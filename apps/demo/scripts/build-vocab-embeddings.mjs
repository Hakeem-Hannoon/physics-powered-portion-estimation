/**
 * Regenerate assets/food-vocab-embeddings.json — the precomputed MobileCLIP-S0
 * text embeddings for on-device zero-shot classification. Only needed when the
 * food vocabulary changes; the committed JSON already covers the starter bundle.
 *
 * The image encoder runs per-capture on device; these text embeddings are the
 * offline half (prompt-ensembled + L2-normalized, cosine-matched on device by
 * packages/pipeline/src/zero-shot.ts). Validated: 6/6 top-1 on real food photos.
 *
 * Requires transformers.js (dev-only, not bundled into the app):
 *   npm i -D @huggingface/transformers   # then: npm run build:vocab
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL = "Xenova/mobileclip_s0";
const CTX = 77; // MobileCLIP fixed text context length — pad to this or the graph errors
// Terse labels the NutrientStore resolves to USDA FDC rows via nutrition/label-map.json.
const VOCAB = ["rice", "chicken", "broccoli", "egg", "salmon", "pasta", "potato", "beef", "banana", "apple", "almonds", "bread"];
const TEMPLATES = ["a photo of {}", "a photo of {} on a plate", "a close-up photo of {}", "{}"];
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "food-vocab-embeddings.json");

let transformers;
try {
  transformers = await import("@huggingface/transformers");
} catch {
  console.error("This tool needs transformers.js:\n  npm i -D @huggingface/transformers");
  process.exit(1);
}
const { AutoTokenizer, CLIPTextModelWithProjection } = transformers;

const l2 = (a) => {
  let s = 0;
  for (const v of a) s += v * v;
  s = Math.sqrt(s) || 1;
  return a.map((v) => v / s);
};

const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
const textModel = await CLIPTextModelWithProjection.from_pretrained(MODEL, { dtype: "fp32" });

const vocab = [];
for (const label of VOCAB) {
  const prompts = TEMPLATES.map((t) => t.replace("{}", label));
  const inputs = tokenizer(prompts, { padding: "max_length", max_length: CTX, truncation: true });
  const { text_embeds } = await textModel(inputs);
  const [n, d] = text_embeds.dims;
  const acc = new Array(d).fill(0);
  for (let i = 0; i < n; i++) {
    const row = l2(Array.from(text_embeds.data.slice(i * d, (i + 1) * d)));
    for (let j = 0; j < d; j++) acc[j] += row[j];
  }
  vocab.push({ label, embedding: l2(acc).map((v) => Math.round(v * 1e6) / 1e6) });
}

const doc = {
  _comment:
    "Precomputed MobileCLIP-S0 text embeddings for on-device zero-shot food classification. Regenerate with `npm run build:vocab`. Prompt-ensembled + L2-normalized; cosine-matched against the image embedding on device (packages/pipeline/src/zero-shot.ts).",
  model: MODEL,
  embedding_dim: vocab[0].embedding.length,
  templates: TEMPLATES,
  vocab,
};
await writeFile(OUT, JSON.stringify(doc));
console.log(`wrote ${OUT}: ${vocab.length} labels, dim=${doc.embedding_dim}`);
