---
tags: [ppe, reference, foundations, cs, math]
---

# CS Foundations

> The computer‑science and math toolkit this project runs on, built from zero. Each section ends with **where it's used** so you can jump to the applied note. If a symbol ever confuses you, check [[Glossary]].

You do **not** need all of this before reading the applied notes — skim, then come back. The four topics that carry the most weight: **vectors/matrices**, **homogeneous coordinates**, **least squares**, and **gradient descent**.

---

## 1. Vectors and matrices (linear algebra)

A **vector** is an ordered list of numbers, e.g. a 3D point $\mathbf{x} = (x, y, z)$. A **matrix** is a rectangular grid of numbers that represents a *linear transformation* — rotate, scale, project. Multiplying a matrix by a vector transforms the vector.

Operations you'll see everywhere:
- **Dot product** $\mathbf{a}\cdot\mathbf{b} = \sum_i a_i b_i$ — measures alignment; zero means perpendicular. Used to test "is this point on the plane?" ($\mathbf{n}\cdot\mathbf{X} = d_0$) and to project onto axes.
- **Cross product** $\mathbf{a}\times\mathbf{b}$ — gives a vector perpendicular to both; used to build a coordinate frame on a plane.
- **Norm** $\lVert\mathbf{x}\rVert = \sqrt{\mathbf{x}\cdot\mathbf{x}}$ — length. **Normalize** = divide by norm to get a unit (length‑1) direction.
- **Matrix × vector** — apply a transform. **Matrix × matrix** — compose transforms. **Transpose** $M^\top$ — flip across the diagonal; for a rotation matrix, the transpose is its inverse. **Inverse** $M^{-1}$ — undo the transform.

In this codebase these are hand‑written in `packages/geometry/src/vec.ts` (3‑ and 4‑element vectors, 3×3 matrices) with **zero dependencies** — small enough to read in one sitting.

**Where used:** everywhere in [[Math 1 - Metric Scale and the Pinhole Camera]], [[Math 2 - The Ruler]], [[Math 3 - The Plane Homography]], and the [[Geometry Library]].

---

## 2. Coordinate frames and rigid transforms

A **coordinate frame** is a choice of origin + axes. The same physical point has different number‑coordinates in different frames. Three frames matter here:
- **World frame** — fixed to the room, in meters (ARKit gives us this).
- **Camera frame** — attached to the phone; x right, y down, z forward (computer‑vision convention).
- **Plane frame** — a 2D frame lying flat on the table.

A **rigid transform** (rotation $R$ + translation $\mathbf{t}$) converts coordinates between frames: $\mathbf{x}_{\text{cam}} = R\,\mathbf{x}_{\text{world}} + \mathbf{t}$. A **convention trap** that bites everyone: ARKit's camera frame is y‑**up**, z‑**back**, but the CV math assumes y‑down, z‑forward. You must flip signs exactly once — the code does it in `poseFromArkitCameraToWorld` ([[Geometry Library]]), and there's a regression test for it ([[Testing]]).

---

## 3. Homogeneous coordinates and projective geometry

This is the trick that makes camera math clean. Add a "1" to a point: $(x, y) \to (x, y, 1)$. Now:
- **Translation becomes a matrix multiply** (it couldn't before), so *every* transform — rotate, scale, translate, project — is a single matrix.
- Points are equal **up to scale**: $(x, y, 1)$ and $(2x, 2y, 2)$ are the *same* 2D point. To read off the real 2D point, **divide by the last coordinate** ("dehomogenize"): $(a, b, w) \to (a/w, b/w)$.

That last rule *is* perspective. A **camera projection** is just: take a 3D point in homogeneous form, multiply by a matrix, divide by the last coordinate. The division is why far things look small.

A **homography** is a 3×3 matrix mapping one plane to another plane (e.g. the table → the image). It's invertible, so $H^{-1}$ maps image pixels of the table back to real centimeters. This single idea powers the exact area measurement.

**Where used:** the pinhole model ([[Math 1 - Metric Scale and the Pinhole Camera]]) and the plane homography ([[Math 3 - The Plane Homography]]).

---

## 4. Least squares (fitting a model to noisy data)

You have many noisy measurements and a model with a few parameters; you want the parameters that best fit. **Least squares** picks the parameters that minimize the sum of squared errors. For a linear model this has a clean closed‑form solution (solve $A\mathbf{x} = \mathbf{b}$ in the least‑squares sense).

Two appearances here:
- ARKit fits the **table plane** to many tracked 3D points by least squares.
- The depth‑map plane fit in training (`prepare_nutrition5k.py`) solves `depth(x,y) ≈ ax + by + c` over border pixels with `np.linalg.lstsq` — a literal least‑squares plane fit ([[Training Pipeline]], [[Shape Priors and Nutrition5k]]).

**Intuition:** squaring the error punishes big misses hard and gives a unique, smooth answer. Its weakness — sensitivity to outliers — motivates the next section.

---

## 5. Probability, robust statistics, and error propagation

**Mean vs. median.** The mean (average) is pulled around by outliers; the **median** (middle value) ignores them. This project leans on the median wherever a few bad samples could wreck things:
- The ruler's anchor is the **median** of a rolling buffer of recent hits, so a hand tremor spike can't move it ([[Math 2 - The Ruler]]).
- The shape priors κ/φ/h̄ are fit as **medians** across dishes, so mislabeled dishes don't drag them ([[Shape Priors and Nutrition5k]]).
- Densities are the **median** across a food's volumetric portions ([[Nutrition Database]]).

**Averaging reduces noise.** For $N$ independent, zero‑mean noisy samples, the average's error shrinks like $1/\sqrt{N}$. That's why buffering ~6 frames and taking the middle helps.

**Error propagation.** When a result is a *product* $m = \rho\cdot\varphi\cdot A\cdot h$, the **relative** errors add in quadrature (squares):
$$\left(\frac{\sigma_m}{m}\right)^2 \approx \left(\frac{\sigma_\rho}{\rho}\right)^2 + \left(\frac{\sigma_A}{A}\right)^2 + \left(\frac{\sigma_h}{h}\right)^2 + \left(\frac{\sigma_\varphi}{\varphi}\right)^2$$
And because area depends on scale *squared* ($A \propto s^2$), a scale error enters **doubled**. This is the entire honesty story — [[Math 4 - Volume Mass and Nutrients]] and `error-budget.ts`.

---

## 6. Calculus you actually need: Riemann sums

Integration = adding up infinitely many infinitesimal pieces. In practice on a computer it's a **Riemann sum**: to get the volume under a height field, chop the area into tiny cells, multiply each cell's height by its area, and add:
$$V = \sum_{\text{cells}} \max(0, h)\cdot \Delta A$$
That's literally `integrateHeightFieldM3` — the LiDAR volume route. Same idea gives the **shoelace formula** for a polygon's area (a discrete sum over its vertices). No continuous calculus required; just careful sums. See [[Math 4 - Volume Mass and Nutrients]].

---

## 7. Neural networks from zero

A **neural network** is a big function with millions of tunable numbers (**weights**). You show it inputs, compare its output to the right answer with a **loss function** (a number measuring wrongness), and nudge the weights to reduce the loss. Repeat millions of times.

- **Gradient descent** — the nudging rule. The **gradient** is the direction of steepest increase of the loss; step the *opposite* way. **Backpropagation** is the efficient algorithm (calculus chain rule) that computes the gradient for every weight in one backward pass. **Learning rate** = step size. **Epoch** = one pass over the whole dataset. **Adam/AdamW** = a popular gradient‑descent variant; **cosine schedule** = gently shrink the step size over training.
- **Convolutional neural network (CNN)** — a network for images. A **convolution** slides a small learnable filter across the image, detecting local patterns (edges → textures → parts → objects) as you stack layers. Efficient because the same filter is reused everywhere. The [[Mass Regressor Model]] uses a small CNN (MobileNetV3) as its "eyes."
- **Transformer / attention** — an alternative to convolution where every patch of the image can "attend to" (look at) every other patch, learning long‑range relationships. **SegFormer** (the segmentation model) is a transformer. See [[Segmentation Model]].
- **Segmentation vs. classification vs. regression** — *classification* outputs a label ("rice"); *segmentation* labels **every pixel** ("these pixels are rice"); *regression* outputs a **number** ("161 grams"). This project uses all three.
- **Fine‑tuning** — take a model already trained on a huge dataset and continue training it on your specific task. Cheaper and better than starting from scratch when data is limited. The segmenter is fine‑tuned; the mass regressor's backbone is pretrained then adapted.
- **Loss in log space.** If you care about *relative* (percentage) error and your targets span orders of magnitude (a leaf vs. a steak), train on $\log(\text{mass})$ instead of mass. Then equal absolute errors in log‑space mean equal *ratios* in real space — which is exactly what the % benchmark (MAPE) measures. Used by the [[Mass Regressor Model]].
- **Metrics.** **mIoU** (mean intersection‑over‑union) scores segmentation: overlap of predicted vs. true region, averaged over classes. **MAPE** (mean absolute percentage error) scores the regressor. Both in [[Glossary]].

---

## 8. Software‑engineering concepts used here

- **Monorepo + workspaces** — many packages in one repo, cross‑referenced by name (`@ppe/geometry`). See [[Testing]].
- **Schema validation (zod)** — describe the exact shape of data once; validate untrusted input against it at runtime. The `CapturePayload`/`EstimateResult` contracts. See [[The Pipeline]].
- **Adapter pattern** — depend on an *interface*, not a concrete class, so you can swap mocks for real models without touching the core. See [[System Architecture]].
- **Pure functions + property tests** — geometry is pure (same input → same output, no side effects), so it can be tested against synthetic scenes with *known* answers to 1e‑9. See [[Testing]].
- **ETL** (Extract‑Transform‑Load) — the nutrition data build: read CSVs, transform, load into SQLite. See [[Nutrition Database]].
- **Atomic writes / resumability** — the dataset downloader streams to a `.part` file then renames, so an interruption never leaves a half‑file. See [[Training Pipeline]].

## Related
- [[Math 1 - Metric Scale and the Pinhole Camera]] · [[Math 3 - The Plane Homography]] · [[Math 4 - Volume Mass and Nutrients]] · [[Mass Regressor Model]] · [[Glossary]] · [[Home]]
