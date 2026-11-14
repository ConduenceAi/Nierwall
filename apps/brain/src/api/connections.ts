import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Hono } from "hono";
import { z } from "zod";
import type { Brain } from "../brain.js";
import { EVM_NETWORKS, ROOT } from "../config.js";
import { walletAppName } from "../connections.js";

const PAGE = resolve(ROOT, "apps/sign/dist/index.html");
const CSP = "default-src 'self'; script-src 'self' https://raw.githubusercontent.com https://*.hot-labs.org; frame-src https: ; connect-src *; style-src 'self' 'unsafe-inline'; img-src * data:";

/** What's connected, for the app's Connections view: your wallets (with any Rhea loan found), and what's turned on. */
export function publicConnections(brain: Brain) {
  const positions = brain.latestSnapshot()?.positions ?? [];
  const { wallets, demo, transactionSafety } = brain.connections;
  return {
    wallets: wallets.map((w) => {
      const loan = positions.find((p) => p.walletLabel === w.label);
      return {
        label: w.label, chain: w.chain, address: w.address, app: walletAppName(w.via), networks: w.networks ?? null,
        rhea: loan ? { healthFactor: loan.healthFactor, collateralUsd: Math.round(loan.collateralUsd), debtUsd: Math.round(loan.debtUsd) } : null,
      };
    }),
    demo,
    usingDemo: brain.usingDemo,
    transactionSafety,
  };
}

const WalletInput = z.object({
  address: z.string().min(2).max(100),
  label: z.string().max(40).optional(),
  via: z.string().max(40).optional(),
  networks: z.array(z.enum(EVM_NETWORKS)).min(1).optional(),
});

/** Connections: /api/* needs the Nierwall token; /connect/<one-time token> is the local page that adds a wallet. */
export function registerConnectionRoutes(app: Hono, brain: Brain) {
  app.get("/api/connections", (c) => c.json(publicConnections(brain)));

  app.post("/api/wallets", async (c) => {
    try {
      const wallet = await brain.addWallet(WalletInput.parse(await c.req.json()));
      return c.json({ wallet: wallet.label, connections: publicConnections(brain) });
    } catch (e) {
      return c.json({ error: String(e instanceof Error ? e.message : e) }, 400);
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
    if (!existsSync(PAGE)) return c.text("Build the page first: pnpm --filter @guardian/sign build", 500);
    return c.html(readFileSync(PAGE, "utf8"), 200, { "cache-control": "no-store", "content-security-policy": CSP });
  });

  // The page sends only an address it read from the wallet: no keys, and no signature is ever asked for.
  app.post("/connect/:token/wallet", async (c) => {
    if (!brain.connectLinks.valid(c.req.param("token"))) return c.json({ error: "This link has expired." }, 404);
    try {
      const input = WalletInput.pick({ address: true, via: true, label: true }).parse(await c.req.json());
      const wallet = await brain.addWallet(input);
      return c.json({ wallet: wallet.label, chain: wallet.chain });
    } catch (e) {
      return c.json({ error: String(e instanceof Error ? e.message : e) }, 400);
    }
  });
}
