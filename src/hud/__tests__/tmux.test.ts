import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHudResizeHookName,
  buildHudResizeHookSlot,
  buildHudWatchCommand,
  findLegacyFocusedHudWatchPaneIds,
  findHudWatchPaneIds,
  hudPaneMatchesOwner,
  listCurrentWindowHudPaneIds,
  OMX_TMUX_HUD_LEADER_PANE_ENV,
  TMUX_PANE_FIELD_SEPARATOR_OCTAL_ESCAPE,
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
  it('builds a deterministic hook name from the tmux session, window, and leader identity', () => {
    assert.equal(buildHudResizeHookName('$7', '@3', '%1'), 'omx_hud_resize_7_3_1');
  });

  it('builds a bounded numeric client-resized slot', () => {
    const slot = buildHudResizeHookSlot('omx_hud_resize_7_3_1');
    assert.match(slot, /^client-resized\[\d+\]$/);

    const index = Number.parseInt(slot.replace(/^client-resized\[|\]$/g, ''), 10);
    assert.ok(index >= 0);
    assert.ok(index < 2147483647);
  });

  it('parses hook context from tmux display-message output', () => {
    const context = parseHudResizeHookContext('$7\t@3\n', '%1');

    assert.deepEqual(context, {
      sessionId: '$7',
      windowId: '@3',
      leaderPaneId: '%1',
      hookName: 'omx_hud_resize_7_3_1',
      hookSlot: buildHudResizeHookSlot('omx_hud_resize_7_3_1'),
    });
  });

  it('rejects malformed tmux ids in hook context output', () => {
    assert.equal(parseHudResizeHookContext('$7; touch /tmp/owned\t@3\n', '%1'), null);
    assert.equal(parseHudResizeHookContext('$7\t@3$(touch /tmp/owned)\n', '%1'), null);
    assert.equal(parseHudResizeHookContext('$7\t@3\n', '%1; touch /tmp/owned'), null);
  });

  it('registers a client-resized hook at session scope with exact HUD pane targeting', () => {
    const calls: string[][] = [];

    const result = registerHudResizeHook('%9', '%1', 3, (args) => {
      calls.push(args);
      if (args[0] === 'display-message') return '$7\t@3\n';
      return '';
    });

    const hookSlot = buildHudResizeHookSlot('omx_hud_resize_7_3_1');
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
    assert.deepEqual(calls[2], ['set-hook', '-u', '-t', '$7', buildHudResizeHookSlot('omx_hud_resize_7_3')]);
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
    assert.deepEqual(calls[1], ['set-hook', '-u', '-t', '$7', buildHudResizeHookSlot('omx_hud_resize_7_3')]);
    assert.deepEqual(calls[2], [
      'set-hook',
      '-u',
      '-t',
      '$7',
      buildHudResizeHookSlot('omx_hud_resize_7_3_1'),
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
    const secondSlot = registered[2]?.[3];
    assert.match(firstSlot ?? '', /^client-resized\[\d+\]$/);
    assert.match(secondSlot ?? '', /^client-resized\[\d+\]$/);
    assert.notEqual(firstSlot, secondSlot);
  });

  it('uses distinct hook slots for different leaders in the same session window', () => {
    const registered: string[][] = [];
    const execTmuxSync = (args: string[]) => {
      if (args[0] === 'display-message') return '$7\t@3\n';
      registered.push(args);
      return '';
    };

    assert.equal(registerHudResizeHook('%9', '%1', 3, execTmuxSync), true);
    assert.equal(registerHudResizeHook('%10', '%2', 3, execTmuxSync), true);

    const firstSlot = registered[0]?.[3];
    const secondSlot = registered[2]?.[3];
    assert.match(firstSlot ?? '', /^client-resized\[\d+\]$/);
    assert.match(secondSlot ?? '', /^client-resized\[\d+\]$/);
    assert.notEqual(firstSlot, secondSlot);
  });

  it('reuses the same hook slot when a HUD pane is recreated for the same leader', () => {
    const registered: string[][] = [];
    const execTmuxSync = (args: string[]) => {
      if (args[0] === 'display-message') return '$7\t@3\n';
      registered.push(args);
      return '';
    };

    assert.equal(registerHudResizeHook('%9', '%1', 3, execTmuxSync), true);
    assert.equal(registerHudResizeHook('%10', '%1', 3, execTmuxSync), true);

    assert.equal(registered[0]?.[3], registered[2]?.[3]);
  });

  it('does not unregister the legacy hook when installing the leader-scoped hook fails', () => {
    const calls: string[][] = [];

    const result = registerHudResizeHook('%9', '%1', 3, (args) => {
      calls.push(args);
      if (args[0] === 'display-message') return '$7\t@3\n';
      if (args[0] === 'set-hook' && args[1] === '-t') throw new Error('transient tmux failure');
      return '';
    });

    assert.equal(result, false);
    assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
      ['display-message', '-p'],
      ['set-hook', '-t'],
    ]);
  });

  it('keeps registration successful when legacy cleanup fails after installing the leader-scoped hook', () => {
    const calls: string[][] = [];

    const result = registerHudResizeHook('%9', '%1', 3, (args) => {
      calls.push(args);
      if (args[0] === 'display-message') return '$7\t@3\n';
      if (args[0] === 'set-hook' && args[1] === '-u') throw new Error('stale legacy cleanup failure');
      return '';
    });

    assert.equal(result, true);
    assert.equal(calls[1]?.[0], 'set-hook');
    assert.equal(calls[1]?.[1], '-t');
    assert.deepEqual(calls[2], ['set-hook', '-u', '-t', '$7', buildHudResizeHookSlot('omx_hud_resize_7_3')]);
  });

  it('unregisters only the leader-scoped hook slot for the selected leader', () => {
    const unregistered: string[][] = [];
    const execTmuxSync = (args: string[]) => {
      if (args[0] === 'display-message') return '$7\t@3\n';
      unregistered.push(args);
      return '';
    };

    assert.equal(unregisterHudResizeHook('%2', execTmuxSync), true);

    assert.deepEqual(unregistered[0], ['set-hook', '-u', '-t', '$7', buildHudResizeHookSlot('omx_hud_resize_7_3')]);
    assert.deepEqual(unregistered[1], [
      'set-hook',
      '-u',
      '-t',
      '$7',
      buildHudResizeHookSlot('omx_hud_resize_7_3_2'),
    ]);
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

  it('splits tmux octal-escaped control separators from live list-panes output', () => {
    const escapedSeparator = TMUX_PANE_FIELD_SEPARATOR_OCTAL_ESCAPE;
    const panes = parseTmuxPaneSnapshot(
      [
        ['%140', 'node', '', '/home/tools/oh-my-codex'].join(escapedSeparator),
        [
          '%202',
          'node',
          `"exec env OMX_SESSION_ID='sess-a' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%140' OMX_ROOT='/tmp/run' '/usr/bin/node' '/repo/dist/cli/omx.js' hud --watch --preset=focused"`,
          '/home/tools/oh-my-codex.omx-worktrees/launch-fix-default-subagent-fix',
        ].join(escapedSeparator),
      ].join('\n'),
    );

    assert.equal(panes.length, 2);
    assert.equal(panes[0]?.paneId, '%140');
    assert.equal(panes[0]?.currentCommand, 'node');
    assert.equal(panes[0]?.startCommand, '');
    assert.equal(panes[0]?.currentPath, '/home/tools/oh-my-codex');
    assert.equal(panes[1]?.paneId, '%202');
    assert.equal(panes[1]?.currentCommand, 'node');
    assert.equal(
      panes[1]?.currentPath,
      '/home/tools/oh-my-codex.omx-worktrees/launch-fix-default-subagent-fix',
    );
    assert.deepEqual(readHudPaneOwner(panes[1]!), {
      sessionId: 'sess-a',
      leaderPaneId: '%140',
    });
    assert.deepEqual(
      findHudWatchPaneIds(panes, '%140', { sessionId: 'sess-a', leaderPaneId: '%140' }),
      ['%202'],
    );
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

  it('matches same-session HUD panes only within the requested leader ownership scope', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%3\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%3' /node /omx.js hud --watch`,
        "%4\tnode\texec env OMX_SESSION_ID='sess-a' /node /omx.js hud --watch",
        `%5\tnode\texec env OMX_SESSION_ID='sess-b' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-a', leaderPaneId: '%1' }), ['%2', '%4']);
    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-a', leaderPaneId: '%3' }), ['%3', '%4']);
    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { leaderPaneId: '%1' }), []);
  });

  it('does not match session-owned HUD panes when only leader ownership is requested', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%3\tnode\texec env OMX_SESSION_ID='sess-b' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { leaderPaneId: '%1' }), []);
  });

  it('does not match leader-only legacy HUD panes when a session owner is requested', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-canonical', leaderPaneId: '%1' }), []);
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

  it('separately detects legacy focused watch panes for automatic reconciliation only', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        '%2\tnode\tnode /tmp/bin/omx.js hud --watch --preset=focused',
        '%3\tnode\tnode /tmp/bin/omx.js hud --watch --preset=minimal',
        `%4\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch --preset=focused`,
        '%5\tnode\tnode /tmp/bin/omx.js hud --tmux --preset=focused',
        `%6\tnode\t/bin/zsh -c 'exec '\\''node'\\'' '\\''/tmp/bin/omx.js'\\'' '\\''hud'\\'' '\\''--watch'\\'' '\\''--preset=focused'\\'''`,
        '%7\tnode\tnode /tmp/bin/custom-hud.js hud --watch --preset=focused',
        '%8\tnode\tnode /tmp/omx-pr2664/custom-hud.js hud --watch --preset=focused',
        '%9\tnode\tnode /tmp/bin/omx.js hud --tmux --watch --preset=focused',
      ].join('\n'),
    );

    assert.deepEqual(findLegacyFocusedHudWatchPaneIds(panes, '%1'), ['%2', '%6']);
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

  it('kills doctor-smoke HUD panes even if a literal deleted-marker cwd was materialized', () => {
    const parent = mkdtempSync(join(tmpdir(), 'omx-doctor-plugin-hook-live-marker-'));
    const materializedDeletedPath = join(parent, 'smoke (deleted)');
    mkdirSync(materializedDeletedPath);
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\texec env OMX_SESSION_ID='omx-doctor-plugin-hook-smoke' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch\t${materializedDeletedPath}`,
      ].join('\n'),
    );
    const killed: string[] = [];

    try {
      const result = reapDeadHudPanes(panes, {
        killPane: (paneId) => {
          killed.push(paneId);
          return true;
        },
      });

      assert.deepEqual(killed, ['%2']);
      assert.deepEqual(result, { reaped: ['%2'], preserved: [] });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
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
