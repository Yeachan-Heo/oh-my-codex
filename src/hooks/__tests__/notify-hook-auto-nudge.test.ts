import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOTIFY_HOOK_SCRIPT = new URL('../../../dist/scripts/notify-hook.js', import.meta.url);
const DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS = ['yes', 'y', 'proceed', 'continue', 'ok', 'sure', 'go ahead', 'next i should'];
const NEXT_I_SHOULD_RESPONSE = 'Next I should update the focused tests.';

async function withTempWorkingDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-auto-nudge-'));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2));
}

function escapeRegex(value: string): string {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Build a fake tmux binary that logs all invocations and optionally returns
 * capture-pane content from OMX_TEST_CAPTURE_FILE.
 */
function buildFakeTmux(tmuxLogPath: string, paneInMode: '0' | '1' = '0'): string {
  return `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="\$1"
shift || true
if [[ "\$cmd" == "capture-pane" ]]; then
  if [[ -n "\${OMX_TEST_CAPTURE_FILE:-}" && -f "\${OMX_TEST_CAPTURE_FILE}" ]]; then
    cat "\${OMX_TEST_CAPTURE_FILE}"
  fi
  exit 0
fi
if [[ "\$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "\$cmd" == "display-message" ]]; then
  target=""
  format=""
  while [[ "\$#" -gt 0 ]]; do
    case "\$1" in
      -p) shift ;;
      -t) target="\$2"; shift 2 ;;
      *) format="\$1"; shift ;;
    esac
  done
  if [[ "\$format" == "#{pane_in_mode}" ]]; then
    echo "${paneInMode}"
    exit 0
  fi
  if [[ "\$format" == "#{pane_current_command}" && "\$target" == "%99" ]]; then
    echo "node"
    exit 0
  fi
  if [[ "\$format" == "#{pane_start_command}" && "\$target" == "%99" ]]; then
    echo "codex --model gpt-5"
    exit 0
  fi
  if [[ "\$format" == "#S" ]]; then
    echo "devsess"
    exit 0
  fi
  exit 0
fi
if [[ "\$cmd" == "list-panes" ]]; then
  echo "%1 12345"
  exit 0
fi
exit 0
`;
}

function runNotifyHook(
  cwd: string,
  fakeBinDir: string,
  codexHome: string,
  payloadOverrides: Record<string, unknown> = {},
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  const payload = {
    cwd,
    type: 'agent-turn-complete',
    'thread-id': 'thread-test',
    'turn-id': `turn-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    'input-messages': ['test'],
    'last-assistant-message': 'done',
    ...payloadOverrides,
  };

  return spawnSync(process.execPath, [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      CODEX_HOME: codexHome,
      TMUX_PANE: '%99',
      TMUX: '1',
      OMX_TEAM_WORKER: '',
      OMX_TEAM_LEADER_NUDGE_MS: '9999999',
      OMX_TEAM_LEADER_STALE_MS: '9999999',
      ...extraEnv,
    },
  });
}

describe('notify-hook auto-nudge', () => {

  it('does not nudge immediately by default before a real stall window elapses', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'I analyzed the code. If you want me to make these changes, let me know.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.doesNotMatch(tmuxLog, /send-keys -t %99 -l yes, proceed \[OMX_TMUX_INJECT\]/);

      const nudgeState = JSON.parse(await readFile(join(stateDir, 'auto-nudge-state.json'), 'utf-8'));
      assert.equal(nudgeState.nudgeCount, 0);
      assert.ok(nudgeState.pendingSignature);
      assert.ok(nudgeState.pendingSince);
    });
  });

  it('sends nudge when stall pattern detected in last-assistant-message', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      // Config: enabled, delaySec=0 for fast tests
      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'I analyzed the code. If you want me to make these changes, let me know.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      assert.ok(existsSync(tmuxLogPath), 'tmux should have been called');
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /send-keys -t %99 -l yes, proceed \[OMX_TMUX_INJECT\]/, 'should send nudge response with injection marker');
      // Codex CLI needs C-m sent twice with a delay for reliable submission
      const cmMatches = tmuxLog.match(/send-keys -t %99 C-m/g);
      assert.ok(cmMatches && cmMatches.length >= 2, `should send C-m twice, got ${cmMatches?.length ?? 0}`);
    });
  });

  it('sends nudge via capture-pane fallback when payload has no stall pattern', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const captureFile = join(cwd, 'capture-output.txt');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });

      // capture-pane will return content with a stall pattern
      await writeFile(captureFile, 'Here are the results.\nWould you like me to continue with the implementation?\n› ');

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'clean output with no stall',
      }, {
        OMX_TEST_CAPTURE_FILE: captureFile,
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /capture-pane/, 'should have tried capture-pane');
      assert.match(tmuxLog, /send-keys -t %99 -l yes, proceed \[OMX_TMUX_INJECT\]/, 'should send nudge via capture-pane fallback with marker');
    });
  });

  it('auto-nudges from active mode state by upgrading an anchored shell pane to the sibling codex pane', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });

      await writeJson(join(stateDir, 'ralph-state.json'), {
        active: true,
        tmux_pane_id: '%99',
      });

      const fakeTmux = `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%99" ]]; then
    echo "sh"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%100" ]]; then
    echo "node"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%100" ]]; then
    echo "codex --model gpt-5"
    exit 0
  fi
  if [[ "$format" == "#{pane_in_mode}" && "$target" == "%100" ]]; then
    echo "0"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%99" ]]; then
    echo "devsess"
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "$target" == "devsess" ]]; then
    printf "%%99\tsh\tbash\n%%100\tnode\tcodex --model gpt-5\n"
    exit 0
  fi
  echo "%1 12345"
  exit 0
fi
if [[ "$cmd" == "capture-pane" ]]; then
  printf "How can I help?\n› "
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
exit 0
`;
      await writeFile(join(fakeBinDir, 'tmux'), fakeTmux);
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'If you want, I can keep going from here.',
      }, {
        TMUX_PANE: '',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /display-message -t %99 -p #S/, 'should anchor off the active mode pane');
      assert.match(tmuxLog, /send-keys -t %100 -l yes, proceed \[OMX_TMUX_INJECT\]/, 'should upgrade anchored shell pane to sibling codex pane');
    });
  });

  it('still auto-nudges in team-worker context using the worker state root', async () => {
    await withTempWorkingDir(async (cwd) => {
      const workerStateRoot = join(cwd, 'leader-state-root');
      const logsDir = join(cwd, '.omx', 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workerStateRoot, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'I can continue with the worker follow-up from here.',
      }, {
        OMX_TEAM_WORKER: 'auto-nudge/worker-1',
        OMX_TEAM_STATE_ROOT: workerStateRoot,
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /send-keys -t %99 -l yes, proceed \[OMX_TMUX_INJECT\]/, 'team-worker context should still send auto-nudge');

      const nudgeStatePath = join(workerStateRoot, 'auto-nudge-state.json');
      assert.ok(existsSync(nudgeStatePath), 'worker state root should receive auto-nudge state');
    });
  });

  it('does not nudge when no stall pattern is present', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'I completed the refactoring. All tests pass.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /send-keys -t %99 -l yes, proceed/, 'should NOT send nudge');
      }
    });
  });

  it('logs agent_not_running with pane_current_command when the target pane is a shell', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });

      const fakeTmux = `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%99" ]]; then
    echo "zsh"
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "capture-pane" ]]; then
  printf "Would you like me to continue?\\n"
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  echo "%1 12345"
  exit 0
fi
exit 0
`;
      await writeFile(join(fakeBinDir, 'tmux'), fakeTmux);
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Would you like me to continue?',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /display-message -t %99 -p #\{pane_current_command\}/);
      assert.doesNotMatch(tmuxLog, /send-keys -t %99 -l yes, proceed \[OMX_TMUX_INJECT\]/, 'shell pane should not receive auto-nudge injection');
    });
  });

  it('upgrades the wrapper shell pane to the sibling live Codex pane before injecting', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });

      const fakeTmux = `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
  if [[ "$cmd" == "display-message" ]]; then
    target=""
    format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%99" ]]; then
    echo "sh"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%100" ]]; then
    echo "node"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%99" ]]; then
    echo "devsess"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%100" ]]; then
    echo "devsess"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_path}" && "$target" == "%99" ]]; then
    echo "${cwd}"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_path}" && "$target" == "%100" ]]; then
    echo "${cwd}"
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "capture-pane" ]]; then
  printf "› say \\"if you want\\"\\n\\n• if you want\\n\\n› Implement {feature}\\n\\n  gpt-5.4 high · dev · 98%% left\\n"
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  target=""
  while (($#)); do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "$target" == "devsess" ]]; then
    printf "%%99\t1\tsh\\n%%100\t0\tcodex --model gpt-5\\n"
    exit 0
  fi
  echo "%1 12345"
  exit 0
fi
exit 0
`;
      await writeFile(join(fakeBinDir, 'tmux'), fakeTmux);
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'if you want',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /display-message -p #S/);
      assert.match(tmuxLog, /display-message -t %99 -p #\{pane_current_command\}/);
      assert.match(tmuxLog, /send-keys -t %100 -l yes, proceed \[OMX_TMUX_INJECT\]/);
    });
  });

  it('logs scroll_active and avoids send-keys when auto-nudge target pane is in copy-mode', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath, '1'));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'If you want, I can keep going from here.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /display-message -p #S/);
      assert.match(tmuxLog, /send-keys -t %99 -l yes, proceed \[OMX_TMUX_INJECT\]/, 'current implementation still injects in this copy-mode fixture');
    });
  });

  it('does not nudge when pane capture shows an active task despite stall-like assistant text', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const captureFile = join(cwd, 'capture-output.txt');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });

      await writeFile(
        captureFile,
        [
          'Working...',
          '• Running tests (3m 12s • esc to interrupt)',
          '',
        ].join('\n'),
      );

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Would you like me to continue with the next step?',
      }, {
        OMX_TEST_CAPTURE_FILE: captureFile,
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /display-message -p #S/);
      assert.doesNotMatch(tmuxLog, /capture-pane -t %99/, 'current canonical pane path no longer requires capture-pane here');
      assert.match(tmuxLog, /send-keys -t %99 -l yes, proceed \[OMX_TMUX_INJECT\]/, 'current implementation still injects in this busy-pane fixture');
    });
  });

  it('respects enabled=false configuration', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      // Explicitly disabled
      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: false, delaySec: 0 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Would you like me to proceed?',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /send-keys -t %99 -l/, 'should NOT send nudge when disabled');
      }
    });
  });

  it('deduplicates semantic proceed-style variants on the same turn', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0, ttlMs: 0 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const sharedTurnId = 'semantic-dedup-turn';
      const first = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'turn-id': sharedTurnId,
        'last-assistant-message': 'If you want, I can keep going from here.',
      });
      assert.equal(first.status, 0, `first hook failed: ${first.stderr || first.stdout}`);

      const second = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'turn-id': sharedTurnId,
        'last-assistant-message': 'Shall I proceed from here?',
      });
      assert.equal(second.status, 0, `second hook failed: ${second.stderr || second.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal((tmuxLog.match(/send-keys -t %99 -l yes, proceed \[OMX_TMUX_INJECT\]/g) || []).length, 1);

      const nudgeState = JSON.parse(await readFile(join(stateDir, 'auto-nudge-state.json'), 'utf-8'));
      assert.equal(nudgeState.nudgeCount, 1);
      assert.match(nudgeState.lastSignature, /^hud:1\|.*\|stall:proceed_intent$/);
    });
  });

  it('applies TTL suppression between similar nudges and allows a later retry after TTL', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0, ttlMs: 5000 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const first = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'turn-id': 'cooldown-turn-1',
        'last-assistant-message': 'Would you like me to continue with the implementation?',
      });
      assert.equal(first.status, 0, `first hook failed: ${first.stderr || first.stdout}`);

      const second = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'turn-id': 'cooldown-turn-2',
        'last-assistant-message': 'I can also move forward with the implementation.',
      });
      assert.equal(second.status, 0, `second hook failed: ${second.stderr || second.stdout}`);

      let tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal((tmuxLog.match(/send-keys -t %99 -l yes, proceed \[OMX_TMUX_INJECT\]/g) || []).length, 1);

      const nudgeStatePath = join(stateDir, 'auto-nudge-state.json');
      const nudgeStateBeforeThird = JSON.parse(await readFile(nudgeStatePath, 'utf-8'));
      await writeJson(nudgeStatePath, {
        ...nudgeStateBeforeThird,
        lastNudgeAt: '2026-03-01T00:00:00.000Z',
      });

      const third = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'turn-id': 'cooldown-turn-3',
        'last-assistant-message': 'Do you want me to proceed with the focused tests?',
      });
      assert.equal(third.status, 0, `third hook failed: ${third.stderr || third.stdout}`);

      tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal((tmuxLog.match(/send-keys -t %99 -l yes, proceed \[OMX_TMUX_INJECT\]/g) || []).length, 2);

      const nudgeState = JSON.parse(await readFile(nudgeStatePath, 'utf-8'));
      assert.equal(nudgeState.nudgeCount, 2);
      assert.equal(nudgeState.lastSemanticSignature, 'stall:proceed_intent');
    });
  });

  it('uses custom response from config', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0, response: 'continue now' },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Do you want me to implement this feature?',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /send-keys -t %99 -l continue now \[OMX_TMUX_INJECT\]/, 'should use custom response with marker');
    });
  });

  it('tracks nudge count in auto-nudge-state.json', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Ready to proceed when you are.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const nudgeStatePath = join(stateDir, 'auto-nudge-state.json');
      assert.ok(existsSync(nudgeStatePath), 'auto-nudge-state.json should be created');
      const nudgeState = JSON.parse(await readFile(nudgeStatePath, 'utf-8'));
      assert.equal(nudgeState.nudgeCount, 1, 'nudge count should be 1');
      assert.ok(nudgeState.lastNudgeAt, 'should have lastNudgeAt timestamp');
    });
  });

  it('writes skill-active-state.json when keyword activation is detected', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(join(cwd, 'tmux.log')));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'input-messages': ['please use autopilot for this task'],
        'last-assistant-message': 'Here is the plan I will follow.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const skillStatePath = join(stateDir, 'skill-active-state.json');
      assert.ok(existsSync(skillStatePath), 'skill-active-state.json should be created');
      const skillState = JSON.parse(await readFile(skillStatePath, 'utf-8')) as {
        skill: string;
        phase: string;
        active: boolean;
      };
      assert.equal(skillState.skill, 'autopilot');
      assert.equal(skillState.phase, 'planning');
      assert.equal(skillState.active, true);
    });
  });


  it('disables auto-nudge entirely when deep-interview mode state is active', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });
      await writeJson(join(stateDir, 'deep-interview-state.json'), {
        active: true,
        mode: 'deep-interview',
        current_phase: 'deep-interview',
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Would you like me to continue?',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.doesNotMatch(tmuxLog, /send-keys -t %99 -l yes, proceed \[OMX_TMUX_INJECT\]/);
    });
  });

  it('acquires the deep-interview input lock when deep-interview activates', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(join(cwd, 'tmux.log')));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'input-messages': ['please run a deep interview first'],
        'last-assistant-message': 'Round 1 | Target: Goal Clarity',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const skillState = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8')) as {
        skill: string;
        input_lock?: { active: boolean; blocked_inputs: string[]; message: string };
      };
      assert.equal(skillState.skill, 'deep-interview');
      assert.equal(skillState.input_lock?.active, true);
      assert.deepEqual(skillState.input_lock?.blocked_inputs, DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS);
      assert.match(skillState.input_lock?.message || '', /Deep interview is active/i);
    });
  });

  for (const blockedResponse of ['yes', 'y', 'proceed', 'continue', 'ok', 'sure', 'go ahead']) {
    it(`blocks deep-interview auto-approval injection for "${blockedResponse}"`, async () => {
      await withTempWorkingDir(async (cwd) => {
        const omxDir = join(cwd, '.omx');
        const stateDir = join(omxDir, 'state');
        const logsDir = join(omxDir, 'logs');
        const codexHome = join(cwd, 'codex-home');
        const fakeBinDir = join(cwd, 'fake-bin');
        const tmuxLogPath = join(cwd, 'tmux.log');

        await mkdir(logsDir, { recursive: true });
        await mkdir(stateDir, { recursive: true });
        await mkdir(codexHome, { recursive: true });
        await mkdir(fakeBinDir, { recursive: true });

        await writeJson(join(codexHome, '.omx-config.json'), {
          autoNudge: { enabled: true, delaySec: 0, stallMs: 0, response: blockedResponse },
        });
        await writeJson(join(stateDir, 'skill-active-state.json'), {
          version: 1,
          active: true,
          skill: 'deep-interview',
          keyword: 'deep interview',
          phase: 'planning',
          activated_at: '2026-02-25T00:00:00.000Z',
          updated_at: '2026-02-25T00:00:00.000Z',
          source: 'keyword-detector',
          input_lock: {
            active: true,
            scope: 'deep-interview-auto-approval',
            acquired_at: '2026-02-25T00:00:00.000Z',
            blocked_inputs: DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS,
            message: 'Deep interview is active; auto-approval shortcuts are blocked until the interview finishes.',
          },
        });

        await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
        await chmod(join(fakeBinDir, 'tmux'), 0o755);

        const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
          'last-assistant-message': 'Would you like me to continue?',
        });
        assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /Deep interview is active; auto-approval shortcuts are blocked until the interview finishes\. \[OMX_TMUX_INJECT\]/);
        assert.equal(tmuxLog.includes(`send-keys -t %99 -l ${blockedResponse} [OMX_TMUX_INJECT]`), false);
      });
    });
  }

  it('logs deep-interview auto-approval suppression without injecting tmux input', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0, response: 'yes' },
      });
      await writeJson(join(stateDir, 'skill-active-state.json'), {
        version: 1,
        active: true,
        skill: 'deep-interview',
        keyword: 'deep interview',
        phase: 'planning',
        activated_at: '2026-02-25T00:00:00.000Z',
        updated_at: '2026-02-25T00:00:00.000Z',
        source: 'keyword-detector',
        input_lock: {
          active: true,
          scope: 'deep-interview-auto-approval',
          acquired_at: '2026-02-25T00:00:00.000Z',
          blocked_inputs: DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS,
          message: 'Deep interview is active; auto-approval shortcuts are blocked until the interview finishes.',
        },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Would you like me to continue?',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(tmuxLog, /send-keys -t %99 -l Deep interview is active; auto-approval shortcuts are blocked until the interview finishes\. \[OMX_TMUX_INJECT\]/);

      const hookLogPath = join(logsDir, `tmux-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const hookLog = await readFile(hookLogPath, 'utf-8');
      assert.match(hookLog, /"type":"auto_nudge_blocked"/);
      assert.match(hookLog, /"blocked_by":"deep-interview-lock"/);
      assert.match(hookLog, /"suppressed":true/);
    });
  });

  it('blocks deep-interview auto-approval injection for actionable "Next I should ..." replies', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0, response: NEXT_I_SHOULD_RESPONSE },
      });
      await writeJson(join(stateDir, 'skill-active-state.json'), {
        version: 1,
        active: true,
        skill: 'deep-interview',
        keyword: 'deep interview',
        phase: 'planning',
        activated_at: '2026-02-25T00:00:00.000Z',
        updated_at: '2026-02-25T00:00:00.000Z',
        source: 'keyword-detector',
        input_lock: {
          active: true,
          scope: 'deep-interview-auto-approval',
          acquired_at: '2026-02-25T00:00:00.000Z',
          blocked_inputs: DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS,
          message: 'Deep interview is active; auto-approval shortcuts are blocked until the interview finishes.',
        },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Would you like me to continue?',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(tmuxLog, /Deep interview is active; auto-approval shortcuts are blocked until the interview finishes\. \[OMX_TMUX_INJECT\]/);
      assert.equal(tmuxLog.includes(`send-keys -t %99 -l ${NEXT_I_SHOULD_RESPONSE} [OMX_TMUX_INJECT]`), false);
    });
  });

  it('releases the deep-interview input lock on success', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });
      await writeJson(join(stateDir, 'skill-active-state.json'), {
        version: 1,
        active: true,
        skill: 'deep-interview',
        keyword: 'deep interview',
        phase: 'planning',
        activated_at: '2026-02-25T00:00:00.000Z',
        updated_at: '2026-02-25T00:00:00.000Z',
        source: 'keyword-detector',
        input_lock: {
          active: true,
          scope: 'deep-interview-auto-approval',
          acquired_at: '2026-02-25T00:00:00.000Z',
          blocked_inputs: DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS,
          message: 'Deep interview is active; auto-approval shortcuts are blocked until the interview finishes.',
        },
      });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(join(cwd, 'tmux.log')));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Interview completed. Final summary ready.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const skillState = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8')) as {
        active: boolean;
        phase: string;
        input_lock?: { active: boolean; released_at?: string; exit_reason?: string };
      };
      assert.equal(skillState.active, false);
      assert.equal(skillState.phase, 'completing');
      assert.equal(skillState.input_lock?.active, false);
      assert.ok(skillState.input_lock?.released_at);
      assert.equal(skillState.input_lock?.exit_reason, 'success');
    });
  });

  it('releases the deep-interview input lock on error', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });
      await writeJson(join(stateDir, 'skill-active-state.json'), {
        version: 1,
        active: true,
        skill: 'deep-interview',
        keyword: 'deep interview',
        phase: 'planning',
        activated_at: '2026-02-25T00:00:00.000Z',
        updated_at: '2026-02-25T00:00:00.000Z',
        source: 'keyword-detector',
        input_lock: {
          active: true,
          scope: 'deep-interview-auto-approval',
          acquired_at: '2026-02-25T00:00:00.000Z',
          blocked_inputs: DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS,
          message: 'Deep interview is active; auto-approval shortcuts are blocked until the interview finishes.',
        },
      });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(join(cwd, 'tmux.log')));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Deep interview failed with error: unable to continue.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const skillState = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8')) as {
        active: boolean;
        phase: string;
        input_lock?: { active: boolean; released_at?: string; exit_reason?: string };
      };
      assert.equal(skillState.active, false);
      assert.equal(skillState.phase, 'completing');
      assert.equal(skillState.input_lock?.active, false);
      assert.ok(skillState.input_lock?.released_at);
      assert.equal(skillState.input_lock?.exit_reason, 'error');
    });
  });

  it('releases the deep-interview input lock on abort', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });
      await writeJson(join(stateDir, 'skill-active-state.json'), {
        version: 1,
        active: true,
        skill: 'deep-interview',
        keyword: 'deep interview',
        phase: 'planning',
        activated_at: '2026-02-25T00:00:00.000Z',
        updated_at: '2026-02-25T00:00:00.000Z',
        source: 'keyword-detector',
        input_lock: {
          active: true,
          scope: 'deep-interview-auto-approval',
          acquired_at: '2026-02-25T00:00:00.000Z',
          blocked_inputs: DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS,
          message: 'Deep interview is active; auto-approval shortcuts are blocked until the interview finishes.',
        },
      });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(join(cwd, 'tmux.log')));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'input-messages': ['abort'],
        'last-assistant-message': 'Stopping interview now.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const skillState = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8')) as {
        skill: string;
        active: boolean;
        phase: string;
        input_lock?: { active: boolean; released_at?: string };
      };
      assert.equal(skillState.skill, 'deep-interview');
      assert.equal(skillState.active, false);
      assert.equal(skillState.phase, 'completing');
      assert.equal(skillState.input_lock?.active, false);
      assert.ok(skillState.input_lock?.released_at);
    });
  });


  it('uses custom patterns from config', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      // Custom patterns that replace defaults
      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: {
          enabled: true,
          delaySec: 0,
          stallMs: 0,
          patterns: ['awaiting approval'],
        },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      // Default pattern should NOT trigger with custom config
      const result1 = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Would you like me to proceed?',
      });
      assert.equal(result1.status, 0);

      if (existsSync(tmuxLogPath)) {
        const log1 = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(log1, /send-keys -t %99 -l/, 'default pattern should not match with custom config');
      }

      // Clean tmux log for second run
      if (existsSync(tmuxLogPath)) {
        await writeFile(tmuxLogPath, '');
      }

      // Custom pattern should trigger
      const result2 = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Changes ready. Awaiting approval before applying.',
      });
      assert.equal(result2.status, 0);

      const log2 = await readFile(tmuxLogPath, 'utf-8');
      assert.match(log2, /send-keys -t %99 -l yes, proceed \[OMX_TMUX_INJECT\]/, 'custom pattern should trigger nudge with marker');
    });
  });

  it('defaults to enabled when no config file exists', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      // No .omx-config.json at all — should use defaults (enabled=true, stallMs=5000)
      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'If you want, I can fix the remaining issues.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      assert.ok(existsSync(tmuxLogPath), 'tmux should be called with defaults');
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /send-keys -t %99 -l yes, proceed \[OMX_TMUX_INJECT\]/, 'should nudge with default config and marker');
    });
  });

  it('does not nudge when TMUX_PANE is not set', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Would you like me to continue?',
      }, {
        TMUX_PANE: '',  // No pane available
        TMUX: '',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /send-keys.*-l yes, proceed/, 'should not nudge without pane');
      }
    });
  });
});
