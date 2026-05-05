import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runProcessTreeWithTimeout } from '../process-tree.js';

describe('runProcessTreeWithTimeout', () => {
  it('captures successful command output', async () => {
    const result = await runProcessTreeWithTimeout(process.execPath, [
      '-e',
      'process.stdout.write("ok"); process.stderr.write("warn");',
    ], { timeoutMs: 1_000 });

    assert.equal(result.status, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout, 'ok');
    assert.equal(result.stderr, 'warn');
  });

  it('marks timed out commands after terminating the process tree', async () => {
    const result = await runProcessTreeWithTimeout(process.execPath, [
      '-e',
      'setTimeout(() => {}, 5_000);',
    ], { timeoutMs: 50, sigkillGraceMs: 10 });

    assert.equal(result.timedOut, true);
    assert.notEqual(result.status, 0);
  });
});
