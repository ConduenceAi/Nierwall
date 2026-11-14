import { describe, expect, it, vi } from "vitest";
import type { TokenInfo } from "../src/tokens.js";

// Offline prices: NEAR $3.32, ETH $1,900, SOL $75, USDC $1; Rhea weighs wNEAR at 0.75 and USDC at 0.95.
const tok = (chain: TokenInfo["chain"], symbol: string, priceUsd: number, contract: string | null, decimals: number): TokenInfo => ({
  chain, symbol, decimals, assetId: `${chain}:${symbol}`, contract, coingeckoId: null, priceUsd,
});
const TOKENS = [
  tok("near", "NEAR", 3.32, null, 24), tok("near", "USDC", 1, "usdc.near", 6),
  tok("base", "ETH", 1900, null, 18), tok("base", "USDC", 1, "0xusdc", 6),
  tok("sol", "SOL", 75, null, 9), tok("sol", "USDC", 1, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 6),
];
vi.mock("../src/tokens.js", async (orig) => ({ ...(await orig<typeof import("../src/tokens.js")>()), tokenList: async () => TOKENS }));
const RHEA = {
  "wrap.near": { token_id: "wrap.near", metadata: { symbol: "wNEAR", decimals: 24 }, config: { volatility_ratio: 7500, extra_decimals: 0 }, price: { usd: "3.32" } },
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": { token_id: "usdc", metadata: { symbol: "USDC", decimals: 6 }, config: { volatility_ratio: 9500, extra_decimals: 12 }, price: { usd: "1" } },
};

const { DEMO_RHEA, DEMO_WALLETS } = await import("../src/demo.js");
const { readHoldings } = await import("../src/holdings.js");
const { fixedRhea } = await import("../src/protocols/rhea.js");
const { allocationOf } = await import("../src/advisor/plans.js");
const { effectFindings, reserveFindings } = await import("../src/snap/effects.js");
const { Brain } = await import("../src/brain.js");
const { Store } = await import("../src/store.js");

describe("demo portfolio", () => {
  it("holds small fixed amounts on NEAR, Base and Solana, and a Rhea loan valued like a real one", async () => {
    const { holdings, errors } = await readHoldings(DEMO_WALLETS, null);
    expect(errors).toEqual([]);
    expect(holdings.map((h) => `${h.walletLabel}:${h.chain}:${h.symbol}:${h.amount}`).sort()).toEqual([
      "Demo Base wallet:base:ETH:0.006", "Demo Base wallet:base:USDC:22",
      "Demo NEAR wallet:near:NEAR:7.5", "Demo NEAR wallet:near:USDC:18",
      "Demo Solana wallet:sol:SOL:0.3", "Demo Solana wallet:sol:USDC:40",
    ]);
    const loan = await fixedRhea(DEMO_RHEA.wallet, DEMO_RHEA, null, RHEA);
    expect(loan.position.healthFactor!).toBeCloseTo((12 * 3.32 * 0.75) / (20 / 0.95), 6);
    const mix = allocationOf(holdings, [loan.position]);
    expect(mix.classes.find((c) => c.cls === "stable")!.pct).toBeGreaterThan(35); // room above the 30% rule
    expect(mix.classes.map((c) => c.cls)).toContain("SOL");
  });

  it("starts with its two rules, and drops them once you add a wallet of your own", async () => {
    const b = new Brain(new Store(":memory:"));
    b.setFeatures({ demo: true });
    const demoRules = () => b.store.listWatches("active").filter((w) => w.source === "demo").map((w) => w.kind).sort();
    expect(demoRules()).toEqual(["allocation_min", "balance_min"]);
    await b.addWallet({ address: "0xabbea473fdde4409c6a1f0c7c527c1bda68e6c24" });
    expect(demoRules()).toEqual([]);
  });

  it("buying $15 of ETH with the Base USDC breaks both rules, and the check says what to pay with instead", async () => {
    const { holdings } = await readHoldings(DEMO_WALLETS, null);
    const loan = await fixedRhea(DEMO_RHEA.wallet, DEMO_RHEA, null, RHEA);
    const before = allocationOf(holdings, [loan.position]);
    const rules = [
      { id: "a", kind: "allocation_min" as const, label: "", params: { cls: "stable", pct: 30 }, status: "active" as const, source: "demo" as const, createdAt: "", confirmedAt: "" },
      { id: "b", kind: "balance_min" as const, label: "", params: { walletLabel: "Demo Base wallet", symbol: "USDC", amount: 10 }, status: "active" as const, source: "demo" as const, createdAt: "", confirmedAt: "" },
    ];
    const changes = [
      { symbol: "USDC", amount: -15, usd: -15, cls: "stable" as const },
      { symbol: "ETH", amount: 0.0078, usd: 0.0078 * 1900, cls: "ETH" as const },
    ];
    const mix = effectFindings(changes, before, rules, holdings, true).findings.find((f) => f.title.includes("30% minimum"))!;
    expect(mix.detail).toMatch(/you could swap (NEAR|SOL) .* or (NEAR|SOL) /);
    const brain = { store: { listWatches: () => rules }, latestSnapshot: () => ({ balances: holdings.map((h) => ({ walletLabel: h.walletLabel, chain: h.chain, symbol: h.symbol, amount: h.amount, usd: h.usd ?? 0 })) }) };
    expect(reserveFindings(brain as any, "Demo Base wallet", changes).map((f) => f.detail)).toEqual(["22.00 → 7.00 USDC (minimum 10)."]);
  });
});
