import AppKit
import SwiftTerm

/// One native terminal attached to tmux through a grouped session ("ccview-native").
/// Switching sessions only selects another tmux window, so it is instant and the
/// terminal process keeps running.
final class TerminalHost: NSObject, LocalProcessTerminalViewDelegate {
    static let shared = TerminalHost()

    let view: LocalProcessTerminalView
    private let viewSession = "ccview-native-\(ProcessInfo.processInfo.processIdentifier)"
    private var started = false
    private(set) var current: String?

    static var tmuxPath: String {
        for p in ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"] where FileManager.default.isExecutableFile(atPath: p) { return p }
        return "tmux"
    }

    override init() {
        view = LocalProcessTerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 500))
        super.init()
        view.processDelegate = self
        view.font = NSFont(name: "SF Mono", size: 13) ?? .monospacedSystemFont(ofSize: 13, weight: .regular)
        view.nativeBackgroundColor = Theme.terminalBG
        view.nativeForegroundColor = NSColor(srgbRed: 0.91, green: 0.90, blue: 0.88, alpha: 1)
        view.caretColor = Theme.accent
        view.optionAsMetaKey = true
        view.translatesAutoresizingMaskIntoConstraints = false
        view.setAccessibilityIdentifier("detail.terminal")
    }

    /// Show tmux window `id` (e.g. "@3") in the terminal.
    func show(_ id: String) {
        current = id
        if !started { launch(first: id); return }
        Self.tmux(["select-window", "-t", "\(viewSession):\(id)"])
        view.window?.makeFirstResponder(view)
    }

    private func launch(first id: String) {
        started = true
        var env = ProcessInfo.processInfo.environment
        env["TERM"] = "xterm-256color"
        env["LANG"] = env["LANG"] ?? "en_US.UTF-8"
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
        let envList = env.map { "\($0.key)=\($0.value)" }
        Self.tmux(["kill-session", "-t", viewSession])
        view.startProcess(executable: Self.tmuxPath, args: Instance.tmuxArgs + [
            "new-session", "-t", "cc", "-s", viewSession, ";",
            "set-option", "-t", viewSession, "destroy-unattached", "on", ";",
            "set-option", "-t", viewSession, "status", "off", ";",
            "set-option", "-t", viewSession, "mouse", "on", ";",
            "select-window", "-t", "\(viewSession):\(id)",
        ], environment: envList, execName: nil)
    }

    func stop() {
        Self.tmux(["kill-session", "-t", viewSession])
    }

    @discardableResult
    static func tmux(_ args: [String]) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tmuxPath)
        p.arguments = Instance.tmuxArgs + args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        try? p.run()
        p.waitUntilExit()
        return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }

    // MARK: LocalProcessTerminalViewDelegate
    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
    func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func processTerminated(source: TerminalView, exitCode: Int32?) {
        // tmux client ended (for example the window was killed); restart on next show
        started = false
        if let id = current, Backend.shared.session(id) != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.show(id) }
        }
    }
}
