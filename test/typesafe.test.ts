import assert from "node:assert/strict";
import test from "node:test";
import { askJev, buildChoiceRequest, type SystemOneClient } from "../src/delegation-assessment/typesafe.ts";
import type { AssessmentInput } from "../src/delegation-assessment/policy.ts";

const direct = { id: "direct", kind: "direct", summary: "Parent handles decisions directly.", evidence: "Parent knows all user decisions.", verificationCriteria: "Run tests and inspect changes.", roles: [], requiredTools: [], authorized: true, writeConflict: false, taskSuitability: "suitable", contextDependency: "high", decisionsRecorded: "conversation", handoffEffort: "high", handoffLossRisk: "high", verificationEffort: "moderate", executionEffort: "moderate", reworkRisk: "low", expectedBenefit: "moderate", independentReviewBenefit: "unknown" } as const;
const delegated = { ...direct, id: "research", kind: "delegated", summary: "Research official API documents independently.", evidence: "Official public documents cover the answer.", verificationCriteria: "Verify citations from official sources.", roles: ["researcher"], requiredTools: ["web"], contextDependency: "low", decisionsRecorded: "documents", handoffEffort: "low", handoffLossRisk: "low", expectedBenefit: "high" } as const;
const input: AssessmentInput = { requestId: "request", phase: "initial", phaseId: "phase-one", nextStep: "Research the documented API and return source links.", contextTokens: null,
  roles: [{ name: "researcher", summary: "Research official documentation and cite sources.", purpose: "research", available: true, suitable: true, authorized: true, tools: ["web"] }],
  options: [{ ...direct, roles: [], requiredTools: [] }, { ...delegated, roles: ["researcher"], requiredTools: ["web"] }],
};
const probabilities = { direct: .05, research: .9, insufficient_information: .03, revise_options: .02 };
const response = (choice: string, probs: Record<string, unknown> = probabilities) => ({ model: "jev-test", answers: { routing: { choice, confidence: .9, probabilities: probs } }, usage: { input_tokens: 1, output_tokens: 1 } });
const client = (answer: unknown) => ({ systemOne: async () => answer as never } as unknown as SystemOneClient);

test("dynamic Choice compares admissible IDs with two fixed abstentions, bounded state, no retries and opt-in debug", async () => {
  let captured: any; const events: any[] = [];
  const result = await askJev(input, undefined, () => ({ systemOne: async (request: unknown, options: unknown) => {
    captured = { request, options }; return response("research") as never;
  } } as unknown as SystemOneClient), async (event) => { events.push(event); }, { defaultsByPurpose: { research: "similar" } });
  assert.deepEqual(Object.keys(captured.request.questions.routing.criteria), ["direct", "research", "insufficient_information", "revise_options"]);
  assert.equal(captured.request.state.roles[0].relative_cost, "similar");
  assert.equal(result.choice, "research"); assert.deepEqual(result.probabilities, probabilities);
  assert.deepEqual(captured.options, { timeout: 5000, retry: { maxRetries: 0 }, signal: undefined });
  assert.deepEqual(events.map((event) => event.event), ["request", "response"]);
  assert.deepEqual(events[0].payload, captured.request);
  assert.equal(JSON.stringify(events).includes("headers"), false);
  assert.equal("raw_user_transcript" in captured.request.state, false);
});

test("request builder filters exclusions, validates every field before client or debug call, strips parent model identifier", async () => {
  const state = { ...input, options: [input.options[0]!, { ...input.options[1]!, writeConflict: true }], parentContext: {
    model: "provider/private-model", contextWindowTokens: 270000, configuredSmartZoneTokens: 150000, smartZoneTokens: 150000,
    remainingTokens: 40000, smartZoneState: "near" as const, childContext: "unknown" as const } };
  const request = buildChoiceRequest(state);
  assert.deepEqual(Object.keys(request.questions.routing.criteria), ["direct", "insufficient_information", "revise_options"]);
  assert.equal(JSON.stringify(request).includes("private-model"), false);
  assert.equal(request.state.parent_context?.smart_zone_state, "near");
  let called = false;
  await assert.rejects(() => askJev({ ...input, options: [input.options[0]!, { ...input.options[1]!, evidence: "密钥 must not pass" }] }, undefined,
    () => { called = true; return client(response("direct")); }, async () => { called = true; }), /options\[1\].evidence/);
  assert.equal(called, false);
});

test("all forwarded identifiers reject obvious secrets before client or debug invocation", async () => {
  const secret = "sk-abcdefghijklmnop";
  const cases: Array<[string, (value: AssessmentInput) => void]> = [
    ["options[0].id", (value) => { value.options[0]!.id = secret; }],
    ["roles[0].name", (value) => { value.roles[0]!.name = secret; value.options[1]!.roles = [secret]; }],
    ["roles[0].tools", (value) => { value.roles[0]!.tools = [secret]; }],
    ["options[1].roles", (value) => { value.options[1]!.roles = [secret]; }],
    ["options[1].requiredTools", (value) => { value.options[1]!.requiredTools = [secret]; }],
  ];
  for (const [field, mutate] of cases) {
    const value = structuredClone(input); mutate(value); let called = false;
    await assert.rejects(() => askJev(value, undefined, () => { called = true; return client(response("direct")); }, async () => { called = true; }),
      (error: Error) => error.message.includes(field));
    assert.equal(called, false, field);
  }
});

test("malformed distributions, unknown IDs, missing keys and cancellation are rejected", async () => {
  for (const answer of [
    { ...response("research"), answers: { routing: { ...response("research").answers.routing, choice: ["research"] } } },
    { ...response("research"), answers: { routing: { ...response("research").answers.routing, choice: { toString: () => "research" } } } },
    response("other"), response("research", { ...probabilities, other: 0 }), response("research", { direct: 1 }),
    response("research", { ...probabilities, direct: -1 }), response("research", { ...probabilities, direct: .6 }),
    { ...response("research"), answers: { routing: { ...response("research").answers.routing, confidence: "1" } } },
  ]) await assert.rejects(() => askJev(input, undefined, () => client(answer)), /Malformed/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => askJev(input, controller.signal, () => ({ systemOne: async (_r: unknown, options: { signal?: AbortSignal }) => {
    options.signal?.throwIfAborted(); throw new Error("unreachable");
  } } as unknown as SystemOneClient)), /TypeSafe request failed/);
});
