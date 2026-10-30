/*
 * Capsule geometry, in code units: the pill is 2 units tall and its left cap is a circle of
 * radius 1 centred on the origin. From left to right:
 *
 *   ( disc )  |  4 rows × 24 columns of marks  |  label …  )
 *
 * - disc: radius DISC_R, the finder. Its ring between GLYPH_R and DISC_R stays clear; a logo goes inside GLYPH_R.
 * - start and end bars: vertical marks the reader measures to undo perspective.
 * - marks: a set cell is a dot of diameter MARK; neighbouring set cells in a row join into a dash.
 * - label: free text after the end bar. The reader never looks there.
 */
let DISC_R = 0.62
let GLYPH_R = 0.42
let MARK = 0.2
let ROWS: [Double] = [-0.54, -0.18, 0.18, 0.54]
let COLS = 24
let PITCH = 0.3
let START_X = 1.05
let FIRST_X = START_X + 0.47
let END_X = FIRST_X + Double(COLS - 1) * PITCH + 0.47
/** Half the length of a bar's centre line; its round ends reach MARK / 2 further. */
let BAR_HALF = 0.54
/** Where the right cap's centre sits when there is no label. */
let RIGHT_CAP = END_X - 0.35

@inline(__always) func colX(_ i: Int) -> Double { FIRST_X + Double(i) * PITCH }

/** Whitening seed of the Capsule format (see codeword.swift). */
let CAPSULE_SEED: UInt32 = 0x5ca9c0de
private let CAPSULE_WHITENING = whitening(CAPSULE_SEED)

/** Byte b fills columns 2b and 2b+1, top to bottom: a smudge across a few columns costs only a byte or two. */
private func cellOf(_ bit: Int) -> (col: Int, row: Int) { ((bit >> 3) * 2 + ((bit & 7) >> 2), bit & 3) }

/** Read cells back into a payload; `confidence[row][col]` (0..1) guides erasure decoding. */
func decodeCells(_ cells: [[Bool]], _ confidence: [[Double]]? = nil) -> (payload: [UInt8], corrected: Int)? {
  var bits: [Bool] = []
  var conf: [Double] = []
  for bit in 0..<CODEWORD_BITS {
    let (col, row) = cellOf(bit)
    bits.append(cells[row][col])
    conf.append(confidence?[row][col] ?? 1)
  }
  return decodeBits(bits, CAPSULE_WHITENING, confidence != nil ? conf : nil)
}
