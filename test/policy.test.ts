import assert from "node:assert/strict";
import test from "node:test";
import { applyPolicy, assessmentIdentity, DEFAULT_POLICY_CONFIG, eligibleOptions, isBoundedServiceAction, isWorkingTool, resolveRelativeCost, validateAssessmentInput, validateRelativeCosts, type AssessmentInput, type ExecutionOption } from "../src/delegation-assessment/policy.ts";

const direct: ExecutionOption = { id: "direct", kind: "direct", summary: "Keep complex decisions with the parent agent.", evidence: "The parent retains important discussion context.", verificationCriteria: "Run focused tests and check the output.", roles: [], requiredTools: [], authorized: true, writeConflict: false, taskSuitability: "suitable", contextDependency: "high", decisionsRecorded: "conversation", handoffEffort: "high", handoffLossRisk: "high", verificationEffort: "moderate", executionEffort: "moderate", reworkRisk: "low", expectedBenefit: "moderate", independentReviewBenefit: "unknown" };
const delegate: ExecutionOption = { ...direct, id: "serial_research", kind: "delegated", summary: "Delegate independent serial documentation research.", evidence: "Official public documentation is sufficient.", verificationCriteria: "Check links against official documentation.", roles: ["researcher"], requiredTools: ["web"], contextDependency: "low", decisionsRecorded: "documents", handoffEffort: "low", handoffLossRisk: "low", expectedBenefit: "high", independentReviewBenefit: "low" };
const input = (options: ExecutionOption[] = [direct, delegate]): AssessmentInput => ({ requestId: "request-1", phase: "initial", phaseId: "initial-1", nextStep: "Inspect official API documentation and return a bounded evidence brief.", roles: [{ name: "researcher", summary: "Read official documentation and provide sources.", purpose: "research", available: true, suitable: true, authorized: true, tools: ["web"] }], options, contextTokens: 500 });
const judgment = (choice: string) => ({ choice, confidence: .9, probabilities: { direct: .1, serial_research: .8, insufficient_information: .05, revise_options: .05 }, model: "mock" });

test("dynamic options and independent serial work remain admissible; review at similar cost is possible", () => {
  const review = { ...delegate, id: "independent_review", summary: "Review implementation independently after writing.", roles: ["reviewer"], requiredTools: ["read"], independentReviewBenefit: "high" as const };
  const mixed = { ...delegate, id: "mixed_execution", summary: "Mix independent research with direct decisions." };
  const state = input([direct, delegate, review, mixed]); state.roles.push({ name: "reviewer", summary: "Read implementation and report concrete defects.", purpose: "review", available: true, suitable: true, authorized: true, tools: ["read"] });
  assert.deepEqual(eligibleOptions(state).admissible.map((o) => o.id), ["direct", "serial_research", "independent_review", "mixed_execution"]);
  assert.equal(applyPolicy(state, DEFAULT_POLICY_CONFIG, judgment("independent_review")).effective, "independent_review");
  assert.equal(resolveRelativeCost(state.roles[1]!, { defaultsByPurpose: { review: "similar" } }), "similar");
  assert.equal(resolveRelativeCost(state.roles[0]!, { defaultsByPurpose: { research: "higher" }, byRole: { researcher: "lower" } }), "lower");
  assert.equal(resolveRelativeCost(state.roles[0]!), "unknown");
});

test("grilling context excludes confirmed high handoff loss; unknown safety needs one revision then direct fallback", () => {
  const high = { ...delegate, contextDependency: "high" as const, decisionsRecorded: "conversation" as const, handoffLossRisk: "high" as const };
  assert.deepEqual(eligibleOptions(input([direct, high])).excluded, [{ optionId: "serial_research", reasons: ["high_handoff_loss"] }]);
  const unknown = { ...high, handoffLossRisk: "unknown" as const };
  const state = input([direct, unknown]);
  assert.deepEqual(eligibleOptions(state).excluded, [{ optionId: "serial_research", reasons: ["transfer_safety_unresolved"] }]);
  assert.equal(applyPolicy(state, DEFAULT_POLICY_CONFIG).needsRevision, true);
  const directChoice = { ...judgment("direct"), probabilities: { direct: .9, insufficient_information: .05, revise_options: .05 } };
  const initial = applyPolicy(state, DEFAULT_POLICY_CONFIG, directChoice);
  assert.equal(initial.choice, "direct"); assert.equal(initial.effective, "direct"); assert.equal(initial.needsRevision, true);
  const exhausted = applyPolicy(state, DEFAULT_POLICY_CONFIG, directChoice, false, 1);
  assert.equal(exhausted.choice, "direct"); assert.equal(exhausted.effective, "direct"); assert.equal(exhausted.needsRevision, false); assert.equal(exhausted.conservativeFallback, true);
  const rules = applyPolicy(state, { ...DEFAULT_POLICY_CONFIG, mode: "rules-only" });
  assert.equal(rules.effective, "direct"); assert.equal(rules.needsRevision, false); assert.equal(rules.conservativeFallback, true);
  assert.deepEqual(rules.excluded, [{ optionId: "serial_research", reasons: ["transfer_safety_unresolved"] }]);
  const result = applyPolicy(state, DEFAULT_POLICY_CONFIG, judgment("insufficient_information"), false, 1);
  assert.equal(result.effective, "direct"); assert.equal(result.needsRevision, false); assert.equal(result.conservativeFallback, true);
  assert.equal(applyPolicy(state, DEFAULT_POLICY_CONFIG, undefined, true).origin, "service-fallback");
});

test("eligibility gives structured reasons for unavailable, unsuitable, unauthorized, missing tools, conflicts", () => {
  const state = input([direct, { ...delegate, authorized: false, writeConflict: true, taskSuitability: "unsuitable", requiredTools: ["shell"] }]);
  state.roles[0] = { ...state.roles[0]!, available: false, authorized: false, suitable: false };
  assert.deepEqual(eligibleOptions(state).excluded[0]?.reasons, ["unauthorized", "write_conflict", "unsuitable", "unavailable_role", "unauthorized_role", "unsuitable_role", "missing_tool"]);
  assert.equal(applyPolicy(state, DEFAULT_POLICY_CONFIG, judgment("serial_research")).effective, "direct");
  assert.equal(applyPolicy(state, { ...DEFAULT_POLICY_CONFIG, mode: "rules-only" }).effective, "direct");
});

test("identity includes option evidence, role capabilities, costs, context bucket, not an attempt flag", () => {
  const state = input(); const hash = assessmentIdentity(state);
  assert.notEqual(hash, assessmentIdentity(input([direct, { ...delegate, evidence: "Different documented evidence here." }])));
  assert.notEqual(hash, assessmentIdentity({ ...state, roles: [{ ...state.roles[0]!, tools: ["shell"] }] }));
  assert.notEqual(hash, assessmentIdentity(state, 16000, { defaultsByPurpose: { research: "lower" } }));
  assert.equal(hash, assessmentIdentity({ ...state, contextTokens: 15999 }));
  assert.notEqual(hash, assessmentIdentity({ ...state, contextTokens: 16000 }));
});

test("all text and categorical fields validated with field-specific repair errors", () => {
  assert.equal(validateAssessmentInput(input()), undefined);
  for (const [field, state] of [
    ["nextStep", { ...input(), nextStep: "api_key=do-not-send" }],
    ["nextStep", { ...input(), nextStep: "Հայերեն text must not pass" }],
    ["nextStep", { ...input(), nextStep: "Ｆｕｌｌｗｉｄｔｈ text must not pass" }],
    ["roles[0].summary", { ...input(), roles: [{ ...input().roles[0]!, summary: "Документация here" }] }],
    ["options[1].evidence", input([direct, { ...delegate, evidence: "secret: keyvalue" }])],
    ["options[1].verificationCriteria", input([direct, { ...delegate, verificationCriteria: "测试 check results" }])],
    ["options[1].summary", input([direct, { ...delegate, summary: "пароль details" }])],
    ["options[1].roles", input([direct, { ...delegate, roles: ["unknown"] }])],
    ["options[1].handoffLossRisk", input([direct, { ...delegate, handoffLossRisk: "safe" as never }])],
  ] as Array<[string, AssessmentInput]>) assert.match(validateAssessmentInput(state) ?? "", new RegExp(field.replace(/[\[\]]/g, "\\$&")));
  assert.match(validateAssessmentInput({ ...input(), facts: { largeResearch: true } } as never) ?? "", /unsupported fields/);
  assert.match(validateAssessmentInput(input([delegate])) ?? "", /direct baseline/);
  assert.match(validateAssessmentInput(input([direct, { ...delegate, id: "revise_options" }])) ?? "", /reserved/);
  assert.match(validateRelativeCosts({ byRole: { researcher: "cheap" } }) ?? "", /relativeCosts.byRole.researcher/);
});

test("bounded read actions remain exempt; working tools remain identified", () => {
  assert.equal(isBoundedServiceAction("subagent", { action: "list", capabilities: true }), true);
  assert.equal(isBoundedServiceAction("bg_wait", {}), true);
  assert.equal(isBoundedServiceAction("subagent", { action: "resume", id: "x" }), false);
  assert.equal(isBoundedServiceAction("subagent", { action: "list", task: "launch" }), false);
  assert.equal(isWorkingTool("delegation_assess"), false); assert.equal(isWorkingTool("bash"), true);
});
