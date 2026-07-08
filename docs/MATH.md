# The Math

Everything from "finger on glass" to "412 kcal", derived. Notation: bold = vectors, $K$ = camera intrinsic matrix, world units are **meters** throughout.

---

## 1. Why the phone's coordinates are metric at all (the "physics" in the name)

A camera alone can never recover absolute scale: shrink the world by 10× and move the camera 10× less, and every image is pixel-identical. Structure-from-motion gives you geometry *up to an unknown global scale factor λ*.

ARKit/ARCore break the ambiguity with the IMU. The accelerometer measures specific force in **m/s²** — a physical unit. Over a short camera motion, integrating acceleration twice gives displacement in meters:

$$\Delta \mathbf{x}_{\text{IMU}} = \iint \left(\mathbf{a}(t) - \mathbf{g}\right)\,dt^2 \quad [\text{m}]$$

Visual tracking measures the *same* displacement up to scale: $\Delta\mathbf{x}_{\text{vis}} = \lambda^{-1}\Delta\mathbf{x}_{\text{true}}$. The visual-inertial optimizer solves for the $\lambda$ that makes them agree (jointly with IMU biases, over many windows — this is visual-inertial odometry, VIO). Result: **ARKit's world frame is in meters on every ARKit-capable phone, LiDAR or not.** That's why the Measure app exists, and it's the entire trick this project is built on: scale comes from Newton, not from a neural net's guess about how big plates usually are.

Accuracy in practice: short-range ARKit measurements are good to roughly ±0.5–1 cm when tracking is healthy (feature-rich scene, a second of device motion). We measure this ourselves in P0 before trusting it (README roadmap).

## 2. The ruler: touch → ray → plane → distance

### 2.1 Pixel to ray

The pinhole model. A pixel $\mathbf{p} = (u, v)$ with intrinsics

$$K = \begin{bmatrix} f_x & 0 & c_x \\ 0 & f_y & c_y \\ 0 & 0 & 1 \end{bmatrix}$$

corresponds to a viewing direction in the **camera frame**:

$$\mathbf{d}_c = K^{-1}\begin{bmatrix}u\\v\\1\end{bmatrix} = \begin{bmatrix}(u - c_x)/f_x\\ (v - c_y)/f_y\\ 1\end{bmatrix}$$

With the camera pose (rotation $R_{cw}$, camera center $\mathbf{c}$, both from ARKit's `camera.transform`), the ray in **world frame** is:

$$\mathbf{r}(t) = \mathbf{c} + t\,\mathbf{d}, \qquad \mathbf{d} = \frac{R_{cw}\,\mathbf{d}_c}{\lVert R_{cw}\,\mathbf{d}_c \rVert}$$

> ⚠️ Convention trap: computer-vision convention has the image $y$-axis pointing **down** and the camera looking along $+z$; ARKit's camera frame has $y$ **up** and looks along $-z$. The derivations here use CV convention; the implementation must flip signs accordingly (documented in `ARCHITECTURE.md`).

### 2.2 Ray ∩ table plane

ARKit's plane detection fits horizontal planes to tracked feature points (or, with LiDAR, to the reconstructed mesh). A plane is $\{\mathbf{X} : \mathbf{n}\cdot\mathbf{X} = d_0\}$ with unit normal $\mathbf{n}$. Intersecting the ray:

$$t^\* = \frac{d_0 - \mathbf{n}\cdot\mathbf{c}}{\mathbf{n}\cdot\mathbf{d}}, \qquad \mathbf{P} = \mathbf{c} + t^\*\,\mathbf{d} \quad (\text{valid iff } t^\* > 0,\ \mathbf{n}\cdot\mathbf{d} \neq 0)$$

(In code this is one call — `ARRaycastQuery` / ARCore `hitTest` — but this is what it computes.)

### 2.3 The gesture

- **Touch down** at $(u_1, v_1)$ → raycast → anchor $\mathbf{P}_1$. A line + live label starts rendering.
- **Drag**: each frame, raycast the current finger position → $\mathbf{P}_2(t)$, display $\lVert \mathbf{P}_2(t) - \mathbf{P}_1 \rVert$ live.
- **Release** → freeze $\mathbf{P}_2$. The measurement:

$$D = \lVert \mathbf{P}_2 - \mathbf{P}_1 \rVert \quad [\text{m}]$$

Multiple strokes are allowed (e.g. plate width, then food height on LiDAR devices). UX guidance matters for accuracy: measure something **long** (relative error of the endpoints falls as $1/D$ — a 20 cm plate-rim stroke with ±5 mm endpoint noise is 2.5% error; a 4 cm stroke is 12.5%) and **near the food** (same plane region).

### 2.4 Anchor stabilization (why one frame is never trusted)

VIO already expresses every raycast in a motion-compensated world frame, so phone movement *per se* is accounted for. What remains is **jitter**: hand tremor of ~1° swings the ray's surface intersection by $Z\tan 1° \approx 7$ mm at $Z = 40$ cm, and pressing or lifting a finger on the trigger jolts the device at exactly the two moments that define the stroke. Three countermeasures, all costing microseconds:

1. **Shake gating.** Per-frame camera velocities from pose deltas — linear $v = \lVert\Delta\mathbf{c}\rVert/\Delta t$, angular $\omega = 2\arccos\lvert\langle q_{t-1}, q_t\rangle\rvert / \Delta t$ — reject samples above ~0.25 m/s or ~0.35 rad/s. This uses the device's measured motion on all axes as a *quality gate*; subtracting the motion from the measurement would double-count what VIO already corrected.
2. **Median anchoring.** Both stroke endpoints are component-wise medians over a window of accepted samples (≥ 4 frames and ≥ 120 ms for the anchor; a rolling 6-frame window for the live endpoint). Zero-mean tremor shrinks roughly like $1/\sqrt{N}$, and the median — unlike a mean — ignores outlier spikes entirely. Release commits the *pre-lift* median, because the lift-jolt frames were gated out before they could vote.
3. **Plane snapping.** Hit points within 8 mm of the locked support plane project onto it — ARCore/ARKit filter the plane temporally across many frames, so it is far steadier than any single raycast. Height strokes (several cm above the plane) pass through untouched.

## 3. From one measurement to metric everything: the plane homography

The naive move is a scalar scale factor: project $\mathbf{P}_1,\mathbf{P}_2$ into the photo, get their pixel distance $\ell_{px}$, and set $s = D/\ell_{px}$ (meters per pixel). Then any pixel length on the plane ≈ $s\cdot\ell$. **This is only locally correct.** Under perspective, meters-per-pixel varies across the image; on a plane tilted $\theta$ from fronto-parallel, using one scalar $s$ can misjudge lengths by up to a factor $\cos\theta$ (at a typical 40° shooting angle, that's ~23% linear → **~50% area error** at the far side of the plate). Since we hold the full camera pose and plane, we can do it exactly instead:

### 3.1 Image ↔ plane homography

Put a 2D coordinate frame on the table plane: origin $\mathbf{O}$ (any point on it), orthonormal in-plane axes $\mathbf{e}_1, \mathbf{e}_2 \perp \mathbf{n}$. A plane point with coordinates $(x, y)$ is $\mathbf{X}(x,y) = \mathbf{O} + x\,\mathbf{e}_1 + y\,\mathbf{e}_2$. Projecting through the camera (world-to-camera $[R\,|\,\mathbf{t}]$):

$$\mathbf{p} \sim K\,(R\,\mathbf{X} + \mathbf{t}) = K\,\big[\,R\mathbf{e}_1 \;\big|\; R\mathbf{e}_2 \;\big|\; R\mathbf{O} + \mathbf{t}\,\big]\begin{bmatrix}x\\y\\1\end{bmatrix} \;\equiv\; H\begin{bmatrix}x\\y\\1\end{bmatrix}$$

$H$ is a 3×3 invertible matrix: the **homography** between metric plane coordinates and image pixels. $H^{-1}$ maps any image point *of the plane* to its true position in meters. Two exact consequences:

- **Lengths**: map both endpoints through $H^{-1}$, take the Euclidean distance. (Sanity check built in: mapping the ruler's own endpoints must reproduce $D$; the residual is our live estimate of calibration quality.)
- **Areas**: map the segmentation mask's polygon vertices through $H^{-1}$ and apply the shoelace formula — or resample the mask into a metric grid ("top-down rectified view") and count cells:

$$A = \frac{1}{2}\left|\sum_i (x_i\,y_{i+1} - x_{i+1}\,y_i)\right| \quad [\text{m}^2]$$

No approximation, valid across the whole plane, any camera angle.

> **Where the ruler fits:** if ARKit's plane + pose are healthy, $H$ already contains the scale and the ruler is *verification* (and the interaction that confirms which plane the meal sits on). If plane detection is poor, the ruler segment **is** the calibration: we fit the scale (and, with two strokes, the plane orientation) from it. And on non-AR captures there is no $H$ at all — see the fallback ladder in §7.

### 3.2 Off-plane bias (food has height — so does a plate rim)

The homography is exact **for points on the plane**. A point at height $h$ above the table is closer to the camera, so mapping it through the *table's* $H^{-1}$ inflates its position radially. For a camera at height $Z$ above the table (near-nadir shooting), a feature at height $h$ appears scaled by:

$$\frac{Z}{Z - h}$$

Example: phone 45 cm above the table, bowl rim at 9 cm → rim diameter overestimated ×1.25, rim **area ×1.56**. This bias is real and silently eaten by every "scale from the plate" heuristic. Corrections, in increasing quality:

1. **Mid-height plane**: evaluate the homography on a plane lifted by the food's half-height $\bar h/2$ (class prior) — kills the bias to first order.
2. **Known-height correction**: multiply measured lengths by $(Z - h)/Z$ using per-class $h$ (or the user's height stroke).
3. **LiDAR**: back-project with true depth; no bias at all.

## 4. Area → volume

Three routes, best-available wins at runtime:

**(a) LiDAR depth integration — measured volume.** Back-project each depth pixel to a world point $\mathbf{X}$, compute its height above the table $h(\mathbf{X}) = d_0 - \mathbf{n}\cdot\mathbf{X}$ (sign such that up is positive), rectify the height field onto the metric plane grid, and integrate over the food mask:

$$V = \sum_{(x,y)\,\in\,\text{mask}} \max\big(0,\, h(x,y)\big)\,\Delta x\,\Delta y$$

This is a Riemann sum of the visible surface — it measures the *upper envelope*; concavities and overhangs are invisible, so it's a mild overestimate for e.g. broccoli, corrected by a per-class packing factor.

**(b) Measured height (the second ruler stroke) — hybrid.** The user drags from the table up the side of the food (raycast against the LiDAR mesh, or against a vertical estimated plane): direct $h$. Then

$$V = \varphi_{\text{class}} \cdot A \cdot h$$

where $\varphi$ is a shape fill factor: cylinder/slab $\varphi = 1$, dome $\varphi = 2/3$ (hemisphere: $\tfrac{2}{3}\pi r^3$ vs $\pi r^2\!\cdot\!r$), cone $\varphi = 1/3$, typical food mound ≈ 0.5–0.6 (fit from Nutrition5k's depth data rather than assumed).

**(c) Shape prior — no height information.** If the food's 3D shape is roughly a scaled copy of a canonical per-class shape, then linear size $\ell \propto \sqrt{A}$ and

$$V = \kappa_{\text{class}}\cdot A^{3/2}$$

(volume grows as the 3/2 power of footprint area — isometric scaling). For genuinely flat classes (pizza, pancake, toast) use $V = A\cdot\bar h_{\text{class}}$ with a fixed thickness prior instead. Both $\kappa$ and $\bar h$ are *fit offline* from Nutrition5k (which has depth + mass ground truth), not hand-tuned.

**Containers** (bowls, cups, glasses) break the on-plane assumption — the visible surface starts at the rim and the volume below is hidden. Treat as a class of their own: rim ellipse → true rim diameter via §3 (+§3.2 rim-height correction), a fill-level estimate (visual, or LiDAR to the food surface inside), and the solid-of-revolution volume $V = \pi\int r(z)^2\,dz$ with a canonical bowl/glass profile $r(z)$. Liquids in straight glasses are actually the *easiest* case: perfect cylinder.

## 5. Volume → mass: density

$$m = \rho_{\text{class}} \cdot V$$

Densities come from data, not vibes: the FAO/INFOODS density database and USDA FNDDS portion weights (FNDDS lists gram weights for volumetric household measures — "1 cup, cooked white rice = 158 g" → $\rho = 158/236.6 = 0.67$ g/mL). Cooked-grain, leafy, fried, and liquid classes span roughly 0.15–1.1 g/mL, which is exactly why classification must precede portioning: **density is where a wrong label hurts most**.

## 6. Mass → calories, macros, micros

Per item $i$ with matched database entry (per-100 g values from USDA FoodData Central):

$$\text{kcal}_i = \frac{m_i}{100}\,E_{100,i}, \qquad P_i = \frac{m_i}{100}\,p_{100,i}, \quad\text{(same for carbs, fat, and each micro)}$$

Micros tracked: fiber, sugar, saturated fat (g); sodium, cholesterol, potassium, calcium, iron (mg). Cross-check every item with the Atwater identity:

$$\text{kcal} \approx 4P + 4C + 9F \quad (\pm 15\%)$$

— outside the band means the DB match or the parse is wrong; flag, don't ship the number.

## 7. Scale-source fallback ladder

| Source | What it gives | Expected scale error |
|---|---|---|
| LiDAR depth + plane | full metric surface | ~1–2% |
| ARKit VIO ruler (this project's core) | plane-metric via $H$ | ~2–4% |
| Known object in frame (credit card: 85.60 × 53.98 mm, ISO/IEC 7810 ID-1) | local scale + rough $H$ from its quad | ~3–6% |
| User-stated plate diameter | one scalar | ~5–10% |
| Nothing (prior on plate size) | a guess | unbounded — label as estimate |

## 8. Error budget (honesty section)

Mass is a product $m = \rho\,V = \rho\,\varphi\,A\,h$, so **relative** errors add in quadrature:

$$\left(\frac{\sigma_m}{m}\right)^2 \approx \left(\frac{\sigma_\rho}{\rho}\right)^2 + \left(\frac{\sigma_A}{A}\right)^2 + \left(\frac{\sigma_h}{h}\right)^2 + \left(\frac{\sigma_\varphi}{\varphi}\right)^2$$

and scale enters area **squared**: $A \propto s^2 \Rightarrow \sigma_A/A\big|_{\text{scale}} = 2\,\sigma_s/s$.

Realistic per-term numbers:

| Term | Prior-only (v0) | Measured height (v1) |
|---|---|---|
| Scale $s$ (ruler, 20 cm stroke, ±5 mm) | 2.5% → area 5% | same |
| Segmentation boundary → area | ~8% | ~8% |
| Height/shape ($\bar h$, $\kappa$, $\varphi$) | ~25% | ~8–10% |
| Density $\rho$ | ~15% | ~15% |
| **Combined (RSS), per item** | **~30%** | **~20%** |

Two calibration points from the literature: Nutrition5k's models score 26.1% calorie error from RGB alone and 16.5% with metric depth — our two columns bracket those numbers from the geometry side, which is exactly what you'd hope: the ruler recovers most of what depth hardware provides. Humans eyeball at ~41%.

**Per-meal error is smaller than per-item error.** For $k$ items with independent, unbiased errors, the total's relative error shrinks like $1/\sqrt{k}$ (e.g. four ~20% items → ~10% on the meal total). Caveat: density and shape-prior errors are *systematic per class* — they don't cancel across identical items, only across different foods.

**Where the learned model enters (v2):** a small scale-conditioned regressor — rectified metric crop + $(A, h, \text{class})$ → grams — trained on Nutrition5k absorbs the correlated shape/density residuals jointly and should push per-item error toward the depth-equipped ~16% floor. That's the only place in the pipeline where we train anything, and it has strictly more information than any published RGB-only model (it *knows the metric scale*).

## 9. Practical pitfalls (each one is a unit test)

1. **Intrinsics rescale with resolution.** ARKit reports $K$ for the full-resolution captured image; crop/downscale ⇒ $f_x' = f_x\,\frac{w'}{w}$, $c_x' = c_x\,\frac{w'}{w}$ (same for $y$). Get this wrong and every length is silently off by the resize ratio.
2. **Orientation.** Sensor-native landscape vs display portrait vs EXIF rotation — apply exactly once. A 90° mixup swaps $f_x/f_y$ and shears $H$.
3. **Axis conventions.** ARKit camera $y$-up/$-z$-forward vs CV $y$-down/$+z$-forward (§2.1 warning).
4. **Textureless/dark tables** defeat plane detection → the module must detect low tracking quality and coach the user ("move the phone slightly"), or fall down the §7 ladder.
5. **Ruler endpoint UX error** dominates $\sigma_s$ for short strokes: enforce a minimum stroke length in UI, snap to high-gradient edges later.
6. **Elevated bases** (food on a raised plate ≠ table plane): raycast onto the *plate* surface if LiDAR sees it; else the §3.2 correction with plate-height prior (~2–3 cm).
7. **Timestamp alignment**: use the ruler anchors from the AR session but the *frame* (image + pose + intrinsics) captured at shutter time — anchors are world-fixed, so this is safe as long as tracking didn't reset between stroke and shutter (check `trackingState`).
