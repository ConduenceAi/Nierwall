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

  app.get("/snap/health", (c) => {
    brain.snapSeenAt = Date.now();
    return c.json({ ok: true, lastRefresh: brain.latestSnapshot()?.takenAt ?? null });
  });

  // One-click install of the local Snap into MetaMask Flask (`pnpm snap` serves it on localhost:8080). It says which
  // wallets it found and what's missing: regular MetaMask only installs Snaps MetaMask has reviewed, so a local one needs Flask.
  app.get("/snap/install", (c) =>
    c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install Nierwall Snap</title><style>body{font:15px/1.55 system-ui;max-width:560px;margin:40px auto;padding:0 18px;color:#000;background:#fff}
@media (prefers-color-scheme:dark){body{color:#fff;background:#000}}a{color:#3B82F6}code{font-size:13px}
button{background:#3B82F6;color:#fff;border:0;border-radius:9px;padding:10px 16px;font:600 15px system-ui;cursor:pointer}
#out{margin-top:14px}#out ol{padding-left:20px}</style></head>
<body><h1>Nierwall for MetaMask</h1><p>Installs the Nierwall Snap from <code>http://localhost:8080</code> into <b>MetaMask Flask</b>.
It shows Nierwall's check inside MetaMask's confirmation screen before you sign.</p>
<button id="b">Install Nierwall Snap</button><div id="out"></div>
<script>
const providers=[];window.addEventListener("eip6963:announceProvider",e=>providers.push(e.detail));window.dispatchEvent(new Event("eip6963:requestProvider"));
const FLASK="https://docs.metamask.io/snaps/get-started/install-flask/";
const show=html=>{document.getElementById("out").innerHTML=html;};
document.getElementById("b").onclick=async()=>{
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise(r=>setTimeout(r,300));
  const flask=providers.find(p=>p.info.rdns==="io.metamask.flask");
  const regular=providers.find(p=>p.info.rdns==="io.metamask");
  if(!flask){
    show(regular
      ? "<p><b>This browser has MetaMask, not MetaMask Flask.</b> Regular MetaMask only installs Snaps MetaMask has reviewed; a Snap running on your Mac needs Flask, MetaMask's developer edition.</p><ol><li><a href='"+FLASK+"' target='_blank' rel='noopener'>Install MetaMask Flask</a>, best in a separate browser profile: Flask and MetaMask can't run side by side, so in this profile you'd have to turn MetaMask off first.</li><li>Set up a wallet in Flask, then open this page again in that profile and press Install.</li></ol>"
      : "<p><b>No MetaMask found in this browser.</b> <a href='"+FLASK+"' target='_blank' rel='noopener'>Install MetaMask Flask</a>, set up a wallet, then reload this page.</p>");
    return;
  }
  // The Snap is served by \`pnpm snap\`; without it, MetaMask can't fetch it.
  const served=await fetch("http://localhost:8080/snap.manifest.json",{mode:"no-cors",cache:"no-store"}).then(()=>true,()=>false);
  if(!served){show("<p><b>The Snap isn't being served.</b> In the Nierwall folder, run <code>pnpm snap</code> and leave it running, then press Install again.</p>");return;}
  try{const r=await flask.provider.request({method:"wallet_requestSnaps",params:{"local:http://localhost:8080":{}}});
    show("<p><b>Installed:</b> "+Object.keys(r).join(", ")+". Turn on Transaction safety in Nierwall, then start a transaction in Flask to see Nierwall's check.</p>");}
  catch(e){show("<p>Install failed: "+(e.message||e)+"</p>");}
};
</script></body></html>`),
  );

  app.post("/snap/analyze", async (c) => {
    const input = Input.parse(await c.req.json());
    brain.snapSeenAt = Date.now();
    // Transaction safety is off until the user turns it on in the app.
    if (!brain.connections.transactionSafety) {
      return c.json({ status: "unknown", summary: "Nierwall's checks are off", findings: [{ severity: "info", title: "Transaction safety is off", detail: "Turn it on in the Nierwall app (Transaction safety, under the shield) to check transactions before you sign. Until then this one isn't checked." }] });
    }
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
