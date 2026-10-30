import { rsDecode, rsEncode } from "./rs";

/*
 * Every format carries the same codeword: 6 payload bytes + 6 Reed–Solomon parity bytes, XORed with
 * a whitening sequence of its own. The sequence keeps the pattern lively for any payload and tells
 * formats (and future versions) apart: a code never decodes under another format's sequence.
 */
export const DATA_BYTES = 6;
export const ECC_BYTES = 6;
export const CODEWORD_BYTES = DATA_BYTES + ECC_BYTES;
export const CODEWORD_BITS = CODEWORD_BYTES * 8;

export type Payload = Uint8Array;

const whitenings = new Map<number, Uint8Array>();
function whitening(seed: number) {
  let out = whitenings.get(seed);
  if (!out) {
    out = new Uint8Array(CODEWORD_BYTES);
    let s = seed >>> 0 || 1;
    for (let i = 0; i < CODEWORD_BYTES; i++) {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      out[i] = s & 0xff;
    }
    whitenings.set(seed, out);
  }
  return out;
}

/** A number below 2^48 as the 6-byte payload (big-endian). */
export function payloadFromNumber(value: number | bigint): Payload {
  let v = BigInt(value);
  if (v < 0n || v >= 1n << 48n) throw new RangeError("Payloads hold numbers from 0 to 2^48 - 1");
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
  if (input.length !== DATA_BYTES) throw new RangeError(`Payloads are ${DATA_BYTES} bytes`);
  return input;
}

/** The whitened codeword as 96 bits, most significant bit of byte 0 first. */
export function encodeBits(payload: Payload | number | bigint, seed: number): boolean[] {
  const cw = rsEncode(normalizePayload(payload), ECC_BYTES);
  const w = whitening(seed);
  const bits: boolean[] = [];
  for (let i = 0; i < CODEWORD_BYTES; i++) for (let b = 7; b >= 0; b--) bits.push((((cw[i] ^ w[i]) >> b) & 1) === 1);
  return bits;
}

/**
 * Decode 96 read bits. `confidence` (0..1 per bit) picks which bytes to treat as erasures when plain
 * correction fails. Every attempt keeps one parity byte spare, so a misread is rejected rather than
 * corrected into a different payload.
 */
export function decodeBits(bits: boolean[], seed: number, confidence?: number[]): { payload: Payload; corrected: number } | null {
  const w = whitening(seed);
  const word: number[] = [];
  const byteConfidence: number[] = [];
  for (let i = 0; i < CODEWORD_BYTES; i++) {
    let v = 0;
    let c = 1;
    for (let b = 0; b < 8; b++) {
      v = (v << 1) | (bits[i * 8 + b] ? 1 : 0);
      if (confidence) c = Math.min(c, confidence[i * 8 + b]);
    }
    word.push(v ^ w[i]);
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
