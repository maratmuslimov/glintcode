import assert from "node:assert/strict";
import test from "node:test";
import { detect } from "../src/detect";
import { decodeCells, encodeCells, payloadFromNumber, payloadToNumber } from "../src/capsule-format";
import { pose, render } from "./raster";

test("cells round-trip for many payloads", () => {
  for (let i = 0; i < 2000; i++) {
    const v = Math.floor(Math.random() * 2 ** 48);
    const out = decodeCells(encodeCells(v));
    assert.ok(out);
    assert.equal(payloadToNumber(out.payload), v);
  }
  assert.equal(payloadToNumber(payloadFromNumber(2 ** 48 - 1)), 2 ** 48 - 1);
});

test("reads a frontal code, both polarities and styles", () => {
  for (const style of ["pill", "bare"] as const) {
    for (const inverted of [false, true]) {
      const v = 123456789012;
      const img = render(v, pose({ scale: 30, angle: 0.3, cx: 320, cy: 240 }), 640, 480, {
        style,
        ink: inverted ? 240 : 20,
        paper: inverted ? 25 : 245,
      });
      const found = detect({ data: img, width: 640, height: 480 });
      assert.equal(found.length, 1, `${style} inverted=${inverted}`);
      assert.equal(found[0].value, v);
    }
  }
});

test("reads under perspective", () => {
  const v = 987654321;
  const img = render(v, pose({ scale: 34, angle: -0.6, cx: 320, cy: 240, px: 0.0009, py: -0.0006 }), 640, 480);
  const found = detect({ data: img, width: 640, height: 480 });
  assert.equal(found[0]?.value, v);
});

test("every format's codeword round-trips and never decodes under another format's whitening", async () => {
  const { decodeBits, encodeBits } = await import("../src/codeword");
  const seeds = [0x5ca9c0de, 0x0b17c0de, 0xc0175e11, 0x4a10c0de, 0xc047c0de];
  for (let i = 0; i < 300; i++) {
    const v = Math.floor(Math.random() * 2 ** 48);
    for (const seed of seeds) {
      const bits = encodeBits(v, seed);
      assert.equal(payloadToNumber(decodeBits(bits, seed)!.payload), v);
      for (const other of seeds) if (other !== seed) assert.equal(decodeBits(bits, other), null);
    }
  }
});
