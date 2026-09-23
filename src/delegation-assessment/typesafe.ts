import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { eligibleOptions, resolveRelativeCost, validateAssessmentInput, validateRelativeCosts, type AssessmentInput, type ModelJudgment, type RelativeCostConfig } from "./policy.ts";
import type { DebugSink } from "./debug.ts";

export interface SystemOneClient { systemOne: TypeSafeClient["systemOne"]; }
export type ClientFactory = () => SystemOneClient;

export function createJevClient(): SystemOneClient {
  // SDK v0.6.0: timeout is per attempt; maxRetries: 0 gives one 5s attempt.
  // The SDK resolves TYPESAFE_API_KEY itself. This extension never reads or logs it.
  return new TypeSafeClient({ timeout: 5_000, retry: { maxRetries: 0 }, logLevel: "off" });
}

const INSTRUCTIONS = "Choose the best admissible next-stage execution option by its ID. Quality and preservation of important constraints outrank relative cost. Compare suitability, decisions recorded, handoff effort and loss, verification, execution effort, rework, and concrete independent review benefit. Unknown is not favorable evidence; lower cost alone does not establish suitability. Serial independent work can be delegated; high parent context alone does not require it. Return no explanation. Choose insufficient_information when evidence cannot support comparison; choose revise_options when evidence is sufficient but none of the submitted options is acceptable. The parent owns execution and may deviate.";
const ABSTENTIONS = {
  insufficient_information: "Descriptions or evidence are insufficient to compare the submitted admissible options.",
  revise_options: "The descriptions are sufficient, but none of the submitted admissible options is acceptable.",
} as const;

/** Pure, validated, bounded service payload. Never forwards model identifiers, local paths, raw transcripts or unchecked fields. */
export function buildChoiceRequest(input: AssessmentInput, costs: RelativeCostConfig = {}) {
  const invalid = validateAssessmentInput(input) ?? validateRelativeCosts(costs);
  if (invalid) throw new Error(invalid);
  const { admissible } = eligibleOptions(input);
  const criteria: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const option of admissible) criteria[option.id] = option.summary;
  Object.assign(criteria, ABSTENTIONS);
  return {
    model: "jev-latest",
    state: {
      next_step: input.nextStep,
      roles: input.roles.filter((role) => admissible.some((option) => option.roles.includes(role.name))).map((role) => ({
        id: role.name, capability: role.summary, purpose: role.purpose, relative_cost: resolveRelativeCost(role, costs), tools: role.tools,
      })),
      options: admissible.map((option) => ({
        id: option.id, kind: option.kind, summary: option.summary, evidence: option.evidence, verification_criteria: option.verificationCriteria,
        roles: option.roles, required_tools: option.requiredTools, task_suitability: option.taskSuitability,
        context_dependency: option.contextDependency, decisions_recorded: option.decisionsRecorded, handoff_effort: option.handoffEffort,
        handoff_loss_risk: option.handoffLossRisk, verification_effort: option.verificationEffort, execution_effort: option.executionEffort,
        rework_risk: option.reworkRisk, expected_benefit: option.expectedBenefit, independent_review_benefit: option.independentReviewBenefit,
      })),
      context_tokens_approximate: input.contextTokens,
      parent_context: input.parentContext ? { context_window_tokens: input.parentContext.contextWindowTokens,
        smart_zone_tokens: input.parentContext.smartZoneTokens, remaining_tokens: input.parentContext.remainingTokens,
        smart_zone_state: input.parentContext.smartZoneState, child_context: input.parentContext.childContext } : null,
    },
    questions: { routing: choice(INSTRUCTIONS, criteria) },
  };
}

export async function askJev(input: AssessmentInput, signal: AbortSignal | undefined, factory: ClientFactory = createJevClient, debug?: DebugSink, costs: RelativeCostConfig = {}): Promise<ModelJudgment> {
  const request = buildChoiceRequest(input, costs);
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
  const answer = response.answers?.routing;
  const keys = Object.keys(request.questions.routing.criteria);
  const raw = answer?.probabilities;
  if (!answer || !raw || typeof raw !== "object" || Array.isArray(raw) || typeof answer.choice !== "string" || !Object.hasOwn(request.questions.routing.criteria, answer.choice)
    || Object.keys(raw).length !== keys.length || !keys.every((key) => Object.hasOwn(raw, key))) throw new Error("Malformed Jev Choice response.");
  const probabilities = raw as Record<string, number>;
  if (![...Object.values(probabilities), answer.confidence].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)
    || Math.abs(Object.values(probabilities).reduce((total, value) => total + value, 0) - 1) > 1e-6
    || typeof response.model !== "string" || !response.model) throw new Error("Malformed Jev Choice response.");
  return { choice: answer.choice, confidence: answer.confidence, probabilities: { ...probabilities }, model: response.model };
}
