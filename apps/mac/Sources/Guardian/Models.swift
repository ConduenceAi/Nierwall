import Foundation

// Mirrors apps/brain/src/ai/cards.ts and the WebSocket messages in apps/brain/src/api/server.ts.

struct Attestation: Decodable, Equatable {
    let model: String
    let verified: Bool
    let verifiedAt: String?
    let detail: String
}

struct BrainStatus: Decodable, Equatable {
    let lastRefresh: String?
    let openIncidents: Int
    let dataProblems: Int
    let telegramLinked: Bool
    let attestation: Attestation
    let state: String // loading | ok | attention | degraded
}

struct PositionCard: Decodable, Equatable, Identifiable {
    var id: String { positionId }
    let positionId: String
    let title: String
    let wallet: String
    let health: Double?
    let floor: Double?
    let liquidationDistance: Double?
    let collateralUsd: Double
    let debtUsd: Double
    let observedAt: String
    let simulated: Bool
}

struct AlertCard: Decodable, Equatable {
    let alertId: String
    let incidentId: String
    let severity: String
    let title: String
    let body: String
    let simulated: Bool
}

struct FixStep: Decodable, Equatable {
    let chain: String
    let wallet: String
    let description: String
}

struct FixOption: Decodable, Equatable, Identifiable {
    let id: String
    let kind: String
    let title: String
    let steps: [FixStep]
    let healthBefore: Double?
    let healthAfter: Double?
    let notes: [String]
    let rank: Int
}

struct FixCard: Decodable, Equatable {
    let alertId: String
    let fix: FixOption
}

struct WatchCard: Decodable, Equatable {
    let watchId: String
    let label: String
}

/// A plan the advisor proposed and the brain checked: steps, loan health and allocation before and after.
struct PlanCard: Decodable, Equatable {
    struct Step: Decodable, Equatable { let n: Int; let chain: String; let wallet: String; let description: String; let manual: Bool }
    struct Loan: Decodable, Equatable { let label: String; let before: Double?; let after: Double?; let floor: Double? }
    struct Share: Decodable, Equatable { let cls: String; let beforePct: Double; let afterPct: Double }
    let planId: String
    let title: String
    let goal: String
    let steps: [Step]
    let loans: [Loan]
    let allocation: [Share]
    let netWorthBefore: Double
    let netWorthAfter: Double
    let costUsd: Double
    let maxCostUsd: Double
    let costReason: String
    let warnings: [String]
    let simulated: Bool
}

enum Card: Decodable, Equatable, Identifiable {
    case position(PositionCard)
    case alert(AlertCard)
    case fix(FixCard)
    case watchConfirm(WatchCard)
    case plan(PlanCard)
    case other(String)

    var id: String {
        switch self {
        case .position(let p): return "p:\(p.positionId)"
        case .alert(let a): return "a:\(a.alertId)"
        case .fix(let f): return "f:\(f.fix.id)"
        case .watchConfirm(let w): return "w:\(w.watchId)"
        case .plan(let p): return "pl:\(p.planId)"
        case .other(let t): return "o:\(t)"
        }
    }

    private enum K: String, CodingKey { case type }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        switch try c.decode(String.self, forKey: .type) {
        case "position": self = .position(try PositionCard(from: decoder))
        case "alert": self = .alert(try AlertCard(from: decoder))
        case "fix": self = .fix(try FixCard(from: decoder))
        case "watch_confirm": self = .watchConfirm(try WatchCard(from: decoder))
        case "plan": self = .plan(try PlanCard(from: decoder))
        case let t: self = .other(t)
        }
    }
}

struct Reply: Decodable, Equatable {
    let text: String
    let speak: String
    let cards: [Card]
    let via: String
}

/// One entry in the panel's conversation.
struct ChatItem: Identifiable, Equatable {
    enum Role { case user, assistant, alert }
    let id = UUID()
    let role: Role
    let text: String
    var cards: [Card] = []
    var via: String? = nil
}

struct RuntimeInfo: Decodable {
    let port: Int
    let token: String
}
