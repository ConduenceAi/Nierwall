import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { env } from "./config.js";

/** Where the Mac app finds the brain: ~/Library/Application Support/Guardian/brain.json (owner-only). */
export const APP_SUPPORT = join(homedir(), "Library", "Application Support", "Guardian");

export interface RuntimeInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

export function writeRuntimeInfo(port: number): RuntimeInfo {
  mkdirSync(APP_SUPPORT, { recursive: true });
  const token = env.GUARDIAN_TOKEN || randomBytes(24).toString("hex");
  const info: RuntimeInfo = { port, token, pid: process.pid, startedAt: new Date().toISOString() };
  const path = join(APP_SUPPORT, "brain.json");
  writeFileSync(path, JSON.stringify(info, null, 2));
  chmodSync(path, 0o600);
  return info;
}
