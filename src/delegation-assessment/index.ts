import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Gate } from "./gate.ts";
import { DEFAULT_BUDGET_CONFIG, parentContext, validBudget, type BudgetConfig, type ParentContext } from "./context-budget.ts";
import { askJev } from "./typesafe.ts";
import { DEFAULT_POLICY_CONFIG, applyPolicy, assessmentIdentity, isBoundedServiceAction, isWorkingTool, validateAssessmentInput, validateEnglishSafe, type Assessment, type AssessmentInput, type PolicyConfig } from "./policy.ts";

const CUSTOM_TYPE = "delegation-assessment";
const MAX_CACHE = 20;
interface RuntimeConfig extends PolicyConfig, BudgetConfig { enabled: boolean; }
const OFF_CONFIG: RuntimeConfig = { ...DEFAULT_POLICY_CONFIG, ...DEFAULT_BUDGET_CONFIG, mode: "off", enabled: false };

function parseConfig(raw: unknown): RuntimeConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const mode = value.mode ?? "observe";
  if (mode !== "observe" && mode !== "enforce" && mode !== "rules-only" && mode !== "off") return undefined;
  const threshold = value.provisionalConfidenceThreshold ?? DEFAULT_POLICY_CONFIG.provisionalConfidenceThreshold;
  const growth = value.contextGrowthTokens ?? DEFAULT_POLICY_CONFIG.contextGrowthTokens;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1 || typeof growth !== "number" || !Number.isSafeInteger(growth) || growth < 1_000) return undefined;
  const smartZoneTokens = value.smartZoneTokens === undefined ? DEFAULT_BUDGET_CONFIG.smartZoneTokens : value.smartZoneTokens;
  const overrides = value.smartZoneTokensByModel === undefined ? {} : value.smartZoneTokensByModel;
  if (!validBudget(smartZoneTokens) || !overrides || typeof overrides !== "object" || Array.isArray(overrides)
    || !Object.entries(overrides).every(([key, budget]) => /^[^\s/]+\/[^\s]+$/.test(key) && validBudget(budget))) return undefined;
  return { enabled: mode !== "off", mode, provisionalConfidenceThreshold: threshold, contextGrowthTokens: growth,
    smartZoneTokens, smartZoneTokensByModel: overrides as Record<string, number> };
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
  return { effective: assessment.effective, choice: assessment.choice, origin: assessment.origin, confidence: assessment.confidence, probabilities: assessment.probabilities, contextTokensApproximate: assessment.contextTokens, model: assessment.model, parentContext: assessment.parentContext };
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
export function createDelegationAssessment(ask: (input: AssessmentInput, signal: AbortSignal | undefined) => Promise<import("./policy.ts").ModelJudgment> = askJev): (pi: ExtensionAPI) => void {
  return (pi) => {
    if (process.env.PI_SUBAGENT_CHILD === "1") return;
    const gate = new Gate();
    let config = OFF_CONFIG;
    let sessionId: string | undefined;
    let runActive = false;
    let requestPreparedForRun = false;
    let directActionGeneration: number | undefined;
    let budgetWarningKey: string | undefined;
    let assessmentWarningKey: string | undefined;
    const cache = new Map<string, Assessment>();
    const inFlight = new Map<string, Promise<Assessment>>();
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
    const newRequest = (): void => { gate.newRequest(randomUUID()); cache.clear(); };
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
        gate.resetSession(); budgetWarningKey = undefined;
        cache.clear(); inFlight.clear(); runActive = false; requestPreparedForRun = false;
        sessionId = currentSessionId(ctx);
        const loaded = await loadConfig(ctx); config = loaded.config;
        // Fork/new intentionally do not inherit a disabled marker copied from another branch.
        if ((event.reason === "startup" || event.reason === "resume" || event.reason === "reload") && disabledForSession(ctx, sessionId)) gate.disable();
        const state = gate.state.disabled
          ? "Оценка делегирования: отключена после внутренней ошибки этой сессии."
          : loaded.warning ?? (config.mode === "off" ? "Оценка делегирования: выключена" : config.mode === "observe" ? "Оценка делегирования: наблюдение (Jev/rules не блокируют)" : config.mode === "rules-only" ? "Оценка делегирования: rules-only (правила применяются)" : "Оценка делегирования: enforce (Jev/rules применяются)");
        ui(ctx, () => ctx.ui.setStatus("delegation", state));
        if (loaded.warning) ui(ctx, () => ctx.ui.notify(loaded.warning!, "warning"));
      } catch { failOpen(ctx); }
    });
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
      gate.invalidateAssessment(); cache.clear();
    }));
    pi.on("before_agent_start", (_event, ctx) => guarded(ctx, () => {
      if (!config.enabled || gate.state.disabled || !gate.state.requestId) return;
      const modeText = config.mode === "observe" ? "Observe only; never block tools." : "Enforce the same policy before working tools.";
      return { message: { customType: CUSTOM_TYPE, display: false, content: `Delegation assessment (${config.mode}). Before the first working tool and each explicit new phase, call delegation_assess with an English <=2000-character next-step summary, phase category, unique phaseId, facts, selected suitable candidate, and compact roles obtained from subagent action:list capabilities:true. After approximately ${config.contextGrowthTokens} additional parent context tokens, including after reading large skills or reference documents, reassess with phase=context_growth and a new phaseId before the next working tool, including subagent launches. Read only relevant reference sections. Parent smart-zone default budget is ${config.smartZoneTokens} tokens, with per-model overrides and a cap at the model window. This is a heuristic, not a quality guarantee. Near the budget, prefer fresh-context children and concise reports only when delegation prerequisites and operator permission hold. At the budget, propose a manual handoff or compaction; do not launch children or compact automatically. Delegation does not remove existing parent context. Child context usage is unknown. Do not include raw user text, code, logs, or secrets. ${modeText} This tool only advises; the parent alone launches existing subagents and does not expand permissions.` } };
    }));

    pi.registerTool({ name: "delegation_assess", label: "Delegation Assess", description: "Assess an English bounded next step; this does not launch children.", promptSnippet: "Assess delegation before working tools or an explicit phase transition", promptGuidelines: ["Use delegation_assess before working tools with compact roles from subagent action:list capabilities:true."], parameters: Type.Object({
      phase: StringEnum(["initial", "transition", "context_growth"] as const), phaseId: Type.String({ minLength: 1, maxLength: 80 }), nextStep: Type.String({ minLength: 1, maxLength: 2000 }),
      facts: Type.Object({ boundedVerifiableSubtask: Type.Boolean(), requiresMostParentContext: Type.Boolean(), largeResearch: Type.Boolean(), independentWork: Type.Boolean(), knownWriteConflict: Type.Boolean() }),
      roles: Type.Array(Type.Object({ name: Type.String({ maxLength: 80 }), summary: Type.String({ maxLength: 300 }), available: Type.Boolean() }), { maxItems: 12 }), selectedCandidate: Type.Object({ name: Type.String({ maxLength: 80 }), suitable: Type.Boolean() }),
    }), async execute(_id, params, signal, _update, ctx) {
      if (!config.enabled) return { content: [{ type: "text", text: "Assessment is off/baseline." }], details: { mode: "off" } };
      if (gate.state.disabled) return { content: [{ type: "text", text: "Assessment extension is disabled for this session." }], details: { disabled: true } };
      let tokens: number | null;
      let budget: ParentContext;
      try { ({ tokens, budget } = parentContext(ctx, config)); monitorBudget(ctx, budget); } catch { failOpen(ctx); return { content: [{ type: "text", text: "Assessment extension malfunctioned; gating is disabled for this session." }], details: { disabled: true } }; }
      if (gate.state.disabled) return { content: [{ type: "text", text: "Assessment extension is disabled for this session." }], details: { disabled: true } };
      const requestId = gate.state.requestId;
      if (!requestId) throw new Error("No active user request to assess.");
      const input: AssessmentInput = { requestId, phase: params.phase, phaseId: params.phaseId, nextStep: params.nextStep, facts: params.facts, roles: params.roles, selectedCandidate: params.selectedCandidate, contextTokens: tokens, parentContext: budget };
      const invalid = validateAssessmentInput(input);
      if (invalid) throw new Error(invalid); // caller input errors stay repairable
      try {
        const identity = assessmentIdentity(input, config.contextGrowthTokens);
        const snapshot = gate.beginAssessment(identity);
        if (!snapshot) throw new Error("No active user request to assess.");
        let assessment = cache.get(identity);
        if (!assessment) {
          let task = inFlight.get(identity);
          if (!task) {
            task = (async () => {
              let judgment; let serviceFailed = false;
              if (config.mode !== "rules-only") {
                if (!ui(ctx, () => ctx.ui.notify("Jev: START; выполняется оценка.", "info"))) return applyPolicy(input, config, undefined, true);
                try { judgment = await ask(input, signal); }
                catch (error) {
                  if (signal?.aborted) throw new Error("Assessment cancelled.");
                  serviceFailed = true;
                }
              }
              return applyPolicy(input, config, judgment, serviceFailed);
            })();
            inFlight.set(identity, task);
            void task.finally(() => { if (inFlight.get(identity) === task) inFlight.delete(identity); }).catch(() => {});
          }
          assessment = await task;
          // A completed call may only populate the cache for its exact still-current generation.
          if (!gate.isCurrent(snapshot)) { displayResult(ctx, assessment, "discarded"); return { content: [{ type: "text", text: "Discarded stale assessment." }], details: { stale: true } }; }
          cache.set(identity, assessment);
          if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
        }
        if (!gate.record(snapshot, assessment)) { displayResult(ctx, assessment, "discarded"); return { content: [{ type: "text", text: "Discarded stale assessment." }], details: { stale: true } }; }
        displayResult(ctx, assessment, "result");
        const result = render(assessment);
        return { content: [{ type: "text", text: JSON.stringify({ observation: config.mode === "observe", ...result }) }], details: result };
      } catch (error) {
        if ((error as Error).message === "Assessment cancelled.") {
          ui(ctx, () => ctx.ui.notify("Jev: RESULT отменён.", "warning"));
          return { content: [{ type: "text", text: "Assessment cancelled." }], details: { cancelled: true } };
        }
        failOpen(ctx);
        return { content: [{ type: "text", text: "Assessment extension malfunctioned; gating is disabled for this session." }], details: { disabled: true } };
      }
    } });

    pi.registerTool({ name: "delegation_refuse", label: "Delegation Refusal", description: "Record a concrete English reason for declining the current delegation recommendation.", parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 500 }) }), async execute(_id, params, _signal, _update, ctx) {
      if (!config.enabled) return { content: [{ type: "text", text: "Assessment is off/baseline." }], details: { mode: "off" } };
      const reason = params.reason.trim(); const invalid = validateEnglishSafe(reason, "Refusal reason");
      if (invalid) throw new Error(invalid);
      const recorded = guarded(ctx, () => gate.recordRefusal(reason, contextTokens(ctx), config.contextGrowthTokens));
      if (recorded === undefined) return { content: [{ type: "text", text: "Assessment extension malfunctioned; gating is disabled for this session." }], details: { disabled: true } };
      if (!recorded) throw new Error("A current delegation recommendation is required before recording a refusal.");
      try { pi.appendEntry(CUSTOM_TYPE, { kind: "refusal", assessmentIdentity: gate.state.refusal?.identity, reasonLength: reason.length }); } catch { failOpen(ctx); }
      ui(ctx, () => ctx.ui.setStatus("delegation", `Действие главного агента: отказ от делегирования: ${reason}`));
      ui(ctx, () => ctx.ui.notify(`Действие главного агента: отказ от делегирования: ${reason}`, "info"));
      return { content: [{ type: "text", text: "Concrete delegation refusal recorded for the current recommendation." }], details: { refusalRecorded: true } };
    } });

    pi.on("tool_call", (event, ctx) => guarded(ctx, () => {
      if (!config.enabled || gate.state.disabled) return;
      if (isBoundedServiceAction(event.toolName, event.input)) return;
      const launch = event.toolName === "subagent";
      if (!isWorkingTool(event.toolName) && !launch) return;
      const { tokens, budget } = parentContext(ctx, config);
      monitorBudget(ctx, budget);
      if (gate.state.disabled) return;
      const verdict = gate.mayWork(config.mode, tokens, config.contextGrowthTokens, launch);
      const need = gate.assessmentNeed(tokens, config.contextGrowthTokens);
      // Token counts and tool IDs change while the same assessment remains stale.
      // Generation changes on a new request, phase, session, or invalidation.
      const warningKey = `${gate.state.generation}:${need}`;
      if (config.mode === "observe" && need && assessmentWarningKey !== warningKey) {
        assessmentWarningKey = warningKey;
        const reason = need === "context_growth"
          ? `оценка устарела: рост контекста на ${tokens! - gate.state.assessment!.contextTokens!} токенов, порог ${config.contextGrowthTokens}; повторите delegation_assess с phase=context_growth и новым phaseId перед следующим рабочим инструментом`
          : need === "pending" ? "оценка ещё выполняется" : "оценка отсутствует для текущего запроса или фазы; вызовите delegation_assess";
        ui(ctx, () => ctx.ui.notify(`Наблюдение: ${reason}; инструмент не блокировался.`, "warning"));
      }
      if (!verdict.allowed && config.mode !== "observe") return { block: true, reason: verdict.reason };
      if (launch) { gate.markDispatch(event.toolCallId); ui(ctx, () => ctx.ui.notify("Действие главного агента: запуск делегирования (попытка).", "info")); }
      else if (gate.state.assessment?.effective === "direct" && !gate.needsAssessment(contextTokens(ctx), config.contextGrowthTokens)
        && directActionGeneration !== gate.state.generation) {
        directActionGeneration = gate.state.generation;
        const text = `Действие главного агента: продолжает работу самостоятельно; режим=${config.mode}`;
        ui(ctx, () => ctx.ui.setStatus("delegation", text));
        ui(ctx, () => ctx.ui.notify(text, "info"));
      }
    }));
    pi.on("tool_result", (event, ctx) => guarded(ctx, () => {
      if (!config.enabled || event.toolName !== "subagent" || isBoundedServiceAction(event.toolName, event.input)) return;
      const result = gate.settleDispatch(event.toolCallId, !event.isError && confirmedDispatch(event.details));
      if (result === "confirmed") ui(ctx, () => ctx.ui.notify("Действие главного агента: запуск делегирования подтверждён.", "info"));
      else if (result === "current-failed") {
        gate.invalidateAssessment();
        ui(ctx, () => ctx.ui.notify("Действие главного агента: запуск не подтверждён; нужна новая оценка и список ролей.", "warning"));
      }
    }));
  };
}
export default createDelegationAssessment();
