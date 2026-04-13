import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jobCommand, jobsCommand } from "../jobs.js";
import type { TrackedJob } from "../../notifications/types.js";

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

describe("jobsCommand", () => {
  it("prints help for --help", async () => {
    const out: string[] = [];
    await jobsCommand(["--help"], {
      stdout: (line) => out.push(line),
      stderr: () => undefined,
      list: () => [],
    });
    assert.match(out.join("\n"), /Usage:\s*\n\s*omx jobs/i);
  });

  it("prints an empty-state message when no jobs exist", async () => {
    const out: string[] = [];
    await jobsCommand([], {
      stdout: (line) => out.push(line),
      stderr: () => undefined,
      list: () => [],
    });
    assert.deepEqual(out, ["No tracked jobs."]);
  });

  it("emits a compact JSON envelope when --json is set", async () => {
    const out: string[] = [];
    await jobsCommand(["--json"], {
      stdout: (line) => out.push(line),
      stderr: () => undefined,
      list: () => [createTrackedJob()],
    });
    assert.deepEqual(out, ['{"jobs":[{"jobName":"example-job","status":"running","startedAt":"2026-04-13T00:00:00Z","pid":12345,"artifacts":{"outputs":["/tmp/example-output.json"]}}]}']);
  });
});

describe("jobCommand", () => {
  it("prints help when no job name is provided", async () => {
    const out: string[] = [];
    await jobCommand([], {
      stdout: (line) => out.push(line),
      stderr: () => undefined,
      get: () => null,
    });
    assert.match(out.join("\n"), /Usage:\s*\n\s*omx jobs/i);
  });

  it("emits compact JSON for a known job with --json", async () => {
    const out: string[] = [];
    await jobCommand(["example-job", "--json"], {
      stdout: (line) => out.push(line),
      stderr: () => undefined,
      get: () => createTrackedJob(),
    });
    assert.deepEqual(out, ['{"jobName":"example-job","status":"running","startedAt":"2026-04-13T00:00:00Z","pid":12345,"artifacts":{"outputs":["/tmp/example-output.json"]}}']);
  });

  it("writes a structured error to stderr and sets exitCode when the job is missing", async () => {
    const err: string[] = [];
    const previousExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      await jobCommand(["missing-job", "--json"], {
        stdout: () => undefined,
        stderr: (line) => err.push(line),
        get: () => null,
      });
      assert.equal(process.exitCode, 1);
      assert.deepEqual(err, ['{"error":"Unknown tracked job: missing-job"}']);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
