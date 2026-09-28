import { randomUUID } from "node:crypto";
import type { Channel, Contact, Conversation, Dealer, Lead, Message, Rep, ScheduledStep, SmsConsent } from "../domain/types.js";
import type { Store } from "../store/types.js";
import type { Scheduler } from "../scheduler/types.js";
import type { VinAdapter, CoxEvent } from "../adapters/vin/types.js";
import type { EmailSender, SmsSender } from "../adapters/messaging/types.js";
import type { Composer, ComposeContext, ComposeKind, ComposeResult } from "./composer.js";
import { TemplateComposer } from "./templateComposer.js";
import { composeCompliant } from "./compliance.js";
import { deferOutOfQuietHours, isLastStep, isQuietHours, planCadence, resolveChannel } from "./cadence.js";
import {
  FIXED, PRICE_QUESTIONS_BEFORE_HANDOFF, SAME_CHANNEL_GAP_MS, classifyInbound,
} from "./policy.js";

export interface Logger { info(o: unknown, msg?: string): void; warn(o: unknown, msg?: string): void; error(o: unknown, msg?: string): void }

export interface OrchestratorDeps {
  store: Store;
  scheduler: Scheduler;
  vin: VinAdapter;
  sms: SmsSender;
  email: EmailSender;
  composer: Composer;
  storeTz: string;
  emailFromDomain: string;
  defaultSmsFrom?: string;
  publicBaseUrl?: string;
  now?: () => Date;
  log?: Logger;
}

export interface LeadBundle { lead: Lead; rep: Rep; contact: Contact; dealer: Dealer }

/**
 * The ONLY thing that sends. Adapters never send. Every outbound goes through `deliver`, which
 * runs the policy check, records the message, and mirrors it to Vin.
 */
export class Orchestrator {
  private readonly template = new TemplateComposer();
  private readonly now: () => Date;
  private readonly log: Logger;
  constructor(private readonly d: OrchestratorDeps) {
    this.now = d.now ?? (() => new Date());
    this.log = d.log ?? { info: () => {}, warn: () => {}, error: () => {} };
  }

  /* ---------------- Lead lifecycle ---------------- */

  async onLeadAssigned(b: LeadBundle): Promise<Conversation> {
    const now = this.now();
    await this.d.store.upsertLead(b.lead);
    await this.d.store.upsertContact(b.contact);
    await this.d.store.upsertRep({ ...(await this.d.store.getRep(b.rep.id)), ...b.rep, voice: (await this.d.store.getRep(b.rep.id))?.voice ?? b.rep.voice });

    const existing = await this.d.store.getConversation(b.lead.id);
    if (existing) {
      if (existing.repId !== b.rep.id) {
        // Rule 5: reassignment switches persona, keeps the thread.
        const updated: Conversation = { ...existing, repId: b.rep.id, updatedAt: now };
        await this.d.store.upsertConversation(updated);
        await this.note(b.lead, `Lead reassigned to ${b.rep.firstName} ${b.rep.lastName}. Assistant continuing the thread as ${b.rep.firstName}'s assistant.`);
        return updated;
      }
      return existing;
    }

    const smsConsent: SmsConsent = b.contact.smsConsent === "revoked" ? "revoked" : b.lead.tcpaOptIn || b.contact.smsConsent === "granted" ? "granted" : "unknown";
    const conv: Conversation = {
      leadId: b.lead.id, dealerId: b.lead.dealerId, repId: b.rep.id, contactId: b.contact.id,
      state: "active", smsConsent, smsConsentPending: false, priceQuestions: 0, lastOut: {}, createdAt: now, updatedAt: now,
    };
    await this.d.store.upsertConversation(conv);

    const plan = planCadence(now, { hasPhone: b.contact.phones.length > 0, hasEmail: b.contact.emails.length > 0 && !b.contact.emailOptOut, tz: this.d.storeTz });
    for (const p of plan) await this.d.scheduler.schedule({ leadId: b.lead.id, kind: p.kind, runAt: p.runAt });
    await this.note(b.lead, `Assistant engaged for ${b.rep.firstName}. ${plan.length} touches planned. SMS consent: ${smsConsent}.`);
    this.log.info({ leadId: b.lead.id, steps: plan.length }, "lead assigned, cadence planned");
    return conv;
  }

  /** Cox pushes events out of order. We always re-read current state from Vin and act idempotently. */
  async onCoxEvent(ev: CoxEvent): Promise<{ action: string }> {
    const leadId = ev.LeadId ? String(ev.LeadId) : undefined;
    const dealerId = ev.DealerId ? String(ev.DealerId) : undefined;
    const customerId = ev.CustomerId ? String(ev.CustomerId) : undefined;

    switch (ev.Type) {
      case "LeadCreated":
      case "LeadUpdated": {
        if (!leadId) return { action: "ignored_no_lead" };
        const lead = await this.d.vin.getLead(leadId, dealerId);
        if (!lead.repId) return { action: "waiting_for_assignment" };
        const bundle = await this.loadBundle(lead);
        await this.onLeadAssigned(bundle);
        return { action: "lead_assigned" };
      }
      case "LastContactAttemptUpdated":
        if (!leadId) return { action: "ignored_no_lead" };
        return (await this.goSilent(leadId, "rep_activity")) ? { action: "silenced_rep_activity" } : { action: "no_conversation" };
      case "AppointmentUpdated":
        if (!leadId) return { action: "ignored_no_lead" };
        return (await this.goSilent(leadId, "appointment_set")) ? { action: "silenced_appointment" } : { action: "no_conversation" };
      case "ShowroomVisitCompleted":
        if (!leadId) return { action: "ignored_no_lead" };
        return (await this.goSilent(leadId, "showroom_visit")) ? { action: "silenced_showroom" } : { action: "no_conversation" };
      case "ConsentUpdated":
      case "CustomerUpdated":
      case "CustomerMerged": {
        if (!customerId || !dealerId) return { action: "ignored_no_customer" };
        const contact = await this.d.vin.getContact(customerId, dealerId);
        await this.d.store.upsertContact(contact);
        let n = 0;
        for (const c of await this.d.store.listConversations()) {
          if (c.contactId !== contact.id) continue;
          if (contact.smsConsent === "revoked" && c.state !== "opted_out") { await this.optOut(c.leadId, "vin_consent"); n++; }
          else if (contact.smsConsent === "granted" && c.smsConsent !== "granted") { await this.d.store.upsertConversation({ ...c, smsConsent: "granted", smsConsentPending: false }); n++; }
        }
        return { action: `consent_synced:${n}` };
      }
      case "VehicleOfInterestCreated":
      case "VehicleOfInterestUpdated": {
        if (!leadId) return { action: "ignored_no_lead" };
        const lead = await this.d.store.getLead(leadId);
        if (!lead) return { action: "no_conversation" };
        const vehicles = await this.d.vin.getLeadVehicles(leadId, lead.dealerId);
        await this.d.store.upsertLead({ ...lead, vehicles });
        return { action: "vehicles_refreshed" };
      }
      default:
        return { action: "ignored_type" };
    }
  }

  async loadBundle(lead: Lead): Promise<LeadBundle> {
    const [contact, rep, dealer] = await Promise.all([
      this.d.vin.getContact(lead.contactId, lead.dealerId),
      this.d.vin.getUser(lead.repId!, lead.dealerId),
      this.d.vin.getDealer(lead.dealerId),
    ]);
    if (lead.vehicles.length === 0) {
      try { lead = { ...lead, vehicles: await this.d.vin.getLeadVehicles(lead.id, lead.dealerId) }; } catch (e) { this.log.warn({ err: String(e) }, "vehicles lookup failed"); }
    }
    return { lead, contact, rep, dealer };
  }

  /* ---------------- Inbound ---------------- */

  async onInbound(input: { leadId?: string; fromPhone?: string; toPhone?: string; channel: Channel; body: string }): Promise<{ action: string }> {
    const now = this.now();
    const conv = input.leadId ? await this.d.store.getConversation(input.leadId) : await this.findByPhone(input.fromPhone, input.toPhone);
    if (!conv) return { action: "no_conversation" };
    const lead = (await this.d.store.getLead(conv.leadId))!;
    const contact = (await this.d.store.getContact(conv.contactId))!;
    const rep = (await this.d.store.getRep(conv.repId))!;

    await this.record(lead, { channel: input.channel, direction: "in", body: input.body, at: now });
    let c: Conversation = { ...conv, lastIn: now };
    await this.d.store.upsertConversation(c);

    const intents = classifyInbound(input.body);
    if (intents.includes("stop")) { await this.optOut(c.leadId, "customer_stop"); return { action: "opted_out" }; }
    if (c.state === "opted_out") return { action: "ignored_opted_out" };

    if (intents.includes("yes") && input.channel === "sms" && c.smsConsent !== "granted") {
      c = { ...c, smsConsent: "granted", smsConsentPending: false };
      await this.d.store.upsertConversation(c);
      await this.safe(() => this.d.vin.setSmsConsent(contact.id, lead.dealerId, true, "customer_yes_reply"), "mirror consent");
      if (intents.length === 1) {
        // The YES was the whole message. Send the real first text now.
        await this.deliver(c, rep, contact, "sms", { kind: "first_sms" });
        return { action: "consent_granted_first_sms" };
      }
    }
    if (c.state !== "active") return { action: `ignored_${c.state}` };

    const required: string[] = [];
    let availability: ComposeContext["availability"];
    if (intents.includes("real_person")) required.push(FIXED.realPerson(rep.firstName));
    if (intents.includes("price")) {
      c = { ...c, priceQuestions: c.priceQuestions + 1 };
      await this.d.store.upsertConversation(c);
      if (c.priceQuestions >= PRICE_QUESTIONS_BEFORE_HANDOFF) {
        await this.deliver(c, rep, contact, input.channel, { kind: "reply", intents, requiredLines: [FIXED.priceAsk(rep.firstName)], inbound: input.body });
        await this.handoff(c.leadId, "second price question");
        return { action: "handoff_price" };
      }
      required.push(FIXED.priceAsk(rep.firstName));
    }
    if (intents.includes("availability")) {
      availability = await this.checkAvailability(lead);
      if (availability === "unverified") required.push(FIXED.availabilityUnverified());
    }

    await this.deliver(c, rep, contact, input.channel, { kind: "reply", intents, requiredLines: required, inbound: input.body, availability });

    if (intents.includes("appointment")) { await this.handoff(c.leadId, "customer wants to schedule"); return { action: "handoff_appointment" }; }
    return { action: "replied" };
  }

  private async checkAvailability(lead: Lead): Promise<NonNullable<ComposeContext["availability"]>> {
    const v = lead.vehicles.find((x) => x.stockNumber || x.vin);
    if (!v) return "unverified";
    try {
      const inv = await this.d.vin.findInventory(lead.dealerId, { stockNumber: v.stockNumber, vin: v.vin });
      if (!inv) return "unverified";
      return inv.available ? "available" : "unavailable";
    } catch (e) {
      this.log.warn({ err: String(e) }, "inventory check failed");
      return "unverified";
    }
  }

  private async findByPhone(from?: string, to?: string): Promise<Conversation | undefined> {
    if (!from) return undefined;
    const convs = await this.d.store.listConversations();
    const matches: Conversation[] = [];
    for (const c of convs) {
      const contact = await this.d.store.getContact(c.contactId);
      if (contact?.phones.includes(from)) matches.push(c);
    }
    if (matches.length <= 1) return matches[0];
    // Same customer, several leads: prefer the rep whose number they texted, then the newest.
    if (to) {
      const rep = await this.d.store.findRepBySmsFrom(to);
      const byRep = matches.filter((c) => c.repId === rep?.id);
      if (byRep.length) matches.splice(0, matches.length, ...byRep);
    }
    return matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  }

  /* ---------------- Scheduled cadence ---------------- */

  async runDue(now: Date = this.now()): Promise<{ sent: number; deferred: number; dropped: number }> {
    const out = { sent: 0, deferred: 0, dropped: 0 };
    for (const step of await this.d.scheduler.due(now)) {
      try {
        const r = await this.runStep(step, now);
        out[r]++;
      } catch (e) {
        this.log.error({ err: String(e), step }, "step failed");
        if (step.attempts >= 3) { await this.d.scheduler.complete(step.id); out.dropped++; }
        else { await this.d.scheduler.reschedule(step.id, new Date(now.getTime() + 5 * 60_000)); out.deferred++; }
      }
    }
    return out;
  }

  private async runStep(step: ScheduledStep, now: Date): Promise<"sent" | "deferred" | "dropped"> {
    const conv = await this.d.store.getConversation(step.leadId);
    if (!conv || conv.state !== "active") { await this.d.scheduler.complete(step.id); return "dropped"; }
    const contact = (await this.d.store.getContact(conv.contactId))!;
    const rep = (await this.d.store.getRep(conv.repId))!;
    const lead = (await this.d.store.getLead(conv.leadId))!;

    if (isQuietHours(now, this.d.storeTz)) {
      await this.d.scheduler.reschedule(step.id, deferOutOfQuietHours(now, this.d.storeTz));
      return "deferred";
    }

    const hasPhone = contact.phones.length > 0;
    const hasEmail = contact.emails.length > 0 && !contact.emailOptOut;
    let channel = resolveChannel(step.kind, conv.smsConsent, hasPhone, hasEmail);
    let kind: ComposeKind = step.kind === "first_sms" ? "first_sms" : step.kind === "first_email" ? "first_email" : isLastStep(step.kind) ? "last_touch" : "follow_up";

    if (channel === "sms") {
      if (conv.smsConsent === "revoked") channel = hasEmail ? "email" : null;
      else if (conv.smsConsent === "unknown") {
        if (conv.smsConsentPending) channel = hasEmail && step.kind !== "first_sms" ? "email" : null; // no second text until YES
        else kind = "opt_in_request";
      }
    }
    if (!channel) { await this.d.scheduler.complete(step.id); await this.finishIfLast(step, lead); return "dropped"; }

    // Rule 2: no two messages on the same channel within 3 hours unless the customer replied.
    const last = conv.lastOut[channel];
    const repliedSince = conv.lastIn && last ? conv.lastIn.getTime() > last.getTime() : false;
    if (last && !repliedSince && now.getTime() - last.getTime() < SAME_CHANNEL_GAP_MS) {
      await this.d.scheduler.reschedule(step.id, deferOutOfQuietHours(new Date(last.getTime() + SAME_CHANNEL_GAP_MS), this.d.storeTz));
      return "deferred";
    }

    const requiredLines = kind === "opt_in_request" ? [FIXED.optInRequest(rep.firstName, (await this.d.vin.getDealer(lead.dealerId)).name || "the dealership")] : undefined;
    await this.deliver(conv, rep, contact, channel, { kind, requiredLines });
    if (kind === "opt_in_request") await this.d.store.upsertConversation({ ...(await this.d.store.getConversation(conv.leadId))!, smsConsentPending: true });
    await this.d.scheduler.complete(step.id);
    await this.finishIfLast(step, lead);
    return "sent";
  }

  private async finishIfLast(step: ScheduledStep, lead: Lead) {
    if (!isLastStep(step.kind)) return;
    const conv = await this.d.store.getConversation(step.leadId);
    if (!conv || conv.state !== "active") return;
    await this.d.store.upsertConversation({ ...conv, state: "silent", stateReason: "day3_complete" });
    await this.note(lead, "Assistant finished the 3-day cadence with no appointment. Handing back to Vin follow-up.");
  }

  /* ---------------- State transitions ---------------- */

  async goSilent(leadId: string, reason: string): Promise<boolean> {
    const conv = await this.d.store.getConversation(leadId);
    if (!conv) return false;
    if (conv.state !== "active") return true;
    await this.d.store.upsertConversation({ ...conv, state: "silent", stateReason: reason });
    await this.d.scheduler.cancelForLead(leadId);
    const lead = await this.d.store.getLead(leadId);
    if (lead) await this.note(lead, `Assistant paused (${reason.replace(/_/g, " ")}).`);
    return true;
  }

  async optOut(leadId: string, reason: string): Promise<void> {
    const conv = await this.d.store.getConversation(leadId);
    if (!conv) return;
    await this.d.store.upsertConversation({ ...conv, state: "opted_out", stateReason: reason, smsConsent: "revoked", smsConsentPending: false });
    await this.d.scheduler.cancelForLead(leadId);
    const lead = await this.d.store.getLead(leadId);
    if (lead) {
      if (reason !== "vin_consent") await this.safe(() => this.d.vin.setSmsConsent(conv.contactId, lead.dealerId, false, reason), "mirror opt-out");
      await this.note(lead, `Customer opted out of texts (${reason.replace(/_/g, " ")}). All assistant touches cancelled.`);
    }
  }

  async handoff(leadId: string, reason: string): Promise<void> {
    const conv = await this.d.store.getConversation(leadId);
    if (!conv || conv.state === "handed_off") return;
    const lead = (await this.d.store.getLead(leadId))!;
    const rep = (await this.d.store.getRep(conv.repId))!;
    const contact = (await this.d.store.getContact(conv.contactId))!;
    const dealer = await this.d.vin.getDealer(lead.dealerId);
    await this.d.store.upsertConversation({ ...conv, state: "handed_off", stateReason: reason });
    await this.d.scheduler.cancelForLead(leadId);

    const history = await this.d.store.listMessages(leadId);
    const summary = await this.template.compose({
      kind: "handoff_summary", channel: "email", rep, dealerName: dealer.name, customerFirstName: contact.firstName,
      vehicle: lead.vehicles[0], history, handoffReason: reason,
    });
    await this.note(lead, `HANDOFF to ${rep.firstName}: ${reason}.\n${summary.body}`);
    // Notify the rep on their own cell/email. This is rep-facing, not customer-facing, so no policy check.
    const fromSms = rep.smsFrom ?? this.d.defaultSmsFrom;
    if (rep.phone && fromSms) await this.safe(() => this.d.sms.sendSms({ from: fromSms, to: rep.phone!, body: `${contact.firstName} ${contact.lastName} (lead ${leadId}) is ready for you: ${reason}. Check the lead in Vin for the thread.` }), "rep sms");
    if (rep.email) await this.safe(() => this.d.email.sendEmail({ from: this.repFrom(rep), to: rep.email!, replyTo: this.repFrom(rep), subject: summary.subject ?? "Handoff", textBody: summary.body }), "rep email");
    this.log.info({ leadId, reason }, "handoff");
  }

  /* ---------------- Sending (the only path) ---------------- */

  private async deliver(conv: Conversation, rep: Rep, contact: Contact, channel: Channel, opts: Partial<ComposeContext> & { kind: ComposeKind }): Promise<Message> {
    const lead = (await this.d.store.getLead(conv.leadId))!;
    const dealer = await this.d.vin.getDealer(lead.dealerId);
    const history = await this.d.store.listMessages(conv.leadId);
    const ctx: ComposeContext = {
      channel, rep, dealerName: dealer.name || "the dealership", customerFirstName: contact.firstName, vehicle: lead.vehicles[0], history, ...opts,
    };
    const draft = await this.composeChecked(ctx, lead);
    const now = this.now();

    if (channel === "sms") {
      const to = contact.phones[0]!;
      const from = rep.smsFrom ?? this.d.defaultSmsFrom;
      if (!from) throw new Error("no sms from number configured");
      await this.d.sms.sendSms({ from, to, body: draft.body });
    } else {
      const to = contact.emails[0]!;
      await this.d.email.sendEmail({
        from: this.repFrom(rep), to, replyTo: `reply+${conv.leadId}@${this.d.emailFromDomain}`,
        subject: draft.subject ?? "Following up", textBody: draft.body, tag: ctx.kind, headers: { "X-Ricochet-Lead": conv.leadId },
      });
    }
    const msg = await this.record(lead, { channel, direction: "out", body: draft.body, subject: draft.subject, at: now, repId: rep.id });
    const fresh = (await this.d.store.getConversation(conv.leadId)) ?? conv;
    await this.d.store.upsertConversation({ ...fresh, lastOut: { ...fresh.lastOut, [channel]: now } });
    this.log.info({ leadId: conv.leadId, channel, kind: ctx.kind }, "sent");
    return msg;
  }

  /** Try the configured composer, feed violations back once, then fall back to templates. Never sends non-compliant text. */
  async composeChecked(ctx: ComposeContext, lead: Lead): Promise<ComposeResult> {
    const r = await composeCompliant(this.d.composer, this.template, ctx, lead.vehicles[0]?.listedPrice);
    if (r.rejected.length) this.log.warn({ leadId: lead.id, rejected: r.rejected, source: r.source }, "draft rejected, used fallback");
    return r.draft;
  }

  private repFrom(rep: Rep): string {
    return rep.emailFrom ?? `${rep.firstName.toLowerCase().replace(/[^a-z0-9]/g, "") || "assistant"}@${this.d.emailFromDomain}`;
  }

  private async record(lead: Lead, m: { channel: Channel; direction: "in" | "out"; body: string; subject?: string; at: Date; repId?: string }): Promise<Message> {
    const msg: Message = { id: randomUUID(), leadId: lead.id, channel: m.channel, direction: m.direction, body: m.body, subject: m.subject, at: m.at, vinLogged: false };
    await this.d.store.addMessage(msg);
    await this.safe(async () => {
      await this.d.vin.logActivity({ leadId: lead.id, dealerId: lead.dealerId, channel: m.channel, direction: m.direction, body: m.body, subject: m.subject, at: m.at, repId: m.repId });
      msg.vinLogged = true;
    }, "vin log");
    return msg;
  }

  private async note(lead: Lead, text: string) {
    await this.safe(() => this.d.vin.addLeadNote(lead.id, lead.dealerId, `[Ricochet] ${text}`), "vin note");
  }

  private async safe(fn: () => Promise<unknown>, what: string) {
    try { await fn(); } catch (e) { this.log.warn({ err: String(e) }, `${what} failed`); }
  }
}
