import assert from "node:assert/strict";
import test from "node:test";
import { applyPolicy, assessmentIdentity, DEFAULT_POLICY_CONFIG, isBoundedServiceAction, rulesRecommendDelegate, validateAssessmentInput, type AssessmentInput } from "../src/delegation-assessment/policy.ts";

const role = [{ name: "researcher", summary: "Find official documentation and return sources.", available: true }];
const base = (facts: Partial<AssessmentInput["facts"]> = {}): AssessmentInput => ({ requestId: "request-1", phase: "initial", phaseId: "initial-1", nextStep: "Inspect official API documentation and return a bounded evidence brief.", roles: role, selectedCandidate: { name: "researcher", suitable: true }, contextTokens: 500, facts: { boundedVerifiableSubtask: true, requiresMostParentContext: false, largeResearch: false, independentWork: false, knownWriteConflict: false, ...facts } });

test("frozen policy cases use explicit selected suitability evidence", () => {
  assert.equal(rulesRecommendDelegate(base({ largeResearch: true })), true);
  assert.equal(rulesRecommendDelegate(base({ independentWork: true })), true);
  assert.equal(rulesRecommendDelegate(base()), false);
  assert.equal(rulesRecommendDelegate({ ...base({ independentWork: true }), selectedCandidate: { name: "researcher", suitable: false } }), false);
  assert.equal(rulesRecommendDelegate(base({ independentWork: true, knownWriteConflict: true })), false);
});
test("rules-only and uncertain Jev retain the same hard policy", () => {
  const independent = base({ independentWork: true }); const probabilities = { delegate: 0.8, direct: 0.1, insufficient_information: 0.1 };
  assert.equal(applyPolicy(independent, { ...DEFAULT_POLICY_CONFIG, mode: "rules-only" }).effective, "delegate");
  assert.equal(applyPolicy(independent, DEFAULT_POLICY_CONFIG, { choice: "delegate", confidence: 0.2, probabilities, model: "jev" }).effective, "delegate");
  assert.equal(applyPolicy(base(), DEFAULT_POLICY_CONFIG, { choice: "delegate", confidence: 0.99, probabilities, model: "jev" }).effective, "direct");
});
test("identity covers semantic summary, facts, role summaries, candidate, and buckets", () => {
  const input = base({ independentWork: true }); const identity = assessmentIdentity(input);
  assert.notEqual(identity, assessmentIdentity({ ...input, nextStep: "Different bounded English next step summary." }));
  assert.notEqual(identity, assessmentIdentity({ ...input, roles: [{ ...role[0]!, summary: "Different capability." }] }));
  assert.notEqual(identity, assessmentIdentity({ ...input, selectedCandidate: { name: "researcher", suitable: false } }));
  assert.equal(identity, assessmentIdentity({ ...input, contextTokens: 15_999 }));
  assert.notEqual(identity, assessmentIdentity({ ...input, contextTokens: 16_000 }));
});
test("only bounded read/control service shapes bypass the gate", () => {
  assert.equal(isBoundedServiceAction("subagent", { action: "list", capabilities: true }), true);
  assert.equal(isBoundedServiceAction("subagent", { action: "children.list" }), true);
  assert.equal(isBoundedServiceAction("bg_wait", {}), true);
  assert.equal(isBoundedServiceAction("subagent", { action: "resume", id: "x", message: "work" }), false);
  assert.equal(isBoundedServiceAction("subagent", { action: "list", agent: "worker", task: "launch" }), false);
  assert.equal(isBoundedServiceAction("subagent", { action: "unknown" }), false);
});
test("practical input guards reject unsafe or invalid phase data", () => {
  assert.match(validateAssessmentInput({ ...base(), nextStep: "api_key=do-not-send" }) ?? "", /secret/i);
  assert.match(validateAssessmentInput({ ...base(), phaseId: "with spaces" }) ?? "", /phaseId/i);
  assert.equal(validateAssessmentInput(base()), undefined);
});
