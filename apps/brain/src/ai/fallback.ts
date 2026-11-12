import type { Brain } from "../brain.js";
import { scenarioLabel } from "../scenario.js";
import { positionCard, alertCards, type Reply } from "./cards.js";

const n2 = (x: number) => x.toFixed(2);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * Deterministic answers built only from computed numbers. Used when the NEAR AI model is unavailable,
 * and as the safety net for alerts: Nierwall never goes silent because a model is down.
 */
export function fallbackReply(brain: Brain, text: string): Reply {
  const snap = brain.latestSnapshot();
  const watches = brain.store.listWatches("active");
  const q = text.toLowerCase();
  if (!snap) return { text: "I haven't finished my first check yet. Try again in a few seconds.", speak: "Still loading. Try again in a moment.", cards: [], via: "fallback" };

  const sim = scenarioLabel(snap.scenario);
  const open = brain.store.listIncidents("open");

  if (/alert|wrong|problem|issue|why/.test(q) && open.length) {
    const alerts = brain.store.listAlerts(5).filter((a) => open.some((i) => i.id === a.incidentId));
    const top = alerts[0];
    return {
      text: `${open.length} open ${open.length === 1 ? "issue" : "issues"}. ${top ? `${top.title}. ${top.body}` : open[0]!.title}`,
      speak: top ? `${top.title}.` : `${open.length} open issues.`,
      cards: top ? alertCards(top) : [],
      via: "fallback",
    };
  }

  const positions = snap.positions.filter((p) => {
    if (/rhea|near/.test(q) && !/aave|base|eth/.test(q)) return p.protocol === "rhea";
    if (/aave|base/.test(q) && !/rhea/.test(q)) return p.protocol === "aave";
    return true;
  });
  const lines = positions.map((p) => {
    const name = p.protocol === "rhea" ? "Rhea on NEAR" : "Aave on Base";
    if (p.healthFactor == null) return `${name} has no debt.`;
    const floor = watches.find((w) => w.kind === "health_below" && (w.params as any).positionId === p.id);
    const f = floor ? ` (floor ${n2(Number((floor.params as any).threshold))})` : "";
    const d = p.liquidationDistance != null ? `, liquidation after a ${pct(p.liquidationDistance)} drop` : "";
    return `${name}: health ${n2(p.healthFactor)}${f}${d}.`;
  });
  const status = open.length ? `${open.length} open ${open.length === 1 ? "issue" : "issues"}.` : "Nothing needs you right now.";
  const prices = Object.values(snap.prices).map((p) => `${p!.symbol} $${p!.usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`).join(", ");
  return {
    text: `${sim ? `${sim}. ` : ""}${lines.join(" ")} ${status} Prices: ${prices}.`,
    speak: `${lines[0] ?? "No positions found."} ${status}`,
    cards: positions.map((p) => positionCard(p, watches)),
    via: "fallback",
  };
}
