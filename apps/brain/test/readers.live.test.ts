import { describe, expect, it } from "vitest";
import * as rheaSdk from "@rhea-finance/cross-chain-sdk";
import { readRhea, readRheaMain, previewRheaRepay, repayToReach, rheaAssets } from "../src/protocols/rhea.js";
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

  it("rhea: every supplied and borrowed token is read, and health matches the SDK's adjusted sums", async () => {
    const [all, portfolio, assets] = await Promise.all([readRhea("fixture", "sauldone.near", null), rheaSdk.getAccountAllPositionsView("sauldone.near"), rheaAssets()]);
    const d = all.find((x) => x.position.positionKey === "REGULAR")!;
    expect(d.position.id).toBe("rhea:fixture");
    expect(d.position.debtUsd).toBeGreaterThan(0);
    for (const [key, p] of Object.entries((portfolio as any).positions as Record<string, { collateral: object; borrowed: object }>)) {
      const mine = all.find((x) => x.position.positionKey === key);
      expect(mine?.position.collateral.map((c) => c.token).sort()).toEqual(Object.keys(p.collateral).sort());
      expect(mine?.position.debt.map((c) => c.token).sort()).toEqual(Object.keys(p.borrowed).sort());
    }
    const col = rheaSdk.getAdjustedSum({ type: "collateral", portfolio: portfolio as any, assets: assets as any }).toNumber();
    const bor = rheaSdk.getAdjustedSum({ type: "borrowed", portfolio: portfolio as any, assets: assets as any }).toNumber();
    expect(d.position.healthFactor!).toBeCloseTo(col / bor, 4);
    // Repaying the computed amount reaches the target.
    const debtToken = d.position.debt[0]!.token;
    const target = (d.position.healthFactor ?? 1) + 0.2;
    const amt = repayToReach(d, debtToken, target)!;
    expect(previewRheaRepay(d, debtToken, amt)!).toBeCloseTo(target, 6);
  }, 90_000);

  it("rhea: a NEAR shock lowers health for NEAR collateral", async () => {
    const calm = await readRheaMain("fixture", "autopilot-test.near", null);
    const shocked = await readRheaMain("fixture", "autopilot-test.near", { active: true, shocks: { NEAR: -0.1 }, startedAt: "", note: "" });
    if (!calm || !shocked) return;
    if (calm.position.collateral.some((c) => c.symbol.toUpperCase().includes("NEAR"))) {
      expect(shocked.position.healthFactor!).toBeLessThan(calm.position.healthFactor!);
    }
    expect(shocked.position.simulated || !calm.position.collateral.some((c) => c.symbol.includes("NEAR"))).toBe(true);
  }, 90_000);
});
