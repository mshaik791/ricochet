import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { SinkAuthMode } from "../config.js";
import { COX_EVENT_TYPES, type CoxEvent } from "../adapters/vin/types.js";

export interface SinkAuthConfig {
  mode: SinkAuthMode;
  headerName: string;   // lowercased
  secret?: string;
  basicUser?: string;
  basicPass?: string;
  allowedIps: string[]; // IPs or CIDRs
}

export interface SinkRequest {
  headers: Record<string, string | string[] | undefined>;
  ip: string;
}

export type SinkAuthResult = { ok: true } | { ok: false; reason: string };

/**
 * Cox delivers events by pushing to the Event Sink URL you register in the storefront, with the
 * auth type you pick there. This verifies that auth on every delivery. Constant-time compares,
 * no early exits that leak which half of a credential was wrong.
 */
export function verifySinkAuth(cfg: SinkAuthConfig, req: SinkRequest): SinkAuthResult {
  if (cfg.allowedIps.length > 0 && !ipAllowed(req.ip, cfg.allowedIps)) return { ok: false, reason: "ip_not_allowed" };

  switch (cfg.mode) {
    case "none":
      return { ok: true };
    case "header": {
      if (!cfg.secret) return { ok: false, reason: "sink_secret_not_configured" };
      const got = header(req.headers, cfg.headerName);
      return safeEqual(got, cfg.secret) ? { ok: true } : { ok: false, reason: "bad_header_secret" };
    }
    case "bearer": {
      if (!cfg.secret) return { ok: false, reason: "sink_secret_not_configured" };
      const auth = header(req.headers, "authorization") ?? "";
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      return m && safeEqual(m[1], cfg.secret) ? { ok: true } : { ok: false, reason: "bad_bearer" };
    }
    case "basic": {
      if (!cfg.basicUser || !cfg.basicPass) return { ok: false, reason: "sink_basic_not_configured" };
      const auth = header(req.headers, "authorization") ?? "";
      const m = /^Basic\s+(.+)$/i.exec(auth);
      if (!m) return { ok: false, reason: "bad_basic" };
      let decoded = "";
      try { decoded = Buffer.from(m[1]!, "base64").toString("utf8"); } catch { return { ok: false, reason: "bad_basic" }; }
      const idx = decoded.indexOf(":");
      const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
      const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
      const uOk = safeEqual(user, cfg.basicUser);
      const pOk = safeEqual(pass, cfg.basicPass);
      return uOk && pOk ? { ok: true } : { ok: false, reason: "bad_basic" };
    }
    default:
      return { ok: false, reason: "unknown_mode" };
  }
}

function header(h: SinkRequest["headers"], name: string): string | undefined {
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const ab = Buffer.from(a, "utf8"); const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) { timingSafeEqual(bb, bb); return false; }
  return timingSafeEqual(ab, bb);
}

/* ---------- IP allowlist (IPv4 + IPv4-mapped IPv6, CIDR or exact) ---------- */

export function ipAllowed(ip: string, allow: string[]): boolean {
  const norm = ip.replace(/^::ffff:/, "");
  for (const entry of allow) {
    const [base, bitsStr] = entry.split("/");
    if (!base) continue;
    if (bitsStr === undefined) { if (base === norm) return true; continue; }
    if (isIP(base) !== 4 || isIP(norm) !== 4) continue;
    const bits = Number(bitsStr);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((ipv4ToInt(base) & mask) === (ipv4ToInt(norm) & mask)) return true;
  }
  return false;
}
function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, oct) => ((acc << 8) + Number(oct)) >>> 0, 0) >>> 0;
}

/* ---------- Payload parsing ---------- */

export type ParsedEvents = { ok: true; events: CoxEvent[] } | { ok: false; reason: string };

/** Accepts a single event object or an array of events. Requires Type + TrackingId. */
export function parseCoxEvents(body: unknown): ParsedEvents {
  const items = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as any).events) ? (body as any).events : [body];
  const events: CoxEvent[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") return { ok: false, reason: "event_not_object" };
    const o = item as Record<string, unknown>;
    const Type = str(o.Type ?? o.type ?? o.EventType ?? o.eventType);
    const TrackingId = str(o.TrackingId ?? o.trackingId);
    if (!Type) return { ok: false, reason: "missing_type" };
    if (!TrackingId) return { ok: false, reason: "missing_tracking_id" };
    events.push({
      ...o,
      Type,
      TrackingId,
      OccurredUtc: str(o.OccurredUtc ?? o.occurredUtc) ?? new Date().toISOString(),
      LeadId: str(o.LeadId ?? o.leadId),
      CustomerId: str(o.CustomerId ?? o.customerId ?? o.ContactId ?? o.contactId),
      DealerId: str(o.DealerId ?? o.dealerId),
      Version: str(o.Version ?? o.version),
    });
  }
  return { ok: true, events };
}

export function isKnownEventType(t: string): boolean {
  return (COX_EVENT_TYPES as readonly string[]).includes(t);
}

function str(x: unknown): string | undefined {
  return x === undefined || x === null || x === "" ? undefined : String(x);
}
