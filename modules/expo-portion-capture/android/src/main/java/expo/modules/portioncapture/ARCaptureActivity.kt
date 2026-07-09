package expo.modules.portioncapture

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.ImageFormat
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.YuvImage
import android.os.SystemClock
import android.media.Image
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.opengl.Matrix
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import com.google.ar.core.ArCoreApk
import com.google.ar.core.Camera
import com.google.ar.core.CameraConfig
import com.google.ar.core.CameraConfigFilter
import com.google.ar.core.Config
import com.google.ar.core.Frame
import com.google.ar.core.HitResult
import com.google.ar.core.Plane
import com.google.ar.core.Pose
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.NotYetAvailableException
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Full-screen ARCore capture with a center reticle and a hold-to-measure
 * trigger (the 45 lb plate button): aim the reticle, hold the plate to anchor
 * point A, move the phone to stretch the ruler, release to commit — the
 * finger never covers the food. Raycasts hit any tracked surface (planes in
 * any orientation, depth points, feature points), so measuring is never
 * gated on table detection; a detected support plane still improves the
 * portion math (MATH.md §3) and the coaching says so.
 *
 * Emits the same versioned CapturePayload as the iOS module
 * (packages/pipeline contracts; ARCore's physical-camera pose shares ARKit's
 * y-up/z-backward convention).
 */
class ARCaptureActivity : Activity(), GLSurfaceView.Renderer {
  companion object {
    const val EXTRA_REQUIRE_STROKE = "requireStroke"
    const val EXTRA_MIN_STROKE_M = "minStrokeLengthM"
    private const val CAMERA_PERMISSION_CODE = 41
    private const val MIN_COMMIT_LENGTH_M = 0.005f

    /** Beyond this, raycast + pixel resolution degrade; meals are shot < 1 m. */
    private const val FAR_WARN_M = 1.5f

    /** Finger-to-reticle amplification for the plate trackpad. */
    private const val PAD_GAIN = 2.2f

    // Anchor/endpoint stabilization (MATH.md §2.4): shake-gated samples,
    // component-wise medians. 1° of tremor at 40 cm swings a raw endpoint
    // ~7 mm; a median over ~6 accepted frames cuts that ~2.5× and absorbs
    // the press/lift jolt spikes entirely.
    private const val STEADY_WINDOW = 6
    private const val SHAKE_LINEAR_M_S = 1.0f
    private const val SHAKE_ANGULAR_RAD_S = 1.5f
    private const val PLANE_SNAP_M = 0.008f

    // Motion-blur shutter gate (CAPTURE_QUALITY.md R6). Tracking-normal says VIO
    // is healthy, not that the frozen frame is sharp: ~10°/s of hand drift at
    // 1/30 s smears ~9 px. These thresholds are far tighter than the measuring
    // gate above — a still needs the phone genuinely still — but we only DELAY a
    // photo by a few frames (never starve a buffer), so strict is safe here.
    private const val SHOOT_LINEAR_M_S = 0.30f
    private const val SHOOT_ANGULAR_RAD_S = 0.30f
    /** Wait at most this long for a calm frame before shooting anyway. */
    private const val SHOOT_GRACE_MS = 350L

    /** Below this ambient pixel intensity (~0–1), low light hurts accuracy. */
    private const val DARK_PIXEL_INTENSITY = 0.25f
    /** Beyond this camera-axis-vs-plane-normal angle, coach a more top-down shot. */
    private const val TILT_WARN_DEG = 45f
    /** DEPTH16 low 13 bits hold millimeters; masking is range-safe below 8.19 m
     *  (every meal is well inside it), sidestepping the confidence-bit ambiguity. */
    private const val DEPTH16_MM_MASK = 0x1FFF
  }

  private class Stroke(val p1: FloatArray, val p2: FloatArray, val kind: String) {
    val lengthM: Float get() = dist(p1, p2)
  }

  private lateinit var glView: GLSurfaceView
  private lateinit var rulerOverlay: RulerOverlay
  private lateinit var measureLabel: TextView
  private lateinit var hintLabel: TextView
  private lateinit var shutterButton: Button
  private lateinit var undoButton: Button
  private lateinit var torchButton: Button
  private lateinit var plateButton: PlateButton
  private lateinit var rotationHelper: DisplayRotationHelper
  private val background = BackgroundRenderer()

  private var session: Session? = null
  private var installRequested = false
  private var textureBound = false

  private var requireStroke = true
  private var minStrokeLengthM = 0.10f

  // GL-thread state
  private val strokes = mutableListOf<Stroke>()
  private var activeStart: FloatArray? = null
  private var activeEnd: FloatArray? = null
  private var reticlePoint: FloatArray? = null
  private var reticleDistanceM: Float? = null
  private var reticleX = 0f
  private var reticleY = 0f

  // Plate-trackpad steering (UI thread writes, GL thread reads).
  @Volatile private var padDx = 0f
  @Volatile private var padDy = 0f

  // Stabilization state (GL thread).
  private val steadySamples = ArrayDeque<FloatArray>()
  private var prevPose: Pose? = null
  private var prevTimestampNs = 0L
  // Latest pose-delta speeds (GL thread) — reused by the blur gate (R6) and the
  // capture_quality telemetry (R8); written every frame in isShaky().
  private var lastLinearMS = 0f
  private var lastAngularRadS = 0f
  // Per-frame capture-quality signals (GL thread write, telemetry/coaching read).
  private var viewAngleDeg = 90f
  @Volatile private var lightPixelIntensity = -1f
  private var introUntilMs = 0L
  private var activeOffTarget = false
  private var activeFar = false
  private var funnyShown = false
  private var lockedPlane: Plane? = null
  private var fallbackNormal: FloatArray? = null
  private var fallbackPoint: FloatArray? = null

  // UI-thread → GL-thread signals
  @Volatile private var measureHeld = false
  @Volatile private var captureRequested = false
  @Volatile private var captureRequestedAtMs = 0L
  @Volatile private var torchOn = false
  @Volatile private var undoRequested = false
  @Volatile private var shutterReady = false
  private var delivered = false
  private var lastLabel = ""
  private var lastHint = ""
  private var lastShutterEnabled = false

  // MARK: lifecycle

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    requireStroke = intent.getBooleanExtra(EXTRA_REQUIRE_STROKE, true)
    minStrokeLengthM = intent.getFloatExtra(EXTRA_MIN_STROKE_M, 0.10f)

    glView = GLSurfaceView(this).apply {
      setEGLContextClientVersion(2)
      preserveEGLContextOnPause = true
      setRenderer(this@ARCaptureActivity)
      renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
    }
    rulerOverlay = RulerOverlay(this)
    rotationHelper = DisplayRotationHelper(this)
    setContentView(buildLayout())
    hintLabel.text = "Hold the phone steady above the food — screen parallel to the table reads best"
    introUntilMs = SystemClock.uptimeMillis() + 4000
  }

  override fun onResume() {
    super.onResume()
    if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.CAMERA), CAMERA_PERMISSION_CODE)
      return
    }
    if (!ensureSession()) return
    try {
      session?.resume()
    } catch (e: Exception) {
      finishWith(null, "Camera unavailable: ${e.message}")
      return
    }
    glView.onResume()
    rotationHelper.onResume()
  }

  override fun onPause() {
    super.onPause()
    rotationHelper.onPause()
    glView.onPause()
    session?.pause()
  }

  override fun onDestroy() {
    super.onDestroy()
    session?.close()
    session = null
    if (!delivered) {
      delivered = true
      CaptureBridge.deliver(null)
    }
  }

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    finishWith(null, null)
  }

  override fun onRequestPermissionsResult(code: Int, permissions: Array<String>, results: IntArray) {
    super.onRequestPermissionsResult(code, permissions, results)
    if (code == CAMERA_PERMISSION_CODE &&
      (results.isEmpty() || results[0] != PackageManager.PERMISSION_GRANTED)
    ) {
      finishWith(null, null)
    }
  }

  private fun ensureSession(): Boolean {
    if (session != null) return true
    return try {
      when (ArCoreApk.getInstance().requestInstall(this, !installRequested)) {
        ArCoreApk.InstallStatus.INSTALL_REQUESTED -> {
          installRequested = true
          false // resumes again after the Play Services for AR install flow
        }
        ArCoreApk.InstallStatus.INSTALLED -> {
          val created = Session(this)
          selectHighResCameraConfig(created)
          applyConfig(created)
          session = created
          true
        }
      }
    } catch (e: Exception) {
      finishWith(null, "ARCore unavailable: ${e.message}")
      false
    }
  }

  /**
   * Pick the largest-area CPU image config (CAPTURE_QUALITY.md R1). ARCore's
   * default CPU stream is 640×480 on many devices — the GL preview looks sharp,
   * which hides that `acquireCameraImage()`, the stored JPEG, and every
   * pixel→meter conversion inherit 0.3 MP. `camera.imageIntrinsics` tracks the
   * chosen size automatically, so the payload stays self-consistent. Tie-break
   * toward configs that keep the depth sensor usable so R3 isn't disabled.
   */
  private fun selectHighResCameraConfig(session: Session) {
    try {
      val filter = CameraConfigFilter(session)
        .setFacingDirection(CameraConfig.FacingDirection.BACK)
      val configs = session.getSupportedCameraConfigs(filter)
      val best = configs
        .sortedWith(
          compareByDescending<CameraConfig> { it.imageSize.width.toLong() * it.imageSize.height }
            .thenByDescending { it.depthSensorUsage == CameraConfig.DepthSensorUsage.REQUIRE_AND_USE }
        )
        .firstOrNull()
      if (best != null) session.cameraConfig = best
    } catch (e: Exception) {
      // Keep ARCore's default config; capture still works, just lower-res.
    }
  }

  /**
   * (Re)apply the session config. Extracted so the torch toggle (R7) can flip
   * `flashMode` and reconfigure without rebuilding the session. Ambient light
   * estimation feeds the low-light coaching + telemetry (R7/R8).
   */
  private fun applyConfig(session: Session) {
    session.configure(
      Config(session).apply {
        // Planes in any orientation, plus depth where the hardware provides it —
        // the ruler is free to hit any surface.
        planeFindingMode = Config.PlaneFindingMode.HORIZONTAL_AND_VERTICAL
        updateMode = Config.UpdateMode.LATEST_CAMERA_IMAGE
        focusMode = Config.FocusMode.AUTO
        lightEstimationMode = Config.LightEstimationMode.AMBIENT_INTENSITY
        depthMode = if (session.isDepthModeSupported(Config.DepthMode.AUTOMATIC)) {
          Config.DepthMode.AUTOMATIC
        } else {
          Config.DepthMode.DISABLED
        }
        flashMode = if (torchOn) Config.FlashMode.TORCH else Config.FlashMode.OFF
      }
    )
  }

  private fun toggleTorch() {
    val session = session ?: return
    torchOn = !torchOn
    try {
      applyConfig(session)
    } catch (e: Exception) {
      torchOn = false // device without a controllable flash — TORCH is a no-op
    }
    runOnUiThread { torchButton.text = if (torchOn) "Torch ●" else "Torch ○" }
  }

  private fun finishWith(payload: HashMap<String, Any?>?, message: String?) {
    if (!delivered) {
      delivered = true
      CaptureBridge.deliver(payload)
    }
    message?.let { runOnUiThread { measureLabel.text = it } }
    finish()
  }

  // MARK: GLSurfaceView.Renderer (GL thread)

  override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
    GLES20.glClearColor(0f, 0f, 0f, 1f)
    background.createOnGlThread()
    textureBound = false
  }

  override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
    GLES20.glViewport(0, 0, width, height)
    rotationHelper.onSurfaceChanged(width, height)
  }

  override fun onDrawFrame(gl: GL10?) {
    GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
    val session = session ?: return
    if (!textureBound) {
      session.setCameraTextureName(background.textureId)
      textureBound = true
    }
    rotationHelper.updateSessionIfNeeded(session)

    val frame = try {
      session.update()
    } catch (e: Exception) {
      return
    }
    background.draw(frame)

    val camera = frame.camera
    if (undoRequested) {
      undoRequested = false
      strokes.removeLastOrNull()
    }
    lightPixelIntensity = try {
      frame.lightEstimate.takeIf { it.state == com.google.ar.core.LightEstimate.State.VALID }
        ?.pixelIntensity ?: -1f
    } catch (e: Exception) {
      -1f
    }

    updateReticleAndMeasure(frame, camera)
    publishOverlay(camera)

    if (captureRequested) {
      when {
        camera.trackingState != TrackingState.TRACKING ->
          postLabel("Hold steady — tracking is limited")
        // R6: refuse to freeze a blurred frame while the phone is still moving,
        // but never trap the user — after the grace window, shoot regardless.
        isTooShakyToShoot() && !shootGraceExpired() ->
          postLabel("Steadying the shot — hold still…")
        else ->
          try {
            val payload = buildPayload(frame, camera)
            captureRequested = false
            runOnUiThread { finishWith(payload, null) }
          } catch (e: NotYetAvailableException) {
            // CPU image lags the GPU frame occasionally; retry next frame.
          } catch (e: Exception) {
            captureRequested = false
            postLabel("Capture failed: ${e.message}")
          }
      }
    }
  }

  private fun isTooShakyToShoot(): Boolean =
    lastLinearMS > SHOOT_LINEAR_M_S || lastAngularRadS > SHOOT_ANGULAR_RAD_S

  private fun shootGraceExpired(): Boolean =
    captureRequestedAtMs != 0L && SystemClock.uptimeMillis() - captureRequestedAtMs > SHOOT_GRACE_MS

  // MARK: reticle + hold-to-measure (MATH.md §2.3), GL thread

  private fun updateReticleAndMeasure(frame: Frame, camera: Camera) {
    if (camera.trackingState != TrackingState.TRACKING) {
      reticlePoint = null
      steadySamples.clear()
      return
    }
    val w = glView.width
    val h = glView.height
    if (w == 0 || h == 0) return

    val shaky = isShaky(frame, camera)

    // The plate trackpad steers the reticle, so the phone stays steady.
    reticleX = w / 2f + (padDx * PAD_GAIN).coerceIn(-w * 0.42f, w * 0.42f)
    reticleY = h / 2f + (padDy * PAD_GAIN).coerceIn(-h * 0.42f, h * 0.42f)
    val hit = bestHit(frame, reticleX, reticleY)
    val rawPoint = hit?.hitPose?.translation?.let(::snapToSupportPlane)
    reticlePoint = rawPoint
    reticleDistanceM = rawPoint?.let { dist(it, camera.pose.translation) }

    // View obliquity: angle between the camera optical axis (−z) and straight
    // down the plane normal. 0° = top-down, which the homography + off-plane
    // math (MATH.md §3, §3.2) both prefer. Feeds R5 coaching + R8 telemetry.
    viewAngleDeg = angleBetweenDeg(negate(camera.pose.zAxis), negate(planeNormal()))

    // Robust endpoint (MATH.md §2.4): shake-gated samples, component-wise
    // median over recent frames. Tremor and the press/lift jolts are
    // zero-mean spikes; the median absorbs them.
    if (rawPoint == null) {
      steadySamples.clear()
    } else if (!shaky) {
      steadySamples.addLast(rawPoint)
      while (steadySamples.size > STEADY_WINDOW) steadySamples.removeFirst()
    }
    val steadyPoint = if (steadySamples.isEmpty()) rawPoint else medianPoint(steadySamples)

    if (measureHeld) {
      if (activeStart == null) {
        if (rawPoint != null && hit != null) {
          rememberPlane(hit)
          // Wall or ceiling anchor: definitely off-mission, never a table
          // at a bad angle (those detect horizontal-upward or fail).
          val anchorPlane = hit.trackable as? Plane
          activeOffTarget = anchorPlane != null &&
            anchorPlane.type != Plane.Type.HORIZONTAL_UPWARD_FACING
          activeFar = (reticleDistanceM ?: 0f) > FAR_WARN_M
          // Anchor instantly, from the PRE-press median: the buffer filled
          // before the finger jolt could contaminate it.
          activeStart =
            if (steadySamples.isNotEmpty()) medianPoint(steadySamples) else rawPoint
          activeEnd = activeStart
        } else {
          postLabel("Aim the sparkle at a surface first")
        }
      } else if (steadyPoint != null) {
        activeEnd = steadyPoint
        postLabel(formatMeters(dist(activeStart!!, steadyPoint)))
      }
    } else if (activeStart != null) {
      // Released: commit with the median-filtered (pre-lift-jolt) endpoint.
      val start = activeStart
      val end = activeEnd
      activeStart = null
      activeEnd = null
      if (start != null && end != null) {
        val length = dist(start, end)
        if (length < MIN_COMMIT_LENGTH_M) {
          postLabel("Too short — slide your finger further while holding the plate")
        } else {
          val direction = normalized(sub(end, start))
          val vertical = abs(dot(direction, planeNormal())) > 0.7f
          strokes.add(Stroke(start, end, if (vertical) "vertical" else "horizontal"))
          val far = activeFar || (reticleDistanceM ?: 0f) > FAR_WARN_M
          val note = when {
            activeOffTarget && !funnyShown -> {
              funnyShown = true
              " — not what this is for, but fine :)"
            }
            far -> " (measured far away — accuracy drops out here)"
            else -> ""
          }
          postLabel(formatMeters(length) + note)
        }
      }
    }
  }

  /**
   * Hit preference: plane-within-polygon → any tracked plane → depth/feature
   * points (free-space measuring — no table required).
   */
  private fun bestHit(frame: Frame, x: Float, y: Float): HitResult? {
    val hits = frame.hitTest(x, y)
    return hits.firstOrNull { hit ->
      val plane = hit.trackable as? Plane
      plane != null && plane.trackingState == TrackingState.TRACKING &&
        plane.isPoseInPolygon(hit.hitPose)
    } ?: hits.firstOrNull { hit ->
      (hit.trackable as? Plane)?.trackingState == TrackingState.TRACKING
    } ?: hits.firstOrNull { it.trackable !is Plane }
  }

  private fun rememberPlane(hit: HitResult) {
    val plane = hit.trackable as? Plane
    if (plane != null && plane.type == Plane.Type.HORIZONTAL_UPWARD_FACING) {
      lockedPlane = plane
    } else if (fallbackNormal == null) {
      fallbackNormal = hit.hitPose.yAxis
      fallbackPoint = hit.hitPose.translation
    }
  }

  private fun planeNormal(): FloatArray =
    lockedPlane?.centerPose?.yAxis ?: fallbackNormal ?: floatArrayOf(0f, 1f, 0f)

  /**
   * Shake gate for VIOLENT motion only (fast swings, hard jolts) — pose-delta
   * linear + angular velocity. Ordinary tremor passes through; filtering it
   * is the medians' job. Thresholds must stay generous: a strict gate starves
   * the buffers and blocks measuring outright.
   */
  private fun isShaky(frame: Frame, camera: Camera): Boolean {
    val pose = camera.pose
    val nowNs = frame.timestamp
    val prev = prevPose
    val prevNs = prevTimestampNs
    prevPose = pose
    prevTimestampNs = nowNs
    if (prev == null || prevNs == 0L || nowNs <= prevNs) {
      lastLinearMS = 0f; lastAngularRadS = 0f // unknown motion ⇒ treat as steady
      return false
    }
    val dt = (nowNs - prevNs) / 1e9f
    if (dt > 0.25f) {
      lastLinearMS = 0f; lastAngularRadS = 0f
      return false
    }
    val linear = dist(pose.translation, prev.translation) / dt
    val q1 = FloatArray(4).also { prev.getRotationQuaternion(it, 0) }
    val q2 = FloatArray(4).also { pose.getRotationQuaternion(it, 0) }
    val qDot = abs(q1[0] * q2[0] + q1[1] * q2[1] + q1[2] * q2[2] + q1[3] * q2[3])
      .coerceAtMost(1f)
    val angular = 2f * acos(qDot) / dt
    // Cached for the R6 blur gate and R8 telemetry (both read the latest speeds).
    lastLinearMS = linear
    lastAngularRadS = angular
    return linear > SHAKE_LINEAR_M_S || angular > SHAKE_ANGULAR_RAD_S
  }

  /**
   * Points within a few mm of the locked support plane snap onto it — the
   * plane is temporally filtered by ARCore and far steadier than per-frame
   * hits. Height strokes (several cm above) pass through untouched.
   */
  private fun snapToSupportPlane(p: FloatArray): FloatArray {
    val plane = lockedPlane ?: return p
    if (plane.trackingState != TrackingState.TRACKING) return p
    val n = normalized(plane.centerPose.yAxis)
    val offset = dot(sub(p, plane.centerPose.translation), n)
    if (abs(offset) >= PLANE_SNAP_M) return p
    return floatArrayOf(p[0] - n[0] * offset, p[1] - n[1] * offset, p[2] - n[2] * offset)
  }

  /** Component-wise median — robust to the outlier frames a mean would chase. */
  private fun medianPoint(samples: Collection<FloatArray>): FloatArray {
    fun med(index: Int): Float {
      val sorted = samples.map { it[index] }.sorted()
      return sorted[sorted.size / 2]
    }
    return floatArrayOf(med(0), med(1), med(2))
  }

  // MARK: overlay projection (GL thread → UI thread)

  private fun publishOverlay(camera: Camera) {
    val segments = mutableListOf<RulerOverlay.Segment>()
    val tracking = camera.trackingState == TrackingState.TRACKING
    if (tracking) {
      val view = FloatArray(16)
      val proj = FloatArray(16)
      val vp = FloatArray(16)
      camera.getViewMatrix(view, 0)
      camera.getProjectionMatrix(proj, 0, 0.05f, 20f)
      Matrix.multiplyMM(vp, 0, proj, 0, view, 0)
      val w = glView.width.toFloat()
      val h = glView.height.toFloat()

      fun project(p: FloatArray): FloatArray? {
        val v = floatArrayOf(p[0], p[1], p[2], 1f)
        val o = FloatArray(4)
        Matrix.multiplyMV(o, 0, vp, 0, v, 0)
        if (o[3] <= 0f) return null
        return floatArrayOf((o[0] / o[3] + 1f) / 2f * w, (1f - o[1] / o[3]) / 2f * h)
      }

      for (stroke in strokes) {
        val a = project(stroke.p1) ?: continue
        val b = project(stroke.p2) ?: continue
        segments.add(
          RulerOverlay.Segment(a[0], a[1], b[0], b[1], formatMeters(stroke.lengthM), false)
        )
      }
      val start = activeStart
      val end = activeEnd
      if (start != null && end != null) {
        val a = project(start)
        val b = project(end)
        if (a != null && b != null) {
          segments.add(
            RulerOverlay.Segment(a[0], a[1], b[0], b[1], formatMeters(dist(start, end)), true)
          )
        }
      }
    }
    rulerOverlay.publish(
      segments,
      reticleLocked = tracking && reticlePoint != null,
      reticleX = reticleX,
      reticleY = reticleY,
    )

    val ready = !requireStroke ||
      strokes.any { it.kind == "horizontal" && it.lengthM >= minStrokeLengthM }
    shutterReady = ready
    if (ready != lastShutterEnabled) {
      lastShutterEnabled = ready
      runOnUiThread { shutterButton.alpha = if (ready) 1f else 0.4f }
    }

    // Live coaching: the hint always states the next action. The intro tip
    // (hold steady, parallel to the table) owns the first few seconds.
    if (SystemClock.uptimeMillis() < introUntilMs && !measureHeld && strokes.isEmpty()) return
    val reticleDist = reticleDistanceM
    postHint(
      when {
        !tracking -> "Move the phone slowly so tracking can start…"
        measureHeld || activeStart != null ->
          "Hold the phone steady — slide your finger to sweep, release to set"
        reticleDist != null && reticleDist > FAR_WARN_M ->
          "That's ${formatMeters(reticleDist)} away — too far to read well, move closer"
        reticlePoint != null && viewAngleDeg > TILT_WARN_DEG ->
          "Tilt more top-down — shooting flat-on reads portions best"
        lightPixelIntensity in 0f..DARK_PIXEL_INTENSITY ->
          "A bit dark — more light (or the torch) sharpens the estimate"
        ready && lockedPlane == null ->
          "Ready — sweeping the table into view sharpens portion accuracy"
        ready -> "Add a height measurement up the food, or shoot"
        reticlePoint == null -> "Point the sparkle at the food or table…"
        else ->
          "Hold the phone steady; hold the plate and slide your finger " +
            "≥ ${(minStrokeLengthM * 100).toInt()} cm across the food"
      }
    )
  }

  private fun postLabel(text: String) {
    if (text == lastLabel) return
    lastLabel = text
    runOnUiThread { measureLabel.text = text }
  }

  private fun postHint(text: String) {
    if (text == lastHint) return
    lastHint = text
    runOnUiThread { hintLabel.text = text }
  }

  // MARK: payload (docs/ARCHITECTURE.md contract), GL thread

  private fun buildPayload(frame: Frame, camera: Camera): HashMap<String, Any?> {
    val directory = File(cacheDir, "portion-capture-${UUID.randomUUID()}")
    directory.mkdirs()

    // 1. Sensor-oriented CPU image → JPEG. Pixel coordinates in the payload
    //    refer to this stored image (MATH.md §9.2).
    val image = frame.acquireCameraImage()
    val (imageFile, width, height) = try {
      val file = File(directory, "capture.jpg")
      file.writeBytes(yuvToJpeg(image))
      Triple(file, image.width, image.height)
    } finally {
      image.close()
    }

    // 2. Intrinsics for that image (physical camera, same sensor frame).
    val intrinsics = camera.imageIntrinsics
    val f = intrinsics.focalLength
    val c = intrinsics.principalPoint

    // 3. Physical camera pose: x right, y up, z backward — the ARKit
    //    convention, serialized row-major exactly like the iOS module.
    val columnMajor = FloatArray(16)
    camera.pose.toMatrix(columnMajor, 0)
    val cameraToWorld = ArrayList<Float>(16)
    for (r in 0 until 4) for (col in 0 until 4) cameraToWorld.add(columnMajor[col * 4 + r])

    // 4. The supporting plane: n·X = d0.
    val plane = lockedPlane
    val normal: FloatArray
    val point: FloatArray
    var extent: List<Float>? = null
    when {
      plane != null && plane.trackingState == TrackingState.TRACKING -> {
        normal = plane.centerPose.yAxis
        point = plane.centerPose.translation
        extent = listOf(plane.extentX, plane.extentZ)
      }
      fallbackNormal != null -> {
        normal = fallbackNormal!!
        point = fallbackPoint!!
      }
      strokes.isNotEmpty() -> {
        normal = floatArrayOf(0f, 1f, 0f)
        point = strokes.first().p1
      }
      else -> throw IllegalStateException("Measure at least one stroke before capturing")
    }
    val n = normalized(normal)
    val d0 = dot(n, point)

    val horizontalOk = strokes.any { it.kind == "horizontal" && it.lengthM >= minStrokeLengthM }

    // 5. Depth, when the hardware measures it (R3) — no longer dropped. Upgrades
    //    the scale source to the depth tier (MATH.md §7) and unlocks the §4a
    //    height-field volume route on ARCore depth devices.
    val depthDict: HashMap<String, Any?>? =
      if (session?.config?.depthMode != Config.DepthMode.DISABLED) {
        try {
          frame.acquireDepthImage16Bits().use { depth ->
            writeDepth(depth, directory, intrinsics, width, height)
          }
        } catch (e: NotYetAvailableException) {
          null
        } catch (e: Exception) {
          null
        }
      } else {
        null
      }

    val cameraHeightM = abs(dot(sub(camera.pose.translation, point), n)).coerceAtLeast(1e-4f)

    return hashMapOf(
      "version" to 1,
      "image" to "file://${imageFile.absolutePath}",
      "image_size" to listOf(width, height),
      "intrinsics" to listOf(
        listOf(f[0], 0f, c[0]),
        listOf(0f, f[1], c[1]),
        listOf(0f, 0f, 1f),
      ),
      "camera_to_world" to cameraToWorld,
      "plane" to hashMapOf(
        "normal" to listOf(n[0], n[1], n[2]),
        "d0" to d0,
        "extent" to extent,
      ),
      "strokes" to strokes.map {
        hashMapOf(
          "p1" to listOf(it.p1[0], it.p1[1], it.p1[2]),
          "p2" to listOf(it.p2[0], it.p2[1], it.p2[2]),
          "length_m" to it.lengthM,
          "kind" to it.kind,
        )
      },
      "depth" to depthDict,
      "tracking" to hashMapOf(
        // R9: report the real tracking state instead of a hardcoded "normal".
        "state" to trackingStateName(camera.trackingState),
        "plane_source" to if (plane != null) "detected_plane" else "estimated",
      ),
      // Depth present ⇒ depth-tier scale (mirrors iOS "lidar"); else the ruler,
      // else nothing.
      "scale_source" to when {
        depthDict != null -> "lidar"
        horizontalOk -> "ruler"
        else -> "none"
      },
      // R8: capture-condition telemetry (CAPTURE_QUALITY.md). Additive/optional.
      "capture_quality" to hashMapOf(
        "light_estimate" to (if (lightPixelIntensity >= 0f) lightPixelIntensity else null),
        "exposure_duration_s" to null, // ARCore doesn't surface exposure duration
        "camera_speed_m_s" to lastLinearMS,
        "camera_speed_rad_s" to lastAngularRadS,
        "view_angle_deg" to viewAngleDeg,
        "distance_m" to cameraHeightM,
      ),
    )
  }

  private fun trackingStateName(state: TrackingState): String = when (state) {
    TrackingState.TRACKING -> "normal"
    TrackingState.PAUSED -> "limited"
    TrackingState.STOPPED -> "not_available"
  }

  /**
   * DEPTH16 image → f32-meters sidecar (little-endian, row-major, tightly
   * packed), with the RGB intrinsics rescaled to the depth resolution
   * (MATH.md §9.1) exactly as the iOS module does. Confidence is left null;
   * per-pixel confidence via the Raw Depth API is a follow-up (R3 note).
   */
  private fun writeDepth(
    depth: Image,
    directory: File,
    rgb: com.google.ar.core.CameraIntrinsics,
    rgbW: Int,
    rgbH: Int,
  ): HashMap<String, Any?> {
    val w = depth.width
    val h = depth.height
    val plane = depth.planes[0]
    val shorts = plane.buffer.order(ByteOrder.nativeOrder()).asShortBuffer()
    val rowStrideShorts = plane.rowStride / 2
    val pixelStrideShorts = (plane.pixelStride / 2).coerceAtLeast(1)

    val out = ByteBuffer.allocate(w * h * 4).order(ByteOrder.LITTLE_ENDIAN)
    for (row in 0 until h) {
      var idx = row * rowStrideShorts
      for (col in 0 until w) {
        val mm = shorts.get(idx).toInt() and DEPTH16_MM_MASK
        out.putFloat(mm / 1000f)
        idx += pixelStrideShorts
      }
    }
    val depthFile = File(directory, "depth.f32")
    depthFile.writeBytes(out.array())

    val f = rgb.focalLength
    val c = rgb.principalPoint
    val sx = w.toFloat() / rgbW
    val sy = h.toFloat() / rgbH
    return hashMapOf(
      "map" to "file://${depthFile.absolutePath}",
      "confidence" to null,
      "size" to listOf(w, h),
      "intrinsics" to listOf(
        listOf(f[0] * sx, 0f, c[0] * sx),
        listOf(0f, f[1] * sy, c[1] * sy),
        listOf(0f, 0f, 1f),
      ),
    )
  }

  /** YUV_420_888 → NV21 → JPEG (quality 92). Absolute-indexed reads. */
  private fun yuvToJpeg(image: Image): ByteArray {
    val width = image.width
    val height = image.height
    val nv21 = ByteArray(width * height * 3 / 2)
    val yPlane = image.planes[0]
    val uPlane = image.planes[1]
    val vPlane = image.planes[2]

    var out = 0
    for (row in 0 until height) {
      val base = row * yPlane.rowStride
      for (col in 0 until width) {
        nv21[out++] = yPlane.buffer.get(base + col * yPlane.pixelStride)
      }
    }
    for (row in 0 until height / 2) {
      val vBase = row * vPlane.rowStride
      val uBase = row * uPlane.rowStride
      for (col in 0 until width / 2) {
        nv21[out++] = vPlane.buffer.get(vBase + col * vPlane.pixelStride)
        nv21[out++] = uPlane.buffer.get(uBase + col * uPlane.pixelStride)
      }
    }

    val stream = ByteArrayOutputStream()
    YuvImage(nv21, ImageFormat.NV21, width, height, null)
      .compressToJpeg(Rect(0, 0, width, height), 92, stream)
    return stream.toByteArray()
  }

  // MARK: chrome

  private fun buildLayout(): FrameLayout {
    val density = resources.displayMetrics.density
    fun dp(v: Int) = (v * density).toInt()

    measureLabel = TextView(this).apply {
      setTextColor(Color.WHITE)
      textSize = 20f
      gravity = Gravity.CENTER
    }
    hintLabel = TextView(this).apply {
      setTextColor(0xD9FFFFFF.toInt())
      textSize = 13f
      gravity = Gravity.CENTER
    }
    plateButton = PlateButton(
      this,
      onHoldChange = { held ->
        measureHeld = held
        if (!held) {
          // Reticle recenters after each stroke for a predictable next aim.
          padDx = 0f
          padDy = 0f
        }
      },
      onDrag = { dx, dy ->
        padDx = dx
        padDy = dy
      },
    )
    shutterButton = Button(this).apply {
      text = "●"
      textSize = 24f
      alpha = 0.4f
      // Always clickable: a dimmed shutter explains itself when tapped.
      setOnClickListener {
        if (shutterReady) {
          captureRequestedAtMs = SystemClock.uptimeMillis() // R6 grace-window start
          captureRequested = true
        } else {
          measureLabel.text =
            "Measure a ≥ ${(minStrokeLengthM * 100).toInt()} cm span with the plate first"
        }
      }
    }
    undoButton = Button(this).apply {
      text = "Undo"
      setOnClickListener { undoRequested = true }
    }
    torchButton = Button(this).apply {
      text = "Torch ○"
      setOnClickListener { toggleTorch() }
    }
    fun params(gravity: Int, marginBottom: Int = 0, marginTop: Int = 0) =
      FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.WRAP_CONTENT,
        FrameLayout.LayoutParams.WRAP_CONTENT,
        gravity,
      ).apply {
        bottomMargin = dp(marginBottom)
        topMargin = dp(marginTop)
        leftMargin = dp(16)
        rightMargin = dp(16)
      }

    return FrameLayout(this).apply {
      addView(glView, FrameLayout.LayoutParams(-1, -1))
      addView(rulerOverlay, FrameLayout.LayoutParams(-1, -1))
      addView(measureLabel, params(Gravity.TOP or Gravity.CENTER_HORIZONTAL, marginTop = 44))
      addView(hintLabel, params(Gravity.TOP or Gravity.CENTER_HORIZONTAL, marginTop = 80))
      addView(
        plateButton,
        FrameLayout.LayoutParams(dp(148), dp(148), Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL)
          .apply { bottomMargin = dp(20) },
      )
      addView(shutterButton, params(Gravity.BOTTOM or Gravity.END, marginBottom = 44))
      addView(undoButton, params(Gravity.BOTTOM or Gravity.START, marginBottom = 44))
      addView(torchButton, params(Gravity.TOP or Gravity.END, marginTop = 44))
    }
  }
}

/**
 * 2D overlay: the steerable reticle plus strokes projected to screen space
 * each frame. The reticle is an AI sparkle — a four-point star with two
 * softly pulsing glitter specks — inside a target ring: solid yellow when
 * locked onto a surface, dashed while searching.
 */
class RulerOverlay(context: Activity) : View(context) {
  class Segment(
    val x1: Float, val y1: Float, val x2: Float, val y2: Float,
    val label: String, val active: Boolean,
  )

  @Volatile private var segments: List<Segment> = emptyList()
  @Volatile private var reticleLocked = false
  @Volatile private var reticleX = -1f
  @Volatile private var reticleY = -1f

  private val density = context.resources.displayMetrics.density

  private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.YELLOW
    strokeWidth = 6f
    strokeCap = Paint.Cap.ROUND
  }
  private val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.YELLOW }
  private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE
    textSize = 40f
    setShadowLayer(4f, 0f, 0f, Color.BLACK)
  }
  private val reticleLockedPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    color = Color.YELLOW
    strokeWidth = 3f * density
  }
  private val reticleSearchPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    color = 0xB3FFFFFF.toInt()
    strokeWidth = 2f * density
    pathEffect = DashPathEffect(floatArrayOf(6f * density, 5f * density), 0f)
  }
  private val sparklePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    setShadowLayer(4f, 0f, 0f, Color.BLACK)
  }
  private val sparklePath = Path()

  fun publish(
    nextSegments: List<Segment>,
    reticleLocked: Boolean,
    reticleX: Float,
    reticleY: Float,
  ) {
    segments = nextSegments
    this.reticleLocked = reticleLocked
    this.reticleX = reticleX
    this.reticleY = reticleY
    postInvalidateOnAnimation()
  }

  override fun onDraw(canvas: Canvas) {
    for (segment in segments) {
      line.alpha = if (segment.active) 255 else 200
      canvas.drawLine(segment.x1, segment.y1, segment.x2, segment.y2, line)
      canvas.drawCircle(segment.x1, segment.y1, 10f, dot)
      canvas.drawCircle(segment.x2, segment.y2, 10f, dot)
      canvas.drawText(
        segment.label,
        (segment.x1 + segment.x2) / 2f + 14f,
        (segment.y1 + segment.y2) / 2f - 14f,
        text,
      )
    }

    // The reticle: where the next anchor lands (steered by the plate).
    val cx = if (reticleX >= 0f) reticleX else width / 2f
    val cy = if (reticleY >= 0f) reticleY else height / 2f
    val r = 26f * density
    canvas.drawCircle(cx, cy, r, if (reticleLocked) reticleLockedPaint else reticleSearchPaint)

    // The AI sparkle + two glitter specks, gently breathing out of phase.
    val color = if (reticleLocked) Color.YELLOW else 0xE6FFFFFF.toInt()
    val t = SystemClock.uptimeMillis()
    drawSparkle(canvas, cx, cy, r * 0.46f, color, 255)
    drawSparkle(
      canvas, cx + r * 0.58f, cy - r * 0.52f, r * 0.17f, color,
      (170 + 85 * sin(t / 240.0)).toInt().coerceIn(60, 255),
    )
    drawSparkle(
      canvas, cx - r * 0.62f, cy + r * 0.44f, r * 0.12f, color,
      (170 + 85 * sin(t / 240.0 + 2.2)).toInt().coerceIn(60, 255),
    )
  }

  /** The four-point AI star: quadratic curves pinched through the center. */
  private fun drawSparkle(canvas: Canvas, x: Float, y: Float, r: Float, color: Int, alpha: Int) {
    sparklePaint.color = color
    sparklePaint.alpha = alpha
    sparklePath.reset()
    sparklePath.moveTo(x, y - r)
    sparklePath.quadTo(x, y, x + r, y)
    sparklePath.quadTo(x, y, x, y + r)
    sparklePath.quadTo(x, y, x - r, y)
    sparklePath.quadTo(x, y, x, y - r)
    sparklePath.close()
    canvas.drawPath(sparklePath, sparklePaint)
  }
}

// Small vector helpers shared by the activity.
private fun sub(a: FloatArray, b: FloatArray) =
  floatArrayOf(a[0] - b[0], a[1] - b[1], a[2] - b[2])

private fun dot(a: FloatArray, b: FloatArray) =
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

private fun dist(a: FloatArray, b: FloatArray): Float {
  val d = sub(a, b)
  return sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2])
}

private fun normalized(v: FloatArray): FloatArray {
  val n = sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
  return if (n < 1e-9f) floatArrayOf(0f, 1f, 0f) else floatArrayOf(v[0] / n, v[1] / n, v[2] / n)
}

private fun negate(v: FloatArray) = floatArrayOf(-v[0], -v[1], -v[2])

private fun angleBetweenDeg(a: FloatArray, b: FloatArray): Float {
  val d = dot(normalized(a), normalized(b)).coerceIn(-1f, 1f)
  return Math.toDegrees(acos(d).toDouble()).toFloat()
}

private fun formatMeters(m: Float): String =
  if (m < 1f) "%.1f cm".format(m * 100) else "%.2f m".format(m)
