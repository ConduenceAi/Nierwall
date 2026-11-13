import { formatUnits } from "viem";
import { quote } from "../intents/oneclick.js";
import { assetClass, type QuoteEstimate } from "./plans.js";
import { toRaw, type TokenInfo } from "../tokens.js";

/**
 * Stand-in accounts for checking prices. A dry quote's price doesn't depend on who receives the funds, so
 * the real addresses only go to NEAR Intents once the user opens a plan to sign it.
 */
const placeholder = (network: TokenInfo["chain"]) => (network === "near" ? "intents.near" : "0x1111111111111111111111111111111111111111");

/** Dry NEAR Intents quote for a plan step, in token units. */
export async function dryQuote(from: TokenInfo, to: TokenInfo, amount: number): Promise<QuoteEstimate> {
  const stable = assetClass(from.symbol) === "stable" && assetClass(to.symbol) === "stable";
  const q = await quote({
    originAsset: from.assetId,
    destinationAsset: to.assetId,
    amount: toRaw(amount, from.decimals).toString(),
    refundTo: placeholder(from.chain),
    recipient: placeholder(to.chain),
    dry: true,
    slippageBps: stable ? 50 : 100,
    quoteWaitingTimeMs: 1500,
  });
  return {
    expectedOut: Number(q.amountOutFormatted),
    minOut: Number(formatUnits(BigInt(q.minAmountOut || "0"), to.decimals)),
    timeEstimate: q.timeEstimate,
  };
}
