import { randomBytes } from "node:crypto";
import { encodeFunctionData, getAddress, parseAbi } from "viem";
import type { Brain } from "../brain.js";
import { ADDRESSES, FIXTURE_WALLETS } from "../config.js";
import { quote, swapStatus, type Quote } from "../intents/oneclick.js";
import { logger } from "../log.js";
import { rheaAssets } from "../protocols/rhea.js";
import type { FixOption } from "../types.js";

const log = logger("sign");
const erc20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const NEAR_GAS = "300000000000000";

export type StepState = "waiting" | "ready" | "submitted" | "done" | "failed";

export interface SignStep {
  id: "base_send" | "intents_delivery" | "near_repay" | "manual";
  title: string;
  detail: string;
  state: StepState;
  chain: "base" | "near" | null;
  wallet: string | null;
  /** Address/account that must sign (shown to the user, checked in the page). */
  expectedSigner: string | null;
  evmTx?: { chainId: number; to: string; data: string; value: string };
  nearTx?: { receiverId: string; actions: Array<{ type: "FunctionCall"; params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string } }> };
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

/** Builds Rhea's repay call: deposit USDC with ft_transfer_call and repay it in the same execution. */
async function rheaRepayTx(amountRaw: bigint) {
  const assets = await rheaAssets();
  const extra = BigInt(assets[ADDRESSES.near.usdc]?.config?.extra_decimals ?? 12);
  const maxAmountInternal = (amountRaw * 10n ** extra).toString();
  return {
    receiverId: ADDRESSES.near.usdc,
    actions: [
      {
        type: "FunctionCall" as const,
        params: {
          methodName: "ft_transfer_call",
          args: {
            receiver_id: ADDRESSES.near.rhea,
            amount: amountRaw.toString(),
            msg: JSON.stringify({ Execute: { actions: [{ Repay: { token_id: ADDRESSES.near.usdc, max_amount: maxAmountInternal } }] } }),
          },
          gas: NEAR_GAS,
          deposit: "1",
        },
      },
    ],
  };
}

export class SignSessions {
  private sessions = new Map<string, SignSession>();
  private pollers = new Map<string, NodeJS.Timeout>();

  constructor(private brain: Brain, private onUpdate: (s: SignSession) => void) {}

  /** Deposit addresses of open cross-chain fixes, so the Snap can check transfers against them. */
  pendingDeposits() {
    const out: Array<{ depositAddress: string; fromAddress: string; amountRaw: string }> = [];
    for (const s of this.sessions.values()) {
      const step = s.steps.find((x) => x.id === "base_send");
      if (!s.done && s.depositAddress && step?.expectedSigner && step.state !== "done" && Date.parse(s.expiresAt) > Date.now()) {
        const amountHex = step.evmTx?.data.slice(-64) ?? "0";
        out.push({ depositAddress: s.depositAddress, fromAddress: step.expectedSigner, amountRaw: BigInt(`0x${amountHex}`).toString() });
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

  /** Creates a one-time session for a fix. Cross-chain fixes get a real (wet) quote here, after checks pass. */
  async create(fix: FixOption): Promise<SignSession> {
    const plan = fix.plan;
    if (!plan) throw new Error("This option has no executable plan");
    if (this.brain.wallets === FIXTURE_WALLETS) throw new Error("These are public demo accounts, so there's nothing for you to sign. Add your own wallets in config/wallets.json to review and sign fixes.");
    const wallets = this.brain.wallets.wallets;
    const token = randomBytes(18).toString("base64url");
    const session: SignSession = {
      token, fixId: fix.id, title: fix.title, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      healthBefore: fix.healthBefore, healthAfter: fix.healthAfter, checks: [], privacyNote: null, steps: [], depositAddress: null, done: false,
    };

    if (plan.type === "rhea_repay_from_base") {
      const from = wallets.find((w) => w.label === plan.fromWallet);
      const to = wallets.find((w) => w.label === plan.toWallet);
      if (!from || !to) throw new Error("Wallets for this fix are no longer configured");
      const amountRaw = BigInt(Math.round(plan.amountUsdc * 1e6));
      const q = await quote({
        originAsset: ADDRESSES.intents.baseUsdc, destinationAsset: ADDRESSES.intents.nearUsdc,
        amount: amountRaw.toString(), refundTo: from.address, recipient: to.address, dry: false,
      });
      session.checks = q.checks;
      if (q.checks.some((c) => !c.ok)) throw new Error(`Quote failed checks: ${q.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`);
      session.depositAddress = q.depositAddress;
      session.privacyNote = "This route links your Base and NEAR addresses on-chain.";
      session.steps.push({
        id: "base_send", chain: "base", wallet: from.label, expectedSigner: getAddress(from.address), state: "ready",
        title: `Send ${q.amountInFormatted} USDC on Base`,
        detail: `From ${from.label} to the NEAR Intents deposit address. Valid until ${q.deadline}.`,
        evmTx: {
          chainId: 8453,
          to: getAddress(ADDRESSES.base.usdc),
          data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [getAddress(q.depositAddress!), amountRaw] }),
          value: "0x0",
        },
      });
      session.steps.push({
        id: "intents_delivery", chain: null, wallet: null, expectedSigner: null, state: "waiting",
        title: `NEAR Intents delivers about ${Number(q.amountOutFormatted).toFixed(2)} USDC`,
        detail: `To ${to.label}, at least ${(Number(q.minAmountOut) / 1e6).toFixed(2)} USDC${q.timeEstimate ? `, usually within ${q.timeEstimate}s` : ""}.`,
      });
      session.steps.push({
        id: "near_repay", chain: "near", wallet: to.label, expectedSigner: to.address, state: "waiting",
        title: "Repay USDC on Rhea",
        detail: "Repays what arrived. Your NEAR wallet asks you to approve one transaction.",
        nearTx: await rheaRepayTx(BigInt(q.minAmountOut)),
      });
    } else if (plan.type === "rhea_repay") {
      const w = wallets.find((x) => x.label === plan.wallet);
      if (!w) throw new Error("Wallet for this fix is no longer configured");
      const amountRaw = BigInt(Math.round(plan.amountUsdc * 1e6));
      session.steps.push({
        id: "near_repay", chain: "near", wallet: w.label, expectedSigner: w.address, state: "ready",
        title: `Repay ${plan.amountUsdc.toLocaleString("en-US")} USDC on Rhea`,
        detail: "Your NEAR wallet asks you to approve one transaction.",
        nearTx: await rheaRepayTx(amountRaw),
      });
    } else {
      session.steps.push({
        id: "manual", chain: "near", wallet: plan.wallet, expectedSigner: null, state: "ready",
        title: `Add ${plan.amountNear.toLocaleString("en-US")} NEAR as collateral in the Rhea app`,
        detail: "Nierwall can't build this transaction yet. Open Rhea, supply NEAR and enable it as collateral.",
        link: "https://app.rhea.finance/",
      });
    }
    this.sessions.set(token, session);
    this.brain.store.addEvent("fix_review_opened", { fix: fix.title, kind: fix.kind });
    return session;
  }

  /** Records a submitted transaction for a step and advances the flow. */
  async record(token: string, stepId: SignStep["id"], txHash: string) {
    const s = this.get(token);
    if (!s) throw new Error("Session expired");
    const step = s.steps.find((x) => x.id === stepId);
    if (!step) throw new Error("Unknown step");
    step.txHash = txHash;
    step.state = "submitted";
    if (stepId === "base_send") {
      step.state = "done";
      const delivery = s.steps.find((x) => x.id === "intents_delivery");
      if (delivery) delivery.state = "submitted";
      this.pollDelivery(s);
    }
    if (stepId === "near_repay") void this.confirmNear(s, step);
    this.onUpdate(s);
    return s;
  }

  private pollDelivery(s: SignSession) {
    if (!s.depositAddress || this.pollers.has(s.token)) return;
    const timer = setInterval(async () => {
      try {
        const st = await swapStatus(s.depositAddress!);
        const delivery = s.steps.find((x) => x.id === "intents_delivery")!;
        delivery.detail = `${delivery.detail.split(" Status:")[0]} Status: ${st.status.toLowerCase().replace(/_/g, " ")}.`;
        if (st.status === "SUCCESS") {
          delivery.state = "done";
          const repay = s.steps.find((x) => x.id === "near_repay");
          if (repay) {
            if (st.amountOut) repay.nearTx = await rheaRepayTx(BigInt(st.amountOut));
            repay.state = "ready";
          }
          clearInterval(timer);
          this.pollers.delete(s.token);
        } else if (st.status === "REFUNDED" || st.status === "FAILED") {
          delivery.state = "failed";
          clearInterval(timer);
          this.pollers.delete(s.token);
        }
        this.onUpdate(s);
      } catch (e) {
        log.warn("delivery status failed", { err: String(e).slice(0, 120) });
      }
    }, 10_000);
    this.pollers.set(s.token, timer);
  }

  private async confirmNear(s: SignSession, step: SignStep) {
    try {
      const { env } = await import("../config.js");
      const body = { jsonrpc: "2.0", id: "1", method: "tx", params: { tx_hash: step.txHash, sender_account_id: step.expectedSigner, wait_until: "FINAL" } };
      const res = await fetch(env.NEAR_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json()) as { result?: { status?: Record<string, unknown> } };
      const ok = !!j.result?.status && "SuccessValue" in j.result.status;
      step.state = ok ? "done" : "failed";
      if (ok) {
        s.done = true;
        this.brain.store.addEvent("fix_completed", { fix: s.title, healthBefore: s.healthBefore, healthAfter: s.healthAfter });
        void this.brain.refreshNow();
      }
    } catch (e) {
      log.warn("NEAR tx confirmation failed", { err: String(e).slice(0, 120) });
      step.state = "failed";
    }
    this.onUpdate(s);
  }
}
