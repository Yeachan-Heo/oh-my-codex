/**
 * Tests for issue #215: tmux scrollback preservation during OMX output injection.
 *
 * When a pane is in copy-mode (scrollback), tmux's `pane_in_mode` format
 * variable returns "1".  Injecting send-keys into such a pane would kick the
 * user out of scrollback.  The fix checks pane_in_mode before sending and
 * skips with reason `scroll_active` when the pane is scrolling.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTmuxSessionName } from '../../cli/index.js';

const NOTIFY_HOOK_SCRIPT = new URL('../../../dist/scripts/notify-hook.js', import.meta.url);

async function withTempWorkingDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-notify-scroll-'));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

function readLinuxStartTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd === -1) return null;
    const remainder = stat.slice(commandEnd + 1).trim();
    const fields = remainder.split(/\s+/);
    if (fields.length <= 19) return null;
    const startTicks = Number(fields[19]);
    return Number.isFinite(startTicks) ? startTicks : null;
  } catch {
    return null;
  }
}

function readLinuxCmdline(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`);
    const text = raw.toString('utf-8').replace(/\0+/g, ' ').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** Build a fake tmux binary that responds to all required commands.
 *  paneInMode: '0' or '1' — the value returned for #{pane_in_mode}.
 */
function fakeTmuxScript(cwd: string, paneInMode: '0' | '1'): string {
  return `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "list-panes" ]]; then
  if [[ " $* " == *" -a "* ]]; then printf '%s\t%s\t%s\n' '%42' '0' '4242'; exit 0; fi
  echo "%42 1"
  exit 0
fi
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
  if [[ "$format" == "#{pane_id}" ]]; then
    echo "%42"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_path}" ]]; then
    echo "${cwd}"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" ]]; then
    echo "codex"
    exit 0

  fi
  if [[ "$format" == "#{pane_start_command}" ]]; then
    echo "codex --model gpt-5"
    exit 0
  fi
  if [[ "$format" == "#S" ]]; then
    echo "\${OMX_TEST_TMUX_SESSION_NAME:-devsess}"
    exit 0
  fi
  if [[ "$format" == "#{pane_in_mode}" ]]; then
    echo "${paneInMode}"
    exit 0
  fi
  echo "unsupported format: $format" >&2
  exit 1
fi
if [[ "$cmd" == "capture-pane" ]]; then
  printf "› ready\n"
  exit 0
fi
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${cwd}/tmux-buffer"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${cwd}/tmux-buffer" ]]; then cat "${cwd}/tmux-buffer"; fi
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${cwd}/tmux-buffer"
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
echo "unsupported cmd: $cmd" >&2
exit 1
`;
}

async function setupFixture(cwd: string, paneInMode: '0' | '1', skipIfScrolling = true) {
  const omxDir = join(cwd, '.omx');
  const stateDir = join(omxDir, 'state');
  const logsDir = join(omxDir, 'logs');
  const sessionId = 'omx-scroll-test';
  const sessionStateDir = join(stateDir, 'sessions', sessionId);
  const fakeBinDir = join(cwd, 'fake-bin');
  const fakeTmuxPath = join(fakeBinDir, 'tmux');

  await mkdir(sessionStateDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await mkdir(fakeBinDir, { recursive: true });

  await writeJson(join(stateDir, 'session.json'), {
    session_id: sessionId,
    started_at: new Date().toISOString(),
    cwd,
    pid: process.pid,
    platform: process.platform,
    pid_start_ticks: readLinuxStartTicks(process.pid),
    pid_cmdline: readLinuxCmdline(process.pid),
  });
  await writeJson(join(sessionStateDir, 'ralph-state.json'), { active: true, iteration: 0 });
  await writeJson(join(omxDir, 'tmux-hook.json'), {
    enabled: true,
    target: { type: 'pane', value: '%42' },
    allowed_modes: ['ralph'],
    cooldown_ms: 0,
    max_injections_per_session: 10,
    prompt_template: 'Continue [OMX_TMUX_INJECT]',
    marker: '[OMX_TMUX_INJECT]',
    dry_run: false,
    log_level: 'debug',
    skip_if_scrolling: skipIfScrolling,
  });

  await writeFile(fakeTmuxPath, fakeTmuxScript(cwd, paneInMode));
  await chmod(fakeTmuxPath, 0o755);

  return { stateDir, fakeBinDir, hookStatePath: join(stateDir, 'tmux-hook-state.json') };
}

function runNotifyHook(cwd: string, fakeBinDir: string, threadId: string) {
  const payload = {
    cwd,
    type: 'agent-turn-complete',
    'thread-id': threadId,
    'turn-id': `turn-${threadId}`,
    'input-messages': ['no marker here'],
    'last-assistant-message': 'output',
  };
  return spawnSync(process.execPath, [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      OMX_TEAM_WORKER: '',
      OMX_SESSION_ID: 'omx-scroll-test',
      OMX_TEST_TMUX_SESSION_NAME: buildTmuxSessionName(cwd, 'omx-scroll-test'),
      TMUX_PANE: '%42',
    },
  });
}

describe('notify-hook tmux scrollback preservation (issue #215)', () => {
  it('skips injection and records scroll_active when pane is in copy-mode', async () => {
    await withTempWorkingDir(async (cwd) => {
      const { fakeBinDir, hookStatePath } = await setupFixture(cwd, '1', true);

      const result = runNotifyHook(cwd, fakeBinDir, 'thread-scroll-1');
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const state = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(state.last_reason, 'scroll_active', 'should preserve scrollback by skipping injection in copy-mode');
      assert.equal(state.total_injections ?? 0, 0, 'scroll-active skip should not increment injection count');
    });
  });

  it('proceeds with injection when pane is NOT in copy-mode', async () => {
    await withTempWorkingDir(async (cwd) => {
      const { fakeBinDir, hookStatePath } = await setupFixture(cwd, '0', true);

      const result = runNotifyHook(cwd, fakeBinDir, 'thread-scroll-2');
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const state = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(state.last_reason, 'injection_sent', 'should proceed with injection');
      assert.equal(state.total_injections, 1, 'injection count should be 1');
    });
  });

  it('injects even when pane is scrolling if skip_if_scrolling is false', async () => {
    await withTempWorkingDir(async (cwd) => {
      const { fakeBinDir, hookStatePath } = await setupFixture(cwd, '1', false);

      const result = runNotifyHook(cwd, fakeBinDir, 'thread-scroll-3');
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const state = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(state.last_reason, 'injection_sent', 'should inject regardless of scroll state');
      assert.equal(state.total_injections, 1, 'injection count should be 1');
    });
  });

  it('does not record dedupeKey on scroll_active so next turn can retry', async () => {
    await withTempWorkingDir(async (cwd) => {
      const { fakeBinDir, stateDir } = await setupFixture(cwd, '1', true);
      const hookStatePath = join(stateDir, 'tmux-hook-state.json');

      runNotifyHook(cwd, fakeBinDir, 'thread-scroll-4');
      const stateAfterSkip = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(stateAfterSkip.last_reason, 'scroll_active');
    });
  });
});
