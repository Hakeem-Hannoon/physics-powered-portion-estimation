---
tags: [ppe, codebase, pipeline]
---

# The Pipeline

> `@ppe/pipeline` — the `estimateMeal()` orchestration that turns a `CapturePayload` into an `EstimateResult`. It wires the [[Geometry Library]] math to pluggable model adapters, enforces contracts on both edges, and never invents a number. Source: `packages/pipeline/src/`.

## The four files

| File | What it holds |
|---|---|
| `contracts.ts` | the zod schemas: `capturePayloadSchema` (input) and `estimateResultSchema` (output), plus their inferred TS types |
| `adapters.ts` | the interfaces the app must implement: `Segmenter`, `Classifier`, `NutrientStore`, `DepthProvider` |
| `estimate.ts` | `estimateMeal()` — the whole orchestration |
| `mocks.ts` | `FixedSegmenter`, `FixedClassifier`, `InMemoryNutrientStore` for tests/demo |

Depends on `@ppe/geometry` (by source) and `zod`. See [[System Architecture]] for how it sits between capture and the models.

## The contracts (`contracts.ts`)

Two zod schemas define the system's edges. **`capturePayloadSchema`** validates the native module's output (see [[System Architecture]] for the field table); notably `version: z.literal(1)`, `strokes` capped at 8, `depth` nullable, `scale_source` a 5‑way enum. **`estimateResultSchema`** validates what the pipeline returns.

Why validate at runtime? The native side is an **untrusted producer** — a schema mismatch should fail *loudly at the boundary*, not corrupt a downstream calculation. zod's `.parse()` throws a `ZodError` on any violation. The TS types are *inferred from* the schemas (`z.infer`), so the types and the runtime checks can never drift apart.

## The adapters (`adapters.ts`) — how models plug in

The pipeline depends on **interfaces**, never concrete models (the adapter pattern, [[CS Foundations]] §8):

```ts
interface Segmenter    { segment(imageUri, imageSize): Promise<Region[]> }
interface Classifier   { classify(imageUri, region): Promise<ClassifierResult> }
interface NutrientStore { lookup(label): Promise<FoodRecord | null> }
interface DepthProvider { heightField(payload, region): Promise<{heights, cellAreaM2, maxHeightM?}> } // optional
```

A `Region` is a pixel‑space polygon. A `FoodRecord` bundles `{ label, per100, densityGPerMl, shape }`, where `shape` is `{ kind: "mound"|"flat"|"container", kappa?, hBarM?, phi? }` — the per‑class geometry constants ([[Shape Priors and Nutrition5k]]). Swapping mocks for real models (SAM/SegFormer, MobileCLIP, the SQLite bundle) never touches `estimate.ts`.

## `estimateMeal()` — the orchestration, step by step

```ts
export async function estimateMeal(payloadInput: unknown, deps: EstimateDeps): Promise<EstimateResult>
```

**1. Validate & set up the geometry.** `capturePayloadSchema.parse(payloadInput)` (throws on bad input). Then build the camera math from the payload: `intrinsicsFromMatrix`, `poseFromArkitCameraToWorld` → `worldToCamera`, normalize the `plane`, `planeBasis`, and invert the homography once: `imageToPlane = mat3Inverse(planeToImageHomography(...))`. Compute the camera height above the plane (used for the off‑plane correction), treating anything ≤ 5 cm as unknown.

**2. Ruler self‑check.** For each **horizontal** stroke, `rulerResidualM(...)` measures how well the calibration round‑trips; the max becomes `ruler_residual_mm`. Any **vertical** stroke's length becomes the `measuredHeightM`.

**3. Segment.** `deps.segmenter.segment(image, image_size)` → regions.

**4. Per region — classify, resolve, portion.** For each region:
- `classify` → `{label, confidence}`; `nutrients.lookup(label)` → record or `null`.
- Build flags: `no_db_match` (null record), `low_confidence` (< 0.5), `no_scale` (scale_source `none`).
- Pick the shape (record's, or a default `mound` with `DEFAULT_KAPPA`).
- `metricPolygonAreaM2(imageToPlane, region.polygonPx)` → area.
- **Route the volume** (this is the runtime version of [[Math 4 - Volume Mass and Nutrients]]):

```
if depth provider AND payload.depth:        → integrateHeightFieldM3   (route a) method "lidar_integration"
else:
   height = measured vertical stroke, or flat-class thickness prior, else null
   off-plane correction: area *= elevationLengthFactor(Z, h/2)²         (MATH.md §3.2)
   if height known:  → volumeAreaHeightM3(area, height, φ)              (route b) method "area_height"
   else:             → volumeShapePriorM3(area, κ)                      (route c) method "shape_prior"
   if shape is a container: method "container_prior" + flag
```

- **Compose nutrition** (`buildMatchedItem`): `massG(volumeMl, density)` → `nutrientsForMassG(per100, mass)`; run the Atwater check and flag `atwater_mismatch` if off by >15%; round everything. **If there's no record, emit an item with `mass_g/kcal/... = null`** — the never‑invent rule (geometry still reports volume so the UI can ask).

**5. Totals & quality, then validate the output.** Sum items into `totals`; assemble `quality { scale_source, ruler_residual_mm, est_relative_error, camera_height_m }` where `est_relative_error = combinedRelativeError(errorPreset(scale_source, heightWasMeasured))`. Finally `estimateResultSchema.parse(result)` — **the output contract is enforced exactly like the input contract.**

## The constants to know

```ts
DEFAULT_KAPPA = 0.55      // placeholder V=κA^1.5 mound constant until the Nutrition5k fit lands
DEFAULT_MOUND_PHI = 0.58  // fill factor for area×height on a typical mound
LOW_CONFIDENCE = 0.5      // below this → low_confidence flag
ATWATER_TOLERANCE = 0.15  // >15% deviation → atwater_mismatch flag
```

`DEFAULT_KAPPA = 0.55` is the single most important placeholder in the codebase — it's replaced by the fitted value from [[Shape Priors and Nutrition5k]] as the top of [[Roadmap and Next Steps]].

## Editing an estimate (propose → confirm)

The system *proposes*; the user *confirms* — and usually tweaks a portion or a label first ([[ARCHITECTURE]] §2). `edit.ts` provides pure helpers for that, so an edited item is as testable as the original estimate:

- **`rescaleItemToMass(item, grams)`** — the portion slider. Nutrition is linear in mass ([[Math 4 - Volume Mass and Nutrients]] §6), so this is an exact proportional rescale of kcal/macros/micros; the *measured* geometry is kept (the user is correcting the mass, not the measurement). An unmatched item just gets its mass set (nutrition stays null). Adds `portion_edited`.
- **`relabelItem(item, record | null, label?)`** — swap the food. Re-derives mass and nutrition from a new `FoodRecord` (from a [[Nutrition Database]] `lookup`) applied to the item's measured volume — renaming changes density and nutrition, not the volume on the plate. `record: null` → null nutrition + `no_db_match` (never invented). Confidence becomes 1 (user-chosen); clears stale `no_db_match`/`low_confidence`/`atwater_mismatch`; re-runs the Atwater check.
- **`recomputeTotals(items)`** — re-sum meal totals (same rounding as `estimateMeal`).
- **`withEditedItem(result, i, newItem)`** — replace an item, recompute totals, and **re-validate the whole result against the output contract** — so an edit can never yield an invalid `EstimateResult`. Compose: `withEditedItem(r, i, rescaleItemToMass(r.items[i], grams))`.

These reuse `@ppe/geometry`'s `massG`/`nutrientsForMassG`/`atwaterDeviation`, so an edit follows the exact same math as the original estimate. Tested in [[Testing]] (11 cases).

## The two contract rules (why they matter)
- **Never invent nutrition.** No DB match → null nutrients + `no_db_match`, but volume still reported. Tested directly ([[Testing]], "refuses to invent nutrition"). The edit helpers preserve this — `relabelItem(item, null)` yields null nutrition, never a guess.
- **Never false precision.** `est_relative_error` rides in `quality` so the UI shows ranges, not fake decimals.

## Related
- [[System Architecture]] · [[Geometry Library]] · [[Math 4 - Volume Mass and Nutrients]] · [[Nutrition Database]] · [[Shape Priors and Nutrition5k]] · [[Testing]] · [[ARCHITECTURE]]
