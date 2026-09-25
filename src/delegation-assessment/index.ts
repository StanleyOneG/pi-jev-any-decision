import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DELEGATION_ASSESS_PARAMS } from "./schema.ts";
import { Gate } from "./gate.ts";
import { DEFAULT_BUDGET_CONFIG, parentContext, validBudget, type BudgetConfig, type ParentContext } from "./context-budget.ts";
import { askJev } from "./typesafe.ts";
import { createDebugLog, type DebugSink } from "./debug.ts";
import { DEFAULT_POLICY_CONFIG, applyPolicy, assessmentIdentity, isBoundedServiceAction, isWorkingTool, noComparison, normalizeAssessmentInput, validateEnglishSafe, validateRelativeCosts, type Assessment, type AssessmentInput, type Role, type PolicyConfig, type RelativeCostConfig } from "./policy.ts";

const CUSTOM_TYPE = "delegation-assessment";
const MAX_CACHE = 20;
interface RuntimeConfig extends PolicyConfig, BudgetConfig { enabled: boolean; debug?: boolean; }
const OFF_CONFIG: RuntimeConfig = { ...DEFAULT_POLICY_CONFIG, ...DEFAULT_BUDGET_CONFIG, mode: "off", enabled: false };

function parseConfig(raw: unknown): RuntimeConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.debug !== undefined && typeof value.debug !== "boolean") return undefined;
  if (validateRelativeCosts(value.relativeCosts)) return undefined;
  const mode = value.mode ?? "observe";
  if (mode !== "observe" && mode !== "enforce" && mode !== "rules-only" && mode !== "off") return undefined;
  const threshold = value.provisionalConfidenceThreshold ?? DEFAULT_POLICY_CONFIG.provisionalConfidenceThreshold;
  const growth = value.contextGrowthTokens ?? DEFAULT_POLICY_CONFIG.contextGrowthTokens;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1 || typeof growth !== "number" || !Number.isSafeInteger(growth) || growth < 1_000) return undefined;
  const smartZoneTokens = value.smartZoneTokens === undefined ? DEFAULT_BUDGET_CONFIG.smartZoneTokens : value.smartZoneTokens;
  const overrides = value.smartZoneTokensByModel === undefined ? {} : value.smartZoneTokensByModel;
  if (!validBudget(smartZoneTokens) || !overrides || typeof overrides !== "object" || Array.isArray(overrides)
    || !Object.entries(overrides).every(([key, budget]) => /^[^\s/]+\/[^\s]+$/.test(key) && validBudget(budget))) return undefined;
  return { enabled: mode !== "off", debug: value.debug === true, mode, provisionalConfidenceThreshold: threshold, contextGrowthTokens: growth,
    smartZoneTokens, smartZoneTokensByModel: overrides as Record<string, number>, relativeCosts: value.relativeCosts as RelativeCostConfig | undefined };
}
async function loadConfig(ctx: ExtensionContext): Promise<{ config: RuntimeConfig; warning?: string }> {
  if (!ctx.isProjectTrusted()) return { config: OFF_CONFIG, warning: "Оценка делегирования: проект не доверен, режим off." };
  try {
    const parsed = parseConfig(JSON.parse(await readFile(join(ctx.cwd, CONFIG_DIR_NAME, "delegation-assessment.json"), "utf8")));
    return parsed ? { config: parsed } : { config: OFF_CONFIG, warning: "Оценка делегирования: неверный конфиг, режим off." };
  } catch (error) {
    return { config: OFF_CONFIG, warning: (error as NodeJS.ErrnoException).code === "ENOENT" ? "Оценка делегирования: нет явного opt-in, режим off." : "Оценка делегирования: неверный конфиг, режим off." };
  }
}
function contextTokens(ctx: ExtensionContext): number | null {
  const tokens = ctx.getContextUsage()?.tokens;
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : null;
}
function currentSessionId(ctx: ExtensionContext): string | undefined {
  const id = ctx.sessionManager.getSessionId();
  return typeof id === "string" && id ? id : undefined;
}
function render(assessment: Assessment) {
  return { effective: assessment.effective, choice: assessment.choice, origin: assessment.origin, reason: assessment.reason, confidence: assessment.confidence, probabilities: assessment.probabilities, contextTokensApproximate: assessment.contextTokens, model: assessment.model, parentContext: assessment.parentContext, excluded: assessment.excluded, needsRevision: assessment.needsRevision, conservativeFallback: assessment.conservativeFallback };
}
function conciseResult(assessment: Assessment, observation: boolean) {
  const action = assessment.needsRevision ? `Revise the options or transfer evidence once; excluded: ${assessment.excluded.map((item) => `${item.optionId} (${item.reasons.join(", ")})`).join("; ").slice(0, 350) || "model requested clarification"}.` : undefined;
  return { observation, effective: assessment.effective, origin: assessment.origin, reason: assessment.reason, ...(assessment.needsRevision ? { needsRevision: true, action } : {}), ...(assessment.conservativeFallback ? { conservativeFallback: true } : {}) };
}
/** Launch receipts are authoritative only when pi-subagents returns its top-level run identity. */
function confirmedDispatch(details: unknown): boolean {
  if (!details || typeof details !== "object") return false;
  const runId = (details as Record<string, unknown>).runId;
  return typeof runId === "string" && runId.length > 0;
}
function disabledForSession(ctx: ExtensionContext, sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === CUSTOM_TYPE
    && entry.data && typeof entry.data === "object" && (entry.data as { kind?: unknown; sessionId?: unknown }).kind === "disabled"
    && (entry.data as { sessionId?: unknown }).sessionId === sessionId);
}

/** Factory is exported only to inject a deterministic client in tests; production uses askJev. */
export function createDelegationAssessment(ask: (input: AssessmentInput, signal: AbortSignal | undefined, debug?: DebugSink, costs?: RelativeCostConfig) => Promise<import("./policy.ts").ModelJudgment> = (input, signal, debug, costs) => askJev(input, signal, undefined, debug, costs)): (pi: ExtensionAPI) => void {
  return (pi) => {
    if (process.env.PI_SUBAGENT_CHILD === "1") return;
    const gate = new Gate();
    let config = OFF_CONFIG;
    let sessionId: string | undefined;
    let debugLog: ReturnType<typeof createDebugLog> | undefined;
    let runActive = false;
    let requestPreparedForRun = false;
    let parentActionGeneration: number | undefined;
    let budgetWarningKey: string | undefined;
    let assessmentWarningKey: string | undefined;
    let growthReminderKey: string | undefined;
    let guidanceSent = false;
    let cachedRoles: Role[] = [];
    const cache = new Map<string, Assessment>();
    const inFlight = new Map<string, Promise<Assessment>>();
    const capabilityDiscovery = new Map<string, ReturnType<Gate["snapshot"]>>();
    let latestDiscoveryId: string | undefined;
    // One runtime-owned clarification allowance per actual user request, independent of caller phase IDs.
    let revisionUsed = false;
    const failOpen = (ctx: ExtensionContext): void => {
      if (!gate.disable()) return;
      try { pi.appendEntry(CUSTOM_TYPE, { kind: "disabled", ...(sessionId ? { sessionId } : {}) }); } catch { /* persistence is best effort */ }
      try { ctx.ui.setStatus("delegation", "Оценка делегирования отключена из-за внутренней ошибки; обычная работа продолжена."); } catch { /* best effort */ }
      try { ctx.ui.notify("Оценка делегирования отключена из-за внутренней ошибки; обычные subagent-инструкции продолжают работать.", "warning"); } catch { /* best effort */ }
    };
    const ui = (ctx: ExtensionContext, operation: () => void): boolean => {
      try { operation(); return true; } catch { failOpen(ctx); return false; }
    };
    const guarded = <T>(ctx: ExtensionContext, fn: () => T): T | undefined => {
      try { return fn(); } catch { failOpen(ctx); return undefined; }
    };
    const monitorBudget = (ctx: ExtensionContext, budget: ParentContext): void => {
      if (budget.smartZoneState === "within") { budgetWarningKey = undefined; return; }
      if (budget.smartZoneState === "unknown") return;
      const key = `${budget.model}:${budget.smartZoneTokens}:${budget.smartZoneState}`;
      if (key === budgetWarningKey) return;
      budgetWarningKey = key;
      const text = budget.smartZoneState === "exceeded"
        ? `Smart zone: мягкий бюджет ${budget.smartZoneTokens} токенов достигнут. Рассмотрите новую сессию или compaction вручную; запуск ребёнка не разгружает уже накопленный контекст родителя.`
        : `Smart zone: использовано не менее 80% мягкого бюджета ${budget.smartZoneTokens} токенов. Для независимой работы предпочтителен свежий контекст ребёнка и короткий отчёт; автоматического запуска нет.`;
      ui(ctx, () => ctx.ui.notify(text, "warning"));
    };
    const newRequest = (): void => { gate.newRequest(`r:${randomUUID()}`); cache.clear(); revisionUsed = false; };
    const invalidateCapabilities = (): void => { cachedRoles = []; gate.invalidateAssessment(); cache.clear(); };
    const invalidateForModel = (budget: ParentContext): void => {
      const previous = gate.state.assessment?.parentContext;
      if (previous && ((budget.model !== null && previous.model !== budget.model)
        || (budget.contextWindowTokens !== null && previous.contextWindowTokens !== budget.contextWindowTokens)
        || previous.configuredSmartZoneTokens !== budget.configuredSmartZoneTokens
        || (previous.contextWindowTokens !== null && budget.contextWindowTokens !== null && previous.smartZoneTokens !== budget.smartZoneTokens))) {
        gate.invalidateAssessment(); cache.clear();
      }
    };
    const displayResult = (ctx: ExtensionContext, assessment: Assessment, outcome: "result" | "discarded"): void => {
      const label = assessment.origin === "rules" ? "Оценка правил" : "Jev";
      if (outcome === "discarded") {
        ui(ctx, () => ctx.ui.notify(`${label}: RESULT отброшен: оценка устарела.`, "warning"));
        return;
      }
      const source = assessment.origin === "jev" ? "Jev" : assessment.origin === "service-fallback" ? "сервис недоступен, правила" : "правила";
      const text = `${label}: RESULT; выбор=${assessment.choice}; итог=${assessment.effective}; источник=${source}; режим=${config.mode}`;
      ui(ctx, () => ctx.ui.setStatus("delegation", text));
      ui(ctx, () => ctx.ui.notify(text, assessment.origin === "service-fallback" ? "warning" : "info"));
    };

    pi.on("session_start", async (event, ctx) => {
      try {
        gate.resetSession(); budgetWarningKey = undefined; assessmentWarningKey = undefined; growthReminderKey = undefined; guidanceSent = false; cachedRoles = [];
        cache.clear(); inFlight.clear(); capabilityDiscovery.clear(); latestDiscoveryId = undefined; revisionUsed = false; runActive = false; requestPreparedForRun = false;
        sessionId = currentSessionId(ctx);
        debugLog = undefined;
        const loaded = await loadConfig(ctx); config = loaded.config;
        if (config.enabled && config.debug && sessionId) {
          try {
            debugLog = createDebugLog(ctx.cwd, sessionId, () => ctx.ui.notify("Debug: запись журнала недоступна; оценка продолжается без журнала.", "warning"));
            await debugLog.write({ event: "session", mode: config.mode });
            ctx.ui.notify(`Debug: ${debugLog.path}`, "info");
          } catch { debugLog = undefined; }
        }
        // Fork/new intentionally do not inherit a disabled marker copied from another branch.
        if ((event.reason === "startup" || event.reason === "resume" || event.reason === "reload") && disabledForSession(ctx, sessionId)) gate.disable();
        const state = gate.state.disabled
          ? "Оценка делегирования: отключена после внутренней ошибки этой сессии."
          : loaded.warning ?? (config.mode === "off" ? "Оценка делегирования: выключена" : config.mode === "observe" ? "Оценка делегирования: наблюдение (Jev/rules не блокируют)" : config.mode === "rules-only" ? "Оценка делегирования: rules-only (правила применяются)" : "Оценка делегирования: enforce (Jev/rules применяются)");
        ui(ctx, () => ctx.ui.setStatus("delegation", state));
        if (loaded.warning) ui(ctx, () => ctx.ui.notify(loaded.warning!, "warning"));
      } catch { failOpen(ctx); }
    });
    pi.on("session_compact", (_event, ctx) => guarded(ctx, () => { invalidateCapabilities(); guidanceSent = false; growthReminderKey = undefined; }));
    pi.on("model_select", (event, ctx) => guarded(ctx, () => {
      if (event.previousModel && `${event.previousModel.provider}/${event.previousModel.id}` !== `${event.model.provider}/${event.model.id}`) { gate.invalidateAssessment(); cache.clear(); }
    }));
    // sendUserMessage emits source:"extension"; it is still a fresh user request.
    pi.on("input", (_event, ctx) => guarded(ctx, () => {
      if (config.enabled && !gate.state.disabled) { newRequest(); requestPreparedForRun = true; }
    }));
    // sendMessage({triggerTurn:true}) may have no input event. Only reset when idle-to-run;
    // agent continuations/retries remain within the active request until agent_settled.
    pi.on("agent_start", (_event, ctx) => guarded(ctx, () => {
      if (!config.enabled || gate.state.disabled) return;
      if (!runActive) {
        runActive = true;
        if (!requestPreparedForRun) newRequest();
        requestPreparedForRun = false;
      }
    }));
    pi.on("agent_settled", (_event, _ctx) => { runActive = false; });
    pi.on("session_tree", (_event, ctx) => guarded(ctx, () => {
      invalidateCapabilities(); guidanceSent = false; growthReminderKey = undefined;
    }));
    pi.on("before_agent_start", (_event, ctx) => guarded(ctx, () => {
      if (!config.enabled || gate.state.disabled || !gate.state.requestId) return;
      const budget = parentContext(ctx, config).budget;
      invalidateForModel(budget);
      const need = gate.assessmentNeed(contextTokens(ctx), config.contextGrowthTokens);
      const first = !guidanceSent; guidanceSent = true;
      const guidance = `Dynamic routing (${config.mode}): assess before the first working tool, meaningful new work phase, changed goal/scope/permissions/capabilities, or ${config.contextGrowthTokens} additional context tokens (phase=context_growth), including after reading large skills or reference documents, before the next working tool, including subagent launches. A phase is a meaningful work unit, not every reply or tool result. Discover roles first with subagent action:list capabilities:true within host permissions; rediscover on capability change. Do not claim no suitable role before discovery. Omit roles to reuse the last validated snapshot; [] clears it. Check current user, applicable project and loaded skill instructions for delegation permission and its exact task/scope; standing permission counts without fresh user wording, but discovery permission does not grant writer permission. Host limits and restrictions still apply. Submit bounded English nextStep, phaseId and one direct baseline with evidence and verificationCriteria. At substantial implementation transitions, compare direct with at least one suitable, authorized bounded implementation alternative when available; direct-only is appropriate for small work or concrete blockers/overhead. For other substantial research/code discovery consider an authorized bounded alternative when useful. If omitting delegation, give noDelegationReason with the actual restriction, missing permission, unsuitability or overhead; no_authorized_delegate must name the missing authority, not a generic unsupported claim. Candidate omission is not Jev rejection. Delegated options need capability, tool, suitability, transfer and comparison evidence; unknown is not favorable. Reassess explicitly before materially different work: retained advice is not permission to launch or act. One clarification per request for unresolved transfer safety, then conservative direct fallback. Record concrete delegation_deviate if choosing differently. Never send raw user text, code, logs or secrets to Jev; no forced launch or permission expansion. Smart-zone budget ${config.smartZoneTokens} tokens is advisory: propose manual handoff/compaction, never automatic launch.`;
      return { message: { customType: CUSTOM_TYPE, display: false, content: first ? guidance : need === "context_growth" ? "Routing advice expired by context growth. Reassess with phase=context_growth before working tools; no automatic delegation." : need === "missing" ? "No accepted routing advice. Assess before working tools; discover roles if capabilities are unknown." : need === "pending" ? "Routing assessment pending; wait for its accepted result before working tools." : "Continue with the accepted routing advice for this work phase. Reassess for a material transition, capability change, or growth; advice does not authorize launches." } };
    }));

    pi.registerTool({ name: "delegation_assess", label: "Delegation Assess", description: "Compare submitted bounded execution options; does not discover roles, grant permission or launch children. Old facts/selectedCandidate calls must migrate to options.", promptSnippet: "Discover roles within host permissions before ruling out suitability; assess before working tools or a meaningful phase transition; omit roles to reuse validated capabilities", promptGuidelines: ["Submit one direct baseline and up to seven other options. At substantial implementation transitions compare an authorized suitable bounded implementation alternative when available; small work or concrete blockers/overhead may stay direct-only.", "Check current user, applicable project and loaded skill instructions for exact task/scope permission; standing permission needs no fresh user delegation words, but discovery permission is not writer permission. For direct-only give the actual noDelegationReason (name missing authority for no_authorized_delegate). Omission is not model rejection; unknown facts are not favorable evidence."], parameters: DELEGATION_ASSESS_PARAMS, async execute(_id, params, signal, _update, ctx) {
      if (!config.enabled) return { content: [{ type: "text", text: "Assessment is off/baseline." }], details: { mode: "off" } };
      if (gate.state.disabled) return { content: [{ type: "text", text: "Assessment extension is disabled for this session." }], details: { disabled: true } };
      let tokens: number | null;
      let budget: ParentContext;
      try { ({ tokens, budget } = parentContext(ctx, config)); monitorBudget(ctx, budget); invalidateForModel(budget); } catch { failOpen(ctx); return { content: [{ type: "text", text: "Assessment extension malfunctioned; gating is disabled for this session." }], details: { disabled: true } }; }
      if (gate.state.disabled) return { content: [{ type: "text", text: "Assessment extension is disabled for this session." }], details: { disabled: true } };
      const requestId = gate.state.requestId;
      if (!requestId) throw new Error("No active user request to assess.");
      if (Object.hasOwn(params, "facts") || Object.hasOwn(params, "selectedCandidate")) throw new Error("Legacy facts/selectedCandidate input is unsupported; migrate to dynamic options.");
      // Host-owned telemetry cannot be supplied by callers, even if a schema adapter passes it through.
      if (["requestId", "contextTokens", "parentContext"].some((key) => Object.hasOwn(params, key))) throw new Error("requestId/context telemetry is host-provided; remove caller-supplied fields.");
      // Validate every field visible to execute before touching identity, cache, or service.
      const input = normalizeAssessmentInput({ ...params, requestId, contextTokens: tokens, parentContext: budget } as AssessmentInput, cachedRoles);
      try {
        const identity = assessmentIdentity(input, config.contextGrowthTokens, config.relativeCosts);
        const snapshot = gate.beginAssessment(identity);
        if (!snapshot) throw new Error("No active user request to assess.");
        const log = debugLog;
        const debug: DebugSink | undefined = log ? (event) => log.write({ ...event, assessmentIdentity: identity, requestId, toolCallId: _id, phase: input.phase, phaseId: input.phaseId }) : undefined;
        let assessment = cache.get(identity);
        const source = assessment ? "cache" : inFlight.has(identity) ? "in_flight" : config.mode === "rules-only" ? "rules" : noComparison(input) ? "local" : "service";
        // Queue without yielding: same-state calls must see inFlight registered below.
        const recorded = debug?.({ event: "assessment", source, input });
        if (!assessment) {
          let task = inFlight.get(identity);
          if (!task) {
            task = (async () => {
              let judgment; let serviceFailed = false;
              if (config.mode !== "rules-only" && !noComparison(input)) {
                if (!ui(ctx, () => ctx.ui.notify("Jev: START; выполняется оценка.", "info"))) return applyPolicy(input, config, undefined, true, revisionUsed ? 1 : 0);
                try { judgment = await ask(input, signal, debug, config.relativeCosts); }
                catch (error) {
                  if (signal?.aborted) throw new Error("Assessment cancelled.");
                  serviceFailed = true;
                }
              }
              if (signal?.aborted) throw new Error("Assessment cancelled.");
              return applyPolicy(input, config, judgment, serviceFailed, revisionUsed ? 1 : 0);
            })();
            inFlight.set(identity, task);
            void task.finally(() => { if (inFlight.get(identity) === task) inFlight.delete(identity); }).catch(() => {});
          }
          assessment = await task;
        }
        await recorded;
        // Only a current waiter may accept a shared result and spend the allowance.
        // A -> B -> A can rejoin a promise whose originating snapshot is stale.
        if (!gate.isCurrent(snapshot)) { await debug?.({ event: "discarded" }); displayResult(ctx, assessment, "discarded"); return { content: [{ type: "text", text: "Discarded stale assessment." }], details: { stale: true } }; }
        const accepted = cache.get(identity);
        if (accepted) assessment = accepted;
        else if (assessment.needsRevision && revisionUsed) assessment = { ...assessment, needsRevision: false, conservativeFallback: true };
        if (!gate.record(snapshot, assessment)) { await debug?.({ event: "discarded" }); displayResult(ctx, assessment, "discarded"); return { content: [{ type: "text", text: "Discarded stale assessment." }], details: { stale: true } }; }
        if (!accepted && assessment.needsRevision) revisionUsed = true;
        if (params.roles !== undefined) cachedRoles = input.roles;
        cache.set(identity, assessment);
        if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
        displayResult(ctx, assessment, "result");
        const result = render(assessment);
        await debug?.({ event: "result", source, result });
        return { content: [{ type: "text", text: JSON.stringify(conciseResult(assessment, config.mode === "observe")) }], details: { ...result, source, serviceCalled: source === "service" } };
      } catch (error) {
        if ((error as Error).message === "Assessment cancelled.") {
          ui(ctx, () => ctx.ui.notify("Jev: RESULT отменён.", "warning"));
          return { content: [{ type: "text", text: "Assessment cancelled." }], details: { cancelled: true } };
        }
        failOpen(ctx);
        return { content: [{ type: "text", text: "Assessment extension malfunctioned; gating is disabled for this session." }], details: { disabled: true } };
      }
    } });

    pi.registerTool({ name: "delegation_deviate", label: "Routing Deviation", description: "Record a concrete English reason for choosing differently from the fresh routing recommendation; not a work gate.", parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 500 }) }), async execute(_id, params, _signal, _update, ctx) {
      if (!config.enabled) return { content: [{ type: "text", text: "Assessment is off/baseline." }], details: { mode: "off" } };
      const reason = params.reason.trim(); const invalid = validateEnglishSafe(reason, "Deviation reason", 500);
      if (invalid) throw new Error(invalid);
      const recorded = guarded(ctx, () => gate.recordDeviation(reason, contextTokens(ctx), config.contextGrowthTokens));
      if (recorded === undefined) return { content: [{ type: "text", text: "Assessment extension malfunctioned; gating is disabled for this session." }], details: { disabled: true } };
      if (!recorded) throw new Error("A fresh routing recommendation is required before recording a deviation.");
      try { pi.appendEntry(CUSTOM_TYPE, { kind: "deviation", assessmentIdentity: gate.state.deviation?.identity, reasonLength: reason.length }); } catch { failOpen(ctx); }
      ui(ctx, () => ctx.ui.setStatus("delegation", `Действие главного агента: отклонение от рекомендации: ${reason}`));
      ui(ctx, () => ctx.ui.notify(`Действие главного агента: отклонение от рекомендации: ${reason}`, "info"));
      return { content: [{ type: "text", text: "Concrete routing deviation recorded for the current recommendation." }], details: { deviationRecorded: true } };
    } });

    pi.on("tool_call", (event, ctx) => guarded(ctx, () => {
      if (!config.enabled || gate.state.disabled) return;
      if (isBoundedServiceAction(event.toolName, event.input)) {
        if (event.toolName === "subagent" && event.input.action === "list" && event.input.capabilities === true) {
          capabilityDiscovery.set(event.toolCallId, gate.snapshot()); latestDiscoveryId = event.toolCallId;
        }
        return;
      }
      if (event.toolName === "delegation_deviate") return;
      const launch = event.toolName === "subagent";
      if (!isWorkingTool(event.toolName) && !launch) return;
      const { tokens, budget } = parentContext(ctx, config);
      monitorBudget(ctx, budget);
      invalidateForModel(budget);
      if (gate.state.disabled) return;
      const verdict = gate.mayWork(config.mode, tokens, config.contextGrowthTokens);
      const need = gate.assessmentNeed(tokens, config.contextGrowthTokens);
      // Token counts and tool IDs change while the same assessment remains stale.
      // Generation changes on a new request, phase, session, or invalidation.
      const warningKey = need === "context_growth" ? `${gate.state.assessment?.identity}:${gate.state.assessment?.contextTokens}:growth` : `${gate.state.generation}:${need}`;
      if (config.mode === "observe" && need && assessmentWarningKey !== warningKey) {
        assessmentWarningKey = warningKey;
        const reason = need === "context_growth"
          ? `оценка устарела: рост контекста на ${tokens! - gate.state.assessment!.contextTokens!} токенов, порог ${config.contextGrowthTokens}; повторите delegation_assess с phase=context_growth и новым phaseId перед следующим рабочим инструментом`
          : need === "pending" ? "оценка ещё выполняется" : "оценка отсутствует для текущего запроса или фазы; вызовите delegation_assess";
        ui(ctx, () => ctx.ui.notify(`Наблюдение: ${reason}; инструмент не блокировался.`, "warning"));
      }
      if (config.mode === "observe" && need === "context_growth" && gate.state.assessment) {
        const key = `${gate.state.assessment.identity}:${gate.state.assessment.contextTokens}`;
        if (growthReminderKey !== key) {
          growthReminderKey = key;
          try { pi.sendMessage({ customType: CUSTOM_TYPE, display: false, content: "Routing advice expired by context growth. Reassess with delegation_assess phase=context_growth before the next working tool; no delegation is automatic." }, { deliverAs: "steer", triggerTurn: false }); }
          catch { failOpen(ctx); }
        }
      }
      if (!verdict.allowed && config.mode !== "observe") return { block: true, reason: verdict.reason };
      if (launch) { gate.markDispatch(event.toolCallId); ui(ctx, () => ctx.ui.notify("Действие главного агента: запуск делегирования (попытка).", "info")); }
      else if (gate.state.assessment && !gate.needsAssessment(contextTokens(ctx), config.contextGrowthTokens)
        && parentActionGeneration !== gate.state.generation) {
        parentActionGeneration = gate.state.generation;
        // A preparation tool is not evidence of a routing decision or refusal.
        const text = `Действие главного агента: вызов инструмента ${event.toolName}; рекомендация=${gate.state.assessment.effective}; режим=${config.mode}`;
        ui(ctx, () => ctx.ui.setStatus("delegation", text));
        ui(ctx, () => ctx.ui.notify(text, "info"));
      }
    }));
    pi.on("tool_result", (event, ctx) => guarded(ctx, () => {
      if (!config.enabled || event.toolName !== "subagent") return;
      if (event.input && typeof event.input === "object" && !Array.isArray(event.input)
        && event.input.action === "list" && event.input.capabilities === true) {
        const snapshot = capabilityDiscovery.get(event.toolCallId);
        capabilityDiscovery.delete(event.toolCallId);
        if (!event.isError && snapshot && gate.isCurrent(snapshot) && latestDiscoveryId === event.toolCallId) invalidateCapabilities();
        return;
      }
      if (isBoundedServiceAction(event.toolName, event.input)) return;
      const result = gate.settleDispatch(event.toolCallId, !event.isError && confirmedDispatch(event.details));
      if (result === "confirmed") ui(ctx, () => ctx.ui.notify("Действие главного агента: запуск делегирования подтверждён.", "info"));
      else if (result === "current-failed") ui(ctx, () => ctx.ui.notify("Действие главного агента: запуск не подтверждён; свежесть оценки не изменилась.", "warning"));
    }));
  };
}
export default createDelegationAssessment();
