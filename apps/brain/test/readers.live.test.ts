import { describe, expect, it } from "vitest";
import * as rheaSdk from "@rhea-finance/cross-chain-sdk";
import { readRhea, previewRheaRepay, repayToReach, rheaAssets } from "../src/protocols/rhea.js";
import { fetchPrices } from "../src/sources/prices.js";

// Live reads against public on-chain accounts (read-only fixtures). Skipped with OFFLINE=1.
const live = process.env.OFFLINE ? describe.skip : describe;

live("live readers", () => {
  it("prices: NEAR from Rhea's oracle, ETH and USDC from the market", async () => {
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
});
