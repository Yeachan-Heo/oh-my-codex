import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

  it('terminates commands that exceed the configured output limit', async () => {
    const result = await runProcessTreeWithTimeout(process.execPath, [
      '-e',
      'while (true) process.stdout.write("x".repeat(1024));',
    ], { timeoutMs: 5_000, sigkillGraceMs: 10, maxOutputBytes: 4096 });

    assert.equal(result.outputLimitExceeded, true);
    assert.equal(Buffer.byteLength(result.stdout), 4096);
    assert.notEqual(result.status, 0);
  });

  it('terminates suspicious process storms before the global timeout', { skip: process.platform !== 'linux' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-process-tree-storm-'));
    const script = join(root, 'storm.sh');
    await writeFile(script, [
      '#!/bin/sh',
      'while :; do',
      '  sleep 30 &',
      '  sleep 0.01',
      'done',
      '',
    ].join('\n'));
    chmodSync(script, 0o755);

    const started = Date.now();
    const result = await runProcessTreeWithTimeout(script, [], {
      timeoutMs: 10_000,
      sigkillGraceMs: 10,
      maxProcessCount: 12,
      processLimitPollMs: 25,
    });

    assert.equal(result.processLimitExceeded, true);
    assert.equal(result.timedOut, false);
    assert.ok(Date.now() - started < 5_000);
    assert.notEqual(result.status, 0);
  });


  it('returns parent output promptly when inherited-stdio grandchildren outlive the parent', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-process-tree-inherited-stdio-'));
    const script = join(root, 'inherited-stdio.sh');
    await writeFile(script, [
      '#!/bin/sh',
      '(sleep 30) &',
      'printf "parent stdout\n"',
      'printf "parent stderr\n" >&2',
      'exit 7',
      '',
    ].join('\n'));
    chmodSync(script, 0o755);

    const started = Date.now();
    const result = await runProcessTreeWithTimeout(script, [], {
      timeoutMs: 10_000,
      sigkillGraceMs: 10,
    });

    assert.equal(result.timedOut, false);
    assert.equal(result.status, 7);
    assert.equal(result.stdout, 'parent stdout\n');
    assert.equal(result.stderr, 'parent stderr\n');
    assert.ok(Date.now() - started < 3_000, 'should not wait for grandchild sleep or timeout');
  });

  it('sweeps process-group grandchildren when the direct child exits', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-process-tree-orphan-'));
    const script = join(root, 'orphan.sh');
    const ready = join(root, 'ready');
    const term = join(root, 'term');
    await writeFile(script, [
      '#!/bin/sh',
      `(trap 'printf term > ${term}; exit 0' TERM; printf ready > ${ready}; sleep 30) >/dev/null 2>&1 &`,
      `while [ ! -f ${ready} ]; do sleep 0.01; done`,
      'printf "parent done\\n"',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(script, 0o755);

    const result = await runProcessTreeWithTimeout(script, [], { timeoutMs: 10_000 });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'parent done\n');
    for (let i = 0; i < 20 && !existsSync(term); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(existsSync(term), true);
    assert.equal(await readFile(term, 'utf8'), 'term');
  });
});
