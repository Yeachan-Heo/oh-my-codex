import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, it } from 'node:test';
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

  it('persists a fail-closed Ralph pane binding only after exact proof and owner tagging', async () => {
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-ralph-pane-binding-'));
    const tmuxPath = join(fakeBinDir, 'tmux');
    const originalPath = process.env.PATH;
    try {
      await writeFile(tmuxPath, `#!/bin/sh
printf '%s\n' "$*" >> '${tmuxPath}.log'
case "$1" in
  list-panes) printf '%%7\\t0\\t4242\\n' ;;
  set-option)
    [ "$5" = '@omx_ralph_pane_owner_id' ] || exit 2
    printf '%s' "$6" > '${tmuxPath}.ralph-owner'
    ;;
  show-option)
    [ "$6" = '@omx_ralph_pane_owner_id' ] || exit 3
    cat '${tmuxPath}.ralph-owner'
    ;;
  display-message) printf 'ralph-session\\n' ;;
  *) exit 1 ;;
esac
`);
      await chmod(tmuxPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${originalPath ?? ''}`;

      const out = withModeRuntimeContext({ active: false }, { active: true, mode: 'ralph' } as Record<string, unknown>, {
        env: { TMUX_PANE: '%7' } as unknown as NodeJS.ProcessEnv,
        nowIso: '2026-02-13T00:00:00.000Z',
      });

      assert.equal(out.tmux_pane_id, '%7');
      assert.equal(out.tmux_pane_pid, 4242);
      assert.equal(out.tmux_session_name, 'ralph-session');
      assert.match(String(out.tmux_pane_owner_id), /^ralph:[0-9a-f-]+$/);
      assert.doesNotMatch(await readFile(`${tmuxPath}.log`, 'utf8'), /@omx_team_pane_owner_id/);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('omits a Ralph pane binding when exact proof is unavailable', () => {
    const out = withModeRuntimeContext({ active: false }, { active: true, mode: 'ralph' } as Record<string, unknown>, {
      env: {} as unknown as NodeJS.ProcessEnv,
      nowIso: '2026-02-13T00:00:00.000Z',
    });
    assert.equal(out.tmux_pane_id, undefined);
    assert.equal(out.tmux_pane_pid, undefined);
    assert.equal(out.tmux_session_name, undefined);
    assert.equal(out.tmux_pane_owner_id, undefined);
  });
});
