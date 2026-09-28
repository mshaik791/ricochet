import type { Config } from "../config.js";
import type { Composer } from "../engine/composer.js";
import { TemplateComposer } from "../engine/templateComposer.js";
import { AnthropicComposer } from "./anthropicComposer.js";
import { OpenAiComposer } from "./openaiComposer.js";

export function makeComposer(cfg: Config): { composer: Composer; provider: string } {
  if (cfg.llm.provider === "openai" && cfg.llm.openaiKey) {
    return { composer: new OpenAiComposer({ apiKey: cfg.llm.openaiKey, model: cfg.llm.openaiModel }), provider: `openai:${cfg.llm.openaiModel}` };
  }
  if (cfg.llm.provider === "anthropic" && cfg.llm.anthropicKey) {
    return { composer: new AnthropicComposer({ apiKey: cfg.llm.anthropicKey, model: cfg.llm.anthropicModel }), provider: `anthropic:${cfg.llm.anthropicModel}` };
  }
  return { composer: new TemplateComposer(), provider: "template" };
}
