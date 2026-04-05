import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { reconcileRalphSessionResume } from '../../scripts/notify-hook/ralph-session-resume.js';

function notifyHookRepoRoot(): string {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return join(testDir, '..', '..', '..');
}

function runNotifyHook(
  payload: Record<string, unknown>,
  envOverrides: Record<string, string> = {},
) {
  return spawnSync(process.execPath, ['dist/scripts/notify-hook.js', JSON.stringify(payload)], {
    cwd: notifyHookRepoRoot(),
    encoding: 'utf-8',
    env: {
      ...process.env,
      OMX_TEAM_WORKER: '',
      TMUX: '',
      TMUX_PANE: '',
      ...envOverrides,
    },
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

function buildPayload(cwd: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cwd,
    type: 'agent-turn-complete',
    thread_id: 'thread-1',
    turn_id: 'turn-1',
    input_messages: [],
    last_assistant_message: 'continue',
    ...overrides,
  };
}

function buildResumeFakeTmux(currentPaneId: string, cwd: string, sessionName = 'devsess'): string {
  return `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
case "$cmd" in
  display-message)
    target=""
    format=""
    while (($#)); do
      case "$1" in
        -p) shift ;;
        -t) target="$2"; shift 2 ;;
        *) format="$1"; shift ;;
      esac
    done
    if [[ "$target" != "${currentPaneId}" ]]; then
      echo "bad display target: $target / $format" >&2
      exit 1
    fi
    case "$format" in
      '#{pane_current_command}') echo "node" ;;
      '#{pane_start_command}') echo "codex" ;;
      '#S') echo "${sessionName}" ;;
      '#{pane_in_mode}') echo "0" ;;
      '#{pane_current_path}') echo "${cwd}" ;;
      *) echo "bad display format: $format" >&2; exit 1 ;;
    esac
    ;;
  list-panes)
    echo "${currentPaneId}\t1\tcodex\tcodex"
    ;;
  capture-pane)
    printf "› ready\\n"
    ;;
  send-keys)
    ;;
  *)
    echo "unsupported cmd: $cmd" >&2
    exit 1
    ;;
esac
`;
}

async function setupTmuxFixture(wd: string, currentPaneId: string): Promise<Record<string, string>> {
  const fakeBinDir = join(wd, 'fake-bin');
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(join(fakeBinDir, 'tmux'), buildResumeFakeTmux(currentPaneId, wd));
  await chmod(join(fakeBinDir, 'tmux'), 0o755);
  return {
    PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
    TMUX_PANE: currentPaneId,
  };
}

async function withPatchedEnv<T>(
  overrides: Record<string, string>,
  run: () => Promise<T>,
): Promise<T> {
  const keys = Object.keys(overrides);
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    process.env[key] = overrides[key];
  }

  try {
    return await run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
  }
}

describe('notify-hook Ralph session resume', () => {
  it('resumes a matching prior Ralph into the current OMX session and rebinds the pane', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-ralph-resume-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const currentOmxSessionId = 'sess-current';
      const priorOmxSessionId = 'sess-prior';
      const currentSessionDir = join(stateDir, 'sessions', currentOmxSessionId);
      const priorSessionDir = join(stateDir, 'sessions', priorOmxSessionId);
      const currentPaneId = '%99';
      await writeJson(join(stateDir, 'session.json'), { session_id: currentOmxSessionId });
      await writeJson(join(priorSessionDir, 'ralph-state.json'), {
        active: true,
        iteration: 4,
        max_iterations: 10,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
        owner_omx_session_id: priorOmxSessionId,
        owner_codex_session_id: 'codex-session-1',
        tmux_pane_id: '%42',
      });

      const result = runNotifyHook(
        buildPayload(wd, {
          session_id: 'codex-session-1',
          thread_id: 'thread-resume-1',
          turn_id: 'turn-resume-1',
        }),
        await setupTmuxFixture(wd, currentPaneId),
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const currentState = JSON.parse(await readFile(join(currentSessionDir, 'ralph-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(currentState.active, true);
      assert.equal(currentState.iteration, 5);
      assert.equal(currentState.owner_omx_session_id, currentOmxSessionId);
      assert.equal(currentState.owner_codex_session_id, 'codex-session-1');
      assert.equal(currentState.tmux_pane_id, currentPaneId);

      const priorState = JSON.parse(await readFile(join(priorSessionDir, 'ralph-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(priorState.active, false);
      assert.equal(priorState.current_phase, 'cancelled');
      assert.equal(priorState.stop_reason, 'ownership_transferred');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rebinds the current pane for an already-active current-session Ralph state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-ralph-current-pane-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const currentOmxSessionId = 'sess-current';
      const priorOmxSessionId = 'sess-prior';
      const currentSessionDir = join(stateDir, 'sessions', currentOmxSessionId);
      const priorSessionDir = join(stateDir, 'sessions', priorOmxSessionId);
      const currentPaneId = '%77';
      await writeJson(join(stateDir, 'session.json'), { session_id: currentOmxSessionId });
      await writeJson(join(currentSessionDir, 'ralph-state.json'), {
        active: true,
        iteration: 4,
        max_iterations: 10,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
      });
      await writeJson(join(priorSessionDir, 'ralph-state.json'), {
        active: true,
        iteration: 9,
        max_iterations: 10,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
        owner_omx_session_id: priorOmxSessionId,
        owner_codex_session_id: 'codex-session-1',
        tmux_pane_id: '%42',
      });

      const result = runNotifyHook(
        buildPayload(wd, {
          session_id: 'codex-session-1',
          thread_id: 'thread-current-1',
          turn_id: 'turn-current-1',
        }),
        await setupTmuxFixture(wd, currentPaneId),
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const currentState = JSON.parse(await readFile(join(currentSessionDir, 'ralph-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(currentState.active, true);
      assert.equal(currentState.owner_omx_session_id, currentOmxSessionId);
      assert.equal(currentState.owner_codex_session_id, 'codex-session-1');
      assert.equal(currentState.tmux_pane_id, currentPaneId);
      assert.ok(typeof currentState.tmux_pane_set_at === 'string' && currentState.tmux_pane_set_at.length > 0);

      const priorState = JSON.parse(await readFile(join(priorSessionDir, 'ralph-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(priorState.active, true);
      assert.equal(priorState.iteration, 9);
      assert.equal(priorState.current_phase, 'executing');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves current-session legacy owner_codex_thread_id until owner_codex_session_id is available', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-ralph-current-legacy-owner-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const currentOmxSessionId = 'sess-current';
      const currentSessionDir = join(stateDir, 'sessions', currentOmxSessionId);
      const currentPaneId = '%79';
      await writeJson(join(stateDir, 'session.json'), { session_id: currentOmxSessionId });
      await writeJson(join(currentSessionDir, 'ralph-state.json'), {
        active: true,
        iteration: 4,
        max_iterations: 10,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
        owner_omx_session_id: currentOmxSessionId,
        owner_codex_thread_id: 'thread-current-legacy-1',
        tmux_pane_id: '%42',
      });

      const result = runNotifyHook(
        buildPayload(wd, {
          thread_id: 'thread-current-legacy-1',
          turn_id: 'turn-current-legacy-1',
        }),
        await setupTmuxFixture(wd, currentPaneId),
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const currentState = JSON.parse(await readFile(join(currentSessionDir, 'ralph-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(currentState.active, true);
      assert.equal(currentState.owner_omx_session_id, currentOmxSessionId);
      assert.equal(currentState.owner_codex_session_id, undefined);
      assert.equal(currentState.owner_codex_thread_id, 'thread-current-legacy-1');
      assert.equal(currentState.tmux_pane_id, currentPaneId);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('adopts a same-thread Ralph across OMX session turnover even when Codex session id is absent', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-ralph-thread-turnover-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const priorOmxSessionId = 'sess-prior';
      const currentOmxSessionId = 'sess-current';
      const priorSessionDir = join(stateDir, 'sessions', priorOmxSessionId);
      const currentSessionDir = join(stateDir, 'sessions', currentOmxSessionId);

      await writeJson(join(stateDir, 'session.json'), { session_id: priorOmxSessionId });
      await writeJson(join(priorSessionDir, 'ralph-state.json'), {
        active: true,
        iteration: 4,
        max_iterations: 10,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
        owner_omx_session_id: priorOmxSessionId,
        tmux_pane_id: '%42',
      });

      const firstResult = runNotifyHook(
        buildPayload(wd, {
          thread_id: 'thread-turnover-1',
          turn_id: 'turn-thread-turnover-prior-1',
        }),
        await setupTmuxFixture(wd, '%81'),
      );
      assert.equal(firstResult.status, 0, firstResult.stderr || firstResult.stdout);

      const updatedPriorState = JSON.parse(
        await readFile(join(priorSessionDir, 'ralph-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(updatedPriorState.active, true);
      assert.equal(updatedPriorState.iteration, 5);
      assert.equal(updatedPriorState.owner_codex_session_id, undefined);
      assert.equal(updatedPriorState.owner_codex_thread_id, 'thread-turnover-1');
      assert.equal(updatedPriorState.tmux_pane_id, '%81');

      await writeJson(join(stateDir, 'session.json'), { session_id: currentOmxSessionId });

      const secondResult = runNotifyHook(
        buildPayload(wd, {
          thread_id: 'thread-turnover-1',
          turn_id: 'turn-thread-turnover-current-1',
        }),
        await setupTmuxFixture(wd, '%82'),
      );
      assert.equal(secondResult.status, 0, secondResult.stderr || secondResult.stdout);

      const currentState = JSON.parse(
        await readFile(join(currentSessionDir, 'ralph-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(currentState.active, true);
      assert.equal(currentState.iteration, 6);
      assert.equal(currentState.owner_omx_session_id, currentOmxSessionId);
      assert.equal(currentState.owner_codex_session_id, undefined);
      assert.equal(currentState.owner_codex_thread_id, 'thread-turnover-1');
      assert.equal(currentState.tmux_pane_id, '%82');

      const priorState = JSON.parse(
        await readFile(join(priorSessionDir, 'ralph-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(priorState.active, false);
      assert.equal(priorState.current_phase, 'cancelled');
      assert.equal(priorState.stop_reason, 'ownership_transferred');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not auto-resume without a unique matching prior Ralph owner', async (t) => {
    const scenarios = [
      {
        name: 'payload session id does not match',
        payloadSessionId: 'codex-session-2',
        priorSessions: ['sess-prior'],
      },
      {
        name: 'multiple prior sessions match the same codex session',
        payloadSessionId: 'codex-session-1',
        priorSessions: ['sess-prior-a', 'sess-prior-b'],
      },
    ];

    for (const scenario of scenarios) {
      await t.test(scenario.name, async () => {
        const wd = await mkdtemp(join(tmpdir(), 'omx-notify-ralph-no-resume-'));
        try {
          const stateDir = join(wd, '.omx', 'state');
          const currentOmxSessionId = 'sess-current';
          const currentSessionDir = join(stateDir, 'sessions', currentOmxSessionId);
          await writeJson(join(stateDir, 'session.json'), { session_id: currentOmxSessionId });
          await mkdir(currentSessionDir, { recursive: true });

          for (const priorSessionId of scenario.priorSessions) {
            await writeJson(join(stateDir, 'sessions', priorSessionId, 'ralph-state.json'), {
              active: true,
              iteration: 4,
              max_iterations: 10,
              current_phase: 'executing',
              started_at: '2026-02-22T00:00:00.000Z',
              owner_omx_session_id: priorSessionId,
              owner_codex_session_id: 'codex-session-1',
            });
          }

          const result = runNotifyHook(buildPayload(wd, {
            session_id: scenario.payloadSessionId,
            thread_id: 'thread-no-resume',
            turn_id: 'turn-no-resume',
          }));
          assert.equal(result.status, 0, result.stderr || result.stdout);

          assert.equal(existsSync(join(currentSessionDir, 'ralph-state.json')), false);
          for (const priorSessionId of scenario.priorSessions) {
            const priorState = JSON.parse(
              await readFile(join(stateDir, 'sessions', priorSessionId, 'ralph-state.json'), 'utf-8'),
            ) as Record<string, unknown>;
            assert.equal(priorState.active, true);
            assert.equal(priorState.iteration, 4);
          }
        } finally {
          await rm(wd, { recursive: true, force: true });
        }
      });
    }
  });

  it('resumes a legacy prior Ralph that only tracks owner_codex_thread_id', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-ralph-thread-resume-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const currentOmxSessionId = 'sess-current';
      const priorOmxSessionId = 'sess-prior';
      const currentSessionDir = join(stateDir, 'sessions', currentOmxSessionId);
      const priorSessionDir = join(stateDir, 'sessions', priorOmxSessionId);
      const currentPaneId = '%55';
      await writeJson(join(stateDir, 'session.json'), { session_id: currentOmxSessionId });
      await writeJson(join(priorSessionDir, 'ralph-state.json'), {
        active: true,
        iteration: 4,
        max_iterations: 10,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
        owner_omx_session_id: priorOmxSessionId,
        owner_codex_thread_id: 'thread-legacy-1',
        tmux_pane_id: '%42',
      });

      const result = runNotifyHook(
        buildPayload(wd, {
          session_id: 'codex-session-1',
          thread_id: 'thread-legacy-1',
          turn_id: 'turn-legacy-1',
        }),
        await setupTmuxFixture(wd, currentPaneId),
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const currentState = JSON.parse(await readFile(join(currentSessionDir, 'ralph-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(currentState.active, true);
      assert.equal(currentState.iteration, 5);
      assert.equal(currentState.owner_omx_session_id, currentOmxSessionId);
      assert.equal(currentState.owner_codex_session_id, 'codex-session-1');
      assert.equal(currentState.owner_codex_thread_id, undefined);
      assert.equal(currentState.tmux_pane_id, currentPaneId);

      const priorState = JSON.parse(await readFile(join(priorSessionDir, 'ralph-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(priorState.active, false);
      assert.equal(priorState.current_phase, 'cancelled');
      assert.equal(priorState.stop_reason, 'ownership_transferred');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not fall back to owner_codex_thread_id when owner_codex_session_id is present and mismatched', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-ralph-session-precedence-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const currentOmxSessionId = 'sess-current';
      const priorOmxSessionId = 'sess-prior';
      const currentSessionDir = join(stateDir, 'sessions', currentOmxSessionId);
      const priorSessionDir = join(stateDir, 'sessions', priorOmxSessionId);
      await writeJson(join(stateDir, 'session.json'), { session_id: currentOmxSessionId });
      await mkdir(currentSessionDir, { recursive: true });
      await writeJson(join(priorSessionDir, 'ralph-state.json'), {
        active: true,
        iteration: 4,
        max_iterations: 10,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
        owner_omx_session_id: priorOmxSessionId,
        owner_codex_session_id: 'codex-session-other',
        owner_codex_thread_id: 'thread-shared-1',
      });

      const result = runNotifyHook(buildPayload(wd, {
        session_id: 'codex-session-1',
        thread_id: 'thread-shared-1',
        turn_id: 'turn-session-precedence-1',
      }));
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.equal(existsSync(join(currentSessionDir, 'ralph-state.json')), false);
      const priorState = JSON.parse(await readFile(join(priorSessionDir, 'ralph-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(priorState.active, true);
      assert.equal(priorState.iteration, 4);
      assert.equal(priorState.current_phase, 'executing');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not auto-resume a legacy Ralph when both source and payload thread ids are missing', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-ralph-empty-thread-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const currentOmxSessionId = 'sess-current';
      const priorOmxSessionId = 'sess-prior';
      const currentSessionDir = join(stateDir, 'sessions', currentOmxSessionId);
      const priorSessionDir = join(stateDir, 'sessions', priorOmxSessionId);
      await writeJson(join(stateDir, 'session.json'), { session_id: currentOmxSessionId });
      await mkdir(currentSessionDir, { recursive: true });
      await writeJson(join(priorSessionDir, 'ralph-state.json'), {
        active: true,
        iteration: 4,
        max_iterations: 10,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
        owner_omx_session_id: priorOmxSessionId,
      });

      const result = runNotifyHook(buildPayload(wd, {
        session_id: 'codex-session-1',
        turn_id: 'turn-empty-thread-1',
      }));
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.equal(existsSync(join(currentSessionDir, 'ralph-state.json')), false);
      const priorState = JSON.parse(await readFile(join(priorSessionDir, 'ralph-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(priorState.active, true);
      assert.equal(priorState.iteration, 4);
      assert.equal(priorState.current_phase, 'executing');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not auto-resume over an inactive current-session Ralph file', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-ralph-inactive-current-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const currentOmxSessionId = 'sess-current';
      const priorOmxSessionId = 'sess-prior';
      const currentSessionDir = join(stateDir, 'sessions', currentOmxSessionId);
      const priorSessionDir = join(stateDir, 'sessions', priorOmxSessionId);
      await writeJson(join(stateDir, 'session.json'), { session_id: currentOmxSessionId });
      await writeJson(join(currentSessionDir, 'ralph-state.json'), {
        active: false,
        iteration: 4,
        max_iterations: 10,
        current_phase: 'cancelled',
        started_at: '2026-02-22T00:00:00.000Z',
        completed_at: '2026-02-22T00:10:00.000Z',
        owner_omx_session_id: currentOmxSessionId,
      });
      await writeJson(join(priorSessionDir, 'ralph-state.json'), {
        active: true,
        iteration: 6,
        max_iterations: 10,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
        owner_omx_session_id: priorOmxSessionId,
        owner_codex_session_id: 'codex-session-1',
      });

      const result = runNotifyHook(buildPayload(wd, {
        session_id: 'codex-session-1',
        thread_id: 'thread-inactive-current-1',
        turn_id: 'turn-inactive-current-1',
      }));
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const currentState = JSON.parse(await readFile(join(currentSessionDir, 'ralph-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(currentState.active, false);
      assert.equal(currentState.current_phase, 'cancelled');
      assert.equal(currentState.owner_omx_session_id, currentOmxSessionId);

      const priorState = JSON.parse(await readFile(join(priorSessionDir, 'ralph-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(priorState.active, true);
      assert.equal(priorState.iteration, 6);
      assert.equal(priorState.current_phase, 'executing');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not auto-resume over an unreadable current-session Ralph file', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-ralph-unreadable-current-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const currentOmxSessionId = 'sess-current';
      const priorOmxSessionId = 'sess-prior';
      const currentSessionDir = join(stateDir, 'sessions', currentOmxSessionId);
      const priorSessionDir = join(stateDir, 'sessions', priorOmxSessionId);
      await writeJson(join(stateDir, 'session.json'), { session_id: currentOmxSessionId });
      await mkdir(currentSessionDir, { recursive: true });
      await writeFile(join(currentSessionDir, 'ralph-state.json'), '{ "active": true');
      await writeJson(join(priorSessionDir, 'ralph-state.json'), {
        active: true,
        iteration: 6,
        max_iterations: 10,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
        owner_omx_session_id: priorOmxSessionId,
        owner_codex_session_id: 'codex-session-1',
      });

      const result = runNotifyHook(buildPayload(wd, {
        session_id: 'codex-session-1',
        thread_id: 'thread-unreadable-current-1',
        turn_id: 'turn-unreadable-current-1',
      }));
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const currentRaw = await readFile(join(currentSessionDir, 'ralph-state.json'), 'utf-8');
      assert.equal(currentRaw, '{ "active": true');

      const priorState = JSON.parse(await readFile(join(priorSessionDir, 'ralph-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(priorState.active, true);
      assert.equal(priorState.iteration, 6);
      assert.equal(priorState.current_phase, 'executing');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('serializes concurrent resume attempts so only one transfer occurs', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-ralph-concurrent-resume-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const currentOmxSessionId = 'sess-current';
      const priorOmxSessionId = 'sess-prior';
      const currentSessionDir = join(stateDir, 'sessions', currentOmxSessionId);
      const priorSessionDir = join(stateDir, 'sessions', priorOmxSessionId);
      await writeJson(join(stateDir, 'session.json'), { session_id: currentOmxSessionId });
      await writeJson(join(priorSessionDir, 'ralph-state.json'), {
        active: true,
        iteration: 4,
        max_iterations: 10,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
        owner_omx_session_id: priorOmxSessionId,
        owner_codex_session_id: 'codex-session-1',
        tmux_pane_id: '%42',
      });

      await withPatchedEnv(await setupTmuxFixture(wd, '%88'), async () => {
        let releaseFirstLock: () => void = () => {};
        const firstLocked = new Promise<void>((resolve) => {
          releaseFirstLock = resolve;
        });
        let firstInsideLock = false;
        let markFirstInside: () => void = () => {};
        const firstEntered = new Promise<void>((resolve) => {
          markFirstInside = resolve;
        });

        const firstResume = reconcileRalphSessionResume({
          stateDir,
          payloadSessionId: 'codex-session-1',
          payloadThreadId: 'thread-concurrent-1',
          env: { ...process.env, TMUX_PANE: '%55' },
          hooks: {
            afterLockAcquired: async () => {
              firstInsideLock = true;
              markFirstInside();
              await firstLocked;
            },
          },
        });

        await firstEntered;
        assert.equal(firstInsideLock, true);

        const secondResume = reconcileRalphSessionResume({
          stateDir,
          payloadSessionId: 'codex-session-1',
          payloadThreadId: 'thread-concurrent-1',
          env: { ...process.env, TMUX_PANE: '%56' },
        });

        releaseFirstLock();

        const [firstResult, secondResult] = await Promise.all([firstResume, secondResume]);
        assert.equal(firstResult.resumed, true);
        assert.equal(secondResult.resumed, false);
        assert.equal(secondResult.reason, 'current_ralph_active');

        const currentState = JSON.parse(await readFile(join(currentSessionDir, 'ralph-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(currentState.active, true);
        assert.equal(currentState.owner_omx_session_id, currentOmxSessionId);
        assert.equal(currentState.owner_codex_session_id, 'codex-session-1');
        assert.equal(currentState.tmux_pane_id, '%56');

        const priorState = JSON.parse(await readFile(join(priorSessionDir, 'ralph-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(priorState.active, false);
        assert.equal(priorState.current_phase, 'cancelled');
        assert.equal(priorState.stop_reason, 'ownership_transferred');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rolls back the target state when transfer fails after writing the current session', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-ralph-transfer-rollback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const currentOmxSessionId = 'sess-current';
      const priorOmxSessionId = 'sess-prior';
      const currentSessionDir = join(stateDir, 'sessions', currentOmxSessionId);
      const priorSessionDir = join(stateDir, 'sessions', priorOmxSessionId);
      await writeJson(join(stateDir, 'session.json'), { session_id: currentOmxSessionId });
      await writeJson(join(priorSessionDir, 'ralph-state.json'), {
        active: true,
        iteration: 4,
        max_iterations: 10,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
        owner_omx_session_id: priorOmxSessionId,
        owner_codex_session_id: 'codex-session-1',
        tmux_pane_id: '%42',
      });

      await assert.rejects(
        () => reconcileRalphSessionResume({
          stateDir,
          payloadSessionId: 'codex-session-1',
          payloadThreadId: 'thread-rollback-1',
          env: { ...process.env, TMUX_PANE: '%57' },
          hooks: {
            afterTargetWrite: async () => {
              throw new Error('simulated_source_write_failure');
            },
          },
        }),
        /simulated_source_write_failure/,
      );

      assert.equal(existsSync(join(currentSessionDir, 'ralph-state.json')), false);
      const priorState = JSON.parse(await readFile(join(priorSessionDir, 'ralph-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(priorState.active, true);
      assert.equal(priorState.current_phase, 'executing');
      assert.equal(priorState.stop_reason, undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
