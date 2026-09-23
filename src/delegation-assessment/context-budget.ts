import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface BudgetConfig {
  smartZoneTokens: number;
  smartZoneTokensByModel: Record<string, number>;
}
export const DEFAULT_BUDGET_CONFIG: BudgetConfig = { smartZoneTokens: 150_000, smartZoneTokensByModel: {} };
export interface ParentContext {
  model: string | null;
  contextWindowTokens: number | null;
  configuredSmartZoneTokens: number;
  smartZoneTokens: number;
  remainingTokens: number | null;
  smartZoneState: "unknown" | "within" | "near" | "exceeded";
  childContext: "unknown";
}
export function validBudget(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1_000;
}
export function parentContext(ctx: ExtensionContext, config: BudgetConfig): { tokens: number | null; budget: ParentContext } {
  const usage = ctx.getContextUsage();
  const tokens = typeof usage?.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens >= 0 ? usage.tokens : null;
  const window = usage?.contextWindow ?? ctx.model?.contextWindow;
  const contextWindowTokens = typeof window === "number" && Number.isFinite(window) && window > 0 ? window : null;
  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
  const configuredSmartZoneTokens = model && Object.hasOwn(config.smartZoneTokensByModel, model)
    ? config.smartZoneTokensByModel[model]! : config.smartZoneTokens;
  // The heuristic budget cannot exceed the model's physical window. It reserves no output tokens.
  const smartZoneTokens = Math.min(configuredSmartZoneTokens, contextWindowTokens ?? Infinity);
  return { tokens, budget: {
    model, contextWindowTokens, configuredSmartZoneTokens, smartZoneTokens,
    remainingTokens: tokens === null ? null : Math.max(0, smartZoneTokens - tokens),
    smartZoneState: tokens === null ? "unknown" : tokens >= smartZoneTokens ? "exceeded" : tokens >= smartZoneTokens * .8 ? "near" : "within",
    childContext: "unknown",
  } };
}
