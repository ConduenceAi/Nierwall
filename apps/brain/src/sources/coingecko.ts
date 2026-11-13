import { env } from "../config.js";

const BASE = "https://api.coingecko.com/api/v3";

/** A free demo key raises CoinGecko's rate limit; without one the public limit applies. */
function headers(): Record<string, string> {
  return env.COINGECKO_API_KEY ? { "x-cg-demo-api-key": env.COINGECKO_API_KEY } : {};
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: headers(), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  return (await res.json()) as T;
}

export interface CoinPrice {
  usd: number;
  change24h: number | null;
}

/** USD prices for CoinGecko coin ids, in one request. Only coin ids are sent, never addresses. */
export async function coinPrices(ids: string[]): Promise<Record<string, CoinPrice>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return {};
  const j = await get<Record<string, { usd?: number; usd_24h_change?: number }>>(
    `/simple/price?ids=${encodeURIComponent(unique.join(","))}&vs_currencies=usd&include_24hr_change=true`,
  );
  const out: Record<string, CoinPrice> = {};
  for (const [id, v] of Object.entries(j)) if (typeof v.usd === "number") out[id] = { usd: v.usd, change24h: v.usd_24h_change ?? null };
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

/** How much a coin has moved over the last `days` days, from daily closes. Cached for an hour. */
const volCache = new Map<string, { at: number; v: Volatility }>();
export async function volatility(coinId: string, days = 90): Promise<Volatility> {
  const hit = volCache.get(`${coinId}:${days}`);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.v;
  const j = await get<{ prices?: Array<[number, number]> }>(`/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${days}&interval=daily`);
  const p = (j.prices ?? []).map((x) => x[1]).filter((x) => x > 0);
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
