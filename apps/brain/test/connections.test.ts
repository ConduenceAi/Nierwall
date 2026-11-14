import { describe, expect, it, vi } from "vitest";
import { defaultLabel, isConnected, parseAddress, redactAddresses, signBlocker, walletAppName } from "../src/connections.js";
import { Brain } from "../src/brain.js";
import { Store } from "../src/store.js";

describe("connections: addresses", () => {
  it("tells NEAR accounts from 0x addresses, and rejects anything else", () => {
    expect(parseAddress(" Sarthak.near ")).toEqual({ chain: "near", address: "sarthak.near" });
    expect(parseAddress("0xabbea473fdde4409c6a1f0c7c527c1bda68e6c24")).toEqual({ chain: "evm", address: "0xABBEa473fdDE4409C6A1F0c7C527C1bDa68E6C24" });
    expect(parseAddress("a".repeat(64))).toEqual({ chain: "near", address: "a".repeat(64) });
    expect("error" in parseAddress("my wallet")).toBe(true);
    expect("error" in parseAddress("0x123")).toBe(true);
  });

  it("names wallets until the user does, and keeps addresses out of memory", () => {
    expect(defaultLabel("near", [])).toBe("NEAR wallet");
    expect(defaultLabel("near", ["near wallet", "NEAR wallet 2"])).toBe("NEAR wallet 3");
    expect(defaultLabel("evm", ["NEAR wallet"])).toBe("EVM wallet");
    expect(redactAddresses("my account is sarthak.near and 0xABBEa473fdDE4409C6A1F0c7C527C1bDa68E6C24, call it Savings")).toBe("my account is [address] and [address], call it Savings");
  });
});

describe("connections: the brain starts empty", () => {
  const brain = () => new Brain(new Store(":memory:"));

  it("watches nothing until a wallet is added, and transaction safety starts off", () => {
    const b = brain();
    expect(b.wallets.wallets).toEqual([]);
    expect(b.connections.transactionSafety).toBe(false);
    b.setFeatures({ transactionSafety: true });
    expect(b.connections.transactionSafety).toBe(true);
  });

  it("adds a wallet once, under a free nickname, and removes it", async () => {
    const b = brain();
    const w = await b.addWallet({ address: "0xabbea473fdde4409c6a1f0c7c527c1bda68e6c24", via: "typed" });
    expect([w.label, w.chain, w.via]).toEqual(["EVM wallet", "evm", "typed"]);
    expect((await b.addWallet({ address: "0xABBEa473fdDE4409C6A1F0c7C527C1bDa68E6C24" })).label).toBe("EVM wallet");
    expect(b.wallets.wallets.map((x) => x.label)).toEqual(["EVM wallet"]);
    await expect(b.addWallet({ address: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB", label: "evm wallet" })).rejects.toThrow("already have a wallet called");
    expect(b.removeWallet("EVM WALLET")).toBe(true);
    expect(b.wallets.wallets).toEqual([]);
  });

  it("reads a typed wallet; connecting it through its wallet app upgrades it, and only then can it send", async () => {
    const b = brain();
    const typed = await b.addWallet({ address: "0xabbea473fdde4409c6a1f0c7c527c1bda68e6c24", label: "Cash" });
    expect([isConnected(typed), signBlocker(typed)]).toEqual([false, expect.stringContaining("MetaMask")]);
    const connected = await b.addWallet({ address: "0xABBEa473fdDE4409C6A1F0c7C527C1bDa68E6C24", via: "metamask" });
    expect([connected.label, connected.via, isConnected(connected), signBlocker(connected)]).toEqual(["Cash", "metamask", true, null]);
    expect(b.wallets.wallets).toHaveLength(1);
    // Typing it again doesn't undo the connection.
    expect((await b.addWallet({ address: "0xabbea473fdde4409c6a1f0c7c527c1bda68e6c24" })).via).toBe("metamask");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ result: { amount: "1" } })));
    const near = await b.addWallet({ address: "savings.near", label: "Savings", via: "meteor-wallet" });
    vi.unstubAllGlobals();
    expect([isConnected(near), walletAppName(near.via)]).toEqual([true, "Meteor"]);
    expect([walletAppName("metamask"), walletAppName("hot-wallet"), walletAppName("typed")]).toEqual(["MetaMask", "HOT", null]);
  });

  it("never serves a saved loan or balance for a wallet you don't have", () => {
    const store = new Store(":memory:");
    store.saveSnapshot({
      takenAt: "", prices: {}, coins: {}, errors: [], scenario: null,
      positions: [{ id: "rhea:Old wallet", protocol: "rhea", chain: "near", walletLabel: "Old wallet", collateral: [], debt: [], collateralUsd: 40, debtUsd: 20, healthFactor: 1.38, liquidationDistance: null, observedAt: "", simulated: false }],
      balances: [{ walletLabel: "Old wallet", chain: "near", symbol: "NEAR", amount: 7.5, usd: 25 }],
    } as any);
    const b = new Brain(store);
    expect([b.latestSnapshot()!.positions, b.latestSnapshot()!.balances]).toEqual([[], []]);
  });

  it("checks that a NEAR account exists before adding it", async () => {
    const b = brain();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { cause: { name: "UNKNOWN_ACCOUNT" } } })));
    await expect(b.addWallet({ address: "nobody-here-123.near" })).rejects.toThrow("no NEAR account called");
    vi.unstubAllGlobals();
  });
});
