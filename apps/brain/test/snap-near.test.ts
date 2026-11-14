import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, keccak256, parseAbi, toBytes, toHex } from "viem";
import type { TokenInfo } from "../src/tokens.js";

// The NEAR token list comes from NEAR Intents; give the decoder a small fixed one so the test runs offline.
vi.mock("../src/tokens.js", async (orig) => {
  const actual = await orig<typeof import("../src/tokens.js")>();
  const tokens: TokenInfo[] = [
    { chain: "near", symbol: "NEAR", decimals: 24, assetId: "nep141:wrap.near", contract: null, coingeckoId: "near", priceUsd: 3.5 },
    { chain: "near", symbol: "wNEAR", decimals: 24, assetId: "nep141:wrap.near", contract: "wrap.near", coingeckoId: "near", priceUsd: 3.5 },
    { chain: "near", symbol: "USDC", decimals: 6, assetId: "nep141:usdc", contract: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", coingeckoId: "usd-coin", priceUsd: 1 },
  ];
  return { ...actual, tokenList: async () => tokens };
});

const { analyzeNear } = await import("../src/snap/near.js");

const abi = parseAbi([
  "function functionCall(string receiverId, string methodName, bytes args, uint64 gas, uint32 yoctoNear)",
  "function transfer(string receiverId, uint32 yoctoNear)",
  "function addKey(uint8 publicKeyKind, bytes publicKey, uint64 nonce, bool isFullAccess, bool isLimitedAllowance, uint128 allowance, string receiverId, string[] methodNames)",
]);
const ME = "0x" + "ab".repeat(20);
const toFor = (account: string) => (account.startsWith("0x") ? account : `0x${keccak256(toBytes(account)).slice(26)}`);
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

// Just enough of the brain: wallets, no watches, an empty portfolio.
const brain: any = {
  wallets: { wallets: [{ label: "Savings", chain: "near", address: "savings.near", role: "" }], watchRhea: [] },
  store: { listWatches: () => [] },
  portfolio: { holdings: async () => ({ holdings: [], errors: [] }) },
  scenario: { get: () => null },
  latestSnapshot: () => null,
  last: null,
};
const run = (data: `0x${string}`, to: string, value = "0x0") => analyzeNear(brain, { chainId: "eip155:397", transaction: { from: ME, to, data, value } }, []);

describe("snap: NEAR transactions from MetaMask (NEP-518)", () => {
  it("reads a NEAR transfer: the value carries NEAR in 10^-18 units", async () => {
    // 2.5 NEAR = 2.5e18 in the value field, times 10^6 = 2.5e24 yoctoNEAR.
    const r = await run(encodeFunctionData({ abi, functionName: "transfer", args: ["stranger.near", 0] }), toFor("stranger.near"), toHex(25n * 10n ** 17n));
    expect(r.status).toBe("warn");
    expect(r.changes).toContainEqual({ label: "You send", value: "2.5 NEAR ($8.75)" });
  });

  it("knows the user's own NEAR wallets", async () => {
    const r = await run(encodeFunctionData({ abi, functionName: "transfer", args: ["savings.near", 0] }), toFor("savings.near"), toHex(10n ** 18n));
    expect(r.findings[0]!.title).toBe('To your own wallet "Savings"');
  });

  it("flags a transaction whose target doesn't match its NEAR action", async () => {
    const r = await run(encodeFunctionData({ abi, functionName: "transfer", args: ["stranger.near", 0] }), toFor("someone-else.near"), toHex(10n ** 18n));
    expect(r.status).toBe("critical");
    expect(r.summary).toBe("The target doesn't match the NEAR action");
  });

  it("treats a full-access key as critical and a limited key as routine", async () => {
    const full = await run(encodeFunctionData({ abi, functionName: "addKey", args: [0, toHex(new Uint8Array(32)), 0n, true, false, 0n, "", []] }), ME);
    expect(full.status).toBe("critical");
    expect(full.summary).toContain("full control");
    const limited = await run(encodeFunctionData({ abi, functionName: "addKey", args: [0, toHex(new Uint8Array(32)), 0n, false, true, 10n ** 23n, "app.near", ["vote"]] }), ME);
    expect(limited.status).toBe("pass");
  });

  it("reads a token send and a Rhea DEX swap, with the swap's guaranteed minimum", async () => {
    const send = await run(encodeFunctionData({ abi, functionName: "functionCall", args: [USDC, "ft_transfer", toHex(toBytes(JSON.stringify({ receiver_id: "stranger.near", amount: "250000000" }))), 30_000_000_000_000n, 1] }), toFor(USDC));
    expect(send.changes).toContainEqual({ label: "You send", value: "250 USDC ($250)" });
    const msg = JSON.stringify({ actions: [{ pool_id: 1, token_in: "wrap.near", token_out: USDC, min_amount_out: "34000000" }] });
    const swap = await run(encodeFunctionData({ abi, functionName: "functionCall", args: ["wrap.near", "ft_transfer_call", toHex(toBytes(JSON.stringify({ receiver_id: "v2.ref-finance.near", amount: (10n * 10n ** 24n).toString(), msg }))), 100_000_000_000_000n, 1] }), toFor("wrap.near"));
    expect(swap.changes).toEqual([
      { label: "Network", value: "NEAR (via MetaMask)" },
      { label: "You send", value: "10 wNEAR ($35)" },
      { label: "You get", value: "at least 34 USDC ($34)" },
    ]);
  });
});
