import { randomBytes } from "node:crypto";
import { encodeFunctionData, erc20Abi, getAddress, type Hex } from "viem";
import { assetClass, type Plan, type PlanStep } from "../advisor/plans.js";
import type { Brain } from "../brain.js";
import { evmChain, evmClient, evmNetwork, networkName } from "../chains.js";
import { ADDRESSES, type EvmNetwork, type Network, type Wallet } from "../config.js";
import { isConnected, walletAppName } from "../connections.js";
import { quote, swapStatus, type Quote } from "../intents/oneclick.js";
import { logger } from "../log.js";
import { usdcOn } from "../planner/fixes.js";
import { rheaAssets } from "../protocols/rhea.js";
import { toRaw, tokenList, type TokenInfo } from "../tokens.js";
import type { FixOption } from "../types.js";

const log = logger("sign");
const NEAR_GAS = "300000000000000";
const NEAR_GAS_PART = "50000000000000";
/** Storage registration on a NEP-141 token: refunded if the account is already registered. */
const NEAR_STORAGE = "1250000000000000000000";

export type StepState = "waiting" | "ready" | "submitted" | "done" | "failed";

type NearAction =
  | { type: "FunctionCall"; params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string } }
  | { type: "Transfer"; params: { deposit: string } };

/** An EVM transaction for MetaMask, with what it needs to add the network if it doesn't know it yet. */
export interface EvmTx {
  chainId: number;
  to: string;
  data: string;
  value: string;
  network: { name: string; symbol: string; rpcUrl: string; explorerUrl: string | null };
}

export interface SignStep {
  id: string;
  /** evm: signed in MetaMask on its network. near: signed in the NEAR wallet. intents: NEAR Intents delivering. link: done by hand. */
  kind: "evm" | "near" | "intents" | "link";
  title: string;
  detail: string;
  state: StepState;
  chain: Network | null;
  wallet: string | null;
  /** Address/account that must sign (shown to the user, checked in the page). */
  expectedSigner: string | null;
  /** The wallet app the signer was connected with ("meteor-wallet", "metamask"), and its name for people. */
  walletApp?: string;
  walletAppName?: string;
  evmTx?: EvmTx;
  nearTx?: { receiverId: string; actions: NearAction[] };
  /** NEAR Intents deposit address this step pays, or delivery this step waits for. */
  depositAddress?: string;
  /** Base units sent to the deposit address, so the Snap can match the transfer. */
  amountRaw?: string;
  /** Legacy fix flow: rebuild this Rhea repay with the amount NEAR Intents actually delivered. */
  repayDelivered?: boolean;
  txHash?: string;
  link?: string;
}

export interface SignSession {
  token: string;
  fixId: string;
  title: string;
  createdAt: string;
  expiresAt: string;
  healthBefore: number | null;
  healthAfter: number | null;
  checks: Quote["checks"];
  privacyNote: string | null;
  steps: SignStep[];
  depositAddress: string | null;
  done: boolean;
}

const fc = (methodName: string, args: Record<string, unknown>, deposit = "1", gas = NEAR_GAS_PART): NearAction => ({ type: "FunctionCall", params: { methodName, args, gas, deposit } });
const fmt = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: x >= 1000 ? 0 : x >= 1 ? 2 : 6 });

/** Rhea repay: deposit the token with ft_transfer_call and repay it in the same execution. */
async function rheaRepayTx(tokenId: string, amountRaw: bigint) {
  const assets = await rheaAssets();
  const extra = BigInt(assets[tokenId]?.config?.extra_decimals ?? 0);
  const maxAmountInternal = (amountRaw * 10n ** extra).toString();
  return {
    receiverId: tokenId,
    actions: [
      {
        type: "FunctionCall" as const,
        params: {
          methodName: "ft_transfer_call",
          args: { receiver_id: ADDRESSES.near.rhea, amount: amountRaw.toString(), msg: JSON.stringify({ Execute: { actions: [{ Repay: { token_id: tokenId, max_amount: maxAmountInternal } }] } }) },
          gas: NEAR_GAS,
          deposit: "1",
        },
      },
    ],
  };
}

/**
 * Rhea add collateral: deposit the token and mark it as collateral in one call. Native NEAR is wrapped to wNEAR first,
 * in the same transaction. No price data is needed, since more collateral only makes the loan safer.
 */
async function rheaCollateralTx(token: TokenInfo, tokenId: string, amountRaw: bigint, account: string) {
  const assets = await rheaAssets();
  const extra = BigInt(assets[tokenId]?.config?.extra_decimals ?? 0);
  const msg = JSON.stringify({ Execute: { actions: [{ IncreaseCollateral: { token_id: tokenId, max_amount: (amountRaw * 10n ** extra).toString() } }] } });
  const wrap = !token.contract;
  return {
    receiverId: tokenId,
    actions: [
      // A transaction gets 300 Tgas in all: small calls for wrapping, the rest for Rhea.
      ...(wrap ? [fc("storage_deposit", { account_id: account, registration_only: true }, NEAR_STORAGE, "10000000000000"), fc("near_deposit", {}, amountRaw.toString(), "10000000000000")] : []),
      fc("ft_transfer_call", { receiver_id: ADDRESSES.near.rhea, amount: amountRaw.toString(), msg }, "1", wrap ? "250000000000000" : NEAR_GAS),
    ],
  };
}

/** Sends a NEAR token to an account. Native NEAR is wrapped to wNEAR first when the receiver is a NEAR Intents deposit. */
function nearSendTx(token: TokenInfo, amountRaw: bigint, from: string, to: string, wrapNative: boolean) {
  if (!token.contract && !wrapNative) return { receiverId: to, actions: [{ type: "Transfer" as const, params: { deposit: amountRaw.toString() } }] };
  const contract = token.contract ?? "wrap.near";
  return {
    receiverId: contract,
    actions: [
      ...(token.contract ? [] : [fc("storage_deposit", { account_id: from, registration_only: true }, NEAR_STORAGE), fc("near_deposit", {}, amountRaw.toString())]),
      fc("storage_deposit", { account_id: to, registration_only: true }, NEAR_STORAGE),
      fc("ft_transfer", { receiver_id: to, amount: amountRaw.toString() }),
    ],
  };
}

function evmTx(chainId: number, to: string, data: string, value = "0x0"): EvmTx {
  const c = evmChain(chainId)!;
  return { chainId, to, data, value, network: { name: c.name, symbol: c.native.symbol, rpcUrl: c.rpcs[0]!, explorerUrl: c.viem.blockExplorers?.default.url ?? null } };
}

/** Sends a token (ERC-20 or the network's own coin) to an address, on the token's EVM network. */
function evmSendTx(token: TokenInfo, amountRaw: bigint, to: string): EvmTx {
  const chainId = evmNetwork(token.chain as EvmNetwork).id;
  if (!token.contract) return evmTx(chainId, getAddress(to), "0x", `0x${amountRaw.toString(16)}`);
  return evmTx(chainId, getAddress(token.contract), encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(to), amountRaw] }));
}

export class SignSessions {
  private sessions = new Map<string, SignSession>();
  private pollers = new Map<string, NodeJS.Timeout>();

  constructor(private brain: Brain, private onUpdate: (s: SignSession) => void) {}

  /** Open NEAR Intents deposits (any network), so the Snap can check transfers against them. */
  pendingDeposits() {
    const out: Array<{ depositAddress: string; fromAddress: string; amountRaw: string; chainId?: number; token?: string | null }> = [];
    for (const s of this.sessions.values()) {
      if (s.done || Date.parse(s.expiresAt) < Date.now()) continue;
      for (const step of s.steps) {
        if ((step.kind === "evm" || step.kind === "near") && step.depositAddress && step.expectedSigner && step.amountRaw && step.state !== "done") {
          // An ERC-20 deposit calls the token contract; the network's own coin goes straight to the deposit address.
          const token = step.evmTx ? (step.evmTx.value === "0x0" ? step.evmTx.to : null) : undefined;
          out.push({ depositAddress: step.depositAddress, fromAddress: step.expectedSigner, amountRaw: step.amountRaw, chainId: step.evmTx?.chainId, token });
        }
      }
    }
    return out;
  }

  get(token: string) {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (Date.parse(s.expiresAt) < Date.now() && !s.done) return null;
    return s;
  }

  private newSession(id: string, title: string, healthBefore: number | null, healthAfter: number | null): SignSession {
    return {
      token: randomBytes(18).toString("base64url"), fixId: id, title, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      healthBefore, healthAfter, checks: [], privacyNote: null, steps: [], depositAddress: null, done: false,
    };
  }

  private wallet(label: string): Wallet {
    const w = this.brain.wallets.wallets.find((x) => x.label === label);
    if (!w) throw new Error(`Wallet "${label}" is no longer configured`);
    return w;
  }

  /** A wallet that signs a step: only one connected through its wallet app, which the step then opens. */
  private signer(label: string): Wallet & { app: { walletApp: string; walletAppName: string } } {
    const w = this.wallet(label);
    if (!isConnected(w)) {
      throw new Error(`${w.label} was added by address, so Nierwall only reads it. Connect it in Nierwall (Connect a wallet) to send transactions through it.`);
    }
    return { ...w, app: { walletApp: w.via!, walletAppName: walletAppName(w.via) ?? w.via! } };
  }

  /** Creates a one-time session for a fix. Cross-chain fixes get a real (wet) quote here, after checks pass. */
  async create(fix: FixOption): Promise<SignSession> {
    const plan = fix.plan;
    if (!plan) throw new Error("This option has no executable plan");
    const session = this.newSession(fix.id, fix.title, fix.healthBefore, fix.healthAfter);

    if (plan.type === "rhea_repay_from_evm" || plan.type === "rhea_repay_from_base") {
      const from = this.signer(plan.fromWallet);
      const to = this.signer(plan.toWallet);
      const network = plan.fromChain ?? "base";
      const usdc = await usdcOn(network);
      const amountRaw = toRaw(plan.amountUsdc, usdc.decimals);
      const q = await quote({
        originAsset: usdc.assetId, destinationAsset: ADDRESSES.intents.nearUsdc,
        amount: amountRaw.toString(), refundTo: from.address, recipient: to.address, dry: false,
      });
      session.checks = q.checks;
      if (q.checks.some((c) => !c.ok)) throw new Error(`Quote failed checks: ${q.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`);
      session.depositAddress = q.depositAddress;
      session.privacyNote = `This route links your ${networkName(network)} and NEAR addresses on-chain.`;
      session.steps.push({
        id: "evm_send", kind: "evm", chain: network, wallet: from.label, expectedSigner: getAddress(from.address), state: "ready", ...from.app,
        title: `Send ${q.amountInFormatted} USDC on ${networkName(network)}`,
        detail: `From ${from.label} to the NEAR Intents deposit address. Valid until ${q.deadline}.`,
        evmTx: evmSendTx(usdc, amountRaw, q.depositAddress!),
        depositAddress: q.depositAddress!, amountRaw: amountRaw.toString(),
      });
      session.steps.push({
        id: "intents_delivery", kind: "intents", chain: null, wallet: null, expectedSigner: null, state: "waiting", depositAddress: q.depositAddress!,
        title: `NEAR Intents delivers about ${Number(q.amountOutFormatted).toFixed(2)} USDC`,
        detail: `To ${to.label}, at least ${(Number(q.minAmountOut) / 1e6).toFixed(2)} USDC${q.timeEstimate ? `, usually within ${q.timeEstimate}s` : ""}.`,
      });
      session.steps.push({
        id: "near_repay", kind: "near", chain: "near", wallet: to.label, expectedSigner: to.address, state: "waiting", repayDelivered: true, ...to.app,
        title: "Repay USDC on Rhea",
        detail: `Repays what arrived. ${to.app.walletAppName} asks you to approve one transaction.`,
        nearTx: await rheaRepayTx(ADDRESSES.near.usdc, BigInt(q.minAmountOut)),
      });
    } else if (plan.type === "rhea_repay") {
      const w = this.signer(plan.wallet);
      session.steps.push({
        id: "near_repay", kind: "near", chain: "near", wallet: w.label, expectedSigner: w.address, state: "ready", ...w.app,
        title: `Repay ${plan.amountUsdc.toLocaleString("en-US")} USDC on Rhea`,
        detail: `${w.app.walletAppName} asks you to approve one transaction.`,
        nearTx: await rheaRepayTx(ADDRESSES.near.usdc, BigInt(Math.round(plan.amountUsdc * 1e6))),
      });
    } else {
      const w = this.signer(plan.wallet);
      const near = (await tokenList()).find((t) => t.chain === "near" && !t.contract)!;
      session.steps.push({
        id: "near_collateral", kind: "near", chain: "near", wallet: w.label, expectedSigner: w.address, state: "ready", ...w.app,
        title: `Add ${plan.amountNear.toLocaleString("en-US")} NEAR as collateral on Rhea`,
        detail: `Wraps the NEAR and adds it as collateral in one transaction. ${w.app.walletAppName} asks you to approve it.`,
        nearTx: await rheaCollateralTx(near, ADDRESSES.near.wnear, toRaw(plan.amountNear, near.decimals), w.address),
      });
    }
    this.sessions.set(session.token, session);
    this.brain.store.addEvent("fix_review_opened", { fix: fix.title, kind: fix.kind });
    return session;
  }

  /**
   * Creates a session for a checked plan. Swaps and moves get real (wet) quotes now, and each must still
   * deliver at least 98% of what the check promised. Steps run in order; each opens after the one before is confirmed.
   */
  async createFromPlan(plan: Plan): Promise<SignSession> {
    const loan = plan.loans[0];
    const session = this.newSession(plan.id, plan.title, loan?.before ?? null, loan?.after ?? null);
    const links = new Set<string>();
    let n = 0;
    const push = (step: Omit<SignStep, "id" | "state">) => session.steps.push({ ...step, id: `s${++n}`, state: n === 1 ? "ready" : "waiting" } as SignStep);

    for (const ps of plan.steps) {
      // Every step that sends goes through the wallet app its wallet was connected with; a step done by hand needs none.
      const signerApp = ps.execution === "manual" ? null : this.signer(ps.wallet).app;
      const app = signerApp ?? {};
      const approveIn = signerApp?.walletAppName ?? "Your wallet";
      const w = this.wallet(ps.wallet);
      const amountRaw = toRaw(ps.amount, ps.token.decimals);
      const signer = w.chain === "evm" ? getAddress(w.address) : w.address;
      if (ps.chain === "sol") throw new Error("Nierwall can't send from Solana wallets.");
      const kind = ps.chain === "near" ? "near" : "evm";

      if (ps.type === "swap" || ps.type === "move") {
        const to = this.wallet(ps.toWallet!);
        if (to.label !== w.label) links.add(`${w.label} and ${to.label}`);
        if (ps.route === "transfer") {
          push({
            kind, chain: ps.chain, wallet: w.label, expectedSigner: signer, ...app,
            title: `Send ${fmt(ps.amount)} ${ps.token.symbol} to ${to.label}`, detail: `A plain transfer between your wallets on ${networkName(ps.chain)}.`,
            ...(kind === "evm" ? { evmTx: evmSendTx(ps.token, amountRaw, to.address) } : { nearTx: nearSendTx(ps.token, amountRaw, w.address, to.address, false) }),
          });
          continue;
        }
        const stable = assetClass(ps.token.symbol) === "stable" && assetClass(ps.toToken!.symbol) === "stable";
        const q = await quote({
          originAsset: ps.token.assetId, destinationAsset: ps.toToken!.assetId, amount: amountRaw.toString(),
          refundTo: w.address, recipient: to.address, dry: false, slippageBps: stable ? 50 : 100,
          expectMinOut: toRaw(ps.minOut!, ps.toToken!.decimals).toString(),
        });
        session.checks.push(...q.checks.map((c) => ({ ...c, name: `step ${ps.n}: ${c.name}` })));
        if (q.checks.some((c) => !c.ok)) throw new Error(`Step ${ps.n} quote failed checks: ${q.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}. Prices may have moved; ask for the plan again.`);
        const deposit = q.depositAddress!;
        push({
          kind, chain: ps.chain, wallet: w.label, expectedSigner: signer, depositAddress: deposit, amountRaw: amountRaw.toString(), ...app,
          title: `Send ${fmt(ps.amount)} ${ps.token.symbol}${kind === "evm" ? ` on ${networkName(ps.chain)}` : ""} to NEAR Intents`,
          detail: `From ${w.label}${!ps.token.contract && kind === "near" ? " (wrapped to wNEAR in the same transaction)" : ""}. Valid until ${q.deadline}.`,
          ...(kind === "evm" ? { evmTx: evmSendTx(ps.token, amountRaw, deposit) } : { nearTx: nearSendTx(ps.token, amountRaw, w.address, deposit, true) }),
        });
        push({
          kind: "intents", chain: null, wallet: null, expectedSigner: null, depositAddress: deposit,
          title: `NEAR Intents delivers about ${fmt(Number(q.amountOutFormatted))} ${ps.toToken!.symbol}`,
          detail: `To ${to.label}, at least ${fmt(ps.minOut!)} ${ps.toToken!.symbol}${q.timeEstimate ? `, usually within ${q.timeEstimate}s` : ""}.`,
        });
        continue;
      }

      // Rhea: repay and add collateral are built here; withdrawing collateral is done in the Rhea app.
      if (ps.type === "repay" && ps.token.contract) {
        push({
          kind: "near", chain: "near", wallet: w.label, expectedSigner: w.address, ...app,
          title: `Repay ${fmt(ps.amount)} ${ps.token.symbol} on Rhea`, detail: `${approveIn} asks you to approve one transaction.`,
          nearTx: await rheaRepayTx(ps.protocolToken!, amountRaw),
        });
      } else if (ps.type === "add_collateral") {
        push({
          kind: "near", chain: "near", wallet: w.label, expectedSigner: w.address, ...app,
          title: `Add ${fmt(ps.amount)} ${ps.token.symbol} as collateral on Rhea`,
          detail: `${ps.token.contract ? "" : "Wraps the NEAR and adds it in one transaction. "}${approveIn} asks you to approve it.`,
          nearTx: await rheaCollateralTx(ps.token, ps.protocolToken!, amountRaw, w.address),
        });
      } else {
        push({
          kind: "link", chain: "near", wallet: w.label, expectedSigner: null, link: "https://app.rhea.finance/",
          title: ps.description, detail: "Nierwall can't build this Rhea transaction yet. Do it in the Rhea app, then mark it done here.",
        });
      }
    }

    if (links.size) session.privacyNote = `This plan links ${[...links].join(", ")} on-chain.`;
    this.sessions.set(session.token, session);
    this.brain.store.addEvent("plan_review_opened", { plan: plan.title, steps: plan.steps.length });
    return session;
  }

  /** Records a submitted transaction for a step and waits for it to confirm. */
  async record(token: string, stepId: string, txHash: string) {
    const s = this.get(token);
    if (!s) throw new Error("Session expired");
    const step = s.steps.find((x) => x.id === stepId);
    if (!step) throw new Error("Unknown step");
    if (step.state !== "ready") throw new Error("This step isn't ready yet");
    step.txHash = txHash;
    step.state = "submitted";
    if (step.kind === "evm") void this.confirmEvm(s, step);
    else if (step.kind === "near") void this.confirmNear(s, step);
    else this.finish(s, step, true); // a manual step marked done
    this.onUpdate(s);
    return s;
  }

  /** Marks a step done (or failed) and opens the next one. */
  private finish(s: SignSession, step: SignStep, ok: boolean) {
    step.state = ok ? "done" : "failed";
    if (!ok) return this.onUpdate(s);
    const next = s.steps[s.steps.indexOf(step) + 1];
    if (!next) {
      s.done = true;
      this.brain.store.addEvent("fix_completed", { fix: s.title, healthBefore: s.healthBefore, healthAfter: s.healthAfter });
      void this.brain.refreshNow();
    } else if (next.kind === "intents") {
      next.state = "submitted";
      this.pollDelivery(s, next);
    } else {
      next.state = "ready";
    }
    this.onUpdate(s);
  }

  private async confirmEvm(s: SignSession, step: SignStep) {
    try {
      const r = await evmClient(evmChain(step.evmTx!.chainId)!).waitForTransactionReceipt({ hash: step.txHash as Hex, timeout: 180_000 });
      this.finish(s, step, r.status === "success");
    } catch (e) {
      log.warn("EVM tx confirmation failed", { chainId: step.evmTx?.chainId, err: String(e).slice(0, 120) });
      this.finish(s, step, false);
    }
  }

  private pollDelivery(s: SignSession, step: SignStep) {
    const key = `${s.token}:${step.id}`;
    if (!step.depositAddress || this.pollers.has(key)) return;
    const timer = setInterval(async () => {
      try {
        const st = await swapStatus(step.depositAddress!);
        step.detail = `${step.detail.split(" Status:")[0]} Status: ${st.status.toLowerCase().replace(/_/g, " ")}.`;
        if (st.status === "SUCCESS" || st.status === "REFUNDED" || st.status === "FAILED") {
          clearInterval(timer);
          this.pollers.delete(key);
          const next = s.steps[s.steps.indexOf(step) + 1];
          if (st.status === "SUCCESS" && next?.repayDelivered && st.amountOut) next.nearTx = await rheaRepayTx(ADDRESSES.near.usdc, BigInt(st.amountOut));
          this.finish(s, step, st.status === "SUCCESS");
        } else {
          this.onUpdate(s);
        }
      } catch (e) {
        log.warn("delivery status failed", { err: String(e).slice(0, 120) });
      }
    }, 10_000);
    this.pollers.set(key, timer);
  }

  private async confirmNear(s: SignSession, step: SignStep) {
    try {
      const { env } = await import("../config.js");
      const body = { jsonrpc: "2.0", id: "1", method: "tx", params: { tx_hash: step.txHash, sender_account_id: step.expectedSigner, wait_until: "FINAL" } };
      const res = await fetch(env.NEAR_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json()) as { result?: { status?: Record<string, unknown> } };
      this.finish(s, step, !!j.result?.status && "SuccessValue" in j.result.status);
    } catch (e) {
      log.warn("NEAR tx confirmation failed", { err: String(e).slice(0, 120) });
      this.finish(s, step, false);
    }
  }
}
