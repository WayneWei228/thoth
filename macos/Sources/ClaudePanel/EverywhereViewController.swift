import AppKit

struct BrainDevice: Codable, Hashable {
    let name: String
    let os: String?
    let transport: String?
    let last_sync: Double?
    let ok: Int?
    let error: String?
    let sessions: Int?
    /// A computer that sends by itself has sent nothing for 20 minutes (server: deviceList).
    let silent: Bool?
    /// This panel can make a new join command for it.
    let reconnect: Bool?
}

struct BrainSession: Codable, Hashable {
    let device: String
    let agent: String
    let sid: String
    let cwd: String?
    let project: String?
    let title: String?
    let first_prompt: String?
    let last_prompt: String?
    let last_reply: String?
    let updated: String?
    let mtime: Double?

    /// First 8 characters of the id; used in accessibility identifiers.
    var sid8: String { String(sid.prefix(8)) }

    var displayTitle: String {
        if let t = title, !t.isEmpty { return t }
        return first_prompt ?? sid
    }
    var projectName: String {
        let p = project ?? ""
        if p.hasPrefix("git:") { return String(p.dropFirst(4)) }
        if p.hasPrefix("folder:") { return String(p.dropFirst(7)) }
        return p.isEmpty ? "No project" : p
    }
}

struct BrainHandoff: Codable {
    let id: String
    let status: String?
    let result: String?
    let target_path: String?
}

/// Search field that reports every change of its text: typing, Enter, and values
/// set from outside (accessibility, so agents and VoiceOver users get results too).
final class LiveSearchField: NSSearchField {
    var onChange: (() -> Void)?
    override var stringValue: String {
        didSet { onChange?() }
    }
    override var objectValue: Any? {
        didSet { onChange?() }
    }
    // Accessibility clients (agents, VoiceOver) set the value through this call.
    override func setAccessibilityValue(_ value: Any?) {
        super.setAccessibilityValue(value)
        if let v = value as? String, v != stringValue { stringValue = v }
        onChange?()
    }
    override func textDidChange(_ notification: Notification) {
        super.textDidChange(notification)
        onChange?()
    }
}

/// All Devices: every Claude Code and Codex session on every device, from the
/// central brain. Search, filter by device and agent, add a computer, remove a computer.
final class EverywhereViewController: NSViewController {
    private let search = LiveSearchField()
    private let devicePopup = NSPopUpButton()
    private let agentControl = NSSegmentedControl(labels: ["All", "Claude", "Codex"], trackingMode: .selectOne, target: nil, action: nil)
    private let devicesRow = NSStackView()
    private let stack = NSStackView()
    private let status = label("", size: 12, color: .secondaryLabelColor)
    private let silentNote = WrappingLabel(wrappingLabelWithString: "")
    private var devices: [BrainDevice] = []
    private var results: [BrainSession] = []
    private var pending: DispatchWorkItem?
    private var loadedOnce = false

    override func loadView() {
        let root = NSView()
        let title = label("All Devices", size: 24, weight: .semibold)
        title.setAccessibilityIdentifier("everywhere.title")
        let sub = label("Every Claude Code and Codex session on every device, from your brain. Add a computer here, or remove one.", size: 13, color: .secondaryLabelColor)

        search.placeholderString = "Search all sessions (title, request, reply, folder)"
        search.translatesAutoresizingMaskIntoConstraints = false
        search.target = self
        search.action = #selector(queryChanged)
        search.sendsSearchStringImmediately = true
        search.onChange = { [weak self] in self?.queryChanged() }
        search.setAccessibilityIdentifier("everywhere.search")
        devicePopup.translatesAutoresizingMaskIntoConstraints = false
        devicePopup.target = self
        devicePopup.action = #selector(queryChanged)
        devicePopup.setAccessibilityIdentifier("everywhere.device")
        agentControl.selectedSegment = 0
        agentControl.target = self
        agentControl.action = #selector(queryChanged)
        agentControl.translatesAutoresizingMaskIntoConstraints = false
        agentControl.setAccessibilityIdentifier("everywhere.agent")
        let syncBtn = ActionButton("Sync Now", symbol: "arrow.triangle.2.circlepath") { [weak self] in self?.syncNow() }
        syncBtn.setAccessibilityIdentifier("everywhere.sync")
        let addBtn = ActionButton("Add Computer", symbol: "plus", prominent: true) { [weak self] in self?.addDevice() }
        addBtn.toolTip = "Connect another computer to your brain"
        addBtn.setAccessibilityIdentifier("everywhere.addDevice")
        status.setAccessibilityIdentifier("everywhere.status")

        silentNote.font = .systemFont(ofSize: 12)
        silentNote.textColor = .systemOrange
        silentNote.translatesAutoresizingMaskIntoConstraints = false
        silentNote.setAccessibilityIdentifier("everywhere.silent")
        devicesRow.orientation = .horizontal
        devicesRow.spacing = 10
        devicesRow.translatesAutoresizingMaskIntoConstraints = false

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
        stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        doc.addSubview(stack)

        [title, sub, devicesRow, silentNote, addBtn, syncBtn, search, devicePopup, agentControl, status, scroll].forEach { root.addSubview($0) }
        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: root.topAnchor, constant: 44),
            title.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 32),
            sub.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 4),
            sub.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            sub.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor, constant: -32),
            devicesRow.topAnchor.constraint(equalTo: sub.bottomAnchor, constant: 14),
            devicesRow.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            devicesRow.trailingAnchor.constraint(lessThanOrEqualTo: addBtn.leadingAnchor, constant: -10),
            addBtn.trailingAnchor.constraint(equalTo: syncBtn.leadingAnchor, constant: -8),
            addBtn.centerYAnchor.constraint(equalTo: devicesRow.centerYAnchor),
            syncBtn.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -32),
            syncBtn.centerYAnchor.constraint(equalTo: devicesRow.centerYAnchor),
            silentNote.topAnchor.constraint(equalTo: devicesRow.bottomAnchor, constant: 8),
            silentNote.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            silentNote.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -32),
            search.topAnchor.constraint(equalTo: silentNote.bottomAnchor, constant: 8),
            search.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            search.trailingAnchor.constraint(equalTo: devicePopup.leadingAnchor, constant: -10),
            devicePopup.centerYAnchor.constraint(equalTo: search.centerYAnchor),
            devicePopup.widthAnchor.constraint(equalToConstant: 170),
            devicePopup.trailingAnchor.constraint(equalTo: agentControl.leadingAnchor, constant: -10),
            agentControl.centerYAnchor.constraint(equalTo: search.centerYAnchor),
            agentControl.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -32),
            status.topAnchor.constraint(equalTo: search.bottomAnchor, constant: 8),
            status.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            status.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor, constant: -32),
            scroll.topAnchor.constraint(equalTo: status.bottomAnchor, constant: 10),
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            doc.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            doc.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            doc.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            stack.topAnchor.constraint(equalTo: doc.topAnchor),
            stack.leadingAnchor.constraint(equalTo: doc.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: doc.trailingAnchor, constant: -32),
            stack.bottomAnchor.constraint(equalTo: doc.bottomAnchor, constant: -32),
        ])
        view = root
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        reload()
    }

    /// Called when the page is shown. Panel state updates do not change this page.
    func reload() {
        guard isViewLoaded else { return }
        loadDevices()
        if !loadedOnce { loadedOnce = true; runQuery() }
    }

    private var localDevice: String? { devices.first { $0.transport == "local" }?.name }

    private func loadDevices() {
        Backend.shared.get("api/deviceList", as: [BrainDevice].self) { [weak self] list in
            guard let self else { return }
            guard let list else {
                self.devices = []
                self.renderDevices()
                self.status.stringValue = "The central brain is not running. Start it with: python3 brain/brain.py serve"
                return
            }
            self.devices = list
            self.renderDevices()
        }
    }

    private func renderDevices() {
        devicesRow.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let selected = devicePopup.titleOfSelectedItem
        devicePopup.removeAllItems()
        devicePopup.addItem(withTitle: "All devices")
        for d in devices {
            devicePopup.addItem(withTitle: d.name)
            let chip = CardView()
            chip.accessibleName = "Device \(d.name)"
            chip.setAccessibilityIdentifier("everywhere.deviceChip.\(d.name)")
            chip.onClick = { [weak self] in
                self?.devicePopup.selectItem(withTitle: d.name)
                self?.queryChanged()
            }
            let silent = d.ok == 1 && d.silent == true
            let dot = StatusDot()
            dot.state = d.ok == 1 && !silent ? .idle : .needs
            let isWin = (d.os ?? "").lowercased().contains("windows")
            let icon = NSImageView(image: Theme.icon(isWin ? "pc" : "laptopcomputer", nil)!)
            icon.contentTintColor = .secondaryLabelColor
            icon.translatesAutoresizingMaskIntoConstraints = false
            let name = label(d.name + (d.transport == "local" ? " (this Mac)" : ""), size: 13, weight: .semibold)
            name.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
            let synced = d.last_sync.map { ago($0 * 1000) } ?? "never"
            let detail = label(silent ? "\(d.sessions ?? 0) sessions · nothing new for \(synced)"
                               : d.ok == 1 ? "\(d.sessions ?? 0) sessions · synced \(synced)" : "offline: \(d.error ?? "")",
                               size: 11, color: silent ? .systemOrange : .secondaryLabelColor)
            [dot, icon, name, detail].forEach { chip.addSubview($0) }
            // every computer but this one can be removed
            var trailing = chip.trailingAnchor
            if d.transport != "local" {
                let remove = ActionButton("", symbol: "minus.circle") { [weak self] in self?.confirmRemove(d) }
                remove.isBordered = false
                remove.contentTintColor = .secondaryLabelColor
                remove.toolTip = "Remove \(d.name) from your brain"
                remove.setAccessibilityLabel("Remove \(d.name)")
                remove.setAccessibilityIdentifier("everywhere.deviceChip.\(d.name).remove")
                chip.addSubview(remove)
                NSLayoutConstraint.activate([
                    remove.trailingAnchor.constraint(equalTo: chip.trailingAnchor, constant: -8),
                    remove.centerYAnchor.constraint(equalTo: chip.centerYAnchor),
                    remove.widthAnchor.constraint(equalToConstant: 20),
                ])
                trailing = remove.leadingAnchor
                if silent, d.reconnect == true {
                    let again = ActionButton("Reconnect", symbol: "arrow.clockwise") { [weak self] in self?.reconnect(d) }
                    again.controlSize = .small
                    again.toolTip = "\(d.name) sends nothing. Get a command that connects it again"
                    again.setAccessibilityIdentifier("everywhere.deviceChip.\(d.name).reconnect")
                    chip.addSubview(again)
                    NSLayoutConstraint.activate([
                        again.trailingAnchor.constraint(equalTo: remove.leadingAnchor, constant: -6),
                        again.centerYAnchor.constraint(equalTo: chip.centerYAnchor),
                    ])
                    trailing = again.leadingAnchor
                }
                chip.onMenu = { [weak self] _ in
                    let m = NSMenu()
                    m.addItem(ClosureMenuItem(title: "Show Only \(d.name)") { self?.devicePopup.selectItem(withTitle: d.name); self?.queryChanged() })
                    if d.reconnect == true { m.addItem(ClosureMenuItem(title: "Reconnect \(d.name)…") { self?.reconnect(d) }) }
                    m.addItem(.separator())
                    m.addItem(ClosureMenuItem(title: "Remove \(d.name)…") { self?.confirmRemove(d) })
                    return m
                }
            }
            NSLayoutConstraint.activate([
                dot.leadingAnchor.constraint(equalTo: chip.leadingAnchor, constant: 10),
                dot.centerYAnchor.constraint(equalTo: chip.centerYAnchor),
                icon.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 8),
                icon.centerYAnchor.constraint(equalTo: chip.centerYAnchor),
                name.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
                name.topAnchor.constraint(equalTo: chip.topAnchor, constant: 7),
                detail.leadingAnchor.constraint(equalTo: name.leadingAnchor),
                detail.topAnchor.constraint(equalTo: name.bottomAnchor, constant: 1),
                name.trailingAnchor.constraint(lessThanOrEqualTo: trailing, constant: -12),
                detail.trailingAnchor.constraint(equalTo: trailing, constant: -12),
                chip.heightAnchor.constraint(equalToConstant: 44),
                chip.widthAnchor.constraint(greaterThanOrEqualToConstant: 200),
            ])
            devicesRow.addArrangedSubview(chip)
        }
        if let selected, devicePopup.itemTitles.contains(selected) { devicePopup.selectItem(withTitle: selected) }
        // say it in words too: a quiet computer is easy to miss
        let quiet = devices.filter { $0.ok == 1 && $0.silent == true }
        if quiet.isEmpty {
            silentNote.stringValue = ""
        } else {
            let names = quiet.map(\.name).joined(separator: ", ")
            let can = quiet.contains { $0.reconnect == true }
            silentNote.stringValue = "\(names) \(quiet.count == 1 ? "has" : "have") sent nothing for more than 20 minutes. "
                + "A computer that is off or asleep sends again when it wakes up."
                + (can ? " If it is on and still silent, choose Reconnect." : " If it is on and still silent, check that it is online.")
        }
    }

    @objc private func queryChanged() {
        pending?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.runQuery() }
        pending = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: w)
    }

    private func runQuery() {
        var q: [String: String] = ["limit": "200"]
        let text = search.stringValue.trimmingCharacters(in: .whitespaces)
        if !text.isEmpty { q["q"] = text }
        if devicePopup.indexOfSelectedItem > 0, let d = devicePopup.titleOfSelectedItem { q["device"] = d }
        if agentControl.selectedSegment == 1 { q["agent"] = "claude" }
        if agentControl.selectedSegment == 2 { q["agent"] = "codex" }
        Backend.shared.get("api/brain/sessions", query: q, as: [BrainSession].self) { [weak self] list in
            guard let self else { return }
            guard let list else {
                self.status.stringValue = "The central brain is not running. Start it with: python3 brain/brain.py serve"
                return
            }
            self.results = list
            self.render()
        }
    }

    // MARK: add and remove a computer

    private func addDevice() {
        let sheet = AddDeviceController(taken: devices.map(\.name)) { [weak self] in
            self?.loadDevices()
            self?.runQuery()
        }
        presentAsSheet(sheet)
    }

    private func reconnect(_ d: BrainDevice) {
        let sheet = AddDeviceController(taken: [], reconnect: d.name) { [weak self] in
            self?.loadDevices()
            self?.runQuery()
        }
        presentAsSheet(sheet)
    }

    private func confirmRemove(_ d: BrainDevice) {
        guard let w = view.window else { return }
        let n = d.sessions ?? 0
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = "Remove “\(d.name)” from your brain?"
        a.informativeText = """
        The brain deletes what it has from \(d.name): \(n) session\(n == 1 ? "" : "s") and its memory files. \
        \(d.name) can no longer send data to the brain.

        Nothing on \(d.name) itself changes. To connect it again, choose Add Computer.
        """
        a.addButton(withTitle: "Remove")
        a.addButton(withTitle: "Cancel")
        a.buttons.first?.hasDestructiveAction = true
        a.buttons.first?.setAccessibilityIdentifier("everywhere.remove.confirm")
        a.buttons.last?.setAccessibilityIdentifier("everywhere.remove.cancel")
        a.beginSheetModal(for: w) { [weak self] r in
            if r == .alertFirstButtonReturn { self?.remove(d) }
        }
    }

    private func remove(_ d: BrainDevice) {
        status.stringValue = "Removing \(d.name)…"
        Backend.shared.send("deviceRemove", ["name": d.name], fail: { [weak self] message in
            guard let self, let w = self.view.window else { return }
            self.status.stringValue = "\(d.name) was not removed."
            let a = NSAlert()
            a.messageText = "“\(d.name)” was not removed"
            a.informativeText = message
            a.beginSheetModal(for: w)
        }, done: { [weak self] r in
            guard let self else { return }
            if self.devicePopup.titleOfSelectedItem == d.name { self.devicePopup.selectItem(at: 0) }
            if let note = r["note"] as? String, let w = self.view.window {
                let a = NSAlert()
                a.messageText = "“\(d.name)” is disconnected"
                a.informativeText = note
                a.beginSheetModal(for: w)
            } else {
                let n = r["sessions"] as? Int ?? 0
                Toast.show("Removed \(d.name): \(n) session\(n == 1 ? "" : "s") deleted from the brain")
            }
            self.loadDevices()
            self.runQuery()
        })
    }

    private func syncNow() {
        status.stringValue = "Syncing all devices…"
        Backend.shared.post("brain/sync") { [weak self] _ in
            self?.loadDevices()
            self?.runQuery()
        }
    }

    private func render() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let devicesHit = Set(results.map(\.device))
        status.stringValue = results.isEmpty ? "No session matches." :
            "\(results.count) session\(results.count == 1 ? "" : "s") on \(devicesHit.count) device\(devicesHit.count == 1 ? "" : "s")" + (results.count >= 200 ? " (first 200)" : "")
        // group by project, keep the newest-first order of groups
        var order: [String] = []
        var groups: [String: [BrainSession]] = [:]
        for s in results {
            let k = s.project ?? ""
            if groups[k] == nil { order.append(k) }
            groups[k, default: []].append(s)
        }
        for k in order {
            guard let items = groups[k] else { continue }
            let section = NSStackView()
            section.orientation = .vertical
            section.alignment = .leading
            section.spacing = 6
            section.translatesAutoresizingMaskIntoConstraints = false
            let devs = Array(Set(items.map(\.device))).sorted().joined(separator: " · ")
            let header = label("\(items[0].projectName)   \(devs)", size: 14, weight: .semibold)
            section.addArrangedSubview(header)
            for s in items { section.addArrangedSubview(row(s)) }
            for v in section.arrangedSubviews where v !== header { v.widthAnchor.constraint(equalTo: section.widthAnchor).isActive = true }
            stack.addArrangedSubview(section)
            section.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
    }

    private func row(_ s: BrainSession) -> NSView {
        let c = CardView()
        c.accessibleName = "\(s.device) \(s.agent) \(s.displayTitle)"
        c.setAccessibilityIdentifier("everywhere.result.\(s.device).\(s.sid8)")
        let deviceTag = Pill()
        deviceTag.set(text: s.device, color: s.device == localDevice ? Theme.green : .systemBlue)
        let agentTag = Pill()
        agentTag.set(text: s.agent == "codex" ? "Codex" : "Claude", color: s.agent == "codex" ? .systemPurple : Theme.accent)
        let title = label(s.displayTitle, size: 13, weight: .semibold)
        let when = label(s.mtime.map { ago($0 * 1000) } ?? "", size: 11, color: .tertiaryLabelColor)
        when.setContentCompressionResistancePriority(.required, for: .horizontal)
        let you = label((s.last_prompt ?? "").isEmpty ? "" : "You: \(s.last_prompt ?? "")", size: 12, color: .secondaryLabelColor)
        let reply = label(s.last_reply ?? "", size: 12, color: .labelColor)
        let path = label(s.cwd ?? "", size: 11, color: .tertiaryLabelColor)
        [deviceTag, agentTag, title, when, you, reply, path].forEach { c.addSubview($0) }

        let who = s.agent == "codex" ? "Codex" : "Claude"
        let canOpen = s.device == localDevice && FileManager.default.fileExists(atPath: s.cwd ?? "")
        let action: NSView
        if canOpen {
            let open = ActionButton("Open Here", symbol: "play.fill") { Self.openLocal(s) }
            open.controlSize = .small
            open.setAccessibilityIdentifier("everywhere.result.\(s.device).\(s.sid8).open")
            action = open
            c.onClick = { Self.openLocal(s) }
        } else if s.device != localDevice, localDevice != nil {
            let hand = ActionButton("Continue on This Mac", symbol: "arrow.down.forward.and.arrow.up.backward") { [weak self] in
                self?.confirmHandoff(s)
            }
            hand.controlSize = .small
            hand.toolTip = "Copy the code from \(s.device) to this Mac and start \(who) here with a summary of the work"
            hand.setAccessibilityIdentifier("everywhere.result.\(s.device).\(s.sid8).handoff")
            action = hand
        } else {
            action = label("Folder not on this Mac", size: 11, color: .tertiaryLabelColor)
        }
        c.addSubview(action)
        NSLayoutConstraint.activate([
            deviceTag.leadingAnchor.constraint(equalTo: c.leadingAnchor, constant: 12),
            deviceTag.topAnchor.constraint(equalTo: c.topAnchor, constant: 10),
            agentTag.leadingAnchor.constraint(equalTo: deviceTag.trailingAnchor, constant: 6),
            agentTag.centerYAnchor.constraint(equalTo: deviceTag.centerYAnchor),
            title.leadingAnchor.constraint(equalTo: agentTag.trailingAnchor, constant: 8),
            title.centerYAnchor.constraint(equalTo: deviceTag.centerYAnchor),
            title.trailingAnchor.constraint(lessThanOrEqualTo: when.leadingAnchor, constant: -8),
            when.trailingAnchor.constraint(equalTo: action.leadingAnchor, constant: -10),
            when.centerYAnchor.constraint(equalTo: deviceTag.centerYAnchor),
            action.trailingAnchor.constraint(equalTo: c.trailingAnchor, constant: -12),
            action.centerYAnchor.constraint(equalTo: deviceTag.centerYAnchor),
            you.leadingAnchor.constraint(equalTo: c.leadingAnchor, constant: 12),
            you.trailingAnchor.constraint(equalTo: c.trailingAnchor, constant: -12),
            you.topAnchor.constraint(equalTo: deviceTag.bottomAnchor, constant: 6),
            reply.leadingAnchor.constraint(equalTo: you.leadingAnchor),
            reply.trailingAnchor.constraint(equalTo: you.trailingAnchor),
            reply.topAnchor.constraint(equalTo: you.bottomAnchor, constant: 2),
            path.leadingAnchor.constraint(equalTo: you.leadingAnchor),
            path.trailingAnchor.constraint(equalTo: you.trailingAnchor),
            path.topAnchor.constraint(equalTo: reply.bottomAnchor, constant: 2),
            path.bottomAnchor.constraint(equalTo: c.bottomAnchor, constant: -10),
        ])
        return c
    }

    // MARK: cross-device handoff (phase 3)

    private func confirmHandoff(_ s: BrainSession) {
        let who = s.agent == "codex" ? "Codex" : "Claude"
        let a = NSAlert()
        a.messageText = "Continue “\(s.displayTitle)” on this Mac?"
        a.informativeText = """
        The brain copies the code from \(s.device) (\(s.cwd ?? "")) to a new folder on this Mac, writes a summary of \
        what was done and what is left, and opens a \(who) session here with it. Nothing on \(s.device) changes.
        """
        a.addButton(withTitle: "Continue Here")
        a.addButton(withTitle: "Cancel")
        if a.runModal() != .alertFirstButtonReturn { return }
        startHandoff(s)
    }

    private func startHandoff(_ s: BrainSession) {
        status.stringValue = "Handing off from \(s.device): reading the session, copying the code, writing the summary…"
        Backend.shared.post("brain/handoff", ["device": s.device, "sid": s.sid]) { [weak self] r in
            guard let id = r["id"] as? String else { return }
            self?.pollHandoff(id, tries: 0)
        }
    }

    private func pollHandoff(_ id: String, tries: Int) {
        Backend.shared.get("api/brain/handoffs", query: ["limit": "20"], as: [BrainHandoff].self) { [weak self] list in
            guard let self else { return }
            let h = list?.first { $0.id == id }
            switch h?.status {
            case "ran":  // "prepared" comes first (code copied) and is not the end in panel mode
                let res = (h?.result).flatMap { $0.data(using: .utf8) }.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
                self.status.stringValue = "Handoff \(id) ready: \(h?.target_path ?? "")"
                if let sessionId = res?["panel_session"] as? String {
                    let who = res?["agent"] as? String == "codex" ? "Codex" : "Claude"
                    Toast.show("Opened on this Mac. Approve the folder, then \(who) gets the summary.")
                    self.openWhenListed(sessionId, tries: 0)
                }
            case "failed", "run-failed":
                self.status.stringValue = "Handoff failed"
                let a = NSAlert()
                a.messageText = "Handoff failed"
                a.informativeText = String((h?.result ?? "").suffix(600))
                a.runModal()
            default:
                if tries > 150 { self.status.stringValue = "Handoff is taking long; check later."; return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.pollHandoff(id, tries: tries + 1) }
            }
        }
    }

    /// The panel state arrives every 1.5 s; open the new session once the app knows it.
    private func openWhenListed(_ id: String, tries: Int) {
        if Backend.shared.session(id) != nil || tries > 20 {
            AppDelegate.shared.window.show(.session(id))
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.openWhenListed(id, tries: tries + 1) }
    }

    /// Continue a Claude or Codex session of this Mac inside the panel (opens it if it is already there).
    static func openLocal(_ s: BrainSession) {
        if let open = Backend.shared.sessions.first(where: { $0.sid == s.sid }) {
            AppDelegate.shared.window.show(.session(open.id))
            return
        }
        var body: [String: Any] = ["folder": s.cwd ?? "", "sid": s.sid]
        if s.agent == "codex" { body["agent"] = "codex" }  // the server runs `codex resume <sid>`
        Backend.shared.post("new", body) { r in
            if let id = r["id"] as? String {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { AppDelegate.shared.window.show(.session(id)) }
            }
        }
    }
}
