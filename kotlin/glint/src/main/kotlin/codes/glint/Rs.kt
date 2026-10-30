package codes.glint

// Reed–Solomon over GF(256) (primitive polynomial 0x11d, first consecutive root α^0),
// with errors-and-erasures decoding. Polynomials are arrays, highest degree first.

private val LOG = IntArray(256)
private val EXP = IntArray(512).also { exp ->
    var x = 1
    for (i in 0 until 255) {
        exp[i] = x
        LOG[x] = i
        x = x shl 1
        if (x and 0x100 != 0) x = x xor 0x11d
    }
    for (i in 255 until 512) exp[i] = exp[i - 255]
}

private fun mul(a: Int, b: Int) = if (a != 0 && b != 0) EXP[LOG[a] + LOG[b]] else 0
private fun div(a: Int, b: Int) = if (a != 0) EXP[(LOG[a] + 255 - LOG[b]) % 255] else 0
private fun pow(a: Int, n: Int) = EXP[((LOG[a] * n) % 255 + 255) % 255]
private fun inv(a: Int) = EXP[255 - LOG[a]]

private fun polyScale(p: IntArray, x: Int) = IntArray(p.size) { mul(p[it], x) }

private fun polyAdd(p: IntArray, q: IntArray): IntArray {
    val r = IntArray(maxOf(p.size, q.size))
    for (i in p.indices) r[i + r.size - p.size] = p[i]
    for (i in q.indices) r[i + r.size - q.size] = r[i + r.size - q.size] xor q[i]
    return r
}

private fun polyMul(p: IntArray, q: IntArray): IntArray {
    val r = IntArray(p.size + q.size - 1)
    for (j in q.indices) for (i in p.indices) r[i + j] = r[i + j] xor mul(p[i], q[j])
    return r
}

private fun polyEval(p: IntArray, x: Int): Int {
    var y = p[0]
    for (i in 1 until p.size) y = mul(y, x) xor p[i]
    return y
}

private fun generator(nsym: Int): IntArray {
    var g = intArrayOf(1)
    for (i in 0 until nsym) g = polyMul(g, intArrayOf(1, pow(2, i)))
    return g
}

/** Data followed by nsym parity bytes. */
internal fun rsEncode(data: IntArray, nsym: Int): IntArray {
    val g = generator(nsym)
    val out = data.copyOf(data.size + nsym)
    for (i in data.indices) {
        val coef = out[i]
        if (coef != 0) for (j in 1 until g.size) out[i + j] = out[i + j] xor mul(g[j], coef)
    }
    data.copyInto(out)
    return out
}

private fun syndromes(msg: IntArray, nsym: Int): IntArray {
    val s = IntArray(nsym + 1)
    for (i in 0 until nsym) s[i + 1] = polyEval(msg, pow(2, i))
    return s
}

private fun forneySyndromes(synd: IntArray, erasures: IntArray, n: Int): IntArray {
    val f = synd.copyOfRange(1, synd.size)
    for (p in erasures) {
        val x = pow(2, n - 1 - p)
        for (j in 0 until f.size - 1) f[j] = mul(f[j], x) xor f[j + 1]
    }
    return f
}

/** Berlekamp–Massey on the (Forney) syndromes; null when there are more errors than it can locate. */
private fun errorLocator(synd: IntArray, nsym: Int, erasureCount: Int): IntArray? {
    var loc = intArrayOf(1)
    var old = intArrayOf(1)
    for (i in 0 until nsym - erasureCount) {
        var delta = synd[i]
        // Past the start of synd the TS reads undefined, and mul of that is 0.
        for (j in 1 until loc.size) if (i >= j) delta = delta xor mul(loc[loc.size - 1 - j], synd[i - j])
        old = old.copyOf(old.size + 1)
        if (delta != 0) {
            if (old.size > loc.size) {
                val next = polyScale(old, delta)
                old = polyScale(loc, inv(delta))
                loc = next
            }
            loc = polyAdd(loc, polyScale(old, delta))
        }
    }
    var lead = 0
    while (lead < loc.size && loc[lead] == 0) lead++
    loc = loc.copyOfRange(lead, loc.size)
    val errors = loc.size - 1
    return if (errors * 2 + erasureCount > nsym) null else loc
}

private fun findErrors(locReversed: IntArray, n: Int): IntArray? {
    if (locReversed.isEmpty()) return null
    val errors = locReversed.size - 1
    val pos = IntArray(n)
    var count = 0
    for (i in 0 until n) if (polyEval(locReversed, pow(2, i)) == 0) pos[count++] = n - 1 - i
    return if (count == errors) pos.copyOf(count) else null
}

private fun correctErrata(msg: IntArray, synd: IntArray, positions: IntArray): IntArray? {
    val coefPos = IntArray(positions.size) { msg.size - 1 - positions[it] }
    var loc = intArrayOf(1)
    for (i in coefPos) loc = polyMul(loc, polyAdd(intArrayOf(1), intArrayOf(pow(2, i), 0)))
    // The remainder modulo x^loc.size: the product's low loc.size coefficients.
    val product = polyMul(synd.reversedArray(), loc)
    val evaluator = product.copyOfRange(product.size - loc.size, product.size)
    val x = IntArray(coefPos.size) { pow(2, coefPos[it]) }
    val out = msg.copyOf()
    for (i in x.indices) {
        val xiInv = inv(x[i])
        var prime = 1
        for (j in x.indices) if (j != i) prime = mul(prime, 1 xor mul(xiInv, x[j]))
        if (prime == 0) return null
        val y = mul(x[i], polyEval(evaluator, xiInv))
        out[positions[i]] = out[positions[i]] xor div(y, prime)
    }
    return out
}

internal class RsDecoded(@JvmField val data: IntArray, @JvmField val corrected: Int)

private fun anyNonZero(s: IntArray): Boolean {
    for (v in s) if (v != 0) return true
    return false
}

/**
 * Correct a codeword in place of its errors and the given erasures (positions known to be unreliable).
 * Succeeds while 2·errors + erasures ≤ nsym; `budget` can demand spare parity so that
 * a garbled read is rejected instead of being "corrected" into another valid codeword.
 */
internal fun rsDecode(codeword: IntArray, nsym: Int, erasures: IntArray, budget: Int = nsym): RsDecoded? {
    if (erasures.size > budget) return null
    val msg = codeword.copyOf()
    for (p in erasures) msg[p] = 0
    val synd = syndromes(msg, nsym)
    var fixed = msg
    if (anyNonZero(synd)) {
        val loc = errorLocator(forneySyndromes(synd, erasures, msg.size), nsym, erasures.size) ?: return null
        val errors = findErrors(loc.reversedArray(), msg.size)
        if (errors == null || errors.size * 2 + erasures.size > budget) return null
        val out = correctErrata(msg, synd, erasures + errors)
        if (out == null || anyNonZero(syndromes(out, nsym))) return null
        fixed = out
    }
    var corrected = 0
    for (i in fixed.indices) if (fixed[i] != codeword[i]) corrected++
    return RsDecoded(fixed.copyOf(fixed.size - nsym), corrected)
}
