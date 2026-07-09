import ARKit
import AVFoundation
import CoreImage
import ImageIO
import SceneKit
import UIKit

/// One committed ruler stroke, world-space meters (MATH.md §2.3).
private struct RulerStroke {
  let p1: simd_float3
  let p2: simd_float3
  let kind: String // "horizontal" | "vertical"
  let node: SCNNode
  var lengthM: Float { simd_distance(p1, p2) }
}

/// Full-screen AR capture: the user tap-holds and drags to draw metric ruler
/// strokes (raycast against tracked geometry each frame — MATH.md §2), then
/// takes the photo. Produces the versioned CapturePayload consumed by
/// @ppe/pipeline (schema: packages/pipeline/src/contracts.ts).
///
/// The endpoints are stabilized per-frame (MATH.md §2.4) rather than read from a
/// single touch event, and the shutter freezes a full-resolution still via
/// ARKit 6 (`captureHighResolutionFrame`) — see docs/CAPTURE_QUALITY.md R2/R5.
final class ARCaptureViewController: UIViewController, ARSessionDelegate {
  var requireStroke = true
  var minStrokeLengthM: Float = 0.10
  /// Called exactly once: payload dictionary, or nil when cancelled.
  var onComplete: (([String: Any]?) -> Void)?

  private let sceneView = ARSCNView()
  private let coachingOverlay = ARCoachingOverlayView()
  private let measureLabel = UILabel()
  private let hintLabel = UILabel()
  private let shutterButton = UIButton(type: .system)
  private let cancelButton = UIButton(type: .system)
  private let undoButton = UIButton(type: .system)
  private let torchButton = UIButton(type: .system)

  private var strokes: [RulerStroke] = []
  /// Committed anchor of the in-progress stroke (locked from the anchor window).
  private var activeStart: simd_float3?
  /// Live, median-filtered endpoint of the in-progress stroke.
  private var activeEnd: simd_float3?
  private var activeNode: SCNNode?
  /// Screen point the finger is holding while a gesture is active (nil = idle).
  private var activeFingerPoint: CGPoint?
  /// True until the anchor window fills, while activeStart is still settling.
  private var capturingAnchor = false
  /// The plane the meal sits on: locked by the first successful stroke raycast.
  private var lockedPlaneAnchor: ARPlaneAnchor?
  private var lockedPlaneTransform: simd_float4x4?
  private var planeSource = "estimated"
  private var completed = false
  private var torchOn = false

  // MARK: - Stabilization + capture-quality state (MATH.md §2.4, CAPTURE_QUALITY.md)

  /// Shake-gated recent hits; component-wise median is the robust endpoint.
  private var steadySamples: [simd_float3] = []
  private var prevPosition: simd_float3?
  private var prevQuat: simd_quatf?
  private var prevTime: TimeInterval = 0
  /// Latest pose-delta speeds — the blur proxy (R6) and telemetry (R8).
  private var lastLinear: Float = 0
  private var lastAngular: Float = 0
  /// Latest coaching signals, refreshed each frame from a center raycast.
  private var reticleDistanceM: Float?
  private var viewAngleDeg: Float = 90
  /// A pending high-res capture that's waiting for the phone to hold still (R6).
  private var shutterDeadline: TimeInterval?

  private enum K {
    // Endpoint stabilization (MATH.md §2.4) — same constants as the Android module.
    static let steadyWindow = 6
    static let shakeLinear: Float = 1.0
    static let shakeAngular: Float = 1.5
    static let planeSnap: Float = 0.008
    // Motion-blur shutter gate (CAPTURE_QUALITY.md R6): far tighter than the
    // measuring gate — a still needs the phone genuinely still — but it only
    // delays the photo a few frames, never starves a buffer, so strict is safe.
    static let shootLinear: Float = 0.30
    static let shootAngular: Float = 0.30
    static let shootGrace: TimeInterval = 0.35
    static let farWarnM: Float = 1.5
    static let tiltWarnDeg: Float = 45
    static let darkLumens: CGFloat = 60 // ARLightEstimate.ambientIntensity (~lumens)
  }

  // MARK: - Lifecycle

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    layoutViews()

    sceneView.automaticallyUpdatesLighting = true
    sceneView.session.delegate = self
    sceneView.session.delegateQueue = .main // raycasts + node edits stay on main
    sceneView.session.run(Self.makeConfiguration())

    coachingOverlay.session = sceneView.session
    coachingOverlay.goal = .horizontalPlane
    coachingOverlay.activatesAutomatically = true

    let press = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress(_:)))
    press.minimumPressDuration = 0.15
    press.allowableMovement = .greatestFiniteMagnitude
    sceneView.addGestureRecognizer(press)

    updateControls()
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    sceneView.session.pause()
  }

  override var prefersStatusBarHidden: Bool { true }

  private static func makeConfiguration() -> ARWorldTrackingConfiguration {
    let config = ARWorldTrackingConfiguration()
    config.planeDetection = [.horizontal]
    if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) {
      config.sceneReconstruction = .mesh
    }
    if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) {
      config.frameSemantics.insert(.smoothedSceneDepth)
    }
    // R2: opt into the video format ARKit recommends for 12 MP still capture, so
    // `captureHighResolutionFrame` can hand back a full-resolution photo.
    if let hiRes = ARWorldTrackingConfiguration.recommendedVideoFormatForHighResolutionFrameCapturing {
      config.videoFormat = hiRes
    }
    return config
  }

  // MARK: - Per-frame update (MATH.md §2.4 stabilization + coaching), main queue

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    updateShake(frame)
    guard case .normal = frame.camera.trackingState else {
      steadySamples.removeAll()
      return
    }

    // The in-progress stroke: sample the finger point each frame, shake-gate,
    // and track the component-wise median — tremor and the press/lift jolts are
    // zero-mean spikes the median absorbs (MATH.md §2.4).
    if let point = activeFingerPoint {
      if let hit = raycast(at: point) {
        let raw = snapToSupportPlane(hit.point)
        if !isShaky() {
          steadySamples.append(raw)
          if steadySamples.count > K.steadyWindow { steadySamples.removeFirst() }
        }
        let median = steadySamples.isEmpty ? raw : Self.medianPoint(steadySamples)
        if capturingAnchor {
          // No pre-touch buffer exists on the tap-drag interaction, so the anchor
          // settles over the first window of gated frames, then locks.
          activeStart = median
          if steadySamples.count >= K.steadyWindow { capturingAnchor = false }
        }
        activeEnd = median
        if let start = activeStart {
          redrawActiveStroke(from: start, to: median)
          setMeasureText(Self.format(meters: simd_distance(start, median)))
        }
      }
    }

    updateCoaching(frame)
    serviceHighResCapture()
  }

  // MARK: - The ruler gesture (MATH.md §2.3)

  @objc private func handleLongPress(_ gesture: UILongPressGestureRecognizer) {
    let point = gesture.location(in: sceneView)
    switch gesture.state {
    case .began:
      guard let hit = raycast(at: point) else {
        setMeasureText("Point at the table surface")
        return
      }
      rememberPlane(from: hit.result)
      // Begin sampling; the per-frame update settles the anchor from the median.
      steadySamples.removeAll()
      capturingAnchor = true
      activeStart = hit.point
      activeEnd = hit.point
      activeFingerPoint = point
    case .changed:
      activeFingerPoint = point
    case .ended:
      defer { endGesture() }
      guard let start = activeStart, let end = activeEnd else { return }
      let length = simd_distance(start, end)
      guard length >= 0.005, let node = activeNode else {
        activeNode?.removeFromParentNode()
        setMeasureText("Too short — drag a longer line")
        return
      }
      let direction = simd_normalize(end - start)
      let vertical = abs(simd_dot(direction, planeNormal())) > 0.7
      strokes.append(
        RulerStroke(p1: start, p2: end, kind: vertical ? "vertical" : "horizontal", node: node)
      )
      setMeasureText(Self.format(meters: length))
      updateControls()
    case .cancelled, .failed:
      activeNode?.removeFromParentNode()
      endGesture()
    default:
      break
    }
  }

  private func endGesture() {
    activeFingerPoint = nil
    capturingAnchor = false
    activeStart = nil
    activeEnd = nil
    activeNode = nil
    steadySamples.removeAll()
  }

  /// A raycast result plus its world point (kept together so callers can both
  /// read the point and inspect the anchor).
  private struct Hit { let result: ARRaycastResult; let point: simd_float3 }

  /// Prefer mapped geometry (LiDAR mesh / detected planes); fall back to the
  /// estimated plane so the ruler works before mapping completes.
  private func raycast(at point: CGPoint) -> Hit? {
    let targets: [ARRaycastQuery.Target] = [.existingPlaneGeometry, .estimatedPlane]
    for target in targets {
      if let query = sceneView.raycastQuery(from: point, allowing: target, alignment: .any),
         let result = sceneView.session.raycast(query).first {
        return Hit(result: result, point: result.worldTransform.position)
      }
    }
    return nil
  }

  private func rememberPlane(from hit: ARRaycastResult) {
    if let anchor = hit.anchor as? ARPlaneAnchor {
      lockedPlaneAnchor = anchor
      planeSource = "detected_plane"
    } else if lockedPlaneAnchor == nil, lockedPlaneTransform == nil {
      // Raycast surface frame: the Y column is the surface normal.
      lockedPlaneTransform = hit.worldTransform
      planeSource = "estimated"
    }
  }

  private func planeNormal() -> simd_float3 {
    if let anchor = lockedPlaneAnchor {
      return simd_normalize(anchor.transform.columns.1.xyz)
    }
    if let transform = lockedPlaneTransform {
      return simd_normalize(transform.columns.1.xyz)
    }
    return simd_float3(0, 1, 0)
  }

  // MARK: - Stabilization helpers (MATH.md §2.4)

  /// Pose-delta linear + angular speed, cached for the blur gate and telemetry.
  private func updateShake(_ frame: ARFrame) {
    let t = frame.timestamp
    let pos = frame.camera.transform.columns.3.xyz
    let quat = simd_quatf(frame.camera.transform)
    defer { prevPosition = pos; prevQuat = quat; prevTime = t }
    guard let p0 = prevPosition, let q0 = prevQuat, prevTime > 0 else {
      lastLinear = 0; lastAngular = 0; return
    }
    let dt = Float(t - prevTime)
    guard dt > 0, dt < 0.25 else { lastLinear = 0; lastAngular = 0; return }
    lastLinear = simd_distance(pos, p0) / dt
    let qDot = min(abs(simd_dot(q0.vector, quat.vector)), 1)
    lastAngular = 2 * acos(qDot) / dt
  }

  /// Shake gate for VIOLENT motion only — ordinary tremor passes to the median.
  private func isShaky() -> Bool {
    lastLinear > K.shakeLinear || lastAngular > K.shakeAngular
  }

  /// Tighter gate: is the phone still enough to freeze a sharp still? (R6)
  private func isTooShakyToShoot() -> Bool {
    lastLinear > K.shootLinear || lastAngular > K.shootAngular
  }

  /// Points within a few mm of the locked plane snap onto it — the plane is
  /// temporally filtered and steadier than any single raycast. Height strokes
  /// (several cm above) pass through untouched.
  private func snapToSupportPlane(_ p: simd_float3) -> simd_float3 {
    guard let anchor = lockedPlaneAnchor else { return p }
    let n = simd_normalize(anchor.transform.columns.1.xyz)
    let offset = simd_dot(p - anchor.transform.columns.3.xyz, n)
    if abs(offset) >= K.planeSnap { return p }
    return p - n * offset
  }

  private static func medianPoint(_ samples: [simd_float3]) -> simd_float3 {
    func med(_ index: Int) -> Float {
      let sorted = samples.map { $0[index] }.sorted()
      return sorted[sorted.count / 2]
    }
    return simd_float3(med(0), med(1), med(2))
  }

  private func redrawActiveStroke(from start: simd_float3, to end: simd_float3) {
    activeNode?.removeFromParentNode()
    let node = Self.strokeNode(from: start, to: end)
    sceneView.scene.rootNode.addChildNode(node)
    activeNode = node
  }

  /// A thin cylinder between two world points, with endpoint dots.
  private static func strokeNode(from start: simd_float3, to end: simd_float3) -> SCNNode {
    let parent = SCNNode()
    let length = simd_distance(start, end)
    if length > 1e-4 {
      let cylinder = SCNCylinder(radius: 0.0015, height: CGFloat(length))
      cylinder.firstMaterial?.diffuse.contents = UIColor.systemYellow
      cylinder.firstMaterial?.lightingModel = .constant
      let line = SCNNode(geometry: cylinder)
      line.simdPosition = (start + end) / 2
      // SCNCylinder's axis is +Y; rotate it onto the stroke direction.
      line.simdOrientation = simd_quatf(from: simd_float3(0, 1, 0), to: simd_normalize(end - start))
      parent.addChildNode(line)
    }
    for point in [start, end] {
      let dot = SCNNode(geometry: SCNSphere(radius: 0.004))
      dot.geometry?.firstMaterial?.diffuse.contents = UIColor.systemYellow
      dot.geometry?.firstMaterial?.lightingModel = .constant
      dot.simdPosition = point
      parent.addChildNode(dot)
    }
    return parent
  }

  // MARK: - Coaching (CAPTURE_QUALITY.md R5/R7), main queue

  private func updateCoaching(_ frame: ARFrame) {
    // A center raycast gives a live distance + view-angle reference when the
    // user isn't actively measuring.
    let center = CGPoint(x: sceneView.bounds.midX, y: sceneView.bounds.midY)
    if let hit = raycast(at: center) {
      reticleDistanceM = simd_distance(hit.point, frame.camera.transform.columns.3.xyz)
    } else {
      reticleDistanceM = nil
    }
    let forward = -simd_normalize(frame.camera.transform.columns.2.xyz) // camera looks along -z
    viewAngleDeg = Self.angleDeg(forward, -planeNormal())

    // ARKit's own overlay owns the "move to start tracking" moment.
    guard !coachingOverlay.isActive, activeFingerPoint == nil else { return }
    let lumens = frame.lightEstimate?.ambientIntensity ?? 1000
    if let dist = reticleDistanceM, dist > K.farWarnM {
      setHint("That's \(Self.format(meters: dist)) away — move closer to read portions well")
    } else if reticleDistanceM != nil, viewAngleDeg > K.tiltWarnDeg {
      setHint("Tilt more top-down — shooting flat-on reads portions best")
    } else if lumens < K.darkLumens {
      setHint("A bit dark — more light (or the torch) sharpens the estimate")
    } else if requireStroke, !strokes.contains(where: { $0.kind == "horizontal" && $0.lengthM >= minStrokeLengthM }) {
      setHint("Hold and drag along the plate to measure (≥ \(Int(minStrokeLengthM * 100)) cm)")
    } else {
      setHint("Add a vertical stroke up the food for better accuracy, or shoot")
    }
  }

  // MARK: - Capture (docs/ARCHITECTURE.md payload contract)

  @objc private func shutterTapped() {
    guard let frame = sceneView.session.currentFrame else { return }
    guard case .normal = frame.camera.trackingState else {
      setMeasureText("Hold steady — tracking is limited")
      return
    }
    guard shutterReady else {
      setMeasureText("Measure a ≥ \(Int(minStrokeLengthM * 100)) cm span first")
      return
    }
    // R6: arm a short grace window; serviceHighResCapture() fires the shutter on
    // the first calm frame, or once the window expires (never trap the user).
    shutterDeadline = frame.timestamp + K.shootGrace
    setMeasureText("Steadying the shot — hold still…")
  }

  /// Runs each frame while a capture is armed (R6 → R2).
  private func serviceHighResCapture() {
    guard let deadline = shutterDeadline,
          let frame = sceneView.session.currentFrame else { return }
    let expired = frame.timestamp >= deadline
    guard expired || !isTooShakyToShoot() else { return }
    shutterDeadline = nil

    // R2: freeze a full-resolution (12 MP) still out-of-band. Its intrinsics and
    // pose differ from the video stream, so the payload is built ENTIRELY from
    // the returned frame — mixing the two is the MATH.md §9.1 corruption trap.
    sceneView.session.captureHighResolutionFrame { [weak self] hiFrame, _ in
      guard let self else { return }
      let source = hiFrame ?? self.sceneView.session.currentFrame
      guard let captured = source else {
        self.setMeasureText("Capture failed — try again")
        return
      }
      do {
        let payload = try self.buildPayload(frame: captured)
        self.finish(with: payload)
      } catch {
        self.setMeasureText("Capture failed: \(error.localizedDescription)")
      }
    }
  }

  @objc private func cancelTapped() {
    finish(with: nil)
  }

  @objc private func undoTapped() {
    guard let last = strokes.popLast() else { return }
    last.node.removeFromParentNode()
    updateControls()
  }

  /// R7: torch via ARKit 6's configurable primary capture device.
  @objc private func toggleTorch() {
    torchOn.toggle()
    if let device = ARWorldTrackingConfiguration.configurableCaptureDeviceForPrimaryCamera {
      do {
        try device.lockForConfiguration()
        device.torchMode = torchOn ? .on : .off
        device.unlockForConfiguration()
      } catch {
        torchOn = false
      }
    } else {
      torchOn = false
    }
    torchButton.setTitle(torchOn ? "Torch ●" : "Torch ○", for: .normal)
  }

  private var shutterReady: Bool {
    !requireStroke || strokes.contains { $0.kind == "horizontal" && $0.lengthM >= minStrokeLengthM }
  }

  private func finish(with payload: [String: Any]?) {
    guard !completed else { return }
    completed = true
    sceneView.session.pause()
    dismiss(animated: true) { [onComplete] in
      onComplete?(payload)
    }
  }

  private enum CaptureError: LocalizedError {
    case noPlane
    var errorDescription: String? { "No table surface was detected — draw a ruler stroke first" }
  }

  private func buildPayload(frame: ARFrame) throws -> [String: Any] {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("portion-capture-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    // 1. The image, at sensor resolution and sensor orientation. All pixel
    //    coordinates in the payload refer to this stored image (MATH.md §9.2).
    let pixelBuffer = frame.capturedImage
    let imageWidth = CVPixelBufferGetWidth(pixelBuffer)
    let imageHeight = CVPixelBufferGetHeight(pixelBuffer)
    let imageURL = try writeImage(pixelBuffer, to: directory)

    // 2. The supporting plane: n·X = d0 (MATH.md §2.2).
    let normal: simd_float3
    var extent: [Float]? = nil
    var planePoint: simd_float3
    if let anchor = lockedPlaneAnchor {
      normal = simd_normalize(anchor.transform.columns.1.xyz)
      planePoint = anchor.transform.columns.3.xyz
      extent = [anchor.planeExtent.width, anchor.planeExtent.height]
      planeSource = (sceneView.session.configuration as? ARWorldTrackingConfiguration)?
        .sceneReconstruction == .mesh ? "lidar_mesh" : "detected_plane"
    } else if let transform = lockedPlaneTransform {
      normal = simd_normalize(transform.columns.1.xyz)
      planePoint = transform.columns.3.xyz
    } else if let firstStroke = strokes.first {
      normal = simd_float3(0, 1, 0)
      planePoint = firstStroke.p1
    } else {
      throw CaptureError.noPlane
    }
    let d0 = simd_dot(normal, planePoint)

    // 3. Depth, when the hardware provides it. It can lag the out-of-band still
    //    by a frame, so fall back to the latest video frame's depth — the depth
    //    block carries its OWN intrinsics, so a mixed source stays correct.
    var depthDict: Any = NSNull()
    let sceneDepth = frame.smoothedSceneDepth ?? frame.sceneDepth
      ?? sceneView.session.currentFrame?.smoothedSceneDepth
      ?? sceneView.session.currentFrame?.sceneDepth
    if let sceneDepth {
      depthDict = try writeDepth(
        sceneDepth,
        to: directory,
        cameraIntrinsics: frame.camera.intrinsics,
        imageSize: (imageWidth, imageHeight)
      )
    }

    let horizontalOK = strokes.contains { $0.kind == "horizontal" && $0.lengthM >= minStrokeLengthM }
    let scaleSource: String = depthDict is NSNull ? (horizontalOK ? "ruler" : "none") : "lidar"

    // 4. Capture-condition telemetry (CAPTURE_QUALITY.md R8). Additive/optional.
    let cameraPos = frame.camera.transform.columns.3.xyz
    let cameraHeightM = max(abs(simd_dot(cameraPos - planePoint, normal)), 1e-4)
    let lightAny: Any = frame.lightEstimate.map { $0.ambientIntensity as Any } ?? NSNull()
    let exposureAny: Any = ARWorldTrackingConfiguration.configurableCaptureDeviceForPrimaryCamera
      .map { CMTimeGetSeconds($0.exposureDuration) as Any } ?? NSNull()

    return [
      "version": 1,
      "image": imageURL.absoluteString,
      "image_size": [imageWidth, imageHeight],
      "intrinsics": Self.rows(of: frame.camera.intrinsics),
      // simd matrices are column-major; the contract is row-major.
      "camera_to_world": Self.rowMajor(frame.camera.transform),
      "plane": [
        "normal": [normal.x, normal.y, normal.z],
        "d0": d0,
        "extent": extent as Any,
      ],
      "strokes": strokes.map { stroke in
        [
          "p1": [stroke.p1.x, stroke.p1.y, stroke.p1.z],
          "p2": [stroke.p2.x, stroke.p2.y, stroke.p2.z],
          "length_m": stroke.lengthM,
          "kind": stroke.kind,
        ]
      },
      "depth": depthDict,
      // R9: report the real tracking state instead of a hardcoded "normal".
      "tracking": ["state": Self.trackingName(frame.camera.trackingState), "plane_source": planeSource],
      "scale_source": scaleSource,
      "capture_quality": [
        "light_estimate": lightAny,
        "exposure_duration_s": exposureAny,
        "camera_speed_m_s": lastLinear,
        "camera_speed_rad_s": lastAngular,
        "view_angle_deg": viewAngleDeg,
        "distance_m": cameraHeightM,
      ],
    ]
  }

  private func writeImage(_ pixelBuffer: CVPixelBuffer, to directory: URL) throws -> URL {
    let image = CIImage(cvPixelBuffer: pixelBuffer)
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    // R4: pin the lossy quality so encoding is deterministic across OS versions
    // (an OS-default shift would silently move segmentation-boundary behavior).
    let options: [CIImageRepresentationOption: Any] =
      [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.90]
    let heicURL = directory.appendingPathComponent("capture.heic")
    do {
      try ciContext.writeHEIFRepresentation(
        of: image, to: heicURL, format: .RGBA8, colorSpace: colorSpace, options: options
      )
      return heicURL
    } catch {
      // Simulators and older devices without HEIC encoders fall back to JPEG.
      let jpegURL = directory.appendingPathComponent("capture.jpg")
      try ciContext.writeJPEGRepresentation(
        of: image, to: jpegURL, colorSpace: colorSpace, options: options
      )
      return jpegURL
    }
  }

  /// Reused across captures (hoisted for the 12 MP encode — CAPTURE_QUALITY.md R4).
  private let ciContext = CIContext()

  /// Serializes the depth + confidence maps as raw binaries, with intrinsics
  /// rescaled from the RGB resolution to the depth resolution (MATH.md §9.1).
  private func writeDepth(
    _ sceneDepth: ARDepthData,
    to directory: URL,
    cameraIntrinsics: simd_float3x3,
    imageSize: (Int, Int)
  ) throws -> [String: Any] {
    let depthMap = sceneDepth.depthMap
    let width = CVPixelBufferGetWidth(depthMap)
    let height = CVPixelBufferGetHeight(depthMap)

    let depthURL = directory.appendingPathComponent("depth.f32")
    try Self.pixelBufferData(depthMap, bytesPerPixel: 4).write(to: depthURL)

    var confidencePath: Any = NSNull()
    if let confidenceMap = sceneDepth.confidenceMap {
      let confidenceURL = directory.appendingPathComponent("depth-confidence.u8")
      try Self.pixelBufferData(confidenceMap, bytesPerPixel: 1).write(to: confidenceURL)
      confidencePath = confidenceURL.absoluteString
    }

    let sx = Float(width) / Float(imageSize.0)
    let sy = Float(height) / Float(imageSize.1)
    var k = cameraIntrinsics
    k[0][0] *= sx // fx  (simd_float3x3 subscripts are [column][row])
    k[1][1] *= sy // fy
    k[2][0] *= sx // cx
    k[2][1] *= sy // cy

    return [
      "map": depthURL.absoluteString,
      "confidence": confidencePath,
      "size": [width, height],
      "intrinsics": Self.rows(of: k),
    ]
  }

  private static func pixelBufferData(_ buffer: CVPixelBuffer, bytesPerPixel: Int) -> Data {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
    let base = CVPixelBufferGetBaseAddress(buffer)!
    var data = Data(capacity: width * height * bytesPerPixel)
    let rowLength = width * bytesPerPixel
    for row in 0..<height {
      data.append(
        Data(bytes: base.advanced(by: row * bytesPerRow), count: rowLength)
      )
    }
    return data
  }

  // MARK: - Matrix serialization (row-major contract)

  private static func rowMajor(_ m: simd_float4x4) -> [Float] {
    // simd stores columns; the payload stores rows: element (r, c) = columns[c][r].
    var out: [Float] = []
    out.reserveCapacity(16)
    for r in 0..<4 {
      for c in 0..<4 {
        out.append(m[c][r])
      }
    }
    return out
  }

  private static func rows(of m: simd_float3x3) -> [[Float]] {
    (0..<3).map { r in (0..<3).map { c in m[c][r] } }
  }

  private static func format(meters: Float) -> String {
    meters < 1 ? String(format: "%.1f cm", meters * 100) : String(format: "%.2f m", meters)
  }

  private static func trackingName(_ state: ARCamera.TrackingState) -> String {
    switch state {
    case .normal: return "normal"
    case .limited: return "limited"
    case .notAvailable: return "not_available"
    }
  }

  private static func angleDeg(_ a: simd_float3, _ b: simd_float3) -> Float {
    let d = max(-1, min(1, simd_dot(simd_normalize(a), simd_normalize(b))))
    return acos(d) * 180 / .pi
  }

  // MARK: - UI chrome

  private func setMeasureText(_ text: String) {
    measureLabel.text = text
  }

  private func setHint(_ text: String) {
    hintLabel.text = text
  }

  private func updateControls() {
    let hasValidStroke = strokes.contains {
      $0.kind == "horizontal" && $0.lengthM >= minStrokeLengthM
    }
    shutterButton.isEnabled = hasValidStroke || !requireStroke
    shutterButton.alpha = shutterButton.isEnabled ? 1 : 0.4
    undoButton.isHidden = strokes.isEmpty
    hintLabel.text = hasValidStroke
      ? "Add a vertical stroke up the food for better accuracy, or shoot"
      : "Hold and drag along the plate to measure (≥ \(Int(minStrokeLengthM * 100)) cm)"
  }

  private func layoutViews() {
    for subview in [sceneView, coachingOverlay] {
      subview.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(subview)
      NSLayoutConstraint.activate([
        subview.topAnchor.constraint(equalTo: view.topAnchor),
        subview.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        subview.leadingAnchor.constraint(equalTo: view.leadingAnchor),
        subview.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      ])
    }

    measureLabel.textColor = .white
    measureLabel.font = .monospacedDigitSystemFont(ofSize: 22, weight: .semibold)
    measureLabel.textAlignment = .center

    hintLabel.textColor = .white.withAlphaComponent(0.85)
    hintLabel.font = .systemFont(ofSize: 14)
    hintLabel.textAlignment = .center
    hintLabel.numberOfLines = 2

    shutterButton.setImage(UIImage(systemName: "circle.inset.filled"), for: .normal)
    shutterButton.tintColor = .white
    shutterButton.transform = CGAffineTransform(scaleX: 2.4, y: 2.4)
    shutterButton.addTarget(self, action: #selector(shutterTapped), for: .touchUpInside)

    cancelButton.setTitle("Cancel", for: .normal)
    cancelButton.tintColor = .white
    cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)

    undoButton.setImage(UIImage(systemName: "arrow.uturn.backward"), for: .normal)
    undoButton.tintColor = .white
    undoButton.addTarget(self, action: #selector(undoTapped), for: .touchUpInside)

    torchButton.setTitle("Torch ○", for: .normal)
    torchButton.tintColor = .white
    torchButton.addTarget(self, action: #selector(toggleTorch), for: .touchUpInside)

    for control in [measureLabel, hintLabel, shutterButton, cancelButton, undoButton, torchButton] {
      control.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(control)
    }
    let safe = view.safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      measureLabel.topAnchor.constraint(equalTo: safe.topAnchor, constant: 12),
      measureLabel.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
      hintLabel.topAnchor.constraint(equalTo: measureLabel.bottomAnchor, constant: 6),
      hintLabel.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 24),
      hintLabel.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -24),
      torchButton.topAnchor.constraint(equalTo: safe.topAnchor, constant: 12),
      torchButton.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -24),
      shutterButton.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
      shutterButton.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -32),
      cancelButton.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 24),
      cancelButton.centerYAnchor.constraint(equalTo: shutterButton.centerYAnchor),
      undoButton.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -24),
      undoButton.centerYAnchor.constraint(equalTo: shutterButton.centerYAnchor),
    ])
  }
}

private extension simd_float4 {
  var xyz: simd_float3 { simd_float3(x, y, z) }
}

private extension simd_float4x4 {
  var position: simd_float3 { columns.3.xyz }
}
