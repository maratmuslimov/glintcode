package codes.glint.android

import android.os.SystemClock
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import codes.glint.DetectOptions
import codes.glint.GlintDetection
import codes.glint.GlintDetector
import codes.glint.GlintPolarity
import java.nio.ByteBuffer

/**
 * Scan CameraX frames. Polarities alternate between frames, which halves the work per frame; a code
 * in view is found within two frames either way. Coordinates are in the unrotated buffer's pixels.
 */
class GlintAnalyzer @JvmOverloads constructor(
    /** Working size of a frame. Frames larger than this are box-downscaled by a whole factor. */
    private val maxDimension: Int = 960,
    /** A code still in view is reported again after this many ms. */
    private val repeatAfter: Long = 3000,
    /** Every frame's result, for drawing overlays. */
    private val onFrame: ((detections: List<GlintDetection>, ms: Double, rotationDegrees: Int) -> Unit)? = null,
    private val clock: () -> Long = SystemClock::elapsedRealtime,
    /** Called once per newly seen code (again after `repeatAfter` ms if it stays in view). */
    private val onDetect: (GlintDetection) -> Unit,
) : ImageAnalysis.Analyzer {
    private val detector = GlintDetector()
    private val seen = HashMap<Long, Long>()
    private var gray = ByteArray(0)
    private var frame = 0

    override fun analyze(image: ImageProxy) {
        try {
            val t0 = System.nanoTime()
            val w = image.width
            val h = image.height
            val plane = image.planes[0]
            if (gray.size != w * h) gray = ByteArray(w * h)
            copyPlane(plane.buffer, plane.rowStride, plane.pixelStride, w, h, gray)
            val polarity = if (frame++ % 2 != 0) GlintPolarity.INVERTED else GlintPolarity.NORMAL
            val found = detector.detect(gray, w, h, DetectOptions(polarity = polarity, maxDimension = maxDimension))
            onFrame?.invoke(found, (System.nanoTime() - t0) / 1e6, image.imageInfo.rotationDegrees)
            val now = clock()
            for (d in found) {
                val last = seen[d.value]
                if (last == null || now - last > repeatAfter) onDetect(d)
                seen[d.value] = now
            }
        } finally {
            image.close()
        }
    }
}

/** Tightly packed luminance from a plane with row padding (and, on some devices, pixel gaps). */
internal fun copyPlane(src: ByteBuffer, rowStride: Int, pixelStride: Int, width: Int, height: Int, out: ByteArray) {
    val b = src.duplicate()
    if (pixelStride == 1) {
        for (y in 0 until height) {
            b.position(y * rowStride)
            b.get(out, y * width, width)
        }
        return
    }
    for (y in 0 until height) {
        val row = y * rowStride
        for (x in 0 until width) out[y * width + x] = b.get(row + x * pixelStride)
    }
}
