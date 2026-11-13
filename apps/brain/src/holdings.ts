import { formatUnits, getAddress, parseAbi } from "viem";
import { ADDRESSES, type Chain, type Wallet } from "./config.js";
import { logger } from "./log.js";
import { baseClient } from "./protocols/aave.js";
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
  chain: Chain;
  symbol: string;
  amount: number;
  /** USD value; null when the token has no price. */
  usd: number | null;
  token: TokenInfo;
  simulated: boolean;
}

/**
 * Every token Nierwall can value and swap, in every wallet: Base through one batched read, NEAR through
 * FastNEAR's account endpoint. Zero balances are skipped. Like the RPCs, these services see the addresses asked about.
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
    holdings.push({ walletLabel: w.label, chain: w.chain, symbol: token.symbol, amount, usd: shocked.usd == null ? null : amount * shocked.usd, token, simulated: shocked.simulated });
  };

  await Promise.all(
    wallets.map(async (w) => {
      try {
        if (w.chain === "base") {
          const owner = getAddress(w.address);
          const erc20s = tokens.filter((t) => t.chain === "base" && t.contract);
          const [eth, ...raws] = await Promise.all([
            baseClient.getBalance({ address: owner }),
            ...erc20s.map((t) => baseClient.readContract({ address: getAddress(t.contract!), abi: erc20, functionName: "balanceOf", args: [owner] }).catch(() => 0n)),
          ]);
          const native = tokens.find((t) => t.chain === "base" && !t.contract);
          if (native) add(w, native, Number(formatUnits(eth, 18)));
          erc20s.forEach((t, i) => add(w, t, Number(formatUnits(raws[i] ?? 0n, t.decimals))));
        } else {
          await readNear(w, tokens, add);
        }
      } catch (e) {
        errors.push(`holdings:${w.label}: ${String(e).slice(0, 120)}`);
      }
    }),
  );
  return { holdings, errors };
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
