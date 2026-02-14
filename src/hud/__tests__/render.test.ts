import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderHud } from '../render.js';
import type { HudRenderContext } from '../types.js';

function contextWithTeam(): HudRenderContext {
  return {
    version: 'v0.0.0',
    gitBranch: null,
    ralph: null,
    ultrawork: null,
    autopilot: null,
    team: { active: true, current_phase: 'team-exec', agent_count: 3, team_name: 'wave2' },
    ecomode: null,
    pipeline: null,
    metrics: null,
    hudNotify: null,
    session: null,
  };
}

describe('renderHud team state', () => {
  it('includes team phase from TeamStateForHud.current_phase', () => {
    const output = renderHud(contextWithTeam(), 'focused');
    assert.match(output, /team:team-exec/);
    assert.match(output, /\(wave2,3 workers\)/);
  });
});

