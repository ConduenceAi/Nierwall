import { NearConnector } from "@hot-labs/near-connect";

/**
 * Nierwall's review and connect page. Runs on 127.0.0.1, opened from the Mac app. It never sees keys. Each step goes to
 * the wallet app its wallet was connected with: a NEAR wallet (Meteor or another) through NEAR Connect, or MetaMask for
 * EVM steps (on whichever network the step names) through EIP-6963.
 */

interface Step {
  id: string;
  kind: "evm" | "near" | "intents" | "link";
  title: string;
  detail: string;
  state: "waiting" | "ready" | "submitted" | "done" | "failed";
  chain: string | null;
  wallet: string | null;
  expectedSigner: string | null;
  /** The wallet app the signer was connected with ("meteor-wallet", "metamask"), and its name for people. */
  walletApp?: string;
  walletAppName?: string;
  evmTx?: {
    chainId: number;
    to: string;
    data: string;
    value: string;
    network: { name: string; symbol: string; rpcUrl: string; explorerUrl: string | null };
  };
  nearTx?: { receiverId: string; actions: any[] };
  txHash?: string;
  link?: string;
}
interface Session {
  title: string;
  expiresAt: string;
  healthBefore: number | null;
  healthAfter: number | null;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  privacyNote: string | null;
  steps: Step[];
  done: boolean;
}
interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<any>;
}

const token = location.pathname.split("/").filter(Boolean)[1] ?? "";
// Opened by the orb after you said yes: ask each step's wallet to sign it as soon as it's ready, once. You still approve
// every step in the wallet.
const auto = new URLSearchParams(location.search).get("auto") === "1";
const asked = new Set<string>();
/** Steps waiting on a wallet right now. */
const inFlight = new Set<string>();
const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ---- EIP-6963 wallet discovery: the EVM wallet a step's wallet was connected with, MetaMask first ----
const providers: Array<{ info: { rdns: string; name: string }; provider: Eip1193 }> = [];
window.addEventListener("eip6963:announceProvider", (e: any) => providers.push(e.detail));
window.dispatchEvent(new Event("eip6963:requestProvider"));

/** The browser wallet for an EVM wallet connected as `app` ("metamask", or another wallet's rdns). */
function pickEvmProvider(app?: string): { provider: Eip1193; rdns: string } | null {
  const mm = providers.find((p) => p.info.rdns.startsWith("io.metamask"));
  const chosen = (app && app !== "metamask" ? providers.find((p) => p.info.rdns === app) : undefined) ?? mm ?? providers[0];
  if (chosen) return { provider: chosen.provider, rdns: chosen.info.rdns };
  const injected = (window as any).ethereum as Eip1193 | undefined;
  return injected ? { provider: injected, rdns: "" } : null;
}

async function api(path: string, body?: unknown) {
  const res = await fetch(`/sign/${token}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

/** The wallet app a step opens, for people. */
const appName = (step: Step) => step.walletAppName ?? (step.kind === "evm" ? "MetaMask" : "your NEAR wallet");

async function sendEvm(step: Step) {
  const found = pickEvmProvider(step.walletApp);
  if (!found) throw new Error("No browser wallet found. Install MetaMask in this browser.");
  const { provider } = found;
  const [account] = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!account || account.toLowerCase() !== step.expectedSigner!.toLowerCase()) {
    throw new Error(`Switch ${appName(step)} to your "${step.wallet}" account (${step.expectedSigner}).`);
  }
  const tx = step.evmTx!;
  const chainHex = `0x${tx.chainId.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
  } catch (e: any) {
    // The wallet doesn't know this network yet: offer to add it.
    if (e?.code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: chainHex, chainName: tx.network.name,
          nativeCurrency: { name: tx.network.symbol, symbol: tx.network.symbol, decimals: 18 },
          rpcUrls: [tx.network.rpcUrl], ...(tx.network.explorerUrl ? { blockExplorerUrls: [tx.network.explorerUrl] } : {}),
        }],
      });
    } else throw e;
  }
  const hash = (await provider.request({
    method: "eth_sendTransaction",
    params: [{ from: account, to: step.evmTx!.to, data: step.evmTx!.data, value: step.evmTx!.value }],
  })) as string;
  await api(`/steps/${step.id}`, { txHash: hash });
}

// The nonce this page was served with. NEAR Connect puts it on each wallet's sandboxed scripts, so the page's security
// policy lets the wallet's code run.
const cspNonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce || undefined;
let connector: NearConnector | null = null;
// Every NEAR wallet NEAR Connect lists, except its "Ethereum Wallets" entry: EVM wallets connect through MetaMask here.
const near = () => (connector ??= new NearConnector({ network: "mainnet", cspNonce, excludedWallets: ["ethereum-wallets"], features: { signAndSendTransaction: true } }));

async function sendNear(step: Step) {
  // Straight to the wallet app the account was connected with; the full list if NEAR Connect doesn't know it.
  const wallet = await near()
    .connect(step.walletApp ? { walletId: step.walletApp } : undefined)
    .catch((e) => (String(e).includes("Wallet not found") ? near().connect() : Promise.reject(e)));
  const accounts = await wallet.getAccounts();
  const accountId = accounts[0]?.accountId;
  if (accountId !== step.expectedSigner) {
    throw new Error(`Connect the "${step.wallet}" account (${step.expectedSigner}); you connected ${accountId ?? "no account"}.`);
  }
  const outcome: any = await wallet.signAndSendTransaction({ receiverId: step.nearTx!.receiverId, actions: step.nearTx!.actions } as any);
  const hash = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id;
  if (!hash) throw new Error("The wallet didn't return a transaction hash.");
  await api(`/steps/${step.id}`, { txHash: hash });
}

function render(s: Session) {
  const hb = s.healthBefore != null ? s.healthBefore.toFixed(2) : "–";
  const ha = s.healthAfter != null ? s.healthAfter.toFixed(2) : "–";
  $("title").textContent = s.title;
  $("health").innerHTML = `Health <b>${hb}</b> → <b>${ha}</b> <span class="muted">(estimate, re-checked at each step)</span>`;
  $("checks").innerHTML = s.checks.length
    ? s.checks.map((c) => `<li class="${c.ok ? "ok" : "bad"}">${c.ok ? "✓" : "✕"} ${esc(c.detail)}</li>`).join("")
    : `<li class="muted">No cross-chain quote needed for this fix.</li>`;
  $("privacy").textContent = s.privacyNote ?? "";
  $("privacy").hidden = !s.privacyNote;
  $("steps").innerHTML = s.steps
    .map((st, i) => {
      const action =
        st.state === "ready" && st.kind === "evm" ? `<button data-step="${st.id}">Sign with ${esc(appName(st))} on ${esc(st.evmTx?.network.name ?? "EVM")}</button>` :
        st.state === "ready" && st.kind === "near" && st.nearTx ? `<button data-step="${st.id}">Sign with ${esc(appName(st))}</button>` :
        st.state === "ready" && st.link ? `<a class="button" href="${esc(st.link)}" target="_blank" rel="noopener">Open Rhea</a> <button data-step="${st.id}" data-manual="1">I've done this</button>` : "";
      const hash = st.txHash ? `<div class="hash">tx ${esc(st.txHash.slice(0, 18))}…</div>` : "";
      return `<li class="step ${st.state}"><div class="n">${i + 1}</div><div class="body"><div class="t">${esc(st.title)} <span class="state">${st.state}</span></div><div class="d">${esc(st.detail)}</div>${hash}${action}</div></li>`;
    })
    .join("");
  $("done").hidden = !s.done;
  document.querySelectorAll<HTMLButtonElement>("button[data-step]").forEach((b) => {
    const step = s.steps.find((x) => x.id === b.dataset.step)!;
    b.disabled = inFlight.has(step.id);
    b.addEventListener("click", () => void sign(step, !!b.dataset.manual));
  });
  // From the orb: hand the next ready step to its wallet, once. A step you turn down waits for a click.
  const next = auto && !s.done && !inFlight.size
    ? s.steps.find((st) => st.state === "ready" && (st.kind === "evm" || (st.kind === "near" && st.nearTx)) && !asked.has(st.id))
    : undefined;
  if (next) {
    asked.add(next.id);
    void sign(next, false);
  }
  const waiting = s.steps.find((st) => inFlight.has(st.id));
  const sent = s.steps.find((st) => st.state === "submitted" && st.kind !== "intents");
  const n = (st: Step) => s.steps.indexOf(st) + 1;
  $("status").textContent = waiting && waiting.kind !== "link" ? `Waiting for you to approve step ${n(waiting)} in ${appName(waiting)}.`
    : sent ? `Step ${n(sent)} sent. Waiting for the network to confirm it.` : "";
}

/** Hands a step to its wallet (or marks a manual step done), then shows the result. */
async function sign(step: Step, manual: boolean) {
  if (inFlight.has(step.id)) return;
  inFlight.add(step.id);
  $("error").textContent = "";
  try {
    if (manual) await api(`/steps/${step.id}`, { txHash: "manual-done" });
    else if (step.kind === "evm") await sendEvm(step);
    else await sendNear(step);
  } catch (e: any) {
    $("error").textContent = e?.message ?? String(e);
  } finally {
    inFlight.delete(step.id);
    await refresh();
  }
}

async function refresh() {
  try {
    render((await api("/session")) as Session);
  } catch (e: any) {
    $("error").textContent = `This review link has expired or is invalid. Open the fix again from Nierwall. (${e?.message ?? e})`;
  }
}

// ---- Connect a wallet: the page reads only the account or address and sends it to Nierwall ----

async function addWallet(address: string, via: string) {
  const label = ($("nickname") as HTMLInputElement).value.trim() || undefined;
  const res = await fetch(`${location.pathname}/wallet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, via, label }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? res.statusText);
  ($("nickname") as HTMLInputElement).value = "";
  $("done").textContent = `Connected "${j.wallet}". Nierwall can now send it transactions for you to approve. Connect another, or close this page.`;
  $("done").hidden = false;
}

function connectPage() {
  document.title = "Nierwall · Connect a wallet";
  $("eyebrow").textContent = "Nierwall · connect a wallet";
  $("title").textContent = "Connect a wallet";
  $("health").textContent = "A connected wallet is one Nierwall can send transactions to for your approval: fixes for a Rhea loan, swaps and moves with NEAR Intents. To only watch a wallet, add its address in the Nierwall panel instead.";
  $("checks-card").hidden = true;
  $("footer").textContent = "Nierwall only gets the address, never your keys, and every transaction still needs your OK in the wallet. Remove a wallet any time in the Nierwall panel.";
  $("steps").innerHTML = `
    <li class="step"><div class="n">1</div><div class="body"><div class="t">Name it <span class="state">optional</span></div>
      <input id="nickname" maxlength="40" placeholder="e.g. Savings or Cash"></div></li>
    <li class="step"><div class="n">2</div><div class="body"><div class="t">Connect</div>
      <button id="near">NEAR wallet</button> <button id="evm">MetaMask (EVM)</button>
      <div class="d" style="margin-top:8px">NEAR wallet opens the list: Meteor, HOT, Intear, MyNearWallet and more.</div></div></li>`;
  const run = (b: HTMLButtonElement, f: () => Promise<void>) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      $("error").textContent = "";
      $("done").hidden = true;
      try {
        await f();
      } catch (e: any) {
        $("error").textContent = e?.message ?? String(e);
      } finally {
        b.disabled = false;
      }
    });
  run($("near") as HTMLButtonElement, async () => {
    const wallet = await near().connect();
    const account = (await wallet.getAccounts())[0]?.accountId;
    if (!account) throw new Error("The wallet didn't share an account.");
    await addWallet(account, wallet.manifest.id);
  });
  run($("evm") as HTMLButtonElement, async () => {
    const found = pickEvmProvider("metamask");
    if (!found) throw new Error("No browser wallet found. Install MetaMask in this browser.");
    const [account] = (await found.provider.request({ method: "eth_requestAccounts" })) as string[];
    if (!account) throw new Error("MetaMask didn't share an account.");
    await addWallet(account, found.rdns.startsWith("io.metamask") || !found.rdns ? "metamask" : found.rdns);
  });
}

if (location.pathname.startsWith("/connect/")) {
  connectPage();
} else {
  void refresh();
  setInterval(refresh, 4000);
}
