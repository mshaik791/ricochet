import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDraft, composeCompliant, normalizeTypography } from "../src/engine/compliance.js";
import { TemplateComposer } from "../src/engine/templateComposer.js";
import type { Composer, ComposeContext } from "../src/engine/composer.js";
import { fixtures } from "./helpers.js";

const ctx = (over: Partial<ComposeContext> = {}): ComposeContext => ({
  kind: "reply", channel: "sms", rep: fixtures().rep, dealerName: "Dublin Mazda", customerFirstName: "Jordan", history: [], ...over,
});
const REQUIRED = "The listed price is what you saw online and we're willing to work with you.";

test("normalizeTypography straightens curly quotes and ellipses", () => {
  assert.equal(normalizeTypography("we’re “here”… "), "we're \"here\"...");
});
test("a curly-apostrophe required line still counts as present after normalization", async () => {
  const llm: Composer = { async compose() { return { body: `${REQUIRED.replace("we're", "we’re")} Want me to set up a time?` }; } };
  const r = await composeCompliant(llm, new TemplateComposer(), ctx({ requiredLines: [REQUIRED] }), 33450);
  assert.equal(r.source, "primary");
  assert.ok(r.draft.body.includes(REQUIRED));
});
test("missing required line is a violation, handoff summaries are exempt from policy", () => {
  assert.equal(checkDraft({ body: "Sure thing, want to come by?" }, ctx({ requiredLines: [REQUIRED] }))[0]!.rule, "required_line");
  assert.deepEqual(checkDraft({ body: "$29,000 out the door; call me — now" }, ctx({ kind: "handoff_summary", channel: "email" })), []);
});
test("composer that throws falls straight to the template", async () => {
  const boom: Composer = { async compose() { throw new Error("api down"); } };
  const r = await composeCompliant(boom, new TemplateComposer(), ctx({ kind: "first_sms" }));
  assert.equal(r.source, "template");
});
