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
 * (or is misread) is rejected instead of producing a wrong value. Erasure decoding checks far fewer
 * bits than plain decoding (16 instead of about 32 and up), and a reader makes many attempts per
 * candidate, so every format gets a plain attempt before any format may use erasures.
 */

private let RADIAL: [GlintFormat] = [.orbit, .constellation, .halo, .contour]

/** Reader with its own buffers, so a camera loop doesn't allocate every frame. Use from one thread at a time. */
public final class GlintReader {
  private let buffers = Buffers()

  public init() {}

  /** Find and read every code in an 8-bit luminance image. */
  public func detect(gray: [UInt8], width: Int, height: Int, options: GlintDetectOptions = GlintDetectOptions()) -> [GlintDetection] {
    if width < 0 || height < 0 || gray.count < width * height { return [] }
    return gray.withUnsafeBufferPointer { p in
      guard let data = p.baseAddress else { return [] }
      return detect(gray: data, width: width, height: height, bytesPerRow: width, options: options)
    }
  }

  /** Find and read every code in an RGBA image (4 bytes per pixel). */
  public func detect(rgba: [UInt8], width: Int, height: Int, options: GlintDetectOptions = GlintDetectOptions()) -> [GlintDetection] {
    if width < 0 || height < 0 || rgba.count < width * height * 4 { return [] }
    return rgba.withUnsafeBufferPointer { p in
      guard let data = p.baseAddress else { return [] }
      return detect(rgba: data, width: width, height: height, bytesPerRow: width * 4, options: options)
    }
  }

  /** Luminance rows `bytesPerRow` apart, such as a camera's luma plane. */
  public func detect(gray: UnsafePointer<UInt8>, width: Int, height: Int, bytesPerRow: Int, options: GlintDetectOptions = GlintDetectOptions()) -> [GlintDetection] {
    detect(ImageInput(data: gray, width: width, height: height, rowBytes: bytesPerRow, layout: .gray), options)
  }

  public func detect(rgba: UnsafePointer<UInt8>, width: Int, height: Int, bytesPerRow: Int, options: GlintDetectOptions = GlintDetectOptions()) -> [GlintDetection] {
    detect(ImageInput(data: rgba, width: width, height: height, rowBytes: bytesPerRow, layout: .rgba), options)
  }

  public func detect(bgra: UnsafePointer<UInt8>, width: Int, height: Int, bytesPerRow: Int, options: GlintDetectOptions = GlintDetectOptions()) -> [GlintDetection] {
    detect(ImageInput(data: bgra, width: width, height: height, rowBytes: bytesPerRow, layout: .bgra), options)
  }

  func detect(_ image: ImageInput, _ options: GlintDetectOptions) -> [GlintDetection] {
    let formats = options.formats
    guard let (k, _, _, passes) = analyze(image, options.maxDimension, options.polarity, buffers) else { return [] }
    let scale = Double(k)
    var results: [GlintDetection] = []
    for P in passes {
      for e in P.candidates {
        if results.contains(where: { jsHypot($0.center.x / scale - e.cx, $0.center.y / scale - e.cy) < e.a }) { continue }
        let round = RADIAL.contains(where: formats.contains) && radialPrecheck(P, e)
        var hit: Read? = nil
        for erasures in [false, true] {
          if hit == nil, formats.contains(.capsule) { hit = readCapsule(P, e, erasures) }
          if round { for f in RADIAL where hit == nil && formats.contains(f) { hit = readRadial(f, P, e, erasures) } }
        }
        guard let hit else { continue }
        let s = { (p: Point) in GlintPoint(x: p.0 * scale, y: p.1 * scale) }
        results.append(
          GlintDetection(
            format: hit.format,
            payload: hit.payload,
            value: hit.value,
            corners: hit.corners.map(s),
            center: s(hit.center),
            size: hit.size * scale,
            inverted: P.inverted,
            corrected: hit.corrected
          )
        )
        if results.count >= options.maxResults { return results }
      }
    }
    return results
  }
}

public enum Glint {
  /** Find and read every code in an 8-bit luminance image. */
  public static func detect(gray: [UInt8], width: Int, height: Int, options: GlintDetectOptions = GlintDetectOptions()) -> [GlintDetection] {
    GlintReader().detect(gray: gray, width: width, height: height, options: options)
  }

  /** Find and read every code in an RGBA image (4 bytes per pixel). */
  public static func detect(rgba: [UInt8], width: Int, height: Int, options: GlintDetectOptions = GlintDetectOptions()) -> [GlintDetection] {
    GlintReader().detect(rgba: rgba, width: width, height: height, options: options)
  }
}
