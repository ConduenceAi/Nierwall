import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Chain, Wallet, WalletsConfig } from "../config.js";
import type { Holding } from "../holdings.js";
import type { AaveAccountDetail } from "../protocols/aave.js";
import { findToken, type TokenInfo } from "../tokens.js";
import type { Allocation, LendingPosition, Watch } from "../types.js";

/*
 * The advisor's safety net. The AI (in a TEE) proposes plans as plain steps; this file replays them on the
 * Mac against real balances, loans and live quotes, and rejects anything that doesn't add up. Plans can
 * only move funds between the user's own wallets, into or out of their Aave and Rhea loans, or through
 * NEAR Intents swaps. There is no field for an outside address.
 */

const amountFields = {
  amount: z.number().positive().optional(),
  amountUsd: z.number().positive().optional(),
  percent: z.number().positive().max(100).optional(),
};

export const PlanAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("swap"), wallet: z.string(), from: z.string(), to: z.string(), ...amountFields }),
  z.object({ type: z.literal("move"), fromWallet: z.string(), toWallet: z.string(), token: z.string(), toToken: z.string().optional(), ...amountFields }),
  z.object({ type: z.literal("repay"), wallet: z.string(), protocol: z.enum(["aave", "rhea"]), token: z.string(), ...amountFields }),
  z.object({ type: z.literal("add_collateral"), wallet: z.string(), protocol: z.enum(["aave", "rhea"]), token: z.string(), ...amountFields }),
  z.object({ type: z.literal("withdraw"), wallet: z.string(), protocol: z.enum(["aave", "rhea"]), token: z.string(), ...amountFields }),
]);
export type PlanAction = z.infer<typeof PlanAction>;

export const PlanInput = z.object({
  title: z.string().min(3).max(120),
  goal: z.string().max(300).default(""),
  actions: z.array(PlanAction).min(1).max(6),
  /** The most this plan is worth paying in fees and slippage. The advisor decides; plans that cost more are rejected. */
  maxCostUsd: z.number().nonnegative(),
  costReason: z.string().max(200).default(""),
});
export type PlanInput = z.infer<typeof PlanInput>;

export type AssetClass = "stable" | "ETH" | "BTC" | "NEAR" | "other";
const CLASSES: AssetClass[] = ["stable", "ETH", "BTC", "NEAR", "other"];

export function assetClass(symbol: string): AssetClass {
  const s = symbol.toUpperCase();
  if (/(USD|DAI|FRAX|GHO|EURC)/.test(s)) return "stable";
  if (s.includes("BTC")) return "BTC";
  if (s.includes("ETH")) return "ETH";
  if (s.includes("NEAR")) return "NEAR";
  return "other";
}

/** One step of a checked plan: what the user signs (or does by hand), in plain words. */
export interface PlanStep {
  n: number;
  type: PlanAction["type"];
  chain: Chain;
  /** Wallet that signs this step. */
  wallet: string;
  description: string;
  /** "sign": Nierwall builds it for your wallet. "manual": you do it in the protocol's app. */
  execution: "sign" | "manual";
  token: TokenInfo;
  /** Token units spent, repaid, added or withdrawn. */
  amount: number;
  toWallet?: string;
  toToken?: TokenInfo;
  route?: "intents" | "transfer";
  /** Token units expected and guaranteed to arrive (swaps and moves). */
  expectedOut?: number;
  minOut?: number;
  protocol?: "aave" | "rhea";
  /** Aave reserve address or Rhea token id. */
  protocolToken?: string;
}

export interface Plan {
  id: string;
  title: string;
  goal: string;
  createdAt: string;
  steps: PlanStep[];
  loans: Array<{ positionId: string; label: string; before: number | null; after: number | null; floor: number | null }>;
  allocation: Array<{ cls: AssetClass; beforePct: number; afterPct: number }>;
  netWorthBefore: number;
  netWorthAfter: number;
  /** Value lost to swap fees and slippage (estimate). */
  costUsd: number;
  /** What the advisor allowed this plan to cost, and why. */
  maxCostUsd: number;
  costReason: string;
  warnings: string[];
  simulated: boolean;
}

export interface QuoteEstimate {
  /** Token units of the destination token. */
  expectedOut: number;
  minOut: number;
  timeEstimate: number | null;
}

export interface PlanContext {
  wallets: WalletsConfig;
  positions: LendingPosition[];
  /** Aave detail by wallet label (reserves and prices), for collateral that isn't in the position yet. */
  aave: Map<string, AaveAccountDetail>;
  /** Rhea token lookup by symbol, for collateral that isn't in the position yet. */
  rheaToken: (symbol: string) => { tokenId: string; symbol: string; usd: number; vr: number; collateral: boolean } | null;
  holdings: Holding[];
  tokens: TokenInfo[];
  watches: Watch[];
  protectedWallets: string[];
  quote: (from: TokenInfo, to: TokenInfo, amount: number) => Promise<QuoteEstimate>;
  simulated: boolean;
}

export type PlanCheck = { ok: true; plan: Plan } | { ok: false; errors: string[]; warnings: string[] };

interface Entry {
  symbol: string;
  token: string;
  amount: number;
  price: number;
  weight: number;
}
interface LoanSim {
  id: string;
  protocol: "aave" | "rhea";
  wallet: string;
  col: Entry[];
  debt: Entry[];
}

/** Health with the protocols' own weights: Σ collateral × weight ÷ Σ debt ÷ weight (Aave debt weight is 1). */
export function loanHealth(l: { col: Entry[]; debt: Entry[] }): number | null {
  const col = l.col.reduce((s, c) => s + c.amount * c.price * c.weight, 0);
  const debt = l.debt.reduce((s, d) => s + (d.weight > 0 ? (d.amount * d.price) / d.weight : d.amount * d.price), 0);
  return debt > 1e-9 ? col / debt : null;
}

const fmt = (x: number, d = 4) => x.toLocaleString("en-US", { maximumFractionDigits: x >= 1000 ? 0 : x >= 1 ? Math.min(d, 2) : d });
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Left in each wallet's native coin to pay gas. */
const GAS_RESERVE: Record<Chain, number> = { base: 0.0002, near: 0.05 };

/** Replays a proposed plan against current data. Returns the checked plan, or what's wrong with it. */
export async function checkPlan(input: PlanInput, ctx: PlanContext): Promise<PlanCheck> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const wallet = (label: string): Wallet | undefined => ctx.wallets.wallets.find((w) => same(w.label, label));
  const knownWallets = ctx.wallets.wallets.map((w) => w.label).join(", ");

  // Balances by wallet and symbol, and loans, both mutated as steps replay.
  const bal = new Map<string, number>();
  const key = (walletLabel: string, symbol: string) => `${walletLabel}\u0000${symbol.toUpperCase()}`;
  for (const h of ctx.holdings) bal.set(key(h.walletLabel, h.symbol), (bal.get(key(h.walletLabel, h.symbol)) ?? 0) + h.amount);
  const loans = new Map<string, LoanSim>();
  const toEntry = (t: LendingPosition["collateral"][number]): Entry => ({ symbol: t.symbol, token: t.token, amount: t.amount, price: t.amount > 0 ? t.usd / t.amount : 0, weight: t.weight });
  for (const p of ctx.positions) loans.set(p.id, { id: p.id, protocol: p.protocol, wallet: p.walletLabel, col: p.collateral.map(toEntry), debt: p.debt.map(toEntry) });
  const healthBefore = new Map([...loans].map(([id, l]) => [id, loanHealth(l)]));

  // Prices for valuing the portfolio before and after.
  const price = (chain: Chain, symbol: string): number | null => {
    const h = ctx.holdings.find((x) => x.chain === chain && same(x.symbol, symbol) && x.usd != null && x.amount > 0);
    if (h) return h.usd! / h.amount;
    return findToken(ctx.tokens, chain, symbol)?.priceUsd ?? null;
  };
  const value = (): { total: number; byClass: Record<AssetClass, number> } => {
    const byClass = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<AssetClass, number>;
    for (const [k, amount] of bal) {
      const [label, symbol] = k.split("\u0000") as [string, string];
      const w = wallet(label);
      const p = w ? price(w.chain, symbol) : null;
      if (p != null) byClass[assetClass(symbol)] += amount * p;
    }
    for (const l of loans.values()) {
      for (const c of l.col) byClass[assetClass(c.symbol)] += c.amount * c.price;
      for (const d of l.debt) byClass[assetClass(d.symbol)] -= d.amount * d.price;
    }
    return { total: Object.values(byClass).reduce((s, v) => s + v, 0), byClass };
  };
  const before = value();

  const resolve = (a: { amount?: number; amountUsd?: number; percent?: number }, available: number, unitPrice: number | null, what: string): number | null => {
    const given = [a.amount, a.amountUsd, a.percent].filter((x) => x != null).length;
    if (given !== 1) {
      errors.push(`${what}: give exactly one of amount, amountUsd or percent.`);
      return null;
    }
    if (a.amount != null) return a.amount;
    if (a.percent != null) return (available * a.percent) / 100;
    if (!unitPrice) {
      errors.push(`${what}: no price, so give the amount in tokens.`);
      return null;
    }
    return a.amountUsd! / unitPrice;
  };
  const spendable = (w: Wallet, token: TokenInfo) => {
    const have = bal.get(key(w.label, token.symbol)) ?? 0;
    return token.contract ? have : Math.max(0, have - GAS_RESERVE[w.chain]);
  };
  const debit = (w: Wallet, token: TokenInfo, amount: number, what: string) => {
    const avail = spendable(w, token);
    if (amount > avail * (1 + 1e-9)) {
      errors.push(`${what}: ${w.label} has ${fmt(avail)} ${token.symbol} available${token.contract ? "" : " after keeping some for gas"}. Add a swap or move first, or use less.`);
      return false;
    }
    bal.set(key(w.label, token.symbol), (bal.get(key(w.label, token.symbol)) ?? 0) - amount);
    return true;
  };
  const credit = (w: Wallet, token: TokenInfo, amount: number) => bal.set(key(w.label, token.symbol), (bal.get(key(w.label, token.symbol)) ?? 0) + amount);
  const tokenOn = (w: Wallet, symbol: string, what: string) => {
    const t = findToken(ctx.tokens, w.chain, symbol);
    if (!t) {
      const known = ctx.tokens.filter((x) => x.chain === w.chain && x.priceUsd).map((x) => x.symbol).slice(0, 14).join(", ");
      errors.push(`${what}: ${symbol} isn't a token Nierwall can handle on ${w.chain === "base" ? "Base" : "NEAR"}. Known: ${known}.`);
    }
    return t;
  };
  const notProtected = (w: Wallet, what: string) => {
    if (ctx.protectedWallets.some((p) => same(p, w.label))) {
      errors.push(`${what}: ${w.label} is protected; Nierwall won't move funds out of it.`);
      return false;
    }
    return true;
  };

  const steps: PlanStep[] = [];
  const signers = new Set<string>();
  /** Expected minus guaranteed output, in USD: the replay credits only the guaranteed minimum. */
  let slackUsd = 0;
  for (const [i, a] of input.actions.entries()) {
    const what = `Step ${i + 1}`;
    const n = steps.length + 1;

    if (a.type === "swap" || a.type === "move") {
      const fw = wallet(a.type === "swap" ? a.wallet : a.fromWallet);
      const tw = wallet(a.type === "swap" ? a.wallet : a.toWallet);
      if (!fw || !tw) {
        errors.push(`${what}: unknown wallet. Use one of: ${knownWallets}.`);
        continue;
      }
      if (a.type === "move" && fw.label === tw.label) {
        errors.push(`${what}: moving within one wallet is a swap.`);
        continue;
      }
      const fromTok = tokenOn(fw, a.type === "swap" ? a.from : a.token, what);
      const toTok = tokenOn(tw, a.type === "swap" ? a.to : a.toToken ?? a.token, what);
      if (!fromTok || !toTok || !notProtected(fw, what)) continue;
      if (fromTok.assetId === toTok.assetId && fw.chain === tw.chain && a.type === "swap") {
        errors.push(`${what}: ${fromTok.symbol} to ${toTok.symbol} is the same token.`);
        continue;
      }
      const amount = resolve(a, spendable(fw, fromTok), price(fw.chain, fromTok.symbol), what);
      if (amount == null || !debit(fw, fromTok, amount, what)) continue;
      const direct = fw.chain === tw.chain && fromTok.assetId === toTok.assetId && fromTok.symbol === toTok.symbol;
      let q: QuoteEstimate;
      if (direct) {
        q = { expectedOut: amount, minOut: amount, timeEstimate: null };
      } else {
        try {
          q = await ctx.quote(fromTok, toTok, amount);
        } catch (e) {
          errors.push(`${what}: NEAR Intents couldn't quote ${fromTok.symbol} → ${toTok.symbol}: ${String(e instanceof Error ? e.message : e).slice(0, 140)}`);
          continue;
        }
      }
      credit(tw, toTok, q.minOut);
      slackUsd += (q.expectedOut - q.minOut) * (price(tw.chain, toTok.symbol) ?? 0);
      signers.add(fw.label);
      if (fw.label !== tw.label) warnings.push(`Moving between ${fw.label} and ${tw.label} links the two wallets on-chain.`);
      const where = fw.label === tw.label ? `in ${fw.label}` : `from ${fw.label} to ${tw.label}`;
      steps.push({
        n, type: a.type, chain: fw.chain, wallet: fw.label, execution: "sign", token: fromTok, amount, toWallet: tw.label, toToken: toTok,
        route: direct ? "transfer" : "intents", expectedOut: q.expectedOut, minOut: q.minOut,
        description: direct
          ? `Send ${fmt(amount)} ${fromTok.symbol} ${where}`
          : `${a.type === "swap" ? "Swap" : "Move"} ${fmt(amount)} ${fromTok.symbol} → about ${fmt(q.expectedOut)} ${toTok.symbol} ${where} with NEAR Intents (at least ${fmt(q.minOut)}${q.timeEstimate ? `, ~${q.timeEstimate}s` : ""})`,
      });
      continue;
    }

    // Loan steps: repay, add collateral, withdraw.
    const w = wallet(a.wallet);
    if (!w) {
      errors.push(`${what}: unknown wallet. Use one of: ${knownWallets}.`);
      continue;
    }
    const loan = loans.get(`${a.protocol}:${w.label}`);
    if (!loan) {
      errors.push(`${what}: Nierwall doesn't watch a ${a.protocol === "aave" ? "Aave" : "Rhea"} loan for ${w.label}.`);
      continue;
    }
    const protoName = a.protocol === "aave" ? "Aave" : "Rhea";
    const sym = a.protocol === "rhea" && same(a.token, "NEAR") ? "wNEAR" : a.token;

    if (a.type === "repay") {
      const d = loan.debt.find((x) => same(x.symbol, sym));
      if (!d) {
        errors.push(`${what}: ${w.label} doesn't owe ${a.token} on ${protoName}. Debt: ${loan.debt.map((x) => x.symbol).join(", ") || "none"}.`);
        continue;
      }
      const tok = tokenOn(w, d.symbol, what);
      if (!tok) continue;
      let amount = resolve(a, d.amount, d.price, what);
      if (amount == null) continue;
      amount = Math.min(amount, d.amount);
      if (!debit(w, tok, amount, what)) continue;
      d.amount -= amount;
      signers.add(w.label);
      steps.push({ n, type: "repay", chain: w.chain, wallet: w.label, execution: "sign", token: tok, amount, protocol: a.protocol, protocolToken: d.token, description: `Repay ${fmt(amount)} ${d.symbol} on ${protoName} from ${w.label}` });
      continue;
    }

    if (a.type === "add_collateral") {
      let entry = loan.col.find((x) => same(x.symbol, sym));
      if (!entry) {
        if (a.protocol === "aave") {
          const r = ctx.aave.get(w.label)?.reserves.find((x) => same(x.symbol, sym));
          const p = r ? ctx.aave.get(w.label)?.prices[r.asset.toLowerCase()] : undefined;
          if (!r || !r.collateralEnabled || !p) {
            errors.push(`${what}: ${a.token} can't be Aave collateral on Base.`);
            continue;
          }
          entry = { symbol: r.symbol, token: r.asset, amount: 0, price: p, weight: r.liquidationThreshold };
        } else {
          const r = ctx.rheaToken(sym);
          if (!r || !r.collateral || !(r.usd > 0)) {
            errors.push(`${what}: ${a.token} can't be Rhea collateral.`);
            continue;
          }
          entry = { symbol: r.symbol, token: r.tokenId, amount: 0, price: r.usd, weight: r.vr };
        }
        loan.col.push(entry);
      }
      const tok = tokenOn(w, entry.symbol, what);
      if (!tok || !notProtected(w, what)) continue;
      const amount = resolve(a, spendable(w, tok), entry.price, what);
      if (amount == null || !debit(w, tok, amount, what)) continue;
      entry.amount += amount;
      signers.add(w.label);
      steps.push({
        n, type: "add_collateral", chain: w.chain, wallet: w.label, execution: a.protocol === "aave" ? "sign" : "manual", token: tok, amount, protocol: a.protocol, protocolToken: entry.token,
        description: `Add ${fmt(amount)} ${entry.symbol} as ${protoName} collateral from ${w.label}${a.protocol === "rhea" ? " (in the Rhea app)" : ""}`,
      });
      continue;
    }

    // withdraw
    const c = loan.col.find((x) => same(x.symbol, sym));
    if (!c) {
      errors.push(`${what}: ${w.label} has no ${a.token} collateral on ${protoName}.`);
      continue;
    }
    const tok = tokenOn(w, c.symbol, what);
    if (!tok) continue;
    let amount = resolve(a, c.amount, c.price, what);
    if (amount == null) continue;
    amount = Math.min(amount, c.amount);
    c.amount -= amount;
    credit(w, tok, amount);
    signers.add(w.label);
    steps.push({
      n, type: "withdraw", chain: w.chain, wallet: w.label, execution: a.protocol === "aave" ? "sign" : "manual", token: tok, amount, protocol: a.protocol, protocolToken: c.token,
      description: `Withdraw ${fmt(amount)} ${c.symbol} of ${protoName} collateral to ${w.label}${a.protocol === "rhea" ? " (in the Rhea app)" : ""}`,
    });
  }

  // Limits: loan health, health floors and balance reserves the user set.
  const loanRows: Plan["loans"] = [];
  for (const [id, l] of loans) {
    const b = healthBefore.get(id) ?? null;
    const after = loanHealth(l);
    const floorWatch = ctx.watches.find((x) => x.kind === "health_below" && x.status === "active" && (x.params as Record<string, unknown>).positionId === id);
    const floor = floorWatch ? Number((floorWatch.params as Record<string, unknown>).threshold) : null;
    const label = `${l.protocol === "aave" ? "Aave" : "Rhea"} · ${l.wallet}`;
    const changed = b == null ? after != null : after == null || Math.abs(after - b) > 1e-6;
    if (changed || steps.some((s) => s.protocol === l.protocol && s.wallet === l.wallet)) loanRows.push({ positionId: id, label, before: b, after, floor });
    if (after != null && after < 1.05 && (b == null || after < b)) errors.push(`${label}: health would fall to ${after.toFixed(2)}, too close to liquidation.`);
    else if (after != null && floor != null && after < floor) {
      warnings.push(b != null && after > b ? `${label}: health improves to ${after.toFixed(2)} but stays below your floor of ${floor.toFixed(2)}.` : `${label}: health would be ${after.toFixed(2)}, below your floor of ${floor.toFixed(2)}.`);
    }
  }
  for (const watch of ctx.watches) {
    if (watch.kind !== "balance_min" || watch.status !== "active") continue;
    const p = watch.params as Record<string, unknown>;
    const left = bal.get(key(String(p.walletLabel), String(p.symbol))) ?? 0;
    if (left < Number(p.amount) && steps.some((s) => same(s.wallet, String(p.walletLabel)))) {
      errors.push(`${p.walletLabel} would keep ${fmt(left)} ${p.symbol}, under your ${p.amount} ${p.symbol} reserve.`);
    }
  }
  const afterMix = value();
  for (const watch of ctx.watches) {
    if ((watch.kind !== "allocation_min" && watch.kind !== "allocation_max") || watch.status !== "active") continue;
    const p = watch.params as Record<string, unknown>;
    const cls = String(p.cls) as AssetClass;
    const target = Number(p.pct);
    const share = (m: { total: number; byClass: Record<AssetClass, number> }) => (m.total > 0 ? (m.byClass[cls] / m.total) * 100 : 0);
    const b = share(before);
    const a = share(afterMix);
    const min = watch.kind === "allocation_min";
    if (min ? a < target && a < b - 0.05 : a > target && a > b + 0.05) {
      warnings.push(`${cls === "stable" ? "Stablecoins" : cls} would ${min ? "fall" : "rise"} to ${a.toFixed(1)}% of the portfolio, ${min ? "below your minimum" : "above your maximum"} of ${target}%.`);
    }
  }
  for (const label of signers) {
    const w = wallet(label)!;
    const gas = w.chain === "base" ? "ETH" : "NEAR";
    const have = ctx.holdings.find((h) => h.walletLabel === label && h.symbol === gas)?.amount ?? 0;
    if (have < GAS_RESERVE[w.chain]) warnings.push(`${label} has almost no ${gas} to pay network fees.`);
  }
  if (steps.some((s) => s.execution === "manual")) warnings.push("Some steps are done by hand in the Rhea app.");
  if (ctx.simulated) warnings.push("Prices include a SIMULATED scenario.");

  const after = value();
  const expectedAfter = after.total + slackUsd;
  const cost = Math.max(0, before.total - expectedAfter);
  if (steps.length && cost > input.maxCostUsd + 0.005) {
    errors.push(`This costs about $${cost.toFixed(2)} in fees and slippage, more than the $${input.maxCostUsd} allowed for it. Use fewer or smaller swaps, or allow more if it's worth it.`);
  }
  if (errors.length || !steps.length) return { ok: false, errors: errors.length ? errors : ["The plan has no steps."], warnings: [...new Set(warnings)] };

  const pct = (v: number, total: number) => (total > 0 ? Number(((v / total) * 100).toFixed(1)) : 0);
  const plan: Plan = {
    id: `plan_${randomUUID().slice(0, 12)}`,
    title: input.title,
    goal: input.goal,
    createdAt: new Date().toISOString(),
    steps,
    loans: loanRows,
    allocation: CLASSES.map((cls) => ({ cls, beforePct: pct(before.byClass[cls], before.total), afterPct: pct(after.byClass[cls], after.total) })).filter((r) => r.beforePct !== 0 || r.afterPct !== 0),
    netWorthBefore: Math.round(before.total),
    netWorthAfter: Math.round(expectedAfter),
    costUsd: Number(cost.toFixed(2)),
    maxCostUsd: input.maxCostUsd,
    costReason: input.costReason,
    warnings: [...new Set(warnings)],
    simulated: ctx.simulated,
  };
  return { ok: true, plan };
}

/** Value by asset class across wallets and loans (collateral minus debt), as shares of net worth. */
export function allocationOf(holdings: Holding[], positions: LendingPosition[]): Allocation {
  const byClass = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<AssetClass, number>;
  for (const h of holdings) if (h.usd != null) byClass[assetClass(h.symbol)] += h.usd;
  for (const p of positions) {
    for (const c of p.collateral) byClass[assetClass(c.symbol)] += c.usd;
    for (const d of p.debt) byClass[assetClass(d.symbol)] -= d.usd;
  }
  const total = Object.values(byClass).reduce((s, v) => s + v, 0);
  return {
    netWorthUsd: Math.round(total),
    classes: CLASSES.filter((c) => Math.abs(byClass[c]) >= 0.5).map((cls) => ({ cls, usd: Math.round(byClass[cls]), pct: total > 0 ? Number(((byClass[cls] / total) * 100).toFixed(1)) : 0 })),
  };
}
