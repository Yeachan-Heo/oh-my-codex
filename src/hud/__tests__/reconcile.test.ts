import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OMX_TMUX_HUD_OWNER_ENV, reconcileHudForPromptSubmit } from '../reconcile.js';
import { HUD_TMUX_HEIGHT_LINES, HUD_TMUX_ULTRAGOAL_HEIGHT_LINES, HUD_TMUX_MIN_LAUNCH_WINDOW_HEIGHT_LINES } from '../constants.js';
import { OMX_TMUX_HUD_LEADER_PANE_ENV } from '../tmux.js';

const noOpRegisterHudResizeHook = () => true;
const noOpUnregisterHudResizeHook = () => true;

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
    const created: Array<{ cwd: string; cmd: string; options?: { heightLines?: number; targetPaneId?: string } }> = [];
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
      unregisterHudResizeHook: noOpUnregisterHudResizeHook,
      registerHudResizeHook: noOpRegisterHudResizeHook,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'skipped_no_session_id');
    assert.equal(result.paneId, null);
    assert.equal(created.length, 0);
    assert.equal(resized.length, 0);
  });

  it('recreates a missing HUD in explicit OMX-owned tmux with a session id', async () => {
    const created: Array<{ cwd: string; cmd: string; options?: { heightLines?: number; targetPaneId?: string } }> = [];
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

  it('reaps orphaned same-session HUD panes whose leader pane was destroyed, then recreates a single HUD', async () => {
    // Regression for the "team mode leaves only stacked HUD strips" bug: the leader
    // pane (%21) was destroyed but its owner-tagged HUD panes remained, all pointing
    // at the dead leader id. They match neither findHudWatchPaneIds (leader mismatch)
    // nor findLegacyFocusedHudWatchPaneIds (they carry owner metadata), so each prompt
    // submit previously appended a fresh HUD instead of reclaiming the orphans.
    const killed: string[] = [];
    const created: Array<{ cmd: string; options?: { targetPaneId?: string } }> = [];

    const orphan = (paneId: string) => ({
      paneId,
      currentCommand: 'node',
      startCommand: `exec env OMX_SESSION_ID='sess-a' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%21' node omx hud --watch --preset=focused`,
    });

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%33', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        // %33 is the current (live) leader pane; %21 is gone from the window.
        { paneId: '%33', currentCommand: 'codex', startCommand: 'codex' },
        orphan('%34'),
        orphan('%42'),
        orphan('%47'),
      ],
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      resizeTmuxPane: () => true,
      createHudWatchPane: (_cwd, cmd, options) => {
        created.push({ cmd, options });
        return '%50';
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    // All three dead-leader orphans are reaped, then exactly one fresh HUD is created.
    assert.deepEqual(killed.sort(), ['%34', '%42', '%47']);
    assert.equal(result.status, 'recreated');
    assert.equal(result.paneId, '%50');
    assert.equal(created.length, 1);
    assert.equal(created[0]?.options?.targetPaneId, '%33');
    assert.match(created[0]?.cmd || '', new RegExp(`${OMX_TMUX_HUD_LEADER_PANE_ENV}='%33'`));
  });

  it('reaps orphaned HUD panes tagged with an equivalent native session id', async () => {
    // #2684 lets HUD dedupe treat the OMX owner id and Codex native session id as
    // equivalent. Orphan reaping must use the same identity set so a canonical
    // owner reconcile still reclaims dead-leader HUDs tagged with the native id.
    const killed: string[] = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'codex-native-uuid', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      sessionId: 'omx-owner-abc',
      sessionIds: ['omx-owner-abc', 'codex-native-uuid'],
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        {
          paneId: '%2',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='codex-native-uuid' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%21' node omx hud --watch`,
        },
      ],
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      resizeTmuxPane: () => true,
      createHudWatchPane: () => '%9',
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.deepEqual(killed, ['%2']);
    assert.equal(result.status, 'recreated');
    assert.equal(result.paneId, '%9');
  });


  it('reaps a stale HUD pane for the same leader after the leader resumes with a new session id', async () => {
    const killed: string[] = [];
    const created: Array<{ options?: { targetPaneId?: string } }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%leader', OMX_SESSION_ID: 'sess-new', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%leader', currentCommand: 'codex', startCommand: 'codex' },
        {
          paneId: '%stale-hud',
          currentCommand: 'node',
          startCommand: `exec env OMX_SESSION_ID='sess-old' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%leader' node omx hud --watch --preset=focused`,
        },
      ],
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      createHudWatchPane: (_cwd, _cmd, options) => {
        created.push({ options });
        return '%new-hud';
      },
      resizeTmuxPane: () => true,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.deepEqual(killed, ['%stale-hud']);
    assert.equal(result.status, 'recreated');
    assert.equal(result.paneId, '%new-hud');
    assert.equal(created.length, 1);
    assert.equal(created[0]?.options?.targetPaneId, '%leader');
  });

  it('reaps a stale same-leader HUD even when a current-session HUD already exists', async () => {
    const killed: string[] = [];
    const created: string[] = [];
    const resized: Array<{ paneId: string; heightLines: number }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%leader', OMX_SESSION_ID: 'sess-new', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%leader', currentCommand: 'codex', startCommand: 'codex' },
        {
          paneId: '%current-hud',
          currentCommand: 'node',
          startCommand: `exec env OMX_SESSION_ID='sess-new' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%leader' node omx hud --watch --preset=focused`,
        },
        {
          paneId: '%stale-hud',
          currentCommand: 'node',
          startCommand: `exec env OMX_SESSION_ID='sess-old' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%leader' node omx hud --watch --preset=focused`,
        },
      ],
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      createHudWatchPane: () => {
        created.push('create');
        return '%new-hud';
      },
      resizeTmuxPane: (paneId, heightLines) => {
        resized.push({ paneId, heightLines });
        return true;
      },
      registerHudResizeHook: noOpRegisterHudResizeHook,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.deepEqual(killed, ['%stale-hud']);
    assert.deepEqual(created, []);
    assert.equal(result.status, 'resized');
    assert.equal(result.paneId, '%current-hud');
    assert.deepEqual(resized, [{ paneId: '%current-hud', heightLines: HUD_TMUX_HEIGHT_LINES }]);
  });

  it('does not reap a different-session HUD pane owned by a neighboring live leader', async () => {
    const killed: string[] = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%left', OMX_SESSION_ID: 'sess-left', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%left', currentCommand: 'codex', startCommand: 'codex' },
        { paneId: '%right', currentCommand: 'codex', startCommand: 'codex' },
        {
          paneId: '%right-hud',
          currentCommand: 'node',
          startCommand: `exec env OMX_SESSION_ID='sess-right' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%right' node omx hud --watch --preset=focused`,
        },
      ],
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      createHudWatchPane: () => '%left-hud',
      resizeTmuxPane: () => true,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.deepEqual(killed, []);
    assert.equal(result.status, 'recreated');
    assert.equal(result.paneId, '%left-hud');
  });

  it('does not reap an orphaned HUD pane that belongs to a different session', async () => {
    // A HUD owned by another session's leader (which may live in a different tmux
    // window we cannot see here) must survive even when that leader is absent.
    const killed: string[] = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        {
          paneId: '%4',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-b' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%5' node omx hud --watch`,
        },
      ],
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      resizeTmuxPane: () => true,
      createHudWatchPane: () => '%9',
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    // sess-b orphan is left untouched; this session simply creates its own HUD.
    assert.deepEqual(killed, []);
    assert.equal(result.status, 'recreated');
    assert.equal(result.paneId, '%9');
  });

  it('reaps a same-session orphan whose recorded leader is itself another HUD pane', async () => {
    // Review follow-up (#2682): when a HUD pane was mistakenly used as a leader, an
    // orphan can name another HUD pane as its leader. That referenced HUD must not
    // count as a live leader, or the orphan survives while the referenced HUD is
    // reaped — leaving a dangling strip that still never matches the real pane.
    const killed: string[] = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        {
          // orphan whose recorded leader (%3) is itself another HUD pane
          paneId: '%2',
          currentCommand: 'node',
          startCommand: `exec env OMX_SESSION_ID='sess-a' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%3' node omx hud --watch --preset=focused`,
        },
        {
          // the referenced HUD %3, itself orphaned (its leader %21 is gone)
          paneId: '%3',
          currentCommand: 'node',
          startCommand: `exec env OMX_SESSION_ID='sess-a' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%21' node omx hud --watch --preset=focused`,
        },
      ],
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      resizeTmuxPane: () => true,
      createHudWatchPane: () => '%9',
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    // Both HUD-led and dead-leader orphans are reaped; a single fresh HUD is created.
    assert.deepEqual(killed.sort(), ['%2', '%3']);
    assert.equal(result.status, 'recreated');
    assert.equal(result.paneId, '%9');
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
      unregisterHudResizeHook: noOpUnregisterHudResizeHook,
      registerHudResizeHook: noOpRegisterHudResizeHook,
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
      unregisterHudResizeHook: noOpUnregisterHudResizeHook,
      registerHudResizeHook: noOpRegisterHudResizeHook,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'recreated');
    assert.equal(created.length, 1);
    assert.match(
      created[0]?.cmd || '',
      /^exec env OMX_SESSION_ID='sess boxed' OMX_TMUX_HUD_OWNER='1' OMX_TMUX_HUD_LEADER_PANE='%1' OMX_ROOT='\/tmp\/boxed root\/it'\\''s\/\$\(literal\)' '.*' '.*omx\.js' hud --watch/,
    );
  });

  it('forwards OMX_STATE_ROOT when recreating HUD with shell-safe quoting', async () => {
    const created: string[] = [];
    const result = await reconcileHudForPromptSubmit('/repo', {
      env: {
        TMUX: '1',
        TMUX_PANE: '%1',
        OMX_SESSION_ID: 'sess-a',
        OMX_STATE_ROOT: '/boxed state/root',
        [OMX_TMUX_HUD_OWNER_ENV]: '1',
      },
      listCurrentWindowPanes: () => [{ paneId: '%1', currentCommand: 'codex', startCommand: 'codex' }],
      createHudWatchPane: (_cwd, hudCmd) => {
        created.push(hudCmd);
        return '%9';
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
      resizeTmuxPane: () => true,
      readHudConfig: async () => ({ preset: 'focused', git: { display: 'branch' }, statusLine: { preset: 'focused' } }),
      readAllState: async () => ({
        version: null,
        gitBranch: null,
        ralph: null,
        ultragoal: null,
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
    });

    assert.equal(result.status, 'recreated');
    assert.match(created[0] ?? '', /OMX_STATE_ROOT='\/boxed state\/root'/);
    assert.doesNotMatch(created[0] ?? '', /OMX_ROOT=/);
  });

  it('forwards OMX_TEAM_STATE_ROOT before boxed roots when recreating HUD', async () => {
    const created: string[] = [];
    const result = await reconcileHudForPromptSubmit('/repo', {
      env: {
        TMUX: '1',
        TMUX_PANE: '%1',
        OMX_SESSION_ID: 'sess-a',
        OMX_ROOT: '/boxed-root',
        OMX_STATE_ROOT: '/boxed-state-root',
        OMX_TEAM_STATE_ROOT: '/team-state-root',
        [OMX_TMUX_HUD_OWNER_ENV]: '1',
      },
      listCurrentWindowPanes: () => [{ paneId: '%1', currentCommand: 'codex', startCommand: 'codex' }],
      createHudWatchPane: (_cwd, hudCmd) => {
        created.push(hudCmd);
        return '%9';
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
      resizeTmuxPane: () => true,
      readHudConfig: async () => ({ preset: 'focused', git: { display: 'branch' }, statusLine: { preset: 'focused' } }),
      readAllState: async () => ({
        version: null,
        gitBranch: null,
        ralph: null,
        ultragoal: null,
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
    });

    assert.equal(result.status, 'recreated');
    assert.match(created[0] ?? '', /OMX_TEAM_STATE_ROOT='\/team-state-root'/);
    assert.doesNotMatch(created[0] ?? '', /OMX_ROOT=/);
    assert.doesNotMatch(created[0] ?? '', /OMX_STATE_ROOT=/);
  });

  it('targets the emitting pane window when listing and creating HUD panes', async () => {
    const listArgs: Array<string | undefined> = [];
    const created: Array<{ options?: { heightLines?: number; targetPaneId?: string } }> = [];

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
      unregisterHudResizeHook: noOpUnregisterHudResizeHook,
      registerHudResizeHook: noOpRegisterHudResizeHook,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'recreated');
    assert.deepEqual(listArgs, ['%leader', '%leader']);
    assert.equal(created[0]?.options?.targetPaneId, '%leader');
  });

  it('keeps prompt-submit HUD recreation scoped to the emitting pane in multi-pane windows', async () => {
    const created: Array<{ options?: { heightLines?: number; targetPaneId?: string } }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%right', OMX_SESSION_ID: 'sess-right', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%left', currentCommand: 'codex', startCommand: 'codex' },
        { paneId: '%right', currentCommand: 'codex', startCommand: 'codex' },
      ],
      createHudWatchPane: (_cwd, _cmd, options) => {
        created.push({ options });
        return '%hud-right';
      },
      resizeTmuxPane: () => true,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'recreated');
    assert.equal(created[0]?.options?.targetPaneId, '%right');
    assert.equal(Object.hasOwn(created[0]?.options ?? {}, 'fullWidth'), false);
  });

  it('keeps repeated left/right prompt-submit HUD recreation scoped to each pane when the neighboring pane already has a HUD', async () => {
    const created: Array<{ side: 'left' | 'right'; options?: { heightLines?: number; targetPaneId?: string } }> = [];
    const resized: Array<{ side: 'left' | 'right'; paneId: string; heightLines: number }> = [];
    const killed: string[] = [];

    const codexPane = (paneId: string) => ({
      paneId,
      currentCommand: 'codex',
      startCommand: 'codex',
    });

    const hudPane = (paneId: string, sessionId: string, leaderPaneId: string) => ({
      paneId,
      currentCommand: 'node',
      startCommand: `exec env OMX_SESSION_ID='${sessionId}' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='${leaderPaneId}' node omx hud --watch --preset=focused`,
    });

    const leftCreateResult = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%left', OMX_SESSION_ID: 'sess-left', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        codexPane('%left'),
        codexPane('%right'),
        hudPane('%hud-right', 'sess-right', '%right'),
      ],
      createHudWatchPane: (_cwd, _cmd, options) => {
        created.push({ side: 'left', options });
        return '%hud-left';
      },
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      resizeTmuxPane: (paneId, heightLines) => {
        resized.push({ side: 'left', paneId, heightLines });
        return true;
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    const leftRepeatResult = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%left', OMX_SESSION_ID: 'sess-left', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        codexPane('%left'),
        codexPane('%right'),
        hudPane('%hud-left', 'sess-left', '%left'),
        hudPane('%hud-right', 'sess-right', '%right'),
      ],
      createHudWatchPane: (_cwd, _cmd, options) => {
        created.push({ side: 'left', options });
        return '%hud-left-repeat';
      },
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      resizeTmuxPane: (paneId, heightLines) => {
        resized.push({ side: 'left', paneId, heightLines });
        return true;
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    const rightCreateResult = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%right', OMX_SESSION_ID: 'sess-right', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        codexPane('%left'),
        codexPane('%right'),
        hudPane('%hud-left', 'sess-left', '%left'),
      ],
      createHudWatchPane: (_cwd, _cmd, options) => {
        created.push({ side: 'right', options });
        return '%hud-right';
      },
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      resizeTmuxPane: (paneId, heightLines) => {
        resized.push({ side: 'right', paneId, heightLines });
        return true;
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    const rightRepeatResult = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%right', OMX_SESSION_ID: 'sess-right', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        codexPane('%left'),
        codexPane('%right'),
        hudPane('%hud-left', 'sess-left', '%left'),
        hudPane('%hud-right', 'sess-right', '%right'),
      ],
      createHudWatchPane: (_cwd, _cmd, options) => {
        created.push({ side: 'right', options });
        return '%hud-right-repeat';
      },
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      resizeTmuxPane: (paneId, heightLines) => {
        resized.push({ side: 'right', paneId, heightLines });
        return true;
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(leftCreateResult.status, 'recreated');
    assert.equal(leftCreateResult.paneId, '%hud-left');
    assert.equal(leftRepeatResult.status, 'resized');
    assert.equal(leftRepeatResult.paneId, '%hud-left');
    assert.equal(rightCreateResult.status, 'recreated');
    assert.equal(rightCreateResult.paneId, '%hud-right');
    assert.equal(rightRepeatResult.status, 'resized');
    assert.equal(rightRepeatResult.paneId, '%hud-right');
    assert.deepEqual(killed, []);
    assert.deepEqual(resized, [
      { side: 'left', paneId: '%hud-left', heightLines: HUD_TMUX_HEIGHT_LINES },
      { side: 'left', paneId: '%hud-left', heightLines: HUD_TMUX_HEIGHT_LINES },
      { side: 'right', paneId: '%hud-right', heightLines: HUD_TMUX_HEIGHT_LINES },
      { side: 'right', paneId: '%hud-right', heightLines: HUD_TMUX_HEIGHT_LINES },
    ]);
    assert.equal(created.length, 2);
    assert.equal(created[0]?.options?.targetPaneId, '%left');
    assert.equal(created[1]?.options?.targetPaneId, '%right');
    assert.equal(Object.hasOwn(created[0]?.options ?? {}, 'fullWidth'), false);
    assert.equal(Object.hasOwn(created[1]?.options ?? {}, 'fullWidth'), false);
  });

  it('keeps pane-scoped standalone HUDs stable when two leaders share a window bottom', async () => {
    const killed: string[] = [];
    const created: Array<{ options?: { heightLines?: number; fullWidth?: boolean; targetPaneId?: string } }> = [];
    const resized: Array<{ paneId: string; heightLines: number }> = [];

    const codexPane = (paneId: string, paneLeft: number, paneWidth: number) => ({
      paneId,
      currentCommand: 'codex',
      startCommand: 'codex',
      paneLeft,
      paneWidth,
      paneBottom: 36,
      windowWidth: 160,
      windowHeight: 40,
    });
    const hudPane = (paneId: string, sessionId: string, leaderPaneId: string, paneLeft: number, paneWidth: number) => ({
      paneId,
      currentCommand: 'node',
      startCommand: `exec env OMX_SESSION_ID='${sessionId}' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='${leaderPaneId}' node omx hud --watch --preset=focused`,
      paneLeft,
      paneWidth,
      paneHeight: HUD_TMUX_HEIGHT_LINES,
      paneBottom: 39,
      windowWidth: 160,
      windowHeight: 40,
    });

    const leftRepeatResult = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%left', OMX_SESSION_ID: 'sess-left', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        codexPane('%left', 0, 80),
        codexPane('%right', 80, 80),
        hudPane('%hud-left', 'sess-left', '%left', 0, 80),
        hudPane('%hud-right', 'sess-right', '%right', 80, 80),
      ],
      createHudWatchPane: (_cwd, _cmd, options) => {
        created.push({ options });
        return '%hud-left-repeat';
      },
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      resizeTmuxPane: (paneId, heightLines) => {
        resized.push({ paneId, heightLines });
        return true;
      },
      registerHudResizeHook: noOpRegisterHudResizeHook,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    const rightCreateResult = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%right', OMX_SESSION_ID: 'sess-right', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        codexPane('%left', 0, 80),
        codexPane('%right', 80, 80),
        hudPane('%hud-left', 'sess-left', '%left', 0, 80),
        // This is the launch-time standalone split for pane B. It is pane-scoped,
        // not full-window width, so prompt-submit/layout reconcile must keep it
        // instead of killing it and recreating a full-width HUD that competes with
        // pane A's HUD.
        hudPane('%hud-right', 'sess-right', '%right', 80, 80),
      ],
      createHudWatchPane: (_cwd, _cmd, options) => {
        created.push({ options });
        return '%hud-right-repeat';
      },
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      resizeTmuxPane: (paneId, heightLines) => {
        resized.push({ paneId, heightLines });
        return true;
      },
      registerHudResizeHook: noOpRegisterHudResizeHook,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(leftRepeatResult.status, 'unchanged');
    assert.equal(leftRepeatResult.paneId, '%hud-left');
    assert.equal(rightCreateResult.status, 'unchanged');
    assert.equal(rightCreateResult.paneId, '%hud-right');
    assert.deepEqual(killed, []);
    assert.deepEqual(created, []);
    assert.deepEqual(resized, []);
  });

  it('collapses same-owner HUD panes that appear during the create race window', async () => {
    const killed: string[] = [];
    const resized: Array<{ paneId: string; heightLines: number }> = [];
    let listCount = 0;

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-race', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => {
        listCount += 1;
        if (listCount === 1) {
          return [
            { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
          ];
        }
        return [
          { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
          {
            paneId: '%8',
            currentCommand: 'node',
            startCommand: `exec env OMX_SESSION_ID='sess-race' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
          },
          {
            paneId: '%9',
            currentCommand: 'node',
            startCommand: `exec env OMX_SESSION_ID='sess-race' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch --preset=focused`,
          },
        ];
      },
      createHudWatchPane: () => '%9',
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      resizeTmuxPane: (paneId, heightLines) => {
        resized.push({ paneId, heightLines });
        return true;
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'replaced_duplicates');
    assert.equal(result.paneId, '%9');
    assert.equal(result.duplicateCount, 1);
    assert.deepEqual(killed, ['%8']);
    assert.deepEqual(resized, [{ paneId: '%9', heightLines: HUD_TMUX_HEIGHT_LINES }]);
  });

  it('keeps an observed same-owner HUD when the returned create pane is absent from the post-create scan', async () => {
    const killed: string[] = [];
    const resized: Array<{ paneId: string; heightLines: number }> = [];
    let listCount = 0;

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-race', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => {
        listCount += 1;
        if (listCount === 1) return [{ paneId: '%1', currentCommand: 'codex', startCommand: 'codex' }];
        return [
          { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
          {
            paneId: '%8',
            currentCommand: 'node',
            startCommand: `exec env OMX_SESSION_ID='sess-race' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
          },
        ];
      },
      createHudWatchPane: () => '%9',
      killTmuxPane: (paneId) => { killed.push(paneId); return true; },
      resizeTmuxPane: (paneId, heightLines) => { resized.push({ paneId, heightLines }); return true; },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'recreated');
    assert.equal(result.paneId, '%8');
    assert.equal(result.duplicateCount, 0);
    assert.deepEqual(killed, []);
    assert.deepEqual(resized, [{ paneId: '%8', heightLines: HUD_TMUX_HEIGHT_LINES }]);
  });

  it('kills post-create duplicate HUD panes even when the keeper cannot be resized', async () => {
    const killed: string[] = [];
    const registered: string[] = [];
    let listCount = 0;

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-race', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => {
        listCount += 1;
        if (listCount === 1) return [{ paneId: '%1', currentCommand: 'codex', startCommand: 'codex' }];
        return [
          { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
          {
            paneId: '%8',
            currentCommand: 'node',
            startCommand: `exec env OMX_SESSION_ID='sess-race' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
          },
          {
            paneId: '%9',
            currentCommand: 'node',
            startCommand: `exec env OMX_SESSION_ID='sess-race' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
          },
        ];
      },
      createHudWatchPane: () => '%9',
      killTmuxPane: (paneId) => { killed.push(paneId); return true; },
      resizeTmuxPane: () => false,
      registerHudResizeHook: (paneId) => { registered.push(paneId); return true; },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.paneId, '%9');
    assert.equal(result.duplicateCount, 1);
    assert.deepEqual(killed, ['%8']);
    assert.deepEqual(registered, []);
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
      unregisterHudResizeHook: noOpUnregisterHudResizeHook,
      registerHudResizeHook: noOpRegisterHudResizeHook,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'replaced_duplicates');
    assert.equal(result.paneId, '%2');
    assert.deepEqual(killed, ['%3']);
    assert.deepEqual(resized, [{ paneId: '%2', heightLines: HUD_TMUX_HEIGHT_LINES }]);
    assert.deepEqual(created, []);
  });

  it('deduplicates same-leader HUD panes tagged with equivalent owner and canonical session ids', async () => {
    const killed: string[] = [];
    const resized: Array<{ paneId: string; heightLines: number }> = [];
    const created: Array<{ cmd: string }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'codex-native-uuid', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      sessionId: 'omx-owner-abc',
      sessionIds: ['omx-owner-abc', 'codex-native-uuid'],
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        {
          paneId: '%2',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='omx-owner-abc' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
        },
        {
          paneId: '%3',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='codex-native-uuid' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
        },
        {
          // Same equivalent session, but its recorded leader is itself a HUD pane;
          // the orphan reaper should remove it before normal same-leader dedupe.
          paneId: '%4',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='codex-native-uuid' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%4' node omx hud --watch`,
        },
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
    assert.equal(result.duplicateCount, 1);
    assert.deepEqual(killed, ['%4', '%3']);
    assert.deepEqual(resized, [{ paneId: '%2', heightLines: HUD_TMUX_HEIGHT_LINES }]);
    assert.deepEqual(created, []);
  });

  it('reuses and deduplicates legacy unowned focused HUD watch panes before recreating', async () => {
    const killed: string[] = [];
    const resized: Array<{ paneId: string; heightLines: number }> = [];
    const created: string[] = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        { paneId: '%2', currentCommand: 'node', startCommand: 'node /tmp/bin/omx.js hud --watch --preset=focused' },
        { paneId: '%3', currentCommand: 'node', startCommand: 'node /tmp/bin/omx.js hud --watch --preset=focused' },
        { paneId: '%4', currentCommand: 'node', startCommand: 'node /tmp/bin/omx.js hud --watch --preset=minimal' },
        { paneId: '%5', currentCommand: 'node', startCommand: 'node /tmp/bin/omx.js hud --tmux --preset=focused' },
      ],
      killTmuxPane: (paneId) => { killed.push(paneId); return true; },
      createHudWatchPane: () => { created.push('create'); return '%9'; },
      resizeTmuxPane: (paneId, heightLines) => { resized.push({ paneId, heightLines }); return true; },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'replaced_duplicates');
    assert.equal(result.paneId, '%2');
    assert.equal(result.duplicateCount, 1);
    assert.deepEqual(killed, ['%3']);
    assert.deepEqual(resized, [{ paneId: '%2', heightLines: HUD_TMUX_HEIGHT_LINES }]);
    assert.deepEqual(created, []);
  });

  it('treats an extra legacy focused pane as stale when an owned HUD already exists', async () => {
    const killed: string[] = [];
    const resized: Array<{ paneId: string; heightLines: number }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        {
          paneId: '%2',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch --preset=focused`,
        },
        { paneId: '%3', currentCommand: 'node', startCommand: 'node /tmp/bin/omx.js hud --watch --preset=focused' },
      ],
      killTmuxPane: (paneId) => { killed.push(paneId); return true; },
      resizeTmuxPane: (paneId, heightLines) => { resized.push({ paneId, heightLines }); return true; },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'replaced_duplicates');
    assert.equal(result.paneId, '%2');
    assert.equal(result.duplicateCount, 1);
    assert.deepEqual(killed, ['%3']);
    assert.deepEqual(resized, [{ paneId: '%2', heightLines: HUD_TMUX_HEIGHT_LINES }]);
  });

  it('deduplicates legacy focused panes that appear during the prompt-submit create race', async () => {
    const killed: string[] = [];
    const resized: Array<{ paneId: string; heightLines: number }> = [];
    let listCount = 0;

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-race', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => {
        listCount += 1;
        if (listCount === 1) return [{ paneId: '%1', currentCommand: 'codex', startCommand: 'codex' }];
        return [
          { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
          { paneId: '%8', currentCommand: 'node', startCommand: 'node /tmp/bin/omx.js hud --watch --preset=focused' },
          {
            paneId: '%9',
            currentCommand: 'node',
            startCommand: `exec env OMX_SESSION_ID='sess-race' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch --preset=focused`,
          },
        ];
      },
      createHudWatchPane: () => '%9',
      killTmuxPane: (paneId) => { killed.push(paneId); return true; },
      resizeTmuxPane: (paneId, heightLines) => { resized.push({ paneId, heightLines }); return true; },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'replaced_duplicates');
    assert.equal(result.paneId, '%9');
    assert.equal(result.duplicateCount, 1);
    assert.deepEqual(killed, ['%8']);
    assert.deepEqual(resized, [{ paneId: '%9', heightLines: HUD_TMUX_HEIGHT_LINES }]);
  });

  it('kills existing duplicate HUD panes even when the keeper cannot be resized', async () => {
    const killed: string[] = [];
    const registered: string[] = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        {
          paneId: '%8',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
        },
        {
          paneId: '%9',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
        },
      ],
      killTmuxPane: (paneId) => { killed.push(paneId); return true; },
      resizeTmuxPane: () => false,
      registerHudResizeHook: (paneId) => { registered.push(paneId); return true; },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.paneId, '%8');
    assert.equal(result.duplicateCount, 1);
    assert.deepEqual(killed, ['%9']);
    assert.deepEqual(registered, []);
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
      unregisterHudResizeHook: noOpUnregisterHudResizeHook,
      registerHudResizeHook: noOpRegisterHudResizeHook,
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
          startCommand: `env OMX_SESSION_ID='sess-b' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
        },
        {
          paneId: '%5',
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
      unregisterHudResizeHook: noOpUnregisterHudResizeHook,
      registerHudResizeHook: noOpRegisterHudResizeHook,
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
      registerHudResizeHook: noOpRegisterHudResizeHook,
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

  it('recreates instead of reusing a leader-only HUD pane when reviving with a canonical session id', async () => {
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

    assert.equal(result.status, 'recreated');
    assert.equal(result.paneId, '%9');
    assert.deepEqual(created, ['create']);
    assert.deepEqual(resized, [{ paneId: '%9', heightLines: HUD_TMUX_HEIGHT_LINES }]);
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

  it('leaves an existing full-width bottom HUD pane unchanged when geometry and height are healthy', async () => {
    const killed: string[] = [];
    const created: Array<{ options?: { heightLines?: number; fullWidth?: boolean; targetPaneId?: string } }> = [];
    const resized: Array<{ paneId: string; heightLines: number }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex', paneLeft: 0, paneTop: 0, paneWidth: 160, paneHeight: 50 - HUD_TMUX_HEIGHT_LINES, paneBottom: 49 - HUD_TMUX_HEIGHT_LINES, windowWidth: 160, windowHeight: 50 },
        {
          paneId: '%2',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
          paneLeft: 0,
          paneTop: 50 - HUD_TMUX_HEIGHT_LINES,
          paneWidth: 160,
          paneHeight: HUD_TMUX_HEIGHT_LINES,
          paneBottom: 49,
          windowWidth: 160,
          windowHeight: 50,
        },
      ],
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      createHudWatchPane: (_cwd, _cmd, options) => {
        created.push({ options });
        return '%9';
      },
      resizeTmuxPane: (paneId, heightLines) => {
        resized.push({ paneId, heightLines });
        return true;
      },
      registerHudResizeHook: noOpRegisterHudResizeHook,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'unchanged');
    assert.deepEqual(killed, []);
    assert.deepEqual(created, []);
    assert.deepEqual(resized, []);
  });

  it('recreates a single owned HUD pane when tmux layout narrows it below the window width', async () => {
    const killed: string[] = [];
    const resized: Array<{ paneId: string; heightLines: number }> = [];
    const created: Array<{ options?: { heightLines?: number; fullWidth?: boolean; targetPaneId?: string } }> = [];
    const registered: Array<{ hudPaneId: string; currentPaneId: string | undefined; heightLines: number }> = [];
    const unregistered: Array<string | undefined> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex', paneLeft: 0, paneTop: 0, paneWidth: 80, paneHeight: 50, paneBottom: 49, windowWidth: 160, windowHeight: 50 },
        {
          paneId: '%2',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
          paneLeft: 80,
          paneTop: 0,
          paneWidth: 80,
          paneHeight: 50,
          paneBottom: 49,
          windowWidth: 160,
          windowHeight: 50,
        },
        { paneId: '%3', currentCommand: 'codex', startCommand: 'codex', paneLeft: 0, paneTop: 25, paneWidth: 80, paneHeight: 25, paneBottom: 49, windowWidth: 160, windowHeight: 50 },
      ],
      unregisterHudResizeHook: (currentPaneId) => {
        unregistered.push(currentPaneId);
        return true;
      },
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      createHudWatchPane: (_cwd, _cmd, options) => {
        created.push({ options });
        return '%9';
      },
      resizeTmuxPane: (paneId, heightLines) => {
        resized.push({ paneId, heightLines });
        return true;
      },
      registerHudResizeHook: (hudPaneId, currentPaneId, heightLines) => {
        registered.push({ hudPaneId, currentPaneId, heightLines });
        return true;
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'recreated');
    assert.equal(result.paneId, '%9');
    assert.equal(result.duplicateCount, 0);
    assert.deepEqual(unregistered, ['%1']);
    assert.deepEqual(killed, ['%2']);
    assert.equal(created.length, 1);
    assert.equal(Object.hasOwn(created[0]?.options ?? {}, 'fullWidth'), false);
    assert.equal(created[0]?.options?.targetPaneId, '%1');
    assert.equal(created[0]?.options?.heightLines, HUD_TMUX_HEIGHT_LINES);
    assert.deepEqual(resized, [{ paneId: '%9', heightLines: HUD_TMUX_HEIGHT_LINES }]);
    assert.deepEqual(registered, [{ hudPaneId: '%9', currentPaneId: '%1', heightLines: HUD_TMUX_HEIGHT_LINES }]);
  });

  it('recreates a single owned HUD pane when tmux layout moves it away from the bottom', async () => {
    const killed: string[] = [];
    const created: Array<{ options?: { heightLines?: number; fullWidth?: boolean; targetPaneId?: string } }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex', paneLeft: 0, paneTop: 3, paneWidth: 160, paneHeight: 47, paneBottom: 49, windowWidth: 160, windowHeight: 50 },
        {
          paneId: '%2',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
          paneLeft: 0,
          paneTop: 0,
          paneWidth: 160,
          paneHeight: 3,
          paneBottom: 2,
          windowWidth: 160,
          windowHeight: 50,
        },
        { paneId: '%3', currentCommand: 'codex', startCommand: 'codex', paneLeft: 80, paneTop: 3, paneWidth: 80, paneHeight: 47, paneBottom: 49, windowWidth: 160, windowHeight: 50 },
      ],
      unregisterHudResizeHook: () => true,
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      createHudWatchPane: (_cwd, _cmd, options) => {
        created.push({ options });
        return '%9';
      },
      resizeTmuxPane: () => true,
      registerHudResizeHook: () => true,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'recreated');
    assert.deepEqual(killed, ['%2']);
    assert.equal(created[0]?.options?.fullWidth, true);
    assert.equal(created[0]?.options?.targetPaneId, '%1');
  });

  it('keeps a geometrically healthy duplicate HUD pane instead of preserving a malformed first duplicate', async () => {
    const killed: string[] = [];
    const resized: Array<{ paneId: string; heightLines: number }> = [];
    const created: Array<{ options?: { heightLines?: number; fullWidth?: boolean; targetPaneId?: string } }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex', paneLeft: 0, paneTop: 0, paneWidth: 160, paneHeight: 47, paneBottom: 46, windowWidth: 160, windowHeight: 50 },
        {
          paneId: '%bad',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
          paneLeft: 80,
          paneTop: 0,
          paneWidth: 80,
          paneHeight: 50,
          paneBottom: 49,
          windowWidth: 160,
          windowHeight: 50,
        },
        {
          paneId: '%good',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
          paneLeft: 0,
          paneTop: 47,
          paneWidth: 160,
          paneHeight: 3,
          paneBottom: 49,
          windowWidth: 160,
          windowHeight: 50,
        },
      ],
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      createHudWatchPane: (_cwd, _cmd, options) => {
        created.push({ options });
        return '%new';
      },
      resizeTmuxPane: (paneId, heightLines) => {
        resized.push({ paneId, heightLines });
        return true;
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'replaced_duplicates');
    assert.equal(result.paneId, '%good');
    assert.deepEqual(killed, ['%bad']);
    assert.deepEqual(resized, [{ paneId: '%good', heightLines: HUD_TMUX_HEIGHT_LINES }]);
    assert.deepEqual(created, []);
  });

  it('recreates duplicate HUD panes when every duplicate has malformed topology', async () => {
    const unregistered: Array<string | undefined> = [];
    const killed: string[] = [];
    const created: Array<{ options?: { heightLines?: number; fullWidth?: boolean; targetPaneId?: string } }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex', paneLeft: 0, paneTop: 0, paneWidth: 80, paneHeight: 50, paneBottom: 49, windowWidth: 160, windowHeight: 50 },
        {
          paneId: '%bad-a',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
          paneLeft: 80,
          paneTop: 0,
          paneWidth: 80,
          paneHeight: 50,
          paneBottom: 49,
          windowWidth: 160,
          windowHeight: 50,
        },
        {
          paneId: '%bad-b',
          currentCommand: 'node',
          startCommand: `env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
          paneLeft: 0,
          paneTop: 0,
          paneWidth: 160,
          paneHeight: 3,
          paneBottom: 2,
          windowWidth: 160,
          windowHeight: 50,
        },
      ],
      unregisterHudResizeHook: (leaderPaneId) => {
        unregistered.push(leaderPaneId);
        return true;
      },
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      createHudWatchPane: (_cwd, _cmd, options) => {
        created.push({ options });
        return '%new';
      },
      resizeTmuxPane: () => true,
      registerHudResizeHook: () => true,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(result.status, 'replaced_duplicates');
    assert.equal(result.paneId, '%new');
    assert.deepEqual(unregistered, ['%1']);
    assert.deepEqual(killed, ['%bad-a', '%bad-b']);
    assert.equal(created.length, 1);
    assert.equal(Object.hasOwn(created[0]?.options ?? {}, 'fullWidth'), false);
    assert.equal(created[0]?.options?.targetPaneId, '%1');
  });

  it('registers client-resized hook scoped from the emitting pane after resizing an existing HUD pane', async () => {
    const registered: Array<{ hudPaneId: string; leaderPaneId: string | undefined; heightLines: number }> = [];

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
      registerHudResizeHook: (hudPaneId, leaderPaneId, heightLines) => {
        registered.push({ hudPaneId, leaderPaneId, heightLines });
        return true;
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(registered.length, 1);
    assert.equal(registered[0]?.hudPaneId, '%2');
    assert.equal(registered[0]?.leaderPaneId, '%1');
    assert.equal(registered[0]?.heightLines, HUD_TMUX_HEIGHT_LINES);
  });

  it('registers client-resized hook scoped from the emitting pane after creating a new HUD pane', async () => {
    const registered: Array<{ hudPaneId: string; leaderPaneId: string | undefined; heightLines: number }> = [];

    await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
      ],
      createHudWatchPane: () => '%9',
      resizeTmuxPane: () => true,
      unregisterHudResizeHook: noOpUnregisterHudResizeHook,
      registerHudResizeHook: (hudPaneId, leaderPaneId, heightLines) => {
        registered.push({ hudPaneId, leaderPaneId, heightLines });
        return true;
      },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.equal(registered.length, 1);
    assert.equal(registered[0]?.hudPaneId, '%9');
    assert.equal(registered[0]?.leaderPaneId, '%1');
    assert.equal(registered[0]?.heightLines, HUD_TMUX_HEIGHT_LINES);
  });

  it('keeps the resize hook on the reused duplicate keeper pane', async () => {
    const unregistered: Array<string | undefined> = [];
    const registered: Array<{ hudPaneId: string; leaderPaneId: string | undefined }> = [];

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
      unregisterHudResizeHook: (leaderPaneId) => { unregistered.push(leaderPaneId); return true; },
      registerHudResizeHook: (hudPaneId, leaderPaneId) => { registered.push({ hudPaneId, leaderPaneId }); return true; },
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
    });

    assert.deepEqual(unregistered, []);
    assert.equal(registered.length, 1);
    assert.equal(registered[0]?.hudPaneId, '%2');
    assert.equal(registered[0]?.leaderPaneId, '%1');
  });
});

describe('reconcileHudForPromptSubmit cramped-window guard (#2754)', () => {
  const crampedHeight = HUD_TMUX_MIN_LAUNCH_WINDOW_HEIGHT_LINES - 1;
  const roomyHeight = HUD_TMUX_MIN_LAUNCH_WINDOW_HEIGHT_LINES;

  it('does not create a HUD split on prompt submit when the existing window is too cramped', async () => {
    const created: string[] = [];
    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
      ],
      createHudWatchPane: (_cwd, cmd) => {
        created.push(cmd);
        return '%9';
      },
      resizeTmuxPane: () => true,
      unregisterHudResizeHook: noOpUnregisterHudResizeHook,
      registerHudResizeHook: noOpRegisterHudResizeHook,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
      readCurrentWindowSize: () => ({ width: 160, height: crampedHeight }),
    });

    assert.equal(result.status, 'skipped_window_too_cramped');
    assert.equal(result.paneId, null);
    assert.deepEqual(created, []);
  });

  it('uses the default tmux window-size reader when production deps omit an injected reader', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-cramped-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const tmuxBin = join(fakeBinDir, 'tmux');
    const originalPath = process.env.PATH;

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(
        tmuxBin,
        `#!/usr/bin/env bash
set -eu
printf '[%s]' "$@" >> "${tmuxLogPath}"
printf '\n' >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  printf '160\t${crampedHeight}'
fi
if [[ "$cmd" == "list-panes" ]]; then
  printf '%%1\\037codex\\0370\\0370\\037160\\03724\\03723\\037160\\037${crampedHeight}\\037codex\\037/repo'
fi
`,
      );
      await chmod(tmuxBin, 0o755);
      process.env.PATH = `${fakeBinDir}:${originalPath ?? ''}`;

      const created: string[] = [];
      const result = await reconcileHudForPromptSubmit('/repo', {
        env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
        sessionId: 'sess-a',
        sessionIds: ['sess-a'],
        createHudWatchPane: (_cwd, cmd) => {
          created.push(cmd);
          return '%9';
        },
        resizeTmuxPane: () => true,
        unregisterHudResizeHook: noOpUnregisterHudResizeHook,
        registerHudResizeHook: noOpRegisterHudResizeHook,
        resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
      });

      assert.equal(result.status, 'skipped_window_too_cramped');
      assert.equal(result.paneId, null);
      assert.deepEqual(created, []);
      const log = await readFile(tmuxLogPath, 'utf-8');
      assert.match(log, /\[list-panes\]\[-t\]\[%1\]/);
      assert.match(log, /\[display-message\]\[-p\]\[-t\]\[%1\]\[#\{window_width\}\t#\{window_height\}\]/);
    } finally {
      process.env.PATH = originalPath;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('creates the HUD on prompt submit when the existing window has room', async () => {
    const created: string[] = [];
    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
      ],
      createHudWatchPane: (_cwd, cmd) => {
        created.push(cmd);
        return '%9';
      },
      resizeTmuxPane: () => true,
      unregisterHudResizeHook: noOpUnregisterHudResizeHook,
      registerHudResizeHook: noOpRegisterHudResizeHook,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
      readCurrentWindowSize: () => ({ width: 160, height: roomyHeight }),
    });

    assert.equal(result.status, 'recreated');
    assert.equal(result.paneId, '%9');
    assert.equal(created.length, 1);
  });

  it('creates the HUD on prompt submit when the window height is unknown', async () => {
    const created: string[] = [];
    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
      ],
      createHudWatchPane: (_cwd, cmd) => {
        created.push(cmd);
        return '%9';
      },
      resizeTmuxPane: () => true,
      unregisterHudResizeHook: noOpUnregisterHudResizeHook,
      registerHudResizeHook: noOpRegisterHudResizeHook,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
      readCurrentWindowSize: () => ({ width: null, height: null }),
    });

    assert.equal(result.status, 'recreated');
    assert.equal(created.length, 1);
  });

  it('keeps an existing HUD pane even when the window is cramped', async () => {
    const created: string[] = [];
    const resized: Array<{ paneId: string; lines: number }> = [];
    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1', OMX_SESSION_ID: 'sess-a', [OMX_TMUX_HUD_OWNER_ENV]: '1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        {
          paneId: '%2',
          currentCommand: 'node',
          startCommand: `exec env OMX_SESSION_ID='sess-a' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch --preset=focused`,
        },
      ],
      createHudWatchPane: (_cwd, cmd) => {
        created.push(cmd);
        return '%9';
      },
      resizeTmuxPane: (paneId, lines) => {
        resized.push({ paneId, lines });
        return true;
      },
      unregisterHudResizeHook: noOpUnregisterHudResizeHook,
      registerHudResizeHook: noOpRegisterHudResizeHook,
      resolveOmxCliEntryPath: () => '/repo/dist/cli/omx.js',
      readCurrentWindowSize: () => ({ width: 160, height: crampedHeight }),
    });

    // The cramped guard only blocks fresh creation; an already-present HUD pane
    // is kept (resized) rather than removed.
    assert.equal(result.status, 'resized');
    assert.equal(result.paneId, '%2');
    assert.deepEqual(created, []);
    assert.equal(resized[0]?.paneId, '%2');
    assert.equal(resized[0]?.lines, HUD_TMUX_HEIGHT_LINES);
  });
});
