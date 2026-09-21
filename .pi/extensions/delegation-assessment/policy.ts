import { createHash } from "node:crypto";

export type Mode = "observe" | "enforce" | "rules-only" | "off";
export type Phase = "initial" | "transition" | "context_growth";
export type Choice = "delegate" | "direct" | "insufficient_information";

export interface Role { name: string; summary: string; available: boolean; }
export interface SuitableCandidate { name: string; suitable: boolean; }
export interface PolicyFacts {
  boundedVerifiableSubtask: boolean;
  requiresMostParentContext: boolean;
  largeResearch: boolean;
  independentWork: boolean;
  knownWriteConflict: boolean;
}
export interface AssessmentInput {
  requestId: string;
  phase: Phase;
  /** Caller-provided transition nonce; a phase label alone is not an identity. */
  phaseId: string;
  nextStep: string;
  facts: PolicyFacts;
  roles: Role[];
  selectedCandidate: SuitableCandidate;
  contextTokens: number | null;
}
export interface ModelJudgment { choice: Choice; confidence: number; probabilities: Record<Choice, number>; model: string; }
export interface Assessment {
  identity: string; phase: Phase; phaseId: string; choice: Choice; effective: "delegate" | "direct";
  origin: "jev" | "rules" | "service-fallback"; confidence: number | null;
  probabilities: Record<Choice, number> | null; contextTokens: number | null; model?: string;
}
export interface PolicyConfig { mode: Mode; provisionalConfidenceThreshold: number; contextGrowthTokens: number; }
export const DEFAULT_POLICY_CONFIG: PolicyConfig = { mode: "observe", provisionalConfidenceThreshold: 0.7, contextGrowthTokens: 16_000 };

function contextBucket(tokens: number | null, growth: number): string { return tokens === null ? "unknown" : String(Math.floor(tokens / growth)); }
export function assessmentIdentity(input: AssessmentInput, growth = DEFAULT_POLICY_CONFIG.contextGrowthTokens): string {
  // All semantic fields participate, but the identity is safe to persist as opaque metadata.
  const semanticKey = JSON.stringify({ requestId: input.requestId, phase: input.phase, phaseId: input.phaseId,
    bucket: contextBucket(input.contextTokens, growth), nextStep: input.nextStep, facts: input.facts,
    roles: input.roles.map(({ name, summary, available }) => ({ name, summary, available })), candidate: input.selectedCandidate });
  return createHash("sha256").update(semanticKey).digest("hex");
}
export function hasSuitableRole(input: AssessmentInput): boolean {
  return input.selectedCandidate.suitable && input.roles.some((role) => role.available && role.name === input.selectedCandidate.name);
}
/** Hard prerequisites, not a claim that research/independence is a security boundary. */
export function rulesRecommendDelegate(input: AssessmentInput): boolean {
  const f = input.facts;
  return f.boundedVerifiableSubtask && hasSuitableRole(input) && !f.requiresMostParentContext
    && (f.largeResearch || f.independentWork) && !f.knownWriteConflict;
}
export function applyPolicy(input: AssessmentInput, config: PolicyConfig, judgment?: ModelJudgment, serviceFailed = false): Assessment {
  const fallback = rulesRecommendDelegate(input) ? "delegate" : "direct";
  const base = { identity: assessmentIdentity(input, config.contextGrowthTokens), phase: input.phase, phaseId: input.phaseId, contextTokens: input.contextTokens };
  if (config.mode === "rules-only") return { ...base, choice: fallback, effective: fallback, origin: "rules", confidence: null, probabilities: null };
  if (serviceFailed || !judgment || judgment.confidence < config.provisionalConfidenceThreshold || judgment.choice === "insufficient_information") {
    return { ...base, choice: judgment?.choice ?? "insufficient_information", effective: fallback,
      origin: serviceFailed ? "service-fallback" : "rules", confidence: judgment?.confidence ?? null,
      probabilities: judgment?.probabilities ?? null, model: judgment?.model };
  }
  // Rules are hard prerequisites. Jev is an advisory preference inside that envelope.
  return { ...base, choice: judgment.choice, effective: judgment.choice === "delegate" && fallback === "delegate" ? "delegate" : "direct",
    origin: "jev", confidence: judgment.confidence, probabilities: judgment.probabilities, model: judgment.model };
}

const SECRET_PATTERN = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|token|secret|password)\s*[:=])/i;
const CYRILLIC_PATTERN = /[\u0400-\u04ff]/;
const ENGLISH = /[A-Za-z]/g;
export function validateEnglishSafe(value: string, field: string): string | undefined {
  if (!value.trim()) return `${field} must not be blank.`;
  if (CYRILLIC_PATTERN.test(value) || SECRET_PATTERN.test(value)) return `${field} must be English and contain no obvious secrets.`;
  if ((value.match(ENGLISH)?.length ?? 0) < 3) return `${field} must be an English summary.`;
}
/** Practical guards only; language and secret detection are deliberately not claimed perfect. */
export function validateAssessmentInput(input: AssessmentInput): string | undefined {
  if (input.nextStep.length > 2000) return "nextStep must contain 1–2000 characters.";
  if (input.phaseId.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(input.phaseId)) return "phaseId must be a compact ASCII transition identity.";
  const summary = validateEnglishSafe(input.nextStep, "nextStep"); if (summary) return summary;
  if (input.roles.length > 12) return "At most 12 compact roles are allowed.";
  if (input.roles.some((r) => !r.name.trim() || r.name.length > 80 || r.summary.length > 300 || validateEnglishSafe(`${r.name} ${r.summary}`, "role"))) return "Roles must be compact English capability summaries without obvious secrets.";
  if (!input.selectedCandidate.name || input.selectedCandidate.name.length > 80) return "selectedCandidate must identify one compact role.";
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
export function isWorkingTool(toolName: string): boolean { return toolName !== "delegation_assess" && toolName !== "delegation_refuse" && toolName !== "bg_wait"; }
