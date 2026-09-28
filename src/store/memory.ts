import type { Contact, Conversation, Lead, Message, Rep, VoiceProfile } from "../domain/types.js";
import type { Store } from "./types.js";

/** Dev/test store. Replace with PgStore in prod (CLAUDE.md next steps #5). */
export class MemoryStore implements Store {
  leads = new Map<string, Lead>();
  contacts = new Map<string, Contact>();
  conversations = new Map<string, Conversation>();
  messages = new Map<string, Message[]>();
  reps = new Map<string, Rep>();
  seen = new Set<string>();

  async upsertLead(lead: Lead) { this.leads.set(lead.id, lead); }
  async getLead(id: string) { return this.leads.get(id); }
  async upsertContact(c: Contact) { this.contacts.set(c.id, c); }
  async getContact(id: string) { return this.contacts.get(id); }
  async upsertConversation(c: Conversation) { this.conversations.set(c.leadId, { ...c, updatedAt: new Date() }); }
  async getConversation(leadId: string) { return this.conversations.get(leadId); }
  async listConversations() { return [...this.conversations.values()]; }
  async addMessage(m: Message) {
    const arr = this.messages.get(m.leadId) ?? [];
    arr.push(m);
    this.messages.set(m.leadId, arr);
  }
  async listMessages(leadId: string) { return [...(this.messages.get(leadId) ?? [])]; }
  async upsertRep(rep: Rep) { this.reps.set(rep.id, { ...this.reps.get(rep.id), ...rep }); }
  async getRep(id: string) { return this.reps.get(id); }
  async findRepBySmsFrom(number: string) { return [...this.reps.values()].find((r) => r.smsFrom === number); }
  async saveVoiceProfile(p: VoiceProfile) {
    const rep = this.reps.get(p.repId);
    if (rep) this.reps.set(p.repId, { ...rep, voice: p });
  }
  async markEventSeen(trackingId: string) {
    if (this.seen.has(trackingId)) return false;
    this.seen.add(trackingId);
    return true;
  }
}
