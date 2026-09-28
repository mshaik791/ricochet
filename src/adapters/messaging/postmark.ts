import type { EmailSendRequest, EmailSender, SendResult } from "./types.js";

export interface PostmarkOptions { serverToken: string; messageStream?: string; fetchImpl?: typeof fetch }

/** Postmark REST via fetch. Open tracking on. Reply-To routes to reply+<leadId>@ inbound. */
export class PostmarkEmail implements EmailSender {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: PostmarkOptions) { this.fetchImpl = opts.fetchImpl ?? fetch; }

  async sendEmail(req: EmailSendRequest): Promise<SendResult> {
    const res = await this.fetchImpl("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "X-Postmark-Server-Token": this.opts.serverToken, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        From: req.from,
        To: req.to,
        ReplyTo: req.replyTo,
        Subject: req.subject,
        TextBody: req.textBody,
        Tag: req.tag,
        TrackOpens: true,
        MessageStream: this.opts.messageStream ?? "outbound",
        Headers: Object.entries(req.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
      }),
    });
    if (!res.ok) throw new Error(`postmark ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { MessageID: string };
    return { providerId: json.MessageID };
  }
}

/** reply+<leadId>@domain  ->  leadId */
export function leadIdFromReplyAddress(mailboxHash: string | undefined, toFull: string | undefined): string | undefined {
  if (mailboxHash && mailboxHash.trim()) return mailboxHash.trim();
  const m = /reply\+([^@\s>]+)@/i.exec(toFull ?? "");
  return m?.[1];
}
