// Image analysis shared by every format: luminance, adaptive threshold, connected components,
// ellipse fitting and the geometry helpers the readers build on.

enum PixelLayout {
  case gray
  case rgba
  case bgra
}

struct ImageInput {
  /** Luminance (1 byte per pixel) or colour (4 bytes per pixel), rows `rowBytes` apart. */
  let data: UnsafePointer<UInt8>
  let width: Int
  let height: Int
  let rowBytes: Int
  let layout: PixelLayout
}

typealias Point = (Double, Double)

/** Array.prototype.sort: equal elements keep their order. */
func stableSorted<T>(_ a: [T], by less: (T, T) -> Bool) -> [T] {
  a.enumerated().sorted { less($0.element, $1.element) || (!less($1.element, $0.element) && $0.offset < $1.offset) }.map(\.element)
}

/** Storage that outlives a frame. `reserve` keeps no contents; `grow` does. */
final class Scratch<T> {
  private(set) var p: UnsafeMutablePointer<T>
  private var cap: Int

  init(_ cap: Int = 1) {
    self.cap = max(cap, 1)
    p = .allocate(capacity: self.cap)
  }

  deinit { p.deallocate() }

  func reserve(_ n: Int) {
    if n <= cap { return }
    p.deallocate()
    cap = n
    p = .allocate(capacity: n)
  }

  func grow(_ n: Int, used: Int) {
    let next = UnsafeMutablePointer<T>.allocate(capacity: n)
    next.moveInitialize(from: p, count: used)
    p.deallocate()
    p = next
    cap = n
  }
}

/** Reusable per-size buffers, so a camera loop doesn't allocate every frame. Not thread-safe: one per reader. */
final class Buffers {
  private var w = -1
  private var h = -1
  let luma = Scratch<UInt8>()
  let inv = Scratch<UInt8>()
  let integral = Scratch<UInt32>()
  let mask = Scratch<UInt8>()
  let maskInv = Scratch<UInt8>()
  let blockHi = Scratch<Float>()
  let blockLo = Scratch<Float>()
  let cc = [Components(), Components()]

  func ensure(_ w: Int, _ h: Int) {
    if w == self.w && h == self.h { return }
    self.w = w
    self.h = h
    luma.reserve(w * h)
    inv.reserve(w * h)
    integral.reserve((w + 1) * (h + 1))
    integral.p.initialize(repeating: 0, count: (w + 1) * (h + 1))
    mask.reserve(w * h)
    maskInv.reserve(w * h)
  }
}

func toLuma(_ img: ImageInput, _ maxDimension: Int, _ buffers: Buffers) -> (w: Int, h: Int, k: Int)? {
  let width = img.width, height = img.height, data = img.data, stride = img.rowBytes
  let k0 = jsMax(1, (Double(max(width, height)) / Double(maxDimension)).rounded(.up))
  if !k0.isFinite { return nil }
  let k = Int(k0)
  let w = width / k
  let h = height / k
  buffers.ensure(w, h)
  let out = buffers.luma.p
  let area = k * k
  let r = img.layout == .bgra ? 2 : 0
  let b = 2 - r
  if k == 1 {
    if img.layout == .gray {
      if stride == w {
        out.update(from: data, count: w * h)
      } else {
        for y in 0..<h { (out + y * w).update(from: data + y * stride, count: w) }
      }
    } else {
      for y in 0..<h {
        let row = data + y * stride
        let o = out + y * w
        for x in 0..<w {
          let px = row + x * 4
          o[x] = UInt8(truncatingIfNeeded: (Int(px[r]) * 77 + Int(px[1]) * 150 + Int(px[b]) * 29) >> 8)
        }
      }
    }
    return (w, h, k)
  }
  for y in 0..<h {
    for x in 0..<w {
      var s = 0
      for dy in 0..<k {
        let row = data + (y * k + dy) * stride
        if img.layout == .gray {
          let px = row + x * k
          for dx in 0..<k { s += Int(px[dx]) }
        } else {
          let px = row + x * k * 4
          for dx in 0..<k {
            let c = px + dx * 4
            s += (Int(c[r]) * 77 + Int(c[1]) * 150 + Int(c[b]) * 29) >> 8
          }
        }
      }
      out[y * w + x] = UInt8(truncatingIfNeeded: s / area)
    }
  }
  return (w, h, k)
}

/**
 * Pixels clearly lighter than the mean of their neighbourhood (`mask`), and clearly darker (`maskInv`,
 * the same test on the inverted image). The neighbourhood mean is computed once per 4×4 block; the
 * margin grows with brightness (mean + 7 + mean/14). Pixels are judged unsmoothed: smoothing would
 * cut camera noise but also erase the marks of codes under ~30 px tall.
 */
func threshold(_ lum: UnsafePointer<UInt8>, _ w: Int, _ h: Int, _ light: Bool, _ dark: Bool, _ buffers: Buffers) {
  let I = buffers.integral.p
  let W1 = w + 1
  for y in 0..<h {
    var row: UInt32 = 0
    let top = I + y * W1 + 1
    let cur = I + (y + 1) * W1 + 1
    let l = lum + y * w
    for x in 0..<w {
      row &+= UInt32(l[x])
      cur[x] = top[x] &+ row
    }
  }
  let r = max(4, Int(jsRound(Double(min(w, h)) / 28)))
  let bw = (w + 3) >> 2
  let bh = (h + 3) >> 2
  buffers.blockHi.reserve(bw * bh)
  buffers.blockLo.reserve(bw * bh)
  let hi = buffers.blockHi.p
  let lo = buffers.blockLo.p
  for by in 0..<bh {
    let cy = min(h - 1, by * 4 + 2)
    let y0 = max(0, cy - r), y1 = min(h, cy + r + 1)
    for bx in 0..<bw {
      let cx = min(w - 1, bx * 4 + 2)
      let x0 = max(0, cx - r), x1 = min(w, cx + r + 1)
      let area = Double((x1 - x0) * (y1 - y0))
      // Doubles, as in TS: the terms are read as they stand, wrapped or not.
      let mean = (Double(I[y1 * W1 + x1]) - Double(I[y0 * W1 + x1]) - Double(I[y1 * W1 + x0]) + Double(I[y0 * W1 + x0])) / area
      hi[by * bw + bx] = Float(mean + 7 + mean / 14)
      let inv = 255 - mean
      lo[by * bw + bx] = Float(255 - (inv + 7 + inv / 14))
    }
  }
  let mask = buffers.mask.p
  let maskInv = buffers.maskInv.p
  for y in 0..<h {
    let l = y * w
    let brow = (y >> 2) * bw
    for x in 0..<w {
      let v = lum[l + x]
      let b = brow + (x >> 2)
      let f = Float(v)
      mask[l + x] = light && f > hi[b] ? 1 : 0
      maskInv[l + x] = dark && f < lo[b] ? 1 : 0
    }
  }
}

final class Components {
  var count = 0
  // per run
  let runY = Scratch<Int32>(1 << 14)
  let runX0 = Scratch<Int32>(1 << 14)
  let runX1 = Scratch<Int32>(1 << 14)
  let parent = Scratch<Int32>(1 << 14)
  let runComp = Scratch<Int32>()
  let rowStart = Scratch<Int32>()
  var rows = 0
  private let compOf = Scratch<Int32>()
  // per component
  let n = Scratch<Double>()
  let sx = Scratch<Double>()
  let sy = Scratch<Double>()
  let sxx = Scratch<Double>()
  let syy = Scratch<Double>()
  let sxy = Scratch<Double>()
  let minX = Scratch<Int32>()
  let maxX = Scratch<Int32>()
  let minY = Scratch<Int32>()
  let maxY = Scratch<Int32>()
  let compRunStart = Scratch<Int32>()
  let compRuns = Scratch<Int32>()
  private let fill = Scratch<Int32>()

  func build(_ mask: UnsafePointer<UInt8>, _ w: Int, _ h: Int) {
    var cap = capacity
    var runY = self.runY.p
    var runX0 = self.runX0.p
    var runX1 = self.runX1.p
    var parent = self.parent.p
    rowStart.reserve(h + 1)
    let rowStart = self.rowStart.p
    rows = h
    var nr = 0
    @inline(__always) func find(_ start: Int) -> Int {
      var a = start
      while Int(parent[a]) != a {
        parent[a] = parent[Int(parent[a])]
        a = Int(parent[a])
      }
      return a
    }
    var prevStart = 0
    var prevEnd = 0
    for y in 0..<h {
      rowStart[y] = Int32(truncatingIfNeeded: nr)
      let row = mask + y * w
      var p = prevStart
      var x = 0
      while x < w {
        if row[x] == 0 {
          x += 1
          continue
        }
        let a = x
        while x < w && row[x] != 0 { x += 1 }
        let b = x - 1
        if nr == cap {
          cap *= 2
          self.runY.grow(cap, used: nr)
          self.runX0.grow(cap, used: nr)
          self.runX1.grow(cap, used: nr)
          self.parent.grow(cap, used: nr)
          runY = self.runY.p
          runX0 = self.runX0.p
          runX1 = self.runX1.p
          parent = self.parent.p
        }
        let id = nr
        nr += 1
        runY[id] = Int32(truncatingIfNeeded: y)
        runX0[id] = Int32(truncatingIfNeeded: a)
        runX1[id] = Int32(truncatingIfNeeded: b)
        parent[id] = Int32(truncatingIfNeeded: id)
        while p < prevEnd && Int(runX1[p]) < a - 1 { p += 1 }
        var q = p
        while q < prevEnd && Int(runX0[q]) <= b + 1 {
          let ra = find(id)
          let rb = find(q)
          if ra != rb { parent[ra < rb ? rb : ra] = Int32(truncatingIfNeeded: ra < rb ? ra : rb) }
          q += 1
        }
      }
      prevStart = Int(rowStart[y])
      prevEnd = nr
    }
    rowStart[h] = Int32(truncatingIfNeeded: nr)
    capacity = cap

    compOf.reserve(nr)
    self.runComp.reserve(nr)
    let compOf = self.compOf.p
    let runComp = self.runComp.p
    compOf.initialize(repeating: -1, count: nr)
    var count = 0
    for i in 0..<nr {
      let r = find(i)
      if compOf[r] < 0 {
        compOf[r] = Int32(truncatingIfNeeded: count)
        count += 1
      }
      runComp[i] = compOf[r]
    }
    self.count = count
    for s in [self.n, self.sx, self.sy, self.sxx, self.syy, self.sxy] {
      s.reserve(count)
      s.p.initialize(repeating: 0, count: count)
    }
    for s in [self.minX, self.maxX, self.minY, self.maxY] { s.reserve(count) }
    let n = self.n.p, sx = self.sx.p, sy = self.sy.p, sxx = self.sxx.p, syy = self.syy.p, sxy = self.sxy.p
    let minX = self.minX.p, maxX = self.maxX.p, minY = self.minY.p, maxY = self.maxY.p
    minX.initialize(repeating: 1 << 30, count: count)
    maxX.initialize(repeating: -1, count: count)
    minY.initialize(repeating: 1 << 30, count: count)
    maxY.initialize(repeating: -1, count: count)
    self.compRunStart.reserve(count + 1)
    let compRunStart = self.compRunStart.p
    compRunStart.initialize(repeating: 0, count: count + 1)
    for i in 0..<nr {
      let c = Int(runComp[i])
      let a = Double(runX0[i])
      let b = Double(runX1[i])
      let y = Double(runY[i])
      let len = b - a + 1
      let s1 = ((a + b) * len) / 2
      n[c] += len
      sx[c] += s1
      sy[c] += y * len
      sxx[c] += sq(b) - sq(a - 1)
      syy[c] += y * y * len
      sxy[c] += y * s1
      if runX0[i] < minX[c] { minX[c] = runX0[i] }
      if runX1[i] > maxX[c] { maxX[c] = runX1[i] }
      if runY[i] < minY[c] { minY[c] = runY[i] }
      if runY[i] > maxY[c] { maxY[c] = runY[i] }
      compRunStart[c + 1] += 1
    }
    for c in 0..<count { compRunStart[c + 1] += compRunStart[c] }
    self.fill.reserve(count)
    let fill = self.fill.p
    fill.update(from: compRunStart, count: count)
    self.compRuns.reserve(nr)
    let compRuns = self.compRuns.p
    for i in 0..<nr {
      let c = Int(runComp[i])
      compRuns[Int(fill[c])] = Int32(truncatingIfNeeded: i)
      fill[c] += 1
    }
  }

  private var capacity = 1 << 14
}

@inline(__always) private func sq(_ v: Double) -> Double { (v * (v + 1) * (2 * v + 1)) / 6 }

/** Component containing pixel (x, y), or -1. */
func compAt(_ cc: Components, _ x: Double, _ y: Double) -> Int {
  if !x.isFinite || !y.isFinite { return -1 }
  let yi = y.rounded(.down)
  let xi = x.rounded(.down)
  if yi < 0 || yi >= Double(cc.rows) { return -1 }
  let row = Int(yi)
  let rowStart = cc.rowStart.p, runX0 = cc.runX0.p, runX1 = cc.runX1.p
  var lo = Int(rowStart[row])
  var hi = Int(rowStart[row + 1]) - 1
  while lo <= hi {
    let m = (lo + hi) >> 1
    if Double(runX1[m]) < xi { lo = m + 1 } else if Double(runX0[m]) > xi { hi = m - 1 } else { return Int(cc.runComp.p[m]) }
  }
  return -1
}

struct Ellipse {
  let cx: Double
  let cy: Double
  let a: Double
  let b: Double
  let phi: Double
}

/** Ellipse of a component with its holes filled (each row from its leftmost to rightmost pixel). */
func filledEllipse(_ cc: Components, _ c: Int) -> Ellipse? {
  var A = 0.0, Sx = 0.0, Sy = 0.0, Sxx = 0.0, Syy = 0.0, Sxy = 0.0
  var row = -1, lo = 0, hi = 0
  @inline(__always) func flush() {
    if row < 0 { return }
    let dlo = Double(lo), dhi = Double(hi), drow = Double(row)
    let len = dhi - dlo + 1
    let s1 = ((dlo + dhi) * len) / 2
    A += len
    Sx += s1
    Sy += drow * len
    Sxx += sq(dhi) - sq(dlo - 1)
    Syy += drow * drow * len
    Sxy += drow * s1
  }
  let compRuns = cc.compRuns.p, runY = cc.runY.p, runX0 = cc.runX0.p, runX1 = cc.runX1.p
  for k in Int(cc.compRunStart.p[c])..<Int(cc.compRunStart.p[c + 1]) {
    let r = Int(compRuns[k])
    let y = Int(runY[r])
    if y != row {
      flush()
      row = y
      lo = Int(runX0[r])
      hi = Int(runX1[r])
    } else {
      if Int(runX0[r]) < lo { lo = Int(runX0[r]) }
      if Int(runX1[r]) > hi { hi = Int(runX1[r]) }
    }
  }
  flush()
  let mx = Sx / A
  let my = Sy / A
  // + 1/12: each pixel is a unit square, not a point.
  let vxx = Sxx / A - mx * mx + 1.0 / 12
  let vyy = Syy / A - my * my + 1.0 / 12
  let vxy = Sxy / A - mx * my
  let tr = (vxx + vyy) / 2
  let half = (vxx - vyy) / 2
  let d = (half * half + vxy * vxy).squareRoot()
  let l1 = tr + d
  let l2 = tr - d
  if l2 <= 0 { return nil }
  let a = 2 * l1.squareRoot()
  let b = 2 * l2.squareRoot()
  let ratio = A / (Double.pi * a * b)
  if ratio < 0.86 || ratio > 1.14 || b / a < 0.22 { return nil }
  return Ellipse(cx: mx + 0.5, cy: my + 0.5, a: a, b: b, phi: 0.5 * jsAtan2(2 * vxy, vxx - vyy))
}

/** Bilinear sample at continuous image coordinates (pixel i covers [i, i+1)). */
struct Sampler {
  let lum: UnsafePointer<UInt8>
  let w: Int
  let xMax: Double
  let yMax: Double

  init(_ lum: UnsafePointer<UInt8>, _ w: Int, _ h: Int) {
    self.lum = lum
    self.w = w
    xMax = Double(w) - 1.001
    yMax = Double(h) - 1.001
  }

  @inline(__always) func callAsFunction(_ x: Double, _ y: Double) -> Double {
    var fx = x - 0.5
    if fx < 0 { fx = 0 }
    if fx > xMax { fx = xMax }
    var fy = y - 0.5
    if fy < 0 { fy = 0 }
    if fy > yMax { fy = yMax }
    // NaN stays NaN here and in the result; `|0` makes it 0.
    let x0 = fx == fx ? Int(fx) : 0
    let y0 = fy == fy ? Int(fy) : 0
    let ax = fx - Double(x0)
    let ay = fy - Double(y0)
    let p = lum + y0 * w + x0
    let a = Int(p[0]), b = Int(p[1]), c = Int(p[w]), d = Int(p[w + 1])
    let top = Double(a) + Double(b - a) * ax
    let bot = Double(c) + Double(d - c) * ax
    return top + (bot - top) * ay
  }

  @inline(__always) func callAsFunction(_ p: Point) -> Double { self(p.0, p.1) }
}

typealias Map2 = (Double, Double) -> Point

/** Code units → image, as an affine map from a disc of radius discR (code units) seen as ellipse e, rotated by psi. */
struct AffineMap {
  let cx: Double
  let cy: Double
  let m00: Double
  let m01: Double
  let m10: Double
  let m11: Double

  init(_ e: Ellipse, _ psi: Double, _ discR: Double) {
    let s = 1 / discR
    let cp = jsCos(e.phi), sp = jsSin(e.phi)
    let cr = jsCos(psi), sr = jsSin(psi)
    // The unit circle maps onto the ellipse through R(phi) · diag(a, b) · R(psi).
    m00 = (cp * e.a * cr - sp * e.b * sr) * s
    m01 = (-cp * e.a * sr - sp * e.b * cr) * s
    m10 = (sp * e.a * cr + cp * e.b * sr) * s
    m11 = (-sp * e.a * sr + cp * e.b * cr) * s
    cx = e.cx
    cy = e.cy
  }

  @inline(__always) func callAsFunction(_ x: Double, _ y: Double) -> Point { (cx + m00 * x + m01 * y, cy + m10 * x + m11 * y) }
}

/** Least-squares homography (h33 = 1) from code points to image points. */
func homography(_ src: [Point], _ dst: [Point], _ origin: Point, _ scale: Double) -> Map2? {
  var N = [Double](repeating: 0, count: 64)
  var r = [Double](repeating: 0, count: 8)
  for i in 0..<src.count {
    let (x, y) = src[i]
    let u = (dst[i].0 - origin.0) / scale
    let v = (dst[i].1 - origin.1) / scale
    let rows: [([Double], Double)] = [
      ([x, y, 1, 0, 0, 0, -u * x, -u * y], u),
      ([0, 0, 0, x, y, 1, -v * x, -v * y], v),
    ]
    for (a, b) in rows {
      for j in 0..<8 {
        r[j] += a[j] * b
        for k in 0..<8 { N[j * 8 + k] += a[j] * a[k] }
      }
    }
  }
  // Gaussian elimination with partial pivoting.
  for c in 0..<8 {
    var best = c
    for k in (c + 1)..<max(8, c + 1) where N[k * 8 + c].magnitude > N[best * 8 + c].magnitude { best = k }
    if N[best * 8 + c].magnitude < 1e-12 { return nil }
    if best != c {
      for k in 0..<8 { N.swapAt(c * 8 + k, best * 8 + k) }
      r.swapAt(c, best)
    }
    for k in 0..<8 {
      if k == c { continue }
      let f = N[k * 8 + c] / N[c * 8 + c]
      if f == 0 || f != f { continue }
      for j in c..<8 { N[k * 8 + j] -= f * N[c * 8 + j] }
      r[k] -= f * r[c]
    }
  }
  let h = (0..<8).map { r[$0] / N[$0 * 8 + $0] }
  return { x, y in
    let d = h[6] * x + h[7] * y + 1
    return (origin.0 + (scale * (h[0] * x + h[1] * y + h[2])) / d, origin.1 + (scale * (h[3] * x + h[4] * y + h[5])) / d)
  }
}

struct Bar {
  let c: Point
  /** Unit vector along the bar. */
  let v: Point
  let half: Double
  let n: Double
}

func barOf(_ cc: Components, _ c: Int) -> Bar? {
  let n = cc.n.p[c]
  if n < 4 { return nil }
  let mx = cc.sx.p[c] / n, my = cc.sy.p[c] / n
  let vxx = cc.sxx.p[c] / n - mx * mx + 1.0 / 12
  let vyy = cc.syy.p[c] / n - my * my + 1.0 / 12
  let vxy = cc.sxy.p[c] / n - mx * my
  let tr = (vxx + vyy) / 2
  let half = (vxx - vyy) / 2
  let d = (half * half + vxy * vxy).squareRoot()
  let l1 = tr + d, l2 = tr - d
  if l1 < 4 * jsMax(l2, 0.05) { return nil }
  let t = 0.5 * jsAtan2(2 * vxy, vxx - vyy)
  return Bar(c: (mx + 0.5, my + 0.5), v: (jsCos(t), jsSin(t)), half: (3 * l1).squareRoot(), n: n)
}

struct Pass {
  /** True when this pass looks for marks darker than their surroundings (dark ink on paper). */
  let inverted: Bool
  let cc: Components
  let sample: Sampler
  /** Round components: possible finders, largest first. */
  let candidates: [Ellipse]
}

/**
 * One analysis of a frame shared by every format: luminance (downscaled by k), both threshold
 * polarities from one integral image, components and round candidates for each.
 */
func analyze(_ image: ImageInput, _ maxDimension: Int, _ polarity: GlintPolarity, _ buffers: Buffers) -> (k: Int, w: Int, h: Int, passes: [Pass])? {
  guard let (w, h, k) = toLuma(image, maxDimension, buffers) else { return nil }
  let luma = UnsafePointer(buffers.luma.p)
  let which: [Bool] = polarity == .both ? [false, true] : [polarity == .inverted]
  threshold(luma, w, h, which.contains(false), which.contains(true), buffers)
  var passes: [Pass] = []
  for inverted in which {
    var lum = luma
    if inverted {
      let out = buffers.inv.p
      for i in 0..<(w * h) { out[i] = 255 - luma[i] }
      lum = UnsafePointer(out)
    }
    let cc = buffers.cc[inverted ? 1 : 0]
    cc.build(inverted ? buffers.maskInv.p : buffers.mask.p, w, h)
    var found: [(e: Ellipse, area: Int)] = []
    for c in 0..<cc.count {
      if cc.n.p[c] < 12 { continue }
      let bw = Int(cc.maxX.p[c] - cc.minX.p[c]) + 1
      let bh = Int(cc.maxY.p[c] - cc.minY.p[c]) + 1
      if bw < 5 || bh < 5 || bw > 5 * bh || bh > 5 * bw { continue }
      if let e = filledEllipse(cc, c), e.a >= 3 { found.append((e, bw * bh)) }
    }
    found = stableSorted(found) { $0.area > $1.area }
    passes.append(Pass(inverted: inverted, cc: cc, sample: Sampler(lum, w, h), candidates: found.prefix(200).map(\.e)))
  }
  return (k, w, h, passes)
}
