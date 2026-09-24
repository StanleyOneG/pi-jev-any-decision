import assert from "node:assert/strict";
import test from "node:test";
import { Gate } from "../src/delegation-assessment/gate.ts";
import type { Assessment } from "../src/delegation-assessment/policy.ts";

const assessment = (effective: string, identity = "one", tokens: number | null = 100): Assessment => ({ identity, phase: "initial", phaseId: identity, choice: effective, effective, origin: "rules", confidence: null, probabilities: null, contextTokens: tokens, excluded: [], needsRevision: false, conservativeFallback: false });

test("enforce and rules-only require freshness while observe never blocks", () => {
  for (const mode of ["enforce", "rules-only"] as const) { const gate = new Gate(); gate.newRequest("r"); assert.equal(gate.mayWork(mode, 100, 16_000).allowed, false); }
  const observe = new Gate(); observe.newRequest("r"); assert.equal(observe.mayWork("observe", 1, 16_000).allowed, true);
});

test("new requests retain accepted advice and its original context baseline, but discard pending work", () => {
  const gate = new Gate(); gate.newRequest("first");
  const accepted = gate.beginAssessment("initial:a")!; gate.record(accepted, assessment("direct", "initial:a", 100));
  gate.markDispatch("old"); gate.recordDeviation("Concrete reason", 100, 1000);
  gate.newRequest("second");
  assert.equal(gate.state.assessment?.contextTokens, 100);
  assert.equal(gate.state.deviation, undefined);
  assert.equal(gate.settleDispatch("old", true), "stale");
  assert.equal(gate.assessmentNeed(1099, 1000), null);
  assert.equal(gate.assessmentNeed(1100, 1000), "context_growth");
  const pending = gate.beginAssessment("transition:b")!;
  gate.newRequest("third");
  assert.equal(gate.record(pending, assessment("direct", "transition:b")), false);
  assert.equal(gate.assessmentNeed(100, 1000), "missing");
});

test("phase identities and generations discard concurrent stale results", () => {
  const gate = new Gate(); gate.newRequest("r");
  const first = gate.beginAssessment("initial:a")!;
  const second = gate.beginAssessment("transition:b")!;
  assert.equal(gate.record(first, assessment("direct", "initial:a")), false);
  assert.equal(gate.record(second, assessment("direct", "transition:b")), true);
  assert.equal(gate.mayWork("enforce", 100, 16_000).allowed, true);
  const repeat = gate.beginAssessment("transition:b")!;
  assert.equal(repeat.generation, second.generation);
});

test("delegated recommendation and unconfirmed launch cannot bar fresh work", () => {
  const gate = new Gate(); gate.newRequest("r"); const snapshot = gate.beginAssessment("initial:a")!; gate.record(snapshot, assessment("serial_review", "initial:a"));
  assert.equal(gate.mayWork("enforce", 100, 16_000).allowed, true);
  gate.markDispatch("one"); assert.equal(gate.settleDispatch("one", false), "current-failed");
  assert.equal(gate.mayWork("enforce", 100, 16_000).allowed, true);
  gate.markDispatch("two"); assert.equal(gate.settleDispatch("two", true), "confirmed");
  assert.equal(gate.mayWork("enforce", 100, 16_000).allowed, true);
});

test("stale dispatch failures cannot invalidate a newer permit", () => {
  const gate = new Gate(); gate.newRequest("r");
  const first = gate.beginAssessment("initial:a")!; gate.record(first, assessment("review", "initial:a"));
  gate.markDispatch("old");
  const newer = gate.beginAssessment("transition:b")!; gate.record(newer, assessment("direct", "transition:b"));
  assert.equal(gate.settleDispatch("old", false), "stale");
  assert.equal(gate.mayWork("enforce", 100, 16_000).allowed, true);
});

test("deviation attaches to any exact fresh recommendation and expires on growth", () => {
  const gate = new Gate(); gate.newRequest("r"); const snapshot = gate.beginAssessment("initial:a")!; gate.record(snapshot, assessment("direct", "initial:a"));
  assert.equal(gate.recordDeviation("Concrete reason", 100, 16_000), true);
  assert.equal(gate.state.deviation?.identity, "initial:a");
  assert.equal(gate.mayWork("enforce", 100, 16_000).allowed, true);
  assert.equal(gate.recordDeviation("Expired reason", 16_100, 16_000), false);
  const transition = gate.beginAssessment("growth:b")!; gate.record(transition, assessment("review", "growth:b", 16_100));
  assert.equal(gate.state.deviation, undefined);
  assert.equal(gate.recordDeviation("Fresh reason", 16_100, 16_000), true);
});
