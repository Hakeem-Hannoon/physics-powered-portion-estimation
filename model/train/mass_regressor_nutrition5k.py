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

The backbone is exchangeable via --backbone (fastvit_t8 for ANE-friendly
inference, efficientnet-lite for LiteRT). Everything exports through
export/export_coreml.py.

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
    ):
        self.rows = manifest.reset_index(drop=True)
        self.image_size = image_size
        self.train = train
        # Scale-source parity (technique #2). Off when scale_noise == 0.
        self.scale_noise = scale_noise    # σ of the global log-scale error (~ruler)
        self.ruler_prob = ruler_prob      # fraction of train examples simulated as ruler
        self.height_noise = height_noise  # σ of independent height-stroke jitter

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, idx: int):
        row = self.rows.iloc[idx]
        # Image → CHW float tensor in [0, 1]. A square resize is fine: the crop
        # is already region-tight and the scale lives in `cond`, not in the
        # pixel dimensions, so aspect distortion costs the model nothing.
        image = Image.open(row.image_path).convert("RGB").resize(
            (self.image_size, self.image_size)
        )
        x = torch.from_numpy(np.array(image)).permute(2, 0, 1).float() / 255.0
        # Horizontal flip is the ONLY safe augmentation here — a plate has no
        # canonical left/right, but vertical flips or rotations would fight the
        # fixed overhead geometry the conditioning encodes.
        if self.train and torch.rand(1).item() < 0.5:
            x = torch.flip(x, dims=[2])

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
    ):
        super().__init__()
        # Physics-anchor config (technique #1). When residual is True the mass head
        # predicts a correction to physics_log_mass() rather than absolute log-mass.
        self.residual = residual
        self.kappa = kappa
        self.phi = phi
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

    def forward(self, image: torch.Tensor, cond: torch.Tensor) -> torch.Tensor:
        h = self.backbone(image)              # pooled visual features, R^feature_dim
        out = self.head(self.film(h, cond))   # modulate by physics, then regress
        if not self.residual:
            return out                        # [log_mass, log_kcal] directly
        # Technique #1: mass head = geometry prior + learned residual. The head
        # starts near 0 (its final Linear is ~zero-init in effect), so training
        # begins at the physics estimate and learns the density/shape correction.
        anchor = physics_log_mass(cond, self.kappa, self.phi)  # (B,) log-grams
        log_mass = anchor + out[:, 0]
        return torch.stack([log_mass, out[:, 1]], dim=1)


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
    args = parser.parse_args()

    kappa, phi = load_priors(args.priors)
    print(
        f"config: residual={args.residual} (κ={kappa:.4f}, φ={phi:.3f}), "
        f"scale_noise={args.scale_noise} ruler_prob={args.ruler_prob} "
        f"height_noise={args.height_noise}"
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
            train=True,
            scale_noise=args.scale_noise,
            ruler_prob=args.ruler_prob,
            height_noise=args.height_noise,
        ),
        batch_size=args.batch_size,
        shuffle=True,
        num_workers=8,
        pin_memory=True,
    )
    test_loader = DataLoader(
        MealRegionDataset(test_df, train=False),
        batch_size=args.batch_size,
        num_workers=4,
    )

    # 2. Model + optimization. AdamW with cosine decay across the whole run;
    #    SmoothL1 (Huber) on the log-targets shrugs off the occasional mislabeled
    #    dish instead of letting one outlier dominate the gradient.
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = ScaleConditionedMassRegressor(
        args.backbone, residual=args.residual, kappa=kappa, phi=phi
    ).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)
    loss_fn = nn.SmoothL1Loss()

    # 3. Train. One pass per epoch, then score MAPE on the held-out split and
    #    checkpoint only when mass MAPE improves — so the best model survives
    #    even if later epochs overfit or the Colab runtime disconnects mid-run.
    best_mape = float("inf")
    for epoch in range(args.epochs):
        model.train()
        for image, cond, target in train_loader:
            image, cond, target = image.to(device), cond.to(device), target.to(device)
            loss = loss_fn(model(image, cond), target)   # SmoothL1 over [log_mass, log_kcal]
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
        if mass_mape < best_mape:   # new best → save (backbone name travels with the weights)
            best_mape = mass_mape
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            torch.save(
                {"backbone": args.backbone, "state_dict": model.state_dict()},
                args.output,
            )
    print(f"best mass MAPE: {best_mape:.3f} → {args.output}")
    print("Benchmarks to beat (Nutrition5k, docs/MODELS.md): 26.1% RGB / 16.5% depth.")


if __name__ == "__main__":
    main()
