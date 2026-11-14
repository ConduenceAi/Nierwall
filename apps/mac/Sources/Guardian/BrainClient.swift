import AppKit
import Foundation

/// Talks to the local brain (127.0.0.1) over a WebSocket for chat and live alerts, and REST for actions.
/// Connection details come from ~/Library/Application Support/Guardian/brain.json, written by the brain.
@MainActor
final class BrainClient: ObservableObject {
    enum Connection: Equatable { case connecting, connected, offline }

    @Published var connection: Connection = .connecting
    @Published var status: BrainStatus?
    @Published var items: [ChatItem] = []
    @Published var positions: [PositionCard] = []
    @Published var thinking = false

    var onAlert: ((AlertCard, [Card]) -> Void)?
    var onReply: ((Reply) -> Void)?
    var onReviewRequested: ((String) -> Void)?
    /// A signing session moved on (a step confirmed or failed, or it's done).
    var onSignUpdate: ((SignUpdate) -> Void)?

    private var task: URLSessionWebSocketTask?
    private var runtime: RuntimeInfo?
    private let session = URLSession(configuration: .ephemeral)
    private var retry = 0

    static var runtimeURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Guardian/brain.json")
    }

    func connect() {
        task?.cancel(with: .goingAway, reason: nil)
        guard let data = try? Data(contentsOf: Self.runtimeURL),
              let info = try? JSONDecoder().decode(RuntimeInfo.self, from: data),
              let url = URL(string: "ws://127.0.0.1:\(info.port)/ws?token=\(info.token)") else {
            connection = .offline
            scheduleReconnect()
            return
        }
        runtime = info
        connection = .connecting
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        receive(t)
    }

    private func scheduleReconnect() {
        retry = min(retry + 1, 6)
        let delay = Double(retry) * 2
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.connect() }
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            Task { @MainActor in
                guard let self, t === self.task else { return }
                switch result {
                case .failure:
                    self.connection = .offline
                    self.scheduleReconnect()
                case .success(let msg):
                    self.retry = 0
                    self.connection = .connected
                    if case .string(let s) = msg { self.handle(s) }
                    self.receive(t)
                }
            }
        }
    }

    private func handle(_ s: String) {
        guard let data = s.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }
        let sub = { (key: String) -> Data? in obj[key].flatMap { try? JSONSerialization.data(withJSONObject: $0) } }
        switch type {
        case "hello":
            if let d = sub("status") { status = try? JSONDecoder().decode(BrainStatus.self, from: d) }
            Task { await loadPortfolio() }
        case "snapshot":
            Task { await loadPortfolio(); await loadStatus() }
        case "alert":
            if let d = sub("alert"), let cards = try? JSONDecoder().decode([Card].self, from: d),
               case .alert(let a)? = cards.first {
                items.append(ChatItem(role: .alert, text: a.title, cards: cards))
                onAlert?(a, cards)
                Task { await loadStatus() }
            }
        case "reply":
            thinking = false
            if let d = sub("reply"), let reply = try? JSONDecoder().decode(Reply.self, from: d) {
                items.append(ChatItem(role: .assistant, text: reply.text, cards: reply.cards, via: reply.via))
                onReply?(reply)
            }
        case "review":
            if let id = obj["alertId"] as? String { onReviewRequested?(id) }
        case "sign":
            if let d = sub("session"), let update = try? JSONDecoder().decode(SignUpdate.self, from: d) { onSignUpdate?(update) }
        case "error":
            thinking = false
            items.append(ChatItem(role: .assistant, text: "Something went wrong: \(obj["message"] as? String ?? "unknown error")"))
        default: break
        }
    }

    func ask(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        items.append(ChatItem(role: .user, text: trimmed))
        guard let task, connection == .connected else {
            items.append(ChatItem(role: .assistant, text: "Nierwall's brain isn't running. Start it with `pnpm brain` in the project folder."))
            return
        }
        thinking = true
        let payload: [String: Any] = ["type": "chat", "requestId": UUID().uuidString, "text": trimmed]
        if let d = try? JSONSerialization.data(withJSONObject: payload), let s = String(data: d, encoding: .utf8) {
            task.send(.string(s)) { _ in }
        }
    }

    // MARK: REST helpers

    private func request(_ method: String, _ path: String, body: [String: Any]? = nil) async -> [String: Any]? {
        guard let runtime, let url = URL(string: "http://127.0.0.1:\(runtime.port)\(path)") else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue(runtime.token, forHTTPHeaderField: "x-guardian-token")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        guard let (data, _) = try? await session.data(for: req) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    func loadPortfolio() async {
        guard let obj = await request("GET", "/api/portfolio"), let cards = obj["cards"],
              let d = try? JSONSerialization.data(withJSONObject: cards),
              let decoded = try? JSONDecoder().decode([Card].self, from: d) else { return }
        positions = decoded.compactMap { if case .position(let p) = $0 { return p } else { return nil } }
    }

    func loadStatus() async {
        guard let obj = await request("GET", "/api/status"), let d = try? JSONSerialization.data(withJSONObject: obj) else { return }
        status = try? JSONDecoder().decode(BrainStatus.self, from: d)
    }

    func confirmWatch(_ id: String) async -> Bool {
        await request("POST", "/api/watches/\(id)/confirm")?["status"] as? String == "active"
    }

    func snooze(_ incidentId: String, minutes: Int = 60) async {
        _ = await request("POST", "/api/incidents/\(incidentId)/snooze", body: ["minutes": minutes])
    }

    /// Opens the local review-and-sign page for a fix. Returns an error message if it can't.
    /// Opens a fix or plan to sign. With a wallet (the orb's "send it to Meteor"), the page goes straight to that
    /// wallet and asks it to sign each step as it becomes ready; you still approve every one there.
    func review(fixId: String, wallet: String? = nil) async -> String? {
        let body: [String: Any]? = wallet.map { ["wallet": $0, "auto": true] }
        guard let obj = await request("POST", "/api/fixes/\(fixId)/review", body: body) else { return "Nierwall's brain didn't answer." }
        if let urlString = obj["url"] as? String, let url = URL(string: urlString) {
            NSWorkspace.shared.open(url)
            return nil
        }
        return obj["error"] as? String ?? "Couldn't open the review."
    }

    /// Opens a one-time Telegram link (valid 10 minutes) that links your private chat. Returns an error message if it can't.
    func linkTelegram() async -> String? {
        guard let obj = await request("POST", "/api/telegram/pair") else { return "Nierwall's brain didn't answer." }
        if let link = obj["link"] as? String, let url = URL(string: link) {
            NSWorkspace.shared.open(url)
            return nil
        }
        return obj["error"] as? String ?? "Couldn't create a Telegram link."
    }
}
