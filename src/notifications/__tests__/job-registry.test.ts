import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TrackedJob } from "../types.js";

function createTrackedJob(overrides: Partial<TrackedJob> = {}): TrackedJob {
  return {
    jobName: "example-job",
    status: "running",
    startedAt: "2026-04-13T00:00:00Z",
    pid: 12345,
    artifacts: {
      outputs: ["/tmp/example-output.json"],
    },
    ...overrides,
  };
}

async function importJobRegistryFresh() {
  const moduleUrl = new URL("../job-registry.js", import.meta.url);
  moduleUrl.searchParams.set("t", `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return import(moduleUrl.href);
}

describe("job-registry", () => {
  it("returns an empty registry when no file exists", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "omx-job-registry-empty-"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;

    try {
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      const registry = await importJobRegistryFresh();
      assert.deepEqual(registry.loadTrackedJobRegistry(), { version: 1, jobs: {} });
      assert.deepEqual(registry.listTrackedJobs(), []);
    } finally {
      if (typeof originalHome === "string") process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (typeof originalUserProfile === "string") process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("upserts, lists, and looks up tracked jobs", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "omx-job-registry-upsert-"));
    const stateDir = join(homeDir, ".omx", "state");
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;

    try {
      await mkdir(stateDir, { recursive: true });
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      const registry = await importJobRegistryFresh();

      const older = createTrackedJob({
        jobName: "older-job",
        startedAt: "2026-04-13T00:00:00Z",
      });
      const newer = createTrackedJob({
        jobName: "newer-job",
        status: "finished",
        startedAt: "2026-04-13T01:00:00Z",
        finishedAt: "2026-04-13T02:00:00Z",
      });

      assert.equal(registry.upsertTrackedJob(older), true);
      assert.equal(registry.upsertTrackedJob(newer), true);

      const loaded = registry.loadTrackedJobRegistry();
      assert.deepEqual(Object.keys(loaded.jobs).sort(), ["newer-job", "older-job"]);
      assert.equal(registry.lookupTrackedJob("older-job")?.pid, 12345);
      assert.deepEqual(registry.listTrackedJobs().map((job: TrackedJob) => job.jobName), [
        "newer-job",
        "older-job",
      ]);

      const fileContent = readFileSync(join(stateDir, "tracked-jobs.json"), "utf-8");
      assert.match(fileContent, /"newer-job"/);
      assert.match(fileContent, /"older-job"/);
    } finally {
      if (typeof originalHome === "string") process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (typeof originalUserProfile === "string") process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("removes tracked jobs cleanly", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "omx-job-registry-remove-"));
    const stateDir = join(homeDir, ".omx", "state");
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;

    try {
      await mkdir(stateDir, { recursive: true });
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      const registry = await importJobRegistryFresh();

      assert.equal(registry.upsertTrackedJob(createTrackedJob()), true);
      assert.equal(registry.removeTrackedJob("example-job"), true);
      assert.equal(registry.lookupTrackedJob("example-job"), null);
      assert.deepEqual(registry.listTrackedJobs(), []);
    } finally {
      if (typeof originalHome === "string") process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (typeof originalUserProfile === "string") process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("fails closed to an empty registry when the file is malformed", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "omx-job-registry-malformed-"));
    const stateDir = join(homeDir, ".omx", "state");
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, "tracked-jobs.json"), "{not-valid-json", "utf-8");
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      const registry = await importJobRegistryFresh();
      assert.deepEqual(registry.loadTrackedJobRegistry(), { version: 1, jobs: {} });
      assert.equal(registry.lookupTrackedJob("anything"), null);
    } finally {
      if (typeof originalHome === "string") process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (typeof originalUserProfile === "string") process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
