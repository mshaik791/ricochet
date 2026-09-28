/**
 * Verifies every ENDPOINTS entry in src/adapters/vin/cox.ts against the OpenAPI specs in docs/cox/.
 * Exit 0: all present (or spec files missing, with a warning). Exit 1: a path or method is not in the spec.
 */
import { readFileSync, existsSync } from "node:fs";
import { ENDPOINTS } from "../src/adapters/vin/cox.js";

const SPECS: Record<string, string> = {
  "lead-management": "docs/cox/lead-management.openapi.json",
  "connect-event-solution": "docs/cox/connect-event-solution.openapi.json",
};

function loadSpec(file: string): { paths: Record<string, Record<string, unknown>>; basePath?: string; servers?: { url: string }[] } | undefined {
  if (!existsSync(file)) return undefined;
  const raw = readFileSync(file, "utf8");
  try { return JSON.parse(raw); } catch { console.error(`${file} is not JSON. Export the spec as JSON (or convert YAML with: npx yaml2json).`); process.exit(1); }
}

/** Compare ignoring parameter names and trailing slashes: /leads/id/{leadId} == /leads/id/{id} */
const norm = (p: string) => p.replace(/\{[^}]+\}/g, "{}").replace(/\/+$/, "").toLowerCase();

let failures = 0;
const rows: string[] = [];
for (const [spec, file] of Object.entries(SPECS)) {
  const doc = loadSpec(file);
  if (!doc) { rows.push(`WARN  ${spec}: ${file} not found. Download it from the storefront product page.`); continue; }
  const specPaths = Object.keys(doc.paths ?? {});
  const server = doc.servers?.[0]?.url ?? doc.basePath ?? "";
  rows.push(`INFO  ${spec}: ${specPaths.length} paths, server ${server || "(none)"}`);
  for (const [key, ep] of Object.entries(ENDPOINTS)) {
    if (ep.spec !== spec) continue;
    const match = specPaths.find((sp) => norm(sp) === norm(ep.path) || norm(sp).endsWith(norm(ep.path)));
    if (!match) {
      failures++;
      const similar = specPaths.filter((sp) => sp.toLowerCase().includes(ep.path.split("/")[1] ?? "")).slice(0, 5);
      rows.push(`FAIL  ${key}: ${ep.method} ${ep.path} not in spec.${similar.length ? ` Similar: ${similar.join(", ")}` : ""}`);
      continue;
    }
    const methods = Object.keys(doc.paths[match] ?? {}).map((m) => m.toUpperCase());
    if (!methods.includes(ep.method)) { failures++; rows.push(`FAIL  ${key}: ${match} exists but has no ${ep.method} (has ${methods.join(",")})`); continue; }
    rows.push(`OK    ${key}: ${ep.method} ${match}`);
  }
}
console.log(rows.join("\n"));
if (failures) { console.error(`\n${failures} endpoint(s) differ from the spec. Fix ENDPOINTS in src/adapters/vin/cox.ts.`); process.exit(1); }
console.log("\nEndpoint table matches the specs that are present.");
