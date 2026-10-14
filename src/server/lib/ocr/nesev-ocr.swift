// nesev-ocr: small macOS helper for receipt analysis (compiled on demand by src/server/lib/ocr/helper.ts).
//
//   nesev-ocr text <file.pdf> [--max-pages N]                    PDF text layer (PDFKit page.string)
//   nesev-ocr ocr <file> [--langs de-DE,en-US] [--dpi 300] [--max-pages N]
//                                                               Apple Vision OCR of an image or the rendered PDF pages
//   nesev-ocr render <file> <outdir> [--dpi 150] [--max-pages N] PDF pages (or an image) as PNG files
//   nesev-ocr detect-document <image>                           receipt outline in a photo (Vision document segmentation,
//                                                               rectangle detection as fallback)
//   nesev-ocr crop <image> <out> --quad x1,y1,...,x4,y4 [--format jpeg|png] [--quality 0.9] [--max-side 3000] [--enhance]
//                                                               perspective-corrected cut-out of the quad (Core Image)
//   nesev-ocr version
//
// Quads are normalized [x, y] corner points (top-left origin) in the order top-left, top-right, bottom-right,
// bottom-left, measured on the image as displayed, i.e. after applying its EXIF orientation.
//
// All output is JSON on stdout; errors go to stderr with exit code 1. Everything runs locally.

import AppKit
import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import PDFKit
import UniformTypeIdentifiers
import Vision

let VERSION = "2"

struct Failure: Error { let message: String }

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

func printJSON(_ value: Any) {
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: []) else { fail("JSON encoding failed") }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func option(_ args: [String], _ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}

func isPDF(_ url: URL) -> Bool {
  if url.pathExtension.lowercased() == "pdf" { return true }
  guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
  defer { try? handle.close() }
  let head = handle.readData(ofLength: 5)
  return head == "%PDF-".data(using: .ascii)
}

func openPDF(_ url: URL) -> PDFDocument {
  guard let doc = PDFDocument(url: url) else { fail("PDF kann nicht gelesen werden") }
  if doc.isLocked && !doc.unlock(withPassword: "") { fail("PDF ist passwortgeschützt") }
  return doc
}

/// Renders a PDF page on a white background at `dpi` (longest side capped at 6000 px).
func renderPage(_ page: PDFPage, dpi: Double) -> CGImage? {
  let box = page.bounds(for: .mediaBox)
  let rotated = page.rotation % 180 != 0
  let wPt = rotated ? box.height : box.width
  let hPt = rotated ? box.width : box.height
  var scale = dpi / 72.0
  let longest = max(wPt, hPt) * scale
  if longest > 6000 { scale *= 6000 / longest }
  let width = Int((wPt * scale).rounded())
  let height = Int((hPt * scale).rounded())
  guard width > 0, height > 0,
    let ctx = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
  else { return nil }
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
  ctx.scaleBy(x: scale, y: scale)
  page.draw(with: .mediaBox, to: ctx)
  return ctx.makeImage()
}

func loadImage(_ url: URL) -> (CGImage, CGImagePropertyOrientation) {
  guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(src, 0, nil)
  else { fail("Bild kann nicht gelesen werden") }
  var orientation = CGImagePropertyOrientation.up
  if let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
    let raw = props[kCGImagePropertyOrientation] as? UInt32,
    let o = CGImagePropertyOrientation(rawValue: raw)
  {
    orientation = o
  }
  return (image, orientation)
}

/// Page images of a PDF or the single image file.
func pageImages(_ url: URL, dpi: Double, maxPages: Int) -> (images: [(CGImage, CGImagePropertyOrientation)], pageCount: Int) {
  if isPDF(url) {
    let doc = openPDF(url)
    var images: [(CGImage, CGImagePropertyOrientation)] = []
    for i in 0..<min(doc.pageCount, maxPages) {
      guard let page = doc.page(at: i), let img = renderPage(page, dpi: dpi) else { continue }
      images.append((img, .up))
    }
    return (images, doc.pageCount)
  }
  return ([loadImage(url)], 1)
}

func round3(_ v: Double) -> Double { (v * 1000).rounded() / 1000 }

func recognize(_ image: CGImage, orientation: CGImagePropertyOrientation, langs: [String]) throws -> [[String: Any]] {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.recognitionLanguages = langs
  if #available(macOS 13.0, *) { request.automaticallyDetectsLanguage = false }
  let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
  try handler.perform([request])
  let observations = request.results ?? []
  return observations.compactMap { obs in
    guard let candidate = obs.topCandidates(1).first else { return nil }
    let b = obs.boundingBox  // normalized, origin bottom-left
    return [
      "text": candidate.string,
      "confidence": round3(Double(candidate.confidence)),
      // normalized [x, y, w, h] with origin top-left
      "box": [round3(b.minX), round3(1 - b.maxY), round3(b.width), round3(b.height)],
    ]
  }
}

func savePNG(_ image: CGImage, to url: URL) -> Bool {
  guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    return false
  }
  CGImageDestinationAddImage(dest, image, nil)
  return CGImageDestinationFinalize(dest)
}

// --- receipt photos: outline detection and perspective crop ---

func round4(_ v: Double) -> Double { (v * 10000).rounded() / 10000 }

/// Vision rectangle (normalized, origin bottom-left) → quad [[x, y]] TL, TR, BR, BL with origin top-left.
func quadPoints(_ obs: VNRectangleObservation) -> [[Double]] {
  [obs.topLeft, obs.topRight, obs.bottomRight, obs.bottomLeft].map { p in
    [round4(min(max(Double(p.x), 0), 1)), round4(min(max(1 - Double(p.y), 0), 1))]
  }
}

/// Shoelace area of a normalized quad (fraction of the image).
func quadArea(_ q: [[Double]]) -> Double {
  var sum = 0.0
  for i in 0..<4 {
    let a = q[i], b = q[(i + 1) % 4]
    sum += a[0] * b[1] - b[0] * a[1]
  }
  return abs(sum) / 2
}

func detectDocument(_ url: URL) -> [String: Any] {
  let (image, orientation) = loadImage(url)
  let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
  let rotated = [.left, .right, .leftMirrored, .rightMirrored].contains(orientation)
  var result: [String: Any] = [
    "width": rotated ? image.height : image.width,
    "height": rotated ? image.width : image.height,
    "quad": NSNull(),
    "confidence": 0,
    "method": NSNull(),
  ]
  // Segmentation finds paper on cluttered backgrounds. Without a document it answers with ~the whole frame
  // at confidence 0; a tiny hit is usually a label or a phone screen.
  if #available(macOS 12.0, *) {
    let request = VNDetectDocumentSegmentationRequest()
    if (try? handler.perform([request])) != nil, let obs = request.results?.first, obs.confidence >= 0.3 {
      let quad = quadPoints(obs)
      if quadArea(quad) >= 0.03 {
        result["quad"] = quad
        result["confidence"] = round3(Double(obs.confidence))
        result["method"] = "segmentation"
        return result
      }
    }
  }
  let rect = VNDetectRectanglesRequest()
  rect.minimumAspectRatio = 0.1  // long receipts
  rect.maximumAspectRatio = 1
  rect.minimumSize = 0.2
  rect.minimumConfidence = 0.5
  rect.quadratureTolerance = 30  // perspective
  rect.maximumObservations = 1
  if (try? handler.perform([rect])) != nil, let obs = rect.results?.first {
    result["quad"] = quadPoints(obs)
    result["confidence"] = round3(Double(obs.confidence))
    result["method"] = "rectangles"
  }
  return result
}

func parseQuad(_ raw: String?) -> [[Double]] {
  guard let raw else { fail("--quad fehlt") }
  let v = raw.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
  guard v.count == 8, v.allSatisfy({ $0.isFinite }) else { fail("--quad braucht 8 Zahlen") }
  func clamp(_ x: Double) -> Double { min(max(x, 0), 1) }
  return (0..<4).map { (i: Int) -> [Double] in [clamp(v[i * 2]), clamp(v[i * 2 + 1])] }
}

func crop(_ url: URL, to out: URL, quad: [[Double]], args: [String]) -> [String: Any] {
  guard let input = CIImage(contentsOf: url, options: [.applyOrientationProperty: true]) else {
    fail("Bild kann nicht gelesen werden")
  }
  let extent = input.extent
  // normalized, origin top-left → Core Image pixels, origin bottom-left
  func point(_ p: [Double]) -> CIVector {
    CIVector(x: extent.minX + p[0] * extent.width, y: extent.minY + (1 - p[1]) * extent.height)
  }
  guard let perspective = CIFilter(name: "CIPerspectiveCorrection") else { fail("CIPerspectiveCorrection fehlt") }
  perspective.setValue(input, forKey: kCIInputImageKey)
  perspective.setValue(point(quad[0]), forKey: "inputTopLeft")
  perspective.setValue(point(quad[1]), forKey: "inputTopRight")
  perspective.setValue(point(quad[2]), forKey: "inputBottomRight")
  perspective.setValue(point(quad[3]), forKey: "inputBottomLeft")
  guard var image = perspective.outputImage, !image.extent.isInfinite, image.extent.width >= 1, image.extent.height >= 1
  else { fail("Zuschneiden fehlgeschlagen") }

  let maxSide = Double(option(args, "--max-side") ?? "") ?? 3000
  let longest = Double(max(image.extent.width, image.extent.height))
  if maxSide > 0 && longest > maxSide {
    image = image.applyingFilter(
      "CILanczosScaleTransform", parameters: [kCIInputScaleKey: maxSide / longest, kCIInputAspectRatioKey: 1.0])
  }
  if args.contains("--enhance") {
    // mild "scan" look: grayscale, a bit more contrast, slightly brighter paper
    image = image.applyingFilter(
      "CIColorControls",
      parameters: [kCIInputSaturationKey: 0.0, kCIInputContrastKey: 1.15, kCIInputBrightnessKey: 0.03])
  }
  // integral extent at the origin (the filters leave fractional offsets)
  let rect = image.extent.integral
  image = image.cropped(to: rect).transformed(by: CGAffineTransform(translationX: -rect.minX, y: -rect.minY))

  let context = CIContext()
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  let format = option(args, "--format") ?? "jpeg"
  do {
    if format == "png" {
      try context.writePNGRepresentation(of: image, to: out, format: .RGBA8, colorSpace: space)
    } else {
      let quality = Double(option(args, "--quality") ?? "") ?? 0.9
      let key = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
      try context.writeJPEGRepresentation(of: image, to: out, colorSpace: space, options: [key: quality])
    }
  } catch {
    fail("Bild konnte nicht gespeichert werden: \(error.localizedDescription)")
  }
  return ["file": out.path, "width": Int(rect.width), "height": Int(rect.height)]
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("usage: nesev-ocr text|ocr|render|detect-document|crop|version ...") }
let maxPages = Int(option(args, "--max-pages") ?? "") ?? 10

switch command {
case "version":
  printJSON(["version": VERSION])

case "text":
  guard args.count >= 2 else { fail("usage: nesev-ocr text <file.pdf>") }
  let doc = openPDF(URL(fileURLWithPath: args[1]))
  var pages: [String] = []
  for i in 0..<min(doc.pageCount, maxPages) { pages.append(doc.page(at: i)?.string ?? "") }
  printJSON(["pageCount": doc.pageCount, "pages": pages])

case "ocr":
  guard args.count >= 2 else { fail("usage: nesev-ocr ocr <file>") }
  let langs = (option(args, "--langs") ?? "de-DE,en-US").split(separator: ",").map(String.init)
  let dpi = Double(option(args, "--dpi") ?? "") ?? 300
  let (images, pageCount) = pageImages(URL(fileURLWithPath: args[1]), dpi: dpi, maxPages: maxPages)
  var pages: [[String: Any]] = []
  for (i, (image, orientation)) in images.enumerated() {
    do {
      let lines = try recognize(image, orientation: orientation, langs: langs)
      pages.append(["page": i + 1, "width": image.width, "height": image.height, "lines": lines])
    } catch {
      fail("Texterkennung fehlgeschlagen: \(error.localizedDescription)")
    }
  }
  printJSON(["engine": "vision", "pageCount": pageCount, "pages": pages])

case "render":
  guard args.count >= 3 else { fail("usage: nesev-ocr render <file> <outdir>") }
  let dpi = Double(option(args, "--dpi") ?? "") ?? 150
  let outDir = URL(fileURLWithPath: args[2], isDirectory: true)
  try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
  let (images, pageCount) = pageImages(URL(fileURLWithPath: args[1]), dpi: dpi, maxPages: maxPages)
  var files: [String] = []
  for (i, (image, _)) in images.enumerated() {
    let url = outDir.appendingPathComponent("page-\(i + 1).png")
    if savePNG(image, to: url) { files.append(url.path) }
  }
  printJSON(["pageCount": pageCount, "files": files])

case "detect-document":
  guard args.count >= 2 else { fail("usage: nesev-ocr detect-document <image>") }
  let url = URL(fileURLWithPath: args[1])
  if isPDF(url) { fail("Nur Bilder können erkannt werden") }
  printJSON(detectDocument(url))

case "crop":
  guard args.count >= 3 else { fail("usage: nesev-ocr crop <image> <out> --quad x1,y1,...") }
  let url = URL(fileURLWithPath: args[1])
  if isPDF(url) { fail("Nur Bilder können zugeschnitten werden") }
  printJSON(crop(url, to: URL(fileURLWithPath: args[2]), quad: parseQuad(option(args, "--quad")), args: args))

default:
  fail("unknown command \(command)")
}
