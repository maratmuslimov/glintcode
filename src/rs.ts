// Reed–Solomon over GF(256) (primitive polynomial 0x11d, first consecutive root α^0),
// with errors-and-erasures decoding. Polynomials are arrays, highest degree first.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const div = (a: number, b: number) => (a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0);
const pow = (a: number, n: number) => EXP[(((LOG[a] * n) % 255) + 255) % 255];
const inv = (a: number) => EXP[255 - LOG[a]];

const polyScale = (p: number[], x: number) => p.map((c) => mul(c, x));

function polyAdd(p: number[], q: number[]) {
  const r = new Array<number>(Math.max(p.length, q.length)).fill(0);
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
  return r;
}

function polyMul(p: number[], q: number[]) {
  const r = new Array<number>(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
  return r;
}

function polyEval(p: number[], x: number) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}

/** Remainder of dividend / divisor (divisor monic). */
function polyMod(dividend: number[], divisor: number[]) {
  const out = dividend.slice();
  for (let i = 0; i < dividend.length - (divisor.length - 1); i++) {
    const coef = out[i];
    if (coef) for (let j = 1; j < divisor.length; j++) if (divisor[j]) out[i + j] ^= mul(divisor[j], coef);
  }
  return out.slice(out.length - (divisor.length - 1));
}

const generators = new Map<number, number[]>();
function generator(nsym: number) {
  let g = generators.get(nsym);
  if (!g) {
    g = [1];
    for (let i = 0; i < nsym; i++) g = polyMul(g, [1, pow(2, i)]);
    generators.set(nsym, g);
  }
  return g;
}

/** Data followed by nsym parity bytes. */
export function rsEncode(data: ArrayLike<number>, nsym: number): number[] {
  const g = generator(nsym);
  const out = [...Array.from(data), ...new Array<number>(nsym).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef) for (let j = 1; j < g.length; j++) out[i + j] ^= mul(g[j], coef);
  }
  return [...Array.from(data), ...out.slice(data.length)];
}

function syndromes(msg: number[], nsym: number) {
  const s = [0];
  for (let i = 0; i < nsym; i++) s.push(polyEval(msg, pow(2, i)));
  return s;
}

function forneySyndromes(synd: number[], erasures: number[], n: number) {
  const f = synd.slice(1);
  for (const p of erasures) {
    const x = pow(2, n - 1 - p);
    for (let j = 0; j < f.length - 1; j++) f[j] = mul(f[j], x) ^ f[j + 1];
  }
  return f;
}

/** Berlekamp–Massey on the (Forney) syndromes; null when there are more errors than it can locate. */
function errorLocator(synd: number[], nsym: number, erasureCount: number) {
  let loc = [1];
  let old = [1];
  for (let i = 0; i < nsym - erasureCount; i++) {
    let delta = synd[i];
    for (let j = 1; j < loc.length; j++) delta ^= mul(loc[loc.length - 1 - j], synd[i - j]);
    old = [...old, 0];
    if (delta) {
      if (old.length > loc.length) {
        const next = polyScale(old, delta);
        old = polyScale(loc, inv(delta));
        loc = next;
      }
      loc = polyAdd(loc, polyScale(old, delta));
    }
  }
  while (loc.length && loc[0] === 0) loc.shift();
  const errors = loc.length - 1;
  return errors * 2 + erasureCount > nsym ? null : loc;
}

function findErrors(locReversed: number[], n: number) {
  const errors = locReversed.length - 1;
  const pos: number[] = [];
  for (let i = 0; i < n; i++) if (polyEval(locReversed, pow(2, i)) === 0) pos.push(n - 1 - i);
  return pos.length === errors ? pos : null;
}

function correctErrata(msg: number[], synd: number[], positions: number[]) {
  const coefPos = positions.map((p) => msg.length - 1 - p);
  let loc = [1];
  for (const i of coefPos) loc = polyMul(loc, polyAdd([1], [pow(2, i), 0]));
  const evaluator = polyMod(polyMul(synd.slice().reverse(), loc), [1, ...new Array<number>(loc.length).fill(0)]).reverse();
  const X = coefPos.map((p) => pow(2, p));
  const out = msg.slice();
  for (let i = 0; i < X.length; i++) {
    const xiInv = inv(X[i]);
    let prime = 1;
    for (let j = 0; j < X.length; j++) if (j !== i) prime = mul(prime, 1 ^ mul(xiInv, X[j]));
    if (prime === 0) return null;
    const y = mul(X[i], polyEval(evaluator.slice().reverse(), xiInv));
    out[positions[i]] ^= div(y, prime);
  }
  return out;
}

/**
 * Correct a codeword in place of its errors and the given erasures (positions known to be unreliable).
 * Succeeds while 2·errors + erasures ≤ nsym; `maxErrata` can demand spare parity so that
 * a garbled read is rejected instead of being "corrected" into another valid codeword.
 */
export function rsDecode(
  codeword: ArrayLike<number>,
  nsym: number,
  erasures: number[] = [],
  budget = nsym,
): { data: number[]; corrected: number } | null {
  if (erasures.length > budget) return null;
  const msg = Array.from(codeword);
  for (const p of erasures) msg[p] = 0;
  const synd = syndromes(msg, nsym);
  let fixed = msg;
  if (synd.some((s) => s !== 0)) {
    const loc = errorLocator(forneySyndromes(synd, erasures, msg.length), nsym, erasures.length);
    if (!loc) return null;
    const errors = findErrors(loc.slice().reverse(), msg.length);
    if (!errors || errors.length * 2 + erasures.length > budget) return null;
    const out = correctErrata(msg, synd, [...erasures, ...errors]);
    if (!out || syndromes(out, nsym).some((s) => s !== 0)) return null;
    fixed = out;
  }
  let corrected = 0;
  for (let i = 0; i < fixed.length; i++) if (fixed[i] !== codeword[i]) corrected++;
  return { data: fixed.slice(0, fixed.length - nsym), corrected };
}
