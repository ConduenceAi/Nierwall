import type { Hono } from "hono";
import { z } from "zod";
import { redactAddresses } from "../connections.js";

/**
 * The memory service's model calls (Graphiti pulling facts out of your own words) come here, on the brain's local
 * API, and go on to the same verified NEAR AI TEE model as the chat, encrypted end to end. So the memory needs no
 * key of its own and no outside AI service ever sees it.
 */
export interface MemoryModel {
  /** One plain completion, no tools. Null while the model's attestation isn't verified. */
  memoryCompletion(req: MemoryCompletion): Promise<{ id: string | null; model: string; content: string; finishReason: string | null } | null>;
}

export interface MemoryCompletion {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxTokens: number;
  temperature: number;
  /** Ask for a JSON object. The schema itself stays in the prompt, which is encrypted. */
  json: boolean;
}

/** OpenAI's chat-completions shape, as Graphiti sends it. Only messages and a few numbers are used. */
const Request = z.object({
  messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().max(100_000) })).min(1).max(20),
  max_tokens: z.number().int().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  response_format: z.object({ type: z.string() }).optional(),
});

export const MEMORY_MAX_TOKENS = 4096;

export function registerMemoryLlmRoutes(app: Hono, model: MemoryModel | null) {
  // Under /api/*, so it needs the brain's token like every other local caller.
  app.post("/api/memory/llm/chat/completions", async (c) => {
    if (!model) return c.json({ error: { message: "NEAR AI isn't set up (NEAR_AI_API_KEY), so memory can't pull out facts" } }, 503);
    const parsed = Request.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { message: "invalid request", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } }, 400);
    const body = parsed.data;
    const out = await model.memoryCompletion({
      // The brain already strips addresses before text reaches memory; this is the second lock on that door.
      messages: body.messages.map((m) => ({ role: m.role, content: redactAddresses(m.content) })),
      maxTokens: Math.min(body.max_tokens ?? MEMORY_MAX_TOKENS, MEMORY_MAX_TOKENS),
      temperature: Math.min(body.temperature ?? 0, 1),
      json: body.response_format?.type === "json_object" || body.response_format?.type === "json_schema",
    });
    if (!out) return c.json({ error: { message: "NEAR AI's attestation isn't verified right now" } }, 503);
    return c.json({
      id: out.id ?? `memory-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: out.model,
      choices: [{ index: 0, message: { role: "assistant", content: out.content }, finish_reason: out.finishReason ?? "stop" }],
    });
  });
}
