package codes.glint

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/*
 * Round formats. All share one layout idea: a solid lens (the finder) in the middle with a glyph or
 * logo cut out of it, and data on rings around it. Code units: the code fits in radius 1, angles run
 * clockwise from 12 o'clock, a cell's point is (r·sin θ, −r·cos θ).
 *
 * - orbit:          rings of arcs; the inner ring is the same on every code (rotation, validation).
 * - constellation:  the same rings drawn as dots.
 * - halo:           52 rays, each 0–3 segments long (2 bits); the first 4 rays are fixed.
 * - contour:        4 wavy rings; a cell bulging out is 1, in is 0. The inner ring breaks at two cells: the start mark.
 */

private const val TAU = PI * 2

/** Fixed angles with their sines and cosines: the same bits as computing them at each use. */
private class Angles(n: Int, f: (Int) -> Double) {
    @JvmField val a = DoubleArray(n, f)
    @JvmField val sin = DoubleArray(n) { sin(a[it]) }
    @JvmField val cos = DoubleArray(n) { cos(a[it]) }
}

private fun midAngles(n: Int) = Angles(n) { ((it + 0.5) / n) * TAU }

private class Ring(@JvmField val r: Double, @JvmField val n: Int) {
    @JvmField val at = midAngles(n)
}

/** Sample points with a fixed value on every code: they give the rotation. */
private class Known(
    @JvmField val r: Double,
    a: Double,
    @JvmField val ink: Boolean,
    @JvmField val w: Double,
    /** Also look this far in and out, keeping the inkiest sample (for lines whose radius varies). */
    @JvmField val dr: Double = 0.0,
) {
    @JvmField val sin = sin(a)
    @JvmField val cos = cos(a)
}

private class Cell(@JvmField val ring: Int, @JvmField val i: Int, @JvmField val a: Double)

private class Spec(
    /** Lens radius; the lens ring between `glyph` and `lens` is always ink. */
    @JvmField val lens: Double,
    @JvmField val glyph: Double,
    /** A radius between lens and data that is always paper (except where `known` says otherwise). */
    @JvmField val paper: Double,
    @JvmField val seed: Int,
    /** Where between paper (0) and ink (1) the rotation search splits: lower for formats that may use light colours. */
    @JvmField val split: Double,
    @JvmField val known: Array<Known>,
    /** Binary rings of orbit and constellation, with the cells in reading order; empty otherwise. */
    @JvmField val rings: Array<Ring> = emptyArray(),
    @JvmField val cells: Array<Cell> = emptyArray(),
) {
    @JvmField val total = known.sumOf { it.w }
}

private fun byAngle(cells: List<Cell>) = cells.sortedWith { p, q ->
    val c = p.a.compareTo(q.a)
    if (c != 0) c else p.ring - q.ring
}

// ---------- orbit & constellation: binary cells on rings ----------

private const val SYNC = "111101110011100100100100"

private fun cellLayout(syncR: Double, syncN: Int, rings: Array<Ring>, lens: Double, glyph: Double, paper: Double, seed: Int): Spec {
    val cells = ArrayList<Cell>()
    rings.forEachIndexed { k, ring -> for (i in 0 until ring.n) cells.add(Cell(k, i, ring.at.a[i])) }
    check(cells.size == CODEWORD_BITS) { "layout must hold exactly one codeword" }
    val known = Array(SYNC.length) { i -> Known(syncR, ((i + 0.5) / syncN) * TAU, SYNC[i] == '1', 1.0) }
    return Spec(lens, glyph, paper, seed, 0.5, known, rings, byAngle(cells).toTypedArray())
}

private val ORBIT = cellLayout(0.6, 24, arrayOf(Ring(0.7, 28), Ring(0.8, 32), Ring(0.9, 36)), 0.46, 0.34, 0.53, 0x0b17c0de)
private val CONSTELLATION = cellLayout(0.55, 24, arrayOf(Ring(0.65, 28), Ring(0.75, 32), Ring(0.85, 36)), 0.4, 0.29, 0.455, 0xc0175e11.toInt())

// ---------- halo: rays of 4 lengths ----------

private const val HALO_RAYS = 52
private val HALO_FIXED = intArrayOf(3, 0, 3, 1)
private const val HALO_R0 = 0.53
private val HALO_LEN = doubleArrayOf(0.0, 0.12, 0.24, 0.38)

/** Radii between consecutive length levels: ink there means the ray reaches past it. */
private val HALO_PROBES = doubleArrayOf(HALO_R0 + 0.06, HALO_R0 + 0.18, HALO_R0 + 0.31)
private const val HALO_STROKE = 0.05

/** Ray end ÷ ray start (outer edge ÷ inner edge of the ink) between consecutive levels. */
private val HALO_RATIO_SPLIT = run {
    val inner = HALO_R0 - HALO_STROKE / 2
    val ratios = DoubleArray(4) { (HALO_R0 + HALO_LEN[it] + HALO_STROKE / 2) / inner }
    DoubleArray(3) { (ratios[it] + ratios[it + 1]) / 2 }
}
private val HALO_AT = Angles(HALO_RAYS) { (it.toDouble() / HALO_RAYS) * TAU }
private val HALO = Spec(
    0.4, 0.29, 0.455, 0x4a10c0de, 0.35,
    run {
        val k = ArrayList<Known>()
        for (i in 0 until HALO_RAYS) k.add(Known(HALO_R0, HALO_AT.a[i], true, 1.0))
        HALO_FIXED.forEachIndexed { i, level -> HALO_PROBES.forEachIndexed { j, r -> k.add(Known(r, HALO_AT.a[i], level > j, 3.0)) } }
        k.toTypedArray()
    },
)

// Two bits per ray, Gray-coded so that misjudging a length by one step costs one bit.
private val LEVEL_TO_GRAY = intArrayOf(0, 1, 3, 2)

// ---------- contour: wavy rings ----------

private val CONTOUR_RINGS = arrayOf(Ring(0.57, 20), Ring(0.69, 24), Ring(0.81, 28), Ring(0.93, 32))
private const val CONTOUR_AMP = 0.03

/** Cells of the inner ring where the line breaks: they mark the start, like a notch on a dial. */
private fun contourBreak(i: Int) = i == 0 || i == 3
private val CONTOUR_CELLS = run {
    val cells = ArrayList<Cell>()
    CONTOUR_RINGS.forEachIndexed { k, ring ->
        for (i in 0 until ring.n) if (k > 0 || !contourBreak(i)) cells.add(Cell(k, i, ring.at.a[i]))
    }
    byAngle(cells).toTypedArray()
}

/** Cells past the codeword carry a fixed alternating pattern. */
private fun contourPad(i: Int) = i % 2 == 0
private val CONTOUR = Spec(
    0.42, 0.3, 0.475, 0xc047c0de.toInt(), 0.5,
    Array(CONTOUR_RINGS[0].n) { i ->
        Known(CONTOUR_RINGS[0].r, CONTOUR_RINGS[0].at.a[i], !contourBreak(i), if (contourBreak(i)) 4.0 else 1.0, CONTOUR_AMP)
    },
)

/** cos θ, sin θ, cos 2θ, sin 2θ per cell of a contour ring, 5 entries each, leading with the constant term. */
private val CONTOUR_BASIS = Array(CONTOUR_RINGS.size) { k ->
    val count = CONTOUR_RINGS[k].n
    val out = DoubleArray(count * 5)
    for (i in 0 until count) {
        val a = ((i + 0.5) / count) * TAU
        out[i * 5] = 1.0
        out[i * 5 + 1] = cos(a)
        out[i * 5 + 2] = sin(a)
        out[i * 5 + 3] = cos(2 * a)
        out[i * 5 + 4] = sin(2 * a)
    }
    out
}

private fun specOf(format: GlintFormat) = when (format) {
    GlintFormat.ORBIT -> ORBIT
    GlintFormat.CONSTELLATION -> CONSTELLATION
    GlintFormat.HALO -> HALO
    GlintFormat.CONTOUR -> CONTOUR
    GlintFormat.CAPSULE -> throw IllegalArgumentException("capsule is not a round format")
}

internal fun seedOf(format: GlintFormat) = if (format == GlintFormat.CAPSULE) CAPSULE_SEED else specOf(format).seed

// ---------- reading ----------

private const val SECTORS = 16

/** How many different rotations a candidate may be read at. */
private const val MAX_ROTATIONS = 8
private val RING_24 = midAngles(24)
private val RING_48 = midAngles(48)
private val AROUND = Angles(SECTORS * 2) { (it.toDouble() / (SECTORS * 2)) * TAU }
private val SECTOR_AT = Angles(SECTORS * 4) { i -> (((i / 4) + ((i % 4) + 0.5) / 4) / SECTORS) * TAU }

private fun ringSamples(p: Polarity, m: Map2, r: Double, out: DoubleArray) {
    for (j in 0 until 24) out[j] = m.sample(p, r * RING_24.sin[j], -r * RING_24.cos[j])
}

/**
 * Cheap test shared by every round format, in lens radii: a solid lens, a paper gap right outside it,
 * and a clear quiet zone past the code. A dot from inside some code's rings fails the last part,
 * since at its own scale "past the code" lands on its neighbours.
 */
internal fun radialPrecheck(p: Polarity, e: Ellipse): Boolean {
    val m = Affine(e, 0.0, 1.0)
    val lens = DoubleArray(24)
    val gap = DoubleArray(24)
    ringSamples(p, m, 0.86, lens)
    ringSamples(p, m, 1.13, gap)
    lens.sort()
    gap.sort()
    val ink = lens[12]
    val paper = gap[12]
    if (ink - paper < 18) return false
    val t = (ink + paper) / 2
    if (lens[3] < t || gap[20] > t) return false
    ringSamples(p, m, 2.45, lens)
    var quiet = 0
    for (v in lens) if (v < t) quiet++
    if (quiet < 20) return false
    // Rings of data between 1.2 and 2.2 lens radii in every round format: a bullet or a letter "o"
    // has nothing there. Each probe takes the darkest of a few radii, since strokes are thin.
    var inked = 0
    for (j in 0 until 48) {
        val sa = RING_48.sin[j]
        val ca = RING_48.cos[j]
        var hit = false
        var r = 1.2
        while (r <= 2.1 && !hit) {
            hit = m.sample(p, r * sa, -r * ca) > t
            r += 0.06
        }
        if (hit) inked++
    }
    return inked >= 16
}

private fun scoreRotation(p: Polarity, e: Ellipse, spec: Spec, psi: Double, tk: Double, span: Double): Double {
    val m = Affine(e, psi, spec.lens)
    var s = 0.0
    for (k in spec.known) {
        var raw = m.sample(p, k.r * k.sin, -k.r * k.cos)
        if (k.dr != 0.0) {
            val inner = k.r - k.dr
            val outer = k.r + k.dr
            raw = max(max(m.sample(p, inner * k.sin, -inner * k.cos), raw), m.sample(p, outer * k.sin, -outer * k.cos))
        }
        val v = max(-1.0, min(1.0, (raw - tk) / span))
        s += k.w * (if (k.ink) v else -v)
    }
    return s
}

/** x / (1 + p·x): keeps the lens (centre and local scale) as fitted but bends the outer rings the way a tilted view does. */
private class Tilted(private val rot: Map2) : Map2() {
    @JvmField var scale = 1.0
    @JvmField var px = 0.0
    @JvmField var py = 0.0

    override fun x(x: Double, y: Double): Double {
        val w = 1 + px * x + py * y
        return rot.x((x * scale) / w, (y * scale) / w)
    }

    override fun y(x: Double, y: Double): Double {
        val w = 1 + px * x + py * y
        return rot.y((x * scale) / w, (y * scale) / w)
    }

    override fun sample(p: Polarity, x: Double, y: Double): Double {
        val w = 1 + px * x + py * y
        return rot.sample(p, (x * scale) / w, (y * scale) / w)
    }
}

// If the plain read fails: small scale corrections, then perspective. Triples of scale, px, py.
private val TRIES = run {
    val out = ArrayList<Double>()
    for (scale in doubleArrayOf(1.0, 0.97, 1.03, 0.94, 1.06)) {
        out.add(scale)
        out.add(0.0)
        out.add(0.0)
    }
    for (mag in doubleArrayOf(0.1, 0.2)) {
        for (k in 0 until 8) {
            val a = (k.toDouble() / 8) * TAU
            for (scale in doubleArrayOf(1.0, 0.96, 1.04)) {
                out.add(scale)
                out.add(mag * cos(a))
                out.add(mag * sin(a))
            }
        }
    }
    out.toDoubleArray()
}

private val REFINE = arrayOf(doubleArrayOf(2.0, 0.5), doubleArrayOf(0.5, 0.125))

/** How far from psi, in degrees, the score stays at `level` or above. */
private fun plateauEdge(p: Polarity, e: Ellipse, spec: Spec, psi: Double, dir: Double, level: Double, tk: Double, span: Double): Double {
    val deg = PI / 180
    var d = 0.0
    while (d < 12 && scoreRotation(p, e, spec, psi + dir * (d + 0.25) * deg, tk, span) >= level) d += 0.25
    return d
}

/**
 * Read a round code around candidate lens `e`. Finds the rotation from the format's fixed points,
 * then reads cells relative to per-sector ink/paper levels; a few small scale corrections are
 * tried when the first read doesn't decode (perspective makes the lens a slightly biased ruler).
 * `erasures` allows decoding that leans on cell confidence (see Detect.kt).
 */
internal fun readRadial(format: GlintFormat, p: Polarity, e: Ellipse, erasures: Boolean): Read? {
    val spec = specOf(format)
    val base = Affine(e, 0.0, spec.lens)

    // Ink and paper levels; reject candidates without a clean lens ring and paper gap.
    val inkR = (spec.glyph + spec.lens) / 2
    val inks = DoubleArray(SECTORS * 2)
    val papers = DoubleArray(SECTORS * 2)
    for (s in 0 until SECTORS * 2) {
        inks[s] = base.sample(p, inkR * AROUND.sin[s], -inkR * AROUND.cos[s])
        papers[s] = base.sample(p, spec.paper * AROUND.sin[s], -spec.paper * AROUND.cos[s])
    }
    val sortedInk = inks.copyOf()
    val sortedPaper = papers.copyOf()
    sortedInk.sort()
    sortedPaper.sort()
    val ink = sortedInk[SECTORS]
    val paper = sortedPaper[SECTORS]
    if (ink - paper < 18) return null
    val t = (ink + paper) / 2
    var inkOk = 0
    var paperOk = 0
    for (v in inks) if (v > t) inkOk++
    for (v in papers) if (v < t) paperOk++
    if (inkOk < SECTORS * 2 - 3) return null
    if (paperOk < SECTORS * 2 - 6) return null

    // Rotation. Soft score: how far each fixed point sits on its expected side of the split. On sharp
    // frames even this saturates into a plateau a few degrees wide, so the search ends by taking the
    // plateau's middle: its edge is far enough off to misread the outer rings.
    val total = spec.total
    val tk = paper + (ink - paper) * spec.split
    val span = (ink - paper) * min(spec.split, 1 - spec.split)
    val coarseS = DoubleArray(180)
    val coarsePsi = DoubleArray(180)
    // Stable: equal scores keep ascending angle.
    val order = IntArray(180)
    for (i in 0 until 180) {
        coarsePsi[i] = ((i * 2).toDouble() / 180) * PI
        val s = scoreRotation(p, e, spec, coarsePsi[i], tk, span)
        coarseS[i] = s
        var j = i
        while (j > 0 && coarseS[order[j - 1]] < s) {
            order[j] = order[j - 1]
            j--
        }
        order[j] = i
    }
    if (coarseS[order[0]] < total * 0.4) return null
    // Every distinct rotation that fits: data can repeat a format's fixed pattern (Halo's four rays turn
    // up by chance in about one code in six), and only decoding can tell which one is real.
    val deg = PI / 180
    val picked = DoubleArray(180)
    var pickedCount = 0
    val rotations = DoubleArray(MAX_ROTATIONS)
    var rotationCount = 0
    candidates@ for (i in 0 until 180) {
        val s0 = coarseS[order[i]]
        val psi0 = coarsePsi[order[i]]
        if (rotationCount >= MAX_ROTATIONS || s0 < total * 0.4) break
        for (j in 0 until pickedCount) if (abs(((picked[j] - psi0 + 3 * PI) % TAU) - PI) < 5 * deg) continue@candidates
        picked[pickedCount++] = psi0
        var localPsi = psi0
        var localS = s0
        for (pass in REFINE) {
            val width = pass[0]
            val step = pass[1]
            val c = localPsi
            var d = -width
            while (d <= width) {
                val s = scoreRotation(p, e, spec, c + d * deg, tk, span)
                if (s > localS) {
                    localPsi = c + d * deg
                    localS = s
                }
                d += step
            }
        }
        if (localS < total * 0.6) continue
        val level = localS - total * 0.01
        val up = plateauEdge(p, e, spec, localPsi, 1.0, level, tk, span)
        val down = plateauEdge(p, e, spec, localPsi, -1.0, level, tk, span)
        rotations[rotationCount++] = localPsi + ((up - down) / 2) * deg
    }
    if (rotationCount == 0) return null

    // Per-sector references (code angle), so uneven light across the code cancels out.
    val vals = DoubleArray(4)
    val pv = DoubleArray(4)
    val views = Array(rotationCount) { r ->
        val sectorInk = DoubleArray(SECTORS)
        val sectorPaper = DoubleArray(SECTORS)
        val rot = Affine(e, rotations[r], spec.lens)
        for (s in 0 until SECTORS) {
            for (j in 0 until 4) {
                val at = s * 4 + j
                vals[j] = rot.sample(p, inkR * SECTOR_AT.sin[at], -inkR * SECTOR_AT.cos[at])
                pv[j] = rot.sample(p, spec.paper * SECTOR_AT.sin[at], -spec.paper * SECTOR_AT.cos[at])
            }
            vals.sort()
            pv.sort()
            sectorInk[s] = (vals[1] + vals[2]) / 2
            sectorPaper[s] = (pv[1] + pv[2]) / 2
        }
        CellReader(p, Tilted(rot), sectorInk, sectorPaper)
    }

    var at = 0
    while (at < TRIES.size) {
        val scale = TRIES[at]
        val px = TRIES[at + 1]
        val py = TRIES[at + 2]
        at += 3
        // Contour only: a long run of equal cells looks like drift, so plain views also try a weaker drift model.
        val lowest = if (format == GlintFormat.CONTOUR && px == 0.0 && py == 0.0) 0 else 2
        for (view in views) {
            val m = view.m
            m.scale = scale
            m.px = px
            m.py = py
            for (harmonics in 2 downTo lowest) {
                if (!view.read(format, spec, harmonics)) continue
                val decoded = decodeBits(view.bits, spec.seed, if (erasures) view.conf else null) ?: continue
                val tx = m.x(0.0, -1.0)
                val ty = m.y(0.0, -1.0)
                val bx = m.x(0.0, 1.0)
                val by = m.y(0.0, 1.0)
                return Read(
                    format,
                    decoded.payload,
                    payloadToNumber(decoded.payload),
                    decoded.corrected,
                    doubleArrayOf(m.x(-1.0, -1.0), m.y(-1.0, -1.0), m.x(1.0, -1.0), m.y(1.0, -1.0), m.x(1.0, 1.0), m.y(1.0, 1.0), m.x(-1.0, 1.0), m.y(-1.0, 1.0)),
                    m.x(0.0, 0.0),
                    m.y(0.0, 0.0),
                    hypot(tx - bx, ty - by),
                )
            }
        }
    }
    return null
}

/** Threshold one ring's relative values at half the level of its brighter cells. */
private fun binarize(values: DoubleArray, bits: BooleanArray, conf: DoubleArray) {
    val sorted = values.copyOf()
    sorted.sort()
    val n = max(3, sorted.size shr 2)
    var sum = 0.0
    for (i in 0 until n) sum += sorted[sorted.size - 1 - i]
    val thr = max(0.25, sum / n / 2)
    for (i in values.indices) {
        bits[i] = values[i] > thr
        conf[i] = min(1.0, abs(values[i] - thr) / thr)
    }
}

/** Least-squares fit of v[i] ≈ c0 + c1·cos θ + s1·sin θ + c2·cos 2θ + s2·sin 2θ at cell angles, up to `harmonics`. */
private fun harmonicFit(v: DoubleArray, ring: Int, harmonics: Int, out: DoubleArray) {
    val count = v.size
    val basis = CONTOUR_BASIS[ring]
    val half = count.toDouble() / 2
    // Cell angles are evenly spaced, so the basis is orthogonal: each coefficient is a projection.
    var c0 = 0.0
    var c1 = 0.0
    var c2 = 0.0
    var c3 = 0.0
    var c4 = 0.0
    for (i in 0 until count) {
        val b = i * 5
        c0 += (v[i] * basis[b]) / count
        if (harmonics >= 1) {
            c1 += (v[i] * basis[b + 1]) / half
            c2 += (v[i] * basis[b + 2]) / half
        }
        if (harmonics >= 2) {
            c3 += (v[i] * basis[b + 3]) / half
            c4 += (v[i] * basis[b + 4]) / half
        }
    }
    for (i in 0 until count) {
        val b = i * 5
        out[i] = basis[b] * c0 + basis[b + 1] * c1 + basis[b + 2] * c2 + basis[b + 3] * c3 + basis[b + 4] * c4
    }
}

private class CellReader(
    private val p: Polarity,
    @JvmField val m: Tilted,
    private val sectorInk: DoubleArray,
    private val sectorPaper: DoubleArray,
) {
    @JvmField val bits = BooleanArray(CODEWORD_BITS)
    @JvmField val conf = DoubleArray(CODEWORD_BITS)

    private fun rel(v: Double, a: Double): Double {
        val x = ((a / TAU) * SECTORS - 0.5 + SECTORS) % SECTORS
        val s0 = floor(x).toInt()
        val u = x - s0
        val s1 = (s0 + 1) % SECTORS
        val i = sectorInk[s0] * (1 - u) + sectorInk[s1] * u
        val q = sectorPaper[s0] * (1 - u) + sectorPaper[s1] * u
        return (v - q) / max(8.0, i - q)
    }

    private fun relAt(r: Double, a: Double, sa: Double, ca: Double) = rel(m.sample(p, r * sa, -r * ca), a)

    fun read(format: GlintFormat, spec: Spec, harmonics: Int) = when (format) {
        GlintFormat.HALO -> readHalo()
        GlintFormat.CONTOUR -> readContour(harmonics)
        else -> readRings(spec)
    }

    private fun readRings(spec: Spec): Boolean {
        val rings = spec.rings
        // Strokes are thin: take the strongest of three radii, so a ring seen slightly off its radius
        // (perspective, a biased lens fit) still reads as ink.
        val ringBits = Array(rings.size) { BooleanArray(rings[it].n) }
        val ringConf = Array(rings.size) { DoubleArray(rings[it].n) }
        for (k in rings.indices) {
            val ring = rings[k]
            val at = ring.at
            val vals = DoubleArray(ring.n)
            for (i in 0 until ring.n) {
                val a = at.a[i]
                val sa = at.sin[i]
                val ca = at.cos[i]
                vals[i] = max(max(relAt(ring.r - 0.022, a, sa, ca), relAt(ring.r, a, sa, ca)), relAt(ring.r + 0.022, a, sa, ca))
            }
            binarize(vals, ringBits[k], ringConf[k])
        }
        val cells = spec.cells
        for (k in cells.indices) {
            bits[k] = ringBits[cells[k].ring][cells[k].i]
            conf[k] = ringConf[cells[k].ring][cells[k].i]
        }
        return true
    }

    private fun readHalo(): Boolean {
        // Trace each ray outwards: where its ink starts (the base dot) and where it ends. The ratio of
        // the two gives the length level and doesn't care about the local scale, which perspective and
        // a biased lens fit both distort.
        val thr = 0.3
        val levels = IntArray(HALO_RAYS)
        val confs = DoubleArray(HALO_RAYS)
        for (i in 0 until HALO_RAYS) {
            val a = HALO_AT.a[i]
            var start = -1.0
            var end = -1.0
            var misses = 0
            var r = 0.45
            while (r <= 1.02) {
                val d = 0.012 / r
                val v = max(max(relAt(r, a - d, sin(a - d), cos(a - d)), relAt(r, a, HALO_AT.sin[i], HALO_AT.cos[i])), relAt(r, a + d, sin(a + d), cos(a + d)))
                if (v > thr) {
                    if (start < 0) start = r
                    end = r
                    misses = 0
                } else if (start >= 0 && ++misses > 2) break
                r += 0.01
            }
            if (start < 0) return false
            val ratio = end / start
            var level = 0
            while (level < 3 && ratio > HALO_RATIO_SPLIT[level]) level++
            val lower = if (level > 0) HALO_RATIO_SPLIT[level - 1] else Double.NEGATIVE_INFINITY
            val upper = if (level < 3) HALO_RATIO_SPLIT[level] else Double.POSITIVE_INFINITY
            // Most rotations tried are wrong: don't trace the other rays once a fixed one disagrees.
            if (i < HALO_FIXED.size && level != HALO_FIXED[i]) return false
            levels[i] = level
            confs[i] = min(1.0, min(ratio - lower, upper - ratio) / 0.08)
        }
        var n = 0
        for (i in HALO_FIXED.size until HALO_RAYS) {
            val g = LEVEL_TO_GRAY[levels[i]]
            bits[n] = g >= 2
            bits[n + 1] = g and 1 == 1
            conf[n] = confs[i]
            conf[n + 1] = confs[i]
            n += 2
        }
        return true
    }

    private fun isBreak(ring: Int, i: Int) = ring == 0 && contourBreak(i)

    /** Line position (radial offset from the nominal radius) at each cell: the ink-weighted centre of a window. */
    private fun measure(k: Int, center: DoubleArray, half: Double, out: DoubleArray) {
        val ring = CONTOUR_RINGS[k]
        val at = ring.at
        for (i in center.indices) {
            val c = center[i]
            if (isBreak(k, i)) {
                out[i] = c
                continue
            }
            val a = at.a[i]
            val sa = at.sin[i]
            val ca = at.cos[i]
            var sw = 0.0
            var sx = 0.0
            var d = c - half
            while (d <= c + half + 1e-9) {
                val w = max(0.0, relAt(ring.r + d, a, sa, ca) - 0.25)
                sw += w
                sx += w * d
                d += half / 6
            }
            out[i] = if (sw > 0) sx / sw else c
        }
    }

    /**
     * Separate the slow drift (scale and perspective errors: a constant and two harmonics) from the
     * ±amplitude signal, alternating: estimate the signal, fit the drift to what's left, repeat.
     */
    private fun split(k: Int, raw: DoubleArray, harmonics: Int, trend: DoubleArray) {
        val signal = DoubleArray(raw.size)
        val rest = DoubleArray(raw.size)
        for (iter in 0 until 4) {
            for (i in raw.indices) rest[i] = raw[i] - signal[i]
            harmonicFit(rest, k, harmonics, trend)
            for (i in raw.indices) signal[i] = if (raw[i] - trend[i] > 0) CONTOUR_AMP else -CONTOUR_AMP
        }
    }

    private fun readContour(harmonics: Int): Boolean {
        val offsets = Array(CONTOUR_RINGS.size) { k ->
            val n = CONTOUR_RINGS[k].n
            val zero = DoubleArray(n)
            val wide = DoubleArray(n)
            val drift = DoubleArray(n)
            val fine = DoubleArray(n)
            val trend = DoubleArray(n)
            // First pass with a wide window finds where the ring really is; the second re-centres a
            // narrower window on that drift, so a neighbouring ring can't pull the centre.
            measure(k, zero, 0.065, wide)
            split(k, wide, harmonics, drift)
            measure(k, drift, CONTOUR_AMP + 0.03, fine)
            split(k, fine, harmonics, trend)
            DoubleArray(n) { i -> if (isBreak(k, i)) 0.0 else fine[i] - trend[i] }
        }
        val cells = CONTOUR_CELLS
        // The pad cells must read as their fixed pattern, or this isn't a contour code.
        var padOk = 0
        for (k in cells.indices) {
            val v = offsets[cells[k].ring][cells[k].i]
            if (k < CODEWORD_BITS) {
                bits[k] = v > 0
                conf[k] = min(1.0, abs(v) / CONTOUR_AMP)
            } else if ((v > 0) == contourPad(k)) padOk++
        }
        return padOk >= cells.size - CODEWORD_BITS - 2
    }
}
