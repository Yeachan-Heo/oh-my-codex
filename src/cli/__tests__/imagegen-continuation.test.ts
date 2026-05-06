import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseImagegenContinuationArgs,
  prepareImagegenContinuation,
} from "../../imagegen/continuation.js";
import { readPendingExecFollowups } from "../../exec/followup.js";
import { writeSessionStart } from "../../hooks/session.js";

function runOmx(cwd: string, argv: string[]): { status: number | null; stdout: string; stderr: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, "..", "..", "..");
  const omxBin = join(repoRoot, "dist", "cli", "omx.js");
  const result = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      CODEX_HOME: "",
      OMX_MODEL_INSTRUCTIONS_FILE: "",
      OMX_TEAM_WORKER: "",
      OMX_TEAM_STATE_ROOT: "",
      OMX_TEAM_LEADER_CWD: "",
    },
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

describe("omx imagegen continuation", () => {
  it("parses continuation arguments for built-in image generation recovery", () => {
    const parsed = parseImagegenContinuationArgs([
      "continuation",
      "sess-imagegen",
      "--artifact",
      "hairstyles-sheet.png",
      "--generated-dir",
      "C:/Users/USER/.codex/generated_images/sess-imagegen",
      "--work-dir",
      ".omx/image-gen/run",
      "--after",
      "2026-05-06T00:00:00.000Z",
      "--json",
    ]);

    assert.equal(parsed.sessionId, "sess-imagegen");
    assert.equal(parsed.artifactName, "hairstyles-sheet.png");
    assert.equal(parsed.generatedImagesDir, "C:/Users/USER/.codex/generated_images/sess-imagegen");
    assert.equal(parsed.workDir, ".omx/image-gen/run");
    assert.equal(parsed.after, "2026-05-06T00:00:00.000Z");
    assert.equal(parsed.json, true);
  });

  it("writes pending imagegen metadata and queues a Stop-hook follow-up", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-imagegen-continuation-"));
    try {
      const session = await writeSessionStart(wd, "omx-test-imagegen");
      const result = await prepareImagegenContinuation({
        cwd: wd,
        sessionId: session.session_id,
        actor: "visual-ralph",
        artifactName: "hairstyles-sheet.png",
        generatedImagesDir: "C:/Users/USER/.codex/generated_images/omx-test-imagegen",
        workDir: ".omx/image-gen/visible-creation-v1",
        after: "2026-05-06T00:00:00.000Z",
        nowIso: "2026-05-06T00:01:00.000Z",
      });

      const pending = JSON.parse(await readFile(result.pendingPath, "utf-8")) as {
        artifact_name?: string;
        generated_images_dir?: string;
        resume_instruction?: string;
      };
      assert.equal(pending.artifact_name, "hairstyles-sheet.png");
      assert.equal(pending.generated_images_dir, "C:/Users/USER/.codex/generated_images/omx-test-imagegen");
      assert.match(String(pending.resume_instruction), /Resume the interrupted Ralph visual\/imagegen workflow/);

      const followups = await readPendingExecFollowups(wd, session.session_id);
      assert.equal(followups.pending.length, 1);
      assert.equal(followups.pending[0]?.actor, "visual-ralph");
      assert.match(followups.pending[0]?.prompt ?? "", /hairstyles-sheet\.png/);
      assert.match(result.queuePath, /exec-followups\.json$/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("exposes the helper through the CLI", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-imagegen-cli-"));
    try {
      const session = await writeSessionStart(wd, "omx-test-imagegen-cli");
      const result = runOmx(wd, [
        "imagegen",
        "continuation",
        session.session_id,
        "--artifact",
        "fashion-sheet.png",
        "--prompt",
        "Resume imagegen QA for fashion-sheet.png.",
        "--json",
      ]);

      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout) as {
        ok?: boolean;
        pending_path?: string;
        record?: { artifact_name?: string; resume_instruction?: string };
      };
      assert.equal(output.ok, true);
      assert.equal(output.record?.artifact_name, "fashion-sheet.png");
      assert.equal(output.record?.resume_instruction, "Resume imagegen QA for fashion-sheet.png.");
      assert.match(output.pending_path ?? "", /imagegen-pending\.json$/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("queues continuation metadata even when no exec session is accepting input", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-imagegen-no-active-exec-"));
    try {
      const result = runOmx(wd, [
        "imagegen",
        "continuation",
        "plain-app-session",
        "--artifact",
        "eyes-sheet.png",
        "--prompt",
        "Resume imagegen recovery for eyes-sheet.png.",
        "--json",
      ]);

      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout) as {
        ok?: boolean;
        queue_path?: string;
        record?: { session_id?: string };
      };
      assert.equal(output.ok, true);
      assert.equal(output.record?.session_id, "plain-app-session");
      assert.match(output.queue_path ?? "", /plain-app-session.*exec-followups\.json/);

      const followups = await readPendingExecFollowups(wd, "plain-app-session");
      assert.equal(followups.pending.length, 1);
      assert.equal(followups.pending[0]?.prompt, "Resume imagegen recovery for eyes-sheet.png.");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
