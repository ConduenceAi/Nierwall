import { getAddress } from "viem";
import { ADDRESSES, type Wallet, type WalletsConfig } from "./config.js";
import { readHoldings, type Holding } from "./holdings.js";
import { logger } from "./log.js";
import { baseTokenBalance, readAave, type AaveAccountDetail } from "./protocols/aave.js";
import { nearBalances, readRhea, type RheaAccountDetail } from "./protocols/rhea.js";
import { coinPrices } from "./sources/coingecko.js";
import { fetchPrices } from "./sources/prices.js";
import type { ScenarioState, Snapshot, WalletBalance } from "./types.js";

const log = logger("portfolio");

export interface SnapshotWithDetail {
  snapshot: Snapshot;
  /** Protocol detail kept in memory for previews and the Snap; never persisted with addresses. */
  aave: Map<string, AaveAccountDetail>;
  rhea: Map<string, RheaAccountDetail>;
}

export class Portfolio {
  private holdingsCache: { at: number; key: string; data: { holdings: Holding[]; errors: string[] } } | null = null;

  constructor(readonly wallets: WalletsConfig) {}

  /** Every token in every wallet. Cached (2 minutes by default) so the APIs aren't hit on every tick. */
  async holdings(scenario: ScenarioState | null, maxAgeMs = 120_000) {
    const key = JSON.stringify(scenario?.active ? scenario.shocks : null);
    const c = this.holdingsCache;
    if (c && c.key === key && Date.now() - c.at < maxAgeMs) return c.data;
    const data = await readHoldings(this.wallets.wallets, scenario);
    this.holdingsCache = { at: Date.now(), key, data };
    return data;
  }

  wallet(label: string): Wallet | undefined {
    return this.wallets.wallets.find((w) => w.label === label);
  }

  /** One full refresh: prices, watched lending positions, wallet balances used by fixes, and watched coins. */
  async refresh(scenario: ScenarioState | null, coinIds: string[] = []): Promise<SnapshotWithDetail> {
    const errors: string[] = [];
    const aave = new Map<string, AaveAccountDetail>();
    const rhea = new Map<string, RheaAccountDetail>();

    const prices: Snapshot["prices"] = await fetchPrices(scenario).catch((e) => {
      errors.push(`prices: ${String(e).slice(0, 120)}`);
      return {};
    });

    const jobs: Array<Promise<void>> = [];
    let coins: Snapshot["coins"] = {};
    if (coinIds.length) {
      jobs.push(coinPrices(coinIds).then((c) => void (coins = c)).catch((e) => void errors.push(`coingecko: ${String(e).slice(0, 120)}`)));
    }
    for (const label of this.wallets.watchAave) {
      const w = this.wallet(label);
      if (!w || w.chain !== "base") continue;
      jobs.push(readAave(label, w.address, scenario).then((d) => void aave.set(label, d)).catch((e) => void errors.push(`aave:${label}: ${String(e).slice(0, 120)}`)));
    }
    for (const label of this.wallets.watchRhea) {
      const w = this.wallet(label);
      if (!w || w.chain !== "near") continue;
      jobs.push(readRhea(label, w.address, scenario).then((d) => void rhea.set(label, d)).catch((e) => void errors.push(`rhea:${label}: ${String(e).slice(0, 120)}`)));
    }

    const balances: WalletBalance[] = [];
    for (const w of this.wallets.wallets) {
      if (w.chain === "base") {
        jobs.push(
          baseTokenBalance(w.address, getAddress(ADDRESSES.base.usdc))
            .then((amount) => void balances.push({ walletLabel: w.label, chain: "base", symbol: "USDC", amount, usd: amount * (prices.USDC?.usd ?? 1) }))
            .catch((e) => void errors.push(`balance:${w.label}: ${String(e).slice(0, 120)}`)),
        );
      } else {
        jobs.push(
          nearBalances(w.address, [ADDRESSES.near.usdc])
            .then((b) => {
              balances.push({ walletLabel: w.label, chain: "near", symbol: "NEAR", amount: b.NEAR ?? 0, usd: (b.NEAR ?? 0) * (prices.NEAR?.usd ?? 0) });
              balances.push({ walletLabel: w.label, chain: "near", symbol: "USDC", amount: b.USDC ?? 0, usd: (b.USDC ?? 0) * (prices.USDC?.usd ?? 1) });
            })
            .catch((e) => void errors.push(`balance:${w.label}: ${String(e).slice(0, 120)}`)),
        );
      }
    }
    await Promise.all(jobs);
    if (errors.length) log.warn("refresh had errors", { count: errors.length, first: errors[0] });

    const snapshot: Snapshot = {
      takenAt: new Date().toISOString(),
      prices,
      positions: [...rhea.values(), ...aave.values()].map((d) => d.position),
      balances,
      coins,
      errors,
      scenario,
    };
    return { snapshot, aave, rhea };
  }
}
