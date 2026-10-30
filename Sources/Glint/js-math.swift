// What JavaScript's Math does, to the bit. The reader breaks ties between nearly equal scores, so a
// libm that is one ulp off can pick another rotation. sin, cos and atan2 are fdlibm, as in V8; hypot
// is V8's Kahan sum. The rest of JS's number semantics (NaN in min and max, round) lives here too.
//
// V8's fdlibm is C++ built with fused multiply-add on arm64: within one expression a*b ± c is fused,
// the left product first. mad() marks each place; the plain and the fused result differ in the last bit.

@inline(__always) private func mad(_ a: Double, _ b: Double, _ c: Double) -> Double { c.addingProduct(a, b) }
@inline(__always) private func high(_ x: Double) -> Int32 { Int32(truncatingIfNeeded: x.bitPattern >> 32) }
@inline(__always) private func low(_ x: Double) -> UInt32 { UInt32(truncatingIfNeeded: x.bitPattern) }

private let S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04
private let S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10
private let C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05
private let C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11

@inline(__always) private func kernelSin(_ x: Double, _ y: Double, _ iy: Bool) -> Double {
  let ix = high(x) & 0x7fff_ffff
  if ix < 0x3e40_0000, x.magnitude < 1 { return x }
  let z = x * x
  let v = z * x
  let r = mad(z, mad(z, mad(z, mad(z, S6, S5), S4), S3), S2)
  if !iy { return mad(v, mad(z, r, S1), x) }
  return x - mad(-v, S1, mad(z, mad(0.5, y, -(v * r)), -y))
}

@inline(__always) private func kernelCos(_ x: Double, _ y: Double) -> Double {
  let ix = high(x) & 0x7fff_ffff
  if ix < 0x3e40_0000, x.magnitude < 1 { return 1 }
  let z = x * x
  let r = z * mad(z, mad(z, mad(z, mad(z, mad(z, C6, C5), C4), C3), C2), C1)
  if ix < 0x3fd3_3333 { return 1 - mad(0.5, z, -mad(z, r, -(x * y))) }
  let qx = ix > 0x3fe9_0000 ? 0.28125 : Double(bitPattern: UInt64(UInt32(ix - 0x0020_0000)) << 32)
  let hz = mad(0.5, z, -qx)
  let a = 1 - qx
  return a - (hz - mad(z, r, -(x * y)))
}

private let invpio2 = 6.36619772367581382433e-01
private let pio2_1 = 1.57079632673412561417e+00, pio2_1t = 6.07710050650619224932e-11
private let pio2_2 = 6.07710050630396597660e-11, pio2_2t = 2.02226624879595063154e-21
private let pio2_3 = 2.02226624871116645580e-21, pio2_3t = 8.47842766036889956997e-32

private let npio2hw: [Int32] = [
  0x3ff921fb, 0x400921fb, 0x4012d97c, 0x401921fb, 0x401f6a7a, 0x4022d97c, 0x4025fdbb, 0x402921fb,
  0x402c463a, 0x402f6a7a, 0x4031475c, 0x4032d97c, 0x40346b9c, 0x4035fdbb, 0x40378fdb, 0x403921fb,
  0x403ab41b, 0x403c463a, 0x403dd85a, 0x403f6a7a, 0x40407e4c, 0x4041475c, 0x4042106c, 0x4042d97c,
  0x4043a28c, 0x40446b9c, 0x404534ac, 0x4045fdbb, 0x4046c6cb, 0x40478fdb, 0x404858eb, 0x404921fb,
]

/** x reduced to [-π/4, π/4] as y0 + y1, and the quadrant. The reader's angles stay under 2^19·π/2. */
@inline(__always) private func remPio2(_ x: Double) -> (n: Int, y0: Double, y1: Double) {
  let hx = high(x)
  let ix = hx & 0x7fff_ffff
  if ix < 0x4002_d97c {
    if hx > 0 {
      var z = x - pio2_1
      if ix != 0x3ff9_21fb {
        let y0 = z - pio2_1t
        return (1, y0, (z - y0) - pio2_1t)
      }
      z -= pio2_2
      let y0 = z - pio2_2t
      return (1, y0, (z - y0) - pio2_2t)
    }
    var z = x + pio2_1
    if ix != 0x3ff9_21fb {
      let y0 = z + pio2_1t
      return (-1, y0, (z - y0) + pio2_1t)
    }
    z += pio2_2
    let y0 = z + pio2_2t
    return (-1, y0, (z - y0) + pio2_2t)
  }
  var t = x.magnitude
  let n = Int(mad(t, invpio2, 0.5))
  let fn = Double(n)
  var r = mad(-fn, pio2_1, t)
  var w = fn * pio2_1t
  var y0 = r - w
  if !(n < 32 && ix != npio2hw[n - 1]) {
    let j = ix >> 20
    var i = j - ((high(y0) >> 20) & 0x7ff)
    if i > 16 {
      t = r
      w = fn * pio2_2
      r = t - w
      w = mad(fn, pio2_2t, -((t - r) - w))
      y0 = r - w
      i = j - ((high(y0) >> 20) & 0x7ff)
      if i > 49 {
        t = r
        w = fn * pio2_3
        r = t - w
        w = mad(fn, pio2_3t, -((t - r) - w))
        y0 = r - w
      }
    }
  }
  let y1 = (r - y0) - w
  return hx < 0 ? (-n, -y0, -y1) : (n, y0, y1)
}

@inline(__always) func jsSin(_ x: Double) -> Double {
  if high(x) & 0x7fff_ffff <= 0x3fe9_21fb { return kernelSin(x, 0, false) }
  let (n, y0, y1) = remPio2(x)
  switch n & 3 {
  case 0: return kernelSin(y0, y1, true)
  case 1: return kernelCos(y0, y1)
  case 2: return -kernelSin(y0, y1, true)
  default: return -kernelCos(y0, y1)
  }
}

@inline(__always) func jsCos(_ x: Double) -> Double {
  if high(x) & 0x7fff_ffff <= 0x3fe9_21fb { return kernelCos(x, 0) }
  let (n, y0, y1) = remPio2(x)
  switch n & 3 {
  case 0: return kernelCos(y0, y1)
  case 1: return -kernelSin(y0, y1, true)
  case 2: return -kernelCos(y0, y1)
  default: return kernelSin(y0, y1, true)
  }
}

private let atanhi = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00]
private let atanlo = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17]
private let aT = [
  3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01,
  9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02,
  4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02,
]

func jsAtan(_ v: Double) -> Double {
  var x = v
  let hx = high(x)
  let ix = hx & 0x7fff_ffff
  if ix >= 0x4410_0000 {
    if x.isNaN { return x }
    return hx > 0 ? atanhi[3] + atanlo[3] : -atanhi[3] - atanlo[3]
  }
  var id = -1
  if ix < 0x3fdc_0000 {
    if ix < 0x3e20_0000 { return x }
  } else {
    x = x.magnitude
    if ix < 0x3ff3_0000 {
      if ix < 0x3fe6_0000 {
        id = 0
        x = mad(2, x, -1) / (2 + x)
      } else {
        id = 1
        x = (x - 1) / (x + 1)
      }
    } else if ix < 0x4003_8000 {
      id = 2
      x = (x - 1.5) / mad(1.5, x, 1)
    } else {
      id = 3
      x = -1 / x
    }
  }
  let z = x * x
  let w = z * z
  let s1 = z * mad(w, mad(w, mad(w, mad(w, mad(w, aT[10], aT[8]), aT[6]), aT[4]), aT[2]), aT[0])
  let s2 = w * mad(w, mad(w, mad(w, mad(w, aT[9], aT[7]), aT[5]), aT[3]), aT[1])
  if id < 0 { return mad(-x, s1 + s2, x) }
  let r = atanhi[id] - (mad(x, s1 + s2, -atanlo[id]) - x)
  return hx < 0 ? -r : r
}

func jsAtan2(_ y: Double, _ x: Double) -> Double {
  let tiny = 1.0e-300, piO2 = 1.5707963267948965580e+00, pi = 3.1415926535897931160e+00, piLo = 1.2246467991473531772e-16
  if x.isNaN || y.isNaN { return x + y }
  let hx = high(x), hy = high(y)
  let ix = hx & 0x7fff_ffff, iy = hy & 0x7fff_ffff
  if x == 1 { return jsAtan(y) }
  var m = ((hy >> 31) & 1) | ((hx >> 30) & 2)
  if y == 0 {
    switch m {
    case 0, 1: return y
    case 2: return pi + tiny
    default: return -pi - tiny
    }
  }
  if x == 0 { return hy < 0 ? -piO2 - tiny : piO2 + tiny }
  if x.isInfinite {
    if y.isInfinite {
      switch m {
      case 0: return 0.78539816339744827900 + tiny
      case 1: return -0.78539816339744827900 - tiny
      case 2: return 3 * 0.78539816339744827900 + tiny
      default: return -3 * 0.78539816339744827900 - tiny
      }
    }
    switch m {
    case 0: return 0
    case 1: return -0.0
    case 2: return pi + tiny
    default: return -pi - tiny
    }
  }
  if y.isInfinite { return hy < 0 ? -piO2 - tiny : piO2 + tiny }
  let k = (iy - ix) >> 20
  var z: Double
  if k > 60 {
    z = piO2 + 0.5 * piLo
    m &= 1
  } else if hx < 0, k < -60 {
    z = 0
  } else {
    z = jsAtan((y / x).magnitude)
  }
  switch m {
  case 0: return z
  case 1: return -z
  case 2: return pi - (z - piLo)
  default: return (z - piLo) - pi
  }
}

/** Math.hypot of two numbers: both scaled by the larger, then a compensated sum. */
@inline(__always) func jsHypot(_ a: Double, _ b: Double) -> Double {
  let x = a.magnitude, y = b.magnitude
  if x.isInfinite || y.isInfinite { return .infinity }
  if x.isNaN || y.isNaN { return .nan }
  let top = x > y ? x : y
  if top == 0 { return 0 }
  var sum = 0.0, compensation = 0.0
  let n = x / top
  var summand = n * n - compensation
  var preliminary = sum + summand
  compensation = (preliminary - sum) - summand
  sum = preliminary
  let m = y / top
  summand = m * m - compensation
  preliminary = sum + summand
  sum = preliminary
  return sum.squareRoot() * top
}

/** Math.round: .5 goes toward +∞. */
@inline(__always) func jsRound(_ x: Double) -> Double {
  let down = x.rounded(.down)
  return x - down >= 0.5 ? down + 1 : down
}

/** Math.min and Math.max: NaN wins, unlike Swift's. */
@inline(__always) func jsMin(_ a: Double, _ b: Double) -> Double { a != a ? a : (b != b ? b : (b < a ? b : a)) }
@inline(__always) func jsMax(_ a: Double, _ b: Double) -> Double { a != a ? a : (b != b ? b : (b > a ? b : a)) }
