# Real model adapters — integration guide

All three model adapters behind the pipeline are now **real and on-device** — the
demo classifies the food and weighs it end-to-end with no picker. This is the
guide to how they're wired. The adapter interfaces are in
`packages/pipeline/src/adapters.ts`.

| Adapter | Interface | Status | Where |
|---|---|---|---|
| **NutrientStore** | `lookup(label) → FoodRecord \| null` | ✅ **real & shipped** | `apps/demo/src/nutrient-store.ts` (expo-sqlite) |
| **Classifier** | `classify(uri, region) → {label, confidence, topK}` | ✅ **real & shipped** | MobileCLIP-S0 zero-shot: `ZeroShotClassifier` (`@ppe/pipeline`) + `clip-embedder.ts` |
| **Segmenter** | `segment(uri, size) → Region[]` | ✅ **real & shipped** | SlimSAM point-prompt: `sam-segmenter.ts` |

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

- **Bundle:** `apps/demo/assets/nutrients.sqlite` — a curated *starter* set of 12
  common foods with real per-100 g values + portion-derived densities, a
  **per-food `shape_class`** (mound/flat — bread & salmon use the flat slab
  route), and per-class shape priors seeded from MATH.md §4 (the fitted per-class
  κ/φ/h̄ from Nutrition5k override them once available). Rebuild with
  `npm run build:nutrients` (source: `nutrition/starter/build-starter.mjs`).
- **Store:** `ExpoSqliteNutrientStore` mirrors the Node reference store
  (`nutrition/etl/nutrient-store.mjs`) exactly — same schema, same resolution
  order (curated alias → exact description → FTS/LIKE), same "null = never invent
  nutrition" rule. On first launch it copies the read-only asset into
  expo-sqlite's directory.
- **Production bundle:** run the full ETL over the real FDC CSV export (~15k
  foods) instead of the starter set — `npm run etl:bundle -- --fdc-dir ./fdc-csv
  --out apps/demo/assets/nutrients.sqlite` (download: <https://fdc.nal.usda.gov/download-datasets/>).
- **Label mapping** (the "quality-critical data artifact"): `nutrition/label-map.json`
  — the curated map of terse classifier labels + synonyms ("rice", "grilled
  chicken") → FDC descriptions. It's copied next to the DB by `npm run build:nutrients`
  and loaded as the store's `aliases` (`FOOD_ALIASES` in `apps/demo/src/foods.ts`).
  Grow it toward the full FoodSeg103 vocabulary once the classifier vocab is fixed.

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
   regenerable with `npm run build:vocab`. The vocab is the 12 starter-bundle
   labels, resolved to FDC rows via `nutrition/label-map.json`.
3. **Wiring:** `makeClipClassifier(createClipEmbedder(session))` in
   `vision-adapters.ts` (`loadVisionDeps()`).

Validated: **6/6 top-1** on real photos (rice, chicken, broccoli, egg, banana,
apple…) through this exact preprocessing. The label is *predicted*; the UI lets
the user correct it (propose→confirm via `relabelItem`/`withEditedItem`).

## 3. Segmentation — SlimSAM point-prompt (shipped)

`sam-segmenter.ts` runs **SlimSAM** (a SAM-2.1-tiny-class promptable model,
`Xenova/slimsam-77-uniform`) via two ONNX sessions:

1. **Vision encoder** (`slimsam_vision_encoder.onnx`) — the frame is resized to
   SAM's 1024 letterbox (`samResizeTarget`) and normalized+padded by
   `packSamTensor` (ImageNet mean/std, zero-pad bottom/right).
2. **Mask decoder** (`slimsam_decoder.onnx`) — prompted with a single point at the
   frame center (the capture UX centers the food; the ruler-tap pixel is the
   documented upgrade) and the encoder's embeddings. Its multimask output is
   reduced to the food region's bounding polygon in stored-image pixels
   (`pickBestMaskIndex` avoids the whole-plate mask; `maskGridToImagePolygon` maps
   the low-res grid back through the letterbox), from which the pipeline computes
   metric area via the plane homography.

All the numeric math is pure, unit-tested code in `@ppe/pipeline`
(`preprocess.ts`). A hand-coded Node run of it reproduced transformers.js's SAM
mask bbox to within a few pixels. On any failure the adapter falls back to a
centered square, so classification + the metric geometry (weight) still run — the
P1 drill's intended behavior.

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
