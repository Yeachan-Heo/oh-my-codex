import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import {
  createHudWatchPane,
  findHudSplitOperationMarkerPaneId,
  findHudWatchPaneIds,
  listCurrentWindowPanes,
  readHudHookHealth,
  readHudLeaderOwnerIdentity,
  registerHudResizeHook,
} from '../tmux.js';
import { isRealTmuxAvailable, type TempTmuxSessionFixture, withTempTmuxSession } from '../../team/__tests__/tmux-test-fixture.js';
import { dispatchCodexNativeHook } from '../../scripts/codex-native-hook.js';
import { HUD_TMUX_MIN_LAUNCH_WINDOW_HEIGHT_LINES } from '../constants.js';

const PANE_READY_TIMEOUT_MS = 1_000;
const PANE_READY_INTERVAL_MS = 50;
const ENV_FILE_TIMEOUT_MS = 3_000;
const HUD_RECONCILE_TIMEOUT_MS = 15_000;
const TEMP_CLEANUP_RETRIES = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function skipUnlessPrivateRealTmux(t: TestContext): boolean {
  if (isRealTmuxAvailable()) return true;
  assert.equal(process.env.CI, undefined, 'CI must provide tmux for the private-server HUD split regression');
  t.skip('tmux is not installed');
  return false;
}

function quoteSh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function parseShimTmuxArgv(contents: string): string[][] {
  return contents
    .split('tmux argv:\n')
    .slice(1)
    .map((record) => record.split('\nend tmux argv')[0]!.split('\n').filter(Boolean));
}

async function waitForPaneReady(fixture: TempTmuxSessionFixture, paneId: string): Promise<void> {
  const deadline = Date.now() + PANE_READY_TIMEOUT_MS;
  let lastState = '';
  while (Date.now() < deadline) {
    lastState = fixture.run(['display-message', '-p', '-t', paneId, '#{pane_dead}']);
    if (lastState === '0') return;
    await new Promise((resolve) => setTimeout(resolve, PANE_READY_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for private tmux pane readiness: ${paneId} (${lastState})`);
}

async function waitForFileContent(filePath: string): Promise<string> {
  const deadline = Date.now() + ENV_FILE_TIMEOUT_MS;
  let lastContent = '';
  while (Date.now() < deadline) {
    try {
      lastContent = await readFile(filePath, 'utf-8');
      if (lastContent !== '') return lastContent;
    } catch {
      // The pane may not have started writing yet.
    }
    await new Promise((resolve) => setTimeout(resolve, PANE_READY_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for pane env marker file: ${filePath} (last: ${JSON.stringify(lastContent)})`);
}

async function removeTempDirWithRetry(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < TEMP_CLEANUP_RETRIES; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY') throw error;
      await new Promise((resolve) => setTimeout(resolve, PANE_READY_INTERVAL_MS));
    }
  }
  throw lastError;
}

async function waitForReconciledHud(
  leaderPaneId: string,
  oldHudPaneId: string,
  sessionId: string,
  operation = 'layout mutation',
): Promise<string> {
  const deadline = Date.now() + HUD_RECONCILE_TIMEOUT_MS;
  let lastSnapshot = '';
  while (Date.now() < deadline) {
    const panes = listCurrentWindowPanes(undefined, leaderPaneId);
    const leader = panes.find((pane) => pane.paneId === leaderPaneId);
    const hudPaneIds = findHudWatchPaneIds(panes, leaderPaneId, { leaderPaneId, sessionId });
    const hud = hudPaneIds.length === 1
      ? panes.find((pane) => pane.paneId === hudPaneIds[0])
      : undefined;
    lastSnapshot = JSON.stringify({ leader, hudPaneIds, hud });
    if (
      leader
      && hud
      && hud.paneId !== oldHudPaneId
      && hud.paneTop === (leader.paneBottom ?? -2) + 2
      && hud.paneLeft === leader.paneLeft
      && hud.paneWidth === leader.paneWidth
    ) return hud.paneId;
    await new Promise((resolve) => setTimeout(resolve, PANE_READY_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for automatic HUD topology reconciliation after ${operation}: ${lastSnapshot}`);
}

async function waitForRegisteredLayoutHooks(fixture: TempTmuxSessionFixture): Promise<void> {
  const deadline = Date.now() + HUD_RECONCILE_TIMEOUT_MS;
  let lastHooks = '';
  while (Date.now() < deadline) {
    const sessionHooks = fixture.run(['show-hooks', '-t', fixture.sessionName]);
    const windowHooks = fixture.run(['show-hooks', '-w', '-t', fixture.leaderPaneId]);
    lastHooks = `${sessionHooks}\n${windowHooks}`;
    if (/^after-split-window\[/m.test(sessionHooks) && /^window-layout-changed\[/m.test(windowHooks)) return;
    await new Promise((resolve) => setTimeout(resolve, PANE_READY_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for split and window layout hooks: ${lastHooks}`);
}

async function waitForPaneToDisappear(
  fixture: TempTmuxSessionFixture,
  paneId: string,
  operation: string,
): Promise<void> {
  const deadline = Date.now() + HUD_RECONCILE_TIMEOUT_MS;
  let lastPaneIds = '';
  while (Date.now() < deadline) {
    lastPaneIds = fixture.run(['list-panes', '-a', '-F', '#{pane_id}']);
    if (!lastPaneIds.split('\n').includes(paneId)) return;
    await new Promise((resolve) => setTimeout(resolve, PANE_READY_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for the old HUD watcher to retire after ${operation}: ${lastPaneIds}`);
}

function createOwnedHud(
  fixture: TempTmuxSessionFixture,
  workDir: string,
  sessionId: string,
): { hudPaneId: string; omxEntry: string } {
  const omxEntry = join(process.cwd(), 'dist', 'cli', 'omx.js');
  const hudCommand = [
    'exec',
    'env',
    'OMX_TMUX_HUD_OWNER=1',
    `OMX_SESSION_ID=${quoteSh(sessionId)}`,
    `OMX_TMUX_HUD_LEADER_PANE=${quoteSh(fixture.leaderPaneId)}`,
    `OMX_ROOT=${quoteSh(workDir)}`,
    `OMX_ENTRY_PATH=${quoteSh(omxEntry)}`,
    `OMX_STARTUP_CWD=${quoteSh(process.cwd())}`,
    quoteSh(process.execPath),
    quoteSh(omxEntry),
    'hud',
    '--watch',
  ].join(' ');
  const hudPaneId = fixture.run([
    'split-window', '-d', '-P', '-F', '#{pane_id}', '-v', '-l', '2',
    '-c', workDir, '-t', fixture.leaderPaneId, hudCommand,
  ]);
  return { hudPaneId, omxEntry };
}

function registerOwnedHudHooks(
  fixture: TempTmuxSessionFixture,
  workDir: string,
  sessionId: string,
  hudPaneId: string,
  omxEntry: string,
): void {
  fixture.run(['set-option', '-t', fixture.sessionName, '@omx_instance_id', sessionId]);
  assert.equal(registerHudResizeHook(
    hudPaneId,
    fixture.leaderPaneId,
    2,
    {
      cwd: workDir,
      env: {
        ...process.env,
        ...fixture.env,
        OMX_ENTRY_PATH: omxEntry,
        OMX_STARTUP_CWD: process.cwd(),
        OMX_SESSION_ID: sessionId,
        OMX_ROOT: workDir,
      },
    },
  ), true);
}

function assertPaneExists(fixture: TempTmuxSessionFixture, paneId: string, message: string): void {
  const paneIds = fixture.run(['list-panes', '-a', '-F', '#{pane_id}']).split('\n');
  assert.ok(paneIds.includes(paneId), message);
}

async function waitForOwnedHudHooksHealthy(
  fixture: TempTmuxSessionFixture,
  workDir: string,
  sessionId: string,
  hudPaneId: string,
  omxEntry: string,
): Promise<void> {
  const deadline = Date.now() + HUD_RECONCILE_TIMEOUT_MS;
  let lastHealth = 'unknown';
  let lastProbe = '';
  while (Date.now() < deadline) {
    const panes = listCurrentWindowPanes(undefined, fixture.leaderPaneId);
    const leader = panes.find((pane) => pane.paneId === fixture.leaderPaneId);
    const hud = panes.find((pane) => pane.paneId === hudPaneId);
    if (leader?.panePid && leader.sessionId && leader.windowId && hud?.panePid && hud.paneHeight) {
      lastHealth = readHudHookHealth({
        leaderPaneId: fixture.leaderPaneId,
        leaderPanePid: leader.panePid,
        hudPaneId,
        hudPanePid: hud.panePid,
        sessionId: leader.sessionId,
        windowId: leader.windowId,
        heightLines: hud.paneHeight,
        cwd: workDir,
        env: {
          ...process.env,
          ...fixture.env,
          OMX_ENTRY_PATH: omxEntry,
          OMX_STARTUP_CWD: process.cwd(),
          OMX_SESSION_ID: sessionId,
          OMX_ROOT: workDir,
        },
      }, (args) => {
        const output = fixture.run(args);
        if (args[0] === 'display-message' && args.at(-1)?.includes('@omx_hook_identity_')) {
          lastProbe = output;
        }
        return `${output}\n`;
      });
      if (lastHealth === 'healthy') return;
    }
    await new Promise((resolve) => setTimeout(resolve, PANE_READY_INTERVAL_MS));
  }
  const hookOutput = `${fixture.run(['show-hooks', '-t', fixture.sessionName])}\n${fixture.run(['show-hooks', '-w', '-t', fixture.leaderPaneId])}`;
  const hookSlots = [...hookOutput.matchAll(/^(client-resized|window-layout-changed|after-split-window)\[([0-9]+)\]/gmu)]
    .map((match) => `${match[1]}[${match[2]}]`)
    .filter((slot, index, slots) => slots.indexOf(slot) === index);
  const hookEquality = hookSlots.map((slot) => {
    const option = `@omx_hook_expected_${slot.slice(0, slot.indexOf('[')).replaceAll('-', '_')}_${slot.slice(slot.indexOf('[') + 1, -1)}`;
    return `${slot}:${fixture.run(['display-message', '-p', '-t', fixture.leaderPaneId, `#{?#{==:#{${slot}},#{${option}}},1,0}`])}`;
  }).join(',');
  throw new Error(`timed out waiting for healthy owned HUD hooks: ${lastHealth} (${lastProbe}; ${hookEquality})`);
}

describe('createHudWatchPane real private-server split transaction', () => {
  it('retains both HUDs when a vertically split sibling becomes the latest session owner', async (t) => {
    if (!skipUnlessPrivateRealTmux(t)) return;

    const workDir = await mkdtemp(join(tmpdir(), 'omx-hud-two-leaders-'));
    try {
      await withTempTmuxSession({}, async (fixture) => {
        const topId = fixture.leaderPaneId;
        const bottomId = fixture.run(['split-window', '-d', '-P', '-F', '#{pane_id}', '-v', '-t', topId]);
        fixture.run(['set-option', '-t', fixture.sessionName, '@omx_instance_id', 'top-owner']);
        fixture.run(['set-option', '-p', '-t', topId, '@omx_pane_instance_id', 'top-owner']);
        const top = createOwnedHud(fixture, workDir, 'top-owner');
        await waitForPaneReady(fixture, top.hudPaneId);

        fixture.run(['set-option', '-t', fixture.sessionName, '@omx_instance_id', 'bottom-owner']);
        fixture.run(['set-option', '-p', '-t', bottomId, '@omx_pane_instance_id', 'bottom-owner']);
        const bottomFixture = { ...fixture, leaderPaneId: bottomId };
        const bottom = createOwnedHud(bottomFixture, workDir, 'bottom-owner');
        await waitForPaneReady(fixture, bottom.hudPaneId);

        const execTmux = (args: string[]) => `${fixture.run(args)}\n`;
        assert.equal(readHudLeaderOwnerIdentity(topId, 'top-owner', execTmux), 'current');
        assert.equal(readHudLeaderOwnerIdentity(bottomId, 'bottom-owner', execTmux), 'current');
        assert.equal(registerHudResizeHook(top.hudPaneId, topId, 2, {
          cwd: workDir,
          env: { ...fixture.env, OMX_SESSION_ID: 'top-owner', OMX_ENTRY_PATH: top.omxEntry },
        }, execTmux), true);
        await waitForOwnedHudHooksHealthy(fixture, workDir, 'top-owner', top.hudPaneId, top.omxEntry);

        fixture.run(['set-option', '-p', '-t', bottomId, '@omx_pane_instance_id', 'bottom-successor']);
        await waitForPaneToDisappear(fixture, bottom.hudPaneId, 'bottom leader ownership change');
        assertPaneExists(fixture, top.hudPaneId, 'closing the bottom HUD must not retire the top HUD');
      });
    } finally {
      await removeTempDirWithRetry(workDir);
    }
  });

  it('creates one healthy HUD after a cramped window grows and retires it when ownership changes', async (t) => {
    if (!skipUnlessPrivateRealTmux(t)) return;

    const workDir = await mkdtemp(join(tmpdir(), 'omx-hud-native-hook-realtmux-'));
    const binDir = join(workDir, 'bin');
    const sessionId = `omx-hud-native-hook-${process.pid}`;
    const omxEntry = join(process.cwd(), 'dist', 'cli', 'omx.js');
    const envKeys = [
      'PATH', 'OMX_ROOT', 'OMX_STATE_ROOT', 'OMX_TEAM_STATE_ROOT',
      'OMX_SESSION_ID', 'OMX_TMUX_HUD_OWNER', 'OMX_TMUX_HUD_LEADER_PANE',
      'OMX_ENTRY_PATH', 'OMX_STARTUP_CWD', 'OMX_NATIVE_HOOK_DOCTOR_SMOKE',
    ] as const;
    const previousEnv = envKeys.map((key) => process.env[key]);
    try {
      await mkdir(binDir, { recursive: true });
      await withTempTmuxSession({ serverLog: true }, async (fixture) => {
        await fixture.createPathShim(binDir);
        process.env.PATH = `${binDir}:${previousEnv[0] ?? ''}`;
        process.env.OMX_ROOT = workDir;
        delete process.env.OMX_STATE_ROOT;
        delete process.env.OMX_TEAM_STATE_ROOT;
        process.env.OMX_SESSION_ID = sessionId;
        process.env.OMX_TMUX_HUD_OWNER = '1';
        process.env.OMX_TMUX_HUD_LEADER_PANE = fixture.leaderPaneId;
        process.env.OMX_ENTRY_PATH = omxEntry;
        process.env.OMX_STARTUP_CWD = process.cwd();
        delete process.env.OMX_NATIVE_HOOK_DOCTOR_SMOKE;
        fixture.run(['set-option', '-t', fixture.sessionName, '@omx_instance_id', sessionId]);
        await waitForPaneReady(fixture, fixture.leaderPaneId);
        assert.ok(
          Number(fixture.run(['display-message', '-p', '-t', fixture.leaderPaneId, '#{window_height}']))
            < HUD_TMUX_MIN_LAUNCH_WINDOW_HEIGHT_LINES,
        );

        const prompt = {
          hook_event_name: 'UserPromptSubmit',
          cwd: workDir,
          session_id: sessionId,
          prompt: 'Inspect the HUD integration test',
        };
        await dispatchCodexNativeHook(prompt, { cwd: workDir });
        assert.deepEqual(
          findHudWatchPaneIds(listCurrentWindowPanes(undefined, fixture.leaderPaneId), fixture.leaderPaneId, {
            leaderPaneId: fixture.leaderPaneId,
            sessionId,
          }),
          [],
        );
        fixture.run(['resize-window', '-t', fixture.windowTarget, '-x', '120', '-y', '50']);
        assert.equal(fixture.run(['display-message', '-p', '-t', fixture.leaderPaneId, '#{window_height}']), '50');

        await dispatchCodexNativeHook(prompt, { cwd: workDir });
        const firstPanes = listCurrentWindowPanes(undefined, fixture.leaderPaneId);
        const firstHudIds = findHudWatchPaneIds(firstPanes, fixture.leaderPaneId, {
          leaderPaneId: fixture.leaderPaneId,
          sessionId,
        });
        assert.equal(firstHudIds.length, 1);
        const hudPaneId = firstHudIds[0]!;
        await waitForPaneReady(fixture, hudPaneId);
        await waitForOwnedHudHooksHealthy(fixture, workDir, sessionId, hudPaneId, omxEntry);

        await dispatchCodexNativeHook(prompt, { cwd: workDir });
        const secondPanes = listCurrentWindowPanes(undefined, fixture.leaderPaneId);
        assert.deepEqual(
          findHudWatchPaneIds(secondPanes, fixture.leaderPaneId, {
            leaderPaneId: fixture.leaderPaneId,
            sessionId,
          }),
          [hudPaneId],
        );
        fixture.run(['set-option', '-t', fixture.sessionName, '@omx_instance_id', `${sessionId}-successor`]);
        await waitForPaneToDisappear(fixture, hudPaneId, 'owner identity change');
        assert.doesNotMatch(await fixture.readServerLog(), /too many arguments|unknown hook/i);
      });
    } finally {
      for (let index = 0; index < envKeys.length; index += 1) {
        const key = envKeys[index]!;
        const value = previousEnv[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await removeTempDirWithRetry(workDir);
    }
  });

  it('creates a marker-tagged HUD pane and round-trips the tmux 3.2a pane_start_command', async (t) => {
    if (!skipUnlessPrivateRealTmux(t)) return;

    const workDir = await mkdtemp(join(tmpdir(), 'omx-hud-split-realtmux-'));
    const bin = join(workDir, 'bin');
    const shimLogPath = join(workDir, 'tmux-argv.log');
    const envFile = join(workDir, 'marker-env.txt');
    const previousPath = process.env.PATH;
    try {
      await mkdir(bin, { recursive: true });
      await withTempTmuxSession({ serverLog: true }, async (fixture) => {
        await fixture.createPathShim(bin, shimLogPath);
        process.env.PATH = `${bin}:${previousPath ?? ''}`;
        try {
          await waitForPaneReady(fixture, fixture.leaderPaneId);

          const hudCmd = `/bin/sh -c ${quoteSh(
            `printf %s "$OMX_TMUX_SPLIT_OPERATION_MARKER" > ${quoteSh(envFile)}; exec sleep 300`,
          )}`;
          const paneId = createHudWatchPane(workDir, hudCmd, { targetPaneId: fixture.leaderPaneId });
          assert.ok(paneId, 'guarded split must create the HUD pane and emit its receipt');

          const panes = fixture.run(['list-panes', '-a', '-F', '#{pane_id}|#{pane_start_command}']);
          const paneRow = panes.split('\n').find((row) => row.startsWith(`${paneId}|`));
          assert.ok(paneRow, 'created HUD pane must exist on the private server');

          const marker = await waitForFileContent(envFile);
          assert.match(marker, UUID_PATTERN, 'env marker file must expose the operation marker uuid');
          assert.ok(
            paneRow.includes(`OMX_TMUX_SPLIT_OPERATION_MARKER='${marker}'`),
            'pane_start_command must carry the marker in the tmux 3.2a double-quoted representation',
          );

          const execTmux = (args: string[]): string => {
            const result = fixture.runResult(args);
            assert.equal(result.status, 0, `tmux ${args.join(' ')} failed: ${result.stderr}`);
            return result.stdout;
          };
          assert.equal(
            findHudSplitOperationMarkerPaneId(marker, execTmux),
            paneId,
            'marker round-trip must resolve the created HUD pane',
          );

          const ifShellTransactions = parseShimTmuxArgv(await readFile(shimLogPath, 'utf-8'))
            .filter((argv) => argv[0] === 'if-shell');
          assert.equal(ifShellTransactions.length, 1, 'guarded split must run exactly one if-shell transaction');
          const successBranch = ifShellTransactions[0]?.[5] ?? '';
          assert.match(successBranch, /split-window/);
          assert.match(successBranch, / ; display-message -p __omx_hud_split_/);
          assert.doesNotMatch(successBranch, /\\; /);
          assert.doesNotMatch(
            await fixture.readServerLog(),
            /too many arguments/i,
            'real tmux must not fold the receipt command into the effect argv',
          );
        } finally {
          if (typeof previousPath === 'string') process.env.PATH = previousPath;
          else delete process.env.PATH;
        }
      });
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await removeTempDirWithRetry(workDir);
    }
  });

  it('recreates and rearms a HUD directly below its owner after another pane is split', async (t) => {
    if (!skipUnlessPrivateRealTmux(t)) return;

    const workDir = await mkdtemp(join(tmpdir(), 'omx-hud-layout-realtmux-'));
    try {
      await withTempTmuxSession({ serverLog: true }, async (fixture) => {
        const sessionId = `omx-hud-layout-${process.pid}`;
        const omxEntry = join(process.cwd(), 'dist', 'cli', 'omx.js');
        const hudCommand = [
          'env',
          'OMX_TMUX_HUD_OWNER=1',
          `OMX_SESSION_ID=${quoteSh(sessionId)}`,
          `OMX_TMUX_HUD_LEADER_PANE=${quoteSh(fixture.leaderPaneId)}`,
          `OMX_ROOT=${quoteSh(workDir)}`,
          quoteSh(process.execPath),
          quoteSh(omxEntry),
          'hud',
          '--watch',
        ].join(' ');
        const oldHudPaneId = fixture.run([
          'split-window', '-d', '-P', '-F', '#{pane_id}', '-v', '-l', '2',
          '-c', workDir, '-t', fixture.leaderPaneId, hudCommand,
        ]);
        await waitForPaneReady(fixture, oldHudPaneId);
        fixture.run(['set-option', '-t', fixture.sessionName, '@omx_instance_id', sessionId]);

        assert.equal(registerHudResizeHook(
          oldHudPaneId,
          fixture.leaderPaneId,
          2,
          {
            cwd: workDir,
            env: {
              ...process.env,
              ...fixture.env,
              OMX_ENTRY_PATH: omxEntry,
              OMX_STARTUP_CWD: process.cwd(),
              OMX_SESSION_ID: sessionId,
              OMX_ROOT: workDir,
            },
          },
        ), true);
        assert.match(fixture.run(['show-hooks', '-t', fixture.sessionName]), /^after-split-window\[/m);

        fixture.run(['split-window', '-d', '-v', '-t', fixture.leaderPaneId, 'sleep 300']);
        const newHudPaneId = await waitForReconciledHud(fixture.leaderPaneId, oldHudPaneId, sessionId);

        assert.notEqual(newHudPaneId, oldHudPaneId);
        await waitForOwnedHudHooksHealthy(fixture, workDir, sessionId, newHudPaneId, omxEntry);
        assert.match(
          fixture.run(['show-hooks', '-t', fixture.sessionName]),
          /^after-split-window\[/m,
          'one-shot split hook must be rearmed after reconciliation',
        );
        assert.doesNotMatch(await fixture.readServerLog(), /too many arguments|unknown hook/i);
      });
    } finally {
      await removeTempDirWithRetry(workDir);
    }
  });

  for (const mutation of ['join-pane', 'move-pane', 'swap-pane', 'select-layout'] as const) {
    it(`reconciles HUD placement after ${mutation}`, async (t) => {
      if (!skipUnlessPrivateRealTmux(t)) return;

      const workDir = await mkdtemp(join(tmpdir(), `omx-hud-${mutation}-realtmux-`));
      try {
        await withTempTmuxSession({ serverLog: true }, async (fixture) => {
          const sessionId = `omx-hud-${mutation}-${process.pid}`;
          const omxEntry = join(process.cwd(), 'dist', 'cli', 'omx.js');
          const peerPaneId = fixture.run([
            'split-window', '-d', '-P', '-F', '#{pane_id}', '-h',
            '-t', fixture.leaderPaneId, 'sleep 300',
          ]);
          const hudCommand = [
            'env',
            'OMX_TMUX_HUD_OWNER=1',
            `OMX_SESSION_ID=${quoteSh(sessionId)}`,
            `OMX_TMUX_HUD_LEADER_PANE=${quoteSh(fixture.leaderPaneId)}`,
            `OMX_ROOT=${quoteSh(workDir)}`,
            quoteSh(process.execPath),
            quoteSh(omxEntry),
            'hud',
            '--watch',
          ].join(' ');
          const hudPaneId = fixture.run([
            'split-window', '-d', '-P', '-F', '#{pane_id}', '-v', '-l', '2',
            '-c', workDir, '-t', fixture.leaderPaneId, hudCommand,
          ]);
          await waitForPaneReady(fixture, peerPaneId);
          await waitForPaneReady(fixture, hudPaneId);
          fixture.run(['set-option', '-t', fixture.sessionName, '@omx_instance_id', sessionId]);

          assert.equal(registerHudResizeHook(
            hudPaneId,
            fixture.leaderPaneId,
            2,
            {
              cwd: workDir,
              env: {
                ...process.env,
                ...fixture.env,
                OMX_ENTRY_PATH: omxEntry,
                OMX_STARTUP_CWD: process.cwd(),
                OMX_SESSION_ID: sessionId,
                OMX_ROOT: workDir,
              },
            },
          ), true);
          await waitForRegisteredLayoutHooks(fixture);

          if (mutation === 'join-pane' || mutation === 'move-pane') {
            const sourcePaneId = fixture.run([
              'new-window', '-d', '-P', '-F', '#{pane_id}',
              '-t', fixture.sessionName, 'sleep 300',
            ]);
            fixture.run([mutation, '-d', '-v', '-s', sourcePaneId, '-t', fixture.leaderPaneId]);
          } else if (mutation === 'swap-pane') {
            fixture.run(['swap-pane', '-d', '-s', hudPaneId, '-t', peerPaneId]);
          } else {
            fixture.run(['select-layout', '-t', fixture.leaderPaneId, 'even-horizontal']);
          }

          const newHudPaneId = await waitForReconciledHud(
            fixture.leaderPaneId,
            hudPaneId,
            sessionId,
            mutation,
          );
          assert.notEqual(newHudPaneId, hudPaneId, `${mutation} must trigger HUD recreation`);
          await waitForRegisteredLayoutHooks(fixture);
          assert.doesNotMatch(await fixture.readServerLog(), /too many arguments|unknown hook/i);
        });
      } finally {
        await removeTempDirWithRetry(workDir);
      }
    });
  }

  it('moves an owned HUD to another window, retires the old watcher, and keeps unrelated panes', async (t) => {
    if (!skipUnlessPrivateRealTmux(t)) return;

    const workDir = await mkdtemp(join(tmpdir(), 'omx-hud-cross-window-realtmux-'));
    try {
      await withTempTmuxSession({ serverLog: true }, async (fixture) => {
        const sessionId = `omx-hud-cross-window-${process.pid}`;
        const destinationPaneId = fixture.run([
          'new-window', '-d', '-P', '-F', '#{pane_id}',
          '-t', fixture.sessionName, 'sleep 300',
        ]);
        fixture.run(['resize-window', '-t', fixture.leaderPaneId, '-x', '90', '-y', '70']);
        fixture.run(['resize-window', '-t', destinationPaneId, '-x', '90', '-y', '70']);
        const { hudPaneId, omxEntry } = createOwnedHud(fixture, workDir, sessionId);
        registerOwnedHudHooks(fixture, workDir, sessionId, hudPaneId, omxEntry);
        await waitForPaneReady(fixture, destinationPaneId);
        await waitForPaneReady(fixture, hudPaneId);
        await waitForOwnedHudHooksHealthy(fixture, workDir, sessionId, hudPaneId, omxEntry);

        fixture.run(['move-pane', '-d', '-v', '-s', hudPaneId, '-t', destinationPaneId]);

        const replacementPaneId = await waitForReconciledHud(
          fixture.leaderPaneId,
          hudPaneId,
          sessionId,
          'moving the owned HUD to another window',
        );
        await waitForPaneToDisappear(fixture, hudPaneId, 'moving the owned HUD to another window');
        await waitForRegisteredLayoutHooks(fixture);
        const leaderWindowPanes = listCurrentWindowPanes(undefined, fixture.leaderPaneId);
        assert.deepEqual(
          findHudWatchPaneIds(leaderWindowPanes, fixture.leaderPaneId, {
            leaderPaneId: fixture.leaderPaneId,
            sessionId,
          }),
          [replacementPaneId],
          'the leader window must contain exactly one healthy owned HUD',
        );
        await waitForOwnedHudHooksHealthy(fixture, workDir, sessionId, replacementPaneId, omxEntry);
        assertPaneExists(fixture, destinationPaneId, 'the unrelated destination pane must remain alive');
        assert.doesNotMatch(await fixture.readServerLog(), /too many arguments|unknown hook/i);
      });
    } finally {
      await removeTempDirWithRetry(workDir);
    }
  });

  it('moves the leader to another window, retires its old HUD, and keeps unrelated panes', async (t) => {
    if (!skipUnlessPrivateRealTmux(t)) return;

    const workDir = await mkdtemp(join(tmpdir(), 'omx-hud-leader-window-realtmux-'));
    try {
      await withTempTmuxSession({ serverLog: true }, async (fixture) => {
        const sessionId = `omx-hud-leader-window-${process.pid}`;
        const sourcePeerPaneId = fixture.run([
          'split-window', '-d', '-P', '-F', '#{pane_id}', '-h',
          '-t', fixture.leaderPaneId, 'sleep 300',
        ]);
        const destinationPaneId = fixture.run([
          'new-window', '-d', '-P', '-F', '#{pane_id}',
          '-t', fixture.sessionName, 'sleep 300',
        ]);
        fixture.run(['resize-window', '-t', fixture.leaderPaneId, '-x', '90', '-y', '70']);
        fixture.run(['resize-window', '-t', destinationPaneId, '-x', '90', '-y', '70']);
        const { hudPaneId, omxEntry } = createOwnedHud(fixture, workDir, sessionId);
        registerOwnedHudHooks(fixture, workDir, sessionId, hudPaneId, omxEntry);
        await waitForPaneReady(fixture, sourcePeerPaneId);
        await waitForPaneReady(fixture, destinationPaneId);
        await waitForPaneReady(fixture, hudPaneId);
        await waitForOwnedHudHooksHealthy(fixture, workDir, sessionId, hudPaneId, omxEntry);

        fixture.run(['move-pane', '-d', '-h', '-s', fixture.leaderPaneId, '-t', destinationPaneId]);

        const replacementPaneId = await waitForReconciledHud(
          fixture.leaderPaneId,
          hudPaneId,
          sessionId,
          'moving the leader to another window',
        );
        await waitForPaneToDisappear(fixture, hudPaneId, 'moving the leader to another window');
        await waitForRegisteredLayoutHooks(fixture);
        const leaderWindowPanes = listCurrentWindowPanes(undefined, fixture.leaderPaneId);
        assert.deepEqual(
          findHudWatchPaneIds(leaderWindowPanes, fixture.leaderPaneId, {
            leaderPaneId: fixture.leaderPaneId,
            sessionId,
          }),
          [replacementPaneId],
          'the moved leader must contain exactly one healthy owned HUD',
        );
        await waitForOwnedHudHooksHealthy(fixture, workDir, sessionId, replacementPaneId, omxEntry);
        assertPaneExists(fixture, sourcePeerPaneId, 'the unrelated source pane must remain alive');
        assertPaneExists(fixture, destinationPaneId, 'the unrelated destination pane must remain alive');
        assert.doesNotMatch(await fixture.readServerLog(), /too many arguments|unknown hook/i);
      });
    } finally {
      await removeTempDirWithRetry(workDir);
    }
  });

  it('rearms a missing layout hook without replacing a correctly placed HUD', async (t) => {
    if (!skipUnlessPrivateRealTmux(t)) return;

    const workDir = await mkdtemp(join(tmpdir(), 'omx-hud-hook-health-realtmux-'));
    try {
      await withTempTmuxSession({ serverLog: true }, async (fixture) => {
        const sessionId = `omx-hud-hook-health-${process.pid}`;
        const { hudPaneId, omxEntry } = createOwnedHud(fixture, workDir, sessionId);
        registerOwnedHudHooks(fixture, workDir, sessionId, hudPaneId, omxEntry);
        await waitForPaneReady(fixture, hudPaneId);
        await waitForOwnedHudHooksHealthy(fixture, workDir, sessionId, hudPaneId, omxEntry);
        const layoutHook = fixture.run(['show-hooks', '-w', '-t', fixture.leaderPaneId])
          .split('\n')
          .map((line) => line.match(/^(window-layout-changed\[[^\]]+\])/u)?.[1])
          .find((hook): hook is string => typeof hook === 'string');
        assert.ok(layoutHook, 'the owned HUD must publish its window layout hook');

        fixture.run(['set-hook', '-u', '-w', '-t', fixture.leaderPaneId, layoutHook]);
        await waitForRegisteredLayoutHooks(fixture);

        assertPaneExists(fixture, hudPaneId, 'hook recovery must preserve the correctly placed HUD pane');
        const panes = listCurrentWindowPanes(undefined, fixture.leaderPaneId);
        assert.deepEqual(
          findHudWatchPaneIds(panes, fixture.leaderPaneId, {
            leaderPaneId: fixture.leaderPaneId,
            sessionId,
          }),
          [hudPaneId],
          'hook recovery must retain one owned HUD',
        );
        await waitForOwnedHudHooksHealthy(fixture, workDir, sessionId, hudPaneId, omxEntry);
        assert.doesNotMatch(await fixture.readServerLog(), /too many arguments|unknown hook/i);
      });
    } finally {
      await removeTempDirWithRetry(workDir);
    }
  });

  it('uses the watcher fallback to recover a swapped HUD when its layout hook is absent', async (t) => {
    if (!skipUnlessPrivateRealTmux(t)) return;

    const workDir = await mkdtemp(join(tmpdir(), 'omx-hud-no-event-swap-realtmux-'));
    try {
      await withTempTmuxSession({ serverLog: true }, async (fixture) => {
        const sessionId = `omx-hud-no-event-swap-${process.pid}`;
        const peerPaneId = fixture.run([
          'split-window', '-d', '-P', '-F', '#{pane_id}', '-h',
          '-t', fixture.leaderPaneId, 'sleep 300',
        ]);
        const { hudPaneId, omxEntry } = createOwnedHud(fixture, workDir, sessionId);
        registerOwnedHudHooks(fixture, workDir, sessionId, hudPaneId, omxEntry);
        await waitForPaneReady(fixture, peerPaneId);
        await waitForPaneReady(fixture, hudPaneId);
        await waitForOwnedHudHooksHealthy(fixture, workDir, sessionId, hudPaneId, omxEntry);
        const layoutHook = fixture.run(['show-hooks', '-w', '-t', fixture.leaderPaneId])
          .split('\n')
          .map((line) => line.match(/^(window-layout-changed\[[^\]]+\])/u)?.[1])
          .find((hook): hook is string => typeof hook === 'string');
        assert.ok(layoutHook, 'the owned HUD must publish its window layout hook');
        fixture.run(['set-hook', '-u', '-w', '-t', fixture.leaderPaneId, layoutHook]);

        fixture.run(['swap-pane', '-d', '-s', hudPaneId, '-t', peerPaneId]);

        const replacementPaneId = await waitForReconciledHud(
          fixture.leaderPaneId,
          hudPaneId,
          sessionId,
          'a swap with no layout hook',
        );
        assert.notEqual(replacementPaneId, hudPaneId);
        await waitForRegisteredLayoutHooks(fixture);
        await waitForOwnedHudHooksHealthy(fixture, workDir, sessionId, replacementPaneId, omxEntry);
        assert.doesNotMatch(await fixture.readServerLog(), /too many arguments|unknown hook/i);
      });
    } finally {
      await removeTempDirWithRetry(workDir);
    }
  });
});
