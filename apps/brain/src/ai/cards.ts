import type { Alert, FixOption, LendingPosition, Watch } from "../types.js";

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
      observedAt: string;
      simulated: boolean;
    }
  | { type: "alert"; alertId: string; incidentId: string; severity: Alert["severity"]; title: string; body: string; simulated: boolean }
  | { type: "fix"; alertId: string; fix: FixOption }
  | { type: "watch_confirm"; watchId: string; label: string }
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

export function positionCard(p: LendingPosition, watches: Watch[]): Card {
  const floorWatch = watches.find((w) => w.kind === "health_below" && w.status === "active" && (w.params as any).positionId === p.id);
  return {
    type: "position",
    positionId: p.id,
    title: p.protocol === "rhea" ? "Rhea · NEAR" : "Aave V3 · Base",
    wallet: p.walletLabel,
    health: p.healthFactor,
    floor: floorWatch ? Number((floorWatch.params as any).threshold) : null,
    liquidationDistance: p.liquidationDistance,
    collateralUsd: p.collateralUsd,
    debtUsd: p.debtUsd,
    observedAt: p.observedAt,
    simulated: p.simulated,
  };
}

export function alertCards(a: Alert): Card[] {
  return [
    { type: "alert", alertId: a.id, incidentId: a.incidentId, severity: a.severity, title: a.title, body: a.body, simulated: a.simulated },
    ...a.fixes.map((fix) => ({ type: "fix" as const, alertId: a.id, fix })),
  ];
}
