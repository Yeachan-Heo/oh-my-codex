import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { executeStateOperation } from '../operations.js';
import { subagentTrackingPath } from '../../subagents/tracker.js';

async function withAmbientTmuxEnv<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const previousTmux = process.env.TMUX;
  const previousTmuxPane = process.env.TMUX_PANE;
  const previousPath = process.env.PATH;

  if (typeof env.TMUX === 'string') process.env.TMUX = env.TMUX;
  else delete process.env.TMUX;
  if (typeof env.TMUX_PANE === 'string') process.env.TMUX_PANE = env.TMUX_PANE;
  else delete process.env.TMUX_PANE;
  if (typeof env.PATH === 'string') process.env.PATH = env.PATH;
  else if ('PATH' in env) delete process.env.PATH;

  try {
    return await run();
  } finally {
    if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
    else delete process.env.TMUX;
    if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
    else delete process.env.TMUX_PANE;
    if (typeof previousPath === 'string') process.env.PATH = previousPath;
    else delete process.env.PATH;
  }
}

async function withOmxRootEnv<T>(root: string, run: () => Promise<T>): Promise<T> {
  const previousOmxRoot = process.env.OMX_ROOT;
  const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
  const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
  process.env.OMX_ROOT = root;
  delete process.env.OMX_STATE_ROOT;
  delete process.env.OMX_TEAM_STATE_ROOT;
  try {
    return await run();
  } finally {
    if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
    else delete process.env.OMX_ROOT;
    if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
    else delete process.env.OMX_STATE_ROOT;
    if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
    else delete process.env.OMX_TEAM_STATE_ROOT;
  }
}

async function writeNativeSubagentTracking(cwd: string, sessionId: string): Promise<void> {
  const trackingPath = subagentTrackingPath(cwd);
  const now = '2026-05-28T00:00:00.000Z';
  await mkdir(dirname(trackingPath), { recursive: true });
  await writeFile(trackingPath, JSON.stringify({
    schemaVersion: 1,
    sessions: {
      [sessionId]: {
        session_id: sessionId,
        leader_thread_id: 'thread-leader',
        updated_at: now,
        threads: {
          'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: now, last_seen_at: now, turn_count: 1 },
          'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: now, last_seen_at: now, completed_at: now, turn_count: 1 },
          'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: now, last_seen_at: now, completed_at: now, turn_count: 1 },
        },
      },
    },
  }, null, 2));
}

function ralplanConsensusGate(
  sessionId: string,
  provenanceKind: 'native_subagent' | 'codex_exec',
  threadOverrides: { architect?: string; critic?: string } = {},
): Record<string, unknown> {
  const architectThread = threadOverrides.architect ?? (provenanceKind === 'native_subagent' ? 'thread-architect' : 'exec-architect');
  const criticThread = threadOverrides.critic ?? (provenanceKind === 'native_subagent' ? 'thread-critic' : 'exec-critic');
  return {
    required: true,
    complete: true,
    sequence: ['architect-review', 'critic-review'],
    planning_artifacts_are_not_consensus: true,
    required_review_roles: ['architect', 'critic'],
    ralplan_architect_review: {
      agent_role: 'architect',
      verdict: 'approve',
      provenance_kind: provenanceKind,
      session_id: sessionId,
      thread_id: architectThread,
      artifact_path: '.omx/artifacts/architect.md',
      tracker_path: '.omx/state/subagent-tracking.json',
    },
    ralplan_critic_review: {
      agent_role: 'critic',
      verdict: 'approve',
      provenance_kind: provenanceKind,
      session_id: sessionId,
      thread_id: criticThread,
      artifact_path: '.omx/artifacts/critic.md',
      tracker_path: '.omx/state/subagent-tracking.json',
    },
  };
}

async function createFakeTmuxBin(wd: string): Promise<string> {
  const fakeBin = join(wd, 'bin');
  await mkdir(fakeBin, { recursive: true });
  const tmuxPath = join(fakeBin, 'tmux');
  await writeFile(
    tmuxPath,
    `#!/usr/bin/env bash
set -eu
cmd="\${1:-}"
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
  if [[ -z "$target" && "$format" == "#{pane_id}" ]]; then
    echo "%777"
    exit 0
  fi
  if [[ -z "$target" && "$format" == "#S" ]]; then
    echo "maintainer-default"
    exit 0
  fi
  if [[ "$target" == "%777" && "$format" == "#{pane_id}" ]]; then
    echo "%777"
    exit 0
  fi
  if [[ "$target" == "%777" && "$format" == "#S" ]]; then
    echo "maintainer-default"
    exit 0
  fi
fi
if [[ "$cmd" == "list-sessions" ]]; then
  echo "maintainer-default"
  exit 0
fi
exit 1
`,
  );
  await chmod(tmuxPath, 0o755);
  return fakeBin;
}

describe('state operations directory initialization', () => {
  it('keeps state_list_active side-effect-free without setup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-test-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const tmuxHookConfig = join(wd, '.omx', 'tmux-hook.json');
      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);

      const response = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });

      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);
      assert.deepEqual(response.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps state_get_status side-effect-free when session_id is provided', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-status-readonly-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', 'sess1');
      const tmuxHookConfig = join(wd, '.omx', 'tmux-hook.json');
      assert.equal(existsSync(sessionDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);

      const response = await executeStateOperation('state_get_status', {
        workingDirectory: wd,
        session_id: 'sess1',
      });

      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(sessionDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);
      assert.deepEqual(response.payload, { statuses: {} });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('surfaces active ultragoal artifacts in list-active without mode state files', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ultragoal-artifact-'));
    try {
      await mkdir(join(wd, '.omx', 'ultragoal'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'ultragoal', 'goals.json'),
        JSON.stringify({
          activeGoalId: 'G001',
          goals: [{
            id: 'G001',
            title: 'Fix duplicate HUD panes',
            objective: 'Keep one HUD renderer per leader.',
            status: 'in_progress',
          }],
        }, null, 2),
      );

      const activeResponse = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(activeResponse.payload, { active_modes: ['ultragoal'] });

      const statusResponse = await executeStateOperation('state_get_status', {
        workingDirectory: wd,
        mode: 'ultragoal',
      });
      const statuses = (statusResponse.payload as {
        statuses?: Record<string, { active?: boolean; phase?: string; path?: string; source?: string }>;
      }).statuses || {};
      assert.equal(statuses.ultragoal?.active, true);
      assert.equal(statuses.ultragoal?.phase, 'in_progress');
      assert.equal(statuses.ultragoal?.path, join(wd, '.omx', 'ultragoal', 'goals.json'));
      assert.equal(statuses.ultragoal?.source, 'ultragoal-artifacts');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prefers active ultragoal artifacts over stale inactive mode state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ultragoal-stale-state-'));
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(join(wd, '.omx', 'ultragoal'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'state', 'ultragoal-state.json'),
        JSON.stringify({ active: false, current_phase: 'cleared' }, null, 2),
      );
      await writeFile(
        join(wd, '.omx', 'ultragoal', 'goals.json'),
        JSON.stringify({
          activeGoalId: 'G001',
          goals: [{
            id: 'G001',
            title: 'Fix duplicate HUD panes',
            objective: 'Keep one HUD renderer per leader.',
            status: 'in_progress',
          }],
        }, null, 2),
      );

      const activeResponse = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(activeResponse.payload, { active_modes: ['ultragoal'] });

      const statusResponse = await executeStateOperation('state_get_status', {
        workingDirectory: wd,
        mode: 'ultragoal',
      });
      const statuses = (statusResponse.payload as {
        statuses?: Record<string, { active?: boolean; phase?: string; source?: string }>;
      }).statuses || {};
      assert.equal(statuses.ultragoal?.active, true);
      assert.equal(statuses.ultragoal?.phase, 'in_progress');
      assert.equal(statuses.ultragoal?.source, 'ultragoal-artifacts');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not treat root fallback as active for explicit session list-active decisions', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-active-scope-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, 'ralph-state.json'),
        JSON.stringify({
          active: true,
          mode: 'ralph',
          current_phase: 'executing',
        }, null, 2),
      );

      const activeResponse = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: 'missing-session',
      });

      assert.deepEqual(activeResponse.payload, { active_modes: [] });

      const readResponse = await executeStateOperation('state_read', {
        workingDirectory: wd,
        session_id: 'missing-session',
        mode: 'ralph',
      });
      assert.equal((readResponse.payload as { active?: unknown }).active, true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps missing state_read side-effect-free without setup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-readonly-missing-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const tmuxHookConfig = join(wd, '.omx', 'tmux-hook.json');
      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);

      const response = await executeStateOperation('state_read', {
        workingDirectory: wd,
        mode: 'deep-interview',
      });

      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);
      assert.deepEqual(response.payload, { exists: false, mode: 'deep-interview' });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('bootstraps tmux-hook from the current tmux pane for mutating state operations', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-live-'));
    try {
      const tmuxHookConfig = join(wd, '.omx', 'tmux-hook.json');
      const fakeBin = await createFakeTmuxBin(wd);

      await withAmbientTmuxEnv(
        {
          TMUX: '/tmp/maintainer-default,123,0',
          TMUX_PANE: '%777',
          PATH: `${fakeBin}:${process.env.PATH || ''}`,
        },
        async () => {
          const response = await executeStateOperation('state_write', {
            workingDirectory: wd,
            mode: 'deep-interview',
            active: true,
            current_phase: 'deep-interview',
          });
          assert.equal(response.isError, undefined);
          assert.equal((response.payload as { success?: boolean }).success, true);
        },
      );

      const tmuxConfig = JSON.parse(await readFile(tmuxHookConfig, 'utf-8')) as {
        target?: { type?: string; value?: string };
      };
      assert.deepEqual(tmuxConfig.target, { type: 'pane', value: '%777' });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('writes and reads deep-interview state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-readwrite-'));
    try {
      const writeResponse = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'deep-interview',
        active: true,
        current_phase: 'deep-interview',
        state: {
          current_focus: 'intent',
          threshold: 0.2,
        },
      });

      assert.equal(writeResponse.isError, undefined);
      assert.deepEqual(writeResponse.payload, {
        success: true,
        mode: 'deep-interview',
        path: join(wd, '.omx', 'state', 'deep-interview-state.json'),
      });

      const readResponse = await executeStateOperation('state_read', {
        workingDirectory: wd,
        mode: 'deep-interview',
      });

      assert.equal(readResponse.isError, undefined);
      const readBody = readResponse.payload as Record<string, unknown>;
      assert.equal(readBody.active, true);
      assert.equal(readBody.current_phase, 'deep-interview');
      assert.equal(readBody.current_focus, 'intent');
      assert.equal(readBody.threshold, 0.2);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('writes and reads autoresearch state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autoresearch-'));
    try {
      const writeResponse = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'autoresearch',
        active: true,
        current_phase: 'running',
      });

      assert.equal(writeResponse.isError, undefined);
      assert.deepEqual(writeResponse.payload, {
        success: true,
        mode: 'autoresearch',
        path: join(wd, '.omx', 'state', 'autoresearch-state.json'),
      });

      const readResponse = await executeStateOperation('state_read', {
        workingDirectory: wd,
        mode: 'autoresearch',
      });

      assert.equal(readResponse.isError, undefined);
      const readBody = readResponse.payload as Record<string, unknown>;
      assert.equal(readBody.active, true);
      assert.equal(readBody.current_phase, 'running');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('lists active modes from the explicit session scope without leaking a sibling Ralph session', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-foreign-ralph-scope-'));
    try {
      const currentSessionDir = join(wd, '.omx', 'state', 'sessions', 'sess-current');
      const foreignSessionDir = join(wd, '.omx', 'state', 'sessions', 'sess-foreign');
      await mkdir(currentSessionDir, { recursive: true });
      await mkdir(foreignSessionDir, { recursive: true });
      await writeFile(
        join(foreignSessionDir, 'ralph-state.json'),
        JSON.stringify({ active: true, current_phase: 'executing' }, null, 2),
      );

      const response = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: 'sess-current',
      });

      assert.deepEqual(response.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('isolates same workflow state across explicit session ids when starting and clearing one session', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-same-workflow-isolation-'));
    try {
      const writeA = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: 'sess-a',
        mode: 'ralph',
        active: true,
        iteration: 1,
        max_iterations: 5,
        current_phase: 'executing',
        state: { task_slug: 'session-a-task' },
      });
      assert.equal(writeA.isError, undefined);

      const sessionAStatePath = join(wd, '.omx', 'state', 'sessions', 'sess-a', 'ralph-state.json');
      const sessionACanonicalPath = join(wd, '.omx', 'state', 'sessions', 'sess-a', 'skill-active-state.json');
      const sessionAStateBefore = JSON.parse(await readFile(sessionAStatePath, 'utf-8')) as Record<string, unknown>;
      const sessionACanonicalBefore = JSON.parse(await readFile(sessionACanonicalPath, 'utf-8')) as Record<string, unknown>;

      const writeB = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: 'sess-b',
        mode: 'ralph',
        active: true,
        iteration: 1,
        max_iterations: 5,
        current_phase: 'executing',
        state: { task_slug: 'session-b-task' },
      });
      assert.equal(writeB.isError, undefined);

      assert.deepEqual(JSON.parse(await readFile(sessionAStatePath, 'utf-8')), sessionAStateBefore);
      assert.deepEqual(JSON.parse(await readFile(sessionACanonicalPath, 'utf-8')), sessionACanonicalBefore);

      await executeStateOperation('state_clear', {
        workingDirectory: wd,
        session_id: 'sess-b',
        mode: 'ralph',
      });

      const activeA = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: 'sess-a',
      });
      assert.deepEqual(activeA.payload, { active_modes: ['ralph'] });

      const activeB = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: 'sess-b',
      });
      assert.deepEqual(activeB.payload, { active_modes: [] });

      assert.deepEqual(JSON.parse(await readFile(sessionAStatePath, 'utf-8')), sessionAStateBefore);
      assert.deepEqual(JSON.parse(await readFile(sessionACanonicalPath, 'utf-8')), sessionACanonicalBefore);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('serializes concurrent state_write calls per mode file and preserves merged fields', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-concurrency-'));
    try {
      const writes = Array.from({ length: 16 }, (_, i) =>
        executeStateOperation('state_write', {
          workingDirectory: wd,
          mode: 'team',
          state: { [`k${i}`]: i },
        }),
      );

      const responses = await Promise.all(writes);
      for (const response of responses) {
        assert.equal(response.isError, undefined);
      }

      const filePath = join(wd, '.omx', 'state', 'team-state.json');
      const state = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
      for (let i = 0; i < 16; i++) {
        assert.equal(state[`k${i}`], i);
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not report a legacy root mode active after clearing the current session scope', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-clear-root-fallback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-clear';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(
        join(stateDir, 'deep-interview-state.json'),
        JSON.stringify({ active: true, mode: 'deep-interview', current_phase: 'legacy-root' }, null, 2),
      );
      await writeFile(
        join(sessionDir, 'deep-interview-state.json'),
        JSON.stringify({ active: true, mode: 'deep-interview', current_phase: 'session-active' }, null, 2),
      );

      await executeStateOperation('state_clear', {
        workingDirectory: wd,
        mode: 'deep-interview',
      });

      assert.equal(existsSync(join(sessionDir, 'deep-interview-state.json')), true);
      assert.equal(existsSync(join(stateDir, 'deep-interview-state.json')), true);

      const sessionState = JSON.parse(
        await readFile(join(sessionDir, 'deep-interview-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(sessionState.active, false);
      assert.equal(sessionState.current_phase, 'cleared');

      const activeResponse = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(activeResponse.payload, { active_modes: [] });

      const statusResponse = await executeStateOperation('state_get_status', {
        workingDirectory: wd,
        mode: 'deep-interview',
      });
      const statuses = (statusResponse.payload as {
        statuses?: Record<string, { active?: boolean; phase?: string }>;
      }).statuses || {};
      assert.equal(statuses['deep-interview']?.active, false);
      assert.equal(statuses['deep-interview']?.phase, 'cleared');

      const readResponse = await executeStateOperation('state_read', {
        workingDirectory: wd,
        mode: 'deep-interview',
      });
      const readBody = readResponse.payload as Record<string, unknown>;
      assert.equal(readBody.active, false);
      assert.equal(readBody.current_phase, 'cleared');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('all_sessions clear removes session-only canonical workflow state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-all-sessions-session-only-'));
    try {
      const sessionDir = join(wd, '.omx', 'state', 'sessions', 'sess-only');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'ralph-state.json'),
        JSON.stringify({ active: true, mode: 'ralph', current_phase: 'executing' }, null, 2),
      );
      await writeFile(
        join(sessionDir, 'skill-active-state.json'),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'ralph',
          session_id: 'sess-only',
          active_skills: [{ skill: 'ralph', phase: 'executing', active: true, session_id: 'sess-only' }],
        }, null, 2),
      );

      const cleared = await executeStateOperation('state_clear', {
        workingDirectory: wd,
        mode: 'ralph',
        all_sessions: true,
      });
      assert.equal(cleared.isError, undefined);

      assert.equal(existsSync(join(sessionDir, 'ralph-state.json')), false);
      assert.equal(existsSync(join(sessionDir, 'skill-active-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('syncs canonical skill-active state for tracked mode writes and clears', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-canonical-'));
    try {
      await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: 'sess-sync',
        mode: 'autoresearch',
        active: true,
        current_phase: 'running',
      });

      const canonicalPath = join(wd, '.omx', 'state', 'sessions', 'sess-sync', 'skill-active-state.json');
      const canonical = JSON.parse(await readFile(canonicalPath, 'utf-8')) as {
        active_skills?: Array<{
          skill: string;
          phase?: string;
          session_id?: string;
          activated_at?: string;
          updated_at?: string;
        }>;
      };
      assert.deepEqual(canonical.active_skills, [{
        skill: 'autoresearch',
        phase: 'running',
        active: true,
        activated_at: canonical.active_skills?.[0]?.activated_at,
        updated_at: canonical.active_skills?.[0]?.updated_at,
        session_id: 'sess-sync',
      }]);

      await executeStateOperation('state_clear', {
        workingDirectory: wd,
        session_id: 'sess-sync',
        mode: 'autoresearch',
      });

      const cleared = JSON.parse(await readFile(canonicalPath, 'utf-8')) as {
        active: boolean;
        active_skills?: unknown[];
      };
      assert.equal(cleared.active, false);
      assert.deepEqual(cleared.active_skills, []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies unsupported overlaps without writing the requested mode state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-deny-overlap-'));
    try {
      const existing = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: 'sess-deny',
        mode: 'team',
        active: true,
        current_phase: 'running',
      });
      assert.equal(existing.isError, undefined);

      const denied = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: 'sess-deny',
        mode: 'autopilot',
        active: true,
        current_phase: 'planning',
      });

      assert.equal(denied.isError, true);
      assert.match(String((denied.payload as { error?: string }).error || ''), /Unsupported workflow overlap: team \+ autopilot\./);
      assert.equal(existsSync(join(wd, '.omx', 'state', 'sessions', 'sess-deny', 'autopilot-state.json')), false);

      const canonical = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'sessions', 'sess-deny', 'skill-active-state.json'), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string }> };
      assert.deepEqual(canonical.active_skills?.map((entry) => entry.skill), ['team']);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects standalone ralplan writes while preserving active Autopilot supervisor state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ralplan-child-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ralplan-child';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_gate: {
                status: 'required',
                skip_reason: null,
              },
            },
          }, null, 2),
        );

        const denied = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'ralplan',
          active: true,
          current_phase: 'planning',
        });

        assert.equal(denied.isError, true);
        assert.match(String((denied.payload as { error?: string }).error || ''), /Execution-to-planning rollback auto-complete is not allowed\./);
        assert.equal(existsSync(join(sessionDir, 'ralplan-state.json')), false);

        const autopilotState = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(autopilotState.active, true);
        assert.equal(autopilotState.mode, 'autopilot');
        assert.equal(autopilotState.current_phase, 'deep-interview');
        assert.equal(autopilotState.auto_completed_reason, undefined);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows Autopilot itself to enter the supervised ralplan child phase', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-child-phase-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-child-phase';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_gate: {
                status: 'complete',
                rationale: 'Requirements clarified and ready for consensus planning.',
              },
              handoff_artifacts: {
                deep_interview: {
                  summary: 'Autopilot may proceed to ralplan.',
                },
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.active, true);
        assert.equal(state.mode, 'autopilot');
        assert.equal(state.current_phase, 'ralplan');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot direct deep-interview to ultragoal skip without deep-interview evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-direct-di-skip-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-direct-di-skip-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_gate: { status: 'required' },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ultragoal',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /Cannot transition ralplan -> ultragoal|Unsupported|cannot/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'deep-interview');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot deep-interview completion before the ralplan gate', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-di-complete-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-di-complete-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_gate: { status: 'required' },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /Cannot complete Autopilot before ralplan gate/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'deep-interview');
        assert.equal(state.active, true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot direct deep-interview to ultragoal skip even with deep-interview evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-direct-di-complete-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-direct-di-complete-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_gate: {
                status: 'complete',
                rationale: 'Deep-interview is complete, but ralplan consensus is not.',
              },
              handoff_artifacts: {
                deep_interview: { summary: 'Ready for ralplan only.' },
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ultragoal',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /Cannot transition ralplan -> ultragoal|Unsupported|cannot/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'deep-interview');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot deep-interview to ralplan self-write when only a satisfied question exists', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-child-phase-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-child-phase-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            question_enforcement: {
              obligation_id: 'obligation-answered',
              source: 'omx-question',
              status: 'satisfied',
              lifecycle_outcome: 'askuserQuestion',
              requested_at: '2026-05-28T00:00:00.000Z',
              question_id: 'question-answered',
              satisfied_at: '2026-05-28T00:01:00.000Z',
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /missing deep-interview completion\/skip gate/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'deep-interview');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot waiting-for-user to ralplan self-write while the deep-interview question is unresolved', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-waiting-question-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-waiting-question-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'waiting-for-user',
            run_outcome: 'blocked_on_user',
            lifecycle_outcome: 'askuserQuestion',
            state: {
              deep_interview_question: {
                status: 'waiting_for_user',
                source: 'omx-question',
                obligation_id: 'obligation-waiting',
                previous_phase: 'deep-interview',
                requested_at: '2026-05-28T00:00:00.000Z',
              },
              deep_interview_gate: {
                status: 'complete',
                rationale: 'Stale completion gate must not bypass an unresolved question.',
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /question obligation is still pending/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'waiting-for-user');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot handoff when the next state omits a still-pending deep-interview question', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-omitted-question-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-omitted-question-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'waiting-for-user',
            run_outcome: 'blocked_on_user',
            lifecycle_outcome: 'askuserQuestion',
            state: {
              deep_interview_question: {
                status: 'waiting_for_user',
                source: 'omx-question',
                obligation_id: 'obligation-omitted',
                previous_phase: 'deep-interview',
                requested_at: '2026-05-28T00:00:00.000Z',
              },
              deep_interview_gate: {
                status: 'required',
                rationale: 'Question still needs an answer.',
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
          state: {
            deep_interview_gate: {
              status: 'complete',
              rationale: 'Replacement state must not erase an unanswered question obligation.',
            },
            handoff_artifacts: {
              deep_interview: { summary: 'Ready for planning.' },
            },
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /question obligation is still pending/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'waiting-for-user');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('ignores stale standalone deep-interview question state for Autopilot supervisor handoff', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ignore-standalone-di-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ignore-standalone-di';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'deep-interview-state.json'),
          JSON.stringify({
            active: false,
            mode: 'deep-interview',
            current_phase: 'completed',
            question_enforcement: {
              obligation_id: 'stale-obligation',
              source: 'omx-question',
              status: 'pending',
              lifecycle_outcome: 'askuserQuestion',
              requested_at: '2026-05-28T00:00:00.000Z',
            },
          }, null, 2),
        );
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_gate: {
                status: 'complete',
                rationale: 'Autopilot-owned gate is complete.',
              },
              handoff_artifacts: {
                deep_interview: { summary: 'Autopilot-owned handoff is ready.' },
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot satisfied nested question handoff without a record-backed question id', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-satisfied-question-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-satisfied-question-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_question: {
                status: 'satisfied',
                source: 'omx-question',
                obligation_id: 'obligation-no-record',
                previous_phase: 'deep-interview',
                requested_at: '2026-05-28T00:00:00.000Z',
                satisfied_at: '2026-05-28T00:01:00.000Z',
              },
              deep_interview_gate: {
                status: 'complete',
                rationale: 'Question satisfaction must be backed by an answered record.',
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /lacks same-session answered omx question record/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'deep-interview');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows Autopilot handoff when next state satisfies a previously pending question', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-next-question-satisfied-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-next-question-satisfied';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        const questionId = 'question-next-satisfied';
        await mkdir(join(sessionDir, 'questions'), { recursive: true });
        await writeFile(
          join(sessionDir, 'questions', `${questionId}.json`),
          JSON.stringify({
            kind: 'omx.question/v1',
            question_id: questionId,
            session_id: sessionId,
            source: 'deep-interview',
            status: 'answered',
            answer: 'lowercase ascii slug',
            answers: [{ question_id: 'q-1', index: 0, answer: 'lowercase ascii slug' }],
          }, null, 2),
        );
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_question: {
                obligation_id: 'obligation-next-satisfied',
                source: 'omx-question',
                status: 'waiting_for_user',
                requested_at: '2026-05-28T00:00:00.000Z',
              },
              deep_interview_gate: { status: 'required' },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
          state: {
            deep_interview_question: {
              obligation_id: 'obligation-next-satisfied',
              source: 'omx-question',
              status: 'satisfied',
              requested_at: '2026-05-28T00:00:00.000Z',
              question_id: questionId,
              satisfied_at: '2026-05-28T00:01:00.000Z',
            },
            deep_interview_gate: {
              status: 'complete',
              rationale: 'The answered question resolves the CLI output policy.',
            },
            handoff_artifacts: {
              deep_interview: { summary: 'Ready for ralplan after answered question.' },
            },
          },
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows Autopilot deep-interview to ralplan self-write with explicit user-authorized skip evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-child-phase-skip-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-child-phase-skip';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              deep_interview_gate: {
                status: 'skipped',
                skip_authorized_by_user: true,
                skip_reason: 'User explicitly authorized skipping deep-interview for this bounded follow-up.',
                skipped_at: '2026-05-28T00:02:00.000Z',
                source: 'user',
                session_id: sessionId,
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('resolves Autopilot satisfied question evidence under OMX_TEAM_STATE_ROOT', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-team-question-'));
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      const wd = join(root, 'source');
      const teamStateRoot = join(root, 'team-state');
      const sessionId = 'sess-autopilot-team-question';
      const sessionDir = join(teamStateRoot, 'sessions', sessionId);
      const questionId = 'question-team-satisfied';
      await mkdir(join(sessionDir, 'questions'), { recursive: true });
      await writeFile(
        join(sessionDir, 'questions', `${questionId}.json`),
        JSON.stringify({
          kind: 'omx.question/v1',
          question_id: questionId,
          session_id: sessionId,
          source: 'deep-interview',
          status: 'answered',
          answer: 'clarified scope',
          answers: [{ question_id: 'q-1', index: 0, answer: 'clarified scope' }],
        }, null, 2),
      );
      await writeFile(
        join(sessionDir, 'autopilot-state.json'),
        JSON.stringify({
          active: true,
          mode: 'autopilot',
          current_phase: 'deep-interview',
          question_enforcement: {
            obligation_id: 'obligation-team-question',
            source: 'omx-question',
            status: 'satisfied',
            lifecycle_outcome: 'askuserQuestion',
            requested_at: '2026-05-28T00:00:00.000Z',
            question_id: questionId,
            satisfied_at: '2026-05-28T00:01:00.000Z',
          },
          state: {
            deep_interview_gate: {
              status: 'complete',
              rationale: 'The answered question resolves the execution boundary.',
            },
          },
        }, null, 2),
      );

      delete process.env.OMX_ROOT;
      delete process.env.OMX_STATE_ROOT;
      process.env.OMX_TEAM_STATE_ROOT = teamStateRoot;

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'autopilot',
        active: true,
        current_phase: 'ralplan',
      });

      assert.equal(response.isError, undefined);
      const state = JSON.parse(
        await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(state.current_phase, 'ralplan');
      assert.equal(existsSync(join(wd, '.omx', 'state', 'sessions', sessionId, 'questions', `${questionId}.json`)), false);
    } finally {
      if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
      else delete process.env.OMX_ROOT;
      if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
      else delete process.env.OMX_STATE_ROOT;
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(root, { recursive: true, force: true });
    }
  });


  it('denies Autopilot direct ralplan to code-review skip without native consensus evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-direct-ralplan-skip-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-direct-ralplan-skip-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'ralplan',
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'code-review',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /Cannot skip Autopilot ultragoal gate/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot ralplan completion before the ultragoal gate', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ralplan-complete-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ralplan-complete-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'ralplan',
            state: {
              handoff_artifacts: {
                ralplan: {
                  plan_path: '.omx/plans/prd.md',
                  test_spec_path: '.omx/plans/test-spec.md',
                },
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /Cannot complete Autopilot before ultragoal gate/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
        assert.equal(state.active, true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot ralplan to ultragoal self-write with codex_exec consensus evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ralplan-native-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ralplan-native-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'ralplan',
            state: {
              handoff_artifacts: {
                ralplan: {
                  plan_path: '.omx/plans/prd.md',
                  test_spec_path: '.omx/plans/test-spec.md',
                },
                ralplan_consensus_gate: ralplanConsensusGate(sessionId, 'codex_exec'),
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ultragoal',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /tracker-backed native architect and critic lanes/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });


  it('denies Autopilot ralplan to ultragoal self-write when native reviews reuse one subagent thread', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ralplan-same-thread-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ralplan-same-thread-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeNativeSubagentTracking(wd, sessionId);
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'ralplan',
            state: {
              handoff_artifacts: {
                ralplan: {
                  plan_path: '.omx/plans/prd.md',
                  test_spec_path: '.omx/plans/test-spec.md',
                },
                ralplan_consensus_gate: ralplanConsensusGate(sessionId, 'native_subagent', {
                  critic: 'thread-architect',
                }),
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ultragoal',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /tracker-backed native architect and critic lanes/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies legacy Autopilot planning to ultragoal without ralplan consensus evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-legacy-planning-gate-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-legacy-planning-gate';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'planning',
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ultragoal',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /ralplan consensus/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'planning');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows Autopilot ralplan to ultragoal self-write with tracker-backed native consensus evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ralplan-native-allow-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ralplan-native-allow';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeNativeSubagentTracking(wd, sessionId);
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'ralplan',
            state: {
              handoff_artifacts: {
                ralplan: {
                  plan_path: '.omx/plans/prd.md',
                  test_spec_path: '.omx/plans/test-spec.md',
                },
                ralplan_consensus_gate: ralplanConsensusGate(sessionId, 'native_subagent'),
              },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ultragoal',
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ultragoal');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed when canonical deep-interview is active but mode state is missing', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-missing-deep-interview-state-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-missing-deep-interview-state';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'skill-active-state.json'),
          JSON.stringify({
            version: 1,
            active: true,
            skill: 'deep-interview',
            session_id: sessionId,
            active_skills: [{
              skill: 'deep-interview',
              active: true,
              phase: 'intent-first',
              session_id: sessionId,
            }],
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'ralplan',
          active: true,
          current_phase: 'planning',
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /missing deep-interview completion\/skip gate/i);
        assert.equal(existsSync(join(sessionDir, 'ralplan-state.json')), false);
        const canonical = JSON.parse(
          await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8'),
        ) as { active_skills?: Array<{ skill: string; active?: boolean }> };
        assert.equal(canonical.active_skills?.[0]?.skill, 'deep-interview');
        assert.equal(canonical.active_skills?.[0]?.active, true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not auto-complete existing workflow state when tracked write validation fails', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-validate-before-transition-'));
    try {
      const sessionDir = join(wd, '.omx', 'state', 'sessions', 'sess-invalid');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'ralplan-state.json'),
        JSON.stringify({ active: true, mode: 'ralplan', current_phase: 'planning' }, null, 2),
      );

      const denied = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: 'sess-invalid',
        mode: 'ralph',
        active: true,
        current_phase: 'definitely-invalid',
      });

      assert.equal(denied.isError, true);
      assert.match(String((denied.payload as { error?: string }).error || ''), /ralph\.current_phase/i);

      const ralplanState = JSON.parse(
        await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(ralplanState.active, true);
      assert.equal(ralplanState.current_phase, 'planning');
      assert.equal(existsSync(join(sessionDir, 'ralph-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps session-scoped tracked state writable after root-state parse fallback on resume', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-resume-root-fallback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-resume-root-fallback';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(
        join(stateDir, 'ralph-state.json'),
        JSON.stringify({
          active: true,
          current_phase: 'executing',
          owner_omx_session_id: 'stale-root-owner',
        }, null, 2),
      );
      await writeFile(
        join(sessionDir, 'ralph-state.json'),
        JSON.stringify({
          active: true,
          current_phase: 'executing',
          owner_omx_session_id: sessionId,
        }, null, 2),
      );

      const writeResult = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        state: {
          current_phase: 'verify',
        },
      });

      assert.equal(writeResult.isError, undefined);
      const sessionState = JSON.parse(
        await readFile(join(sessionDir, 'ralph-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(sessionState.active, true);
      assert.equal(sessionState.current_phase, 'verifying');
      assert.equal(sessionState.owner_omx_session_id, sessionId);

      const rootState = JSON.parse(
        await readFile(join(stateDir, 'ralph-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(rootState.current_phase, 'executing');
      assert.equal(rootState.owner_omx_session_id, 'stale-root-owner');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
