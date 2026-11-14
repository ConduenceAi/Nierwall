import { parseUnits } from "viem";
import { EVM_NETWORKS, type Network } from "./config.js";
import { logger } from "./log.js";

const log = logger("tokens");

/** A token Nierwall can value and swap: one entry of the NEAR Intents (1Click) token list. */
export interface TokenInfo {
  /** Where it lives: NEAR, an EVM network by its NEAR Intents name (eth, base, arb…), or Solana (sol). */
  chain: Network;
  symbol: string;
  decimals: number;
  /** NEAR Intents asset id, used in quotes. */
  assetId: string;
  /** ERC-20 address (lowercase) on an EVM network, NEP-141 account on NEAR, or SPL mint on Solana; null for each network's own coin (ETH, NEAR, SOL…). */
  contract: string | null;
  coingeckoId: string | null;
  /** USD price from the NEAR Intents list, refreshed with it. */
  priceUsd: number | null;
}

export interface RawToken {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
  contractAddress?: string | null;
  coingeckoId?: string | null;
  price?: number | string | null;
}

let cache: { at: number; raw: RawToken[]; tokens: TokenInfo[] } | null = null;

/** The whole NEAR Intents token list, every chain, with prices. Cached for 5 minutes. */
export async function intentsTokens(): Promise<RawToken[]> {
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.raw;
  try {
    const res = await fetch("https://1click.chaindefuser.com/v0/tokens", { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`1Click tokens ${res.status}`);
    const raw = (await res.json()) as RawToken[];
    cache = { at: Date.now(), raw, tokens: parseTokenList(raw) };
    return raw;
  } catch (e) {
    if (cache) {
      log.warn("token list refresh failed; using the cached one", { err: String(e).slice(0, 120) });
      return cache.raw;
    }
    throw e;
  }
}

/** Tokens on NEAR, the EVM networks and Solana that NEAR Intents can swap, with prices. */
export async function tokenList(): Promise<TokenInfo[]> {
  await intentsTokens();
  return cache!.tokens;
}

const NETWORKS = new Set<string>([...EVM_NETWORKS, "near", "sol"]);

export function parseTokenList(raw: RawToken[]): TokenInfo[] {
  const tokens: TokenInfo[] = [];
  for (const t of raw) {
    // Old entries NEAR Intents keeps for existing balances, like "POL(DEPRECATED)", aren't offered.
    if (!NETWORKS.has(t.blockchain) || t.symbol.includes("(DEPRECATED)")) continue;
    const price = Number(t.price ?? 0);
    // EVM addresses are compared in lowercase; NEAR accounts and Solana mints (base58) are case-sensitive as they are.
    const contract = t.contractAddress ? (t.blockchain === "near" || t.blockchain === "sol" ? t.contractAddress : t.contractAddress.toLowerCase()) : null;
    tokens.push({ chain: t.blockchain as Network, symbol: t.symbol, decimals: t.decimals, assetId: t.assetId, contract, coingeckoId: t.coingeckoId ?? null, priceUsd: price > 0 ? price : null });
  }
  // Native NEAR swaps through wNEAR: it's wrapped first, then deposited.
  const wnear = tokens.find((t) => t.chain === "near" && t.contract === "wrap.near");
  if (wnear) tokens.push({ ...wnear, symbol: "NEAR", contract: null, coingeckoId: wnear.coingeckoId ?? "near" });
  return tokens;
}

/** Finds a token on a network by symbol (case-insensitive) or contract. "NEAR" is native NEAR, "wNEAR" the wrapped token. */
export function findToken(tokens: TokenInfo[], chain: Network, query: string): TokenInfo | undefined {
  const q = query.trim().toLowerCase();
  const onChain = tokens.filter((t) => t.chain === chain);
  return onChain.find((t) => t.symbol.toLowerCase() === q) ?? onChain.find((t) => t.contract === q);
}

/** Token units to the integer amount used on-chain, without float drift. */
export function toRaw(amount: number, decimals: number): bigint {
  const s = amount.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: Math.min(decimals, 12) });
  return parseUnits(s, decimals);
}
