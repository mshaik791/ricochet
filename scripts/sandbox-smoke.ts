/**
 * Smoke test against the Cox sandbox. Read-only unless --note is passed. Usage:
 *   npm run cox:smoke                        token, subscriber, subscriptions, first page of leads, one lead walked
 *   npm run cox:smoke -- --lead 2090659561   walk a specific lead
 *   npm run cox:smoke -- --lead <id> --note  also POST one [Ricochet] note (unverified route)
 * Prints status + first 300 chars of any error so a wrong path or media type is obvious. Never prints keys or the
 * subscriber password.
 */
import { loadConfig } from "../src/config.js";
import { CoxAdapter, CoxApiError, CoxEventsClient, ENDPOINTS, leadVehicleIds } from "../src/adapters/vin/cox.js";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const has = (n: string) => args.includes(n);
const cfg = loadConfig();
const redact = (s: string) => s.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>").replace(/(?<!\d)(\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4})(?!\d)/g, "<phone>");

let fails = 0;
const step = async <T,>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
  process.stdout.write(`\n== ${name}\n`);
  try {
    const r = await fn();
    console.log(redact(typeof r === "string" ? r : JSON.stringify(r, null, 2) ?? "").slice(0, 1200));
    return r;
  } catch (e) {
    fails++;
    if (e instanceof CoxApiError) console.log(`FAIL ${e.status} ${e.url}\n${e.bodyText.slice(0, 300)}`);
    else console.log(`FAIL ${String(e)}`);
    return undefined;
  }
};

console.log(`LM base ${cfg.cox.lm.baseUrl}  key header ${cfg.cox.lm.apiKeyHeader}  key ${cfg.cox.lm.apiKey ? "set" : "MISSING"}  oauth client ${cfg.cox.lm.clientId ? "set" : "MISSING"}  userId ${cfg.cox.lm.userId ?? "(unset)"}`);
console.log(`Events base ${cfg.cox.events.baseUrl}  key ${cfg.cox.events.apiKey ? "set" : "MISSING"}`);
console.log(`Endpoint table: ${Object.entries(ENDPOINTS).filter(([, e]) => e.verified).length} verified, ${Object.entries(ENDPOINTS).filter(([, e]) => !e.verified).map(([k]) => k).join(", ")} unverified`);

const dealerId = flag("--dealer") ?? cfg.cox.sandboxDealerId ?? "12617";

if (cfg.cox.events.apiKey && cfg.cox.events.clientId && cfg.cox.events.clientSecret) {
  const ev = new CoxEventsClient(cfg.cox.events);
  await step("Event Service: OAuth token", async () => `ok (${(await ev.token()).length} chars)`);
  await step("Event Service: GET /subscriber (our sink registration)", () => ev.getSubscriber());
  await step("Event Service: GET /subscription", async () => (await ev.listSubscriptions()).map((s) => `${s.dealerId}: ${s.status} (${s.subscriptions.length} types)`));
} else console.log("\n(skipping Event Service: set COX_EVENTS_API_KEY, COX_EVENTS_CLIENT_ID, COX_EVENTS_CLIENT_SECRET)");

if (cfg.cox.lm.apiKey && cfg.cox.lm.clientId) {
  const lm = new CoxAdapter(cfg.cox.lm);
  const page = await step(`Lead Management: GET /leads?dealerId=${dealerId}&limit=3`, async () => {
    const p = await lm.listLeads(dealerId, 3);
    return { count: p.count, ids: p.items.map((l) => l.id) };
  });
  const leadId = flag("--lead") ?? page?.ids[0];
  if (leadId) {
    const lead = await step(`GET /leads/id/${leadId} (v4)`, () => lm.getLead(leadId, dealerId));
    if (lead) {
      const d = lead.dealerId || dealerId;
      await step("GET /vehicles/interest?leadId= (v1)", () => lm.getLeadVehicles(leadId, d));
      await step("GET /contacts/id/{id}?dealerId=&userId= (v3) — needs COX_LM_USER_ID", () => lm.getContact(lead.contactId, d));
      if (lead.repId) await step(`GET /users/id/${lead.repId} (unverified)`, () => lm.getUser(lead.repId!, d));
      else console.log("\n(lead payload carries no assigned user; skipping user API)");
      await step(`GET /dealers/id/${d} (unverified)`, () => lm.getDealer(d));
      if (has("--note")) await step("POST /leads/id/{id}/notes (unverified)", async () => { await lm.addLeadNote(leadId, d, `[Ricochet] sandbox smoke ${new Date().toISOString()}`); return "posted"; });
    }
  }
  await step("Spec drift check hint", async () => `lead vehicle ids resolve via leadVehicleIds(): ${JSON.stringify(leadVehicleIds({ vehiclesOfInterest: [{ vehicleId: "x-0" }] }))}`);
} else console.log("\n(skipping Lead Management: set COX_LM_API_KEY and the OAuth client)");

console.log(`\n${fails === 0 ? "All steps passed." : `${fails} step(s) failed. Expected failures: contact (until COX_LM_USER_ID is known), users/dealers/notes (not in plan yet).`}`);
