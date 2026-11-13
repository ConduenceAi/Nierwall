import { logger } from "../log.js";
import type { PriceInfo, ScenarioState, Symbol } from "../types.js";
import { coinPrices } from "./coins.js";

const log = logger("prices");

/** Applies scenario shocks. Correlated assets (wstETH, stNEAR...) move with their base asset. */
export function applyShock(sym: Symbol, usd: number, scenario: ScenarioState | null): { usd: number; simulated: boolean } {
  const shock = scenario?.active ? scenario.shocks[sym] : undefined;
  if (shock === undefined || shock === 0) return { usd, simulated: false };
  return { usd: usd * (1 + shock), simulated: true };
}

type RawPrices = Partial<Record<Symbol, { usd: number; source: PriceInfo["source"] }>>;

/**
 * Oracle prices that actually drive liquidations: Chainlink via Aave's oracle on Base for ETH and USDC,
 * Pyth via Rhea on NEAR for NEAR. Loaded lazily to avoid import cycles.
 */
async function oraclePrices(): Promise<RawPrices> {
  const out: RawPrices = {};
  const [{ aaveReserves, baseClient }, { rheaAssets }, { ADDRESSES }] = await Promise.all([
    import("../protocols/aave.js"),
    import("../protocols/rhea.js"),
    import("../config.js"),
  ]);
  const { parseAbi, formatUnits, getAddress } = await import("viem");
  const oracleAbi = parseAbi(["function getAssetsPrices(address[] assets) view returns (uint256[])"]);
  const [aave, rhea] = await Promise.allSettled([
    (async () => {
      const { oracle } = await aaveReserves();
      const [eth, usdc] = await baseClient.readContract({
        address: oracle,
        abi: oracleAbi,
        functionName: "getAssetsPrices",
        args: [[getAddress(ADDRESSES.base.weth), getAddress(ADDRESSES.base.usdc)]],
      });
      return { eth: Number(formatUnits(eth ?? 0n, 8)), usdc: Number(formatUnits(usdc ?? 0n, 8)) };
    })(),
    rheaAssets(),
  ]);
  if (aave.status === "fulfilled") {
    if (aave.value.eth > 0) out.ETH = { usd: aave.value.eth, source: "aave-oracle" };
    if (aave.value.usdc > 0) out.USDC = { usd: aave.value.usdc, source: "aave-oracle" };
  } else log.warn("aave oracle unavailable", { err: String(aave.reason).slice(0, 160) });
  if (rhea.status === "fulfilled") {
    const near = Number(rhea.value[ADDRESSES.near.wnear]?.price?.usd ?? 0);
    if (near > 0) out.NEAR = { usd: near, source: "rhea-pyth" };
  } else log.warn("rhea prices unavailable", { err: String(rhea.reason).slice(0, 160) });
  return out;
}

const COIN_IDS: Record<Symbol, string> = { ETH: "ethereum", NEAR: "near", USDC: "usd-coin" };

/** Market prices for what the oracles missed: DefiLlama, or CoinGecko when DefiLlama can't answer. */
async function marketPrices(symbols: Symbol[]): Promise<RawPrices> {
  const coins = await coinPrices(symbols.map((s) => COIN_IDS[s]));
  const out: RawPrices = {};
  for (const s of symbols) {
    const c = coins[COIN_IDS[s]];
    if (c) out[s] = { usd: c.usd, source: c.source };
  }
  return out;
}

/** Latest prices with scenario shocks applied. Oracles first, market prices for anything missing. */
export async function fetchPrices(scenario: ScenarioState | null): Promise<Partial<Record<Symbol, PriceInfo>>> {
  let raw = await oraclePrices().catch((e) => {
    log.warn("oracle prices failed", { err: String(e).slice(0, 160) });
    return {} as RawPrices;
  });
  const missing = (["ETH", "NEAR", "USDC"] as Symbol[]).filter((s) => !raw[s]);
  if (missing.length) {
    const market = await marketPrices(missing).catch((e) => {
      log.warn("market prices failed", { err: String(e).slice(0, 160) });
      return {} as RawPrices;
    });
    raw = { ...market, ...raw };
  }
  const now = Math.floor(Date.now() / 1000);
  const out: Partial<Record<Symbol, PriceInfo>> = {};
  for (const [sym, p] of Object.entries(raw) as Array<[Symbol, { usd: number; source: PriceInfo["source"] }]>) {
    const shocked = applyShock(sym, p.usd, scenario);
    out[sym] = { symbol: sym, usd: shocked.usd, publishTime: now, source: p.source, simulated: shocked.simulated };
  }
  return out;
}
