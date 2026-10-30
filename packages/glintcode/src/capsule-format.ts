import { CODEWORD_BITS, decodeBits, encodeBits, type Payload } from "./codeword";

export { DATA_BYTES, payloadFromNumber, payloadToNumber, type Payload } from "./codeword";

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
export const DISC_R = 0.62;
export const GLYPH_R = 0.42;
export const MARK = 0.2;
export const ROWS = [-0.54, -0.18, 0.18, 0.54] as const;
export const COLS = 24;
export const PITCH = 0.3;
export const START_X = 1.05;
export const FIRST_X = START_X + 0.47;
export const END_X = FIRST_X + (COLS - 1) * PITCH + 0.47;
/** Half the length of a bar's centre line; its round ends reach MARK / 2 further. */
export const BAR_HALF = 0.54;
/** Where the right cap's centre sits when there is no label. */
export const RIGHT_CAP = END_X - 0.35;

export const colX = (i: number) => FIRST_X + i * PITCH;

/** Whitening seed of the Capsule format (see codeword.ts). */
const SEED = 0x5ca9c0de;

/** Byte b fills columns 2b and 2b+1, top to bottom: a smudge across a few columns costs only a byte or two. */
const cellOf = (bit: number) => ({ col: (bit >> 3) * 2 + ((bit & 7) >> 2), row: bit & 3 });

/** The grid of set cells: cells[row][col]. */
export function encodeCells(payload: Payload | number | bigint): boolean[][] {
  const cells = ROWS.map(() => new Array<boolean>(COLS).fill(false));
  encodeBits(payload, SEED).forEach((on, bit) => {
    const { col, row } = cellOf(bit);
    cells[row][col] = on;
  });
  return cells;
}

/** Read cells back into a payload; `confidence[row][col]` (0..1) guides erasure decoding. */
export function decodeCells(cells: boolean[][], confidence?: number[][]): { payload: Payload; corrected: number } | null {
  const bits: boolean[] = [];
  const conf: number[] = [];
  for (let bit = 0; bit < CODEWORD_BITS; bit++) {
    const { col, row } = cellOf(bit);
    bits.push(cells[row][col]);
    conf.push(confidence ? confidence[row][col] : 1);
  }
  return decodeBits(bits, SEED, confidence ? conf : undefined);
}
