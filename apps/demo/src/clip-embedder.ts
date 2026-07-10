/**
 * The injected MobileCLIP image encoder for `ZeroShotClassifier` (@ppe/pipeline).
 * Crops the food region, resizes to the model's 256×256 input, decodes to RGBA,
 * packs the [1,3,256,256] tensor (rescale-only — MobileCLIP does NOT mean/std
 * normalize), runs the vision encoder, and returns the image embedding. The
 * cosine-match + softmax against the precomputed text vocabulary happens in the
 * tested ZeroShotClassifier. Validated end-to-end in Node: 6/6 top-1 on real
 * food photos through this exact preprocessing. See docs/REAL_ADAPTERS.md.
 */
import { InferenceSession, Tensor } from "onnxruntime-react-native";
import {
  CLIP_INPUT_SIZE,
  type ImageEmbedder,
  packClipTensor,
  polygonBBox,
} from "@ppe/pipeline";
import { decodeJpegRgba, imageSize, manipulateToBase64 } from "./image-io";

export function createClipEmbedder(session: InferenceSession): ImageEmbedder {
  return async (imageUri, region) => {
    const { width, height } = await imageSize(imageUri);
    const crop = polygonBBox(region.polygonPx, width, height);
    const base64 = await manipulateToBase64(
      imageUri,
      { width: CLIP_INPUT_SIZE, height: CLIP_INPUT_SIZE },
      crop,
    );
    const rgba = decodeJpegRgba(base64);
    const pixels = packClipTensor(rgba, CLIP_INPUT_SIZE);
    const feeds = {
      pixel_values: new Tensor("float32", pixels, [1, 3, CLIP_INPUT_SIZE, CLIP_INPUT_SIZE]),
    };
    const { image_embeds } = await session.run(feeds);
    return image_embeds.data as Float32Array; // ZeroShotClassifier L2-normalizes on cosine
  };
}
