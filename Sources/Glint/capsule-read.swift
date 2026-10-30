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

private let BAR_VAR: Double = {
  // Variance along a bar of a filled stadium (centre line ±BAR_HALF, radius MARK/2), for matching measured bars.
  var sum = 0.0
  var sum2 = 0.0
  var count = 0.0
  let r = MARK / 2
  var y = -BAR_HALF - r
  while y <= BAR_HALF + r {
    let dy = jsMax(0, y.magnitude - BAR_HALF)
    let w = dy >= r ? 0 : 2 * (r * r - dy * dy).squareRoot()
    sum += w * y
    sum2 += w * y * y
    count += w
    y += 0.002
  }
  let mean = sum / count
  return sum2 / count - mean * mean
}()
let BAR_END = (3 * BAR_VAR).squareRoot()

private struct Feature {
  let x: Double
  let y: Double
  let light: Bool
  let w: Double
}

// Features every code shares, near the disc (rotation search) and along the whole code (validation).
private let templates: (near: [Feature], far: [Feature]) = {
  var near: [Feature] = []
  var far: [Feature] = []
  for y in [-0.5, -0.25, 0, 0.25, 0.5] { near.append(Feature(x: START_X, y: y, light: true, w: 2)) }
  for y in [-0.45, 0, 0.45] { near.append(Feature(x: 0.82, y: y, light: false, w: 1)) }
  for y in ROWS { near.append(Feature(x: START_X + 0.25, y: y, light: false, w: 1)) }
  for x in [1.6, 2.2, 2.8] { for y in [-0.84, -0.36, 0, 0.36, 0.84] { near.append(Feature(x: x, y: y, light: false, w: 1)) } }
  var x = 1.6
  while x < END_X - 0.3 {
    for y in [-0.36, 0, 0.36] { far.append(Feature(x: x, y: y, light: false, w: 1)) }
    x += 0.6
  }
  for y in [-0.4, 0, 0.4] { far.append(Feature(x: END_X, y: y, light: true, w: 2)) }
  return (near, far)
}()
private let NEAR = templates.near
private let FAR = templates.far
private let NEAR_MAX = NEAR.reduce(0) { $0 + $1.w }
private let FAR_MAX = FAR.reduce(0) { $0 + $1.w }

func readCapsule(_ P: Pass, _ e: Ellipse, _ erasures: Bool) -> Read? {
  let sample = P.sample, cc = P.cc
  // Contrast between the disc's clear ring and the capsule around it.
  let base = AffineMap(e, 0, DISC_R)
  var lightOk = 0, darkOk = 0
  var lights: [Double] = [], darks: [Double] = []
  lights.reserveCapacity(12)
  darks.reserveCapacity(12)
  for i in 0..<12 {
    let a = (Double(i) / 12) * Double.pi * 2
    let c = jsCos(a), s = jsSin(a)
    lights.append(sample(base(0.52 * c, 0.52 * s)))
    darks.append(sample(base(0.8 * c, 0.8 * s)))
  }
  lights.sort()
  darks.sort()
  let light = lights[6]
  let dark = darks[6]
  if light - dark < 18 { return nil }
  let t = (light + dark) / 2
  for v in lights where v > t { lightOk += 1 }
  for v in darks where v < t { darkOk += 1 }
  if lightOk < 10 || darkOk < 8 { return nil }

  // Rotation: the start bar is a component just outside the disc. Look for bar-shaped components on
  // a ring there; each one gives a rotation, refined against the near template.
  func score(_ psi: Double, _ tpl: [Feature]) -> Double {
    let m = AffineMap(e, psi, DISC_R)
    var s = 0.0
    for p in tpl where (sample(m(p.x, p.y)) > t) == p.light { s += p.w }
    return s
  }
  let cp = jsCos(e.phi), sp = jsSin(e.phi)
  func toCode(_ x: Double, _ y: Double) -> Point {
    // Inverse of R(phi)·diag(a,b) scaled to DISC_R (rotation psi = 0).
    let dx = x - e.cx, dy = y - e.cy
    let u = (cp * dx + sp * dy) / e.a, v = (-sp * dx + cp * dy) / e.b
    return (u * DISC_R, v * DISC_R)
  }
  let unit = (e.a + e.b) / 2 / DISC_R
  var seen = Set<Int>()
  var guesses: [Double] = []
  for k in 0..<40 {
    let ang = (Double(k) / 40) * Double.pi * 2
    for r in [START_X - 0.06, START_X + 0.06] {
      let q = base(r * jsCos(ang), r * jsSin(ang))
      let c = compAt(cc, q.0, q.1)
      if c < 0 || seen.contains(c) { continue }
      seen.insert(c)
      guard let bar = barOf(cc, c), !(bar.half < BAR_END * unit * 0.35 || bar.half > BAR_END * unit * 2.2) else { continue }
      let (qx, qy) = toCode(bar.c.0, bar.c.1)
      let dist = jsHypot(qx, qy)
      if dist < START_X * 0.75 || dist > START_X * 1.3 { continue }
      guesses.append(jsAtan2(qy, qx))
    }
  }
  var best: (psi: Double, s: Double)? = nil
  let deg = Double.pi / 180
  for psi0 in guesses {
    var local = (psi: psi0, s: score(psi0, NEAR))
    for (span, step) in [(6.0, 1.5), (1.0, 0.25)] {
      let c = local.psi
      var d = -span
      while d <= span {
        let psi = c + d * deg
        let s = score(psi, NEAR)
        if s > local.s { local = (psi, s) }
        d += step
      }
    }
    if best == nil || local.s > best!.s { best = local }
  }
  guard let found = best, found.s >= NEAR_MAX * 0.85 else { return nil }
  let affine = AffineMap(e, found.psi, DISC_R)

  // Bars. The start bar is a component right where the template says. The end bar may sit far from
  // the affine prediction under perspective, so walk the capsule's axis and take the first bar-like
  // component past the data (label letters come after it, data dashes lie across it).
  func axisAt(_ x: Double) -> Point {
    let (ax, ay) = affine(x, -1)
    let (bx, by) = affine(x, 1)
    return (bx - ax, by - ay)
  }
  func parallel(_ bar: Bar, _ axis: Point) -> Double { (bar.v.0 * axis.0 + bar.v.1 * axis.1).magnitude / jsHypot(axis.0, axis.1) }
  var start: Bar? = nil
  do {
    let axis = axisAt(START_X)
    let predicted = (BAR_END * jsHypot(axis.0, axis.1)) / 2
    var bestD = Double.infinity
    for dx in [0, -0.06, 0.06] {
      for dy in [0, -0.2, 0.2] {
        let q = affine(START_X + dx, dy)
        let c = compAt(cc, q.0, q.1)
        guard c >= 0, let bar = barOf(cc, c), !(parallel(bar, axis) < 0.85 || bar.half < predicted * 0.55 || bar.half > predicted * 1.45) else { continue }
        let (px, py) = affine(START_X, 0)
        let d = jsHypot(bar.c.0 - px, bar.c.1 - py)
        if d < bestD {
          bestD = d
          start = bar
        }
      }
    }
  }
  // Bar-like components past the data, nearest first; decoding decides which one is the real end bar.
  var ends: [(bar: Bar, along: Double)] = []
  if let start {
    let (ox, oy) = start.c
    let (fx, fy) = affine(END_X, 0)
    let dir: Point = (fx - ox, fy - oy)
    let len = jsHypot(dir.0, dir.1)
    let ux = dir.0 / len, uy = dir.1 / len
    var seen = Set<Int>()
    let step = jsMax(0.5, len / (END_X - START_X) * 0.07)
    var t = len * 0.45
    while t < len * 3 {
      for off in [0, -0.3, 0.3] {
        let spread = start.half * 1.4 + t * 0.05
        let qx = ox + ux * t - uy * off * spread
        let qy = oy + uy * t + ux * off * spread
        let c = compAt(cc, qx, qy)
        if c < 0 || seen.contains(c) { continue }
        seen.insert(c)
        guard let bar = barOf(cc, c) else { continue }
        if (bar.v.0 * start.v.0 + bar.v.1 * start.v.1).magnitude < 0.75 { continue }
        if bar.half < start.half * 0.35 || bar.half > start.half * 2.8 { continue }
        let along = (bar.c.0 - ox) * ux + (bar.c.1 - oy) * uy
        let across = (-(bar.c.0 - ox) * uy + (bar.c.1 - oy) * ux).magnitude
        if across > start.half * 0.8 + along * 0.08 || along < len * 0.45 { continue }
        ends.append((bar, along))
      }
      if ends.count >= 3 { break }
      t += step
    }
    ends = stableSorted(ends) { $0.along < $1.along }
  }

  var maps: [Map2] = []
  if let start {
    for (end, _) in ends {
      func orient(_ bar: Bar, _ x: Double) -> (Point, Point) {
        let (ax, ay) = affine(x, -1)
        let (bx, by) = affine(x, 1)
        let sgn: Double = bar.v.0 * (bx - ax) + bar.v.1 * (by - ay) > 0 ? 1 : -1
        let top: Point = (bar.c.0 - sgn * bar.v.0 * bar.half, bar.c.1 - sgn * bar.v.1 * bar.half)
        let bottom: Point = (bar.c.0 + sgn * bar.v.0 * bar.half, bar.c.1 + sgn * bar.v.1 * bar.half)
        return (top, bottom)
      }
      let (st, sb) = orient(start, START_X)
      let (et, eb) = orient(end, END_X)
      let src: [Point] = [
        (START_X, -BAR_END), (START_X, BAR_END), (START_X, 0),
        (END_X, -BAR_END), (END_X, BAR_END), (END_X, 0),
        (0, 0), (0, -DISC_R), (0, DISC_R), (-DISC_R, 0),
      ]
      let dst: [Point] = [st, sb, start.c, et, eb, end.c, (e.cx, e.cy), affine(0, -DISC_R), affine(0, DISC_R), affine(-DISC_R, 0)]
      if let H = homography(src, dst, (e.cx, e.cy), e.a) { maps.append(H) }
    }
  }
  maps.append { affine($0, $1) }

  for map in maps {
    // Validate along the whole code before reading it.
    var s = 0.0
    for p in FAR where (sample(map(p.x, p.y)) > t) == p.light { s += p.w }
    if s < FAR_MAX * 0.8 { continue }

    func barLight(_ x: Double) -> Double {
      var v = 0.0
      for y in [-0.4, -0.2, 0, 0.2, 0.4] { v += sample(map(x, y)) }
      return v / 5
    }
    let ls = barLight(START_X), le = barLight(END_X)
    // Raw cell values and the dark level between rows, per column.
    var values = [[Double]](repeating: [Double](repeating: 0, count: COLS), count: ROWS.count)
    var darkAt = [Double](repeating: 0, count: COLS)
    for i in 0..<COLS {
      let x = colX(i)
      var d = 0.0
      for y in [-0.36, 0, 0.36] { d += sample(map(x, y)) }
      darkAt[i] = d / 3
      for (row, y) in ROWS.enumerated() {
        values[row][i] = (sample(map(x - 0.06, y)) + sample(map(x, y)) + sample(map(x + 0.06, y))) / 3
      }
    }
    // Each row may have its own colour: its "set" level is the brighter part of its own values,
    // relative to the bars (so lighting gradients along the code still cancel out).
    var cells = [[Bool]](repeating: [Bool](repeating: false, count: COLS), count: ROWS.count)
    var conf = [[Double]](repeating: [Double](repeating: 0, count: COLS), count: ROWS.count)
    for row in 0..<ROWS.count {
      var rel: [Double] = []
      for i in 0..<COLS {
        let l = ls + ((le - ls) * (colX(i) - START_X)) / (END_X - START_X)
        rel.append((values[row][i] - darkAt[i]) / jsMax(8, l - darkAt[i]))
      }
      let sorted = rel.sorted(by: >)
      // Mean of the brightest quarter, but never below half the bar contrast.
      let top = jsMax(0.5, (sorted[0] + sorted[1] + sorted[2] + sorted[3] + sorted[4] + sorted[5]) / 6)
      let thr = top / 2
      for i in 0..<COLS {
        cells[row][i] = rel[i] > thr
        conf[row][i] = jsMin(1, (rel[i] - thr).magnitude / thr)
      }
    }
    if let out = decodeCells(cells, erasures ? conf : nil) {
      let right = RIGHT_CAP + 1
      let top = map(0, -1), bottom = map(0, 1)
      return Read(
        format: .capsule,
        payload: out.payload,
        value: payloadToNumber(out.payload),
        corrected: out.corrected,
        corners: [map(-1, -1), map(right, -1), map(right, 1), map(-1, 1)],
        center: map(0, 0),
        size: jsHypot(top.0 - bottom.0, top.1 - bottom.1)
      )
    }
  }
  return nil
}
