/*
 * Round formats. All share one layout idea: a solid lens (the finder) in the middle with a glyph or
 * logo cut out of it, and data on rings around it. Code units: the code fits in radius 1, angles run
 * clockwise from 12 o'clock, a cell's point is (r·sin θ, −r·cos θ).
 *
 * - orbit:          rings of arcs; the inner ring is the same on every code (rotation, validation).
 * - constellation:  the same rings drawn as dots.
 * - halo:           52 rays, each 0–3 segments long (2 bits); the first 4 rays are fixed.
 * - contour:        4 wavy rings; a cell bulging out is 1, in is 0. The inner ring breaks at two cells: the start mark.
 *
 * Unlike the TS, an angle's sine and cosine are computed once (`Angle`): same values, and most of the run time.
 */

private let TAU = Double.pi * 2
private let SECTORS = 16
/** How many different rotations a candidate may be read at. */
private let MAX_ROTATIONS = 8

/** An angle with what the reader derives from it: its sine and cosine, and its place between sectors. */
private struct Angle {
  let a: Double
  let sin: Double
  let cos: Double
  let s0: Int
  let s1: Int
  let u: Double

  init(_ a: Double) {
    self.a = a
    sin = jsSin(a)
    cos = jsCos(a)
    let x = ((a / TAU) * Double(SECTORS) - 0.5 + Double(SECTORS)).truncatingRemainder(dividingBy: Double(SECTORS))
    let f = x.rounded(.down)
    s0 = Int(f)
    u = x - f
    s1 = (s0 + 1) % SECTORS
  }
}

@inline(__always) private func polar(_ r: Double, _ a: Angle) -> Point { (r * a.sin, -r * a.cos) }

private struct Ring {
  let r: Double
  let n: Int
  /** Cell angles, (i + 0.5) / n · 2π. */
  let angles: [Angle]

  init(r: Double, n: Int) {
    self.r = r
    self.n = n
    angles = (0..<n).map { Angle(((Double($0) + 0.5) / Double(n)) * TAU) }
  }
}

private struct Known {
  let at: Point
  /** `dr`: also look this far in and out, keeping the inkiest sample (for lines whose radius varies). */
  let inOut: (Point, Point)?
  let ink: Bool
  let w: Double

  init(r: Double, a: Double, ink: Bool, w: Double, dr: Double = 0) {
    let angle = Angle(a)
    at = polar(r, angle)
    inOut = dr != 0 ? (polar(r - dr, angle), polar(r + dr, angle)) : nil
    self.ink = ink
    self.w = w
  }
}

private struct Cell {
  let ring: Int
  let i: Int
  let a: Double
}

private struct Spec {
  /** Lens radius; the lens ring between `glyph` and `lens` is always ink. */
  let lens: Double
  let glyph: Double
  /** A radius between lens and data that is always paper (except where `known` says otherwise). */
  let paper: Double
  let whitening: [Int]
  /** Where between paper (0) and ink (1) the rotation search splits: lower for formats that may use light colours. */
  let split: Double
  /** Sample points with a fixed value on every code: they give the rotation. */
  let known: [Known]
}

private func sortedCells(_ cells: [Cell]) -> [Cell] {
  stableSorted(cells) { $0.a != $1.a ? $0.a < $1.a : $0.ring < $1.ring }
}

// ---------- orbit & constellation: binary cells on rings ----------

private let SYNC = Array("111101110011100100100100")

private struct CellLayout {
  let spec: Spec
  let rings: [Ring]
  /** Data cells in reading order (sorted by angle, so a smudge on one side costs few bytes). */
  let cells: [Cell]

  init(sync: Ring, rings: [Ring], lens: Double, glyph: Double, paper: Double, seed: UInt32) {
    var cells: [Cell] = []
    for (k, ring) in rings.enumerated() {
      for i in 0..<ring.n { cells.append(Cell(ring: k, i: i, a: ring.angles[i].a)) }
    }
    self.cells = sortedCells(cells)
    self.rings = rings
    precondition(cells.count == CODEWORD_BITS, "layout must hold exactly one codeword")
    let known = SYNC.enumerated().map { i, c in Known(r: sync.r, a: ((Double(i) + 0.5) / Double(sync.n)) * TAU, ink: c == "1", w: 1) }
    spec = Spec(lens: lens, glyph: glyph, paper: paper, whitening: whitening(seed), split: 0.5, known: known)
  }
}

private let ORBIT = CellLayout(
  sync: Ring(r: 0.6, n: 24), rings: [Ring(r: 0.7, n: 28), Ring(r: 0.8, n: 32), Ring(r: 0.9, n: 36)],
  lens: 0.46, glyph: 0.34, paper: 0.53, seed: 0x0b17c0de
)

private let CONSTELLATION = CellLayout(
  sync: Ring(r: 0.55, n: 24), rings: [Ring(r: 0.65, n: 28), Ring(r: 0.75, n: 32), Ring(r: 0.85, n: 36)],
  lens: 0.4, glyph: 0.29, paper: 0.455, seed: 0xc0175e11
)

// ---------- halo: rays of 4 lengths ----------

private let HALO_RAYS = 52
private let HALO_FIXED = [3, 0, 3, 1]
private let HALO_R0 = 0.53
private let HALO_LEN = [0, 0.12, 0.24, 0.38]
/** Radii between consecutive length levels: ink there means the ray reaches past it. */
private let HALO_PROBES = [HALO_R0 + 0.06, HALO_R0 + 0.18, HALO_R0 + 0.31]
private let HALO_STROKE = 0.05
/** Ray end ÷ ray start (outer edge ÷ inner edge of the ink) between consecutive levels. */
private let HALO_RATIO_SPLIT: [Double] = {
  let inner = HALO_R0 - HALO_STROKE / 2
  let ratios = HALO_LEN.map { (HALO_R0 + $0 + HALO_STROKE / 2) / inner }
  return [0, 1, 2].map { (ratios[$0] + ratios[$0 + 1]) / 2 }
}()
private let HALO_ANGLES = (0..<HALO_RAYS).map { (Double($0) / Double(HALO_RAYS)) * TAU }
private let HALO = Spec(
  lens: 0.4,
  glyph: 0.29,
  paper: 0.455,
  whitening: whitening(0x4a10c0de),
  split: 0.35,
  known: {
    var k: [Known] = []
    for i in 0..<HALO_RAYS { k.append(Known(r: HALO_R0, a: HALO_ANGLES[i], ink: true, w: 1)) }
    for (i, level) in HALO_FIXED.enumerated() {
      for (j, r) in HALO_PROBES.enumerated() { k.append(Known(r: r, a: HALO_ANGLES[i], ink: level > j, w: 3)) }
    }
    return k
  }()
)
// Two bits per ray, Gray-coded so that misjudging a length by one step costs one bit.
private let LEVEL_TO_GRAY = [0, 1, 3, 2]

// ---------- contour: wavy rings ----------

private let CONTOUR_RINGS = [Ring(r: 0.57, n: 20), Ring(r: 0.69, n: 24), Ring(r: 0.81, n: 28), Ring(r: 0.93, n: 32)]
private let CONTOUR_AMP = 0.03
/** Cells of the inner ring where the line breaks: they mark the start, like a notch on a dial. */
private let CONTOUR_BREAKS = [0, 3]
private let CONTOUR_CELLS: [Cell] = {
  var cells: [Cell] = []
  for (k, ring) in CONTOUR_RINGS.enumerated() {
    for i in 0..<ring.n where k > 0 || !CONTOUR_BREAKS.contains(i) { cells.append(Cell(ring: k, i: i, a: ring.angles[i].a)) }
  }
  return sortedCells(cells)
}()
/** Cells past the codeword carry a fixed alternating pattern. */
@inline(__always) private func contourPad(_ i: Int) -> Bool { i % 2 == 0 }
private let CONTOUR = Spec(
  lens: 0.42,
  glyph: 0.3,
  paper: 0.475,
  whitening: whitening(0xc047c0de),
  split: 0.5,
  known: (0..<CONTOUR_RINGS[0].n).map { i in
    Known(
      r: CONTOUR_RINGS[0].r,
      a: ((Double(i) + 0.5) / Double(CONTOUR_RINGS[0].n)) * TAU,
      ink: !CONTOUR_BREAKS.contains(i),
      w: CONTOUR_BREAKS.contains(i) ? 4 : 1,
      dr: CONTOUR_AMP
    )
  }
)

private func spec(_ format: GlintFormat) -> Spec {
  switch format {
  case .orbit: return ORBIT.spec
  case .constellation: return CONSTELLATION.spec
  case .halo: return HALO
  default: return CONTOUR
  }
}

// ---------- reading ----------

private let PRECHECK_24 = (0..<24).map { Angle(((Double($0) + 0.5) / 24) * TAU) }
private let PRECHECK_48 = (0..<48).map { Angle(((Double($0) + 0.5) / 48) * TAU) }

/**
 * Cheap test shared by every round format, in lens radii: a solid lens, a paper gap right outside it,
 * and a clear quiet zone past the code. A dot from inside some code's rings fails the last part,
 * since at its own scale "past the code" lands on its neighbours.
 */
func radialPrecheck(_ P: Pass, _ e: Ellipse) -> Bool {
  let m = AffineMap(e, 0, 1)
  let sample = P.sample
  func ring(_ r: Double) -> [Double] {
    var out: [Double] = []
    out.reserveCapacity(24)
    for a in PRECHECK_24 {
      let p = polar(r, a)
      out.append(sample(m(p.0, p.1)))
    }
    return out
  }
  let lens = ring(0.86).sorted()
  let gap = ring(1.13).sorted()
  let ink = lens[12]
  let paper = gap[12]
  if ink - paper < 18 { return false }
  let t = (ink + paper) / 2
  if lens[3] < t || gap[20] > t { return false }
  if ring(2.45).filter({ $0 < t }).count < 20 { return false }
  // Rings of data between 1.2 and 2.2 lens radii in every round format: a bullet or a letter "o"
  // has nothing there. Each probe takes the darkest of a few radii, since strokes are thin.
  var inked = 0
  for a in PRECHECK_48 {
    var hit = false
    var r = 1.2
    while r <= 2.1 && !hit {
      let p = polar(r, a)
      hit = sample(m(p.0, p.1)) > t
      r += 0.06
    }
    if hit { inked += 1 }
  }
  return inked >= 16
}

private let ANGLES_32 = (0..<(SECTORS * 2)).map { Angle((Double($0) / Double(SECTORS * 2)) * TAU) }
private let COARSE = stride(from: 0, to: 360, by: 2).map { (Double($0) / 180) * Double.pi }
private let SECTOR_ANGLES = (0..<SECTORS).map { s in
  (0..<4).map { j in Angle(((Double(s) + (Double(j) + 0.5) / 4) / Double(SECTORS)) * TAU) }
}
// If the plain read fails: small scale corrections, then perspective. x / (1 + p·x) keeps the lens
// (centre and local scale) as fitted but bends the outer rings the way a tilted view does.
private let TRIES: [(scale: Double, px: Double, py: Double)] = {
  var tries: [(Double, Double, Double)] = []
  for scale in [1, 0.97, 1.03, 0.94, 1.06] { tries.append((scale, 0, 0)) }
  for mag in [0.1, 0.2] {
    for k in 0..<8 {
      let a = (Double(k) / 8) * TAU
      for scale in [1, 0.96, 1.04] { tries.append((scale, mag * jsCos(a), mag * jsSin(a))) }
    }
  }
  return tries
}()

/** The map of one try, and relative cell values under it. */
private struct Reader {
  let rot: AffineMap
  let scale: Double
  let px: Double
  let py: Double
  let sample: Sampler
  /** SECTORS ink levels, then SECTORS paper levels. */
  let sectors: UnsafePointer<Double>

  @inline(__always) func m(_ x: Double, _ y: Double) -> Point {
    let w = 1 + px * x + py * y
    return rot((x * scale) / w, (y * scale) / w)
  }

  @inline(__always) func rel(_ r: Double, _ a: Angle) -> Double {
    let p0 = polar(r, a)
    let v = sample(m(p0.0, p0.1))
    let i = sectors[a.s0] * (1 - a.u) + sectors[a.s1] * a.u
    let p = sectors[SECTORS + a.s0] * (1 - a.u) + sectors[SECTORS + a.s1] * a.u
    return (v - p) / jsMax(8, i - p)
  }
}

/**
 * Read a round code around candidate lens `e`. Finds the rotation from the format's fixed points,
 * then reads cells relative to per-sector ink/paper levels; a few small scale corrections are
 * tried when the first read doesn't decode (perspective makes the lens a slightly biased ruler).
 * `erasures` allows decoding that leans on cell confidence (see detect.swift).
 */
func readRadial(_ format: GlintFormat, _ P: Pass, _ e: Ellipse, _ erasures: Bool) -> Read? {
  let spec = spec(format)
  let sample = P.sample
  let base = AffineMap(e, 0, spec.lens)
  @inline(__always) func at(_ m: AffineMap, _ r: Double, _ a: Angle) -> Double {
    let p = polar(r, a)
    return sample(m(p.0, p.1))
  }

  // Ink and paper levels; reject candidates without a clean lens ring and paper gap.
  let inkR = (spec.glyph + spec.lens) / 2
  var inks: [Double] = []
  var papers: [Double] = []
  inks.reserveCapacity(SECTORS * 2)
  papers.reserveCapacity(SECTORS * 2)
  for a in ANGLES_32 {
    inks.append(at(base, inkR, a))
    papers.append(at(base, spec.paper, a))
  }
  let sortedInk = inks.sorted()
  let sortedPaper = papers.sorted()
  let ink = sortedInk[SECTORS]
  let paper = sortedPaper[SECTORS]
  if ink - paper < 18 { return nil }
  let t = (ink + paper) / 2
  if inks.filter({ $0 > t }).count < SECTORS * 2 - 3 { return nil }
  if papers.filter({ $0 < t }).count < SECTORS * 2 - 6 { return nil }

  // Rotation. Soft score: how far each fixed point sits on its expected side of the split. On sharp
  // frames even this saturates into a plateau a few degrees wide, so the search ends by taking the
  // plateau's middle: its edge is far enough off to misread the outer rings.
  let total = spec.known.reduce(0) { $0 + $1.w }
  let tk = paper + (ink - paper) * spec.split
  let span = (ink - paper) * jsMin(spec.split, 1 - spec.split)
  let known = spec.known
  func score(_ psi: Double) -> Double {
    let m = AffineMap(e, psi, spec.lens)
    var s = 0.0
    for k in known {
      var raw = sample(m(k.at.0, k.at.1))
      if let (i, o) = k.inOut { raw = jsMax(jsMax(sample(m(i.0, i.1)), raw), sample(m(o.0, o.1))) }
      let v = jsMax(-1, jsMin(1, (raw - tk) / span))
      s += k.w * (k.ink ? v : -v)
    }
    return s
  }
  let coarse = stableSorted(COARSE.map { (s: score($0), psi: $0) }) { $0.s > $1.s }
  if coarse[0].s < total * 0.4 { return nil }
  // Every distinct rotation that fits: data can repeat a format's fixed pattern (Halo's four rays turn
  // up by chance in about one code in six), and only decoding can tell which one is real.
  let deg = Double.pi / 180
  var picked: [Double] = []
  var rotations: [Double] = []
  for (s0, psi0) in coarse {
    if rotations.count >= MAX_ROTATIONS || s0 < total * 0.4 { break }
    if picked.contains(where: { (($0 - psi0 + 3 * Double.pi).truncatingRemainder(dividingBy: TAU) - Double.pi).magnitude < 5 * deg }) { continue }
    picked.append(psi0)
    var local = (psi: psi0, s: s0)
    for (width, step) in [(2.0, 0.5), (0.5, 0.125)] {
      let c = local.psi
      var d = -width
      while d <= width {
        let s = score(c + d * deg)
        if s > local.s { local = (c + d * deg, s) }
        d += step
      }
    }
    if local.s < total * 0.6 { continue }
    let level = local.s - total * 0.01
    func edge(_ dir: Double) -> Double {
      var d = 0.0
      while d < 12 && score(local.psi + dir * (d + 0.25) * deg) >= level { d += 0.25 }
      return d
    }
    rotations.append(local.psi + ((edge(1) - edge(-1)) / 2) * deg)
  }
  if rotations.isEmpty { return nil }

  // Per-sector references (code angle), so uneven light across the code cancels out.
  let rots = rotations.map { AffineMap(e, $0, spec.lens) }
  var levels = [Double](repeating: 0, count: rots.count * SECTORS * 2)
  for (v, rot) in rots.enumerated() {
    for s in 0..<SECTORS {
      var vals: [Double] = []
      var pv: [Double] = []
      for a in SECTOR_ANGLES[s] {
        vals.append(at(rot, inkR, a))
        pv.append(at(rot, spec.paper, a))
      }
      vals.sort()
      pv.sort()
      levels[v * SECTORS * 2 + s] = (vals[1] + vals[2]) / 2
      levels[v * SECTORS * 2 + SECTORS + s] = (pv[1] + pv[2]) / 2
    }
  }

  return levels.withUnsafeBufferPointer { sectors in
    for (scale, px, py) in TRIES {
      for (v, rot) in rots.enumerated() {
        let reader = Reader(rot: rot, scale: scale, px: px, py: py, sample: sample, sectors: sectors.baseAddress! + v * SECTORS * 2)
        // Contour only: a long run of equal cells looks like drift, so plain views also try a weaker drift model.
        for harmonics in format == .contour && px == 0 && py == 0 ? [2, 1, 0] : [2] {
          guard let out = readCells(format, reader, harmonics), let decoded = decodeBits(out.bits, spec.whitening, erasures ? out.conf : nil) else { continue }
          let top = reader.m(0, -1), bottom = reader.m(0, 1)
          return Read(
            format: format,
            payload: decoded.payload,
            value: payloadToNumber(decoded.payload),
            corrected: decoded.corrected,
            corners: [reader.m(-1, -1), reader.m(1, -1), reader.m(1, 1), reader.m(-1, 1)],
            center: reader.m(0, 0),
            size: jsHypot(top.0 - bottom.0, top.1 - bottom.1)
          )
        }
      }
    }
    return nil
  }
}

/** Threshold one ring's relative values at half the level of its brighter cells. */
private func binarize(_ values: [Double]) -> (bits: [Bool], conf: [Double]) {
  let sorted = values.sorted(by: >)
  let top = sorted[0..<max(3, sorted.count >> 2)]
  let thr = jsMax(0.25, top.reduce(0, +) / Double(top.count) / 2)
  return (values.map { $0 > thr }, values.map { jsMin(1, ($0 - thr).magnitude / thr) })
}

private func readCells(_ format: GlintFormat, _ R: Reader, _ harmonics: Int) -> (bits: [Bool], conf: [Double])? {
  if format == .orbit || format == .constellation {
    let L = format == .orbit ? ORBIT : CONSTELLATION
    // Strokes are thin: take the strongest of three radii, so a ring seen slightly off its radius
    // (perspective, a biased lens fit) still reads as ink.
    let perRing = L.rings.map { ring -> (bits: [Bool], conf: [Double]) in
      var vals: [Double] = []
      vals.reserveCapacity(ring.n)
      for a in ring.angles { vals.append(jsMax(jsMax(R.rel(ring.r - 0.022, a), R.rel(ring.r, a)), R.rel(ring.r + 0.022, a))) }
      return binarize(vals)
    }
    return (L.cells.map { perRing[$0.ring].bits[$0.i] }, L.cells.map { perRing[$0.ring].conf[$0.i] })
  }
  if format == .halo {
    // Trace each ray outwards: where its ink starts (the base dot) and where it ends. The ratio of
    // the two gives the length level and doesn't care about the local scale, which perspective and
    // a biased lens fit both distort.
    let thr = 0.3
    var bits: [Bool] = []
    var conf: [Double] = []
    var levels: [Int] = []
    var confs: [Double] = []
    for i in 0..<HALO_RAYS {
      let a = HALO_ANGLES[i]
      let mid = Angle(a)
      var start = -1.0
      var end = -1.0
      var misses = 0
      var r = 0.45
      while r <= 1.02 {
        let d = 0.012 / r
        let v = jsMax(jsMax(R.rel(r, Angle(a - d)), R.rel(r, mid)), R.rel(r, Angle(a + d)))
        if v > thr {
          if start < 0 { start = r }
          end = r
          misses = 0
        } else if start >= 0 {
          misses += 1
          if misses > 2 { break }
        }
        r += 0.01
      }
      if start < 0 { return nil }
      let ratio = end / start
      var level = 0
      while level < 3 && ratio > HALO_RATIO_SPLIT[level] { level += 1 }
      let lower = level > 0 ? HALO_RATIO_SPLIT[level - 1] : -Double.infinity
      let upper = level < 3 ? HALO_RATIO_SPLIT[level] : Double.infinity
      // Most rotations tried are wrong: don't trace the other rays once a fixed one disagrees.
      if i < HALO_FIXED.count && level != HALO_FIXED[i] { return nil }
      levels.append(level)
      confs.append(jsMin(1, jsMin(ratio - lower, upper - ratio) / 0.08))
    }
    for i in HALO_FIXED.count..<HALO_RAYS {
      let g = LEVEL_TO_GRAY[levels[i]]
      bits.append(g >= 2)
      bits.append(g & 1 == 1)
      conf.append(confs[i])
      conf.append(confs[i])
    }
    return (bits, conf)
  }
  // contour: where along the radius each ring's line sits at each cell, relative to the ring's own trend.
  let isBreak = { (ring: Int, i: Int) in ring == 0 && CONTOUR_BREAKS.contains(i) }
  // Line position (radial offset from the nominal radius) at each cell: the ink-weighted centre of a window.
  func measure(_ k: Int, _ center: [Double], _ half: Double) -> [Double] {
    let ring = CONTOUR_RINGS[k]
    var out = center
    for i in 0..<center.count {
      if isBreak(k, i) { continue }
      let c = center[i]
      let a = ring.angles[i]
      var sw = 0.0, sx = 0.0
      var d = c - half
      while d <= c + half + 1e-9 {
        let w = jsMax(0, R.rel(ring.r + d, a) - 0.25)
        sw += w
        sx += w * d
        d += half / 6
      }
      out[i] = sw > 0 ? sx / sw : c
    }
    return out
  }
  // Separate the slow drift (scale and perspective errors: a constant and two harmonics) from the
  // ±amplitude signal, alternating: estimate the signal, fit the drift to what's left, repeat.
  func split(_ k: Int, _ raw: [Double]) -> [Double] {
    var signal = [Double](repeating: 0, count: raw.count)
    var trend = signal
    for _ in 0..<4 {
      var rest = raw
      for i in 0..<raw.count { rest[i] = raw[i] - signal[i] }
      trend = harmonicFit(rest, k, harmonics)
      for i in 0..<raw.count { signal[i] = raw[i] - trend[i] > 0 ? CONTOUR_AMP : -CONTOUR_AMP }
    }
    return trend
  }
  var offsets: [[Double]] = []
  for k in 0..<CONTOUR_RINGS.count {
    let ring = CONTOUR_RINGS[k]
    // First pass with a wide window finds where the ring really is; the second re-centres a
    // narrower window on that drift, so a neighbouring ring can't pull the centre.
    let wide = measure(k, [Double](repeating: 0, count: ring.n), 0.065)
    let drift = split(k, wide)
    let fine = measure(k, drift, CONTOUR_AMP + 0.03)
    let trend = split(k, fine)
    offsets.append(fine.indices.map { isBreak(k, $0) ? 0 : fine[$0] - trend[$0] })
  }
  var bits: [Bool] = []
  var conf: [Double] = []
  // The pad cells must read as their fixed pattern, or this isn't a contour code.
  var padOk = 0
  for (k, c) in CONTOUR_CELLS.enumerated() {
    let v = offsets[c.ring][c.i]
    if k < CODEWORD_BITS {
      bits.append(v > 0)
      conf.append(jsMin(1, v.magnitude / CONTOUR_AMP))
    } else if (v > 0) == contourPad(k) {
      padOk += 1
    }
  }
  return padOk >= CONTOUR_CELLS.count - CODEWORD_BITS - 2 ? (bits, conf) : nil
}

private let HARMONICS: [[[Double]]] = CONTOUR_RINGS.map { ring in
  (0..<ring.n).map { i in
    let a = ((Double(i) + 0.5) / Double(ring.n)) * TAU
    return [1, jsCos(a), jsSin(a), jsCos(2 * a), jsSin(2 * a)]
  }
}

/** Least-squares fit of v[i] ≈ c0 + c1·cos θ + s1·sin θ + c2·cos 2θ + s2·sin 2θ at cell angles of ring `k`, up to `harmonics`. */
private func harmonicFit(_ v: [Double], _ k: Int, _ harmonics: Int) -> [Double] {
  let basis = HARMONICS[k]
  let count = Double(v.count)
  // Cell angles are evenly spaced, so the basis is orthogonal: each coefficient is a projection.
  let terms = 1 + 2 * harmonics
  var coef = [0.0, 0, 0, 0, 0]
  let norm = [count, count / 2, count / 2, count / 2, count / 2]
  for i in 0..<v.count {
    let b = basis[i]
    for j in 0..<terms { coef[j] += (v[i] * b[j]) / norm[j] }
  }
  return v.indices.map { i in
    var s = 0.0
    for j in 0..<5 { s += basis[i][j] * coef[j] }
    return s
  }
}
