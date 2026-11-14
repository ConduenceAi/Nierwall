import type { Hono } from "hono";
import { z } from "zod";
import { allocationOf } from "../advisor/plans.js";
import type { Brain } from "../brain.js";
import { networkName } from "../chains.js";
import { EVM_NETWORKS, type Wallet } from "../config.js";
import { isConnected, walletAppName } from "../connections.js";
import { readHoldings } from "../holdings.js";
import { readRhea } from "../protocols/rhea.js";
import { sumUsd } from "../protocols/risk.js";
import { servePage } from "../sign/routes.js";
import type { LendingPosition } from "../types.js";

/**
 * The app's wallets view: every wallet Nierwall watches (with any Rhea loan found), which of them are connected and can
 * be sent transactions, and whether transaction safety is on.
 */
const cents = (usd: number) => Math.round(usd * 100) / 100;

export function publicConnections(brain: Brain) {
  const positions = brain.latestSnapshot()?.positions ?? [];
  const { transactionSafety } = brain.connections;
  return {
    wallets: brain.wallets.wallets.map((w) => {
      const loan = positions.find((p) => p.walletLabel === w.label);
      return {
        label: w.label, chain: w.chain, address: w.address, app: walletAppName(w.via), connected: isConnected(w), networks: w.networks ?? null,
        rhea: loan ? { healthFactor: loan.healthFactor, collateralUsd: cents(loan.collateralUsd), debtUsd: cents(loan.debtUsd) } : null,
      };
    }),
    transactionSafety,
  };
}

/**
 * The tokens in your wallets and what they're worth, for the app's Tokens view: at live prices (no simulated scenario),
 * Rhea loans netted into the total. Read on request and cached for 2 minutes.
 */
let tokensCache: { at: number; key: string; body: unknown } | null = null;
async function yourTokens(wallets: Wallet[]) {
  const key = JSON.stringify(wallets.map((w) => [w.label, w.address, w.networks ?? null]));
  if (tokensCache && tokensCache.key === key && Date.now() - tokensCache.at < 120_000) return tokensCache.body;
  const [{ holdings, errors }, loans] = await Promise.all([
    readHoldings(wallets, null),
    Promise.all(wallets.filter((w) => w.chain === "near").map((w) => readRhea(w.label, w.address, null).then((ds) => ds.map((d) => d.position)).catch(() => null))),
  ]);
  const positions: LendingPosition[] = loans.flatMap((ps) => ps ?? []);
  // One line per token and network, across your wallets, biggest first.
  const byToken = new Map<string, { symbol: string; chain: string; network: string; amount: number; usd: number | null }>();
  for (const h of holdings) {
    const k = `${h.chain}:${h.symbol}`;
    const t = byToken.get(k) ?? { symbol: h.symbol, chain: h.chain, network: networkName(h.chain), amount: 0, usd: 0 };
    t.amount += h.amount;
    t.usd = t.usd == null || h.usd == null ? null : t.usd + h.usd;
    byToken.set(k, t);
  }
  const body = {
    tokens: [...byToken.values()].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)),
    totalUsd: allocationOf(holdings, positions).netWorthUsd,
    loansUsd: positions.length ? Math.round(positions.reduce((sum, p) => sum + p.collateralUsd + sumUsd(p.supplied ?? []) - p.debtUsd, 0)) : null,
    complete: errors.length === 0,
  };
  tokensCache = { at: Date.now(), key, body };
  return body;
}

/** A wallet typed into the app: watched by address, never sent anything. */
const TypedWallet = z.object({
  address: z.string().min(2).max(100),
  label: z.string().max(40).optional(),
  networks: z.array(z.enum(EVM_NETWORKS)).min(1).optional(),
});

/** A wallet connected on the page: the account or address, and the wallet app it came from (a NEAR Connect id, or "metamask"). */
const ConnectedWallet = z.object({
  address: z.string().min(2).max(100),
  label: z.string().max(40).optional(),
  via: z.string().min(1).max(40).refine((v) => v !== "typed", "A connected wallet names its wallet app."),
});

/** Wallets: /api/* needs the Nierwall token; /connect/<one-time token> is the local page that connects a wallet. */
export function registerConnectionRoutes(app: Hono, brain: Brain) {
  app.get("/api/connections", (c) => c.json(publicConnections(brain)));

  app.get("/api/tokens", async (c) => {
    try {
      return c.json(await yourTokens(brain.connections.wallets));
    } catch (e) {
      return c.json({ error: String(e instanceof Error ? e.message : e).slice(0, 200) }, 502);
    }
  });

  app.post("/api/wallets", async (c) => {
    try {
      const wallet = await brain.addWallet({ ...TypedWallet.parse(await c.req.json()), via: "typed" });
      return c.json({ wallet: wallet.label, connections: publicConnections(brain) });
    } catch (e) {
      return c.json({ error: e instanceof z.ZodError ? "Type a NEAR account (like you.near) or a 0x address." : String(e instanceof Error ? e.message : e) }, 400);
    }
  });

  app.delete("/api/wallets/:label", (c) => {
    const removed = brain.removeWallet(decodeURIComponent(c.req.param("label")));
    return removed ? c.json(publicConnections(brain)) : c.json({ error: "No wallet by that name" }, 404);
  });

  app.post("/api/settings", async (c) => {
    brain.setFeatures(z.object({ transactionSafety: z.boolean().optional() }).parse(await c.req.json()));
    return c.json(publicConnections(brain));
  });

  app.post("/api/connect", (c) => c.json({ url: brain.connectLink() }));

  app.get("/connect/:token", (c) => {
    if (!brain.connectLinks.valid(c.req.param("token"))) return c.text("This link has expired. Ask Nierwall to connect a wallet again.", 404);
    return servePage(c);
  });

  // The page sends only the account it read from the wallet: no keys, and no signature is ever asked for.
  app.post("/connect/:token/wallet", async (c) => {
    if (!brain.connectLinks.valid(c.req.param("token"))) return c.json({ error: "This link has expired." }, 404);
    try {
      const wallet = await brain.addWallet(ConnectedWallet.parse(await c.req.json()));
      return c.json({ wallet: wallet.label, chain: wallet.chain });
    } catch (e) {
      return c.json({ error: e instanceof z.ZodError ? "The wallet didn't share a usable account." : String(e instanceof Error ? e.message : e) }, 400);
    }
  });
}
