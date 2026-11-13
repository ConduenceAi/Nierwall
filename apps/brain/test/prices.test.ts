import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionResult } from "viem";
import { evmChain } from "../src/chains.js";
import { erc20Abi } from "../src/protocols/aave.js";
import { NATIVE, resolveTokens, tokenPrices } from "../src/snap/pricing.js";
import { coinPrices, volatility } from "../src/sources/coins.js";
import { llamaPrices } from "../src/sources/defillama.js";
import { fetchPrices } from "../src/sources/prices.js";

// The oracles behind fetchPrices: Aave's answers for ETH and USDC, Rhea's is down, so NEAR has to come from the market.
vi.mock("../src/protocols/aave.js", async (orig) => ({
  ...(await orig<typeof import("../src/protocols/aave.js")>()),
  aaveReserves: async () => ({ oracle: "0x0000000000000000000000000000000000000001" }),
  baseClient: { readContract: async () => [2000n * 10n ** 8n, 10n ** 8n] },
}));
vi.mock("../src/protocols/rhea.js", async (orig) => ({
  ...(await orig<typeof import("../src/protocols/rhea.js")>()),
  rheaAssets: async () => {
    throw new Error("Rhea unavailable");
  },
}));

/** What the fake services know. A service left out is down (HTTP 503). */
interface Fake {
  /** DefiLlama current prices by key; an object sets the confidence. */
  llama?: Record<string, number | { price: number; confidence: number }>;
  change?: Record<string, number>;
  chart?: Record<string, number[]>;
  /** CoinGecko prices by coin id or contract. */
  coingecko?: Record<string, number>;
  cgChart?: Record<string, number[]>;
}

let calls: URL[] = [];
const asked = (host: string) => calls.filter((u) => u.host === host);
const keysIn = (u: URL) => decodeURIComponent(u.pathname.split("/").pop()!).split(",");

/** Answers every fetch offline: DefiLlama, CoinGecko, the NEAR Intents token list, and token contracts over RPC. */
function serve(fake: Fake) {
  calls = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    const reply = answer(fake, url, typeof init?.body === "string" ? JSON.parse(init.body) : null);
    return reply === undefined ? new Response("unavailable", { status: 503 }) : Response.json(reply);
  });
}
afterEach(() => vi.unstubAllGlobals());

function answer(fake: Fake, url: URL, rpc: { id: number; params: [{ data: string }] } | null): unknown {
  if (url.host === "coins.llama.fi") {
    if (!fake.llama) return undefined;
    const pick = <T>(table: Record<string, T>, f: (v: T) => unknown) => ({ coins: Object.fromEntries(keysIn(url).filter((k) => k in table).map((k) => [k, f(table[k]!)])) });
    if (url.pathname.startsWith("/prices/current/")) return pick(fake.llama, (p) => ({ symbol: "X", timestamp: 0, ...(typeof p === "number" ? { price: p, confidence: 0.99 } : p) }));
    if (url.pathname.startsWith("/percentage/")) return pick(fake.change ?? {}, (c) => c);
    if (url.pathname.startsWith("/chart/")) return pick(fake.chart ?? {}, (ps) => ({ symbol: "X", confidence: 0.99, prices: ps.map((price, i) => ({ timestamp: i * 86_400, price })) }));
  }
  if (url.host === "api.coingecko.com") {
    if (!fake.coingecko) return undefined;
    const chart = /\/coins\/([^/]+)\/market_chart$/.exec(url.pathname);
    if (chart) return { prices: (fake.cgChart?.[chart[1]!] ?? []).map((p, i) => [i * 86_400_000, p]) };
    const wanted = (url.searchParams.get("ids") ?? url.searchParams.get("contract_addresses") ?? "").split(",");
    return Object.fromEntries(wanted.filter((k) => k in fake.coingecko!).map((k) => [k, { usd: fake.coingecko![k], usd_24h_change: -1 }]));
  }
  if (url.host === "1click.chaindefuser.com") return [];
  if (rpc) {
    const result = rpc.params[0].data.startsWith("0x95d89b41")
      ? encodeFunctionResult({ abi: erc20Abi, functionName: "symbol", result: "DEGEN" })
      : encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result: 18 });
    return { jsonrpc: "2.0", id: rpc.id, result };
  }
}

describe("DefiLlama coins API", () => {
  it("asks for long lists in batches and leaves out prices it isn't confident in", async () => {
    const keys = Array.from({ length: 120 }, (_, i) => `base:0x${i.toString(16).padStart(40, "0")}`);
    serve({ llama: { [keys[0]!]: 1.5, [keys[119]!]: 2, [keys[60]!]: { price: 9, confidence: 0.3 } } });
    expect(await llamaPrices(keys)).toEqual({ [keys[0]!]: 1.5, [keys[119]!]: 2 });
    expect(asked("coins.llama.fi").map((u) => keysIn(u).length)).toEqual([50, 50, 20]);
  });
});

describe("coin prices: DefiLlama first, CoinGecko as the fallback", () => {
  it("prices coins on DefiLlama by CoinGecko id, with the 24-hour change, and asks CoinGecko only for the rest", async () => {
    serve({ llama: { "coingecko:near": 3.5, "coingecko:solana": 80 }, change: { "coingecko:near": 2.5 }, coingecko: { "tiny-coin": 0.01 } });
    expect(await coinPrices(["near", "solana", "tiny-coin", "near"])).toEqual({
      near: { usd: 3.5, change24h: 2.5, source: "defillama" },
      solana: { usd: 80, change24h: null, source: "defillama" },
      "tiny-coin": { usd: 0.01, change24h: -1, source: "coingecko" },
    });
    expect(asked("api.coingecko.com").map((u) => u.searchParams.get("ids"))).toEqual(["tiny-coin"]);
  });

  it("uses CoinGecko for everything when DefiLlama is down, and throws only when nothing could be priced", async () => {
    serve({ coingecko: { near: 3.4 } });
    expect(await coinPrices(["near"])).toEqual({ near: { usd: 3.4, change24h: -1, source: "coingecko" } });
    serve({});
    await expect(coinPrices(["near"])).rejects.toThrow("CoinGecko 503");
  });

  it("keeps DefiLlama's prices when the CoinGecko fallback fails", async () => {
    serve({ llama: { "coingecko:near": 3.5 } });
    expect(await coinPrices(["near", "tiny-coin"])).toEqual({ near: { usd: 3.5, change24h: null, source: "defillama" } });
  });

  it("backs up the oracles: they come first, DefiLlama fills in only what they miss", async () => {
    serve({ llama: { "coingecko:near": 3.5, "coingecko:ethereum": 1999, "coingecko:usd-coin": 0.999 } });
    const p = await fetchPrices(null);
    expect([p.ETH?.usd, p.ETH?.source, p.USDC?.usd, p.USDC?.source]).toEqual([2000, "aave-oracle", 1, "aave-oracle"]);
    expect([p.NEAR?.usd, p.NEAR?.source]).toEqual([3.5, "defillama"]);
    expect(new Set(asked("coins.llama.fi").flatMap(keysIn))).toEqual(new Set(["coingecko:near"]));
  });
});

describe("volatility", () => {
  // 91 daily prices, flat except for one drop in the middle.
  const drop = (pct: number) => Array.from({ length: 91 }, (_, i) => (i < 45 ? 100 : 100 * (1 - pct)));

  it("uses DefiLlama's daily prices when there's one for every day, and caches them for an hour", async () => {
    serve({ llama: {}, chart: { "coingecko:near": drop(0.2) } });
    expect(await volatility("near")).toEqual({ coinId: "near", days: 90, dailyVolPct: 2.1, worstDayPct: -20, worstWeekPct: -20, changePct: -20 });
    await volatility("near");
    expect(asked("coins.llama.fi")).toHaveLength(1);
    expect(asked("api.coingecko.com")).toHaveLength(0);
  });

  it("uses CoinGecko's series when DefiLlama's skips days", async () => {
    serve({ llama: {}, chart: { "coingecko:linear-protocol": drop(0.2).slice(0, 84) }, coingecko: {}, cgChart: { "linear-protocol": drop(0.1) } });
    expect(await volatility("linear-protocol")).toMatchObject({ dailyVolPct: 1.1, worstDayPct: -10, changePct: -10 });
  });

  it("passes on CoinGecko's error when neither service has the history", async () => {
    serve({});
    await expect(volatility("pepe")).rejects.toThrow("CoinGecko 503");
  });
});

describe("snap: token prices on any EVM chain", () => {
  const base = evmChain(8453)!;
  const DEGEN = "0x4ed4e862860bed51a9570b96d89af5e1b0efefed";
  const OBSCURE = "0x00000000000000000000000000000000000000aa";

  it("prices contracts and the chain's coin in one DefiLlama request, and asks CoinGecko only for the rest", async () => {
    serve({ llama: { [`base:${DEGEN}`]: 0.00074, "coingecko:ethereum": 1930 }, coingecko: { [OBSCURE]: 0.5 } });
    expect(Object.fromEntries(await tokenPrices(base, [DEGEN, OBSCURE, NATIVE]))).toEqual({ [DEGEN]: 0.00074, [OBSCURE]: 0.5, [NATIVE]: 1930 });
    expect(asked("coins.llama.fi").map(keysIn)).toEqual([[`base:${DEGEN}`, `base:${OBSCURE}`, "coingecko:ethereum"]]);
    expect(asked("api.coingecko.com").map((u) => `${u.pathname} ${u.searchParams.get("contract_addresses")}`)).toEqual([`/api/v3/simple/token_price/base ${OBSCURE}`]);
  });

  it("goes straight to CoinGecko on a chain without a DefiLlama prefix", async () => {
    serve({ llama: {}, coingecko: { [DEGEN]: 0.0007 } });
    expect((await tokenPrices({ ...base, defillama: null }, [DEGEN])).get(DEGEN)).toBe(0.0007);
    expect(asked("coins.llama.fi")).toHaveLength(0);
  });

  it("names a token missing from the NEAR Intents list from its contract, and prices it on DefiLlama", async () => {
    serve({ llama: { [`base:${DEGEN}`]: 0.00074 } });
    const meta = await resolveTokens(base, ["0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"]);
    expect(meta.get(DEGEN)).toEqual({ symbol: "DEGEN", decimals: 18, priceUsd: 0.00074 });
  });
});
