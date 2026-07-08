---
tags: [ppe, models, ml]
---

# Segmentation Model

> Finding and outlining the food in the image — the first ML stage. What semantic segmentation is, the two model paths (promptable SAM vs. fine‑tuned SegFormer), why every public food checkpoint is unusable, and how the fine‑tune works. Spec: [[MODELS]] §1. ML basics: [[CS Foundations]] §7.

## What "segmentation" is (and how it differs from classification)

Three related tasks (see [[CS Foundations]] §7):
- **Classification** — one label for the whole image ("this is rice").
- **Segmentation** — a label for **every pixel** ("these pixels are rice, those are chicken").
- **Detection** — boxes around objects.

The pipeline needs **segmentation**, because portioning needs the food's **outline** to measure its area ([[Math 3 - The Plane Homography]]). The `Segmenter` adapter returns a pixel‑space polygon per food region ([[The Pipeline]]).

## Two ways to get the outline

### Path A — promptable SAM (use as‑is)
[SAM 2.1 Tiny](https://huggingface.co/apple/coreml-sam2.1-tiny) ships as an fp16 Core ML package (Apache‑2.0). SAM is *promptable*: you give it a point or box and it segments the object there. The elegant fit here — **the ruler gesture already put the user's finger on the food**, so that same tap becomes the segmentation prompt. Alternatives: MobileSAM (~10 ms on GPU), EfficientSAM. This is the likely iOS route.

### Path B — fine‑tuned SegFormer (the automatic path)
For automatic (no‑tap) segmentation across a food vocabulary, fine‑tune **SegFormer** on [FoodSeg103](https://huggingface.co/datasets/EduardoPacheco/FoodSeg103) (104 classes, 7.1k images, Apache‑2.0). This is the model this repo trains — script `model/train/segformer_foodseg103.py` ([[Training Pipeline]]).

## Why we have to train our own (the verified finding)

**Every public FoodSeg103 checkpoint on Hugging Face scores mIoU ≤ 0.05** — e.g. a popular one measures **0.0104**. That's unusable (near‑random). A competent fine‑tune reaches ~**0.25** (SegFormer‑B0) / ~**0.32** (B1); the server‑class ceiling (FoodSAM) is 46.4. So: *ship none of the public ones, train our own.* ([[MODELS]] §1.) There's also a **license trap**: all Ultralytics‑lineage weights (YOLO‑seg, FastSAM) are AGPL‑3.0 — poison for a closed app.

### What is mIoU?
**Intersection‑over‑Union** for one class = (predicted region ∩ true region) / (predicted ∪ true) — 1.0 is perfect overlap, 0 is none. **mIoU** averages IoU over all classes. It's the standard segmentation metric; the training script computes it every epoch.

## SegFormer in one paragraph (the transformer bit)

Older segmenters were pure CNNs (convolutions, [[CS Foundations]] §7). **SegFormer** uses a **transformer** encoder (the "MiT" backbone, `mit-b0`/`b1`): instead of only looking at local neighborhoods, attention lets every image patch relate to every other patch, capturing long‑range context (useful when a food spans the plate). A lightweight all‑MLP decoder turns the encoder features into a per‑pixel class map. B0 is tiny (**3.7 M params**) — small enough for on‑device. Depth on how attention/CNNs work: [[CS Foundations]] §7.

## How the fine‑tune works (`segformer_foodseg103.py`)

The script (annotated in [[Training Pipeline]]) does, in `main()`:
1. **Data** — stream FoodSeg103 from the Hub; a `SegformerImageProcessor` normalizes images and aligns the 104‑class label maps, applied lazily per batch.
2. **Model** — load the pretrained MiT backbone but attach a **fresh head sized to 104 classes** (`ignore_mismatched_sizes=True` drops the incompatible pretrained head). This is **fine‑tuning**: reuse learned visual features, retrain the output layer for our labels.
3. **Metric** — `mean_iou`. Two memory‑safety helpers (`preprocess_logits_for_metrics`, `compute_metrics`) arg‑max on‑device *before* accumulating predictions, so evaluating over the whole val set doesn't hold 104‑channel logits for thousands of images in RAM and OOM.
4. **Train** — Hugging Face `Trainer`: eval + checkpoint every epoch, keep the best‑by‑mIoU model, fp16 on GPU. Writes `eval_results.json` next to the model so the result survives even if Drive doesn't sync the checkpoint dirs.

Targets: mIoU ≥ 0.25 (B0) / ≥ 0.32 (B1). Runtime ~2–3 h on an H100. Export to Core ML / ExecuTorch for the app happens in notebook 04.

## Classification (the sibling stage)

After segmentation, each crop is **classified** to a food name. The plan ([[MODELS]] §2): **MobileCLIP** zero‑shot — embed each crop, cosine‑match against precomputed text embeddings of the food vocabulary (FoodSeg103 labels + USDA descriptions). Fast (image encoder ~1.5 ms), and the text side is precomputed offline. A small fine‑tuned head can disambiguate cooked‑state (fried vs. steamed), which matters because it drives density ([[Math 4 - Volume Mass and Nutrients]]).

## Related
- [[Mass Regressor Model]] · [[Training Pipeline]] · [[The Pipeline]] · [[Math 3 - The Plane Homography]] · [[CS Foundations]] · [[MODELS]]
