import AppKit
import CoreGraphics

/// Hold ⌘⌥ (both keys, nothing else) to talk.
///
/// Carbon hotkeys can't be modifier-only, and a keyboard event tap would need the Input Monitoring
/// permission. So this checks the modifier state about 30 times a second instead, plus counters of key
/// presses and clicks: Nierwall never sees what you type. Any other key, modifier or click while ⌘⌥ are
/// down means it was a shortcut (⌘⌥Esc, ⌘⌥-drag…), and the hold is ignored.
@MainActor
final class TalkKeys {
    /// ⌘⌥ held long enough: start listening.
    var onHoldStart: (() -> Void)?
    /// Released after a hold: send.
    var onHoldEnd: (() -> Void)?
    /// Pressed and released quickly with nothing else.
    var onTap: (() -> Void)?
    /// Another key or a click during a hold: it was a shortcut, so cancel.
    var onInterrupted: (() -> Void)?

    private let holdDelay: TimeInterval = 0.35
    private var timer: DispatchSourceTimer?
    private var downAt: Date?
    private var holding = false
    private var spoiled = false
    private var keyCount: UInt32 = 0
    private var clickCount: UInt32 = 0
    /// Keeps App Nap from slowing the check down while the app sits in the menu bar.
    private let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep], reason: "Hold ⌘⌥ to talk")

    init() {
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now(), repeating: .milliseconds(30), leeway: .milliseconds(10))
        t.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.poll() } }
        t.resume()
        timer = t
    }

    private func poll() {
        let state = CGEventSourceStateID.combinedSessionState
        let flags = CGEventSource.flagsState(state)
        let both = flags.contains([.maskCommand, .maskAlternate])
        guard both || downAt != nil else { return }

        let extra = !flags.intersection([.maskShift, .maskControl, .maskSecondaryFn]).isEmpty
        let keys = CGEventSource.counterForEventType(state, eventType: .keyDown)
        let clicks = CGEventSource.counterForEventType(state, eventType: .leftMouseDown)
            &+ CGEventSource.counterForEventType(state, eventType: .rightMouseDown)
            &+ CGEventSource.counterForEventType(state, eventType: .otherMouseDown)

        if both {
            guard let start = downAt else {
                downAt = Date()
                holding = false
                spoiled = extra || NSEvent.pressedMouseButtons != 0
                keyCount = keys
                clickCount = clicks
                return
            }
            if extra || keys != keyCount || clicks != clickCount || NSEvent.pressedMouseButtons != 0 {
                spoil()
            } else if !holding, !spoiled, Date().timeIntervalSince(start) >= holdDelay {
                holding = true
                onHoldStart?()
            }
            return
        }

        // Released.
        let start = downAt!
        downAt = nil
        if holding {
            holding = false
            onHoldEnd?()
        } else if !spoiled, keys == keyCount, clicks == clickCount, Date().timeIntervalSince(start) < holdDelay {
            onTap?()
        }
    }

    private func spoil() {
        guard !spoiled else { return }
        spoiled = true
        if holding {
            holding = false
            onInterrupted?()
        }
    }
}
