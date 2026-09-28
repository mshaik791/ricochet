import type { Composer, ComposeContext, ComposeResult } from "./composer.js";
import { describeVehicle, shortVehicle } from "./composer.js";

/**
 * Deterministic, policy-compliant fallback. Used in tests, in dev without an LLM key, and whenever
 * an LLM draft fails the policy check twice. Voice knobs still apply (greeting, signoff, emoji).
 */
export class TemplateComposer implements Composer {
  async compose(ctx: ComposeContext): Promise<ComposeResult> {
    const rep = ctx.rep.firstName;
    const knobs = ctx.rep.voice?.knobs;
    const hi = knobs?.greeting?.trim() || "Hi";
    const signoff = knobs?.signoff?.trim() || `${rep}`;
    const smile = knobs?.emoji ? " :)" : "";
    const name = ctx.customerFirstName || "there";
    const car = describeVehicle(ctx.vehicle);
    const short = shortVehicle(ctx.vehicle);
    const required = (ctx.requiredLines ?? []).join(" ");

    switch (ctx.kind) {
      case "opt_in_request":
        return { body: required || `${hi} ${name}, this is ${rep}'s assistant at ${ctx.dealerName} about ${short}. Ok to text you here? Reply YES to confirm or STOP to opt out.` };

      case "first_sms":
        return { body: `${hi} ${name}, it's ${rep}'s assistant at ${ctx.dealerName}. Saw you asked about the ${car}. Want to set up a quick call or come take a look?${smile}` };

      case "first_email":
        return {
          subject: `Your ${short} question`,
          body: `${hi} ${name},\n\nThanks for asking about the ${car}. I work with ${rep} at ${ctx.dealerName} and help get things scheduled. What works better for you, a quick call or coming by to see it? Happy to line up whichever is easier.\n\n${signoff}`,
        };

      case "follow_up":
        return ctx.channel === "sms"
          ? { body: `${hi} ${name}, ${rep}'s assistant again. Still happy to set up a time for the ${short} whenever works for you.${smile}` }
          : {
              subject: `Still here on the ${short}`,
              body: `${hi} ${name},\n\nWanted to make it easy if you're still looking at the ${car}. ${rep} can walk you through it on a quick call or in person. Just reply with a day and time that works.\n\n${signoff}`,
            };

      case "last_touch":
        return ctx.channel === "sms"
          ? { body: `${hi} ${name}, last note from me on the ${short}. If the timing changes, just text back and ${rep} will take care of you.${smile}` }
          : {
              subject: `Whenever you're ready`,
              body: `${hi} ${name},\n\nI'll stop filling your inbox about the ${car}. If the timing changes, reply here and ${rep} will pick it right up.\n\n${signoff}`,
            };

      case "reply": {
        const intents = new Set(ctx.intents ?? []);
        const lines: string[] = [];
        if (required) lines.push(required);
        if (intents.has("availability")) {
          if (ctx.availability === "available") lines.push(`Good news, the ${short} is still here.`);
          else if (ctx.availability === "unavailable") lines.push(`That one just went, but ${rep} has similar ones and can show you what's close.`);
          // "unverified" is covered by the required fixed line.
        }
        if (intents.has("appointment")) lines.push(`${rep} will confirm the time with you directly.`);
        if (lines.length === 0) lines.push(`Happy to help with that. Easiest is a quick call or a visit so ${rep} can go over it with you.`);
        if (!intents.has("price") && !intents.has("appointment")) lines.push(`Want me to set up a time?`);
        const body = ctx.channel === "sms" ? lines.join(" ") : `${hi} ${name},\n\n${lines.join(" ")}\n\n${signoff}`;
        return ctx.channel === "sms" ? { body } : { subject: `Re: your ${short} question`, body };
      }

      case "handoff_summary": {
        const last = ctx.history.slice(-6).map((m) => `${m.direction === "in" ? name : "Assistant"}: ${m.body.replace(/\s+/g, " ").slice(0, 140)}`).join("\n");
        return {
          subject: `Handoff: ${name} on the ${short}`,
          body: `Handing ${name} to you. Reason: ${ctx.handoffReason ?? "ready for you"}. Vehicle: ${car}.\nRecent thread:\n${last}`,
        };
      }
    }
  }
}
