# model/

Training, export, and prior fitting. The full model landscape with verified IDs, licenses, and sizes lives in [`../docs/MODELS.md`](../docs/MODELS.md).

## Scripts

| Script | What it does | Where it runs |
|---|---|---|
| `train/segformer_foodseg103.py` | Fine-tunes SegFormer-B0/B1 on FoodSeg103 (the on-device segmenter) | **H100** — B0 ~2–3 h, B1 ~4–6 h |
| `data/prepare_nutrition5k.py` | Nutrition5k RGB-D → manifest of (area, height, volume, mass, kcal) per dish | GPU box for disk/bandwidth (181 GB download); CPU-bound |
| `train/mass_regressor_nutrition5k.py` | The scale-conditioned mass regressor (P3) — CNN backbone + FiLM physics conditioning | **H100** — ~1–2 h at batch 128 |
| `priors/fit_priors.py` | Fits κ / φ / h̄ per class from the manifest (MATH.md §4) | laptop, seconds |
| `export/export_coreml.py` | Checkpoints → fp16 `.mlpackage` for iOS | laptop (macOS for verification) |

## Colab

Ready-to-run notebooks for every GPU step live in [`colab/`](colab/) — they mount Drive, clone this repo, and persist their **outputs** (checkpoints, manifest, priors, exports) to the shared project Drive folder ([view-only](https://drive.google.com/drive/folders/1y1hDjkfHsazsOoe4LJjWKoEKj2bHKKjd)). The raw Nutrition5k dataset stages to the VM's local disk instead — Drive's FUSE mount aborts (`Errno 103`) on the thousands of per-dish RGB-D reads.

## Cloud (H100) run order

1. `pip install -r requirements.txt`
2. `gsutil -m cp -r gs://nutrition5k_dataset/... data/n5k/` — needs ~200 GB free disk
3. Job 1: `python train/segformer_foodseg103.py --model nvidia/mit-b0 --epochs 60 --batch-size 32`
   — target: mIoU ≥ 0.25 (B0) / 0.32 (B1); every public checkpoint measures ≤ 0.05
4. `python data/prepare_nutrition5k.py --root data/n5k --out out/n5k-manifest.csv`
5. `python priors/fit_priors.py --manifest out/n5k-manifest.csv` → update `DEFAULT_KAPPA` in `@ppe/pipeline` and the `shape_priors` table in `nutrition/`
6. Job 2: `python train/mass_regressor_nutrition5k.py --manifest out/n5k-manifest.csv`
   — benchmarks to beat: 26.1% calorie MAPE (RGB), 16.5% (RGB+depth)
7. `python export/export_coreml.py …` for both artifacts, then record results in the root README's Results table

Models used as-is (already converted by Apple, no training needed): `apple/coreml-sam2.1-tiny` (promptable segmentation), `apple/coreml-mobileclip` (zero-shot classification), `apple/coreml-depth-anything-v2-small` (relative depth fallback, rescaled by the ruler).
