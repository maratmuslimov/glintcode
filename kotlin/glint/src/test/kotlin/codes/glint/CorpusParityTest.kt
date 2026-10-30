package codes.glint

import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import java.io.File

/** GLINT_CORPUS=<dir>: manifest.jsonl plus raw .gray frames, every one must read as TypeScript read it. */
class CorpusParityTest {
    private class Frame(val file: String, val w: Int, val h: Int, val format: String, val read: List<Triple<String, Long, Int>>)

    @Test
    fun corpus() {
        val dir = System.getenv("GLINT_CORPUS").orEmpty()
        assumeTrue(dir.isNotEmpty(), "GLINT_CORPUS is not set")
        val frames = ArrayList<Frame>()
        for (line in File(dir, "manifest.jsonl").readLines()) {
            // The generator may be mid-write on the last line.
            val m = try { JSONObject(line) } catch (_: Exception) { continue }
            frames.add(Frame(m.getString("file"), m.getInt("width"), m.getInt("height"), m.optString("format"), signature(m.getJSONArray("read"))))
        }
        // Warm-up: the JIT settles before anything is timed.
        for (f in frames.take(400)) Glint.detect(File(dir, f.file).readBytes(), f.w, f.h)

        val diffs = ArrayList<String>()
        val both = ArrayList<Double>()
        val single = ArrayList<Double>()
        val perFormat = HashMap<String, IntArray>()
        val detector = GlintDetector()
        var alternate = 0
        for (f in frames) {
            val gray = File(dir, f.file).readBytes()
            val t0 = System.nanoTime()
            val found = detector.detect(gray, f.w, f.h)
            val t1 = System.nanoTime()
            val polarity = if (alternate++ % 2 == 0) GlintPolarity.NORMAL else GlintPolarity.INVERTED
            detector.detect(gray, f.w, f.h, DetectOptions(polarity = polarity, maxDimension = 4096))
            val t2 = System.nanoTime()
            if (f.w == 960 && f.h == 720) {
                both.add((t1 - t0) / 1e6)
                single.add((t2 - t1) / 1e6)
            }
            val counts = perFormat.getOrPut(f.format) { IntArray(2) }
            counts[0]++
            if (signature(found) != f.read) {
                counts[1]++
                diffs.add("${f.file}: ts=${f.read} kotlin=${signature(found)}")
            }
        }
        both.sort()
        single.sort()
        println("corpus: ${frames.size} frames, ${diffs.size} differences")
        perFormat.toSortedMap().forEach { (k, v) -> println("  $k: ${v[0]} frames, ${v[1]} differences") }
        if (both.isNotEmpty()) {
            println("960x720 ms: both polarities median %.2f p95 %.2f; one polarity median %.2f p95 %.2f (${both.size} frames)".format(
                both[both.size / 2], both[both.size * 95 / 100], single[single.size / 2], single[single.size * 95 / 100],
            ))
        }
        diffs.take(40).forEach(::println)
        assertEquals(0, diffs.size, "frames differing from TypeScript")
    }
}
