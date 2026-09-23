import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDebugLog } from "../src/delegation-assessment/debug.ts";

test("debug stays in target project, serializes concurrent writes and ignores logs in Git", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-debug-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let warnings = 0;
  const log = createDebugLog(cwd, "session-1", () => warnings++);
  await Promise.all(Array.from({ length: 10 }, (_, i) => log.write({ event: "test", i })));
  const rows = (await readFile(log.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map((row) => row.i), Array.from({ length: 10 }, (_, i) => i));
  assert.ok(rows.every((row) => row.cwd === cwd && row.sessionId === "session-1" && row.timestamp));
  assert.equal(await readFile(join(cwd, ".pi/delegation-assessment-debug/.gitignore"), "utf8"), "*\n");
  assert.equal((await stat(log.path)).mode & 0o777, 0o600);
  await createDebugLog(cwd, "session-1", () => warnings++).write({ event: "resume" });
  assert.equal((await readFile(log.path, "utf8")).trim().split("\n").length, 11);
  assert.equal(warnings, 0);
  assert.throws(() => createDebugLog(cwd, "../../escape", () => {}));
});

test("unsafe diagnostic paths warn once without rejecting assessments", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-debug-"));
  const outside = await mkdtemp(join(tmpdir(), "jev-outside-"));
  t.after(async () => { await rm(cwd, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  await mkdir(join(cwd, ".pi"));
  await symlink(outside, join(cwd, ".pi/delegation-assessment-debug"));
  let warnings = 0;
  const log = createDebugLog(cwd, "session-1", () => warnings++);
  await log.write({ event: "test" }); await log.write({ event: "test" });
  assert.equal(warnings, 1);
  await assert.rejects(stat(join(outside, "session-1.jsonl")), { code: "ENOENT" });
});
