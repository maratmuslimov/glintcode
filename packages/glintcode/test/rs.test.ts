import assert from "node:assert/strict";
import test from "node:test";
import { rsDecode, rsEncode } from "../src/rs";

let seed = 12345;
const rand = (n: number) => {
  seed = (seed * 1103515245 + 12345) >>> 0;
  return (seed >>> 8) % n;
};
const pick = (n: number, k: number) => {
  const s = new Set<number>();
  while (s.size < k) s.add(rand(n));
  return [...s];
};

test("corrects up to nsym/2 errors", () => {
  for (let trial = 0; trial < 3000; trial++) {
    const data = Array.from({ length: 6 }, () => rand(256));
    const cw = rsEncode(data, 6);
    const bad = cw.slice();
    const k = rand(4);
    for (const p of pick(12, k)) bad[p] ^= 1 + rand(255);
    const out = rsDecode(bad, 6);
    assert.ok(out, `trial ${trial}`);
    assert.deepEqual(out.data, data);
    assert.equal(out.corrected, k);
  }
});

test("corrects erasures and errors together (2e + s <= nsym)", () => {
  for (let trial = 0; trial < 3000; trial++) {
    const data = Array.from({ length: 6 }, () => rand(256));
    const cw = rsEncode(data, 6);
    const s = rand(7);
    const e = rand(Math.floor((6 - s) / 2) + 1);
    const pos = pick(12, s + e);
    const bad = cw.slice();
    for (const p of pos) bad[p] ^= 1 + rand(255);
    const out = rsDecode(bad, 6, pos.slice(0, s));
    assert.ok(out, `trial ${trial} s=${s} e=${e}`);
    assert.deepEqual(out.data, data);
  }
});

test("rejects reads beyond the budget instead of miscorrecting often", () => {
  let accepted = 0;
  const n = 20000;
  for (let trial = 0; trial < n; trial++) {
    const word = Array.from({ length: 12 }, () => rand(256));
    if (rsDecode(word, 6, [], 4)) accepted++;
  }
  // A random word is within 2 errors of a codeword with probability ~1.5e-8.
  assert.equal(accepted, 0);
});
