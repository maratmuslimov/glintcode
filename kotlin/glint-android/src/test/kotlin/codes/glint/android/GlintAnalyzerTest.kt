package codes.glint.android

import androidx.camera.core.ImageInfo
import androidx.camera.core.ImageProxy
import codes.glint.DetectOptions
import codes.glint.GlintDetection
import codes.glint.GlintDetector
import codes.glint.GlintPolarity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.lang.reflect.Proxy
import java.nio.ByteBuffer
import java.util.zip.Inflater

class GlintAnalyzerTest {
    private class Frame(val gray: ByteArray, val w: Int, val h: Int, val stride: Int) {
        var closed = false
        val buffer: ByteBuffer = ByteBuffer.allocateDirect(stride * h).also { b ->
            for (y in 0 until h) {
                for (x in 0 until stride) b.put(y * stride + x, if (x < w) gray[y * w + x] else 0x55)
            }
        }

        val proxy: ImageProxy
            get() {
                val plane = object : ImageProxy.PlaneProxy {
                    override fun getRowStride() = stride
                    override fun getPixelStride() = 1
                    override fun getBuffer(): ByteBuffer = this@Frame.buffer
                }
                val info = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(ImageInfo::class.java)) { _, m, _ ->
                    if (m.name == "getRotationDegrees") 90 else null
                } as ImageInfo
                return Proxy.newProxyInstance(javaClass.classLoader, arrayOf(ImageProxy::class.java)) { _, m, _ ->
                    when (m.name) {
                        "getWidth" -> w
                        "getHeight" -> h
                        "getPlanes" -> arrayOf(plane)
                        "getImageInfo" -> info
                        "close" -> { closed = true; null }
                        else -> null
                    }
                } as ImageProxy
            }
    }

    /** The filter-0 grayscale PNGs spec/frames is made of (no ImageIO on the Android test classpath). */
    private fun load(file: File): Frame {
        val png = ByteBuffer.wrap(file.readBytes())
        var w = 0
        var h = 0
        val inflater = Inflater()
        var at = 8
        while (at < png.limit()) {
            val len = png.getInt(at)
            val type = String(png.array(), at + 4, 4, Charsets.ISO_8859_1)
            if (type == "IHDR") {
                w = png.getInt(at + 8)
                h = png.getInt(at + 12)
            }
            if (type == "IDAT") inflater.setInput(png.array(), at + 8, len)
            at += len + 12
        }
        val raw = ByteArray((w + 1) * h)
        var n = 0
        while (n < raw.size && !inflater.finished()) n += inflater.inflate(raw, n, raw.size - n)
        val gray = ByteArray(w * h)
        for (y in 0 until h) raw.copyInto(gray, y * w, y * (w + 1) + 1, (y + 1) * (w + 1))
        return Frame(gray, w, h, w + 64)
    }

    private fun frames() = File(System.getProperty("glint.spec"), "frames").listFiles { f -> f.name.endsWith(".png") }!!.sorted().map(::load)

    private fun values(f: Frame, polarity: GlintPolarity) =
        GlintDetector().detect(f.gray, f.w, f.h, DetectOptions(polarity = polarity, maxDimension = 960)).map { it.value }

    @Test
    fun polarityAlternatesAndRepeatsAreHeldBack() {
        // One frame that reads only on the normal polarity, one only on the inverted.
        val all = frames()
        val normal = all.first { values(it, GlintPolarity.NORMAL).size == 1 && values(it, GlintPolarity.INVERTED).isEmpty() }
        val inverted = all.first { values(it, GlintPolarity.INVERTED).size == 1 && values(it, GlintPolarity.NORMAL).isEmpty() }
        var now = 0L
        val detected = ArrayList<GlintDetection>()
        val perFrame = ArrayList<Int>()
        val analyzer = GlintAnalyzer(
            repeatAfter = 3000,
            onFrame = { list, ms, rotation ->
                perFrame.add(list.size)
                assertTrue(ms >= 0)
                assertEquals(90, rotation)
            },
            clock = { now },
        ) { detected.add(it) }

        analyzer.analyze(normal.proxy) // frame 0: normal, found
        analyzer.analyze(normal.proxy) // frame 1: inverted, not found
        analyzer.analyze(inverted.proxy) // frame 2: normal, not found
        analyzer.analyze(inverted.proxy) // frame 3: inverted, found
        assertEquals(listOf(1, 0, 0, 1), perFrame)
        assertEquals(values(normal, GlintPolarity.NORMAL) + values(inverted, GlintPolarity.INVERTED), detected.map { it.value })
        assertTrue(normal.closed && inverted.closed)

        now = 3000
        analyzer.analyze(normal.proxy) // frame 4: normal, within repeatAfter of frame 0
        assertEquals(2, detected.size)
        now = 6001
        analyzer.analyze(normal.proxy) // frame 5: inverted
        analyzer.analyze(normal.proxy) // frame 6: normal, past repeatAfter of frame 4
        assertEquals(3, detected.size)
    }

    @Test
    fun rowPaddingAndPixelStrideAreSkipped() {
        val src = ByteBuffer.wrap(byteArrayOf(1, 9, 2, 9, 9, 9, 3, 9, 4, 9, 9, 9))
        val out = ByteArray(4)
        copyPlane(src, 6, 2, 2, 2, out)
        assertEquals(listOf<Byte>(1, 2, 3, 4), out.toList())
        val packed = ByteBuffer.wrap(byteArrayOf(1, 2, 9, 3, 4))
        copyPlane(packed, 3, 1, 2, 2, out)
        assertEquals(listOf<Byte>(1, 2, 3, 4), out.toList())
    }
}
