import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTmuxSessionName } from '../../cli/index.js';
import { handleTmuxInjection } from '../../scripts/notify-hook/tmux-injection.js';

const NOTIFY_HOOK_SCRIPT = new URL('../../../dist/scripts/notify-hook.js', import.meta.url);

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

async function writeManagedSessionState(stateDir: string, cwd: string, sessionId: string): Promise<void> {
  await writeJson(join(stateDir, 'session.json'), {
    session_id: sessionId,
    started_at: new Date().toISOString(),
    cwd,
    pid: process.pid,
    platform: process.platform,
    pid_start_ticks: readLinuxStartTicks(process.pid),
    pid_cmdline: readLinuxCmdline(process.pid),
  });
}

describe('notify-hook tmux target healing', () => {
  it('falls back to global mode state when scoped session has no allowed active mode', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const sessionId = 'omx-abc123';
      const sessionStateDir = join(stateDir, 'sessions', sessionId);
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);
      const configPath = join(omxDir, 'tmux-hook.json');
      const hookStatePath = join(stateDir, 'tmux-hook-state.json');

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeManagedSessionState(stateDir, cwd, sessionId);
      await writeJson(join(sessionStateDir, 'team-state.json'), { active: true, current_phase: 'team-exec' });
      await writeJson(join(stateDir, 'ralph-state.json'), { active: true, iteration: 0 });
      await writeJson(configPath, {
        enabled: true,
        target: { type: 'pane', value: '%42' },
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
  if [[ "$format" == "#{pane_id}" && "$target" == "%42" ]]; then
    echo "%42"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%42" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%42" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  if [[ "$format" == "#{pane_in_mode}" && "$target" == "%42" ]]; then
    echo "0"
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
        session_id: sessionId,
        'thread-id': 'thread-test-global-fallback',
        'turn-id': 'turn-test-global-fallback',
        'input-messages': ['no marker here'],
        'last-assistant-message': 'output',
      };

      const previousPath = process.env.PATH;
      const previousTeamWorker = process.env.OMX_TEAM_WORKER;
      try {
        process.env.PATH = `${fakeBinDir}:${process.env.PATH || ''}`;
        process.env.OMX_TEAM_WORKER = '';
        delete process.env.TMUX_PANE;
        await handleTmuxInjection({ payload, cwd, stateDir, logsDir });
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        if (typeof previousTeamWorker === 'string') process.env.OMX_TEAM_WORKER = previousTeamWorker;
        else delete process.env.OMX_TEAM_WORKER;
      }

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, 'injection_sent');
      assert.equal(hookState.total_injections, 1);
    });
  });

  it('falls back to current tmux pane and heals stale session target', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const sessionId = 'omx-abc123';
      const sessionStateDir = join(stateDir, 'sessions', sessionId);
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);
      const configPath = join(omxDir, 'tmux-hook.json');
      const hookStatePath = join(stateDir, 'tmux-hook-state.json');

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeManagedSessionState(stateDir, cwd, sessionId);
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
  if [[ "$target" == "${managedSessionName}" ]]; then
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
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%42" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%42" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_path}" && "$target" == "%42" ]]; then
    echo "${cwd}"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%42" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%42" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%42" ]]; then
    echo "${managedSessionName}"
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
        session_id: sessionId,
        'thread-id': 'thread-test',
        'turn-id': 'turn-test',
        'input-messages': ['no marker here'],
        'last-assistant-message': 'output',
      };

      const previousPath = process.env.PATH;
      const previousTeamWorker = process.env.OMX_TEAM_WORKER;
      const previousTmuxPane = process.env.TMUX_PANE;
      try {
        process.env.PATH = `${fakeBinDir}:${process.env.PATH || ''}`;
        process.env.OMX_TEAM_WORKER = '';
        process.env.TMUX_PANE = '%42';
        await handleTmuxInjection({ payload, cwd, stateDir, logsDir });
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        if (typeof previousTeamWorker === 'string') process.env.OMX_TEAM_WORKER = previousTeamWorker;
        else delete process.env.OMX_TEAM_WORKER;
        if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
        else delete process.env.TMUX_PANE;
      }

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
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);
      const configPath = join(omxDir, 'tmux-hook.json');
      const hookStatePath = join(stateDir, 'tmux-hook-state.json');

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeManagedSessionState(stateDir, cwd, sessionId);
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
  if [[ "$target" == "${managedSessionName}" ]]; then
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
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%42" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%42" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_path}" && "$target" == "%42" ]]; then
    echo "/tmp/not-the-hook-cwd"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%42" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%42" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%42" ]]; then
    echo "${managedSessionName}"
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
        session_id: sessionId,
        'thread-id': 'thread-test-2',
        'turn-id': 'turn-test-2',
        'input-messages': ['no marker here'],
        'last-assistant-message': 'output',
      };

      const previousPath = process.env.PATH;
      const previousTeamWorker = process.env.OMX_TEAM_WORKER;
      const previousTmuxPane = process.env.TMUX_PANE;
      try {
        process.env.PATH = `${fakeBinDir}:${process.env.PATH || ''}`;
        process.env.OMX_TEAM_WORKER = '';
        process.env.TMUX_PANE = '%42';
        await handleTmuxInjection({ payload, cwd, stateDir, logsDir });
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        if (typeof previousTeamWorker === 'string') process.env.OMX_TEAM_WORKER = previousTeamWorker;
        else delete process.env.OMX_TEAM_WORKER;
        if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
        else delete process.env.TMUX_PANE;
      }

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, 'pane_cwd_mismatch');
      assert.equal(hookState.total_injections, 0);
    });
  });

  it('resolves the explicit managed session target without shared-cwd guessing', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const sessionId = 'omx-abc123';
      const sessionStateDir = join(stateDir, 'sessions', sessionId);
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);
      const configPath = join(omxDir, 'tmux-hook.json');
      const hookStatePath = join(stateDir, 'tmux-hook-state.json');

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeManagedSessionState(stateDir, cwd, sessionId);
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
  if [[ "$target" == "${managedSessionName}" ]]; then
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
    echo "${managedSessionName}"
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
        session_id: sessionId,
        'thread-id': 'thread-test-3',
        'turn-id': 'turn-test-3',
        'input-messages': ['no marker here'],
        'last-assistant-message': 'output',
      };

      const previousPath = process.env.PATH;
      const previousTeamWorker = process.env.OMX_TEAM_WORKER;
      try {
        process.env.PATH = `${fakeBinDir}:${process.env.PATH || ''}`;
        process.env.OMX_TEAM_WORKER = '';
        delete process.env.TMUX_PANE;
        await handleTmuxInjection({ payload, cwd, stateDir, logsDir });
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        if (typeof previousTeamWorker === 'string') process.env.OMX_TEAM_WORKER = previousTeamWorker;
        else delete process.env.OMX_TEAM_WORKER;
      }

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, 'injection_sent');
      assert.equal(hookState.total_injections, 1);
    });
  });

  it('heals a stale HUD pane target back to the canonical codex pane', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const sessionId = 'omx-hud-stale';
      const sessionStateDir = join(stateDir, 'sessions', sessionId);
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);
      const configPath = join(omxDir, 'tmux-hook.json');
      const hookStatePath = join(stateDir, 'tmux-hook-state.json');

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeManagedSessionState(stateDir, cwd, sessionId);
      await writeJson(join(sessionStateDir, 'ralph-state.json'), { active: true, iteration: 0 });
      await writeJson(configPath, {
        enabled: true,
        target: { type: 'pane', value: '%77' },
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
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%99" ]]; then
    echo "node"
    exit 0
  fi
  if [[ "$format" == "#{pane_id}" && "$target" == "%77" ]]; then
    echo "%77"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%77" ]]; then
    echo "node dist/cli/omx.js hud --watch"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%77" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_path}" && "$target" == "%99" ]]; then
    echo "${cwd}"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%99" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%99" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  if [[ "$format" == "#{pane_in_mode}" && "$target" == "%99" ]]; then
    echo "0"
    exit 0
  fi
  exit 1
fi
if [[ "$cmd" == "list-panes" ]]; then
  target=""
  while (($#)); do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "$target" == "${managedSessionName}" ]]; then
    printf "%%77\t1\tnode\tnode dist/cli/omx.js hud --watch\n%%99\t0\tcodex\tcodex\n"
    exit 0
  fi
  exit 1
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
exit 1
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const payload = {
        cwd,
        type: 'agent-turn-complete',
        session_id: sessionId,
        'thread-id': 'thread-test-hud-heal',
        'turn-id': 'turn-test-hud-heal',
        'input-messages': ['no marker here'],
        'last-assistant-message': 'output',
      };

      const previousPath = process.env.PATH;
      const previousTeamWorker = process.env.OMX_TEAM_WORKER;
      const previousTmuxPane = process.env.TMUX_PANE;
      try {
        process.env.PATH = `${fakeBinDir}:${process.env.PATH || ''}`;
        process.env.OMX_TEAM_WORKER = '';
        process.env.TMUX_PANE = '%99';
        await handleTmuxInjection({ payload, cwd, stateDir, logsDir });
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        if (typeof previousTeamWorker === 'string') process.env.OMX_TEAM_WORKER = previousTeamWorker;
        else delete process.env.OMX_TEAM_WORKER;
        if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
        else delete process.env.TMUX_PANE;
      }

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, 'injection_sent');
      assert.equal(hookState.last_target, '%99');

      const healedConfig = await readJson<{ target: { type: string; value: string } }>(configPath);
      assert.equal(healedConfig.target.type, 'pane');
      assert.equal(healedConfig.target.value, '%99');
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
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);
      const configPath = join(omxDir, 'tmux-hook.json');
      const hookStatePath = join(stateDir, 'tmux-hook-state.json');

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeManagedSessionState(stateDir, cwd, sessionId);
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
    echo "${managedSessionName}"
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
        session_id: sessionId,
        'thread-id': 'thread-test-4',
        'turn-id': 'turn-test-4',
        'input-messages': ['no marker here'],
        'last-assistant-message': 'output',
      };

      const previousPath = process.env.PATH;
      const previousTeamWorker = process.env.OMX_TEAM_WORKER;
      try {
        process.env.PATH = `${fakeBinDir}:${process.env.PATH || ''}`;
        process.env.OMX_TEAM_WORKER = '';
        delete process.env.TMUX_PANE;
        await handleTmuxInjection({ payload, cwd, stateDir, logsDir });
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        if (typeof previousTeamWorker === 'string') process.env.OMX_TEAM_WORKER = previousTeamWorker;
        else delete process.env.OMX_TEAM_WORKER;
      }

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, 'injection_sent');
      assert.equal(hookState.total_injections, 1);

      const healedConfig = await readJson<{ target: { type: string; value: string } }>(configPath);
      assert.equal(healedConfig.target.type, 'pane');
      assert.equal(healedConfig.target.value, '%99');
    });
  });

  it('prefers scoped active mode state over global mode state for tmux pane selection', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const sessionId = 'omx-abc123';
      const sessionStateDir = join(stateDir, 'sessions', sessionId);
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);
      const configPath = join(omxDir, 'tmux-hook.json');
      const hookStatePath = join(stateDir, 'tmux-hook-state.json');

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeManagedSessionState(stateDir, cwd, sessionId);
      await writeJson(join(sessionStateDir, 'ralph-state.json'), {
        active: true,
        iteration: 0,
        tmux_pane_id: '%99',
      });
      await writeJson(join(stateDir, 'ralph-state.json'), {
        active: true,
        iteration: 100,
        tmux_pane_id: '%55',
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
    echo "${managedSessionName}"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%99" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#{pane_in_mode}" && "$target" == "%99" ]]; then
    echo "0"
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
        session_id: sessionId,
        'thread-id': 'thread-test-scoped-pane-precedence',
        'turn-id': 'turn-test-scoped-pane-precedence',
        'input-messages': ['no marker here'],
        'last-assistant-message': 'output',
      };

      const previousPath = process.env.PATH;
      const previousTeamWorker = process.env.OMX_TEAM_WORKER;
      try {
        process.env.PATH = `${fakeBinDir}:${process.env.PATH || ''}`;
        process.env.OMX_TEAM_WORKER = '';
        delete process.env.TMUX_PANE;
        await handleTmuxInjection({ payload, cwd, stateDir, logsDir });
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        if (typeof previousTeamWorker === 'string') process.env.OMX_TEAM_WORKER = previousTeamWorker;
        else delete process.env.OMX_TEAM_WORKER;
      }

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, 'injection_sent');
      assert.equal(hookState.total_injections, 1);

      const healedConfig = await readJson<{ target: { type: string; value: string } }>(configPath);
      assert.equal(healedConfig.target.type, 'pane');
      assert.equal(healedConfig.target.value, '%99');
    });
  });

  it('skips injection when the resolved pane is still busy', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const sessionId = 'omx-busy-pane';
      const sessionStateDir = join(stateDir, 'sessions', sessionId);
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);
      const configPath = join(omxDir, 'tmux-hook.json');
      const hookStatePath = join(stateDir, 'tmux-hook-state.json');

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeManagedSessionState(stateDir, cwd, sessionId);
      await writeJson(join(sessionStateDir, 'ralph-state.json'), { active: true, iteration: 0, tmux_pane_id: '%42' });
      await writeJson(configPath, {
        enabled: true,
        target: { type: 'pane', value: '%42' },
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
  if [[ "$format" == "#{pane_id}" && "$target" == "%42" ]]; then
    echo "%42"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%42" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%42" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
  if [[ "$format" == "#{pane_in_mode}" && "$target" == "%42" ]]; then
    echo "0"
    exit 0
  fi
  echo "bad display target: $target / $format" >&2
  exit 1
fi
if [[ "$cmd" == "capture-pane" ]]; then
  cat <<'EOF'
Working...
• Running tests (3m 12s • esc to interrupt)
EOF
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  echo "unexpected send-keys" >&2
  exit 1
fi
echo "unsupported cmd: $cmd" >&2
exit 1
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const payload = {
        cwd,
        type: 'agent-turn-complete',
        session_id: sessionId,
        'thread-id': 'thread-test-busy-pane',
        'turn-id': 'turn-test-busy-pane',
        'input-messages': ['no marker here'],
        'last-assistant-message': 'output',
      };

      const previousPath = process.env.PATH;
      const previousTeamWorker = process.env.OMX_TEAM_WORKER;
      try {
        process.env.PATH = `${fakeBinDir}:${process.env.PATH || ''}`;
        process.env.OMX_TEAM_WORKER = '';
        delete process.env.TMUX_PANE;
        await handleTmuxInjection({ payload, cwd, stateDir, logsDir });
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        if (typeof previousTeamWorker === 'string') process.env.OMX_TEAM_WORKER = previousTeamWorker;
        else delete process.env.OMX_TEAM_WORKER;
      }

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, 'pane_has_active_task');
      assert.equal(hookState.total_injections ?? 0, 0);
    });
  });
});
