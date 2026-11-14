import { describe, expect, it, vi } from "vitest";
import type { Plan, PlanStep } from "../src/advisor/plans.js";
import type { TokenInfo } from "../src/tokens.js";

// Rhea keeps wNEAR with 0 extra decimals in this test; the token list has plain NEAR and wNEAR.
vi.mock("../src/protocols/rhea.js", async (orig) => ({
  ...(await orig<typeof import("../src/protocols/rhea.js")>()),
  rheaAssets: async () => ({ "wrap.near": { config: { extra_decimals: 0 } } }),
}));
const near: TokenInfo = { chain: "near", symbol: "NEAR", decimals: 24, assetId: "nep141:wrap.near", contract: null, coingeckoId: "near", priceUsd: 3.5 };
const wnear: TokenInfo = { ...near, symbol: "wNEAR", contract: "wrap.near" };
vi.mock("../src/tokens.js", async (orig) => ({ ...(await orig<typeof import("../src/tokens.js")>()), tokenList: async () => [near, wnear] }));

const { SignSessions } = await import("../src/sign/sessions.js");

const brain: any = {
  wallets: { wallets: [{ label: "Savings", chain: "near", address: "you.near", role: "" }], watchRhea: ["Savings"] },
  store: { addEvent: () => undefined },
};
const tgas = (actions: any[]) => actions.reduce((sum, a) => sum + Number(a.params.gas) / 1e12, 0);
const plan = (step: Partial<PlanStep>): Plan => ({
  id: "plan_test", title: "Add collateral", goal: "", createdAt: "", loans: [], allocation: [], netWorthBefore: 0, netWorthAfter: 0,
  costUsd: 0, maxCostUsd: 1, costReason: "", warnings: [], simulated: false,
  steps: [{ n: 1, type: "add_collateral", chain: "near", wallet: "Savings", description: "", execution: "sign", token: near, amount: 100, protocol: "rhea", protocolToken: "wrap.near", ...step }],
});

describe("signing: Rhea add collateral", () => {
  it("wraps plain NEAR and adds it as collateral in one transaction, within the gas limit", async () => {
    const s = await new SignSessions(brain, () => undefined).createFromPlan(plan({}));
    const [step] = s.steps;
    expect([step!.kind, step!.state, step!.nearTx!.receiverId]).toEqual(["near", "ready", "wrap.near"]);
    const actions = step!.nearTx!.actions as any[];
    expect(actions.map((a) => a.params.methodName)).toEqual(["storage_deposit", "near_deposit", "ft_transfer_call"]);
    expect(actions[1].params.deposit).toBe((100n * 10n ** 24n).toString());
    const call = actions[2].params.args;
    expect(call.receiver_id).toBe("contract.main.burrow.near");
    expect(JSON.parse(call.msg)).toEqual({ Execute: { actions: [{ IncreaseCollateral: { token_id: "wrap.near", max_amount: (100n * 10n ** 24n).toString() } }] } });
    expect(tgas(actions)).toBeLessThanOrEqual(300);
  });

  it("sends wNEAR straight to Rhea, and the alert's fix builds the same transaction", async () => {
    const s = await new SignSessions(brain, () => undefined).createFromPlan(plan({ token: wnear }));
    expect((s.steps[0]!.nearTx!.actions as any[]).map((a) => a.params.methodName)).toEqual(["ft_transfer_call"]);
    const fix = await new SignSessions(brain, () => undefined).create({
      id: "f1", kind: "add_collateral", rank: 1, title: "Add 50 NEAR", steps: [], healthBefore: 1.2, healthAfter: 1.4, notes: [],
      plan: { type: "rhea_add_collateral", amountNear: 50, wallet: "Savings" },
    });
    const actions = fix.steps[0]!.nearTx!.actions as any[];
    expect([fix.steps[0]!.kind, actions.map((a) => a.params.methodName).join(",")]).toEqual(["near", "storage_deposit,near_deposit,ft_transfer_call"]);
    expect(actions[1].params.deposit).toBe((50n * 10n ** 24n).toString());
  });
});

describe("signing: the orb's \"send it to Meteor\"", () => {
  it("opens the review page on Meteor and asks it to sign each step; a click in the panel opens it plainly", async () => {
    const { Hono } = await import("hono");
    const { registerSignRoutes } = await import("../src/sign/routes.js");
    const saved = plan({});
    const app = new Hono();
    registerSignRoutes(app, { ...brain, store: { ...brain.store, kvGet: (k: string) => (k === "plan:plan_test" ? saved : null) } }, new SignSessions(brain, () => undefined), 7420);
    const post = async (body?: unknown) => {
      const res = await app.request("/api/fixes/plan_test/review", { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return (await res.json()) as { url: string };
    };
    expect((await post({ wallet: "meteor-wallet", auto: true })).url).toMatch(/^http:\/\/127\.0\.0\.1:7420\/sign\/[\w-]+\?wallet=meteor-wallet&auto=1$/);
    expect((await post()).url).toMatch(/^http:\/\/127\.0\.0\.1:7420\/sign\/[\w-]+$/);
  });
});
