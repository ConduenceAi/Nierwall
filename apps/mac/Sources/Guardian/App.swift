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
    private let brain = BrainClient()
    private let ui = UIState()
    private let speaker = SpeechOutput()
    private let notifier = Notifier()
    private var hotKey: HotKey?
    private var speech: AnyObject?
    private var holdTimer: Timer?
    private var panelWasVisible = false
    private var bag = Set<AnyCancellable>()

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePanel)
        setIcon("shield", tint: nil)

        let actions = PanelActions(
            send: { [weak self] text in self?.ui.voiceTurn = false; self?.brain.ask(text) },
            toggleMic: { [weak self] in self?.toggleListening() },
            review: { [weak self] fixId in Task { if let err = await self?.brain.review(fixId: fixId) { self?.ui.notice = err } } },
            confirmWatch: { [weak self] id in Task { _ = await self?.brain.confirmWatch(id) } },
            snooze: { [weak self] id in Task { await self?.brain.snooze(id) } },
            linkTelegram: { [weak self] in Task { if let err = await self?.brain.linkTelegram() { self?.ui.notice = err } } }
        )
        panel = FloatingPanel(content: NSHostingView(rootView: PanelView(brain: brain, ui: ui, actions: actions)))

        brain.onAlert = { [weak self] alert, _ in
            guard alert.severity != "info" || true else { return }
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

        hotKey = HotKey()
        hotKey?.onDown = { [weak self] in self?.hotKeyDown() }
        hotKey?.onUp = { [weak self] in self?.hotKeyUp() }

        brain.connect()
    }

    // MARK: Panel

    @objc private func togglePanel() {
        panel.isVisible ? panel.orderOut(nil) : showPanel()
    }

    private func showPanel() {
        if let button = statusItem.button, let window = button.window {
            let rect = window.convertToScreen(button.convert(button.bounds, to: nil))
            let screen = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
            let x = min(rect.maxX - panel.frame.width + 12, screen.maxX - panel.frame.width - 8)
            panel.setFrameOrigin(NSPoint(x: max(screen.minX + 8, x), y: rect.minY - panel.frame.height - 6))
        }
        panel.makeKeyAndOrderFront(nil)
    }

    // MARK: Hotkey: hold to talk, tap to toggle the panel

    private func hotKeyDown() {
        panelWasVisible = panel.isVisible
        showPanel()
        holdTimer?.invalidate()
        holdTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.startListening() }
        }
    }

    private func hotKeyUp() {
        holdTimer?.invalidate()
        if ui.listening {
            stopListeningAndSend()
        } else if panelWasVisible {
            panel.orderOut(nil)
        }
    }

    // MARK: Voice

    private func toggleListening() {
        ui.listening ? stopListeningAndSend() : startListening()
    }

    private func startListening() {
        guard !ui.listening else { return }
        guard #available(macOS 26.0, *) else {
            ui.notice = "Voice needs macOS 26 or later. Typing works."
            return
        }
        speaker.stop()
        let input = SpeechInput()
        input.onTranscript = { [weak self] text in self?.ui.transcript = text }
        speech = input
        ui.listening = true
        ui.transcript = ""
        ui.notice = nil
        Task {
            do {
                try await input.start()
            } catch {
                ui.listening = false
                ui.notice = "Couldn't start listening: \(error.localizedDescription)"
            }
        }
    }

    private func stopListeningAndSend() {
        guard #available(macOS 26.0, *), let input = speech as? SpeechInput else { ui.listening = false; return }
        Task {
            let text = await input.stop()
            ui.listening = false
            ui.transcript = ""
            speech = nil
            if !text.isEmpty {
                ui.voiceTurn = true
                brain.ask(text)
            }
        }
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
