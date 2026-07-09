# Image Capture Quality — Findings & Recommendations

An audit of what the capture module actually hands the pipeline — image, depth,
and shutter-moment geometry — and the highest-leverage ways to improve it.
Written 2026-07-08 against the current `modules/expo-portion-capture` code.

Companion docs: [`MATH.md`](MATH.md) (error budget §8, stabilization §2.4,
pitfalls §9) · [`ARCHITECTURE.md`](ARCHITECTURE.md) (payload contract) ·
[`HARDWARE.md`](HARDWARE.md) (sensors) · [`STATUS.md`](STATUS.md) (roadmap).

> **Status — 2026-07-08:** R1–R9 are all **implemented in code** (both native
> modules + the optional `capture_quality` contract field), passing typecheck
> and the 46-test suite. They are **not yet device-validated** — that happens in
> the P0/P1 drills, which now double as the capture-quality baseline. The §2
> table below is the *pre-change* state; the "✅ implemented" note on each
> recommendation records what shipped. iOS R5 keeps the tap-drag interaction and
> adds the §2.4 stabilization statistics per-frame — the full reticle +
> plate-trackpad redesign remains STATUS.md §5 item 2.

---

## 1. Where capture quality enters the error budget

MATH.md §8 splits per-item mass error into scale, segmentation-area, height/
shape, and density terms. Capture quality feeds the first two directly:

- **Image resolution & sharpness → the segmentation-area term (~8%).**
  Boundary error in *pixels* converts to area error through the meters-per-
  pixel of the stored image. At 40 cm with a ~60° HFOV, one pixel spans
  ≈ 0.72 mm at 640 px width, 0.24 mm at 1920 px, 0.11 mm at 4032 px. A ±2 px
  boundary fuzz on a 10 cm item is ~±5.6% area at 640 px — most of the entire
  budgeted term — vs ~±2% at 1920 px. Resolution also bounds classifier crop
  quality (a 5 cm garnish at 40 cm is ~70 px across at 640, ~210 px at 1920,
  ~440 px at 12 MP) and the texture the mass regressor sees.
- **Anchor stabilization → the scale term (enters area *squared*).**
  §2.4 exists because ±5 mm endpoints on a 20 cm stroke are already 2.5%
  scale → 5% area. This stack is implemented on Android, absent on iOS.
- **Payload completeness → the tier ladder (§7).** A capture that drops depth
  it could have had demotes the whole estimate a tier (~20% → ~15–20% band).

So "better capture quality" means three concrete things: more (sharp) pixels,
steadier anchors, and a payload that carries everything the hardware measured.

## 2. Current state (code-verified)

| Dimension | Android (Kotlin/ARCore) | iOS (Swift/ARKit) |
|---|---|---|
| Image source | `frame.acquireCameraImage()` CPU stream — **default camera config; no `CameraConfig` selection** (`ARCaptureActivity.kt:214-228, 560`) | `frame.capturedImage` video frame, typically 1920×1440 (`ARCaptureViewController.swift:244`) |
| Typical stored size | **640×480 on many devices** (ARCore default CPU image) | 1920×1440 |
| Encode | JPEG q92 from NV21 (`:639-668`) | HEIC, **no explicit quality** → OS-default lossy (`:310-324`); JPEG fallback also unspecified |
| Depth in payload | **Always `null`** even with `DepthMode.AUTOMATIC` on (`:630`) | `smoothedSceneDepth ?? sceneDepth`, f32 + confidence + rescaled K ✅ (`:272-279, 328-362`) |
| §2.4 stabilization | ✅ full stack (median buffer, shake gate, plane snap) | ❌ none — raw per-event raycasts |
| Interaction | ✅ reticle + plate-trackpad (finger never covers food) | tap-drag (finger covers food) |
| Shutter gating | `TrackingState.TRACKING` only | `.normal` tracking only |
| Low-light aid | none (no torch, no lux hint) | none |
| Distance/tilt coaching | too-far warning > 1.5 m ✅; no tilt hint | none |
| `tracking.state` field | hardcoded `"normal"` | hardcoded `"normal"` |

(The interaction/stabilization gap is already STATUS.md §5 item 2 — "iOS
capture parity." The items below either ride along with that rework or are
independent of it.)

---

## 3. Recommendations

Ordered by impact ÷ effort. **R1 and R2 are the headline items** — each is the
"more pixels" fix for its platform, and each also future-proofs the P1/P2
drills (segmentation quality is about to matter much more than it did with the
placeholder segmenter).

### R1 — Android: select a high-resolution camera config (biggest win, small effort) · ✅ implemented

`ensureSession()` never chooses a `CameraConfig`, so `acquireCameraImage()`
returns the CPU image of ARCore's *default* config — 640×480 on many devices
(0.3 MP; the GPU preview looks sharp, which hides this). The stored JPEG, the
segmentation input, and every pixel→meter conversion inherit it.

Fix at session creation, before the first `resume()`:

```kotlin
val filter = CameraConfigFilter(created)
  .setFacingDirection(CameraConfig.FacingDirection.BACK)
val configs = created.getSupportedCameraConfigs(filter)
// Largest CPU image area, tie-broken toward 30fps and depth-sensor use.
created.cameraConfig = configs.maxByOrNull {
  it.imageSize.width.toLong() * it.imageSize.height
} ?: created.cameraConfig
```

- `camera.imageIntrinsics` automatically corresponds to the chosen CPU image
  size, so the payload stays consistent with zero further changes (that
  invariant deserves a unit/assert anyway: `image_size` vs intrinsics `cx·2`).
- Typical result: 1920×1440 (2.76 MP, 9× the pixels). JPEG grows to roughly
  0.6–1.2 MB at q92 — inside HARDWARE.md's 2–4 MB payload budget.
- Keep the depth check honest: on depth-capable devices prefer a config whose
  `depthSensorUsage` doesn't disable depth (filter, then max-area).
- Perf ride-along: the per-pixel NV21 loop is ~4M JNI `get()` calls at 2.76 MP.
  Bulk-copy rows when `pixelStride == 1` (Y plane always; U/V via one
  interleaved buffer read when `pixelStride == 2`) to keep shutter latency flat.

### R2 — iOS: capture a 12 MP still at the shutter (ARKit 6) · ✅ implemented

The frozen frame is a *video* frame. ARKit 6 (iOS 16+, which the podspec
already pins) provides an out-of-band full-photo capture **without
interrupting the session**:

```swift
// At session start:
if let fmt = ARWorldTrackingConfiguration.recommendedVideoFormatForHighResolutionFrameCapturing {
  config.videoFormat = fmt
}
// At shutter, replacing the currentFrame grab:
session.captureHighResolutionFrame { hiFrame, error in
  let frame = hiFrame ?? sceneView.session.currentFrame  // graceful fallback
  // build payload from `frame`
}
```

Rules that keep the math intact:

- **Use the returned frame's own `camera.intrinsics`, `camera.transform`, and
  `capturedImage` together.** The 12 MP still (4032×3024) has different K than
  the video stream; mixing them is exactly the §9.1 silent-corruption pitfall.
  Ruler anchors are world-fixed, so strokes need no adjustment (§9.7).
- **Depth can lag the still by a frame.** If the hi-res `ARFrame` carries no
  `sceneDepth`, take depth from the latest video frame — the contract already
  stores depth with its *own* intrinsics block, so mixed sources stay correct.
- **Do NOT chase the 4K video format instead** (`recommendedVideoFormatFor4KResolution`).
  It's 16:9 — it crops vertical FOV relative to the 4:3 sensor and the 4:3
  LiDAR depth map, for a fraction of the still's pixels. The 12 MP still stays
  full-FOV 4:3, so the existing linear depth-intrinsics rescale keeps holding.
- Payload cost: ~2–3.5 MB HEIC — the top of HARDWARE.md's budget; if that
  matters for Spotter transport later, a 2016×1512 half-scale export with
  rescaled K (§9.1) still doubles today's linear resolution.
- Sharpness bonus: the still is taken through the full photo pipeline
  (denoise/sharpen), noticeably better in dim kitchens than a video frame.

### R3 — Android: serialize the depth it already measures · ✅ implemented

`depthMode = AUTOMATIC` is configured, then `"depth" to null` is written —
depth-capable Androids are permanently demoted to the ruler tier.
`frame.acquireDepthImage16Bits()` → convert to the contract's f32-meters
sidecar (DEPTH16 is uint16 *millimeters*; Android's format spec reserves the
top 3 bits for confidence — mask and verify what ARCore writes there, pin it
with a test). Confidence: the Raw Depth API
(`acquireRawDepthImage16Bits` + `acquireRawDepthConfidenceImage`, Y8 0–255)
maps onto the contract's `confidence` slot; full depth alone leaves it `null`.
Registration caveat: depth aligns with the camera image aspect, but write the
depth block's intrinsics from the depth resolution exactly as iOS does
(`writeDepth`), not by assuming equal aspect — `Frame.transformCoordinates2d`
is the ground truth if a mismatch appears. Upgrades `scale_source` to depth
tier (§7: ~2–4% scale → ~1–2%) and unlocks the §4a height-field volume route
on Android.

### R4 — iOS: pin the encode quality (trivial) · ✅ implemented

`writeHEIFRepresentation` / `writeJPEGRepresentation` are called without a
quality option, so lossy quality floats with OS defaults across devices and
versions. Pass an explicit `options: [.lossyCompressionQuality: 0.90]` (JPEG
fallback too, and Android is already explicit at 92). Determinism matters
here: a silent OS-default change would shift segmentation-boundary behavior
between builds. While in that function: `CIContext` is recreated per capture —
harmless today, worth hoisting when R2 lands (12 MP encode).

### R5 — iOS: port the §2.4 stabilization + coaching (already roadmap #2 — this is the capture-quality half) · ✅ implemented (stats only; full UI redesign still pending)

The scale term is the squared one, and iOS currently commits raw
single-raycast endpoints at the two worst moments (finger press/lift). The
Kotlin constants to port verbatim: `STEADY_WINDOW=6`, `SHAKE_LINEAR_M_S=1.0`,
`SHAKE_ANGULAR_RAD_S=1.5`, `PLANE_SNAP_M=0.008` — plus the too-far (>1.5 m)
warning, which iOS also lacks. Add the tilt cue on both platforms while in
here: hint when the view is more than ~45° off plane-normal ("shoot more
top-down") — §3 makes grazing angles pay in homography conditioning, and §3.2
off-plane bias grows with obliquity.

### R6 — Both: gate the shutter on motion blur, not just tracking state · ✅ implemented

Tracking `.normal`/`TRACKING` says VIO is healthy — not that the frozen frame
is sharp. Blur in pixels ≈ ω · t_exp · fx: at a mundane 10°/s hand adjustment,
1/30 s exposure, fx≈1500 px → ~9 px of smear — boundary-destroying, invisible
to the tracking gate. Cheapest robust gate: reuse the §2.4 pose-delta
velocities *at shutter time* — if angular speed > ~0.3 rad/s or linear >
~0.3 m/s, wait up to ~300 ms for a calmer frame before freezing (the §2.4
field lesson doesn't apply here: this gate delays a photo by milliseconds, it
doesn't starve a measurement buffer). On iOS, `frame.camera.exposureDuration`
(and iOS 16 `frame.exifData` ISO) sharpens the threshold: long exposure ⇒
proportionally stricter speed gate. Optional belt-and-suspenders: grab 2–3
candidate frames and keep the max-Laplacian-variance one.

### R7 — Both: light — measure it, and offer the torch · ✅ implemented

Dim dining is the common real-world capture. Two cheap moves:
- **Hint from the light estimate** (iOS `frame.lightEstimate.ambientIntensity`
  ~lumens, ≈1000 = well-lit; Android `LightEstimate`): below a threshold,
  coach "more light helps accuracy."
- **Torch toggle**: ARCore has first-class support (`Config.FlashMode.TORCH`);
  iOS gets it through ARKit 6's `configurableCaptureDeviceForPrimaryCamera`
  (lock, set `torchMode`, unlock — same handle later enables focus/exposure
  nudges if AF hunting shows up in P0/P1). Note the LiDAR interaction is
  favorable: torch brightens RGB without disturbing ToF depth.

### R8 — Both: capture-QA telemetry in the payload (additive, contract-safe) · ✅ implemented

The result contract already ships `quality.*`; give the pipeline capture-side
inputs to compute it honestly. Additive optional block, `version` stays 1
(zod strips unknown keys today; add the optional field to
`capturePayloadSchema` when consumed):

```jsonc
"capture_quality": {
  "light_estimate": 742.0,          // lumens-ish, platform units
  "exposure_duration_s": 0.016,     // iOS; null on Android
  "camera_speed_m_s": 0.04,         // §2.4 velocities at shutter
  "camera_speed_rad_s": 0.11,
  "view_angle_deg": 21.5,           // camera axis vs plane normal
  "distance_m": 0.42                // camera to plane along the axis
}
```

Feeds `est_relative_error` (a dim, oblique, far capture honestly widens the
band), gives Spotter a concrete retake prompt, and — immediately — turns the
P0/P1 drills into labeled data about *when* captures go bad.

### R9 — Both: report the real `tracking.state` · ✅ implemented

Both modules hardcode `"normal"`. They only capture while tracking is good,
but the moment R6's delayed-shutter path exists the field can lie. One-line
honesty fix on each platform; the contract field already exists.

### Deliberate non-changes

- **No EXIF orientation tag on stored images.** Payload pixel coordinates
  refer to the sensor-oriented buffer (§9.2); an orientation tag would make
  well-behaved decoders rotate the image out from under the intrinsics. The
  sideways look in a photo viewer is the correct behavior. (A debug-only
  contact-sheet exporter is the right fix for human eyeballing.)
- **No HDR video (`videoHDRAllowed`).** Segmentation/classification models
  assume SDR; HDR also costs battery and can drop the frame rate VIO likes.
- **No real-time hover scanning.** Out of scope per HARDWARE.md — the budget
  math (one inference per capture) is a feature, not a limitation.

---

## 4. Suggested sequencing

| Order | Item | Effort | Payoff |
|---|---|---|---|
| 1 | R1 Android camera config | ~½ day incl. device check | 9× pixels on the lead platform, before P1 |
| 2 | R4 iOS encode quality | minutes | determinism |
| 3 | R9 tracking.state | minutes | honest payloads |
| 4 | R2 iOS 12 MP still | ~1–2 days | 4.4× pixels, sharper dim-light frames |
| 5 | R5 iOS §2.4 parity (+tilt/too-far both) | roadmap #2 | scale-term floor on iOS |
| 6 | R6 blur gate | ~1 day | protects both R1/R2 gains |
| 7 | R3 Android depth serialization | ~2 days | tier upgrade on depth devices |
| 8 | R7 light/torch, R8 QA telemetry | ~1 day | dim-scene rescue + measurable quality |

P0/P1 tie-in: land R1 (and ideally R4/R9) **before** running the drills, and
record R8's fields per trial if it's in — the drills then double as the
capture-quality baseline. Add one dim-light row to the P1 sheet to exercise
R6/R7 thresholds with kitchen-scale truth.

## 5. Sources

- Apple — [captureHighResolutionFrame(completion:)](https://developer.apple.com/documentation/arkit/arsession/capturehighresolutionframe(completion:)) · [Discover ARKit 6 (WWDC22, session 10126)](https://developer.apple.com/videos/play/wwdc2022/10126/): 12 MP out-of-band stills, `recommendedVideoFormatForHighResolutionFrameCapturing`, `configurableCaptureDeviceForPrimaryCamera` (exposure/WB/torch access, iOS 16+), per-frame EXIF.
- Google — [CameraConfig](https://developers.google.com/ar/reference/java/com/google/ar/core/CameraConfig) (CPU `imageSize` vs GPU `textureSize`, `getSupportedCameraConfigs` + `setCameraConfig`) · [Config.FlashMode](https://developers.google.com/ar/reference/java/com/google/ar/core/Config.FlashMode) (`TORCH`, default `OFF`) · ARCore Depth / Raw Depth API references (`acquireDepthImage16Bits`, `acquireRawDepthConfidenceImage`).
- This repo — `MATH.md` §2.4/§3.2/§8/§9, `HARDWARE.md` (payload budget), `docs/vault/The Capture App.md` (platform generation gap), and the module sources cited inline.
