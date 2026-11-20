import AppKit

/// One Claude Code command, from GET /api/commands (lib/commands.ts).
struct Command: Decodable {
    let name: String
    let description: String
    let hint: String
    let folders: [String]?   // a project command: only the sessions in these folders have it
}
private struct CommandList: Decodable { let commands: [Command] }

/// A list under the Ask box, built on NSScrollView + NSTableView like the system's own lists: pixel
/// scrolling with momentum and elastic edges, the native scroller (drag it to scroll fast), Up/Down
/// move the selection and the list scrolls smoothly to keep it on screen, the mouse selects the row
/// under it, Enter or a click picks. At most `visible` rows tall.
final class SuggestionList: NSView, NSTableViewDataSource, NSTableViewDelegate {
    struct Item { let title: String; let detail: String }
    private let header = label("", size: 11, weight: .semibold, color: .secondaryLabelColor)
    private let scroll = NSScrollView()
    private let table = NSTableView()
    private var height: NSLayoutConstraint!
    private(set) var items: [Item] = []
    private(set) var selected = 0
    private let visible = 8
    private let rowHeight: CGFloat = 30
    // Where the mouse was when the selection last changed. A row that scrolls in under a mouse that
    // did not move must not take the selection from the arrow keys (the keys looked stuck).
    private var mouseAt = NSEvent.mouseLocation
    var onPick: ((Int) -> Void)?

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 12
        layer?.borderWidth = 1
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityElement(true)
        setAccessibilityRole(.list)
        setAccessibilityIdentifier("home.commands")

        let column = NSTableColumn(identifier: .init("item"))
        table.addTableColumn(column)
        table.headerView = nil
        table.style = .plain                        // no extra inset above the first row
        table.rowHeight = rowHeight
        table.intercellSpacing = .zero
        table.backgroundColor = .clear
        table.selectionHighlightStyle = .none
        table.focusRingType = .none
        table.refusesFirstResponder = true          // the Ask box keeps the keys
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.action = #selector(clicked)

        scroll.documentView = table
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.scrollerStyle = .overlay
        scroll.autohidesScrollers = true
        scroll.verticalScrollElasticity = .allowed
        scroll.automaticallyAdjustsContentInsets = false
        scroll.contentInsets = NSEdgeInsets(top: 0, left: 4, bottom: 0, right: 4)
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.verticalScroller?.setAccessibilityIdentifier("home.commands.scroll")

        [header, scroll].forEach { addSubview($0) }
        height = scroll.heightAnchor.constraint(equalToConstant: rowHeight)
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            header.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            header.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            scroll.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 4),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
            height,
        ])
        isHidden = true
        refreshColors()
    }
    required init?(coder: NSCoder) { fatalError() }

    func show(_ items: [Item], title: String) {
        self.items = items
        header.stringValue = title
        selected = 0
        mouseAt = NSEvent.mouseLocation
        isHidden = items.isEmpty
        setAccessibilityLabel(title)
        height.constant = rowHeight * CGFloat(max(1, min(items.count, visible)))
        table.reloadData()
        table.sizeLastColumnToFit()
        scroll.contentView.scroll(to: .zero)
        scroll.reflectScrolledClipView(scroll.contentView)
    }
    func hide() {
        items = []
        isHidden = true
        table.reloadData()
    }

    func move(_ by: Int) {
        guard !items.isEmpty else { return }
        mouseAt = NSEvent.mouseLocation
        select((selected + by + items.count) % items.count)
        reveal(selected)
    }

    /// The mouse is over row `i`: it becomes the selected row (Enter then picks it, as a click does).
    func hover(_ i: Int) {
        let now = NSEvent.mouseLocation
        guard now != mouseAt else { return }   // the row moved under the mouse, the mouse did not move
        mouseAt = now
        select(i)
    }

    private func select(_ i: Int) {
        guard items.indices.contains(i), i != selected else { return }
        let old = selected
        selected = i
        for r in [old, i] { (table.view(atColumn: 0, row: r, makeIfNecessary: false) as? SuggestionRow)?.setSelected(r == i) }
    }

    /// Scroll just enough to show row `i`, with the short animation the system lists use.
    private func reveal(_ i: Int) {
        let row = table.rect(ofRow: i)
        let clip = scroll.contentView
        var origin = clip.bounds.origin
        if row.minY < origin.y { origin.y = row.minY }
        else if row.maxY > origin.y + clip.bounds.height { origin.y = row.maxY - clip.bounds.height }
        else { return }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.12
            ctx.allowsImplicitAnimation = true
            clip.animator().setBoundsOrigin(origin)
        }
        scroll.reflectScrolledClipView(clip)
    }

    @objc private func clicked() {
        let r = table.clickedRow
        if items.indices.contains(r) { onPick?(r) }
    }

    func numberOfRows(in tableView: NSTableView) -> Int { items.count }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let v = SuggestionRow(items[row], index: row, selected: row == selected,
                              hover: { [weak self] in self?.hover(row) }) { [weak self] in self?.onPick?(row) }
        let index = row + 1
        v.setAccessibilityIdentifier("home.commands.\(index)")
        return v
    }

    override func viewDidChangeEffectiveAppearance() { refreshColors(); table.reloadData() }
    private func refreshColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = Theme.panel.cgColor
            layer?.borderColor = (Theme.web ? Theme.ink : NSColor.separatorColor).cgColor
            layer?.borderWidth = Theme.web ? 2 : 1
        }
    }
}

private final class SuggestionRow: NSView {
    private let pick: () -> Void
    private let hover: () -> Void
    private let name: String
    let index: Int
    init(_ item: SuggestionList.Item, index: Int, selected: Bool, hover: @escaping () -> Void, pick: @escaping () -> Void) {
        self.pick = pick
        self.hover = hover
        self.index = index
        self.name = item.detail.isEmpty ? item.title : "\(item.title): \(item.detail)"
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 8
        let title = label(item.title, size: 13, weight: .semibold)
        title.setContentCompressionResistancePriority(.required, for: .horizontal)
        title.setContentHuggingPriority(.required, for: .horizontal)
        let detail = label(item.detail, size: 12, color: .secondaryLabelColor)
        [title, detail].forEach { addSubview($0) }
        NSLayoutConstraint.activate([
            title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            title.centerYAnchor.constraint(equalTo: centerYAnchor),
            title.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, multiplier: 0.5),
            detail.leadingAnchor.constraint(equalTo: title.trailingAnchor, constant: 12),
            detail.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            detail.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        setSelected(selected)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeInKeyWindow, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }
    required init?(coder: NSCoder) { fatalError() }
    func setSelected(_ on: Bool) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = on ? Theme.you.withAlphaComponent(0.16).cgColor : NSColor.clear.cgColor
        }
        setAccessibilitySelected(on)
    }
    override func mouseEntered(with event: NSEvent) { hover() }
    override func mouseMoved(with event: NSEvent) { hover() }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .button }
    override func accessibilityLabel() -> String? { name }
    override func accessibilityPerformPress() -> Bool { pick(); return true }
}

/// Claude Code commands in the Ask box. Typing "/" lists the commands; sending a command asks which
/// session runs it (or a new session). A command never goes through the router: it must reach
/// the session as typed, and "/clear" in the wrong session would lose that session's context.
final class CommandPicker {
    private enum Mode { case none, commands([Command]), sessions(text: String, files: [String], targets: [Target]) }
    private struct Target { let id: String?; let title: String; let detail: String }   // id nil = a new session

    private let composer: ComposerBox
    private let list: SuggestionList
    private var mode = Mode.none
    private var commands: [Command] = []
    private var loadedAt = Date.distantPast
    private var loading = false
    private var dismissedFor: String?   // Esc closed the list for this text
    private var askedOnSend = false     // the list was asked for once because of a send

    init(composer: ComposerBox, list: SuggestionList) {
        self.composer = composer
        self.list = list
        composer.text.onKey = { [weak self] e in self?.key(e) ?? false }
        composer.interceptSend = { [weak self] t, files in self?.sending(t, files) ?? false }
        list.onPick = { [weak self] i in self?.pick(i) }
        NotificationCenter.default.addObserver(forName: NSText.didChangeNotification, object: composer.text, queue: .main) { [weak self] _ in
            self?.textChanged()
        }
        load {}   // ready before the first "/"
    }

    /// "/name" or "/name args" → the name; other text (also a file path such as /Users/me/a.txt) → nil.
    static func commandName(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("/") else { return nil }
        let name = String(t.dropFirst().prefix { !$0.isWhitespace })
        guard let f = name.first, f.isLetter || f.isNumber else { return nil }
        return name.allSatisfy({ $0.isLetter || $0.isNumber || "_:.-".contains($0) }) ? name : nil
    }

    /// The commands for what is typed after "/": names that start with it, then names that
    /// contain it, then descriptions that contain it.
    static func matches(_ all: [Command], _ query: String) -> [Command] {
        let q = query.lowercased()
        if q.isEmpty { return all }
        var starts: [Command] = [], inName: [Command] = [], inText: [Command] = []
        for c in all {
            let n = c.name.lowercased()
            // "brain" finds "superpowers:brainstorming": the part after the plugin name counts as a start
            if n.hasPrefix(q) || n.split(separator: ":").last.map({ $0.hasPrefix(q) }) == true { starts.append(c) }
            else if n.contains(q) { inName.append(c) }
            else if c.description.lowercased().contains(q) { inText.append(c) }
        }
        return starts + inName + inText
    }

    /// Calls `done` when the list is here: at once when it is fresh, else after the running (or a
    /// new) request for it. Callers that come while a request runs wait for that request.
    private func load(_ done: @escaping () -> Void) {
        if Date().timeIntervalSince(loadedAt) < 30 { return done() }
        waiters.append(done)
        if loading { return }
        loading = true
        Backend.shared.get("api/commands", as: CommandList.self) { [weak self] r in
            guard let self else { return }
            self.loading = false
            if let r, !r.commands.isEmpty { self.commands = r.commands; self.loadedAt = Date() }
            let w = self.waiters
            self.waiters = []
            w.forEach { $0() }
        }
    }
    private var waiters: [() -> Void] = []

    private func textChanged() {
        let t = composer.text.string
        if t != dismissedFor { dismissedFor = nil }
        // the command list shows while the text is one word that starts with "/"
        guard t.hasPrefix("/"), !t.contains(where: { $0.isWhitespace }), dismissedFor == nil else { return close() }
        showCommands(for: t)
        load { [weak self] in
            guard let self, self.composer.text.string == t, self.dismissedFor == nil else { return }
            self.showCommands(for: t)
        }
    }

    private func showCommands(for text: String) {
        let found = Self.matches(commands, String(text.dropFirst()))
        if found.isEmpty { return close() }
        mode = .commands(found)
        list.show(found.map { .init(title: "/\($0.name)", detail: $0.hint.isEmpty ? $0.description : "\($0.hint)  \($0.description)") },
                  title: "Claude Code commands · ↑↓ to choose · Enter to pick · Esc to close")
    }

    private func close() {
        mode = .none
        list.hide()
    }

    /// Keys while a list is open. true = the key is used here and does not reach the text view.
    private func key(_ e: NSEvent) -> Bool {
        if case .none = mode { return false }
        switch e.keyCode {
        case 125: list.move(1); return true      // Down
        case 126: list.move(-1); return true     // Up
        case 53:                                 // Esc
            dismissedFor = composer.text.string
            close()
            return true
        case 48: pick(list.selected); return true   // Tab
        case 36, 76:                                // Return
            guard !e.modifierFlags.contains(.shift) else { return false }
            // the whole name is typed: Enter sends it (and asks for the session), it does not only fill the name in
            if case .commands(let found) = mode, found.indices.contains(list.selected),
               "/\(found[list.selected].name)" == composer.text.string { close(); return false }
            pick(list.selected)
            return true
        default: return false
        }
    }

    private func pick(_ i: Int) {
        switch mode {
        case .none: return
        case .commands(let found):
            guard found.indices.contains(i) else { return }
            close()
            composer.setText("/\(found[i].name) ")   // ready for arguments; Enter sends
        case .sessions(let text, let files, let targets):
            guard targets.indices.contains(i) else { return }
            close()
            composer.clear()
            RouteWatcher.shared.sendCommand(text, files, target: targets[i].id, name: targets[i].title)
        }
    }

    /// The Ask box is about to send `text`. A known command is not sent yet: the user chooses the
    /// session first (true = the box keeps the text). Other text goes to the router as before.
    private func sending(_ text: String, _ files: [String]) -> Bool {
        guard let name = Self.commandName(text) else { return false }
        if commands.isEmpty {
            if !askedOnSend {
                // the list is not here yet (a draft sent right after the app started): get it, then send again
                askedOnSend = true
                loadedAt = .distantPast
                load { [weak self] in self?.composer.submit() }
                return true
            }
            // still no list (the server could not ask Claude Code): never send a command to the router
            askedOnSend = false
            Toast.show("Could not load Claude Code's commands. Try again in a moment.")
            return true
        }
        askedOnSend = false
        guard let command = commands.first(where: { $0.name == name }) else { return false }
        if case .sessions = mode { pick(list.selected); return true }
        var targets = Backend.shared.sessions
            .filter { !$0.isCodex && (command.folders == nil || command.folders!.contains($0.folder)) }
            .sorted { $0.activity > $1.activity }
            .map { Target(id: $0.id, title: $0.name, detail: "\($0.folderName) · \($0.sessionState.label)") }
        if command.folders == nil {
            let folder = (Backend.shared.defaultFolder as NSString).lastPathComponent
            targets.append(Target(id: nil, title: "New session", detail: folder.isEmpty ? "the default folder" : "in \(folder)"))
        }
        guard !targets.isEmpty else { Toast.show("No open session has /\(name)"); return true }
        mode = .sessions(text: text, files: files, targets: targets)
        list.show(targets.map { .init(title: $0.title, detail: $0.detail) }, title: "Run /\(name) in · ↑↓ to choose · Enter to send · Esc to cancel")
        return true
    }
}
