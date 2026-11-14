import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono, type Context, type Next } from "hono";
import type { WSContext } from "hono/ws";
import { z } from "zod";
import type { Assistant } from "../ai/assistant.js";
import { alertCards, positionCard } from "../ai/cards.js";
import type { Brain } from "../brain.js";
import { logger } from "../log.js";
import { describeWatch } from "../watches/engine.js";
import type { Snapshot, WatchKind } from "../types.js";

const log = logger("api");

export interface ApiOptions {
  brain: Brain;
  assistant: Assistant;
  token: string;
  port: number;
  telegram?: { pairLink(): Promise<string | null>; linked(): boolean };
  /** Extra route groups registered by other modules (wallets, the connect and signing page). */
  extend?: Array<(app: Hono) => void>;
}

export type ServerMessage =
  | { type: "hello"; status: Record<string, unknown> }
  | { type: "snapshot"; snapshot: PublicSnapshot }
  | { type: "alert"; alert: ReturnType<typeof alertCards>; raw: unknown }
  | { type: "reply"; requestId: string; reply: unknown }
  | { type: "review"; alertId: string }
  | { type: "error"; requestId?: string; message: string };

/** Snapshot without wallet addresses: labels and numbers only. */
export type PublicSnapshot = Omit<Snapshot, "positions"> & { positions: Array<Snapshot["positions"][number]> };

function publicSnapshot(s: Snapshot): PublicSnapshot {
  return s; // positions and balances already carry labels, never addresses
}

const WatchInput = z.object({
  kind: z.enum(["health_below", "price_below", "price_move", "liq_distance", "balance_min"]),
  params: z.record(z.string(), z.unknown()),
  confirm: z.boolean().default(false),
  source: z.enum(["user", "memory", "system"]).default("user"),
});

export function startApi(opts: ApiOptions) {
  const { brain, assistant, token } = opts;
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const clients = new Set<WSContext>();

  const authed = async (c: Context, next: Next) => {
    const t = c.req.header("x-guardian-token") ?? c.req.query("token");
    if (t !== token) return c.json({ error: "unauthorized" }, 401);
    await next();
  };

  const status = () => {
    const snap = brain.latestSnapshot();
    return {
      lastRefresh: snap?.takenAt ?? null,
      scenario: snap?.scenario ?? null,
      openIncidents: brain.store.listIncidents("open").length,
      dataProblems: snap?.errors.length ?? 0,
      telegramLinked: opts.telegram?.linked() ?? false,
      attestation: assistant.attestation(),
      state: !snap ? "loading" : (snap.errors.length ? "degraded" : brain.store.listIncidents("open").length ? "attention" : "ok"),
    };
  };

  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
    log.error("request failed", { path: c.req.path, err: String(err).slice(0, 200) });
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, service: "guardian-brain" }));

  app.use("/api/*", authed);
  app.get("/api/status", (c) => c.json(status()));
  app.get("/api/portfolio", (c) => {
    const snap = brain.latestSnapshot();
    if (!snap) return c.json({ error: "not ready" }, 503);
    const watches = brain.store.listWatches("active");
    return c.json({ snapshot: publicSnapshot(snap), cards: snap.positions.map((p) => positionCard(p, watches)) });
  });
  app.post("/api/refresh", async (c) => {
    const r = await brain.refreshNow();
    return c.json({ takenAt: r.data.snapshot.takenAt, alerts: r.alerts.length });
  });

  app.get("/api/watches", (c) => c.json(brain.store.listWatches()));
  app.post("/api/watches", async (c) => {
    const body = WatchInput.parse(await c.req.json());
    const label = describeWatch(body.kind as WatchKind, body.params as Record<string, any>);
    const w = brain.store.newWatch({ kind: body.kind, label, params: body.params, source: body.source, status: body.confirm ? "active" : "proposed" });
    return c.json(w);
  });
  app.post("/api/watches/:id/confirm", (c) => {
    const w = brain.store.confirmWatch(c.req.param("id"));
    if (!w) return c.json({ error: "not found" }, 404);
    brain.store.addEvent("watch_confirmed", { label: w.label });
    void brain.refreshNow();
    return c.json(w);
  });
  app.delete("/api/watches/:id", (c) => {
    brain.store.deleteWatch(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/api/alerts", (c) => c.json(brain.store.listAlerts(Number(c.req.query("limit") ?? 20))));
  app.get("/api/incidents", (c) => c.json(brain.store.listIncidents(undefined, 50)));
  app.post("/api/incidents/:id/snooze", async (c) => {
    const { minutes } = z.object({ minutes: z.number().int().min(1).max(7 * 24 * 60) }).parse(await c.req.json());
    return c.json(brain.snooze(c.req.param("id"), minutes) ?? { error: "not found" });
  });
  app.post("/api/incidents/:id/ack", (c) => c.json(brain.acknowledge(c.req.param("id")) ?? { error: "not found" }));

  app.post("/api/scenario", async (c) => {
    const body = z.object({ shocks: z.partialRecord(z.enum(["ETH", "NEAR", "USDC"]), z.number()), note: z.string().default("") }).parse(await c.req.json());
    const s = brain.scenario.start(body.shocks, body.note);
    const r = await brain.refreshNow();
    return c.json({ scenario: s, alerts: r.alerts.length });
  });
  app.delete("/api/scenario", async (c) => {
    brain.scenario.clear();
    const r = await brain.refreshNow();
    return c.json({ cleared: true, alerts: r.alerts.length });
  });

  app.post("/api/chat", async (c) => {
    const { text } = z.object({ text: z.string().min(1).max(4000) }).parse(await c.req.json());
    return c.json(await assistant.reply(text, "mac"));
  });

  app.post("/api/telegram/pair", async (c) => {
    const link = await opts.telegram?.pairLink();
    return link ? c.json({ link }) : c.json({ error: "Telegram is not configured (set TELEGRAM_BOT_TOKEN)" }, 400);
  });

  for (const register of opts.extend ?? []) register(app);

  app.get(
    "/ws",
    async (c, next) => {
      const t = c.req.query("token") ?? c.req.header("x-guardian-token");
      if (t !== token) return c.text("unauthorized", 401);
      await next();
    },
    upgradeWebSocket(() => ({
      onOpen(_e, ws) {
        clients.add(ws);
        log.info("client connected", { clients: clients.size });
        ws.send(JSON.stringify({ type: "hello", status: status() } satisfies ServerMessage));
        const snap = brain.latestSnapshot();
        if (snap) ws.send(JSON.stringify({ type: "snapshot", snapshot: publicSnapshot(snap) } satisfies ServerMessage));
      },
      async onMessage(e, ws) {
        let msg: { type?: string; requestId?: string; text?: string };
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (msg.type === "chat" && msg.text) {
          try {
            const reply = await assistant.reply(msg.text, "mac");
            ws.send(JSON.stringify({ type: "reply", requestId: msg.requestId ?? "", reply } satisfies ServerMessage));
          } catch (err) {
            ws.send(JSON.stringify({ type: "error", requestId: msg.requestId, message: String(err).slice(0, 200) } satisfies ServerMessage));
          }
        }
      },
      onClose(_e, ws) {
        clients.delete(ws);
      },
    })),
  );

  const server = serve({ fetch: app.fetch, port: opts.port, hostname: "127.0.0.1" });
  injectWebSocket(server);
  log.info("listening", { url: `http://127.0.0.1:${opts.port}` });

  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      try {
        ws.send(data);
      } catch {
        clients.delete(ws);
      }
    }
  };
  return { app, server, broadcast, clientCount: () => clients.size, status };
}
