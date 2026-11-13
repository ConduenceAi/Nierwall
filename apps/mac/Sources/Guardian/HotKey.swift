import AppKit
import Carbon
import CoreGraphics

/// Press ⌘⌥ (both keys, nothing else) to talk: a tap, or a hold.
///
/// Carbon hotkeys can't be modifier-only, and a keyboard event tap would need the Input Monitoring
/// permission. So this checks the modifier state about 30 times a second instead, plus counters of key
/// presses and clicks: Nierwall never sees what you type. Any other key, modifier or click while ⌘⌥ are
/// down means it was a shortcut (⌘⌥Esc, ⌘⌥-drag…), and the press is ignored.
@MainActor
final class TalkKeys {
    /// ⌘⌥ tapped, or held for a moment.
    var onPress: (() -> Void)?
    /// Another key or a click while ⌘⌥ were still held after a press: it was a shortcut after all.
    var onInterrupted: (() -> Void)?

    private let holdDelay: TimeInterval = 0.35
    private var timer: DispatchSourceTimer?
    private var downAt: Date?
    private var holding = false
    private var spoiled = false
    private var keyCount: UInt32 = 0
    private var clickCount: UInt32 = 0
    /// Keeps App Nap from slowing the check down while the app sits in the menu bar.
    private let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep], reason: "Press ⌘⌥ to talk")

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
                onPress?()
            }
            return
        }

        // Released. A hold already counted; a quick clean tap counts now.
        let start = downAt!
        downAt = nil
        if holding {
            holding = false
        } else if !spoiled, keys == keyCount, clicks == clickCount, Date().timeIntervalSince(start) < holdDelay {
            onPress?()
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

/// Esc while the orb is open. The orb never takes keyboard focus (your typing keeps going to your app), so
/// Esc is registered as a system-wide shortcut, and only while the orb is open: everywhere else it works as
/// usual. Carbon shortcuts need no permission.
@MainActor
final class EscapeKey {
    var onPress: (() -> Void)?
    var isEnabled = false {
        didSet {
            guard isEnabled != oldValue else { return }
            if isEnabled {
                RegisterEventHotKey(UInt32(kVK_Escape), 0, EventHotKeyID(signature: escapeSignature, id: 1), GetApplicationEventTarget(), 0, &ref)
            } else if let ref {
                UnregisterEventHotKey(ref)
                self.ref = nil
            }
        }
    }
    private var ref: EventHotKeyRef?

    init() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            guard id.signature == escapeSignature, let context else { return OSStatus(eventNotHandledErr) }
            let key = Unmanaged<EscapeKey>.fromOpaque(context).takeUnretainedValue()
            MainActor.assumeIsolated { key.onPress?() } // Carbon events arrive on the main thread
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), nil)
    }
}

/// "NWes", so the handler knows the hotkey is ours.
private let escapeSignature: OSType = 0x4E57_6573
