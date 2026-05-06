import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STARTUP_SETTLE_MS = 150;
const SPAWN_TIMEOUT_MS = 1_500;
const EXIT_TIMEOUT_MS = 2_500;
const OUTPUT_LIMIT = 4_096;

const IDLE_ENTRYPOINTS = [
  { server: 'state', file: 'state-server.js' },
  { server: 'memory', file: 'memory-server.js' },
  { server: 'code_intel', file: 'code-intel-server.js' },
  { server: 'trace', file: 'trace-server.js' },
] as const;

type EntryPoint = (typeof IDLE_ENTRYPOINTS)[number];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimOutput(chunks: string[]): string {
  const text = chunks.join('');
  if (text.length <= OUTPUT_LIMIT) return text;
  return text.slice(-OUTPUT_LIMIT);
}

function isChildAlive(child: ChildProcess): boolean {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return false;
  }

  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function formatFailureContext(entrypoint: EntryPoint, stderr: string[], stdout: string[]): string {
  const note = 'caveat' in entrypoint ? ` (${entrypoint.caveat})` : '';
  return [
    `${entrypoint.server}${note}`,
    `stdout=${JSON.stringify(trimOutput(stdout))}`,
    `stderr=${JSON.stringify(trimOutput(stderr))}`,
  ].join(' | ');
}

async function waitForSpawn(child: ChildProcess, entrypoint: EntryPoint, stderr: string[], stdout: string[]): Promise<void> {
  await Promise.race([
    once(child, 'spawn').then(() => undefined),
    once(child, 'error').then(([error]) => {
      throw new Error(
        `failed to spawn ${formatFailureContext(entrypoint, stderr, stdout)}: ${(error as Error).message}`,
      );
    }),
    delay(SPAWN_TIMEOUT_MS).then(() => {
      throw new Error(`timed out waiting for spawn: ${formatFailureContext(entrypoint, stderr, stdout)}`);
    }),
  ]);
}

async function assertChildAliveBeforeTeardown(
  child: ChildProcess,
  entrypoint: EntryPoint,
  stderr: string[],
  stdout: string[],
): Promise<void> {
  await delay(STARTUP_SETTLE_MS);
  assert.equal(
    isChildAlive(child),
    true,
    `child must still be alive before teardown assertion: ${formatFailureContext(entrypoint, stderr, stdout)}`,
  );
}

async function waitForExit(
  child: ChildProcess,
  entrypoint: EntryPoint,
  stderr: string[],
  stdout: string[],
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  try {
    const [code, signal] = (await Promise.race([
      once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>,
      delay(EXIT_TIMEOUT_MS).then(() => {
        throw new Error(`timed out waiting for exit: ${formatFailureContext(entrypoint, stderr, stdout)}`);
      }),
    ])) as [number | null, NodeJS.Signals | null];

    return { code, signal };
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}

function spawnEntrypoint(entrypoint: EntryPoint): {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
} {
  const child = spawn(process.execPath, [join(process.cwd(), 'dist', 'mcp', entrypoint.file)], {
    cwd: process.cwd(),
    env: { ...process.env, OMX_MCP_LIFECYCLE_LOG: 'off' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: string) => stderr.push(chunk));

  return { child, stdout, stderr };
}

async function forceCleanup(child: ChildProcess): Promise<void> {
  if (!isChildAlive(child)) return;
  child.kill('SIGKILL');
  await once(child, 'exit').catch(() => {});
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  if (!predicate()) throw new Error(message);
}

describe('MCP stdio lifecycle runtime regression (built entrypoints)', () => {
  for (const entrypoint of IDLE_ENTRYPOINTS) {
    const label = 'caveat' in entrypoint
      ? `${entrypoint.server} idle entrypoint exits after stdin closes (${entrypoint.caveat})`
      : `${entrypoint.server} idle entrypoint exits after stdin closes`;

    it(label, async () => {
      const { child, stderr, stdout } = spawnEntrypoint(entrypoint);

      try {
        await waitForSpawn(child, entrypoint, stderr, stdout);
        await assertChildAliveBeforeTeardown(child, entrypoint, stderr, stdout);

        child.stdin?.end();
        const exit = await waitForExit(child, entrypoint, stderr, stdout);

        assert.notEqual(exit.signal, 'SIGKILL');
        assert.equal(isChildAlive(child), false);
      } finally {
        await forceCleanup(child);
      }
    });
  }

  for (const entrypoint of IDLE_ENTRYPOINTS) {
    const label = 'caveat' in entrypoint
      ? `${entrypoint.server} idle entrypoint exits on SIGTERM (${entrypoint.caveat})`
      : `${entrypoint.server} idle entrypoint exits on SIGTERM`;

    it(label, async () => {
      const { child, stderr, stdout } = spawnEntrypoint(entrypoint);

      try {
        await waitForSpawn(child, entrypoint, stderr, stdout);
        await assertChildAliveBeforeTeardown(child, entrypoint, stderr, stdout);

        child.kill('SIGTERM');
        const exit = await waitForExit(child, entrypoint, stderr, stdout);

        assert.notEqual(exit.signal, 'SIGKILL');
        assert.equal(isChildAlive(child), false);
      } finally {
        await forceCleanup(child);
      }
    });
  }

  for (const entrypoint of IDLE_ENTRYPOINTS) {
    const label = 'caveat' in entrypoint
      ? `${entrypoint.server} idle entrypoint exits on SIGINT (${entrypoint.caveat})`
      : `${entrypoint.server} idle entrypoint exits on SIGINT`;

    it(label, async () => {
      const { child, stderr, stdout } = spawnEntrypoint(entrypoint);

      try {
        await waitForSpawn(child, entrypoint, stderr, stdout);
        await assertChildAliveBeforeTeardown(child, entrypoint, stderr, stdout);

        child.kill('SIGINT');
        const exit = await waitForExit(child, entrypoint, stderr, stdout);

        assert.notEqual(exit.signal, 'SIGKILL');
        assert.equal(isChildAlive(child), false);
      } finally {
        await forceCleanup(child);
      }
    });
  }

  it('uninitialized older duplicate entrypoints self-exit while the newest sibling survives', async () => {
    const entrypoint = IDLE_ENTRYPOINTS[0];
    const sharedEnv = {
      ...process.env,
      OMX_MCP_PARENT_WATCHDOG_INTERVAL_MS: '250',
      OMX_MCP_DUPLICATE_SIBLING_WATCHDOG_INTERVAL_MS: '250',
      OMX_MCP_DUPLICATE_SIBLING_PRE_TRAFFIC_GRACE_MS: '500',
      OMX_MCP_LIFECYCLE_LOG: 'off',
    };
    const older = spawn(process.execPath, [join(process.cwd(), 'dist', 'mcp', entrypoint.file)], {
      cwd: process.cwd(),
      env: sharedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let newer: ChildProcess | null = null;

    const stdout: string[] = [];
    const stderr: string[] = [];
    const attachLogs = (child: ChildProcess) => {
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: string) => stderr.push(chunk));
    };
    attachLogs(older);

    try {
      await waitForSpawn(older, entrypoint, stderr, stdout);
      await assertChildAliveBeforeTeardown(older, entrypoint, stderr, stdout);

      newer = spawn(process.execPath, [join(process.cwd(), 'dist', 'mcp', entrypoint.file)], {
        cwd: process.cwd(),
        env: sharedEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      attachLogs(newer);
      await waitForSpawn(newer, entrypoint, stderr, stdout);
      await assertChildAliveBeforeTeardown(newer, entrypoint, stderr, stdout);

      await waitForCondition(
        () => !isChildAlive(older),
        4_000,
        `older duplicate failed to self-exit: ${formatFailureContext(entrypoint, stderr, stdout)}`,
      );

      assert.equal(isChildAlive(newer), true, `newest duplicate should survive: ${formatFailureContext(entrypoint, stderr, stdout)}`);
      const olderExit = await waitForExit(older, entrypoint, stderr, stdout);
      assert.notEqual(olderExit.signal, 'SIGKILL');
    } finally {
      await forceCleanup(older);
      if (newer) {
        await forceCleanup(newer);
      }
    }
  });

  it('initialized older duplicate entrypoints remain alive when a native subagent sibling starts', async () => {
    const entrypoint = IDLE_ENTRYPOINTS[0];
    const sharedEnv = {
      ...process.env,
      OMX_MCP_PARENT_WATCHDOG_INTERVAL_MS: '250',
      OMX_MCP_DUPLICATE_SIBLING_WATCHDOG_INTERVAL_MS: '250',
      OMX_MCP_DUPLICATE_SIBLING_PRE_TRAFFIC_GRACE_MS: '500',
      OMX_MCP_LIFECYCLE_LOG: 'off',
    };
    const older = spawn(process.execPath, [join(process.cwd(), 'dist', 'mcp', entrypoint.file)], {
      cwd: process.cwd(),
      env: sharedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let newer: ChildProcess | null = null;

    const stdout: string[] = [];
    const stderr: string[] = [];
    const attachLogs = (child: ChildProcess) => {
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: string) => stderr.push(chunk));
    };
    attachLogs(older);

    try {
      await waitForSpawn(older, entrypoint, stderr, stdout);
      await assertChildAliveBeforeTeardown(older, entrypoint, stderr, stdout);

      older.stdin?.write('leader-initialize-traffic');
      await delay(100);

      newer = spawn(process.execPath, [join(process.cwd(), 'dist', 'mcp', entrypoint.file)], {
        cwd: process.cwd(),
        env: sharedEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      attachLogs(newer);
      await waitForSpawn(newer, entrypoint, stderr, stdout);
      await assertChildAliveBeforeTeardown(newer, entrypoint, stderr, stdout);

      await delay(1_500);

      assert.equal(
        isChildAlive(older),
        true,
        `initialized older sibling should keep active transport alive: ${formatFailureContext(entrypoint, stderr, stdout)}`,
      );
      assert.equal(
        isChildAlive(newer),
        true,
        `newer sibling should also survive: ${formatFailureContext(entrypoint, stderr, stdout)}`,
      );
    } finally {
      await forceCleanup(older);
      if (newer) {
        await forceCleanup(newer);
      }
    }
  });

  it('pre-traffic sibling hard cap cleans up no-traffic app-server children and records telemetry', async () => {
    const entrypoint = IDLE_ENTRYPOINTS[0];
    const logDir = await mkdtemp(join(tmpdir(), 'omx-mcp-runtime-lifecycle-'));
    const sharedEnv = {
      ...process.env,
      OMX_MCP_PARENT_WATCHDOG_INTERVAL_MS: '250',
      OMX_MCP_DUPLICATE_SIBLING_INITIAL_DELAY_MS: '0',
      OMX_MCP_DUPLICATE_SIBLING_WATCHDOG_INTERVAL_MS: '250',
      OMX_MCP_DUPLICATE_SIBLING_PRE_TRAFFIC_GRACE_MS: '60000',
      OMX_MCP_MAX_SIBLINGS_PER_ENTRYPOINT: '4',
      OMX_MCP_LIFECYCLE_LOG_DIR: logDir,
    };
    const children: ChildProcess[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const attachLogs = (child: ChildProcess) => {
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: string) => stderr.push(chunk));
    };

    try {
      for (let index = 0; index < 5; index += 1) {
        const child = spawn(process.execPath, [join(process.cwd(), 'dist', 'mcp', entrypoint.file)], {
          cwd: process.cwd(),
          env: sharedEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        children.push(child);
        attachLogs(child);
        await waitForSpawn(child, entrypoint, stderr, stdout);
      }

      await waitForCondition(
        () => children.filter(isChildAlive).length <= 4,
        4_000,
        `pre-traffic hard cap did not bound duplicate children: ${formatFailureContext(entrypoint, stderr, stdout)}`,
      );

      assert.equal(
        children.filter(isChildAlive).length,
        4,
        `hard cap should preserve the newest four children: ${formatFailureContext(entrypoint, stderr, stdout)}`,
      );

      const telemetry = await readFile(join(logDir, 'state-server.js.ndjson'), 'utf8');
      assert.match(telemetry, /duplicate_sibling_observed/);
      assert.match(telemetry, /superseded_hard_cap_pre_traffic/);
    } finally {
      for (const child of children) {
        await forceCleanup(child);
      }
    }
  });
});
