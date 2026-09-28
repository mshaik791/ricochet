export interface SmsSendRequest { from: string; to: string; body: string; statusCallbackUrl?: string }
export interface EmailSendRequest {
  from: string; to: string; subject: string; textBody: string; replyTo: string; tag?: string; headers?: Record<string, string>;
}
export interface SendResult { providerId: string }

/** Adapters never decide to send. Only src/engine/orchestrator.ts calls these. */
export interface SmsSender { sendSms(req: SmsSendRequest): Promise<SendResult> }
export interface EmailSender { sendEmail(req: EmailSendRequest): Promise<SendResult> }
