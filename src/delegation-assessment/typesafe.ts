import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import type { AssessmentInput, Choice, ModelJudgment } from "./policy.ts";
import type { DebugSink } from "./debug.ts";

export interface SystemOneClient {
  systemOne: TypeSafeClient["systemOne"];
}

export type ClientFactory = () => SystemOneClient;

export function createJevClient(): SystemOneClient {
  // SDK v0.6.0: timeout is per attempt; maxRetries: 0 gives one 5s attempt.
  // The SDK resolves TYPESAFE_API_KEY itself. This extension never reads or logs it.
  return new TypeSafeClient({ timeout: 5_000, retry: { maxRetries: 0 }, logLevel: "off" });
}

const CRITERIA = {
  delegate: "Delegate only a bounded, independently verifiable next step to a suitable available role when its handoff does not require most parent context and it is large research or independent work without a known write conflict.",
  direct: "Keep the next step with the main agent when it is small, tightly dependent, conflicts with current writes, needs most parent context, or lacks a suitable available role.",
  insufficient_information: "Use when the bounded summary and policy facts do not support a reliable routing choice.",
} as const;

export async function askJev(input: AssessmentInput, signal: AbortSignal | undefined, factory: ClientFactory = createJevClient, debug?: DebugSink): Promise<ModelJudgment> {
  const request = {
    model: "jev-latest",
    state: {
      next_step: input.nextStep,
      policy_facts: {
        bounded_verifiable_subtask: input.facts.boundedVerifiableSubtask,
        requires_most_parent_context: input.facts.requiresMostParentContext,
        large_research: input.facts.largeResearch,
        independent_work: input.facts.independentWork,
        known_write_conflict: input.facts.knownWriteConflict,
      },
      available_roles: input.roles.filter((role) => role.available).map((role) => ({ name: role.name, capability: role.summary })),
      context_tokens_approximate: input.contextTokens,
      parent_context: input.parentContext ? { ...input.parentContext } : null,
    },
    questions: {
      routing: choice("Choose the safe next-step routing. Parent smart-zone telemetry is a heuristic, not a quality guarantee. Near the budget, prefer independent work in a fresh child with a concise report only when all delegation prerequisites hold. A child does not remove existing parent context; child context usage is unknown. High context alone never requires delegation. Return no explanation; application code owns policy and execution.", CRITERIA),
    },
  };
  // This is the JSON body supplied to systemOne, not headers or credentials.
  await debug?.({ event: "request", payload: request });
  const started = Date.now();
  let response;
  try {
    response = await factory().systemOne(request, { timeout: 5_000, retry: { maxRetries: 0 }, signal });
  } catch {
    await debug?.({ event: "service_error", elapsedMs: Date.now() - started, cancelled: signal?.aborted === true });
    // Do not persist SDK errors: they can contain server bodies or credentials.
    throw new Error("TypeSafe request failed.");
  }
  await debug?.({ event: "response", elapsedMs: Date.now() - started, response: { model: response.model, answers: response.answers, usage: response.usage } });
  const answer = response.answers.routing;
  const raw = answer.probabilities as Record<string, unknown>;
  const probabilities: Record<Choice, number> = {
    delegate: raw.delegate as number,
    direct: raw.direct as number,
    insufficient_information: raw.insufficient_information as number,
  };
  const numbers = [...Object.values(probabilities), answer.confidence];
  if (!numbers.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error("Malformed Jev Choice response.");
  const sum = Object.values(probabilities).reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > 1e-6) throw new Error("Malformed Jev Choice response.");
  if (answer.choice !== "delegate" && answer.choice !== "direct" && answer.choice !== "insufficient_information") throw new Error("Unexpected Jev Choice response.");
  if (typeof response.model !== "string" || !response.model) throw new Error("Malformed Jev Choice response.");
  return { choice: answer.choice, confidence: answer.confidence, probabilities, model: response.model };
}
