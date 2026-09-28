import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Message, Rep, VoiceKnobs, VoiceProfile } from "../../domain/types.js";
import type { Store } from "../../store/types.js";
import type { Composer, ComposeContext } from "../../engine/composer.js";
import { TemplateComposer } from "../../engine/templateComposer.js";
import { composeCompliant } from "../../engine/compliance.js";
import { findViolations } from "../../engine/policy.js";
import { safeEqual } from "../../webhooks/coxSinkAuth.js";

export interface SetupRouteDeps { store: Store; composer: Composer; adminToken?: string; defaultDealerId?: string; defaultDealerName?: string }

/** Scripted customer for the 7-turn simulation. Deterministic so every rep gets the same hard cases. */
export const SIM_CUSTOMER = { firstName: "Jordan", lastName: "Lee", phone: "(925) 555-0142", email: "jordan.lee@example.com" };
export const SIM_VEHICLE = { year: 2024, make: "Mazda", model: "CX-5", trim: "Premium", stockNumber: "M24187", listedPrice: 33450, isInventory: true } as const;
export const SIM_TURNS: readonly string[] = [
  "Hi, I saw the 2024 CX-5 Premium online. Is it still available?",
  "Cool. What's the best price you can do on it?",
  "Come on, just give me a number. Would you take 30k out the door?",
  "Ok. I have a 2017 Civic to trade in, does that help at all?",
  "Wait, is this a real person or a bot?",
  "Fine. I could maybe come by Saturday afternoon. What time do you close?",
  "Great, see you then. Can you text me the address?",
];

interface Session { id: string; rep: Rep; dealerName: string; turn: number; samples: string[]; coaching: string[][]; createdAt: number }
const DEFAULT_KNOBS: VoiceKnobs = { formality: 2, emoji: false, length: "short", greeting: "Hi", signoff: "" };

export async function registerSetup(app: FastifyInstance, deps: SetupRouteDeps) {
  const sessions = new Map<string, Session>();
  const template = new TemplateComposer();
  const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "setup.html");

  const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!deps.adminToken) return true;
    const q = (req.query as { token?: string } | undefined)?.token;
    const h = req.headers["x-setup-token"] as string | undefined;
    if (safeEqual(q, deps.adminToken) || safeEqual(h, deps.adminToken)) return true;
    reply.code(401).send({ error: "unauthorized" });
    return false;
  };

  app.get("/setup", async (req, reply) => {
    if (!guard(req, reply)) return;
    return reply.type("text/html").send(await readFile(htmlPath, "utf8"));
  });

  app.post<{ Body: { repId: string; firstName: string; lastName?: string; email?: string; phone?: string; dealerId?: string; dealerName?: string } }>("/api/setup/session", async (req, reply) => {
    if (!guard(req, reply)) return;
    const b = req.body ?? ({} as any);
    if (!b.repId || !b.firstName) return reply.code(400).send({ error: "repId and firstName required" });
    const existing = await deps.store.getRep(b.repId);
    const rep: Rep = {
      id: String(b.repId), dealerId: b.dealerId ?? existing?.dealerId ?? deps.defaultDealerId ?? "", firstName: b.firstName, lastName: b.lastName ?? existing?.lastName ?? "",
      email: b.email ?? existing?.email, phone: b.phone ?? existing?.phone, voice: existing?.voice,
    };
    await deps.store.upsertRep(rep);
    const s: Session = { id: randomUUID(), rep, dealerName: b.dealerName ?? deps.defaultDealerName ?? "Dublin Mazda", turn: 0, samples: [], coaching: [], createdAt: Date.now() };
    sessions.set(s.id, s);
    return { sessionId: s.id, customer: SIM_CUSTOMER, vehicle: SIM_VEHICLE, turn: 1, totalTurns: SIM_TURNS.length, customerMessage: SIM_TURNS[0], existingVoice: !!existing?.voice };
  });

  app.post<{ Body: { sessionId: string; repMessage: string } }>("/api/setup/turn", async (req, reply) => {
    if (!guard(req, reply)) return;
    const s = sessions.get(req.body?.sessionId ?? "");
    if (!s) return reply.code(404).send({ error: "session not found" });
    const text = (req.body.repMessage ?? "").trim();
    if (!text) return reply.code(400).send({ error: "empty message" });
    if (s.turn >= SIM_TURNS.length) return reply.code(409).send({ error: "simulation complete" });
    s.samples.push(text);
    const coaching = findViolations({ body: text, channel: "sms", listedPrice: SIM_VEHICLE.listedPrice }).map((v) => `${v.rule}: ${v.detail}`);
    s.coaching.push(coaching);
    s.turn++;
    const done = s.turn >= SIM_TURNS.length;
    return { turn: s.turn + (done ? 0 : 1), totalTurns: SIM_TURNS.length, done, customerMessage: done ? null : SIM_TURNS[s.turn], coaching };
  });

  app.post<{ Body: { sessionId: string; knobs: Partial<VoiceKnobs> } }>("/api/setup/preview", async (req, reply) => {
    if (!guard(req, reply)) return;
    const s = sessions.get(req.body?.sessionId ?? "");
    if (!s) return reply.code(404).send({ error: "session not found" });
    const voice = buildVoice(s, req.body.knobs ?? {});
    const rep: Rep = { ...s.rep, voice };
    const base = { rep, dealerName: s.dealerName, customerFirstName: SIM_CUSTOMER.firstName, vehicle: { ...SIM_VEHICLE }, history: [] as Message[] };
    const specs: Array<Partial<ComposeContext> & Pick<ComposeContext, "kind" | "channel">> = [
      { kind: "first_sms", channel: "sms" },
      { kind: "first_email", channel: "email" },
      { kind: "reply", channel: "sms", inbound: SIM_TURNS[1], intents: ["price"], requiredLines: [`The listed price is what you saw online and we're willing to work with you. Easiest is a quick call or a visit so ${rep.firstName} can go over it with you.`] },
    ];
    const previews = [];
    for (const spec of specs) {
      const r = await composeCompliant(deps.composer, template, { ...base, ...spec } as ComposeContext, SIM_VEHICLE.listedPrice);
      previews.push({ kind: spec.kind, channel: spec.channel, subject: r.draft.subject, body: r.draft.body, source: r.source });
    }
    return { previews, voice: { knobs: voice.knobs, sampleCount: voice.samples.length } };
  });

  app.post<{ Body: { sessionId: string; knobs: Partial<VoiceKnobs>; smsFrom?: string; emailFrom?: string } }>("/api/setup/save", async (req, reply) => {
    if (!guard(req, reply)) return;
    const s = sessions.get(req.body?.sessionId ?? "");
    if (!s) return reply.code(404).send({ error: "session not found" });
    if (s.samples.length < 3) return reply.code(409).send({ error: "complete at least 3 turns first" });
    const voice = buildVoice(s, req.body.knobs ?? {});
    await deps.store.upsertRep({ ...s.rep, smsFrom: req.body.smsFrom ?? s.rep.smsFrom, emailFrom: req.body.emailFrom ?? s.rep.emailFrom });
    await deps.store.saveVoiceProfile(voice);
    sessions.delete(s.id);
    return { saved: true, repId: s.rep.id, sampleCount: voice.samples.length, knobs: voice.knobs };
  });

  app.get<{ Params: { repId: string } }>("/api/setup/reps/:repId", async (req, reply) => {
    if (!guard(req, reply)) return;
    const rep = await deps.store.getRep(req.params.repId);
    if (!rep) return reply.code(404).send({ error: "not found" });
    return { id: rep.id, firstName: rep.firstName, lastName: rep.lastName, smsFrom: rep.smsFrom, emailFrom: rep.emailFrom, voice: rep.voice ? { knobs: rep.voice.knobs, sampleCount: rep.voice.samples.length, savedAt: rep.voice.savedAt } : null };
  });

  function buildVoice(s: Session, knobsIn: Partial<VoiceKnobs>): VoiceProfile {
    const knobs: VoiceKnobs = {
      formality: clampFormality(knobsIn.formality ?? DEFAULT_KNOBS.formality),
      emoji: !!(knobsIn.emoji ?? DEFAULT_KNOBS.emoji),
      length: knobsIn.length === "medium" ? "medium" : "short",
      greeting: (knobsIn.greeting ?? DEFAULT_KNOBS.greeting).toString().slice(0, 20),
      signoff: (knobsIn.signoff ?? DEFAULT_KNOBS.signoff).toString().slice(0, 40),
    };
    return { repId: s.rep.id, knobs, samples: s.samples.map(stripPii), savedAt: new Date() };
  }
}

function clampFormality(n: unknown): VoiceKnobs["formality"] {
  const v = Math.min(5, Math.max(1, Math.round(Number(n) || 2)));
  return v as VoiceKnobs["formality"];
}

/** Rule 9: samples are the rep's outbound text only, customer PII stripped. */
export function stripPii(text: string): string {
  return text
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[phone]")
    .replace(/\(\d{3}\)\s?\d{3}[-.\s]?\d{4}/g, "[phone]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(new RegExp(`\\b${SIM_CUSTOMER.firstName}\\b`, "gi"), "[name]")
    .replace(new RegExp(`\\b${SIM_CUSTOMER.lastName}\\b`, "g"), "[name]");
}
