import AppKit
import WebKit

/// First-run setup. The web page /setup.html does every step;
/// this window only hosts it, shows a "Starting…" state while the server comes up, and shows
/// an error with "Copy diagnostics" when the server never answers.
final class SetupWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    enum Mode { case firstRun, menu }

    private let web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    private let startingBox = NSStackView()
    private let errorBox = NSStackView()
    private let errorText = NSTextField(wrappingLabelWithString: "")
    private let diagNote = NSTextField(labelWithString: "")
    private var poll: Timer?
    private var loaded = false
    private var finishing = false
    private(set) var mode: Mode = .firstRun
    /// Called once when setup is finished (or the window is closed in first-run mode with setup done).
    var onFinished: (() -> Void)?

    init() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 820, height: 780),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable],
                         backing: .buffered, defer: false)
        w.title = "Set Up Thoth"
        w.minSize = NSSize(width: 560, height: 520)
        w.setFrameAutosaveName("ClaudePanelSetup")
        super.init(window: w)
        w.delegate = self
        w.isReleasedWhenClosed = false
        build(w)
        w.center()
    }
    required init?(coder: NSCoder) { fatalError() }

    private func build(_ w: NSWindow) {
        let root = NSView()
        w.contentView = root
        web.navigationDelegate = self
        web.uiDelegate = self
        web.setAccessibilityIdentifier("setup.web")
        web.isHidden = true
        for v in [web, startingBox, errorBox] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(v)
        }
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: root.topAnchor), web.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: root.leadingAnchor), web.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            startingBox.centerXAnchor.constraint(equalTo: root.centerXAnchor), startingBox.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            errorBox.centerXAnchor.constraint(equalTo: root.centerXAnchor), errorBox.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            errorBox.widthAnchor.constraint(lessThanOrEqualToConstant: 520),
        ])

        startingBox.orientation = .vertical
        startingBox.spacing = 12
        let spin = NSProgressIndicator()
        spin.style = .spinning
        spin.startAnimation(nil)
        let title = NSTextField(labelWithString: "Starting Thoth…")
        title.font = .systemFont(ofSize: 17, weight: .semibold)
        title.setAccessibilityIdentifier("setup.starting")
        let sub = NSTextField(labelWithString: "This takes a few seconds.")
        sub.textColor = .secondaryLabelColor
        for v in [spin, title, sub] as [NSView] { startingBox.addArrangedSubview(v) }

        errorBox.orientation = .vertical
        errorBox.spacing = 12
        errorBox.alignment = .leading
        errorBox.isHidden = true
        let et = NSTextField(labelWithString: "Thoth could not start its server")
        et.font = .systemFont(ofSize: 17, weight: .semibold)
        et.setAccessibilityIdentifier("setup.error")
        errorText.textColor = .secondaryLabelColor
        errorText.setAccessibilityIdentifier("setup.error.detail")
        let copy = NSButton(title: "Copy diagnostics", target: self, action: #selector(copyDiagnostics))
        copy.setAccessibilityIdentifier("setup.copyDiagnostics")
        let retry = NSButton(title: "Try again", target: self, action: #selector(retry))
        retry.setAccessibilityIdentifier("setup.retry")
        retry.bezelColor = Theme.accent   // the main action, as the prominent buttons of the panel (ActionButton)
        diagNote.textColor = .secondaryLabelColor
        let row = NSStackView(views: [copy, retry, diagNote])
        row.spacing = 8
        for v in [et, errorText, row] as [NSView] { errorBox.addArrangedSubview(v) }
    }

    // MARK: states

    func present(_ mode: Mode) {
        self.mode = mode
        finishing = false
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        Instance.activate()
        poll?.invalidate()
        if loaded { web.reload() } else { showStarting() }
        // Wait for the server (the app starts it), then load the page.
        waitForServer(deadline: Date().addingTimeInterval(30))
    }

    private func showStarting() {
        startingBox.isHidden = false; errorBox.isHidden = true; web.isHidden = true
    }

    private func showError(_ text: String) {
        startingBox.isHidden = true; errorBox.isHidden = false; web.isHidden = true
        errorText.stringValue = text
        diagNote.stringValue = ""
    }

    private func waitForServer(deadline: Date) {
        Backend.shared.fetchSetupDone { [weak self] done in
            guard let self, self.window?.isVisible == true else { return }
            // first-run window that only waited for a slow server: setup is already done, open the panel
            if done == true, self.mode == .firstRun, !self.loaded { self.finish(); return }
            if done != nil { self.loadPage(); return }
            if Date() > deadline {
                self.showError("The server on port \(Backend.shared.port) did not answer after 30 seconds. Copy the diagnostics and send them to whoever helps you with Thoth.")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in self?.waitForServer(deadline: deadline) }
        }
    }

    private func loadPage() {
        loaded = true
        startingBox.isHidden = true; errorBox.isHidden = true; web.isHidden = false
        web.load(URLRequest(url: Backend.shared.base.appendingPathComponent("setup.html")))
        poll?.invalidate()
        // The page may finish in another browser: close when the server says setup is done.
        guard mode == .firstRun else { return }
        poll = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Backend.shared.fetchSetupDone { done in if done == true { self?.finish() } }
        }
    }

    private func finish() {
        poll?.invalidate(); poll = nil
        finishing = true
        let cb = onFinished
        window?.close()
        cb?()
    }

    @objc private func retry() { showStarting(); Backend.shared.start(); waitForServer(deadline: Date().addingTimeInterval(30)) }

    @objc private func copyDiagnostics() {
        let text = Backend.shared.diagnostics()
        Instance.pasteboard.clearContents()
        Instance.pasteboard.setString(text, forType: .string)
        diagNote.stringValue = "Copied."
    }

    /// Closing the window in first-run mode before the end opens the normal panel window.
    /// Setup stays reachable (File > Set Up Devices…) and the page resumes at its saved step.
    func windowWillClose(_ notification: Notification) {
        poll?.invalidate(); poll = nil
        if mode == .firstRun, !finishing {
            finishing = true
            let cb = onFinished
            DispatchQueue.main.async { cb?() }
        }
    }

    // MARK: web view

    /// The page ends setup with location.href = "/" (or the "Open the panel" link).
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.host == "127.0.0.1", url.port == Backend.shared.port, url.path == "/" || url.path.isEmpty {
            decisionHandler(.cancel)
            finish()
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { loadFailed(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { loadFailed(error) }
    private func loadFailed(_ error: Error) {
        loaded = false
        showError("The setup page did not load: \(error.localizedDescription)")
    }

    /// The page uses confirm() before disconnecting a device; WKWebView needs this to show it.
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.runModal()
        completionHandler()
    }
}

