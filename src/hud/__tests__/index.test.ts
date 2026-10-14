import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { hudCommand, resolveHudWatchCwd, runWatchMode } from '../index.js';
import { renderHud } from '../render.js';
import { OMX_TMUX_HUD_OWNER_ENV } from '../reconcile.js';
import { OMX_TMUX_HUD_LEADER_PANE_ENV } from '../tmux.js';
import type { HudFlags, HudRenderContext } from '../types.js';

const WATCH_FLAGS: HudFlags = {
  watch: true,
  json: false,
  tmux: false,
};

function emptyCtx(): HudRenderContext {
  return {
    version: null,
    gitBranch: null,
    ralph: null,
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
  };
}

// A leader pane and no HUD pane, so every watcher tick asks for a repair.
const REPAIR_WATCH_PANES = [{ paneId: '%1', currentCommand: 'codex', startCommand: 'codex', panePid: '101',
  paneLeft: 0, paneTop: 0, paneWidth: 80, paneHeight: 22, paneBottom: 21, windowWidth: 80, windowHeight: 23 }];
const REPAIR_WATCH_CONFIG = { preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } } as const;

function repairWatchEnv(sessionId: string): Record<string, string> {
  return { TMUX: 'tmux', TMUX_PANE: '%2', OMX_SESSION_ID: sessionId,
    [OMX_TMUX_HUD_OWNER_ENV]: '1', [OMX_TMUX_HUD_LEADER_PANE_ENV]: '%1' };
}

// Stands in for a reconcile child that hangs before doing any work. It logs
// its pid first, so every line of the log is one spawn. With `withGrandchild`
// it also starts a hanging grandchild in the child's process group, as the real
// child does when it runs tmux, and logs that pid too.
async function writeHangingReconcileEntry(root: string, withGrandchild = false): Promise<{
  entry: string;
  spawnLog: string;
  readSpawnPids: () => Promise<number[]>;
  readGrandchildPids: () => Promise<number[]>;
  killSpawned: () => Promise<void>;
}> {
  const entry = join(root, 'dist', 'cli', 'omx.js');
  const spawnLog = join(root, 'dist', 'cli', 'spawns.log');
  const grandchildLog = join(root, 'dist', 'cli', 'grandchildren.log');
  await mkdir(join(root, 'dist', 'cli'), { recursive: true });
  await writeFile(entry, [
    "require('node:fs').appendFileSync(require('node:path').join(__dirname, 'spawns.log'), process.pid + '\\n');",
    ...(withGrandchild ? [
      "const grandchild = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "require('node:fs').appendFileSync(require('node:path').join(__dirname, 'grandchildren.log'), grandchild.pid + '\\n');",
    ] : []),
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
  const readPids = async (log: string): Promise<number[]> => {
    const text = await readFile(log, 'utf-8').catch(() => '');
    return text.split('\n').filter(Boolean).map(Number);
  };
  const readSpawnPids = (): Promise<number[]> => readPids(spawnLog);
  const readGrandchildPids = (): Promise<number[]> => readPids(grandchildLog);
  // Without the timeout the hang children never exit; do not leak them.
  const killSpawned = async (): Promise<void> => {
    for (const pid of [...await readSpawnPids(), ...await readGrandchildPids()]) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ESRCH: the timeout already reaped this child.
      }
    }
  };
  return { entry, spawnLog, readSpawnPids, readGrandchildPids, killSpawned };
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function withTimeout(promise: Promise<void>, message: string, timeoutMs = 1000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('hudCommand reconcile entrypoint', () => {
  it('runs tmux reconciliation without changing the exit code when repair succeeds', async () => {
    let reconciledCwd: string | null = null;

    await hudCommand(['--reconcile-tmux'], {
      cwd: '/repo',
      reconcileHudForPromptSubmit: async (cwd) => {
        reconciledCwd = cwd;
        return { status: 'recreated', paneId: '%9', desiredHeight: 3, duplicateCount: 0 };
      },
    });

    assert.equal(reconciledCwd, '/repo');
    assert.equal(process.exitCode, undefined);
  });

  it('sets a non-zero exit code when tmux reconciliation fails', async () => {
    await hudCommand(['--reconcile-tmux'], {
      cwd: '/repo',
      reconcileHudForPromptSubmit: async () => (
        { status: 'failed', paneId: null, desiredHeight: 3, duplicateCount: 0 }
      ),
    });

    assert.equal(process.exitCode, 1);
  });
});

describe('runWatchMode', () => {
  it('keeps a verified owned HUD idle for sixty watcher ticks without reconciliation', async () => {
    let tick: (() => void) | undefined;
    let stop: (() => void) | undefined;
    let repairs = 0;
    let hookWrites = 0;
    let frames = 0;
    const panes = [
      { paneId: '%1', currentCommand: 'codex', startCommand: 'codex', panePid: '101', sessionId: '$1', windowId: '@1',
        paneLeft: 0, paneTop: 0, paneWidth: 80, paneHeight: 20, paneBottom: 19, windowWidth: 80, windowHeight: 23 },
      { paneId: '%2', currentCommand: 'node', panePid: '102', sessionId: '$1', windowId: '@1',
        startCommand: "OMX_TMUX_HUD_OWNER='1' OMX_SESSION_ID='idle-test' OMX_TMUX_HUD_LEADER_PANE='%1' node omx hud --watch",
        paneLeft: 0, paneTop: 21, paneWidth: 80, paneHeight: 2, paneBottom: 22, windowWidth: 80, windowHeight: 23 },
    ];
    const promise = runWatchMode('/repo', WATCH_FLAGS, {
      isTTY: true,
      env: { TMUX: 'tmux', TMUX_PANE: '%2', OMX_SESSION_ID: 'idle-test',
        [OMX_TMUX_HUD_OWNER_ENV]: '1', [OMX_TMUX_HUD_LEADER_PANE_ENV]: '%1' },
      isOwnerAliveFn: async () => true,
      isSessionAttachedFn: () => true,
      listCurrentWindowPanesFn: () => panes,
      readHudLeaderOwnerFn: () => 'current',
      readHudHookHealthFn: () => 'healthy',
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      readAllStateFn: async () => emptyCtx(),
      renderHudFn: () => { frames += 1; return 'frame'; },
      reconcileTmuxHudFn: async () => { repairs += 1; },
      registerHudResizeHookFn: () => { hookWrites += 1; return true; },
      runAuthorityTickFn: async () => {},
      writeStdout: () => {}, writeStderr: () => {},
      registerSigint: handler => { stop = handler; },
      setIntervalFn: handler => { tick = handler; return {} as ReturnType<typeof setInterval>; },
      clearIntervalFn: () => {},
    });
    await flush();
    for (let index = 0; index < 60; index += 1) {
      tick?.();
      await flush();
    }
    stop?.();
    await promise;
    assert.equal(frames, 61);
    assert.equal(repairs, 0);
    assert.equal(hookWrites, 0);
  });

  it('does not overlap watcher repair children while rendering continues', async () => {
    let tick: (() => void) | undefined;
    let stop: (() => void) | undefined;
    let repairs = 0;
    let frames = 0;
    const child = deferred();
    const promise = runWatchMode('/repo', WATCH_FLAGS, {
      isTTY: true,
      env: { TMUX: 'tmux', TMUX_PANE: '%2', OMX_SESSION_ID: 'repair-test',
        [OMX_TMUX_HUD_OWNER_ENV]: '1', [OMX_TMUX_HUD_LEADER_PANE_ENV]: '%1' },
      isOwnerAliveFn: async () => true,
      isSessionAttachedFn: () => true,
      listCurrentWindowPanesFn: () => [{ paneId: '%1', currentCommand: 'codex', startCommand: 'codex', panePid: '101',
        paneLeft: 0, paneTop: 0, paneWidth: 80, paneHeight: 22, paneBottom: 21, windowWidth: 80, windowHeight: 23 }],
      readHudLeaderOwnerFn: () => 'current',
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      readAllStateFn: async () => emptyCtx(),
      renderHudFn: () => { frames += 1; return 'frame'; },
      reconcileTmuxHudFn: async () => { repairs += 1; await child.promise; },
      runAuthorityTickFn: async () => {},
      writeStdout: () => {}, writeStderr: () => {},
      registerSigint: handler => { stop = handler; },
      setIntervalFn: handler => { tick = handler; return {} as ReturnType<typeof setInterval>; },
      clearIntervalFn: () => {},
    });
    await flush();
    for (let index = 0; index < 3; index += 1) { tick?.(); await flush(); }
    assert.equal(repairs, 1);
    assert.equal(frames, 4);
    child.resolve();
    stop?.();
    await promise;
  });

  it('bounds a watcher repair child that never exits so a later tick can repair again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-hud-repair-timeout-'));
    const { entry, readSpawnPids, killSpawned } = await writeHangingReconcileEntry(root);
    let tick: (() => void) | undefined;
    let stop: (() => void) | undefined;
    const promise = runWatchMode('/repo', WATCH_FLAGS, {
      isTTY: true,
      env: { ...repairWatchEnv('repair-timeout-test'), OMX_ENTRY_PATH: entry },
      isOwnerAliveFn: async () => true,
      isSessionAttachedFn: () => true,
      listCurrentWindowPanesFn: () => REPAIR_WATCH_PANES,
      readHudLeaderOwnerFn: () => 'current',
      readHudConfigFn: async () => REPAIR_WATCH_CONFIG,
      readAllStateFn: async () => emptyCtx(),
      renderHudFn: () => 'frame',
      repairTimeoutMs: 1500,
      runAuthorityTickFn: async () => {},
      writeStdout: () => {}, writeStderr: () => {},
      registerSigint: handler => { stop = handler; },
      setIntervalFn: handler => { tick = handler; return {} as ReturnType<typeof setInterval>; },
      clearIntervalFn: () => {},
    });
    try {
      const deadline = Date.now() + 15000;
      let spawns = 0;
      while (spawns < 2 && Date.now() < deadline) {
        tick?.();
        await new Promise((resolve) => setTimeout(resolve, 250));
        spawns = (await readSpawnPids()).length;
      }
      assert.ok(spawns >= 2, `expected a second repair child after the first was killed, saw ${spawns}`);
    } finally {
      stop?.();
      await promise;
      await killSpawned();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('kills the process group of a timed-out repair child, not only the child', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-hud-repair-group-'));
    const { entry, readSpawnPids, readGrandchildPids, killSpawned } = await writeHangingReconcileEntry(root, true);
    let tick: (() => void) | undefined;
    let stop: (() => void) | undefined;
    const promise = runWatchMode('/repo', WATCH_FLAGS, {
      isTTY: true,
      env: { ...repairWatchEnv('repair-group-test'), OMX_ENTRY_PATH: entry },
      isOwnerAliveFn: async () => true,
      isSessionAttachedFn: () => true,
      listCurrentWindowPanesFn: () => REPAIR_WATCH_PANES,
      readHudLeaderOwnerFn: () => 'current',
      readHudConfigFn: async () => REPAIR_WATCH_CONFIG,
      readAllStateFn: async () => emptyCtx(),
      renderHudFn: () => 'frame',
      repairTimeoutMs: 1000,
      runAuthorityTickFn: async () => {},
      writeStdout: () => {}, writeStderr: () => {},
      registerSigint: handler => { stop = handler; },
      setIntervalFn: handler => { tick = handler; return {} as ReturnType<typeof setInterval>; },
      clearIntervalFn: () => {},
    });
    try {
      const deadline = Date.now() + 5000;
      let grandchildren: number[] = [];
      while (grandchildren.length === 0 && Date.now() < deadline) {
        tick?.();
        await new Promise((resolve) => setTimeout(resolve, 100));
        grandchildren = await readGrandchildPids();
      }
      assert.ok(grandchildren.length > 0, 'the repair child never started its grandchild');
      const [child] = await readSpawnPids();
      assert.ok(await waitForExit(child!, 5000), 'the hung repair child was not killed by the timeout');
      assert.ok(await waitForExit(grandchildren[0]!, 5000), 'a subprocess of the repair child outlived the timeout kill');
    } finally {
      stop?.();
      await promise;
      await killSpawned();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not keep a stopped watcher process alive while its repair child hangs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-hud-repair-exit-'));
    const { entry, spawnLog, readSpawnPids, killSpawned } = await writeHangingReconcileEntry(root);
    // The watcher runs in its own process: the test runner's own handles would
    // hide a timer that keeps the event loop alive. The repair timeout is far
    // longer than the test waits, so only an unreferenced timer lets it exit.
    // The script is plain JS, not type-checked: keep its dependencies in step
    // with runWatchMode.
    const script = join(root, 'watch.mjs');
    await writeFile(script, `
import { existsSync } from 'node:fs';
const { runWatchMode } = await import(${JSON.stringify(new URL('../index.js', import.meta.url).href)});
let tick;
let stop;
const done = runWatchMode('/repo', ${JSON.stringify(WATCH_FLAGS)}, {
  isTTY: true,
  env: ${JSON.stringify({ ...repairWatchEnv('repair-exit-test'), OMX_ENTRY_PATH: entry })},
  isOwnerAliveFn: async () => true,
  isSessionAttachedFn: () => true,
  listCurrentWindowPanesFn: () => ${JSON.stringify(REPAIR_WATCH_PANES)},
  readHudLeaderOwnerFn: () => 'current',
  readHudConfigFn: async () => (${JSON.stringify(REPAIR_WATCH_CONFIG)}),
  readAllStateFn: async () => (${JSON.stringify(emptyCtx())}),
  renderHudFn: () => 'frame',
  repairTimeoutMs: 60000,
  runAuthorityTickFn: async () => {},
  writeStdout: () => {}, writeStderr: () => {},
  registerSigint: (handler) => { stop = handler; },
  setIntervalFn: (handler) => { tick = handler; return {}; },
  clearIntervalFn: () => {},
});
const spawnLog = ${JSON.stringify(spawnLog)};
for (let i = 0; i < 100 && !existsSync(spawnLog); i += 1) {
  tick?.();
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!existsSync(spawnLog)) {
  console.error('no repair child was spawned');
  process.exit(2);
}
console.log('stopping');
stop();
await done;
`);
    const watcher = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    watcher.stderr.on('data', (chunk) => { stderr += chunk; });
    // Counted from stop(), so a slow start cannot pass for a watcher kept alive.
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    watcher.stdout.once('data', () => { killTimer = setTimeout(() => watcher.kill('SIGKILL'), 15000); });
    try {
      const [code, signal] = await once(watcher, 'close');
      assert.equal(signal, null, 'watcher process still running 15 s after stop() with a hung repair child');
      assert.equal(code, 0, stderr);
      assert.equal((await readSpawnPids()).length, 1);
    } finally {
      clearTimeout(killTimer);
      watcher.kill('SIGKILL');
      await killSpawned();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves a live cwd when the HUD launch path was reused by another run', () => {
    const resolved = resolveHudWatchCwd('/home/tools/calc', {
      getCwd: () => '/home/tools/calc',
      readProcCwd: () => '/home/tools/calc.noninteractive-aborted-20260527T233204Z',
      realpath: (path) => {
        if (path === '/home/tools/calc') return '/dev/inode/new-calc-run';
        if (path === '/home/tools/calc.noninteractive-aborted-20260527T233204Z') {
          return '/dev/inode/old-aborted-run';
        }
        return path;
      },
    });

    assert.equal(resolved, '/home/tools/calc.noninteractive-aborted-20260527T233204Z');
  });

  it('keeps the launch cwd when live and launch paths resolve to the same directory', () => {
    const resolved = resolveHudWatchCwd('/workspace/link', {
      getCwd: () => '/workspace/link',
      readProcCwd: () => '/workspace/real',
      realpath: () => '/dev/inode/same-project',
    });

    assert.equal(resolved, '/workspace/link');
  });

  it('does not select a proc deleted-cwd marker over the safer launch cwd', () => {
    const resolved = resolveHudWatchCwd('/tmp/omx-doctor-plugin-hook-smoke', {
      getCwd: () => '/tmp/omx-doctor-plugin-hook-smoke',
      readProcCwd: () => '/tmp/omx-doctor-plugin-hook-smoke (deleted)',
      realpath: (path) => {
        if (path === '/tmp/omx-doctor-plugin-hook-smoke') return '/dev/inode/reused-safe-path';
        throw new Error(`deleted marker path should not be resolved: ${path}`);
      },
    });

    assert.equal(resolved, '/tmp/omx-doctor-plugin-hook-smoke');
  });

  it('follows a live cwd whose literal name ends with the deleted marker text', () => {
    const resolved = resolveHudWatchCwd('/tmp/stale-launch', {
      getCwd: () => '/tmp/live workspace (deleted)',
      readProcCwd: () => '/tmp/live workspace (deleted)',
      realpath: (path) => {
        if (path === '/tmp/stale-launch') return '/dev/inode/stale-launch';
        if (path === '/tmp/live workspace (deleted)') return '/dev/inode/live-literal-marker';
        return path;
      },
    });

    assert.equal(resolved, '/tmp/live workspace (deleted)');
  });

  it('follows a live literal deleted-marker cwd when process cwd is an alias to the same directory', () => {
    const resolved = resolveHudWatchCwd('/tmp/stale-launch', {
      getCwd: () => '/tmp/link-to-live',
      readProcCwd: () => '/tmp/live workspace (deleted)',
      realpath: (path) => {
        if (path === '/tmp/stale-launch') return '/dev/inode/stale-launch';
        if (path === '/tmp/link-to-live') return '/dev/inode/live-literal-marker';
        if (path === '/tmp/live workspace (deleted)') return '/dev/inode/live-literal-marker';
        return path;
      },
    });

    assert.equal(resolved, '/tmp/live workspace (deleted)');
  });

  it('reads HUD state from the resolved live cwd on every watch frame', async () => {
    const seenConfigCwds: string[] = [];
    const seenStateCwds: string[] = [];
    const seenAuthorityCwds: string[] = [];
    let sigintHandler: (() => void) | undefined;

    const promise = runWatchMode('/home/tools/calc', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      resolveWatchCwdFn: () => '/home/tools/calc.noninteractive-aborted-20260527T233204Z',
      readHudConfigFn: async (cwd) => {
        seenConfigCwds.push(cwd);
        return { preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } };
      },
      readAllStateFn: async (cwd) => {
        seenStateCwds.push(cwd);
        return emptyCtx();
      },
      renderHudFn: () => 'frame',
      runAuthorityTickFn: async ({ cwd }) => { seenAuthorityCwds.push(cwd); },
      writeStdout: () => {},
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: () => ({}) as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });

    await flush();
    sigintHandler?.();
    await promise;

    assert.deepEqual(seenConfigCwds, ['/home/tools/calc.noninteractive-aborted-20260527T233204Z']);
    assert.deepEqual(seenStateCwds, ['/home/tools/calc.noninteractive-aborted-20260527T233204Z']);
    assert.deepEqual(seenAuthorityCwds, ['/home/tools/calc.noninteractive-aborted-20260527T233204Z']);
  });

  it('restores cursor and clears interval on SIGINT', async () => {
    const writes: string[] = [];
    let sigintHandler: (() => void) | undefined;
    let clearCount = 0;

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      readAllStateFn: async (_cwd, config) => ({ ...emptyCtx(), gitBranch: config?.git.display ?? null }),
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: (ctx) => `frame:${ctx.gitBranch}`,
      writeStdout: (text) => { writes.push(text); },
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: () => ({}) as ReturnType<typeof setInterval>,
      clearIntervalFn: () => { clearCount += 1; },
    });

    await flush();
    assert.ok(sigintHandler, 'SIGINT handler should be registered');

    sigintHandler?.();
    await promise;

    assert.equal(clearCount, 1);
    assert.ok(writes.some((chunk) => chunk.includes('\x1b[?25l')), 'cursor should be hidden in watch mode');
    assert.ok(writes.some((chunk) => chunk.includes('\x1b[?25h\x1b[2J\x1b[H')), 'cursor should be restored on SIGINT');
    assert.ok(writes.some((chunk) => chunk.includes('frame:repo-branch')));
  });

  it('coalesces ticks so slow renders do not overlap', async () => {
    const writes: string[] = [];
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;

    let callCount = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const firstRenderGate = deferred();
    const firstReadStarted = deferred();
    const secondReadStarted = deferred();

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      readAllStateFn: async (_cwd, config) => {
        callCount += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (callCount === 1) {
            firstReadStarted.resolve();
            await firstRenderGate.promise;
          } else if (callCount === 2) {
            secondReadStarted.resolve();
          }
          return emptyCtx();
        } finally {
          inFlight -= 1;
        }
      },
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      writeStdout: (text) => { writes.push(text); },
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: (handler) => {
        timerTick = handler;
        return ({}) as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });

    await flush();
    assert.ok(timerTick, 'interval tick should be registered');
    await withTimeout(firstReadStarted.promise, 'first render should start before exercising queued ticks');

    // Trigger multiple ticks while first render is deterministically blocked.
    timerTick?.();
    timerTick?.();

    firstRenderGate.resolve();
    await withTimeout(secondReadStarted.promise, 'queued rerender should start after first render is released');

    sigintHandler?.();
    await promise;

    assert.equal(maxInFlight, 1);
    assert.equal(callCount, 2, 'multiple overlapping ticks should collapse to one queued rerender');
  });


  it('renders combined ultragoal and team state as one stable watch frame', async () => {
    const writes: string[] = [];
    let sigintHandler: (() => void) | undefined;

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      readAllStateFn: async () => ({
        ...emptyCtx(),
        team: { active: true, agent_count: 2, team_name: 'hud-fix' },
        ultragoal: {
          active: true,
          status: 'in_progress',
          total: 3,
          complete: 1,
          pending: 1,
          inProgress: 1,
          failed: 0,
          reviewBlocked: 0,
          needsUserDecision: 0,
          progressTotal: 3,
          activeGoal: {
            id: 'G002-team',
            title: 'Team HUD summary',
            objective: 'avoid duplicated focused tmux HUD content',
            status: 'in_progress',
            index: 2,
          },
          nextGoals: [{
            id: 'G003-next',
            title: 'Next team checkpoint',
            objective: 'keep combined team ultragoal compact',
            status: 'pending',
            index: 3,
          }],
        },
      }),
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: renderHud,
      writeStdout: (text) => { writes.push(text); },
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: () => ({}) as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });

    await flush();
    sigintHandler?.();
    await promise;

    const plain = writes.join('').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    assert.equal((plain.match(/team:hud-fix \(2 workers\)/g) ?? []).length, 1);
    assert.equal((plain.match(/ultragoal 1\/3/g) ?? []).length, 1);
    assert.ok(plain.includes('ultragoal 1/3 + team:hud-fix (2 workers)'));
    assert.ok(plain.includes('G002-team: Team HUD summary'));
    assert.ok(!plain.includes('G003-next: Next team checkpoint (pending)'));
  });

  it('passes adaptive active-ultragoal line budget to watch rendering', async () => {
    const maxLines: Array<number | undefined> = [];
    let sigintHandler: (() => void) | undefined;

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      readAllStateFn: async () => ({
        ...emptyCtx(),
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
      }),
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: (_ctx, _preset, options) => {
        maxLines.push(options?.maxLines);
        return 'frame';
      },
      writeStdout: () => {},
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: () => ({}) as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });

    await flush();
    sigintHandler?.();
    await promise;

    assert.deepEqual(maxLines, [3]);
  });

  it('expands for each worker, refreshes reported status, and shrinks after team completion', async () => {
    const frames: string[] = [];
    const heights: number[] = [];
    let tick: (() => void) | undefined;
    let stop: (() => void) | undefined;
    let frame = 0;
    const workers = Array.from({ length: 15 }, (_, i) => ({ name: `worker-${i + 1}`, state: 'working' as const }));
    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: { TMUX: 'tmux', TMUX_PANE: '%2', OMX_SESSION_ID: 'watch-test', [OMX_TMUX_HUD_OWNER_ENV]: '1', [OMX_TMUX_HUD_LEADER_PANE_ENV]: '%1' },
      listCurrentWindowPanesFn: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex', panePid: '101', sessionId: '$1', windowId: '@1',
          paneLeft: 0, paneTop: 0, paneWidth: 80, paneHeight: frame === 1 ? 14 : 50,
          paneBottom: frame === 1 ? 13 : 49, windowWidth: 80, windowHeight: frame === 1 ? 24 : 70 },
        { paneId: '%2', currentCommand: 'node', panePid: '102', sessionId: '$1', windowId: '@1',
          startCommand: "OMX_TMUX_HUD_OWNER='1' OMX_SESSION_ID='watch-test' OMX_TMUX_HUD_LEADER_PANE='%1' node omx hud --watch",
          paneLeft: 0, paneTop: frame === 1 ? 15 : 51, paneWidth: 80, paneHeight: frame === 1 ? 9 : 19,
          paneBottom: frame === 1 ? 23 : 69, windowWidth: 80, windowHeight: frame === 1 ? 24 : 70 },
      ],
      isSessionAttachedFn: () => true,
      isOwnerAliveFn: async () => true,
      readHudLeaderOwnerFn: () => 'current',
      readAllStateFn: async () => ({ ...emptyCtx(), team: frame === 3 ? null : {
        active: true, team_name: 'checkout', workers: workers.map(worker => ({ ...worker, state: frame === 0 ? 'working' : 'done' })),
      } }),
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: renderHud,
      writeStdout: text => { frames.push(text); },
      writeStderr: () => {},
      registerSigint: handler => { stop = handler; },
      setIntervalFn: handler => { tick = handler; return {} as ReturnType<typeof setInterval>; },
      clearIntervalFn: () => {},
      resizeTmuxPaneFn: (_pane, height) => { heights.push(height); return true; },
      clearTmuxPaneHistoryFn: () => true,
      registerHudResizeHookFn: () => true,
      readHudHookHealthFn: () => 'healthy',
      reconcileTmuxHudFn: async () => {},
      runAuthorityTickFn: async () => {},
    });
    try {
      await flush();
      assert.ok(frames.at(-1)?.includes('worker-15 working'), JSON.stringify({ frames, heights }));
      frame = 1;
      tick?.();
      await flush();
      assert.ok(frames.at(-1)?.includes('+6 workers'));
      assert.ok(!frames.at(-1)?.includes('worker-15 done'));
      frame = 2;
      tick?.();
      await flush();
      assert.ok(frames.at(-1)?.includes('worker-15 done'));
      frame = 3;
      tick?.();
      await flush();
      assert.ok(!frames.at(-1)?.includes('worker-15'));
      assert.deepEqual(heights, [17, 11, 17, 2]);
    } finally {
      stop?.();
      await promise;
    }
  });

  it('passes compact no-ultragoal line budget to watch rendering', async () => {
    const maxLines: Array<number | undefined> = [];
    let sigintHandler: (() => void) | undefined;

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      readAllStateFn: async () => emptyCtx(),
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: (_ctx, _preset, options) => {
        maxLines.push(options?.maxLines);
        return 'frame';
      },
      writeStdout: () => {},
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: () => ({}) as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });

    await flush();
    sigintHandler?.();
    await promise;

    assert.deepEqual(maxLines, [2]);
  });

  it('does not write an extra terminal row beyond the rendered watch frame', async () => {
    const writes: string[] = [];
    let sigintHandler: (() => void) | undefined;

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      readAllStateFn: async () => emptyCtx(),
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'line-one\nline-two',
      writeStdout: (text) => { writes.push(text); },
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: () => ({}) as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });

    await flush();
    sigintHandler?.();
    await promise;

    assert.ok(writes.some((chunk) => chunk.includes('line-one\nline-two\x1b[K\x1b[J')));
    assert.ok(!writes.some((chunk) => chunk.includes('line-two\x1b[K\n\x1b[J')));
  });

  it('resizes an OMX-owned running HUD pane when the adaptive budget changes', async () => {
    const resized: Array<{ paneId: string; heightLines: number }> = [];
    const registered: Array<{ hudPaneId: string; leaderPaneId: string | undefined; heightLines: number }> = [];
    const events: string[] = [];
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    let callCount = 0;
    const secondReadStarted = deferred();

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {
        TMUX: '1',
        TMUX_PANE: '%2',
        OMX_SESSION_ID: 'watch-test',
        [OMX_TMUX_HUD_OWNER_ENV]: '1',
        [OMX_TMUX_HUD_LEADER_PANE_ENV]: '%1',
      },
      listCurrentWindowPanesFn: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex', panePid: '101', sessionId: '$1', windowId: '@1',
          paneLeft: 0, paneTop: 0, paneWidth: 80, paneHeight: 20, paneBottom: 19, windowWidth: 80, windowHeight: 24 },
        { paneId: '%2', currentCommand: 'node', panePid: '102', sessionId: '$1', windowId: '@1',
          startCommand: "OMX_TMUX_HUD_OWNER='1' OMX_SESSION_ID='watch-test' OMX_TMUX_HUD_LEADER_PANE='%1' node omx hud --watch",
          paneLeft: 0, paneTop: 21, paneWidth: 80, paneHeight: callCount === 1 ? 3 : 2,
          paneBottom: callCount === 1 ? 23 : 22, windowWidth: 80, windowHeight: 24 },
      ],
      readHudHookHealthFn: () => 'healthy',
      readHudLeaderOwnerFn: () => 'current',
      readAllStateFn: async () => {
        callCount += 1;
        if (callCount === 2) secondReadStarted.resolve();
        return {
          ...emptyCtx(),
          ultragoal: callCount === 1 ? null : {
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
        };
      },
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      writeStdout: (text) => { events.push(`write:${text}`); },
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: (handler) => {
        timerTick = handler;
        return ({}) as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
      resizeTmuxPaneFn: (paneId, heightLines) => {
        events.push(`resize:${heightLines}`);
        resized.push({ paneId, heightLines });
        return true;
      },
      clearTmuxPaneHistoryFn: (paneId) => {
        events.push(`history:${paneId}`);
        return true;
      },
      registerHudResizeHookFn: (hudPaneId, leaderPaneId, heightLines) => {
        events.push(`hook:${heightLines}`);
        registered.push({ hudPaneId, leaderPaneId, heightLines });
        return true;
      },
      reconcileTmuxHudFn: async () => {},
    });

    await flush();
    timerTick?.();
    await withTimeout(secondReadStarted.promise, 'second render should observe active ultragoal');
    sigintHandler?.();
    await promise;

    assert.deepEqual(resized, [
      { paneId: '%2', heightLines: 2 },
      { paneId: '%2', heightLines: 3 },
    ]);
    assert.deepEqual(registered, [
      { hudPaneId: '%2', leaderPaneId: '%1', heightLines: 2 },
      { hudPaneId: '%2', leaderPaneId: '%1', heightLines: 3 },
    ]);
    const secondClear = events.findIndex((event, index) => index > 0 && event === 'write:\u001b[3J\u001b[2J\u001b[H');
    const secondResize = events.indexOf('resize:3');
    const secondFrame = events.findIndex((event, index) => index > secondResize && event.includes('frame'));
    assert.ok(secondClear >= 0 && secondClear < secondResize, 'the new frame must clear before pane reflow');
    assert.ok(secondFrame > secondResize, 'the new frame must publish after pane reflow');
    const secondHistory = events.findIndex((event, index) => index > secondResize && event === 'history:%2');
    assert.ok(secondHistory > secondResize, 'reflowed HUD history must be cleared before frame publication');
  });

  it('runs authority tick after each rendered frame', async () => {
    const writes: string[] = [];
    let sigintHandler: (() => void) | undefined;
    let authorityCalls = 0;

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      readAllStateFn: async () => emptyCtx(),
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      writeStdout: (text) => { writes.push(text); },
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: () => ({}) as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
      runAuthorityTickFn: async ({ cwd }) => { authorityCalls += 1; assert.equal(cwd, '/tmp'); },
    });

    await flush();
    sigintHandler?.();
    await promise;

    assert.equal(authorityCalls, 1);
    assert.ok(writes.some((chunk) => chunk.includes('frame')));
  });

  it('keeps rendering when the authority tick fails after a frame', async () => {
    const writes: string[] = [];
    const errors: string[] = [];
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    let renderCount = 0;
    let authorityCalls = 0;
    const firstAuthorityAttempted = deferred();
    const secondReadStarted = deferred();

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      readAllStateFn: async () => {
        renderCount += 1;
        if (renderCount === 2) secondReadStarted.resolve();
        return emptyCtx();
      },
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      writeStdout: (text) => { writes.push(text); },
      writeStderr: (text) => { errors.push(text); },
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: (handler) => {
        timerTick = handler;
        return ({}) as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
      runAuthorityTickFn: async () => {
        authorityCalls += 1;
        if (authorityCalls === 1) {
          firstAuthorityAttempted.resolve();
          throw new Error('dist is rebuilding');
        }
      },
    });

    await withTimeout(firstAuthorityAttempted.promise, 'first authority tick should run');
    await flush();
    assert.equal(process.exitCode, undefined);
    assert.ok(errors.some((line) => line.includes('HUD watch authority tick failed: dist is rebuilding')));

    timerTick?.();
    await withTimeout(secondReadStarted.promise, 'watch should render again after authority tick failure');
    sigintHandler?.();
    await promise;

    assert.equal(renderCount, 2);
    assert.equal(authorityCalls, 2);
    assert.equal(process.exitCode, undefined);
    assert.equal((writes.join('').match(/frame/g) ?? []).length, 2);
    assert.ok(!errors.some((line) => line.includes('HUD watch render failed')));
  });

  it('handles render failures gracefully and restores terminal state', async () => {
    const writes: string[] = [];
    const errors: string[] = [];
    let clearCount = 0;

    await runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      readAllStateFn: async (_cwd, config) => {
        throw new Error('boom');
      },
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      writeStdout: (text) => { writes.push(text); },
      writeStderr: (text) => { errors.push(text); },
      registerSigint: () => {},
      setIntervalFn: () => ({}) as ReturnType<typeof setInterval>,
      clearIntervalFn: () => { clearCount += 1; },
    });

    assert.equal(clearCount, 1);
    assert.equal(process.exitCode, 1);
    assert.ok(errors.some((line) => line.includes('HUD watch render failed: boom')));
    assert.ok(writes.some((chunk) => chunk.includes('\x1b[?25h\x1b[2J\x1b[H')));
  });
});

describe('hudCommand --tmux', () => {
  for (const keepValidPane of [true, false]) {
    it(`selects a topology-valid HUD before cleanup and measures fresh geometry (keeper=${keepValidPane})`, async () => {
      const tmp = await mkdtemp(join(tmpdir(), 'omx-hud-launch-keeper-'));
      const logPath = join(tmp, 'tmux.log');
      const panePath = join(tmp, 'panes.json');
      const fakeBin = join(tmp, 'bin');
      const root = join(tmp, '.omx', 'state');
      const sessionDir = join(root, 'sessions', 'sess-a');
      const teamDir = join(root, 'team', 'alpha');
      await Promise.all([mkdir(fakeBin), mkdir(sessionDir, { recursive: true }), mkdir(teamDir, { recursive: true })]);
      await writeFile(join(root, 'session.json'), JSON.stringify({ session_id: 'sess-a', cwd: tmp, state_root: root }));
      await writeFile(join(sessionDir, 'team-state.json'), JSON.stringify({ active: true, team_name: 'alpha' }));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({ active: true, skill: 'team', phase: 'team-exec', session_id: 'sess-a',
        active_skills: [{ skill: 'team', phase: 'team-exec', active: true, session_id: 'sess-a' }] }));
      await writeFile(join(teamDir, 'config.json'), JSON.stringify({ name: 'alpha', workers: Array.from({ length: 20 }, (_, i) => ({ name: `worker-${i + 1}` })) }));
      const command = "env OMX_SESSION_ID='sess-a' OMX_TMUX_HUD_OWNER='1' OMX_TMUX_HUD_LEADER_PANE='%1' node omx hud --watch";
      await writeFile(panePath, JSON.stringify([
        ['%1', 'codex', 0, 0, 80, 12, 11, 160, 50, 'codex', tmp, 0, 1001],
        ['%2', 'node', 81, 0, 79, 50, 49, 160, 50, command, tmp, 0, 1002],
        ...(keepValidPane ? [['%3', 'node', 0, 13, 80, 3, 15, 160, 50, command, tmp, 0, 1003]] : []),
      ]));
      const shim = join(fakeBin, 'tmux');
      await writeFile(shim, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, args.join(' ') + '\\n');
let panes = JSON.parse(fs.readFileSync(${JSON.stringify(panePath)}, 'utf8'));
if (args[0] === 'list-panes') {
  console.log(panes.map(pane => args.at(-1) === '#{pane_id}' ? pane[0] : pane.join('\\x1f')).join('\\n'));
} else if (args[0] === 'kill-pane') {
  panes = panes.filter(pane => pane[0] !== args[2]);
  panes[0][5] = 8;
  fs.writeFileSync(${JSON.stringify(panePath)}, JSON.stringify(panes));
} else if (args[0] === 'display-message') {
  console.log('$7\\t@3');
}
`);
      await chmod(shim, 0o755);
      const keys = ['PATH', 'TMUX', 'TMUX_PANE', 'OMX_SESSION_ID', 'OMX_ROOT', 'OMX_STATE_ROOT', 'OMX_TEAM_STATE_ROOT'];
      const previousEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
      const previousLog = console.log;
      try {
        process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ''}`;
        process.env.TMUX = 'private-test';
        process.env.TMUX_PANE = '%1';
        process.env.OMX_SESSION_ID = 'sess-a';
        process.env.OMX_STATE_ROOT = tmp;
        delete process.env.OMX_ROOT;
        delete process.env.OMX_TEAM_STATE_ROOT;
        console.log = () => {};
        await hudCommand(['--tmux'], { cwd: tmp });
        const log = await readFile(logPath, 'utf8');
        assert.match(log, /kill-pane -t %2/);
        assert.doesNotMatch(log, /kill-pane -t %3|resize-pane -t %2/);
        if (keepValidPane) {
          assert.match(log, /resize-pane -t %3 -y 5/);
          assert.doesNotMatch(log, /split-window/);
        } else {
          assert.match(log, /split-window -v -l 3 -t %1/);
        }
      } finally {
        console.log = previousLog;
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await rm(tmp, { recursive: true, force: true });
      }
    });
  }

  it('does not reuse duplicate HUD snapshots without complete current authority', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'omx-hud-tmux-duplicate-test-'));
    const logPath = join(tmp, 'tmux.log');
    const fakeBin = join(tmp, 'bin');
    await mkdir(fakeBin);
    const tmuxPath = join(fakeBin, 'tmux');
    await writeFile(tmuxPath, `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$1" == "display-message" && "$*" == *'#{session_id}'* ]]; then
  printf '$7\t@3\n'
  exit 0
fi
if [[ "$1" == "list-panes" && "\${!#}" == '#{pane_id}' ]]; then
  printf '%%1\n%%2\n%%3\n'
  exit 0
fi
if [[ "$1" == "list-panes" ]]; then
  printf '%%1\\037zsh\\0370\\0370\\037160\\03740\\03739\\037160\\03740\\037zsh\\037/repo\\0370\\0371001\n'
  printf '%b\n' "%%2\\037node\\0370\\03737\\037160\\0373\\03739\\037160\\03740\\037exec env OMX_SESSION_ID='sess-a' OMX_TMUX_HUD_OWNER='1' OMX_TMUX_HUD_LEADER_PANE='%1' /node /repo/dist/cli/omx.js hud --watch\\037/repo\\0370\\0371002"
  printf '%b\n' "%%3\\037node\\0370\\03734\\037160\\0373\\03736\\037160\\03740\\037exec env OMX_SESSION_ID='sess-a' OMX_TMUX_HUD_OWNER='1' OMX_TMUX_HUD_LEADER_PANE='%1' /node /repo/dist/cli/omx.js hud --watch\\037/repo\\0370\\0371003"
  exit 0
fi
if [[ "$1" == "resize-pane" || "$1" == "set-hook" || "$1" == "kill-pane" ]]; then
  exit 0
fi
if [[ "$1" == "split-window" ]]; then
  echo '%9'
  exit 0
fi
exit 0
`);
    await chmod(tmuxPath, 0o755);

    const previousEnv = {
      PATH: process.env.PATH,
      TMUX: process.env.TMUX,
      TMUX_PANE: process.env.TMUX_PANE,
      OMX_SESSION_ID: process.env.OMX_SESSION_ID,
    };
    const previousLog = console.log;
    const logs: string[] = [];
    try {
      process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ''}`;
      process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
      process.env.TMUX_PANE = '%1';
      process.env.OMX_SESSION_ID = 'sess-a';
      console.log = (message?: unknown) => { logs.push(String(message ?? '')); };

      await hudCommand(['--tmux']);

      const tmuxLog = await readFile(logPath, 'utf8');
      assert.match(tmuxLog, /list-panes -t %1 -F #\{pane_id\}/);
      assert.match(
        tmuxLog,
        /list-panes -t %1 -F #\{pane_id\}\x1f#\{pane_current_command\}\x1f#\{pane_left\}\x1f#\{pane_top\}\x1f#\{pane_width\}\x1f#\{pane_height\}\x1f#\{pane_bottom\}\x1f#\{window_width\}\x1f#\{window_height\}\x1f#\{session_id\}\x1f#\{window_id\}\x1f#\{pane_dead\}\x1f#\{pane_pid\}\x1f#\{pane_start_command\}\x1f#\{pane_current_path\}/,
      );
      assert.doesNotMatch(tmuxLog, /kill-pane -t %3/);
      assert.doesNotMatch(tmuxLog, /resize-pane -t %2/);
      assert.match(tmuxLog, /split-window -v -l 2 -t %1/);
      assert.equal(logs.some((line) => line.includes('Removed duplicate HUD panes')), false);
    } finally {
      console.log = previousLog;
      for (const [key, value] of Object.entries(previousEnv)) {
        if (typeof value === 'string') process.env[key] = value;
        else delete process.env[key];
      }
      await rm(tmp, { recursive: true, force: true });
    }
  });
  it('does not reuse a session HUD snapshot without complete current authority', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'omx-hud-tmux-test-'));
    const logPath = join(tmp, 'tmux.log');
    const fakeBin = join(tmp, 'bin');
    await mkdir(fakeBin);
    const tmuxPath = join(fakeBin, 'tmux');
    await writeFile(tmuxPath, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$1" == "display-message" && "$*" == *'#{pane_id}'* ]]; then
  echo '%1'
  exit 0
fi
if [[ "$1" == "display-message" && "$*" == *'#{session_id}'* ]]; then
  printf '$7\\t@3\\n'
  exit 0
fi
if [[ "$1" == "list-panes" && "\${!#}" == '#{pane_id}' ]]; then
  printf '%%1\\n%%2\\n'
  exit 0
fi
if [[ "$1" == "list-panes" ]]; then
  printf '%%1\\037codex\\0370\\0370\\037160\\03737\\03736\\037160\\03740\\037codex\\037/repo\\0370\\0371001\\n'
  printf '%b\n' "%%2\\037node\\0370\\03737\\037160\\0373\\03739\\037160\\03740\\037exec env OMX_SESSION_ID='sess-a' OMX_TMUX_HUD_OWNER='1' OMX_TMUX_HUD_LEADER_PANE='%1' /node /repo/dist/cli/omx.js hud --watch\\037/repo\\0370\\0371002"
  exit 0
fi
if [[ "$1" == "resize-pane" || "$1" == "set-hook" ]]; then
  exit 0
fi
if [[ "$1" == "split-window" ]]; then
  echo '%9'
  exit 0
fi
exit 0
`);
    await chmod(tmuxPath, 0o755);

    const previousEnv = {
      PATH: process.env.PATH,
      TMUX: process.env.TMUX,
      TMUX_PANE: process.env.TMUX_PANE,
      OMX_SESSION_ID: process.env.OMX_SESSION_ID,
    };
    const previousLog = console.log;
    const logs: string[] = [];
    try {
      process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ''}`;
      process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
      process.env.TMUX_PANE = '';
      process.env.OMX_SESSION_ID = 'sess-a';
      console.log = (message?: unknown) => { logs.push(String(message ?? '')); };

      await hudCommand(['--tmux']);

      const tmuxLog = await readFile(logPath, 'utf8');
      assert.match(tmuxLog, /display-message -p #\{pane_id\}/);
      assert.match(tmuxLog, /list-panes -t %1 -F #\{pane_id\}/);
      assert.match(
        tmuxLog,
        /list-panes -t %1 -F #\{pane_id\}\x1f#\{pane_current_command\}\x1f#\{pane_left\}\x1f#\{pane_top\}\x1f#\{pane_width\}\x1f#\{pane_height\}\x1f#\{pane_bottom\}\x1f#\{window_width\}\x1f#\{window_height\}\x1f#\{session_id\}\x1f#\{window_id\}\x1f#\{pane_dead\}\x1f#\{pane_pid\}\x1f#\{pane_start_command\}\x1f#\{pane_current_path\}/,
      );
      assert.doesNotMatch(tmuxLog, /resize-pane -t %2/);
      assert.match(tmuxLog, /split-window -v -l 2 -t %1/);
      assert.equal(logs.some((line) => line.includes('Reused existing HUD pane')), false);
    } finally {
      console.log = previousLog;
      for (const [key, value] of Object.entries(previousEnv)) {
        if (typeof value === 'string') process.env[key] = value;
        else delete process.env[key];
      }
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
