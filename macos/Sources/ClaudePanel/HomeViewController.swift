import AppKit

/// Home: the first thing the user sees. A large Ask box, then what needs the user,
/// then recent requests and where they went.
final class HomeViewController: NSViewController {
    private let stack = NSStackView()
    private let needsStack = NSStackView()
    private let requestsStack = NSStackView()
    private let needsHeader = label("Needs you", size: 13, weight: .semibold, color: .secondaryLabelColor)
    private let requestsHeader = label("Recent requests", size: 13, weight: .semibold, color: .secondaryLabelColor)
    private var composer: ComposerBox!
    private let commandList = SuggestionList()
    private var commandPicker: CommandPicker!
    private var lastRoutesKey = ""

    override func loadView() {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        let doc = FlippedView()
        doc.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = doc

        let greet = label("What should Claude work on?", size: 28, weight: .semibold)
        greet.alignment = .center
        let sub = label("Ask once. It goes to the right session, or a new one in the right folder.", size: 14, color: .secondaryLabelColor)
        sub.alignment = .center
        composer = ComposerBox(placeholder: "Ask anything…", idPrefix: "home.ask") { [weak self] t, files in self?.ask(t, files) }
        composer.minHeight = 70
        composer.draftKey = "home"
        commandPicker = CommandPicker(composer: composer, list: commandList)
        let hint = label("Enter to send · Shift+Enter for a new line · / for Claude Code commands · paste or drop images", size: 11, color: .tertiaryLabelColor)
        hint.alignment = .center

        for s in [needsStack, requestsStack] {
            s.orientation = .vertical
            s.alignment = .leading
            s.spacing = 8
            s.translatesAutoresizingMaskIntoConstraints = false
        }

        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        [greet, sub, composer, commandList, hint].forEach { stack.addArrangedSubview($0) }
        stack.setCustomSpacing(6, after: composer)
        stack.setCustomSpacing(8, after: greet)
        stack.setCustomSpacing(22, after: sub)
        stack.setCustomSpacing(36, after: hint)
        for v in [needsHeader, needsStack, requestsHeader, requestsStack] as [NSView] { stack.addArrangedSubview(v) }
        stack.setCustomSpacing(26, after: needsStack)
        doc.addSubview(stack)

        NSLayoutConstraint.activate([
            doc.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            doc.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
            doc.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            doc.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            stack.topAnchor.constraint(equalTo: doc.topAnchor, constant: 110),
            stack.centerXAnchor.constraint(equalTo: doc.centerXAnchor),
            stack.widthAnchor.constraint(equalTo: doc.widthAnchor, multiplier: 0.86),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 760),
            stack.bottomAnchor.constraint(equalTo: doc.bottomAnchor, constant: -40),
            composer.widthAnchor.constraint(equalTo: stack.widthAnchor),
            commandList.widthAnchor.constraint(equalTo: stack.widthAnchor),
            greet.widthAnchor.constraint(equalTo: stack.widthAnchor),
            sub.widthAnchor.constraint(equalTo: stack.widthAnchor),
            needsHeader.widthAnchor.constraint(equalTo: stack.widthAnchor),
            requestsHeader.widthAnchor.constraint(equalTo: stack.widthAnchor),
            needsStack.widthAnchor.constraint(equalTo: stack.widthAnchor),
            requestsStack.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        view = scroll
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        view.window?.makeFirstResponder(composer.text)
        reload()
    }

    private func ask(_ text: String, _ files: [String]) {
        RouteWatcher.shared.send(text, files)   // a failure shows a sheet with Try Again / Edit
    }

    /// A failed request's text goes back into the Ask box ("Edit" in RouteWatcher's sheet).
    func restore(_ text: String, _ files: [String]) {
        _ = view
        composer.setDraft(text, files: files.map { URL(fileURLWithPath: $0) })
        view.window?.makeFirstResponder(composer.text)
    }

    func reload() {
        guard isViewLoaded else { return }
        let b = Backend.shared

        // jump to the session once the router sent my request
        if let r = b.routes.first(where: { RouteWatcher.shared.isMine($0.id) }) {
            if let t = r.target, r.decided != nil, b.session(t) != nil {
                RouteWatcher.shared.done(r.id)
                Toast.show("→ \(r.targetName ?? "session"): \(r.reason ?? "")")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { AppDelegate.shared.window.show(.session(t)) }
                return
            }
        }

        // Needs you
        needsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let needs = b.sessions.filter { $0.sessionState == .needs }
        needsHeader.isHidden = needs.isEmpty
        needsStack.isHidden = needs.isEmpty
        for s in needs { needsStack.addArrangedSubview(needsRow(s)) }

        // Requests
        requestsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let routes = Array(b.routes.filter { $0.status != "dry" }.prefix(8))
        requestsHeader.isHidden = routes.isEmpty
        requestsStack.isHidden = routes.isEmpty
        for r in routes { requestsStack.addArrangedSubview(requestRow(r)) }
    }

    private func needsRow(_ s: Session) -> NSView {
        let card = CardView()
        card.tint = Theme.red
        card.onClick = { AppDelegate.shared.window.show(.session(s.id)) }
        card.accessibleName = "Needs you: \(s.name)"
        card.setAccessibilityIdentifier("home.needs.\(s.name)")
        let dot = StatusDot(); dot.state = .needs
        let name = label(s.name, size: 13, weight: .semibold)
        let q = label(s.question.isEmpty ? "\(s.isCodex ? "Codex" : "Claude") is waiting for your choice." : s.question, size: 12, color: .secondaryLabelColor, lines: 2)
        let buttons = NSStackView()
        buttons.spacing = 6
        buttons.translatesAutoresizingMaskIntoConstraints = false
        for o in s.options.prefix(4) {
            let btn = ActionButton(o.label) { Backend.shared.post("choose", ["id": s.id, "n": o.n]) }
            btn.setAccessibilityIdentifier("home.needs.\(s.name).choice.\(o.n)")
            btn.controlSize = .small
            if o.label.lowercased().hasPrefix("yes") { btn.bezelColor = Theme.green }
            btn.lineBreakMode = .byTruncatingTail
            btn.widthAnchor.constraint(lessThanOrEqualToConstant: 240).isActive = true
            buttons.addArrangedSubview(btn)
        }
        buttons.addArrangedSubview(ActionButton("Open") { AppDelegate.shared.window.show(.session(s.id)) })
        [dot, name, q, buttons].forEach { card.addSubview($0) }
        if let badge = Pill.agent(s.agentId) {
            card.addSubview(badge)
            NSLayoutConstraint.activate([
                badge.leadingAnchor.constraint(equalTo: name.trailingAnchor, constant: 6),
                badge.centerYAnchor.constraint(equalTo: name.centerYAnchor),
                badge.trailingAnchor.constraint(lessThanOrEqualTo: card.trailingAnchor, constant: -14),
            ])
        } else {
            name.trailingAnchor.constraint(lessThanOrEqualTo: card.trailingAnchor, constant: -14).isActive = true
        }
        NSLayoutConstraint.activate([
            dot.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 14),
            dot.centerYAnchor.constraint(equalTo: name.centerYAnchor),
            name.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 10),
            name.topAnchor.constraint(equalTo: card.topAnchor, constant: 12),
            q.leadingAnchor.constraint(equalTo: name.leadingAnchor),
            q.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -14),
            q.topAnchor.constraint(equalTo: name.bottomAnchor, constant: 4),
            buttons.leadingAnchor.constraint(equalTo: name.leadingAnchor),
            buttons.topAnchor.constraint(equalTo: q.bottomAnchor, constant: 8),
            buttons.trailingAnchor.constraint(lessThanOrEqualTo: card.trailingAnchor, constant: -14),
            buttons.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -12),
        ])
        return card
    }

    private func requestRow(_ r: Route) -> NSView {
        let card = CardView()
        card.accessibleName = "Request: \(r.text)"
        card.setAccessibilityIdentifier("home.request.\(r.id)")
        if r.status == "ask" || r.status == "error" { card.tint = Theme.amber }
        let pill = Pill()
        switch r.status {
        case "sent", "split": pill.set(text: r.statusLabel, color: Theme.green)
        case "ask": pill.set(text: r.statusLabel, color: Theme.amber, filled: true)
        case "error": pill.set(text: r.statusLabel, color: Theme.red, filled: true)
        default: pill.set(text: r.statusLabel, color: Theme.amber)
        }
        // a task of a split request: "↳ 1/3" under its request
        let text = label(r.part.map { "↳ \($0)  \(r.text)" } ?? r.text, size: 13, weight: .medium)
        let time = label(Date(timeIntervalSince1970: r.ts / 1000).formatted(date: .omitted, time: .shortened), size: 11, color: .tertiaryLabelColor)
        time.setContentCompressionResistancePriority(.required, for: .horizontal)
        let reason = label(r.error ?? r.reason ?? "", size: 12, color: .secondaryLabelColor, lines: 2)
        let dismiss = ActionButton("", symbol: "xmark") { Backend.shared.post("dismissRoute", ["routeId": r.id]) }
        dismiss.isBordered = false
        dismiss.toolTip = "Remove"
        let top = NSStackView(views: [pill, text])
        top.spacing = 8
        top.translatesAutoresizingMaskIntoConstraints = false
        if let t = r.target, let s = Backend.shared.session(t) {
            // clicking the request opens the session it went to (like its "→ name" button)
            card.onClick = { AppDelegate.shared.window.show(.session(t)) }
            let go = ActionButton("→ \(s.name)") { AppDelegate.shared.window.show(.session(t)) }
            go.setAccessibilityIdentifier("home.request.\(r.id).go")
            go.controlSize = .small
            top.addArrangedSubview(go)
        }
        [top, time, dismiss, reason].forEach { card.addSubview($0) }
        var cons = [
            top.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 14),
            top.topAnchor.constraint(equalTo: card.topAnchor, constant: 10),
            top.trailingAnchor.constraint(lessThanOrEqualTo: time.leadingAnchor, constant: -8),
            dismiss.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -10),
            dismiss.centerYAnchor.constraint(equalTo: top.centerYAnchor),
            time.trailingAnchor.constraint(equalTo: dismiss.leadingAnchor, constant: -6),
            time.centerYAnchor.constraint(equalTo: top.centerYAnchor),
            reason.leadingAnchor.constraint(equalTo: top.leadingAnchor),
            reason.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -14),
            reason.topAnchor.constraint(equalTo: top.bottomAnchor, constant: 4),
        ]
        if r.status == "ask" || r.status == "error" {
            let opts = WrapStack()
            var seen = Set<String>()
            // first choice: just start it, in the default folder (no folder picking needed)
            let def = Backend.shared.defaultFolder
            if !def.isEmpty {
                let b = ActionButton("New session in \((def as NSString).lastPathComponent)", symbol: "plus", prominent: true) {
                    Self.routeTo(r, ["folder": def, "name": r.newName ?? ""])
                }
                b.setAccessibilityIdentifier("home.request.\(r.id).newDefault")
                b.toolTip = def
                opts.add(b)
            }
            for c in r.choices ?? [] {
                seen.insert(c.id)
                let b = ActionButton(c.name, prominent: true) { Self.routeTo(r, ["target": c.id]) }
                b.setAccessibilityIdentifier("home.request.\(r.id).pick.\(c.name)")
                opts.add(b)
            }
            for s in Backend.shared.sessions where !seen.contains(s.id) && s.sessionState != .elsewhere {
                let b = ActionButton(s.name) { Self.routeTo(r, ["target": s.id]) }
                b.setAccessibilityIdentifier("home.request.\(r.id).pick.\(s.name)")
                opts.add(b)
            }
            if let f = r.folder, !f.isEmpty, f != def {
                opts.add(ActionButton("New in \((f as NSString).lastPathComponent)", symbol: "plus") { Self.routeTo(r, ["folder": f, "name": r.newName ?? ""]) })
            }
            opts.add(ActionButton("New Session…", symbol: "folder") { AppDelegate.shared.window.showNewSession(folder: r.folder ?? "", routeId: r.id) })
            card.addSubview(opts)
            cons += [
                opts.leadingAnchor.constraint(equalTo: top.leadingAnchor),
                opts.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -14),
                opts.topAnchor.constraint(equalTo: reason.bottomAnchor, constant: 8),
                opts.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -12),
            ]
        } else {
            cons.append(reason.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -10))
        }
        NSLayoutConstraint.activate(cons)
        return card
    }

    static func routeTo(_ r: Route, _ body: [String: Any]) {
        var b = body; b["routeId"] = r.id
        Backend.shared.post("routeTo", b) { res in
            if let id = res["id"] as? String {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { AppDelegate.shared.window.show(.session(id)) }
            }
        }
    }
}

/// Lays out buttons left to right and wraps to new lines.
final class WrapStack: FlippedView {
    private var items: [NSView] = []
    private var heightC: NSLayoutConstraint!
    let spacing: CGFloat = 6

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        heightC = heightAnchor.constraint(equalToConstant: 24)
        heightC.isActive = true
    }
    required init?(coder: NSCoder) { fatalError() }

    func add(_ v: NSView) {
        v.translatesAutoresizingMaskIntoConstraints = true
        if let b = v as? NSButton { b.controlSize = .small; b.sizeToFit() }
        items.append(v)
        addSubview(v)
        needsLayout = true
    }

    override func layout() {
        super.layout()
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for v in items {
            let s = v.fittingSize.width > 0 ? v.fittingSize : v.frame.size
            let w = min(s.width, bounds.width)
            if x > 0 && x + w > bounds.width { x = 0; y += rowH + spacing; rowH = 0 }
            v.frame = NSRect(x: x, y: y, width: w, height: s.height)
            x += w + spacing
            rowH = max(rowH, s.height)
        }
        let h = y + rowH
        if abs(heightC.constant - h) > 0.5 { heightC.constant = max(h, 1) }
    }
}
