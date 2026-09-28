import type { CadenceStepKind, Channel, SmsConsent } from "../domain/types.js";
import { QUIET_END_HOUR, QUIET_START_HOUR } from "./policy.js";

/**
 * Rule 2. Offsets are from lead assignment. Morning steps land at 9:00 store time on that day.
 * Channel "sms_if_consent" falls back to email when SMS consent is not granted.
 */
export interface CadenceDef {
  kind: CadenceStepKind;
  channel: Channel | "sms_if_consent";
  offsetMs?: number;           // relative to assignment
  morningOfDay?: number;       // 1 = next morning, 2 = day 2, 3 = day 3
  last?: boolean;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

export const CADENCE: readonly CadenceDef[] = [
  { kind: "first_sms", channel: "sms", offsetMs: 1 * MIN },
  { kind: "first_email", channel: "email", offsetMs: 2 * MIN },
  { kind: "email_3h", channel: "email", offsetMs: 3 * HOUR + 10 * MIN },
  { kind: "next_morning", channel: "sms_if_consent", morningOfDay: 1 },
  { kind: "day2", channel: "email", morningOfDay: 2 },
  { kind: "day3_last", channel: "sms_if_consent", morningOfDay: 3, last: true },
];

export const MORNING_HOUR = 9;

export interface PlannedStep { kind: CadenceStepKind; runAt: Date }

export function planCadence(assignedAt: Date, opts: { hasPhone: boolean; hasEmail: boolean; tz: string }): PlannedStep[] {
  const out: PlannedStep[] = [];
  const emailOnly = !opts.hasPhone && opts.hasEmail;
  for (const def of CADENCE) {
    if (!opts.hasEmail && def.channel === "email") continue;
    if (!opts.hasPhone && def.channel === "sms") continue;
    if (!opts.hasPhone && !opts.hasEmail) continue;
    let runAt: Date;
    if (def.morningOfDay !== undefined) {
      runAt = atStoreHour(addDays(assignedAt, def.morningOfDay, opts.tz), MORNING_HOUR, opts.tz);
    } else {
      let offset = def.offsetMs ?? 0;
      if (emailOnly && def.kind === "first_email") offset = 1 * MIN;
      runAt = new Date(assignedAt.getTime() + offset);
    }
    out.push({ kind: def.kind, runAt: deferOutOfQuietHours(runAt, opts.tz) });
  }
  return out;
}

export function resolveChannel(kind: CadenceStepKind, smsConsent: SmsConsent, hasPhone: boolean, hasEmail: boolean): Channel | null {
  const def = CADENCE.find((d) => d.kind === kind);
  if (!def) return null;
  if (def.channel === "sms") return hasPhone ? "sms" : null;
  if (def.channel === "email") return hasEmail ? "email" : null;
  if (smsConsent === "granted" && hasPhone) return "sms";
  return hasEmail ? "email" : null;
}

export function isLastStep(kind: CadenceStepKind): boolean {
  return CADENCE.find((d) => d.kind === kind)?.last === true;
}

/* ---------- Store-time helpers (no deps) ---------- */

export function storeParts(d: Date, tz: string): { y: number; m: number; day: number; hour: number; minute: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(d)) p[part.type] = part.value;
  return { y: Number(p.year), m: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

/** Offset of tz from UTC in ms at instant d. */
function tzOffsetMs(d: Date, tz: string): number {
  const p = storeParts(d, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.day, p.hour, p.minute, d.getUTCSeconds());
  const truncated = new Date(d); truncated.setUTCMilliseconds(0);
  return asUtc - truncated.getTime();
}

/** Same calendar date in store tz, at hour:00. */
export function atStoreHour(d: Date, hour: number, tz: string): Date {
  const p = storeParts(d, tz);
  const guess = new Date(Date.UTC(p.y, p.m - 1, p.day, hour, 0, 0) - tzOffsetMs(d, tz));
  // Correct for DST shifts between d and guess.
  const fix = tzOffsetMs(d, tz) - tzOffsetMs(guess, tz);
  return new Date(guess.getTime() + fix);
}

export function addDays(d: Date, days: number, tz: string): Date {
  const p = storeParts(d, tz);
  const noonUtc = Date.UTC(p.y, p.m - 1, p.day + days, 12, 0, 0);
  return new Date(noonUtc);
}

export function isQuietHours(d: Date, tz: string): boolean {
  const h = storeParts(d, tz).hour;
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

/** If d falls in 9pm–8am store time, move it to 8:00am store time (same or next day). */
export function deferOutOfQuietHours(d: Date, tz: string): Date {
  if (!isQuietHours(d, tz)) return d;
  const h = storeParts(d, tz).hour;
  const base = h >= QUIET_START_HOUR ? addDays(d, 1, tz) : d;
  return atStoreHour(base, QUIET_END_HOUR, tz);
}
