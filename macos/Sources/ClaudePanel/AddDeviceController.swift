import AppKit

/// Sheet of the All Devices page: connect another computer to the brain.
/// 1. Name the computer and choose its system. 2. Run one command on it. The sheet shows when it
/// has joined and how many sessions the brain got. Cancel before it joins and nothing is added.
final class AddDeviceController: NSViewController {
    private let taken: [String]
    /// Set = the sheet reconnects this listed computer (a new command; its sessions stay) instead of adding one.
    private let reconnect: String?
    private var since: Double = 0    // reconnect: the computer is back when it sent data after this time (ms)
    private let onChange: () -> Void
    private let nameField = NSTextField(string: "")
    private let osPopup = NSPopUpButton()
    private let message = WrappingLabel(wrappingLabelWithString: "")
    private let step2 = label("2. Run this command on that computer", size: 13, weight: .semibold)
    private let where_ = label("", size: 12, color: .secondaryLabelColor)
    private let command = NSTextField(wrappingLabelWithString: "")
    private let commandBox = NSBox()
    private let note = WrappingLabel(wrappingLabelWithString: "")
    private let firewall = WrappingLabel(wrappingLabelWithString: "")
    private var allow: ActionButton!
    private let spinner = NSProgressIndicator()
    private let state = WrappingLabel(wrappingLabelWithString: "")
    private var create: ActionButton!
    private var copy: ActionButton!
    private var close: ActionButton!
    private var device = ""          // the computer being added; empty before step 2
    private var localMode = false    // the brain is on this computer (a listed computer must be taken back on Cancel)
    private var joined = false
    private var timer: Timer?
    private static let systems = [("macOS", "macos"), ("Linux", "linux"), ("Windows", "windows")]

    init(taken: [String], reconnect: String? = nil, onChange: @escaping () -> Void) {
        self.taken = taken
        self.reconnect = reconnect
        self.onChange = onChange
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func loadView() {
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 600, height: 470))
        let title = label(reconnect.map { "Reconnect \($0)" } ?? "Add a Computer", size: 17, weight: .semibold)
        let sub = WrappingLabel(wrappingLabelWithString: reconnect.map { "Use this when \($0) is on and awake but sends nothing: it could not find this Mac again, or it was set up again. Run one command on it. Its sessions in the brain stay." }
            ?? "Its Claude Code and Codex sessions and memory files go to your brain. You run one command on that computer; nothing else is installed by hand.")
        sub.font = .systemFont(ofSize: 12)
        sub.textColor = .secondaryLabelColor
        let step1 = label(reconnect == nil ? "1. Name the computer" : "1. The computer", size: 13, weight: .semibold)
        nameField.placeholderString = "for example: office-pc"
        nameField.translatesAutoresizingMaskIntoConstraints = false
        nameField.setAccessibilityIdentifier("addDevice.name")
        nameField.target = self
        nameField.action = #selector(createPressed)
        osPopup.translatesAutoresizingMaskIntoConstraints = false
        Self.systems.forEach { osPopup.addItem(withTitle: $0.0) }
        osPopup.setAccessibilityIdentifier("addDevice.os")
        create = ActionButton("Create Command", symbol: "terminal", prominent: true) { [weak self] in self?.createPressed() }
        create.setAccessibilityIdentifier("addDevice.create")
        message.font = .systemFont(ofSize: 12)
        message.textColor = .systemRed
        message.setAccessibilityIdentifier("addDevice.message")

        command.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        command.isSelectable = true
        command.translatesAutoresizingMaskIntoConstraints = false
        command.setAccessibilityIdentifier("addDevice.command")
        commandBox.boxType = .custom
        commandBox.cornerRadius = 6
        commandBox.borderColor = .separatorColor
        commandBox.fillColor = .textBackgroundColor
        commandBox.titlePosition = .noTitle
        commandBox.translatesAutoresizingMaskIntoConstraints = false
        commandBox.contentView?.addSubview(command)
        copy = ActionButton("Copy Command", symbol: "doc.on.doc") { [weak self] in self?.copyCommand() }
        copy.setAccessibilityIdentifier("addDevice.copy")
        note.font = .systemFont(ofSize: 12)
        note.textColor = .secondaryLabelColor
        note.setAccessibilityIdentifier("addDevice.note")
        firewall.font = .systemFont(ofSize: 12)
        firewall.textColor = .systemOrange
        firewall.translatesAutoresizingMaskIntoConstraints = false
        firewall.setAccessibilityIdentifier("addDevice.firewall")
        allow = ActionButton("Allow Other Computers…", symbol: "lock.open") { [weak self] in
            Backend.shared.send("setupFix", ["id": "firewall-allow"], fail: { [weak self] t in self?.firewall.stringValue = t }, done: { [weak self] _ in
                self?.firewall.stringValue = "macOS asks for your Mac password once. After that, run the command on the other computer."
            })
        }
        allow.controlSize = .small
        allow.setAccessibilityIdentifier("addDevice.allow")
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.translatesAutoresizingMaskIntoConstraints = false
        state.font = .systemFont(ofSize: 13, weight: .medium)
        state.setAccessibilityIdentifier("addDevice.state")
        close = ActionButton("Cancel") { [weak self] in self?.closePressed() }
        close.keyEquivalent = "\u{1b}"
        close.setAccessibilityIdentifier("addDevice.close")

        [message, note, state, sub].forEach { $0.translatesAutoresizingMaskIntoConstraints = false }
        [title, sub, step1, nameField, osPopup, create, message, step2, where_, commandBox, copy, note, firewall, allow, spinner, state, close].forEach { root.addSubview($0) }
        let m: CGFloat = 22
        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: root.topAnchor, constant: 20),
            title.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: m),
            sub.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 6),
            sub.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            sub.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -m),
            step1.topAnchor.constraint(equalTo: sub.bottomAnchor, constant: 18),
            step1.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            nameField.topAnchor.constraint(equalTo: step1.bottomAnchor, constant: 8),
            nameField.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            nameField.trailingAnchor.constraint(equalTo: osPopup.leadingAnchor, constant: -8),
            osPopup.centerYAnchor.constraint(equalTo: nameField.centerYAnchor),
            osPopup.widthAnchor.constraint(equalToConstant: 110),
            osPopup.trailingAnchor.constraint(equalTo: create.leadingAnchor, constant: -8),
            create.centerYAnchor.constraint(equalTo: nameField.centerYAnchor),
            create.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -m),
            message.topAnchor.constraint(equalTo: nameField.bottomAnchor, constant: 6),
            message.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            message.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -m),
            step2.topAnchor.constraint(equalTo: message.bottomAnchor, constant: 14),
            step2.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            where_.topAnchor.constraint(equalTo: step2.bottomAnchor, constant: 4),
            where_.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            where_.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor, constant: -m),
            commandBox.topAnchor.constraint(equalTo: where_.bottomAnchor, constant: 8),
            commandBox.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            commandBox.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -m),
            command.topAnchor.constraint(equalTo: commandBox.topAnchor, constant: 10),
            command.leadingAnchor.constraint(equalTo: commandBox.leadingAnchor, constant: 10),
            command.trailingAnchor.constraint(equalTo: commandBox.trailingAnchor, constant: -10),
            command.bottomAnchor.constraint(equalTo: commandBox.bottomAnchor, constant: -10),
            copy.topAnchor.constraint(equalTo: commandBox.bottomAnchor, constant: 8),
            copy.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            note.centerYAnchor.constraint(equalTo: copy.centerYAnchor),
            note.leadingAnchor.constraint(equalTo: copy.trailingAnchor, constant: 10),
            note.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -m),
            firewall.topAnchor.constraint(equalTo: copy.bottomAnchor, constant: 12),
            firewall.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            firewall.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -m),
            allow.topAnchor.constraint(equalTo: firewall.bottomAnchor, constant: 6),
            allow.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            spinner.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            spinner.centerYAnchor.constraint(equalTo: close.centerYAnchor),
            state.leadingAnchor.constraint(equalTo: spinner.trailingAnchor, constant: 8),
            state.centerYAnchor.constraint(equalTo: close.centerYAnchor),
            state.trailingAnchor.constraint(equalTo: close.leadingAnchor, constant: -12),
            close.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -m),
            close.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -18),
            close.topAnchor.constraint(greaterThanOrEqualTo: allow.bottomAnchor, constant: 14),
        ])
        view = root
        showStep2(false)
        if let reconnect {
            nameField.stringValue = reconnect
            nameField.isEnabled = false
            osPopup.isHidden = true
            create.title = "New Code"
            createPressed()
        }
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        view.window?.makeFirstResponder(nameField)
    }

    override func viewWillDisappear() {
        super.viewWillDisappear()
        timer?.invalidate()
    }

    private func showStep2(_ on: Bool) {
        [step2, where_, commandBox, copy, note].forEach { $0.isHidden = !on }
        if !on { firewall.isHidden = true; allow.isHidden = true }
    }

    /// "Office PC" -> "office-pc": the brain's names are small letters, digits and "-".
    static func tidy(_ s: String) -> String {
        let lowered = s.trimmingCharacters(in: .whitespaces).lowercased()
        let mapped = String(lowered.map { ($0.isASCII && ($0.isLetter || $0.isNumber)) ? $0 : "-" })
        let squeezed = mapped.split(separator: "-", omittingEmptySubsequences: true).joined(separator: "-")
        return String(squeezed.prefix(31))
    }

    @objc private func createPressed() {
        let name = Self.tidy(nameField.stringValue)
        guard !name.isEmpty else { message.stringValue = "Type a name for the computer: letters, digits and \"-\"."; return }
        nameField.stringValue = name
        if device.isEmpty, taken.contains(name) {
            message.stringValue = "Your brain already has a computer called \"\(name)\". Choose another name, or remove that one first."
            return
        }
        message.stringValue = ""
        let os = Self.systems[max(0, osPopup.indexOfSelectedItem)].1
        create.isEnabled = false
        let body: [String: Any] = reconnect == nil ? ["name": name, "os": os] : ["name": name]
        Backend.shared.send(reconnect == nil ? "deviceAdd" : "deviceReconnect", body, fail: { [weak self] text in
            self?.message.stringValue = text
            self?.create.isEnabled = true
        }, done: { [weak self] r in
            self?.created(r, os: r["os"] as? String ?? os)
        })
    }

    private func created(_ r: [String: Any], os: String) {
        device = r["device"] as? String ?? ""
        localMode = (r["mode"] as? String) == "local"
        joined = false
        since = r["since"] as? Double ?? 0
        command.stringValue = r["command"] as? String ?? ""
        where_.stringValue = os == "windows" ? "On \(device): open PowerShell, paste the command, press Enter."
                                             : "On \(device): open Terminal, paste the command, press Enter."
        note.stringValue = "The code in it works once, for 15 minutes."
        showStep2(true)
        let cause = (r["firewall"] as? [String: Any])?["cause"] as? String
        firewall.stringValue = cause.map { "Before you run it: \($0) Allow it here, or the command gets no answer." } ?? ""
        firewall.isHidden = cause == nil
        allow.isHidden = cause == nil
        nameField.isEnabled = false
        osPopup.isEnabled = false
        create.title = "New Code"
        create.isEnabled = true
        spinner.startAnimation(nil)
        state.stringValue = reconnect == nil ? "Waiting for \(device) to join…" : "Waiting for \(device) to run the command…"
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.poll() }
    }

    private func poll() {
        guard !device.isEmpty else { return }
        let name = device
        Backend.shared.send("deviceStatus", ["name": name], fail: { _ in }, done: { [weak self] r in
            guard let self, self.device == name else { return }
            guard r["joined"] as? Bool == true else { return }
            if self.reconnect != nil {   // it was joined all the time: wait for the new join, then for data after it
                if r["waiting"] as? Bool == true { return }
                guard (r["lastSeen"] as? Double ?? 0) > self.since else {
                    self.state.stringValue = "\(name) ran the command. It is sending its sessions…"
                    return
                }
            }
            if !self.joined {
                self.joined = true
                self.close.title = "Done"
                self.create.isEnabled = false
                self.onChange()
            }
            let n = r["sessions"] as? Int ?? 0
            if r["pushed"] as? Bool == true {
                self.timer?.invalidate()
                self.spinner.stopAnimation(nil)
                self.state.stringValue = "\(name) is connected: the brain has \(n) session\(n == 1 ? "" : "s") from it."
                self.onChange()
            } else {
                self.state.stringValue = "\(name) joined. It is sending its sessions…"
            }
        })
    }

    private func copyCommand() {
        Instance.pasteboard.clearContents()
        Instance.pasteboard.setString(command.stringValue, forType: .string)
        copy.title = "Copied"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.copy.title = "Copy Command" }
    }

    private func closePressed() {
        timer?.invalidate()
        // cancelled before the computer joined: take it off the list, so its code stops working
        if reconnect == nil, localMode, !device.isEmpty, !joined {
            Backend.shared.send("deviceRemove", ["name": device], fail: { _ in }, done: { _ in })
        }
        dismiss(nil)
        onChange()
    }
}
