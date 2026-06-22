import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { initTeamState, listDispatchRequests } from '../../team/state.js';
import {
  buildOmxApiServeArgs,
  daemonTokenFileForState,
  defaultOmxApiStateFile,
  OmxClient,
  OmxHttpError,
  parseSseFrame,
  parseSseStream,
  readOmxDaemonState,
  readOmxDaemonToken,
  startOmxApiDaemon,
  resolveOmxApiClientOptions,
  OmxTeamClient,
  OmxCatalogClient,
  OmxRuntimeClient,
  buildCodexForkArgs,
  buildOmxExecSkillArgs,
  buildOmxResumeArgs,
  resolveCodexProfile,
  codexProfileToApiEnv,
} from '../index.js';

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('OmxClient', () => {
  it('calls the local responses endpoint with bearer auth and extracts generated text', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new OmxClient({
      baseUrl: 'http://127.0.0.1:14510/',
      bearerToken: 'local-token',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ output_text: 'hello sdk' });
      }) as typeof fetch,
    });

    assert.equal(await client.generateText('hello'), 'hello sdk');
    assert.equal(calls[0]?.url, 'http://127.0.0.1:14510/v1/responses');
    assert.equal(calls[0]?.init?.method, 'POST');
    assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, 'Bearer local-token');
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { input: 'hello', stream: false });
  });



  it('keeps transport options out of JSON payloads and forwards AbortSignal', async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    const client = new OmxClient({
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push({ init });
        return jsonResponse({ output_text: 'ok' });
      }) as typeof fetch,
    });
    const controller = new AbortController();

    await client.responses.create(
      { input: 'hello', signal: controller.signal, timeoutMs: 123 } as unknown as Parameters<typeof client.responses.create>[0],
      { signal: controller.signal },
    );

    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { input: 'hello', stream: false });
    assert.equal(calls[0]?.init?.signal, controller.signal);
  });

  it('raises OmxHttpError with the API error payload', async () => {
    const client = new OmxClient({
      fetchImpl: (async () => jsonResponse({ error: { message: 'nope', type: 'bad' } }, { status: 401, statusText: 'Unauthorized' })) as typeof fetch,
    });

    await assert.rejects(
      client.health(),
      (error: unknown) => {
        assert.ok(error instanceof OmxHttpError);
        assert.equal(error.status, 401);
        assert.equal(error.body?.error?.type, 'bad');
        assert.equal(error.message, 'nope');
        return true;
      },
    );
  });

  it('parses named and unnamed SSE frames', () => {
    assert.deepEqual(parseSseFrame('event: response.output_text.delta\ndata: {"delta":"hi"}'), {
      event: 'response.output_text.delta',
      data: { delta: 'hi' },
      raw: 'event: response.output_text.delta\ndata: {"delta":"hi"}',
    });
    assert.equal(parseSseFrame('data: [DONE]'), null);
  });

  it('streams CRLF-delimited SSE frames across chunk boundaries', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: one\r\ndata: {"delta":'));
        controller.enqueue(encoder.encode('"a"}\r\n\r\ndata: {"delta":"b"}\r\n\r\ndata: [DONE]\r\n\r\n'));
        controller.close();
      },
    });
    const events = [];
    for await (const event of parseSseStream(new Response(body))) events.push(event);
    assert.deepEqual(events.map((event) => event.data), [{ delta: 'a' }, { delta: 'b' }]);
    assert.equal(events[0]?.event, 'one');
  });
});

describe('OMX API daemon helpers', () => {
  it('resolves client options from daemon state and token files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-state-'));
    try {
      const stateFile = join(dir, 'daemon.json');
      const tokenFile = daemonTokenFileForState(stateFile);
      await writeFile(stateFile, JSON.stringify({
        pid: 123,
        host: '127.0.0.1',
        port: 15151,
        backend: 'mock',
        started_at_unix: 1,
        local_bearer_token_file: tokenFile,
      }));
      await writeFile(tokenFile, 'abc123\n');
      await chmod(tokenFile, 0o600);

      assert.equal(await readOmxDaemonToken(stateFile), 'abc123');
      assert.deepEqual(await resolveOmxApiClientOptions({ stateFile, env: {} }), {
        baseUrl: 'http://127.0.0.1:15151',
        bearerToken: 'abc123',
        fetchImpl: undefined,
        timeoutMs: undefined,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });



  it('uses daemon token fallback when OMX_API_BASE_URL matches daemon state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-baseurl-token-'));
    try {
      const stateFile = join(dir, 'daemon.json');
      const tokenFile = daemonTokenFileForState(stateFile);
      await writeFile(stateFile, JSON.stringify({
        pid: 123,
        host: '127.0.0.1',
        port: 15151,
        backend: 'mock',
        started_at_unix: 1,
        local_bearer_token_file: tokenFile,
      }));
      await writeFile(tokenFile, 'token-from-file\n');
      await chmod(tokenFile, 0o600);

      assert.deepEqual(await resolveOmxApiClientOptions({ stateFile, env: { OMX_API_BASE_URL: 'http://127.0.0.1:15151' } }), {
        baseUrl: 'http://127.0.0.1:15151',
        bearerToken: 'token-from-file',
        fetchImpl: undefined,
        timeoutMs: undefined,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not forward daemon token fallback to unrelated OMX_API_BASE_URL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-baseurl-no-token-'));
    try {
      const stateFile = join(dir, 'daemon.json');
      const tokenFile = daemonTokenFileForState(stateFile);
      await writeFile(stateFile, JSON.stringify({
        pid: 123,
        host: '127.0.0.1',
        port: 15151,
        backend: 'mock',
        started_at_unix: 1,
        local_bearer_token_file: tokenFile,
      }));
      await writeFile(tokenFile, 'token-from-file\n');
      await chmod(tokenFile, 0o600);

      assert.deepEqual(await resolveOmxApiClientOptions({ stateFile, env: { OMX_API_BASE_URL: 'http://127.0.0.1:16666' } }), {
        baseUrl: 'http://127.0.0.1:16666',
        bearerToken: undefined,
        fetchImpl: undefined,
        timeoutMs: undefined,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not forward daemon token fallback to decorated matching base URLs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-baseurl-decorated-no-token-'));
    try {
      const stateFile = join(dir, 'daemon.json');
      const tokenFile = daemonTokenFileForState(stateFile);
      await writeFile(stateFile, JSON.stringify({
        pid: 123,
        host: '127.0.0.1',
        port: 15151,
        backend: 'mock',
        started_at_unix: 1,
        local_bearer_token_file: tokenFile,
      }));
      await writeFile(tokenFile, 'token-from-file\n');
      await chmod(tokenFile, 0o600);

      for (const baseUrl of [
        'http://user:pass@127.0.0.1:15151',
        'http://127.0.0.1:15151/proxy',
        'http://127.0.0.1:15151?target=proxy',
      ]) {
        assert.deepEqual(await resolveOmxApiClientOptions({ baseUrl, stateFile, env: {} }), {
          baseUrl,
          bearerToken: undefined,
          fetchImpl: undefined,
          timeoutMs: undefined,
        });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not forward OMX_API_LOCAL_BEARER to unrelated OMX_API_BASE_URL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-baseurl-explicit-token-'));
    try {
      assert.deepEqual(await resolveOmxApiClientOptions({
        stateFile: join(dir, 'missing.json'),
        env: {
          OMX_API_BASE_URL: 'http://127.0.0.1:16666',
          OMX_API_LOCAL_BEARER: 'explicit-env-token',
        },
      }), {
        baseUrl: 'http://127.0.0.1:16666',
        bearerToken: undefined,
        fetchImpl: undefined,
        timeoutMs: undefined,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses explicit bearerToken option for custom OMX_API_BASE_URL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-baseurl-explicit-token-'));
    try {
      assert.deepEqual(await resolveOmxApiClientOptions({
        bearerToken: 'option-token',
        stateFile: join(dir, 'missing.json'),
        env: {
          OMX_API_BASE_URL: 'http://127.0.0.1:16666',
          OMX_API_LOCAL_BEARER: 'env-token',
        },
      }), {
        baseUrl: 'http://127.0.0.1:16666',
        bearerToken: 'option-token',
        fetchImpl: undefined,
        timeoutMs: undefined,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not forward OMX_API_LOCAL_BEARER to unrelated explicit baseUrl option', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-option-baseurl-no-token-'));
    try {
      assert.deepEqual(await resolveOmxApiClientOptions({
        baseUrl: 'http://127.0.0.1:16666',
        stateFile: join(dir, 'missing.json'),
        env: { OMX_API_LOCAL_BEARER: 'env-token' },
      }), {
        baseUrl: 'http://127.0.0.1:16666',
        bearerToken: undefined,
        fetchImpl: undefined,
        timeoutMs: undefined,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsafe daemon token files', { skip: process.platform === 'win32' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-unsafe-token-'));
    try {
      const stateFile = join(dir, 'daemon.json');
      const tokenFile = daemonTokenFileForState(stateFile);
      await writeFile(stateFile, JSON.stringify({
        pid: 123,
        host: '127.0.0.1',
        port: 15151,
        backend: 'mock',
        started_at_unix: 1,
        local_bearer_token_file: tokenFile,
      }));
      await writeFile(tokenFile, 'unsafe-token\n');
      await chmod(tokenFile, 0o644);

      assert.equal(await readOmxDaemonToken(stateFile), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects daemon token paths that are not files', { skip: process.platform === 'win32' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-token-dir-'));
    try {
      const stateFile = join(dir, 'daemon.json');
      const tokenPath = join(dir, 'token-dir');
      await mkdir(tokenPath);
      await writeFile(stateFile, JSON.stringify({
        pid: 123,
        host: '127.0.0.1',
        port: 15151,
        backend: 'mock',
        started_at_unix: 1,
        local_bearer_token_file: tokenPath,
      }));

      assert.equal(await readOmxDaemonToken(stateFile), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back when daemon state or token files are malformed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-corrupt-state-'));
    try {
      const stateFile = join(dir, 'daemon.json');
      await writeFile(stateFile, '{not-json');
      await writeFile(daemonTokenFileForState(stateFile), 'token');

      assert.equal(await readOmxDaemonState(stateFile), null);
      assert.equal(await readOmxDaemonToken(stateFile), undefined);
      assert.deepEqual(await resolveOmxApiClientOptions({ stateFile, env: { OMX_API_PORT: 'not-a-port' } }), {
        baseUrl: 'http://127.0.0.1:14510',
        bearerToken: undefined,
        fetchImpl: undefined,
        timeoutMs: undefined,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores daemon state with an unusable port', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-bad-state-port-'));
    try {
      const stateFile = join(dir, 'daemon.json');
      await writeFile(stateFile, JSON.stringify({
        pid: 123,
        host: '127.0.0.1',
        port: 0,
        backend: 'mock',
        started_at_unix: 1,
      }));

      assert.equal(await readOmxDaemonState(stateFile), null);
      assert.deepEqual(await resolveOmxApiClientOptions({ stateFile, env: { OMX_API_PORT: '15556' } }), {
        baseUrl: 'http://127.0.0.1:15556',
        bearerToken: undefined,
        fetchImpl: undefined,
        timeoutMs: undefined,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses OMX_API_STATE_FILE before the SDK user-scoped default state file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-env-state-file-'));
    try {
      const stateFile = join(dir, 'daemon.json');
      await writeFile(stateFile, JSON.stringify({
        pid: 123,
        host: '127.0.0.1',
        port: 16667,
        backend: 'mock',
        started_at_unix: 1,
      }));

      assert.equal(defaultOmxApiStateFile().includes('/tmp/omx-api-daemon.json'), false);
      assert.deepEqual(await resolveOmxApiClientOptions({ env: { OMX_API_STATE_FILE: stateFile } }), {
        baseUrl: 'http://127.0.0.1:16667',
        bearerToken: undefined,
        fetchImpl: undefined,
        timeoutMs: undefined,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });



  it('uses a valid OMX_API_PORT fallback when no daemon state exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-env-port-'));
    try {
      assert.deepEqual(await resolveOmxApiClientOptions({ stateFile: join(dir, 'missing.json'), env: { OMX_API_PORT: '15555' } }), {
        baseUrl: 'http://127.0.0.1:15555',
        bearerToken: undefined,
        fetchImpl: undefined,
        timeoutMs: undefined,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('builds stable omx-api serve argv', () => {
    assert.deepEqual(buildOmxApiServeArgs({
      host: '127.0.0.1',
      port: 14510,
      backend: 'mock',
      stateFile: '/tmp/omx-api.json',
    }), [
      'serve',
      '--host',
      '127.0.0.1',
      '--port',
      '14510',
      '--backend',
      'mock',
      '--state-file',
      '/tmp/omx-api.json',
    ]);
  });




  it('does not accept stale daemon state present before startup', { skip: process.platform === 'win32' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-daemon-stale-'));
    try {
      const script = join(dir, 'no-state-api');
      await writeFile(script, `#!/bin/sh
exit 0
`);
      await chmod(script, 0o755);
      const stateFile = join(dir, 'daemon.json');
      await writeFile(stateFile, JSON.stringify({ pid: 999999, host: '127.0.0.1', port: 19999, backend: 'mock', started_at_unix: 1 }));

      await assert.rejects(
        startOmxApiDaemon({ binaryPath: script, stateFile, port: 17777, startupTimeoutMs: 1_000 }),
        /exited before writing daemon state|did not write daemon state/,
      );
      assert.equal(await readOmxDaemonState(stateFile), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('includes daemon stderr when startup exits before writing state', { skip: process.platform === 'win32' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-daemon-fail-'));
    try {
      const script = join(dir, 'fail-api');
      await writeFile(script, `#!/bin/sh
echo "bind failed for sdk test" 1>&2
exit 17
`);
      await chmod(script, 0o755);

      await assert.rejects(
        startOmxApiDaemon({ binaryPath: script, stateFile: join(dir, 'daemon.json'), startupTimeoutMs: 1_000 }),
        /bind failed for sdk test/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('starts from a stub daemon state and cleans state files on stop', { skip: process.platform === 'win32' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-daemon-ok-'));
    try {
      const script = join(dir, 'stub-api');
      await writeFile(script, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
const stateFile = valueAfter('--state-file');
const host = valueAfter('--host');
const port = Number(valueAfter('--port'));
const backend = valueAfter('--backend');
fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, host, port, backend, started_at_unix: 1 }));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`);
      await chmod(script, 0o755);
      const stateFile = join(dir, 'daemon.json');
      const daemon = await startOmxApiDaemon({
        binaryPath: script,
        stateFile,
        port: 16666,
        startupTimeoutMs: 1_000,
      });

      assert.equal(daemon.baseUrl, 'http://127.0.0.1:16666');
      await daemon.stop({ timeoutMs: 50 });
      assert.equal(await readOmxDaemonState(stateFile), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('requires port 0 daemon state to report the assigned port', { skip: process.platform === 'win32' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-daemon-port-zero-'));
    try {
      const script = join(dir, 'stub-api');
      await writeFile(script, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
const stateFile = valueAfter('--state-file');
const host = valueAfter('--host');
const port = Number(valueAfter('--port'));
const backend = valueAfter('--backend');
fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, host, port, backend, started_at_unix: 1 }));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`);
      await chmod(script, 0o755);

      await assert.rejects(
        startOmxApiDaemon({ binaryPath: script, stateFile: join(dir, 'daemon.json'), port: 0, startupTimeoutMs: 200 }),
        /did not write daemon state/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses a private managed state directory when no stateFile is provided', { skip: process.platform === 'win32' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-daemon-managed-'));
    try {
      const script = join(dir, 'stub-api');
      await writeFile(script, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
const stateFile = valueAfter('--state-file');
const host = valueAfter('--host');
const port = Number(valueAfter('--port'));
const backend = valueAfter('--backend');
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, host, port, backend, started_at_unix: 1 }));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`);
      await chmod(script, 0o755);
      const daemon = await startOmxApiDaemon({
        binaryPath: script,
        port: 16669,
        startupTimeoutMs: 1_000,
      });
      const stateDir = dirname(daemon.stateFile);
      const stateDirStats = await stat(stateDir);

      assert.match(stateDir, /omx-api-daemon-/);
      assert.equal(stateDirStats.mode & 0o077, 0);
      await daemon.stop({ timeoutMs: 50 });
      await assert.rejects(stat(stateDir), /ENOENT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('maps a Codex profile into daemon API env without overriding explicit env', { skip: process.platform === 'win32' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-daemon-profile-'));
    try {
      const codexHome = join(dir, 'codex-home');
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, 'config.toml'), 'model_provider = "base-provider"\n');
      await writeFile(join(codexHome, 'gpt55.config.toml'), 'model = "profile-model"\nmodel_reasoning_effort = "high"\n');

      const envOut = join(dir, 'env.json');
      const script = join(dir, 'stub-api');
      await writeFile(script, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
const stateFile = valueAfter('--state-file');
const host = valueAfter('--host');
const port = Number(valueAfter('--port'));
const backend = valueAfter('--backend');
fs.writeFileSync(${JSON.stringify(envOut)}, JSON.stringify({
  profile: process.env.OMX_API_CODEX_PROFILE,
  model: process.env.OMX_API_GENERATE_MODEL,
  provider: process.env.OMX_API_CODEX_MODEL_PROVIDER,
  effort: process.env.OMX_API_CODEX_REASONING_EFFORT
}));
fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, host, port, backend, started_at_unix: 1 }));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`);
      await chmod(script, 0o755);
      const daemon = await startOmxApiDaemon({
        binaryPath: script,
        stateFile: join(dir, 'daemon.json'),
        port: 16670,
        startupTimeoutMs: 1_000,
        profile: 'gpt55',
        codexHome,
        env: {
          ...process.env,
          OMX_API_GENERATE_MODEL: 'explicit-model',
          OMX_API_CODEX_MODEL_PROVIDER: '',
        },
      });
      await daemon.stop({ timeoutMs: 50 });

      assert.deepEqual(JSON.parse(await readFile(envOut, 'utf-8')), {
        profile: 'gpt55',
        model: 'explicit-model',
        provider: 'base-provider',
        effort: 'high',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });


  it('does not remove a state file that has been replaced by another daemon pid', { skip: process.platform === 'win32' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-sdk-daemon-mismatch-'));
    try {
      const script = join(dir, 'stub-api');
      await writeFile(script, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
const stateFile = valueAfter('--state-file');
const host = valueAfter('--host');
const port = Number(valueAfter('--port'));
const backend = valueAfter('--backend');
fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, host, port, backend, started_at_unix: 1 }));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`);
      await chmod(script, 0o755);
      const stateFile = join(dir, 'daemon.json');
      const daemon = await startOmxApiDaemon({ binaryPath: script, stateFile, port: 16667, startupTimeoutMs: 1_000 });
      await writeFile(stateFile, JSON.stringify({ pid: 999999, host: '127.0.0.1', port: 16668, backend: 'mock', started_at_unix: 2 }));

      await daemon.stop({ timeoutMs: 50 });
      assert.equal((await readOmxDaemonState(stateFile))?.pid, 999999);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});



describe('OmxTeamClient', () => {
  it('sends mailbox messages and exposes queued dispatch outcomes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-team-queue-'));
    try {
      await initTeamState('sdk-queue', 'sdk queue test', 'executor', 2, cwd);
      const team = new OmxTeamClient({ cwd });

      const result = await team.sendMessage({
        teamName: 'sdk-queue',
        fromWorker: 'worker-1',
        toWorker: 'worker-2',
        body: 'queued hello',
      });

      assert.equal(result.message.body, 'queued hello');
      assert.equal(result.dispatch.reason, 'queued_for_hook_dispatch');
      assert.equal(result.dispatch.message_id, result.message.message_id);

      const mailbox = await team.mailboxList({ teamName: 'sdk-queue', worker: 'worker-2', includeDelivered: false });
      assert.equal(mailbox.count, 1);
      assert.equal(mailbox.messages[0]?.message_id, result.message.message_id);

      const requests = await listDispatchRequests('sdk-queue', cwd, { kind: 'mailbox' });
      assert.equal(requests.some((request) => request.message_id === result.message.message_id), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('wraps team task lifecycle operations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-team-tasks-'));
    try {
      await initTeamState('sdk-tasks', 'sdk task test', 'executor', 2, cwd);
      const team = new OmxTeamClient({ cwd });

      const task = await team.createTask({
        teamName: 'sdk-tasks',
        subject: 'Review SDK task API',
        description: 'Verify task wrappers expose existing team API operations.',
      });
      assert.equal(task.subject, 'Review SDK task API');

      const tasks = await team.listTasks('sdk-tasks');
      assert.equal(tasks.count, 1);
      assert.equal(tasks.tasks[0]?.id, task.id);

      const read = await team.readTask({ teamName: 'sdk-tasks', taskId: task.id });
      assert.equal(read.description, 'Verify task wrappers expose existing team API operations.');

      const updated = await team.updateTask({
        teamName: 'sdk-tasks',
        taskId: task.id,
        subject: 'Review complete SDK task API',
      });
      assert.equal(updated.subject, 'Review complete SDK task API');

      const claim = await team.claimTask({
        teamName: 'sdk-tasks',
        taskId: task.id,
        worker: 'worker-1',
        expectedVersion: updated.version ?? 1,
      });
      assert.equal(typeof claim.claimToken, 'string');
      assert.equal(claim.task?.status, 'in_progress');
      const transitioned = await team.transitionTaskStatus({
        teamName: 'sdk-tasks',
        taskId: task.id,
        from: 'in_progress',
        to: 'completed',
        claimToken: String(claim.claimToken),
        result: 'SDK wrapper test completed',
      });
      assert.equal((transitioned.task as { status?: string } | undefined)?.status, 'completed');

      const approval = await team.writeTaskApproval({
        teamName: 'sdk-tasks',
        taskId: task.id,
        status: 'approved',
        reviewer: 'leader-fixed',
        decisionReason: 'SDK wrapper test',
      });
      assert.equal(approval.status, 'approved');
      assert.equal((await team.readTaskApproval({ teamName: 'sdk-tasks', taskId: task.id })).approval && true, true);

      const heartbeat = await team.updateWorkerHeartbeat({
        teamName: 'sdk-tasks',
        worker: 'worker-1',
        pid: process.pid,
        turnCount: 1,
        alive: true,
      });
      assert.equal(heartbeat.worker, 'worker-1');
      assert.equal((await team.readWorkerHeartbeat({ teamName: 'sdk-tasks', worker: 'worker-1' })).worker, 'worker-1');

      const events = await team.readEvents({ teamName: 'sdk-tasks' });
      assert.equal(typeof events.count, 'number');
      assert.equal((await team.operation('read-events', { team_name: 'sdk-tasks' })).count, events.count);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('OmxCatalogClient and runtime command builders', () => {
  it('lists skills and builds skill prompts without invoking workflows', async () => {
    const catalog = new OmxCatalogClient();
    assert.ok(catalog.listSkills().some((skill) => skill.name === 'ralph'));
    assert.ok(catalog.listAgents().some((agent) => agent.name === 'executor'));
    assert.match(await catalog.readSkill('ralph'), /Ralph/i);
    assert.match(await catalog.readAgent('executor'), /executor/i);
    assert.equal(catalog.skillPrompt('ralph', { args: 'ship the SDK' }), '$ralph ship the SDK');
    assert.equal(catalog.agentPrompt('executor', { prompt: 'ship the SDK' }), 'Use the executor role: ship the SDK');
    assert.throws(() => catalog.skillPath('../ralph'), /Invalid OMX skill name/);
  });

  it('builds resume, fork, and skill command argv with profile support', () => {
    assert.deepEqual(buildOmxResumeArgs({
      last: true,
      profile: 'gpt55',
      madmax: true,
      prompt: 'continue',
    }), [
      'resume',
      '--last',
      '--profile',
      'gpt55',
      '--dangerously-bypass-approvals-and-sandbox',
      'continue',
    ]);

    assert.deepEqual(buildCodexForkArgs({
      sessionId: 'session-1',
      profile: 'gpt55',
      prompt: 'branch this',
    }), ['fork', '--profile', 'gpt55', 'session-1', 'branch this']);

    assert.deepEqual(buildOmxExecSkillArgs({
      skill: 'ralph',
      prompt: 'verify SDK',
      profile: 'gpt55',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
      madmax: true,
      direct: true,
    }), ['exec', '--direct', '--profile', 'gpt55', '--model', 'gpt-5.5', '--madmax', '-c', 'model_reasoning_effort="high"', '$ralph verify SDK']);

    const runtime = new OmxRuntimeClient({ cwd: process.cwd() });
    assert.deepEqual(runtime.buildForkArgs({ last: true }), ['fork', '--last']);
    assert.throws(() => buildOmxExecSkillArgs({ skill: 'bad skill' }), /Invalid OMX skill name/);
  });

  it('allows runtime launcher stdout to be captured with custom spawn options', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-runtime-spawn-'));
    try {
      const omxBin = join(cwd, 'omx-stub.js');
      await writeFile(omxBin, `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));\n`);
      const runtime = new OmxRuntimeClient({
        cwd,
        omxBin,
        spawnOptions: { stdio: ['ignore', 'pipe', 'pipe'] },
      });

      const child = runtime.runSkill({ skill: 'ralph', prompt: 'verify SDK' });
      let stdout = '';
      child.stdout?.setEncoding('utf-8');
      child.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });
      const code = await new Promise<number | null>((resolvePromise, reject) => {
        child.once('error', reject);
        child.once('close', resolvePromise);
      });

      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(stdout), { argv: ['exec', '$ralph verify SDK'] });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('Codex profile resolution', () => {
  it('layers a Codex profile config and maps API-relevant env', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-sdk-codex-home-'));
    try {
      await writeFile(join(codexHome, 'config.toml'), 'model = "base-model"\nmodel_provider = "base-provider"\n');
      await writeFile(join(codexHome, 'gpt55.config.toml'), 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n');

      const profile = await resolveCodexProfile({ profile: 'gpt55', codexHome, env: {} });
      assert.equal(profile.model, 'gpt-5.5');
      assert.equal(profile.modelProvider, 'base-provider');
      assert.equal(profile.reasoningEffort, 'high');
      assert.deepEqual(codexProfileToApiEnv(profile), {
        OMX_API_CODEX_PROFILE: 'gpt55',
        OMX_API_GENERATE_MODEL: 'gpt-5.5',
        OMX_API_CODEX_MODEL_PROVIDER: 'base-provider',
        OMX_API_CODEX_REASONING_EFFORT: 'high',
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});

describe('OmxWorkspace', () => {
  it('reads session and scoped HUD state', async () => {
    const { OmxWorkspace } = await import('../index.js');
    const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-workspace-'));
    try {
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: 's1', cwd }));
      await mkdir(join(cwd, '.omx', 'state', 'sessions', 's1'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'sessions', 's1', 'hud-state.json'), JSON.stringify({ turn_count: 2 }));

      const workspace = new OmxWorkspace({ cwd, sessionId: 's1' });
      assert.equal((await workspace.readSession())?.session_id, 's1');
      assert.equal((await workspace.readHud())?.turn_count, 2);
      assert.equal((await workspace.scope()).stateDir, join(cwd, '.omx', 'state', 'sessions', 's1'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
