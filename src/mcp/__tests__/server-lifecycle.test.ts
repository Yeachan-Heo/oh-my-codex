import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
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
  {
    server: 'team',
    file: 'team-server.js',
    caveat: 'idle teardown only; request-time child-job semantics remain intentionally out of scope',
  },
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
    env: { ...process.env },
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
});
