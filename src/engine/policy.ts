/**
 * Fixed product policy. Reps' samples drive the voice; nothing in here is configurable per rep.
 * See CLAUDE.md "Product rules".
 */

export const BANNED_PHRASES: readonly string[] = [
  "i hope this message finds you well",
  "i hope this email finds you well",
  "just checking in",
  "just wanted to check in",
  "just following up",
  "circle back",
  "touch base",
  "reach out",
  "reaching out",
  "don't hesitate",
  "do not hesitate",
  "at your earliest convenience",
  "please let me know if you have any questions",
  "feel free to",
  "i'm an ai",
  "i am an ai",
  "as an ai",
  "language model",
  "virtual assistant",
  "automated message",
  "exciting opportunity",
  "unbeatable",
  "act now",
  "limited time",
  "don't miss out",
  "valued customer",
  "delve",
  "leverage",
  "elevate",
  "seamless",
  "game changer",
  "out the door",
  "otd",
  "drive-off",
  "drive off price",
];

/** Words that mean we are talking about money in a way rule 3 forbids. */
const PRICE_TALK = [
  /\bout[- ]the[- ]door\b/i,
  /\botd\b/i,
  /\bapr\b/i,
  /\binterest rate\b/i,
  /\brate[s]?\b/i,
  /\bper month\b/i,
  /\/mo\b/i,
  /\bmonthly\b/i,
  /\bpayment[s]?\b/i,
  /\bdiscount/i,
  /\brebate/i,
  /\bincentive/i,
  /\bmarkup\b/i,
  /\bmark-up\b/i,
  /\bdoc fee/i,
  /\bfees?\b/i,
  /\btax(es)?\b/i,
  /\bfinanc(e|ing)\b/i,
  /\blease\b/i,
  /\bdown payment\b/i,
  /\b\d+(\.\d+)?\s?%/,
];

export interface PolicyCheckInput {
  body: string;
  channel: "sms" | "email";
  /** The listed price the customer already saw, if any. Only this number may appear. */
  listedPrice?: number;
}

export interface PolicyViolation {
  rule: string;
  detail: string;
}

const MAX_SMS_CHARS = 320;
const MAX_EMAIL_CHARS = 700;
const MAX_SMS_SENTENCES = 3;
const MAX_EMAIL_SENTENCES = 6;

export function findViolations(input: PolicyCheckInput): PolicyViolation[] {
  const v: PolicyViolation[] = [];
  const body = input.body;
  const lower = body.toLowerCase();

  if (!body.trim()) v.push({ rule: "empty", detail: "message is empty" });
  if (body.includes("—")) v.push({ rule: "style", detail: "em dash" });
  if (body.includes(";")) v.push({ rule: "style", detail: "semicolon" });
  if (/^\s*([-*•]|\d+[.)])\s+/m.test(body)) v.push({ rule: "style", detail: "bullet or numbered list" });
  if (/<[a-z][\s\S]*>/i.test(body)) v.push({ rule: "style", detail: "html" });

  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) v.push({ rule: "banned_phrase", detail: phrase });
  }

  const maxChars = input.channel === "sms" ? MAX_SMS_CHARS : MAX_EMAIL_CHARS;
  if (body.length > maxChars) v.push({ rule: "length", detail: `${body.length} chars > ${maxChars}` });
  const sentences = countSentences(body);
  const maxSentences = input.channel === "sms" ? MAX_SMS_SENTENCES : MAX_EMAIL_SENTENCES;
  if (sentences > maxSentences) v.push({ rule: "length", detail: `${sentences} sentences > ${maxSentences}` });

  for (const re of PRICE_TALK) {
    if (re.test(body)) v.push({ rule: "price", detail: `price talk: ${re.source}` });
  }
  for (const amount of dollarAmounts(body)) {
    if (input.listedPrice === undefined || Math.round(amount) !== Math.round(input.listedPrice)) {
      v.push({ rule: "price", detail: `dollar amount ${amount} is not the listed price` });
    }
  }
  // Ranges like "28-30k" or "between 28,000 and 30,000"
  if (/\$?\d[\d,]*\s?(k|,000)?\s?(-|to)\s?\$?\d[\d,]*\s?k?\b/i.test(body) && /\$|\bk\b|,000/i.test(body)) {
    v.push({ rule: "price", detail: "price range" });
  }
  return v;
}

export function isCompliant(input: PolicyCheckInput): boolean {
  return findViolations(input).length === 0;
}

export function countSentences(text: string): number {
  const parts = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Za-z0-9"'(])/)
    .filter((s) => s.trim().length > 0);
  return parts.length;
}

export function dollarAmounts(text: string): number[] {
  const out: number[] = [];
  const re = /\$\s?(\d[\d,]*)(\.\d+)?\s?(k)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const whole = Number((m[1] ?? "0").replace(/,/g, ""));
    const frac = m[2] ? Number(m[2]) : 0;
    const n = (whole + frac) * (m[3] ? 1000 : 1);
    if (!Number.isNaN(n)) out.push(n);
  }
  // "28k" without a dollar sign, only when it reads like money
  const re2 = /(?<!\$\s?)\b(\d{2,3})k\b/gi;
  while ((m = re2.exec(text)) !== null) out.push(Number(m[1]) * 1000);
  return out;
}

/* ---------- Inbound classification ---------- */

export type InboundIntent =
  | "stop"
  | "yes"
  | "price"
  | "availability"
  | "real_person"
  | "appointment"
  | "other";

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "remove me", "opt out", "optout"]);
const YES_WORDS = new Set(["yes", "y", "yes please", "ok", "okay", "sure", "yep", "yeah", "yea", "yup", "sounds good", "fine", "go ahead"]);

export function classifyInbound(text: string): InboundIntent[] {
  const t = text.trim().toLowerCase().replace(/[.!]+$/g, "");
  const intents: InboundIntent[] = [];
  if (STOP_WORDS.has(t) || /^(stop|unsubscribe)\b/.test(t)) return ["stop"];
  if (YES_WORDS.has(t)) intents.push("yes");
  if (/\b(price|pricing|cost|how much|best deal|deal|discount|out the door|otd|payment|monthly|per month|apr|rate|finance|lease|negotiable|lowest|cheaper|msrp)\b/.test(t)) intents.push("price");
  if (/\b(still available|available|in stock|on the lot|still have|do you have|sold|is it there)\b/.test(t)) intents.push("availability");
  if (/\b(real person|a bot|robot|automated|are you human|is this a human|ai\b|chatbot|actual person)\b/.test(t)) intents.push("real_person");
  if (/\b(come in|stop by|appointment|schedule|test drive|visit|tomorrow|today|this weekend|saturday|sunday|monday|tuesday|wednesday|thursday|friday|what time|call me|give me a call)\b/.test(t)) intents.push("appointment");
  if (intents.length === 0) intents.push("other");
  return intents;
}

/* ---------- Fixed lines the assistant may always use ---------- */

export const FIXED = {
  realPerson: (repFirst: string) =>
    `I'm ${repFirst}'s assistant and I help with scheduling. ${repFirst} is who you'll be working with.`,
  availabilityUnverified: () => `Let me confirm that and get right back to you.`,
  priceAsk: (repFirst: string) =>
    `The listed price is what you saw online and we're willing to work with you. Easiest is a quick call or a visit so ${repFirst} can go over it with you.`,
  optInRequest: (repFirst: string, dealer: string) =>
    `Hi, this is ${repFirst}'s assistant at ${dealer} about the car you asked about. Ok to text you here? Reply YES to confirm or STOP to opt out.`,
  optOutAck: () => `Got it, you won't get any more texts from us.`,
};

/* ---------- Quiet hours and spacing ---------- */

export const QUIET_START_HOUR = 21; // 9pm store time
export const QUIET_END_HOUR = 8;    // 8am store time
export const SAME_CHANNEL_GAP_MS = 3 * 60 * 60 * 1000;
export const PRICE_QUESTIONS_BEFORE_HANDOFF = 2;
