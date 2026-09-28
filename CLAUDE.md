# Ricochet — project context for Claude Code

Read this first in every session. It captures decisions made before this repo existed.

## What Ricochet is
A per-salesperson AI lead-response assistant for car dealerships on VinSolutions (Cox Automotive) Connect CRM.
When an internet lead is assigned to a salesperson, that rep's assistant texts and emails the customer within 1–2 minutes
in the rep's own voice, answers basic questions, pushes toward a phone call or in-store appointment, then hands off to
the rep with a summary. Everything is logged back to the lead in Vin.

Positioning: NOT a store-level "AI BDC" (that's Impel, Mia, Numa, Vinessa). Each rep gets their own assistant, set up by
them in a 5-minute simulation, so nobody's leads get taken and it doesn't sound automated.

## People and status
- Founder: Hameed Shaik, hameed@getricochet.live, (925) 523-9256. Domain getricochet.live (Squarespace, Google Workspace).
- Entity not yet formed. NDA signed as "Hameed Shaik d/b/a Ricochet". Form an LLC/Inc before signing Cox Step 2.
- Dealer: 12-store Honda/Mazda group in the Bay Area. Pilot store: Dublin Mazda (Vin dealer #14011). Contact via a friend.
  Dealer wants: human voice calls only (no AI voice), text only after opt-in, email-first is fine, no bots logged into
  workstations, strict data security (Vin holds SSNs/income). Reps get 10–20 leads/day per store. Round-robin routing with
  15-minute rollover to the next rep. Baseline from Vin Insights: 81% of leads missed the 15-minute window; 44 leads → 21
  contacted → 3 appts → 1 sold over 14 days.
- Cox: contact Jason McCallum, Vendor API Services (Jason.McCallum@coxautoinc.com), cc Jennifer, Chris.
  Sandbox approved 9/18/2026 for Lead Management 1.0 and Connect Event Solution 1.0. "Integration" env for Lead
  Management requested 9/20, pending. Step 2 Service Agreement NOT signed yet (triggers $2,000 setup + $1,000/plan/yr;
  $65 + $50 per rooftop per month once live). 10–15 business days for integration credentials after Step 2.
  Open questions for Jason: (1) any way to send email/SMS through Vin, or log-only? (2) does Eventing carry its own
  annual fee? (3) can Lead Management create appointments? (4) does it expose lead activity history?
  Jason said: Lead Management covers Contact Management + Lead Submission; Digital Showroom can add notes and create a
  showroom visit; "request any related APIs and we'll approve."

## Cox sandbox facts
- Lead Management: API key auth (`x-api-key`), base https://sandbox.api.vinsolutions.com,
  `Accept`/`Content-Type: application/vnd.coxauto.v3+json`.
- Connect Event Service: OAuth client_credentials + `x-api-key`, base
  https://sandbox.api.coxautoinc.com/vinsolutions/eventingapi, `application/vnd.coxauto.v1+json`, scope PublicAPI.
- Events are delivered by push to an Event Sink you register in the storefront (destination URL, auth type, rate limit).
  Event types: AppointmentUpdated, ConsentUpdated, CustomerCreated/Updated/Merged, LastContactAttemptUpdated,
  LeadCreated, LeadUpdated, ShowroomVisitCompleted, VehicleOfInterestCreated/Updated.
  Order is NOT guaranteed. Dedupe on TrackingId. Payload fields: Type, TrackingId, OccurredUtc, LeadId, CustomerId,
  DealerId, Version.
- Sandbox = one dealership. Production = all dealers who authorize us via invitation code.
- Keys live in .env only. Never commit. Rotate anything that was ever pasted into a chat or screenshot.

## Product rules (non-negotiable)
1. SMS only with recorded consent: TCPAOptIn=true from the lead source, ConsentUpdated from Vin, or a YES reply.
   Otherwise the first text is an opt-in request only. STOP → opt out, cancel everything, mirror to Vin.
2. Cadence: text at +1 min, email at +2 min, email +3h10m, next morning, day 2, day 3 last touch, then hand back to
   Vin's own follow-up process. Email-only leads get the email at +1. Nothing between 9pm–8am store time (deferred).
   No two messages on the same channel within 3 hours unless the customer replied.
3. Price: only the listed price the customer already saw, plus "we're willing to work with you." Never OTD, discounts,
   fees, rates, payments, or ranges. Every price question ends in a call/visit ask. Two price questions → handoff.
4. Availability only asserted when verified against inventory; otherwise "let me confirm and get right back."
5. Assistant goes silent on: rep activity on the lead (LastContactAttemptUpdated), opt-out, handoff, appointment set,
   day 3. Reassignment (LeadUpdated with new rep) switches persona, keeps the thread.
6. If asked "is this a real person": it is the rep's assistant helping with scheduling; the rep is who they'll deal with.
   Never claim to be the rep. Never volunteer that it's AI otherwise. (California B&P §17941.)
7. Human-sounding: no em dashes, semicolons, bullets, or the banned phrases in src/engine/policy.ts. Short. One idea per
   message. Casual punctuation. Reps' own samples drive the voice; policy is fixed.
8. No browser automation of Vin. API only. No persistent user sessions.
9. Store only what's needed: lead/contact/vehicle fields and message text. No financial, credit, or identity data.
   Voice samples are the rep's outbound text only, customer PII stripped.

## Architecture
- Node 22 + TypeScript, Fastify, Postgres (memory store in dev), Fly.io (always-on machine, sjc).
- `src/engine/orchestrator.ts` is the ONLY thing that sends. Adapters never send.
- `src/adapters/vin/cox.ts` — every method marked TODO(cox) must be implemented against the OpenAPI specs in `docs/`.
- Messaging: Twilio (one local number per rep, 10DLC registered) + Postmark (per-rep from-address on a sending
  subdomain, reply+<leadId>@ inbound routing, open tracking). Cox does not send for us; we log every message to the lead.
- Rep onboarding: `src/api/setup.html` — 7-turn simulated customer, style knobs, 3-message preview, save → voice profile.

## Pilot metrics (baseline → 60-day target)
Responded within 15 min: 20% → 95% (within 2 min). Leads contacted: 48% → 80%. Appointments per 100 leads: ~7 → 15+.

## Immediate next steps
1. Put OpenAPI specs for both products in `docs/` (download from storefront product pages).
2. Implement CoxAdapter + event-sink verification; run against sandbox dealer.
3. Deploy to Fly; register Event Sink pointing at /webhooks/cox/events.
4. Twilio account + 10DLC brand/campaign; Postmark sending domain mail.getricochet.live with SPF/DKIM/DMARC.
5. PgStore + scheduled_steps runner (replace MemoryStore/MemoryScheduler in prod).
6. Manager dashboard (leads today, assistant engaged, replied, appointment set, handed off).

## Always
`npm test` before finishing any change. Keep this file updated when a decision changes.
