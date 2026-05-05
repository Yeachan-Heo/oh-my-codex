import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

function runOmx(cwd: string, argv: string[], env: NodeJS.ProcessEnv = {}) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, "..", "..", "..");
  const omxBin = join(repoRoot, "dist", "cli", "omx.js");
  return spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      OMX_AUTO_UPDATE: "0",
      OMX_NOTIFY_FALLBACK: "0",
      OMX_HOOK_DERIVED_SIGNALS: "0",
      ...env,
    },
  });
}

describe("cursor/mode e2e", () => {
  it("shows cursor/mode in top-level help", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-cursor-help-"));
    try {
      const result = runOmx(cwd, ["--help"]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /omx cursor\s+Cursor control-plane workflow commands/i);
      assert.match(result.stdout, /omx mode\s+Show or set OMX control mode/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("persists cursor mode and reports it via show", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-mode-switch-"));
    try {
      const setResult = runOmx(cwd, ["mode", "cursor"]);
      assert.equal(setResult.status, 0, setResult.stderr || setResult.stdout);
      assert.match(setResult.stdout, /\[mode\] set to cursor/);

      const showResult = runOmx(cwd, ["mode", "show"]);
      assert.equal(showResult.status, 0, showResult.stderr || showResult.stdout);
      assert.match(showResult.stdout, /\[mode\] cursor/);

      const persisted = await readFile(join(cwd, ".omx", "mode.json"), "utf8");
      assert.match(persisted, /"mode": "cursor"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("runs cursor apply --run through detected cursor-agent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-cursor-run-"));
    const binDir = join(cwd, "bin");
    const logFile = join(cwd, "cursor-agent.log");
    try {
      await mkdir(binDir, { recursive: true });
      const stub = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `printf '%s\\n' "$@" > "${logFile}"`,
      ].join("\n");
      await writeFile(join(binDir, "cursor-agent"), stub, { mode: 0o755 });

      const result = runOmx(
        cwd,
        ["cursor", "apply", "feature-cursor-e2e", "--run", "--model", "gpt-5", "--workspace", "."],
        { PATH: `${binDir}:${process.env.PATH ?? ""}` },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /\[cursor\] apply guidance for feature-cursor-e2e/);
      assert.match(result.stdout, /\[cursor\] running: cursor-agent agent --workspace \./);

      const invokedArgs = await readFile(logFile, "utf8");
      assert.match(invokedArgs, /^agent$/m);
      assert.match(invokedArgs, /^--workspace$/m);
      assert.match(invokedArgs, /^\.$/m);
      assert.match(invokedArgs, /^Implement tasks from openspec\/changes\/feature-cursor-e2e\/tasks\.md\.$/m);
      assert.match(invokedArgs, /^--model$/m);
      assert.match(invokedArgs, /^gpt-5$/m);
      assert.doesNotMatch(invokedArgs, /^--trust$/m);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("forwards --trust to cursor-agent when explicitly set", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-cursor-trust-"));
    const binDir = join(cwd, "bin");
    const logFile = join(cwd, "cursor-agent.log");
    try {
      await mkdir(binDir, { recursive: true });
      const stub = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `printf '%s\\n' "$@" > "${logFile}"`,
      ].join("\n");
      await writeFile(join(binDir, "cursor-agent"), stub, { mode: 0o755 });

      const result = runOmx(
        cwd,
        ["cursor", "apply", "feature-cursor-e2e", "--run", "--trust", "--workspace", "."],
        { PATH: `${binDir}:${process.env.PATH ?? ""}` },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const invokedArgs = await readFile(logFile, "utf8");
      assert.match(invokedArgs, /^--trust$/m);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("ignores missing value after --workspace/--model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-cursor-missing-flag-value-"));
    const binDir = join(cwd, "bin");
    const logFile = join(cwd, "cursor-agent.log");
    try {
      await mkdir(binDir, { recursive: true });
      const stub = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `printf '%s\\n' "$@" > "${logFile}"`,
      ].join("\n");
      await writeFile(join(binDir, "cursor-agent"), stub, { mode: 0o755 });

      const result = runOmx(
        cwd,
        [
          "cursor",
          "apply",
          "feature-cursor-e2e",
          "--run",
          "--workspace",
          "--model",
          "--trust",
        ],
        { PATH: `${binDir}:${process.env.PATH ?? ""}` },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const invokedArgs = await readFile(logFile, "utf8");
      assert.match(invokedArgs, /^--workspace$/m);
      assert.match(invokedArgs, new RegExp(`^${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
      assert.doesNotMatch(invokedArgs, /^--model$/m);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
