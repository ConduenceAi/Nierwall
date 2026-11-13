import { describe, expect, it } from "vitest";
import { allocationOf, assetClass, checkPlan, type PlanContext, type PlanInput } from "../src/advisor/plans.js";
import type { Holding } from "../src/holdings.js";
import type { TokenInfo } from "../src/tokens.js";
import type { LendingPosition, Watch } from "../src/types.js";

const tok = (chain: "base" | "near", symbol: string, price: number, contract: string | null, decimals = 6): TokenInfo => ({
  chain, symbol, decimals, assetId: `${chain}:${symbol}`, contract, coingeckoId: null, priceUsd: price,
});
const tokens = [
  tok("base", "ETH", 2000, null, 18),
  tok("base", "USDC", 1, "0xusdc"),
  tok("near", "NEAR", 3.5, null, 24),
  tok("near", "wNEAR", 3.5, "wrap.near", 24),
  tok("near", "USDC", 1, "usdc.near"),
];
const holding = (walletLabel: string, chain: "base" | "near", symbol: string, amount: number): Holding => {
  const token = tokens.find((t) => t.chain === chain && t.symbol === symbol)!;
  return { walletLabel, chain, symbol, amount, usd: amount * token.priceUsd!, token, simulated: false };
};
// Rhea loan: 4,000 wNEAR collateral (weight 0.6) against 7,000 USDC (weight 0.95) → health 1.14.
const rheaLoan: LendingPosition = {
  id: "rhea:Savings", protocol: "rhea", chain: "near", walletLabel: "Savings",
  collateral: [{ token: "wrap.near", symbol: "wNEAR", amount: 4000, usd: 14000, weight: 0.6 }],
  debt: [{ token: "usdc.near", symbol: "USDC", amount: 7000, usd: 7000, weight: 0.95 }],
  collateralUsd: 14000, debtUsd: 7000, healthFactor: 1.14, liquidationDistance: 0.12, observedAt: "", simulated: false,
};
const watch = (kind: Watch["kind"], params: Record<string, unknown>): Watch => ({ id: kind, kind, label: "", params, status: "active", source: "user", createdAt: "", confirmedAt: "" });

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  return {
    wallets: { wallets: [{ label: "Cash", chain: "base", address: "0xabc", role: "" }, { label: "Savings", chain: "near", address: "you.near", role: "" }], watchAave: [], watchRhea: ["Savings"] },
    positions: [rheaLoan],
    aave: new Map(),
    rheaToken: () => null,
    holdings: [holding("Cash", "base", "USDC", 5000), holding("Cash", "base", "ETH", 1), holding("Savings", "near", "NEAR", 100)],
    tokens,
    watches: [watch("health_below", { positionId: "rhea:Savings", threshold: 1.3 }), watch("balance_min", { walletLabel: "Cash", symbol: "USDC", amount: 1000 })],
    protectedWallets: [],
    // A fair price minus 0.2%, with 1% slippage allowed.
    quote: async (from, to, amount) => {
      const expectedOut = ((amount * from.priceUsd!) / to.priceUsd!) * 0.998;
      return { expectedOut, minOut: expectedOut * 0.99, timeEstimate: 30 };
    },
    simulated: false,
    ...over,
  };
}
const plan = (actions: PlanInput["actions"], maxCostUsd = 100): PlanInput => ({ title: "Test plan", goal: "", actions, maxCostUsd, costReason: "" });

describe("plan checker", () => {
  it("moving cash to NEAR and repaying raises Rhea health", async () => {
    const r = await checkPlan(plan([
      { type: "move", fromWallet: "Cash", toWallet: "Savings", token: "USDC", amount: 3000 },
      { type: "repay", wallet: "Savings", protocol: "rhea", token: "USDC", amount: 2900 },
    ]), ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const loan = r.plan.loans.find((l) => l.positionId === "rhea:Savings")!;
    expect(loan.before).toBeCloseTo(1.14, 2);
    expect(loan.after!).toBeCloseTo((4000 * 3.5 * 0.6) / (4100 / 0.95), 6);
    expect(r.plan.steps.map((s) => s.execution)).toEqual(["sign", "sign"]);
    expect(r.plan.warnings.some((w) => w.includes("links the two wallets"))).toBe(true);
  });

  it("rejects a plan that costs more than the advisor allowed", async () => {
    // A 3,000 USDC move loses about $6 to the 0.2% spread.
    const cheap = await checkPlan(plan([{ type: "move", fromWallet: "Cash", toWallet: "Savings", token: "USDC", amount: 3000 }], 2), ctx());
    expect(cheap.ok).toBe(false);
    if (!cheap.ok) expect(cheap.errors.join(" ")).toContain("more than the $2 allowed");
    const ok = await checkPlan(plan([{ type: "move", fromWallet: "Cash", toWallet: "Savings", token: "USDC", amount: 3000 }], 10), ctx());
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.plan.costUsd).toBeCloseTo(6, 1);
  });

  it("only counts the guaranteed minimum from a swap", async () => {
    // 2,970 USDC is guaranteed from 3,000; repaying 2,990 would need more than that.
    const r = await checkPlan(plan([
      { type: "move", fromWallet: "Cash", toWallet: "Savings", token: "USDC", amount: 3000 },
      { type: "repay", wallet: "Savings", protocol: "rhea", token: "USDC", amount: 2990 },
    ]), ctx());
    expect(r.ok).toBe(false);
  });

  it("keeps the user's reserve", async () => {
    const r = await checkPlan(plan([{ type: "move", fromWallet: "Cash", toWallet: "Savings", token: "USDC", amount: 4500 }]), ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("reserve");
  });

  it("refuses a withdrawal that brings a loan near liquidation", async () => {
    const r = await checkPlan(plan([{ type: "withdraw", wallet: "Savings", protocol: "rhea", token: "wNEAR", percent: 20 }]), ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("too close to liquidation");
  });

  it("says when a loan improves but stays under the user's floor", async () => {
    // Repaying 500 lifts health from 1.14 to 1.23, still under the 1.30 floor.
    const r = await checkPlan(plan([
      { type: "move", fromWallet: "Cash", toWallet: "Savings", token: "USDC", amount: 1000 },
      { type: "repay", wallet: "Savings", protocol: "rhea", token: "USDC", amount: 500 },
    ]), ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.warnings.join(" ")).toContain("stays below your floor");
  });

  it("can't spend what a wallet doesn't hold, or move funds out of a protected wallet", async () => {
    const tooMuch = await checkPlan(plan([{ type: "swap", wallet: "Cash", from: "ETH", to: "USDC", amount: 2 }]), ctx());
    expect(tooMuch.ok).toBe(false);
    const prot = await checkPlan(plan([{ type: "swap", wallet: "Cash", from: "ETH", to: "USDC", amount: 0.5 }]), ctx({ protectedWallets: ["Cash"] }));
    expect(prot.ok).toBe(false);
    if (!prot.ok) expect(prot.errors.join(" ")).toContain("protected");
  });

  it("only knows the user's own wallets and needs one clear amount", async () => {
    const stranger = await checkPlan(plan([{ type: "move", fromWallet: "Cash", toWallet: "0xdeadbeef", token: "USDC", amount: 10 }]), ctx());
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.errors.join(" ")).toContain("unknown wallet");
    const unclear = await checkPlan(plan([{ type: "swap", wallet: "Cash", from: "ETH", to: "USDC", amount: 0.1, percent: 10 }]), ctx());
    expect(unclear.ok).toBe(false);
  });

  it("keeps gas money: a percent of native NEAR leaves some behind", async () => {
    const r = await checkPlan(plan([{ type: "swap", wallet: "Savings", from: "NEAR", to: "USDC", percent: 100 }]), ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.steps[0]!.amount).toBeCloseTo(99.95, 6);
  });
});

describe("allocation", () => {
  it("nets loan debt against holdings by asset class", () => {
    const a = allocationOf([holding("Cash", "base", "USDC", 5000), holding("Savings", "near", "NEAR", 100)], [rheaLoan]);
    const usd = Object.fromEntries(a.classes.map((c) => [c.cls, c.usd]));
    expect(usd.stable).toBe(5000 - 7000);
    expect(usd.NEAR).toBe(350 + 14000);
    expect(a.netWorthUsd).toBe(5000 + 350 + 14000 - 7000);
  });
  it("classes", () => {
    expect([assetClass("cbBTC"), assetClass("WETH"), assetClass("stNEAR"), assetClass("USDT"), assetClass("AURORA")]).toEqual(["BTC", "ETH", "NEAR", "stable", "other"]);
  });
});
