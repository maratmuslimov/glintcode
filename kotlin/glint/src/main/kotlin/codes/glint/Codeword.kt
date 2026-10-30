package codes.glint

import kotlin.math.min

/*
 * Every format carries the same codeword: 6 payload bytes + 6 Reed–Solomon parity bytes, XORed with
 * a whitening sequence of its own. The sequence keeps the pattern lively for any payload and tells
 * formats (and future versions) apart: a code never decodes under another format's sequence.
 */
internal const val DATA_BYTES = 6
internal const val ECC_BYTES = 6
internal const val CODEWORD_BYTES = DATA_BYTES + ECC_BYTES
internal const val CODEWORD_BITS = CODEWORD_BYTES * 8

private fun whitening(seed: Int): IntArray {
    val out = IntArray(CODEWORD_BYTES)
    var s = if (seed != 0) seed else 1
    for (i in 0 until CODEWORD_BYTES) {
        s = s xor (s shl 13)
        s = s xor (s ushr 17)
        s = s xor (s shl 5)
        out[i] = s and 0xff
    }
    return out
}

/** A number below 2^48 as the 6-byte payload (big-endian). */
internal fun payloadFromNumber(value: Long): IntArray {
    require(value in 0 until (1L shl 48)) { "Payloads hold numbers from 0 to 2^48 - 1" }
    var v = value
    val out = IntArray(DATA_BYTES)
    for (i in DATA_BYTES - 1 downTo 0) {
        out[i] = (v and 0xff).toInt()
        v = v shr 8
    }
    return out
}

internal fun payloadToNumber(payload: ByteArray): Long {
    var v = 0L
    for (b in payload) v = v * 256 + (b.toInt() and 0xff)
    return v
}

/** The whitened codeword as 96 bits, most significant bit of byte 0 first. */
internal fun encodeBits(value: Long, seed: Int): BooleanArray {
    val cw = rsEncode(payloadFromNumber(value), ECC_BYTES)
    val w = whitening(seed)
    val bits = BooleanArray(CODEWORD_BITS)
    for (i in 0 until CODEWORD_BYTES) for (b in 7 downTo 0) bits[i * 8 + 7 - b] = ((cw[i] xor w[i]) shr b) and 1 == 1
    return bits
}

internal class Decoded(@JvmField val payload: ByteArray, @JvmField val corrected: Int)

/**
 * Decode 96 read bits. `confidence` (0..1 per bit) picks which bytes to treat as erasures when plain
 * correction fails. Every attempt keeps one parity byte spare, so a misread is rejected rather than
 * corrected into a different payload.
 */
internal fun decodeBits(bits: BooleanArray, seed: Int, confidence: DoubleArray?): Decoded? {
    val w = whitening(seed)
    val word = IntArray(CODEWORD_BYTES)
    val byteConfidence = DoubleArray(CODEWORD_BYTES)
    for (i in 0 until CODEWORD_BYTES) {
        var v = 0
        var c = 1.0
        for (b in 0 until 8) {
            v = (v shl 1) or (if (bits[i * 8 + b]) 1 else 0)
            if (confidence != null) c = min(c, confidence[i * 8 + b])
        }
        word[i] = v xor w[i]
        byteConfidence[i] = c
    }
    val budget = ECC_BYTES - 1
    var out = rsDecode(word, ECC_BYTES, IntArray(0), budget)
    if (out == null && confidence != null) {
        // Stable: bytes of equal confidence keep their order.
        val order = IntArray(CODEWORD_BYTES) { it }
        for (i in 1 until CODEWORD_BYTES) {
            val o = order[i]
            var j = i
            while (j > 0 && byteConfidence[order[j - 1]] > byteConfidence[o]) {
                order[j] = order[j - 1]
                j--
            }
            order[j] = o
        }
        out = rsDecode(word, ECC_BYTES, order.copyOf(2), budget) ?: rsDecode(word, ECC_BYTES, order.copyOf(4), budget)
    }
    if (out == null) return null
    val data = out.data
    return Decoded(ByteArray(data.size) { data[it].toByte() }, out.corrected)
}
