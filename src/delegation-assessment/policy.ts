import { createHash } from "node:crypto";
import type { ParentContext } from "./context-budget.ts";

export type Mode = "observe" | "enforce" | "rules-only" | "off";
export type Phase = "initial" | "transition" | "context_growth";
export type Abstention = "insufficient_information" | "revise_options";
export type Choice = string;
export type Purpose = "execution" | "research" | "review";
export type RelativeCost = "lower" | "similar" | "higher" | "unknown";
export type Level = "low" | "moderate" | "high" | "unknown";
export type RecordedIn = "documents" | "conversation" | "both" | "unknown";
export interface Role {
  name: string; summary: string; purpose: Purpose; available: boolean; suitable: boolean;
  authorized: boolean; tools: string[];
}
export interface ExecutionOption {
  id: string; kind: "direct" | "delegated"; summary: string; evidence: string; verificationCriteria: string;
  roles: string[]; requiredTools: string[]; authorized: boolean; writeConflict: boolean;
  taskSuitability: "suitable" | "unsuitable" | "unknown";
  contextDependency: Level; decisionsRecorded: RecordedIn; handoffEffort: Level; handoffLossRisk: Level;
  verificationEffort: Level; executionEffort: Level; reworkRisk: Level; expectedBenefit: Level;
  independentReviewBenefit: Level;
}
export type NoDelegationCode = "trivial_continuation" | "no_authorized_delegate" | "no_suitable_delegate" | "handoff_not_worthwhile";
export interface NoDelegationReason { code: NoDelegationCode; detail: string; }
export interface AssessmentInput {
  requestId: string; phase: Phase; phaseId: string; nextStep: string;
  roles: Role[]; options: ExecutionOption[]; contextTokens: number | null; parentContext?: ParentContext;
  noDelegationReason?: NoDelegationReason;
}
export type DirectOptionInput = Pick<ExecutionOption, "id" | "kind" | "summary" | "evidence" | "verificationCriteria"> & Partial<Omit<ExecutionOption, "id" | "kind" | "summary" | "evidence" | "verificationCriteria">> & { kind: "direct" };
export type ExternalAssessmentInput = Omit<AssessmentInput, "roles" | "options"> & { roles?: Role[]; options: (DirectOptionInput | ExecutionOption)[] };
export interface RelativeCostConfig {
  defaultsByPurpose?: Partial<Record<Purpose, RelativeCost>>;
  byRole?: Record<string, RelativeCost>;
}
export interface PolicyConfig { mode: Mode; provisionalConfidenceThreshold: number; contextGrowthTokens: number; relativeCosts?: RelativeCostConfig; }
export const DEFAULT_POLICY_CONFIG: PolicyConfig = { mode: "observe", provisionalConfidenceThreshold: 0.7, contextGrowthTokens: 16_000 };
export interface ModelJudgment { choice: Choice; confidence: number; probabilities: Record<string, number>; model: string; }
export interface Exclusion { optionId: string; reasons: ExclusionReason[]; }
export type ExclusionReason = "unauthorized" | "write_conflict" | "unsuitable" | "unknown_suitability" | "unavailable_role" | "unauthorized_role" | "unsuitable_role" | "missing_tool" | "transfer_safety_unresolved" | "high_handoff_loss";
export interface Eligibility { admissible: ExecutionOption[]; excluded: Exclusion[]; needsClarification: boolean; }
export type RoutingReason = "no_comparison" | "rules_only" | "service_failure" | "low_confidence" | "clarification" | "invalid_choice" | "model_choice";
export interface Assessment {
  identity: string; phase: Phase; phaseId: string; choice: Choice; effective: string;
  origin: "jev" | "rules" | "service-fallback"; confidence: number | null;
  probabilities: Record<string, number> | null; contextTokens: number | null; model?: string; parentContext?: ParentContext;
  excluded: Exclusion[]; needsRevision: boolean; conservativeFallback: boolean;
  /** Present on applyPolicy results; optional to preserve existing external Assessment fixtures. */
  reason?: RoutingReason;
}

export function resolveRelativeCost(role: Pick<Role, "name" | "purpose">, config: RelativeCostConfig = {}): RelativeCost {
  return config.byRole && Object.hasOwn(config.byRole, role.name) ? config.byRole[role.name]! : config.defaultsByPurpose?.[role.purpose] ?? "unknown";
}
export function validateRelativeCosts(value: unknown): string | undefined {
  if (value === undefined) return;
  if (!isRecord(value) || !onlyKeys(value, ["defaultsByPurpose", "byRole"])) return "relativeCosts must contain only defaultsByPurpose and byRole.";
  for (const key of ["defaultsByPurpose", "byRole"] as const) {
    const entries = value[key];
    if (entries === undefined) continue;
    if (!isRecord(entries) || Object.keys(entries).length > 24) return `relativeCosts.${key} must be a bounded object.`;
    for (const [name, cost] of Object.entries(entries)) {
      if (key === "defaultsByPurpose" ? !["execution", "research", "review"].includes(name) : !validId(name, 80)) return `relativeCosts.${key}.${name} has an invalid key.`;
      if (!["lower", "similar", "higher", "unknown"].includes(cost as string)) return `relativeCosts.${key}.${name} must be lower, similar, higher, or unknown.`;
    }
  }
}
function contextBucket(tokens: number | null, growth: number): string { return tokens === null ? "unknown" : String(Math.floor(tokens / growth)); }
export function assessmentIdentity(input: AssessmentInput, growth = DEFAULT_POLICY_CONFIG.contextGrowthTokens, costs: RelativeCostConfig = {}): string {
  const semanticKey = JSON.stringify({ requestId: input.requestId, phase: input.phase, phaseId: input.phaseId,
    bucket: contextBucket(input.contextTokens, growth), parentContext: input.parentContext ? { ...input.parentContext, remainingTokens: undefined } : undefined,
    nextStep: input.nextStep, roles: input.roles, options: input.options, noDelegationReason: input.noDelegationReason, costs });
  return createHash("sha256").update(semanticKey).digest("hex");
}
export function eligibleOptions(input: AssessmentInput): Eligibility {
  const excluded: Exclusion[] = [];
  const admissible: ExecutionOption[] = [];
  for (const option of input.options) {
    const reasons: ExclusionReason[] = [];
    if (!option.authorized) reasons.push("unauthorized");
    if (option.writeConflict) reasons.push("write_conflict");
    if (option.taskSuitability === "unsuitable") reasons.push("unsuitable");
    if (option.taskSuitability === "unknown" && option.kind === "delegated") reasons.push("unknown_suitability");
    if (option.kind === "delegated") {
      for (const name of option.roles) {
        const role = input.roles.find((candidate) => candidate.name === name);
        if (!role?.available) reasons.push("unavailable_role");
        if (role && !role.authorized) reasons.push("unauthorized_role");
        if (role && !role.suitable) reasons.push("unsuitable_role");
      }
      if (option.requiredTools.some((tool) => !option.roles.some((name) => input.roles.find((role) => role.name === name && role.available && role.tools.includes(tool))))) reasons.push("missing_tool");
      if (option.contextDependency !== "low" && option.handoffLossRisk === "high") reasons.push("high_handoff_loss");
      if (option.contextDependency !== "low" && option.handoffLossRisk === "unknown") reasons.push("transfer_safety_unresolved");
    }
    if (reasons.length) excluded.push({ optionId: option.id, reasons: [...new Set(reasons)] });
    else admissible.push(option);
  }
  return { admissible, excluded, needsClarification: excluded.some((item) => item.reasons.includes("transfer_safety_unresolved")) };
}
/** A service comparison is unnecessary only if no delegated choice survives AND no transfer clarification is pending. */
export function noComparison(input: AssessmentInput): boolean {
  const eligibility = eligibleOptions(input);
  return !eligibility.needsClarification && eligibility.admissible.length === 1 && eligibility.admissible[0]?.kind === "direct";
}
/** revisionCount is runtime state, never a delegation_assess argument. It is 0 on first attempt and 1 after revision. */
export function applyPolicy(input: AssessmentInput, config: PolicyConfig, judgment?: ModelJudgment, serviceFailed = false, revisionCount = 0): Assessment {
  const eligibility = eligibleOptions(input);
  const direct = eligibility.admissible.find((option) => option.kind === "direct");
  if (!direct) throw new Error("A locally admissible direct baseline is required.");
  const base = { identity: assessmentIdentity(input, config.contextGrowthTokens, config.relativeCosts), phase: input.phase, phaseId: input.phaseId,
    contextTokens: input.contextTokens, parentContext: input.parentContext, excluded: eligibility.excluded };
  const localOnly = noComparison(input);
  const validChoice = config.mode !== "rules-only" && judgment && eligibility.admissible.some((option) => option.id === judgment.choice);
  const abstained = judgment?.choice === "insufficient_information" || judgment?.choice === "revise_options";
  const uncertain = !!abstained || eligibility.needsClarification;
  const needsRevision = !serviceFailed && config.mode !== "rules-only" && revisionCount === 0 && uncertain;
  const choice = config.mode === "rules-only" ? direct.id : judgment?.choice ?? (eligibility.needsClarification ? "insufficient_information" : direct.id);
  const confident = !!judgment && judgment.confidence >= config.provisionalConfidenceThreshold;
  return { ...base, choice, effective: validChoice && confident && !serviceFailed && !eligibility.needsClarification ? judgment.choice : direct.id,
    origin: serviceFailed ? "service-fallback" : config.mode === "rules-only" || !confident || !validChoice || eligibility.needsClarification ? "rules" : "jev",
    confidence: judgment?.confidence ?? null, probabilities: judgment?.probabilities ?? null, model: judgment?.model,
    needsRevision, conservativeFallback: !needsRevision && (serviceFailed || uncertain || (!!judgment && !confident)),
    reason: serviceFailed ? "service_failure" : config.mode === "rules-only" ? "rules_only" : eligibility.needsClarification || abstained ? "clarification" : localOnly ? "no_comparison" : !judgment || !validChoice ? "invalid_choice" : !confident ? "low_confidence" : "model_choice" };
}

const SECRET_PATTERN = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|token|secret|password|bearer)\s*[:=]\s*\S+|\bbearer\s+\S+|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b)/i;
// Restrict model-bound prose to printable ASCII; script block lists miss languages.
// This still cannot distinguish English from other languages written in ASCII.
const NON_LATIN_SCRIPT = /[^\x20-\x7e]/;
const ID = /^[A-Za-z][A-Za-z0-9._:-]*$/;
function validId(value: unknown, max: number): value is string { return typeof value === "string" && value.length <= max && ID.test(value) && !SECRET_PATTERN.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)); }
/** Syntactic privacy/language guard, not a semantic proof that ASCII prose is English or secret-free. */
export function validateEnglishSafe(value: unknown, field: string, max = 300): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > max) return `${field} must be a nonblank English summary of at most ${max} characters.`;
  if (NON_LATIN_SCRIPT.test(value) || SECRET_PATTERN.test(value) || /[\r\n\x00-\x08\x0b-\x1f]/.test(value)) return `${field} must use ASCII English and contain no obvious secrets or control characters.`;
  if ((value.match(/[A-Za-z]/g)?.length ?? 0) < 3) return `${field} must be an English summary.`;
}
const LEVELS = ["low", "moderate", "high", "unknown"];
const OPTION_KEYS = ["id", "kind", "summary", "evidence", "verificationCriteria", "roles", "requiredTools", "authorized", "writeConflict", "taskSuitability", "contextDependency", "decisionsRecorded", "handoffEffort", "handoffLossRisk", "verificationEffort", "executionEffort", "reworkRisk", "expectedBenefit", "independentReviewBenefit"];
const ASSESSMENT_KEYS = ["requestId", "phase", "phaseId", "nextStep", "roles", "options", "contextTokens", "parentContext", "noDelegationReason"];
const UNKNOWN_DIRECT_EVIDENCE = { contextDependency: "unknown", decisionsRecorded: "unknown", handoffEffort: "unknown", handoffLossRisk: "unknown", verificationEffort: "unknown", executionEffort: "unknown", reworkRisk: "unknown", expectedBenefit: "unknown", independentReviewBenefit: "unknown" } as const;
/** Normalize caller data after checking EVERY explicit field; omitted direct permissions only establish an admissible baseline, never action authority. */
export function normalizeAssessmentInput(value: ExternalAssessmentInput, cachedRoles: Role[] = []): AssessmentInput {
  if (!isRecord(value) || !onlyKeys(value, ASSESSMENT_KEYS)) throw new Error("assessment contains unsupported fields; migrate to dynamic options.");
  const roles = value.roles === undefined ? cachedRoles : value.roles;
  const options = Array.isArray(value.options) ? value.options.map((option) => {
    if (!isRecord(option) || option.kind !== "direct") return option;
    return { roles: [], requiredTools: [], authorized: true, writeConflict: false, taskSuitability: "suitable", ...UNKNOWN_DIRECT_EVIDENCE, ...option };
  }) : value.options;
  const normalized = { ...value, roles, options } as AssessmentInput;
  const error = validateAssessmentInput(normalized);
  if (error) throw new Error(error);
  return normalized;
}
/** Validate before calling the service (including data that the request builder might not forward). */
export function validateAssessmentInput(input: AssessmentInput): string | undefined {
  if (!isRecord(input) || !onlyKeys(input, ASSESSMENT_KEYS)) return "assessment contains unsupported fields; migrate to dynamic options.";
  if (!validId(input.requestId, 120)) return "requestId must be a compact ASCII identifier.";
  if (!["initial", "transition", "context_growth"].includes(input.phase)) return "phase is invalid.";
  if (!validId(input.phaseId, 80)) return "phaseId must be a compact ASCII transition identity.";
  const step = validateEnglishSafe(input.nextStep, "nextStep", 2000); if (step) return step;
  if (input.contextTokens !== null && (!Number.isSafeInteger(input.contextTokens) || input.contextTokens < 0)) return "contextTokens must be a nonnegative integer or null.";
  if (!Array.isArray(input.roles) || input.roles.length > 12) return "roles must contain at most 12 roles.";
  const roleNames = new Set<string>();
  for (const [i, role] of input.roles.entries()) {
    const field = `roles[${i}]`;
    if (!isRecord(role) || !onlyKeys(role, ["name", "summary", "purpose", "available", "suitable", "authorized", "tools"])) return `${field} has unsupported fields.`;
    if (!validId(role.name, 80) || roleNames.has(role.name)) return `${field}.name must be a unique compact ASCII identifier.`;
    roleNames.add(role.name);
    const error = validateEnglishSafe(role.summary, `${field}.summary`); if (error) return error;
    if (!["execution", "research", "review"].includes(role.purpose)) return `${field}.purpose is invalid.`;
    for (const key of ["available", "suitable", "authorized"] as const) if (typeof role[key] !== "boolean") return `${field}.${key} must be boolean.`;
    if (!Array.isArray(role.tools) || role.tools.length > 16 || new Set(role.tools).size !== role.tools.length || !role.tools.every((tool) => validId(tool, 80))) return `${field}.tools must be unique compact ASCII identifiers (at most 16).`;
  }
  if (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > 8) return "options must contain 1–8 bounded execution options.";
  const ids = new Set<string>(); let directs = 0;
  for (const [i, option] of input.options.entries()) {
    const field = `options[${i}]`;
    if (!isRecord(option) || !onlyKeys(option, OPTION_KEYS)) return `${field} has unsupported fields.`;
    if (!validId(option.id, 80) || ["insufficient_information", "revise_options"].includes(option.id) || ids.has(option.id)) return `${field}.id must be a unique compact ASCII identifier distinct from reserved outcomes.`;
    ids.add(option.id);
    if (option.kind !== "direct" && option.kind !== "delegated") return `${field}.kind is invalid.`;
    for (const key of ["summary", "evidence", "verificationCriteria"] as const) { const error = validateEnglishSafe(option[key], `${field}.${key}`, key === "summary" ? 500 : 400); if (error) return error; }
    for (const key of ["roles", "requiredTools"] as const) if (!Array.isArray(option[key]) || option[key].length > 12 || new Set(option[key]).size !== option[key].length || !option[key].every((v) => validId(v, 80))) return `${field}.${key} must be unique compact ASCII identifiers (at most 12).`;
    if (option.kind === "direct" && (option.roles.length || option.requiredTools.length)) return `${field} direct baseline must have no delegated roles/tools.`;
    const missingRole = option.roles.find((name) => !roleNames.has(name));
    if (missingRole) return `${field}.roles refers to missing role ${missingRole}; supply roles explicitly or refresh the capability snapshot.`;
    for (const key of ["authorized", "writeConflict"] as const) if (typeof option[key] !== "boolean") return `${field}.${key} must be boolean.`;
    if (!["suitable", "unsuitable", "unknown"].includes(option.taskSuitability)) return `${field}.taskSuitability is invalid.`;
    if (!["documents", "conversation", "both", "unknown"].includes(option.decisionsRecorded)) return `${field}.decisionsRecorded is invalid.`;
    for (const key of ["contextDependency", "handoffEffort", "handoffLossRisk", "verificationEffort", "executionEffort", "reworkRisk", "expectedBenefit", "independentReviewBenefit"] as const) if (!LEVELS.includes(option[key])) return `${field}.${key} is invalid.`;
    if (option.kind === "direct") { directs++; if (option.roles.length || option.requiredTools.length || !option.authorized || option.writeConflict || option.taskSuitability !== "suitable") return `${field} direct baseline must be admissible and have no delegated roles/tools.`; }
    else if (!option.roles.length) return `${field}.roles must name at least one role for delegated work.`;
  }
  if (directs !== 1) return "options must include exactly one admissible direct baseline.";
  if (input.noDelegationReason !== undefined) {
    const reason = input.noDelegationReason;
    if (!isRecord(reason) || !onlyKeys(reason, ["code", "detail"]) || !["trivial_continuation", "no_authorized_delegate", "no_suitable_delegate", "handoff_not_worthwhile"].includes(reason.code as string)) return "noDelegationReason.code is invalid.";
    const invalid = validateEnglishSafe(reason.detail, "noDelegationReason.detail"); if (invalid) return invalid;
  } else if (input.options.length === 1) return "noDelegationReason is required when no delegated option is supplied.";
  if (input.parentContext !== undefined) {
    const p = input.parentContext;
    if (!isRecord(p) || !onlyKeys(p, ["model", "contextWindowTokens", "configuredSmartZoneTokens", "smartZoneTokens", "remainingTokens", "smartZoneState", "childContext"])) return "parentContext has unsupported fields.";
    if (p.model !== null && (typeof p.model !== "string" || p.model.length > 150 || NON_LATIN_SCRIPT.test(p.model) || SECRET_PATTERN.test(p.model))) return "parentContext.model is invalid.";
    for (const key of ["contextWindowTokens", "remainingTokens"] as const) if (p[key] !== null && (!Number.isSafeInteger(p[key]) || (p[key] as number) < 0)) return `parentContext.${key} is invalid.`;
    for (const key of ["configuredSmartZoneTokens", "smartZoneTokens"] as const) if (!Number.isSafeInteger(p[key]) || (p[key] as number) < 0) return `parentContext.${key} is invalid.`;
    if (!["unknown", "within", "near", "exceeded"].includes(p.smartZoneState as string) || p.childContext !== "unknown") return "parentContext telemetry is invalid.";
  }
}

const SAFE_SUBAGENT_ACTIONS = new Set(["list", "status", "doctor", "guide", "models", "children.list"]);
const SAFE_ACTION_KEYS: Record<string, ReadonlySet<string>> = {
  list: new Set(["action", "capabilities", "agentScope"]), status: new Set(["action", "id", "runId", "dir", "index", "view", "lines"]),
  doctor: new Set(["action"]), guide: new Set(["action", "topic"]), models: new Set(["action", "agent"]), "children.list": new Set(["action"]),
};
/** Only read/control shapes with no launch fields are exempt. resume and steer can execute child work. */
export function isBoundedServiceAction(toolName: string, input: unknown): boolean {
  if (toolName === "bg_wait") return true;
  if (toolName !== "subagent" || !input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>; const action = value.action;
  if (typeof action !== "string" || !SAFE_SUBAGENT_ACTIONS.has(action)) return false;
  const allowed = SAFE_ACTION_KEYS[action]!;
  return Object.keys(value).every((key) => allowed.has(key));
}
export function isWorkingTool(toolName: string): boolean { return toolName !== "delegation_assess" && toolName !== "delegation_deviate" && toolName !== "bg_wait"; }
