package codes.glint

/*
 * One reader for every format. A frame is analysed once (luminance, both threshold polarities,
 * components); every round component is then offered to each enabled format's reader:
 *
 * - capsule: the disc is light inside a dark capsule; the start bar gives the rotation, both bars
 *   and the disc fix a homography for the whole length.
 * - round formats: the lens is a solid disc; fixed points (sync ring, fixed rays, start dots)
 *   give the rotation, then rings are read against per-sector ink and paper levels.
 *
 * Every read ends in Reed–Solomon with one parity byte kept spare, so a candidate that isn't a code
 * (or is misread) is rejected instead of producing a wrong value. Erasure decoding checks far fewer
 * bits than plain decoding (16 instead of about 32 and up), and a reader makes many attempts per
 * candidate, so every format gets a plain attempt before any format may use erasures.
 */

private val RADIAL = arrayOf(GlintFormat.ORBIT, GlintFormat.CONSTELLATION, GlintFormat.HALO, GlintFormat.CONTOUR)
private val ALL = GlintFormat.entries.toSet()
private val ERASURE_PASSES = booleanArrayOf(false, true)

/** A reader with its own buffers: reuse one per camera loop. Not safe across threads at once. */
class GlintDetector {
    private val buffers = Buffers()

    /** Find and read every code in a luminance image (1 byte per pixel). */
    fun detect(gray: ByteArray, width: Int, height: Int, options: DetectOptions = DetectOptions()): List<GlintDetection> {
        require(gray.size >= width.toLong() * height) { "Expected $width × $height luminance bytes" }
        return run(gray, false, width, height, options)
    }

    /** Find and read every code in an RGBA image (4 bytes per pixel). */
    fun detect(rgba: Rgba, width: Int, height: Int, options: DetectOptions = DetectOptions()): List<GlintDetection> {
        require(rgba.data.size >= width.toLong() * height * 4) { "Expected $width × $height RGBA pixels" }
        return run(rgba.data, true, width, height, options)
    }

    private fun run(data: ByteArray, rgba: Boolean, width: Int, height: Int, options: DetectOptions): List<GlintDetection> {
        val formats = options.formats?.toSet() ?: ALL
        val capsule = GlintFormat.CAPSULE in formats
        val radial = RADIAL.any { it in formats }
        val analysis = analyze(data, rgba, width, height, options.maxDimension, options.polarity, buffers)
        val k = analysis.k.toDouble()
        val results = ArrayList<GlintDetection>()
        for (p in analysis.passes) {
            candidates@ for (e in p.candidates) {
                for (r in results) if (hypot(r.center.x / k - e.cx, r.center.y / k - e.cy) < e.a) continue@candidates
                val round = radial && radialPrecheck(p, e)
                var hit: Read? = null
                for (erasures in ERASURE_PASSES) {
                    if (hit == null && capsule) hit = readCapsule(p, e, erasures)
                    if (round) for (f in RADIAL) if (hit == null && f in formats) hit = readRadial(f, p, e, erasures)
                }
                if (hit == null) continue
                val c = hit.corners
                results.add(
                    GlintDetection(
                        hit.format,
                        hit.payload,
                        hit.value,
                        List(4) { GlintPoint(c[it * 2] * k, c[it * 2 + 1] * k) },
                        GlintPoint(hit.centerX * k, hit.centerY * k),
                        hit.size * k,
                        p.inverted,
                        hit.corrected,
                    ),
                )
                if (results.size >= options.maxResults) return results
            }
        }
        return results
    }
}

/** One-call reads; each thread keeps its own detector, so calls are safe from any thread. */
object Glint {
    private val detectors = object : ThreadLocal<GlintDetector>() {
        override fun initialValue() = GlintDetector()
    }

    fun detect(gray: ByteArray, width: Int, height: Int, options: DetectOptions = DetectOptions()): List<GlintDetection> =
        detectors.get().detect(gray, width, height, options)

    fun detect(rgba: Rgba, width: Int, height: Int, options: DetectOptions = DetectOptions()): List<GlintDetection> =
        detectors.get().detect(rgba, width, height, options)
}
