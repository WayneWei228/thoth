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
    /// Where new work goes when no session or folder fits (server setting).
    private(set) var defaultFolder = ""
    private(set) var connected = false
    /// The server is building the saved windows again; a saved page waits for its session.
    private(set) var restoring = false

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

    // MARK: server lifecycle

    func start() {
        ping { [weak self] ok in
            guard let self else { return }
            if ok { self.connect() } else { self.launchServer() }
        }
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
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = [NSHomeDirectory() + "/.local/bin", "/opt/homebrew/bin", "/opt/homebrew/opt/node@22/bin",
                       "/usr/local/bin", "/usr/bin", "/bin", env["PATH"] ?? ""].joined(separator: ":")
        p.environment = Instance.serverEnvironment(env)
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
                 "connected: \(connected)"]
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

    private func apply(_ state: StateMessage) {
        connected = true
        // ignore updates that only move the activity clock
        let key = state.sessions.map { "\($0.id)|\($0.name)|\($0.state)|\($0.last)|\($0.question)|\($0.options.count)|\($0.title ?? "")|\($0.prompt ?? "")|\($0.branch)|\($0.device ?? "")|\($0.isOffline)" }
            .joined(separator: "\n") + "#" + (state.routes ?? []).map { "\($0.id)|\($0.status)|\($0.target ?? "")" }.joined(separator: ",")
            + "#\(state.restoring == true)"
        let first = sessions.isEmpty && !state.sessions.isEmpty
        sessions = state.sessions
        restoring = state.restoring ?? false
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
