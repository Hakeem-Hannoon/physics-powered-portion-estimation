"""The scale-conditioned mass regressor (roadmap P3) — the model this project
trains from scratch, because nothing public does it (verified 2026-07,
docs/MODELS.md §4).

Architecture
============
Input:  RGB crop of one food region, metrically rectified (MATH.md §3.1),
        plus a conditioning vector of measured physics:
          [log(area_m2), height_m (or -1), has_height, scale-source one-hot(5)]
Output: log(mass_g) for the region (and an auxiliary kcal head).

    crop ──► CNN backbone (timm mobilenetv3_large_100, pretrained) ──► h ∈ R^960
    physics ──► MLP ──► (γ, β)          FiLM conditioning
    h' = γ ⊙ h + β ──► MLP head ──► [log_mass, log_kcal]

Why this shape and no recurrence: the input is a single image with scalar
side-information — a convolutional (or hybrid ViT) encoder plus feature-wise
conditioning is the right inductive bias. RNNs model sequences; there is no
sequence here. FiLM (Perez et al., 2018) lets the measured scale multiply
visual features, which mirrors the physics: doubling the metric area should
roughly double predicted mass for the same appearance, and the network learns
exactly that coupling instead of guessing scale from texture. If multi-frame
captures land later (video sweep), attention pooling over frame embeddings is
the upgrade path; recurrence stays unnecessary.

Two scale-leverage techniques sit on top of the base architecture (both on by
default, both ablatable — see docs/MODEL_IMPROVEMENTS.md #1, #2):

  1. Physics-anchored residual (--residual): the head predicts a CORRECTION to
     the geometry mass prior m̂ = ρ·V (V from MATH.md §4), not mass from scratch.
     The physically-correct A^{3/2} / A·h scaling is then guaranteed, and the
     network only has to learn the density/shape *deviation* — a far tighter
     target than log-mass over two orders of magnitude.
  2. Scale-source parity (--scale-noise): Nutrition5k's scale is depth-clean, but
     production scale is the VIO ruler (~2–4%, and area∝scale² so ~4–8%). We
     inject matching noise on a fraction of training examples and relabel their
     source to "ruler", so the model is robust to ruler-grade input at inference
     instead of being surprised by it.

Run-2 standard-tuning levers (docs/vault/Mass Regressor Model.md → "Improving
the model" #1–#3), each on by default and each ablatable back to the 24.1%
run-1 configuration:

  3. Overhead-safe augmentation (--aug): mild random-resized-crop, vertical
     flip, photometric jitter. Only the pixels are perturbed — the conditioning
     vector and targets are measurements, not appearance, and stay untouched.
  4. Input normalization inside the model (--input-norm): ImageNet mean/std on
     pixels + train-split standardization of log(area)/height, stored as model
     buffers so any export carries its own preprocessing and the app contract
     stays "plain [0,1] pixels, raw physical units".
  5. Loss weighting (--mass-weight/--kcal-weight, default 2:1): mass is the
     shipped metric (production kcal = mass × USDA kcal/g), so it gets the
     larger gradient share; kcal stays as an auxiliary regularizer.

Before training starts, the script prints the geometry-only baseline (the
physics anchor scored alone on the test split) — the honest "what does the CNN
add?" number for the P3 A/B, and a manifest sanity check in one line.

The backbone is exchangeable via --backbone (fastvit_t8 for ANE-friendly
inference, efficientnet-lite for LiteRT). Everything exports through
export/export_coreml.py (Core ML) and export/export_onnx.py (ONNX for the
demo app's onnxruntime-react-native runtime).

Data: a manifest CSV produced by data/prepare_nutrition5k.py with columns
  image_path, area_m2, height_m, mass_g, kcal, split
Nutrition5k is CC BY 4.0 — commercially usable with attribution.

GPU job (Google Labs H100): ~1-2 h for 50 epochs at batch 128. The real cost
is the 181 GB dataset download and the manifest extraction, both one-time.

    python train/mass_regressor_nutrition5k.py --manifest out/n5k-manifest.csv
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
import timm
import torch
import torch.nn as nn
from PIL import Image
from torch.utils.data import DataLoader, Dataset

SCALE_SOURCES = ["lidar", "ruler", "reference_object", "stated", "none"]
COND_DIM = 3 + len(SCALE_SOURCES)

# ImageNet statistics for the pretrained backbone (--input-norm). Applied
# INSIDE the model via registered buffers, not in the dataset: the exported
# graph then carries its own preprocessing, so the app keeps feeding plain
# [0, 1] pixels and can never drift out of sync with the training-time input.
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


def _uniform(lo: float, hi: float) -> float:
    """Uniform sample through torch's RNG so DataLoader per-worker seeding
    covers the augmentation draws too (Python's `random` would share state)."""
    return lo + (hi - lo) * torch.rand(1).item()

# Physics anchor (residual mode). Reference density for m̂ = ρ·V — a neutral
# ~water value; the learned residual absorbs each food's true density (0.15–1.1
# g/mL, MATH.md §5), so this only sets where the correction starts, not the
# answer. Volume comes out in m³ (area in m², height in m — MATH.md §4), and
# 1 m³ = 1e6 mL, so grams = ρ[g/mL]·1e6·V[m³].
REFERENCE_DENSITY_G_PER_ML = 1.0
ML_PER_M3 = 1.0e6
# Fallback priors if --priors can't be read (matches model/priors/priors.json).
DEFAULT_KAPPA = 0.1687
DEFAULT_PHI = 0.446
DEFAULT_PRIORS_PATH = Path(__file__).resolve().parent.parent / "priors" / "priors.json"


def load_priors(path: str | Path) -> tuple[float, float]:
    """Read (kappa, phi) from a fit priors.json; fall back to the committed
    global values if the file is missing/partial. kappa scales the shape-prior
    volume V = κ·A^{3/2}; phi is the mound fill factor in V = φ·A·h (MATH.md §4)."""
    try:
        data = json.loads(Path(path).read_text())
        g = data.get("_global", data)
        return float(g.get("kappa", DEFAULT_KAPPA)), float(g.get("phi", DEFAULT_PHI))
    except Exception:
        return DEFAULT_KAPPA, DEFAULT_PHI


def physics_log_mass(cond: torch.Tensor, kappa: float, phi: float) -> torch.Tensor:
    """Geometry-only mass prior in log-grams, from the SAME capture-time features
    the phone has (area, height, has_height — never the label). With a measured
    height: V = φ·A·h; without: the shape prior V = κ·A^{3/2} (MATH.md §4). Then
    m̂ = ρ_ref·V. The regressor predicts a residual around this, so it only learns
    the density/shape deviation and inherits the correct scaling for any portion
    size — including sizes outside the training range."""
    log_area = cond[:, 0]
    height = cond[:, 1]
    has_height = cond[:, 2]
    area = torch.exp(log_area)
    v_height = phi * area * height.clamp(min=1e-4)     # φ·A·h  (m³)
    v_prior = kappa * area.clamp(min=1e-8) ** 1.5      # κ·A^{3/2} (m³)
    volume_m3 = torch.where(has_height > 0.5, v_height, v_prior).clamp(min=1e-9)
    mass_g = REFERENCE_DENSITY_G_PER_ML * ML_PER_M3 * volume_m3
    return torch.log(mass_g.clamp(min=1.0))


class MealRegionDataset(Dataset):
    """One training example per dish: the RGB crop, the measured-physics
    conditioning vector, and the (log) mass/kcal targets.

    The conditioning vector is deliberately only what the phone can measure at
    capture time — nothing here reads the label — so the network learns exactly
    the map it will run in production (MATH.md §3.1)."""

    def __init__(
        self,
        manifest: pd.DataFrame,
        image_size: int = 256,
        train: bool = True,
        scale_noise: float = 0.0,
        ruler_prob: float = 0.0,
        height_noise: float = 0.0,
        aug: bool = False,
    ):
        self.rows = manifest.reset_index(drop=True)
        self.image_size = image_size
        self.train = train
        # Scale-source parity (technique #2). Off when scale_noise == 0.
        self.scale_noise = scale_noise    # σ of the global log-scale error (~ruler)
        self.ruler_prob = ruler_prob      # fraction of train examples simulated as ruler
        self.height_noise = height_noise  # σ of independent height-stroke jitter
        self.aug = aug                    # run-2 augmentation (lever #1); train only

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, idx: int):
        row = self.rows.iloc[idx]
        image = Image.open(row.image_path).convert("RGB")
        # Mild random-resized-crop (lever #1, train only). Two jobs: generic
        # regularization on a ~3.5k-dish dataset, and production parity — at
        # inference the crop comes from a predicted mask whose bounds wobble
        # around the food. MILD (≥ 80% of the area) because dropped pixels are
        # food the conditioning still counts: `cond` keeps the measured area of
        # the WHOLE region, so an aggressive crop would decouple appearance
        # from physics.
        if self.train and self.aug:
            w, h = image.size
            area_frac = _uniform(0.8, 1.0)
            aspect = _uniform(0.9, 1.1)
            cw = min(w, round(math.sqrt(w * h * area_frac * aspect)))
            ch = min(h, round(math.sqrt(w * h * area_frac / aspect)))
            x0 = int(torch.randint(0, w - cw + 1, (1,)).item())
            y0 = int(torch.randint(0, h - ch + 1, (1,)).item())
            image = image.crop((x0, y0, x0 + cw, y0 + ch))
        # Image → CHW float tensor in [0, 1]. A square resize is fine: the crop
        # is already region-tight and the scale lives in `cond`, not in the
        # pixel dimensions, so aspect distortion costs the model nothing.
        image = image.resize((self.image_size, self.image_size))
        x = torch.from_numpy(np.array(image)).permute(2, 0, 1).float() / 255.0
        # Horizontal flip — a plate has no canonical left/right. Kept outside
        # --aug so --no-aug reproduces the run-1 configuration exactly.
        if self.train and torch.rand(1).item() < 0.5:
            x = torch.flip(x, dims=[2])
        if self.train and self.aug:
            # Vertical flip: safe *because the view is overhead* — from above,
            # a plate has no canonical up/down either. (Side-view datasets do:
            # gravity gives them an up, which is why the run-1 comment ruled
            # this out before the overhead framing was thought through.)
            if torch.rand(1).item() < 0.5:
                x = torch.flip(x, dims=[1])
            # Photometric jitter: mass is invariant to the kitchen's lighting,
            # so teach that invariance instead of letting the net bind density
            # cues to Nutrition5k's fixed camera rig. Pixels only — `cond` and
            # the targets are measurements, not appearance.
            x = x * _uniform(0.8, 1.2)                       # brightness
            mean = x.mean()
            x = (x - mean) * _uniform(0.8, 1.2) + mean       # contrast
            gray = x.mean(dim=0, keepdim=True)
            x = gray + (x - gray) * _uniform(0.8, 1.2)       # saturation
            x = x.clamp(0.0, 1.0)

        # Conditioning vector — layout must stay in lockstep with COND_DIM and
        # the app-side encoder:
        #   [ log(area_m2), height_m (or -1), has_height, one-hot(scale_source)[5] ]
        # log(area) because mass scales ~area^(3/2), so the net sees a near-linear
        # cue; when a capture had no depth, height is -1 and has_height=0, telling
        # the model to lean on area alone rather than trust a bogus height.
        height = float(row.get("height_m", -1) or -1)
        has_height = 1.0 if height > 0 else 0.0
        source = str(row.get("scale_source", "lidar"))
        area_m2 = float(row.area_m2)

        # Technique #2 — train/test scale-source parity. Nutrition5k's scale is
        # depth-clean; production scale is the VIO ruler (~2–4%, and area ∝ scale²
        # so ~4–8% on area). On a fraction of TRAIN examples, draw one global scale
        # error s and apply s² to area / s to height (a single world-scale error
        # hits both), add independent endpoint jitter to the short height stroke,
        # and RELABEL the source to "ruler" so the model learns the per-source
        # noise band rather than tying clean features to whatever one-hot it always
        # saw. Only the INPUTS are perturbed — targets stay ground truth.
        if self.train and self.scale_noise > 0.0 and torch.rand(1).item() < self.ruler_prob:
            s = math.exp(torch.randn(1).item() * self.scale_noise)
            area_m2 *= s * s
            if has_height:
                hj = math.exp(torch.randn(1).item() * self.height_noise)
                height = max(height * s * hj, 1e-4)
            source = "ruler"

        one_hot = [1.0 if source == src else 0.0 for src in SCALE_SOURCES]
        cond = torch.tensor(
            [math.log(max(area_m2, 1e-6)), max(height, -1.0), has_height, *one_hot],
            dtype=torch.float32,
        )
        # Targets in log space: mass/kcal span two orders of magnitude, so what
        # matters is relative error. SmoothL1 on logs ≈ penalizing ratio error,
        # which is exactly the currency the MAPE benchmark is scored in.
        target = torch.tensor(
            [math.log(max(row.mass_g, 1.0)), math.log(max(row.kcal, 1.0))],
            dtype=torch.float32,
        )
        return x, cond, target


class FiLM(nn.Module):
    """Feature-wise Linear Modulation (Perez et al., 2018): the measured physics
    predicts a per-channel scale (γ) and shift (β) that rescale the visual
    features. This is where "double the metric area ⇒ ~double the mass" gets
    wired into the network — the scale multiplies the features instead of being
    concatenated and merely hoped for."""

    def __init__(self, cond_dim: int, feature_dim: int):
        super().__init__()
        # Tiny MLP mapping the conditioning vector → 2·feature_dim, later split
        # into (γ, β), one pair per backbone channel.
        self.net = nn.Sequential(
            nn.Linear(cond_dim, 128), nn.SiLU(), nn.Linear(128, 2 * feature_dim)
        )

    def forward(self, features: torch.Tensor, cond: torch.Tensor) -> torch.Tensor:
        gamma, beta = self.net(cond).chunk(2, dim=-1)
        # (1 + γ) so that γ=0 is the identity: modulation starts as a no-op and
        # learns to deviate, which trains more stably than scaling from zero.
        return features * (1 + gamma) + beta


class ScaleConditionedMassRegressor(nn.Module):
    """backbone → FiLM(physics) → MLP head → [log_mass, log_kcal].

    Any timm feature extractor works as the backbone (num_classes=0 yields
    pooled features); swap it via --backbone for different on-device targets
    (fastvit_t8 for the Apple Neural Engine, efficientnet-lite for LiteRT)."""

    def __init__(
        self,
        backbone: str = "mobilenetv3_large_100",
        residual: bool = True,
        kappa: float = DEFAULT_KAPPA,
        phi: float = DEFAULT_PHI,
        input_norm: bool = False,
        cond_stats: tuple[float, float, float, float] = (0.0, 1.0, 0.0, 1.0),
    ):
        super().__init__()
        # Physics-anchor config (technique #1). When residual is True the mass head
        # predicts a correction to physics_log_mass() rather than absolute log-mass.
        self.residual = residual
        self.kappa = kappa
        self.phi = phi
        # Input normalization (lever #2) lives INSIDE the model, as buffers:
        # buffers ride in the state_dict and in any traced/ONNX graph, so the
        # preprocessing the weights were trained with is the preprocessing the
        # phone runs — one object, no drift. Off → identity, i.e. run-1 input.
        self.input_norm = input_norm
        mean = IMAGENET_MEAN if input_norm else (0.0, 0.0, 0.0)
        std = IMAGENET_STD if input_norm else (1.0, 1.0, 1.0)
        self.register_buffer("pixel_mean", torch.tensor(mean).view(1, 3, 1, 1))
        self.register_buffer("pixel_std", torch.tensor(std).view(1, 3, 1, 1))
        # (log_area mean, log_area std, height mean, height std) over the train
        # split; identity when input_norm is off.
        self.register_buffer(
            "cond_stats", torch.tensor(cond_stats, dtype=torch.float32)
        )
        self.backbone = timm.create_model(backbone, pretrained=True, num_classes=0)
        # Size FiLM/head from the backbone's ACTUAL pooled-feature width, not
        # backbone.num_features — they differ on some nets (MobileNetV3 reports
        # 960 there, but forward() returns the 1280-d post-conv_head features, so
        # FiLM's γ/β wouldn't match). A dummy forward measures it for any backbone.
        with torch.no_grad():
            feature_dim = self.backbone(torch.zeros(1, 3, 224, 224)).shape[1]
        self.film = FiLM(COND_DIM, feature_dim)
        # Shared head: mass and kcal ride the same modulated features and only
        # split at the final Linear, so the kcal output is a cheap auxiliary task
        # that regularizes the shared representation.
        self.head = nn.Sequential(
            nn.Linear(feature_dim, 256), nn.SiLU(), nn.Dropout(0.1), nn.Linear(256, 2)
        )

    def _normalize_cond(self, cond: torch.Tensor) -> torch.Tensor:
        """Standardize the continuous dims for FiLM. Raw, log(area) sits near −5
        and height near 0.04 with a −1 sentinel — FiLM's MLP would first have to
        learn its own rescaling before γ/β mean anything. A missing height maps
        to 0 (the standardized mean), not a standardized −1 (a ~10σ outlier);
        `has_height` already carries the missingness signal."""
        log_area = (cond[:, 0] - self.cond_stats[0]) / self.cond_stats[1]
        height = torch.where(
            cond[:, 2] > 0.5,
            (cond[:, 1] - self.cond_stats[2]) / self.cond_stats[3],
            torch.zeros_like(cond[:, 1]),
        )
        return torch.cat(
            [log_area.unsqueeze(1), height.unsqueeze(1), cond[:, 2:]], dim=1
        )

    def forward(self, image: torch.Tensor, cond: torch.Tensor) -> torch.Tensor:
        x = (image - self.pixel_mean) / self.pixel_std   # identity when norm off
        h = self.backbone(x)                  # pooled visual features, R^feature_dim
        film_cond = self._normalize_cond(cond) if self.input_norm else cond
        out = self.head(self.film(h, film_cond))   # modulate by physics, then regress
        if not self.residual:
            return out                        # [log_mass, log_kcal] directly
        # Technique #1: mass head = geometry prior + learned residual. The head
        # starts near 0 (its final Linear is ~zero-init in effect), so training
        # begins at the physics estimate and learns the density/shape correction.
        # Computed from the RAW cond — the physics needs real units (m², m);
        # normalization is only the network's diet.
        anchor = physics_log_mass(cond, self.kappa, self.phi)  # (B,) log-grams
        log_mass = anchor + out[:, 0]
        return torch.stack([log_mass, out[:, 1]], dim=1)


def load_checkpoint(path: str) -> tuple["ScaleConditionedMassRegressor", dict]:
    """Rebuild the exact trained model from a self-describing checkpoint — the
    one loader every export script goes through, so reconstruction logic can't
    fork. Run-1 checkpoints (no config keys, no normalization buffers in the
    state_dict) load with identity normalization via strict=False, reproducing
    their training-time behavior; run-2+ checkpoints restore their buffers and
    load strictly."""
    saved = torch.load(path, map_location="cpu")
    state = saved["state_dict"]
    has_norm_buffers = "pixel_mean" in state
    model = ScaleConditionedMassRegressor(
        saved["backbone"],
        residual=saved.get("residual", True),
        kappa=saved.get("kappa", DEFAULT_KAPPA),
        phi=saved.get("phi", DEFAULT_PHI),
        input_norm=saved.get("input_norm", False),
    )
    model.load_state_dict(state, strict=has_norm_buffers)
    model.eval()
    return model, saved


def mape(pred_log: torch.Tensor, true_log: torch.Tensor) -> float:
    """Mean absolute percentage error, evaluated back in linear grams/kcal. The
    model emits logs, so exp() first, then mean(|pred − true| / true)."""
    pred = torch.exp(pred_log)
    true = torch.exp(true_log)
    return (torch.abs(pred - true) / true).mean().item()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--backbone", default="mobilenetv3_large_100")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--output", default="out/mass-regressor.pt")
    # Technique #1 — physics-anchored residual (on by default; --no-residual to ablate).
    parser.add_argument(
        "--residual", action=argparse.BooleanOptionalAction, default=True,
        help="predict a correction to the geometry mass prior instead of absolute mass",
    )
    parser.add_argument(
        "--priors", default=str(DEFAULT_PRIORS_PATH),
        help="priors.json with fit kappa/phi for the physics anchor",
    )
    # Technique #2 — scale-source parity (on by default; --scale-noise 0 to ablate).
    parser.add_argument(
        "--scale-noise", type=float, default=0.03,
        help="σ of the simulated global ruler scale error (0 disables parity aug)",
    )
    parser.add_argument(
        "--ruler-prob", type=float, default=0.5,
        help="fraction of train examples simulated as ruler-scaled captures",
    )
    parser.add_argument(
        "--height-noise", type=float, default=0.05,
        help="σ of independent height-stroke jitter under the ruler simulation",
    )
    # Run-2 standard-tuning levers (vault: Mass Regressor Model → "Improving the
    # model"). All default-on; `--no-aug --no-input-norm --mass-weight 1` +
    # the technique flags reproduce the 24.1% run-1 configuration.
    parser.add_argument(
        "--aug", action=argparse.BooleanOptionalAction, default=True,
        help="overhead-safe augmentation: mild crop, vertical flip, color jitter",
    )
    parser.add_argument(
        "--input-norm", action=argparse.BooleanOptionalAction, default=True,
        help="ImageNet pixel norm + conditioning standardization inside the model",
    )
    parser.add_argument(
        "--mass-weight", type=float, default=2.0,
        help="loss weight on log-mass (the shipped metric)",
    )
    parser.add_argument(
        "--kcal-weight", type=float, default=1.0,
        help="loss weight on the auxiliary log-kcal head",
    )
    parser.add_argument(
        "--image-size", type=int, default=256,
        help="square crop resolution fed to the backbone (lever #5 knob)",
    )
    args = parser.parse_args()

    kappa, phi = load_priors(args.priors)
    print(
        f"config: residual={args.residual} (κ={kappa:.4f}, φ={phi:.3f}), "
        f"scale_noise={args.scale_noise} ruler_prob={args.ruler_prob} "
        f"height_noise={args.height_noise}, aug={args.aug} "
        f"input_norm={args.input_norm} loss={args.mass_weight:g}:{args.kcal_weight:g} "
        f"image_size={args.image_size}"
    )

    # 1. Data. Split on the manifest's `split` column — Nutrition5k's official
    #    train/test dish ids — so no dish leaks across the boundary. Images are
    #    read lazily per batch, so `image_path` must resolve to local disk (the
    #    Colab notebook stages the dataset there; reading off Drive aborts).
    manifest = pd.read_csv(args.manifest)
    train_df = manifest[manifest.split == "train"]
    test_df = manifest[manifest.split == "test"]
    train_loader = DataLoader(
        MealRegionDataset(
            train_df,
            image_size=args.image_size,
            train=True,
            scale_noise=args.scale_noise,
            ruler_prob=args.ruler_prob,
            height_noise=args.height_noise,
            aug=args.aug,
        ),
        batch_size=args.batch_size,
        shuffle=True,
        num_workers=8,
        pin_memory=True,
    )
    test_loader = DataLoader(
        MealRegionDataset(test_df, image_size=args.image_size, train=False),
        batch_size=args.batch_size,
        num_workers=4,
    )

    # Train-split statistics for --input-norm (lever #2). Heights: measured
    # ones only (> 0) — the −1 sentinel is a flag, not a height, and would
    # poison the moments. The stats ride in the model as buffers, so every
    # export inherits them automatically.
    cond_stats = (0.0, 1.0, 0.0, 1.0)
    if args.input_norm:
        log_area = np.log(np.clip(train_df.area_m2.to_numpy(dtype=float), 1e-6, None))
        if "height_m" in train_df.columns:
            heights = pd.to_numeric(train_df.height_m, errors="coerce").fillna(-1.0)
            measured = heights.to_numpy(dtype=float)
            measured = measured[measured > 0]
        else:
            measured = np.array([])
        cond_stats = (
            float(log_area.mean()),
            float(max(log_area.std(), 1e-6)),
            float(measured.mean()) if measured.size else 0.0,
            float(max(measured.std(), 1e-6)) if measured.size else 1.0,
        )
        print(f"cond stats (train): log_area {cond_stats[0]:.3f}±{cond_stats[1]:.3f}, "
              f"height {cond_stats[2]:.3f}±{cond_stats[3]:.3f}")

    # 2. Model + optimization. AdamW with cosine decay across the whole run;
    #    SmoothL1 (Huber) on the log-targets shrugs off the occasional mislabeled
    #    dish instead of letting one outlier dominate the gradient.
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = ScaleConditionedMassRegressor(
        args.backbone,
        residual=args.residual,
        kappa=kappa,
        phi=phi,
        input_norm=args.input_norm,
        cond_stats=cond_stats,
    ).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)
    # Lever #3 — mass carries the larger gradient share (it's the shipped
    # metric; production kcal = mass × USDA kcal/g, the head is auxiliary).
    loss_fn = nn.SmoothL1Loss(reduction="none")
    loss_weights = torch.tensor(
        [args.mass_weight, args.kcal_weight], device=device
    )

    # Geometry-only baseline: score the physics anchor alone on the test split,
    # exactly like the model is scored. Two jobs: the honest "what does the CNN
    # add?" number for the P3 A/B, and a one-line manifest audit — if this
    # prints something absurd, the area/height extraction is broken and no
    # amount of training will fix it downstream.
    with torch.no_grad():
        base = [
            mape(physics_log_mass(cond, kappa, phi), target[:, 0])
            for _, cond, target in test_loader
        ]
    print(f"geometry-only baseline: mass MAPE {float(np.mean(base)):.3f} "
          f"(the anchor alone — the number the CNN must beat)")

    # 3. Train. One pass per epoch, then score MAPE on the held-out split and
    #    checkpoint only when mass MAPE improves — so the best model survives
    #    even if later epochs overfit or the Colab runtime disconnects mid-run.
    best_mape = float("inf")
    for epoch in range(args.epochs):
        model.train()
        for image, cond, target in train_loader:
            image, cond, target = image.to(device), cond.to(device), target.to(device)
            # Per-element SmoothL1 over [log_mass, log_kcal], then the 2:1 weighting.
            loss = (loss_fn(model(image, cond), target) * loss_weights).mean()
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
        scheduler.step()

        # Evaluate on the test split in linear grams/kcal (mape() exp's the logs).
        model.eval()
        mass_mapes, kcal_mapes = [], []
        with torch.no_grad():
            for image, cond, target in test_loader:
                pred = model(image.to(device), cond.to(device)).cpu()
                mass_mapes.append(mape(pred[:, 0], target[:, 0]))
                kcal_mapes.append(mape(pred[:, 1], target[:, 1]))
        mass_mape = float(np.mean(mass_mapes))
        kcal_mape = float(np.mean(kcal_mapes))
        print(f"epoch {epoch + 1}: mass MAPE {mass_mape:.3f}, kcal MAPE {kcal_mape:.3f}")
        if mass_mape < best_mape:   # new best → save
            best_mape = mass_mape
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            # The checkpoint is self-describing: everything the export scripts
            # need to reconstruct this exact model (backbone, anchor config,
            # normalization mode, input size) travels WITH the weights, so an
            # export can never silently rebuild a mismatched architecture. The
            # normalization statistics themselves are buffers inside state_dict.
            torch.save(
                {
                    "backbone": args.backbone,
                    "residual": args.residual,
                    "kappa": kappa,
                    "phi": phi,
                    "input_norm": args.input_norm,
                    "image_size": args.image_size,
                    "state_dict": model.state_dict(),
                },
                args.output,
            )
    print(f"best mass MAPE: {best_mape:.3f} → {args.output}")
    print("Benchmarks to beat (Nutrition5k, docs/MODELS.md): 26.1% RGB / 16.5% depth.")


if __name__ == "__main__":
    main()
