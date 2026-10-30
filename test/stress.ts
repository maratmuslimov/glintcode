// Stress test on real renders: Chromium draws capsuleSvg() with CSS 3D tilt, blur and clutter,
// screenshots it as JPEG, then noise and uneven light are added and the reader runs in Node.
//   pnpm stress [cases=400] [seed=1]
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { detect } from "../src/detect";
import { capsuleLayout, capsuleSvg, type CapsuleOptions } from "../src/render";

const require = createRequire(import.meta.url);
// Playwright comes with the machine (pre-installed browser), not with this package.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { chromium } = require("playwright") as { chromium: any };

const CASES = Number(process.argv[2] ?? 400);
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

const STYLES: { name: string; opts: CapsuleOptions; bg: string }[] = [
  { name: "pill", opts: {}, bg: "#f4f4f2" },
  { name: "pill+label", opts: { label: { title: "Maison", subtitle: "Стол 12 · меню" } }, bg: "#ffffff" },
  { name: "inverted", opts: { pill: "#ffffff", marks: "#111111" }, bg: "#151515" },
  { name: "bare", opts: { style: "bare", label: "Café Sol" }, bg: "#ffffff" },
  { name: "brand", opts: { pill: "#4b58e6", label: "loyalty card" }, bg: "#eef0ff" },
  { name: "rows", opts: { pill: "#1d1d1f", rows: ["#ffffff", "#f1c9a8", "#e59a6b", "#ffb36b"], label: "Ticket 20931" }, bg: "#faf7f2" },
];

const CLUTTER = `
  <div style="position:absolute;left:20px;top:16px;font:600 28px system-ui;color:#333">Наш сезонный ужин · Season dinner</div>
  <div style="position:absolute;left:24px;bottom:20px;font:16px Georgia;color:#555;width:600px">Lorem ipsum o o o • • • ● ● ◯ ◎ 0 O Q — 12:30 · 18:45 · €24</div>
  <div style="position:absolute;right:30px;top:80px;width:70px;height:70px;border-radius:50%;background:#222"></div>
  <div style="position:absolute;right:120px;top:90px;width:40px;height:40px;border-radius:50%;border:8px solid #222"></div>
  <div style="position:absolute;left:40px;top:120px;width:160px;height:36px;border-radius:18px;background:#222"></div>
`;

interface Case {
  style: (typeof STYLES)[number];
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

function makeCase(): Case {
  return {
    style: pick(STYLES),
    value: Math.floor(rnd() * 2 ** 48),
    height: Math.round(between(22, 160)),
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

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const decoder = await browser.newPage();

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
    const c = makeCase();
    // Keep the whole code in frame at any rotation: its length stays under 90% of the short side.
    const vb = capsuleLayout(c.value, c.style.opts).viewBox;
    c.height = Math.min(c.height, Math.floor((0.9 * Math.min(W, H) * 2) / vb.width));
    const svg = capsuleSvg(c.value, { ...c.style.opts, height: c.height });
    await page.setContent(`<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;background:${c.style.bg};overflow:hidden;position:relative">
      ${CLUTTER}
      <div style="position:absolute;left:${c.x * W}px;top:${c.y * H}px;perspective:${between(650, 1600)}px">
        <div style="transform:translate(-50%,-50%) rotateZ(${c.rz}deg) rotateX(${c.rx}deg) rotateY(${c.ry}deg);filter:blur(${c.blur}px);line-height:0">${svg}</div>
      </div></body></html>`);
    const jpeg = await page.screenshot({ type: "jpeg", quality: c.quality });
    // Noise and a light gradient, added in the page so the result is plain RGBA.
    const b64 = (await decoder.evaluate(
      `(${NOISE})(${JSON.stringify({ src: `data:image/jpeg;base64,${jpeg.toString("base64")}`, noise: c.noise, light: c.light, seed: i + 1 })})`,
    )) as string;
    const data = new Uint8Array(Buffer.from(b64, "base64"));

    if (process.env.DUMP && Number(process.env.ONLY) === i) require("node:fs").writeFileSync(process.env.DUMP, jpeg);
    const t0 = performance.now();
    const found = detect({ data, width: W, height: H });
    times.push(performance.now() - t0);

    const ok = found.some((f) => f.value === c.value);
    if (found.some((f) => f.value !== c.value)) wrong++;
    const tilt = Math.max(Math.abs(c.rx), Math.abs(c.ry));
    bump("all", ok);
    bump(`style ${c.style.name}`, ok);
    bump(`height ${c.height < 32 ? "22-31" : c.height < 48 ? "32-47" : c.height < 80 ? "48-79" : "80-160"}px`, ok);
    bump(`tilt ${tilt < 20 ? "0-19" : tilt < 35 ? "20-34" : tilt < 45 ? "35-44" : "45-55"}°`, ok);
    bump(`blur ${c.blur === 0 ? "none" : c.blur < 0.8 ? "<0.8px" : "0.8-1.6px"}`, ok);
    if (!ok) failures.push(`#${i} ${c.style.name} h=${c.height} rx=${c.rx.toFixed(0)} ry=${c.ry.toFixed(0)} blur=${c.blur.toFixed(1)} noise=${c.noise.toFixed(0)} q=${c.quality}`);
  }
  await browser.close();

  times.sort((a, b) => a - b);
  console.log(`\n${CASES} frames ${W}×${H}`);
  for (const [k, s] of [...stats].sort()) console.log(`${k.padEnd(18)} ${String(s.ok).padStart(4)}/${String(s.n).padEnd(4)} ${((100 * s.ok) / s.n).toFixed(1)}%`);
  console.log(`wrong payloads    ${wrong}`);
  console.log(`time per frame    median ${times[times.length >> 1].toFixed(1)} ms, p90 ${times[Math.floor(times.length * 0.9)].toFixed(1)} ms`);
  if (process.env.VERBOSE) console.log(failures.join("\n"));
}

main();
