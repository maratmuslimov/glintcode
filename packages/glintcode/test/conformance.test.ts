// The frames in spec/frames must keep reading as recorded, here and in the Swift and Kotlin readers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { detect } from "../src/detect";
import { encodeBits } from "../src/codeword";
import { FORMATS, type Format } from "../src/index";

const SPEC = new URL("../../../spec/", import.meta.url).pathname;

/** Decode the filter-0 grayscale PNGs spec/frames is made of. */
function readGray(path: string) {
  const png = readFileSync(path);
  let width = 0, height = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    if (type === "IHDR") {
      width = png.readUInt32BE(at + 8);
      height = png.readUInt32BE(at + 12);
    }
    if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + len));
    at += len + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) data.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  return { data, width, height };
}

test("codewords match spec/vectors.json", () => {
  const { seeds, vectors } = JSON.parse(readFileSync(`${SPEC}vectors.json`, "utf8"));
  for (const v of vectors) {
    for (const f of FORMATS) assert.equal(encodeBits(v.value, seeds[f as Format]).map((b) => (b ? "1" : "0")).join(""), v.bits[f]);
  }
});

test("frames read exactly as recorded", () => {
  const manifest = JSON.parse(readFileSync(`${SPEC}frames/manifest.json`, "utf8"));
  for (const m of manifest) {
    const found = detect(readGray(`${SPEC}frames/${m.file}`)).map((d) => ({ format: d.format, value: d.value, corrected: d.corrected }));
    assert.deepEqual(found, m.read.map((r: { format: string; value: number; corrected: number }) => ({ format: r.format, value: r.value, corrected: r.corrected })), m.file);
  }
});
