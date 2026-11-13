import { env } from "../config.js";

const BASE = "https://1click.chaindefuser.com";

export interface QuoteParams {
  originAsset: string;
  destinationAsset: string;
  /** Base units of the origin asset. */
  amount: string;
  refundTo: string;
  recipient: string;
  dry: boolean;
  slippageBps?: number;
  deadlineMinutes?: number;
  quoteWaitingTimeMs?: number;
  /** Minimum output (base units) agreed when a plan was checked; replaces the same-token output check. */
  expectMinOut?: string;
}

export interface Quote {
  dry: boolean;
  amountIn: string;
  amountInFormatted: string;
  amountOut: string;
  amountOutFormatted: string;
  minAmountOut: string;
  timeEstimate: number | null;
  depositAddress: string | null;
  deadline: string | null;
  recipient: string;
  originAsset: string;
  destinationAsset: string;
  correlationId: string;
  signature: string | null;
  /** Checks Nierwall ran on the quote before showing it. */
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.ONECLICK_JWT) headers.authorization = `Bearer ${env.ONECLICK_JWT}`;
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`1Click ${path} ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

/**
 * Requests a 1Click quote. Dry quotes price the route without creating a deposit address; a wet quote
 * (dry=false) is only requested when the user opens the review screen.
 */
export async function quote(p: QuoteParams): Promise<Quote> {
  const deadline = new Date(Date.now() + (p.deadlineMinutes ?? 30) * 60_000).toISOString();
  const body = {
    dry: p.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: p.slippageBps ?? 50,
    originAsset: p.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: p.destinationAsset,
    amount: p.amount,
    refundTo: p.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: p.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline,
    referral: "nierwall",
    quoteWaitingTimeMs: p.quoteWaitingTimeMs ?? 3000,
  };
  const r = await call<{ correlationId: string; signature?: string; quoteRequest: typeof body; quote: Record<string, any> }>("/v0/quote", { method: "POST", body: JSON.stringify(body) });
  const q = r.quote;
  const out: Quote = {
    dry: p.dry,
    amountIn: String(q.amountIn),
    amountInFormatted: String(q.amountInFormatted),
    amountOut: String(q.amountOut),
    amountOutFormatted: String(q.amountOutFormatted),
    minAmountOut: String(q.minAmountOut),
    timeEstimate: q.timeEstimate ?? null,
    depositAddress: q.depositAddress ?? null,
    deadline: q.deadline ?? null,
    recipient: r.quoteRequest.recipient,
    originAsset: r.quoteRequest.originAsset,
    destinationAsset: r.quoteRequest.destinationAsset,
    correlationId: r.correlationId,
    signature: r.signature ?? null,
    checks: [],
  };
  out.checks = checkQuote(out, p);
  return out;
}

/** Nierwall's own checks on a quote; any failure blocks the review screen. */
export function checkQuote(q: Quote, p: QuoteParams): Quote["checks"] {
  const minOut = BigInt(q.minAmountOut || "0");
  const amountIn = BigInt(q.amountIn || "0");
  const slip = BigInt(p.slippageBps ?? 50);
  const checks = [
    { name: "recipient", ok: q.recipient === p.recipient, detail: q.recipient === p.recipient ? "Funds go to your own account" : "Recipient does not match your account" },
    { name: "route", ok: q.originAsset === p.originAsset && q.destinationAsset === p.destinationAsset, detail: "Origin and destination tokens match the plan" },
    { name: "amount", ok: amountIn === BigInt(p.amount), detail: "Input amount matches the plan" },
    p.expectMinOut != null
      ? // A checked plan: the price may not have moved more than 2% against it since.
        { name: "minimum output", ok: minOut * 100n >= BigInt(p.expectMinOut) * 98n, detail: `At least ${q.minAmountOut} base units arrive (plan expected ${p.expectMinOut})` }
      : // Same-decimals stablecoin route: minimum out must stay within slippage + 0.5% of the input.
        { name: "minimum output", ok: minOut * 10_000n >= amountIn * (10_000n - slip - 50n), detail: `At least ${q.minAmountOut} base units arrive` },
  ];
  if (!q.dry) {
    const ok = !!q.depositAddress && !!q.deadline && Date.parse(q.deadline) - Date.now() > 10 * 60_000;
    checks.push({ name: "deposit window", ok, detail: ok ? `Valid until ${q.deadline}` : "Deposit window too short or missing" });
  }
  return checks;
}

export interface SwapStatus {
  status: "KNOWN_DEPOSIT_TX" | "PENDING_DEPOSIT" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED" | string;
  amountOut?: string;
  nearTxHashes?: string[];
}

export async function swapStatus(depositAddress: string): Promise<SwapStatus> {
  const r = await call<{ status: string; swapDetails?: { amountOut?: string; nearTxHashes?: string[] } }>(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  return { status: r.status, amountOut: r.swapDetails?.amountOut, nearTxHashes: r.swapDetails?.nearTxHashes };
}
