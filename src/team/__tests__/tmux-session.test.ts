import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
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
  buildHudPaneTarget,
  chooseTeamLeaderPaneId,
  createTeamSession,
  enableMouseScrolling,
  isMsysOrGitBash,
  isNativeWindows,
  isTmuxAvailable,
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
  paneIsBootstrapping,
  dismissTrustPromptIfPresent,
  mitigateCopyModeUnderlineArtifacts,
} from '../tmux-session.js';
import { HUD_RESIZE_RECONCILE_DELAY_SECONDS, HUD_TMUX_TEAM_HEIGHT_LINES } from '../../hud/constants.js';
import * as tmuxSessionModule from '../tmux-session.js';
import { OMX_ENTRY_PATH_ENV, OMX_STARTUP_CWD_ENV } from '../../utils/paths.js';

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
  const original = fs.existsSync;
  fs.existsSync = mock;
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fs.existsSync = original;
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
│ model:     gpt-5.5 high   /model to change │
│ directory: ~/Workspace/demo                │
╰────────────────────────────────────────────╯

How can I help you today?`;

const VIEWPORT_WITHOUT_VISIBLE_PROMPT_CAPTURE = `╭────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.118.0)                 │
│                                            │
│ model:     gpt-5.5 high   /model to change │
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

  it('buildRegisterResizeHookArgs uses window target and numeric client-resized hook slot', () => {
    const args = buildRegisterResizeHookArgs('my-session:0', 'omx_resize_team_session_0_1', '%1');
    assert.equal(args[0], 'set-hook');
    assert.equal(args[1], '-t');
    assert.equal(args[2], 'my-session:0');
    assert.match(args[3] ?? '', /^client-resized\[\d+\]$/);
    assert.equal(args[4], `run-shell -b 'tmux resize-pane -t %1 -y ${HUD_TMUX_TEAM_HEIGHT_LINES} >/dev/null 2>&1 || true'`);
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
    process.argv = [...prevArgv, '--madmax'];
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

  it('uses zsh with ~/.zshrc and non-login shell exec semantics', () => {
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
      assert.match(cmd, /source ~\/\.zshrc/);
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
      assert.match(cmd, /source ~\/\.zshrc/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('uses bash with ~/.bashrc and preserves launch args', () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, ['--model', 'gpt-5']);
      assert.match(cmd, /source ~\/\.bashrc/);
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
    process.argv = [...prevArgv, '--dangerously-bypass-approvals-and-sandbox'];
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
    process.argv = [...prevArgv, '--madmax'];
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
        ['--model', 'gpt-5.3-codex-spark', '-c', 'model_reasoning_effort="low"'],
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
      assert.match(cmd, /\.bashrc/, 'must source bash rc file for bash fallback');
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
      translateWorkerLaunchArgsForCli('gemini', ['--model', 'gpt-5.3-codex-spark'], 'Read worker inbox'),
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
        ['--model', 'gpt-5.3-codex'],
        '/tmp/workspace',
        { OMX_TEAM_STATE_ROOT: '/tmp/workspace/.omx/state' },
        'codex',
      );
      // command is now the resolved absolute path (or bare binary if which fails)
      assert.equal(spec.workerCli, 'codex');
      assert.ok(typeof spec.command === 'string' && spec.command.length > 0, 'command must be a non-empty string');
      assert.deepEqual(spec.args, ['--model', 'gpt-5.3-codex', '--dangerously-bypass-approvals-and-sandbox']);
      assert.equal(spec.env.OMX_TEAM_WORKER, 'alpha-team/worker-2');
      assert.equal(spec.env.OMX_TEAM_STATE_ROOT, '/tmp/workspace/.omx/state');
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
        ['--model', 'gpt-5.3-codex-spark'],
        '/tmp/workspace',
        { OMX_TEAM_STATE_ROOT: '/tmp/workspace/.omx/state' },
        'codex',
        undefined,
        'explore',
      );
      assert.deepEqual(spec.args, ['--model', 'gpt-5.3-codex-spark']);
    } finally {
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
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
│ model:     gpt-5.5 high   /model to change │
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
        assert.equal(waitForWorkerReady('omx-team-x', 1, 1_000), true);
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
          assert.match(tmuxLog, /display-message -p #S:#I #{pane_id}/);
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
          assert.doesNotMatch(tmuxLog, /set-hook -t leader:0 client-resized\[\d+\]/);
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
        },
      );
    } finally {
      process.argv = previousArgv;
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
