import { formatUnits, getAddress, parseAbi, type Address } from "viem";
import { evmChain, evmClient } from "../chains.js";
import { ADDRESSES } from "../config.js";
import { applyShock } from "../sources/prices.js";
import type { LendingPosition, ScenarioState, TokenAmount } from "../types.js";
import { liquidationDrop, mainCollateralClass, riskClass, sumUsd, type Weighted } from "./risk.js";

/** Aave V3 lives on Base here, so its loans and its price oracle are read from Base. */
export const baseClient = evmClient(evmChain(8453)!);

export const poolAbi = parseAbi([
  "function ADDRESSES_PROVIDER() view returns (address)",
  "function getReservesList() view returns (address[])",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
  "function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)",
  "function repayWithATokens(address asset, uint256 amount, uint256 interestRateMode) returns (uint256)",
  "function setUserUseReserveAsCollateral(address asset, bool useAsCollateral)",
]);
const providerAbi = parseAbi(["function getPriceOracle() view returns (address)", "function getPoolDataProvider() view returns (address)"]);
const dataProviderAbi = parseAbi([
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
]);
const oracleAbi = parseAbi(["function getAssetsPrices(address[] assets) view returns (uint256[])"]);
export const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

export interface AaveReserve {
  asset: Address;
  symbol: string;
  decimals: number;
  /** Liquidation threshold as a fraction (0.83 = 83%). */
  liquidationThreshold: number;
  collateralEnabled: boolean;
  frozen: boolean;
}

interface ReserveCache {
  at: number;
  pool: Address;
  oracle: Address;
  dataProvider: Address;
  reserves: AaveReserve[];
}
let cache: ReserveCache | null = null;

/** Reserve list and static config, cached for 10 minutes. */
export async function aaveReserves(): Promise<ReserveCache> {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache;
  const pool = getAddress(ADDRESSES.base.aavePool);
  const provider = await baseClient.readContract({ address: pool, abi: poolAbi, functionName: "ADDRESSES_PROVIDER" });
  const [oracle, dataProvider, list] = await Promise.all([
    baseClient.readContract({ address: provider, abi: providerAbi, functionName: "getPriceOracle" }),
    baseClient.readContract({ address: provider, abi: providerAbi, functionName: "getPoolDataProvider" }),
    baseClient.readContract({ address: pool, abi: poolAbi, functionName: "getReservesList" }),
  ]);
  const reserves = await Promise.all(
    list.map(async (asset): Promise<AaveReserve> => {
      const [symbol, cfg] = await Promise.all([
        baseClient.readContract({ address: asset, abi: erc20Abi, functionName: "symbol" }).catch(() => asset.slice(0, 8)),
        baseClient.readContract({ address: dataProvider, abi: dataProviderAbi, functionName: "getReserveConfigurationData", args: [asset] }),
      ]);
      return {
        asset,
        symbol,
        decimals: Number(cfg[0]),
        liquidationThreshold: Number(cfg[2]) / 10_000,
        collateralEnabled: cfg[5],
        frozen: cfg[9],
      };
    }),
  );
  cache = { at: Date.now(), pool, oracle, dataProvider, reserves };
  return cache;
}

export interface AaveAccountDetail {
  position: LendingPosition;
  /** Oracle prices (USD) per reserve asset, shocked when a scenario is active. */
  prices: Record<string, number>;
  reserves: AaveReserve[];
  onChainHealth: number | null;
}

/** Reads one account's Aave V3 position on Base, including per-asset detail. */
export async function readAave(walletLabel: string, user: string, scenario: ScenarioState | null): Promise<AaveAccountDetail> {
  const { pool, oracle, dataProvider, reserves } = await aaveReserves();
  const account = getAddress(user);
  const [summary, rawPrices, userData] = await Promise.all([
    baseClient.readContract({ address: pool, abi: poolAbi, functionName: "getUserAccountData", args: [account] }),
    baseClient.readContract({ address: oracle, abi: oracleAbi, functionName: "getAssetsPrices", args: [reserves.map((r) => r.asset)] }),
    Promise.all(reserves.map((r) => baseClient.readContract({ address: dataProvider, abi: dataProviderAbi, functionName: "getUserReserveData", args: [r.asset, account] }))),
  ]);

  const prices: Record<string, number> = {};
  const collateral: TokenAmount[] = [];
  const debt: TokenAmount[] = [];
  const wCol: Weighted[] = [];
  const wDebt: Weighted[] = [];
  let simulated = false;

  reserves.forEach((r, i) => {
    const cls = riskClass(r.symbol);
    const base8 = Number(formatUnits(rawPrices[i] ?? 0n, 8));
    const shocked = cls === "ETH" || cls === "NEAR" ? applyShock(cls, base8, scenario) : { usd: base8, simulated: false };
    simulated ||= shocked.simulated;
    prices[r.asset.toLowerCase()] = shocked.usd;
    const d = userData[i]!;
    const supplied = Number(formatUnits(d[0], r.decimals));
    const owed = Number(formatUnits(d[1] + d[2], r.decimals));
    if (supplied > 0 && d[8]) {
      const usd = supplied * shocked.usd;
      collateral.push({ token: r.asset, symbol: r.symbol, amount: supplied, usd, weight: r.liquidationThreshold });
      wCol.push({ cls, value: usd * r.liquidationThreshold });
    }
    if (owed > 0) {
      const usd = owed * shocked.usd;
      debt.push({ token: r.asset, symbol: r.symbol, amount: owed, usd, weight: 1 });
      wDebt.push({ cls, value: usd });
    }
  });

  const onChainHealth = summary[1] > 0n ? Number(formatUnits(summary[5], 18)) : null;
  const weightedCol = wCol.reduce((s, c) => s + c.value, 0);
  const weightedDebt = wDebt.reduce((s, c) => s + c.value, 0);
  // Use the protocol's own number unless a scenario changed prices.
  const healthFactor = weightedDebt > 0 ? (simulated ? weightedCol / weightedDebt : onChainHealth) : null;
  const main = mainCollateralClass(wCol);

  return {
    prices,
    reserves,
    onChainHealth,
    position: {
      id: `aave:${walletLabel}`,
      protocol: "aave",
      chain: "base",
      walletLabel,
      collateral,
      debt,
      collateralUsd: sumUsd(collateral),
      debtUsd: sumUsd(debt),
      healthFactor,
      liquidationDistance: main ? liquidationDrop(main, wCol, wDebt) : null,
      observedAt: new Date().toISOString(),
      simulated,
    },
  };
}

export type AaveAction = "supply" | "withdraw" | "borrow" | "repay";

/** Estimated health after an action, from per-asset weights. Ignores eMode and isolation mode. */
export function simulateAave(detail: AaveAccountDetail, action: AaveAction, asset: string, amount: number) {
  const r = detail.reserves.find((x) => x.asset.toLowerCase() === asset.toLowerCase());
  if (!r) return { supported: false as const, reason: "Asset is not an Aave V3 Base reserve" };
  const price = detail.prices[asset.toLowerCase()] ?? 0;
  const usd = amount * price;
  let col = detail.position.collateral.reduce((s, c) => s + c.usd * c.weight, 0);
  let debt = detail.position.debt.reduce((s, d) => s + d.usd, 0);
  const isCollateral = detail.position.collateral.some((c) => c.token.toLowerCase() === asset.toLowerCase());
  if (action === "supply") col += r.collateralEnabled ? usd * r.liquidationThreshold : 0;
  if (action === "withdraw" && isCollateral) col -= usd * r.liquidationThreshold;
  if (action === "borrow") debt += usd;
  if (action === "repay") debt = Math.max(0, debt - usd);
  return {
    supported: true as const,
    symbol: r.symbol,
    usd,
    healthBefore: detail.position.healthFactor,
    healthAfter: debt > 0 ? Math.max(0, col) / debt : null,
  };
}

export async function baseTokenBalance(owner: string, token: Address): Promise<number> {
  const [raw, decimals] = await Promise.all([
    baseClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [getAddress(owner)] }),
    baseClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return Number(formatUnits(raw, decimals));
}
