import type { Brain } from "../brain.js";
import type { Reply } from "./cards.js";
import { fallbackReply } from "./fallback.js";

export type Channel = "mac" | "telegram" | "cli";

export interface Assistant {
  reply(text: string, channel: Channel): Promise<Reply>;
  /** Attestation status of the model behind the assistant, for the "verified" badge. */
  attestation(): { model: string; verified: boolean; verifiedAt: string | null; detail: string };
}

/** Assistant that answers only from computed numbers. Used until a NEAR AI key is configured. */
export class FallbackAssistant implements Assistant {
  constructor(private brain: Brain) {}
  async reply(text: string): Promise<Reply> {
    return fallbackReply(this.brain, text);
  }
  attestation() {
    return { model: "none", verified: false, verifiedAt: null, detail: "No NEAR AI key configured; answers come from deterministic templates." };
  }
}
