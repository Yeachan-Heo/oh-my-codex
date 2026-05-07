import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OMX_TMUX_HUD_OWNER_ENV, reconcileHudForPromptSubmit } from '../reconcile.js';

describe('reconcileHudForPromptSubmit', () => {
  it('skips reconciliation outside tmux', async () => {
    const result = await reconcileHudForPromptSubmit('/tmp', {
      env: {},
    });
    assert.equal(result.status, 'skipped_not_tmux');
    assert.equal(result.paneId, null);
  });

  it('skips reconciliation in non-OMX-owned tmux even when an entry exists', async () => {
    let listed = false;
    let created = false;

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%claude', OMX_SESSION_ID: 'untrusted' },
      listCurrentWindowPanes: () => {
        listed = true;
        return [
          { paneId: '%claude', currentCommand: 'claude', startCommand: 'claude' },
        ];
      },
      createHudWatchPane: () => {
        created = true;
        return '%hud';
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'skipped_not_omx_owned_tmux');
    assert.equal(result.paneId, null);
    assert.equal(listed, false);
    assert.equal(created, false);
  });

  it('recreates a missing HUD in explicit OMX-owned tmux', async () => {
    const created: Array<{ cwd: string; cmd: string; options?: { heightLines?: number; fullWidth?: boolean; targetPaneId?: string } }> = [];
    const resized: Array<{ paneId: string; heightLines: number }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
      ],
      createHudWatchPane: (cwd, cmd, options) => {
        created.push({ cwd, cmd, options });
        return '%9';
      },
      resizeTmuxPane: (paneId, heightLines) => {
        resized.push({ paneId, heightLines });
        return true;
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'recreated');
    assert.equal(result.paneId, '%9');
    assert.equal(created.length, 1);
    assert.match(created[0]?.cmd || '', /\/repo\/dist\/cli\/omx\.js' hud --watch/);
    assert.equal(created[0]?.options?.heightLines, 3);
    assert.equal(resized.length, 1);
    assert.equal(resized[0]?.heightLines, 3);
  });

  it('prefers an explicit session override when recreating HUD', async () => {
    const created: Array<{ cmd: string }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-stale', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      sessionId: 'sess-canonical',
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
      ],
      createHudWatchPane: (_cwd, cmd) => {
        created.push({ cmd });
        return '%9';
      },
      resizeTmuxPane: () => true,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'recreated');
    assert.equal(created.length, 1);
    assert.match(created[0]?.cmd || '', /^OMX_SESSION_ID='sess-canonical' '.*' '.*omx\.js' hud --watch/);
    assert.doesNotMatch(created[0]?.cmd || '', /sess-stale/);
  });

  it('targets the emitting pane window when listing and creating HUD panes', async () => {
    const listArgs: Array<string | undefined> = [];
    const created: Array<{ options?: { heightLines?: number; fullWidth?: boolean; targetPaneId?: string } }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%leader', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: (currentPaneId) => {
        listArgs.push(currentPaneId);
        return [
          { paneId: '%leader', currentCommand: 'codex', startCommand: 'codex' },
        ];
      },
      createHudWatchPane: (_cwd, _cmd, options) => {
        created.push({ options });
        return '%hud';
      },
      resizeTmuxPane: () => true,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'recreated');
    assert.deepEqual(listArgs, ['%leader']);
    assert.equal(created[0]?.options?.targetPaneId, '%leader');
  });

  it('kills duplicate HUD panes and recreates one full-width pane', async () => {
    const killed: string[] = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        { paneId: '%2', currentCommand: 'node', startCommand: 'node omx hud --watch' },
        { paneId: '%3', currentCommand: 'node', startCommand: 'node omx hud --watch' },
        { paneId: '%4', currentCommand: 'codex', startCommand: 'codex' },
      ],
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      createHudWatchPane: (_cwd, _cmd, options) => {
        assert.equal(options?.fullWidth, true);
        assert.equal(options?.heightLines, 3);
        return '%9';
      },
      resizeTmuxPane: () => true,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'replaced_duplicates');
    assert.deepEqual(killed, ['%2', '%3']);
  });

  it('resizes an existing single HUD pane instead of recreating it', async () => {
    const resized: Array<{ paneId: string; heightLines: number }> = [];
    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        { paneId: '%2', currentCommand: 'node', startCommand: 'node omx hud --watch' },
      ],
      resizeTmuxPane: (paneId, heightLines) => {
        resized.push({ paneId, heightLines });
        return true;
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'resized');
    assert.equal(resized.length, 1);
    assert.equal(resized[0]?.paneId, '%2');
    assert.equal(resized[0]?.heightLines, 3);
  });
});
