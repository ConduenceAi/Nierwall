import { env } from "./config.js";

/** An EVM network the Snap can check: where to read and simulate, and where to find prices. */
export interface EvmChain {
  id: number;
  name: string;
  rpc: string;
  /** The node supports eth_simulateV1, so Nierwall sees what a transaction sends and gets. Otherwise it only decodes the call. */
  simulate: boolean;
  /** Chain name in the NEAR Intents token list (prices). */
  intents: string | null;
  /** CoinGecko asset platform (prices of other tokens). */
  coingecko: string | null;
  native: { symbol: string; coingeckoId: string | null };
}

const pn = (host: string) => `https://${host}.publicnode.com`;
const ETH = { symbol: "ETH", coingeckoId: "ethereum" };

// Simulation support checked against each public node on 2026-11-13.
const CHAINS: EvmChain[] = [
  { id: 1, name: "Ethereum", rpc: pn("ethereum-rpc"), simulate: true, intents: "eth", coingecko: "ethereum", native: ETH },
  { id: 8453, name: "Base", rpc: pn("base-rpc"), simulate: true, intents: "base", coingecko: "base", native: ETH },
  { id: 42161, name: "Arbitrum", rpc: pn("arbitrum-one-rpc"), simulate: true, intents: "arb", coingecko: "arbitrum-one", native: ETH },
  { id: 10, name: "OP Mainnet", rpc: pn("optimism-rpc"), simulate: true, intents: "op", coingecko: "optimistic-ethereum", native: ETH },
  { id: 137, name: "Polygon", rpc: pn("polygon-bor-rpc"), simulate: true, intents: "pol", coingecko: "polygon-pos", native: { symbol: "POL", coingeckoId: "polygon-ecosystem-token" } },
  { id: 56, name: "BNB Chain", rpc: pn("bsc-rpc"), simulate: true, intents: "bsc", coingecko: "binance-smart-chain", native: { symbol: "BNB", coingeckoId: "binancecoin" } },
  { id: 100, name: "Gnosis", rpc: pn("gnosis-rpc"), simulate: true, intents: "gnosis", coingecko: "xdai", native: { symbol: "xDAI", coingeckoId: "xdai" } },
  { id: 42220, name: "Celo", rpc: pn("celo-rpc"), simulate: true, intents: null, coingecko: "celo", native: { symbol: "CELO", coingeckoId: "celo" } },
  { id: 59144, name: "Linea", rpc: pn("linea-rpc"), simulate: true, intents: null, coingecko: "linea", native: ETH },
  { id: 80094, name: "Berachain", rpc: pn("berachain-rpc"), simulate: true, intents: "bera", coingecko: "berachain", native: { symbol: "BERA", coingeckoId: "berachain-bera" } },
  { id: 146, name: "Sonic", rpc: pn("sonic-rpc"), simulate: true, intents: null, coingecko: "sonic", native: { symbol: "S", coingeckoId: "sonic-3" } },
  { id: 130, name: "Unichain", rpc: pn("unichain-rpc"), simulate: true, intents: null, coingecko: "unichain", native: ETH },
  { id: 5000, name: "Mantle", rpc: pn("mantle-rpc"), simulate: true, intents: null, coingecko: "mantle", native: { symbol: "MNT", coingeckoId: "mantle" } },
  { id: 43114, name: "Avalanche", rpc: pn("avalanche-c-chain-rpc"), simulate: false, intents: "avax", coingecko: "avalanche", native: { symbol: "AVAX", coingeckoId: "avalanche-2" } },
  { id: 534352, name: "Scroll", rpc: pn("scroll-rpc"), simulate: false, intents: "scroll", coingecko: "scroll", native: ETH },
  { id: 324, name: "zkSync Era", rpc: "https://mainnet.era.zksync.io", simulate: false, intents: null, coingecko: "zksync", native: ETH },
  { id: 1313161554, name: "Aurora", rpc: "https://mainnet.aurora.dev", simulate: false, intents: null, coingecko: "aurora", native: ETH },
];

/** A known EVM network by chain id. RPC_URL_<id> in .env overrides its node (Base uses BASE_RPC_URL). */
export function evmChain(id: number): EvmChain | undefined {
  const c = CHAINS.find((x) => x.id === id);
  if (!c) return undefined;
  const override = id === 8453 ? env.BASE_RPC_URL : process.env[`RPC_URL_${id}`];
  return override ? { ...c, rpc: override } : c;
}

export const EVM_CHAIN_NAMES = CHAINS.map((c) => c.name);
