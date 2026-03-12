import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { withModeRuntimeContext } from '../mode-state-context.js';

describe('withModeRuntimeContext', () => {
  it('captures tmux_pane_id on activation when env has TMUX_PANE', () => {
    const existing: Record<string, unknown> = { active: false };
    const next: Record<string, unknown> = { active: true };
    const out = withModeRuntimeContext(existing, next, {
      env: { TMUX_PANE: '%7' } as unknown as NodeJS.ProcessEnv,
      nowIso: '2026-02-13T00:00:00.000Z',
    });
    assert.equal(out.tmux_pane_id, '%7');
    assert.equal(out.tmux_pane_set_at, '2026-02-13T00:00:00.000Z');
  });

  it('does not overwrite tmux_pane_id once set', () => {
    const existing: Record<string, unknown> = { active: true, tmux_pane_id: '%1', tmux_pane_set_at: 'x' };
    const next: Record<string, unknown> = { active: true, tmux_pane_id: '%1', tmux_pane_set_at: 'x' };
    const out = withModeRuntimeContext(existing, next, {
      env: { TMUX_PANE: '%9' } as unknown as NodeJS.ProcessEnv,
      nowIso: '2026-02-13T00:00:00.000Z',
    });
    assert.equal(out.tmux_pane_id, '%1');
    assert.equal(out.tmux_pane_set_at, 'x');
  });

  it('does nothing when TMUX_PANE is missing', () => {
    const existing: Record<string, unknown> = { active: false };
    const next: Record<string, unknown> = { active: true };
    const out = withModeRuntimeContext(existing, next, {
      env: {} as unknown as NodeJS.ProcessEnv,
      nowIso: '2026-02-13T00:00:00.000Z',
    });
    assert.equal(out.tmux_pane_id, undefined);
  });
});
