import type { Contact, Conversation, Lead, Message, Rep, VoiceProfile } from "../domain/types.js";

export interface Store {
  // leads and their conversations
  upsertLead(lead: Lead): Promise<void>;
  getLead(leadId: string): Promise<Lead | undefined>;
  upsertContact(contact: Contact): Promise<void>;
  getContact(contactId: string): Promise<Contact | undefined>;
  upsertConversation(c: Conversation): Promise<void>;
  getConversation(leadId: string): Promise<Conversation | undefined>;
  listConversations(): Promise<Conversation[]>;
  // messages
  addMessage(m: Message): Promise<void>;
  listMessages(leadId: string): Promise<Message[]>;
  // reps
  upsertRep(rep: Rep): Promise<void>;
  getRep(repId: string): Promise<Rep | undefined>;
  findRepBySmsFrom(number: string): Promise<Rep | undefined>;
  saveVoiceProfile(p: VoiceProfile): Promise<void>;
  // event dedupe (Cox TrackingId)
  markEventSeen(trackingId: string): Promise<boolean>; // true if new, false if duplicate
}
