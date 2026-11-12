import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "./config.js";
import type { Alert, Incident, Snapshot, Watch } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, params TEXT NOT NULL,
  status TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, confirmed_at TEXT
);
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY, watch_id TEXT NOT NULL, state TEXT NOT NULL, severity TEXT NOT NULL,
  title TEXT NOT NULL, detail TEXT NOT NULL, value REAL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  snoozed_until TEXT, acknowledged INTEGER NOT NULL DEFAULT 0, simulated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS incidents_watch ON incidents(watch_id, state);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, taken_at TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL,
  remembered INTEGER NOT NULL DEFAULT 0
);
`;

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? null : String(v));

function rowToWatch(r: Row): Watch {
  return {
    id: String(r.id),
    kind: String(r.kind) as Watch["kind"],
    label: String(r.label),
    params: JSON.parse(String(r.params)),
    status: String(r.status) as Watch["status"],
    source: String(r.source) as Watch["source"],
    createdAt: String(r.created_at),
    confirmedAt: str(r.confirmed_at),
  };
}

function rowToIncident(r: Row): Incident {
  return {
    id: String(r.id),
    watchId: String(r.watch_id),
    state: String(r.state) as Incident["state"],
    severity: String(r.severity) as Incident["severity"],
    title: String(r.title),
    detail: String(r.detail),
    value: r.value == null ? null : Number(r.value),
    firstSeen: String(r.first_seen),
    lastSeen: String(r.last_seen),
    snoozedUntil: str(r.snoozed_until),
    acknowledged: Number(r.acknowledged) === 1,
    simulated: Number(r.simulated) === 1,
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path = resolve(DATA_DIR, "guardian.sqlite")) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  // ---- key/value ----
  kvGet<T>(key: string): T | null {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as Row | undefined;
    return r ? (JSON.parse(String(r.value)) as T) : null;
  }
  kvSet(key: string, value: unknown) {
    this.db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }
  kvDelete(key: string) {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }

  // ---- watches ----
  saveWatch(w: Watch) {
    this.db
      .prepare(
        `INSERT INTO watches(id, kind, label, params, status, source, created_at, confirmed_at) VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, label=excluded.label, params=excluded.params, status=excluded.status,
         source=excluded.source, confirmed_at=excluded.confirmed_at`,
      )
      .run(w.id, w.kind, w.label, JSON.stringify(w.params), w.status, w.source, w.createdAt, w.confirmedAt);
    return w;
  }
  newWatch(input: Omit<Watch, "id" | "createdAt" | "confirmedAt" | "status"> & { status?: Watch["status"] }): Watch {
    const now = new Date().toISOString();
    const status = input.status ?? "proposed";
    return this.saveWatch({ ...input, id: randomUUID(), status, createdAt: now, confirmedAt: status === "active" ? now : null });
  }
  getWatch(id: string) {
    const r = this.db.prepare("SELECT * FROM watches WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToWatch(r) : null;
  }
  listWatches(status?: Watch["status"]) {
    const rows = (status
      ? this.db.prepare("SELECT * FROM watches WHERE status = ? ORDER BY created_at").all(status)
      : this.db.prepare("SELECT * FROM watches ORDER BY created_at").all()) as Row[];
    return rows.map(rowToWatch);
  }
  confirmWatch(id: string) {
    const w = this.getWatch(id);
    if (!w) return null;
    return this.saveWatch({ ...w, status: "active", confirmedAt: new Date().toISOString() });
  }
  deleteWatch(id: string) {
    this.db.prepare("DELETE FROM watches WHERE id = ?").run(id);
  }

  // ---- incidents ----
  openIncidentFor(watchId: string) {
    const r = this.db.prepare("SELECT * FROM incidents WHERE watch_id = ? AND state = 'open' ORDER BY first_seen DESC LIMIT 1").get(watchId) as Row | undefined;
    return r ? rowToIncident(r) : null;
  }
  getIncident(id: string) {
    const r = this.db.prepare("SELECT * FROM incidents WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToIncident(r) : null;
  }
  saveIncident(i: Incident) {
    this.db
      .prepare(
        `INSERT INTO incidents(id, watch_id, state, severity, title, detail, value, first_seen, last_seen, snoozed_until, acknowledged, simulated)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET state=excluded.state, severity=excluded.severity, title=excluded.title, detail=excluded.detail,
         value=excluded.value, last_seen=excluded.last_seen, snoozed_until=excluded.snoozed_until, acknowledged=excluded.acknowledged`,
      )
      .run(i.id, i.watchId, i.state, i.severity, i.title, i.detail, i.value, i.firstSeen, i.lastSeen, i.snoozedUntil, i.acknowledged ? 1 : 0, i.simulated ? 1 : 0);
    return i;
  }
  listIncidents(state?: Incident["state"], limit = 50) {
    const rows = (state
      ? this.db.prepare("SELECT * FROM incidents WHERE state = ? ORDER BY last_seen DESC LIMIT ?").all(state, limit)
      : this.db.prepare("SELECT * FROM incidents ORDER BY last_seen DESC LIMIT ?").all(limit)) as Row[];
    return rows.map(rowToIncident);
  }

  // ---- alerts ----
  saveAlert(a: Alert) {
    this.db.prepare("INSERT OR REPLACE INTO alerts(id, incident_id, created_at, json) VALUES(?,?,?,?)").run(a.id, a.incidentId, a.createdAt, JSON.stringify(a));
    return a;
  }
  getAlert(id: string) {
    const r = this.db.prepare("SELECT json FROM alerts WHERE id = ?").get(id) as Row | undefined;
    return r ? (JSON.parse(String(r.json)) as Alert) : null;
  }
  listAlerts(limit = 20) {
    const rows = this.db.prepare("SELECT json FROM alerts ORDER BY created_at DESC LIMIT ?").all(limit) as Row[];
    return rows.map((r) => JSON.parse(String(r.json)) as Alert);
  }

  // ---- snapshots ----
  saveSnapshot(s: Snapshot) {
    this.db.prepare("INSERT INTO snapshots(taken_at, json) VALUES(?, ?)").run(s.takenAt, JSON.stringify(s));
    this.db.prepare("DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT 500)").run();
  }
  latestSnapshot(): Snapshot | null {
    const r = this.db.prepare("SELECT json FROM snapshots ORDER BY id DESC LIMIT 1").get() as Row | undefined;
    return r ? (JSON.parse(String(r.json)) as Snapshot) : null;
  }

  // ---- events (structured, later written to memory) ----
  addEvent(type: string, data: Record<string, unknown>) {
    this.db.prepare("INSERT INTO events(at, type, json) VALUES(?, ?, ?)").run(new Date().toISOString(), type, JSON.stringify(data));
  }
  unrememberedEvents(limit = 20) {
    return (this.db.prepare("SELECT * FROM events WHERE remembered = 0 ORDER BY id LIMIT ?").all(limit) as Row[]).map((r) => ({
      id: Number(r.id),
      at: String(r.at),
      type: String(r.type),
      data: JSON.parse(String(r.json)) as Record<string, unknown>,
    }));
  }
  markRemembered(ids: number[]) {
    const stmt = this.db.prepare("UPDATE events SET remembered = 1 WHERE id = ?");
    for (const id of ids) stmt.run(id);
  }
}
