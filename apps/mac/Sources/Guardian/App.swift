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
    /// The conversation's audio (a VoiceSession, macOS 26+), while one is going.
    private var voice: AnyObject?
    private var turns = TurnTaking()
    private var conversationStartedAt = Date.distantPast
    /// What the orb offered to send ("Should I send it to Meteor?"). Only your next turn can answer it.
    private var offer: Offer?
    private struct Offer { let id: String; let title: String }
    /// Signing news already told, so each is said once.
    private var told = Set<String>()
    /// Where the overlay's question sits in brain.items; its answer is the next assistant item after it.
    private var awaitingReply: Int?
    private var replyTimeout: Timer?
    private var bag = Set<AnyCancellable>()

    @available(macOS 26.0, *)
    private var session: VoiceSession? { voice as? VoiceSession }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePanel)
        setIcon("shield", tint: nil)

        let actions = PanelActions(
            send: { [weak self] text in self?.ui.voiceTurn = false; self?.brain.ask(text) },
            toggleMic: { [weak self] in self?.toggleConversation() },
            review: { [weak self] fixId in Task { await self?.review(fixId) } },
            confirmWatch: { [weak self] id in Task { _ = await self?.brain.confirmWatch(id) } },
            snooze: { [weak self] id in Task { await self?.brain.snooze(id) } },
            linkTelegram: { [weak self] in Task { if let err = await self?.brain.linkTelegram() { self?.ui.notice = err } } }
        )
        panel = FloatingPanel(content: NSHostingView(rootView: PanelView(brain: brain, ui: ui, actions: actions)))
        overlay = OverlayController()
        overlay.onOrbTap = { [weak self] in self?.talkPressed() }
        overlay.onEscape = { [weak self] in self?.endConversation() }
        overlay.onClose = { [weak self] in self?.overlayClosed() }
        speaker.onSpeakingChanged = { [weak self] speaking in self?.overlay.setSpeaking(speaking) }

        brain.onAlert = { [weak self] alert, _ in
            self?.notifier.post(title: alert.title, body: alert.body, alertId: alert.alertId, incidentId: alert.incidentId, critical: alert.severity == "critical")
        }
        brain.onReply = { [weak self] reply in
            guard let self else { return }
            if self.ui.voiceTurn && self.ui.speakReplies { self.answer(reply.speak, offering: self.sendable(reply.cards)) }
            self.ui.voiceTurn = false
        }
        brain.onSignUpdate = { [weak self] update in self?.signUpdated(update) }
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

        talkKeys.onPress = { [weak self] in self?.talkPressed() }
        talkKeys.onInterrupted = { [weak self] in self?.pressInterrupted() }

        brain.connect()
    }

    // MARK: Panel

    @objc private func togglePanel() {
        panel.isVisible ? panel.orderOut(nil) : showPanel()
    }

    /// Opening the panel ends a conversation, unless the conversation itself opened it (an answer with buttons).
    private func showPanel(keepOverlay: Bool = false) {
        if overlay.isVisible, !keepOverlay { endConversation() }
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

    // MARK: Voice: a conversation with the orb. ⌘⌥ starts it, a pause sends each turn, Esc ends it.

    /// ⌘⌥ (tapped or held) or a click on the orb. Mid-conversation it sends what you've said right away,
    /// or stops the orb talking; before you've said anything, it ends the conversation.
    private func talkPressed() {
        guard voice != nil else { return startConversation() }
        switch overlay.model.phase {
        case .listening: turns.hasSaid ? sendTurn() : endConversation()
        case .answer where overlay.model.speaking: cutIn(byVoice: false)
        default: break
        }
    }

    /// ⌘⌥ turned out to be part of a shortcut (another key while still held): undo the conversation it just started.
    private func pressInterrupted() {
        guard voice != nil, Date().timeIntervalSince(conversationStartedAt) < 3, !turns.hasSaid else { return }
        endConversation()
    }

    private func toggleConversation() {
        voice != nil ? endConversation() : startConversation()
    }

    private func startConversation() {
        guard #available(macOS 26.0, *) else {
            ui.notice = "Voice needs macOS 26 or later. Typing works."
            return showPanel()
        }
        speaker.stop()
        replyTimeout?.invalidate()
        awaitingReply = nil
        panel.orderOut(nil)
        overlay.model.reset()
        overlay.show()
        conversationStartedAt = Date()
        turns = TurnTaking() // the room may have changed since last time

        let session = VoiceSession()
        session.onLevel = { [weak self] level in self?.micLevel(level) }
        session.onTranscript = { [weak self] text in self?.transcribed(text) }
        session.onSpeakingChanged = { [weak self] speaking in self?.orbSpeaking(speaking) }
        session.onFailure = { [weak self] in self?.endConversation(saying: "The microphone stopped. Press Command Option to talk again.") }
        voice = session
        ui.listening = true
        ui.notice = nil
        Task {
            do {
                try await session.start()
                guard voice === session else { return }
                speaker.stop() // so the mic doesn't hear "getting voice ready"
                listen()
            } catch is CancellationError {
                // Ended while the speech model was still loading.
            } catch {
                guard voice === session else { return }
                ui.notice = "Couldn't start listening: \(error.localizedDescription)"
                endConversation(saying: "I couldn't start listening.")
                showPanel(keepOverlay: true)
            }
        }
        // The first time, macOS downloads its speech model before the mic turns on.
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            if voice === session, overlay.model.phase == .preparing { speaker.say("One moment, getting voice ready.") }
        }
    }

    /// Your turn: the orb listens.
    private func listen() {
        overlay.model.phase = .listening
        turns.listen(at: Date())
    }

    /// The mic level, about 20 times a second. The orb follows it, and it tells when you've finished
    /// talking, or started talking over the orb.
    private func micLevel(_ level: Double) {
        overlay.model.push(level: level)
        guard #available(macOS 26.0, *), let session else { return }
        let orbTalking = overlay.model.phase == .answer && overlay.model.speaking
        guard overlay.model.phase == .listening || (orbTalking && session.echoCancelling) else { return }
        switch turns.level(level, at: Date()) {
        case .duck: session.duck(true)
        case .unduck: session.duck(false)
        case .send: sendTurn()
        case .giveUp: endConversation()
        case .cutIn, nil: break
        }
    }

    /// What you've said so far this turn, about once a second.
    private func transcribed(_ text: String) {
        let phase = overlay.model.phase
        guard voice != nil, phase == .listening || phase == .answer else { return }
        if turns.transcript(text, at: Date()) == .cutIn, overlay.model.speaking { cutIn(byVoice: true) }
    }

    /// You talked over the orb, or pressed ⌘⌥ while it talked: it stops and listens.
    private func cutIn(byVoice: Bool) {
        guard #available(macOS 26.0, *), let session else { return }
        overlay.model.phase = .listening // first, so the end of its speech isn't taken as it finishing
        session.stopSpeaking()
        if byVoice {
            turns.cutIn(at: Date()) // keeps what you've said
        } else {
            session.beginTurn() // drops whatever the mic caught while it talked
            turns.listen(at: Date())
        }
    }

    /// The orb started or stopped talking.
    private func orbSpeaking(_ speaking: Bool) {
        overlay.model.speaking = speaking
        // It finished on its own: your turn, fresh, so none of its words count as yours.
        guard !speaking, overlay.model.phase == .answer, #available(macOS 26.0, *), let session else { return }
        session.beginTurn()
        listen()
    }

    /// You paused: send what you said.
    private func sendTurn() {
        guard #available(macOS 26.0, *), let session, overlay.model.phase == .listening else { return }
        overlay.model.phase = .thinking
        overlay.model.level = 0
        let turns = self.turns
        Task {
            let heard = await session.endTurn()
            guard voice === session else { return }
            let text = turns.cleaned(heard)
            guard !text.isEmpty else {
                // Only noise, or the orb's own words: keep listening.
                session.beginTurn()
                return listen()
            }
            // Your answer to "Should I send it to Meteor?". Anything but a clear yes sends nothing.
            if let offer {
                self.offer = nil
                switch TurnTaking.answer(text) {
                case .yes: return send(offer)
                case .no: return answer("Okay, I won't send it.")
                case .other: break
                }
            }
            ask(text)
        }
    }

    private func ask(_ text: String) {
        ui.voiceTurn = true
        awaitingReply = brain.items.count
        brain.ask(text)
        replyTimeout?.invalidate()
        replyTimeout = Timer.scheduledTimer(withTimeInterval: 45, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.awaitingReply != nil else { return }
                self.awaitingReply = nil
                self.ui.voiceTurn = false
                self.endConversation(saying: "Still working on it. The answer will show up in the Nierwall panel.")
            }
        }
    }

    /// The orb says the answer and keeps listening while it talks, so you can cut in. With something to sign, it
    /// asks whether to send it to Meteor, and your next turn answers that.
    private func answer(_ text: String, offering: Offer? = nil) {
        guard #available(macOS 26.0, *), let session, !text.isEmpty else { return }
        offer = offering
        let said = offering == nil ? text : "\(text) Should I send it to Meteor?"
        overlay.model.phase = .answer
        turns.orbSays(said, at: Date())
        session.beginTurn()
        session.say(said)
    }

    /// The first thing in a reply you could send to your wallet: a checked plan, or a fix that isn't hypothetical.
    private func sendable(_ cards: [Card]) -> Offer? {
        for card in cards {
            switch card {
            case .plan(let p) where p.steps.contains(where: { !$0.manual }): return Offer(id: p.planId, title: p.title)
            case .fix(let f) where !f.fix.notes.contains(where: { $0.contains("hypothetical") }): return Offer(id: f.fix.id, title: f.fix.title)
            default: continue
            }
        }
        return nil
    }

    /// You said yes: the brain opens the checked steps, re-quoting anything that moves money, and the page asks
    /// Meteor to sign each one as it becomes ready. You approve every step in Meteor; the orb says when it's done.
    private func send(_ offer: Offer) {
        overlay.model.phase = .thinking
        Task {
            if let error = await brain.review(fixId: offer.id, wallet: "meteor-wallet") { return answer("I couldn't open it. \(error)") }
            answer("Opening Meteor. Approve it there, and I'll tell you when it's done.")
        }
    }

    /// A signing session moved on: say when it's done, or when a step failed, once each.
    private func signUpdated(_ update: SignUpdate) {
        if update.done, told.insert("\(update.token):done").inserted {
            let health = update.healthAfter.map { String(format: " Rhea health should now be about %.2f.", $0) } ?? ""
            tell("Done: \(update.title).\(health)")
        }
        for step in update.steps where step.state == "failed" && told.insert("\(update.token):\(step.id)").inserted {
            tell("That didn't go through: \(step.title).")
        }
    }

    /// News about something you asked for: a notification, and spoken too if you're mid-conversation and not talking.
    private func tell(_ text: String) {
        notifier.postInfo(title: "Nierwall", body: text)
        if voice != nil, overlay.model.phase == .listening, !turns.hasSaid { answer(text) }
    }

    private func deliverReply(_ items: [ChatItem]) {
        guard let start = awaitingReply, items.count > start,
              let reply = items[start...].first(where: { $0.role == .assistant }) else { return }
        awaitingReply = nil
        replyTimeout?.invalidate()
        guard voice != nil else { return }
        // Something went wrong (the brain isn't running…): the panel says what.
        guard reply.via != nil else {
            endConversation(saying: "That didn't work. The details are in the Nierwall panel.")
            return showPanel(keepOverlay: true)
        }
        // Anything to click opens in the panel, and the conversation goes on.
        if reply.cards.contains(where: needsClick) { showPanel(keepOverlay: true) }
        // Not spoken (voice replies are off): it's in the panel, and it's your turn again.
        if overlay.model.phase == .thinking {
            if #available(macOS 26.0, *), let session { session.beginTurn() }
            listen()
            showPanel(keepOverlay: true)
        }
    }

    private func needsClick(_ card: Card) -> Bool {
        switch card {
        case .fix, .watchConfirm, .plan: return true
        default: return false
        }
    }

    /// Esc, ⌘⌥ before you've said anything, a long silence, or a problem: the mic goes off and the orb
    /// goes away, after saying `message` if there is one.
    private func endConversation(saying message: String? = nil) {
        if #available(macOS 26.0, *), let session { session.stop() }
        voice = nil
        offer = nil
        ui.listening = false
        guard let message else { return overlay.hide() }
        overlay.showMessage()
        speaker.say(message)
    }

    /// The orb went away: the conversation is over, and a late answer goes to the panel instead of being
    /// spoken out of nowhere.
    private func overlayClosed() {
        if #available(macOS 26.0, *), let session { session.stop() }
        voice = nil
        offer = nil
        ui.listening = false
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
