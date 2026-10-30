// Stress test on real renders: Chromium draws a code's SVG with CSS 3D tilt, blur and clutter,
// screenshots it as JPEG, then noise and uneven light are added and the reader runs in Node.
//   pnpm stress [cases=400] [seed=1] [format=capsule|orbit|…|all]
// With format "all", also runs frames with no code in them (false reads) and clean renders of every
// format, colour scheme and size, codes filling the frame included: those must always read.
//   OUT_JSON=<file>  write the summary as JSON (the site's results table comes from it)
//   CORPUS=<dir>     keep every frame as 8-bit luminance plus a manifest, to compare the Swift and Kotlin readers
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { detect } from "../src/detect";
import { capsuleLayout, type CapsuleOptions } from "../src/capsule-render";
import { codeSvg, FORMATS, type Format } from "../src/index";
import type { RadialOptions } from "../src/radial";

const require = createRequire(import.meta.url);
// Playwright comes with the machine (pre-installed browser), not with this package.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { chromium } = require("playwright") as { chromium: any };

const CASES = Number(process.argv[2] ?? 400);
const TARGET = process.argv[4] ?? "capsule";
const SEED = Number(process.argv[3] ?? 1);
let seed = Number(process.argv[3] ?? 1);
const rnd = () => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 4294967296;
};
const between = (a: number, b: number) => a + (b - a) * rnd();
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

const W = 960;
const H = 720;

type Style = { name: string; opts: CapsuleOptions & RadialOptions; bg: string };

const stylesOf = (format: Format): Style[] =>
  format === "capsule"
    ? [
        { name: "pill", opts: {}, bg: "#f4f4f2" },
        { name: "pill+label", opts: { label: { title: "Maison", subtitle: "Стол 12 · меню" } }, bg: "#ffffff" },
        { name: "inverted", opts: { pill: "#ffffff", marks: "#111111" }, bg: "#151515" },
        { name: "bare", opts: { style: "bare", label: "Café Sol" }, bg: "#ffffff" },
        { name: "brand", opts: { pill: "#4b58e6", label: "loyalty card" }, bg: "#eef0ff" },
        { name: "rows", opts: { pill: "#1d1d1f", rows: ["#ffffff", "#f1c9a8", "#e59a6b", "#ffb36b"], label: "Ticket 20931" }, bg: "#faf7f2" },
      ]
    : [
        { name: "ink", opts: {}, bg: "#f4f4f2" },
        { name: "inverted", opts: { ink: "#ffffff", paper: "#151515" }, bg: "#151515" },
        { name: "rings", opts: { lens: "#16171c", rings: ["#2f37a8", "#4b58e6", "#6877ff", "#8a7dff"] }, bg: "#ffffff" },
        { name: "warm+logo", opts: { ink: "#2b241c", paper: "#f4efe7", lens: "#7a2e1d", logo: { svg: '<text x="0" y="0.38" text-anchor="middle" font-family="Georgia" font-style="italic" font-size="1.15" fill="#f4efe7">M</text>' } }, bg: "#f4efe7" },
        { name: "caption", opts: { caption: "Наведите камеру" }, bg: "#ffffff" },
      ];


const CLUTTER = `
  <div style="position:absolute;left:20px;top:16px;font:600 28px system-ui;color:#333">Наш сезонный ужин · Season dinner</div>
  <div style="position:absolute;left:24px;bottom:20px;font:16px Georgia;color:#555;width:600px">Lorem ipsum o o o • • • ● ● ◯ ◎ 0 O Q — 12:30 · 18:45 · €24</div>
  <div style="position:absolute;right:30px;top:80px;width:70px;height:70px;border-radius:50%;background:#222"></div>
  <div style="position:absolute;right:120px;top:90px;width:40px;height:40px;border-radius:50%;border:8px solid #222"></div>
  <div style="position:absolute;left:40px;top:120px;width:160px;height:36px;border-radius:18px;background:#222"></div>
`;

interface Case {
  style: Style;
  value: number;
  height: number;
  rz: number;
  rx: number;
  ry: number;
  blur: number;
  noise: number;
  light: number;
  quality: number;
  x: number;
  y: number;
}

function makeCase(format: Format): Case {
  return {
    style: pick(stylesOf(format)),
    value: Math.floor(rnd() * 2 ** 48),
    height: Math.round(format === "capsule" ? between(22, 160) : between(40, 640)),
    rz: between(0, 360),
    rx: between(-55, 55),
    ry: between(-45, 45),
    blur: rnd() < 0.5 ? 0 : between(0, 1.6),
    noise: between(0, 14),
    light: between(0, 0.55),
    quality: Math.round(between(55, 92)),
    x: between(0.45, 0.55),
    y: between(0.45, 0.55),
  };
}

// Plain JS source: tsx would wrap a real function with helpers the page doesn't have.
const NOISE = `async ({ src, noise, light, seed }) => {
  const img = new Image();
  img.src = src;
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.width;
  cv.height = img.height;
  const g = cv.getContext("2d");
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, cv.width, cv.height);
  let s = seed;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      const k = (y * cv.width + x) * 4;
      const shade = 1 - light * (x / cv.width) * (0.5 + y / cv.height);
      const n = (r() + r() + r() - 1.5) * noise * 1.4;
      for (let ch = 0; ch < 3; ch++) d.data[k + ch] = Math.max(0, Math.min(255, d.data[k + ch] * shade + n));
    }
  }
  let bin = "";
  for (let k = 0; k < d.data.length; k += 0x8000) bin += String.fromCharCode(...d.data.subarray(k, k + 0x8000));
  return btoa(bin);
}`;

const luminance = (rgba: Uint8Array) => {
  const out = new Uint8Array(rgba.length >> 2);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return out;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pages = { page: any; decoder: any };

/** Draw a frame, add noise and uneven light, return RGBA. */
async function frame({ page, decoder }: Pages, html: string, c: Pick<Case, "quality" | "noise" | "light">, i: number) {
  await page.setContent(html);
  const jpeg = await page.screenshot({ type: "jpeg", quality: c.quality });
  // Added in the page so the result is plain RGBA.
  const b64 = (await decoder.evaluate(
    `(${NOISE})(${JSON.stringify({ src: `data:image/jpeg;base64,${jpeg.toString("base64")}`, noise: c.noise, light: c.light, seed: i + 1 })})`,
  )) as string;
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function keep(name: string, rgba: Uint8Array, entry: object) {
  if (!process.env.CORPUS) return;
  mkdirSync(process.env.CORPUS, { recursive: true });
  writeFileSync(`${process.env.CORPUS}/${name}.gray`, luminance(rgba));
  appendFileSync(`${process.env.CORPUS}/manifest.jsonl`, JSON.stringify({ file: `${name}.gray`, width: W, height: H, ...entry }) + "\n");
}

async function runFormat(pages: Pages, format: Format) {
  const stats = new Map<string, { n: number; ok: number }>();
  const bump = (key: string, ok: boolean) => {
    const s = stats.get(key) ?? { n: 0, ok: 0 };
    s.n++;
    if (ok) s.ok++;
    stats.set(key, s);
  };
  let wrong = 0;
  const times: number[] = [];
  const failures: string[] = [];

  for (let i = 0; i < CASES; i++) {
    const c = makeCase(format);
    let svg: string;
    if (format === "capsule") {
      // Keep the whole code in frame at any rotation: its length stays under 90% of the short side.
      const vb = capsuleLayout(c.value, c.style.opts).viewBox;
      c.height = Math.min(c.height, Math.floor((0.9 * Math.min(W, H) * 2) / vb.width));
      svg = codeSvg("capsule", c.value, { ...c.style.opts, height: c.height });
    } else {
      // Round codes: c.height is the diameter.
      svg = codeSvg(format, c.value, { ...c.style.opts, size: c.height });
    }
    const data = await frame(
      pages,
      `<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;background:${c.style.bg};overflow:hidden;position:relative">
      ${CLUTTER}
      <div style="position:absolute;left:${c.x * W}px;top:${c.y * H}px;perspective:${between(650, 1600)}px">
        <div style="transform:translate(-50%,-50%) rotateZ(${c.rz}deg) rotateX(${c.rx}deg) rotateY(${c.ry}deg);filter:blur(${c.blur}px);line-height:0">${svg}</div>
      </div></body></html>`,
      c,
      i,
    );

    const t0 = performance.now();
    const found = detect({ data, width: W, height: H });
    times.push(performance.now() - t0);
    keep(`${format}-${i}`, data, { format, value: c.value, read: found.map((f) => ({ format: f.format, value: f.value, corrected: f.corrected })) });

    const ok = found.some((f) => f.value === c.value && f.format === format);
    if (found.some((f) => f.value !== c.value || f.format !== format)) wrong++;
    const tilt = Math.max(Math.abs(c.rx), Math.abs(c.ry));
    bump("all", ok);
    bump(`style ${c.style.name}`, ok);
    if (format === "capsule") bump(`height ${c.height < 32 ? "22-31" : c.height < 48 ? "32-47" : c.height < 80 ? "48-79" : "80-160"}px`, ok);
    else bump(`size ${c.height < 60 ? "40-59" : c.height < 100 ? "60-99" : c.height < 180 ? "100-179" : c.height < 320 ? "180-319" : "320-640"}px`, ok);
    bump(`tilt ${tilt < 20 ? "0-19" : tilt < 35 ? "20-34" : tilt < 45 ? "35-44" : "45-55"}°`, ok);
    bump(`blur ${c.blur === 0 ? "none" : c.blur < 0.8 ? "<0.8px" : "0.8-1.6px"}`, ok);
    if (!ok) failures.push(`#${i} ${c.style.name} h=${c.height} rx=${c.rx.toFixed(0)} ry=${c.ry.toFixed(0)} blur=${c.blur.toFixed(1)} noise=${c.noise.toFixed(0)} q=${c.quality}`);
  }

  times.sort((a, b) => a - b);
  const median = times[times.length >> 1];
  const p90 = times[Math.floor(times.length * 0.9)];
  console.log(`\n${format}: ${CASES} frames ${W}×${H}`);
  for (const [k, s] of [...stats].sort()) console.log(`${k.padEnd(18)} ${String(s.ok).padStart(4)}/${String(s.n).padEnd(4)} ${((100 * s.ok) / s.n).toFixed(1)}%`);
  console.log(`wrong payloads    ${wrong}`);
  console.log(`time per frame    median ${median.toFixed(1)} ms, p90 ${p90.toFixed(1)} ms`);
  if (process.env.VERBOSE) console.log(failures.join("\n"));
  return { format, frames: CASES, wrong, medianMs: +median.toFixed(1), p90Ms: +p90.toFixed(1), buckets: Object.fromEntries([...stats].sort()) };
}

/** Frames with the same clutter and damage but no code: anything read here is a false positive. */
async function runNegatives(pages: Pages) {
  let falseReads = 0;
  for (let i = 0; i < CASES; i++) {
    const data = await frame(
      pages,
      `<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;background:${pick(["#ffffff", "#f4f4f2", "#151515"])};overflow:hidden;position:relative">${CLUTTER}
      <div style="position:absolute;left:${between(200, 700)}px;top:${between(200, 500)}px;font:${Math.round(between(14, 60))}px Georgia;color:#444;transform:rotate(${between(0, 360)}deg)">oooo ● ◎ ◯ 0Oo •••</div></body></html>`,
      { quality: Math.round(between(55, 92)), noise: between(0, 14), light: between(0, 0.55) },
      i,
    );
    const found = detect({ data, width: W, height: H });
    keep(`none-${i}`, data, { format: "none", read: found.map((f) => ({ format: f.format, value: f.value, corrected: f.corrected })) });
    falseReads += found.length;
  }
  console.log(`\nno code: ${CASES} frames, ${falseReads} false reads`);
  return { frames: CASES, falseReads };
}

const CLEAN_THEMES: { bg: string; capsule: CapsuleOptions; round: RadialOptions }[] = [
  { bg: "#ffffff", capsule: {}, round: {} },
  { bg: "#111216", capsule: { pill: "#ffffff", marks: "#111216" }, round: { ink: "#ffffff", paper: "#111216" } },
  { bg: "#ffffff", capsule: { pill: "#3d46e0" }, round: { lens: "#16171c", rings: ["#2f37a8", "#3d46e0", "#5563ee", "#6877ff"] } },
  { bg: "#f4efe7", capsule: { pill: "#7a2e1d", marks: "#f4efe7" }, round: { ink: "#2b241c", paper: "#f4efe7", lens: "#7a2e1d" } },
];

/** Perfect renders of every format and colour scheme, from small to filling the frame. Nothing here should fail. */
async function runClean({ decoder }: Pages) {
  const out: { format: Format; frames: number; read: number; wrong: number }[] = [];
  const perCombo = Math.max(4, Math.round(CASES / 15));
  for (const format of FORMATS) {
    let read = 0, wrong = 0, frames = 0;
    for (const size of [320, 480, 640, 800, 1100, 1280]) {
      for (const theme of CLEAN_THEMES) {
        for (let i = 0; i < perCombo; i++) {
          const value = Math.floor(rnd() * 2 ** 48);
          const svg = format === "capsule" ? codeSvg("capsule", value, { ...theme.capsule, margin: 0.3 }) : codeSvg(format, value, theme.round);
          const [b64, w, h] = (await decoder.evaluate(
            `(async () => {
              const url = URL.createObjectURL(new Blob([${JSON.stringify(svg)}], { type: "image/svg+xml" }));
              const img = new Image(); img.src = url; await img.decode();
              const k = ${size} / Math.max(img.naturalWidth, img.naturalHeight);
              const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
              const g = c.getContext("2d"); g.fillStyle = ${JSON.stringify(theme.bg)}; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
              const d = g.getImageData(0, 0, c.width, c.height).data; let s = "";
              for (let k2 = 0; k2 < d.length; k2 += 0x8000) s += String.fromCharCode(...d.subarray(k2, k2 + 0x8000));
              URL.revokeObjectURL(url); return [btoa(s), c.width, c.height]; })()`,
          )) as [string, number, number];
          const found = detect({ data: new Uint8Array(Buffer.from(b64, "base64")), width: w, height: h });
          frames++;
          if (found.some((f) => f.value === value && f.format === format)) read++;
          if (found.some((f) => f.value !== value || f.format !== format)) wrong++;
        }
      }
    }
    console.log(`clean ${format}: ${read}/${frames} read, ${wrong} wrong`);
    out.push({ format, frames, read, wrong });
  }
  return out;
}

async function main() {
  const browser = await chromium.launch();
  const pages = {
    page: await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 }),
    decoder: await browser.newPage(),
  };
  const formats = TARGET === "all" ? FORMATS : [TARGET as Format];
  const results = [];
  for (const format of formats) results.push(await runFormat(pages, format));
  const negatives = TARGET === "all" ? await runNegatives(pages) : undefined;
  const clean = TARGET === "all" ? await runClean(pages) : undefined;
  await browser.close();
  if (process.env.OUT_JSON) {
    writeFileSync(process.env.OUT_JSON, JSON.stringify({ seed: SEED, width: W, height: H, node: process.version, formats: results, negatives, clean }, null, 2) + "\n");
  }
}

main();
