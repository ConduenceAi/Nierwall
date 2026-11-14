import { randomBytes } from "node:crypto";
import { getAddress, isAddress } from "viem";
import { env, type Wallet } from "./config.js";

/**
 * What the user has added: the wallets Nierwall watches, and the features they turned on. Everything starts empty
 * and off, and only what the user adds or turns on is used.
 */
export interface Connections {
  wallets: Wallet[];
  /** Answer the MetaMask Snap's checks before you sign. */
  transactionSafety: boolean;
}

export const NO_CONNECTIONS: Connections = { wallets: [], transactionSafety: false };

/**
 * A wallet connected through its wallet app (a NEAR wallet such as Meteor, or MetaMask for an EVM address) can be sent
 * transactions to approve. One added by address is only read.
 */
export function isConnected(w: Wallet): boolean {
  return !!w.via && !["typed", "config file"].includes(w.via);
}

/** Why Nierwall can't send a transaction from this wallet, for the AI and the user; null when it can. */
export function signBlocker(w: Wallet): string | null {
  if (isConnected(w)) return null;
  if (w.chain === "solana") return `${w.label} is a Solana wallet: Nierwall reads it but can't send from it. Use another wallet as the source.`;
  const how = w.chain === "near" ? "a NEAR wallet such as Meteor" : "MetaMask";
  return `${w.label} was added by address, so Nierwall only reads it. To send from it, the user connects it with ${how} (Connect a wallet in Nierwall).`;
}

/** At most this many wallets, so the reads per minute stay reasonable. */
export const MAX_WALLETS = 10;

const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A Solana address is 32 bytes written in base58 (32 to 44 characters). */
function isSolanaAddress(a: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return false;
  let n = 0n;
  for (const ch of a) n = n * 58n + BigInt(BASE58.indexOf(ch));
  // Each leading "1" is a zero byte; the rest is the number's own bytes.
  const leading = /^1*/.exec(a)![0].length;
  return leading + Math.ceil((n === 0n ? 0 : n.toString(16).length) / 2) === 32;
}

/** Reads an address and says which kind of wallet it is: a 0x address (EVM), a NEAR account, or a Solana address. */
export function parseAddress(raw: string): { chain: "evm" | "near" | "solana"; address: string } | { error: string } {
  const a = raw.trim().replace(/[.,;!?]+$/, "");
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) {
    return isAddress(a, { strict: false }) ? { chain: "evm", address: getAddress(a.toLowerCase()) } : { error: "That 0x address has a typo (its checksum doesn't match)." };
  }
  const near = a.toLowerCase();
  if (NEAR_ACCOUNT.test(near) && (near.includes(".") || /^[0-9a-f]{64}$/.test(near))) return { chain: "near", address: near };
  if (isSolanaAddress(a)) return { chain: "solana", address: a };
  return { error: "That isn't a NEAR account (like you.near), a 0x address or a Solana address." };
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
export function defaultLabel(chain: "evm" | "near" | "solana", taken: string[]): string {
  const base = chain === "near" ? "NEAR wallet" : chain === "solana" ? "Solana wallet" : "EVM wallet";
  const used = new Set(taken.map((t) => t.toLowerCase()));
  for (let n = 1; ; n++) {
    const label = n === 1 ? base : `${base} ${n}`;
    if (!used.has(label.toLowerCase())) return label;
  }
}

/** Wallet apps: NEAR wallets by their NEAR Connect id, and MetaMask for EVM addresses. */
const WALLET_APPS: Record<string, string> = {
  "meteor-wallet": "Meteor", "hot-wallet": "HOT", "intear-wallet": "Intear", mynearwallet: "MyNearWallet", ledger: "Ledger",
  "okx-wallet": "OKX Wallet", "near-mobile": "NEAR Mobile", "nightly-wallet": "Nightly", "hana-wallet": "Hana", "trezu-wallet": "Trezu",
  metamask: "MetaMask",
};

/** The wallet app a wallet was connected through, for people: "Meteor", "MetaMask". Null when it was added by address. */
export function walletAppName(via: string | undefined): string | null {
  if (!via || via === "typed" || via === "config file") return null;
  return WALLET_APPS[via] ?? via;
}

/** Addresses and NEAR account names in text become "[address]", so they never reach the memory service. */
export function redactAddresses(text: string): string {
  return text
    .replace(/\b0x[0-9a-fA-F]{40}\b/g, "[address]")
    .replace(/\b[0-9a-f]{64}\b/g, "[address]")
    .replace(/\b(([a-z\d]+[-_])*[a-z\d]+\.)+(near|tg)\b/gi, "[address]")
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, (m) => (isSolanaAddress(m) ? "[address]" : m));
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
