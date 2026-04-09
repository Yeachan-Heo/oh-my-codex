import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildManagedCodexHooksConfig } from "../../config/codex-hooks.js";
import {
  initTeamState,
  readTeamLeaderAttention,
  readTeamPhase,
} from "../../team/state.js";
import {
  dispatchCodexNativeHook,
  mapCodexHookEventToOmxEvent,
  resolveSessionOwnerPidFromAncestry,
} from "../codex-native-hook.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  await writeFile(path, JSON.stringify(value, null, 2));
}

const TEAM_STOP_COMMIT_GUIDANCE =
  " If system-generated worker auto-checkpoint commits exist, rewrite them into Lore-format final commits before merge/finalization.";

const TEAM_ENV_KEYS = [
  "OMX_TEAM_WORKER",
  "OMX_TEAM_STATE_ROOT",
  "OMX_TEAM_LEADER_CWD",
] as const;

const priorTeamEnv = new Map<(typeof TEAM_ENV_KEYS)[number], string | undefined>();

beforeEach(() => {
  priorTeamEnv.clear();
  for (const key of TEAM_ENV_KEYS) {
    priorTeamEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of TEAM_ENV_KEYS) {
    const value = priorTeamEnv.get(key);
    if (typeof value === "string") process.env[key] = value;
    else delete process.env[key];
  }
  priorTeamEnv.clear();
});

describe("codex native hook config", () => {
  it("builds the expected managed hooks.json shape", () => {
    const config = buildManagedCodexHooksConfig("/tmp/omx");
    assert.deepEqual(Object.keys(config.hooks), [
      "SessionStart",
      "PreToolUse",
      "PostToolUse",
      "UserPromptSubmit",
      "Stop",
    ]);

    const preToolUse = config.hooks.PreToolUse[0] as {
      matcher?: string;
      hooks?: Array<Record<string, unknown>>;
    };
    assert.equal(preToolUse.matcher, "Bash");
    assert.match(
      String(preToolUse.hooks?.[0]?.command || ""),
      /codex-native-hook\.js"?$/,
    );

    const postToolUse = config.hooks.PostToolUse[0] as {
      matcher?: string;
      hooks?: Array<Record<string, unknown>>;
    };
    assert.equal(postToolUse.matcher, undefined);
    assert.match(
      String(postToolUse.hooks?.[0]?.command || ""),
      /codex-native-hook\.js"?$/,
    );
    assert.equal(postToolUse.hooks?.[0]?.statusMessage, "Running OMX tool review");

    const stop = config.hooks.Stop[0] as {
      hooks?: Array<Record<string, unknown>>;
    };
    assert.equal(stop.hooks?.[0]?.timeout, 30);
  });
});

describe("codex native hook dispatch", () => {
  it("maps Codex events onto OMX logical surfaces", () => {
    assert.equal(mapCodexHookEventToOmxEvent("SessionStart"), "session-start");
    assert.equal(mapCodexHookEventToOmxEvent("UserPromptSubmit"), "keyword-detector");
    assert.equal(mapCodexHookEventToOmxEvent("PreToolUse"), "pre-tool-use");
    assert.equal(mapCodexHookEventToOmxEvent("PostToolUse"), "post-tool-use");
    assert.equal(mapCodexHookEventToOmxEvent("Stop"), "stop");
  });

  it("writes SessionStart state against the long-lived session owner pid", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-session-start-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "SessionStart",
          cwd,
          session_id: "sess-start-1",
        },
        {
          cwd,
          sessionOwnerPid: 43210,
        },
      );

      assert.equal(result.omxEventName, "session-start");
      assert.deepEqual(result.outputJson, {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext:
            "OMX native SessionStart detected. Load workspace conventions from AGENTS.md, restore relevant .omx runtime/project memory context, and continue from existing mode state before making changes.",
        },
      });
      const sessionState = JSON.parse(
        await readFile(join(cwd, ".omx", "state", "session.json"), "utf-8"),
      ) as { session_id?: string; pid?: number };
      assert.equal(sessionState.session_id, "sess-start-1");
      assert.equal(sessionState.pid, 43210);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("appends .omx/ to repo-root .gitignore during SessionStart when missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-session-gitignore-"));
    try {
      await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
      execFileSync("git", ["init"], { cwd, stdio: "pipe" });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "SessionStart",
          cwd,
          session_id: "sess-gitignore-1",
        },
        { cwd, sessionOwnerPid: 43210 },
      );

      assert.equal(result.omxEventName, "session-start");
      const gitignore = await readFile(join(cwd, ".gitignore"), "utf-8");
      assert.match(gitignore, /^node_modules\/\n\.omx\/\n$/);
      assert.match(
        JSON.stringify(result.outputJson),
        /Added \.omx\/ to .*\.gitignore/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("includes persisted project-memory summary in SessionStart context", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-session-memory-"));
    try {
      await writeJson(join(cwd, ".omx", "project-memory.json"), {
        techStack: "TypeScript + Node.js",
        build: "npm test",
        conventions: "small diffs, verify before claim",
        directives: [
          { directive: "Keep native Stop bounded to real continuation decisions.", priority: "high" },
        ],
        notes: [
          { category: "env", content: "Requires LOCAL_API_BASE for smoke tests", timestamp: new Date().toISOString() },
        ],
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "SessionStart",
          cwd,
          session_id: "sess-memory-1",
        },
        { cwd, sessionOwnerPid: 43210 },
      );

      const serialized = JSON.stringify(result.outputJson);
      assert.match(serialized, /\[Project memory\]/);
      assert.match(serialized, /TypeScript \+ Node\.js/);
      assert.match(serialized, /small diffs, verify before claim/);
      assert.match(serialized, /Keep native Stop bounded to real continuation decisions\./);
      assert.match(serialized, /Requires LOCAL_API_BASE for smoke tests/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("resolves the Codex owner from ancestry without mistaking codex-native-hook wrappers for Codex", () => {
    const commands = new Map<number, string>([
      [2100, 'sh -c node "/repo/dist/scripts/codex-native-hook.js"'],
      [1100, 'node /usr/local/bin/codex.js'],
      [900, 'bash'],
    ]);
    const parents = new Map<number, number | null>([
      [2100, 1100],
      [1100, 900],
      [900, 1],
    ]);

    const resolved = resolveSessionOwnerPidFromAncestry(2100, {
      readParentPid: (pid) => parents.get(pid) ?? null,
      readProcessCommand: (pid) => commands.get(pid) ?? "",
    });

    assert.equal(resolved, 1100);
  });

  it("records keyword activation from UserPromptSubmit payloads", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-1",
          thread_id: "thread-1",
          turn_id: "turn-1",
          prompt: "$ralplan implement issue #1307",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState?.skill, "ralplan");
      assert.ok(result.outputJson, "UserPromptSubmit should emit developer context");
      assert.match(JSON.stringify(result.outputJson), /skill: ralplan activated and initial state initialized at \.omx\/state\/sessions\/sess-1\/ralplan-state\.json; write subsequent updates via omx_state MCP\./);

      const statePath = join(cwd, ".omx", "state", "skill-active-state.json");
      assert.equal(existsSync(statePath), true);
      const state = JSON.parse(await readFile(statePath, "utf-8")) as {
        skill?: string;
        active?: boolean;
        initialized_mode?: string;
      };
      assert.equal(state.skill, "ralplan");
      assert.equal(state.active, true);
      assert.equal(state.initialized_mode, "ralplan");
      assert.equal(existsSync(join(cwd, ".omx", "state", "sessions", "sess-1", "ralplan-state.json")), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not emit UserPromptSubmit routing context for unknown $tokens", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-unknown-token-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-unknown-1",
          thread_id: "thread-unknown-1",
          turn_id: "turn-unknown-1",
          prompt: "$maer-thinking 다시 설명해봐",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState, null);
      assert.equal(result.outputJson, null);
      assert.equal(existsSync(join(cwd, ".omx", "state", "skill-active-state.json")), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("nudges $team prompt-submit routing toward omx team runtime usage", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-team-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-team-1",
          thread_id: "thread-team-1",
          turn_id: "turn-team-1",
          prompt: "$team ship this fix with verification",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState?.skill, "team");
      assert.match(
        JSON.stringify(result.outputJson),
        /skill: team activated and initial state initialized at \.omx\/state\/team-state\.json; write subsequent updates via omx_state MCP\./,
      );
      assert.match(JSON.stringify(result.outputJson), /Use the durable OMX team runtime via `omx team \.\.\.`/);
      assert.match(JSON.stringify(result.outputJson), /If you need help, run `omx team --help`\./);

      const state = JSON.parse(
        await readFile(join(cwd, ".omx", "state", "team-state.json"), "utf-8"),
      ) as { mode?: string; active?: boolean; current_phase?: string };
      assert.equal(state.mode, "team");
      assert.equal(state.active, true);
      assert.equal(state.current_phase, "starting");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("runs prompt-submit HUD reconciliation as a best-effort tmux-only side effect", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-hud-reconcile-"));
    const originalTmux = process.env.TMUX;
    const originalTmuxPane = process.env.TMUX_PANE;
    const originalPath = process.env.PATH;
    const originalArgv = process.argv;
    try {
      process.env.TMUX = "1";
      process.env.TMUX_PANE = "%1";
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      await writeFile(
        join(cwd, ".omx", "hud-config.json"),
        JSON.stringify({ preset: "focused", git: { display: "branch" } }, null, 2),
      );

      const binDir = await mkdtemp(join(tmpdir(), "omx-native-hook-hud-reconcile-bin-"));
      const tmuxLog = join(cwd, "tmux.log");
      await writeFile(
        join(binDir, "tmux"),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(tmuxLog)}
case "$1" in
  list-panes)
    printf '%%1\\tcodex\\tcodex\\n'
    ;;
  display-message)
    printf '80\\t24\\n'
    ;;
  split-window)
    printf '%%9\\n'
    ;;
  resize-pane)
    ;;
esac
`,
      );
      await chmod(join(binDir, "tmux"), 0o755);
      process.env.PATH = `${binDir}:${originalPath}`;
      process.argv = [originalArgv[0] || 'node', '/tmp/codex-host-binary'];

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-hud-1",
          prompt: "$ralplan prepare plan",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      const tmuxCalls = await readFile(tmuxLog, "utf-8");
      assert.match(tmuxCalls, /list-panes/);
      assert.match(tmuxCalls, /split-window/);
      assert.match(tmuxCalls, /resize-pane -t %9 -y 3/);
      assert.match(tmuxCalls, /dist\/cli\/omx\.js' hud --watch --preset=focused/);
      assert.doesNotMatch(tmuxCalls, /\/tmp\/codex-host-binary' hud --watch/);
    } finally {
      if (originalTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = originalTmux;
      }
      if (originalTmuxPane === undefined) {
        delete process.env.TMUX_PANE;
      } else {
        process.env.TMUX_PANE = originalTmuxPane;
      }
      process.env.PATH = originalPath;
      process.argv = originalArgv;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns a destructive-command caution on PreToolUse for rm -rf dist", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-danger-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-danger",
          tool_input: { command: "rm -rf dist" },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.deepEqual(result.outputJson, {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
        },
        systemMessage:
          "Destructive Bash command detected (`rm -rf dist`). Confirm the target and expected side effects before running it.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stays silent on PreToolUse for neutral pwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-neutral-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-neutral",
          tool_input: { command: "pwd" },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns PostToolUse remediation guidance for command-not-found output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-posttool-failure-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-fail",
          tool_input: { command: "foo --version" },
          tool_response: "{\"exit_code\":127,\"stdout\":\"\",\"stderr\":\"bash: foo: command not found\"}",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "post-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: "The Bash output indicates a command/setup failure that should be fixed before retrying.",
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            "Bash reported `command not found`, `permission denied`, or a missing file/path. Verify the command, dependency installation, PATH, file permissions, and referenced paths before retrying.",
        },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns PostToolUse MCP transport fallback guidance for clear MCP transport death", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-posttool-mcp-transport-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          tool_name: "mcp__omx_state__state_write",
          tool_use_id: "tool-mcp-transport",
          tool_input: { mode: "team", active: true },
          tool_response: "{\"error\":\"MCP transport closed\",\"details\":\"stdio pipe closed before response\"}",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "post-tool-use");
      const output = result.outputJson as {
        decision?: string;
        reason?: string;
        hookSpecificOutput?: { additionalContext?: string };
      } | null;
      assert.equal(output?.decision, "block");
      assert.equal(
        output?.reason,
        "The MCP tool appears to have lost its transport/server connection. Preserve state, debug the transport failure, and use OMX CLI/file-backed fallbacks instead of retrying blindly.",
      );
      const additionalContext = String(
        output?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(
        additionalContext,
        /omx state state_write --input/,
      );
      assert.match(
        additionalContext,
        /plain Node stdio processes/i,
      );
      assert.match(
        additionalContext,
        /read-stall-state/,
      );
      assert.match(
        additionalContext,
        /OMX_MCP_TRANSPORT_DEBUG=1/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not classify non-transport MCP failures as transport death", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-posttool-mcp-nontransport-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          tool_name: "mcp__omx_state__state_write",
          tool_use_id: "tool-mcp-nontransport",
          tool_input: { active: true },
          tool_response: "{\"error\":\"validation failed\",\"details\":\"mode is required\"}",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "post-tool-use");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("marks active team state failed on MCP transport death without deleting team state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-team-mcp-transport-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(cwd);
      await initTeamState(
        "transport-team",
        "task",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-transport" },
      );
      await writeJson(join(cwd, ".omx", "state", "team-state.json"), {
        active: true,
        team_name: "transport-team",
        current_phase: "team-exec",
      });

      await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          session_id: "sess-transport",
          tool_name: "mcp__omx_state__state_write",
          tool_use_id: "tool-mcp-transport-team",
          tool_input: { mode: "team", active: true },
          tool_response: "{\"error\":\"MCP transport closed\",\"details\":\"stdio pipe closed before response\"}",
        },
        { cwd },
      );

      const phase = await readTeamPhase("transport-team", cwd);
      const attention = await readTeamLeaderAttention("transport-team", cwd);
      assert.equal(phase?.current_phase, "failed");
      assert.equal(attention?.leader_attention_reason, "mcp_transport_dead");
      assert.equal(attention?.leader_attention_pending, true);
      assert.equal(existsSync(join(cwd, ".omx", "state", "team", "transport-team")), true);
    } finally {
      process.chdir(previousCwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("treats stderr-only informative non-zero output as reviewable instead of a generic failure", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-posttool-informative-stderr-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-useful-stderr",
          tool_input: { command: "gh pr checks" },
          tool_response: "{\"exit_code\":8,\"stdout\":\"\",\"stderr\":\"build pending\\nlint pass\"}",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "post-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: "The Bash command returned a non-zero exit code but produced useful output that should be reviewed before retrying.",
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            "The Bash output appears informative despite the non-zero exit code. Review and report the output before retrying instead of assuming the command simply failed.",
        },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("treats non-zero gh pr checks style output as informative instead of a generic failure", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-posttool-informative-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-useful",
          tool_input: { command: "gh pr checks" },
          tool_response: "{\"exit_code\":8,\"stdout\":\"build\\tpending\\t2m\\nlint\\tpass\\t18s\",\"stderr\":\"\"}",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "post-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: "The Bash command returned a non-zero exit code but produced useful output that should be reviewed before retrying.",
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            "The Bash output appears informative despite the non-zero exit code. Review and report the output before retrying instead of assuming the command simply failed.",
        },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns MCP transport-death guidance and preserves failed team state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-posttool-mcp-dead-"));
    try {
      await initTeamState(
        "mcp-transport-dead-team",
        "transport failure fallback",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-mcp-dead" },
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          session_id: "sess-mcp-dead",
          tool_name: "mcp__omx_state__state_write",
          tool_use_id: "tool-mcp-dead",
          tool_response: JSON.stringify({
            error: "transport closed",
            message: "MCP server disconnected",
          }),
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "post-tool-use");
      assert.equal(result.outputJson?.decision, "block");
      assert.match(String(result.outputJson?.reason || ""), /lost its transport\/server connection/);
      const hookSpecificOutput = result.outputJson?.hookSpecificOutput as {
        hookEventName?: string;
        additionalContext?: string;
      } | undefined;
      assert.equal(hookSpecificOutput?.hookEventName, "PostToolUse");
      assert.match(
        String(hookSpecificOutput?.additionalContext || ""),
        /Retry via CLI parity with `omx state state_write --input '\{\}' --json`\./,
      );
      assert.match(
        String(hookSpecificOutput?.additionalContext || ""),
        /omx team api read-stall-state/,
      );

      const phase = JSON.parse(
        await readFile(join(cwd, ".omx", "state", "team", "mcp-transport-dead-team", "phase.json"), "utf-8"),
      ) as { current_phase?: string; transitions?: Array<{ reason?: string }> };
      assert.equal(phase.current_phase, "failed");
      assert.equal(phase.transitions?.at(-1)?.reason, "mcp_transport_dead");

      const attention = JSON.parse(
        await readFile(join(cwd, ".omx", "state", "team", "mcp-transport-dead-team", "leader-attention.json"), "utf-8"),
      ) as { leader_attention_reason?: string; attention_reasons?: string[] };
      assert.equal(attention.leader_attention_reason, "mcp_transport_dead");
      assert.ok(attention.attention_reasons?.includes("mcp_transport_dead"));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stays silent on neutral successful PostToolUse output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-posttool-neutral-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-ok",
          tool_input: { command: "pwd" },
          tool_response: "{\"exit_code\":0,\"stdout\":\"/repo\",\"stderr\":\"\"}",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "post-tool-use");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns CLI fallback guidance and preserves failed team state on clear MCP transport death", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-posttool-mcp-transport-"));
    try {
      await initTeamState(
        "transport-team",
        "transport failure fallback",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-stop-mcp-transport" },
      );
      await writeJson(join(cwd, ".omx", "state", "team-state.json"), {
        active: true,
        team_name: "transport-team",
        current_phase: "team-exec",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          session_id: "sess-stop-mcp-transport",
          tool_name: "mcp__omx_state__state_write",
          tool_use_id: "tool-mcp-fail",
          tool_input: { mode: "team", active: true },
          tool_response: JSON.stringify({
            error: "MCP transport closed unexpectedly",
            exit_code: 1,
          }),
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "post-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: "The MCP tool appears to have lost its transport/server connection. Preserve state, debug the transport failure, and use OMX CLI/file-backed fallbacks instead of retrying blindly.",
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            "Clear MCP transport-death signal detected. Preserve current team/runtime state. Retry via CLI parity with `omx state state_write --input '{\"mode\":\"team\",\"active\":true}' --json`. OMX MCP servers are plain Node stdio processes, so they still shut down when stdin/transport closes. If this happened during team runtime, inspect first with `omx team status <team>` or `omx team api read-stall-state --input '{\"team_name\":\"<team>\"}' --json`, and only force cleanup after capturing needed state. For root-cause debugging, rerun with `OMX_MCP_TRANSPORT_DEBUG=1` to log why the stdio transport closed.",
        },
      });

      const phase = await readTeamPhase("transport-team", cwd);
      const attention = await readTeamLeaderAttention("transport-team", cwd);
      assert.equal(phase?.current_phase, "failed");
      assert.equal(attention?.leader_attention_reason, "mcp_transport_dead");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output while Autopilot is active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-autopilot-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "autopilot-state.json"), {
        active: true,
        current_phase: "execution",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-autopilot",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "OMX autopilot is still active (phase: execution); continue the task and gather fresh verification evidence before stopping.",
        stopReason: "autopilot_execution",
        systemMessage: "OMX autopilot is still active (phase: execution).",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output while Ultrawork is active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-ultrawork-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "ultrawork-state.json"), {
        active: true,
        current_phase: "executing",
      });

      const result = await dispatchCodexNativeHook(
        { hook_event_name: "Stop", cwd, session_id: "sess-stop-ultrawork" },
        { cwd },
      );

      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "OMX ultrawork is still active (phase: executing); continue the task and gather fresh verification evidence before stopping.",
        stopReason: "ultrawork_executing",
        systemMessage: "OMX ultrawork is still active (phase: executing).",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output while UltraQA is active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-ultraqa-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "ultraqa-state.json"), {
        active: true,
        current_phase: "diagnose",
      });

      const result = await dispatchCodexNativeHook(
        { hook_event_name: "Stop", cwd, session_id: "sess-stop-ultraqa" },
        { cwd },
      );

      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "OMX ultraqa is still active (phase: diagnose); continue the task and gather fresh verification evidence before stopping.",
        stopReason: "ultraqa_diagnose",
        systemMessage: "OMX ultraqa is still active (phase: diagnose).",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output while team phase is non-terminal", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "team-state.json"), {
        active: true,
        current_phase: "team-exec",
        team_name: "review-team",
      });
      await writeJson(join(stateDir, "team", "review-team", "phase.json"), {
        current_phase: "team-verify",
        max_fix_attempts: 3,
        current_fix_attempt: 0,
        transitions: [],
        updated_at: new Date().toISOString(),
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (review-team) at phase team-verify; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-verify",
        systemMessage: "OMX team pipeline is still active at phase team-verify.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks Stop for a team worker with a non-terminal assigned task via native worker context", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-worker-"));
    const prevTeamWorker = process.env.OMX_TEAM_WORKER;
    const prevTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const prevLeaderCwd = process.env.OMX_TEAM_LEADER_CWD;
    try {
      await initTeamState(
        "worker-stop-team",
        "worker stop fallback",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-stop-team-worker" },
      );
      const workerDir = join(cwd, ".omx", "state", "team", "worker-stop-team", "workers", "worker-1");
      await writeJson(join(workerDir, "status.json"), {
        state: "idle",
        current_task_id: "1",
        updated_at: new Date().toISOString(),
      });
      await writeJson(join(cwd, ".omx", "state", "team", "worker-stop-team", "tasks", "task-1.json"), {
        id: "1",
        subject: "hook task",
        description: "finish hook task",
        status: "in_progress",
        owner: "worker-1",
        created_at: new Date().toISOString(),
      });

      process.env.OMX_TEAM_WORKER = "worker-stop-team/worker-1";
      process.env.OMX_TEAM_STATE_ROOT = join(cwd, ".omx", "state");
      process.env.OMX_TEAM_LEADER_CWD = cwd;

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd: join(cwd, ".omx", "team", "worker-stop-team", "worktrees", "worker-1"),
          session_id: "sess-stop-team-worker",
        },
        { cwd: join(cwd, ".omx", "team", "worker-stop-team", "worktrees", "worker-1") },
      );

      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "OMX team worker worker-1 is still assigned non-terminal task 1 (in_progress); continue the current assigned task or report a concrete blocker before stopping.",
        stopReason: "team_worker_worker-1_1_in_progress",
        systemMessage: "OMX team worker worker-1 is still assigned task 1 (in_progress).",
      });
    } finally {
      if (typeof prevTeamWorker === "string") process.env.OMX_TEAM_WORKER = prevTeamWorker;
      else delete process.env.OMX_TEAM_WORKER;
      if (typeof prevTeamStateRoot === "string") process.env.OMX_TEAM_STATE_ROOT = prevTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      if (typeof prevLeaderCwd === "string") process.env.OMX_TEAM_LEADER_CWD = prevLeaderCwd;
      else delete process.env.OMX_TEAM_LEADER_CWD;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block Stop for a team worker when assigned task is terminal", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-worker-terminal-"));
    const prevTeamWorker = process.env.OMX_TEAM_WORKER;
    const prevTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      await initTeamState(
        "worker-stop-team-terminal",
        "worker stop terminal fallback",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-stop-team-worker-terminal" },
      );
      const workerDir = join(cwd, ".omx", "state", "team", "worker-stop-team-terminal", "workers", "worker-1");
      await writeJson(join(workerDir, "status.json"), {
        state: "done",
        current_task_id: "1",
        updated_at: new Date().toISOString(),
      });
      await writeJson(join(cwd, ".omx", "state", "team", "worker-stop-team-terminal", "tasks", "task-1.json"), {
        id: "1",
        subject: "hook task",
        description: "finish hook task",
        status: "completed",
        owner: "worker-1",
        created_at: new Date().toISOString(),
      });

      process.env.OMX_TEAM_WORKER = "worker-stop-team-terminal/worker-1";
      process.env.OMX_TEAM_STATE_ROOT = join(cwd, ".omx", "state");

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-worker-terminal",
        },
        { cwd },
      );

      assert.equal(result.outputJson, null);
    } finally {
      if (typeof prevTeamWorker === "string") process.env.OMX_TEAM_WORKER = prevTeamWorker;
      else delete process.env.OMX_TEAM_WORKER;
      if (typeof prevTeamStateRoot === "string") process.env.OMX_TEAM_STATE_ROOT = prevTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output from canonical team state when coarse mode state is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-canonical-"));
    try {
      await initTeamState(
        "canonical-team",
        "canonical stop fallback",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-stop-team-canonical" },
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-canonical",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (canonical-team) at phase team-exec; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-exec",
        systemMessage: "OMX team pipeline is still active at phase team-exec.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("re-fires canonical-team Stop output for a later fresh Stop reply when coarse mode state is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-canonical-refire-"));
    try {
      await initTeamState(
        "canonical-team-refire",
        "canonical stop fallback refire",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-stop-team-canonical-refire" },
      );

      await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-canonical-refire",
          thread_id: "thread-stop-team-canonical-refire",
          turn_id: "turn-stop-team-canonical-refire-1",
        },
        { cwd },
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-canonical-refire",
          thread_id: "thread-stop-team-canonical-refire",
          turn_id: "turn-stop-team-canonical-refire-2",
          stop_hook_active: true,
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (canonical-team-refire) at phase team-exec; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-exec",
        systemMessage: "OMX team pipeline is still active at phase team-exec.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block Stop from canonical team state alone when the canonical phase is terminal", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-terminal-"));
    try {
      await initTeamState(
        "terminal-team",
        "terminal stop fallback",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-stop-team-terminal" },
      );
      await writeJson(join(cwd, ".omx", "state", "team", "terminal-team", "phase.json"), {
        current_phase: "complete",
        max_fix_attempts: 3,
        current_fix_attempt: 0,
        transitions: [],
        updated_at: new Date().toISOString(),
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-terminal",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output from canonical team state when manifest session ownership is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-legacy-"));
    try {
      await initTeamState(
        "legacy-team",
        "legacy stop fallback",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-stop-team-legacy" },
      );
      const manifestPath = join(cwd, ".omx", "state", "team", "legacy-team", "manifest.v2.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
      await writeJson(manifestPath, {
        ...manifest,
        leader: {
          ...(manifest.leader as Record<string, unknown> | undefined),
          session_id: "",
        },
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-legacy",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (legacy-team) at phase team-exec; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-exec",
        systemMessage: "OMX team pipeline is still active at phase team-exec.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it("reads canonical Stop fallback team state from OMX_TEAM_STATE_ROOT when configured", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-root-"));
    const sharedRoot = join(cwd, "shared-root");
    const priorTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      process.env.OMX_TEAM_STATE_ROOT = "shared-root";
      await initTeamState(
        "canonical-root-team",
        "canonical stop root fallback",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-stop-team-root", OMX_TEAM_STATE_ROOT: "shared-root" },
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-root",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (canonical-root-team) at phase team-exec; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-exec",
        systemMessage: "OMX team pipeline is still active at phase team-exec.",
      });
      assert.equal(existsSync(join(sharedRoot, "team", "canonical-root-team", "phase.json")), true);
    } finally {
      if (typeof priorTeamStateRoot === "string") process.env.OMX_TEAM_STATE_ROOT = priorTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output from canonical team state rooted via OMX_TEAM_STATE_ROOT", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-env-root-"));
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      process.env.OMX_TEAM_STATE_ROOT = "shared-team-state";
      await initTeamState(
        "env-root-team",
        "env root stop fallback",
        "executor",
        1,
        cwd,
        undefined,
        {
          ...process.env,
          OMX_SESSION_ID: "sess-stop-team-env-root",
          OMX_TEAM_STATE_ROOT: "shared-team-state",
        },
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-env-root",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (env-root-team) at phase team-exec; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-exec",
        systemMessage: "OMX team pipeline is still active at phase team-exec.",
      });
    } finally {
      if (typeof previousTeamStateRoot === "string") process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output for active ralplan skill with matching active mode state and without active subagents", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-skill-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-skill"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-skill" });
      await writeJson(join(stateDir, "sessions", "sess-stop-skill", "skill-active-state.json"), {
        active: true,
        skill: "ralplan",
        phase: "planning",
      });
      await writeJson(join(stateDir, "sessions", "sess-stop-skill", "ralplan-state.json"), {
        active: true,
        current_phase: "planning",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-skill",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "OMX skill ralplan is still active (phase: planning); continue until the current ralplan workflow reaches a terminal state.",
        stopReason: "skill_ralplan_planning",
        systemMessage: "OMX skill ralplan is still active (phase: planning).",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block on stale ralplan skill-active state when the matching mode state is absent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-stale-skill-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-stale-skill"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-stale-skill" });
      await writeJson(join(stateDir, "sessions", "sess-stop-stale-skill", "skill-active-state.json"), {
        active: true,
        skill: "ralplan",
        phase: "planning",
        session_id: "sess-stop-stale-skill",
        active_skills: [{
          skill: "ralplan",
          phase: "planning",
          active: true,
          session_id: "sess-stop-stale-skill",
        }],
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-stale-skill",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block on active ralplan skill when subagents are still active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-skill-subagent-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-skill-subagent"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-skill-subagent" });
      await writeJson(join(stateDir, "sessions", "sess-stop-skill-subagent", "skill-active-state.json"), {
        active: true,
        skill: "ralplan",
        phase: "planning",
      });
      await writeJson(join(stateDir, "sessions", "sess-stop-skill-subagent", "ralplan-state.json"), {
        active: true,
        current_phase: "planning",
      });
      await writeJson(join(stateDir, "subagent-tracking.json"), {
        schemaVersion: 1,
        sessions: {
          "sess-stop-skill-subagent": {
            session_id: "sess-stop-skill-subagent",
            leader_thread_id: "leader-1",
            updated_at: new Date().toISOString(),
            threads: {
              "leader-1": {
                thread_id: "leader-1",
                kind: "leader",
                first_seen_at: new Date().toISOString(),
                last_seen_at: new Date().toISOString(),
                turn_count: 1,
              },
              "sub-1": {
                thread_id: "sub-1",
                kind: "subagent",
                first_seen_at: new Date().toISOString(),
                last_seen_at: new Date().toISOString(),
                turn_count: 1,
              },
            },
          },
        },
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-skill-subagent",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block on stale root ralplan skill when the explicit session-scoped canonical skill state is absent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-stale-root-skill-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "skill-active-state.json"), {
        active: true,
        skill: "ralplan",
        phase: "planning",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-stale-root-skill",
          thread_id: "thread-stop-stale-root-skill",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output for active deep-interview skill with matching active mode state and without active subagents", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-deep-interview-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-deep-interview"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-deep-interview" });
      await writeJson(join(stateDir, "sessions", "sess-stop-deep-interview", "skill-active-state.json"), {
        active: true,
        skill: "deep-interview",
        phase: "planning",
      });
      await writeJson(join(stateDir, "sessions", "sess-stop-deep-interview", "deep-interview-state.json"), {
        active: true,
        current_phase: "planning",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-deep-interview",
        },
        { cwd },
      );

      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "OMX skill deep-interview is still active (phase: planning); continue until the current deep-interview workflow reaches a terminal state.",
        stopReason: "skill_deep-interview_planning",
        systemMessage: "OMX skill deep-interview is still active (phase: planning).",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("ignores root skill-active fallback from a different thread when evaluating Stop", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-foreign-thread-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "skill-active-state.json"), {
        active: true,
        skill: "deep-interview",
        phase: "planning",
        session_id: "",
        thread_id: "other-thread",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-main",
          thread_id: "main-thread",
        },
        { cwd },
      );

      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output while Ralph is active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, "ralph-state.json"),
        JSON.stringify({
          active: true,
          current_phase: "executing",
        }),
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "OMX Ralph is still active (phase: executing); continue the task and gather fresh verification evidence before stopping.",
        stopReason: "ralph_executing",
        systemMessage:
          "OMX Ralph is still active (phase: executing); continue the task and gather fresh verification evidence before stopping.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block Stop from stale session-scoped Ralph state that belongs to another session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-stale-session-ralph-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-current"), { recursive: true });
      await mkdir(join(stateDir, "sessions", "sess-stale"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-current" });
      await writeJson(join(stateDir, "sessions", "sess-stale", "ralph-state.json"), {
        active: true,
        current_phase: "starting",
        session_id: "sess-stale",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-current",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not re-block Ralph when Stop already continued once", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-ralph-once-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, "ralph-state.json"),
        JSON.stringify({
          active: true,
          current_phase: "executing",
        }),
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-ralph-once",
          stop_hook_active: true,
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output for native auto-nudge stall prompts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto",
          last_assistant_message: "Would you like me to keep going and finish the cleanup?",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: "yes, proceed",
        stopReason: "auto_nudge",
        systemMessage:
          "OMX native Stop detected a stall/permission-style handoff and continued the turn automatically.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("suppresses duplicate native auto-nudge replays for the same Stop reply", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-once-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });

      await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-once",
          thread_id: "thread-stop-auto",
          turn_id: "turn-stop-auto-1",
          last_assistant_message: "Would you like me to continue?",
        },
        { cwd },
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-once",
          thread_id: "thread-stop-auto",
          turn_id: "turn-stop-auto-1",
          stop_hook_active: true,
          last_assistant_message: "Would you like me to continue?",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("re-fires native auto-nudge for a later fresh Stop reply even when stop_hook_active is true", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-refire-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });

      await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-refire",
          thread_id: "thread-stop-auto-refire",
          turn_id: "turn-stop-auto-refire-1",
          last_assistant_message: "Would you like me to continue?",
        },
        { cwd },
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-refire",
          thread_id: "thread-stop-auto-refire",
          turn_id: "turn-stop-auto-refire-2",
          stop_hook_active: true,
          last_assistant_message: "If you want, I can keep going and finish the cleanup.",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: "yes, proceed",
        stopReason: "auto_nudge",
        systemMessage:
          "OMX native Stop detected a stall/permission-style handoff and continued the turn automatically.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("suppresses native auto-nudge when only the deep-interview input lock is active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-deep-interview-lock-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-auto-lock"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-auto-lock" });
      await writeJson(join(stateDir, "sessions", "sess-stop-auto-lock", "skill-active-state.json"), {
        version: 1,
        active: true,
        skill: "deep-interview",
        phase: "planning",
        input_lock: {
          active: true,
          scope: "deep-interview-auto-approval",
          blocked_inputs: ["yes", "proceed"],
          message: "Deep interview is active; auto-approval shortcuts are blocked until the interview finishes.",
        },
      });
      await writeJson(join(stateDir, "sessions", "sess-stop-auto-lock", "deep-interview-state.json"), {
        active: true,
        current_phase: "planning",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-lock",
          thread_id: "thread-stop-auto-lock",
          turn_id: "turn-stop-auto-lock-1",
          last_assistant_message: "Would you like me to continue with the next step?",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "OMX skill deep-interview is still active (phase: planning); continue until the current deep-interview workflow reaches a terminal state.",
        stopReason: "skill_deep-interview_planning",
        systemMessage: "OMX skill deep-interview is still active (phase: planning).",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("suppresses native auto-nudge re-fire while session-scoped deep-interview state is still active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-deep-interview-state-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-auto-interview"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-auto-interview" });
      await writeJson(join(stateDir, "sessions", "sess-stop-auto-interview", "deep-interview-state.json"), {
        active: true,
        mode: "deep-interview",
        current_phase: "intent-first",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-interview",
          thread_id: "thread-stop-auto-interview",
          turn_id: "turn-stop-auto-interview-2",
          stop_hook_active: true,
          last_assistant_message: "If you want, I can keep going from here.",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("suppresses native auto-nudge when root deep-interview mode state is active without an explicit session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-deep-interview-mode-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "deep-interview-state.json"), {
        active: true,
        mode: "deep-interview",
        current_phase: "intent-first",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          turn_id: "turn-stop-auto-mode-1",
          last_assistant_message: "Would you like me to continue with the next step?",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not suppress native auto-nudge from stale root deep-interview mode state when the explicit session-scoped mode state is absent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-stale-root-mode-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "deep-interview-state.json"), {
        active: true,
        mode: "deep-interview",
        current_phase: "intent-first",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-stale-root-mode",
          thread_id: "thread-stop-auto-stale-root-mode",
          turn_id: "turn-stop-auto-stale-root-mode-1",
          last_assistant_message: "Would you like me to continue with the next step?",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: "yes, proceed",
        stopReason: "auto_nudge",
        systemMessage:
          "OMX native Stop detected a stall/permission-style handoff and continued the turn automatically.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not suppress native auto-nudge from stale root deep-interview skill state when the explicit session-scoped canonical skill state is absent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-stale-root-skill-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "skill-active-state.json"), {
        active: true,
        skill: "deep-interview",
        phase: "planning",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-stale-root-skill",
          thread_id: "thread-stop-auto-stale-root-skill",
          turn_id: "turn-stop-auto-stale-root-skill-1",
          last_assistant_message: "Would you like me to continue with the next step?",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: "yes, proceed",
        stopReason: "auto_nudge",
        systemMessage:
          "OMX native Stop detected a stall/permission-style handoff and continued the turn automatically.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not suppress native auto-nudge from stale root deep-interview input lock when the explicit session-scoped canonical skill state is absent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-stale-root-lock-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "skill-active-state.json"), {
        active: true,
        skill: "deep-interview",
        phase: "planning",
        input_lock: {
          active: true,
          scope: "deep-interview-auto-approval",
          blocked_inputs: ["yes", "proceed"],
          message: "Deep interview is active; auto-approval shortcuts are blocked until the interview finishes.",
        },
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-stale-root-lock",
          thread_id: "thread-stop-auto-stale-root-lock",
          turn_id: "turn-stop-auto-stale-root-lock-1",
          last_assistant_message: "Would you like me to continue with the next step?",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: "yes, proceed",
        stopReason: "auto_nudge",
        systemMessage:
          "OMX native Stop detected a stall/permission-style handoff and continued the turn automatically.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("re-fires team Stop output for a later fresh Stop reply while the team is still active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-refire-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "team-state.json"), {
        active: true,
        current_phase: "team-exec",
        team_name: "review-team",
      });
      await writeJson(join(stateDir, "team", "review-team", "phase.json"), {
        current_phase: "team-verify",
        max_fix_attempts: 3,
        current_fix_attempt: 0,
        transitions: [],
        updated_at: new Date().toISOString(),
      });

      await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-refire",
          thread_id: "thread-stop-team-refire",
          turn_id: "turn-stop-team-refire-1",
        },
        { cwd },
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-refire",
          thread_id: "thread-stop-team-refire",
          turn_id: "turn-stop-team-refire-2",
          stop_hook_active: true,
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (review-team) at phase team-verify; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-verify",
        systemMessage: "OMX team pipeline is still active at phase team-verify.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
