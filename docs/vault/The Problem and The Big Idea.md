---
tags: [ppe, guide, concept]
---

# The Problem and The Big Idea

> Why portion size is the hard, unsolved part of food logging — and the single physical insight that makes it solvable on any phone.

## The problem: scale ambiguity is a law of optics

A pinhole camera (which every phone camera approximates) maps the 3D world to a 2D image by projection. The defining property of that projection: **it destroys absolute scale.** Formally, if you scale the entire world by a factor λ and move the camera λ times closer, every ray through the lens is unchanged, so every pixel is identical. This is why *structure‑from‑motion* — reconstructing 3D from images — can only ever recover geometry **up to an unknown global scale factor**.

Concretely for food: **200 g and 400 g of rice can produce identical pixels.** No amount of cleverness extracts the missing scale from a single ordinary photo, because the information isn't there. (Full argument: [[MATH]] §1.)

This matters because portion size *is* the calorie number. Food **identification** is nearly solved — modern vision models reach ~93% precision naming a dish. Food **quantification** is the open problem. Google's [Nutrition5k](https://github.com/google-research-datasets/Nutrition5k) study quantified the gap precisely:

| Input to the model | Calorie error (MAPE) |
|---|---|
| RGB photo alone | **26.1%** |
| RGB **+ metric depth** | **16.5%** |
| (humans eyeballing) | ~41% |

That ~10‑point improvement is **pure scale information**. The whole game is: *get that scale.*

## Why not just use AI to guess the scale?

You can try to learn a prior — "plates are usually ~26 cm, so infer size from the plate." Two problems:
1. It's a **guess**, not a measurement. Plates, bowls, and camera angles vary enormously; the error is unbounded and, worse, *systematic* (biased) per scene.
2. It fails exactly where it matters — unusual portions, unusual dishware, close‑ups.

Density makes a wrong scale even more expensive: mass = density × volume, and density swings from ~0.15 g/mL (leafy greens) to ~1.1 g/mL (dense liquids). A scale error gets **squared** on the way to area, then multiplied by density. Guessing is not good enough. (Error propagation: [[Math 4 - Volume Mass and Nutrients]] and [[MATH]] §8.)

## The big idea: measured scale from the IMU

Every ARKit/ARCore phone has an **IMU** (accelerometer + gyroscope). The accelerometer measures *specific force* in **m/s²** — a real physical unit, hundreds of times per second. Over a short device motion, integrating acceleration twice gives a displacement in **meters**:

$$\Delta \mathbf{x}_{\text{IMU}} = \iint (\mathbf{a}(t) - \mathbf{g})\,dt^2 \quad [\text{m}]$$

The camera, meanwhile, tracks the *same* motion but only up to the unknown scale λ. The phone's **visual‑inertial odometry** (VIO) solves for the λ that makes the visual displacement agree with the metric IMU displacement. The result is profound:

> **ARKit/ARCore's world coordinate frame is in real meters on every capable phone — LiDAR or not.** Scale comes from Newton, not from a neural net.

This is exactly why the "Measure" app works on phones without depth sensors. This project stands on that fact. Instead of asking the network to guess how big things are, we **measure** with a 2‑second ruler gesture and feed a *known* scale into the rest of the pipeline. In practice, short‑range ARKit measurements are good to roughly ±0.5–1 cm when tracking is healthy — which the project verifies on real hardware in the "P0" drill (see [[Testing]]).

Deep dive on the physics: [[Math 1 - Metric Scale and the Pinhole Camera]].

## What the insight buys you

Once scale is *measured*, the rest of portioning becomes deterministic geometry you can write down and unit‑test — no learning required:
- pixels → real centimeters on the table (the plane homography, [[Math 3 - The Plane Homography]]),
- area → volume via three routes depending on what was measured ([[Math 4 - Volume Mass and Nutrients]]),
- volume → mass → calories via public databases ([[Nutrition Database]]).

And the one place a model *does* help — turning appearance + measured scale into mass — now has **strictly more information than any published RGB‑only model** (it knows the metric scale). That's the novel [[Mass Regressor Model]].

## The honest ceiling

Physics also tells you where the ceiling is. Realistic per‑item error is ~30% with shape priors only, ~20% with a measured height, ~16% with full depth — matching the Nutrition5k literature. You don't beat that with more AI; you beat it with more *measurement*. So the correct product design is **propose → confirm**: show a labeled estimate with an error band, let the user nudge the portion, and only then log it. Chasing sub‑20% fully‑autonomous accuracy is a research program, not a feature. (See [[STATUS]] §8.)

## Related
- [[Beginner Guide]] · [[Math 1 - Metric Scale and the Pinhole Camera]] · [[Math 4 - Volume Mass and Nutrients]] · [[System Architecture]] · [[MATH]] · [[STATUS]]
