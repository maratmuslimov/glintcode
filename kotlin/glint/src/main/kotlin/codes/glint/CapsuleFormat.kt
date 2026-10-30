package codes.glint

/*
 * Capsule geometry, in code units: the pill is 2 units tall and its left cap is a circle of
 * radius 1 centred on the origin. From left to right:
 *
 *   ( disc )  |  4 rows × 24 columns of marks  |  label …  )
 *
 * - disc: radius DISC_R, the finder. Its ring between GLYPH_R and DISC_R stays clear; a logo goes inside GLYPH_R.
 * - start and end bars: vertical marks the reader measures to undo perspective.
 * - marks: a set cell is a dot of diameter MARK; neighbouring set cells in a row join into a dash.
 * - label: free text after the end bar. The reader never looks there.
 */
internal const val DISC_R = 0.62
internal const val MARK = 0.2
internal val ROWS = doubleArrayOf(-0.54, -0.18, 0.18, 0.54)
internal const val COLS = 24
internal const val PITCH = 0.3
internal const val START_X = 1.05
internal const val FIRST_X = START_X + 0.47
internal const val END_X = FIRST_X + (COLS - 1) * PITCH + 0.47

/** Half the length of a bar's centre line; its round ends reach MARK / 2 further. */
internal const val BAR_HALF = 0.54

/** Where the right cap's centre sits when there is no label. */
internal const val RIGHT_CAP = END_X - 0.35

internal fun colX(i: Int) = FIRST_X + i * PITCH

/** Whitening seed of the Capsule format (see Codeword.kt). */
internal const val CAPSULE_SEED = 0x5ca9c0de

/** Read cells (bit = row + col · 4, as filled below) back into a payload; `confidence` (0..1) guides erasure decoding. */
internal fun decodeCells(cells: BooleanArray, confidence: DoubleArray?): Decoded? {
    val bits = BooleanArray(CODEWORD_BITS)
    val conf = DoubleArray(CODEWORD_BITS)
    for (bit in 0 until CODEWORD_BITS) {
        // Byte b fills columns 2b and 2b+1, top to bottom: a smudge across a few columns costs only a byte or two.
        val col = (bit shr 3) * 2 + ((bit and 7) shr 2)
        val row = bit and 3
        bits[bit] = cells[row + col * ROWS.size]
        conf[bit] = if (confidence != null) confidence[row + col * ROWS.size] else 1.0
    }
    return decodeBits(bits, CAPSULE_SEED, if (confidence != null) conf else null)
}
