import type { Symbol, TokenAmount } from "../types.js";

/** Which price-risk bucket a token belongs to. Stablecoins and unknowns don't move with a shock. */
export function riskClass(symbol: string): Symbol | "STABLE" | "OTHER" {
  const s = symbol.toUpperCase();
  if (s.includes("ETH")) return "ETH";
  if (s.includes("NEAR")) return "NEAR";
  if (/(USDC|USDT|USDBC|GHO|DAI|USDE|FRAX|LUSD|PYUSD|EURC)/.test(s)) return "STABLE";
  return "OTHER";
}

export interface Weighted {
  cls: ReturnType<typeof riskClass>;
  /** Collateral: usd * weight. Debt: weighted debt usd. */
  value: number;
}

/**
 * Fraction a price class can fall before health reaches 1.0, holding all else equal.
 * Health(x) = (A(1-x) + B) / (Dc(1-x) + Do), where A/Dc are the class's weighted collateral/debt.
 * Returns null when a fall in that class cannot cause liquidation, 0 when already liquidatable.
 */
export function liquidationDrop(cls: Symbol, collateral: Weighted[], debt: Weighted[]): number | null {
  const A = collateral.filter((c) => c.cls === cls).reduce((s, c) => s + c.value, 0);
  const B = collateral.filter((c) => c.cls !== cls).reduce((s, c) => s + c.value, 0);
  const Dc = debt.filter((d) => d.cls === cls).reduce((s, d) => s + d.value, 0);
  const Do = debt.filter((d) => d.cls !== cls).reduce((s, d) => s + d.value, 0);
  if (A + B <= 0 || Dc + Do <= 0) return null;
  if (A <= Dc) return null; // a fall in this class does not hurt health
  const keep = (Do - B) / (A - Dc); // remaining fraction (1-x) at health = 1
  if (keep <= 0) return null; // other collateral alone covers the debt
  const drop = 1 - keep;
  return drop <= 0 ? 0 : Math.min(drop, 1);
}

/** The collateral class carrying the most weighted collateral (ETH or NEAR), if any. */
export function mainCollateralClass(collateral: Weighted[]): Symbol | null {
  const totals = new Map<Symbol, number>();
  for (const c of collateral) if (c.cls === "ETH" || c.cls === "NEAR") totals.set(c.cls, (totals.get(c.cls) ?? 0) + c.value);
  let best: Symbol | null = null;
  let bestV = 0;
  for (const [k, v] of totals) if (v > bestV) [best, bestV] = [k, v];
  return best;
}

export function sumUsd(items: TokenAmount[]) {
  return items.reduce((s, t) => s + t.usd, 0);
}
