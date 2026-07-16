import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { executeStateOperation } from '../operations.js';
import { subagentTrackingPath } from '../../subagents/tracker.js';
import { updateModeState } from '../../modes/base.js';
import { WRITABLE_STATE_SCOPE_ERRORS } from '../../mcp/state-paths.js';

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
async function withStateRootEnv<T>(env: Partial<Record<'OMX_ROOT' | 'OMX_STATE_ROOT' | 'OMX_TEAM_STATE_ROOT', string>>, run: () => Promise<T>): Promise<T> {
  const previousOmxRoot = process.env.OMX_ROOT;
  const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
  const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
  if (typeof env.OMX_ROOT === 'string') process.env.OMX_ROOT = env.OMX_ROOT;
  else delete process.env.OMX_ROOT;
  if (typeof env.OMX_STATE_ROOT === 'string') process.env.OMX_STATE_ROOT = env.OMX_STATE_ROOT;
  else delete process.env.OMX_STATE_ROOT;
  if (typeof env.OMX_TEAM_STATE_ROOT === 'string') process.env.OMX_TEAM_STATE_ROOT = env.OMX_TEAM_STATE_ROOT;
  else delete process.env.OMX_TEAM_STATE_ROOT;
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

function responsePayload<T extends Record<string, unknown>>(response: { payload: unknown; isError?: boolean }): T {
  assert.equal(response.isError, undefined);
  assert.ok(response.payload && typeof response.payload === 'object' && !Array.isArray(response.payload));
  return response.payload as T;
}

function validExecutionContract(stride: 'task' | 'deliverable' | 'milestone'): Record<string, unknown> {
  const perStride = {
    task: {
      allow_task_shrink: true,
      acceptance_coverage_scope: 'task',
      shrink_policy: 'allowed',
      completion_unit: 'One focused task',
      stop_condition: 'Stop after that task is implemented and verified',
    },
    deliverable: {
      allow_task_shrink: false,
      acceptance_coverage_scope: 'deliverable',
      shrink_policy: 'ask_before_shrink',
      completion_unit: 'The named deliverable',
      stop_condition: 'Stop after the deliverable is complete and verified',
    },
    milestone: {
      allow_task_shrink: false,
      acceptance_coverage_scope: 'milestone',
      shrink_policy: 'deny_unless_blocked',
      completion_unit: 'The approved milestone',
      stop_condition: 'Stop after the milestone is complete unless blocked',
    },
  } as const;

  return {
    version: 1,
    execution_stride: stride,
    source: 'deep-interview',
    selected_by: 'user',
    ...perStride[stride],
  };
}

async function writeNativeSubagentTracking(cwd: string, sessionId: string): Promise<void> {
  const trackingPath = subagentTrackingPath(cwd);
  const architectCompletedAt = '2026-05-28T00:00:00.000Z';
  const criticStartedAt = '2026-05-28T00:01:00.000Z';
  const criticCompletedAt = '2026-05-28T00:02:00.000Z';
  await mkdir(dirname(trackingPath), { recursive: true });
  await writeFile(trackingPath, JSON.stringify({
    schemaVersion: 1,
    sessions: {
      [sessionId]: {
        session_id: sessionId,
        leader_thread_id: 'thread-leader',
        updated_at: criticCompletedAt,
        threads: {
          'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: architectCompletedAt, last_seen_at: architectCompletedAt, turn_count: 1 },
          'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: architectCompletedAt, last_seen_at: architectCompletedAt, completed_at: architectCompletedAt, turn_count: 1, mode: 'architect' },
          'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: criticStartedAt, last_seen_at: criticCompletedAt, completed_at: criticCompletedAt, turn_count: 1, mode: 'critic' },
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
      sequence_index: 1,
      provenance_kind: provenanceKind,
      session_id: sessionId,
      thread_id: architectThread,
      artifact_path: '.omx/artifacts/architect.md',
      tracker_path: '.omx/state/subagent-tracking.json',
    },
    ralplan_critic_review: {
      agent_role: 'critic',
      verdict: 'approve',
      sequence_index: 2,
      provenance_kind: provenanceKind,
      session_id: sessionId,
      thread_id: criticThread,
      artifact_path: '.omx/artifacts/critic.md',
      tracker_path: '.omx/state/subagent-tracking.json',
    },
  };
}

async function writeNativeRalplanConsensusGate(
  cwd: string,
  sessionId: string,
  threadOverrides: { architect?: string; critic?: string } = {},
): Promise<Record<string, unknown>> {
  await writeNativeSubagentTracking(cwd, sessionId);
  return ralplanConsensusGate(sessionId, 'native_subagent', threadOverrides);
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

  it('writes and clears session state under OMX_TEAM_STATE_ROOT without creating cwd .omx', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-state-ops-team-root-'));
    try {
      const wd = join(root, 'workspace');
      const teamStateRoot = join(root, 'team-state');
      await mkdir(wd, { recursive: true });

      await withStateRootEnv({ OMX_TEAM_STATE_ROOT: teamStateRoot }, async () => {
        const writeResponse = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: 'sess-team-write',
          mode: 'autoresearch',
          active: true,
          current_phase: 'running',
        });
        const writePayload = responsePayload<{ path: string }>(writeResponse);
        assert.equal(writePayload.path, join(teamStateRoot, 'sessions', 'sess-team-write', 'autoresearch-state.json'));
        assert.equal(existsSync(writePayload.path), true);
        assert.equal(existsSync(join(teamStateRoot, 'sessions', 'sess-team-write', 'skill-active-state.json')), true);
        assert.equal(existsSync(join(wd, '.omx')), false);

        const clearResponse = await executeStateOperation('state_clear', {
          workingDirectory: wd,
          session_id: 'sess-team-write',
          mode: 'autoresearch',
        });
        const clearPayload = responsePayload<{ path: string }>(clearResponse);
        assert.equal(clearPayload.path, writePayload.path);
        assert.equal(existsSync(writePayload.path), false);
        assert.equal(existsSync(join(teamStateRoot, 'sessions', 'sess-team-write', 'skill-active-state.json')), true);
        assert.equal(existsSync(join(wd, '.omx')), false);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes and clears session state under OMX_ROOT when cwd is filesystem root', async () => {
    const boxRoot = await mkdtemp(join(tmpdir(), 'omx-state-ops-omx-root-'));
    try {
      await withStateRootEnv({ OMX_ROOT: boxRoot }, async () => {
        const writeResponse = await executeStateOperation('state_write', {
          workingDirectory: '/',
          session_id: 'sess-omx-root',
          mode: 'autoresearch',
          active: true,
          current_phase: 'running',
        });
        const writePayload = responsePayload<{ path: string }>(writeResponse);
        const expectedPath = join(boxRoot, '.omx', 'state', 'sessions', 'sess-omx-root', 'autoresearch-state.json');
        assert.equal(writePayload.path, expectedPath);
        assert.equal(existsSync(expectedPath), true);

        const clearResponse = await executeStateOperation('state_clear', {
          workingDirectory: '/',
          session_id: 'sess-omx-root',
          mode: 'autoresearch',
        });
        const clearPayload = responsePayload<{ path: string }>(clearResponse);
        assert.equal(clearPayload.path, expectedPath);
        assert.equal(existsSync(expectedPath), false);

        const workspace = join(boxRoot, 'workspace');
        await mkdir(workspace, { recursive: true });
        const workspaceResponse = await executeStateOperation('state_write', {
          workingDirectory: workspace,
          session_id: 'sess-omx-root-workspace',
          mode: 'autoresearch',
          active: true,
          current_phase: 'running',
        });
        const workspacePayload = responsePayload<{ path: string }>(workspaceResponse);
        assert.equal(
          workspacePayload.path,
          join(boxRoot, '.omx', 'state', 'sessions', 'sess-omx-root-workspace', 'autoresearch-state.json'),
        );
        assert.equal(existsSync(join(workspace, '.omx')), false);
      });
    } finally {
      await rm(boxRoot, { recursive: true, force: true });
    }
  });

  it('writes and clears session state under OMX_STATE_ROOT when cwd is filesystem root', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'omx-state-ops-state-root-'));
    try {
      await withStateRootEnv({ OMX_STATE_ROOT: stateRoot }, async () => {
        const writeResponse = await executeStateOperation('state_write', {
          workingDirectory: '/',
          session_id: 'sess-state-root',
          mode: 'autoresearch',
          active: true,
          current_phase: 'running',
        });
        const writePayload = responsePayload<{ path: string }>(writeResponse);
        const expectedPath = join(stateRoot, '.omx', 'state', 'sessions', 'sess-state-root', 'autoresearch-state.json');
        assert.equal(writePayload.path, expectedPath);
        assert.equal(existsSync(expectedPath), true);

        const clearResponse = await executeStateOperation('state_clear', {
          workingDirectory: '/',
          session_id: 'sess-state-root',
          mode: 'autoresearch',
        });
        const clearPayload = responsePayload<{ path: string }>(clearResponse);
        assert.equal(clearPayload.path, expectedPath);
        assert.equal(existsSync(expectedPath), false);

        const workspace = join(stateRoot, 'workspace');
        await mkdir(workspace, { recursive: true });
        const workspaceResponse = await executeStateOperation('state_write', {
          workingDirectory: workspace,
          session_id: 'sess-state-root-workspace',
          mode: 'autoresearch',
          active: true,
          current_phase: 'running',
        });
        const workspacePayload = responsePayload<{ path: string }>(workspaceResponse);
        assert.equal(
          workspacePayload.path,
          join(stateRoot, '.omx', 'state', 'sessions', 'sess-state-root-workspace', 'autoresearch-state.json'),
        );
        assert.equal(existsSync(join(workspace, '.omx')), false);
      });
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
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

  it('reports reconciled task-scoped aggregate ultragoal artifacts as inactive in get-status', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ultragoal-reconciled-'));
    try {
      await mkdir(join(wd, '.omx', 'ultragoal'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'ultragoal', 'goals.json'),
        JSON.stringify({
          aggregateCompletion: {
            status: 'complete',
            completedAt: '2026-06-01T12:00:00.000Z',
            evidence: 'task-scoped Codex aggregate completed and active microgoal row was reconciled',
          },
          activeGoalId: 'G002',
          goals: [{
            id: 'G001',
            title: 'Fix duplicate HUD panes',
            objective: 'Keep one HUD renderer per leader.',
            status: 'complete',
            completedAt: '2026-06-01T12:00:00.000Z',
          }, {
            id: 'G002',
            title: 'Still marked running',
            objective: 'Progress-only row left running by the old aggregate path.',
            status: 'in_progress',
          }, {
            id: 'G003',
            title: 'Still marked pending',
            objective: 'Progress-only row left pending by the old aggregate path.',
            status: 'pending',
          }],
        }, null, 2),
      );

      const activeResponse = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(activeResponse.payload, { active_modes: [] });

      const statusResponse = await executeStateOperation('state_get_status', {
        workingDirectory: wd,
        mode: 'ultragoal',
      });
      const statuses = (statusResponse.payload as {
        statuses?: Record<string, { active?: boolean; phase?: string; path?: string; source?: string; data?: { activeGoal?: unknown; inProgress?: number; pending?: number; complete?: number } }>;
      }).statuses || {};
      assert.equal(statuses.ultragoal?.active, false);
      assert.equal(statuses.ultragoal?.phase, 'complete');
      assert.equal(statuses.ultragoal?.path, join(wd, '.omx', 'ultragoal', 'goals.json'));
      assert.equal(statuses.ultragoal?.source, 'ultragoal-artifacts');
      assert.equal(statuses.ultragoal?.data?.activeGoal, undefined);
      assert.equal(statuses.ultragoal?.data?.complete, 1);
      assert.equal(statuses.ultragoal?.data?.inProgress, 1);
      assert.equal(statuses.ultragoal?.data?.pending, 1);
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

  it('normalizes terminal deep-interview snapshots by releasing stale locks', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-di-terminal-normalize-'));
    try {
      const completedAt = '2026-07-09T00:00:00.000Z';
      const writeResponse = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'deep-interview',
        active: false,
        current_phase: 'cancelled',
        completed_at: completedAt,
        input_lock: {
          active: true,
          owner: 'question-round',
        },
        approval_lock: {
          status: 'pending',
          reviewer: 'user',
        },
        question_enforcement: {
          obligation_id: 'obligation-stale',
          source: 'omx-question',
          status: 'pending',
          lifecycle_outcome: 'askuserQuestion',
          requested_at: '2026-07-08T23:59:00.000Z',
        },
      });

      assert.equal(writeResponse.isError, undefined);

      const readResponse = await executeStateOperation('state_read', {
        workingDirectory: wd,
        mode: 'deep-interview',
      });
      const readBody = readResponse.payload as Record<string, unknown>;
      const inputLock = readBody.input_lock as Record<string, unknown>;
      const approvalLock = readBody.approval_lock as Record<string, unknown>;
      const questionEnforcement = readBody.question_enforcement as Record<string, unknown>;

      assert.equal(readBody.active, false);
      assert.equal(readBody.current_phase, 'cancelled');
      assert.equal(readBody.completed_at, completedAt);
      assert.equal(readBody.run_outcome, 'cancelled');
      assert.equal(inputLock.active, false);
      assert.equal(inputLock.status, 'released');
      assert.equal(inputLock.released_at, completedAt);
      assert.equal(approvalLock.active, false);
      assert.equal(approvalLock.status, 'released');
      assert.equal(inputLock.release_reason, 'terminal_state_normalization');
      assert.equal(questionEnforcement.status, 'cleared');
      assert.equal(questionEnforcement.clear_reason, 'abort');
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

  it('does not list a mode active when terminal canonical visibility contradicts an active detail state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-terminal-canonical-wins-'));
    try {
      const sessionId = 'sess-terminal-visible';
      const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(wd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
        active: true,
        current_phase: 'deep-interview',
      }, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: false,
        skill: 'autopilot',
        phase: 'complete',
        completed_at: '2026-06-09T00:00:00.000Z',
        session_id: sessionId,
        active_skills: [{ skill: 'autopilot', phase: 'deep-interview', active: true, session_id: sessionId }],
      }, null, 2));

      const response = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });

      assert.deepEqual(response.payload, { active_modes: [] });
      const detailState = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(detailState.active, true);
      assert.equal(detailState.current_phase, 'deep-interview');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('uses the implicit current session canonical state when filtering list-active', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-terminal-canonical-implicit-'));
    try {
      const sessionId = 'sess-terminal-implicit';
      const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(wd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
        active: true,
        current_phase: 'deep-interview',
      }, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: false,
        skill: 'autopilot',
        phase: 'complete',
        completed_at: '2026-06-09T00:00:00.000Z',
        session_id: sessionId,
        active_skills: [{ skill: 'autopilot', phase: 'deep-interview', active: true, session_id: sessionId }],
      }, null, 2));

      const response = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });

      assert.deepEqual(response.payload, { active_modes: [] });
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

  it('finalizes completed ralplan writes across root and current session state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-complete-'));
    try {
      const sessionId = 'sess-ralplan-complete';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        cwd: wd,
      }, null, 2));
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      const staleSkillState = {
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        updated_at: '2026-06-30T00:00:00.000Z',
        session_id: sessionId,
        active_skills: [{
          skill: 'ralplan',
          phase: 'planning',
          active: true,
          session_id: sessionId,
        }],
      };
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify(staleSkillState, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify(staleSkillState, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        terminal_reason: 'consensus approved bounded no-op',
        ralplan_architect_review: {
          verdict: 'APPROVE',
          artifact_path: '.omx/plans/architect.md',
        },
        ralplan_critic_review: {
          verdict: 'APPROVE',
          artifact_path: '.omx/plans/critic.md',
        },
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      const rootRalplan = JSON.parse(await readFile(join(stateDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      const sessionRalplan = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      for (const state of [rootRalplan, sessionRalplan]) {
        assert.equal(state.active, false);
        assert.equal(state.current_phase, 'complete');
        assert.equal(state.status, 'complete');
        assert.equal(state.terminal_reason, 'consensus approved bounded no-op');
        assert.equal((state.ralplan_consensus_gate as Record<string, unknown>).complete, true);
        assert.equal(state.session_id, sessionId);
      }

      const rootSkill = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8')) as Record<string, unknown>;
      const sessionSkill = JSON.parse(await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8')) as Record<string, unknown>;
      for (const state of [rootSkill, sessionSkill]) {
        assert.equal(state.active, false);
        assert.equal(state.phase, 'complete');
        assert.equal(state.terminal_reason, 'consensus approved bounded no-op');
        assert.deepEqual(state.active_skills, []);
      }
      assert.equal(sessionSkill.session_id, sessionId);

      const listed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(listed.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('finalizes ralplan when runtime tracker lags but workspace tracker has completed native reviews', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-runtime-lag-complete-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-runtime-lag-root-'));
    try {
      await withStateRootEnv({ OMX_STATE_ROOT: stateRoot }, async () => {
        const sessionId = 'sess-ralplan-runtime-lag-complete';
        const runtimeStateDir = join(stateRoot, '.omx', 'state');
        const sessionDir = join(runtimeStateDir, 'sessions', sessionId);
        const workspaceStateDir = join(wd, '.omx', 'state');
        await mkdir(sessionDir, { recursive: true });
        await mkdir(workspaceStateDir, { recursive: true });
        await writeFile(join(runtimeStateDir, 'session.json'), JSON.stringify({
          session_id: sessionId,
          native_session_id: 'thread-leader',
          cwd: wd,
        }, null, 2));
        const consensusGate = ralplanConsensusGate(sessionId, 'native_subagent') as {
          ralplan_architect_review: Record<string, unknown>;
          ralplan_critic_review: Record<string, unknown>;
        };
        consensusGate.ralplan_architect_review.completed_at = '2026-07-07T04:30:00.000Z';
        consensusGate.ralplan_critic_review.completed_at = '2026-07-07T04:31:00.000Z';
        await writeFile(subagentTrackingPath(wd), JSON.stringify({
          schemaVersion: 1,
          sessions: {
            [sessionId]: {
              session_id: sessionId,
              leader_thread_id: 'thread-leader',
              updated_at: '2026-07-07T04:31:00.000Z',
              threads: {
                'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-07-07T04:29:00.000Z', last_seen_at: '2026-07-07T04:29:00.000Z', turn_count: 1 },
                'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: '2026-07-07T04:30:00.000Z', last_seen_at: '2026-07-07T04:30:00.000Z', turn_count: 1 },
                'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: '2026-07-07T04:31:00.000Z', last_seen_at: '2026-07-07T04:31:00.000Z', turn_count: 1 },
              },
            },
          },
        }, null, 2));
        await writeFile(join(workspaceStateDir, 'subagent-tracking.json'), JSON.stringify({
          schemaVersion: 1,
          sessions: {
            [sessionId]: {
              session_id: sessionId,
              leader_thread_id: 'thread-leader',
              updated_at: '2026-07-07T04:31:00.000Z',
              threads: {
                'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-07-07T04:29:00.000Z', last_seen_at: '2026-07-07T04:29:00.000Z', turn_count: 1 },
                'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: '2026-07-07T04:30:00.000Z', last_seen_at: '2026-07-07T04:30:00.000Z', completed_at: '2026-07-07T04:30:00.000Z', turn_count: 1 },
                'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: '2026-07-07T04:31:00.000Z', last_seen_at: '2026-07-07T04:31:00.000Z', completed_at: '2026-07-07T04:31:00.000Z', turn_count: 1 },
              },
            },
          },
        }, null, 2));
        await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
          mode: 'ralplan',
          active: true,
          current_phase: 'planning',
          session_id: sessionId,
        }, null, 2));

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'ralplan',
          active: false,
          current_phase: 'complete',
          planning_complete: true,
          latest_plan_path: '.omx/plans/prd-clickstack-otel-consumer-20260707T043000Z.md',
          terminal_reason: 'consensus approved despite runtime tracker lag',
          ralplan_consensus_gate: consensusGate,
        });

        assert.equal(response.isError, undefined);
        const sessionRalplan = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(sessionRalplan.active, false);
        assert.equal(sessionRalplan.current_phase, 'complete');
        assert.equal(sessionRalplan.status, 'complete');
        assert.equal(sessionRalplan.terminal_reason, 'consensus approved despite runtime tracker lag');
        assert.equal((sessionRalplan.ralplan_consensus_gate as Record<string, unknown>).complete, true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('rejects forged ralplan complete gates before mutating active session state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-forged-complete-'));
    try {
      const sessionId = 'sess-ralplan-forged-complete';
      await writeNativeSubagentTracking(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        cwd: wd,
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: {
          complete: true,
        },
      });

      assert.equal(response.isError, true);
      assert.match(String((response.payload as { error?: unknown }).error ?? ''), /tracker-backed native architect and critic consensus evidence/);
      const sessionRalplan = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(sessionRalplan.active, true);
      assert.equal(sessionRalplan.current_phase, 'planning');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows ralplan unsupported native non-clean recovery without tracker-backed consensus', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-unsupported-recovery-'));
    try {
      const sessionId = 'sess-ralplan-unsupported-recovery';
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'blocked',
        native_subagent_support: {
          status: 'unsupported',
          reason: 'multi_agent_v1_unavailable',
          source: 'post_tool_failure',
        },
      });

      assert.equal(response.isError, undefined);
      const state = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(state.active, false);
      assert.equal(state.current_phase, 'blocked');
      assert.equal(state.ralplan_consensus_gate, undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects ralplan clean complete without tracker-backed native consensus after unsupported recovery support', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-clean-still-strict-'));
    try {
      const sessionId = 'sess-ralplan-clean-still-strict';
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
        native_subagent_support: {
          status: 'unsupported',
          reason: 'multi_agent_v1_unavailable',
          source: 'post_tool_failure',
        },
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        status: 'complete',
      });

      assert.equal(response.isError, true);
      assert.match(String((response.payload as { error?: unknown }).error ?? ''), /Cannot complete ralplan cleanly while native subagent support is unavailable/);
      const state = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(state.active, true);
      assert.equal(state.current_phase, 'planning');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects ralplan clean complete with unsupported evidence even when native consensus is valid', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-clean-unsupported-valid-consensus-deny-'));
    try {
      const sessionId = 'sess-ralplan-clean-unsupported-valid-consensus-deny';
      await writeNativeSubagentTracking(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        status: 'complete',
        native_subagent_support: {
          status: 'unsupported',
          reason: 'multi_agent_v1_unavailable',
          source: 'post_tool_failure',
        },
        ralplan_consensus_gate: ralplanConsensusGate(sessionId, 'native_subagent'),
      });

      assert.equal(response.isError, true);
      assert.match(String((response.payload as { error?: unknown }).error ?? ''), /Cannot complete ralplan cleanly while native subagent support is unavailable/);
      const state = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(state.active, true);
      assert.equal(state.current_phase, 'planning');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects ralplan clean complete with handoff-artifact unsupported evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-clean-handoff-unsupported-deny-'));
    try {
      const sessionId = 'sess-ralplan-clean-handoff-unsupported-deny';
      await writeNativeSubagentTracking(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        status: 'complete',
        handoff_artifacts: {
          ralplan: {
            native_subagent_support: {
              status: 'unsupported',
              reason: 'multi_agent_v1_unavailable',
              source: 'post_tool_failure',
            },
          },
        },
        ralplan_consensus_gate: ralplanConsensusGate(sessionId, 'native_subagent'),
      });

      assert.equal(response.isError, true);
      assert.match(String((response.payload as { error?: unknown }).error ?? ''), /Cannot complete ralplan cleanly while native subagent support is unavailable/);
      const state = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(state.active, true);
      assert.equal(state.current_phase, 'planning');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects ralplan clean complete with nested handoff-artifact unsupported evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-clean-nested-handoff-unsupported-deny-'));
    try {
      const sessionId = 'sess-ralplan-clean-nested-handoff-unsupported-deny';
      await writeNativeSubagentTracking(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        status: 'complete',
        state: {
          handoff_artifacts: {
            ralplan: {
              native_subagent_support: {
                status: 'unsupported',
                reason: 'multi_agent_v1_unavailable',
                source: 'post_tool_failure',
              },
            },
          },
        },
        ralplan_consensus_gate: ralplanConsensusGate(sessionId, 'native_subagent'),
      });

      assert.equal(response.isError, true);
      assert.match(String((response.payload as { error?: unknown }).error ?? ''), /Cannot complete ralplan cleanly while native subagent support is unavailable/);
      const state = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(state.active, true);
      assert.equal(state.current_phase, 'planning');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects ralplan clean complete with handoff-root unsupported evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-clean-handoff-root-unsupported-deny-'));
    try {
      const sessionId = 'sess-ralplan-clean-handoff-root-unsupported-deny';
      await writeNativeSubagentTracking(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        status: 'complete',
        handoff_artifacts: {
          native_subagent_support: {
            status: 'unsupported',
            reason: 'multi_agent_v1_unavailable',
            source: 'post_tool_failure',
          },
          ralplan_consensus_gate: ralplanConsensusGate(sessionId, 'native_subagent'),
        },
      });

      assert.equal(response.isError, true);
      assert.match(String((response.payload as { error?: unknown }).error ?? ''), /Cannot complete ralplan cleanly while native subagent support is unavailable/);
      const state = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(state.active, true);
      assert.equal(state.current_phase, 'planning');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects ralplan clean status alias with unsupported evidence even when native consensus is valid', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-status-alias-unsupported-deny-'));
    try {
      const sessionId = 'sess-ralplan-status-alias-unsupported-deny';
      await writeNativeSubagentTracking(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        status: 'complete',
        native_subagent_support: {
          status: 'unsupported',
          reason: 'multi_agent_v1_unavailable',
          source: 'post_tool_failure',
        },
        ralplan_consensus_gate: ralplanConsensusGate(sessionId, 'native_subagent'),
      });

      assert.equal(response.isError, true);
      assert.match(String((response.payload as { error?: unknown }).error ?? ''), /Cannot complete ralplan cleanly while native subagent support is unavailable/);
      const state = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(state.active, true);
      assert.equal(state.current_phase, 'planning');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('normalizes currentPhase before gating ralplan terminal writes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-current-phase-alias-'));
    try {
      const sessionId = 'sess-ralplan-current-phase-alias';
      await writeNativeSubagentTracking(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        cwd: wd,
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralplan',
        active: false,
        currentPhase: 'complete',
      });

      assert.equal(response.isError, true);
      assert.match(String((response.payload as { error?: unknown }).error ?? ''), /tracker-backed native architect and critic consensus evidence/);
      const sessionRalplan = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(sessionRalplan.active, true);
      assert.equal(sessionRalplan.current_phase, 'planning');
      assert.equal(sessionRalplan.currentPhase, undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('reuses existing tracker-backed ralplan consensus when terminal writes omit gate payload', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-existing-consensus-'));
    try {
      const sessionId = 'sess-ralplan-existing-consensus';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        cwd: wd,
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
        ralplan_consensus_gate: consensusGate,
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        terminal_reason: 'existing tracker-backed consensus complete',
      });

      assert.equal(response.isError, undefined);
      const sessionRalplan = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(sessionRalplan.active, false);
      assert.equal(sessionRalplan.current_phase, 'complete');
      const finalGate = sessionRalplan.ralplan_consensus_gate as Record<string, unknown>;
      assert.equal(finalGate.complete, true);
      assert.deepEqual(finalGate.required_review_roles, ['architect', 'critic']);
      assert.equal((finalGate.ralplan_architect_review as Record<string, unknown>).provenance_kind, 'native_subagent');
      assert.equal((finalGate.ralplan_critic_review as Record<string, unknown>).provenance_kind, 'native_subagent');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('finalizes completed ralplan updateModeState writes across root and current session state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-complete-update-mode-'));
    try {
      const sessionId = 'sess-ralplan-complete-update-mode';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        cwd: wd,
      }, null, 2));
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      const staleSkillState = {
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        session_id: sessionId,
        active_skills: [{
          skill: 'ralplan',
          phase: 'planning',
          active: true,
          session_id: sessionId,
        }],
      };
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify(staleSkillState, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify(staleSkillState, null, 2));

      await updateModeState('ralplan', {
        active: false,
        current_phase: 'complete',
        terminal_reason: 'runtime consensus complete',
        ralplan_consensus_gate: consensusGate,
      }, wd);

      const rootRalplan = JSON.parse(await readFile(join(stateDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      const sessionRalplan = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      for (const state of [rootRalplan, sessionRalplan]) {
        assert.equal(state.active, false);
        assert.equal(state.current_phase, 'complete');
        assert.equal(state.status, 'complete');
        assert.equal(state.terminal_reason, 'runtime consensus complete');
        assert.equal((state.ralplan_consensus_gate as Record<string, unknown>).complete, true);
        assert.equal(state.session_id, sessionId);
      }

      const rootSkill = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8')) as Record<string, unknown>;
      const sessionSkill = JSON.parse(await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8')) as Record<string, unknown>;
      for (const state of [rootSkill, sessionSkill]) {
        assert.equal(state.active, false);
        assert.equal(state.phase, 'complete');
        assert.equal(state.terminal_reason, 'runtime consensus complete');
        assert.deepEqual(state.active_skills, []);
      }

      const rootListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(rootListed.payload, { active_modes: [] });

      const sessionListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(sessionListed.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects forged ralplan complete gates from updateModeState before mutating active state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-update-mode-forged-complete-'));
    try {
      const sessionId = 'sess-ralplan-update-mode-forged-complete';
      await writeNativeSubagentTracking(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        cwd: wd,
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));

      await assert.rejects(
        updateModeState('ralplan', {
          active: false,
          current_phase: 'complete',
          ralplan_consensus_gate: {
            complete: true,
          },
        }, wd),
        /architect and critic consensus evidence/,
      );

      const sessionRalplan = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(sessionRalplan.active, true);
      assert.equal(sessionRalplan.current_phase, 'planning');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('activates deep-interview when terminal Team detail outranks foreign legacy mirrors', async () => {
    await withStateRootEnv({}, async () => {
      const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-stale-team-transition-'));
      try {
        const stateDir = join(wd, '.omx', 'state');
        await mkdir(stateDir, { recursive: true });
        const teamState = { active: false, mode: 'team', current_phase: 'cancelled', run_outcome: 'continue' };
        const foreignSkillState = {
          version: 1,
          active: true,
          skill: 'team',
          phase: 'team-exec',
          current_phase: 'cancelled',
          session_id: 'foreign-team-session',
          active_skills: [{ skill: 'team', phase: 'team-exec', active: true }],
        };
        const runState = { version: 1, mode: 'team', active: true, outcome: 'continue', current_phase: 'team-exec' };
        await writeFile(join(stateDir, 'team-state.json'), JSON.stringify(teamState, null, 2));
        await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify(foreignSkillState, null, 2));
        await writeFile(join(stateDir, 'run-state.json'), JSON.stringify(runState, null, 2));

        const beforeList = await executeStateOperation('state_list_active', { workingDirectory: wd });
        const beforeTeam = await executeStateOperation('state_read', { workingDirectory: wd, mode: 'team' });
        assert.deepEqual(beforeList.payload, { active_modes: ['run'] });
        assert.deepEqual(beforeTeam.payload, teamState);

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          mode: 'deep-interview',
          active: true,
          current_phase: 'deep-interview',
          state: { interview_id: 'fixture', profile: 'quick', type: 'brownfield' },
        });

        const payload = responsePayload<{ success: boolean; path: string }>(response);
        assert.equal(payload.success, true);
        assert.equal(payload.path, join(stateDir, 'deep-interview-state.json'));
        assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'team-state.json'), 'utf-8')), teamState);
        assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'run-state.json'), 'utf-8')), runState);
        assert.equal(existsSync(join(stateDir, 'sessions', 'foreign-team-session', 'deep-interview-state.json')), false);

        assert.deepEqual(
          JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8')),
          foreignSkillState,
        );
        const afterList = await executeStateOperation('state_list_active', { workingDirectory: wd });
        assert.deepEqual(afterList.payload, { active_modes: ['deep-interview', 'run'] });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  });
  it('fails closed without mutating root state when ralplan terminalization sees a foreign session pointer', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-stale-session-'));
    try {
      const staleSessionId = 'sess-ralplan-stale';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, staleSessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', staleSessionId);
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: staleSessionId,
        cwd: join(wd, 'different-project'),
      }, null, 2));
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: staleSessionId,
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        session_id: staleSessionId,
        active_skills: [
          {
            skill: 'ralplan',
            phase: 'planning',
            active: true,
          },
          {
            skill: 'ralplan',
            phase: 'planning',
            active: true,
            session_id: staleSessionId,
          },
        ],
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        status: 'complete',
        terminal_reason: 'consensus approved bounded no-op',
        state: {
          session_id: staleSessionId,
          ralplan_consensus_gate: consensusGate,
        },
      });

      assert.equal(response.isError, true);
      assert.deepEqual(response.payload, { error: WRITABLE_STATE_SCOPE_ERRORS.unusableSession });
      const rootRalplan = JSON.parse(await readFile(join(stateDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(rootRalplan.active, true);
      assert.equal(rootRalplan.current_phase, 'planning');
      assert.equal(rootRalplan.session_id, staleSessionId);
      const rootSkill = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(rootSkill.active, true);
      assert.equal(rootSkill.phase, 'planning');
      assert.equal(Array.isArray(rootSkill.active_skills), true);
      assert.equal(existsSync(join(sessionDir, 'ralplan-state.json')), false);
      assert.equal(existsSync(join(sessionDir, 'skill-active-state.json')), false);

      const listed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(listed.payload, { active_modes: ['ralplan'] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not hide unrelated root detail state when ralplan terminalizes without canonical state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-root-detail-only-'));
    try {
      const sessionId = 'sess-ralplan-root-detail-only';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'team-state.json'), JSON.stringify({
        mode: 'team',
        active: true,
        current_phase: 'running',
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        state: {
          session_id: sessionId,
          ralplan_consensus_gate: consensusGate,
        },
      });

      assert.equal(response.isError, undefined);
      assert.equal(existsSync(join(stateDir, 'skill-active-state.json')), false);

      const listed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(listed.payload, { active_modes: ['team'] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves an unrelated active root ralplan when a session ralplan terminalizes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-preserve-root-'));
    try {
      const sessionId = 'sess-ralplan-preserve-root';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        active_skills: [
          {
            skill: 'ralplan',
            phase: 'planning',
            active: true,
          },
          {
            skill: 'ralplan',
            phase: 'planning',
            active: true,
            session_id: sessionId,
          },
        ],
      }, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        session_id: sessionId,
        active_skills: [{
          skill: 'ralplan',
          phase: 'planning',
          active: true,
          session_id: sessionId,
        }],
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        status: 'complete',
        terminal_reason: 'consensus approved bounded no-op',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      const rootRalplan = JSON.parse(await readFile(join(stateDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(rootRalplan.active, true);
      assert.equal(rootRalplan.current_phase, 'planning');
      assert.equal(rootRalplan.session_id, undefined);

      const sessionRalplan = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(sessionRalplan.active, false);
      assert.equal(sessionRalplan.current_phase, 'complete');
      assert.equal(sessionRalplan.session_id, sessionId);

      const rootSkill = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8')) as {
        active: boolean;
        skill: string;
        phase: string;
        active_skills?: Array<{ skill: string; session_id?: string }>;
      };
      assert.equal(rootSkill.active, true);
      assert.equal(rootSkill.skill, 'ralplan');
      assert.deepEqual(rootSkill.active_skills, [{ skill: 'ralplan', phase: 'planning', active: true }]);

      const rootListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(rootListed.payload, { active_modes: ['ralplan'] });

      const sessionListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(sessionListed.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not hide a legacy active root ralplan detail state when a session ralplan terminalizes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-legacy-root-detail-'));
    try {
      const sessionId = 'sess-ralplan-legacy-root-detail';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        session_id: sessionId,
        active_skills: [{
          skill: 'ralplan',
          phase: 'planning',
          active: true,
          session_id: sessionId,
        }],
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      assert.equal(existsSync(join(stateDir, 'skill-active-state.json')), false);

      const rootListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(rootListed.payload, { active_modes: ['ralplan'] });

      const sessionListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(sessionListed.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes an empty session-only root mirror when a session ralplan terminalizes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-empty-root-mirror-'));
    try {
      const sessionId = 'sess-ralplan-empty-root-mirror';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        session_id: sessionId,
        active_skills: [{
          skill: 'ralplan',
          phase: 'planning',
          active: true,
          session_id: sessionId,
        }],
      }, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        session_id: sessionId,
        active_skills: [{
          skill: 'ralplan',
          phase: 'planning',
          active: true,
          session_id: sessionId,
        }],
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      assert.equal(existsSync(join(stateDir, 'skill-active-state.json')), false);

      const rootListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(rootListed.payload, { active_modes: ['ralplan'] });

      const sessionListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(sessionListed.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves run_outcome-only root canonical tombstones when a session ralplan terminalizes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-preserve-root-tombstone-'));
    try {
      const sessionId = 'sess-ralplan-root-tombstone';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'team-state.json'), JSON.stringify({
        mode: 'team',
        active: true,
        current_phase: 'running',
      }, null, 2));
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'team',
        run_outcome: 'finish',
        active_skills: [{
          skill: 'team',
          active: true,
        }],
      }, null, 2));

      const before = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(before.payload, { active_modes: [] });

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      const rootSkill = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8')) as {
        active: boolean;
        run_outcome?: string;
      };
      assert.equal(rootSkill.active, true);
      assert.equal(rootSkill.run_outcome, 'finish');

      const rootListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(rootListed.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes terminal_reason-only active root canonical state when a session ralplan terminalizes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-terminal-reason-only-'));
    try {
      const sessionId = 'sess-ralplan-terminal-reason-only';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        terminal_reason: 'stale reason without terminal marker',
        active_skills: [{
          skill: 'ralplan',
          active: true,
          session_id: sessionId,
        }],
      }, null, 2));

      const before = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(before.payload, { active_modes: ['ralplan'] });

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      assert.equal(existsSync(join(stateDir, 'skill-active-state.json')), false);

      const rootListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(rootListed.payload, { active_modes: ['ralplan'] });

      const sessionListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(sessionListed.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes non-terminal lifecycle_outcome root canonical state when a session ralplan terminalizes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-lifecycle-nonterminal-'));
    try {
      const sessionId = 'sess-ralplan-lifecycle-nonterminal';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        lifecycle_outcome: 'progress',
        active_skills: [{
          skill: 'ralplan',
          active: true,
          session_id: sessionId,
        }],
      }, null, 2));

      const before = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(before.payload, { active_modes: ['ralplan'] });

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      assert.equal(existsSync(join(stateDir, 'skill-active-state.json')), false);

      const rootListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(rootListed.payload, { active_modes: ['ralplan'] });

      const sessionListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(sessionListed.payload, { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves unrelated active session skills when ralplan terminalizes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-preserve-'));
    try {
      const sessionId = 'sess-ralplan-preserve';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        cwd: wd,
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(sessionDir, 'autoresearch-state.json'), JSON.stringify({
        mode: 'autoresearch',
        active: true,
        current_phase: 'running',
        session_id: sessionId,
      }, null, 2));
      const mixedSkillState = {
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        updated_at: '2026-06-30T00:00:00.000Z',
        session_id: sessionId,
        active_skills: [
          {
            skill: 'ralplan',
            phase: 'planning',
            active: true,
            session_id: sessionId,
          },
          {
            skill: 'autoresearch',
            phase: 'running',
            active: true,
            session_id: sessionId,
          },
        ],
      };
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify(mixedSkillState, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify(mixedSkillState, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        status: 'complete',
        terminal_reason: 'consensus approved bounded no-op',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      const rootSkill = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8')) as {
        active: boolean;
        skill: string;
        phase: string;
        active_skills?: Array<{ skill: string; phase?: string; session_id?: string }>;
      };
      const sessionSkill = JSON.parse(await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8')) as {
        active: boolean;
        skill: string;
        phase: string;
        active_skills?: Array<{ skill: string; phase?: string; session_id?: string }>;
      };
      for (const state of [rootSkill, sessionSkill]) {
        assert.equal(state.active, true);
        assert.equal(state.skill, 'autoresearch');
        assert.equal(state.phase, 'running');
        assert.deepEqual(state.active_skills?.map((entry) => entry.skill), ['autoresearch']);
        assert.deepEqual(state.active_skills?.map((entry) => entry.session_id), [sessionId]);
      }

      const listed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(listed.payload, { active_modes: ['autoresearch'] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves same-session root mirror skills when session canonical state is partial', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-partial-session-skill-'));
    try {
      const sessionId = 'sess-ralplan-partial-session-skill';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(sessionDir, 'team-state.json'), JSON.stringify({
        mode: 'team',
        active: true,
        current_phase: 'running',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        session_id: sessionId,
        active_skills: [
          {
            skill: 'ralplan',
            phase: 'planning',
            active: true,
            session_id: sessionId,
          },
          {
            skill: 'team',
            phase: 'running',
            active: true,
            session_id: sessionId,
          },
        ],
      }, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        session_id: sessionId,
        active_skills: [{
          skill: 'ralplan',
          phase: 'planning',
          active: true,
          session_id: sessionId,
        }],
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      const sessionSkill = JSON.parse(await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8')) as {
        active: boolean;
        skill: string;
        phase: string;
        session_id?: string;
        active_skills?: Array<{ skill: string; phase?: string; session_id?: string }>;
      };
      assert.equal(sessionSkill.active, true);
      assert.equal(sessionSkill.skill, 'team');
      assert.equal(sessionSkill.phase, 'running');
      assert.equal(sessionSkill.session_id, sessionId);
      assert.deepEqual(sessionSkill.active_skills?.map((entry) => entry.skill), ['team']);
      assert.deepEqual(sessionSkill.active_skills?.map((entry) => entry.session_id), [sessionId]);

      const sessionListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(sessionListed.payload, { active_modes: ['team'] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('clears stale terminal phase aliases when preserving same-session root mirror skills', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-terminal-session-skill-'));
    try {
      const sessionId = 'sess-ralplan-terminal-session-skill';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(sessionDir, 'team-state.json'), JSON.stringify({
        mode: 'team',
        active: true,
        current_phase: 'running',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralplan',
        phase: 'planning',
        session_id: sessionId,
        active_skills: [
          {
            skill: 'ralplan',
            phase: 'planning',
            active: true,
            session_id: sessionId,
          },
          {
            skill: 'team',
            active: true,
            session_id: sessionId,
          },
        ],
      }, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: false,
        skill: 'ralplan',
        phase: 'blocked',
        session_id: sessionId,
        completed_at: '2026-06-30T00:00:00.000Z',
        terminal_reason: 'stale terminal marker',
        active_skills: [],
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      const sessionSkill = JSON.parse(await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8')) as {
        active: boolean;
        skill: string;
        phase: string;
        completed_at?: string;
        terminal_reason?: string;
        active_skills?: Array<{ skill: string; phase?: string; session_id?: string }>;
      };
      assert.equal(sessionSkill.active, true);
      assert.equal(sessionSkill.skill, 'team');
      assert.equal(sessionSkill.phase, '');
      assert.equal(sessionSkill.completed_at, undefined);
      assert.equal(sessionSkill.terminal_reason, undefined);
      assert.deepEqual(sessionSkill.active_skills?.map((entry) => entry.skill), ['team']);

      const sessionListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(sessionListed.payload, { active_modes: ['team'] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not hide detail-only active session state when ralplan terminalizes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-session-detail-only-'));
    try {
      const sessionId = 'sess-ralplan-session-detail-only';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(sessionDir, 'autoresearch-state.json'), JSON.stringify({
        mode: 'autoresearch',
        active: true,
        current_phase: 'running',
        session_id: sessionId,
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      assert.equal(existsSync(join(sessionDir, 'skill-active-state.json')), false);

      const listed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(listed.payload, { active_modes: ['autoresearch'] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not seed session canonical state from root-only skills when ralplan terminalizes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-ralplan-root-only-skill-'));
    try {
      const sessionId = 'sess-ralplan-root-only-skill';
      const consensusGate = await writeNativeRalplanConsensusGate(wd, sessionId);
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'autoresearch-state.json'), JSON.stringify({
        mode: 'autoresearch',
        active: true,
        current_phase: 'running',
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'autoresearch',
        phase: 'running',
        active_skills: [{
          skill: 'autoresearch',
          phase: 'running',
          active: true,
        }],
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(sessionDir, 'team-state.json'), JSON.stringify({
        mode: 'team',
        active: true,
        current_phase: 'running',
        session_id: sessionId,
      }, null, 2));

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: false,
        current_phase: 'complete',
        ralplan_consensus_gate: consensusGate,
      });

      assert.equal(response.isError, undefined);
      assert.equal(existsSync(join(sessionDir, 'skill-active-state.json')), false);

      const rootListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
      });
      assert.deepEqual(rootListed.payload, { active_modes: ['autoresearch'] });

      const sessionListed = await executeStateOperation('state_list_active', {
        workingDirectory: wd,
        session_id: sessionId,
      });
      assert.deepEqual(sessionListed.payload, { active_modes: ['team'] });
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

  it('does not reject planning writes from stale detail-only execution state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-stale-detail-rollback-'));
    try {
      const sessionId = 'sess-stale-detail';
      const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'ralph-state.json'),
        JSON.stringify({
          active: true,
          current_phase: 'executing',
        }, null, 2),
      );

      const written = await executeStateOperation('state_write', {
        workingDirectory: wd,
        session_id: sessionId,
        mode: 'ralplan',
        active: true,
        current_phase: 'planning',
      });

      assert.equal(written.isError, undefined);
      assert.equal(existsSync(join(sessionDir, 'ralplan-state.json')), true);
      const canonical = JSON.parse(
        await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string }> };
      assert.deepEqual(canonical.active_skills?.map((entry) => entry.skill), ['ralplan']);
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
        await writeFile(
          join(sessionDir, 'skill-active-state.json'),
          JSON.stringify({
            active: true,
            skill: 'autopilot',
            phase: 'deep-interview',
            session_id: sessionId,
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

  it('rejects standalone ralplan writes from detail-only active Autopilot supervisor state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-detail-only-ralplan-child-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-detail-only-ralplan-child';
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
        assert.match(String((denied.payload as { error?: string }).error || ''), /Cannot write ralplan: autopilot is already active\./);
        assert.match(String((denied.payload as { error?: string }).error || ''), /Execution-to-planning rollback auto-complete is not allowed\./);
        assert.equal(existsSync(join(sessionDir, 'ralplan-state.json')), false);
        assert.equal(existsSync(join(sessionDir, 'skill-active-state.json')), false);

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

  it('lets canonical ralplan authority override stale detail-only Autopilot state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-canonical-ralplan-stale-autopilot-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-canonical-ralplan-stale-autopilot';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'skill-active-state.json'),
          JSON.stringify({
            active: true,
            skill: 'ralplan',
            phase: 'planning',
            session_id: sessionId,
            active_skills: [{ skill: 'ralplan', phase: 'planning', active: true, session_id: sessionId }],
          }, null, 2),
        );
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            session_id: sessionId,
          }, null, 2),
        );

        const written = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'ralplan',
          active: true,
          current_phase: 'critic-review',
        });

        assert.equal(written.isError, undefined);
        assert.equal(existsSync(join(sessionDir, 'ralplan-state.json')), true);

        const canonical = JSON.parse(
          await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8'),
        ) as { active_skills?: Array<{ skill: string }> };
        assert.deepEqual(canonical.active_skills?.map((entry) => entry.skill), ['ralplan']);

        const autopilotState = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(autopilotState.active, true);
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

  it('allows Autopilot deep-interview to ralplan handoff with required valid execution contract strides', async () => {
    for (const stride of ['task', 'deliverable', 'milestone'] as const) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-execution-contract-${stride}-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-execution-contract-${stride}`;
          const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, 'autopilot-state.json'),
            JSON.stringify({
              active: true,
              mode: 'autopilot',
              current_phase: 'deep-interview',
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
                rationale: `The ${stride} stride is explicitly contracted for planning.`,
              },
              handoff_artifacts: {
                deep_interview: {
                  summary: `Ready for ralplan with ${stride} stride.`,
                  execution_contract_required: true,
                  execution_contract: validExecutionContract(stride),
                },
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
    }
  });

  it('allows partial Autopilot ralplan handoff writes when a required execution contract is already persisted', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-execution-contract-partial-write-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-execution-contract-partial-write';
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
                rationale: 'The persisted interview artifact already defines the milestone contract.',
              },
              handoff_artifacts: {
                deep_interview: {
                  summary: 'Ready for ralplan with a persisted milestone execution contract.',
                  execution_contract_required: true,
                  execution_contract: validExecutionContract('milestone'),
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
        assert.equal(state.current_phase, 'ralplan');
        assert.deepEqual(
          ((state.state as Record<string, unknown>).handoff_artifacts as Record<string, unknown>).deep_interview,
          {
            summary: 'Ready for ralplan with a persisted milestone execution contract.',
            execution_contract_required: true,
            execution_contract: validExecutionContract('milestone'),
          },
        );
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot deep-interview handoff when execution contract is required but missing or invalid', async () => {
    for (const [caseName, deepInterviewHandoff] of Object.entries({
      missing: {
        summary: 'Execution contract was required but omitted.',
        execution_contract_required: true,
      },
      wrongStrideFields: {
        summary: 'Execution contract mismatches its stride semantics.',
        execution_contract_required: true,
        execution_contract: {
          ...validExecutionContract('deliverable'),
          allow_task_shrink: true,
        },
      },
      legacyPhaseEnum: {
        summary: 'Legacy phase enum must not be accepted as an execution stride.',
        execution_contract_required: true,
        execution_contract: {
          ...validExecutionContract('milestone'),
          execution_stride: 'phase',
        },
      },
      invalidSource: {
        summary: 'Contract provenance must be deep-interview.',
        execution_contract_required: true,
        execution_contract: {
          ...validExecutionContract('task'),
          source: 'ralplan',
        },
      },
      invalidSelection: {
        summary: 'Contract selected_by must be user or default.',
        execution_contract_required: true,
        execution_contract: {
          ...validExecutionContract('task'),
          selected_by: 'inferred',
        },
      },
    })) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-execution-contract-deny-${caseName}-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-execution-contract-deny-${caseName}`;
          const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, 'autopilot-state.json'),
            JSON.stringify({
              active: true,
              mode: 'autopilot',
              current_phase: 'deep-interview',
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
                rationale: 'The interview is complete but the required contract is not valid.',
              },
              handoff_artifacts: {
                deep_interview: deepInterviewHandoff,
              },
            },
          });

          assert.equal(response.isError, true);
          assert.match(String((response.payload as { error?: string }).error || ''), /execution_contract/i);
          const state = JSON.parse(
            await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
          ) as Record<string, unknown>;
          assert.equal(state.current_phase, 'deep-interview');
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('preserves Autopilot legacy behavior when execution contract is absent or not required', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-execution-contract-not-required-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-execution-contract-not-required';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
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
              rationale: 'No execution contract was required for this legacy handoff.',
            },
            handoff_artifacts: {
              deep_interview: {
                summary: 'Ready for ralplan with legacy behavior.',
                execution_contract_required: false,
                execution_contract: {
                  version: 1,
                  execution_stride: 'phase',
                },
              },
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

  it('honors all documented execution contract required marker locations and runtime aliases', async () => {
    const aliasContract = {
      version: 1,
      executionStride: 'deliverable',
      source: 'deep-interview',
      selected_by: 'user',
      allowTaskShrink: false,
      completionUnit: 'The named deliverable',
      stopCondition: 'Stop after the deliverable is complete and verified',
      acceptanceCoverageScope: 'deliverable',
      shrinkPolicy: 'ask_before_shrink',
    };

    for (const [caseName, topLevelPatch, nestedPatch, handoffPatch] of [
      ['gate', {}, { deep_interview_gate: { execution_contract_required: true } }, {}],
      ['top-level', { execution_contract_required: true }, {}, {}],
      ['nested-state', {}, { execution_contract_required: true }, {}],
      ['handoff', {}, {}, { execution_contract_required: true }],
      ['handoff-camel', {}, {}, { executionContractRequired: true }],
    ] as const) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-execution-contract-marker-${caseName}-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-execution-contract-marker-${caseName}`;
          const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, 'autopilot-state.json'),
            JSON.stringify({
              active: true,
              mode: 'autopilot',
              current_phase: 'deep-interview',
            }, null, 2),
          );

          const response = await executeStateOperation('state_write', {
            workingDirectory: wd,
            session_id: sessionId,
            mode: 'autopilot',
            active: true,
            current_phase: 'ralplan',
            ...topLevelPatch,
            state: {
              ...nestedPatch,
              deep_interview_gate: {
                status: 'complete',
                rationale: `The ${caseName} marker requires a valid execution contract.`,
                ...((nestedPatch as { deep_interview_gate?: Record<string, unknown> }).deep_interview_gate ?? {}),
              },
              handoff_artifacts: {
                deep_interview: {
                  summary: `Ready for ralplan with ${caseName} required marker.`,
                  execution_contract: aliasContract,
                  ...handoffPatch,
                },
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
    }
  });

  it('denies stale valid execution contracts from masking an invalid next-state contract', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-execution-contract-precedence-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-execution-contract-precedence';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'deep-interview',
            state: {
              handoff_artifacts: {
                deep_interview: {
                  summary: 'Stale current-state contract must not rescue nextState.',
                  execution_contract_required: true,
                  execution_contract: validExecutionContract('milestone'),
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
          state: {
            execution_contract: {
              ...validExecutionContract('milestone'),
              shrink_policy: 'allowed',
            },
            deep_interview_gate: {
              status: 'complete',
              rationale: 'Resulting next state carries an invalid higher-priority contract.',
            },
            handoff_artifacts: {
              deep_interview: {
                summary: 'Valid handoff contract must not mask invalid direct/nested contract.',
                execution_contract_required: true,
                execution_contract: validExecutionContract('milestone'),
              },
            },
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /execution_contract/i);
        const state = JSON.parse(
          await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
        ) as Record<string, unknown>;
        assert.equal(state.current_phase, 'deep-interview');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('supports direct execution contract compatibility while rejecting invalid handoff contracts', async () => {
    for (const [caseName, handoffPatch, shouldAllow] of [
      ['missing-handoff-contract', {}, true],
      ['invalid-handoff-contract', { execution_contract: { ...validExecutionContract('deliverable'), source: 'ralplan' } }, false],
    ] as const) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-execution-contract-${caseName}-handoff-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-contract-${caseName}`;
          const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, 'autopilot-state.json'),
            JSON.stringify({
              active: true,
              mode: 'autopilot',
              current_phase: 'deep-interview',
            }, null, 2),
          );

          const response = await executeStateOperation('state_write', {
            workingDirectory: wd,
            session_id: sessionId,
            mode: 'autopilot',
            active: true,
            current_phase: 'ralplan',
            state: {
              execution_contract: validExecutionContract('deliverable'),
              deep_interview_gate: {
                status: 'complete',
                rationale: 'A compatibility direct contract may satisfy a marker, but invalid handoff data fails first.',
              },
              handoff_artifacts: {
                deep_interview: {
                  summary: 'Handoff marker requires the handoff contract to be valid too.',
                  execution_contract_required: true,
                  ...handoffPatch,
                },
              },
            },
          });

          assert.equal(response.isError, shouldAllow ? undefined : true);
          if (!shouldAllow) {
            assert.match(String((response.payload as { error?: string }).error || ''), /execution_contract/i);
          }
          const state = JSON.parse(
            await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
          ) as Record<string, unknown>;
          assert.equal(state.current_phase, shouldAllow ? 'ralplan' : 'deep-interview');
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('applies required execution contract validation to explicit Autopilot deep-interview skip gates', async () => {
    for (const [caseName, deepInterviewHandoff, shouldAllow] of [
      ['missing', { summary: 'Skip is authorized, but contract is missing.', execution_contract_required: true }, false],
      ['valid', {
        summary: 'Skip is authorized and the required contract is present.',
        execution_contract_required: true,
        execution_contract: validExecutionContract('task'),
      }, true],
    ] as const) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-execution-contract-skip-${caseName}-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-execution-contract-skip-${caseName}`;
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
                handoff_artifacts: {
                  deep_interview: deepInterviewHandoff,
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

          assert.equal(response.isError, shouldAllow ? undefined : true);
          if (!shouldAllow) {
            assert.match(String((response.payload as { error?: string }).error || ''), /execution_contract/i);
          }
          const state = JSON.parse(
            await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
          ) as Record<string, unknown>;
          assert.equal(state.current_phase, shouldAllow ? 'ralplan' : 'deep-interview');
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
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

  it('allows Autopilot ralplan unsupported native non-clean recovery', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ralplan-unsupported-recovery-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ralplan-unsupported-recovery';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
          active: true,
          mode: 'autopilot',
          current_phase: 'ralplan',
        }, null, 2));

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'blocked',
          native_subagent_support: {
            status: 'unsupported',
            reason: 'multi_agent_v1_unavailable',
            source: 'post_tool_failure',
          },
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, false);
        assert.equal(state.current_phase, 'blocked');
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

  it('denies Autopilot ralplan to ultragoal when unsupported native evidence is present', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ralplan-unsupported-ultragoal-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ralplan-unsupported-ultragoal-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
          active: true,
          mode: 'autopilot',
          current_phase: 'ralplan',
          native_subagent_support: {
            status: 'unsupported',
            reason: 'native_subagents_unsupported',
            source: 'post_tool_failure',
          },
        }, null, 2));

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ultragoal',
          native_subagent_support: {
            status: 'unsupported',
            reason: 'native_subagents_unsupported',
            source: 'post_tool_failure',
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /Cannot transition ralplan -> ultragoal/i);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot ralplan to ultragoal with unsupported evidence even when native consensus is valid', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ralplan-unsupported-valid-consensus-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ralplan-unsupported-valid-consensus-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeNativeSubagentTracking(wd, sessionId);
        await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
          active: true,
          mode: 'autopilot',
          current_phase: 'ralplan',
          native_subagent_support: {
            status: 'unsupported',
            reason: 'multi_agent_v1_unavailable',
            source: 'post_tool_failure',
          },
          state: {
            handoff_artifacts: {
              ralplan: {
                plan_path: '.omx/plans/prd.md',
                test_spec_path: '.omx/plans/test-spec.md',
              },
              ralplan_consensus_gate: ralplanConsensusGate(sessionId, 'native_subagent'),
            },
          },
        }, null, 2));

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ultragoal',
        });

        assert.equal(response.isError, true);
        const error = String((response.payload as { error?: string }).error || '');
        assert.match(error, /terminalize non-clean/);
        assert.match(error, /blocked\/cancelled\/failed/);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.current_phase, 'ralplan');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  for (const { lane, architectVerdict, criticVerdict } of [
    { lane: 'architect', architectVerdict: 'iterate', criticVerdict: 'approve' },
    { lane: 'critic', architectVerdict: 'approve', criticVerdict: 'iterate' },
  ] as const) {
    it(`denies Autopilot ralplan to ultragoal self-write when ${lane} verdict is iterate despite complete consensus flag`, async () => {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-ralplan-${lane}-iterate-deny-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-ralplan-${lane}-iterate-deny`;
          const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeNativeSubagentTracking(wd, sessionId);
          const consensusGate = ralplanConsensusGate(sessionId, 'native_subagent');
          (consensusGate.ralplan_architect_review as Record<string, unknown>).verdict = architectVerdict;
          (consensusGate.ralplan_critic_review as Record<string, unknown>).verdict = criticVerdict;
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
                  ralplan_consensus_gate: consensusGate,
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
          const error = String((response.payload as { error?: string }).error || '');
          assert.match(error, new RegExp(`${lane}.*verdict=iterate`, 'i'));
          const state = JSON.parse(
            await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'),
          ) as Record<string, unknown>;
          assert.equal(state.current_phase, 'ralplan');
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  }


  it('explains when native ralplan reviews are not present in subagent tracking', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ralplan-native-missing-tracker-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ralplan-native-missing-tracker';
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

        assert.equal(response.isError, true);
        const error = String((response.payload as { error?: string }).error || '');
        assert.match(error, /subagent-tracking\.json/);
        assert.match(error, /only reviews recorded in OMX subagent-tracking\.json count as native lanes/i);
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

  it('denies Autopilot implementation-phase completion before the code-review gate', async () => {
    for (const phase of ['ultragoal', 'rework', 'team', 'ralph']) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-${phase}-complete-deny-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-${phase}-complete-deny`;
          const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, 'autopilot-state.json'),
            JSON.stringify({
              active: true,
              mode: 'autopilot',
              current_phase: phase,
              state: { handoff_artifacts: { ultragoal: { verification: 'passed' } } },
            }, null, 2),
          );

          const response = await executeStateOperation('state_write', {
            workingDirectory: wd,
            session_id: sessionId,
            mode: 'autopilot',
            active: false,
            current_phase: 'complete',
            state: {
              review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review.json' },
              qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/1' },
            },
          });

          assert.equal(response.isError, true);
          assert.match(String((response.payload as { error?: string }).error || ''), /Cannot complete Autopilot before code-review gate/i);
          const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
          assert.equal(state.active, true);
          assert.equal(state.current_phase, phase);
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('denies Autopilot implementation-phase skip directly to ultraqa', async () => {
    for (const phase of ['ultragoal', 'rework', 'team', 'ralph']) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-${phase}-ultraqa-skip-deny-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-${phase}-ultraqa-skip-deny`;
          const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, 'autopilot-state.json'),
            JSON.stringify({
              active: true,
              mode: 'autopilot',
              current_phase: phase,
              state: { handoff_artifacts: { ultragoal: { verification: 'passed' } } },
            }, null, 2),
          );

          const response = await executeStateOperation('state_write', {
            workingDirectory: wd,
            session_id: sessionId,
            mode: 'autopilot',
            active: true,
            current_phase: 'ultraqa',
          });

          assert.equal(response.isError, true);
          assert.match(String((response.payload as { error?: string }).error || ''), /Cannot skip Autopilot code-review gate/i);
          const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
          assert.equal(state.active, true);
          assert.equal(state.current_phase, phase);
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('denies Autopilot code-review completion before the ultraqa gate', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-code-review-complete-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-code-review-complete-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'code-review',
            state: {
              handoff_artifacts: { code_review: { source: 'native-subagent' } },
              review_verdict: { recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          state: {
            review_verdict: { recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true },
            qa_verdict: { clean: true, skipped: false },
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /Cannot complete Autopilot before ultraqa gate/i);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, true);
        assert.equal(state.current_phase, 'code-review');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows Autopilot code-review REQUEST_CHANGES to enter implementation rework', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-review-rework-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-review-rework';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({ active: true, mode: 'autopilot', current_phase: 'code-review', review_cycle: 1 }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'rework',
          review_cycle: 2,
          state: {
            handoff_artifacts: {
              code_review: {
                stage: 'code-review',
                recommendation: 'REQUEST_CHANGES',
                architectural_status: 'CLEAR',
                clean: false,
                artifact_path: '.omx/reviews/code-review-cycle-1.json',
                findings: ['Fix src/implementation.ts'],
              },
            },
            review_verdict: {
              stage: 'code-review',
              recommendation: 'REQUEST_CHANGES',
              architectural_status: 'CLEAR',
              clean: false,
              artifact_path: '.omx/reviews/code-review-cycle-1.json',
              findings: ['Fix src/implementation.ts'],
            },
            return_to_ralplan_reason: null,
          },
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, true);
        assert.equal(state.current_phase, 'rework');
        assert.equal(state.review_cycle, 2);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('replaces stale blocking review state when Autopilot completes with clean latest evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-clean-clears-stale-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-clean-clears-stale';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'ultraqa',
            return_to_ralplan_reason: 'Earlier code-review BLOCK required fixes.',
            handoff_artifacts: {
              code_review: { stage: 'code-review', recommendation: 'REQUEST_CHANGES', architectural_status: 'BLOCK', clean: false, artifact_path: '.omx/reviews/stale-block.json' },
              ultraqa: null,
            },
            state: {
              review_verdict: { stage: 'code-review', recommendation: 'REQUEST_CHANGES', architectural_status: 'BLOCK', clean: false, artifact_path: '.omx/reviews/stale-block.json' },
              qa_verdict: null,
              return_to_ralplan_reason: 'Earlier code-review BLOCK required fixes.',
            },
          }, null, 2),
        );

        const cleanReview = { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review-cycle-2.json' };
        const cleanQa = { stage: 'ultraqa', clean: true, skipped: false, url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/2864' };
        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          completed_at: '2026-06-18T05:00:00.000Z',
          state: {
            review_verdict: cleanReview,
            qa_verdict: cleanQa,
          },
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        const nestedState = state.state as Record<string, unknown>;
        const handoffArtifacts = nestedState.handoff_artifacts as Record<string, unknown>;
        assert.equal(state.active, false);
        assert.equal(state.current_phase, 'complete');
        assert.deepEqual(state.review_verdict, cleanReview);
        assert.deepEqual(state.qa_verdict, cleanQa);
        assert.equal(state.return_to_ralplan_reason, null);
        assert.deepEqual(nestedState.review_verdict, cleanReview);
        assert.deepEqual(nestedState.qa_verdict, cleanQa);
        assert.equal(nestedState.return_to_ralplan_reason, null);
        assert.deepEqual(handoffArtifacts.code_review, cleanReview);
        assert.deepEqual(handoffArtifacts.ultraqa, cleanQa);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot ultraqa completion without clean review and QA evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ultraqa-complete-evidence-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ultraqa-complete-evidence-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'ultraqa',
            state: {
              review_verdict: { recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true },
              qa_verdict: null,
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          state: {
            review_verdict: { recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true },
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /without clean code-review and ultraqa verdict evidence/i);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, true);
        assert.equal(state.current_phase, 'ultraqa');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot implementation and code-review terminalization via inactive ultraqa phase', async () => {
    for (const phase of ['ultragoal', 'rework', 'team', 'ralph', 'code-review']) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-${phase}-inactive-ultraqa-deny-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-${phase}-inactive-ultraqa-deny`;
          const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, 'autopilot-state.json'),
            JSON.stringify({ active: true, mode: 'autopilot', current_phase: phase }, null, 2),
          );

          const response = await executeStateOperation('state_write', {
            workingDirectory: wd,
            session_id: sessionId,
            mode: 'autopilot',
            active: false,
            current_phase: 'ultraqa',
            state: {
              review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review.json' },
              qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/3' },
            },
          });

          assert.equal(response.isError, true);
          assert.match(String((response.payload as { error?: string }).error || ''), /Cannot (complete|skip) Autopilot/i);
          const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
          assert.equal(state.active, true);
          assert.equal(state.current_phase, phase);
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('denies Autopilot ultraqa completion when review and QA provenance are swapped', async () => {
    const cases = [
      {
        name: 'swapped-stage',
        review_verdict: { stage: 'ultraqa', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/state/autopilot-state.json#pipeline_stage_results.ultraqa.artifacts.qa_verdict' },
        qa_verdict: { stage: 'code-review', clean: true, skipped: false, artifact_path: '.omx/state/autopilot-state.json#pipeline_stage_results.code-review.artifacts.review_verdict' },
      },
      {
        name: 'swapped-artifact-path',
        review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/state/autopilot-state.json#pipeline_stage_results.ultraqa.artifacts.qa_verdict' },
        qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, artifact_path: '.omx/state/autopilot-state.json#pipeline_stage_results.code-review.artifacts.review_verdict' },
      },
      {
        name: 'review-uses-ultraqa-provenance',
        review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/ultraqa/qa-verdict.json' },
        qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, artifact_path: '.omx/qa/qa-verdict.json' },
      },
      {
        name: 'qa-uses-code-review-provenance',
        review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review.json' },
        qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, artifact_path: '.omx/reviews/code-review.json' },
      },
      {
        name: 'shared-neutral-provenance',
        review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/evidence/shared.json' },
        qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, artifact_path: '.omx/evidence/shared.json' },
      },
    ];

    for (const testCase of cases) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-ultraqa-${testCase.name}-deny-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-ultraqa-${testCase.name}-deny`;
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({ active: true, mode: 'autopilot', current_phase: 'ultraqa' }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          state: {
            review_verdict: testCase.review_verdict,
            qa_verdict: testCase.qa_verdict,
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /without clean code-review and ultraqa verdict evidence/i);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, true);
        assert.equal(state.current_phase, 'ultraqa');
      });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('denies Autopilot ultraqa completion with self-attested clean verdicts but no durable provenance', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ultraqa-self-attested-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ultraqa-self-attested-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'ultraqa',
            state: {
              review_verdict: { recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true },
              qa_verdict: { clean: true, skipped: false },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          state: {
            review_verdict: { recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true },
            qa_verdict: { clean: true, skipped: false },
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /without clean code-review and ultraqa verdict evidence/i);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, true);
        assert.equal(state.current_phase, 'ultraqa');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot ultraqa skipped completion without durable QA provenance', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ultraqa-skipped-no-provenance-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ultraqa-skipped-no-provenance-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({ active: true, mode: 'autopilot', current_phase: 'ultraqa' }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          state: {
            review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review.json' },
            qa_verdict: { stage: 'ultraqa', clean: true, skipped: true, reason: 'Docs-only change; QA not applicable.' },
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /without clean code-review and ultraqa verdict evidence/i);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, true);
        assert.equal(state.current_phase, 'ultraqa');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot completion from an unknown active phase', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-unknown-phase-complete-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-unknown-phase-complete-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'bogus',
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          completed_at: '2026-06-09T14:40:00.000Z',
          state: {
            review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review.json' },
            qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/5' },
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /unknown active phase/i);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, true);
        assert.equal(state.current_phase, 'bogus');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies Autopilot completion from an unknown active phase when persisted state omits mode', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-unknown-phase-no-mode-complete-deny-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-unknown-phase-no-mode-complete-deny';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            current_phase: 'bogus',
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          completed_at: '2026-06-09T14:45:00.000Z',
          state: {
            review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review.json' },
            qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/6' },
          },
        });

        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ''), /unknown active phase/i);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, true);
        assert.equal(state.current_phase, 'bogus');
        assert.equal(Object.prototype.hasOwnProperty.call(state, 'mode'), false);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not persist user-supplied trustedPipelineProgress from Autopilot state_write', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-trusted-field-strip-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-trusted-field-strip';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            current_phase: 'ultraqa',
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: true,
          current_phase: 'ultraqa',
          trustedPipelineProgress: true,
          state: {
            trustedPipelineProgress: true,
          },
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(Object.prototype.hasOwnProperty.call(state, 'trustedPipelineProgress'), false);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows Autopilot state_write cancellation from gated phases without clean review and QA evidence', async () => {
    for (const phase of ['deep-interview', 'ralplan', 'ultragoal', 'code-review']) {
      const wd = await mkdtemp(join(tmpdir(), `omx-state-ops-autopilot-${phase}-cancel-allow-`));
      try {
        await withOmxRootEnv(wd, async () => {
          const sessionId = `sess-autopilot-${phase}-cancel-allow`;
          const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, 'autopilot-state.json'),
            JSON.stringify({
              active: true,
              current_phase: phase,
            }, null, 2),
          );

          const response = await executeStateOperation('state_write', {
            workingDirectory: wd,
            session_id: sessionId,
            mode: 'autopilot',
            active: false,
            current_phase: 'cancelled',
            completed_at: '2026-06-09T16:30:00.000Z',
          });

          assert.equal(response.isError, undefined);
          const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
          assert.equal(state.active, false);
          assert.equal(state.current_phase, 'cancelled');
          assert.equal(state.run_outcome, 'cancelled');
          assert.equal(state.completed_at, '2026-06-09T16:30:00.000Z');
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('allows Autopilot ultraqa completion with clean review and QA evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ultraqa-complete-allow-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ultraqa-complete-allow';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({
            active: true,
            mode: 'autopilot',
            current_phase: 'ultraqa',
            state: {
              review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review.json' },
              qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/1' },
            },
          }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          completed_at: '2026-06-09T14:30:00.000Z',
          state: {
            review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review.json' },
            qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/1' },
          },
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, false);
        assert.equal(state.current_phase, 'complete');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows Autopilot ultraqa skipped completion with reason and durable QA provenance', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ops-autopilot-ultraqa-skipped-allow-'));
    try {
      await withOmxRootEnv(wd, async () => {
        const sessionId = 'sess-autopilot-ultraqa-skipped-allow';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({ active: true, mode: 'autopilot', current_phase: 'ultraqa' }, null, 2),
        );

        const response = await executeStateOperation('state_write', {
          workingDirectory: wd,
          session_id: sessionId,
          mode: 'autopilot',
          active: false,
          current_phase: 'complete',
          completed_at: '2026-06-09T14:35:00.000Z',
          state: {
            review_verdict: { stage: 'code-review', recommendation: 'APPROVE', architectural_status: 'CLEAR', clean: true, artifact_path: '.omx/reviews/code-review.json' },
            qa_verdict: {
              stage: 'ultraqa',
              clean: true,
              skipped: true,
              reason: 'Docs-only change; QA not applicable.',
              artifact_path: '.omx/state/autopilot-state.json#pipeline_stage_results.ultraqa.artifacts.qa_verdict',
            },
          },
        });

        assert.equal(response.isError, undefined);
        const state = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(state.active, false);
        assert.equal(state.current_phase, 'complete');
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
