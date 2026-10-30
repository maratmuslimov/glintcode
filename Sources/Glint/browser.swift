#if canImport(AVFoundation)
import AVFoundation
import Foundation

/**
 * Scan camera frames from AVCaptureVideoDataOutput (bi-planar YUV or BGRA). Polarities alternate
 * between frames, which halves the work per frame; a code in view is found within two frames either
 * way. Call from one queue at a time.
 *
 * Where scanVideo has a canvas shrink the frame to `maxDimension`, this averages by a whole factor
 * (as `detect` does), so a 1280×720 frame with the default 960 is read at 640×360.
 */
public final class GlintScanner {
  /** Called once per newly seen code (again after `repeatAfter` seconds if it stays in view). */
  public var onDetect: ((GlintDetection) -> Void)?
  /** Every frame's result, for drawing overlays, and its time in milliseconds. */
  public var onFrame: (([GlintDetection], Double) -> Void)?
  /** Working size of a frame. Default 960. */
  public var maxDimension: Int
  public var repeatAfter: TimeInterval
  /** The clock of `repeatAfter`. */
  public var now: () -> Date = Date.init

  private let reader = GlintReader()
  private var frame = 0
  private var seen: [UInt64: Date] = [:]

  public init(maxDimension: Int = 960, repeatAfter: TimeInterval = 3) {
    self.maxDimension = maxDimension
    self.repeatAfter = repeatAfter
  }

  /** Scan the frame of a sample buffer; empty when it holds no image. */
  @discardableResult
  public func scan(_ sampleBuffer: CMSampleBuffer) -> [GlintDetection] {
    guard let image = CMSampleBufferGetImageBuffer(sampleBuffer) else { return [] }
    return scan(image)
  }

  /** Scan one frame; coordinates are in its pixels. Pixel formats other than bi-planar 8-bit YUV and BGRA read as empty. */
  @discardableResult
  public func scan(_ pixelBuffer: CVPixelBuffer) -> [GlintDetection] {
    let t0 = DispatchTime.now().uptimeNanoseconds
    CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
    let options = GlintDetectOptions(polarity: frame % 2 != 0 ? .inverted : .normal, maxDimension: maxDimension)
    let found: [GlintDetection]
    switch CVPixelBufferGetPixelFormatType(pixelBuffer) {
    case kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange:
      guard let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else { return [] }
      found = reader.detect(
        gray: UnsafePointer(base.assumingMemoryBound(to: UInt8.self)),
        width: CVPixelBufferGetWidthOfPlane(pixelBuffer, 0),
        height: CVPixelBufferGetHeightOfPlane(pixelBuffer, 0),
        bytesPerRow: CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0),
        options: options
      )
    case kCVPixelFormatType_32BGRA:
      guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return [] }
      found = reader.detect(
        bgra: UnsafePointer(base.assumingMemoryBound(to: UInt8.self)),
        width: CVPixelBufferGetWidth(pixelBuffer),
        height: CVPixelBufferGetHeight(pixelBuffer),
        bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
        options: options
      )
    default:
      return []
    }
    frame += 1
    onFrame?(found, Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6)
    let time = now()
    for d in found {
      if let last = seen[d.value], time.timeIntervalSince(last) <= repeatAfter {} else { onDetect?(d) }
      seen[d.value] = time
    }
    return found
  }
}
#endif
