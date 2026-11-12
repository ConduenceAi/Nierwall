import SwiftUI

@MainActor
final class UIState: ObservableObject {
    @Published var listening = false
    @Published var transcript = ""
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
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().opacity(0.5)
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
            if ui.listening || !ui.transcript.isEmpty { transcriptBar }
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
            Orb(active: ui.listening || brain.thinking)
            VStack(alignment: .leading, spacing: 1) {
                Text("Nierwall").font(.system(size: 15, weight: .semibold))
                Text(stateLine).font(.caption).foregroundStyle(stateColor)
            }
            Spacer()
            attestationChip
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
            if brain.positions.isEmpty {
                Text(brain.connection == .connected ? "Loading your positions…" : "Start the brain with `pnpm brain`, then ask me anything.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Text("Try: “How's my Rhea loan?” · “What if NEAR drops 20%?” · “Ping me if Rhea goes under 1.5”")
                .font(.caption).foregroundStyle(.tertiary)
            if brain.connection == .connected, brain.status?.telegramLinked == false {
                Button("Get alerts on Telegram") { actions.linkTelegram() }.buttonStyle(.link).font(.caption)
            }
        }
    }

    private var transcriptBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "waveform").foregroundStyle(Color.accentColor).symbolEffect(.variableColor.iterative, isActive: ui.listening)
            Text(ui.transcript.isEmpty ? "Listening…" : ui.transcript).font(.callout).italic().lineLimit(2)
            Spacer()
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(Color.accentColor.opacity(0.08))
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
            .help(ui.listening ? "Stop and send" : "Talk (or hold ⌘⇧Space)")
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .overlay(alignment: .bottomTrailing) {
            Text("Hold ⌘⇧Space to talk").font(.system(size: 9)).foregroundStyle(.tertiary).padding(.trailing, 14).padding(.bottom, 2)
        }
    }

    private func submit() {
        let text = input
        input = ""
        actions.send(text)
    }
}

struct Orb: View {
    let active: Bool
    @State private var pulse = false
    var body: some View {
        Circle()
            .fill(AngularGradient(colors: [.blue, Palette.near, .purple, .blue], center: .center))
            .frame(width: 22, height: 22)
            .overlay(Circle().stroke(Color.accentColor.opacity(0.35), lineWidth: pulse && active ? 6 : 3))
            .scaleEffect(pulse && active ? 1.08 : 1)
            .animation(active ? .easeInOut(duration: 0.8).repeatForever(autoreverses: true) : .default, value: pulse)
            .onAppear { pulse = true }
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
        .padding(11)
        .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.separator))
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
