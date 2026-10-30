package codes.glint

import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.io.File
import javax.imageio.ImageIO

private val SPEC = File(System.getProperty("glint.spec"))

internal fun readGray(file: File): Triple<ByteArray, Int, Int> {
    val image = ImageIO.read(file)
    val raster = image.raster
    check(raster.numBands == 1 && raster.sampleModel.getSampleSize(0) == 8) { "$file is not 8-bit gray" }
    val samples = raster.getSamples(0, 0, image.width, image.height, 0, null as IntArray?)
    return Triple(ByteArray(samples.size) { samples[it].toByte() }, image.width, image.height)
}

internal fun signature(list: List<GlintDetection>) = list.map { Triple(it.format.id, it.value, it.corrected) }

internal fun signature(read: JSONArray) = (0 until read.length()).map {
    val r = read.getJSONObject(it)
    Triple(r.getString("format"), r.getLong("value"), r.getInt("corrected"))
}

class ConformanceTest {
    @Test
    fun codewordsMatchVectors() {
        val spec = JSONObject(File(SPEC, "vectors.json").readText())
        val seeds = spec.getJSONObject("seeds")
        val vectors = spec.getJSONArray("vectors")
        var checked = 0
        for (i in 0 until vectors.length()) {
            val v = vectors.getJSONObject(i)
            for (f in GlintFormat.entries) {
                assertEquals(seeds.getLong(f.id).toInt(), seedOf(f), f.id)
                val bits = encodeBits(v.getLong("value"), seedOf(f)).joinToString("") { if (it) "1" else "0" }
                assertEquals(v.getJSONObject("bits").getString(f.id), bits, "${v.get("value")} ${f.id}")
                checked++
            }
        }
        println("vectors: $checked format/value pairs across ${vectors.length()} values")
    }

    @Test
    fun framesReadAsRecorded() {
        val manifest = JSONArray(File(SPEC, "frames/manifest.json").readText())
        for (i in 0 until manifest.length()) {
            val m = manifest.getJSONObject(i)
            val (gray, w, h) = readGray(File(SPEC, "frames/${m.getString("file")}"))
            assertEquals(m.getInt("width"), w)
            assertEquals(m.getInt("height"), h)
            val found = Glint.detect(gray, w, h)
            assertEquals(signature(m.getJSONArray("read")), signature(found), m.getString("file"))
            // Recorded positions are rounded to 2 decimals.
            val read = m.getJSONArray("read")
            for (j in 0 until read.length()) {
                val r = read.getJSONObject(j)
                val center = r.getJSONArray("center")
                assertEquals(center.getDouble(0), found[j].center.x, 0.0051, m.getString("file"))
                assertEquals(center.getDouble(1), found[j].center.y, 0.0051, m.getString("file"))
                assertEquals(r.getDouble("size"), found[j].size, 0.0051, m.getString("file"))
                assertEquals(r.getBoolean("inverted"), found[j].inverted, m.getString("file"))
            }
            // RGBA of a gray frame reads the same.
            val rgba = ByteArray(gray.size * 4) { if (it % 4 == 3) -1 else gray[it / 4] }
            assertEquals(signature(found), signature(Glint.detect(Rgba(rgba), w, h)), m.getString("file"))
        }
        println("frames: ${manifest.length()} read as recorded")
    }

    @Test
    fun v8Hypot() {
        assertEquals(5.0, hypot(3.0, 4.0))
        assertEquals(0.0, hypot(0.0, -0.0))
        assertEquals(Double.POSITIVE_INFINITY, hypot(Double.NaN, Double.NEGATIVE_INFINITY))
    }
}
