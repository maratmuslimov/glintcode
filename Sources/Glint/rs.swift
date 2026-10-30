// Reed–Solomon over GF(256) (primitive polynomial 0x11d, first consecutive root α^0),
// with errors-and-erasures decoding. Polynomials are arrays, highest degree first.

private let tables: (exp: [Int], log: [Int]) = {
  var exp = [Int](repeating: 0, count: 512)
  var log = [Int](repeating: 0, count: 256)
  var x = 1
  for i in 0..<255 {
    exp[i] = x
    log[x] = i
    x <<= 1
    if x & 0x100 != 0 { x ^= 0x11d }
  }
  for i in 255..<512 { exp[i] = exp[i - 255] }
  return (exp, log)
}()
private let EXP = tables.exp
private let LOG = tables.log

@inline(__always) private func mul(_ a: Int, _ b: Int) -> Int { a != 0 && b != 0 ? EXP[LOG[a] + LOG[b]] : 0 }
@inline(__always) private func div(_ a: Int, _ b: Int) -> Int { a != 0 ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0 }
@inline(__always) private func pow(_ a: Int, _ n: Int) -> Int { EXP[(((LOG[a] * n) % 255) + 255) % 255] }
@inline(__always) private func inv(_ a: Int) -> Int { EXP[255 - LOG[a]] }

private func polyScale(_ p: [Int], _ x: Int) -> [Int] { p.map { mul($0, x) } }

private func polyAdd(_ p: [Int], _ q: [Int]) -> [Int] {
  var r = [Int](repeating: 0, count: max(p.count, q.count))
  for i in 0..<p.count { r[i + r.count - p.count] = p[i] }
  for i in 0..<q.count { r[i + r.count - q.count] ^= q[i] }
  return r
}

private func polyMul(_ p: [Int], _ q: [Int]) -> [Int] {
  var r = [Int](repeating: 0, count: p.count + q.count - 1)
  for j in 0..<q.count { for i in 0..<p.count { r[i + j] ^= mul(p[i], q[j]) } }
  return r
}

/** An empty polynomial evaluates to -1 where the TS gets undefined: it equals nothing. */
private func polyEval(_ p: [Int], _ x: Int) -> Int {
  if p.isEmpty { return -1 }
  var y = p[0]
  for i in 1..<max(p.count, 1) { y = mul(y, x) ^ p[i] }
  return y
}

/** Remainder of dividend / divisor (divisor monic). */
private func polyMod(_ dividend: [Int], _ divisor: [Int]) -> [Int] {
  var out = dividend
  var i = 0
  while i < dividend.count - (divisor.count - 1) {
    let coef = out[i]
    if coef != 0 { for j in 1..<divisor.count where divisor[j] != 0 { out[i + j] ^= mul(divisor[j], coef) } }
    i += 1
  }
  return Array(out[(out.count - (divisor.count - 1))...])
}

private func generator(_ nsym: Int) -> [Int] {
  var g = [1]
  for i in 0..<nsym { g = polyMul(g, [1, pow(2, i)]) }
  return g
}

/** Data followed by nsym parity bytes. */
func rsEncode(_ data: [Int], _ nsym: Int) -> [Int] {
  let g = generator(nsym)
  var out = data + [Int](repeating: 0, count: nsym)
  for i in 0..<data.count {
    let coef = out[i]
    if coef != 0 { for j in 1..<g.count { out[i + j] ^= mul(g[j], coef) } }
  }
  return data + out[data.count...]
}

private func syndromes(_ msg: [Int], _ nsym: Int) -> [Int] {
  var s = [0]
  for i in 0..<nsym { s.append(polyEval(msg, pow(2, i))) }
  return s
}

private func forneySyndromes(_ synd: [Int], _ erasures: [Int], _ n: Int) -> [Int] {
  var f = Array(synd[1...])
  for p in erasures {
    let x = pow(2, n - 1 - p)
    for j in 0..<(f.count - 1) { f[j] = mul(f[j], x) ^ f[j + 1] }
  }
  return f
}

/** Berlekamp–Massey on the (Forney) syndromes; nil when there are more errors than it can locate. */
private func errorLocator(_ synd: [Int], _ nsym: Int, _ erasureCount: Int) -> [Int]? {
  var loc = [1]
  var old = [1]
  var i = 0
  while i < nsym - erasureCount {
    var delta = synd[i]
    var j = 1
    while j < loc.count {
      delta ^= mul(loc[loc.count - 1 - j], i - j >= 0 ? synd[i - j] : 0)
      j += 1
    }
    old.append(0)
    if delta != 0 {
      if old.count > loc.count {
        let next = polyScale(old, delta)
        old = polyScale(loc, inv(delta))
        loc = next
      }
      loc = polyAdd(loc, polyScale(old, delta))
    }
    i += 1
  }
  while let first = loc.first, first == 0 { loc.removeFirst() }
  let errors = loc.count - 1
  return errors * 2 + erasureCount > nsym ? nil : loc
}

private func findErrors(_ locReversed: [Int], _ n: Int) -> [Int]? {
  let errors = locReversed.count - 1
  var pos: [Int] = []
  for i in 0..<n where polyEval(locReversed, pow(2, i)) == 0 { pos.append(n - 1 - i) }
  return pos.count == errors ? pos : nil
}

private func correctErrata(_ msg: [Int], _ synd: [Int], _ positions: [Int]) -> [Int]? {
  let coefPos = positions.map { msg.count - 1 - $0 }
  var loc = [1]
  for i in coefPos { loc = polyMul(loc, polyAdd([1], [pow(2, i), 0])) }
  let evaluator = Array(polyMod(polyMul(synd.reversed(), loc), [1] + [Int](repeating: 0, count: loc.count)).reversed())
  let X = coefPos.map { pow(2, $0) }
  var out = msg
  for i in 0..<X.count {
    let xiInv = inv(X[i])
    var prime = 1
    for j in 0..<X.count where j != i { prime = mul(prime, 1 ^ mul(xiInv, X[j])) }
    if prime == 0 { return nil }
    let y = mul(X[i], polyEval(evaluator.reversed(), xiInv))
    out[positions[i]] ^= div(y, prime)
  }
  return out
}

/**
 * Correct a codeword in place of its errors and the given erasures (positions known to be unreliable).
 * Succeeds while 2·errors + erasures ≤ budget, so that a garbled read is rejected instead of
 * being "corrected" into another valid codeword.
 */
func rsDecode(_ codeword: [Int], _ nsym: Int, _ erasures: [Int] = [], budget: Int? = nil) -> (data: [Int], corrected: Int)? {
  let budget = budget ?? nsym
  if erasures.count > budget { return nil }
  var msg = codeword
  for p in erasures { msg[p] = 0 }
  let synd = syndromes(msg, nsym)
  var fixed = msg
  if synd.contains(where: { $0 != 0 }) {
    guard let loc = errorLocator(forneySyndromes(synd, erasures, msg.count), nsym, erasures.count) else { return nil }
    guard let errors = findErrors(loc.reversed(), msg.count), errors.count * 2 + erasures.count <= budget else { return nil }
    guard let out = correctErrata(msg, synd, erasures + errors), !syndromes(out, nsym).contains(where: { $0 != 0 }) else { return nil }
    fixed = out
  }
  var corrected = 0
  for i in 0..<fixed.count where fixed[i] != codeword[i] { corrected += 1 }
  return (Array(fixed[0..<(fixed.count - nsym)]), corrected)
}
