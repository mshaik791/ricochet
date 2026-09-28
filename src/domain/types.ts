export type Channel = "sms" | "email";
export type Direction = "in" | "out";
export type SmsConsent = "granted" | "unknown" | "revoked";

export type ConversationState =
  | "active"      // assistant is working the lead
  | "silent"      // rep is active, appointment set, or day 3 reached
  | "handed_off"  // summary delivered to rep, assistant done
  | "opted_out";  // customer said STOP

export interface Rep {
  id: string;            // Vin user id as string
  dealerId: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;        // rep's own cell, for handoff summaries
  smsFrom?: string;      // Twilio number assigned to this rep
  emailFrom?: string;    // per-rep from-address on the sending subdomain
  voice?: VoiceProfile;
}

export interface Contact {
  id: string;            // Vin contact id
  dealerId: string;
  firstName: string;
  lastName: string;
  emails: string[];
  phones: string[];
  smsConsent: SmsConsent;
  emailOptOut: boolean;
}

export interface VehicleOfInterest {
  id?: string;
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
  stockNumber?: string;
  vin?: string;
  isInventory: boolean;
  /** The price the customer already saw. The only number we are allowed to repeat. */
  listedPrice?: number;
}

export interface Lead {
  id: string;
  dealerId: string;
  contactId: string;
  repId?: string;        // assigned Vin user id
  source?: string;
  createdAt: Date;
  status?: string;
  tcpaOptIn?: boolean;   // consent asserted by the lead source
  vehicles: VehicleOfInterest[];
  originalComment?: string;
}

export interface Message {
  id: string;
  leadId: string;
  channel: Channel;
  direction: Direction;
  body: string;
  subject?: string;
  at: Date;
  vinLogged: boolean;
}

export interface Conversation {
  leadId: string;
  dealerId: string;
  repId: string;
  contactId: string;
  state: ConversationState;
  stateReason?: string;
  smsConsent: SmsConsent;
  smsConsentPending: boolean;   // opt-in request sent, waiting for YES
  priceQuestions: number;
  lastOut: Partial<Record<Channel, Date>>;
  lastIn?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type CadenceStepKind =
  | "first_sms"
  | "first_email"
  | "email_3h"
  | "next_morning"
  | "day2"
  | "day3_last";

export interface ScheduledStep {
  id: string;
  leadId: string;
  kind: CadenceStepKind;
  runAt: Date;
  attempts: number;
}

export interface VoiceKnobs {
  formality: 1 | 2 | 3 | 4 | 5;   // 1 = very casual, 5 = buttoned up
  emoji: boolean;
  length: "short" | "medium";
  greeting: string;               // e.g. "Hey" / "Hi"
  signoff: string;                // e.g. "- Sam" / "Thanks, Sam"
}

export interface VoiceProfile {
  repId: string;
  knobs: VoiceKnobs;
  /** The rep's own outbound lines from the setup simulation, customer PII stripped. */
  samples: string[];
  savedAt: Date;
}

export interface Dealer {
  id: string;
  name: string;
  phone?: string;
  timezone?: string;
  address?: string;
}

export interface InventoryVehicle {
  stockNumber?: string;
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
  status?: string;       // e.g. "In Stock", "Sold", "In Transit"
  listedPrice?: number;
  available: boolean;
}
