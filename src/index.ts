import { capsuleSvg, type CapsuleOptions } from "./capsule-render";
import type { Payload } from "./codeword";
import { radialSvg, type RadialFormat, type RadialOptions } from "./radial";
import type { Format } from "./types";

export { capsuleLayout, capsuleSvg, type CapsuleLayout, type CapsuleOptions, type Label } from "./capsule-render";
export { radialModel, radialSvg, type RadialFormat, type RadialOptions } from "./radial";
export { detect } from "./detect";
export { detectImage, scanVideo, type ScanOptions } from "./browser";
export { DATA_BYTES, payloadFromNumber, payloadToNumber, type Payload } from "./codeword";
export type { Detection, DetectOptions, Format } from "./types";
export type { ImageInput, Point } from "./image";

export const FORMATS: Format[] = ["capsule", "orbit", "halo", "constellation", "contour"];

/** Render any format as SVG. */
export function codeSvg(format: "capsule", payload: Payload | number | bigint, options?: CapsuleOptions): string;
export function codeSvg(format: RadialFormat, payload: Payload | number | bigint, options?: RadialOptions): string;
export function codeSvg(format: Format, payload: Payload | number | bigint, options: CapsuleOptions | RadialOptions = {}): string {
  return format === "capsule" ? capsuleSvg(payload, options as CapsuleOptions) : radialSvg(format, payload, options as RadialOptions);
}
