import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const id = Type.String({ maxLength: 80 });
const level = () => StringEnum(["low", "moderate", "high", "unknown"] as const);
const role = Type.Object({ name: id, summary: Type.String({ maxLength: 300 }), purpose: StringEnum(["execution", "research", "review"] as const), available: Type.Boolean(), suitable: Type.Boolean(), authorized: Type.Boolean(), tools: Type.Array(id, { maxItems: 16 }) });
const common = { id, summary: Type.String({ maxLength: 500 }), evidence: Type.String({ maxLength: 400 }), verificationCriteria: Type.String({ maxLength: 400 }) };
const comparison = { contextDependency: level(), decisionsRecorded: StringEnum(["documents", "conversation", "both", "unknown"] as const), handoffEffort: level(), handoffLossRisk: level(), verificationEffort: level(), executionEffort: level(), reworkRisk: level(), expectedBenefit: level(), independentReviewBenefit: level() };
const direct = Type.Object({ ...common, kind: Type.Literal("direct"), roles: Type.Optional(Type.Array(id, { maxItems: 12 })), requiredTools: Type.Optional(Type.Array(id, { maxItems: 12 })), authorized: Type.Optional(Type.Boolean()), writeConflict: Type.Optional(Type.Boolean()), taskSuitability: Type.Optional(StringEnum(["suitable", "unsuitable", "unknown"] as const)), ...Object.fromEntries(Object.entries(comparison).map(([key, value]) => [key, Type.Optional(value)])) });
const delegated = Type.Object({ ...common, kind: Type.Literal("delegated"), roles: Type.Array(id, { minItems: 1, maxItems: 12 }), requiredTools: Type.Array(id, { maxItems: 12 }), authorized: Type.Boolean(), writeConflict: Type.Boolean(), taskSuitability: StringEnum(["suitable", "unsuitable", "unknown"] as const), ...comparison });
/** External tool params only: runtime supplies requestId/context telemetry and a cached roles snapshot to normalizeAssessmentInput. */
export const DELEGATION_ASSESS_PARAMS = Type.Object({
  phase: StringEnum(["initial", "transition", "context_growth"] as const), phaseId: Type.String({ minLength: 1, maxLength: 80 }), nextStep: Type.String({ minLength: 1, maxLength: 2000 }),
  roles: Type.Optional(Type.Array(role, { maxItems: 12 })),
  options: Type.Array(Type.Union([direct, delegated]), { minItems: 1, maxItems: 8 }),
  noDelegationReason: Type.Optional(Type.Object({ code: StringEnum(["trivial_continuation", "no_authorized_delegate", "no_suitable_delegate", "handoff_not_worthwhile"] as const), detail: Type.String({ minLength: 1, maxLength: 300 }) })),
});
