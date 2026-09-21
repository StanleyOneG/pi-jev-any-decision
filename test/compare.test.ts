import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cases = [
  ["small-connected-fix", "frozen"], ["broad-research", "frozen"], ["independent-work", "frozen"], ["tight-dependency", "frozen"],
  ["research-write-conflict", "holdouts"], ["unavailable-role", "holdouts"],
];
function completeRuns() {
  return cases.flatMap(([caseId, caseSet]) => ["baseline", "rules-only", "jev"].map((mode) => ({
    caseId, caseSet, mode, decision: "direct", parentContextTokens: 100, allAgentCostUsd: mode === "jev" ? 1.1 : 1, allAgentDurationMs: 200, quality: 0.9, qualityEvidence: "Independent reviewer recorded the checked result.",
  })));
}
async function recording(runs: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), "jev-compare-")); const path = join(dir, "recording.json"); await writeFile(path, JSON.stringify({ runs })); return path;
}

test("benchmark validator requires the complete unique case-by-mode matrix and emits paired evidence", async () => {
  const path = await recording(completeRuns());
  const { stdout } = await execFileAsync(process.execPath, ["scripts/compare.mjs", path]);
  const report = JSON.parse(stdout);
  assert.equal(report.status, "recorded-not-claimed");
  assert.equal(report.noQualityRegression, true);
  assert.equal(report.withinExperimentalCostBudget, true);
  assert.equal(report.totals.jev.parentContextTokens, 600);
});

test("benchmark validator rejects duplicates, missing rows, and invalid measurements", async () => {
  const runs = completeRuns();
  runs.pop();
  runs.push({ ...runs[0]!, allAgentCostUsd: Number.NaN });
  const path = await recording(runs);
  await assert.rejects(() => execFileAsync(process.execPath, ["scripts/compare.mjs", path]), (error: any) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /duplicate recording|missing jev\/unavailable-role|invalid allAgentCostUsd/);
    return true;
  });
});
