# Physics-Powered Portion Estimation

**(photo, measured scale) → calories + macros + micros — on the phone.**

An end-to-end meal-photo nutrition estimator whose portion step is grounded in measured geometry. While framing the shot, the user holds a finger on the screen and drags: an AR ruler measures a real-world distance through the camera (across the plate, up the side of the food). That measurement pins the metric scale of the scene — the single variable that decides whether a photo shows 200 g of rice or 400 g of rice, and the variable a lone 2D image mathematically withholds.

Built by [Spotter Labs](https://spotter-labs.com) to power meal logging in the **Spotter** app; packaged as a standalone library any app can adopt.

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

### In action

<p>
  <img src="docs/images/capture-idle.png" width="24%" alt="AR capture screen: sparkle reticle searching, plate button, intro hint" />
  <img src="docs/images/capture-measuring.png" width="24%" alt="Holding the plate: ruler stretching across the food with a live cm readout" />
  <img src="docs/images/capture-stroke.png" width="24%" alt="Committed stroke with its length label; shutter enabled" />
  <img src="docs/images/estimate-card.png" width="24%" alt="Estimate card: area, volume, grams, kcal, and the quality block" />
</p>

1. `capture-idle.png` — the capture screen: sparkle reticle (dashed = searching), the 45 lb plate trigger, the hold-steady intro hint.
2. `capture-measuring.png` — plate held, thumb sliding: the yellow ruler stretches with a live cm readout.
3. `capture-stroke.png` — released: the committed stroke with its label, shutter brightened.
4. `estimate-card.png` — back in the app: measured area/volume, grams, kcal/macros, ruler residual and the ± error band.

**Capture technique** — it's physics, so technique matters:

- **Hold the phone steady.** The plate trackpad does the sweeping, so your hands can stay parked. Every anchor is shake-gated and median-filtered over multiple frames ([`docs/MATH.md`](docs/MATH.md) §2.4); steadier frames mean tighter medians.
- **Screen parallel to the table, shooting from above.** Grazing rays amplify depth error, and the top-down view minimizes the perspective correction the homography has to unwind.
- **Get close** — under a meter. Angular resolution converts to millimeters up close and to centimeters far away; the app warns live beyond 1.5 m.

Every result ships with a propagated error estimate and stays user-editable — the system proposes, the user confirms.

## The math

Full derivations with every symbol defined: [`docs/MATH.md`](docs/MATH.md). The spine of it:

**1. Metric world coordinates from the IMU** (§1). Cameras alone recover geometry up to an unknown scale; the accelerometer measures true m/s², and the visual-inertial optimizer pins the scale by reconciling integrated IMU displacement with visually-tracked displacement. Result: ARKit distances are in meters on every supported phone.

**2. The ruler** (§2). A touch at pixel $(u,v)$ becomes the ray $\mathbf{d} = R\,K^{-1}[u,v,1]^\top$ from the camera center; intersecting it with the table plane $\{\mathbf{n}\cdot\mathbf{X}=d_0\}$ gives the 3D anchor. Two anchors give $D = \lVert \mathbf{P}_2-\mathbf{P}_1\rVert$.

**3. One measurement → metric everything** (§3). With pose + plane known, the homography $H = K\,[R\mathbf{e}_1 \mid R\mathbf{e}_2 \mid R\mathbf{O}+\mathbf{t}]$ maps image pixels of the plane to meters, exactly, across the whole image — a scalar meters-per-pixel would drift up to ~50% in area at a 40° shooting angle. The ruler doubles as a live self-check: re-projecting its endpoints through $H^{-1}$ must reproduce $D$, and the residual ships in every result as `ruler_residual_mm`.

**4. Area → volume → mass** (§4–5). Three volume routes, best available wins: LiDAR height-field integration $V=\sum h\,\Delta A$; measured height with per-class fill factors $V=\varphi A h$ (dome ⅔, cone ⅓, mound ≈ 0.55); shape priors $V=\kappa A^{3/2}$ fitted from Nutrition5k. Then $m=\rho V$ with densities from FAO/INFOODS and FNDDS portion weights. One derived subtlety worth naming: anything mapped through the *table's* homography while sitting above the table (a bowl rim at height $h$, camera at height $Z$) appears inflated by $Z/(Z-h)$ — a 9 cm rim under a 45 cm camera reads 56% large in area. The pipeline corrects for it (§3.2).

**5. Energy with a tripwire** (§6). $\text{kcal} = \sum_i m_i\,E_{100,i}/100$, cross-checked against Atwater $4P+4C+9F$; a mismatch flags a bad database row before the user ever sees it.

**6. Honest error budget** (§8). Relative errors combine in quadrature, with scale entering area squared. Propagated per-item expectations: **~30%** with priors only, **~20%** with a measured height — bracketing the published RGB (26.1%) and depth (16.5%) results from the geometry side. Multi-item meals do better: independent per-item errors shrink ~$1/\sqrt{k}$ on the total.

## The software

TypeScript monorepo + a Swift native module + Python training. Everything metric lives in plain, unit-tested code; ML sits behind narrow adapters and can be swapped per platform.

| Path | What it is | Status |
|---|---|---|
| [`packages/geometry`](packages/geometry) | The math library: pinhole camera, ARKit→CV conversion, ray-plane, homography, areas, volumes, densities, Atwater, error budgets. Zero dependencies. | implemented, 20 tests |
| [`packages/pipeline`](packages/pipeline) | `estimateMeal(payload, deps)`: zod-validated capture contract in, zod-validated estimate out. Model adapters (`Segmenter`, `Classifier`, `NutrientStore`, `DepthProvider`) + mocks. | implemented, 4 tests |
| [`modules/expo-portion-capture`](modules/expo-portion-capture) | The Expo native module: full-screen ARKit capture with the tap-hold-drag ruler, stroke undo, coaching overlay, HEIC + depth export, row-major matrix serialization. | Swift implemented; needs device validation (P0) |
| [`apps/demo`](apps/demo) | Dev-build Expo app: capture → pipeline with a placeholder segmenter — the P1 kitchen-scale drill. | implemented |
| [`nutrition/`](nutrition) | ETL: USDA FoodData Central CSVs → SQLite bundle with per-100 g nutrients + portion-derived densities (FTS-indexed). Runs on Node's built-in SQLite, zero deps. | implemented, 3 tests |
| [`model/`](model) | Training: SegFormer/FoodSeg103 fine-tune, the scale-conditioned mass regressor, Nutrition5k manifest extraction, prior fitting, Core ML export. | scripts ready; GPU runs pending |

```bash
npm install          # root workspaces: geometry, pipeline, nutrition ETL
npm test             # 27 tests
npm run typecheck

# nutrient bundle (download FDC CSVs first — https://fdc.nal.usda.gov/download-datasets/)
npm run etl:bundle -- --fdc-dir ./fdc-csv --out nutrient-bundle.sqlite

# demo app (device required)
cd apps/demo && npm install && npx expo run:ios
```

Design decisions worth knowing:

- **Contracts are enforced at both edges.** The native module is treated as an untrusted producer; `capturePayloadSchema` validates every payload, and `estimateResultSchema` validates the pipeline's own output before it returns.
- **Geometry is code, ML is a plug.** Stage 3 is ~300 lines of linear algebra with microsecond cost, testable against synthetic scenes to float precision. Swapping SAM for SegFormer, or Core ML for ExecuTorch, touches adapters only.
- **Unknown food stays unknown.** A label without a database match returns `mass_g: null` plus a `no_db_match` flag — the geometry still reports size, and the UI asks the user. The system declines to invent nutrition facts.
- **Serialization pitfalls are encoded, and tested.** simd column-major → contract row-major, ARKit y-up camera → CV y-down, intrinsics rescaling with resolution — each has a dedicated test, because each silently corrupts every downstream number when wrong.

## The hardware

Details in [`docs/HARDWARE.md`](docs/HARDWARE.md). Summary:

- **IMU** — the metric anchor; present on every ARKit/ARCore phone. This is what lets tier-2 hardware do metric portions.
- **Camera + factory calibration** — per-frame intrinsics from `frame.camera.intrinsics`; the K in every equation.
- **LiDAR** (iPhone 12 Pro onward, Pro models) — 256×192 fused metric depth: measured volumes, height strokes on the food itself, instant planes.
- **Apple Neural Engine / GPU** — all model inference is single-shot per capture (under ~2 s total on A15+); published Core ML numbers for our exact picks: MobileCLIP-S0 1.5 ms, Depth-Anything-V2-small 31–34 ms.

| Tier | Hardware | Scale source | Expected per-item error |
|---|---|---|---|
| 1 | LiDAR iPhone/iPad | depth + ruler check | ~15–20% |
| 2 | any ARKit/ARCore phone | VIO ruler | ~20–30% |
| 3 | plain photo | reference object / stated plate size | ~30%+ |
| 4 | nothing | priors | labeled estimate |

## The models

Verified landscape with IDs, licenses, sizes, latencies: [`docs/MODELS.md`](docs/MODELS.md). The strategy in one line — buy segmentation and classification off the shelf, train the two things the shelf lacks:

- **Use as-is:** `apple/coreml-sam2.1-tiny` (promptable segmentation — the ruler tap doubles as the prompt), `apple/coreml-mobileclip` (zero-shot labeling over a food vocabulary), `apple/coreml-depth-anything-v2-small` (relative depth on LiDAR-free devices, rescaled to metric by the ruler stroke).
- **Fine-tune:** SegFormer-B0/B1 on FoodSeg103 — every public checkpoint for this dataset measures at mIoU ≤ 0.05, so shipping quality means training our own (`model/train/segformer_foodseg103.py`).
- **Train (the novel part):** the **scale-conditioned mass regressor** — a small CNN backbone whose features are FiLM-modulated by the measured physics (log area, height, scale source), regressing log-mass on Nutrition5k. Web-verified: nothing public conditions on a measured AR scale. Architecture rationale, including why recurrent networks have no role here, in `docs/MODELS.md` §4.

## Testing set & results

Three layers. Results are recorded here as each layer runs; unit results are current as of 2026-07-07 on this commit.

**1. Unit + property tests (implemented — all green).**

| Suite | Tests | What it proves |
|---|---|---|
| `packages/geometry` | 20 | Synthetic-scene ground truth: ray↔pixel round-trips at 1e-9 m, a known 10×10 cm square recovered from pixels to 0.01 m² at 1e-9, ruler self-check residual < 1e-9, the off-plane inflation exactly Z/(Z−h) and its correction exact, ARKit→CV pose conversion, intrinsics rescaling, volume/energy/error-budget algebra |
| `packages/pipeline` | 4 | End-to-end estimate on a synthetic ARKit capture (values within physical bounds, totals consistent, budget numbers match MATH.md), vertical-stroke height route, unknown-food refusal, malformed-payload rejection |
| `nutrition` | 3 | FDC ETL: data-type filtering, density derivation from cup portions (158 g/cup → 0.668 g/mL), FTS search |
| **Total** | **27 passed** | `npm test`, 233 ms; CI runs the same suite on every push |

**2. Physical validation (pending device build).**

| Drill | Protocol | Pass bar | Result |
|---|---|---|---|
| P0 — ruler accuracy | 10 known objects × 3 angles × 2 lighting, stroke vs tape measure | median ≤ 5 mm on 20 cm spans | *pending* |
| P1 — geometry-only mass | ~30 home meals, kitchen-scale truth, placeholder segmentation | median mass error ≤ 25% | *pending* |

**3. Model benchmarks (pending H100 runs).**

| Benchmark | Metric | Baselines to beat | Result |
|---|---|---|---|
| FoodSeg103 val | mIoU | public checkpoints ≤ 0.05; competent B0 ≈ 0.25, B1 ≈ 0.32 | *pending* |
| Nutrition5k test split | calorie MAPE | 26.1% (RGB) / 16.5% (RGB+depth) | *pending* |
| End-to-end vs NutriBench-style meals | macro accuracy | GPT-4o+CoT ≈ 66.8% Acc@7.5g carbs | *pending* |

## Training on cloud GPUs

Two jobs need the H100s; both are packaged as ready-to-run Colab notebooks in [`model/colab/`](model/colab/), with all **outputs** persisted to the project's shared Drive folder ([view-only](https://drive.google.com/drive/folders/1y1hDjkfHsazsOoe4LJjWKoEKj2bHKKjd)) so runtime disconnects lose nothing (the raw Nutrition5k dataset stages to the VM's local disk instead — Drive's FUSE mount aborts on the thousands of per-dish RGB-D reads):

1. **SegFormer fine-tune** — `model/train/segformer_foodseg103.py`, single H100, ~2–3 h (B0) / 4–6 h (B1). Dataset streams from Hugging Face.
2. **Nutrition5k pipeline** — one-time 181 GB `gsutil` download (plan ~200 GB disk), manifest extraction (`model/data/prepare_nutrition5k.py`, CPU-bound), prior fitting (seconds), then the mass regressor (`model/train/mass_regressor_nutrition5k.py`, ~1–2 h at batch 128).

Everything else — ETL, exports, priors, all 27 tests — runs on a laptop.

## Roadmap

Live status — what's done, in progress, and next — is tracked in **[`docs/STATUS.md`](docs/STATUS.md)**. The milestones:

- **P0 — ruler validation.** Build `apps/demo` on a device, run the tape-measure drill, record results above.
- **P1 — physics before ML.** Kitchen-scale drill with placeholder segmentation: proves the geometry pipeline on real food.
- **P2 — models in.** SAM 2.1 tiny + MobileCLIP zero-shot wired as adapters; SegFormer fine-tune replaces the placeholder.
- **P3 — the regressor.** Nutrition5k training with scale conditioning; A/B against pure geometry; ship the winner per confidence.
- **P4 — benchmark + integrate.** Fill the results tables; expose the `EstimateResult` to Spotter's propose→confirm flow.

## Use in Spotter

This library is the portion engine for [Spotter](https://spotter-labs.com)'s photo meal logging. `EstimateResult.items` maps 1:1 onto Spotter's `MealItem` (`description`/`proteinG`/`carbsG`/`fatG`/`micros`) and feeds the existing `create_pending_macro_log` propose→confirm flow — the coach proposes what the camera measured, the user adjusts portions with real numbers behind the slider, and the database write happens only on confirmation. Micro keys match Spotter's `micros.ts` set exactly.

## License

MIT © Spotter Labs — see [LICENSE](LICENSE). Data sources carry their own terms: USDA FoodData Central (CC0), Nutrition5k (CC BY 4.0), FAO/INFOODS (FAO publication), FoodSeg103 (Apache-2.0, image provenance noted in `docs/MODELS.md`).
