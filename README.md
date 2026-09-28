# Ricochet

Per-salesperson AI lead-response assistant for dealerships on VinSolutions Connect CRM.
Read `CLAUDE.md` first. It holds the product rules, the Cox facts, and the decisions behind this code.

## Quick start

```bash
npm install
cp .env.example .env        # fill in keys, never commit
npm test                    # 51 tests, all fakes, no network
npm run dev                 # http://localhost:8080 with a seeded fake dealer
```

Without Cox keys the server runs against `FakeVinAdapter` with a seeded lead (`77001`), rep (`501`) and contact (`9001`).
Without Twilio or Postmark keys, outbound messages print to the console. Without an LLM key, the deterministic
`TemplateComposer` writes every message.

```bash
npm run cox:simulate -- LeadCreated 77001            # push a fake Cox event at the local sink
curl localhost:8080/api/conversations                 # watch the cadence get planned
open http://localhost:8080/setup                     # rep onboarding simulation
```

## Layout

```
src/engine/orchestrator.ts   the ONLY thing that sends. Lead lifecycle, inbound handling, cadence runner, handoff
src/engine/policy.ts         fixed rules: banned phrases, style, price guard, inbound intent classification
src/engine/cadence.ts        rule 2 schedule, store-time quiet hours, DST-safe morning steps
src/engine/compliance.ts     LLM draft -> policy check -> one retry -> template fallback
src/engine/templateComposer.ts  deterministic, always-compliant messages
src/llm/                     OpenAI (default) and Claude composers sharing one prompt
src/adapters/vin/cox.ts      CoxAdapter (Lead Management) + CoxEventsClient (Connect Event Service)
src/adapters/vin/fake.ts     FakeVinAdapter for tests and local dev
src/adapters/messaging/      Twilio and Postmark over fetch, plus fakes
src/webhooks/coxSinkAuth.ts  event-sink auth (header / basic / bearer), IP allowlist, payload parsing
src/api/routes/coxEvents.ts  POST /webhooks/cox/events
src/api/routes/inbound.ts    POST /webhooks/twilio/sms, POST /webhooks/postmark/inbound
src/api/routes/setup.ts      rep onboarding API, src/api/setup.html is the page
src/store/, src/scheduler/   interfaces + memory implementations (Postgres is next-steps #5)
scripts/cox-spec-check.ts    verifies ENDPOINTS against docs/cox/*.openapi.json
scripts/sandbox-smoke.ts     hits the sandbox dealer end to end
scripts/simulate-event.ts    posts a Cox-shaped event at the local sink
```

## Cox integration

Every REST path the adapter uses lives in `ENDPOINTS` at the top of `src/adapters/vin/cox.ts`.
Put the two OpenAPI specs in `docs/cox/` (see `docs/cox/README.md`) and run:

```bash
npm run cox:spec-check
```

It fails with the nearest matching paths if anything in the table is not in the spec. Then:

```bash
npm run cox:smoke                          # token, event types, sinks, dealer
npm run cox:smoke -- --lead <leadId>       # lead -> contact -> user -> vehicles -> inventory
npm run cox:smoke -- --lead <leadId> --note   # also writes one [Ricochet] note
```

### What the sandbox taught us (9/27/2026)

Lead Management needs `api_key` (not `x-api-key`) plus the OAuth bearer. Leads are v4, vehicles v1, contacts v3.
Hrefs point at production and get rebased. Contacts need a `userId` from Cox. Users, dealers, inventory and notes are
not in the sandbox plan yet. The `ENDPOINTS` table marks what has been seen working. Full notes in `CLAUDE.md`.

### Event sink

Register `PUBLIC_BASE_URL/webhooks/cox/events` in the storefront. Pick the auth type there and mirror it in `.env`:

| Storefront auth | `.env` |
|---|---|
| Custom header | `COX_SINK_AUTH_MODE=header`, `COX_SINK_HEADER_NAME`, `COX_SINK_SECRET` |
| Basic | `COX_SINK_AUTH_MODE=basic`, `COX_SINK_BASIC_USER`, `COX_SINK_BASIC_PASS` |
| Bearer token | `COX_SINK_AUTH_MODE=bearer`, `COX_SINK_SECRET` |

Deliveries are deduped on `TrackingId`. Order is not guaranteed, so every handler re-reads current state from Vin.
The sink never returns 5xx for processing failures (that would cause redelivery storms). Per-event status is in the response body.

## Deploy (Fly.io, sjc, always on)

```bash
fly launch --copy-config --no-deploy
fly secrets set COX_LM_API_KEY=... COX_EVENTS_API_KEY=... COX_EVENTS_CLIENT_ID=... COX_EVENTS_CLIENT_SECRET=... \
  COX_SINK_SECRET=... TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... POSTMARK_SERVER_TOKEN=... POSTMARK_INBOUND_SECRET=... \
  OPENAI_API_KEY=... SETUP_ADMIN_TOKEN=... PUBLIC_BASE_URL=https://ricochet.fly.dev
fly deploy
```

Production refuses to boot without Cox, Twilio and Postmark credentials, and refuses `COX_SINK_AUTH_MODE=none`.

## Rules the code enforces

See `CLAUDE.md` "Product rules". In short: no SMS without recorded consent, fixed cadence with quiet hours and
3-hour same-channel spacing, no price beyond the listed price, availability only when inventory confirms it,
silence on rep activity, fixed disclosure when asked if it is a real person, human-sounding text, API only, minimal data.
