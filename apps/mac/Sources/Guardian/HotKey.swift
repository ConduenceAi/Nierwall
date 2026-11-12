import Carbon
import Foundation

/// Global hotkey with separate key-down and key-up events, so holding it can mean "talk".
/// Default ⌘⇧Space: since Sequoia, macOS rejects global shortcuts that use only ⌥ or ⇧.
final class HotKey {
    var onDown: (() -> Void)?
    var onUp: (() -> Void)?
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?

    init(keyCode: UInt32 = UInt32(kVK_Space), modifiers: UInt32 = UInt32(cmdKey | shiftKey)) {
        var types = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        let me = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let event, let userData else { return noErr }
            let hotKey = Unmanaged<HotKey>.fromOpaque(userData).takeUnretainedValue()
            let kind = GetEventKind(event)
            DispatchQueue.main.async {
                if kind == UInt32(kEventHotKeyPressed) { hotKey.onDown?() } else if kind == UInt32(kEventHotKeyReleased) { hotKey.onUp?() }
            }
            return noErr
        }, 2, &types, me, &handler)
        let id = EventHotKeyID(signature: OSType(0x4752_4431), id: 1) // "GRD1"
        RegisterEventHotKey(keyCode, modifiers, id, GetApplicationEventTarget(), 0, &ref)
    }

    deinit {
        if let ref { UnregisterEventHotKey(ref) }
        if let handler { RemoveEventHandler(handler) }
    }
}
