import AppKit
import Combine
import SwiftUI

// MARK: - State

/// What the Siri-style voice overlay is showing.
@MainActor
final class OverlayModel: ObservableObject {
    enum Phase: Equatable { case preparing, listening, thinking, answer, message }

    @Published var phase: Phase = .preparing
    /// Smoothed microphone level, 0 to 1.
    @Published var level: Double = 0
    @Published var transcript = ""
    @Published var reply: ChatItem?
    @Published var message = ""
    @Published var speaking = false
    @Published var hovering = false
    /// True while ⌘⌥ is held (letting go sends). False for tap-to-talk (a pause or a click on the orb sends).
    @Published var holdToTalk = true

    func reset(holdToTalk: Bool) {
        phase = .preparing
        level = 0
        transcript = ""
        reply = nil
        message = ""
        speaking = false
        self.holdToTalk = holdToTalk
    }

    func push(level new: Double) {
        level = level * 0.5 + new * 0.5
    }

    /// Answers with buttons stay up until you act on them or close them.
    var needsAction: Bool {
        (reply?.cards ?? []).contains { card in
            switch card {
            case .fix, .watchConfirm: return true
            default: return false
            }
        }
    }

    var glowing: Bool { phase == .preparing || phase == .listening || phase == .thinking }

    var orbMode: OrbMode {
        switch phase {
        case .listening: return .listening
        case .preparing, .thinking: return .thinking
        case .answer, .message: return speaking ? .speaking : .idle
        }
    }
}

// MARK: - Orb and edge glow

enum OrbMode { case idle, listening, thinking, speaking }

/// Siri-style orb: colored light drifting inside a dark glass sphere. It swells with your voice,
/// swirls while Nierwall thinks, and pulses while it speaks.
struct SiriOrb: View {
    var mode: OrbMode
    var level: Double = 0
    var size: CGFloat = 76
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let colors: [Color] = [
        Color(red: 0.16, green: 0.42, blue: 1.00),
        Color(red: 0.60, green: 0.30, blue: 1.00),
        Color(red: 1.00, green: 0.30, blue: 0.60),
        Color(red: 0.00, green: 0.80, blue: 0.62),
    ]
    private static let speeds: [Double] = [0.7, -0.95, 1.2, -0.55]

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: reduceMotion || (mode == .idle && size < 40))) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let e = energy(at: t)
            ZStack {
                Circle().fill(Color(red: 0.03, green: 0.04, blue: 0.10))
                ForEach(0..<4, id: \.self) { i in blob(i, t: t, e: e) }
                Circle().fill(RadialGradient(colors: [.white.opacity(0.32), .clear], center: UnitPoint(x: 0.32, y: 0.24), startRadius: 0, endRadius: size * 0.5))
            }
            .frame(width: size, height: size)
            .clipShape(Circle())
            .overlay(Circle().strokeBorder(.white.opacity(0.2), lineWidth: max(0.5, size / 100)))
            .shadow(color: Self.colors[0].opacity(0.2 + 0.4 * e), radius: size * (0.06 + 0.2 * e))
            .scaleEffect(1 + 0.08 * e)
        }
        .frame(width: size * 1.12, height: size * 1.12)
    }

    private func energy(at t: Double) -> Double {
        switch mode {
        case .idle: return 0.2 + 0.05 * sin(t * 1.4)
        case .listening: return 0.22 + 0.78 * level
        case .thinking: return 0.42 + 0.16 * sin(t * 5)
        case .speaking: return 0.3 + 0.4 * abs(sin(t * 7)) * (0.65 + 0.35 * sin(t * 2.3))
        }
    }

    private func blob(_ i: Int, t: Double, e: Double) -> some View {
        let a = t * Self.speeds[i] * (mode == .thinking ? 2.6 : 1) + Double(i) * .pi / 2
        let r = size * (0.17 + 0.12 * e)
        return Ellipse()
            .fill(Self.colors[i].opacity(0.85))
            .frame(width: size * (0.5 + 0.2 * e), height: size * (0.38 + 0.16 * e))
            .rotationEffect(.radians(a * 0.8))
            .offset(x: cos(a) * r, y: sin(a * 1.3) * r)
            .blur(radius: size * 0.13)
            .blendMode(.plusLighter)
    }
}

/// The glow around the screen edges while you talk and while Nierwall thinks.
struct EdgeGlow: View {
    @ObservedObject var model: OverlayModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let e = model.phase == .listening ? 0.3 + 0.7 * model.level : 0.35 + 0.15 * sin(t * 3)
            // Colors sweep around the edges. Keep the angle small so it stays precise.
            let a = (t * 0.6).truncatingRemainder(dividingBy: 2 * .pi)
            let gradient = LinearGradient(colors: SiriOrb.colors,
                                          startPoint: UnitPoint(x: 0.5 + 0.5 * cos(a), y: 0.5 + 0.5 * sin(a)),
                                          endPoint: UnitPoint(x: 0.5 - 0.5 * cos(a), y: 0.5 - 0.5 * sin(a)))
            let edge = RoundedRectangle(cornerRadius: 12, style: .continuous)
            ZStack {
                edge.strokeBorder(gradient, lineWidth: 8 + 16 * e).blur(radius: 18)
                edge.strokeBorder(gradient, lineWidth: 1.5 + 2.5 * e).blur(radius: 2)
            }
            .drawingGroup() // one GPU pass for the whole glow
            .opacity(0.5 + 0.5 * e)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

// MARK: - The overlay card

private struct OverlaySizeKey: PreferenceKey {
    static let defaultValue = CGSize.zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}

/// The floating card: orb, what you said, and the answer with its cards.
struct OverlayView: View {
    @ObservedObject var model: OverlayModel
    @ObservedObject var brain: BrainClient
    let actions: PanelActions
    var orbTap: () -> Void
    var close: () -> Void
    var openPanel: () -> Void
    var onSize: (CGSize) -> Void

    var body: some View {
        VStack(spacing: 12) {
            Button(action: orbTap) { SiriOrb(mode: model.orbMode, level: model.level, size: 76) }
                .buttonStyle(.plain)
                .help(model.phase == .listening ? "Done talking" : "Ask something else")
            content
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 14)
        .frame(width: 440)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).strokeBorder(.white.opacity(0.14)))
        .overlay(alignment: .topTrailing) {
            Button(action: close) {
                Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
                    .frame(width: 20, height: 20).background(.quaternary, in: Circle())
            }
            .buttonStyle(.plain)
            .padding(12)
            .help("Close")
        }
        .shadow(color: .black.opacity(0.3), radius: 22, y: 8)
        .padding(28) // room for the shadow
        .fixedSize(horizontal: false, vertical: true)
        .background(GeometryReader { g in Color.clear.preference(key: OverlaySizeKey.self, value: g.size) })
        .onPreferenceChange(OverlaySizeKey.self) { onSize($0) }
        .onHover { model.hovering = $0 }
        .animation(.spring(response: 0.32, dampingFraction: 0.86), value: model.phase)
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .preparing:
            VStack(spacing: 4) {
                Text("Getting voice ready…").font(.title3.weight(.medium))
                Text("First time only: macOS is installing its speech model.").font(.caption).foregroundStyle(.secondary)
            }
            .multilineTextAlignment(.center)
        case .listening:
            Text(model.transcript.isEmpty ? "Listening…" : model.transcript)
                .font(.title3.weight(.medium))
                .foregroundStyle(model.transcript.isEmpty ? .secondary : .primary)
                .multilineTextAlignment(.center)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
            hint(model.holdToTalk ? "Let go of ⌘⌥ to send" : "Tap the orb when you're done")
        case .thinking:
            if !model.transcript.isEmpty { quote(model.transcript, lines: 3) }
            hint("Thinking…")
        case .answer:
            if !model.transcript.isEmpty { quote(model.transcript, lines: 2) }
            if let reply = model.reply { answer(reply) }
            hint("Tap the orb to ask something else")
        case .message:
            Text(model.message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func answer(_ reply: ChatItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(reply.text)
                .lineLimit(9)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(reply.cards.prefix(3)) { card in overlayCard(card) }
            if reply.cards.count > 3 {
                Button("\(reply.cards.count - 3) more in the Nierwall panel", action: openPanel).buttonStyle(.link).font(.caption)
            }
            if reply.via == "fallback" {
                Text("From templates (no model)").font(.system(size: 9, design: .monospaced)).foregroundStyle(.tertiary)
            } else if reply.via != nil, brain.status?.attestation.verified == true {
                Text("NEAR AI · TEE verified").font(.system(size: 9, weight: .medium, design: .monospaced)).foregroundStyle(Palette.near)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func overlayCard(_ card: Card) -> some View {
        switch card {
        case .fix(let f): FixCardView(card: f, review: actions.review, compact: true)
        default: CardView(card: card, actions: actions)
        }
    }

    private func quote(_ text: String, lines: Int) -> some View {
        Text("“\(text)”")
            .font(.callout)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .lineLimit(lines)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func hint(_ text: String) -> some View {
        Text(text).font(.caption2).foregroundStyle(.tertiary)
    }
}

// MARK: - Windows

/// The overlay's window: above every app, including full-screen ones. It never takes keyboard focus on
/// its own, so a shortcut or text you're typing keeps going to your app.
final class OverlayPanel: NSPanel {
    var onCancel: (() -> Void)?
    var onResign: (() -> Void)?

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 496, height: 220),
                   styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView], backing: .buffered, defer: false)
        isFloatingPanel = true
        becomesKeyOnlyIfNeeded = true
        level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
    }
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) { onCancel?() }
    override func resignKey() {
        super.resignKey()
        onResign?()
    }
}

/// Full-screen, click-through window for the edge glow.
final class GlowWindow: NSWindow {
    init() {
        super.init(contentRect: .zero, styleMask: [.borderless], backing: .buffered, defer: false)
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        ignoresMouseEvents = true
        isReleasedWhenClosed = false
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
    }
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Buttons in the overlay answer the first click, even though Nierwall is never the active app.
final class FirstClickHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// MARK: - Controller

/// Shows the overlay and the edge glow on the screen you're working on, and closes them when you're done.
@MainActor
final class OverlayController {
    let model = OverlayModel()
    private let panel = OverlayPanel()
    private let glow = GlowWindow()
    private var anchor = NSPoint.zero
    private var size = CGSize(width: 496, height: 220)
    private var shown = false
    private var dismissTimer: Timer?
    private var clickMonitor: Any?
    private var bag = Set<AnyCancellable>()

    /// Esc, the close button, or a click elsewhere while it's listening.
    var onCancel: (() -> Void)?
    /// The overlay closed, by you or on its own.
    var onClose: (() -> Void)?
    var onOrbTap: (() -> Void)?

    var isVisible: Bool { shown }

    init(brain: BrainClient, actions: PanelActions, openPanel: @escaping () -> Void) {
        let view = OverlayView(model: model, brain: brain, actions: actions,
                               orbTap: { [weak self] in self?.onOrbTap?() },
                               close: { [weak self] in self?.onCancel?() },
                               openPanel: openPanel,
                               onSize: { [weak self] in self?.resize($0) })
        let host = FirstClickHostingView(rootView: view)
        host.sizingOptions = []
        panel.contentView = host
        panel.onCancel = { [weak self] in self?.onCancel?() }
        panel.onResign = { [weak self] in self?.clickedAway() }

        let glowHost = NSHostingView(rootView: EdgeGlow(model: model))
        glowHost.sizingOptions = []
        glow.contentView = glowHost

        model.$phase.removeDuplicates().sink { [weak self] phase in
            guard let self, self.shown else { return }
            self.setGlow(phase == .preparing || phase == .listening || phase == .thinking)
        }.store(in: &bag)
    }

    func show() {
        dismissTimer?.invalidate()
        guard let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }) ?? NSScreen.main else { return }
        anchor = NSPoint(x: screen.visibleFrame.midX, y: screen.visibleFrame.minY + 8)
        glow.setFrame(screen.frame, display: false)
        place()
        if !shown {
            shown = true
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.18
                panel.animator().alphaValue = 1
            }
            // Clicks in other apps close a finished answer. Mouse events need no permission.
            clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                Task { @MainActor in self?.clickedAway() }
            }
        }
        setGlow(model.glowing)
    }

    func hide() {
        guard shown else { return }
        shown = false
        dismissTimer?.invalidate()
        if let clickMonitor { NSEvent.removeMonitor(clickMonitor) }
        clickMonitor = nil
        setGlow(false)
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.2
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            Task { @MainActor in
                guard let self, !self.shown else { return }
                self.panel.orderOut(nil)
            }
        })
        onClose?()
    }

    func showAnswer(_ item: ChatItem) {
        model.reply = item
        model.phase = .answer
        if !shown { show() }
        if model.needsAction {
            dismissTimer?.invalidate()
        } else {
            scheduleDismiss(after: min(16, max(5, Double(item.text.count) / 16)))
        }
    }

    func showMessage(_ text: String, dismissAfter seconds: TimeInterval = 2.5) {
        model.message = text
        model.phase = .message
        if !shown { show() }
        scheduleDismiss(after: seconds)
    }

    func setSpeaking(_ speaking: Bool) {
        model.speaking = speaking
        if !speaking, shown, model.phase == .answer, !model.needsAction { scheduleDismiss(after: 4) }
    }

    /// After you confirm or act on something in the overlay.
    func dismissSoon() {
        if shown { scheduleDismiss(after: 2.5) }
    }

    private func clickedAway() {
        guard shown, model.phase == .answer || model.phase == .message else { return }
        hide()
    }

    private func scheduleDismiss(after seconds: TimeInterval) {
        dismissTimer?.invalidate()
        dismissTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.shown else { return }
                if self.model.hovering || self.model.speaking { self.scheduleDismiss(after: 2) } else { self.hide() }
            }
        }
    }

    private func setGlow(_ on: Bool) {
        if on {
            if !glow.isVisible {
                glow.alphaValue = 0
                glow.orderFrontRegardless()
            }
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.35
                glow.animator().alphaValue = 1
            }
        } else if glow.isVisible {
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.45
                glow.animator().alphaValue = 0
            }, completionHandler: { [weak self] in
                Task { @MainActor in
                    guard let self, !(self.shown && self.model.glowing) else { return }
                    self.glow.orderOut(nil)
                }
            })
        }
    }

    private func resize(_ s: CGSize) {
        guard s.width > 1, s.height > 1, s != size else { return }
        size = s
        DispatchQueue.main.async { [weak self] in self?.place() }
    }

    /// Bottom center of the screen, growing upward as the answer comes in.
    private func place() {
        panel.setFrame(NSRect(x: (anchor.x - size.width / 2).rounded(), y: anchor.y.rounded(), width: size.width, height: size.height), display: true)
    }
}

// MARK: - Design check

/// Offscreen renders of the overlay for checking the design: `Nierwall --render-previews <folder>`.
/// Nothing is shown on screen.
@MainActor
enum OverlayPreviews {
    static func render(to dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let brain = BrainClient()
        let actions = PanelActions(send: { _ in }, toggleMic: {}, review: { _ in }, confirmWatch: { _ in }, snooze: { _ in }, linkTelegram: {})
        let cards = (try? JSONDecoder().decode([Card].self, from: Data(sampleCards.utf8))) ?? []
        let desktop = LinearGradient(colors: [Color(red: 0.16, green: 0.2, blue: 0.3), Color(red: 0.36, green: 0.24, blue: 0.4)], startPoint: .topLeading, endPoint: .bottomTrailing)

        func overlay(_ name: String, _ setup: (OverlayModel) -> Void) {
            let model = OverlayModel()
            setup(model)
            let view = OverlayView(model: model, brain: brain, actions: actions, orbTap: {}, close: {}, openPanel: {}, onSize: { _ in })
            save(view.background(desktop), name, dir)
        }
        overlay("1-listening") { m in
            m.reset(holdToTalk: true); m.phase = .listening; m.level = 0.75; m.transcript = "How's my Rhea loan doing"
        }
        overlay("2-thinking") { m in
            m.reset(holdToTalk: true); m.phase = .thinking; m.transcript = "How's my Rhea loan doing?"
        }
        overlay("3-answer") { m in
            m.reset(holdToTalk: true)
            m.transcript = "How's my Rhea loan doing?"
            m.reply = ChatItem(role: .assistant, text: "Your Rhea loan is healthy: health factor 1.37, and NEAR would have to fall 27% before liquidation. Your floor is 1.30.", cards: cards, via: "fallback")
            m.phase = .answer
        }
        overlay("4-message") { m in
            m.reset(holdToTalk: true); m.message = "I didn't catch that."; m.phase = .message
        }

        let glowModel = OverlayModel()
        glowModel.phase = .listening
        glowModel.level = 0.6
        save(EdgeGlow(model: glowModel).frame(width: 960, height: 600).background(desktop), "5-edge-glow", dir)
        save(HStack(spacing: 28) {
            SiriOrb(mode: .idle)
            SiriOrb(mode: .listening, level: 0.85)
            SiriOrb(mode: .thinking)
            SiriOrb(mode: .speaking)
            SiriOrb(mode: .listening, level: 0.5, size: 22)
        }.padding(30).background(desktop), "6-orbs", dir)
    }

    private static func save<V: View>(_ view: V, _ name: String, _ dir: URL) {
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        guard let image = renderer.cgImage,
              let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            print("couldn't render \(name)")
            return
        }
        try? png.write(to: dir.appendingPathComponent("\(name).png"))
        print("wrote \(name).png")
    }

    private static let sampleCards = """
    [{"type":"position","positionId":"rhea:NEAR wallet","title":"Rhea · NEAR","wallet":"NEAR wallet","health":1.37,"floor":1.3,"liquidationDistance":0.271,"collateralUsd":16479,"debtUsd":8564,"observedAt":"2026-11-13T09:00:00Z","simulated":false},
     {"type":"fix","alertId":"a1","fix":{"id":"f1","kind":"repay","title":"Move 1,359 USDC from Cash (Base) to NEAR, then repay on Rhea","steps":[{"chain":"base","wallet":"Cash","description":"Send 1,359 USDC to a NEAR Intents deposit address"},{"chain":"near","wallet":"NEAR wallet","description":"Repay the USDC that arrives on Rhea"}],"healthBefore":1.25,"healthAfter":1.48,"notes":["NEAR Intents: about 1,358.84 USDC arrives in ~35s"],"rank":1}},
     {"type":"watch_confirm","watchId":"w1","label":"Rhea · NEAR: health factor below 1.30"}]
    """
}
