import { FallbackAssistant, type Assistant } from "./ai/assistant.js";
import { alertCards } from "./ai/cards.js";
import { startApi } from "./api/server.js";
import { Brain } from "./brain.js";
import { env, loadWallets } from "./config.js";
import { logger } from "./log.js";
import { writeRuntimeInfo } from "./runtime.js";
import { Store } from "./store.js";
import { TelegramBot } from "./telegram/bot.js";
import { SignSessions } from "./sign/sessions.js";
import { registerSignRoutes } from "./sign/routes.js";
import { registerSnapRoutes } from "./snap/routes.js";

const log = logger("main");

async function main() {
  const store = new Store();
  const { config, source } = loadWallets();
  log.info("wallets loaded", { source, wallets: config.wallets.map((w) => w.label) });
  const brain = new Brain(store, config);

  // The NEAR AI agent replaces this once NEAR_AI_API_KEY is set (wired in ai/agent.ts).
  let assistant: Assistant = new FallbackAssistant(brain);
  try {
    const { createAssistant } = await import("./ai/agent.js");
    assistant = (await createAssistant(brain)) ?? assistant;
  } catch (e) {
    log.warn("NEAR AI agent unavailable, using deterministic answers", { err: String(e).slice(0, 160) });
  }

  const runtime = writeRuntimeInfo(env.GUARDIAN_PORT);
  const extend: Array<(app: import("hono").Hono) => void> = [];
  let api: ReturnType<typeof startApi> | null = null;
  const sessions = new SignSessions(brain, (s) => api?.broadcast({ type: "sign", session: s } as any));
  extend.push((app) => registerSignRoutes(app, brain, sessions, runtime.port));
  extend.push((app) => registerSnapRoutes(app, brain, () => sessions.pendingDeposits()));
  const telegram = TelegramBot.fromEnv(brain, assistant, (alertId) => {
    if (!api || api.clientCount() === 0) return false;
    api.broadcast({ type: "review", alertId });
    return true;
  });
  api = startApi({ brain, assistant, token: runtime.token, port: runtime.port, telegram: telegram ?? undefined, extend });

  brain.on("alert", (a) => {
    api?.broadcast({ type: "alert", alert: alertCards(a), raw: a });
    void telegram?.sendAlert(a);
    log.info("alert", { severity: a.severity, title: a.title, fixes: a.fixes.length });
  });
  brain.on("snapshot", (snapshot) => api?.broadcast({ type: "snapshot", snapshot }));

  if (telegram) await telegram.start().catch((e) => log.warn("Telegram failed to start", { err: String(e).slice(0, 160) }));
  else log.info("Telegram disabled (no TELEGRAM_BOT_TOKEN)");

  brain.start();
  log.info("Nierwall brain running", { port: runtime.port });

  const shutdown = () => {
    brain.stop();
    telegram?.stop();
    api?.server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log.error("fatal", { err: String(e) });
  process.exit(1);
});
