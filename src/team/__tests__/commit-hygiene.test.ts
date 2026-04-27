import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTeamCommitHygieneContext,
  renderTeamCommitHygieneMarkdown,
  resolveTeamCommitHygieneArtifactCwd,
  TEAM_OPERATIONAL_COMMIT_KINDS,
  TEAM_OPERATIONAL_COMMIT_STATUSES,
  type TeamCommitHygieneLedger,
} from '../commit-hygiene.js';
import type { TeamTask } from '../state.js';

describe('team commit hygiene vocabulary', () => {
  it('includes canonical operation and status vocabulary in structured context', () => {
    const tasks: TeamTask[] = [
      {
        id: '1',
        subject: 'worker result',
        description: 'preserve worker output',
        status: 'completed',
        role: 'executor',
        owner: 'worker-1',
        version: 1,
        created_at: '2026-04-26T00:00:00.000Z',
      },
    ];
    const ledger: TeamCommitHygieneLedger = {
      version: 1,
      team_name: 'team-hygiene',
      updated_at: '2026-04-26T00:00:00.000Z',
      runtime_commits_are_scaffolding: true,
      entries: [
        {
          recorded_at: '2026-04-26T00:00:00.000Z',
          operation: 'auto_checkpoint',
          worker_name: 'worker-1',
          task_id: '1',
          status: 'applied',
          operational_commit: 'abc1234',
        },
      ],
    };

    const context = buildTeamCommitHygieneContext({
      teamName: 'team-hygiene',
      tasks,
      ledger,
    });

    assert.deepEqual(
      context.vocabulary.operational_commit_kinds.map((term) => term.value),
      [...TEAM_OPERATIONAL_COMMIT_KINDS],
    );
    assert.deepEqual(
      context.vocabulary.operational_commit_statuses.map((term) => term.value),
      [...TEAM_OPERATIONAL_COMMIT_STATUSES],
    );
    assert.match(
      context.vocabulary.operational_commit_kinds.find((term) => term.value === 'auto_checkpoint')?.description ?? '',
      /worker-local checkpoint commit/i,
    );
    assert.match(
      context.vocabulary.operational_commit_statuses.find((term) => term.value === 'conflict')?.description ?? '',
      /reconciliation/i,
    );
  });

  it('renders the vocabulary before runtime ledger details in markdown', () => {
    const context = buildTeamCommitHygieneContext({
      teamName: 'team-hygiene',
      tasks: [],
      ledger: {
        version: 1,
        team_name: 'team-hygiene',
        updated_at: '2026-04-26T00:00:00.000Z',
        runtime_commits_are_scaffolding: true,
        entries: [],
      },
    });

    const markdown = renderTeamCommitHygieneMarkdown(context);

    assert.match(markdown, /## Commit Hygiene Vocabulary/);
    assert.match(markdown, /### Operational commit kinds/);
    assert.match(markdown, /`integration_cherry_pick` \(integration cherry-pick\)/);
    assert.match(markdown, /### Operational commit statuses/);
    assert.match(markdown, /`noop` \(no-op\)/);
    assert.ok(
      markdown.indexOf('## Commit Hygiene Vocabulary') < markdown.indexOf('## Runtime Operational Ledger'),
      'vocabulary should explain ledger terms before ledger entries are shown',
    );
  });
});

describe('team commit hygiene artifact root', () => {
  it('derives leader-facing artifacts from persisted team metadata instead of worker cwd', () => {
    const leaderCwd = '/tmp/omx-leader';
    const workerCwd = `${leaderCwd}/.omx/team/demo/worktrees/worker-3`;

    assert.equal(
      resolveTeamCommitHygieneArtifactCwd({
        workers: [],
        leader_cwd: leaderCwd,
        team_state_root: `${leaderCwd}/.omx/state`,
      }, workerCwd),
      leaderCwd,
    );

    assert.equal(
      resolveTeamCommitHygieneArtifactCwd({
        workers: [
          {
            name: 'worker-3',
            index: 3,
            role: 'executor',
            assigned_tasks: ['3'],
            worktree_repo_root: leaderCwd,
            worktree_path: workerCwd,
          },
        ],
        team_state_root: `${leaderCwd}/.omx/state`,
      }, workerCwd),
      leaderCwd,
    );

    assert.equal(
      resolveTeamCommitHygieneArtifactCwd({
        workers: [],
        team_state_root: `${leaderCwd}/.omx/state`,
      }, workerCwd),
      leaderCwd,
    );
  });
});
