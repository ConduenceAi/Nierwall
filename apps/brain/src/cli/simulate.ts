/**
 * Applies a price shock to the running brain so an alert can be shown without waiting for a crash.
 * Alerts it causes are labeled SIMULATED everywhere and never written to memory.
 *   pnpm simulate NEAR -9 ETH -10   move NEAR by -9% and ETH by -10% (ETH, NEAR or USDC)
 *   pnpm simulate off               back to real prices
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_SUPPORT, type RuntimeInfo } from "../runtime.js";

const args = process.argv.slice(2).filter((a) => a !== "--");
const usage = "Usage: pnpm simulate NEAR -9 [ETH -10]   or   pnpm simulate off";

let info: RuntimeInfo;
try {
  info = JSON.parse(readFileSync(join(APP_SUPPORT, "brain.json"), "utf8")) as RuntimeInfo;
} catch {
  console.error("The brain isn't running. Start it with: pnpm brain");
  process.exit(1);
}
const headers = { "x-guardian-token": info.token, "content-type": "application/json" };

async function send(init: RequestInit, path = "/api/scenario") {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}${path}`, { ...init, headers });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(body.error ?? res.statusText));
    return body;
  } catch (e) {
    console.error(`The brain didn't accept it: ${e instanceof Error ? e.message : e}. Is \`pnpm brain\` running?`);
    process.exit(1);
  }
}

if (args[0] === "off") {
  const r = await send({ method: "DELETE" });
  console.log(`Back to real prices. ${r.alerts} alert(s) from the refresh.`);
} else {
  const shocks: Record<string, number> = {};
  for (let i = 0; i < args.length; i += 2) {
    const sym = args[i]?.toUpperCase();
    const pct = Number(String(args[i + 1]).replace("%", ""));
    if (!sym || !["ETH", "NEAR", "USDC"].includes(sym) || !Number.isFinite(pct) || pct <= -100) {
      console.error(usage);
      process.exit(1);
    }
    shocks[sym] = pct / 100;
  }
  if (!Object.keys(shocks).length) {
    console.error(usage);
    process.exit(1);
  }
  const r = await send({ method: "POST", body: JSON.stringify({ shocks }) });
  const label = Object.entries(shocks).map(([s, v]) => `${s} ${v > 0 ? "+" : ""}${Math.round(v * 1000) / 10}%`).join(", ");
  console.log(`SIMULATED: ${label}. ${r.alerts} new alert(s). Undo with: pnpm simulate off`);
  if (!r.alerts) {
    const watches = (await send({ method: "GET" }, "/api/watches")) as unknown as Array<{ source: string; status: string }>;
    console.log(watches.some((w) => w.source !== "system" && w.status === "active")
      ? "None of your watches crossed its limit at these prices. Try a bigger move."
      : "You haven't set any watches yet. Ask Nierwall first, e.g. “Ping me if my Rhea health goes under 1.3”, and confirm it.");
  }
}
