import type { Severity, Snapshot, Symbol, Watch } from "../types.js";

export interface Evaluation {
  watch: Watch;
  /** The condition is currently true. */
  triggered: boolean;
  /** The condition has cleared with a margin (hysteresis), so an open incident can resolve. */
  recovered: boolean;
  /** Data needed for this watch is missing; never treated as safe. */
  unknown: boolean;
  severity: Severity;
  value: number | null;
  title: string;
  detail: string;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${x.toLocaleString("en-US", { maximumFractionDigits: x < 10 ? 4 : 2 })}`;
const num = (x: number) => x.toFixed(2);

/** Price a watch follows: an oracle price (ETH, NEAR, USDC) or any CoinGecko coin by id. */
function watchedPrice(p: Record<string, any>, snap: Snapshot): { price: number | undefined; name: string } {
  if (p.coinId) return { price: snap.coins?.[String(p.coinId)]?.usd, name: String(p.symbol ?? p.coinId) };
  return { price: snap.prices[p.symbol as Symbol]?.usd, name: String(p.symbol) };
}

export const CLASS_NAMES: Record<string, string> = { stable: "Stablecoins", ETH: "ETH", BTC: "BTC", NEAR: "NEAR", other: "Other tokens" };
const className = (cls: unknown) => CLASS_NAMES[String(cls)] ?? String(cls);

const coinName = (p: Record<string, any>) => (p.coinId && p.name ? `${p.symbol} (${p.name})` : String(p.symbol ?? p.coinId));

function protocolName(positionId: string) {
  const [proto, label] = positionId.split(":");
  const name = proto === "rhea" ? "Rhea · NEAR" : proto === "aave" ? "Aave V3 · Base" : proto ?? positionId;
  return { name, label: label ?? "" };
}

/** Evaluates one watch against a snapshot. Pure function: no I/O, easy to test. */
export function evaluate(watch: Watch, snap: Snapshot): Evaluation {
  const base = { watch, triggered: false, recovered: false, unknown: false, severity: "warning" as Severity, value: null as number | null };
  const p = watch.params as Record<string, any>;

  switch (watch.kind) {
    case "health_below": {
      const pos = snap.positions.find((x) => x.id === p.positionId);
      const { name } = protocolName(String(p.positionId));
      if (!pos) return { ...base, unknown: true, title: `${name}: no fresh data`, detail: `Couldn't read this position in the last refresh, so its health is unknown.` };
      const hf = pos.healthFactor;
      const threshold = Number(p.threshold);
      const critical = Number(p.critical ?? 1 + (threshold - 1) / 2);
      if (hf === null) return { ...base, recovered: true, title: `${name}: no debt`, detail: "Nothing borrowed, so there's no liquidation risk." };
      const triggered = hf < threshold;
      return {
        ...base,
        value: hf,
        triggered,
        recovered: hf >= threshold * 1.02,
        severity: hf < critical ? "critical" : "warning",
        title: triggered ? `${name} is below your floor` : `${name} health ${num(hf)}`,
        detail: `Health factor ${num(hf)} (your floor ${num(threshold)}).${pos.liquidationDistance != null ? ` Liquidation if the main collateral falls ${pct(pos.liquidationDistance)} more.` : ""}`,
      };
    }
    case "liq_distance": {
      const pos = snap.positions.find((x) => x.id === p.positionId);
      const { name } = protocolName(String(p.positionId));
      const limit = Number(p.pct);
      if (!pos || pos.liquidationDistance == null) return { ...base, unknown: !pos, title: `${name}: distance unknown`, detail: "Couldn't compute how far collateral can fall." };
      const d = pos.liquidationDistance;
      return {
        ...base,
        value: d,
        triggered: d < limit,
        recovered: d >= limit * 1.1,
        severity: d < limit / 2 ? "critical" : "warning",
        title: `${name} is within ${pct(d)} of liquidation`,
        detail: `Collateral can fall ${pct(d)} before liquidation (you asked to know under ${pct(limit)}).`,
      };
    }
    case "price_below":
    case "price_above": {
      const { price, name: sym } = watchedPrice(p, snap);
      const level = Number(p.price);
      if (price == null) return { ...base, unknown: true, title: `${sym} price unavailable`, detail: "No price source answered." };
      const below = watch.kind === "price_below";
      return {
        ...base,
        value: price,
        triggered: below ? price < level : price > level,
        recovered: below ? price >= level * 1.01 : price <= level * 0.99,
        title: `${sym} is ${below ? "below" : "above"} ${usd(level)}`,
        detail: `${sym} is ${usd(price)} (your level ${usd(level)}).`,
      };
    }
    case "price_move": {
      const { price, name: sym } = watchedPrice(p, snap);
      const ref = Number(p.referencePrice);
      const move = Number(p.pct); // e.g. -0.10
      if (price == null || !ref) return { ...base, unknown: true, title: `${sym} price unavailable`, detail: "No price source answered." };
      const change = price / ref - 1;
      const eps = 1e-9; // an exact 10% move must count as 10%
      const triggered = move < 0 ? change <= move + eps : change >= move - eps;
      return {
        ...base,
        value: change,
        triggered,
        recovered: move < 0 ? change > move * 0.8 : change < move * 0.8,
        severity: Math.abs(change) >= Math.abs(move) * 1.5 ? "critical" : "warning",
        title: `${sym} ${change < 0 ? "down" : "up"} ${pct(Math.abs(change))}`,
        detail: `${sym} is ${usd(price)}, ${pct(Math.abs(change))} ${change < 0 ? "below" : "above"} ${usd(ref)} from when you set this watch.`,
      };
    }
    case "allocation_min":
    case "allocation_max": {
      const target = Number(p.pct);
      const min = watch.kind === "allocation_min";
      if (!snap.allocation) return { ...base, unknown: true, title: "Portfolio mix unknown", detail: "Couldn't read wallet holdings." };
      const share = snap.allocation.classes.find((c) => c.cls === p.cls)?.pct ?? 0;
      return {
        ...base,
        value: share,
        triggered: min ? share < target : share > target,
        recovered: min ? share >= target + 1 : share <= target - 1,
        title: `${className(p.cls)} ${min ? "below" : "above"} ${target}% of your portfolio`,
        detail: `${className(p.cls)} ${p.cls === "stable" || p.cls === "other" ? "are" : "is"} ${share.toFixed(1)}% of your portfolio (your ${min ? "minimum" : "maximum"} is ${target}%).`,
      };
    }
    case "balance_min": {
      // What the wallet holds on all its networks. Empty balances aren't listed, so none means zero, unless a read
      // of this wallet failed: then the total could be short, and it's unknown.
      const failed = snap.errors.some((e) => e.startsWith(`holdings:${p.walletLabel}:`) || e.startsWith("holdings: "));
      const min = Number(p.amount);
      if (failed) return { ...base, unknown: true, title: `${p.walletLabel}: balance unknown`, detail: "Couldn't read this balance." };
      const amount = snap.balances.filter((b) => b.walletLabel === p.walletLabel && b.symbol === p.symbol).reduce((sum, b) => sum + b.amount, 0);
      return {
        ...base,
        value: amount,
        triggered: amount < min,
        recovered: amount >= min,
        title: `${p.walletLabel} is below your ${p.symbol} reserve`,
        detail: `${p.walletLabel} holds ${amount.toFixed(2)} ${p.symbol} (your minimum ${min}).`,
      };
    }
    case "data_stale": {
      const n = snap.errors.length;
      return {
        ...base,
        value: n,
        triggered: n > 0,
        recovered: n === 0,
        title: "Some data can't be refreshed",
        detail: n ? `Sources failing: ${snap.errors.map((e) => e.split(":")[0]).join(", ")}. Affected positions show as unknown, not safe.` : "All sources answered.",
      };
    }
  }
}

/** Plain-language read-back used when Nierwall proposes a watch for confirmation. */
export function describeWatch(kind: Watch["kind"], params: Record<string, any>): string {
  switch (kind) {
    case "health_below":
      return `${protocolName(params.positionId).name}: health factor below ${Number(params.threshold).toFixed(2)}${params.target != null ? `, fixes aim for ${Number(params.target).toFixed(2)}` : ""}`;
    case "liq_distance":
      return `${protocolName(params.positionId).name}: within ${pct(Number(params.pct))} of liquidation`;
    case "price_below":
      return `${coinName(params)} below ${usd(Number(params.price))}`;
    case "price_above":
      return `${coinName(params)} above ${usd(Number(params.price))}`;
    case "price_move":
      return `${coinName(params)} ${Number(params.pct) < 0 ? "drops" : "rises"} ${pct(Math.abs(Number(params.pct)))} from ${usd(Number(params.referencePrice))}`;
    case "balance_min":
      return `${params.walletLabel} holds less than ${params.amount} ${params.symbol}`;
    case "allocation_min":
      return `Keep ${className(params.cls)} at least ${params.pct}% of the portfolio`;
    case "allocation_max":
      return `Keep ${className(params.cls)} at most ${params.pct}% of the portfolio`;
    case "data_stale":
      return "Data sources stop answering";
  }
}

/** Safety rails the AI can't talk down: health this low, or liquidation this close, is always critical. */
const ALWAYS_CRITICAL_HEALTH = 1.1;
const ALWAYS_CRITICAL_DISTANCE = 0.05;

export interface SeverityJudgment {
  severity: "warning" | "critical";
  reason: string;
}

/** The fixed rule's severity, unless the AI judged it from the market context; hard rails always win. */
export function combineSeverity(e: Evaluation, judged: SeverityJudgment | null): { severity: Severity; reason: string | null } {
  const v = e.value;
  const rail = (e.watch.kind === "health_below" && v != null && v < ALWAYS_CRITICAL_HEALTH) || (e.watch.kind === "liq_distance" && v != null && v < ALWAYS_CRITICAL_DISTANCE);
  if (rail) return { severity: "critical", reason: judged?.severity === "critical" ? judged.reason : null };
  return judged ? { severity: judged.severity, reason: judged.reason } : { severity: e.severity, reason: null };
}

/** True when a watch is close to firing, so the scheduler should check more often. */
export function isNearLimit(e: Evaluation): boolean {
  const p = e.watch.params as Record<string, any>;
  if (e.value == null) return e.unknown;
  if (e.watch.kind === "health_below") return e.value < Number(p.threshold) * 1.1;
  if (e.watch.kind === "liq_distance") return e.value < Number(p.pct) * 1.5;
  if (e.watch.kind === "price_below") return e.value < Number(p.price) * 1.03;
  if (e.watch.kind === "price_above") return e.value > Number(p.price) * 0.97;
  if (e.watch.kind === "allocation_min") return e.value < Number(p.pct) + 2;
  if (e.watch.kind === "allocation_max") return e.value > Number(p.pct) - 2;
  if (e.watch.kind === "price_move") return Math.abs(e.value) > Math.abs(Number(p.pct)) * 0.7;
  return false;
}
