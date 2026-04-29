import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTmuxSessionName } from '../../cli/index.js';
import { handleTmuxInjection, resolvePaneTarget } from '../../scripts/notify-hook/tmux-injection.js';

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

function withPatchedEnv<T>(patch: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const managedKeys = new Set([
    ...Object.keys(patch),
    'CODEX_HOME',
    'OMX_SESSION_ID',
    'OMX_RUNTIME_BRIDGE',
    'OMX_NOTIFY_FALLBACK',
    'OMX_NOTIFY_FALLBACK_AUTO_NUDGE_STALL_MS',
    'OMX_HOOK_CONFIG',
    'OMX_NOTIFY_PROFILE',
    'OMX_NOTIFY_VERBOSITY',
    'OMX_TEAM_WORKER',
    'OMX_TEAM_STATE_ROOT',
    'OMX_TEAM_LEADER_CWD',
    'OMX_MODEL_INSTRUCTIONS_FILE',
    'TMUX',
    'TMUX_PANE',
  ]);
  const previous = new Map<string, string | undefined>();
  for (const key of managedKeys) {
    previous.set(key, process.env[key]);
    if (Object.prototype.hasOwnProperty.call(patch, key)) process.env[key] = patch[key]!;
    else delete process.env[key];
  }
  return run().finally(() => {
    for (const [key, value] of previous) {
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
  });
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

  it('does not revive a legacy root Ralph fallback when canonical skill state excludes Ralph', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const sessionId = 'omx-abc123';
      const sessionStateDir = join(stateDir, 'sessions', sessionId);
      const configPath = join(omxDir, 'tmux-hook.json');
      const hookStatePath = join(stateDir, 'tmux-hook-state.json');
      const sessionStatePath = join(stateDir, 'session.json');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeManagedSessionState(stateDir, cwd, sessionId);
      const canonicalSessionState = JSON.parse(await readFile(sessionStatePath, 'utf-8')) as Record<string, unknown>;
      await writeJson(join(stateDir, 'ralph-state.json'), { active: true, iteration: 0, tmux_pane_id: '%42' });
      await writeJson(join(sessionStateDir, 'skill-active-state.json'), {
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        session_id: sessionId,
        active_skills: [
          { skill: 'ralplan', phase: 'planning', active: true, session_id: sessionId },
        ],
      });
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
  if [[ "$format" == "#{pane_id}" && "$target" == "%42" ]]; then
    echo "%42"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%42" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%42" ]]; then
    echo "codex --model gpt-5"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_path}" && "$target" == "%42" ]]; then
    echo "${cwd}"
    exit 0
  fi
  if [[ "$format" == "#{pane_in_mode}" && "$target" == "%42" ]]; then
    echo "0"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%42" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
echo "unsupported tmux call: $cmd $*" >&2
exit 1
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const payload = {
        cwd,
        type: 'agent-turn-complete',
        session_id: sessionId,
        'thread-id': 'thread-test-canonical-excludes-ralph',
        'turn-id': 'turn-test-canonical-excludes-ralph',
        'input-messages': ['no marker here'],
        'last-assistant-message': 'output',
      };

      const previousPath = process.env.PATH;
      const previousTeamWorker = process.env.OMX_TEAM_WORKER;
      try {
        process.env.PATH = `${fakeBinDir}:${process.env.PATH || ''}`;
        process.env.OMX_TEAM_WORKER = '';
        await handleTmuxInjection({ payload, cwd, stateDir, logsDir });
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        if (typeof previousTeamWorker === 'string') process.env.OMX_TEAM_WORKER = previousTeamWorker;
        else delete process.env.OMX_TEAM_WORKER;
      }

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.total_injections, 0);
      assert.equal(hookState.last_reason, 'mode_not_allowed');
      const persistedSessionState = JSON.parse(await readFile(sessionStatePath, 'utf-8')) as Record<string, unknown>;
      assert.equal(persistedSessionState.session_id, canonicalSessionState.session_id);
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.doesNotMatch(tmuxLog, /send-keys -t %42 -l/, 'legacy root Ralph state should not trigger a Ralph nudge when canonical skill state excludes Ralph');
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

  it('prefers the session tagged with the current OMX instance over stale pane config', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const sessionId = 'omx-tagged-instance';
      const sessionStateDir = join(stateDir, 'sessions', sessionId);
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);
      const wrongSessionName = 'other-omx-session';
      const configPath = join(omxDir, 'tmux-hook.json');
      const hookStatePath = join(stateDir, 'tmux-hook-state.json');

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeManagedSessionState(stateDir, cwd, sessionId);
      await writeJson(join(sessionStateDir, 'ralph-state.json'), { active: true, iteration: 0 });
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
if [[ "$cmd" == "list-sessions" ]]; then
  printf "%s\t%s\n" "${wrongSessionName}" "omx-other"
  printf "%s\t%s\n" "${managedSessionName}" "${sessionId}"
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
  if [[ "$target" == "${managedSessionName}" ]]; then
    printf "%%99\t1\tcodex\tcodex\n"
    exit 0
  fi
  exit 1
fi
if [[ "$cmd" == "show-option" ]]; then
  target=""
  while (($#)); do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "$target" == "${managedSessionName}" ]]; then
    echo "${sessionId}"
    exit 0
  fi
  if [[ "$target" == "${wrongSessionName}" ]]; then
    echo "omx-other"
    exit 0
  fi
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
  if [[ "$format" == "#{pane_id}" && "$target" == "%99" ]]; then echo "%99"; exit 0; fi
  if [[ "$format" == "#{pane_current_path}" && "$target" == "%99" ]]; then echo "${cwd}"; exit 0; fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%99" ]]; then echo "codex"; exit 0; fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%99" ]]; then echo "codex"; exit 0; fi
  if [[ "$format" == "#{pane_in_mode}" && "$target" == "%99" ]]; then echo "0"; exit 0; fi
  if [[ "$format" == "#S" && "$target" == "%99" ]]; then echo "${managedSessionName}"; exit 0; fi
  if [[ "$format" == "#{pane_id}" && "$target" == "%42" ]]; then echo "%42"; exit 0; fi
  if [[ "$format" == "#S" && "$target" == "%42" ]]; then echo "${wrongSessionName}"; exit 0; fi
  exit 1
fi
if [[ "$cmd" == "send-keys" ]]; then
  [[ "$*" == *"%99"* ]]
  exit $?
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
        'thread-id': 'thread-tagged-instance',
        'turn-id': 'turn-tagged-instance',
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

  it('skips injection when a static pane belongs to another tagged OMX instance', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const sessionId = 'omx-current-instance';
      const sessionStateDir = join(stateDir, 'sessions', sessionId);
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const wrongSessionName = 'wrong-tagged-session';
      const configPath = join(omxDir, 'tmux-hook.json');
      const hookStatePath = join(stateDir, 'tmux-hook-state.json');

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeManagedSessionState(stateDir, cwd, sessionId);
      await writeJson(join(sessionStateDir, 'ralph-state.json'), { active: true, iteration: 0 });
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
if [[ "$cmd" == "list-sessions" ]]; then
  printf "%s\t%s\n" "${wrongSessionName}" "omx-other-instance"
  exit 0
fi
if [[ "$cmd" == "show-option" ]]; then
  echo "omx-other-instance"
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
  if [[ "$format" == "#{pane_id}" && "$target" == "%42" ]]; then echo "%42"; exit 0; fi
  if [[ "$format" == "#{pane_current_path}" && "$target" == "%42" ]]; then echo "${cwd}"; exit 0; fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%42" ]]; then echo "codex"; exit 0; fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%42" ]]; then echo "codex"; exit 0; fi
  if [[ "$format" == "#S" && "$target" == "%42" ]]; then echo "${wrongSessionName}"; exit 0; fi
  exit 1
fi
if [[ "$cmd" == "send-keys" ]]; then
  echo "send-keys must not run" >&2
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
        'thread-id': 'thread-wrong-instance',
        'turn-id': 'turn-wrong-instance',
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
      assert.equal(hookState.last_reason, 'pane_instance_mismatch');
      assert.equal(hookState.total_injections, 0);
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

  it('accepts alias and canonical twin paths when resolving managed pane ownership', async () => {
    await withTempWorkingDir(async (cwd) => {
      const aliasCwd = `${cwd}-alias`;
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const sessionId = 'omx-abc123';
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const managedSessionName = buildTmuxSessionName(cwd, sessionId);

      await mkdir(stateDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await symlink(cwd, aliasCwd, process.platform === 'win32' ? 'junction' : 'dir');
      await writeManagedSessionState(stateDir, cwd, sessionId);

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
  if [[ "$target" == "%42" && "$format" == "#{pane_id}" ]]; then
    echo "%42"
    exit 0
  fi
  if [[ "$target" == "%42" && "$format" == "#{pane_start_command}" ]]; then
    echo "codex --model gpt-5"
    exit 0
  fi
  if [[ "$target" == "%42" && "$format" == "#{pane_current_command}" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$target" == "%42" && "$format" == "#{pane_current_path}" ]]; then
    echo "${cwd}"
    exit 0
  fi
  if [[ "$target" == "%42" && "$format" == "#S" ]]; then
    echo "${managedSessionName}"
    exit 0
  fi
fi
echo "unsupported tmux call: $cmd $*" >&2
exit 1
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const previousPath = process.env.PATH;
      const previousTeamWorker = process.env.OMX_TEAM_WORKER;
      const previousTmux = process.env.TMUX;
      const previousTmuxPane = process.env.TMUX_PANE;
      try {
        process.env.PATH = `${fakeBinDir}:${process.env.PATH || ''}`;
        process.env.OMX_TEAM_WORKER = '';
        delete process.env.TMUX;
        delete process.env.TMUX_PANE;

        const resolution = await resolvePaneTarget(
          { type: 'pane', value: '%42' },
          aliasCwd,
          '',
          aliasCwd,
          { session_id: sessionId },
        );
        assert.equal(resolution.paneTarget, '%42');
        assert.equal(resolution.reason, 'explicit_pane_target');
        assert.equal(resolution.matched_session, managedSessionName);
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        if (typeof previousTeamWorker === 'string') process.env.OMX_TEAM_WORKER = previousTeamWorker;
        else delete process.env.OMX_TEAM_WORKER;
        if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
        else delete process.env.TMUX;
        if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
        else delete process.env.TMUX_PANE;
        await rm(aliasCwd, { recursive: true, force: true });
      }
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

  it('does not heal the repo-scoped target when a preGuard skip returns early', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const sessionId = 'omx-preguard-heal';
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
        'thread-id': 'thread-test-preguard-heal',
        'turn-id': 'turn-test-preguard-heal',
        'input-messages': ['already contains [OMX_TMUX_INJECT] marker'],
        'last-assistant-message': 'output',
      };

      await withPatchedEnv({
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
        OMX_TEAM_WORKER: '',
      }, async () => {
        await handleTmuxInjection({ payload, cwd, stateDir, logsDir });
      });

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, 'loop_guard_input_marker');
      assert.equal(hookState.total_injections, 0);

      const healedConfig = await readJson<{ target: { type: string; value: string } }>(configPath);
      assert.equal(healedConfig.target.type, 'session');
      assert.equal(healedConfig.target.value, 'nonexistent-session');
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
