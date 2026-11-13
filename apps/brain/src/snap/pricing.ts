import { createPublicClient, getAddress, http, type PublicClient } from "viem";
import type { EvmChain } from "../chains.js";
import { env } from "../config.js";
import { erc20Abi } from "../protocols/aave.js";
import { intentsTokens } from "../tokens.js";

/** Where eth_simulateV1 reports native coin moves (ERC-7528). */
export const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export interface TokenMeta {
  symbol: string;
  decimals: number;
  priceUsd: number | null;
}

const clients = new Map<number, PublicClient>();
export function chainClient(chain: EvmChain): PublicClient {
  let c = clients.get(chain.id);
  if (!c) {
    c = createPublicClient({ transport: http(chain.rpc, { timeout: 8000 }) });
    clients.set(chain.id, c);
  }
  return c;
}

const cgHeaders = (): Record<string, string> => (env.COINGECKO_API_KEY ? { "x-cg-demo-api-key": env.COINGECKO_API_KEY } : {});
async function cg<T>(path: string): Promise<T | null> {
  const res = await fetch(`https://api.coingecko.com/api/v3${path}`, { headers: cgHeaders(), signal: AbortSignal.timeout(6000) }).catch(() => null);
  return res?.ok ? ((await res.json()) as T) : null;
}

/**
 * Symbol, decimals and USD price for tokens on any EVM chain: the NEAR Intents list first, then CoinGecko by
 * contract, then the token contract itself for the name. Keys are lowercase addresses; NATIVE is the chain's coin.
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
  if (missing.length && chain.coingecko) {
    const prices = await cg<Record<string, { usd?: number }>>(`/simple/token_price/${chain.coingecko}?contract_addresses=${missing.join(",")}&vs_currencies=usd`);
    const client = chainClient(chain);
    await Promise.all(
      missing.map(async (a) => {
        const [symbol, decimals] = await Promise.all([
          client.readContract({ address: getAddress(a), abi: erc20Abi, functionName: "symbol" }).catch(() => null),
          client.readContract({ address: getAddress(a), abi: erc20Abi, functionName: "decimals" }).catch(() => null),
        ]);
        if (symbol != null && decimals != null) out.set(a, { symbol: String(symbol), decimals: Number(decimals), priceUsd: prices?.[a]?.usd ?? null });
      }),
    );
  }
  if (wanted.includes(NATIVE) && !out.get(NATIVE)?.priceUsd) {
    const id = chain.native.coingeckoId;
    const p = id ? await cg<Record<string, { usd?: number }>>(`/simple/price?ids=${id}&vs_currencies=usd`) : null;
    out.set(NATIVE, { symbol: chain.native.symbol, decimals: 18, priceUsd: (id && p?.[id]?.usd) || null });
  }
  return out;
}
