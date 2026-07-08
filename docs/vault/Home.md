---
tags: [ppe, moc, home]
---

# 🏠 PPE Vault — Home

> **Physics-Powered Portion Estimation (PPE)** — turn a meal photo *plus a measured real‑world scale* into calories, macros, and micros. This vault teaches the whole project from the ground up: the math, the architecture, the computer science, the models, and where it's all going next.

**How to use this vault:** open the **`docs/` folder** as your Obsidian vault (File → Open folder as vault → pick `physics-powered-portion-estimation/docs`). Then the wiki‑style links below all resolve — including the canonical spec docs [[MATH]], [[ARCHITECTURE]], [[MODELS]], [[HARDWARE]], and [[STATUS]] that live alongside this vault. Open the graph view (⌘/Ctrl‑G) to see how everything connects.

The **spec docs** (`MATH.md`, `ARCHITECTURE.md`, …) are the terse source of truth written for someone who already knows the field. The **vault notes** (this folder) are the *teaching layer* — they re‑derive and explain the same material assuming you're starting fresh. When in doubt, the spec wins; if they ever disagree, that's a bug — tell me.

---

## The one‑paragraph version

A single photo can't tell you if that's 200 g or 400 g of rice — the pixels are identical, because a camera has no sense of absolute size. This project fixes that by **measuring** the scale instead of guessing it: a 2‑second "tap‑hold‑slide" ruler gesture on the phone screen, made metric by the phone's motion sensors (the same physics that lets ARKit's Measure app work). With real‑world scale in hand, the rest is geometry you can write down: segment the food, measure its area and height, turn that into volume, multiply by density to get grams, and look up nutrition. One small neural network is trained where no formula exists (mass from appearance + measured scale). Everything runs on the phone.

```
 CAPTURE (AR ruler, pure geometry)  →  SEGMENT → CLASSIFY → PORTION (metric geometry) → NUTRIENTS (USDA)
   [[The Capture App]]                  [[Segmentation Model]]  [[Math 4 - Volume Mass and Nutrients]]  [[Nutrition Database]]
```

---

## 🧭 Start here (reading path for a newcomer)

1. [[Beginner Guide]] — the whole project in plain language, no jargon assumed.
2. [[The Problem and The Big Idea]] — *why* portion size is the hard problem and the one insight that cracks it.
3. [[System Architecture]] — the two halves (capture + pipeline) and how a photo becomes a number.
4. [[CS Foundations]] — the math/CS toolkit (vectors, matrices, projection, calculus, probability, neural nets) used everywhere, explained from zero.
5. Then follow your interest into **The Math**, **The Code**, or **The Models** below.

---

## 📐 The Math (the "physics" in the name)

The full formal derivation is [[MATH]]. These notes teach it in four steps:

- [[Math 1 - Metric Scale and the Pinhole Camera]] — why the world frame is in *meters* (IMU + visual‑inertial odometry), and the pinhole camera model (pixels ↔ rays).
- [[Math 2 - The Ruler]] — ray ∩ plane, the tap‑hold‑slide gesture, and the statistics that make a shaky hand accurate.
- [[Math 3 - The Plane Homography]] — the exact pixels→cm² map, why a single "meters‑per‑pixel" number is wrong, and the off‑plane (height) bias.
- [[Math 4 - Volume Mass and Nutrients]] — area→volume (three routes), volume→mass (density), mass→calories (Atwater), and the honest error budget.

## 💻 The Code (the runtime, TypeScript)

- [[Geometry Library]] — `@ppe/geometry`: [[MATH]] as ~zero‑dependency tested code, function by function.
- [[The Pipeline]] — `@ppe/pipeline`: `estimateMeal()` orchestration, the zod contracts, the pluggable model adapters, and the "never invent nutrition" rule.
- [[The Capture App]] — the native ARKit/ARCore module (the sparkle reticle + "45 lb plate" trackpad) and the demo app.
- [[Nutrition Database]] — the `nutrition/` ETL that turns USDA CSVs into an on‑device SQLite bundle.

## 🧠 The Models (the ML, PyTorch → Core ML)

Full model landscape: [[MODELS]].

- [[Segmentation Model]] — finding the food in the image (SegFormer / SAM), transformers and mIoU from scratch.
- [[Mass Regressor Model]] — the *novel* model: mass from a rectified crop + measured scale (CNN + FiLM), from scratch.
- [[Shape Priors and Nutrition5k]] — the κ/φ/h̄ constants fit from data, and the Nutrition5k dataset + manifest extraction.
- [[Training Pipeline]] — the four Colab notebooks, the Drive‑vs‑local‑disk storage rules, how to reproduce.

## 📚 Reference

- [[CS Foundations]] — the underlying computer science and math, ground up.
- [[Testing]] — the automated suite (geometry / pipeline / ETL) and the physical P0/P1/P3 validation drills.
- [[Roadmap and Next Steps]] — what's done, what's in flight, and the ordered next steps (mirrors [[STATUS]]).
- [[Glossary]] — every term and symbol in one place.

---

## Canonical spec docs (the source of truth)

| Doc | What it fixes |
|---|---|
| [[MATH]] | Every equation from "finger on glass" to "412 kcal". |
| [[ARCHITECTURE]] | System design: capture module + inference pipeline, interfaces, repo map. |
| [[MODELS]] | Verified model inventory per stage; what to use vs. fine‑tune vs. train. |
| [[HARDWARE]] | The sensors (IMU, camera, LiDAR), device tiers, compute budget. |
| [[STATUS]] | Where the project stands; the roadmap's authoritative copy. |

Project overview lives in the repo root [`README.md`](../../README.md).
