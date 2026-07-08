---
tags: [ppe, codebase, native, capture]
---

# The Capture App

> The native AR capture screen — the only part that touches the camera and motion sensors. It runs the ruler ([[Math 2 - The Ruler]]) and emits the `CapturePayload`. Code: `modules/expo-portion-capture/`, `apps/demo/`. Spec: [[ARCHITECTURE]] §1.

## Why a custom native module

No maintained React Native / Expo library exposes ARKit raycasting + intrinsics + depth. So this is a hand‑written **Expo module** (`expo-portion-capture`) with a Swift/ARKit implementation for iOS and a Kotlin/ARCore one for Android, both producing the **identical `CapturePayload`** ([[System Architecture]]). The app already needs a dev build (for models + camera), so a native module is fine.

## The two platforms are at different design generations

A load‑bearing fact to know:

- **Android (Kotlin/ARCore) = the reworked version.** Center **sparkle reticle** + a **"45 lb gym‑plate" trigger that doubles as a thumb‑trackpad**, so *the finger never covers the food*. Has the full [[Math 2 - The Ruler]] §2.4 stabilization stack. Depth is enabled where supported but **not yet serialized** (payload `depth: null`, so `scale_source = "ruler"`). Built and running on a Pixel.
- **iOS (Swift/ARKit) = the older tap‑hold‑drag version.** The finger raycasts at its own screen location (so it covers the food), built on SceneKit 3D nodes, and it's the **only** platform that currently exports **LiDAR depth**. No stabilization stack yet — iOS parity is [[Roadmap and Next Steps]] item 2.

Same payload out either way; different interaction and maturity.

## The AR session

- **Android** (`ARCaptureActivity.ensureSession`): handles the Play‑Services‑for‑AR install flow, then configures plane finding **horizontal + vertical** (the ruler may hit any surface), latest‑camera‑image update mode, auto‑focus, and depth `AUTOMATIC` where supported. Capture is gated on `TrackingState.TRACKING`.
- **iOS** (`ARCaptureViewController.makeConfiguration`): `ARWorldTrackingConfiguration` with horizontal plane detection, LiDAR **mesh** reconstruction + `smoothedSceneDepth` where available, and Apple's `ARCoachingOverlayView` for the "move your phone" UX. Capture gated on `.normal` tracking.

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

Both platforms' `buildPayload` produce the same schema ([[System Architecture]]): write the image (Android JPEG from YUV, iOS HEIC), read `intrinsics` and the pose (transpose to the row‑major, ARKit‑convention 4×4 the geometry expects), express the locked plane as `n·X = d0`, map the strokes, set `depth` (iOS serializes LiDAR f32 + confidence with **intrinsics rescaled to depth resolution** per [[MATH]] §9.1; Android `null` for now), and set `scale_source`. Both feed `poseFromArkitCameraToWorld` in the [[Geometry Library]] unchanged.

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
`deps` injects a `CenterSquareSegmenter` (hard‑coded centered square), a `FixedClassifier` ("white rice, cooked"), and an `InMemoryNutrientStore` (rice: density 0.67, κ 0.55). So the demo exercises **real geometry on a placeholder segmentation** — you can cook rice, weigh it, capture with a ≥10 cm stroke, and compare the app's grams to a kitchen scale (the P1 drill).

## Related
- [[Math 2 - The Ruler]] · [[System Architecture]] · [[The Pipeline]] · [[Geometry Library]] · [[Testing]] · [[ARCHITECTURE]] · [[HARDWARE]]
