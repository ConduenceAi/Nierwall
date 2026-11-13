/**
 * DefiLlama's coins API: free, with no key and no monthly cap, so the brain can price watched coins on every
 * refresh. A key is `coingecko:<coin id>` for a coin or `<chain>:<contract>` for a token. Only these keys are
 * sent, never wallet addresses.
 */
const BASE = "https://coins.llama.fi";

/** Keys per request, so long lists stay well inside URL length limits. */
const BATCH = 50;

/**
 * DefiLlama prices tokens it only finds in DEX pools with a confidence that follows the pool's depth. Below this a
 * price counts as unknown, so a token can't look valuable just because someone seeded a tiny pool.
 */
const MIN_CONFIDENCE = 0.8;

async function get<T>(path: string, timeoutMs: number): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`DefiLlama ${res.status}`);
  return (await res.json()) as T;
}

/** Unique keys, URL-encoded, in comma-separated groups of BATCH. */
function batches(keys: string[]): string[] {
  const unique = [...new Set(keys)].filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < unique.length; i += BATCH) out.push(unique.slice(i, i + BATCH).map(encodeURIComponent).join(","));
  return out;
}

/** Current USD price by key. Keys DefiLlama doesn't know, and prices it isn't confident in, are left out. */
export async function llamaPrices(keys: string[], timeoutMs = 15_000): Promise<Record<string, number>> {
  const replies = await Promise.all(
    batches(keys).map((b) => get<{ coins?: Record<string, { price?: number; confidence?: number }> }>(`/prices/current/${b}`, timeoutMs)),
  );
  const out: Record<string, number> = {};
  for (const j of replies) {
    for (const [k, v] of Object.entries(j.coins ?? {})) if (typeof v.price === "number" && v.price > 0 && (v.confidence ?? 1) >= MIN_CONFIDENCE) out[k] = v.price;
  }
  return out;
}

/** Price change over the last 24 hours by key, in percent. */
export async function llamaChange24h(keys: string[], timeoutMs = 15_000): Promise<Record<string, number>> {
  const replies = await Promise.all(batches(keys).map((b) => get<{ coins?: Record<string, number> }>(`/percentage/${b}?period=24h`, timeoutMs)));
  const out: Record<string, number> = {};
  for (const j of replies) for (const [k, v] of Object.entries(j.coins ?? {})) if (Number.isFinite(v)) out[k] = v;
  return out;
}

/**
 * One price a day over the last `days` days, ending now: days + 1 prices, oldest first, like CoinGecko's daily
 * chart. Days DefiLlama has no price for are missing from the list.
 */
export async function llamaDailyPrices(key: string, days: number, timeoutMs = 15_000): Promise<number[]> {
  const j = await get<{ coins?: Record<string, { prices?: Array<{ price: number }> }> }>(`/chart/${encodeURIComponent(key)}?span=${days + 1}&period=1d`, timeoutMs);
  return (j.coins?.[key]?.prices ?? []).map((x) => x.price);
}
