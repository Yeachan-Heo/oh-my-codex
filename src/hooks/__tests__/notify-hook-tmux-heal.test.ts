import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOTIFY_HOOK_SCRIPT = new URL('../../../scripts/notify-hook.js', import.meta.url);

async function withTempWorkingDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-notify-tmux-heal-'));
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

describe('notify-hook tmux target healing', () => {
  it('falls back to current tmux pane and heals stale session target', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const sessionId = 'omx-abc123';
      const sessionStateDir = join(stateDir, 'sessions', sessionId);
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const configPath = join(omxDir, 'tmux-hook.json');
      const hookStatePath = join(stateDir, 'tmux-hook-state.json');

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'session.json'), { session_id: sessionId });
      await writeJson(join(sessionStateDir, 'ralph-state.json'), { active: true, iteration: 0 });
      await writeJson(configPath, {
        enabled: true,
        target: { type: 'session', value: sessionId },
        allowed_modes: ['ralph'],
        cooldown_ms: 0,
        max_injections_per_session: 10,
        prompt_template: 'Continue [OMX_TMUX_INJECT]',
        marker: '[OMX_TMUX_INJECT]',
        dry_run: false,
        log_level: 'debug',
      });

      const fakeTmux = `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "list-panes" ]]; then
  target=""
  while (($#)); do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "$target" == "devsess" ]]; then
    echo "%42 1"
    exit 0
  fi
  echo "can't find session: $target" >&2
  exit 1
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
  if [[ "$format" == "#{pane_id}" && "$target" == "%42" ]]; then
    echo "%42"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_path}" && "$target" == "%42" ]]; then
    echo "${cwd}"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%42" ]]; then
    echo "devsess"
    exit 0
  fi
  echo "bad display target: $target / $format" >&2
  exit 1
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
echo "unsupported cmd: $cmd" >&2
exit 1
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const payload = {
        cwd,
        type: 'agent-turn-complete',
        'thread-id': 'thread-test',
        'turn-id': 'turn-test',
        'input-messages': ['no marker here'],
        'last-assistant-message': 'output',
      };

      const result = spawnSync(process.execPath, [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
          OMX_TEAM_WORKER: '',
          TMUX_PANE: '%42',
        },
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, 'injection_sent');
      assert.equal(hookState.total_injections, 1);

      const healedConfig = await readJson<{ target: { type: string; value: string } }>(configPath);
      assert.equal(healedConfig.target.type, 'pane');
      assert.equal(healedConfig.target.value, '%42');
    });
  });

  it('skips injection when fallback pane cwd does not match hook cwd', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const sessionId = 'omx-abc123';
      const sessionStateDir = join(stateDir, 'sessions', sessionId);
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const configPath = join(omxDir, 'tmux-hook.json');
      const hookStatePath = join(stateDir, 'tmux-hook-state.json');

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'session.json'), { session_id: sessionId });
      await writeJson(join(sessionStateDir, 'ralph-state.json'), { active: true, iteration: 0 });
      await writeJson(configPath, {
        enabled: true,
        target: { type: 'session', value: sessionId },
        allowed_modes: ['ralph'],
        cooldown_ms: 0,
        max_injections_per_session: 10,
        prompt_template: 'Continue [OMX_TMUX_INJECT]',
        marker: '[OMX_TMUX_INJECT]',
        dry_run: false,
        log_level: 'debug',
      });

      const fakeTmux = `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "list-panes" ]]; then
  target=""
  while (($#)); do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "$target" == "devsess" ]]; then
    echo "%42 1"
    exit 0
  fi
  echo "can't find session: $target" >&2
  exit 1
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
  if [[ "$format" == "#{pane_id}" && "$target" == "%42" ]]; then
    echo "%42"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_path}" && "$target" == "%42" ]]; then
    echo "/tmp/not-the-hook-cwd"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%42" ]]; then
    echo "devsess"
    exit 0
  fi
  echo "bad display target: $target / $format" >&2
  exit 1
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
echo "unsupported cmd: $cmd" >&2
exit 1
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const payload = {
        cwd,
        type: 'agent-turn-complete',
        'thread-id': 'thread-test-2',
        'turn-id': 'turn-test-2',
        'input-messages': ['no marker here'],
        'last-assistant-message': 'output',
      };

      const result = spawnSync(process.execPath, [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
          OMX_TEAM_WORKER: '',
          TMUX_PANE: '%42',
        },
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, 'pane_cwd_mismatch');
      assert.equal(hookState.total_injections, 0);
    });
  });

  it('falls back by matching pane cwd when TMUX_PANE is unavailable', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const sessionId = 'omx-abc123';
      const sessionStateDir = join(stateDir, 'sessions', sessionId);
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const configPath = join(omxDir, 'tmux-hook.json');
      const hookStatePath = join(stateDir, 'tmux-hook-state.json');

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'session.json'), { session_id: sessionId });
      await writeJson(join(sessionStateDir, 'ralph-state.json'), { active: true, iteration: 0 });
      await writeJson(configPath, {
        enabled: true,
        target: { type: 'session', value: sessionId },
        allowed_modes: ['ralph'],
        cooldown_ms: 0,
        max_injections_per_session: 10,
        prompt_template: 'Continue [OMX_TMUX_INJECT]',
        marker: '[OMX_TMUX_INJECT]',
        dry_run: false,
        log_level: 'debug',
      });

      const fakeTmux = `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "list-panes" ]]; then
  all=false
  target=""
  while (($#)); do
    case "$1" in
      -a) all=true; shift ;;
      -t) target="$2"; shift 2 ;;
      -F) shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "$all" == "true" ]]; then
    echo "%42\t${cwd}\t1\tdevsess"
    exit 0
  fi
  if [[ "$target" == "devsess" ]]; then
    echo "%42 1"
    exit 0
  fi
  echo "can't find session: $target" >&2
  exit 1
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
  if [[ "$format" == "#{pane_id}" && "$target" == "%42" ]]; then
    echo "%42"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%42" ]]; then
    echo "devsess"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_path}" && "$target" == "%42" ]]; then
    echo "${cwd}"
    exit 0
  fi
  echo "bad display target: $target / $format" >&2
  exit 1
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
echo "unsupported cmd: $cmd" >&2
exit 1
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const payload = {
        cwd,
        type: 'agent-turn-complete',
        'thread-id': 'thread-test-3',
        'turn-id': 'turn-test-3',
        'input-messages': ['no marker here'],
        'last-assistant-message': 'output',
      };

      const result = spawnSync(process.execPath, [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
          OMX_TEAM_WORKER: '',
        },
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, 'injection_sent');
      assert.equal(hookState.total_injections, 1);

      const healedConfig = await readJson<{ target: { type: string; value: string } }>(configPath);
      assert.equal(healedConfig.target.type, 'pane');
      assert.equal(healedConfig.target.value, '%42');
    });
  });

  it('prefers active mode state tmux_pane_id when present', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const sessionId = 'omx-abc123';
      const sessionStateDir = join(stateDir, 'sessions', sessionId);
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const configPath = join(omxDir, 'tmux-hook.json');
      const hookStatePath = join(stateDir, 'tmux-hook-state.json');

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, 'session.json'), { session_id: sessionId });
      await writeJson(join(sessionStateDir, 'ralph-state.json'), {
        active: true,
        iteration: 0,
        tmux_pane_id: '%99',
      });
      await writeJson(configPath, {
        enabled: true,
        target: { type: 'session', value: 'nonexistent-session' },
        allowed_modes: ['ralph'],
        cooldown_ms: 0,
        max_injections_per_session: 10,
        prompt_template: 'Continue [OMX_TMUX_INJECT]',
        marker: '[OMX_TMUX_INJECT]',
        dry_run: false,
        log_level: 'debug',
      });

      const fakeTmux = `#!/usr/bin/env bash
set -eu
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
  if [[ "$format" == "#{pane_id}" && "$target" == "%99" ]]; then
    echo "%99"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_path}" && "$target" == "%99" ]]; then
    echo "${cwd}"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%99" ]]; then
    echo "devsess"
    exit 0
  fi
  echo "bad display target: $target / $format" >&2
  exit 1
fi
if [[ "$cmd" == "list-panes" ]]; then
  echo "can't find session" >&2
  exit 1
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
echo "unsupported cmd: $cmd" >&2
exit 1
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const payload = {
        cwd,
        type: 'agent-turn-complete',
        'thread-id': 'thread-test-4',
        'turn-id': 'turn-test-4',
        'input-messages': ['no marker here'],
        'last-assistant-message': 'output',
      };

      const result = spawnSync(process.execPath, [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
          OMX_TEAM_WORKER: '',
        },
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, 'injection_sent');
      assert.equal(hookState.total_injections, 1);

      const healedConfig = await readJson<{ target: { type: string; value: string } }>(configPath);
      assert.equal(healedConfig.target.type, 'pane');
      assert.equal(healedConfig.target.value, '%99');
    });
  });
});
