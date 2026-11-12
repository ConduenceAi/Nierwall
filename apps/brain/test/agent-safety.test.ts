import { describe, expect, it } from "vitest";
import { detectSecret } from "../src/ai/tripwire.js";
import { collectNumbers, ungroundedNumbers } from "../src/ai/grounding.js";
import { stressPosition } from "../src/ai/tools.js";
import type { LendingPosition } from "../src/types.js";

describe("seed-phrase tripwire", () => {
  it("blocks a 12-word BIP-39 phrase", () => {
    expect(detectSecret("my words are abandon ability able about above absent absorb abstract absurd abuse access accident")).toBe("seed phrase");
  });
  it("blocks EVM and NEAR private keys", () => {
    expect(detectSecret("key 0x" + "ab".repeat(32))).toBe("private key");
    expect(detectSecret("ed25519:" + "3".repeat(80))).toBe("NEAR secret key");
  });
  it("lets normal questions through", () => {
    expect(detectSecret("How is my Rhea loan doing after the NEAR drop?")).toBeNull();
    expect(detectSecret("send 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 to the pool")).toBeNull(); // 40-hex address is fine
  });
});

describe("grounding check", () => {
  const grounding = collectNumbers({ healthFactor: 1.392, liquidationDropPct: 28.2, debtUsd: 8563, ratio: 0.1 });
  it("accepts rounded figures from tool data", () => {
    expect(ungroundedNumbers("Health is 1.39, liquidation after a 28.2% drop, debt $8,563, about 10%.", grounding)).toEqual([]);
  });
  it("flags invented numbers", () => {
    expect(ungroundedNumbers("Health is 1.72 and you owe $9,999.", grounding)).toEqual(["1.72", "$9,999"]);
  });
  it("ignores small counts", () => {
    expect(ungroundedNumbers("You have 2 options and 1 open issue.", grounding)).toEqual([]);
  });
});

describe("stress test", () => {
  const p: LendingPosition = {
    id: "rhea:x", protocol: "rhea", chain: "near", walletLabel: "x",
    collateral: [{ token: "wrap.near", symbol: "wNEAR", amount: 1000, usd: 3000, weight: 0.75 }],
    debt: [{ token: "usdc", symbol: "USDC", amount: 1500, usd: 1500, weight: 0.95 }],
    collateralUsd: 3000, debtUsd: 1500, healthFactor: null, liquidationDistance: null, observedAt: "", simulated: false,
  };
  it("a 20% NEAR drop scales health by 0.8", () => {
    const base = stressPosition(p, "NEAR", 0)!;
    expect(stressPosition(p, "NEAR", -0.2)!).toBeCloseTo(base * 0.8, 10);
    expect(stressPosition(p, "ETH", -0.2)!).toBeCloseTo(base, 10);
  });
});
