import AppKit
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    static var shared: AppDelegate!
    var window: MainWindowController!
    private var prevStates: [String: String] = [:]

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppDelegate.shared = self
        buildMenu()
        Backend.shared.start()
        window = MainWindowController()
        setUpNotifications()
        Backend.shared.onChange.append { [weak self] in self?.notifyChanges() }
        RouteWatcher.shared.start()
        launchGate(deadline: Date().addingTimeInterval(30), started: Date())
        if Instance.background { listenForVerifyPaste() }
    }

    /// Background verify instance only: a key press cannot reach an app that is not in
    /// front, so the verify script asks for Paste with a notification. It runs the same
    /// paste(_:) as Cmd+V in the session composer, reading the instance's own pasteboard.
    private func listenForVerifyPaste() {
        DistributedNotificationCenter.default().addObserver(
            self, selector: #selector(verifyPaste),
            name: Notification.Name((Bundle.main.bundleIdentifier ?? "") + ".verify.paste"),
            object: nil, suspensionBehavior: .deliverImmediately)
    }

    @objc private func verifyPaste() {
        func find(_ v: NSView) -> ComposerTextView? {
            if let t = v as? ComposerTextView, t.accessibilityIdentifier() == "detail.composer.input", !t.isHiddenOrHasHiddenAncestor { return t }
            for s in v.subviews { if let t = find(s) { return t } }
            return nil
        }
        for w in NSApp.windows where w.isVisible {
            if let root = w.contentView, let t = find(root) {
                w.makeFirstResponder(t)
                t.paste(nil)
                return
            }
        }
    }

    // MARK: first run (W1): setup window or normal window

    let setup = SetupWindowController()
    private var gateDone = false

    /// Ask the server whether setup is done. Done (or an old server): the normal window.
    /// Not done: the setup window. No answer yet: the setup window's "Starting…" state after a moment, an error after 30 s.
    /// Setup was finished on this Mac before (saved when the server says so). Such a launch opens
    /// the normal window at once, even while the server is still starting (after a restart of the
    /// Mac it can take many seconds): the window waits for it and shows the last page.
    static let setupSeenKey = "setupDoneSeen"

    private func launchGate(deadline: Date, started: Date) {
        if UserDefaults.standard.bool(forKey: Self.setupSeenKey) && !gateDone {
            gateDone = true
            showMain()
            // the state folder can be new (moved, wiped): then setup runs again
            Backend.shared.fetchSetupDone { [weak self] done in
                if done == false { UserDefaults.standard.set(false, forKey: Self.setupSeenKey); self?.showSetup(.firstRun) }
            }
            return
        }
        Backend.shared.fetchSetupDone { [weak self] done in
            guard let self, !self.gateDone else { return }
            if let done {
                self.gateDone = true
                if done { UserDefaults.standard.set(true, forKey: Self.setupSeenKey); self.showMain() } else { self.showSetup(.firstRun) }
                return
            }
            if Date() > deadline {
                self.gateDone = true
                self.showSetup(.firstRun)   // the window waits, then shows the error with Copy diagnostics
                return
            }
            if Date().timeIntervalSince(started) > 1.5, !self.setup.window!.isVisible { self.showSetup(.firstRun) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.launchGate(deadline: deadline, started: started) }
        }
    }

    private func showMain() {
        window.showWindow(nil)
        Instance.activate()
    }

    func showSetup(_ mode: SetupWindowController.Mode) {
        setup.onFinished = { [weak self] in
            self?.gateDone = true
            Backend.shared.fetchSetupDone { done in if done == true { UserDefaults.standard.set(true, forKey: AppDelegate.setupSeenKey) } }
            self?.showMain()
        }
        setup.present(mode)
    }


    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Switch the look now: save it, then build the main window again on the same page (views read
    /// the look when they are built). Sessions keep running; only the window is new.
    func setLook(_ look: Theme.Look) {
        guard look != Theme.look else { return }
        UserDefaults.standard.set(look.rawValue, forKey: Theme.lookKey)
        NSApp.appearance = look == .website ? NSAppearance(named: .aqua) : nil
        guard let old = window else { return }
        let page = old.page, visible = old.window?.isVisible ?? false
        old.window?.saveFrame(usingName: "ClaudePanelMain")
        old.window?.orderOut(nil)
        window = MainWindowController()
        window.show(page)
        if visible { window.showWindow(nil) }
        old.close()
    }

    /// claudepanel://session/<tmux window id>  (used by `thoth adopt` / the /panel command)
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == Instance.urlScheme {
            let id = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")).removingPercentEncoding ?? ""
            guard url.host == "session", id.hasPrefix("@") else { continue }
            Instance.activate()
            window?.showWindow(nil)
            openWhenKnown(id, tries: 40)
        }
    }

    /// The new window shows up in the backend state within a poll or two.
    private func openWhenKnown(_ id: String, tries: Int) {
        if Backend.shared.session(id) != nil { window.show(.session(id)); return }
        guard tries > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.openWhenKnown(id, tries: tries - 1) }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { if setup.window?.isVisible == true { setup.showWindow(nil) } else if gateDone { window.showWindow(nil) } }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        // only the view session ends; Claude sessions keep running in tmux
        TerminalHost.shared.stop()
    }

    // MARK: notifications (needs you / finished), only when the app is not in front

    private var notificationsAvailable: Bool { Bundle.main.bundleIdentifier != nil && !Instance.isTest }

    private func setUpNotifications() {
        guard notificationsAvailable else { return }
        let c = UNUserNotificationCenter.current()
        c.delegate = self
        c.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    private func notifyChanges() {
        for s in Backend.shared.sessions {
            let prev = prevStates[s.id]
            prevStates[s.id] = s.state
            guard let prev, prev != s.state, !s.isOffline else { continue }
            if s.sessionState == .needs { post("\(s.name) needs you", s.question.isEmpty ? "Claude is waiting for your choice." : s.question, id: s.id) }
            if prev == "working" && s.sessionState == .idle { post("\(s.name) is done", s.last, id: s.id) }
        }
    }

    private func post(_ title: String, _ body: String, id: String) {
        guard notificationsAvailable, !NSApp.isActive else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = String(body.prefix(180))
        content.sound = .default
        content.userInfo = ["id": id]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id + "-" + UUID().uuidString, content: content, trigger: nil))
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        if let id = response.notification.request.content.userInfo["id"] as? String {
            DispatchQueue.main.async {
                Instance.activate()
                self.window.showWindow(nil)
                self.window.show(.session(id))
            }
        }
        done()
    }

    // MARK: menu

    private func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let app = NSMenu()
        app.addItem(withTitle: "About Thoth", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        let settingsItem = ClosureMenuItemKey(title: "Settings…", key: ",") { SettingsWindowController.shared.present() }
        settingsItem.setAccessibilityIdentifier("menu.settings")
        app.addItem(settingsItem)
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Thoth", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit Thoth", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app

        let fileItem = NSMenuItem(); main.addItem(fileItem)
        let file = NSMenu(title: "File")
        file.addItem(ClosureMenuItemKey(title: "New Request", key: "n") { [weak self] in self?.window.show(.home) })
        file.addItem(ClosureMenuItemKey(title: "New Session…", key: "N") { [weak self] in self?.window.showNewSession() })
        file.addItem(.separator())
        let setupItem = ClosureMenuItemKey(title: "Set Up Devices…", key: "") { [weak self] in self?.showSetup(.menu) }
        setupItem.setAccessibilityIdentifier("menu.setUpDevices")
        file.addItem(setupItem)
        file.addItem(.separator())
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = file

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(ClosureMenuItemKey(title: "Home", key: "0") { [weak self] in self?.window.show(.home) })
        view.addItem(ClosureMenuItemKey(title: "All Sessions", key: "l") { [weak self] in self?.window.show(.sessions) })
        view.addItem(ClosureMenuItemKey(title: "All Devices", key: "e") { [weak self] in self?.window.show(.everywhere) })
        for i in 1...9 {
            view.addItem(ClosureMenuItemKey(title: "Session \(i)", key: "\(i)") { [weak self] in
                let list = Backend.shared.sessions
                if i <= list.count { self?.window.show(.session(list[i - 1].id)) }
            })
        }
        view.addItem(.separator())
        view.addItem(withTitle: "Toggle Sidebar", action: #selector(NSSplitViewController.toggleSidebar(_:)), keyEquivalent: "s")
        view.items.last?.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = view

        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        winItem.submenu = win
        NSApp.windowsMenu = win

        NSApp.mainMenu = main
    }
}

final class ClosureMenuItemKey: NSMenuItem {
    private let handler: () -> Void
    init(title: String, key: String, handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(fire), keyEquivalent: key)
        target = self
    }
    required init(coder: NSCoder) { fatalError() }
    @objc private func fire() { handler() }
}

// Before anything reads UserDefaults: take over the settings of the old bundle id (once).
let migratedDefaults = LegacyDefaults.migrate()
// Test switch: do only the migration and exit. It skips the
// windows and the server start; the migration call above is the same one a normal launch makes.
if CommandLine.arguments.contains("--migrate-defaults-only") {
    UserDefaults.standard.synchronize()
    print("migrated \(migratedDefaults) keys")
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
if Theme.web { app.appearance = NSAppearance(named: .aqua) }   // the website look is ink on paper: light only
app.setActivationPolicy(.regular)
app.run()
