# ppe-demo

Minimal Expo app exercising the **full end-to-end stack** on a real device:
`expo-portion-capture` (AR ruler) → segment → classify → weigh → nutrition, all
on-device. Capture a meal and it **predicts every ingredient and its weight** —
no picker.

**What's real** (adapter details + model wiring: [`docs/REAL_ADAPTERS.md`](../../docs/REAL_ADAPTERS.md)):

- **Segmentation** — **real.** SlimSAM (a SAM-2.1-tiny-class promptable model)
  in "segment everything" mode via `onnxruntime-react-native`: the frame is
  encoded once, the mask decoder is swept over a grid of points, and overlapping
  masks are deduped into **one region per ingredient**. Capture a mixed plate and
  it weighs each food separately.
- **Classification** — **real.** MobileCLIP-S0 zero-shot over a **58-food
  FoodSeg103 vocabulary** (carrot, shrimp, tomato, cheese…, not just 12 words):
  the on-device image encoder embeds the food crop and cosine-matches the
  precomputed text embeddings (`assets/food-vocab-embeddings.json`). Validated
  12/12 top-1 on held-out photos of newly-added foods. Tap a chip to correct the
  label (propose→confirm) — the chips cover the whole vocabulary.
- **Geometry** — real. Ruler → homography → area → volume → mass (MATH.md).
- **Nutrition** — **real USDA data** via `ExpoSqliteNutrientStore`, reading the
  bundled `assets/nutrients.sqlite`: the **full generic-food FDC database**
  (~13.7k foods) with the curated 58-food set overlaid so the classifier's
  labels keep their hand-checked rows. Rebuild with
  `npm run build:nutrients:full -- <fdc-csv-dir>` (or the curated set alone via
  `npm run build:nutrients`).

This app lives outside the npm workspaces so the root install stays light; it
links the packages by `file:` path.

```bash
cd apps/demo
npm install
npm run build:models          # fetch the on-device ONNX weights (~80 MB, gitignored)
npx expo install --fix        # aligns expo/react-native versions with the SDK
npx expo run:android          # or run:ios — a development build on a physical device
```

**iOS native wiring, two non-obvious bits:**

- The capture module lives at the *repo root* (`modules/expo-portion-capture`),
  not in this app's `modules/`, so Expo autolinking is pointed at it via
  `expo.autolinking.nativeModulesDir` in `package.json`. Without that, the pod
  is silently skipped and the app throws `Cannot find native module
  'ExpoPortionCapture'` at launch.
- The module's podspec requires iOS 16, so the app's deployment target is
  raised to 16.0 via `expo-build-properties` in `app.json` (autolinking
  silently drops any module whose podspec doesn't support the target's
  platform version — no build error, just a missing module at runtime).

**Xcode 26+:** the fmt 11.x pod that RN 0.79 vendors doesn't compile under
Xcode 26's stricter clang (`consteval … is not a constant expression` in
`fmt/format-inl.h`). `plugins/with-fmt-xcode26-fix.js` patches the generated
Podfile to build just the fmt pod as C++17, which sidesteps it. The plugin runs
at prebuild — if you hit the error with an `ios/` generated before the plugin
existed, `rm -rf ios` and rebuild.

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
