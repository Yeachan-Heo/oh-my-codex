import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  DEEP_INTERVIEW_HANDOFF_REJECT_DETAILS,
  evaluateDeepInterviewRalplanHandoffCommand,
  type DeepInterviewHandoffRejectReason,
} from "../../scripts/codex-native-hook.js";

const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), "../../..");
const HANDOFF_MARKER = "<!-- OMX:AUTOPILOT:DEEP-INTERVIEW-RALPLAN-HANDOFF:v1 -->";
const SESSION_ID = "issue-3293-session";

function handoffPayload(cwd: string): Record<string, unknown> {
  return {
    mode: "autopilot",
    active: true,
    current_phase: "ralplan",
    session_id: SESSION_ID,
    workingDirectory: cwd,
    state: {
      deep_interview_gate: {
        status: "complete",
        rationale: "The requirements are complete.",
        handoff_summary: "The interview is ready for planning.",
      },
      handoff_artifacts: {
        deep_interview: ".omx/specs/deep-interview-handoff.md",
      },
    },
  };
}

function handoffCommand(payload: Record<string, unknown>): string {
  return `omx state write --input '${JSON.stringify(payload)}' --json`;
}

function documentedHandoffCommand(): string {
  const skill = readFileSync(join(PROJECT_ROOT, "skills/autopilot/SKILL.md"), "utf-8");
  const markerOffset = skill.indexOf(HANDOFF_MARKER);
  assert.notEqual(markerOffset, -1, "the stable handoff marker must be documented");
  const fence = skill.slice(markerOffset).match(/^<!--[\s\S]*?-->\n```bash\n([\s\S]*?)\n```/);
  assert.ok(fence?.[1], "the marker must immediately precede an executable bash fence");
  return fence[1];
}

async function withFixture(action: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "omx-issue-3293-handoff-"));
  try {
    await mkdir(join(cwd, ".omx", "specs"), { recursive: true });
    await writeFile(join(cwd, ".omx", "specs", "deep-interview-handoff.md"), "# Clarified requirements\n");
    await action(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function assertValueFreeDiagnostic(reason: DeepInterviewHandoffRejectReason, cwd: string): void {
  const detail = DEEP_INTERVIEW_HANDOFF_REJECT_DETAILS[reason];
  assert.ok(detail.length > 0);
  assert.equal(detail.includes(cwd), false);
  assert.equal(detail.includes(SESSION_ID), false);
  assert.equal(detail.includes("deep-interview-handoff.md"), false);
}

describe("issue #3293 Autopilot deep-interview handoff", () => {
  it("admits the exact stable-marked documented handoff command", async () => {
    await withFixture(async (cwd) => {
      const command = documentedHandoffCommand();
      const result = evaluateDeepInterviewRalplanHandoffCommand(cwd, command, SESSION_ID);
      assert.deepEqual(result, { allowed: true });
      assert.match(command, /"current_phase":"ralplan"/);
    });
  });

  const rejectionCases: Array<{
    name: string;
    reason: DeepInterviewHandoffRejectReason;
    command: (cwd: string) => string;
  }> = [
    {
      name: "reports session_id_missing",
      reason: "session_id_missing",
      command: (cwd) => {
        const payload = handoffPayload(cwd);
        delete payload.session_id;
        return handoffCommand(payload);
      },
    },
    {
      name: "reports session_id_mismatch",
      reason: "session_id_mismatch",
      command: (cwd) => handoffCommand({ ...handoffPayload(cwd), session_id: "other-session" }),
    },
    {
      name: "reports session_alias_conflict",
      reason: "session_alias_conflict",
      command: (cwd) => handoffCommand({ ...handoffPayload(cwd), codex_session_id: "other-session" }),
    },
    {
      name: "reports working_directory_missing",
      reason: "working_directory_missing",
      command: (cwd) => {
        const payload = handoffPayload(cwd);
        delete payload.workingDirectory;
        return handoffCommand(payload);
      },
    },
    {
      name: "reports working_directory_mismatch",
      reason: "working_directory_mismatch",
      command: (cwd) => handoffCommand({ ...handoffPayload(cwd), workingDirectory: join(cwd, "other") }),
    },
    {
      name: "reports gate_incomplete",
      reason: "gate_incomplete",
      command: (cwd) => handoffCommand({ ...handoffPayload(cwd), state: {} }),
    },
    {
      name: "reports durable_evidence_missing",
      reason: "durable_evidence_missing",
      command: (cwd) => handoffCommand(handoffPayload(cwd)),
    },
    {
      name: "reports unsafe_transport",
      reason: "unsafe_transport",
      command: (cwd) => `${handoffCommand(handoffPayload(cwd))} $(printf unsafe)`,
    },
    {
      name: "reports artifact_target_not_allowed",
      reason: "artifact_target_not_allowed",
      command: (cwd) => `${handoffCommand(handoffPayload(cwd))} > .omx/specs/allowed.md 2> forbidden.txt`,
    },
  ];

  for (const testCase of rejectionCases) {
    it(testCase.name, async () => {
      if (testCase.reason === "durable_evidence_missing") {
        const cwd = await mkdtemp(join(tmpdir(), "omx-issue-3293-no-evidence-"));
        try {
          const result = evaluateDeepInterviewRalplanHandoffCommand(cwd, testCase.command(cwd), SESSION_ID);
          assert.equal(result.allowed, false);
          assert.equal(result.reason, testCase.reason);
          assertValueFreeDiagnostic(testCase.reason, cwd);
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
        return;
      }
      await withFixture(async (cwd) => {
        const result = evaluateDeepInterviewRalplanHandoffCommand(cwd, testCase.command(cwd), SESSION_ID);
        assert.equal(result.allowed, false);
        assert.equal(result.reason, testCase.reason);
        assertValueFreeDiagnostic(testCase.reason, cwd);
      });
    });
  }

  it("preserves boolean admission parity for representative accepted and rejected commands", async () => {
    await withFixture(async (cwd) => {
      const accepted = handoffCommand(handoffPayload(cwd));
      const rejected = handoffCommand({ ...handoffPayload(cwd), session_id: "other-session" });
      assert.equal(evaluateDeepInterviewRalplanHandoffCommand(cwd, accepted, SESSION_ID).allowed, true);
      assert.equal(evaluateDeepInterviewRalplanHandoffCommand(cwd, rejected, SESSION_ID).allowed, false);
      const documentedCommand = documentedHandoffCommand();
      assert.deepEqual(evaluateDeepInterviewRalplanHandoffCommand(cwd, documentedCommand, SESSION_ID), { allowed: true });
      const unexpectedExpansion = documentedCommand.replace(
        "${PWD:?working directory required}",
        "${UNTRUSTED_WORKING_DIRECTORY}",
      );
      assert.deepEqual(evaluateDeepInterviewRalplanHandoffCommand(cwd, unexpectedExpansion, SESSION_ID), {
        allowed: false,
        reason: "unsafe_transport",
      });
      assert.deepEqual(evaluateDeepInterviewRalplanHandoffCommand(cwd, handoffCommand({
        ...handoffPayload(cwd),
        unexpected: true,
      }), SESSION_ID), {
        allowed: false,
        reason: "unsafe_transport",
      });
    });
  });

  it(
    "keeps the plugin Autopilot skill mirror byte-identical",
    { skip: existsSync(join(PROJECT_ROOT, "dist", "scripts", "sync-plugin-mirror.js")) ? false : "requires the built sync-plugin mirror runner" },
    () => {
      assert.equal(
        readFileSync(join(PROJECT_ROOT, "plugins/oh-my-codex/skills/autopilot/SKILL.md"), "utf-8"),
        readFileSync(join(PROJECT_ROOT, "skills/autopilot/SKILL.md"), "utf-8"),
      );
    },
  );
});
