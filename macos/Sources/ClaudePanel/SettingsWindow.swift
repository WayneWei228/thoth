import AppKit

/// Settings (sidebar bottom left, or Thoth > Settings… ⌘,). For now one section: Appearance,
/// the Original look or the Website look (Theme.Look). The window uses system controls only, so it
/// looks right in both looks and needs no rebuild when the look changes.
final class SettingsWindowController: NSWindowController {
    static let shared = SettingsWindowController()

    private var cards: [Theme.Look: LookCard] = [:]

    init() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 300),
                         styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "Settings"
        w.isReleasedWhenClosed = false
        super.init(window: w)
        build(w)
        w.center()
    }
    required init?(coder: NSCoder) { fatalError() }

    private func build(_ w: NSWindow) {
        let title = NSTextField(labelWithString: "Appearance")
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        let sub = NSTextField(wrappingLabelWithString: "How Thoth looks. It changes at once; your sessions keep running.")
        sub.textColor = .secondaryLabelColor
        let original = LookCard(look: .original, title: "Original", detail: "System colours. Follows light and dark mode.")
        original.setAccessibilityIdentifier("settings.look.original")
        let website = LookCard(look: .website, title: "Website", detail: "Ink on paper, like the Thoth website. Light only.")
        website.setAccessibilityIdentifier("settings.look.website")
        cards = [.original: original, .website: website]
        for c in [original, website] { c.onPick = { [weak self] look in self?.pick(look) } }
        let row = NSStackView(views: [original, website])
        row.spacing = 16
        row.distribution = .fillEqually
        let stack = NSStackView(views: [title, sub, row])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.setCustomSpacing(18, after: sub)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let root = NSView()
        root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 22),
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: root.bottomAnchor, constant: -22),
            row.widthAnchor.constraint(equalTo: stack.widthAnchor),
            sub.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        w.contentView = root
        refresh()
    }

    func present() {
        refresh()
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        Instance.activate()
    }

    private func pick(_ look: Theme.Look) {
        AppDelegate.shared.setLook(look)
        refresh()
        window?.makeKeyAndOrderFront(nil)   // the main window was built again; keep Settings in front
    }

    private func refresh() {
        for (look, card) in cards { card.selected = look == Theme.look }
    }
}

/// One choice: a small picture of the look, its name and one line. Click to pick it.
final class LookCard: NSView {
    let look: Theme.Look
    var onPick: ((Theme.Look) -> Void)?
    var selected = false { didSet { needsDisplay = true; setAccessibilityValue(selected ? "selected" : "") } }
    private let title: String, detail: String

    init(look: Theme.Look, title: String, detail: String) {
        self.look = look; self.title = title; self.detail = detail
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 180).isActive = true
        setAccessibilityRole(.radioButton)
        setAccessibilityLabel(title)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { onPick?(look) }
    override func accessibilityPerformPress() -> Bool { onPick?(look); return true }

    override func draw(_ dirtyRect: NSRect) {
        let r = bounds.insetBy(dx: 1.5, dy: 1.5)
        let frame = NSBezierPath(roundedRect: r, xRadius: 10, yRadius: 10)
        NSColor.controlBackgroundColor.setFill(); frame.fill()
        (selected ? NSColor.controlAccentColor : NSColor.separatorColor).setStroke()
        frame.lineWidth = selected ? 3 : 1; frame.stroke()

        // the picture: a tiny window with a sidebar, a title and a card
        let pic = NSRect(x: 14, y: 14, width: r.width - 26, height: 96)
        let web = look == .website
        let paper = web ? Theme.hex(0xF1ECE2) : NSColor.windowBackgroundColor
        let side = web ? Theme.hex(0xE8E2D5) : NSColor.underPageBackgroundColor
        let ink = web ? Theme.hex(0x1B1A17) : NSColor.labelColor
        let win = NSBezierPath(roundedRect: pic, xRadius: 6, yRadius: 6)
        paper.setFill(); win.fill()
        NSGraphicsContext.saveGraphicsState(); win.addClip()
        side.setFill(); NSRect(x: pic.minX, y: pic.minY, width: pic.width * 0.3, height: pic.height).fill()
        let lights: [NSColor] = web ? [Theme.hex(0xE4472F), Theme.hex(0xF2A93B), Theme.hex(0x3DA56A)] : [.systemRed, .systemOrange, .systemGreen]
        for (i, c) in lights.enumerated() {
            let d = NSBezierPath(ovalIn: NSRect(x: pic.minX + 10, y: pic.minY + 30 + CGFloat(i) * 16, width: 8, height: 8))
            c.setFill(); d.fill()
            if web { ink.setStroke(); d.lineWidth = 1; d.stroke() }
            ink.withAlphaComponent(0.35).setFill()
            NSRect(x: pic.minX + 23, y: pic.minY + 32 + CGFloat(i) * 16, width: pic.width * 0.3 - 30, height: 4).fill()
        }
        let titleAttrs: [NSAttributedString.Key: Any] = [.font: web ? Theme.serif(17) : NSFont.systemFont(ofSize: 12, weight: .semibold), .foregroundColor: ink]
        ("All Sessions" as NSString).draw(at: NSPoint(x: pic.minX + pic.width * 0.36, y: pic.minY + 10), withAttributes: titleAttrs)
        let card = NSRect(x: pic.minX + pic.width * 0.36, y: pic.minY + 40, width: pic.width * 0.56, height: 40)
        let cp = NSBezierPath(roundedRect: card, xRadius: web ? 7 : 6, yRadius: web ? 7 : 6)
        if web {
            Theme.hex(0x1B1A17).withAlphaComponent(0.12).setFill()
            NSBezierPath(roundedRect: card.offsetBy(dx: 3, dy: 3), xRadius: 7, yRadius: 7).fill()
        }
        (web ? Theme.hex(0xFBF8F1) : NSColor.controlBackgroundColor).setFill(); cp.fill()
        (web ? ink : NSColor.separatorColor).setStroke(); cp.lineWidth = web ? 1.5 : 1; cp.stroke()
        NSGraphicsContext.restoreGraphicsState()
        NSColor.separatorColor.setStroke(); win.lineWidth = 1; win.stroke()

        let t: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 13, weight: .semibold), .foregroundColor: NSColor.labelColor]
        (title as NSString).draw(at: NSPoint(x: 14, y: pic.maxY + 10), withAttributes: t)
        let style = NSMutableParagraphStyle(); style.lineBreakMode = .byWordWrapping
        let d: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: style]
        (detail as NSString).draw(in: NSRect(x: 14, y: pic.maxY + 29, width: r.width - 26, height: 32), withAttributes: d)
    }
}
