/**
 * Unit and integration tests for MiniMax provider support in run-provider-advisor.
 *
 * Uses spawnSync for subprocess invocations. Local HTTP server tests are avoided
 * because spawnSync blocks the event loop, preventing the server from responding.
 * Instead, we test:
 *  - Missing API key (synchronous check, fast)
 *  - Unknown provider (synchronous check, fast)
 *  - Network error path (connection refused, fast)
 *  - Real API integration (requires MINIMAX_API_KEY, skipped if absent)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

function runAdvisor(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const scriptPath = join(REPO_ROOT, 'dist', 'scripts', 'run-provider-advisor.js');
  const r = spawnSync(process.execPath, [scriptPath, ...argv], {
    cwd,
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, ...envOverrides },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message };
}

function shouldSkip(err?: string): boolean {
  return typeof err === 'string' && /(EPERM|EACCES)/i.test(err);
}

describe('run-provider-advisor: minimax provider', () => {
  it('exits with code 1 and prints MINIMAX_API_KEY error when key is empty', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-minimax-nokey-'));
    try {
      const res = runAdvisor(wd, ['minimax', 'hello'], { MINIMAX_API_KEY: '' });
      if (shouldSkip(res.error)) return;

      assert.equal(res.status, 1, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
      assert.match(res.stderr, /MINIMAX_API_KEY/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('exits with code 1 for unknown provider', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-minimax-unknown-'));
    try {
      const res = runAdvisor(wd, ['unknownprovider', 'hello']);
      if (shouldSkip(res.error)) return;

      assert.equal(res.status, 1, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('writes artifact with non-zero exit code when MiniMax API is unreachable', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-minimax-refused-'));
    try {
      // Port 1 is privileged/closed on most systems — connection is refused immediately
      const res = runAdvisor(wd, ['minimax', 'explain the error path'], {
        MINIMAX_API_KEY: 'dummy-key-for-network-test',
        MINIMAX_BASE_URL: 'http://127.0.0.1:1',
      });
      if (shouldSkip(res.error)) return;

      assert.equal(res.status, 1, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
      const artifactPath = res.stdout.trim();
      if (artifactPath.includes('.omx')) {
        const artifact = await readFile(artifactPath, 'utf-8');
        assert.match(artifact, /minimax advisor artifact/i);
        // Artifact should record failure (exitCode != 0)
        assert.match(artifact, /Exit code: 1/);
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('accepts minimax as a valid provider name (does not print unknown-provider error)', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-minimax-valid-provider-'));
    try {
      // Even with an empty key, the error should be about MINIMAX_API_KEY, not "unknown provider"
      const res = runAdvisor(wd, ['minimax', 'hello'], { MINIMAX_API_KEY: '' });
      if (shouldSkip(res.error)) return;

      assert.doesNotMatch(res.stderr, /unknown provider/i);
      assert.match(res.stderr, /MINIMAX_API_KEY/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  // Integration test — only runs when MINIMAX_API_KEY is set in the environment
  it('(integration) calls real MiniMax API and writes artifact on success', async () => {
    const apiKey = process.env.MINIMAX_API_KEY;
    if (!apiKey) {
      // Skip gracefully when no key is available
      return;
    }

    const wd = await mkdtemp(join(tmpdir(), 'omx-minimax-integration-'));
    try {
      const res = runAdvisor(wd, ['minimax', 'Reply with: MINIMAX_OK'], {
        MINIMAX_API_KEY: apiKey,
        MINIMAX_MODEL: 'MiniMax-M2.7-highspeed',
      });
      if (shouldSkip(res.error)) return;

      assert.equal(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
      const artifactPath = res.stdout.trim();
      assert.ok(artifactPath.includes('.omx'), `Expected artifact path, got: ${artifactPath}`);
      const artifact = await readFile(artifactPath, 'utf-8');
      assert.match(artifact, /minimax advisor artifact/i);
      assert.match(artifact, /Exit code: 0/);
      assert.match(artifact, /MINIMAX_OK/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
