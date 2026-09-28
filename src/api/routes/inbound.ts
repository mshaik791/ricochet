import type { FastifyInstance } from "fastify";
import type { Orchestrator } from "../../engine/orchestrator.js";
import { verifyTwilioSignature } from "../../adapters/messaging/twilio.js";
import { leadIdFromReplyAddress } from "../../adapters/messaging/postmark.js";
import { normalizePhone } from "../../adapters/vin/cox.js";
import { safeEqual } from "../../webhooks/coxSinkAuth.js";

export interface InboundRouteDeps {
  orchestrator: Orchestrator;
  publicBaseUrl: string;
  env: string;
  twilioAuthToken?: string;
  postmarkInboundSecret?: string;
}

export async function registerInbound(app: FastifyInstance, deps: InboundRouteDeps) {
  /** Twilio inbound SMS (form-encoded). Replies with empty TwiML. */
  app.post<{ Body: Record<string, string> }>("/webhooks/twilio/sms", async (req, reply) => {
    const url = `${deps.publicBaseUrl}/webhooks/twilio/sms`;
    const sig = req.headers["x-twilio-signature"] as string | undefined;
    if (deps.twilioAuthToken) {
      if (!verifyTwilioSignature(deps.twilioAuthToken, url, req.body ?? {}, sig)) return reply.code(403).send("bad signature");
    } else if (deps.env === "production") {
      return reply.code(503).send("twilio not configured");
    }
    const b = req.body ?? {};
    const from = b.From ? normalizePhone(b.From) : undefined;
    const to = b.To ? normalizePhone(b.To) : undefined;
    const body = (b.Body ?? "").trim();
    const r = body ? await deps.orchestrator.onInbound({ fromPhone: from, toPhone: to, channel: "sms", body }) : { action: "empty" };
    req.log.info({ from, action: r.action }, "twilio inbound");
    return reply.type("text/xml").send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>");
  });

  /** Postmark inbound webhook (JSON). Route: reply+<leadId>@domain -> MailboxHash. */
  app.post<{ Body: Record<string, unknown>; Querystring: { secret?: string } }>("/webhooks/postmark/inbound", async (req, reply) => {
    if (deps.postmarkInboundSecret) {
      const q = req.query?.secret;
      const auth = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
      const basicPass = auth ? Buffer.from(auth[1]!, "base64").toString("utf8").split(":").slice(1).join(":") : undefined;
      if (!safeEqual(q, deps.postmarkInboundSecret) && !safeEqual(basicPass, deps.postmarkInboundSecret)) return reply.code(401).send({ error: "unauthorized" });
    } else if (deps.env === "production") {
      return reply.code(503).send({ error: "postmark not configured" });
    }
    const b = req.body ?? {};
    const leadId = leadIdFromReplyAddress(b.MailboxHash as string | undefined, (b.ToFull as { Email?: string }[] | undefined)?.[0]?.Email ?? (b.To as string | undefined));
    const body = String(b.StrippedTextReply ?? b.TextBody ?? "").trim();
    if (!leadId) return reply.code(200).send({ action: "no_lead_in_address" });
    const r = body ? await deps.orchestrator.onInbound({ leadId, channel: "email", body }) : { action: "empty" };
    req.log.info({ leadId, action: r.action }, "postmark inbound");
    return reply.code(200).send(r);
  });
}
