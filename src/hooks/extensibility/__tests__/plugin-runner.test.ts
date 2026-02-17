import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const RESULT_PREFIX = '__OMX_PLUGIN_RESULT__ ';

function getRunnerPath(): string {
  // Resolve from dist after build
  return join(process.cwd(), 'dist', 'hooks', 'extensibility', 'plugin-runner.js');
}

function runRunner(
  input: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string; code: number | null; result: Record<string, unknown> | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [getRunnerPath()], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      const lines = stdout.split('\n').filter(Boolean);
      const resultLine = [...lines].reverse().find((l) => l.startsWith(RESULT_PREFIX));
      let result: Record<string, unknown> | null = null;
      if (resultLine) {
        try {
          result = JSON.parse(resultLine.slice(RESULT_PREFIX.length));
        } catch {
          result = null;
        }
      }
      resolve({ stdout, stderr, code, result });
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

describe('plugin-runner', () => {
  it('emits error for empty stdin', async () => {
    const { result, code } = await new Promise<{ result: Record<string, unknown> | null; code: number | null }>((resolve) => {
      const child = spawn(process.execPath, [getRunnerPath()], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.on('close', (exitCode) => {
        const lines = stdout.split('\n').filter(Boolean);
        const resultLine = [...lines].reverse().find((l) => l.startsWith(RESULT_PREFIX));
        let parsed: Record<string, unknown> | null = null;
        if (resultLine) {
          try { parsed = JSON.parse(resultLine.slice(RESULT_PREFIX.length)); } catch { parsed = null; }
        }
        resolve({ result: parsed, code: exitCode });
      });
      child.stdin.end('');
    });

    assert.ok(result);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'empty_request');
    assert.equal(code, 1);
  });

  it('emits error for invalid JSON', async () => {
    const { result, code } = await new Promise<{ result: Record<string, unknown> | null; code: number | null }>((resolve) => {
      const child = spawn(process.execPath, [getRunnerPath()], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.on('close', (exitCode) => {
        const lines = stdout.split('\n').filter(Boolean);
        const resultLine = [...lines].reverse().find((l) => l.startsWith(RESULT_PREFIX));
        let parsed: Record<string, unknown> | null = null;
        if (resultLine) {
          try { parsed = JSON.parse(resultLine.slice(RESULT_PREFIX.length)); } catch { parsed = null; }
        }
        resolve({ result: parsed, code: exitCode });
      });
      child.stdin.write('not json at all');
      child.stdin.end();
    });

    assert.ok(result);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_json');
    assert.equal(code, 1);
  });

  it('emits invalid_export for plugin without onHookEvent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runner-'));
    try {
      const pluginPath = join(cwd, 'no-export.mjs');
      await writeFile(pluginPath, 'export const x = 1;');

      const { result, code } = await runRunner({
        cwd,
        pluginId: 'no-export',
        pluginPath,
        event: {
          schema_version: '1',
          event: 'session-start',
          timestamp: new Date().toISOString(),
          source: 'native',
          context: {},
        },
      });

      assert.ok(result);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'invalid_export');
      assert.equal(code, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('emits ok for valid plugin', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runner-'));
    try {
      const pluginPath = join(cwd, 'valid.mjs');
      await writeFile(pluginPath, 'export async function onHookEvent(event, sdk) {}');

      const { result, code } = await runRunner({
        cwd,
        pluginId: 'valid',
        pluginPath,
        event: {
          schema_version: '1',
          event: 'session-start',
          timestamp: new Date().toISOString(),
          source: 'native',
          context: {},
        },
      });

      assert.ok(result);
      assert.equal(result.ok, true);
      assert.equal(result.reason, 'ok');
      assert.equal(result.plugin, 'valid');
      assert.equal(code, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('emits runner_error when plugin throws', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runner-'));
    try {
      const pluginPath = join(cwd, 'throws.mjs');
      await writeFile(pluginPath, 'export function onHookEvent() { throw new Error("boom"); }');

      const { result, code } = await runRunner({
        cwd,
        pluginId: 'throws',
        pluginPath,
        event: {
          schema_version: '1',
          event: 'session-start',
          timestamp: new Date().toISOString(),
          source: 'native',
          context: {},
        },
      });

      assert.ok(result);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'runner_error');
      assert.match(String(result.error), /boom/);
      assert.equal(code, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('derives pluginId from path when not provided', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runner-'));
    try {
      const pluginPath = join(cwd, 'derived-name.mjs');
      await writeFile(pluginPath, 'export async function onHookEvent() {}');

      const { result } = await runRunner({
        cwd,
        pluginPath,
        event: {
          schema_version: '1',
          event: 'session-start',
          timestamp: new Date().toISOString(),
          source: 'native',
          context: {},
        },
      });

      assert.ok(result);
      assert.equal(result.ok, true);
      assert.equal(result.plugin, 'derived-name.mjs');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
