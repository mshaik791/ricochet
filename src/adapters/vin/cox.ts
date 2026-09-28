import type { Contact, Dealer, InventoryVehicle, Lead, Rep, SmsConsent, VehicleOfInterest } from "../../domain/types.js";
import type { ActivityLog, VinAdapter } from "./types.js";

/**
 * CoxAdapter: VinSolutions Lead Management 1.0 (sandbox) + Connect Event Service 1.0.
 *
 * Confirmed against the sandbox on 2026-09-27 (see CLAUDE.md "Cox sandbox facts"):
 *  - Lead Management wants the key in an `api_key` header (NOT x-api-key, despite the storefront) AND an OAuth
 *    bearer from authentication.vinsolutions.com using the same client_credentials as the event service.
 *  - Every href Vin returns points at https://api.vinsolutions.com even in the sandbox. We rewrite the origin.
 *  - Media type versions differ per resource. Each ENDPOINTS row carries its own.
 *  - Event Service uses `x-api-key` + bearer. Resources are singular: /subscriber, /subscription.
 *
 * `verified: true` means a 200 was observed in the sandbox. Unverified rows are best guesses from public Vin
 * docs and are the first thing to check when the OpenAPI specs land (`npm run cox:spec-check`).
 */

export interface CoxEndpoint {
  method: "GET" | "POST" | "PUT" | "PATCH";
  path: string;
  version: 1 | 2 | 3 | 4;
  spec: "lead-management" | "connect-event-solution";
  verified: boolean;
  note?: string;
}

export const ENDPOINTS = {
  lead:          { method: "GET",  path: "/leads/id/{leadId}",                 version: 4, spec: "lead-management", verified: true,  note: "v4 nests contact/leadSource/vehicle ids" },
  leads:         { method: "GET",  path: "/leads",                             version: 4, spec: "lead-management", verified: true,  note: "?dealerId=&limit=&pagenumber=" },
  contact:       { method: "GET",  path: "/contacts/id/{contactId}",           version: 3, spec: "lead-management", verified: false, note: "?dealerId=&userId= ; userId must be tied to the token (403 otherwise)" },
  leadVehicles:  { method: "GET",  path: "/vehicles/interest",                 version: 1, spec: "lead-management", verified: true,  note: "?leadId=&dealerId=" },
  vehicle:       { method: "GET",  path: "/vehicles/interest/id/{vehicleId}",  version: 1, spec: "lead-management", verified: true },
  leadSource:    { method: "GET",  path: "/leadsources/id/{leadSourceId}",     version: 1, spec: "lead-management", verified: true,  note: "?dealerId=" },
  user:          { method: "GET",  path: "/users/id/{userId}",                 version: 1, spec: "lead-management", verified: false, note: "596 Service Not Found in sandbox: not in our plan yet" },
  dealer:        { method: "GET",  path: "/dealers/id/{dealerId}",             version: 1, spec: "lead-management", verified: false, note: "596 Service Not Found in sandbox: not in our plan yet" },
  inventory:     { method: "GET",  path: "/vehicles/inventory",                version: 1, spec: "lead-management", verified: false, note: "route missing in sandbox: ask Cox which plan exposes inventory" },
  leadNote:      { method: "POST", path: "/leads/id/{leadId}/notes",           version: 1, spec: "lead-management", verified: false, note: "route missing in sandbox: Digital Showroom plan adds notes" },
  contactUpdate: { method: "PUT",  path: "/contacts/id/{contactId}",           version: 3, spec: "lead-management", verified: false, note: "consent flags" },
  subscriber:    { method: "GET",  path: "/subscriber",                        version: 1, spec: "connect-event-solution", verified: true, note: "our sink registration (auth type, endpoint, rate limit)" },
  subscription:  { method: "GET",  path: "/subscription",                      version: 1, spec: "connect-event-solution", verified: true, note: "per-dealer event type subscriptions + status" },
} as const satisfies Record<string, CoxEndpoint>;

export type EndpointKey = keyof typeof ENDPOINTS;
export const mediaType = (v: number) => `application/vnd.coxauto.v${v}+json`;

export interface LeadManagementOptions {
  baseUrl: string;
  apiKey: string;
  /** Header that carries the key. Sandbox gateway wants `api_key`. */
  apiKeyHeader?: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  /** Vin user id the token is associated with. Required by the contacts API. */
  userId?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  notePrefix?: string;
}

export interface EventServiceOptions {
  baseUrl: string;
  apiKey: string;
  apiKeyHeader?: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class CoxApiError extends Error {
  constructor(public readonly status: number, public readonly url: string, public readonly bodyText: string) {
    super(`cox ${status} ${url}: ${bodyText.slice(0, 300)}`);
  }
}

/* ---------- OAuth client_credentials token cache ---------- */

export class ClientCredentials {
  private token?: { value: string; expiresAt: number };
  constructor(
    private readonly o: { tokenUrl: string; clientId: string; clientSecret: string; scope?: string; fetchImpl?: typeof fetch; now?: () => Date },
  ) {}
  async get(): Promise<string> {
    const now = (this.o.now ?? (() => new Date()))().getTime();
    if (this.token && this.token.expiresAt - 60_000 > now) return this.token.value;
    const f = this.o.fetchImpl ?? fetch;
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: this.o.clientId, client_secret: this.o.clientSecret });
    if (this.o.scope) body.set("scope", this.o.scope);
    const res = await f(this.o.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
    const text = await res.text();
    if (!res.ok) throw new CoxApiError(res.status, this.o.tokenUrl, text);
    const json = JSON.parse(text) as { access_token: string; expires_in?: number };
    this.token = { value: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }
  invalidate() { this.token = undefined; }
}

/** Vin hrefs always name the production host. Point them at whichever base we are configured for. */
export function rebaseHref(href: string, baseUrl: string): string {
  try {
    const h = new URL(href); const b = new URL(baseUrl);
    h.protocol = b.protocol; h.host = b.host;
    if (b.pathname !== "/" && !h.pathname.startsWith(b.pathname)) h.pathname = b.pathname.replace(/\/$/, "") + h.pathname;
    return h.toString();
  } catch { return href.startsWith("http") ? href : baseUrl + href; }
}

/* ---------- Lead Management adapter ---------- */

export class CoxAdapter implements VinAdapter {
  private readonly f: typeof fetch;
  private readonly oauth: ClientCredentials;
  private readonly keyHeader: string;
  private readonly notePrefix: string;

  constructor(private readonly o: LeadManagementOptions) {
    this.f = o.fetchImpl ?? fetch;
    this.keyHeader = o.apiKeyHeader ?? "api_key";
    this.notePrefix = o.notePrefix ?? "[Ricochet]";
    this.oauth = new ClientCredentials({ tokenUrl: o.tokenUrl, clientId: o.clientId, clientSecret: o.clientSecret, scope: o.scope ?? "PublicAPI", fetchImpl: this.f, now: o.now });
  }

  /* --- public API --- */

  async getLead(leadId: string, dealerId?: string): Promise<Lead> {
    const raw = await this.get("lead", this.url("lead", { leadId }, dealerId ? { dealerId } : {}));
    return mapLead(raw, leadId, dealerId);
  }

  /** Page of leads for a dealer. Used by the smoke test and future backfills. */
  async listLeads(dealerId: string, limit = 10, page = 1): Promise<{ count: number; items: Lead[]; next?: string }> {
    const raw = obj(await this.get("leads", this.url("leads", {}, { dealerId, limit: String(limit), pagenumber: String(page) })));
    return { count: n(raw.count) ?? 0, items: asArray(raw.items).map((x) => mapLead(x, "", dealerId)), next: s(raw.next) };
  }

  async getContact(contactId: string, dealerId: string): Promise<Contact> {
    const q: Record<string, string> = { dealerId };
    if (this.o.userId) q.userId = this.o.userId;
    const raw = await this.get("contact", this.url("contact", { contactId }, q));
    return mapContact(raw, contactId, dealerId);
  }

  async getUser(userId: string, dealerId: string): Promise<Rep> {
    const raw = await this.get("user", this.url("user", { userId }, { dealerId }));
    return mapUser(raw, userId, dealerId);
  }

  async getDealer(dealerId: string): Promise<Dealer> {
    const raw = await this.get("dealer", this.url("dealer", { dealerId }));
    return mapDealer(raw, dealerId);
  }

  async getLeadVehicles(leadId: string, dealerId: string): Promise<VehicleOfInterest[]> {
    const raw = await this.get("leadVehicles", this.url("leadVehicles", {}, { leadId, dealerId }));
    return mapVehicleList(raw);
  }

  async getVehicle(vehicleId: string): Promise<VehicleOfInterest> {
    return mapVehicle(obj(await this.get("vehicle", this.url("vehicle", { vehicleId }))));
  }

  async getLeadSourceName(leadSourceId: string, dealerId: string): Promise<string | undefined> {
    return s(pick(obj(await this.get("leadSource", this.url("leadSource", { leadSourceId }, { dealerId }))), "leadSourceName", "name"));
  }

  async findInventory(dealerId: string, q: { stockNumber?: string; vin?: string }): Promise<InventoryVehicle | undefined> {
    if (!q.stockNumber && !q.vin) return undefined;
    const query: Record<string, string> = { dealerId };
    if (q.stockNumber) query.stockNumber = q.stockNumber;
    if (q.vin) query.vin = q.vin;
    let raw: unknown;
    try { raw = await this.get("inventory", this.url("inventory", {}, query)); }
    catch (e) { if (e instanceof CoxApiError && e.status === 404) return undefined; throw e; }
    const first = asArray(raw)[0];
    return first ? mapInventory(first) : undefined;
  }

  async logActivity(a: ActivityLog): Promise<void> {
    const dir = a.direction === "out" ? "to customer" : "from customer";
    const subj = a.subject ? ` "${a.subject}"` : "";
    await this.addLeadNote(a.leadId, a.dealerId, `${this.notePrefix} ${a.channel.toUpperCase()} ${dir}${subj} at ${a.at.toISOString()}\n${a.body}`);
  }

  async addLeadNote(leadId: string, dealerId: string, note: string): Promise<void> {
    await this.send("leadNote", this.url("leadNote", { leadId }), { dealerId: Number(dealerId) || dealerId, note });
  }

  async setSmsConsent(contactId: string, dealerId: string, granted: boolean, source: string): Promise<void> {
    const q: Record<string, string> = { dealerId };
    if (this.o.userId) q.userId = this.o.userId;
    await this.send("contactUpdate", this.url("contactUpdate", { contactId }, q), {
      dealerId: Number(dealerId) || dealerId, smsOptIn: granted, textOptIn: granted, consentSource: source,
    });
  }

  /** Follow an href Vin returned (rebased onto our host) with a given media version. */
  async getByHref<T = unknown>(href: string, version: 1 | 2 | 3 | 4 = 1): Promise<T> {
    return (await this.request("GET", rebaseHref(href, this.o.baseUrl), mediaType(version))) as T;
  }

  /* --- HTTP plumbing --- */

  url(key: EndpointKey, params: Record<string, string>, query: Record<string, string> = {}): string {
    let path: string = ENDPOINTS[key].path;
    for (const [k, v] of Object.entries(params)) path = path.replace(`{${k}}`, encodeURIComponent(v));
    const qs = new URLSearchParams(query).toString();
    return this.o.baseUrl + path + (qs ? `?${qs}` : "");
  }

  private get(key: EndpointKey, url: string) { return this.request("GET", url, mediaType(ENDPOINTS[key].version)); }
  private send(key: EndpointKey, url: string, body: unknown) { return this.request(ENDPOINTS[key].method, url, mediaType(ENDPOINTS[key].version), body); }

  private async headers(accept: string): Promise<Record<string, string>> {
    return { [this.keyHeader]: this.o.apiKey, Accept: accept, "Content-Type": accept, Authorization: `Bearer ${await this.oauth.get()}` };
  }

  private async request(method: string, url: string, accept: string, body?: unknown, retried = false): Promise<unknown> {
    const res = await this.f(url, { method, headers: await this.headers(accept), body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401 && !retried) { this.oauth.invalidate(); return this.request(method, url, accept, body, true); }
    const text = await res.text();
    if (!res.ok) throw new CoxApiError(res.status, url, text);
    if (!text) return undefined;
    try { return JSON.parse(text); } catch { return text; }
  }
}

/* ---------- Connect Event Service client (read side; delivery is push to our sink) ---------- */

export interface CoxSubscriber {
  subscriberId: string; description?: string; authorizationType?: string; username?: string;
  invocationEndpoint?: string; httpMethod?: string; status?: string; rateLimit?: { period: string; limit: number };
}
export interface CoxSubscription { dealerId: number; subscriberId: string; status: string; statusDateUtc?: string; subscriptions: string[] }

export class CoxEventsClient {
  private readonly f: typeof fetch;
  readonly oauth: ClientCredentials;
  private readonly keyHeader: string;
  constructor(private readonly o: EventServiceOptions) {
    this.f = o.fetchImpl ?? fetch;
    this.keyHeader = o.apiKeyHeader ?? "x-api-key";
    this.oauth = new ClientCredentials({ tokenUrl: o.tokenUrl, clientId: o.clientId, clientSecret: o.clientSecret, scope: o.scope ?? "PublicAPI", fetchImpl: this.f, now: o.now });
  }
  async token(): Promise<string> { return this.oauth.get(); }
  /** Our sink registration. Never print `password` from this payload. */
  async getSubscriber(): Promise<CoxSubscriber> {
    const raw = obj(await this.get(ENDPOINTS.subscriber.path));
    const { password: _drop, ...safe } = raw as unknown as CoxSubscriber & { password?: string };
    return safe as CoxSubscriber;
  }
  async listSubscriptions(): Promise<CoxSubscription[]> { return asArray(await this.get(ENDPOINTS.subscription.path)) as unknown as CoxSubscription[]; }
  async get(path: string): Promise<unknown> {
    const url = path.startsWith("http") ? path : this.o.baseUrl + path;
    const res = await this.f(url, { headers: { [this.keyHeader]: this.o.apiKey, Accept: mediaType(1), Authorization: `Bearer ${await this.oauth.get()}` } });
    const text = await res.text();
    if (!res.ok) throw new CoxApiError(res.status, url, text);
    try { return JSON.parse(text); } catch { return text; }
  }
}

/* ---------- Mapping. Tolerant of PascalCase/camelCase, v3 string hrefs and v4 {href,id} objects. ---------- */

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {});
export function pick(o: Obj, ...keys: string[]): unknown {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k];
    const lower = k.toLowerCase();
    const found = Object.keys(o).find((kk) => kk.toLowerCase() === lower);
    if (found && o[found] !== undefined && o[found] !== null) return o[found];
  }
  return undefined;
}
const s = (x: unknown): string | undefined => (x === undefined || x === null || x === "" ? undefined : String(x));
const n = (x: unknown): number | undefined => { const v = Number(x); return x === undefined || x === null || x === "" || Number.isNaN(v) ? undefined : v; };
const nz = (x: unknown): number | undefined => { const v = n(x); return v === 0 ? undefined : v; };
const b = (x: unknown): boolean | undefined => (typeof x === "boolean" ? x : typeof x === "string" ? /^(true|yes|1)$/i.test(x) : undefined);
export function asArray(x: unknown): Obj[] {
  if (Array.isArray(x)) return x.map(obj);
  const o = obj(x);
  for (const k of ["items", "Items", "results", "Results", "data", "Data", "vehicles", "Vehicles", "value"]) if (Array.isArray(o[k])) return (o[k] as unknown[]).map(obj);
  return Object.keys(o).length ? [o] : [];
}
/** Vin hrefs end in the id: .../contacts/id/12345?dealerid=1  or  .../vehicles/interest/id/2090659561-0 */
export function idFromHref(x: unknown): string | undefined {
  if (x === undefined || x === null) return undefined;
  if (typeof x === "string") { const m = /\/id\/([^/?]+)|\/(\d+)(?:\?.*)?$/.exec(x); return m?.[1] ?? m?.[2]; }
  if (typeof x === "number") return String(x);
  const o = obj(x);
  if (Object.keys(o).length === 0) return undefined;
  const direct = s(pick(o, "id", "contactId", "leadId", "userId", "vehicleId", "leadSourceId"));
  if (direct) return direct;
  const href = pick(o, "href");
  return typeof href === "string" ? idFromHref(href) : undefined;
}

export function mapLead(raw: unknown, fallbackId: string, fallbackDealer?: string): Lead {
  const o = obj(raw);
  const users = pick(o, "assignedUsers", "salespeople", "salesPersons");
  const firstUser = Array.isArray(users) ? users[0] : users;
  const repId =
    s(pick(o, "assignedUserId", "salesRepId", "salespersonId", "primarySalespersonId", "ownerId", "userId")) ??
    idFromHref(pick(o, "assignedUser", "salesperson", "primarySalesperson", "owner")) ??
    idFromHref(firstUser);
  const src = pick(o, "leadSource", "leadSourceName", "sourceName", "source");
  const primary = obj(pick(o, "primaryVehicleOfInterest"));
  const voiRaw = pick(o, "vehiclesOfInterest", "VehiclesOfInterest", "vehicles");
  const voi = asArray(voiRaw).map((v) => ({ ...v, id: idFromHref(v) }));
  const vehicles: VehicleOfInterest[] = [];
  if (s(pick(primary, "make")) || s(pick(primary, "model"))) vehicles.push(mapVehicle(primary));
  else for (const v of voi) if (s(pick(v, "make")) || s(pick(v, "model"))) vehicles.push(mapVehicle(v));
  const createdRaw = s(pick(o, "createdUtc", "createDateUtc", "createdDateUtc", "created", "createdAt"));
  return {
    id: s(pick(o, "leadId", "id")) ?? idFromHref(pick(o, "href")) ?? fallbackId,
    dealerId: s(pick(o, "dealerId")) ?? idFromHref(pick(o, "dealer")) ?? fallbackDealer ?? "",
    contactId: s(pick(o, "contactId", "customerId")) ?? idFromHref(pick(o, "contact", "customer")) ?? "",
    repId,
    source: typeof src === "string" && !src.startsWith("http") ? src : s(pick(obj(src), "leadSourceName", "name")),
    createdAt: createdRaw ? new Date(createdRaw) : new Date(),
    status: s(pick(o, "leadStatus", "status", "leadStatusType")),
    tcpaOptIn: b(pick(o, "tcpaOptIn", "TCPAOptIn", "smsOptIn")),
    vehicles,
    originalComment: s(pick(o, "comments", "comment", "customerComments", "note")),
  };
}

/** Vehicle-of-interest ids referenced by a lead (v3 hrefs or v4 objects), for follow-up fetches. */
export function leadVehicleIds(raw: unknown): string[] {
  return asArray(pick(obj(raw), "vehiclesOfInterest", "VehiclesOfInterest")).map((v) => idFromHref(v)).filter((x): x is string => !!x);
}

export function mapContact(raw: unknown, fallbackId: string, dealerId: string): Contact {
  const o = obj(raw);
  const info = obj(pick(o, "contactInformation", "ContactInformation"));
  const src = Object.keys(info).length ? info : o;
  const emailsRaw = pick(src, "emails", "emailAddresses", "email");
  const phonesRaw = pick(src, "phones", "phoneNumbers", "phone");
  const emails = asArray(emailsRaw).map((e) => s(pick(e, "emailAddress", "address", "email", "value"))).filter((x): x is string => !!x);
  if (typeof emailsRaw === "string") emails.push(emailsRaw);
  const phones = asArray(phonesRaw).map((p) => s(pick(p, "number", "phoneNumber", "phone", "value"))).filter((x): x is string => !!x);
  if (typeof phonesRaw === "string") phones.push(phonesRaw);
  const prefs = obj(pick(o, "communicationPreferences", "consent", "optIns", "preferences"));
  const smsFlag = b(pick(prefs, "smsOptIn", "textOptIn", "tcpaOptIn", "sms", "text")) ?? b(pick(o, "smsOptIn", "textOptIn", "tcpaOptIn"));
  const smsOptOut = b(pick(prefs, "smsOptOut", "textOptOut", "doNotText")) ?? b(pick(o, "smsOptOut", "textOptOut", "doNotText"));
  let smsConsent: SmsConsent = "unknown";
  if (smsOptOut === true) smsConsent = "revoked";
  else if (smsFlag === true) smsConsent = "granted";
  return {
    id: s(pick(o, "contactId", "id", "customerId")) ?? fallbackId,
    dealerId: s(pick(o, "dealerId")) ?? dealerId,
    firstName: s(pick(src, "firstName", "givenName")) ?? "",
    lastName: s(pick(src, "lastName", "familyName")) ?? "",
    emails: dedupe(emails),
    phones: dedupe(phones).map(normalizePhone),
    smsConsent,
    emailOptOut: b(pick(prefs, "emailOptOut", "doNotEmail")) ?? b(pick(o, "emailOptOut", "doNotEmail")) ?? false,
  };
}

export function mapUser(raw: unknown, fallbackId: string, dealerId: string): Rep {
  const o = obj(raw);
  const first = s(pick(o, "firstName", "givenName"));
  const last = s(pick(o, "lastName", "familyName"));
  const full = s(pick(o, "fullName", "name"));
  const phone = s(pick(o, "mobilePhone", "cellPhone", "phone", "phoneNumber"));
  return {
    id: s(pick(o, "userId", "id")) ?? fallbackId,
    dealerId: s(pick(o, "dealerId")) ?? dealerId,
    firstName: first ?? full?.split(" ")[0] ?? "",
    lastName: last ?? full?.split(" ").slice(1).join(" ") ?? "",
    email: s(pick(o, "emailAddress", "email")),
    phone: phone ? normalizePhone(phone) : undefined,
  };
}

export function mapDealer(raw: unknown, fallbackId: string): Dealer {
  const o = obj(raw);
  return {
    id: s(pick(o, "dealerId", "id")) ?? fallbackId,
    name: s(pick(o, "dealerName", "name")) ?? "",
    phone: s(pick(o, "phone", "phoneNumber")),
    timezone: s(pick(o, "timeZone", "timezone", "ianaTimeZone")),
    address: s(pick(o, "address", "address1", "streetAddress")),
  };
}

export function mapVehicleList(raw: unknown): VehicleOfInterest[] {
  return asArray(raw).map(mapVehicle);
}

/** v1 vehicle-of-interest: year 0 / nulls when the lead source sent nothing. inventoryType NEW|USED|UNKNOWN. */
export function mapVehicle(v: Obj): VehicleOfInterest {
  const inv = obj(pick(v, "inventory", "inventoryVehicle"));
  const src = Object.keys(inv).length ? inv : v;
  const stock = s(pick(src, "stockNumber", "stockNo", "stock"));
  const vin = s(pick(src, "vin", "VIN"));
  const invType = s(pick(v, "inventoryType"))?.toUpperCase();
  const isInventory = b(pick(v, "isInventory")) ?? (invType ? invType !== "UNKNOWN" : !!(stock || Object.keys(inv).length));
  return {
    id: s(pick(v, "vehicleId", "id", "vehicleOfInterestId")) ?? idFromHref(pick(v, "href")),
    year: nz(pick(src, "year", "modelYear")),
    make: s(pick(src, "make", "makeName")),
    model: s(pick(src, "model", "modelName")),
    trim: s(pick(src, "trim", "trimName")),
    stockNumber: stock,
    vin,
    isInventory,
    listedPrice: nz(pick(src, "sellingPrice", "listPrice", "listedPrice", "internetPrice", "price", "msrp")),
  };
}

export function mapInventory(v: Obj): InventoryVehicle {
  const status = s(pick(v, "status", "inventoryStatus", "vehicleStatus"));
  const sold = b(pick(v, "isSold", "sold")) ?? /sold|deliver|wholesale|pending/i.test(status ?? "");
  const inStock = b(pick(v, "inStock", "isAvailable", "available"));
  return {
    stockNumber: s(pick(v, "stockNumber", "stockNo")),
    vin: s(pick(v, "vin", "VIN")),
    year: nz(pick(v, "year", "modelYear")),
    make: s(pick(v, "make")),
    model: s(pick(v, "model")),
    trim: s(pick(v, "trim")),
    status,
    listedPrice: nz(pick(v, "sellingPrice", "listPrice", "internetPrice", "price")),
    available: inStock ?? !sold,
  };
}

const dedupe = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
export function normalizePhone(p: string): string {
  const digits = p.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return p.startsWith("+") ? p : `+${digits}`;
}
