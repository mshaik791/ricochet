import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyInbound, countSentences, dollarAmounts, findViolations, isCompliant } from "../src/engine/policy.js";

const sms = (body: string, listedPrice?: number) => findViolations({ body, channel: "sms", listedPrice }).map((v) => v.rule);

test("clean text passes", () => {
  assert.equal(isCompliant({ body: "Hi Jordan, it's Sam's assistant at Dublin Mazda. Want to set up a quick call?", channel: "sms" }), true);
});
test("em dash, semicolon, bullets, html are style violations", () => {
  assert.ok(sms("Hi — there").includes("style"));
  assert.ok(sms("Hi; there").includes("style"));
  assert.ok(sms("Options:\n- call\n- visit").includes("style"));
  assert.ok(sms("1. call\n2. visit").includes("style"));
  assert.ok(sms("<b>hi</b>").includes("style"));
});
test("banned phrases", () => {
  assert.ok(sms("Just checking in on the CX-5.").includes("banned_phrase"));
  assert.ok(sms("I'm an AI assistant.").includes("banned_phrase"));
  assert.ok(sms("We can do it out the door.").includes("banned_phrase"));
});
test("price talk is rejected", () => {
  for (const b of ["We could do $500 off", "Payments around $400 per month", "APR is 3.9%", "no doc fee", "I can get you between 28k and 30k", "financing available"]) {
    assert.ok(sms(b, 33450).includes("price"), b);
  }
});
test("listed price is the only allowed number", () => {
  assert.deepEqual(sms("It's listed at $33,450 and we're willing to work with you.", 33450), []);
  assert.ok(sms("It's listed at $33,450.", undefined).includes("price"));
  assert.ok(sms("How about $31,000?", 33450).includes("price"));
});
test("length limits", () => {
  assert.ok(sms("a".repeat(321)).includes("length"));
  assert.ok(sms("One. Two. Three. Four.").includes("length"));
  assert.deepEqual(findViolations({ body: "One. Two. Three. Four. Five. Six.", channel: "email" }).map((v) => v.rule), []);
});
test("sentence and dollar helpers", () => {
  assert.equal(countSentences("Hi there. How are you? Good!"), 3);
  assert.deepEqual(dollarAmounts("$33,450 or $30k or 28k"), [33450, 30000, 28000]);
});
test("classifyInbound", () => {
  assert.deepEqual(classifyInbound("STOP"), ["stop"]);
  assert.deepEqual(classifyInbound("Unsubscribe me"), ["stop"]);
  assert.deepEqual(classifyInbound("yes"), ["yes"]);
  assert.ok(classifyInbound("what's the best price?").includes("price"));
  assert.ok(classifyInbound("is it still available?").includes("availability"));
  assert.ok(classifyInbound("are you a real person or a bot").includes("real_person"));
  assert.ok(classifyInbound("can I come in saturday for a test drive").includes("appointment"));
  assert.deepEqual(classifyInbound("cool thanks"), ["other"]);
});
