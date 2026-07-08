---
tags: [ppe, math, concept]
---

# Math 3 — The Plane Homography

> The exact map from image pixels to real centimeters on the table — why a single "meters‑per‑pixel" number is wrong, how areas are measured perfectly, and the height bias that inflates everything. Source: [[MATH]] §3. Builds on [[Math 1 - Metric Scale and the Pinhole Camera]], uses homogeneous coordinates from [[CS Foundations]] §3.

## Why the naive approach fails

The tempting shortcut: project the ruler endpoints into the photo, measure their pixel distance $\ell_{px}$, and set a scalar $s = D/\ell_{px}$ (meters per pixel). Then any pixel length × $s$ = meters.

**This is only locally correct.** Under perspective, meters‑per‑pixel *varies across the image* — the far side of a tilted plate covers more real distance per pixel than the near side. On a plane tilted θ from face‑on, one scalar can misjudge lengths by up to $\cos\theta$. At a typical 40° shooting angle that's ~23% in length → **~50% area error** at the far edge of the plate. Since we hold the *full* camera pose and plane, we can do it **exactly** instead.

## The homography ([[MATH]] §3.1)

Put a 2D coordinate frame **on the table**: an origin $\mathbf{O}$ and two perpendicular in‑plane axes $\mathbf{e}_1, \mathbf{e}_2$ (both ⟂ the normal $\mathbf{n}$). A point with table‑coordinates $(x, y)$ is the 3D point $\mathbf{X}(x,y) = \mathbf{O} + x\mathbf{e}_1 + y\mathbf{e}_2$. Push it through the camera (world‑to‑camera $[R\,|\,\mathbf{t}]$, then K):

$$\mathbf{p} \sim K\,(R\,\mathbf{X} + \mathbf{t}) = \underbrace{K\big[\,R\mathbf{e}_1 \mid R\mathbf{e}_2 \mid R\mathbf{O} + \mathbf{t}\,\big]}_{H}\begin{bmatrix}x\\y\\1\end{bmatrix}$$

$H$ is a **3×3 invertible matrix** — the **homography** from metric table‑coordinates to image pixels. Its inverse $H^{-1}$ maps any image pixel *of the table* back to real meters. This is exact — no small‑angle approximation, valid across the whole plane at any camera angle. Code: `planeToImageHomography` builds $H$; the pipeline inverts it with `mat3Inverse` ([[Geometry Library]], [[The Pipeline]]).

Recall from [[CS Foundations]] §3 that applying a homography means multiply then **divide by the third coordinate** (`applyHomography`). That division is the perspective correction the scalar shortcut lacked.

### Two exact consequences

**Lengths.** Map both endpoints through $H^{-1}$, take the Euclidean distance. Built‑in sanity check: mapping the *ruler's own* endpoints back must reproduce the measured $D$ — the leftover residual is a live estimate of calibration quality (`rulerResidualM` → `ruler_residual_mm`). In a perfect capture it's zero to ~1e‑9 ([[Testing]]).

**Areas (the shoelace formula).** Map the segmentation outline's vertices through $H^{-1}$ into metric coordinates, then apply the **shoelace formula** — a discrete sum that gives any polygon's area from its ordered vertices:

$$A = \frac{1}{2}\left|\sum_i (x_i\,y_{i+1} - x_{i+1}\,y_i)\right| \quad [\text{m}^2]$$

Code path: `metricPolygonAreaM2` = `pixelPolygonToPlane` (through $H^{-1}$) then `polygonArea` (shoelace). The test projects a known 10×10 cm square and recovers **0.01 m² to 1e‑9** ([[Testing]]).

## The off‑plane (height) bias ([[MATH]] §3.2)

The homography is exact **only for points actually on the plane.** Food has height. A point at height $h$ above the table is physically *closer to the camera*, so mapping it through the *table's* $H^{-1}$ places it too far out — it looks bigger than it is.

For a near‑overhead camera at height $Z$, a feature at height $h$ appears scaled by:

$$\frac{Z}{Z - h}$$

Example: phone 45 cm up, bowl rim at 9 cm → rim diameter over‑measured ×1.25, rim **area ×1.56**. This bias is real and silently swallowed by every "scale from the plate" heuristic. Corrections, increasing in quality:
1. **Mid‑height plane** — evaluate the homography on a plane lifted by the food's half‑height $\bar h/2$ (a class prior). Kills the bias to first order. *This is what the pipeline does:* it multiplies area by $\left(\frac{Z - h/2}{Z}\right)^2$ via `elevationLengthFactor` (squared, because it's an area).
2. **Known‑height correction** — use a per‑class $h$ or the user's height stroke.
3. **LiDAR** — back‑project with true depth; no bias at all.

The regression test elevates a point, confirms the inflation is *exactly* $Z/(Z-h)$, and that the correction undoes it — to 1e‑9 ([[Testing]], "off‑plane inflation").

## Containers are special

Bowls, cups, glasses break the on‑plane assumption entirely — the visible surface starts at the *rim* and the volume below is hidden. They're treated as their own shape class: rim ellipse → true rim diameter (via the homography + rim‑height correction) → a fill‑level estimate → a solid‑of‑revolution volume $V = \pi\int r(z)^2 dz$ with a canonical profile. Straight glasses of liquid are actually the *easiest* case (perfect cylinder). In code this shows up as the `container` shape kind and a `container_prior` method flag ([[The Pipeline]]).

## Where this leads

You now have the food's **metric area** (and possibly a **measured height**), bias‑corrected. Turning that into volume → mass → calories is [[Math 4 - Volume Mass and Nutrients]].

## Related
- [[Math 1 - Metric Scale and the Pinhole Camera]] · [[Math 2 - The Ruler]] · [[Math 4 - Volume Mass and Nutrients]] · [[Geometry Library]] · [[The Pipeline]] · [[MATH]]
