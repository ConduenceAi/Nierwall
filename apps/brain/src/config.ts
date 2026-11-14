import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
/** Repository root (apps/brain/src -> repo). */
export const ROOT = resolve(here, "../../..");

const envFile = resolve(ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const Env = z.object({
  GUARDIAN_PORT: z.coerce.number().int().default(7420),
  GUARDIAN_TOKEN: z.string().default(""),
  NEAR_AI_BASE_URL: z.string().url().default("https://cloud-api.near.ai/v1"),
  NEAR_AI_API_KEY: z.string().default(""),
  NEAR_AI_MODEL: z.string().default("z-ai/glm-5.3-flash"),
  MEMORY_URL: z.string().default("http://127.0.0.1:7421"),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_DETAIL: z.enum(["generic", "actionable", "detailed"]).default("actionable"),
  NEAR_RPC_URL: z.string().url().default("https://free.rpc.fastnear.com"),
  /** Optional: your own Base node, tried before the built-in ones. Other networks: RPC_URL_<chain id>. */
  BASE_RPC_URL: z.union([z.literal(""), z.string().url()]).default(""),
  SCENARIO_MODE: z.string().default("1"),
  GUARDIAN_DATA_DIR: z.string().optional(),
  ONECLICK_JWT: z.string().default(""),
  COINGECKO_API_KEY: z.string().default(""),
  /** Stronger TEE model for planning questions (rebalancing, trades); everyday chat uses NEAR_AI_MODEL. */
  NEAR_AI_PLANNER_MODEL: z.string().default("deepseek-ai/DeepSeek-V4.1-Flash-1017"),
});

export const env = Env.parse(process.env);
export const DATA_DIR = resolve(ROOT, env.GUARDIAN_DATA_DIR ?? "data");
mkdirSync(DATA_DIR, { recursive: true });

/** The EVM networks NEAR Intents can move money on, by their NEAR Intents names. */
export const EVM_NETWORKS = ["eth", "base", "arb", "op", "pol", "bsc", "gnosis", "avax", "bera", "scroll"] as const;
export type EvmNetwork = (typeof EVM_NETWORKS)[number];
/** Where a token lives: NEAR, or one of the EVM networks. */
export type Network = EvmNetwork | "near";

/**
 * What kind of wallet: one NEAR account, or one EVM address, which is the same on every EVM network.
 * "base" is the old name for "evm" and still works in wallets.json.
 */
export const Chain = z.enum(["evm", "near", "base"]).transform((c): "evm" | "near" => (c === "base" ? "evm" : c));
export type Chain = z.output<typeof Chain>;

export const WalletSchema = z.object({
  label: z.string().min(1),
  chain: Chain,
  address: z.string().min(2),
  role: z.string().default(""),
  /** EVM wallets: the networks to read (default: all of them). Each network's node sees the address it's asked about. */
  networks: z.array(z.enum(EVM_NETWORKS)).min(1).optional(),
  /** The wallet app it was connected through ("meteor-wallet", "metamask"…), or "typed". */
  via: z.string().optional(),
});
export type Wallet = z.infer<typeof WalletSchema>;

/** Every NEAR wallet is also checked for a Rhea loan, so there's no separate list of loans to watch. */
const WalletsFile = z.object({ wallets: z.array(WalletSchema) });
export type WalletsConfig = z.infer<typeof WalletsFile>;

/**
 * Public on-chain accounts, read-only: for `pnpm demo`, the tests, and the app's demo accounts when the user turns
 * them on to try Nierwall before connecting a wallet. They are not the user's wallets and are labeled as such.
 */
export const FIXTURE_WALLETS: WalletsConfig = {
  wallets: [
    { label: "Demo EVM wallet", chain: "evm", address: "0xABBEa473fdDE4409C6A1F0c7C527C1bDa68E6C24", role: "public account, read-only demo fixture" },
    { label: "Demo NEAR wallet", chain: "near", address: "luckyjacket2695.near", role: "public account, read-only demo fixture" },
    // A public USDC holder on Base, so the demo can show a cross-chain NEAR Intents fix.
    { label: "Demo cash wallet", chain: "evm", address: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB", role: "public account, read-only demo fixture" },
  ],
};

/** Wallets from config/wallets.json, the older way to add them; the brain imports them once. Null when there's no file. */
export function walletsFile(): WalletsConfig | null {
  const path = process.env.GUARDIAN_WALLETS_FILE ? resolve(ROOT, process.env.GUARDIAN_WALLETS_FILE) : resolve(ROOT, "config/wallets.json");
  return existsSync(path) ? WalletsFile.parse(JSON.parse(readFileSync(path, "utf8"))) : null;
}

export const ADDRESSES = {
  near: {
    rhea: "contract.main.burrow.near",
    usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    wnear: "wrap.near",
  },
  intents: {
    nearUsdc: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  },
} as const;
