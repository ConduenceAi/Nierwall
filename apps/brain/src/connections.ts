import { randomBytes } from "node:crypto";
import { getAddress, isAddress } from "viem";
import { env, type Wallet } from "./config.js";

/**
 * What the user has connected: the wallets Nierwall watches, and the features they turned on. Everything starts
 * empty and off, and only what the user adds or turns on is used.
 */
export interface Connections {
  wallets: Wallet[];
  /** Public read-only demo accounts, to try Nierwall before connecting a wallet. Ignored once one is connected. */
  demo: boolean;
  /** Answer the MetaMask Snap's checks before you sign. */
  transactionSafety: boolean;
}

export const NO_CONNECTIONS: Connections = { wallets: [], demo: false, transactionSafety: false };

/** At most this many wallets, so the reads per minute stay reasonable. */
export const MAX_WALLETS = 10;

const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** Reads an address and says which kind of wallet it is: a 0x address (EVM) or a NEAR account. */
export function parseAddress(raw: string): { chain: "evm" | "near"; address: string } | { error: string } {
  const a = raw.trim().replace(/[.,;!?]+$/, "");
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) {
    return isAddress(a, { strict: false }) ? { chain: "evm", address: getAddress(a.toLowerCase()) } : { error: "That 0x address has a typo (its checksum doesn't match)." };
  }
  const near = a.toLowerCase();
  if (NEAR_ACCOUNT.test(near) && (near.includes(".") || /^[0-9a-f]{64}$/.test(near))) return { chain: "near", address: near };
  return { error: "That isn't a NEAR account (like you.near) or a 0x address." };
}

/** Whether a NEAR account exists, asked of the NEAR node. EVM addresses always exist. */
export async function nearAccountExists(account: string): Promise<boolean> {
  const res = await fetch(env.NEAR_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "query", params: { request_type: "view_account", finality: "final", account_id: account } }),
  });
  const j = (await res.json()) as { result?: unknown; error?: { cause?: { name?: string } } };
  if (j.result) return true;
  if (j.error?.cause?.name === "UNKNOWN_ACCOUNT") return false;
  throw new Error("The NEAR node didn't answer; try again in a moment.");
}

/** A free nickname: "NEAR wallet", then "NEAR wallet 2"… */
export function defaultLabel(chain: "evm" | "near", taken: string[]): string {
  const base = chain === "near" ? "NEAR wallet" : "EVM wallet";
  const used = new Set(taken.map((t) => t.toLowerCase()));
  for (let n = 1; ; n++) {
    const label = n === 1 ? base : `${base} ${n}`;
    if (!used.has(label.toLowerCase())) return label;
  }
}

/** The wallet app a wallet was connected through, for people: "Meteor", "MetaMask". */
export function walletAppName(via: string | undefined): string | null {
  if (!via || via === "typed") return null;
  const known: Record<string, string> = { "meteor-wallet": "Meteor", metamask: "MetaMask", "hot-wallet": "HOT", "intear-wallet": "Intear", mynearwallet: "MyNearWallet" };
  return known[via] ?? via;
}

/** Addresses and NEAR account names in text become "[address]", so they never reach the memory service. */
export function redactAddresses(text: string): string {
  return text
    .replace(/\b0x[0-9a-fA-F]{40}\b/g, "[address]")
    .replace(/\b[0-9a-f]{64}\b/g, "[address]")
    .replace(/\b(([a-z\d]+[-_])*[a-z\d]+\.)+(near|tg)\b/gi, "[address]");
}

/**
 * One-time links to the local connect page, valid 15 minutes. The page only ever sends back an address: it can't
 * sign, and nothing else can use the link.
 */
export class ConnectLinks {
  private links = new Map<string, number>();

  create(): string {
    const token = randomBytes(18).toString("base64url");
    this.links.set(token, Date.now() + 15 * 60_000);
    return token;
  }

  valid(token: string): boolean {
    const until = this.links.get(token);
    if (until && until > Date.now()) return true;
    this.links.delete(token);
    return false;
  }
}
