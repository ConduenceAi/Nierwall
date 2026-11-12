import { describe, expect, it } from "vitest";
import { evaluate, isNearLimit } from "../src/watches/engine.js";
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
