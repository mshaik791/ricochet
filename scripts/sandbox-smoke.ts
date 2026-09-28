/**
 * Read-only(ish) smoke test against the Cox sandbox dealer. Usage:
 *   npm run cox:smoke                      token + event service reads + dealer lookup
 *   npm run cox:smoke -- --lead 12345      also fetch a lead, its contact, rep and vehicles
 *   npm run cox:smoke -- --lead 12345 --note   also write one [Ricochet] note to that lead
 * Never prints keys. Prints status + first 400 chars of any error body so path/media-type problems are obvious.
 */
import { loadConfig } from "../src/config.js";
import { CoxAdapter, CoxApiError, CoxEventsClient } from "../src/adapters/vin/cox.js";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const has = (n: string) => args.includes(n);
const cfg = loadConfig();

const step = async (name: string, fn: () => Promise<unknown>) => {
  process.stdout.write(`\n== ${name}\n`);
  try {
    const r = await fn();
    console.log(typeof r === "string" ? r : JSON.stringify(r, null, 2)?.slice(0, 1500));
    return r;
  } catch (e) {
    if (e instanceof CoxApiError) console.log(`FAIL ${e.status} ${e.url}\n${e.bodyText.slice(0, 400)}`);
    else console.log(`FAIL ${String(e)}`);
    return undefined;
  }
};

console.log(`LM base: ${cfg.cox.lm.baseUrl}  accept: ${cfg.cox.lm.accept}  key: ${cfg.cox.lm.apiKey ? "set" : "MISSING"}`);
console.log(`Events base: ${cfg.cox.events.baseUrl}  token url: ${cfg.cox.events.tokenUrl}  key: ${cfg.cox.events.apiKey ? "set" : "MISSING"}  client: ${cfg.cox.events.clientId ? "set" : "MISSING"}`);

if (cfg.cox.events.apiKey && cfg.cox.events.clientId && cfg.cox.events.clientSecret) {
  const ev = new CoxEventsClient(cfg.cox.events);
  await step("Event Service: OAuth client_credentials token", async () => { const t = await ev.token(); return `token ok (${t.length} chars)`; });
  await step("Event Service: GET /eventtypes", () => ev.listEventTypes());
  await step("Event Service: GET /eventsinks", () => ev.listEventSinks());
  await step("Event Service: GET /subscriptions", () => ev.listSubscriptions());
} else console.log("\n(skipping Event Service: set COX_EVENTS_API_KEY, COX_EVENTS_CLIENT_ID, COX_EVENTS_CLIENT_SECRET)");

if (cfg.cox.lm.apiKey) {
  const lm = new CoxAdapter(cfg.cox.lm);
  const dealerId = flag("--dealer") ?? cfg.cox.sandboxDealerId;
  if (dealerId) await step(`Lead Management: dealer ${dealerId}`, () => lm.getDealer(dealerId));
  else console.log("\n(set COX_SANDBOX_DEALER_ID or pass --dealer to test the dealer endpoint)");
  const leadId = flag("--lead");
  if (leadId) {
    const lead = await step(`Lead Management: lead ${leadId}`, () => lm.getLead(leadId, dealerId)) as Awaited<ReturnType<CoxAdapter["getLead"]>> | undefined;
    if (lead) {
      const d = lead.dealerId || dealerId || "";
      if (lead.contactId) await step(`contact ${lead.contactId}`, () => lm.getContact(lead.contactId, d));
      if (lead.repId) await step(`assigned user ${lead.repId}`, () => lm.getUser(lead.repId!, d));
      await step("vehicles of interest", () => lm.getLeadVehicles(leadId, d));
      const v = lead.vehicles.find((x) => x.stockNumber || x.vin);
      if (v) await step(`inventory lookup ${v.stockNumber ?? v.vin}`, () => lm.findInventory(d, { stockNumber: v.stockNumber, vin: v.vin }));
      if (has("--note")) await step("write [Ricochet] note", async () => { await lm.addLeadNote(leadId, d, `[Ricochet] sandbox smoke test ${new Date().toISOString()}`); return "note posted"; });
    }
  } else console.log("\n(pass --lead <leadId> to walk a lead -> contact -> user -> vehicles)");
} else console.log("\n(skipping Lead Management: set COX_LM_API_KEY)");
