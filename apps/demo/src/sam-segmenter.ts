/**
 * On-device food segmentation via SlimSAM (a SAM 2.1-tiny-class promptable model)
 * — the roadmap P2 segmenter. It resizes the frame to SAM's 1024 letterbox, runs
 * the vision encoder, then prompts the mask decoder with a single point at the
 * image center (the capture UX centers the food under the reticle; the ruler-tap
 * pixel is the documented upgrade). SAM's multimask output is reduced to the food
 * region's bounding polygon, from which the pipeline computes metric area via the
 * plane homography.
 *
 * The preprocessing/coordinate math is the pure, tested code in @ppe/pipeline
 * (packSamTensor / pickBestMaskIndex / maskGridToImagePolygon); a hand-coded Node
 * run of it reproduced transformers.js's SAM mask bbox to within a few pixels, so
 * this port is faithful. On any failure it falls back to a centered square, so
 * classification + the metric geometry (weight) still run — the P1 drill's
 * intended behavior. See docs/REAL_ADAPTERS.md.
 */
import { InferenceSession, Tensor } from "onnxruntime-react-native";
import {
  SAM_INPUT_SIZE,
  type Region,
  type Segmenter,
  centerPointPrompt,
  maskGridToImagePolygon,
  packSamTensor,
  pickBestMaskIndex,
  samResizeTarget,
  thresholdMaskBBox,
} from "@ppe/pipeline";
import { decodeJpegRgba, manipulateToBase64 } from "./image-io";

/** The placeholder region — a centered square (~16% of frame) — used as a
 *  graceful fallback. Exercises the real metric geometry against a weighable
 *  single dish (roadmap P1) even when the model can't run. */
function centeredSquare(w: number, h: number): Region[] {
  const side = Math.min(w, h) * 0.4;
  const cx = w / 2;
  const cy = h / 2;
  return [
    {
      polygonPx: [
        [cx - side / 2, cy - side / 2],
        [cx + side / 2, cy - side / 2],
        [cx + side / 2, cy + side / 2],
        [cx - side / 2, cy + side / 2],
      ],
    },
  ];
}

export function createSamSegmenter(
  vision: InferenceSession,
  decoder: InferenceSession,
): Segmenter {
  return {
    async segment(imageUri, [W, H]) {
      try {
        const { scale, newW, newH } = samResizeTarget(W, H);
        const base64 = await manipulateToBase64(imageUri, { width: newW, height: newH });
        const rgba = decodeJpegRgba(base64);
        const pixels = packSamTensor(rgba, SAM_INPUT_SIZE);

        const encoded = await vision.run({
          pixel_values: new Tensor("float32", pixels, [1, 3, SAM_INPUT_SIZE, SAM_INPUT_SIZE]),
        });

        const decoded = await decoder.run({
          input_points: new Tensor("float32", centerPointPrompt(W, H, scale), [1, 1, 1, 2]),
          // int64 foreground label; Hermes (RN 0.79) supports BigInt64Array.
          input_labels: new Tensor("int64", new BigInt64Array([1n]), [1, 1, 1]),
          image_embeddings: encoded.image_embeddings,
          image_positional_embeddings: encoded.image_positional_embeddings,
        });

        const pred = decoded.pred_masks; // dims [1, 1, numMasks, gh, gw]
        const iou = decoded.iou_scores; // dims [1, 1, numMasks]
        const numMasks = pred.dims[2]!;
        const gh = pred.dims[3]!;
        const gw = pred.dims[4]!;
        const logits = pred.data as Float32Array;

        const bboxes = [];
        const coverage: number[] = [];
        for (let m = 0; m < numMasks; m++) {
          const bb = thresholdMaskBBox(logits, gw, gh, m);
          bboxes.push(bb);
          coverage.push(bb.count / (gw * gh));
        }
        const best = pickBestMaskIndex(iou.data as Float32Array, coverage);
        const bb = bboxes[best]!;
        if (bb.count === 0) return centeredSquare(W, H);
        return [{ polygonPx: maskGridToImagePolygon(bb, gw, gh, scale, W, H) }];
      } catch (error) {
        console.warn("[SAM] segmentation failed; centered-square fallback:", error);
        return centeredSquare(W, H);
      }
    },
  };
}
