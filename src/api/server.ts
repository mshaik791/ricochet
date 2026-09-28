import Fastify, { type FastifyInstance } from "fastify";
import formbody from "@fastify/formbody";
import type { Config } from "../config.js";
import type { Orchestrator } from "../engine/orchestrator.js";
import type { Store } from "../store/types.js";
import type { Scheduler } from "../scheduler/types.js";
import type { Composer } from "../engine/composer.js";
import { registerCoxEvents } from "./routes/coxEvents.js";
import { registerInbound } from "./routes/inbound.js";
import { registerSetup } from "./routes/setup.js";

export interface ServerDeps {
  config: Config;
  orchestrator: Orchestrator;
  store: Store;
  scheduler: Scheduler;
  composer: Composer;
  composerName: string;
  vinName: string;
  logger?: boolean | object;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? { level: deps.config.logLevel }, trustProxy: true });
  await app.register(formbody);

  app.get("/healthz", async () => ({ ok: true, env: deps.config.env, composer: deps.composerName, vin: deps.vinName }));

  await registerCoxEvents(app, { orchestrator: deps.orchestrator, store: deps.store, sink: deps.config.cox.sink });
  await registerInbound(app, {
    orchestrator: deps.orchestrator, publicBaseUrl: deps.config.publicBaseUrl, env: deps.config.env,
    twilioAuthToken: deps.config.twilio.authToken, postmarkInboundSecret: deps.config.postmark.inboundSecret,
  });
  await registerSetup(app, { store: deps.store, composer: deps.composer, adminToken: deps.config.setupAdminToken, defaultDealerId: deps.config.cox.sandboxDealerId });

  // Small read-only view for the pilot (manager dashboard proper is next-steps #6).
  app.get("/api/conversations", async (req, reply) => {
    if (deps.config.setupAdminToken) {
      const q = (req.query as { token?: string }).token;
      if (q !== deps.config.setupAdminToken && req.headers["x-setup-token"] !== deps.config.setupAdminToken) return reply.code(401).send({ error: "unauthorized" });
    }
    const convs = await deps.store.listConversations();
    return Promise.all(convs.map(async (c) => ({ ...c, pending: (await deps.scheduler.pendingForLead(c.leadId)).map((s) => ({ kind: s.kind, runAt: s.runAt })), messages: (await deps.store.listMessages(c.leadId)).length })));
  });

  return app;
}
