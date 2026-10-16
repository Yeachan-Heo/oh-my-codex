import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveCachedNativeBinaryPath } from '../../cli/native-assets.js';
import { getPackageRoot } from '../../utils/package.js';
import { isRuntimeTransportError, RuntimeBridge, RuntimeBridgeError, resolveRuntimeBinaryPath } from '../bridge.js';

describe('resolveRuntimeBinaryPath', () => {
  it('prefers explicit OMX_RUNTIME_BINARY override', () => {
    const previous = process.env.OMX_RUNTIME_BINARY;
    try {
      process.env.OMX_RUNTIME_BINARY = '/custom/runtime';
      const actual = resolveRuntimeBinaryPath({
        debugPath: '/debug/runtime',
        releasePath: '/release/runtime',
        fallbackBinary: 'omx-runtime',
        exists: () => false,
      });
      assert.equal(actual, '/custom/runtime');
    } finally {
      if (typeof previous === 'string') process.env.OMX_RUNTIME_BINARY = previous;
      else delete process.env.OMX_RUNTIME_BINARY;
    }
  });

  it('prefers debug build over release and PATH fallback', () => {
    const previous = process.env.OMX_RUNTIME_BINARY;
    try {
      delete process.env.OMX_RUNTIME_BINARY;
      const actual = resolveRuntimeBinaryPath({
        debugPath: '/debug/runtime',
        releasePath: '/release/runtime',
        fallbackBinary: 'omx-runtime',
        exists: (candidate) => candidate === '/debug/runtime' || candidate === '/release/runtime',
      });
      assert.equal(actual, '/debug/runtime');
    } finally {
      if (typeof previous === 'string') process.env.OMX_RUNTIME_BINARY = previous;
      else delete process.env.OMX_RUNTIME_BINARY;
    }
  });

  it('falls back to release build when debug is unavailable', () => {
    const previous = process.env.OMX_RUNTIME_BINARY;
    try {
      delete process.env.OMX_RUNTIME_BINARY;
      const actual = resolveRuntimeBinaryPath({
        debugPath: '/debug/runtime',
        releasePath: '/release/runtime',
        fallbackBinary: 'omx-runtime',
        exists: (candidate) => candidate === '/release/runtime',
      });
      assert.equal(actual, '/release/runtime');
    } finally {
      if (typeof previous === 'string') process.env.OMX_RUNTIME_BINARY = previous;
      else delete process.env.OMX_RUNTIME_BINARY;
    }
  });

  it('falls back to PATH binary when local builds are unavailable', () => {
    const previous = process.env.OMX_RUNTIME_BINARY;
    try {
      delete process.env.OMX_RUNTIME_BINARY;
      const actual = resolveRuntimeBinaryPath({
        debugPath: '/debug/runtime',
        releasePath: '/release/runtime',
        fallbackBinary: 'omx-runtime',
        exists: () => false,
      });
      assert.equal(actual, 'omx-runtime');
    } finally {
      if (typeof previous === 'string') process.env.OMX_RUNTIME_BINARY = previous;
      else delete process.env.OMX_RUNTIME_BINARY;
    }
  });

  it('prefers the verified native cache on the production path', () => {
    const previousCacheDir = process.env.OMX_NATIVE_CACHE_DIR;
    const previousOverride = process.env.OMX_RUNTIME_BINARY;
    const tempRoot = mkdtempSync(join(tmpdir(), 'omx-runtime-cache-'));
    try {
      delete process.env.OMX_RUNTIME_BINARY;
      const manifest = JSON.parse(
        readFileSync(join(getPackageRoot(), 'package.json'), 'utf-8'),
      ) as { version?: string };
      const version = manifest.version;
      assert.ok(version, 'expected a package version for cache resolution');

      const env = { ...process.env, OMX_NATIVE_CACHE_DIR: tempRoot };
      const cached = resolveCachedNativeBinaryPath(
        'omx-runtime' as never,
        version,
        process.platform as NodeJS.Platform,
        process.arch,
        env,
      );
      const contents = 'runtime-binary-bytes';
      mkdirSync(dirname(cached), { recursive: true });
      writeFileSync(cached, contents);
      writeFileSync(`${cached}.sha256`, `${createHash('sha256').update(contents).digest('hex')}\n`);

      process.env.OMX_NATIVE_CACHE_DIR = tempRoot;
      // Called without an injected `exists` so the production cache branch runs.
      // A bare require() there is a ReferenceError under ESM; the surrounding
      // catch used to swallow it, so the verified cache was never consulted and
      // resolution silently fell through to the PATH-only fallback.
      const actual = resolveRuntimeBinaryPath();
      assert.equal(actual, cached);
    } finally {
      if (typeof previousCacheDir === 'string') process.env.OMX_NATIVE_CACHE_DIR = previousCacheDir;
      else delete process.env.OMX_NATIVE_CACHE_DIR;
      if (typeof previousOverride === 'string') process.env.OMX_RUNTIME_BINARY = previousOverride;
      else delete process.env.OMX_RUNTIME_BINARY;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('adds .exe suffix on Windows for default fallback binary', () => {
    const previous = process.env.OMX_RUNTIME_BINARY;
    try {
      delete process.env.OMX_RUNTIME_BINARY;
      const actual = resolveRuntimeBinaryPath({
        debugPath: '/debug/runtime',
        releasePath: '/release/runtime',
        exists: () => false,
        platform: 'win32',
      });
      assert.equal(actual, 'omx-runtime.exe');
    } finally {
      if (typeof previous === 'string') process.env.OMX_RUNTIME_BINARY = previous;
      else delete process.env.OMX_RUNTIME_BINARY;
    }
  });

  it('adds .exe suffix on Windows for workspace debug path', () => {
    const previous = process.env.OMX_RUNTIME_BINARY;
    try {
      delete process.env.OMX_RUNTIME_BINARY;
      const actual = resolveRuntimeBinaryPath({
        debugPath: '/debug/runtime',
        releasePath: '/release/runtime',
        fallbackBinary: 'omx-runtime',
        exists: (candidate) => candidate === '/debug/runtime.exe',
        platform: 'win32',
      });
      assert.equal(actual, '/debug/runtime.exe');
    } finally {
      if (typeof previous === 'string') process.env.OMX_RUNTIME_BINARY = previous;
      else delete process.env.OMX_RUNTIME_BINARY;
    }
  });

  it('adds .exe suffix on Windows for workspace release path', () => {
    const previous = process.env.OMX_RUNTIME_BINARY;
    try {
      delete process.env.OMX_RUNTIME_BINARY;
      const actual = resolveRuntimeBinaryPath({
        debugPath: '/debug/runtime',
        releasePath: '/release/runtime',
        fallbackBinary: 'omx-runtime',
        exists: (candidate) => candidate === '/release/runtime.exe',
        platform: 'win32',
      });
      assert.equal(actual, '/release/runtime.exe');
    } finally {
      if (typeof previous === 'string') process.env.OMX_RUNTIME_BINARY = previous;
      else delete process.env.OMX_RUNTIME_BINARY;
    }
  });

  it('does not add .exe suffix on non-Windows platforms', () => {
    const previous = process.env.OMX_RUNTIME_BINARY;
    try {
      delete process.env.OMX_RUNTIME_BINARY;
      const actual = resolveRuntimeBinaryPath({
        debugPath: '/debug/runtime',
        releasePath: '/release/runtime',
        fallbackBinary: 'custom-binary',
        exists: () => false,
        platform: 'darwin',
      });
      assert.equal(actual, 'custom-binary');
    } finally {
      if (typeof previous === 'string') process.env.OMX_RUNTIME_BINARY = previous;
      else delete process.env.OMX_RUNTIME_BINARY;
    }
  });
});

describe('RuntimeBridgeError', () => {
  it('preserves command and stdoutPreview context for typed catches', () => {
    const cause = new SyntaxError('Unexpected token } in JSON at position 0');
    const err = new RuntimeBridgeError('exec failed', {
      command: 'AcquireAuthority',
      stdoutPreview: '}',
      cause,
    });
    assert.ok(err instanceof Error);
    assert.ok(err instanceof RuntimeBridgeError);
    assert.equal(err.name, 'RuntimeBridgeError');
    assert.equal(err.context.command, 'AcquireAuthority');
    assert.equal(err.context.stdoutPreview, '}');
    assert.equal(err.context.cause, cause);
    assert.match(err.message, /exec failed/);
  });

  it('defaults context to an empty object when omitted', () => {
    const err = new RuntimeBridgeError('bare message');
    assert.deepEqual(err.context, {});
  });
});

describe('RuntimeBridge.readCompatFile (parse guard)', () => {
  function withBridge(run: (stateDir: string, bridge: RuntimeBridge) => void): void {
    const stateDir = mkdtempSync(join(tmpdir(), 'omx-bridge-compat-'));
    try {
      run(stateDir, new RuntimeBridge({ stateDir, binaryPath: '/nonexistent-binary' }));
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }

  it('returns null when stateDir is unset', () => {
    const bridge = new RuntimeBridge({ binaryPath: '/nonexistent-binary' });
    assert.equal(bridge.readCompatFile('snapshot.json'), null);
  });

  it('returns null when the compat file is absent', () => {
    withBridge((_dir, bridge) => {
      assert.equal(bridge.readCompatFile('snapshot.json'), null);
    });
  });

  it('returns null on truncated JSON instead of throwing SyntaxError', () => {
    withBridge((stateDir, bridge) => {
      writeFileSync(join(stateDir, 'snapshot.json'), '{');
      assert.equal(bridge.readCompatFile('snapshot.json'), null);
    });
  });

  it('returns null on empty content (truncate-then-write race)', () => {
    withBridge((stateDir, bridge) => {
      writeFileSync(join(stateDir, 'snapshot.json'), '');
      assert.equal(bridge.readCompatFile('snapshot.json'), null);
    });
  });

  it('parses well-formed JSON normally', () => {
    withBridge((stateDir, bridge) => {
      writeFileSync(join(stateDir, 'snapshot.json'), JSON.stringify({ schema_version: 1 }));
      assert.deepEqual(
        bridge.readCompatFile<{ schema_version: number }>('snapshot.json'),
        { schema_version: 1 },
      );
    });
  });
});

describe('RuntimeBridge.readDispatchRecordsStrict', () => {
  it('fails closed for missing, malformed, and invalid-shaped dispatch compatibility output', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'omx-bridge-dispatch-strict-'));
    const bridge = new RuntimeBridge({ stateDir, binaryPath: '/nonexistent-binary' });
    try {
      assert.throws(() => bridge.readDispatchRecordsStrict(), RuntimeBridgeError);
      writeFileSync(join(stateDir, 'dispatch.json'), '{');
      assert.throws(() => bridge.readDispatchRecordsStrict(), RuntimeBridgeError);
      writeFileSync(join(stateDir, 'dispatch.json'), JSON.stringify({ records: [{}] }));
      assert.throws(() => bridge.readDispatchRecordsStrict(), RuntimeBridgeError);
      writeFileSync(join(stateDir, 'dispatch.json'), JSON.stringify({ records: [{
        request_id: 'missing-required-fields',
        target: 'worker-1',
        status: 'pending',
        created_at: '2026-01-01T00:00:00.000Z',
        notified_at: null,
        delivered_at: null,
        failed_at: null,
        metadata: null,
      }] }));
      assert.throws(() => bridge.readDispatchRecordsStrict(), RuntimeBridgeError);
      writeFileSync(join(stateDir, 'dispatch.json'), JSON.stringify({ records: [] }));
      assert.deepEqual(bridge.readDispatchRecordsStrict(), []);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe('RuntimeBridge.execCommand / readSnapshot (parse guard)', () => {
  it('captures real runtime dispatch records larger than the pipe buffer limit', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'omx-bridge-large-snapshot-'));
    try {
      const bridge = new RuntimeBridge({ stateDir });
      const trigger = 'x'.repeat(20_000);
      for (let index = 0; index < 60; index += 1) {
        bridge.execCommand({ command: 'QueueDispatch', request_id: `large-${index}`, target: 'worker-1',
          metadata: { team_name: 'alpha', trigger_message: trigger } });
      }
      const snapshot = bridge.execCommand({ command: 'CaptureSnapshot' });
      assert.equal(snapshot.event, 'SnapshotCaptured');
      assert.ok('dispatch_records' in snapshot && Array.isArray(snapshot.dispatch_records));
      assert.equal(snapshot.dispatch_records.length, 60);
      assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024);
      assert.ok(snapshot.dispatch_records.every((record) => record.metadata?.trigger_message === trigger));
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  // Keep schema probes separate from exec/snapshot output in fake runtimes.
  const validSchema = JSON.stringify({
    capabilities: ['team-mailbox-scope-v1'],
    commands: [
      'acquire-authority', 'renew-authority', 'queue-dispatch',
      'mark-notified', 'mark-delivered', 'mark-failed', 'remove-dispatch-records',
      'request-replay', 'capture-snapshot',
    ],
  });

  function withFakeBinary(stdout: string, run: (bridge: RuntimeBridge, binaryPath: string) => void, schema = validSchema): void {
    const stateDir = mkdtempSync(join(tmpdir(), 'omx-bridge-exec-'));
    const binaryPath = join(stateDir, 'fake-runtime.sh');
    const script = `#!/bin/sh
case "$1" in
  schema)
    printf '%s' ${JSON.stringify(schema)}
    ;;
  *)
    printf '%s' ${JSON.stringify(stdout)}
    ;;
esac
`;
    writeFileSync(binaryPath, script, 'utf-8');
    chmodSync(binaryPath, 0o755);
    try {
      run(new RuntimeBridge({ stateDir, binaryPath }), binaryPath);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }

  it('rejects missing Team scope capability even after another runtime was validated', () => {
    const command = { command: 'CaptureSnapshot' as const };
    withFakeBinary('{"event":"SnapshotCaptured"}', (bridge) => bridge.execCommand(command));
    for (const capabilities of [undefined, [], 'team-mailbox-scope-v1']) {
      withFakeBinary('{"event":"SnapshotCaptured"}', (bridge) => {
        assert.throws(() => bridge.execCommand(command), /team-mailbox-scope-v1/);
      }, JSON.stringify({ ...JSON.parse(validSchema), capabilities }));
    }
  });

  it('revalidates a runtime replaced at the same path before the next mutation', () => {
    const command = { command: 'CaptureSnapshot' as const };
    withFakeBinary('{"event":"SnapshotCaptured"}', (bridge, binaryPath) => {
      bridge.execCommand(command);
      writeFileSync(binaryPath, `#!/bin/sh
printf '%s' '{"commands":[],"capabilities":[]}'
`);
      assert.throws(() => bridge.execCommand(command), /team-mailbox-scope-v1/);
    });
  });

  it('executes the configured runtime without relocating it to the temp directory', () => {
    withFakeBinary('{"event":"SnapshotCaptured"}', (bridge, binaryPath) => {
      writeFileSync(binaryPath, `#!/usr/bin/env node
if (process.argv[2] === 'schema') console.log(${JSON.stringify(validSchema)});
else console.log(JSON.stringify({event:'SnapshotCaptured',binary:process.argv[1],subcommand:process.argv[2]}));
`);
      assert.deepEqual(bridge.execCommand({ command: 'CaptureSnapshot' }), {
        event: 'SnapshotCaptured', binary: binaryPath, subcommand: 'exec-scoped',
      });
    });
  });

  it('rejects an old executable swapped in after schema without mutating state', () => {
    withFakeBinary('{"event":"SnapshotCaptured"}', (bridge, binaryPath) => {
      const mutationPath = `${binaryPath}.mutation`;
      const old = `#!/usr/bin/env node
if (process.argv[2] === 'exec-scoped') { console.error('unknown subcommand ' + String.fromCharCode(96) + 'exec-scoped' + String.fromCharCode(96)); process.exit(1); }
require('fs').writeFileSync(${JSON.stringify(mutationPath)}, 'unsafe');
console.log(JSON.stringify({event:'UnsafeMutation'}));
`;
      writeFileSync(binaryPath, `#!/usr/bin/env node
const fs = require('fs');
if (process.argv[2] === 'schema') {
  fs.writeFileSync(${JSON.stringify(binaryPath)}, ${JSON.stringify(old)});
  console.log(${JSON.stringify(validSchema)});
} else console.log(JSON.stringify({event:'SnapshotCaptured'}));
`);
      assert.throws(() => bridge.execCommand({ command: 'CaptureSnapshot' }), (error: unknown) => {
        assert.ok(error instanceof RuntimeBridgeError);
        assert.equal(error.context.command, 'schema');
        return true;
      });
      assert.throws(() => readFileSync(mutationPath), { code: 'ENOENT' });
    });
  });

  it('execCommand surfaces RuntimeBridgeError when stdout is non-JSON', () => {
    withFakeBinary('not-json-at-all', (bridge) => {
      assert.throws(
        () =>
          bridge.execCommand({
            command: 'AcquireAuthority',
            owner: 'leader',
            lease_id: 'L1',
            leased_until: '2026-01-01T00:00:00Z',
          }),
        (err: unknown) => {
          assert.ok(err instanceof RuntimeBridgeError, 'expected RuntimeBridgeError');
          const typed = err as RuntimeBridgeError;
          assert.equal(typed.context.command, 'AcquireAuthority');
          assert.match(typed.message, /non-JSON output/);
          assert.ok(typed.context.cause instanceof SyntaxError);
          return true;
        },
      );
    });
  });

  it('execCommand parses well-formed RuntimeEvent stdout', () => {
    const event = {
      event: 'AuthorityAcquired',
      owner: 'leader',
      lease_id: 'L1',
      leased_until: '2026-01-01T00:00:00Z',
    };
    withFakeBinary(JSON.stringify(event), (bridge) => {
      const actual = bridge.execCommand({
        command: 'AcquireAuthority',
        owner: 'leader',
        lease_id: 'L1',
        leased_until: '2026-01-01T00:00:00Z',
      });
      assert.deepEqual(actual, event);
    });
  });

  it('accepts the authoritative dispatch removal command', () => {
    const event = {
      event: 'DispatchRecordsRemoved',
      request_ids: ['req-removed'],
    };
    withFakeBinary(JSON.stringify(event), (bridge) => {
      assert.deepEqual(
        bridge.execCommand({
          command: 'RemoveDispatchRecords',
          request_ids: ['req-removed'],
        }),
        event,
      );
    });
  });

  it('readSnapshot surfaces RuntimeBridgeError when stdout is non-JSON', () => {
    withFakeBinary('snapshot panic', (bridge) => {
      assert.throws(
        () => bridge.readSnapshot(),
        (err: unknown) => {
          assert.ok(err instanceof RuntimeBridgeError, 'expected RuntimeBridgeError');
          const typed = err as RuntimeBridgeError;
          assert.equal(typed.context.command, 'snapshot');
          assert.match(typed.message, /non-JSON output/);
          return true;
        },
      );
    });
  });
});

describe('isRuntimeTransportError', () => {
  it('allows fallback only when the runtime executable cannot be spawned', () => {
    const wrap = (cause: { code: string; status?: number | null; signal?: string | null }) =>
      new Error('runtime process failed', { cause });
    for (const code of ['EACCES', 'ENOENT', 'ENOTDIR', 'ENOEXEC', 'EPERM']) {
      assert.equal(isRuntimeTransportError(wrap({ code })), true);
    }
    assert.equal(isRuntimeTransportError(wrap({ code: 'ENOENT', status: 1 })), false);
    assert.equal(isRuntimeTransportError(wrap({ code: 'ETIMEDOUT' })), false);
    assert.equal(isRuntimeTransportError(wrap({ code: 'ENOENT', signal: 'SIGTERM' })), false);
    assert.equal(isRuntimeTransportError(new Error('untyped failure')), false);
  });
});
