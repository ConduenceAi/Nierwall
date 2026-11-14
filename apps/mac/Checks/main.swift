import Foundation

// Turn-taking without a microphone: scripted mic levels (20 a second) and transcripts (in bursts, the way
// Apple's transcriber sends them). Run with scripts/check.sh.

var failures = 0

func check(_ ok: Bool, _ what: String) {
    print(ok ? "  ok   \(what)" : "  FAIL \(what)")
    if !ok { failures += 1 }
}

let t0 = Date(timeIntervalSince1970: 1_000_000)

/// Plays `seconds` of audio and returns the first event that ends or hands over the turn, with its time.
func play(_ turns: inout TurnTaking, seconds: Double, level: (Double) -> Double, words: [(Double, String)]) -> (at: Double, event: TurnTaking.Event)? {
    var pending = words
    var s = 0.0
    while s <= seconds {
        let now = t0.addingTimeInterval(s)
        while let w = pending.first, w.0 <= s {
            pending.removeFirst()
            if let e = turns.transcript(w.1, at: now), e == .cutIn { return (s, e) }
        }
        if let e = turns.level(level(s), at: now), e == .send || e == .giveUp { return (s, e) }
        s += 0.05
    }
    return nil
}

func near(_ result: (at: Double, event: TurnTaking.Event)?, _ event: TurnTaking.Event, at expected: Double, within: Double = 0.15) -> Bool {
    guard let result else { return false }
    return result.event == event && abs(result.at - expected) < within
}

/// Talking from 0.5 s to 2.6 s, with the dips between syllables.
let question: (Double) -> Double = { s in (s >= 0.5 && s <= 2.6) ? (Int(s * 20) % 7 == 0 ? 0.35 : 0.65) : 0.05 }

print("You ask, then pause")
var a = TurnTaking()
a.listen(at: t0)
check(near(play(&a, seconds: 10, level: question, words: [(1.5, "What is my"), (2.5, "What is my Rhea health factor"), (3.5, "What is my Rhea health factor right now?")]), .send, at: 3.7), "sends about 1.1 s after you stop")
check(a.said == "What is my Rhea health factor right now?", "keeps what you said")

print("You trail off on \"and\"")
var b = TurnTaking()
b.listen(at: t0)
check(near(play(&b, seconds: 10, level: question, words: [(1.5, "Move my USDC"), (2.5, "Move my USDC to savings and")]), .send, at: 4.8), "waits about 2.2 s instead")

print("You say nothing")
var c = TurnTaking()
c.listen(at: t0)
check(near(play(&c, seconds: 12, level: { _ in 0.05 }, words: []), .giveUp, at: 8, within: 0.1), "the conversation ends after 8 s")

print("A fan hums under your voice")
var d = TurnTaking()
d.listen(at: t0)
let fan: (Double) -> Double = { s in (s >= 0.3 && s <= 2.2) ? (Int(s * 20) % 6 == 0 ? 0.58 : 0.78) : 0.5 + 0.02 * sin(s * 9) }
check(near(play(&d, seconds: 12, level: fan, words: [(1.0, "What about"), (2.0, "What about my Base"), (3.0, "What about my Base wallet?")]), .send, at: 3.3, within: 0.2), "still sends about 1.1 s after you stop")

print("Music with vocals never goes quiet")
var m = TurnTaking()
m.listen(at: t0)
check(near(play(&m, seconds: 12, level: { s in 0.4 + 0.35 * abs(sin(s * 3)) }, words: [(1.0, "What about"), (2.0, "What about my Base wallet?")]), .send, at: 5.2, within: 0.2), "no new words for 3.2 s ends the turn")

print("The orb talks")
var o = TurnTaking()
o.orbSays("Your Rhea health factor is 1.41, close to your floor of 1.3.", at: t0)
check(o.transcript("health factor is", at: t0) == nil, "its own words (echo) don't cut it off")
check(o.transcript("health factor is one point four one", at: t0) == nil, "nor its numbers, spoken")
check(o.transcript("health factor is one point four one wait", at: t0) == .cutIn, "\"wait\" cuts it off")

var o2 = TurnTaking()
o2.orbSays("Your Rhea health factor is 1.41, close to your floor of 1.3.", at: t0)
_ = o2.transcript("health factor is", at: t0)
check(o2.transcript("health factor is what about Base", at: t0) == .cutIn, "two words of yours cut it off")
o2.cutIn(at: t0)
_ = o2.transcript("health factor is what about Base wallet", at: t0)
check(o2.said == "what about Base wallet", "and only your words are kept")
check(o2.cleaned("Health factor is. What about my Base wallet?") == "What about my Base wallet?", "in the final transcript too")

var q = TurnTaking()
q.orbSays("Your Rhea health factor is 1.41.", at: t0)
var events: [(Double, TurnTaking.Event)] = []
var s = 0.0
while s < 4 {
    if let e = q.level((s >= 1 && s < 1.6) ? 0.8 : 0.08, at: t0.addingTimeInterval(s)) { events.append((s, e)) }
    s += 0.05
}
check(events.map(\.1) == [.duck, .unduck] && abs(events[0].0 - 1.3) < 0.1, "a loud voice turns it down, and it comes back up if no words follow")

print("Words")
check(TurnTaking.vocabulary(of: "Repay $1,200 to stay above 20%").isSuperset(of: ["one", "thousand", "two", "hundred", "twenty", "percent"]), "numbers count in both forms")
check(TurnTaking.withoutEcho("what about base", spoken: ["what"], upTo: 0) == "what about base", "nothing is stripped from a fresh turn")

print("\"Should I send it to Meteor?\"")
for yes in ["Yes", "yeah, send it", "Go ahead.", "let's do it", "OK", "sure, do it"] {
    check(TurnTaking.answer(yes) == .yes, "\"\(yes)\" sends it")
}
for no in ["No", "not now", "don't send it", "cancel", "nope, leave it"] {
    check(TurnTaking.answer(no) == .no, "\"\(no)\" doesn't")
}
for other in ["yes, but first what's the fee?", "wait", "what would my health be after that?", "yes I think so but let me check my balance on Arbitrum first please"] {
    check(TurnTaking.answer(other) == .other, "\"\(other)\" is a new question, and nothing is sent")
}

print(failures == 0 ? "All turn-taking checks passed." : "\(failures) turn-taking check(s) failed.")
exit(failures == 0 ? 0 : 1)
