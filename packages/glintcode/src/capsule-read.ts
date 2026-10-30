import {
  BAR_HALF,
  colX,
  COLS,
  decodeCells,
  DISC_R,
  END_X,
  MARK,
  RIGHT_CAP,
  ROWS,
  START_X,
} from "./capsule-format";
import { payloadToNumber } from "./codeword";
import { affineMap, type Bar, barOf, compAt, type Ellipse, homography, type Map2, type Point, type Polarity } from "./image";
import type { Read } from "./types";

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

export function readCapsule(P: Polarity, e: Ellipse): Read | null {
  const { sample, cc } = P;
  // Contrast between the disc's clear ring and the capsule around it.
  const base = affineMap(e, 0, DISC_R);
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
    const m = affineMap(e, psi, DISC_R);
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
  const affine = affineMap(e, best.psi, DISC_R);

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
    if (out) {
      const right = RIGHT_CAP + 1;
      const top = map(0, -1), bottom = map(0, 1);
      return {
        format: "capsule",
        payload: out.payload,
        value: payloadToNumber(out.payload),
        corrected: out.corrected,
        corners: [map(-1, -1), map(right, -1), map(right, 1), map(-1, 1)],
        center: map(0, 0),
        size: Math.hypot(top[0] - bottom[0], top[1] - bottom[1]),
      };
    }
  }
  return null;
}
