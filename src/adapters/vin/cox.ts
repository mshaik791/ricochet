import type { Contact, Dealer, InventoryVehicle, Lead, Rep, SmsConsent, VehicleOfInterest } from "../../domain/types.js";
import type { ActivityLog, VinAdapter } from "./types.js";

/**
 * CoxAdapter: VinSolutions Lead Management 1.0 (sandbox) + Connect Event Service 1.0.
 *
 * Every REST call goes through ENDPOINTS below. `npm run cox:spec-check` validates each
 * method+path against docs/cox/lead-management.openapi.json and
 * docs/cox/connect-event-solution.openapi.json when those files are present, so a path that
 * differs from the spec fails loudly before it fails in the sandbox.
 *
 * Vin responses are HATEOAS-style in places: a lead carries `href`s to its contact, vehicles and
 * users. When an href is present we follow it instead of building the path ourselves, which makes
 * this adapter tolerant of path differences between v3 media types.
 */

export interface CoxEndpoint { method: "GET" | "POST" | "PUT" | "PATCH"; path: string; spec: "lead-management" | "connect-event-solution"; note?: string }

export const ENDPOINTS = {
  lead:          { method: "GET",  path: "/leads/id/{leadId}",                    spec: "lead-management" },
  contact:       { method: "GET",  path: "/contacts/id/{contactId}",              spec: "lead-management", note: "?dealerId=" },
  user:          { method: "GET",  path: "/users/id/{userId}",                    spec: "lead-management", note: "?dealerId=" },
  dealer:        { method: "GET",  path: "/dealers/id/{dealerId}",                spec: "lead-management" },
  leadVehicles:  { method: "GET",  path: "/vehicles/interest",                    spec: "lead-management", note: "?leadId=&dealerId=" },
  inventory:     { method: "GET",  path: "/vehicles/inventory",                   spec: "lead-management", note: "?dealerId=&stockNumber=|vin=" },
  leadNote:      { method: "POST", path: "/leads/id/{leadId}/notes",              spec: "lead-management", note: "body {dealerId, note}" },
  leadUpdate:    { method: "PUT",  path: "/leads/id/{leadId}",                    spec: "lead-management" },
  contactUpdate: { method: "PUT",  path: "/contacts/id/{contactId}",              spec: "lead-management", note: "consent flags" },
  eventTypes:    { method: "GET",  path: "/eventtypes",                           spec: "connect-event-solution" },
  eventSinks:    { method: "GET",  path: "/eventsinks",                           spec: "connect-event-solution" },
  subscriptions: { method: "GET",  path: "/subscriptions",                        spec: "connect-event-solution" },
} as const satisfies Record<string, CoxEndpoint>;

export interface LeadManagementOptions {
  baseUrl: string;
  apiKey: string;
  accept?: string;
  /** Optional OAuth on top of the API key. Leave unset for the sandbox unless the product page requires it. */
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Note prefix so reps can tell assistant activity from their own. */
  notePrefix?: string;
}

export interface EventServiceOptions {
  baseUrl: string;
  apiKey: string;
  accept?: string;
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

/* ---------- Lead Management adapter ---------- */

export class CoxAdapter implements VinAdapter {
  private readonly f: typeof fetch;
  private readonly accept: string;
  private readonly oauth?: ClientCredentials;
  private readonly notePrefix: string;

  constructor(private readonly o: LeadManagementOptions) {
    this.f = o.fetchImpl ?? fetch;
    this.accept = o.accept ?? "application/vnd.coxauto.v3+json";
    this.notePrefix = o.notePrefix ?? "[Ricochet]";
    if (o.tokenUrl && o.clientId && o.clientSecret) {
      this.oauth = new ClientCredentials({ tokenUrl: o.tokenUrl, clientId: o.clientId, clientSecret: o.clientSecret, scope: o.scope ?? "PublicAPI", fetchImpl: this.f, now: o.now });
    }
  }

  /* --- public API --- */

  async getLead(leadId: string, dealerId?: string): Promise<Lead> {
    const raw = await this.get(this.url("lead", { leadId }, dealerId ? { dealerId } : {}));
    return mapLead(raw, leadId, dealerId);
  }

  async getContact(contactId: string, dealerId: string): Promise<Contact> {
    const raw = await this.get(this.url("contact", { contactId }, { dealerId }));
    return mapContact(raw, contactId, dealerId);
  }

  async getUser(userId: string, dealerId: string): Promise<Rep> {
    const raw = await this.get(this.url("user", { userId }, { dealerId }));
    return mapUser(raw, userId, dealerId);
  }

  async getDealer(dealerId: string): Promise<Dealer> {
    const raw = await this.get(this.url("dealer", { dealerId }));
    return mapDealer(raw, dealerId);
  }

  async getLeadVehicles(leadId: string, dealerId: string): Promise<VehicleOfInterest[]> {
    const raw = await this.get(this.url("leadVehicles", {}, { leadId, dealerId }));
    return mapVehicleList(raw);
  }

  async findInventory(dealerId: string, q: { stockNumber?: string; vin?: string }): Promise<InventoryVehicle | undefined> {
    if (!q.stockNumber && !q.vin) return undefined;
    const query: Record<string, string> = { dealerId };
    if (q.stockNumber) query.stockNumber = q.stockNumber;
    if (q.vin) query.vin = q.vin;
    let raw: unknown;
    try {
      raw = await this.get(this.url("inventory", {}, query));
    } catch (e) {
      if (e instanceof CoxApiError && e.status === 404) return undefined;
      throw e;
    }
    const list = asArray(raw);
    const first = list[0];
    return first ? mapInventory(first) : undefined;
  }

  async logActivity(a: ActivityLog): Promise<void> {
    const dir = a.direction === "out" ? "to customer" : "from customer";
    const subj = a.subject ? ` "${a.subject}"` : "";
    const note = `${this.notePrefix} ${a.channel.toUpperCase()} ${dir}${subj} at ${a.at.toISOString()}\n${a.body}`;
    await this.addLeadNote(a.leadId, a.dealerId, note);
  }

  async addLeadNote(leadId: string, dealerId: string, note: string): Promise<void> {
    await this.send("POST", this.url("leadNote", { leadId }), { dealerId: Number(dealerId) || dealerId, note });
  }

  async setSmsConsent(contactId: string, dealerId: string, granted: boolean, source: string): Promise<void> {
    // Consent flags live on the contact. We PATCH the minimal shape and always leave a note so the
    // change is visible on the timeline even if the field name differs in the spec.
    await this.send("PUT", this.url("contactUpdate", { contactId }, { dealerId }), {
      dealerId: Number(dealerId) || dealerId,
      smsOptIn: granted,
      textOptIn: granted,
      consentSource: source,
    });
  }

  /** Follow a HATEOAS href returned by Vin (same auth, same media type). */
  async getByHref<T = unknown>(href: string): Promise<T> {
    return (await this.get(href.startsWith("http") ? href : this.o.baseUrl + href)) as T;
  }

  /* --- HTTP plumbing --- */

  url(key: keyof typeof ENDPOINTS, params: Record<string, string>, query: Record<string, string> = {}): string {
    let path: string = ENDPOINTS[key].path;
    for (const [k, v] of Object.entries(params)) path = path.replace(`{${k}}`, encodeURIComponent(v));
    const qs = new URLSearchParams(query).toString();
    return this.o.baseUrl + path + (qs ? `?${qs}` : "");
  }

  private async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = { "x-api-key": this.o.apiKey, Accept: this.accept, "Content-Type": this.accept };
    if (this.oauth) h.Authorization = `Bearer ${await this.oauth.get()}`;
    return h;
  }

  private async get(url: string): Promise<unknown> {
    return this.request("GET", url);
  }

  private async send(method: "POST" | "PUT" | "PATCH", url: string, body: unknown): Promise<unknown> {
    return this.request(method, url, body);
  }

  private async request(method: string, url: string, body?: unknown, retried = false): Promise<unknown> {
    const res = await this.f(url, { method, headers: await this.headers(), body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401 && this.oauth && !retried) { this.oauth.invalidate(); return this.request(method, url, body, true); }
    const text = await res.text();
    if (!res.ok) throw new CoxApiError(res.status, url, text);
    if (!text) return undefined;
    try { return JSON.parse(text); } catch { return text; }
  }
}

/* ---------- Connect Event Service client (management/read side; delivery is push to our sink) ---------- */

export class CoxEventsClient {
  private readonly f: typeof fetch;
  readonly oauth: ClientCredentials;
  private readonly accept: string;
  constructor(private readonly o: EventServiceOptions) {
    this.f = o.fetchImpl ?? fetch;
    this.accept = o.accept ?? "application/vnd.coxauto.v1+json";
    this.oauth = new ClientCredentials({ tokenUrl: o.tokenUrl, clientId: o.clientId, clientSecret: o.clientSecret, scope: o.scope ?? "PublicAPI", fetchImpl: this.f, now: o.now });
  }
  async token(): Promise<string> { return this.oauth.get(); }
  async listEventTypes(): Promise<unknown> { return this.get(ENDPOINTS.eventTypes.path); }
  async listEventSinks(): Promise<unknown> { return this.get(ENDPOINTS.eventSinks.path); }
  async listSubscriptions(): Promise<unknown> { return this.get(ENDPOINTS.subscriptions.path); }
  async get(path: string): Promise<unknown> {
    const url = path.startsWith("http") ? path : this.o.baseUrl + path;
    const res = await this.f(url, { headers: { "x-api-key": this.o.apiKey, Accept: this.accept, Authorization: `Bearer ${await this.oauth.get()}` } });
    const text = await res.text();
    if (!res.ok) throw new CoxApiError(res.status, url, text);
    try { return JSON.parse(text); } catch { return text; }
  }
}

/* ---------- Mapping. Tolerant of PascalCase/camelCase and href-linked sub-resources. ---------- */

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
const b = (x: unknown): boolean | undefined => (typeof x === "boolean" ? x : typeof x === "string" ? /^(true|yes|1)$/i.test(x) : undefined);
export function asArray(x: unknown): Obj[] {
  if (Array.isArray(x)) return x.map(obj);
  const o = obj(x);
  for (const k of ["items", "Items", "results", "Results", "data", "Data", "vehicles", "Vehicles", "value"]) if (Array.isArray(o[k])) return (o[k] as unknown[]).map(obj);
  return Object.keys(o).length ? [o] : [];
}
/** Vin hrefs end in the numeric id: .../contacts/id/12345 */
export function idFromHref(x: unknown): string | undefined {
  if (typeof x === "string") { const m = /\/(\d+)(?:\?.*)?$/.exec(x); return m?.[1]; }
  const o = obj(x);
  return s(pick(o, "id", "contactId", "leadId", "userId", "vehicleId")) ?? idFromHref(pick(o, "href"));
}

export function mapLead(raw: unknown, fallbackId: string, fallbackDealer?: string): Lead {
  const o = obj(raw);
  const users = pick(o, "assignedUsers", "salespeople", "salesPersons");
  const firstUser = Array.isArray(users) ? users[0] : users;
  const repId =
    s(pick(o, "assignedUserId", "salesRepId", "salespersonId", "primarySalespersonId", "ownerId")) ??
    idFromHref(pick(o, "assignedUser", "salesperson", "primarySalesperson", "owner")) ??
    idFromHref(firstUser);
  const vehiclesRaw = pick(o, "vehicles", "vehiclesOfInterest", "VehiclesOfInterest");
  const createdRaw = s(pick(o, "createdUtc", "createDateUtc", "createdDateUtc", "created", "createdAt"));
  return {
    id: s(pick(o, "leadId", "id")) ?? fallbackId,
    dealerId: s(pick(o, "dealerId")) ?? idFromHref(pick(o, "dealer")) ?? fallbackDealer ?? "",
    contactId: s(pick(o, "contactId", "customerId")) ?? idFromHref(pick(o, "contact", "customer")) ?? "",
    repId,
    source: s(pick(o, "leadSourceName", "sourceName", "leadSource", "source")),
    createdAt: createdRaw ? new Date(createdRaw) : new Date(),
    status: s(pick(o, "leadStatus", "status", "leadStatusType")),
    tcpaOptIn: b(pick(o, "tcpaOptIn", "TCPAOptIn", "smsOptIn")),
    vehicles: Array.isArray(vehiclesRaw) ? mapVehicleList(vehiclesRaw) : [],
    originalComment: s(pick(o, "comments", "comment", "customerComments", "note")),
  };
}

export function mapContact(raw: unknown, fallbackId: string, dealerId: string): Contact {
  const o = obj(raw);
  const info = obj(pick(o, "contactInformation", "ContactInformation")) ;
  const src = Object.keys(info).length ? info : o;
  const emailsRaw = pick(src, "emails", "emailAddresses", "email");
  const phonesRaw = pick(src, "phones", "phoneNumbers", "phone");
  const emails = asArray(emailsRaw).map((e) => s(pick(e, "emailAddress", "address", "email", "value")) ?? (typeof e === "string" ? e : undefined)).filter((x): x is string => !!x);
  if (typeof emailsRaw === "string") emails.push(emailsRaw);
  const phones = asArray(phonesRaw).map((p) => s(pick(p, "number", "phoneNumber", "phone", "value")) ?? (typeof p === "string" ? p : undefined)).filter((x): x is string => !!x);
  if (typeof phonesRaw === "string") phones.push(phonesRaw);
  const prefs = obj(pick(o, "communicationPreferences", "consent", "optIns", "preferences"));
  const smsFlag = b(pick(prefs, "smsOptIn", "textOptIn", "tcpaOptIn", "sms", "text")) ?? b(pick(o, "smsOptIn", "textOptIn", "tcpaOptIn"));
  const smsOptOut = b(pick(prefs, "smsOptOut", "textOptOut", "doNotText")) ?? b(pick(o, "smsOptOut", "textOptOut", "doNotText"));
  let smsConsent: SmsConsent = "unknown";
  if (smsOptOut === true) smsConsent = "revoked";
  else if (smsFlag === true) smsConsent = "granted";
  else if (smsFlag === false && smsOptOut === undefined) smsConsent = "unknown";
  return {
    id: s(pick(o, "contactId", "id", "customerId")) ?? fallbackId,
    dealerId: s(pick(o, "dealerId")) ?? dealerId,
    firstName: s(pick(src, "firstName", "givenName")) ?? "",
    lastName: s(pick(src, "lastName", "familyName")) ?? "",
    emails: normalizePhonesOrEmails(emails),
    phones: normalizePhonesOrEmails(phones).map(normalizePhone),
    smsConsent,
    emailOptOut: b(pick(prefs, "emailOptOut", "doNotEmail")) ?? b(pick(o, "emailOptOut", "doNotEmail")) ?? false,
  };
}

export function mapUser(raw: unknown, fallbackId: string, dealerId: string): Rep {
  const o = obj(raw);
  const first = s(pick(o, "firstName", "givenName"));
  const last = s(pick(o, "lastName", "familyName"));
  const full = s(pick(o, "fullName", "name"));
  return {
    id: s(pick(o, "userId", "id")) ?? fallbackId,
    dealerId: s(pick(o, "dealerId")) ?? dealerId,
    firstName: first ?? full?.split(" ")[0] ?? "",
    lastName: last ?? full?.split(" ").slice(1).join(" ") ?? "",
    email: s(pick(o, "emailAddress", "email")),
    phone: (() => { const p = s(pick(o, "mobilePhone", "cellPhone", "phone", "phoneNumber")); return p ? normalizePhone(p) : undefined; })(),
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

export function mapVehicle(v: Obj): VehicleOfInterest {
  const inv = obj(pick(v, "inventory", "inventoryVehicle"));
  const src = Object.keys(inv).length ? inv : v;
  const price = n(pick(src, "listPrice", "listedPrice", "internetPrice", "sellingPrice", "price", "msrp"));
  const stock = s(pick(src, "stockNumber", "stockNo", "stock"));
  const vin = s(pick(src, "vin", "VIN"));
  const isInventory = b(pick(v, "isInventory", "inventoryVehicle")) ?? !!(stock || (Object.keys(inv).length > 0));
  return {
    id: s(pick(v, "vehicleId", "id", "vehicleOfInterestId")),
    year: n(pick(src, "year", "modelYear")),
    make: s(pick(src, "make", "makeName")),
    model: s(pick(src, "model", "modelName")),
    trim: s(pick(src, "trim", "trimName")),
    stockNumber: stock,
    vin,
    isInventory,
    listedPrice: price,
  };
}

export function mapInventory(v: Obj): InventoryVehicle {
  const status = s(pick(v, "status", "inventoryStatus", "vehicleStatus"));
  const sold = b(pick(v, "isSold", "sold")) ?? /sold|deliver|wholesale|pending/i.test(status ?? "");
  const inStock = b(pick(v, "inStock", "isAvailable", "available"));
  return {
    stockNumber: s(pick(v, "stockNumber", "stockNo")),
    vin: s(pick(v, "vin", "VIN")),
    year: n(pick(v, "year", "modelYear")),
    make: s(pick(v, "make")),
    model: s(pick(v, "model")),
    trim: s(pick(v, "trim")),
    status,
    listedPrice: n(pick(v, "listPrice", "internetPrice", "sellingPrice", "price")),
    available: inStock ?? !sold,
  };
}

function normalizePhonesOrEmails(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}
export function normalizePhone(p: string): string {
  const digits = p.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return p.startsWith("+") ? p : `+${digits}`;
}
