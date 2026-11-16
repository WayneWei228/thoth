import AppKit

/// Sheet: pick a folder (recent, or the native folder dialog), then start a new
/// conversation or continue a previous one in that folder.
final class NewSessionController: NSViewController, NSTableViewDataSource, NSTableViewDelegate {
    private var folder: String
    private let routeId: String?
    private let folderField = NSTextField(string: "")
    private let recentPopup = NSPopUpButton()
    private let table = NSTableView()
    private let emptyLabel = label("", size: 12, color: .secondaryLabelColor)
    private var recent: [RecentFolder] = []
    private var history: [HistoryItem] = []
    private let agentControl = NSSegmentedControl(labels: ["Claude Code", "Codex"], trackingMode: .selectOne, target: nil, action: nil)
    private let agentNote = label("", size: 11, color: .secondaryLabelColor)
    private static let agentKey = "newSession.agent"
    private static let agentIds = ["claude", "codex"]

    init(folder: String, routeId: String?) {
        self.folder = folder
        self.routeId = routeId
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func loadView() {
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 520))
        let title = label(routeId == nil ? "New Session" : "Send Request to a New Session", size: 17, weight: .semibold)
        let step1 = label("1. Project folder", size: 13, weight: .semibold)
        folderField.placeholderString = "/path/to/project"
        folderField.stringValue = folder
        folderField.target = self
        folderField.action = #selector(folderTyped)
        folderField.translatesAutoresizingMaskIntoConstraints = false
        folderField.setAccessibilityIdentifier("newSession.folder")
        recentPopup.setAccessibilityIdentifier("newSession.recent")
        table.setAccessibilityIdentifier("newSession.history")
        let choose = ActionButton("Choose…", symbol: "folder") { [weak self] in self?.chooseFolder() }
        recentPopup.translatesAutoresizingMaskIntoConstraints = false
        recentPopup.target = self
        recentPopup.action = #selector(recentPicked)
        let step2 = label("2. Start", size: 13, weight: .semibold)
        let fresh = ActionButton("Start New Conversation", symbol: "plus.bubble", prominent: true) { [weak self] in self?.create(sid: "") }
        agentControl.translatesAutoresizingMaskIntoConstraints = false
        agentControl.setAccessibilityIdentifier("newSession.agent")
        agentControl.target = self
        agentControl.action = #selector(agentPicked)
        let saved = UserDefaults.standard.string(forKey: Self.agentKey) ?? "claude"
        agentControl.selectedSegment = Self.agentIds.firstIndex(of: saved) ?? 0
        agentControl.setToolTip("Start Claude Code in this folder", forSegment: 0)
        agentControl.setToolTip("Start the Codex CLI in this folder", forSegment: 1)
        let or = label("or double-click a previous conversation to continue it:", size: 12, color: .secondaryLabelColor)

        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false
        let colT = NSTableColumn(identifier: .init("t")); colT.title = "Conversation"; colT.width = 420
        let colD = NSTableColumn(identifier: .init("d")); colD.title = "Last used"; colD.width = 130
        table.addTableColumn(colT); table.addTableColumn(colD)
        table.dataSource = self
        table.delegate = self
        table.rowHeight = 36
        table.usesAlternatingRowBackgroundColors = true
        table.doubleAction = #selector(continuePicked)
        table.target = self
        scroll.documentView = table

        let cancel = ActionButton("Cancel") { [weak self] in self?.dismiss(nil) }
        cancel.keyEquivalent = "\u{1b}"
        let cont = ActionButton("Continue Selected") { [weak self] in self?.continuePicked() }
        cancel.setAccessibilityIdentifier("newSession.cancel")
        cont.setAccessibilityIdentifier("newSession.continue")
        fresh.setAccessibilityIdentifier("newSession.start")
        choose.setAccessibilityIdentifier("newSession.choose")

        [title, step1, folderField, choose, recentPopup, step2, agentControl, fresh, agentNote, or, scroll, emptyLabel, cancel, cont].forEach { root.addSubview($0) }
        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: root.topAnchor, constant: 20),
            title.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 22),
            step1.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 18),
            step1.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            folderField.topAnchor.constraint(equalTo: step1.bottomAnchor, constant: 8),
            folderField.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            folderField.trailingAnchor.constraint(equalTo: choose.leadingAnchor, constant: -8),
            choose.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -22),
            choose.centerYAnchor.constraint(equalTo: folderField.centerYAnchor),
            recentPopup.topAnchor.constraint(equalTo: folderField.bottomAnchor, constant: 8),
            recentPopup.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            recentPopup.widthAnchor.constraint(equalToConstant: 300),
            step2.topAnchor.constraint(equalTo: recentPopup.bottomAnchor, constant: 20),
            step2.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            agentControl.topAnchor.constraint(equalTo: step2.bottomAnchor, constant: 8),
            agentControl.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            fresh.centerYAnchor.constraint(equalTo: agentControl.centerYAnchor),
            fresh.leadingAnchor.constraint(equalTo: agentControl.trailingAnchor, constant: 10),
            agentNote.centerYAnchor.constraint(equalTo: fresh.centerYAnchor),
            agentNote.leadingAnchor.constraint(equalTo: fresh.trailingAnchor, constant: 10),
            agentNote.trailingAnchor.constraint(lessThanOrEqualTo: choose.trailingAnchor),
            or.topAnchor.constraint(equalTo: fresh.bottomAnchor, constant: 14),
            or.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            scroll.topAnchor.constraint(equalTo: or.bottomAnchor, constant: 8),
            scroll.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: choose.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: cancel.topAnchor, constant: -14),
            emptyLabel.centerXAnchor.constraint(equalTo: scroll.centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: scroll.centerYAnchor),
            cancel.trailingAnchor.constraint(equalTo: cont.leadingAnchor, constant: -8),
            cancel.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -18),
            cont.trailingAnchor.constraint(equalTo: choose.trailingAnchor),
            cont.bottomAnchor.constraint(equalTo: cancel.bottomAnchor),
        ])
        view = root
        loadRecent()
        loadAgents()
        loadHistory()
    }

    /// The agent "Start New Conversation" uses.
    private var chosenAgent: String {
        let i = agentControl.selectedSegment
        return i >= 0 && i < Self.agentIds.count ? Self.agentIds[i] : "claude"
    }

    @objc private func agentPicked() {
        UserDefaults.standard.set(chosenAgent, forKey: Self.agentKey)
    }

    /// Codex may be missing on this Mac: then its segment is off and the reason is shown.
    private func loadAgents() {
        Backend.shared.get("api/agents", as: [AgentInfo].self) { [weak self] list in
            guard let self else { return }
            let codex = list?.first { $0.id == "codex" }
            let ok = codex?.available ?? false
            let reason = codex?.reason ?? (list == nil ? "This server cannot start Codex." : "Codex is not available.")
            self.agentControl.setEnabled(ok, forSegment: 1)
            self.agentControl.setToolTip(ok ? "Start the Codex CLI in this folder" : reason, forSegment: 1)
            self.agentNote.stringValue = ok ? "" : "Codex: \(reason)"
            if !ok && self.agentControl.selectedSegment == 1 { self.agentControl.selectedSegment = 0 }
        }
    }

    private func loadRecent() {
        Backend.shared.get("api/folders", as: [RecentFolder].self) { [weak self] list in
            guard let self else { return }
            self.recent = list ?? []
            self.recentPopup.removeAllItems()
            self.recentPopup.addItem(withTitle: "Recent folders…")
            for r in self.recent.prefix(25) { self.recentPopup.addItem(withTitle: shortPath(r.folder)) }
        }
    }

    private func loadHistory() {
        history = []
        table.reloadData()
        let f = folderField.stringValue.trimmingCharacters(in: .whitespaces)
        guard !f.isEmpty else { emptyLabel.stringValue = "Choose a folder first."; return }
        emptyLabel.stringValue = "Loading…"
        Backend.shared.get("api/history", query: ["folder": f], as: [HistoryItem].self) { [weak self] list in
            guard let self else { return }
            self.history = list ?? []
            self.emptyLabel.stringValue = self.history.isEmpty ? "No previous conversations in this folder." : ""
            self.table.reloadData()
        }
    }

    @objc private func folderTyped() { loadHistory() }
    @objc private func recentPicked() {
        let i = recentPopup.indexOfSelectedItem - 1
        guard i >= 0, i < recent.count else { return }
        folderField.stringValue = recent[i].folder
        loadHistory()
    }

    private func chooseFolder() {
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.allowsMultipleSelection = false
        p.prompt = "Choose"
        p.message = "Choose a project folder"
        guard let w = view.window else { return }
        p.beginSheetModal(for: w) { [weak self] r in
            guard r == .OK, let url = p.url, let self else { return }
            self.folderField.stringValue = url.path
            self.loadHistory()
        }
    }

    @objc private func continuePicked() {
        let row = table.selectedRow >= 0 ? table.selectedRow : table.clickedRow
        guard row >= 0, row < history.count else { Toast.show("Select a conversation first"); return }
        let h = history[row]
        if let open = Backend.shared.sessions.first(where: { $0.sid == h.sid }) {
            dismiss(nil)
            AppDelegate.shared.window.show(.session(open.id))
            return
        }
        create(sid: h.sid, agent: h.agentId)
    }

    private func create(sid: String, agent: String? = nil) {
        let agent = agent ?? chosenAgent
        let f = folderField.stringValue.trimmingCharacters(in: .whitespaces)
        guard !f.isEmpty else { Toast.show("Choose a folder first"); return }
        if let rid = routeId, sid.isEmpty {
            dismiss(nil)
            Backend.shared.post("routeTo", ["routeId": rid, "folder": f, "agent": agent]) { r in
                if let id = r["id"] as? String { AppDelegate.shared.window.show(.session(id)) }
            }
            return
        }
        var body: [String: Any] = ["folder": f, "agent": agent]
        if !sid.isEmpty { body["sid"] = sid }
        dismiss(nil)
        Backend.shared.post("new", body) { r in
            if let id = r["id"] as? String {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { AppDelegate.shared.window.show(.session(id)) }
            }
        }
    }

    // MARK: table
    func numberOfRows(in tableView: NSTableView) -> Int { history.count }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let h = history[row]
        if tableColumn?.identifier.rawValue == "d" {
            return label(Date(timeIntervalSince1970: h.mtime / 1000).formatted(date: .abbreviated, time: .shortened), size: 12, color: .secondaryLabelColor)
        }
        let v = NSView()
        let open = Backend.shared.sessions.contains { $0.sid == h.sid }
        let t = label((h.title.isEmpty ? h.first : h.title) + (open ? "   (open in panel)" : ""), size: 13, weight: .medium)
        let s = label(h.first, size: 11, color: .secondaryLabelColor)
        let badge = Pill()
        badge.setMuted(h.agentId == "codex" ? "Codex" : "Claude Code")
        v.addSubview(badge); v.addSubview(t); v.addSubview(s)
        NSLayoutConstraint.activate([
            badge.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 4), badge.centerYAnchor.constraint(equalTo: t.centerYAnchor),
            t.leadingAnchor.constraint(equalTo: badge.trailingAnchor, constant: 6), t.trailingAnchor.constraint(lessThanOrEqualTo: v.trailingAnchor),
            t.topAnchor.constraint(equalTo: v.topAnchor, constant: 2),
            s.leadingAnchor.constraint(equalTo: badge.leadingAnchor), s.trailingAnchor.constraint(lessThanOrEqualTo: v.trailingAnchor),
            s.topAnchor.constraint(equalTo: t.bottomAnchor, constant: 1),
        ])
        return v
    }
}
