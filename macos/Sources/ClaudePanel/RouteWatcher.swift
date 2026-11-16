import AppKit

/// Follows each request sent from the Ask box until the router is done, on every page (Home
/// reloads only while it is shown). When a request fails, the user sees it at once: a sheet with
/// the error, "Try Again" (the same text and files) and "Edit" (the text goes back into the Ask
/// box). Before this, a failed request only set a "Failed" card on Home, and when the app could not
/// read the state message it showed nothing at all (2026-11-10: two requests looked swallowed).
final class RouteWatcher {
    static let shared = RouteWatcher()
    private struct Request { let text: String; let files: [String] }
    private var mine: [String: Request] = [:]
    private var started = false

    func start() {
        guard !started else { return }
        started = true
        Backend.shared.onChange.append { [weak self] in self?.check() }
    }

    /// Send a request to the router and follow it.
    func send(_ text: String, _ files: [String]) {
        Backend.shared.send("route", ["text": text, "attachments": files], fail: { [weak self] error in
            self?.failed(text: text, files: files, error: error)
        }) { [weak self] r in
            guard let rid = r["routeId"] as? String else {
                self?.failed(text: text, files: files, error: r["error"] as? String ?? "The server did not take the request")
                return
            }
            self?.mine[rid] = Request(text: text, files: files)
            Toast.show("Finding the right session…")
            self?.check()
        }
    }

    /// The route ids that are still being followed (Home jumps to the session for these).
    func isMine(_ id: String) -> Bool { mine[id] != nil }
    func done(_ id: String) { mine[id] = nil }

    private func check() {
        for (rid, req) in mine {
            guard let r = Backend.shared.routes.first(where: { $0.id == rid }) else { continue }
            if r.status == "error" {
                mine[rid] = nil
                failed(text: req.text, files: req.files, error: r.error ?? "Unknown error")
            } else if r.status == "ask" {
                mine[rid] = nil
                Toast.show("Which session? Choose on Home.")
            } else if r.status == "split" {
                // several jobs went to several sessions: Home lists each task under the request
                mine[rid] = nil
                Toast.show("Split into \(r.tasks?.count ?? 0) tasks. See Home.")
            }
            // a sent request: Home jumps to its session and calls done()
        }
    }

    private func failed(text: String, files: [String], error: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Your request was not sent"
        let shown = text.count > 300 ? String(text.prefix(300)) + "…" : text
        alert.informativeText = "\(shown)\n\nError: \(error)"
        alert.addButton(withTitle: "Try Again")
        alert.addButton(withTitle: "Edit")
        alert.addButton(withTitle: "Close")
        alert.buttons[0].setAccessibilityIdentifier("route.failed.retry")
        alert.buttons[1].setAccessibilityIdentifier("route.failed.edit")
        alert.window.setAccessibilityIdentifier("route.failed")
        let handle: (NSApplication.ModalResponse) -> Void = { [weak self] resp in
            switch resp {
            case .alertFirstButtonReturn: self?.send(text, files)
            case .alertSecondButtonReturn:
                let w = AppDelegate.shared.window
                w?.show(.home)
                w?.home.restore(text, files)
            default: break
            }
        }
        if let win = AppDelegate.shared.window?.window, win.attachedSheet == nil {
            alert.beginSheetModal(for: win, completionHandler: handle)
        } else {
            handle(alert.runModal())
        }
    }
}
