package codes.glint

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/*
 * Reading a Capsule, in one pass over the frame:
 *
 * 1. Luminance, downscaled so the long side is at most `maxDimension`.
 * 2. Adaptive threshold (integral image) for "mark" pixels: lighter than their surroundings.
 *    The second polarity runs the same steps on the inverted image (dark marks on a light
 *    capsule, or bare marks on paper).
 * 3. Connected components as runs, with moments.
 * 4. Every round component is a candidate disc: its ellipse gives centre, scale and tilt up to a rotation.
 * 5. The rotation comes from matching a template of features every code has (start bar, gaps).
 * 6. The start and end bars are measured as components; their ends plus the disc fix a homography,
 *    which corrects perspective along the whole capsule.
 * 7. 96 cells are sampled with local thresholds and decoded with Reed–Solomon.
 */

private val BAR_VAR = run {
    // Variance along a bar of a filled stadium (centre line ±BAR_HALF, radius MARK/2), for matching measured bars.
    var sum = 0.0
    var sum2 = 0.0
    var count = 0.0
    val r = MARK / 2
    var y = -BAR_HALF - r
    while (y <= BAR_HALF + r) {
        val dy = max(0.0, abs(y) - BAR_HALF)
        val w = if (dy >= r) 0.0 else 2 * sqrt(r * r - dy * dy)
        sum += w * y
        sum2 += w * y * y
        count += w
        y += 0.002
    }
    val mean = sum / count
    sum2 / count - mean * mean
}
private val BAR_END = sqrt(3 * BAR_VAR)

private class Template {
    @JvmField var size = 0
    @JvmField var x = DoubleArray(64)
    @JvmField var y = DoubleArray(64)
    @JvmField var light = BooleanArray(64)
    @JvmField var w = DoubleArray(64)
    @JvmField var max = 0.0

    fun add(px: Double, py: Double, isLight: Boolean, weight: Double) {
        x[size] = px
        y[size] = py
        light[size] = isLight
        w[size] = weight
        max += weight
        size++
    }
}

// Features every code shares, near the disc (rotation search) and along the whole code (validation).
private val NEAR = Template().apply {
    for (y in doubleArrayOf(-0.5, -0.25, 0.0, 0.25, 0.5)) add(START_X, y, true, 2.0)
    for (y in doubleArrayOf(-0.45, 0.0, 0.45)) add(0.82, y, false, 1.0)
    for (y in ROWS) add(START_X + 0.25, y, false, 1.0)
    for (x in doubleArrayOf(1.6, 2.2, 2.8)) for (y in doubleArrayOf(-0.84, -0.36, 0.0, 0.36, 0.84)) add(x, y, false, 1.0)
}
private val FAR = Template().apply {
    var x = 1.6
    while (x < END_X - 0.3) {
        for (y in doubleArrayOf(-0.36, 0.0, 0.36)) add(x, y, false, 1.0)
        x += 0.6
    }
    for (y in doubleArrayOf(-0.4, 0.0, 0.4)) add(END_X, y, true, 2.0)
}

private val STEPS_CAPSULE = arrayOf(doubleArrayOf(6.0, 1.5), doubleArrayOf(1.0, 0.25))
private val OFFSETS_DX = doubleArrayOf(0.0, -0.06, 0.06)
private val OFFSETS_DY = doubleArrayOf(0.0, -0.2, 0.2)
private val OFFSETS_SIDE = doubleArrayOf(0.0, -0.3, 0.3)
private val BAR_Y = doubleArrayOf(-0.4, -0.2, 0.0, 0.2, 0.4)
private val DARK_Y = doubleArrayOf(-0.36, 0.0, 0.36)
private val RING_R = doubleArrayOf(START_X - 0.06, START_X + 0.06)

private fun match(p: Polarity, m: Map2, tpl: Template, t: Double): Double {
    var s = 0.0
    for (i in 0 until tpl.size) if ((m.sample(p, tpl.x[i], tpl.y[i]) > t) == tpl.light[i]) s += tpl.w[i]
    return s
}

private class EndBar(@JvmField val bar: Bar, @JvmField val along: Double)

private fun parallel(bar: Bar, ax: Double, ay: Double) = abs(bar.vx * ax + bar.vy * ay) / hypot(ax, ay)

/** Top then bottom end of a bar, as x, y pairs written to dst at `at`. */
private fun orient(affine: Map2, bar: Bar, x: Double, dst: DoubleArray, at: Int) {
    val ax = affine.x(x, -1.0)
    val ay = affine.y(x, -1.0)
    val bx = affine.x(x, 1.0)
    val by = affine.y(x, 1.0)
    val sgn = if (bar.vx * (bx - ax) + bar.vy * (by - ay) > 0) 1.0 else -1.0
    dst[at] = bar.cx - sgn * bar.vx * bar.half
    dst[at + 1] = bar.cy - sgn * bar.vy * bar.half
    dst[at + 2] = bar.cx + sgn * bar.vx * bar.half
    dst[at + 3] = bar.cy + sgn * bar.vy * bar.half
}

private val BAR_SRC = doubleArrayOf(
    START_X, -BAR_END, START_X, BAR_END, START_X, 0.0,
    END_X, -BAR_END, END_X, BAR_END, END_X, 0.0,
    0.0, 0.0, 0.0, -DISC_R, 0.0, DISC_R, -DISC_R, 0.0,
)

internal fun readCapsule(p: Polarity, e: Ellipse, erasures: Boolean): Read? {
    val cc = p.cc
    // Contrast between the disc's clear ring and the capsule around it.
    val base = Affine(e, 0.0, DISC_R)
    val lights = DoubleArray(12)
    val darks = DoubleArray(12)
    for (i in 0 until 12) {
        val a = (i.toDouble() / 12) * PI * 2
        val c = cos(a)
        val s = sin(a)
        lights[i] = base.sample(p, 0.52 * c, 0.52 * s)
        darks[i] = base.sample(p, 0.8 * c, 0.8 * s)
    }
    lights.sort()
    darks.sort()
    val light = lights[6]
    val dark = darks[6]
    if (light - dark < 18) return null
    val t = (light + dark) / 2
    var lightOk = 0
    var darkOk = 0
    for (v in lights) if (v > t) lightOk++
    for (v in darks) if (v < t) darkOk++
    if (lightOk < 10 || darkOk < 8) return null

    // Rotation: the start bar is a component just outside the disc. Look for bar-shaped components on
    // a ring there; each one gives a rotation, refined against the near template.
    val cp = cos(e.phi)
    val sp = sin(e.phi)
    val unit = (e.a + e.b) / 2 / DISC_R
    cc.clearSeen()
    val guesses = DoubleArray(80)
    var guessCount = 0
    for (k in 0 until 40) {
        val ang = (k.toDouble() / 40) * PI * 2
        val ca = cos(ang)
        val sa = sin(ang)
        for (r in RING_R) {
            val rx = r * ca
            val ry = r * sa
            val c = compAt(cc, base.x(rx, ry), base.y(rx, ry))
            if (c < 0 || !cc.markSeen(c)) continue
            val bar = barOf(cc, c)
            if (bar == null || bar.half < BAR_END * unit * 0.35 || bar.half > BAR_END * unit * 2.2) continue
            // Inverse of R(phi)·diag(a,b) scaled to DISC_R (rotation psi = 0).
            val dx = bar.cx - e.cx
            val dy = bar.cy - e.cy
            val u = (cp * dx + sp * dy) / e.a
            val v = (-sp * dx + cp * dy) / e.b
            val qx = u * DISC_R
            val qy = v * DISC_R
            val dist = hypot(qx, qy)
            if (dist < START_X * 0.75 || dist > START_X * 1.3) continue
            guesses[guessCount++] = atan2(qy, qx)
        }
    }
    var hasBest = false
    var bestPsi = 0.0
    var bestS = 0.0
    val deg = PI / 180
    for (g in 0 until guessCount) {
        var localPsi = guesses[g]
        var localS = match(p, Affine(e, localPsi, DISC_R), NEAR, t)
        for (pass in STEPS_CAPSULE) {
            val span = pass[0]
            val step = pass[1]
            val c = localPsi
            var d = -span
            while (d <= span) {
                val psi = c + d * deg
                val s = match(p, Affine(e, psi, DISC_R), NEAR, t)
                if (s > localS) {
                    localPsi = psi
                    localS = s
                }
                d += step
            }
        }
        if (!hasBest || localS > bestS) {
            hasBest = true
            bestPsi = localPsi
            bestS = localS
        }
    }
    if (!hasBest || bestS < NEAR.max * 0.85) return null
    val affine = Affine(e, bestPsi, DISC_R)

    // Bars. The start bar is a component right where the template says. The end bar may sit far from
    // the affine prediction under perspective, so walk the capsule's axis and take the first bar-like
    // component past the data (label letters come after it, data dashes lie across it).
    var start: Bar? = null
    run {
        val ax = affine.x(START_X, 1.0) - affine.x(START_X, -1.0)
        val ay = affine.y(START_X, 1.0) - affine.y(START_X, -1.0)
        val predicted = (BAR_END * hypot(ax, ay)) / 2
        var bestD = Double.POSITIVE_INFINITY
        for (dx in OFFSETS_DX) {
            for (dy in OFFSETS_DY) {
                val c = compAt(cc, affine.x(START_X + dx, dy), affine.y(START_X + dx, dy))
                val bar = (if (c < 0) null else barOf(cc, c)) ?: continue
                if (parallel(bar, ax, ay) < 0.85 || bar.half < predicted * 0.55 || bar.half > predicted * 1.45) continue
                val d = hypot(bar.cx - affine.x(START_X, 0.0), bar.cy - affine.y(START_X, 0.0))
                if (d < bestD) {
                    bestD = d
                    start = bar
                }
            }
        }
    }
    // Bar-like components past the data, nearest first; decoding decides which one is the real end bar.
    val maps = ArrayList<Map2>(4)
    val first = start
    if (first != null) {
        val ends = ArrayList<EndBar>(4)
        val ox = first.cx
        val oy = first.cy
        val dirX = affine.x(END_X, 0.0) - ox
        val dirY = affine.y(END_X, 0.0) - oy
        val len = hypot(dirX, dirY)
        val ux = dirX / len
        val uy = dirY / len
        cc.clearSeen()
        val step = max(0.5, len / (END_X - START_X) * 0.07)
        var along0 = len * 0.45
        while (along0 < len * 3) {
            for (off in OFFSETS_SIDE) {
                val spread = first.half * 1.4 + along0 * 0.05
                val qx = ox + ux * along0 - uy * off * spread
                val qy = oy + uy * along0 + ux * off * spread
                val c = compAt(cc, qx, qy)
                if (c < 0 || !cc.markSeen(c)) continue
                val bar = barOf(cc, c) ?: continue
                if (abs(bar.vx * first.vx + bar.vy * first.vy) < 0.75) continue
                if (bar.half < first.half * 0.35 || bar.half > first.half * 2.8) continue
                val along = (bar.cx - ox) * ux + (bar.cy - oy) * uy
                val across = abs(-(bar.cx - ox) * uy + (bar.cy - oy) * ux)
                if (across > first.half * 0.8 + along * 0.08 || along < len * 0.45) continue
                ends.add(EndBar(bar, along))
            }
            if (ends.size >= 3) break
            along0 += step
        }
        ends.sortWith { a, b -> a.along.compareTo(b.along) }

        for (end in ends) {
            val dst = DoubleArray(20)
            orient(affine, first, START_X, dst, 0)
            dst[4] = first.cx
            dst[5] = first.cy
            orient(affine, end.bar, END_X, dst, 6)
            dst[10] = end.bar.cx
            dst[11] = end.bar.cy
            dst[12] = e.cx
            dst[13] = e.cy
            dst[14] = affine.x(0.0, -DISC_R)
            dst[15] = affine.y(0.0, -DISC_R)
            dst[16] = affine.x(0.0, DISC_R)
            dst[17] = affine.y(0.0, DISC_R)
            dst[18] = affine.x(-DISC_R, 0.0)
            dst[19] = affine.y(-DISC_R, 0.0)
            val h = homography(BAR_SRC, dst, e.cx, e.cy, e.a)
            if (h != null) maps.add(h)
        }
    }
    maps.add(affine)

    val rowCount = ROWS.size
    val values = DoubleArray(rowCount * COLS)
    val darkAt = DoubleArray(COLS)
    val rel = DoubleArray(COLS)
    val sorted = DoubleArray(COLS)
    val cells = BooleanArray(rowCount * COLS)
    val conf = DoubleArray(rowCount * COLS)
    for (map in maps) {
        // Validate along the whole code before reading it.
        if (match(p, map, FAR, t) < FAR.max * 0.8) continue

        var ls = 0.0
        var le = 0.0
        for (y in BAR_Y) ls += map.sample(p, START_X, y)
        for (y in BAR_Y) le += map.sample(p, END_X, y)
        ls /= 5
        le /= 5
        // Raw cell values and the dark level between rows, per column.
        for (i in 0 until COLS) {
            val x = colX(i)
            var d = 0.0
            for (y in DARK_Y) d += map.sample(p, x, y)
            darkAt[i] = d / 3
            for (row in 0 until rowCount) {
                val y = ROWS[row]
                values[row + i * rowCount] = (map.sample(p, x - 0.06, y) + map.sample(p, x, y) + map.sample(p, x + 0.06, y)) / 3
            }
        }
        // Each row may have its own colour: its "set" level is the brighter part of its own values,
        // relative to the bars (so lighting gradients along the code still cancel out).
        for (row in 0 until rowCount) {
            for (i in 0 until COLS) {
                val l = ls + ((le - ls) * (colX(i) - START_X)) / (END_X - START_X)
                rel[i] = (values[row + i * rowCount] - darkAt[i]) / max(8.0, l - darkAt[i])
            }
            rel.copyInto(sorted)
            sorted.sort()
            val n = COLS - 1
            // Mean of the brightest quarter, but never below half the bar contrast.
            val top = max(0.5, (sorted[n] + sorted[n - 1] + sorted[n - 2] + sorted[n - 3] + sorted[n - 4] + sorted[n - 5]) / 6)
            val thr = top / 2
            for (i in 0 until COLS) {
                cells[row + i * rowCount] = rel[i] > thr
                conf[row + i * rowCount] = min(1.0, abs(rel[i] - thr) / thr)
            }
        }
        val out = decodeCells(cells, if (erasures) conf else null) ?: continue
        val right = RIGHT_CAP + 1
        val tx = map.x(0.0, -1.0)
        val ty = map.y(0.0, -1.0)
        val bx = map.x(0.0, 1.0)
        val by = map.y(0.0, 1.0)
        return Read(
            GlintFormat.CAPSULE,
            out.payload,
            payloadToNumber(out.payload),
            out.corrected,
            doubleArrayOf(
                map.x(-1.0, -1.0), map.y(-1.0, -1.0), map.x(right, -1.0), map.y(right, -1.0),
                map.x(right, 1.0), map.y(right, 1.0), map.x(-1.0, 1.0), map.y(-1.0, 1.0),
            ),
            map.x(0.0, 0.0),
            map.y(0.0, 0.0),
            hypot(tx - bx, ty - by),
        )
    }
    return null
}
