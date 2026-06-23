// On-device OCR for scanned PDFs using Apple's Vision framework.
//
// Usage:  ocr <input.pdf>
// Prints the recognized text to stdout, one page after another, with a
// form-feed (\f) separating pages so the chunker can keep page numbers.
//
// Build once:  swiftc -O scripts/ocr.swift -o .cache/ocr
// Nothing leaves the machine — important, since the corpus is copyrighted books.

import Foundation
import PDFKit
import Vision
import CoreGraphics

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

guard CommandLine.arguments.count >= 2 else { fail("usage: ocr <input.pdf>") }
let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)

guard let doc = PDFDocument(url: url) else { fail("could not open PDF: \(path)") }

// Render at 2x for crisper glyphs → better recognition on book scans.
let scale: CGFloat = 2.0

func renderPage(_ page: PDFPage) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    let width = Int(bounds.width * scale)
    let height = Int(bounds.height * scale)
    guard width > 0, height > 0 else { return nil }
    guard let ctx = CGContext(
        data: nil, width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
    ctx.scaleBy(x: scale, y: scale)
    ctx.translateBy(x: -bounds.origin.x, y: -bounds.origin.y)
    page.draw(with: .mediaBox, to: ctx)
    return ctx.makeImage()
}

func ocr(_ image: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return ""
    }
    let observations = request.results ?? []
    return observations
        .compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: "\n")
}

var out = ""
for i in 0..<doc.pageCount {
    guard let page = doc.page(at: i) else { continue }
    if let image = renderPage(page) {
        out += ocr(image)
    }
    out += "\u{000C}" // form feed between pages
}

FileHandle.standardOutput.write(out.data(using: .utf8) ?? Data())
