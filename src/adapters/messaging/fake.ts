import type { EmailSendRequest, EmailSender, SendResult, SmsSendRequest, SmsSender } from "./types.js";

export class FakeSenders implements SmsSender, EmailSender {
  sms: SmsSendRequest[] = [];
  emails: EmailSendRequest[] = [];
  failNext = false;
  async sendSms(req: SmsSendRequest): Promise<SendResult> {
    if (this.failNext) { this.failNext = false; throw new Error("fake sms failure"); }
    this.sms.push(req);
    return { providerId: `SM${this.sms.length}` };
  }
  async sendEmail(req: EmailSendRequest): Promise<SendResult> {
    if (this.failNext) { this.failNext = false; throw new Error("fake email failure"); }
    this.emails.push(req);
    return { providerId: `PM${this.emails.length}` };
  }
}
