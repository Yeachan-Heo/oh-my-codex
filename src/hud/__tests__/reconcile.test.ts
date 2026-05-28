import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OMX_TMUX_HUD_OWNER_ENV, reconcileHudForPromptSubmit } from '../reconcile.js';
import { HUD_TMUX_HEIGHT_LINES, HUD_TMUX_ULTRAGOAL_HEIGHT_LINES } from '../constants.js';
import { OMX_TMUX_HUD_LEADER_PANE_ENV } from '../tmux.js';

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

  it('skips recreating a missing HUD in explicit OMX-owned tmux without a session id', async () => {
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

    assert.equal(result.status, 'skipped_no_session_id');
    assert.equal(result.paneId, null);
    assert.equal(created.length, 0);
    assert.equal(resized.length, 0);
  });

  it('recreates a missing HUD in explicit OMX-owned tmux with a session id', async () => {
    const created: Array<{ cwd: string; cmd: string; options?: { heightLines?: number; fullWidth?: boolean; targetPaneId?: string } }> = [];
    const resized: Array<{ paneId: string; heightLines: number }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
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
    assert.match(created[0]?.cmd || '', /exec .*\/repo\/dist\/cli\/omx\.js' hud --watch/);
    assert.match(created[0]?.cmd || '', /OMX_SESSION_ID='sess-a'/);
    assert.match(created[0]?.cmd || '', /OMX_TMUX_HUD_OWNER='1'/);
    assert.equal(created[0]?.options?.heightLines, HUD_TMUX_HEIGHT_LINES);
    assert.equal(resized.length, 1);
    assert.equal(resized[0]?.heightLines, HUD_TMUX_HEIGHT_LINES);
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
    assert.match(
      created[0]?.cmd || '',
      /^exec env OMX_SESSION_ID='sess-canonical' OMX_TMUX_HUD_OWNER='1' OMX_TMUX_HUD_LEADER_PANE='%1' '.*' '.*omx\.js' hud --watch/,
    );
    assert.doesNotMatch(created[0]?.cmd || '', /sess-stale/);
  });

  it('forwards OMX_ROOT when recreating HUD with shell-safe quoting', async () => {
    const created: Array<{ cmd: string }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: {
        TMUX: '1',
        TMUX_PANE: '%1',
        OMX_SESSION_ID: 'sess boxed',
        OMX_ROOT: "/tmp/boxed root/it's/$(literal)",
        [OMX_TMUX_HUD_OWNER_ENV]: '1',
      },
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
    assert.match(
      created[0]?.cmd || '',
      /^exec env OMX_SESSION_ID='sess boxed' OMX_TMUX_HUD_OWNER='1' OMX_TMUX_HUD_LEADER_PANE='%1' OMX_ROOT='\/tmp\/boxed root\/it'\\''s\/\$\(literal\)' '.*' '.*omx\.js' hud --watch/,
    );
  });

  it('targets the emitting pane window when listing and creating HUD panes', async () => {
    const listArgs: Array<string | undefined> = [];
    const created: Array<{ options?: { heightLines?: number; fullWidth?: boolean; targetPaneId?: string } }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%leader', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
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

  it('kills duplicate HUD panes and reuses one existing pane', async () => {
    const killed: string[] = [];
    const resized: Array<{ paneId: string; heightLines: number }> = [];
    const created: Array<{ cmd: string }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        {
          paneId: '%2',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
        },
        {
          paneId: '%3',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
        },
        { paneId: '%4', currentCommand: 'codex', startCommand: 'codex' },
      ],
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      createHudWatchPane: (_cwd, cmd) => {
        created.push({ cmd });
        return '%9';
      },
      resizeTmuxPane: (paneId, heightLines) => {
        resized.push({ paneId, heightLines });
        return true;
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'replaced_duplicates');
    assert.equal(result.paneId, '%2');
    assert.deepEqual(killed, ['%3']);
    assert.deepEqual(resized, [{ paneId: '%2', heightLines: HUD_TMUX_HEIGHT_LINES }]);
    assert.deepEqual(created, []);
  });

  it('does not resize, kill, or reuse another active leader session HUD in the same tmux window', async () => {
    const killed: string[] = [];
    const resized: string[] = [];
    const created: Array<{ cmd: string; options?: { targetPaneId?: string } }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%3', OMX_SESSION_ID: 'sess-b', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        {
          paneId: '%2',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
        },
        { paneId: '%3', currentCommand: 'codex', startCommand: 'codex' },
      ],
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      resizeTmuxPane: (paneId) => {
        resized.push(paneId);
        return true;
      },
      createHudWatchPane: (_cwd, cmd, options) => {
        created.push({ cmd, options });
        return '%4';
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'recreated');
    assert.equal(result.paneId, '%4');
    assert.deepEqual(killed, []);
    assert.deepEqual(resized, ['%4']);
    assert.equal(created[0]?.options?.targetPaneId, '%3');
    assert.match(created[0]?.cmd || '', /OMX_SESSION_ID='sess-b'/);
    assert.match(created[0]?.cmd || '', new RegExp(`${OMX_TMUX_HUD_LEADER_PANE_ENV}='%3'`));
  });

  it('still cleans stale duplicate HUD panes for the same session and leader owner', async () => {
    const killed: string[] = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        {
          paneId: '%2',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
        },
        {
          paneId: '%3',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
        },
        {
          paneId: '%4',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-b' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%5' node omx hud --watch`,
        },
      ],
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      createHudWatchPane: () => '%9',
      resizeTmuxPane: () => true,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'replaced_duplicates');
    assert.equal(result.paneId, '%2');
    assert.deepEqual(killed, ['%3']);
  });

  it('deduplicates same-leader node HUD panes while preserving active ultragoal height despite empty mode state', async () => {
    const killed: string[] = [];
    const resized: Array<{ paneId: string; heightLines: number }> = [];
    const created: string[] = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'zsh', startCommand: 'zsh' },
        { paneId: '%2', currentCommand: 'node', startCommand: `exec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch` },
        { paneId: '%3', currentCommand: 'node', startCommand: `exec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch` },
      ],
      readHudConfig: async () => ({ preset: 'focused', git: { display: 'branch' }, statusLine: { preset: 'focused' } }),
      readAllState: async () => ({
        version: null,
        gitBranch: null,
        ralph: null,
        ultragoal: {
          active: true,
          status: 'in_progress',
          total: 1,
          complete: 0,
          pending: 0,
          inProgress: 1,
          failed: 0,
          reviewBlocked: 0,
          needsUserDecision: 0,
          progressTotal: 1,
        },
        ultrawork: null,
        autopilot: null,
        ralplan: null,
        deepInterview: null,
        autoresearch: null,
        ultraqa: null,
        team: null,
        metrics: null,
        hudNotify: null,
        session: null,
      }),
      killTmuxPane: (paneId) => { killed.push(paneId); return true; },
      resizeTmuxPane: (paneId, heightLines) => { resized.push({ paneId, heightLines }); return true; },
      createHudWatchPane: () => { created.push('create'); return '%9'; },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'replaced_duplicates');
    assert.equal(result.paneId, '%2');
    assert.equal(result.duplicateCount, 1);
    assert.deepEqual(killed, ['%3']);
    assert.deepEqual(resized, [{ paneId: '%2', heightLines: HUD_TMUX_ULTRAGOAL_HEIGHT_LINES }]);
    assert.deepEqual(created, []);
  });

  it('resizes an existing single HUD pane instead of recreating it', async () => {
    const resized: Array<{ paneId: string; heightLines: number }> = [];
    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        {
          paneId: '%2',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
        },
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
    assert.equal(resized[0]?.heightLines, HUD_TMUX_HEIGHT_LINES);
  });

  it('resizes an existing HUD pane to active ultragoal height when ultragoal is active', async () => {
    const resized: Array<{ paneId: string; heightLines: number }> = [];
    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        {
          paneId: '%2',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
        },
      ],
      readHudConfig: async () => ({ preset: 'focused', git: { display: 'branch' }, statusLine: { preset: 'focused' } }),
      readAllState: async () => ({
        version: null,
        gitBranch: null,
        ralph: null,
        ultragoal: {
          active: true,
          status: 'in_progress',
          total: 1,
          complete: 0,
          pending: 0,
          inProgress: 1,
          failed: 0,
          reviewBlocked: 0,
          needsUserDecision: 0,
          progressTotal: 1,
        },
        ultrawork: null,
        autopilot: null,
        ralplan: null,
        deepInterview: null,
        autoresearch: null,
        ultraqa: null,
        team: null,
        metrics: null,
        hudNotify: null,
        session: null,
      }),
      resizeTmuxPane: (paneId, heightLines) => {
        resized.push({ paneId, heightLines });
        return true;
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'resized');
    assert.deepEqual(resized, [{ paneId: '%2', heightLines: HUD_TMUX_ULTRAGOAL_HEIGHT_LINES }]);
  });

  it('resizes an existing owner-tagged same-leader HUD pane instead of creating a duplicate during prompt revive', async () => {
    const resized: Array<{ paneId: string; heightLines: number }> = [];
    const created: string[] = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-canonical', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        {
          paneId: '%2',
          currentCommand: 'node',
          startCommand: `exec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        },
      ],
      createHudWatchPane: () => {
        created.push('create');
        return '%9';
      },
      resizeTmuxPane: (paneId, heightLines) => {
        resized.push({ paneId, heightLines });
        return true;
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'resized');
    assert.equal(result.paneId, '%2');
    assert.deepEqual(created, []);
    assert.deepEqual(resized, [{ paneId: '%2', heightLines: HUD_TMUX_HEIGHT_LINES }]);
  });


  it('deduplicates same-leader HUD panes without creating a new pane when session id is unavailable', async () => {
    const killed: string[] = [];
    const resized: Array<{ paneId: string; heightLines: number }> = [];
    const created: string[] = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        { paneId: '%2', currentCommand: 'node', startCommand: `env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch` },
        { paneId: '%3', currentCommand: 'node', startCommand: `env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch` },
      ],
      killTmuxPane: (paneId) => { killed.push(paneId); return true; },
      resizeTmuxPane: (paneId, heightLines) => { resized.push({ paneId, heightLines }); return true; },
      createHudWatchPane: () => { created.push('create'); return '%9'; },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'replaced_duplicates');
    assert.equal(result.paneId, '%2');
    assert.equal(result.duplicateCount, 1);
    assert.deepEqual(killed, ['%3']);
    assert.deepEqual(resized, [{ paneId: '%2', heightLines: HUD_TMUX_HEIGHT_LINES }]);
    assert.deepEqual(created, []);
  });

  it('resizes an existing single HUD pane even without a fresh session id', async () => {
    const resized: Array<{ paneId: string; heightLines: number }> = [];
    const created: string[] = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        {
          paneId: '%2',
          currentCommand: 'node',
          startCommand: `env ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
        },
      ],
      createHudWatchPane: () => {
        created.push('create');
        return '%9';
      },
      resizeTmuxPane: (paneId, heightLines) => {
        resized.push({ paneId, heightLines });
        return true;
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'resized');
    assert.equal(result.paneId, '%2');
    assert.deepEqual(created, []);
    assert.deepEqual(resized, [{ paneId: '%2', heightLines: HUD_TMUX_HEIGHT_LINES }]);
  });

  it('registers client-resized hook scoped from the emitting pane after resizing an existing HUD pane', async () => {
    const registered: Array<{ hudPaneId: string; currentPaneId: string | undefined; heightLines: number }> = [];

    await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        {
          paneId: '%2',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
        },
      ],
      resizeTmuxPane: () => true,
      registerHudResizeHook: (hudPaneId, currentPaneId, heightLines) => {
        registered.push({ hudPaneId, currentPaneId, heightLines });
        return true;
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(registered.length, 1);
    assert.equal(registered[0]?.hudPaneId, '%2');
    assert.equal(registered[0]?.currentPaneId, '%1');
    assert.equal(registered[0]?.heightLines, HUD_TMUX_HEIGHT_LINES);
  });

  it('registers client-resized hook scoped from the emitting pane after creating a new HUD pane', async () => {
    const registered: Array<{ hudPaneId: string; currentPaneId: string | undefined; heightLines: number }> = [];

    await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
      ],
      createHudWatchPane: () => '%9',
      resizeTmuxPane: () => true,
      registerHudResizeHook: (hudPaneId, currentPaneId, heightLines) => {
        registered.push({ hudPaneId, currentPaneId, heightLines });
        return true;
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(registered.length, 1);
    assert.equal(registered[0]?.hudPaneId, '%9');
    assert.equal(registered[0]?.currentPaneId, '%1');
    assert.equal(registered[0]?.heightLines, HUD_TMUX_HEIGHT_LINES);
  });

  it('keeps the resize hook on the reused duplicate keeper pane', async () => {
    const unregistered: Array<string | undefined> = [];
    const registered: Array<{ hudPaneId: string; currentPaneId: string | undefined }> = [];

    await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        { paneId: '%2', currentCommand: 'node', startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch` },
        { paneId: '%3', currentCommand: 'node', startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch` },
      ],
      killTmuxPane: () => true,
      createHudWatchPane: () => '%9',
      resizeTmuxPane: () => true,
      unregisterHudResizeHook: (currentPaneId) => { unregistered.push(currentPaneId); return true; },
      registerHudResizeHook: (hudPaneId, currentPaneId) => { registered.push({ hudPaneId, currentPaneId }); return true; },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.deepEqual(unregistered, []);
    assert.equal(registered.length, 1);
    assert.equal(registered[0]?.hudPaneId, '%2');
    assert.equal(registered[0]?.currentPaneId, '%1');
  });
});
