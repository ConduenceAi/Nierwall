import { describe, expect, it } from "vitest";
import type { Holding } from "../src/holdings.js";
import { effectFindings, netChanges, type RawTransfer } from "../src/snap/effects.js";
import type { TokenMeta } from "../src/snap/pricing.js";
import type { Allocation, Watch } from "../src/types.js";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ME = "0xaaaa000000000000000000000000000000000001";
const ALSO_ME = "0xaaaa000000000000000000000000000000000002";
const POOL = "0xbbbb000000000000000000000000000000000003";
const meta = new Map<string, TokenMeta>([
  [NATIVE, { symbol: "ETH", decimals: 18, priceUsd: 2000 }],
  [USDC, { symbol: "USDC", decimals: 6, priceUsd: 1 }],
]);
const own = new Set([ME, ALSO_ME]);
const holding = (walletLabel: string, symbol: string, usd: number): Holding => ({
  walletLabel, chain: "base", symbol, amount: usd, usd, token: { chain: "base", symbol, decimals: 18, assetId: symbol, contract: null, coingeckoId: null, priceUsd: 1 }, simulated: false,
});
const watch = (kind: Watch["kind"], params: Record<string, unknown>): Watch => ({ id: kind, kind, label: "", params, status: "active", source: "user", createdAt: "", confirmedAt: "" });
// $10,000: 30% stables, 20% ETH, 50% NEAR.
const before: Allocation = { netWorthUsd: 10_000, classes: [{ cls: "stable", usd: 3000, pct: 30 }, { cls: "ETH", usd: 2000, pct: 20 }, { cls: "NEAR", usd: 5000, pct: 50 }] };
const holdings = [holding("Cash", "USDC", 3000), holding("Savings", "NEAR", 5000), holding("Cash", "ETH", 2000)];

// Swapping USDC for ETH: USDC leaves to a pool, ETH comes back.
const swap = (usdcOut: number, ethIn: number): RawTransfer[] => [
  { token: USDC, from: ME, to: POOL, amount: BigInt(usdcOut * 1e6) },
  { token: NATIVE, from: POOL, to: ME, amount: BigInt(Math.round(ethIn * 1e6)) * 10n ** 12n },
];

describe("snap: what a transaction does", () => {
  it("nets transfers across the user's wallets; moves between them cancel out", () => {
    const changes = netChanges([...swap(1500, 0.74), { token: USDC, from: ME, to: ALSO_ME, amount: 500_000_000n }], own, meta);
    expect(changes.map((c) => [c.symbol, c.amount])).toEqual([["USDC", -1500], ["ETH", 0.74]]);
  });

  it("warns when a swap breaks the stablecoin minimum, and suggests something else to sell", () => {
    const changes = netChanges(swap(1500, 0.74), own, meta);
    const { findings, rows } = effectFindings(changes, before, [watch("allocation_min", { cls: "stable", pct: 20 })], holdings, true);
    expect(rows).toEqual([{ label: "You send", value: "1,500 USDC ($1,500)" }, { label: "You get", value: "0.74 ETH ($1,480)" }]);
    const f = findings.find((x) => x.title.includes("20% minimum"))!;
    expect(f.severity).toBe("warning");
    expect(f.detail).toContain("from 30.0% to 15.0%");
    expect(f.detail).toContain("you could swap NEAR");
    expect(f.detail).not.toContain("you could swap USDC");
  });

  it("stays quiet when the mix stays within the target", () => {
    const { findings } = effectFindings(netChanges(swap(500, 0.249), own, meta), before, [watch("allocation_min", { cls: "stable", pct: 20 })], holdings, true);
    expect(findings).toEqual([]);
  });

  it("flags a bad rate, and a very bad one as critical", () => {
    const meh = effectFindings(netChanges(swap(1000, 0.47), own, meta), before, [], holdings, true);
    expect(meh.findings[0]!.severity).toBe("warning"); // gives $1,000, gets $940
    const awful = effectFindings(netChanges(swap(1000, 0.3), own, meta), before, [], holdings, true);
    expect(awful.findings[0]!.severity).toBe("critical");
  });

  it("notices when a contract call takes tokens and gives nothing back", () => {
    const { findings } = effectFindings(netChanges([{ token: USDC, from: ME, to: POOL, amount: 800_000_000n }], own, meta), before, [], holdings, true);
    expect(findings[0]!.title).toBe("Nothing comes back to your wallets");
  });
});
