import AppKit
import WebKit

/// One session: header with actions, a choice bar when Claude asks something,
/// the native terminal, and a composer.
final class SessionDetailViewController: NSViewController, NSTextFieldDelegate {
    private var sessionId: String?
    private let dot = StatusDot()
    private let nameField = NSTextField(string: "")
    private let editBtn = NSButton()
    private let pill = Pill()
    /// Small muted "Codex" badge next to the state pill; hidden for Claude Code sessions.
    private let agentBadge = Pill()
    private let titleLabel = label("", size: 12, color: .secondaryLabelColor)
    private let pathLabel = label("", size: 12, color: .secondaryLabelColor)
    private var resumeBtn: ActionButton!
    private var stopBtn: ActionButton!
    /// Only for a session on this Mac (a helper computer's folder is not here; it closes from there).
    private var localOnly: [NSView] = []
    private var closeBtn = NSView()
    private var fetchBtn: ActionButton!
    private let choiceBar = NSView()
    private let choiceQ = label("", size: 13, weight: .semibold, lines: 2)
    /// Claude's menu as a numbered list, one option per row (like the terminal menu).
    private let choiceButtons = NSStackView()
    private let notice = NSView()
    private let noticeLabel = label("", size: 12, lines: 4)
    private let termHolder = NSView()
    private var composer: ComposerBox!
    private var choiceKey = ""
    private lazy var chat: WKWebView = {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(ChatBridge(), name: "panel")
        return WKWebView(frame: .zero, configuration: cfg)
    }()
    private var aboveComposer: NSLayoutConstraint!
    private var toBottom: NSLayoutConstraint!
    private let modeSwitch = NSSegmentedControl(labels: ["Chat", "Terminal"], trackingMode: .selectOne, target: nil, action: nil)
    private var chatWin: String?

    override func loadView() {
        let root = NSView()

        // header
        let header = NSView()
        header.translatesAutoresizingMaskIntoConstraints = false
        nameField.isBordered = false
        nameField.drawsBackground = false
        nameField.isEditable = false
        nameField.font = .systemFont(ofSize: 18, weight: .semibold)
        nameField.delegate = self
        nameField.translatesAutoresizingMaskIntoConstraints = false
        nameField.toolTip = "Double-click to rename"
        nameField.setAccessibilityIdentifier("detail.name")
        pill.setAccessibilityIdentifier("detail.state")
        editBtn.setAccessibilityIdentifier("detail.rename")
        agentBadge.setMuted("Codex")
        agentBadge.toolTip = "Runs the Codex CLI"
        agentBadge.isHidden = true
        agentBadge.setAccessibilityIdentifier("detail.agent")
        let pills = NSStackView(views: [pill, agentBadge])   // a hidden badge takes no space
        pills.spacing = 6
        pills.translatesAutoresizingMaskIntoConstraints = false
        let dbl = NSClickGestureRecognizer(target: self, action: #selector(startRename))
        dbl.numberOfClicksRequired = 2
        nameField.addGestureRecognizer(dbl)
        editBtn.image = Theme.icon("pencil", "Rename")
        editBtn.isBordered = false
        editBtn.target = self
        editBtn.action = #selector(startRename)
        editBtn.toolTip = "Rename"
        editBtn.translatesAutoresizingMaskIntoConstraints = false
        resumeBtn = ActionButton("Resume", symbol: "play.fill", prominent: true) { [weak self] in self?.resume() }
        stopBtn = ActionButton("Stop", symbol: "stop.fill") { [weak self] in
            if let id = self?.sessionId { Backend.shared.post("interrupt", ["id": id]) }
        }
        let finder = ActionButton("", symbol: "folder") { [weak self] in
            if let s = self?.current { Backend.shared.post("reveal", ["folder": s.folder]) }
        }
        finder.toolTip = "Show in Finder"
        let code = ActionButton("VS Code", symbol: "chevron.left.forwardslash.chevron.right") { [weak self] in
            if let s = self?.current { Backend.shared.post("reveal", ["folder": s.folder, "app": "code"]) }
        }
        let close = ActionButton("", symbol: "xmark.circle") { [weak self] in
            if let s = self?.current { SessionMenu.close(s) }
        }
        close.toolTip = "Close session"
        closeBtn = close
        fetchBtn = ActionButton("Fetch Result", symbol: "arrow.down.circle") { [weak self] in
            if let s = self?.current { SessionMenu.fetch(s) }
        }
        fetchBtn.toolTip = "Take the committed work of this session to this Mac as a branch helper/<computer>/<name>. Your checkout does not change."
        fetchBtn.setAccessibilityIdentifier("detail.fetch")
        localOnly = [finder, code]
        resumeBtn.setAccessibilityIdentifier("detail.resume")
        stopBtn.setAccessibilityIdentifier("detail.stop")
        finder.setAccessibilityIdentifier("detail.finder")
        code.setAccessibilityIdentifier("detail.code")
        close.setAccessibilityIdentifier("detail.close")
        modeSwitch.selectedSegment = UserDefaults.standard.integer(forKey: "detail.mode")
        modeSwitch.target = self
        modeSwitch.action = #selector(modeChanged)
        modeSwitch.setAccessibilityIdentifier("detail.mode")
        modeSwitch.setToolTip("Chat view or the raw terminal", forSegment: 0)
        let actions = NSStackView(views: [modeSwitch, resumeBtn, stopBtn, fetchBtn, finder, code, close])
        actions.spacing = 6
        actions.translatesAutoresizingMaskIntoConstraints = false
        [dot, nameField, editBtn, pills, titleLabel, pathLabel, actions].forEach { header.addSubview($0) }
        NSLayoutConstraint.activate([
            dot.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 20),
            dot.centerYAnchor.constraint(equalTo: nameField.centerYAnchor),
            nameField.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 10),
            nameField.topAnchor.constraint(equalTo: header.topAnchor, constant: 38),
            nameField.widthAnchor.constraint(greaterThanOrEqualToConstant: 60),
            nameField.widthAnchor.constraint(lessThanOrEqualToConstant: 280),
            editBtn.leadingAnchor.constraint(equalTo: nameField.trailingAnchor, constant: 2),
            editBtn.centerYAnchor.constraint(equalTo: nameField.centerYAnchor),
            pills.leadingAnchor.constraint(equalTo: editBtn.trailingAnchor, constant: 8),
            pills.centerYAnchor.constraint(equalTo: nameField.centerYAnchor),
            titleLabel.leadingAnchor.constraint(equalTo: pills.trailingAnchor, constant: 10),
            titleLabel.centerYAnchor.constraint(equalTo: nameField.centerYAnchor),
            titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: actions.leadingAnchor, constant: -12),
            pathLabel.leadingAnchor.constraint(equalTo: nameField.leadingAnchor, constant: 2),
            pathLabel.topAnchor.constraint(equalTo: nameField.bottomAnchor, constant: 2),
            pathLabel.trailingAnchor.constraint(lessThanOrEqualTo: actions.leadingAnchor, constant: -12),
            pathLabel.bottomAnchor.constraint(equalTo: header.bottomAnchor, constant: -10),
            actions.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -20),
            actions.centerYAnchor.constraint(equalTo: nameField.centerYAnchor, constant: 8),
        ])

        // choice bar
        choiceBar.wantsLayer = true
        choiceBar.layer?.backgroundColor = Theme.red.withAlphaComponent(0.12).cgColor
        choiceBar.translatesAutoresizingMaskIntoConstraints = false
        let bell = NSImageView(image: Theme.icon("exclamationmark.circle.fill", nil)!)
        bell.contentTintColor = Theme.red
        bell.translatesAutoresizingMaskIntoConstraints = false
        choiceButtons.orientation = .vertical
        choiceButtons.alignment = .leading
        choiceButtons.spacing = 5
        choiceButtons.translatesAutoresizingMaskIntoConstraints = false
        // the bar takes only the height it needs; the terminal / chat gets the rest
        choiceBar.setContentHuggingPriority(.required, for: .vertical)
        choiceQ.setContentHuggingPriority(.required, for: .vertical)
        choiceButtons.setHuggingPriority(.required, for: .vertical)
        [bell, choiceQ, choiceButtons].forEach { choiceBar.addSubview($0) }
        NSLayoutConstraint.activate([
            bell.leadingAnchor.constraint(equalTo: choiceBar.leadingAnchor, constant: 20),
            bell.topAnchor.constraint(equalTo: choiceBar.topAnchor, constant: 12),
            choiceQ.leadingAnchor.constraint(equalTo: bell.trailingAnchor, constant: 8),
            choiceQ.trailingAnchor.constraint(equalTo: choiceBar.trailingAnchor, constant: -20),
            choiceQ.topAnchor.constraint(equalTo: choiceBar.topAnchor, constant: 11),
            choiceButtons.leadingAnchor.constraint(equalTo: choiceQ.leadingAnchor),
            choiceButtons.trailingAnchor.constraint(lessThanOrEqualTo: choiceQ.trailingAnchor),
            choiceButtons.topAnchor.constraint(equalTo: choiceQ.bottomAnchor, constant: 8),
            choiceButtons.bottomAnchor.constraint(equalTo: choiceBar.bottomAnchor, constant: -12),
        ])

        // notice
        notice.wantsLayer = true
        notice.layer?.backgroundColor = Theme.amber.withAlphaComponent(0.12).cgColor
        notice.translatesAutoresizingMaskIntoConstraints = false
        notice.addSubview(noticeLabel)
        NSLayoutConstraint.activate([
            noticeLabel.leadingAnchor.constraint(equalTo: notice.leadingAnchor, constant: 20),
            noticeLabel.trailingAnchor.constraint(equalTo: notice.trailingAnchor, constant: -20),
            noticeLabel.topAnchor.constraint(equalTo: notice.topAnchor, constant: 9),
            noticeLabel.bottomAnchor.constraint(equalTo: notice.bottomAnchor, constant: -9),
        ])

        // terminal holder (the shared terminal view is added in viewWillAppear)
        termHolder.wantsLayer = true
        termHolder.layer?.backgroundColor = Theme.terminalBG.cgColor
        termHolder.translatesAutoresizingMaskIntoConstraints = false
        termHolder.setContentHuggingPriority(.defaultLow, for: .vertical)

        composer = ComposerBox(placeholder: Self.placeholder("Claude"), fontSize: 14, idPrefix: "detail.composer") { [weak self] t, files in
            guard let id = self?.sessionId else { return }
            // the chat page shows the sent message at once (it is in the transcript only after the prompt hooks)
            Backend.shared.post("send", ["id": id, "text": t, "attachments": files]) { _ in
                self?.chat.evaluateJavaScript("window.pollNow && pollNow()")
            }
        }
        composer.minHeight = 36
        choiceBar.setAccessibilityIdentifier("detail.choiceBar")
        notice.setAccessibilityIdentifier("detail.notice")
        composer.maxHeight = 140

        chat.setValue(false, forKey: "drawsBackground")
        chat.translatesAutoresizingMaskIntoConstraints = false
        chat.setAccessibilityIdentifier("detail.chat")
        termHolder.addSubview(chat)
        NSLayoutConstraint.activate([
            chat.leadingAnchor.constraint(equalTo: termHolder.leadingAnchor),
            chat.trailingAnchor.constraint(equalTo: termHolder.trailingAnchor),
            chat.topAnchor.constraint(equalTo: termHolder.topAnchor),
            chat.bottomAnchor.constraint(equalTo: termHolder.bottomAnchor),
        ])
        // Chat mode: the choice bar sits at the end of the conversation, right above the composer.
        // Terminal mode: no choice bar and no composer; the terminal itself takes the answer and the typing.
        let column = NSStackView(views: [header, notice, termHolder, choiceBar])
        column.orientation = .vertical
        column.spacing = 0
        column.alignment = .leading
        column.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(column)
        root.addSubview(composer)
        // the composer shows only in Chat mode; in Terminal mode you type into the terminal itself
        aboveComposer = column.bottomAnchor.constraint(equalTo: composer.topAnchor, constant: -10)
        toBottom = column.bottomAnchor.constraint(equalTo: root.bottomAnchor)
        for v in [header, notice, termHolder, choiceBar] { v.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true }
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: root.topAnchor),
            column.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            column.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            aboveComposer,
            composer.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            composer.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            composer.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -12),
        ])
        view = root
    }

    var current: Session? { Backend.shared.session(sessionId) }

    /// Drafts follow the conversation (transcript id), not the tmux window id: after tmux restarts,
    /// window ids are new and could point at another session's draft.
    private static func draftKey(_ id: String) -> String {
        if let s = Backend.shared.session(id), !s.sid.isEmpty { return "sid.\(s.sid)" }
        return id
    }

    func load(_ id: String) {
        _ = view
        if sessionId != id { choiceKey = "" }
        sessionId = id
        attachTerminal()
        // a helper computer's session has no terminal on this Mac: only Chat (lib/peer.ts)
        if current?.isRemote != true { TerminalHost.shared.show(id) }
        composer.draftKey = Self.draftKey(id)
        if chatWin != id {
            chatWin = id
            let u = Backend.shared.base.appendingPathComponent("chat.html")
            var c = URLComponents(url: u, resolvingAgainstBaseURL: false)!
            c.queryItems = [URLQueryItem(name: "win", value: id)] + (Theme.web ? [URLQueryItem(name: "look", value: "website")] : [])
            chat.load(URLRequest(url: c.url!))
        }
        applyMode()
        reload()
    }

    @objc private func modeChanged() {
        UserDefaults.standard.set(modeSwitch.selectedSegment, forKey: "detail.mode")
        applyMode()
    }

    private static func placeholder(_ agent: String) -> String { "Message \(agent)…  (paste or drop images and files)" }

    /// Chat, or the terminal. A helper computer's session is always Chat (no terminal through the relay).
    private var chatMode: Bool { modeSwitch.selectedSegment == 0 || current?.isRemote == true }

    private func applyMode() {
        let chatMode = self.chatMode
        chat.isHidden = !chatMode
        TerminalHost.shared.view.isHidden = chatMode
        termHolder.layer?.backgroundColor = chatMode ? NSColor.clear.cgColor : Theme.terminalBG.cgColor
        reload()   // the choice bar belongs to Chat mode
        updateComposer()
        view.window?.makeFirstResponder(chatMode ? composer.text : TerminalHost.shared.view)
    }

    /// Composer only in Chat mode and only while Claude runs; otherwise the page content
    /// reaches the bottom of the window.
    private func updateComposer() {
        let show = chatMode && (current?.running ?? false) && current?.isOffline != true
        composer.isHidden = !show
        // deactivate first: both active at once would conflict
        if show { toBottom.isActive = false; aboveComposer.isActive = true } else { aboveComposer.isActive = false; toBottom.isActive = true }
    }

    private func attachTerminal() {
        let t = TerminalHost.shared.view
        guard t.superview !== termHolder else { return }
        t.removeFromSuperview()
        termHolder.addSubview(t)
        NSLayoutConstraint.activate([
            t.leadingAnchor.constraint(equalTo: termHolder.leadingAnchor, constant: 10),
            t.trailingAnchor.constraint(equalTo: termHolder.trailingAnchor, constant: -4),
            t.topAnchor.constraint(equalTo: termHolder.topAnchor, constant: 6),
            t.bottomAnchor.constraint(equalTo: termHolder.bottomAnchor, constant: -4),
        ])
    }

    func reload() {
        guard isViewLoaded, let s = current else { return }
        if let id = sessionId { composer.moveDraft(to: Self.draftKey(id)) }
        dot.state = s.sessionState
        if !nameField.isEditable { nameField.stringValue = s.name }
        pill.set(s.sessionState)
        agentBadge.isHidden = !s.isCodex
        let ph = Self.placeholder(s.isCodex ? "Codex" : "Claude")
        if composer.text.placeholder != ph { composer.text.placeholder = ph }
        titleLabel.stringValue = s.title ?? ""
        let place = s.device.map { s.folder.isEmpty ? "on \($0)" : "on \($0)  ·  \(s.folder)" } ?? shortPath(s.folder)
        editBtn.isHidden = s.isPending   // a row still preparing cannot be renamed
        pathLabel.stringValue = place + (s.branch.isEmpty ? "" : "  ·  ⎇ \(s.branch)")
        modeSwitch.isHidden = s.isRemote
        localOnly.forEach { $0.isHidden = s.isRemote }
        closeBtn.isHidden = s.isRemote && !s.isPending   // a pending row on a helper: closing cancels it
        if s.isRemote && chat.isHidden { applyMode() }
        resumeBtn.isHidden = s.running || s.isOffline || s.isPending
        resumeBtn.title = s.sid.isEmpty ? "Start" : "Resume"
        stopBtn.isHidden = s.sessionState != .working || s.isOffline
        fetchBtn.isHidden = !s.canFetch
        fetchBtn.title = s.isFetching ? "Cancel Fetch" : "Fetch Result"
        updateComposer()

        // choice bar: Claude's menu as buttons
        let key = s.sessionState == .needs ? s.options.map(\.label).joined(separator: "|") : ""
        choiceBar.isHidden = key.isEmpty || !chatMode || s.isOffline
        if key != choiceKey {
            choiceKey = key
            choiceQ.stringValue = s.question.isEmpty ? "\(s.isCodex ? "Codex" : "Claude") needs your decision" : s.question
            choiceButtons.arrangedSubviews.forEach { $0.removeFromSuperview() }
            for o in s.options {
                let b = ActionButton("\(o.n).  \(o.label)") { [weak self] in
                    guard let id = self?.sessionId else { return }
                    Backend.shared.post("choose", ["id": id, "n": o.n])
                    if let c = self?.composer { self?.view.window?.makeFirstResponder(c.text) }
                }
                if o.label.lowercased().hasPrefix("yes") { b.bezelColor = Theme.green }   // o.label has no number
                b.toolTip = o.label
                b.setAccessibilityIdentifier("detail.choice.\(o.n)")
                b.controlSize = .small
                b.alignment = .left
                (b.cell as? NSButtonCell)?.lineBreakMode = .byTruncatingTail   // full text in the tooltip
                b.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
                choiceButtons.addArrangedSubview(b)
                b.widthAnchor.constraint(lessThanOrEqualTo: choiceButtons.widthAnchor).isActive = true
            }
        }

        if s.isOffline, let d = s.device {
            noticeLabel.stringValue = "\(d) does not answer now (asleep, off, or no network). This is the last state it sent. Thoth connects again by itself."
            notice.isHidden = false
            return
        }
        switch s.sessionState {
        case .preparing:
            noticeLabel.stringValue = "Thoth is copying this project to \(s.device ?? "the other computer") (a new worktree, a clone, or a copy of this folder). The session starts there by itself and shows here. Close it to cancel."
            notice.isHidden = false
        case .failed:
            noticeLabel.stringValue = "The session did not start on \(s.device ?? "the other computer"): \(s.last)\nClose it to remove this row."
            notice.isHidden = false
        case .elsewhere:
            noticeLabel.stringValue = "This conversation is open in another window (VS Code or a terminal). Click Resume to move it here: the other copy is closed and the conversation continues in the panel. A message sent here does the same."
            notice.isHidden = false
        case .stopped:
            noticeLabel.stringValue = s.sid.isEmpty ? "\(s.isCodex ? "Codex" : "Claude") is not running here. Click Start." : "\(s.isCodex ? "Codex" : "Claude") is not running here. Click Resume to continue this conversation."
            notice.isHidden = false
        default:
            notice.isHidden = true
        }
        // a helper session's recent "Fetch result" (progress, branch, or error) above the state notice;
        // the server drops a finished one from the row after 10 minutes
        if s.isRemote, let f = s.fetch {
            let line = f.text(s.device ?? "the helper")
            noticeLabel.stringValue = notice.isHidden ? line : line + "\n" + noticeLabel.stringValue
            notice.isHidden = false
        }
    }

    private func resume() {
        guard let s = current else { return }
        if s.sessionState == .elsewhere {
            let a = NSAlert()
            a.messageText = "Move this conversation here?"
            a.informativeText = "It is open in another window. That copy will be closed (its history is kept) and the conversation continues in the panel."
            a.addButton(withTitle: "Move Here")
            a.addButton(withTitle: "Cancel")
            if a.runModal() != .alertFirstButtonReturn { return }
        }
        Backend.shared.post("start", ["id": s.id])
    }

    // MARK: inline rename

    @objc private func startRename() {
        nameField.isEditable = true
        nameField.isBordered = true
        nameField.drawsBackground = true
        view.window?.makeFirstResponder(nameField)
        nameField.currentEditor()?.selectAll(nil)
    }

    func controlTextDidEndEditing(_ obj: Notification) {
        guard nameField.isEditable else { return }
        nameField.isEditable = false
        nameField.isBordered = false
        nameField.drawsBackground = false
        let movement = (obj.userInfo?["NSTextMovement"] as? Int) ?? 0
        let n = nameField.stringValue.trimmingCharacters(in: .whitespaces)
        if let s = current {
            if movement == NSTextMovement.cancel.rawValue || n.isEmpty { nameField.stringValue = s.name; return }
            if n != s.name {
                Backend.shared.post("rename", ["id": s.id, "name": n]) { _ in Toast.show("Renamed to “\(n)”") }
            }
        }
        view.window?.makeFirstResponder(TerminalHost.shared.view)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.cancelOperation(_:)) {
            nameField.stringValue = current?.name ?? ""
            view.window?.makeFirstResponder(nil)
            return true
        }
        return false
    }
}


/// Messages from the chat page (public/chat.ts toNative): clipboard and
/// downloads are done by the app, because WKWebView limits the page APIs.
final class ChatBridge: NSObject, WKScriptMessageHandler {
    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "copy":
            guard let text = body["text"] as? String else { return }
            Instance.pasteboard.clearContents()
            Instance.pasteboard.setString(text, forType: .string)
        case "openFile":
            // only files the user attached (copies in the attachments folder)
            guard let p = body["path"] as? String else { return }
            let u = URL(fileURLWithPath: p).standardizedFileURL
            if u.path.hasPrefix(Attachments.dir.standardizedFileURL.path + "/"), FileManager.default.fileExists(atPath: u.path) {
                NSWorkspace.shared.open(u)
            } else { Toast.show("Only attached files can be opened here") }
        case "openSent":
            // a file Claude sent with SendUserFile: the server checks that this session sent it and the
            // file rules (/api/file check=1) and gives back the real path and whether it may be opened.
            // A type that can run code (HTML, SVG, scripts, Office) is shown in Finder, not opened.
            guard let win = body["win"] as? String, let p = body["path"] as? String else { return }
            // a helper computer's session (lib/peer.ts): the file is on that computer; a path it names is
            // never opened on this Mac
            if let s = Backend.shared.session(win), let d = s.device { Toast.show("This file is on \(d)"); return }
            struct Checked: Decodable { let path: String; let open: Bool }
            Backend.shared.get("api/file", query: ["win": win, "path": p, "check": "1"], as: Checked.self) { r in
                guard let r else { Toast.show("Could not open the file"); return }
                let u = URL(fileURLWithPath: r.path)
                let v = try? u.resourceValues(forKeys: [.isRegularFileKey, .isPackageKey])
                guard v?.isRegularFile == true, v?.isPackage != true else { Toast.show("Could not open the file"); return }
                if r.open { NSWorkspace.shared.open(u) } else { NSWorkspace.shared.activateFileViewerSelecting([u]) }
            }
        case "saveImage":
            guard let src = body["src"] as? String else { return }
            ChatBridge.saveImage(src: src, name: body["name"] as? String)
        default:
            break
        }
    }

    /// Save an image from the chat (a data: URL or a file served by our own
    /// server) into ~/Downloads with a unique name.
    static func saveImage(src: String, name: String?) {
        let local = Backend.shared.base.absoluteString
        let finish: (Data?, String) -> Void = { data, ext in
            DispatchQueue.main.async {
                guard let data, !data.isEmpty else { Toast.show("Could not save the image"); return }
                let downloads = Instance.downloads
                var base = (name.map { ($0 as NSString).deletingPathExtension } ?? "").trimmingCharacters(in: .whitespaces)
                if base.isEmpty || base == "image" { base = "claude-panel-image-\(Int(Date().timeIntervalSince1970))" }
                var url = downloads.appendingPathComponent(base).appendingPathExtension(ext)
                var i = 2
                while FileManager.default.fileExists(atPath: url.path) {
                    url = downloads.appendingPathComponent("\(base) \(i)").appendingPathExtension(ext); i += 1
                }
                do { try data.write(to: url); Toast.show("Saved to Downloads: \(url.lastPathComponent)") } catch { Toast.show("Could not save the image") }
            }
        }
        if src.hasPrefix("data:"), let comma = src.firstIndex(of: ",") {
            let header = String(src[..<comma])                    // data:image/png;base64
            let ext = header.split(separator: "/").last?.split(separator: ";").first.map(String.init)?.replacingOccurrences(of: "jpeg", with: "jpg") ?? "png"
            finish(Data(base64Encoded: String(src[src.index(after: comma)...])), ext)
        } else if src.hasPrefix(local), let u = URL(string: src) {
            URLSession.shared.dataTask(with: u) { data, resp, _ in
                let type = (resp as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? "image/png"
                finish((resp as? HTTPURLResponse)?.statusCode == 200 ? data : nil,
                       type.split(separator: "/").last.map(String.init)?.replacingOccurrences(of: "jpeg", with: "jpg") ?? "png")
            }.resume()
        } else {
            Toast.show("Only images from this conversation can be saved")
        }
    }
}
