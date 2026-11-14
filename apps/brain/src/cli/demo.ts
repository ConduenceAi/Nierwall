/**
 * Terminal demo: the full watch → alert → fix loop without the Mac app.
 * Uses your config/wallets.json if present, otherwise public read-only fixture accounts.
 *   pnpm demo            run the scripted scenario (NEAR -9%, ETH -10%)
 *   pnpm demo --calm     only show the live snapshot
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { allocationOf, checkPlan } from "../advisor/plans.js";
import { dryQuote } from "../advisor/quotes.js";
import { networkName } from "../chains.js";
import { rheaAssets, rheaTokenBySymbol } from "../protocols/rhea.js";
import { coinPrices, type CoinPrice } from "../sources/coins.js";
import { tokenList } from "../tokens.js";
import { DATA_DIR, loadWallets } from "../config.js";
import { Brain } from "../brain.js";
import { Store } from "../store.js";
import type { Alert, LendingPosition, Snapshot } from "../types.js";
import { describeWatch } from "../watches/engine.js";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};
const money = (x: number) => `$${x.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

function printSnapshot(s: Snapshot) {
  const prices = Object.values(s.prices).map((p) => `${p!.symbol} $${p!.usd.toLocaleString("en-US", { maximumFractionDigits: 4 })}${p!.simulated ? c.amber("*") : ""} ${c.dim(`(${p!.source})`)}`);
  console.log(`  Prices: ${prices.join("   ")}`);
  for (const p of s.positions) printPosition(p);
  // Each wallet's largest balances, on whichever networks they are.
  for (const w of new Set(s.balances.map((b) => b.walletLabel))) {
    const held = s.balances.filter((b) => b.walletLabel === w).sort((a, b) => b.usd - a.usd);
    const list = held.slice(0, 4).map((b) => `${b.amount.toLocaleString("en-US", { maximumFractionDigits: b.amount < 1 ? 4 : 2 })} ${b.symbol} on ${networkName(b.chain)}`);
    console.log(c.dim(`  ${w}: ${list.join(", ")}${held.length > 4 ? `, and ${held.length - 4} more` : ""}`));
  }
  if (s.errors.length) console.log(c.amber(`  Data problems: ${s.errors.join("; ")}`));
}

function printPosition(p: LendingPosition) {
  const name = "Rhea · NEAR";
  const hf = p.healthFactor == null ? "no debt" : p.healthFactor.toFixed(3);
  const col = p.collateral.map((x) => `${x.amount.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${x.symbol}`).join(", ");
  const debt = p.debt.map((x) => `${x.amount.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${x.symbol}`).join(", ");
  const dist = p.liquidationDistance == null ? "" : `, liquidation after a ${(p.liquidationDistance * 100).toFixed(1)}% drop`;
  console.log(`  ${c.bold(name)} (${p.walletLabel}) health ${c.bold(hf)}${p.simulated ? c.amber(" SIMULATED") : ""}${dist}`);
  console.log(c.dim(`    collateral ${money(p.collateralUsd)} [${col}]  debt ${money(p.debtUsd)} [${debt}]`));
}

function printAlert(a: Alert) {
  const color = a.severity === "critical" ? c.red : a.severity === "warning" ? c.amber : c.green;
  console.log(color(`\n  ▲ ${a.title}`));
  console.log(`    ${a.body}`);
  for (const f of a.fixes) {
    const hf = f.healthAfter != null ? ` → health ${f.healthAfter.toFixed(2)}` : "";
    console.log(`    ${c.cyan(`${String.fromCharCode(64 + f.rank)}.`)} ${f.title}${hf}`);
    for (const s of f.steps) console.log(c.dim(`       - [${networkName(s.chain)}] ${s.description} (sign in ${s.wallet})`));
    for (const n of f.notes) console.log(c.dim(`       · ${n}`));
  }
}

async function main() {
  const calmOnly = process.argv.includes("--calm");
  const dbPath = resolve(DATA_DIR, "demo.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
  const store = new Store(dbPath);
  const { config, source } = loadWallets();
  const brain = new Brain(store, config);

  console.log(c.bold("\nNierwall · terminal demo"));
  console.log(c.dim(source === "fixtures"
    ? "  Using public read-only fixture accounts (add config/wallets.json to watch your own)."
    : "  Using your wallets from config/wallets.json."));

  console.log(c.bold("\n1. Live snapshot"));
  const first = await brain.tick();
  printSnapshot(first.data.snapshot);
  if (calmOnly) return;

  console.log(c.bold("\n2. Watches (as if you'd said them out loud)"));
  for (const p of first.data.snapshot.positions) {
    if (p.healthFactor == null) continue;
    const threshold = Math.floor(p.healthFactor * 0.94 * 100) / 100;
    const params = { positionId: p.id, threshold };
    const w = store.newWatch({ kind: "health_below", label: describeWatch("health_below", params), params, source: "demo" });
    store.confirmWatch(w.id);
    console.log(`  ✓ ${w.label}`);
  }
  const eth = first.data.snapshot.prices.ETH?.usd;
  if (eth) {
    const params = { symbol: "ETH", pct: -0.1, referencePrice: eth };
    const w = store.newWatch({ kind: "price_move", label: describeWatch("price_move", params), params, source: "demo" });
    store.confirmWatch(w.id);
    console.log(`  ✓ ${w.label}`);
  }

  console.log(c.bold("\n3. Calm check"));
  const calm = await brain.tick();
  console.log(calm.alerts.length ? `  ${calm.alerts.length} alert(s)` : c.green("  All good. Nothing needs you."));

  console.log(c.bold("\n4. Scenario: NEAR -9%, ETH -10% (labeled SIMULATED everywhere)"));
  brain.scenario.start({ NEAR: -0.09, ETH: -0.1 }, "terminal demo");
  const shocked = await brain.tick();
  for (const p of shocked.data.snapshot.positions) printPosition(p);
  if (!shocked.alerts.length) console.log(c.dim("  No watch crossed its line."));
  shocked.alerts.forEach(printAlert);

  console.log(c.bold("\n5. Prices recover"));
  brain.scenario.clear();
  const after = await brain.tick();
  after.alerts.forEach(printAlert);
  console.log(c.dim(`\n  Incidents: ${store.listIncidents().map((i) => `${i.title} (${i.state})`).join("; ") || "none"}`));

  console.log(c.bold("\n6. Advisor: a plan the AI could propose, checked on this Mac"));
  const { holdings } = await brain.portfolio.holdings(null);
  const alloc = allocationOf(holdings, after.data.snapshot.positions);
  console.log(`  Net worth ${money(alloc.netWorthUsd)}: ${alloc.classes.map((x) => `${x.cls} ${x.pct}%`).join(" · ")} ${c.dim("(loans netted)")}`);
  if (source === "fixtures") {
    const [tokens, assets] = await Promise.all([tokenList(), rheaAssets()]);
    const check = await checkPlan(
      {
        title: "Bring cash to NEAR and repay the Rhea loan",
        goal: "a safer Rhea loan",
        // In the app the AI sets this per plan; the demo shows a fixed example.
        maxCostUsd: 20,
        costReason: "Worth a few dollars to move a loan away from liquidation",
        actions: [
          { type: "move", fromWallet: "Demo cash wallet", toWallet: "Demo NEAR wallet", token: "USDC", amount: 2000 },
          { type: "repay", wallet: "Demo NEAR wallet", protocol: "rhea", token: "USDC", amount: 1950 },
        ],
      },
      {
        wallets: config, positions: after.data.snapshot.positions, rheaToken: (sym) => rheaTokenBySymbol(assets, sym),
        holdings, tokens, watches: store.listWatches("active"), protectedWallets: [], quote: dryQuote, simulated: false,
      },
    );
    if (check.ok) {
      console.log(`  ${c.bold(check.plan.title)}`);
      for (const st of check.plan.steps) console.log(`    ${st.n}. ${st.description}`);
      for (const l of check.plan.loans) console.log(c.green(`    ${l.label}: health ${l.before?.toFixed(2) ?? "–"} → ${l.after?.toFixed(2) ?? "–"}`));
      console.log(c.dim(`    About $${check.plan.costUsd.toFixed(2)} in fees and slippage.`));
      for (const w of check.plan.warnings) console.log(c.amber(`    ! ${w}`));
    } else {
      console.log(c.amber(`  Plan rejected: ${check.errors.join(" ")}`));
    }
  }
  const sol = await coinPrices(["solana"]).catch(() => ({}) as Record<string, CoinPrice>);
  if (sol.solana) console.log(c.dim(`  Token watches work for any coin, e.g. SOL is $${sol.solana.usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}${sol.solana.change24h != null ? ` (${sol.solana.change24h.toFixed(1)}% in 24h)` : ""}, from ${sol.solana.source === "defillama" ? "DefiLlama" : "CoinGecko"}.`));
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
