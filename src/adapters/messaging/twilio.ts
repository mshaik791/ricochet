import { createHmac, timingSafeEqual } from "node:crypto";
import type { SendResult, SmsSendRequest, SmsSender } from "./types.js";

export interface TwilioOptions { accountSid: string; authToken: string; fetchImpl?: typeof fetch }

/** Twilio REST via fetch. No SDK, no persistent sessions. */
export class TwilioSms implements SmsSender {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: TwilioOptions) { this.fetchImpl = opts.fetchImpl ?? fetch; }

  async sendSms(req: SmsSendRequest): Promise<SendResult> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.opts.accountSid)}/Messages.json`;
    const form = new URLSearchParams({ From: req.from, To: req.to, Body: req.body });
    if (req.statusCallbackUrl) form.set("StatusCallback", req.statusCallbackUrl);
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${this.opts.accountSid}:${this.opts.authToken}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    if (!res.ok) throw new Error(`twilio ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { sid: string };
    return { providerId: json.sid };
  }
}

/**
 * Twilio request signature: base64(HMAC-SHA1(authToken, url + concat(sorted key+value))).
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  const a = Buffer.from(expected); const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
