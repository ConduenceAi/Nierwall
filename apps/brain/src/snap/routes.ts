import type { Hono } from "hono";
import { z } from "zod";
import type { Brain } from "../brain.js";
import { logger } from "../log.js";
import { analyzeTx, type PendingDeposit } from "./analyze.js";

const log = logger("snap");

const Input = z.object({
  chainId: z.string().max(40),
  transaction: z.object({ from: z.string().optional(), to: z.string().optional(), data: z.string().max(200_000).optional(), value: z.string().optional() }).passthrough(),
  origin: z.string().max(300).optional(),
});

/**
 * Routes called by the MetaMask Snap from inside MetaMask's sandbox. Bound to 127.0.0.1 only. Responses carry
 * warnings and health numbers, never wallet addresses or balances beyond what the transaction already contains.
 */
export function registerSnapRoutes(app: Hono, brain: Brain, pendingDeposits: () => PendingDeposit[] = () => []) {
  app.use("/snap/*", async (c, next) => {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      // Chrome Private Network Access: MetaMask's sandbox (public origin) calling 127.0.0.1.
      "Access-Control-Allow-Private-Network": "true",
      "Access-Control-Max-Age": "600",
    };
    if (c.req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    await next();
    for (const [k, v] of Object.entries(cors)) c.res.headers.set(k, v);
  });

  app.get("/snap/health", (c) => c.json({ ok: true, lastRefresh: brain.latestSnapshot()?.takenAt ?? null }));

  // One-click install of the local Snap into MetaMask Flask (run `pnpm --filter @guardian/snap serve` first).
  app.get("/snap/install", (c) =>
    c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install Nierwall Snap</title><style>body{font:15px/1.5 system-ui;max-width:560px;margin:40px auto;padding:0 18px;color:#101828;background:#F2F4F7}
button{background:#2446D8;color:#fff;border:0;border-radius:9px;padding:10px 16px;font:600 15px system-ui;cursor:pointer}#out{margin-top:14px}</style></head>
<body><h1>Nierwall for MetaMask</h1><p>Installs the Nierwall Snap from <code>http://localhost:8080</code> into <b>MetaMask Flask</b>.
It shows Nierwall's check inside MetaMask's confirmation screen before you sign.</p>
<button id="b">Install Nierwall Snap</button><div id="out"></div>
<script>
const providers=[];window.addEventListener("eip6963:announceProvider",e=>providers.push(e.detail));window.dispatchEvent(new Event("eip6963:requestProvider"));
document.getElementById("b").onclick=async()=>{const out=document.getElementById("out");
const flask=providers.find(p=>p.info.rdns==="io.metamask.flask");
if(!flask){out.textContent="MetaMask Flask not found. Local Snaps need Flask (the developer build of MetaMask).";return;}
try{const r=await flask.provider.request({method:"wallet_requestSnaps",params:{"local:http://localhost:8080":{}}});
out.textContent="Installed: "+Object.keys(r).join(", ")+". Make a transaction on Base to see Nierwall's check.";}catch(e){out.textContent="Install failed: "+(e.message||e);}};
</script></body></html>`),
  );

  app.post("/snap/analyze", async (c) => {
    const input = Input.parse(await c.req.json());
    try {
      const result = await analyzeTx(brain, input, pendingDeposits());
      brain.store.addEvent("presign_check", { status: result.status, summary: result.summary, origin: input.origin ?? null });
      return c.json(result);
    } catch (e) {
      log.warn("analysis failed", { err: String(e).slice(0, 200) });
      return c.json({ status: "unknown", summary: "Analysis failed", findings: [{ severity: "info", title: "Nierwall couldn't analyze this", detail: "Treat it as unchecked, not as safe." }] });
    }
  });
}
