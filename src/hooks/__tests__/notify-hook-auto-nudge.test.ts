import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTmuxSessionName } from '../../cli/index.js';
import { classifyKeywordInput, recordSkillActivation } from '../keyword-detector.js';
import { recordNotifySkillActivation, recordNotifySkillActivationNonFatal } from '../../scripts/notify-hook.js';
import { normalizeSkillActiveState } from '../../scripts/notify-hook/auto-nudge.js';

const NOTIFY_HOOK_SCRIPT = new URL('../../../dist/scripts/notify-hook.js', import.meta.url);
const DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS = ['yes', 'y', 'proceed', 'continue', 'ok', 'sure', 'go ahead', 'next i should'];
const NEXT_I_SHOULD_RESPONSE = 'Next I should update the focused tests.';
const DEFAULT_AUTO_NUDGE_RESPONSE = 'continue with the current task only if it is already authorized';
const INHERITED_OMX_ENV_KEYS = [
  'OMX_ROOT',
  'OMX_STATE_ROOT',
  'OMX_SESSION_ID',
  'OMX_SOURCE_CWD',
  'OMX_STARTUP_CWD',
  'OMX_ENTRY_PATH',
] as const;

describe('notify lifecycle owner normalization', () => {
  it('preserves the stored Codex owner for lifecycle authorization checks', () => {
    const state = normalizeSkillActiveState({
      skill: 'ralph',
      active: true,
      phase: 'executing',
      owner_codex_session_id: 'codex-owner-a',
    });
    assert.equal(state?.owner_codex_session_id, 'codex-owner-a');
  });
});

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

async function writeManagedSessionState(stateDir: string, cwd: string): Promise<void> {
  await writeJson(join(stateDir, 'session.json'), {
    session_id: 'sess-managed',
    started_at: new Date().toISOString(),
    cwd,
    pid: process.pid,
    platform: process.platform,
    pid_start_ticks: readLinuxStartTicks(process.pid),
    pid_cmdline: readLinuxCmdline(process.pid),
  });
}

async function writeWorkerIdentityFixture(stateRoot: string, cwd: string, teamName: string, workerName: string): Promise<void> {
  const workerDir = join(stateRoot, 'team', teamName, 'workers', workerName);
  await mkdir(workerDir, { recursive: true });
  await writeJson(join(workerDir, 'identity.json'), {
    name: workerName,
    index: Number(workerName.replace(/^worker-/, '')) || 1,
    role: 'executor',
    assigned_tasks: [],
    worktree_path: cwd,
    team_state_root: stateRoot,
  });
  await writeJson(join(stateRoot, 'team', teamName, 'config.json'), {
    name: teamName,
    tmux_pane_owner_id: `team:${teamName}`,
    hud_pane_id: null,
    workers: [{ name: workerName, pane_id: '%99', pid: 9999 }],
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function defaultAutoNudgePattern(targetPane: string): RegExp {
  return new RegExp(`send-keys -t ${escapeRegex(targetPane)} -l ${escapeRegex(DEFAULT_AUTO_NUDGE_RESPONSE)} \\[OMX_TMUX_INJECT\\]`);
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
if [[ "\$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "\$cmd" == "show-buffer" ]]; then
  if [[ -f "${tmuxLogPath}.buffer" ]]; then cat "${tmuxLogPath}.buffer"; fi
  exit 0
fi
if [[ "\$cmd" == "paste-buffer" ]]; then
  target=""
  while [[ "\$#" -gt 0 ]]; do
    case "\$1" in
      -t) target="\$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "${tmuxLogPath}.buffer" ]]; then
    echo "send-keys -t \${target} -l $(cat "${tmuxLogPath}.buffer")" >> "${tmuxLogPath}"
  fi
  exit 0
fi
if [[ "\$cmd" == "delete-buffer" ]]; then
  rm -f "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "\$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "show-option" ]]; then
  option="\${@: -1}"
  case "$option" in
    @omx_team_pane_owner_id) echo "\${OMX_TEST_TMUX_OWNER:-team:auto-nudge}" ;;
    @omx_pane_instance_id) echo "\${OMX_TEST_TMUX_PANE_INSTANCE_ID:-}" ;;
    @omx_instance_id) echo "\${OMX_TEST_TMUX_INSTANCE_ID:-}" ;;
  esac
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
    echo "${'${OMX_TEST_TMUX_SESSION_NAME:-devsess}'}"
    exit 0
  fi
  exit 0
fi
if [[ "\$cmd" == "list-panes" ]]; then
  target=""
  while [[ "\$#" -gt 0 ]]; do
    case "\$1" in
      -t) target="\$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -n "\$target" && "\$target" == "${'${OMX_TEST_TMUX_SESSION_NAME:-devsess}'}" ]]; then
    printf '%%99\t1\tnode\tcodex --model gpt-5\n'
    exit 0
  fi
  printf '%%99\t0\t%s\n%%100\t0\t10000\n' "\${OMX_TEST_TMUX_PANE_PID:-9999}"
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
  if (extraEnv.OMX_TEST_UNMANAGED_SESSION !== '1' && !extraEnv.OMX_TEAM_WORKER) {
    const sessionPath = join(cwd, '.omx', 'state', 'session.json');
    const sessionState = {
      session_id: 'sess-managed',
      started_at: new Date().toISOString(),
      cwd,
      pid: process.pid,
      platform: process.platform,
      pid_start_ticks: readLinuxStartTicks(process.pid),
      pid_cmdline: readLinuxCmdline(process.pid),
    };
    writeFileSync(sessionPath, JSON.stringify(sessionState, null, 2));
  }

  const payload = {
    cwd,
    type: 'agent-turn-complete',
    'thread-id': 'thread-test',
    'turn-id': `turn-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    ...(extraEnv.OMX_TEST_UNMANAGED_SESSION !== '1' && !extraEnv.OMX_TEAM_WORKER ? { 'session-id': 'sess-managed' } : {}),
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
      ...Object.fromEntries(INHERITED_OMX_ENV_KEYS.map((key) => [key, ''])),
      ...(extraEnv.OMX_TEST_UNMANAGED_SESSION !== '1' && !extraEnv.OMX_TEAM_WORKER ? { OMX_SESSION_ID: 'sess-managed' } : {}),
      ...(extraEnv.OMX_TEST_UNMANAGED_SESSION !== '1' && !extraEnv.OMX_TEAM_WORKER ? { OMX_TEST_TMUX_SESSION_NAME: buildTmuxSessionName(cwd, 'sess-managed') } : {}),
      TMUX_PANE: '%99',
      TMUX: '1',
      OMX_TEAM_INTERNAL_WORKER: '',
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

      await writeManagedSessionState(stateDir, cwd);
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      await mkdir(sessionStateDir, { recursive: true });

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'I analyzed the code. Keep going and finish the focused cleanup.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%99'));

      const nudgeState = JSON.parse(await readFile(join(sessionStateDir, 'auto-nudge-state.json'), 'utf-8'));
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
      await writeManagedSessionState(stateDir, cwd);

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'I analyzed the code. Keep going and finish the focused cleanup.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      assert.ok(existsSync(tmuxLogPath), 'tmux should have been called');
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, defaultAutoNudgePattern('%99'), 'should send nudge response with injection marker');
      // Codex CLI needs C-m sent twice with a delay for reliable submission
      const cmMatches = tmuxLog.match(/send-keys -t %99 C-m/g);
      assert.ok(cmMatches && cmMatches.length >= 2, `should send C-m twice, got ${cmMatches?.length ?? 0}`);
    });
  });

  it('does not auto-nudge planning-phase skill state into execution', async () => {
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
      await writeManagedSessionState(stateDir, cwd);
      await writeJson(join(stateDir, 'skill-active-state.json'), {
        active: true,
        skill: 'analyze',
        keyword: 'investigate',
        phase: 'planning',
        source: 'keyword-detector',
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'I can continue with the plan from here.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.doesNotMatch(tmuxLog, /send-keys -t %99 -l/, 'planning-phase prompts should not be auto-nudged');

      const skillState = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8'));
      assert.equal(skillState.phase, 'planning');
    });
  });

  it('respects `.omx/tmux-hook.json` enabled:false and skips auto-nudge injection', async () => {
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
      await writeJson(join(omxDir, 'tmux-hook.json'), {
        enabled: false,
        target: { type: 'pane', value: '%99' },
      });
      await writeManagedSessionState(stateDir, cwd);

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'I analyzed the code. If you want me to make these changes, let me know.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%99'));
    });
  });

  it('does not auto-nudge plain tmux Codex sessions that only inherit OMX session env', async () => {
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

      const sleeper = spawnSync('bash', ['-lc', 'sleep 5 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' });
      assert.equal(sleeper.status, 0, sleeper.stderr || sleeper.stdout);
      const sleeperPid = Number((sleeper.stdout || '').trim());
      assert.ok(Number.isFinite(sleeperPid) && sleeperPid > 1, 'expected helper pid');

      await writeJson(join(stateDir, 'session.json'), {
        session_id: 'sess-managed',
        started_at: new Date().toISOString(),
        cwd,
        pid: sleeperPid,
        platform: process.platform,
        pid_start_ticks: readLinuxStartTicks(sleeperPid),
        pid_cmdline: readLinuxCmdline(sleeperPid),
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'session-id': 'sess-managed',
        'last-assistant-message': 'I analyzed the code. If you want me to make these changes, let me know.',
      }, {
        OMX_SESSION_ID: 'sess-managed',
        OMX_TEST_UNMANAGED_SESSION: '1',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%99'));
    });
  });

  it('does not auto-nudge plain tmux Codex sessions that are not OMX-managed', async () => {
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
        'last-assistant-message': 'I analyzed the code. If you want me to make these changes, let me know.',
      }, {
        OMX_TEST_UNMANAGED_SESSION: '1',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%99'));
    });
  });

  it('does not auto-nudge when payload session-id disagrees with the managed tmux session identity', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const managedSessionName = buildTmuxSessionName(cwd, 'sess-managed');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });

      await writeManagedSessionState(stateDir, cwd);

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'session-id': 'sess-other',
        'last-assistant-message': 'I analyzed the code. If you want me to make these changes, let me know.',
      }, {
        OMX_SESSION_ID: 'sess-managed',
        OMX_TEST_TMUX_SESSION_NAME: managedSessionName,
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%99'));
    });
  });

  it('does not auto-nudge when tmux session naming drifts from the current OMX session id', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const expectedManagedSessionName = buildTmuxSessionName(cwd, 'sess-managed');
      const mismatchedDetachedSessionName = buildTmuxSessionName(cwd, 'sess-legacy-detached');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });

      await writeManagedSessionState(stateDir, cwd);

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'session-id': 'sess-managed',
        'last-assistant-message': 'I analyzed the code. If you want me to make these changes, let me know.',
      }, {
        OMX_SESSION_ID: 'sess-managed',
        OMX_TEST_TMUX_SESSION_NAME: mismatchedDetachedSessionName,
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(
        tmuxLog,
        new RegExp(`list-panes -s -t ${escapeRegex(expectedManagedSessionName)}`),
        'should resolve panes against the current OMX session identity, not the drifted tmux session name',
      );
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%99'));
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
      await writeManagedSessionState(stateDir, cwd);

      // capture-pane will return content with a stall pattern
      await writeFile(captureFile, 'Here are the results.\nKeep going and finish the implementation.\n› ');

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
      assert.match(tmuxLog, defaultAutoNudgePattern('%99'), 'should send nudge via capture-pane fallback with marker');
    });
  });

  it('does not nudge from PASS/FAIL-style test output captured from the pane', async () => {
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
      await writeManagedSessionState(stateDir, cwd);

      await writeFile(
        captureFile,
        [
          'PASS should continue with the next step when approvals are present',
          'FAIL aborts the branch cleanly when the worker exits early',
          'Test Suites: 1 failed, 1 total',
        ].join('\n'),
      );

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'clean output with no stall',
      }, {
        OMX_TEST_CAPTURE_FILE: captureFile,
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /capture-pane/, 'should still inspect capture-pane output');
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%99'), 'PASS/FAIL-style test output must not trigger a nudge');
    });
  });

  it('auto-nudges from active mode state by upgrading an anchored shell pane to the sibling codex pane', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const managedSessionName = buildTmuxSessionName(cwd, 'sess-managed');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });
      await writeManagedSessionState(stateDir, cwd);

      await writeJson(join(sessionStateDir, 'ralph-state.json'), {
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
    echo "${managedSessionName}"
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
  if [[ "$target" == "${managedSessionName}" ]]; then
    printf "%%99\t0\tsh\tbash\n%%100\t1\tnode\tcodex --model gpt-5\n"
    exit 0
  fi
  printf '%%99\t0\t9999\n%%100\t0\t10000\n'
  exit 0
fi
if [[ "$cmd" == "capture-pane" ]]; then
  printf "How can I help?\n› "
  exit 0
fi
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${tmuxLogPath}.buffer" ]]; then cat "${tmuxLogPath}.buffer"; fi
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "${tmuxLogPath}.buffer" ]]; then
    echo "send-keys -t \${target} -l $(cat "${tmuxLogPath}.buffer")" >> "${tmuxLogPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${tmuxLogPath}.buffer"
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
        'last-assistant-message': 'Keep going and finish the cleanup from here.',
      }, {
        TMUX_PANE: '',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, defaultAutoNudgePattern('%100'), 'should upgrade anchored shell pane to sibling codex pane');
    });
  });

  it('keeps a verified codex anchor from active mode state even when a sibling codex pane is focused', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const managedSessionName = buildTmuxSessionName(cwd, 'sess-managed');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });
      await writeManagedSessionState(stateDir, cwd);

      await writeJson(join(sessionStateDir, 'ralph-state.json'), {
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
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%99" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#{pane_in_mode}" && "$target" == "%99" ]]; then
    echo "0"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%99" ]]; then
    echo "${managedSessionName}"
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
  if [[ "$target" == "${managedSessionName}" ]]; then
    printf "%%99\t0\tcodex\tcodex\\n%%100\t1\tcodex\tcodex\\n"
    exit 0
  fi
  printf '%%99\t0\t9999\n%%100\t0\t10000\n'
  exit 0
fi
if [[ "$cmd" == "capture-pane" ]]; then
  printf "How can I help?\\n› "
  exit 0
fi
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${tmuxLogPath}.buffer" ]]; then cat "${tmuxLogPath}.buffer"; fi
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "${tmuxLogPath}.buffer" ]]; then
    echo "send-keys -t \${target} -l $(cat "${tmuxLogPath}.buffer")" >> "${tmuxLogPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${tmuxLogPath}.buffer"
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
        'last-assistant-message': 'Keep going and finish the cleanup from here.',
      }, {
        TMUX_PANE: '',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, defaultAutoNudgePattern('%99'), 'should keep the verified codex anchor');
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%100'), 'should not jump to the focused sibling codex pane');
    });
  });

  it('upgrades a node shell anchor from active mode state to the sibling codex pane', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const managedSessionName = buildTmuxSessionName(cwd, 'sess-managed');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });
      await writeManagedSessionState(stateDir, cwd);

      await writeJson(join(sessionStateDir, 'ralph-state.json'), {
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
    echo "node"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%99" ]]; then
    echo "bash"
    exit 0
  fi
  if [[ "$format" == "#{pane_in_mode}" && "$target" == "%100" ]]; then
    echo "0"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%99" ]]; then
    echo "${managedSessionName}"
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
  if [[ "$target" == "${managedSessionName}" ]]; then
    printf "%%99\t0\tnode\tbash\\n%%100\t1\tnode\tcodex --model gpt-5\\n"
    exit 0
  fi
  printf '%%99\t0\t9999\n%%100\t0\t10000\n'
  exit 0
fi
if [[ "$cmd" == "capture-pane" ]]; then
  printf "How can I help?\\n› "
  exit 0
fi
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${tmuxLogPath}.buffer" ]]; then cat "${tmuxLogPath}.buffer"; fi
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "${tmuxLogPath}.buffer" ]]; then
    echo "send-keys -t \${target} -l $(cat "${tmuxLogPath}.buffer")" >> "${tmuxLogPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${tmuxLogPath}.buffer"
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
        'last-assistant-message': 'Keep going and finish the cleanup from here.',
      }, {
        TMUX_PANE: '',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, defaultAutoNudgePattern('%100'), 'should upgrade the node shell anchor to the sibling codex pane');
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%99'), 'node shell anchor should not be retained');
    });
  });

  it('upgrades a shell-degraded codex anchor from active mode state to the sibling codex pane', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const managedSessionName = buildTmuxSessionName(cwd, 'sess-managed');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });
      await writeManagedSessionState(stateDir, cwd);

      await writeJson(join(sessionStateDir, 'ralph-state.json'), {
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
    echo "bash"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%99" ]]; then
    echo "codex --model gpt-5"
    exit 0
  fi
  if [[ "$format" == "#{pane_in_mode}" && "$target" == "%100" ]]; then
    echo "0"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%99" ]]; then
    echo "${managedSessionName}"
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
  if [[ "$target" == "${managedSessionName}" ]]; then
    printf "%%99\t1\tbash\tcodex --model gpt-5\\n%%100\t0\tnode\tcodex --model gpt-5\\n"
    exit 0
  fi
  printf '%%99\t0\t9999\n%%100\t0\t10000\n'
  exit 0
fi
if [[ "$cmd" == "capture-pane" ]]; then
  printf "How can I help?\\n› "
  exit 0
fi
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${tmuxLogPath}.buffer" ]]; then cat "${tmuxLogPath}.buffer"; fi
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "${tmuxLogPath}.buffer" ]]; then
    echo "send-keys -t \${target} -l $(cat "${tmuxLogPath}.buffer")" >> "${tmuxLogPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${tmuxLogPath}.buffer"
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
        'last-assistant-message': 'Keep going and finish the cleanup from here.',
      }, {
        TMUX_PANE: '',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, defaultAutoNudgePattern('%100'), 'should upgrade the shell-degraded codex anchor to the sibling codex pane');
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%99'), 'shell-degraded codex anchor should not be retained');
    });
  });

  it('fails closed when a shell-degraded codex anchor has no live sibling pane', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const managedSessionName = buildTmuxSessionName(cwd, 'sess-managed');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });
      await writeManagedSessionState(stateDir, cwd);

      await writeJson(join(sessionStateDir, 'ralph-state.json'), {
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
    echo "bash"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%99" ]]; then
    echo "codex --model gpt-5"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%99" ]]; then
    echo "${managedSessionName}"
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
  if [[ "$target" == "${managedSessionName}" ]]; then
    printf "%%99\t1\tbash\tcodex --model gpt-5\\n%%100\t0\tbash\tbash\\n"
    exit 0
  fi
  printf '%%99\t0\t9999\n%%100\t0\t10000\n'
  exit 0
fi
if [[ "$cmd" == "capture-pane" ]]; then
  printf "How can I help?\\n› "
  exit 0
fi
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${tmuxLogPath}.buffer" ]]; then cat "${tmuxLogPath}.buffer"; fi
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "${tmuxLogPath}.buffer" ]]; then
    echo "send-keys -t \${target} -l $(cat "${tmuxLogPath}.buffer")" >> "${tmuxLogPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${tmuxLogPath}.buffer"
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
        'last-assistant-message': 'Keep going and finish the cleanup from here.',
      }, {
        TMUX_PANE: '',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%99'), 'shell-degraded codex anchor should not be retained without a live sibling');
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%100'), 'no live sibling should keep auto-nudge from sending input');
    });
  });

  it('still auto-nudges in team-worker context using the worker state root', async () => {
    await withTempWorkingDir(async (cwd) => {
      const workerStateRoot = join(cwd, 'leader-state-root');
      const logsDir = join(cwd, '.omx', 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const managedSessionName = buildTmuxSessionName(cwd, 'sess-managed');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workerStateRoot, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeWorkerIdentityFixture(workerStateRoot, cwd, 'auto-nudge', 'worker-1');

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
      assert.match(tmuxLog, defaultAutoNudgePattern('%99'), 'team-worker context should still send auto-nudge');

      const nudgeStatePath = join(workerStateRoot, 'auto-nudge-state.json');
      assert.ok(existsSync(nudgeStatePath), 'worker state root should receive auto-nudge state');
    });
  });

  it('does not capture or send in team-worker context without a persisted string owner token', async () => {
    for (const owner of [undefined, 17] as const) {
      await withTempWorkingDir(async (cwd) => {
        const workerStateRoot = join(cwd, 'leader-state-root');
        const codexHome = join(cwd, 'codex-home');
        const fakeBinDir = join(cwd, 'fake-bin');
        const tmuxLogPath = join(cwd, 'tmux.log');
        await mkdir(workerStateRoot, { recursive: true });
        await mkdir(codexHome, { recursive: true });
        await mkdir(fakeBinDir, { recursive: true });
        await writeWorkerIdentityFixture(workerStateRoot, cwd, 'auto-nudge', 'worker-1');
        const configPath = join(workerStateRoot, 'team', 'auto-nudge', 'config.json');
        const config = JSON.parse(await readFile(configPath, 'utf-8'));
        if (owner === undefined) delete config.tmux_pane_owner_id;
        else config.tmux_pane_owner_id = owner;
        await writeJson(configPath, config);
        await writeJson(join(codexHome, '.omx-config.json'), { autoNudge: { enabled: true, delaySec: 0, stallMs: 0 } });
        await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
        await chmod(join(fakeBinDir, 'tmux'), 0o755);

        const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
          'last-assistant-message': 'I can continue with the worker follow-up from here.',
        }, {
          OMX_TEAM_WORKER: 'auto-nudge/worker-1',
          OMX_TEAM_STATE_ROOT: workerStateRoot,
        });
        assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
        assert.doesNotMatch(tmuxLog, /capture-pane|send-keys/, 'missing or malformed persisted owner must not capture or send tmux input');
      });
    }
  });

  it('fails closed for Team-worker owner takeover, recycled panes, and HUD targets', async () => {
    for (const scenario of ([
      { name: 'owner takeover', env: { OMX_TEST_TMUX_OWNER: 'team:foreign' }, hudPaneId: null },
      { name: 'recycled pane', env: { OMX_TEST_TMUX_PANE_PID: '10001' }, hudPaneId: null },
      { name: 'HUD target', env: {}, hudPaneId: '%99' },
    ] satisfies Array<{ name: string; env: Record<string, string>; hudPaneId: string | null }>)) {
      await withTempWorkingDir(async (cwd) => {
        const workerStateRoot = join(cwd, 'leader-state-root');
        const codexHome = join(cwd, 'codex-home');
        const fakeBinDir = join(cwd, 'fake-bin');
        const tmuxLogPath = join(cwd, 'tmux.log');
        await mkdir(workerStateRoot, { recursive: true });
        await mkdir(codexHome, { recursive: true });
        await mkdir(fakeBinDir, { recursive: true });
        await writeWorkerIdentityFixture(workerStateRoot, cwd, 'auto-nudge', 'worker-1');
        const configPath = join(workerStateRoot, 'team', 'auto-nudge', 'config.json');
        const config = JSON.parse(await readFile(configPath, 'utf-8'));
        config.hud_pane_id = scenario.hudPaneId;
        await writeJson(configPath, config);
        await writeJson(join(codexHome, '.omx-config.json'), { autoNudge: { enabled: true, delaySec: 0, stallMs: 0 } });
        await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
        await chmod(join(fakeBinDir, 'tmux'), 0o755);

        const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
          'last-assistant-message': 'I can continue with the worker follow-up from here.',
        }, {
          OMX_TEAM_WORKER: 'auto-nudge/worker-1',
          OMX_TEAM_STATE_ROOT: workerStateRoot,
          ...(scenario.env as Record<string, string>),
        });
        assert.equal(result.status, 0, `${scenario.name}: hook failed: ${result.stderr || result.stdout}`);
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%99'), `${scenario.name} must not inject Team input`);
      });
    }
  });

  it('fails closed in team-worker context when the worker state root lacks a valid identity', async () => {
    await withTempWorkingDir(async (cwd) => {
      const localStateRoot = join(cwd, '.omx', 'state');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(localStateRoot, { recursive: true });
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
        OMX_TEAM_STATE_ROOT: '',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      assert.equal(existsSync(join(localStateRoot, 'auto-nudge-state.json')), false, 'unvalidated worker cwd state root must not receive auto-nudge state');
      assert.equal(existsSync(join(localStateRoot, 'team', 'auto-nudge', 'workers', 'worker-1', 'heartbeat.json')), false, 'unvalidated worker cwd state root must not receive heartbeat state');
      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /send-keys/, 'unvalidated worker state root must not inject auto-nudge input');
      }
    });
  });

  it('still auto-nudges from the stored worker pane when TMUX_PANE is missing and the worker pane looks shell-degraded', async () => {
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
      await writeWorkerIdentityFixture(workerStateRoot, cwd, 'auto-nudge', 'worker-1');

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });
      await writeJson(join(workerStateRoot, 'ralph-state.json'), {
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
    echo "bash"
    exit 0
  fi
  if [[ "$format" == "#{pane_start_command}" && "$target" == "%99" ]]; then
    echo "codex --model gpt-5"
    exit 0
  fi
  if [[ "$format" == "#{pane_in_mode}" && "$target" == "%99" ]]; then
    echo "0"
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "capture-pane" ]]; then
  printf "How can I help?\\n› "
  exit 0
fi
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${tmuxLogPath}.buffer" ]]; then cat "${tmuxLogPath}.buffer"; fi
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "${tmuxLogPath}.buffer" ]]; then
    echo "send-keys -t \${target} -l $(cat "${tmuxLogPath}.buffer")" >> "${tmuxLogPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "show-option" ]]; then
  echo "team:auto-nudge"
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  printf '%%99\t0\t9999\n%%100\t0\t10000\n'
  exit 0
fi
exit 0
`;
      await writeFile(join(fakeBinDir, 'tmux'), fakeTmux);
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'I can continue with the worker follow-up from here.',
      }, {
        OMX_TEAM_WORKER: 'auto-nudge/worker-1',
        OMX_TEAM_STATE_ROOT: workerStateRoot,
        TMUX_PANE: '',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, defaultAutoNudgePattern('%99'), 'worker fallback should keep using the stored pane when TMUX_PANE is absent');
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
      await writeManagedSessionState(stateDir, cwd);
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      await mkdir(sessionStateDir, { recursive: true });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'I completed the refactoring. All tests pass.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, new RegExp(`send-keys -t %99 -l ${escapeRegex(DEFAULT_AUTO_NUDGE_RESPONSE)}`), 'should NOT send nudge');
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
      const managedSessionName = buildTmuxSessionName(cwd, 'sess-managed');

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
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${tmuxLogPath}.buffer" ]]; then cat "${tmuxLogPath}.buffer"; fi
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "${tmuxLogPath}.buffer" ]]; then
    echo "send-keys -t \${target} -l $(cat "${tmuxLogPath}.buffer")" >> "${tmuxLogPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  printf '%%99\t0\t9999\n%%100\t0\t10000\n'
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
      assert.ok(tmuxLog.includes('display-message -p -t %99 #S'), 'should inspect the managed anchor pane before deciding');
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%99'), 'shell pane should not receive auto-nudge injection');
    });
  });

  it('falls back to the sibling codex pane when TMUX_PANE is a managed non-agent shell pane', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const managedSessionName = buildTmuxSessionName(cwd, 'sess-managed');

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
    echo "${managedSessionName}"
    exit 0
  fi
  if [[ "$format" == "#S" && "$target" == "%100" ]]; then
    echo "${managedSessionName}"
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
  printf "› keep going\\n\\n• keep going\\n\\n› Implement {feature}\\n\\n  gpt-5.6-sol high · dev · 98%% left\\n"
  exit 0
fi
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${tmuxLogPath}.buffer" ]]; then cat "${tmuxLogPath}.buffer"; fi
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "${tmuxLogPath}.buffer" ]]; then
    echo "send-keys -t \${target} -l $(cat "${tmuxLogPath}.buffer")" >> "${tmuxLogPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${tmuxLogPath}.buffer"
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
  if [[ "$target" == "${managedSessionName}" ]]; then
    printf "%%99\t1\tsh\tbash\\n%%100\t0\tnode\tcodex --model gpt-5\\n"
    exit 0
  fi
  printf '%%99\t0\t9999\n%%100\t0\t10000\n'
  exit 0
fi
exit 0
`;
      await writeFile(join(fakeBinDir, 'tmux'), fakeTmux);
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'keep going',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /display-message -p #S/);
      assert.ok(tmuxLog.includes('display-message -p -t %99 #S'), 'should inspect the anchored shell pane before upgrading');
      assert.match(tmuxLog, defaultAutoNudgePattern('%100'));
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
      const managedSessionName = buildTmuxSessionName(cwd, 'sess-managed');

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
        'last-assistant-message': 'Keep going and finish the cleanup from here.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /display-message -p #S/);
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%99'), 'copy-mode pane should not receive auto-nudge injection');
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
      assert.match(tmuxLog, /capture-pane -t %99/, 'busy pane detection should inspect capture output');
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%99'), 'busy pane should not receive auto-nudge injection');
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
      await writeManagedSessionState(stateDir, cwd);
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      await mkdir(sessionStateDir, { recursive: true });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const sharedTurnId = 'semantic-dedup-turn';
      const first = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'turn-id': sharedTurnId,
        'last-assistant-message': 'Keep going and finish the cleanup from here.',
      });
      assert.equal(first.status, 0, `first hook failed: ${first.stderr || first.stdout}`);

      const second = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'turn-id': sharedTurnId,
        'last-assistant-message': 'Continue with the cleanup from here.',
      });
      assert.equal(second.status, 0, `second hook failed: ${second.stderr || second.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal((tmuxLog.match(new RegExp(defaultAutoNudgePattern('%99').source, 'g')) || []).length, 1);

      const nudgeState = JSON.parse(await readFile(join(sessionStateDir, 'auto-nudge-state.json'), 'utf-8'));
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
      await writeManagedSessionState(stateDir, cwd);
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      await mkdir(sessionStateDir, { recursive: true });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const first = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'turn-id': 'cooldown-turn-1',
        'last-assistant-message': 'Continue with the implementation from here.',
      });
      assert.equal(first.status, 0, `first hook failed: ${first.stderr || first.stdout}`);

      const second = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'turn-id': 'cooldown-turn-2',
        'last-assistant-message': 'I can also move forward with the implementation.',
      });
      assert.equal(second.status, 0, `second hook failed: ${second.stderr || second.stdout}`);

      let tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal((tmuxLog.match(new RegExp(defaultAutoNudgePattern('%99').source, 'g')) || []).length, 1);

      const nudgeStatePath = join(sessionStateDir, 'auto-nudge-state.json');
      const nudgeStateBeforeThird = JSON.parse(await readFile(nudgeStatePath, 'utf-8'));
      await writeJson(nudgeStatePath, {
        ...nudgeStateBeforeThird,
        lastNudgeAt: '2026-03-01T00:00:00.000Z',
      });

      const third = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'turn-id': 'cooldown-turn-3',
        'last-assistant-message': 'Keep going and finish the focused tests.',
      });
      assert.equal(third.status, 0, `third hook failed: ${third.stderr || third.stdout}`);

      tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal((tmuxLog.match(new RegExp(defaultAutoNudgePattern('%99').source, 'g')) || []).length, 2);

      const nudgeState = JSON.parse(await readFile(nudgeStatePath, 'utf-8'));
      assert.equal(nudgeState.nudgeCount, 2);
      assert.equal(nudgeState.lastSemanticSignature, 'stall:proceed_intent');
    });
  });

  it('does not resend the exact same stalled turn after TTL expiry', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const lastTurnAt = '2026-03-01T00:00:00.000Z';
      const lastMessage = 'Keep going and finish the cleanup from here.';

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0, ttlMs: 5000 },
      });
      await writeManagedSessionState(stateDir, cwd);
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      await mkdir(sessionStateDir, { recursive: true });
      await writeJson(join(sessionStateDir, 'hud-state.json'), {
        last_turn_at: lastTurnAt,
        turn_count: 1,
        last_agent_output: lastMessage,
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const first = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'turn-id': 'stalled-turn-1',
        'last-assistant-message': lastMessage,
      });
      assert.equal(first.status, 0, `first hook failed: ${first.stderr || first.stdout}`);

      const nudgeStatePath = join(sessionStateDir, 'auto-nudge-state.json');
      const firstState = JSON.parse(await readFile(nudgeStatePath, 'utf-8'));
      await writeJson(nudgeStatePath, {
        ...firstState,
        lastNudgeAt: '2026-03-01T00:00:10.000Z',
      });

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'turn-id': 'stalled-turn-1',
        'last-assistant-message': lastMessage,
      });
      assert.equal(result.status, 0, `second hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.equal((tmuxLog.match(new RegExp(defaultAutoNudgePattern('%99').source, 'g')) || []).length, 1);

      const nudgeState = JSON.parse(await readFile(nudgeStatePath, 'utf-8'));
      assert.equal(nudgeState.nudgeCount, 1);
      assert.equal(nudgeState.lastSignature, firstState.lastSignature);
    });
  });

  it('ignores non-turn-complete payloads so the same stalled reply cannot re-nudge without a new Codex boundary', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const lastMessage = 'Keep going and finish the cleanup from here.';

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0, ttlMs: 0 },
      });
      await writeManagedSessionState(stateDir, cwd);
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const first = runNotifyHook(cwd, fakeBinDir, codexHome, {
        type: 'agent-turn-complete',
        'turn-id': 'turn-complete-1',
        'last-assistant-message': lastMessage,
      });
      assert.equal(first.status, 0, `first hook failed: ${first.stderr || first.stdout}`);

      const second = runNotifyHook(cwd, fakeBinDir, codexHome, {
        type: 'function_call_output',
        'turn-id': 'function-call-output-1',
        'last-assistant-message': lastMessage,
      });
      assert.equal(second.status, 0, `second hook failed: ${second.stderr || second.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.equal((tmuxLog.match(new RegExp(defaultAutoNudgePattern('%99').source, 'g')) || []).length, 1);

      const hudState = JSON.parse(await readFile(join(sessionStateDir, 'hud-state.json'), 'utf-8'));
      assert.equal(hudState.turn_count, 1);

      const nudgeState = JSON.parse(await readFile(join(sessionStateDir, 'auto-nudge-state.json'), 'utf-8'));
      assert.equal(nudgeState.nudgeCount, 1);
      assert.match(nudgeState.lastSignature, /^hud:1\|.*\|stall:proceed_intent$/);
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
        'last-assistant-message': 'Keep going and implement this feature.',
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
      await writeManagedSessionState(stateDir, cwd);
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      await mkdir(sessionStateDir, { recursive: true });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Keep going and finish the focused cleanup.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const nudgeStatePath = join(sessionStateDir, 'auto-nudge-state.json');
      assert.ok(existsSync(nudgeStatePath), 'auto-nudge-state.json should be created');
      const nudgeState = JSON.parse(await readFile(nudgeStatePath, 'utf-8'));
      assert.equal(nudgeState.nudgeCount, 1, 'nudge count should be 1');
      assert.ok(nudgeState.lastNudgeAt, 'should have lastNudgeAt timestamp');
    });
  });

  it('does not reactivate completed autopilot from terminal turn replay', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      const terminalCompletedAt = '2026-05-31T20:24:39.005Z';

      await mkdir(logsDir, { recursive: true });
      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });
      await writeManagedSessionState(stateDir, cwd);
      await writeJson(join(sessionStateDir, 'autopilot-state.json'), {
        mode: 'autopilot',
        active: false,
        current_phase: 'complete',
        completed_at: terminalCompletedAt,
        stop_reason: 'completed',
        session_id: 'sess-managed',
        thread_id: 'thread-autopilot-complete',
        turn_id: 'turn-autopilot-complete',
        iteration: 7,
        max_iterations: 10,
        review_cycle: 1,
      });
      await writeJson(join(sessionStateDir, 'skill-active-state.json'), {
        version: 1,
        active: false,
        skill: 'autopilot',
        keyword: '$autopilot',
        phase: 'completing',
        activated_at: '2026-05-31T19:28:04.651Z',
        updated_at: terminalCompletedAt,
        source: 'keyword-detector',
        session_id: 'sess-managed',
        thread_id: 'thread-autopilot-complete',
        turn_id: 'turn-autopilot-complete',
        active_skills: [],
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(join(cwd, 'tmux.log')));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        type: 'agent-turn-complete',
        'thread-id': 'thread-autopilot-complete',
        'turn-id': 'turn-autopilot-complete',
        'input-messages': ['$autopilot .omx/specs/hermes-intake-librarian-subagent-mcp.md'],
        'last-assistant-message': 'Autopilot complete. Committed:\n- 93302d4b2 enable profile-scoped MCP delegation without leaking tools',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const autopilotState = JSON.parse(await readFile(join(sessionStateDir, 'autopilot-state.json'), 'utf-8')) as {
        active: boolean;
        current_phase: string;
        completed_at?: string;
        started_at?: string;
        iteration?: number;
      };
      assert.equal(autopilotState.active, false);
      assert.equal(autopilotState.current_phase, 'complete');
      assert.equal(autopilotState.completed_at, terminalCompletedAt);
      assert.equal(autopilotState.started_at, undefined);
      assert.equal(autopilotState.iteration, 7);

      const skillState = JSON.parse(await readFile(join(sessionStateDir, 'skill-active-state.json'), 'utf-8')) as {
        active: boolean;
        phase: string;
        active_skills?: unknown[];
      };
      assert.equal(skillState.active, false);
      assert.equal(skillState.phase, 'completing');
      assert.equal(skillState.active_skills?.length ?? 0, 0);
    });
  });

  it('does not reactivate completed autopilot from canonical terminal replay wording', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      const terminalCompletedAt = '2026-05-31T20:24:39.005Z';

      await mkdir(logsDir, { recursive: true });
      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });
      await writeManagedSessionState(stateDir, cwd);
      await writeJson(join(sessionStateDir, 'autopilot-state.json'), {
        mode: 'autopilot',
        active: false,
        current_phase: 'complete',
        completed_at: terminalCompletedAt,
        thread_id: 'thread-autopilot-complete',
        turn_id: 'turn-autopilot-complete',
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(join(cwd, 'tmux.log')));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        type: 'agent-turn-complete',
        'thread-id': 'thread-autopilot-complete',
        'turn-id': 'turn-autopilot-complete',
        'input-messages': ['autopilot mode'],
        'last-assistant-message': 'Autopilot completed successfully.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const autopilotState = JSON.parse(await readFile(join(sessionStateDir, 'autopilot-state.json'), 'utf-8')) as {
        active: boolean;
        current_phase: string;
        completed_at?: string;
      };
      assert.equal(autopilotState.active, false);
      assert.equal(autopilotState.current_phase, 'complete');
      assert.equal(autopilotState.completed_at, terminalCompletedAt);
    });
  });

  it('does not reactivate completed autopilot from registry-alias terminal replay', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      const terminalCompletedAt = '2026-05-31T20:24:39.005Z';

      await mkdir(logsDir, { recursive: true });
      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });
      await writeManagedSessionState(stateDir, cwd);
      await writeJson(join(sessionStateDir, 'autopilot-state.json'), {
        mode: 'autopilot',
        active: false,
        current_phase: 'complete',
        completed_at: terminalCompletedAt,
        thread_id: 'thread-autopilot-complete',
        turn_id: 'turn-autopilot-complete',
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(join(cwd, 'tmux.log')));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        type: 'agent-turn-complete',
        'thread-id': 'thread-autopilot-complete',
        'turn-id': 'turn-autopilot-complete',
        'input-messages': ['build me a terminal replay regression guard'],
        'last-assistant-message': 'Autopilot complete. Regression guard shipped.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const autopilotState = JSON.parse(await readFile(join(sessionStateDir, 'autopilot-state.json'), 'utf-8')) as {
        active: boolean;
        current_phase: string;
        completed_at?: string;
      };
      assert.equal(autopilotState.active, false);
      assert.equal(autopilotState.current_phase, 'complete');
      assert.equal(autopilotState.completed_at, terminalCompletedAt);
    });
  });

  it('allows a later autopilot prompt after completed autopilot state', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');

      await mkdir(logsDir, { recursive: true });
      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });
      await writeManagedSessionState(stateDir, cwd);
      await writeJson(join(sessionStateDir, 'autopilot-state.json'), {
        mode: 'autopilot',
        active: false,
        current_phase: 'complete',
        completed_at: '2026-05-31T20:24:39.005Z',
        thread_id: 'thread-autopilot-complete',
        turn_id: 'turn-autopilot-complete',
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(join(cwd, 'tmux.log')));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        type: 'agent-turn-complete',
        'thread-id': 'thread-autopilot-complete',
        'turn-id': 'turn-later-autopilot-start',
        'input-messages': ['$autopilot .omx/specs/next-task.md'],
        'last-assistant-message': 'Autopilot complete replay text from a different turn should not suppress this activation.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const autopilotState = JSON.parse(await readFile(join(sessionStateDir, 'autopilot-state.json'), 'utf-8')) as {
        active: boolean;
        current_phase: string;
        completed_at?: string;
        turn_id?: string;
      };
      assert.equal(autopilotState.active, true);
      assert.equal(autopilotState.current_phase, 'deep-interview');
      assert.equal(autopilotState.completed_at, undefined);
      assert.equal(autopilotState.turn_id, 'turn-later-autopilot-start');
    });
  });

  it('shares immutable classification across the terminal replay activation matrix', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-notify-replay-matrix';
      const sessionStateDir = join(stateDir, 'sessions', sessionId);
      const terminalThreadId = 'thread-autopilot-complete';
      const terminalTurnId = 'turn-autopilot-complete';
      const terminalPayload = {
        type: 'agent-turn-complete',
        'thread-id': terminalThreadId,
        'turn-id': terminalTurnId,
        'last-assistant-message': 'Autopilot complete.',
      };

      await mkdir(sessionStateDir, { recursive: true });
      await writeJson(join(sessionStateDir, 'autopilot-state.json'), {
        mode: 'autopilot',
        active: false,
        current_phase: 'complete',
        completed_at: '2026-05-31T20:24:39.005Z',
        session_id: sessionId,
        thread_id: terminalThreadId,
        turn_id: terminalTurnId,
      });
      const terminalAutopilotStatePath = join(sessionStateDir, 'autopilot-state.json');
      const terminalSessionSkillStatePath = join(sessionStateDir, 'skill-active-state.json');
      const terminalRootSkillStatePath = join(stateDir, 'skill-active-state.json');


      for (const text of ['$autopilot replay task café\r\n', 'autopilot mode — replay café']) {
        const bytesBefore = Buffer.from(text, 'utf8');
        const terminalStateBefore = await readFile(terminalAutopilotStatePath);

        let classifierCalls = 0;
        let classifierText = '';
        let writerCalls = 0;
        const result = await recordNotifySkillActivation({
          stateDir,
          sourceCwd: cwd,
          text,
          sessionId,
          threadId: terminalThreadId,
          turnId: terminalTurnId,
          payload: terminalPayload,
        }, {
          classifyKeywordInput: (input) => {
            classifierCalls += 1;
            classifierText = input;
            return classifyKeywordInput(input);
          },
          recordSkillActivation: async () => {
            writerCalls += 1;
            return null;
          },
        });

        assert.equal(classifierCalls, 1, 'notify should classify each latest input once');
        assert.equal(writerCalls, 0, 'same-turn terminal replay must not reach the writer');
        assert.equal(result, null);
        assert.deepEqual(Buffer.from(classifierText, 'utf8'), bytesBefore, 'classifier must receive the original input bytes');
        assert.deepEqual(await readFile(terminalAutopilotStatePath), terminalStateBefore, 'same-turn replay must preserve terminal detail bytes');
        assert.equal(existsSync(terminalSessionSkillStatePath), false, 'same-turn replay must not create session canonical state');
        assert.equal(existsSync(terminalRootSkillStatePath), false, 'same-turn replay must not create root canonical state');
      }

      const markedSessionId = 'sess-notify-terminal-marked-answer';
      const markedThreadId = 'thread-notify-terminal-marked-answer';
      const markedTurnId = 'turn-notify-terminal-marked-answer';
      const markedSessionDir = join(stateDir, 'sessions', markedSessionId);
      const markedSkillPath = join(markedSessionDir, 'skill-active-state.json');
      const markedDetailPath = join(markedSessionDir, 'autopilot-state.json');
      await mkdir(markedSessionDir, { recursive: true });
      await writeJson(markedSkillPath, {
        version: 1,
        active: true,
        skill: 'autopilot',
        keyword: '$autopilot',
        phase: 'completing',
        activated_at: '2026-05-31T20:24:39.005Z',
        updated_at: '2026-05-31T20:24:39.005Z',
        session_id: markedSessionId,
        active_skills: [{ skill: 'autopilot', phase: 'completing', active: true, session_id: markedSessionId }],
      });
      await writeJson(markedDetailPath, {
        mode: 'autopilot',
        active: false,
        current_phase: 'complete',
        completed_at: '2026-05-31T20:24:39.005Z',
        session_id: markedSessionId,
      });
      const markedSkillBefore = await readFile(markedSkillPath);
      const markedDetailBefore = await readFile(markedDetailPath);
      let markedWriterCalls = 0;
      const markedResult = await recordNotifySkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: '[omx question answered] yes',
        sessionId: markedSessionId,
        threadId: markedThreadId,
        turnId: markedTurnId,
        payload: {
          type: 'agent-turn-complete',
          'thread-id': markedThreadId,
          'turn-id': markedTurnId,
          'last-assistant-message': 'Autopilot complete.',
        },
      }, {
        recordSkillActivation: async (input) => {
          markedWriterCalls += 1;
          return recordSkillActivation(input);
        },
      });
      assert.equal(markedWriterCalls, 1);
      assert.equal(markedResult, null);
      assert.deepEqual(await readFile(markedSkillPath), markedSkillBefore);
      assert.deepEqual(await readFile(markedDetailPath), markedDetailBefore);

      for (const orderedCase of [
        { text: '$ralplan $autopilot plan this change', skill: 'ralplan' },
        { text: '$ralph $autopilot ship this change', skill: 'ralph' },
      ]) {
        const orderedSessionId = `sess-notify-primary-${orderedCase.skill}`;
        const orderedThreadId = `thread-notify-primary-${orderedCase.skill}`;
        const orderedTurnId = `turn-notify-primary-${orderedCase.skill}`;
        const orderedSessionDir = join(stateDir, 'sessions', orderedSessionId);
        await mkdir(orderedSessionDir, { recursive: true });
        await writeJson(join(orderedSessionDir, 'autopilot-state.json'), {
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          completed_at: '2026-05-31T20:24:39.005Z',
          session_id: orderedSessionId,
          thread_id: orderedThreadId,
          turn_id: orderedTurnId,
        });
        const orderedAutopilotPath = join(orderedSessionDir, 'autopilot-state.json');
        const orderedAutopilotBefore = await readFile(orderedAutopilotPath);
        await writeJson(join(orderedSessionDir, 'skill-active-state.json'), {
          version: 1,
          active: true,
          skill: 'autopilot',
          keyword: '$autopilot',
          phase: 'completing',
          activated_at: '2026-05-31T20:24:39.005Z',
          updated_at: '2026-05-31T20:24:39.005Z',
          session_id: orderedSessionId,
          thread_id: orderedThreadId,
          turn_id: orderedTurnId,
          active_skills: [{
            skill: 'autopilot',
            phase: 'completing',
            active: true,
            session_id: orderedSessionId,
            thread_id: orderedThreadId,
            turn_id: orderedTurnId,
          }],
        });
        let orderedWriterCalls = 0;
        const orderedResult = await recordNotifySkillActivation({
          stateDir,
          sourceCwd: cwd,
          text: orderedCase.text,
          sessionId: orderedSessionId,
          threadId: orderedThreadId,
          turnId: orderedTurnId,
          payload: {
            type: 'agent-turn-complete',
            'thread-id': orderedThreadId,
            'turn-id': orderedTurnId,
            'last-assistant-message': 'Autopilot complete.',
          },
        }, {
          recordSkillActivation: async (input) => {
            orderedWriterCalls += 1;
            return recordSkillActivation(input);
          },
        });

        assert.equal(orderedWriterCalls, 1, `leading ${orderedCase.skill} must reach the writer`);
        assert.equal(orderedResult?.skill, orderedCase.skill, orderedCase.text);
        assert.equal(orderedResult?.active, true, orderedCase.text);
        assert.equal(existsSync(join(orderedSessionDir, 'skill-active-state.json')), true, orderedCase.text);
        assert.equal(orderedResult?.active_skills?.some((entry) => entry.skill === 'autopilot'), false, orderedCase.text);
        assert.deepEqual(await readFile(orderedAutopilotPath), orderedAutopilotBefore, orderedCase.text);
      }

      const filteredSessionId = 'sess-notify-disabled-team-terminal-autopilot';
      const filteredThreadId = 'thread-notify-disabled-team-terminal-autopilot';
      const filteredTurnId = 'turn-notify-disabled-team-terminal-autopilot';
      const filteredSessionDir = join(stateDir, 'sessions', filteredSessionId);
      const filteredAutopilotPath = join(filteredSessionDir, 'autopilot-state.json');
      await mkdir(filteredSessionDir, { recursive: true });
      await writeJson(filteredAutopilotPath, {
        mode: 'autopilot',
        active: false,
        current_phase: 'complete',
        completed_at: '2026-05-31T20:24:39.005Z',
        session_id: filteredSessionId,
        thread_id: filteredThreadId,
        turn_id: filteredTurnId,
      });
      const filteredAutopilotBefore = await readFile(filteredAutopilotPath);
      const previousTeamMode = process.env.OMX_TEAM_MODE;
      process.env.OMX_TEAM_MODE = 'disabled';
      try {
        const filteredResult = await recordNotifySkillActivation({
          stateDir,
          sourceCwd: cwd,
          text: '$team $autopilot retry',
          sessionId: filteredSessionId,
          threadId: filteredThreadId,
          turnId: filteredTurnId,
          payload: {
            type: 'agent-turn-complete',
            'thread-id': filteredThreadId,
            'turn-id': filteredTurnId,
            'last-assistant-message': 'Autopilot complete.',
          },
        });
        assert.equal(filteredResult, null);
        assert.deepEqual(await readFile(filteredAutopilotPath), filteredAutopilotBefore);
        assert.equal(existsSync(join(filteredSessionDir, 'skill-active-state.json')), false);
        assert.equal(existsSync(join(stateDir, 'skill-active-state.json')), false);
      } finally {
        if (previousTeamMode === undefined) delete process.env.OMX_TEAM_MODE;
        else process.env.OMX_TEAM_MODE = previousTeamMode;
      }

      const restartText = '$autopilot new task — café';
      const restartBytes = Buffer.from(restartText, 'utf8');
      let restartClassification: ReturnType<typeof classifyKeywordInput> | undefined;
      let writerClassification: ReturnType<typeof classifyKeywordInput> | undefined;
      let writerResult: Awaited<ReturnType<typeof recordSkillActivation>> | undefined;
      let writerCalls = 0;
      let writerText = '';
      const restartResult = await recordNotifySkillActivation({
        stateDir,
        sourceCwd: cwd,
        text: restartText,
        sessionId,
        threadId: terminalThreadId,
        turnId: 'turn-autopilot-restart',
        payload: {
          ...terminalPayload,
          'turn-id': 'turn-autopilot-restart',
          'last-assistant-message': 'Autopilot complete text from a prior turn.',
        },
      }, {
        classifyKeywordInput: (input) => {
          restartClassification = classifyKeywordInput(input);
          return restartClassification;
        },
        recordSkillActivation: async (input) => {
          writerCalls += 1;
          writerText = input.text;
          writerClassification = input.classification;
          writerResult = await recordSkillActivation(input);
          return writerResult;
        },
      });

      assert.equal(writerCalls, 1, 'a different turn must reach the writer');
      assert.strictEqual(writerClassification, restartClassification, 'writer must receive the classifier object by identity');
      assert.strictEqual(restartResult, writerResult, 'notify must return the writer result unchanged');
      assert.deepEqual(Buffer.from(writerText, 'utf8'), restartBytes, 'writer must receive the original input bytes');
      const reactivatedAutopilot = JSON.parse(await readFile(join(sessionStateDir, 'autopilot-state.json'), 'utf-8')) as {
        active: boolean;
        current_phase: string;
        turn_id?: string;
      };
      assert.equal(reactivatedAutopilot.active, true);
      assert.equal(reactivatedAutopilot.current_phase, 'deep-interview');
      assert.equal(reactivatedAutopilot.turn_id, 'turn-autopilot-restart');

      const sessionSkillStatePath = join(sessionStateDir, 'skill-active-state.json');
      const autopilotStatePath = join(sessionStateDir, 'autopilot-state.json');
      const rootSkillStatePath = join(stateDir, 'skill-active-state.json');
      for (const [index, text] of ['do not start $autopilot — café', '"$autopilot" — quoted only'].entries()) {
        const bytesBefore = Buffer.from(text, 'utf8');
        const skillStateBefore = await readFile(sessionSkillStatePath);
        const autopilotStateBefore = await readFile(autopilotStatePath);
        let rejectedClassification: ReturnType<typeof classifyKeywordInput> | undefined;
        let rejectedWriterClassification: ReturnType<typeof classifyKeywordInput> | undefined;
        let rejectedWriterResult: Awaited<ReturnType<typeof recordSkillActivation>> | undefined;
        let rejectedWriterCalls = 0;
        let rejectedWriterText = '';
        const rejectedResult = await recordNotifySkillActivation({
          stateDir,
          sourceCwd: cwd,
          text,
          sessionId,
          threadId: terminalThreadId,
          turnId: `turn-rejected-${index}`,
          payload: {
            type: 'agent-turn-complete',
            'thread-id': terminalThreadId,
            'turn-id': `turn-rejected-${index}`,
            'last-assistant-message': 'Normal nonterminal reply.',
          },
        }, {
          classifyKeywordInput: (input) => {
            rejectedClassification = classifyKeywordInput(input);
            return rejectedClassification;
          },
          recordSkillActivation: async (input) => {
            rejectedWriterCalls += 1;
            rejectedWriterText = input.text;
            rejectedWriterClassification = input.classification;
            rejectedWriterResult = await recordSkillActivation(input);
            return rejectedWriterResult;
          },
        });

        assert.equal(rejectedWriterCalls, 1, 'rejected nonterminal text must still reach the real writer once');
        assert.strictEqual(rejectedResult, rejectedWriterResult, 'notify must return the real writer result unchanged');
        assert.equal(rejectedResult, null);
        assert.strictEqual(rejectedWriterClassification, rejectedClassification, 'rejected input must retain classification identity');
        assert.deepEqual(rejectedClassification?.matches, [], 'negated and quoted text must not activate a workflow');
        assert.deepEqual(Buffer.from(rejectedWriterText, 'utf8'), bytesBefore, 'writer must receive rejected input bytes unchanged');
        assert.deepEqual(await readFile(sessionSkillStatePath), skillStateBefore, 'rejected input must preserve canonical state bytes');
        assert.deepEqual(await readFile(autopilotStatePath), autopilotStateBefore, 'rejected input must preserve detail state bytes');
        assert.equal(existsSync(rootSkillStatePath), false, 'rejected session input must not create root canonical state');
      }
    });
  });

  it('G1a-N preserves ordered multi-skill classification and seeds only the ralplan primary when Team is enabled', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-g1a-notify-ordered';
      const threadId = 'thread-g1a-notify-ordered';
      const turnId = 'turn-g1a-notify-ordered';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const text = '$ralplan, $autopilot; $team';
      let classification: ReturnType<typeof classifyKeywordInput> | undefined;
      let writerClassification: ReturnType<typeof classifyKeywordInput> | undefined;
      let writerCalls = 0;
      const previousTeamMode = process.env.OMX_TEAM_MODE;
      process.env.OMX_TEAM_MODE = 'enabled';

      try {
        const result = await recordNotifySkillActivation({
          stateDir,
          sourceCwd: cwd,
          text,
          sessionId,
          threadId,
          turnId,
          payload: { type: 'agent-turn-complete', 'thread-id': threadId, 'turn-id': turnId },
        }, {
          classifyKeywordInput: (input) => {
            classification = classifyKeywordInput(input);
            return classification;
          },
          recordSkillActivation: async (input) => {
            writerCalls += 1;
            writerClassification = input.classification;
            return recordSkillActivation(input);
          },
        });

        assert.equal(writerCalls, 1);
        assert.strictEqual(writerClassification, classification, 'notify must pass the ordered classifier output to the writer');
        assert.deepEqual(classification?.matches.map((match) => match.skill), ['ralplan', 'autopilot', 'team']);
        assert.equal(result?.skill, 'ralplan');
        assert.deepEqual(result?.deferred_skills, ['autopilot', 'team']);
        assert.deepEqual(result?.active_skills?.map((entry) => entry.skill), ['ralplan']);
        assert.equal(existsSync(join(sessionDir, 'ralplan-state.json')), true);
        assert.equal(existsSync(join(sessionDir, 'autopilot-state.json')), false);
        assert.equal(existsSync(join(stateDir, 'team-state.json')), false);
      } finally {
        if (previousTeamMode === undefined) delete process.env.OMX_TEAM_MODE;
        else process.env.OMX_TEAM_MODE = previousTeamMode;
      }
    });
  });

  it('G1c-N deduplicates exact canonical and alias Autopilot invocations across classifier, writer, canonical state, and detail state', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-g1c-notify-duplicate';
      const threadId = 'thread-g1c-notify-duplicate';
      const turnId = 'turn-g1c-notify-duplicate';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const text = '$autopilot $oh-my-codex:autopilot build it';
      let classification: ReturnType<typeof classifyKeywordInput> | undefined;
      let writerClassification: ReturnType<typeof classifyKeywordInput> | undefined;
      let writerCalls = 0;

      const result = await recordNotifySkillActivation({
        stateDir,
        sourceCwd: cwd,
        text,
        sessionId,
        threadId,
        turnId,
        payload: { type: 'agent-turn-complete', 'thread-id': threadId, 'turn-id': turnId },
      }, {
        classifyKeywordInput: (input) => {
          classification = classifyKeywordInput(input);
          return classification;
        },
        recordSkillActivation: async (input) => {
          writerCalls += 1;
          writerClassification = input.classification;
          return recordSkillActivation(input);
        },
      });

      assert.equal(writerCalls, 1);
      assert.strictEqual(writerClassification, classification, 'writer must receive the deduplicated classifier output');
      assert.deepEqual(classification?.matches.map((match) => match.skill), ['autopilot']);
      assert.equal(result?.skill, 'autopilot');
      assert.deepEqual(result?.deferred_skills ?? [], []);
      assert.deepEqual(result?.active_skills?.map((entry) => entry.skill), ['autopilot']);
      const canonical = JSON.parse(await readFile(join(sessionDir, 'skill-active-state.json'), 'utf8')) as { active_skills?: Array<{ skill: string }> };
      assert.deepEqual(canonical.active_skills?.map((entry) => entry.skill), ['autopilot']);
      assert.equal(existsSync(join(sessionDir, 'autopilot-state.json')), true);
    });
  });

  // Notify Stop is N/A: it has no user-prompt activation transport to replay.

  it('G1b-N filters disabled Team before suppressing an exact same-turn terminal Autopilot replay without changing state bytes', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-g1b-notify-terminal';
      const threadId = 'thread-g1b-notify-terminal';
      const turnId = 'turn-g1b-notify-terminal';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const sessionSkillPath = join(sessionDir, 'skill-active-state.json');
      const sessionAutopilotPath = join(sessionDir, 'autopilot-state.json');
      const rootSkillPath = join(stateDir, 'skill-active-state.json');
      const rootAutopilotPath = join(stateDir, 'autopilot-state.json');
      const seededPaths = [sessionSkillPath, sessionAutopilotPath, rootSkillPath, rootAutopilotPath];

      await mkdir(sessionDir, { recursive: true });
      await writeJson(sessionSkillPath, {
        version: 1,
        active: true,
        skill: 'autopilot',
        keyword: '$autopilot',
        phase: 'completing',
        session_id: sessionId,
        thread_id: threadId,
        turn_id: turnId,
        active_skills: [{ skill: 'autopilot', phase: 'completing', active: true, session_id: sessionId, thread_id: threadId, turn_id: turnId }],
      });
      await writeJson(sessionAutopilotPath, {
        mode: 'autopilot',
        active: false,
        current_phase: 'complete',
        completed_at: '2026-05-31T20:24:39.005Z',
        session_id: sessionId,
        thread_id: threadId,
        turn_id: turnId,
      });
      await writeJson(rootSkillPath, {
        version: 1,
        active: true,
        skill: 'autopilot',
        keyword: '$autopilot',
        phase: 'completing',
        scope: 'root-copy',
        session_id: sessionId,
        thread_id: threadId,
        turn_id: turnId,
      });
      await writeJson(rootAutopilotPath, {
        mode: 'autopilot',
        active: false,
        current_phase: 'complete',
        completed_at: '2026-05-31T20:24:39.005Z',
        scope: 'root-copy',
        session_id: sessionId,
        thread_id: threadId,
        turn_id: turnId,
      });
      const bytesBefore = new Map(await Promise.all(seededPaths.map(async (path) => [path, await readFile(path)] as const)));

      const previousTeamMode = process.env.OMX_TEAM_MODE;
      process.env.OMX_TEAM_MODE = 'disabled';
      try {
        let classification: ReturnType<typeof classifyKeywordInput> | undefined;
        let writerCalls = 0;
        const result = await recordNotifySkillActivation({
          stateDir,
          sourceCwd: cwd,
          text: '$team $autopilot retry',
          sessionId,
          threadId,
          turnId,
          payload: {
            type: 'agent-turn-complete',
            'thread-id': threadId,
            'turn-id': turnId,
            'last-assistant-message': 'Autopilot complete.',
          },
        }, {
          classifyKeywordInput: (text) => {
            classification = classifyKeywordInput(text);
            return classification;
          },
          recordSkillActivation: async () => {
            writerCalls += 1;
            return null;
          },
        });

        assert.deepEqual(classification?.matches.map((match) => match.skill), ['team', 'autopilot'], 'the source classification must retain Team before runtime filtering');
        assert.equal(writerCalls, 0, 'disabled Team filtering must expose the same-turn terminal Autopilot replay for suppression');
        assert.equal(result, null);
        for (const path of seededPaths) {
          assert.deepEqual(await readFile(path), bytesBefore.get(path), `same-turn notify replay must preserve ${path} byte-for-byte`);
        }
      } finally {
        if (previousTeamMode === undefined) delete process.env.OMX_TEAM_MODE;
        else process.env.OMX_TEAM_MODE = previousTeamMode;
      }
    });
  });

  it('G2a sends the exact stale predecessor prompt through the shared classification and writer boundary without state', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, 'isolated-g2a-state-root');
      const sessionId = 'sess-g2a-stale-predecessor';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const rootSkillPath = join(stateDir, 'skill-active-state.json');
      const sessionSkillPath = join(sessionDir, 'skill-active-state.json');
      const rootRalplanPath = join(stateDir, 'ralplan-state.json');
      const sessionRalplanPath = join(sessionDir, 'ralplan-state.json');
      const text = 'use $ralplan is the consensus-planning command';
      const textBytes = Buffer.from(text, 'utf8');
      let classification: ReturnType<typeof classifyKeywordInput> | undefined;
      let writerClassification: ReturnType<typeof classifyKeywordInput> | undefined;
      let writerText = '';
      let writerCalls = 0;

      const result = await recordNotifySkillActivation({
        stateDir,
        sourceCwd: cwd,
        text,
        sessionId,
        threadId: 'thread-g2a-stale-predecessor',
        turnId: 'turn-g2a-stale-predecessor',
        payload: { type: 'agent-turn-complete' },
      }, {
        classifyKeywordInput: (input) => {
          classification = classifyKeywordInput(input);
          return classification;
        },
        recordSkillActivation: async (input) => {
          writerCalls += 1;
          writerText = input.text;
          writerClassification = input.classification;
          return recordSkillActivation(input);
        },
      });

      assert.equal(writerCalls, 1, 'notify must invoke the shared writer boundary once');
      assert.strictEqual(writerClassification, classification, 'notify must pass the original classification object to the writer');
      assert.deepEqual(Buffer.from(writerText, 'utf8'), textBytes, 'notify must pass the stale predecessor bytes unchanged');
      assert.deepEqual(classification?.matches, [], 'the stale predecessor wording must not activate ralplan');
      assert.equal(result, null);
      assert.equal(existsSync(stateDir), false, 'the stale predecessor wording must not create isolated state');
      assert.equal(existsSync(rootSkillPath), false, 'the stale predecessor wording must not create root canonical state');
      assert.equal(existsSync(sessionSkillPath), false, 'the stale predecessor wording must not create session canonical state');
      assert.equal(existsSync(rootRalplanPath), false, 'the stale predecessor wording must not create root ralplan detail state');
      assert.equal(existsSync(sessionRalplanPath), false, 'the stale predecessor wording must not create session ralplan detail state');
    });
  });

  it('G2b-N preserves five distinct terminal state files for the exact negated notify prompt without a fabricated Stop signal', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-g2b-negated-terminal';
      const threadId = 'thread-g2b-negated-terminal';
      const turnId = 'turn-g2b-negated-terminal';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const sessionJsonPath = join(stateDir, 'session.json');
      const rootSkillPath = join(stateDir, 'skill-active-state.json');
      const rootAutopilotPath = join(stateDir, 'autopilot-state.json');
      const sessionSkillPath = join(sessionDir, 'skill-active-state.json');
      const sessionAutopilotPath = join(sessionDir, 'autopilot-state.json');
      const seededPaths = [sessionJsonPath, rootSkillPath, rootAutopilotPath, sessionSkillPath, sessionAutopilotPath];
      const terminalBytes = [
        Buffer.from(`{\n  "session_id": "${sessionId}",\n  "started_at": "2026-06-01T00:00:01.001Z",\n  "turn_id": "turn-g2b-session-pointer"\n}\n`),
        Buffer.from(`{\n  "version": 1,\n  "active": true,\n  "skill": "autopilot",\n  "phase": "completing",\n  "updated_at": "2026-06-01T00:00:02.002Z",\n  "turn_id": "turn-g2b-root-skill"\n}\n`),
        Buffer.from(`{\n  "mode": "autopilot",\n  "active": false,\n  "current_phase": "complete",\n  "completed_at": "2026-06-01T00:00:03.003Z",\n  "turn_id": "turn-g2b-root-detail"\n}\n`),
        Buffer.from(`{\n  "version": 1,\n  "active": true,\n  "skill": "autopilot",\n  "phase": "completing",\n  "updated_at": "2026-06-01T00:00:04.004Z",\n  "turn_id": "turn-g2b-session-skill"\n}\n`),
        Buffer.from(`{\n  "mode": "autopilot",\n  "active": false,\n  "current_phase": "complete",\n  "completed_at": "2026-06-01T00:00:05.005Z",\n  "turn_id": "turn-g2b-session-detail"\n}\n`),
      ];

      await mkdir(sessionDir, { recursive: true });
      await Promise.all(seededPaths.map((path, index) => writeFile(path, terminalBytes[index]!)));
      const text = 'do not start $autopilot — café';
      const textBytes = Buffer.from(text, 'utf8');
      let classification: ReturnType<typeof classifyKeywordInput> | undefined;
      let writerClassification: ReturnType<typeof classifyKeywordInput> | undefined;
      let writerText = '';
      let writerCalls = 0;

      const result = await recordNotifySkillActivation({
        stateDir,
        sourceCwd: cwd,
        text,
        sessionId,
        threadId,
        turnId,
        payload: {
          type: 'agent-turn-complete',
          'thread-id': threadId,
          'turn-id': turnId,
        },
      }, {
        classifyKeywordInput: (input) => {
          classification = classifyKeywordInput(input);
          return classification;
        },
        recordSkillActivation: async (input) => {
          writerCalls += 1;
          writerText = input.text;
          writerClassification = input.classification;
          return recordSkillActivation(input);
        },
      });

      assert.equal(writerCalls, 1, 'the negated notify input must reach the shared writer boundary once');
      assert.strictEqual(writerClassification, classification, 'notify must retain classification identity for negated input');
      assert.deepEqual(Buffer.from(writerText, 'utf8'), textBytes, 'notify must retain the exact negated input bytes');
      assert.deepEqual(classification?.matches, [], 'the exact negated input must not restart Autopilot');
      assert.equal(result, null);
      for (const [index, path] of seededPaths.entries()) {
        assert.deepEqual(await readFile(path), terminalBytes[index], `negated notify input must preserve ${path} byte-for-byte`);
      }
    });
  });

  it('logs injected skill activation writer failures without failing the notify hook boundary', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const logsDir = join(cwd, '.omx', 'logs');
      const sessionId = 'sess-notify-writer-failure';
      const threadId = 'thread-notify-writer-failure';
      const turnId = 'turn-notify-writer-failure';
      let writerCalls = 0;

      await mkdir(logsDir, { recursive: true });
      const result = await recordNotifySkillActivationNonFatal({
        stateDir,
        sourceCwd: cwd,
        text: '$ralplan plan this change',
        sessionId,
        threadId,
        turnId,
        payload: { type: 'agent-turn-complete' },
      }, logsDir, {
        recordSkillActivation: async () => {
          writerCalls += 1;
          throw new Error(`injected writer failure ${'x'.repeat(1_000)}`);
        },
      });

      assert.equal(result, null);
      assert.equal(writerCalls, 1);
      const logPath = join(logsDir, `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const events = (await readFile(logPath, 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const failure = events.find((event) => event.type === 'notify_skill_activation_failure');
      assert.ok(failure);
      assert.equal(failure.level, 'warn');
      assert.equal(failure.session_id, sessionId);
      assert.equal(failure.thread_id, threadId);
      assert.equal(failure.turn_id, turnId);
      assert.match(String(failure.error), /^injected writer failure /);
      assert.ok(String(failure.error).length <= 512);
      assert.equal(Number.isNaN(Date.parse(String(failure.timestamp))), false);
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
      await writeManagedSessionState(stateDir, cwd);
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(join(cwd, 'tmux.log')));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'input-messages': ['$autopilot handle this task'],
        'last-assistant-message': 'Here is the plan I will follow.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const rootSkillStatePath = join(stateDir, 'skill-active-state.json');
      assert.equal(existsSync(rootSkillStatePath), false, 'session-scoped activation should not write root skill-active-state.json');
      const skillStatePath = join(sessionStateDir, 'skill-active-state.json');
      assert.ok(existsSync(skillStatePath), 'session skill-active-state.json should be created');
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
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%99'));
    });
  });


  it('disables auto-nudge when only skill-active-state carries the deep-interview input lock', async () => {
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
      await writeManagedSessionState(stateDir, cwd);
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      await mkdir(sessionStateDir, { recursive: true });
      await writeJson(join(sessionStateDir, 'skill-active-state.json'), {
        version: 1,
        active: true,
        skill: 'deep-interview',
        keyword: 'deep interview',
        phase: 'executing',
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

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
      assert.doesNotMatch(tmuxLog, defaultAutoNudgePattern('%99'));
    });
  });

  it('acquires the deep-interview input lock when deep-interview activates', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });
      await writeManagedSessionState(stateDir, cwd);

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(join(cwd, 'tmux.log')));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'input-messages': ['please run a deep interview first'],
        'last-assistant-message': 'Round 1 | Target: Goal Clarity',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      assert.equal(
        existsSync(join(stateDir, 'skill-active-state.json')),
        false,
        'session-scoped deep-interview activation should not write root skill-active-state.json',
      );
      const skillState = JSON.parse(await readFile(join(sessionStateDir, 'skill-active-state.json'), 'utf-8')) as {
        skill: string;
        input_lock?: { active: boolean; blocked_inputs: string[]; message: string };
      };
      assert.equal(skillState.skill, 'deep-interview');
      assert.equal(skillState.input_lock?.active, true);
      assert.deepEqual(skillState.input_lock?.blocked_inputs, DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS);
      assert.match(skillState.input_lock?.message || '', /Deep interview is active/i);

      const modeState = JSON.parse(await readFile(join(sessionStateDir, 'deep-interview-state.json'), 'utf-8')) as {
        active: boolean;
        mode: string;
        current_phase: string;
        input_lock?: { active: boolean };
      };
      assert.equal(modeState.active, true);
      assert.equal(modeState.mode, 'deep-interview');
      assert.equal(modeState.current_phase, 'intent-first');
      assert.equal(modeState.input_lock?.active, true);
    });
  });

  it('releases deep-interview mode state on normal completion without waiting for later keyword input', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(join(cwd, 'tmux.log')));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const activated = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'input-messages': ['please run a deep interview first'],
        'last-assistant-message': 'Round 1 | Target: Goal Clarity',
      });
      assert.equal(activated.status, 0, `activation hook failed: ${activated.stderr || activated.stdout}`);

      const completed = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'input-messages': ['continue'],
        'last-assistant-message': 'Interview completed. Final summary ready.',
      });
      assert.equal(completed.status, 0, `completion hook failed: ${completed.stderr || completed.stdout}`);

      const skillState = JSON.parse(await readFile(join(sessionStateDir, 'skill-active-state.json'), 'utf-8')) as {
        active: boolean;
        phase: string;
        input_lock?: { active: boolean; exit_reason?: string; released_at?: string };
      };
      assert.equal(skillState.active, false);
      assert.equal(skillState.phase, 'completing');
      assert.equal(skillState.input_lock?.active, false);
      assert.equal(skillState.input_lock?.exit_reason, 'success');
      assert.ok(skillState.input_lock?.released_at);

      const modeState = JSON.parse(await readFile(join(sessionStateDir, 'deep-interview-state.json'), 'utf-8')) as {
        active: boolean;
        current_phase: string;
        completed_at?: string;
        input_lock?: { active: boolean; exit_reason?: string; released_at?: string };
      };
      assert.equal(modeState.active, false);
      assert.equal(modeState.current_phase, 'completing');
      assert.ok(modeState.completed_at);
      assert.equal(modeState.input_lock?.active, false);
      assert.equal(modeState.input_lock?.exit_reason, 'success');
      assert.ok(modeState.input_lock?.released_at);
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
          'last-assistant-message': 'Keep going and finish the cleanup.',
        });
        assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /Deep interview is active; auto-approval shortcuts are blocked until the interview finishes\. \[OMX_TMUX_INJECT\]/);
        assert.equal(tmuxLog.includes(`send-keys -t %99 -l ${blockedResponse} [OMX_TMUX_INJECT]`), false);
      });
    });
  }

  it('suppresses deep-interview auto-approval without injecting tmux input', async () => {
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
        'last-assistant-message': 'Keep going and finish the cleanup.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(tmuxLog, /send-keys -t %99 -l Deep interview is active; auto-approval shortcuts are blocked until the interview finishes\. \[OMX_TMUX_INJECT\]/);
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

  it('allows non-blocked custom deep-interview auto-nudge responses to continue', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const capturePath = join(cwd, 'capture.txt');
      const customResponse = 'advance with the next interview question';
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0, response: customResponse },
      });
      await writeManagedSessionState(stateDir, cwd);
      await mkdir(sessionStateDir, { recursive: true });
      await writeJson(join(sessionStateDir, 'skill-active-state.json'), {
        version: 1,
        active: true,
        skill: 'deep-interview',
        keyword: 'deep interview',
        phase: 'executing',
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
      await writeFile(capturePath, 'OpenAI Codex\n› ');

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Keep going and finish the cleanup.',
      }, {
        OMX_TEST_CAPTURE_FILE: capturePath,
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(
        tmuxLog,
        new RegExp(`send-keys -t %99 -l ${customResponse} \\[OMX_TMUX_INJECT\\]`),
        'should allow a non-blocked continuation response during deep interview',
      );
    });
  });

  it('keeps autoresearch active when assistant claims completion without validator evidence', async () => {
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
      await writeManagedSessionState(stateDir, cwd);
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      await mkdir(sessionStateDir, { recursive: true });
      await writeJson(join(sessionStateDir, 'skill-active-state.json'), {
        active: true,
        skill: 'autoresearch',
        keyword: '$autoresearch',
        phase: 'executing',
        source: 'keyword-detector',
        session_id: 'sess-managed',
        owner_codex_session_id: 'sess-managed',
      });
      await writeJson(join(sessionStateDir, 'autoresearch-state.json'), {
        active: true,
        mode: 'autoresearch',
        current_phase: 'executing',
        session_id: 'sess-managed',
        owner_codex_session_id: 'sess-managed',
        validation_mode: 'mission-validator-script',
        mission_validator_command: 'node scripts/validate.js',
        completion_artifact_path: '.omx/specs/autoresearch-demo/completion.json',
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'All tests pass. Completed with summary.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const skillState = JSON.parse(await readFile(join(sessionStateDir, 'skill-active-state.json'), 'utf-8')) as {
        active: boolean;
        phase: string;
        autoresearch_completion_reason?: string;
      };
      assert.equal(skillState.active, true);
      assert.equal(skillState.phase, 'executing');
      assert.equal(skillState.autoresearch_completion_reason, 'missing_or_invalid_completion_artifact');
    });
  });

  it('completes autoresearch when validator artifact passes', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const codexHome = join(cwd, 'codex-home');
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');
      const specDir = join(cwd, '.omx', 'specs', 'autoresearch-demo');

      await mkdir(logsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await mkdir(specDir, { recursive: true });
      await writeJson(join(codexHome, '.omx-config.json'), {
        autoNudge: { enabled: true, delaySec: 0, stallMs: 0 },
      });
      await writeManagedSessionState(stateDir, cwd);
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      await mkdir(sessionStateDir, { recursive: true });
      await writeJson(join(sessionStateDir, 'skill-active-state.json'), {
        active: true,
        skill: 'autoresearch',
        keyword: '$autoresearch',
        phase: 'reviewing',
        source: 'keyword-detector',
        session_id: 'sess-managed',
        owner_codex_session_id: 'sess-managed',
      });
      await writeJson(join(sessionStateDir, 'autoresearch-state.json'), {
        active: true,
        mode: 'autoresearch',
        current_phase: 'reviewing',
        session_id: 'sess-managed',
        owner_codex_session_id: 'sess-managed',
        validation_mode: 'mission-validator-script',
        mission_validator_command: 'node scripts/validate.js',
        completion_artifact_path: '.omx/specs/autoresearch-demo/completion.json',
      });
      await writeJson(join(specDir, 'completion.json'), {
        status: 'passed',
        passed: true,
      });

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Completed with final summary after validator pass.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const skillState = JSON.parse(await readFile(join(sessionStateDir, 'skill-active-state.json'), 'utf-8')) as {
        active: boolean;
        phase: string;
        autoresearch_completion_reason?: string;
      };
      assert.equal(skillState.active, false);
      assert.equal(skillState.phase, 'completing');
      assert.equal(skillState.autoresearch_completion_reason, 'validator_passed');
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
      await writeManagedSessionState(stateDir, cwd);
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      await mkdir(sessionStateDir, { recursive: true });
      await writeJson(join(sessionStateDir, 'skill-active-state.json'), {
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

      const skillState = JSON.parse(await readFile(join(sessionStateDir, 'skill-active-state.json'), 'utf-8')) as {
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

  it('does not release deep-interview state from generic progress prose', async () => {
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
      await writeManagedSessionState(stateDir, cwd);
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      await mkdir(sessionStateDir, { recursive: true });
      await writeJson(join(sessionStateDir, 'skill-active-state.json'), {
        version: 1,
        active: true,
        skill: 'deep-interview',
        keyword: 'deep interview',
        phase: 'executing',
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
      await writeJson(join(sessionStateDir, 'deep-interview-state.json'), {
        active: true,
        mode: 'deep-interview',
        current_phase: 'intent-first',
        started_at: '2026-02-25T00:00:00.000Z',
        updated_at: '2026-02-25T00:00:00.000Z',
      });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(join(cwd, 'tmux.log')));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'Summary so far: done with the first round of questions.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      const skillState = JSON.parse(await readFile(join(sessionStateDir, 'skill-active-state.json'), 'utf-8')) as {
        active: boolean;
        phase: string;
        input_lock?: { active: boolean; released_at?: string; exit_reason?: string };
      };
      assert.equal(skillState.active, true);
      assert.notEqual(skillState.phase, 'completing');
      assert.equal(skillState.input_lock?.active, true);
      assert.equal(skillState.input_lock?.released_at || '', '');
      assert.equal(skillState.input_lock?.exit_reason || '', '');

      const modeState = JSON.parse(await readFile(join(sessionStateDir, 'deep-interview-state.json'), 'utf-8')) as {
        active: boolean;
        current_phase: string;
        completed_at?: string;
      };
      assert.equal(modeState.active, true);
      assert.equal(modeState.current_phase, 'intent-first');
      assert.equal(modeState.completed_at || '', '');
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
      await writeManagedSessionState(stateDir, cwd);
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      await mkdir(sessionStateDir, { recursive: true });
      await writeJson(join(sessionStateDir, 'skill-active-state.json'), {
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

      const skillState = JSON.parse(await readFile(join(sessionStateDir, 'skill-active-state.json'), 'utf-8')) as {
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
      await writeManagedSessionState(stateDir, cwd);
      const sessionStateDir = join(stateDir, 'sessions', 'sess-managed');
      await mkdir(sessionStateDir, { recursive: true });
      await writeJson(join(sessionStateDir, 'skill-active-state.json'), {
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

      const skillState = JSON.parse(await readFile(join(sessionStateDir, 'skill-active-state.json'), 'utf-8')) as {
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
        'last-assistant-message': 'Keep going and finish the focused cleanup.',
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
      assert.match(log2, defaultAutoNudgePattern('%99'), 'custom pattern should trigger nudge with marker');
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
        'last-assistant-message': 'Keep going and fix the remaining issues.',
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      assert.ok(existsSync(tmuxLogPath), 'tmux should be called with defaults');
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, defaultAutoNudgePattern('%99'), 'should nudge with default config and marker');
    });
  });

  it('can still resolve the managed session pane when TMUX_PANE is not set', async () => {
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
      await writeFile(captureFile, 'Here are the results.\nKeep going and finish the implementation.\n› ');

      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const result = runNotifyHook(cwd, fakeBinDir, codexHome, {
        'last-assistant-message': 'clean output with no stall',
      }, {
        TMUX_PANE: '',  // No pane available
        TMUX: '',
        OMX_TEST_CAPTURE_FILE: captureFile,
      });
      assert.equal(result.status, 0, `hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.match(tmuxLog, defaultAutoNudgePattern('%99'), 'should fall back to the managed session pane when TMUX_PANE is absent');
      }
    });
  });
});
