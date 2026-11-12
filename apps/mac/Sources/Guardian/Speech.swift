import AVFoundation
import Foundation
import Speech

/// On-device speech to text with Apple's SpeechAnalyzer (macOS 26+). Audio never leaves the Mac.
@available(macOS 26.0, *)
final class SpeechInput: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private var analyzer: SpeechAnalyzer?
    private var continuation: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?
    private var converter: AVAudioConverter?
    private var targetFormat: AVAudioFormat?
    private var finalText = ""
    private var volatileText = ""
    private let lock = NSLock()

    /// Called on the main queue with the running transcript.
    var onTranscript: ((String) -> Void)?

    /// Domain words that generic dictation tends to get wrong.
    private let vocabulary = ["Nierwall", "Rhea", "Aave", "USDC", "NEAR", "NEAR Intents", "health factor", "wNEAR", "Base", "MetaMask"]

    func start() async throws {
        finalText = ""
        volatileText = ""
        let transcriber = SpeechTranscriber(locale: Locale(identifier: "en-US"), preset: .progressiveTranscription)
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall() // first run only: installs Apple's on-device model
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let context = AnalysisContext()
        context.contextualStrings[.general] = vocabulary
        try? await analyzer.setContext(context)
        targetFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])

        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        self.continuation = continuation
        resultsTask = Task { [weak self] in
            do {
                for try await result in transcriber.results {
                    guard let self else { return }
                    let text = String(result.text.characters)
                    let full = self.lock.withLock { () -> String in
                        if result.isFinal { self.finalText += text; self.volatileText = "" } else { self.volatileText = text }
                        return (self.finalText + self.volatileText).trimmingCharacters(in: .whitespaces)
                    }
                    DispatchQueue.main.async { self.onTranscript?(full) }
                }
            } catch {}
        }
        try await analyzer.start(inputSequence: stream)
        self.analyzer = analyzer

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        if let targetFormat, targetFormat != inputFormat {
            converter = AVAudioConverter(from: inputFormat, to: targetFormat)
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            self?.feed(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    private func feed(_ buffer: AVAudioPCMBuffer) {
        guard let continuation else { return }
        guard let converter, let targetFormat else {
            continuation.yield(AnalyzerInput(buffer: buffer))
            return
        }
        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }
        var consumed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if error == nil, out.frameLength > 0 { continuation.yield(AnalyzerInput(buffer: out)) }
    }

    /// Stops listening and returns the final transcript.
    func stop() async -> String {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        continuation?.finish()
        continuation = nil
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
        _ = await resultsTask?.value
        analyzer = nil
        return lock.withLock { (finalText + volatileText).trimmingCharacters(in: .whitespacesAndNewlines) }
    }
}

/// On-device text to speech. Picks the best installed English voice.
final class SpeechOutput {
    private let synth = AVSpeechSynthesizer()
    private lazy var voice: AVSpeechSynthesisVoice? = {
        let english = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }
        return english.first { $0.quality == .premium } ?? english.first { $0.quality == .enhanced } ?? AVSpeechSynthesisVoice(language: "en-US")
    }()
    var enabled = true

    func say(_ text: String) {
        guard enabled, !text.isEmpty else { return }
        synth.stopSpeaking(at: .immediate)
        let u = AVSpeechUtterance(string: text)
        u.voice = voice
        u.rate = AVSpeechUtteranceDefaultSpeechRate * 1.04
        synth.speak(u)
    }

    func stop() { synth.stopSpeaking(at: .immediate) }
}
