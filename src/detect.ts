import {
  BAR_HALF,
  colX,
  COLS,
  decodeCells,
  DISC_R,
  END_X,
  MARK,
  payloadToNumber,
  RIGHT_CAP,
  ROWS,
  START_X,
  type Payload,
} from "./format";

/*
 * Reading a Capsule, in one pass over the frame:
 *
 * 1. Luminance, downscaled so the long side is at most `maxDimension`.
 * 2. Adaptive threshold (integral image) for "mark" pixels: lighter than their surroundings.
 *    The second polarity runs the same steps on the inverted image (dark marks on a light
 *    capsule, or bare marks on paper).
 * 3. Connected components as runs, with moments.
 * 4. Every round component is a candidate disc: its ellipse gives centre, scale and tilt up to a rotation.
 * 5. The rotation comes from matching a template of features every code has (start bar, gaps).
 * 6. The start and end bars are measured as components; their ends plus the disc fix a homography,
 *    which corrects perspective along the whole capsule.
 * 7. 96 cells are sampled with local thresholds and decoded with Reed–Solomon.
 */

export interface ImageInput {
  /** RGBA (4 bytes per pixel, as from canvas getImageData) or luminance (1 byte per pixel). */
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

export interface DetectOptions {
  /** "both" (default), "normal" (light marks on a dark capsule) or "inverted" (dark marks on light). */
  polarity?: "both" | "normal" | "inverted";
  /** Long side the frame is downscaled to before reading. Default 1280. */
  maxDimension?: number;
  /** Stop after this many codes. Default 4. */
  maxResults?: number;
}

export type Point = [number, number];

export interface Detection {
  payload: Payload;
  /** The payload as a number (0..2^48-1). */
  value: number;
  /** Corners of the code area (label excluded) in image pixels: top-left, top-right, bottom-right, bottom-left. */
  corners: [Point, Point, Point, Point];
  /** Centre of the disc in image pixels. */
  center: Point;
  /** Approximate pill height in image pixels. */
  size: number;
  inverted: boolean;
  /** Bytes fixed by error correction (0 = clean read). */
  corrected: number;
}

const BAR_VAR = (() => {
  // Variance along a bar of a filled stadium (centre line ±BAR_HALF, radius MARK/2), for matching measured bars.
  let sum = 0;
  let sum2 = 0;
  let count = 0;
  const r = MARK / 2;
  for (let y = -BAR_HALF - r; y <= BAR_HALF + r; y += 0.002) {
    const dy = Math.max(0, Math.abs(y) - BAR_HALF);
    const w = dy >= r ? 0 : 2 * Math.sqrt(r * r - dy * dy);
    sum += w * y;
    sum2 += w * y * y;
    count += w;
  }
  return sum2 / count - (sum / count) ** 2;
})();
const BAR_END = Math.sqrt(3 * BAR_VAR);

type Template = { x: number; y: number; light: boolean; w: number }[];

// Features every code shares, near the disc (rotation search) and along the whole code (validation).
const NEAR: Template = [];
const FAR: Template = [];
{
  for (const y of [-0.5, -0.25, 0, 0.25, 0.5]) NEAR.push({ x: START_X, y, light: true, w: 2 });
  for (const y of [-0.45, 0, 0.45]) NEAR.push({ x: 0.82, y, light: false, w: 1 });
  for (const y of ROWS) NEAR.push({ x: START_X + 0.25, y, light: false, w: 1 });
  for (const x of [1.6, 2.2, 2.8]) for (const y of [-0.84, -0.36, 0, 0.36, 0.84]) NEAR.push({ x, y, light: false, w: 1 });
  for (let x = 1.6; x < END_X - 0.3; x += 0.6) for (const y of [-0.36, 0, 0.36]) FAR.push({ x, y, light: false, w: 1 });
  for (const y of [-0.4, 0, 0.4]) FAR.push({ x: END_X, y, light: true, w: 2 });
}
const NEAR_MAX = NEAR.reduce((s, t) => s + t.w, 0);
const FAR_MAX = FAR.reduce((s, t) => s + t.w, 0);

/** Reusable per-size buffers, so a camera loop doesn't allocate every frame. */
class Buffers {
  w = 0;
  h = 0;
  luma = new Uint8Array(0);
  inv = new Uint8Array(0);
  integral = new Uint32Array(0);
  mask = new Uint8Array(0);
  maskInv = new Uint8Array(0);
  blockHi = new Float32Array(0);
  blockLo = new Float32Array(0);
  ensure(w: number, h: number) {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.luma = new Uint8Array(w * h);
    this.inv = new Uint8Array(w * h);
    this.integral = new Uint32Array((w + 1) * (h + 1));
    this.mask = new Uint8Array(w * h);
    this.maskInv = new Uint8Array(w * h);
  }
}
const buffers = new Buffers();

function toLuma(img: ImageInput, maxDimension: number) {
  const { width, height, data } = img;
  const rgba = data.length >= width * height * 4;
  const k = Math.max(1, Math.ceil(Math.max(width, height) / maxDimension));
  const w = Math.floor(width / k);
  const h = Math.floor(height / k);
  buffers.ensure(w, h);
  const out = buffers.luma;
  const area = k * k;
  if (k === 1) {
    if (rgba) for (let i = 0, j = 0; i < w * h; i++, j += 4) out[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
    else out.set(data.subarray(0, w * h));
    return { w, h, k, luma: out };
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < k; dy++) {
        let i = (y * k + dy) * width + x * k;
        for (let dx = 0; dx < k; dx++, i++) {
          if (rgba) {
            const j = i * 4;
            s += (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
          } else s += data[i];
        }
      }
      out[y * w + x] = (s / area) | 0;
    }
  }
  return { w, h, k, luma: out };
}

/**
 * Pixels clearly lighter than the mean of their neighbourhood (`mask`), and clearly darker (`maskInv`,
 * the same test on the inverted image). The neighbourhood mean is computed once per 4×4 block; the
 * margin grows with brightness (mean + 7 + mean/14). Pixels are judged unsmoothed: smoothing would
 * cut camera noise but also erase the marks of codes under ~30 px tall.
 */
function threshold(lum: Uint8Array, w: number, h: number, light: boolean, dark: boolean) {
  const I = buffers.integral;
  const W1 = w + 1;
  for (let y = 0; y < h; y++) {
    let row = 0;
    const o = (y + 1) * W1;
    const p = y * W1;
    const l = y * w;
    for (let x = 0; x < w; x++) {
      row += lum[l + x];
      I[o + x + 1] = I[p + x + 1] + row;
    }
  }
  const r = Math.max(4, Math.round(Math.min(w, h) / 28));
  const bw = (w + 3) >> 2;
  const bh = (h + 3) >> 2;
  if (buffers.blockHi.length < bw * bh) {
    buffers.blockHi = new Float32Array(bw * bh);
    buffers.blockLo = new Float32Array(bw * bh);
  }
  const hi = buffers.blockHi;
  const lo = buffers.blockLo;
  for (let by = 0; by < bh; by++) {
    const cy = Math.min(h - 1, by * 4 + 2);
    const y0 = Math.max(0, cy - r), y1 = Math.min(h, cy + r + 1);
    for (let bx = 0; bx < bw; bx++) {
      const cx = Math.min(w - 1, bx * 4 + 2);
      const x0 = Math.max(0, cx - r), x1 = Math.min(w, cx + r + 1);
      const area = (x1 - x0) * (y1 - y0);
      const mean = (I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0]) / area;
      hi[by * bw + bx] = mean + 7 + mean / 14;
      const inv = 255 - mean;
      lo[by * bw + bx] = 255 - (inv + 7 + inv / 14);
    }
  }
  const mask = buffers.mask;
  const maskInv = buffers.maskInv;
  for (let y = 0; y < h; y++) {
    const l = y * w;
    const brow = (y >> 2) * bw;
    for (let x = 0; x < w; x++) {
      const v = lum[l + x];
      const b = brow + (x >> 2);
      mask[l + x] = light && v > hi[b] ? 1 : 0;
      maskInv[l + x] = dark && v < lo[b] ? 1 : 0;
    }
  }
}

interface Components {
  count: number;
  // per run
  runY: Int32Array;
  runX0: Int32Array;
  runX1: Int32Array;
  runComp: Int32Array;
  rowStart: Int32Array;
  // per component
  n: Float64Array;
  sx: Float64Array;
  sy: Float64Array;
  sxx: Float64Array;
  syy: Float64Array;
  sxy: Float64Array;
  minX: Int32Array;
  maxX: Int32Array;
  minY: Int32Array;
  maxY: Int32Array;
  compRunStart: Int32Array;
  compRuns: Int32Array;
}

function components(mask: Uint8Array, w: number, h: number): Components {
  let cap = 1 << 14;
  let runY = new Int32Array(cap);
  let runX0 = new Int32Array(cap);
  let runX1 = new Int32Array(cap);
  let parent = new Int32Array(cap);
  const rowStart = new Int32Array(h + 1);
  let nr = 0;
  const find = (a: number) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  let prevStart = 0;
  let prevEnd = 0;
  for (let y = 0; y < h; y++) {
    rowStart[y] = nr;
    const base = y * w;
    let p = prevStart;
    for (let x = 0; x < w; ) {
      if (!mask[base + x]) {
        x++;
        continue;
      }
      const a = x;
      while (x < w && mask[base + x]) x++;
      const b = x - 1;
      if (nr === cap) {
        cap *= 2;
        const grow = (arr: Int32Array) => {
          const next = new Int32Array(cap);
          next.set(arr);
          return next;
        };
        runY = grow(runY);
        runX0 = grow(runX0);
        runX1 = grow(runX1);
        parent = grow(parent);
      }
      const id = nr++;
      runY[id] = y;
      runX0[id] = a;
      runX1[id] = b;
      parent[id] = id;
      while (p < prevEnd && runX1[p] < a - 1) p++;
      for (let q = p; q < prevEnd && runX0[q] <= b + 1; q++) {
        const ra = find(id);
        const rb = find(q);
        if (ra !== rb) parent[ra < rb ? rb : ra] = ra < rb ? ra : rb;
      }
    }
    prevStart = rowStart[y];
    prevEnd = nr;
  }
  rowStart[h] = nr;

  const compOf = new Int32Array(nr).fill(-1);
  const runComp = new Int32Array(nr);
  let count = 0;
  for (let i = 0; i < nr; i++) {
    const r = find(i);
    if (compOf[r] < 0) compOf[r] = count++;
    runComp[i] = compOf[r];
  }
  const n = new Float64Array(count);
  const sx = new Float64Array(count);
  const sy = new Float64Array(count);
  const sxx = new Float64Array(count);
  const syy = new Float64Array(count);
  const sxy = new Float64Array(count);
  const minX = new Int32Array(count).fill(1 << 30);
  const maxX = new Int32Array(count).fill(-1);
  const minY = new Int32Array(count).fill(1 << 30);
  const maxY = new Int32Array(count).fill(-1);
  const sq = (v: number) => (v * (v + 1) * (2 * v + 1)) / 6;
  const compRunStart = new Int32Array(count + 1);
  for (let i = 0; i < nr; i++) {
    const c = runComp[i];
    const a = runX0[i];
    const b = runX1[i];
    const y = runY[i];
    const len = b - a + 1;
    const s1 = ((a + b) * len) / 2;
    n[c] += len;
    sx[c] += s1;
    sy[c] += y * len;
    sxx[c] += sq(b) - sq(a - 1);
    syy[c] += y * y * len;
    sxy[c] += y * s1;
    if (a < minX[c]) minX[c] = a;
    if (b > maxX[c]) maxX[c] = b;
    if (y < minY[c]) minY[c] = y;
    if (y > maxY[c]) maxY[c] = y;
    compRunStart[c + 1]++;
  }
  for (let c = 0; c < count; c++) compRunStart[c + 1] += compRunStart[c];
  const fill = compRunStart.slice(0, count);
  const compRuns = new Int32Array(nr);
  for (let i = 0; i < nr; i++) compRuns[fill[runComp[i]]++] = i;
  return { count, runY, runX0, runX1, runComp, rowStart, n, sx, sy, sxx, syy, sxy, minX, maxX, minY, maxY, compRunStart, compRuns };
}

/** Component containing pixel (x, y), or -1. */
function compAt(cc: Components, x: number, y: number) {
  const yi = Math.floor(y);
  const xi = Math.floor(x);
  if (yi < 0 || yi >= cc.rowStart.length - 1) return -1;
  let lo = cc.rowStart[yi];
  let hi = cc.rowStart[yi + 1] - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (cc.runX1[m] < xi) lo = m + 1;
    else if (cc.runX0[m] > xi) hi = m - 1;
    else return cc.runComp[m];
  }
  return -1;
}

interface Ellipse {
  cx: number;
  cy: number;
  a: number;
  b: number;
  phi: number;
}

/** Ellipse of a component with its holes filled (each row from its leftmost to rightmost pixel). */
function filledEllipse(cc: Components, c: number): Ellipse | null {
  let A = 0, Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0;
  let row = -1, lo = 0, hi = 0;
  const flush = () => {
    if (row < 0) return;
    const len = hi - lo + 1;
    const s1 = ((lo + hi) * len) / 2;
    const sq = (v: number) => (v * (v + 1) * (2 * v + 1)) / 6;
    A += len;
    Sx += s1;
    Sy += row * len;
    Sxx += sq(hi) - sq(lo - 1);
    Syy += row * row * len;
    Sxy += row * s1;
  };
  for (let k = cc.compRunStart[c]; k < cc.compRunStart[c + 1]; k++) {
    const r = cc.compRuns[k];
    const y = cc.runY[r];
    if (y !== row) {
      flush();
      row = y;
      lo = cc.runX0[r];
      hi = cc.runX1[r];
    } else {
      if (cc.runX0[r] < lo) lo = cc.runX0[r];
      if (cc.runX1[r] > hi) hi = cc.runX1[r];
    }
  }
  flush();
  const mx = Sx / A;
  const my = Sy / A;
  // + 1/12: each pixel is a unit square, not a point.
  const vxx = Sxx / A - mx * mx + 1 / 12;
  const vyy = Syy / A - my * my + 1 / 12;
  const vxy = Sxy / A - mx * my;
  const tr = (vxx + vyy) / 2;
  const d = Math.sqrt(((vxx - vyy) / 2) ** 2 + vxy * vxy);
  const l1 = tr + d;
  const l2 = tr - d;
  if (l2 <= 0) return null;
  const a = 2 * Math.sqrt(l1);
  const b = 2 * Math.sqrt(l2);
  const ratio = A / (Math.PI * a * b);
  if (ratio < 0.86 || ratio > 1.14 || b / a < 0.22) return null;
  return { cx: mx + 0.5, cy: my + 0.5, a, b, phi: 0.5 * Math.atan2(2 * vxy, vxx - vyy) };
}

/** Bilinear sample at continuous image coordinates (pixel i covers [i, i+1)). */
function sampler(lum: Uint8Array, w: number, h: number) {
  return (x: number, y: number) => {
    const fx = Math.min(Math.max(x - 0.5, 0), w - 1.001);
    const fy = Math.min(Math.max(y - 0.5, 0), h - 1.001);
    const x0 = fx | 0;
    const y0 = fy | 0;
    const ax = fx - x0;
    const ay = fy - y0;
    const i = y0 * w + x0;
    const top = lum[i] + (lum[i + 1] - lum[i]) * ax;
    const bot = lum[i + w] + (lum[i + w + 1] - lum[i + w]) * ax;
    return top + (bot - top) * ay;
  };
}

type Map2 = (x: number, y: number) => Point;

/** Code units → image, as an affine map from the disc ellipse and a rotation psi. */
function affineMap(e: Ellipse, psi: number): Map2 {
  const s = 1 / DISC_R;
  const cp = Math.cos(e.phi), sp = Math.sin(e.phi);
  const cr = Math.cos(psi), sr = Math.sin(psi);
  // The unit circle maps onto the ellipse through R(phi) · diag(a, b) · R(psi).
  const m00 = (cp * e.a * cr - sp * e.b * sr) * s;
  const m01 = (-cp * e.a * sr - sp * e.b * cr) * s;
  const m10 = (sp * e.a * cr + cp * e.b * sr) * s;
  const m11 = (-sp * e.a * sr + cp * e.b * cr) * s;
  return (x, y) => [e.cx + m00 * x + m01 * y, e.cy + m10 * x + m11 * y];
}

/** Least-squares homography (h33 = 1) from code points to image points. */
function homography(src: Point[], dst: Point[], origin: Point, scale: number): Map2 | null {
  const N = new Float64Array(64);
  const r = new Float64Array(8);
  for (let i = 0; i < src.length; i++) {
    const [x, y] = src[i];
    const u = (dst[i][0] - origin[0]) / scale;
    const v = (dst[i][1] - origin[1]) / scale;
    const rows: [number[], number][] = [
      [[x, y, 1, 0, 0, 0, -u * x, -u * y], u],
      [[0, 0, 0, x, y, 1, -v * x, -v * y], v],
    ];
    for (const [a, b] of rows) {
      for (let j = 0; j < 8; j++) {
        r[j] += a[j] * b;
        for (let k = 0; k < 8; k++) N[j * 8 + k] += a[j] * a[k];
      }
    }
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < 8; c++) {
    let best = c;
    for (let k = c + 1; k < 8; k++) if (Math.abs(N[k * 8 + c]) > Math.abs(N[best * 8 + c])) best = k;
    if (Math.abs(N[best * 8 + c]) < 1e-12) return null;
    if (best !== c) {
      for (let k = 0; k < 8; k++) [N[c * 8 + k], N[best * 8 + k]] = [N[best * 8 + k], N[c * 8 + k]];
      [r[c], r[best]] = [r[best], r[c]];
    }
    for (let k = 0; k < 8; k++) {
      if (k === c) continue;
      const f = N[k * 8 + c] / N[c * 8 + c];
      if (!f) continue;
      for (let j = c; j < 8; j++) N[k * 8 + j] -= f * N[c * 8 + j];
      r[k] -= f * r[c];
    }
  }
  const h = Array.from({ length: 8 }, (_, i) => r[i] / N[i * 8 + i]);
  return (x, y) => {
    const d = h[6] * x + h[7] * y + 1;
    return [origin[0] + (scale * (h[0] * x + h[1] * y + h[2])) / d, origin[1] + (scale * (h[3] * x + h[4] * y + h[5])) / d];
  };
}

interface Bar {
  c: Point;
  /** Unit vector along the bar. */
  v: Point;
  half: number;
  n: number;
}

function barOf(cc: Components, c: number): Bar | null {
  const n = cc.n[c];
  if (n < 4) return null;
  const mx = cc.sx[c] / n, my = cc.sy[c] / n;
  const vxx = cc.sxx[c] / n - mx * mx + 1 / 12;
  const vyy = cc.syy[c] / n - my * my + 1 / 12;
  const vxy = cc.sxy[c] / n - mx * my;
  const tr = (vxx + vyy) / 2;
  const d = Math.sqrt(((vxx - vyy) / 2) ** 2 + vxy * vxy);
  const l1 = tr + d, l2 = tr - d;
  if (l1 < 4 * Math.max(l2, 0.05)) return null;
  const t = 0.5 * Math.atan2(2 * vxy, vxx - vyy);
  return { c: [mx + 0.5, my + 0.5], v: [Math.cos(t), Math.sin(t)], half: Math.sqrt(3 * l1), n };
}

interface Polarity {
  lum: Uint8Array;
  cc: Components;
  sample: (x: number, y: number) => number;
}

function tryCandidate(P: Polarity, e: Ellipse): { map: Map2; detection: Omit<Detection, "inverted" | "corners" | "center" | "size"> } | null {
  const { sample, cc } = P;
  // Contrast between the disc's clear ring and the capsule around it.
  const base = affineMap(e, 0);
  let light = 0, dark = 0, lightOk = 0, darkOk = 0;
  const lights: number[] = [], darks: number[] = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    lights.push(sample(...base(0.52 * Math.cos(a), 0.52 * Math.sin(a))));
    darks.push(sample(...base(0.8 * Math.cos(a), 0.8 * Math.sin(a))));
  }
  lights.sort((p, q) => p - q);
  darks.sort((p, q) => p - q);
  light = lights[6];
  dark = darks[6];
  if (light - dark < 18) return null;
  const t = (light + dark) / 2;
  for (const v of lights) if (v > t) lightOk++;
  for (const v of darks) if (v < t) darkOk++;
  if (lightOk < 10 || darkOk < 8) return null;

  // Rotation: the start bar is a component just outside the disc. Look for bar-shaped components on
  // a ring there; each one gives a rotation, refined against the near template.
  const score = (psi: number, tpl: Template) => {
    const m = affineMap(e, psi);
    let s = 0;
    for (const p of tpl) if (sample(...m(p.x, p.y)) > t === p.light) s += p.w;
    return s;
  };
  const cp = Math.cos(e.phi), sp = Math.sin(e.phi);
  const toCode = (x: number, y: number): Point => {
    // Inverse of R(phi)·diag(a,b) scaled to DISC_R (rotation psi = 0).
    const dx = x - e.cx, dy = y - e.cy;
    const u = (cp * dx + sp * dy) / e.a, v = (-sp * dx + cp * dy) / e.b;
    return [u * DISC_R, v * DISC_R];
  };
  const unit = (e.a + e.b) / 2 / DISC_R;
  const seen = new Set<number>();
  const guesses: number[] = [];
  for (let k = 0; k < 40; k++) {
    const ang = (k / 40) * Math.PI * 2;
    for (const r of [START_X - 0.06, START_X + 0.06]) {
      const c = compAt(cc, ...base(r * Math.cos(ang), r * Math.sin(ang)));
      if (c < 0 || seen.has(c)) continue;
      seen.add(c);
      const bar = barOf(cc, c);
      if (!bar || bar.half < BAR_END * unit * 0.35 || bar.half > BAR_END * unit * 2.2) continue;
      const [qx, qy] = toCode(...bar.c);
      const dist = Math.hypot(qx, qy);
      if (dist < START_X * 0.75 || dist > START_X * 1.3) continue;
      guesses.push(Math.atan2(qy, qx));
    }
  }
  let best: { psi: number; s: number } | null = null;
  const deg = Math.PI / 180;
  for (const psi0 of guesses) {
    let local = { psi: psi0, s: score(psi0, NEAR) };
    for (const [span, step] of [[6, 1.5], [1, 0.25]]) {
      const c = local.psi;
      for (let d = -span; d <= span; d += step) {
        const psi = c + d * deg;
        const s = score(psi, NEAR);
        if (s > local.s) local = { psi, s };
      }
    }
    if (!best || local.s > best.s) best = local;
  }
  if (!best || best.s < NEAR_MAX * 0.85) return null;
  const affine = affineMap(e, best.psi);

  // Bars. The start bar is a component right where the template says. The end bar may sit far from
  // the affine prediction under perspective, so walk the capsule's axis and take the first bar-like
  // component past the data (label letters come after it, data dashes lie across it).
  const axisAt = (x: number) => {
    const [ax, ay] = affine(x, -1);
    const [bx, by] = affine(x, 1);
    return [bx - ax, by - ay] as Point;
  };
  const parallel = (bar: Bar, axis: Point) => Math.abs(bar.v[0] * axis[0] + bar.v[1] * axis[1]) / Math.hypot(...axis);
  let start: Bar | null = null;
  {
    const axis = axisAt(START_X);
    const predicted = (BAR_END * Math.hypot(...axis)) / 2;
    let bestD = Infinity;
    for (const dx of [0, -0.06, 0.06]) {
      for (const dy of [0, -0.2, 0.2]) {
        const c = compAt(cc, ...affine(START_X + dx, dy));
        const bar = c < 0 ? null : barOf(cc, c);
        if (!bar || parallel(bar, axis) < 0.85 || bar.half < predicted * 0.55 || bar.half > predicted * 1.45) continue;
        const [px, py] = affine(START_X, 0);
        const d = Math.hypot(bar.c[0] - px, bar.c[1] - py);
        if (d < bestD) {
          bestD = d;
          start = bar;
        }
      }
    }
  }
  // Bar-like components past the data, nearest first; decoding decides which one is the real end bar.
  const ends: { bar: Bar; along: number }[] = [];
  if (start) {
    const [ox, oy] = start.c;
    const [fx, fy] = affine(END_X, 0);
    const dir: Point = [fx - ox, fy - oy];
    const len = Math.hypot(...dir);
    const ux = dir[0] / len, uy = dir[1] / len;
    const seen = new Set<number>();
    const step = Math.max(0.5, len / (END_X - START_X) * 0.07);
    for (let t = len * 0.45; t < len * 3; t += step) {
      for (const off of [0, -0.3, 0.3]) {
        const spread = start.half * 1.4 + t * 0.05;
        const qx = ox + ux * t - uy * off * spread;
        const qy = oy + uy * t + ux * off * spread;
        const c = compAt(cc, qx, qy);
        if (c < 0 || seen.has(c)) continue;
        seen.add(c);
        const bar = barOf(cc, c);
        if (!bar) continue;
        if (Math.abs(bar.v[0] * start.v[0] + bar.v[1] * start.v[1]) < 0.75) continue;
        if (bar.half < start.half * 0.35 || bar.half > start.half * 2.8) continue;
        const along = (bar.c[0] - ox) * ux + (bar.c[1] - oy) * uy;
        const across = Math.abs(-(bar.c[0] - ox) * uy + (bar.c[1] - oy) * ux);
        if (across > start.half * 0.8 + along * 0.08 || along < len * 0.45) continue;
        ends.push({ bar, along });
      }
      if (ends.length >= 3) break;
    }
    ends.sort((a, b) => a.along - b.along);
  }

  const maps: Map2[] = [];
  for (const { bar: end } of start ? ends : []) {
    const orient = (bar: Bar, x: number): [Point, Point] => {
      const [ax, ay] = affine(x, -1);
      const [bx, by] = affine(x, 1);
      const sgn = bar.v[0] * (bx - ax) + bar.v[1] * (by - ay) > 0 ? 1 : -1;
      const top: Point = [bar.c[0] - sgn * bar.v[0] * bar.half, bar.c[1] - sgn * bar.v[1] * bar.half];
      const bottom: Point = [bar.c[0] + sgn * bar.v[0] * bar.half, bar.c[1] + sgn * bar.v[1] * bar.half];
      return [top, bottom];
    };
    const [st, sb] = orient(start!, START_X);
    const [et, eb] = orient(end, END_X);
    const src: Point[] = [
      [START_X, -BAR_END], [START_X, BAR_END], [START_X, 0],
      [END_X, -BAR_END], [END_X, BAR_END], [END_X, 0],
      [0, 0], [0, -DISC_R], [0, DISC_R], [-DISC_R, 0],
    ];
    const dst: Point[] = [st, sb, start!.c, et, eb, end.c, [e.cx, e.cy], affine(0, -DISC_R), affine(0, DISC_R), affine(-DISC_R, 0)];
    const H = homography(src, dst, [e.cx, e.cy], e.a);
    if (H) maps.push(H);
  }
  maps.push(affine);

  for (const map of maps) {
    // Validate along the whole code before reading it.
    let s = 0;
    for (const p of FAR) if (sample(...map(p.x, p.y)) > t === p.light) s += p.w;
    if (s < FAR_MAX * 0.8) continue;

    const barLight = (x: number) => {
      let v = 0;
      for (const y of [-0.4, -0.2, 0, 0.2, 0.4]) v += sample(...map(x, y));
      return v / 5;
    };
    const ls = barLight(START_X), le = barLight(END_X);
    // Raw cell values and the dark level between rows, per column.
    const values = ROWS.map(() => new Float64Array(COLS));
    const darkAt = new Float64Array(COLS);
    for (let i = 0; i < COLS; i++) {
      const x = colX(i);
      let d = 0;
      for (const y of [-0.36, 0, 0.36]) d += sample(...map(x, y));
      darkAt[i] = d / 3;
      ROWS.forEach((y, row) => {
        values[row][i] = (sample(...map(x - 0.06, y)) + sample(...map(x, y)) + sample(...map(x + 0.06, y))) / 3;
      });
    }
    // Each row may have its own colour: its "set" level is the brighter part of its own values,
    // relative to the bars (so lighting gradients along the code still cancel out).
    const cells: boolean[][] = ROWS.map(() => []);
    const conf: number[][] = ROWS.map(() => []);
    ROWS.forEach((_, row) => {
      const rel: number[] = [];
      for (let i = 0; i < COLS; i++) {
        const l = ls + ((le - ls) * (colX(i) - START_X)) / (END_X - START_X);
        rel.push((values[row][i] - darkAt[i]) / Math.max(8, l - darkAt[i]));
      }
      const sorted = rel.slice().sort((a, b) => b - a);
      // Mean of the brightest quarter, but never below half the bar contrast.
      const top = Math.max(0.5, (sorted[0] + sorted[1] + sorted[2] + sorted[3] + sorted[4] + sorted[5]) / 6);
      const thr = top / 2;
      for (let i = 0; i < COLS; i++) {
        cells[row][i] = rel[i] > thr;
        conf[row][i] = Math.min(1, Math.abs(rel[i] - thr) / thr);
      }
    });
    const out = decodeCells(cells, conf);
    if (out) return { map, detection: { payload: out.payload, value: payloadToNumber(out.payload), corrected: out.corrected } };
  }
  return null;
}

/** Find and read every Capsule code in an image. */
export function detect(image: ImageInput, options: DetectOptions = {}): Detection[] {
  const { w, h, k, luma } = toLuma(image, options.maxDimension ?? 1280);
  const maxResults = options.maxResults ?? 4;
  const polarity = options.polarity ?? "both";
  const results: Detection[] = [];
  const passes: boolean[] = polarity === "both" ? [false, true] : [polarity === "inverted"];

  threshold(luma, w, h, passes.includes(false), passes.includes(true));
  for (const inverted of passes) {
    let lum = luma;
    if (inverted) {
      lum = buffers.inv;
      for (let i = 0; i < w * h; i++) lum[i] = 255 - luma[i];
    }
    const cc = components(inverted ? buffers.maskInv : buffers.mask, w, h);
    const P: Polarity = { lum, cc, sample: sampler(lum, w, h) };

    const candidates: { e: Ellipse; area: number }[] = [];
    for (let c = 0; c < cc.count; c++) {
      if (cc.n[c] < 12) continue;
      const bw = cc.maxX[c] - cc.minX[c] + 1;
      const bh = cc.maxY[c] - cc.minY[c] + 1;
      if (bw < 5 || bh < 5 || bw > 5 * bh || bh > 5 * bw) continue;
      const e = filledEllipse(cc, c);
      if (e && e.a >= 3) candidates.push({ e, area: bw * bh });
    }
    candidates.sort((a, b) => b.area - a.area);

    for (const { e } of candidates.slice(0, 200)) {
      const scale = (e.a + e.b) / 2 / DISC_R;
      if (results.some((r) => Math.hypot(r.center[0] / k - e.cx, r.center[1] / k - e.cy) < scale * 0.8)) continue;
      const hit = tryCandidate(P, e);
      if (!hit) continue;
      const m = (x: number, y: number): Point => {
        const [px, py] = hit.map(x, y);
        return [px * k, py * k];
      };
      const right = RIGHT_CAP + 1;
      const top = m(0, -1), bottom = m(0, 1);
      results.push({
        ...hit.detection,
        corners: [m(-1, -1), m(right, -1), m(right, 1), m(-1, 1)],
        center: m(0, 0),
        size: Math.hypot(top[0] - bottom[0], top[1] - bottom[1]),
        inverted,
      });
      if (results.length >= maxResults) return results;
    }
    
  }
  return results;
}

