package codes.glint

import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

// Image analysis shared by every format: luminance, adaptive threshold, connected components,
// ellipse fitting and the geometry helpers the readers build on.

// sin, cos and atan2 go through StrictMath: fdlibm, as in V8, where Math's intrinsics differ in the last bit.
internal fun sin(a: Double) = StrictMath.sin(a)
internal fun cos(a: Double) = StrictMath.cos(a)
internal fun atan2(y: Double, x: Double) = StrictMath.atan2(y, x)

/** Math.hypot as V8 computes it (Kahan summation of the normalized squares), not fdlibm's. */
internal fun hypot(x: Double, y: Double): Double {
    val ax = Math.abs(x)
    val ay = Math.abs(y)
    if (ax.isInfinite() || ay.isInfinite()) return Double.POSITIVE_INFINITY
    if (ax.isNaN() || ay.isNaN()) return Double.NaN
    val m = if (ay > ax) ay else ax
    if (m == 0.0) return 0.0
    val nx = ax / m
    val ny = ay / m
    // With two terms the compensation is always 0.
    return sqrt(nx * nx + ny * ny) * m
}

/** Reusable per-size buffers, so a camera loop doesn't allocate every frame. One per detector. */
internal class Buffers {
    @JvmField var w = -1
    @JvmField var h = -1
    @JvmField var luma = ByteArray(0)
    @JvmField var inv = ByteArray(0)
    @JvmField var integral = IntArray(0)
    @JvmField var mask = ByteArray(0)
    @JvmField var maskInv = ByteArray(0)
    @JvmField var blockHi = FloatArray(0)
    @JvmField var blockLo = FloatArray(0)
    @JvmField val cc = arrayOf(Components(), Components())

    fun ensure(w: Int, h: Int) {
        if (w == this.w && h == this.h) return
        this.w = w
        this.h = h
        luma = ByteArray(w * h)
        inv = ByteArray(w * h)
        integral = IntArray((w + 1) * (h + 1))
        mask = ByteArray(w * h)
        maskInv = ByteArray(w * h)
    }
}

/** Fills `buffers.luma` and returns k, the downscale factor. */
internal fun toLuma(data: ByteArray, rgba: Boolean, width: Int, height: Int, maxDimension: Int, buffers: Buffers): Int {
    val k = max(1, ceil(max(width, height).toDouble() / maxDimension).toInt())
    val w = width / k
    val h = height / k
    buffers.ensure(w, h)
    val out = buffers.luma
    if (k == 1) {
        if (rgba) {
            var j = 0
            for (i in 0 until w * h) {
                out[i] = (((data[j].toInt() and 0xff) * 77 + (data[j + 1].toInt() and 0xff) * 150 + (data[j + 2].toInt() and 0xff) * 29) shr 8).toByte()
                j += 4
            }
        } else data.copyInto(out, 0, 0, w * h)
        return k
    }
    val area = k.toLong() * k
    for (y in 0 until h) {
        for (x in 0 until w) {
            var s = 0L
            for (dy in 0 until k) {
                var i = (y * k + dy) * width + x * k
                for (dx in 0 until k) {
                    if (rgba) {
                        val j = i * 4
                        s += (((data[j].toInt() and 0xff) * 77 + (data[j + 1].toInt() and 0xff) * 150 + (data[j + 2].toInt() and 0xff) * 29) shr 8).toLong()
                    } else s += (data[i].toInt() and 0xff).toLong()
                    i++
                }
            }
            out[y * w + x] = (s / area).toByte()
        }
    }
    return k
}

/**
 * Pixels clearly lighter than the mean of their neighbourhood (`mask`), and clearly darker (`maskInv`,
 * the same test on the inverted image). The neighbourhood mean is computed once per 4×4 block; the
 * margin grows with brightness (mean + 7 + mean/14). Pixels are judged unsmoothed: smoothing would
 * cut camera noise but also erase the marks of codes under ~30 px tall.
 */
internal fun threshold(lum: ByteArray, w: Int, h: Int, light: Boolean, dark: Boolean, buffers: Buffers) {
    val ii = buffers.integral
    val w1 = w + 1
    for (y in 0 until h) {
        var row = 0
        val o = (y + 1) * w1
        val p = y * w1
        val l = y * w
        for (x in 0 until w) {
            row += lum[l + x].toInt() and 0xff
            ii[o + x + 1] = ii[p + x + 1] + row
        }
    }
    val r = max(4, Math.round(min(w, h).toDouble() / 28).toInt())
    val bw = (w + 3) shr 2
    val bh = (h + 3) shr 2
    if (buffers.blockHi.size < bw * bh) {
        buffers.blockHi = FloatArray(bw * bh)
        buffers.blockLo = FloatArray(bw * bh)
    }
    val hi = buffers.blockHi
    val lo = buffers.blockLo
    for (by in 0 until bh) {
        val cy = min(h - 1, by * 4 + 2)
        val y0 = max(0, cy - r)
        val y1 = min(h, cy + r + 1)
        for (bx in 0 until bw) {
            val cx = min(w - 1, bx * 4 + 2)
            val x0 = max(0, cx - r)
            val x1 = min(w, cx + r + 1)
            val area = (x1 - x0) * (y1 - y0)
            // Uint32 reads: a wrapped integral stays wrong the same way as in a Uint32Array.
            val sum = (ii[y1 * w1 + x1].toLong() and 0xffffffffL) - (ii[y0 * w1 + x1].toLong() and 0xffffffffL) -
                (ii[y1 * w1 + x0].toLong() and 0xffffffffL) + (ii[y0 * w1 + x0].toLong() and 0xffffffffL)
            val mean = sum.toDouble() / area
            hi[by * bw + bx] = (mean + 7 + mean / 14).toFloat()
            val inv = 255 - mean
            lo[by * bw + bx] = (255 - (inv + 7 + inv / 14)).toFloat()
        }
    }
    val mask = buffers.mask
    val maskInv = buffers.maskInv
    for (y in 0 until h) {
        val l = y * w
        val brow = (y shr 2) * bw
        for (x in 0 until w) {
            val v = (lum[l + x].toInt() and 0xff).toFloat()
            val b = brow + (x shr 2)
            mask[l + x] = if (light && v > hi[b]) 1 else 0
            maskInv[l + x] = if (dark && v < lo[b]) 1 else 0
        }
    }
}

private fun sq(v: Double) = (v * (v + 1) * (2 * v + 1)) / 6

/** Connected components as runs. Arrays grow as needed and are reused; only the first `count` / `runs` entries hold data. */
internal class Components {
    @JvmField var count = 0
    @JvmField var runs = 0
    @JvmField var height = 0

    // per run
    @JvmField var runY = IntArray(1 shl 14)
    @JvmField var runX0 = IntArray(1 shl 14)
    @JvmField var runX1 = IntArray(1 shl 14)
    @JvmField var runComp = IntArray(0)
    @JvmField var rowStart = IntArray(0)
    private var parent = IntArray(1 shl 14)
    private var compOf = IntArray(0)

    // per component
    @JvmField var n = DoubleArray(0)
    @JvmField var sx = DoubleArray(0)
    @JvmField var sy = DoubleArray(0)
    @JvmField var sxx = DoubleArray(0)
    @JvmField var syy = DoubleArray(0)
    @JvmField var sxy = DoubleArray(0)
    @JvmField var minX = IntArray(0)
    @JvmField var maxX = IntArray(0)
    @JvmField var minY = IntArray(0)
    @JvmField var maxY = IntArray(0)
    @JvmField var compRunStart = IntArray(0)
    @JvmField var compRuns = IntArray(0)
    private var fill = IntArray(0)

    // A set of components that empties in O(1): `seen[c] == generation`.
    private var seen = IntArray(0)
    private var generation = 0

    fun clearSeen() {
        generation++
    }

    /** False if c was already in the set; adds it. */
    fun markSeen(c: Int): Boolean {
        if (seen[c] == generation) return false
        seen[c] = generation
        return true
    }

    private fun find(start: Int): Int {
        val parent = parent
        var a = start
        while (parent[a] != a) {
            parent[a] = parent[parent[a]]
            a = parent[a]
        }
        return a
    }

    private fun growRuns() {
        val cap = runY.size * 2
        runY = runY.copyOf(cap)
        runX0 = runX0.copyOf(cap)
        runX1 = runX1.copyOf(cap)
        parent = parent.copyOf(cap)
    }

    private fun sizeComponents(count: Int) {
        if (n.size < count) {
            val cap = max(count, n.size * 2)
            n = DoubleArray(cap)
            sx = DoubleArray(cap)
            sy = DoubleArray(cap)
            sxx = DoubleArray(cap)
            syy = DoubleArray(cap)
            sxy = DoubleArray(cap)
            minX = IntArray(cap)
            maxX = IntArray(cap)
            minY = IntArray(cap)
            maxY = IntArray(cap)
            compRunStart = IntArray(cap + 1)
            fill = IntArray(cap)
            seen = IntArray(cap)
            generation = 0
        } else {
            n.fill(0.0, 0, count)
            sx.fill(0.0, 0, count)
            sy.fill(0.0, 0, count)
            sxx.fill(0.0, 0, count)
            syy.fill(0.0, 0, count)
            sxy.fill(0.0, 0, count)
            compRunStart.fill(0, 0, count + 1)
        }
        minX.fill(1 shl 30, 0, count)
        maxX.fill(-1, 0, count)
        minY.fill(1 shl 30, 0, count)
        maxY.fill(-1, 0, count)
    }

    fun compute(mask: ByteArray, w: Int, h: Int) {
        if (rowStart.size != h + 1) rowStart = IntArray(h + 1)
        val rowStart = rowStart
        height = h
        var nr = 0
        var prevStart = 0
        var prevEnd = 0
        for (y in 0 until h) {
            rowStart[y] = nr
            val base = y * w
            var p = prevStart
            var x = 0
            while (x < w) {
                if (mask[base + x].toInt() == 0) {
                    x++
                    continue
                }
                val a = x
                while (x < w && mask[base + x].toInt() != 0) x++
                val b = x - 1
                if (nr == runY.size) growRuns()
                val id = nr++
                runY[id] = y
                runX0[id] = a
                runX1[id] = b
                parent[id] = id
                while (p < prevEnd && runX1[p] < a - 1) p++
                var q = p
                while (q < prevEnd && runX0[q] <= b + 1) {
                    val ra = find(id)
                    val rb = find(q)
                    if (ra != rb) parent[if (ra < rb) rb else ra] = if (ra < rb) ra else rb
                    q++
                }
            }
            prevStart = rowStart[y]
            prevEnd = nr
        }
        rowStart[h] = nr
        runs = nr

        if (compOf.size < nr) {
            compOf = IntArray(max(nr, compOf.size * 2))
            runComp = IntArray(compOf.size)
            compRuns = IntArray(compOf.size)
        }
        val compOf = compOf
        val runComp = runComp
        compOf.fill(-1, 0, nr)
        var count = 0
        for (i in 0 until nr) {
            val r = find(i)
            if (compOf[r] < 0) compOf[r] = count++
            runComp[i] = compOf[r]
        }
        this.count = count
        sizeComponents(count)
        val n = n
        val sx = sx
        val sy = sy
        val sxx = sxx
        val syy = syy
        val sxy = sxy
        val compRunStart = compRunStart
        for (i in 0 until nr) {
            val c = runComp[i]
            val a = runX0[i]
            val b = runX1[i]
            val y = runY[i]
            val len = (b - a + 1).toDouble()
            val s1 = ((a + b) * len) / 2
            n[c] += len
            sx[c] += s1
            sy[c] += y * len
            sxx[c] += sq(b.toDouble()) - sq(a - 1.0)
            syy[c] += y.toDouble() * y * len
            sxy[c] += y * s1
            if (a < minX[c]) minX[c] = a
            if (b > maxX[c]) maxX[c] = b
            if (y < minY[c]) minY[c] = y
            if (y > maxY[c]) maxY[c] = y
            compRunStart[c + 1]++
        }
        for (c in 0 until count) compRunStart[c + 1] += compRunStart[c]
        compRunStart.copyInto(fill, 0, 0, count)
        for (i in 0 until nr) compRuns[fill[runComp[i]]++] = i
    }
}

/** Component containing pixel (x, y), or -1. */
internal fun compAt(cc: Components, x: Double, y: Double): Int {
    val yi = floor(y)
    val xi = floor(x)
    if (yi.isNaN() || yi < 0 || yi >= cc.height) return -1
    val row = yi.toInt()
    var lo = cc.rowStart[row]
    var hi = cc.rowStart[row + 1] - 1
    while (lo <= hi) {
        val m = (lo + hi) shr 1
        if (cc.runX1[m] < xi) lo = m + 1
        else if (cc.runX0[m] > xi) hi = m - 1
        else return cc.runComp[m]
    }
    return -1
}

internal class Ellipse(
    @JvmField val cx: Double,
    @JvmField val cy: Double,
    @JvmField val a: Double,
    @JvmField val b: Double,
    @JvmField val phi: Double,
)

/** Ellipse of a component with its holes filled (each row from its leftmost to rightmost pixel). */
internal fun filledEllipse(cc: Components, c: Int): Ellipse? {
    var area = 0.0
    var sumX = 0.0
    var sumY = 0.0
    var sumXX = 0.0
    var sumYY = 0.0
    var sumXY = 0.0
    var row = -1
    var lo = 0
    var hi = 0
    var k = cc.compRunStart[c]
    val end = cc.compRunStart[c + 1]
    while (true) {
        val r = if (k < end) cc.compRuns[k] else -1
        val y = if (r >= 0) cc.runY[r] else -1
        if (r < 0 || y != row) {
            if (row >= 0) {
                val len = (hi - lo + 1).toDouble()
                val s1 = ((lo + hi) * len) / 2
                area += len
                sumX += s1
                sumY += row * len
                sumXX += sq(hi.toDouble()) - sq(lo - 1.0)
                sumYY += row.toDouble() * row * len
                sumXY += row * s1
            }
            if (r < 0) break
            row = y
            lo = cc.runX0[r]
            hi = cc.runX1[r]
        } else {
            if (cc.runX0[r] < lo) lo = cc.runX0[r]
            if (cc.runX1[r] > hi) hi = cc.runX1[r]
        }
        k++
    }
    val mx = sumX / area
    val my = sumY / area
    // + 1/12: each pixel is a unit square, not a point.
    val vxx = sumXX / area - mx * mx + 1.0 / 12
    val vyy = sumYY / area - my * my + 1.0 / 12
    val vxy = sumXY / area - mx * my
    val tr = (vxx + vyy) / 2
    val half = (vxx - vyy) / 2
    val d = sqrt(half * half + vxy * vxy)
    val l1 = tr + d
    val l2 = tr - d
    if (l2 <= 0) return null
    val a = 2 * sqrt(l1)
    val b = 2 * sqrt(l2)
    val ratio = area / (PI * a * b)
    if (ratio < 0.86 || ratio > 1.14 || b / a < 0.22) return null
    return Ellipse(mx + 0.5, my + 0.5, a, b, 0.5 * atan2(2 * vxy, vxx - vyy))
}

/** Code units → image. `sample` saves mapping x and y apart where the map is costly. */
internal abstract class Map2 {
    abstract fun x(x: Double, y: Double): Double
    abstract fun y(x: Double, y: Double): Double
    open fun sample(p: Polarity, x: Double, y: Double) = p.sample(x(x, y), y(x, y))
}

/** Code units → image, as an affine map from a disc of radius discR (code units) seen as ellipse e, rotated by psi. */
internal class Affine(e: Ellipse, psi: Double, discR: Double) : Map2() {
    private val cx = e.cx
    private val cy = e.cy
    private val m00: Double
    private val m01: Double
    private val m10: Double
    private val m11: Double

    init {
        val s = 1 / discR
        val cp = cos(e.phi)
        val sp = sin(e.phi)
        val cr = cos(psi)
        val sr = sin(psi)
        // The unit circle maps onto the ellipse through R(phi) · diag(a, b) · R(psi).
        m00 = (cp * e.a * cr - sp * e.b * sr) * s
        m01 = (-cp * e.a * sr - sp * e.b * cr) * s
        m10 = (sp * e.a * cr + cp * e.b * sr) * s
        m11 = (-sp * e.a * sr + cp * e.b * cr) * s
    }

    override fun x(x: Double, y: Double) = cx + m00 * x + m01 * y
    override fun y(x: Double, y: Double) = cy + m10 * x + m11 * y
}

private class Homography(
    private val h: DoubleArray,
    private val ox: Double,
    private val oy: Double,
    private val scale: Double,
) : Map2() {
    override fun x(x: Double, y: Double): Double {
        val d = h[6] * x + h[7] * y + 1
        return ox + (scale * (h[0] * x + h[1] * y + h[2])) / d
    }

    override fun y(x: Double, y: Double): Double {
        val d = h[6] * x + h[7] * y + 1
        return oy + (scale * (h[3] * x + h[4] * y + h[5])) / d
    }

    override fun sample(p: Polarity, x: Double, y: Double): Double {
        val d = h[6] * x + h[7] * y + 1
        return p.sample(ox + (scale * (h[0] * x + h[1] * y + h[2])) / d, oy + (scale * (h[3] * x + h[4] * y + h[5])) / d)
    }
}

/** Least-squares homography (h33 = 1) from code points to image points. Points are x, y pairs. */
internal fun homography(src: DoubleArray, dst: DoubleArray, ox: Double, oy: Double, scale: Double): Map2? {
    val nn = DoubleArray(64)
    val r = DoubleArray(8)
    val a = DoubleArray(8)
    fun add(b: Double) {
        for (j in 0 until 8) {
            r[j] += a[j] * b
            for (k in 0 until 8) nn[j * 8 + k] += a[j] * a[k]
        }
    }
    for (i in 0 until src.size / 2) {
        val x = src[i * 2]
        val y = src[i * 2 + 1]
        val u = (dst[i * 2] - ox) / scale
        val v = (dst[i * 2 + 1] - oy) / scale
        a[0] = x
        a[1] = y
        a[2] = 1.0
        a[3] = 0.0
        a[4] = 0.0
        a[5] = 0.0
        a[6] = -u * x
        a[7] = -u * y
        add(u)
        a[0] = 0.0
        a[1] = 0.0
        a[2] = 0.0
        a[3] = x
        a[4] = y
        a[5] = 1.0
        a[6] = -v * x
        a[7] = -v * y
        add(v)
    }
    // Gaussian elimination with partial pivoting.
    for (c in 0 until 8) {
        var best = c
        for (k in c + 1 until 8) if (Math.abs(nn[k * 8 + c]) > Math.abs(nn[best * 8 + c])) best = k
        if (Math.abs(nn[best * 8 + c]) < 1e-12) return null
        if (best != c) {
            for (k in 0 until 8) {
                val t = nn[c * 8 + k]
                nn[c * 8 + k] = nn[best * 8 + k]
                nn[best * 8 + k] = t
            }
            val t = r[c]
            r[c] = r[best]
            r[best] = t
        }
        for (k in 0 until 8) {
            if (k == c) continue
            val f = nn[k * 8 + c] / nn[c * 8 + c]
            if (f == 0.0 || f.isNaN()) continue
            for (j in c until 8) nn[k * 8 + j] -= f * nn[c * 8 + j]
            r[k] -= f * r[c]
        }
    }
    return Homography(DoubleArray(8) { r[it] / nn[it * 8 + it] }, ox, oy, scale)
}

internal class Bar(
    @JvmField val cx: Double,
    @JvmField val cy: Double,
    /** Unit vector along the bar. */
    @JvmField val vx: Double,
    @JvmField val vy: Double,
    @JvmField val half: Double,
)

internal fun barOf(cc: Components, c: Int): Bar? {
    val n = cc.n[c]
    if (n < 4) return null
    val mx = cc.sx[c] / n
    val my = cc.sy[c] / n
    val vxx = cc.sxx[c] / n - mx * mx + 1.0 / 12
    val vyy = cc.syy[c] / n - my * my + 1.0 / 12
    val vxy = cc.sxy[c] / n - mx * my
    val tr = (vxx + vyy) / 2
    val half = (vxx - vyy) / 2
    val d = sqrt(half * half + vxy * vxy)
    val l1 = tr + d
    val l2 = tr - d
    if (l1 < 4 * max(l2, 0.05)) return null
    val t = 0.5 * atan2(2 * vxy, vxx - vyy)
    return Bar(mx + 0.5, my + 0.5, cos(t), sin(t), sqrt(3 * l1))
}

/** One polarity of a frame: its luminance, components and round candidates. */
internal class Polarity(
    /** True when this pass looks for marks darker than their surroundings (dark ink on paper). */
    @JvmField val inverted: Boolean,
    @JvmField val lum: ByteArray,
    @JvmField val cc: Components,
    @JvmField val w: Int,
    /** Round components: possible finders, largest first. */
    @JvmField val candidates: List<Ellipse>,
    h: Int,
) {
    private val limX = w - 1.001
    private val limY = h - 1.001

    /** Bilinear sample at continuous image coordinates (pixel i covers [i, i+1)). */
    fun sample(x: Double, y: Double): Double {
        val fx = min(max(x - 0.5, 0.0), limX)
        val fy = min(max(y - 0.5, 0.0), limY)
        val x0 = fx.toInt()
        val y0 = fy.toInt()
        val ax = fx - x0
        val ay = fy - y0
        val i = y0 * w + x0
        val lum = lum
        val a = lum[i].toInt() and 0xff
        val c = lum[i + w].toInt() and 0xff
        val top = a + ((lum[i + 1].toInt() and 0xff) - a) * ax
        val bot = c + ((lum[i + w + 1].toInt() and 0xff) - c) * ax
        return top + (bot - top) * ay
    }
}

private class Found(@JvmField val e: Ellipse, @JvmField val area: Int)

internal class Analysis(@JvmField val k: Int, @JvmField val passes: Array<Polarity>)

/**
 * One analysis of a frame shared by every format: luminance (downscaled by k), both threshold
 * polarities from one integral image, components and round candidates for each.
 */
internal fun analyze(data: ByteArray, rgba: Boolean, width: Int, height: Int, maxDimension: Int, polarity: GlintPolarity, buffers: Buffers): Analysis {
    val k = toLuma(data, rgba, width, height, maxDimension, buffers)
    val w = buffers.w
    val h = buffers.h
    val luma = buffers.luma
    val which = when (polarity) {
        GlintPolarity.BOTH -> booleanArrayOf(false, true)
        GlintPolarity.NORMAL -> booleanArrayOf(false)
        GlintPolarity.INVERTED -> booleanArrayOf(true)
    }
    threshold(luma, w, h, polarity != GlintPolarity.INVERTED, polarity != GlintPolarity.NORMAL, buffers)
    val passes = Array(which.size) { index ->
        val inverted = which[index]
        var lum = luma
        if (inverted) {
            lum = buffers.inv
            for (i in 0 until w * h) lum[i] = (255 - (luma[i].toInt() and 0xff)).toByte()
        }
        val cc = buffers.cc[index]
        cc.compute(if (inverted) buffers.maskInv else buffers.mask, w, h)
        val found = ArrayList<Found>()
        for (c in 0 until cc.count) {
            if (cc.n[c] < 12) continue
            val bw = cc.maxX[c] - cc.minX[c] + 1
            val bh = cc.maxY[c] - cc.minY[c] + 1
            if (bw < 5 || bh < 5 || bw > 5 * bh || bh > 5 * bw) continue
            val e = filledEllipse(cc, c)
            if (e != null && e.a >= 3) found.add(Found(e, bw * bh))
        }
        found.sortWith { a, b -> b.area - a.area }
        Polarity(inverted, lum, cc, w, List(min(found.size, 200)) { found[it].e }, h)
    }
    return Analysis(k, passes)
}
