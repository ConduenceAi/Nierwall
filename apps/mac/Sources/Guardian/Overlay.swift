import AppKit
import Combine
import SwiftUI

// MARK: - State

/// What the Siri-style orb is doing.
@MainActor
final class OverlayModel: ObservableObject {
    enum Phase: Equatable { case preparing, listening, thinking, answer, message }

    @Published var phase: Phase = .preparing
    /// Smoothed microphone level, 0 to 1.
    @Published var level: Double = 0
    @Published var speaking = false
    @Published var hovering = false
    /// True while ⌘⌥ is held (letting go sends). False for tap-to-talk (a pause or a click on the orb sends).
    var holdToTalk = true
    /// What you've said so far. Not shown; it tells a pause after speech from silence.
    var transcript = ""

    func reset(holdToTalk: Bool) {
        phase = .preparing
        level = 0
        speaking = false
        transcript = ""
        self.holdToTalk = holdToTalk
    }

    func push(level new: Double) {
        level = level * 0.5 + new * 0.5
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
    var size: CGFloat = 64
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Shades of green, led by NEAR green (#00EC97).
    static let colors: [Color] = [
        Color(red: 0.00, green: 0.93, blue: 0.59),
        Color(red: 0.06, green: 0.62, blue: 0.40),
        Color(red: 0.08, green: 0.72, blue: 0.65),
        Color(red: 0.52, green: 0.85, blue: 0.20),
    ]
    private static let speeds: [Double] = [0.7, -0.95, 1.2, -0.55]

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: reduceMotion || (mode == .idle && size < 40))) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let e = energy(at: t)
            ZStack {
                Circle().fill(Color(red: 0.01, green: 0.07, blue: 0.05))
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

/// Just the orb, no background. Click it when you're done talking, or to ask something else.
struct OverlayView: View {
    @ObservedObject var model: OverlayModel
    var orbTap: () -> Void

    var body: some View {
        Button(action: orbTap) { SiriOrb(mode: model.orbMode, level: model.level, size: OverlayController.orbSize) }
            .buttonStyle(.plain)
            .help(model.phase == .listening ? "Done talking" : "Ask something else")
            .accessibilityLabel(label)
            .onHover { model.hovering = $0 }
            .padding(OverlayController.margin) // room for the orb to swell and glow
    }

    private var label: String {
        switch model.phase {
        case .preparing: return "Nierwall is getting voice ready"
        case .listening: return "Nierwall is listening"
        case .thinking: return "Nierwall is thinking"
        case .answer, .message: return model.speaking ? "Nierwall is talking" : "Nierwall"
        }
    }
}

// MARK: - Windows

/// The orb's window: above every app, including full-screen ones. It never takes keyboard focus, so a
/// shortcut or text you're typing keeps going to your app.
final class OverlayPanel: NSPanel {
    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 116, height: 116),
                   styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView], backing: .buffered, defer: false)
        isFloatingPanel = true
        level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
    }
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
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

/// The orb answers the first click, even though Nierwall is never the active app.
final class FirstClickHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// MARK: - Controller

/// Shows the orb at the top center of the screen you're working on, with the edge glow, and fades them
/// out once Nierwall has finished talking.
@MainActor
final class OverlayController {
    static let orbSize: CGFloat = 64
    static let margin: CGFloat = 22

    let model = OverlayModel()
    private let panel = OverlayPanel()
    private let glow = GlowWindow()
    private var shown = false
    private var dismissTimer: Timer?
    private var clickMonitor: Any?
    private var bag = Set<AnyCancellable>()

    /// The orb went away, on its own or because you clicked elsewhere.
    var onClose: (() -> Void)?
    var onOrbTap: (() -> Void)?

    var isVisible: Bool { shown }

    init() {
        let host = FirstClickHostingView(rootView: OverlayView(model: model, orbTap: { [weak self] in self?.onOrbTap?() }))
        host.sizingOptions = []
        panel.contentView = host

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
        // Top center, just under the menu bar (and the notch).
        let side = (Self.orbSize * 1.12 + Self.margin * 2).rounded()
        panel.setFrame(NSRect(x: (screen.frame.midX - side / 2).rounded(), y: (screen.visibleFrame.maxY - side + 8).rounded(), width: side, height: side), display: true)
        glow.setFrame(screen.frame, display: false)
        if !shown {
            shown = true
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.18
                panel.animator().alphaValue = 1
            }
            // A click in another app dismisses a finished answer. Mouse events need no permission.
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
            ctx.duration = 0.25
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            Task { @MainActor in
                guard let self, !self.shown else { return }
                self.panel.orderOut(nil)
            }
        })
        onClose?()
    }

    /// The answer is in. The orb pulses while it's spoken, then fades.
    func showAnswer(spoken: Bool) {
        model.phase = .answer
        if !shown { show() }
        scheduleDismiss(after: spoken ? 8 : 1.5)
    }

    /// A short spoken status, like "I didn't catch that."
    func showMessage() {
        model.phase = .message
        if !shown { show() }
        scheduleDismiss(after: 8)
    }

    func setSpeaking(_ speaking: Bool) {
        model.speaking = speaking
        if !speaking, shown, model.phase == .answer || model.phase == .message { scheduleDismiss(after: 1) }
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
}

// MARK: - Design check

/// Offscreen renders of the orb on a mock screen, for checking the design: `Nierwall --render-previews <folder>`.
/// Nothing is shown on screen.
@MainActor
enum OverlayPreviews {
    static func render(to dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let states: [(String, (OverlayModel) -> Void)] = [
            ("1-listening", { m in m.reset(holdToTalk: true); m.phase = .listening; m.level = 0.75 }),
            ("2-thinking", { m in m.reset(holdToTalk: true); m.phase = .thinking }),
            ("3-speaking", { m in m.reset(holdToTalk: true); m.phase = .answer; m.speaking = true }),
        ]
        for (name, setup) in states {
            let model = OverlayModel()
            setup(model)
            save(mockScreen(model), name, dir)
        }
        if let card = try? JSONDecoder().decode(PlanCard.self, from: Data(samplePlan.utf8)) {
            save(PlanCardView(card: card, review: { _ in }).padding(14).frame(width: 390).background(Color(white: 0.93)), "5-plan-card", dir)
        }
        save(HStack(spacing: 28) {
            SiriOrb(mode: .idle)
            SiriOrb(mode: .listening, level: 0.85)
            SiriOrb(mode: .thinking)
            SiriOrb(mode: .speaking)
            SiriOrb(mode: .listening, level: 0.5, size: 22)
        }.padding(30).background(desktop), "4-orbs", dir)
    }

    private static let samplePlan = """
    {"type":"plan","planId":"plan_x","title":"Bring cash over and repay Rhea","goal":"safer Rhea loan",
     "steps":[{"n":1,"chain":"base","wallet":"Cash","description":"Move 2,000 USDC → about 2,000 USDC from Cash to Savings with NEAR Intents (at least 1,990, ~35s)","manual":false},
              {"n":2,"chain":"near","wallet":"Savings","description":"Repay 1,950 USDC on Rhea from Savings","manual":false}],
     "loans":[{"positionId":"rhea:Savings","label":"Rhea · Savings","before":1.41,"after":1.83,"floor":1.3}],
     "allocation":[{"cls":"stable","beforePct":42.1,"afterPct":35.6},{"cls":"NEAR","beforePct":57.9,"afterPct":64.4}],
     "netWorthBefore":20450,"netWorthAfter":20449,"costUsd":0.42,"maxCostUsd":15,"costReason":"worth a little to move the loan away from liquidation",
     "warnings":["Moving between Cash and Savings links the two wallets on-chain."],"simulated":false}
    """

    private static let desktop = LinearGradient(colors: [Color(red: 0.16, green: 0.2, blue: 0.3), Color(red: 0.36, green: 0.24, blue: 0.4)], startPoint: .topLeading, endPoint: .bottomTrailing)

    /// A 1280×800 screen: menu bar, an app window, the edge glow, and the orb where the real one goes.
    private static func mockScreen(_ model: OverlayModel) -> some View {
        ZStack(alignment: .top) {
            desktop
            RoundedRectangle(cornerRadius: 12).fill(Color(white: 0.95)).frame(width: 820, height: 500).shadow(radius: 24).padding(.top, 150)
            Rectangle().fill(.black.opacity(0.35)).frame(height: 28)
            if model.glowing { EdgeGlow(model: model) }
            OverlayView(model: model, orbTap: {}).padding(.top, 28 - 8)
        }
        .frame(width: 1280, height: 800)
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
}
