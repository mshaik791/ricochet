import type { ComposeContext } from "../engine/composer.js";
import { describeVehicle } from "../engine/composer.js";
import { BANNED_PHRASES } from "../engine/policy.js";

/** Stable system prompt (cacheable). Voice-specific material goes in the user turn. */
export const SYSTEM_PROMPT = `You write short messages on behalf of a car salesperson's assistant at a dealership. The customer submitted an internet lead about a specific car. Your job is to get them on a phone call or into the store with the salesperson, in the salesperson's own voice.

Hard rules. Breaking any of these makes the message unusable.
1. Never state or imply any price, number, payment, rate, discount, fee, tax, range, or "out the door" figure. The only allowed money statement is that the listed price is what they saw online and the store is willing to work with them. Every price question ends with an ask for a call or visit.
2. Only say a car is available if the context says availability is verified. Otherwise say you will confirm and get right back.
3. If asked whether this is a real person, say you are the salesperson's assistant who helps with scheduling and the salesperson is who they will work with. Never claim to be the salesperson. Do not volunteer that you are software otherwise.
4. Sound like a person texting. No em dashes. No semicolons. No bullet points or numbered lists. No sign-off blocks in texts. Casual punctuation is fine.
5. Short. One idea per message. Texts are one to three sentences. Emails are at most six sentences.
6. Never use these phrases: ${BANNED_PHRASES.join(", ")}.
7. If the context gives REQUIRED LINES, include them word for word.
8. Do not invent facts about the car, the store, hours, inventory, or the customer.

Output only the message text. For an email, start with a line "Subject: ..." then a blank line, then the body.`;

export function buildUserPrompt(ctx: ComposeContext): string {
  const v = ctx.rep.voice;
  const lines: string[] = [];
  lines.push(`Channel: ${ctx.channel}`);
  lines.push(`Message type: ${ctx.kind}`);
  lines.push(`Salesperson: ${ctx.rep.firstName} at ${ctx.dealerName}`);
  lines.push(`Customer first name: ${ctx.customerFirstName || "(unknown, do not guess)"}`);
  lines.push(`Vehicle: ${describeVehicle(ctx.vehicle)}${ctx.vehicle?.stockNumber ? ` (stock ${ctx.vehicle.stockNumber})` : ""}`);
  if (ctx.availability) lines.push(`Availability: ${ctx.availability}`);
  if (v) {
    lines.push(`Voice knobs: formality ${v.knobs.formality}/5, emoji ${v.knobs.emoji ? "ok" : "no"}, length ${v.knobs.length}, greeting "${v.knobs.greeting}", signoff "${v.knobs.signoff}"`);
    if (v.samples.length) lines.push(`How the salesperson actually writes (match this tone, not the content):\n${v.samples.map((s) => `- ${s}`).join("\n")}`);
  }
  if (ctx.history.length) {
    lines.push(`Conversation so far (oldest first):\n${ctx.history.slice(-8).map((m) => `${m.direction === "in" ? "Customer" : "Assistant"} (${m.channel}): ${m.body}`).join("\n")}`);
  }
  if (ctx.inbound) lines.push(`Customer just said: ${ctx.inbound}`);
  if (ctx.intents?.length) lines.push(`Detected intents: ${ctx.intents.join(", ")}`);
  if (ctx.requiredLines?.length) lines.push(`REQUIRED LINES (include verbatim):\n${ctx.requiredLines.join("\n")}`);
  if (ctx.handoffReason) lines.push(`Handoff reason: ${ctx.handoffReason}`);
  if (ctx.feedback?.length) lines.push(`Your previous draft was rejected for: ${ctx.feedback.join("; ")}. Fix those and try again.`);
  lines.push(goalFor(ctx));
  return lines.join("\n\n");
}

function goalFor(ctx: ComposeContext): string {
  switch (ctx.kind) {
    case "opt_in_request": return "Goal: ask permission to text. Use the required line as-is.";
    case "first_sms": return "Goal: first text within a minute of the lead. Acknowledge the car, offer a quick call or a visit.";
    case "first_email": return "Goal: first email. Acknowledge the car, offer a call or visit, make replying easy.";
    case "follow_up": return "Goal: light follow-up. Do not repeat the previous message. One new angle at most, then the ask.";
    case "last_touch": return "Goal: last touch. Low pressure, leave the door open, no guilt.";
    case "reply": return "Goal: answer what they asked within the rules, then move toward a call or visit.";
    case "handoff_summary": return "Goal: a two to four sentence summary for the salesperson, plain and factual. This goes to the salesperson, not the customer.";
  }
}
