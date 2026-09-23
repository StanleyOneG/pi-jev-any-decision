import { open } from "node:fs/promises";
import { resolve, join } from "node:path";
import { askJev, buildChoiceRequest } from "../src/delegation-assessment/typesafe.ts";
import { createDebugLog } from "../src/delegation-assessment/debug.ts";
import { applyPolicy, DEFAULT_POLICY_CONFIG, type AssessmentInput, type ExecutionOption, type Role } from "../src/delegation-assessment/policy.ts";

// Synthetic smoke cases, not a quality or cost benchmark. No children are launched.
const parent: ExecutionOption = {
  id: "parent", kind: "direct", summary: "The parent performs the bounded implementation and validates it.",
  evidence: "The parent has the written acceptance criteria and can run focused tests.", verificationCriteria: "Run focused tests and inspect the diff against the written requirements.",
  roles: [], requiredTools: [], authorized: true, writeConflict: false, taskSuitability: "suitable",
  contextDependency: "low", decisionsRecorded: "documents", handoffEffort: "low", handoffLossRisk: "low",
  verificationEffort: "low", executionEffort: "high", reworkRisk: "low", expectedBenefit: "moderate", independentReviewBenefit: "low",
};
const worker: Role = { name: "implementer", summary: "Implement bounded TypeScript changes and run focused tests.", purpose: "execution", available: true, suitable: true, authorized: true, tools: ["read", "edit", "bash"] };
const reviewer: Role = { name: "auditor", summary: "Independently inspect authentication logic and report testable defects.", purpose: "review", available: true, suitable: true, authorized: true, tools: ["read", "bash"] };
const child: ExecutionOption = { ...parent, id: "serial_implementation", kind: "delegated", summary: "One fresh implementer completes the documented change; the parent accepts the diff.", evidence: "Requirements and tests are written. The implementer owns the files exclusively. Parent acceptance is short.", roles: ["implementer"], requiredTools: ["read", "edit", "bash"], executionEffort: "moderate", expectedBenefit: "high" };
const review: ExecutionOption = { ...child, id: "parent_plus_audit", summary: "Parent implements the security change; an independent auditor verifies it before acceptance.", evidence: "Subtle authorization defects can evade self-review. An independent audit checks explicit security invariants.", roles: ["auditor"], requiredTools: ["read", "bash"], executionEffort: "moderate", independentReviewBenefit: "high" };
const costs = { defaultsByPurpose: { execution: "lower", research: "lower", review: "similar" } } as const;
function scenario(id: string, nextStep: string, options: ExecutionOption[], roles = [worker, reviewer]): AssessmentInput {
  return { requestId: `probe:${id}`, phase: "initial", phaseId: id, nextStep, options, roles, contextTokens: 80000 };
}
const cases = [
  { name: "documented_serial_work", expected: "serial_implementation", input: scenario("serial", "Implement a documented opt-in JSONL sink with explicit file ownership and focused tests. There is substantial routine work and little handoff or acceptance overhead.", [parent, child]) },
  { name: "grilling_context", expected: "parent", input: scenario("context", "Implement a decision-sensitive change after extensive requirements discussion; exceptions and rejected alternatives remain only in the parent conversation.", [
    { ...parent, evidence: "Critical unwritten exceptions remain in parent context.", contextDependency: "high", decisionsRecorded: "conversation" },
    { ...child, contextDependency: "high", decisionsRecorded: "conversation", handoffEffort: "high", handoffLossRisk: "high" },
  ]) },
  { name: "tiny_coupled_change", expected: "parent", input: scenario("tiny", "Correct one already-understood condition and run its existing test. Preparing a child brief and accepting a separate report exceeds the remaining work.", [
    { ...parent, executionEffort: "low", evidence: "The parent already located the exact one-line defect and its test." },
    { ...child, handoffEffort: "high", verificationEffort: "high", expectedBenefit: "low" },
  ]) },
  { name: "independent_security_review", expected: "parent_plus_audit", input: scenario("review", "Implement and verify an authentication boundary change. Independent review can catch severe subtle authorization defects; audit cost is comparable to the parent and quality takes priority.", [
    { ...parent, reworkRisk: "high", verificationEffort: "high", evidence: "Self-review alone may repeat the assumptions that caused the authorization defect." }, review,
  ]) },
  { name: "unknown_transfer_safety", expected: "parent", input: scenario("unknown", "Implement a context-dependent change, but the completeness of the handoff has not been established.", [parent, { ...child, contextDependency: "high", handoffLossRisk: "unknown" }]) },
  { name: "dynamic_four_options", expected: "targeted_research", input: scenario("dynamic", "Resolve one undocumented SDK edge case before implementation. A brief primary-source investigation is useful; implementation and review would be premature.", [
    { ...parent, executionEffort: "high", evidence: "Parent could research directly but would consume its larger context on document retrieval." },
    { ...child, expectedBenefit: "low", evidence: "Implementation requirements depend on the unresolved SDK question." },
    { ...review, expectedBenefit: "low", independentReviewBenefit: "low", evidence: "There is no implementation to review yet." },
    { ...child, id: "targeted_research", roles: ["researcher"], requiredTools: ["read"], summary: "A fresh researcher answers only the SDK question with primary references.", evidence: "This independent question is fully stated and source citations make acceptance cheap.", expectedBenefit: "high" },
  ], [worker, reviewer, { ...worker, name: "researcher", purpose: "research", summary: "Read primary SDK documentation and provide exact source references.", tools: ["read"] }]) },
];

if (!process.argv.includes("--live")) {
  console.log(JSON.stringify(cases.map(({ name, input }) => ({ name, request: buildChoiceRequest(input, costs) })), null, 2));
} else {
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not configured; no calls made.");
  const cwd = resolve(process.cwd());
  let evidenceFailed = false;
  const log = createDebugLog(cwd, "dynamic-routing-live-probe", () => { evidenceFailed = true; });
  const record = async (event: Parameters<typeof log.write>[0]) => {
    await log.write(event);
    if (evidenceFailed) throw new Error("Cannot write probe evidence; stop live testing.");
  };
  await record({ event: "probe_setup", plannedCalls: cases.length, hardLimit: 12 });
  // One-shot local approval marker. Never delete automatically or silently rerun paid calls.
  const marker = await open(join(cwd, ".pi/delegation-assessment-debug/dynamic-routing-live-probe.approval-used"), "wx", 0o600);
  await marker.close();
  let attempts = 0;
  for (const item of cases) {
    if (attempts >= 12) throw new Error("Approved live-call limit reached.");
    attempts++;
    const started = Date.now();
    try {
      const judgment = await askJev(item.input, undefined, undefined, (event) => record({ ...event, case: item.name, attempt: attempts }), costs);
      const assessment = applyPolicy(item.input, { ...DEFAULT_POLICY_CONFIG, relativeCosts: costs }, judgment);
      const result = { event: "probe_result", case: item.name, attempt: attempts, expectedEffective: item.expected,
        observedChoice: judgment.choice, effective: assessment.effective, confidence: judgment.confidence,
        matchesExpectation: assessment.effective === item.expected, needsRevision: assessment.needsRevision,
        excluded: assessment.excluded, elapsedMs: Date.now() - started };
      await record(result); console.log(JSON.stringify(result));
    } catch {
      const result = { event: "probe_error", case: item.name, attempt: attempts, elapsedMs: Date.now() - started };
      await record(result); console.log(JSON.stringify(result));
    }
  }
  console.log(JSON.stringify({ attempts, evidence: log.path, additionalAutomaticRetries: 0 }));
}
