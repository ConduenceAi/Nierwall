import { formatUnits, getAddress, parseAbi } from "viem";
import { evmClient, evmNetwork } from "./chains.js";
import { ADDRESSES, EVM_NETWORKS, type EvmNetwork, type Network, type Wallet } from "./config.js";
import { logger } from "./log.js";
import { nearBalances } from "./protocols/rhea.js";
import { riskClass } from "./protocols/risk.js";
import { applyShock } from "./sources/prices.js";
import { tokenList, type TokenInfo } from "./tokens.js";
import type { ScenarioState, Symbol } from "./types.js";

const log = logger("holdings");
const erc20 = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
/** NEAR keeps this much per byte of account storage locked: 10^19 yoctoNEAR. */
const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;

export interface Holding {
  walletLabel: string;
  /** The network it's on: NEAR, or an EVM network (eth, base, arb…). */
  chain: Network;
  symbol: string;
  amount: number;
  /** USD value; null when the token has no price. */
  usd: number | null;
  token: TokenInfo;
  simulated: boolean;
}

/**
 * Every token Nierwall can value and swap, in every wallet: an EVM wallet on each network NEAR Intents supports (a
 * batched read per network), a NEAR wallet through FastNEAR's account endpoint. Zero balances are skipped. Like the
 * RPCs, these services see the addresses asked about.
 */
export async function readHoldings(wallets: Wallet[], scenario: ScenarioState | null): Promise<{ holdings: Holding[]; errors: string[] }> {
  const tokens = await tokenList();
  const holdings: Holding[] = [];
  const errors: string[] = [];
  const add = (w: Wallet, token: TokenInfo, amount: number) => {
    if (!(amount > 0)) return;
    const cls = riskClass(token.symbol);
    const shocked = token.priceUsd != null && (cls === "ETH" || cls === "NEAR") ? applyShock(cls as Symbol, token.priceUsd, scenario) : { usd: token.priceUsd, simulated: false };
    if (shocked.usd != null && amount * shocked.usd < 0.01) return; // dust
    holdings.push({ walletLabel: w.label, chain: token.chain, symbol: token.symbol, amount, usd: shocked.usd == null ? null : amount * shocked.usd, token, simulated: shocked.simulated });
  };

  // Each network is read on its own, so one slow node doesn't hold up the rest.
  await Promise.all(
    wallets.flatMap((w) =>
      w.chain === "evm"
        ? (w.networks ?? EVM_NETWORKS).map((n) => readEvm(w, n, tokens, add).catch((e) => void errors.push(`holdings:${w.label}:${n}: ${String(e).slice(0, 120)}`)))
        : [readNear(w, tokens, add).catch((e) => void errors.push(`holdings:${w.label}: ${String(e).slice(0, 120)}`))],
    ),
  );
  return { holdings, errors };
}

/** One EVM network: its own coin and every token NEAR Intents lists there, read in one Multicall3 batch. */
async function readEvm(w: Wallet, network: EvmNetwork, tokens: TokenInfo[], add: (w: Wallet, t: TokenInfo, amount: number) => void) {
  const owner = getAddress(w.address);
  const client = evmClient(evmNetwork(network));
  const listed = tokens.filter((t) => t.chain === network);
  const erc20s = listed.filter((t) => t.contract);
  const [coin, ...raws] = await Promise.all([
    client.getBalance({ address: owner }),
    ...erc20s.map((t) => client.readContract({ address: getAddress(t.contract!), abi: erc20, functionName: "balanceOf", args: [owner] }).catch(() => 0n)),
  ]);
  const native = listed.find((t) => !t.contract);
  if (native) add(w, native, Number(formatUnits(coin, native.decimals)));
  erc20s.forEach((t, i) => add(w, t, Number(formatUnits(raws[i] ?? 0n, t.decimals))));
}

async function readNear(w: Wallet, tokens: TokenInfo[], add: (w: Wallet, t: TokenInfo, amount: number) => void) {
  const nearTokens = tokens.filter((t) => t.chain === "near");
  const native = nearTokens.find((t) => !t.contract);
  try {
    const res = await fetch(`https://api.fastnear.com/v1/account/${encodeURIComponent(w.address)}/full`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`FastNEAR ${res.status}`);
    const j = (await res.json()) as { state?: { balance?: string; storage_bytes?: number }; tokens?: Array<{ contract_id: string; balance: string }> };
    if (native && j.state?.balance) {
      const locked = BigInt(j.state.storage_bytes ?? 0) * STORAGE_YOCTO_PER_BYTE;
      const free = BigInt(j.state.balance) - locked;
      add(w, native, Number(formatUnits(free > 0n ? free : 0n, 24)));
    }
    for (const b of j.tokens ?? []) {
      const t = nearTokens.find((x) => x.contract === b.contract_id);
      if (t && b.balance && b.balance !== "0") add(w, t, Number(formatUnits(BigInt(b.balance), t.decimals)));
    }
  } catch (e) {
    // Fall back to the NEAR RPC for native NEAR and USDC, which fixes need most.
    log.warn("FastNEAR unavailable; reading NEAR and USDC over RPC", { wallet: w.label, err: String(e).slice(0, 120) });
    const b = await nearBalances(w.address, [ADDRESSES.near.usdc]);
    if (native) add(w, native, b.NEAR ?? 0);
    const usdc = nearTokens.find((t) => t.contract === ADDRESSES.near.usdc);
    if (usdc) add(w, usdc, b.USDC ?? 0);
  }
}
