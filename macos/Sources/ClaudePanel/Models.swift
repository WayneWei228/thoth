import Foundation

/// One option of a choice menu Claude shows (permission prompt, trust prompt, selection).
struct Choice: Codable, Hashable {
    let n: Int
    let label: String
}

/// One Claude Code session = one window of the tmux session "cc".
struct Session: Codable, Hashable {
    let id: String          // tmux window id, e.g. "@3"
    let index: Int
    let name: String
    let folder: String
    let sid: String         // Claude transcript id (for --resume), may be empty
    let running: Bool
    let state: String       // needs | working | idle | stopped | elsewhere
    let last: String        // Claude's last reply
    let options: [Choice]
    let question: String
    let branch: String
    let prompt: String?     // user's last request
    let title: String?      // AI title of the conversation
    let activity: Double    // ms since epoch
    let agent: String?      // "claude" | "codex"; missing = "claude"

    var agentId: String { agent ?? "claude" }
    var isCodex: Bool { agentId == "codex" }
    var sessionState: SessionState { SessionState(rawValue: state) ?? .idle }
    var folderName: String { (folder as NSString).lastPathComponent }
}

enum SessionState: String {
    case needs, working, idle, stopped, elsewhere

    var label: String {
        switch self {
        case .needs: return "Needs you"
        case .working: return "Working"
        case .idle: return "Ready"
        case .stopped: return "Not running"
        case .elsewhere: return "Open elsewhere"
        }
    }

    /// Sort order: what needs a person comes first.
    var rank: Int {
        switch self {
        case .needs: return 0
        case .working: return 1
        case .idle: return 2
        case .elsewhere: return 3
        case .stopped: return 4
        }
    }
}

struct RouteChoice: Codable, Hashable {
    let id: String
    let name: String
}

/// A request typed in the Ask box and where the router sent it.
struct Route: Codable, Hashable {
    let id: String
    let ts: Double
    let text: String
    let status: String      // routing | sending | queued | sent | ask | error | dry | split
    let reason: String?
    let error: String?
    let target: String?
    let targetName: String?
    let decided: String?    // auto | auto-new | manual
    let confidence: Double?
    let choices: [RouteChoice]?
    let folder: String?
    let newName: String?
    let parent: String?     // one task of a request the router split into several (server.ts route)
    let part: String?       // "1/3"
    let tasks: [String]?    // a split request: the route ids of its tasks

    var statusLabel: String {
        switch status {
        case "split": return "Split into tasks"
        case "routing": return "Finding the right session…"
        case "sending": return "Sending…"
        case "handing-off": return "Moving the work to this Mac…"
        case "briefing": return "Writing background for the new session…"
        case "queued": return "Waiting for the session"
        case "sent": return "Sent"
        case "ask": return "Which session?"
        case "error": return "Failed"
        default: return status
        }
    }
}

struct StateMessage: Codable {
    let type: String?
    let sessions: [Session]
    let routes: [Route]?
    let defaultFolder: String?
    /// The server is building the saved windows again (after a Mac restart or a tmux crash).
    let restoring: Bool?

    /// One session or request the app cannot read is skipped; it must not drop the whole message.
    /// (2026-11-10: sessions without a name made every state message fail, so the app kept old
    /// data and never saw that two requests had failed.)
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decodeIfPresent(String.self, forKey: .type)
        sessions = (try c.decode([Lossy<Session>].self, forKey: .sessions)).compactMap(\.value)
        routes = (try c.decodeIfPresent([Lossy<Route>].self, forKey: .routes))?.compactMap(\.value)
        defaultFolder = try c.decodeIfPresent(String.self, forKey: .defaultFolder)
        restoring = try c.decodeIfPresent(Bool.self, forKey: .restoring)
    }
}

/// Decodes a T, or nil when the element is not a valid T (the array goes on).
struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

struct HistoryItem: Codable, Hashable {
    let sid: String
    let mtime: Double
    let title: String
    let first: String
    let agent: String?      // "claude" | "codex"; missing = "claude"

    var agentId: String { agent ?? "claude" }
}

/// One coding agent the server can start (GET /api/agents).
struct AgentInfo: Codable, Hashable {
    let id: String
    let name: String
    let available: Bool
    let reason: String?
}

struct RecentFolder: Codable, Hashable {
    let folder: String
    let mtime: Double
}

func shortPath(_ p: String) -> String {
    let home = NSHomeDirectory()
    return p.hasPrefix(home) ? "~" + p.dropFirst(home.count) : p
}

func ago(_ ms: Double) -> String {
    guard ms > 0 else { return "" }
    let s = max(0, Date().timeIntervalSince1970 - ms / 1000)
    if s < 60 { return "now" }
    if s < 3600 { return "\(Int(s / 60))m" }
    if s < 86400 { return "\(Int(s / 3600))h" }
    return "\(Int(s / 86400))d"
}
