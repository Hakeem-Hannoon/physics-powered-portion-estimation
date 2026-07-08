---
tags: [ppe, models, data, ml]
---

# Shape Priors and Nutrition5k

> The per‑class constants (κ, φ, h̄) that let the geometry estimate volume without a full 3D scan — fit from data, not guessed — and the Nutrition5k dataset + manifest extraction they're fit from. Code: `model/data/prepare_nutrition5k.py`, `model/priors/fit_priors.py`. Math: [[Math 4 - Volume Mass and Nutrients]].

## What the priors are and why they matter

When the app has only a food's **area** (no depth, no height stroke), it still needs a **volume**. The three shape constants ([[Math 4 - Volume Mass and Nutrients]]) bridge that gap:

| Symbol | Used in | Meaning |
|---|---|---|
| **κ** (kappa) | $V = \kappa A^{3/2}$ | mounded foods: how volume scales with footprint area |
| **φ** (phi) | $V = \varphi A h$ | fill factor: how much of the area×height prism the food actually occupies |
| **h̄** (h‑bar) | $V = A\bar h$ | typical thickness of flat foods (pizza, toast) |

These feed the `FoodRecord.shape` in [[The Pipeline]] and seed `DEFAULT_KAPPA` (currently a `0.55` placeholder). The whole reason they can be *fit* rather than *guessed*: Nutrition5k provides depth + mass ground truth for thousands of real dishes.

## Nutrition5k, the dataset

[Nutrition5k](https://github.com/google-research-datasets/Nutrition5k) (Google, CC BY 4.0 — commercial‑clean) has ~5k dishes with **overhead RGB‑D** captures (an Intel RealSense depth camera looking straight down), per‑ingredient masses, per‑dish calories, and official train/test splits. Depth is 16‑bit with **10,000 units per meter**. It's the training substrate for both the shape priors and the [[Mass Regressor Model]]. (~3,490 usable overhead dishes after filtering.)

## Manifest extraction (`prepare_nutrition5k.py`)

This script turns each dish's raw depth map into the **same metric features the phone measures at capture time**, so the model trains on exactly what it'll see in production. For every overhead dish, `analyze_depth()`:

1. **Fit the table plane** from the border ring of the depth image by **least squares** ([[CS Foundations]] §4): `depth(x,y) ≈ ax + by + c` over the border pixels (`np.linalg.lstsq`). This is the [[Math 3 - The Plane Homography]] plane fit, done on real depth.
2. **Height field** = plane depth − pixel depth (how far each pixel rises above the table).
3. **Food mask** = height > 5 mm threshold.
4. **Metric area & volume** — per‑pixel footprint at the table depth $(Z/f_x)(Z/f_y)$, summed over the mask for area, and $\sum h\cdot\Delta A$ for volume (the route‑(a) Riemann sum, [[Math 4 - Volume Mass and Nutrients]]).

Each dish becomes one CSV row: `dish_id, image_path, area_m2, volume_m3, height_m, mean_height_m, mass_g, kcal, scale_source="lidar", split`. That **manifest CSV** is the shared input to both the priors fit and the regressor training. (The script is annotated line‑by‑line — see [[Training Pipeline]]. Storage caveat: it reads ~5k per‑dish folders, so it must run against **local disk**, not Google Drive — that's the whole [[Training Pipeline]] storage story.)

## Fitting the priors (`fit_priors.py`)

Runs on a laptop in seconds over the manifest. For each food class (or one global class until per‑class labels exist), using **medians** so a few bad dishes can't drag the fit ([[CS Foundations]] §5):

- **κ** — from $V = \kappa A^{3/2}$: in log space $\log V = \log\kappa + 1.5\log A$, so $\log\kappa$ is the **median of $(\log V - 1.5\log A)$** — a robust intercept. (This is a robust version of the least‑squares intercept idea.)
- **φ** — the median of $V / (A\cdot h_{\max})$: the fraction of the bounding prism the food fills. Clamped to [0.05, 1.0] — it's a volume fraction, so anything outside is a fit artifact.
- **h̄** — the median of $h_{\max}$: a typical thickness for the flat‑food route.

Degenerate rows (near‑zero area/volume/height, i.e. failed depth fits) are dropped first, and classes with too few dishes are skipped. Output is `priors.json`, which:
- replaces `DEFAULT_KAPPA = 0.55` in `@ppe/pipeline` ([[The Pipeline]]), and
- seeds `nutrition/`'s planned `shape_priors` table ([[Nutrition Database]]).

Wiring these fitted values in is the **highest‑value next step** ([[Roadmap and Next Steps]] item 1).

## The through‑line
Nutrition5k's depth + mass ground truth → manifest of metric features → (a) shape priors that make the geometry fallback data‑grounded, and (b) the training set for the scale‑conditioned [[Mass Regressor Model]]. Same manifest, two consumers.

## Related
- [[Mass Regressor Model]] · [[Training Pipeline]] · [[Math 4 - Volume Mass and Nutrients]] · [[The Pipeline]] · [[Nutrition Database]] · [[CS Foundations]] · [[MODELS]]
