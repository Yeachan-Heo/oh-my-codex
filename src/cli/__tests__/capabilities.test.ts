import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const testDir = join(fileURLToPath(import.meta.url), "..");
const repoRoot = join(testDir, "..", "..", "..");
const omxBin = join(repoRoot, "dist", "cli", "omx.js");

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "omx-capabilities-cli-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runOmx(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [omxBin, ...args], { cwd, encoding: "utf8" });
}

async function writeObservations(dir: string, observations: unknown[]): Promise<string> {
  const path = join(dir, "observations.json");
  await writeFile(path, JSON.stringify({ version: 1, kind: "omx_capability_observations", observations }, null, 2), "utf8");
  return path;
}

const SUCCESS_OBSERVATIONS = [
  {
    fixture_id: "project-memory-write-required-arg",
    tool_calls: [{ name: "project_memory_write", arguments: { memory: { note: "capability preflight fixture" } } }],
  },
  {
    fixture_id: "project-memory-read-known-tool",
    tool_calls: [{ name: "project_memory_read", arguments: {} }],
  },
  {
    fixture_id: "tool-restraint-no-call",
    tool_calls: [],
  },
];

function hasFailure(stdout: string, code: string): boolean {
  const parsed = JSON.parse(stdout) as { failures?: Array<{ code?: string }> };
  return parsed.failures?.some((failure) => failure.code === code) ?? false;
}

describe("omx capabilities cli", () => {
  it("routes local help", async () => {
    await withTempDir(async (dir) => {
      const result = runOmx(dir, ["capabilities", "--help"]);

      assert.equal(result.status, 0);
      assert.match(result.stdout, /omx capabilities lock/);
      assert.doesNotMatch(result.stdout, /Launch Codex CLI/);
    });
  });

  it("locks and checks with JSON output", async () => {
    await withTempDir(async (dir) => {
      const lock = runOmx(dir, ["capabilities", "lock", "--json"]);
      assert.equal(lock.status, 0, lock.stderr);
      const lockJson = JSON.parse(lock.stdout);
      assert.equal(lockJson.ok, true);
      assert.match(lockJson.lockfile, /omx-capabilities\.lock\.json$/);

      const check = runOmx(dir, ["capabilities", "check", "--json"]);
      assert.equal(check.status, 0, check.stderr);
      const checkJson = JSON.parse(check.stdout);
      assert.equal(checkJson.ok, true);
      assert.equal(checkJson.observations_checked, false);
    });
  });

  it("checks successful fixture observations", async () => {
    await withTempDir(async (dir) => {
      const lock = runOmx(dir, ["capabilities", "lock", "--json"]);
      assert.equal(lock.status, 0, lock.stderr);
      const observations = await writeObservations(dir, SUCCESS_OBSERVATIONS);

      const check = runOmx(dir, ["capabilities", "check", "--observations", observations, "--require-observations", "--json"]);

      assert.equal(check.status, 0, check.stderr);
      const checkJson = JSON.parse(check.stdout);
      assert.equal(checkJson.ok, true);
      assert.equal(checkJson.observations_checked, true);
    });
  });

  it("exits non-zero for required missing observations", async () => {
    await withTempDir(async (dir) => {
      const lock = runOmx(dir, ["capabilities", "lock", "--json"]);
      assert.equal(lock.status, 0, lock.stderr);

      const check = runOmx(dir, ["capabilities", "check", "--require-observations", "--json"]);

      assert.notEqual(check.status, 0);
      const checkJson = JSON.parse(check.stdout);
      assert.equal(checkJson.ok, false);
      assert.ok(checkJson.failures.some((failure: { code: string }) => failure.code === "observations_missing"));
    });
  });

  it("reports missing required tool arguments", async () => {
    await withTempDir(async (dir) => {
      const lock = runOmx(dir, ["capabilities", "lock", "--json"]);
      assert.equal(lock.status, 0, lock.stderr);
      const observations = await writeObservations(dir, [
        { fixture_id: "project-memory-write-required-arg", tool_calls: [{ name: "project_memory_write", arguments: {} }] },
        SUCCESS_OBSERVATIONS[1],
        SUCCESS_OBSERVATIONS[2],
      ]);

      const check = runOmx(dir, ["capabilities", "check", "--observations", observations, "--json"]);

      assert.notEqual(check.status, 0);
      assert.equal(hasFailure(check.stdout, "missing_required_arg"), true);
    });
  });

  it("reports hallucinated tools", async () => {
    await withTempDir(async (dir) => {
      const lock = runOmx(dir, ["capabilities", "lock", "--json"]);
      assert.equal(lock.status, 0, lock.stderr);
      const observations = await writeObservations(dir, [
        SUCCESS_OBSERVATIONS[0],
        { fixture_id: "project-memory-read-known-tool", tool_calls: [{ name: "imaginary_tool", arguments: {} }] },
        SUCCESS_OBSERVATIONS[2],
      ]);

      const check = runOmx(dir, ["capabilities", "check", "--observations", observations, "--json"]);

      assert.notEqual(check.status, 0);
      assert.equal(hasFailure(check.stdout, "hallucinated_tool"), true);
    });
  });

  it("reports tool-restraint violations", async () => {
    await withTempDir(async (dir) => {
      const lock = runOmx(dir, ["capabilities", "lock", "--json"]);
      assert.equal(lock.status, 0, lock.stderr);
      const observations = await writeObservations(dir, [
        SUCCESS_OBSERVATIONS[0],
        SUCCESS_OBSERVATIONS[1],
        { fixture_id: "tool-restraint-no-call", tool_calls: [{ name: "project_memory_read", arguments: {} }] },
      ]);

      const check = runOmx(dir, ["capabilities", "check", "--observations", observations, "--json"]);

      assert.notEqual(check.status, 0);
      assert.equal(hasFailure(check.stdout, "unexpected_tool_call"), true);
    });
  });
});
