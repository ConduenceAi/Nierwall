import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { MEMORY_MAX_TOKENS, registerMemoryLlmRoutes, type MemoryCompletion, type MemoryModel } from "../src/memory/llm.js";

/** A stand-in for the NEAR AI agent that records what it was asked. */
function fakeModel(verified = true) {
  const calls: MemoryCompletion[] = [];
  const model: MemoryModel = {
    async memoryCompletion(req) {
      calls.push(req);
      return verified ? { id: "c1", model: "z-ai/glm-5.3-flash", content: '{"facts":[]}', finishReason: "stop" } : null;
    },
  };
  return { model, calls };
}

function post(app: Hono, body: unknown) {
  return app.request("/api/memory/llm/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("memory: model calls go to NEAR AI through the brain", () => {
  it("answers in the chat-completions shape Graphiti reads, from the verified model", async () => {
    const app = new Hono();
    const { model, calls } = fakeModel();
    registerMemoryLlmRoutes(app, model);
    const res = await post(app, {
      model: "near-ai",
      messages: [{ role: "system", content: "Extract entities." }, { role: "user", content: "Keep my Savings wallet above 1.5" }],
      temperature: 0,
      max_tokens: 16384,
      response_format: { type: "json_object" },
    });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.choices[0].message).toEqual({ role: "assistant", content: '{"facts":[]}' });
    expect(json.model).toBe("z-ai/glm-5.3-flash");
    // Graphiti's model name is ignored, the token limit is capped, and JSON mode is passed on.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.maxTokens).toBe(MEMORY_MAX_TOKENS);
    expect(calls[0]!.json).toBe(true);
  });

  it("takes addresses out before the model sees them", async () => {
    const app = new Hono();
    const { model, calls } = fakeModel();
    registerMemoryLlmRoutes(app, model);
    await post(app, { messages: [{ role: "user", content: "savings.near and 0xABBEa473fdDE4409C6A1F0c7C527C1bDa68E6C24 are mine" }] });
    expect(calls[0]!.messages[0]!.content).toBe("[address] and [address] are mine");
    expect(calls[0]!.json).toBe(false);
  });

  it("refuses tool messages and empty requests, without calling the model", async () => {
    const app = new Hono();
    const { model, calls } = fakeModel();
    registerMemoryLlmRoutes(app, model);
    expect((await post(app, { messages: [{ role: "tool", content: "{}" }] })).status).toBe(400);
    expect((await post(app, { messages: [] })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("says so when NEAR AI isn't set up or its attestation isn't verified", async () => {
    const none = new Hono();
    registerMemoryLlmRoutes(none, null);
    expect((await post(none, { messages: [{ role: "user", content: "hi" }] })).status).toBe(503);

    const unverified = new Hono();
    registerMemoryLlmRoutes(unverified, fakeModel(false).model);
    expect((await post(unverified, { messages: [{ role: "user", content: "hi" }] })).status).toBe(503);
  });
});
