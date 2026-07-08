---
tags: [ppe, math, concept]
---

# Math 4 — Volume, Mass, and Nutrients

> From a food's metric area to calories on the plate — the three volume routes, density, the Atwater energy check, and the error budget that keeps the whole thing honest. Source: [[MATH]] §4–§8. Uses [[CS Foundations]] §5–6.

## Area → volume: three routes ([[MATH]] §4)

We have the food's metric **area** $A$ (from [[Math 3 - The Plane Homography]]) and maybe a **height** $h$. The pipeline picks the best available route at runtime (`estimate.ts`; code in [[Geometry Library]]).

### Route (a) — LiDAR height‑field integration (measured volume)

Best case. Back‑project each depth pixel to a 3D point, compute its height above the table $h(\mathbf{X}) = d_0 - \mathbf{n}\cdot\mathbf{X}$, resample onto a metric grid, and **integrate** (a Riemann sum, [[CS Foundations]] §6):

$$V = \sum_{(x,y)\,\in\,\text{mask}} \max\big(0,\, h(x,y)\big)\,\Delta x\,\Delta y$$

Code: `integrateHeightFieldM3(heights, cellAreaM2)`. It measures the *visible upper surface*, so concavities/overhangs are invisible — a mild overestimate for e.g. broccoli, tamed by a per‑class packing factor. Method flag: `lidar_integration`.

### Route (b) — area × height with a fill factor (hybrid)

If a **height** is known (a vertical ruler stroke, or LiDAR max height) but not a full field:

$$V = \varphi_{\text{class}}\cdot A\cdot h$$

$\varphi$ is a **shape fill factor** — how much of the bounding prism the food actually fills: slab/cylinder $\varphi = 1$, dome $\varphi = 2/3$, cone $\varphi = 1/3$, typical food mound ≈ 0.5–0.6. It's *fit from data* (Nutrition5k), not guessed — see [[Shape Priors and Nutrition5k]]. Code: `volumeAreaHeightM3(areaM2, heightM, phi)`, default `DEFAULT_MOUND_PHI = 0.58`. Method flag: `area_height`.

### Route (c) — shape prior (no height at all)

If only area is known, assume the food is a scaled copy of a canonical per‑class shape. Then linear size $\ell \propto \sqrt{A}$, so volume scales as the **3/2 power** of area (isometric scaling):

$$V = \kappa_{\text{class}}\cdot A^{3/2}$$

Sanity check the exponent: double the *linear* size → area ×4, volume ×8, and indeed $4^{3/2} = 8$. ✓ (This exact relation is unit‑tested — [[Testing]].) For genuinely flat classes (pizza, toast) use $V = A\cdot\bar h_{\text{class}}$ with a fixed thickness prior instead. Both κ and $\bar h$ are **fit offline from Nutrition5k**, not hand‑tuned. Code: `volumeShapePriorM3(areaM2, kappa)`, placeholder `DEFAULT_KAPPA = 0.55` until the fit lands ([[Roadmap and Next Steps]]). Method flag: `shape_prior`.

## Volume → mass: density ([[MATH]] §5)

$$m = \rho_{\text{class}}\cdot V$$

Densities come from data: the FAO/INFOODS density database (primary) and USDA FNDDS portion weights (secondary — "1 cup cooked white rice = 158 g" → $\rho = 158/236.6 = 0.67$ g/mL). Classes span ~0.15–1.1 g/mL, which is *why classification must precede portioning* — **density is where a wrong label hurts most.** How these densities are derived and stored: [[Nutrition Database]]. Code: `massG(volumeMl, densityGPerMl)`.

## Mass → calories, macros, micros ([[MATH]] §6)

Every nutrient scales linearly with mass off the per‑100 g database values:

$$\text{kcal} = \frac{m}{100}\,E_{100}, \qquad P = \frac{m}{100}\,p_{100}, \quad \text{(same for carbs, fat, each micro)}$$

Code: `nutrientsForMassG(per100, massG)`. Micros carried end‑to‑end: fiber, sugar, saturated fat (g); sodium, cholesterol, potassium, calcium, iron (mg).

**The Atwater cross‑check.** Energy must roughly satisfy the macronutrient identity:

$$\text{kcal} \approx 4P + 4C + 9F \quad (\pm 15\%)$$

If a food's stated kcal falls outside that band, the database match or the parse is wrong — **flag it, don't ship the number** (`atwater_mismatch`). Code: `atwaterKcal`, `atwaterDeviation`; the test feeds a good record (passes) and a broken one (flagged). This is a cheap, powerful guard against bad data.

## The error budget — the honesty section ([[MATH]] §8)

Mass is a product $m = \rho\,\varphi\,A\,h$, so **relative** errors add in quadrature, and scale enters area **squared**:

$$\left(\frac{\sigma_m}{m}\right)^2 \approx \Big(2\tfrac{\sigma_s}{s}\Big)^2 + \Big(\tfrac{\sigma_A}{A}\Big)^2_{\!\text{seg}} + \Big(\tfrac{\sigma_h}{h}\Big)^2 + \Big(\tfrac{\sigma_\rho}{\rho}\Big)^2$$

Realistic per‑term numbers give two honest columns:

| Term | Prior‑only (v0) | Measured height (v1) |
|---|---|---|
| Scale (20 cm ruler, ±5 mm) | 2.5% → area 5% | same |
| Segmentation → area | ~8% | ~8% |
| Height / shape (κ, φ, $\bar h$) | ~25% | ~8–10% |
| Density | ~15% | ~15% |
| **Combined (RSS), per item** | **~30%** | **~20%** |

These bracket Nutrition5k's literature (26.1% RGB / 16.5% depth) *from the geometry side* — exactly as hoped: the ruler recovers most of what depth hardware gives. The code computes this via `errorPreset(scale_source, heightMeasured)` → `combinedRelativeError`, and the tests lock the numbers to **0.306 (v0)** and **0.207 (v1)** ([[Testing]]).

**Per‑meal error is smaller than per‑item.** For $k$ items with independent errors, the total shrinks like $1/\sqrt{k}$ (four ~20% items → ~10% on the meal). Caveat: density/shape errors are *systematic per class* and don't cancel across identical foods.

**Where the learned model enters (v2):** the scale‑conditioned [[Mass Regressor Model]] absorbs the correlated shape/density residuals jointly and should push per‑item error toward the depth‑equipped ~16% floor — the only trained piece, and it *knows the metric scale*, so it has strictly more information than any RGB‑only model.

## Related
- [[Math 3 - The Plane Homography]] · [[Shape Priors and Nutrition5k]] · [[Mass Regressor Model]] · [[Nutrition Database]] · [[Geometry Library]] · [[The Pipeline]] · [[MATH]]
