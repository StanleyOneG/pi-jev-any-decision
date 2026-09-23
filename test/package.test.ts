import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

test("checkout does not auto-load a duplicate assessment extension", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  await assert.rejects(access(join(root, ".pi/extensions/delegation-assessment")), { code: "ENOENT" });
});

// Exercise the same package-resource discovery used by CLI -e, without network
// access or loading the developer's settings. Git installs use this manifest too.
test("package loading from another project exposes only the assessment entrypoint", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-package-"));
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const manager = new DefaultPackageManager({
      cwd,
      agentDir: join(cwd, "agent"),
      settingsManager: SettingsManager.inMemory(),
    });
    const resources = await manager.resolveExtensionSources([root], { temporary: true });
    assert.deepEqual(resources.extensions.map(({ path, enabled }) => ({ path, enabled })), [
      { path: join(root, "src/delegation-assessment/index.ts"), enabled: true },
    ]);
    assert.deepEqual(resources.skills, []);
    assert.deepEqual(resources.prompts, []);
    assert.deepEqual(resources.themes, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
