/*
 * Every format carries the same codeword: 6 payload bytes + 6 Reed–Solomon parity bytes, XORed with
 * a whitening sequence of its own. The sequence keeps the pattern lively for any payload and tells
 * formats (and future versions) apart: a code never decodes under another format's sequence.
 */
let DATA_BYTES = 6
let ECC_BYTES = 6
let CODEWORD_BYTES = DATA_BYTES + ECC_BYTES
let CODEWORD_BITS = CODEWORD_BYTES * 8

func whitening(_ seed: UInt32) -> [Int] {
  var out = [Int](repeating: 0, count: CODEWORD_BYTES)
  var s = seed == 0 ? 1 : seed
  for i in 0..<CODEWORD_BYTES {
    s ^= s << 13
    s ^= s >> 17
    s ^= s << 5
    out[i] = Int(s & 0xff)
  }
  return out
}

/** A number below 2^48 as the 6-byte payload (big-endian). */
func payloadFromNumber(_ value: UInt64) -> [Int] {
  precondition(value < 1 << 48, "Payloads hold numbers from 0 to 2^48 - 1")
  var v = value
  var out = [Int](repeating: 0, count: DATA_BYTES)
  for i in stride(from: DATA_BYTES - 1, through: 0, by: -1) {
    out[i] = Int(v & 0xff)
    v >>= 8
  }
  return out
}

func payloadToNumber(_ payload: [UInt8]) -> UInt64 {
  var v: UInt64 = 0
  for b in payload { v = v * 256 + UInt64(b) }
  return v
}

/** The whitened codeword as 96 bits, most significant bit of byte 0 first. */
func encodeBits(_ payload: UInt64, _ seed: UInt32) -> [Bool] {
  let cw = rsEncode(payloadFromNumber(payload), ECC_BYTES)
  let w = whitening(seed)
  var bits: [Bool] = []
  for i in 0..<CODEWORD_BYTES { for b in stride(from: 7, through: 0, by: -1) { bits.append(((cw[i] ^ w[i]) >> b) & 1 == 1) } }
  return bits
}

/**
 * Decode 96 read bits. `confidence` (0..1 per bit) picks which bytes to treat as erasures when plain
 * correction fails. Every attempt keeps one parity byte spare, so a misread is rejected rather than
 * corrected into a different payload.
 */
func decodeBits(_ bits: [Bool], _ w: [Int], _ confidence: [Double]? = nil) -> (payload: [UInt8], corrected: Int)? {
  var word = [Int](repeating: 0, count: CODEWORD_BYTES)
  var byteConfidence = [Double](repeating: 1, count: CODEWORD_BYTES)
  for i in 0..<CODEWORD_BYTES {
    var v = 0
    var c = 1.0
    for b in 0..<8 {
      v = (v << 1) | (bits[i * 8 + b] ? 1 : 0)
      if let confidence { c = jsMin(c, confidence[i * 8 + b]) }
    }
    word[i] = v ^ w[i]
    byteConfidence[i] = c
  }
  let budget = ECC_BYTES - 1
  var out = rsDecode(word, ECC_BYTES, [], budget: budget)
  if out == nil, confidence != nil {
    let order = stableSorted(Array(byteConfidence.enumerated())) { $0.element < $1.element }.map(\.offset)
    for erasures in [2, 4] {
      out = rsDecode(word, ECC_BYTES, Array(order[0..<erasures]), budget: budget)
      if out != nil { break }
    }
  }
  return out.map { ($0.data.map { UInt8($0) }, $0.corrected) }
}
