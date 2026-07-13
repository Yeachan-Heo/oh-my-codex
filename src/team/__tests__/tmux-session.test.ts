import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import {
  buildClientAttachedReconcileHookName,
  assertTeamWorkerCliBinaryAvailable,
  buildWorkerProcessLaunchSpec,
  buildReconcileHudResizeArgs,
  buildRegisterClientAttachedReconcileArgs,
  buildRegisterResizeHookArgs,
  buildResizeHookName,
  buildResizeHookTarget,
  buildScheduleDelayedHudResizeArgs,
  buildUnregisterClientAttachedReconcileArgs,
  buildUnregisterResizeHookArgs,
  buildWorkerStartupCommand,
  trustWorkerMiseConfigIfAvailable,
  writeWorkerStartupScriptCommand,
  shouldSourceTeamWorkerShellRc,
  buildHudPaneTarget,
  chooseTeamLeaderPaneId,
  createTeamSession,
  enableMouseScrolling,
  isMsysOrGitBash,
  isNativeWindows,
  isTmuxAvailable,
  isWorkerPaneOpen,
  restoreStandaloneHudPane,
  translatePathForMsys,
  isWsl2,
  isWorkerAlive,
  killWorker,
  killWorkerByPaneId,
  teardownWorkerPanes,
  listTeamSessions,
  resolveTeamWorkerCli,
  resolveTeamWorkerLaunchMode,
  resolveWorkerCliForSend,
  resolveTeamWorkerCliPlan,
  buildWorkerSubmitPlan,
  sanitizeTeamName,
  shouldAttemptAdaptiveRetry,
  sendToWorker,
  sendToWorkerStdin,
  sleepFractionalSeconds,
  translateWorkerLaunchArgsForCli,
  waitForWorkerReady,
  waitForWorkerReadyAsync,
  paneIsBootstrapping,
  classifyWorkerStartupInjectSafety,
  checkWorkerStartupInjectSafety,
  dismissTrustPromptIfPresent,
  evaluateStartupDirectTriggerSafetyCapture,
  mitigateCopyModeUnderlineArtifacts,
} from '../tmux-session.js';
import { HUD_RESIZE_RECONCILE_DELAY_SECONDS, HUD_TMUX_TEAM_HEIGHT_LINES } from '../../hud/constants.js';
import * as tmuxSessionModule from '../tmux-session.js';
import { OMX_ENTRY_PATH_ENV, OMX_STARTUP_CWD_ENV } from '../../utils/paths.js';

const fsMutable = fs as typeof fs & {
  existsSync: typeof fs.existsSync;
  statSync: typeof fs.statSync;
};

function withEmptyPath<T>(fn: () => T): T {
  const prev = process.env.PATH;
  process.env.PATH = '';
  try {
    return fn();
  } finally {
    if (typeof prev === 'string') process.env.PATH = prev;
    else delete process.env.PATH;
  }
}

function withMockedExistsSync<T>(mock: typeof fs.existsSync, fn: () => T): T {
  const original = fsMutable.existsSync;
  fsMutable.existsSync = mock;
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fsMutable.existsSync = original;
    syncBuiltinESMExports();
  }
}

function withMockedStatSync<T>(mock: typeof fs.statSync, fn: () => T): T {
  const original = fsMutable.statSync;
  fsMutable.statSync = mock;
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fsMutable.statSync = original;
    syncBuiltinESMExports();
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CLAUDE_BYPASS_PROMPT_CAPTURE = `Bypass Permissions mode

1. No, exit
2. Yes, I accept

Press Enter to confirm`;

const READY_HELPER_CAPTURE = `╭────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.114.0)                 │
│                                            │
│ model:     gpt-5.6-sol high   /model to change │
│ directory: ~/Workspace/demo                │
╰────────────────────────────────────────────╯

How can I help you today?`;

const VIEWPORT_WITHOUT_VISIBLE_PROMPT_CAPTURE = `╭────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.118.0)                 │
│                                            │
│ model:     gpt-5.6-sol high   /model to change │
│ directory: ~/Workspace/demo                │
╰────────────────────────────────────────────╯

⚠ MCP startup incomplete (failed: hf request)`;

const VIEWPORT_SCROLLBACK_READY_CAPTURE = `${VIEWPORT_WITHOUT_VISIBLE_PROMPT_CAPTURE}

› support lane on multi-image attach`;

const QUEUED_AFTER_TOOL_CALL_CAPTURE = `• Messages to be submitted after next tool call (press esc to interrupt and send immediately)
  ↳ Read $OMX_TEAM_STATE_ROOT/team/demo/workers/worker-1/inbox.md, work now, report progress

› Write tests for @filename`;

async function withMockTmuxFixture<T>(
  dirPrefix: string,
  tmuxScript: (tmuxLogPath: string) => string,
  run: (ctx: { logPath: string }) => Promise<T>,
): Promise<T> {
  const fakeBinDir = await mkdtemp(join(tmpdir(), dirPrefix));
  const logPath = join(fakeBinDir, 'tmux.log');
  const tmuxStubPath = join(fakeBinDir, 'tmux');
  const previousPath = process.env.PATH;

  try {
    await writeFile(tmuxStubPath, tmuxScript(logPath));
    await chmod(tmuxStubPath, 0o755);
    process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
    return await run({ logPath });
  } finally {
    if (typeof previousPath === 'string') process.env.PATH = previousPath;
    else delete process.env.PATH;
    await rm(fakeBinDir, { recursive: true, force: true });
  }
}

describe('sanitizeTeamName', () => {
  it('lowercases and strips invalid chars', () => {
    assert.equal(sanitizeTeamName('My Team!'), 'my-team');
  });

  it('truncates to 30 chars', () => {
    const long = 'a'.repeat(50);
    assert.equal(sanitizeTeamName(long).length, 30);
  });

  it('rejects empty after sanitization', () => {
    assert.throws(() => sanitizeTeamName('!!!'), /empty/i);
  });
});

describe('chooseTeamLeaderPaneId', () => {
  it('keeps preferred pane when it is not HUD', () => {
    const panes = [
      { paneId: '%1', currentCommand: 'node', startCommand: "'codex'" },
      { paneId: '%2', currentCommand: 'node', startCommand: "node omx hud --watch" },
    ];
    assert.equal(chooseTeamLeaderPaneId(panes, '%1'), '%1');
  });

  it('switches away from HUD preferred pane to first non-HUD pane', () => {
    const panes = [
      { paneId: '%2', currentCommand: 'node', startCommand: "node omx hud --watch" },
      { paneId: '%1', currentCommand: 'node', startCommand: "'codex'" },
    ];
    assert.equal(chooseTeamLeaderPaneId(panes, '%2'), '%1');
  });

  it('falls back to preferred pane when all panes are HUD panes', () => {
    const panes = [
      { paneId: '%2', currentCommand: 'node', startCommand: "node omx hud --watch" },
      { paneId: '%3', currentCommand: 'node', startCommand: "node omx hud --watch" },
    ];
    assert.equal(chooseTeamLeaderPaneId(panes, '%2'), '%2');
  });
});

describe('HUD resize hook command builders', () => {
  it('buildResizeHookName normalizes all segments into collision-safe tokens', () => {
    const name = buildResizeHookName('Team A', 'Session:Main', '0', '%12');
    assert.equal(name, 'omx_resize_Team_A_Session_Main_0_12');
  });

  it('buildResizeHookTarget uses session:window format', () => {
    assert.equal(buildResizeHookTarget('my-session', '3'), 'my-session:3');
  });

  it('buildHudPaneTarget always returns %<pane_id>', () => {
    assert.equal(buildHudPaneTarget('%41'), '%41');
    assert.equal(buildHudPaneTarget('41'), '%41');
  });

  it('buildRegisterResizeHookArgs uses target and numeric client-resized hook slot', () => {
    const args = buildRegisterResizeHookArgs('my-session:0', 'omx_resize_team_session_0_1', '%1');
    assert.equal(args[0], 'set-hook');
    assert.equal(args[1], '-t');
    assert.equal(args[2], 'my-session:0');
    assert.match(args[3] ?? '', /^client-resized\[\d+\]$/);
    assert.equal(
      args[4],
      `run-shell -b 'tmux resize-pane -t %1 -y ${HUD_TMUX_TEAM_HEIGHT_LINES} >/dev/null 2>&1 || true; sleep ${HUD_RESIZE_RECONCILE_DELAY_SECONDS}; tmux resize-pane -t %1 -y ${HUD_TMUX_TEAM_HEIGHT_LINES} >/dev/null 2>&1 || true'`,
    );
  });

  it('buildUnregisterResizeHookArgs removes the exact numeric hook slot', () => {
    const registered = buildRegisterResizeHookArgs('my-session:0', 'omx_resize_team_session_0_1', '%1');
    const unregistered = buildUnregisterResizeHookArgs('my-session:0', 'omx_resize_team_session_0_1');
    assert.deepEqual(unregistered, ['set-hook', '-u', '-t', 'my-session:0', registered[3] as string]);
  });

  it('buildClientAttachedReconcileHookName normalizes all segments into collision-safe tokens', () => {
    const name = buildClientAttachedReconcileHookName('Team A', 'Session:Main', '0', '%12');
    assert.equal(name, 'omx_attached_Team_A_Session_Main_0_12');
  });

  it('buildRegisterClientAttachedReconcileArgs installs one-shot client-attached reconcile hook', () => {
    const args = buildRegisterClientAttachedReconcileArgs('my-session:0', 'omx_attached_team_session_0_1', '%1');
    assert.equal(args[0], 'set-hook');
    assert.equal(args[1], '-t');
    assert.equal(args[2], 'my-session:0');
    assert.match(args[3] ?? '', /^client-attached\[\d+\]$/);
    assert.match(
      args[4] ?? '',
      /^run-shell -b 'tmux resize-pane -t %1 -y \d+ >\/dev\/null 2>&1 \|\| true; tmux set-hook -u -t my-session:0 client-attached\[\d+\]'$/,
    );
  });

  it('buildUnregisterClientAttachedReconcileArgs removes the exact numeric client-attached slot', () => {
    const registered = buildRegisterClientAttachedReconcileArgs('my-session:0', 'omx_attached_team_session_0_1', '%1');
    const unregistered = buildUnregisterClientAttachedReconcileArgs('my-session:0', 'omx_attached_team_session_0_1');
    assert.deepEqual(unregistered, ['set-hook', '-u', '-t', 'my-session:0', registered[3] as string]);
  });

  it('hook indices stay within signed 32-bit range (issue #240)', () => {
    // buildResizeHookSlot and buildClientAttachedHookSlot must produce indices
    // in [0, 2147483647) so tmux (signed 32-bit) does not overflow.
    const longName = 'omx_resize_' + 'a'.repeat(200);
    const resizeArgs = buildRegisterResizeHookArgs('sess:0', longName, '%1');
    const attachedArgs = buildRegisterClientAttachedReconcileArgs('sess:0', longName, '%1');

    const resizeSlot = resizeArgs[3] ?? '';
    const attachedSlot = attachedArgs[3] ?? '';

    const resizeIndex = Number((resizeSlot.match(/\[(\d+)\]/) ?? [])[1]);
    const attachedIndex = Number((attachedSlot.match(/\[(\d+)\]/) ?? [])[1]);

    assert.ok(resizeIndex >= 0, `resize index must be non-negative, got ${resizeIndex}`);
    assert.ok(resizeIndex < 2147483647, `resize index must be < 2^31-1, got ${resizeIndex}`);
    assert.ok(attachedIndex >= 0, `attached index must be non-negative, got ${attachedIndex}`);
    assert.ok(attachedIndex < 2147483647, `attached index must be < 2^31-1, got ${attachedIndex}`);
  });

  it('hook indices are deterministic across calls', () => {
    const name = 'omx_resize_team_session_0_1';
    const a = buildRegisterResizeHookArgs('s:0', name, '%1');
    const b = buildRegisterResizeHookArgs('s:0', name, '%1');
    assert.equal(a[3], b[3]);

    const c = buildRegisterClientAttachedReconcileArgs('s:0', name, '%1');
    const d = buildRegisterClientAttachedReconcileArgs('s:0', name, '%1');
    assert.equal(c[3], d[3]);
  });

  it('buildScheduleDelayedHudResizeArgs schedules tmux-side delayed reconcile', () => {
    assert.deepEqual(
      buildScheduleDelayedHudResizeArgs('%1'),
      ['run-shell', '-b', `sleep ${HUD_RESIZE_RECONCILE_DELAY_SECONDS}; tmux resize-pane -t %1 -y ${HUD_TMUX_TEAM_HEIGHT_LINES} >/dev/null 2>&1 || true`],
    );
  });

  it('buildReconcileHudResizeArgs executes a best-effort quiet resize command', () => {
    const args = buildReconcileHudResizeArgs('%7');
    assert.equal(args.join(' ').includes('split-window'), false);
    assert.deepEqual(
      args,
      ['run-shell', `tmux resize-pane -t %7 -y ${HUD_TMUX_TEAM_HEIGHT_LINES} >/dev/null 2>&1 || true`],
    );
  });

  it('resolves the tmux executable for win32 hook shell snippets', async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-win32-hook-tmux-'));
    const prevPath = process.env.PATH;
    const prevPathext = process.env.PATHEXT;
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      const tmuxPath = join(fakeBin, 'tmux.exe');
      await writeFile(tmuxPath, '');
      process.env.PATH = fakeBin;
      process.env.PATHEXT = '.EXE';
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      const resizeArgs = buildRegisterResizeHookArgs('my-session:0', 'omx_resize_team_session_0_1', '%1');
      const delayedArgs = buildScheduleDelayedHudResizeArgs('%1');
      const reconcileArgs = buildReconcileHudResizeArgs('%1');

      assert.match(resizeArgs[4] ?? '', new RegExp(escapeRegExp(tmuxPath)));
      assert.doesNotMatch(resizeArgs[4] ?? '', /^run-shell -b 'tmux resize-pane/);
      assert.match(delayedArgs[2] ?? '', new RegExp(escapeRegExp(tmuxPath)));
      assert.doesNotMatch(delayedArgs[2] ?? '', /sleep \d+; tmux resize-pane/);
      assert.match(reconcileArgs[1] ?? '', new RegExp(escapeRegExp(tmuxPath)));
      assert.doesNotMatch(reconcileArgs[1] ?? '', /^tmux resize-pane/);
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevPathext === 'string') process.env.PATHEXT = prevPathext;
      else delete process.env.PATHEXT;
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('resolves the tmux executable twice for win32 client-attached one-shot hooks', async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-win32-attached-hook-'));
    const prevPath = process.env.PATH;
    const prevPathext = process.env.PATHEXT;
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      const tmuxPath = join(fakeBin, 'tmux.exe');
      await writeFile(tmuxPath, '');
      process.env.PATH = fakeBin;
      process.env.PATHEXT = '.EXE';
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      const args = buildRegisterClientAttachedReconcileArgs('my-session:0', 'omx_attached_team_session_0_1', '%1');
      const matches = (args[4] ?? '').match(new RegExp(escapeRegExp(tmuxPath), 'g')) || [];
      assert.equal(matches.length, 2, 'client-attached hook should resolve tmux for both resize and unregister commands');
      assert.doesNotMatch(args[4] ?? '', /; tmux set-hook -u -t my-session:0 client-attached/);
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevPathext === 'string') process.env.PATHEXT = prevPathext;
      else delete process.env.PATHEXT;
      await rm(fakeBin, { recursive: true, force: true });
    }
  });
});


describe('evaluateStartupDirectTriggerSafetyCapture', () => {
  it('allows startup direct triggers on a ready prompt or Codex viewport', () => {
    assert.deepEqual(evaluateStartupDirectTriggerSafetyCapture(READY_HELPER_CAPTURE, 'codex'), {
      safe: true,
      reason: 'ready_prompt',
    });
    assert.deepEqual(evaluateStartupDirectTriggerSafetyCapture(VIEWPORT_WITHOUT_VISIBLE_PROMPT_CAPTURE, 'codex'), {
      safe: true,
      reason: 'codex_viewport',
    });
  });

  it('blocks startup direct triggers through trust and Claude bypass prompts', () => {
    assert.deepEqual(evaluateStartupDirectTriggerSafetyCapture(`Do you trust the contents of this directory?
Press enter to continue`, 'codex'), {
      safe: false,
      reason: 'trust_prompt',
    });
    assert.deepEqual(evaluateStartupDirectTriggerSafetyCapture(CLAUDE_BYPASS_PROMPT_CAPTURE, 'claude'), {
      safe: false,
      reason: 'claude_bypass_prompt',
    });
  });
});

describe('sendToWorker validation', () => {
  it('rejects text over 200 chars', async () => {
    await assert.rejects(
      sendToWorker('omx-team-x', 1, 'a'.repeat(200)),
      /< 200/i
    );
  });

  it('rejects empty/whitespace text', async () => {
    await assert.rejects(
      sendToWorker('omx-team-x', 1, '   '),
      /non-empty/i
    );
  });

  it('rejects injection marker', async () => {
    await assert.rejects(
      sendToWorker('omx-team-x', 1, `hello [OMX_TMUX_INJECT]`),
      /marker/i
    );
  });

  it('auto-accepts the Claude bypass prompt before sending worker text', async () => {
    await withMockTmuxFixture(
      'omx-tmux-claude-bypass-send-',
      (logPath) => `#!/bin/sh
set -eu
state_dir="$(dirname "${logPath}")"
accepted_file="$state_dir/accepted"
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    if [ -f "$accepted_file" ]; then
      cat <<'EOF'
How can I help you today?
EOF
    else
      cat <<'EOF'
${CLAUDE_BYPASS_PROMPT_CAPTURE}
EOF
    fi
    exit 0
    ;;
  send-keys)
    if [ "\${4:-}" = "-l" ] && [ "\${6:-}" = "2" ]; then
      : > "$accepted_file"
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
      async ({ logPath }) => {
        await sendToWorker('omx-team-x', 1, 'check inbox');
        const log = await readFile(logPath, 'utf-8');
        const acceptIndex = log.indexOf('send-keys -t omx-team-x:1 -l -- 2');
        const submitIndex = log.indexOf('send-keys -t omx-team-x:1 -l -- check inbox');
        assert.notEqual(acceptIndex, -1, `expected bypass acceptance in log:\n${log}`);
        assert.notEqual(submitIndex, -1, `expected worker text submission in log:\n${log}`);
        assert.ok(acceptIndex < submitIndex, `expected bypass acceptance before worker text:\n${log}`);
      },
    );
  });

  it('ignores stale queued-next-tool-call banner text that only survives in scrollback history', async () => {
    await withMockTmuxFixture(
      'omx-tmux-codex-stale-queued-scrollback-',
      (logPath) => `#!/bin/sh
set -eu
state_dir="$(dirname "${logPath}")"
text_sent_file="$state_dir/text-sent"
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    if printf '%s\n' "$*" | grep -q -- ' -S -80'; then
      if [ -f "$text_sent_file" ]; then
        cat <<'EOF'
${QUEUED_AFTER_TOOL_CALL_CAPTURE}
EOF
      else
        cat <<'EOF'
${READY_HELPER_CAPTURE}
EOF
      fi
    else
      cat <<'EOF'
${READY_HELPER_CAPTURE}
EOF
    fi
    exit 0
    ;;
  send-keys)
    if [ "\${4:-}" = "-l" ] && [ "\${6:-}" = "check inbox" ]; then
      : > "$text_sent_file"
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
      async ({ logPath }) => {
        await sendToWorker('omx-team-x', 1, 'check inbox');
        const log = await readFile(logPath, 'utf-8');
        const enterCount = (log.match(/send-keys -t omx-team-x:1 C-m/g) || []).length;
        assert.equal(
          enterCount,
          2,
          `expected only the baseline submit presses when the queued banner is stale scrollback:\n${log}`,
        );
        assert.match(log, /capture-pane -t omx-team-x:1 -p/);
        assert.match(log, /capture-pane -t omx-team-x:1 -p -S -80/);
      },
    );
  });

  it('keeps nudging Codex when the visible pane still shows a live queued-next-tool-call banner', async () => {
    await withMockTmuxFixture(
      'omx-tmux-codex-visible-queued-submit-',
      (logPath) => `#!/bin/sh
set -eu
state_dir="$(dirname "${logPath}")"
text_sent_file="$state_dir/text-sent"
enter_count_file="$state_dir/enter-count"
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    enter_count=0
    if [ -f "$enter_count_file" ]; then
      enter_count=$(cat "$enter_count_file")
    fi
    if printf '%s\n' "$*" | grep -q -- ' -S -80'; then
      cat <<'EOF'
${READY_HELPER_CAPTURE}
EOF
    else
      if [ "$enter_count" -ge 4 ]; then
        cat <<'EOF'
initialized in .

◦ Waiting for background terminal (59s…)
EOF
      elif [ -f "$text_sent_file" ]; then
        cat <<'EOF'
${QUEUED_AFTER_TOOL_CALL_CAPTURE}
EOF
      else
        cat <<'EOF'
${READY_HELPER_CAPTURE}
EOF
      fi
    fi
    exit 0
    ;;
  send-keys)
    if [ "\${4:-}" = "-l" ] && [ "\${6:-}" = "check inbox" ]; then
      : > "$text_sent_file"
    fi
    if [ "\${4:-}" = "C-m" ]; then
      enter_count=0
      if [ -f "$enter_count_file" ]; then
        enter_count=$(cat "$enter_count_file")
      fi
      enter_count=$((enter_count + 1))
      printf '%s' "$enter_count" > "$enter_count_file"
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
      async ({ logPath }) => {
        await sendToWorker('omx-team-x', 1, 'check inbox');
        const log = await readFile(logPath, 'utf-8');
        const enterCount = (log.match(/send-keys -t omx-team-x:1 C-m/g) || []).length;
        assert.ok(
          enterCount >= 4,
          `expected extra submit nudges when Codex queues the trigger:\n${log}`,
        );
      },
    );
  });

  it('fails closed when the visible queued-next-tool-call banner never clears after the final submit round', async () => {
    await withMockTmuxFixture(
      'omx-tmux-codex-stuck-queued-submit-',
      (logPath) => `#!/bin/sh
set -eu
state_dir="$(dirname "${logPath}")"
text_sent_file="$state_dir/text-sent"
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    if printf '%s\n' "$*" | grep -q -- ' -S -80'; then
      cat <<'EOF'
${READY_HELPER_CAPTURE}
EOF
    else
      if [ -f "$text_sent_file" ]; then
        cat <<'EOF'
${QUEUED_AFTER_TOOL_CALL_CAPTURE}
EOF
      else
        cat <<'EOF'
${READY_HELPER_CAPTURE}
EOF
      fi
    fi
    exit 0
    ;;
  send-keys)
    if [ "\${4:-}" = "-l" ] && [ "\${6:-}" = "check inbox" ]; then
      : > "$text_sent_file"
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
      async ({ logPath }) => {
        await assert.rejects(
          () => sendToWorker('omx-team-x', 1, 'check inbox'),
          /submit_queued_after_tool_call/,
        );
        const log = await readFile(logPath, 'utf-8');
        const enterCount = (log.match(/send-keys -t omx-team-x:1 C-m/g) || []).length;
        assert.ok(
          enterCount >= 4,
          `expected repeated submit nudges before failing closed on stuck queued banner:\n${log}`,
        );
      },
    );
  });

  it('does not confirm delivery while a wrapped hyphenated trigger remains as an unsent draft', async () => {
    const trigger = 'Read .omx/state/team/team-x/workers/worker-1/inbox.md';
    await withMockTmuxFixture(
      'omx-tmux-codex-wrapped-trigger-draft-',
      (logPath) => `#!/bin/sh
set -eu
state_dir="$(dirname "${logPath}")"
text_sent_file="$state_dir/text-sent"
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    if [ -f "$text_sent_file" ]; then
      cat <<'EOF'
${READY_HELPER_CAPTURE}

› Read .omx/state/team/team-x/workers/worker-
  1/inbox.md
EOF
    else
      cat <<'EOF'
${READY_HELPER_CAPTURE}
EOF
    fi
    exit 0
    ;;
  send-keys)
    if [ "\${4:-}" = "-l" ] && [ "\${6:-}" = "${trigger}" ]; then
      : > "$text_sent_file"
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
      async ({ logPath }) => {
        await assert.rejects(
          () => sendToWorker('omx-team-x', 1, trigger),
          /submit_failed/,
        );
        const log = await readFile(logPath, 'utf-8');
        const enterCount = (log.match(/send-keys -t omx-team-x:1 C-m/g) || []).length;
        assert.ok(
          enterCount >= 4,
          `expected repeated submit nudges before failing on the still-visible wrapped draft:\n${log}`,
        );
      },
    );
  });
});

describe('sendToWorker adaptive retry matching', () => {
  it('recognizes hyphen-wrapped trigger drafts as still visible', () => {
    assert.equal(
      shouldAttemptAdaptiveRetry(
        'auto',
        true,
        true,
        `${READY_HELPER_CAPTURE}\n\n› Read .omx/state/team/team-x/workers/worker-\n  1/inbox.md`,
        'Read .omx/state/team/team-x/workers/worker-1/inbox.md',
      ),
      true,
    );
  });
});

describe('startup direct trigger safety', () => {
  it('classifies ready panes as safe and blocks trust, bypass, bootstrapping, and active-task captures', () => {
    assert.equal(classifyWorkerStartupInjectSafety(READY_HELPER_CAPTURE), 'safe');
    assert.equal(
      classifyWorkerStartupInjectSafety('Do you trust the contents of this directory?\nPress enter to continue'),
      'trust_prompt',
    );
    assert.equal(classifyWorkerStartupInjectSafety(CLAUDE_BYPASS_PROMPT_CAPTURE), 'claude_bypass_prompt');
    assert.equal(classifyWorkerStartupInjectSafety('OpenAI Codex\nmodel: loading'), 'bootstrapping');
    assert.equal(
      classifyWorkerStartupInjectSafety('OpenAI Codex\nmodel: test\n• Running tests (esc to interrupt)'),
      'active_task',
    );
  });

  it('checks visible pane first and refuses direct injection through a trust prompt', async () => {
    await withMockTmuxFixture(
      'omx-tmux-startup-direct-trust-',
      (logPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    cat <<'EOF'
Do you trust the contents of this directory?
Press enter to continue
EOF
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
      async ({ logPath }) => {
        assert.deepEqual(
          await checkWorkerStartupInjectSafety('omx-team-x', 1),
          { safe: false, reason: 'trust_prompt' },
        );
        const log = await readFile(logPath, 'utf-8');
        assert.doesNotMatch(log, /send-keys/);
      },
    );
  });
});

describe('shouldAttemptAdaptiveRetry', () => {
  it('returns false when adaptive retry is disabled', () => {
    assert.equal(
      shouldAttemptAdaptiveRetry('auto', true, false, '❯ hello', 'hello'),
      false,
    );
  });

  it('returns false when strategy is not auto', () => {
    assert.equal(
      shouldAttemptAdaptiveRetry('queue', true, true, '❯ hello', 'hello'),
      false,
    );
  });

  it('returns false when pane was not initially busy', () => {
    assert.equal(
      shouldAttemptAdaptiveRetry('auto', false, true, '❯ hello', 'hello'),
      false,
    );
  });

  it('returns false when trigger text is missing from latest capture', () => {
    assert.equal(
      shouldAttemptAdaptiveRetry('auto', true, true, '❯ ready prompt', 'hello'),
      false,
    );
  });

  it('returns false when latest capture still shows active task markers', () => {
    const activeCapture = '• Doing work (2m 10s • esc to interrupt)\n❯ hello';
    assert.equal(
      shouldAttemptAdaptiveRetry('auto', true, true, activeCapture, 'hello'),
      false,
    );
  });

  it('returns false when latest capture shows Claude active generation line', () => {
    const activeCapture = '· Caramelizing…\n❯ hello';
    assert.equal(
      shouldAttemptAdaptiveRetry('auto', true, true, activeCapture, 'hello'),
      false,
    );
  });

  it('returns false when latest capture shows Claude apostrophe generation line', () => {
    const activeCapture = "· Beboppin'...\n❯ hello";
    assert.equal(
      shouldAttemptAdaptiveRetry('auto', true, true, activeCapture, 'hello'),
      false,
    );
  });

  it('returns false when latest capture shows Claude sparkle generation line', () => {
    const activeCapture = '✻ Pollinating…\n❯ hello';
    assert.equal(
      shouldAttemptAdaptiveRetry('auto', true, true, activeCapture, 'hello'),
      false,
    );
  });

  it('returns false when latest capture shows background terminal running status', () => {
    const activeCapture = '2 background terminal running\n❯ hello';
    assert.equal(
      shouldAttemptAdaptiveRetry('auto', true, true, activeCapture, 'hello'),
      false,
    );
  });

  it('does not treat non-ellipsis Claude bullet text as active generation', () => {
    const readyCapture = '· Caramelizing\n❯ hello';
    assert.equal(
      shouldAttemptAdaptiveRetry('auto', true, true, readyCapture, 'hello'),
      true,
    );
  });

  it('returns true only when auto+busy and latest capture is ready with visible text', () => {
    const readyCapture = '❯ hello';
    assert.equal(
      shouldAttemptAdaptiveRetry('auto', true, true, readyCapture, 'hello'),
      true,
    );
  });
});

describe('paneIsBootstrapping (#391)', () => {
  it('detects "loading" keyword', () => {
    assert.equal(paneIsBootstrapping(['loading model weights…']), true);
  });

  it('detects "model: loading" pattern', () => {
    assert.equal(paneIsBootstrapping(['gpt-4o', 'model: loading']), true);
  });

  it('detects "initializing" keyword', () => {
    assert.equal(paneIsBootstrapping(['Initializing workspace']), true);
  });

  it('detects "connecting to" keyword', () => {
    assert.equal(paneIsBootstrapping(['connecting to server']), true);
  });

  it('returns false for normal ready prompt', () => {
    assert.equal(paneIsBootstrapping(['› ']), false);
  });

  it('returns false for status bar without loading', () => {
    assert.equal(paneIsBootstrapping(['gpt-4o', '50% left', '› ']), false);
  });
});

describe('paneLooksReady gate: status-only is not ready (#391)', () => {
  // These verify the fix for #391: status bar markers alone (gpt-*, % left,
  // Claude Code v*) must NOT count as ready without a prompt character.
  // We test indirectly via shouldAttemptAdaptiveRetry since paneLooksReady is
  // not exported, but the adaptive retry guard calls paneLooksReady internally.
  it('shouldAttemptAdaptiveRetry returns false for status-only capture (no prompt)', () => {
    // Capture has Codex status bar but no prompt character — paneLooksReady
    // should return false, so adaptive retry should also return false.
    const statusOnlyCapture = 'gpt-4o  50% left';
    assert.equal(
      shouldAttemptAdaptiveRetry('auto', true, true, statusOnlyCapture, 'gpt-4o'),
      false,
    );
  });

  it('shouldAttemptAdaptiveRetry returns false for Claude status-only capture', () => {
    const statusOnlyCapture = 'Claude Code v1.2.3  claude-sonnet-4-20250514';
    assert.equal(
      shouldAttemptAdaptiveRetry('auto', true, true, statusOnlyCapture, 'Claude Code'),
      false,
    );
  });

  it('shouldAttemptAdaptiveRetry returns false when pane is bootstrapping', () => {
    const loadingCapture = 'gpt-4o\nmodel: loading\n› hello';
    assert.equal(
      shouldAttemptAdaptiveRetry('auto', true, true, loadingCapture, 'hello'),
      false,
    );
  });

  it('shouldAttemptAdaptiveRetry treats issue-only prompt as ready even without glyph', () => {
    const issuePromptCapture = 'IND-123 only...';
    assert.equal(
      shouldAttemptAdaptiveRetry('auto', true, true, issuePromptCapture, 'IND-123 only...'),
      true,
    );
  });
});

describe('buildWorkerStartupCommand', () => {
  it('auto-selects gemini worker CLI from gemini model', () => {
    const prevShell = process.env.SHELL;
    const prevCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.SHELL = '/bin/bash';
    delete process.env.OMX_TEAM_WORKER_CLI; // auto
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = buildWorkerStartupCommand(
        'alpha',
        1,
        ['--model', 'gemini-2.0-pro'],
        process.cwd(),
        {},
        undefined,
        'Read worker inbox',
      );
      assert.match(cmd, /exec .*gemini/);
      assert.match(cmd, /--approval-mode/);
      assert.match(cmd, /yolo/);
      assert.match(cmd, /--model/);
      assert.match(cmd, /gemini-2.0-pro/);
      assert.match(cmd, /(?:^|\s|')-i(?:'|\s|$)/);
      assert.match(cmd, /Read worker inbox/);
      assert.match(cmd, /Read worker inbox/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('scrubs HUD ownership env from interactive worker startup commands', () => {
    const prevShell = process.env.SHELL;
    const prevCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevHudOwner = process.env.OMX_TMUX_HUD_OWNER;
    const prevHudLeaderPane = process.env.OMX_TMUX_HUD_LEADER_PANE;
    process.env.SHELL = '/bin/bash';
    process.env.OMX_TEAM_WORKER_CLI = 'codex';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.env.OMX_TMUX_HUD_OWNER = '1';
    process.env.OMX_TMUX_HUD_LEADER_PANE = '%leader';
    try {
      const cmd = buildWorkerStartupCommand(
        'alpha-team',
        1,
        [],
        '/tmp/workspace',
        {
          OMX_TEAM_STATE_ROOT: '/tmp/workspace/.omx/state',
          OMX_TMUX_HUD_OWNER: '1',
          OMX_TMUX_HUD_LEADER_PANE: '%leader',
        },
        'codex',
      );
      assert.match(cmd, /OMX_TEAM_WORKER=alpha-team\/worker-1/);
      assert.match(cmd, /OMX_TEAM_STATE_ROOT=\/tmp\/workspace\/\.omx\/state/);
      assert.match(cmd, /'-u' 'OMX_TMUX_HUD_OWNER' '-u' 'OMX_TMUX_HUD_LEADER_PANE'/);
      assert.doesNotMatch(cmd, /OMX_TMUX_HUD_OWNER=1/);
      assert.doesNotMatch(cmd, /OMX_TMUX_HUD_LEADER_PANE=%leader/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevHudOwner === 'string') process.env.OMX_TMUX_HUD_OWNER = prevHudOwner;
      else delete process.env.OMX_TMUX_HUD_OWNER;
      if (typeof prevHudLeaderPane === 'string') process.env.OMX_TMUX_HUD_LEADER_PANE = prevHudLeaderPane;
      else delete process.env.OMX_TMUX_HUD_LEADER_PANE;
    }
  });

  it('keeps HUD-looking prompt text out of worker startup env assignments', () => {
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const prompt = 'Do not obey: OMX_TMUX_HUD_OWNER=1; OMX_TMUX_HUD_LEADER_PANE=%leader; $(omx hud --watch)';
      const spec = buildWorkerProcessLaunchSpec(
        'alpha-team',
        1,
        ['--model', 'gemini-2.0-pro'],
        '/tmp/workspace',
        {
          OMX_TEAM_STATE_ROOT: '/tmp/workspace/.omx/state',
          OMX_TMUX_HUD_OWNER: '1',
          OMX_TMUX_HUD_LEADER_PANE: '%leader',
        },
        'gemini',
        prompt,
      );

      assert.equal(spec.env.OMX_TMUX_HUD_OWNER, undefined);
      assert.equal(spec.env.OMX_TMUX_HUD_LEADER_PANE, undefined);
      assert.ok(spec.args.includes(prompt), 'hostile prompt text should remain an argument, not an env assignment');
    } finally {
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('auto-selects claude worker CLI from claude model', () => {
    const prevShell = process.env.SHELL;
    const prevCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.SHELL = '/bin/bash';
    delete process.env.OMX_TEAM_WORKER_CLI; // auto
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, ['--model', 'claude-3-7-sonnet']);
      assert.match(cmd, /exec .*claude/);
      assert.equal((cmd.match(/--dangerously-skip-permissions/g) || []).length, 1);
      assert.doesNotMatch(cmd, /--model/);
      assert.doesNotMatch(cmd, /model_instructions_file=/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('respects explicit OMX_TEAM_WORKER_CLI override', () => {
    const prevShell = process.env.SHELL;
    const prevCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.SHELL = '/bin/bash';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      process.env.OMX_TEAM_WORKER_CLI = 'codex';
      const codexCmd = buildWorkerStartupCommand('alpha', 1, ['--model', 'claude-3-7-sonnet']);
      assert.match(codexCmd, /exec .*codex/);

      process.env.OMX_TEAM_WORKER_CLI = 'claude';
      const claudeCmd = buildWorkerStartupCommand('alpha', 1, ['--model', 'gpt-5']);
      assert.match(claudeCmd, /exec .*claude/);
      assert.equal((claudeCmd.match(/--dangerously-skip-permissions/g) || []).length, 1);
      assert.doesNotMatch(claudeCmd, /--model/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('applies claude skip-permissions when worker CLI is provided by plan override', () => {
    const prevShell = process.env.SHELL;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.SHELL = '/bin/bash';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = buildWorkerStartupCommand(
        'alpha',
        1,
        ['--model', 'gpt-5', '--dangerously-bypass-approvals-and-sandbox'],
        process.cwd(),
        {},
        'claude',
      );
      assert.match(cmd, /exec .*claude/);
      assert.equal((cmd.match(/--dangerously-skip-permissions/g) || []).length, 1);
      assert.doesNotMatch(cmd, /dangerously-bypass-approvals-and-sandbox/);
      assert.doesNotMatch(cmd, /--model/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('drops all explicit launch args for claude workers', () => {
    const prevShell = process.env.SHELL;
    const prevCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.SHELL = '/bin/bash';
    process.env.OMX_TEAM_WORKER_CLI = 'claude';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, [
        '--dangerously-bypass-approvals-and-sandbox',
        '-c', 'model_instructions_file="/tmp/custom.md"',
        '--model', 'claude-3-7-sonnet',
      ]);
      assert.match(cmd, /exec .*claude/);
      assert.equal((cmd.match(/--dangerously-skip-permissions/g) || []).length, 1);
      assert.doesNotMatch(cmd, /dangerously-bypass-approvals-and-sandbox/);
      assert.doesNotMatch(cmd, /model_instructions_file=/);
      assert.doesNotMatch(cmd, /--model/);
      assert.doesNotMatch(cmd, /claude-3-7-sonnet/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('does not pass bypass flags in claude mode', () => {
    const prevArgv = process.argv;
    const prevShell = process.env.SHELL;
    const prevCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.SHELL = '/bin/bash';
    process.env.OMX_TEAM_WORKER_CLI = 'claude';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.argv = ['node', 'omx', '--madmax'];
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1);
      assert.match(cmd, /exec .*claude/);
      assert.equal((cmd.match(/--dangerously-skip-permissions/g) || []).length, 1);
      assert.doesNotMatch(cmd, /dangerously-bypass-approvals-and-sandbox/);
    } finally {
      process.argv = prevArgv;
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('uses zsh without sourcing ~/.zshrc by default and keeps non-login exec semantics', () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/zsh';
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = withMockedExistsSync((candidate) => candidate === '/bin/zsh', () =>
        buildWorkerStartupCommand('alpha', 2),
      );
      assert.match(cmd, /OMX_TEAM_WORKER=alpha\/worker-2/);
      assert.match(cmd, /'\/bin\/zsh' -c/);
      assert.doesNotMatch(cmd, /'\/bin\/zsh' -lc\b/);
      assert.doesNotMatch(cmd, /source ~\/\.zshrc/);
      assert.match(cmd, /exec .*codex/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('accepts Homebrew zsh as a supported worker shell without falling back', () => {
    const prevShell = process.env.SHELL;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.SHELL = '/opt/homebrew/bin/zsh';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = withMockedExistsSync((candidate) => candidate === '/opt/homebrew/bin/zsh', () =>
        buildWorkerStartupCommand('alpha', 2),
      );
      assert.match(cmd, /'\/opt\/homebrew\/bin\/zsh' -c/);
      assert.doesNotMatch(cmd, /'\/bin\/sh' -c/);
      assert.doesNotMatch(cmd, /source ~\/\.zshrc/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('accepts MacPorts zsh as a supported worker shell without falling back', () => {
    const prevShell = process.env.SHELL;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.SHELL = '/opt/local/bin/zsh';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = withMockedExistsSync((candidate) => candidate === '/opt/local/bin/zsh', () =>
        buildWorkerStartupCommand('alpha', 2),
      );
      assert.match(cmd, /'\/opt\/local\/bin\/zsh' -c/);
      assert.doesNotMatch(cmd, /'\/bin\/sh' -c/);
      assert.doesNotMatch(cmd, /source ~\/\.zshrc/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('prevents issue #2358 bash rc fan-out by default and preserves launch args', () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, ['--model', 'gpt-5']);
      assert.doesNotMatch(cmd, /source ~\/\.bashrc/);
      assert.match(cmd, /exec .*codex/);
      assert.match(cmd, /--model/);
      assert.match(cmd, /gpt-5/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('sources worker shell rc files only when explicitly opted in', () => {
    const prevShell = process.env.SHELL;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevSourceRc = process.env.OMX_TMUX_SOURCE_SHELL_RC;
    process.env.SHELL = '/bin/bash';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      delete process.env.OMX_TMUX_SOURCE_SHELL_RC;
      assert.equal(shouldSourceTeamWorkerShellRc(process.env), false);
      assert.doesNotMatch(
        buildWorkerStartupCommand('alpha', 1, ['--model', 'gpt-5']),
        /source ~\/\.bashrc/,
      );

      process.env.OMX_TMUX_SOURCE_SHELL_RC = '1';
      assert.equal(shouldSourceTeamWorkerShellRc(process.env), true);
      assert.match(
        buildWorkerStartupCommand('alpha', 1, ['--model', 'gpt-5']),
        /source ~\/\.bashrc/,
      );

      delete process.env.OMX_TMUX_SOURCE_SHELL_RC;
      assert.match(
        buildWorkerStartupCommand(
          'alpha',
          1,
          ['--model', 'gpt-5'],
          process.cwd(),
          { OMX_TMUX_SOURCE_SHELL_RC: '1' },
        ),
        /source ~\/\.bashrc/,
        'per-worker explicit opt-in should be honored',
      );
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevSourceRc === 'string') process.env.OMX_TMUX_SOURCE_SHELL_RC = prevSourceRc;
      else delete process.env.OMX_TMUX_SOURCE_SHELL_RC;
    }
  });

  it('injects canonical team state env vars when provided', () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = buildWorkerStartupCommand(
        'alpha',
        1,
        [],
        '/tmp/worker-cwd',
        {
          OMX_TEAM_STATE_ROOT: '/tmp/leader/.omx/state',
          OMX_TEAM_LEADER_CWD: '/tmp/leader',
        },
      );
      assert.match(cmd, /OMX_TEAM_STATE_ROOT=\/tmp\/leader\/\.omx\/state/);
      assert.match(cmd, /OMX_TEAM_LEADER_CWD=\/tmp\/leader/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('uses a generated startup script with MSYS paths on win32/MSYS', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const prevMsystem = process.env.MSYSTEM;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const stateRoot = 'C:\\omx-state';
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      process.env.MSYSTEM = 'MINGW64';
      process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
      const cmd = writeWorkerStartupScriptCommand(
        'alpha',
        1,
        ['--model', 'gpt-5'],
        'C:\\repo',
        { OMX_TEAM_STATE_ROOT: stateRoot },
        'gemini',
      );
      assert.equal(cmd, `exec /bin/sh '/c/omx-state/team/alpha/runtime/worker-1-startup.sh'`);
      const script = await readFile(join(stateRoot, 'team', 'alpha', 'runtime', 'worker-1-startup.sh'), 'utf-8');
      assert.match(script, /^cd '\/c\/repo'$/m);
      assert.match(script, /^exec '\/bin\/sh' -c /m);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
      if (typeof prevMsystem === 'string') process.env.MSYSTEM = prevMsystem;
      else delete process.env.MSYSTEM;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('does not emit cmd.exe flag wrappers for MSYS startup scripts with cmd shims', async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), 'omx-worker-startup-msys-cmd-shim-'));
    const fakeBin = join(fakeRoot, 'bin dir');
    const stateRoot = join(fakeRoot, 'state root');
    const startupScriptPath = join(stateRoot, 'team', 'alpha', 'runtime', 'worker-1-startup.sh');
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const prevPath = process.env.PATH;
    const prevPathext = process.env.PATHEXT;
    const prevMsystem = process.env.MSYSTEM;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    try {
      await mkdir(fakeBin, { recursive: true });
      const geminiCmdPath = join(fakeBin, 'gemini.cmd');
      await writeFile(geminiCmdPath, '@echo off\r\n');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      process.env.PATH = fakeBin;
      process.env.PATHEXT = '.CMD';
      process.env.MSYSTEM = 'MINGW64';
      process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';

      const cmd = writeWorkerStartupScriptCommand(
        'alpha',
        1,
        ['--model', 'gemini-2.5-pro'],
        'C:\\repo with space',
        { OMX_TEAM_STATE_ROOT: stateRoot },
        'gemini',
      );

      assert.equal(cmd, `exec /bin/sh '${startupScriptPath}'`);
      const script = await readFile(startupScriptPath, 'utf-8');
      assert.doesNotMatch(script, /cmd\.exe/i);
      assert.doesNotMatch(script, /'\/d'|'\/s'|'\/c'|\s\/d\s|\s\/s\s|\s\/c\s/i);
      assert.match(script, /^cd '\/c\/repo with space'$/m);
      assert.match(script, /^exec '\/bin\/sh' -c /m);
      assert.match(script, new RegExp(escapeRegExp(geminiCmdPath)));
      assert.match(script, /--approval-mode/);
      assert.match(script, /yolo/);
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevPathext === 'string') process.env.PATHEXT = prevPathext;
      else delete process.env.PATHEXT;
      if (typeof prevMsystem === 'string') process.env.MSYSTEM = prevMsystem;
      else delete process.env.MSYSTEM;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('wraps MSYS prompt worker cmd shims for shell-free Windows spawn', async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), 'omx-worker-process-msys-bat-shim-'));
    const fakeBin = join(fakeRoot, 'bin dir');
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const prevPath = process.env.PATH;
    const prevPathext = process.env.PATHEXT;
    const prevMsystem = process.env.MSYSTEM;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevComSpec = process.env.ComSpec;
    try {
      await mkdir(fakeBin, { recursive: true });
      const geminiBatPath = join(fakeBin, 'gemini.bat');
      await writeFile(geminiBatPath, '@echo off\r\n');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      process.env.PATH = fakeBin;
      process.env.PATHEXT = '.BAT';
      process.env.MSYSTEM = 'MINGW64';
      process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
      process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';

      const spec = buildWorkerProcessLaunchSpec(
        'alpha',
        1,
        ['--model', 'gemini-2.5-pro'],
        'C:\\repo with space',
        {},
        'gemini',
      );

      assert.equal(spec.command, 'C:\\Windows\\System32\\cmd.exe');
      assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c']);
      assert.match(spec.args[3] ?? '', new RegExp(escapeRegExp(geminiBatPath)));
      assert.match(spec.args[3] ?? '', /--approval-mode/);
      assert.match(spec.args[3] ?? '', /yolo/);
      assert.equal(spec.env.OMX_LEADER_CLI_PATH, geminiBatPath);
      assert.notEqual(spec.command, geminiBatPath);
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevPathext === 'string') process.env.PATHEXT = prevPathext;
      else delete process.env.PATHEXT;
      if (typeof prevMsystem === 'string') process.env.MSYSTEM = prevMsystem;
      else delete process.env.MSYSTEM;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevComSpec === 'string') process.env.ComSpec = prevComSpec;
      else delete process.env.ComSpec;
    }
  });

  it('writes a short worker startup script under team runtime state when available', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-worker-startup-script-'));
    const stateRoot = join(wd, '.omx', 'state');
    const prevShell = process.env.SHELL;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevHudOwner = process.env.OMX_TMUX_HUD_OWNER;
    const prevHudLeaderPane = process.env.OMX_TMUX_HUD_LEADER_PANE;
    process.env.SHELL = '/bin/bash';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.env.OMX_TMUX_HUD_OWNER = '1';
    process.env.OMX_TMUX_HUD_LEADER_PANE = '%leader';
    try {
      const cmd = writeWorkerStartupScriptCommand(
        'alpha',
        1,
        ['--model', 'gpt-5'],
        wd,
        {
          OMX_TEAM_STATE_ROOT: stateRoot,
          OMX_TEAM_LEADER_CWD: wd,
          OMX_TMUX_HUD_OWNER: '1',
          OMX_TMUX_HUD_LEADER_PANE: '%leader',
        },
        'gemini',
      );
      assert.equal(cmd, `exec /bin/sh '${stateRoot}/team/alpha/runtime/worker-1-startup.sh'`);
      const script = await readFile(join(stateRoot, 'team', 'alpha', 'runtime', 'worker-1-startup.sh'), 'utf-8');
      assert.match(script, /^#!\/bin\/sh/m);
      assert.match(script, new RegExp(`cd '${wd.replace(/'/g, `'\\\\''`)}'`));
      assert.match(script, /^unset OMX_TMUX_HUD_OWNER OMX_TMUX_HUD_LEADER_PANE$/m);
      assert.match(script, /export OMX_TEAM_STATE_ROOT=/);
      assert.doesNotMatch(script, /^export OMX_TMUX_HUD_OWNER=/m);
      assert.doesNotMatch(script, /^export OMX_TMUX_HUD_LEADER_PANE=/m);
      assert.match(script, /exec '\/bin\/bash' -c /);
      assert.doesNotMatch(cmd ?? '', /OMX_TEAM_STATE_ROOT=/, 'tmux command should point at script instead of inlining env');
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevHudOwner === 'string') process.env.OMX_TMUX_HUD_OWNER = prevHudOwner;
      else delete process.env.OMX_TMUX_HUD_OWNER;
      if (typeof prevHudLeaderPane === 'string') process.env.OMX_TMUX_HUD_LEADER_PANE = prevHudLeaderPane;
      else delete process.env.OMX_TMUX_HUD_LEADER_PANE;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('trusts worktree .mise.toml before worker launch when mise is available', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-worker-mise-trust-'));
    const fakeBin = join(wd, 'bin');
    const logPath = join(wd, 'mise.log');
    const previousPath = process.env.PATH;
    try {
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(wd, '.mise.toml'), '[tools]\nnode = "latest"\n');
      await writeFile(
        join(fakeBin, 'mise'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logPath}'\nexit 0\n`,
      );
      await chmod(join(fakeBin, 'mise'), 0o755);
      process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
      assert.equal(trustWorkerMiseConfigIfAvailable(wd), true);
      assert.match(await readFile(logPath, 'utf-8'), new RegExp(`trust --yes ${wd.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\/\\.mise\\.toml`));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails soft when .mise.toml exists but mise is unavailable', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-worker-mise-missing-'));
    try {
      await writeFile(join(wd, '.mise.toml'), '[tools]\nnode = "latest"\n');
      withEmptyPath(() => {
        assert.equal(trustWorkerMiseConfigIfAvailable(wd), false);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('inherits only allowlisted ambient proxy env vars for tmux startup commands', () => {
    const prevShell = process.env.SHELL;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevHttpsProxy = process.env.HTTPS_PROXY;
    const prevHttpProxy = process.env.HTTP_PROXY;
    const prevNoProxy = process.env.NO_PROXY;
    const prevLowerHttpsProxy = process.env.https_proxy;
    const prevCustom = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.SHELL = '/bin/bash';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.env.HTTPS_PROXY = 'https://upper-proxy.example:443';
    process.env.HTTP_PROXY = 'http://upper-proxy.example:80';
    process.env.NO_PROXY = 'localhost,127.0.0.1';
    process.env.https_proxy = 'https://lower-proxy.example:443';
    process.env.AWS_SECRET_ACCESS_KEY = 'should-not-inherit';
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, [], '/tmp/project');
      assert.match(cmd, /HTTPS_PROXY=https:\/\/upper-proxy\.example:443/);
      assert.match(cmd, /HTTP_PROXY=http:\/\/upper-proxy\.example:80/);
      assert.match(cmd, /NO_PROXY=localhost,127\.0\.0\.1/);
      assert.match(cmd, /https_proxy=https:\/\/lower-proxy\.example:443/);
      assert.doesNotMatch(cmd, /AWS_SECRET_ACCESS_KEY=should-not-inherit/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevHttpsProxy === 'string') process.env.HTTPS_PROXY = prevHttpsProxy;
      else delete process.env.HTTPS_PROXY;
      if (typeof prevHttpProxy === 'string') process.env.HTTP_PROXY = prevHttpProxy;
      else delete process.env.HTTP_PROXY;
      if (typeof prevNoProxy === 'string') process.env.NO_PROXY = prevNoProxy;
      else delete process.env.NO_PROXY;
      if (typeof prevLowerHttpsProxy === 'string') process.env.https_proxy = prevLowerHttpsProxy;
      else delete process.env.https_proxy;
      if (typeof prevCustom === 'string') process.env.AWS_SECRET_ACCESS_KEY = prevCustom;
      else delete process.env.AWS_SECRET_ACCESS_KEY;
    }
  });

  it('preserves explicit worker env precedence over inherited ambient proxy vars', () => {
    const prevShell = process.env.SHELL;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevHttpsProxy = process.env.HTTPS_PROXY;
    process.env.SHELL = '/bin/bash';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.env.HTTPS_PROXY = 'https://ambient-proxy.example:443';
    try {
      const cmd = buildWorkerStartupCommand(
        'alpha',
        1,
        [],
        '/tmp/project',
        { HTTPS_PROXY: 'https://explicit-proxy.example:8443' },
      );
      assert.match(cmd, /HTTPS_PROXY=https:\/\/explicit-proxy\.example:8443/);
      assert.doesNotMatch(cmd, /HTTPS_PROXY=https:\/\/ambient-proxy\.example:443/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevHttpsProxy === 'string') process.env.HTTPS_PROXY = prevHttpsProxy;
      else delete process.env.HTTPS_PROXY;
    }
  });

  it('resolves POSIX leader paths before building fish worker startup commands', async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-worker-startup-posix-'));
    const prevPath = process.env.PATH;
    const prevShell = process.env.SHELL;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.PATH = fakeBin;
    process.env.SHELL = '/bin/fish';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const nodePath = join(fakeBin, 'node');
      const codexPath = join(fakeBin, 'codex');
      await writeFile(nodePath, '#!/bin/sh\n');
      await writeFile(codexPath, '#!/bin/sh\n');
      await chmod(nodePath, 0o755);
      await chmod(codexPath, 0o755);

      const { buildWorkerStartupCommand: buildFreshWorkerStartupCommand } = await import(`../tmux-session.js?posix-path=${Date.now()}`);
      const cmd = buildFreshWorkerStartupCommand(
        'alpha',
        1,
        ['-c', 'model_reasoning_effort="low"'],
        process.cwd(),
        {},
        'codex',
      );

      assert.match(cmd, new RegExp(escapeRegExp(`OMX_LEADER_NODE_PATH=${nodePath}`)));
      assert.match(cmd, new RegExp(escapeRegExp(`OMX_LEADER_CLI_PATH=${codexPath}`)));
      assert.match(cmd, new RegExp(escapeRegExp(`export PATH='\\''${fakeBin}'\\'':$PATH; exec '\\''${codexPath}'\\''`)));
      assert.doesNotMatch(cmd, /export PATH='\\''node'\\'':\$PATH/);
      assert.doesNotMatch(cmd, / exec codex(?:\s|')/);
    } finally {
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('inherits bypass flag from process argv once', () => {
    const prevArgv = process.argv;
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.argv = ['node', 'omx', '--dangerously-bypass-approvals-and-sandbox'];
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, ['--dangerously-bypass-approvals-and-sandbox']);
      const matches = cmd.match(/--dangerously-bypass-approvals-and-sandbox/g) || [];
      assert.equal(matches.length, 1);
    } finally {
      process.argv = prevArgv;
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('maps --madmax to bypass flag in worker command', () => {
    const prevArgv = process.argv;
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.argv = ['node', 'omx', '--madmax'];
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1);
      const matches = cmd.match(/--dangerously-bypass-approvals-and-sandbox/g) || [];
      assert.equal(matches.length, 1);
    } finally {
      process.argv = prevArgv;
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('preserves reasoning override args in worker command', () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, ['-c', 'model_reasoning_effort="xhigh"']);
      assert.match(cmd, /exec .*codex/);
      assert.match(cmd, /'-c'/);
      assert.match(cmd, /'model_reasoning_effort=\"xhigh\"'/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('forces codex bypass under explicit launch-arg profiles', () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const profiles = [
        ['--model', 'gpt-5', '-c', 'model_reasoning_effort="high"'],
        ['--model', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="low"'],
      ];

      for (const launchArgs of profiles) {
        const cmd = buildWorkerStartupCommand('alpha', 1, launchArgs, process.cwd(), {}, 'codex');
        assert.match(cmd, /exec .*codex/);
        assert.equal((cmd.match(/--dangerously-bypass-approvals-and-sandbox/g) || []).length, 1);
        assert.match(cmd, /--model/);
        assert.match(cmd, new RegExp(launchArgs[1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(cmd, new RegExp(launchArgs[3]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('supports worker-specific reasoning overrides for codex and strips them for claude workers', () => {
    const prevShell = process.env.SHELL;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.SHELL = '/bin/bash';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const codexCmd = buildWorkerStartupCommand('alpha', 1, ['-c', 'model_reasoning_effort="low"'], process.cwd(), {}, 'codex');
      const claudeCmd = buildWorkerStartupCommand('alpha', 2, ['-c', 'model_reasoning_effort="high"'], process.cwd(), {}, 'claude');
      assert.match(codexCmd, /exec .*codex/);
      assert.match(codexCmd, /'model_reasoning_effort="low"'/);
      assert.match(claudeCmd, /exec .*claude/);
      assert.equal((claudeCmd.match(/--dangerously-skip-permissions/g) || []).length, 1);
      assert.doesNotMatch(claudeCmd, /model_reasoning_effort/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('injects model_instructions_file override by default', () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevInstr = process.env.OMX_MODEL_INSTRUCTIONS_FILE;
    delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT; // default enabled
    delete process.env.OMX_MODEL_INSTRUCTIONS_FILE;
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, [], '/tmp/project');
      assert.match(cmd, /'-c'/);
      assert.match(cmd, /model_instructions_file=/);
      assert.match(cmd, /AGENTS\.md/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevInstr === 'string') process.env.OMX_MODEL_INSTRUCTIONS_FILE = prevInstr;
      else delete process.env.OMX_MODEL_INSTRUCTIONS_FILE;
    }
  });


  it('uses per-worker OMX_MODEL_INSTRUCTIONS_FILE from extraEnv when building process launch spec', () => {
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevInstr = process.env.OMX_MODEL_INSTRUCTIONS_FILE;
    delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    delete process.env.OMX_MODEL_INSTRUCTIONS_FILE;
    try {
      const spec = buildWorkerProcessLaunchSpec(
        'alpha',
        1,
        ['-c', 'model_reasoning_effort="low"'],
        '/tmp/project',
        { OMX_MODEL_INSTRUCTIONS_FILE: '/tmp/project/.omx/state/team/alpha/workers/worker-1/AGENTS.md' },
        'codex',
      );
      const joined = spec.args.join(' ');
      assert.match(joined, /model_reasoning_effort="low"/);
      assert.match(joined, /model_instructions_file="\/tmp\/project\/.omx\/state\/team\/alpha\/workers\/worker-1\/AGENTS\.md"/);
    } finally {
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevInstr === 'string') process.env.OMX_MODEL_INSTRUCTIONS_FILE = prevInstr;
      else delete process.env.OMX_MODEL_INSTRUCTIONS_FILE;
    }
  });

  it('recognizes every model-instructions config spelling before -- and ignores positional suffixes', () => {
    const previousBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const customOverride = 'model_instructions_file="/tmp/custom.md"';
    const configForms = [
      ['-c', customOverride],
      ['--config', customOverride],
      [`-c=${customOverride}`],
      [`--config=${customOverride}`],
    ];
    delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    try {
      for (const launchArgs of configForms) {
        const spec = buildWorkerProcessLaunchSpec('alpha', 1, launchArgs, '/tmp/project', {}, 'codex', undefined, 'explore');
        assert.equal(spec.args.filter((arg) => arg.includes('model_instructions_file=')).length, 1);
        assert.ok(spec.args.some((arg) => arg.includes(customOverride)));
      }

      for (const launchArgs of configForms) {
        const spec = buildWorkerProcessLaunchSpec('alpha', 1, ['--', ...launchArgs], '/tmp/project', {}, 'codex', undefined, 'explore');
        const marker = spec.args.indexOf('--');
        assert.ok(marker > 0);
        assert.ok(spec.args.slice(0, marker).some((arg) => arg.includes('model_instructions_file="/tmp/project/AGENTS.md"')));
        assert.deepEqual(spec.args.slice(marker + 1), launchArgs);
      }
    } finally {
      if (typeof previousBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = previousBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });


  it('does not synthesize absent first-party OMX MCP server tables for Codex team workers', async () => {
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevCompat = process.env.OMX_TEAM_WORKER_MCP_COMPAT;
    const prevCodexHome = process.env.CODEX_HOME;
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-team-no-mcp-config-'));
    try {
      await writeFile(join(codexHome, 'config.toml'), '[mcp_servers.gitnexus]\ncommand = "gitnexus"\n');
      process.env.CODEX_HOME = codexHome;
      process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
      delete process.env.OMX_TEAM_WORKER_MCP_COMPAT;
      const cmd = buildWorkerStartupCommand('alpha', 1, [], '/tmp/project', {}, 'codex');
      for (const server of ['omx_state', 'omx_memory', 'omx_code_intel', 'omx_trace', 'omx_wiki', 'omx_hermes']) {
        assert.doesNotMatch(cmd, new RegExp(`mcp_servers\\.${server}\\.enabled=false`));
      }
    } finally {
      await rm(codexHome, { recursive: true, force: true });
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevCompat === 'string') process.env.OMX_TEAM_WORKER_MCP_COMPAT = prevCompat;
      else delete process.env.OMX_TEAM_WORKER_MCP_COMPAT;
      if (typeof prevCodexHome === 'string') process.env.CODEX_HOME = prevCodexHome;
      else delete process.env.CODEX_HOME;
    }
  });

  it('disables configured first-party OMX MCP compatibility servers for Codex team workers by default', async () => {
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevCompat = process.env.OMX_TEAM_WORKER_MCP_COMPAT;
    const prevCodexHome = process.env.CODEX_HOME;
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-team-mcp-config-'));
    try {
      await writeFile(
        join(codexHome, 'config.toml'),
        ['omx_state', 'omx_memory', 'omx_code_intel', 'omx_trace', 'omx_wiki', 'omx_hermes']
          .map((server) => `[mcp_servers.${server}]\ncommand = "omx"\nargs = ["mcp-serve", "${server}"]\n`)
          .join('\n'),
      );
      process.env.CODEX_HOME = codexHome;
      process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
      delete process.env.OMX_TEAM_WORKER_MCP_COMPAT;
      const cmd = buildWorkerStartupCommand('alpha', 1, [], '/tmp/project', {}, 'codex');
      for (const server of ['omx_state', 'omx_memory', 'omx_code_intel', 'omx_trace', 'omx_wiki', 'omx_hermes']) {
        assert.match(cmd, new RegExp(`mcp_servers\\.${server}\\.enabled=false`));
      }
    } finally {
      await rm(codexHome, { recursive: true, force: true });
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevCompat === 'string') process.env.OMX_TEAM_WORKER_MCP_COMPAT = prevCompat;
      else delete process.env.OMX_TEAM_WORKER_MCP_COMPAT;
      if (typeof prevCodexHome === 'string') process.env.CODEX_HOME = prevCodexHome;
      else delete process.env.CODEX_HOME;
    }
  });

  it('recognizes every MCP config spelling before -- and inserts generated overrides before positional suffixes', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'omx-team-mcp-config-forms-'));
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-team-mcp-home-'));
    const previousBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const previousCompat = process.env.OMX_TEAM_WORKER_MCP_COMPAT;
    const enabledOverride = 'mcp_servers.omx_state.enabled=true';
    const configForms = [
      ['-c', enabledOverride],
      ['--config', enabledOverride],
      [`-c=${enabledOverride}`],
      [`--config=${enabledOverride}`],
    ];
    try {
      await writeFile(join(codexHome, 'config.toml'), '[mcp_servers.omx_state]\ncommand = "omx"\n');
      process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
      delete process.env.OMX_TEAM_WORKER_MCP_COMPAT;
      const startupEnv = { OMX_TEAM_STATE_ROOT: stateRoot, CODEX_HOME: codexHome };

      for (const [index, launchArgs] of configForms.entries()) {
        writeWorkerStartupScriptCommand('alpha', index + 1, launchArgs, '/tmp/project', startupEnv, 'codex', undefined, 'explore');
        const script = await readFile(join(stateRoot, 'team', 'alpha', 'runtime', `worker-${index + 1}-startup.sh`), 'utf-8');
        assert.equal((script.match(/mcp_servers\.omx_state\.enabled=/g) ?? []).length, 1);
        assert.match(script, /mcp_servers\.omx_state\.enabled=true/);
        assert.doesNotMatch(script, /mcp_servers\.omx_state\.enabled=false/);
      }

      for (const [index, launchArgs] of configForms.entries()) {
        const workerIndex = index + 10;
        writeWorkerStartupScriptCommand('alpha', workerIndex, ['--', ...launchArgs], '/tmp/project', startupEnv, 'codex', undefined, 'explore');
        const script = await readFile(join(stateRoot, 'team', 'alpha', 'runtime', `worker-${workerIndex}-startup.sh`), 'utf-8');
        const generatedIndex = script.indexOf('mcp_servers.omx_state.enabled=false');
        const positionalIndex = script.indexOf('mcp_servers.omx_state.enabled=true');
        assert.ok(generatedIndex >= 0 && generatedIndex < positionalIndex);
      }
    } finally {
      if (typeof previousBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = previousBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof previousCompat === 'string') process.env.OMX_TEAM_WORKER_MCP_COMPAT = previousCompat;
      else delete process.env.OMX_TEAM_WORKER_MCP_COMPAT;
      await rm(stateRoot, { recursive: true, force: true });
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('preserves explicit team-worker MCP compatibility opt-in', async () => {
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevCompat = process.env.OMX_TEAM_WORKER_MCP_COMPAT;
    const prevCodexHome = process.env.CODEX_HOME;
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-team-mcp-compat-'));
    try {
      await writeFile(join(codexHome, 'config.toml'), '[mcp_servers.omx_state]\ncommand = "omx"\n');
      process.env.CODEX_HOME = codexHome;
      process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
      process.env.OMX_TEAM_WORKER_MCP_COMPAT = '1';
      const cmd = buildWorkerStartupCommand('alpha', 1, [], '/tmp/project', {}, 'codex');
      assert.doesNotMatch(cmd, /mcp_servers\.omx_state\.enabled=false/);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevCompat === 'string') process.env.OMX_TEAM_WORKER_MCP_COMPAT = prevCompat;
      else delete process.env.OMX_TEAM_WORKER_MCP_COMPAT;
      if (typeof prevCodexHome === 'string') process.env.CODEX_HOME = prevCodexHome;
      else delete process.env.CODEX_HOME;
    }
  });

  it('does not inject model_instructions_file override when disabled', () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, [], '/tmp/project');
      assert.doesNotMatch(cmd, /model_instructions_file=/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('does not inject model_instructions_file when already provided in launch args', () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT; // default enabled
    try {
      const cmd = buildWorkerStartupCommand(
        'alpha',
        1,
        ['-c', 'model_instructions_file="/tmp/custom.md"'],
        '/tmp/project',
      );
      const matches = cmd.match(/model_instructions_file=/g) || [];
      assert.equal(matches.length, 1);
      assert.match(cmd, /custom\.md/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('translates model_instructions_file path for MSYS2/Git Bash environments', () => {
    const prevShell = process.env.SHELL;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevInstructions = process.env.OMX_MODEL_INSTRUCTIONS_FILE;
    const prevMsystem = process.env.MSYSTEM;
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    process.env.SHELL = '/bin/bash';
    delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT; // default enabled
    process.env.OMX_MODEL_INSTRUCTIONS_FILE = 'C:\\repo\\AGENTS.md';
    process.env.MSYSTEM = 'MINGW64';
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, [], 'C:\\repo');
      assert.match(cmd, /model_instructions_file=\"\/c\/repo\/AGENTS\.md\"/);
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevInstructions === 'string') process.env.OMX_MODEL_INSTRUCTIONS_FILE = prevInstructions;
      else delete process.env.OMX_MODEL_INSTRUCTIONS_FILE;
      if (typeof prevMsystem === 'string') process.env.MSYSTEM = prevMsystem;
      else delete process.env.MSYSTEM;
    }
  });

  it('ignores unsupported SHELL values and resolves a supported worker shell', () => {
    const prevShell = process.env.SHELL;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.SHELL = '/usr/bin/fish';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, [], process.cwd());
      assert.doesNotMatch(cmd, /fish/, 'worker shell must not inherit unsupported fish SHELL');
      assert.match(cmd, /\/(?:bin|usr\/bin|usr\/local\/bin|opt\/homebrew\/bin)\/(?:zsh|bash)\b|\/bin\/sh\b/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('never emits fish-style PATH manipulation for unsupported SHELL values', () => {
    const prevShell = process.env.SHELL;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.SHELL = '/usr/bin/fish';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, [], process.cwd());
      assert.doesNotMatch(cmd, /set -x PATH/, 'must not emit fish PATH syntax');
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('uses /bin/sh on MSYS2/Windows regardless of zsh availability', () => {
    const prevShell = process.env.SHELL;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevMsystem = process.env.MSYSTEM;
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    process.env.SHELL = '/bin/zsh';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.env.MSYSTEM = 'MINGW64';
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, [], 'C:\\repo');
      assert.match(cmd, /\/bin\/sh/, 'must use /bin/sh on MSYS2/Windows');
      assert.doesNotMatch(cmd, /\/zsh/, 'must not attempt zsh on Windows');
      assert.doesNotMatch(cmd, /\.zshrc/, 'must not source zshrc on Windows');
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevMsystem === 'string') process.env.MSYSTEM = prevMsystem;
      else delete process.env.MSYSTEM;
    }
  });

  it('uses a native PowerShell startup command on native Windows instead of /bin/sh -lc', async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-worker-startup-win32-'));
    const prevPath = process.env.PATH;
    const prevPathext = process.env.PATHEXT;
    const prevShell = process.env.SHELL;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevLeaderNodePath = process.env.OMX_LEADER_NODE_PATH;
    const prevMsystem = process.env.MSYSTEM;
    const prevOstype = process.env.OSTYPE;
    const prevWsl = process.env.WSL_DISTRO_NAME;
    const prevWslInterop = process.env.WSL_INTEROP;
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    process.env.PATH = fakeBin;
    process.env.PATHEXT = '.PS1';
    process.env.SHELL = '/bin/zsh';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.env.OMX_LEADER_NODE_PATH = 'C:\\Program Files\\nodejs\\node.exe';
    delete process.env.MSYSTEM;
    delete process.env.OSTYPE;
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const codexPs1Path = join(fakeBin, 'codex.ps1');
      await writeFile(codexPs1Path, '');

      const cmd = buildWorkerStartupCommand('alpha', 1, ['--model', 'gpt-5'], 'C:\\repo');
      assert.doesNotMatch(cmd, /\/bin\/sh -lc/, 'native Windows workers must not launch through POSIX sh');
      assert.match(cmd, /^powershell\.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand /);

      const encoded = cmd.replace(/^powershell\.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand /, '');
      const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
      assert.match(decoded, /\$env:PATH = 'C:\\Program Files\\nodejs;' \+ \$env:PATH/);
      assert.match(decoded, /\$env:OMX_TEAM_WORKER = 'alpha\/worker-1'/);
      assert.match(decoded, new RegExp(escapeRegExp(`'-File' '${codexPs1Path}'`)));
      assert.match(decoded, /'--model' 'gpt-5'/);
      assert.match(decoded, /'--dangerously-bypass-approvals-and-sandbox'/);
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevPathext === 'string') process.env.PATHEXT = prevPathext;
      else delete process.env.PATHEXT;
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevLeaderNodePath === 'string') process.env.OMX_LEADER_NODE_PATH = prevLeaderNodePath;
      else delete process.env.OMX_LEADER_NODE_PATH;
      if (typeof prevMsystem === 'string') process.env.MSYSTEM = prevMsystem;
      else delete process.env.MSYSTEM;
      if (typeof prevOstype === 'string') process.env.OSTYPE = prevOstype;
      else delete process.env.OSTYPE;
      if (typeof prevWsl === 'string') process.env.WSL_DISTRO_NAME = prevWsl;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof prevWslInterop === 'string') process.env.WSL_INTEROP = prevWslInterop;
      else delete process.env.WSL_INTEROP;
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('uses the resolved PowerShell executable path in native Windows startup commands', async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-worker-startup-win32-powershell-'));
    const prevPath = process.env.PATH;
    const prevPathext = process.env.PATHEXT;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevLeaderNodePath = process.env.OMX_LEADER_NODE_PATH;
    const prevMsystem = process.env.MSYSTEM;
    const prevOstype = process.env.OSTYPE;
    const prevWsl = process.env.WSL_DISTRO_NAME;
    const prevWslInterop = process.env.WSL_INTEROP;
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    process.env.PATH = fakeBin;
    process.env.PATHEXT = '.EXE;.PS1';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.env.OMX_LEADER_NODE_PATH = 'C:\\Program Files\\nodejs\\node.exe';
    delete process.env.MSYSTEM;
    delete process.env.OSTYPE;
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const codexPs1Path = join(fakeBin, 'codex.ps1');
      const powershellExePath = join(fakeBin, 'powershell.exe');
      await writeFile(codexPs1Path, '');
      await writeFile(powershellExePath, '');

      const cmd = buildWorkerStartupCommand('alpha', 1, ['--model', 'gpt-5'], 'C:\\repo');
      const prefix = `${powershellExePath} -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand `;
      assert.ok(cmd.startsWith(prefix), cmd);
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevPathext === 'string') process.env.PATHEXT = prevPathext;
      else delete process.env.PATHEXT;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevLeaderNodePath === 'string') process.env.OMX_LEADER_NODE_PATH = prevLeaderNodePath;
      else delete process.env.OMX_LEADER_NODE_PATH;
      if (typeof prevMsystem === 'string') process.env.MSYSTEM = prevMsystem;
      else delete process.env.MSYSTEM;
      if (typeof prevOstype === 'string') process.env.OSTYPE = prevOstype;
      else delete process.env.OSTYPE;
      if (typeof prevWsl === 'string') process.env.WSL_DISTRO_NAME = prevWsl;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof prevWslInterop === 'string') process.env.WSL_INTEROP = prevWslInterop;
      else delete process.env.WSL_INTEROP;
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('prefers a no-space native Windows PowerShell path when one is available', async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-worker-startup-win32-nospace-powershell-'));
    const prevPath = process.env.PATH;
    const prevPathext = process.env.PATHEXT;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevLeaderNodePath = process.env.OMX_LEADER_NODE_PATH;
    const prevSystemRoot = process.env.SystemRoot;
    const prevSYSTEMROOT = process.env.SYSTEMROOT;
    const prevWindir = process.env.windir;
    const prevWINDIR = process.env.WINDIR;
    const prevMsystem = process.env.MSYSTEM;
    const prevOstype = process.env.OSTYPE;
    const prevWsl = process.env.WSL_DISTRO_NAME;
    const prevWslInterop = process.env.WSL_INTEROP;
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    process.env.PATH = fakeBin;
    process.env.PATHEXT = '.EXE;.PS1';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.env.OMX_LEADER_NODE_PATH = 'C:\\Program Files\\nodejs\\node.exe';
    process.env.SystemRoot = 'C:\\Windows';
    delete process.env.SYSTEMROOT;
    delete process.env.windir;
    delete process.env.WINDIR;
    delete process.env.MSYSTEM;
    delete process.env.OSTYPE;
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const codexPs1Path = join(fakeBin, 'codex.ps1');
      const pathPowerShellExe = join(fakeBin, 'powershell.exe');
      const windowsPowerShellExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      await writeFile(codexPs1Path, '');
      await writeFile(pathPowerShellExe, '');

      const cmd = withMockedExistsSync((candidate) =>
        candidate === windowsPowerShellExe
        || candidate === pathPowerShellExe
        || candidate === codexPs1Path,
      () => buildWorkerStartupCommand('alpha', 1, ['--model', 'gpt-5'], 'C:\\repo'));
      const prefix = `${windowsPowerShellExe} -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand `;
      assert.ok(cmd.startsWith(prefix), cmd);
      assert.ok(!cmd.startsWith(`${pathPowerShellExe} `), cmd);
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevPathext === 'string') process.env.PATHEXT = prevPathext;
      else delete process.env.PATHEXT;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevLeaderNodePath === 'string') process.env.OMX_LEADER_NODE_PATH = prevLeaderNodePath;
      else delete process.env.OMX_LEADER_NODE_PATH;
      if (typeof prevSystemRoot === 'string') process.env.SystemRoot = prevSystemRoot;
      else delete process.env.SystemRoot;
      if (typeof prevSYSTEMROOT === 'string') process.env.SYSTEMROOT = prevSYSTEMROOT;
      else delete process.env.SYSTEMROOT;
      if (typeof prevWindir === 'string') process.env.windir = prevWindir;
      else delete process.env.windir;
      if (typeof prevWINDIR === 'string') process.env.WINDIR = prevWINDIR;
      else delete process.env.WINDIR;
      if (typeof prevMsystem === 'string') process.env.MSYSTEM = prevMsystem;
      else delete process.env.MSYSTEM;
      if (typeof prevOstype === 'string') process.env.OSTYPE = prevOstype;
      else delete process.env.OSTYPE;
      if (typeof prevWsl === 'string') process.env.WSL_DISTRO_NAME = prevWsl;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof prevWslInterop === 'string') process.env.WSL_INTEROP = prevWslInterop;
      else delete process.env.WSL_INTEROP;
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('uses the resolved node-hosted Codex launcher in native Windows startup commands', async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), 'omx-worker-startup-win32-node-hosted-'));
    const fakeBin = join(fakeRoot, 'node_modules', '.bin');
    const prevPath = process.env.PATH;
    const prevPathext = process.env.PATHEXT;
    const prevShell = process.env.SHELL;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevLeaderNodePath = process.env.OMX_LEADER_NODE_PATH;
    const prevMsystem = process.env.MSYSTEM;
    const prevOstype = process.env.OSTYPE;
    const prevWsl = process.env.WSL_DISTRO_NAME;
    const prevWslInterop = process.env.WSL_INTEROP;
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    process.env.PATH = fakeBin;
    process.env.PATHEXT = '.CMD;.PS1';
    process.env.SHELL = '/bin/zsh';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.env.OMX_LEADER_NODE_PATH = 'C:\\Program Files\\nodejs\\node.exe';
    delete process.env.MSYSTEM;
    delete process.env.OSTYPE;
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const codexCmdPath = join(fakeBin, 'codex.cmd');
      const codexJsPath = join(fakeRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      await mkdir(fakeBin, { recursive: true });
      await mkdir(join(fakeRoot, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
      await writeFile(codexCmdPath, '@echo off\r\n');
      await writeFile(codexJsPath, '');

      const cmd = buildWorkerStartupCommand('alpha', 1, ['--model', 'gpt-5'], 'C:\\repo');
      const prefix = 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ';
      assert.ok(cmd.startsWith(prefix));

      const decoded = Buffer.from(cmd.slice(prefix.length), 'base64').toString('utf16le');
      assert.match(decoded, new RegExp(escapeRegExp(`$env:OMX_LEADER_CLI_PATH = '${codexJsPath}'`)));
      assert.match(
        decoded,
        new RegExp(
          escapeRegExp(`& '${process.execPath}' '${codexJsPath}' '--model' 'gpt-5' '--dangerously-bypass-approvals-and-sandbox'`),
        ),
      );
      assert.doesNotMatch(decoded, new RegExp(escapeRegExp(codexCmdPath)));
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevPathext === 'string') process.env.PATHEXT = prevPathext;
      else delete process.env.PATHEXT;
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevLeaderNodePath === 'string') process.env.OMX_LEADER_NODE_PATH = prevLeaderNodePath;
      else delete process.env.OMX_LEADER_NODE_PATH;
      if (typeof prevMsystem === 'string') process.env.MSYSTEM = prevMsystem;
      else delete process.env.MSYSTEM;
      if (typeof prevOstype === 'string') process.env.OSTYPE = prevOstype;
      else delete process.env.OSTYPE;
      if (typeof prevWsl === 'string') process.env.WSL_DISTRO_NAME = prevWsl;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof prevWslInterop === 'string') process.env.WSL_INTEROP = prevWslInterop;
      else delete process.env.WSL_INTEROP;
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it('falls back to bash when SHELL is unsupported and zsh candidates are unavailable', () => {
    const prevShell = process.env.SHELL;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.SHELL = '/opt/custom/fish';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = withMockedExistsSync((candidate) => candidate === '/opt/custom/fish' || candidate === '/bin/bash', () =>
        buildWorkerStartupCommand('alpha', 1, [], process.cwd()),
      );
      assert.match(cmd, /\/bin\/bash\b/, 'must fall back to bash when zsh is unavailable');
      assert.doesNotMatch(cmd, /\.bashrc/, 'must not source bash rc file for bash fallback by default');
      assert.doesNotMatch(cmd, /fish/, 'must not launch unsupported fish shell');
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('falls back to /bin/sh when no supported shell candidates exist', () => {
    const prevShell = process.env.SHELL;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.SHELL = '/opt/custom/fish';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = withMockedExistsSync((candidate) => candidate === '/opt/custom/fish', () =>
        buildWorkerStartupCommand('alpha', 1, [], process.cwd()),
      );
      assert.match(cmd, /'\/bin\/sh' -c\b/, 'must launch workers through /bin/sh when no supported shells exist');
      assert.doesNotMatch(cmd, /'\/bin\/sh' -lc\b/);
      assert.doesNotMatch(cmd, /\.zshrc|\.bashrc/, 'must not source zsh/bash rc files for /bin/sh fallback');
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });
});

describe('team worker CLI helpers', () => {
  it('resolveTeamWorkerCli auto-detects claude models', () => {
    assert.equal(resolveTeamWorkerCli(['--model', 'claude-3-7-sonnet'], {}), 'claude');
    assert.equal(resolveTeamWorkerCli(['--model=claude-sonnet-4-6'], {}), 'claude');
    assert.equal(resolveTeamWorkerCli(['--model', 'gemini-2.0-pro'], {}), 'gemini');
    assert.equal(resolveTeamWorkerCli(['--model', 'gpt-5'], {}), 'codex');
    assert.equal(resolveTeamWorkerCli([], {}), 'codex');
    assert.equal(resolveTeamWorkerCli(['--', '--model', 'claude-3-7-sonnet'], {}), 'codex');
    assert.equal(resolveTeamWorkerCli(['--', '--model=gemini-2.0-pro'], {}), 'codex');
  });

  it('resolveTeamWorkerCli accepts explicit gemini override', () => {
    assert.equal(resolveTeamWorkerCli([], { OMX_TEAM_WORKER_CLI: 'gemini' }), 'gemini');
  });

  it('resolveTeamWorkerCliPlan accepts gemini in CLI map', () => {
    const plan = resolveTeamWorkerCliPlan(3, [], { OMX_TEAM_WORKER_CLI_MAP: 'codex,gemini,claude' });
    assert.deepEqual(plan, ['codex', 'gemini', 'claude']);
  });

  it('translateWorkerLaunchArgsForCli preserves args for codex', () => {
    const args = ['--model', 'gpt-5', '-c', 'model_reasoning_effort="xhigh"'];
    assert.deepEqual(translateWorkerLaunchArgsForCli('codex', args), args);
  });

  it('translateWorkerLaunchArgsForCli returns only skip-permissions for claude', () => {
    assert.deepEqual(
      translateWorkerLaunchArgsForCli('claude', ['-c', 'model_reasoning_effort="xhigh"', '--model', 'claude-3-7-sonnet']),
      ['--dangerously-skip-permissions'],
    );
  });

  it('translateWorkerLaunchArgsForCli keeps read-only claude roles out of skip-permissions mode', () => {
    assert.deepEqual(
      translateWorkerLaunchArgsForCli('claude', ['--model', 'claude-3-7-sonnet'], undefined, 'architect'),
      [],
    );
  });

  it('translateWorkerLaunchArgsForCli emits gemini approval-mode by default and adds -i when initial prompt is provided', () => {
    assert.deepEqual(
      translateWorkerLaunchArgsForCli('gemini', ['--model', 'gemini-2.0-pro', '--json']),
      ['--approval-mode', 'yolo', '--model', 'gemini-2.0-pro'],
    );
    assert.deepEqual(
      translateWorkerLaunchArgsForCli('gemini', ['--model', 'gemini-2.0-pro', '--json'], 'Read worker inbox'),
      ['--approval-mode', 'yolo', '-i', 'Read worker inbox', '--model', 'gemini-2.0-pro'],
    );
    assert.deepEqual(
      translateWorkerLaunchArgsForCli('gemini', ['--json']),
      ['--approval-mode', 'yolo'],
    );
    assert.deepEqual(
      translateWorkerLaunchArgsForCli('gemini', ['--json'], 'Read worker inbox'),
      ['--approval-mode', 'yolo', '-i', 'Read worker inbox'],
    );
  });

  it('translateWorkerLaunchArgsForCli omits non-gemini default models for gemini workers', () => {
    assert.deepEqual(
      translateWorkerLaunchArgsForCli('gemini', ['--model', 'gpt-5.6-luna'], 'Read worker inbox'),
      ['--approval-mode', 'yolo', '-i', 'Read worker inbox'],
    );
  });

  it('translateWorkerLaunchArgsForCli keeps planning/read-only gemini roles out of yolo mode', () => {
    assert.deepEqual(
      translateWorkerLaunchArgsForCli('gemini', ['--model', 'gemini-2.0-pro'], 'Read worker inbox', 'planner'),
      ['-i', 'Read worker inbox', '--model', 'gemini-2.0-pro'],
    );
  });

  it('assertTeamWorkerCliBinaryAvailable throws clear error when binary missing', () => {
    assert.throws(
      () => assertTeamWorkerCliBinaryAvailable('claude', () => false),
      /not available on PATH/i,
    );
  });

  it('resolveTeamWorkerCliPlan supports mixed per-worker CLI map', () => {
    const plan = resolveTeamWorkerCliPlan(
      4,
      [],
      { OMX_TEAM_WORKER_CLI_MAP: 'codex,codex,gemini,claude' },
    );
    assert.deepEqual(plan, ['codex', 'codex', 'gemini', 'claude']);
  });

  it('resolveTeamWorkerCliPlan accepts single-value map and expands to all workers', () => {
    const plan = resolveTeamWorkerCliPlan(
      3,
      [],
      { OMX_TEAM_WORKER_CLI_MAP: 'claude' },
    );
    assert.deepEqual(plan, ['claude', 'claude', 'claude']);
  });

  it('resolveTeamWorkerCliPlan supports auto entries in CLI map', () => {
    const plan = resolveTeamWorkerCliPlan(
      2,
      ['--model', 'claude-3-7-sonnet'],
      { OMX_TEAM_WORKER_CLI_MAP: 'auto,codex' },
    );
    assert.deepEqual(plan, ['claude', 'codex']);
  });

  it('resolveTeamWorkerCliPlan auto entries ignore OMX_TEAM_WORKER_CLI override', () => {
    const plan = resolveTeamWorkerCliPlan(
      1,
      ['--model', 'claude-3-7-sonnet'],
      {
        OMX_TEAM_WORKER_CLI: 'codex',
        OMX_TEAM_WORKER_CLI_MAP: 'auto',
      },
    );
    assert.deepEqual(plan, ['claude']);
  });

  it('resolveTeamWorkerCliPlan rejects map lengths that do not match workerCount', () => {
    assert.throws(
      () => resolveTeamWorkerCliPlan(4, [], { OMX_TEAM_WORKER_CLI_MAP: 'codex,claude' }),
      /expected 1 or 4/i,
    );
  });

  it('resolveTeamWorkerCliPlan rejects empty entries in CLI map', () => {
    assert.throws(
      () => resolveTeamWorkerCliPlan(2, [], { OMX_TEAM_WORKER_CLI_MAP: 'codex,' }),
      /empty entries are not allowed/i,
    );
  });

  it('resolveTeamWorkerCliPlan reports invalid entry errors with OMX_TEAM_WORKER_CLI_MAP', () => {
    assert.throws(
      () => resolveTeamWorkerCliPlan(1, [], { OMX_TEAM_WORKER_CLI_MAP: 'claudee' }),
      /OMX_TEAM_WORKER_CLI_MAP/i,
    );
  });

  it('resolveWorkerCliForSend prioritizes explicit worker CLI over map/global', () => {
    assert.equal(
      resolveWorkerCliForSend(2, 'claude', [], { OMX_TEAM_WORKER_CLI_MAP: 'codex,codex' }),
      'claude',
    );
  });

  it('resolveWorkerCliForSend resolves per-worker map entry by index', () => {
    assert.equal(
      resolveWorkerCliForSend(2, undefined, [], { OMX_TEAM_WORKER_CLI_MAP: 'codex,claude' }),
      'claude',
    );
  });

  it('buildWorkerSubmitPlan disables queue-first for claude workers', () => {
    const plan = buildWorkerSubmitPlan('auto', 'claude', true, true);
    assert.equal(plan.queueFirstRound, false);
    assert.equal(plan.submitKeyPressesPerRound, 1);
    assert.equal(plan.allowAdaptiveRetry, false);
  });

  it('buildWorkerSubmitPlan preserves queue-first behavior for busy codex workers', () => {
    const plan = buildWorkerSubmitPlan('auto', 'codex', true, true);
    assert.equal(plan.queueFirstRound, true);
    assert.equal(plan.submitKeyPressesPerRound, 2);
    assert.equal(plan.allowAdaptiveRetry, true);
  });
});

describe('team worker launch mode helpers', () => {
  it('resolveTeamWorkerLaunchMode defaults to interactive and accepts prompt', () => {
    assert.equal(resolveTeamWorkerLaunchMode({}), 'interactive');
    assert.equal(resolveTeamWorkerLaunchMode({ OMX_TEAM_WORKER_LAUNCH_MODE: 'interactive' }), 'interactive');
    assert.equal(resolveTeamWorkerLaunchMode({ OMX_TEAM_WORKER_LAUNCH_MODE: 'prompt' }), 'prompt');
    assert.equal(resolveTeamWorkerLaunchMode({ OMX_TEAM_WORKER_LAUNCH_MODE: ' PROMPT ' }), 'prompt');
  });

  it('resolveTeamWorkerLaunchMode rejects unsupported values', () => {
    assert.throws(
      () => resolveTeamWorkerLaunchMode({ OMX_TEAM_WORKER_LAUNCH_MODE: 'tmux' }),
      /Invalid OMX_TEAM_WORKER_LAUNCH_MODE value/i,
    );
  });

  it('buildWorkerProcessLaunchSpec returns command/args/env for prompt process spawn', () => {
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const spec = buildWorkerProcessLaunchSpec(
        'alpha-team',
        2,
        ['--model', 'gpt-5.6-terra'],
        '/tmp/workspace',
        { OMX_TEAM_STATE_ROOT: '/tmp/workspace/.omx/state' },
        'codex',
      );
      // command is now the resolved absolute path (or bare binary if which fails)
      assert.equal(spec.workerCli, 'codex');
      assert.ok(typeof spec.command === 'string' && spec.command.length > 0, 'command must be a non-empty string');
      assert.deepEqual(spec.args, ['--model', 'gpt-5.6-terra', '--dangerously-bypass-approvals-and-sandbox']);
      assert.equal(spec.env.OMX_TEAM_WORKER, 'alpha-team/worker-2');
      assert.equal(spec.env.OMX_TEAM_STATE_ROOT, '/tmp/workspace/.omx/state');
      assert.equal(spec.env.OMX_TMUX_HUD_OWNER, undefined);
      assert.equal(spec.env.OMX_TMUX_HUD_LEADER_PANE, undefined);
    } finally {
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('buildWorkerProcessLaunchSpec scrubs HUD ownership env from worker launches', () => {
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const spec = buildWorkerProcessLaunchSpec(
        'alpha-team',
        1,
        [],
        '/tmp/workspace',
        {
          OMX_TEAM_STATE_ROOT: '/tmp/workspace/.omx/state',
          OMX_TMUX_HUD_OWNER: '1',
          OMX_TMUX_HUD_LEADER_PANE: '%leader',
        },
        'codex',
      );
      assert.equal(spec.env.OMX_TEAM_WORKER, 'alpha-team/worker-1');
      assert.equal(spec.env.OMX_TEAM_STATE_ROOT, '/tmp/workspace/.omx/state');
      assert.equal(spec.env.OMX_TMUX_HUD_OWNER, undefined);
      assert.equal(spec.env.OMX_TMUX_HUD_LEADER_PANE, undefined);
    } finally {
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('buildWorkerProcessLaunchSpec does not force codex bypass for read-only roles', () => {
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const spec = buildWorkerProcessLaunchSpec(
        'alpha-team',
        2,
        ['--model', 'gpt-5.6-luna'],
        '/tmp/workspace',
        { OMX_TEAM_STATE_ROOT: '/tmp/workspace/.omx/state' },
        'codex',
        undefined,
        'explore',
      );
      assert.deepEqual(spec.args, ['--model', 'gpt-5.6-luna']);
    } finally {
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('suppresses ambient madmax and role-default bypass for direct Codex policy', () => {
    const previousArgv = process.argv;
    const previousBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.argv = ['node', 'omx', '--madmax'];
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const spec = buildWorkerProcessLaunchSpec(
        'policy-team',
        1,
        ['--ask-for-approval', 'on-request'],
        '/tmp/workspace',
        {},
        'codex',
        undefined,
        'executor',
      );
      assert.deepEqual(spec.args, ['--ask-for-approval', 'on-request']);
    } finally {
      process.argv = previousArgv;
      if (typeof previousBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = previousBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('preserves no-policy Codex bypass defaults exactly once for execution, absent, and unknown roles', () => {
    const previousArgv = process.argv;
    const previousBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.argv = ['node', 'omx'];
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {

      for (const role of ['executor', undefined, 'unknown-role']) {
        const spec = buildWorkerProcessLaunchSpec('policy-team', 1, [], '/tmp/workspace', {}, 'codex', undefined, role);
        assert.equal(spec.args.filter((arg) => arg === '--dangerously-bypass-approvals-and-sandbox').length, 1, String(role));
      }
      const readOnlySpec = buildWorkerProcessLaunchSpec('policy-team', 1, [], '/tmp/workspace', {}, 'codex', undefined, 'explore');
      assert.equal(readOnlySpec.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
      const bypassOnlySpec = buildWorkerProcessLaunchSpec('policy-team', 1, ['--madmax'], '/tmp/workspace', {}, 'codex', undefined, 'executor');
      assert.deepEqual(bypassOnlySpec.args, ['--dangerously-bypass-approvals-and-sandbox']);
    } finally {
      process.argv = previousArgv;
      if (typeof previousBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = previousBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('keeps ambient and role-default bypasses before end-of-options while suffix lookalikes remain positional', () => {
    const previousArgv = process.argv;
    const previousBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const positionalSuffix = ['--', '--madmax', '--sandbox', 'workspace-write', 'C:\\workspace\\tail\\'];
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      process.argv = ['node', 'omx', '--', '--madmax'];
      assert.deepEqual(
        buildWorkerProcessLaunchSpec('policy-team', 1, positionalSuffix, '/tmp/workspace', {}, 'codex', undefined, 'explore').args,
        positionalSuffix,
      );
      assert.deepEqual(
        buildWorkerProcessLaunchSpec('policy-team', 1, positionalSuffix, '/tmp/workspace', {}, 'codex', undefined, 'executor').args,
        ['--dangerously-bypass-approvals-and-sandbox', ...positionalSuffix],
      );

      process.argv = ['node', 'omx', '--madmax', '--', '--sandbox', 'workspace-write'];
      assert.deepEqual(
        buildWorkerProcessLaunchSpec('policy-team', 1, positionalSuffix, '/tmp/workspace', {}, 'codex', undefined, 'explore').args,
        ['--dangerously-bypass-approvals-and-sandbox', ...positionalSuffix],
      );
    } finally {
      process.argv = previousArgv;
      if (typeof previousBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = previousBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('fails closed when a mixed final Codex policy reaches the platform boundary', () => {
    const previousBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      assert.throws(
        () => buildWorkerProcessLaunchSpec(
          'policy-team',
          1,
          ['--dangerously-bypass-approvals-and-sandbox', '--sandbox', 'workspace-write'],
          '/tmp/workspace',
          {},
          'codex',
          undefined,
          'executor',
        ),
        /internal_mixed_codex_worker_policy_argv/,
      );
    } finally {
      if (typeof previousBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = previousBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('executes the generated POSIX startup script with canonical config policy and exact positional argv', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'omx-worker-policy-script-'));
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-worker-policy-codex-home-'));
    const fakeBin = join(stateRoot, 'bin');
    const capturePath = join(stateRoot, 'worker-argv.json');
    const injectionMarkerPath = join(stateRoot, 'injected');
    const previousBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const previousPath = process.env.PATH;
    const previousCapture = process.env.OMX_POLICY_ARGV_CAPTURE;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.env.OMX_POLICY_ARGV_CAPTURE = capturePath;
    try {
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(fakeBin, 'codex'),
        `#!/usr/bin/env node
require('fs').writeFileSync(process.env.OMX_POLICY_ARGV_CAPTURE, JSON.stringify(process.argv.slice(2)));
`,
      );
      await chmod(join(fakeBin, 'codex'), 0o755);
      process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;

      const positionalSuffix = [
        'C:\\workspace\\nested\\',
        '',
        '--sandbox=read-only',
        '--madmax',
        `$(touch ${injectionMarkerPath})`,
      ];
      const launchArgs = ['--config', 'sandbox_mode="workspace-write"', '--', ...positionalSuffix];
      const expectedArgs = ['--sandbox', 'workspace-write', '--', ...positionalSuffix];
      const workerEnv = { OMX_TEAM_STATE_ROOT: stateRoot, CODEX_HOME: codexHome };
      const spec = buildWorkerProcessLaunchSpec('policy-team', 1, launchArgs, stateRoot, workerEnv, 'codex', undefined, 'executor');
      const scriptCommand = writeWorkerStartupScriptCommand(
        'policy-team',
        1,
        launchArgs,
        stateRoot,
        workerEnv,
        'codex',
        undefined,
        'executor',
      );
      const scriptPath = join(stateRoot, 'team', 'policy-team', 'runtime', 'worker-1-startup.sh');
      const script = await readFile(scriptPath, 'utf-8');
      const execution = spawnSync('/bin/sh', [scriptPath], { encoding: 'utf-8' });

      assert.deepEqual(spec.args, expectedArgs);
      assert.equal(spec.env.CODEX_HOME, codexHome);
      assert.match(script, new RegExp(escapeRegExp(`export CODEX_HOME='${codexHome}'`)));
      assert.match(scriptCommand ?? '', /worker-1-startup\.sh/);
      assert.equal(execution.status, 0, execution.stderr);
      assert.deepEqual(JSON.parse(await readFile(capturePath, 'utf-8')), expectedArgs);
      assert.equal(fs.existsSync(injectionMarkerPath), false);
      assert.doesNotMatch(script, /dangerously-bypass-approvals-and-sandbox/);
    } finally {
      if (typeof previousBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = previousBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousCapture === 'string') process.env.OMX_POLICY_ARGV_CAPTURE = previousCapture;
      else delete process.env.OMX_POLICY_ARGV_CAPTURE;
      await rm(stateRoot, { recursive: true, force: true });
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('captures exact native-Windows harness PowerShell wrapper argv for canonical policy and positional suffixes', async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-worker-policy-win32-'));
    const capturePath = join(fakeBin, 'powershell-argv.json');
    const previousPath = process.env.PATH;
    const previousPathext = process.env.PATHEXT;
    const previousBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const previousMsystem = process.env.MSYSTEM;
    const previousOstype = process.env.OSTYPE;
    const previousWsl = process.env.WSL_DISTRO_NAME;
    const previousWslInterop = process.env.WSL_INTEROP;
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      const codexPs1Path = join(fakeBin, 'codex.ps1');
      const powershellExePath = join(fakeBin, 'powershell.exe');
      await writeFile(codexPs1Path, '');
      await writeFile(
        powershellExePath,
        `#!${process.execPath}
require('fs').writeFileSync(process.env.OMX_POLICY_ARGV_CAPTURE, JSON.stringify(process.argv.slice(2)));
`,
      );
      await chmod(powershellExePath, 0o755);
      process.env.PATH = fakeBin;
      process.env.PATHEXT = '.EXE;.PS1';
      process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
      delete process.env.MSYSTEM;
      delete process.env.OSTYPE;
      delete process.env.WSL_DISTRO_NAME;
      delete process.env.WSL_INTEROP;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      const positionalSuffix = ['C:\\workspace\\nested\\', '', '--sandbox=read-only', '--madmax'];
      const expectedWorkerArgs = ['--sandbox', 'workspace-write', '--', ...positionalSuffix];
      const windowsSpec = buildWorkerProcessLaunchSpec(
        'policy-team',
        1,
        ['--config', 'sandbox_mode="workspace-write"', '--', ...positionalSuffix],
        'C:\\workspace',
        {},
        'codex',
        undefined,
        'executor',
      );
      const execution = spawnSync(windowsSpec.command, windowsSpec.args, {
        encoding: 'utf-8',
        env: { ...process.env, ...windowsSpec.env, OMX_POLICY_ARGV_CAPTURE: capturePath },
      });

      assert.equal(windowsSpec.command, powershellExePath);
      assert.equal(execution.status, 0, execution.stderr);
      assert.deepEqual(JSON.parse(await readFile(capturePath, 'utf-8')), [
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', codexPs1Path, ...expectedWorkerArgs,
      ]);
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousPathext === 'string') process.env.PATHEXT = previousPathext;
      else delete process.env.PATHEXT;
      if (typeof previousBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = previousBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof previousMsystem === 'string') process.env.MSYSTEM = previousMsystem;
      else delete process.env.MSYSTEM;
      if (typeof previousOstype === 'string') process.env.OSTYPE = previousOstype;
      else delete process.env.OSTYPE;
      if (typeof previousWsl === 'string') process.env.WSL_DISTRO_NAME = previousWsl;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof previousWslInterop === 'string') process.env.WSL_INTEROP = previousWslInterop;
      else delete process.env.WSL_INTEROP;
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('rejects Claude and Gemini restrictive policies before permission translation', () => {
    const previousBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      for (const workerCli of ['claude', 'gemini'] as const) {
        const incompatibility = new RegExp(`Selected team worker CLI "${workerCli}" is incompatible with an explicit approval or sandbox policy\\.`);
        assert.throws(
          () => buildWorkerProcessLaunchSpec(
            'policy-team', 1, ['--sandbox', 'workspace-write'], '/tmp/workspace', {}, workerCli, 'Read worker inbox', 'executor',
          ),
          incompatibility,
        );
        assert.throws(
          () => buildWorkerProcessLaunchSpec(
            'policy-team', 1, ['--config', 'sandbox_mode="workspace-write"'], '/tmp/workspace', {}, workerCli, 'Read worker inbox', 'executor',
          ),
          incompatibility,
        );
        const positionalModel = `${workerCli}-positional-model`;
        const positionalSpec = buildWorkerProcessLaunchSpec(
          'policy-team',
          1,
          ['--config', 'sandbox_mode="workspace-write"', '--', '--model', positionalModel],
          '/tmp/workspace',
          {},
          undefined,
          undefined,
          'executor',
        );
        assert.equal(positionalSpec.workerCli, 'codex');
        assert.deepEqual(positionalSpec.args, [
          '--sandbox', 'workspace-write', '--', '--model', positionalModel,
        ]);
      }
    } finally {
      if (typeof previousBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = previousBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('preserves Claude and Gemini no-policy and bypass-only permission defaults', () => {
    const previousBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      assert.deepEqual(
        buildWorkerProcessLaunchSpec('policy-team', 1, [], '/tmp/workspace', {}, 'claude', undefined, 'executor').args,
        ['--dangerously-skip-permissions'],
      );
      assert.deepEqual(
        buildWorkerProcessLaunchSpec('policy-team', 1, ['--madmax'], '/tmp/workspace', {}, 'claude', undefined, 'executor').args,
        ['--dangerously-skip-permissions'],
      );
      assert.deepEqual(
        buildWorkerProcessLaunchSpec('policy-team', 1, [], '/tmp/workspace', {}, 'gemini', 'Read worker inbox', 'executor').args,
        ['--approval-mode', 'yolo', '-i', 'Read worker inbox'],
      );
      assert.deepEqual(
        buildWorkerProcessLaunchSpec('policy-team', 1, ['--madmax'], '/tmp/workspace', {}, 'gemini', 'Read worker inbox', 'executor').args,
        ['--approval-mode', 'yolo', '-i', 'Read worker inbox'],
      );
    } finally {
      if (typeof previousBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = previousBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('buildWorkerProcessLaunchSpec includes leader node and CLI path env vars', () => {
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const spec = buildWorkerProcessLaunchSpec(
        'beta-team',
        1,
        [],
        '/tmp/workspace',
        {},
        'codex',
      );
      assert.ok(
        typeof spec.env.OMX_LEADER_NODE_PATH === 'string' && spec.env.OMX_LEADER_NODE_PATH.length > 0,
        'OMX_LEADER_NODE_PATH must be set',
      );
      assert.ok(
        typeof spec.env.OMX_LEADER_CLI_PATH === 'string' && spec.env.OMX_LEADER_CLI_PATH.length > 0,
        'OMX_LEADER_CLI_PATH must be set',
      );
      // command matches the resolved CLI path stored in env
      assert.equal(spec.command, spec.env.OMX_LEADER_CLI_PATH);
    } finally {
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('buildWorkerProcessLaunchSpec wraps Windows PowerShell shims for prompt workers', async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-worker-spec-win32-'));
    const prevPath = process.env.PATH;
    const prevPathext = process.env.PATHEXT;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevMsystem = process.env.MSYSTEM;
    const prevOstype = process.env.OSTYPE;
    const prevWsl = process.env.WSL_DISTRO_NAME;
    const prevWslInterop = process.env.WSL_INTEROP;
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    process.env.PATH = fakeBin;
    process.env.PATHEXT = '.PS1';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    delete process.env.MSYSTEM;
    delete process.env.OSTYPE;
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const codexPs1Path = join(fakeBin, 'codex.ps1');
      await writeFile(codexPs1Path, '');

      const spec = buildWorkerProcessLaunchSpec(
        'beta-team',
        1,
        ['--model', 'gpt-5'],
        'C:\\workspace',
        {},
        'codex',
      );

      assert.match(spec.command, /powershell(?:\.exe)?$/i);
      assert.deepEqual(spec.args.slice(0, 5), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']);
      assert.equal(spec.args[5], codexPs1Path);
      assert.deepEqual(spec.args.slice(6), ['--model', 'gpt-5', '--dangerously-bypass-approvals-and-sandbox']);
      assert.equal(spec.env.OMX_LEADER_CLI_PATH, codexPs1Path);
      assert.notEqual(spec.command, codexPs1Path);
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevPathext === 'string') process.env.PATHEXT = prevPathext;
      else delete process.env.PATHEXT;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevMsystem === 'string') process.env.MSYSTEM = prevMsystem;
      else delete process.env.MSYSTEM;
      if (typeof prevOstype === 'string') process.env.OSTYPE = prevOstype;
      else delete process.env.OSTYPE;
      if (typeof prevWsl === 'string') process.env.WSL_DISTRO_NAME = prevWsl;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof prevWslInterop === 'string') process.env.WSL_INTEROP = prevWslInterop;
      else delete process.env.WSL_INTEROP;
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('buildWorkerProcessLaunchSpec records the resolved node-hosted Codex launcher on native Windows', async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), 'omx-worker-spec-win32-node-hosted-'));
    const fakeBin = join(fakeRoot, 'node_modules', '.bin');
    const prevPath = process.env.PATH;
    const prevPathext = process.env.PATHEXT;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevMsystem = process.env.MSYSTEM;
    const prevOstype = process.env.OSTYPE;
    const prevWsl = process.env.WSL_DISTRO_NAME;
    const prevWslInterop = process.env.WSL_INTEROP;
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    process.env.PATH = fakeBin;
    process.env.PATHEXT = '.CMD;.PS1';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    delete process.env.MSYSTEM;
    delete process.env.OSTYPE;
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const codexCmdPath = join(fakeBin, 'codex.cmd');
      const codexJsPath = join(fakeRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      await mkdir(fakeBin, { recursive: true });
      await mkdir(join(fakeRoot, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
      await writeFile(codexCmdPath, '@echo off\r\n');
      await writeFile(codexJsPath, '');

      const spec = buildWorkerProcessLaunchSpec(
        'beta-team',
        1,
        ['--model', 'gpt-5'],
        'C:\\workspace',
        {},
        'codex',
      );

      assert.equal(spec.command, process.execPath);
      assert.deepEqual(spec.args, [codexJsPath, '--model', 'gpt-5', '--dangerously-bypass-approvals-and-sandbox']);
      assert.equal(spec.env.OMX_LEADER_CLI_PATH, codexJsPath);
      assert.notEqual(spec.env.OMX_LEADER_CLI_PATH, codexCmdPath);
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevPathext === 'string') process.env.PATHEXT = prevPathext;
      else delete process.env.PATHEXT;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevMsystem === 'string') process.env.MSYSTEM = prevMsystem;
      else delete process.env.MSYSTEM;
      if (typeof prevOstype === 'string') process.env.OSTYPE = prevOstype;
      else delete process.env.OSTYPE;
      if (typeof prevWsl === 'string') process.env.WSL_DISTRO_NAME = prevWsl;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof prevWslInterop === 'string') process.env.WSL_INTEROP = prevWslInterop;
      else delete process.env.WSL_INTEROP;
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it('buildWorkerProcessLaunchSpec preserves ambient CODEX_HOME so Codex workers keep provider websocket metadata', async () => {
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevCodexHome = process.env.CODEX_HOME;
    const prevSqliteHome = process.env.CODEX_SQLITE_HOME;
    const prevProviderEnv = process.env.CUSTOM_PROVIDER_API_KEY;
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-team-provider-websocket-'));
    const sqliteHome = await mkdtemp(join(tmpdir(), 'omx-team-provider-sqlite-'));
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_SQLITE_HOME = sqliteHome;
    process.env.CUSTOM_PROVIDER_API_KEY = 'test-secret';

    try {
      await writeFile(join(codexHome, 'config.toml'), [
        'model = "gpt-5.6-sol"',
        'model_provider = "custom_provider"',
        '',
        '[model_providers.custom_provider]',
        'name = "custom_provider"',
        'base_url = "http://localhost:3000/v1"',
        'wire_api = "responses"',
        'supports_websockets = true',
        'requires_openai_auth = true',
        'env_key = "CUSTOM_PROVIDER_API_KEY"',
        '',
      ].join('\n'));

      const spec = buildWorkerProcessLaunchSpec(
        'websocket-team',
        1,
        [],
        '/tmp/workspace',
        {},
        'codex',
      );

      assert.equal(spec.env.CODEX_HOME, codexHome);
      assert.equal(spec.env.CODEX_SQLITE_HOME, sqliteHome);
      assert.equal(spec.env.CUSTOM_PROVIDER_API_KEY, 'test-secret');
    } finally {
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevCodexHome === 'string') process.env.CODEX_HOME = prevCodexHome;
      else delete process.env.CODEX_HOME;
      if (typeof prevSqliteHome === 'string') process.env.CODEX_SQLITE_HOME = prevSqliteHome;
      else delete process.env.CODEX_SQLITE_HOME;
      if (typeof prevProviderEnv === 'string') process.env.CUSTOM_PROVIDER_API_KEY = prevProviderEnv;
      else delete process.env.CUSTOM_PROVIDER_API_KEY;
      await rm(codexHome, { recursive: true, force: true });
      await rm(sqliteHome, { recursive: true, force: true });
    }
  });

  it('buildWorkerProcessLaunchSpec injects the active provider env_key from CODEX_HOME config.toml', async () => {
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevCodexHome = process.env.CODEX_HOME;
    const prevProviderEnv = process.env.CUSTOM_PROVIDER_API_KEY;
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-team-provider-env-'));
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.env.CODEX_HOME = codexHome;
    process.env.CUSTOM_PROVIDER_API_KEY = 'test-secret';

    try {
      await writeFile(join(codexHome, 'config.toml'), [
        'model_provider = "custom_provider"',
        '',
        '[model_providers.custom_provider]',
        'name = "custom_provider"',
        'base_url = "http://localhost:3000/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        'env_key = "CUSTOM_PROVIDER_API_KEY"',
        '',
      ].join('\n'));

      const spec = buildWorkerProcessLaunchSpec(
        'gamma-team',
        1,
        [],
        '/tmp/workspace',
        {},
        'codex',
      );

      assert.equal(spec.env.CUSTOM_PROVIDER_API_KEY, 'test-secret');
    } finally {
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevCodexHome === 'string') process.env.CODEX_HOME = prevCodexHome;
      else delete process.env.CODEX_HOME;
      if (typeof prevProviderEnv === 'string') process.env.CUSTOM_PROVIDER_API_KEY = prevProviderEnv;
      else delete process.env.CUSTOM_PROVIDER_API_KEY;
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('buildWorkerProcessLaunchSpec uses CLI model_provider override for Codex provider env injection', async () => {
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevCodexHome = process.env.CODEX_HOME;
    const prevDefaultProviderEnv = process.env.DEFAULT_PROVIDER_API_KEY;
    const prevCheapProviderEnv = process.env.CHEAP_PROVIDER_API_KEY;
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-team-provider-cli-override-'));
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.env.CODEX_HOME = codexHome;
    process.env.DEFAULT_PROVIDER_API_KEY = 'default-secret';
    process.env.CHEAP_PROVIDER_API_KEY = 'cheap-secret';

    try {
      await writeFile(join(codexHome, 'config.toml'), [
        'model_provider = "default_provider"',
        '',
        '[model_providers.default_provider]',
        'name = "default_provider"',
        'base_url = "http://localhost:3000/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        'env_key = "DEFAULT_PROVIDER_API_KEY"',
        '',
        '[model_providers.cheapRouter]',
        'name = "cheapRouter"',
        'base_url = "http://localhost:4000/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        'env_key = "CHEAP_PROVIDER_API_KEY"',
        '',
      ].join('\n'));

      const spec = buildWorkerProcessLaunchSpec(
        'provider-override-team',
        1,
        ['-c', 'model_provider="cheapRouter"', '--model', 'gpt-5.6-sol'],
        '/tmp/workspace',
        {},
        'codex',
      );

      assert.equal(spec.env.CHEAP_PROVIDER_API_KEY, 'cheap-secret');
      assert.equal(spec.env.DEFAULT_PROVIDER_API_KEY, undefined);
      assert.deepEqual(spec.args.slice(0, 4), ['-c', 'model_provider="cheapRouter"', '--model', 'gpt-5.6-sol']);
    } finally {
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevCodexHome === 'string') process.env.CODEX_HOME = prevCodexHome;
      else delete process.env.CODEX_HOME;
      if (typeof prevDefaultProviderEnv === 'string') process.env.DEFAULT_PROVIDER_API_KEY = prevDefaultProviderEnv;
      else delete process.env.DEFAULT_PROVIDER_API_KEY;
      if (typeof prevCheapProviderEnv === 'string') process.env.CHEAP_PROVIDER_API_KEY = prevCheapProviderEnv;
      else delete process.env.CHEAP_PROVIDER_API_KEY;
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('buildWorkerProcessLaunchSpec does not inject the active provider env_key for non-codex workers', async () => {
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevCodexHome = process.env.CODEX_HOME;
    const prevProviderEnv = process.env.CUSTOM_PROVIDER_API_KEY;
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-team-provider-env-'));
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.env.CODEX_HOME = codexHome;
    process.env.CUSTOM_PROVIDER_API_KEY = 'test-secret';

    try {
      await writeFile(join(codexHome, 'config.toml'), [
        'model_provider = "custom_provider"',
        '',
        '[model_providers.custom_provider]',
        'name = "custom_provider"',
        'base_url = "http://localhost:3000/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        'env_key = "CUSTOM_PROVIDER_API_KEY"',
        '',
      ].join('\n'));

      const spec = buildWorkerProcessLaunchSpec(
        'delta-team',
        1,
        [],
        '/tmp/workspace',
        {},
        'claude',
      );

      assert.equal(spec.workerCli, 'claude');
      assert.equal(spec.env.CODEX_HOME, undefined);
      assert.equal(spec.env.CUSTOM_PROVIDER_API_KEY, undefined);
    } finally {
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevCodexHome === 'string') process.env.CODEX_HOME = prevCodexHome;
      else delete process.env.CODEX_HOME;
      if (typeof prevProviderEnv === 'string') process.env.CUSTOM_PROVIDER_API_KEY = prevProviderEnv;
      else delete process.env.CUSTOM_PROVIDER_API_KEY;
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('buildWorkerProcessLaunchSpec reads provider env from worker CODEX_HOME override', async () => {
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevCodexHome = process.env.CODEX_HOME;
    const prevPrimaryProviderEnv = process.env.PRIMARY_PROVIDER_API_KEY;
    const prevWorkerProviderEnv = process.env.WORKER_PROVIDER_API_KEY;
    const leaderCodexHome = await mkdtemp(join(tmpdir(), 'omx-team-provider-env-leader-'));
    const workerCodexHome = await mkdtemp(join(tmpdir(), 'omx-team-provider-env-worker-'));
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.env.CODEX_HOME = leaderCodexHome;
    process.env.PRIMARY_PROVIDER_API_KEY = 'leader-secret';
    process.env.WORKER_PROVIDER_API_KEY = 'worker-secret';

    try {
      await writeFile(join(leaderCodexHome, 'config.toml'), [
        'model_provider = "primary_provider"',
        '',
        '[model_providers.primary_provider]',
        'name = "primary_provider"',
        'base_url = "http://localhost:3000/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        'env_key = "PRIMARY_PROVIDER_API_KEY"',
        '',
      ].join('\n'));

      await writeFile(join(workerCodexHome, 'config.toml'), [
        'model_provider = "worker_provider"',
        '',
        '[model_providers.worker_provider]',
        'name = "worker_provider"',
        'base_url = "http://localhost:4000/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        'env_key = "WORKER_PROVIDER_API_KEY"',
        '',
      ].join('\n'));

      const spec = buildWorkerProcessLaunchSpec(
        'epsilon-team',
        1,
        [],
        '/tmp/workspace',
        { CODEX_HOME: workerCodexHome },
        'codex',
      );

      assert.equal(spec.env.CODEX_HOME, workerCodexHome);
      assert.equal(spec.env.WORKER_PROVIDER_API_KEY, 'worker-secret');
      assert.equal(spec.env.PRIMARY_PROVIDER_API_KEY, undefined);
    } finally {
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevCodexHome === 'string') process.env.CODEX_HOME = prevCodexHome;
      else delete process.env.CODEX_HOME;
      if (typeof prevPrimaryProviderEnv === 'string') process.env.PRIMARY_PROVIDER_API_KEY = prevPrimaryProviderEnv;
      else delete process.env.PRIMARY_PROVIDER_API_KEY;
      if (typeof prevWorkerProviderEnv === 'string') process.env.WORKER_PROVIDER_API_KEY = prevWorkerProviderEnv;
      else delete process.env.WORKER_PROVIDER_API_KEY;
      await rm(leaderCodexHome, { recursive: true, force: true });
      await rm(workerCodexHome, { recursive: true, force: true });
    }
  });

  it('buildWorkerProcessLaunchSpec keeps the worker env contract unchanged for ambient proxy vars', () => {
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevHttpsProxy = process.env.HTTPS_PROXY;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.env.HTTPS_PROXY = 'https://ambient-proxy.example:443';
    try {
      const spec = buildWorkerProcessLaunchSpec(
        'eta-team',
        1,
        [],
        '/tmp/workspace',
        {},
        'codex',
      );
      assert.equal(spec.env.HTTPS_PROXY, undefined);
    } finally {
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevHttpsProxy === 'string') process.env.HTTPS_PROXY = prevHttpsProxy;
      else delete process.env.HTTPS_PROXY;
    }
  });

  it('buildWorkerProcessLaunchSpec resolves relative worker CODEX_HOME against the worker cwd', async () => {
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevCodexHome = process.env.CODEX_HOME;
    const prevLeaderProviderEnv = process.env.LEADER_PROVIDER_API_KEY;
    const prevWorkerProviderEnv = process.env.WORKER_PROVIDER_API_KEY;
    const originalCwd = process.cwd();
    const leaderCwd = await mkdtemp(join(tmpdir(), 'omx-team-provider-relative-leader-'));
    const workerCwd = await mkdtemp(join(tmpdir(), 'omx-team-provider-relative-worker-'));
    const leaderCodexHome = join(leaderCwd, '.codex');
    const workerCodexHome = join(workerCwd, '.codex');
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.env.CODEX_HOME = leaderCodexHome;
    process.env.LEADER_PROVIDER_API_KEY = 'leader-secret';
    process.env.WORKER_PROVIDER_API_KEY = 'worker-secret';

    try {
      await mkdir(leaderCodexHome, { recursive: true });
      await mkdir(workerCodexHome, { recursive: true });

      await writeFile(join(leaderCodexHome, 'config.toml'), [
        'model_provider = "leader_provider"',
        '',
        '[model_providers.leader_provider]',
        'name = "leader_provider"',
        'base_url = "http://localhost:3000/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        'env_key = "LEADER_PROVIDER_API_KEY"',
        '',
      ].join('\n'));

      await writeFile(join(workerCodexHome, 'config.toml'), [
        'model_provider = "worker_provider"',
        '',
        '[model_providers.worker_provider]',
        'name = "worker_provider"',
        'base_url = "http://localhost:4000/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        'env_key = "WORKER_PROVIDER_API_KEY"',
        '',
      ].join('\n'));

      process.chdir(leaderCwd);

      const spec = buildWorkerProcessLaunchSpec(
        'zeta-team',
        1,
        [],
        workerCwd,
        { CODEX_HOME: '.codex' },
        'codex',
      );

      assert.equal(spec.env.CODEX_HOME, '.codex');
      assert.equal(spec.env.WORKER_PROVIDER_API_KEY, 'worker-secret');
      assert.equal(spec.env.LEADER_PROVIDER_API_KEY, undefined);
    } finally {
      process.chdir(originalCwd);
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevCodexHome === 'string') process.env.CODEX_HOME = prevCodexHome;
      else delete process.env.CODEX_HOME;
      if (typeof prevLeaderProviderEnv === 'string') process.env.LEADER_PROVIDER_API_KEY = prevLeaderProviderEnv;
      else delete process.env.LEADER_PROVIDER_API_KEY;
      if (typeof prevWorkerProviderEnv === 'string') process.env.WORKER_PROVIDER_API_KEY = prevWorkerProviderEnv;
      else delete process.env.WORKER_PROVIDER_API_KEY;
      await rm(leaderCwd, { recursive: true, force: true });
      await rm(workerCwd, { recursive: true, force: true });
    }
  });
});

describe('sendToWorkerStdin', () => {
  it('writes a newline-terminated trigger message to worker stdin', () => {
    const stdin = new PassThrough();
    let captured = '';
    stdin.on('data', (chunk) => {
      captured += chunk.toString();
    });

    sendToWorkerStdin(stdin, 'check inbox now');
    assert.equal(captured, 'check inbox now\n');
  });

  it('validates trigger text before writing to stdin', () => {
    const stdin = new PassThrough();
    assert.throws(() => sendToWorkerStdin(stdin, ''), /non-empty/i);
    assert.throws(() => sendToWorkerStdin(stdin, 'a'.repeat(200)), /< 200 characters/i);
  });
});

describe('tmux-dependent functions when tmux is unavailable', () => {
  it('isTmuxAvailable returns false', () => {
    withEmptyPath(() => {
      assert.equal(isTmuxAvailable(), false);
    });
  });

  it('createTeamSession throws', () => {
    withEmptyPath(() => {
      assert.throws(
        () => createTeamSession('My Team', 1, process.cwd()),
        /tmux is not available/i
      );
    });
  });

  it('listTeamSessions returns empty', () => {
    withEmptyPath(() => {
      assert.deepEqual(listTeamSessions(), []);
    });
  });

  it('waitForWorkerReady uses visible capture-pane argv without tail flags', async () => {
    await withMockTmuxFixture(
      'omx-tmux-worker-ready-visible-capture-',
      (logPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    cat <<'EOF'
${READY_HELPER_CAPTURE}
EOF
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
      async ({ logPath }) => {
        assert.equal(waitForWorkerReady('omx-team-x', 1, 1_000), true);
        const log = await readFile(logPath, 'utf-8');
        assert.match(log, /capture-pane -t omx-team-x:1 -p/);
        assert.doesNotMatch(log, /capture-pane -t omx-team-x:1 -p -S/);
      },
    );
  });

  it('waitForWorkerReady accepts Codex 0.114.0-style welcome helper text', async () => {
    await withMockTmuxFixture(
      'omx-tmux-worker-ready-hello-',
      (logPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    cat <<'EOF'
╭────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.114.0)                 │
│                                            │
│ model:     gpt-5.6-sol high   /model to change │
│ directory: ~/Workspace/demo                │
╰────────────────────────────────────────────╯

How can I help you today?
EOF
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
      async () => {
        assert.equal(waitForWorkerReady('omx-team-x', 1, 1_000), true);
      },
    );
  });

  it('waitForWorkerReady falls back to recent scrollback when a live Codex viewport pushes the prompt below the visible slice', async () => {
    await withMockTmuxFixture(
      'omx-tmux-worker-ready-scrollback-fallback-',
      (logPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    if printf '%s\n' "$*" | grep -q -- ' -S -80'; then
      cat <<'EOF'
${VIEWPORT_SCROLLBACK_READY_CAPTURE}
EOF
    else
      cat <<'EOF'
${VIEWPORT_WITHOUT_VISIBLE_PROMPT_CAPTURE}
EOF
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
      async ({ logPath }) => {
        assert.equal(waitForWorkerReady('omx-team-x', 1, 1_000), true);
        const log = await readFile(logPath, 'utf-8');
        assert.match(log, /capture-pane -t omx-team-x:1 -p/);
        assert.match(log, /capture-pane -t omx-team-x:1 -p -S -80/);
      },
    );
  });

  it('waitForWorkerReady does not consult scrollback when the visible slice is only status text', async () => {
    await withMockTmuxFixture(
      'omx-tmux-worker-ready-no-scrollback-status-',
      (logPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    cat <<'EOF'
gpt-5 50% left
EOF
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
      async ({ logPath }) => {
        assert.equal(waitForWorkerReady('omx-team-x', 1, 250), false);
        const log = await readFile(logPath, 'utf-8');
        assert.match(log, /capture-pane -t omx-team-x:1 -p/);
        assert.doesNotMatch(log, /capture-pane -t omx-team-x:1 -p -S -80/);
      },
    );
  });

  it('waitForWorkerReady auto-accepts the Claude bypass prompt', async () => {
    await withMockTmuxFixture(
      'omx-tmux-claude-bypass-ready-',
      (logPath) => `#!/bin/sh
set -eu
state_dir="$(dirname "${logPath}")"
accepted_file="$state_dir/accepted"
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    if [ -f "$accepted_file" ]; then
      cat <<'EOF'
${READY_HELPER_CAPTURE}
EOF
    else
      cat <<'EOF'
${CLAUDE_BYPASS_PROMPT_CAPTURE}
EOF
    fi
    exit 0
    ;;
  send-keys)
    if [ "\${4:-}" = "-l" ] && [ "\${6:-}" = "2" ]; then
      : > "$accepted_file"
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
      async ({ logPath }) => {
        assert.equal(waitForWorkerReady('omx-team-x', 1, 5_000), true);
        const log = await readFile(logPath, 'utf-8');
        assert.match(log, /send-keys -t omx-team-x:1 -l -- 2/);
        assert.match(log, /send-keys -t omx-team-x:1 C-m/);
      },
    );
  });

  it('waitForWorkerReady leaves the Claude bypass prompt untouched when auto-accept is disabled', async () => {
    const previousAutoAccept = process.env.OMX_TEAM_AUTO_ACCEPT_BYPASS;
    process.env.OMX_TEAM_AUTO_ACCEPT_BYPASS = '0';
    try {
      await withMockTmuxFixture(
        'omx-tmux-claude-bypass-blocked-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    cat <<'EOF'
${CLAUDE_BYPASS_PROMPT_CAPTURE}
EOF
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        async ({ logPath }) => {
          assert.equal(waitForWorkerReady('omx-team-x', 1, 250), false);
          const log = await readFile(logPath, 'utf-8');
          assert.doesNotMatch(log, /send-keys/);
        },
      );
    } finally {
      if (typeof previousAutoAccept === 'string') process.env.OMX_TEAM_AUTO_ACCEPT_BYPASS = previousAutoAccept;
      else delete process.env.OMX_TEAM_AUTO_ACCEPT_BYPASS;
    }
  });

  it('waitForWorkerReady returns false on timeout', () => {
    withEmptyPath(() => {
      assert.equal(waitForWorkerReady('omx-team-x', 1, 1), false);
    });
  });
});


describe('waitForWorkerReadyAsync parity', () => {
  it('uses visible capture-pane argv without tail flags', async () => {
    await withMockTmuxFixture(
      'omx-tmux-worker-ready-async-visible-capture-',
      (logPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    cat <<'EOF'
${READY_HELPER_CAPTURE}
EOF
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
      async ({ logPath }) => {
        assert.equal(await waitForWorkerReadyAsync('omx-team-x', 1, 1_000), true);
        const log = await readFile(logPath, 'utf-8');
        assert.match(log, /capture-pane -t omx-team-x:1 -p/);
        assert.doesNotMatch(log, /capture-pane -t omx-team-x:1 -p -S/);
      },
    );
  });

  it('falls back to recent scrollback only when visible slice shows a live Codex viewport', async () => {
    await withMockTmuxFixture(
      'omx-tmux-worker-ready-async-scrollback-fallback-',
      (logPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    if printf '%s\n' "$*" | grep -q -- ' -S -80'; then
      cat <<'EOF'
${VIEWPORT_SCROLLBACK_READY_CAPTURE}
EOF
    else
      cat <<'EOF'
${VIEWPORT_WITHOUT_VISIBLE_PROMPT_CAPTURE}
EOF
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
      async ({ logPath }) => {
        assert.equal(await waitForWorkerReadyAsync('omx-team-x', 1, 1_000), true);
        const log = await readFile(logPath, 'utf-8');
        assert.match(log, /capture-pane -t omx-team-x:1 -p/);
        assert.match(log, /capture-pane -t omx-team-x:1 -p -S -80/);
      },
    );

    await withMockTmuxFixture(
      'omx-tmux-worker-ready-async-no-scrollback-status-',
      (logPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    printf 'gpt-5 50%% left\n'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
      async ({ logPath }) => {
        assert.equal(await waitForWorkerReadyAsync('omx-team-x', 1, 250), false);
        const log = await readFile(logPath, 'utf-8');
        assert.match(log, /capture-pane -t omx-team-x:1 -p/);
        assert.doesNotMatch(log, /capture-pane -t omx-team-x:1 -p -S -80/);
      },
    );
  });

  it('auto-accepts trust prompts and then observes readiness', async () => {
    const previousAutoTrust = process.env.OMX_TEAM_AUTO_TRUST;
    delete process.env.OMX_TEAM_AUTO_TRUST;
    try {
      await withMockTmuxFixture(
        'omx-tmux-worker-ready-async-trust-',
        (logPath) => `#!/bin/sh
set -eu
state_dir="$(dirname "${logPath}")"
accepted_file="$state_dir/accepted"
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    if [ -f "$accepted_file" ]; then
      cat <<'EOF'
${READY_HELPER_CAPTURE}
EOF
    else
      cat <<'EOF'
Do you trust the contents of this directory?
Press enter to continue
EOF
    fi
    exit 0
    ;;
  send-keys)
    if [ "\${4:-}" = "C-m" ]; then
      : > "$accepted_file"
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        async ({ logPath }) => {
          assert.equal(await waitForWorkerReadyAsync('omx-team-x', 1, 5_000), true);
          const log = await readFile(logPath, 'utf-8');
          assert.match(log, /send-keys -t omx-team-x:1 C-m/);
        },
      );
    } finally {
      if (typeof previousAutoTrust === 'string') process.env.OMX_TEAM_AUTO_TRUST = previousAutoTrust;
      else delete process.env.OMX_TEAM_AUTO_TRUST;
    }
  });

  it('auto-accepts the Claude bypass prompt and then observes readiness', async () => {
    const previousAutoAccept = process.env.OMX_TEAM_AUTO_ACCEPT_BYPASS;
    delete process.env.OMX_TEAM_AUTO_ACCEPT_BYPASS;
    try {
      await withMockTmuxFixture(
        'omx-tmux-worker-ready-async-claude-bypass-',
      (logPath) => `#!/bin/sh
set -eu
state_dir="$(dirname "${logPath}")"
accepted_file="$state_dir/accepted"
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    if [ -f "$accepted_file" ]; then
      cat <<'EOF'
${READY_HELPER_CAPTURE}
EOF
    else
      cat <<'EOF'
${CLAUDE_BYPASS_PROMPT_CAPTURE}
EOF
    fi
    exit 0
    ;;
  send-keys)
    if [ "\${4:-}" = "-l" ] && [ "\${6:-}" = "2" ]; then
      : > "$accepted_file"
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        async ({ logPath }) => {
          assert.equal(await waitForWorkerReadyAsync('omx-team-x', 1, 5_000), true);
          const log = await readFile(logPath, 'utf-8');
          assert.match(log, /send-keys -t omx-team-x:1 -l -- 2/);
        },
      );
    } finally {
      if (typeof previousAutoAccept === 'string') process.env.OMX_TEAM_AUTO_ACCEPT_BYPASS = previousAutoAccept;
      else delete process.env.OMX_TEAM_AUTO_ACCEPT_BYPASS;
    }
  });

  it('returns false on timeout or tmux command failure', async () => {
    await withMockTmuxFixture(
      'omx-tmux-worker-ready-async-capture-failure-',
      (logPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`,
      async () => {
        assert.equal(await waitForWorkerReadyAsync('omx-team-x', 1, 1), false);
      },
    );

    await withEmptyPath(async () => {
      assert.equal(await waitForWorkerReadyAsync('omx-team-x', 1, 1), false);
    });
  });
});

describe('createTeamSession tmux instance tagging', () => {
  it('rejects incompatible non-Codex and mixed Codex plans before any direct tmux mutation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-direct-policy-preflight-'));
    const previousTmux = process.env.TMUX;
    const previousTmuxPane = process.env.TMUX_PANE;
    const previousBypassInstructions = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    try {
      await withMockTmuxFixture(
        'omx-tmux-direct-policy-preflight-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${logPath}"
case "\${1:-}" in
  -V)
    echo "tmux 3.4"
    ;;
  display-message)
    echo "leader:0 %1"
    ;;
  list-panes)
    printf "%%1\\tnode\\t'codex'\\n"
    ;;
  split-window)
    echo "%2"
    ;;
  *)
    ;;
esac
exit 0
`,
        async ({ logPath }) => {
          const fakeBinDir = dirname(logPath);
          for (const workerCli of ['codex', 'claude', 'gemini']) {
            const binaryPath = join(fakeBinDir, workerCli);
            await writeFile(binaryPath, '#!/bin/sh\nexit 0\n');
            await chmod(binaryPath, 0o755);
          }

          process.env.TMUX = 'leader-session,stub,0';
          process.env.TMUX_PANE = '%1';
          process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
          const restrictiveArgs = ['--config', 'sandbox_mode="workspace-write"'];
          const readOnlyPreflightCommands = [
            '-V',
            'display-message -p -t %1 #{session_name}:#{window_index} #{pane_id}',
          ];


          for (const workerCli of ['claude', 'gemini'] as const) {
            for (const scenario of [
              {
                name: `direct-${workerCli}-first`,
                workerCount: 1,
                workerStartups: [{ workerCli, launchArgs: restrictiveArgs }],
              },
              {
                name: `direct-${workerCli}-later`,
                workerCount: 2,
                workerStartups: [
                  { workerCli: 'codex' as const, launchArgs: restrictiveArgs },
                  { workerCli, launchArgs: restrictiveArgs },
                ],
              },
            ]) {
              await writeFile(logPath, '');
              assert.throws(
                () => createTeamSession(
                  scenario.name,
                  scenario.workerCount,
                  cwd,
                  [],
                  scenario.workerStartups,
                ),
                new RegExp(`Selected team worker CLI "${workerCli}" is incompatible with an explicit approval or sandbox policy\\.`),
              );
              const tmuxCommands = (await readFile(logPath, 'utf-8')).trim().split('\n');
              assert.deepEqual(
                tmuxCommands,
                readOnlyPreflightCommands,

                `${scenario.name} must reject after read-only availability/context probes and before tagging, HUD cleanup, splits, or process launch`,
              );
            }
          }

          const mixedCodexArgs = [
            '--dangerously-bypass-approvals-and-sandbox',
            '--sandbox',
            'workspace-write',
          ];
          for (const scenario of [
            {
              name: 'direct-codex-mixed-first',
              workerCount: 1,
              workerStartups: [{ workerCli: 'codex' as const, launchArgs: mixedCodexArgs }],
            },
            {
              name: 'direct-codex-mixed-later',
              workerCount: 2,
              workerStartups: [
                { workerCli: 'codex' as const, launchArgs: restrictiveArgs },
                { workerCli: 'codex' as const, launchArgs: mixedCodexArgs },
              ],
            },
          ]) {
            await writeFile(logPath, '');
            assert.throws(
              () => createTeamSession(
                scenario.name,
                scenario.workerCount,
                cwd,
                [],
                scenario.workerStartups,
              ),
              /internal_mixed_codex_worker_policy_argv/,
            );
            assert.deepEqual(
              (await readFile(logPath, 'utf-8')).trim().split('\n'),
              readOnlyPreflightCommands,
              `${scenario.name} must reject before tagging, HUD cleanup, splits, or process launch`,
            );
          }
        },
      );
    } finally {
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof previousBypassInstructions === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = previousBypassInstructions;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('redraws the leader pane after team layout changes so wrapped diff hunks repaint with gutters', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-redraw-leader-'));
    const prevTmux = process.env.TMUX;
    const prevTmuxPane = process.env.TMUX_PANE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    try {
      await withMockTmuxFixture(
        'omx-tmux-redraw-leader-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${logPath}"
case "\${1:-}" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*)
        echo "120"
        ;;
      *)
        echo "leader:0 %1"
        ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"pane_current_command"*)
        printf "%%1\\tnode\\t'codex'\\n"
        ;;
      *)
        printf "%%1\\n"
        ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *" -h "*)
        echo "%2"
        ;;
      *)
        echo "%3"
        ;;
    esac
    exit 0
    ;;
  set-option|resize-pane|select-layout|set-window-option|select-pane|set-hook|run-shell|send-keys)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
        `,
        async ({ logPath }) => {
          const fakeBinDir = join(logPath, '..');
          const geminiPath = join(fakeBinDir, 'gemini');
          await writeFile(geminiPath, '#!/bin/sh\nexit 0\n');
          await chmod(geminiPath, 0o755);

          process.env.TMUX = 'leader-session,stub,0';
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_CLI = 'gemini';

          createTeamSession('Diff Gutter Redraw', 1, cwd);

          const tmuxLog = await readFile(logPath, 'utf-8');
          assert.match(tmuxLog, /select-layout -t leader:0 main-vertical/);
          assert.match(tmuxLog, /set-window-option -t leader:0 main-pane-width 60/);
          assert.match(tmuxLog, /split-window -v -f -l 3 -t leader:0 -d -P -F #\{pane_id\}/);
          assert.match(
            tmuxLog,
            /send-keys -t %1 C-l/,
            'leader Codex pane must repaint after team splits/resizes so tmux does not auto-wrap diff continuation rows without the line-number gutter',
          );
        },
      );
    } finally {
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevTmuxPane === 'string') process.env.TMUX_PANE = prevTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('tags leader, worker, and HUD panes with pane-scoped instance ownership', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-pane-tags-'));
    const prevTmux = process.env.TMUX;
    const prevTmuxPane = process.env.TMUX_PANE;
    const prevSessionId = process.env.OMX_SESSION_ID;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    try {
      await withMockTmuxFixture(
        'omx-tmux-pane-tags-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${logPath}"
case "\${1:-}" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*)
        echo "120"
        ;;
      *)
        echo "shared:0 %1"
        ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"pane_current_command"*)
        printf "%%1\\tnode\\t'codex'\\n"
        ;;
      *)
        printf "%%1\\n"
        ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *" -h "*)
        echo "%2"
        ;;
      *)
        echo "%3"
        ;;
    esac
    exit 0
    ;;
  set-option|resize-pane|select-layout|set-window-option|select-pane|set-hook|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
        `,
        async ({ logPath }) => {
          const fakeBinDir = join(logPath, '..');
          const geminiPath = join(fakeBinDir, 'gemini');
          await writeFile(geminiPath, '#!/bin/sh\nexit 0\n');
          await chmod(geminiPath, 0o755);

          process.env.TMUX = '1';
          process.env.TMUX_PANE = '%1';
          process.env.OMX_SESSION_ID = 'omx-pane-scope';
          process.env.OMX_TEAM_WORKER_CLI = 'gemini';

          const session = createTeamSession('Pane Tags', 1, cwd);
          assert.equal(session.name, 'shared:0');
          assert.equal(session.leaderPaneId, '%1');
          assert.deepEqual(session.workerPaneIds, ['%2']);
          assert.equal(session.hudPaneId, '%3');

          const tmuxLog = await readFile(logPath, 'utf-8');
          assert.match(tmuxLog, /set-option -t shared @omx_instance_id omx-pane-scope/);
          assert.match(tmuxLog, /set-option -p -t %1 @omx_pane_instance_id omx-pane-scope/);
          assert.match(tmuxLog, /set-option -p -t %2 @omx_pane_instance_id omx-pane-scope/);
          assert.match(tmuxLog, /set-option -p -t %3 @omx_pane_instance_id omx-pane-scope/);
          assert.match(tmuxLog, /set-option -p -t %1 @omx_team_pane_owner_id team:pane-tags/);
          assert.match(tmuxLog, /set-option -p -t %2 @omx_team_pane_owner_id team:pane-tags/);
          assert.match(tmuxLog, /set-option -p -t %3 @omx_team_pane_owner_id team:pane-tags/);
          assert.match(tmuxLog, /exec env OMX_SESSION_ID='omx-pane-scope' OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%1' .*hud --watch/);
        },
      );
    } finally {
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevTmuxPane === 'string') process.env.TMUX_PANE = prevTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof prevSessionId === 'string') process.env.OMX_SESSION_ID = prevSessionId;
      else delete process.env.OMX_SESSION_ID;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not reuse the Team pane owner token as the HUD logical session id', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-hud-session-boundary-'));
    const prevTmux = process.env.TMUX;
    const prevTmuxPane = process.env.TMUX_PANE;
    const prevSessionId = process.env.OMX_SESSION_ID;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    try {
      await withMockTmuxFixture(
        'omx-tmux-hud-session-boundary-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
case "\${1:-}" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*)
        echo "120"
        ;;
      *)
        echo "shared:0 %1"
        ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-t %2 -F #{pane_pid}"*)
        echo "2000002222"
        ;;
      *"pane_current_command"*)
        printf "%%1\\tnode\\t'codex'\\n"
        ;;
      *)
        printf "%%1\\n"
        ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *" -h "*)
        echo "%2"
        ;;
      *)
        echo "%3"
        ;;
    esac
    exit 0
    ;;
  set-option|resize-pane|select-layout|set-window-option|select-pane|set-hook|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
        `,
        async ({ logPath }) => {
          const fakeBinDir = join(logPath, '..');
          const geminiPath = join(fakeBinDir, 'gemini');
          await writeFile(geminiPath, '#!/bin/sh\nexit 0\n');
          await chmod(geminiPath, 0o755);

          process.env.TMUX = '1';
          process.env.TMUX_PANE = '%1';
          delete process.env.OMX_SESSION_ID;
          process.env.OMX_TEAM_WORKER_CLI = 'gemini';

          const session = createTeamSession('HUD Session Boundary', 1, cwd, [], undefined, {
            teamPaneOwnerId: 'team:explicit-owner-boundary',
          });
          assert.equal(session.hudPaneId, '%3');
          assert.equal(session.teamPaneOwnerId, 'team:explicit-owner-boundary');

          const tmuxLog = await readFile(logPath, 'utf-8');
          assert.match(tmuxLog, /set-option -p -t %1 @omx_team_pane_owner_id team:explicit-owner-boundary/);
          assert.match(tmuxLog, /set-option -p -t %2 @omx_team_pane_owner_id team:explicit-owner-boundary/);
          assert.match(tmuxLog, /set-option -p -t %3 @omx_team_pane_owner_id team:explicit-owner-boundary/);
          assert.match(tmuxLog, /exec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%1' .*hud --watch/);
          assert.doesNotMatch(tmuxLog, /OMX_SESSION_ID='team:explicit-owner-boundary'/);
        },
      );
    } finally {
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevTmuxPane === 'string') process.env.TMUX_PANE = prevTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof prevSessionId === 'string') process.env.OMX_SESSION_ID = prevSessionId;
      else delete process.env.OMX_SESSION_ID;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('removes only HUD panes owned by the current leader during team startup', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-owned-hud-startup-'));
    const prevTmux = process.env.TMUX;
    const prevTmuxPane = process.env.TMUX_PANE;
    const prevSessionId = process.env.OMX_SESSION_ID;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    try {
      await withMockTmuxFixture(
        'omx-tmux-owned-hud-startup-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${logPath}"
case "\${1:-}" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*)
        echo "120"
        ;;
      *)
        echo "shared:0 %1"
        ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"pane_current_command"*)
        printf "%%1\\tnode\\t'codex'\\n"
        printf "%%7\\tnode\\t'codex neighbor'\\n"
        printf "%%2\\tnode\\texec env OMX_SESSION_ID='leader-session-a' OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%1' node /tmp/bin/omx.js hud --watch\\n"
        printf "%%8\\tnode\\texec env OMX_SESSION_ID='neighbor-session' OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%7' node /tmp/bin/omx.js hud --watch\\n"
        ;;
      *)
        printf "%%1\\n%%7\\n%%2\\n%%8\\n"
        ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *" -h "*)
        echo "%3"
        ;;
      *)
        echo "%4"
        ;;
    esac
    exit 0
    ;;
  set-option|resize-pane|select-layout|set-window-option|select-pane|set-hook|run-shell|send-keys|kill-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
        `,
        async ({ logPath }) => {
          const fakeBinDir = join(logPath, '..');
          const geminiPath = join(fakeBinDir, 'gemini');
          await writeFile(geminiPath, '#!/bin/sh\nexit 0\n');
          await chmod(geminiPath, 0o755);

          process.env.TMUX = 'shared-session,stub,0';
          process.env.TMUX_PANE = '%1';
          process.env.OMX_SESSION_ID = 'leader-session-a';
          process.env.OMX_TEAM_WORKER_CLI = 'gemini';

          const session = createTeamSession('Owned HUD Startup', 1, cwd);
          assert.equal(session.leaderPaneId, '%1');
          assert.equal(session.hudPaneId, '%4');

          const tmuxLog = await readFile(logPath, 'utf-8');
          assert.match(tmuxLog, /kill-pane -t %2/);
          assert.doesNotMatch(tmuxLog, /kill-pane -t %8/);
          assert.match(tmuxLog, /split-window -v -f -l 3 -t shared:0 -d -P -F #\{pane_id\}/);
        },
      );
    } finally {
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevTmuxPane === 'string') process.env.TMUX_PANE = prevTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof prevSessionId === 'string') process.env.OMX_SESSION_ID = prevSessionId;
      else delete process.env.OMX_SESSION_ID;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses tmux 3.2a-compatible client-resized hook registration for team HUD resize', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-resize-hook-fallback-'));
    const prevTmux = process.env.TMUX;
    const prevTmuxPane = process.env.TMUX_PANE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevWarn = console.warn;
    const warnings: string[] = [];

    try {
      await withMockTmuxFixture(
        'omx-tmux-resize-hook-fallback-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${logPath}"
case "\${1:-}" in
  -V)
    echo "tmux 3.2a"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*)
        echo "120"
        ;;
      *)
        echo "leader:0 %1"
        ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"pane_current_command"*)
        printf "%%1\tnode\t'codex'\n"
        ;;
      *)
        printf "%%1\n"
        ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *" -h "*)
        echo "%2"
        ;;
      *)
        echo "%3"
        ;;
    esac
    exit 0
    ;;
  set-hook)
    case "$*" in
      *"window-resized["*)
        echo "invalid option: window-resized[]" >&2
        exit 1
        ;;
      *" -w "*)
        echo "invalid option: -w" >&2
        exit 1
        ;;
      *)
        exit 0
        ;;
    esac
    ;;
  set-option|resize-pane|select-layout|set-window-option|select-pane|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        async ({ logPath }) => {
          const fakeBinDir = join(logPath, '..');
          const geminiPath = join(fakeBinDir, 'gemini');
          await writeFile(geminiPath, '#!/bin/sh\nexit 0\n');
          await chmod(geminiPath, 0o755);

          process.env.TMUX = 'leader-session,stub,0';
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_CLI = 'gemini';
          console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };

          const session = createTeamSession('Resize Hook Fallback', 1, cwd);
          assert.equal(session.hudPaneId, '%3');
          assert.ok(session.resizeHookName);
          assert.equal(session.resizeHookTarget, 'leader:0');
          assert.equal(warnings.join('\n'), '');

          const tmuxLog = await readFile(logPath, 'utf-8');
          assert.match(tmuxLog, /set-hook -t leader:0 client-resized\[\d+\]/);
          assert.doesNotMatch(tmuxLog, /window-resized\[/);
          assert.doesNotMatch(tmuxLog, /set-hook -w /);
          assert.match(tmuxLog, /set-hook -t leader:0 client-attached\[\d+\]/);
          assert.match(tmuxLog, new RegExp(`run-shell -b sleep ${HUD_RESIZE_RECONCILE_DELAY_SECONDS}; .*resize-pane -t %3 -y ${HUD_TMUX_TEAM_HEIGHT_LINES}`));
          assert.match(tmuxLog, new RegExp(`run-shell .*resize-pane -t %3 -y ${HUD_TMUX_TEAM_HEIGHT_LINES}`));
          assert.doesNotMatch(tmuxLog, /kill-pane -t %2/);
          assert.doesNotMatch(tmuxLog, /kill-pane -t %3/);
        },
      );
    } finally {
      console.warn = prevWarn;
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevTmuxPane === 'string') process.env.TMUX_PANE = prevTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('degrades HUD run-shell resize failures to warnings during team startup', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-runshell-fallback-'));
    const prevTmux = process.env.TMUX;
    const prevTmuxPane = process.env.TMUX_PANE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevWarn = console.warn;
    const warnings: string[] = [];
    try {
      await withMockTmuxFixture(
        'omx-tmux-runshell-fallback-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${logPath}"
case "\${1:-}" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*) echo "120" ;;
      *) echo "leader:0 %1" ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"pane_current_command"*) printf "%%1\\tnode\\t'codex'\\n" ;;
      *) printf "%%1\\n" ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *" -h "*) echo "%2" ;;
      *) echo "%3" ;;
    esac
    exit 0
    ;;
  run-shell)
    echo "Unsupported tmux compatibility command: run-shell" >&2
    exit 1
    ;;
  set-option|resize-pane|select-layout|set-window-option|select-pane|set-hook|send-keys)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        async ({ logPath }) => {
          const fakeBinDir = join(logPath, '..');
          const geminiPath = join(fakeBinDir, 'gemini');
          await writeFile(geminiPath, '#!/bin/sh\nexit 0\n');
          await chmod(geminiPath, 0o755);

          process.env.TMUX = 'leader-session,stub,0';
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_CLI = 'gemini';
          console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };

          const session = createTeamSession('Run Shell Fallback', 1, cwd);
          assert.equal(session.hudPaneId, '%3');
          assert.match(warnings.join('\n'), /HUD resize/);
          assert.match(warnings.join('\n'), /Unsupported tmux compatibility command: run-shell/);
          const tmuxLog = await readFile(logPath, 'utf-8');
          assert.match(tmuxLog, /run-shell -b sleep/);
          assert.doesNotMatch(tmuxLog, /kill-pane -t %2/);
          assert.doesNotMatch(tmuxLog, /kill-pane -t %3/);
        },
      );
    } finally {
      console.warn = prevWarn;
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevTmuxPane === 'string') process.env.TMUX_PANE = prevTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('native Windows HUD reconciliation', () => {
  it('allows team startup on native Windows when current tmux client is reachable without TMUX env vars', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-win32-no-env-'));
    const prevTmux = process.env.TMUX;
    const prevTmuxPane = process.env.TMUX_PANE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevMsystem = process.env.MSYSTEM;
    const prevOstype = process.env.OSTYPE;
    const prevWsl = process.env.WSL_DISTRO_NAME;
    const prevWslInterop = process.env.WSL_INTEROP;
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

    try {
      await withMockTmuxFixture(
        'omx-tmux-win32-no-env-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
case "\${1:-}" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*)
        echo "120"
        ;;
      *)
        echo "leader:0 %1"
        ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"pane_current_command"*)
        printf "%%1\\tnode\\t'codex'\\n%%2\\tgemini\\t'gemini'\\n%%3\\tnode\\t'node omx hud --watch'\\n"
        ;;
      *)
        printf "%%1\\n%%2\\n%%3\\n"
        ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *" -h "*)
        echo "%2"
        ;;
      *)
        echo "%3"
        ;;
    esac
    exit 0
    ;;
  resize-pane|select-layout|set-window-option|select-pane|kill-pane|set-hook|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        async ({ logPath }) => {
          const fakeBinDir = join(logPath, '..');
          const geminiPath = join(fakeBinDir, 'gemini');
          await writeFile(geminiPath, '#!/bin/sh\nexit 0\n');
          await chmod(geminiPath, 0o755);

          delete process.env.TMUX;
          delete process.env.TMUX_PANE;
          process.env.OMX_TEAM_WORKER_CLI = 'gemini';
          delete process.env.MSYSTEM;
          delete process.env.OSTYPE;
          delete process.env.WSL_DISTRO_NAME;
          delete process.env.WSL_INTEROP;
          Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

          const session = createTeamSession('Windows Team', 1, cwd);
          assert.equal(session.name, 'leader:0');
          assert.equal(session.leaderPaneId, '%1');
          assert.equal(session.hudPaneId, '%3');

          const tmuxLog = await readFile(logPath, 'utf-8');
          assert.match(tmuxLog, /display-message -p #\{session_name\}:#\{window_index\} #\{pane_id\}/);
          assert.match(tmuxLog, /powershell\.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand/);
          assert.doesNotMatch(tmuxLog, /\/bin\/sh -lc/);
          assert.match(tmuxLog, new RegExp(`resize-pane -t %3 -y ${HUD_TMUX_TEAM_HEIGHT_LINES}`));
        },
      );
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevTmuxPane === 'string') process.env.TMUX_PANE = prevTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevMsystem === 'string') process.env.MSYSTEM = prevMsystem;
      else delete process.env.MSYSTEM;
      if (typeof prevOstype === 'string') process.env.OSTYPE = prevOstype;
      else delete process.env.OSTYPE;
      if (typeof prevWsl === 'string') process.env.WSL_DISTRO_NAME = prevWsl;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof prevWslInterop === 'string') process.env.WSL_INTEROP = prevWslInterop;
      else delete process.env.WSL_INTEROP;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('avoids nested tmux run-shell hooks during team HUD startup on native Windows', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-win32-hud-'));
    const prevTmux = process.env.TMUX;
    const prevTmuxPane = process.env.TMUX_PANE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevMsystem = process.env.MSYSTEM;
    const prevOstype = process.env.OSTYPE;
    const prevWsl = process.env.WSL_DISTRO_NAME;
    const prevWslInterop = process.env.WSL_INTEROP;
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

    try {
      await withMockTmuxFixture(
        'omx-tmux-win32-hud-reconcile-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
case "\${1:-}" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*)
        echo "120"
        ;;
      *)
        echo "leader:0 %1"
        ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"pane_current_command"*)
        printf "%%1\\tnode\\t'codex'\\n%%2\\tgemini\\t'gemini'\\n%%3\\tnode\\t'node omx hud --watch'\\n"
        ;;
      *)
        printf "%%1\\n%%2\\n%%3\\n"
        ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *" -h "*)
        echo "%2"
        ;;
      *)
        echo "%3"
        ;;
    esac
    exit 0
    ;;
  resize-pane|select-layout|set-window-option|select-pane|kill-pane)
    exit 0
    ;;
  set-hook|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        async ({ logPath }) => {
          const fakeBinDir = join(logPath, '..');
          const geminiPath = join(fakeBinDir, 'gemini');
          await writeFile(geminiPath, '#!/bin/sh\nexit 0\n');
          await chmod(geminiPath, 0o755);

          process.env.TMUX = 'leader-session,stub,0';
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_CLI = 'gemini';
          delete process.env.MSYSTEM;
          delete process.env.OSTYPE;
          delete process.env.WSL_DISTRO_NAME;
          delete process.env.WSL_INTEROP;
          Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

          const session = createTeamSession('Windows Team', 1, cwd);
          assert.equal(session.hudPaneId, '%3');
          assert.equal(session.resizeHookName, null);
          assert.equal(session.resizeHookTarget, null);

          const tmuxLog = await readFile(logPath, 'utf-8');
          assert.match(tmuxLog, new RegExp(`resize-pane -t %3 -y ${HUD_TMUX_TEAM_HEIGHT_LINES}`));
          assert.doesNotMatch(tmuxLog, /set-hook -w /);
          assert.doesNotMatch(tmuxLog, /window-resized\[/);
          assert.doesNotMatch(tmuxLog, /set-hook -t leader:0 client-attached\[\d+\]/);
          assert.doesNotMatch(tmuxLog, /run-shell -b sleep \d+; tmux resize-pane -t %3 -y \d+ >/);
          assert.doesNotMatch(tmuxLog, /run-shell tmux resize-pane -t %3 -y \d+ >/);
        },
      );
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevTmuxPane === 'string') process.env.TMUX_PANE = prevTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevMsystem === 'string') process.env.MSYSTEM = prevMsystem;
      else delete process.env.MSYSTEM;
      if (typeof prevOstype === 'string') process.env.OSTYPE = prevOstype;
      else delete process.env.OSTYPE;
      if (typeof prevWsl === 'string') process.env.WSL_DISTRO_NAME = prevWsl;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof prevWslInterop === 'string') process.env.WSL_INTEROP = prevWslInterop;
      else delete process.env.WSL_INTEROP;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects synthetic worker and HUD pane ids that never materialize on native Windows', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-win32-synthetic-pane-'));
    const prevTmux = process.env.TMUX;
    const prevTmuxPane = process.env.TMUX_PANE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevMsystem = process.env.MSYSTEM;
    const prevOstype = process.env.OSTYPE;
    const prevWsl = process.env.WSL_DISTRO_NAME;
    const prevWslInterop = process.env.WSL_INTEROP;
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

    try {
      await withMockTmuxFixture(
        'omx-tmux-win32-synthetic-pane-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
case "\${1:-}" in
  -V)
    echo "tmux 3.3.2"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*)
        echo "120"
        ;;
      *)
        echo "leader:0 %1"
        ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"pane_current_command"*)
        printf "%%1\\tnode\\t'codex'\\n"
        ;;
      *)
        printf "%%1\\n"
        ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *" -h "*)
        echo "%2"
        ;;
      *)
        echo "%3"
        ;;
    esac
    exit 0
    ;;
  kill-pane|select-layout|set-window-option|select-pane|resize-pane|set-hook|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        async ({ logPath }) => {
          const fakeBinDir = join(logPath, '..');
          const geminiPath = join(fakeBinDir, 'gemini');
          const powershellExePath = join(fakeBinDir, 'powershell.exe');
          await writeFile(geminiPath, '#!/bin/sh\nexit 0\n');
          await chmod(geminiPath, 0o755);
          await writeFile(powershellExePath, '');

          process.env.TMUX = 'leader-session,stub,0';
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_CLI = 'gemini';
          delete process.env.MSYSTEM;
          delete process.env.OSTYPE;
          delete process.env.WSL_DISTRO_NAME;
          delete process.env.WSL_INTEROP;
          Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

          assert.throws(
            () => createTeamSession('Windows Team', 1, cwd),
            /worker pane 1 did not remain present/,
          );

          const tmuxLog = await readFile(logPath, 'utf-8');
          const listPaneCalls = tmuxLog.match(/list-panes -t leader:0 -F #\{pane_id\}\t#\{pane_current_command\}\t#\{pane_start_command\}/g) || [];
          assert.ok(listPaneCalls.length >= 2, tmuxLog);
          assert.match(tmuxLog, /kill-pane -t %2/);
        },
      );
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevTmuxPane === 'string') process.env.TMUX_PANE = prevTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevMsystem === 'string') process.env.MSYSTEM = prevMsystem;
      else delete process.env.MSYSTEM;
      if (typeof prevOstype === 'string') process.env.OSTYPE = prevOstype;
      else delete process.env.OSTYPE;
      if (typeof prevWsl === 'string') process.env.WSL_DISTRO_NAME = prevWsl;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof prevWslInterop === 'string') process.env.WSL_INTEROP = prevWslInterop;
      else delete process.env.WSL_INTEROP;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('restores standalone HUD panes with direct resize on native Windows', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-standalone-win32-hud-'));
    const prevLeaderNodePath = process.env.OMX_LEADER_NODE_PATH;
    const prevMsystem = process.env.MSYSTEM;
    const prevOstype = process.env.OSTYPE;
    const prevWsl = process.env.WSL_DISTRO_NAME;
    const prevWslInterop = process.env.WSL_INTEROP;
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

    try {
      await withMockTmuxFixture(
        'omx-tmux-win32-standalone-hud-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
case "\${1:-}" in
  split-window)
    echo "%44"
    exit 0
    ;;
  resize-pane|select-pane)
    exit 0
    ;;
  set-hook|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        async ({ logPath }) => {
          delete process.env.MSYSTEM;
          delete process.env.OSTYPE;
          delete process.env.WSL_DISTRO_NAME;
          delete process.env.WSL_INTEROP;
          process.env.OMX_LEADER_NODE_PATH = 'C:\\Program Files\\nodejs\\node.exe';
          Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

          const paneId = restoreStandaloneHudPane('%11', cwd);
          assert.equal(paneId, '%44');

          const tmuxLog = await readFile(logPath, 'utf-8');
          assert.match(tmuxLog, /'C:\\Program Files\\nodejs\\node\.exe'/);
          assert.match(tmuxLog, new RegExp(`resize-pane -t %44 -y ${HUD_TMUX_TEAM_HEIGHT_LINES}`));
          assert.match(tmuxLog, /select-pane -t %11/);
          assert.doesNotMatch(tmuxLog, /run-shell -b sleep \d+; tmux resize-pane -t %44 -y \d+ >/);
          assert.doesNotMatch(tmuxLog, /run-shell tmux resize-pane -t %44 -y \d+ >/);
          assert.doesNotMatch(tmuxLog, /set-hook -t /);
        },
      );
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevLeaderNodePath === 'string') process.env.OMX_LEADER_NODE_PATH = prevLeaderNodePath;
      else delete process.env.OMX_LEADER_NODE_PATH;
      if (typeof prevMsystem === 'string') process.env.MSYSTEM = prevMsystem;
      else delete process.env.MSYSTEM;
      if (typeof prevOstype === 'string') process.env.OSTYPE = prevOstype;
      else delete process.env.OSTYPE;
      if (typeof prevWsl === 'string') process.env.WSL_DISTRO_NAME = prevWsl;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof prevWslInterop === 'string') process.env.WSL_INTEROP = prevWslInterop;
      else delete process.env.WSL_INTEROP;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reuses an existing standalone HUD pane across repeated restore calls', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-standalone-reuse-hud-'));

    try {
      await withMockTmuxFixture(
        'omx-tmux-reuse-standalone-hud-',
        (logPath) => {
          const statePath = `${logPath}.state`;
          return `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
case "\${1:-}" in
  list-panes)
    printf '%%11\\tzsh\\tzsh\\n'
    if [ -f "${statePath}" ]; then
      printf "%%44\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%11' /node /omx.js hud --watch\\n"
    fi
    exit 0
    ;;
  split-window)
    : > "${statePath}"
    echo "%44"
    exit 0
    ;;
  run-shell|select-pane|resize-pane|set-hook|kill-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
        },
        async ({ logPath }) => {
          const firstPaneId = restoreStandaloneHudPane('%11', cwd);
          const secondPaneId = restoreStandaloneHudPane('%11', cwd);

          assert.equal(firstPaneId, '%44');
          assert.equal(secondPaneId, '%44');

          const tmuxLog = await readFile(logPath, 'utf-8');
          const splitCount = (tmuxLog.match(/(^|\n)split-window /g) ?? []).length;
          assert.equal(splitCount, 1);
          assert.doesNotMatch(tmuxLog, /kill-pane -t %44/);
          assert.match(tmuxLog, /list-panes -t %11 -F #\{pane_id\}\t#\{pane_current_command\}\t#\{pane_start_command\}/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('restores standalone HUD panes from the live leader pane cwd with explicit session ownership', async () => {
    const teamLaunchCwd = await mkdtemp(join(tmpdir(), 'omx-standalone-team-launch-cwd-'));
    const leaderPaneCwd = await mkdtemp(join(tmpdir(), 'omx-standalone-leader-pane-cwd-'));

    try {
      await withMockTmuxFixture(
        'omx-tmux-leader-cwd-standalone-hud-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
case "\${1:-}" in
  display-message)
    case "$*" in
      *"#{pane_current_path}"*)
        echo "${leaderPaneCwd}"
        ;;
    esac
    exit 0
    ;;
  split-window)
    echo "%44"
    exit 0
    ;;
  run-shell|select-pane|resize-pane|set-hook)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        async ({ logPath }) => {
          const paneId = restoreStandaloneHudPane('%11', teamLaunchCwd, {
            sessionId: 'current-session-for-hud',
          });
          assert.equal(paneId, '%44');

          const tmuxLog = await readFile(logPath, 'utf-8');
          assert.match(tmuxLog, /display-message -p -t %11 #\{pane_current_path\}/);
          assert.match(tmuxLog, new RegExp(`split-window -v -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t %11 -d -P -F #\\{pane_id\\} -c ${escapeRegExp(leaderPaneCwd)} `));
          assert.doesNotMatch(tmuxLog, new RegExp(`split-window .* -c ${escapeRegExp(teamLaunchCwd)} `));
          assert.match(
            tmuxLog,
            /exec env OMX_SESSION_ID='current-session-for-hud' OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%11' .*hud --watch/,
          );
        },
      );
    } finally {
      await rm(teamLaunchCwd, { recursive: true, force: true });
      await rm(leaderPaneCwd, { recursive: true, force: true });
    }
  });

  it('falls back to the team launch cwd when the live leader pane cwd is unusable', async () => {
    const teamLaunchCwd = await mkdtemp(join(tmpdir(), 'omx-standalone-team-launch-cwd-fallback-'));
    const deletedLeaderPaneCwd = await mkdtemp(join(tmpdir(), 'omx-standalone-deleted-leader-pane-cwd-'));
    await rm(deletedLeaderPaneCwd, { recursive: true, force: true });

    try {
      await withMockTmuxFixture(
        'omx-tmux-deleted-leader-cwd-standalone-hud-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
case "\${1:-}" in
  display-message)
    case "$*" in
      *"#{pane_current_path}"*)
        echo "${deletedLeaderPaneCwd}"
        ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *"-c ${teamLaunchCwd} "*)
        echo "%44"
        exit 0
        ;;
      *"-c ${deletedLeaderPaneCwd} "*)
        echo "deleted cwd should not be used" >&2
        exit 1
        ;;
      *)
        echo "unexpected cwd: $*" >&2
        exit 1
        ;;
    esac
    ;;
  run-shell|select-pane|resize-pane|set-hook)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        async ({ logPath }) => {
          const paneId = restoreStandaloneHudPane('%11', teamLaunchCwd, {
            sessionId: 'current-session-for-hud',
          });
          assert.equal(paneId, '%44');

          const tmuxLog = await readFile(logPath, 'utf-8');
          assert.match(tmuxLog, /display-message -p -t %11 #\{pane_current_path\}/);
          assert.match(tmuxLog, new RegExp(`split-window -v -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t %11 -d -P -F #\\{pane_id\\} -c ${escapeRegExp(teamLaunchCwd)} `));
          assert.doesNotMatch(tmuxLog, new RegExp(`split-window .* -c ${escapeRegExp(deletedLeaderPaneCwd)} `));
          assert.match(tmuxLog, /select-pane -t %11/);
        },
      );
    } finally {
      await rm(teamLaunchCwd, { recursive: true, force: true });
    }
  });

  it('keeps MSYS drive-style live leader cwd candidates without raw stat prefiltering', async () => {
    const liveLeaderCwd = '/c/live';
    const fallbackCwd = 'C:\\fallback';
    const fakeCygpathDir = await mkdtemp(join(tmpdir(), 'omx-msys-live-cygpath-'));
    const previousPath = process.env.PATH;
    const previousMsystem = process.env.MSYSTEM;
    const previousOstype = process.env.OSTYPE;
    const previousWsl = process.env.WSL_DISTRO_NAME;
    const previousWslInterop = process.env.WSL_INTEROP;
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const statCalls: string[] = [];

    try {
      const cygpathPath = join(fakeCygpathDir, 'cygpath');
      await writeFile(cygpathPath, '#!/bin/sh\nprintf "%s\\n" "$2"\n');
      await chmod(cygpathPath, 0o755);
      process.env.PATH = `${fakeCygpathDir}:${previousPath ?? ''}`;
      process.env.MSYSTEM = 'MINGW64';
      process.env.OSTYPE = 'msys';
      delete process.env.WSL_DISTRO_NAME;
      delete process.env.WSL_INTEROP;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      await withMockTmuxFixture(
        'omx-tmux-msys-live-cwd-standalone-hud-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
case "\${1:-}" in
  display-message)
    case "$*" in
      *"#{pane_current_path}"*)
        echo "${liveLeaderCwd}"
        ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *"-c ${liveLeaderCwd} "*)
        echo "%44"
        exit 0
        ;;
      *"-c ${fallbackCwd} "*)
        echo "fallback cwd should not be used when MSYS live cwd succeeds" >&2
        exit 1
        ;;
      *)
        echo "unexpected cwd: $*" >&2
        exit 1
        ;;
    esac
    ;;
  run-shell|select-pane|resize-pane|set-hook)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        async ({ logPath }) => {
          const paneId = withMockedStatSync(
            ((pathLike: fs.PathLike) => {
              const value = String(pathLike);
              statCalls.push(value);
              if (value === fallbackCwd) return { isDirectory: () => true } as fs.Stats;
              return { isDirectory: () => false } as fs.Stats;
            }) as typeof fs.statSync,
            () => restoreStandaloneHudPane('%11', fallbackCwd, { sessionId: 'current-session-for-hud' }),
          );
          assert.equal(paneId, '%44');
          assert.equal(statCalls.includes(liveLeaderCwd), false);
          assert.equal(statCalls.includes(fallbackCwd), true);

          const tmuxLog = await readFile(logPath, 'utf-8');
          assert.match(tmuxLog, /display-message -p -t %11 #\{pane_current_path\}/);
          assert.match(tmuxLog, new RegExp(`split-window -v -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t %11 -d -P -F #\\{pane_id\\} -c ${escapeRegExp(liveLeaderCwd)} `));
          assert.doesNotMatch(tmuxLog, new RegExp(`split-window .* -c ${escapeRegExp(fallbackCwd)} `));
          assert.match(tmuxLog, /select-pane -t %11/);
        },
      );
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousMsystem === 'string') process.env.MSYSTEM = previousMsystem;
      else delete process.env.MSYSTEM;
      if (typeof previousOstype === 'string') process.env.OSTYPE = previousOstype;
      else delete process.env.OSTYPE;
      if (typeof previousWsl === 'string') process.env.WSL_DISTRO_NAME = previousWsl;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof previousWslInterop === 'string') process.env.WSL_INTEROP = previousWslInterop;
      else delete process.env.WSL_INTEROP;
      await rm(fakeCygpathDir, { recursive: true, force: true });
    }
  });

  it('falls back after an unusable MSYS drive-style live leader cwd split attempt fails', async () => {
    const liveLeaderCwd = '/c/deleted-live';
    const fallbackCwd = 'C:\\fallback';
    const fakeCygpathDir = await mkdtemp(join(tmpdir(), 'omx-msys-deleted-live-cygpath-'));
    const previousPath = process.env.PATH;
    const previousMsystem = process.env.MSYSTEM;
    const previousOstype = process.env.OSTYPE;
    const previousWsl = process.env.WSL_DISTRO_NAME;
    const previousWslInterop = process.env.WSL_INTEROP;
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const statCalls: string[] = [];

    try {
      const cygpathPath = join(fakeCygpathDir, 'cygpath');
      await writeFile(cygpathPath, '#!/bin/sh\nprintf "%s\\n" "$2"\n');
      await chmod(cygpathPath, 0o755);
      process.env.PATH = `${fakeCygpathDir}:${previousPath ?? ''}`;
      process.env.MSYSTEM = 'MINGW64';
      process.env.OSTYPE = 'msys';
      delete process.env.WSL_DISTRO_NAME;
      delete process.env.WSL_INTEROP;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      await withMockTmuxFixture(
        'omx-tmux-msys-deleted-live-cwd-standalone-hud-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
case "\${1:-}" in
  display-message)
    case "$*" in
      *"#{pane_current_path}"*)
        echo "${liveLeaderCwd}"
        ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *"-c ${liveLeaderCwd} "*)
        echo "deleted live cwd cannot be used" >&2
        exit 1
        ;;
      *"-c ${fallbackCwd} "*)
        echo "%44"
        exit 0
        ;;
      *)
        echo "unexpected cwd: $*" >&2
        exit 1
        ;;
    esac
    ;;
  run-shell|select-pane|resize-pane|set-hook)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        async ({ logPath }) => {
          const paneId = withMockedStatSync(
            ((pathLike: fs.PathLike) => {
              const value = String(pathLike);
              statCalls.push(value);
              if (value === fallbackCwd) return { isDirectory: () => true } as fs.Stats;
              return { isDirectory: () => false } as fs.Stats;
            }) as typeof fs.statSync,
            () => restoreStandaloneHudPane('%11', fallbackCwd, { sessionId: 'current-session-for-hud' }),
          );
          assert.equal(paneId, '%44');
          assert.equal(statCalls.includes(liveLeaderCwd), false);
          assert.equal(statCalls.includes(fallbackCwd), true);

          const tmuxLog = await readFile(logPath, 'utf-8');
          const liveAttemptIndex = tmuxLog.indexOf(`-c ${liveLeaderCwd} `);
          const fallbackAttemptIndex = tmuxLog.indexOf(`-c ${fallbackCwd} `);
          assert.ok(liveAttemptIndex >= 0, 'deleted MSYS live cwd should still be attempted');
          assert.ok(fallbackAttemptIndex > liveAttemptIndex, 'fallback should be attempted after live split failure');
          assert.match(tmuxLog, /select-pane -t %11/);
        },
      );
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousMsystem === 'string') process.env.MSYSTEM = previousMsystem;
      else delete process.env.MSYSTEM;
      if (typeof previousOstype === 'string') process.env.OSTYPE = previousOstype;
      else delete process.env.OSTYPE;
      if (typeof previousWsl === 'string') process.env.WSL_DISTRO_NAME = previousWsl;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof previousWslInterop === 'string') process.env.WSL_INTEROP = previousWslInterop;
      else delete process.env.WSL_INTEROP;
      await rm(fakeCygpathDir, { recursive: true, force: true });
    }
  });

  it('restores standalone HUD panes with an absolute OMX entry path after cwd drift', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-standalone-relative-hud-'));
    const startupCwd = await mkdtemp(join(tmpdir(), 'omx-standalone-relative-start-'));
    const previousEntryPath = process.env[OMX_ENTRY_PATH_ENV];
    const previousStartupCwd = process.env[OMX_STARTUP_CWD_ENV];
    const previousArgv = process.argv;

    try {
      const launcherDir = join(startupCwd, 'dist', 'cli');
      const launcherPath = join(launcherDir, 'omx.js');
      await mkdir(launcherDir, { recursive: true });
      await writeFile(launcherPath, '#!/usr/bin/env node\n');

      await withMockTmuxFixture(
        'omx-tmux-relative-standalone-hud-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
case "\${1:-}" in
  split-window)
    echo "%44"
    exit 0
    ;;
  run-shell|select-pane|resize-pane|set-hook)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        async ({ logPath }) => {
          delete process.env[OMX_ENTRY_PATH_ENV];
          process.env[OMX_STARTUP_CWD_ENV] = startupCwd;
          process.argv = [previousArgv[0] || 'node', 'dist/cli/omx.js'];

          const paneId = restoreStandaloneHudPane('%11', cwd);
          assert.equal(paneId, '%44');

          const tmuxLog = await readFile(logPath, 'utf-8');
          assert.match(tmuxLog, new RegExp(escapeRegExp(launcherPath)));
          assert.doesNotMatch(tmuxLog, /'dist\/cli\/omx\.js' hud --watch/);
          assert.match(tmuxLog, /exec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%11' .*hud --watch/);
        },
      );
    } finally {
      process.argv = previousArgv;
      if (typeof previousEntryPath === 'string') process.env[OMX_ENTRY_PATH_ENV] = previousEntryPath;
      else delete process.env[OMX_ENTRY_PATH_ENV];
      if (typeof previousStartupCwd === 'string') process.env[OMX_STARTUP_CWD_ENV] = previousStartupCwd;
      else delete process.env[OMX_STARTUP_CWD_ENV];
      await rm(cwd, { recursive: true, force: true });
      await rm(startupCwd, { recursive: true, force: true });
    }
  });

  it('restores standalone HUD panes with the packaged CLI entry when argv1 is not the OMX CLI', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-standalone-noncli-hud-'));
    const previousArgv = process.argv;

    try {
      await withMockTmuxFixture(
        'omx-tmux-noncli-standalone-hud-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
case "\${1:-}" in
  split-window)
    echo "%44"
    exit 0
    ;;
  run-shell|select-pane|resize-pane|set-hook)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        async ({ logPath }) => {
          process.argv = [previousArgv[0] || 'node', '/tmp/codex-host-binary'];

          const paneId = restoreStandaloneHudPane('%11', cwd);
          assert.equal(paneId, '%44');

          const tmuxLog = await readFile(logPath, 'utf-8');
          assert.match(tmuxLog, /dist\/cli\/omx\.js' hud --watch/);
          assert.doesNotMatch(tmuxLog, /\/tmp\/codex-host-binary' hud --watch/);
          assert.match(tmuxLog, /exec env OMX_TMUX_HUD_OWNER=1 .*hud --watch/);
        },
      );
    } finally {
      process.argv = previousArgv;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('restores standalone HUD panes with OMX_ROOT forwarded and shell-escaped', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-standalone-root-hud-'));
    const previousOmxRoot = process.env.OMX_ROOT;

    try {
      await withMockTmuxFixture(
        'omx-tmux-root-standalone-hud-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
case "\${1:-}" in
  split-window)
    echo "%44"
    exit 0
    ;;
  run-shell|select-pane|resize-pane|set-hook)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        async ({ logPath }) => {
          process.env.OMX_ROOT = "/tmp/boxed root/it's/$(literal)";

          const paneId = restoreStandaloneHudPane('%11', cwd);
          assert.equal(paneId, '%44');

          const tmuxLog = await readFile(logPath, 'utf-8');
          assert.match(
            tmuxLog,
            /exec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%11' OMX_ROOT='\/tmp\/boxed root\/it'\\''s\/\$\(literal\)' .*hud --watch/,
          );
        },
      );
    } finally {
      if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
      else delete process.env.OMX_ROOT;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('dismissTrustPromptIfPresent capture shape', () => {
  it('uses visible capture-pane argv without tail flags', async () => {
    const previousAutoTrust = process.env.OMX_TEAM_AUTO_TRUST;
    delete process.env.OMX_TEAM_AUTO_TRUST;
    try {
      await withMockTmuxFixture(
        'omx-tmux-dismiss-trust-visible-capture-',
        (logPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${logPath}"
case "$1" in
  capture-pane)
    cat <<'EOF'
Do you trust the contents of this directory?
Press enter to continue
EOF
    exit 0
    ;;
  send-keys)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        async ({ logPath }) => {
          assert.equal(dismissTrustPromptIfPresent('omx-team-x', 1), true);
          const log = await readFile(logPath, 'utf-8');
          assert.match(log, /capture-pane -t omx-team-x:1 -p/);
          assert.doesNotMatch(log, /capture-pane -t omx-team-x:1 -p -S/);
        },
      );
    } finally {
      if (typeof previousAutoTrust === 'string') process.env.OMX_TEAM_AUTO_TRUST = previousAutoTrust;
      else delete process.env.OMX_TEAM_AUTO_TRUST;
    }
  });
});

describe('dismissTrustPromptIfPresent', () => {
  it('returns false when tmux is unavailable', () => {
    withEmptyPath(() => {
      assert.equal(dismissTrustPromptIfPresent('omx-team-x', 1), false);
    });
  });

  it('returns false when OMX_TEAM_AUTO_TRUST is disabled', () => {
    const prev = process.env.OMX_TEAM_AUTO_TRUST;
    process.env.OMX_TEAM_AUTO_TRUST = '0';
    try {
      assert.equal(dismissTrustPromptIfPresent('omx-team-x', 1), false);
    } finally {
      if (typeof prev === 'string') process.env.OMX_TEAM_AUTO_TRUST = prev;
      else delete process.env.OMX_TEAM_AUTO_TRUST;
    }
  });

  it('returns false when OMX_TEAM_AUTO_TRUST is unset (auto-trust enabled) but tmux unavailable', () => {
    const prev = process.env.OMX_TEAM_AUTO_TRUST;
    delete process.env.OMX_TEAM_AUTO_TRUST;
    try {
      withEmptyPath(() => {
        assert.equal(dismissTrustPromptIfPresent('omx-team-x', 1), false);
      });
    } finally {
      if (typeof prev === 'string') process.env.OMX_TEAM_AUTO_TRUST = prev;
    }
  });
});

describe('isWorkerAlive', () => {
  it('does not require pane_current_command to match "codex"', () => {
    // This was a real failure mode: tmux reports pane_current_command=node for the Codex TUI,
    // which caused workers to be treated as dead and the leader to clean up state too early.
    withEmptyPath(() => {
      assert.equal(isWorkerAlive('omx-team-x', 1), false);
    });
  });

  it('treats an existing non-dead pane id as live even when pane_pid is unavailable', async () => {
    await withMockTmuxFixture(
      'omx-pane-id-liveness-',
      (logPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${logPath}"
case "\${1:-}" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  list-panes)
    if [ "$2" = "-a" ]; then
      printf "%%77 0 \\n%%88 1 \\n"
      exit 0
    fi
    exit 1
    ;;
  *)
    exit 1
    ;;
esac
`,
      async () => {
        assert.equal(isWorkerAlive('ignored-session', 1, '%77'), true);
        assert.equal(isWorkerPaneOpen('ignored-session', 1, '%77'), true);
        assert.equal(isWorkerAlive('ignored-session', 2, '%88'), false);
      },
    );
  });
});

describe('isWsl2', () => {
  it('returns true when WSL_DISTRO_NAME is set', () => {
    const prev = process.env.WSL_DISTRO_NAME;
    process.env.WSL_DISTRO_NAME = 'Ubuntu-22.04';
    try {
      assert.equal(isWsl2(), true);
    } finally {
      if (typeof prev === 'string') process.env.WSL_DISTRO_NAME = prev;
      else delete process.env.WSL_DISTRO_NAME;
    }
  });

  it('returns true when WSL_INTEROP is set and WSL_DISTRO_NAME is absent', () => {
    const prevDistro = process.env.WSL_DISTRO_NAME;
    const prevInterop = process.env.WSL_INTEROP;
    delete process.env.WSL_DISTRO_NAME;
    process.env.WSL_INTEROP = '/run/WSL/8_interop';
    try {
      assert.equal(isWsl2(), true);
    } finally {
      if (typeof prevDistro === 'string') process.env.WSL_DISTRO_NAME = prevDistro;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof prevInterop === 'string') process.env.WSL_INTEROP = prevInterop;
      else delete process.env.WSL_INTEROP;
    }
  });

  it('returns a boolean without throwing when no WSL env vars are present', () => {
    const prevDistro = process.env.WSL_DISTRO_NAME;
    const prevInterop = process.env.WSL_INTEROP;
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    try {
      assert.equal(typeof isWsl2(), 'boolean');
    } finally {
      if (typeof prevDistro === 'string') process.env.WSL_DISTRO_NAME = prevDistro;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof prevInterop === 'string') process.env.WSL_INTEROP = prevInterop;
      else delete process.env.WSL_INTEROP;
    }
  });
});

describe('isMsysOrGitBash', () => {
  it('returns true on win32 when MSYSTEM is set', () => {
    assert.equal(isMsysOrGitBash({ MSYSTEM: 'MINGW64' }, 'win32'), true);
  });

  it('returns true on win32 when OSTYPE indicates msys/mingw', () => {
    assert.equal(isMsysOrGitBash({ OSTYPE: 'msys' }, 'win32'), true);
    assert.equal(isMsysOrGitBash({ OSTYPE: 'mingw64' }, 'win32'), true);
  });

  it('returns false outside win32', () => {
    assert.equal(isMsysOrGitBash({ MSYSTEM: 'MINGW64' }, 'linux'), false);
  });
});

describe('translatePathForMsys', () => {
  it('returns original path outside MSYS2/Git Bash', () => {
    assert.equal(translatePathForMsys('C:\\repo\\AGENTS.md', {}, 'linux'), 'C:\\repo\\AGENTS.md');
  });

  it('uses cygpath translation when available', () => {
    const translated = translatePathForMsys(
      'C:\\repo\\AGENTS.md',
      { MSYSTEM: 'MINGW64' },
      'win32',
      () => ({ status: 0, stdout: '/c/repo/AGENTS.md\n', stderr: '', error: undefined, output: [] as string[] }) as any,
    );
    assert.equal(translated, '/c/repo/AGENTS.md');
  });

  it('falls back gracefully when cygpath is unavailable', () => {
    const translated = translatePathForMsys(
      'C:\\repo\\AGENTS.md',
      { MSYSTEM: 'MINGW64' },
      'win32',
      () => ({ status: 1, stdout: '', stderr: 'not found', error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), output: [] as string[] }) as any,
    );
    assert.equal(translated, '/c/repo/AGENTS.md');
  });
});

describe('isNativeWindows', () => {
  it('returns true when process.platform is win32 and not WSL2', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const prevDistro = process.env.WSL_DISTRO_NAME;
    const prevInterop = process.env.WSL_INTEROP;
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      assert.equal(isNativeWindows(), true);
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevDistro === 'string') process.env.WSL_DISTRO_NAME = prevDistro;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof prevInterop === 'string') process.env.WSL_INTEROP = prevInterop;
      else delete process.env.WSL_INTEROP;
    }
  });

  it('returns false when process.platform is win32 but WSL2 is detected', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const prevDistro = process.env.WSL_DISTRO_NAME;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.WSL_DISTRO_NAME = 'Ubuntu-22.04';
    try {
      assert.equal(isNativeWindows(), false);
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevDistro === 'string') process.env.WSL_DISTRO_NAME = prevDistro;
      else delete process.env.WSL_DISTRO_NAME;
    }
  });

  it('returns false on win32 when MSYS2/Git Bash is detected', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const prevMsystem = process.env.MSYSTEM;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.MSYSTEM = 'MINGW64';
    try {
      assert.equal(isNativeWindows(), false);
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevMsystem === 'string') process.env.MSYSTEM = prevMsystem;
      else delete process.env.MSYSTEM;
    }
  });

  it('returns false on Linux', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      assert.equal(isNativeWindows(), false);
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
    }
  });

  it('returns false on macOS', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      assert.equal(isNativeWindows(), false);
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
    }
  });
});

describe('enableMouseScrolling', () => {
  it('returns false when tmux is unavailable', () => {
    // When tmux is not on PATH, enableMouseScrolling should gracefully return false
    // rather than throwing, so callers do not need to guard against errors.
    withEmptyPath(() => {
      assert.equal(enableMouseScrolling('omx-team-x'), false);
    });
  });

  it('returns false for empty session target when tmux unavailable', () => {
    withEmptyPath(() => {
      assert.equal(enableMouseScrolling(''), false);
    });
  });

  it('returns false in WSL2 environment when tmux is unavailable', () => {
    // WSL2 path: even with the XT override branch active, the function must
    // return false (not throw) when tmux is not on PATH.
    const prev = process.env.WSL_DISTRO_NAME;
    process.env.WSL_DISTRO_NAME = 'Ubuntu-22.04';
    try {
      withEmptyPath(() => {
        assert.equal(enableMouseScrolling('omx-team-x'), false);
      });
    } finally {
      if (typeof prev === 'string') process.env.WSL_DISTRO_NAME = prev;
      else delete process.env.WSL_DISTRO_NAME;
    }
  });
});

describe('killWorkerByPaneId leader pane guard', () => {
  it('skips kill when workerPaneId matches leaderPaneId (guard fires before tmux is called)', () => {
    // With empty PATH tmux is unavailable, so any actual kill-pane call would fail.
    // When the guard fires (paneId === leaderPaneId) the function returns early
    // without invoking tmux, so no error is thrown regardless of PATH.
    withEmptyPath(() => {
      assert.doesNotThrow(() => killWorkerByPaneId('%5', '%5'));
    });
  });

  it('does not skip kill when pane ids differ (falls through to tmux attempt)', () => {
    // Different IDs: guard does not fire. tmux is unavailable but kill errors are swallowed internally.
    withEmptyPath(() => {
      assert.doesNotThrow(() => killWorkerByPaneId('%5', '%6'));
    });
  });

  it('skips kill for non-percent pane id without reaching tmux', () => {
    withEmptyPath(() => {
      assert.doesNotThrow(() => killWorkerByPaneId('invalid', '%5'));
    });
  });

  it('skips kill when no leaderPaneId provided and pane id is valid percent id', () => {
    // Without leaderPaneId the guard is not active; tmux call fails gracefully.
    withEmptyPath(() => {
      assert.doesNotThrow(() => killWorkerByPaneId('%5'));
    });
  });
});

describe('sleepFractionalSeconds', () => {
  it('uses ceil(ms) so sub-millisecond positive values still sleep', () => {
    const calls: number[] = [];
    const captureSleep = (ms: number): void => {
      calls.push(ms);
    };

    sleepFractionalSeconds(0.1, captureSleep);
    sleepFractionalSeconds(0.0001, captureSleep);

    assert.deepEqual(calls, [100, 1]);
  });

  it('ignores invalid values and clamps extreme sleeps to 60s max', () => {
    const calls: number[] = [];
    const captureSleep = (ms: number): void => {
      calls.push(ms);
    };

    sleepFractionalSeconds(0, captureSleep);
    sleepFractionalSeconds(-1, captureSleep);
    sleepFractionalSeconds(NaN, captureSleep);
    sleepFractionalSeconds(Number.POSITIVE_INFINITY, captureSleep);
    sleepFractionalSeconds(999_999, captureSleep);

    assert.deepEqual(calls, [60_000]);
  });
});

describe('enableMouseScrolling scroll and copy setup (issue #206)', () => {
  it('returns false gracefully when scroll-copy setup fails because tmux is unavailable', () => {
    // With empty PATH the initial "mouse on" call fails, so the function returns
    // false before any binding calls are made. No throw must occur.
    withEmptyPath(() => {
      assert.equal(enableMouseScrolling('omx-team-x'), false);
    });
  });

  it('does not throw when WSL2 env is set and tmux is unavailable (regression + #206)', () => {
    const prev = process.env.WSL_DISTRO_NAME;
    process.env.WSL_DISTRO_NAME = 'Ubuntu-22.04';
    try {
      withEmptyPath(() => {
        assert.doesNotThrow(() => enableMouseScrolling('omx-team-x'));
      });
    } finally {
      if (typeof prev === 'string') process.env.WSL_DISTRO_NAME = prev;
      else delete process.env.WSL_DISTRO_NAME;
    }
  });
});


describe('enableMouseScrolling session scoping (issue #817)', () => {
  it('only applies session-scoped tmux options and does not mutate global bindings or terminal-overrides', async () => {
    await withMockTmuxFixture(
      'omx-tmux-enable-mouse-scope-',
      (tmuxLogPath) => `#!/bin/sh
printf '%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  show-options)
    if [ "$2" = "-gv" ] && [ "$3" = "-t" ] && [ "$4" = "omx-team-x" ] && [ "$5" = "mode-style" ]; then
      printf '%s\n' 'bg=yellow,fg=black,underscore'
      exit 0
    fi
    exit 1
    ;;
  set-option)
    if [ "$2" = "-t" ]; then
      exit 0
    fi
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`,
      async ({ logPath }) => {
        assert.equal(enableMouseScrolling('omx-team-x'), true);
        const tmuxLog = await readFile(logPath, 'utf-8');
        assert.match(tmuxLog, /set-option -t omx-team-x mouse on/);
        assert.match(tmuxLog, /set-option -t omx-team-x set-clipboard on/);
        assert.match(
          tmuxLog,
          /set-option -t omx-team-x mode-style bg=yellow,fg=black,underscore,nounderscore,nodouble-underscore,nocurly-underscore,nodotted-underscore,nodashed-underscore/,
        );
        assert.doesNotMatch(tmuxLog, /bind-key/);
        assert.doesNotMatch(tmuxLog, /terminal-overrides/);
      },
    );
  });
});

describe('mitigateCopyModeUnderlineArtifacts', () => {
  it('best-effort sanitizes copy-mode style options without requiring global tmux changes', async () => {
    await withMockTmuxFixture(
      'omx-tmux-sanitize-copy-style-',
      (tmuxLogPath) => `#!/bin/sh
printf '%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  show-options)
    if [ "$2" = "-gv" ] && [ "$3" = "-t" ] && [ "$4" = "omx-team-x" ] && [ "$5" = "mode-style" ]; then
      printf '%s\n' 'bg=yellow,fg=black,underscore'
      exit 0
    fi
    if [ "$2" = "-gv" ] && [ "$3" = "-t" ] && [ "$4" = "omx-team-x" ] && [ "$5" = "copy-mode-selection-style" ]; then
      printf '%s\n' 'fg=white,bg=blue,curly-underscore'
      exit 0
    fi
    exit 1
    ;;
  set-option)
    if [ "$2" = "-t" ]; then
      exit 0
    fi
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`,
      async ({ logPath }) => {
        assert.equal(mitigateCopyModeUnderlineArtifacts('omx-team-x'), true);
        const tmuxLog = await readFile(logPath, 'utf-8');
        assert.match(
          tmuxLog,
          /set-option -t omx-team-x mode-style bg=yellow,fg=black,underscore,nounderscore,nodouble-underscore,nocurly-underscore,nodotted-underscore,nodashed-underscore/,
        );
        assert.match(
          tmuxLog,
          /set-option -t omx-team-x copy-mode-selection-style fg=white,bg=blue,curly-underscore,nounderscore,nodouble-underscore,nocurly-underscore,nodotted-underscore,nodashed-underscore/,
        );
        assert.doesNotMatch(tmuxLog, /set-option -g/);
      },
    );
  });
});

describe('killWorker leader pane guard', () => {
  it('returns immediately when workerPaneId matches leaderPaneId', () => {
    // Guard fires before any tmux send-keys call, so no error even with empty PATH.
    withEmptyPath(() => {
      assert.doesNotThrow(() => killWorker('omx-team-x:0', 1, '%5', '%5'));
    });
  });

  it('proceeds (gracefully) when pane ids differ', () => {
    // Guard does not fire; tmux calls fail gracefully with empty PATH.
    withEmptyPath(() => {
      assert.doesNotThrow(() => killWorker('omx-team-x:0', 1, '%5', '%6'));
    });
  });

  it('proceeds when leaderPaneId is not provided', () => {
    withEmptyPath(() => {
      assert.doesNotThrow(() => killWorker('omx-team-x:0', 1, '%5'));
    });
  });
});

describe('teardownWorkerPanes shared primitive', () => {
  it('excludes leader and hud panes in shared pane-kill primitive', async () => {
    await withMockTmuxFixture(
      'omx-tmux-teardown-',
      (logPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
exit 0
`,
      async ({ logPath }) => {
        const summary = await teardownWorkerPanes(['%1', '%2', '%3'], {
          leaderPaneId: '%1',
          hudPaneId: '%2',
          graceMs: 1,
        });

        assert.equal(summary.excluded.leader, 1);
        assert.equal(summary.excluded.hud, 1);
        assert.equal(summary.kill.attempted, 1);
        assert.equal(summary.kill.succeeded, 1);
        const log = await readFile(logPath, 'utf-8');
        assert.match(log, /kill-pane -t %3/);
        assert.doesNotMatch(log, /kill-pane -t %1/);
        assert.doesNotMatch(log, /kill-pane -t %2/);
      },
    );
  });

  it('uses pane-id-direct kill semantics without liveness-gated helper calls', async () => {
    const source = await readFile(new URL('../tmux-session.js', import.meta.url), 'utf-8');
    const primitiveBlock = source.split('export async function teardownWorkerPanes')[1] ?? '';
    assert.equal(primitiveBlock.includes('isWorkerAlive'), false);
    assert.equal(primitiveBlock.includes('killWorker('), false);
  });

  it('continues best-effort when a pane target is missing', async () => {
    await withMockTmuxFixture(
      'omx-tmux-teardown-missing-',
      (logPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
if [ "$1" = "kill-pane" ] && [ "\${3:-}" = "%404" ]; then
  echo "missing pane" >&2
  exit 1
fi
exit 0
`,
      async ({ logPath }) => {
        const summary = await teardownWorkerPanes(['%404', '%405'], { graceMs: 1 });
        assert.equal(summary.kill.attempted, 2);
        assert.equal(summary.kill.succeeded, 1);
        assert.equal(summary.kill.failed, 1);
        const log = await readFile(logPath, 'utf-8');
        assert.match(log, /kill-pane -t %404/);
        assert.match(log, /kill-pane -t %405/);
      },
    );
  });
});

describe('leader mailbox-only boundary', () => {
  it('does not export direct leader pane injection helper', () => {
    assert.equal('sendToLeaderPane' in tmuxSessionModule, false);
  });
});
