# Project Status & Roadmap

The single source of truth for where this project stands. Updated 2026-07-10.

Companion docs: [`../README.md`](../README.md) (overview) · [`MATH.md`](MATH.md) (derivations) · [`ARCHITECTURE.md`](ARCHITECTURE.md) (system design) · [`MODELS.md`](MODELS.md) (model landscape) · [`HARDWARE.md`](HARDWARE.md) (sensors/devices) · [`CAPTURE_QUALITY.md`](CAPTURE_QUALITY.md) (image-capture audit + R1–R9).

---

## 1. The product

**What it is:** an on-device engine that turns a meal photo plus a *measured* real-world scale into nutrition — `(photo, scale) → calories + macros + micros` — where the scale comes from a 2-second AR ruler gesture instead of a guess.

**The goal:** be the portion-estimation engine for **Spotter** ([spotter-labs.com](https://spotter-labs.com)) meal logging, and stand alone as an MIT-licensed library any app can adopt.

**Why it exists:** food *identification* is nearly solved (~93% precision from modern vision models); **portion size is the open problem**. A single RGB photo is scale-ambiguous — 200 g and 400 g of rice can produce identical pixels. Google's Nutrition5k quantified the gap: **26.1% calorie error from RGB alone → 16.5% once metric depth is added**. That delta is pure scale information. LiDAR phones capture it in hardware; this project recovers it on *any* ARKit/ARCore phone with a tap-hold-slide ruler, because the IMU makes the world frame metric (physics, not ML).

**The pipeline (all on-device):**

```
CAPTURE (AR ruler, geometry only)   →   SEGMENT → CLASSIFY → PORTION (metric geometry) → NUTRIENTS (USDA FDC)
```

**The design contract that ties it to Spotter:** `EstimateResult.items` maps 1:1 onto Spotter's `MealItem` (`description`/`proteinG`/`carbsG`/`fatG`/`micros`), so results flow straight into the existing `create_pending_macro_log` propose→confirm path. Everything is a labeled, editable estimate with a propagated error band — the system proposes, the user confirms, the database writes only on confirmation.

---

## 2. Status legend

✅ Complete & verified · 🟡 In progress / waiting on external work · ⬜ Not started

---

## 3. ✅ Done

### Core libraries (TypeScript, tested)
- ✅ **`@ppe/geometry`** — the entire `MATH.md` as zero-dependency code: pinhole camera + ARKit↔CV conversion, ray–plane intersection, the exact plane homography (pixels→cm²), off-plane bias correction, three volume routes (LiDAR height-field / area×height / shape prior), density→mass, Atwater energy, error-budget propagation, and the shake-gated stabilization helpers. **20 synthetic-scene tests** verifying ground truth to ~1e-9.
- ✅ **`@ppe/pipeline`** — `estimateMeal(payload, deps)` with zod contracts enforced on **both** edges (capture payload in, estimate out), pluggable model adapters (`Segmenter`/`Classifier`/`NutrientStore`/`DepthProvider`), mocks, and the "unknown food returns null, never invents nutrition" rule. **4 end-to-end tests.**
- ✅ **`nutrition/` ETL** — USDA FoodData Central CSVs → on-device SQLite bundle (per-100 g nutrients + portion-derived densities, FTS-indexed) on Node's built-in SQLite, zero deps. **3 tests.**
- ✅ **27 tests total green, typecheck clean, CI** runs the suite on every push.

### Android capture module (built, on-device, iterated from real testing)
- ✅ **`expo-portion-capture` (Kotlin/ARCore)** — the full native capture screen, **built, installed, and running on a Pixel**:
  - Center **sparkle reticle** (AI four-point star + glitter) — dashed while searching, solid when locked on a surface.
  - **45 lb gym-plate trigger** that doubles as a **thumb trackpad**: hold to anchor, slide the thumb to steer the reticle (2.2× gain) so the phone stays steady and the finger never covers the food; releases and recenters per stroke.
  - **Shake-gated median stabilization** — pre-press median anchoring (the jolt can't contaminate frames captured before it), rolling-median live endpoint, plane snapping; violent-motion gate only.
  - **Free-surface measuring** — hits planes of any orientation, depth points, and feature points, so measuring is never gated on table detection (a support plane still sharpens the portion math and the coaching nudges toward it).
  - Live coaching state machine, "hold steady / screen parallel to the table" guidance, off-mission wink (`"not what this is for, but fine :)"`), too-far warning past 1.5 m, undo, GL camera background, 2D projected stroke overlay, versioned `CapturePayload` export.
- ✅ **Demo Expo app** (`apps/demo`) — capture → pipeline with a placeholder segmenter; the vehicle for the P0/P1 device drills.
- ✅ **Toolchain unblocked** — Android SDK, `local.properties`, `ANDROID_HOME`, monorepo Metro resolution, and the Expo-module dependency set all sorted so `npx expo run:android` builds clean.

### Capture-quality pass (R1–R9, code done — device validation pending)
- ✅ **Image resolution** — Android now selects the **largest-area CPU camera config** (was ARCore's ~640×480 default); iOS captures a **12 MP still** via ARKit 6 `captureHighResolutionFrame`, building the payload from the returned frame's own intrinsics/pose (MATH.md §9.1).
- ✅ **Android depth serialized** — `acquireDepthImage16Bits` → f32-meters sidecar with rescaled intrinsics; depth-capable Androids move to `scale_source: "lidar"` and unlock the §4a height-field route. (Confidence still `null` — Raw Depth API is the follow-up.)
- ✅ **iOS §2.4 stabilization** — per-frame median buffer + shake gate + plane snap ported under the existing tap-drag UI (accuracy parity; the reticle/plate-trackpad **interaction** redesign is still item 2 below).
- ✅ **Sharper + honest** — motion-blur shutter gate (both), pinned iOS encode quality, ambient-light coaching + torch (both), tilt/too-far coaching, real `tracking.state`, and an additive optional `capture_quality` telemetry block in the contract (feeds `est_relative_error`; turns P0/P1 into labeled quality data).
- ✅ Details + rationale + on-device verification plan: [`CAPTURE_QUALITY.md`](CAPTURE_QUALITY.md).

### Docs
- ✅ `README.md`, `MATH.md` (incl. §2.4 stabilization + §8 error budget), `ARCHITECTURE.md`, `MODELS.md` (web-verified model landscape), `HARDWARE.md`, `CAPTURE_QUALITY.md`, and this `STATUS.md`. Screenshot slots wired in the README (`docs/images/*`, pending upload).

### Training + infra (scripts ready, repo public)
- ✅ **Training scripts** — SegFormer/FoodSeg103 fine-tune (eval memory-safe, writes `eval_results.json`), the scale-conditioned mass regressor (MobileNetV3 + FiLM), Nutrition5k manifest extraction, prior fitting, Core ML export.
- ✅ **Colab notebooks 01–04** — Drive-backed, resumable, GCP-free download, token-aware/public clone, GPU auto-batch. All infra bugs (private-repo clone, gitignored script, HF-cache-on-Drive mmap, eval OOM) fixed.
- ✅ **Repo is public** at [github.com/Hakeem-Hannoon/physics-powered-portion-estimation](https://github.com/Hakeem-Hannoon/physics-powered-portion-estimation).

---

## 4. 🟡 In progress / waiting on

### Model training (running now, on the user's GPUs)
- ✅ **SegFormer fine-tune (notebook 02)** — done: **mIoU 0.246** (nvidia/mit-b0), at the ~0.25 B0 target and vs ≤ 0.05 for every public FoodSeg103 checkpoint.
- ✅ **Nutrition5k manifest + priors (notebook 03)** — manifest extracted (3,484 dishes; now resilient to corrupt captures), `priors.json` fit (κ=0.1687, φ=0.446, h̄=0.098 m) and **wired in** — replaced the `DEFAULT_KAPPA = 0.55` placeholder in `@ppe/pipeline` + `nutrition/`'s `shape_priors`; committed as `model/priors/priors.json`.
- ✅ **Mass regressor (notebook 03)** — trained: **mass MAPE 24.1%** (inside the §8 budget), kcal head ~32%. Tuning to beat the 26.1% RGB / 16.5% depth calorie baselines is the next experiment (`docs/vault/Mass Regressor Model.md` → "Improving the model").

### Physical validation (the user's phone + kitchen)
- 🟡 **P0 — ruler accuracy** — measure known objects vs a tape measure at multiple angles. Pass bar: median ≤ 5 mm on 20 cm spans. This certifies the physics on real hardware → first real README results row.
- 🟡 **P1 — geometry-only mass** — ~30 home meals, kitchen-scale ground truth, placeholder segmentation. Pass bar: median mass error ≤ 25%. Proves the geometry before any model is trusted.

### Content
- 🟡 **Screenshots** — README `docs/images/{capture-idle,capture-measuring,capture-stroke,estimate-card}.png` slots defined; awaiting upload from device.

---

## 5. ⬜ Coming up next (ordered)

1. ✅ **Wire the fitted priors — done.** κ=0.1687 / φ=0.446 / h̄=0.098 m (n=3,484) are now `DEFAULT_KAPPA`/`DEFAULT_MOUND_PHI` in `@ppe/pipeline`, the ETL's default `shape_priors`, and `model/priors/priors.json`. Per-class values await per-class labels.
2. 🟡 **iOS capture parity** — the §2.4 stabilization stats + capture-quality pass (R1–R9) are now ported, so iOS is at **accuracy** parity under its existing tap-drag UI. Remaining: the reticle + plate-trackpad **interaction** redesign (finger-never-covers-food), then dev-build and run P0 on iPhone. iPhone Pro (LiDAR) additionally unlocks the measured height-field volume route (highest-accuracy tier).
3. ✅ **Real model adapters — the vision stack is on-device.** The demo now **classifies the food and weighs it end-to-end** with no picker (guide: `docs/REAL_ADAPTERS.md`):
   - **`Classifier`** — MobileCLIP-S0 zero-shot (ONNX image encoder + precomputed text embeddings). **Validated 6/6 top-1** on real photos through the shipped preprocessing.
   - **`Segmenter`** — SlimSAM (SAM-2.1-tiny-class) point-prompted at the frame center; a hand-coded Node run of the shipped math reproduced transformers.js's mask bbox to the pixel. Falls back to a centered square on failure.
   - **`NutrientStore`** — real (see item 4).
   - **Runtime decision:** `onnxruntime-react-native` (one cross-platform ONNX per model) instead of the ExecuTorch custom-model path — this *is* the de-risking of that "highest-risk unknown". The platform-agnostic preprocessing lives in `@ppe/pipeline` (`preprocess.ts`, 13 tests).
   - **Remaining:** on-device runtime validation (the P2 drill — mask quality on real captures, latency), then `DepthProvider` (LiDAR iOS; Android Depth16) for the highest-accuracy volume route.
4. 🟡 **On-device nutrient bundle** — **done for the demo**: `ExpoSqliteNutrientStore` over expo-sqlite reads a bundled SQLite DB (`apps/demo/assets/nutrients.sqlite`), with **per-food shape classes** (mound/flat resolution) and the curated label→FDC map (`nutrition/label-map.json`). A 12-food **starter** bundle ships now (`nutrition/starter/build-starter.mjs`); the full ~15k-food FDC bundle (`npm run etl:bundle`) and the fitted **per-class** κ/φ/h̄ are the remaining steps.
5. ⬜ **Core ML / ExecuTorch export + inference wiring** — notebook 04 exports; wire the exported models into the module and benchmark on-device latency.
6. ⬜ **Confirm/edit UI** — adjust the segment outline, swap the label, tweak portions before logging (the contract already anticipates this).
7. ⬜ **Spotter integration** (in the gym-bro repo) — add the module + `@ppe/*` packages to Spotter's mobile app, a "Scan meal" entry in the coach/Nutrition tab, map `EstimateResult.items` → `create_pending_macro_log`, Pro-gate behind `entitlements.nutrition`, honor `hide_numbers`, and fall back to the existing cloud VLM path on unsupported devices.
8. ⬜ **P3/P4 — the regressor in the loop + benchmarks** — A/B the scale-conditioned regressor against pure geometry, ship the winner per confidence, fill the Nutrition5k + NutriBench-style results tables.

---

## 6. ⬜ Backlog / later

- ⬜ **Barcode path** — Open Food Facts GTIN lookup (deterministic; re-adopts the currently-inert `expo-camera` dep in Spotter).
- ⬜ **Repo hardening** — Android CI (`gradle assemble`) per push, iOS build check on a macOS runner, grow the test suite as adapters land.
- ⬜ **Distribution** — consume via git (owner of both repos) vs. publish `@ppe/*` + the module to npm. The payload contract is already versioned (`version: 1`) for safe evolution.
- ⬜ **Compliance sweep** (pre-store) — Apple `apple-ascl` license review for MobileCLIP/SAM builds, Play Data Safety (camera, on-device only — images never leave the phone), FDC/Nutrition5k/FAO attribution lines.
- ⬜ **Weekly meal-plan variation, health write-sync, saved-meals** — downstream Spotter features once the core engine ships.

---

## 7. Milestone tracker

| Milestone | What it proves | State |
|---|---|---|
| **P0** — ruler accuracy | The physics on real hardware (≤ 5 mm on 20 cm) | 🟡 ready to run on device |
| **P1** — geometry-only mass | The metric pipeline on real food (≤ 25% mass) | 🟡 pending P0 |
| **P2** — models in | On-device segmentation + classification wired | 🟡 wired + Node-validated (classify 6/6; SAM bbox reproduced); on-device drill next |
| **P3** — the regressor | Scale-conditioned mass regression, A/B vs geometry | 🟡 trained (mass 24.1%); tuning + A/B next |
| **P4** — benchmark + integrate | Nutrition5k/NutriBench numbers; live in Spotter | ⬜ |

---

## 8. Known constraints & decisions on record

- **Portion size is the hard ceiling, by physics.** Realistic per-item error: ~30% (shape priors only) → ~20% (measured height) → ~16% (LiDAR/depth), matching the Nutrition5k literature. Per-meal error shrinks ~1/√k across items. The propose→confirm-with-editable-portions UX is the correct answer; chasing sub-20% autonomous accuracy is a research program, not a feature.
- **No off-the-shelf on-device food SDK to adopt** — the one that existed (Passio, the tech behind MyFitnessPal Meal Scan) pivoted to cloud LLMs. The winning architecture everywhere is *identify with a model → get the numbers from a verified DB → confirm portions*. This project's differentiator is the *measured* scale.
- **The novel model is the scale-conditioned mass regressor** — verified that nothing public conditions mass regression on a measured AR scale reference. It's a small FiLM head on a MobileNet backbone (CNN, no RNN — a capture is one frame + scalars, not a sequence).
- **iOS: accuracy reworked, interaction not yet** — the §2.4 stabilization + the R1–R9 capture-quality pass now run on iOS, so its *numbers* match Android. The *interaction* upgrades (reticle, plate trackpad, free-surface, wink) still live only in the Android module; that redesign is item #2 in §5.
