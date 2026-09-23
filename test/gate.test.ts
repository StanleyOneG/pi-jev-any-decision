import assert from "node:assert/strict";
import test from "node:test";
import { Gate } from "../src/delegation-assessment/gate.ts";
import type { Assessment } from "../src/delegation-assessment/policy.ts";

const assessment = (effective: "delegate" | "direct", identity = "one", tokens: number | null = 100): Assessment => ({ identity, phase: "initial", phaseId: identity, choice: effective, effective, origin: "rules", confidence: null, probabilities: null, contextTokens: tokens });

test("enforce and rules-only both require an assessment, observe never blocks", () => {
  for (const mode of ["enforce", "rules-only"] as const) { const gate = new Gate(); gate.newRequest("r"); assert.equal(gate.mayWork(mode, 100, 16_000).allowed, false); }
  const observe = new Gate(); observe.newRequest("r"); assert.equal(observe.mayWork("observe", 1, 16_000).allowed, true);
});

test("phase identities and generations discard concurrent stale results", () => {
  const gate = new Gate(); gate.newRequest("r");
  const first = gate.beginAssessment("initial:a")!;
  const second = gate.beginAssessment("transition:b")!;
  assert.equal(gate.record(first, assessment("direct", "initial:a")), false);
  assert.equal(gate.record(second, assessment("direct", "transition:b")), true);
  assert.equal(gate.mayWork("enforce", 100, 16_000).allowed, true);
  const repeat = gate.beginAssessment("transition:b")!;
  assert.equal(repeat.generation, second.generation, "same semantic state is deduplicated");
});

test("delegate launch itself passes the gate but only confirmed dispatch authorizes follow-on work", () => {
  const gate = new Gate(); gate.newRequest("r"); const snapshot = gate.beginAssessment("initial:a")!; gate.record(snapshot, assessment("delegate", "initial:a"));
  assert.equal(gate.mayWork("enforce", 100, 16_000).allowed, false);
  assert.equal(gate.mayWork("enforce", 100, 16_000, true).allowed, true);
  gate.markDispatch("one"); assert.equal(gate.settleDispatch("one", false), "current-failed");
  assert.equal(gate.mayWork("enforce", 100, 16_000).allowed, false);
  gate.markDispatch("two"); assert.equal(gate.settleDispatch("two", true), "confirmed");
  assert.equal(gate.mayWork("enforce", 100, 16_000).allowed, true);
});

test("stale dispatch failures cannot invalidate a newer permit", () => {
  const gate = new Gate(); gate.newRequest("r");
  const first = gate.beginAssessment("initial:a")!; gate.record(first, assessment("delegate", "initial:a"));
  gate.markDispatch("old");
  const newer = gate.beginAssessment("transition:b")!; gate.record(newer, assessment("direct", "transition:b"));
  assert.equal(gate.settleDispatch("old", false), "stale");
  assert.equal(gate.mayWork("enforce", 100, 16_000).allowed, true);
});

test("refusal is bound to the exact current delegate assessment and growth blocks again", () => {
  const gate = new Gate(); gate.newRequest("r"); const snapshot = gate.beginAssessment("initial:a")!; gate.record(snapshot, assessment("delegate", "initial:a"));
  assert.equal(gate.recordRefusal("Concrete reason", 100, 16_000), true); assert.equal(gate.mayWork("enforce", 100, 16_000).allowed, true);
  assert.equal(gate.needsAssessment(16_100, 16_000), true);
  const transition = gate.beginAssessment("growth:b")!; gate.record(transition, assessment("direct", "growth:b", 16_100));
  assert.equal(gate.recordRefusal("No longer attached", 16_100, 16_000), false);
});
