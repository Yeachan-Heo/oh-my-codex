import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileHudForPromptSubmit } from '../reconcile.js';

describe('reconcileHudForPromptSubmit', () => {
  it('skips reconciliation outside tmux', async () => {
    const result = await reconcileHudForPromptSubmit('/tmp', {
      env: {},
    });
    assert.equal(result.status, 'skipped_not_tmux');
    assert.equal(result.paneId, null);
  });

  it('recreates a missing HUD in tmux', async () => {
    const created: Array<{ cwd: string; cmd: string; options?: { heightLines?: number; fullWidth?: boolean; targetPaneId?: string } }> = [];
    const resized: Array<{ paneId: string; heightLines: number }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1' },
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
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-stale' },
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
    assert.match(created[0]?.cmd || '', /^OMX_SESSION_ID='sess-canonical' node '.*omx\.js' hud --watch/);
    assert.doesNotMatch(created[0]?.cmd || '', /sess-stale/);
  });

  it('targets the emitting pane window when listing and creating HUD panes', async () => {
    const listArgs: Array<string | undefined> = [];
    const created: Array<{ options?: { heightLines?: number; fullWidth?: boolean; targetPaneId?: string } }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%leader' },
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
      env: { TMUX: '1', TMUX_PANE: '%1' },
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
      env: { TMUX: '1', TMUX_PANE: '%1' },
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
