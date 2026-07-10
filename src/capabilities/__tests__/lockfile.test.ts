import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_CAPABILITIES_LOCKFILE,
  buildCapabilitiesLockfile,
  checkCapabilitiesPreflight,
  defaultCapabilitiesLockfilePath,
  writeCapabilitiesLockfile,
} from "../lockfile.js";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "omx-capabilities-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("capabilities lockfile", () => {
  it("uses a repo-visible default lock path", () => {
    assert.equal(defaultCapabilitiesLockfilePath("/repo"), join("/repo", DEFAULT_CAPABILITIES_LOCKFILE));
  });

  it("checks a freshly written lockfile successfully", async () => {
    await withTempDir(async (dir) => {
      const path = defaultCapabilitiesLockfilePath(dir);
      await writeCapabilitiesLockfile(path, await buildCapabilitiesLockfile({ cwd: dir }));

      const result = await checkCapabilitiesPreflight({ cwd: dir });

      assert.equal(result.ok, true);
      assert.equal(result.observations_checked, false);
      assert.deepEqual(result.failures, []);
    });
  });

  it("validates successful observations", async () => {
    await withTempDir(async (dir) => {
      const path = defaultCapabilitiesLockfilePath(dir);
      await writeCapabilitiesLockfile(path, await buildCapabilitiesLockfile({ cwd: dir }));
      await writeFile(
        join(dir, "observations.json"),
        JSON.stringify({
          version: 1,
          kind: "omx_capability_observations",
          observations: [
            { fixture_id: "project-memory-write-required-arg", tool_calls: [{ name: "project_memory_write", arguments: { memory: {} } }] },
            { fixture_id: "project-memory-read-known-tool", tool_calls: [{ name: "project_memory_read", arguments: {} }] },
            { fixture_id: "tool-restraint-no-call", tool_calls: [] },
          ],
        }),
      );

      const result = await checkCapabilitiesPreflight({ cwd: dir, observationsPath: "observations.json", requireObservations: true });

      assert.equal(result.ok, true);
      assert.equal(result.observations_checked, true);
    });
  });

  it("fails observations missing a required argument", async () => {
    await withTempDir(async (dir) => {
      const path = defaultCapabilitiesLockfilePath(dir);
      await writeCapabilitiesLockfile(path, await buildCapabilitiesLockfile({ cwd: dir }));
      await writeFile(
        join(dir, "observations.json"),
        JSON.stringify({
          version: 1,
          kind: "omx_capability_observations",
          observations: [
            { fixture_id: "project-memory-write-required-arg", tool_calls: [{ name: "project_memory_write", arguments: {} }] },
            { fixture_id: "project-memory-read-known-tool", tool_calls: [{ name: "project_memory_read", arguments: {} }] },
            { fixture_id: "tool-restraint-no-call", tool_calls: [] },
          ],
        }),
      );

      const result = await checkCapabilitiesPreflight({ cwd: dir, observationsPath: "observations.json", requireObservations: true });

      assert.equal(result.ok, false);
      assert.ok(result.failures.some((failure) => failure.code === "missing_required_arg"));
    });
  });

  it("fails hallucinated tool observations", async () => {
    await withTempDir(async (dir) => {
      const path = defaultCapabilitiesLockfilePath(dir);
      await writeCapabilitiesLockfile(path, await buildCapabilitiesLockfile({ cwd: dir }));
      await writeFile(
        join(dir, "observations.json"),
        JSON.stringify({
          version: 1,
          kind: "omx_capability_observations",
          observations: [
            { fixture_id: "project-memory-write-required-arg", tool_calls: [{ name: "project_memory_write", arguments: { memory: {} } }] },
            { fixture_id: "project-memory-read-known-tool", tool_calls: [{ name: "imaginary_tool", arguments: {} }] },
            { fixture_id: "tool-restraint-no-call", tool_calls: [] },
          ],
        }),
      );

      const result = await checkCapabilitiesPreflight({ cwd: dir, observationsPath: "observations.json", requireObservations: true });

      assert.equal(result.ok, false);
      assert.ok(result.failures.some((failure) => failure.code === "hallucinated_tool"));
    });
  });

  it("fails tool-restraint observations that call a tool", async () => {
    await withTempDir(async (dir) => {
      const path = defaultCapabilitiesLockfilePath(dir);
      await writeCapabilitiesLockfile(path, await buildCapabilitiesLockfile({ cwd: dir }));
      await writeFile(
        join(dir, "observations.json"),
        JSON.stringify({
          version: 1,
          kind: "omx_capability_observations",
          observations: [
            { fixture_id: "project-memory-write-required-arg", tool_calls: [{ name: "project_memory_write", arguments: { memory: {} } }] },
            { fixture_id: "project-memory-read-known-tool", tool_calls: [{ name: "project_memory_read", arguments: {} }] },
            { fixture_id: "tool-restraint-no-call", tool_calls: [{ name: "project_memory_read", arguments: {} }] },
          ],
        }),
      );

      const result = await checkCapabilitiesPreflight({ cwd: dir, observationsPath: "observations.json", requireObservations: true });

      assert.equal(result.ok, false);
      assert.ok(result.failures.some((failure) => failure.code === "unexpected_tool_call"));
    });
  });

  it("changes configured tool digest when lockfile tool schema drifts", async () => {
    await withTempDir(async (dir) => {
      const path = defaultCapabilitiesLockfilePath(dir);
      const lock = await buildCapabilitiesLockfile({ cwd: dir });
      lock.surfaces.configured_tools.digest = "drift";
      await writeCapabilitiesLockfile(path, lock);

      const result = await checkCapabilitiesPreflight({ cwd: dir });

      assert.equal(result.ok, false);
      assert.ok(result.failures.some((failure) => failure.code === "configured_tool_surface_mismatch"));
      assert.match(await readFile(path, "utf8"), /omx_capabilities_lock/);
    });
  });
});
