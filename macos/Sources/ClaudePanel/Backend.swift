import AppKit
import Foundation

/// Talks to the Node backend (server.ts): starts it when needed, streams state
/// over WebSocket, and sends actions over HTTP. All callbacks run on the main thread.
final class Backend {
    static let shared = Backend()

    let port = Instance.port
    var base: URL { URL(string: "http://127.0.0.1:\(port)")! }
    var origin: String { "http://127.0.0.1:\(port)" }

    private(set) var sessions: [Session] = []
    private(set) var routes: [Route] = []
    /// The helper computers (state message `peers`): each one's sidebar header and its update state.
    private(set) var peers: [PeerInfo] = []
    /// Where new work goes when no session or folder fits (server setting).
    private(set) var defaultFolder = ""
    private(set) var connected = false
    /// The server is building the saved windows again; a saved page waits for its session.
    private(set) var restoring = false
    /// Computers waiting for the owner's Approve (the sidebar's "Wants to Join").
    private(set) var joins: [JoinRequest] = []

    /// Called on the main thread after every state update.
    var onChange: [() -> Void] = []

    private var socket: URLSessionWebSocketTask?
    private var serverProcess: Process?
    private var lastKey = ""

    /// Folder that holds server.ts (the repository root).
    var repoDir: String {
        if let env = ProcessInfo.processInfo.environment["CC_PANEL_DIR"] { return env }
        if let plist = Bundle.main.object(forInfoDictionaryKey: "CCPanelRepo") as? String, !plist.isEmpty { return plist }
        return NSHomeDirectory() + "/code/cc-panel"
    }

    /// The folder this app was built from (macos/build-app.sh writes CCPanelRepo); repoDir when unset.
    var builtFrom: String {
        if let plist = Bundle.main.object(forInfoDictionaryKey: "CCPanelRepo") as? String, !plist.isEmpty { return plist }
        return repoDir
    }

    // MARK: server lifecycle

    /// Why the app does not start the server itself (scripts/app-server.ts): the launchd service owns
    /// it, or this Mac is a helper, or Thoth is installed in another folder. Shown in the window while
    /// there is no connection; nil = nothing to say.
    private(set) var serverNote: String?
    private var askingOwner = false
    private var lastAsk = Date.distantPast

    func start() {
        ping { [weak self] ok in
            guard let self else { return }
            if ok { self.connect() } else { self.askOwner() }
        }
    }

    /// The server does not answer: ask scripts/app-server.ts who starts it (lib/server_owner.ts). One
    /// owner per server: with the launchd service installed (or on a helper) the app never starts its
    /// own, so it cannot take the port from the service. The script returns at once; the answer comes
    /// in the termination handler (or after 5 s, when it hangs). At most one question every 10 s.
    private func askOwner() {
        // the script comes from the folder this app was built from (it always has it), not from
        // repoDir: an older folder (CC_PANEL_DIR) has no script, and must not get a server by default
        let script = builtFrom + "/scripts/app-server.ts"
        guard FileManager.default.fileExists(atPath: script) else {
            setNote("Thoth cannot check who starts its server: \(script) is missing. Install Thoth again.")
            scheduleReconnect()
            return
        }
        if askingOwner || Date().timeIntervalSince(lastAsk) < 10 { scheduleReconnect(); return }
        askingOwner = true
        lastAsk = Date()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["node", script, repoDir]
        p.currentDirectoryURL = URL(fileURLWithPath: builtFrom)
        p.environment = Instance.serverEnvironment(nodeEnvironment())
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak self] _ in
            let data = out.fileHandleForReading.readDataToEndOfFile()
            DispatchQueue.main.async { self?.ownerAnswered(data, script: script) }
        }
        do { try p.run() } catch {
            askingOwner = false
            setNote("Thoth could not run node to start its server: \(error.localizedDescription)")
            scheduleReconnect()
            return
        }
        // the script returns in well under a second; a hung node or launchctl must not stop every
        // later question: end it after 5 s (the termination handler then clears askingOwner)
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { if p.isRunning { p.terminate() } }
    }

    private func ownerAnswered(_ data: Data, script: String) {
        askingOwner = false
        let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        switch o?["action"] as? String {
        case "spawn":
            setNote(nil)
            launchServer()
        case "launchd", "none":
            setNote(o?["message"] as? String)
            scheduleReconnect()
        default:
            setNote("Thoth could not check who starts its server (\(script) gave no answer).")
            scheduleReconnect()
        }
    }

    private func setNote(_ note: String?) {
        guard note != serverNote else { return }
        serverNote = note
        notify()
    }

    private func nodeEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = [NSHomeDirectory() + "/.local/bin", "/opt/homebrew/bin", "/opt/homebrew/opt/node@22/bin",
                       "/usr/local/bin", "/usr/bin", "/bin", env["PATH"] ?? ""].joined(separator: ":")
        return env
    }

    private func ping(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: base.appendingPathComponent("api/state"))
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    private func launchServer() {
        let script = repoDir + "/server.ts"
        guard FileManager.default.fileExists(atPath: script) else {
            NSLog("Thoth: server.ts not found at \(script)")
            scheduleReconnect()
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["node", script]
        p.currentDirectoryURL = URL(fileURLWithPath: repoDir)
        p.environment = Instance.serverEnvironment(nodeEnvironment())
        let logDir = Instance.home
        try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
        let logPath = logDir + "/server.log"
        if !FileManager.default.fileExists(atPath: logPath) { FileManager.default.createFile(atPath: logPath, contents: nil) }
        if let log = FileHandle(forWritingAtPath: logPath) {
            log.seekToEndOfFile()
            p.standardOutput = log
            p.standardError = log
        }
        do { try p.run(); serverProcess = p } catch { NSLog("Thoth: cannot start server: \(error)") }
        // The server keeps running after the app quits; sessions live in tmux anyway.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.connect() }
    }

    // MARK: state stream

    private func connect() {
        var req = URLRequest(url: URL(string: "ws://127.0.0.1:\(port)/ws/state")!)
        req.setValue(origin, forHTTPHeaderField: "Origin")
        let task = URLSession.shared.webSocketTask(with: req)
        socket = task
        task.resume()
        receive(task)
    }

    private func receive(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                DispatchQueue.main.async {
                    self.connected = false
                    self.notify()
                    self.scheduleReconnect()
                }
            case .success(let msg):
                var data: Data?
                switch msg {
                case .string(let s): data = s.data(using: .utf8)
                case .data(let d): data = d
                @unknown default: break
                }
                if let data, let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], o["type"] as? String == "permAsk" {
                    // a session needs a macOS permission (server.ts onPermNeed): ask the user first
                    if let p = o["perm"] as? [String: Any], let id = p["id"] as? String, let name = p["name"] as? String,
                       let pane = p["pane"] as? String, pane.hasPrefix("x-apple.systempreferences:") {
                        let perm = PermissionGuide.Perm(id: id, name: name, pane: pane)
                        DispatchQueue.main.async { PermissionGuide.shared.ask(perm, appPath: o["app"] as? String, session: o["session"] as? String ?? "") }
                    }
                } else if let data, let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], o["type"] as? String == "joinNotice",
                          let jd = try? JSONSerialization.data(withJSONObject: o["join"] ?? [:]), let j = try? JSONDecoder().decode(JoinRequest.self, from: jd) {
                    // a computer asks to join: once per request id (server.ts announceJoins)
                    DispatchQueue.main.async { AppDelegate.shared.notifyJoin(j) }
                } else if let data, let state = try? JSONDecoder().decode(StateMessage.self, from: data) {
                    DispatchQueue.main.async { self.apply(state) }
                }
                self.receive(task)
            }
        }
    }

    /// GET /api/setup: true = setup done, false = first run, nil = the server does not answer.
    /// A server without this endpoint (404) counts as done.
    func fetchSetupDone(_ done: @escaping (Bool?) -> Void) {
        var req = URLRequest(url: base.appendingPathComponent("api/setup"))
        req.timeoutInterval = 4
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            var result: Bool?
            if code == 404 { result = true }
            else if code == 200, let o = data.flatMap({ try? JSONSerialization.jsonObject(with: $0) }) as? [String: Any] { result = (o["done"] as? Bool) ?? true }
            DispatchQueue.main.async { done(result) }
        }.resume()
    }

    /// Plain-text report for support: where the app looks, whether the server file exists, the log tail.
    func diagnostics() -> String {
        let fm = FileManager.default
        var l = ["Thoth diagnostics",
                 "time: \(Date())",
                 "macOS: \(ProcessInfo.processInfo.operatingSystemVersionString)",
                 "app version: \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?")",
                 "port: \(port)", "home: \(Instance.home)", "repo: \(repoDir)",
                 "server.ts present: \(fm.fileExists(atPath: repoDir + "/server.ts"))",
                 "server process started by app: \(serverProcess.map { "pid \($0.processIdentifier), running \($0.isRunning)" } ?? "no")",
                 "connected: \(connected)",
                 "server note: \(serverNote ?? "none")"]
        if let log = try? String(contentsOfFile: Instance.home + "/server.log", encoding: .utf8) {
            l += ["", "server.log (last 40 lines):"] + log.split(separator: "\n", omittingEmptySubsequences: false).suffix(40).map(String.init)
        } else {
            l.append("server.log: not found in \(Instance.home)")
        }
        return l.joined(separator: "\n")
    }

    private func scheduleReconnect() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.start() }
    }

    /// What the views show from a state message, as one string: a new message with the same key
    /// changes nothing on screen (only the activity clock moved). Built from short typed parts: one
    /// long interpolation made the Swift type checker slow (76 ms here; a timeout on a slower Mac).
    static func changeKey(_ state: StateMessage) -> String {
        let parts: [String] = [
            state.sessions.map(sessionKey).joined(separator: "\n"),
            (state.routes ?? []).map(routeKey).joined(separator: ","),
            String(state.restoring == true),
            (state.peers ?? []).map(peerKey).joined(separator: ","),
            (state.joins ?? []).map(joinKey).joined(separator: ","),
        ]
        return parts.joined(separator: "#")
    }

    private static func sessionKey(_ s: Session) -> String {
        let fetch: String = s.fetch.map { f in [f.id, f.state, f.step].joined(separator: "/") } ?? ""
        let fields: [String] = [
            s.id, s.name, s.state, s.last, s.question, String(s.options.count),
            s.title ?? "", s.prompt ?? "", s.branch, s.device ?? "", String(s.isOffline), fetch,
        ]
        return fields.joined(separator: "|")
    }

    private static func routeKey(_ r: Route) -> String {
        [r.id, r.status, r.target ?? ""].joined(separator: "|")
    }

    private static func peerKey(_ p: PeerInfo) -> String {
        [p.device, String(p.online), p.update ?? "", p.error ?? ""].joined(separator: "|")
    }

    private static func joinKey(_ j: JoinRequest) -> String {
        [j.id, j.name, j.os].joined(separator: "|")
    }

    private func apply(_ state: StateMessage) {
        if !connected || serverNote != nil { serverNote = nil; lastKey = "" }
        connected = true
        // ignore updates that only move the activity clock
        let key = Self.changeKey(state)
        let first = sessions.isEmpty && !state.sessions.isEmpty
        sessions = state.sessions
        restoring = state.restoring ?? false
        peers = state.peers ?? []
        joins = state.joins ?? []
        routes = state.routes ?? routes
        if let f = state.defaultFolder { defaultFolder = f }
        if key != lastKey || first {
            lastKey = key
            notify()
        }
    }

    private func notify() { onChange.forEach { $0() } }

    func session(_ id: String?) -> Session? { sessions.first { $0.id == id } }

    // MARK: HTTP

    @discardableResult
    func post(_ action: String, _ body: [String: Any] = [:], done: (([String: Any]) -> Void)? = nil) -> Void {
        send(action, body, fail: nil, done: done)
    }

    /// Like post, but the caller shows the error itself (a sheet, an alert) instead of a toast.
    func send(_ action: String, _ body: [String: Any] = [:], fail: ((String) -> Void)?, done: (([String: Any]) -> Void)?) {
        var req = URLRequest(url: base.appendingPathComponent("api/\(action)"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(origin, forHTTPHeaderField: "Origin")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 120
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            let json = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async {
                if code != 200 {
                    let message = json["error"] as? String ?? (code == 0 ? "The panel server does not answer" : "Request failed")
                    if let fail { fail(message) } else { Toast.show(message) }
                    return
                }
                done?(json)
            }
        }.resume()
    }

    func get<T: Decodable>(_ path: String, query: [String: String] = [:], as: T.Type, done: @escaping (T?) -> Void) {
        var comps = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty {
            comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
            // URLComponents leaves "+" as is; the server (URLSearchParams) reads it as a space ("C++ notes.pdf")
            comps.percentEncodedQuery = comps.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        }
        URLSession.shared.dataTask(with: comps.url!) { data, _, _ in
            let v = data.flatMap { try? JSONDecoder().decode(T.self, from: $0) }
            DispatchQueue.main.async { done(v) }
        }.resume()
    }
}
