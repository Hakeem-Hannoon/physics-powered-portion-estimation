# Mass-Regressor Improvement Ideas (scale-leverage)

Six ways to push the scale-conditioned mass regressor past its first-run
**mass MAPE 24.1% / kcal ~32%** ([[Mass Regressor Model]], STATUS.md §4), all
built around the one asset no public model has: the **user-measured metric
scale**. Ordered by expected payoff ÷ effort.

Companion: `docs/vault/Mass Regressor Model.md` "Improving the model" holds the
*standard* ML-tuning experiments (augmentation, normalization, loss weighting,
backbone) — this doc is the *scale-specific* ideas on top of those.

Status legend: ✅ implemented · 🔬 explained, not code · 📝 noted / deferred.

---

## 1. Physics-anchored residual learning — ✅ implemented

**Idea.** A single horizontal ruler stroke fixes metric **area** almost exactly,
so the model's real job isn't "estimate mass" — it's "correct the shape/density
prior given the pixels." So instead of regressing absolute `log(mass)`, predict a
**correction** to the geometry estimate `m̂ = ρ·V` (`V = φ·A·h` with a measured
height, else `κ·A^{3/2}` — MATH.md §4). The physically-correct A^{3/2} / A·h
scaling is then *guaranteed*, and the residual only has to absorb the
density/shape deviation — a far tighter target than log-mass over two orders of
magnitude, and correct even for portion sizes outside the training range.

**Code.** `physics_log_mass()` + `ScaleConditionedMassRegressor(residual=True)`
in `model/train/mass_regressor_nutrition5k.py`; anchor priors read from
`model/priors/priors.json`. Default **on**; `--no-residual` to ablate. Head is
near-zero at init, so training *starts* at the physics estimate.

**Watch for.** The reference density is a constant (~water); the residual absorbs
true per-food density, so this mostly helps once per-class density is *not*
available — pairs naturally with #4. Verify the residual distribution is actually
tighter than raw log-mass (log it during training).

## 2. Train/test scale-source parity (noise injection) — ✅ implemented

**Idea.** Nutrition5k's scale is depth-**clean**; production scale is the VIO
**ruler** (~2–4%, and area ∝ scale² ⇒ ~4–8% on area, ~cubic on mass). Training on
clean scale and inferring on noisy scale is a silent train/test gap. Fix: on a
fraction of train examples, draw one global scale error `s`, apply `s²` to area
and `s` to height (a single world-scale error hits both), add independent height
jitter, and **relabel the source one-hot to "ruler"** so the model learns each
source's noise band instead of tying clean features to a fixed one-hot. Only
inputs are perturbed — targets stay ground truth.

**Code.** `MealRegionDataset(scale_noise, ruler_prob, height_noise)` in the same
file. Defaults `--scale-noise 0.03 --ruler-prob 0.5 --height-noise 0.05`;
`--scale-noise 0` to ablate.

## 3. Elicit a second (vertical) height stroke — 📝 noted, deferred (per user)

**Idea.** With one horizontal stroke, height is a class prior — the **dominant**
error term (MATH.md §8: height/shape ~25% → ~8% *once a height is measured*). A
2-second vertical stroke up the food, which the payload + model already support
(`has_height`, `height_m`), is the single biggest accuracy jump available. It's a
capture-UX/coaching change more than a model change.

**Status.** Deferred by preference for now — kept here so it isn't lost. If
revisited, it's mostly a coaching nudge in the capture module + making sure the
`height_noise` term (#2) reflects real vertical-stroke error.

## 4. Per-class priors (κ, φ, ρ, h̄) — 📝 noted; needs per-class labels

**Idea.** κ, φ, ρ, h̄ are global constants today (`priors.json._global`:
κ=0.1687, φ=0.446, h̄=0.098 m). **Density especially** is where a wrong/averaged
value bites, and per-class error is *systematic* — it does not average out across
identical items the way random error does. Fitting priors **per food class** and
conditioning the anchor (#1) on the predicted class removes that bias.

**Training cost — small, but gated on labels, not GPU.** The priors themselves
are a **least-squares / ratio fit, seconds of CPU** (see `model/priors/` +
`fit_priors.py`) — no GPU, no retraining of the network to *produce* them. The
real cost is the **per-class labels**: Nutrition5k ships per-dish totals, not
per-ingredient masses/areas, so you need a per-region label to bin by class.
Options, cheapest first: (a) fit priors only for the subset of **single-food
dishes** (clean class↔mass), a data-filtering pass, no new labels; (b) use
Nutrition5k's ingredient metadata where present to attribute mass; (c) run the
segmenter+classifier to auto-label regions and fit priors per predicted class
(noisy but scalable). Then **one regressor retrain** (~1–2 h H100) to condition
on the per-class anchor. So: prior fit = seconds; the work is assembling
per-class (area, height, mass) rows; then a single normal training run.

## 5. Higher-res, metric-rectified crop — 🔬 explained (enabled by the capture work)

**Not a new dataset.** "Metric-rectified crop" = the *existing* input to the
regressor, just better. Two independent parts:

- **Rectified** — the crop is warped through the plane homography (MATH.md §3.1)
  into a top-down, metric view before the CNN sees it, so a given food occupies a
  consistent shape regardless of camera angle. Already the intended preprocessing.
- **Higher-res** — the crop is only as good as the image it's cut from. That's
  exactly what the `CAPTURE_QUALITY.md` **R1/R2** work just fixed: Android was
  handing the pipeline a ~640×480 frame (R1 → full-res config), iOS a video frame
  (R2 → 12 MP still). A 5 cm garnish that was ~70 px across is now ~200–440 px —
  more texture for the model to read density/shape from. **No new data**, no
  retrain required to benefit; the model simply gets sharper crops at inference.

**To exploit on the training side:** make the manifest's training crops match —
render the rectified crop at a resolution consistent with what the phone now
produces, and (optionally) bump `--image-size` above 256 if the extra detail
helps (test it; more pixels ≠ free if the backbone bottlenecks). This is the
training-time twin of the capture change.

## 6. Standard ML tuning — ✅ top three implemented (run 2)

The three highest-payoff levers are now in `mass_regressor_nutrition5k.py`, each
default-on and each ablatable back to the run-1 configuration:

- **Augmentation** (`--aug`): mild random-resized-crop, overhead-safe vertical
  flip, photometric jitter — pixels only, `cond`/targets untouched.
- **Input normalization** (`--input-norm`): ImageNet pixel norm **plus**
  train-split standardization of log(area)/height, stored as model buffers so
  every export carries its own preprocessing (the app still feeds [0,1] pixels
  and raw physical units).
- **Loss weighting** (`--mass-weight 2 --kcal-weight 1`): mass is the shipped
  metric, since production is *mass → classify → USDA kcal/g*.

The script also prints a **geometry-only baseline** (the anchor scored alone on
the test split) before training — the honest "what does the CNN add?" number
and a one-line manifest audit. Still open from the standard set: backbone /
schedule sweeps, deeper regularization, `--image-size` (the #5 knob, now a
flag). Full rationale: `docs/vault/Mass Regressor Model.md` → "Improving the
model."

---

## Verification status

The #1/#2 code is **smoke-verified end-to-end** (torch CPU, stubbed backbone,
synthetic data — 23 checks): the physics anchor returns sane grams, the residual
identity `out_mass = anchor + head_residual` holds, `--no-residual` bypasses it,
the scale-noise path relabels `"ruler"` and perturbs area while leaving the
no-noise path clean, and a full forward→loss→backward→checkpoint round-trips.
The run-2 levers (§6) got the same treatment — **32 checks**: augmentation
leaves `cond`/targets untouched, the anchor reads *raw* units while FiLM sees
standardized ones, run-1 checkpoints still load (identity normalization), the
2:1 loss blend matches a hand computation, a 2-epoch `main()` trains and saves a
self-describing checkpoint, and the ONNX export (`export/export_onnx.py`)
matches torch to 1e-4 under onnxruntime. So a GPU run won't fail on a
shape/logic bug. The **accuracy** result (does run 2 beat 24.1%) still needs the
real Nutrition5k training run — that's yours to kick off (notebook 03); record
the number in `MODELS_REGISTRY.md` Stage 4.

## Running the A/B

```bash
# New default — both scale-leverage techniques on:
python model/train/mass_regressor_nutrition5k.py --manifest out/n5k-manifest.csv

# Reproduce the 24.1% baseline (both off):
python model/train/mass_regressor_nutrition5k.py --manifest out/n5k-manifest.csv \
  --no-residual --scale-noise 0

# Isolate one lever at a time (change ONE thing, record mass MAPE):
#   --no-residual                 # technique #1 off, #2 on
#   --scale-noise 0               # technique #2 off, #1 on
```

Primary metric stays **mass MAPE** on the held-out split; kcal MAPE is secondary
(production derives calories from mass). Record each run in the Mass Regressor
note's results table.
