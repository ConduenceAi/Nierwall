import { ADDRESSES, type Network, type Wallet } from "./config.js";
import type { WatchKind } from "./types.js";

/**
 * The demo portfolio, for trying Nierwall before adding a wallet: small, realistic, fixed amounts on NEAR (with a
 * Rhea loan), Base and Solana, valued at live prices. No account is read and nothing can be sent from it.
 *
 * Sized for the demo story: stablecoins are about 38% of it, so buying about $15 of ETH with the Base USDC drops them
 * under the 30% minimum and the Base wallet under its 10 USDC reserve, while about $10 breaks neither.
 */
export const DEMO_WALLETS: Wallet[] = [
  { label: "Demo NEAR wallet", chain: "near", address: "nierwall-demo.near", role: "demo portfolio", via: "demo" },
  { label: "Demo Base wallet", chain: "evm", address: "0xDe00000000000000000000000000000000000001", role: "demo portfolio", via: "demo", networks: ["base"] },
  { label: "Demo Solana wallet", chain: "solana", address: "DemoSo1ana111111111111111111111111111111111", role: "demo portfolio", via: "demo" },
];

/** What each demo wallet holds, in tokens; prices come live from NEAR Intents' list. */
export const DEMO_BALANCES: Record<string, Array<{ chain: Network; symbol: string; amount: number }>> = {
  "Demo NEAR wallet": [{ chain: "near", symbol: "NEAR", amount: 7.5 }, { chain: "near", symbol: "USDC", amount: 18 }],
  "Demo Base wallet": [{ chain: "base", symbol: "ETH", amount: 0.006 }, { chain: "base", symbol: "USDC", amount: 22 }],
  "Demo Solana wallet": [{ chain: "sol", symbol: "SOL", amount: 0.3 }, { chain: "sol", symbol: "USDC", amount: 40 }],
};

/** The demo NEAR wallet's Rhea loan, by Rhea token id: 12 NEAR of collateral against 20 USDC, health about 1.4. */
export const DEMO_RHEA = {
  wallet: "Demo NEAR wallet",
  collateral: { [ADDRESSES.near.wnear]: 12 } as Record<string, number>,
  borrowed: { [ADDRESSES.near.usdc]: 20 } as Record<string, number>,
};

/** The rules the demo starts with: keep 30% in stablecoins, and at least 10 USDC in the Base wallet. */
export const DEMO_RULES: Array<{ kind: WatchKind; params: Record<string, unknown> }> = [
  { kind: "allocation_min", params: { cls: "stable", pct: 30, reason: "a cash cushion for loan repayments" } },
  { kind: "balance_min", params: { walletLabel: "Demo Base wallet", symbol: "USDC", amount: 10 } },
];

export const isDemoWallet = (w: Wallet) => w.via === "demo";
