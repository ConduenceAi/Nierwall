import { z } from "zod";
import { allocationOf, checkPlan, PlanInput, type Plan } from "../advisor/plans.js";
import { dryQuote } from "../advisor/quotes.js";
import type { Brain } from "../brain.js";
import { fixesFor } from "../planner/fixes.js";
import { rheaAssets, rheaTokenBySymbol } from "../protocols/rhea.js";
import { riskClass } from "../protocols/risk.js";
import { coinPrices, searchCoins, volatility } from "../sources/coingecko.js";
import { tokenList } from "../tokens.js";
import type { LendingPosition, Symbol, Watch, WatchKind } from "../types.js";
import { describeWatch } from "../watches/engine.js";
import { alertCards, planCard, positionCard, type Card } from "./cards.js";
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
      description: "Current loans (health factor, collateral, debt, distance to liquidation), every token in each wallet by label with USD values, allocation by asset class (net of loans), prices, and whether a SIMULATED scenario is active.",
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
        "Kinds: health_below {positionId, threshold, target, reason} where threshold is the floor that raises an alert and target the health a fix restores " +
        "(choose both from asset_volatility and the user's goals; floor above 1.05, target above the floor); liq_distance {positionId, pct}; price_below / price_above {symbol, price}; " +
        "price_move {symbol, pct} (pct negative for a drop, measured from the current price); balance_min {walletLabel, symbol, amount}. " +
        "For ETH, NEAR or USDC use symbol. For any other token, call find_token first and pass coinId, symbol and name instead.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["health_below", "liq_distance", "price_below", "price_above", "price_move", "balance_min"] },
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
      name: "asset_volatility",
      description: "How much a token's price has moved over the last 90 days: typical daily move, worst day, worst week, total change (CoinGecko daily closes). Use it to choose loan floors and repair targets, and to judge risk. token: a symbol like NEAR, ETH, cbBTC, or a CoinGecko coin id.",
      parameters: { type: "object", properties: { token: { type: "string" } }, required: ["token"], additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "find_token",
      description: "Look up any token on CoinGecko by name or ticker (e.g. 'SOL', 'pepe'). Returns coin ids with current prices, biggest first. Use before watching a token other than ETH, NEAR or USDC.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "check_plan",
      description:
        "Check a plan on the user's Mac before suggesting it. Each step is replayed against real balances, loans and live NEAR Intents quotes; " +
        "returns verified numbers (health before/after, allocation before/after, cost) or the problems to fix. Never state results for a plan this didn't verify. " +
        "Steps: swap {wallet, from, to} within one wallet; move {fromWallet, toWallet, token, toToken?} between the user's own wallets, across chains if needed; " +
        "repay / add_collateral / withdraw {wallet, protocol: aave|rhea, token}. Give each step exactly one of amount (tokens), amountUsd, or percent " +
        "(of the available balance; for repay, of the debt; for withdraw, of that collateral). Use token symbols from get_portfolio. Base wallets hold Base tokens, NEAR wallets NEAR tokens. " +
        "Set maxCostUsd to the most this plan is worth paying in fees and slippage, and costReason to why; plans that cost more are rejected.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short name, e.g. 'Cut NEAR to 40% of the portfolio'" },
          goal: { type: "string", description: "What the user asked for, in a few words" },
          maxCostUsd: { type: "number", minimum: 0, description: "Most this plan is worth paying in fees and slippage, in USD" },
          costReason: { type: "string", description: "One short sentence on why that cost is acceptable" },
          actions: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["swap", "move", "repay", "add_collateral", "withdraw"] },
                wallet: { type: "string" },
                from: { type: "string" },
                to: { type: "string" },
                fromWallet: { type: "string" },
                toWallet: { type: "string" },
                token: { type: "string" },
                toToken: { type: "string" },
                protocol: { type: "string", enum: ["aave", "rhea"] },
                amount: { type: "number" },
                amountUsd: { type: "number" },
                percent: { type: "number" },
              },
              required: ["type"],
            },
          },
        },
        required: ["title", "actions", "maxCostUsd"],
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

function summarizePosition(p: LendingPosition, watches: Watch[]) {
  const floor = watches.find((w) => w.kind === "health_below" && w.status === "active" && (w.params as Record<string, unknown>).positionId === p.id);
  const fp = floor?.params as Record<string, unknown> | undefined;
  return {
    floor: fp ? Number(fp.threshold) : null,
    repairTarget: fp?.target != null ? Number(fp.target) : null,
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

const ProposeInput = z.object({ kind: z.enum(["health_below", "liq_distance", "price_below", "price_above", "price_move", "balance_min"]), params: z.record(z.string(), z.unknown()) });

/** What the model sees of a checked plan: plain numbers, labels, no addresses. */
function summarizePlan(p: Plan) {
  return {
    ok: true,
    planId: p.id,
    title: p.title,
    steps: p.steps.map((s) => `${s.n}. ${s.description}${s.execution === "manual" ? " (by hand)" : ""}`),
    loans: p.loans.map((l) => ({ loan: l.label, healthBefore: l.before == null ? null : Number(l.before.toFixed(2)), healthAfter: l.after == null ? null : Number(l.after.toFixed(2)), floor: l.floor })),
    allocationPct: p.allocation.map((a) => ({ assetClass: a.cls, before: a.beforePct, after: a.afterPct })),
    netWorthBeforeUsd: p.netWorthBefore,
    netWorthAfterUsd: p.netWorthAfter,
    costUsd: p.costUsd,
    warnings: p.warnings,
    note: "Shown to the user as a card with Review & sign. Nothing moves until they sign each step in their own wallet.",
  };
}

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const { brain } = ctx;
  const snap = brain.latestSnapshot();
  const watches = brain.store.listWatches();
  switch (name) {
    case "get_portfolio": {
      if (!snap) return { error: "No data yet" };
      for (const p of snap.positions) ctx.cards.push(positionCard(p, watches));
      const { holdings, errors } = await brain.portfolio.holdings(brain.scenario.get());
      const wallets = brain.wallets.wallets.map((w) => ({
        wallet: w.label,
        chain: w.chain,
        role: w.role || undefined,
        tokens: holdings
          .filter((h) => h.walletLabel === w.label)
          .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
          .slice(0, 12)
          .map((h) => ({ symbol: h.symbol, amount: Number(h.amount.toPrecision(6)), usd: h.usd == null ? null : Math.round(h.usd) })),
      }));
      return {
        takenAt: snap.takenAt,
        scenario: snap.scenario?.active ? { simulated: true, shocks: snap.scenario.shocks } : null,
        prices: Object.fromEntries(Object.values(snap.prices).map((p) => [p!.symbol, Number(p!.usd.toFixed(4))])),
        positions: snap.positions.map((p) => summarizePosition(p, watches)),
        wallets,
        allocation: allocationOf(holdings, snap.positions),
        dataProblems: [...snap.errors, ...errors].map((e) => e.split(":")[0]),
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
      if (input.kind === "health_below") {
        const floor = Number(params.threshold);
        const target = Number(params.target);
        if (!(floor > 1.05) || !(target > floor) || target > 5) return { error: "Give threshold (the floor, above 1.05) and target (the health a fix restores, above the floor). Use asset_volatility to choose them." };
        params.reason = String(params.reason ?? "").slice(0, 200);
      }
      const isPrice = input.kind === "price_below" || input.kind === "price_above" || input.kind === "price_move";
      let current: number | undefined;
      if (isPrice && params.coinId) {
        current = (await coinPrices([String(params.coinId)]).catch(() => ({})) as Record<string, { usd: number }>)[String(params.coinId)]?.usd;
        if (!current) return { error: "CoinGecko has no price for that coinId. Use an id from find_token." };
        params.symbol = String(params.symbol ?? params.coinId).toUpperCase();
      } else if (isPrice) {
        current = snap?.prices[params.symbol as Symbol]?.usd;
        if (!current) return { error: "No price for that symbol. For tokens other than ETH, NEAR and USDC, use find_token and pass coinId." };
      }
      if (input.kind === "price_move") params.referencePrice = Number(current!.toPrecision(6));
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
      const floorWatch = watches.find((w) => w.kind === "health_below" && w.status === "active" && (w.params as Record<string, unknown>).positionId === positionId);
      const target = Number(args.target ?? (floorWatch?.params as Record<string, unknown> | undefined)?.target);
      if (!(target > 1.05)) return { error: "No repair target for this loan yet. Propose a floor and target first (asset_volatility, then propose_watch health_below), or pass target." };
      const watch = { id: "adhoc", kind: "health_below" as const, label: "", params: { positionId, threshold: target, target }, status: "active" as const, source: "user" as const, createdAt: "", confirmedAt: null };
      const fixes = await fixesFor(watch, brain.last, brain.wallets, brain.prefs, false);
      brain.rememberFixes(fixes);
      for (const fix of fixes) ctx.cards.push({ type: "fix", alertId: "adhoc", fix });
      return fixes.length
        ? fixes.map((f) => ({ rank: f.rank, title: f.title, healthBefore: f.healthBefore, healthAfter: f.healthAfter, steps: f.steps.map((s) => `${s.chain}: ${s.description}`), notes: f.notes }))
        : { note: "No fixes needed or this position type is read-only (Aave fixes are not supported yet)." };
    }
    case "asset_volatility": {
      const q = String(args.token ?? "").trim();
      const tokens = await tokenList().catch(() => []);
      const bySymbol = tokens.find((t) => t.symbol.toLowerCase() === q.toLowerCase() && t.coingeckoId)?.coingeckoId;
      const coinId = bySymbol ?? (/^[a-z0-9-]+$/.test(q) ? q : (await searchCoins(q).catch(() => []))[0]?.coinId);
      if (!coinId) return { error: `Couldn't find ${q} on CoinGecko` };
      return { token: q, ...(await volatility(coinId)) };
    }
    case "find_token": {
      const matches = await searchCoins(String(args.query ?? ""));
      const prices = await coinPrices(matches.slice(0, 3).map((m) => m.coinId)).catch(() => ({}) as Record<string, { usd: number; change24h: number | null }>);
      return {
        matches: matches.map((m) => ({
          ...m,
          priceUsd: prices[m.coinId]?.usd ?? null,
          change24hPct: prices[m.coinId]?.change24h == null ? null : Number(prices[m.coinId]!.change24h!.toFixed(1)),
        })),
      };
    }
    case "check_plan": {
      if (!brain.last) return { error: "No data yet" };
      const parsed = PlanInput.safeParse(args);
      if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "plan"}: ${i.message}`) };
      const scenario = brain.scenario.get();
      const [{ holdings }, tokens, assets] = await Promise.all([brain.portfolio.holdings(scenario, 60_000), tokenList(), rheaAssets()]);
      const result = await checkPlan(parsed.data, {
        wallets: brain.wallets,
        positions: brain.last.snapshot.positions,
        aave: brain.last.aave,
        rheaToken: (symbol) => rheaTokenBySymbol(assets, symbol),
        holdings,
        tokens,
        watches: brain.store.listWatches("active"),
        protectedWallets: brain.prefs.protectedWallets,
        quote: dryQuote,
        simulated: !!scenario?.active,
      });
      if (!result.ok) return result;
      brain.store.kvSet(`plan:${result.plan.id}`, result.plan);
      ctx.cards.push(planCard(result.plan));
      return summarizePlan(result.plan);
    }
    case "recall_memory": {
      if (!ctx.memory) return { facts: [], note: "Memory service is not running" };
      return { facts: await ctx.memory.search(String(args.query), 8).catch(() => []) };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}
