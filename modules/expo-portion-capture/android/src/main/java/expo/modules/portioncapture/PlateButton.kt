package expo.modules.portioncapture

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.view.MotionEvent
import android.view.View

/**
 * The measure trigger AND thumb-trackpad, drawn as a 45 lb gym plate viewed
 * face-on: rubber disc, groove rings, center hub with a barbell hole, and the
 * classic "45" stamp.
 *
 * Hold it to start measuring; slide the finger (it may leave the plate — the
 * gesture stays captured) to drive the reticle while the phone stays steady;
 * release to commit. Reports the drag as a delta from the touch-down point.
 */
@SuppressLint("ViewConstructor")
class PlateButton(
  context: Context,
  private val onHoldChange: (held: Boolean) -> Unit,
  private val onDrag: (dx: Float, dy: Float) -> Unit,
) : View(context) {

  private var held = false
  private var downX = 0f
  private var downY = 0f

  private val disc = Paint(Paint.ANTI_ALIAS_FLAG)
  private val groove = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    color = 0xFF3A3A3C.toInt()
  }
  private val hub = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF0E0E0F.toInt() }
  private val hole = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK }
  private val rim = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    color = Color.YELLOW
  }
  private val stamp = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = 0xFFE8E8E8.toInt()
    textAlign = Paint.Align.CENTER
    isFakeBoldText = true
  }
  private val stampSmall = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = 0xFF9A9A9E.toInt()
    textAlign = Paint.Align.CENTER
  }

  init {
    contentDescription = "Hold and slide to measure"
    isHapticFeedbackEnabled = true
  }

  override fun onDraw(canvas: Canvas) {
    val cx = width / 2f
    val cy = height / 2f
    val r = (minOf(width, height) / 2f) * if (held) 0.94f else 1f

    // Rubber disc with a soft top-left sheen.
    disc.shader = RadialGradient(
      cx - r * 0.3f, cy - r * 0.3f, r * 1.8f,
      0xFF2C2C2E.toInt(), 0xFF161618.toInt(), Shader.TileMode.CLAMP,
    )
    canvas.drawCircle(cx, cy, r, disc)

    // Machined grooves.
    groove.strokeWidth = r * 0.03f
    canvas.drawCircle(cx, cy, r * 0.88f, groove)
    canvas.drawCircle(cx, cy, r * 0.56f, groove)

    // Hub and barbell hole.
    canvas.drawCircle(cx, cy, r * 0.24f, hub)
    canvas.drawCircle(cx, cy, r * 0.13f, hole)

    // The stamp, on the flat between the grooves.
    stamp.textSize = r * 0.30f
    canvas.drawText("45", cx, cy - r * 0.62f + stamp.textSize / 2.6f, stamp)
    stampSmall.textSize = r * 0.14f
    canvas.drawText("LB", cx, cy + r * 0.74f, stampSmall)

    if (held) {
      rim.strokeWidth = r * 0.06f
      canvas.drawCircle(cx, cy, r * 0.97f, rim)
    }
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = event.x
        downY = event.y
        setHeld(true)
      }
      MotionEvent.ACTION_MOVE -> {
        if (held) onDrag(event.x - downX, event.y - downY)
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> setHeld(false)
    }
    return true
  }

  private fun setHeld(next: Boolean) {
    if (held == next) return
    held = next
    onHoldChange(next)
    invalidate()
  }
}
