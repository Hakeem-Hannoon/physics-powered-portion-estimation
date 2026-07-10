import { describe, expect, it } from "vitest";
import {
  CLIP_INPUT_SIZE,
  SAM_INPUT_SIZE,
  SAM_MEAN,
  SAM_STD,
  centerPointPrompt,
  maskGridToImagePolygon,
  packClipTensor,
  packSamTensor,
  pickBestMaskIndex,
  polygonBBox,
  samResizeTarget,
  thresholdMaskBBox,
} from "../src/preprocess";

/** Build an RGBA raster from a per-pixel [r,g,b] function. */
function rgba(w: number, h: number, fn: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

describe("packClipTensor", () => {
  it("lays out NCHW RGB scaled to [0,1], no mean/std", () => {
    // 2x2 with distinct channels; use a size-2 tensor for the test.
    const img = rgba(2, 2, (x, y) => [x === 0 ? 255 : 0, y === 0 ? 128 : 0, 51]);
    const t = packClipTensor(img, 2);
    expect(t.length).toBe(3 * 2 * 2);
    // R plane first (offset 0): x==0 → 1, x==1 → 0
    expect(t[0]).toBeCloseTo(1, 6); // (0,0) R
    expect(t[1]).toBeCloseTo(0, 6); // (1,0) R
    // G plane (offset 4): y==0 → 128/255
    expect(t[4]).toBeCloseTo(128 / 255, 5); // (0,0) G
    expect(t[6]).toBeCloseTo(0, 6); // (0,1) G
    // B plane (offset 8): constant 51/255 = 0.2
    expect(t[8]).toBeCloseTo(0.2, 5);
  });

  it("rejects a crop that is not size×size (caller must resize first)", () => {
    expect(() => packClipTensor(rgba(10, 8, () => [0, 0, 0]), CLIP_INPUT_SIZE)).toThrow();
  });
});

describe("polygonBBox", () => {
  it("returns the clamped integer bbox of a polygon", () => {
    const bb = polygonBBox(
      [
        [10.4, 20.9],
        [50.2, 20.9],
        [50.2, 60.1],
        [10.4, 60.1],
      ],
      1000,
      1000,
    );
    expect(bb).toEqual({ x: 10, y: 20, width: 51 - 10, height: 61 - 20 });
  });

  it("clamps to the image and never returns a zero dimension", () => {
    const bb = polygonBBox(
      [
        [-5, -5],
        [3, -5],
        [3, 3],
        [-5, 3],
      ],
      100,
      100,
    );
    expect(bb.x).toBe(0);
    expect(bb.y).toBe(0);
    expect(bb.width).toBeGreaterThanOrEqual(1);
    expect(bb.height).toBeGreaterThanOrEqual(1);
  });
});

describe("samResizeTarget", () => {
  it("scales the longest edge to 1024 preserving aspect", () => {
    expect(samResizeTarget(2000, 1000)).toEqual({ scale: 1024 / 2000, newW: 1024, newH: 512 });
    expect(samResizeTarget(1000, 2000)).toEqual({ scale: 1024 / 2000, newW: 512, newH: 1024 });
    const sq = samResizeTarget(480, 480);
    expect(sq.newW).toBe(1024);
    expect(sq.newH).toBe(1024);
  });
});

describe("packSamTensor", () => {
  it("ImageNet-normalizes the valid region and zero-pads the rest", () => {
    // 2x2 mid-gray image packed into a size-4 padded frame.
    const img = rgba(2, 2, () => [128, 128, 128]);
    const t = packSamTensor(img, 4);
    expect(t.length).toBe(3 * 4 * 4);
    const plane = 4 * 4;
    const norm = (c: number) => (128 / 255 - SAM_MEAN[c]!) / SAM_STD[c]!;
    // valid pixel (0,0)
    expect(t[0]).toBeCloseTo(norm(0), 5); // R
    expect(t[plane]).toBeCloseTo(norm(1), 5); // G
    expect(t[2 * plane]).toBeCloseTo(norm(2), 5); // B
    // padded pixel (3,3) stays exactly 0 in every channel
    expect(t[3 * 4 + 3]).toBe(0);
    expect(t[plane + 3 * 4 + 3]).toBe(0);
  });
});

describe("centerPointPrompt", () => {
  it("maps the original-image center into the resized SAM frame", () => {
    const { scale } = samResizeTarget(2000, 1000);
    const p = centerPointPrompt(2000, 1000, scale);
    expect(p[0]).toBeCloseTo(1000 * scale, 5); // 512
    expect(p[1]).toBeCloseTo(500 * scale, 5); // 256
  });
});

describe("thresholdMaskBBox", () => {
  it("thresholds logits at 0 and returns the grid bbox of the chosen mask", () => {
    // Two 3x3 masks concatenated; mask #1 has a 2x2 block of positives.
    const gw = 3;
    const gh = 3;
    const m0 = new Float32Array(9).fill(-1);
    const m1 = new Float32Array([-1, -1, -1, -1, 2, 3, -1, 4, 5]); // positives at (1,1),(2,1),(1,2),(2,2)
    const logits = Float32Array.from([...m0, ...m1]);
    const bb = thresholdMaskBBox(logits, gw, gh, 1);
    expect(bb.count).toBe(4);
    expect(bb).toMatchObject({ minX: 1, minY: 1, maxX: 2, maxY: 2 });
    expect(thresholdMaskBBox(logits, gw, gh, 0).count).toBe(0);
  });
});

describe("pickBestMaskIndex", () => {
  it("prefers the highest-IoU mask under the coverage cap (avoids whole-frame)", () => {
    // mask 2 has the best IoU but covers the whole frame; mask 1 is the food.
    const iou = [0.5, 0.8, 0.99];
    const coverage = [0.1, 0.4, 0.98];
    expect(pickBestMaskIndex(iou, coverage, 0.92)).toBe(1);
  });

  it("falls back to the smallest-coverage mask when all exceed the cap", () => {
    const iou = [0.9, 0.95, 0.99];
    const coverage = [0.97, 0.95, 0.99];
    expect(pickBestMaskIndex(iou, coverage, 0.92)).toBe(1);
  });
});

describe("maskGridToImagePolygon", () => {
  it("maps a grid bbox back to original pixels through the letterbox scale", () => {
    // 2000x1000 image → scale 0.512, 256-grid over the 1024 padded frame.
    const { scale } = samResizeTarget(2000, 1000);
    const bb = { count: 1, minX: 64, minY: 32, maxX: 127, maxY: 63 };
    const poly = maskGridToImagePolygon(bb, 256, 256, scale, 2000, 1000);
    expect(poly).toHaveLength(4);
    const [p0, p1, p2, p3] = poly as [[number, number], [number, number], [number, number], [number, number]];
    // minX cell 64 → frame (64/256)*1024=256 → /scale = 256/0.512 = 500 orig px
    expect(p0[0]).toBeCloseTo(500, 3);
    expect(p0[1]).toBeCloseTo(250, 3); // 32→128 frame → 250 orig
    // maxX+1 = 128 → frame 512 → 1000 orig px
    expect(p1[0]).toBeCloseTo(1000, 3);
    // rectangle, 4 CW corners
    expect(p2).toEqual([p1[0], p3[1]]);
  });

  it("clamps mapped coordinates to the image bounds", () => {
    const { scale } = samResizeTarget(1000, 1000);
    // a bbox that runs to the grid edge must not exceed the original size
    const bb = { count: 1, minX: 0, minY: 0, maxX: 255, maxY: 255 };
    const poly = maskGridToImagePolygon(bb, 256, 256, scale, 1000, 1000);
    for (const [x, y] of poly) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1000);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1000);
    }
  });
});

describe("constants", () => {
  it("match the models' preprocessor configs", () => {
    expect(CLIP_INPUT_SIZE).toBe(256);
    expect(SAM_INPUT_SIZE).toBe(1024);
    expect(SAM_MEAN).toEqual([0.485, 0.456, 0.406]);
    expect(SAM_STD).toEqual([0.229, 0.224, 0.225]);
  });
});
