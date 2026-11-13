import { formatUnits, maxUint256 } from "viem";
import { allocationOf, assetClass, type AssetClass } from "../advisor/plans.js";
import type { Brain } from "../brain.js";
import type { EvmChain } from "../chains.js";
import { ADDRESSES } from "../config.js";
import type { Holding } from "../holdings.js";
import type { Allocation, Watch } from "../types.js";
import { CLASS_NAMES } from "../watches/engine.js";
import type { SnapFinding } from "./analyze.js";
import { NATIVE, resolveTokens, type TokenMeta } from "./pricing.js";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const APPROVAL_FOR_ALL = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";

/** Spenders users commonly approve. Unknown is not "bad", just worth a look. */
export const KNOWN_SPENDERS: Record<string, string> = {
  "0x000000000022d473030f116ddee9f6b43ac78ba3": "Permit2 (Uniswap)", // same address on every chain
  [ADDRESSES.base.aavePool.toLowerCase()]: "Aave V3 Pool",
  "0x6ff5693b99212da76ad316178a184ab56d299b43": "Uniswap Universal Router",
};

export interface RawTransfer {
  token: string;
  from: string;
  to: string;
  amount: bigint;
}

/** A permission the transaction grants: an ERC-20 allowance, or "all" for approve-all (NFTs and similar). */
export interface RawApproval {
  token: string;
  owner: string;
  spender: string;
  amount: bigint | "all";
}

/** Runs the exact transaction on the network's latest block without sending it, and returns its transfers and approvals. */
export async function simulateTransfers(rpc: string, tx: { from: string; to: string | null; data: string; value?: string }): Promise<{ ok: true; reverted: boolean; transfers: RawTransfer[]; approvals: RawApproval[] } | { ok: false; reason: string }> {
  const value = tx.value && BigInt(tx.value) > 0n ? `0x${BigInt(tx.value).toString(16)}` : undefined;
  const call = { from: tx.from, ...(tx.to ? { to: tx.to } : {}), data: tx.data, ...(value ? { value } : {}) };
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(6000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_simulateV1", params: [{ blockStateCalls: [{ calls: [call] }], traceTransfers: true, validation: false }, "latest"] }),
  });
  const j = (await res.json()) as { result?: Array<{ calls?: Array<{ status: string; logs?: Array<{ address: string; topics: string[]; data: string }> }> }>; error?: { message?: string } };
  const c = j.result?.[0]?.calls?.[0];
  if (j.error || !c) return { ok: false, reason: j.error?.message ?? "no simulation result" };
  const addr = (topic: string) => `0x${topic.slice(26)}`.toLowerCase();
  const num = (data: string) => BigInt(data === "0x" ? 0 : data);
  const logs = c.logs ?? [];
  const transfers = logs
    .filter((l) => l.topics[0] === TRANSFER && l.topics.length === 3) // ERC-20 and native; NFTs carry a 4th topic
    .map((l) => ({ token: l.address.toLowerCase(), from: addr(l.topics[1]!), to: addr(l.topics[2]!), amount: num(l.data) }));
  const approvals: RawApproval[] = logs.flatMap((l): RawApproval[] => {
    if (l.topics[0] === APPROVAL && l.topics.length === 3) return [{ token: l.address.toLowerCase(), owner: addr(l.topics[1]!), spender: addr(l.topics[2]!), amount: num(l.data) }];
    if (l.topics[0] === APPROVAL_FOR_ALL && l.topics.length === 3 && num(l.data) === 1n) return [{ token: l.address.toLowerCase(), owner: addr(l.topics[1]!), spender: addr(l.topics[2]!), amount: "all" }];
    return [];
  });
  return { ok: true, reverted: c.status !== "0x1", transfers, approvals };
}

export interface Change {
  symbol: string;
  /** Signed: negative leaves the user's wallets, positive arrives. */
  amount: number;
  usd: number | null;
  cls: AssetClass;
  /** "at least": the amount is a guaranteed minimum (e.g. a swap's minimum output). */
  atLeast?: boolean;
}

/** What leaves and arrives across the user's wallets. Moves between their own wallets cancel out. */
export function netChanges(transfers: RawTransfer[], own: Set<string>, meta: Map<string, TokenMeta>): Change[] {
  const sums = new Map<string, bigint>();
  for (const t of transfers) {
    const out = own.has(t.from);
    const into = own.has(t.to);
    if (out === into) continue;
    sums.set(t.token, (sums.get(t.token) ?? 0n) + (into ? t.amount : -t.amount));
  }
  const out: Change[] = [];
  for (const [token, raw] of sums) {
    if (raw === 0n) continue;
    const m = meta.get(token);
    const amount = Number(formatUnits(raw, m?.decimals ?? 18));
    const symbol = m?.symbol ?? `token ${token.slice(0, 6)}…${token.slice(-4)}`;
    out.push({ symbol, amount, usd: m?.priceUsd != null ? amount * m.priceUsd : null, cls: m ? assetClass(symbol) : "other" });
  }
  return out;
}

const fmtAmount = (x: number) => Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: Math.abs(x) >= 1000 ? 0 : Math.abs(x) >= 1 ? 2 : 6 });
const fmtUsd = (x: number) => `$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: Math.abs(x) >= 100 ? 0 : 2 })}`;
const describe = (c: Change) => `${c.atLeast ? "at least " : ""}${fmtAmount(c.amount)} ${c.symbol}${c.usd != null ? ` (${fmtUsd(c.usd)})` : ""}`;

/**
 * Turns a transaction's net changes into pre-sign findings: what you send and get, whether the rate is bad,
 * and whether it breaks the portfolio mix the user decided on (with what else they could use instead).
 */
export function effectFindings(changes: Change[], before: Allocation, watches: Watch[], holdings: Holding[], contractCall: boolean): { findings: SnapFinding[]; rows: Array<{ label: string; value: string }> } {
  const findings: SnapFinding[] = [];
  const sent = changes.filter((c) => c.amount < 0);
  const got = changes.filter((c) => c.amount > 0);
  const rows = [
    ...(sent.length ? [{ label: "You send", value: sent.map(describe).join(", ") }] : []),
    ...(got.length ? [{ label: "You get", value: got.map(describe).join(", ") }] : []),
  ];

  // Value check: only when every token involved has a price.
  const outUsd = -sent.reduce((s, c) => s + (c.usd ?? NaN), 0);
  const inUsd = got.reduce((s, c) => s + (c.usd ?? NaN), 0);
  if (sent.length && got.length && Number.isFinite(outUsd) && Number.isFinite(inUsd) && outUsd >= 10) {
    const loss = 1 - inUsd / outUsd;
    if (loss > 0.15) findings.push({ severity: "critical", title: `You'd get ${(loss * 100).toFixed(0)}% less value back`, detail: `You give about ${fmtUsd(outUsd)} and get ${got.some((c) => c.atLeast) ? "at least " : "about "}${fmtUsd(inUsd)}. Check the rate and the site before signing.` });
    else if (loss > 0.03) findings.push({ severity: "warning", title: `You'd lose about ${(loss * 100).toFixed(1)}% on this trade`, detail: `You give about ${fmtUsd(outUsd)} and get ${got.some((c) => c.atLeast) ? "at least " : "about "}${fmtUsd(inUsd)}: fees, slippage or a poor route.` });
  } else if (contractCall && sent.length && !got.length && Number.isFinite(outUsd) && outUsd >= 10) {
    findings.push({ severity: "warning", title: "Nothing comes back to your wallets", detail: `About ${fmtUsd(outUsd)} leaves and no token arrives. Fine for a payment or deposit you expect; a red flag for a swap.` });
  }

  // Portfolio mix the user decided on.
  if (before.netWorthUsd > 0 && changes.every((c) => c.usd != null || c.amount > 0)) {
    const byClass = new Map(before.classes.map((c) => [c.cls, c.usd] as [AssetClass, number]));
    for (const c of changes) if (c.usd != null) byClass.set(c.cls, (byClass.get(c.cls) ?? 0) + c.usd);
    const totalAfter = [...byClass.values()].reduce((s, v) => s + v, 0);
    const shareBefore = (cls: AssetClass) => before.classes.find((c) => c.cls === cls)?.pct ?? 0;
    const shareAfter = (cls: AssetClass) => (totalAfter > 0 ? ((byClass.get(cls) ?? 0) / totalAfter) * 100 : 0);
    const bought = [...got].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))[0]?.cls;
    const minimums = new Set(watches.filter((w) => w.kind === "allocation_min" && w.status === "active").map((w) => String((w.params as Record<string, unknown>).cls)));

    for (const w of watches) {
      if ((w.kind !== "allocation_min" && w.kind !== "allocation_max") || w.status !== "active") continue;
      const p = w.params as Record<string, unknown>;
      const cls = String(p.cls) as AssetClass;
      const target = Number(p.pct);
      const b = shareBefore(cls);
      const a = shareAfter(cls);
      const min = w.kind === "allocation_min";
      if (!(min ? a < target && a < b - 0.05 : a > target && a > b + 0.05)) continue;
      const name = CLASS_NAMES[cls] ?? cls;
      let detail = `${name} would go from ${b.toFixed(1)}% to ${a.toFixed(1)}% of your portfolio. You set ${min ? "a minimum" : "a maximum"} of ${target}%.`;
      if (min && bought && bought !== cls) {
        // Other things the user holds that could pay for the same purchase without touching this class.
        const alternatives = holdings
          .filter((h) => h.usd != null && h.usd >= 20 && ![cls, bought].includes(assetClass(h.symbol)) && !minimums.has(assetClass(h.symbol)))
          .sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0))
          .slice(0, 2)
          .map((h) => `${h.symbol} (about ${fmtUsd(h.usd!)} in ${h.walletLabel})`);
        if (alternatives.length) detail += ` If you want ${CLASS_NAMES[bought] ?? bought}, you could swap ${alternatives.join(" or ")} instead and keep ${name.toLowerCase()} at ${b.toFixed(0)}%.`;
      }
      findings.push({ severity: "warning", title: `${name} would ${min ? "fall below" : "rise above"} your ${target}% ${min ? "minimum" : "maximum"}`, detail });
    }
  }
  return { findings, rows };
}

/** The user's portfolio mix right now (Base and NEAR holdings plus loans), for checking a transaction against their targets. */
export async function currentMix(brain: Brain): Promise<{ before: Allocation; holdings: Holding[] }> {
  const { holdings } = await brain.portfolio.holdings(brain.scenario.get()).catch(() => ({ holdings: [] as Holding[] }));
  return { before: allocationOf(holdings, brain.latestSnapshot()?.positions ?? []), holdings };
}

/** Simulates an EVM transaction and checks its effects. Null when the network's node can't simulate it. */
export async function txEffects(brain: Brain, chain: EvmChain, tx: { from: string; to: string | null; data: string; value?: string }, contractCall: boolean): Promise<{ findings: SnapFinding[]; rows: Array<{ label: string; value: string }> } | null> {
  const sim = await simulateTransfers(chain.rpc, tx).catch(() => null);
  if (!sim || !sim.ok) return null;
  if (sim.reverted) return { findings: [{ severity: "warning", title: "This transaction would fail", detail: `Simulated on ${chain.name}'s latest block, it reverts. You'd pay the network fee for nothing.` }], rows: [] };

  // EVM addresses are the same on every EVM chain, so any of the user's EVM wallets counts as theirs here.
  const own = new Set(brain.wallets.wallets.filter((w) => w.chain === "base").map((w) => w.address.toLowerCase()));
  own.add(tx.from.toLowerCase());
  const tokens = [...new Set([...sim.transfers.map((t) => t.token), ...sim.approvals.map((a) => a.token)])];
  const meta = await resolveTokens(chain, tokens).catch(() => new Map<string, TokenMeta>());

  // Permissions hidden inside the call: an unlimited or approve-all grant to an unfamiliar contract is how drainers work.
  const hidden: SnapFinding[] = contractCall
    ? sim.approvals
        .filter((a) => own.has(a.owner) && !KNOWN_SPENDERS[a.spender] && (a.amount === "all" || a.amount >= maxUint256 / 2n))
        .map((a) => {
          const name = meta.get(a.token)?.symbol ?? `${a.token.slice(0, 6)}…${a.token.slice(-4)}`;
          return { severity: "warning" as const, title: a.amount === "all" ? "This gives a contract control of a whole collection" : `This also gives unlimited access to your ${name}`, detail: `${a.spender.slice(0, 6)}…${a.spender.slice(-4)} could move ${a.amount === "all" ? "every item" : `all your ${name}`} later, not just now. Only sign if you trust this app.` };
        })
    : [];
  const changes = netChanges(sim.transfers, own, meta);
  if (!changes.length) return { findings: [...hidden, ...(contractCall && !hidden.length ? [{ severity: "info" as const, title: "No tokens leave or enter your wallets", detail: `Simulated on ${chain.name}'s latest block.` }] : [])], rows: [] };

  const { before, holdings } = await currentMix(brain);
  const effects = effectFindings(changes, before, brain.store.listWatches("active"), holdings, contractCall);
  return { findings: [...hidden, ...effects.findings], rows: effects.rows };
}

export { NATIVE };
