import AppKit

/// The macOS permission guide, like `agent-desktop permissions --guide` (user, 2026-11-15):
/// System Settings opens at the right Privacy & Security pane and comes to the front; a small
/// floating window next to it shows the app's icon, which the user drags into the list.
/// It checks the state every second (GET /api/permissions, the probe that runs in the sessions' tmux
/// server) and goes on to the next missing permission by itself.
/// Setup does not ask for permissions (user, 2026-11-15): the server sends `permAsk` when a session's
/// tool failed for want of one (lib/permneed.js), and `ask` first says why, with Allow / Not now.
final class PermissionGuide: NSObject, NSWindowDelegate {
    static let shared = PermissionGuide()

    struct Perm { let id: String; let name: String; let pane: String }

    private var panel: NSPanel?
    private var queue: [Perm] = []
    private var current: Perm?
    private var app = Bundle.main.bundleURL
    private var timer: Timer?
    private var advancing = false
    private let titleLabel = NSTextField(labelWithString: "")
    private let stepsLabel = NSTextField(wrappingLabelWithString: "")
    private let statusLabel = NSTextField(labelWithString: "")
    private let tile = AppDragTile()
    private let allowButton = NSButton(title: "Allow…", target: nil, action: nil)
    private let laterButton = NSButton(title: "Not now", target: nil, action: nil)
    private let closeButton = NSButton(title: "Close", target: nil, action: nil)
    private var asking: Perm?

    /// A session needs `p`: say why and wait for Allow (then the guide) or Not now.
    func ask(_ p: Perm, appPath: String?, session: String) {
        if current != nil { return }   // the guide is already open
        if let path = appPath, !path.isEmpty, FileManager.default.fileExists(atPath: path) { app = URL(fileURLWithPath: path) }
        else { app = Bundle.main.bundleURL }
        asking = p
        buildPanel()
        let who = session.isEmpty ? "A Claude session" : "The session \u{201C}\(session)\u{201D}"
        let what = p.id == "screen_recording" ? "tried to take a screenshot" : "tried to click or type in another app"
        titleLabel.stringValue = p.id == "screen_recording" ? "Let Claude see the screen?" : "Let Claude use other apps?"
        stepsLabel.stringValue = "\(who) \(what). macOS allows this only with \(p.name) for \(appName).\n"
            + "\(appName) works without it. Allow it only if you want Claude to do this."
        statusLabel.stringValue = ""
        tile.app = app
        setMode(asking: true)
        place(tries: 0)
        panel?.orderFrontRegardless()
    }

    private func setMode(asking a: Bool) {
        tile.isHidden = a
        allowButton.isHidden = !a; laterButton.isHidden = !a; closeButton.isHidden = a
    }

    @objc private func allow() {
        guard let p = asking else { return }
        asking = nil
        start(perms: [p], appPath: app.path)
    }

    /// Start (or switch to) the guide. `perms`: the missing permissions, the clicked one first.
    func start(perms: [Perm], appPath: String?) {
        guard let first = perms.first else { return }
        if let p = appPath, !p.isEmpty, FileManager.default.fileExists(atPath: p) { app = URL(fileURLWithPath: p) }
        else { app = Bundle.main.bundleURL }
        queue = Array(perms.dropFirst())
        show(first)
    }

    private var appName: String { app.deletingPathExtension().lastPathComponent }

    private func show(_ p: Perm) {
        current = p
        asking = nil
        advancing = false
        buildPanel()
        setMode(asking: false)
        titleLabel.stringValue = "Allow \(appName): \(p.name)"
        stepsLabel.stringValue = "1. Drag \(appName) from here into the list in System Settings.\n"
            + "2. Turn on the switch next to \(appName).\n"
            + "Already in the list? Turn it off and on again."
        statusLabel.stringValue = "Waiting for \(p.name)…"
        statusLabel.textColor = .secondaryLabelColor
        tile.app = app
        openPane(p.pane)
        startPolling()
    }

    private func openPane(_ pane: String) {
        guard let url = URL(string: pane) else { return }
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = true
        NSWorkspace.shared.open(url, configuration: cfg) { [weak self] _, _ in
            DispatchQueue.main.async {
                // bring System Settings to the front (it may sit behind the setup window), then
                // put the guide next to its window once that window exists
                NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences").first?.activate()
                self?.place(tries: 10)
            }
        }
    }

    // MARK: panel

    private func buildPanel() {
        if let panel { panel.orderFrontRegardless(); return }
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 300, height: 300),
                        styleMask: [.titled, .closable, .utilityWindow, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.title = "Thoth"
        p.level = .floating
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.delegate = self
        p.setAccessibilityIdentifier("permguide.panel")

        titleLabel.font = .systemFont(ofSize: 14, weight: .semibold)
        titleLabel.setAccessibilityIdentifier("permguide.title")
        stepsLabel.font = .systemFont(ofSize: 12)
        stepsLabel.preferredMaxLayoutWidth = 268
        statusLabel.font = .systemFont(ofSize: 12, weight: .medium)
        statusLabel.setAccessibilityIdentifier("permguide.status")
        tile.setAccessibilityIdentifier("permguide.app")
        closeButton.target = self; closeButton.action = #selector(closePanel)
        closeButton.setAccessibilityIdentifier("permguide.close")
        allowButton.target = self; allowButton.action = #selector(allow)
        allowButton.keyEquivalent = "\r"
        allowButton.setAccessibilityIdentifier("permguide.allow")
        laterButton.target = self; laterButton.action = #selector(closePanel)
        laterButton.setAccessibilityIdentifier("permguide.later")
        let buttons = NSStackView(views: [laterButton, allowButton, closeButton])
        buttons.spacing = 8

        let stack = NSStackView(views: [titleLabel, tile, stepsLabel, statusLabel, buttons])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let root = NSView()
        root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: root.topAnchor), stack.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor), stack.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            stack.widthAnchor.constraint(equalToConstant: 300),
            tile.widthAnchor.constraint(equalToConstant: 120), tile.heightAnchor.constraint(equalToConstant: 104),
        ])
        p.contentView = root
        panel = p
        placeFallback()
        p.orderFrontRegardless()
    }

    /// Next to the System Settings window (its bounds are readable without Screen Recording).
    private func place(tries: Int) {
        guard let panel else { return }
        if asking != nil { placeFallback(); return }
        if let r = settingsWindowFrame() {
            let vis = (NSScreen.screens.first { $0.frame.intersects(r) } ?? NSScreen.main)?.visibleFrame ?? r
            let size = panel.frame.size
            var x = r.maxX + 12
            if x + size.width > vis.maxX { x = r.minX - size.width - 12 }
            if x < vis.minX { x = vis.maxX - size.width - 12 }
            let y = min(max(r.maxY - size.height, vis.minY + 12), vis.maxY - size.height)
            panel.setFrameOrigin(NSPoint(x: x, y: y))
            panel.orderFrontRegardless()
        } else if tries > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.place(tries: tries - 1) }
        }
    }

    private func placeFallback() {
        guard let panel, let vis = NSScreen.main?.visibleFrame else { return }
        panel.setFrameOrigin(NSPoint(x: vis.maxX - panel.frame.width - 24, y: vis.maxY - panel.frame.height - 24))
    }

    private func settingsWindowFrame() -> NSRect? {
        guard let pid = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences").first?.processIdentifier,
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { return nil }
        let mainH = NSScreen.screens.first?.frame.height ?? 0
        for w in list where (w[kCGWindowOwnerPID as String] as? pid_t) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
            guard let b = w[kCGWindowBounds as String] as? [String: CGFloat], let bw = b["Width"], let bh = b["Height"], bw > 200, bh > 200 else { continue }
            // CG coordinates start at the top left of the main screen; AppKit at the bottom left
            return NSRect(x: b["X"] ?? 0, y: mainH - (b["Y"] ?? 0) - bh, width: bw, height: bh)
        }
        return nil
    }

    @objc private func closePanel() { panel?.close() }

    func windowWillClose(_ notification: Notification) {
        timer?.invalidate(); timer = nil
        panel = nil; current = nil; asking = nil; queue = []
    }

    // MARK: state

    private func startPolling() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.check() }
    }

    private func check() {
        guard let cur = current, !advancing else { return }
        var req = URLRequest(url: Backend.shared.base.appendingPathComponent("api/permissions"))
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let o = data.flatMap({ try? JSONSerialization.jsonObject(with: $0) }) as? [String: Any],
                  let checks = o["checks"] as? [[String: Any]] else { return }
            let granted = Set(checks.filter { ($0["perm"] as? Bool) == true && ($0["ok"] as? Bool) == true }.compactMap { $0["id"] as? String })
            DispatchQueue.main.async { if self?.current?.id == cur.id, granted.contains(cur.id) { self?.grantedNow(cur, granted) } }
        }.resume()
    }

    private func grantedNow(_ p: Perm, _ granted: Set<String>) {
        advancing = true
        statusLabel.stringValue = "\(p.name): granted. Thank you."
        statusLabel.textColor = .systemGreen
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self, self.current?.id == p.id else { return }
            self.queue.removeAll { granted.contains($0.id) }
            if self.queue.isEmpty { self.panel?.close(); return }
            self.show(self.queue.removeFirst())
        }
    }
}

/// The app's icon and name; dragging it gives the app's file URL, as a drag from Finder does.
final class AppDragTile: NSView, NSDraggingSource {
    var app: URL? { didSet { needsDisplay = true; setAccessibilityLabel(app.map { "Drag \($0.deletingPathExtension().lastPathComponent) into the list" }) } }

    override init(frame: NSRect) { super.init(frame: frame); translatesAutoresizingMaskIntoConstraints = false; setAccessibilityRole(.button) }
    required init?(coder: NSCoder) { fatalError() }

    private var icon: NSImage? { app.map { NSWorkspace.shared.icon(forFile: $0.path) } }

    override func draw(_ dirtyRect: NSRect) {
        let r = bounds.insetBy(dx: 1, dy: 1)
        let box = NSBezierPath(roundedRect: r, xRadius: 12, yRadius: 12)
        NSColor.controlAccentColor.withAlphaComponent(0.08).setFill(); box.fill()
        NSColor.controlAccentColor.withAlphaComponent(0.6).setStroke()
        box.lineWidth = 1.5; box.setLineDash([5, 4], count: 2, phase: 0); box.stroke()
        icon?.draw(in: NSRect(x: bounds.midX - 32, y: bounds.maxY - 74, width: 64, height: 64))
        let name = (app?.deletingPathExtension().lastPathComponent ?? "") as NSString
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 12, weight: .medium), .foregroundColor: NSColor.labelColor]
        let s = name.size(withAttributes: attrs)
        name.draw(at: NSPoint(x: bounds.midX - s.width / 2, y: 8), withAttributes: attrs)
    }

    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        guard let app else { return }
        let item = NSDraggingItem(pasteboardWriter: app as NSURL)
        let img = icon ?? NSImage()
        item.setDraggingFrame(NSRect(x: bounds.midX - 32, y: bounds.maxY - 74, width: 64, height: 64), contents: img)
        beginDraggingSession(with: [item], event: event, source: self)
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        context == .outsideApplication ? [.copy, .link, .generic] : []
    }
}
