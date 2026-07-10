/**
 * Platform-agnostic image preprocessing + coordinate math for the on-device
 * vision adapters (MobileCLIP-S0 classifier, SlimSAM segmenter). This is pure
 * typed-array numeric code, kept here so it is unit-tested by vitest exactly
 * like `@ppe/geometry` — while the demo owns only the React-Native-specific I/O
 * (JPEG decode via jpeg-js, native crop/resize via expo-image-manipulator, the
 * onnxruntime-react-native session). It mirrors the `ZeroShotClassifier` split:
 * the tested logic lives in the library; the model call is injected in the app.
 *
 * Every constant and transform below was captured from the models' own
 * `preprocessor_config.json` and verified in Node against transformers.js — a
 * hand-coded run of this exact math reproduced transformers.js's SAM mask bbox
 * to within a few pixels, and MobileCLIP zero-shot scored 6/6 on real photos.
 * See docs/REAL_ADAPTERS.md.
 */

/** A decoded RGBA raster (stride 4: R,G,B,A per pixel). What jpeg-js returns. */
export interface Rgba {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ MobileCLIP */

/**
 * MobileCLIP-S0 input side (square). Its preprocessing is rescale-only — pixels
 * are scaled to [0,1] and NOT normalized by ImageNet mean/std (the model's
 * preprocessor_config has `do_normalize: false`). Resize the food crop to this
 * size before packing.
 */
export const CLIP_INPUT_SIZE = 256;

/**
 * Pack an already-`size`×`size` RGBA crop into a MobileCLIP image tensor of shape
 * [1, 3, size, size] (channels-first, RGB, scaled to [0,1]). The caller resizes
 * the food region to `size`×`size` natively first (expo-image-manipulator).
 */
export function packClipTensor(img: Rgba, size = CLIP_INPUT_SIZE): Float32Array {
  if (img.width !== size || img.height !== size) {
    throw new Error(`packClipTensor expects ${size}x${size}, got ${img.width}x${img.height}`);
  }
  const out = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const p = y * size + x;
      out[p] = img.data[s]! / 255; // R
      out[plane + p] = img.data[s + 1]! / 255; // G
      out[2 * plane + p] = img.data[s + 2]! / 255; // B
    }
  }
  return out;
}

/** Axis-aligned pixel bounding box of a polygon, clamped to [0,w)×[0,h). */
export function polygonBBox(
  polygon: [number, number][],
  imageW: number,
  imageH: number,
): { x: number; y: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of polygon) {
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  const x = Math.max(0, Math.floor(minX));
  const y = Math.max(0, Math.floor(minY));
  const width = Math.min(imageW, Math.ceil(maxX)) - x;
  const height = Math.min(imageH, Math.ceil(maxY)) - y;
  return { x, y, width: Math.max(1, width), height: Math.max(1, height) };
}

/* ------------------------------------------------------------------- SlimSAM */

/** SAM (SlimSAM) input side and ImageNet normalization (preprocessor_config). */
export const SAM_INPUT_SIZE = 1024;
export const SAM_MEAN: readonly [number, number, number] = [0.485, 0.456, 0.406];
export const SAM_STD: readonly [number, number, number] = [0.229, 0.224, 0.225];

export interface SamResizeTarget {
  scale: number;
  newW: number;
  newH: number;
}

/**
 * SAM resizes so the LONGEST edge is `longEdge` (1024), preserving aspect, then
 * zero-pads to a square. This returns the resize target (do the resize natively,
 * then `packSamTensor`) and the `scale` needed to map coordinates back later.
 */
export function samResizeTarget(
  origW: number,
  origH: number,
  longEdge = SAM_INPUT_SIZE,
): SamResizeTarget {
  const scale = longEdge / Math.max(origW, origH);
  return { scale, newW: Math.round(origW * scale), newH: Math.round(origH * scale) };
}

/**
 * Pack an already-resized RGBA image (newW×newH from `samResizeTarget`) into a
 * padded SAM tensor [1, 3, size, size]: ImageNet-normalized in the top-left valid
 * region, zero-padded on the bottom/right (SAM's pad rule). Channels-first, RGB.
 */
export function packSamTensor(
  img: Rgba,
  size = SAM_INPUT_SIZE,
  mean = SAM_MEAN,
  std = SAM_STD,
): Float32Array {
  const out = new Float32Array(3 * size * size); // zeros → padding
  const plane = size * size;
  const w = Math.min(img.width, size);
  const h = Math.min(img.height, size);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * img.width + x) * 4;
      const p = y * size + x;
      out[p] = (img.data[s]! / 255 - mean[0]) / std[0];
      out[plane + p] = (img.data[s + 1]! / 255 - mean[1]) / std[1];
      out[2 * plane + p] = (img.data[s + 2]! / 255 - mean[2]) / std[2];
    }
  }
  return out;
}

/** The point prompt (image center) in the resized SAM frame, shape-[1,1,1,2] data. */
export function centerPointPrompt(origW: number, origH: number, scale: number): Float32Array {
  return new Float32Array([(origW / 2) * scale, (origH / 2) * scale]);
}

export interface MaskBBox {
  count: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Threshold one mask of SAM's multimask logits (`pred_masks`, laid out
 * [...masks][gh][gw]) at 0 (>0 ⇒ foreground) and return its grid-space bbox and
 * foreground pixel count.
 */
export function thresholdMaskBBox(
  logits: ArrayLike<number>,
  gridW: number,
  gridH: number,
  maskIndex: number,
): MaskBBox {
  const off = maskIndex * gridW * gridH;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      if (logits[off + y * gridW + x]! > 0) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { count, minX, minY, maxX, maxY };
}

/**
 * Choose which of SAM's multimask outputs to use: the highest-IoU mask whose
 * foreground coverage is at or below `maxCoverage`. SAM's largest mask is often
 * the whole scene/plate/table; we want the food, so we cap coverage and prefer
 * the confident sub-whole mask. If every mask exceeds the cap, fall back to the
 * smallest-coverage one (least-bad) rather than the whole frame.
 */
export function pickBestMaskIndex(
  iou: ArrayLike<number>,
  coverage: ArrayLike<number>,
  maxCoverage = 0.92,
): number {
  let best = -1;
  let bestIou = -Infinity;
  for (let i = 0; i < iou.length; i++) {
    if (coverage[i]! <= maxCoverage && iou[i]! > bestIou) {
      best = i;
      bestIou = iou[i]!;
    }
  }
  if (best >= 0) return best;
  let smallest = 0;
  for (let i = 1; i < coverage.length; i++) {
    if (coverage[i]! < coverage[smallest]!) smallest = i;
  }
  return smallest;
}

/**
 * Map a low-res SAM mask-grid bbox back to a bounding polygon in ORIGINAL
 * stored-image pixels. The `gridW×gridH` grid spans the full padded `size`×`size`
 * SAM frame, whose valid image occupies the top-left `scale`-resized region — so
 * a grid cell → padded-frame px → ÷ scale → original px (clamped to the image).
 * The bbox is expanded to the outer edges of the min/max cells so it fully covers
 * the mask; metric area is computed from these vertices via the plane homography.
 */
export function maskGridToImagePolygon(
  bb: MaskBBox,
  gridW: number,
  gridH: number,
  scale: number,
  origW: number,
  origH: number,
  size = SAM_INPUT_SIZE,
): [number, number][] {
  const map = (gx: number, gy: number): [number, number] => {
    const fx = (gx / gridW) * size;
    const fy = (gy / gridH) * size;
    return [
      Math.min(origW, Math.max(0, fx / scale)),
      Math.min(origH, Math.max(0, fy / scale)),
    ];
  };
  const [x0, y0] = map(bb.minX, bb.minY);
  const [x1, y1] = map(bb.maxX + 1, bb.maxY + 1); // outer edge of the last cell
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}
