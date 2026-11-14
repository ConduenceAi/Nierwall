import { decodeFunctionData, formatUnits, hexToBytes, keccak256, parseAbi, toBytes, type Hex } from "viem";
import { assetClass } from "../advisor/plans.js";
import type { Brain } from "../brain.js";
import { ADDRESSES } from "../config.js";
import { readRheaMain, rheaAssets, rheaPositionId, tokenInfo } from "../protocols/rhea.js";
import { tokenList, type TokenInfo } from "../tokens.js";
import { verdict, type PendingDeposit, type SnapAnalysis, type SnapFinding, type SnapTxInput } from "./analyze.js";
import { currentMix, effectFindings, type Change } from "./effects.js";

/*
 * NEAR transactions sent from MetaMask (NEP-518, chain 397). The wallet contract reads a NEAR action from the
 * Ethereum transaction's data. The `value` field carries NEAR in units of 10^-18; the uint32 argument adds the
 * remaining yoctoNEAR. `to` is the target account itself (0x… accounts) or the last 20 bytes of keccak256(account).
 */
const nearAbi = parseAbi([
  "function functionCall(string receiverId, string methodName, bytes args, uint64 gas, uint32 yoctoNear)",
  "function transfer(string receiverId, uint32 yoctoNear)",
  "function addKey(uint8 publicKeyKind, bytes publicKey, uint64 nonce, bool isFullAccess, bool isLimitedAllowance, uint128 allowance, string receiverId, string[] methodNames)",
  "function deleteKey(uint8 publicKeyKind, bytes publicKey)",
]);
const REF_DEX = "v2.ref-finance.near";
const RHEA_ORACLE = "priceoracle.near";
/** Contracts where sending tokens is expected: Rhea lending and DEX, NEAR Intents, wNEAR. */
const KNOWN_RECEIVERS: Record<string, string> = { [ADDRESSES.near.rhea]: "Rhea lending", [REF_DEX]: "Rhea DEX", "intents.near": "NEAR Intents", "wrap.near": "wNEAR" };

const short = (a: string) => (a.length > 24 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);
const fmt = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: x >= 1000 ? 0 : x >= 1 ? 2 : 6 });

type RheaAction = Record<string, { token_id?: string; amount?: string; max_amount?: string }>;

export async function analyzeNear(brain: Brain, input: SnapTxInput, pending: PendingDeposit[]): Promise<SnapAnalysis> {
  const tx = input.transaction;
  const network = { label: "Network", value: "NEAR (via MetaMask)" };
  let decoded: ReturnType<typeof decodeFunctionData<typeof nearAbi>>;
  try {
    decoded = decodeFunctionData({ abi: nearAbi, data: (tx.data ?? "0x") as Hex });
  } catch {
    return { status: "unknown", summary: "Unrecognized NEAR action", findings: [{ severity: "warning", title: "Nierwall couldn't read this NEAR action", detail: "It isn't a standard NEAR transfer, call or key change. This is not a safety verdict." }], changes: [network] };
  }

  const sender = (tx.from ?? "").toLowerCase(); // a MetaMask account on NEAR is the 0x… account itself
  const nearWallets = brain.wallets.wallets.filter((w) => w.chain === "near");
  const ownLabel = (account: string) => nearWallets.find((w) => w.address.toLowerCase() === account.toLowerCase())?.label ?? (account.toLowerCase() === sender ? "this account" : null);
  const tokens = await tokenList().catch(() => [] as TokenInfo[]);
  const nearToken = (contract: string | null) => tokens.find((t) => t.chain === "near" && t.contract === contract);
  const nearPrice = nearToken(null)?.priceUsd ?? null;
  const findings: SnapFinding[] = [];
  const changes: Change[] = [];
  let contractCall = true;
  let what = "NEAR action";
  let health: { before: number | null; after: number | null } | null = null;

  // The transaction must be addressed to the account its NEAR action targets; anything else is forged.
  if (decoded.functionName === "transfer" || decoded.functionName === "functionCall") {
    const receiver = String(decoded.args[0]);
    const to = (tx.to ?? "").toLowerCase();
    if (to !== receiver.toLowerCase() && to !== `0x${keccak256(toBytes(receiver)).slice(26)}`) {
      findings.push({ severity: "critical", title: "The target doesn't match the NEAR action", detail: `The transaction is addressed to ${short(to)} but acts on ${receiver}. Don't sign it.` });
    }
  }
  const deposit = (extra: number | bigint) => BigInt(tx.value ?? 0) * 1_000_000n + BigInt(extra);

  /** A token leaving the account: to one of the user's wallets, a Nierwall deposit, a known contract, or a stranger. */
  const send = (symbol: string, amount: number, priceUsd: number | null, to: string, raw: string) => {
    const mine = ownLabel(to);
    const planned = pending.find((p) => p.depositAddress.toLowerCase() === to.toLowerCase());
    if (mine) findings.push({ severity: "info", title: `To your own wallet "${mine}"`, detail: "Moving funds between your wallets." });
    else if (planned) findings.push(planned.amountRaw === raw ? { severity: "info", title: "Matches your Nierwall plan", detail: "Recipient and amount match the NEAR Intents quote you reviewed." } : { severity: "warning", title: "Amount differs from your Nierwall quote", detail: "The deposit address matches, but the amount doesn't." });
    else if (KNOWN_RECEIVERS[to]) findings.push({ severity: "info", title: `To ${KNOWN_RECEIVERS[to]}`, detail: `Sending ${fmt(amount)} ${symbol}.` });
    else findings.push({ severity: "warning", title: "Recipient isn't one of your wallets", detail: `Sending ${fmt(amount)} ${symbol} to ${short(to)}. Make sure you trust it.` });
    if (!mine) changes.push({ symbol, amount: -amount, usd: priceUsd == null ? null : -amount * priceUsd, cls: assetClass(symbol) });
  };

  if (decoded.functionName === "addKey") {
    const [, , , isFullAccess, , , receiverId, methodNames] = decoded.args;
    what = "Key change";
    findings.push(isFullAccess
      ? { severity: "critical", title: "This gives a new key full control of your NEAR account", detail: "Whoever holds this key can move everything in the account, now or later. Only sign if you created the key yourself." }
      : { severity: "info", title: `Adds a limited key for ${receiverId}`, detail: `It can only call ${methodNames.length ? methodNames.join(", ") : "methods"} on ${receiverId} and can't move your tokens.` });
  } else if (decoded.functionName === "deleteKey") {
    what = "Key change";
    findings.push({ severity: "warning", title: "Removes a key from your NEAR account", detail: "If it's your only way in, you could lose access to the account." });
  } else if (decoded.functionName === "transfer") {
    const [receiver, extra] = decoded.args;
    what = "NEAR transfer";
    contractCall = false;
    const yocto = deposit(extra);
    send("NEAR", Number(formatUnits(yocto, 24)), nearPrice, receiver.toLowerCase(), yocto.toString());
  } else {
    const [receiver, method, argsHex, , extra] = decoded.args;
    const attached = deposit(extra);
    let a: Record<string, any> = {};
    try {
      a = JSON.parse(new TextDecoder().decode(hexToBytes(argsHex)));
    } catch {
      /* not JSON */
    }
    const token = nearToken(receiver);
    const amountOf = (raw: string | undefined, t: TokenInfo | undefined) => (raw && t ? Number(formatUnits(BigInt(raw), t.decimals)) : null);

    if (method === "ft_transfer" && token) {
      what = "Token transfer";
      contractCall = false;
      send(token.symbol, amountOf(a.amount, token) ?? 0, token.priceUsd, String(a.receiver_id ?? ""), String(a.amount ?? ""));
    } else if (method === "ft_transfer_call" && token && a.receiver_id === REF_DEX) {
      // A Rhea DEX swap: the token goes in, the last hop's minimum output comes back.
      what = "Swap on Rhea";
      const hops = (safeJson(a.msg)?.actions ?? []) as Array<{ token_out?: string; min_amount_out?: string }>;
      const last = hops.at(-1);
      const outToken = nearToken(last?.token_out ?? null);
      const amountIn = amountOf(a.amount, token) ?? 0;
      changes.push({ symbol: token.symbol, amount: -amountIn, usd: token.priceUsd == null ? null : -amountIn * token.priceUsd, cls: assetClass(token.symbol) });
      const minOut = amountOf(last?.min_amount_out, outToken);
      if (outToken && minOut != null) changes.push({ symbol: outToken.symbol, amount: minOut, usd: outToken.priceUsd == null ? null : minOut * outToken.priceUsd, cls: assetClass(outToken.symbol), atLeast: true });
      else findings.push({ severity: "warning", title: "Couldn't read what this swap returns", detail: "Nierwall couldn't find the output token or its minimum. Check the amounts in the app." });
    } else if ((method === "ft_transfer_call" && token && a.receiver_id === ADDRESSES.near.rhea) || (receiver === RHEA_ORACLE && method === "oracle_call" && a.receiver_id === ADDRESSES.near.rhea) || (receiver === ADDRESSES.near.rhea && (method === "execute" || method === "execute_with_pyth"))) {
      // Rhea lending: deposits, repays and collateral changes, with the effect on loan health.
      what = "Rhea loan action";
      const actions: RheaAction[] = method === "ft_transfer_call" || method === "oracle_call" ? (safeJson(a.msg)?.Execute?.actions ?? []) : (a.actions ?? []);
      const sent = method === "ft_transfer_call" ? { tokenId: receiver, amount: amountOf(a.amount, token) ?? 0 } : null;
      health = await rheaHealth(brain, ownLabel(sender) ?? "This account", sender, actions, sent);
      const verbs = actions.map((x) => Object.keys(x)[0]).filter(Boolean);
      const label = sent && !verbs.length ? `Deposit ${fmt(sent.amount)} ${token!.symbol} to Rhea` : `Rhea: ${verbs.join(", ") || method}`;
      const floorWatch = brain.store.listWatches("active").find((w) => w.kind === "health_below" && (w.params as Record<string, unknown>).positionId === `rhea:${ownLabel(sender)}`);
      const floor = floorWatch ? Number((floorWatch.params as Record<string, unknown>).threshold) : null;
      const move = `health ${health.before?.toFixed(2) ?? "∞"} → ${health.after?.toFixed(2) ?? "∞"}`;
      if (health.after == null) findings.push({ severity: "info", title: label, detail: "No debt after this, so no liquidation risk." });
      else if (health.after < 1) findings.push({ severity: "critical", title: "This makes your Rhea loan liquidatable", detail: `${label}: ${move}. Liquidation starts below 1.00.` });
      else if (health.after < 1.1) findings.push({ severity: "critical", title: "Rhea health would be dangerously low", detail: `${label}: ${move}. A small price move could liquidate you.` });
      else if (floor != null && health.after < floor) findings.push({ severity: "warning", title: `Below your ${floor.toFixed(2)} floor`, detail: `${label}: ${move}.` });
      else findings.push({ severity: "info", title: label, detail: `${move}${health.after >= (health.before ?? 0) ? ", safer than now" : ""}.` });
    } else if (method === "ft_transfer_call" && token) {
      what = "Token transfer";
      send(token.symbol, amountOf(a.amount, token) ?? 0, token.priceUsd, String(a.receiver_id ?? ""), String(a.amount ?? ""));
    } else if (receiver === "wrap.near" && (method === "near_deposit" || method === "near_withdraw")) {
      what = method === "near_deposit" ? "Wrap NEAR" : "Unwrap NEAR";
      findings.push({ severity: "info", title: method === "near_deposit" ? `Wraps ${fmt(Number(formatUnits(attached, 24)))} NEAR into wNEAR` : "Unwraps wNEAR into NEAR", detail: "Same value, different form." });
    } else if (method === "storage_deposit") {
      what = "Storage deposit";
      findings.push({ severity: "info", title: `Registers storage on ${short(receiver)}`, detail: `Pays ${fmt(Number(formatUnits(attached, 24)))} NEAR so the account can hold this token; refundable.` });
    } else {
      what = `${method} on ${short(receiver)}`;
      findings.push({ severity: "info", title: `Calls ${method} on ${short(receiver)}`, detail: "Nierwall doesn't know this contract, so it can't say what the call does. This is not a safety verdict." });
      if (attached > 10n ** 22n) {
        const n = Number(formatUnits(attached, 24));
        findings.push({ severity: "warning", title: `Attaches ${fmt(n)} NEAR`, detail: `The contract receives ${fmt(n)} NEAR with this call.` });
        changes.push({ symbol: "NEAR", amount: -n, usd: nearPrice == null ? null : -n * nearPrice, cls: "NEAR" });
      }
    }
  }

  let rows: Array<{ label: string; value: string }> = [network];
  if (changes.length) {
    const { before, holdings } = await currentMix(brain);
    const effects = effectFindings(changes, before, brain.store.listWatches("active"), holdings, contractCall);
    findings.push(...effects.findings);
    rows = [network, ...effects.rows];
  }
  return { ...verdict(findings, what), changes: rows, ...(health ? { healthBefore: health.before, healthAfter: health.after } : {}) };
}

function safeJson(s: unknown): any {
  try {
    return typeof s === "string" ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

/** Rhea health before and after a list of lending actions, with Rhea's own weights. */
async function rheaHealth(brain: Brain, label: string, account: string, actions: RheaAction[], sent: { tokenId: string; amount: number } | null) {
  // Actions without a position key act on the main position.
  const [detail, assets] = await Promise.all([brain.last?.rhea.get(rheaPositionId(label)) ?? readRheaMain(label, account, null), rheaAssets()]);
  let col = detail?.position.collateral.reduce((s, c) => s + c.usd * c.weight, 0) ?? 0;
  let debt = detail?.position.debt.reduce((s, d) => s + (d.weight > 0 ? d.usd / d.weight : d.usd), 0) ?? 0;
  const before = debt > 1e-9 ? col / debt : null;
  for (const action of actions) {
    const [kind, p] = Object.entries(action)[0] ?? [];
    if (!kind || !p?.token_id) continue;
    const t = tokenInfo(assets, p.token_id);
    const raw = p.amount ?? p.max_amount;
    // Amounts inside Rhea actions use internal decimals; a repay or collateral top-up without one uses what was sent.
    const amount = raw ? Number(formatUnits(BigInt(raw), t.decimals)) : sent?.tokenId === p.token_id ? sent.amount : 0;
    const usd = amount * t.usd;
    if (kind === "Borrow") debt += t.vr > 0 ? usd / t.vr : usd;
    else if (kind === "Repay") debt = Math.max(0, debt - (t.vr > 0 ? usd / t.vr : usd));
    else if (kind === "IncreaseCollateral") col += usd * t.vr;
    else if (kind === "DecreaseCollateral") col = Math.max(0, col - (raw ? usd : detail?.position.collateral.find((c) => c.token === p.token_id)?.usd ?? 0) * t.vr);
  }
  return { before, after: debt > 1e-9 ? col / debt : null };
}
