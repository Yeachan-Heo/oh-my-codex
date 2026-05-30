import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHudResizeHookName,
  buildHudResizeHookSlot,
  buildHudWatchCommand,
  findHudWatchPaneIds,
  hudPaneMatchesOwner,
  listCurrentWindowHudPaneIds,
  OMX_TMUX_HUD_LEADER_PANE_ENV,
  parseTmuxPaneSnapshot,
  readActiveTmuxPaneId,
  readHudPaneOwner,
  reapDeadHudPanes,
  parseHudResizeHookContext,
  registerHudResizeHook,
  unregisterHudResizeHook,
} from '../tmux.js';
import { HUD_RESIZE_RECONCILE_DELAY_SECONDS } from '../constants.js';

describe('HUD resize hook helpers', () => {
  it('builds a deterministic hook name from the tmux session and window identity', () => {
    assert.equal(buildHudResizeHookName('$7', '@3'), 'omx_hud_resize_7_3');
  });

  it('builds a bounded numeric client-resized slot', () => {
    const slot = buildHudResizeHookSlot('omx_hud_resize_7_3');
    assert.match(slot, /^client-resized\[\d+\]$/);

    const index = Number.parseInt(slot.replace(/^client-resized\[|\]$/g, ''), 10);
    assert.ok(index >= 0);
    assert.ok(index < 2147483647);
  });

  it('parses hook context from tmux display-message output', () => {
    const context = parseHudResizeHookContext('$7\t@3\n');

    assert.deepEqual(context, {
      sessionId: '$7',
      windowId: '@3',
      hookName: 'omx_hud_resize_7_3',
      hookSlot: buildHudResizeHookSlot('omx_hud_resize_7_3'),
    });
  });

  it('registers a client-resized hook at session scope with exact HUD pane targeting', () => {
    const calls: string[][] = [];

    const result = registerHudResizeHook('%9', '%1', 3, (args) => {
      calls.push(args);
      if (args[0] === 'display-message') return '$7\t@3\n';
      return '';
    });

    const hookSlot = buildHudResizeHookSlot('omx_hud_resize_7_3');
    assert.equal(result, true);
    assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%1', '#{session_id}\t#{window_id}']);
    assert.equal(calls[1]?.[0], 'set-hook');
    assert.equal(calls[1]?.[1], '-t');
    assert.equal(calls[1]?.[2], '$7');
    assert.equal(calls[1]?.[3], hookSlot);
    assert.match(calls[1]?.[4] ?? '', /^run-shell -b /);
    assert.match(calls[1]?.[4] ?? '', /resize-pane/);
    assert.match(calls[1]?.[4] ?? '', /set-hook/);
    assert.doesNotMatch(calls[1]?.[4] ?? '', /'-w'/);
    assert.match(calls[1]?.[4] ?? '', new RegExp(`sleep ${HUD_RESIZE_RECONCILE_DELAY_SECONDS}`));
    assert.match(calls[1]?.[4] ?? '', new RegExp(hookSlot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('unregisters the same per-window hook slot', () => {
    const calls: string[][] = [];

    const result = unregisterHudResizeHook('%1', (args) => {
      calls.push(args);
      if (args[0] === 'display-message') return '$7\t@3\n';
      return '';
    });

    assert.equal(result, true);
    assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%1', '#{session_id}\t#{window_id}']);
    assert.deepEqual(calls[1], [
      'set-hook',
      '-u',
      '-t',
      '$7',
      buildHudResizeHookSlot('omx_hud_resize_7_3'),
    ]);
  });

  it('uses distinct hook slots for different windows in the same session', () => {
    const registered: string[][] = [];

    const execFor = (windowId: string) => (args: string[]) => {
      if (args[0] === 'display-message') return `$7\t${windowId}\n`;
      registered.push(args);
      return '';
    };

    assert.equal(registerHudResizeHook('%9', '%1', 3, execFor('@3')), true);
    assert.equal(registerHudResizeHook('%10', '%2', 3, execFor('@4')), true);

    const firstSlot = registered[0]?.[3];
    const secondSlot = registered[1]?.[3];
    assert.match(firstSlot ?? '', /^client-resized\[\d+\]$/);
    assert.match(secondSlot ?? '', /^client-resized\[\d+\]$/);
    assert.notEqual(firstSlot, secondSlot);
  });

  it('reuses the same hook slot when a HUD pane is recreated in the same window', () => {
    const registered: string[][] = [];
    const execTmuxSync = (args: string[]) => {
      if (args[0] === 'display-message') return '$7\t@3\n';
      registered.push(args);
      return '';
    };

    assert.equal(registerHudResizeHook('%9', '%1', 3, execTmuxSync), true);
    assert.equal(registerHudResizeHook('%10', '%1', 3, execTmuxSync), true);

    assert.equal(registered[0]?.[3], registered[1]?.[3]);
  });
});

describe('HUD pane ownership helpers', () => {
  it('reads session and leader ownership from env-prefixed HUD commands', () => {
    const [pane] = parseTmuxPaneSnapshot(
      `%9\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
    );

    assert.deepEqual(readHudPaneOwner(pane!), {
      sessionId: 'sess-a',
      leaderPaneId: '%1',
    });
    assert.equal(hudPaneMatchesOwner(pane!, { sessionId: 'sess-a', leaderPaneId: '%1' }), true);
    assert.equal(hudPaneMatchesOwner(pane!, { sessionId: 'sess-b', leaderPaneId: '%2' }), false);
  });

  it('reads ownership from quoted tmux shell env arguments used by inside-tmux launch', () => {
    const [pane] = parseTmuxPaneSnapshot(
      `%9\tnode\t/bin/zsh -c 'exec '\\''env'\\'' '\\''OMX_SESSION_ID=sess-a'\\'' '\\''${OMX_TMUX_HUD_LEADER_PANE_ENV}=%1'\\'' '\\''node'\\'' '\\''/omx.js'\\'' '\\''hud'\\'' '\\''--watch'\\'''`,
    );

    assert.deepEqual(readHudPaneOwner(pane!), {
      sessionId: 'sess-a',
      leaderPaneId: '%1',
    });
  });

  it('preserves tab-containing start commands when reading the optional cwd column', () => {
    const [pane] = parseTmuxPaneSnapshot('%9\tnode\tnode\t/omx.js hud --watch\t/tmp/repo');

    assert.equal(pane?.startCommand, 'node\t/omx.js hud --watch');
    assert.equal(pane?.currentPath, '/tmp/repo');
  });

  it('keeps independent leaders in one tmux window from matching each other HUD panes', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        '%3\tcodex\tcodex',
        `%4\tnode\texec env OMX_SESSION_ID='sess-b' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%3' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%3', { sessionId: 'sess-b', leaderPaneId: '%3' }), ['%4']);
    assert.deepEqual(findHudWatchPaneIds(panes, '%3', { sessionId: 'sess-a', leaderPaneId: '%1' }), ['%2']);
  });

  it('matches same-leader HUD panes across session ids for same-pane relaunch cleanup', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_SESSION_ID='old-session' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%3\tnode\texec env OMX_SESSION_ID='new-session' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%4\tnode\texec env OMX_SESSION_ID='other-session' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%9' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { leaderPaneId: '%1' }), ['%2', '%3']);
    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'new-session', leaderPaneId: '%1' }), ['%2', '%3']);
  });

  it('matches owner-tagged same-leader HUD panes even when the current revive has only a canonical session id', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-canonical', leaderPaneId: '%1' }), ['%2']);
  });

  it('does not owner-match a different live leader just because the session id matches', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        '%3\tcodex\tcodex',
        `%4\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%3' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-a', leaderPaneId: '%1' }), []);
  });

  it('does not owner-match untagged HUD panes when an owner scope is requested', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        '%2\tnode\tnode /tmp/bin/omx.js hud --watch',
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-a', leaderPaneId: '%1' }), []);
    assert.deepEqual(findHudWatchPaneIds(panes, '%1'), ['%2']);
  });

  it('matches session-owned legacy HUD panes without leader tags for same-session cleanup', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        "%2\tnode\texec env OMX_SESSION_ID='sess-a' /node /omx.js hud --watch",
        "%3\tnode\texec env OMX_SESSION_ID='sess-b' /node /omx.js hud --watch",
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-a', leaderPaneId: '%1' }), ['%2']);
  });

  it('finds one same-session HUD pane when TMUX_PANE is unavailable', () => {
    const calls: string[][] = [];
    const execTmuxSync = (args: string[]) => {
      calls.push(args);
      return [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
      ].join('\n');
    };

    assert.deepEqual(listCurrentWindowHudPaneIds(undefined, execTmuxSync, { sessionId: 'sess-a' }), ['%2']);
    assert.deepEqual(calls, [
      ['list-panes', '-F', '#{pane_id}\x1f#{pane_current_command}\x1f#{pane_start_command}\x1f#{pane_current_path}'],
    ]);
  });

  it('keeps active-pane fallback isolated from a different same-session leader HUD', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        '%3\tcodex\tcodex',
        `%4\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%3' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-a', leaderPaneId: '%1' }), []);
  });

  it('resolves the active tmux pane as a TMUX_PANE fallback', () => {
    const calls: string[][] = [];
    const paneId = readActiveTmuxPaneId((args) => {
      calls.push(args);
      return '%7\n';
    });

    assert.equal(paneId, '%7');
    assert.deepEqual(calls, [['display-message', '-p', '#{pane_id}']]);
  });

  it('tags reconciled HUD watch commands with the leader pane owner', () => {
    const cmd = buildHudWatchCommand('/usr/bin/omx.js', undefined, 'sess-a', undefined, '%1');

    assert.match(cmd, /OMX_SESSION_ID='sess-a'/);
    assert.match(cmd, /OMX_TMUX_HUD_OWNER='1'/);
    assert.match(cmd, new RegExp(`${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1'`));
  });

  it('tags reconciled HUD watch commands as OMX-owned even without a session id', () => {
    const cmd = buildHudWatchCommand('/usr/bin/omx.js', undefined, '', undefined, '%1');

    assert.doesNotMatch(cmd, /OMX_SESSION_ID=/);
    assert.match(cmd, /OMX_TMUX_HUD_OWNER='1'/);
    assert.match(cmd, new RegExp(`${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1'`));
  });
});

describe('dead HUD pane reaper', () => {
  it('kills HUD panes whose leader pane is not present in the snapshot', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%9' /node /omx.js hud --watch`,
      ].join('\n'),
    );
    const killed: string[] = [];

    const result = reapDeadHudPanes(panes, {
      killPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
    });

    assert.deepEqual(killed, ['%2']);
    assert.deepEqual(result, { reaped: ['%2'], preserved: [] });
  });

  it('preserves HUD panes whose leader pane is alive', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    const result = reapDeadHudPanes(panes, {
      killPane: () => {
        throw new Error('live leader HUD should not be killed');
      },
    });

    assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
  });

  it('preserves legacy HUD panes with no leader tag by default', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        '%2\tnode\tnode /tmp/bin/omx.js hud --watch',
      ].join('\n'),
    );

    const result = reapDeadHudPanes(panes, {
      killPane: () => {
        throw new Error('legacy untagged HUD should not be killed');
      },
    });

    assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
  });

  it('kills untagged HUD panes whose tmux cwd has been deleted', () => {
    const deletedPath = join(tmpdir(), `omx-doctor-native-hook-dist-${process.pid}-${Date.now()} (deleted)`);
    rmSync(deletedPath, { recursive: true, force: true });
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\texec env OMX_TMUX_HUD_OWNER='1' /tmp/bin/omx.js hud --watch\t${deletedPath}`,
      ].join('\n'),
    );
    const killed: string[] = [];

    const result = reapDeadHudPanes(panes, {
      killPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
    });

    assert.deepEqual(killed, ['%2']);
    assert.deepEqual(result, { reaped: ['%2'], preserved: [] });
  });

  it('kills deleted-cwd doctor-smoke HUD panes even when an old owner tag points at a live leader', () => {
    const deletedPath = join(tmpdir(), `omx-doctor-plugin-hook-${process.pid}-${Date.now()} (deleted)`);
    rmSync(deletedPath, { recursive: true, force: true });
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\texec env OMX_SESSION_ID='doctor-smoke' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch\t${deletedPath}`,
      ].join('\n'),
    );
    const killed: string[] = [];

    const result = reapDeadHudPanes(panes, {
      killPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
    });

    assert.deepEqual(killed, ['%2']);
    assert.deepEqual(result, { reaped: ['%2'], preserved: [] });
  });

  it('preserves non-doctor deleted-cwd HUD panes while their leader is still live', () => {
    const deletedPath = join(tmpdir(), `omx-live-leader-deleted-cwd-${process.pid}-${Date.now()} (deleted)`);
    rmSync(deletedPath, { recursive: true, force: true });
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\texec env OMX_SESSION_ID='sess-live' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch\t${deletedPath}`,
      ].join('\n'),
    );

    const result = reapDeadHudPanes(panes, {
      killPane: () => {
        throw new Error('live leader HUD with stale launch cwd should not be killed');
      },
    });

    assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
  });

  it('kills deleted-cwd HUD panes when their owner leader is no longer live', () => {
    const deletedPath = join(tmpdir(), `omx-dead-leader-deleted-cwd-${process.pid}-${Date.now()} (deleted)`);
    rmSync(deletedPath, { recursive: true, force: true });
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\texec env OMX_SESSION_ID='sess-stale' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%9' /node /omx.js hud --watch\t${deletedPath}`,
      ].join('\n'),
    );
    const killed: string[] = [];

    const result = reapDeadHudPanes(panes, {
      killPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
    });

    assert.deepEqual(killed, ['%2']);
    assert.deepEqual(result, { reaped: ['%2'], preserved: [] });
  });

  it('preserves HUD panes in an existing cwd whose name ends with the deleted marker text', () => {
    const parent = mkdtempSync(join(tmpdir(), 'omx-live-cwd-'));
    const liveDeletedSuffixPath = join(parent, 'live (deleted)');
    mkdirSync(liveDeletedSuffixPath);
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\texec env OMX_SESSION_ID='live' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch\t${liveDeletedSuffixPath}`,
      ].join('\n'),
    );

    try {
      const result = reapDeadHudPanes(panes, {
        killPane: () => {
          throw new Error('live cwd with literal marker suffix should not be killed');
        },
      });

      assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('preserves live deleted-marker cwd paths containing tabs from the tmux list separator', () => {
    const parent = mkdtempSync(join(tmpdir(), 'omx-tab-live-cwd-'));
    const liveDeletedSuffixPath = join(parent, 'left\tlive (deleted)');
    mkdirSync(liveDeletedSuffixPath);
    const separator = '\x1f';
    const panes = parseTmuxPaneSnapshot(
      [
        ['%1', 'codex', 'codex', '/repo'].join(separator),
        [
          '%2',
          'node',
          `exec env OMX_SESSION_ID='live' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
          liveDeletedSuffixPath,
        ].join(separator),
      ].join('\n'),
    );

    try {
      const result = reapDeadHudPanes(panes, {
        killPane: () => {
          throw new Error('live tab cwd with literal marker suffix should not be killed');
        },
      });

      assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('preserves deleted-cwd panes with misleading HUD text but no OMX owner metadata', () => {
    const deletedPath = join(tmpdir(), `omx-misleading-hud-text-${process.pid}-${Date.now()} (deleted)`);
    rmSync(deletedPath, { recursive: true, force: true });
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\tSUCCESS but not an OMX pane: hud --watch\t${deletedPath}`,
      ].join('\n'),
    );

    const result = reapDeadHudPanes(panes, {
      killPane: () => {
        throw new Error('misleading non-OMX HUD text should not be killed');
      },
    });

    assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
  });

  it('does not touch non-HUD panes', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%9' /node /omx.js sidecar --watch`,
      ].join('\n'),
    );

    const result = reapDeadHudPanes(panes, {
      killPane: () => {
        throw new Error('non-HUD panes should not be killed');
      },
    });

    assert.deepEqual(result, { reaped: [], preserved: [] });
  });

  it('uses an explicit live-pane predicate for reaper decisions', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%3\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%9' /node /omx.js hud --watch`,
      ].join('\n'),
    );
    const killed: string[] = [];

    const result = reapDeadHudPanes(panes, {
      isLivePane: (paneId) => paneId === '%9',
      killPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
    });

    assert.deepEqual(killed, ['%2']);
    assert.deepEqual(result, { reaped: ['%2'], preserved: ['%3'] });
  });
});
