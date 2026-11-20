import AppKit

enum Theme {
    /// Two looks the user picks in Thoth > Appearance (user, 2026-11-15): "Original" (system
    /// colours, light and dark) and "Website" (ink on paper, the three lights,
    /// blue for "you"). Views read the look when they are built; switching rebuilds the main window.
    enum Look: String, CaseIterable { case original, website }
    static let lookKey = "ThothLook"
    static var look: Look { Look(rawValue: UserDefaults.standard.string(forKey: lookKey) ?? "") ?? .original }
    static var web: Bool { look == .website }

    static func hex(_ v: Int) -> NSColor {
        NSColor(srgbRed: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
    }
    static var paper: NSColor { web ? hex(0xF1ECE2) : .windowBackgroundColor }
    static var panel: NSColor { web ? hex(0xFBF8F1) : .controlBackgroundColor }
    static var side: NSColor { web ? hex(0xE8E2D5) : .clear }
    static var ink: NSColor { web ? hex(0x1B1A17) : .labelColor }
    static var soft: NSColor { web ? hex(0x8E897D) : .secondaryLabelColor }
    static var you: NSColor { web ? hex(0x2947D8) : accent }
    static var accent: NSColor { web ? ink : NSColor(srgbRed: 0.79, green: 0.39, blue: 0.26, alpha: 1) }     // #C96442
    static var red: NSColor { web ? hex(0xE4472F) : .systemRed }
    static var amber: NSColor { web ? hex(0xF2A93B) : .systemOrange }
    static var green: NSColor { web ? hex(0x3DA56A) : .systemGreen }
    /// Instrument Serif, the site's title font (app bundle: Resources/fonts). New York when it is missing.
    private static let serifLoaded: Bool = {
        guard let dir = Bundle.main.resourceURL?.appendingPathComponent("fonts") else { return false }
        let u = dir.appendingPathComponent("instrument-serif-latin-400-normal.woff2")
        return CTFontManagerRegisterFontsForURL(u as CFURL, .process, nil)
    }()
    static func serif(_ size: CGFloat) -> NSFont {
        if serifLoaded, let f = NSFont(name: "InstrumentSerif-Regular", size: size) { return f }
        let d = NSFont.systemFont(ofSize: size).fontDescriptor.withDesign(.serif)
        return d.flatMap { NSFont(descriptor: $0, size: size) } ?? .systemFont(ofSize: size)
    }
    /// The site's hard shadow: ink, no blur, down and to the right.
    static func hardShadow(_ layer: CALayer?, flipped: Bool = true) {
        guard web else { return }
        layer?.masksToBounds = false
        layer?.shadowColor = ink.cgColor
        layer?.shadowOpacity = 0.12
        layer?.shadowRadius = 0
        layer?.shadowOffset = CGSize(width: 4, height: flipped ? 5 : -5)
    }
    static let terminalBG = NSColor(srgbRed: 0.106, green: 0.106, blue: 0.102, alpha: 1)

    static func color(for state: SessionState) -> NSColor {
        switch state {
        case .needs, .failed: return red
        case .working, .preparing: return amber
        case .idle: return green
        case .stopped, .elsewhere: return .secondaryLabelColor
        }
    }
}

/// Flipped view so stacked content starts at the top.
class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// Status dot: filled for live states, hollow for not running; needs-you pulses.
final class StatusDot: NSView {
    var state: SessionState = .idle { didSet { update() } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        translatesAutoresizingMaskIntoConstraints = false
        let d: CGFloat = Theme.web ? 12 : 10
        widthAnchor.constraint(equalToConstant: d).isActive = true
        heightAnchor.constraint(equalToConstant: d).isActive = true
        update()
    }
    required init?(coder: NSCoder) { fatalError() }

    private func update() {
        guard let layer else { return }
        let c = Theme.color(for: state)
        let hollow = state == .stopped || state == .elsewhere
        if Theme.web {   // a light, as on the site: an ink ring, lit in the state colour
            layer.cornerRadius = 6
            layer.backgroundColor = hollow ? Theme.hex(0xD8D2C5).cgColor : c.cgColor
            layer.borderWidth = 1.5
            layer.borderColor = (hollow ? Theme.soft : Theme.ink).cgColor
        } else {
            layer.cornerRadius = 5
            layer.backgroundColor = hollow ? NSColor.clear.cgColor : c.cgColor
            layer.borderWidth = hollow ? 1.5 : 0
            layer.borderColor = c.cgColor
        }
        layer.removeAllAnimations()
        if state == .needs || state == .working || state == .preparing {
            let a = CABasicAnimation(keyPath: "opacity")
            a.fromValue = 1; a.toValue = 0.35; a.duration = state == .needs ? 0.7 : 1.0
            a.autoreverses = true; a.repeatCount = .infinity
            layer.add(a, forKey: "pulse")
        }
    }
}

/// Small rounded label for a state.
final class Pill: NSTextField {
    override init(frame: NSRect) {
        super.init(frame: frame)
        isEditable = false
        isSelectable = false
        isBordered = false
        drawsBackground = false
        font = .systemFont(ofSize: 11, weight: .semibold)
        wantsLayer = true
        layer?.cornerRadius = 8
        alignment = .center
        translatesAutoresizingMaskIntoConstraints = false
        setContentCompressionResistancePriority(.required, for: .horizontal)
    }
    required init?(coder: NSCoder) { fatalError() }
    convenience init(_ text: String) {
        self.init(frame: .zero)
        stringValue = text
    }
    override var intrinsicContentSize: NSSize {
        let s = super.intrinsicContentSize
        return NSSize(width: s.width + 14, height: 18)
    }
    func set(_ state: SessionState) {
        stringValue = state.label
        let c = Theme.color(for: state)
        switch state {
        case .needs, .failed: textColor = .white; layer?.backgroundColor = c.cgColor
        case .stopped, .elsewhere: textColor = .secondaryLabelColor; layer?.backgroundColor = NSColor.quaternaryLabelColor.cgColor
        default: textColor = c; layer?.backgroundColor = c.withAlphaComponent(0.15).cgColor
        }
        invalidateIntrinsicContentSize()
    }
    /// Muted gray pill, for example the agent badge.
    func setMuted(_ text: String) {
        stringValue = text
        textColor = .secondaryLabelColor
        layer?.backgroundColor = NSColor.quaternaryLabelColor.cgColor
        invalidateIntrinsicContentSize()
    }
    /// Small "Codex" badge for Codex sessions; nil for Claude Code (keeps the old look).
    static func agent(_ agent: String) -> Pill? {
        guard agent == "codex" else { return nil }
        let p = Pill()
        p.setMuted("Codex")
        p.toolTip = "Runs the Codex CLI"
        return p
    }
    func set(text: String, color: NSColor, filled: Bool = false) {
        stringValue = text
        textColor = filled ? .white : color
        layer?.backgroundColor = filled ? color.cgColor : color.withAlphaComponent(0.15).cgColor
        invalidateIntrinsicContentSize()
    }
}

/// Multi-line label that wraps to its current width instead of its one-line width.
final class WrappingLabel: NSTextField {
    override func layout() {
        super.layout()
        if abs(preferredMaxLayoutWidth - bounds.width) > 0.5 {
            preferredMaxLayoutWidth = bounds.width
            invalidateIntrinsicContentSize()
        }
    }
    override var intrinsicContentSize: NSSize {
        let s = super.intrinsicContentSize
        return NSSize(width: NSView.noIntrinsicMetric, height: s.height)
    }
}

func label(_ s: String, size: CGFloat = 13, weight: NSFont.Weight = .regular, color: NSColor = .labelColor, lines: Int = 1) -> NSTextField {
    let l = lines == 1 ? NSTextField(labelWithString: s) : WrappingLabel(labelWithString: s)
    // page titles use the site's serif (it looks smaller than the system font at the same size)
    l.font = size >= 20 && Theme.web ? Theme.serif(size * 1.35) : .systemFont(ofSize: size, weight: weight)
    l.textColor = color
    l.lineBreakMode = .byTruncatingTail
    l.maximumNumberOfLines = lines
    l.cell?.truncatesLastVisibleLine = true
    if lines != 1 { l.cell?.wraps = true; l.lineBreakMode = .byWordWrapping }
    l.translatesAutoresizingMaskIntoConstraints = false
    l.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return l
}

func button(_ title: String, symbol: String? = nil, style: NSButton.BezelStyle = .rounded, target: AnyObject?, action: Selector?) -> NSButton {
    let b = NSButton(title: title, target: target, action: action)
    b.bezelStyle = style
    if let symbol, let img = Theme.icon(symbol, title) {
        b.image = img
        b.imagePosition = title.isEmpty ? .imageOnly : .imageLeading
    }
    b.translatesAutoresizingMaskIntoConstraints = false
    return b
}

/// Draws a button as on the website: paper fill, ink border, a hard shadow; it moves onto its
/// shadow while pressed. A prominent button (bezelColor = ink) is ink with paper text.
final class InkButtonCell: NSButtonCell {
    private var small: Bool { controlSize == .small || controlSize == .mini }
    private var shadow: CGFloat { small ? 2 : 3 }
    private var tint: NSColor? { (controlView as? NSButton)?.bezelColor }
    private var dark: Bool { tint == Theme.ink }
    private var inkFont: NSFont { .systemFont(ofSize: small ? 12 : 13, weight: .semibold) }

    override var cellSize: NSSize {
        let h: CGFloat = small ? 25 : 31
        if title.isEmpty { return NSSize(width: h, height: h) }
        let tw = ceil((title as NSString).size(withAttributes: [.font: inkFont]).width)
        let iw: CGFloat = image == nil ? 0 : (image!.size.width * (small ? 0.8 : 1) + 5)
        return NSSize(width: tw + iw + (small ? 20 : 26) + shadow, height: h)
    }
    // text and icon keep a distance from the border
    private func padded(_ b: NSRect) -> NSRect { title.isEmpty ? b : b.insetBy(dx: small ? 9 : 12, dy: 0) }
    override func titleRect(forBounds rect: NSRect) -> NSRect { super.titleRect(forBounds: padded(rect)) }
    override func imageRect(forBounds rect: NSRect) -> NSRect { super.imageRect(forBounds: padded(rect)) }
    override func drawBezel(withFrame frame: NSRect, in controlView: NSView) {
        var r = NSRect(x: frame.minX + 1, y: frame.minY + 1, width: frame.width - 2 - shadow, height: frame.height - 2 - shadow)
        let radius = bezelStyle == .circular ? r.height / 2 : (small ? 7 : 9)
        if isHighlighted {
            r = r.offsetBy(dx: shadow - 1, dy: shadow - 1)
        } else {
            Theme.ink.withAlphaComponent(isEnabled ? 0.18 : 0.08).setFill()
            NSBezierPath(roundedRect: r.offsetBy(dx: shadow, dy: shadow), xRadius: radius, yRadius: radius).fill()
        }
        let p = NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius)
        let fill = tint.map { $0 == Theme.ink ? $0 : (Theme.panel.blended(withFraction: 0.55, of: $0) ?? $0) } ?? Theme.panel
        (isEnabled ? fill : (Theme.paper.blended(withFraction: 0.5, of: fill) ?? fill)).setFill()
        p.fill()
        Theme.ink.withAlphaComponent(isEnabled ? 1 : 0.35).setStroke()
        p.lineWidth = small ? 1.5 : 1.8
        p.stroke()
    }
    private func content(_ frame: NSRect) -> NSRect {
        frame.offsetBy(dx: isHighlighted ? shadow / 2 - 0.5 : -shadow / 2, dy: isHighlighted ? shadow / 2 - 0.5 : -shadow / 2)
    }
    override func drawTitle(_ title: NSAttributedString, withFrame frame: NSRect, in controlView: NSView) -> NSRect {
        let t = NSMutableAttributedString(attributedString: title)
        let all = NSRange(location: 0, length: t.length)
        t.addAttribute(.foregroundColor, value: (dark ? Theme.panel : Theme.ink).withAlphaComponent(isEnabled ? 1 : 0.4), range: all)
        t.addAttribute(.font, value: inkFont, range: all)
        return super.drawTitle(t, withFrame: content(frame), in: controlView)
    }
    override func drawImage(_ image: NSImage, withFrame frame: NSRect, in controlView: NSView) {
        var img = image
        if dark {   // ink icons on an ink button: draw them in the paper colour
            img = NSImage(size: image.size, flipped: false) { r in
                image.draw(in: r)
                Theme.panel.set()
                r.fill(using: .sourceAtop)
                return true
            }
        }
        var f = content(frame)
        if small { f = f.insetBy(dx: f.width * 0.1, dy: f.height * 0.1) }
        img.draw(in: f, from: .zero, operation: .sourceOver, fraction: isEnabled ? 1 : 0.4, respectFlipped: true, hints: nil)
    }
}

/// A button that runs a closure.
final class ActionButton: NSButton {
    override class var cellClass: AnyClass? { get { Theme.web ? InkButtonCell.self : NSButtonCell.self } set {} }
    var handler: (() -> Void)?
    convenience init(_ title: String, symbol: String? = nil, prominent: Bool = false, handler: @escaping () -> Void) {
        self.init(title: title, target: nil, action: nil)
        self.handler = handler
        target = self
        action = #selector(fire)
        bezelStyle = Theme.web ? .smallSquare : .rounded   // website: the cell draws the button itself (InkButtonCell)
        controlSize = .regular
        if let symbol, let img = Theme.icon(symbol, title) {
            image = img
            imagePosition = title.isEmpty ? .imageOnly : .imageLeading
        }
        if prominent { bezelColor = Theme.accent; keyEquivalent = "" }
        translatesAutoresizingMaskIntoConstraints = false
    }
    @objc private func fire() { handler?() }
}

/// Rounded card that highlights on hover and reports clicks.
class CardView: FlippedView {
    // Only a card with a click action looks clickable (hover, hand cursor, button role).
    // A card that only highlighted on hover but did nothing on click confused the user (Home's requests).
    var onClick: (() -> Void)? { didSet { window?.invalidateCursorRects(for: self); refresh() } }
    var onMenu: ((NSEvent) -> NSMenu?)?
    var highlighted = false { didSet { refresh() } }
    var tint: NSColor? { didSet { refresh() } }
    private var hovering = false { didSet { refresh() } }
    private var tracking: NSTrackingArea?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = Theme.web ? 14 : 12
        layer?.borderWidth = Theme.web ? 2 : 1
        Theme.hardShadow(layer)
        translatesAutoresizingMaskIntoConstraints = false
        refresh()
    }
    required init?(coder: NSCoder) { fatalError() }

    override func updateLayer() { refresh() }
    override var wantsUpdateLayer: Bool { true }

    func refresh() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            if Theme.web {
                let base = tint.flatMap { Theme.panel.blended(withFraction: 0.14, of: $0) } ?? Theme.panel
                layer?.backgroundColor = (hovering && onClick != nil ? base.blended(withFraction: 0.06, of: Theme.ink) ?? base : base).cgColor
                layer?.borderColor = (tint ?? (highlighted ? Theme.you : Theme.ink)).cgColor
            } else {
                let base = tint?.withAlphaComponent(0.12) ?? NSColor.controlBackgroundColor
                layer?.backgroundColor = (hovering && onClick != nil ? base.blended(withFraction: 0.06, of: .labelColor) ?? base : base).cgColor
                layer?.borderColor = (tint.map { $0.withAlphaComponent(0.6) } ?? (highlighted ? Theme.accent : NSColor.separatorColor)).cgColor
            }
        }
    }

    override func updateTrackingAreas() {
        if let tracking { removeTrackingArea(tracking) }
        tracking = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(tracking!)
    }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func mouseUp(with event: NSEvent) {
        if bounds.contains(convert(event.locationInWindow, from: nil)) { onClick?() }
    }
    override func menu(for event: NSEvent) -> NSMenu? { onMenu?(event) }

    // Accessible as a button, so agents and VoiceOver can press it.
    var accessibleName = ""
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { onClick != nil ? .button : .group }
    override func accessibilityLabel() -> String? { accessibleName }
    override func accessibilityPerformPress() -> Bool { onClick?(); return onClick != nil }
    override func resetCursorRects() { if onClick != nil { addCursorRect(bounds, cursor: .pointingHand) } }
}

/// Transient message at the bottom of the main window.
enum Toast {
    private static var view: NSTextField?
    private static var work: DispatchWorkItem?

    static func show(_ text: String) {
        guard let content = NSApp.mainWindow?.contentView ?? NSApp.windows.first?.contentView else { return }
        view?.removeFromSuperview()
        let l = NSTextField(labelWithString: "  \(text)  ")
        l.font = .systemFont(ofSize: 13, weight: .medium)
        l.textColor = .white
        l.wantsLayer = true
        l.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.8).cgColor
        l.layer?.cornerRadius = 8
        l.alignment = .center
        l.lineBreakMode = .byTruncatingTail
        l.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(l)
        NSLayoutConstraint.activate([
            l.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            l.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -24),
            l.heightAnchor.constraint(equalToConstant: 30),
            l.widthAnchor.constraint(lessThanOrEqualTo: content.widthAnchor, multiplier: 0.8),
        ])
        view = l
        work?.cancel()
        let w = DispatchWorkItem { l.removeFromSuperview() }
        work = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: w)
    }
}

/// Context menu shared by cards, rows and the detail header.
enum SessionMenu {
    static func make(for s: Session, open: @escaping () -> Void, rename: @escaping () -> Void) -> NSMenu {
        let m = NSMenu()
        func add(_ title: String, _ fn: @escaping () -> Void) {
            let item = ClosureMenuItem(title: title, handler: fn)
            m.addItem(item)
        }
        add("Open", open)
        if s.isPending {
            // a new session on a helper, not started: closing it cancels it there and removes its folder
            add(s.sessionState == .preparing ? "Cancel" : "Remove") { close(s) }
            return m
        }
        add("Rename…", rename)
        if s.isRemote {
            // a helper computer's session (lib/peer.ts ACTIONS): no folder on this Mac; it closes on the helper
            if !s.running { add(s.sid.isEmpty ? "Start" : "Resume") { Backend.shared.post("start", ["id": s.id]) } }
            if s.sessionState == .working { add("Stop (Esc)") { Backend.shared.post("interrupt", ["id": s.id]) } }
            if s.canFetch {
                m.addItem(.separator())
                add(s.isFetching ? "Cancel Fetch" : "Fetch Result") { fetch(s) }
            }
            if !s.isOffline {
                m.addItem(.separator())
                add("Close Session") { close(s) }
            }
            return m
        }
        if !s.running { add(s.sid.isEmpty ? "Start" : "Resume") { Backend.shared.post("start", ["id": s.id]) } }
        if s.sessionState == .working { add("Stop (Esc)") { Backend.shared.post("interrupt", ["id": s.id]) } }
        m.addItem(.separator())
        add("New Session in This Folder") { AppDelegate.shared.window.showNewSession(folder: s.folder) }
        add("Show in Finder") { Backend.shared.post("reveal", ["folder": s.folder]) }
        add("Open in VS Code") { Backend.shared.post("reveal", ["folder": s.folder, "app": "code"]) }
        m.addItem(.separator())
        add("Close Session") { close(s) }
        return m
    }

    /// "Fetch result" of a helper session: its committed work becomes a branch helper/<device>/<name>
    /// in the matching repository here (never the current branch, index or working tree). Answers at
    /// once; the row's `fetch` shows the progress. While it runs, the same item cancels it.
    static func fetch(_ s: Session) {
        if s.isFetching { Backend.shared.post("fetchCancel", ["id": s.id]); return }
        Backend.shared.post("fetchResult", ["id": s.id, "fetchId": newFetchId()])
    }
    static func newFetchId() -> String {
        (0..<8).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }

    /// Closes at once, with no confirmation: the conversation is saved and can be resumed from New Session.
    static func close(_ s: Session) {
        Backend.shared.post("close", ["id": s.id])
        AppDelegate.shared.window.sessionClosed(s.id)
    }

    static func askRename(_ s: Session) {
        let a = NSAlert()
        a.messageText = "Rename Session"
        a.addButton(withTitle: "Rename")
        a.addButton(withTitle: "Cancel")
        let f = NSTextField(string: s.name)
        f.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
        a.accessoryView = f
        a.window.initialFirstResponder = f
        if a.runModal() == .alertFirstButtonReturn {
            let n = f.stringValue.trimmingCharacters(in: .whitespaces)
            if !n.isEmpty && n != s.name { Backend.shared.post("rename", ["id": s.id, "name": n]) }
        }
    }
}

final class ClosureMenuItem: NSMenuItem {
    private var handler: () -> Void
    init(title: String, handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(fire), keyEquivalent: "")
        target = self
    }
    required init(coder: NSCoder) { fatalError() }
    @objc private func fire() { handler() }
}
