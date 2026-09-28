/**
 * Posts a Connect Event Service style event to a running Ricochet (default http://localhost:8080)
 * using the sink auth from .env. Usage:
 *   npm run cox:simulate -- LeadCreated 77001
 *   npm run cox:simulate -- LastContactAttemptUpdated 77001
 *   npm run cox:simulate -- ConsentUpdated 77001 --customer 9001
 */
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";

const cfg = loadConfig();
const [type = "LeadCreated", leadId = "77001", ...rest] = process.argv.slice(2);
const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const base = flag("--url") ?? `http://localhost:${cfg.port}`;
const dealerId = flag("--dealer") ?? cfg.cox.sandboxDealerId ?? "14011";

const headers: Record<string, string> = { "Content-Type": "application/vnd.coxauto.v1+json" };
const s = cfg.cox.sink;
if (s.mode === "header" && s.secret) headers[s.headerName] = s.secret;
if (s.mode === "bearer" && s.secret) headers.Authorization = `Bearer ${s.secret}`;
if (s.mode === "basic" && s.basicUser) headers.Authorization = "Basic " + Buffer.from(`${s.basicUser}:${s.basicPass ?? ""}`).toString("base64");

const event = { Type: type, TrackingId: randomUUID(), OccurredUtc: new Date().toISOString(), LeadId: Number(leadId), CustomerId: Number(flag("--customer") ?? 9001), DealerId: Number(dealerId), Version: 1 };
const res = await fetch(`${base}/webhooks/cox/events`, { method: "POST", headers, body: JSON.stringify(event) });
console.log(res.status, await res.text());
