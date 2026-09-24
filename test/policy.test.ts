import assert from "node:assert/strict";
import test from "node:test";
import { applyPolicy, assessmentIdentity, DEFAULT_POLICY_CONFIG, eligibleOptions, noComparison, normalizeAssessmentInput, isBoundedServiceAction, isWorkingTool, resolveRelativeCost, validateAssessmentInput, validateRelativeCosts, type AssessmentInput, type ExecutionOption } from "../src/delegation-assessment/policy.ts";

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

test("compact direct normalizes to admissible baseline without invented comparison evidence", () => {
  const compact = { id: "direct", kind: "direct" as const, summary: direct.summary, evidence: direct.evidence, verificationCriteria: direct.verificationCriteria };
  const state = normalizeAssessmentInput({ ...input(), roles: undefined, options: [compact, delegate] }, input().roles);
  assert.deepEqual(state.roles, input().roles);
  assert.deepEqual(state.options[0], { ...compact, roles: [], requiredTools: [], authorized: true, writeConflict: false, taskSuitability: "suitable",
    contextDependency: "unknown", decisionsRecorded: "unknown", handoffEffort: "unknown", handoffLossRisk: "unknown", verificationEffort: "unknown", executionEffort: "unknown", reworkRisk: "unknown", expectedBenefit: "unknown", independentReviewBenefit: "unknown" });
  assert.equal(validateAssessmentInput(state), undefined);
  assert.deepEqual(normalizeAssessmentInput({ ...input(), options: [direct, delegate] }).options[0], direct);
});

test("direct-only reason is required and validated even for local routing", () => {
  assert.throws(() => normalizeAssessmentInput({ ...input(), options: [direct] }), /noDelegationReason/);
  const reason = { code: "trivial_continuation" as const, detail: "Only a short direct continuation is useful." };
  assert.deepEqual(normalizeAssessmentInput({ ...input(), options: [direct], noDelegationReason: reason }).noDelegationReason, reason);
  for (const invalid of [{ code: "other", detail: reason.detail }, { code: reason.code, detail: "api_key=supersecret" }, { code: reason.code, detail: "中文 forbidden" }, { code: reason.code, detail: "x".repeat(301) }, { ...reason, extra: true }]) {
    assert.throws(() => normalizeAssessmentInput({ ...input(), options: [direct], noDelegationReason: invalid as never }), /noDelegationReason/);
  }
  assert.throws(() => normalizeAssessmentInput({ ...input(), noDelegationReason: { ...reason, detail: "secret: abc" } }), /noDelegationReason/);
});

test("explicit direct fields cannot silently override admissibility or hide unsafe values", () => {
  for (const option of [
    { ...direct, roles: ["researcher"] }, { ...direct, requiredTools: ["web"] }, { ...direct, authorized: false },
    { ...direct, writeConflict: true }, { ...direct, taskSuitability: "unknown" }, { ...direct, handoffEffort: "bad" },
    { ...direct, evidence: "Bearer abcdefghijklmnopqrstuvwxyz" }, { ...direct, requiredTools: 4 },
  ]) assert.throws(() => normalizeAssessmentInput({ ...input(), options: [option as never, delegate] }), /options\[0\]/);
  assert.throws(() => normalizeAssessmentInput({ ...input(), roles: [], options: [direct, delegate] }), /options\[1\].roles.*researcher/);
  assert.throws(() => normalizeAssessmentInput({ ...input(), facts: {}, options: [direct, delegate] } as never), /unsupported fields/);
});

test("no comparison requires only direct admissible and no unresolved transfer", () => {
  const reason = { code: "handoff_not_worthwhile" as const, detail: "No useful delegation is available." };
  const onlyDirect = normalizeAssessmentInput({ ...input(), options: [direct], noDelegationReason: reason });
  assert.equal(noComparison(onlyDirect), true);
  const filtered = input([direct, { ...delegate, writeConflict: true }]);
  assert.equal(noComparison(filtered), true);
  assert.deepEqual(eligibleOptions(filtered).excluded, [{ optionId: "serial_research", reasons: ["write_conflict"] }]);
  assert.equal(noComparison(input([direct, { ...delegate, contextDependency: "high", handoffLossRisk: "unknown" }])), false);
  assert.equal(noComparison(input()), false);
  const result = applyPolicy(filtered, DEFAULT_POLICY_CONFIG);
  assert.equal(result.reason, "no_comparison"); assert.equal(result.origin, "rules"); assert.equal(result.confidence, null);
  assert.equal(applyPolicy(input(), DEFAULT_POLICY_CONFIG, { ...judgment("serial_research"), confidence: .4 }).reason, "low_confidence");
});

test("benign token and password prose passes while labeled and formatted secrets fail in every model-bound field", () => {
  const safe = "Compare token budget, token overhead, password handling, and secret checks.";
  const state = input(); state.nextStep = safe; state.roles[0]!.summary = safe;
  for (const option of state.options) { option.summary = safe; option.evidence = safe; option.verificationCriteria = safe; }
  assert.equal(validateAssessmentInput(state), undefined);
  for (const text of ["token=abc123", "password: abc123", "Bearer abcdef123456", "bearer: abcdef123456", "bearer=abcdef123456", "-----BEGIN PRIVATE KEY-----", "sk-abcdefghijklmnop", "ghp_abcdefghijklmnop"]) {
    for (const update of [
      (value: AssessmentInput) => { value.nextStep = text; },
      (value: AssessmentInput) => { value.roles[0]!.summary = text; },
      (value: AssessmentInput) => { value.options[0]!.summary = text; },
      (value: AssessmentInput) => { value.options[0]!.evidence = text; },
      (value: AssessmentInput) => { value.options[0]!.verificationCriteria = text; },
    ]) { const value = structuredClone(state); update(value); assert.ok(validateAssessmentInput(value), text); }
  }
});

test("bounded read actions remain exempt; working tools remain identified", () => {
  assert.equal(isBoundedServiceAction("subagent", { action: "list", capabilities: true }), true);
  assert.equal(isBoundedServiceAction("bg_wait", {}), true);
  assert.equal(isBoundedServiceAction("subagent", { action: "resume", id: "x" }), false);
  assert.equal(isBoundedServiceAction("subagent", { action: "list", task: "launch" }), false);
  assert.equal(isWorkingTool("delegation_assess"), false); assert.equal(isWorkingTool("bash"), true);
});
