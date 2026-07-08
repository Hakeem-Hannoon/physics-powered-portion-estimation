---
tags: [ppe, reference, glossary]
---

# Glossary

> Every term and symbol in one place. Each entry links to the note that explains it in depth.

## Symbols

| Symbol | Meaning | See |
|---|---|---|
| $K$ | camera intrinsic matrix $[[f_x,0,c_x],[0,f_y,c_y],[0,0,1]]$ | [[Math 1 - Metric Scale and the Pinhole Camera]] |
| $f_x, f_y$ | focal lengths in pixels | [[Math 1 - Metric Scale and the Pinhole Camera]] |
| $c_x, c_y$ | principal point (≈ image center) in pixels | [[Math 1 - Metric Scale and the Pinhole Camera]] |
| $\mathbf{n}, d_0$ | plane normal and offset: $\mathbf{n}\cdot\mathbf{X}=d_0$ | [[Math 2 - The Ruler]] |
| $H$ | homography (table metric coords ↔ image pixels) | [[Math 3 - The Plane Homography]] |
| $Z$ | camera height above the table plane | [[Math 3 - The Plane Homography]] |
| $A$ | food footprint area (m²) | [[Math 3 - The Plane Homography]] |
| $h$ | food height above the table (m) | [[Math 4 - Volume Mass and Nutrients]] |
| $V$ | food volume | [[Math 4 - Volume Mass and Nutrients]] |
| $\rho$ | density (g/mL) | [[Math 4 - Volume Mass and Nutrients]] |
| $\kappa$ (kappa) | shape prior in $V=\kappa A^{3/2}$ | [[Shape Priors and Nutrition5k]] |
| $\varphi$ (phi) | fill factor in $V=\varphi A h$ | [[Shape Priors and Nutrition5k]] |
| $\bar h$ (h‑bar) | flat‑food thickness prior | [[Shape Priors and Nutrition5k]] |
| $\lambda$ (lambda) | the unknown global scale factor vision alone can't recover | [[The Problem and The Big Idea]] |
| $\gamma, \beta$ | FiLM per‑channel scale & shift | [[Mass Regressor Model]] |

## Terms

**AR (augmented reality)** — here, ARKit (iOS) / ARCore (Android): the frameworks that give a metric world frame, plane detection, and raycasting. See [[HARDWARE]].

**ARKit / ARCore** — Apple's / Google's AR frameworks. Provide the metric pose, intrinsics, plane, and (optionally) depth in the `CapturePayload`. See [[The Capture App]].

**Atwater identity** — kcal ≈ 4·protein + 4·carbs + 9·fat; used as a data‑sanity cross‑check. See [[Math 4 - Volume Mass and Nutrients]].

**Backpropagation** — the chain‑rule algorithm that computes gradients for every weight in a network. See [[CS Foundations]] §7.

**CapturePayload** — the versioned JSON contract from the native capture module to the pipeline. See [[System Architecture]].

**CNN (convolutional neural network)** — an image network built from sliding learnable filters. The mass regressor's backbone. See [[CS Foundations]] §7, [[Mass Regressor Model]].

**Density** — mass per volume (g/mL); the bridge from volume to grams; comes from USDA/FAO data. See [[Nutrition Database]].

**ETL (Extract‑Transform‑Load)** — the nutrition data build (CSVs → SQLite). See [[Nutrition Database]].

**FiLM (Feature‑wise Linear Modulation)** — conditioning trick where scalars produce a per‑channel scale/shift on visual features. The core of the mass regressor. See [[Mass Regressor Model]].

**Fine‑tuning** — continuing to train a pretrained model on your specific task. See [[CS Foundations]] §7, [[Segmentation Model]].

**FoodSeg103** — a 104‑class food segmentation dataset; the segmenter's fine‑tune target. See [[Segmentation Model]].

**FUSE / `Errno 103`** — the Google Drive filesystem layer; it aborts on many‑small‑file workloads, which drives the Colab local‑disk storage rule. See [[Training Pipeline]].

**Gradient descent** — the training loop: nudge weights opposite the loss gradient. See [[CS Foundations]] §7.

**Homography** — a 3×3 matrix mapping one plane to another (table ↔ image). See [[Math 3 - The Plane Homography]].

**Homogeneous coordinates** — appending a "1" so translation and perspective are matrix multiplies; read out by dividing by the last coordinate. See [[CS Foundations]] §3.

**IMU (inertial measurement unit)** — accelerometer + gyroscope; the accelerometer's m/s² reading is what makes the world frame metric. See [[Math 1 - Metric Scale and the Pinhole Camera]].

**Intrinsics** — the camera's $K$ (fx, fy, cx, cy); resolution‑bound. See [[Math 1 - Metric Scale and the Pinhole Camera]].

**Least squares** — fitting parameters by minimizing squared error (e.g. the table‑plane fit). See [[CS Foundations]] §4.

**LiDAR** — a time‑of‑flight depth sensor on Pro iPhones/iPads; gives the highest‑accuracy volume route. See [[HARDWARE]].

**MAPE (mean absolute percentage error)** — the regressor's metric; % error averaged. Nutrition5k baselines: 26.1% RGB / 16.5% depth. See [[Mass Regressor Model]].

**Manifest** — the CSV of per‑dish metric features + labels extracted from Nutrition5k; input to priors + regressor. See [[Shape Priors and Nutrition5k]].

**Median (robust statistic)** — the middle value; ignores outliers. Used for anchoring, priors, densities. See [[CS Foundations]] §5.

**mIoU (mean intersection‑over‑union)** — the segmentation metric; overlap of predicted vs. true region, averaged over classes. See [[Segmentation Model]].

**Monorepo / workspaces** — one repo, many packages cross‑referenced by name (`@ppe/*`). See [[Testing]].

**Pinhole model** — the camera model mapping pixels ↔ rays via $K$. See [[Math 1 - Metric Scale and the Pinhole Camera]].

**Plane homography** — see Homography.

**Raycast** — shoot a ray from a pixel into the world and intersect it with geometry (the plane). See [[Math 2 - The Ruler]].

**Regression** — a model that outputs a number (grams), vs. classification (a label). See [[CS Foundations]] §7, [[Mass Regressor Model]].

**SAM (Segment Anything Model)** — a promptable segmenter; the ruler tap can be its prompt. See [[Segmentation Model]].

**scale_source** — where the metric scale came from: `lidar` \| `ruler` \| `reference_object` \| `stated` \| `none` (the fallback ladder). See [[System Architecture]], [[MATH]] §7.

**SegFormer** — a transformer‑based segmentation model; the fine‑tune target. See [[Segmentation Model]].

**Segmentation** — per‑pixel labeling (the food's outline). See [[Segmentation Model]].

**Shoelace formula** — polygon area from ordered vertices. See [[Math 3 - The Plane Homography]].

**Transformer / attention** — a network where every patch can attend to every other; SegFormer's basis. See [[CS Foundations]] §7.

**VIO (visual‑inertial odometry)** — fusing camera + IMU to get a metric pose; the source of the meters. See [[Math 1 - Metric Scale and the Pinhole Camera]].

**zod** — the runtime schema‑validation library enforcing the `CapturePayload` / `EstimateResult` contracts. See [[The Pipeline]].

## Related
- [[Home]] · [[CS Foundations]] · [[Beginner Guide]] · [[MATH]]
