import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function runCompiledRunner(root: string, envOverrides: Record<string, string> = {}, timeoutMs = 5_000) {
  return spawnSync(process.execPath, ['dist/scripts/run-test-files.js', root], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...envOverrides,
    },
    timeout: timeoutMs,
  });
}

describe('run-test-files diagnostics', () => {
  it('applies a bounded node --test timeout so hanging tests fail with file context', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const testsDir = join(wd, '__tests__');
      mkdirSync(testsDir, { recursive: true });
      const testPath = join(testsDir, 'hang.test.js');
      writeFileSync(
        testPath,
        [
          "import { test } from 'node:test';",
          "test('never resolves', async () => { await new Promise(() => setInterval(() => {}, 1_000)); });",
          '',
        ].join('\n'),
      );

      const result = runCompiledRunner(wd, {
        OMX_NODE_TEST_TIMEOUT_MS: '250',
        OMX_NODE_TEST_RUNNER_TIMEOUT_MS: '750',
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /per-test timeout 250ms/);
      assert.match(result.stderr, /node --test did not exit normally|runner timeout 750ms/);
      assert.match(`${result.stdout}\n${result.stderr}`, /hang\.test\.js|never resolves|cancelled/i);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('logs that per-test timeout is disabled by default', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const testsDir = join(wd, '__tests__');
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(
        join(testsDir, 'pass.test.js'),
        [
          "import { test } from 'node:test';",
          "test('passes', () => {});",
          '',
        ].join('\n'),
      );

      const result = runCompiledRunner(wd);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stderr, /per-test timeout disabled/);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('serializes test files by default in CI to avoid cross-file child-process leaks', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const testsDir = join(wd, '__tests__');
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(
        join(testsDir, 'pass.test.js'),
        [
          "import { test } from 'node:test';",
          "test('passes', () => {});",
          '',
        ].join('\n'),
      );

      const result = runCompiledRunner(wd, { CI: 'true' });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stderr, /test concurrency 1/);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('honors an explicit test concurrency override in CI', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const testsDir = join(wd, '__tests__');
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(
        join(testsDir, 'pass.test.js'),
        [
          "import { test } from 'node:test';",
          "test('passes', () => {});",
          '',
        ].join('\n'),
      );

      const result = runCompiledRunner(wd, { CI: 'true', OMX_NODE_TEST_CONCURRENCY: '2' });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stderr, /test concurrency 2/);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });
});
