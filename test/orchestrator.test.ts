import { test } from "node:test";
import assert from "node:assert/strict";
import { world, MIN, HOUR } from "./helpers.js";
import type { Composer, ComposeContext } from "../src/engine/composer.js";

test("assignment plans the cadence and notes Vin", async () => {
  const w = world();
  await w.orchestrator.onLeadAssigned({ lead: w.lead, rep: w.rep, contact: w.contact, dealer: w.dealer });
  assert.equal((await w.scheduler.pendingForLead("77001")).length, 6);
  assert.ok(w.vin.notes.some((n) => n.note.includes("Assistant engaged")));
  await w.orchestrator.onLeadAssigned({ lead: w.lead, rep: w.rep, contact: w.contact, dealer: w.dealer });
  assert.equal((await w.scheduler.pendingForLead("77001")).length, 6, "idempotent");
});

test("without consent the first text is an opt-in request, YES unlocks the real first text", async () => {
  const w = world();
  await w.orchestrator.onLeadAssigned({ lead: w.lead, rep: w.rep, contact: w.contact, dealer: w.dealer });
  w.clock.advance(1 * MIN);
  await w.orchestrator.runDue();
  assert.equal(w.senders.sms.length, 1);
  assert.ok(w.senders.sms[0]!.body.includes("Reply YES"));
  assert.equal(w.senders.sms[0]!.to, "+19255550142"); assert.equal(w.senders.sms[0]!.from, "+19255550100");
  assert.ok(w.vin.activity.some((a) => a.direction === "out" && a.channel === "sms"), "logged to Vin");

  await w.orchestrator.onInbound({ fromPhone: "+19255550142", toPhone: "+19255550100", channel: "sms", body: "YES" });
  assert.equal(w.senders.sms.length, 2);
  assert.ok(w.senders.sms[1]!.body.includes("CX-5"));
  assert.equal((await w.store.getConversation("77001"))!.smsConsent, "granted");
  assert.deepEqual(w.vin.consent[0], { contactId: "9001", granted: true, source: "customer_yes_reply" });
});

test("TCPA opt-in from the source skips the opt-in request", async () => {
  const w = world({ lead: { tcpaOptIn: true } });
  await w.orchestrator.onLeadAssigned({ lead: w.lead, rep: w.rep, contact: w.contact, dealer: w.dealer });
  w.clock.advance(1 * MIN); await w.orchestrator.runDue();
  assert.ok(!w.senders.sms[0]!.body.includes("Reply YES"));
});

test("email at +2, then 3h10m email, same-channel spacing is enforced", async () => {
  const w = world({ lead: { tcpaOptIn: true } });
  await w.orchestrator.onLeadAssigned({ lead: w.lead, rep: w.rep, contact: w.contact, dealer: w.dealer });
  w.clock.advance(2 * MIN); await w.orchestrator.runDue();
  assert.equal(w.senders.emails.length, 1);
  assert.equal(w.senders.emails[0]!.replyTo, "reply+77001@mail.getricochet.live");
  assert.equal(w.senders.emails[0]!.from, "sam@mail.getricochet.live");
  // Force an email step early: it must be deferred, not sent.
  const step = (await w.scheduler.pendingForLead("77001")).find((s) => s.kind === "email_3h")!;
  await w.scheduler.reschedule(step.id, w.clock.advance(30 * MIN));
  const r = await w.orchestrator.runDue();
  assert.equal(r.deferred, 1); assert.equal(w.senders.emails.length, 1);
  w.clock.advance(3 * HOUR); await w.orchestrator.runDue();
  assert.equal(w.senders.emails.length, 2);
});

test("STOP opts out, cancels everything, mirrors to Vin, and later steps do nothing", async () => {
  const w = world({ lead: { tcpaOptIn: true } });
  await w.orchestrator.onLeadAssigned({ lead: w.lead, rep: w.rep, contact: w.contact, dealer: w.dealer });
  w.clock.advance(1 * MIN); await w.orchestrator.runDue();
  const r = await w.orchestrator.onInbound({ fromPhone: "+19255550142", channel: "sms", body: "STOP" });
  assert.equal(r.action, "opted_out");
  assert.equal((await w.scheduler.pendingForLead("77001")).length, 0);
  assert.equal((await w.store.getConversation("77001"))!.state, "opted_out");
  assert.deepEqual(w.vin.consent.at(-1), { contactId: "9001", granted: false, source: "customer_stop" });
  const before = w.senders.sms.length;
  w.clock.advance(24 * HOUR); await w.orchestrator.runDue();
  assert.equal(w.senders.sms.length, before);
});

test("price question gets the fixed line, second one hands off to the rep", async () => {
  const w = world({ lead: { tcpaOptIn: true } });
  await w.orchestrator.onLeadAssigned({ lead: w.lead, rep: w.rep, contact: w.contact, dealer: w.dealer });
  w.clock.advance(1 * MIN); await w.orchestrator.runDue();
  await w.orchestrator.onInbound({ fromPhone: "+19255550142", channel: "sms", body: "what's your best price?" });
  const reply1 = w.senders.sms.at(-1)!.body;
  assert.ok(reply1.includes("listed price is what you saw online"), reply1);
  assert.ok(!/\$\d/.test(reply1));
  const r = await w.orchestrator.onInbound({ fromPhone: "+19255550142", channel: "sms", body: "would you take 30k out the door" });
  assert.equal(r.action, "handoff_price");
  const conv = (await w.store.getConversation("77001"))!;
  assert.equal(conv.state, "handed_off");
  assert.ok(w.vin.notes.some((n) => n.note.includes("HANDOFF")));
  assert.ok(w.senders.sms.some((s) => s.to === "+19255550101" && s.body.includes("ready for you")), "rep got a text");
  assert.ok(w.senders.emails.some((e) => e.to === "sam@example.com" && e.subject?.startsWith("Handoff")), "rep got an email");
  assert.equal((await w.scheduler.pendingForLead("77001")).length, 0);
});

test("availability is only asserted when inventory confirms it", async () => {
  const w = world({ lead: { tcpaOptIn: true } });
  await w.orchestrator.onLeadAssigned({ lead: w.lead, rep: w.rep, contact: w.contact, dealer: w.dealer });
  await w.orchestrator.onInbound({ fromPhone: "+19255550142", channel: "sms", body: "is it still available?" });
  assert.ok(w.senders.sms.at(-1)!.body.includes("still here"));
  w.vin.inventory[0]!.available = false;
  await w.orchestrator.onInbound({ fromPhone: "+19255550142", channel: "sms", body: "still have it?" });
  assert.ok(w.senders.sms.at(-1)!.body.includes("just went"));
  w.vin.inventory.length = 0;
  await w.orchestrator.onInbound({ fromPhone: "+19255550142", channel: "sms", body: "do you have it" });
  assert.ok(w.senders.sms.at(-1)!.body.includes("Let me confirm that"));
});

test("real person question gets the disclosure and never claims to be the rep", async () => {
  const w = world({ lead: { tcpaOptIn: true } });
  await w.orchestrator.onLeadAssigned({ lead: w.lead, rep: w.rep, contact: w.contact, dealer: w.dealer });
  await w.orchestrator.onInbound({ fromPhone: "+19255550142", channel: "sms", body: "is this a real person?" });
  const b = w.senders.sms.at(-1)!.body;
  assert.ok(b.includes("I'm Sam's assistant and I help with scheduling"));
});

test("rep activity silences the assistant, customer replies are logged but not answered", async () => {
  const w = world({ lead: { tcpaOptIn: true } });
  await w.orchestrator.onLeadAssigned({ lead: w.lead, rep: w.rep, contact: w.contact, dealer: w.dealer });
  const r = await w.orchestrator.onCoxEvent({ Type: "LastContactAttemptUpdated", TrackingId: "t1", OccurredUtc: "", LeadId: "77001", DealerId: "14011" });
  assert.equal(r.action, "silenced_rep_activity");
  assert.equal((await w.scheduler.pendingForLead("77001")).length, 0);
  const before = w.senders.sms.length;
  const ri = await w.orchestrator.onInbound({ fromPhone: "+19255550142", channel: "sms", body: "hey what's up" });
  assert.equal(ri.action, "ignored_silent");
  assert.equal(w.senders.sms.length, before);
  assert.ok(w.vin.activity.some((a) => a.direction === "in"));
});

test("Cox events: LeadCreated assigns via Vin reads, AppointmentUpdated silences, ConsentUpdated syncs", async () => {
  const w = world();
  const r1 = await w.orchestrator.onCoxEvent({ Type: "LeadCreated", TrackingId: "a", OccurredUtc: "", LeadId: "77001", DealerId: "14011" });
  assert.equal(r1.action, "lead_assigned");
  assert.equal((await w.scheduler.pendingForLead("77001")).length, 6);
  w.vin.contacts.get("9001")!.smsConsent = "granted";
  await w.orchestrator.onCoxEvent({ Type: "ConsentUpdated", TrackingId: "b", OccurredUtc: "", CustomerId: "9001", DealerId: "14011" });
  assert.equal((await w.store.getConversation("77001"))!.smsConsent, "granted");
  const r3 = await w.orchestrator.onCoxEvent({ Type: "AppointmentUpdated", TrackingId: "c", OccurredUtc: "", LeadId: "77001" });
  assert.equal(r3.action, "silenced_appointment");
  w.vin.leads.get("77001")!.repId = undefined;
  const r4 = await w.orchestrator.onCoxEvent({ Type: "LeadCreated", TrackingId: "d", OccurredUtc: "", LeadId: "77001" });
  assert.equal(r4.action, "waiting_for_assignment");
});

test("reassignment switches persona and keeps the thread", async () => {
  const w = world({ lead: { tcpaOptIn: true } });
  await w.orchestrator.onLeadAssigned({ lead: w.lead, rep: w.rep, contact: w.contact, dealer: w.dealer });
  w.clock.advance(1 * MIN); await w.orchestrator.runDue();
  const rep2 = { ...w.rep, id: "502", firstName: "Alex", smsFrom: "+19255550200" };
  await w.orchestrator.onLeadAssigned({ lead: { ...w.lead, repId: "502" }, rep: rep2, contact: w.contact, dealer: w.dealer });
  const conv = (await w.store.getConversation("77001"))!;
  assert.equal(conv.repId, "502");
  assert.equal((await w.scheduler.pendingForLead("77001")).length, 5, "remaining steps kept");
  assert.equal((await w.store.listMessages("77001")).length, 1, "thread kept");
  await w.orchestrator.onInbound({ fromPhone: "+19255550142", channel: "sms", body: "who is this" });
  assert.ok(w.senders.sms.at(-1)!.body.includes("Alex"));
});

test("day 3 last touch ends the cadence and hands back to Vin", async () => {
  const w = world({ lead: { tcpaOptIn: true } });
  await w.orchestrator.onLeadAssigned({ lead: w.lead, rep: w.rep, contact: w.contact, dealer: w.dealer });
  for (let i = 0; i < 4 * 24; i++) { w.clock.advance(1 * HOUR); await w.orchestrator.runDue(); }
  assert.equal((await w.store.getConversation("77001"))!.state, "silent");
  assert.ok(w.vin.notes.some((n) => n.note.includes("Handing back to Vin")));
  assert.equal(w.senders.sms.length + w.senders.emails.length, 6);
});

test("quiet hours: steps due at night wait for 8am", async () => {
  const w = world({ lead: { tcpaOptIn: true } });
  w.clock.set(new Date("2026-09-29T05:30:00Z")); // 10:30pm PDT
  await w.orchestrator.onLeadAssigned({ lead: { ...w.lead, createdAt: w.clock.now }, rep: w.rep, contact: w.contact, dealer: w.dealer });
  w.clock.advance(5 * MIN); await w.orchestrator.runDue();
  assert.equal(w.senders.sms.length, 0);
  w.clock.set(new Date("2026-09-29T15:01:00Z")); // 8:01am PDT
  await w.orchestrator.runDue();
  assert.equal(w.senders.sms.length, 1);
});

test("a non-compliant LLM draft is rejected and the template is sent instead", async () => {
  const seen: ComposeContext[] = [];
  const bad: Composer = { async compose(ctx) { seen.push(ctx); return { body: "I can do $29,000 out the door — no fees; just say yes!" }; } };
  const w = world({ composer: bad, lead: { tcpaOptIn: true } });
  await w.orchestrator.onLeadAssigned({ lead: w.lead, rep: w.rep, contact: w.contact, dealer: w.dealer });
  w.clock.advance(1 * MIN); await w.orchestrator.runDue();
  assert.equal(seen.length, 2, "one retry with feedback");
  assert.ok(seen[1]!.feedback!.length > 0);
  const sent = w.senders.sms[0]!.body;
  assert.ok(!sent.includes("$") && !sent.includes("—") && !sent.includes(";"));
});

test("email-only lead never gets an sms and replies by email", async () => {
  const w = world({ contact: { phones: [] } });
  await w.orchestrator.onLeadAssigned({ lead: w.lead, rep: w.rep, contact: w.contact, dealer: w.dealer });
  w.clock.advance(1 * MIN); await w.orchestrator.runDue();
  assert.equal(w.senders.sms.length, 0); assert.equal(w.senders.emails.length, 1);
  await w.orchestrator.onInbound({ leadId: "77001", channel: "email", body: "Can I come by Saturday?" });
  assert.equal(w.senders.emails.filter((e) => e.to === "jordan@example.com").length, 2, "customer got the reply by email");
  assert.equal(w.senders.emails.filter((e) => e.to === "sam@example.com").length, 1, "rep got the handoff");
  assert.equal((await w.store.getConversation("77001"))!.state, "handed_off");
});
