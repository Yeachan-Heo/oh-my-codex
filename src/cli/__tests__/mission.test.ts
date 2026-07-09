import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELP } from "../index.js";
import { missionCommand, parseMissionTasks } from "../mission.js";

async function withTempDir<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "omx-mission-"));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("omx mission", () => {
  it("parses simple prompt lists and markdown checklists", () => {
    const tasks = parseMissionTasks([
      "# Mission",
      "",
      "- [ ] Inspect the failure",
      "- [x] Keep the passing behavior",
      "1. Write focused tests",
      "<!-- comment -->",
      "Plain prompt",
    ].join("\n"));

    assert.deepEqual(tasks.map((task) => [task.id, task.source_line, task.prompt]), [
      ["task-001", 3, "Inspect the failure"],
      ["task-002", 4, "Keep the passing behavior"],
      ["task-003", 5, "Write focused tests"],
      ["task-004", 7, "Plain prompt"],
    ]);
  });

  it("writes a dry-run summary and ledger without executing tasks", async () => {
    await withTempDir(async (cwd) => {
      await writeFile(join(cwd, "mission.md"), "- [ ] First prompt\n- [ ] Second prompt\n", "utf-8");
      const out: string[] = [];
      let runCount = 0;

      await missionCommand(["mission.md", "--dry-run", "--slug", "demo"], {
        cwd,
        now: () => new Date("2026-07-06T00:00:00.000Z"),
        stdout: (line) => out.push(line),
        runTask: async () => {
          runCount += 1;
          return 0;
        },
      });

      assert.equal(runCount, 0);
      assert.match(out.join("\n"), /mission planned: demo \(2 tasks\)/);
      const summary = JSON.parse(await readFile(join(cwd, ".omx", "missions", "demo", "summary.json"), "utf-8"));
      assert.equal(summary.status, "planned");
      assert.equal(summary.counts.total, 2);
      assert.equal(summary.counts.planned, 2);
      assert.deepEqual(summary.tasks.map((task: { status: string }) => task.status), ["planned", "planned"]);
      const ledger = await readFile(join(cwd, ".omx", "missions", "demo", "ledger.jsonl"), "utf-8");
      assert.match(ledger, /mission_planned/);
    });
  });

  it("runs tasks sequentially, records failures, and skips remaining tasks by default", async () => {
    await withTempDir(async (cwd) => {
      await writeFile(join(cwd, "mission.md"), "First\nSecond\nThird\n", "utf-8");
      const seen: Array<{ prompt: string; args: string[] }> = [];
      const exits = [0, 7];

      await missionCommand(["run", "mission.md", "--slug", "demo", "--", "--model", "gpt-5"], {
        cwd,
        stdout: () => undefined,
        runTask: async (prompt, args) => {
          seen.push({ prompt, args });
          return exits.shift() ?? 0;
        },
      });

      assert.deepEqual(seen, [
        { prompt: "First", args: ["--model", "gpt-5"] },
        { prompt: "Second", args: ["--model", "gpt-5"] },
      ]);
      const summary = JSON.parse(await readFile(join(cwd, ".omx", "missions", "demo", "summary.json"), "utf-8"));
      assert.equal(summary.status, "failed");
      assert.deepEqual(summary.tasks.map((task: { status: string }) => task.status), ["passed", "failed", "skipped"]);
      assert.equal(summary.counts.failed, 1);
      assert.equal(summary.counts.skipped, 1);
      process.exitCode = undefined;
    });
  });

  it("reports status from an existing summary by file or slug", async () => {
    await withTempDir(async (cwd) => {
      await writeFile(join(cwd, "mission.md"), "First\nSecond\n", "utf-8");
      await missionCommand(["mission.md", "--dry-run", "--slug", "demo"], { cwd, stdout: () => undefined });

      const byFile: string[] = [];
      await missionCommand(["status", "mission.md", "--slug", "demo"], { cwd, stdout: (line) => byFile.push(line) });
      assert.match(byFile.join("\n"), /mission status: demo \[planned\]/);
      assert.match(byFile.join("\n"), /\[planned\] task-001 line 1: First/);

      const bySlug: string[] = [];
      await missionCommand(["status", "demo"], { cwd, stdout: (line) => bySlug.push(line) });
      assert.match(bySlug.join("\n"), /summary: .*\.omx.*missions.*demo.*summary\.json/);
    });
  });

  it("reports invalid summary JSON as a mission error", async () => {
    await withTempDir(async (cwd) => {
      const summaryPath = join(cwd, "summary.json");
      await writeFile(summaryPath, "{not json", "utf-8");

      const err: string[] = [];
      await missionCommand(["status", "demo", "--summary", summaryPath], {
        cwd,
        stdout: () => undefined,
        stderr: (line) => err.push(line),
      });

      assert.deepEqual(err, [`[mission] Invalid mission summary at ${summaryPath}.`]);
      assert.equal(process.exitCode, 1);
      process.exitCode = undefined;
    });
  });

  it("resumes durable summaries by skipping passed tasks and retrying stale running work", async () => {
    await withTempDir(async (cwd) => {
      await writeFile(join(cwd, "mission.md"), "First\nSecond\nThird\n", "utf-8");
      await missionCommand(["run", "mission.md", "--slug", "demo", "--continue-on-error"], {
        cwd,
        stdout: () => undefined,
        runTask: async (prompt) => prompt === "First" ? 0 : 9,
      });
      process.exitCode = undefined;

      const summaryPath = join(cwd, ".omx", "missions", "demo", "summary.json");
      const interrupted = JSON.parse(await readFile(summaryPath, "utf-8"));
      interrupted.status = "running";
      interrupted.completed_at = undefined;
      interrupted.tasks[1].status = "running";
      interrupted.tasks[1].completed_at = undefined;
      await writeFile(summaryPath, `${JSON.stringify(interrupted, null, 2)}\n`, "utf-8");

      const seen: string[] = [];
      await missionCommand(["resume", "mission.md", "--slug", "demo", "--continue-on-error"], {
        cwd,
        stdout: () => undefined,
        runTask: async (prompt) => {
          seen.push(prompt);
          return 0;
        },
      });

      assert.deepEqual(seen, ["Second", "Third"]);
      const resumed = JSON.parse(await readFile(summaryPath, "utf-8"));
      assert.equal(resumed.status, "passed");
      assert.deepEqual(resumed.tasks.map((task: { status: string }) => task.status), ["passed", "passed", "passed"]);
      const ledger = await readFile(join(cwd, ".omx", "missions", "demo", "ledger.jsonl"), "utf-8");
      assert.match(ledger, /mission_resumed/);
    });
  });

  it("reruns one requested task from the existing summary", async () => {
    await withTempDir(async (cwd) => {
      await writeFile(join(cwd, "mission.md"), "First\nSecond\nThird\n", "utf-8");
      await missionCommand(["run", "mission.md", "--slug", "demo", "--continue-on-error"], {
        cwd,
        stdout: () => undefined,
        runTask: async (prompt) => prompt === "Second" ? 4 : 0,
      });
      process.exitCode = undefined;

      const seen: string[] = [];
      await missionCommand(["rerun", "mission.md", "--slug", "demo", "--task", "task-002"], {
        cwd,
        stdout: () => undefined,
        runTask: async (prompt) => {
          seen.push(prompt);
          return 0;
        },
      });

      assert.deepEqual(seen, ["Second"]);
      const summary = JSON.parse(await readFile(join(cwd, ".omx", "missions", "demo", "summary.json"), "utf-8"));
      assert.equal(summary.status, "passed");
      assert.deepEqual(summary.tasks.map((task: { status: string }) => task.status), ["passed", "passed", "passed"]);
    });
  });

  it("marks blocked and needs-human-review tasks in status counts", async () => {
    await withTempDir(async (cwd) => {
      await writeFile(join(cwd, "mission.md"), "First\nSecond\nThird\n", "utf-8");
      await missionCommand(["run", "mission.md", "--slug", "demo"], {
        cwd,
        stdout: () => undefined,
        runTask: async () => 0,
      });

      await missionCommand(["mark", "demo", "--task", "task-002", "--status", "blocked"], { cwd, stdout: () => undefined });
      await missionCommand(["mark", "demo", "--task", "task-003", "--status", "needs-human-review"], { cwd, stdout: () => undefined });

      const out: string[] = [];
      await missionCommand(["status", "demo"], { cwd, stdout: (line) => out.push(line) });
      const status = out.join("\n");
      assert.match(status, /mission status: demo \[blocked\]/);
      assert.match(status, /1\/3 passed, 0 failed, 0 skipped, 1 blocked, 1 needs-human-review, 0 planned/);
      assert.match(status, /\[blocked\] task-002 line 2: Second/);
      assert.match(status, /\[needs-human-review\] task-003 line 3: Third/);

      const summary = JSON.parse(await readFile(join(cwd, ".omx", "missions", "demo", "summary.json"), "utf-8"));
      assert.equal(summary.status, "blocked");
      assert.equal(summary.counts.blocked, 1);
      assert.equal(summary.counts["needs-human-review"], 1);
      const ledger = await readFile(join(cwd, ".omx", "missions", "demo", "ledger.jsonl"), "utf-8");
      assert.match(ledger, /task_marked/);
    });
  });

  it("leaves operator-marked tasks on resume and allows explicit rerun", async () => {
    await withTempDir(async (cwd) => {
      await writeFile(join(cwd, "mission.md"), "First\nSecond\nThird\n", "utf-8");
      await missionCommand(["run", "mission.md", "--slug", "demo"], {
        cwd,
        stdout: () => undefined,
        runTask: async () => 0,
      });
      await missionCommand(["mark", "mission.md", "--slug", "demo", "--task", "task-002", "--status", "blocked"], { cwd, stdout: () => undefined });
      await missionCommand(["mark", "mission.md", "--slug", "demo", "--task", "task-003", "--status", "needs-human-review"], { cwd, stdout: () => undefined });

      const resumedPrompts: string[] = [];
      await missionCommand(["resume", "mission.md", "--slug", "demo"], {
        cwd,
        stdout: () => undefined,
        runTask: async (prompt) => {
          resumedPrompts.push(prompt);
          return 0;
        },
      });
      assert.deepEqual(resumedPrompts, []);
      assert.equal(process.exitCode, 1);
      process.exitCode = undefined;

      const rerunPrompts: string[] = [];
      await missionCommand(["rerun", "mission.md", "--slug", "demo", "--task", "task-002"], {
        cwd,
        stdout: () => undefined,
        runTask: async (prompt) => {
          rerunPrompts.push(prompt);
          return 0;
        },
      });
      assert.deepEqual(rerunPrompts, ["Second"]);

      const summary = JSON.parse(await readFile(join(cwd, ".omx", "missions", "demo", "summary.json"), "utf-8"));
      assert.equal(summary.status, "needs-human-review");
      assert.deepEqual(summary.tasks.map((task: { status: string }) => task.status), ["passed", "passed", "needs-human-review"]);
      assert.equal(process.exitCode, 1);
      process.exitCode = undefined;
    });
  });

  it("documents mission in top-level help", () => {
    assert.match(HELP, /omx mission <file>/);
    assert.match(HELP, /prompt\/checklist file sequentially through omx exec/);
  });
});
