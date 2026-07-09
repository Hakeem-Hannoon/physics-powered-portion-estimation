/**
 * On-device vision adapters — segmentation + classification (roadmap P2).
 *
 * STATUS: device + model pending. These are the wiring points for the real
 * models; they are NOT imported by App.tsx yet because they need two things this
 * repo can't ship in JS:
 *   1. the exported model artifacts (Core ML `.mlpackage` on iOS / ExecuTorch
 *      `.pte` on Android) — produced by `model/export/export_coreml.py` /
 *      Colab notebook 04 from the trained SegFormer + MobileCLIP weights;
 *   2. an on-device runtime to run them — Core ML via a native module on iOS,
 *      or `react-native-executorch` on Android (`npx expo install react-native-executorch`).
 *
 * The design keeps the model call *injected*: the runtime-specific inference is a
 * function you pass in, and the platform-agnostic logic (cosine-match zero-shot
 * classification, mask→region) lives here and in `@ppe/pipeline` (tested). So
 * enabling real vision is: export the models → bundle them → implement the two
 * injected functions below → swap these into `deps` in App.tsx.
 *
 * See MODELS.md §1–2 (model choices) and docs/REAL_ADAPTERS.md (integration guide).
 */
import {
  type Embedding,
  type ImageEmbedder,
  type LabeledEmbedding,
  type Region,
  type Segmenter,
  ZeroShotClassifier,
} from "@ppe/pipeline";

/* ----------------------------------------------------------------- classification */

/**
 * Build the real MobileCLIP zero-shot classifier. `encodeImage` is the injected
 * Core ML / ExecuTorch image encoder (crop → embedding); `vocab` is the food
 * vocabulary's precomputed TEXT embeddings (computed offline with the CLIP text
 * encoder — see docs/REAL_ADAPTERS.md). The cosine-match + softmax lives in the
 * tested `ZeroShotClassifier` (@ppe/pipeline).
 */
export function makeClipClassifier(
  encodeImage: ImageEmbedder,
  vocab: LabeledEmbedding[],
): ZeroShotClassifier {
  return new ZeroShotClassifier(encodeImage, vocab);
}

/* ------------------------------------------------------------------- segmentation */

/**
 * The injected segmentation model call: image → a boolean foreground mask at the
 * given pixel resolution. For SAM the ruler tap is the point prompt; for a
 * SegFormer fine-tune it's the argmax of the food classes. `[w,h]` is the stored
 * image size, so the returned mask indexes match the payload's pixel space.
 */
export type SegmentationRunner = (
  imageUri: string,
  imageSize: [number, number],
) => Promise<boolean[][]>; // mask[y][x]

/**
 * Axis-aligned bounding polygon of a boolean mask's foreground, in pixel coords.
 * A deliberately simple, robust region for the first integration; a contour
 * trace (marching squares) is the accuracy upgrade once masks are real, since
 * the pipeline computes metric area from these vertices via the homography.
 */
export function maskToBoundingPolygon(mask: boolean[][]): [number, number][] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < mask.length; y++) {
    const row = mask[y]!;
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (minX > maxX) return []; // empty mask
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

/** `Segmenter` backed by an injected on-device segmentation model. */
export class MaskSegmenter implements Segmenter {
  constructor(private readonly run: SegmentationRunner) {}

  async segment(imageUri: string, imageSize: [number, number]): Promise<Region[]> {
    const mask = await this.run(imageUri, imageSize);
    const polygonPx = maskToBoundingPolygon(mask);
    return polygonPx.length ? [{ polygonPx }] : [];
  }
}

/* ----------------------------------------------------------------------- example wiring

// iOS (Core ML) or Android (react-native-executorch): implement the two calls,
// then swap into App.tsx's `deps`.

import foodVocab from "../assets/food-vocab-embeddings.json"; // { label, embedding }[]

const encodeImage: ImageEmbedder = async (imageUri, region) => {
  // crop `region` from imageUri, resize to the encoder input, run the model,
  // return the L2-normalized image embedding (Float32Array).
  return runMobileClipImageEncoder(imageUri, region);
};

const runSeg: SegmentationRunner = async (imageUri, imageSize) => {
  // run SAM (with the ruler tap as prompt) or the SegFormer fine-tune; return mask[y][x].
  return runSegModel(imageUri, imageSize);
};

const deps = {
  segmenter: new MaskSegmenter(runSeg),
  classifier: makeClipClassifier(encodeImage, foodVocab as LabeledEmbedding[]),
  nutrients: new ExpoSqliteNutrientStore(FOOD_ALIASES),
};
----------------------------------------------------------------------------------------- */

/** Placeholder so `Embedding` stays referenced for docs tooling; harmless. */
export type { Embedding };
