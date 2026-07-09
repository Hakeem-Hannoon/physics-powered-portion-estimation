# ppe-demo

Minimal Expo app exercising the full stack on a real device: `expo-portion-capture`
(AR ruler) → `@ppe/pipeline` (geometry + nutrients).

**What's real vs. placeholder** (adapter details + how to enable the models:
[`docs/REAL_ADAPTERS.md`](../../docs/REAL_ADAPTERS.md)):

- **Geometry** — real. Ruler → homography → area → volume → mass (MATH.md).
- **Nutrition** — **real USDA data** via `ExpoSqliteNutrientStore`, reading the
  bundled `assets/nutrients.sqlite` (12 common foods; rebuild with
  `npm run build:nutrients`, or the full FDC bundle via `npm run etl:bundle`).
- **Classification** — interim: **pick the food** with the chip row (real nutrition
  for the confirmed label). The real MobileCLIP zero-shot classifier's matching
  logic is tested (`@ppe/pipeline` `ZeroShotClassifier`); its on-device image
  encoder is device+model-pending.
- **Segmentation** — placeholder centered square (real metric geometry on top),
  until the SAM/SegFormer model is exported (`MaskSegmenter` scaffold is ready).

This app lives outside the npm workspaces so the root install stays light; it
links the packages by `file:` path.

```bash
cd apps/demo
npm install
npx expo install --fix        # aligns expo/react-native versions with the SDK
npx expo run:android          # or run:ios — a development build on a physical device
```

ARKit/ARCore need real hardware — the simulator and Expo Go report "unsupported".
Adding the SQLite database is a **native rebuild** (`expo run:*`), not a hot reload.

**P1 validation drill:** pick the food, cook and weigh a portion, capture with a
≥10 cm ruler stroke across the plate, and compare the app's grams against the
scale (protocol + pass bars in `docs/ARCHITECTURE.md` §4). Add a **vertical**
stroke up the food to switch to the measured-height route and watch the error
band tighten from ~31% to ~20%.
