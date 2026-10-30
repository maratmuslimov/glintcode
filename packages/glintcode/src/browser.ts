import { detect } from "./detect";
import type { Detection, DetectOptions } from "./types";

/** Pixels of anything a canvas can draw (image, bitmap, video frame, canvas), downscaled to `maxDimension`. */
function pixels(source: CanvasImageSource, maxDimension: number, canvas?: HTMLCanvasElement) {
  const any = source as { videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number; width: number; height: number };
  const sw = any.videoWidth || any.naturalWidth || any.width;
  const sh = any.videoHeight || any.naturalHeight || any.height;
  const s = Math.min(1, maxDimension / Math.max(sw, sh));
  const w = Math.round(sw * s);
  const h = Math.round(sh * s);
  const cv = canvas ?? document.createElement("canvas");
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  const g = cv.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(source, 0, 0, w, h);
  return { data: g.getImageData(0, 0, w, h).data, width: w, height: h, scale: 1 / s };
}

const toSource = (d: Detection, scale: number): Detection => ({
  ...d,
  center: [d.center[0] * scale, d.center[1] * scale],
  corners: d.corners.map(([x, y]) => [x * scale, y * scale]) as Detection["corners"],
  size: d.size * scale,
});

/**
 * Read codes from a still image (a photo, an upload). Tries a few working sizes, since a phone
 * photo may hold a small code in 12 MP or a big one that is cheaper to find downscaled.
 * Coordinates in the result are in the source image's pixels.
 */
export function detectImage(source: CanvasImageSource, options: Omit<DetectOptions, "maxDimension"> = {}): Detection[] {
  for (const size of [1280, 2000, 800]) {
    const px = pixels(source, size);
    const found = detect(px, { ...options, maxDimension: size });
    if (found.length) return found.map((d) => toSource(d, px.scale));
  }
  return [];
}

export interface ScanOptions {
  /** Called once per newly seen code (again after `repeatAfter` ms if it stays in view). */
  onDetect: (detection: Detection) => void;
  /** Every frame's result, for drawing overlays. */
  onFrame?: (detections: Detection[], ms: number) => void;
  /** Working size of a frame. Default 960. */
  maxDimension?: number;
  repeatAfter?: number;
}

/**
 * Scan a playing <video> (e.g. from getUserMedia) frame by frame. Polarities alternate between
 * frames, which halves the work per frame; a code in view is found within two frames either way.
 */
export function scanVideo(video: HTMLVideoElement, options: ScanOptions) {
  const canvas = document.createElement("canvas");
  let stopped = false;
  let frame = 0;
  const seen = new Map<number, number>();
  const tick = () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const t0 = performance.now();
      const px = pixels(video, options.maxDimension ?? 960, canvas);
      const found = detect(px, { polarity: frame++ % 2 ? "inverted" : "normal", maxDimension: 4096 }).map((d) => toSource(d, px.scale));
      options.onFrame?.(found, performance.now() - t0);
      const now = Date.now();
      for (const d of found) {
        const last = seen.get(d.value);
        if (last === undefined || now - last > (options.repeatAfter ?? 3000)) options.onDetect(d);
        seen.set(d.value, now);
      }
    }
    if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  };
  tick();
  return { stop: () => void (stopped = true) };
}
