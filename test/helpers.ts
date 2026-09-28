import type { Contact, Dealer, Lead, Rep } from "../src/domain/types.js";
import { MemoryStore } from "../src/store/memory.js";
import { MemoryScheduler } from "../src/scheduler/memory.js";
import { FakeVinAdapter } from "../src/adapters/vin/fake.js";
import { FakeSenders } from "../src/adapters/messaging/fake.js";
import { TemplateComposer } from "../src/engine/templateComposer.js";
import { Orchestrator } from "../src/engine/orchestrator.js";
import type { Composer } from "../src/engine/composer.js";

export const TZ = "America/Los_Angeles";
/** 2026-09-28 10:00 PDT */
export const T0 = new Date("2026-09-28T17:00:00Z");

export class Clock {
  now: Date;
  constructor(start = T0) { this.now = new Date(start); }
  fn = () => this.now;
  advance(ms: number) { this.now = new Date(this.now.getTime() + ms); return this.now; }
  set(d: Date) { this.now = new Date(d); return this.now; }
}
export const MIN = 60_000; export const HOUR = 60 * MIN;

export function fixtures(overrides: { contact?: Partial<Contact>; lead?: Partial<Lead> } = {}) {
  const dealer: Dealer = { id: "14011", name: "Dublin Mazda", timezone: TZ };
  const rep: Rep = { id: "501", dealerId: "14011", firstName: "Sam", lastName: "Rivera", email: "sam@example.com", phone: "+19255550101", smsFrom: "+19255550100" };
  const contact: Contact = { id: "9001", dealerId: "14011", firstName: "Jordan", lastName: "Lee", emails: ["jordan@example.com"], phones: ["+19255550142"], smsConsent: "unknown", emailOptOut: false, ...overrides.contact };
  const lead: Lead = {
    id: "77001", dealerId: "14011", contactId: "9001", repId: "501", source: "Dealer Website", createdAt: T0, tcpaOptIn: false,
    vehicles: [{ year: 2024, make: "Mazda", model: "CX-5", trim: "Premium", stockNumber: "M24187", isInventory: true, listedPrice: 33450 }],
    ...overrides.lead,
  };
  return { dealer, rep, contact, lead };
}

export function world(opts: { composer?: Composer; clock?: Clock; contact?: Partial<Contact>; lead?: Partial<Lead> } = {}) {
  const clock = opts.clock ?? new Clock();
  const store = new MemoryStore();
  const scheduler = new MemoryScheduler();
  const vin = new FakeVinAdapter();
  const senders = new FakeSenders();
  const f = fixtures({ contact: opts.contact, lead: opts.lead });
  vin.dealers.set(f.dealer.id, f.dealer); vin.users.set(f.rep.id, f.rep); vin.contacts.set(f.contact.id, f.contact); vin.leads.set(f.lead.id, f.lead);
  vin.inventory.push({ stockNumber: "M24187", year: 2024, make: "Mazda", model: "CX-5", status: "In Stock", listedPrice: 33450, available: true });
  const orchestrator = new Orchestrator({
    store, scheduler, vin, sms: senders, email: senders, composer: opts.composer ?? new TemplateComposer(),
    storeTz: TZ, emailFromDomain: "mail.getricochet.live", defaultSmsFrom: "+19255550100", now: clock.fn,
  });
  return { clock, store, scheduler, vin, senders, orchestrator, ...f };
}
