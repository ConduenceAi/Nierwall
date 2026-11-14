import type { EvmNetwork, Network } from "./config.js";

export type Symbol = "ETH" | "NEAR" | "USDC";

export interface PriceInfo {
  symbol: Symbol;
  usd: number;
  /** Unix seconds of the oracle publish time. */
  publishTime: number;
  source: "rhea-pyth" | "defillama" | "coingecko";
  /** True when a scenario shock changed this price. */
  simulated: boolean;
}

export interface TokenAmount {
  token: string;
  symbol: string;
  amount: number;
  usd: number;
  /** Collateral weight (Rhea's volatility ratio), 0..1. */
  weight: number;
}

export interface LendingPosition {
  /** Stable id: "rhea:<wallet label>". */
  id: string;
  protocol: "rhea";
  chain: Network;
  walletLabel: string;
  collateral: TokenAmount[];
  debt: TokenAmount[];
  collateralUsd: number;
  debtUsd: number;
  /** Ratio, 1.00 = liquidation line. Null when there is no debt. */
  healthFactor: number | null;
  /** Fraction the main collateral can fall before liquidation, 0..1. Null when not meaningful. */
  liquidationDistance: number | null;
  observedAt: string;
  simulated: boolean;
}

export interface WalletBalance {
  walletLabel: string;
  chain: Network;
  symbol: string;
  amount: number;
  usd: number;
}

export interface Snapshot {
  takenAt: string;
  prices: Partial<Record<Symbol, PriceInfo>>;
  positions: LendingPosition[];
  balances: WalletBalance[];
  /** Prices of coins that watches follow, keyed by CoinGecko coin id. */
  coins?: Record<string, { usd: number; change24h: number | null }>;
  /** Present when an allocation watch is active. */
  allocation?: Allocation;
  /** Sources that failed during this refresh; their data is missing or stale. */
  errors: string[];
  scenario: ScenarioState | null;
}

export interface ScenarioState {
  active: boolean;
  /** Price shocks as fractions, e.g. { NEAR: -0.09 }. */
  shocks: Partial<Record<Symbol, number>>;
  startedAt: string;
  note: string;
}

export type WatchKind = "health_below" | "price_below" | "price_above" | "price_move" | "liq_distance" | "balance_min" | "allocation_min" | "allocation_max" | "data_stale";

/** Portfolio value by asset class across wallets and loans (debt netted), as shares of net worth. */
export interface Allocation {
  netWorthUsd: number;
  classes: Array<{ cls: "stable" | "ETH" | "BTC" | "NEAR" | "SOL" | "other"; usd: number; pct: number }>;
}

export interface Watch {
  id: string;
  kind: WatchKind;
  /** Plain-language description shown to the user and read back for confirmation. */
  label: string;
  params: Record<string, unknown>;
  status: "proposed" | "active" | "paused";
  source: "user" | "memory" | "demo" | "system";
  createdAt: string;
  confirmedAt: string | null;
}

export type Severity = "info" | "warning" | "critical";

export interface Incident {
  id: string;
  watchId: string;
  state: "open" | "resolved";
  severity: Severity;
  title: string;
  detail: string;
  value: number | null;
  firstSeen: string;
  lastSeen: string;
  snoozedUntil: string | null;
  acknowledged: boolean;
  simulated: boolean;
}

/** Machine-readable plan behind a fix, used to build the transactions the user signs. */
/** USDC from an EVM wallet on one of its networks, through NEAR Intents to the NEAR wallet, then repaid on Rhea. */
interface RepayFromEvm {
  amountUsdc: number;
  fromWallet: string;
  fromChain?: EvmNetwork;
  toWallet: string;
}

export type FixPlan =
  | ({ type: "rhea_repay_from_evm" } & RepayFromEvm)
  /** The old name, from before fixes could start on any network: always Base. */
  | ({ type: "rhea_repay_from_base" } & RepayFromEvm)
  | { type: "rhea_repay"; amountUsdc: number; wallet: string }
  | { type: "rhea_add_collateral"; amountNear: number; wallet: string };

export interface FixOption {
  id: string;
  kind: "repay" | "add_collateral";
  plan?: FixPlan;
  title: string;
  /** Steps the user signs, in order. */
  steps: Array<{ chain: Network; wallet: string; description: string }>;
  healthBefore: number | null;
  healthAfter: number | null;
  notes: string[];
  rank: number;
  intentsQuote?: { amountIn: string; amountOutMin: string; deadline: string; dry: boolean } | null;
}

export interface Alert {
  id: string;
  incidentId: string;
  createdAt: string;
  severity: Severity;
  title: string;
  body: string;
  fixes: FixOption[];
  simulated: boolean;
}
