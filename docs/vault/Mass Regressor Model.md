---
tags: [ppe, models, ml]
---

# Mass Regressor Model

> The one model this project trains from scratch, because nothing public does it: predict a food's **mass** from its appearance **plus the measured metric scale**. This is the novel contribution. Spec: [[MODELS]] §4, [[MATH]] §8. Code: `model/train/mass_regressor_nutrition5k.py`. ML basics: [[CS Foundations]] §7.

## Why it exists

Direct image→nutrition models exist only server‑scale or as paper experiments with no weights. **Verified: no public model conditions mass regression on a measured AR scale reference. Nobody has shipped this.** ([[MODELS]] §4.) That gap is the point — this model sees *strictly more information* than any RGB‑only model, because it's handed the metric scale the physics recovered ([[The Problem and The Big Idea]]).

It's also the **v2 fallback**: whenever the pure‑geometry pipeline ([[Math 4 - Volume Mass and Nutrients]]) is uncertain, this model absorbs the correlated shape/density residuals jointly and should push per‑item error from ~20% toward the depth‑equipped ~16% floor.

## The inputs and outputs

- **Input 1 — the image:** an RGB crop of one food region, metrically rectified, resized to 256×256.
- **Input 2 — the physics (a conditioning vector):** exactly what the phone measures at capture, and *nothing that peeks at the label*:
  $$[\ \log(\text{area}),\ \ \text{height (or }{-}1),\ \ \text{has\_height},\ \ \text{one‑hot}(\text{scale\_source})[5]\ ]$$
  `log(area)` because mass scales ~$A^{3/2}$, so the log gives the network a near‑linear cue; when a capture had no depth, height is `−1` with `has_height=0`, telling the model to lean on area alone.
- **Output:** `log(mass)` and an auxiliary `log(kcal)`.

Why **log space**? Mass/kcal span two orders of magnitude (a lettuce leaf vs. a steak). Training on logs with a SmoothL1 (Huber) loss penalizes *ratio* error — which is exactly what the % benchmark (MAPE) measures ([[CS Foundations]] §7).

## The architecture

```
   RGB crop ─► CNN backbone (MobileNetV3) ─► visual features  h ∈ R^960
   physics  ─► FiLM MLP ─► (γ, β)                          │
                                                            ▼
                             h' = (1 + γ) ⊙ h + β  ─► MLP head ─► [log_mass, log_kcal]
```

### The backbone — a CNN
`mobilenetv3_large_100` (from `timm`), pretrained on ImageNet, gives pooled visual features. A CNN ([[CS Foundations]] §7) is the right inductive bias for a single image; small pretrained backbones transfer well at Nutrition5k's modest size (~3.5k usable overhead dishes — a from‑scratch transformer would starve). Swappable via `--backbone` (`fastvit_t8` for the Apple Neural Engine, `efficientnet‑lite` for Android/LiteRT).

### FiLM — the clever part
**Feature‑wise Linear Modulation** (Perez et al., 2018). The physics vector is fed through a small MLP that outputs a per‑channel scale **γ** and shift **β**, which *modulate* the visual features:

$$h' = (1 + \gamma)\odot h + \beta$$

Why this beats just concatenating the scalars onto the features: FiLM lets the measured scale **multiply** the visual signal — mirroring the physics that *doubling the metric area should roughly double the predicted mass for the same appearance*. Concatenation lets the network ignore the scalars early in training; multiplication forces the coupling. The `(1 + γ)` form means γ=0 is the identity, so training starts as a no‑op modulation and *learns* to deviate — more stable than scaling from zero. (This is `class FiLM` in the code; see the annotated walkthrough in [[Training Pipeline]].)

### The head
A small MLP outputs two numbers: `log_mass` and `log_kcal`. They share the modulated features and split only at the last layer, so kcal is a **cheap auxiliary task** that regularizes the shared representation.

## Why no RNN?
Recurrent nets model *sequences*. A capture is **one frame plus scalars** — there is no sequence. A convolutional (or CNN‑ViT hybrid) encoder + FiLM conditioning is the right shape. If multi‑frame video sweeps ever land, the upgrade is *attention pooling over per‑frame embeddings* with the same backbone — still no recurrence. ([[MODELS]] §4.)

## Training (`mass_regressor_nutrition5k.py`)

Reads the manifest CSV from [[Shape Priors and Nutrition5k]] (columns `image_path, area_m2, height_m, mass_g, kcal, split`). Then:
1. **Data** — split on the manifest's official `train`/`test` column (no dish leaks across). The `Dataset.__getitem__` builds the image tensor (with a horizontal‑flip augmentation — the only safe one for an overhead plate), the conditioning vector, and the log‑space targets.
2. **Optimize** — AdamW + cosine LR schedule over 50 epochs; SmoothL1 on the log targets (robust to the occasional mislabeled dish).
3. **Train/eval** — each epoch, train one pass then score **MAPE** on the held‑out split; keep the best‑by‑mass‑MAPE checkpoint (survives disconnects/overfitting).

Targets: beat **26.1%** calorie MAPE (RGB baseline); approach **16.5%** (depth baseline). Landing between them is the expected, honest outcome. Runtime ~1–2 h on an H100. Export via `model/export/export_coreml.py` (Core ML fp16) / ExecuTorch `.pte`. **~5.5 M params**, expected ≤ 10 ms on the Neural Engine ([[HARDWARE]]).

## Related
- [[Segmentation Model]] · [[Shape Priors and Nutrition5k]] · [[Training Pipeline]] · [[Math 4 - Volume Mass and Nutrients]] · [[The Problem and The Big Idea]] · [[CS Foundations]] · [[MODELS]]
