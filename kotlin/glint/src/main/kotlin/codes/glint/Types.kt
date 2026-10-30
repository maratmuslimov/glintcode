package codes.glint

enum class GlintFormat(val id: String) {
    CAPSULE("capsule"),
    ORBIT("orbit"),
    HALO("halo"),
    CONSTELLATION("constellation"),
    CONTOUR("contour"),
}

enum class GlintPolarity {
    /** Marks of either kind. */
    BOTH,

    /** Marks lighter than around them. */
    NORMAL,

    /** Marks darker than around them. */
    INVERTED,
}

data class DetectOptions(
    /** Formats to look for. Default: all. */
    val formats: Collection<GlintFormat>? = null,
    val polarity: GlintPolarity = GlintPolarity.BOTH,
    /** Long side the frame is downscaled to before reading. */
    val maxDimension: Int = 1280,
    /** Stop after this many codes. */
    val maxResults: Int = 4,
)

data class GlintPoint(val x: Double, val y: Double)

class GlintDetection(
    val format: GlintFormat,
    val payload: ByteArray,
    /** The payload as a number (0..2^48-1). */
    val value: Long,
    /** Corners of the code area in image pixels (label excluded): top-left, top-right, bottom-right, bottom-left. */
    val corners: List<GlintPoint>,
    /** Centre of the finder in image pixels. */
    val center: GlintPoint,
    /** Capsule: pill height; round formats: diameter. In image pixels. */
    val size: Double,
    /** True when the marks were darker than their surroundings (e.g. black ink on paper). */
    val inverted: Boolean,
    /** Bytes fixed by error correction (0 = clean read). */
    val corrected: Int,
) {
    override fun toString() = "GlintDetection(${format.id}, value=$value, corrected=$corrected, inverted=$inverted)"
}

/** RGBA pixels, 4 bytes each, as an overload of `detect` next to plain luminance. */
class Rgba(@JvmField val data: ByteArray)

/** What a format's reader returns for one candidate, in working-frame pixels. `corners` is x, y × 4. */
internal class Read(
    @JvmField val format: GlintFormat,
    @JvmField val payload: ByteArray,
    @JvmField val value: Long,
    @JvmField val corrected: Int,
    @JvmField val corners: DoubleArray,
    @JvmField val centerX: Double,
    @JvmField val centerY: Double,
    @JvmField val size: Double,
)
