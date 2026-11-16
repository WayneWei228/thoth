import AppKit

/// Icons in the website's look: ink lines with round ends, paper fill, one colour accent
/// (the mark: public/logo.svg). An icon without a drawing here is the SF Symbol in a bold weight.
extension Theme {
    static func icon(_ symbol: String, _ description: String?) -> NSImage? {
        guard web else { return NSImage(systemSymbolName: symbol, accessibilityDescription: description) }   // the Original look
        if let draw = drawings[symbol] {
            let img = NSImage(size: NSSize(width: 20, height: 20), flipped: true) { _ in draw(); return true }
            img.accessibilityDescription = description
            return img
        }
        let cfg = NSImage.SymbolConfiguration(pointSize: 13, weight: .bold)
        return NSImage(systemSymbolName: symbol, accessibilityDescription: description)?.withSymbolConfiguration(cfg)
    }

    /// The mark: one panel, three lights, the place where you ask.
    static func mark(height: CGFloat) -> NSImage {
        let k = height / 36
        return NSImage(size: NSSize(width: 44 * k, height: height), flipped: true) { _ in
            let t = NSAffineTransform(); t.scale(by: k); t.concat()
            box(NSRect(x: 2, y: 2, width: 40, height: 32), r: 8, w: 2.5)
            line([(16, 2), (16, 34)], w: 2)
            light(9, 10, 2.8, red, ring: 0); light(9, 18, 2.8, amber, ring: 0); light(9, 26, 2.8, green, ring: 0)
            pill(NSRect(x: 22, y: 23, width: 14, height: 5), you)
            return true
        }
    }

    private static func box(_ r: NSRect, r radius: CGFloat, w: CGFloat = 1.6, fill: NSColor = panel) {
        let p = NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius)
        fill.setFill(); p.fill()
        ink.setStroke(); p.lineWidth = w; p.stroke()
    }
    private static func line(_ pts: [(CGFloat, CGFloat)], w: CGFloat = 1.6, close: Bool = false, fill: NSColor? = nil) {
        let p = NSBezierPath()
        p.move(to: NSPoint(x: pts[0].0, y: pts[0].1))
        for q in pts.dropFirst() { p.line(to: NSPoint(x: q.0, y: q.1)) }
        if close { p.close() }
        p.lineWidth = w; p.lineCapStyle = .round; p.lineJoinStyle = .round
        if let fill { fill.setFill(); p.fill() }
        ink.setStroke(); p.stroke()
    }
    private static func light(_ x: CGFloat, _ y: CGFloat, _ r: CGFloat, _ c: NSColor, ring: CGFloat = 1.1) {
        let p = NSBezierPath(ovalIn: NSRect(x: x - r, y: y - r, width: r * 2, height: r * 2))
        c.setFill(); p.fill()
        if ring > 0 { ink.setStroke(); p.lineWidth = ring; p.stroke() }
    }
    private static func pill(_ r: NSRect, _ c: NSColor) {
        c.setFill(); NSBezierPath(roundedRect: r, xRadius: r.height / 2, yRadius: r.height / 2).fill()
    }

    private static let drawings: [String: () -> Void] = [
        // New Request: a sheet with the blue place where you ask
        "square.and.pencil": {
            box(NSRect(x: 2.5, y: 3, width: 15, height: 14), r: 3.5)
            line([(6, 7.5), (12, 7.5)], w: 1.4)
            pill(NSRect(x: 6, y: 11, width: 8, height: 3), you)
        },
        // All Sessions: three sessions, each with its light
        "square.grid.2x2": {
            light(4.5, 4.5, 2.2, red); line([(9.5, 4.5), (17, 4.5)])
            light(4.5, 10, 2.2, amber); line([(9.5, 10), (17, 10)])
            light(4.5, 15.5, 2.2, green); line([(9.5, 15.5), (17, 15.5)])
        },
        // All Devices: a screen and a phone, each with a light
        "desktopcomputer": {
            box(NSRect(x: 1.5, y: 3, width: 13.5, height: 10), r: 2.5)
            line([(8.2, 13), (8.2, 16.5)]); line([(5, 16.8), (11.4, 16.8)])
            light(5.2, 6.6, 1.5, green, ring: 0)
            box(NSRect(x: 12.5, y: 7.5, width: 6, height: 10.5), r: 2)
            light(15.5, 10.5, 1.3, amber, ring: 0)
        },
        "folder": { folder(panel) },
        "folder.fill": { folder(amber) },
        "plus": { line([(10, 4), (10, 16)], w: 2); line([(4, 10), (16, 10)], w: 2) },
        "arrow.up": { line([(10, 16), (10, 4.5)], w: 2); line([(5, 9.5), (10, 4.5), (15, 9.5)], w: 2) },
        "xmark": { line([(5, 5), (15, 15)], w: 2); line([(15, 5), (5, 15)], w: 2) },
        "xmark.circle": {
            box(NSRect(x: 2.5, y: 2.5, width: 15, height: 15), r: 7.5)
            line([(7.2, 7.2), (12.8, 12.8)]); line([(12.8, 7.2), (7.2, 12.8)])
        },
        "terminal": {
            box(NSRect(x: 2, y: 3.5, width: 16, height: 13), r: 3, fill: ink)
            let p = NSBezierPath(); p.move(to: NSPoint(x: 5.5, y: 8)); p.line(to: NSPoint(x: 8.5, y: 10.5)); p.line(to: NSPoint(x: 5.5, y: 13))
            p.lineWidth = 1.5; p.lineCapStyle = .round; p.lineJoinStyle = .round; panel.setStroke(); p.stroke()
            pill(NSRect(x: 10.5, y: 12, width: 4.5, height: 1.6), green)
        },
        "play.fill": { line([(6.5, 4.5), (15.5, 10), (6.5, 15.5)], close: true, fill: green) },
        "stop.fill": { box(NSRect(x: 5, y: 5, width: 10, height: 10), r: 2.5, fill: red) },
        "exclamationmark.circle.fill": {
            light(10, 10, 7.5, red, ring: 1.6)
            let p = NSBezierPath(); p.move(to: NSPoint(x: 10, y: 6)); p.line(to: NSPoint(x: 10, y: 10.8))
            p.lineWidth = 2; p.lineCapStyle = .round; panel.setStroke(); p.stroke()
            panel.setFill(); NSBezierPath(ovalIn: NSRect(x: 8.9, y: 12.9, width: 2.2, height: 2.2)).fill()
        },
    ]
    private static func folder(_ fill: NSColor) {
        line([(2.5, 15.5), (2.5, 5), (8, 5), (9.8, 7.2), (17.5, 7.2), (17.5, 15.5)], close: true, fill: fill)
    }
}
