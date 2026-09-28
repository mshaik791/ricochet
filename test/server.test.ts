import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { buildServer } from "../src/api/server.js";
import { loadConfig } from "../src/config.js";
import { world } from "./helpers.js";

async function app(envOverrides: Record<string, string> = {}, wOpts: Parameters<typeof world>[0] = {}) {
  const w = world(wOpts);
  const config = loadConfig({
    NODE_ENV: "test", COX_SINK_AUTH_MODE: "header", COX_SINK_SECRET: "s3cret", PUBLIC_BASE_URL: "https://ricochet.example",
    TWILIO_AUTH_TOKEN: "twtoken", POSTMARK_INBOUND_SECRET: "pmsecret", ...envOverrides,
  });
  const server = await buildServer({ config, orchestrator: w.orchestrator, store: w.store, scheduler: w.scheduler, composer: w.orchestrator["d"].composer, composerName: "template", vinName: "fake", logger: false });
  return { server, w, config };
}
const ev = (over: Record<string, unknown> = {}) => ({ Type: "LeadCreated", TrackingId: "t-" + Math.random(), OccurredUtc: new Date().toISOString(), LeadId: 77001, CustomerId: 9001, DealerId: 14011, Version: 1, ...over });

test("healthz", async () => {
  const { server } = await app();
  const r = await server.inject({ method: "GET", url: "/healthz" });
  assert.equal(r.statusCode, 200); assert.equal(r.json().ok, true);
});

test("cox sink: 401 without auth, 400 malformed, 202 processed, 200 duplicate, vendor media type parsed", async () => {
  const { server, w } = await app();
  const hdr = { "content-type": "application/vnd.coxauto.v1+json", "x-ricochet-sink-key": "s3cret" };
  assert.equal((await server.inject({ method: "POST", url: "/webhooks/cox/events", headers: { "content-type": "application/json" }, payload: ev() })).statusCode, 401);
  assert.equal((await server.inject({ method: "POST", url: "/webhooks/cox/events", headers: { ...hdr, "x-ricochet-sink-key": "nope" }, payload: ev() })).statusCode, 401);
  assert.equal((await server.inject({ method: "POST", url: "/webhooks/cox/events", headers: hdr, payload: JSON.stringify({ TrackingId: "x" }) })).statusCode, 400);
  const e = ev();
  const ok = await server.inject({ method: "POST", url: "/webhooks/cox/events", headers: hdr, payload: JSON.stringify(e) });
  assert.equal(ok.statusCode, 202);
  assert.equal(ok.json().results[0].action, "lead_assigned");
  assert.ok(await w.store.getConversation("77001"));
  const dup = await server.inject({ method: "POST", url: "/webhooks/cox/events", headers: hdr, payload: JSON.stringify(e) });
  assert.equal(dup.statusCode, 200); assert.equal(dup.json().results[0].status, "duplicate");
  const unknown = await server.inject({ method: "POST", url: "/webhooks/cox/events", headers: hdr, payload: JSON.stringify(ev({ Type: "SomethingNew" })) });
  assert.equal(unknown.statusCode, 202); assert.equal(unknown.json().results[0].status, "ignored_unknown_type");
  const batch = await server.inject({ method: "POST", url: "/webhooks/cox/events", headers: hdr, payload: JSON.stringify([ev({ Type: "LastContactAttemptUpdated" }), ev({ Type: "LeadUpdated" })]) });
  assert.equal(batch.json().received, 2);
  assert.equal((await server.inject({ method: "GET", url: "/webhooks/cox/events" })).statusCode, 200);
});

test("cox sink: processing errors return 202 with per-event error, never 5xx", async () => {
  const { server } = await app();
  const r = await server.inject({ method: "POST", url: "/webhooks/cox/events", headers: { "content-type": "application/json", "x-ricochet-sink-key": "s3cret" }, payload: ev({ LeadId: 999999 }) });
  assert.equal(r.statusCode, 202); assert.equal(r.json().results[0].status, "error");
});

test("cox sink: basic and bearer modes and ip allowlist via config", async () => {
  const basic = await app({ COX_SINK_AUTH_MODE: "basic", COX_SINK_BASIC_USER: "cox", COX_SINK_BASIC_PASS: "pw" });
  const auth = "Basic " + Buffer.from("cox:pw").toString("base64");
  assert.equal((await basic.server.inject({ method: "POST", url: "/webhooks/cox/events", headers: { "content-type": "application/json", authorization: auth }, payload: ev() })).statusCode, 202);
  assert.equal((await basic.server.inject({ method: "POST", url: "/webhooks/cox/events", headers: { "content-type": "application/json" }, payload: ev() })).statusCode, 401);
  const bearer = await app({ COX_SINK_AUTH_MODE: "bearer", COX_SINK_ALLOWED_IPS: "10.0.0.0/8" });
  assert.equal((await bearer.server.inject({ method: "POST", url: "/webhooks/cox/events", headers: { "content-type": "application/json", authorization: "Bearer s3cret" }, payload: ev() })).statusCode, 401, "ip blocked");
  assert.equal((await bearer.server.inject({ method: "POST", url: "/webhooks/cox/events", remoteAddress: "10.1.2.3", headers: { "content-type": "application/json", authorization: "Bearer s3cret" }, payload: ev() })).statusCode, 202);
});

test("config refuses sink mode none in production", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production", COX_SINK_AUTH_MODE: "none" }));
});

test("twilio inbound: signature verified, STOP handled, TwiML returned", async () => {
  const { server, w } = await app({}, { lead: { tcpaOptIn: true } });
  await w.orchestrator.onLeadAssigned({ lead: w.lead, rep: w.rep, contact: w.contact, dealer: w.dealer });
  const params = { From: "+19255550142", To: "+19255550100", Body: "STOP" };
  const url = "https://ricochet.example/webhooks/twilio/sms";
  const sig = createHmac("sha1", "twtoken").update(url + Object.keys(params).sort().map((k) => k + (params as any)[k]).join("")).digest("base64");
  const bad = await server.inject({ method: "POST", url: "/webhooks/twilio/sms", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "nope" }, payload: new URLSearchParams(params).toString() });
  assert.equal(bad.statusCode, 403);
  const ok = await server.inject({ method: "POST", url: "/webhooks/twilio/sms", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig }, payload: new URLSearchParams(params).toString() });
  assert.equal(ok.statusCode, 200); assert.ok(ok.body.includes("<Response></Response>"));
  assert.equal((await w.store.getConversation("77001"))!.state, "opted_out");
});

test("postmark inbound: secret required, MailboxHash routes to the lead", async () => {
  const { server, w } = await app({}, { lead: { tcpaOptIn: true } });
  await w.orchestrator.onLeadAssigned({ lead: w.lead, rep: w.rep, contact: w.contact, dealer: w.dealer });
  const payload = { MailboxHash: "77001", ToFull: [{ Email: "reply+77001@mail.getricochet.live" }], StrippedTextReply: "Is it still available?", TextBody: "Is it still available?\n\n> quoted" };
  assert.equal((await server.inject({ method: "POST", url: "/webhooks/postmark/inbound", payload })).statusCode, 401);
  const ok = await server.inject({ method: "POST", url: "/webhooks/postmark/inbound?secret=pmsecret", payload });
  assert.equal(ok.statusCode, 200); assert.equal(ok.json().action, "replied");
  assert.equal(w.senders.emails.length, 1);
  assert.ok(w.senders.emails[0]!.textBody.includes("still here"));
});

test("setup: 7-turn simulation, preview, save voice profile with PII stripped", async () => {
  const { server, w } = await app({ SETUP_ADMIN_TOKEN: "admin" });
  assert.equal((await server.inject({ method: "GET", url: "/setup" })).statusCode, 401);
  const page = await server.inject({ method: "GET", url: "/setup?token=admin" });
  assert.equal(page.statusCode, 200); assert.ok(page.body.includes("<title>Ricochet setup</title>"));
  const s = (await server.inject({ method: "POST", url: "/api/setup/session", headers: { "x-setup-token": "admin" }, payload: { repId: "501", firstName: "Sam", lastName: "Rivera", dealerName: "Dublin Mazda" } })).json();
  assert.equal(s.turn, 1); assert.equal(s.totalTurns, 7);
  const replies = ["Yep still here! Want to swing by?", "Best I can do is $29,500 out the door — deal?", "Come in and we'll make it work", "Trade helps, bring it in", "Ha, real person. Sam here.", "Saturday works, we close at 8", "Sure, text me at 925-555-0101 or jordan@x.com and I'll send it"];
  let last: any;
  for (const r of replies) last = (await server.inject({ method: "POST", url: "/api/setup/turn", headers: { "x-setup-token": "admin" }, payload: { sessionId: s.sessionId, repMessage: r } })).json();
  assert.equal(last.done, true);
  const pv = (await server.inject({ method: "POST", url: "/api/setup/preview", headers: { "x-setup-token": "admin" }, payload: { sessionId: s.sessionId, knobs: { greeting: "Hey", emoji: true } } })).json();
  assert.equal(pv.previews.length, 3);
  assert.ok(pv.previews.every((p: any) => !p.body.includes("—") && !/\$\d/.test(p.body) || p.body.includes("33,450")));
  const saved = (await server.inject({ method: "POST", url: "/api/setup/save", headers: { "x-setup-token": "admin" }, payload: { sessionId: s.sessionId, knobs: { greeting: "Hey" }, smsFrom: "+19255550100" } })).json();
  assert.equal(saved.saved, true);
  const rep = (await w.store.getRep("501"))!;
  assert.equal(rep.voice!.samples.length, 7);
  assert.ok(!rep.voice!.samples.join(" ").includes("925-555-0101"));
  assert.ok(!rep.voice!.samples.join(" ").includes("jordan@x.com"));
  assert.ok(rep.voice!.samples.some((x) => x.includes("[phone]") && x.includes("[email]")));
  assert.equal(rep.voice!.knobs.greeting, "Hey");
});
