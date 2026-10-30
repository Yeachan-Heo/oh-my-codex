import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { TEAM_NAME_SAFE_PATTERN } from '../contracts.js';
import { buildInternalTeamName, resolveCurrentTeamName, resolveTeamIdentityScope, resolveTeamNameForCurrentContext, TeamLookupAmbiguityError } from '../team-identity.js';
import { initTeamState } from '../state.js';

const longDisplay = 'this-is-a-very-long-team-display-name-that-would-overflow';

async function writePhase(cwd: string, teamName: string, currentPhase: string, updatedAt: string): Promise<void> {
  await writeFile(join(cwd, '.omx', 'state', 'team', teamName, 'phase.json'), JSON.stringify({
    current_phase: currentPhase,
    max_fix_attempts: 3,
    current_fix_attempt: 0,
    transitions: [],
    updated_at: updatedAt,
  }, null, 2));
}

async function writeLeaderPane(cwd: string, teamName: string, leaderPaneId: string): Promise<void> {
  for (const filename of ['manifest.v2.json', 'config.json']) {
    const path = join(cwd, '.omx', 'state', 'team', teamName, filename);
    const data = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    data.leader_pane_id = leaderPaneId;
    await writeFile(path, JSON.stringify(data, null, 2));
  }
}

describe('team identity', () => {
  it('builds stable valid internal names for same display and distinct sessions', () => {
    const a = buildInternalTeamName(longDisplay, { sessionId: 'session-a', paneId: '', tmuxTarget: '', runId: '', source: 'env-session' });
    const b = buildInternalTeamName(longDisplay, { sessionId: 'session-b', paneId: '', tmuxTarget: '', runId: '', source: 'env-session' });
    const a2 = buildInternalTeamName(longDisplay, { sessionId: 'session-a', paneId: '', tmuxTarget: '', runId: '', source: 'env-session' });
    const runA = buildInternalTeamName('demo', { sessionId: '', paneId: '', tmuxTarget: '', runId: 'run-a', source: 'run-id' });
    const runB = buildInternalTeamName('demo', { sessionId: '', paneId: '', tmuxTarget: '', runId: 'run-b', source: 'run-id' });

    assert.notEqual(a, b);
    assert.notEqual(runA, runB);
    assert.equal(a, a2);
    assert.equal(a.length <= 30, true);
    assert.match(a, TEAM_NAME_SAFE_PATTERN);
  });

  it('does not use cwd session.json as the identity source when env is absent', () => {
    const scope = resolveTeamIdentityScope({ TMUX: '/tmp/tmux,1,0', TMUX_PANE: '%42' });
    assert.equal(scope.source, 'tmux-pane');
    assert.equal(scope.paneId, '%42');
  });

  it('resolves an unnamed team only when the sole active candidate matches the current leader session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-current-sole-'));
    try {
      await initTeamState('demo-active', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-current' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });

      assert.equal(resolveCurrentTeamName(cwd, { OMX_SESSION_ID: 'session-current' }), 'demo-active');
      assert.equal(resolveCurrentTeamName(cwd, { OMX_SESSION_ID: 'session-foreign' }), null);
      assert.equal(resolveCurrentTeamName(cwd, {}), null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not fall back to an unbound terminal team for unnamed resolution', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-terminal-unnamed-'));
    try {
      await initTeamState('demo-terminal', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-terminal' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await writePhase(cwd, 'demo-terminal', 'complete', '2026-01-03T00:00:00.000Z');

      assert.equal(resolveCurrentTeamName(cwd, {}), null);
      assert.equal(resolveCurrentTeamName(cwd, { OMX_SESSION_ID: 'session-foreign' }), null);
      assert.equal(resolveCurrentTeamName(cwd, { OMX_SESSION_ID: 'session-terminal' }), 'demo-terminal');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resolves the current leader terminal team even when another session has an active team', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-terminal-vs-foreign-active-'));
    try {
      await initTeamState('demo-mine', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-mine' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await writePhase(cwd, 'demo-mine', 'complete', '2026-01-03T00:00:00.000Z');
      await initTeamState('other-active', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-other' }, {
        display_name: 'other', requested_name: 'other', identity_source: 'env-session',
      });

      assert.equal(resolveCurrentTeamName(cwd, { OMX_SESSION_ID: 'session-mine' }), 'demo-mine');
      assert.equal(resolveCurrentTeamName(cwd, { OMX_SESSION_ID: 'session-other' }), 'other-active');
      assert.equal(resolveCurrentTeamName(cwd, { OMX_SESSION_ID: 'session-foreign' }), null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not accept a matching leader pane when an explicit current session conflicts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-session-precedence-'));
    try {
      await initTeamState('demo-active', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-owner' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await writeLeaderPane(cwd, 'demo-active', '%42');

      assert.equal(resolveCurrentTeamName(cwd, { OMX_SESSION_ID: 'session-foreign', TMUX_PANE: '%42' }), null);
      assert.equal(resolveCurrentTeamName(cwd, { TMUX_PANE: '%42' }), 'demo-active');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resolves display names from OMX_TEAM_STATE_ROOT when cwd has no local team state', async () => {
    const leaderCwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-leader-'));
    const workerCwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-worker-'));
    try {
      await initTeamState('shared-demo-aaaaaaaa', 'task', 'executor', 1, leaderCwd, undefined, { OMX_SESSION_ID: 'session-shared' }, {
        display_name: 'shared-demo', requested_name: 'shared-demo', identity_source: 'env-session',
      });

      assert.equal(
        resolveTeamNameForCurrentContext('shared-demo', workerCwd, {
          OMX_SESSION_ID: 'session-shared',
          OMX_TEAM_STATE_ROOT: join(leaderCwd, '.omx', 'state'),
        }),
        'shared-demo-aaaaaaaa',
      );
    } finally {
      await rm(leaderCwd, { recursive: true, force: true });
      await rm(workerCwd, { recursive: true, force: true });
    }
  });



  it('prefers active display-name candidates over retained terminal states', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-active-'));
    try {
      await initTeamState('demo-active', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-active' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await initTeamState('demo-terminal', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-terminal' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await writePhase(cwd, 'demo-terminal', 'complete', '2026-01-01T00:00:00.000Z');

      assert.equal(resolveTeamNameForCurrentContext('demo', cwd, {}), 'demo-active');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('prefers active display-name candidates over an exact retained terminal directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-exact-terminal-'));
    try {
      await initTeamState('demo', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-terminal' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await initTeamState('demo-aaaaaaaa', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-active' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await writePhase(cwd, 'demo', 'complete', '2026-01-01T00:00:00.000Z');

      assert.equal(resolveTeamNameForCurrentContext('demo', cwd, {}), 'demo-aaaaaaaa');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses current leader identity to break active display-name ties', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-current-'));
    try {
      await initTeamState('demo-aaaaaaaa', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-a' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await initTeamState('demo-bbbbbbbb', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-b' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });

      assert.equal(resolveTeamNameForCurrentContext('demo', cwd, { OMX_SESSION_ID: 'session-b' }), 'demo-bbbbbbbb');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses current leader identity before latest retained terminal state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-terminal-current-'));
    try {
      await initTeamState('demo-old-current', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-current' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await initTeamState('demo-new-other', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-other' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await writePhase(cwd, 'demo-old-current', 'failed', '2026-01-01T00:00:00.000Z');
      await writePhase(cwd, 'demo-new-other', 'complete', '2026-01-02T00:00:00.000Z');

      assert.equal(resolveTeamNameForCurrentContext('demo', cwd, { OMX_SESSION_ID: 'session-current' }), 'demo-old-current');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resolves the latest retained terminal display-name state only when unambiguous', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-latest-terminal-'));
    try {
      await initTeamState('demo-old', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-old' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await initTeamState('demo-new', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-new' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await writePhase(cwd, 'demo-old', 'failed', '2026-01-01T00:00:00.000Z');
      await writePhase(cwd, 'demo-new', 'complete', '2026-01-03T00:00:00.000Z');

      assert.equal(resolveTeamNameForCurrentContext('demo', cwd, {}), 'demo-new');

      await writePhase(cwd, 'demo-old', 'failed', '2026-01-03T00:00:00.000Z');
      assert.throws(() => resolveTeamNameForCurrentContext('demo', cwd, {}), TeamLookupAmbiguityError);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });



  it('sanitizes unsafe lookup input instead of returning raw path-like names', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-unsafe-'));
    try {
      assert.equal(resolveTeamNameForCurrentContext('../../victim', cwd, {}), 'victim');
      assert.equal(resolveTeamNameForCurrentContext('Demo Team', cwd, {}), 'demo-team');
      assert.throws(() => resolveTeamNameForCurrentContext('---', cwd, {}), /invalid_team_name/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resolves display names to the current session candidate and fails closed on ambiguity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-'));
    try {
      await initTeamState('demo-aaaaaaaa', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-a' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await initTeamState('demo-bbbbbbbb', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-b' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });

      assert.equal(resolveTeamNameForCurrentContext('demo', cwd, { OMX_SESSION_ID: 'session-a' }), 'demo-aaaaaaaa');
      assert.equal(resolveTeamNameForCurrentContext('demo-bbbbbbbb', cwd, {}), 'demo-bbbbbbbb');
      assert.throws(() => resolveTeamNameForCurrentContext('demo', cwd, {}), TeamLookupAmbiguityError);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
