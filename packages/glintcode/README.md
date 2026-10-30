# glintcode

Glint is five visual codes that carry the same 48-bit payload, with one generator and one camera reader
for all of them. TypeScript, no dependencies, about 13 KB gzipped. Demo and docs: https://glint.codes

| Format | Look |
|---|---|
| **capsule** (Glint Capsule) | A pill: round finder, four rows of dots and dashes, and room for human-readable text inside. |
| **orbit** | A solid lens with four rings of arcs; the inner ring is the same on every code. |
| **constellation** | The orbit layout drawn as dots. |
| **halo** | 52 rays of four lengths around the lens; the first four rays are fixed. |
| **contour** | Four wavy rings like a topographic map; a bulge out is 1, in is 0. |

## Shared format

- Payload: 6 bytes (a number below 2^48, or any 6 bytes). Meant to be an ID that a server resolves,
  so what a printed code opens can change after printing.
- Reed–Solomon over GF(256), 6 data + 6 parity bytes. The reader corrects up to 2 bad bytes, or up to 4
  when it knows which cells were unsure (erasures). Every format gets a plain attempt first, and one
  parity byte always stays spare. This makes wrong reads rare, not impossible: with 4 erasures only 16 bits
  of checking remain.
- Each format XORs the codeword with its own whitening sequence: the pattern stays lively for any
  payload, and a code can never decode as another format (or a future version).
- Bytes sit next to each other on the code (capsule: two columns per byte; round formats: cells
  sorted by angle), so a smudge or a finger costs one or two bytes.

## Capsule

```
 ╭────────────────────────────────────────────────────────────╮
 │  ◯   │  ─── ·  ── · ─────  ·  ──  · ─── ·   │  Maison      │
 │ (1)  │  · ── ─ ·  ── ·  ─── ─ ·  ── ·  ─ ·  │  Table 12    │
 │      │  ── · ─── ·  ─ ·  ── · ───  · ── ─   │              │
 │      │  · ─ ·  ── ─── · ─ ·  ── ·  ─── ·    │              │
 ╰────────────────────────────────────────────────────────────╯
       (2)              (3) data                (4)   (5) label
```

1. **Disc**: the finder. Its ellipse gives the reader centre, scale and tilt. A logo fits inside.
2. **Start bar**: gives the rotation; with the end bar, four points that undo perspective.
3. **Data**: 4 rows × 24 columns = 96 cells. A run of set cells in a row is drawn as one dash.
4. **End bar**: separates data from the label. Found by walking along the capsule's axis.
5. **Label**: free text. The reader never looks there.

Geometry in `src/capsule-format.ts` (code units, pill height 2): the disc's ring between radius 0.42
and 0.62 stays clear, marks are 0.2 wide on a 0.3 pitch.

## Round formats

All four have a solid lens in the middle (the finder) with a glyph or logo cut out of it, a paper gap
around it, and data on rings out to radius ~1. Geometry in `src/radial.ts`.

- **orbit**: sync ring of 24 cells at r 0.6 (fixed pattern), data rings of 28/32/36 cells at 0.7/0.8/0.9.
  A run of set cells is one arc.
- **constellation**: the same idea as dots, rings at 0.55 (sync), 0.65, 0.75, 0.85.
- **halo**: 52 rays starting at r 0.53, lengths 0/0.12/0.24/0.38 (2 bits per ray, Gray-coded). The reader
  traces each ray and uses end ÷ start, which doesn't depend on scale or perspective.
- **contour**: rings at 0.57/0.69/0.81/0.93 with 20/24/28/32 cells, ±0.03 bulges. The inner ring breaks at
  two cells: that's the start mark. The reader measures each line's position and removes the slow drift
  (scale, perspective) before deciding bulge or dip. It needs about twice the size of the other formats.

## Generate

```ts
import { codeSvg, capsuleLayout } from "glintcode";

codeSvg("capsule", 123456789, { label: { title: "Maison", subtitle: "Table 12" } });
codeSvg("capsule", 123456789, { pill: "#ffffff", marks: "#111111" });          // light capsule on a dark card
codeSvg("capsule", 123456789, { style: "bare", caption: "Scan with the app" }); // marks straight on paper
codeSvg("orbit", 123456789, { rings: ["#2f37a8", "#3a46cc", "#4451e0", "#4b58e6"] });
codeSvg("halo", 123456789, { ink: "#ffffff", paper: "#111111" });               // white on black
codeSvg("contour", 123456789, { logo: { href: "/logo.png" }, caption: "Scan me" });
```

Capsule options: `style` (`pill` | `bare`), `pill`, `marks`, `rows` (one colour per row), `disc`, `glyph`,
`logo` (`glyph` | `none` | `{ href }` | `{ svg }`), `label` (string or `{ title, subtitle }`), `caption`,
`text`, `fontFamily`, `measureText` (exact text widths; otherwise estimated and fitted with
`textLength`), `background`, `margin`, `height` (pill height in px).

Round options: `ink`, `paper` (colour of the glyph cut out of the lens), `rings` (per ring; halo: per
length), `lens`, `logo`, `caption`, `background`, `margin`, `size` (diameter in px).

Any colours work as long as the marks contrast with what is around them. `capsuleLayout()` and
`radialModel()` return the geometry as data, for React Native, canvas or print pipelines.

## Read

```ts
import { detect, detectImage, scanVideo } from "glintcode";

detect({ data: imageData.data, width, height });                 // RGBA or 8-bit luminance → Detection[]
detect(frame, { formats: ["capsule", "orbit"] });                 // only some formats
detectImage(imgOrBitmap);                                         // a photo: tries several working sizes
const scanner = scanVideo(videoElement, { onDetect: (d) => open(d.value) });
```

A `Detection` has `format`, `value` (number), `payload` (bytes), `corners` and `center` in image pixels,
`size` (capsule: pill height; round: diameter), `inverted` (marks darker than around them) and
`corrected` (bytes fixed by error correction).

How a frame is read (`src/detect.ts`): luminance → adaptive threshold per 4×4 block (both polarities
from one integral image) → connected components as runs → round components become finder candidates →
each enabled format's reader tries them:

- capsule (`src/capsule-read.ts`): the start bar next to the disc gives the rotation; start bar, end bar
  and disc fix a homography; 96 cells are sampled with per-row thresholds.
- round (`src/radial.ts`): a shared precheck (solid lens, paper gap, quiet zone, ink on the data rings)
  drops most candidates cheaply; fixed points give the rotation (the middle of the matching range, and
  every distinct rotation that fits); cells are read against per-sector ink and paper levels; if that
  fails, small scale and perspective corrections are tried.

## Tests

```
pnpm test                    # Reed–Solomon, codewords, conformance frames from ../../spec
pnpm stress 300 11 all       # Chromium renders with 3D tilt, blur, noise and JPEG, frames with no code, clean renders
pnpm vectors                 # regenerate spec/ (only when the format changes)
```

The current numbers are at https://glint.codes/#tests.

## Limits

- Stock phone cameras don't read these codes: they need this reader in an app, a website or an
  App Clip. Where people scan with the stock camera, pair a code with NFC or a small QR code.
- Small codes: below ~32 px of capsule height or ~60 px of round diameter in the working frame, marks are
  only a few pixels wide. For small codes in large frames, read at a higher working size (`maxDimension`).
  Contour needs about 150 px.
- Strong tilt (45° and more) reads less often in a single frame; in a live camera feed a few frames are
  usually enough.
