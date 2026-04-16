import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDuplicateCoordinator,
  resolveDuplicateRegistryDir,
  type DuplicateCoordinatorDeps,
} from '../duplicate-coordination.js';

const PARENT_PID = 55;
const SELF_PID = 101;
const SERVER_NAME = 'state';
const PRE_TRAFFIC_GRACE_MS = 25;

type SignalProcess = DuplicateCoordinatorDeps['signalProcess'];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSignalProcess(alivePids: Iterable<number> | Set<number>): NonNullable<SignalProcess> {
  const liveSet = alivePids instanceof Set ? alivePids : new Set(alivePids);
  return ((pid: number) => {
    if (liveSet.has(pid)) return true;
    const error = Object.assign(new Error(`pid ${pid} missing`), { code: 'ESRCH' });
    throw error;
  }) as NonNullable<SignalProcess>;
}

class FakeWatcher {
  closed = false;

  constructor(
    private readonly onChange: () => void,
    private readonly onError: (error: unknown) => void,
  ) {}

  close(): void {
    this.closed = true;
  }

  emitChange(): void {
    if (this.closed) return;
    this.onChange();
  }

  emitError(error: unknown = new Error('watch failed')): void {
    if (this.closed) return;
    this.onError(error);
  }
}

function createWatchHarness(): {
  watchers: FakeWatcher[];
  watchDirectory: NonNullable<DuplicateCoordinatorDeps['watchDirectory']>;
} {
  const watchers: FakeWatcher[] = [];
  return {
    watchers,
    watchDirectory: (_directory, onChange, onError) => {
      const watcher = new FakeWatcher(onChange, onError);
      watchers.push(watcher);
      return watcher;
    },
  };
}

async function withTmpDir(run: (tmpRoot: string) => Promise<void>): Promise<void> {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'omx-dup-coord-'));
  try {
    await run(tmpRoot);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

function getRegistryDir(tmpRoot: string): string {
  return resolveDuplicateRegistryDir({
    parentPid: PARENT_PID,
    serverName: SERVER_NAME,
    tmpDir: tmpRoot,
  });
}

function getPresencePath(tmpRoot: string, pid: number): string {
  return join(getRegistryDir(tmpRoot), `presence-${pid}.json`);
}

function getOwnerPath(tmpRoot: string): string {
  return join(getRegistryDir(tmpRoot), 'owner.json');
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

describe('duplicate coordination runtime registry', () => {
  it('writes self presence at startup and removes it on dispose', async () => {
    await withTmpDir(async (tmpRoot) => {
      const watchHarness = createWatchHarness();
      const coordinator = await createDuplicateCoordinator({
        parentPid: PARENT_PID,
        selfPid: SELF_PID,
        serverName: SERVER_NAME,
        lifecycleDebugEnabled: false,
        shutdown: () => {},
      }, {
        tmpDir: tmpRoot,
        signalProcess: createSignalProcess([SELF_PID]),
        watchDirectory: watchHarness.watchDirectory,
      });

      const presencePath = getPresencePath(tmpRoot, SELF_PID);
      assert.deepEqual(await readJson(presencePath), {
        pid: SELF_PID,
        parentPid: PARENT_PID,
        serverName: SERVER_NAME,
        createdAtMs: (await readJson(presencePath) as { createdAtMs: number }).createdAtMs,
      });

      await coordinator.dispose();
      await assert.rejects(() => stat(presencePath));
    });
  });

  it('garbage-collects stale presence and owner records on startup', async () => {
    await withTmpDir(async (tmpRoot) => {
      const registryDir = getRegistryDir(tmpRoot);
      await mkdir(registryDir, { recursive: true });
      await writeFile(getPresencePath(tmpRoot, 140), JSON.stringify({
        pid: 140,
        parentPid: PARENT_PID,
        serverName: SERVER_NAME,
        createdAtMs: 1,
      }), 'utf8');
      await writeFile(getOwnerPath(tmpRoot), JSON.stringify({
        pid: 140,
        parentPid: PARENT_PID,
        serverName: SERVER_NAME,
        claimedAtMs: 2,
      }), 'utf8');

      const coordinator = await createDuplicateCoordinator({
        parentPid: PARENT_PID,
        selfPid: SELF_PID,
        serverName: SERVER_NAME,
        lifecycleDebugEnabled: false,
        shutdown: () => {},
      }, {
        tmpDir: tmpRoot,
        signalProcess: createSignalProcess([SELF_PID]),
        watchDirectory: createWatchHarness().watchDirectory,
      });

      await assert.rejects(() => stat(getPresencePath(tmpRoot, 140)));
      await assert.rejects(() => stat(getOwnerPath(tmpRoot)));
      await coordinator.dispose();
    });
  });

  it('self-exits after the grace window when a newer live sibling exists before traffic', async () => {
    await withTmpDir(async (tmpRoot) => {
      const registryDir = getRegistryDir(tmpRoot);
      await mkdir(registryDir, { recursive: true });
      await writeFile(getPresencePath(tmpRoot, 140), JSON.stringify({
        pid: 140,
        parentPid: PARENT_PID,
        serverName: SERVER_NAME,
        createdAtMs: 1,
      }), 'utf8');

      const shutdownReasons: string[] = [];
      const coordinator = await createDuplicateCoordinator({
        parentPid: PARENT_PID,
        selfPid: SELF_PID,
        serverName: SERVER_NAME,
        lifecycleDebugEnabled: false,
        shutdown: (reason) => {
          shutdownReasons.push(reason);
        },
        preTrafficGraceMs: PRE_TRAFFIC_GRACE_MS,
      }, {
        tmpDir: tmpRoot,
        signalProcess: createSignalProcess([SELF_PID, 140]),
        watchDirectory: createWatchHarness().watchDirectory,
      });

      await delay(PRE_TRAFFIC_GRACE_MS + 40);
      assert.deepEqual(shutdownReasons, ['superseded_duplicate_before_traffic']);
      await coordinator.dispose();
    });
  });

  it('self-exits after the grace window when a live foreign owner exists before traffic', async () => {
    await withTmpDir(async (tmpRoot) => {
      const registryDir = getRegistryDir(tmpRoot);
      await mkdir(registryDir, { recursive: true });
      await writeFile(getOwnerPath(tmpRoot), JSON.stringify({
        pid: 220,
        parentPid: PARENT_PID,
        serverName: SERVER_NAME,
        claimedAtMs: 1,
      }), 'utf8');

      const shutdownReasons: string[] = [];
      const coordinator = await createDuplicateCoordinator({
        parentPid: PARENT_PID,
        selfPid: SELF_PID,
        serverName: SERVER_NAME,
        lifecycleDebugEnabled: false,
        shutdown: (reason) => {
          shutdownReasons.push(reason);
        },
        preTrafficGraceMs: PRE_TRAFFIC_GRACE_MS,
      }, {
        tmpDir: tmpRoot,
        signalProcess: createSignalProcess([SELF_PID, 220]),
        watchDirectory: createWatchHarness().watchDirectory,
      });

      await delay(PRE_TRAFFIC_GRACE_MS + 40);
      assert.deepEqual(shutdownReasons, ['superseded_duplicate_before_traffic']);
      await coordinator.dispose();
    });
  });

  it('re-evaluates duplicate state on watcher events before first traffic', async () => {
    await withTmpDir(async (tmpRoot) => {
      const watchHarness = createWatchHarness();
      const shutdownReasons: string[] = [];
      const alivePids = new Set([SELF_PID]);
      const coordinator = await createDuplicateCoordinator({
        parentPid: PARENT_PID,
        selfPid: SELF_PID,
        serverName: SERVER_NAME,
        lifecycleDebugEnabled: false,
        shutdown: (reason) => {
          shutdownReasons.push(reason);
        },
        preTrafficGraceMs: PRE_TRAFFIC_GRACE_MS,
      }, {
        tmpDir: tmpRoot,
        signalProcess: createSignalProcess(alivePids),
        watchDirectory: watchHarness.watchDirectory,
      });

      alivePids.add(140);
      await writeFile(getPresencePath(tmpRoot, 140), JSON.stringify({
        pid: 140,
        parentPid: PARENT_PID,
        serverName: SERVER_NAME,
        createdAtMs: 1,
      }), 'utf8');
      watchHarness.watchers[0]?.emitChange();

      await delay(PRE_TRAFFIC_GRACE_MS + 40);
      assert.deepEqual(shutdownReasons, ['superseded_duplicate_before_traffic']);
      await coordinator.dispose();
    });
  });

  it('closes the watcher after first traffic and never duplicate-exits afterward', async () => {
    await withTmpDir(async (tmpRoot) => {
      const watchHarness = createWatchHarness();
      const shutdownReasons: string[] = [];
      const coordinator = await createDuplicateCoordinator({
        parentPid: PARENT_PID,
        selfPid: SELF_PID,
        serverName: SERVER_NAME,
        lifecycleDebugEnabled: false,
        shutdown: (reason) => {
          shutdownReasons.push(reason);
        },
        preTrafficGraceMs: PRE_TRAFFIC_GRACE_MS,
      }, {
        tmpDir: tmpRoot,
        signalProcess: createSignalProcess([SELF_PID, 140]),
        watchDirectory: watchHarness.watchDirectory,
      });

      await coordinator.markFirstTraffic();
      assert.equal(watchHarness.watchers[0]?.closed, true);

      await writeFile(getPresencePath(tmpRoot, 140), JSON.stringify({
        pid: 140,
        parentPid: PARENT_PID,
        serverName: SERVER_NAME,
        createdAtMs: 1,
      }), 'utf8');
      watchHarness.watchers[0]?.emitChange();

      await delay(PRE_TRAFFIC_GRACE_MS + 40);
      assert.deepEqual(shutdownReasons, []);
      await coordinator.dispose();
    });
  });

  it('claims owner on first traffic when no live owner exists', async () => {
    await withTmpDir(async (tmpRoot) => {
      const coordinator = await createDuplicateCoordinator({
        parentPid: PARENT_PID,
        selfPid: SELF_PID,
        serverName: SERVER_NAME,
        lifecycleDebugEnabled: false,
        shutdown: () => {},
      }, {
        tmpDir: tmpRoot,
        signalProcess: createSignalProcess([SELF_PID]),
        watchDirectory: createWatchHarness().watchDirectory,
      });

      await coordinator.markFirstTraffic();
      const owner = await readJson(getOwnerPath(tmpRoot)) as { pid: number; parentPid: number; serverName: string };
      assert.equal(owner.pid, SELF_PID);
      assert.equal(owner.parentPid, PARENT_PID);
      assert.equal(owner.serverName, SERVER_NAME);

      await coordinator.dispose();
      await assert.rejects(() => stat(getOwnerPath(tmpRoot)));
    });
  });

  it('does not overwrite a live foreign owner on first traffic', async () => {
    await withTmpDir(async (tmpRoot) => {
      await mkdir(getRegistryDir(tmpRoot), { recursive: true });
      await writeFile(getOwnerPath(tmpRoot), JSON.stringify({
        pid: 220,
        parentPid: PARENT_PID,
        serverName: SERVER_NAME,
        claimedAtMs: 1,
      }), 'utf8');

      const coordinator = await createDuplicateCoordinator({
        parentPid: PARENT_PID,
        selfPid: SELF_PID,
        serverName: SERVER_NAME,
        lifecycleDebugEnabled: false,
        shutdown: () => {},
      }, {
        tmpDir: tmpRoot,
        signalProcess: createSignalProcess([SELF_PID, 220]),
        watchDirectory: createWatchHarness().watchDirectory,
      });

      await coordinator.markFirstTraffic();
      const owner = await readJson(getOwnerPath(tmpRoot)) as { pid: number };
      assert.equal(owner.pid, 220);
      await coordinator.dispose();
    });
  });

  it('stays alive when watcher creation fails and does not fall back to polling', async () => {
    await withTmpDir(async (tmpRoot) => {
      const registryDir = getRegistryDir(tmpRoot);
      await mkdir(registryDir, { recursive: true });
      await writeFile(getPresencePath(tmpRoot, 140), JSON.stringify({
        pid: 140,
        parentPid: PARENT_PID,
        serverName: SERVER_NAME,
        createdAtMs: 1,
      }), 'utf8');

      const shutdownReasons: string[] = [];
      const coordinator = await createDuplicateCoordinator({
        parentPid: PARENT_PID,
        selfPid: SELF_PID,
        serverName: SERVER_NAME,
        lifecycleDebugEnabled: false,
        shutdown: (reason) => {
          shutdownReasons.push(reason);
        },
        preTrafficGraceMs: PRE_TRAFFIC_GRACE_MS,
      }, {
        tmpDir: tmpRoot,
        signalProcess: createSignalProcess([SELF_PID, 140]),
        watchDirectory: () => {
          throw new Error('watch unavailable');
        },
      });

      await delay(PRE_TRAFFIC_GRACE_MS + 40);
      assert.deepEqual(shutdownReasons, []);
      await coordinator.dispose();
    });
  });

  it('cleans malformed records conservatively when possible', async () => {
    await withTmpDir(async (tmpRoot) => {
      await mkdir(getRegistryDir(tmpRoot), { recursive: true });
      await writeFile(getPresencePath(tmpRoot, 140), '{not-json', 'utf8');
      await writeFile(getOwnerPath(tmpRoot), '{still-not-json', 'utf8');

      const coordinator = await createDuplicateCoordinator({
        parentPid: PARENT_PID,
        selfPid: SELF_PID,
        serverName: SERVER_NAME,
        lifecycleDebugEnabled: false,
        shutdown: () => {},
      }, {
        tmpDir: tmpRoot,
        signalProcess: createSignalProcess([SELF_PID]),
        watchDirectory: createWatchHarness().watchDirectory,
      });

      await assert.rejects(() => stat(getPresencePath(tmpRoot, 140)));
      await assert.rejects(() => stat(getOwnerPath(tmpRoot)));
      await coordinator.dispose();
    });
  });
});

describe('duplicate coordination source contract', () => {
  it('keeps duplicate coordination event-driven and tmpdir-backed', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/duplicate-coordination.ts'), 'utf8');

    assert.match(src, /tmpdir\(/, 'duplicate coordination registry should live under os.tmpdir()');
    assert.doesNotMatch(src, /state-paths\.js/, 'runtime duplicate coordination must not depend on the persistent .omx/state path helpers');
    assert.doesNotMatch(src, /watchFile\(/, 'duplicate coordination must not fall back to fs.watchFile polling');
    assert.doesNotMatch(src, /setInterval\(/, 'duplicate coordination must not use repeating timers');
  });
});
