/**
 * Fetch the on-device model weights into apps/demo/assets/models/. The .onnx
 * files are gitignored (tens of MB each) and re-fetched deterministically here,
 * the same way the SQLite bundle is built by a script rather than committed.
 * Dependency-free (Node's global fetch). Run: `npm run build:models`.
 *
 * Sources — the ready ONNX exports the pipeline was validated against:
 *   • MobileCLIP-S0 image encoder (classification) — Xenova/mobileclip_s0
 *   • SlimSAM-77 vision encoder + mask decoder (segmentation) — Xenova/slimsam-77-uniform
 */
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "models");
const HF = "https://huggingface.co";

const MODELS = [
  {
    file: "mobileclip_s0_vision.onnx",
    url: `${HF}/Xenova/mobileclip_s0/resolve/main/onnx/vision_model.onnx`,
    minBytes: 40_000_000,
  },
  {
    file: "slimsam_vision_encoder.onnx",
    url: `${HF}/Xenova/slimsam-77-uniform/resolve/main/onnx/vision_encoder.onnx`,
    minBytes: 20_000_000,
  },
  {
    file: "slimsam_decoder.onnx",
    url: `${HF}/Xenova/slimsam-77-uniform/resolve/main/onnx/prompt_encoder_mask_decoder.onnx`,
    minBytes: 15_000_000,
  },
];

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

async function present(path, minBytes) {
  try {
    return (await stat(path)).size >= minBytes;
  } catch {
    return false;
  }
}

await mkdir(OUT_DIR, { recursive: true });
for (const m of MODELS) {
  const path = join(OUT_DIR, m.file);
  if (await present(path, m.minBytes)) {
    console.log(`✓ ${m.file} (already present)`);
    continue;
  }
  process.stdout.write(`↓ ${m.file} … `);
  const res = await fetch(m.url);
  if (!res.ok) throw new Error(`fetch ${m.url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < m.minBytes) {
    throw new Error(`${m.file}: got ${mb(buf.byteLength)}, expected ≥ ${mb(m.minBytes)}`);
  }
  await writeFile(path, buf);
  console.log(mb(buf.byteLength));
}
console.log(`\nModels ready in ${OUT_DIR}. Rebuild the dev client to bundle them.`);
