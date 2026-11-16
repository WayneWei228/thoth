// Write a QR code PNG for a text (macOS CoreImage; no extra packages).
// Usage: swift scripts/qr.swift "<text>" out.png
import AppKit
import CoreImage

let args = CommandLine.arguments
guard args.count == 3, let data = args[1].data(using: .utf8) else { fatalError("usage: qr.swift <text> <out.png>") }
let f = CIFilter(name: "CIQRCodeGenerator")!
f.setValue(data, forKey: "inputMessage")
f.setValue("M", forKey: "inputCorrectionLevel")
let img = f.outputImage!.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
let rep = NSBitmapImageRep(ciImage: img)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
