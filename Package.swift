// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "Glint",
  platforms: [.iOS(.v15), .macOS(.v12)],
  products: [.library(name: "Glint", targets: ["Glint"])],
  targets: [
    .target(name: "Glint"),
    .testTarget(name: "GlintTests", dependencies: ["Glint"], resources: [.copy("js-math.txt")]),
  ]
)
