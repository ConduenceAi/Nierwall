import AppKit

let app = NSApplication.shared
if let i = CommandLine.arguments.firstIndex(of: "--render-previews"), CommandLine.arguments.indices.contains(i + 1) {
    MainActor.assumeIsolated { OverlayPreviews.render(to: URL(fileURLWithPath: CommandLine.arguments[i + 1])) }
    exit(0)
}
let delegate = MainActor.assumeIsolated { AppDelegate() }
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
