import type { FastifyInstance } from "fastify";
import type { Orchestrator } from "../../engine/orchestrator.js";
import type { Store } from "../../store/types.js";
import { isKnownEventType, parseCoxEvents, verifySinkAuth, type SinkAuthConfig } from "../../webhooks/coxSinkAuth.js";

export interface CoxEventsRouteDeps { orchestrator: Orchestrator; store: Store; sink: SinkAuthConfig }

/**
 * Event Sink for Connect Event Service. Register PUBLIC_BASE_URL + /webhooks/cox/events in the
 * storefront with the auth type matching COX_SINK_AUTH_MODE.
 *
 * Responses: 401 bad auth, 400 malformed, 202 accepted (per-event results in body), 200 all duplicates.
 * Processing errors never surface as 5xx to Cox (they would trigger redelivery storms); they are logged
 * and reported per event.
 */
export async function registerCoxEvents(app: FastifyInstance, deps: CoxEventsRouteDeps) {
  // Cox posts with application/vnd.coxauto.v1+json, which Fastify does not parse by default.
  app.addContentTypeParser(/^application\/.*\+json$/i, { parseAs: "string" }, (_req, body, done) => {
    try { done(null, body === "" ? {} : JSON.parse(body as string)); } catch (e) { done(e as Error, undefined); }
  });

  // Some sink registrations probe the URL first.
  app.get("/webhooks/cox/events", async () => ({ ok: true, sink: "ricochet" })); // Fastify adds HEAD automatically

  app.post("/webhooks/cox/events", async (req, reply) => {
    const auth = verifySinkAuth(deps.sink, { headers: req.headers, ip: req.ip });
    if (!auth.ok) {
      req.log.warn({ reason: auth.reason, ip: req.ip }, "cox sink auth failed");
      return reply.code(401).send({ error: "unauthorized" });
    }
    const parsed = parseCoxEvents(req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.reason });

    const results: { trackingId: string; type: string; status: string; action?: string }[] = [];
    for (const ev of parsed.events) {
      if (!isKnownEventType(ev.Type)) { results.push({ trackingId: ev.TrackingId, type: ev.Type, status: "ignored_unknown_type" }); continue; }
      const fresh = await deps.store.markEventSeen(ev.TrackingId);
      if (!fresh) { results.push({ trackingId: ev.TrackingId, type: ev.Type, status: "duplicate" }); continue; }
      try {
        const r = await deps.orchestrator.onCoxEvent(ev);
        results.push({ trackingId: ev.TrackingId, type: ev.Type, status: "processed", action: r.action });
      } catch (e) {
        req.log.error({ err: String(e), trackingId: ev.TrackingId, type: ev.Type }, "event processing failed");
        results.push({ trackingId: ev.TrackingId, type: ev.Type, status: "error" });
      }
    }
    const allDup = results.length > 0 && results.every((r) => r.status === "duplicate");
    return reply.code(allDup ? 200 : 202).send({ received: results.length, results });
  });
}
