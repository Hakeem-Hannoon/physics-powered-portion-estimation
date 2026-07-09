# Model Registry — weights, descriptions, and version log

The single source of truth for **every model artifact** in the pipeline: what it
is, where its weights live, and the metric at each version. This is the *ledger*;
[`MODELS.md`](MODELS.md) is the *selection rationale* (why each model was picked)
and [`STATUS.md`](STATUS.md) is the roadmap. Update a model's version table every
time you train, fine-tune, refit, or re-export it.

## Storage & naming conventions

- **Off-the-shelf models** are pulled from their Hugging Face repo at export
  time — we don't vendor their weights. The registry records the exact HF id +
  revision so a build is reproducible.
- **Models we train** (SegFormer fine-tune, mass regressor) produce checkpoints
  too large for git. They persist to the project's shared **Drive folder**
  ([view-only](https://drive.google.com/drive/folders/1y1hDjkfHsazsOoe4LJjWKoEKj2bHKKjd)),
  written by the Colab notebooks. Naming: `<model>-v<n>-<metric>.pt` (e.g.
  `mass-regressor-v1-massmape.pt`) plus a sibling `<model>-v<n>.json` config.
- **Fitted (non-neural) artifacts** small enough to commit — `priors.json` — live
  in the repo and ARE version-controlled.
- Every checkpoint carries its own provenance inside the file where possible
  (the regressor `.pt` stores `{"backbone", "state_dict"}`; add `config` on the
  next save so a checkpoint is self-describing).

Status legend: ✅ trained/shipped · 🟡 pending run · ⬜ not started.

---

## Stage 1 — Segmentation

| | |
|---|---|
| **Role** | RGB image → per-food-region masks (the ruler tap doubles as the prompt). |
| **Chosen source** | Fine-tune **SegFormer-B0** (`nvidia/mit-b0`) on `EduardoPacheco/FoodSeg103` — every public FoodSeg103 checkpoint measures ≤ 0.05 mIoU, so we train our own (MODELS.md §1). |
| **Off-the-shelf fallback** | `apple/coreml-sam2.1-tiny` (Apache-2.0, promptable) for the interactive path. |
| **Train script** | `model/train/segformer_foodseg103.py` (Colab notebook 02). |
| **Input → output** | 512×512 RGB → 104-class logit map → argmax masks. |
| **Export** | Core ML (iOS) / ExecuTorch `.pte` (Android) via notebook 04. |
| **Weights artifact** | HF-format checkpoint dir + `eval_results.json` → Drive. |

**Versions**

| Ver | Date | Weights | Backbone / config | Metric | Status |
|---|---|---|---|---|---|
| v1 | 2026-07-09 | `segformer-b0-foodseg103-v1/` (Drive) | `nvidia/mit-b0`, FoodSeg103 val | **mIoU 0.246** (target ~0.25; public ckpts ≤ 0.05) | ✅ |
| — | — | — | try B1 (`nvidia/mit-b1`, target ~0.32) | — | ⬜ |

---

## Stage 2 — Classification

| | |
|---|---|
| **Role** | Each masked crop → food label (drives density, MATH.md §5). |
| **Chosen source** | `apple/coreml-mobileclip` (S0) — **zero-shot**, no training. Embed the crop, cosine-match against precomputed text embeddings of the food vocabulary. |
| **Fine-tune option** | `apple/MobileCLIP2-S0` + a small linear head for cooked-state disambiguation (fried vs steamed) — the gap that most affects density. |
| **Input → output** | crop → image embedding → nearest food-vocab label + top-k. |
| **Weights artifact** | HF (image encoder, Core ML). **Text-side embeddings** of the vocab are computed offline and shipped as an asset — treat that `.npy`/table as a versioned artifact too. |
| **License note** | `apple-ascl` — review before App Store submission. |

**Matching logic:** ✅ implemented + tested — `ZeroShotClassifier`
(`packages/pipeline/src/zero-shot.ts`, 7 tests): cosine-match crop embedding vs.
precomputed text embeddings + softmax. The on-device image **encoder** is the
remaining device+model piece. Integration guide: [`REAL_ADAPTERS.md`](REAL_ADAPTERS.md) §2.

**Versions**

| Ver | Date | Weights | Config | Metric | Status |
|---|---|---|---|---|---|
| logic | 2026-07-09 | — (pure, in `@ppe/pipeline`) | cosine + softmax zero-shot | tested | ✅ |
| encoder | — | `apple/coreml-mobileclip` (S0, HF) | Core ML / ExecuTorch image head | ~88–90% top-1 Food-101 | 🟡 needs export + device |
| text | — | `food-vocab-embeddings-v0.json` (asset) | prompt-ensembled offline | — | ⬜ |
| interim | 2026-07-09 | — | `SelectedClassifier` food picker (real nutrition, confirmed label) | — | ✅ demo |

---

## Stage 3 — Depth (LiDAR-free devices)

| | |
|---|---|
| **Role** | Relative depth on phones without a depth sensor; the ruler stroke rescales it to metric (so a metric-depth net stays optional). |
| **Chosen source** | `apple/coreml-depth-anything-v2-small` (Apache-2.0, 24.8 M, 49.8 MB fp16, 31–34 ms iPhone 12/15 Pro Max). |
| **Input → output** | RGB → relative inverse-depth map → metric via ruler anchor. |
| **Weights artifact** | HF (Core ML fp16). Off-the-shelf, no training. |
| **Note** | On LiDAR/ARCore-depth devices this stage is skipped — real depth comes from the capture payload (see `CAPTURE_QUALITY.md` R3 for the Android depth serialization). |

**Versions**

| Ver | Date | Weights | Config | Status |
|---|---|---|---|---|
| v0 | — | `apple/coreml-depth-anything-v2-small` (HF) | as-is, fp16 | ⬜ not wired |

---

## Stage 4 — Mass regressor (the one we train from scratch)

| | |
|---|---|
| **Role** | (metric-rectified crop + measured physics) → **grams**. The novel model — nothing public conditions mass regression on a measured AR scale (MODELS.md §4). |
| **Architecture** | `mobilenetv3_large_100` backbone → FiLM(physics) → MLP head → `[log_mass, log_kcal]`. ~5.5 M params. Physics-anchored residual optional (default on). |
| **Train script** | `model/train/mass_regressor_nutrition5k.py` (Colab notebook 03). |
| **Data** | Nutrition5k overhead RGB-D, official splits (`model/data/prepare_nutrition5k.py` → manifest). |
| **Input → output** | 256×256 crop + `[log(area), height, has_height, one-hot(scale_source)[5]]` → `[log_mass, log_kcal]`. |
| **Export** | `model/export/export_coreml.py` → `MassRegressor.mlpackage` (Core ML fp16); ExecuTorch `.pte` for Android. |
| **Checkpoint** | `out/mass-regressor.pt` = `{"backbone", "state_dict"}` → Drive as `mass-regressor-v<n>.pt`. |
| **Primary metric** | **mass MAPE** on the held-out split (production derives calories as mass → classify → USDA kcal/g, so mass leads; kcal head is auxiliary). |

**Versions**

| Ver | Date | Weights | Config | mass MAPE | kcal MAPE | Status |
|---|---|---|---|---|---|---|
| v0 | 2026-07-09 | `mass-regressor-v0.pt` (Drive) | mobilenetv3_large_100, 50 ep, bs128, κ=0.1687; **residual off, no scale-noise** | **24.1%** | ~32% | ✅ baseline |
| v1 | *pending* | `mass-regressor-v1.pt` | + **physics-anchored residual** (#1) + **scale-source parity** (#2), defaults on (`--residual --scale-noise 0.03 --ruler-prob 0.5`) | *TBD* | *TBD* | 🟡 ready to run |

> v1 is the A/B for the two techniques in [`MODEL_IMPROVEMENTS.md`](MODEL_IMPROVEMENTS.md).
> Record the number here after the run; also log the ablations (`--no-residual`,
> `--scale-noise 0`) so the contribution of each technique is attributable.

---

## Fitted artifact — Shape priors (not a neural net, but it has "weights")

| | |
|---|---|
| **Role** | The geometry constants the portion math and the regressor's physics anchor use: `V = κ·A^{3/2}` (no height) / `V = φ·A·h` (measured height), mean height `h̄` (MATH.md §4). |
| **Fit script** | `model/priors/fit_priors.py` from the Nutrition5k manifest (least-squares/ratio — **seconds of CPU, no GPU**). |
| **Weights artifact** | `model/priors/priors.json` — **committed to git** (small). |
| **Consumers** | `@ppe/pipeline` (`DEFAULT_KAPPA`/`DEFAULT_MOUND_PHI`), the ETL's `shape_priors`, and the regressor's `physics_log_mass()`. |

**Versions**

| Ver | Date | Weights | Values | Status |
|---|---|---|---|---|
| global-v1 | 2026-07-09 | `model/priors/priors.json` | κ=0.1687, φ=0.446, h̄=0.098 m, n=3484 | ✅ |
| per-class | *pending* | `priors.json` (per-class keys) | needs per-class labels — MODEL_IMPROVEMENTS.md #4 | ⬜ |

---

## Nutrient bundle (data artifact — real, shipped)

The `NutrientStore` adapter is **real and wired into the demo** (`ExpoSqliteNutrientStore`,
`apps/demo/src/nutrient-store.ts`), reading a bundled SQLite database instead of
the hard-coded mock. See [`REAL_ADAPTERS.md`](REAL_ADAPTERS.md) §1.

| Ver | Date | Artifact | Contents | Status |
|---|---|---|---|---|
| starter | 2026-07-09 | `apps/demo/assets/nutrients.sqlite` (~24 KB) | 12 common foods, real USDA per-100 g + 5 densities + `_global` prior | ✅ shipped in demo |
| full | — | build via `npm run etl:bundle` over the FDC export | ~15k foods, FTS5-indexed, ~15–30 MB | ⬜ (needs FDC download) |

Source of the starter set: `nutrition/starter/build-starter.mjs` (runs the same
`buildBundle` as the full ETL); rebuild with `npm run build:nutrients`.

## Reproduce / re-export any model

```bash
# Regressor (GPU): train → checkpoint → Core ML
python model/train/mass_regressor_nutrition5k.py --manifest out/n5k-manifest.csv
python model/export/export_coreml.py regressor --checkpoint out/mass-regressor.pt \
  --out out/MassRegressor.mlpackage

# Priors (CPU, seconds):
python model/priors/fit_priors.py --manifest out/n5k-manifest.csv --out model/priors/priors.json

# SegFormer (GPU): notebook 02, or the script directly.
python model/train/segformer_foodseg103.py
```
