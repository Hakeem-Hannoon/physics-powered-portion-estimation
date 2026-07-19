# MacroScope Portion Scout

**A Spotter Labs project for physics-powered nutrition portion estimation.**

[![CI](https://github.com/Hakeem-Hannoon/MacroScope-Portion-Scout/actions/workflows/ci.yml/badge.svg)](https://github.com/Hakeem-Hannoon/MacroScope-Portion-Scout/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥ 22.5](https://img.shields.io/badge/node-%E2%89%A5%2022.5-339933.svg)](package.json)

MacroScope Portion Scout turns a meal photo plus a measured scale gesture into calories, macros, and micros on the phone. While framing the shot, the user holds a finger on the screen and drags: an AR ruler measures a real-world distance through the camera (across the plate, up the side of the food). That measurement pins the metric scale of the scene — the single variable that decides whether a photo shows 200 g of rice or 400 g of rice, and the variable a lone 2D image mathematically withholds.

Built by [Spotter Labs](https://spotter-labs.com) for the **Spotter** app's meal logging pipeline, then packaged as a standalone library any app can adopt. Developed under the codename `physics-powered-portion-estimation` (old links redirect).

## Why this name

`MacroScope` combines nutrition macros with camera-based measurement. `Portion Scout` mirrors the energy of `RAGuccino Nutrition Scout`: a small specialist that finds the missing piece before the model writes food data down. This one scouts mass, volume, and scale, so the calorie math survives real plates, weird bowls, and the snack you definitely meant to measure before eating half of it.

## The problem this solves

Meal-photo calorie apps share one dominant failure mode, and food recognition is innocent:

- **Identification is nearly solved.** Vision-language models name foods at ~93% precision ([Nutrients 2025](https://www.mdpi.com/2072-6643/17/4/607)); closed-set classifiers reach 85–95% top-1.
- **Portion size is the open problem.** A single RGB photo is scale-ambiguous. Google's [Nutrition5k](https://arxiv.org/abs/2103.03375) quantified it: 26.1% calorie error from RGB alone, dropping to **16.5% once metric depth enters**. Human experts eyeball portions at ~41% error.

The gap between those numbers *is* the scale information. LiDAR iPhones capture it in hardware; every other phone leaves it on the table. This project recovers it everywhere ARKit/ARCore runs, with a 2-second gesture and zero learned components: ARKit's world coordinates are metric because the IMU's accelerometer measures in m/s² — the scale comes from physics.

## How it works

```
CAPTURE (native AR, geometry only)                  INFERENCE (on-device)
┌──────────────────────────────┐    payload    ┌──────────────────────────────────┐
│ camera preview               │   ────────▶   │ 1. SEGMENT   food regions        │
│ + tap-hold-drag ruler        │               │ 2. CLASSIFY  each region         │
│   → P₁, P₂ world points (m)  │    photo      │ 3. PORTION   pixels → cm² → mL   │
│ + camera intrinsics K        │    + K        │    → grams   (the physics step)  │
│ + camera pose, table plane   │    + pose     │ 4. NUTRIENTS grams × per-100 g   │
│ + LiDAR depth (when present) │    + plane    │    (USDA FDC + density tables)   │
└──────────────────────────────┘    + ruler    └──────────────────────────────────┘
                                                  │
                                                  ▼
                                   { items: [{ label, mass_g, kcal,
                                      protein_g, carbs_g, fat_g, micros }…],
                                     totals, quality: { est_relative_error, … } }
```

The capture gesture: aim the sparkle reticle at the food, hold the plate button to anchor a 3D point (a raycast against tracked geometry), slide your thumb on the plate to sweep the reticle — the phone stays steady — and release to commit the stroke with a live cm readout. Horizontal strokes calibrate scale; a vertical stroke up the food measures its height. The shutter then freezes the frame together with everything the math needs: intrinsics, camera pose, plane equation, strokes, and the depth map when the hardware has one.

<!-- Screenshot gallery goes here once the PNGs are committed to docs/images/:
     capture-idle.png · capture-measuring.png · capture-stroke.png · estimate-card.png -->

**Capture technique** — it's physics, so technique matters:

- **Hold the phone steady.** The plate trackpad does the sweeping, so your hands can stay parked. Every anchor is shake-gated and median-filtered over multiple frames ([`docs/MATH.md`](docs/MATH.md) §2.4); steadier frames mean tighter medians.
- **Screen parallel to the table, shooting from above.** Grazing rays amplify depth error, and the top-down view minimizes the perspective correction the homography has to unwind.
- **Get close** — under a meter. Angular resolution converts to millimeters up close and to centimeters far away; the app warns live beyond 1.5 m.

Downstream, every number is a labeled, editable estimate with a propagated error band — the system proposes, the user confirms, and only then is anything logged. The one idea to internalize: **the portion step comes from measured geometry** — the AR-ruler scale is the input no RGB-only calorie app has, and it's what moves calorie error from ~26% (RGB) toward ~16% (metric depth).

What to expect by hardware tier (sensor details in [`docs/HARDWARE.md`](docs/HARDWARE.md); all model inference is single-shot per capture, under ~2 s on recent phones):

| Tier | Hardware | Scale source | Expected per-item error |
|---|---|---|---|
| 1 | LiDAR iPhone/iPad | depth + ruler check | ~15–20% |
| 2 | any ARKit/ARCore phone | VIO ruler | ~20–30% |
| 3 | plain photo | reference object / stated plate size | ~30%+ |
| 4 | nothing | priors | labeled estimate |

## Quickstart

Prerequisites: **Node ≥ 22.5** (the nutrition ETL uses Node's built-in SQLite). The demo app additionally needs Xcode or Android Studio and a **physical device** — ARKit/ARCore report "unsupported" in simulators and Expo Go.

```bash
npm install          # root workspaces: geometry, pipeline, nutrition ETL
npm test
npm run typecheck
```

Rebuild the nutrient bundle (the demo ships with the full generic-food FDC database, curated 58-food set overlaid on top):

```bash
# download the per-type FDC CSV zips (Foundation, SR Legacy, FNDDS) and unzip:
# https://fdc.nal.usda.gov/download-datasets/
cd apps/demo && npm run build:nutrients:full -- ~/Downloads/fdc
# or the 58-food curated set alone: npm run build:nutrients
```

Run the demo on a device:

```bash
cd apps/demo
npm install                # the demo lives outside the root workspaces on purpose
npm run build:models       # fetch the on-device ONNX weights (~80 MB, gitignored)
npx expo install --fix     # align expo/react-native versions with the SDK
npx expo run:ios           # or run:android
```

What's real in the demo, model wiring, and fallback behavior: [`apps/demo/README.md`](apps/demo/README.md).

## Repository layout

TypeScript monorepo + a Swift native module + Python training. Five blocks, each swappable behind a narrow interface: everything metric lives in plain, unit-tested code, and ML sits behind adapters that can be swapped per platform.

| Path | What it is |
|---|---|
| [`modules/expo-portion-capture`](modules/expo-portion-capture) | **Capture** — native ARKit screen (Swift): the tap-hold-drag ruler, stroke undo, coaching overlay, HEIC + depth export. Emits a versioned `CapturePayload` — image + camera intrinsics + pose + table plane + ruler strokes + depth (when present). |
| [`packages/geometry`](packages/geometry) | **Geometry** — the metric math as pure, zero-dependency code: pinhole camera, ARKit→CV conversion, ray–plane intersection, plane homography, areas, volumes, densities, Atwater energy, error budgets. Unit-tested against synthetic scenes to float precision. |
| [`packages/pipeline`](packages/pipeline) | **Pipeline** — `estimateMeal(payload, deps)`: segment → classify → portion (geometry) → nutrients, behind zod-validated contracts and four adapter interfaces (`Segmenter`, `Classifier`, `NutrientStore`, `DepthProvider`), with mocks for all four. |
| [`model/`](model), [`nutrition/`](nutrition) | **Models + data** — training and export for the learned pieces (segmentation fine-tune, the scale-conditioned mass regressor, shape priors), and the ETL that turns USDA FoodData Central CSVs into the FTS-indexed SQLite nutrient bundle. |
| [`apps/demo`](apps/demo) | **Demo** — dev-build Expo app running the whole stack on a real device: SlimSAM segmentation + MobileCLIP-S0 zero-shot classification via ONNX Runtime, metric geometry, USDA nutrients. |

Design decisions worth knowing:

- **Contracts are enforced at both edges.** The native module is treated as an untrusted producer; `capturePayloadSchema` validates every payload, and `estimateResultSchema` validates the pipeline's own output before it returns.
- **Geometry is code, ML is a plug.** The portion step is plain linear algebra, testable against synthetic scenes to float precision. Swapping segmentation models or inference runtimes touches adapters only.
- **Unknown food stays unknown.** A label without a database match returns `mass_g: null` plus a `no_db_match` flag — the geometry still reports size, and the UI asks the user. The system declines to invent nutrition facts.
- **Serialization pitfalls are encoded, and tested.** simd column-major → contract row-major, ARKit y-up camera → CV y-down, intrinsics rescaling with resolution — each has a dedicated test, because each silently corrupts every downstream number when wrong.

## The math

Full derivations with every symbol defined: [`docs/MATH.md`](docs/MATH.md) — or learn the whole project from the ground up (the math, the code, the models, and the CS behind them) in the [`docs/vault/` Obsidian vault](docs/vault/Home.md), starting at [Home](docs/vault/Home.md) and [Beginner Guide](docs/vault/Beginner%20Guide.md). The spine of it:

**1. Metric world coordinates from the IMU** (§1). Cameras alone recover geometry up to an unknown scale; the accelerometer measures true m/s², and the visual-inertial optimizer pins the scale by reconciling integrated IMU displacement with visually-tracked displacement. Result: ARKit distances are in meters on every supported phone.

**2. The ruler** (§2). A touch at pixel $(u,v)$ becomes the ray $\mathbf{d} = R\,K^{-1}[u,v,1]^\top$ from the camera center; intersecting it with the table plane $\{\mathbf{n}\cdot\mathbf{X}=d_0\}$ gives the 3D anchor. Two anchors give $D = \lVert \mathbf{P}_2-\mathbf{P}_1\rVert$.

**3. One measurement → metric everything** (§3). With pose + plane known, the homography $H = K\,[R\mathbf{e}_1 \mid R\mathbf{e}_2 \mid R\mathbf{O}+\mathbf{t}]$ maps image pixels of the plane to meters, exactly, across the whole image — a scalar meters-per-pixel would drift up to ~50% in area at a 40° shooting angle. The ruler doubles as a live self-check: re-projecting its endpoints through $H^{-1}$ must reproduce $D$, and the residual ships in every result as `ruler_residual_mm`.

**4. Area → volume → mass** (§4–5). Three volume routes, best available wins: LiDAR height-field integration $V=\sum h\,\Delta A$; measured height with per-class fill factors $V=\varphi A h$ (dome ⅔, cone ⅓, mound ≈ 0.55); shape priors $V=\kappa A^{3/2}$ fitted from Nutrition5k. Then $m=\rho V$ with densities from FAO/INFOODS and FNDDS portion weights. One derived subtlety worth naming: anything mapped through the *table's* homography while sitting above the table (a bowl rim at height $h$, camera at height $Z$) appears inflated by $Z/(Z-h)$ — a 9 cm rim under a 45 cm camera reads 56% large in area. The pipeline corrects for it (§3.2).

**5. Energy with a tripwire** (§6). $\text{kcal} = \sum_i m_i\,E_{100,i}/100$, cross-checked against Atwater $4P+4C+9F$; a mismatch flags a bad database row before the user ever sees it.

**6. Honest error budget** (§8). Relative errors combine in quadrature, with scale entering area squared. Propagated per-item expectations: **~30%** with priors only, **~20%** with a measured height — bracketing the published RGB (26.1%) and depth (16.5%) results from the geometry side. Multi-item meals do better: independent per-item errors shrink ~$1/\sqrt{k}$ on the total.

## The models

The strategy in one line: buy segmentation and classification off the shelf, train the two things the shelf lacks. The verified model landscape — exact IDs, licenses, sizes, latencies — lives in [`docs/MODELS.md`](docs/MODELS.md); what's wired on-device today is documented in [`docs/REAL_ADAPTERS.md`](docs/REAL_ADAPTERS.md).

- **Running in the demo now** (via `onnxruntime-react-native`, iOS + Android): **SlimSAM** for promptable segmentation — the ruler tap doubles as the point prompt — and **MobileCLIP-S0** for zero-shot labeling over a curated food vocabulary.
- **Fine-tune:** SegFormer-B0/B1 on FoodSeg103 — every public checkpoint for this dataset measures at mIoU ≤ 0.05, so shipping quality means training our own (`model/train/segformer_foodseg103.py`).
- **Train (the novel part):** the **scale-conditioned mass regressor** — a small CNN backbone whose features are FiLM-modulated by the measured physics (log area, height, scale source), regressing log-mass on Nutrition5k. Nothing public conditions on a measured AR scale; the architecture rationale is in `docs/MODELS.md` §4.
- **Depth on LiDAR-free devices:** Depth-Anything-V2-small, rescaled to metric by the ruler stroke.

Both GPU jobs — the SegFormer fine-tune and the Nutrition5k regressor — are packaged as ready-to-run Colab notebooks in [`model/colab/`](model/colab), documented in [`model/README.md`](model/README.md). Everything else (ETL, exports, prior fitting, the full test suite) runs on a laptop.

## Validation & benchmarks

Three layers, from float precision to real kitchens. Live status for all of it: [`docs/STATUS.md`](docs/STATUS.md).

**1. Unit + property tests** — `npm test`; CI runs the suite and typecheck on every push.

| Suite | What it proves |
|---|---|
| `packages/geometry` | Synthetic-scene ground truth: ray↔pixel round-trips at 1e-9 m, a known 10×10 cm square recovered from pixels to 0.01 m², ruler self-check residual < 1e-9, the off-plane inflation exactly Z/(Z−h) and its correction, ARKit→CV pose conversion, intrinsics rescaling, volume/energy/error-budget algebra |
| `packages/pipeline` | End-to-end estimates on a synthetic ARKit capture (values within physical bounds, totals consistent, budget numbers match MATH.md), the vertical-stroke height route, unknown-food refusal, malformed-payload rejection, model-input preprocessing, zero-shot cosine matching, and the propose→confirm edit helpers |
| `nutrition` | FDC ETL — data-type filtering, density derivation from cup portions (158 g/cup → 0.668 g/mL), FTS search, shape-prior seeding — and the SQLite store: exact/FTS/alias label resolution, water-density fallback, null-on-miss, end-to-end mass→nutrition |

**2. Model benchmarks** — first training runs; the improvement plan lives in the [Mass Regressor vault note](docs/vault/Mass%20Regressor%20Model.md).

| Benchmark | Metric | Reference points | Result |
|---|---|---|---|
| FoodSeg103 val | mIoU | public checkpoints ≤ 0.05; competent B0 ≈ 0.25 | **0.246** (nvidia/mit-b0) |
| Nutrition5k test | mass MAPE | MATH.md §8 physics budget ~20–30% | **24.1%** |
| Nutrition5k test | calorie MAPE (auxiliary kcal head) | 26.1% RGB / 16.5% RGB+depth | ~32%, untuned — see below |

The mass number is the one that drives shipped calories: production computes **mass → classify → USDA kcal/g**, not calories directly. The direct-kcal head is a harder problem (caloric density varies ~60× across foods) and hasn't been tuned yet.

**3. Physical validation** — the P0 tape-measure drill (ruler vs. known objects; pass bar: median ≤ 5 mm on 20 cm spans) and the P1 kitchen-scale drill (~30 real meals; pass bar: median mass error ≤ 25%) are specified in [`docs/STATUS.md`](docs/STATUS.md) and run on-device next.

## Roadmap

Live status — what's done, in progress, and next — is tracked in [`docs/STATUS.md`](docs/STATUS.md). The milestones:

- **P0 — ruler validation.** Build `apps/demo` on a device and run the tape-measure drill.
- **P1 — physics before ML.** Kitchen-scale drill: proves the geometry pipeline on real food.
- **P2 — models in.** On-device segmentation + zero-shot classification as adapters; the SegFormer fine-tune replaces zero-shot where it wins.
- **P3 — the regressor.** Nutrition5k training with scale conditioning; A/B against pure geometry; ship the winner per confidence.
- **P4 — benchmark + integrate.** Fill the results tables; expose the `EstimateResult` to Spotter's propose→confirm flow.

## Use in Spotter

This library is the portion engine for [Spotter](https://spotter-labs.com)'s photo meal logging. Estimate items map one-to-one onto Spotter's meal-item shape and feed its existing propose→confirm flow: the coach proposes what the camera measured, the user adjusts portions with real numbers behind the slider, and nothing is logged until they confirm.

## Documentation

| Doc | What's inside |
|---|---|
| [`docs/MATH.md`](docs/MATH.md) | Every derivation, every symbol defined — IMU scale, ray casting, the homography, volume routes, error propagation |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The shape of the system: contracts, adapters, data flow |
| [`docs/MODELS.md`](docs/MODELS.md) | The verified model landscape: IDs, licenses, sizes, latencies, decisions |
| [`docs/REAL_ADAPTERS.md`](docs/REAL_ADAPTERS.md) | What's actually wired on-device and how the models were converted |
| [`docs/HARDWARE.md`](docs/HARDWARE.md) | The sensors: IMU, camera calibration, LiDAR, neural engines |
| [`docs/CAPTURE_QUALITY.md`](docs/CAPTURE_QUALITY.md) | Image-capture audit and the R1–R9 quality gates |
| [`docs/STATUS.md`](docs/STATUS.md) | Single source of truth for status + roadmap |
| [`docs/vault/`](docs/vault/Home.md) | Obsidian teaching vault — the whole project from the ground up, starting at [Home](docs/vault/Home.md) |

## Contributing

Issues and PRs are welcome. The bar is the one CI enforces on every push: `npm test` and `npm run typecheck` both green. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`, …). New to the codebase? Start with the [vault](docs/vault/Home.md).

## License

MIT © Spotter Labs — see [LICENSE](LICENSE). Data sources carry their own terms: USDA FoodData Central (CC0), Nutrition5k (CC BY 4.0), FAO/INFOODS (FAO publication), FoodSeg103 (Apache-2.0, image provenance noted in `docs/MODELS.md`).
