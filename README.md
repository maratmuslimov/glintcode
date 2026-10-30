# Capsule

A visual code shaped like a pill: a round finder, four rows of dots and dashes, and room for
human-readable text inside the same shape. One TypeScript package with no dependencies: a generator
(SVG, or geometry for any renderer) and a camera reader. About 9 KB gzipped.

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

## Format

- Payload: 6 bytes (a number below 2^48, or any 6 bytes). Meant to be an ID that a server resolves,
  so what a printed code opens can change after printing.
- Reed–Solomon over GF(256), 6 data + 6 parity bytes. The reader corrects up to 2 bad bytes, or up to 4
  when it knows which cells were unsure (erasures), and always keeps one parity byte spare to reject
  a misread instead of correcting it into another payload.
- Byte *b* fills columns 2b and 2b+1 top to bottom, so a smudge across a few columns costs one or two bytes.
- Cells are XORed with a fixed whitening sequence. A future format version uses another sequence,
  so its codes can never decode as this version.
- Geometry (code units, pill height 2): see `src/format.ts`. The disc's ring between radius 0.42 and
  0.62 must stay clear; marks are 0.2 wide on a 0.3 pitch.

## Generate

```ts
import { capsuleSvg, capsuleLayout } from "capsule-code";

capsuleSvg(123456789, { label: { title: "Maison", subtitle: "Table 12" } });
capsuleSvg(123456789, { pill: "#ffffff", marks: "#111111" });          // light capsule on a dark card
capsuleSvg(123456789, { style: "bare", caption: "Scan with the app" }); // marks straight on paper
capsuleSvg(123456789, { rows: ["#fff", "#f6d7bd", "#efae84", "#e8875a"], logo: { href: "/logo.png" } });
```

Options: `style` (`pill` | `bare`), `pill`, `marks`, `rows` (one colour per row), `disc`, `glyph`,
`logo` (`glyph` | `none` | `{ href }` | `{ svg }`), `label` (string or `{ title, subtitle }`), `caption`,
`text`, `fontFamily`, `measureText` (exact text widths; otherwise estimated and fitted with
`textLength`), `background`, `margin`, `height` (px, sets width/height).

Any colours work as long as the marks contrast with the capsule (and the capsule with what is around it).
`capsuleLayout()` returns the same geometry as data, for React Native, canvas or print pipelines.

## Read

```ts
import { detect, detectImage, scanVideo } from "capsule-code";

detect({ data: imageData.data, width, height });   // RGBA or 8-bit luminance → Detection[]
detectImage(imgOrBitmap);                          // a photo: tries several working sizes
const scanner = scanVideo(videoElement, { onDetect: (d) => open(d.value) });
```

A `Detection` has `value` (number), `payload` (bytes), `corners` and `center` in image pixels,
`size` (pill height in px), `inverted` (light capsule) and `corrected` (bytes fixed by error correction).

How it reads a frame (`src/detect.ts`): luminance → adaptive threshold per 4×4 block (both polarities
from one integral image) → connected components as runs → round components become disc candidates
→ the start bar next to a disc gives the rotation → start bar, end bar and disc fix a homography →
96 cells are sampled with per-row thresholds → Reed–Solomon.

## Tests

```
pnpm test        # Reed–Solomon, format round trips, software-rendered reads under perspective
pnpm stress 600  # Chromium renders real SVGs with 3D tilt, blur, noise, JPEG, clutter; reads each frame once
pnpm demo        # http://localhost:8000/demo/camera.html: live camera reader (localhost or https)
```

Stress results (600 frames 960×720, single frame, no accumulation; seed 7):

| Condition | Read |
|---|---|
| all (600 frames) | 92.3% |
| blur 0.8-1.6px (158 frames) | 84.8% |
| blur <0.8px (138 frames) | 96.4% |
| blur none (304 frames) | 94.4% |
| height 22-31px (37 frames) | 48.6% |
| height 32-47px (67 frames) | 83.6% |
| height 48-79px (129 frames) | 98.4% |
| height 80-160px (367 frames) | 96.2% |
| style bare (88 frames) | 89.8% |
| style brand (121 frames) | 89.3% |
| style inverted (111 frames) | 91.9% |
| style pill+label (101 frames) | 93.1% |
| style pill (90 frames) | 97.8% |
| style rows (89 frames) | 93.3% |
| tilt 0-19° (85 frames) | 95.3% |
| tilt 20-34° (221 frames) | 95.9% |
| tilt 35-44° (196 frames) | 90.3% |
| tilt 45-55° (98 frames) | 85.7% |

Wrong payloads: 0. Time per frame (both polarities, one server core, Node): median 23.6 ms, p90 34.6 ms.

## Limits

- Phone cameras don't read Capsule by themselves: it needs this reader in an app, a website or an App Clip.
  Where people scan with the stock camera, pair it with NFC or a small QR code.
- Below ~32 px of pill height in the working frame the marks are under 3 px wide and reads get unreliable.
  For small codes in large frames, read at a higher working size (`maxDimension`).
- Tilt beyond ~45° reads less often in a single frame; in a live camera feed a few frames are usually enough.
