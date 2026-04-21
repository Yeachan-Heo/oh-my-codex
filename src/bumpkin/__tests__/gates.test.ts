import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { CommandRunner, GateContext } from '../gates/types.js';
import {
  buildGate,
  bundleSizeGate,
  lintGate,
  previewDeployGate,
  testsPassGate,
  typeCheckGate,
} from '../gates/registry.js';

function stubRun(output: {
  code: number;
  stdout?: string;
  stderr?: string;
}): { run: CommandRunner; calls: Array<{ cmd: string; args: readonly string[]; cwd: string | undefined }> } {
  const calls: Array<{ cmd: string; args: readonly string[]; cwd: string | undefined }> = [];
  const run: CommandRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    return { code: output.code, stdout: output.stdout ?? '', stderr: output.stderr ?? '' };
  };
  return { run, calls };
}

function ctxWith(run: CommandRunner, baseline: Record<string, unknown> = {}): GateContext {
  return { workspacePath: '/tmp/ws', run, baseline };
}

describe('bumpkin/gates', () => {
  it('testsPassGate passes when the test command exits 0', async () => {
    const { run, calls } = stubRun({ code: 0, stdout: 'all tests passed' });
    const gate = testsPassGate();
    const verdict = await gate.run(ctxWith(run));
    assert.equal(verdict.pass, true);
    assert.match(verdict.reason, /passed/);
    assert.equal(calls[0]?.cmd, 'npm');
    assert.deepEqual(calls[0]?.args, ['test']);
    assert.equal(calls[0]?.cwd, '/tmp/ws');
  });

  it('testsPassGate fails with stderr context when command exits non-zero', async () => {
    const { run } = stubRun({ code: 1, stderr: 'FAIL: auth.test' });
    const verdict = await testsPassGate().run(ctxWith(run));
    assert.equal(verdict.pass, false);
    assert.match(verdict.reason, /test suite failed/);
    assert.match(verdict.reason, /FAIL: auth\.test/);
    assert.equal(verdict.artifacts?.exitCode, 1);
  });

  it('testsPassGate accepts a custom command', async () => {
    const { run, calls } = stubRun({ code: 0 });
    await testsPassGate({ command: ['pytest', '-x'] }).run(ctxWith(run));
    assert.equal(calls[0]?.cmd, 'pytest');
    assert.deepEqual(calls[0]?.args, ['-x']);
  });

  it('typeCheckGate defaults to tsc --noEmit', async () => {
    const { run, calls } = stubRun({ code: 0 });
    await typeCheckGate().run(ctxWith(run));
    assert.equal(calls[0]?.cmd, 'npx');
    assert.deepEqual(calls[0]?.args, ['tsc', '--noEmit']);
  });

  it('buildGate defaults to npm run build', async () => {
    const { run, calls } = stubRun({ code: 0 });
    await buildGate().run(ctxWith(run));
    assert.deepEqual(calls[0]?.args, ['run', 'build']);
  });

  it('lintGate passes when warnings are at or below baseline', async () => {
    const { run } = stubRun({ code: 0, stdout: '3 warnings' });
    const verdict = await lintGate().run(ctxWith(run, { lintWarnings: 3 }));
    assert.equal(verdict.pass, true);
    assert.equal(verdict.artifacts?.warnings, 3);
  });

  it('lintGate fails when warnings regress above baseline', async () => {
    const { run } = stubRun({ code: 0, stdout: '5 warnings' });
    const verdict = await lintGate().run(ctxWith(run, { lintWarnings: 3 }));
    assert.equal(verdict.pass, false);
    assert.match(verdict.reason, /regressed: 5 > baseline 3/);
  });

  it('lintGate fails when linter exits non-zero', async () => {
    const { run } = stubRun({ code: 2, stderr: 'eslint config missing' });
    const verdict = await lintGate().run(ctxWith(run));
    assert.equal(verdict.pass, false);
    assert.match(verdict.reason, /lint failed/);
  });

  it('bundleSizeGate passes when no baseline is recorded', async () => {
    const { run } = stubRun({ code: 0 });
    const gate = bundleSizeGate({ measure: async () => 100_000 });
    const verdict = await gate.run(ctxWith(run));
    assert.equal(verdict.pass, true);
    assert.equal(verdict.artifacts?.baseline, null);
  });

  it('bundleSizeGate passes when bundle within ratio of baseline', async () => {
    const { run } = stubRun({ code: 0 });
    const gate = bundleSizeGate({ measure: async () => 105_000, maxIncreaseRatio: 1.1 });
    const verdict = await gate.run(ctxWith(run, { bundleBytes: 100_000 }));
    assert.equal(verdict.pass, true);
  });

  it('bundleSizeGate fails when bundle exceeds ratio', async () => {
    const { run } = stubRun({ code: 0 });
    const gate = bundleSizeGate({ measure: async () => 120_000, maxIncreaseRatio: 1.1 });
    const verdict = await gate.run(ctxWith(run, { bundleBytes: 100_000 }));
    assert.equal(verdict.pass, false);
    assert.match(verdict.reason, /bundle grew from 100000 to 120000/);
  });

  it('previewDeployGate passes when preview responds ok', async () => {
    const { run } = stubRun({ code: 0 });
    const gate = previewDeployGate({ checkPreview: async () => ({ ok: true, url: 'https://preview.example' }) });
    const verdict = await gate.run(ctxWith(run));
    assert.equal(verdict.pass, true);
    assert.match(verdict.reason, /preview deploy ok/);
  });

  it('previewDeployGate fails with the underlying message', async () => {
    const { run } = stubRun({ code: 0 });
    const gate = previewDeployGate({ checkPreview: async () => ({ ok: false, message: '502 Bad Gateway' }) });
    const verdict = await gate.run(ctxWith(run));
    assert.equal(verdict.pass, false);
    assert.match(verdict.reason, /502 Bad Gateway/);
  });
});
