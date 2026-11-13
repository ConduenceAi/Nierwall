import AppKit
import Combine
import SwiftUI

/// Spotlight-style panel: floats above other windows, doesn't activate the app, closes on Esc or click-away.
final class FloatingPanel: NSPanel {
    init(content: NSView) {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 390, height: 540), styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView], backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        contentView = content
    }
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) { orderOut(nil) }
    override func resignKey() {
        super.resignKey()
        orderOut(nil)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var panel: FloatingPanel!
    private var overlay: OverlayController!
    private let brain = BrainClient()
    private let ui = UIState()
    private let speaker = SpeechOutput()
    private let notifier = Notifier()
    private let talkKeys = TalkKeys()
    private var speech: AnyObject?
    /// Where the overlay's question sits in brain.items; its answer is the next assistant item after it.
    private var awaitingReply: Int?
    private var replyTimeout: Timer?
    private var listenStartedAt = Date()
    private var lastVoiceAt: Date?
    private var bag = Set<AnyCancellable>()

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePanel)
        setIcon("shield", tint: nil)

        let actions = PanelActions(
            send: { [weak self] text in self?.ui.voiceTurn = false; self?.brain.ask(text) },
            toggleMic: { [weak self] in self?.toggleListening() },
            review: { [weak self] fixId in Task { await self?.review(fixId) } },
            confirmWatch: { [weak self] id in Task { _ = await self?.brain.confirmWatch(id) } },
            snooze: { [weak self] id in Task { await self?.brain.snooze(id) } },
            linkTelegram: { [weak self] in Task { if let err = await self?.brain.linkTelegram() { self?.ui.notice = err } } }
        )
        panel = FloatingPanel(content: NSHostingView(rootView: PanelView(brain: brain, ui: ui, actions: actions)))
        overlay = OverlayController()
        overlay.onOrbTap = { [weak self] in self?.orbTapped() }
        overlay.onClose = { [weak self] in self?.overlayClosed() }
        speaker.onSpeakingChanged = { [weak self] speaking in self?.overlay.setSpeaking(speaking) }

        brain.onAlert = { [weak self] alert, _ in
            self?.notifier.post(title: alert.title, body: alert.body, alertId: alert.alertId, incidentId: alert.incidentId, critical: alert.severity == "critical")
        }
        brain.onReply = { [weak self] reply in
            guard let self else { return }
            if self.ui.voiceTurn && self.ui.speakReplies { self.speaker.say(reply.speak) }
            self.ui.voiceTurn = false
        }
        brain.onReviewRequested = { [weak self] _ in self?.showPanel() }
        notifier.onOpen = { [weak self] _ in self?.showPanel() }
        notifier.onSnooze = { [weak self] id in Task { await self?.brain.snooze(id) } }

        brain.$status.combineLatest(brain.$connection)
            .receive(on: RunLoop.main)
            .sink { [weak self] _, _ in self?.updateIcon() }
            .store(in: &bag)
        brain.$items
            .receive(on: RunLoop.main)
            .sink { [weak self] items in self?.deliverReply(items) }
            .store(in: &bag)

        talkKeys.onHoldStart = { [weak self] in self?.beginVoice(holdToTalk: true) }
        talkKeys.onHoldEnd = { [weak self] in self?.holdReleased() }
        talkKeys.onTap = { [weak self] in self?.keysTapped() }
        talkKeys.onInterrupted = { [weak self] in self?.cancelVoice() }

        brain.connect()
    }

    // MARK: Panel

    @objc private func togglePanel() {
        panel.isVisible ? panel.orderOut(nil) : showPanel()
    }

    /// Opening the panel ends a voice turn, unless the turn itself opened it (an answer with buttons).
    private func showPanel(keepOverlay: Bool = false) {
        if overlay.isVisible, !keepOverlay { cancelVoice() }
        if let button = statusItem.button, let window = button.window {
            let rect = window.convertToScreen(button.convert(button.bounds, to: nil))
            let screen = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
            let x = min(rect.maxX - panel.frame.width + 12, screen.maxX - panel.frame.width - 8)
            panel.setFrameOrigin(NSPoint(x: max(screen.minX + 8, x), y: rect.minY - panel.frame.height - 6))
        }
        panel.makeKeyAndOrderFront(nil)
    }

    private func review(_ fixId: String) async {
        if let err = await brain.review(fixId: fixId) { ui.notice = err } else { overlay.hide() }
    }

    // MARK: ⌘⌥: hold to talk, tap to finish or close

    private func holdReleased() {
        if ui.listening, overlay.model.holdToTalk { finishVoice() }
    }

    private func keysTapped() {
        if ui.listening { finishVoice() } else if overlay.isVisible { cancelVoice() }
    }

    private func orbTapped() {
        switch overlay.model.phase {
        case .listening: finishVoice()
        case .answer, .message: beginVoice(holdToTalk: false)
        case .preparing, .thinking: break
        }
    }

    private func toggleListening() {
        ui.listening ? finishVoice() : beginVoice(holdToTalk: false)
    }

    // MARK: Voice, through the Siri-style overlay

    private func beginVoice(holdToTalk: Bool) {
        guard !ui.listening else { return }
        guard #available(macOS 26.0, *) else {
            ui.notice = "Voice needs macOS 26 or later. Typing works."
            showPanel()
            return
        }
        speaker.stop()
        replyTimeout?.invalidate()
        awaitingReply = nil
        panel.orderOut(nil)
        overlay.model.reset(holdToTalk: holdToTalk)
        overlay.show()

        let input = SpeechInput()
        input.onTranscript = { [weak self] text in self?.overlay.model.transcript = text }
        input.onLevel = { [weak self] level in self?.heard(level) }
        speech = input
        ui.listening = true
        ui.notice = nil
        listenStartedAt = Date()
        lastVoiceAt = nil
        Task {
            do {
                try await input.start()
                if ui.listening, speech === input {
                    speaker.stop() // so the mic doesn't hear "getting voice ready"
                    overlay.model.phase = .listening
                }
            } catch is CancellationError {
                // Stopped while the speech model was still loading; finishVoice already said so.
            } catch {
                guard speech === input else { return }
                ui.listening = false
                speech = nil
                say("I couldn't start listening.")
                ui.notice = "Couldn't start listening: \(error.localizedDescription)"
                showPanel(keepOverlay: true)
            }
        }
        // The first time, macOS downloads its speech model before the mic turns on.
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            if ui.listening, speech === input, overlay.model.phase == .preparing { speaker.say("One moment, getting voice ready.") }
        }
    }

    /// Drives the orb, and ends a tap-to-talk turn after a short pause once you've said something.
    private func heard(_ level: Double) {
        overlay.model.push(level: level)
        guard ui.listening, !overlay.model.holdToTalk, overlay.model.phase == .listening else { return }
        let now = Date()
        if level > 0.3 { lastVoiceAt = now }
        let quiet = now.timeIntervalSince(lastVoiceAt ?? listenStartedAt)
        let said = !overlay.model.transcript.isEmpty
        if (said && quiet > 1.4) || (!said && quiet > 6) || now.timeIntervalSince(listenStartedAt) > 30 {
            finishVoice()
        }
    }

    /// Stops listening and sends what you said.
    private func finishVoice() {
        guard ui.listening, #available(macOS 26.0, *), let input = speech as? SpeechInput else { return }
        ui.listening = false
        let wasPreparing = overlay.model.phase == .preparing
        overlay.model.phase = .thinking
        overlay.model.level = 0
        Task {
            let text = await input.stop()
            if speech === input { speech = nil }
            guard overlay.isVisible else { return }
            if wasPreparing {
                say("Voice is still getting ready. Try again in a moment.")
            } else if text.isEmpty {
                say("I didn't catch that.")
            } else {
                ask(text)
            }
        }
    }

    private func ask(_ text: String) {
        overlay.model.transcript = text
        ui.voiceTurn = true
        awaitingReply = brain.items.count
        brain.ask(text)
        replyTimeout?.invalidate()
        replyTimeout = Timer.scheduledTimer(withTimeInterval: 45, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.awaitingReply != nil else { return }
                self.awaitingReply = nil
                self.ui.voiceTurn = false
                self.say("Still working on it. The answer will show up in the Nierwall panel.")
            }
        }
    }

    private func deliverReply(_ items: [ChatItem]) {
        guard let start = awaitingReply, items.count > start,
              let reply = items[start...].first(where: { $0.role == .assistant }) else { return }
        awaitingReply = nil
        replyTimeout?.invalidate()
        // Answers from the brain are spoken (see onReply). Anything to click, or not spoken, opens in the panel.
        let spoken = reply.via != nil && ui.speakReplies
        overlay.showAnswer(spoken: spoken)
        if !spoken || reply.cards.contains(where: needsClick) { showPanel(keepOverlay: true) }
    }

    private func needsClick(_ card: Card) -> Bool {
        switch card {
        case .fix, .watchConfirm, .plan: return true
        default: return false
        }
    }

    /// A short spoken status from the orb, like "I didn't catch that."
    private func say(_ text: String) {
        overlay.showMessage()
        speaker.say(text)
    }

    /// Esc, the close button, a quick ⌘⌥ tap, or a shortcut pressed mid-hold: stop without sending, and close.
    private func cancelVoice() {
        if ui.listening, #available(macOS 26.0, *), let input = speech as? SpeechInput {
            ui.listening = false
            speech = nil
            Task { _ = await input.stop() }
        }
        overlay.hide()
    }

    /// Once the overlay closes, a late answer goes to the panel instead of being spoken out of nowhere.
    private func overlayClosed() {
        if awaitingReply != nil {
            awaitingReply = nil
            ui.voiceTurn = false
        }
        replyTimeout?.invalidate()
        speaker.stop()
    }

    // MARK: Menu-bar icon reflects state

    private func updateIcon() {
        if brain.connection != .connected { return setIcon("shield.slash", tint: .secondaryLabelColor) }
        switch brain.status?.state {
        case "attention": setIcon("exclamationmark.shield.fill", tint: .systemOrange)
        case "degraded": setIcon("shield.slash", tint: .systemOrange)
        default: setIcon("shield", tint: nil)
        }
    }

    private func setIcon(_ symbol: String, tint: NSColor?) {
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Nierwall")
        image?.isTemplate = tint == nil
        statusItem.button?.image = image
        statusItem.button?.contentTintColor = tint
    }
}
