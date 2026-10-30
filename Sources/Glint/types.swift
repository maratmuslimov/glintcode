public enum GlintFormat: String, CaseIterable, Sendable {
  case capsule, orbit, halo, constellation, contour
}

public enum GlintPolarity: Sendable {
  /** Marks lighter than around them. */
  case normal
  /** Marks darker than around them. */
  case inverted
  case both
}

public struct GlintPoint: Equatable, Sendable {
  public var x: Double
  public var y: Double

  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }
}

public struct GlintDetectOptions: Sendable {
  /** Formats to look for. Default: all. */
  public var formats: Set<GlintFormat>
  public var polarity: GlintPolarity
  /** Long side the frame is downscaled to before reading. Default 1280. */
  public var maxDimension: Int
  /** Stop after this many codes. Default 4. */
  public var maxResults: Int

  public init(formats: Set<GlintFormat> = Set(GlintFormat.allCases), polarity: GlintPolarity = .both, maxDimension: Int = 1280, maxResults: Int = 4) {
    self.formats = formats
    self.polarity = polarity
    self.maxDimension = maxDimension
    self.maxResults = maxResults
  }
}

public struct GlintDetection: Equatable, Sendable {
  public var format: GlintFormat
  public var payload: [UInt8]
  /** The payload as a number (0..2^48-1). */
  public var value: UInt64
  /** Corners of the code area in image pixels (label excluded): top-left, top-right, bottom-right, bottom-left. */
  public var corners: [GlintPoint]
  /** Centre of the finder in image pixels. */
  public var center: GlintPoint
  /** Capsule: pill height; round formats: diameter. In image pixels. */
  public var size: Double
  /** True when the marks were darker than their surroundings (e.g. black ink on paper). */
  public var inverted: Bool
  /** Bytes fixed by error correction (0 = clean read). */
  public var corrected: Int
}

/** What a format's reader returns for one candidate, in working-frame pixels. */
struct Read {
  var format: GlintFormat
  var payload: [UInt8]
  var value: UInt64
  var corrected: Int
  var corners: [Point]
  var center: Point
  var size: Double
}
