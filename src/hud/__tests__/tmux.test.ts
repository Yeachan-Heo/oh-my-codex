import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHudLayoutHookSlot,
  buildHudResizeHookName,
  buildHudResizeHookSlot,
  buildHudWatchCommand,
  createHudWatchPane,
  findLegacyFocusedHudWatchPaneIds,
  findHudWatchPaneIds,
  hudPaneMatchesOwner,
  listCurrentWindowHudPaneIds,
  OMX_TMUX_HUD_LEADER_PANE_ENV,
  TMUX_PANE_FIELD_SEPARATOR,
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
  const hookAuthority = (args: string[], windowId = '@3'): string | undefined => {
    if (args[0] === 'list-panes') {
      return '%1 0 101\n%2 0 102\n%9 0 109\n%10 0 110\n';
    }
    if (args[0] === 'display-message') return `$7\t${windowId}\n`;
    return undefined;
  };

  it('builds deterministic bounded hook names and slots', () => {
    const hookName = buildHudResizeHookName('$7', '@3', '%1');
    assert.equal(hookName, 'omx_hud_resize_7_3_1');
    for (const slot of [buildHudResizeHookSlot(hookName), buildHudLayoutHookSlot(hookName)]) {
      assert.match(slot, /^(?:client-resized|window-layout-changed)\[\d+\]$/);
      const index = Number.parseInt(slot.replace(/^.*\[|\]$/g, ''), 10);
      assert.ok(index >= 0 && index < 2147483647);
    }
  });

  it('parses hook context with exact leader and HUD pane incarnations', () => {
    const context = parseHudResizeHookContext('$7\t@3\n', '%1', '%9', {
      leaderPanePid: '101',
      hudPanePid: '109',
    });
    assert.deepEqual(context, {
      sessionId: '$7',
      windowId: '@3',
      leaderPaneId: '%1',
      leaderPanePid: '101',
      hudPaneId: '%9',
      hudPanePid: '109',
      hookName: 'omx_hud_resize_7_3_1',
      hookSlot: buildHudResizeHookSlot('omx_hud_resize_7_3_1'),
      layoutHookSlot: buildHudLayoutHookSlot('omx_hud_resize_7_3_1'),
    });
    assert.equal(parseHudResizeHookContext('$7; touch /tmp/owned\t@3\n', '%1'), null);
    assert.equal(parseHudResizeHookContext('$7\t@3$(touch /tmp/owned)\n', '%1'), null);
    assert.equal(parseHudResizeHookContext('$7\t@3\n', '%1; touch /tmp/owned'), null);
  });

  it('registers session hooks only after capturing exact pane, PID, session, and window authority', () => {
    const calls: string[][] = [];
    const result = registerHudResizeHook('%9', '%1', 3, { cwd: '/repo', env: { TMUX: '/tmp/tmux', OMX_SESSION_ID: 'sess-a' } }, (args) => {
      calls.push(args);
      return hookAuthority(args) ?? '';
    });
    const hookSlot = buildHudResizeHookSlot('omx_hud_resize_7_3_1');
    const layoutHookSlot = buildHudLayoutHookSlot('omx_hud_resize_7_3_1');
    const registrations = calls.filter((args) => args[0] === 'set-hook' && args[1] === '-t');

    assert.equal(result, true);
    assert.deepEqual(calls[0], ['list-panes', '-a', '-F', '#{pane_id} #{pane_dead} #{pane_pid}']);
    assert.deepEqual(calls[1], ['display-message', '-p', '-t', '%1', '#{session_id}\t#{window_id}']);
    assert.equal(registrations[0]?.[2], '$7');
    assert.equal(registrations[0]?.[3], hookSlot);
    assert.match(registrations[0]?.[4] ?? '', /^run-shell -b /);
    for (const token of ['if-shell', 'pane_id', '%1', 'pane_pid', '101', '%9', '109']) {
      assert.match(registrations[0]?.[4] ?? '', new RegExp(token));
    }
    assert.match(registrations[0]?.[4] ?? '', /resize-pane/);
    assert.match(registrations[0]?.[4] ?? '', new RegExp(`sleep ${HUD_RESIZE_RECONCILE_DELAY_SECONDS}`));
    assert.equal(registrations[1]?.[3], layoutHookSlot);
    assert.match(registrations[1]?.[4] ?? '', /--reconcile-tmux/);
    assert.match(registrations[1]?.[4] ?? '', /OMX_TMUX_HUD_OWNER/);
  });

  it('guards registered hooks against recycled leader or HUD pane IDs', () => {
    const calls: string[][] = [];
    assert.equal(registerHudResizeHook('%9', '%1', 3, (args) => {
      calls.push(args);
      return hookAuthority(args) ?? '';
    }), true);
    const commands = calls
      .filter((args) => args[0] === 'set-hook' && args[1] === '-t')
      .map((args) => args[4] ?? '');
    assert.ok(commands.length >= 1);
    for (const command of commands) {
      for (const token of ['pane_id', '%1', 'pane_pid', '101', '%9', '109']) {
        assert.match(command, new RegExp(token));
      }
    }
  });

  it('rejects a recycled HUD split source before creating a pane', () => {
    const calls: string[][] = [];
    const options = new Map<string, string>();
    const result = createHudWatchPane('/repo', 'node omx.js hud --watch', { targetPaneId: '%1' }, (args) => {
      calls.push(args);
      if (args[0] === 'display-message') return '%1\t0\t101\t$7\t@3\n';
      if (args[0] === 'list-panes') return '%1\n%2\n';
      if (args[0] === 'set-option') {
        options.set(args.at(-2)!, args.at(-1)!);
        return '';
      }
      if (args[0] === 'show-options') {
        const value = options.get(args.at(-1)!);
        return value === undefined ? '' : `${value}\n`;
      }
      if (args[0] === 'if-shell') {
        assert.match(args[4] ?? '', /pane_pid/);
        assert.match(args[4] ?? '', /101/);
        return '__omx_hud_split_rejected_drifted_source\n';
      }
      return '';
    });

    assert.equal(result, null);
    const split = calls.find((args) => args[0] === 'if-shell');
    assert.deepEqual(calls[0], [
      'display-message', '-p', '-t', '%1',
      '#{pane_id}\t#{pane_dead}\t#{pane_pid}\t#{session_id}\t#{window_id}',
    ]);
    assert.ok(split);
    assert.deepEqual(split?.slice(0, 4), ['if-shell', '-F', '-t', '%1']);
    for (const token of ['pane_id', '%1', 'pane_pid', '101', 'session_id', '$7', 'window_id', '@3']) {
      assert.match(split?.[4] ?? '', new RegExp(token.replace('$', '\\$')));
    }
    assert.match(split?.[6] ?? '', /__omx_hud_split_rejected_/);
  });

  it('reports layout-hook installation failure without undoing the installed resize hook', () => {
    const calls: string[][] = [];
    const layoutHookSlot = buildHudLayoutHookSlot('omx_hud_resize_7_3_1');
    const result = registerHudResizeHook('%9', '%1', 3, (args) => {
      calls.push(args);
      if (args[0] === 'set-hook' && args[3] === layoutHookSlot) throw new Error('layout hook rejected');
      return hookAuthority(args) ?? '';
    });
    assert.equal(result, false);
    assert.ok(calls.some((args) => args[0] === 'set-hook' && args[3] === buildHudResizeHookSlot('omx_hud_resize_7_3_1')));
    assert.ok(calls.some((args) => args[0] === 'set-hook' && args[3] === layoutHookSlot));
  });


  it('unregisters leader-scoped hooks through guarded session transactions', () => {
    const calls: string[][] = [];
    assert.equal(unregisterHudResizeHook('%1', (args) => {
      calls.push(args);
      return hookAuthority(args) ?? '';
    }), true);
    assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%1', '#{session_id}\t#{window_id}']);
    const guarded = calls.filter((args) => args[0] === 'if-shell');
    assert.equal(guarded.length, 2);
    assert.deepEqual(guarded.map((args) => args[3]), ['$7', '$7']);

    const expectedIdentity = (hookSlot: string): { option: string; predicate: string } => {
      const match = /^(client-resized|window-layout-changed)\[([0-9]+)\]$/.exec(hookSlot);
      assert.ok(match);
      const option = `@omx_hook_identity_${match[1]!.replaceAll('-', '_')}_${match[2]}`;
      let hash = 2166136261;
      for (const character of `omx_hud_resize_7_3_1:${hookSlot}`) {
        hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
      }
      return { option, predicate: `#{==:${option},omx-${(hash >>> 0).toString(16)}}` };
    };

    for (const [index, hookSlot] of [
      buildHudResizeHookSlot('omx_hud_resize_7_3_1'),
      buildHudLayoutHookSlot('omx_hud_resize_7_3_1'),
    ].entries()) {
      const identity = expectedIdentity(hookSlot);
      assert.equal(guarded[index]?.[4], identity.predicate);
      assert.equal(
        guarded[index]?.[5],
        `set-hook -u -t $7 ${hookSlot} \\; set-option -u -t $7 ${identity.option}`,
      );
      assert.equal(guarded[index]?.[6], '');
    }
  });

  it('attempts layout-hook cleanup after resize-hook cleanup failure', () => {
    const calls: string[][] = [];
    const resizeSlot = buildHudResizeHookSlot('omx_hud_resize_7_3_1');
    const result = unregisterHudResizeHook('%1', (args) => {
      calls.push(args);
      if (args[0] === 'if-shell' && (args[5] ?? '').includes(resizeSlot)) throw new Error('resize hook rejected');
      return hookAuthority(args) ?? '';
    });
    assert.equal(result, false);
    assert.ok(calls.some((args) => args[0] === 'if-shell' && (args[5] ?? '').includes(buildHudLayoutHookSlot('omx_hud_resize_7_3_1'))));
  });

  it('uses distinct slots across windows and leaders while retaining a leader slot across HUD recreation', () => {
    const registered: string[][] = [];
    const execFor = (windowId: string) => (args: string[]) => {
      if (args[0] === 'set-hook' && args[1] === '-t') registered.push(args);
      return hookAuthority(args, windowId) ?? '';
    };
    assert.equal(registerHudResizeHook('%9', '%1', 3, execFor('@3')), true);
    assert.equal(registerHudResizeHook('%10', '%2', 3, execFor('@4')), true);
    const registeredResizeSlots = registered.filter((args) => args[3]?.startsWith('client-resized['));
    assert.notEqual(registeredResizeSlots[0]?.[3], registeredResizeSlots[1]?.[3]);

    const recreated: string[][] = [];
    const sameLeader = (args: string[]) => {
      if (args[0] === 'set-hook' && args[1] === '-t') recreated.push(args);
      return hookAuthority(args) ?? '';
    };
    assert.equal(registerHudResizeHook('%9', '%1', 3, sameLeader), true);
    assert.equal(registerHudResizeHook('%10', '%1', 3, sameLeader), true);
    const recreatedResizeSlots = recreated.filter((args) => args[3]?.startsWith('client-resized['));
    assert.equal(recreatedResizeSlots[0]?.[3], recreatedResizeSlots[1]?.[3]);
  });
});

describe('HUD pane ownership helpers', () => {
  it('parses pane geometry from tmux pane snapshots without corrupting the start command or cwd', () => {
    const [pane] = parseTmuxPaneSnapshot(
      `%2\tnode\t0\t47\t160\t3\t49\t160\t50\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch\t/tmp/repo`,
    );

    assert.deepEqual(pane, {
      paneId: '%2',
      currentCommand: 'node',
      paneLeft: 0,
      paneTop: 47,
      paneWidth: 160,
      paneHeight: 3,
      paneBottom: 49,
      windowWidth: 160,
      windowHeight: 50,
      startCommand: `exec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
      currentPath: '/tmp/repo',
    });
  });

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

  it('reads ownership from tmux 3.7b whole-command quoting with a receipt comment', () => {
    const [pane] = parseTmuxPaneSnapshot(
      `%3\tnode\t"exec env OMX_SESSION_ID='%0' OMX_TMUX_HUD_OWNER=1 ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%0' '/node' '/omx.js' hud --watch # omx_source_receipt"`,
    );

    assert.deepEqual(readHudPaneOwner(pane!), {
      sessionId: '%0',
      leaderPaneId: '%0',
    });
    assert.equal(hudPaneMatchesOwner(pane!, { leaderPaneId: '%0' }), true);
  });

  it('splits tmux octal-escaped control separators from live list-panes output', () => {
    const escapedSeparator = '\\037';
    const panes = parseTmuxPaneSnapshot(
      [
        ['%140', 'node', '', '/home/tools/oh-my-codex'].join(escapedSeparator),
        [
          '%202',
          'node',
          `exec env OMX_SESSION_ID='sess-a' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%140' OMX_ROOT='/tmp/run' '/usr/bin/node' '/repo/dist/cli/omx.js' hud --watch --preset=focused`,
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
    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { leaderPaneId: '%1' }), ['%2', '%5']);
  });

  it('does not match session-owned HUD panes when only leader ownership is requested', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%3\tnode\texec env OMX_SESSION_ID='sess-b' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { leaderPaneId: '%1' }), ['%2', '%3']);
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

  it('matches equivalent owner and canonical session ids for the same leader', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_SESSION_ID='omx-owner-abc' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%3\tnode\texec env OMX_SESSION_ID='codex-native-uuid' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%4\tnode\texec env OMX_SESSION_ID='other-session' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%5\tnode\texec env OMX_SESSION_ID='codex-native-uuid' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%5' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(
      findHudWatchPaneIds(panes, '%1', {
        sessionId: 'omx-owner-abc',
        sessionIds: ['omx-owner-abc', 'codex-native-uuid'],
        leaderPaneId: '%1',
      }),
      ['%2', '%3'],
    );
  });

  it('finds one same-session HUD pane when TMUX_PANE is unavailable', () => {
    const calls: string[][] = [];
    const execTmuxSync = (args: string[]) => {
      calls.push(args);
      if (args.at(-1) === '#{pane_id}') return '%1\n%2\n';
      return [
        ['%1', 'codex', '0', '0', '160', '47', '46', '160', '50', 'codex', '/repo', '0', '101'].join('\x1f'),
        ['%2', 'node', '0', '47', '160', '3', '49', '160', '50', `exec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`, '/repo', '0', '102'].join('\x1f'),
      ].join('\n') + '\n';
    }

    assert.deepEqual(listCurrentWindowHudPaneIds(undefined, execTmuxSync, { sessionId: 'sess-a' }), ['%2']);
    assert.deepEqual(calls, [
      ['list-panes', '-F', '#{pane_id}'],
      [
        'list-panes',
        '-F',
        [
          '#{pane_id}',
          '#{pane_current_command}',
          '#{pane_left}',
          '#{pane_top}',
          '#{pane_width}',
          '#{pane_height}',
          '#{pane_bottom}',
          '#{window_width}',
          '#{window_height}',
          '#{pane_start_command}',
          '#{pane_current_path}',
          '#{pane_dead}',
          '#{pane_pid}',
        ].join('\x1f'),
      ],
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
  it('ignores team ACK commands that mention HUD preserve repro text', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        [
          '%2',
          'node',
          "node /repo/dist/cli/omx.js team api send-message --input '{\"body\":\"ACK: hud preserve repro just ack\"}' --json",
        ].join('\t'),
      ].join('\n'),
    );

    const result = reapDeadHudPanes(panes, {
      killPane: () => {
        throw new Error('team ACK command should not be classified as a HUD watch pane');
      },
    });

    assert.deepEqual(findHudWatchPaneIds(panes), []);
    assert.deepEqual(result, { reaped: [], preserved: [] });
  });

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
