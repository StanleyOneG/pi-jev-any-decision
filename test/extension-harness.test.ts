import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDelegationAssessment } from "../src/delegation-assessment/index.ts";
import type { AssessmentInput, ModelJudgment } from "../src/delegation-assessment/policy.ts";

async function harness(mode?: "observe" | "enforce" | "rules-only" | "off", trusted = true, extraConfig: Record<string, unknown> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "jev-extension-")); if (mode) { await mkdir(join(cwd, ".pi")); await writeFile(join(cwd, ".pi", "delegation-assessment.json"), JSON.stringify({ mode, provisionalConfidenceThreshold: .7, ...extraConfig })); }
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>(); const tools: any[] = []; const notices: string[] = []; const entries: any[] = []; let tokens: number | undefined = 10; let sessionId = "session-1"; let usageError = false;
  const pi: any = { on(name: string, handler: any) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => {}; }, registerTool(tool: any) { tools.push(tool); }, appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); }, events: { on() {}, emit() {} } };
  const ctx: any = { cwd, mode: "json", hasUI: false, signal: undefined, isProjectTrusted: () => trusted, getContextUsage: () => { if (usageError) throw new Error("usage unavailable"); return tokens === undefined ? undefined : ({ tokens, contextWindow: 100_000, percent: .01 }); }, sessionManager: { getSessionId: () => sessionId, getEntries: () => entries }, ui: { setStatus: (_k: string, text: string) => notices.push(text), notify: (text: string) => notices.push(text) } };
  return { pi, handlers, tools, ctx, notices, entries, setTokens: (value: number | undefined) => { tokens = value; }, setUsageError: (value: boolean) => { usageError = value; }, setSessionId: (value: string) => { sessionId = value; } };
}
const input = (phaseId = "initial-1") => ({ phase: "initial" as const, phaseId, nextStep: "Research official documentation and return a concise bounded brief.", roles: [{ name: "researcher", summary: "Research official documentation.", purpose: "research" as const, available: true, suitable: true, authorized: true, tools: ["read"] }], options: [
  { id: "direct", kind: "direct" as const, summary: "Parent researches and verifies the documentation.", evidence: "Parent can perform the complete task.", verificationCriteria: "Cross-check the primary documentation.", roles: [], requiredTools: [], authorized: true, writeConflict: false, taskSuitability: "suitable" as const, contextDependency: "low" as const, decisionsRecorded: "documents" as const, handoffEffort: "low" as const, handoffLossRisk: "low" as const, verificationEffort: "moderate" as const, executionEffort: "high" as const, reworkRisk: "low" as const, expectedBenefit: "moderate" as const, independentReviewBenefit: "low" as const },
  { id: "research", kind: "delegated" as const, summary: "Researcher reads official documentation and returns a brief.", evidence: "The bounded research can be checked independently.", verificationCriteria: "Verify claims against primary references.", roles: ["researcher"], requiredTools: ["read"], authorized: true, writeConflict: false, taskSuitability: "suitable" as const, contextDependency: "low" as const, decisionsRecorded: "documents" as const, handoffEffort: "low" as const, handoffLossRisk: "low" as const, verificationEffort: "low" as const, executionEffort: "moderate" as const, reworkRisk: "low" as const, expectedBenefit: "high" as const, independentReviewBenefit: "moderate" as const },
] });
const direct: ModelJudgment = { choice: "direct", confidence: .9, probabilities: { research: .05, direct: .85, insufficient_information: .05, revise_options: .05 }, model: "mock" };
const research: ModelJudgment = { ...direct, choice: "research", probabilities: { research: .85, direct: .05, insufficient_information: .05, revise_options: .05 } };
async function start(h: Awaited<ReturnType<typeof harness>>) { await h.handlers.get("session_start")![0]({ reason: "startup" }, h.ctx); h.handlers.get("input")![0]({ source: "interactive", text: "raw secret user text" }, h.ctx); }
function tool(h: Awaited<ReturnType<typeof harness>>, name: string) { return h.tools.find((candidate) => candidate.name === name)!; }

test("debug is opt-in, project-local, records cache and separates sessions", async () => {
  const h = await harness("observe", true, { debug: true }); let calls = 0;
  createDelegationAssessment(async (_input, _signal, debug) => { calls++; await debug?.({ event: "request", payload: { model: "mock" } }); return direct; })(h.pi);
  await start(h);
  const assess = () => tool(h, "delegation_assess").execute("a", input(), undefined, undefined, h.ctx);
  await Promise.all([assess(), assess()]); await assess();
  const directory = join(h.ctx.cwd, ".pi/delegation-assessment-debug");
  const rows = (await readFile(join(directory, "session-1.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls, 1);
  assert.deepEqual(rows.filter((row) => row.event === "assessment").map((row) => row.source), ["service", "in_flight", "cache"]);
  assert.equal(rows.filter((row) => row.event === "request").length, 1);
  assert.equal(rows.find((row) => row.event === "assessment").input.nextStep, input().nextStep);
  assert.ok(!JSON.stringify(rows).includes("raw secret user text"));
  h.setSessionId("session-2"); await start(h); await assess();
  assert.ok((await stat(join(directory, "session-2.jsonl"))).isFile());
  for (const [mode, trusted, config] of [["observe", true, {}], ["off", true, { debug: true }], ["observe", false, { debug: true }], ["observe", true, { debug: "yes" }]] as const) {
    const other = await harness(mode, trusted, config); createDelegationAssessment(async () => direct)(other.pi); await start(other);
    await tool(other, "delegation_assess").execute("a", input(), undefined, undefined, other.ctx);
    await assert.rejects(stat(join(other.ctx.cwd, ".pi/delegation-assessment-debug")), { code: "ENOENT" });
  }
});

test("rejoining an older in-flight identity spends clarification exactly once at acceptance", async () => {
  const h = await harness("observe", true, { debug: true });
  const pending = new Map<string, (value: ModelJudgment) => void>(); let calls = 0;
  const abstain: ModelJudgment = { ...direct, choice: "insufficient_information" };
  createDelegationAssessment((value) => { calls++; return new Promise((resolve) => pending.set(value.phaseId, resolve)); })(h.pi);
  await start(h);
  const assess = (phaseId: string) => tool(h, "delegation_assess").execute(phaseId, input(phaseId), undefined, undefined, h.ctx);
  const a = assess("stage-a"); const b = assess("stage-b"); const aAgain = assess("stage-a");
  assert.equal(calls, 2);
  pending.get("stage-a")!(abstain);
  assert.equal((await a).details.stale, true);
  assert.equal((await aAgain).details.needsRevision, true);
  pending.get("stage-b")!(abstain);
  assert.equal((await b).details.stale, true);
  const c = assess("stage-c"); pending.get("stage-c")!(abstain);
  const result = await c;
  assert.equal(result.details.needsRevision, false);
  assert.equal(result.details.conservativeFallback, true);
  assert.equal(result.details.effective, "direct");
});

test("observe distinguishes missing assessment from growth expiry and provides reassessment instructions", async () => {
  const h = await harness("observe"); createDelegationAssessment(async () => direct)(h.pi); await start(h);
  const work = () => h.handlers.get("tool_call")![0]({ toolName: "read", toolCallId: "r", input: {} }, h.ctx);
  assert.equal(await work(), undefined);
  assert.match(h.notices.at(-1)!, /оценка отсутствует/);
  await tool(h, "delegation_assess").execute("a", input(), undefined, undefined, h.ctx);
  h.setTokens(16_010); assert.equal(await work(), undefined);
  assert.match(h.notices.at(-1)!, /оценка устарела.*рост.*16000.*context_growth/);
  const injected = h.handlers.get("before_agent_start")![0]({}, h.ctx).message.content;
  assert.match(injected, /after reading large skills or reference documents/);
  assert.match(injected, /before the next working tool, including subagent launches/);
});

test("observe warns once per stale assessment across tool batches and further growth", async () => {
  const h = await harness("observe"); createDelegationAssessment(async () => direct)(h.pi); await start(h);
  const assess = (phaseId: string) => tool(h, "delegation_assess").execute("a", input(phaseId), undefined, undefined, h.ctx);
  let callId = 0;
  const work = (toolName = "read") => h.handlers.get("tool_call")![0]({ toolName, toolCallId: `work-${callId++}`, input: {} }, h.ctx);
  const warnings = () => h.notices.filter((text) => text.startsWith("Наблюдение:"));
  await assess("initial");
  h.setTokens(16_010);
  assert.equal(await work(), undefined);
  assert.equal(warnings().length, 1);
  assert.match(warnings()[0], /оценка устарела.*context_growth/);
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => work())), Array(8).fill(undefined));
  h.setTokens(33_354); assert.equal(await work("bash"), undefined);
  h.setTokens(undefined); await work();
  h.setTokens(34_000); await work();
  assert.equal(warnings().length, 1, "same stale assessment must not spam, even as token counts change");
  await assess("fresh-growth"); await work();
  assert.equal(warnings().length, 1);
  h.setTokens(50_000); await work(); await work();
  assert.equal(warnings().length, 2, "a newly expired assessment gets its own warning");
});

test("observe deduplicates missing and pending warnings but rearms on lifecycle changes", async () => {
  const h = await harness("observe");
  let resolve!: (value: ModelJudgment) => void;
  createDelegationAssessment(() => new Promise((done) => { resolve = done; }))(h.pi); await start(h);
  const work = () => h.handlers.get("tool_call")![0]({ toolName: "read", toolCallId: "r", input: {} }, h.ctx);
  const warnings = () => h.notices.filter((text) => text.startsWith("Наблюдение:"));
  await work(); await work();
  assert.equal(warnings().length, 1);
  assert.match(warnings().at(-1)!, /оценка отсутствует/);
  const pending = tool(h, "delegation_assess").execute("a", input(), undefined, undefined, h.ctx);
  await work(); await work();
  assert.equal(warnings().length, 2);
  assert.match(warnings().at(-1)!, /ещё выполняется/);
  resolve(direct); await pending;
  h.setTokens(16_010); await work(); await work();
  assert.equal(warnings().length, 3, "pending warning must not hide expiry in the same generation");
  assert.match(warnings().at(-1)!, /оценка устарела/);
  h.handlers.get("input")![0]({ source: "interactive", text: "next request" }, h.ctx);
  await work(); await work(); assert.equal(warnings().length, 4);
  h.handlers.get("session_tree")![0]({}, h.ctx);
  await work(); await work(); assert.equal(warnings().length, 5);
  await start(h);
  await work(); await work(); assert.equal(warnings().length, 6);
});

test("parent smart-zone telemetry warns at 80 percent and budget without forcing delegation or blocking", async () => {
  const h = await harness("observe"); let tokens: number | undefined = 119_999; let captured: AssessmentInput | undefined;
  h.ctx.model = { provider: "test", id: "parent", contextWindow: 272_000 };
  h.ctx.getContextUsage = () => tokens === undefined ? undefined : { tokens, contextWindow: 272_000 };
  createDelegationAssessment(async (value) => { captured = value; return direct; })(h.pi); await start(h);
  const assess = () => tool(h, "delegation_assess").execute("a", input(), undefined, undefined, h.ctx);
  let result = await assess();
  assert.equal(result.details.parentContext.smartZoneState, "within");
  assert.equal(result.details.parentContext.remainingTokens, 30_001);
  assert.equal(result.details.parentContext.contextWindowTokens, 272_000);
  assert.equal(result.details.parentContext.model, "test/parent");
  assert.deepEqual((captured as any).parentContext, result.details.parentContext);
  const warnings = () => h.notices.filter((text) => text.startsWith("Smart zone:"));
  assert.equal(warnings().length, 0);
  tokens = 120_000; result = await assess(); assert.equal(result.details.parentContext.smartZoneState, "near");
  assert.equal(warnings().length, 1);
  await assess(); assert.equal(warnings().length, 1, "no warning spam on repeated assessment");
  tokens = 150_000;
  assert.equal(await h.handlers.get("tool_call")![0]({ toolName: "read", toolCallId: "r", input: {} }, h.ctx), undefined);
  assert.equal(warnings().length, 2, "monitor even without a new assessment");
  assert.match(warnings().at(-1)!, /новую сессию.*compaction.*не разгружает/);
  result = await assess(); assert.equal(result.details.parentContext.smartZoneState, "exceeded");
  assert.equal(result.details.effective, "direct", "budget never forces delegation");
  tokens = undefined; result = await assess();
  assert.equal(result.details.parentContext.smartZoneState, "unknown");
  assert.equal(result.details.parentContext.remainingTokens, null);
  assert.equal(result.details.parentContext.contextWindowTokens, 272_000);
  assert.equal(result.details.parentContext.childContext, "unknown");
});

test("model overrides, physical window cap, and unknown telemetry are explicit", async () => {
  const h = await harness("observe", true, { smartZoneTokens: 140_000, smartZoneTokensByModel: { "test/parent": 90_000 } });
  h.ctx.model = { provider: "test", id: "parent", contextWindow: 80_000 };
  h.ctx.getContextUsage = () => ({ tokens: 70_000, contextWindow: 80_000 });
  createDelegationAssessment(async () => direct)(h.pi); await start(h);
  const assess = () => tool(h, "delegation_assess").execute("a", input(), undefined, undefined, h.ctx);
  let result = await assess();
  assert.equal(result.details.parentContext.configuredSmartZoneTokens, 90_000);
  assert.equal(result.details.parentContext.smartZoneTokens, 80_000);
  assert.equal(result.details.parentContext.remainingTokens, 10_000);
  h.ctx.model = undefined; h.ctx.getContextUsage = () => undefined;
  result = await assess();
  assert.equal(result.details.parentContext.model, null);
  assert.equal(result.details.parentContext.contextWindowTokens, null);
  assert.equal(result.details.parentContext.smartZoneTokens, 140_000);
  assert.equal(result.details.parentContext.remainingTokens, null);
  assert.equal(result.details.parentContext.smartZoneState, "unknown");
});

test("invalid budget configuration stays off and rules-only budget monitoring makes no API calls", async () => {
  for (const config of [{ smartZoneTokens: null }, { smartZoneTokens: "150000" }, { smartZoneTokens: 0 }, { smartZoneTokensByModel: [] }, { smartZoneTokensByModel: { "test/parent": -1 } }]) {
    const h = await harness("observe", true, config); let calls = 0;
    createDelegationAssessment(async () => { calls++; return direct; })(h.pi); await start(h);
    assert.equal((await tool(h, "delegation_assess").execute("a", input(), undefined, undefined, h.ctx)).details.mode, "off");
    assert.equal(calls, 0);
  }
  const h = await harness("rules-only"); let calls = 0;
  createDelegationAssessment(async () => { calls++; return direct; })(h.pi); await start(h); h.setTokens(150_000);
  await tool(h, "delegation_assess").execute("a", input(), undefined, undefined, h.ctx);
  assert.equal(calls, 0);
  assert.ok(h.notices.some((text) => text.startsWith("Smart zone:")));
});

test("budget warning UI failure disables the extension before any API call", async () => {
  const h = await harness("observe"); let calls = 0;
  createDelegationAssessment(async () => { calls++; return direct; })(h.pi); await start(h); h.setTokens(150_000);
  h.ctx.ui.notify = (text: string) => { if (text.startsWith("Smart zone:")) throw new Error("UI failed"); };
  const result = await tool(h, "delegation_assess").execute("a", input(), undefined, undefined, h.ctx);
  assert.equal(calls, 0);
  assert.equal(result.details.disabled, true);
});

test("direct work reports the parent action once per assessment generation", async () => {
  const h = await harness("observe"); createDelegationAssessment(async () => direct)(h.pi); await start(h);
  const actions = () => h.notices.filter((text) => text.includes("Действие главного агента: продолжает работу самостоятельно"));
  await tool(h, "delegation_assess").execute("a", input(), undefined, undefined, h.ctx);
  assert.equal(actions().length, 0, "assessment alone is not an action");
  const work = () => h.handlers.get("tool_call")![0]({ toolName: "read", toolCallId: "read", input: { path: "README.md" } }, h.ctx);
  assert.equal(await work(), undefined);
  assert.ok(actions().length > 0);
  const count = actions().length;
  await work(); assert.equal(actions().length, count, "do not repeat the action for every tool");
  await tool(h, "delegation_assess").execute("b", input("next-phase"), undefined, undefined, h.ctx);
  await work(); assert.ok(actions().length > count);
  const afterPhase = actions().length;
  h.setTokens(16_010); await work(); assert.equal(actions().length, afterPhase, "expired assessments cannot label new work");
});

test("deviation accepts any fresh recommendation and growth expires it", async () => {
  const h = await harness("enforce"); createDelegationAssessment(async () => direct)(h.pi); await start(h);
  await tool(h, "delegation_assess").execute("a", input(), undefined, undefined, h.ctx);
  const deviate = () => tool(h, "delegation_deviate").execute("r", { reason: "Independent review gives a concrete quality check." }, undefined, undefined, h.ctx);
  h.setTokens(16_009); assert.equal((await deviate()).details.deviationRecorded, true);
  const entriesBefore = h.entries.length;
  h.setTokens(16_010);
  await assert.rejects(deviate, /fresh routing recommendation/);
  assert.equal(h.entries.length, entriesBefore);
  await tool(h, "delegation_assess").execute("b", input("fresh-growth"), undefined, undefined, h.ctx);
  assert.equal((await deviate()).details.deviationRecorded, true);
});

test("enforce permits ordinary work after delegated recommendation without launch confirmation", async () => {
  const h = await harness("enforce"); let calls = 0;
  createDelegationAssessment(async () => { calls++; return research; })(h.pi); await start(h);
  const assess = (phaseId = "same-phase") => tool(h, "delegation_assess").execute("a", input(phaseId), undefined, undefined, h.ctx);
  const work = () => h.handlers.get("tool_call")![0]({ toolName: "read", toolCallId: "read", input: {} }, h.ctx);
  await assess(); await assess(); assert.equal(calls, 1);
  assert.equal(await work(), undefined);
  await tool(h, "delegation_deviate").execute("r", { reason: "The parent must preserve the single write boundary." }, undefined, undefined, h.ctx);
  await assess("new-phase"); assert.equal(await work(), undefined);
  assert.equal(calls, 2);
});

test("one clarification across phase ID and category; cache and concurrent shares do not spend it", async () => {
  const h = await harness("enforce"); let calls = 0;
  const unknown = (phaseId: string, phase: "initial" | "transition" | "context_growth" = "initial") => ({ ...input(phaseId), phase,
    options: [input().options[0], { ...input().options[1], contextDependency: "high" as const, decisionsRecorded: "conversation" as const, handoffLossRisk: "unknown" as const }] });
  createDelegationAssessment(async () => { calls++; return direct; })(h.pi); await start(h);
  const assess = (params: ReturnType<typeof unknown>) => tool(h, "delegation_assess").execute("a", params, undefined, undefined, h.ctx);
  const [first, shared] = await Promise.all([assess(unknown("first")), assess(unknown("first"))]);
  assert.equal(first.details.needsRevision, true); assert.equal(shared.details.needsRevision, true);
  assert.equal((await assess(unknown("first"))).details.needsRevision, true); assert.equal(calls, 1);
  const second = await assess(unknown("revised", "transition"));
  assert.equal(second.details.choice, "direct"); assert.equal(second.details.conservativeFallback, true);
  assert.equal(second.details.needsRevision, false); assert.equal(second.details.effective, "direct");
  assert.equal((await assess(unknown("third", "context_growth"))).details.needsRevision, false);
  assert.equal(calls, 3, "later genuine assessments remain possible without another clarification");
  h.handlers.get("input")![0]({ source: "interactive", text: "new actual request" }, h.ctx);
  assert.equal((await assess(unknown("first"))).details.needsRevision, true);
});

test("model abstention differs from exhausted fallback across category changes and fresh input resets", async () => {
  const h = await harness("enforce"); let calls = 0;
  createDelegationAssessment(async () => { calls++; return { ...direct, choice: "insufficient_information", probabilities: { direct: .05, research: .05, insufficient_information: .85, revise_options: .05 } }; })(h.pi); await start(h);
  const assess = (phaseId: string, phase: "initial" | "transition" = "initial") => tool(h, "delegation_assess").execute("a", { ...input(phaseId), phase }, undefined, undefined, h.ctx);
  const first = await assess("one"); assert.equal(first.details.needsRevision, true); assert.equal(first.details.conservativeFallback, false);
  const repeat = await assess("one"); assert.equal(repeat.details.needsRevision, true); assert.equal(calls, 1);
  const second = await assess("two", "transition"); assert.equal(second.details.needsRevision, false); assert.equal(second.details.conservativeFallback, true);
  assert.equal(second.details.effective, "direct"); assert.equal(calls, 2);
  h.handlers.get("input")![0]({ source: "interactive", text: "genuine new request" }, h.ctx);
  assert.equal((await assess("three")).details.needsRevision, true);
});

test("runtime config passes relative costs, rejects malformed profiles and legacy boolean calls", async () => {
  const h = await harness("observe", true, { relativeCosts: { defaultsByPurpose: { research: "similar" }, byRole: { researcher: "higher" } } });
  let costs: unknown; let calls = 0;
  createDelegationAssessment(async (_input, _signal, _debug, resolved) => { calls++; costs = resolved; return research; })(h.pi); await start(h);
  const assessor = tool(h, "delegation_assess");
  assert.equal(assessor.parameters.properties.options.type, "array");
  assert.equal(assessor.parameters.properties.facts, undefined);
  await assert.rejects(() => assessor.execute("bad", { ...input(), facts: { largeResearch: true } }, undefined, undefined, h.ctx), /Legacy facts\/selectedCandidate/);
  assert.equal(calls, 0);
  const result = await assessor.execute("good", input(), undefined, undefined, h.ctx);
  assert.equal(result.details.effective, "research");
  assert.deepEqual(costs, { defaultsByPurpose: { research: "similar" }, byRole: { researcher: "higher" } });
  const bad = await harness("observe", true, { relativeCosts: { defaultsByPurpose: { research: "cheap" } } });
  createDelegationAssessment(async () => { throw new Error("must stay off"); })(bad.pi); await start(bad);
  assert.equal((await tool(bad, "delegation_assess").execute("bad", input(), undefined, undefined, bad.ctx)).details.mode, "off");
});

test("off is explicit opt-in: missing/untrusted config makes no Jev calls", async () => {
  let calls = 0; const h = await harness(); createDelegationAssessment(async () => { calls++; return direct; })(h.pi); await start(h);
  const result = await tool(h, "delegation_assess").execute("a", input(), undefined, undefined, h.ctx);
  assert.equal(result.details.mode, "off"); assert.equal(calls, 0); assert.match(h.notices.join("\n"), /opt-in/);
  const untrusted = await harness("enforce", false); createDelegationAssessment(async () => { calls++; return direct; })(untrusted.pi); await start(untrusted); assert.equal((await tool(untrusted, "delegation_assess").execute("a", input(), undefined, undefined, untrusted.ctx)).details.mode, "off"); assert.equal(calls, 0);
});

test("enforce gates freshness, not launch confirmation, and admits only bounded read/control actions", async () => {
  const h = await harness("enforce"); createDelegationAssessment(async () => direct)(h.pi); await start(h);
  assert.equal((await h.handlers.get("tool_call")![0]({ toolName: "subagent", toolCallId: "launch", input: { agent: "worker", task: "work" } }, h.ctx))?.block, true);
  assert.equal(await h.handlers.get("tool_call")![0]({ toolName: "subagent", toolCallId: "list", input: { action: "list", capabilities: true } }, h.ctx), undefined);
  assert.equal((await h.handlers.get("tool_call")![0]({ toolName: "subagent", toolCallId: "bad", input: { action: "list", agent: "worker", task: "work" } }, h.ctx))?.block, true);
  assert.equal(await h.handlers.get("tool_call")![0]({ toolName: "bg_wait", toolCallId: "wait", input: {} }, h.ctx), undefined);
  await tool(h, "delegation_assess").execute("assessment", input(), undefined, undefined, h.ctx);
  assert.equal(await h.handlers.get("tool_call")![0]({ toolName: "subagent", toolCallId: "launch", input: { agent: "researcher", task: "work" } }, h.ctx), undefined);
  await h.handlers.get("tool_result")![0]({ toolName: "subagent", toolCallId: "launch", input: { agent: "researcher" }, isError: false, details: { ok: false } }, h.ctx);
  assert.equal((await h.handlers.get("tool_call")![0]({ toolName: "bash", toolCallId: "work", input: {} }, h.ctx))?.block, undefined, "unconfirmed dispatch does not stale a fresh assessment");
});

test("rules-only is enforceable without Jev; observe reports without blocking", async () => {
  let calls = 0; const rules = await harness("rules-only"); createDelegationAssessment(async () => { calls++; return direct; })(rules.pi); await start(rules);
  assert.equal((await rules.handlers.get("tool_call")![0]({ toolName: "bash", toolCallId: "b", input: {} }, rules.ctx))?.block, true);
  await tool(rules, "delegation_assess").execute("a", input(), undefined, undefined, rules.ctx); assert.equal(calls, 0);
  const observe = await harness("observe"); createDelegationAssessment(async () => direct)(observe.pi); await start(observe);
  assert.equal(await observe.handlers.get("tool_call")![0]({ toolName: "unknown_tool", toolCallId: "u", input: {} }, observe.ctx), undefined);
  assert.match(observe.notices.join("\n"), /Наблюдение/);
});

test("late assessments cannot open a new request or phase and repeated state is deduplicated", async () => {
  let resolve!: (value: ModelJudgment) => void; let calls = 0; const deferred = new Promise<ModelJudgment>((done) => { resolve = done; }); const h = await harness("enforce"); createDelegationAssessment(async () => { calls++; return deferred; })(h.pi); await start(h);
  const first = tool(h, "delegation_assess").execute("a", input("first"), undefined, undefined, h.ctx);
  const second = tool(h, "delegation_assess").execute("b", input("second"), undefined, undefined, h.ctx);
  resolve(direct); await second; const stale = await first; assert.equal(stale.details.stale, true);
  h.handlers.get("input")![0]({ source: "interactive", text: "new request" }, h.ctx);
  assert.equal((await h.handlers.get("tool_call")![0]({ toolName: "bash", toolCallId: "work", input: {} }, h.ctx))?.block, true);
  assert.equal(calls, 2);
});

test("growth, session replacement, deviation, and safe output display remain fresh and bounded", async () => {
  const h = await harness("enforce"); createDelegationAssessment(async () => research)(h.pi); await start(h);
  await tool(h, "delegation_assess").execute("a", input(), undefined, undefined, h.ctx);
  await assert.rejects(() => tool(h, "delegation_deviate").execute("r", { reason: "   " }, undefined, undefined, h.ctx));
  await tool(h, "delegation_deviate").execute("r", { reason: "The parent needs to preserve a single write boundary." }, undefined, undefined, h.ctx);
  h.setTokens(16_100); assert.equal((await h.handlers.get("tool_call")![0]({ toolName: "bash", toolCallId: "b", input: {} }, h.ctx))?.block, true);
  await h.handlers.get("session_start")![0]({ reason: "fork" }, h.ctx); assert.equal((await h.handlers.get("tool_call")![0]({ toolName: "bash", toolCallId: "c", input: {} }, h.ctx))?.block, true);
  assert.equal(h.notices.some((text) => /raw secret user text/.test(text)), false);
});

test("extension input and trigger-only idle runs establish a fresh bounded request", async () => {
  const h = await harness("enforce"); createDelegationAssessment(async () => direct)(h.pi);
  await h.handlers.get("session_start")![0]({ reason: "startup" }, h.ctx);
  await h.handlers.get("agent_start")![0]({}, h.ctx); // sendMessage({ triggerTurn: true }) has no input event
  assert.equal((await h.handlers.get("tool_call")![0]({ toolName: "bash", toolCallId: "first", input: {} }, h.ctx))?.block, true);
  await tool(h, "delegation_assess").execute("a", input(), undefined, undefined, h.ctx);
  await h.handlers.get("agent_start")![0]({}, h.ctx); // continuation does not reset the active request
  assert.equal((await h.handlers.get("tool_call")![0]({ toolName: "bash", toolCallId: "continuation", input: {} }, h.ctx))?.block, undefined);
  h.handlers.get("agent_settled")![0]({}, h.ctx);
  await h.handlers.get("agent_start")![0]({}, h.ctx); // a later trigger-only run must not reuse the old permit
  assert.equal((await h.handlers.get("tool_call")![0]({ toolName: "bash", toolCallId: "second", input: {} }, h.ctx))?.block, true);
  h.handlers.get("agent_settled")![0]({}, h.ctx);
  h.handlers.get("input")![0]({ source: "extension", text: "fresh extension message" }, h.ctx);
  assert.equal((await h.handlers.get("tool_call")![0]({ toolName: "bash", toolCallId: "third", input: {} }, h.ctx))?.block, true);
});

test("cancelled calls clean exact in-flight state and stale answers never cache or authorize", async () => {
  let calls = 0; const h = await harness("enforce"); createDelegationAssessment(async (_input, signal) => { calls++; signal?.throwIfAborted(); return direct; })(h.pi); await start(h);
  const abort = new AbortController(); abort.abort();
  assert.equal((await tool(h, "delegation_assess").execute("a", input(), abort.signal, undefined, h.ctx)).details.cancelled, true);
  assert.equal((await tool(h, "delegation_assess").execute("b", input(), undefined, undefined, h.ctx)).details.effective, "direct");
  assert.equal(calls, 2);
  assert.match(h.notices.join("\n"), /START[\s\S]*RESULT отменён/);
});

test("internal context failures fail open and disabled state restores only to its owning saved session", async () => {
  const h = await harness("enforce"); createDelegationAssessment(async () => direct)(h.pi); await start(h);
  h.setUsageError(true);
  assert.equal((await tool(h, "delegation_assess").execute("a", input(), undefined, undefined, h.ctx)).details.disabled, true);
  assert.deepEqual(h.entries.find((entry) => entry.data.kind === "disabled")?.data, { kind: "disabled", sessionId: "session-1" });
  h.setUsageError(false); await h.handlers.get("session_start")![0]({ reason: "reload" }, h.ctx);
  assert.equal((await tool(h, "delegation_assess").execute("b", input(), undefined, undefined, h.ctx)).details.disabled, true);
  h.setSessionId("fork-session"); await h.handlers.get("session_start")![0]({ reason: "fork" }, h.ctx);
  h.handlers.get("input")![0]({ source: "interactive", text: "new fork" }, h.ctx);
  assert.notEqual((await tool(h, "delegation_assess").execute("c", input(), undefined, undefined, h.ctx)).details.disabled, true);
});

test("UI failures disable the gate before a Jev call, while rules-only shows no fake Jev start", async () => {
  let calls = 0; const h = await harness("enforce"); createDelegationAssessment(async () => { calls++; return direct; })(h.pi); await start(h);
  h.ctx.ui.notify = () => { throw new Error("UI unavailable"); };
  const result = await tool(h, "delegation_assess").execute("a", input(), undefined, undefined, h.ctx);
  assert.equal(result.details.stale, true);
  assert.equal(calls, 0);
  const rules = await harness("rules-only"); createDelegationAssessment(async () => direct)(rules.pi); await start(rules);
  await tool(rules, "delegation_assess").execute("r", input(), undefined, undefined, rules.ctx);
  assert.equal(rules.notices.some((notice) => notice.includes("Jev: START")), false);
});

test("persisted deviation data is opaque and excludes assessment and reason prose", async () => {
  const h = await harness("enforce"); createDelegationAssessment(async () => research)(h.pi); await start(h);
  const sentinel = "SENTINEL_SUMMARY_AND_ROLE_TEXT";
  await tool(h, "delegation_assess").execute("a", { ...input(), nextStep: `Research ${sentinel}.`, roles: [{ ...input().roles[0], summary: sentinel }] }, undefined, undefined, h.ctx);
  await tool(h, "delegation_deviate").execute("r", { reason: `Concrete ${sentinel} reason.` }, undefined, undefined, h.ctx);
  const persisted = JSON.stringify(h.entries);
  assert.equal(persisted.includes(sentinel), false);
  assert.match(persisted, /[a-f0-9]{64}/);
});
