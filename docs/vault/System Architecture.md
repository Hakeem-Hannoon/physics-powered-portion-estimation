---
tags: [ppe, architecture, codebase]
---

# System Architecture

> How a meal photo becomes a nutrition estimate — the two halves of the system, the data contract between them, and where every piece lives in the repo. Canonical spec: [[ARCHITECTURE]].

## Two halves

The system splits cleanly into a part that needs a camera and motion sensors (native, runs during capture) and a part that's pure computation (runs once per photo, on‑device):

```
 ┌─────────────────────────── NATIVE CAPTURE (geometry, no ML) ───────────────────────────┐
 │  <PortionCapture /> full-screen AR screen                                               │
 │    • ARKit/ARCore session: plane detection, VIO pose, LiDAR depth if present            │
 │    • tap-hold-slide ruler (N strokes) → real-world lengths in meters                    │
 │    • shutter → CapturePayload  ────────────────────────────────┐                        │
 └────────────────────────────────────────────────────────────────┼───────────────────────┘
                                                                   ▼
 ┌─────────────────────────── ON-DEVICE PIPELINE (estimateMeal) ──────────────────────────┐
 │  CapturePayload                                                                          │
 │    → preprocess (YCbCr→RGB, orientation, intrinsics rescale check)                       │
 │    → SEGMENT   image → [{ mask/polygon }]          (model adapter)                        │
 │    → CLASSIFY  crop  → { label, confidence }       (model adapter)                        │
 │    → GEOMETRY  mask + payload → { area, height?, volume, method }   (plain code, MATH.md) │
 │    → RESOLVE   label → density ρ + per-100g nutrients  (SQLite bundle adapter)            │
 │    → COMPOSE   m = ρV → kcal/macros/micros + Atwater check + error band                   │
 │  → EstimateResult (JSON)                                                                  │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
```

The design rule that makes this robust: **geometry is deliberately not a model.** It's ~300 lines of linear algebra that run in microseconds and are unit‑testable against synthetic scenes with known ground truth (to ~1e‑9 — see [[Testing]]). Models are confined to *segment* and *classify* (and the optional [[Mass Regressor Model]]); everything metric is code.

## The contract between the halves: `CapturePayload`

Capture and pipeline are decoupled by one **versioned JSON document** (plus binary sidecars for the image and depth). This is the single most important interface in the system — it's the boundary where "untrusted native producer" hands off to "validated pure logic." It is defined once as a zod schema in `packages/pipeline/src/contracts.ts` (`capturePayloadSchema`) and mirrored as TypeScript types in the native module's `src/index.ts`.

Key fields (full walkthrough in [[The Pipeline]]):

| Field | Meaning |
|---|---|
| `version: 1` | contract version — evolve safely |
| `image`, `image_size` | full‑res sensor image URI + its resolution |
| `intrinsics` | 3×3 camera matrix **K**, valid for `image_size` (rescale on resize) |
| `camera_to_world` | 4×4 pose, ARKit convention (y‑up, z‑back) |
| `plane` | the supporting surface: `n·X = d0` in the world frame |
| `strokes[]` | ruler strokes `{p1, p2, length_m, kind}`, `kind` = horizontal (scale) or vertical (height) |
| `depth` | LiDAR/scene depth map + confidence, or `null` |
| `scale_source` | `lidar` \| `ruler` \| `reference_object` \| `stated` \| `none` — the fallback ladder ([[MATH]] §7) |

The pipeline **validates this on the way in** and **validates its own `EstimateResult` on the way out** — both edges enforced by zod. A malformed payload is rejected at the boundary, never half‑processed. See [[Testing]] (pipeline test #4).

## The result: `EstimateResult`

Per‑item `{ label, confidence, geometry{area, height, volume, method}, mass_g, kcal, macros, micros, flags }`, plus meal `totals` and a `quality` block with `scale_source`, the `ruler_residual_mm` self‑check, and the propagated `est_relative_error`. Two contract rules matter:
- **Never invent nutrition.** If the classifier's label has no database match, `mass_g`/`kcal`/… are `null` and a `no_db_match` flag is set — but geometry still reports the volume, so the UI can ask the user *with the size already known*.
- **Never false precision.** `est_relative_error` is surfaced so portions render as ranges; everything stays editable before logging.

The item shape deliberately maps 1:1 onto Spotter's `MealItem`, so results flow straight into an existing meal‑logging flow ([[Roadmap and Next Steps]]).

## Repo map

| Directory | Package | Contents | Vault note |
|---|---|---|---|
| `packages/geometry` | `@ppe/geometry` | the math library (TypeScript, **zero deps**) — [[MATH]] as tested code | [[Geometry Library]] |
| `packages/pipeline` | `@ppe/pipeline` | zod contracts, model adapter interfaces, `estimateMeal` orchestration, mocks | [[The Pipeline]] |
| `modules/expo-portion-capture` | — | the native capture module (Kotlin/ARCore reworked; Swift/ARKit older) | [[The Capture App]] |
| `apps/demo` | — | Expo dev‑build app exercising capture → pipeline on‑device | [[The Capture App]] |
| `model/` | — | training (SegFormer, mass regressor), prior fitting, Core ML export, Colab notebooks | [[Training Pipeline]] |
| `nutrition/` | `@ppe/nutrition-etl` | USDA FDC CSVs → on‑device SQLite bundle (per‑100g + densities) | [[Nutrition Database]] |
| `docs/` | — | the spec docs + this vault | [[Home]] |

It's an npm‑workspaces monorepo (ESM throughout, Node ≥ 22.5). `@ppe/pipeline` depends on `@ppe/geometry` **by source** (no build step — `main`/`types` point at raw `src/index.ts`). Details and CI in [[Testing]].

## How the models plug in: adapters

The pipeline never imports a model directly. It defines four **interfaces** (`packages/pipeline/src/adapters.ts`) and the app injects concrete implementations:

- `Segmenter.segment(image, size) → Region[]`
- `Classifier.classify(image, region) → { label, confidence, topK? }`
- `NutrientStore.lookup(label) → FoodRecord | null`
- `DepthProvider.heightField(payload, region) → { heights, cellAreaM2, maxHeightM? }` *(optional — LiDAR route)*

In tests and the demo these are mocks (a centered‑square segmenter, a fixed "white rice" classifier, an in‑memory nutrient map). Swapping in the real models (SAM/SegFormer, MobileCLIP, the SQLite bundle) is [[Roadmap and Next Steps]] item P2 — and because of the adapter seam, it doesn't touch the geometry or orchestration at all.

## Device tiers (what "scale_source" you get)

| Tier | Hardware | Scale source | Per‑item error |
|---|---|---|---|
| 1 | iPhone/iPad Pro (LiDAR) | depth + ruler verification | ~15–20% |
| 2 | any ARKit/ARCore phone | VIO ruler | ~20–30% |
| 3 | camera only (shared photo) | reference object / stated size | ~30%+ |
| 4 | no scale info | priors only | labeled estimate |

Details: [[HARDWARE]].

## Related
- [[ARCHITECTURE]] · [[The Pipeline]] · [[Geometry Library]] · [[The Capture App]] · [[Math 3 - The Plane Homography]] · [[Home]]
