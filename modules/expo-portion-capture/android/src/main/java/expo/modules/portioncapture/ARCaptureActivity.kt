package expo.modules.portioncapture

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.ImageFormat
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.YuvImage
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
import com.google.ar.core.Config
import com.google.ar.core.Frame
import com.google.ar.core.HitResult
import com.google.ar.core.Plane
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.NotYetAvailableException
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.abs
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
  private var activeOffTarget = false
  private var activeFar = false
  private var funnyShown = false
  private var lockedPlane: Plane? = null
  private var fallbackNormal: FloatArray? = null
  private var fallbackPoint: FloatArray? = null

  // UI-thread → GL-thread signals
  @Volatile private var measureHeld = false
  @Volatile private var captureRequested = false
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
    hintLabel.text = "Point the circle at your plate…"
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
          created.configure(
            Config(created).apply {
              // Planes in any orientation, plus depth where the hardware
              // provides it — the ruler is free to hit any surface.
              planeFindingMode = Config.PlaneFindingMode.HORIZONTAL_AND_VERTICAL
              updateMode = Config.UpdateMode.LATEST_CAMERA_IMAGE
              focusMode = Config.FocusMode.AUTO
              depthMode = if (created.isDepthModeSupported(Config.DepthMode.AUTOMATIC)) {
                Config.DepthMode.AUTOMATIC
              } else {
                Config.DepthMode.DISABLED
              }
            }
          )
          session = created
          true
        }
      }
    } catch (e: Exception) {
      finishWith(null, "ARCore unavailable: ${e.message}")
      false
    }
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
    updateReticleAndMeasure(frame, camera)
    publishOverlay(camera)

    if (captureRequested && camera.trackingState == TrackingState.TRACKING) {
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
    } else if (captureRequested) {
      postLabel("Hold steady — tracking is limited")
    }
  }

  // MARK: reticle + hold-to-measure (MATH.md §2.3), GL thread

  private fun updateReticleAndMeasure(frame: Frame, camera: Camera) {
    if (camera.trackingState != TrackingState.TRACKING) {
      reticlePoint = null
      return
    }
    val w = glView.width
    val h = glView.height
    if (w == 0 || h == 0) return

    val hit = bestHit(frame, w / 2f, h / 2f)
    reticlePoint = hit?.hitPose?.translation
    reticleDistanceM = reticlePoint?.let { dist(it, camera.pose.translation) }

    if (measureHeld) {
      val point = reticlePoint
      if (activeStart == null) {
        if (point != null && hit != null) {
          rememberPlane(hit)
          // Wall or ceiling anchor: definitely off-mission, never a table at
          // a bad angle (those detect as horizontal-upward or fail entirely).
          val anchorPlane = hit.trackable as? Plane
          activeOffTarget = anchorPlane != null &&
            anchorPlane.type != Plane.Type.HORIZONTAL_UPWARD_FACING
          activeFar = (reticleDistanceM ?: 0f) > FAR_WARN_M
          activeStart = point
          activeEnd = point
        } else {
          postLabel("Aim the circle at a surface first")
        }
      } else if (point != null) {
        activeEnd = point
        postLabel(formatMeters(dist(activeStart!!, point)))
      }
    } else if (activeStart != null) {
      // Released: commit the stroke.
      val start = activeStart!!
      val end = activeEnd
      activeStart = null
      activeEnd = null
      if (end != null) {
        val length = dist(start, end)
        if (length < MIN_COMMIT_LENGTH_M) {
          postLabel("Too short — sweep further while holding the plate")
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
    rulerOverlay.publish(segments, reticleLocked = tracking && reticlePoint != null)

    val ready = !requireStroke ||
      strokes.any { it.kind == "horizontal" && it.lengthM >= minStrokeLengthM }
    shutterReady = ready
    if (ready != lastShutterEnabled) {
      lastShutterEnabled = ready
      runOnUiThread { shutterButton.alpha = if (ready) 1f else 0.4f }
    }

    // Live coaching: the hint always states the next action.
    val reticleDist = reticleDistanceM
    postHint(
      when {
        !tracking -> "Move the phone slowly so tracking can start…"
        measureHeld || activeStart != null -> "Sweep to the end point, then let go of the plate"
        reticleDist != null && reticleDist > FAR_WARN_M ->
          "That's ${formatMeters(reticleDist)} away — too far to read well, move closer"
        ready && lockedPlane == null ->
          "Ready — sweeping the table into view sharpens portion accuracy"
        ready -> "Add a height measurement up the food, or shoot"
        reticlePoint == null -> "Point the circle at the food or table…"
        else -> "Hold the plate, sweep ≥ ${(minStrokeLengthM * 100).toInt()} cm, release"
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
      "depth" to null,
      "tracking" to hashMapOf(
        "state" to "normal",
        "plane_source" to if (plane != null) "detected_plane" else "estimated",
      ),
      "scale_source" to if (horizontalOk) "ruler" else "none",
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
    plateButton = PlateButton(this) { held -> measureHeld = held }
    shutterButton = Button(this).apply {
      text = "●"
      textSize = 24f
      alpha = 0.4f
      // Always clickable: a dimmed shutter explains itself when tapped.
      setOnClickListener {
        if (shutterReady) {
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
    val cancelButton = Button(this).apply {
      text = "Cancel"
      setOnClickListener { finishWith(null, null) }
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
        FrameLayout.LayoutParams(dp(92), dp(92), Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL)
          .apply { bottomMargin = dp(28) },
      )
      addView(shutterButton, params(Gravity.BOTTOM or Gravity.END, marginBottom = 44))
      addView(undoButton, params(Gravity.BOTTOM or Gravity.START, marginBottom = 44))
      addView(cancelButton, params(Gravity.TOP or Gravity.START, marginTop = 36))
    }
  }
}

/**
 * 2D overlay: the center reticle plus strokes projected to screen space each
 * frame. The reticle ring is solid yellow when locked onto a surface and
 * dashed gray while searching.
 */
class RulerOverlay(context: Activity) : View(context) {
  class Segment(
    val x1: Float, val y1: Float, val x2: Float, val y2: Float,
    val label: String, val active: Boolean,
  )

  @Volatile private var segments: List<Segment> = emptyList()
  @Volatile private var reticleLocked = false

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
  private val reticleDot = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }

  fun publish(nextSegments: List<Segment>, reticleLocked: Boolean) {
    segments = nextSegments
    this.reticleLocked = reticleLocked
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

    // The center reticle: where the next anchor lands.
    val cx = width / 2f
    val cy = height / 2f
    val r = 24f * density
    if (reticleLocked) {
      canvas.drawCircle(cx, cy, r, reticleLockedPaint)
      reticleDot.color = Color.YELLOW
    } else {
      canvas.drawCircle(cx, cy, r, reticleSearchPaint)
      reticleDot.color = 0xB3FFFFFF.toInt()
    }
    canvas.drawCircle(cx, cy, 3f * density, reticleDot)
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

private fun formatMeters(m: Float): String =
  if (m < 1f) "%.1f cm".format(m * 100) else "%.2f m".format(m)
