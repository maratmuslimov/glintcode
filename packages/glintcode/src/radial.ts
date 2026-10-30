import { CODEWORD_BITS, decodeBits, encodeBits, payloadToNumber, type Payload } from "./codeword";
import { affineMap, type Ellipse, type Map2, type Point, type Polarity } from "./image";
import type { Format, Read } from "./types";

/*
 * Round formats. All share one layout idea: a solid lens (the finder) in the middle with a glyph or
 * logo cut out of it, and data on rings around it. Code units: the code fits in radius 1, angles run
 * clockwise from 12 o'clock, a cell's point is (r·sin θ, −r·cos θ).
 *
 * - orbit:          rings of arcs; the inner ring is the same on every code (rotation, validation).
 * - constellation:  the same rings drawn as dots.
 * - halo:           52 rays, each 0–3 segments long (2 bits); the first 4 rays are fixed.
 * - contour:        4 wavy rings; a cell bulging out is 1, in is 0. The inner ring breaks at two cells: the start mark.
 */

export type RadialFormat = Exclude<Format, "capsule">;

const TAU = Math.PI * 2;
export const polar = (r: number, a: number): Point => [r * Math.sin(a), -r * Math.cos(a)];

interface Ring {
  r: number;
  n: number;
}

interface Spec {
  /** Lens radius; the lens ring between `glyph` and `lens` is always ink. */
  lens: number;
  glyph: number;
  /** A radius between lens and data that is always paper (except where `known` says otherwise). */
  paper: number;
  seed: number;
  /** Where between paper (0) and ink (1) the rotation search splits: lower for formats that may use light colours. */
  split: number;
  /** Radii where the data lives: a real code has ink there at a fair share of angles. */
  data: number[];
  /** Sample points with a fixed value on every code: they give the rotation. */
  /** `dr`: also look this far in and out, keeping the inkiest sample (for lines whose radius varies). */
  known: { r: number; a: number; ink: boolean; w: number; dr?: number }[];
}

// ---------- orbit & constellation: binary cells on rings ----------

const SYNC = "111101110011100100100100";

interface CellLayout extends Spec {
  sync: Ring;
  rings: Ring[];
  /** Data cells in reading order (sorted by angle, so a smudge on one side costs few bytes). */
  cells: { ring: number; i: number; a: number }[];
}

function cellLayout(sync: Ring, rings: Ring[], spec: Omit<Spec, "known" | "data" | "split">): CellLayout {
  const cells: CellLayout["cells"] = [];
  rings.forEach((ring, k) => {
    for (let i = 0; i < ring.n; i++) cells.push({ ring: k, i, a: ((i + 0.5) / ring.n) * TAU });
  });
  cells.sort((p, q) => p.a - q.a || p.ring - q.ring);
  if (cells.length !== CODEWORD_BITS) throw new Error("layout must hold exactly one codeword");
  const known = [...SYNC].map((c, i) => ({ r: sync.r, a: ((i + 0.5) / sync.n) * TAU, ink: c === "1", w: 1 }));
  return { ...spec, sync, rings, cells, known, data: rings.map((r) => r.r), split: 0.5 };
}

const ORBIT = cellLayout({ r: 0.6, n: 24 }, [{ r: 0.7, n: 28 }, { r: 0.8, n: 32 }, { r: 0.9, n: 36 }], {
  lens: 0.46,
  glyph: 0.34,
  paper: 0.53,
  seed: 0x0b17c0de,
});
const ORBIT_STROKE = 0.072;
const ORBIT_GAP = 0.06;

const CONSTELLATION = cellLayout({ r: 0.55, n: 24 }, [{ r: 0.65, n: 28 }, { r: 0.75, n: 32 }, { r: 0.85, n: 36 }], {
  lens: 0.4,
  glyph: 0.29,
  paper: 0.455,
  seed: 0xc0175e11,
});
const DOT_R = 0.04;

// ---------- halo: rays of 4 lengths ----------

const HALO_RAYS = 52;
const HALO_FIXED = [3, 0, 3, 1];
const HALO_R0 = 0.53;
const HALO_LEN = [0, 0.12, 0.24, 0.38];
/** Radii between consecutive length levels: ink there means the ray reaches past it. */
const HALO_PROBES = [HALO_R0 + 0.06, HALO_R0 + 0.18, HALO_R0 + 0.31];
const HALO_STROKE = 0.05;
/** Ray end ÷ ray start (outer edge ÷ inner edge of the ink) between consecutive levels. */
const HALO_RATIO_SPLIT = (() => {
  const inner = HALO_R0 - HALO_STROKE / 2;
  const ratios = HALO_LEN.map((l) => (HALO_R0 + l + HALO_STROKE / 2) / inner);
  return [0, 1, 2].map((k) => (ratios[k] + ratios[k + 1]) / 2);
})();
const HALO: Spec = {
  lens: 0.4,
  glyph: 0.29,
  paper: 0.455,
  seed: 0x4a10c0de,
  split: 0.35,
  data: HALO_PROBES,
  known: (() => {
    const k: Spec["known"] = [];
    for (let i = 0; i < HALO_RAYS; i++) k.push({ r: HALO_R0, a: (i / HALO_RAYS) * TAU, ink: true, w: 1 });
    HALO_FIXED.forEach((level, i) => HALO_PROBES.forEach((r, j) => k.push({ r, a: (i / HALO_RAYS) * TAU, ink: level > j, w: 3 })));
    return k;
  })(),
};
// Two bits per ray, Gray-coded so that misjudging a length by one step costs one bit.
const GRAY_TO_LEVEL = [0, 1, 3, 2];
const LEVEL_TO_GRAY = [0, 1, 3, 2];

// ---------- contour: wavy rings ----------

const CONTOUR_RINGS: Ring[] = [{ r: 0.57, n: 20 }, { r: 0.69, n: 24 }, { r: 0.81, n: 28 }, { r: 0.93, n: 32 }];
const CONTOUR_AMP = 0.03;
const CONTOUR_STROKE = 0.036;
/** Cells of the inner ring where the line breaks: they mark the start, like a notch on a dial. */
const CONTOUR_BREAKS = [0, 3];
const CONTOUR_CELLS = (() => {
  const cells: { ring: number; i: number; a: number }[] = [];
  CONTOUR_RINGS.forEach((ring, k) => {
    for (let i = 0; i < ring.n; i++) if (k > 0 || !CONTOUR_BREAKS.includes(i)) cells.push({ ring: k, i, a: ((i + 0.5) / ring.n) * TAU });
  });
  return cells.sort((p, q) => p.a - q.a || p.ring - q.ring);
})();
/** Cells past the codeword carry a fixed alternating pattern. */
const CONTOUR_PAD = (i: number) => i % 2 === 0;
const CONTOUR: Spec = {
  lens: 0.42,
  glyph: 0.3,
  paper: 0.475,
  seed: 0xc047c0de,
  split: 0.5,
  data: CONTOUR_RINGS.map((r) => r.r),
  known: Array.from({ length: CONTOUR_RINGS[0].n }, (_, i) => ({
    r: CONTOUR_RINGS[0].r,
    a: ((i + 0.5) / CONTOUR_RINGS[0].n) * TAU,
    ink: !CONTOUR_BREAKS.includes(i),
    w: CONTOUR_BREAKS.includes(i) ? 4 : 1,
    dr: CONTOUR_AMP,
  })),
};

const SPECS: Record<RadialFormat, Spec> = { orbit: ORBIT, constellation: CONSTELLATION, halo: HALO, contour: CONTOUR };

// ---------- encoding ----------

/** Per-format model of what to draw: cell grids, ray levels or ring values. */
export function radialModel(format: RadialFormat, payload: Payload | number | bigint) {
  const bits = encodeBits(payload, SPECS[format].seed);
  if (format === "orbit" || format === "constellation") {
    const L = format === "orbit" ? ORBIT : CONSTELLATION;
    const grid = L.rings.map((r) => new Array<boolean>(r.n).fill(false));
    L.cells.forEach((c, k) => (grid[c.ring][c.i] = bits[k]));
    return { kind: "cells" as const, rings: [{ ...L.sync, bits: [...SYNC].map((c) => c === "1") }, ...L.rings.map((r, k) => ({ ...r, bits: grid[k] }))] };
  }
  if (format === "halo") {
    const levels = [...HALO_FIXED];
    for (let k = 0; k < CODEWORD_BITS; k += 2) levels.push(GRAY_TO_LEVEL[(bits[k] ? 2 : 0) + (bits[k + 1] ? 1 : 0)]);
    return { kind: "rays" as const, levels };
  }
  const grid = CONTOUR_RINGS.map((r) => new Array<boolean>(r.n).fill(false));
  CONTOUR_CELLS.forEach((c, k) => (grid[c.ring][c.i] = k < CODEWORD_BITS ? bits[k] : CONTOUR_PAD(k)));
  return { kind: "waves" as const, rings: CONTOUR_RINGS.map((r, k) => ({ ...r, bits: grid[k] })) };
}

// ---------- rendering ----------

export interface RadialOptions {
  /** Colour of everything printed. Default #111111. */
  ink?: string;
  /** Colour cut out of the lens (the glyph). Default #ffffff. */
  paper?: string;
  /** Fill behind the code; default none. */
  background?: string;
  /** One colour per ring (inner first; halo: per length level 0–3). Each must contrast with the background like `ink`. */
  rings?: string[];
  /** Lens colour (defaults to `ink`). */
  lens?: string;
  /** Inside the lens: the scan glyph (default), nothing, an image URL, or SVG markup in a -1..1 box. */
  logo?: "glyph" | "none" | { href: string } | { svg: string };
  /** Text under the code. */
  caption?: string;
  captionColor?: string;
  fontFamily?: string;
  /** Clear margin around the code in code units (radius 1). Default 0.2. */
  margin?: number;
  /** Sets width/height attributes (px) for this code diameter. */
  size?: number;
  title?: string;
}

const n = (v: number) => +v.toFixed(4);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
let clipIds = 0;

function runs(bits: boolean[]) {
  const len = bits.length;
  if (bits.every(Boolean)) return [[0, len]];
  const out: number[][] = [];
  const start = bits.findIndex((b, i) => b && !bits[(i + len - 1) % len]);
  if (start < 0) return out;
  for (let k = 0; k < len; ) {
    const i = (start + k) % len;
    if (!bits[i]) {
      k++;
      continue;
    }
    let l = 0;
    while (l < len && bits[(i + l) % len]) l++;
    out.push([i, l]);
    k += l;
  }
  return out;
}

function arc(r: number, a0: number, a1: number) {
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  return `M${n(x0)} ${n(y0)}A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${n(x1)} ${n(y1)}`;
}

/** Render a round code as an SVG string. */
export function radialSvg(format: RadialFormat, payload: Payload | number | bigint, options: RadialOptions = {}): string {
  const spec = SPECS[format];
  const model = radialModel(format, payload);
  const ink = options.ink ?? "#111111";
  const paper = options.paper ?? "#ffffff";
  const ringColor = (k: number) => options.rings?.[k] ?? ink;
  let body = "";

  if (model.kind === "cells" && format === "orbit") {
    model.rings.forEach((ring, k) => {
      const d = TAU / ring.n;
      const ext = (d * ring.r) / 2 - ORBIT_GAP / 2 - ORBIT_STROKE / 2;
      const path = runs(ring.bits)
        .map(([s, len]) =>
          len === ring.n
            ? `M0 ${-ring.r}A${ring.r} ${ring.r} 0 1 1 0 ${ring.r}A${ring.r} ${ring.r} 0 1 1 0 ${-ring.r}`
            : arc(ring.r, (s + 0.5) * d - ext / ring.r, (s + len - 0.5) * d + ext / ring.r),
        )
        .join("");
      body += `<path d="${path}" fill="none" stroke="${ringColor(k)}" stroke-width="${ORBIT_STROKE}" stroke-linecap="round"/>`;
    });
  } else if (model.kind === "cells") {
    model.rings.forEach((ring, k) => {
      let d = "";
      ring.bits.forEach((on, i) => {
        if (!on) return;
        const [x, y] = polar(ring.r, ((i + 0.5) / ring.n) * TAU);
        d += `M${n(x - DOT_R)} ${n(y)}a${DOT_R} ${DOT_R} 0 1 0 ${DOT_R * 2} 0a${DOT_R} ${DOT_R} 0 1 0 ${-DOT_R * 2} 0`;
      });
      body += `<path d="${d}" fill="${ringColor(k)}"/>`;
    });
  } else if (model.kind === "rays") {
    const byLevel: string[] = ["", "", "", ""];
    model.levels.forEach((level, i) => {
      const a = (i / HALO_RAYS) * TAU;
      const [x0, y0] = polar(HALO_R0, a);
      const [x1, y1] = polar(HALO_R0 + HALO_LEN[level], a);
      byLevel[level] += `M${n(x0)} ${n(y0)}L${n(x1)} ${n(y1)}`;
    });
    byLevel.forEach((d, level) => {
      if (d) body += `<path d="${d}" stroke="${ringColor(level)}" stroke-width="${HALO_STROKE}" stroke-linecap="round"/>`;
    });
  } else {
    model.rings.forEach((ring, k) => {
      const v = ring.bits.map((b) => (b ? 1 : -1));
      // The inner ring breaks around its start cells; the line is drawn from the end of one break round to the next.
      const breaks = k === 0 ? CONTOUR_BREAKS : [];
      const inBreak = (x: number) => breaks.some((b) => Math.abs(((x - b + ring.n * 1.5) % ring.n) - ring.n / 2) < 0.3);
      const steps = 240;
      const start = breaks.length ? Math.round(((breaks[0] + 0.5 + 0.3) / ring.n) * steps) : 0;
      let d = "";
      let pen = false;
      for (let j = 0; j <= steps; j++) {
        const a = (((j + start) % steps) / steps) * TAU;
        const x = (a / TAU) * ring.n - 0.5;
        if (inBreak(x)) {
          pen = false;
          continue;
        }
        const i0 = Math.floor(x);
        const u = x - i0;
        const w = (1 - Math.cos(Math.PI * u)) / 2;
        const val = v[(i0 + ring.n) % ring.n] * (1 - w) + v[(i0 + 1) % ring.n] * w;
        const [px, py] = polar(ring.r + CONTOUR_AMP * val, a);
        d += `${pen ? "L" : "M"}${n(px)} ${n(py)}`;
        pen = true;
      }
      body += `<path d="${d}${breaks.length ? "" : "Z"}" fill="none" stroke="${ringColor(k)}" stroke-width="${CONTOUR_STROKE}" stroke-linejoin="round" stroke-linecap="round"/>`;
    });
  }

  body += `<circle r="${spec.lens}" fill="${options.lens ?? ink}"/>`;
  const logo = options.logo ?? "glyph";
  const g = spec.glyph;
  if (logo === "glyph") {
    const s = g * 0.62, c = s * 0.4, L = s * 0.55;
    const corner = (sx: number, sy: number) =>
      `M${n(sx * s)} ${n(sy * (s - L))}L${n(sx * s)} ${n(sy * (s - c))}Q${n(sx * s)} ${n(sy * s)} ${n(sx * (s - c))} ${n(sy * s)}L${n(sx * (s - L))} ${n(sy * s)}`;
    const d = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => corner(a, b)).join("");
    body += `<path d="${d}" fill="none" stroke="${paper}" stroke-width="${n(g * 0.15)}" stroke-linecap="round"/>`;
  } else if (logo !== "none" && "href" in logo) {
    const id = `glint-logo-r${++clipIds}`;
    body += `<clipPath id="${id}"><circle r="${g}"/></clipPath><image href="${esc(logo.href)}" x="${-g}" y="${-g}" width="${g * 2}" height="${g * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/>`;
  } else if (logo !== "none") {
    body += `<g transform="scale(${g})">${logo.svg}</g>`;
  }

  const m = options.margin ?? 0.2;
  let height = 2 + 2 * m;
  if (options.caption) {
    const font = options.fontFamily ?? "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
    body += `<text x="0" y="${n(1 + m + 0.16)}" text-anchor="middle" font-family="${esc(font)}" font-size="0.2" fill="${options.captionColor ?? "#6e6e73"}">${esc(options.caption)}</text>`;
    height += 0.3;
  }
  if (options.background) body = `<rect x="${-1 - m}" y="${-1 - m}" width="${2 + 2 * m}" height="${n(height)}" fill="${options.background}"/>` + body;
  const size = options.size ? ` width="${n((options.size * (2 + 2 * m)) / 2)}" height="${n((options.size * height) / 2)}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-1 - m} ${-1 - m} ${2 + 2 * m} ${n(height)}"${size} role="img" aria-label="${esc(options.title ?? options.caption ?? "Glint code")}">${body}</svg>`;
}

// ---------- reading ----------

const SECTORS = 16;

/**
 * Cheap test shared by every round format, in lens radii: a solid lens, a paper gap right outside it,
 * and a clear quiet zone past the code. A dot from inside some code's rings fails the last part,
 * since at its own scale "past the code" lands on its neighbours.
 */
export function radialPrecheck(P: Polarity, e: Ellipse): boolean {
  const m = affineMap(e, 0, 1);
  const ring = (r: number) => {
    const out: number[] = [];
    for (let j = 0; j < 24; j++) out.push(P.sample(...m(...polar(r, ((j + 0.5) / 24) * TAU))));
    return out;
  };
  const lens = ring(0.86).sort((a, b) => a - b);
  const gap = ring(1.13).sort((a, b) => a - b);
  const ink = lens[12];
  const paper = gap[12];
  if (ink - paper < 18) return false;
  const t = (ink + paper) / 2;
  if (lens[3] < t || gap[20] > t) return false;
  if (ring(2.45).filter((v) => v < t).length < 20) return false;
  // Rings of data between 1.2 and 2.2 lens radii in every round format: a bullet or a letter "o"
  // has nothing there. Each probe takes the darkest of a few radii, since strokes are thin.
  let inked = 0;
  for (let j = 0; j < 48; j++) {
    const a = ((j + 0.5) / 48) * TAU;
    let hit = false;
    for (let r = 1.2; r <= 2.1 && !hit; r += 0.06) hit = P.sample(...m(...polar(r, a))) > t;
    if (hit) inked++;
  }
  return inked >= 16;
}

/**
 * Read a round code around candidate lens `e`. Finds the rotation from the format's fixed points,
 * then reads cells relative to per-sector ink/paper levels; a few small scale corrections are
 * tried when the first read doesn't decode (perspective makes the lens a slightly biased ruler).
 */
export function readRadial(format: RadialFormat, P: Polarity, e: Ellipse): Read | null {
  const spec = SPECS[format];
  const { sample } = P;
  const base = affineMap(e, 0, spec.lens);
  const at = (m: Map2, r: number, a: number) => sample(...m(...polar(r, a)));

  // Ink and paper levels; reject candidates without a clean lens ring and paper gap.
  const inkR = (spec.glyph + spec.lens) / 2;
  const inks: number[] = [];
  const papers: number[] = [];
  for (let s = 0; s < SECTORS * 2; s++) {
    const a = (s / (SECTORS * 2)) * TAU;
    inks.push(at(base, inkR, a));
    papers.push(at(base, spec.paper, a));
  }
  const sortedInk = inks.slice().sort((p, q) => p - q);
  const sortedPaper = papers.slice().sort((p, q) => p - q);
  const ink = sortedInk[SECTORS];
  const paper = sortedPaper[SECTORS];
  if (ink - paper < 18) return null;
  const t = (ink + paper) / 2;
  if (inks.filter((v) => v > t).length < SECTORS * 2 - 3) return null;
  if (papers.filter((v) => v < t).length < SECTORS * 2 - 6) return null;

  // Rotation. Soft score: how far each fixed point sits on its expected side of the split. A hard
  // match count is flat across a few degrees and would leave the rotation at the edge of that plateau.
  const total = spec.known.reduce((s, k) => s + k.w, 0);
  const tk = paper + (ink - paper) * spec.split;
  const span = (ink - paper) * Math.min(spec.split, 1 - spec.split);
  const score = (psi: number) => {
    const m = affineMap(e, psi, spec.lens);
    let s = 0;
    for (const k of spec.known) {
      const raw = k.dr ? Math.max(at(m, k.r - k.dr, k.a), at(m, k.r, k.a), at(m, k.r + k.dr, k.a)) : at(m, k.r, k.a);
      const v = Math.max(-1, Math.min(1, (raw - tk) / span));
      s += k.w * (k.ink ? v : -v);
    }
    return s;
  };
  const coarse: [number, number][] = [];
  for (let d = 0; d < 360; d += 2) coarse.push([score((d / 180) * Math.PI), (d / 180) * Math.PI]);
  coarse.sort((p, q) => q[0] - p[0]);
  let best = { psi: 0, s: -Infinity };
  const deg = Math.PI / 180;
  for (const [s0, psi0] of coarse.slice(0, 3)) {
    if (s0 < total * 0.4) break;
    let local = { psi: psi0, s: s0 };
    for (const [width, step] of [[2, 0.5], [0.5, 0.125]]) {
      const c = local.psi;
      for (let d = -width; d <= width; d += step) {
        const s = score(c + d * deg);
        if (s > local.s) local = { psi: c + d * deg, s };
      }
    }
    if (local.s > best.s) best = local;
  }
  if (best.s < total * 0.6) return null;

  // Per-sector references (code angle), so uneven light across the code cancels out.
  const sectorInk = new Float64Array(SECTORS);
  const sectorPaper = new Float64Array(SECTORS);
  const rot = affineMap(e, best.psi, spec.lens);
  for (let s = 0; s < SECTORS; s++) {
    const vals: number[] = [];
    const pv: number[] = [];
    for (let j = 0; j < 4; j++) {
      const a = ((s + (j + 0.5) / 4) / SECTORS) * TAU;
      vals.push(at(rot, inkR, a));
      pv.push(at(rot, spec.paper, a));
    }
    vals.sort((p, q) => p - q);
    pv.sort((p, q) => p - q);
    sectorInk[s] = (vals[1] + vals[2]) / 2;
    sectorPaper[s] = (pv[1] + pv[2]) / 2;
  }
  const rel = (v: number, a: number) => {
    const x = ((a / TAU) * SECTORS - 0.5 + SECTORS) % SECTORS;
    const s0 = Math.floor(x), u = x - s0, s1 = (s0 + 1) % SECTORS;
    const i = sectorInk[s0] * (1 - u) + sectorInk[s1] * u;
    const p = sectorPaper[s0] * (1 - u) + sectorPaper[s1] * u;
    return (v - p) / Math.max(8, i - p);
  };

  // If the plain read fails: small scale corrections, then perspective. x / (1 + p·x) keeps the lens
  // (centre and local scale) as fitted but bends the outer rings the way a tilted view does.
  const tries: [number, number, number][] = [];
  for (const scale of [1, 0.97, 1.03, 0.94, 1.06]) tries.push([scale, 0, 0]);
  for (const mag of [0.1, 0.2]) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      for (const scale of [1, 0.96, 1.04]) tries.push([scale, mag * Math.cos(a), mag * Math.sin(a)]);
    }
  }
  for (const [scale, px, py] of tries) {
    const m: Map2 = (x, y) => {
      const w = 1 + px * x + py * y;
      return rot((x * scale) / w, (y * scale) / w);
    };
    const out = readCells(format, m, (r, a) => rel(at(m, r, a), a));
    if (!out) continue;
    const decoded = decodeBits(out.bits, spec.seed, out.conf);
    if (!decoded) continue;
    const top = m(0, -1), bottom = m(0, 1);
    return {
      format,
      payload: decoded.payload,
      value: payloadToNumber(decoded.payload),
      corrected: decoded.corrected,
      corners: [m(-1, -1), m(1, -1), m(1, 1), m(-1, 1)],
      center: m(0, 0),
      size: Math.hypot(top[0] - bottom[0], top[1] - bottom[1]),
    };
  }
  return null;
}

/** Threshold one ring's relative values at half the level of its brighter cells. */
function binarize(values: number[]) {
  const sorted = values.slice().sort((p, q) => q - p);
  const top = sorted.slice(0, Math.max(3, sorted.length >> 2));
  const thr = Math.max(0.25, top.reduce((s, v) => s + v, 0) / top.length / 2);
  return { bits: values.map((v) => v > thr), conf: values.map((v) => Math.min(1, Math.abs(v - thr) / thr)) };
}

function readCells(format: RadialFormat, m: Map2, relAt: (r: number, a: number) => number): { bits: boolean[]; conf: number[] } | null {
  if (format === "orbit" || format === "constellation") {
    const L = format === "orbit" ? ORBIT : CONSTELLATION;
    // Strokes are thin: take the strongest of three radii, so a ring seen slightly off its radius
    // (perspective, a biased lens fit) still reads as ink.
    const perRing = L.rings.map((ring) => {
      const vals: number[] = [];
      for (let i = 0; i < ring.n; i++) {
        const a = ((i + 0.5) / ring.n) * TAU;
        vals.push(Math.max(relAt(ring.r - 0.022, a), relAt(ring.r, a), relAt(ring.r + 0.022, a)));
      }
      return binarize(vals);
    });
    return {
      bits: L.cells.map((c) => perRing[c.ring].bits[c.i]),
      conf: L.cells.map((c) => perRing[c.ring].conf[c.i]),
    };
  }
  if (format === "halo") {
    // Trace each ray outwards: where its ink starts (the base dot) and where it ends. The ratio of
    // the two gives the length level and doesn't care about the local scale, which perspective and
    // a biased lens fit both distort.
    const thr = 0.3;
    const bits: boolean[] = [];
    const conf: number[] = [];
    const levels: number[] = [];
    const confs: number[] = [];
    for (let i = 0; i < HALO_RAYS; i++) {
      const a = (i / HALO_RAYS) * TAU;
      let start = -1;
      let end = -1;
      let misses = 0;
      for (let r = 0.45; r <= 1.02; r += 0.01) {
        const d = 0.012 / r;
        const v = Math.max(relAt(r, a - d), relAt(r, a), relAt(r, a + d));
        if (v > thr) {
          if (start < 0) start = r;
          end = r;
          misses = 0;
        } else if (start >= 0 && ++misses > 2) break;
      }
      if (start < 0) return null;
      const ratio = end / start;
      let level = 0;
      while (level < 3 && ratio > HALO_RATIO_SPLIT[level]) level++;
      const edges = [HALO_RATIO_SPLIT[level - 1] ?? -Infinity, HALO_RATIO_SPLIT[level] ?? Infinity];
      levels.push(level);
      confs.push(Math.min(1, Math.min(ratio - edges[0], edges[1] - ratio) / 0.08));
    }
    for (let i = 0; i < HALO_FIXED.length; i++) if (levels[i] !== HALO_FIXED[i]) return null;
    for (let i = HALO_FIXED.length; i < HALO_RAYS; i++) {
      const g = LEVEL_TO_GRAY[levels[i]];
      bits.push(g >= 2, (g & 1) === 1);
      conf.push(confs[i], confs[i]);
    }
    return { bits, conf };
  }
  // contour: where along the radius each ring's line sits at each cell, relative to the ring's own trend.
  const isBreak = (ring: Ring, i: number) => ring === CONTOUR_RINGS[0] && CONTOUR_BREAKS.includes(i);
  // Line position (radial offset from the nominal radius) at each cell: the ink-weighted centre of a window.
  const measure = (ring: Ring, center: number[], half: number) =>
    center.map((c, i) => {
      if (isBreak(ring, i)) return c;
      const a = ((i + 0.5) / ring.n) * TAU;
      let sw = 0, sx = 0;
      for (let d = c - half; d <= c + half + 1e-9; d += half / 6) {
        const w = Math.max(0, relAt(ring.r + d, a) - 0.25);
        sw += w;
        sx += w * d;
      }
      return sw > 0 ? sx / sw : c;
    });
  // Separate the slow drift (scale and perspective errors: a constant and two harmonics) from the
  // ±amplitude signal, alternating: estimate the signal, fit the drift to what's left, repeat.
  const split = (ring: Ring, raw: number[]) => {
    let signal = raw.map(() => 0);
    let trend = raw.map(() => 0);
    for (let iter = 0; iter < 4; iter++) {
      trend = harmonicFit(raw.map((v, i) => v - signal[i]), ring.n);
      signal = raw.map((v, i) => (v - trend[i] > 0 ? CONTOUR_AMP : -CONTOUR_AMP));
    }
    return trend;
  };
  const offsets = CONTOUR_RINGS.map((ring) => {
    // First pass with a wide window finds where the ring really is; the second re-centres a
    // narrower window on that drift, so a neighbouring ring can't pull the centre.
    const wide = measure(ring, new Array(ring.n).fill(0), 0.065);
    const drift = split(ring, wide);
    const fine = measure(ring, drift, CONTOUR_AMP + 0.03);
    const trend = split(ring, fine);
    return fine.map((v, i) => (isBreak(ring, i) ? 0 : v - trend[i]));
  });
  const bits: boolean[] = [];
  const conf: number[] = [];
  CONTOUR_CELLS.forEach((c, k) => {
    const v = offsets[c.ring][c.i];
    if (k < CODEWORD_BITS) {
      bits.push(v > 0);
      conf.push(Math.min(1, Math.abs(v) / CONTOUR_AMP));
    }
  });
  // The pad cells must read as their fixed pattern, or this isn't a contour code.
  let padOk = 0;
  CONTOUR_CELLS.forEach((c, k) => {
    if (k >= CODEWORD_BITS && offsets[c.ring][c.i] > 0 === CONTOUR_PAD(k)) padOk++;
  });
  return padOk >= CONTOUR_CELLS.length - CODEWORD_BITS - 2 ? { bits, conf } : null;
}

/** Least-squares fit of v[i] ≈ c0 + c1·cos θ + s1·sin θ + c2·cos 2θ + s2·sin 2θ at cell angles. */
function harmonicFit(v: number[], count: number) {
  const basis = (i: number) => {
    const a = ((i + 0.5) / count) * TAU;
    return [1, Math.cos(a), Math.sin(a), Math.cos(2 * a), Math.sin(2 * a)];
  };
  // Cell angles are evenly spaced, so the basis is orthogonal: each coefficient is a projection.
  const coef = [0, 0, 0, 0, 0];
  const norm = [count, count / 2, count / 2, count / 2, count / 2];
  for (let i = 0; i < count; i++) {
    const b = basis(i);
    for (let j = 0; j < 5; j++) coef[j] += (v[i] * b[j]) / norm[j];
  }
  return v.map((_, i) => basis(i).reduce((s, b, j) => s + b * coef[j], 0));
}
