import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  LIFECYCLE_LOG_DIR_ENV,
  LIFECYCLE_LOG_ENV,
  PRETRAFFIC_LEDGER_ENV,
  appendPretrafficEvent,
  emit,
  isLifecycleLogDisabled,
  readPretrafficSiblingPids,
  resolveLogDir,
  _resetForTests,
} from '../lifecycle-telemetry.js';

describe('resolveLogDir', () => {
  it('returns OMX_MCP_LIFECYCLE_LOG_DIR override regardless of platform', () => {
    const result = resolveLogDir({
      env: { [LIFECYCLE_LOG_DIR_ENV]: '/custom/path' },
      platform: 'darwin',
      home: '/Users/x',
      tmp: '/tmp',
    });
    assert.equal(result.dir, '/custom/path');
    assert.equal(result.source, 'env');
  });

  it('returns ~/Library/Logs/oh-my-codex/mcp on darwin', () => {
    const result = resolveLogDir({
      env: {},
      platform: 'darwin',
      home: '/Users/jane',
      tmp: '/tmp',
    });
    assert.equal(result.dir, '/Users/jane/Library/Logs/oh-my-codex/mcp');
    assert.equal(result.source, 'platform');
  });

  it('returns XDG_STATE_HOME-rooted path on linux when XDG set', () => {
    const result = resolveLogDir({
      env: { XDG_STATE_HOME: '/custom/state' },
      platform: 'linux',
      home: '/home/jane',
      tmp: '/tmp',
    });
    assert.equal(result.dir, '/custom/state/oh-my-codex/mcp');
    assert.equal(result.source, 'platform');
  });

  it('returns ~/.local/state-rooted path on linux when XDG unset', () => {
    const result = resolveLogDir({
      env: {},
      platform: 'linux',
      home: '/home/jane',
      tmp: '/tmp',
    });
    assert.equal(result.dir, '/home/jane/.local/state/oh-my-codex/mcp');
    assert.equal(result.source, 'platform');
  });

  it('returns LOCALAPPDATA-rooted path on win32 when set', () => {
    const result = resolveLogDir({
      env: { LOCALAPPDATA: 'C:\\Users\\jane\\AppData\\Local' },
      platform: 'win32',
      home: 'C:\\Users\\jane',
      tmp: 'C:\\Temp',
    });
    assert.equal(result.source, 'platform');
    assert.ok(result.dir.includes('oh-my-codex'));
    assert.ok(result.dir.includes('Logs'));
    assert.ok(result.dir.includes('mcp'));
  });

  it('falls back to tmpdir when no home is available', () => {
    const result = resolveLogDir({
      env: {},
      platform: 'darwin',
      home: null,
      tmp: '/var/folders/x/T/',
    });
    assert.equal(result.source, 'fallback');
    assert.ok(result.dir.includes('oh-my-codex-mcp'));
  });

  it('falls back to tmpdir on win32 when LOCALAPPDATA is missing', () => {
    const result = resolveLogDir({
      env: {},
      platform: 'win32',
      home: 'C:\\Users\\jane',
      tmp: 'C:\\Temp',
    });
    assert.equal(result.source, 'fallback');
  });
});

describe('isLifecycleLogDisabled', () => {
  it('returns true when OMX_MCP_LIFECYCLE_LOG=off (any case)', () => {
    assert.equal(isLifecycleLogDisabled({ [LIFECYCLE_LOG_ENV]: 'off' }), true);
    assert.equal(isLifecycleLogDisabled({ [LIFECYCLE_LOG_ENV]: 'OFF' }), true);
    assert.equal(isLifecycleLogDisabled({ [LIFECYCLE_LOG_ENV]: 'Off' }), true);
  });

  it('returns false otherwise', () => {
    assert.equal(isLifecycleLogDisabled({}), false);
    assert.equal(isLifecycleLogDisabled({ [LIFECYCLE_LOG_ENV]: 'on' }), false);
    assert.equal(isLifecycleLogDisabled({ [LIFECYCLE_LOG_ENV]: '' }), false);
  });
});

describe('emit', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'omx-mcp-lifecycle-'));
    _resetForTests();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a single JSON line with pid, ppid, ts_ms, event, and payload', async () => {
    await emit(
      'startup',
      { serverName: 'state', marker: 'state-server.js' },
      {
        entrypoint: 'state-server',
        env: { [LIFECYCLE_LOG_DIR_ENV]: dir },
        platform: 'darwin',
        now: () => 1700000000000,
        pid: 4242,
        ppid: 1224,
      },
    );

    const filePath = join(dir, 'state-server.ndjson');
    const content = await readFile(filePath, 'utf8');
    assert.ok(content.endsWith('\n'), 'file content must end with newline');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.event, 'startup');
    assert.equal(record.serverName, 'state');
    assert.equal(record.marker, 'state-server.js');
    assert.equal(record.pid, 4242);
    assert.equal(record.ppid, 1224);
    assert.equal(record.ts_ms, 1700000000000);
  });

  it('appends successive emits to the same entrypoint file', async () => {
    const opts = {
      entrypoint: 'memory-server',
      env: { [LIFECYCLE_LOG_DIR_ENV]: dir },
      platform: 'linux' as NodeJS.Platform,
      pid: 1,
      ppid: 2,
    };
    await emit('startup', { i: 1 }, opts);
    await emit('shutdown_reason', { reason: 'stdin_close' }, opts);
    await emit('shutdown_reason', { reason: 'transport_close' }, opts);

    const content = await readFile(join(dir, 'memory-server.ndjson'), 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 3);
    const events = lines.map((l) => JSON.parse(l).event);
    assert.deepEqual(events, ['startup', 'shutdown_reason', 'shutdown_reason']);
  });

  it('short-circuits when OMX_MCP_LIFECYCLE_LOG=off (no file created)', async () => {
    await emit(
      'startup',
      { serverName: 'state' },
      {
        entrypoint: 'state-server',
        env: {
          [LIFECYCLE_LOG_DIR_ENV]: dir,
          [LIFECYCLE_LOG_ENV]: 'off',
        },
        platform: 'darwin',
      },
    );
    let didThrow = false;
    try {
      await stat(join(dir, 'state-server.ndjson'));
    } catch {
      didThrow = true;
    }
    assert.equal(didThrow, true, 'no log file should be created when LIFECYCLE_LOG=off');
  });

  it('replaces oversize payload with lifecycle_event_skipped record', async () => {
    const huge = 'x'.repeat(8 * 1024);
    await emit(
      'duplicate_observation',
      { dump: huge },
      {
        entrypoint: 'wiki-server',
        env: { [LIFECYCLE_LOG_DIR_ENV]: dir },
        platform: 'linux',
        pid: 7,
        ppid: 8,
        now: () => 42,
      },
    );
    const content = await readFile(join(dir, 'wiki-server.ndjson'), 'utf8');
    const record = JSON.parse(content.trim());
    assert.equal(record.event, 'lifecycle_event_skipped');
    assert.equal(record.reason, 'oversize');
    assert.equal(record.original_event, 'duplicate_observation');
    assert.ok(typeof record.original_bytes === 'number');
  });

  it('rotates the log file when it exceeds 4 MB', async () => {
    const filePath = join(dir, 'trace-server.ndjson');
    await mkdtemp(join(tmpdir(), 'noop-')); // ensure tmpdir exists
    // Pre-create a 4.1MB file to trigger rotation on next emit
    const big = Buffer.alloc(4 * 1024 * 1024 + 1024, 0x61);
    await writeFile(filePath, big);

    await emit(
      'startup',
      { serverName: 'trace' },
      {
        entrypoint: 'trace-server',
        env: { [LIFECYCLE_LOG_DIR_ENV]: dir },
        platform: 'linux',
        pid: 1,
        ppid: 2,
      },
    );

    // After rotation, .ndjson should contain just the new line; .ndjson.1 should hold the old big content
    const newContent = await readFile(filePath, 'utf8');
    assert.ok(newContent.length < 1024, 'rotated current file should be small');
    const rotatedInfo = await stat(`${filePath}.1`);
    assert.ok(rotatedInfo.size > 4 * 1024 * 1024, 'rotated .1 file should hold old content');
  });

  it('never throws when target directory cannot be created', async () => {
    // Point at a path under a regular file - mkdir(recursive) will fail
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'x');
    await emit(
      'startup',
      {},
      {
        entrypoint: 'state-server',
        env: { [LIFECYCLE_LOG_DIR_ENV]: join(blocker, 'sub') },
        platform: 'linux',
      },
    );
    // No assertion needed - emit() must not throw
  });
});

describe('pretraffic ledger', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'omx-mcp-pretraffic-'));
    _resetForTests();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function ledgerOpts(extra?: Partial<{ pid: number }>) {
    return {
      entrypoint: 'state-server',
      env: { [LIFECYCLE_LOG_DIR_ENV]: dir },
      platform: 'linux' as NodeJS.Platform,
      ...(extra ?? {}),
    };
  }

  it('reads back PIDs whose latest event is start', async () => {
    await appendPretrafficEvent('start', ledgerOpts({ pid: 101 }));
    await appendPretrafficEvent('start', ledgerOpts({ pid: 102 }));
    const pretraffic = await readPretrafficSiblingPids([101, 102, 103], ledgerOpts());
    assert.deepEqual(pretraffic, [101, 102]);
  });

  it('drops PIDs that have transitioned to traffic', async () => {
    await appendPretrafficEvent('start', ledgerOpts({ pid: 101 }));
    await appendPretrafficEvent('start', ledgerOpts({ pid: 102 }));
    await appendPretrafficEvent('traffic', ledgerOpts({ pid: 101 }));
    const pretraffic = await readPretrafficSiblingPids([101, 102], ledgerOpts());
    assert.deepEqual(pretraffic, [102]);
  });

  it('drops PIDs that have exited', async () => {
    await appendPretrafficEvent('start', ledgerOpts({ pid: 101 }));
    await appendPretrafficEvent('exit', ledgerOpts({ pid: 101 }));
    const pretraffic = await readPretrafficSiblingPids([101], ledgerOpts());
    assert.deepEqual(pretraffic, []);
  });

  it('intersects with the candidate PID list (ignores stale ledger entries)', async () => {
    await appendPretrafficEvent('start', ledgerOpts({ pid: 9001 }));
    await appendPretrafficEvent('start', ledgerOpts({ pid: 9002 }));
    const pretraffic = await readPretrafficSiblingPids([9001], ledgerOpts());
    assert.deepEqual(pretraffic, [9001]);
  });

  it('returns [] when ledger does not exist', async () => {
    const pretraffic = await readPretrafficSiblingPids([101, 102], ledgerOpts());
    assert.deepEqual(pretraffic, []);
  });

  it('keeps working when OMX_MCP_LIFECYCLE_LOG=off (ledger is functional state, not diagnostics)', async () => {
    // Disabling the JSONL diagnostic log must NOT disable the hard-cap ledger.
    // The plan eventually flips OMX_MCP_LIFECYCLE_LOG to off-by-default; the cap must
    // keep enforcing in that configuration.
    const opts = {
      entrypoint: 'state-server',
      env: { [LIFECYCLE_LOG_DIR_ENV]: dir, [LIFECYCLE_LOG_ENV]: 'off' },
      platform: 'linux' as NodeJS.Platform,
      pid: 101,
    };
    await appendPretrafficEvent('start', opts);
    const pretraffic = await readPretrafficSiblingPids([101], opts);
    assert.deepEqual(
      pretraffic,
      [101],
      'LIFECYCLE_LOG=off must NOT short-circuit the pretraffic ledger',
    );
    const fileInfo = await stat(join(dir, 'state-server.pretraffic'));
    assert.ok(fileInfo.size > 0, 'ledger file should be written despite LIFECYCLE_LOG=off');
  });

  it('skips reads and writes when OMX_MCP_PRETRAFFIC_LEDGER=off', async () => {
    const offOpts = {
      entrypoint: 'state-server',
      env: { [LIFECYCLE_LOG_DIR_ENV]: dir, [PRETRAFFIC_LEDGER_ENV]: 'off' },
      platform: 'linux' as NodeJS.Platform,
      pid: 101,
    };
    await appendPretrafficEvent('start', offOpts);
    const pretraffic = await readPretrafficSiblingPids([101], offOpts);
    assert.deepEqual(pretraffic, [], 'PRETRAFFIC_LEDGER=off must short-circuit the ledger entirely');
    let didThrow = false;
    try {
      await stat(join(dir, 'state-server.pretraffic'));
    } catch {
      didThrow = true;
    }
    assert.equal(didThrow, true, 'no ledger file should be created');
  });
});
