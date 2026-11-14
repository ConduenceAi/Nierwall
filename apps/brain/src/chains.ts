import { createPublicClient, fallback, http, type Chain as ViemChain, type PublicClient } from "viem";
import { arbitrum, aurora, avalanche, base, berachain, bsc, celo, gnosis, linea, mainnet, mantle, optimism, polygon, scroll, sonic, unichain, zksync } from "viem/chains";
import { env, type EvmNetwork, type Network } from "./config.js";

/** An EVM network Nierwall works with: where to read and simulate, and where to find prices. */
export interface EvmChain {
  id: number;
  name: string;
  /** Public nodes, tried in order: one that's down or slow falls through to the next. */
  rpcs: string[];
  /** The first node supports eth_simulateV1, so Nierwall sees what a transaction sends and gets. Otherwise it only decodes the call. */
  simulate: boolean;
  /** Network name in NEAR Intents, which can move money there. Null: the Snap checks it, but wallets aren't read there. */
  intents: EvmNetwork | null;
  /** DefiLlama chain prefix, as in `base:0x…` (prices of other tokens). */
  defillama: string | null;
  /** CoinGecko asset platform (prices DefiLlama doesn't have). */
  coingecko: string | null;
  native: { symbol: string; coingeckoId: string | null };
  /** viem's definition: Multicall3 address and formatters. */
  viem: ViemChain;
}

const pn = (host: string) => `https://${host}.publicnode.com`;
const drpc = (name: string) => `https://${name}.drpc.org`;
const ETH = { symbol: "ETH", coingeckoId: "ethereum" };

// Simulation support checked against each first node on 2026-11-13, and every drpc.org backup answered with the right
// chain id. DefiLlama prefixes checked the same day with a live price for each chain's USDC or wrapped coin.
const CHAINS: EvmChain[] = [
  { id: 1, name: "Ethereum", rpcs: [pn("ethereum"), drpc("eth")], simulate: true, intents: "eth", defillama: "ethereum", coingecko: "ethereum", native: ETH, viem: mainnet },
  { id: 8453, name: "Base", rpcs: ["https://mainnet.base.org", drpc("base")], simulate: true, intents: "base", defillama: "base", coingecko: "base", native: ETH, viem: base },
  { id: 42161, name: "Arbitrum", rpcs: [pn("arbitrum-one-rpc"), drpc("arbitrum")], simulate: true, intents: "arb", defillama: "arbitrum", coingecko: "arbitrum-one", native: ETH, viem: arbitrum },
  { id: 10, name: "OP Mainnet", rpcs: [pn("optimism-rpc"), drpc("optimism")], simulate: true, intents: "op", defillama: "optimism", coingecko: "optimistic-ethereum", native: ETH, viem: optimism },
  { id: 137, name: "Polygon", rpcs: [pn("polygon-bor-rpc"), drpc("polygon")], simulate: true, intents: "pol", defillama: "polygon", coingecko: "polygon-pos", native: { symbol: "POL", coingeckoId: "polygon-ecosystem-token" }, viem: polygon },
  { id: 56, name: "BNB Chain", rpcs: [pn("bsc-rpc"), drpc("bsc")], simulate: true, intents: "bsc", defillama: "bsc", coingecko: "binance-smart-chain", native: { symbol: "BNB", coingeckoId: "binancecoin" }, viem: bsc },
  { id: 100, name: "Gnosis", rpcs: [pn("gnosis-rpc"), drpc("gnosis")], simulate: true, intents: "gnosis", defillama: "xdai", coingecko: "xdai", native: { symbol: "xDAI", coingeckoId: "xdai" }, viem: gnosis },
  { id: 42220, name: "Celo", rpcs: [pn("celo-rpc"), drpc("celo")], simulate: true, intents: null, defillama: "celo", coingecko: "celo", native: { symbol: "CELO", coingeckoId: "celo" }, viem: celo },
  { id: 59144, name: "Linea", rpcs: [pn("linea-rpc"), drpc("linea")], simulate: true, intents: null, defillama: "linea", coingecko: "linea", native: ETH, viem: linea },
  { id: 80094, name: "Berachain", rpcs: [pn("berachain-rpc"), drpc("berachain")], simulate: true, intents: "bera", defillama: "berachain", coingecko: "berachain", native: { symbol: "BERA", coingeckoId: "berachain-bera" }, viem: berachain },
  { id: 146, name: "Sonic", rpcs: [pn("sonic-rpc"), drpc("sonic")], simulate: true, intents: null, defillama: "sonic", coingecko: "sonic", native: { symbol: "S", coingeckoId: "sonic-3" }, viem: sonic },
  { id: 130, name: "Unichain", rpcs: [pn("unichain-rpc"), drpc("unichain")], simulate: true, intents: null, defillama: "unichain", coingecko: "unichain", native: ETH, viem: unichain },
  { id: 5000, name: "Mantle", rpcs: [pn("mantle-rpc"), drpc("mantle")], simulate: true, intents: null, defillama: "mantle", coingecko: "mantle", native: { symbol: "MNT", coingeckoId: "mantle" }, viem: mantle },
  { id: 43114, name: "Avalanche", rpcs: [pn("avalanche-c-chain-rpc"), drpc("avalanche")], simulate: false, intents: "avax", defillama: "avax", coingecko: "avalanche", native: { symbol: "AVAX", coingeckoId: "avalanche-2" }, viem: avalanche },
  { id: 534352, name: "Scroll", rpcs: [pn("scroll-rpc"), drpc("scroll")], simulate: false, intents: "scroll", defillama: "scroll", coingecko: "scroll", native: ETH, viem: scroll },
  { id: 324, name: "zkSync Era", rpcs: ["https://mainnet.era.zksync.io", drpc("zksync")], simulate: false, intents: null, defillama: "era", coingecko: "zksync", native: ETH, viem: zksync },
  { id: 1313161554, name: "Aurora", rpcs: ["https://mainnet.aurora.dev", drpc("aurora")], simulate: false, intents: null, defillama: "aurora", coingecko: "aurora", native: ETH, viem: aurora },
];

/** A known EVM network by chain id. RPC_URL_<id> in .env puts your own node first (for Base, BASE_RPC_URL also works). */
export function evmChain(id: number): EvmChain | undefined {
  const c = CHAINS.find((x) => x.id === id);
  if (!c) return undefined;
  const own = (id === 8453 && env.BASE_RPC_URL) || process.env[`RPC_URL_${id}`];
  return own ? { ...c, rpcs: [own, ...c.rpcs] } : c;
}

/** The EVM network NEAR Intents calls `network`. */
export function evmNetwork(network: EvmNetwork): EvmChain {
  const c = CHAINS.find((x) => x.intents === network);
  if (!c) throw new Error(`Unknown EVM network ${network}`);
  return evmChain(c.id)!;
}

/** The network's name for people: "Arbitrum", "NEAR", "Solana". */
export function networkName(network: Network | string): string {
  if (network === "near") return "NEAR";
  if (network === "sol") return "Solana";
  return CHAINS.find((c) => c.intents === network)?.name ?? network;
}

const clients = new Map<number, PublicClient>();

/** A read client for a network, cached. Reads are batched through Multicall3, and a failing node falls through to the next. */
export function evmClient(chain: EvmChain): PublicClient {
  let c = clients.get(chain.id);
  if (!c) {
    c = createPublicClient({
      chain: chain.viem,
      // 5 seconds per node, then the next one; one more pass over them all if every node failed.
      transport: fallback(chain.rpcs.map((url) => http(url, { timeout: 5000, retryCount: 0 })), { retryCount: 1 }),
      batch: { multicall: true },
    }) as PublicClient;
    clients.set(chain.id, c);
  }
  return c;
}

export const EVM_CHAIN_NAMES = CHAINS.map((c) => c.name);
