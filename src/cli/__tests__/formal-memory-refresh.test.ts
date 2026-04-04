import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveFormalMemoryRefreshPlan,
  resolveFormalMemoryRefreshScript,
  scheduleFormalMemoryRefreshOnExit,
} from "../index.js";

async function createRefreshFixture(): Promise<{
  root: string;
  memoryRoot: string;
  scriptPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "omx-formal-refresh-"));
  const memoryRoot = join(root, "memory");
  const scriptPath = join(root, "scripts", "refresh_memory.py");
  await mkdir(memoryRoot, { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(scriptPath, "#!/usr/bin/env python3\n", "utf-8");
  return { root, memoryRoot, scriptPath };
}

describe("formal memory refresh bridge", () => {
  it("prefers explicit refresh script override", () => {
    const env = {
      OMX_EXTERNAL_MEMORY_REFRESH_SCRIPT: "/tmp/custom-refresh.py",
      OMX_EXTERNAL_MEMORY_ROOT: "/tmp/ignored-memory-root",
    } satisfies NodeJS.ProcessEnv;
    assert.equal(resolveFormalMemoryRefreshScript(env), "/tmp/custom-refresh.py");
  });

  it("infers the refresh script from the external memory root sibling scripts directory", async () => {
    const fixture = await createRefreshFixture();
    try {
      const env = {
        OMX_EXTERNAL_MEMORY_ROOT: fixture.memoryRoot,
      } satisfies NodeJS.ProcessEnv;
      assert.equal(resolveFormalMemoryRefreshScript(env), fixture.scriptPath);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps refresh disabled until strict mode and refresh-on-exit are both enabled", () => {
    const disabledStrict = resolveFormalMemoryRefreshPlan("/repo", "session-1", {});
    assert.equal(disabledStrict.enabled, false);
    assert.equal(disabledStrict.reason, "strict_mode_disabled");

    const disabledRefresh = resolveFormalMemoryRefreshPlan("/repo", "session-1", {
      OMX_STRICT_MEMORY_MODE: "1",
    });
    assert.equal(disabledRefresh.enabled, false);
    assert.equal(disabledRefresh.reason, "refresh_on_exit_disabled");
  });

  it("skips the refresh bridge for team worker processes", async () => {
    const fixture = await createRefreshFixture();
    try {
      const plan = resolveFormalMemoryRefreshPlan("/repo", "session-2", {
        OMX_STRICT_MEMORY_MODE: "1",
        OMX_STRICT_MEMORY_REFRESH_ON_EXIT: "1",
        OMX_EXTERNAL_MEMORY_ROOT: fixture.memoryRoot,
        OMX_TEAM_WORKER: "alpha/worker-1",
      });
      assert.equal(plan.enabled, false);
      assert.equal(plan.reason, "team_worker_process");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("spawns a detached refresh process for leader or standalone sessions", async () => {
    const fixture = await createRefreshFixture();
    try {
      let captured:
        | {
            command: string;
            args: readonly string[];
            options: {
              cwd: string;
              env: NodeJS.ProcessEnv;
              detached: boolean;
              stdio: "ignore";
            };
          }
        | undefined;
      let unrefCalled = false;

      const result = scheduleFormalMemoryRefreshOnExit(
        "/repo",
        "session-3",
        {
          OMX_STRICT_MEMORY_MODE: "1",
          OMX_STRICT_MEMORY_REFRESH_ON_EXIT: "1",
          OMX_EXTERNAL_MEMORY_ROOT: fixture.memoryRoot,
          OMX_EXTERNAL_MEMORY_REFRESH_PYTHON: "python3.12",
        },
        ((command: string, args: readonly string[], options: {
          cwd: string;
          env: NodeJS.ProcessEnv;
          detached: boolean;
          stdio: "ignore";
        }) => {
          captured = { command, args, options };
          return {
            unref() {
              unrefCalled = true;
            },
          };
        }) as never,
      );

      assert.equal(result.scheduled, true);
      assert.equal(result.reason, "scheduled");
      assert.equal(captured?.command, "python3.12");
      assert.deepEqual(captured?.args, [fixture.scriptPath, "--workspace-root", "/repo"]);
      assert.equal(captured?.options.cwd, "/repo");
      assert.equal(captured?.options.detached, true);
      assert.equal(captured?.options.stdio, "ignore");
      assert.equal(captured?.options.env.OMX_EXTERNAL_MEMORY_REFRESH_SOURCE, "omx-postlaunch");
      assert.equal(captured?.options.env.OMX_EXTERNAL_MEMORY_REFRESH_SESSION_ID, "session-3");
      assert.equal(unrefCalled, true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports spawn failures without throwing", async () => {
    const fixture = await createRefreshFixture();
    try {
      const result = scheduleFormalMemoryRefreshOnExit(
        "/repo",
        "session-4",
        {
          OMX_STRICT_MEMORY_MODE: "1",
          OMX_STRICT_MEMORY_REFRESH_ON_EXIT: "1",
          OMX_EXTERNAL_MEMORY_ROOT: fixture.memoryRoot,
        },
        (() => {
          throw new Error("boom");
        }) as never,
      );

      assert.equal(result.scheduled, false);
      assert.match(result.reason, /^spawn_failed:boom$/);
      assert.equal(result.plan.enabled, true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
