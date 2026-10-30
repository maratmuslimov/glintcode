// Image analysis shared by every format: luminance, adaptive threshold, connected components,
// ellipse fitting and the geometry helpers the readers build on.

export interface ImageInput {
  /** RGBA (4 bytes per pixel, as from canvas getImageData) or luminance (1 byte per pixel). */
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

export type Point = [number, number];

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
export const buffers = new Buffers();

export function toLuma(img: ImageInput, maxDimension: number) {
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
export function threshold(lum: Uint8Array, w: number, h: number, light: boolean, dark: boolean) {
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

export interface Components {
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

export function components(mask: Uint8Array, w: number, h: number): Components {
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
export function compAt(cc: Components, x: number, y: number) {
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

export interface Ellipse {
  cx: number;
  cy: number;
  a: number;
  b: number;
  phi: number;
}

/** Ellipse of a component with its holes filled (each row from its leftmost to rightmost pixel). */
export function filledEllipse(cc: Components, c: number): Ellipse | null {
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
export function sampler(lum: Uint8Array, w: number, h: number) {
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

export type Map2 = (x: number, y: number) => Point;

/** Code units → image, as an affine map from a disc of radius discR (code units) seen as ellipse e, rotated by psi. */
export function affineMap(e: Ellipse, psi: number, discR: number): Map2 {
  const s = 1 / discR;
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
export function homography(src: Point[], dst: Point[], origin: Point, scale: number): Map2 | null {
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

export interface Bar {
  c: Point;
  /** Unit vector along the bar. */
  v: Point;
  half: number;
  n: number;
}

export function barOf(cc: Components, c: number): Bar | null {
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

export interface Polarity {
  lum: Uint8Array;
  cc: Components;
  sample: (x: number, y: number) => number;
}


export interface Pass extends Polarity {
  /** True when this pass looks for marks darker than their surroundings (dark ink on paper). */
  inverted: boolean;
  /** Round components: possible finders, largest first. */
  candidates: Ellipse[];
}

/**
 * One analysis of a frame shared by every format: luminance (downscaled by k), both threshold
 * polarities from one integral image, components and round candidates for each.
 */
export function analyze(image: ImageInput, maxDimension: number, polarity: "both" | "normal" | "inverted") {
  const { w, h, k, luma } = toLuma(image, maxDimension);
  const which: boolean[] = polarity === "both" ? [false, true] : [polarity === "inverted"];
  threshold(luma, w, h, which.includes(false), which.includes(true));
  const passes: Pass[] = [];
  for (const inverted of which) {
    let lum = luma;
    if (inverted) {
      lum = buffers.inv;
      for (let i = 0; i < w * h; i++) lum[i] = 255 - luma[i];
    }
    const cc = components(inverted ? buffers.maskInv : buffers.mask, w, h);
    const found: { e: Ellipse; area: number }[] = [];
    for (let c = 0; c < cc.count; c++) {
      if (cc.n[c] < 12) continue;
      const bw = cc.maxX[c] - cc.minX[c] + 1;
      const bh = cc.maxY[c] - cc.minY[c] + 1;
      if (bw < 5 || bh < 5 || bw > 5 * bh || bh > 5 * bw) continue;
      const e = filledEllipse(cc, c);
      if (e && e.a >= 3) found.push({ e, area: bw * bh });
    }
    found.sort((a, b) => b.area - a.area);
    passes.push({ inverted, lum, cc, sample: sampler(lum, w, h), candidates: found.slice(0, 200).map((f) => f.e) });
  }
  return { k, w, h, passes };
}
