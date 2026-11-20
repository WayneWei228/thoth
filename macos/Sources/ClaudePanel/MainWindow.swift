import AppKit

enum Page: Equatable {
    case home
    case sessions
    case everywhere
    case session(String)
}

/// Main window: native sidebar + a content area that shows Home (Ask), All Sessions,
/// or one session.
final class MainWindowController: NSWindowController, NSWindowDelegate {
    let split = NSSplitViewController()
    let sidebar = SidebarViewController()
    let content = ContentContainer()
    let home = HomeViewController()
    let sessionsPage = SessionsViewController()
    let everywhere = EverywhereViewController()
    let detail = SessionDetailViewController()
    private(set) var page: Page = .home

    init() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                         backing: .buffered, defer: false)
        w.title = "Thoth"
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        if Theme.web { w.backgroundColor = Theme.paper }
        w.minSize = NSSize(width: 900, height: 560)
        w.setFrameAutosaveName("ClaudePanelMain")
        super.init(window: w)
        w.delegate = self

        let sideItem = NSSplitViewItem(sidebarWithViewController: sidebar)
        sideItem.minimumThickness = 230
        sideItem.maximumThickness = 340
        sideItem.canCollapse = true
        let contentItem = NSSplitViewItem(viewController: content)
        split.addSplitViewItem(sideItem)
        split.addSplitViewItem(contentItem)
        split.splitView.autosaveName = "ClaudePanelSplit"
        w.contentViewController = split
        if !w.setFrameUsingName("ClaudePanelMain") || w.frame.width <= 901 {
            let vis = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
            let size = NSSize(width: min(1320, vis.width - 80), height: min(860, vis.height - 60))
            w.setFrame(NSRect(x: vis.midX - size.width / 2, y: vis.midY - size.height / 2, width: size.width, height: size.height), display: true)
        }

        sidebar.onSelect = { [weak self] page in self?.show(page) }
        Backend.shared.onChange.append { [weak self] in self?.refresh() }
        let last = LastPage.load()
        if case .session = last { restorePending = true }
        show(last)
    }
    /// After launch on a saved session page: wait for that session to appear (after a Mac restart
    /// the server builds the windows again one by one). The wait lasts while the server says it is
    /// restoring, and 8 s more after the first connection (a slow server is not counted).
    private var restorePending = false
    private var restoreUntil: Date?
    private var retryQueued = false
    required init?(coder: NSCoder) { fatalError() }

    func show(_ p: Page) {
        page = p
        LastPage.save(p)
        switch p {
        case .home: content.set(home)
        case .sessions: content.set(sessionsPage)
        case .everywhere: content.set(everywhere); everywhere.reload()
        case .session(let id):
            content.set(detail)
            detail.load(id)
        }
        sidebar.select(p)
        refresh()
    }

    func refresh() {
        sidebar.reload()
        switch page {
        case .home: home.reload()
        case .sessions: sessionsPage.reload()
        case .everywhere: break  // brain data, not panel state
        case .session(let id):
            let b = Backend.shared
            if restorePending && b.connected { restorePending = false; restoreUntil = Date().addingTimeInterval(8) }
            let waiting = restorePending || b.restoring || (restoreUntil.map { Date() < $0 } ?? false)
            let here = b.session(id)
            // tmux restarted: window ids are given out again, so the saved transcript id decides
            // which window holds the conversation (the same id may now be another conversation)
            let want = LastPage.savedSid(id)
            let launching = restorePending || restoreUntil != nil   // until the saved page is confirmed
            if b.connected, let want, here == nil || (launching && here!.sid != want) {
                if let s = b.sessions.first(where: { $0.sid == want }) { restoreUntil = nil; show(.session(s.id)); return }
                if waiting { retryRefresh(); return }
                restoreUntil = nil
                if here == nil || !here!.sid.isEmpty { show(.sessions); return }
            }
            if here == nil && b.connected {
                if waiting { retryRefresh() } else { restoreUntil = nil; show(.sessions) }
            } else {
                if let here, !launching || want == nil || here.sid == want || !waiting { restoreUntil = nil; LastPage.save(page) }
                detail.reload()
            }
        }
        let needs = Backend.shared.sessions.filter { $0.sessionState == .needs }.count
        NSApp.dockTile.badgeLabel = needs > 0 ? "\(needs)" : nil
    }

    private func retryRefresh() {
        guard !retryQueued else { return }
        retryQueued = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.retryQueued = false; self?.refresh() }
    }

    func sessionClosed(_ id: String) {
        if page == .session(id) { show(.sessions) }
    }

    func showNewSession(folder: String = "", routeId: String? = nil) {
        guard let w = window else { return }
        let sheet = NewSessionController(folder: folder, routeId: routeId)
        w.contentViewController?.presentAsSheet(sheet)
    }
}

/// Holds one child view controller at a time.
final class ContentContainer: NSViewController {
    private var currentVC: NSViewController?
    override func loadView() {
        view = NSView()
        if Theme.web { view.wantsLayer = true; view.layer?.backgroundColor = Theme.paper.cgColor }
    }

    func set(_ vc: NSViewController) {
        guard vc !== currentVC else { return }
        currentVC?.view.removeFromSuperview()
        currentVC?.removeFromParent()
        addChild(vc)
        vc.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(vc.view)
        NSLayoutConstraint.activate([
            vc.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            vc.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            vc.view.topAnchor.constraint(equalTo: view.topAnchor),
            vc.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        currentVC = vc
    }
}

// MARK: - Sidebar

private enum SideRow {
    case nav(Page, String, String)        // page, title, SF Symbol
    case header(String)
    case session(Session)
}

final class SidebarViewController: NSViewController, NSTableViewDataSource, NSTableViewDelegate {
    var onSelect: ((Page) -> Void)?
    private let table = NSTableView()
    private var rows: [SideRow] = []
    // Order of "Recent": a running session keeps its place; when it finishes it moves to the top.
    // (Sorting by `activity` moved running sessions on every update.) ms since epoch.
    private var orderKey: [String: Double] = [:]
    private var lastState: [String: SessionState] = [:]
    private var selectedPage: Page = .home
    private var suppress = false
    // Select mode: the user ticks sessions and closes them together (the "Select" button by "Recent").
    private(set) var selecting = false
    private(set) var checked: Set<String> = []
    // AI tidy: the reason for each suggestion (shown under the name in select mode)
    private var hints: [String: String] = [:]
    // the sessions the AI ticked (not the user): only these are unticked when they start working
    private var aiTicked: Set<String> = []
    private var tidying = false
    private let bar = NSView()
    private var barHeight: NSLayoutConstraint!
    private let barLabel = label("", size: 11, color: .secondaryLabelColor)
    private lazy var closeBtn: NSButton = {
        let b = NSButton(title: "Close", target: self, action: #selector(closeChecked))
        b.bezelStyle = .rounded; b.controlSize = .small
        b.setAccessibilityIdentifier("sidebar.closeSelected")
        return b
    }()
    // "Done" in the bar too: the one by "Recent" goes away when no session is left under that header
    private lazy var doneBtn: NSButton = {
        let b = NSButton(title: "Done", target: self, action: #selector(toggleSelecting))
        b.bezelStyle = .rounded; b.controlSize = .small
        b.setAccessibilityIdentifier("sidebar.selectDone")
        return b
    }()
    private lazy var allBtn: NSButton = {
        let b = NSButton(title: "All", target: self, action: #selector(checkAll))
        b.bezelStyle = .rounded; b.controlSize = .small
        b.setAccessibilityIdentifier("sidebar.selectAll")
        return b
    }()

    override func loadView() {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        table.style = .sourceList
        table.headerView = nil
        table.backgroundColor = .clear
        table.rowSizeStyle = .custom
        table.intercellSpacing = NSSize(width: 0, height: 2)
        table.addTableColumn(NSTableColumn(identifier: .init("c")))
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.action = #selector(rowClicked)   // select mode ticks on a click (no row is selectable then)
        table.menu = NSMenu()
        table.menu?.delegate = self
        scroll.documentView = table

        let root = NSView()
        let web = Theme.web
        if web {
            root.wantsLayer = true
            root.layer?.backgroundColor = Theme.side.cgColor   // paper, a little darker than the page
        }
        let brand = label("Thoth", size: 13, weight: .semibold, color: web ? Theme.ink : .secondaryLabelColor)
        if web { brand.font = Theme.serif(21) }
        let mark = NSImageView(image: web ? Theme.mark(height: 20) : NSImage())
        mark.isHidden = !web
        mark.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(mark)
        let newBtn = NSButton(image: Theme.icon("plus", "New Session")!, target: self, action: #selector(newSession))
        newBtn.bezelStyle = .accessoryBarAction
        newBtn.isBordered = false
        newBtn.toolTip = "New session in a folder"
        newBtn.setAccessibilityIdentifier("sidebar.newSession")
        newBtn.translatesAutoresizingMaskIntoConstraints = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        // Settings: bottom left of the sidebar, always visible (user, 2026-11-15)
        let settingsBtn = NSButton(title: "Settings", image: Theme.icon("gearshape", "Settings")!, target: self, action: #selector(openSettings))
        settingsBtn.bezelStyle = .accessoryBarAction
        settingsBtn.isBordered = false
        settingsBtn.imagePosition = .imageLeading
        settingsBtn.imageHugsTitle = true
        settingsBtn.font = .systemFont(ofSize: 13)
        settingsBtn.contentTintColor = web ? Theme.ink : .secondaryLabelColor
        settingsBtn.setAccessibilityIdentifier("sidebar.settings")
        settingsBtn.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(brand); root.addSubview(newBtn); root.addSubview(scroll); root.addSubview(settingsBtn)
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.wantsLayer = true
        bar.setAccessibilityIdentifier("sidebar.selectBar")
        let line = NSBox(); line.boxType = .separator; line.translatesAutoresizingMaskIntoConstraints = false
        for v in [line, barLabel, allBtn, closeBtn, doneBtn] as [NSView] { v.translatesAutoresizingMaskIntoConstraints = false; bar.addSubview(v) }
        root.addSubview(bar)
        barHeight = bar.heightAnchor.constraint(equalToConstant: 0)
        bar.isHidden = true
        NSLayoutConstraint.activate([
            bar.leadingAnchor.constraint(equalTo: root.leadingAnchor), bar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            bar.bottomAnchor.constraint(equalTo: root.bottomAnchor), barHeight,
            line.topAnchor.constraint(equalTo: bar.topAnchor), line.leadingAnchor.constraint(equalTo: bar.leadingAnchor), line.trailingAnchor.constraint(equalTo: bar.trailingAnchor),
            barLabel.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 12), barLabel.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            doneBtn.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -10), doneBtn.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            closeBtn.trailingAnchor.constraint(equalTo: doneBtn.leadingAnchor, constant: -6), closeBtn.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            allBtn.trailingAnchor.constraint(equalTo: closeBtn.leadingAnchor, constant: -6), allBtn.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            barLabel.trailingAnchor.constraint(lessThanOrEqualTo: allBtn.leadingAnchor, constant: -6),
        ])
        NSLayoutConstraint.activate([
            brand.topAnchor.constraint(equalTo: root.topAnchor, constant: 14),
            mark.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 80),
            mark.centerYAnchor.constraint(equalTo: brand.centerYAnchor, constant: 1),
            web ? brand.leadingAnchor.constraint(equalTo: mark.trailingAnchor, constant: 7)
                : brand.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 82),
            newBtn.centerYAnchor.constraint(equalTo: brand.centerYAnchor),
            newBtn.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
            scroll.topAnchor.constraint(equalTo: root.topAnchor, constant: 44),
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: settingsBtn.topAnchor, constant: -6),
            settingsBtn.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            settingsBtn.bottomAnchor.constraint(equalTo: bar.topAnchor, constant: -12),
        ])
        view = root
        reload()
    }

    @objc private func newSession() { AppDelegate.shared.window.showNewSession() }
    @objc private func openSettings() { SettingsWindowController.shared.present() }

    // MARK: Select mode

    @objc func toggleSelecting() { setSelecting(!selecting) }

    func setSelecting(_ on: Bool, checked ids: Set<String> = []) {
        selecting = on
        checked = on ? ids : []
        if !on { hints = [:]; aiTicked = [] }
        reload()
    }

    /// AI tidy: the server asks Claude which sessions are one-off tasks that are done; they are
    /// ticked in select mode with the reason under each name. The user closes them with "Close N".
    @objc func tidy() {
        guard !tidying else { return }
        tidying = true
        reload()
        Backend.shared.send("tidy", [:], fail: { [weak self] msg in
            self?.tidying = false; self?.reload(); Toast.show(msg)
        }) { [weak self] json in
            guard let self else { return }
            self.tidying = false
            let list = json["sessions"] as? [[String: Any]] ?? []
            var close: Set<String> = []
            var hints: [String: String] = [:]
            for d in list {
                guard let id = d["id"] as? String else { continue }
                if let r = d["reason"] as? String, !r.isEmpty { hints[id] = r }
                if d["close"] as? Bool == true { close.insert(id) }
            }
            self.setSelecting(true, checked: close)
            self.hints = hints
            self.aiTicked = close
            self.reload()
        }
    }

    @objc private func checkBox(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        toggle(id)
    }

    private func toggle(_ id: String) {
        if checked.contains(id) { checked.remove(id) } else { checked.insert(id) }
        aiTicked.remove(id)   // the user decided this one now
        reload()
    }

    @objc private func checkAll() {
        let ids = Set(Backend.shared.sessions.map(\.id))
        checked = checked == ids ? [] : ids
        aiTicked = []   // the user's choice now
        reload()
    }

    /// Closes every ticked session (each one like "Close" in its menu: no confirmation, the
    /// conversation is saved and can be resumed).
    @objc func closeChecked() {
        for s in Backend.shared.sessions where checked.contains(s.id) { SessionMenu.close(s) }
        setSelecting(false)
    }

    private func updateBar() {
        bar.isHidden = !selecting
        barHeight.constant = selecting ? 40 : 0
        let n = checked.count
        barLabel.stringValue = n == 0 ? (hints.isEmpty ? "Tick sessions to close" : "AI: nothing to close") : "\(n) selected"
        closeBtn.title = n == 0 ? "Close" : "Close \(n)"
        closeBtn.isEnabled = n > 0
        allBtn.title = checked.count == Backend.shared.sessions.count && n > 0 ? "None" : "All"
    }

    func reload() {
        let sessions = Backend.shared.sessions
        checked.formIntersection(sessions.map(\.id))  // a session that closed is no longer ticked
        if selecting && sessions.isEmpty { selecting = false; hints = [:]; aiTicked = [] }   // nothing left to tick
        // AI tidy ticked it, then it started working or asked for the user: untick it, so Close N never
        // interrupts a turn the AI judged on an older snapshot (the check box hides the status dot)
        // (only the AI's ticks: a session the user ticks by hand stays ticked)
        for x in sessions where aiTicked.contains(x.id) && (x.sessionState == .working || x.sessionState == .needs) { checked.remove(x.id); aiTicked.remove(x.id) }
        let needs = sessions.filter { $0.sessionState == .needs }
        var r: [SideRow] = [
            .nav(.home, "New Request", "square.and.pencil"),
            .nav(.sessions, "All Sessions", "square.grid.2x2"),
            .nav(.everywhere, "All Devices", "desktopcomputer"),
        ]
        if !needs.isEmpty {
            r.append(.header("Needs You"))
            r += needs.map { .session($0) }
        }
        for s in sessions {
            let state = s.sessionState
            if orderKey[s.id] == nil { orderKey[s.id] = s.activity }   // first seen: its last activity
            else if lastState[s.id] == .working && state != .working { orderKey[s.id] = Date().timeIntervalSince1970 * 1000 }
            lastState[s.id] = state
        }
        let rest = sessions.filter { $0.sessionState != .needs }
            .sorted { (orderKey[$0.id] ?? 0, $0.id) > (orderKey[$1.id] ?? 0, $1.id) }
        if !rest.isEmpty {
            r.append(.header("Recent"))
            r += rest.map { .session($0) }
        }
        rows = r
        if isViewLoaded { updateBar() }
        suppress = true
        table.reloadData()
        select(selectedPage)
        suppress = false
    }

    func select(_ p: Page) {
        selectedPage = p
        let idx = rows.firstIndex { row in
            switch (row, p) {
            case (.nav(let a, _, _), _): return a == p
            case (.session(let s), .session(let id)): return s.id == id
            default: return false
            }
        }
        suppress = true
        // select mode: no row is highlighted (rows cannot be selected then)
        if selecting { table.deselectAll(nil) }
        else if let idx { table.selectRowIndexes([idx], byExtendingSelection: false) } else { table.deselectAll(nil) }
        suppress = false
    }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, isGroupRow row: Int) -> Bool {
        if case .header = rows[row] { return true }
        return false
    }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        switch rows[row] {
        case .header: return 26
        case .nav: return 30
        case .session(let s): return (s.title?.isEmpty == false || (selecting && hints[s.id] != nil)) ? 44 : 30
        }
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        if case .header = rows[row] { return false }
        // select mode: no row can be selected. A mouse click ticks through rowClicked; with VoiceOver the
        // row's check box (a button) ticks; arrow keys do nothing, drags tick nothing.
        if selecting { return false }
        return true
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let v = cellView(row)
        switch rows[row] {
        case .nav(let p, _, _): v?.setAccessibilityIdentifier(navID(p))
        case .session(let s):
            v?.setAccessibilityIdentifier("session.\(s.name)")
            // Table rows do not expose identifiers; a fixed label lets agents find them.
            v?.setAccessibilityLabel("\(s.name), \(s.sessionState.label)")
        case .header(let t): v?.setAccessibilityIdentifier("header.\(t)")
        }
        return v
    }

    private var firstSessionHeader: String? {
        for r in rows { if case .header(let t) = r { return t } }
        return nil
    }

    private func cellView(_ row: Int) -> NSView? {
        switch rows[row] {
        case .header(let t):
            let l = label(t, size: 11, weight: .semibold, color: .tertiaryLabelColor)
            let v = NSView(); v.addSubview(l)
            NSLayoutConstraint.activate([l.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 8), l.bottomAnchor.constraint(equalTo: v.bottomAnchor, constant: -4)])
            // Select/Done and Tidy on the first session header ("Needs You" when every session needs you)
            if t == firstSessionHeader {
                let tb = NSButton(title: tidying ? "Tidying…" : "Tidy", target: self, action: #selector(tidy))
                tb.isBordered = false
                tb.isEnabled = !tidying
                tb.font = .systemFont(ofSize: 11, weight: .medium)
                tb.contentTintColor = Theme.accent
                tb.toolTip = "AI suggests which sessions to close (one-off tasks that are done)"
                tb.setAccessibilityIdentifier("sidebar.tidy")
                tb.translatesAutoresizingMaskIntoConstraints = false
                v.addSubview(tb)
                let b = NSButton(title: selecting ? "Done" : "Select", target: self, action: #selector(toggleSelecting))
                b.isBordered = false
                b.font = .systemFont(ofSize: 11, weight: .medium)
                b.contentTintColor = Theme.accent
                b.setAccessibilityIdentifier("sidebar.select")
                b.translatesAutoresizingMaskIntoConstraints = false
                v.addSubview(b)
                NSLayoutConstraint.activate([b.trailingAnchor.constraint(equalTo: v.trailingAnchor, constant: -8), b.firstBaselineAnchor.constraint(equalTo: l.firstBaselineAnchor),
                                             tb.trailingAnchor.constraint(equalTo: b.leadingAnchor, constant: -10), tb.firstBaselineAnchor.constraint(equalTo: l.firstBaselineAnchor)])
            }
            return v
        case .nav(_, let title, let symbol):
            let v = NSTableCellView()
            let img = NSImageView(image: Theme.icon(symbol, title)!)
            img.contentTintColor = Theme.accent
            img.translatesAutoresizingMaskIntoConstraints = false
            let l = label(title, size: 13, weight: .medium)
            v.addSubview(img); v.addSubview(l)
            NSLayoutConstraint.activate([
                img.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 6), img.centerYAnchor.constraint(equalTo: v.centerYAnchor),
                img.widthAnchor.constraint(equalToConstant: 18),
                l.leadingAnchor.constraint(equalTo: img.trailingAnchor, constant: 8), l.centerYAnchor.constraint(equalTo: v.centerYAnchor),
                l.trailingAnchor.constraint(lessThanOrEqualTo: v.trailingAnchor, constant: -6),
            ])
            return v
        case .session(let s):
            let v = NSTableCellView()
            let dot: NSView
            if selecting {
                let cb = NSButton(checkboxWithTitle: "", target: self, action: #selector(checkBox(_:)))
                cb.state = checked.contains(s.id) ? .on : .off
                cb.identifier = NSUserInterfaceItemIdentifier(s.id)
                cb.setAccessibilityIdentifier("select.\(s.name)")
                cb.translatesAutoresizingMaskIntoConstraints = false
                dot = cb
            } else {
                let d = StatusDot(); d.state = s.sessionState; dot = d
            }
            let name = label(s.name, size: 13, weight: .medium)
            let time = label(s.sessionState == .needs ? "Needs you" : ago(s.activity), size: 11, color: s.sessionState == .needs ? Theme.red : .tertiaryLabelColor)
            time.setContentCompressionResistancePriority(.required, for: .horizontal)
            v.addSubview(dot); v.addSubview(name); v.addSubview(time)
            var cons = [
                dot.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: selecting ? 6 : 10),
                name.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: selecting ? 6 : 10),
                time.trailingAnchor.constraint(equalTo: v.trailingAnchor, constant: -8),
                time.firstBaselineAnchor.constraint(equalTo: name.firstBaselineAnchor),
            ]
            if let badge = Pill.agent(s.agentId) {
                v.addSubview(badge)
                cons += [
                    badge.leadingAnchor.constraint(equalTo: name.trailingAnchor, constant: 6),
                    badge.centerYAnchor.constraint(equalTo: name.centerYAnchor),
                    badge.trailingAnchor.constraint(lessThanOrEqualTo: time.leadingAnchor, constant: -6),
                ]
            } else {
                cons.append(name.trailingAnchor.constraint(lessThanOrEqualTo: time.leadingAnchor, constant: -6))
            }
            let hint = selecting ? hints[s.id] : nil
            if let t = hint ?? s.title, !t.isEmpty {
                let sub = label(t, size: 11, color: hint != nil ? (checked.contains(s.id) ? Theme.red : Theme.green) : .secondaryLabelColor)
                v.addSubview(sub)
                cons += [
                    name.topAnchor.constraint(equalTo: v.topAnchor, constant: 5),
                    dot.centerYAnchor.constraint(equalTo: name.centerYAnchor),
                    sub.topAnchor.constraint(equalTo: name.bottomAnchor, constant: 1),
                    sub.leadingAnchor.constraint(equalTo: name.leadingAnchor),
                    sub.trailingAnchor.constraint(lessThanOrEqualTo: v.trailingAnchor, constant: -8),
                ]
            } else {
                cons += [name.centerYAnchor.constraint(equalTo: v.centerYAnchor), dot.centerYAnchor.constraint(equalTo: v.centerYAnchor)]
            }
            NSLayoutConstraint.activate(cons)
            v.toolTip = shortPath(s.folder)
            return v
        }
    }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        let rv = NSTableRowView()
        switch rows[row] {
        case .nav(let p, _, _): rv.setAccessibilityIdentifier(navID(p))
        case .session(let s): rv.setAccessibilityIdentifier("session.\(s.name)")
        case .header(let t): rv.setAccessibilityIdentifier("header.\(t)")
        }
        return rv
    }

    /// Select mode: a click on a session row (also the open session's) ticks or unticks it.
    @objc private func rowClicked() {
        let row = table.clickedRow
        guard selecting, row >= 0, row < rows.count, case .session(let s) = rows[row] else { return }
        toggle(s.id)
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !suppress, table.selectedRow >= 0 else { return }
        if selecting { return }   // rows cannot be selected in select mode (shouldSelectRow)
        switch rows[table.selectedRow] {
        case .nav(let p, _, _): selectedPage = p; onSelect?(p)
        case .session(let s): selectedPage = .session(s.id); onSelect?(.session(s.id))
        case .header: break
        }
    }
}

extension SidebarViewController: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let row = table.clickedRow
        guard row >= 0, case .session(let s) = rows[row] else { return }
        let m = SessionMenu.make(for: s, open: { [weak self] in self?.onSelect?(.session(s.id)) },
                                 rename: { SessionMenu.askRename(s) })
        for item in m.items { m.removeItem(item); menu.addItem(item) }
    }
}

/// Accessibility identifier of a sidebar navigation row.
func navID(_ p: Page) -> String {
    switch p {
    case .home: return "nav.home"
    case .sessions: return "nav.sessions"
    case .everywhere: return "nav.everywhere"
    case .session(let id): return "nav.session.\(id)"
    }
}

/// The page the window showed last, saved on every change. After a crash or a force quit the app
/// opens on the same page and the same session. A session is saved with its transcript id too, so
/// it is found again when tmux restarted and gave it a new window id.
enum LastPage {
    private static let key = "lastPage"

    static func save(_ p: Page) {
        let v: [String: String]
        switch p {
        case .home: v = ["page": "home"]
        case .sessions: v = ["page": "sessions"]
        case .everywhere: v = ["page": "everywhere"]
        case .session(let id):
            let known = Backend.shared.session(id)?.sid ?? ""
            v = ["page": "session", "id": id, "sid": !known.isEmpty ? known : (saved["id"] == id ? saved["sid"] ?? "" : "")]
        }
        UserDefaults.standard.set(v, forKey: key)
    }

    private static var saved: [String: String] { UserDefaults.standard.dictionary(forKey: key) as? [String: String] ?? [:] }

    static func load() -> Page {
        let v = saved
        switch v["page"] {
        case "sessions": return .sessions
        case "everywhere": return .everywhere
        case "session": if let id = v["id"], id.hasPrefix("@") { return .session(id) }
        default: break
        }
        return .home
    }

    /// The transcript id saved with window `id`, if the saved page is that window.
    static func savedSid(_ id: String) -> String? {
        let v = saved
        guard v["id"] == id, let sid = v["sid"], !sid.isEmpty else { return nil }
        return sid
    }
}
