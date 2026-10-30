import {
  BAR_HALF,
  colX,
  DISC_R,
  encodeCells,
  END_X,
  GLYPH_R,
  MARK,
  RIGHT_CAP,
  ROWS,
  START_X,
  type Payload,
} from "./capsule-format";

export type Label = string | { title: string; subtitle?: string };

export interface CapsuleOptions {
  /** "pill" (default): marks cut out of a filled capsule. "bare": marks printed straight on the background. */
  style?: "pill" | "bare";
  /** Fill of the capsule (pill style). Default #111111. */
  pill?: string;
  /** Colour of the marks, bars and disc. Default white on the pill, #111111 bare. */
  marks?: string;
  /** One colour per row of marks, top to bottom. Each must contrast with the pill like `marks` does. */
  rows?: [string, string, string, string];
  /** Disc colour (defaults to `marks`). */
  disc?: string;
  /** Colour of the default glyph inside the disc (defaults to the pill, or white bare). */
  glyph?: string;
  /** Inside the disc: the default scan glyph, nothing, an image URL, or SVG markup drawn in a -1..1 box. */
  logo?: "glyph" | "none" | { href: string } | { svg: string };
  /** Human-readable text after the code, inside the capsule. */
  label?: Label;
  /** Text under the capsule. */
  caption?: string;
  /** Label colour (defaults to `marks`). */
  text?: string;
  /** Caption colour. Default #6e6e73. */
  captionColor?: string;
  fontFamily?: string;
  /** Exact text width in code units for a font size of 1, when the caller can measure (canvas, server font metrics). */
  measureText?: (text: string, weight: number) => number;
  /** Background behind everything; default none (transparent). */
  background?: string;
  /** Clear margin around the code, in code units (the pill is 2 units tall). Default 0.4, bare 0.6. */
  margin?: number;
  /** Sets width/height attributes for this pill height in px. Without it the SVG scales to its container. */
  height?: number;
  /** Accessible name; defaults to the label. */
  title?: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CapsuleLayout {
  viewBox: Rect;
  /** Capsule outline: left cap centre (0,0), right cap centre (right,0), radius 1. */
  pill: { right: number };
  disc: { r: number; glyphR: number };
  /** Every mark, bars included, as a stadium from (x0,y) to (x1,y) with radius MARK/2. Bars are vertical. */
  marks: { row: number; x0: number; y0: number; x1: number; y1: number }[];
  label?: { title: { text: string; x: number; y: number; size: number; width: number }; subtitle?: { text: string; x: number; y: number; size: number; width: number } };
  caption?: { text: string; x: number; y: number; size: number };
}

const TITLE_SIZE = 0.62;
const TITLE_SIZE_2 = 0.56;
const SUBTITLE_SIZE = 0.4;
const LABEL_GAP = 0.55;
const LABEL_PAD = 0.75;

/** Rough advance width in em for a system sans-serif, used when no measureText is given. */
function estimateWidth(text: string, weight: number) {
  let w = 0;
  for (const ch of text) {
    if (ch === " ") w += 0.28;
    else if (/[.,:;!|'·]/.test(ch)) w += 0.27;
    else if (/[0-9]/.test(ch)) w += 0.58;
    else if (/[MWМШЩЖЮФ]/.test(ch)) w += 0.86;
    else if (/[mwмшщжюф]/.test(ch)) w += 0.8;
    else if (/[A-ZА-ЯЁ]/.test(ch)) w += 0.66;
    else if (/[iljI]/.test(ch)) w += 0.25;
    else w += 0.54;
  }
  return w * (weight >= 600 ? 1.06 : 1);
}

export function capsuleLayout(payload: Payload | number | bigint, options: CapsuleOptions = {}): CapsuleLayout {
  const cells = encodeCells(payload);
  const marks: CapsuleLayout["marks"] = [];
  marks.push({ row: -1, x0: START_X, y0: -BAR_HALF, x1: START_X, y1: BAR_HALF });
  ROWS.forEach((y, row) => {
    const bits = cells[row];
    for (let i = 0; i < bits.length; ) {
      if (!bits[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < bits.length && bits[j + 1]) j++;
      marks.push({ row, x0: colX(i), y0: y, x1: colX(j), y1: y });
      i = j + 1;
    }
  });
  marks.push({ row: -1, x0: END_X, y0: -BAR_HALF, x1: END_X, y1: BAR_HALF });

  const measure = options.measureText ?? estimateWidth;
  let right = RIGHT_CAP;
  let label: CapsuleLayout["label"];
  const l = typeof options.label === "string" ? { title: options.label } : options.label;
  if (l?.title) {
    const x = END_X + LABEL_GAP;
    const two = !!l.subtitle;
    const tSize = two ? TITLE_SIZE_2 : TITLE_SIZE;
    const tWidth = measure(l.title, 650) * tSize;
    const title = { text: l.title, x, y: two ? -0.02 : 0.22, size: tSize, width: tWidth };
    const subtitle = two
      ? { text: l.subtitle!, x, y: 0.52, size: SUBTITLE_SIZE, width: measure(l.subtitle!, 500) * SUBTITLE_SIZE }
      : undefined;
    label = { title, subtitle };
    right = Math.max(RIGHT_CAP, x + Math.max(tWidth, subtitle?.width ?? 0) + LABEL_PAD - 1);
  }

  const style = options.style ?? "pill";
  const margin = options.margin ?? (style === "bare" ? 0.6 : 0.4);
  const caption = options.caption ? { text: options.caption, x: right / 2, y: 1 + 0.75, size: 0.5 } : undefined;
  const bottom = caption ? caption.y + 0.2 : 1;
  return {
    viewBox: { x: -1 - margin, y: -1 - margin, width: right + 2 + margin * 2, height: bottom + 1 + margin * 2 },
    pill: { right },
    disc: { r: DISC_R, glyphR: GLYPH_R },
    marks,
    label,
    caption,
  };
}

const n = (v: number) => +v.toFixed(3);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A stadium (round-ended line) of radius r from (x0,y0) to (x1,y1), as a filled path. */
function stadium(x0: number, y0: number, x1: number, y1: number, r: number) {
  if (x0 === x1 && y0 !== y1) {
    return `M${n(x0 - r)} ${n(y0)}A${r} ${r} 0 0 1 ${n(x0 + r)} ${n(y0)}V${n(y1)}A${r} ${r} 0 0 1 ${n(x0 - r)} ${n(y1)}Z`;
  }
  return `M${n(x0)} ${n(y0 - r)}H${n(x1)}A${r} ${r} 0 0 1 ${n(x1)} ${n(y0 + r)}H${n(x0)}A${r} ${r} 0 0 1 ${n(x0)} ${n(y0 - r)}Z`;
}

let clipIds = 0;

/** Render a Capsule code as an SVG string. */
export function capsuleSvg(payload: Payload | number | bigint, options: CapsuleOptions = {}): string {
  const layout = capsuleLayout(payload, options);
  const style = options.style ?? "pill";
  const pill = options.pill ?? "#111111";
  const marks = options.marks ?? (style === "pill" ? "#ffffff" : "#111111");
  const disc = options.disc ?? marks;
  const glyph = options.glyph ?? (style === "pill" ? pill : "#ffffff");
  const text = options.text ?? marks;
  const font = options.fontFamily ?? "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  const { viewBox: vb, pill: p } = layout;

  const byColor = new Map<string, string>();
  for (const m of layout.marks) {
    const color = m.row >= 0 && options.rows ? options.rows[m.row] : marks;
    byColor.set(color, (byColor.get(color) ?? "") + stadium(m.x0, m.y0, m.x1, m.y1, MARK / 2));
  }

  let body = "";
  if (options.background) body += `<rect x="${n(vb.x)}" y="${n(vb.y)}" width="${n(vb.width)}" height="${n(vb.height)}" fill="${options.background}"/>`;
  if (style === "pill") body += `<path d="M0 -1H${n(p.right)}A1 1 0 0 1 ${n(p.right)} 1H0A1 1 0 0 1 0 -1Z" fill="${pill}"/>`;
  for (const [color, d] of byColor) body += `<path d="${d}" fill="${color}"/>`;

  body += `<circle r="${DISC_R}" fill="${disc}"/>`;
  const logo = options.logo ?? "glyph";
  if (logo === "glyph") {
    // Scan corners: four rounded L shapes.
    const s = 0.24, c = 0.1, L = 0.13;
    const corner = (sx: number, sy: number) =>
      `M${sx * s} ${n(sy * (s - L))}L${sx * s} ${n(sy * (s - c))}Q${sx * s} ${sy * s} ${n(sx * (s - c))} ${sy * s}L${n(sx * (s - L))} ${sy * s}`;
    const d = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => corner(a, b)).join("");
    body += `<path d="${d}" fill="none" stroke="${glyph}" stroke-width="0.075" stroke-linecap="round"/>`;
  } else if (logo !== "none" && "href" in logo) {
    const id = `capsule-logo-${++clipIds}`;
    body += `<clipPath id="${id}"><circle r="${GLYPH_R}"/></clipPath><image href="${esc(logo.href)}" x="${-GLYPH_R}" y="${-GLYPH_R}" width="${GLYPH_R * 2}" height="${GLYPH_R * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/>`;
  } else if (logo !== "none") {
    body += `<g transform="scale(${GLYPH_R})">${logo.svg}</g>`;
  }

  if (layout.label) {
    const { title, subtitle } = layout.label;
    const fit = options.measureText ? "" : ` textLength="${n(title.width)}" lengthAdjust="spacingAndGlyphs"`;
    body += `<text x="${n(title.x)}" y="${title.y}" font-family="${esc(font)}" font-size="${title.size}" font-weight="650" fill="${text}"${fit}>${esc(title.text)}</text>`;
    if (subtitle) {
      const fit2 = options.measureText ? "" : ` textLength="${n(subtitle.width)}" lengthAdjust="spacingAndGlyphs"`;
      body += `<text x="${n(subtitle.x)}" y="${subtitle.y}" font-family="${esc(font)}" font-size="${subtitle.size}" font-weight="500" fill="${text}" fill-opacity="0.72"${fit2}>${esc(subtitle.text)}</text>`;
    }
  }
  if (layout.caption) {
    const c = layout.caption;
    body += `<text x="${n(c.x)}" y="${n(c.y)}" text-anchor="middle" font-family="${esc(font)}" font-size="${c.size}" fill="${options.captionColor ?? "#6e6e73"}">${esc(c.text)}</text>`;
  }

  const name = options.title ?? (typeof options.label === "string" ? options.label : options.label?.title) ?? "Capsule code";
  const size = options.height ? ` width="${n((vb.width / 2) * options.height)}" height="${n((vb.height / 2) * options.height)}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(vb.x)} ${n(vb.y)} ${n(vb.width)} ${n(vb.height)}"${size} role="img" aria-label="${esc(name)}">${body}</svg>`;
}
