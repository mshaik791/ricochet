import type { Contact, Dealer, InventoryVehicle, Lead, Rep, VehicleOfInterest } from "../../domain/types.js";
import type { ActivityLog, VinAdapter } from "./types.js";

export class FakeVinAdapter implements VinAdapter {
  leads = new Map<string, Lead>();
  contacts = new Map<string, Contact>();
  users = new Map<string, Rep>();
  dealers = new Map<string, Dealer>();
  inventory: InventoryVehicle[] = [];
  activity: ActivityLog[] = [];
  notes: { leadId: string; note: string }[] = [];
  consent: { contactId: string; granted: boolean; source: string }[] = [];

  async getLead(leadId: string) { const l = this.leads.get(leadId); if (!l) throw new Error(`fake: no lead ${leadId}`); return l; }
  async getContact(contactId: string) { const c = this.contacts.get(contactId); if (!c) throw new Error(`fake: no contact ${contactId}`); return c; }
  async getUser(userId: string) { const u = this.users.get(userId); if (!u) throw new Error(`fake: no user ${userId}`); return u; }
  async getDealer(dealerId: string) { return this.dealers.get(dealerId) ?? { id: dealerId, name: "Dublin Mazda", timezone: "America/Los_Angeles" }; }
  async getLeadVehicles(leadId: string): Promise<VehicleOfInterest[]> { return this.leads.get(leadId)?.vehicles ?? []; }
  async findInventory(_dealerId: string, q: { stockNumber?: string; vin?: string }) {
    return this.inventory.find((v) => (q.stockNumber && v.stockNumber === q.stockNumber) || (q.vin && v.vin === q.vin));
  }
  async logActivity(a: ActivityLog) { this.activity.push(a); }
  async addLeadNote(leadId: string, _dealerId: string, note: string) { this.notes.push({ leadId, note }); }
  async setSmsConsent(contactId: string, _dealerId: string, granted: boolean, source: string) {
    this.consent.push({ contactId, granted, source });
    const c = this.contacts.get(contactId);
    if (c) c.smsConsent = granted ? "granted" : "revoked";
  }
}
