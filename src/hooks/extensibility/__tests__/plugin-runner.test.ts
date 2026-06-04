import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readStdin } from '../plugin-runner-stdin.js';

const RESULT_PREFIX = '__OMX_PLUGIN_RESULT__ ';

function getRunnerPath(): string {
  // Resolve from dist after build
  return join(process.cwd(), 'dist', 'hooks', 'extensibility', 'plugin-runner.js');
}

function runRunner(
  input: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string; code: number | null; result: Record<string, unknown> | null }> {
  return runRunnerWithStdin([Buffer.from(JSON.stringify(input))]);
}

function runRunnerWithStdin(
  chunks: Array<string | Buffer | Uint8Array>,
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

    for (const chunk of chunks) {
      child.stdin.write(chunk);
    }
    child.stdin.end();
  });
}

function setEuroByteOffset(payload: Record<string, unknown>, targetOffset: number): Buffer {
  const event = payload.event as { context: { padding: string } };
  event.context.padding = '';
  const initial = Buffer.from(JSON.stringify(payload));
  const initialOffset = initial.indexOf(Buffer.from('€'));
  assert.notEqual(initialOffset, -1);
  assert.ok(initialOffset <= targetOffset, `initial euro offset ${initialOffset} exceeded target ${targetOffset}`);
  event.context.padding = 'a'.repeat(targetOffset - initialOffset);
  const encoded = Buffer.from(JSON.stringify(payload));
  assert.equal(encoded.indexOf(Buffer.from('€')), targetOffset);
  return encoded;
}

describe('plugin-runner', () => {
  it('reads stdin through async stream iteration without touching the fd', async () => {
    const chunks = ['  {"hello":', Buffer.from('"world"}'), '\n'];
    const stream = Readable.from(chunks, { encoding: 'utf-8' }) as Readable & { fd: number };
    Object.defineProperty(stream, 'fd', {
      get() {
        throw Object.assign(new Error('resource temporarily unavailable'), { code: 'EAGAIN' });
      },
    });

    assert.equal(await readStdin(stream), '{"hello":"world"}');
  });

  it('preserves multibyte UTF-8 split across input chunks', async () => {
    const encoded = Buffer.from('{"msg":"€"}');
    const euroOffset = encoded.indexOf(Buffer.from('€'));
    assert.notEqual(euroOffset, -1);

    const input = Readable.from([
      encoded.subarray(0, euroOffset + 1),
      encoded.subarray(euroOffset + 1),
    ]);

    assert.equal(await readStdin(input), '{"msg":"€"}');
  });

  it('preserves dispatcher-sized UTF-8 stdin payloads when multibyte bytes cross a stream boundary', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runner-utf8-'));
    try {
      const pluginPath = join(cwd, 'utf8-check.mjs');
      await writeFile(
        pluginPath,
        `export function onHookEvent(event) {
          if (event.context.msg !== '€') {
            throw new Error('expected euro, got ' + JSON.stringify(event.context.msg));
          }
        }`,
      );

      const payload = {
        cwd,
        pluginId: 'utf8-check',
        pluginPath,
        event: {
          schema_version: '1',
          event: 'session-start',
          timestamp: new Date().toISOString(),
          source: 'native',
          context: { padding: '', msg: '€' },
        },
      };
      const encoded = setEuroByteOffset(payload, 65_535);
      const euroOffset = encoded.indexOf(Buffer.from('€'));
      const { result, code } = await runRunnerWithStdin([
        encoded.subarray(0, euroOffset + 1),
        encoded.subarray(euroOffset + 1),
      ]);

      assert.ok(result);
      assert.equal(result.ok, true);
      assert.equal(result.reason, 'ok');
      assert.equal(code, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

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

  it('handles bounded concurrent piped runner requests', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runner-concurrent-'));
    try {
      const pluginPath = join(cwd, 'valid-concurrent.mjs');
      await writeFile(pluginPath, 'export async function onHookEvent() {}');
      const runs = 60;
      const concurrency = 20;
      let next = 0;
      const failures: Array<{ index: number; code: number | null; result: Record<string, unknown> | null; stderr: string }> = [];

      async function worker(): Promise<void> {
        while (next < runs) {
          const index = next++;
          const { result, code, stderr } = await runRunner({
            cwd,
            pluginId: `valid-concurrent-${index}`,
            pluginPath,
            event: {
              schema_version: '1',
              event: 'session-start',
              timestamp: new Date().toISOString(),
              source: 'native',
              context: { index },
            },
          });
          if (code !== 0 || result?.ok !== true || result?.reason !== 'ok') {
            failures.push({ index, code, result, stderr });
          }
        }
      }

      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      assert.deepEqual(failures, []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('exits promptly when a successful plugin leaves handles open', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runner-open-handle-'));
    try {
      const pluginPath = join(cwd, 'open-handle.mjs');
      await writeFile(
        pluginPath,
        'export async function onHookEvent() { setInterval(() => {}, 1000); }',
      );

      const startedAt = Date.now();
      const { result, code } = await Promise.race([
        runRunner({
          cwd,
          pluginId: 'open-handle',
          pluginPath,
          event: {
            schema_version: '1',
            event: 'session-start',
            timestamp: new Date().toISOString(),
            source: 'native',
            context: {},
          },
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('runner timed out')), 1000)),
      ]);

      assert.ok(Date.now() - startedAt < 1000);
      assert.ok(result);
      assert.equal(result.ok, true);
      assert.equal(result.reason, 'ok');
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
