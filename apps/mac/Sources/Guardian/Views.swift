import SwiftUI

@MainActor
final class UIState: ObservableObject {
    @Published var listening = false
    @Published var notice: String?
    @Published var speakReplies = true
    var voiceTurn = false
}

enum Palette {
    static let near = Color(red: 0.0, green: 0.55, blue: 0.42)
    static let warn = Color.orange
    static let crit = Color.red
    static let ok = Color.green
}

/// Actions the panel can ask the app to perform.
struct PanelActions {
    var send: (String) -> Void
    var toggleMic: () -> Void
    var review: (String) -> Void
    var confirmWatch: (String) -> Void
    var snooze: (String) -> Void
    var linkTelegram: () -> Void
}

struct PanelView: View {
    @ObservedObject var brain: BrainClient
    @ObservedObject var ui: UIState
    let actions: PanelActions
    @State private var input = ""
    @State private var showConnections = false
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().opacity(0.5)
            if showConnections {
                ScrollView { ConnectionsView(brain: brain, linkTelegram: actions.linkTelegram).padding(14) }
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            if brain.items.isEmpty { overview }
                            ForEach(brain.items) { item in
                                ChatRow(item: item, actions: actions).id(item.id)
                            }
                            if brain.thinking { ThinkingRow().id("thinking") }
                        }
                        .padding(14)
                    }
                    .onChange(of: brain.items.count) { _, _ in
                        if let last = brain.items.last { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last.id, anchor: .bottom) } }
                    }
                }
            }
            if let notice = ui.notice {
                Text(notice).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 14).padding(.vertical, 6)
            }
            Divider().opacity(0.5)
            inputRow
        }
        .frame(width: 390, height: 540)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(.white.opacity(0.08)))
        .onAppear { inputFocused = true }
    }

    private var header: some View {
        HStack(spacing: 10) {
            SiriOrb(mode: ui.listening ? .listening : brain.thinking ? .thinking : .idle, size: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text("Nierwall").font(.system(size: 15, weight: .semibold))
                Text(stateLine).font(.caption).foregroundStyle(stateColor)
            }
            Spacer()
            attestationChip
            Button { showConnections.toggle() } label: {
                Image(systemName: showConnections ? "bubble.left.and.bubble.right" : "link").font(.system(size: 13, weight: .medium))
            }
            .buttonStyle(.plain)
            .help(showConnections ? "Back to the chat" : "Connections: wallets and features")
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private var stateLine: String {
        switch brain.connection {
        case .offline: return "Brain offline: run pnpm brain"
        case .connecting: return "Connecting…"
        case .connected:
            switch brain.status?.state {
            case "attention": return "\(brain.status?.openIncidents ?? 0) open issue(s)"
            case "degraded": return "Some data can't be refreshed"
            case "loading": return "Loading positions…"
            default: return "All good"
            }
        }
    }

    private var stateColor: Color {
        if brain.connection != .connected { return .secondary }
        switch brain.status?.state { case "attention": return Palette.warn; case "degraded": return Palette.warn; default: return .secondary }
    }

    private var attestationChip: some View {
        let verified = brain.status?.attestation.verified ?? false
        return Text(verified ? "NEAR AI · TEE verified" : "Templates only")
            .font(.system(size: 10, weight: .medium, design: .monospaced))
            .padding(.horizontal, 7).padding(.vertical, 3)
            .foregroundStyle(verified ? Palette.near : .secondary)
            .overlay(Capsule().strokeBorder(verified ? Palette.near : .secondary.opacity(0.5)))
            .help(brain.status?.attestation.detail ?? "")
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(brain.positions) { PositionCardView(card: $0) }
            if brain.connection != .connected {
                Text("Start the brain with `pnpm brain`, then ask me anything.").font(.callout).foregroundStyle(.secondary)
            } else if let c = brain.connections, c.wallets.isEmpty, !c.usingDemo {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Nothing is connected yet").font(.headline)
                    Text("Connect a wallet and Nierwall watches its balances and any Rhea loan. It reads only the address. Or press ⌘⌥ and say \u{201C}help me set up\u{201D}.")
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Button("Connect a wallet") { showConnections = true; Task { _ = await brain.connectWallet() } }.buttonStyle(.borderedProminent)
                        Button("Try demo accounts") { Task { await brain.setFeature(demo: true) } }
                    }.controlSize(.small)
                }
            } else if brain.positions.isEmpty {
                Text("No Rhea loan in your wallets. Ask about your balances, or set a price watch.").font(.callout).foregroundStyle(.secondary)
            }
            Text("Try: “How's my Rhea loan?” · “What if NEAR drops 20%?” · “Ping me if Rhea goes under 1.5”")
                .font(.caption).foregroundStyle(.tertiary)
            if brain.connection == .connected, brain.status?.telegramLinked == false {
                Button("Get alerts on Telegram") { actions.linkTelegram() }.buttonStyle(.link).font(.caption)
            }
        }
    }

    private var inputRow: some View {
        HStack(spacing: 8) {
            TextField("Ask Nierwall…", text: $input)
                .textFieldStyle(.plain)
                .focused($inputFocused)
                .onSubmit { submit() }
            Button(action: actions.toggleMic) {
                Image(systemName: ui.listening ? "stop.circle.fill" : "mic.circle.fill").font(.system(size: 22))
                    .foregroundStyle(ui.listening ? Palette.crit : Color.accentColor)
            }
            .buttonStyle(.plain)
            .help(ui.listening ? "End the conversation" : "Talk (or press ⌘⌥ anywhere)")
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .overlay(alignment: .bottomTrailing) {
            Text("⌘⌥ to talk · Esc to stop").font(.system(size: 9)).foregroundStyle(.tertiary).padding(.trailing, 14).padding(.bottom, 2)
        }
    }

    private func submit() {
        let text = input
        input = ""
        actions.send(text)
    }
}

struct ThinkingRow: View {
    var body: some View {
        HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Thinking…").font(.callout).foregroundStyle(.secondary) }
    }
}

struct ChatRow: View {
    let item: ChatItem
    let actions: PanelActions
    var body: some View {
        VStack(alignment: item.role == .user ? .trailing : .leading, spacing: 8) {
            switch item.role {
            case .user:
                Text(item.text).padding(.horizontal, 10).padding(.vertical, 7)
                    .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
                    .frame(maxWidth: .infinity, alignment: .trailing)
            case .assistant:
                Text(item.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                if item.via == "fallback" {
                    Text("From templates (no model)").font(.system(size: 9, design: .monospaced)).foregroundStyle(.tertiary)
                }
            case .alert:
                EmptyView()
            }
            ForEach(item.cards) { card in CardView(card: card, actions: actions) }
        }
        .frame(maxWidth: .infinity, alignment: item.role == .user ? .trailing : .leading)
    }
}

struct CardView: View {
    let card: Card
    let actions: PanelActions
    var body: some View {
        switch card {
        case .position(let p): PositionCardView(card: p)
        case .alert(let a): AlertCardView(card: a, snooze: actions.snooze)
        case .fix(let f): FixCardView(card: f, review: actions.review)
        case .watchConfirm(let w): WatchConfirmView(card: w, confirm: actions.confirmWatch)
        case .plan(let p): PlanCardView(card: p, review: actions.review)
        case .other: EmptyView()
        }
    }
}

private let money: (Double) -> String = { v in
    let f = NumberFormatter(); f.numberStyle = .currency; f.currencyCode = "USD"; f.maximumFractionDigits = 0
    return f.string(from: NSNumber(value: v)) ?? "$\(Int(v))"
}

struct PositionCardView: View {
    let card: PositionCard
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(card.title).font(.caption.weight(.semibold))
                Text(card.wallet).font(.caption).foregroundStyle(.secondary)
                Spacer()
                if card.simulated { Text("SIMULATED").font(.system(size: 9, weight: .bold, design: .monospaced)).foregroundStyle(Palette.warn) }
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(card.health.map { String(format: "%.2f", $0) } ?? "no debt").font(.system(size: 26, weight: .bold, design: .rounded)).monospacedDigit()
                Text("health factor").font(.caption).foregroundStyle(.secondary)
            }
            if let h = card.health { HealthGauge(health: h, floor: card.floor) }
            HStack {
                Text("Collateral \(money(card.collateralUsd)) · Debt \(money(card.debtUsd))")
                Spacer()
                if let d = card.liquidationDistance { Text("liq. after −\(String(format: "%.1f", d * 100))%") }
            }
            .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(11)
        .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.separator))
    }
}

/// Scale 1.00 → 2.00. Red near liquidation, amber below the floor, green above it.
struct HealthGauge: View {
    let health: Double
    let floor: Double?
    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let pos = { (v: Double) in CGFloat(min(max((v - 1) / 1, 0), 1)) * w }
            let f = floor ?? 1.5
            ZStack(alignment: .leading) {
                Capsule().fill(LinearGradient(stops: [
                    .init(color: Palette.crit, location: 0),
                    .init(color: Palette.warn, location: max(0.01, (f - 1) * 0.6)),
                    .init(color: Palette.warn, location: max(0.02, f - 1)),
                    .init(color: Palette.ok, location: min(0.99, f - 1 + 0.001)),
                ], startPoint: .leading, endPoint: .trailing)).frame(height: 6)
                Rectangle().fill(.primary).frame(width: 2, height: 12).offset(x: pos(f) - 1)
                Circle().fill(.background).frame(width: 12, height: 12).overlay(Circle().stroke(.primary, lineWidth: 2.5)).offset(x: pos(health) - 6)
            }
            .frame(height: 12)
        }
        .frame(height: 12)
    }
}

struct AlertCardView: View {
    let card: AlertCard
    let snooze: (String) -> Void
    var color: Color { card.severity == "critical" ? Palette.crit : card.severity == "warning" ? Palette.warn : Palette.ok }
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Image(systemName: card.severity == "info" ? "checkmark.shield" : "exclamationmark.shield.fill").foregroundStyle(color)
                Text(card.title).font(.callout.weight(.semibold)).foregroundStyle(color).fixedSize(horizontal: false, vertical: true)
            }
            Text(card.body).font(.callout).fixedSize(horizontal: false, vertical: true)
            if card.severity != "info" {
                Button("Snooze 1h") { snooze(card.incidentId) }.buttonStyle(.link).font(.caption)
            }
        }
        .padding(11)
        .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct FixCardView: View {
    let card: FixCard
    let review: (String) -> Void
    var body: some View {
        let f = card.fix
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                Text(String(UnicodeScalar(UInt8(64 + max(1, min(f.rank, 26)))))).font(.system(size: 12, weight: .bold, design: .monospaced))
                    .frame(width: 20, height: 20).background(Color.accentColor.opacity(0.15), in: Circle())
                VStack(alignment: .leading, spacing: 3) {
                    Text(f.title).font(.callout.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                    if let a = f.healthAfter {
                        Text("Health \(f.healthBefore.map { String(format: "%.2f", $0) } ?? "–") → \(String(format: "%.2f", a))").font(.caption).monospacedDigit()
                    }
                }
            }
            ForEach(Array(f.steps.enumerated()), id: \.offset) { i, s in
                Text("\(i + 1). [\(s.chain)] \(s.description) · sign in \(s.wallet)").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(f.notes, id: \.self) { n in Text("· \(n)").font(.caption2).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true) }
            Button("Review & sign") { review(f.id) }
                .buttonStyle(.borderedProminent).controlSize(.small)
                .disabled(f.notes.contains { $0.contains("hypothetical") })
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(11)
        .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.separator))
    }
}

/// A checked plan: what changes, the steps, the cost, and anything to watch out for.
struct PlanCardView: View {
    let card: PlanCard
    let review: (String) -> Void
    private func hf(_ v: Double?) -> String { v.map { String(format: "%.2f", $0) } ?? "no debt" }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "checklist").foregroundStyle(Palette.near)
                Text(card.title).font(.callout.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                Spacer()
                if card.simulated { Text("SIMULATED").font(.system(size: 9, weight: .bold, design: .monospaced)).foregroundStyle(Palette.warn) }
            }
            ForEach(card.loans, id: \.label) { l in
                Text("\(l.label): health \(hf(l.before)) → \(hf(l.after))").font(.caption.weight(.medium)).monospacedDigit()
            }
            if !card.allocation.isEmpty {
                Text(card.allocation.map { "\($0.cls) \(Int($0.beforePct.rounded()))% → \(Int($0.afterPct.rounded()))%" }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(card.steps, id: \.n) { s in
                Text("\(s.n). \(s.description)\(s.manual ? " · by hand" : "")").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Text("About \(String(format: "$%.2f", card.costUsd)) in fees and slippage, within the \(String(format: "$%.2f", card.maxCostUsd)) the advisor allowed\(card.costReason.isEmpty ? "" : ": \(card.costReason)"). Checked on your Mac with live quotes.")
                .font(.caption2).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true)
            ForEach(card.warnings, id: \.self) { w in
                Text("⚠︎ \(w)").font(.caption2).foregroundStyle(Palette.warn).fixedSize(horizontal: false, vertical: true)
            }
            Button("Review & sign") { review(card.planId) }.buttonStyle(.borderedProminent).controlSize(.small)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(11)
        .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.near.opacity(0.45)))
    }
}

struct WatchConfirmView: View {
    let card: WatchCard
    let confirm: (String) -> Void
    @State private var done = false
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("New watch").font(.caption).foregroundStyle(.secondary)
                Text(card.label).font(.callout.weight(.semibold))
            }
            Spacer()
            Button(done ? "Active" : "Confirm") { confirm(card.watchId); done = true }
                .buttonStyle(.borderedProminent).controlSize(.small).disabled(done)
        }
        .padding(11)
        .background(Color.purple.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    }
}

/// What's connected and what can be: your wallets (read-only, by address), and the features you turn on.
struct ConnectionsView: View {
    @ObservedObject var brain: BrainClient
    let linkTelegram: () -> Void

    var body: some View {
        let c = brain.connections
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Wallets").font(.headline)
                if let wallets = c?.wallets, !wallets.isEmpty {
                    ForEach(wallets) { w in walletRow(w) }
                } else {
                    Text(c?.usingDemo == true ? "Using the public demo accounts until you connect your own." : "None yet. Nierwall reads only addresses: it never asks for keys and can't move anything.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Button("Connect a wallet") { Task { _ = await brain.connectWallet() } }.buttonStyle(.borderedProminent).controlSize(.small)
            }
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                Text("Features").font(.headline)
                Toggle(isOn: Binding(get: { c?.transactionSafety ?? false }, set: { on in Task { await brain.setFeature(transactionSafety: on) } })) {
                    feature("Transaction safety", "Checks every MetaMask transaction before you sign. Off until you turn it on.")
                }
                if c?.transactionSafety == true {
                    Button("Install the Nierwall Snap in MetaMask Flask") { brain.openSnapInstall() }.buttonStyle(.link).font(.caption)
                }
                Toggle(isOn: Binding(get: { c?.demo ?? false }, set: { on in Task { await brain.setFeature(demo: on) } })) {
                    feature("Demo accounts", c?.wallets.isEmpty == false ? "Your wallets are used, so the demo accounts stay out." : "Public read-only accounts, to look around before connecting yours.")
                }
            }
            Divider()
            VStack(alignment: .leading, spacing: 6) {
                Text("Services").font(.headline)
                status("NEAR AI", brain.status?.attestation.verified == true ? "TEE verified" : "Templates only", ok: brain.status?.attestation.verified == true)
                HStack {
                    status("Telegram", brain.status?.telegramLinked == true ? "Linked" : "Not linked", ok: brain.status?.telegramLinked == true)
                    if brain.status?.telegramLinked != true { Button("Link", action: linkTelegram).buttonStyle(.link).font(.caption) }
                }
            }
        }
        .toggleStyle(.switch)
        .task { await brain.loadConnections() }
    }

    private func walletRow(_ w: Connections.Wallet) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: w.chain == "near" ? "n.circle.fill" : "e.circle.fill").foregroundStyle(w.chain == "near" ? Palette.near : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(w.label).font(.callout.weight(.semibold))
                Text([short(w.address), w.app.map { "via \($0)" }, w.chain == "evm" ? "every EVM network" : nil].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
                if let loan = w.rhea {
                    Text("Rhea loan · health \(loan.healthFactor.map { String(format: "%.2f", $0) } ?? "no debt")").font(.caption).foregroundStyle(Palette.near)
                }
            }
            Spacer()
            Button { Task { await brain.removeWallet(w.label) } } label: { Image(systemName: "xmark.circle") }
                .buttonStyle(.plain).foregroundStyle(.secondary).help("Stop watching \(w.label)")
        }
    }

    private func feature(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title).font(.callout)
            Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func status(_ name: String, _ value: String, ok: Bool) -> some View {
        HStack(spacing: 6) {
            Circle().fill(ok ? Palette.ok : Color.secondary.opacity(0.5)).frame(width: 6, height: 6)
            Text(name).font(.caption)
            Text(value).font(.caption).foregroundStyle(.secondary)
        }
    }

    private func short(_ address: String) -> String {
        address.count > 18 ? "\(address.prefix(8))…\(address.suffix(4))" : address
    }
}
