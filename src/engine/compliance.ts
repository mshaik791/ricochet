import type { Composer, ComposeContext, ComposeResult } from "./composer.js";
import { findViolations, type PolicyViolation } from "./policy.js";

/** LLMs emit curly quotes and ellipses. Texts from a phone do not. Normalize before checking and sending. */
export function normalizeTypography(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function normalizeDraft(draft: ComposeResult): ComposeResult {
  return { body: normalizeTypography(draft.body), subject: draft.subject ? normalizeTypography(draft.subject) : undefined };
}

/** Violations for a draft in context, including missing required lines. */
export function checkDraft(draft: ComposeResult, ctx: ComposeContext, listedPrice?: number): PolicyViolation[] {
  if (ctx.kind === "handoff_summary") return [];
  return findViolations({ body: draft.body, channel: ctx.channel, listedPrice }).concat(
    (ctx.requiredLines ?? []).filter((l) => !draft.body.includes(l)).map((l) => ({ rule: "required_line", detail: `missing: ${l}` })),
  );
}

export interface ComplianceResult { draft: ComposeResult; source: "primary" | "primary_retry" | "template"; rejected: string[][] }

/** Primary composer, one retry with feedback, then the template. Never returns a non-compliant draft. */
export async function composeCompliant(primary: Composer, template: Composer, ctx: ComposeContext, listedPrice?: number): Promise<ComplianceResult> {
  const rejected: string[][] = [];
  let feedback: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let draft: ComposeResult;
    try { draft = normalizeDraft(await primary.compose({ ...ctx, feedback })); } catch { break; }
    const v = checkDraft(draft, ctx, listedPrice);
    if (v.length === 0) return { draft, source: attempt === 0 ? "primary" : "primary_retry", rejected };
    feedback = v.map((x) => `${x.rule}: ${x.detail}`);
    rejected.push(feedback);
  }
  const draft = await template.compose(ctx);
  const v = checkDraft(draft, ctx, listedPrice);
  if (v.length) throw new Error(`template fallback violated policy: ${v.map((x) => x.detail).join(", ")}`);
  return { draft, source: "template", rejected };
}
