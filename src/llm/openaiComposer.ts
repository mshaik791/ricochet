import OpenAI from "openai";
import type { Composer, ComposeContext, ComposeResult } from "../engine/composer.js";
import { shortVehicle, splitSubject } from "../engine/composer.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";

export interface OpenAiComposerOptions { apiKey: string; model: string; client?: OpenAI }

export class OpenAiComposer implements Composer {
  private readonly client: OpenAI;
  constructor(private readonly o: OpenAiComposerOptions) {
    this.client = o.client ?? new OpenAI({ apiKey: o.apiKey, timeout: 20_000, maxRetries: 1 });
  }
  async compose(ctx: ComposeContext): Promise<ComposeResult> {
    const reasoning = /^(gpt-5|o\d)/i.test(this.o.model) ? { reasoning: { effort: "minimal" as const } } : {};
    const res = await this.client.responses.create({
      model: this.o.model,
      instructions: SYSTEM_PROMPT,
      input: buildUserPrompt(ctx),
      max_output_tokens: 600,
      ...reasoning,
    });
    const text = (res.output_text ?? "").trim();
    if (!text) throw new Error("openai: empty draft");
    return ctx.channel === "email" ? splitSubject(text, `Your ${shortVehicle(ctx.vehicle)} question`) : { body: text.replace(/^subject:.*\n+/i, "").trim() };
  }
}
