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
        // no server and the app does not start one (Backend.serverNote): say why above the page
        let note = Backend.shared.connected ? nil : Backend.shared.serverNote
        window?.subtitle = note ?? ""
        content.setBanner(note)
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
            // a preparing row of a new session on a helper became that session: follow it
            if here == nil, let s = b.sessions.first(where: { $0.preparedAs == id }) { show(.session(s.id)); return }
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
    /// Why there is no server and the app does not start one (Backend.serverNote), above every page.
    private let banner = NSTextField(wrappingLabelWithString: "")
    override func loadView() {
        view = NSView()
        if Theme.web { view.wantsLayer = true; view.layer?.backgroundColor = Theme.paper.cgColor }
        banner.isHidden = true
        banner.wantsLayer = true
        banner.drawsBackground = true
        banner.backgroundColor = NSColor.systemOrange.withAlphaComponent(0.18)
        banner.textColor = .labelColor
        banner.font = .systemFont(ofSize: 13, weight: .medium)
        banner.alignment = .center
        banner.layer?.cornerRadius = 8
        banner.setAccessibilityIdentifier("main.serverNote")
        banner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(banner)
        NSLayoutConstraint.activate([
            banner.topAnchor.constraint(equalTo: view.topAnchor, constant: 40),
            banner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            banner.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -48),
            banner.widthAnchor.constraint(lessThanOrEqualToConstant: 720),
        ])
    }

    func setBanner(_ text: String?) {
        _ = view
        banner.stringValue = text.map { "  \($0)  " } ?? ""
        banner.isHidden = text == nil
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
        view.addSubview(banner, positioned: .above, relativeTo: vc.view)
        currentVC = vc
    }
}

// MARK: - Sidebar

private enum SideRow {
    case nav(Page, String, String)        // page, title, SF Symbol
    case header(String)
    case session(Session)
    case device(String, Bool, PeerInfo?)  // a helper computer's name, offline (lib/peer.ts), its update state (lib/self_update.ts)
    case join(JoinRequest)                // a computer waiting for Approve (lib/join_requests.ts)
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
    // join requests with an Approve / Ignore on the way (their buttons stay off until the state drops them)
    private var deciding: Set<String> = []
    private static let joinHeader = "Wants to Join"
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
        let ids = Set(Backend.shared.sessions.filter { !$0.isRemote }.map(\.id))   // a helper's session cannot be closed from here yet
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
        allBtn.title = checked.count == Backend.shared.sessions.filter({ !$0.isRemote }).count && n > 0 ? "None" : "All"
    }

    func reload() {
        let sessions = Backend.shared.sessions
        checked.formIntersection(sessions.map(\.id))  // a session that closed is no longer ticked
        if selecting && sessions.isEmpty { selecting = false; hints = [:]; aiTicked = [] }   // nothing left to tick
        // AI tidy ticked it, then it started working or asked for the user: untick it, so Close N never
        // interrupts a turn the AI judged on an older snapshot (the check box hides the status dot)
        // (only the AI's ticks: a session the user ticks by hand stays ticked)
        for x in sessions where aiTicked.contains(x.id) && (x.sessionState == .working || x.sessionState == .needs) { checked.remove(x.id); aiTicked.remove(x.id) }
        // this Mac's sessions under Needs You / Recent; each helper computer's under its own name
        let local = sessions.filter { !$0.isRemote }
        let needs = local.filter { $0.sessionState == .needs }
        var r: [SideRow] = [
            .nav(.home, "New Request", "square.and.pencil"),
            .nav(.sessions, "All Sessions", "square.grid.2x2"),
            .nav(.everywhere, "All Devices", "desktopcomputer"),
        ]
        // a computer asked to join the cloud brain: right under the pages, before any session
        let joins = Backend.shared.joins
        deciding.formIntersection(joins.map(\.id))
        if !joins.isEmpty {
            r.append(.header(Self.joinHeader))
            r += joins.map { .join($0) }
        }
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
        let rest = local.filter { $0.sessionState != .needs }
            .sorted { (orderKey[$0.id] ?? 0, $0.id) > (orderKey[$1.id] ?? 0, $1.id) }
        if !rest.isEmpty {
            r.append(.header("Recent"))
            r += rest.map { .session($0) }
        }
        // every helper computer has a header (also one without sessions: it may need an update)
        let peers = Backend.shared.peers
        var devices: [String] = peers.map(\.device)
        for s in sessions { if let d = s.device, !devices.contains(d) { devices.append(d) } }
        for d in devices.sorted() {
            let items = sessions.filter { $0.device == d }
            let peer = peers.first { $0.device == d }
            r.append(.device(d, peer.map { !$0.online } ?? items.allSatisfy(\.isOffline), peer))
            r += items.sorted { ($0.sessionState.rank, -(orderKey[$0.id] ?? 0), $0.id) < ($1.sessionState.rank, -(orderKey[$1.id] ?? 0), $1.id) }.map { .session($0) }
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
        switch rows[row] {
        case .header, .device: return true
        default: return false
        }
    }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        switch rows[row] {
        case .header: return 26
        case .device(_, _, let peer): return peer?.showsUpdateButton == true ? 32 : 26   // room for the Update button
        case .nav: return 30
        case .join: return 84
        case .session(let s): return (s.title?.isEmpty == false || (selecting && hints[s.id] != nil)) ? 44 : 30
        }
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        if case .header = rows[row] { return false }
        if case .device = rows[row] { return false }
        if case .join = rows[row] { return false }
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
        case .device(let device, let off, let peer):
            v?.setAccessibilityIdentifier("sidebar.device.\(device)")
            let note = peer?.note ?? (off ? "offline" : nil)
            v?.setAccessibilityLabel(note.map { "\(device), \($0)" } ?? device)
        case .join(let j):
            v?.setAccessibilityIdentifier("join.\(j.name)")
        }
        return v
    }

    private var firstSessionHeader: String? {
        // not "Wants to Join": Select / Tidy belong to the sessions
        for r in rows { if case .header(let t) = r, t != Self.joinHeader { return t } }
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
        case .device(let d, let off, let peer):
            // a helper computer: its name; grey with "offline" when it does not answer; "update needed"
            // (orange) when it runs an older Thoth, "updating…", or "update failed" (red, the error as tooltip).
            // An older helper that is online gets an "Update" button on the right ("Retry" after a failure);
            // during an update a spinner stands there instead.
            let img = NSImageView(image: Theme.icon("desktopcomputer", d)!)
            img.contentTintColor = off ? .tertiaryLabelColor : .secondaryLabelColor
            img.translatesAutoresizingMaskIntoConstraints = false
            let note = peer?.note ?? (off ? "offline" : nil)
            let color: NSColor = peer?.update == "failed" ? Theme.red : peer?.update == "needed" ? .systemOrange : .tertiaryLabelColor
            let l = label(note.map { "\(d) · \($0)" } ?? d, size: 11, weight: .semibold, color: color)
            l.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            if let peer, peer.canUpdate {
                let why = peer.error.flatMap { $0.isEmpty ? nil : $0 + "\n" } ?? ""
                l.toolTip = why + (peer.online ? "This computer runs an older Thoth than this Mac." : "Offline: update it when it is back.")
            }
            let v = NSView(); v.addSubview(img); v.addSubview(l)
            NSLayoutConstraint.activate([
                img.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 8), img.centerYAnchor.constraint(equalTo: v.centerYAnchor),
                img.widthAnchor.constraint(equalToConstant: 13), img.heightAnchor.constraint(equalToConstant: 13),
                l.leadingAnchor.constraint(equalTo: img.trailingAnchor, constant: 5), l.centerYAnchor.constraint(equalTo: v.centerYAnchor),
            ])
            let device = d
            var right: NSView?
            if let peer, peer.showsUpdateButton {
                let b = NSButton(title: peer.update == "failed" ? "Retry" : "Update", target: self, action: #selector(updateDeviceButton(_:)))
                // a filled orange (red: Retry) button with white text: a grey bezel was easy to miss
                b.isBordered = false
                b.wantsLayer = true
                b.layer?.backgroundColor = (peer.update == "failed" ? Theme.red : NSColor.systemOrange).cgColor
                b.layer?.cornerRadius = 5
                b.attributedTitle = NSAttributedString(string: b.title, attributes: [.foregroundColor: NSColor.white, .font: NSFont.systemFont(ofSize: 11, weight: .semibold)])
                b.image = Theme.icon("arrow.down.circle.fill", "Update")
                b.contentTintColor = .white
                b.imagePosition = .imageLeading
                b.imageHugsTitle = true
                b.widthAnchor.constraint(equalToConstant: b.intrinsicContentSize.width + 16).isActive = true
                b.heightAnchor.constraint(equalToConstant: 20).isActive = true
                b.identifier = NSUserInterfaceItemIdentifier(d)
                b.toolTip = "Send this Mac's Thoth to \(d): it installs it and restarts (about 20 seconds)"
                b.setAccessibilityIdentifier("sidebar.device.\(device).updateButton")
                right = b
            } else if peer?.update == "updating" {
                let sp = NSProgressIndicator()
                sp.style = .spinning
                sp.controlSize = .small
                sp.startAnimation(nil)
                sp.setAccessibilityIdentifier("sidebar.device.\(device).updating")
                right = sp
            }
            if let right {
                right.translatesAutoresizingMaskIntoConstraints = false
                v.addSubview(right)
                NSLayoutConstraint.activate([
                    right.trailingAnchor.constraint(equalTo: v.trailingAnchor, constant: -8), right.centerYAnchor.constraint(equalTo: v.centerYAnchor),
                    l.trailingAnchor.constraint(lessThanOrEqualTo: right.leadingAnchor, constant: -6),
                ])
            } else {
                l.trailingAnchor.constraint(lessThanOrEqualTo: v.trailingAnchor, constant: -8).isActive = true
            }
            return v
        case .join(let j):
            return joinCell(j)
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
            if selecting && !s.isRemote {
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
            v.toolTip = s.device.map { "\($0): \(s.folder)" } ?? shortPath(s.folder)
            // a helper computer that does not answer: its sessions grey
            if s.isOffline { v.alphaValue = 0.45 }
            return v
        }
    }

    /// "<name> wants to join": the name, the system, Approve and Ignore (the setup page's decide path,
    /// POST /api/setupCloudDevice). The row goes when the next state message no longer has it.
    private func joinCell(_ j: JoinRequest) -> NSView {
        let v = NSView()
        v.wantsLayer = true
        v.layer?.cornerRadius = 6
        v.layer?.backgroundColor = Theme.accent.withAlphaComponent(0.10).cgColor
        let icon = NSImageView(image: Theme.icon("desktopcomputer", j.system)!)
        icon.contentTintColor = Theme.accent
        icon.translatesAutoresizingMaskIntoConstraints = false
        let name = label(j.name, size: 13, weight: .medium)
        name.lineBreakMode = .byTruncatingTail
        // the system, host, time asked and "Approve only a computer you set up yourself." (server text)
        let sub = label(j.notice ?? j.system, size: 11, color: .secondaryLabelColor, lines: 2)
        let busy = deciding.contains(j.id)
        let approve = ActionButton("Approve", prominent: true) { [weak self] in self?.decide(j, "approve") }
        let ignore = ActionButton("Ignore") { [weak self] in self?.decide(j, "ignore") }
        for b in [approve, ignore] { b.controlSize = .small; b.font = .systemFont(ofSize: 11); b.isEnabled = !busy }
        approve.setAccessibilityIdentifier("join.approve.\(j.name)")
        ignore.setAccessibilityIdentifier("join.ignore.\(j.name)")
        approve.toolTip = "Let \(j.name) send its sessions to your brain"
        ignore.toolTip = "Do not let \(j.name) join (you can Unignore it in File > Set Up Devices…)"
        for x in [icon, name, sub] as [NSView] { x.translatesAutoresizingMaskIntoConstraints = false }
        [icon, name, sub, approve, ignore].forEach { v.addSubview($0) }
        v.setAccessibilityElement(true)
        v.setAccessibilityRole(.group)
        v.setAccessibilityLabel(j.title)
        v.toolTip = j.title
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 8),
            icon.centerYAnchor.constraint(equalTo: name.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 15), icon.heightAnchor.constraint(equalToConstant: 15),
            name.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 6),
            name.topAnchor.constraint(equalTo: v.topAnchor, constant: 6),
            name.trailingAnchor.constraint(lessThanOrEqualTo: v.trailingAnchor, constant: -8),
            sub.leadingAnchor.constraint(equalTo: name.leadingAnchor),
            sub.topAnchor.constraint(equalTo: name.bottomAnchor, constant: 1),
            sub.trailingAnchor.constraint(lessThanOrEqualTo: v.trailingAnchor, constant: -8),
            approve.leadingAnchor.constraint(equalTo: name.leadingAnchor),
            approve.bottomAnchor.constraint(equalTo: v.bottomAnchor, constant: -6),
            ignore.leadingAnchor.constraint(equalTo: approve.trailingAnchor, constant: 6),
            ignore.centerYAnchor.constraint(equalTo: approve.centerYAnchor),
        ])
        sub.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return v
    }

    private func decide(_ j: JoinRequest, _ decision: String) {
        deciding.insert(j.id)
        reload()
        Backend.shared.send("setupCloudDevice", ["id": j.id, "decision": decision], fail: { [weak self] message in
            self?.deciding.remove(j.id)
            self?.reload()
            Toast.show(message)
        }, done: { _ in
            Toast.show(decision == "approve" ? "\(j.name) can join now" : "\(j.name) is ignored")
        })
    }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        let rv = NSTableRowView()
        switch rows[row] {
        case .nav(let p, _, _): rv.setAccessibilityIdentifier(navID(p))
        case .session(let s): rv.setAccessibilityIdentifier("session.\(s.name)")
        case .header(let t): rv.setAccessibilityIdentifier("header.\(t)")
        case .device(let device, _, _): rv.setAccessibilityIdentifier("sidebar.device.\(device)")
        case .join: break   // the cell has join.<name>
        }
        return rv
    }

    /// Select mode: a click on a session row (also the open session's) ticks or unticks it.
    @objc private func rowClicked() {
        let row = table.clickedRow
        guard selecting, row >= 0, row < rows.count, case .session(let s) = rows[row], !s.isRemote else { return }
        toggle(s.id)
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !suppress, table.selectedRow >= 0 else { return }
        if selecting { return }   // rows cannot be selected in select mode (shouldSelectRow)
        switch rows[table.selectedRow] {
        case .nav(let p, _, _): selectedPage = p; onSelect?(p)
        case .session(let s): selectedPage = .session(s.id); onSelect?(.session(s.id))
        case .header, .device, .join: break
        }
    }
}

extension SidebarViewController: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let row = table.clickedRow
        // a helper computer's header: "Update <device>" when it runs an older Thoth (lib/self_update.ts)
        if row >= 0, case .device(let device, _, let peer) = rows[row] {
            let item = NSMenuItem(title: "Update \(device)", action: peer?.showsUpdateButton == true ? #selector(updateDevice(_:)) : nil, keyEquivalent: "")
            item.target = self
            item.representedObject = device
            item.setAccessibilityIdentifier("sidebar.device.\(device).update")
            menu.addItem(item)
            return
        }
        guard row >= 0, case .session(let s) = rows[row] else { return }
        let m = SessionMenu.make(for: s, open: { [weak self] in self?.onSelect?(.session(s.id)) },
                                 rename: { SessionMenu.askRename(s) })
        for item in m.items { m.removeItem(item); menu.addItem(item) }
    }
}

extension SidebarViewController {
    /// "Update <device>": the server sends this Mac's Thoth to the helper; the header shows
    /// "updating…" until the helper is back with the new build (or "update failed").
    @objc func updateDevice(_ sender: NSMenuItem) {
        guard let d = sender.representedObject as? String else { return }
        Backend.shared.post("updateHelper", ["device": d, "updateId": SessionMenu.newFetchId()])
    }

    /// The "Update" / "Retry" button on the helper's header: the same as the menu item.
    @objc func updateDeviceButton(_ sender: NSButton) {
        guard let d = sender.identifier?.rawValue else { return }
        sender.isEnabled = false   // one click (dimmed: its colors are on the layer);
        sender.alphaValue = 0.5
        // the header shows "updating…" at the next state message
        Backend.shared.post("updateHelper", ["device": d, "updateId": SessionMenu.newFetchId()])
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
