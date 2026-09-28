import { test } from "node:test";
import assert from "node:assert/strict";
import { ipAllowed, parseCoxEvents, verifySinkAuth, type SinkAuthConfig } from "../src/webhooks/coxSinkAuth.js";

const base: SinkAuthConfig = { mode: "header", headerName: "x-ricochet-sink-key", secret: "s3cret", allowedIps: [] };
const req = (headers: Record<string, string> = {}, ip = "1.2.3.4") => ({ headers, ip });

test("header mode", () => {
  assert.deepEqual(verifySinkAuth(base, req({ "x-ricochet-sink-key": "s3cret" })), { ok: true });
  assert.equal(verifySinkAuth(base, req({ "x-ricochet-sink-key": "wrong" })).ok, false);
  assert.equal(verifySinkAuth(base, req({})).ok, false);
  assert.equal(verifySinkAuth({ ...base, secret: undefined }, req({ "x-ricochet-sink-key": "s3cret" })).ok, false);
});
test("bearer mode", () => {
  const cfg = { ...base, mode: "bearer" as const };
  assert.equal(verifySinkAuth(cfg, req({ authorization: "Bearer s3cret" })).ok, true);
  assert.equal(verifySinkAuth(cfg, req({ authorization: "Bearer nope" })).ok, false);
  assert.equal(verifySinkAuth(cfg, req({ authorization: "Basic s3cret" })).ok, false);
});
test("basic mode", () => {
  const cfg = { ...base, mode: "basic" as const, basicUser: "cox", basicPass: "pw" };
  const enc = (s: string) => "Basic " + Buffer.from(s).toString("base64");
  assert.equal(verifySinkAuth(cfg, req({ authorization: enc("cox:pw") })).ok, true);
  assert.equal(verifySinkAuth(cfg, req({ authorization: enc("cox:bad") })).ok, false);
  assert.equal(verifySinkAuth(cfg, req({ authorization: enc("bad:pw") })).ok, false);
  assert.equal(verifySinkAuth(cfg, req({})).ok, false);
});
test("none mode and ip allowlist", () => {
  assert.equal(verifySinkAuth({ ...base, mode: "none" }, req()).ok, true);
  const cfg = { ...base, allowedIps: ["10.0.0.0/8", "203.0.113.7"] };
  assert.equal(verifySinkAuth(cfg, req({ "x-ricochet-sink-key": "s3cret" }, "10.20.30.40")).ok, true);
  assert.equal(verifySinkAuth(cfg, req({ "x-ricochet-sink-key": "s3cret" }, "::ffff:203.0.113.7")).ok, true);
  assert.deepEqual(verifySinkAuth(cfg, req({ "x-ricochet-sink-key": "s3cret" }, "8.8.8.8")), { ok: false, reason: "ip_not_allowed" });
  assert.equal(ipAllowed("192.168.1.5", ["192.168.1.0/24"]), true);
  assert.equal(ipAllowed("192.168.2.5", ["192.168.1.0/24"]), false);
});
test("parseCoxEvents accepts object, array, and normalizes ids", () => {
  const one = parseCoxEvents({ Type: "LeadCreated", TrackingId: "t1", OccurredUtc: "2026-09-28T00:00:00Z", LeadId: 77001, DealerId: 14011 });
  assert.ok(one.ok && one.events.length === 1 && one.events[0]!.LeadId === "77001");
  const many = parseCoxEvents([{ type: "LeadUpdated", trackingId: "t2", leadId: 1 }, { Type: "ConsentUpdated", TrackingId: "t3", CustomerId: 9 }]);
  assert.ok(many.ok && many.events.length === 2 && many.events[1]!.CustomerId === "9");
  assert.deepEqual(parseCoxEvents({ TrackingId: "x" }), { ok: false, reason: "missing_type" });
  assert.deepEqual(parseCoxEvents({ Type: "LeadCreated" }), { ok: false, reason: "missing_tracking_id" });
  assert.equal(parseCoxEvents("nope").ok, false);
});
