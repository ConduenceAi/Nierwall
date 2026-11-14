import type { Wallet, WalletsConfig } from "./config.js";
import { allocationOf } from "./advisor/plans.js";
import { readHoldings, type Holding } from "./holdings.js";
import { logger } from "./log.js";
import { readRhea, type RheaAccountDetail } from "./protocols/rhea.js";
import { coinPrices } from "./sources/coins.js";
import { fetchPrices } from "./sources/prices.js";
import type { ScenarioState, Snapshot, WalletBalance } from "./types.js";

const log = logger("portfolio");

export interface SnapshotWithDetail {
  snapshot: Snapshot;
  /** Protocol detail kept in memory for previews and the Snap; never persisted with addresses. */
  rhea: Map<string, RheaAccountDetail>;
}

export class Portfolio {
  private holdingsCache: { at: number; key: string; data: { holdings: Holding[]; errors: string[] } } | null = null;

  /** Reads the brain's wallets each time, so connecting or removing one takes effect on the next refresh. */
  constructor(private readonly config: () => WalletsConfig) {}

  get wallets(): WalletsConfig {
    return this.config();
  }

  /** Every token in every wallet. Cached (2 minutes by default) so the APIs aren't hit on every tick. */
  async holdings(scenario: ScenarioState | null, maxAgeMs = 120_000) {
    const key = JSON.stringify(scenario?.active ? scenario.shocks : null);
    const c = this.holdingsCache;
    if (c && c.key === key && Date.now() - c.at < maxAgeMs) return c.data;
    const data = await readHoldings(this.wallets.wallets, scenario);
    this.holdingsCache = { at: Date.now(), key, data };
    return data;
  }

  /** The next read goes to the networks again, e.g. after a fix moved money. */
  forgetHoldings() {
    this.holdingsCache = null;
  }

  wallet(label: string): Wallet | undefined {
    return this.wallets.wallets.find((w) => w.label === label);
  }

  /** One full refresh: prices, watched lending positions, every wallet's balances on every network, and watched coins. */
  async refresh(scenario: ScenarioState | null, coinIds: string[] = [], withAllocation = false): Promise<SnapshotWithDetail> {
    const errors: string[] = [];
    const rhea = new Map<string, RheaAccountDetail>();

    const prices: Snapshot["prices"] = await fetchPrices(scenario).catch((e) => {
      errors.push(`prices: ${String(e).slice(0, 120)}`);
      return {};
    });

    const jobs: Array<Promise<void>> = [];
    let coins: Snapshot["coins"] = {};
    if (coinIds.length) {
      jobs.push(coinPrices(coinIds).then((c) => void (coins = c)).catch((e) => void errors.push(`coin prices: ${String(e).slice(0, 120)}`)));
    }
    // Every NEAR wallet is checked for a Rhea loan; one with nothing on Rhea simply has no position.
    for (const w of this.wallets.wallets.filter((x) => x.chain === "near")) {
      jobs.push(
        readRhea(w.label, w.address, scenario)
          .then((d) => void (d.position.collateral.length || d.position.debt.length ? rhea.set(w.label, d) : undefined))
          .catch((e) => void errors.push(`rhea:${w.label}: ${String(e).slice(0, 120)}`)),
      );
    }

    // Every token in every wallet on every network (cached): fixes look for spare cash wherever it is.
    const held = this.holdings(scenario).catch((e) => ({ holdings: [] as Holding[], errors: [`holdings: ${String(e).slice(0, 120)}`] }));
    await Promise.all(jobs);
    const h = await held;
    errors.push(...h.errors);
    const balances: WalletBalance[] = h.holdings.map((x) => ({ walletLabel: x.walletLabel, chain: x.chain, symbol: x.symbol, amount: x.amount, usd: x.usd ?? 0 }));
    // A mix that's missing a network would set off allocation alerts for nothing, so it's left out when a read failed.
    let allocation: Snapshot["allocation"];
    if (withAllocation && !h.errors.length) allocation = allocationOf(h.holdings, [...rhea.values()].map((d) => d.position));
    if (errors.length) log.warn("refresh had errors", { count: errors.length, first: errors[0] });

    const snapshot: Snapshot = {
      takenAt: new Date().toISOString(),
      prices,
      positions: [...rhea.values()].map((d) => d.position),
      balances,
      coins,
      allocation,
      errors,
      scenario,
    };
    return { snapshot, rhea };
  }
}
