---
tags: [ppe, math, concept]
---

# Math 2 — The Ruler

> Turning a finger gesture into a real‑world measurement: ray ∩ plane, the tap‑hold‑slide interaction, and the statistics that make a shaky hand accurate. Source: [[MATH]] §2.2–§2.4. Builds on [[Math 1 - Metric Scale and the Pinhole Camera]].

## Ray ∩ plane ([[MATH]] §2.2)

From [[Math 1 - Metric Scale and the Pinhole Camera]] we can turn any screen pixel into a **ray** in the metric world. A tabletop is a **plane**: the set of points with $\mathbf{n}\cdot\mathbf{X} = d_0$ (unit normal $\mathbf{n}$, offset $d_0$). ARKit fits this plane to tracked feature points (or the LiDAR mesh).

Where does the ray hit the plane? Substitute the ray $\mathbf{r}(t) = \mathbf{o} + t\mathbf{d}$ into the plane equation and solve for $t$:

$$t^\* = \frac{d_0 - \mathbf{n}\cdot\mathbf{o}}{\mathbf{n}\cdot\mathbf{d}}, \qquad \mathbf{P} = \mathbf{o} + t^\*\,\mathbf{d}$$

valid when $t^\* > 0$ (in front of the camera) and $\mathbf{n}\cdot\mathbf{d} \ne 0$ (ray not parallel to the plane). That $\mathbf{P}$ is a **real 3D point on the table, in meters**. Code: `intersectRayPlane` ([[Geometry Library]]); on device this is one ARKit/ARCore raycast call, but the math is exactly this.

## The gesture ([[MATH]] §2.3)

A ruler stroke is three moments:
- **Touch down** at pixel $(u_1, v_1)$ → raycast → anchor point $\mathbf{P}_1$. A live line + label start rendering.
- **Drag** → each frame, raycast the current finger position → $\mathbf{P}_2(t)$, show the live length $\lVert\mathbf{P}_2 - \mathbf{P}_1\rVert$.
- **Release** → freeze $\mathbf{P}_2$. The measurement is $D = \lVert \mathbf{P}_2 - \mathbf{P}_1 \rVert$ meters.

Multiple strokes are allowed — e.g. plate width (horizontal) plus, on capable devices, food height (a **vertical** stroke up the side of the food). The stroke's `kind` (horizontal vs. vertical) is decided by the angle between the stroke direction and the plane normal.

**UX drives accuracy.** Endpoint noise contributes *relative* error $\propto 1/D$, so **measure something long**: a 20 cm plate‑rim stroke with ±5 mm endpoint noise is 2.5% error; a 4 cm stroke is 12.5%. The module enforces a minimum stroke length (default 10 cm) before the shutter arms.

## Why one frame is never trusted ([[MATH]] §2.4 — the interesting part)

VIO already compensates for phone *motion* (every raycast is in a motion‑stabilized world frame). What remains is **jitter**: a ~1° hand tremor swings the ray's surface hit by $Z\tan 1° \approx 7$ mm at $Z = 40$ cm, and pressing/lifting a finger jolts the device *at exactly the two instants that define the stroke*. Three countermeasures, each costing microseconds. (This is applied [[CS Foundations]] §5 — robust statistics.)

### 1. Median anchoring from a pre‑touch buffer

Keep a rolling window of the last ~6 reticle hits **at all times**. On **press**, anchor instantly on the **component‑wise median** of that buffer — those frames were captured *before* the finger jolt existed, so the jolt can't contaminate them. The live endpoint is the rolling median of the same window; **release** commits the pre‑lift median, for the same reason.

Why median, not mean? Zero‑mean tremor shrinks like $1/\sqrt{N}$ under either — but the **median ignores outlier spikes entirely** (a single bad frame moves a mean, not a median). Code: `medianPoint` over a `STEADY_WINDOW = 6` buffer in the Android module ([[The Capture App]]).

### 2. Shake gating — for violent motion only

Compute per‑frame camera velocities from pose deltas:
$$v = \frac{\lVert\Delta\mathbf{c}\rVert}{\Delta t}\ \ (\text{linear}),\qquad \omega = \frac{2\arccos\lvert\langle q_{t-1}, q_t\rangle\rvert}{\Delta t}\ \ (\text{angular, from quaternion dot})$$
Exclude samples above ~**1.0 m/s** or ~**1.5 rad/s** — fast swings and hard knocks — from the buffer. The device's measured motion is used as a *quality gate* only; you must **not** subtract it from the measurement (VIO already corrected for it — subtracting double‑counts).

**Hard‑won lesson encoded in the thresholds:** a gate set near ordinary hand‑sway (~0.3 rad/s) *starves the buffer and blocks measuring altogether.* Tremor removal is the median's job; the gate exists only for motion blur. The code comments quote this directly ([[The Capture App]], `isShaky`).

### 3. Plane snapping

Hit points within **8 mm** of the locked support plane are **projected onto it**. ARKit/ARCore temporally filter the plane across many frames, so it's far steadier than any single raycast — snapping to it removes residual jitter for on‑table strokes. Height strokes (several cm above the plane) exceed the threshold and pass through untouched. Code: `snapToSupportPlane`.

## Two ways the measurement is used

The single ruler length $D$ does one of two jobs depending on ARKit's confidence:
- **Verification** — if ARKit's plane + pose are already healthy, the metric scale is *already* known (see the homography in [[Math 3 - The Plane Homography]]); the ruler *confirms* it, and its residual becomes a live quality readout (`ruler_residual_mm`).
- **Calibration** — if plane detection is poor (or on a shared non‑AR photo), the ruler stroke **is** the scale: it fixes the meters‑per‑pixel (and, with two strokes, the plane orientation).

This is the top of the fallback ladder ([[MATH]] §7): LiDAR → **ruler** → reference object (a credit card) → stated plate size → nothing.

## Related
- [[Math 1 - Metric Scale and the Pinhole Camera]] · [[Math 3 - The Plane Homography]] · [[The Capture App]] · [[Geometry Library]] · [[CS Foundations]] · [[MATH]]
