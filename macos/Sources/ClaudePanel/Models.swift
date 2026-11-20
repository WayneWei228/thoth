import Foundation

/// What an idle session waits for from the owner (server.ts Waits).
struct Waits: Codable, Hashable {
    let kind: String   // "question" | "draft"
    let text: String
}

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
    var state: String       // needs | working | idle | stopped | elsewhere | preparing | failed
    let last: String        // Claude's last reply
    var options: [Choice]
    var question: String
    let branch: String
    let prompt: String?     // user's last request
    let title: String?      // AI title of the conversation
    let activity: Double    // ms since epoch
    let agent: String?      // "claude" | "codex"; missing = "claude"
    /// A session on one of the owner's helper computers (lib/peer.ts): the device's name. nil = this Mac.
    let device: String?
    /// The helper computer does not answer now: the last known state, shown grey.
    let offline: Bool?
    /// A session started from this Mac on a helper: the id of the preparing row it was (r:<device>:p-<request id>).
    let preparedAs: String?
    /// The newest "Fetch result" of a helper session (lib/fetch_result.ts).
    let fetch: FetchInfo?
    /// An idle session that waits for the owner (server.ts Session.waits): its last reply asks a
    /// question ("question"), or its input box holds text that was never sent ("draft").
    let waits: Waits?

    /// The app shows a session that waits for the owner like "needs": first, in Needs You, notified,
    /// with the text and no option buttons. The server keeps it "idle" (it may receive messages).
    var shown: Session {
        guard state == "idle", let w = waits else { return self }
        var s = self
        s.state = "needs"
        s.question = w.kind == "draft" ? "Not sent: \(w.text)" : w.text
        s.options = []
        return s
    }

    var agentId: String { agent ?? "claude" }
    var isCodex: Bool { agentId == "codex" }
    var isRemote: Bool { device != nil }
    var isOffline: Bool { offline == true }
    /// A new session on a helper that has not started yet (preparing) or did not start (failed): it can
    /// only be closed, which cancels it there.
    var isPending: Bool { sessionState == .preparing || sessionState == .failed }
    /// A helper session whose work can be fetched to this Mac (it answers and has started).
    var canFetch: Bool { isRemote && !isPending && !isOffline }
    var isFetching: Bool { fetch?.state == "fetching" }
    var sessionState: SessionState { SessionState(rawValue: state) ?? .idle }
    var folderName: String { (folder as NSString).lastPathComponent }
}

enum SessionState: String {
    case needs, working, idle, stopped, elsewhere
    /// A new session on a helper computer: the code is being copied there (lib/remote_new.ts).
    case preparing
    /// A new session on a helper computer did not start; `last` has the error.
    case failed

    var label: String {
        switch self {
        case .needs: return "Needs you"
        case .working: return "Working"
        case .idle: return "Ready"
        case .stopped: return "Not running"
        case .elsewhere: return "Open elsewhere"
        case .preparing: return "Preparing"
        case .failed: return "Did not start"
        }
    }

    /// Sort order: what needs a person comes first.
    var rank: Int {
        switch self {
        case .needs, .failed: return 0
        case .working, .preparing: return 1
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
    /// The helper computers and whether each needs an update (lib/self_update.ts peerStatus).
    let peers: [PeerInfo]?
    /// Computers waiting for the owner's Approve on the cloud brain (lib/join_requests.ts).
    let joins: [JoinRequest]?

    /// One session or request the app cannot read is skipped; it must not drop the whole message.
    /// (2026-11-10: sessions without a name made every state message fail, so the app kept old
    /// data and never saw that two requests had failed.)
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decodeIfPresent(String.self, forKey: .type)
        sessions = (try c.decode([Lossy<Session>].self, forKey: .sessions)).compactMap(\.value?.shown)
        routes = (try c.decodeIfPresent([Lossy<Route>].self, forKey: .routes))?.compactMap(\.value)
        defaultFolder = try c.decodeIfPresent(String.self, forKey: .defaultFolder)
        restoring = try c.decodeIfPresent(Bool.self, forKey: .restoring)
        peers = (try? c.decodeIfPresent([Lossy<PeerInfo>].self, forKey: .peers))??.compactMap(\.value)
        joins = (try? c.decodeIfPresent([Lossy<JoinRequest>].self, forKey: .joins))??.compactMap(\.value)
    }
}

/// A computer that ran `thoth setup --role helper` and waits for Approve (server.ts setJoins).
struct JoinRequest: Codable, Hashable {
    let id: String
    let name: String
    let os: String
    let host: String?
    /// "<name> wants to join" (lib/join_requests.ts title)
    let title: String
    /// macOS, Windows, Linux (lib/join_requests.ts osLabel)
    let system: String
    /// system, host, when it asked, and the warning (lib/join_requests.ts noticeBody)
    let notice: String?
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

/// "Fetch result": the work of a helper session as a branch helper/<device>/<name> in the matching
/// repository on this Mac (lib/fetch_result.ts). state: fetching | fetched | failed.
struct FetchInfo: Codable, Hashable {
    let id: String
    let state: String
    let step: String
    let error: String
    let branch: String
    let commit: String
    let repo: String
    let dirty: Int

    /// The line the detail page shows.
    func text(_ device: String) -> String {
        switch state {
        case "fetching": return "Fetching the result from \(device): \(step)…"
        case "fetched":
            let left = dirty > 0 ? " \(dirty) uncommitted file(s) on \(device) were not fetched." : ""
            return "\(step): \(branch) at \(commit) in \(repo). Your checkout did not change.\(left)"
        default: return "Fetch result failed: \(error)"
        }
    }
}

/// A helper computer this panel knows (GET /api/peers, and `peers` in the state message): a new
/// session can start there. `update`: "needed" (it runs an older Thoth), "updating", "failed" or ""
/// (lib/self_update.ts peerStatus); `error`: why the last update failed.
struct PeerInfo: Codable, Hashable {
    let device: String
    let online: Bool
    var update: String? = nil
    var error: String? = nil

    /// The sidebar's words after the device name.
    var note: String? {
        if update == "updating" { return "updating…" }   // offline for a moment while it restarts
        var parts: [String] = online ? [] : ["offline"]
        if update == "needed" { parts.append("update needed") } else if update == "failed" { parts.append("update failed") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
    /// "Update <device>" is offered: it is older, or its last update failed (not while one runs).
    var canUpdate: Bool { update == "needed" || update == "failed" }
}
struct PeerList: Codable {
    let peers: [PeerInfo]
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
