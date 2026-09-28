import type { Channel, Message, Rep, VehicleOfInterest } from "../domain/types.js";
import type { InboundIntent } from "./policy.js";

export type ComposeKind =
  | "opt_in_request"
  | "first_sms"
  | "first_email"
  | "follow_up"
  | "last_touch"
  | "reply"
  | "handoff_summary";

export interface ComposeContext {
  kind: ComposeKind;
  channel: Channel;
  rep: Rep;
  dealerName: string;
  customerFirstName: string;
  vehicle?: VehicleOfInterest;
  history: Message[];
  inbound?: string;
  intents?: InboundIntent[];
  availability?: "available" | "unavailable" | "unverified";
  /** Fixed policy lines that must appear verbatim (price answer, real-person disclosure, etc.). */
  requiredLines?: string[];
  handoffReason?: string;
  /** Violations from a previous attempt, so an LLM can fix them on retry. */
  feedback?: string[];
}

export interface ComposeResult { body: string; subject?: string }

export interface Composer { compose(ctx: ComposeContext): Promise<ComposeResult> }

export function describeVehicle(v?: VehicleOfInterest): string {
  if (!v) return "the car you asked about";
  const parts = [v.year, v.make, v.model, v.trim].filter(Boolean);
  return parts.length ? parts.join(" ") : "the car you asked about";
}

export function shortVehicle(v?: VehicleOfInterest): string {
  if (!v) return "the car";
  return [v.make, v.model].filter(Boolean).join(" ") || "the car";
}

/** Split "Subject: X\n\nbody" into parts. Falls back to a generic subject. */
export function splitSubject(text: string, fallbackSubject: string): ComposeResult {
  const m = /^\s*subject:\s*(.+?)\s*\n+([\s\S]*)$/i.exec(text);
  if (m) return { subject: m[1]!.trim(), body: m[2]!.trim() };
  return { subject: fallbackSubject, body: text.trim() };
}
