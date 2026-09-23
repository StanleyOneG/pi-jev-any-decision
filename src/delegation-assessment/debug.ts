import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";

export type DebugEvent = { event: string; [key: string]: unknown };
export type DebugSink = (event: DebugEvent) => Promise<void>;

/** Project-local, opt-in diagnostics. Failures never change assessment policy. */
export function createDebugLog(cwd: string, sessionId: string, warn: () => void): { path: string; write: DebugSink } {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId === "." || sessionId === "..") throw new Error("Unsafe session ID");
  const project = resolve(cwd);
  const directory = join(project, ".pi", "delegation-assessment-debug");
  const path = join(directory, `${sessionId}.jsonl`);
  let failed = false;
  let queue = Promise.resolve();
  async function append(file: string, text: string) {
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe debug file");
      await handle.chmod(0o600);
      await handle.writeFile(text);
    } finally { await handle.close(); }
  }
  const write: DebugSink = (event) => {
    // Capture values before awaiting or switching sessions.
    const line = JSON.stringify({ ...event, timestamp: new Date().toISOString(), cwd: project, sessionId }) + "\n";
    queue = queue.then(async () => {
      if (failed) return;
      try {
        for (const dir of [join(project, ".pi"), directory]) {
          await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
          const stat = await lstat(dir);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe debug directory");
        }
        // Self-contained ignore also protects logs in other target repositories.
        const ignore = join(directory, ".gitignore");
        try {
          const handle = await open(ignore, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await handle.writeFile("*\n"); } finally { await handle.close(); }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        await append(path, line);
      } catch {
        failed = true;
        try { warn(); } catch { /* diagnostics must not disable assessments */ }
      }
    });
    return queue;
  };
  return { path, write };
}
