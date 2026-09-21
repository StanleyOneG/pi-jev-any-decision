#!/usr/bin/env node
/**
 * Validate a manually recorded baseline/rules-only/Jev comparison.
 * It never calls models, invents a measurement, or treats missing evidence as zero/pass.
 */
import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) throw new Error("Usage: npm run compare -- benchmarks/recording.json");
const [recording, cases] = await Promise.all([
  JSON.parse(await readFile(path, "utf8")),
  JSON.parse(await readFile(new URL("../benchmarks/cases.json", import.meta.url), "utf8")),
]);
const requiredModes = ["baseline", "rules-only", "jev"];
const choices = new Set(["delegate", "direct", "insufficient_information"]);
const expectedCases = [
  ...(cases.frozen ?? []).map((item) => ({ id: item.id, caseSet: "frozen" })),
  ...(cases.holdouts ?? []).map((item) => ({ id: item.id, caseSet: "holdouts" })),
];
const expectedById = new Map(expectedCases.map((item) => [item.id, item]));
const runs = Array.isArray(recording.runs) ? recording.runs : [];
const errors = [];
const isNumberIn = (value, min, max = Infinity) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const keyFor = (run) => `${run.caseId}\u0000${run.mode}`;
const byKey = new Map();

for (const run of runs) {
  const expected = expectedById.get(run?.caseId);
  if (!expected) { errors.push(`${run?.mode ?? "unknown"}/${run?.caseId ?? "unknown"}: unknown benchmark case`); continue; }
  if (!requiredModes.includes(run.mode)) { errors.push(`${run.mode}/${run.caseId}: unknown benchmark mode`); continue; }
  if (run.caseSet !== expected.caseSet) errors.push(`${run.mode}/${run.caseId}: caseSet must be ${expected.caseSet}`);
  const key = keyFor(run);
  if (byKey.has(key)) errors.push(`${run.mode}/${run.caseId}: duplicate recording`);
  else byKey.set(key, run);
  if (!isNumberIn(run.parentContextTokens, 0)) errors.push(`${run.mode}/${run.caseId}: invalid parentContextTokens`);
  if (!isNumberIn(run.allAgentCostUsd, 0)) errors.push(`${run.mode}/${run.caseId}: invalid allAgentCostUsd`);
  if (!isNumberIn(run.allAgentDurationMs, 0)) errors.push(`${run.mode}/${run.caseId}: invalid allAgentDurationMs`);
  if (!isNumberIn(run.quality, 0, 1)) errors.push(`${run.mode}/${run.caseId}: invalid quality (expected 0..1)`);
  if (typeof run.qualityEvidence !== "string" || !run.qualityEvidence.trim()) errors.push(`${run.mode}/${run.caseId}: missing qualityEvidence`);
  if (typeof run.decision !== "string" || !choices.has(run.decision)) errors.push(`${run.mode}/${run.caseId}: missing recorded decision`);
}
for (const expected of expectedCases) for (const mode of requiredModes) {
  if (!byKey.has(`${expected.id}\u0000${mode}`)) errors.push(`missing ${mode}/${expected.id} recording`);
}
if (errors.length) {
  console.error(JSON.stringify({ status: "incomplete", errors }, null, 2));
  process.exitCode = 2;
} else {
  const totals = Object.fromEntries(requiredModes.map((mode) => {
    const modeRuns = expectedCases.map(({ id }) => byKey.get(`${id}\u0000${mode}`));
    return [mode, {
      allAgentCostUsd: modeRuns.reduce((sum, run) => sum + run.allAgentCostUsd, 0),
      allAgentDurationMs: modeRuns.reduce((sum, run) => sum + run.allAgentDurationMs, 0),
      parentContextTokens: modeRuns.reduce((sum, run) => sum + run.parentContextTokens, 0),
    }];
  }));
  const pairedQuality = expectedCases.map(({ id }) => ({
    caseId: id,
    baseline: byKey.get(`${id}\u0000baseline`).quality,
    rulesOnly: byKey.get(`${id}\u0000rules-only`).quality,
    jev: byKey.get(`${id}\u0000jev`).quality,
  }));
  const noQualityRegression = pairedQuality.every((row) => row.rulesOnly >= row.baseline && row.jev >= row.baseline);
  console.log(JSON.stringify({
    status: "recorded-not-claimed",
    totals,
    pairedQuality,
    noQualityRegression,
    withinExperimentalCostBudget: totals.jev.allAgentCostUsd <= totals.baseline.allAgentCostUsd * 1.2,
    note: "Zero is accepted only when explicitly recorded; absent evidence never passes. Quality compares each rules-only and Jev run to its paired baseline case.",
  }, null, 2));
}
