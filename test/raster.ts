// A tiny software rasterizer for tests: draws a capsule layout through a projective map, with
// supersampling, blur-free. Good enough to exercise the reader without a browser.
import { capsuleLayout, type CapsuleOptions } from "../src/render";
import { DISC_R, GLYPH_R, MARK } from "../src/format";

export type Mat3 = number[]; // row-major 3x3, image = M · code

export function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}

export function render(
  value: number,
  M: Mat3,
  width: number,
  height: number,
  opts: CapsuleOptions & { ink?: number; paper?: number } = {},
): Uint8Array {
  const L = capsuleLayout(value, opts);
  const inv = invert3(M);
  const pill = (opts.style ?? "pill") === "pill";
  const ink = opts.ink ?? 20, paper = opts.paper ?? 245;
  // Pill style: dark pill, light marks. Bare: dark marks on paper.
  const markV = pill ? paper : ink;
  const out = new Uint8Array(width * height);
  const r = MARK / 2;
  const inMark = (x: number, y: number) => {
    for (const m of L.marks) {
      const px = Math.min(Math.max(x, Math.min(m.x0, m.x1)), Math.max(m.x0, m.x1));
      const py = Math.min(Math.max(y, Math.min(m.y0, m.y1)), Math.max(m.y0, m.y1));
      if ((x - px) ** 2 + (y - py) ** 2 <= r * r) return true;
    }
    return false;
  };
  const shade = (x: number, y: number) => {
    const d2 = x * x + y * y;
    if (d2 <= DISC_R * DISC_R) {
      // glyph: a dark square ring inside the disc
      if (d2 <= GLYPH_R * GLYPH_R && Math.max(Math.abs(x), Math.abs(y)) < 0.26 && Math.max(Math.abs(x), Math.abs(y)) > 0.18) return pill ? ink : paper;
      return markV;
    }
    if (inMark(x, y)) return markV;
    if (pill) {
      const cx = Math.min(Math.max(x, 0), L.pill.right);
      if ((x - cx) ** 2 + y * y <= 1) return ink;
    }
    return paper;
  };
  const S = 3;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let s = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const X = px + (sx + 0.5) / S, Y = py + (sy + 0.5) / S;
        const w = inv[6] * X + inv[7] * Y + inv[8];
        const u = (inv[0] * X + inv[1] * Y + inv[2]) / w;
        const v = (inv[3] * X + inv[4] * Y + inv[5]) / w;
        s += Math.abs(u) > 12 || Math.abs(v) > 4 ? paper : shade(u, v);
      }
      out[py * width + px] = s / (S * S);
    }
  }
  return out;
}

/** Map code units into an image: scale (px per unit), rotation, centre, and a projective tilt. */
export function pose({ scale, angle, cx, cy, px = 0, py = 0 }: { scale: number; angle: number; cx: number; cy: number; px?: number; py?: number }): Mat3 {
  const c = Math.cos(angle) * scale, s = Math.sin(angle) * scale;
  // Centre the code (x ≈ 4.4) on (cx, cy).
  const ox = -4.4;
  return [c, -s, cx + c * ox, s, c, cy + s * ox, px, py, 1 + px * ox];
}
