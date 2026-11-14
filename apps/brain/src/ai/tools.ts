import { z } from "zod";
import { allocationOf, checkPlan, PlanInput, type Plan } from "../advisor/plans.js";
import { dryQuote } from "../advisor/quotes.js";
import type { Brain } from "../brain.js";
import { publicConnections } from "../api/connections.js";
import { networkName } from "../chains.js";
import { EVM_NETWORKS } from "../config.js";
import { isConnected, signBlocker, walletAppName } from "../connections.js";
import { fixesFor } from "../planner/fixes.js";
import { rheaAssets, rheaTokenBySymbol } from "../protocols/rhea.js";
import { riskClass } from "../protocols/risk.js";
import { coinPrices, searchCoins, volatility } from "../sources/coins.js";
import { tokenList } from "../tokens.js";
import type { LendingPosition, Symbol, TokenAmount, Watch, WatchKind } from "../types.js";
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
      description: "Current loans (health factor, collateral, debt, distance to liquidation), every token in each wallet by label with USD values and the network it's on (chain: near, or an EVM network such as base, arb, eth), allocation by asset class (net of loans), prices, and whether a SIMULATED scenario is active.",
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
        "price_move {symbol, pct} (pct negative for a drop, measured from the current price); balance_min {walletLabel, symbol, amount}; " +
        "allocation_min / allocation_max {cls: stable|ETH|BTC|NEAR|SOL|other, pct, reason}: a share of net worth the user wants to keep at least / at most. " +
        "For ETH, NEAR or USDC use symbol. For any other token, call find_token first and pass coinId, symbol and name instead.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["health_below", "liq_distance", "price_below", "price_above", "price_move", "balance_min", "allocation_min", "allocation_max"] },
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
      description: "How much a token's price has moved over the last 90 days: typical daily move, worst day, worst week, total change (one price a day). Use it to choose loan floors and repair targets, and to judge risk. token: a symbol like NEAR, ETH, cbBTC, or a CoinGecko coin id.",
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
        "repay / add_collateral / withdraw {wallet, protocol: rhea, token}. Give each step exactly one of amount (tokens), amountUsd, or percent " +
        "(of the available balance; for repay, of the debt; for withdraw, of that collateral). Use token symbols from get_portfolio. " +
        "An EVM wallet holds tokens on several networks: name them with chain/toChain (swap) or fromChain/toChain (move), using the chain values from get_portfolio; " +
        "a swap or move can cross networks, even within one wallet. Left out, Nierwall uses the network where the wallet holds the most of that token. NEAR wallets are always near, Solana wallets sol (they can receive but never send), and Rhea is on near. " +
        "Set maxCostUsd to the most this plan is worth paying in fees and slippage, and costReason to why; plans that cost more are rejected. " +
        "Only connected wallets can send a step (get_portfolio and get_connections show which); a step that sends from a wallet added by address is rejected.",
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
                chain: { type: "string", enum: [...EVM_NETWORKS, "near"], description: "swap: the network the from token is on" },
                fromChain: { type: "string", enum: [...EVM_NETWORKS, "near"], description: "move: the network the token leaves from" },
                toChain: { type: "string", enum: [...EVM_NETWORKS, "near"], description: "swap or move: the network it arrives on" },
                protocol: { type: "string", enum: ["rhea"] },
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
      description: "Search what Nierwall remembers about the user: goals, limits, wallet roles, past decisions. Returns current facts with the date each became true; when two disagree, the newer one is what the user wants now.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_connections",
      description: "The user's wallets by nickname: NEAR or EVM, whether each is connected (Nierwall can send it transactions to approve, through the named wallet app) or only read (added by address), any Rhea loan found in them, and whether transaction safety is on. Nierwall starts with no wallets.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "connect_wallet",
      description:
        "Add a wallet. With a NEAR account the user said or typed (like you.near) or a 0x address they pasted, it's added read-only: Nierwall watches it but can't send it anything (they can also type it in the Nierwall panel). " +
        "Without an address, a page opens in the browser where they connect a NEAR wallet (Meteor or another) or MetaMask; a connected wallet is one Nierwall can send transactions to for approval. Tell them to look for the page. " +
        "label is the nickname to call it; ask the user for one (e.g. Savings, Cash) unless they gave it. Never ask for seed phrases or private keys.",
      parameters: {
        type: "object",
        properties: { address: { type: "string", description: "A NEAR account or 0x address, if the user gave one" }, label: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "remove_wallet",
      description: "Stop watching a wallet the user names. Only when they ask.",
      parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_feature",
      description:
        "Turn a feature on or off when the user asks. transaction_safety: Nierwall checks every transaction in MetaMask before they sign it, against their rules (it also needs the Nierwall Snap installed in MetaMask Flask; the result says how).",
      parameters: {
        type: "object",
        properties: { feature: { type: "string", enum: ["transaction_safety"] }, on: { type: "boolean" } },
        required: ["feature", "on"],
        additionalProperties: false,
      },
    },
  },
];

/** "0.0001035 ZEC ($0.09, 1.02% APR)": four significant digits, so small loans don't read as zero. */
const tokenLine = (t: TokenAmount) => `${Number(t.amount.toPrecision(4))} ${t.symbol} (${t.usd.toFixed(2)}${t.apr != null ? `, ${(t.apr * 100).toFixed(2)}% APR` : ""})`;

function summarizePosition(p: LendingPosition, watches: Watch[]) {
  const floor = watches.find((w) => w.kind === "health_below" && w.status === "active" && (w.params as Record<string, unknown>).positionId === p.id);
  const fp = floor?.params as Record<string, unknown> | undefined;
  return {
    floor: fp ? Number(fp.threshold) : null,
    repairTarget: fp?.target != null ? Number(fp.target) : null,
    positionId: p.id,
    protocol: "Rhea (NEAR)",
    wallet: p.walletLabel,
    // Rhea keeps health per position: the main one, and one per LP token used as collateral.
    position: !p.positionKey || p.positionKey === "REGULAR" ? "main" : `LP position ${p.positionKey}`,
    healthFactor: p.healthFactor == null ? null : Number(p.healthFactor.toFixed(3)),
    liquidationDropPct: p.liquidationDistance == null ? null : Number((p.liquidationDistance * 100).toFixed(1)),
    collateralUsd: Number(p.collateralUsd.toFixed(2)),
    debtUsd: Number(p.debtUsd.toFixed(2)),
    collateral: p.collateral.map(tokenLine),
    debt: p.debt.map(tokenLine),
    ...(p.supplied?.length ? { suppliedNotCollateral: p.supplied.map(tokenLine) } : {}),
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

const ProposeInput = z.object({ kind: z.enum(["health_below", "liq_distance", "price_below", "price_above", "price_move", "balance_min", "allocation_min", "allocation_max"]), params: z.record(z.string(), z.unknown()) });

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
      if (!brain.wallets.wallets.length) return { wallets: [], note: "No wallets yet. Offer to add one (connect_wallet)." };
      if (!snap) return { error: "No data yet" };
      for (const p of snap.positions) ctx.cards.push(positionCard(p, watches));
      const { holdings, errors } = await brain.portfolio.holdings(brain.scenario.get());
      const wallets = brain.wallets.wallets.map((w) => ({
        wallet: w.label,
        kind: w.chain === "evm" ? "EVM (same address on every EVM network)" : w.chain === "solana" ? "Solana (read only: can receive, can't send)" : "NEAR",
        canSend: isConnected(w),
        role: w.role || undefined,
        tokens: holdings
          .filter((h) => h.walletLabel === w.label)
          .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
          .slice(0, 20)
          .map((h) => ({ symbol: h.symbol, chain: h.chain, amount: Number(h.amount.toPrecision(6)), usd: h.usd == null ? null : Math.round(h.usd) })),
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
      if (input.kind === "allocation_min" || input.kind === "allocation_max") {
        if (!["stable", "ETH", "BTC", "NEAR", "SOL", "other"].includes(String(params.cls)) || !(Number(params.pct) > 0 && Number(params.pct) < 100)) {
          return { error: "Give cls (stable, ETH, BTC, NEAR, SOL or other) and pct between 0 and 100." };
        }
        params.pct = Number(Number(params.pct).toFixed(1));
        params.reason = String(params.reason ?? "").slice(0, 200);
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
        if (!current) return { error: "No price for that coinId. Use an id from find_token." };
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
        ? fixes.map((f) => ({ rank: f.rank, title: f.title, healthBefore: f.healthBefore, healthAfter: f.healthAfter, steps: f.steps.map((s) => `${networkName(s.chain)}: ${s.description}`), notes: f.notes }))
        : { note: "No fixes needed for this position." };
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
        rheaToken: (symbol) => rheaTokenBySymbol(assets, symbol),
        holdings,
        tokens,
        watches: brain.store.listWatches("active"),
        protectedWallets: brain.prefs.protectedWallets,
        quote: dryQuote,
        simulated: !!scenario?.active,
        canSign: signBlocker,
      });
      if (!result.ok) return result;
      brain.store.kvSet(`plan:${result.plan.id}`, result.plan);
      ctx.cards.push(planCard(result.plan));
      return summarizePlan(result.plan);
    }
    case "get_connections": {
      const positions = brain.latestSnapshot()?.positions ?? [];
      return {
        wallets: brain.wallets.wallets.map((w) => {
          const loan = positions.find((p) => p.walletLabel === w.label);
          return {
            wallet: w.label, kind: w.chain === "evm" ? "EVM" : w.chain === "solana" ? "Solana" : "NEAR",
            connected: isConnected(w) ? `yes, through ${walletAppName(w.via)}` : "no, only read (added by address)",
            rheaLoan: loan ? { health: loan.healthFactor } : null,
          };
        }),
        transactionSafety: brain.connections.transactionSafety ? "on" : "off",
        note: brain.wallets.wallets.length ? undefined : "No wallets yet.",
      };
    }
    case "connect_wallet": {
      const address = typeof args.address === "string" ? args.address.trim() : "";
      if (!address) {
        brain.emit("open", brain.connectLink());
        return { opened: true, note: "The connect page is open in the browser: connect a NEAR wallet (Meteor or another) or MetaMask there. Nierwall gets only the address; each transaction is still approved in the wallet." };
      }
      try {
        const w = await brain.addWallet({ address, label: typeof args.label === "string" ? args.label : undefined, via: "typed" });
        await brain.refreshNow();
        const loan = brain.latestSnapshot()?.positions.find((p) => p.walletLabel === w.label);
        return {
          added: w.label, kind: w.chain === "evm" ? "EVM, read on every network NEAR Intents supports" : w.chain === "solana" ? "Solana, read only" : "NEAR",
          canSend: isConnected(w) ? true : "no: added by address, so it is only read. To send from it, connect it (connect_wallet without an address).",
          rheaLoan: loan ? summarizePosition(loan, brain.store.listWatches()) : null,
        };
      } catch (e) {
        return { error: String(e instanceof Error ? e.message : e) };
      }
    }
    case "remove_wallet":
      return brain.removeWallet(String(args.label)) ? { removed: String(args.label) } : { error: "No wallet by that name. Call get_connections." };
    case "set_feature": {
      const on = args.on === true;
      brain.setFeatures({ transactionSafety: on });
      if (!on) return { transactionSafety: "off" };
      if (brain.snapSeenAt) return { transactionSafety: "on", snap: "installed: MetaMask shows Nierwall's check before every transaction" };
      // Not seen yet: open the install page, which explains the one-time setup.
      brain.emit("open", `http://127.0.0.1:${brain.apiPort}/snap/install`);
      return { transactionSafety: "on", snap: "not installed yet", setup: "The install page is open in the browser. It needs MetaMask Flask, and `pnpm snap` running in the Nierwall folder; then press Install. After that MetaMask shows Nierwall's check before every transaction." };
    }
    case "recall_memory": {
      if (!ctx.memory) return { facts: [], note: "Memory service is not running" };
      const facts = await ctx.memory.search(String(args.query), 8).catch(() => []);
      return { facts: facts.sort((a, b) => (b.validAt ?? "").localeCompare(a.validAt ?? "")) };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}
