import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildHudLayoutHookSlot,
  buildHudLayoutReconcileHookCommand,
  buildPosixHudReconcileSupervisorCommand,
  buildWindowsHudReconcileSupervisorCommand,
  boundHudHeight,
  buildHudResizeHookName,
  buildHudResizeHookSlot,
  buildHudSplitHookSlot,
  buildHudWatchCommand,
  createHudWatchPane,
  clearTmuxPaneHistoryIfCurrent,
  findHudSplitOperationMarkerPaneId,
  findLegacyFocusedHudWatchPaneIds,
  findHudWatchPaneIds,
  hasValidHudOwnerMarker,
  hudPaneMatchesOwner,
  killTmuxPaneIfCurrent,
  listCurrentWindowPanes,
  listCurrentWindowHudPaneIds,
  OMX_TMUX_HUD_LEADER_PANE_ENV,
  TMUX_PANE_FIELD_SEPARATOR,
  parseTmuxPaneSnapshot,
  readActiveTmuxPaneId,
  readCurrentWindowSize,
  readHudPaneOwner,
  reapDeadHudPanes,
  parseHudResizeHookContext,
  readHudHookHealth,
  readHudLeaderOwnerIdentity,
  registerHudResizeHook,
  resizeTmuxPaneIfCurrent,
  shellEscapeSingle,
  unregisterHudResizeHook,
} from '../tmux.js';
import { HUD_RESIZE_RECONCILE_DELAY_SECONDS } from '../constants.js';

describe('leader owner identity probe', () => {
  it('requires a live exact pane and nonempty matching owner', () => {
    assert.equal(readHudLeaderOwnerIdentity('%1', 'sess-a', () => '%1|0|sess-a\n'), 'current');
    assert.equal(readHudLeaderOwnerIdentity('%1', 'sess-a', () => '%1|0|sess-b\n'), 'mismatch');
    assert.equal(readHudLeaderOwnerIdentity('%1', 'sess-a', () => '%1|0|\n'), 'unknown');
    assert.equal(readHudLeaderOwnerIdentity('%1', 'sess-a', () => '%2|0|sess-a\n'), 'unknown');
    assert.equal(readHudLeaderOwnerIdentity('%1', 'sess-a', () => '%1|1|sess-a\n'), 'unknown');
  });
});

describe('roster height budget', () => {
  it('bounds 15 and 20 workers by the live window and local leader split', () => {
    for (const desired of [17, 22]) {
      const panes = [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex', windowHeight: 24, paneHeight: 14 },
        { paneId: '%2', currentCommand: 'node', startCommand: 'hud', paneHeight: 9 },
      ];
      assert.equal(boundHudHeight(desired, panes, '%1', '%2'), 11);
      panes[0].windowHeight = 80;
      assert.equal(boundHudHeight(desired, panes, '%1', '%2'), 11);
      panes[0].paneHeight = 60;
      assert.equal(boundHudHeight(desired, panes, '%1', '%2'), desired);
      assert.equal(boundHudHeight(desired, panes, '%1'), desired);
      panes[0].paneHeight = 12;
      assert.equal(boundHudHeight(desired, panes, '%1'), 5);
    }
  });

  it('falls back to a compact HUD on missing/invalid geometry', () => {
    assert.equal(boundHudHeight(22, []), 3);
    assert.equal(boundHudHeight(2, []), 2);
    assert.equal(boundHudHeight(22, [{ paneId: '%1', currentCommand: '', startCommand: '', windowHeight: NaN, paneHeight: Infinity }], '%1'), 3);
  });
});

describe('tmux size authority probe', () => {
  it('uses a printable separator and rejects malformed field counts', () => {
    assert.deepEqual(readCurrentWindowSize((args) => {
      assert.deepEqual(args, ['display-message', '-p', '-t', '%1', '#{window_width}|#{window_height}']);
      return '160|50\n';
    }, '%1'), { width: 160, height: 50 });
    assert.deepEqual(readCurrentWindowSize(() => '160_50\n', '%1'), { width: null, height: null });
    assert.deepEqual(readCurrentWindowSize(() => '160|50|extra\n', '%1'), { width: null, height: null });
  });
});

describe('HUD resize hook helpers', () => {
  const hookAuthority = (args: string[], windowId = '@3'): string | undefined => {
    if (args[0] === 'list-panes') {
      return '%1 0 101\n%2 0 102\n%9 0 109\n%10 0 110\n';
    }
    if (args[0] === 'if-shell') {
      const marker = /display-message -p (__omx_hud_unregister_[A-Za-z0-9-]+)/.exec(args[5] ?? '')?.[1];
      return marker ? `${marker}\n` : undefined;
    }
    if (args[0] === 'display-message') return `$7\t${windowId}\n`;
    return undefined;
  };

  it('builds deterministic bounded hook names and slots', () => {
    const hookName = buildHudResizeHookName('$7', '@3', '%1');
    assert.equal(hookName, 'omx_hud_resize_7_3_1');
    for (const slot of [
      buildHudResizeHookSlot(hookName),
      buildHudLayoutHookSlot(hookName),
      buildHudSplitHookSlot(hookName),
    ]) {
      assert.match(slot, /^(?:client-resized|window-layout-changed|after-split-window)\[\d+\]$/);
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
      splitHookSlot: buildHudSplitHookSlot('omx_hud_resize_7_3_1'),
    });
    assert.equal(parseHudResizeHookContext('$7; touch /tmp/owned\t@3\n', '%1'), null);
    assert.equal(parseHudResizeHookContext('$7\t@3$(touch /tmp/owned)\n', '%1'), null);
    assert.equal(parseHudResizeHookContext('$7\t@3\n', '%1; touch /tmp/owned'), null);
  });

  it('registers session hooks only after capturing exact pane, PID, session, and window authority', () => {
    const calls: string[][] = [];
    const result = registerHudResizeHook('%9', '%1', 3, {
      cwd: '/repo',
      env: {
        TMUX: '/tmp/tmux',
        OMX_SESSION_ID: 'sess-a',
        OMX_ENTRY_PATH: fileURLToPath(new URL('../../cli/omx.js', import.meta.url)),
      },
    }, (args) => {
      calls.push(args);
      return hookAuthority(args) ?? '';
    });
    const hookSlot = buildHudResizeHookSlot('omx_hud_resize_7_3_1');
    const layoutHookSlot = buildHudLayoutHookSlot('omx_hud_resize_7_3_1');
    const splitHookSlot = buildHudSplitHookSlot('omx_hud_resize_7_3_1');
    const registrations = calls.filter((args) => args[0] === 'set-hook');
    const registrationSlot = (args: string[]): string | undefined => args[1] === '-w' ? args[4] : args[3];
    const registrationCommand = (args: string[]): string | undefined => args[1] === '-w' ? args[5] : args[4];

    assert.equal(result, true);
    assert.equal(registrations.length, 3);
    assert.deepEqual(calls[0], ['list-panes', '-a', '-F', '#{pane_id} #{pane_dead} #{pane_pid}']);
    assert.deepEqual(calls[1], ['display-message', '-p', '-t', '%1', '#{session_id}|#{window_id}']);
    assert.deepEqual(registrations[0]?.slice(1, 4), ['-t', '$7', hookSlot]);
    assert.match(registrationCommand(registrations[0]!) ?? '', /^run-shell -b /);
    for (const token of ['if-shell', 'pane_id', '%1', 'pane_pid', '101', '%9', '109']) {
      assert.match(registrationCommand(registrations[0]!) ?? '', new RegExp(token));
    }
    assert.match(registrationCommand(registrations[0]!) ?? '', /resize-pane/);
    assert.match(registrationCommand(registrations[0]!) ?? '', new RegExp(`sleep ${HUD_RESIZE_RECONCILE_DELAY_SECONDS}`));
    for (const registration of registrations) {
      if (process.platform !== 'win32' && registrationSlot(registration) !== hookSlot) {
        assert.match(registrationCommand(registration) ?? '', /--reconcile-timeout-ms=30000/);
      }
      const suffixIndex = registration[1] === '-w' ? 6 : 5;
      assert.equal(registration[suffixIndex], ';');
      assert.deepEqual(registration.slice(suffixIndex + 1, suffixIndex + 4), ['set-option', '-t', '$7']);
    }
    assert.deepEqual(
      registrations.slice(1).map(registrationSlot),
      [splitHookSlot, layoutHookSlot],
    );
    assert.deepEqual(registrations[2]?.slice(1, 5), ['-w', '-t', '@3', layoutHookSlot]);
    for (const registration of registrations.slice(1)) {
      assert.match(registrationCommand(registration) ?? '', /--reconcile-tmux/);
      assert.match(registrationCommand(registration) ?? '', /OMX_TMUX_HUD_OWNER/);
      assert.doesNotMatch(registrationCommand(registration) ?? '', /\\; /);
    }
  });

  it('guards registered hooks against recycled leader or HUD pane IDs', () => {
    const calls: string[][] = [];
    assert.equal(registerHudResizeHook('%9', '%1', 3, (args) => {
      calls.push(args);
      return hookAuthority(args) ?? '';
    }), true);
    const commands = calls
      .filter((args) => args[0] === 'set-hook')
      .map((args) => args[1] === '-w' ? (args[5] ?? '') : (args[4] ?? ''));
    assert.ok(commands.length >= 1);
    for (const command of commands) {
      for (const token of ['pane_id', '%1', 'pane_pid', '101', '%9', '109']) {
        assert.match(command, new RegExp(token));
      }
      assert.match(command, /##\{pane_id}/);
      assert.match(command, /##\{pane_pid}/);
    }
  });

  it('serializes repair authority into the Windows reconcile command', () => {
    const base = parseHudResizeHookContext('$7|@3\n', '%1', '%9', {
      leaderPanePid: '101',
      hudPanePid: '109',
    });
    assert.ok(base);
    const context = { ...base, ownerId: 'sess-a' };
    const command = buildHudLayoutReconcileHookCommand(
      'tmux.exe',
      'C:\\repo\\omx.js',
      '%1',
      context,
      context.layoutHookSlot,
      {
        cwd: 'C:\\repo',
        env: {
          TMUX: 'socket,42,0',
          OMX_SESSION_ID: 'sess-a',
          OMX_ROOT: 'C:\\repo',
          OMX_STATE_ROOT: 'C:\\state',
          OMX_TEAM_STATE_ROOT: 'C:\\team',
        },
      },
      'win32',
    );

    for (const fragment of [
      '$env:TMUX', '$env:TMUX_PANE', '$env:OMX_TMUX_HUD_OWNER', '$env:OMX_HUD_WATCH_REPAIR',
      '$env:OMX_HUD_WATCH_LEADER_PID', '$env:OMX_ENTRY_PATH', '$env:OMX_SESSION_ID', '$env:OMX_ROOT',
      '$env:OMX_STATE_ROOT', '$env:OMX_TEAM_STATE_ROOT',
      'socket,42,0', '%1', '101', 'sess-a', 'C:\\repo', 'C:\\state', 'C:\\team',
    ]) assert.ok(command.includes(fragment), fragment);
  });

  it('registers hook-spawned reconcile commands with a portable parent watchdog', () => {
    const base = parseHudResizeHookContext('$7|@3\n', '%1', '%9', {
      leaderPanePid: '101',
      hudPanePid: '109',
    });
    assert.ok(base);
    const context = { ...base, ownerId: 'sess-a' };
    const posixCommand = buildHudLayoutReconcileHookCommand(
      'tmux',
      '/repo/dist/cli/omx.js',
      '%1',
      context,
      context.layoutHookSlot,
      { cwd: '/repo', env: { TMUX: '/tmp/tmux', OMX_SESSION_ID: 'sess-a' } },
      'darwin',
    );

    assert.match(posixCommand, /hud --reconcile-tmux --reconcile-timeout-ms=30000/);
    assert.match(posixCommand, /exec env TMUX=/);
    assert.match(posixCommand, /OMX_ENTRY_PATH=/);
    assert.match(posixCommand, /\)\s*>\s*\/dev\/null 2>&1 \|\| true/);
    assert.doesNotMatch(posixCommand, /\btimeout\s/);

    const windowsCommand = buildHudLayoutReconcileHookCommand(
      'tmux.exe',
      'C:\\repo\\omx.js',
      '%1',
      context,
      context.layoutHookSlot,
      { cwd: 'C:\\repo', env: { TMUX: 'socket,42,0', OMX_SESSION_ID: 'sess-a' } },
      'win32',
    );

    assert.match(windowsCommand, /hud --reconcile-tmux --reconcile-timeout-ms=30000/);
    assert.match(windowsCommand, /\$env:OMX_ENTRY_PATH/);
    assert.match(windowsCommand, /Start-Process/);
    assert.match(windowsCommand, /WaitForExit\(35000\)/);
    assert.match(windowsCommand, /taskkill\.exe \/PID \$child\.Id \/T \/F/);
    assert.match(windowsCommand, /exit 0/);
    assert.doesNotMatch(windowsCommand, /exit 1|ExitCode/);
    assert.doesNotMatch(windowsCommand, /RedirectStandard(Output|Error)/);
  });

  it('bounds POSIX Node startup before CLI dispatch with the shell supervisor', () => {
    if (process.platform === 'win32') return;

    const testDir = mkdtempSync(join(tmpdir(), 'omx-hud-shell-watchdog-'));
    try {
      const entry = join(testDir, 'startup-hang.mjs');
      writeFileSync(entry, 'while (true) {}');
      const command = `exec env OMX_TEST=ready ${shellEscapeSingle(process.execPath)} ${shellEscapeSingle(entry)}`;
      const startedAt = Date.now();
      const supervisor = buildPosixHudReconcileSupervisorCommand(command, 1_000);
      const result = spawnSync(
        '/bin/sh',
        ['-c', `(${supervisor}) >/dev/null 2>&1 || true`],
        { encoding: 'utf8', timeout: 5_000 },
      );

      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.ok(Date.now() - startedAt < 4_000, 'the external watchdog exits promptly');
      assert.ok(supervisor.includes(`trap 'kill "$s" 2>/dev/null || :; wait "$s" 2>/dev/null || :; exit' TERM`));
      assert.match(supervisor, /mkfifo "\$ready_fifo"/);
      assert.match(supervisor, /kill -TERM "\$child"/);
      assert.match(supervisor, /kill -KILL "\$child"/);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('reaps the POSIX watchdog sleep when reconciliation completes early', () => {
    if (process.platform === 'win32') return;

    const testDir = mkdtempSync(join(tmpdir(), 'omx-hud-shell-watchdog-cleanup-'));
    const binDir = join(testDir, 'bin');
    const sleepPidPath = join(testDir, 'sleep.pid');

    try {
      mkdirSync(binDir);
      writeFileSync(join(binDir, 'sleep'), '#!/bin/sh\nprintf "%s\\n" "$$" >> "$OMX_TEST_SLEEP_PIDS"\nexec /bin/sleep "$@"\n', { mode: 0o755 });
      const command = buildPosixHudReconcileSupervisorCommand('/bin/sleep 0.1', 10_000);
      const result = spawnSync('/bin/sh', ['-c', `(${command}) >/dev/null 2>&1 || true`], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          OMX_TEST_SLEEP_PIDS: sleepPidPath,
        },
        timeout: 5_000,
      });

      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.ok(existsSync(sleepPidPath), 'the watchdog started its sleep process');
      const sleepPid = Number(readFileSync(sleepPidPath, 'utf8').trim());
      assert.ok(Number.isSafeInteger(sleepPid) && sleepPid > 0);
      assert.throws(() => process.kill(sleepPid, 0), { code: 'ESRCH' }, 'the watchdog reaps its sleep process');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('bounds Windows Node startup with the PowerShell supervisor', () => {
    if (process.platform !== 'win32') return;

    const testDir = mkdtempSync(join(tmpdir(), 'omx-hud-powershell-watchdog-'));
    try {
      const entry = join(testDir, 'startup-hang.mjs');
      writeFileSync(entry, 'while (true) {}');
      const command = buildWindowsHudReconcileSupervisorCommand(process.execPath, entry, testDir, 1_000);
      const startedAt = Date.now();
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
        timeout: 8_000,
      });

      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.ok(Date.now() - startedAt < 7_000, 'PowerShell kills Node before the outer test timeout');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('reads exact hook health with one non-mutating tmux probe', () => {
    const registrationCalls: string[][] = [];
    const env = {
      TMUX: '/tmp/tmux',
      OMX_SESSION_ID: 'sess-a',
      OMX_ENTRY_PATH: fileURLToPath(new URL('../../cli/omx.js', import.meta.url)),
    };
    assert.equal(registerHudResizeHook('%9', '%1', 3, { cwd: '/repo', env }, (args) => {
      registrationCalls.push(args);
      return hookAuthority(args) ?? '';
    }), true);
    const registrations = registrationCalls.filter(args => args[0] === 'set-hook');
    const bySlot = new Map(registrations.map((args) => {
      const slotIndex = args[1] === '-w' ? 4 : 3;
      const identityIndex = args.findIndex(value => value.startsWith('@omx_hook_identity_'));
      assert.ok(identityIndex >= 0);
      return [args[slotIndex]!, { command: args[slotIndex + 1]!, identity: args[identityIndex + 1]! }];
    }));
    const hookName = buildHudResizeHookName('$7', '@3', '%1');
    const slots = [
      buildHudResizeHookSlot(hookName),
      buildHudLayoutHookSlot(hookName),
      buildHudSplitHookSlot(hookName),
    ];
    const healthCalls: string[][] = [];
    const health = readHudHookHealth({
      sessionId: '$7',
      windowId: '@3',
      leaderPaneId: '%1',
      leaderPanePid: '101',
      hudPaneId: '%9',
      hudPanePid: '109',
      heightLines: 3,
      cwd: '/repo',
      env,
    }, (args) => {
      healthCalls.push(args);
      return [
        '%1', '0', '101', '$7', '@3', 'sess-a',
        ...slots.map(slot => bySlot.has(slot) ? '1' : '0'),
        ...slots.map(slot => bySlot.get(slot)?.identity ?? ''),
      ].join('|') + '\n';
    });

    assert.equal(health, 'healthy');
    assert.equal(healthCalls.length, 1);
    assert.deepEqual(healthCalls[0]?.slice(0, 4), ['display-message', '-p', '-t', '%1']);
    assert.match(healthCalls[0]?.[4] ?? '', /client-resized\[/);
    assert.match(healthCalls[0]?.[4] ?? '', /window-layout-changed\[/);
    assert.match(healthCalls[0]?.[4] ?? '', /after-split-window\[/);
    assert.ok(!healthCalls.some(args => args[0] === 'set-hook' || args[0] === 'set-option'));
  });

  it('distinguishes missing hooks and context drift from malformed hook probes', () => {
    const input = {
      sessionId: '$7',
      windowId: '@3',
      leaderPaneId: '%1',
      leaderPanePid: '101',
      hudPaneId: '%9',
      hudPanePid: '109',
      heightLines: 3,
      cwd: '/repo',
      env: {
        OMX_SESSION_ID: 'sess-a',
        OMX_ENTRY_PATH: fileURLToPath(new URL('../../cli/omx.js', import.meta.url)),
      },
    };
    assert.equal(readHudHookHealth(input, () => [
      '%1', '0', '101', '$7', '@3', 'sess-a', '', '', '', '', '', '',
    ].join('|') + '\n'), 'repair_needed');
    assert.equal(readHudHookHealth(input, () => [
      '%1', '0', '202', '$7', '@3', 'sess-a', '', '', '', '', '', '',
    ].join('|') + '\n'), 'repair_needed');
    assert.equal(readHudHookHealth(input, () => [
      '%1', '0', '101', '$7', '@3', 'other-owner', '', '', '', '', '', '',
    ].join('|') + '\n'), 'owner_mismatch');
    assert.equal(readHudHookHealth(input, () => [
      '%1', '0', '101', '$7', '@3', '', '', '', '', '', '', '',
    ].join('|') + '\n'), 'unknown');
    assert.equal(readHudHookHealth(input, () => 'truncated\n'), 'unknown');
    assert.equal(readHudHookHealth(input, () => { throw new Error('tmux unavailable'); }), 'unknown');
  });

  it('round-trips registered hook health through a real tmux server', { skip: process.platform === 'win32' }, (context) => {
    try {
      execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    } catch {
      context.skip('tmux is unavailable');
      return;
    }
    const serverRoot = mkdtempSync(join(tmpdir(), 'omx-hud-tmux-'));
    const socketPath = join(serverRoot, 's');
    const tmux = (args: string[]): string => execFileSync('tmux', ['-S', socketPath, ...args], { encoding: 'utf8' });
    try {
      tmux(['new-session', '-d', '-s', 'omx-hook-health', 'sleep 30']);
      tmux(['split-window', '-t', 'omx-hook-health', 'sleep 30']);
      const paneLines = tmux([
        'list-panes', '-t', 'omx-hook-health', '-F',
        '#{pane_id} #{pane_pid} #{session_id} #{window_id}',
      ]).trim().split('\n').map(line => line.split(' '));
      assert.equal(paneLines.length, 2);
      const [leader, hud] = paneLines;
      assert.ok(leader && hud);
      tmux(['set-option', '-t', leader[2]!, '@omx_instance_id', 'sess-a']);
      const tmuxEnvironment = tmux([
        'display-message', '-p', '-t', leader[0]!, '#{socket_path},#{pid},0',
      ]).trim();
      const input = {
        sessionId: leader[2]!,
        windowId: leader[3]!,
        leaderPaneId: leader[0]!,
        leaderPanePid: leader[1]!,
        hudPaneId: hud[0]!,
        hudPanePid: hud[1]!,
        heightLines: 3,
        cwd: process.cwd(),
        env: {
          TMUX: tmuxEnvironment,
          OMX_SESSION_ID: 'sess-a',
          OMX_HUD_WATCH_REPAIR: '1',
          OMX_HUD_WATCH_LEADER_PID: leader[1]!,
          OMX_ENTRY_PATH: fileURLToPath(new URL('../../cli/omx.js', import.meta.url)),
        },
      };
      assert.equal(registerHudResizeHook(hud[0]!, leader[0], 3, input, tmux), true);
      let observedHealthProbe = '';
      const probingTmux = (args: string[]): string => {
        const output = tmux(args);
        if (args[0] === 'display-message' && args[4]?.includes('client-resized[')) observedHealthProbe = output;
        return output;
      };
      assert.equal(readHudHookHealth(input, probingTmux), 'healthy', observedHealthProbe);
      assert.equal(readHudHookHealth({ ...input, cwd: join(process.cwd(), 'reused-launch-path') }, tmux), 'repair_needed');
      const hookName = buildHudResizeHookName(leader[2]!, leader[3]!, leader[0]!);
      const resizeHookSlot = buildHudResizeHookSlot(hookName);
      tmux(['set-hook', '-t', leader[2]!, resizeHookSlot, 'display-message foreign']);
      assert.equal(readHudHookHealth(input, tmux), 'repair_needed');
      assert.equal(registerHudResizeHook(hud[0]!, leader[0], 3, input, tmux), true);
      assert.equal(readHudHookHealth(input, tmux), 'healthy');
      let replacedDuringRegistration = false;
      const racingTmux = (args: string[]): string => {
        const output = tmux(args);
        if (!replacedDuringRegistration && args[0] === 'if-shell' && args.join(' ').includes(resizeHookSlot)) {
          tmux(['set-hook', '-t', leader[2]!, resizeHookSlot, 'display-message foreign']);
          replacedDuringRegistration = true;
        }
        return output;
      };
      assert.equal(registerHudResizeHook(hud[0]!, leader[0], 3, input, racingTmux), true);
      assert.equal(replacedDuringRegistration, true);
      assert.equal(readHudHookHealth(input, tmux), 'repair_needed');
      assert.equal(registerHudResizeHook(hud[0]!, leader[0], 3, input, tmux), true);
      assert.equal(readHudHookHealth(input, tmux), 'healthy');
      const splitHookSlot = buildHudSplitHookSlot(hookName);
      const splitHookMatch = /^(after-split-window)\[([0-9]+)\]$/.exec(splitHookSlot);
      assert.ok(splitHookMatch);
      const splitIdentityOption = `@omx_hook_identity_after_split_window_${splitHookMatch[2]}`;
      tmux(['set-hook', '-u', '-t', leader[2]!, splitHookSlot]);
      tmux(['set-option', '-u', '-t', leader[2]!, splitIdentityOption]);
      assert.equal(readHudHookHealth(input, tmux), 'repair_needed');
      const authority = { leaderPaneId: leader[0]!, leaderPanePid: leader[1]!, ownerId: 'sess-a' };
      const cleanupTransactions: Array<{ args: string[]; output: string }> = [];
      const cleanupTmux = (args: string[]): string => {
        const output = tmux(args);
        if (args[0] === 'if-shell') cleanupTransactions.push({ args, output });
        return output;
      };
      assert.equal(unregisterHudResizeHook(leader[0], authority, cleanupTmux), true, JSON.stringify(cleanupTransactions));
      assert.equal(registerHudResizeHook(hud[0]!, leader[0], 3, input, tmux), true);
      assert.equal(resizeTmuxPaneIfCurrent(hud[0]!, hud[1]!, 4, authority, tmux), true);
      assert.equal(tmux(['display-message', '-p', '-t', hud[0]!, '#{pane_height}']).trim(), '4');
      tmux(['set-option', '-t', leader[2]!, '@omx_instance_id', 'sess-b']);
      assert.equal(resizeTmuxPaneIfCurrent(hud[0]!, hud[1]!, 5, authority, tmux), false);
      assert.equal(tmux(['display-message', '-p', '-t', hud[0]!, '#{pane_height}']).trim(), '4');
      assert.equal(unregisterHudResizeHook(leader[0], authority, tmux), false);
    } finally {
      try {
        tmux(['kill-server']);
      } catch {
        // 测试服务器可能已经退出。
      }
      rmSync(serverRoot, { recursive: true, force: true });
    }
  });

  it('rejects a recycled HUD split source before creating a pane', () => {
    const calls: string[][] = [];
    const options = new Map<string, string>();
    const result = createHudWatchPane('/repo', 'node omx.js hud --watch', {
      targetPaneId: '%1',
      authority: { leaderPaneId: '%1', leaderPanePid: '101', ownerId: 'sess-a' },
    }, (args) => {
      calls.push(args);
      if (args[0] === 'display-message') return '%1|0|101|$7|@3\n';
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
      '#{pane_id}|#{pane_dead}|#{pane_pid}|#{session_id}|#{window_id}',
    ]);
    assert.ok(split);
    assert.deepEqual(split?.slice(0, 4), ['if-shell', '-F', '-t', '%1']);
    for (const token of ['pane_id', '%1', 'pane_pid', '101', 'session_id', '$7', 'window_id', '@3']) {
      assert.match(split?.[4] ?? '', new RegExp(token.replace('$', '\\$')));
    }
    assert.match(split?.[4] ?? '', /@omx_instance_id/);
    assert.match(split?.[4] ?? '', /sess-a/);
    assert.match(split?.[5] ?? '', /'OMX_TMUX_SPLIT_OPERATION_MARKER='\\''[^']+'\\'' node omx\.js hud --watch'/);
    assert.match(split?.[5] ?? '', / ; display-message -p __omx_hud_split_/);
    assert.doesNotMatch(split?.[5] ?? '', /\\; /);
    assert.doesNotMatch(split?.[5] ?? '', /; export OMX_TMUX_SPLIT_OPERATION_MARKER/);
    assert.match(split?.[6] ?? '', /__omx_hud_split_rejected_/);
  });

  it('reports layout-hook installation failure without undoing the installed resize hook', () => {
    const calls: string[][] = [];
    const layoutHookSlot = buildHudLayoutHookSlot('omx_hud_resize_7_3_1');
    const result = registerHudResizeHook('%9', '%1', 3, (args) => {
      calls.push(args);
      if (args[0] === 'set-hook' && args.includes(layoutHookSlot)) throw new Error('layout hook rejected');
      return hookAuthority(args) ?? '';
    });
    assert.equal(result, false);
    assert.ok(calls.some((args) => args[0] === 'set-hook' && args[3] === buildHudResizeHookSlot('omx_hud_resize_7_3_1')));
    assert.ok(calls.some((args) => args[0] === 'set-hook' && args.includes(layoutHookSlot)));
  });


  it('unregisters leader-scoped hooks through guarded session transactions', () => {
    const calls: string[][] = [];
    assert.equal(unregisterHudResizeHook('%1', (args) => {
      calls.push(args);
      return hookAuthority(args) ?? '';
    }), true);
    assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%1', '#{session_id}|#{window_id}']);
    const guarded = calls.filter((args) => args[0] === 'if-shell');
    assert.equal(guarded.length, 3);
    assert.deepEqual(guarded.map((args) => args[3]), ['%1', '%1', '%1']);

    const expectedIdentity = (hookSlot: string): { option: string; predicate: string } => {
      const match = /^(client-resized|window-layout-changed|after-split-window)\[([0-9]+)\]$/.exec(hookSlot);
      assert.ok(match);
      const option = `@omx_hook_identity_${match[1]!.replaceAll('-', '_')}_${match[2]}`;
      let hash = 2166136261;
      for (const character of `omx_hud_resize_7_3_1:${hookSlot}`) {
        hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
      }
      return { option, predicate: `#{==:#{${option}},omx-${(hash >>> 0).toString(16)}}` };
    };

    for (const [index, hookSlot] of [
      buildHudResizeHookSlot('omx_hud_resize_7_3_1'),
      buildHudSplitHookSlot('omx_hud_resize_7_3_1'),
      buildHudLayoutHookSlot('omx_hud_resize_7_3_1'),
    ].entries()) {
      const identity = expectedIdentity(hookSlot);
      assert.match(guarded[index]?.[4] ?? '', /pane_id/);
      assert.match(guarded[index]?.[5] ?? '', new RegExp(identity.predicate.replace(/[{}[\]]/g, '\\$&')));
      assert.match(guarded[index]?.[5] ?? '', new RegExp(hookSlot.replace(/[\[\]]/g, '\\$&')));
      assert.match(guarded[index]?.[6] ?? '', /^display-message -p __omx_hud_unregister_failed_/);
    }
  });

  it('guards pane mutations and hook cleanup with the exact leader PID and owner', () => {
    const authority = { leaderPaneId: '%1', leaderPanePid: '101', ownerId: 'sess-a' };
    const calls: string[][] = [];
    const exec = (args: string[]): string => {
      calls.push(args);
      if (args[0] === 'display-message') return '$7|@3\n';
      if (args[0] === 'if-shell') {
        const marker = /display-message -p (__omx_hud_(?:mutation|authority|unregister)_[A-Za-z0-9-]+)/.exec(args[5] ?? '')?.[1];
        return marker ? `${marker}\n` : '';
      }
      return '';
    };

    assert.equal(killTmuxPaneIfCurrent('%9', '109', authority, exec), true);
    assert.equal(resizeTmuxPaneIfCurrent('%9', '109', 4, authority, exec), true);
    assert.equal(clearTmuxPaneHistoryIfCurrent('%9', '109', authority, exec), true);
    assert.equal(unregisterHudResizeHook('%1', authority, exec), true);

    const guarded = calls.filter(args => args[0] === 'if-shell');
    assert.ok(guarded.length >= 6);
    for (const args of guarded) {
      assert.match(args[4] ?? '', /pane_id/);
      assert.match(args[4] ?? '', /%1/);
      assert.match(args[4] ?? '', /pane_pid/);
      assert.match(args[4] ?? '', /101/);
      assert.match(args[4] ?? '', /@omx_instance_id/);
      assert.match(args[4] ?? '', /sess-a/);
    }
    assert.match(guarded[0]?.[5] ?? '', /%9/);
    assert.match(guarded[0]?.[5] ?? '', /109/);
    assert.match(guarded[0]?.[5] ?? '', /kill-pane/);
    assert.match(guarded[1]?.[5] ?? '', /resize-pane/);
    assert.match(guarded[2]?.[5] ?? '', /clear-history/);
  });

  it('fails repair hook registration closed when owner or leader PID authority changes', () => {
    const calls: string[][] = [];
    const result = registerHudResizeHook('%9', '%1', 3, {
      cwd: '/repo',
      env: {
        OMX_SESSION_ID: 'sess-a',
        OMX_HUD_WATCH_REPAIR: '1',
        OMX_HUD_WATCH_LEADER_PID: '101',
        OMX_ENTRY_PATH: fileURLToPath(new URL('../../cli/omx.js', import.meta.url)),
      },
    }, (args) => {
      calls.push(args);
      if (args[0] === 'list-panes') return '%1 0 101\n%9 0 109\n';
      if (args[0] === 'display-message' && args.at(-1) === '#{session_id}|#{window_id}') return '$7|@3\n';
      if (args[0] === 'display-message' && args.at(-1) === '#{@omx_instance_id}') return 'sess-b\n';
      return '';
    });

    assert.equal(result, false);
    assert.ok(!calls.some(args => args[0] === 'set-hook' || args[0] === 'if-shell'));

    calls.length = 0;
    assert.equal(registerHudResizeHook('%9', '%1', 3, {
      cwd: '/repo',
      env: {
        OMX_SESSION_ID: 'sess-a',
        OMX_HUD_WATCH_REPAIR: '1',
        OMX_HUD_WATCH_LEADER_PID: '202',
        OMX_ENTRY_PATH: fileURLToPath(new URL('../../cli/omx.js', import.meta.url)),
      },
    }, (args) => {
      calls.push(args);
      if (args[0] === 'list-panes') return '%1 0 101\n%9 0 109\n';
      if (args[0] === 'display-message' && args.at(-1) === '#{session_id}|#{window_id}') return '$7|@3\n';
      if (args[0] === 'display-message' && args.at(-1) === '#{@omx_instance_id}') return 'sess-a\n';
      return '';
    }), false);
    assert.ok(!calls.some(args => args[0] === 'set-hook' || args[0] === 'if-shell'));
  });

  it('reuses registered hook identities during cleanup without live pane PIDs', () => {
    const registrationCalls: string[][] = [];
    assert.equal(registerHudResizeHook('%9', '%1', 3, (args) => {
      registrationCalls.push(args);
      return hookAuthority(args) ?? '';
    }), true);

    const identitiesBySlot = new Map<string, string>();
    for (const args of registrationCalls.filter((call) => call[0] === 'set-hook')) {
      const slotIndex = args[1] === '-w' ? 4 : 3;
      const identityIndex = args.findIndex(value => value.startsWith('@omx_hook_identity_'));
      assert.ok(identityIndex >= 0);
      identitiesBySlot.set(args[slotIndex]!, args[identityIndex + 1]!);
    }

    const cleanupCalls: string[][] = [];
    assert.equal(unregisterHudResizeHook('%1', (args) => {
      cleanupCalls.push(args);
      return hookAuthority(args) ?? '';
    }), true);

    for (const args of cleanupCalls.filter((call) => call[0] === 'if-shell')) {
      const hookSlot = [...identitiesBySlot.keys()].find((slot) => args[5]?.includes(slot));
      assert.ok(hookSlot);
      assert.match(args[5] ?? '', new RegExp(`${identitiesBySlot.get(hookSlot)}\\}`));
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
    for (const hookSlot of [
      buildHudSplitHookSlot('omx_hud_resize_7_3_1'),
      buildHudLayoutHookSlot('omx_hud_resize_7_3_1'),
    ]) {
      assert.ok(calls.some((args) => args[0] === 'if-shell' && (args[5] ?? '').includes(hookSlot)));
    }
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
    const identity = (args: string[]) => {
      const index = args.findIndex(value => value.startsWith('@omx_hook_identity_'));
      assert.ok(index >= 0);
      return args[index + 1];
    };
    assert.equal(identity(recreated[0]!), identity(recreated[2]!));
    assert.equal(identity(recreated[1]!), identity(recreated[3]!));
  });
});

describe('HUD pane ownership helpers', () => {
  it('captures strict session and window authority in the validated two-query snapshot', () => {
    const calls: string[][] = [];
    const panes = listCurrentWindowPanes((args) => {
      calls.push(args);
      if (calls.length === 1) return '%1\n%9\n';
      return [
        `%1${TMUX_PANE_FIELD_SEPARATOR}codex${TMUX_PANE_FIELD_SEPARATOR}0${TMUX_PANE_FIELD_SEPARATOR}0${TMUX_PANE_FIELD_SEPARATOR}160${TMUX_PANE_FIELD_SEPARATOR}46${TMUX_PANE_FIELD_SEPARATOR}45${TMUX_PANE_FIELD_SEPARATOR}160${TMUX_PANE_FIELD_SEPARATOR}50${TMUX_PANE_FIELD_SEPARATOR}$7${TMUX_PANE_FIELD_SEPARATOR}@3${TMUX_PANE_FIELD_SEPARATOR}0${TMUX_PANE_FIELD_SEPARATOR}101${TMUX_PANE_FIELD_SEPARATOR}codex${TMUX_PANE_FIELD_SEPARATOR}/repo`,
        `%9${TMUX_PANE_FIELD_SEPARATOR}node${TMUX_PANE_FIELD_SEPARATOR}0${TMUX_PANE_FIELD_SEPARATOR}47${TMUX_PANE_FIELD_SEPARATOR}160${TMUX_PANE_FIELD_SEPARATOR}3${TMUX_PANE_FIELD_SEPARATOR}49${TMUX_PANE_FIELD_SEPARATOR}160${TMUX_PANE_FIELD_SEPARATOR}50${TMUX_PANE_FIELD_SEPARATOR}$7${TMUX_PANE_FIELD_SEPARATOR}@3${TMUX_PANE_FIELD_SEPARATOR}0${TMUX_PANE_FIELD_SEPARATOR}109${TMUX_PANE_FIELD_SEPARATOR}omx hud --watch${TMUX_PANE_FIELD_SEPARATOR}/repo`,
      ].join('\n') + '\n';
    }, '%1');

    assert.deepEqual(panes.map(pane => ({
      paneId: pane.paneId,
      sessionId: pane.sessionId,
      windowId: pane.windowId,
      paneDead: pane.paneDead,
      panePid: pane.panePid,
    })), [
      { paneId: '%1', sessionId: '$7', windowId: '@3', paneDead: false, panePid: '101' },
      { paneId: '%9', sessionId: '$7', windowId: '@3', paneDead: false, panePid: '109' },
    ]);
    assert.equal(calls.length, 2);
    assert.match(calls[1]?.at(-1) ?? '', /#\{session_id\}/);
    assert.match(calls[1]?.at(-1) ?? '', /#\{window_id\}/);
  });

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

  it('reads ownership from tmux outer quoting with escaped nested quotes', () => {
    const [pane] = parseTmuxPaneSnapshot(
      `%9\tnode\t"env OMX_DETACHED_HUD_OPERATION='op' /bin/zsh -c 'exec env OMX_SESSION_ID=\\"sess-a\\" OMX_TMUX_HUD_OWNER=\\"1\\" ${OMX_TMUX_HUD_LEADER_PANE_ENV}=\\"%1\\" node omx hud --watch'"`,
    );

    assert.deepEqual(readHudPaneOwner(pane!), {
      sessionId: 'sess-a',
      leaderPaneId: '%1',
    });
    assert.equal(hasValidHudOwnerMarker(pane!), true);
  });

  it('collects owner assignments after leading non-owner assignments before exec env', () => {
    const [pane] = parseTmuxPaneSnapshot(
      `%9\tnode\tOMX_TMUX_SPLIT_OPERATION_MARKER='op' exec env OMX_SESSION_ID='sess-a' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
    );

    assert.deepEqual(readHudPaneOwner(pane!), {
      sessionId: 'sess-a',
      leaderPaneId: '%1',
    });
    assert.equal(hasValidHudOwnerMarker(pane!), true);
  });

  it('accepts the valid initial empty leader metadata', () => {
    const [pane] = parseTmuxPaneSnapshot(
      `%9\tnode\texec env OMX_SESSION_ID='sess-a' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='' node omx hud --watch`,
    );

    assert.deepEqual(readHudPaneOwner(pane!), {
      sessionId: 'sess-a',
      leaderPaneId: undefined,
    });
    assert.equal(hasValidHudOwnerMarker(pane!), true);
  });

  it('rejects ambiguous repeated ownership assignments', () => {
    const [pane] = parseTmuxPaneSnapshot(
      `%9\tnode\texec env OMX_SESSION_ID='sess-a' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%2' node omx hud --watch`,
    );

    assert.deepEqual(readHudPaneOwner(pane!), {
      sessionId: undefined,
      leaderPaneId: undefined,
    });
    assert.equal(hasValidHudOwnerMarker(pane!), false);
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
        ['%1', 'codex', '0', '0', '160', '47', '46', '160', '50', '$7', '@3', '0', '101', 'codex', '/repo'].join('\x1f'),
        ['%2', 'node', '0', '47', '160', '3', '49', '160', '50', '$7', '@3', '0', '102', `exec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`, '/repo'].join('\x1f'),
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
          '#{session_id}',
          '#{window_id}',
          '#{pane_dead}',
          '#{pane_pid}',
          '#{pane_start_command}',
          '#{pane_current_path}',
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

describe('HUD split operation marker round-trip', () => {
  const markerListPanes = (startCommands: string[]): string =>
    startCommands.map((command, index) => `%${index + 1}|${command}`).join('\n') + '\n';

  const execReturning = (output: string): ((args: string[]) => string) => (args) => {
    assert.deepEqual(args, ['list-panes', '-a', '-F', '#{pane_id}|#{pane_start_command}']);
    return output;
  };

  it('round-trips the tmux 3.2a double-quoted command-scoped assignment form', () => {
    const marker = 'omx-split-marker';
    const paneId = findHudSplitOperationMarkerPaneId(
      marker,
      execReturning(markerListPanes([
        '"sleep 300"',
        `"OMX_TMUX_SPLIT_OPERATION_MARKER='${marker}' node omx.js hud --watch"`,
      ])),
    );
    assert.equal(paneId, '%2');
  });

  it('round-trips the tmux 3.2a double-quoted old export form', () => {
    const marker = 'omx-split-marker';
    const paneId = findHudSplitOperationMarkerPaneId(
      marker,
      execReturning(markerListPanes([
        `"OMX_TMUX_SPLIT_OPERATION_MARKER='${marker}'; export OMX_TMUX_SPLIT_OPERATION_MARKER; exec env OMX_TMUX_HUD_OWNER=1 node omx.js hud --watch"`,
      ])),
    );
    assert.equal(paneId, '%1');
  });

  it('keeps matching the bare semicolon export form', () => {
    const marker = 'omx-split-marker';
    const paneId = findHudSplitOperationMarkerPaneId(
      marker,
      execReturning(markerListPanes([
        `OMX_TMUX_SPLIT_OPERATION_MARKER='${marker}'; export OMX_TMUX_SPLIT_OPERATION_MARKER; exec env node omx.js hud --watch`,
      ])),
    );
    assert.equal(paneId, '%1');
  });

  it('keeps matching the bare command-scoped assignment form', () => {
    const marker = 'omx-split-marker';
    const paneId = findHudSplitOperationMarkerPaneId(
      marker,
      execReturning(markerListPanes([
        `OMX_TMUX_SPLIT_OPERATION_MARKER='${marker}' node omx.js hud --watch`,
      ])),
    );
    assert.equal(paneId, '%1');
  });

  it('preserves pipe characters inside pane_start_command', () => {
    const marker = 'omx-split-marker';
    assert.equal(findHudSplitOperationMarkerPaneId(
      marker,
      execReturning(markerListPanes([
        `"OMX_TMUX_SPLIT_OPERATION_MARKER='${marker}' sh -c 'printf a|cat'"`,
      ])),
    ), '%1');
  });

  it('rejects a marker mentioned mid-command', () => {
    const marker = 'omx-split-marker';
    const paneId = findHudSplitOperationMarkerPaneId(
      marker,
      execReturning(markerListPanes([
        `"echo OMX_TMUX_SPLIT_OPERATION_MARKER='${marker}' ; node omx.js hud --watch"`,
      ])),
    );
    assert.equal(paneId, null);
  });

  it('rejects a longer marker value sharing the same prefix', () => {
    const marker = 'omx-split-marker';
    const paneId = findHudSplitOperationMarkerPaneId(
      marker,
      execReturning(markerListPanes([
        `"OMX_TMUX_SPLIT_OPERATION_MARKER='${marker}-extended' node omx.js hud --watch"`,
      ])),
    );
    assert.equal(paneId, null);
  });

  it('returns null when two panes carry the same marker', () => {
    const marker = 'omx-split-marker';
    const paneId = findHudSplitOperationMarkerPaneId(
      marker,
      execReturning(markerListPanes([
        `"OMX_TMUX_SPLIT_OPERATION_MARKER='${marker}' sleep 1"`,
        `"OMX_TMUX_SPLIT_OPERATION_MARKER='${marker}' sleep 2"`,
      ])),
    );
    assert.equal(paneId, null);
  });
});
