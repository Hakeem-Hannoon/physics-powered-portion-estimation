import { describe, expect, it } from "vitest";
import {
  type Region,
  ZeroShotClassifier,
  cosineSimilarity,
  softmax,
} from "../src/index";

const region: Region = { polygonPx: [[0, 0], [1, 0], [1, 1], [0, 1]] };

describe("cosineSimilarity", () => {
  it("is 1 for identical, 0 for orthogonal, -1 for opposite", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });
  it("is 0 for a degenerate (zero) vector rather than NaN", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("softmax", () => {
  it("returns a distribution that sums to 1 and preserves order", () => {
    const p = softmax([0.1, 0.9, 0.3], 10);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(p[1]).toBeGreaterThan(p[2]!);
    expect(p[2]).toBeGreaterThan(p[0]!);
  });
  it("handles the empty case", () => {
    expect(softmax([])).toEqual([]);
  });
});

describe("ZeroShotClassifier", () => {
  const vocab = [
    { label: "rice", embedding: [1, 0, 0] },
    { label: "chicken", embedding: [0, 1, 0] },
    { label: "broccoli", embedding: [0, 0, 1] },
  ];

  it("picks the nearest vocabulary label by cosine and ranks topK", async () => {
    // An embedding closest to 'chicken'.
    const embed = async () => [0.1, 0.95, 0.05];
    const clf = new ZeroShotClassifier(embed, vocab);
    const res = await clf.classify("file:///x.jpg", region);
    expect(res.label).toBe("chicken");
    expect(res.confidence).toBeGreaterThan(0);
    expect(res.confidence).toBeLessThanOrEqual(1);
    expect(res.topK?.[0]!.label).toBe("chicken");
    expect(res.topK).toHaveLength(3);
    // Confidences are a descending, valid distribution slice.
    expect(res.topK![0]!.confidence).toBeGreaterThanOrEqual(res.topK![1]!.confidence);
  });

  it("passes the crop region through to the injected encoder", async () => {
    let seen: Region | null = null;
    const embed = async (_uri: string, r: Region) => {
      seen = r;
      return [1, 0, 0];
    };
    await new ZeroShotClassifier(embed, vocab).classify("file:///x.jpg", region);
    expect(seen).toBe(region);
  });

  it("rejects an empty vocabulary", () => {
    expect(() => new ZeroShotClassifier(async () => [1], [])).toThrow(/vocabulary/);
  });
});
