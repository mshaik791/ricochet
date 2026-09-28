import Anthropic from "@anthropic-ai/sdk";
import type { Composer, ComposeContext, ComposeResult } from "../engine/composer.js";
import { shortVehicle, splitSubject } from "../engine/composer.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";

export interface AnthropicComposerOptions { apiKey: string; model: string; client?: Anthropic }

export class AnthropicComposer implements Composer {
  private readonly client: Anthropic;
  constructor(private readonly o: AnthropicComposerOptions) {
    this.client = o.client ?? new Anthropic({ apiKey: o.apiKey, timeout: 30_000, maxRetries: 1 });
  }
  async compose(ctx: ComposeContext): Promise<ComposeResult> {
    const res = await this.client.messages.create({
      model: this.o.model,
      max_tokens: 1024,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "low" },
      messages: [{ role: "user", content: buildUserPrompt(ctx) }],
    });
    if (res.stop_reason === "refusal") throw new Error("anthropic: refusal");
    const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("").trim();
    if (!text) throw new Error("anthropic: empty draft");
    return ctx.channel === "email" ? splitSubject(text, `Your ${shortVehicle(ctx.vehicle)} question`) : { body: text.replace(/^subject:.*\n+/i, "").trim() };
  }
}
