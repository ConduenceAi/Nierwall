import SwiftUI

@MainActor
final class UIState: ObservableObject {
    @Published var listening = false
    @Published var notice: String?
    @Published var speakReplies = true
    /// The panel opens on your wallets. The chat is behind the button at the top right, and opens on its own for an
    /// alert or an answer with something to click.
    @Published var showChat = false
    var voiceTurn = false
}

/// Nierwall blue (#3B82F6), black and white. Red is kept for danger only: a critical alert, a loan near liquidation.
enum Palette {
    static let blue = Color(red: 59 / 255, green: 130 / 255, blue: 246 / 255)
    static let crit = Color(red: 239 / 255, green: 68 / 255, blue: 68 / 255)
    static let warn = blue
    static let ok = blue
    static let card = Color.white.opacity(0.06)
    static let rule = Color.white.opacity(0.12)
}

/// Actions the panel can ask the app to perform.
struct PanelActions {
    var send: (String) -> Void
    var toggleMic: () -> Void
    var review: (String) -> Void
    var confirmWatch: (String) -> Void
    var snooze: (String) -> Void
    var linkTelegram: () -> Void
    /// Opens the browser page that connects a wallet, so Nierwall can send it transactions to approve.
    var connectWallet: () -> Void
    /// The first of these wallets that's only read (added by address), so a fix or plan through it can't be sent.
    var readOnly: ([String]) -> String?
}

struct PanelView: View {
    @ObservedObject var brain: BrainClient
    @ObservedObject var ui: UIState
    let actions: PanelActions
    @State private var input = ""
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().opacity(0.5)
            if ui.showChat {
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
                    .onAppear { if let last = brain.items.last { proxy.scrollTo(last.id, anchor: .bottom) } }
                    .onChange(of: brain.items.count) { _, _ in
                        if let last = brain.items.last { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last.id, anchor: .bottom) } }
                    }
                }
            } else {
                ScrollView { ConnectionsView(brain: brain, linkTelegram: actions.linkTelegram).padding(14) }
            }
            if let notice = ui.notice {
                Text(notice).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 14).padding(.vertical, 6)
            }
            Divider().opacity(0.5)
            if ui.showChat {
                inputRow
            } else {
                Text("⌘⌥ to talk · Esc to stop").font(.system(size: 10)).foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity).padding(.vertical, 9)
            }
        }
        .frame(width: 390, height: 540)
        .background(.black, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Palette.rule))
        .environment(\.colorScheme, .dark)
        .tint(Palette.blue)
    }

    private var header: some View {
        HStack(spacing: 10) {
            SiriOrb(mode: ui.listening ? .listening : brain.thinking ? .thinking : .idle, size: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text("Nierwall").font(.system(size: 15, weight: .semibold))
                Text(stateLine).font(.caption).foregroundStyle(stateColor)
            }
            Spacer()
            Button { ui.showChat.toggle() } label: {
                Image(systemName: ui.showChat ? "wallet.bifold" : "bubble.left.and.bubble.right").font(.system(size: 13, weight: .medium))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Palette.blue)
            .help(ui.showChat ? "Your wallets" : "Chat with Nierwall")
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

    private var overview: some View {
        VStack(alignment: .leading, spacing: 10) {
            if brain.connection != .connected {
                Text("Start the brain with `pnpm brain`, then ask me anything.").font(.callout).foregroundStyle(.secondary)
            } else if let c = brain.connections, c.wallets.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("No wallets yet").font(.headline)
                    Text("Add a wallet's address and Nierwall watches its balances and any Rhea loan. Or press ⌘⌥ and say \u{201C}help me set up\u{201D}.")
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Button("Add a wallet") { ui.showChat = false }.buttonStyle(.borderedProminent).controlSize(.small)
                }
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
                .onAppear { inputFocused = true }
            Button(action: actions.toggleMic) {
                Image(systemName: ui.listening ? "stop.circle.fill" : "mic.circle.fill").font(.system(size: 22))
                    .foregroundStyle(ui.listening ? .white : Palette.blue)
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
                Text(item.text).foregroundStyle(.white).padding(.horizontal, 10).padding(.vertical, 7)
                    .background(Palette.blue, in: RoundedRectangle(cornerRadius: 12))
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
        case .fix(let f): FixCardView(card: f, review: actions.review, readOnly: actions.readOnly(f.fix.steps.map(\.wallet)), connect: actions.connectWallet)
        case .watchConfirm(let w): WatchConfirmView(card: w, confirm: actions.confirmWatch)
        case .plan(let p): PlanCardView(card: p, review: actions.review, readOnly: actions.readOnly(p.steps.filter { !$0.manual }.map(\.wallet)), connect: actions.connectWallet)
        case .other: EmptyView()
        }
    }
}

private let money: (Double) -> String = { v in
    let f = NumberFormatter(); f.numberStyle = .currency; f.currencyCode = "USD"; f.maximumFractionDigits = abs(v) >= 100 ? 0 : 2
    return f.string(from: NSNumber(value: v)) ?? "$\(Int(v))"
}

struct PositionCardView: View {
    let card: PositionCard
    /// Dollar amounts show as "**" (the health factor stays).
    var hideAmounts = false
    private func dollars(_ v: Double) -> String { hideAmounts ? "**" : money(v) }
    private func amount(_ v: Double) -> String {
        hideAmounts ? "**" : v.formatted(.number.precision(.significantDigits(1...(v >= 1 ? 6 : 4))).grouping(.automatic))
    }

    /// Supplied or borrowed tokens with their total, one line each.
    @ViewBuilder private func tokens(_ title: String, _ items: [PositionToken]) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(title).font(.caption.weight(.semibold))
                    Spacer()
                    Text(dollars(items.reduce(0) { $0 + $1.usd })).font(.caption.weight(.semibold)).monospacedDigit()
                }
                ForEach(Array(items.enumerated()), id: \.offset) { _, t in
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Text(t.symbol).font(.caption)
                        if title == "Supplied" { Text(t.collateral ? "collateral" : "not collateral").font(.caption2).foregroundStyle(.tertiary) }
                        if let apr = t.apr { Text(String(format: "%.2f%% APR", apr * 100)).font(.caption2).foregroundStyle(.tertiary) }
                        Spacer()
                        Text(amount(t.amount)).font(.caption).monospacedDigit()
                        Text(dollars(t.usd)).font(.caption2).foregroundStyle(.secondary).monospacedDigit().frame(minWidth: 52, alignment: .trailing)
                    }
                }
            }
        }
    }

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
            if let supplied = card.supplied, let borrowed = card.borrowed {
                tokens("Supplied", supplied)
                tokens("Borrowed", borrowed)
                if let d = card.liquidationDistance {
                    Text("Liquidated if the main collateral falls \(String(format: "%.1f", d * 100))%").font(.caption2).foregroundStyle(.secondary)
                }
            } else {
                HStack {
                    Text("Collateral \(dollars(card.collateralUsd)) · Debt \(dollars(card.debtUsd))")
                    Spacer()
                    if let d = card.liquidationDistance { Text("liq. after −\(String(format: "%.1f", d * 100))%") }
                }
                .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(11)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.rule))
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
                Circle().fill(.black).frame(width: 12, height: 12).overlay(Circle().stroke(.primary, lineWidth: 2.5)).offset(x: pos(health) - 6)
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
        .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct FixCardView: View {
    let card: FixCard
    let review: (String) -> Void
    /// A wallet the fix sends from that's only read: then the card offers to connect it instead.
    var readOnly: String? = nil
    var connect: () -> Void = {}
    var body: some View {
        let f = card.fix
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                Text(String(UnicodeScalar(UInt8(64 + max(1, min(f.rank, 26)))))).font(.system(size: 12, weight: .bold, design: .monospaced))
                    .frame(width: 20, height: 20).background(Palette.blue.opacity(0.25), in: Circle())
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
            SendButton(readOnly: readOnly, connect: connect) { review(f.id) }
                .disabled(f.notes.contains { $0.contains("hypothetical") })
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(11)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.rule))
    }
}

/// White text in a thin white outline, on the panel's black.
struct OutlineButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 12).padding(.vertical, 5)
            .background(Color.white.opacity(configuration.isPressed ? 0.15 : 0), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.white, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 8))
    }
}

/// An (i) that explains a control only when asked: on hover, or in a small popover on click.
struct InfoButton: View {
    let text: String
    @State private var shown = false
    var body: some View {
        Button { shown.toggle() } label: { Image(systemName: "info.circle").foregroundStyle(.secondary) }
            .buttonStyle(.plain)
            .help(text)
            .popover(isPresented: $shown, arrowEdge: .bottom) {
                Text(text).font(.callout).fixedSize(horizontal: false, vertical: true).frame(width: 260).padding(12)
            }
    }
}

/// "Review & sign" when every wallet that signs is connected; otherwise a way to connect the one that's only read.
struct SendButton: View {
    let readOnly: String?
    let connect: () -> Void
    let review: () -> Void
    var body: some View {
        if let wallet = readOnly {
            VStack(alignment: .leading, spacing: 3) {
                Button("Connect \(wallet) to send", action: connect).buttonStyle(.borderedProminent).controlSize(.small)
                Text("\(wallet) was added by address, so Nierwall only reads it.").font(.caption2).foregroundStyle(.secondary)
            }
        } else {
            Button("Review & sign", action: review).buttonStyle(.borderedProminent).controlSize(.small)
        }
    }
}

/// A checked plan: what changes, the steps, the cost, and anything to watch out for.
struct PlanCardView: View {
    let card: PlanCard
    let review: (String) -> Void
    var readOnly: String? = nil
    var connect: () -> Void = {}
    private func hf(_ v: Double?) -> String { v.map { String(format: "%.2f", $0) } ?? "no debt" }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "checklist").foregroundStyle(Palette.blue)
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
            SendButton(readOnly: readOnly, connect: connect) { review(card.planId) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(11)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.blue.opacity(0.45)))
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
        .background(Palette.blue.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
    }
}

/// Your wallets and what's turned on. Type an address to watch a wallet (read-only), or connect one through its wallet
/// app in the browser so Nierwall can also send it transactions to approve.
struct ConnectionsView: View {
    @ObservedObject var brain: BrainClient
    let linkTelegram: () -> Void
    @State private var address = ""
    @State private var name = ""
    @State private var showAdd = false
    @State private var adding = false
    @State private var addError: String?
    /// Only token names, no amounts or values: for screen sharing.
    @AppStorage("hideAmounts") private var hideAmounts = false

    var body: some View {
        let c = brain.connections
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Wallets").font(.headline)
                if let wallets = c?.wallets, !wallets.isEmpty {
                    ForEach(wallets) { w in walletRow(w) }
                } else {
                    Text("None yet.").font(.caption).foregroundStyle(.secondary)
                }
            }
            addForm
            Divider()
            tokensSection
            Divider()
            rheaSection
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
        .task {
            await brain.loadConnections()
            // Prices move: refresh the tokens every minute while this is open.
            while !Task.isCancelled {
                await brain.loadTokens()
                try? await Task.sleep(for: .seconds(60))
            }
        }
        .onChange(of: brain.connections?.wallets.map(\.id)) { _, _ in Task { await brain.loadTokens() } }
    }

    /// Your own wallets' tokens and their total worth. The eye turns every number and value into "**".
    private var tokensSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Tokens").font(.headline)
                Spacer()
                Button { hideAmounts.toggle() } label: { Image(systemName: hideAmounts ? "eye.slash" : "eye") }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .help(hideAmounts ? "Show amounts" : "Hide amounts")
            }
            if brain.connections?.wallets.isEmpty ?? true {
                Text("Add a wallet to see its tokens.").font(.caption).foregroundStyle(.secondary)
            } else if let t = brain.tokens {
                HStack(alignment: .firstTextBaseline) {
                    Text("Total worth").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Text(masked(usd(t.totalUsd))).font(.title3.weight(.semibold)).monospacedDigit()
                }
                if let loans = t.loansUsd {
                    Text("Includes Rhea loans, \(masked(usd(loans))) net").font(.caption2).foregroundStyle(.tertiary)
                }
                ForEach(t.tokens) { token in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(token.symbol).font(.callout.weight(.medium))
                        Text(token.network).font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Text(masked(amount(token.amount))).font(.callout).monospacedDigit()
                        Text(masked(token.usd.map(usd) ?? "–")).font(.caption).foregroundStyle(.secondary).monospacedDigit().frame(minWidth: 64, alignment: .trailing)
                    }
                }
                if t.tokens.isEmpty { Text("No tokens found.").font(.caption).foregroundStyle(.secondary) }
                if !t.complete { Text("Some networks didn't answer; this may be missing a few.").font(.caption2).foregroundStyle(.tertiary) }
            } else {
                ProgressView().controlSize(.small)
            }
        }
    }

    /// Your Rhea loans: health, how far from liquidation, and what's lent and borrowed (dollar amounts hide with the eye).
    private var rheaSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Rhea positions").font(.headline)
            if brain.positions.isEmpty {
                Text(brain.connections?.wallets.contains { $0.chain == "near" } == true ? "No Rhea positions in your NEAR wallets." : "Add a NEAR wallet to see its Rhea positions.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(brain.positions) { PositionCardView(card: $0, hideAmounts: hideAmounts) }
        }
    }

    /// With amounts hidden, every number shows as "**".
    private func masked(_ s: String) -> String { hideAmounts ? "**" : s }

    private func usd(_ v: Double) -> String {
        v.formatted(.currency(code: "USD").precision(.fractionLength(abs(v) >= 1000 ? 0 : 2)))
    }

    private func amount(_ v: Double) -> String {
        v.formatted(.number.precision(.significantDigits(1...(v >= 1 ? 6 : 4))).grouping(.automatic))
    }

    /// Two ways to add a wallet, each explained behind its (i): watch one by its address (the fields open here), or
    /// connect one in the browser.
    private var addForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 14) {
                HStack(spacing: 4) {
                    Button("Add wallet") { showAdd.toggle(); addError = nil }.buttonStyle(OutlineButtonStyle())
                    InfoButton(text: "Watch a wallet by its address: a NEAR account, a 0x address or a Solana address. Nierwall reads its balances and loans and alerts you, but can't send it anything.")
                }
                HStack(spacing: 4) {
                    Button("Connect wallet") { Task { _ = await brain.connectWallet() } }.buttonStyle(OutlineButtonStyle())
                    InfoButton(text: "Opens your browser to connect Meteor or another NEAR wallet, or MetaMask for EVM networks. Then Nierwall can send it fixes and swaps for you to approve. It only gets the address, never your keys.")
                }
            }
            if showAdd {
                TextField("you.near, 0x… or a Solana address", text: $address).textFieldStyle(.roundedBorder).onSubmit(add)
                HStack(spacing: 8) {
                    TextField("Name, like Savings", text: $name).textFieldStyle(.roundedBorder).onSubmit(add)
                    Button(adding ? "Adding…" : "Add", action: add).buttonStyle(.borderedProminent)
                        .disabled(adding || address.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                if let addError {
                    Text(addError).font(.caption).foregroundStyle(Palette.crit).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .controlSize(.small)
    }

    private func add() {
        let a = address.trimmingCharacters(in: .whitespaces)
        guard !a.isEmpty, !adding else { return }
        adding = true
        addError = nil
        Task {
            let err = await brain.addWallet(address: a, label: name.trimmingCharacters(in: .whitespaces))
            adding = false
            if let err { addError = err } else { address = ""; name = ""; showAdd = false }
        }
    }

    private func walletRow(_ w: Connections.Wallet) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: w.chain == "near" ? "n.circle.fill" : w.chain == "solana" ? "s.circle.fill" : "e.circle.fill").foregroundStyle(w.connected ? Palette.blue : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(w.label).font(.callout.weight(.semibold))
                Text([short(w.address), w.chain == "evm" ? "every EVM network" : w.chain == "solana" ? "Solana" : nil].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    Text(w.connected ? "Connected · \(w.app ?? "wallet")" : "Read-only").font(.caption2.weight(.medium)).foregroundStyle(w.connected ? Palette.blue : .secondary)
                    // Solana wallets are only read: there's nothing to connect them to.
                    if !w.connected && w.chain != "solana" {
                        Button("Connect to send") { Task { _ = await brain.connectWallet() } }.buttonStyle(.link).font(.caption2)
                    }
                }
                if let loan = w.rhea {
                    Text("Rhea loan · health \(loan.healthFactor.map { String(format: "%.2f", $0) } ?? "no debt")").font(.caption).foregroundStyle(Palette.blue)
                }
            }
            Spacer()
            Button { Task { await brain.removeWallet(w.label) } } label: { Image(systemName: "xmark.circle") }
                .buttonStyle(.plain).foregroundStyle(.secondary).help("Stop watching \(w.label)")
        }
    }

    /// A switch's label, as wide as the row, so every switch lines up on the right.
    private func feature(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title).font(.callout)
            Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
