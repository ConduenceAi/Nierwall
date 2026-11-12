import { z } from "zod";
import type { Brain } from "../brain.js";
import { fixesFor } from "../planner/fixes.js";
import { riskClass } from "../protocols/risk.js";
import type { LendingPosition, Symbol, WatchKind } from "../types.js";
import { describeWatch } from "../watches/engine.js";
import { alertCards, positionCard, type Card } from "./cards.js";
import type { MemoryClient } from "../memory/client.js";

export interface ToolContext {
  brain: Brain;
  memory: MemoryClient | null;
  cards: Card[];
}

/** OpenAI-style tool definitions sent to the model. Descriptions are instructions to the model. */
export const TOOL_DEFS = [
  {
    type: "function" as const,
    function: {
      name: "get_portfolio",
      description: "Current positions (health factor, collateral, debt, distance to liquidation), wallet balances by label, prices, and whether a SIMULATED scenario is active.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_alerts",
      description: "Open incidents and recent alerts, with fix options.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "stress_test",
      description: "Health of every position if an asset's price moved by pct (e.g. -0.2 for a 20% drop). Read-only.",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string", enum: ["ETH", "NEAR"] }, pct: { type: "number", minimum: -0.95, maximum: 1 } },
        required: ["symbol", "pct"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_watches",
      description: "Watches (alerts the user set up), active or awaiting confirmation.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "propose_watch",
      description:
        "Propose a new watch when the user states a limit. It is NOT active until the user confirms it in the app. " +
        "Kinds: health_below {positionId, threshold}; liq_distance {positionId, pct}; price_below {symbol, price}; " +
        "price_move {symbol, pct} (pct negative for a drop, measured from the current price); balance_min {walletLabel, symbol, amount}.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["health_below", "liq_distance", "price_below", "price_move", "balance_min"] },
          params: { type: "object", description: "Parameters for the kind. Use positionId values from get_portfolio." },
        },
        required: ["kind", "params"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "plan_fixes",
      description: "Concrete fix options (repay, add collateral, move funds across chains with NEAR Intents) to bring a Rhea position to a target health. Options are estimates the user reviews and signs.",
      parameters: {
        type: "object",
        properties: { positionId: { type: "string" }, target: { type: "number", minimum: 1.05, maximum: 5 } },
        required: ["positionId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "recall_memory",
      description: "Search what Nierwall remembers about the user: goals, limits, wallet roles, past decisions. Returns current facts only.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    },
  },
];

function summarizePosition(p: LendingPosition) {
  return {
    positionId: p.id,
    protocol: p.protocol === "rhea" ? "Rhea (NEAR)" : "Aave V3 (Base)",
    wallet: p.walletLabel,
    healthFactor: p.healthFactor == null ? null : Number(p.healthFactor.toFixed(3)),
    liquidationDropPct: p.liquidationDistance == null ? null : Number((p.liquidationDistance * 100).toFixed(1)),
    collateralUsd: Math.round(p.collateralUsd),
    debtUsd: Math.round(p.debtUsd),
    collateral: p.collateral.map((c) => `${c.amount.toFixed(2)} ${c.symbol}`),
    debt: p.debt.map((d) => `${d.amount.toFixed(2)} ${d.symbol}`),
    simulated: p.simulated,
  };
}

/** Health under a hypothetical shock, from the last snapshot's per-token weights. */
export function stressPosition(p: LendingPosition, symbol: Symbol, pct: number): number | null {
  const f = (sym: string) => (riskClass(sym) === symbol ? 1 + pct : 1);
  const col = p.collateral.reduce((s, c) => s + c.usd * c.weight * f(c.symbol), 0);
  const debt = p.debt.reduce((s, d) => s + (d.weight > 0 ? d.usd / d.weight : d.usd) * f(d.symbol), 0);
  return debt > 0 ? col / debt : null;
}

const ProposeInput = z.object({ kind: z.enum(["health_below", "liq_distance", "price_below", "price_move", "balance_min"]), params: z.record(z.string(), z.unknown()) });

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const { brain } = ctx;
  const snap = brain.latestSnapshot();
  const watches = brain.store.listWatches();
  switch (name) {
    case "get_portfolio": {
      if (!snap) return { error: "No data yet" };
      for (const p of snap.positions) ctx.cards.push(positionCard(p, watches));
      return {
        takenAt: snap.takenAt,
        scenario: snap.scenario?.active ? { simulated: true, shocks: snap.scenario.shocks } : null,
        prices: Object.fromEntries(Object.values(snap.prices).map((p) => [p!.symbol, Number(p!.usd.toFixed(4))])),
        positions: snap.positions.map(summarizePosition),
        balances: snap.balances.map((b) => ({ wallet: b.walletLabel, symbol: b.symbol, amount: Number(b.amount.toFixed(4)) })),
        dataProblems: snap.errors.map((e) => e.split(":")[0]),
      };
    }
    case "get_alerts": {
      const open = brain.store.listIncidents("open");
      const alerts = brain.store.listAlerts(10).filter((a) => open.some((i) => i.id === a.incidentId));
      for (const a of alerts.slice(0, 1)) ctx.cards.push(...alertCards(a));
      return {
        open: open.map((i) => ({ incidentId: i.id, title: i.title, detail: i.detail, severity: i.severity, since: i.firstSeen, simulated: i.simulated })),
        latestAlerts: alerts.map((a) => ({ title: a.title, body: a.body, fixes: a.fixes.map((f) => ({ rank: f.rank, title: f.title, healthAfter: f.healthAfter, notes: f.notes })) })),
      };
    }
    case "stress_test": {
      if (!snap) return { error: "No data yet" };
      const symbol = String(args.symbol) as Symbol;
      const pct = Number(args.pct);
      return {
        symbol,
        movePct: Number((pct * 100).toFixed(1)),
        positions: snap.positions.map((p) => ({
          positionId: p.id,
          healthNow: p.healthFactor == null ? null : Number(p.healthFactor.toFixed(3)),
          healthAfter: (() => { const h = stressPosition(p, symbol, pct); return h == null ? null : Number(h.toFixed(3)); })(),
        })),
      };
    }
    case "list_watches":
      return watches.filter((w) => w.status !== "paused").map((w) => ({ watchId: w.id, label: w.label, status: w.status }));
    case "propose_watch": {
      const input = ProposeInput.parse(args);
      const params = { ...input.params } as Record<string, any>;
      if ((input.kind === "health_below" || input.kind === "liq_distance") && !snap?.positions.some((p) => p.id === params.positionId)) {
        return { error: `Unknown positionId. Use one of: ${snap?.positions.map((p) => p.id).join(", ")}` };
      }
      if (input.kind === "price_move") {
        const price = snap?.prices[params.symbol as Symbol]?.usd;
        if (!price) return { error: "No current price for that symbol" };
        params.referencePrice = Number(price.toFixed(4));
      }
      const label = describeWatch(input.kind as WatchKind, params);
      const w = brain.store.newWatch({ kind: input.kind, label, params, source: "user" });
      ctx.cards.push({ type: "watch_confirm", watchId: w.id, label });
      return { proposed: true, watchId: w.id, readBack: label, note: "Ask the user to confirm it in the app. It is not active yet." };
    }
    case "plan_fixes": {
      if (!brain.last) return { error: "No data yet" };
      const positionId = String(args.positionId);
      const pos = brain.last.snapshot.positions.find((p) => p.id === positionId);
      if (!pos) return { error: "Unknown positionId" };
      const target = Number(args.target ?? 1.5);
      const watch = { id: "adhoc", kind: "health_below" as const, label: "", params: { positionId, threshold: target - 0.2 }, status: "active" as const, source: "user" as const, createdAt: "", confirmedAt: null };
      const fixes = await fixesFor(watch, brain.last, brain.wallets, brain.prefs, false);
      brain.rememberFixes(fixes);
      for (const fix of fixes) ctx.cards.push({ type: "fix", alertId: "adhoc", fix });
      return fixes.length
        ? fixes.map((f) => ({ rank: f.rank, title: f.title, healthBefore: f.healthBefore, healthAfter: f.healthAfter, steps: f.steps.map((s) => `${s.chain}: ${s.description}`), notes: f.notes }))
        : { note: "No fixes needed or this position type is read-only (Aave fixes are not supported yet)." };
    }
    case "recall_memory": {
      if (!ctx.memory) return { facts: [], note: "Memory service is not running" };
      return { facts: await ctx.memory.search(String(args.query), 8).catch(() => []) };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}
