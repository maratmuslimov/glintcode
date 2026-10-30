// Writes the conformance data every reader must pass: spec/vectors.json and spec/frames/.
//   pnpm vectors
// vectors.json holds codewords and cell models; frames are small rendered photos with their expected reads.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import { encodeCells } from "../src/capsule-format";
import { encodeBits, payloadFromNumber } from "../src/codeword";
import { capsuleLayout } from "../src/capsule-render";
import { detect } from "../src/detect";
import { codeSvg, FORMATS, radialModel, type Format } from "../src/index";
import { rsEncode } from "../src/rs";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { chromium } = require("playwright") as { chromium: any };

const SPEC = new URL("../../../spec/", import.meta.url).pathname;
const SEEDS: Record<Format, number> = { capsule: 0x5ca9c0de, orbit: 0x0b17c0de, constellation: 0xc0175e11, halo: 0x4a10c0de, contour: 0xc047c0de };
const W = 480;
const H = 360;

let seed = 2026;
const rnd = () => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 4294967296;
};
const between = (a: number, b: number) => a + (b - a) * rnd();
const hex = (b: ArrayLike<number>) => Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");

function crc32(buf: Uint8Array) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

/** 8-bit grayscale PNG, every row with filter 0, so a test can decode it in a few lines. */
function grayPng(pixels: Uint8Array, width: number, height: number) {
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array(0))]);
}

const VALUES = [0, 1, 255, 65536, 123456789, 987654321012, 2 ** 48 - 1];
for (let i = 0; i < 25; i++) VALUES.push(Math.floor(rnd() * 2 ** 48));

function vectors() {
  const out = VALUES.map((value) => ({
    value,
    payload: hex(payloadFromNumber(value)),
    codeword: hex(rsEncode(payloadFromNumber(value), 6)),
    bits: Object.fromEntries(FORMATS.map((f) => [f, encodeBits(value, SEEDS[f]).map((b) => (b ? "1" : "0")).join("")])),
    capsuleCells: encodeCells(value).map((row) => row.map((b) => (b ? "1" : "0")).join("")),
    capsuleMarks: capsuleLayout(value).marks.length,
    orbitRings: (radialModel("orbit", value) as { rings: { bits: boolean[] }[] }).rings.map((r) => r.bits.map((b) => (b ? "1" : "0")).join("")),
    constellationRings: (radialModel("constellation", value) as { rings: { bits: boolean[] }[] }).rings.map((r) => r.bits.map((b) => (b ? "1" : "0")).join("")),
    haloLevels: (radialModel("halo", value) as { levels: number[] }).levels.join(""),
    contourRings: (radialModel("contour", value) as { rings: { bits: boolean[] }[] }).rings.map((r) => r.bits.map((b) => (b ? "1" : "0")).join("")),
  }));
  writeFileSync(`${SPEC}vectors.json`, JSON.stringify({ seeds: SEEDS, vectors: out }, null, 1) + "\n");
}

const LOOKS: Record<Format, object[]> = {
  capsule: [{}, { pill: "#ffffff", marks: "#111111" }, { style: "bare" }, { pill: "#4b58e6", label: "Maison" }],
  orbit: [{}, { ink: "#ffffff", paper: "#151515" }, { lens: "#16171c", rings: ["#2f37a8", "#4b58e6", "#6877ff", "#8a7dff"] }, {}],
  constellation: [{}, { ink: "#ffffff", paper: "#151515" }, {}, { caption: "Scan me" }],
  halo: [{}, { ink: "#ffffff", paper: "#151515" }, {}, {}],
  contour: [{}, { ink: "#ffffff", paper: "#151515" }, {}, {}],
};

async function frames() {
  const dir = `${SPEC}frames/`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const manifest: object[] = [];
  const add = async (name: string, format: Format | "none", value: number | undefined, html: string) => {
    await page.setContent(html);
    const png = await page.screenshot({ type: "png" });
    const decoded = await page.evaluate(`(async () => {
      const img = new Image(); img.src = "data:image/png;base64,${png.toString("base64")}"; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data; let b = "";
      for (let k = 0; k < d.length; k += 0x8000) b += String.fromCharCode(...d.subarray(k, k + 0x8000));
      return btoa(b); })()`);
    const rgba = new Uint8Array(Buffer.from(decoded as string, "base64"));
    const gray = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < W * H; i++, j += 4) gray[i] = Math.max(0, Math.min(255, ((rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8) + Math.round((rnd() + rnd() - 1) * 6)));
    writeFileSync(`${dir}${name}.png`, grayPng(gray, W, H));
    const read = detect({ data: gray, width: W, height: H }).map((d) => ({ format: d.format, value: d.value, corrected: d.corrected, center: d.center.map((v) => +v.toFixed(2)), size: +d.size.toFixed(2), inverted: d.inverted }));
    manifest.push({ file: `${name}.png`, width: W, height: H, format, value, read });
  };
  for (const format of FORMATS) {
    for (let i = 0; i < 4; i++) {
      const value = Math.floor(rnd() * 2 ** 48);
      const opts = LOOKS[format][i] as { paper?: string; pill?: string };
      const dark = opts.paper === "#151515" || opts.pill === "#ffffff";
      const size = format === "capsule" ? Math.round(between(44, 64)) : Math.round(between(150, 230));
      const svg = format === "capsule" ? codeSvg("capsule", value, { ...opts, height: size }) : codeSvg(format, value, { ...opts, size });
      await add(`${format}-${i}`, format, value, `<!doctype html><body style="margin:0;width:${W}px;height:${H}px;background:${dark ? "#151515" : "#f6f6f2"};overflow:hidden;position:relative">
        <div style="position:absolute;left:50%;top:50%;perspective:900px"><div style="transform:translate(-50%,-50%) rotateZ(${between(0, 360)}deg) rotateX(${between(-30, 30)}deg) rotateY(${between(-25, 25)}deg);filter:blur(${between(0, 0.7)}px);line-height:0">${svg}</div></div></body>`);
    }
  }
  await add("none-0", "none", undefined, `<!doctype html><body style="margin:0;background:#fff;font:600 30px system-ui;color:#333;padding:40px">Lorem ipsum o o o ● ◯ ◎ 0 O Q</body>`);
  await browser.close();
  writeFileSync(`${dir}manifest.json`, JSON.stringify(manifest, null, 1) + "\n");
  const missed = manifest.filter((m) => { const e = m as { value?: number; read: { value: number }[] }; return e.value !== undefined && !e.read.some((r) => r.value === e.value); }).length;
  console.log(`${manifest.length} frames, ${missed} of them unread by the TypeScript reader`);
}

vectors();
await frames();
