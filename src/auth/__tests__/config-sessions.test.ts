import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAuthConfig } from "../config.js";
import { findLatestRolloutSession } from "../sessions.js";

describe("auth config", () => {
  it("merges project keys over user keys per absent key fallback", async () => {
    const home = await mkdtemp(join(tmpdir(), "omx-auth-config-home-"));
    const wd = await mkdtemp(join(tmpdir(), "omx-auth-config-wd-"));
    try {
      await mkdir(join(home, ".omx"), { recursive: true });
      await writeFile(join(home, ".omx", "config.toml"), '[omx.auth]\nrotation = "priority"\npriority = ["user"]\nquota_patterns = ["custom-quota"]\n');
      await mkdir(join(wd, ".omx"), { recursive: true });
      await writeFile(join(wd, ".omx", "config.toml"), '[omx.auth]\npriority = ["project"]\n');
      const config = await readAuthConfig(wd, home);
      assert.equal(config.rotation, "priority");
      assert.deepEqual(config.priority, ["project"]);
      assert.deepEqual(config.quotaPatterns, ["custom-quota"]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe("Codex rollout session heuristic", () => {
  it("returns newest rollout id by mtime", async () => {
    const home = await mkdtemp(join(tmpdir(), "omx-auth-sessions-"));
    try {
      const dir = join(home, "sessions", "2026", "05", "24");
      await mkdir(dir, { recursive: true });
      const oldPath = join(dir, "rollout-old.jsonl");
      const newPath = join(dir, "rollout-new.jsonl");
      await writeFile(oldPath, "{}\n");
      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeFile(newPath, "{}\n");
      const latest = await findLatestRolloutSession(home);
      assert.equal(latest?.id, "new");
      assert.equal(latest?.path, newPath);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
