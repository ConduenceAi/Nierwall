import { decodeFunctionData, formatUnits, getAddress, isAddress, maxUint256, parseAbi } from "viem";
import type { Brain } from "../brain.js";
import { ADDRESSES } from "../config.js";
import { findToken, tokenList } from "../tokens.js";
import { poolAbi, readAave, simulateAave, type AaveAccountDetail, type AaveAction } from "../protocols/aave.js";
import { evmChain } from "../chains.js";
import { KNOWN_SPENDERS, txEffects } from "./effects.js";
import { analyzeNear } from "./near.js";

export interface SnapFinding {
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
}
export interface SnapAnalysis {
  status: "pass" | "warn" | "critical" | "unknown";
  summary: string;
  findings: SnapFinding[];
  healthBefore?: number | null;
  healthAfter?: number | null;
  simulated?: boolean;
  /** What the simulated transaction sends and brings back, e.g. "You send: 1,000 USDC ($1,000)". */
  changes?: Array<{ label: string; value: string }>;
}
export interface SnapTxInput {
  chainId: string;
  transaction: { from?: string; to?: string; data?: string; value?: string };
  origin?: string;
}
export interface PendingDeposit {
  depositAddress: string;
  fromAddress: string;
  amountRaw: string;
  /** EVM deposits: the network and the token contract sent (null for the network's own coin). */
  chainId?: number;
  token?: string | null;
}

const erc20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)", "function transfer(address to, uint256 amount) returns (bool)"]);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function chainNumber(chainId: string): number | null {
  const m = /^(?:eip155:)?(0x[0-9a-f]+|\d+)$/i.exec(chainId.trim());
  if (!m) return null;
  return m[1]!.startsWith("0x") ? parseInt(m[1]!, 16) : Number(m[1]);
}

export function verdict(findings: SnapFinding[], fallback: string): SnapAnalysis {
  const status = findings.some((f) => f.severity === "critical") ? "critical" : findings.some((f) => f.severity === "warning") ? "warn" : findings.length ? "pass" : "unknown";
  const top = findings.find((f) => f.severity === "critical") ?? findings.find((f) => f.severity === "warning") ?? findings[0];
  return { status, summary: top?.title ?? fallback, findings };
}

/**
 * Pre-sign analysis for the MetaMask Snap, on every network MetaMask sends to. Deterministic: decodes the call,
 * simulates it where the network's node allows, checks the effect on positions and rules, and never claims
 * "safe" for something it can't check.
 */
export async function analyzeTx(brain: Brain, input: SnapTxInput, pending: PendingDeposit[] = []): Promise<SnapAnalysis> {
  const chain = chainNumber(input.chainId);
  const tx = input.transaction;
  const findings: SnapFinding[] = [];
  if (chain === 397) return analyzeNear(brain, input, pending);
  const evm = chain != null ? evmChain(chain) : undefined;
  const onBase = chain === 8453;
  const from = tx.from && isAddress(tx.from) ? getAddress(tx.from) : null;
  const to = tx.to && isAddress(tx.to) ? getAddress(tx.to) : null;
  const data = (tx.data ?? "0x") as `0x${string}`;
  const ownWallets = brain.wallets.wallets.filter((w) => w.chain === "evm");
  const own = (addr: string) => ownWallets.find((w) => w.address.toLowerCase() === addr.toLowerCase());
  const fromLabel = from ? own(from)?.label ?? null : null;

  // ---- Aave V3 pool calls on Base: simulate the health impact ----
  if (onBase && to && to.toLowerCase() === ADDRESSES.base.aavePool.toLowerCase() && from) {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: poolAbi, data });
    } catch {
      return verdict([{ severity: "warning", title: "Unrecognized Aave call", detail: "Nierwall couldn't decode this Aave transaction." }], "Unrecognized Aave call");
    }
    const label = fromLabel ?? "This account";
    const detail: AaveAccountDetail = brain.last?.aave.get(label) ?? (await readAave(label, from, null));
    const args = decoded.args as readonly unknown[];
    const asset = String(args[0]);
    const reserve = detail.reserves.find((r) => r.asset.toLowerCase() === asset.toLowerCase());
    const decimals = reserve?.decimals ?? 18;
    let action: AaveAction | null = null;
    let amount = 0;
    const raw = typeof args[1] === "bigint" ? (args[1] as bigint) : 0n;
    const isMax = raw >= maxUint256 / 2n;
    const supplied = detail.position.collateral.find((c) => c.token.toLowerCase() === asset.toLowerCase())?.amount ?? 0;
    const owed = detail.position.debt.find((d) => d.token.toLowerCase() === asset.toLowerCase())?.amount ?? 0;
    switch (decoded.functionName) {
      case "supply": action = "supply"; amount = Number(formatUnits(raw, decimals)); break;
      case "withdraw": action = "withdraw"; amount = isMax ? supplied : Number(formatUnits(raw, decimals)); break;
      case "borrow": action = "borrow"; amount = Number(formatUnits(raw, decimals)); break;
      case "repay": case "repayWithATokens": action = "repay"; amount = isMax ? owed : Number(formatUnits(raw, decimals)); break;
      case "setUserUseReserveAsCollateral": if (args[1] === false) { action = "withdraw"; amount = supplied; } break;
    }
    if (!action) return verdict([{ severity: "info", title: `Aave ${decoded.functionName}`, detail: "No health impact to simulate." }], "Aave call");
    const sim = simulateAave(detail, action, asset, amount);
    if (!sim.supported) return verdict([{ severity: "warning", title: "Unknown Aave asset", detail: sim.reason }], "Unknown Aave asset");
    const floorWatch = brain.store.listWatches("active").find((w) => w.kind === "health_below" && (w.params as any).positionId === `aave:${label}`);
    const floor = floorWatch ? Number((floorWatch.params as any).threshold) : null;
    const after = sim.healthAfter;
    const before = sim.healthBefore;
    const verb = { supply: "Supplying", withdraw: "Withdrawing", borrow: "Borrowing", repay: "Repaying" }[action];
    const what = `${verb} ${amount.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${sim.symbol}`;
    const move = `health ${before?.toFixed(2) ?? "∞"} → ${after?.toFixed(2) ?? "∞"}`;
    if (after == null) findings.push({ severity: "info", title: `${what}: no debt left`, detail: "No liquidation risk after this transaction." });
    else if (after < 1.0) findings.push({ severity: "critical", title: "This makes your Aave position liquidatable", detail: `${what}: ${move}. Liquidation starts below 1.00.` });
    else if (after < 1.1) findings.push({ severity: "critical", title: "Health would be dangerously low", detail: `${what}: ${move}. A small price move could liquidate you.` });
    else if (floor != null && after < floor) findings.push({ severity: "warning", title: `Below your ${floor.toFixed(2)} floor`, detail: `${what}: ${move}.` });
    else findings.push({ severity: "info", title: `${what}`, detail: `${move}${after >= (before ?? 0) ? ", safer than now" : ""}. Estimate from on-chain weights; ignores eMode.` });
    return { ...verdict(findings, what), healthBefore: before, healthAfter: after };
  }

  // ---- ERC-20 approve / transfer ----
  let what = "Contract call";
  if (to && data.length >= 10) {
    let decoded: ReturnType<typeof decodeFunctionData<typeof erc20>> | null = null;
    try {
      decoded = decodeFunctionData({ abi: erc20, data });
    } catch {
      decoded = null;
    }
    if (decoded?.functionName === "approve") {
      const [spender, amount] = decoded.args as [string, bigint];
      const known = KNOWN_SPENDERS[spender.toLowerCase()];
      const unlimited = amount >= maxUint256 / 2n;
      if (unlimited && !known) findings.push({ severity: "warning", title: "Unlimited approval to an unfamiliar contract", detail: `${short(spender)} could move all of this token from your wallet, now or later. Prefer an exact amount.` });
      else if (unlimited) findings.push({ severity: "info", title: `Unlimited approval to ${known}`, detail: "Common for this protocol. You can revoke it later." });
      else findings.push({ severity: "info", title: `Approval to ${known ?? short(spender)}`, detail: "Limited amount." });
      return verdict(findings, "Token approval");
    }
    if (decoded?.functionName === "transfer") {
      const [recipient, amountRaw] = decoded.args as [string, bigint];
      const usdc = evm?.intents ? findToken(await tokenList().catch(() => []), evm.intents, "USDC") : undefined;
      const isUsdc = !!usdc?.contract && to.toLowerCase() === usdc.contract;
      const amount = isUsdc ? Number(formatUnits(amountRaw, usdc!.decimals)) : null;
      const match = pending.find((p) => p.depositAddress.toLowerCase() === recipient.toLowerCase());
      // A deposit you reviewed from this wallet, of this token on this network.
      const mine = pending.find((p) => from && p.fromAddress.toLowerCase() === from.toLowerCase() && p.chainId === chain && p.token?.toLowerCase() === to.toLowerCase());
      if (match) {
        findings.push(match.amountRaw === amountRaw.toString()
          ? { severity: "info", title: "Matches your Nierwall fix", detail: "Recipient and amount match the NEAR Intents quote you reviewed." }
          : { severity: "warning", title: "Amount differs from your Nierwall quote", detail: "The deposit address matches, but the amount doesn't. Funds below the minimum get refunded after the deadline." });
      } else if (mine && mine.amountRaw === amountRaw.toString()) {
        findings.push({ severity: "critical", title: "Recipient doesn't match your Nierwall quote", detail: `You reviewed a deposit to ${short(mine.depositAddress)}, but this sends to ${short(recipient)}. Stop and check where this came from.` });
      } else if (own(recipient)) {
        findings.push({ severity: "info", title: `To your own wallet "${own(recipient)!.label}"`, detail: "Moving funds between your wallets." });
      } else {
        findings.push({ severity: "warning", title: "Recipient isn't one of your wallets", detail: `Sending to ${short(recipient)}. Make sure you trust it.` });
      }
      // Reserve rule (balance_min watch) for the sending wallet: USDC across all its networks.
      if (isUsdc && amount != null && fromLabel) {
        const rule = brain.store.listWatches("active").find((w) => w.kind === "balance_min" && (w.params as any).walletLabel === fromLabel && (w.params as any).symbol === "USDC");
        const held = brain.latestSnapshot()?.balances.filter((b) => b.walletLabel === fromLabel && b.symbol === "USDC");
        const bal = held?.length ? held.reduce((sum, b) => sum + b.amount, 0) : undefined;
        if (rule && bal != null && bal - amount < Number((rule.params as any).amount)) {
          findings.push({ severity: "warning", title: `${fromLabel} would drop below your USDC reserve`, detail: `${bal.toFixed(2)} → ${(bal - amount).toFixed(2)} USDC (minimum ${(rule.params as any).amount}).` });
        }
      }
      what = "Token transfer";
    }
  }

  // ---- Native ETH transfer ----
  const plainSend = (data === "0x" || data.length <= 2) && !!tx.value && BigInt(tx.value) > 0n;
  if (to && plainSend) {
    findings.push(own(to) ? { severity: "info", title: `To your own wallet "${own(to)!.label}"`, detail: "Moving ETH between your wallets." } : { severity: "warning", title: "Recipient isn't one of your wallets", detail: `Sending ETH to ${short(to)}.` });
    what = "ETH transfer";
  }

  // ---- Any call: simulate the exact transaction and check what it does to the user's money ----
  const network = { label: "Network", value: evm?.name ?? `Chain ${chain ?? "unknown"}` };
  let changes: NonNullable<SnapAnalysis["changes"]> = [network];
  let simulated = false;
  if (from && evm?.simulate) {
    const effects = await txEffects(brain, evm, { from, to, data, value: tx.value }, what === "Contract call").catch(() => null);
    if (effects) {
      simulated = true;
      findings.push(...effects.findings);
      changes = [network, ...effects.rows];
    }
  }
  if (!findings.length && !simulated) {
    const why = !evm ? "Nierwall doesn't know this network yet" : !evm.simulate ? `${evm.name}'s node can't simulate transactions` : "the simulation didn't answer";
    return { status: "unknown", summary: "Nierwall couldn't check this transaction", findings: [{ severity: "info", title: "No analysis available", detail: `It isn't a plain transfer or approval, and ${why}. This is not a safety verdict.` }], changes };
  }
  if (!simulated && evm && !evm.simulate) findings.push({ severity: "info", title: `Decoded only`, detail: `${evm.name}'s node can't simulate transactions, so Nierwall checked the call itself, not its full effect.` });
  if (simulated && findings.every((f) => f.severity === "info")) {
    findings.push({ severity: "info", title: "Simulated: nothing unusual", detail: "Checked against your positions, limits and portfolio mix." });
  }
  return { ...verdict(findings, what), changes };
}
