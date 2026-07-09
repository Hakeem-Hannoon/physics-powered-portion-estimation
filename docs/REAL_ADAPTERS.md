# Real model adapters — integration guide

How the demo replaces the three mock adapters with real ones, what's shipped
today, and exactly how to wire the two that need on-device models. The adapter
interfaces are in `packages/pipeline/src/adapters.ts`; this is the guide to
implementing them for real.

| Adapter | Interface | Status | Where |
|---|---|---|---|
| **NutrientStore** | `lookup(label) → FoodRecord \| null` | ✅ **real & shipped** | `apps/demo/src/nutrient-store.ts` (expo-sqlite) |
| **Classifier** | `classify(uri, region) → {label, confidence, topK}` | 🟡 interim = food picker; real logic tested | `ZeroShotClassifier` (`@ppe/pipeline`) + `apps/demo/src/vision-adapters.ts` |
| **Segmenter** | `segment(uri, size) → Region[]` | 🟡 placeholder = centered square | `MaskSegmenter` (`apps/demo/src/vision-adapters.ts`) |

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

## 2. Classification — MobileCLIP zero-shot (needs the model)

The **matching logic is real and unit-tested**: `ZeroShotClassifier`
(`packages/pipeline/src/zero-shot.ts`) embeds the food crop, cosine-matches it
against precomputed **text** embeddings of the food vocabulary, and softmaxes the
scores. What's missing is the on-device **image encoder** — a device+model piece:

1. **Export MobileCLIP** (S0) image encoder to Core ML (iOS) and/or ExecuTorch
   (Android). See MODELS.md §2 (`apple/coreml-mobileclip`).
2. **Precompute text embeddings** for the food vocabulary offline with the CLIP
   *text* encoder (FoodSeg103 labels + FDC descriptions, prompt-ensembled) and
   ship them as an asset, e.g. `assets/food-vocab-embeddings.json`
   (`{label, embedding}[]`).
3. **Implement the injected `ImageEmbedder`** — crop `region`, resize to the
   encoder input, run the model, return the L2-normalized embedding.
4. **Wire it:** `makeClipClassifier(encodeImage, vocab)` in `vision-adapters.ts`.

Until then the demo uses `SelectedClassifier` (the food picker) so you still get
real nutrition for the real measured portion — the label is confirmed, not
predicted.

## 3. Segmentation — SAM 2.1 / SegFormer (needs the model)

`MaskSegmenter` (`vision-adapters.ts`) takes an injected `SegmentationRunner`
(`image → boolean mask`) and converts the mask to a `Region` via
`maskToBoundingPolygon` (a robust bounding polygon; a marching-squares contour
trace is the accuracy upgrade). To enable:

1. **Export the model:** SAM 2.1-tiny Core ML (the ruler tap is the point prompt)
   on iOS, or the **SegFormer-B0 fine-tune** (mIoU 0.246, `MODELS_REGISTRY.md`
   Stage 1) via ExecuTorch on Android.
2. **Implement `SegmentationRunner`** — run the model, threshold to a foreground
   `mask[y][x]` in the stored image's pixel space.
3. **Wire it:** `new MaskSegmenter(runSeg)` in `deps` (App.tsx).

The centered-square placeholder is intentional for the P1 drill: it exercises the
**real** metric geometry (ruler → homography → area → volume → mass) so you can
validate grams against a kitchen scale before the segmentation model lands.

## Runtimes & build

- **iOS:** Core ML via a native module (the capture module already establishes
  the native-module pattern).
- **Android:** `react-native-executorch` (`npx expo install react-native-executorch`)
  loads the exported `.pte`. MODELS.md §1 notes the SegFormer fine-tune rides its
  custom-model path.
- Adding either is a **native rebuild** (`npx expo run:android` / `run:ios`), and
  both need the exported model artifacts bundled — neither ships in this repo yet.
