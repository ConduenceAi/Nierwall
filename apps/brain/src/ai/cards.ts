import type { Plan } from "../advisor/plans.js";
import { networkName } from "../chains.js";
import type { Alert, FixOption, LendingPosition, TokenAmount, Watch } from "../types.js";

/** One token in a position card: what's supplied (and whether it backs the loan) or what's borrowed. */
export interface CardToken {
  symbol: string;
  amount: number;
  usd: number;
  apr: number | null;
  collateral: boolean;
}

/** Structured UI blocks rendered by the Mac app (and summarized as text for Telegram/CLI). */
export type Card =
  | {
      type: "position";
      positionId: string;
      title: string;
      wallet: string;
      health: number | null;
      floor: number | null;
      liquidationDistance: number | null;
      collateralUsd: number;
      debtUsd: number;
      /** Collateral first, then deposits that don't back the loan. */
      supplied: CardToken[];
      borrowed: CardToken[];
      observedAt: string;
      simulated: boolean;
    }
  | { type: "alert"; alertId: string; incidentId: string; severity: Alert["severity"]; title: string; body: string; simulated: boolean }
  | { type: "fix"; alertId: string; fix: FixOption }
  | { type: "watch_confirm"; watchId: string; label: string }
  | {
      type: "plan";
      planId: string;
      title: string;
      goal: string;
      steps: Array<{ n: number; chain: string; wallet: string; description: string; manual: boolean }>;
      loans: Plan["loans"];
      allocation: Plan["allocation"];
      netWorthBefore: number;
      netWorthAfter: number;
      costUsd: number;
      maxCostUsd: number;
      costReason: string;
      warnings: string[];
      simulated: boolean;
    }
  | { type: "attestation"; model: string; verified: boolean; signatureKind: string | null; verifiedAt: string | null; detail: string };

export interface Reply {
  /** Full answer shown in the panel / sent to Telegram. */
  text: string;
  /** One or two short sentences for text-to-speech. */
  speak: string;
  cards: Card[];
  /** Which engine produced it: the NEAR AI model or the deterministic fallback. */
  via: "near-ai" | "fallback";
}

const cardToken = (t: TokenAmount, collateral: boolean): CardToken => ({ symbol: t.symbol, amount: t.amount, usd: t.usd, apr: t.apr ?? null, collateral });

export function positionCard(p: LendingPosition, watches: Watch[]): Card {
  const floorWatch = watches.find((w) => w.kind === "health_below" && w.status === "active" && (w.params as any).positionId === p.id);
  return {
    type: "position",
    positionId: p.id,
    title: p.positionKey && p.positionKey !== "REGULAR" ? `Rhea · ${p.positionKey.replace(/^shadow_ref_v1-(\d+)$/, "LP #$1")}` : "Rhea · NEAR",
    wallet: p.walletLabel,
    health: p.healthFactor,
    floor: floorWatch ? Number((floorWatch.params as any).threshold) : null,
    liquidationDistance: p.liquidationDistance,
    collateralUsd: p.collateralUsd,
    debtUsd: p.debtUsd,
    supplied: [...p.collateral.map((t) => cardToken(t, true)), ...(p.supplied ?? []).map((t) => cardToken(t, false))],
    borrowed: p.debt.map((t) => cardToken(t, false)),
    observedAt: p.observedAt,
    simulated: p.simulated,
  };
}

export function planCard(p: Plan): Card {
  return {
    type: "plan",
    planId: p.id,
    title: p.title,
    goal: p.goal,
    steps: p.steps.map((s) => ({ n: s.n, chain: networkName(s.chain), wallet: s.wallet, description: s.description, manual: s.execution === "manual" })),
    loans: p.loans,
    allocation: p.allocation,
    netWorthBefore: p.netWorthBefore,
    netWorthAfter: p.netWorthAfter,
    costUsd: p.costUsd,
    maxCostUsd: p.maxCostUsd,
    costReason: p.costReason,
    warnings: p.warnings,
    simulated: p.simulated,
  };
}

export function alertCards(a: Alert): Card[] {
  return [
    { type: "alert", alertId: a.id, incidentId: a.incidentId, severity: a.severity, title: a.title, body: a.body, simulated: a.simulated },
    ...a.fixes.map((fix) => ({ type: "fix" as const, alertId: a.id, fix })),
  ];
}
