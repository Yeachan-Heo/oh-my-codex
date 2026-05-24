import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHudResizeHookName,
  buildHudResizeHookSlot,
  buildHudWatchCommand,
  findHudWatchPaneIds,
  hudPaneMatchesOwner,
  OMX_TMUX_HUD_LEADER_PANE_ENV,
  parseTmuxPaneSnapshot,
  readHudPaneOwner,
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

  it('tags reconciled HUD watch commands with the leader pane owner', () => {
    const cmd = buildHudWatchCommand('/usr/bin/omx.js', undefined, 'sess-a', undefined, '%1');

    assert.match(cmd, /OMX_SESSION_ID='sess-a'/);
    assert.match(cmd, new RegExp(`${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1'`));
  });
});
