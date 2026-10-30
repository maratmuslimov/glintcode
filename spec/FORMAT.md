# Glint format, version 1

This is the contract every Glint generator and reader follows. The reference implementation is
`packages/glintcode`; `vectors.json` and `frames/` are the conformance data (regenerate with
`pnpm --filter glintcode vectors` only when the format itself changes, which needs a new version).

## Codeword

| | |
|---|---|
| Payload | 6 bytes, big-endian when used as a number (0 to 2^48 − 1) |
| Error correction | Reed–Solomon over GF(256), polynomial 0x11d, first root α⁰, 6 parity bytes |
| Codeword | 12 bytes = 96 bits, most significant bit of byte 0 first |
| Whitening | The codeword is XORed with a format-specific sequence |

Whitening is xorshift32 (shifts 13, 17, 5) started at the format's seed. After each step, the low byte
of the state is the next whitening byte.

| Style | Format id | Seed |
|---|---|---|
| Glint Capsule | `capsule` | `0x5ca9c0de` |
| Orbit | `orbit` | `0x0b17c0de` |
| Constellation | `constellation` | `0xc0175e11` |
| Halo | `halo` | `0x4a10c0de` |
| Contour | `contour` | `0xc047c0de` |

A code never decodes under another format's seed, and a future version gets new seeds.

Decoders must keep one parity byte spare: 2·errors + erasures ≤ 5. With that budget plain decoding
corrects 2 bytes. When it fails, retry with the 2 and then the 4 least confident bytes as erasures.
A candidate that doesn't decode is not a code; there is no partial result.

## Geometry

Capsule units: the pill is 2 tall and its left cap is a circle of radius 1 around the origin.
Round units: the code fits radius 1, angles run clockwise from 12 o'clock, and a point is
(r·sin θ, −r·cos θ).

### Glint Capsule

Disc radius 0.62 (clear ring 0.42–0.62, logo inside 0.42). Start bar at x = 1.05, half length 0.54.
Data: 4 rows at y = ±0.18, ±0.54; 24 columns from x = 1.52 at pitch 0.3; marks 0.2 wide. End bar at
x = 1.52 + 23 × 0.3 + 0.47. A run of set cells in a row is one dash. Bit `b` lands in
column `2·(b>>3) + ((b&7)>>2)`, row `b&3`.

### Orbit

Lens 0.46, glyph 0.34, paper gap at 0.53. Sync ring: r 0.6, 24 cells, fixed
`111101110011100100100100`. Data rings: 28, 32, 36 cells at r 0.7, 0.8, 0.9. Cell `i` of an `n`-cell
ring sits at angle `(i + 0.5) / n · 2π`. Data bits are assigned to cells sorted by angle, then ring.

### Constellation

The Orbit layout as dots of radius 0.04: lens 0.4, glyph 0.29, gap 0.455, sync ring r 0.55, data rings
r 0.65, 0.75, 0.85.

### Halo

Lens 0.4, glyph 0.29, gap 0.455. 52 rays at angles `i / 52 · 2π`, starting at r 0.53, with lengths 0,
0.12, 0.24, 0.38 and stroke 0.05. The first four rays have fixed levels 3, 0, 3, 1. The other 48
carry two bits each, Gray-coded: bits `00 01 10 11` are levels `0 1 3 2`.

### Contour

Lens 0.42, glyph 0.3, gap 0.475. Rings at r 0.57, 0.69, 0.81, 0.93 with 20, 24, 28, 32 cells, amplitude
±0.03, stroke 0.036. The line bulges out for 1 and in for 0, with a cosine transition between
cells. Cells 0 and 3 of the inner ring are breaks in the line. Remaining cells, sorted by angle then
ring, carry the 96 bits; cells past the codeword are pad, 1 at even index.
