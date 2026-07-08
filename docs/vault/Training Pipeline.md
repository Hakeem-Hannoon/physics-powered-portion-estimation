---
tags: [ppe, data, training, ml]
---

# Training Pipeline

> How the models get trained: four Colab notebooks, the scripts they run, and the one storage rule that keeps Google Drive from breaking everything. Code: `model/`. Notebook docs: `model/colab/README.md`.

## The pieces

`model/` holds the training‑time code (none of it ships in the app — it produces the model files the app loads):

| Path | Role | Vault note |
|---|---|---|
| `data/prepare_nutrition5k.py` | RGB‑D dishes → geometry manifest CSV | [[Shape Priors and Nutrition5k]] |
| `priors/fit_priors.py` | manifest → κ/φ/h̄ `priors.json` | [[Shape Priors and Nutrition5k]] |
| `train/segformer_foodseg103.py` | fine‑tune the food segmenter | [[Segmentation Model]] |
| `train/mass_regressor_nutrition5k.py` | train the scale‑conditioned mass regressor | [[Mass Regressor Model]] |
| `export/export_coreml.py` | export trained models to Core ML / ExecuTorch | — |
| `colab/01–04*.ipynb` | GPU runbooks that orchestrate the above | this note |

## The four notebooks (run in order on a GPU runtime)

| # | Notebook | GPU | Produces |
|---|---|---|---|
| 01 | `01_download_nutrition5k` | none | *(optional)* a persistent raw Nutrition5k archive on Drive |
| 02 | `02_train_segformer_foodseg103` | H100 | the FoodSeg103 segmenter checkpoint + mIoU |
| 03 | `03_train_mass_regressor` | H100 | the manifest, `priors.json`, and the mass‑regressor checkpoint + MAPE |
| 04 | `04_export_coreml` | none | `.mlpackage`s for the app |

Notebook **03** is the self‑contained pipeline: **stage dataset → extract manifest → fit priors → train regressor**. Its three script steps are exactly [[Shape Priors and Nutrition5k]] (steps 1–2) and [[Mass Regressor Model]] (step 3).

## The storage rule (Drive vs. local disk) — read this

Colab mounts Google **Drive** for persistence across disconnects, but Drive's FUSE mount **aborts (`Errno 103`, `ECONNABORTED`) on many‑small‑file workloads** — and Nutrition5k is ~5,000 per‑dish folders, each read twice by the manifest extraction and again *every training epoch*. So the rule is:

> **Big files on Drive; many‑small‑files on local disk.**

Concretely: the raw dataset **stages to the VM's local disk** (`/content/n5k`) from the public GCS bucket over plain HTTPS (a resumable, `.part`‑atomic downloader — [[CS Foundations]] §8). Framework caches (HuggingFace/torch) are local too (Drive's FUSE also breaks `mmap`). Only the **outputs** — checkpoints, manifest, priors, `.mlpackage`s — persist to Drive. Notebook 01's Drive download is therefore *optional/archival*; a Drive→local bulk copy of loose files would hit the same abort, so 03 re‑syncs from the bucket.

Consequence to remember: the manifest bakes in the local `/content/n5k/...` image paths, so a fresh session must **re‑stage before re‑training**.

## Reproducing (the short version)

1. Open a notebook in Colab on an **A100/H100** runtime. (Private‑repo clone needs a `GH_TOKEN` Colab secret; public repo needs nothing.)
2. **Notebook 02** → fine‑tune SegFormer; paste the printed mIoU into the README results table.
3. **Notebook 03** → stages Nutrition5k locally, extracts the manifest, fits `priors.json` (its global κ replaces `DEFAULT_KAPPA` in [[The Pipeline]]), trains the regressor; paste the MAPE.
4. **Notebook 04** → export to Core ML / ExecuTorch for the app.

The scripts are all resumable and heavily commented (block‑level overviews + step comments) so each step is legible on its own. The download avoids any Google Cloud account — it streams from the public bucket. See `model/colab/README.md` for the full runbook.

## What comes out
- A **segmenter** checkpoint (→ [[Segmentation Model]], wired via the `Segmenter` adapter).
- `priors.json` (→ [[Shape Priors and Nutrition5k]], wired into [[The Pipeline]] and [[Nutrition Database]]).
- A **mass‑regressor** checkpoint (→ [[Mass Regressor Model]], the v2 fallback).
- Exported model files for on‑device inference ([[HARDWARE]] compute budget).

## Related
- [[Shape Priors and Nutrition5k]] · [[Segmentation Model]] · [[Mass Regressor Model]] · [[The Pipeline]] · [[MODELS]] · [[HARDWARE]]
