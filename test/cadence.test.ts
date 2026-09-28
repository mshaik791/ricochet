import { test } from "node:test";
import assert from "node:assert/strict";
import { atStoreHour, deferOutOfQuietHours, isQuietHours, planCadence, resolveChannel, storeParts } from "../src/engine/cadence.js";
import { T0, TZ, MIN, HOUR } from "./helpers.js";

test("full plan for phone+email lead at 10am store time", () => {
  const plan = planCadence(T0, { hasPhone: true, hasEmail: true, tz: TZ });
  assert.deepEqual(plan.map((p) => p.kind), ["first_sms", "first_email", "email_3h", "next_morning", "day2", "day3_last"]);
  assert.equal(plan[0]!.runAt.getTime() - T0.getTime(), 1 * MIN);
  assert.equal(plan[1]!.runAt.getTime() - T0.getTime(), 2 * MIN);
  assert.equal(plan[2]!.runAt.getTime() - T0.getTime(), 3 * HOUR + 10 * MIN);
  for (const [i, day] of [[3, 29], [4, 30], [5, 1]] as const) {
    const p = storeParts(plan[i]!.runAt, TZ);
    assert.equal(p.hour, 9, `step ${i} at 9am`); assert.equal(p.day, day, `step ${i} on the right day`);
  }
});
test("email-only lead gets email at +1 and no sms steps", () => {
  const plan = planCadence(T0, { hasPhone: false, hasEmail: true, tz: TZ });
  assert.equal(plan[0]!.kind, "first_email");
  assert.equal(plan[0]!.runAt.getTime() - T0.getTime(), 1 * MIN);
  assert.ok(!plan.some((p) => p.kind === "first_sms"));
});
test("no contact channels gives an empty plan", () => {
  assert.deepEqual(planCadence(T0, { hasPhone: false, hasEmail: false, tz: TZ }), []);
});
test("quiet hours: 10pm lead defers first touches to 8am next day", () => {
  const tenPm = new Date("2026-09-29T05:00:00Z"); // 10pm PDT on the 28th
  assert.equal(isQuietHours(tenPm, TZ), true);
  const plan = planCadence(tenPm, { hasPhone: true, hasEmail: true, tz: TZ });
  const p = storeParts(plan[0]!.runAt, TZ);
  assert.equal(p.hour, 8); assert.equal(p.day, 29);
  const q = storeParts(deferOutOfQuietHours(new Date("2026-09-29T10:30:00Z"), TZ), TZ); // 3:30am
  assert.equal(q.hour, 8); assert.equal(q.day, 29);
});
test("atStoreHour respects DST boundary", () => {
  const beforeDst = new Date("2026-10-31T17:00:00Z");
  const r = atStoreHour(beforeDst, 9, TZ);
  assert.equal(storeParts(r, TZ).hour, 9);
});
test("resolveChannel falls back to email without sms consent", () => {
  assert.equal(resolveChannel("next_morning", "granted", true, true), "sms");
  assert.equal(resolveChannel("next_morning", "unknown", true, true), "email");
  assert.equal(resolveChannel("next_morning", "unknown", true, false), null);
  assert.equal(resolveChannel("first_sms", "unknown", false, true), null);
});
