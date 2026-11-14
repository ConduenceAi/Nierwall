import Foundation

/// Turn-taking in a voice conversation: when you've finished talking, and when you're talking over the orb.
///
/// It's fed the mic level about 20 times a second and the transcript about once a second (Apple's
/// transcriber updates in bursts, so the level is what tells a pause; the words back it up). Pure logic,
/// so it can be checked without a microphone.
struct TurnTaking {
    enum Event: Equatable {
        /// You may be talking over the orb: turn it down while your words come in.
        case duck
        /// You weren't: back up.
        case unduck
        /// You talked over the orb: it stops, and it's your turn.
        case cutIn
        /// You paused after saying something: send it.
        case send
        /// You said nothing for a while: the conversation is over.
        case giveUp
    }

    /// Quiet this long after you've said something ends your turn…
    static let pause: TimeInterval = 1.1
    /// …or this long when your last word says more is coming ("and", "um", "my").
    static let thinkingPause: TimeInterval = 2.2
    /// A noisy room never goes quiet, so no new words for this long ends your turn too.
    static let noNewWords: TimeInterval = 3.2
    /// Nothing said this long and the conversation ends.
    static let idle: TimeInterval = 8
    /// The longest a turn can run.
    static let longest: TimeInterval = 45

    private(set) var orbTalking = false
    private var started = Date.distantPast
    private var lastVoice: Date?
    private var loudSince: Date?
    private var duckedAt: Date?
    private var lastChange = Date.distantPast
    private var transcript = ""
    private var heard: [String] = []
    /// What the orb is saying, to tell its echo from you.
    private var spoken: Set<String> = []
    /// How many words were heard while the orb was still talking (some may be its echo).
    private var heardWhileTalking = 0
    /// The room's own level, kept across turns, so a fan isn't mistaken for you talking.
    private var noise: Double?

    /// What you've said this turn.
    var said: String { cleaned(transcript) }
    var hasSaid: Bool { !said.isEmpty }

    /// `text` without the orb's own words the mic caught while it was talking.
    func cleaned(_ text: String) -> String {
        Self.withoutEcho(text, spoken: spoken, upTo: heardWhileTalking)
    }

    /// Your turn starts, fresh.
    mutating func listen(at now: Date) {
        orbTalking = false
        spoken = []
        heardWhileTalking = 0
        reset(at: now)
    }

    /// The orb starts saying `text`. The mic stays on, so you can talk over it.
    mutating func orbSays(_ text: String, at now: Date) {
        orbTalking = true
        spoken = Self.vocabulary(of: text)
        heardWhileTalking = 0
        reset(at: now)
    }

    /// You talked over the orb: your turn, keeping what you've said so far.
    mutating func cutIn(at now: Date) {
        orbTalking = false
        heardWhileTalking = Self.tokens(transcript).count
        started = now
        lastVoice = now
        lastChange = now
        loudSince = nil
        duckedAt = nil
    }

    private mutating func reset(at now: Date) {
        started = now
        lastVoice = nil
        loudSince = nil
        duckedAt = nil
        lastChange = now
        transcript = ""
        heard = []
    }

    /// The mic level, 0 (quiet) to 1 (loud).
    mutating func level(_ level: Double, at now: Date) -> Event? {
        // Follows the quietest the room gets, rising slowly, so steady noise stops counting as voice.
        let floor = noise.map { level < $0 ? level : $0 + (level - $0) * 0.02 } ?? level
        noise = floor

        if orbTalking {
            // Only clearly louder than the room and the orb's leftover echo.
            loudSince = level > max(0.45, floor + 0.2) ? (loudSince ?? now) : nil
            if let since = loudSince, duckedAt == nil, now.timeIntervalSince(since) >= 0.3 {
                duckedAt = now
                return .duck
            }
            if let at = duckedAt, loudSince == nil, now.timeIntervalSince(at) >= 1.5 {
                duckedAt = nil
                return .unduck
            }
            return nil
        }

        if level > max(0.3, floor + 0.12) { lastVoice = now }
        let quiet = now.timeIntervalSince(lastVoice ?? started)
        let elapsed = now.timeIntervalSince(started)
        guard hasSaid else {
            return (elapsed >= Self.idle && quiet >= 2) || elapsed >= Self.longest ? .giveUp : nil
        }
        let pause = Self.moreToCome(heard.last) ? Self.thinkingPause : Self.pause
        if quiet >= pause || now.timeIntervalSince(lastChange) >= Self.noNewWords || elapsed >= Self.longest {
            return .send
        }
        return nil
    }

    /// The transcript so far this turn.
    mutating func transcript(_ text: String, at now: Date) -> Event? {
        let words = Self.words(text)
        if words != heard {
            heard = words
            lastChange = now
        }
        transcript = text
        guard orbTalking else { return nil }
        let yours = words.filter { !spoken.contains($0) }
        return yours.count >= 2 || yours.contains(where: Self.stopWords.contains) ? .cutIn : nil
    }

    // MARK: Yes or no

    enum Answer: Equatable { case yes, no, other }

    /// Your answer when the orb asks "Should I send it to Meteor?". Only a short, clear yes counts as yes: "yes, but
    /// first…" or a new question is something else, and nothing is sent.
    static func answer(_ text: String) -> Answer {
        let w = words(text)
        guard let first = w.first else { return .other }
        let two = w.prefix(2).joined(separator: " ")
        if w.contains(where: ["but", "wait", "first", "not", "don", "dont", "cancel", "stop"].contains) {
            return no.contains(first) || noPhrases.contains(two) || w.contains("cancel") ? .no : .other
        }
        if no.contains(first) || noPhrases.contains(two) { return .no }
        guard w.count <= 6 else { return .other }
        return yes.contains(first) || yesPhrases.contains(two) ? .yes : .other
    }

    private static let yes: Set<String> = ["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "confirm", "absolutely", "definitely", "please"]
    private static let yesPhrases: Set<String> = ["do it", "go ahead", "send it", "go for", "sounds good", "let s", "of course"]
    private static let no: Set<String> = ["no", "nope", "nah", "cancel", "stop", "don", "dont", "never"]
    private static let noPhrases: Set<String> = ["not now", "hold off", "not yet"]

    // MARK: Words

    /// Said on their own over the orb, these stop it.
    static let stopWords: Set<String> = ["stop", "wait", "pause", "hold", "actually", "nierwall"]

    /// A turn that ends on one of these probably isn't finished.
    static let unfinished: Set<String> = [
        "and", "or", "but", "so", "because", "um", "uh", "the", "a", "an", "my", "your", "to", "of", "for",
        "with", "about", "is", "if", "like", "what", "how", "should", "can", "i", "on", "in", "at", "from",
        "into", "than", "then",
    ]

    static func moreToCome(_ word: String?) -> Bool { word.map(unfinished.contains) ?? false }

    /// Lowercased words without punctuation: "What's 1.41?" → what, s, 1, 41.
    static func words(_ text: String) -> [String] {
        text.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
    }

    static func tokens(_ text: String) -> [Substring] {
        text.split(whereSeparator: \.isWhitespace)
    }

    /// Every word the orb will say, with numbers also as spoken ("1.41" → one point four one).
    static func vocabulary(of text: String) -> Set<String> {
        var all = Set(words(text))
        let speller = NumberFormatter()
        speller.numberStyle = .spellOut
        speller.locale = Locale(identifier: "en_US")
        for token in tokens(text) {
            let number = token.filter { $0.isNumber || $0 == "." }.trimmingCharacters(in: CharacterSet(charactersIn: "."))
            if let value = Double(number), let spelled = speller.string(from: NSNumber(value: value)) {
                all.formUnion(words(spelled))
            }
        }
        return all.union(["percent", "dollar", "dollars", "cents", "point", "minus"])
    }

    /// `text` without its leading words that the orb itself said, looking only at the first `limit` words:
    /// those were heard while it was talking, so they may be its echo. Anything after was heard once it stopped.
    static func withoutEcho(_ text: String, spoken: Set<String>, upTo limit: Int) -> String {
        let tokens = tokens(text)
        var start = 0
        while start < min(limit, tokens.count), words(String(tokens[start])).allSatisfy(spoken.contains) {
            start += 1
        }
        return tokens[start...].joined(separator: " ")
    }
}
