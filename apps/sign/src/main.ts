import { NearConnector } from "@hot-labs/near-connect";

/**
 * Nierwall signing page. Runs on 127.0.0.1, opened from the Mac app. It never sees keys: MetaMask signs the
 * Base step through EIP-6963, and the user's NEAR wallet signs the Rhea step through NEAR Connect.
 */

interface Step {
  id: string;
  kind: "evm" | "near" | "intents" | "link";
  title: string;
  detail: string;
  state: "waiting" | "ready" | "submitted" | "done" | "failed";
  chain: "base" | "near" | null;
  wallet: string | null;
  expectedSigner: string | null;
  evmTx?: { chainId: number; to: string; data: string; value: string };
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
const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ---- EIP-6963 wallet discovery (prefers MetaMask / MetaMask Flask) ----
const providers: Array<{ info: { rdns: string; name: string }; provider: Eip1193 }> = [];
window.addEventListener("eip6963:announceProvider", (e: any) => providers.push(e.detail));
window.dispatchEvent(new Event("eip6963:requestProvider"));

function pickEvmProvider(): Eip1193 | null {
  const mm = providers.find((p) => p.info.rdns.startsWith("io.metamask"));
  return (mm ?? providers[0])?.provider ?? (window as any).ethereum ?? null;
}

async function api(path: string, body?: unknown) {
  const res = await fetch(`/sign/${token}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

async function sendEvm(step: Step) {
  const provider = pickEvmProvider();
  if (!provider) throw new Error("No browser wallet found. Install MetaMask (or MetaMask Flask) in this browser.");
  const [account] = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!account || account.toLowerCase() !== step.expectedSigner!.toLowerCase()) {
    throw new Error(`Switch MetaMask to your "${step.wallet}" account (${step.expectedSigner}).`);
  }
  const chainHex = `0x${step.evmTx!.chainId.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
  } catch (e: any) {
    if (e?.code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: chainHex, chainName: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"] }],
      });
    } else throw e;
  }
  const hash = (await provider.request({
    method: "eth_sendTransaction",
    params: [{ from: account, to: step.evmTx!.to, data: step.evmTx!.data, value: step.evmTx!.value }],
  })) as string;
  await api(`/steps/${step.id}`, { txHash: hash });
}

let connector: NearConnector | null = null;
async function sendNear(step: Step) {
  connector ??= new NearConnector({ network: "mainnet" } as any);
  const wallet = await connector.connect();
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
        st.state === "ready" && st.kind === "evm" ? `<button data-step="${st.id}">Sign with MetaMask</button>` :
        st.state === "ready" && st.kind === "near" && st.nearTx ? `<button data-step="${st.id}">Sign with your NEAR wallet</button>` :
        st.state === "ready" && st.link ? `<a class="button" href="${esc(st.link)}" target="_blank" rel="noopener">Open Rhea</a> <button data-step="${st.id}" data-manual="1">I've done this</button>` : "";
      const hash = st.txHash ? `<div class="hash">tx ${esc(st.txHash.slice(0, 18))}…</div>` : "";
      return `<li class="step ${st.state}"><div class="n">${i + 1}</div><div class="body"><div class="t">${esc(st.title)} <span class="state">${st.state}</span></div><div class="d">${esc(st.detail)}</div>${hash}${action}</div></li>`;
    })
    .join("");
  $("done").hidden = !s.done;
  document.querySelectorAll<HTMLButtonElement>("button[data-step]").forEach((b) =>
    b.addEventListener("click", async () => {
      const step = s.steps.find((x) => x.id === b.dataset.step)!;
      b.disabled = true;
      $("error").textContent = "";
      try {
        if (b.dataset.manual) await api(`/steps/${step.id}`, { txHash: "manual-done" });
        else if (step.kind === "evm") await sendEvm(step);
        else await sendNear(step);
        await refresh();
      } catch (e: any) {
        $("error").textContent = e?.message ?? String(e);
        b.disabled = false;
      }
    }),
  );
}

async function refresh() {
  try {
    render((await api("/session")) as Session);
  } catch (e: any) {
    $("error").textContent = `This review link has expired or is invalid. Open the fix again from Nierwall. (${e?.message ?? e})`;
  }
}

void refresh();
setInterval(refresh, 4000);
