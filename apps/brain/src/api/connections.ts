import type { Hono } from "hono";
import { z } from "zod";
import type { Brain } from "../brain.js";
import { EVM_NETWORKS } from "../config.js";
import { isConnected, walletAppName } from "../connections.js";
import { isDemoWallet } from "../demo.js";
import { servePage } from "../sign/routes.js";

/**
 * The app's wallets view: your wallets (with any Rhea loan found), which of them are connected and can be sent
 * transactions, and what's turned on.
 */
export function publicConnections(brain: Brain) {
  const positions = brain.latestSnapshot()?.positions ?? [];
  const { demo, transactionSafety } = brain.connections;
  // While the demo portfolio stands in for yours, its wallets are listed, marked as the demo.
  return {
    wallets: brain.wallets.wallets.map((w) => {
      const loan = positions.find((p) => p.walletLabel === w.label);
      return {
        label: w.label, chain: w.chain, address: w.address, app: walletAppName(w.via), connected: isConnected(w), demo: isDemoWallet(w), networks: w.networks ?? null,
        rhea: loan ? { healthFactor: loan.healthFactor, collateralUsd: Math.round(loan.collateralUsd), debtUsd: Math.round(loan.debtUsd) } : null,
      };
    }),
    demo,
    usingDemo: brain.usingDemo,
    transactionSafety,
  };
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
    brain.setFeatures(z.object({ demo: z.boolean().optional(), transactionSafety: z.boolean().optional() }).parse(await c.req.json()));
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
