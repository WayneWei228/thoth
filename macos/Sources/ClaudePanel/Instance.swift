import AppKit

/// Instance settings (same meaning as lib/instance.ts). The installed app has
/// none of these keys and uses the defaults. A verify instance is a copy of the
/// app whose Info.plist sets them, so it runs with its own server port, tmux
/// server and state folder, and never touches the user's sessions.
/// Info.plist keys win over environment variables.
enum Instance {
    private static func value(_ plistKey: String, _ envKey: String) -> String? {
        if let v = Bundle.main.object(forInfoDictionaryKey: plistKey) as? String, !v.isEmpty { return v }
        if let v = ProcessInfo.processInfo.environment[envKey], !v.isEmpty { return v }
        return nil
    }

    static let port = Int(value("CCPanelPort", "CC_PANEL_PORT") ?? "") ?? 7878
    static let home = value("CCPanelHome", "CC_PANEL_HOME") ?? NSHomeDirectory() + "/.config/cc-panel"
    /// tmux socket name (`tmux -L`); nil = tmux's default server.
    static let tmuxSocket: String? = value("CCPanelTmuxSocket", "CC_PANEL_TMUX_SOCKET")
    static let urlScheme = value("CCPanelURLScheme", "CC_PANEL_URL_SCHEME") ?? "claudepanel"
    /// Where "Download image" saves. A verify instance saves inside its own folder.
    static let downloads: URL = value("CCPanelDownloads", "CC_PANEL_DOWNLOADS").map { URL(fileURLWithPath: $0) }
        ?? FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
    /// A test instance: no notifications.
    static let isTest = value("CCPanelInstance", "CC_PANEL_INSTANCE") != nil

    static var tmuxArgs: [String] { tmuxSocket.map { ["-L", $0] } ?? [] }

    /// A verify instance that runs in the background (Info.plist CCPanelBackground = 1):
    /// it never brings itself to the front and uses its own pasteboard, so a verify run
    /// does not take the user's keyboard focus or clipboard. The installed app never has this key.
    static let background = isTest && value("CCPanelBackground", "CC_PANEL_BACKGROUND") == "1"

    /// The pasteboard for copy and paste: the system one, or the background instance's own.
    static let pasteboard: NSPasteboard = background
        ? NSPasteboard(name: NSPasteboard.Name("cc-panel-verify-" + (value("CCPanelInstance", "CC_PANEL_INSTANCE") ?? "x")))
        : .general

    /// Bring the app to the front, except in a background verify instance.
    static func activate() {
        if !background { NSApp.activate(ignoringOtherApps: true) }
    }

    /// Environment for the server process this app starts.
    static func serverEnvironment(_ base: [String: String]) -> [String: String] {
        var env = base
        env["CC_PANEL_PORT"] = String(port)
        env["CC_PANEL_HOME"] = home
        env["CC_PANEL_URL_SCHEME"] = urlScheme
        if let s = tmuxSocket { env["CC_PANEL_TMUX_SOCKET"] = s } else { env.removeValue(forKey: "CC_PANEL_TMUX_SOCKET") }
        // a test instance (verify): the server then starts Claude without Remote Control (lib/claude_args.ts)
        if let tag = value("CCPanelInstance", "CC_PANEL_INSTANCE") { env["CC_PANEL_INSTANCE"] = tag } else { env.removeValue(forKey: "CC_PANEL_INSTANCE") }
        // a test instance can give its server more settings (its own brain port, device port, and its own
        // CODEX_HOME so Codex's trust choices never reach the user's ~/.codex): Info.plist CCPanelEnv
        if isTest, let extra = Bundle.main.object(forInfoDictionaryKey: "CCPanelEnv") as? [String: String] {
            for (k, v) in extra where k.hasPrefix("CC_") || k == "CODEX_HOME" { env[k] = v }
        }
        return env
    }
}
