import * as rhea from "@rhea-finance/cross-chain-sdk";
import { env } from "../config.js";
import { applyShock } from "../sources/prices.js";
import type { LendingPosition, ScenarioState, TokenAmount } from "../types.js";
import { liquidationDrop, mainCollateralClass, riskClass, sumUsd, type Weighted } from "./risk.js";

rhea.setCustomNodeUrl(env.NEAR_RPC_URL);

interface RheaAssetView {
  token_id: string;
  price?: { usd?: string } | null;
  metadata?: { symbol?: string; decimals?: number };
  config?: { volatility_ratio: number; extra_decimals: number; can_use_as_collateral?: boolean };
}
export type RheaAssets = Record<string, RheaAssetView>;
interface RheaPortfolio {
  positions?: Record<string, { collateral?: Record<string, { balance: string }>; borrowed?: Record<string, { balance: string }> }>;
}

let assetsCache: { at: number; assets: RheaAssets } | null = null;

/** Rhea asset configs with Pyth prices, cached for 30 seconds. */
export async function rheaAssets(): Promise<RheaAssets> {
  if (assetsCache && Date.now() - assetsCache.at < 30_000) return assetsCache.assets;
  const assets = (await rhea.getAssetDetailsView()) as unknown as RheaAssets;
  assetsCache = { at: Date.now(), assets };
  return assets;
}

/** A Rhea token's symbol, internal decimals (token + extra), collateral weight and price. */
export function tokenInfo(assets: RheaAssets, tokenId: string) {
  const a = assets[tokenId];
  const symbol = a?.metadata?.symbol ?? tokenId.slice(0, 10);
  const decimals = (a?.metadata?.decimals ?? 0) + (a?.config?.extra_decimals ?? 0);
  const vr = (a?.config?.volatility_ratio ?? 0) / 10_000;
  const usd = Number(a?.price?.usd ?? 0);
  return { symbol, decimals, vr, usd };
}

function toAmount(raw: string, decimals: number) {
  // Raw balances carry up to ~40 digits; split to keep float precision sensible.
  const s = raw.padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = s.slice(s.length - decimals).slice(0, 12);
  return Number(`${whole}.${frac || "0"}`);
}

export interface RheaAccountDetail {
  position: LendingPosition;
  /** Price, weight and symbol per token, after any scenario shock. */
  tokens: Record<string, { symbol: string; usd: number; vr: number }>;
  /** Raw portfolio from the SDK, kept for cross-checks. */
  portfolio: RheaPortfolio | undefined;
}

/** Reads the REGULAR Rhea lending position of a NEAR account. */
export async function readRhea(walletLabel: string, accountId: string, scenario: ScenarioState | null): Promise<RheaAccountDetail> {
  const [assets, portfolio] = await Promise.all([rheaAssets(), rhea.getAccountAllPositionsView(accountId) as Promise<RheaPortfolio | undefined>]);
  const regular = portfolio?.positions?.REGULAR;
  const tokens: RheaAccountDetail["tokens"] = {};
  const collateral: TokenAmount[] = [];
  const debt: TokenAmount[] = [];
  const wCol: Weighted[] = [];
  const wDebt: Weighted[] = [];
  let simulated = false;

  const price = (tokenId: string) => {
    const info = tokenInfo(assets, tokenId);
    const cls = riskClass(info.symbol);
    const shocked = cls === "ETH" || cls === "NEAR" ? applyShock(cls, info.usd, scenario) : { usd: info.usd, simulated: false };
    simulated ||= shocked.simulated;
    tokens[tokenId] = { symbol: info.symbol, usd: shocked.usd, vr: info.vr };
    return { ...info, usd: shocked.usd, cls };
  };

  for (const [tokenId, v] of Object.entries(regular?.collateral ?? {})) {
    const p = price(tokenId);
    const amount = toAmount(v.balance, p.decimals);
    const usd = amount * p.usd;
    collateral.push({ token: tokenId, symbol: p.symbol, amount, usd, weight: p.vr });
    wCol.push({ cls: p.cls, value: usd * p.vr });
  }
  for (const [tokenId, v] of Object.entries(regular?.borrowed ?? {})) {
    const p = price(tokenId);
    const amount = toAmount(v.balance, p.decimals);
    const usd = amount * p.usd;
    debt.push({ token: tokenId, symbol: p.symbol, amount, usd, weight: p.vr });
    wDebt.push({ cls: p.cls, value: p.vr > 0 ? usd / p.vr : usd });
  }

  const weightedCol = wCol.reduce((s, c) => s + c.value, 0);
  const weightedDebt = wDebt.reduce((s, d) => s + d.value, 0);
  const main = mainCollateralClass(wCol);
  return {
    tokens,
    portfolio,
    position: {
      id: `rhea:${walletLabel}`,
      protocol: "rhea",
      chain: "near",
      walletLabel,
      collateral,
      debt,
      collateralUsd: sumUsd(collateral),
      debtUsd: sumUsd(debt),
      healthFactor: weightedDebt > 0 ? weightedCol / weightedDebt : null,
      liquidationDistance: main ? liquidationDrop(main, wCol, wDebt) : null,
      observedAt: new Date().toISOString(),
      simulated,
    },
  };
}

/** A Rhea token by symbol ("USDC", "wNEAR"; "NEAR" means wNEAR): its id, collateral weight and price. */
export function rheaTokenBySymbol(assets: RheaAssets, symbol: string): { tokenId: string; symbol: string; usd: number; vr: number; collateral: boolean } | null {
  const q = symbol.toLowerCase() === "near" ? "wnear" : symbol.toLowerCase();
  for (const [tokenId, a] of Object.entries(assets)) {
    if ((a.metadata?.symbol ?? "").toLowerCase() !== q) continue;
    const i = tokenInfo(assets, tokenId);
    return { tokenId, symbol: i.symbol, usd: i.usd, vr: i.vr, collateral: a.config?.can_use_as_collateral !== false };
  }
  return null;
}

/** Health after repaying `amount` of a borrowed token (same weights Rhea uses). */
export function previewRheaRepay(detail: RheaAccountDetail, tokenId: string, amount: number): number | null {
  const t = detail.tokens[tokenId];
  if (!t) return null;
  const col = detail.position.collateral.reduce((s, c) => s + c.usd * c.weight, 0);
  let debt = detail.position.debt.reduce((s, d) => s + (d.weight > 0 ? d.usd / d.weight : d.usd), 0);
  debt -= t.vr > 0 ? (amount * t.usd) / t.vr : amount * t.usd;
  return debt > 1e-9 ? col / debt : null;
}

/** Health after adding `amount` of a token as collateral. */
export function previewRheaAddCollateral(detail: RheaAccountDetail, tokenId: string, amount: number, assets?: RheaAssets): number | null {
  const t = detail.tokens[tokenId] ?? (assets ? (() => { const i = tokenInfo(assets, tokenId); return { symbol: i.symbol, usd: i.usd, vr: i.vr }; })() : undefined);
  if (!t) return null;
  const col = detail.position.collateral.reduce((s, c) => s + c.usd * c.weight, 0) + amount * t.usd * t.vr;
  const debt = detail.position.debt.reduce((s, d) => s + (d.weight > 0 ? d.usd / d.weight : d.usd), 0);
  return debt > 1e-9 ? col / debt : null;
}

/** Amount of a borrowed token to repay to reach a target health. */
export function repayToReach(detail: RheaAccountDetail, tokenId: string, target: number): number | null {
  const t = detail.tokens[tokenId];
  if (!t || target <= 0) return null;
  const col = detail.position.collateral.reduce((s, c) => s + c.usd * c.weight, 0);
  const debt = detail.position.debt.reduce((s, d) => s + (d.weight > 0 ? d.usd / d.weight : d.usd), 0);
  const neededDebt = col / target;
  if (debt <= neededDebt) return 0;
  const perToken = t.vr > 0 ? t.usd / t.vr : t.usd;
  return perToken > 0 ? (debt - neededDebt) / perToken : null;
}

/** Amount of a collateral token to add to reach a target health. */
export function collateralToReach(detail: RheaAccountDetail, tokenId: string, target: number, assets: RheaAssets): number | null {
  const existing = detail.tokens[tokenId];
  const info = existing ?? (() => { const i = tokenInfo(assets, tokenId); return { symbol: i.symbol, usd: i.usd, vr: i.vr }; })();
  if (info.usd <= 0 || info.vr <= 0) return null;
  const col = detail.position.collateral.reduce((s, c) => s + c.usd * c.weight, 0);
  const debt = detail.position.debt.reduce((s, d) => s + (d.weight > 0 ? d.usd / d.weight : d.usd), 0);
  const neededCol = debt * target;
  if (col >= neededCol) return 0;
  return (neededCol - col) / (info.usd * info.vr);
}

/** NEAR account balances: native NEAR and a NEP-141 token. */
export async function nearBalances(accountId: string, tokenIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const rpc = async (body: unknown) => {
    const res = await fetch(env.NEAR_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await res.json()) as { result?: { amount?: string; result?: number[] }; error?: unknown };
    if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
    return j.result;
  };
  const acct = await rpc({ jsonrpc: "2.0", id: "1", method: "query", params: { request_type: "view_account", finality: "final", account_id: accountId } });
  out.NEAR = toAmount(acct?.amount ?? "0", 24);
  const assets = await rheaAssets();
  for (const tokenId of tokenIds) {
    const r = await rpc({
      jsonrpc: "2.0", id: "1", method: "query",
      params: { request_type: "call_function", finality: "final", account_id: tokenId, method_name: "ft_balance_of", args_base64: Buffer.from(JSON.stringify({ account_id: accountId })).toString("base64") },
    }).catch(() => undefined);
    const raw = r?.result ? JSON.parse(Buffer.from(r.result).toString()) : "0";
    const decimals = assets[tokenId]?.metadata?.decimals ?? 6;
    out[assets[tokenId]?.metadata?.symbol ?? tokenId] = toAmount(String(raw), decimals);
  }
  return out;
}
