import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDelegationAssessment } from "../.pi/extensions/delegation-assessment/index.ts";
import type { AssessmentInput, ModelJudgment } from "../.pi/extensions/delegation-assessment/policy.ts";

async function harness(mode?: "observe" | "enforce" | "rules-only" | "off", trusted = true) {
  const cwd = await mkdtemp(join(tmpdir(), "jev-extension-")); if (mode) { await mkdir(join(cwd, ".pi")); await writeFile(join(cwd, ".pi", "delegation-assessment.json"), JSON.stringify({ mode, provisionalConfidenceThreshold: .7 })); }
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>(); const tools: any[] = []; const notices: string[] = []; const entries: any[] = []; let tokens: number | undefined = 10; let sessionId = "session-1"; let usageError = false;
  const pi: any = { on(name: string, handler: any) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => {}; }, registerTool(tool: any) { tools.push(tool); }, appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); }, events: { on() {}, emit() {} } };
  const ctx: any = { cwd, mode: "json", hasUI: false, signal: undefined, isProjectTrusted: () => trusted, getContextUsage: () => { if (usageError) throw new Error("usage unavailable"); return tokens === undefined ? undefined : ({ tokens, contextWindow: 100_000, percent: .01 }); }, sessionManager: { getSessionId: () => sessionId, getEntries: () => entries }, ui: { setStatus: (_k: string, text: string) => notices.push(text), notify: (text: string) => notices.push(text) } };
  return { pi, handlers, tools, ctx, notices, entries, setTokens: (value: number | undefined) => { tokens = value; }, setUsageError: (value: boolean) => { usageError = value; }, setSessionId: (value: string) => { sessionId = value; } };
}
const input = (phaseId = "initial-1") => ({ phase: "initial", phaseId, nextStep: "Research official documentation and return a concise bounded brief.", facts: { boundedVerifiableSubtask: true, requiresMostParentContext: false, largeResearch: true, independentWork: false, knownWriteConflict: false }, roles: [{ name: "researcher", summary: "Research official documentation.", available: true }], selectedCandidate: { name: "researcher", suitable: true } });
const direct: ModelJudgment = { choice: "direct", confidence: .9, probabilities: { delegate: .05, direct: .9, insufficient_information: .05 }, model: "mock" };
async function start(h: Awaited<ReturnType<typeof harness>>) { await h.handlers.get("session_start")![0]({ reason: "startup" }, h.ctx); h.handlers.get("input")![0]({ source: "interactive", text: "raw secret user text" }, h.ctx); }
function tool(h: Awaited<ReturnType<typeof harness>>, name: string) { return h.tools.find((candidate) => candidate.name === name)!; }

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

test("refusal uses current context and rejects the exact growth boundary", async () => {
  const h = await harness("observe");
  createDelegationAssessment(async () => ({ ...direct, choice: "delegate", probabilities: { delegate: .9, direct: .05, insufficient_information: .05 } }))(h.pi); await start(h);
  await tool(h, "delegation_assess").execute("a", input(), undefined, undefined, h.ctx);
  const refuse = () => tool(h, "delegation_refuse").execute("r", { reason: "The parent must preserve the single write boundary." }, undefined, undefined, h.ctx);
  h.setTokens(16_009); assert.equal((await refuse()).details.refusalRecorded, true);
  const entriesBefore = h.entries.length;
  h.setTokens(16_010);
  await assert.rejects(refuse, /current delegation recommendation/);
  assert.equal(h.entries.length, entriesBefore, "expired refusal must not be persisted");
  assert.equal(await h.handlers.get("tool_call")![0]({ toolName: "read", toolCallId: "r", input: {} }, h.ctx), undefined, "observe remains nonblocking");
  await tool(h, "delegation_assess").execute("b", input("fresh-growth"), undefined, undefined, h.ctx);
  assert.equal((await refuse()).details.refusalRecorded, true);
});

for (const action of ["refusal", "confirmed-launch", "pending-launch"] as const) {
  test(`identical cached assessment preserves ${action}, but a new phase does not`, async () => {
    const h = await harness("enforce"); let calls = 0;
    createDelegationAssessment(async () => { calls++; return { ...direct, choice: "delegate", probabilities: { delegate: .9, direct: .05, insufficient_information: .05 } }; })(h.pi); await start(h);
    const assess = (phaseId = "same-phase") => tool(h, "delegation_assess").execute("a", input(phaseId), undefined, undefined, h.ctx);
    const work = () => h.handlers.get("tool_call")![0]({ toolName: "read", toolCallId: "read", input: {} }, h.ctx);
    const confirm = () => h.handlers.get("tool_result")![0]({ toolName: "subagent", toolCallId: "launch", input: { agent: "researcher" }, isError: false, details: { runId: "confirmed-run" } }, h.ctx);
    await assess();
    if (action === "refusal") await tool(h, "delegation_refuse").execute("r", { reason: "The parent must preserve the single write boundary." }, undefined, undefined, h.ctx);
    else {
      assert.equal(await h.handlers.get("tool_call")![0]({ toolName: "subagent", toolCallId: "launch", input: { agent: "researcher", task: "Research documentation." } }, h.ctx), undefined);
      if (action === "confirmed-launch") await confirm();
    }
    await assess(); assert.equal(calls, 1, "identical state uses the cached assessment");
    if (action === "pending-launch") {
      assert.equal((await work())?.block, true, "pending is not confirmation");
      await confirm();
    }
    assert.equal(await work(), undefined, "the same recommendation retains its action");
    await assess("new-phase"); assert.equal((await work())?.block, true, "a new phase needs its own action");
  });
}

test("off is explicit opt-in: missing/untrusted config makes no Jev calls", async () => {
  let calls = 0; const h = await harness(); createDelegationAssessment(async () => { calls++; return direct; })(h.pi); await start(h);
  const result = await tool(h, "delegation_assess").execute("a", input(), undefined, undefined, h.ctx);
  assert.equal(result.details.mode, "off"); assert.equal(calls, 0); assert.match(h.notices.join("\n"), /opt-in/);
  const untrusted = await harness("enforce", false); createDelegationAssessment(async () => { calls++; return direct; })(untrusted.pi); await start(untrusted); assert.equal((await tool(untrusted, "delegation_assess").execute("a", input(), undefined, undefined, untrusted.ctx)).details.mode, "off"); assert.equal(calls, 0);
});

test("enforce gates launch before marking it and admits only bounded read/control actions", async () => {
  const h = await harness("enforce"); createDelegationAssessment(async () => direct)(h.pi); await start(h);
  assert.equal((await h.handlers.get("tool_call")![0]({ toolName: "subagent", toolCallId: "launch", input: { agent: "worker", task: "work" } }, h.ctx))?.block, true);
  assert.equal(await h.handlers.get("tool_call")![0]({ toolName: "subagent", toolCallId: "list", input: { action: "list", capabilities: true } }, h.ctx), undefined);
  assert.equal((await h.handlers.get("tool_call")![0]({ toolName: "subagent", toolCallId: "bad", input: { action: "list", agent: "worker", task: "work" } }, h.ctx))?.block, true);
  assert.equal(await h.handlers.get("tool_call")![0]({ toolName: "bg_wait", toolCallId: "wait", input: {} }, h.ctx), undefined);
  await tool(h, "delegation_assess").execute("assessment", input(), undefined, undefined, h.ctx);
  assert.equal(await h.handlers.get("tool_call")![0]({ toolName: "subagent", toolCallId: "launch", input: { agent: "researcher", task: "work" } }, h.ctx), undefined);
  await h.handlers.get("tool_result")![0]({ toolName: "subagent", toolCallId: "launch", input: { agent: "researcher" }, isError: false, details: { ok: false } }, h.ctx);
  assert.equal((await h.handlers.get("tool_call")![0]({ toolName: "bash", toolCallId: "work", input: {} }, h.ctx))?.block, true, "unconfirmed dispatch cannot authorize work");
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

test("growth, session replacement, refusal, and safe output display remain fresh and bounded", async () => {
  const h = await harness("enforce"); createDelegationAssessment(async () => ({ ...direct, choice: "delegate", probabilities: { delegate: .9, direct: .05, insufficient_information: .05 } }))(h.pi); await start(h);
  await tool(h, "delegation_assess").execute("a", input(), undefined, undefined, h.ctx);
  await assert.rejects(() => tool(h, "delegation_refuse").execute("r", { reason: "   " }, undefined, undefined, h.ctx));
  await tool(h, "delegation_refuse").execute("r", { reason: "The parent needs to preserve a single write boundary." }, undefined, undefined, h.ctx);
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

test("persisted refusal data is opaque and excludes assessment and refusal prose", async () => {
  const h = await harness("enforce"); createDelegationAssessment(async () => ({ ...direct, choice: "delegate", probabilities: { delegate: .9, direct: .05, insufficient_information: .05 } }))(h.pi); await start(h);
  const sentinel = "SENTINEL_SUMMARY_AND_ROLE_TEXT";
  await tool(h, "delegation_assess").execute("a", { ...input(), nextStep: `Research ${sentinel}.`, roles: [{ name: "researcher", summary: sentinel, available: true }] }, undefined, undefined, h.ctx);
  await tool(h, "delegation_refuse").execute("r", { reason: `Concrete ${sentinel} reason.` }, undefined, undefined, h.ctx);
  const persisted = JSON.stringify(h.entries);
  assert.equal(persisted.includes(sentinel), false);
  assert.match(persisted, /[a-f0-9]{64}/);
});
