import { randomBytes } from "node:crypto";
import type { Assistant } from "../ai/assistant.js";
import type { Brain } from "../brain.js";
import { env } from "../config.js";
import { logger } from "../log.js";
import type { Alert } from "../types.js";

const log = logger("telegram");

interface TgUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number; type: string }; text?: string; from?: { username?: string } };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
}
interface Linked {
  chatId: number;
  linkedAt: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Telegram bot over long polling (no public URL needed, works from your Mac).
 * Only a private chat linked through a one-time /start code receives alerts or can talk to Nierwall.
 * Buttons can open, snooze or explain. They never trade.
 */
export class TelegramBot {
  private offset = 0;
  private running = false;
  private username: string | null = null;

  constructor(
    private token: string,
    private brain: Brain,
    private assistant: Assistant,
    private onReview: (alertId: string) => boolean,
  ) {}

  static fromEnv(brain: Brain, assistant: Assistant, onReview: (alertId: string) => boolean) {
    return env.TELEGRAM_BOT_TOKEN ? new TelegramBot(env.TELEGRAM_BOT_TOKEN, brain, assistant, onReview) : null;
  }

  private async call<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json()) as { ok: boolean; result: T; description?: string; parameters?: { retry_after?: number } };
      if (j.ok) return j.result;
      if (res.status === 429 && j.parameters?.retry_after) {
        await new Promise((r) => setTimeout(r, (j.parameters!.retry_after! + 1) * 1000));
        continue;
      }
      throw new Error(`Telegram ${method} failed: ${res.status} ${j.description ?? ""}`);
    }
    throw new Error(`Telegram ${method} kept rate-limiting`);
  }

  linked(): boolean {
    return !!this.brain.store.kvGet<Linked>("telegram");
  }

  /** One-time deep link that links the private chat that opens it. Valid for 10 minutes. */
  async pairLink(): Promise<string | null> {
    if (!this.username) this.username = (await this.call<{ username: string }>("getMe")).username;
    const code = randomBytes(12).toString("base64url");
    this.brain.store.kvSet("telegramPair", { code, expires: Date.now() + 10 * 60_000 });
    return `https://t.me/${this.username}?start=${code}`;
  }

  async start() {
    const me = await this.call<{ username: string }>("getMe");
    this.username = me.username;
    await this.call("deleteWebhook", { drop_pending_updates: false });
    this.running = true;
    log.info("bot online", { bot: me.username, linked: this.linked() });
    void this.poll();
  }

  stop() {
    this.running = false;
  }

  private async poll() {
    while (this.running) {
      try {
        const updates = await this.call<TgUpdate[]>("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handle(u).catch((e) => log.warn("update failed", { err: String(e).slice(0, 160) }));
        }
      } catch (e) {
        log.warn("poll failed", { err: String(e).slice(0, 160) });
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async handle(u: TgUpdate) {
    const linked = this.brain.store.kvGet<Linked>("telegram");
    if (u.message?.text) {
      const { chat, text } = u.message;
      if (text.startsWith("/start")) {
        const code = text.split(" ")[1];
        const pending = this.brain.store.kvGet<{ code: string; expires: number }>("telegramPair");
        if (chat.type !== "private") return this.send(chat.id, "Nierwall only works in a private chat.");
        if (!code || !pending || pending.code !== code || pending.expires < Date.now()) {
          return this.send(chat.id, "This link has expired or was already used. Create a new one from the Nierwall app.");
        }
        this.brain.store.kvDelete("telegramPair");
        this.brain.store.kvSet("telegram", { chatId: chat.id, linkedAt: new Date().toISOString() } satisfies Linked);
        this.brain.store.addEvent("telegram_linked", {});
        return this.send(chat.id, "Linked. Nierwall will send alerts here. Telegram can read bot messages, so alerts use wallet nicknames and never addresses.");
      }
      if (!linked || linked.chatId !== chat.id) return; // ignore strangers
      const reply = await this.assistant.reply(text, "telegram");
      return this.send(chat.id, esc(reply.text));
    }
    if (u.callback_query) {
      const q = u.callback_query;
      if (!linked || q.message?.chat.id !== linked.chatId || !q.data) return this.call("answerCallbackQuery", { callback_query_id: q.id });
      const [kind, id] = q.data.split(":");
      let note = "";
      if (kind === "s" && id) {
        this.brain.snooze(id, 60);
        note = "Snoozed for 1 hour.";
      } else if (kind === "a" && id) {
        this.brain.acknowledge(id);
        note = "Got it. I'll stop reminding you.";
      } else if (kind === "r" && id) {
        note = this.onReview(id) ? "Opened on your Mac. Review and sign there." : "Your Mac app isn't connected. Open Nierwall on your Mac to review.";
      } else if (kind === "w" && id) {
        const alert = this.brain.store.getAlert(id);
        const reply = await this.assistant.reply(`Explain this alert briefly and what each option does: ${alert?.title}. ${alert?.body}`, "telegram");
        await this.send(linked.chatId, esc(reply.text));
      }
      await this.call("answerCallbackQuery", { callback_query_id: q.id, text: note || undefined });
    }
  }

  private async send(chatId: number, html: string, buttons?: Array<Array<{ text: string; callback_data: string }>>) {
    await this.call("sendMessage", {
      chat_id: chatId,
      text: html.slice(0, 4000),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
  }

  /** Sends an alert to the linked chat at the configured detail level. */
  async sendAlert(a: Alert) {
    const linked = this.brain.store.kvGet<Linked>("telegram");
    if (!linked) return;
    const detail = env.TELEGRAM_DETAIL;
    let text: string;
    if (detail === "generic") {
      text = a.severity === "info" ? "A Nierwall alert was resolved." : "A DeFi position needs your attention. Open Nierwall on your Mac.";
    } else {
      const head = `<b>${a.severity === "critical" ? "Critical" : a.severity === "warning" ? "Warning" : "Resolved"}: ${esc(a.title)}</b>`;
      const fixes = a.fixes
        .map((f) => `<b>${String.fromCharCode(64 + f.rank)}.</b> ${esc(f.title)}${f.healthAfter != null ? ` → health ${f.healthAfter.toFixed(2)}` : ""}${f.notes.length ? `\n   <i>${esc(f.notes[0]!)}</i>` : ""}`)
        .join("\n");
      text = [head, esc(a.body), fixes, a.fixes.length ? "<i>Estimates. Nothing moves until you review and sign.</i>" : ""].filter(Boolean).join("\n\n");
    }
    const buttons = a.severity === "info" ? undefined : [
      [{ text: "Review on Mac", callback_data: `r:${a.id}` }, { text: "Snooze 1h", callback_data: `s:${a.incidentId}` }],
      [{ text: "Why?", callback_data: `w:${a.id}` }, { text: "Got it", callback_data: `a:${a.incidentId}` }],
    ];
    await this.send(linked.chatId, text, buttons).catch((e) => log.warn("alert send failed", { err: String(e).slice(0, 160) }));
  }
}
