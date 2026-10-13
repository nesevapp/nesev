// nesev-ocr: small macOS helper for receipt analysis (compiled on demand by src/server/lib/ocr/helper.ts).
//
//   nesev-ocr text <file.pdf> [--max-pages N]                    PDF text layer (PDFKit page.string)
//   nesev-ocr ocr <file> [--langs de-DE,en-US] [--dpi 300] [--max-pages N]
//                                                               Apple Vision OCR of an image or the rendered PDF pages
//   nesev-ocr render <file> <outdir> [--dpi 150] [--max-pages N] PDF pages (or an image) as PNG files
//   nesev-ocr version
//
// All output is JSON on stdout; errors go to stderr with exit code 1. Everything runs locally.

import AppKit
import CoreGraphics
import Foundation
import ImageIO
import PDFKit
import UniformTypeIdentifiers
import Vision

let VERSION = "1"

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

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("usage: nesev-ocr text|ocr|render|version ...") }
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

default:
  fail("unknown command \(command)")
}
