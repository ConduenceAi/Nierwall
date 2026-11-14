import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { type EvmNetwork, type Wallet, type WalletsConfig } from "./config.js";
import { ConnectLinks, defaultLabel, MAX_WALLETS, nearAccountExists, NO_CONNECTIONS, parseAddress, type Connections } from "./connections.js";
import { logger } from "./log.js";
import { DEFAULT_PREFS, fixesFor, type PlannerPrefs } from "./planner/fixes.js";
import { Portfolio, type SnapshotWithDetail } from "./portfolio.js";
import { Scenario, scenarioLabel } from "./scenario.js";
import { coinPrices, volatility } from "./sources/coins.js";
import { Store } from "./store.js";
import type { Alert, Incident, Severity, Snapshot } from "./types.js";
import { combineSeverity, evaluate, isNearLimit, type Evaluation, type SeverityJudgment } from "./watches/engine.js";

export type { SeverityJudgment };

const log = logger("brain");
const REMIND_CRITICAL_MS = 15 * 60_000;
/** How often the AI re-judges an open warning. */
const REJUDGE_MS = 30 * 60_000;
export interface TickResult {
  data: SnapshotWithDetail;
  evaluations: Evaluation[];
  alerts: Alert[];
}

/**
 * The always-on loop: refresh positions, evaluate confirmed watches, manage incidents, emit alerts.
 * Channels (WebSocket, Telegram, CLI) subscribe to "alert" and "snapshot" events.
 */
export class Brain extends EventEmitter {
  readonly portfolio: Portfolio;
  readonly scenario: Scenario;
  prefs: PlannerPrefs = DEFAULT_PREFS;
  last: SnapshotWithDetail | null = null;
  /** Set when the NEAR AI agent is running: judges how serious an alert is from the numbers. */
  severityJudge: ((facts: Record<string, unknown>) => Promise<SeverityJudgment | null>) | null = null;
  lastEvaluations: Evaluation[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private nearLimit = false;
  private ticking: Promise<TickResult> | null = null;
  private conn: Connections;
  /** One-time links to the local page where you connect a wallet; the API serves them on this port. */
  readonly connectLinks = new ConnectLinks();
  apiPort = 0;
  /** When the MetaMask Snap last called in: it's installed and running. */
  snapSeenAt: number | null = null;

  constructor(readonly store: Store) {
    super();
    const saved = store.kvGet<Partial<Connections>>("connections");
    this.conn = { wallets: saved?.wallets ?? NO_CONNECTIONS.wallets, transactionSafety: saved?.transactionSafety ?? NO_CONNECTIONS.transactionSafety };
    // Rules from the old demo portfolio go: every rule here is about your own wallets.
    for (const w of store.listWatches().filter((x) => (x.source as string) === "demo")) store.deleteWatch(w.id);
    this.portfolio = new Portfolio(() => this.wallets);
    this.scenario = new Scenario(store);
    this.ensureSystemWatches();
  }

  // ---- What's connected ----

  get connections(): Connections {
    return this.conn;
  }

  /** The wallets Nierwall watches: the ones you added. */
  get wallets(): WalletsConfig {
    return { wallets: this.conn.wallets };
  }

  /**
   * Adds a wallet: a NEAR account (it must exist) or a 0x address. Typed in, it's only read. Connected through its
   * wallet app (`via`: a NEAR wallet, or MetaMask), Nierwall can also send it transactions to approve; connecting an
   * address you already added upgrades it. Nierwall only ever has the address.
   */
  async addWallet(input: { address: string; label?: string; via?: string; networks?: EvmNetwork[] }): Promise<Wallet> {
    const parsed = parseAddress(input.address);
    if ("error" in parsed) throw new Error(parsed.error);
    const via = input.via ?? "typed";
    const taken = this.wallets.wallets.map((w) => w.label);
    const existing = this.conn.wallets.find((w) => w.chain === parsed.chain && w.address.toLowerCase() === parsed.address.toLowerCase());
    if (existing) {
      if (via === "typed" || existing.via === via) return existing;
      const upgraded: Wallet = { ...existing, via };
      this.conn = { ...this.conn, wallets: this.conn.wallets.map((w) => (w === existing ? upgraded : w)) };
      this.store.addEvent("wallet_connected", { label: upgraded.label, chain: upgraded.chain, via });
      this.connectionsChanged();
      return upgraded;
    }
    if (this.conn.wallets.length >= MAX_WALLETS) throw new Error(`Nierwall watches up to ${MAX_WALLETS} wallets. Remove one first.`);
    if (parsed.chain === "near" && !(await nearAccountExists(parsed.address))) throw new Error(`There's no NEAR account called ${parsed.address}.`);
    const label = input.label?.trim().slice(0, 40) || defaultLabel(parsed.chain, taken);
    if (taken.some((t) => t.toLowerCase() === label.toLowerCase())) throw new Error(`You already have a wallet called "${label}". Pick another name.`);
    const wallet: Wallet = { label, chain: parsed.chain, address: parsed.address, role: "", via, ...(input.networks ? { networks: input.networks } : {}) };
    this.conn = { ...this.conn, wallets: [...this.conn.wallets, wallet] };
    this.store.addEvent("wallet_connected", { label, chain: wallet.chain, via: wallet.via });
    this.connectionsChanged();
    return wallet;
  }

  removeWallet(label: string): boolean {
    const wallets = this.conn.wallets.filter((w) => w.label.toLowerCase() !== label.toLowerCase());
    if (wallets.length === this.conn.wallets.length) return false;
    this.conn = { ...this.conn, wallets };
    this.store.addEvent("wallet_removed", { label });
    this.connectionsChanged();
    return true;
  }

  /** Turns transaction safety on or off. */
  setFeatures(features: { transactionSafety?: boolean }): Connections {
    this.conn = { ...this.conn, ...Object.fromEntries(Object.entries(features).filter(([, v]) => typeof v === "boolean")) };
    this.connectionsChanged();
    return this.conn;
  }

  /** A one-time link to the local page where the user connects a NEAR wallet (Meteor or another) or MetaMask in their browser. */
  connectLink(): string {
    return `http://127.0.0.1:${this.apiPort}/connect/${this.connectLinks.create()}`;
  }

  private connectionsChanged() {
    this.store.kvSet("connections", this.conn);
    this.portfolio.forgetHoldings();
    this.emit("connections", this.conn);
    if (this.running) void this.refreshNow().catch((e) => log.warn("refresh after a connection change failed", { err: String(e).slice(0, 120) }));
  }

  private ensureSystemWatches() {
    if (!this.store.listWatches().some((w) => w.kind === "data_stale")) {
      this.store.newWatch({ kind: "data_stale", label: "Data sources stop answering", params: {}, source: "system", status: "active" });
    }
  }

  /** One refresh-and-evaluate cycle. Concurrent callers share the in-flight tick. */
  tick(): Promise<TickResult> {
    if (!this.ticking) this.ticking = this.runTick().finally(() => (this.ticking = null));
    return this.ticking;
  }

  /** A refresh that reflects changes made just now (scenario, new watch): waits out any in-flight tick first. */
  async refreshNow(): Promise<TickResult> {
    if (this.ticking) await this.ticking.catch(() => undefined);
    this.portfolio.forgetHoldings();
    return this.tick();
  }

  private async runTick(): Promise<TickResult> {
    const active = this.store.listWatches("active");
    const coinIds = active.flatMap((w) => ((w.params as Record<string, unknown>).coinId ? [String((w.params as Record<string, unknown>).coinId)] : []));
    const withAllocation = active.some((w) => w.kind === "allocation_min" || w.kind === "allocation_max");
    const data = await this.portfolio.refresh(this.scenario.get(), coinIds, withAllocation);
    this.last = data;
    this.store.saveSnapshot(data.snapshot);
    this.emit("snapshot", data.snapshot);
    // A rule about one wallet only applies while that wallet is watched: one you removed is skipped.
    const watched = new Set(this.wallets.wallets.map((w) => w.label));
    const evaluations = this.store.listWatches("active")
      .filter((w) => { const label = (w.params as Record<string, unknown>).walletLabel; return label == null || watched.has(String(label)); })
      .map((w) => evaluate(w, data.snapshot));
    this.lastEvaluations = evaluations;
    this.nearLimit = evaluations.some(isNearLimit);
    const alerts: Alert[] = [];
    for (const e of evaluations) {
      const a = await this.handle(e, data).catch((err) => {
        log.error("incident handling failed", { watch: e.watch.id, err: String(err).slice(0, 200) });
        return null;
      });
      if (a) alerts.push(a);
    }
    return { data, evaluations, alerts };
  }

  private async handle(e: Evaluation, data: SnapshotWithDetail): Promise<Alert | null> {
    const now = new Date().toISOString();
    const open = this.store.openIncidentFor(e.watch.id);
    const simulated = !!data.snapshot.scenario;

    if (e.unknown) return null; // the data_stale watch reports missing data; never resolve on unknown

    if (e.triggered) {
      if (!open) {
        const j = await this.judge(e, data);
        const inc: Incident = {
          id: randomUUID(), watchId: e.watch.id, state: "open", severity: j.severity, title: e.title, detail: e.detail,
          value: e.value, firstSeen: now, lastSeen: now, snoozedUntil: null, acknowledged: false, simulated,
        };
        this.store.saveIncident(inc);
        this.store.kvSet(`judged:${inc.id}`, now);
        this.store.addEvent("incident_opened", { watch: e.watch.label, title: e.title, severity: j.severity, value: e.value, simulated });
        return this.alertFor(inc, e, data, "new", j.reason);
      }
      // Re-judge an open warning when the rule says critical, or every half hour.
      const lastJudged = this.store.kvGet<string>(`judged:${open.id}`);
      const due = open.severity !== "critical" && (e.severity === "critical" || !lastJudged || Date.now() - Date.parse(lastJudged) > REJUDGE_MS);
      const j = due ? await this.judge(e, data) : null;
      if (due) this.store.kvSet(`judged:${open.id}`, now);
      const escalated = open.severity !== "critical" && j?.severity === "critical";
      const updated: Incident = { ...open, lastSeen: now, value: e.value, title: e.title, detail: e.detail, severity: escalated ? "critical" : open.severity };
      this.store.saveIncident(updated);
      if (open.snoozedUntil && open.snoozedUntil > now && !escalated) return null;
      if (escalated) return this.alertFor(updated, e, data, "escalated", j?.reason ?? null);
      const lastAlertAt = this.store.kvGet<string>(`lastAlert:${open.id}`);
      if (updated.severity === "critical" && !updated.acknowledged && (!lastAlertAt || Date.now() - Date.parse(lastAlertAt) > REMIND_CRITICAL_MS)) {
        return this.alertFor(updated, e, data, "reminder");
      }
      return null;
    }

    if (open && e.recovered) {
      const resolved: Incident = { ...open, state: "resolved", lastSeen: now, value: e.value, detail: e.detail };
      this.store.saveIncident(resolved);
      this.store.addEvent("incident_resolved", { watch: e.watch.label, value: e.value, simulated });
      const alert: Alert = {
        id: randomUUID(), incidentId: open.id, createdAt: now, severity: "info",
        title: `Back to normal: ${e.watch.label}`, body: e.detail, fixes: [], simulated,
      };
      this.store.saveAlert(alert);
      this.emit("alert", alert);
      return alert;
    }
    if (open) this.store.saveIncident({ ...open, lastSeen: now, value: e.value });
    return null;
  }

  /** How serious this is: the AI's call from the numbers (10-second limit), else the fixed rule. Hard rails always apply. */
  private async judge(e: Evaluation, data: SnapshotWithDetail): Promise<{ severity: Severity; reason: string | null }> {
    if (!this.severityJudge || e.watch.kind === "data_stale") return combineSeverity(e, null);
    const p = e.watch.params as Record<string, unknown>;
    const pos = data.snapshot.positions.find((x) => x.id === p.positionId);
    const main = pos?.collateral.slice().sort((a, b) => b.usd - a.usd)[0]?.symbol.toUpperCase() ?? "";
    const mainCoin = main.includes("BTC") ? "bitcoin" : main.includes("ETH") ? "ethereum" : main.includes("NEAR") ? "near" : null;
    const [coins, vol] = await Promise.all([
      coinPrices(["ethereum", "near", "bitcoin"]).catch(() => ({}) as Record<string, { change24h: number | null }>),
      mainCoin ? volatility(mainCoin).catch(() => null) : Promise.resolve(null),
    ]);
    const facts = {
      alert: e.title,
      detail: e.detail,
      value: e.value,
      floor: p.threshold ?? null,
      loan: pos ? { health: pos.healthFactor, liquidationDropPct: pos.liquidationDistance == null ? null : Number((pos.liquidationDistance * 100).toFixed(1)), collateralUsd: Math.round(pos.collateralUsd), debtUsd: Math.round(pos.debtUsd), mainCollateral: main } : null,
      mainCollateral90d: vol,
      market24hPct: { ETH: coins.ethereum?.change24h ?? null, NEAR: coins.near?.change24h ?? null, BTC: coins.bitcoin?.change24h ?? null },
      simulated: !!data.snapshot.scenario,
    };
    const judged = await Promise.race([
      this.severityJudge(facts).catch((err) => {
        log.warn("severity judge failed; using the rule", { err: String(err).slice(0, 120) });
        return null;
      }),
      new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
    ]);
    return combineSeverity(e, judged);
  }

  private async alertFor(inc: Incident, e: Evaluation, data: SnapshotWithDetail, why: "new" | "escalated" | "reminder", reason: string | null = null): Promise<Alert> {
    const fixes = await fixesFor(e.watch, data, this.wallets, this.prefs, inc.severity === "critical").catch((err) => {
      log.warn("planner failed", { err: String(err).slice(0, 160) });
      return [];
    });
    this.rememberFixes(fixes);
    const label = scenarioLabel(data.snapshot.scenario);
    const prefix = why === "escalated" ? "Getting worse: " : why === "reminder" ? "Still open: " : "";
    const alert: Alert = {
      id: randomUUID(),
      incidentId: inc.id,
      createdAt: new Date().toISOString(),
      severity: inc.severity,
      title: `${label ? `[${label}] ` : ""}${prefix}${e.title}`,
      body: reason ? `${e.detail} ${reason}` : e.detail,
      fixes,
      simulated: inc.simulated,
    };
    this.store.saveAlert(alert);
    this.store.kvSet(`lastAlert:${inc.id}`, alert.createdAt);
    this.emit("alert", alert);
    return alert;
  }

  /** Keeps fix options addressable by id for the review screen (they expire with the session). */
  rememberFixes(fixes: Alert["fixes"]) {
    for (const f of fixes) this.store.kvSet(`fix:${f.id}`, f);
  }

  snooze(incidentId: string, minutes: number) {
    const inc = this.store.getIncident(incidentId);
    if (!inc) return null;
    return this.store.saveIncident({ ...inc, snoozedUntil: new Date(Date.now() + minutes * 60_000).toISOString() });
  }

  acknowledge(incidentId: string) {
    const inc = this.store.getIncident(incidentId);
    if (!inc) return null;
    return this.store.saveIncident({ ...inc, acknowledged: true });
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (err) {
        log.error("tick failed", { err: String(err).slice(0, 200) });
      }
      if (this.running) this.timer = setTimeout(loop, this.nearLimit ? 20_000 : 60_000);
    };
    void loop();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * The last snapshot, with only the wallets you have now: a saved one from before a restart, or a wallet you just
   * removed, never shows a loan or balance that isn't yours any more.
   */
  latestSnapshot(): Snapshot | null {
    const s = this.last?.snapshot ?? this.store.latestSnapshot();
    if (!s) return null;
    const watched = new Set(this.wallets.wallets.map((w) => w.label));
    return { ...s, positions: s.positions.filter((p) => watched.has(p.walletLabel)), balances: s.balances.filter((x) => watched.has(x.walletLabel)) };
  }
}
