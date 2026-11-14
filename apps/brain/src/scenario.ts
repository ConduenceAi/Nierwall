import { env } from "./config.js";
import type { Store } from "./store.js";
import type { ScenarioState, Symbol } from "./types.js";

const KEY = "scenario";

/** Scenario mode applies labeled price shocks to real positions, so you can see an alert without waiting for a crash. */
export class Scenario {
  constructor(private store: Store) {}

  get(): ScenarioState | null {
    const s = this.store.kvGet<ScenarioState>(KEY);
    return s?.active ? s : null;
  }

  start(shocks: Partial<Record<Symbol, number>>, note = "") {
    if (env.SCENARIO_MODE !== "1") throw new Error("Scenario mode is disabled (SCENARIO_MODE=0)");
    for (const [k, v] of Object.entries(shocks)) {
      if (typeof v !== "number" || v <= -0.95 || v >= 5) throw new Error(`Shock for ${k} out of range: ${v}`);
    }
    const s: ScenarioState = { active: true, shocks, startedAt: new Date().toISOString(), note };
    this.store.kvSet(KEY, s);
    return s;
  }

  clear() {
    this.store.kvDelete(KEY);
  }
}

/** Human label, e.g. "SIMULATED: NEAR -9%". */
export function scenarioLabel(s: ScenarioState | null) {
  if (!s?.active) return "";
  const parts = Object.entries(s.shocks).map(([k, v]) => `${k} ${v! > 0 ? "+" : ""}${Math.round(v! * 1000) / 10}%`);
  return `SIMULATED: ${parts.join(", ")}`;
}
