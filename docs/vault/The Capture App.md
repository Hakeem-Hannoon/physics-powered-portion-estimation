---
tags: [ppe, codebase, native, capture]
---

# The Capture App

> The native AR capture screen — the only part that touches the camera and motion sensors. It runs the ruler ([[Math 2 - The Ruler]]) and emits the `CapturePayload`. Code: `modules/expo-portion-capture/`, `apps/demo/`. Spec: [[ARCHITECTURE]] §1. Image-quality audit + the R1–R9 changes: [`docs/CAPTURE_QUALITY.md`](../CAPTURE_QUALITY.md).

## Why a custom native module

No maintained React Native / Expo library exposes ARKit raycasting + intrinsics + depth. So this is a hand‑written **Expo module** (`expo-portion-capture`) with a Swift/ARKit implementation for iOS and a Kotlin/ARCore one for Android, both producing the **identical `CapturePayload`** ([[System Architecture]]). The app already needs a dev build (for models + camera), so a native module is fine.

## The two platforms are at different design generations

A load‑bearing fact to know:

- **Android (Kotlin/ARCore) = the reworked interaction.** Center **sparkle reticle** + a **"45 lb gym‑plate" trigger that doubles as a thumb‑trackpad**, so *the finger never covers the food*. Has the full [[Math 2 - The Ruler]] §2.4 stabilization stack. Built and running on a Pixel.
- **iOS (Swift/ARKit) = the older tap‑hold‑drag interaction** (the finger raycasts at its own location, on SceneKit nodes). The full reticle + plate‑trackpad redesign is still [[Roadmap and Next Steps]] item 2 — but as of the `CAPTURE_QUALITY.md` R1–R9 pass it now runs the **same §2.4 stabilization statistics** (per‑frame median buffer, shake gate, plane snap) under that tap‑drag UI, so its *accuracy* is at parity even though its *interaction* isn't.

**What the R1–R9 capture‑quality pass changed on both** (code done, device‑validation pending — see `CAPTURE_QUALITY.md`):

- **Resolution.** Android now selects the **largest‑area CPU camera config** (`selectHighResCameraConfig`) instead of ARCore's ~640×480 default; iOS freezes a **12 MP still** via ARKit 6 `captureHighResolutionFrame` instead of a ~1920×1440 video frame, building the payload entirely from the returned frame (its own intrinsics/pose — [[MATH]] §9.1).
- **Depth everywhere it exists.** Android **serializes ARCore depth** (`acquireDepthImage16Bits` → f32 meters, intrinsics rescaled) — no longer `depth: null` — so depth‑capable Androids move up to `scale_source: "lidar"` and unlock the §4a height‑field volume route. iOS already exported LiDAR depth.
- **Sharper frames.** A **motion‑blur shutter gate** (R6) waits a few frames for the phone to hold still (tighter than the measuring gate; a short grace window never traps the user) before freezing; iOS **pins the HEIC/JPEG lossy quality** (R4) so encoding is deterministic across OS versions.
- **Dim scenes.** Ambient‑light coaching + a **torch toggle** (ARCore `FlashMode.TORCH`; iOS `configurableCaptureDeviceForPrimaryCamera`).
- **Honest signals.** Real `tracking.state` (was hardcoded `"normal"`), a tilt/too‑top‑down coach, and an additive optional **`capture_quality`** payload block (light, exposure, camera speed, view angle, distance) that feeds `quality.est_relative_error` and turns the P0/P1 drills into labeled quality data.

Same payload schema out either way; different interaction, same math and now the same capture‑quality treatment.

## The AR session

- **Android** (`ARCaptureActivity.ensureSession` → `selectHighResCameraConfig` + `applyConfig`): handles the Play‑Services‑for‑AR install flow, **selects the largest‑area CPU camera config** (R1), then configures plane finding **horizontal + vertical** (the ruler may hit any surface), latest‑camera‑image update mode, auto‑focus, `AMBIENT_INTENSITY` light estimation, depth `AUTOMATIC` where supported, and `FlashMode` from the torch toggle. Capture is gated on `TrackingState.TRACKING`.
- **iOS** (`ARCaptureViewController.makeConfiguration`): `ARWorldTrackingConfiguration` with horizontal plane detection, LiDAR **mesh** reconstruction + `smoothedSceneDepth` where available, `recommendedVideoFormatForHighResolutionFrameCapturing` (R2), a `session.delegate` per‑frame loop for the §2.4 stabilization, and Apple's `ARCoachingOverlayView` for the "move your phone" UX. Capture gated on `.normal` tracking.

## The Android interaction (worth studying) — maps to [[Math 2 - The Ruler]]

Four cooperating pieces:

1. **The "45 lb plate" button = trigger + trackpad** (`PlateButton.kt`). A custom view drawn as a face‑on gym plate. On touch‑down it *captures the gesture* (so the finger can slide **off** the plate) and reports drag **deltas**. Hold to anchor; slide the thumb to steer; release to commit.
2. **The gain factor.** `PAD_GAIN = 2.2` — the thumb delta is amplified 2.2× (and clamped to ±42% of the viewport) to steer the reticle away from center, so a small thumb slide sweeps the aim point across the food *while the phone/camera pose stays still*. Release recenters the reticle.
3. **The sparkle reticle** (`RulerOverlay`). A four‑point star with two breathing glitter specks inside a target ring: **dashed white while searching, solid yellow when locked** onto a surface. It's a 2D overlay projected from the world anchors each frame (no 3D scene graph).
4. **The hold‑to‑measure state machine** (`updateReticleAndMeasure`, on the GL thread):
   - **Press** → anchor point A *instantly from the pre‑press median buffer* (the finger jolt can't contaminate frames captured before it).
   - **Slide** → the endpoint tracks the rolling median; live distance shown.
   - **Release** → commit the median‑filtered (pre‑lift) endpoint; reject sub‑5 mm strokes; classify **horizontal vs. vertical** by the angle to the plane normal (dot > 0.7 ⇒ vertical/height stroke).

### The stabilization stack (the [[Math 2 - The Ruler]] §2.4 statistics, in code)
Constants that quote the math directly:
```
STEADY_WINDOW = 6            // rolling median buffer size
SHAKE_LINEAR_M_S = 1.0       // gate: exclude fast translations
SHAKE_ANGULAR_RAD_S = 1.5    // gate: exclude fast rotations
PLANE_SNAP_M = 0.008         // snap hits within 8 mm to the locked plane
```
- **Median anchoring** — `medianPoint` takes the component‑wise median of the shake‑gated buffer.
- **Shake gating** — `isShaky` computes linear + angular velocity from pose deltas (angular via the quaternion dot, exactly [[MATH]] §2.4) and excludes only *violent* motion; ordinary tremor passes to the median. The comment records the field lesson: too strict a gate *starves the buffer and blocks measuring*.
- **Plane snapping** — `snapToSupportPlane` projects near‑plane hits onto the temporally‑filtered plane; height strokes pass through.

Raycast preference: plane‑within‑polygon → any tracked plane → any depth/feature point, so *measuring is never gated on detecting the table*.

## Building the `CapturePayload`

Both platforms' `buildPayload` produce the same schema ([[System Architecture]]): write the image (Android JPEG from YUV, iOS HEIC at pinned lossy quality), read `intrinsics` and the pose (transpose to the row‑major, ARKit‑convention 4×4 the geometry expects), express the locked plane as `n·X = d0`, map the strokes, set `depth`, `tracking.state` (the real state now, R9), `scale_source`, and the optional `capture_quality` block (R8). Depth is serialized on **both** platforms with **intrinsics rescaled to depth resolution** per [[MATH]] §9.1 — iOS from LiDAR `smoothedSceneDepth` (f32 + confidence), Android from `acquireDepthImage16Bits` (DEPTH16→f32 meters, confidence `null` pending the Raw Depth API). Both feed `poseFromArkitCameraToWorld` in the [[Geometry Library]] unchanged.

## The JS API (`src/index.ts`)

```ts
import * as PortionCapture from "expo-portion-capture";
PortionCapture.isSupported(): boolean           // device supports AR?
PortionCapture.launch(options?): Promise<CapturePayload | null>   // null = user cancelled
// options: { requireStroke?: boolean = true, minStrokeLengthM?: number = 0.10 }
```
The exported TS types mirror `capturePayloadSchema` (the pipeline is the source of truth; the native side is treated as an untrusted producer). Requires a **development build** (ARKit is unavailable in Expo Go) and the `NSCameraUsageDescription` Info.plist key.

## The demo app (`apps/demo`)

A minimal one‑screen Expo dev‑build app that wires the *real* metric path onto *placeholder* models — the vehicle for the P0/P1 device drills ([[Testing]]):

```ts
if (!PortionCapture.isSupported()) { /* need a real device dev build */ }
const payload = await PortionCapture.launch({ requireStroke: true });
if (!payload) return;                 // cancelled
setResult(await estimateMeal(payload, deps));   // real geometry, mock models
```
`deps` now injects **real nutrition**: an `ExpoSqliteNutrientStore` (expo‑sqlite over the bundled `assets/nutrients.sqlite`, 12 real USDA foods) plus a `SelectedClassifier` (the food you pick in the chip row — the interim for the on‑device MobileCLIP classifier, whose matching logic is the tested `ZeroShotClassifier`), on top of the still‑placeholder `CenterSquareSegmenter`. So the demo exercises **real geometry + real nutrition on a placeholder segmentation** — pick the food, cook and weigh it, capture with a ≥10 cm stroke, and compare the app's grams to a kitchen scale (the P1 drill). Adapter details + how to wire the vision models: `docs/REAL_ADAPTERS.md`.

## Related
- [[Math 2 - The Ruler]] · [[System Architecture]] · [[The Pipeline]] · [[Geometry Library]] · [[Testing]] · [[ARCHITECTURE]] · [[HARDWARE]]
