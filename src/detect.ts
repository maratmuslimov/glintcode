import { readCapsule } from "./capsule-read";
import { analyze, type ImageInput, type Point } from "./image";
import { radialPrecheck, readRadial, type RadialFormat } from "./radial";
import type { Detection, DetectOptions, Format, Read } from "./types";

/*
 * One reader for every format. A frame is analysed once (luminance, both threshold polarities,
 * components); every round component is then offered to each enabled format's reader:
 *
 * - capsule: the disc is light inside a dark capsule; the start bar gives the rotation, both bars
 *   and the disc fix a homography for the whole length.
 * - round formats: the lens is a solid disc; fixed points (sync ring, fixed rays, start dots)
 *   give the rotation, then rings are read against per-sector ink and paper levels.
 *
 * Every read ends in Reed–Solomon with one parity byte kept spare, so a candidate that isn't a code
 * (or is misread) is rejected instead of producing a wrong value.
 */

const RADIAL: RadialFormat[] = ["orbit", "constellation", "halo", "contour"];

/** Find and read every code in an image. */
export function detect(image: ImageInput, options: DetectOptions = {}): Detection[] {
  const formats = new Set<Format>(options.formats ?? ["capsule", ...RADIAL]);
  const maxResults = options.maxResults ?? 4;
  const { k, passes } = analyze(image, options.maxDimension ?? 1280, options.polarity ?? "both");
  const results: Detection[] = [];
  for (const P of passes) {
    for (const e of P.candidates) {
      if (results.some((r) => Math.hypot(r.center[0] / k - e.cx, r.center[1] / k - e.cy) < e.a)) continue;
      let hit: Read | null = formats.has("capsule") ? readCapsule(P, e) : null;
      if (!hit && RADIAL.some((f) => formats.has(f)) && radialPrecheck(P, e)) {
        for (const f of RADIAL) if (!hit && formats.has(f)) hit = readRadial(f, P, e);
      }
      if (!hit) continue;
      const s = (p: Point): Point => [p[0] * k, p[1] * k];
      results.push({
        ...hit,
        corners: hit.corners.map(s) as Detection["corners"],
        center: s(hit.center),
        size: hit.size * k,
        inverted: P.inverted,
      });
      if (results.length >= maxResults) return results;
    }
  }
  return results;
}
