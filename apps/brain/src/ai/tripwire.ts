import { english } from "viem/accounts";

const WORDS = new Set(english);

/**
 * Detects secrets before any text leaves the Mac: BIP-39 seed phrases (12-24 wordlist words in a row),
 * EVM private keys (64 hex chars), and NEAR secret keys (ed25519:<base58>). Returns a reason or null.
 */
export function detectSecret(text: string): string | null {
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  let run = 0;
  let longest = 0;
  for (const w of words) {
    run = WORDS.has(w) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  if (longest >= 12) return "seed phrase";
  if (/(^|[^0-9a-f])(0x)?[0-9a-f]{64}([^0-9a-f]|$)/i.test(text)) return "private key";
  if (/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/.test(text)) return "NEAR secret key";
  return null;
}

export const TRIPWIRE_REPLY =
  "That looks like a secret key or seed phrase, so I didn't send it anywhere. Nierwall never needs one. " +
  "If you shared it somewhere else, move those funds to a fresh wallet.";
