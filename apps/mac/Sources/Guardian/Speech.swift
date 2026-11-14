import Accelerate
import AVFoundation
import Foundation
import Speech

/// One voice conversation's audio, all on the Mac: the microphone, Apple's on-device transcriber
/// (SpeechAnalyzer, macOS 26+) and the orb's voice. Audio never leaves the Mac.
///
/// The orb's voice plays through the same audio engine as the microphone, with Apple's echo cancellation
/// on, so the mic hears you rather than the orb, and you can talk over it. Where echo cancellation can't
/// run, the mic is ignored while the orb talks.
@available(macOS 26.0, *)
final class VoiceSession: @unchecked Sendable {
    /// Called on the main queue with what you've said so far this turn.
    var onTranscript: ((String) -> Void)?
    /// Called on the main queue with the microphone level, 0 (quiet) to 1 (loud), about 20 times a second.
    var onLevel: ((Double) -> Void)?
    /// Called on the main queue when the orb starts (true) and stops (false) talking.
    var onSpeakingChanged: ((Bool) -> Void)?
    /// Called on the main queue if the audio stops working mid-conversation.
    var onFailure: (() -> Void)?

    /// Echo cancellation is on: the mic stays open while the orb talks, so you can cut in.
    private(set) var echoCancelling = false

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let synth = AVSpeechSynthesizer()
    private let playFormat: AVAudioFormat
    private let lock = NSLock()
    private var analyzerFormat: AVAudioFormat?
    private var micConverter: AVAudioConverter?
    private var voiceConverter: AVAudioConverter?
    private var turn: Turn?
    private var stopped = false
    private var running = false
    private var tapInstalled = false
    private var configObserver: NSObjectProtocol?

    // What the orb is saying. Each say or stop bumps the id, so callbacks from older speech are ignored.
    private var speechID = 0
    private var started = false
    private var queued = 0
    private var rendered = false
    private var speaking = false

    private static let locale = Locale(identifier: "en-US")
    /// Domain words that generic dictation tends to get wrong.
    private static let vocabulary = ["Nierwall", "Rhea", "USDC", "NEAR", "NEAR Intents", "health factor", "wNEAR", "Base", "MetaMask", "Meteor"]

    init() {
        let settings = SpeechOutput.voice?.audioFileSettings ?? [:]
        let rate = (settings[AVSampleRateKey] as? NSNumber)?.doubleValue ?? 22050
        playFormat = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1) ?? AVAudioFormat(standardFormatWithSampleRate: 22050, channels: 1)!
    }

    /// Loads the speech model (downloaded once, the first time), turns the mic on and starts your first turn.
    func start() async throws {
        let transcriber = SpeechTranscriber(locale: Self.locale, preset: .progressiveTranscription)
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall() // first run only: installs Apple's on-device model
        }
        analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
        beginTurn(with: transcriber)
        try lock.withLock {
            if stopped { throw CancellationError() }
            try startEngine()
        }
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            self?.restart()
        }
    }

    /// Under the lock.
    private func startEngine() throws {
        let input = engine.inputNode
        echoCancelling = (try? input.setVoiceProcessingEnabled(true)) != nil
        if echoCancelling {
            // Music and calls keep their volume while the orb is open.
            input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
        }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        installTap()
        engine.prepare()
        do {
            try engine.start()
        } catch {
            guard echoCancelling else { throw error }
            // Some audio setups can't run echo cancellation. Go without: the mic is ignored while the orb talks.
            engine.stop()
            removeTap()
            try? input.setVoiceProcessingEnabled(false)
            echoCancelling = false
            installTap()
            engine.prepare()
            try engine.start()
        }
        running = true
    }

    private func installTap() {
        engine.inputNode.installTap(onBus: 0, bufferSize: 2048, format: nil) { [weak self] buffer, _ in
            self?.meter(buffer)
            self?.feed(buffer)
        }
        tapInstalled = true
    }

    private func removeTap() {
        guard tapInstalled else { return }
        engine.inputNode.removeTap(onBus: 0)
        tapInstalled = false
    }

    /// The audio devices changed (headphones plugged in, say) and the engine stopped: start again on the new
    /// ones. Whatever the orb was saying is cut off, and it's your turn.
    private func restart() {
        let ok = lock.withLock { () -> Bool in
            guard running, !engine.isRunning else { return true }
            removeTap()
            micConverter = nil
            installTap()
            engine.prepare()
            return (try? engine.start()) != nil
        }
        guard ok else {
            onFailure?()
            return
        }
        if lock.withLock({ speaking }) { stopSpeaking() }
    }

    // MARK: Listening

    /// A fresh turn: from now on the transcriber hears you, and nothing from before counts (the orb's voice,
    /// a cough before you started).
    func beginTurn() {
        beginTurn(with: SpeechTranscriber(locale: Self.locale, preset: .progressiveTranscription))
    }

    private func beginTurn(with transcriber: SpeechTranscriber) {
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
        let turn = Turn(analyzer: analyzer, input: input)
        turn.results = Task { [weak self] in
            do {
                for try await result in transcriber.results {
                    guard let self else { return }
                    let text = String(result.text.characters)
                    let full = self.lock.withLock { () -> String in
                        if result.isFinal { turn.finalText += text; turn.volatileText = "" } else { turn.volatileText = text }
                        return (turn.finalText + turn.volatileText).trimmingCharacters(in: .whitespaces)
                    }
                    DispatchQueue.main.async { if self.isCurrent(turn) { self.onTranscript?(full) } }
                }
            } catch {}
        }
        // The mic feeds the new turn from now on; audio waits in the stream until the analyzer is up.
        let (old, live) = lock.withLock { () -> (Turn?, Bool) in
            guard !stopped else { return (nil, false) }
            defer { self.turn = turn }
            return (self.turn, true)
        }
        old?.discard()
        guard live else { return turn.discard() }
        Task { [weak self] in
            let context = AnalysisContext()
            context.contextualStrings[.general] = Self.vocabulary
            try? await analyzer.setContext(context)
            do {
                try await analyzer.start(inputSequence: stream)
            } catch {
                guard let self, self.isCurrent(turn) else { return }
                DispatchQueue.main.async { self.onFailure?() }
            }
        }
    }

    /// Ends your turn and returns all you said. The mic stays on, but nothing is transcribed until the next turn.
    func endTurn() async -> String {
        guard let turn = lock.withLock({ () -> Turn? in
            defer { self.turn = nil }
            return self.turn
        }) else { return "" }
        turn.input.finish()
        try? await turn.analyzer.finalizeAndFinishThroughEndOfInput()
        _ = await turn.results?.value
        return lock.withLock { (turn.finalText + turn.volatileText).trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    private func isCurrent(_ turn: Turn) -> Bool {
        lock.withLock { self.turn === turn }
    }

    private func meter(_ buffer: AVAudioPCMBuffer) {
        guard let onLevel, let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        var rms: Float = 0
        vDSP_rmsqv(samples, 1, &rms, vDSP_Length(buffer.frameLength))
        let db = 20 * log10(max(rms, 1e-7))
        let level = Double(min(max((db + 50) / 40, 0), 1)) // -50 dB is a quiet room, -10 dB is loud speech
        DispatchQueue.main.async { onLevel(level) }
    }

    private func feed(_ buffer: AVAudioPCMBuffer) {
        // Without echo cancellation the mic would hear the orb, so it's ignored while the orb talks.
        guard let turn = lock.withLock({ speaking && !echoCancelling ? nil : self.turn }), let target = analyzerFormat else { return }
        if buffer.format == target {
            turn.input.yield(AnalyzerInput(buffer: buffer))
            return
        }
        if micConverter?.inputFormat != buffer.format {
            micConverter = AVAudioConverter(from: buffer.format, to: target)
            micConverter?.downmix = true
        }
        guard let micConverter, let out = Self.convert(buffer, with: micConverter) else { return }
        turn.input.yield(AnalyzerInput(buffer: out))
    }

    /// One buffer through a converter. The converter keeps its state between buffers of the same stream.
    private static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter) -> AVAudioPCMBuffer? {
        let format = converter.outputFormat
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var consumed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        return error == nil && out.frameLength > 0 ? out : nil
    }

    // MARK: The orb's voice

    /// Says `text` in the orb's voice, played through this engine so echo cancellation knows what to take
    /// out of the mic.
    func say(_ text: String) {
        let (id, live) = lock.withLock { () -> (Int, Bool) in
            speechID += 1
            started = false
            queued = 0
            rendered = false
            return (speechID, running)
        }
        synth.stopSpeaking(at: .immediate)
        if live { player.stop() }
        player.volume = 1
        synth.write(SpeechOutput.utterance(text)) { [weak self] buffer in self?.play(buffer, id) }
    }

    /// Stops the orb mid-sentence.
    func stopSpeaking() {
        let (was, live) = lock.withLock { () -> (Bool, Bool) in
            speechID += 1
            defer { speaking = false }
            return (speaking, running)
        }
        synth.stopSpeaking(at: .immediate)
        if live { player.stop() }
        if was { report(false) }
    }

    /// Turns the orb's voice down while you might be cutting in, or back up.
    func duck(_ down: Bool) {
        player.volume = down ? 0.25 : 1
    }

    private func play(_ buffer: AVAudioBuffer, _ id: Int) {
        guard let pcm = buffer as? AVAudioPCMBuffer else { return }
        guard pcm.frameLength > 0 else {
            // The last callback: all of it is rendered.
            let done = lock.withLock { () -> Bool in
                guard id == speechID else { return false }
                rendered = true
                return queued == 0
            }
            if done { finished(id) }
            return
        }
        guard let out = forPlayback(pcm) else { return }
        guard let (first, announce) = lock.withLock({ () -> (Bool, Bool)? in
            guard id == speechID, running else { return nil }
            queued += 1
            defer { started = true; speaking = true }
            return (!started, !speaking)
        }) else { return }
        player.scheduleBuffer(out, completionCallbackType: .dataPlayedBack) { [weak self] _ in self?.played(id) }
        if first, engine.isRunning { player.play() }
        if announce { report(true) }
    }

    private func forPlayback(_ pcm: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if pcm.format == playFormat { return pcm }
        if voiceConverter?.inputFormat != pcm.format {
            voiceConverter = AVAudioConverter(from: pcm.format, to: playFormat)
            voiceConverter?.downmix = true
        }
        return voiceConverter.flatMap { Self.convert(pcm, with: $0) }
    }

    private func played(_ id: Int) {
        let done = lock.withLock { () -> Bool in
            guard id == speechID else { return false }
            queued -= 1
            return queued == 0 && rendered
        }
        if done { finished(id) }
    }

    /// The orb finished saying something, or couldn't say it: tell the conversation, once.
    private func finished(_ id: Int) {
        let current = lock.withLock { () -> Bool in
            guard id == speechID else { return false }
            speechID += 1
            speaking = false
            return true
        }
        if current { report(false) }
    }

    private func report(_ speaking: Bool) {
        DispatchQueue.main.async { self.onSpeakingChanged?(speaking) }
    }

    /// Ends the conversation: the mic and the orb's voice go off.
    func stop() {
        let turn = lock.withLock { () -> Turn? in
            stopped = true
            running = false
            speechID += 1
            speaking = false
            defer { self.turn = nil }
            return self.turn
        }
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        synth.stopSpeaking(at: .immediate)
        if engine.isRunning {
            player.stop()
            engine.stop()
        }
        lock.withLock { removeTap() }
        if echoCancelling { try? engine.inputNode.setVoiceProcessingEnabled(false) }
        turn?.discard()
    }

    /// One of your turns: a transcriber, fed from the mic until you pause.
    private final class Turn: @unchecked Sendable {
        let analyzer: SpeechAnalyzer
        let input: AsyncStream<AnalyzerInput>.Continuation
        var results: Task<Void, Never>?
        var finalText = ""
        var volatileText = ""

        init(analyzer: SpeechAnalyzer, input: AsyncStream<AnalyzerInput>.Continuation) {
            self.analyzer = analyzer
            self.input = input
        }

        /// Drops the turn without waiting for its transcript.
        func discard() {
            input.finish()
            results?.cancel()
            let analyzer = analyzer
            Task { await analyzer.cancelAndFinishNow() }
        }
    }
}

/// The orb's voice outside a conversation, for a last word like "I couldn't start listening."
/// Used from the main thread only; delegate callbacks hop to the main queue.
final class SpeechOutput: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    /// The best installed English voice.
    static let voice: AVSpeechSynthesisVoice? = {
        let english = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }
        return english.first { $0.quality == .premium } ?? english.first { $0.quality == .enhanced } ?? AVSpeechSynthesisVoice(language: "en-US")
    }()

    static func utterance(_ text: String) -> AVSpeechUtterance {
        let u = AVSpeechUtterance(string: text)
        u.voice = voice
        u.rate = AVSpeechUtteranceDefaultSpeechRate * 1.04
        return u
    }

    private let synth = AVSpeechSynthesizer()
    var enabled = true
    /// Called on the main queue when speech starts (true) and ends (false).
    var onSpeakingChanged: ((Bool) -> Void)?

    override init() {
        super.init()
        synth.delegate = self
    }

    func say(_ text: String) {
        guard enabled, !text.isEmpty else { return }
        synth.stopSpeaking(at: .immediate)
        synth.speak(Self.utterance(text))
    }

    func stop() { synth.stopSpeaking(at: .immediate) }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) { report(true) }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { report(false) }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { report(false) }

    private func report(_ speaking: Bool) {
        DispatchQueue.main.async { self.onSpeakingChanged?(speaking) }
    }
}
