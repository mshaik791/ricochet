import type { Channel, Contact, Dealer, Direction, InventoryVehicle, Lead, Rep, VehicleOfInterest } from "../../domain/types.js";

export interface ActivityLog {
  leadId: string;
  dealerId: string;
  channel: Channel;
  direction: Direction;
  body: string;
  subject?: string;
  at: Date;
  repId?: string;
}

/**
 * Read from Vin, log to Vin. Never sends anything to a customer.
 * Implementations: CoxAdapter (real), FakeVinAdapter (tests, local dev).
 */
export interface VinAdapter {
  getLead(leadId: string, dealerId?: string): Promise<Lead>;
  getContact(contactId: string, dealerId: string): Promise<Contact>;
  getUser(userId: string, dealerId: string): Promise<Rep>;
  getDealer(dealerId: string): Promise<Dealer>;
  getLeadVehicles(leadId: string, dealerId: string): Promise<VehicleOfInterest[]>;
  findInventory(dealerId: string, q: { stockNumber?: string; vin?: string }): Promise<InventoryVehicle | undefined>;
  /** Mirror one customer-facing message (either direction) onto the lead timeline. */
  logActivity(a: ActivityLog): Promise<void>;
  /** Free-text note on the lead (handoff summaries, opt-outs, assistant state changes). */
  addLeadNote(leadId: string, dealerId: string, note: string): Promise<void>;
  /** Mirror SMS consent changes we learn about (YES / STOP). */
  setSmsConsent(contactId: string, dealerId: string, granted: boolean, source: string): Promise<void>;
}

/* ---------- Connect Event Service payloads ---------- */

export const COX_EVENT_TYPES = [
  "AppointmentUpdated",
  "ConsentUpdated",
  "CustomerCreated",
  "CustomerUpdated",
  "CustomerMerged",
  "LastContactAttemptUpdated",
  "LeadCreated",
  "LeadUpdated",
  "ShowroomVisitCompleted",
  "VehicleOfInterestCreated",
  "VehicleOfInterestUpdated",
] as const;
export type CoxEventType = (typeof COX_EVENT_TYPES)[number];

export interface CoxEvent {
  Type: CoxEventType | string;
  TrackingId: string;
  OccurredUtc: string;
  LeadId?: number | string;
  CustomerId?: number | string;
  DealerId?: number | string;
  Version?: number | string;
  [k: string]: unknown;
}
