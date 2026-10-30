import { rsDecode, rsEncode } from "./rs";

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

export const DATA_BYTES = 6;
export const ECC_BYTES = 6;
const TOTAL_BYTES = DATA_BYTES + ECC_BYTES;

// Fixed whitening, so that a payload of zeros still draws a lively pattern. A future
// format version uses a different sequence: its codes then never decode as this one.
const WHITEN = (() => {
  const out = new Uint8Array(TOTAL_BYTES);
  let s = 0x5ca9c0de;
  for (let i = 0; i < TOTAL_BYTES; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
})();

/** Byte b fills columns 2b and 2b+1, top to bottom: a smudge across a few columns costs only a byte or two. */
const cellOf = (byte: number, bit: number) => ({ col: byte * 2 + (bit >> 2), row: bit & 3 });

export type Payload = Uint8Array;

/** A number below 2^48 as the 6-byte payload (big-endian). */
export function payloadFromNumber(value: number | bigint): Payload {
  let v = BigInt(value);
  if (v < 0n || v >= 1n << 48n) throw new RangeError("Capsule payloads hold numbers from 0 to 2^48 - 1");
  const out = new Uint8Array(DATA_BYTES);
  for (let i = DATA_BYTES - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function payloadToNumber(payload: Payload): number {
  let v = 0;
  for (const b of payload) v = v * 256 + b;
  return v;
}

export function normalizePayload(input: Payload | number | bigint): Payload {
  if (typeof input === "number" || typeof input === "bigint") return payloadFromNumber(input);
  if (input.length !== DATA_BYTES) throw new RangeError(`Capsule payloads are ${DATA_BYTES} bytes`);
  return input;
}

/** The grid of set cells: cells[row][col]. */
export function encodeCells(payload: Payload | number | bigint): boolean[][] {
  const codeword = rsEncode(normalizePayload(payload), ECC_BYTES);
  const cells = ROWS.map(() => new Array<boolean>(COLS).fill(false));
  for (let byte = 0; byte < TOTAL_BYTES; byte++) {
    const v = codeword[byte] ^ WHITEN[byte];
    for (let bit = 0; bit < 8; bit++) {
      const { col, row } = cellOf(byte, bit);
      cells[row][col] = ((v >> (7 - bit)) & 1) === 1;
    }
  }
  return cells;
}

/**
 * Read cells back into a payload. `confidence[row][col]` (0..1) picks which bytes to treat
 * as erasures when plain error correction fails. Every attempt keeps at least one parity
 * byte spare, so a misread is rejected instead of being corrected into a different payload.
 */
export function decodeCells(cells: boolean[][], confidence?: number[][]): { payload: Payload; corrected: number } | null {
  const word: number[] = [];
  const byteConfidence: number[] = [];
  for (let byte = 0; byte < TOTAL_BYTES; byte++) {
    let v = 0;
    let c = 1;
    for (let bit = 0; bit < 8; bit++) {
      const { col, row } = cellOf(byte, bit);
      v = (v << 1) | (cells[row][col] ? 1 : 0);
      if (confidence) c = Math.min(c, confidence[row][col]);
    }
    word.push(v ^ WHITEN[byte]);
    byteConfidence.push(c);
  }
  const budget = ECC_BYTES - 1;
  let out = rsDecode(word, ECC_BYTES, [], budget);
  if (!out && confidence) {
    const order = byteConfidence.map((c, i) => [c, i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
    for (const erasures of [2, 4]) {
      out = rsDecode(word, ECC_BYTES, order.slice(0, erasures), budget);
      if (out) break;
    }
  }
  return out ? { payload: Uint8Array.from(out.data), corrected: out.corrected } : null;
}
