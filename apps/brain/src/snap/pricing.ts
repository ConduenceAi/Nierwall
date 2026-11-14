import { erc20Abi, getAddress } from "viem";
import { evmClient, type EvmChain } from "../chains.js";
import { env } from "../config.js";
import { llamaPrices } from "../sources/defillama.js";
import { intentsTokens } from "../tokens.js";

/** Where eth_simulateV1 reports native coin moves (ERC-7528). */
export const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export interface TokenMeta {
  symbol: string;
  decimals: number;
  priceUsd: number | null;
}

const cgHeaders = (): Record<string, string> => (env.COINGECKO_API_KEY ? { "x-cg-demo-api-key": env.COINGECKO_API_KEY } : {});
async function cg<T>(path: string): Promise<T | null> {
  const res = await fetch(`https://api.coingecko.com/api/v3${path}`, { headers: cgHeaders(), signal: AbortSignal.timeout(6000) }).catch(() => null);
  return res?.ok ? ((await res.json()) as T) : null;
}

/**
 * USD prices for token contracts (lowercase addresses) on a chain, and for NATIVE by the coin's CoinGecko id, in one
 * DefiLlama request. CoinGecko fills in what DefiLlama doesn't price. Only token contracts and coin ids are sent,
 * never wallet addresses.
 */
export async function tokenPrices(chain: EvmChain, addresses: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const coinId = chain.native.coingeckoId;
  const key = (a: string) => (a === NATIVE ? (coinId ? `coingecko:${coinId}` : null) : chain.defillama ? `${chain.defillama}:${a}` : null);
  const llama = await llamaPrices(addresses.map(key).filter((k) => k !== null), 6000).catch(() => ({}) as Record<string, number>);
  for (const a of addresses) {
    const usd = llama[key(a) ?? ""];
    if (usd) out.set(a, usd);
  }

  const tokens = addresses.filter((a) => a !== NATIVE && !out.has(a));
  const native = coinId && addresses.includes(NATIVE) && !out.has(NATIVE);
  const [byContract, byId] = await Promise.all([
    tokens.length && chain.coingecko ? cg<Record<string, { usd?: number }>>(`/simple/token_price/${chain.coingecko}?contract_addresses=${tokens.join(",")}&vs_currencies=usd`) : null,
    native ? cg<Record<string, { usd?: number }>>(`/simple/price?ids=${coinId}&vs_currencies=usd`) : null,
  ]);
  for (const a of tokens) {
    const usd = byContract?.[a]?.usd;
    if (usd) out.set(a, usd);
  }
  const usd = coinId ? byId?.[coinId]?.usd : undefined;
  if (usd) out.set(NATIVE, usd);
  return out;
}

/**
 * Symbol, decimals and USD price for tokens on any EVM chain: the NEAR Intents list first, then DefiLlama (or
 * CoinGecko) by contract, then the token contract itself for the name. Keys are lowercase addresses; NATIVE is the
 * chain's coin.
 */
export async function resolveTokens(chain: EvmChain, addresses: string[]): Promise<Map<string, TokenMeta>> {
  const out = new Map<string, TokenMeta>();
  const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const list = (await intentsTokens().catch(() => [])).filter((t) => chain.intents && t.blockchain === chain.intents && !t.symbol.includes("DEPRECATED"));
  for (const a of wanted) {
    const t = a === NATIVE ? list.find((x) => !x.contractAddress) : list.find((x) => x.contractAddress?.toLowerCase() === a);
    if (t) out.set(a, { symbol: t.symbol, decimals: t.decimals, priceUsd: Number(t.price) > 0 ? Number(t.price) : null });
  }

  const missing = wanted.filter((a) => !out.has(a) && a !== NATIVE);
  const native = wanted.includes(NATIVE) && !out.get(NATIVE)?.priceUsd;
  const prices = await tokenPrices(chain, native ? [...missing, NATIVE] : missing);
  if (missing.length) {
    const client = evmClient(chain);
    await Promise.all(
      missing.map(async (a) => {
        const [symbol, decimals] = await Promise.all([
          client.readContract({ address: getAddress(a), abi: erc20Abi, functionName: "symbol" }).catch(() => null),
          client.readContract({ address: getAddress(a), abi: erc20Abi, functionName: "decimals" }).catch(() => null),
        ]);
        if (symbol != null && decimals != null) out.set(a, { symbol: String(symbol), decimals: Number(decimals), priceUsd: prices.get(a) ?? null });
      }),
    );
  }
  if (native) out.set(NATIVE, { symbol: chain.native.symbol, decimals: 18, priceUsd: prices.get(NATIVE) ?? null });
  return out;
}
