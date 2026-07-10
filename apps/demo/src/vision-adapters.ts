/**
 * On-device vision — the composition root that turns the bundled ONNX models into
 * the pipeline's real `Segmenter` + `Classifier` (roadmap P2). The pieces:
 *   • segmentation: SlimSAM (point-prompted) → `createSamSegmenter` (sam-segmenter.ts)
 *   • classification: MobileCLIP-S0 image encoder → `createClipEmbedder`
 *     (clip-embedder.ts) feeding the tested `ZeroShotClassifier` against the
 *     precomputed food-vocabulary text embeddings (assets/food-vocab-embeddings.json)
 *   • nutrition stays the real SQLite `ExpoSqliteNutrientStore`.
 *
 * Runtime: onnxruntime-react-native (one ONNX per model, iOS + Android) — chosen
 * over the ExecuTorch custom-model path (MODELS.md / docs the "highest-risk
 * unknown") because a single cross-platform artifact per model de-risks it. The
 * models are a native dependency, so enabling this is a dev rebuild
 * (`npx expo run:android` / `run:ios`) with the weights fetched first
 * (`npm run build:models`). See docs/REAL_ADAPTERS.md.
 */
import { InferenceSession } from "onnxruntime-react-native";
import {
  type Classifier,
  type ImageEmbedder,
  type LabeledEmbedding,
  type Segmenter,
  ZeroShotClassifier,
} from "@ppe/pipeline";
import { loadSession } from "./onnx";
import { createClipEmbedder } from "./clip-embedder";
import { createSamSegmenter } from "./sam-segmenter";
import vocabDoc from "../assets/food-vocab-embeddings.json";

// Bundled model weights (metro bundles *.onnx as assets; expo-asset → file path).
const CLIP_VISION = require("../assets/models/mobileclip_s0_vision.onnx") as number;
const SAM_VISION = require("../assets/models/slimsam_vision_encoder.onnx") as number;
const SAM_DECODER = require("../assets/models/slimsam_decoder.onnx") as number;

/** Precomputed MobileCLIP text embeddings for the starter-bundle food vocabulary. */
export const FOOD_VOCAB: LabeledEmbedding[] = (
  vocabDoc as unknown as { vocab: LabeledEmbedding[] }
).vocab;

/**
 * Build the real MobileCLIP zero-shot classifier: `embed` is the injected image
 * encoder (crop → embedding); `vocab` is the food vocabulary's precomputed text
 * embeddings. The cosine-match + softmax lives in the tested `ZeroShotClassifier`.
 */
export function makeClipClassifier(
  embed: ImageEmbedder,
  vocab: LabeledEmbedding[] = FOOD_VOCAB,
): Classifier {
  return new ZeroShotClassifier(embed, vocab);
}

export interface VisionDeps {
  segmenter: Segmenter;
  classifier: Classifier;
}

/**
 * Load the on-device models and assemble the real segmenter + classifier. Heavy
 * (three ONNX sessions, ~80 MB total) — call once on startup and reuse.
 */
export async function loadVisionDeps(): Promise<VisionDeps> {
  const [clipVision, samVision, samDecoder] = await Promise.all([
    loadSession(CLIP_VISION),
    loadSession(SAM_VISION),
    loadSession(SAM_DECODER),
  ]);
  return {
    segmenter: createSamSegmenter(samVision, samDecoder),
    classifier: makeClipClassifier(createClipEmbedder(clipVision)),
  };
}

export type { InferenceSession };
