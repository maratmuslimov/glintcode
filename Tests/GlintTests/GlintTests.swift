import CoreVideo
import Foundation
import ImageIO
import XCTest

@testable import Glint

private let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
private let spec = root.appendingPathComponent("spec")

private struct Entry: Decodable {
  struct Hit: Decodable, Equatable {
    let format: String
    let value: UInt64
    let corrected: Int
  }
  let file: String
  let width: Int
  let height: Int
  let read: [Hit]
}

private struct FrameHit: Decodable {
  let format: String
  let value: UInt64
  let corrected: Int
  let center: [Double]
  let size: Double
  let inverted: Bool
}

private struct Frame: Decodable {
  let file: String
  let read: [FrameHit]
}

private func hits(_ found: [GlintDetection]) -> [Entry.Hit] {
  found.map { Entry.Hit(format: $0.format.rawValue, value: $0.value, corrected: $0.corrected) }
}

/** The stored bytes of an 8-bit gray PNG, with no colour management in the way. */
private func grayPNG(_ url: URL) throws -> (data: [UInt8], width: Int, height: Int) {
  let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
  let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
  XCTAssertEqual(image.bitsPerPixel, 8)
  let bytes = try XCTUnwrap(image.dataProvider?.data) as Data
  var data = [UInt8](repeating: 0, count: image.width * image.height)
  for y in 0..<image.height {
    for x in 0..<image.width { data[y * image.width + x] = bytes[bytes.startIndex + y * image.bytesPerRow + x] }
  }
  return (data, image.width, image.height)
}

private func frames() throws -> [Frame] {
  try JSONDecoder().decode([Frame].self, from: Data(contentsOf: spec.appendingPathComponent("frames/manifest.json")))
}

final class GlintTests: XCTestCase {
  func testVectors() throws {
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: spec.appendingPathComponent("vectors.json"))) as? [String: Any])
    let seeds = try XCTUnwrap(json["seeds"] as? [String: UInt64])
    let vectors = try XCTUnwrap(json["vectors"] as? [[String: Any]])
    var checked = 0
    for v in vectors {
      let value = try XCTUnwrap(v["value"] as? UInt64)
      let bits = try XCTUnwrap(v["bits"] as? [String: String])
      for (format, want) in bits {
        let seed = UInt32(try XCTUnwrap(seeds[format]))
        let got = encodeBits(value, seed)
        XCTAssertEqual(String(got.map { $0 ? "1" : "0" }), want, "\(format) \(value)")
        let back = try XCTUnwrap(decodeBits(got, whitening(seed)))
        XCTAssertEqual(payloadToNumber(back.payload), value)
        XCTAssertEqual(back.corrected, 0)
        checked += 1
      }
      let cells = try XCTUnwrap(v["capsuleCells"] as? [String]).map { $0.map { $0 == "1" } }
      XCTAssertEqual(decodeCells(cells).map { payloadToNumber($0.payload) }, value)
    }
    print("vectors: \(vectors.count) values, \(checked) format codewords")
  }

  func testErrorsAndErasures() {
    let word = rsEncode([1, 2, 3, 4, 5, 6], ECC_BYTES)
    var bad = word
    bad[0] ^= 0x55
    bad[7] ^= 0xaa
    XCTAssertEqual(rsDecode(bad, ECC_BYTES, [], budget: 5)?.corrected, 2)
    bad[3] ^= 0x11
    XCTAssertNil(rsDecode(bad, ECC_BYTES, [], budget: 5))
    XCTAssertEqual(rsDecode(bad, ECC_BYTES, [0, 7, 3], budget: 5)?.data, [1, 2, 3, 4, 5, 6])
  }

  func testJSMath() throws {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "js-math", withExtension: "txt"))
    let double = { (s: Substring) in Double(bitPattern: UInt64(s, radix: 16)!) }
    var lines = 0
    for line in try String(contentsOf: url, encoding: .utf8).split(separator: "\n") {
      let p = line.split(separator: " ")
      let got: Double
      switch p[0] {
      case "s": got = jsSin(double(p[1]))
      case "c": got = jsCos(double(p[1]))
      case "a": got = jsAtan2(double(p[1]), double(p[2]))
      default: got = jsHypot(double(p[1]), double(p[2]))
      }
      XCTAssertEqual(got.bitPattern, double(p[p.count - 1]).bitPattern, String(line))
      lines += 1
    }
    print("js math: \(lines) samples")
  }

  func testRound() {
    XCTAssertEqual(jsRound(2.5), 3)
    XCTAssertEqual(jsRound(-2.5), -2)
    XCTAssertEqual(jsRound(0.49999999999999994), 0)
  }

  func testFrames() throws {
    let all = try frames()
    let reader = GlintReader()
    for m in all {
      let img = try grayPNG(spec.appendingPathComponent("frames/\(m.file)"))
      let found = reader.detect(gray: img.data, width: img.width, height: img.height)
      XCTAssertEqual(hits(found), m.read.map { Entry.Hit(format: $0.format, value: $0.value, corrected: $0.corrected) }, m.file)
      for (d, r) in zip(found, m.read) {
        XCTAssertEqual(d.center.x, r.center[0], accuracy: 0.0051, m.file)
        XCTAssertEqual(d.center.y, r.center[1], accuracy: 0.0051, m.file)
        XCTAssertEqual(d.size, r.size, accuracy: 0.0051, m.file)
        XCTAssertEqual(d.inverted, r.inverted, m.file)
      }
    }
    print("frames: \(all.count)")
  }

  /** The same reads through the RGBA path, a padded row stride and a fresh reader per call. */
  func testInputs() throws {
    for m in try frames() {
      let img = try grayPNG(spec.appendingPathComponent("frames/\(m.file)"))
      let want = Glint.detect(gray: img.data, width: img.width, height: img.height)
      var rgba = [UInt8](repeating: 255, count: img.data.count * 4)
      for (i, v) in img.data.enumerated() {
        // 77 + 150 + 29 = 256: gray comes back unchanged.
        rgba[i * 4] = v
        rgba[i * 4 + 1] = v
        rgba[i * 4 + 2] = v
      }
      XCTAssertEqual(Glint.detect(rgba: rgba, width: img.width, height: img.height), want, m.file)
      let stride = img.width + 13
      var padded = [UInt8](repeating: 9, count: stride * img.height)
      for y in 0..<img.height { padded.replaceSubrange((y * stride)..<(y * stride + img.width), with: img.data[(y * img.width)..<((y + 1) * img.width)]) }
      let viaStride = padded.withUnsafeBufferPointer { GlintReader().detect(gray: $0.baseAddress!, width: img.width, height: img.height, bytesPerRow: stride) }
      XCTAssertEqual(viaStride, want, m.file)
    }
  }

  func testDownscale() throws {
    let m = try XCTUnwrap(frames().first { !$0.read.isEmpty })
    let img = try grayPNG(spec.appendingPathComponent("frames/\(m.file)"))
    var big = [UInt8](repeating: 0, count: img.data.count * 4)
    for y in 0..<(img.height * 2) { for x in 0..<(img.width * 2) { big[y * img.width * 2 + x] = img.data[(y / 2) * img.width + x / 2] } }
    let found = Glint.detect(gray: big, width: img.width * 2, height: img.height * 2, options: GlintDetectOptions(maxDimension: img.width))
    XCTAssertEqual(hits(found), hits(Glint.detect(gray: img.data, width: img.width, height: img.height)))
    XCTAssertEqual(found.first?.center.x ?? 0, m.read[0].center[0] * 2, accuracy: 0.011)
  }

  func testDegenerateInput() {
    XCTAssertEqual(Glint.detect(gray: [], width: 0, height: 0), [])
    XCTAssertEqual(Glint.detect(gray: [1, 2, 3], width: 3, height: 1), [])
    XCTAssertEqual(Glint.detect(gray: [1], width: 2, height: 2), [])
    XCTAssertEqual(Glint.detect(gray: [UInt8](repeating: 7, count: 5000), width: 5000, height: 1), [])
    XCTAssertEqual(Glint.detect(gray: [1, 2, 3, 4], width: 2, height: 2, options: GlintDetectOptions(maxDimension: 0)), [])
  }

  func testScanner() throws {
    let m = try XCTUnwrap(frames().first { $0.read.first?.inverted == false })
    let inked = try XCTUnwrap(frames().first { $0.read.first?.inverted == true })
    for frame in [m, inked] {
      let img = try grayPNG(spec.appendingPathComponent("frames/\(frame.file)"))
      for format in [kCVPixelFormatType_420YpCbCr8BiPlanarFullRange, kCVPixelFormatType_32BGRA] {
        let buffer = try pixelBuffer(img.data, img.width, img.height, format)
        let scanner = GlintScanner()
        var time = Date(timeIntervalSince1970: 0)
        scanner.now = { time }
        var seen: [GlintDetection] = []
        var frames = 0
        scanner.onDetect = { seen.append($0) }
        scanner.onFrame = { _, _ in frames += 1 }
        let first = scanner.scan(buffer)
        let second = scanner.scan(buffer)
        // Polarities alternate: a code shows in exactly one of the two.
        XCTAssertEqual(first.isEmpty, !second.isEmpty, frame.file)
        XCTAssertEqual((first + second).first?.value, frame.read[0].value)
        XCTAssertEqual(seen.count, 1)
        for _ in 0..<4 {
          time += 1
          scanner.scan(buffer)
        }
        XCTAssertEqual(seen.count, 1, "stays in view: no repeat")
        for _ in 0..<2 {
          time += 3.5
          scanner.scan(buffer)
        }
        XCTAssertEqual(seen.count, 2, "repeats after repeatAfter")
        XCTAssertEqual(frames, 8)
      }
    }
  }

  private func pixelBuffer(_ gray: [UInt8], _ w: Int, _ h: Int, _ format: OSType) throws -> CVPixelBuffer {
    var out: CVPixelBuffer?
    XCTAssertEqual(CVPixelBufferCreate(nil, w, h, format, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &out), kCVReturnSuccess)
    let buffer = try XCTUnwrap(out)
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    if format == kCVPixelFormatType_32BGRA {
      let base = try XCTUnwrap(CVPixelBufferGetBaseAddress(buffer)).assumingMemoryBound(to: UInt8.self)
      let stride = CVPixelBufferGetBytesPerRow(buffer)
      for y in 0..<h {
        for x in 0..<w {
          let p = base + y * stride + x * 4
          p[0] = gray[y * w + x]
          p[1] = gray[y * w + x]
          p[2] = gray[y * w + x]
          p[3] = 255
        }
      }
    } else {
      let base = try XCTUnwrap(CVPixelBufferGetBaseAddressOfPlane(buffer, 0)).assumingMemoryBound(to: UInt8.self)
      let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
      for y in 0..<h { (base + y * stride).update(from: Array(gray[(y * w)..<((y + 1) * w)]), count: w) }
    }
    return buffer
  }

  /** GLINT_CORPUS: every frame must read as `read` in manifest.jsonl says. */
  func testCorpus() throws {
    guard let dir = ProcessInfo.processInfo.environment["GLINT_CORPUS"] else { throw XCTSkip("GLINT_CORPUS not set") }
    let base = URL(fileURLWithPath: dir)
    let decoder = JSONDecoder()
    let lines = try String(contentsOf: base.appendingPathComponent("manifest.jsonl"), encoding: .utf8).split(separator: "\n")
    let reader = GlintReader()
    let dump = ProcessInfo.processInfo.environment["GLINT_DUMP"].flatMap { FileHandle(forWritingAtPath: $0) }
    var ms: [Double] = []
    var perFormat: [String: Int] = [:]
    var diffs = 0
    for line in lines {
      let e = try decoder.decode(Entry.self, from: Data(line.utf8))
      let gray = [UInt8](try Data(contentsOf: base.appendingPathComponent(e.file)))
      let t0 = DispatchTime.now().uptimeNanoseconds
      let found = reader.detect(gray: gray, width: e.width, height: e.height)
      let t1 = DispatchTime.now().uptimeNanoseconds
      if e.width == 960 && e.height == 720 { ms.append(Double(t1 - t0) / 1e6) }
      if hits(found) != e.read {
        diffs += 1
        perFormat[String(e.file.prefix { $0 != "-" }), default: 0] += 1
        if diffs <= 20 { print("DIFF \(e.file): swift \(hits(found)) ts \(e.read)") }
      }
      if let dump {
        var s = e.file
        for d in found {
          s += " \(d.format.rawValue) \(d.value) \(d.corrected) \(d.inverted) \(String(d.size.bitPattern, radix: 16))"
          for p in [d.center] + d.corners { s += " \(String(p.x.bitPattern, radix: 16)) \(String(p.y.bitPattern, radix: 16))" }
        }
        dump.write(Data((s + "\n").utf8))
      }
    }
    ms.sort()
    let median = ms.isEmpty ? 0 : ms[ms.count / 2]
    print("corpus: \(lines.count) frames, \(diffs) differ \(perFormat)")
    print("960x720: \(ms.count) frames, median \(median) ms, p95 \(ms.isEmpty ? 0 : ms[ms.count * 95 / 100]) ms, max \(ms.last ?? 0) ms")
    XCTAssertEqual(diffs, 0)
  }
}
