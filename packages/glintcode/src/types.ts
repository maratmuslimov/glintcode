import type { Payload } from "./codeword";
import type { Point } from "./image";

export type Format = "capsule" | "orbit" | "halo" | "constellation" | "contour";

export interface DetectOptions {
  /** Formats to look for. Default: all. */
  formats?: Format[];
  /** "both" (default), "normal" (marks lighter than around them) or "inverted" (marks darker). */
  polarity?: "both" | "normal" | "inverted";
  /** Long side the frame is downscaled to before reading. Default 1280. */
  maxDimension?: number;
  /** Stop after this many codes. Default 4. */
  maxResults?: number;
}

export interface Detection {
  format: Format;
  payload: Payload;
  /** The payload as a number (0..2^48-1). */
  value: number;
  /** Corners of the code area in image pixels (label excluded): top-left, top-right, bottom-right, bottom-left. */
  corners: [Point, Point, Point, Point];
  /** Centre of the finder in image pixels. */
  center: Point;
  /** Capsule: pill height; round formats: diameter. In image pixels. */
  size: number;
  /** True when the marks were darker than their surroundings (e.g. black ink on paper). */
  inverted: boolean;
  /** Bytes fixed by error correction (0 = clean read). */
  corrected: number;
}

/** What a format's reader returns for one candidate, in working-frame pixels. */
export type Read = Omit<Detection, "inverted">;
