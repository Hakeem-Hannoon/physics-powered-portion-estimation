# Colab notebooks (the GPU runs)

Run in order on a GPU runtime (H100/A100). Each notebook mounts Drive, clones this repo, and writes every artifact — dataset, checkpoints, manifest, priors, exports — to the shared project Drive folder so disconnects lose nothing:

**Project Drive folder (view-only):** https://drive.google.com/drive/folders/1y1hDjkfHsazsOoe4LJjWKoEKj2bHKKjd

| # | Notebook | GPU | Time | Produces |
|---|---|---|---|---|
| 01 | `01_download_nutrition5k.ipynb` | none | ~1 h (bandwidth) | `data/nutrition5k/` — overhead RGB-D + metadata (~15–25 GB; skips 160 GB of unused video) |
| 02 | `02_train_segformer_foodseg103.ipynb` | H100 | 2–6 h | `checkpoints/segformer-*` + the FoodSeg103 mIoU result row |
| 03 | `03_train_mass_regressor.ipynb` | H100 | ~2 h + extraction | `out/n5k-manifest.csv`, `out/priors.json` (→ update `DEFAULT_KAPPA`), `checkpoints/mass-regressor.pt` + MAPE result row |
| 04 | `04_export_coreml.ipynb` | none | minutes | `out/*.mlpackage.zip` for the iOS app |

Notes:

- **Your data persists to Drive, nothing touches a Google Cloud account.** The Nutrition5k download streams from the public bucket over plain HTTPS (no gcloud, no project, no auth). The Nutrition5k dataset and every **output** — checkpoints, manifest, priors, `.mlpackage`s — live under `DRIVE_ROOT`. Framework **caches** (HuggingFace/torch) stay on the VM's local disk on purpose: the datasets library memory-maps its Arrow files and mmap over Drive's FUSE mount fails; the dataset and the small pretrained backbones re-download in seconds on a fresh VM.
- Set `DRIVE_ROOT` in the first cell of each notebook to the mounted path of the project folder in your Drive.
- The notebooks clone the repo over public HTTPS. A private repo needs a token: `git clone https://<TOKEN>@github.com/Hakeem-Hannoon/physics-powered-portion-estimation.git`.
- 01 and the training notebooks are all resumable — rerun after a disconnect and they skip or resume what's already in Drive.
- When 02/03 finish, paste the printed result rows into the root README's **Testing set & results** table.
