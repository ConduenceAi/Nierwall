import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Plan } from "../advisor/plans.js";
import type { Brain } from "../brain.js";
import { ROOT } from "../config.js";
import type { FixOption } from "../types.js";
import type { SignSessions } from "./sessions.js";

const DIST = resolve(ROOT, "apps/sign/dist");

/**
 * The review and connect page, with its security policy. NEAR Connect runs the wallet's code (Meteor's) as inline
 * scripts in a srcdoc iframe, which inherits this policy, so a fresh nonce per load lets exactly those scripts and
 * the page's own run.
 */
export function servePage(c: Context) {
  const p = resolve(DIST, "index.html");
  if (!existsSync(p)) return c.text("Build the page first: pnpm --filter @guardian/sign build", 500);
  const nonce = randomBytes(16).toString("base64");
  const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://raw.githubusercontent.com https://*.hot-labs.org; frame-src https: ; connect-src *; style-src 'self' 'unsafe-inline' https:; font-src https: data:; img-src * data:`;
  return c.html(readFileSync(p, "utf8").replace("<script ", `<script nonce="${nonce}" `), 200, { "cache-control": "no-store", "content-security-policy": csp });
}

function findFix(brain: Brain, fixId: string): FixOption | null {
  const saved = brain.store.kvGet<FixOption>(`fix:${fixId}`);
  if (saved) return saved;
  for (const a of brain.store.listAlerts(50)) {
    const f = a.fixes.find((x) => x.id === fixId);
    if (f) return f;
  }
  return null;
}

/** Review/sign routes. /api/* requires the Nierwall token; /sign/<one-time token> is the local page. */
export function registerSignRoutes(app: Hono, brain: Brain, sessions: SignSessions, port: number) {
  // Fixes (from alerts) and checked plans (from the advisor) share one review route.
  app.post("/api/fixes/:fixId/review", async (c) => {
    const id = c.req.param("fixId");
    // From the orb: the page asks each step's wallet app to sign it as soon as it's ready.
    const { auto } = z.object({ auto: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    const plan = id.startsWith("plan_") ? brain.store.kvGet<Plan>(`plan:${id}`) : null;
    const fix = plan ? null : findFix(brain, id);
    if (!plan && !fix) return c.json({ error: "Fix not found or expired" }, 404);
    try {
      const s = plan ? await sessions.createFromPlan(plan) : await sessions.create(fix!);
      return c.json({ url: `http://127.0.0.1:${port}/sign/${s.token}${auto ? "?auto=1" : ""}`, session: s });
    } catch (e) {
      return c.json({ error: String(e instanceof Error ? e.message : e).slice(0, 300) }, 400);
    }
  });

  app.get("/sign-assets/sign.js", (c) => {
    const p = resolve(DIST, "sign.js");
    if (!existsSync(p)) return c.text("Build the signing page first: pnpm --filter @guardian/sign build", 500);
    return c.body(readFileSync(p, "utf8"), 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
  });

  app.get("/sign/:token", (c) => {
    if (!sessions.get(c.req.param("token"))) return c.text("This review link has expired. Open the fix again from Nierwall.", 404);
    return servePage(c);
  });

  app.get("/sign/:token/session", (c) => {
    const s = sessions.get(c.req.param("token"));
    return s ? c.json(s) : c.json({ error: "expired" }, 404);
  });

  app.post("/sign/:token/steps/:stepId", async (c) => {
    const { txHash } = z.object({ txHash: z.string().min(10).max(200) }).parse(await c.req.json());
    const stepId = z.string().regex(/^[a-z0-9_]{1,24}$/).parse(c.req.param("stepId"));
    try {
      return c.json(await sessions.record(c.req.param("token"), stepId, txHash));
    } catch (e) {
      return c.json({ error: String(e instanceof Error ? e.message : e) }, 400);
    }
  });
}
