import { env } from "../config.js";
import { logger } from "../log.js";
import { redactAddresses } from "../connections.js";
import type { Store } from "../store.js";

const log = logger("memory");

export interface MemoryFact {
  uuid: string;
  fact: string;
  validAt: string | null;
  invalidAt: string | null;
  createdAt: string | null;
}

/**
 * Client for the local memory service (Graphiti, Zep's engine). Only two kinds of input are written:
 * the user's own messages and Nierwall's structured events. Text from outside (token names, memos,
 * websites) is never written, so it can't poison the memory.
 */
export class MemoryClient {
  constructor(private base = env.MEMORY_URL) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`memory ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  async health(): Promise<boolean> {
    return this.req<{ ok: boolean }>("/health").then((r) => r.ok).catch(() => false);
  }

  async search(query: string, limit = 8): Promise<MemoryFact[]> {
    return this.req<MemoryFact[]>("/search", { method: "POST", body: JSON.stringify({ query, limit }) });
  }

  async facts(limit = 50): Promise<MemoryFact[]> {
    return this.req<MemoryFact[]>(`/facts?limit=${limit}`);
  }

  async deleteFact(uuid: string) {
    return this.req<{ ok: boolean }>(`/facts/${encodeURIComponent(uuid)}`, { method: "DELETE" });
  }

  /** Queues ingestion; the service extracts facts in the background (several model calls). */
  async addUserMessage(text: string, channel: string) {
    return this.req("/episodes", {
      method: "POST",
      // Addresses never go to the memory service (or the model it uses): a wallet is remembered by its nickname.
      body: JSON.stringify({ name: `user message (${channel})`, type: "message", body: `user: ${redactAddresses(text)}`, source_description: `Nierwall ${channel} chat`, reference_time: new Date().toISOString() }),
    });
  }

  async addEvent(type: string, data: Record<string, unknown>, at: string) {
    return this.req("/episodes", {
      method: "POST",
      body: JSON.stringify({ name: `nierwall event: ${type}`, type: "json", body: JSON.stringify({ event: type, ...data }), source_description: "Nierwall structured event", reference_time: at }),
    });
  }

  /** Flushes structured events (incidents, confirmations, choices) from the store into memory. */
  async flushEvents(store: Store) {
    const events = store.unrememberedEvents(20);
    if (!events.length) return 0;
    const done: number[] = [];
    for (const e of events) {
      // Simulated incidents are not real history; don't teach the memory from them.
      if (e.data.simulated === true) {
        done.push(e.id);
        continue;
      }
      try {
        await this.addEvent(e.type, e.data, e.at);
        done.push(e.id);
      } catch (err) {
        log.warn("event not remembered", { type: e.type, err: String(err).slice(0, 120) });
        break;
      }
    }
    store.markRemembered(done);
    return done.length;
  }
}
