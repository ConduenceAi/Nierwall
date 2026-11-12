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
  NEAR_RPC_URL: z.string().url().default("https://rpc.mainnet.near.org"),
  BASE_RPC_URL: z.string().url().default("https://base-rpc.publicnode.com"),
  SCENARIO_MODE: z.string().default("1"),
  GUARDIAN_DATA_DIR: z.string().optional(),
  ONECLICK_JWT: z.string().default(""),
});

export const env = Env.parse(process.env);
export const DATA_DIR = resolve(ROOT, env.GUARDIAN_DATA_DIR ?? "data");
mkdirSync(DATA_DIR, { recursive: true });

export const Chain = z.enum(["base", "near"]);
export type Chain = z.infer<typeof Chain>;

export const WalletSchema = z.object({
  label: z.string().min(1),
  chain: Chain,
  address: z.string().min(2),
  role: z.string().default(""),
});
export type Wallet = z.infer<typeof WalletSchema>;

const WalletsFile = z.object({
  wallets: z.array(WalletSchema),
  /** Labels of wallets whose Aave V3 (Base) position should be watched. */
  watchAave: z.array(z.string()).default([]),
  /** Labels of wallets whose Rhea (NEAR) position should be watched. */
  watchRhea: z.array(z.string()).default([]),
});
export type WalletsConfig = z.infer<typeof WalletsFile>;

/**
 * Public on-chain accounts used read-only when no config/wallets.json exists, so the demo and
 * tests run against real positions. They are not the user's wallets and are labeled as such.
 */
export const FIXTURE_WALLETS: WalletsConfig = {
  wallets: [
    { label: "Demo Base wallet", chain: "base", address: "0xABBEa473fdDE4409C6A1F0c7C527C1bDa68E6C24", role: "public account, read-only demo fixture" },
    { label: "Demo NEAR wallet", chain: "near", address: "luckyjacket2695.near", role: "public account, read-only demo fixture" },
    // A public USDC holder on Base (Aave's aUSDC reserve), so the demo can show a cross-chain NEAR Intents fix.
    { label: "Demo cash wallet", chain: "base", address: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB", role: "public account, read-only demo fixture" },
  ],
  watchAave: ["Demo Base wallet"],
  watchRhea: ["Demo NEAR wallet"],
};

export function loadWallets(): { config: WalletsConfig; source: "user" | "fixtures" } {
  const path = process.env.GUARDIAN_WALLETS_FILE ? resolve(ROOT, process.env.GUARDIAN_WALLETS_FILE) : resolve(ROOT, "config/wallets.json");
  if (!existsSync(path)) return { config: FIXTURE_WALLETS, source: "fixtures" };
  const parsed = WalletsFile.parse(JSON.parse(readFileSync(path, "utf8")));
  return { config: parsed, source: "user" };
}

export const ADDRESSES = {
  base: {
    aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    weth: "0x4200000000000000000000000000000000000006",
  },
  near: {
    rhea: "contract.main.burrow.near",
    usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    wnear: "wrap.near",
  },
  intents: {
    baseUsdc: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    nearUsdc: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  },
} as const;
