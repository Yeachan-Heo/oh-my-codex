import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHudResizeHookName,
  buildHudResizeHookSlot,
  parseHudResizeHookContext,
  registerHudResizeHook,
  unregisterHudResizeHook,
} from '../tmux.js';

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

  it('registers a session hook in a stable per-window slot with exact HUD pane targeting', () => {
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
    assert.notEqual(calls[1]?.[3], 'client-resized[99]');
    assert.match(calls[1]?.[4] ?? '', /^run-shell -b /);
    assert.match(calls[1]?.[4] ?? '', /resize-pane/);
    assert.match(calls[1]?.[4] ?? '', /set-hook/);
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
