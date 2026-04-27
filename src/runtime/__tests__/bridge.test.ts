import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeBridge, RuntimeBridgeError, resolveRuntimeBinaryPath } from '../bridge.js';

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
    const actual = resolveRuntimeBinaryPath({
      debugPath: '/debug/runtime',
      releasePath: '/release/runtime',
      fallbackBinary: 'omx-runtime',
      exists: (candidate) => candidate === '/debug/runtime' || candidate === '/release/runtime',
    });
    assert.equal(actual, '/debug/runtime');
  });

  it('falls back to release build when debug is unavailable', () => {
    const actual = resolveRuntimeBinaryPath({
      debugPath: '/debug/runtime',
      releasePath: '/release/runtime',
      fallbackBinary: 'omx-runtime',
      exists: (candidate) => candidate === '/release/runtime',
    });
    assert.equal(actual, '/release/runtime');
  });

  it('falls back to PATH binary when local builds are unavailable', () => {
    const actual = resolveRuntimeBinaryPath({
      debugPath: '/debug/runtime',
      releasePath: '/release/runtime',
      fallbackBinary: 'omx-runtime',
      exists: () => false,
    });
    assert.equal(actual, 'omx-runtime');
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

describe('RuntimeBridge.execCommand / readSnapshot (parse guard)', () => {
  // The bridge's `validateSchemaOnce` is a module-level singleton: a single
  // fake-binary that returns the same string regardless of subcommand would
  // make test ordering matter. Branch on $1 so the schema probe always sees
  // a valid manifest while exec/snapshot return the test-supplied stdout.
  const validSchema = JSON.stringify({
    commands: [
      'acquire-authority', 'renew-authority', 'queue-dispatch',
      'mark-notified', 'mark-delivered', 'mark-failed',
      'request-replay', 'capture-snapshot',
    ],
  });

  function withFakeBinary(stdout: string, run: (bridge: RuntimeBridge) => void): void {
    const stateDir = mkdtempSync(join(tmpdir(), 'omx-bridge-exec-'));
    const binaryPath = join(stateDir, 'fake-runtime.sh');
    const script = `#!/bin/sh
case "$1" in
  schema)
    printf '%s' ${JSON.stringify(validSchema)}
    ;;
  *)
    printf '%s' ${JSON.stringify(stdout)}
    ;;
esac
`;
    writeFileSync(binaryPath, script, 'utf-8');
    chmodSync(binaryPath, 0o755);
    try {
      run(new RuntimeBridge({ stateDir, binaryPath }));
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }

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
