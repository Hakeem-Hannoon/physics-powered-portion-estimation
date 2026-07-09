import type { Classifier, ClassifierResult, Region } from "./adapters";

/**
 * Zero-shot classification via an embedding model (MobileCLIP-class): embed the
 * food crop, cosine-match it against precomputed *text* embeddings of the food
 * vocabulary, softmax the scores into confidences (MODELS.md §2). The visual
 * encoder is the only per-capture model call — the text embeddings are computed
 * offline — so this class takes the encoder as an injected `embed` function and
 * keeps the matching logic here, platform-agnostic and unit-tested. The demo
 * wires a real Core ML / ExecuTorch encoder into it (apps/demo/src/vision-adapters.ts).
 */

export type Embedding = ArrayLike<number>;

/** Cosine similarity of two equal-length vectors; 0 if either is degenerate. */
export function cosineSimilarity(a: Embedding, b: Embedding): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/** Numerically-stable softmax over scores scaled by `temperature` (CLIP logit scale). */
export function softmax(scores: number[], temperature = 100): number[] {
  if (scores.length === 0) return [];
  const scaled = scores.map((s) => s * temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((e) => e / sum);
}

/** One food-vocabulary entry: a label plus its precomputed text embedding. */
export interface LabeledEmbedding {
  label: string;
  embedding: Embedding;
}

/** The injected visual encoder: crop of `region` in `imageUri` → embedding. */
export type ImageEmbedder = (imageUri: string, region: Region) => Promise<Embedding>;

export class ZeroShotClassifier implements Classifier {
  /**
   * @param embed   the visual encoder (Core ML / ExecuTorch MobileCLIP image head)
   * @param vocab   precomputed text embeddings, one per food label
   * @param topK    how many ranked alternatives to return (default 3)
   */
  constructor(
    private readonly embed: ImageEmbedder,
    private readonly vocab: LabeledEmbedding[],
    private readonly topK = 3,
  ) {
    if (vocab.length === 0) throw new Error("ZeroShotClassifier needs a non-empty vocabulary");
  }

  async classify(imageUri: string, region: Region): Promise<ClassifierResult> {
    const v = await this.embed(imageUri, region);
    const sims = this.vocab.map((entry) => cosineSimilarity(v, entry.embedding));
    const probs = softmax(sims);
    const ranked = this.vocab
      .map((entry, i) => ({ label: entry.label, confidence: probs[i]! }))
      .sort((a, b) => b.confidence - a.confidence);
    const best = ranked[0]!;
    return {
      label: best.label,
      confidence: best.confidence,
      topK: ranked.slice(0, this.topK),
    };
  }
}
