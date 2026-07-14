import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  teamRuntimeSessionPath,
  teamRuntimeTeamRoot,
  teamRuntimeTeamsRoot,
  teamStartupTimingPath,
  projectHudRuntimeRootEnv,

} from '../runtime.js';
import { resolveHudControlPlaneDomain } from '../../mcp/state-paths.js';
import { buildHudRuntimeEnv } from '../../hud/tmux.js';


describe('team runtime boxed state path helpers', () => {
  it('routes runtime-owned team state paths through OMX_ROOT without changing source cwd semantics', () => {
    const previousRoot = process.env.OMX_ROOT;
    const previousStateRoot = process.env.OMX_STATE_ROOT;
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      process.env.OMX_ROOT = '/tmp/box';
      delete process.env.OMX_STATE_ROOT;
      delete process.env.OMX_TEAM_STATE_ROOT;

      assert.equal(teamRuntimeTeamsRoot('/tmp/source'), '/tmp/box/.omx/state/team');
      assert.equal(teamRuntimeTeamRoot('team-a', '/tmp/source'), '/tmp/box/.omx/state/team/team-a');
      assert.equal(
        teamStartupTimingPath('team-a', '/tmp/source'),
        '/tmp/box/.omx/state/team/team-a/startup-timing.json',
      );
      assert.equal(teamRuntimeSessionPath('/tmp/source'), '/tmp/box/.omx/state/session.json');
      assert.equal(join('/tmp/source', 'README.md'), '/tmp/source/README.md');

      process.env.OMX_TEAM_STATE_ROOT = '/tmp/explicit-team-state';
      assert.equal(teamRuntimeTeamsRoot('/tmp/source'), '/tmp/explicit-team-state/team');
      assert.equal(
        teamStartupTimingPath('team-a', '/tmp/source'),
        '/tmp/explicit-team-state/team/team-a/startup-timing.json',
      );
    } finally {
      if (typeof previousRoot === 'string') process.env.OMX_ROOT = previousRoot;
      else delete process.env.OMX_ROOT;
      if (typeof previousStateRoot === 'string') process.env.OMX_STATE_ROOT = previousStateRoot;
      else delete process.env.OMX_STATE_ROOT;
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
    }
  });
});

describe('team HUD runtime root projection', () => {
  it('preserves the resolver domain for team, OMX, state-root, and cwd roots', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-hud-runtime-cwd-'));
    const teamRoot = mkdtempSync(join(tmpdir(), 'omx-hud-runtime-team-'));
    const omxRoot = mkdtempSync(join(tmpdir(), 'omx-hud-runtime-root-'));
    const stateRoot = mkdtempSync(join(tmpdir(), 'omx-hud-runtime-state-'));
    const cases: Array<{ env: NodeJS.ProcessEnv }> = [
      { env: { OMX_TEAM_STATE_ROOT: ` ${teamRoot} `, OMX_ROOT: omxRoot, OMX_STATE_ROOT: stateRoot } },
      { env: { OMX_ROOT: ` ${omxRoot} `, OMX_STATE_ROOT: stateRoot } },
      { env: { OMX_STATE_ROOT: ` ${stateRoot} ` } },
      { env: {} },
    ];

    try {
      for (const { env } of cases) {
        const parent = await resolveHudControlPlaneDomain({ cwd, env });
        const hudEnv = buildHudRuntimeEnv(projectHudRuntimeRootEnv(parent.rootSource, env)).env;
        const child = await resolveHudControlPlaneDomain({ cwd, env: hudEnv });

        assert.equal(child.rootSource, parent.rootSource);
        assert.equal(child.baseStateDir, parent.baseStateDir);
        assert.equal(child.domainKey, parent.domainKey);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(teamRoot, { recursive: true, force: true });
      rmSync(omxRoot, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});
