import { describe, expect, it } from "vitest";
import * as rheaSdk from "@rhea-finance/cross-chain-sdk";
import { readAave, simulateAave } from "../src/protocols/aave.js";
import { readRhea, previewRheaRepay, repayToReach, rheaAssets } from "../src/protocols/rhea.js";
import { fetchPrices } from "../src/sources/prices.js";

// Live reads against public on-chain accounts (read-only fixtures). Skipped with OFFLINE=1.
const live = process.env.OFFLINE ? describe.skip : describe;

live("live readers", () => {
  it("prices: ETH, NEAR, USDC from Pyth", async () => {
    const p = await fetchPrices(null);
    expect(p.ETH?.usd).toBeGreaterThan(100);
    expect(p.NEAR?.usd).toBeGreaterThan(0.1);
    expect(p.USDC?.usd).toBeGreaterThan(0.9);
  }, 90_000);

  it("rhea: health matches the SDK's adjusted sums", async () => {
    const d = await readRhea("fixture", "sauldone.near", null);
    expect(d.position.debtUsd).toBeGreaterThan(0);
    const assets = await rheaAssets();
    const col = rheaSdk.getAdjustedSum({ type: "collateral", portfolio: d.portfolio as any, assets: assets as any }).toNumber();
    const bor = rheaSdk.getAdjustedSum({ type: "borrowed", portfolio: d.portfolio as any, assets: assets as any }).toNumber();
    expect(d.position.healthFactor!).toBeCloseTo(col / bor, 4);
    // Repaying the computed amount reaches the target.
    const debtToken = d.position.debt[0]!.token;
    const target = (d.position.healthFactor ?? 1) + 0.2;
    const amt = repayToReach(d, debtToken, target)!;
    expect(previewRheaRepay(d, debtToken, amt)!).toBeCloseTo(target, 6);
  }, 90_000);

  it("rhea: a NEAR shock lowers health for NEAR collateral", async () => {
    const calm = await readRhea("fixture", "autopilot-test.near", null);
    const shocked = await readRhea("fixture", "autopilot-test.near", { active: true, shocks: { NEAR: -0.1 }, startedAt: "", note: "" });
    if (calm.position.collateral.some((c) => c.symbol.toUpperCase().includes("NEAR"))) {
      expect(shocked.position.healthFactor!).toBeLessThan(calm.position.healthFactor!);
    }
    expect(shocked.position.simulated || !calm.position.collateral.some((c) => c.symbol.includes("NEAR"))).toBe(true);
  }, 90_000);

  it("aave: our weighted health matches the protocol's", async () => {
    const d = await readAave("fixture", "0xABBEa473fdDE4409C6A1F0c7C527C1bDa68E6C24", null);
    expect(d.onChainHealth).not.toBeNull();
    const col = d.position.collateral.reduce((s, c) => s + c.usd * c.weight, 0);
    const debt = d.position.debt.reduce((s, x) => s + x.usd, 0);
    // Within 2%: interest accrual and eMode can differ slightly from the summary call.
    expect(col / debt).toBeGreaterThan(d.onChainHealth! * 0.98);
    expect(col / debt).toBeLessThan(d.onChainHealth! * 1.02);
    const c0 = d.position.collateral[0]!;
    const sim = simulateAave(d, "withdraw", c0.token, c0.amount * 0.1);
    expect(sim.supported && sim.healthAfter! < (d.position.healthFactor ?? 0)).toBe(true);
  }, 90_000);
});
