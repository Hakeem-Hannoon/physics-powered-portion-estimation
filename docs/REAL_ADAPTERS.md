# Real model adapters — integration guide

All three model adapters behind the pipeline are now **real and on-device** — the
demo classifies the food and weighs it end-to-end with no picker. This is the
guide to how they're wired. The adapter interfaces are in
`packages/pipeline/src/adapters.ts`.

| Adapter | Interface | Status | Where |
|---|---|---|---|
| **NutrientStore** | `lookup(label) → FoodRecord \| null` | ✅ **real & shipped** | `apps/demo/src/nutrient-store.ts` (expo-sqlite) |
| **Classifier** | `classify(uri, region) → {label, confidence, topK}` | ✅ **real & shipped** | MobileCLIP-S0 zero-shot: `ZeroShotClassifier` (`@ppe/pipeline`) + `clip-embedder.ts` |
| **Segmenter** | `segment(uri, size) → Region[]` | ✅ **real & shipped** | SlimSAM "segment everything" (all ingredients): `sam-segmenter.ts` |

**Runtime:** `onnxruntime-react-native` — one ONNX artifact per model, running on
both iOS and Android. This was chosen over the ExecuTorch custom-model path
(MODELS.md's "highest-risk unknown"): a single cross-platform ONNX per model
de-risks the on-device story. The weights are a native dependency, so enabling
them is a dev rebuild (`npx expo run:android` / `run:ios`) after fetching them
(`npm run build:models`). The platform-agnostic preprocessing + coordinate math is
pure, unit-tested code in `@ppe/pipeline` (`preprocess.ts`); the demo owns only
the RN I/O (JPEG decode via jpeg-js, native crop/resize via expo-image-manipulator,
the onnxruntime session in `onnx.ts`).

**Validation before shipping:** the exact preprocessing + models were verified in
Node against transformers.js — MobileCLIP zero-shot scored **6/6 top-1** on real
food photos through this pipeline, and a hand-coded run of the SAM math reproduced
transformers.js's mask bounding box to within a few pixels. The remaining
on-device unknowns (runtime glue, mask quality on real captures) are exactly what
the P2 device drill certifies.

**Files:** `vision-adapters.ts` (composition root: `loadVisionDeps()`),
`clip-embedder.ts` (`ImageEmbedder`), `sam-segmenter.ts` (`Segmenter`),
`image-io.ts` (decode/crop/resize), `onnx.ts` (session loading),
`scripts/fetch-models.mjs` (weights), `scripts/build-vocab-embeddings.mjs` (text
embeddings).

## 1. Nutrition — done (real USDA data)

The demo now reads **real USDA FoodData Central** nutrition from a bundled SQLite
database instead of the single hard-coded rice record.

- **Bundle:** `apps/demo/assets/nutrients.sqlite` — the **full generic-food FDC
  database** (Foundation + SR Legacy + FNDDS ≈ 13.7k foods, ~55% with a
  portion-derived density) with the curated 58-food set **overlaid on top**, so
  the classifier vocabulary keeps resolving to its hand-checked rows
  (per-100 g values, densities, and a **per-food `shape_class`** — bread &
  salmon use the flat slab route) while everything else gains real USDA rows
  for search and future vocabulary growth. Per-class shape priors are seeded
  from MATH.md §4 + the fitted Nutrition5k globals. Rebuild with
  `npm run build:nutrients:full -- <dir with the unzipped per-type FDC CSV
  exports>` (download the Foundation / SR Legacy / FNDDS zips from
  <https://fdc.nal.usda.gov/download-datasets/>; the all-types download is
  gigabytes of branded foods the build filters out anyway). The curated set
  alone: `npm run build:nutrients`.
- **Density derivation handles all three real FDC portion encodings** —
  Foundation's `measure_unit_id`, SR Legacy's free-text `modifier`
  ("cup, diced"), FNDDS's `portion_description` ("1/2 cup") — a parser that
  reads only measure ids sees almost no densities on real data (that bug is
  fixed and regression-tested). Foods without any volumetric portion fall back
  to water density in the store, flagged by `density_source`.
- **Store:** `ExpoSqliteNutrientStore` mirrors the Node reference store
  (`nutrition/etl/nutrient-store.mjs`) exactly — same schema, same resolution
  order (curated alias → exact description → FTS/LIKE), same "null = never invent
  nutrition" rule. On first launch it copies the read-only asset into
  expo-sqlite's directory. `meta.fts` says the FTS5 index is in the file; each
  reader probes its own SQLite for fts5 support and silently degrades to LIKE
  when missing (some `node:sqlite` builds lack it), so the bundle can never
  make a runtime unreadable.
- **Label mapping** (the "quality-critical data artifact"): `nutrition/label-map.json`
  — the map of terse classifier labels + synonyms ("carrot", "grilled chicken")
  → FDC descriptions. It's **generated** from the shared food set
  (`nutrition/starter/build-label-map.mjs` reads `nutrition/starter/foods.mjs`),
  copied next to the DB by `npm run build:nutrients`, and loaded as the store's
  `aliases` (`FOOD_ALIASES` in `apps/demo/src/foods.ts`).
- **Single source of truth** — `nutrition/starter/foods.mjs` defines the food set
  once (vocab word, FDC description, per-100 g USDA values, density, shape,
  aliases); the classifier vocabulary, the nutrient bundle, and the label map are
  all derived from it, so they can never drift. The set is a common subset of
  FoodSeg103's classes (**58 foods**), so the classifier names real ingredients.

## 2. Classification — MobileCLIP-S0 zero-shot (shipped)

`ZeroShotClassifier` (`packages/pipeline/src/zero-shot.ts`) embeds the food crop
with an injected image encoder, cosine-matches it against precomputed **text**
embeddings of the food vocabulary, and softmaxes the scores. Both halves are now
real:

1. **Image encoder** — MobileCLIP-S0's vision head, exported to ONNX
   (`Xenova/mobileclip_s0`, `onnx/vision_model.onnx`), fetched to
   `assets/models/mobileclip_s0_vision.onnx` by `npm run build:models`. The
   injected `ImageEmbedder` (`clip-embedder.ts`) crops the region, resizes to
   256×256, and packs the tensor with `packClipTensor` — **rescale-only**, no
   ImageNet mean/std (MobileCLIP's `preprocessor_config` has `do_normalize:false`).
2. **Text embeddings** — precomputed offline (prompt-ensembled + L2-normalized)
   into `assets/food-vocab-embeddings.json` (`{label, embedding}[]` under `vocab`),
   regenerable with `npm run build:vocab`. The vocab is the **58-food FoodSeg103
   subset** (`nutrition/starter/foods.mjs`), each label resolved to an FDC row via
   `nutrition/label-map.json`. Zero-shot takes any word list, so this is a
   training-free way to name real ingredients (carrot, shrimp, tomato…) instead
   of forcing them into 12 words — validated **12/12** on held-out photos of foods
   absent from the old vocabulary. Adding lookalikes (pork vs. beef) trades a
   little accuracy on ambiguous raw shots; the propose→confirm UI + low-confidence
   flags handle it, and the SegFormer-FoodSeg103 fine-tune (roadmap P2) is the
   learned upgrade.
3. **Wiring:** `makeClipClassifier(createClipEmbedder(session))` in
   `vision-adapters.ts` (`loadVisionDeps()`).

Validated: **6/6 top-1** on real photos (rice, chicken, broccoli, egg, banana,
apple…) through this exact preprocessing. The label is *predicted*; the UI lets
the user correct it (propose→confirm via `relabelItem`/`withEditedItem`).

## 3. Segmentation — SlimSAM "segment everything" (shipped)

`sam-segmenter.ts` runs **SlimSAM** (a SAM-2.1-tiny-class promptable model,
`Xenova/slimsam-77-uniform`) in automatic-mask-generation mode, so the pipeline
weighs **every ingredient** on the plate, not just the centered one. Two ONNX
sessions:

1. **Vision encoder** (`slimsam_vision_encoder.onnx`) — run **once**. The frame is
   resized to SAM's 1024 letterbox (`samResizeTarget`) and normalized+padded by
   `packSamTensor` (ImageNet mean/std, zero-pad bottom/right).
2. **Mask decoder** (`slimsam_decoder.onnx`) — prompted at each point of a **P×P
   grid** (`gridPointPrompts`, default 8×8), one point per call with the exact
   `[1,1,1,2]` tensor shape the preprocessing was validated against. (Batching the
   grid into one decoder call via the exported `point_batch_size` dim allocates a
   ~48 MB output tensor and exercises a decoder path the model may not support at
   runtime — either hard-crashes below the JS layer on device — so the sweep is
   single-point; batching is a post-bring-up speed optimization.) Each point
   proposes up to three masks; `pickBestMaskIndex` takes the best under a
   whole-plate coverage cap, and `maskComponentPolygon` reduces it to its largest
   connected component's **exact-area** rectilinear polygon (traced along
   mask-grid lines, so shoelace area equals the foreground cell count — adjacent
   ingredients get true, non-overlapping footprints instead of overlapping
   bounding boxes).
3. **Reduction** (`dedupeMaskCandidates`) — the grid throws off many overlapping
   proposals per object, so this keeps the **largest mask of each object** and
   suppresses anything sharing more than `overlapThreshold` of the smaller mask's
   footprint (true mask overlap, not bbox IoU — a partial mask nested in a bigger
   one has low IoU but ~1.0 containment, which bbox IoU misses). It also drops the
   **whole-scene mask** (bbox fills the frame in both axes), sub-`minCoverage`
   crumbs, and 1-D slivers (min-side / aspect). `gridPolygonToImage` maps each
   survivor to stored-image pixels.

Then in the pipeline, `estimateMeal` classifies + portions each region and
**collapses items by food label** (`collapseByLabel`): SAM is class-agnostic and
still emits a few overlapping masks per ingredient, so the largest-area mask per
label is kept and the rest dropped — one entry per food, and a single ingredient
is never counted twice in the totals.

All the numeric math is pure, unit-tested code in `@ppe/pipeline`
(`preprocess.ts` + `segment-all.ts`, 34 tests). A hand-coded Node run of the
preprocessing reproduced transformers.js's SAM mask bbox to within a few pixels,
and the full sweep + reduction was validated off-device (onnxruntime-node) on
real food photos — one sensible region per ingredient, no duplicate/whole-scene
masks. On any failure the adapter falls back to a centered square, so
classification + the metric geometry (weight) still run — the P1 drill's intent.

**Known limits (SlimSAM-tiny + a 58-word CLIP vocabulary):** foods outside the
vocabulary are still labeled as the nearest class, and busy mixed dishes yield
the occasional spurious region. Clean semantic multi-food segmentation is what
the planned SegFormer-FoodSeg103 fine-tune (roadmap P2) is for; this SAM +
expanded-zero-shot path is what ships on the models already on device.

**Tuning** (`SamEverythingOptions` in `createSamSegmenter`): `pointsPerSide`
trades recall for latency (more prompts find smaller/occluded items but run the
decoder more times — it is one call per point); `iouThreshold` controls how
aggressively near-duplicate masks merge; `minCoverage`/`maxCoverage` drop crumbs
and the whole-plate mask; `maxRegions` caps downstream classify/portion cost.

## Runtimes & build

- **Both platforms:** `onnxruntime-react-native` runs the same `.onnx` artifacts
  on iOS and Android — no per-platform export, no ExecuTorch/`.pte` custom-model
  path. `int64` decoder labels rely on Hermes `BigInt64Array` (RN 0.79).
- The weights (~80 MB total) are **gitignored**; fetch them with
  `npm run build:models` (dependency-free) before building. Metro bundles them as
  assets (`metro.config.js` adds `onnx` to `assetExts`); `onnx.ts` resolves the
  asset to a file path for `InferenceSession.create`.
- Bundling the models is a **native rebuild** (`npx expo run:android` / `run:ios`),
  not a hot reload.
- **Accuracy upgrades (backlog):** a marching-squares contour (vs. bbox) for the
  SAM region; the ruler-tap pixel as the point prompt; per-class κ/φ; the LiDAR
  height-field route on iPhone Pro.
