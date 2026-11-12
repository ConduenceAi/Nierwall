import { randomUUID } from "node:crypto";
import { ADDRESSES } from "../config.js";
import { collateralToReach, previewRheaAddCollateral, previewRheaRepay, repayToReach, rheaAssets, type RheaAccountDetail } from "../protocols/rhea.js";
import type { FixOption, Snapshot, Watch } from "../types.js";
import type { SnapshotWithDetail } from "../portfolio.js";
import type { WalletsConfig } from "../config.js";
import { quote } from "../intents/oneclick.js";

export interface PlannerPrefs {
  /** Prefer repaying debt over adding collateral (from memory; default true). */
  preferRepay: boolean;
  /** Wallet labels fixes must not draw from unless health is critical. */
  protectedWallets: string[];
  /** Minimum balances to keep, e.g. { "Cash:USDC": 3000 }. */
  reserves: Record<string, number>;
}

export const DEFAULT_PREFS: PlannerPrefs = { preferRepay: true, protectedWallets: [], reserves: {} };

const fmt = (x: number, d = 2) => x.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });

/**
 * Fix options for a Rhea position below its floor. Deterministic: amounts come from Rhea's weights,
 * never from the model. Cross-chain options are marked so the Intents quote can be attached later.
 */
export async function planRheaFixes(args: {
  detail: RheaAccountDetail;
  snapshot: Snapshot;
  wallets: WalletsConfig;
  target: number;
  critical: boolean;
  prefs: PlannerPrefs;
}): Promise<FixOption[]> {
  const { detail, snapshot, wallets, target, critical, prefs } = args;
  const options: FixOption[] = [];
  const pos = detail.position;
  const before = pos.healthFactor;
  const usdcDebt = pos.debt.find((d) => d.token === ADDRESSES.near.usdc);
  const nearWallet = wallets.wallets.find((w) => w.label === pos.walletLabel);

  // 1) Repay USDC debt.
  if (usdcDebt) {
    const need = repayToReach(detail, ADDRESSES.near.usdc, target);
    if (need && need > 0) {
      const amount = Math.ceil(need * 1.01); // 1% buffer for interest and price drift
      const after = previewRheaRepay(detail, ADDRESSES.near.usdc, amount);
      const nearUsdc = snapshot.balances.find((b) => b.walletLabel === pos.walletLabel && b.symbol === "USDC")?.amount ?? 0;
      if (nearUsdc >= amount) {
        options.push({
          id: randomUUID(), kind: "repay", rank: 0, plan: { type: "rhea_repay", amountUsdc: amount, wallet: pos.walletLabel },
          title: `Repay ${fmt(amount, 0)} USDC on Rhea from ${pos.walletLabel}`,
          steps: [{ chain: "near", wallet: pos.walletLabel, description: `Repay ${fmt(amount, 0)} USDC on Rhea` }],
          healthBefore: before, healthAfter: after, notes: [], intentsQuote: null,
        });
      } else {
        // Source USDC from a Base wallet through NEAR Intents.
        for (const w of wallets.wallets.filter((x) => x.chain === "base")) {
          const bal = snapshot.balances.find((b) => b.walletLabel === w.label && b.symbol === "USDC")?.amount ?? 0;
          const reserve = prefs.reserves[`${w.label}:USDC`] ?? 0;
          const spendable = bal - reserve;
          const isProtected = prefs.protectedWallets.includes(w.label) && !critical;
          if (spendable >= amount && !isProtected) {
            options.push({
              id: randomUUID(), kind: "repay", rank: 0, plan: { type: "rhea_repay_from_base", amountUsdc: amount, fromWallet: w.label, toWallet: pos.walletLabel },
              title: `Move ${fmt(amount, 0)} USDC from ${w.label} (Base) to NEAR, then repay on Rhea`,
              steps: [
                { chain: "base", wallet: w.label, description: `Send ${fmt(amount, 0)} USDC to a NEAR Intents deposit address` },
                { chain: "near", wallet: pos.walletLabel, description: `Repay the USDC that arrives on Rhea` },
              ],
              healthBefore: before, healthAfter: after,
              notes: [`${w.label} keeps ${fmt(bal - amount, 0)} USDC${reserve ? ` (reserve ${fmt(reserve, 0)})` : ""}`, "Links your Base and NEAR addresses on-chain"],
              intentsQuote: null,
            });
          }
        }
        if (!options.some((o) => o.kind === "repay")) {
          options.push({
            id: randomUUID(), kind: "repay", rank: 0,
            title: `Repay ${fmt(amount, 0)} USDC on Rhea`,
            steps: [{ chain: "near", wallet: pos.walletLabel, description: `Repay ${fmt(amount, 0)} USDC (you'll need to bring USDC to NEAR first)` }],
            healthBefore: before, healthAfter: after,
            notes: ["No linked wallet holds enough spare USDC; this is a hypothetical amount"], intentsQuote: null,
          });
        }
      }
    }
  }

  // 2) Add NEAR collateral from the NEAR wallet.
  if (nearWallet) {
    const assets = await rheaAssets();
    const need = collateralToReach(detail, ADDRESSES.near.wnear, target, assets as any);
    const nearBal = snapshot.balances.find((b) => b.walletLabel === nearWallet.label && b.symbol === "NEAR")?.amount ?? 0;
    if (need && need > 0) {
      const amount = Math.ceil(need * 1.01);
      const after = previewRheaAddCollateral(detail, ADDRESSES.near.wnear, amount, assets as any);
      const isProtected = prefs.protectedWallets.includes(nearWallet.label) && !critical;
      const enough = nearBal - 0.5 >= amount; // keep 0.5 NEAR for gas and storage
      options.push({
        id: randomUUID(), kind: "add_collateral", rank: 0, plan: { type: "rhea_add_collateral", amountNear: amount, wallet: nearWallet.label },
        title: `Add ${fmt(amount, 0)} NEAR as collateral from ${nearWallet.label}`,
        steps: [{ chain: "near", wallet: nearWallet.label, description: `Supply ${fmt(amount, 0)} NEAR to Rhea as collateral` }],
        healthBefore: before, healthAfter: after,
        notes: [
          ...(enough ? [] : [`${nearWallet.label} holds ${fmt(nearBal, 1)} NEAR, not enough; hypothetical`]),
          ...(isProtected ? [`${nearWallet.label} is marked long-term`] : []),
          "Puts more NEAR at risk if the price keeps falling",
        ],
        intentsQuote: null,
      });
    }
  }

  // Rank: preference first, then options that are actually fundable.
  const score = (o: FixOption) =>
    (prefs.preferRepay ? (o.kind === "repay" ? 0 : 10) : o.kind === "repay" ? 10 : 0) +
    (o.notes.some((n) => n.includes("hypothetical")) ? 20 : 0) +
    (o.notes.some((n) => n.includes("long-term")) ? 5 : 0);
  options.sort((a, b) => score(a) - score(b));
  options.forEach((o, i) => (o.rank = i + 1));
  const top = options.slice(0, 3);
  await Promise.all(top.map((o) => attachDryQuote(o, wallets)));
  return top;
}

/** Prices the cross-chain leg with a dry NEAR Intents quote (no deposit address is created). */
async function attachDryQuote(o: FixOption, wallets: WalletsConfig) {
  if (o.plan?.type !== "rhea_repay_from_base") return;
  const plan = o.plan;
  const from = wallets.wallets.find((w) => w.label === plan.fromWallet);
  const to = wallets.wallets.find((w) => w.label === plan.toWallet);
  if (!from || !to) return;
  try {
    const q = await quote({
      originAsset: ADDRESSES.intents.baseUsdc,
      destinationAsset: ADDRESSES.intents.nearUsdc,
      amount: String(Math.round(plan.amountUsdc * 1e6)),
      refundTo: from.address,
      recipient: to.address,
      dry: true,
    });
    o.intentsQuote = { amountIn: q.amountInFormatted, amountOutMin: (Number(q.minAmountOut) / 1e6).toFixed(2), deadline: "", dry: true };
    o.notes.unshift(`NEAR Intents: about ${fmt(Number(q.amountOutFormatted), 2)} USDC arrives${q.timeEstimate ? ` in ~${q.timeEstimate}s` : ""}, at least ${fmt(Number(q.minAmountOut) / 1e6, 2)}`);
  } catch (e) {
    o.notes.push(`NEAR Intents quote unavailable right now (${String(e).slice(0, 80)})`);
  }
}

/** Fixes for an incident's watch, if the position is one Nierwall can fix (Rhea). */
export async function fixesFor(watch: Watch, data: SnapshotWithDetail, wallets: WalletsConfig, prefs: PlannerPrefs, critical: boolean) {
  const p = watch.params as Record<string, any>;
  if (watch.kind !== "health_below" && watch.kind !== "liq_distance") return [];
  const positionId = String(p.positionId);
  if (!positionId.startsWith("rhea:")) return [];
  const detail = data.rhea.get(positionId.slice(5));
  if (!detail) return [];
  const threshold = watch.kind === "health_below" ? Number(p.threshold) : 1.3;
  return planRheaFixes({ detail, snapshot: data.snapshot, wallets, target: threshold + 0.2, critical, prefs });
}
