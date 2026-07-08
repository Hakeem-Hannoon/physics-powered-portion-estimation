---
tags: [ppe, reference, roadmap]
---

# Roadmap and Next Steps

> Where the project stands and what happens next. This is a teaching‑oriented digest; the **authoritative, dated copy is [[STATUS]]** — when they differ, STATUS wins.

## The goal

Be the portion‑estimation engine for **Spotter** meal logging, and stand alone as an MIT‑licensed library any app can adopt. Contract: `EstimateResult.items` maps 1:1 onto Spotter's `MealItem`, so results flow into an existing propose→confirm logging path. Everything is a labeled, **editable** estimate with an error band — the system proposes, the user confirms, the database writes only on confirmation.

## ✅ Done (built, tested)

- **`@ppe/geometry`** — all of [[MATH]] as zero‑dep code, **20 synthetic‑scene tests** to ~1e‑9. → [[Geometry Library]]
- **`@ppe/pipeline`** — `estimateMeal` with zod contracts on both edges, pluggable adapters, mocks, the never‑invent rule, **4 e2e tests**. → [[The Pipeline]]
- **`nutrition/` ETL** — USDA FDC → on‑device SQLite bundle, **3 tests**. → [[Nutrition Database]]
- **27 tests green, typecheck clean, CI on every push.** → [[Testing]]
- **Android capture module** (Kotlin/ARCore) — the full reworked screen (sparkle reticle, 45 lb plate trackpad, [[Math 2 - The Ruler]] §2.4 stabilization), running on a Pixel. → [[The Capture App]]
- **Demo app** — capture → pipeline with a placeholder segmenter. → [[The Capture App]]
- **Training scripts + Colab notebooks 01–04** — SegFormer fine‑tune, mass regressor, manifest extraction, prior fitting, Core ML export. → [[Training Pipeline]]
- **Docs** — [[MATH]], [[ARCHITECTURE]], [[MODELS]], [[HARDWARE]], [[STATUS]], and this vault.

## 🟡 In progress / waiting on

- **SegFormer fine‑tune (notebook 02)** — training on an A100; waiting on final mIoU (target ≥ 0.25 B0 / ≥ 0.32 B1). → [[Segmentation Model]]
- **Nutrition5k manifest + priors (notebook 03)** — dataset staged; extraction running; waiting on `priors.json` to replace `DEFAULT_KAPPA = 0.55`. → [[Shape Priors and Nutrition5k]]
- **Mass regressor (notebook 03)** — needs a GPU runtime; waiting on calorie MAPE vs. the 26.1% / 16.5% baselines. → [[Mass Regressor Model]]
- **P0 / P1 physical drills** — ruler vs. tape measure; geometry‑only mass vs. kitchen scale. → [[Testing]]
- **Screenshots** — README image slots awaiting device upload.

## ⬜ Next (ordered)

1. **Wire the fitted priors** — drop κ/φ/h̄ from `priors.json` into [[The Pipeline]] (`DEFAULT_KAPPA` + per‑class) and [[Nutrition Database]]'s `shape_priors`. *Smallest, highest‑value step; unblocks the moment notebook 03 finishes.*
2. **iOS capture parity** — port the reticle + plate‑trackpad + stabilization from Android to the Swift module; run P0 on iPhone. iPhone Pro also unlocks the LiDAR height‑field volume route. → [[The Capture App]]
3. **Real model adapters** — replace the mocks: `Segmenter` (SAM 2.1‑tiny Core ML / SegFormer via ExecuTorch), `Classifier` (MobileCLIP zero‑shot), `DepthProvider` (LiDAR). De‑risk the Android ExecuTorch custom‑model path first. → [[Segmentation Model]]
4. **On‑device nutrient bundle** — run the ETL over real FDC CSVs, ship the SQLite as an asset, implement `NutrientStore` over expo‑sqlite, and curate the **label → FDC‑row** mapping (the quality‑critical artifact). → [[Nutrition Database]]
5. **Core ML / ExecuTorch export + inference wiring** — notebook 04 exports; wire and benchmark on‑device. → [[Training Pipeline]]
6. **Confirm/edit UI** — adjust the outline, swap the label, tweak portions before logging.
7. **Spotter integration** — add the module + `@ppe/*` to Spotter's app; "Scan meal" entry; map results into the logging flow; Pro‑gate; fall back to the cloud path on unsupported devices.
8. **P3/P4** — the regressor in the loop, A/B vs. geometry, fill the benchmark tables. → [[Testing]]

## Milestone tracker

| Milestone | Proves | State |
|---|---|---|
| **P0** ruler accuracy | the physics on real hardware (≤ 5 mm) | 🟡 ready to run |
| **P1** geometry‑only mass | the metric pipeline on real food (≤ 25%) | 🟡 pending P0 |
| **P2** models in | on‑device segment + classify wired | ⬜ |
| **P3** the regressor | scale‑conditioned regression, A/B | 🟡 training now |
| **P4** benchmark + integrate | Nutrition5k numbers; live in Spotter | ⬜ |

## The load‑bearing constraint

Portion size is a **hard ceiling by physics**: ~30% (priors) → ~20% (measured height) → ~16% (depth), matching the Nutrition5k literature. You don't beat it with more AI — you beat it with more measurement, and the propose→confirm‑with‑editable‑portions UX is the correct answer. Chasing sub‑20% autonomous accuracy is a research program, not a feature. → [[The Problem and The Big Idea]], [[STATUS]] §8.

## Related
- [[STATUS]] · [[Home]] · [[The Pipeline]] · [[Shape Priors and Nutrition5k]] · [[Mass Regressor Model]] · [[Testing]]
