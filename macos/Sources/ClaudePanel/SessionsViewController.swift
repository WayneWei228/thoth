import AppKit

/// All Sessions, grouped by project folder (like Projects in the Claude app).
final class SessionsViewController: NSViewController {
    private let stack = NSStackView()
    private let search = NSSearchField()
    private var lastKey = ""

    override func loadView() {
        let root = NSView()
        let title = label("All Sessions", size: 24, weight: .semibold)
        let sub = label("Grouped by project folder. Click a card to open it.", size: 13, color: .secondaryLabelColor)
        search.placeholderString = "Filter"
        search.setAccessibilityIdentifier("sessions.filter")
        search.translatesAutoresizingMaskIntoConstraints = false
        search.target = self
        search.action = #selector(filterChanged)
        let newBtn = ActionButton("New Session", symbol: "plus", prominent: true) { AppDelegate.shared.window.showNewSession() }
        newBtn.setAccessibilityIdentifier("sessions.newSession")
        title.setAccessibilityIdentifier("sessions.title")

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        let doc = FlippedView()
        doc.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = doc
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 26
        stack.translatesAutoresizingMaskIntoConstraints = false
        doc.addSubview(stack)

        [title, sub, search, newBtn, scroll].forEach { root.addSubview($0) }
        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: root.topAnchor, constant: 44),
            title.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 32),
            sub.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 4),
            sub.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            newBtn.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -32),
            newBtn.centerYAnchor.constraint(equalTo: title.centerYAnchor),
            search.trailingAnchor.constraint(equalTo: newBtn.leadingAnchor, constant: -10),
            search.centerYAnchor.constraint(equalTo: title.centerYAnchor),
            search.widthAnchor.constraint(equalToConstant: 200),
            scroll.topAnchor.constraint(equalTo: sub.bottomAnchor, constant: 18),
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            doc.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            doc.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            doc.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            stack.topAnchor.constraint(equalTo: doc.topAnchor, constant: 6),
            stack.leadingAnchor.constraint(equalTo: doc.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: doc.trailingAnchor, constant: -32),
            stack.bottomAnchor.constraint(equalTo: doc.bottomAnchor, constant: -32),
        ])
        view = root
    }

    @objc private func filterChanged() { lastKey = ""; reload() }

    func reload() {
        guard isViewLoaded else { return }
        let f = search.stringValue.lowercased()
        let sessions = Backend.shared.sessions.filter {
            f.isEmpty || "\($0.name) \($0.folder) \($0.title ?? "") \($0.last)".lowercased().contains(f)
        }
        let key = sessions.map { "\($0.id)\($0.agentId)\($0.name)\($0.state)\($0.last)\($0.title ?? "")\($0.prompt ?? "")" }.joined() + f
        if key == lastKey { return }
        lastKey = key

        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if sessions.isEmpty {
            let empty = label(f.isEmpty ? "No sessions yet. Click New Session to start one." : "No session matches.", size: 14, color: .secondaryLabelColor)
            stack.addArrangedSubview(empty)
            return
        }
        // group by folder; groups with sessions that need the user come first
        var groups: [String: [Session]] = [:]
        for s in sessions { groups[s.folder, default: []].append(s) }
        let ordered = groups.sorted { a, b in
            let ra = a.value.map { $0.sessionState.rank }.min() ?? 9, rb = b.value.map { $0.sessionState.rank }.min() ?? 9
            if ra != rb { return ra < rb }
            return (a.value.map(\.activity).max() ?? 0) > (b.value.map(\.activity).max() ?? 0)
        }
        for (folder, items) in ordered {
            stack.addArrangedSubview(section(folder: folder, items: items.sorted { $0.sessionState.rank < $1.sessionState.rank }))
        }
        for v in stack.arrangedSubviews { v.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
    }

    private func section(folder: String, items: [Session]) -> NSView {
        let v = NSView()
        v.translatesAutoresizingMaskIntoConstraints = false
        let icon = NSImageView(image: Theme.icon("folder.fill", nil)!)
        icon.contentTintColor = Theme.accent
        icon.translatesAutoresizingMaskIntoConstraints = false
        let name = label((folder as NSString).lastPathComponent, size: 15, weight: .semibold)
        let branch = items.first?.branch ?? ""
        let path = label(shortPath(folder) + (branch.isEmpty ? "" : "  ·  ⎇ \(branch)"), size: 12, color: .secondaryLabelColor)
        let add = ActionButton("New Session Here", symbol: "plus") { AppDelegate.shared.window.showNewSession(folder: folder) }
        add.controlSize = .small
        let grid = CardGrid()
        for s in items { grid.add(card(s)) }
        [icon, name, path, add, grid].forEach { v.addSubview($0) }
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: v.leadingAnchor),
            icon.centerYAnchor.constraint(equalTo: name.centerYAnchor),
            name.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
            name.topAnchor.constraint(equalTo: v.topAnchor),
            path.leadingAnchor.constraint(equalTo: name.trailingAnchor, constant: 10),
            path.firstBaselineAnchor.constraint(equalTo: name.firstBaselineAnchor),
            path.trailingAnchor.constraint(lessThanOrEqualTo: add.leadingAnchor, constant: -10),
            add.trailingAnchor.constraint(equalTo: v.trailingAnchor),
            add.centerYAnchor.constraint(equalTo: name.centerYAnchor),
            grid.topAnchor.constraint(equalTo: name.bottomAnchor, constant: 12),
            grid.leadingAnchor.constraint(equalTo: v.leadingAnchor),
            grid.trailingAnchor.constraint(equalTo: v.trailingAnchor),
            grid.bottomAnchor.constraint(equalTo: v.bottomAnchor),
        ])
        return v
    }

    private func card(_ s: Session) -> NSView {
        let c = CardView()
        if s.sessionState == .needs { c.tint = Theme.red }
        c.onClick = { AppDelegate.shared.window.show(.session(s.id)) }
        c.accessibleName = "\(s.name), \(s.sessionState.label)"
        c.setAccessibilityIdentifier("card.\(s.name)")
        c.onMenu = { _ in SessionMenu.make(for: s, open: { AppDelegate.shared.window.show(.session(s.id)) }, rename: { SessionMenu.askRename(s) }) }
        let dot = StatusDot(); dot.state = s.sessionState
        let name = label(s.name, size: 14, weight: .semibold)
        let pill = Pill(); pill.set(s.sessionState)
        let title = label(s.title ?? "", size: 12, color: .secondaryLabelColor)
        let you = label(s.prompt.map { "You: \($0)" } ?? "", size: 12, color: .tertiaryLabelColor)
        let reply = label(s.sessionState == .needs ? (s.question.isEmpty ? "Waiting for your choice" : s.question) : (s.last.isEmpty ? "—" : s.last), size: 12, lines: 3)
        [dot, name, pill, title, you, reply].forEach { c.addSubview($0) }
        if let badge = Pill.agent(s.agentId) {
            c.addSubview(badge)
            NSLayoutConstraint.activate([
                badge.leadingAnchor.constraint(equalTo: name.trailingAnchor, constant: 6),
                badge.centerYAnchor.constraint(equalTo: name.centerYAnchor),
                badge.trailingAnchor.constraint(lessThanOrEqualTo: pill.leadingAnchor, constant: -6),
            ])
        } else {
            name.trailingAnchor.constraint(lessThanOrEqualTo: pill.leadingAnchor, constant: -6).isActive = true
        }
        NSLayoutConstraint.activate([
            dot.leadingAnchor.constraint(equalTo: c.leadingAnchor, constant: 14),
            dot.centerYAnchor.constraint(equalTo: name.centerYAnchor),
            name.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 8),
            name.topAnchor.constraint(equalTo: c.topAnchor, constant: 12),
            pill.trailingAnchor.constraint(equalTo: c.trailingAnchor, constant: -12),
            pill.centerYAnchor.constraint(equalTo: name.centerYAnchor),
            title.leadingAnchor.constraint(equalTo: name.leadingAnchor),
            title.trailingAnchor.constraint(equalTo: c.trailingAnchor, constant: -14),
            title.topAnchor.constraint(equalTo: name.bottomAnchor, constant: 2),
            you.leadingAnchor.constraint(equalTo: c.leadingAnchor, constant: 14),
            you.trailingAnchor.constraint(equalTo: c.trailingAnchor, constant: -14),
            you.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 8),
            reply.leadingAnchor.constraint(equalTo: you.leadingAnchor),
            reply.trailingAnchor.constraint(equalTo: you.trailingAnchor),
            reply.topAnchor.constraint(equalTo: you.bottomAnchor, constant: 4),
            c.heightAnchor.constraint(equalToConstant: 150),
        ])
        return c
    }
}

/// Grid of equal-width cards that reflows with the window width.
final class CardGrid: FlippedView {
    private var cards: [NSView] = []
    private var heightC: NSLayoutConstraint!
    let minWidth: CGFloat = 280, cardHeight: CGFloat = 150, gap: CGFloat = 14

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        heightC = heightAnchor.constraint(equalToConstant: cardHeight)
        heightC.isActive = true
    }
    required init?(coder: NSCoder) { fatalError() }

    func add(_ v: NSView) {
        v.translatesAutoresizingMaskIntoConstraints = true
        // the card's own height constraint is replaced by frame layout
        v.constraints.filter { $0.firstAttribute == .height && $0.secondItem == nil }.forEach { $0.isActive = false }
        cards.append(v)
        addSubview(v)
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let w = bounds.width
        guard w > 0 else { return }
        let cols = max(1, Int((w + gap) / (minWidth + gap)))
        let cw = (w - gap * CGFloat(cols - 1)) / CGFloat(cols)
        for (i, v) in cards.enumerated() {
            let r = i / cols, c = i % cols
            v.frame = NSRect(x: CGFloat(c) * (cw + gap), y: CGFloat(r) * (cardHeight + gap), width: cw, height: cardHeight)
        }
        let rows = (cards.count + cols - 1) / cols
        let h = CGFloat(rows) * cardHeight + CGFloat(max(0, rows - 1)) * gap
        if abs(heightC.constant - h) > 0.5 { heightC.constant = max(h, 1) }
    }
}
