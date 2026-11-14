import { env } from "../config.js";
import { logger } from "../log.js";
import { llamaChange24h, llamaDailyPrices, llamaPrices } from "./defillama.js";

const log = logger("coins");
const BASE = "https://api.coingecko.com/api/v3";

/** A free CoinGecko key raises its rate limit; without one the public limit applies. */
function headers(): Record<string, string> {
  return env.COINGECKO_API_KEY ? { "x-cg-demo-api-key": env.COINGECKO_API_KEY } : {};
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: headers(), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  return (await res.json()) as T;
}

/** DefiLlama knows coins by their CoinGecko id. */
const llamaKey = (coinId: string) => `coingecko:${coinId}`;

export interface CoinPrice {
  usd: number;
  change24h: number | null;
  /** DefiLlama, or CoinGecko when DefiLlama couldn't answer. */
  source: "defillama" | "coingecko";
}

/**
 * USD prices for CoinGecko coin ids. DefiLlama goes first: it's free, with no key or monthly cap, so the refresh
 * loop can ask every minute. CoinGecko fills in coins DefiLlama doesn't know, or all of them when it's down.
 * Throws only when nothing could be priced. Only coin ids are sent, never addresses.
 */
export async function coinPrices(ids: string[]): Promise<Record<string, CoinPrice>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return {};
  const keys = unique.map(llamaKey);
  const [prices, changes] = await Promise.all([
    llamaPrices(keys).catch((e) => {
      log.warn("defillama prices failed; asking coingecko", { err: String(e).slice(0, 160) });
      return {} as Record<string, number>;
    }),
    llamaChange24h(keys).catch(() => ({}) as Record<string, number>),
  ]);
  const out: Record<string, CoinPrice> = {};
  for (const id of unique) {
    const usd = prices[llamaKey(id)];
    if (usd) out[id] = { usd, change24h: changes[llamaKey(id)] ?? null, source: "defillama" };
  }
  const missing = unique.filter((id) => !out[id]);
  if (missing.length) {
    const cg = await coingeckoPrices(missing).catch((e) => {
      if (!Object.keys(out).length) throw e;
      log.warn("coingecko fallback failed", { coins: missing.length, err: String(e).slice(0, 160) });
      return {};
    });
    Object.assign(out, cg);
  }
  return out;
}

async function coingeckoPrices(ids: string[]): Promise<Record<string, CoinPrice>> {
  const j = await get<Record<string, { usd?: number; usd_24h_change?: number }>>(
    `/simple/price?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=usd&include_24hr_change=true`,
  );
  const out: Record<string, CoinPrice> = {};
  for (const [id, v] of Object.entries(j)) if (typeof v.usd === "number") out[id] = { usd: v.usd, change24h: v.usd_24h_change ?? null, source: "coingecko" };
  return out;
}

export interface CoinMatch {
  coinId: string;
  name: string;
  symbol: string;
  marketCapRank: number | null;
}

/** Coins matching a name or ticker, as CoinGecko ranks them (biggest first). */
export async function searchCoins(query: string): Promise<CoinMatch[]> {
  const j = await get<{ coins?: Array<{ id: string; name: string; symbol: string; market_cap_rank?: number | null }> }>(`/search?query=${encodeURIComponent(query)}`);
  return (j.coins ?? []).slice(0, 5).map((c) => ({ coinId: c.id, name: c.name, symbol: c.symbol.toUpperCase(), marketCapRank: c.market_cap_rank ?? null }));
}

export interface Volatility {
  coinId: string;
  days: number;
  /** Standard deviation of daily moves, in percent. */
  dailyVolPct: number;
  worstDayPct: number;
  /** Worst change over any 7 days in the window, in percent. */
  worstWeekPct: number;
  changePct: number;
}

/** How much a coin has moved over the last `days` days, from one price a day. Cached for an hour. */
const volCache = new Map<string, { at: number; v: Volatility }>();
export async function volatility(coinId: string, days = 90): Promise<Volatility> {
  const hit = volCache.get(`${coinId}:${days}`);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.v;
  let p = (await llamaDailyPrices(llamaKey(coinId), days).catch(() => [] as number[])).filter((x) => x > 0);
  // DefiLlama skips days it has no price for, which would count a two-day move as one day's. CoinGecko's series
  // has no gaps, so it fills in; a gappy series is still used if CoinGecko is down.
  if (p.length <= days) {
    const j = await get<{ prices?: Array<[number, number]> }>(`/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${days}&interval=daily`).catch((e) => {
      if (p.length < 10) throw e;
      return null;
    });
    if (j) p = (j.prices ?? []).map((x) => x[1]).filter((x) => x > 0);
  }
  if (p.length < 10) throw new Error(`Not enough price history for ${coinId}`);
  const moves = p.slice(1).map((x, i) => x / p[i]! - 1);
  const mean = moves.reduce((s, x) => s + x, 0) / moves.length;
  const sd = Math.sqrt(moves.reduce((s, x) => s + (x - mean) ** 2, 0) / (moves.length - 1));
  const weeks = p.slice(7).map((x, i) => x / p[i]! - 1);
  const pct = (x: number) => Number((x * 100).toFixed(1));
  const v: Volatility = { coinId, days, dailyVolPct: pct(sd), worstDayPct: pct(Math.min(...moves)), worstWeekPct: pct(Math.min(...weeks)), changePct: pct(p.at(-1)! / p[0]! - 1) };
  volCache.set(`${coinId}:${days}`, { at: Date.now(), v });
  return v;
}
