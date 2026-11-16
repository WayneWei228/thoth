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
        show(.home)
    }
    required init?(coder: NSCoder) { fatalError() }

    func show(_ p: Page) {
        page = p
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
            if Backend.shared.session(id) == nil && Backend.shared.connected { show(.sessions) } else { detail.reload() }
        }
        let needs = Backend.shared.sessions.filter { $0.sessionState == .needs }.count
        NSApp.dockTile.badgeLabel = needs > 0 ? "\(needs)" : nil
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
            settingsBtn.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -12),
        ])
        view = root
        reload()
    }

    @objc private func newSession() { AppDelegate.shared.window.showNewSession() }
    @objc private func openSettings() { SettingsWindowController.shared.present() }

    func reload() {
        let sessions = Backend.shared.sessions
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
        if let idx { table.selectRowIndexes([idx], byExtendingSelection: false) } else { table.deselectAll(nil) }
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
        case .session(let s): return (s.title?.isEmpty == false) ? 44 : 30
        }
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        if case .header = rows[row] { return false }
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

    private func cellView(_ row: Int) -> NSView? {
        switch rows[row] {
        case .header(let t):
            let l = label(t, size: 11, weight: .semibold, color: .tertiaryLabelColor)
            let v = NSView(); v.addSubview(l)
            NSLayoutConstraint.activate([l.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 8), l.bottomAnchor.constraint(equalTo: v.bottomAnchor, constant: -4)])
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
            let dot = StatusDot(); dot.state = s.sessionState
            let name = label(s.name, size: 13, weight: .medium)
            let time = label(s.sessionState == .needs ? "Needs you" : ago(s.activity), size: 11, color: s.sessionState == .needs ? Theme.red : .tertiaryLabelColor)
            time.setContentCompressionResistancePriority(.required, for: .horizontal)
            v.addSubview(dot); v.addSubview(name); v.addSubview(time)
            var cons = [
                dot.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 10),
                name.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 10),
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
            if let t = s.title, !t.isEmpty {
                let sub = label(t, size: 11, color: .secondaryLabelColor)
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

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !suppress, table.selectedRow >= 0 else { return }
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
