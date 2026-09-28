import { test } from "node:test";
import assert from "node:assert/strict";
import { ClientCredentials, CoxAdapter, CoxApiError, mapContact, mapLead, mapVehicleList, normalizePhone } from "../src/adapters/vin/cox.js";

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }
function fakeFetch(routes: (call: Call) => { status?: number; body?: unknown } | undefined) {
  const calls: Call[] = [];
  const f = (async (input: any, init: any = {}) => {
    const call: Call = { url: String(input), method: init.method ?? "GET", headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])), body: init.body ? String(init.body) : undefined };
    calls.push(call);
    const r = routes(call) ?? { status: 404, body: { message: "not found" } };
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    return new Response(text, { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}
const opts = { baseUrl: "https://sandbox.api.vinsolutions.com", apiKey: "k", accept: "application/vnd.coxauto.v3+json" };

test("sends x-api-key and vendor media types, builds paths from ENDPOINTS", async () => {
  const { f, calls } = fakeFetch((c) => c.url.includes("/leads/id/77001") ? { body: { leadId: 77001, dealerId: 14011, contactId: 9001, assignedUserId: 501 } } : undefined);
  const lm = new CoxAdapter({ ...opts, fetchImpl: f });
  const lead = await lm.getLead("77001", "14011");
  assert.equal(calls[0]!.url, "https://sandbox.api.vinsolutions.com/leads/id/77001?dealerId=14011");
  assert.equal(calls[0]!.headers["x-api-key"], "k");
  assert.equal(calls[0]!.headers["accept"], "application/vnd.coxauto.v3+json");
  assert.equal(lead.repId, "501"); assert.equal(lead.contactId, "9001"); assert.equal(lead.dealerId, "14011");
});
test("non-2xx becomes CoxApiError with status and body", async () => {
  const { f } = fakeFetch(() => ({ status: 403, body: { message: "forbidden" } }));
  const lm = new CoxAdapter({ ...opts, fetchImpl: f });
  await assert.rejects(lm.getDealer("14011"), (e: unknown) => e instanceof CoxApiError && e.status === 403 && e.bodyText.includes("forbidden"));
});
test("logActivity and addLeadNote POST a prefixed note", async () => {
  const { f, calls } = fakeFetch(() => ({ status: 201, body: "" }));
  const lm = new CoxAdapter({ ...opts, fetchImpl: f });
  await lm.logActivity({ leadId: "77001", dealerId: "14011", channel: "sms", direction: "out", body: "hey", at: new Date("2026-09-28T17:00:00Z") });
  assert.equal(calls[0]!.method, "POST");
  assert.ok(calls[0]!.url.endsWith("/leads/id/77001/notes"));
  const body = JSON.parse(calls[0]!.body!);
  assert.equal(body.dealerId, 14011);
  assert.ok(body.note.startsWith("[Ricochet] SMS to customer"));
  assert.ok(body.note.endsWith("\nhey"));
});
test("optional OAuth: token cached, refreshed on 401", async () => {
  let tokens = 0;
  const { f, calls } = fakeFetch((c) => {
    if (c.url.endsWith("/connect/token")) { tokens++; return { body: { access_token: `tok${tokens}`, expires_in: 3600 } }; }
    if (c.headers["authorization"] === "Bearer tok1" && tokens === 1 && calls.filter((x) => x.url.includes("/dealers")).length > 1) return { status: 401, body: {} };
    return { body: { dealerId: 14011, name: "Dublin Mazda" } };
  });
  const lm = new CoxAdapter({ ...opts, fetchImpl: f, tokenUrl: "https://auth.example/connect/token", clientId: "id", clientSecret: "sec" });
  await lm.getDealer("14011"); await lm.getDealer("14011");
  assert.equal(tokens, 2, "second call got 401 on stale token and refreshed once");
  const tokenCall = calls.find((c) => c.url.endsWith("/connect/token"))!;
  assert.ok(tokenCall.body!.includes("grant_type=client_credentials") && tokenCall.body!.includes("scope=PublicAPI"));
});
test("ClientCredentials reuses an unexpired token", async () => {
  let n = 0;
  const { f } = fakeFetch(() => { n++; return { body: { access_token: "t", expires_in: 3600 } }; });
  const cc = new ClientCredentials({ tokenUrl: "https://auth.example/connect/token", clientId: "a", clientSecret: "b", fetchImpl: f });
  await cc.get(); await cc.get();
  assert.equal(n, 1);
});
test("mapLead tolerates PascalCase and href-linked contact/user", () => {
  const lead = mapLead({ LeadId: 1, DealerId: 2, Contact: { href: "https://x/contacts/id/9001" }, AssignedUser: { href: "https://x/users/id/501?dealerId=2" }, CreatedUtc: "2026-09-28T17:00:00Z", TCPAOptIn: "true", Vehicles: [{ Year: 2024, Make: "Mazda", Model: "CX-5", StockNumber: "M1", ListPrice: "33450" }] }, "1");
  assert.equal(lead.contactId, "9001"); assert.equal(lead.repId, "501"); assert.equal(lead.tcpaOptIn, true);
  assert.equal(lead.vehicles[0]!.listedPrice, 33450); assert.equal(lead.vehicles[0]!.isInventory, true);
});
test("mapContact extracts emails, normalized phones and consent", () => {
  const c = mapContact({ contactId: 9001, ContactInformation: { firstName: "Jordan", lastName: "Lee", emails: [{ emailAddress: "j@x.com" }], phones: [{ number: "(925) 555-0142" }] }, communicationPreferences: { smsOptIn: true } }, "9001", "14011");
  assert.deepEqual(c.emails, ["j@x.com"]); assert.deepEqual(c.phones, ["+19255550142"]); assert.equal(c.smsConsent, "granted");
  assert.equal(mapContact({ smsOptOut: true }, "1", "2").smsConsent, "revoked");
  assert.equal(mapContact({ firstName: "A" }, "1", "2").smsConsent, "unknown");
});
test("mapVehicleList unwraps common envelopes", () => {
  assert.equal(mapVehicleList({ items: [{ make: "Mazda" }, { make: "Honda" }] }).length, 2);
  assert.equal(mapVehicleList([{ inventory: { stockNumber: "S1", internetPrice: 20000 } }])[0]!.listedPrice, 20000);
});
test("normalizePhone", () => {
  assert.equal(normalizePhone("925-555-0142"), "+19255550142");
  assert.equal(normalizePhone("19255550142"), "+19255550142");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+44 20 7946 0958");
});
