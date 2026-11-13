import { describe, expect, it } from "vitest";
import { combineSeverity, evaluate, isNearLimit } from "../src/watches/engine.js";
import { liquidationDrop } from "../src/protocols/risk.js";
import type { Snapshot, Watch } from "../src/types.js";

const watch = (kind: Watch["kind"], params: Record<string, unknown>): Watch => ({
  id: "w", kind, label: "test", params, status: "active", source: "user", createdAt: "", confirmedAt: "",
});
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  takenAt: "", prices: { ETH: { symbol: "ETH", usd: 1800, publishTime: 0, source: "aave-oracle", simulated: false } },
  positions: [{
    id: "rhea:NEAR wallet", protocol: "rhea", chain: "near", walletLabel: "NEAR wallet", collateral: [], debt: [],
    collateralUsd: 1000, debtUsd: 500, healthFactor: 1.4, liquidationDistance: 0.28, observedAt: "", simulated: false,
  }],
  balances: [{ walletLabel: "Cash", chain: "base", symbol: "USDC", amount: 2500, usd: 2500 }],
  errors: [], scenario: null, ...over,
});

describe("watch engine", () => {
  it("health below floor triggers, with critical below the midpoint", () => {
    expect(evaluate(watch("health_below", { positionId: "rhea:NEAR wallet", threshold: 1.5 }), snap()).triggered).toBe(true);
    const e = evaluate(watch("health_below", { positionId: "rhea:NEAR wallet", threshold: 1.9 }), snap());
    expect(e.severity).toBe("critical"); // 1.4 < 1 + (1.9 - 1) / 2 = 1.45
    expect(evaluate(watch("health_below", { positionId: "rhea:NEAR wallet", threshold: 1.3 }), snap()).triggered).toBe(false);
  });
  it("missing position is unknown, never safe", () => {
    const e = evaluate(watch("health_below", { positionId: "rhea:other", threshold: 1.5 }), snap());
    expect(e.unknown).toBe(true);
    expect(e.recovered).toBe(false);
  });
  it("recovery needs a 2% margin (hysteresis)", () => {
    const w = watch("health_below", { positionId: "rhea:NEAR wallet", threshold: 1.39 });
    expect(evaluate(w, snap()).recovered).toBe(false); // 1.40 < 1.39 * 1.02
  });
  it("an exact 10% drop fires a -10% price move watch", () => {
    const e = evaluate(watch("price_move", { symbol: "ETH", pct: -0.1, referencePrice: 2000 }), snap());
    expect(e.triggered).toBe(true);
  });
  it("price level and balance minimum", () => {
    expect(evaluate(watch("price_below", { symbol: "ETH", price: 1900 }), snap()).triggered).toBe(true);
    expect(evaluate(watch("balance_min", { walletLabel: "Cash", symbol: "USDC", amount: 3000 }), snap()).triggered).toBe(true);
  });
  it("a reserve counts every network, an empty balance is zero, and a failed read is unknown", () => {
    const reserve = watch("balance_min", { walletLabel: "Cash", symbol: "USDC", amount: 3000 });
    const twoNetworks = snap({ balances: [...snap().balances, { walletLabel: "Cash", chain: "arb", symbol: "USDC", amount: 1000, usd: 1000 }] });
    expect(evaluate(reserve, twoNetworks).triggered).toBe(false); // 2,500 on Base + 1,000 on Arbitrum
    const empty = evaluate(reserve, snap({ balances: [] }));
    expect([empty.unknown, empty.triggered]).toEqual([false, true]);
    expect(evaluate(reserve, snap({ errors: ["holdings:Cash:arb: timeout"] })).unknown).toBe(true);
  });
  it("near-limit speeds up checks", () => {
    expect(isNearLimit(evaluate(watch("health_below", { positionId: "rhea:NEAR wallet", threshold: 1.3 }), snap()))).toBe(true);
    expect(isNearLimit(evaluate(watch("health_below", { positionId: "rhea:NEAR wallet", threshold: 1.0 }), snap()))).toBe(false);
  });
  it("data errors trip the system watch", () => {
    expect(evaluate(watch("data_stale", {}), snap({ errors: ["rhea:x: timeout"] })).triggered).toBe(true);
  });
});

describe("liquidation distance", () => {
  it("single volatile collateral vs stable debt", () => {
    // weighted collateral 1400 in NEAR, debt 1000 stable -> health 1.4 -> drop 1 - 1/1.4
    const d = liquidationDrop("NEAR", [{ cls: "NEAR", value: 1400 }], [{ cls: "STABLE", value: 1000 }]);
    expect(d).toBeCloseTo(1 - 1 / 1.4, 10);
  });
  it("debt in the same asset cannot be liquidated by that asset falling alone", () => {
    expect(liquidationDrop("NEAR", [{ cls: "NEAR", value: 500 }], [{ cls: "NEAR", value: 600 }])).toBeNull();
  });
  it("stable collateral covering the debt means no liquidation from a fall", () => {
    expect(liquidationDrop("ETH", [{ cls: "ETH", value: 500 }, { cls: "STABLE", value: 2000 }], [{ cls: "STABLE", value: 1000 }])).toBeNull();
  });
});

describe("token watches (CoinGecko)", () => {
  it("watches any coin above, below or by a move, and never treats a missing price as safe", () => {
    const s = snap({ coins: { solana: { usd: 80, change24h: -3 } } });
    expect(evaluate(watch("price_below", { coinId: "solana", symbol: "SOL", price: 100 }), s).triggered).toBe(true);
    expect(evaluate(watch("price_above", { coinId: "solana", symbol: "SOL", price: 75 }), s).triggered).toBe(true);
    expect(evaluate(watch("price_above", { coinId: "solana", symbol: "SOL", price: 90 }), s).triggered).toBe(false);
    expect(evaluate(watch("price_move", { coinId: "solana", symbol: "SOL", pct: -0.2, referencePrice: 100 }), s).triggered).toBe(true);
    expect(evaluate(watch("price_below", { coinId: "pepe", symbol: "PEPE", price: 1 }), s).unknown).toBe(true);
  });
});

describe("AI severity with hard rails", () => {
  const ev = (kind: Watch["kind"], value: number, severity: "warning" | "critical" = "warning") =>
    ({ watch: watch(kind, {}), triggered: true, recovered: false, unknown: false, severity, value, title: "", detail: "" }) as Parameters<typeof combineSeverity>[0];
  it("uses the AI's call when there is one, the rule when there isn't", () => {
    expect(combineSeverity(ev("health_below", 1.25), { severity: "critical", reason: "NEAR is falling fast" })).toEqual({ severity: "critical", reason: "NEAR is falling fast" });
    expect(combineSeverity(ev("health_below", 1.25, "critical"), { severity: "warning", reason: "calm market" }).severity).toBe("warning");
    expect(combineSeverity(ev("health_below", 1.25, "critical"), null).severity).toBe("critical");
  });
  it("never lets the AI downplay a loan about to be liquidated", () => {
    expect(combineSeverity(ev("health_below", 1.08), { severity: "warning", reason: "calm" }).severity).toBe("critical");
    expect(combineSeverity(ev("liq_distance", 0.03), { severity: "warning", reason: "calm" }).severity).toBe("critical");
  });
});
