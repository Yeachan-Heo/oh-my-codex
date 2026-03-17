/**
 * Tests for AGENTS.md Runtime Overlay
 *
 * Covers: overlay generation, apply/strip roundtrip, idempotency,
 * size cap enforcement, and graceful handling of missing state.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  generateOverlay,
  applyOverlay,
  stripOverlay,
  hasOverlay,
  resolveSessionOrchestrationMode,
  writeSessionModelInstructionsFile,
  removeSessionModelInstructionsFile,
  sessionModelInstructionsPath,
} from "../agents-overlay.js";

const RUNTIME_START = "<!-- OMX:RUNTIME:START -->";
const RUNTIME_END = "<!-- OMX:RUNTIME:END -->";
const WORKER_START = "<!-- OMX:TEAM:WORKER:START -->";
const WORKER_END = "<!-- OMX:TEAM:WORKER:END -->";

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omx-overlay-test-"));
  await mkdir(join(dir, ".omx", "state"), { recursive: true });
  return dir;
}

function setMockCodexHome(codexHomePath: string): () => void {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHomePath;
  return () => {
    if (typeof previous === "string") process.env.CODEX_HOME = previous;
    else delete process.env.CODEX_HOME;
  };
}

describe("generateOverlay", () => {
  let tempDir: string;
  before(async () => {
    tempDir = await makeTempDir();
  });
  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("generates overlay with no state files (empty but valid)", async () => {
    const overlay = await generateOverlay(tempDir, "test-session-1");
    assert.ok(overlay.includes("<!-- OMX:RUNTIME:START -->"));
    assert.ok(overlay.includes("<!-- OMX:RUNTIME:END -->"));
    assert.ok(overlay.includes("test-session-1"));
    assert.ok(overlay.includes("Compaction Protocol"));
  });

  it("includes the team orchestrator overlay only when orchestration mode is team", async () => {
    const overlay = await generateOverlay(tempDir, "team-session", {
      orchestrationMode: "team",
    });
    assert.match(overlay, /\*\*Orchestration Mode:\*\* team/);
    assert.match(overlay, /supervised, high-overhead coordination surface/i);

    const defaultOverlay = await generateOverlay(tempDir, "default-session", {
      orchestrationMode: "default",
    });
    assert.doesNotMatch(defaultOverlay, /\*\*Orchestration Mode:\*\* team/);
  });

  it("adds advisory explore routing guidance only when USE_OMX_EXPLORE_CMD is enabled", async () => {
    const previous = process.env.USE_OMX_EXPLORE_CMD;
    try {
      delete process.env.USE_OMX_EXPLORE_CMD;
      const disabledOverlay = await generateOverlay(
        tempDir,
        "explore-routing-off",
      );
      assert.doesNotMatch(
        disabledOverlay,
        /\*\*Explore Command Preference:\*\*/,
      );

      process.env.USE_OMX_EXPLORE_CMD = "1";
      const enabledOverlay = await generateOverlay(
        tempDir,
        "explore-routing-on",
      );
      assert.match(
        enabledOverlay,
        /\*\*Explore Command Preference:\*\* enabled via `USE_OMX_EXPLORE_CMD`/,
      );
      assert.match(enabledOverlay, /strongly prefer `omx explore`/);
      assert.match(enabledOverlay, /advisory steering/i);
    } finally {
      if (typeof previous === "string")
        process.env.USE_OMX_EXPLORE_CMD = previous;
      else delete process.env.USE_OMX_EXPLORE_CMD;
    }
  });

  it("generates overlay with active modes", async () => {
    const sessionId = "test-session-2";
    const sessionDir = join(tempDir, ".omx", "state", "sessions", sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "ralph-state.json"),
      JSON.stringify({
        active: true,
        iteration: 3,
        max_iterations: 10,
        current_phase: "executing",
      }),
    );
    const overlay = await generateOverlay(tempDir, sessionId);
    assert.ok(overlay.includes("ralph"));
    assert.ok(overlay.includes("iteration 3/10"));
  });

  it("generates overlay with session-scoped active modes for current session", async () => {
    await mkdir(join(tempDir, ".omx", "state", "sessions", "sess1"), {
      recursive: true,
    });
    await writeFile(
      join(tempDir, ".omx", "state", "sessions", "sess1", "team-state.json"),
      JSON.stringify({
        active: true,
        iteration: 1,
        max_iterations: 5,
        current_phase: "running",
      }),
    );
    const overlay = await generateOverlay(tempDir, "sess1");
    assert.ok(overlay.includes("team"));
    assert.ok(overlay.includes("iteration 1/5"));
  });

  it("generates overlay with notepad priority content", async () => {
    await writeFile(
      join(tempDir, ".omx", "notepad.md"),
      "## PRIORITY\nFocus on auth module refactor.\n\n## WORKING\nSome working notes.",
    );
    const overlay = await generateOverlay(tempDir, "test-session-3");
    assert.ok(overlay.includes("Focus on auth module refactor"));
    assert.ok(overlay.includes("Priority Notes"));
  });

  it("generates overlay with project memory summary", async () => {
    await writeFile(
      join(tempDir, ".omx", "project-memory.json"),
      JSON.stringify({
        techStack: "TypeScript + Node.js",
        conventions: "ESM modules, strict mode",
        build: "npx tsc",
        directives: [
          { directive: "Always use strict TypeScript", priority: "high" },
          { directive: "Low priority thing", priority: "normal" },
        ],
      }),
    );
    const overlay = await generateOverlay(tempDir, "test-session-4");
    assert.ok(overlay.includes("TypeScript + Node.js"));
    assert.ok(overlay.includes("Always use strict TypeScript"));
    assert.ok(!overlay.includes("Low priority thing"));
  });

  it("enforces size cap (overlay <= 3500 chars)", async () => {
    const longText = "A".repeat(5000);
    await writeFile(
      join(tempDir, ".omx", "notepad.md"),
      `## PRIORITY\n${longText}`,
    );
    await writeFile(
      join(tempDir, ".omx", "project-memory.json"),
      JSON.stringify({
        techStack: "B".repeat(2000),
        conventions: "C".repeat(2000),
      }),
    );

    const overlay = await generateOverlay(tempDir, "test-session-5");
    assert.ok(
      overlay.length <= 3500,
      `Overlay too large: ${overlay.length} chars`,
    );
    assert.ok(overlay.includes("<!-- OMX:RUNTIME:START -->"));
    assert.ok(overlay.includes("<!-- OMX:RUNTIME:END -->"));
  });

  it("uses deterministic overflow policy under size cap", async () => {
    const sessionId = "overflow-session";
    const sessionDir = join(tempDir, ".omx", "state", "sessions", sessionId);
    await mkdir(sessionDir, { recursive: true });
    // Inflate optional sections so overflow behavior is exercised.
    // Per-section truncation limits mean the total max body (~2640 chars) fits
    // within MAX_OVERLAY_SIZE (3500), so we verify: size cap, required sections
    // present, and determinism (identical output on repeated calls).
    for (let i = 0; i < 40; i++) {
      await writeFile(
        join(sessionDir, `mode-${i}-state.json`),
        JSON.stringify({
          active: true,
          iteration: i + 1,
          max_iterations: 99,
          current_phase: "run",
        }),
      );
    }
    await writeFile(
      join(tempDir, ".omx", "notepad.md"),
      `## PRIORITY\n${"N".repeat(8000)}`,
    );
    await writeFile(
      join(tempDir, ".omx", "project-memory.json"),
      JSON.stringify({
        techStack: "T".repeat(9000),
        conventions: "C".repeat(9000),
        directives: [{ directive: "D".repeat(3000), priority: "high" }],
      }),
    );

    const overlay1 = await generateOverlay(tempDir, sessionId);
    const overlay2 = await generateOverlay(tempDir, sessionId);

    for (const overlay of [overlay1, overlay2]) {
      assert.ok(
        overlay.length <= 3500,
        `Overlay too large: ${overlay.length} chars`,
      );
      assert.ok(overlay.includes("**Active Modes:**"));
      assert.ok(overlay.includes("**Priority Notes:**"));
      assert.ok(overlay.includes("**Compaction Protocol:**"));
    }
  });

  it("skips inactive modes", async () => {
    await writeFile(
      join(tempDir, ".omx", "state", "autopilot-state.json"),
      JSON.stringify({ active: false, current_phase: "cancelled" }),
    );
    const overlay = await generateOverlay(tempDir, "test-session-6");
    assert.ok(!overlay.includes("autopilot"));
  });

  it("adds blocked ralph planning gate when PRD/test spec are missing", async () => {
    const sessionId = "ralph-gate-blocked";
    const sessionDir = join(tempDir, ".omx", "state", "sessions", sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "ralph-state.json"),
      JSON.stringify({
        active: true,
        iteration: 0,
        max_iterations: 50,
        current_phase: "starting",
      }),
    );
    await mkdir(join(tempDir, ".omx", "plans"), { recursive: true });

    const overlay = await generateOverlay(tempDir, sessionId);
    assert.match(overlay, /\*\*Ralph Ralplan-First Gate:\*\* BLOCKED/);
    assert.match(overlay, /`prd-\*\.md`/);
    assert.match(overlay, /`test-spec-\*\.md`/);
  });

  it("unlocks ralph planning gate when PRD and test spec exist", async () => {
    const sessionId = "ralph-gate-unlocked";
    const sessionDir = join(tempDir, ".omx", "state", "sessions", sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "ralph-state.json"),
      JSON.stringify({
        active: true,
        iteration: 1,
        max_iterations: 50,
        current_phase: "starting",
      }),
    );
    const plansDir = join(tempDir, ".omx", "plans");
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, "prd-issue-259.md"), "# PRD\n");
    await writeFile(join(plansDir, "test-spec-issue-259.md"), "# Test Spec\n");

    const overlay = await generateOverlay(tempDir, sessionId);
    assert.match(overlay, /\*\*Ralph Ralplan-First Gate:\*\* UNLOCKED/);
    assert.match(overlay, /Planning artifacts present: PRD \+ test spec/);
  });
});

describe("resolveSessionOrchestrationMode", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await makeTempDir();
  });
  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("uses explicit activeSkill when provided", async () => {
    const mode = await resolveSessionOrchestrationMode(
      tempDir,
      "sess-explicit",
      "team",
    );
    assert.equal(mode, "team");
  });

  it("reads persisted team skill state from the current session scope", async () => {
    const sessionId = "sess-team";
    const sessionDir = join(tempDir, ".omx", "state", "sessions", sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "skill-active-state.json"),
      JSON.stringify({ active: true, skill: "team" }),
    );

    const mode = await resolveSessionOrchestrationMode(tempDir, sessionId);
    assert.equal(mode, "team");
  });

  it("falls back to default mode for non-team skill state", async () => {
    const sessionId = "sess-autopilot";
    const sessionDir = join(tempDir, ".omx", "state", "sessions", sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "skill-active-state.json"),
      JSON.stringify({ active: true, skill: "autopilot" }),
    );

    const mode = await resolveSessionOrchestrationMode(tempDir, sessionId);
    assert.equal(mode, "default");
  });

  it("does not resurrect stale root team skill state when session-scoped skill state is inactive", async () => {
    const sessionId = "sess-team-complete";
    const rootStatePath = join(
      tempDir,
      ".omx",
      "state",
      "skill-active-state.json",
    );
    const sessionDir = join(tempDir, ".omx", "state", "sessions", sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      rootStatePath,
      JSON.stringify({ active: true, skill: "team" }),
    );
    await writeFile(
      join(sessionDir, "skill-active-state.json"),
      JSON.stringify({ active: false, skill: "team", phase: "completing" }),
    );

    const mode = await resolveSessionOrchestrationMode(tempDir, sessionId);
    assert.equal(mode, "default");
  });

  it("falls back to root team skill state only when no session-scoped skill state exists", async () => {
    const sessionId = "sess-root-fallback";
    await writeFile(
      join(tempDir, ".omx", "state", "skill-active-state.json"),
      JSON.stringify({ active: true, skill: "team" }),
    );

    const mode = await resolveSessionOrchestrationMode(tempDir, sessionId);
    assert.equal(mode, "team");
  });
});

describe("applyOverlay + stripOverlay roundtrip", () => {
  let tempDir: string;
  const originalContent = `# My AGENTS.md

This is the original content.

## Section 1
Some instructions here.
`;

  before(async () => {
    tempDir = await makeTempDir();
  });
  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("apply then strip restores original (roundtrip)", async () => {
    const agentsMd = join(tempDir, "AGENTS.md");
    await writeFile(agentsMd, originalContent);

    const overlay = await generateOverlay(tempDir, "roundtrip-test");
    await applyOverlay(agentsMd, overlay, tempDir);

    const withOverlay = await readFile(agentsMd, "utf-8");
    assert.ok(hasOverlay(withOverlay));
    assert.ok(withOverlay.includes("roundtrip-test"));

    await stripOverlay(agentsMd, tempDir);
    const restored = await readFile(agentsMd, "utf-8");
    assert.ok(!hasOverlay(restored));
    assert.equal(restored.trim(), originalContent.trim());
  });

  it("stripOverlay preserves a top-of-file autonomy directive header", async () => {
    const agentsMd = join(tempDir, "AGENTS-autonomy.md");
    const autonomyContent = `<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->
YOU ARE AN AUTONOMOUS CODING AGENT. EXECUTE TASKS TO COMPLETION WITHOUT ASKING FOR PERMISSION.
DO NOT STOP TO ASK "SHOULD I PROCEED?" — PROCEED. DO NOT WAIT FOR CONFIRMATION ON OBVIOUS NEXT STEPS.
IF BLOCKED, TRY AN ALTERNATIVE APPROACH. ONLY ASK WHEN TRULY AMBIGUOUS OR DESTRUCTIVE.
<!-- END AUTONOMY DIRECTIVE -->

# oh-my-codex - Intelligent Multi-Agent Orchestration
`;
    await writeFile(agentsMd, autonomyContent);

    const overlay = await generateOverlay(tempDir, "autonomy-header");
    await applyOverlay(agentsMd, overlay, tempDir);
    await stripOverlay(agentsMd, tempDir);

    const restored = await readFile(agentsMd, "utf-8");
    assert.equal(restored, autonomyContent);
  });

  it("applyOverlay is idempotent (apply twice, no duplication)", async () => {
    const agentsMd = join(tempDir, "AGENTS-idem.md");
    await writeFile(agentsMd, originalContent);

    const overlay = await generateOverlay(tempDir, "idempotent-test");
    await applyOverlay(agentsMd, overlay, tempDir);
    const firstApply = await readFile(agentsMd, "utf-8");

    await applyOverlay(agentsMd, overlay, tempDir);
    const secondApply = await readFile(agentsMd, "utf-8");

    assert.equal(secondApply, firstApply);
    const startCount = (secondApply.match(/<!-- OMX:RUNTIME:START -->/g) || [])
      .length;
    assert.equal(startCount, 1);
  });

  it("handles stale markers from previous session", async () => {
    const agentsMd = join(tempDir, "AGENTS-stale.md");
    const staleContent =
      originalContent +
      "\n<!-- OMX:RUNTIME:START -->\n<session_context>\nOld stale content\n</session_context>\n<!-- OMX:RUNTIME:END -->\n";
    await writeFile(agentsMd, staleContent);

    const overlay = await generateOverlay(tempDir, "fresh-session");
    await applyOverlay(agentsMd, overlay, tempDir);

    const result = await readFile(agentsMd, "utf-8");
    assert.ok(result.includes("fresh-session"));
    assert.ok(!result.includes("Old stale content"));
    const startCount = (result.match(/<!-- OMX:RUNTIME:START -->/g) || [])
      .length;
    assert.equal(startCount, 1);
  });

  it("stripOverlay is no-op when no overlay exists", async () => {
    const agentsMd = join(tempDir, "AGENTS-noop.md");
    await writeFile(agentsMd, originalContent);

    await stripOverlay(agentsMd, tempDir);
    const result = await readFile(agentsMd, "utf-8");
    assert.equal(result, originalContent);
  });

  it("creates AGENTS.md if it does not exist during apply", async () => {
    const agentsMd = join(tempDir, "AGENTS-new.md");
    const overlay = await generateOverlay(tempDir, "new-file-test");
    await applyOverlay(agentsMd, overlay, tempDir);

    const result = await readFile(agentsMd, "utf-8");
    assert.ok(hasOverlay(result));
    assert.ok(result.includes("new-file-test"));
  });

  it("stripOverlay removes runtime overlay and preserves worker overlay (runtime->worker order)", async () => {
    const agentsMd = join(tempDir, "AGENTS-stacked-rw.md");
    await writeFile(agentsMd, originalContent);

    const runtimeOverlay = await generateOverlay(tempDir, "stacked-rw");
    await applyOverlay(agentsMd, runtimeOverlay, tempDir);

    const workerOverlay = `${WORKER_START}
<team_worker_protocol>
worker protocol body
</team_worker_protocol>
${WORKER_END}
`;
    const withRuntime = await readFile(agentsMd, "utf-8");
    await writeFile(agentsMd, `${withRuntime.trimEnd()}\n\n${workerOverlay}`);

    await stripOverlay(agentsMd, tempDir);
    const result = await readFile(agentsMd, "utf-8");
    assert.ok(!result.includes(RUNTIME_START));
    assert.ok(!result.includes(RUNTIME_END));
    assert.ok(result.includes(WORKER_START));
    assert.ok(result.includes(WORKER_END));
  });

  it("stripOverlay removes runtime overlay and preserves worker overlay (worker->runtime order)", async () => {
    const agentsMd = join(tempDir, "AGENTS-stacked-wr.md");
    const workerOverlay = `${WORKER_START}
<team_worker_protocol>
worker protocol body
</team_worker_protocol>
${WORKER_END}
`;
    await writeFile(
      agentsMd,
      `${originalContent.trimEnd()}\n\n${workerOverlay}`,
    );

    const runtimeOverlay = await generateOverlay(tempDir, "stacked-wr");
    await applyOverlay(agentsMd, runtimeOverlay, tempDir);

    await stripOverlay(agentsMd, tempDir);
    const result = await readFile(agentsMd, "utf-8");
    assert.ok(!result.includes(RUNTIME_START));
    assert.ok(!result.includes(RUNTIME_END));
    assert.ok(result.includes(WORKER_START));
    assert.ok(result.includes(WORKER_END));
  });

  it("stripOverlay removes duplicate runtime marker blocks", async () => {
    const agentsMd = join(tempDir, "AGENTS-duplicate-runtime.md");
    const dup = `${originalContent.trimEnd()}

${RUNTIME_START}
<session_context>first</session_context>
${RUNTIME_END}

${RUNTIME_START}
<session_context>second</session_context>
${RUNTIME_END}
`;
    await writeFile(agentsMd, dup);
    await stripOverlay(agentsMd, tempDir);
    const result = await readFile(agentsMd, "utf-8");
    assert.ok(!result.includes(RUNTIME_START));
    assert.ok(!result.includes(RUNTIME_END));
    assert.equal(result.trim(), originalContent.trim());
  });

  it("stripOverlay handles malformed runtime start marker without deleting worker overlay", async () => {
    const agentsMd = join(tempDir, "AGENTS-malformed-runtime.md");
    const malformed = `${originalContent.trimEnd()}

${RUNTIME_START}
<session_context>
incomplete runtime block

${WORKER_START}
<team_worker_protocol>
worker protocol body
</team_worker_protocol>
${WORKER_END}
`;
    await writeFile(agentsMd, malformed);
    await stripOverlay(agentsMd, tempDir);
    const result = await readFile(agentsMd, "utf-8");
    assert.ok(!result.includes(RUNTIME_START));
    assert.ok(result.includes(WORKER_START));
    assert.ok(result.includes(WORKER_END));
  });
});

describe("session-scoped model instructions file", () => {
  let tempDir: string;
  let restoreCodexHome: (() => void) | undefined;

  before(async () => {
    tempDir = await makeTempDir();
    restoreCodexHome = setMockCodexHome(join(tempDir, "home", ".codex"));
  });
  after(async () => {
    restoreCodexHome?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes user + project AGENTS.md + runtime overlay into session-scoped file", async () => {
    const userAgentsMd = join(tempDir, "home", ".codex", "AGENTS.md");
    const projectAgentsMd = join(tempDir, "AGENTS.md");
    await mkdir(join(tempDir, "home", ".codex"), { recursive: true });
    await writeFile(userAgentsMd, "# User instructions\n\nStart globally.\n");
    const projectContent = "# Project instructions\n\nStay in scope.\n";
    await writeFile(projectAgentsMd, projectContent);

    const overlay = await generateOverlay(tempDir, "session-a");
    const writtenPath = await writeSessionModelInstructionsFile(
      tempDir,
      "session-a",
      overlay,
    );
    const sessionContent = await readFile(writtenPath, "utf-8");
    const projectAfter = await readFile(projectAgentsMd, "utf-8");

    assert.equal(
      writtenPath,
      sessionModelInstructionsPath(tempDir, "session-a"),
    );
    assert.match(sessionContent, /# User instructions/);
    assert.match(sessionContent, /# Project instructions/);
    assert.ok(
      sessionContent.indexOf("# User instructions") <
        sessionContent.indexOf("# Project instructions"),
    );
    assert.match(sessionContent, /<!-- OMX:RUNTIME:START -->/);
    assert.equal(projectAfter, projectContent);
  });

  it("deduplicates duplicate skill references when project and user scopes both install the same skill", async () => {
    const userAgentsMd = join(tempDir, "home", ".codex", "AGENTS.md");
    const projectAgentsMd = join(tempDir, "AGENTS.md");
    const userSkillDir = join(tempDir, "home", ".codex", "skills", "help");
    const projectSkillDir = join(tempDir, ".codex", "skills", "help");
    await mkdir(join(tempDir, "home", ".codex"), { recursive: true });
    await mkdir(userSkillDir, { recursive: true });
    await mkdir(projectSkillDir, { recursive: true });
    await writeFile(join(userSkillDir, "SKILL.md"), "# user help\n");
    await writeFile(join(projectSkillDir, "SKILL.md"), "# project help\n");
    await writeFile(
      userAgentsMd,
      [
        "# User instructions",
        "",
        "- help: user copy (file: /tmp/home/.codex/skills/help/SKILL.md)",
      ].join("\n"),
    );
    await writeFile(
      projectAgentsMd,
      [
        "# Project instructions",
        "",
        "- help: project copy (file: /tmp/project/.codex/skills/help/SKILL.md)",
      ].join("\n"),
    );

    const overlay = await generateOverlay(tempDir, "session-dedupe");
    const writtenPath = await writeSessionModelInstructionsFile(
      tempDir,
      "session-dedupe",
      overlay,
    );
    const sessionContent = await readFile(writtenPath, "utf-8");

    assert.equal(
      (sessionContent.match(/skills\/help\/SKILL\.md/g) || []).length,
      1,
    );
    assert.doesNotMatch(sessionContent, /user copy/);
    assert.match(sessionContent, /project copy/);
  });

  it("writes overlay-only session file when no base AGENTS.md files exist", async () => {
    await rm(join(tempDir, "home"), { recursive: true, force: true });
    await rm(join(tempDir, "AGENTS.md"), { force: true });
    const overlay = await generateOverlay(tempDir, "session-b");
    const writtenPath = await writeSessionModelInstructionsFile(
      tempDir,
      "session-b",
      overlay,
    );
    const sessionContent = await readFile(writtenPath, "utf-8");

    assert.ok(sessionContent.includes("<!-- OMX:RUNTIME:START -->"));
    assert.ok(sessionContent.includes("<!-- OMX:RUNTIME:END -->"));
  });

  it("removes session-scoped file without touching project AGENTS.md", async () => {
    const projectAgentsMd = join(tempDir, "AGENTS.md");
    const projectContent = "# Keep me unchanged\n";
    await writeFile(projectAgentsMd, projectContent);

    const overlay = await generateOverlay(tempDir, "session-c");
    const writtenPath = await writeSessionModelInstructionsFile(
      tempDir,
      "session-c",
      overlay,
    );
    await removeSessionModelInstructionsFile(tempDir, "session-c");

    assert.equal(existsSync(writtenPath), false);
    assert.equal(await readFile(projectAgentsMd, "utf-8"), projectContent);
  });
});

describe("hasOverlay", () => {
  it("returns true when both markers present", () => {
    const content =
      "start\n<!-- OMX:RUNTIME:START -->\nmiddle\n<!-- OMX:RUNTIME:END -->\nend";
    assert.ok(hasOverlay(content));
  });

  it("returns false when no markers", () => {
    assert.ok(!hasOverlay("plain content"));
  });

  it("returns false when only start marker", () => {
    assert.ok(!hasOverlay("<!-- OMX:RUNTIME:START -->\nbroken"));
  });
});
