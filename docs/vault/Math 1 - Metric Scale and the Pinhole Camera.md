---
tags: [ppe, math, concept]
---

# Math 1 — Metric Scale and the Pinhole Camera

> Why the phone's world is in real meters, and the pinhole model that turns pixels into 3D rays. Formal source: [[MATH]] §1–§2.1. Prereqs: [[CS Foundations]] §1–3.

## Part A — where metric scale comes from ([[MATH]] §1)

**The ambiguity.** A camera cannot recover absolute scale. Shrink the world by 10× and move the camera 10× closer, and every image is pixel‑identical. So vision‑only 3D reconstruction ("structure‑from‑motion") only recovers geometry up to an unknown global scale factor λ: $\Delta\mathbf{x}_{\text{vis}} = \lambda^{-1}\,\Delta\mathbf{x}_{\text{true}}$.

**The fix: the accelerometer.** The IMU's accelerometer measures *specific force* in **m/s²** — a genuine physical unit. Integrating acceleration twice over a short motion yields a displacement in **meters**:

$$\Delta \mathbf{x}_{\text{IMU}} = \iint \big(\mathbf{a}(t) - \mathbf{g}\big)\,dt^2 \quad [\text{m}]$$

(subtracting gravity $\mathbf{g}$, which the accelerometer also feels). Now you have the same motion measured two ways: visually (up to λ) and inertially (in meters). The **visual‑inertial optimizer** (VIO) solves for the λ that makes them agree — jointly with the IMU's biases, across many short windows. That fixes the scale.

**The payoff:**
> ARKit's (and ARCore's) world coordinate frame is in **real meters** on every capable phone — LiDAR or not.

This is the "Measure app" trick, and the foundation of this whole project. Accuracy in practice: roughly ±0.5–1 cm on tabletop distances after a second of gentle motion when tracking is healthy — verified in the P0 drill ([[Testing]]).

**Why this beats a learned scale prior:** the number comes from Newton (real forces on a real mass), not from a network's guess about typical plate sizes. See [[The Problem and The Big Idea]].

## Part B — the pinhole camera ([[MATH]] §2.1)

To use that metric world, we need to relate **pixels** to **3D directions**. The pinhole model does this.

### Intrinsics: the K matrix

A camera is described (to good approximation) by four numbers — its **intrinsics**:
- $f_x, f_y$ — focal lengths in pixels (how "zoomed in" — bigger = narrower field of view),
- $c_x, c_y$ — the principal point, roughly the image center in pixels.

Arranged as a matrix:
$$K = \begin{bmatrix} f_x & 0 & c_x \\ 0 & f_y & c_y \\ 0 & 0 & 1 \end{bmatrix}$$

ARKit reports **K per device**, factory‑calibrated, for the captured image's resolution. In code: `Intrinsics { fx, fy, cx, cy }` and `intrinsicsToMat3` ([[Geometry Library]]).

### Pixel → ray (the inverse of projection)

Projection takes a 3D point to a pixel. We need the reverse: given a pixel $(u, v)$, what 3D **direction** did it come from? Multiply by $K^{-1}$:

$$\mathbf{d}_c = K^{-1}\begin{bmatrix}u\\v\\1\end{bmatrix} = \begin{bmatrix}(u - c_x)/f_x\\ (v - c_y)/f_y\\ 1\end{bmatrix}$$

This is a direction in the **camera frame**. Rotate it into the **world frame** with the camera pose (rotation $R_{cw}$, camera center $\mathbf{c}$) and normalize:

$$\mathbf{r}(t) = \mathbf{c} + t\,\mathbf{d}, \qquad \mathbf{d} = \frac{R_{cw}\,\mathbf{d}_c}{\lVert R_{cw}\,\mathbf{d}_c \rVert}$$

Now you have a **ray**: start at the camera, shoot in direction $\mathbf{d}$. Every pixel is a ray into the world. In code: `pixelRay(k, pose, px)` ([[Geometry Library]]).

> ⚠️ **Convention trap.** The CV math above assumes the image y‑axis points **down** and the camera looks along **+z**. ARKit's camera frame is y‑**up**, looking along **−z**. You must convert exactly once — `poseFromArkitCameraToWorld` negates the y and z basis columns. Get this wrong and everything silently mirrors. There's a dedicated regression test ([[Testing]], "converts an ARKit camera transform").

### Projection (the forward direction), and a rescale pitfall

To go the other way — 3D world point → pixel — transform into the camera frame ($\mathbf{x}_c = R\mathbf{x} + \mathbf{t}$), then apply K and **divide by depth** (`projectPoint`):
$$u = f_x\frac{x_c}{z_c} + c_x, \qquad v = f_y\frac{y_c}{z_c} + c_y$$
The division by $z_c$ is perspective (far = small). Points behind the camera ($z_c \le 0$) don't project.

**Pitfall #1 (resolution).** K is valid only for the resolution it was measured at. If you resize the image, you must rescale: $f_x' = f_x\frac{w'}{w}$, $c_x' = c_x\frac{w'}{w}$ (same for y). Forget this and *every length is silently off by the resize ratio.* Code: `rescaleIntrinsics`; test: "rescaled intrinsics project consistently" ([[Testing]]). This is [[MATH]] §9.1, the #1 real‑world bug.

## What this unlocks

You now have two powers:
1. A **metric world frame** (Part A) — real meters.
2. A **pixel ↔ ray** map (Part B) — connect the image to that world.

Combine them and you can turn a finger tap into a real‑world 3D point (intersect the ray with the table plane) — the ruler. That's [[Math 2 - The Ruler]].

## Related
- [[The Problem and The Big Idea]] · [[Math 2 - The Ruler]] · [[Math 3 - The Plane Homography]] · [[Geometry Library]] · [[CS Foundations]] · [[MATH]] · [[HARDWARE]]
