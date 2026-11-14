import { logger } from "../log.js";
import type { PriceInfo, ScenarioState, Symbol } from "../types.js";
import { coinPrices } from "./coins.js";

const log = logger("prices");

/** Applies scenario shocks. Correlated assets (wstETH, stNEAR...) move with their base asset. */
export function applyShock(sym: Symbol, usd: number, scenario: ScenarioState | null): { usd: number; simulated: boolean } {
  const shock = scenario?.active ? scenario.shocks[sym] : undefined;
  if (shock === undefined || shock === 0) return { usd, simulated: false };
  return { usd: usd * (1 + shock), simulated: true };
}

type RawPrices = Partial<Record<Symbol, { usd: number; source: PriceInfo["source"] }>>;

/**
 * The oracle price that drives Rhea's liquidations: Pyth, as Rhea reads it, for NEAR. ETH and USDC come from the
 * market. Loaded lazily to avoid import cycles.
 */
async function oraclePrices(): Promise<RawPrices> {
  const out: RawPrices = {};
  const [{ rheaAssets }, { ADDRESSES }] = await Promise.all([import("../protocols/rhea.js"), import("../config.js")]);
  try {
    const near = Number((await rheaAssets())[ADDRESSES.near.wnear]?.price?.usd ?? 0);
    if (near > 0) out.NEAR = { usd: near, source: "rhea-pyth" };
  } catch (e) {
    log.warn("rhea prices unavailable", { err: String(e).slice(0, 160) });
  }
  return out;
}

const COIN_IDS: Record<Symbol, string> = { ETH: "ethereum", NEAR: "near", USDC: "usd-coin" };

/** Market prices for what the oracles missed: DefiLlama, or CoinGecko when DefiLlama can't answer. */
async function marketPrices(symbols: Symbol[]): Promise<RawPrices> {
  const coins = await coinPrices(symbols.map((s) => COIN_IDS[s]));
  const out: RawPrices = {};
  for (const s of symbols) {
    const c = coins[COIN_IDS[s]];
    if (c) out[s] = { usd: c.usd, source: c.source };
  }
  return out;
}

/** Latest prices with scenario shocks applied. Oracles first, market prices for anything missing. */
export async function fetchPrices(scenario: ScenarioState | null): Promise<Partial<Record<Symbol, PriceInfo>>> {
  let raw = await oraclePrices().catch((e) => {
    log.warn("oracle prices failed", { err: String(e).slice(0, 160) });
    return {} as RawPrices;
  });
  const missing = (["ETH", "NEAR", "USDC"] as Symbol[]).filter((s) => !raw[s]);
  if (missing.length) {
    const market = await marketPrices(missing).catch((e) => {
      log.warn("market prices failed", { err: String(e).slice(0, 160) });
      return {} as RawPrices;
    });
    raw = { ...market, ...raw };
  }
  const now = Math.floor(Date.now() / 1000);
  const out: Partial<Record<Symbol, PriceInfo>> = {};
  for (const [sym, p] of Object.entries(raw) as Array<[Symbol, { usd: number; source: PriceInfo["source"] }]>) {
    const shocked = applyShock(sym, p.usd, scenario);
    out[sym] = { symbol: sym, usd: shocked.usd, publishTime: now, source: p.source, simulated: shocked.simulated };
  }
  return out;
}
