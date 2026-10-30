# Glint

Scannable codes that look designed. Five styles share one 48-bit payload, one generator and one camera
reader, with no dependencies. Live generator, camera reader and test results: https://glint.codes

| Style | Look |
|---|---|
| Glint Capsule | A pill with four rows of marks and room for your own text |
| Orbit | Rings of arcs around a solid lens |
| Constellation | The Orbit layout drawn as dots |
| Halo | 52 rays in four lengths |
| Contour | Wavy rings like a topographic map |

## Repository

| Path | What |
|---|---|
| `packages/glintcode` | Generator and reader in TypeScript |
| `Package.swift`, `Sources/Glint` | Reader in Swift, with an AVFoundation helper |
| `kotlin/` | Reader in Kotlin, with a CameraX analyzer |
| `spec/` | Format contract and conformance data every reader must pass |
| `site/` | glint.codes |

## Quick start

```ts
import { codeSvg, scanVideo } from "glintcode";

const svg = codeSvg("orbit", 123456789);
scanVideo(video, { onDetect: (d) => console.log(d.format, d.value) });
```

Swift and Kotlin setup is in the [docs](https://glint.codes/docs/).

## Limits

Stock phone cameras don't read Glint: it needs your app, your site or an App Clip. A code holds 6 bytes,
meant as an ID your server looks up. Where people scan with the stock camera, use a QR code.

## Development

```
pnpm install
pnpm test
pnpm --filter glint-site dev
swift test
cd kotlin && ./gradlew test
```

## Licence

MIT
