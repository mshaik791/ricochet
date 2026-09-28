import { test } from "node:test";
import assert from "node:assert/strict";
import { ClientCredentials, CoxAdapter, CoxApiError, CoxEventsClient, ENDPOINTS, idFromHref, leadVehicleIds, mapContact, mapLead, mapVehicle, mapVehicleList, normalizePhone, rebaseHref } from "../src/adapters/vin/cox.js";

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }
function fakeFetch(routes: (call: Call) => { status?: number; body?: unknown } | undefined) {
  const calls: Call[] = [];
  const f = (async (input: any, init: any = {}) => {
    const call: Call = { url: String(input), method: init.method ?? "GET", headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])), body: init.body ? String(init.body) : undefined };
    calls.push(call);
    if (call.url.endsWith("/connect/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    const r = routes(call) ?? { status: 404, body: { message: "not found" } };
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    return new Response(text, { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls: () => calls.filter((c) => !c.url.endsWith("/connect/token")), all: calls };
}
const opts = { baseUrl: "https://sandbox.api.vinsolutions.com", apiKey: "k", tokenUrl: "https://auth.example/connect/token", clientId: "id", clientSecret: "sec" };

// Real v4 shape observed in the sandbox on 2026-09-27 (ids changed).
const LEAD_V4 = {
  href: "https://api.vinsolutions.com/leads/id/2090000001", leadId: 2090000001, dealerId: 12617,
  contact: { href: "https://api.vinsolutions.com/contacts/id/1452000001?dealerid=12617", id: 1452000001 },
  coBuyerContact: { href: null, id: null },
  leadSource: { href: "https://api.vinsolutions.com/leadsources/id/55694?dealerid=12617", leadSourceId: 55694, leadSourceName: "Xtime" },
  leadStatus: "ACTIVE_NEW_LEAD", leadStatusType: "ACTIVE", leadType: "INTERNET", leadGroupCategory: "NEW", createdUtc: "2026-09-27T21:58:00+00:00", isHot: false, isOnShowroom: false,
  vehiclesOfInterest: [{ href: "https://api.vinsolutions.com/vehicles/interest/id/2090000001-0", vehicleId: "2090000001-0" }], tradeVehicles: [],
  primaryVehicleOfInterest: { year: null, make: null, model: null, trim: null, vin: null, href: "https://api.vinsolutions.com/vehicles/interest/id/2090000001-0", vehicleId: "2090000001-0" },
};
const VOI_V1 = { href: "https://api.vinsolutions.com/vehicles/interest/id/2090000001-0", lead: "https://api.vinsolutions.com/leads/id/2090000001", year: 2024, make: "Mazda", model: "CX-5", trim: "Premium", vin: null, stockNumber: "M24187", inventoryType: "NEW", sellingPrice: 33450, msrp: 34900 };

test("lead management: api_key header, bearer, per-endpoint media version, path from ENDPOINTS", async () => {
  const { f, calls } = fakeFetch((c) => c.url.includes("/leads/id/2090000001") ? { body: LEAD_V4 } : undefined);
  const lm = new CoxAdapter({ ...opts, fetchImpl: f });
  const lead = await lm.getLead("2090000001", "12617");
  const c = calls()[0]!;
  assert.equal(c.url, "https://sandbox.api.vinsolutions.com/leads/id/2090000001?dealerId=12617");
  assert.equal(c.headers["api_key"], "k");
  assert.equal(c.headers["x-api-key"], undefined);
  assert.equal(c.headers["authorization"], "Bearer tok");
  assert.equal(c.headers["accept"], "application/vnd.coxauto.v4+json");
  assert.equal(lead.id, "2090000001"); assert.equal(lead.contactId, "1452000001"); assert.equal(lead.dealerId, "12617");
  assert.equal(lead.source, "Xtime"); assert.equal(lead.repId, undefined); assert.deepEqual(lead.vehicles, []);
  assert.deepEqual(leadVehicleIds(LEAD_V4), ["2090000001-0"]);
});
test("vehicles of interest use v1 and map year 0 / nulls away", async () => {
  const { f, calls } = fakeFetch((c) => c.url.includes("/vehicles/interest?") ? { body: { count: 1, items: [VOI_V1] } } : undefined);
  const lm = new CoxAdapter({ ...opts, fetchImpl: f });
  const v = await lm.getLeadVehicles("2090000001", "12617");
  assert.equal(calls()[0]!.headers["accept"], "application/vnd.coxauto.v1+json");
  assert.ok(calls()[0]!.url.includes("leadId=2090000001") && calls()[0]!.url.includes("dealerId=12617"));
  assert.deepEqual(v[0], { id: "2090000001-0", year: 2024, make: "Mazda", model: "CX-5", trim: "Premium", stockNumber: "M24187", vin: undefined, isInventory: true, listedPrice: 33450 });
  const empty = mapVehicle({ ...VOI_V1, year: 0, make: null, model: null, stockNumber: null, inventoryType: "UNKNOWN", sellingPrice: null, msrp: null });
  assert.equal(empty.year, undefined); assert.equal(empty.isInventory, false); assert.equal(empty.listedPrice, undefined);
});
test("contact call carries dealerId and the configured userId", async () => {
  const { f, calls } = fakeFetch(() => ({ body: { contactId: 1452000001, contactInformation: { firstName: "Jordan", lastName: "Lee", emails: [{ emailAddress: "j@x.com" }], phones: [{ number: "(925) 555-0142" }] } } }));
  const lm = new CoxAdapter({ ...opts, fetchImpl: f, userId: "4242" });
  const c = await lm.getContact("1452000001", "12617");
  assert.equal(calls()[0]!.url, "https://sandbox.api.vinsolutions.com/contacts/id/1452000001?dealerId=12617&userId=4242");
  assert.equal(calls()[0]!.headers["accept"], "application/vnd.coxauto.v3+json");
  assert.deepEqual(c.phones, ["+19255550142"]); assert.equal(c.firstName, "Jordan");
});
test("hrefs are rebased from the production host onto the configured base", () => {
  assert.equal(rebaseHref("https://api.vinsolutions.com/contacts/id/1?dealerid=12617", "https://sandbox.api.vinsolutions.com"), "https://sandbox.api.vinsolutions.com/contacts/id/1?dealerid=12617");
  assert.equal(rebaseHref("/leads/id/1", "https://sandbox.api.vinsolutions.com"), "https://sandbox.api.vinsolutions.com/leads/id/1");
  assert.equal(idFromHref("https://api.vinsolutions.com/vehicles/interest/id/2090000001-0"), "2090000001-0");
  assert.equal(idFromHref("https://api.vinsolutions.com/contacts/id/1452000001?dealerid=12617"), "1452000001");
});
test("non-2xx becomes CoxApiError; 401 refreshes the token once", async () => {
  let n = 0;
  const { f, all } = fakeFetch(() => (++n === 1 ? { status: 401, body: {} } : { status: 403, body: { message: "forbidden" } }));
  const lm = new CoxAdapter({ ...opts, fetchImpl: f });
  await assert.rejects(lm.getLead("1"), (e: unknown) => e instanceof CoxApiError && e.status === 403 && e.bodyText.includes("forbidden"));
  assert.equal(all.filter((c) => c.url.endsWith("/connect/token")).length, 2, "token fetched, invalidated on 401, fetched again");
});
test("logActivity posts a prefixed note (unverified route, kept until Cox confirms the notes API)", async () => {
  const { f, calls } = fakeFetch(() => ({ status: 201, body: "" }));
  const lm = new CoxAdapter({ ...opts, fetchImpl: f });
  await lm.logActivity({ leadId: "77001", dealerId: "12617", channel: "sms", direction: "out", body: "hey", at: new Date("2026-09-28T17:00:00Z") });
  assert.equal(calls()[0]!.method, "POST");
  assert.ok(calls()[0]!.url.endsWith("/leads/id/77001/notes"));
  assert.ok(JSON.parse(calls()[0]!.body!).note.startsWith("[Ricochet] SMS to customer"));
  assert.equal(ENDPOINTS.leadNote.verified, false);
});
test("ClientCredentials reuses an unexpired token", async () => {
  let n = 0;
  const f = (async () => { n++; return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 })); }) as typeof fetch;
  const cc = new ClientCredentials({ tokenUrl: "https://auth.example/connect/token", clientId: "a", clientSecret: "b", fetchImpl: f });
  await cc.get(); await cc.get();
  assert.equal(n, 1);
});
test("events client: x-api-key + bearer, subscriber password is dropped, subscriptions listed", async () => {
  const { f, calls } = fakeFetch((c) => c.url.endsWith("/subscriber") ? { body: { subscriberId: "s1", authorizationType: "ApiKey", username: "x-api-key", password: "SECRET", invocationEndpoint: "https://x/y", status: "Active" } } : c.url.endsWith("/subscription") ? { body: [{ dealerId: 12617, subscriberId: "s1", status: "inactive", subscriptions: ["LeadCreated"] }] } : undefined);
  const ev = new CoxEventsClient({ baseUrl: "https://sandbox.api.coxautoinc.com/vinsolutions/eventingapi", apiKey: "ek", tokenUrl: "https://auth.example/connect/token", clientId: "id", clientSecret: "sec", fetchImpl: f });
  const sub = await ev.getSubscriber();
  assert.equal((sub as any).password, undefined); assert.equal(sub.invocationEndpoint, "https://x/y");
  assert.equal(calls()[0]!.headers["x-api-key"], "ek"); assert.equal(calls()[0]!.headers["authorization"], "Bearer tok");
  const subs = await ev.listSubscriptions();
  assert.equal(subs[0]!.dealerId, 12617);
});
test("mapLead still tolerates v3 string hrefs and PascalCase", () => {
  const lead = mapLead({ LeadId: 1, DealerId: 2, Contact: "https://api.vinsolutions.com/contacts/id/9001?dealerid=2", AssignedUser: { href: "https://x/users/id/501?dealerId=2" }, TCPAOptIn: "true", Vehicles: [{ Year: 2024, Make: "Mazda", Model: "CX-5", StockNumber: "M1", ListPrice: "33450" }] }, "1");
  assert.equal(lead.contactId, "9001"); assert.equal(lead.repId, "501"); assert.equal(lead.tcpaOptIn, true);
  assert.equal(lead.vehicles[0]!.listedPrice, 33450);
});
test("mapContact consent and mapVehicleList envelopes", () => {
  assert.equal(mapContact({ smsOptOut: true }, "1", "2").smsConsent, "revoked");
  assert.equal(mapContact({ communicationPreferences: { smsOptIn: true } }, "1", "2").smsConsent, "granted");
  assert.equal(mapContact({ firstName: "A" }, "1", "2").smsConsent, "unknown");
  assert.equal(mapVehicleList({ items: [{ make: "Mazda" }, { make: "Honda" }] }).length, 2);
});
test("normalizePhone", () => {
  assert.equal(normalizePhone("925-555-0142"), "+19255550142");
  assert.equal(normalizePhone("19255550142"), "+19255550142");
});
