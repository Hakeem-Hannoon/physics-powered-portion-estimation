# Colab notebooks (the GPU runs)

Run in order on a GPU runtime (H100/A100). Each notebook mounts Drive, clones this repo, and writes its **outputs** — checkpoints, manifest, priors, exports — to the shared project Drive folder so disconnects lose nothing. The raw Nutrition5k dataset is the exception: it stages to the VM's **local disk**, because the per-dish RGB-D reads abort over Drive's FUSE mount (see the storage note below).

**Project Drive folder (view-only):** https://drive.google.com/drive/folders/1y1hDjkfHsazsOoe4LJjWKoEKj2bHKKjd

| # | Notebook | GPU | Time | Produces |
|---|---|---|---|---|
| 01 | `01_download_nutrition5k.ipynb` | none | ~1 h (bandwidth) | **Optional** — a persistent raw archive on Drive (~15–25 GB; skips 160 GB of unused video). 03 stages its own local copy, so skip this unless you want the archive |
| 02 | `02_train_segformer_foodseg103.ipynb` | H100 | 2–6 h | `checkpoints/segformer-*` + the FoodSeg103 mIoU result row |
| 03 | `03_train_mass_regressor.ipynb` | H100 | ~2 h + staging + extraction | stages Nutrition5k to local disk, then `out/n5k-manifest.csv`, `out/priors.json` (→ update `DEFAULT_KAPPA`), `checkpoints/mass-regressor.pt` + MAPE result row, `out/mass-regressor.onnx` for the demo app |
| 04 | `04_export_coreml.ipynb` | none | minutes | `out/*.mlpackage.zip` for the iOS app |

Notes:

- **Storage — big files on Drive, many-small-files on local disk.** Drive's FUSE mount streams a handful of large files fine but aborts (`Errno 103`, `ECONNABORTED`) when a job lists and reads thousands of tiny files — exactly what the ~5k per-dish Nutrition5k RGB-D folders are, hit by both the manifest extraction and every training epoch. So the raw dataset stages to the VM's **local disk** (`/content/n5k`); mmap over FUSE fails for the same reason, so the HuggingFace/torch **caches** are local too. Only the **outputs** — checkpoints, manifest, priors, `.mlpackage`s — persist under `DRIVE_ROOT`. Every download streams from the public bucket over plain HTTPS (no gcloud, no project, no auth), so re-staging a fresh VM's local disk takes minutes.
- Set `DRIVE_ROOT` in the first cell of each notebook to the mounted path of the project folder in your Drive.
- **This repo is private, so the clone needs auth.** Add a GitHub token once as a Colab secret named `GH_TOKEN` (🔑 in the left sidebar → "Add new secret" → paste a PAT with `repo` scope → enable notebook access). The clone cells read it automatically and redact it from any output. If you make the repo public instead, no token is needed and the cells still work. The clone now fails **loud** with a clear message if it can't fetch the code — no more silent failure that looks like a training bug.
- **Runtime:** use an A100/H100. Notebook 02 auto-shrinks the batch on a small GPU (T4) so it won't OOM, but a T4 is many hours vs ~2–3 h on an H100.
- Every notebook is resumable — rerun after a disconnect and it skips or resumes what's already there: 03's dataset staging skips files already on local disk, and outputs skip what's already in Drive.
- When 02/03 finish, paste the printed result rows into the root README's **Testing set & results** table.
