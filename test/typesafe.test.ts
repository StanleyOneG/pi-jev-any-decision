import assert from "node:assert/strict";
import test from "node:test";
import { askJev } from "../.pi/extensions/delegation-assessment/typesafe.ts";
import type { SystemOneClient } from "../.pi/extensions/delegation-assessment/typesafe.ts";
import type { AssessmentInput } from "../.pi/extensions/delegation-assessment/policy.ts";

const input: AssessmentInput = {
  requestId: "r", phase: "initial", phaseId: "initial-1", nextStep: "Research the documented API and return source links.", contextTokens: null,
  facts: { boundedVerifiableSubtask: true, requiresMostParentContext: false, largeResearch: true, independentWork: false, knownWriteConflict: false },
  roles: [{ name: "researcher", summary: "Official docs researcher.", available: true }], selectedCandidate: { name: "researcher", suitable: true },
};

test("TypeSafe adapter uses one typed Choice and a five-second no-retry request", async () => {
  let captured: unknown;
  const result = await askJev(input, undefined, () => ({
    systemOne: async (request: unknown, options: unknown) => {
      captured = { request, options };
      return { model: "jev-test", answers: { routing: { choice: "delegate", confidence: 0.9, probabilities: { delegate: 0.9, direct: 0.05, insufficient_information: 0.05 } } }, usage: { input_tokens: 1, output_tokens: 1 } } as never;
    },
  } as unknown as SystemOneClient));
  assert.equal(result.choice, "delegate");
  assert.deepEqual(result.probabilities, { delegate: 0.9, direct: 0.05, insufficient_information: 0.05 });
  assert.deepEqual((captured as { options: { timeout: number; retry: { maxRetries: number } } }).options, { timeout: 5000, retry: { maxRetries: 0 }, signal: undefined });
  const state = (captured as { request: { state: Record<string, unknown> } }).request.state;
  assert.equal("raw_user_transcript" in state, false);
  assert.equal("reason" in state, false);
});

test("malformed, out-of-range, and cancelled Choice responses are rejected", async () => {
  for (const answer of [
    { choice: "other", confidence: 1, probabilities: {} },
    { choice: "delegate", confidence: "1", probabilities: { delegate: 1, direct: 0, insufficient_information: 0 } },
    { choice: "delegate", confidence: 1, probabilities: { delegate: 2, direct: 0, insufficient_information: 0 } },
    { choice: "delegate", confidence: 1, probabilities: { delegate: 0.7, direct: 0.2, insufficient_information: 0.2 } },
  ]) await assert.rejects(() => askJev(input, undefined, () => ({ systemOne: async () => ({ model: "jev", answers: { routing: answer }, usage: { input_tokens: 0, output_tokens: 0 } } as never) } as unknown as SystemOneClient)), /Malformed|Unexpected/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => askJev(input, controller.signal, () => ({ systemOne: async (_r: unknown, options: { signal?: AbortSignal }) => { options.signal?.throwIfAborted(); throw new Error("unreachable"); } } as unknown as SystemOneClient)));
});
