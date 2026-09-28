import { loadConfig } from "./config.js";
import { MemoryStore } from "./store/memory.js";
import { MemoryScheduler } from "./scheduler/memory.js";
import { CoxAdapter } from "./adapters/vin/cox.js";
import { FakeVinAdapter } from "./adapters/vin/fake.js";
import type { VinAdapter } from "./adapters/vin/types.js";
import { TwilioSms } from "./adapters/messaging/twilio.js";
import { PostmarkEmail } from "./adapters/messaging/postmark.js";
import { FakeSenders } from "./adapters/messaging/fake.js";
import type { EmailSender, SmsSender } from "./adapters/messaging/types.js";
import { makeComposer } from "./llm/index.js";
import { Orchestrator } from "./engine/orchestrator.js";
import { buildServer } from "./api/server.js";
import { seedDev } from "./dev/seed.js";

const config = loadConfig();
const store = new MemoryStore();
const scheduler = new MemoryScheduler();

let vin: VinAdapter; let vinName: string; let fakeVin: FakeVinAdapter | undefined;
if (config.cox.lm.apiKey) {
  vin = new CoxAdapter(config.cox.lm);
  vinName = `cox:${config.cox.lm.baseUrl}`;
} else {
  if (config.env === "production") throw new Error("COX_LM_API_KEY is required in production");
  fakeVin = new FakeVinAdapter(); vin = fakeVin; vinName = "fake";
}

const fakeSenders = new FakeSenders();
const sms: SmsSender = config.twilio.accountSid && config.twilio.authToken
  ? new TwilioSms({ accountSid: config.twilio.accountSid, authToken: config.twilio.authToken })
  : { async sendSms(r) { console.log(`[dev sms] ${r.from} -> ${r.to}: ${r.body}`); return fakeSenders.sendSms(r); } };
const email: EmailSender = config.postmark.serverToken
  ? new PostmarkEmail({ serverToken: config.postmark.serverToken, messageStream: config.postmark.messageStream })
  : { async sendEmail(r) { console.log(`[dev email] ${r.from} -> ${r.to} | ${r.subject}\n${r.textBody}`); return fakeSenders.sendEmail(r); } };
if (config.env === "production" && (!config.twilio.authToken || !config.postmark.serverToken)) throw new Error("Twilio and Postmark credentials are required in production");

const { composer, provider } = makeComposer(config);

// Build the server first so its logger can be handed to the orchestrator.
const pending: { orchestrator?: Orchestrator } = {};
const app = await buildServer({
  config, store, scheduler, composer, composerName: provider, vinName,
  orchestrator: new Proxy({} as Orchestrator, { get: (_t, p) => (pending.orchestrator as any)[p] }),
});
const orchestrator = new Orchestrator({
  store, scheduler, vin, sms, email, composer, storeTz: config.storeTz, emailFromDomain: config.postmark.fromDomain,
  defaultSmsFrom: config.twilio.defaultFrom, publicBaseUrl: config.publicBaseUrl, log: app.log,
  storeName: config.cox.storeName, defaultRepId: config.cox.defaultRepId,
});
pending.orchestrator = orchestrator;

if (fakeVin && config.env !== "production") { await seedDev(fakeVin, store, config.cox.sandboxDealerId ?? "14011"); app.log.info("dev seed loaded: lead 77001, rep 501, contact 9001"); }

// Cadence runner. In prod this becomes the scheduled_steps worker (next steps #5).
const tick = setInterval(() => {
  orchestrator.runDue().then((r) => { if (r.sent || r.deferred || r.dropped) app.log.info(r, "cadence tick"); }).catch((e) => app.log.error({ err: String(e) }, "cadence tick failed"));
}, 15_000);
tick.unref();

await app.listen({ port: config.port, host: "0.0.0.0" });
app.log.info({ composer: provider, vin: vinName, sink: config.cox.sink.mode, tz: config.storeTz }, "ricochet up");
