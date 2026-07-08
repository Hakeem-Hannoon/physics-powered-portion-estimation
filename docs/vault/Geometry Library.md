---
tags: [ppe, codebase, geometry]
---

# Geometry Library

> `@ppe/geometry` — [[MATH]] turned into zero‑dependency, unit‑tested TypeScript. This is the "physics" of the pipeline as ~300 lines of pure functions. Source: `packages/geometry/src/`.

## Why it's a separate, dependency‑free package

Geometry is deliberately **not** a model. It's linear algebra that runs in microseconds and — because it's *pure functions* (same input → same output, no side effects) — can be tested against synthetic scenes with **known answers to ~1e‑9** ([[Testing]]). Zero dependencies keeps it tiny and portable (it can ship in an app bundle untouched). The public surface is re‑exported from `src/index.ts`:

```ts
export * from "./vec";     export * from "./camera";  export * from "./plane";
export * from "./homography"; export * from "./area"; export * from "./volume";
export * from "./energy";  export * from "./error-budget";
```

## File‑by‑file (each maps to a [[MATH]] section)

### `vec.ts` — the primitives
Hand‑written 3‑/4‑vectors and 3×3/4×4 matrices with the operations from [[CS Foundations]] §1: `dot`, `cross`, `normalize`, `add`, `sub`, `scale`, `mat3Mul`, `mat3MulVec`, `mat3Inverse`, `mat3Transpose`, `mat4RotationRowMajor`, etc. No external math library — this is the whole reason the package has zero deps.

### `camera.ts` — the pinhole model ([[Math 1 - Metric Scale and the Pinhole Camera]])
- `Intrinsics { fx, fy, cx, cy }`, `intrinsicsFromMatrix`, `intrinsicsToMat3`.
- `rescaleIntrinsics(k, from, to)` — the resolution‑rescale fix ([[MATH]] §9.1). *The #1 real‑world bug guard.*
- `poseFromArkitCameraToWorld(rowMajor4x4)` — **the convention conversion**: negates the y and z basis columns to go from ARKit (y‑up, z‑back) to CV (y‑down, z‑forward). Both native platforms feed their pose through this one function.
- `pixelRay(k, pose, px)` — pixel → world ray (origin + normalized direction).
- `projectPoint(k, wtc, x)` — world point → pixel (or `null` if behind the camera).
- `cameraHeightAbovePlane(pose, plane)` — signed camera height $Z$ (feeds the off‑plane correction).

### `plane.ts` — planes & the table frame ([[Math 2 - The Ruler]], [[Math 3 - The Plane Homography]])
- `Plane { n, d0 }`.
- `intersectRayPlane(origin, dir, plane)` — the ray∩plane solve $t^\* = (d_0 - \mathbf{n}\cdot\mathbf{o})/(\mathbf{n}\cdot\mathbf{d})$; returns `null` for parallel rays or hits behind the origin.
- `planeBasis(plane)` — builds an orthonormal on‑plane frame $\{O, e_1, e_2, n\}$ (via a cross product from a seed axis).
- `planeCoords` / `planePoint` — world ↔ 2D table coordinates.

### `homography.ts` — pixels ↔ metric plane ([[Math 3 - The Plane Homography]])
- `planeToImageHomography(k, wtc, basis)` — builds $H = K[R e_1 \mid R e_2 \mid RO + t]$.
- `applyHomography(h, p)` — multiply then dehomogenize (divide by the 3rd coord); throws if a point maps to infinity.
- `rulerResidualM(...)` — the §3.1 self‑check: project the ruler endpoints, map them back through $H^{-1}$, return $|{\text{recovered}} - {\text{measured}}|$. Surfaces as `ruler_residual_mm`.
- `elevationLengthFactor(cameraHeightM, featureHeightM)` — the off‑plane correction factor $(Z - h)/Z$ ([[MATH]] §3.2). *Multiply lengths by it; square it for areas.*

### `area.ts` — metric area ([[Math 3 - The Plane Homography]])
- `polygonArea(pts)` — the shoelace sum.
- `pixelPolygonToPlane(imageToPlane, poly)` — map a pixel polygon into meters.
- `metricPolygonAreaM2(imageToPlane, polygonPx)` — the two composed: pixel outline → m². Plus `M2_TO_CM2`.

### `volume.ts` — the three routes + mass ([[Math 4 - Volume Mass and Nutrients]])
- `volumeShapePriorM3(areaM2, kappa)` — route (c), $V = \kappa A^{3/2}$.
- `volumeAreaHeightM3(areaM2, heightM, phi=1)` — route (b), $V = \varphi A h$.
- `integrateHeightFieldM3(heights, cellAreaM2)` — route (a), $\sum\max(0,h)\,\Delta A$.
- `massG(volumeMl, densityGPerMl)` — $m = \rho V$. Plus `M3_TO_ML`.

### `energy.ts` — nutrients & Atwater ([[Math 4 - Volume Mass and Nutrients]])
- Types: `MicroKey`, `Micros`, `NutrientsPer100g`, `NutrientAmounts`.
- `nutrientsForMassG(per100, massG)` — scale per‑100 g by `mass/100`.
- `atwaterKcal(P, C, F)` = $4P + 4C + 9F$; `atwaterDeviation(...)` — relative deviation, `null` when kcal < 1.

### `error-budget.ts` — propagation ([[Math 4 - Volume Mass and Nutrients]])
- `ScaleSource` type and a `SCALE_REL` table (lidar 0.015, ruler 0.025, reference 0.045, stated 0.075, none 0.25).
- `combinedRelativeError(e)` = `Math.hypot(2·scaleRel, segRel, heightRel, densityRel)` — quadrature with the scale term **doubled**.
- `errorPreset(source, heightMeasured)` — the default budget (segmentation 0.08, height 0.10 if measured else 0.25, density 0.15).

## Design notes worth absorbing
- **Everything is a small pure function.** No classes, no state, no I/O. That's what makes the 1e‑9 tests possible.
- **Every function cites its [[MATH]] section in a docstring** — the code *is* the spec, kept honest by the tests.
- **Guards, not silent NaNs.** Bad inputs throw (`intrinsicsFromMatrix` on a degenerate matrix, `applyHomography` on a point at infinity, negative area/density), so failures surface loudly.

## Related
- [[The Pipeline]] · [[Math 1 - Metric Scale and the Pinhole Camera]] · [[Math 2 - The Ruler]] · [[Math 3 - The Plane Homography]] · [[Math 4 - Volume Mass and Nutrients]] · [[Testing]] · [[MATH]]
