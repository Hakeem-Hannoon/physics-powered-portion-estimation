# ppe-demo

Minimal Expo app exercising the **full end-to-end stack** on a real device:
`expo-portion-capture` (AR ruler) → segment → classify → weigh → nutrition, all
on-device. Capture a meal and it **predicts the food and its weight** — no picker.

**What's real** (adapter details + model wiring: [`docs/REAL_ADAPTERS.md`](../../docs/REAL_ADAPTERS.md)):

- **Segmentation** — **real.** SlimSAM (a SAM-2.1-tiny-class promptable model),
  point-prompted at the frame center, via `onnxruntime-react-native`.
- **Classification** — **real.** MobileCLIP-S0 zero-shot: the on-device image
  encoder embeds the food crop and cosine-matches the precomputed food-vocabulary
  text embeddings (`assets/food-vocab-embeddings.json`). Validated 6/6 top-1 on
  real photos. Tap a chip to correct the label (propose→confirm).
- **Geometry** — real. Ruler → homography → area → volume → mass (MATH.md).
- **Nutrition** — **real USDA data** via `ExpoSqliteNutrientStore`, reading the
  bundled `assets/nutrients.sqlite` (12 common foods; rebuild with
  `npm run build:nutrients`, or the full FDC bundle via `npm run etl:bundle`).

This app lives outside the npm workspaces so the root install stays light; it
links the packages by `file:` path.

```bash
cd apps/demo
npm install
npm run build:models          # fetch the on-device ONNX weights (~80 MB, gitignored)
npx expo install --fix        # aligns expo/react-native versions with the SDK
npx expo run:android          # or run:ios — a development build on a physical device
```

ARKit/ARCore need real hardware — the simulator and Expo Go report "unsupported".
The models (and the SQLite DB) bundle at build time, so adding them is a **native
rebuild** (`expo run:*`), not a hot reload. The on-device runtime is
`onnxruntime-react-native` (one ONNX per model, iOS + Android); if segmentation
can't run it falls back to a centered square so classification + weight still work.

**P1/P2 validation drill:** cook and weigh a portion, capture with a ≥10 cm ruler
stroke across the plate, and compare the app's predicted grams against the scale
(protocol + pass bars in `docs/ARCHITECTURE.md` §4). Confirm the predicted label
looks right (correct it with a chip if not — the weight is unaffected). Add a
**vertical** stroke up the food to switch to the measured-height route and watch
the error band tighten from ~31% to ~20%. First launch loads ~80 MB of models —
give it a few seconds before the capture button enables.
