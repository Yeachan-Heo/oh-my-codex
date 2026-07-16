// @ts-nocheck
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  ensureRepoDependencies,
  hasUsableNodeModules,
  buildPackedRegressionEnvironment,
  CODEX_APP_SERVER_TIMEOUTS,
  CodexAppServer,
  CodexExecutableNotFoundError,
  MANAGED_CODEX_HOOK_EVENTS,
  PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS,
  PACKED_INSTALL_NATIVE_HOOK_REGRESSION_PROMPTS,
  PACKED_INSTALL_SMOKE_CORE_COMMANDS,
  appendForeignHookGroups,
  appendDisplayOrderStableForeignHookGroups,
  buildNativeHookSmokePayload,
  createCodexBatchWriteEnvelope,
  createCodexHooksListEnvelope,
  createCodexInitializeEnvelope,
  foreignHookGroupSnapshot,
  generatedHookTrustState,
  parseNpmPackJsonOutput,
  parseCodexHooksListResult,
  probeCodexVersion,
  resolveGitCommonDir,
  resolveReusableNodeModulesSource,
  validateHookStdout,
  assertCodexBatchWriteResult,
  assertGeneratedTrustMatchesCodex,
  managedCodexHooksByEvent,
} from '../smoke-packed-install.js';

function createFakeCodexAppServer(
  onRequest: (request: Record<string, unknown>, child: EventEmitter & Record<string, unknown>) => void,
): CodexAppServer {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  child.stdin.on('data', (chunk: Buffer) => onRequest(JSON.parse(chunk.toString('utf-8')), child));
  child.stdin.on('finish', () => child.emit('close', 0, null));
  return new CodexAppServer(child as never);
}


test('packed install smoke retains narrow boot commands and adds the isolated lifecycle separately', () => {
  assert.deepEqual(PACKED_INSTALL_SMOKE_CORE_COMMANDS, [
    ['--help'],
    ['version'],
    ['api', '--help'],
    ['sparkshell', '--help'],
  ]);
  assert.equal(
    PACKED_INSTALL_SMOKE_CORE_COMMANDS.some((argv) => argv.includes('api')),
    true,
  );
  assert.equal(
    PACKED_INSTALL_SMOKE_CORE_COMMANDS.some((argv) => argv.includes('sparkshell')),
    true,
  );
});

test('packed lifecycle keeps the pinned newline-delimited Codex app-server envelopes literal', () => {
  assert.deepEqual(createCodexInitializeEnvelope('omx-hook-trust-regression'), {
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: { name: 'omx-hook-trust-regression', version: '1.0.0' },
      capabilities: null,
    },
  });
  assert.deepEqual(createCodexHooksListEnvelope('/tmp/project'), {
    id: 2,
    method: 'hooks/list',
    params: { cwds: ['/tmp/project'] },
  });
  assert.deepEqual(createCodexBatchWriteEnvelope({ first: 'sha256:first', second: 'sha256:second' }), {
    id: 3,
    method: 'config/batchWrite',
    params: {
      edits: [{
        keyPath: 'hooks.state',
        value: {
          first: { trusted_hash: 'sha256:first' },
          second: { trusted_hash: 'sha256:second' },
        },
        mergeStrategy: 'upsert',
      }],
      filePath: null,
      expectedVersion: null,
      reloadUserConfig: true,
    },
  });
  assert.deepEqual(CODEX_APP_SERVER_TIMEOUTS, {
    versionProbeMs: 2_000,
    initializeMs: 15_000,
    requestMs: 10_000,
    shutdownMs: 5_000,
  });
});
test('Codex app-server accepts method-bearing notifications but rejects invalid idless envelopes', async () => {
  const accepted = createFakeCodexAppServer((request, child) => {
    child.stdout.write(`${JSON.stringify({ method: 'thread/started', params: { thread: 'fake' } })}\n`);
    child.stdout.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
  });
  assert.deepEqual(await accepted.request({ id: 1, method: 'hooks/list' }, 100), { ok: true });
  await accepted.close();

  for (const envelope of [
    { result: { invalid: true } },
    { error: { code: -1, message: 'invalid' } },
    { unknown: true },
    { method: '   ' },
    { method: 'thread/started', result: { invalid: true } },
  ]) {
    const server = createFakeCodexAppServer((_request, child) => {
      child.stdout.write(`${JSON.stringify(envelope)}\n`);
    });
    await assert.rejects(
      server.request({ id: 1, method: 'hooks/list' }, 100),
      /invalid idless JSON-RPC envelope/,
    );
    await assert.rejects(server.close(), /invalid idless JSON-RPC envelope/);
  }
});

test('Codex app-server rejects id-bearing envelopes that mix response and request fields', async () => {
  for (const envelope of [
    { id: 1, method: 'thread/started', result: { invalid: true } },
    { id: 1, params: { thread: 'fake' }, result: { invalid: true } },
    { id: 1, method: 'thread/started', params: {}, error: { code: -1, message: 'invalid' } },
    { id: 1, result: { invalid: true }, error: { code: -1, message: 'invalid' } },
    { id: 1 },
  ]) {
    const server = createFakeCodexAppServer((_request, child) => {
      child.stdout.write(`${JSON.stringify(envelope)}\n`);
    });
    await assert.rejects(
      server.request({ id: 1, method: 'hooks/list' }, 100),
      /codex app-server response/,
    );
    await assert.rejects(server.close(), /codex app-server response/);
  }
});

test('Codex app-server validates JSON-RPC error response shapes', async () => {
  const valid = createFakeCodexAppServer((_request, child) => {
    child.stdout.write(`${JSON.stringify({
      id: 1,
      error: { code: -32600, message: 'invalid request', data: { source: 'fake' } },
    })}\n`);
  });
  await assert.rejects(valid.request({ id: 1, method: 'hooks/list' }, 100), /returned JSON-RPC error/);
  await valid.close();

  for (const error of [
    null,
    {},
    { code: '-32600', message: 'invalid request' },
    { code: -32600, message: null },
  ]) {
    const server = createFakeCodexAppServer((_request, child) => {
      child.stdout.write(`${JSON.stringify({ id: 1, error })}\n`);
    });
    await assert.rejects(
      server.request({ id: 1, method: 'hooks/list' }, 100),
      /malformed JSON-RPC error/,
    );
    await assert.rejects(server.close(), /malformed JSON-RPC error/);
  }
});

test('Codex app-server incrementally decodes split UTF-8 responses and rejects invalid byte sequences', async () => {
  const split = createFakeCodexAppServer((_request, child) => {
    child.stdout.write(Buffer.from('{"id":1,"result":"', 'utf-8'));
    child.stdout.write(Buffer.from([0xe2, 0x82]));
    child.stdout.write(Buffer.from([0xac]));
    child.stdout.write(Buffer.from('"}\n', 'utf-8'));
  });
  assert.equal(await split.request({ id: 1, method: 'hooks/list' }, 100), '€');
  await split.close();

  for (const writeInvalidResponse of [
    (child: EventEmitter & Record<string, unknown>) => {
      child.stdout.write(Buffer.from('{"id":1,"result":"', 'utf-8'));
      child.stdout.write(Buffer.from([0xff]));
      child.stdout.write(Buffer.from('"}\n', 'utf-8'));
    },
    (child: EventEmitter & Record<string, unknown>) => {
      child.stdout.write(Buffer.from('{"id":1,"result":"', 'utf-8'));
      child.stdout.write(Buffer.from([0xc3]));
    },
  ]) {
    const server = createFakeCodexAppServer((_request, child) => writeInvalidResponse(child));
    const request = server.request({ id: 1, method: 'hooks/list' }, 100);
    await assert.rejects(
      Promise.all([request, server.close()]),
      /invalid UTF-8 stdout/,
    );
  }
});


test('Codex app-server rejects non-empty unterminated stdout when the server closes', async () => {
  const server = createFakeCodexAppServer((_request, child) => {
    child.stdout.write('{"id":1');
  });
  const request = server.request({ id: 1, method: 'hooks/list' }, 100);
  await assert.rejects(
    Promise.all([request, server.close()]),
    /unterminated JSON-RPC stdout/,
  );
});

test('packed lifecycle parses the pinned hooks/list eventName schema', () => {
  const project = '/tmp/project';
  const hooksPath = '/tmp/project/.codex/hooks.json';
  const parsed = parseCodexHooksListResult({
    data: [{
      cwd: project,
      hooks: [{
        eventName: 'preToolUse',
        command: 'node hook.js',
        sourcePath: hooksPath,
        key: `${hooksPath}:pre_tool_use:0:0`,
        currentHash: 'sha256:current',
        displayOrder: 0,
        trustStatus: 'trusted',
      }],
      warnings: [],
      errors: [],
    }],
  }, project, hooksPath);

  assert.equal(parsed.hooks[0]?.event, 'PreToolUse');
  assert.equal(parsed.hooks[0]?.trustStatus, 'trusted');
});

test('packed lifecycle normalizes omitted enabled handlers and rejects disabled or non-integer hook metadata', () => {
  const project = '/tmp/project';
  const hooksPath = '/tmp/project/.codex/hooks.json';
  const response = {
    data: [{
      cwd: project,
      hooks: [{
        eventName: 'preToolUse',
        command: 'node hook.js',
        sourcePath: hooksPath,
        key: `${hooksPath}:pre_tool_use:0:0`,
        currentHash: 'sha256:current',
        displayOrder: 0,
        trustStatus: 'trusted',
      }],
      warnings: [],
      errors: [],
    }],
  };
  assert.doesNotThrow(() => parseCodexHooksListResult(response, project, hooksPath));

  for (const update of [
    { enabled: false },
    { enabled: 'true' },
    { enabled: true, displayOrder: 0.5 },
    { enabled: true, displayOrder: -1 },
  ]) {
    const invalid = structuredClone(response);
    Object.assign(invalid.data[0]!.hooks[0]!, update);
    assert.throws(
      () => parseCodexHooksListResult(invalid, project, hooksPath),
      /enabled command handler|invalid hooks\[0\]\.displayOrder/,
    );
  }
});


test('packed lifecycle requires exactly seven generated OMX trust keys and an isolated approval target', () => {
  const hooks = MANAGED_CODEX_HOOK_EVENTS.map((event, index) => ({
    event,
    command: 'node /tmp/omx/dist/scripts/codex-native-hook.js',
    sourcePath: '/tmp/project/.codex/hooks.json',
    key: `/tmp/project/.codex/hooks.json:${event}:${index}:0`,
    currentHash: `sha256:${event}`,
    displayOrder: index,
    trustStatus: 'untrusted',
  }));
  const trust = Object.fromEntries(hooks.map((hook) => [hook.key, hook.currentHash]));
  assert.doesNotThrow(() => assertGeneratedTrustMatchesCodex(trust, hooks));
  assert.throws(
    () => assertGeneratedTrustMatchesCodex({
      ...trust,
      '/tmp/project/.codex/hooks.json:foreign:0:0': 'sha256:foreign',
    }, hooks),
    /exactly the 7 current OMX hooks with no stale keys/,
  );
  assert.throws(
    () => assertGeneratedTrustMatchesCodex(Object.fromEntries(Object.entries(trust).slice(0, -1)), hooks),
    /exactly the 7 current OMX hooks with no stale keys/,
  );
  assert.doesNotThrow(() => assertCodexBatchWriteResult({
    filePath: '/tmp/isolated-codex-home/config.toml',
    status: 'ok',
    version: null,
  }, '/tmp/isolated-codex-home/config.toml'));
  assert.throws(
    () => assertCodexBatchWriteResult({
      filePath: '/home/user/.codex/config.toml',
      status: 'ok',
      version: null,
    }, '/tmp/isolated-codex-home/config.toml'),
    /expected isolated user config/,
  );
});

test('packed lifecycle fails closed on malformed project hooks.state entries and stale raw keys', () => {
  const hooks = MANAGED_CODEX_HOOK_EVENTS.map((event, index) => ({
    event,
    command: 'node /tmp/omx/dist/scripts/codex-native-hook.js',
    sourcePath: '/tmp/project/.codex/hooks.json',
    key: `/tmp/project/.codex/hooks.json:${event}:${index}:0`,
    currentHash: `sha256:${event}`,
    displayOrder: index,
    trustStatus: 'untrusted',
  }));
  const validConfig = [
    '[hooks.state]',
    ...hooks.map((hook) => `${JSON.stringify(hook.key)} = { trusted_hash = ${JSON.stringify(hook.currentHash)} }`),
  ].join('\n');

  const generatedTrust = generatedHookTrustState(validConfig);
  assert.doesNotThrow(() => assertGeneratedTrustMatchesCodex(generatedTrust, hooks));

  for (const malformedEntry of [
    'first = "sha256:first"',
    'first = {}',
    'first = { trusted_hash = "" }',
    'first = { trusted_hash = 1 }',
    'first = { trusted_hash = "sha256:first", extra = "unexpected" }',
  ]) {
    assert.throws(
      () => generatedHookTrustState(`[hooks.state]\n${malformedEntry}`),
      /invalid hooks\.state entry first/,
    );
  }

  const staleRawTrust = generatedHookTrustState(`${validConfig}\nforeign = { trusted_hash = "sha256:foreign" }`);
  assert.throws(
    () => assertGeneratedTrustMatchesCodex(staleRawTrust, hooks),
    /exactly the 7 current OMX hooks with no stale keys/,
  );

  const protoRawTrust = generatedHookTrustState(
    `${validConfig}\n__proto__ = { trusted_hash = "sha256:proto" }`,
  );
  assert.equal(Object.hasOwn(protoRawTrust, '__proto__'), true);
  assert.throws(
    () => assertGeneratedTrustMatchesCodex(protoRawTrust, hooks),
    /exactly the 7 current OMX hooks with no stale keys/,
  );
});
test('packed lifecycle treats only the production command grammar as managed ownership', () => {
  const hooks = MANAGED_CODEX_HOOK_EVENTS.map((event, index) => ({
    event,
    command: 'node /tmp/omx/dist/scripts/codex-native-hook.js',
    sourcePath: '/tmp/project/.codex/hooks.json',
    key: `/tmp/project/.codex/hooks.json:${event}:${index}:0`,
    currentHash: `sha256:${event}`,
    displayOrder: index,
    trustStatus: 'untrusted',
  }));
  hooks[0]!.command = 'node /tmp/foreign-codex-native-hook.js';
  assert.throws(
    () => managedCodexHooksByEvent(hooks),
    /Expected exactly one OMX SessionStart hook from Codex, received 0/,
  );
});
test('packed lifecycle resolves Windows npm shims through safe command specs for version probes and app-server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-windows-shim-'));
  const fakeChild = () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        queueMicrotask(() => child.emit('close', 0, null));
        return true;
      },
    });
    child.stdin.once('finish', () => queueMicrotask(() => child.emit('close', 0, null)));
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };

  try {
    for (const extension of ['.cmd', '.ps1']) {
      const bin = join(root, extension.slice(1));
      const codexPath = join(bin, `codex${extension}`);
      const powershellPath = join(bin, 'powershell.exe');
      await mkdir(bin, { recursive: true });
      await Promise.all([writeFile(codexPath, ''), writeFile(powershellPath, '')]);

      const versionSpawns: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
      const appSpawns: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
      const seam = {
        platform: 'win32' as const,
        spawnSyncImpl: ((command: string, args: string[], options: Record<string, unknown>) => {
          versionSpawns.push({ command, args, options });
          return { status: 0, stdout: 'codex-cli 0.142.5\n', stderr: '', error: undefined };
        }) as never,
        spawnImpl: ((command: string, args: string[], options: Record<string, unknown>) => {
          appSpawns.push({ command, args, options });
          return fakeChild();
        }) as never,
      };
      const env = { PATH: bin, PATHEXT: extension.toUpperCase() };

      assert.equal(probeCodexVersion(root, env, seam), 'codex-cli 0.142.5');
      const server = await CodexAppServer.start({ cwd: root, env, commandSeam: seam });
      await server.close();

      assert.equal(versionSpawns.length, 2);
      assert.deepEqual(versionSpawns.map(({ command, args, options }) => ({ command, args, options })),
        extension === '.cmd'
          ? [
            {
              command: 'cmd.exe',
              args: ['/d', '/s', '/c', `""${codexPath}" "--version""`],
              options: {
                cwd: root,
                env,
                encoding: 'utf-8',
                timeout: CODEX_APP_SERVER_TIMEOUTS.versionProbeMs,
                killSignal: 'SIGKILL',
                windowsHide: true,
                windowsVerbatimArguments: true,
              },
            },
            {
              command: 'cmd.exe',
              args: ['/d', '/s', '/c', `""${codexPath}" "--version""`],
              options: {
                cwd: root,
                env,
                encoding: 'utf-8',
                timeout: CODEX_APP_SERVER_TIMEOUTS.versionProbeMs,
                killSignal: 'SIGKILL',
                windowsHide: true,
                windowsVerbatimArguments: true,
              },
            },
          ]
          : [
            {
              command: powershellPath,
              args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', codexPath, '--version'],
              options: {
                cwd: root,
                env,
                encoding: 'utf-8',
                timeout: CODEX_APP_SERVER_TIMEOUTS.versionProbeMs,
                killSignal: 'SIGKILL',
                windowsHide: true,
              },
            },
            {
              command: powershellPath,
              args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', codexPath, '--version'],
              options: {
                cwd: root,
                env,
                encoding: 'utf-8',
                timeout: CODEX_APP_SERVER_TIMEOUTS.versionProbeMs,
                killSignal: 'SIGKILL',
                windowsHide: true,
              },
            },
          ],
      );
      assert.deepEqual(appSpawns, extension === '.cmd'
        ? [{
          command: 'cmd.exe',
          args: ['/d', '/s', '/c', `""${codexPath}" "app-server" "--stdio""`],
          options: { cwd: root, env, stdio: 'pipe', windowsHide: true, windowsVerbatimArguments: true },
        }]
        : [{
          command: powershellPath,
          args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', codexPath, 'app-server', '--stdio'],
          options: { cwd: root, env, stdio: 'pipe', windowsHide: true },
        }]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle bypasses an unrelated codex binary shadowing the pinned CLI', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-path-'));
  const shadowDir = join(root, 'shadow');
  const pinnedDir = join(root, 'pinned');
  try {
    await Promise.all([
      mkdir(shadowDir, { recursive: true }),
      mkdir(pinnedDir, { recursive: true }),
    ]);
    const shadow = join(shadowDir, 'codex');
    const pinned = join(pinnedDir, 'codex');
    await Promise.all([
      writeFile(shadow, '#!/bin/sh\necho "codex 0.2.3"\n'),
      writeFile(pinned, '#!/bin/sh\necho "codex-cli 0.142.5"\n'),
    ]);
    await Promise.all([chmod(shadow, 0o755), chmod(pinned, 0o755)]);

    assert.equal(
      probeCodexVersion(root, { PATH: `${shadowDir}${delimiter}${pinnedDir}` }),
      'codex-cli 0.142.5',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle deduplicates repeated PATH entries before enforcing the candidate budget', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-path-dedup-'));
  const shadowDir = join(root, 'shadow');
  const pinnedDir = join(root, 'pinned');
  try {
    await Promise.all([
      mkdir(shadowDir, { recursive: true }),
      mkdir(pinnedDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(shadowDir, 'codex'), '#!/bin/sh\necho "codex 0.2.3"\n'),
      writeFile(join(pinnedDir, 'codex'), '#!/bin/sh\necho "codex-cli 0.142.5"\n'),
    ]);
    await Promise.all([
      chmod(join(shadowDir, 'codex'), 0o755),
      chmod(join(pinnedDir, 'codex'), 0o755),
    ]);

    assert.equal(
      probeCodexVersion(root, {
        PATH: [...Array.from({ length: 40 }, () => shadowDir), pinnedDir].join(delimiter),
      }),
      'codex-cli 0.142.5',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle accepts only the exact stable pinned Codex version output', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-version-'));
  const candidateDir = join(root, 'candidate');
  const executable = join(candidateDir, 'codex');
  const candidates = [
    { output: 'codex-cli 0.142.5', stderr: '', accepted: true },
    { output: 'codex-cli 0.142.5', stderr: 'warning: harmless test diagnostic', accepted: true },
    { output: 'codex-cli 0.142.5\nextra output', stderr: '', accepted: false },
    { output: 'codex-cli 0.142.5-beta', stderr: '', accepted: false },
    { output: 'codex-cli 0.142.5+meta', stderr: '', accepted: false },
    { output: 'codex-cli 0.142.5.1', stderr: '', accepted: false },
    { output: 'codex-cli v0.142.5', stderr: '', accepted: false },
    { output: 'codex-cli 0-142-5', stderr: '', accepted: false },
    { output: 'codex-cli 0.142.5', stderr: 'unexpected version probe error', accepted: false },
  ];
  try {
    await mkdir(candidateDir, { recursive: true });
    for (const candidate of candidates) {
      await writeFile(
        executable,
        `#!/bin/sh\nprintf '%s\\n' '${candidate.output}'\n${candidate.stderr ? `printf '%s\\n' '${candidate.stderr}' >&2\n` : ''}`,
      );
      await chmod(executable, 0o755);
      if (candidate.accepted) {
        assert.equal(probeCodexVersion(root, { PATH: candidateDir }), 'codex-cli 0.142.5');
      } else {
        assert.throws(
          () => probeCodexVersion(root, { PATH: candidateDir }),
          /Unsupported installed Codex version for the 0\.142\.5 boundary/,
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('packed lifecycle does not classify an installed Codex with a broken shebang as absent', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-broken-shebang-'));
  const candidateDir = join(root, 'candidate');
  const executable = join(candidateDir, 'codex');
  try {
    await mkdir(candidateDir, { recursive: true });
    await writeFile(executable, '#!/definitely-not-an-installed-interpreter\n');
    await chmod(executable, 0o755);
    assert.throws(
      () => probeCodexVersion(root, { PATH: candidateDir }),
      /launch returned ENOENT after an existing candidate was observed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle does not classify a dangling Codex candidate as absent', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-dangling-'));
  const candidateDir = join(root, 'candidate');
  try {
    await mkdir(candidateDir, { recursive: true });
    await symlink(join(root, 'missing-codex'), join(candidateDir, 'codex'));
    assert.throws(
      () => probeCodexVersion(root, { PATH: candidateDir }),
      /candidate exists but its target is unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('packed lifecycle does not classify a dangling PATH entry as absent', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-dangling-path-'));
  const danglingPathEntry = join(root, 'dangling-path-entry');
  try {
    await symlink(join(root, 'missing-path-entry'), danglingPathEntry);
    assert.throws(
      () => probeCodexVersion(root, { PATH: danglingPathEntry }),
      /PATH entry exists but its target is unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle bounds all slow Codex candidates with a global deadline', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-global-deadline-'));
  const slowDirs = ['slow-one', 'slow-two', 'slow-three'].map((name) => join(root, name));
  try {
    await Promise.all(slowDirs.map((dir) => mkdir(dir, { recursive: true })));
    await Promise.all(slowDirs.map(async (dir) => {
      const executable = join(dir, 'codex');
      await writeFile(executable, '#!/bin/sh\nexec /bin/sleep 30\n');
      await chmod(executable, 0o755);
    }));
    const startedAt = Date.now();
    assert.throws(
      () => probeCodexVersion(root, { PATH: slowDirs.join(delimiter) }),
      /global deadline/,
    );
    assert.ok(Date.now() - startedAt < 6_500, 'the global version-resolution deadline must force termination');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle fails before probing the 33rd unique PATH candidate', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-candidate-budget-'));
  const candidateDirs = Array.from({ length: 33 }, (_value, index) => join(root, `candidate-${index}`));
  const thirtyThirdProbe = join(root, '33rd-candidate-was-probed');
  try {
    await Promise.all(candidateDirs.map((dir) => mkdir(dir, { recursive: true })));
    await Promise.all(candidateDirs.map(async (dir, index) => {
      const executable = join(dir, 'codex');
      await writeFile(
        executable,
        index === candidateDirs.length - 1
          ? `#!/bin/sh\n: > ${JSON.stringify(thirtyThirdProbe)}\nprintf '%s\\n' 'codex-cli 0.142.5'\n`
          : '#!/bin/sh\nexit 1\n',
      );
      await chmod(executable, 0o755);
    }));
    assert.throws(
      () => probeCodexVersion(root, { PATH: candidateDirs.join(delimiter) }),
      /32-candidate PATH budget/,
    );
    await assert.rejects(access(thirtyThirdProbe));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle continues after a timed-out version probe candidate', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-timeout-'));
  const slowDir = join(root, 'slow');
  const pinnedDir = join(root, 'pinned');
  try {
    await Promise.all([mkdir(slowDir, { recursive: true }), mkdir(pinnedDir, { recursive: true })]);
    await Promise.all([
      writeFile(join(slowDir, 'codex'), '#!/bin/sh\nexec /bin/sleep 30\n'),
      writeFile(join(pinnedDir, 'codex'), '#!/bin/sh\nprintf \'%s\\n\' \'codex-cli 0.142.5\'\n'),
    ]);
    await Promise.all([chmod(join(slowDir, 'codex'), 0o755), chmod(join(pinnedDir, 'codex'), 0o755)]);

    const startedAt = Date.now();
    assert.equal(probeCodexVersion(root, { PATH: `${slowDir}${delimiter}${pinnedDir}` }), 'codex-cli 0.142.5');
    assert.ok(Date.now() - startedAt < 5_000, 'a timed-out candidate must not block later PATH candidates');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle fails instead of skipping when Codex disappears after start version validation', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-disappears-after-version-'));
  const candidateDir = join(root, 'candidate');
  const executable = join(candidateDir, 'codex');
  try {
    await mkdir(candidateDir, { recursive: true });
    await writeFile(executable, [
      '#!/bin/sh',
      'state="${0}.version-count"',
      'if [ "$1" = "--version" ]; then',
      '  if [ -f "$state" ]; then /bin/rm -f "$0"; else : > "$state"; fi',
      '  printf \'%s\\n\' \'codex-cli 0.142.5\'',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'));
    await chmod(executable, 0o755);
    assert.equal(probeCodexVersion(root, { PATH: candidateDir }), 'codex-cli 0.142.5');

    await assert.rejects(
      CodexAppServer.start({ cwd: root, env: { PATH: candidateDir } }),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error instanceof CodexExecutableNotFoundError, false);
        assert.equal(error.code, 'ENOENT');
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle preserves the true-absence Codex skip signal', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'omx-codex-absent-'));
  try {
    assert.throws(
      () => probeCodexVersion(root, { PATH: root }),
      CodexExecutableNotFoundError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed lifecycle pre-seeds and preserves nested foreign group and handler coordinates', () => {
  const marker = 'packed-foreign-fixture';
  const seeded = appendForeignHookGroups('{"hooks":{}}', marker, { appendGroups: true });
  const inserted = appendForeignHookGroups(seeded, marker, { appendGroups: false });
  const snapshot = foreignHookGroupSnapshot(inserted, marker);

  assert.equal(snapshot.length, 4);
  assert.deepEqual(
    snapshot.map((entry) => ({
      event: entry.event,
      groupIndex: entry.groupIndex,
      handlerIndex: entry.handlerIndex,
    })),
    [
      { event: 'PreToolUse', groupIndex: 0, handlerIndex: 0 },
      { event: 'PreToolUse', groupIndex: 0, handlerIndex: 1 },
      { event: 'PostToolUse', groupIndex: 0, handlerIndex: 0 },
      { event: 'PostToolUse', groupIndex: 0, handlerIndex: 1 },
    ],
  );
  assert.match(inserted, /foreign_group_metadata/);
  assert.match(inserted, /foreign_handler_metadata/);
});

test('display-order-stable foreign fixture preserves pre-approved group and handler coordinates', () => {
  const marker = 'packed-display-order-fixture';
  const seeded = appendDisplayOrderStableForeignHookGroups('{"hooks":{}}', marker, { appendGroups: true });
  const inserted = appendDisplayOrderStableForeignHookGroups(seeded, marker, { appendGroups: false });
  const snapshot = foreignHookGroupSnapshot(inserted, marker);

  assert.deepEqual(
    snapshot.map((entry) => ({
      event: entry.event,
      groupIndex: entry.groupIndex,
      handlerIndex: entry.handlerIndex,
    })),
    [
      { event: 'PreToolUse', groupIndex: 0, handlerIndex: 0 },
      { event: 'PreToolUse', groupIndex: 1, handlerIndex: 0 },
      { event: 'PreToolUse', groupIndex: 1, handlerIndex: 1 },
      { event: 'PreToolUse', groupIndex: 1, handlerIndex: 2 },
    ],
  );
});

test('packed install smoke covers every installed native hook event with minimal payloads', () => {
  assert.deepEqual(PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS, [
    'SessionStart',
    'PreToolUse',
    'PostToolUse',
    'UserPromptSubmit',
    'PreCompact',
    'PostCompact',
    'Stop',
  ]);

  for (const eventName of PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS) {
    const payload = buildNativeHookSmokePayload(eventName, '/tmp/omx-packed-hook-smoke');
    assert.equal(payload.hook_event_name, eventName);
    assert.equal(typeof payload.session_id, 'string');
    assert.equal(payload.cwd, '/tmp/omx-packed-hook-smoke');
  }
});

test('packed install smoke covers directive activation and terminal false-activation regressions', () => {
  assert.deepEqual(PACKED_INSTALL_NATIVE_HOOK_REGRESSION_PROMPTS, [
    { name: 'directive-use-ralplan', prompt: 'use $ralplan plan this', expectedSkill: 'ralplan', expectedStopBlock: true },
    { name: 'directive-please-use-ralplan', prompt: 'please use $ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
    { name: 'directive-run-ralplan', prompt: 'run $ralplan plan this', expectedSkill: 'ralplan', expectedStopBlock: true },
    { name: 'directive-list-use-ralplan', prompt: '- use $ralplan plan this', expectedSkill: 'ralplan', expectedStopBlock: true },
    { name: 'directive-documentation-then-command', prompt: 'use $ralplan is the consensus-planning command\n$autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'directive-documentation-then-implicit-command', prompt: 'use $ralplan is the consensus-planning command\nUse autopilot mode.', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'directive-documentation-trailing-prose-then-command', prompt: 'use $ralplan is the workflow command for planning\n$autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'directive-documentation-implicit-prose', prompt: 'use $ralplan is the workflow command for autopilot mode', expectedSkill: null, expectedStopBlock: false },
    { name: 'directive-documentation-alias-prose', prompt: 'use $ralplan is the consensus-planning command\nAutopilot mode is its alias.', expectedSkill: null, expectedStopBlock: false },
    { name: 'directive-coordinated-documentation-then-command', prompt: '- use $ralplan and $autopilot are workflow commands\n$ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
    { name: 'directive-documentation-semicolon-directive', prompt: 'use $ralplan is the consensus-planning command; use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'directive-two-documentation-blocks', prompt: 'use $ralplan is the consensus-planning command\nuse $autopilot is the autonomous workflow command\n$ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
    { name: 'directive-documentation-embedded-token-then-command', prompt: 'use $ralplan is the workflow command for $team\n$autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'doc-task-noun', prompt: 'use $ralplan is the workflow command; use $autopilot update the documentation', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'doc-implicit-followup', prompt: 'use $ralplan is the consensus-planning command; use autopilot mode.', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'doc-transition-followup', prompt: 'use $ralplan is the consensus-planning command; then use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'doc-explicit-alias', prompt: 'use $ralplan is the consensus-planning command; $team is its alias', expectedSkill: null, expectedStopBlock: false },
    { name: 'doc-implicit-chain', prompt: 'use $ralplan is the consensus-planning command\nAutopilot mode is its alias.\n$ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
    { name: 'doc-fullwidth-separator', prompt: 'use $ralplan，$autopilot are workflow commands', expectedSkill: null, expectedStopBlock: false },
    { name: 'doc-compact-slash', prompt: 'use $ralplan/$autopilot are workflow commands\n$ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
    { name: 'reference-prompts-followup', prompt: '[docs]: /target "title\nUse /prompts:architect"\n$ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
    { name: 'doc-period-implicit', prompt: 'use $ralplan is the consensus-planning command. Use autopilot mode.', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'doc-bare-implicit', prompt: 'use $ralplan is the consensus-planning command; autopilot mode.', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'doc-fullwidth-semicolon', prompt: 'use $ralplan is the consensus-planning command； use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'doc-but-followup', prompt: 'use $ralplan is the workflow command; but use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'doc-fullwidth-oxford', prompt: 'use $ralplan， $autopilot， and $team are workflow commands', expectedSkill: null, expectedStopBlock: false },
    { name: 'reference-zero-title', prompt: '[docs]: ./target\n(autopilot mode)', expectedSkill: null, expectedStopBlock: false },
    { name: 'doc-also-alias-explicit', prompt: 'use $ralplan is the consensus-planning command; $team is also its alias', expectedSkill: null, expectedStopBlock: false },
    { name: 'doc-also-alias-implicit', prompt: 'use $ralplan is the consensus-planning command\nAutopilot mode is also its alias.', expectedSkill: null, expectedStopBlock: false },
    { name: 'doc-embedded-mention', prompt: 'use $ralplan is the workflow command; $team appears in the documentation.', expectedSkill: null, expectedStopBlock: false },
    { name: 'chained-negation', prompt: '$ralplan; $autopilot is prohibited', expectedSkill: 'ralplan', expectedStopBlock: true, expectedDeferredSkills: [] },
    { name: 'long-negation', prompt: `$ralplan; $autopilot${' '.repeat(193)}is prohibited`, expectedSkill: 'ralplan', expectedStopBlock: true, expectedDeferredSkills: [] },
    { name: 'doc-arabic-comma', prompt: 'use $ralplan، $autopilot are workflow commands', expectedSkill: null, expectedStopBlock: false },
    { name: 'arabic-negation', prompt: '$ralplan، $autopilot are prohibited', expectedSkill: null, expectedStopBlock: false },
    { name: 'implicit-arabic-negation', prompt: 'Autopilot mode، deep interview are prohibited.', expectedSkill: null, expectedStopBlock: false },
    { name: 'fullwidth-frame-reset', prompt: 'For instance: manual mode is slower。 Use autopilot mode.', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'doc-abbreviation', prompt: 'use $ralplan is the workflow command, e.g. use $autopilot in examples.', expectedSkill: null, expectedStopBlock: false },
    { name: 'implicit-doc-mention', prompt: 'use $ralplan is the workflow command; autopilot mode appears in the documentation.', expectedSkill: null, expectedStopBlock: false },
    { name: 'implicit-doc-chain', prompt: 'use $ralplan is the workflow command; autopilot mode is its alias; $ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
    { name: 'long-command-gap', prompt: `use $ralplan is the workflow command; use${' '.repeat(161)}$autopilot build it`, expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'ideographic-negation', prompt: '$ralplan、 $autopilot are prohibited', expectedSkill: null, expectedStopBlock: false },
    { name: 'implicit-ideo-negation', prompt: 'Autopilot mode、 deep interview are prohibited.', expectedSkill: null, expectedStopBlock: false },
    { name: 'doc-exclamation', prompt: 'use $ralplan is the consensus-planning command! run $autopilot', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'doc-fullwidth-question', prompt: 'use $ralplan is the consensus-planning command？ run $autopilot', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'implicit-doc-predecessor', prompt: 'Autopilot mode is workflow documentation.\n$ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
    { name: 'confusable-use-verb', prompt: 'uſe $ralplan plan it', expectedSkill: null, expectedStopBlock: false },
    { name: 'confusable-please', prompt: 'pleaſe use $ralplan plan it', expectedSkill: null, expectedStopBlock: false },
    { name: 'confusable-prompts-token-then-command', prompt: '/promptſ:architect; use autopilot mode.', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'reserved-em-dash-boundary', prompt: '/prompts:architect— use autopilot mode', expectedSkill: null, expectedStopBlock: false },
    { name: 'reserved-fullwidth-comma-boundary', prompt: '/prompts:architect， use autopilot mode', expectedSkill: null, expectedStopBlock: false },
    { name: 'confusable-implicit-verb', prompt: 'Do not use deep interview but uſe autopilot mode.', expectedSkill: null, expectedStopBlock: false },
    { name: 'frame-fullwidth-colon', prompt: 'For instance： use autopilot mode.', expectedSkill: null, expectedStopBlock: false },
    { name: 'frame-fullwidth-comma', prompt: 'For instance， use autopilot mode.', expectedSkill: null, expectedStopBlock: false },
    { name: 'frame-arabic-comma', prompt: 'For instance، use autopilot mode.', expectedSkill: null, expectedStopBlock: false },
    { name: 'frame-ideo-comma', prompt: 'For instance、 use autopilot mode.', expectedSkill: null, expectedStopBlock: false },
    { name: 'doc-explicit-documented', prompt: 'use $ralplan is the workflow command; $autopilot is documented in the guide.', expectedSkill: null, expectedStopBlock: false },
    { name: 'doc-explicit-described', prompt: '$autopilot is described in the manual.', expectedSkill: null, expectedStopBlock: false },
    { name: 'doc-comma-followup', prompt: 'use $ralplan is the workflow command, but use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'doc-fw-comma-followup', prompt: 'use $ralplan is the workflow command， but use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'doc-arabic-followup', prompt: 'use $ralplan is the workflow command، but use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'doc-ideo-followup', prompt: 'use $ralplan is the workflow command、 but use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'neg-arabic-followup', prompt: 'Do not run $ralplan، use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'neg-ideo-followup', prompt: 'Do not run $ralplan、 use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'implicit-doc-prefix-next', prompt: 'The docs mention autopilot mode.\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
    { name: 'implicit-doc-prefix-line', prompt: 'The docs mention autopilot mode; use $ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
    { name: 'implicit-doc-subject-line', prompt: 'Autopilot mode is workflow documentation; use $ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
    { name: 'compact-explicit-negation', prompt: '$ralplan,$autopilot are prohibited', expectedSkill: null, expectedStopBlock: false },
    { name: 'compact-implicit-negation', prompt: 'Autopilot mode،deep interview are prohibited.', expectedSkill: null, expectedStopBlock: false },
    { name: 'doc-clause-local-prefix', prompt: '$ralplan; $autopilot is documented in the guide.', expectedSkill: 'ralplan', expectedStopBlock: true },
    { name: 'doc-chain-described', prompt: 'use $ralplan is the workflow command; autopilot mode is documented in the guide; $team execute it', expectedSkill: 'team', expectedStopBlock: false, insideTmux: true },
    { name: 'doc-chain-workflow', prompt: 'use $ralplan is the workflow command; autopilot mode is workflow documentation; use $ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
    { name: 'ref-inline-explicit', prompt: '[docs]: $ralplan\n$autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'ref-inline-prompts', prompt: '[docs]: /prompts:architect\n$autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'list-fullwidth-explicit-doc', prompt: '- $ralplan： consensus-planning workflow', expectedSkill: null, expectedStopBlock: false },
    { name: 'list-fullwidth-implicit-doc', prompt: '- autopilot mode： autonomous workflow command', expectedSkill: null, expectedStopBlock: false },
    { name: 'possessive-straight', prompt: "$ralplan's workflow is documented", expectedSkill: null, expectedStopBlock: false },
    { name: 'possessive-curly', prompt: '$ralplan’s workflow is documented', expectedSkill: null, expectedStopBlock: false },
    { name: 'possessive-fullwidth', prompt: '$ralplan＇s workflow is documented', expectedSkill: null, expectedStopBlock: false },
    { name: 'possessive-prompts', prompt: "/prompts:architect's syntax is documented", expectedSkill: null, expectedStopBlock: false },
    { name: 'malformed-prefix-kata', prompt: '$・autopilot mode', expectedSkill: null, expectedStopBlock: false },
    { name: 'malformed-prefix-half', prompt: '$･autopilot mode', expectedSkill: null, expectedStopBlock: false },
    { name: 'malformed-prefix-arabic', prompt: '$٪autopilot mode', expectedSkill: null, expectedStopBlock: false },
    { name: 'malformed-prefix-division', prompt: '$∕autopilot mode', expectedSkill: null, expectedStopBlock: false },
    { name: 'doc-but-directive', prompt: 'use $autopilot is documented but use $ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
    { name: 'list-directive-fw-colon', prompt: '- use $ralplan： consensus-planning workflow', expectedSkill: null, expectedStopBlock: false },
    { name: 'doc-arabic-question', prompt: 'use $ralplan is the workflow command؟ run $autopilot', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'arabic-semicolon-negation', prompt: '$ralplan؛ $autopilot is prohibited', expectedSkill: 'ralplan', expectedStopBlock: true, expectedDeferredSkills: [] },
    { name: 'confusable-postposed-transition', prompt: '$ralplan is prohibited but uſe autopilot mode.', expectedSkill: null, expectedStopBlock: false },
    { name: 'mixed-negation', prompt: 'Autopilot mode and $ralplan are prohibited.', expectedSkill: null, expectedStopBlock: false },
    { name: 'both-mixed-negation', prompt: 'Both autopilot mode and $ralplan are prohibited.', expectedSkill: null, expectedStopBlock: false },
    { name: 'mixed-documentation', prompt: 'use $ralplan and autopilot mode are workflow commands', expectedSkill: null, expectedStopBlock: false },
    { name: 'prose-doc-no-reopen', prompt: '$ralplan is prohibited because docs use $autopilot.', expectedSkill: null, expectedStopBlock: false },
    { name: 'neg-fw-dot-reopen', prompt: 'Do not run $ralplan． use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'neg-greek-q-reopen', prompt: 'Do not run $ralplan; use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'unicode-attached-contrast', prompt: 'Do not use deep interview яbut use autopilot mode.', expectedSkill: null, expectedStopBlock: false },
    { name: 'prefix-list-followup', prompt: 'Do not run $ralplan, $autopilot; use $team execute it', expectedSkill: 'team', expectedStopBlock: false, insideTmux: true },
    { name: 'mixed-postposed-chain', prompt: '$ralplan, autopilot mode, $team are prohibited.', expectedSkill: null, expectedStopBlock: false },
    { name: 'implicit-first-doc-chain', prompt: 'Autopilot mode and $ralplan are workflow commands; use $team execute it', expectedSkill: 'team', expectedStopBlock: false, insideTmux: true },
    { name: 'both-mixed-doc-followup', prompt: 'Both autopilot mode and $ralplan are workflow commands; use $team execute it', expectedSkill: 'team', expectedStopBlock: false, insideTmux: true },
    { name: 'doc-semicolon-preserves-earlier', prompt: 'Use autopilot mode; use $ralplan is the workflow command.', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'doc-independent-comma', prompt: 'Use autopilot mode, and $ralplan is documented in the guide.', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'reference-unclosed-quote-destination', prompt: '[docs]: "target\n$autopilot build it', expectedSkill: null, expectedStopBlock: false },
    { name: 'reference-unclosed-inline-destination', prompt: '[docs]: `target\n$autopilot build it', expectedSkill: null, expectedStopBlock: false },
    { name: 'mixed-prefix-negation-implicit', prompt: 'Do not run $ralplan and use autopilot mode.', expectedSkill: null, expectedStopBlock: false },
    { name: 'repeated-postposed-followup', prompt: '$team is prohibited and is forbidden; use $ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
    { name: 'doc-preserves-earlier', prompt: 'Use autopilot mode; "note"; use $ralplan is the workflow command.', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'doc-colon-followup', prompt: 'use $ralplan is the workflow command: use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'table-followup', prompt: 'Mode | Meaning\n--- | ---\nmanual | documentation\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
    { name: 'neg-advance-reopen', prompt: 'Do not run $ralplan but advance to $ultragoal', expectedSkill: 'ultragoal', expectedStopBlock: false },
    { name: 'neg-jump-reopen', prompt: 'Do not run $ralplan but jump straight to $ultragoal', expectedSkill: 'ultragoal', expectedStopBlock: false },
    { name: 'reference-plain-title', prompt: '[docs]: /target "title\nplain text"\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
    { name: 'reference-plain-destination', prompt: '[docs]: ./target\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
    { name: 'directive-use-the', prompt: 'Do not run $ralplan; use the $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
    { name: 'directive-continue-after-quote', prompt: '"quoted"\ncontinue with $ralplan', expectedSkill: 'ralplan', expectedStopBlock: true },
    { name: 'doc-advance-followup', prompt: 'use $ralplan is the workflow command; advance to $ultragoal', expectedSkill: 'ultragoal', expectedStopBlock: false },
    { name: 'directive-run-code-review', prompt: 'run $code-review', expectedSkill: 'code-review', expectedStopBlock: false },
    { name: 'directive-documentation', prompt: 'use $ralplan is the consensus-planning command', expectedSkill: null, expectedStopBlock: false },
    { name: 'nested-bounded-child-unbounded-parent', prompt: '"`x`\n$ralplan plan it', expectedSkill: null, expectedStopBlock: false },
    { name: 'first-contiguous-block-terminal', prompt: '$ralplan plan it\n"x"\n$autopilot build it', expectedSkill: 'ralplan', expectedStopBlock: true, expectedDeferredSkills: [] },
    { name: 'leading-reserved-dominance', prompt: '/prompts:architect\n"x"\n$ralplan plan it', expectedSkill: null, expectedStopBlock: false },
    { name: 'list-fence-root-opener', prompt: '- ```\n  sample\n```\n$ralplan plan it', expectedSkill: null, expectedStopBlock: false },
    { name: 'list-fence-relative-closer', prompt: '- ```\n  sample\n    ```\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
    { name: 'reference-multiline-title-explicit', prompt: '[docs]: /target "title\nuse /prompts:architect\n$ralplan plan it"', expectedSkill: null, expectedStopBlock: false },
    { name: 'reference-multiline-title-implicit', prompt: '[docs]: /target "title\nuse autopilot mode"', expectedSkill: null, expectedStopBlock: false },
    { name: 'reference-next-line-title', prompt: '[docs]: ./target\n  (autopilot mode)', expectedSkill: null, expectedStopBlock: false },
    { name: 'reference-next-line-destination-title', prompt: '[docs]:\n  ./target\n  (autopilot mode)', expectedSkill: null, expectedStopBlock: false },
    { name: 'kelvin-case-fold-suffix', prompt: '$ultraworK execute', expectedSkill: null, expectedStopBlock: false },
    { name: 'katakana-middle-dot-suffix', prompt: '$ralplan・suffix plan it', expectedSkill: null, expectedStopBlock: false },
    { name: 'halfwidth-middle-dot-suffix', prompt: '$ralplan･suffix plan it', expectedSkill: null, expectedStopBlock: false },
    { name: 'arabic-percent-suffix', prompt: '$ralplan٪docs', expectedSkill: null, expectedStopBlock: false },
    { name: 'division-slash-suffix', prompt: '$ralplan∕config', expectedSkill: null, expectedStopBlock: false },
    { name: 'unclosed-prompts-quote', prompt: '"Use /prompts:architect\n$ralplan plan it', expectedSkill: null, expectedStopBlock: false },
    { name: 'malformed-prompts-suffix', prompt: '/prompts:architect한글\n$ralplan plan it', expectedSkill: null, expectedStopBlock: false },
    { name: 'stale-predecessor-prose-directive', prompt: '> quoted context\nProse\n$ralplan implement this', expectedSkill: null, expectedStopBlock: false },
    { name: 'stale-predecessor-reserved-directive', prompt: '> quoted context\n/prompts:architect\n$ralplan plan this', expectedSkill: null, expectedStopBlock: false },
    { name: 'stale-predecessor-first-block-terminal', prompt: '> quoted context\n$ralplan plan it\nLater discussion.\n$autopilot build it', expectedSkill: 'ralplan', expectedStopBlock: true, expectedDeferredSkills: [] },
    { name: 'stale-predecessor-unclosed-after-negation', prompt: 'Do not run $ralplan.\n"unclosed context\n$autopilot build it', expectedSkill: null, expectedStopBlock: false },
    { name: 'stale-predecessor-reference-unclosed', prompt: '[$ralplan]: ./docs\n"unclosed context\n$autopilot build it', expectedSkill: null, expectedStopBlock: false },
    { name: 'stale-directive-clause-prefix', prompt: '> quoted context\nProse\nUse $ralplan plan this', expectedSkill: null, expectedStopBlock: false },
    { name: 'nested-reserved-predecessor-successor', prompt: '- Use /prompts:architect.\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
    { name: 'nested-fence-predecessor-successor', prompt: '- - ```\n    quoted context\n    ```\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
    { name: 'reference-multiline-destination-implicit', prompt: '[docs]:\nautopilot', expectedSkill: null, expectedStopBlock: false },
    { name: 'middle-dot-suffix', prompt: '$ralplan·suffix plan it', expectedSkill: null, expectedStopBlock: false },
    { name: 'percent-suffix', prompt: '$ralplan%docs', expectedSkill: null, expectedStopBlock: false },
    { name: 'fullwidth-percent-suffix', prompt: '$ralplan％docs', expectedSkill: null, expectedStopBlock: false },
    { name: 'g1a-ordered-multi-skill', prompt: '$ralplan, $autopilot; $team', expectedSkill: 'ralplan', expectedStopBlock: true, expectedDeferredSkills: ['autopilot', 'team'], expectedActiveSkills: ['ralplan'], insideTmux: true },
    { name: 'g1c-duplicate-alias', prompt: '$autopilot $oh-my-codex:autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true, expectedDeferredSkills: [], expectedActiveSkills: ['autopilot'] },
    { name: 'b3-longer-valid-fence', prompt: '```text\n$autopilot build it\n````\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
    { name: 'b4-shorter-invalid-fence', prompt: '````text\n$autopilot build it\n```\n$ralplan plan it', expectedSkill: null, expectedStopBlock: false },
    { name: 'b5-different-marker-invalid-fence', prompt: '```text\n$autopilot build it\n~~~\n$ralplan plan it', expectedSkill: null, expectedStopBlock: false },
  ]);
});

test('packed regression environment clears inherited Team routing state', () => {
  const environment = buildPackedRegressionEnvironment(
    { name: 'poisoned-team-case', insideTmux: true },
    {
      OMX_ROOT: '/tmp/poison-root',
      OMX_STATE_ROOT: '/tmp/poison-state',
      OMX_TEAM_STATE_ROOT: '/tmp/poison-team-state',
      OMX_SESSION_ID: 'poison-session',
      CODEX_SESSION_ID: 'poison-codex-session',
      SESSION_ID: 'poison-generic-session',
      OMX_TEAM_WORKER: 'poison/worker-1',
      OMX_TEAM_INTERNAL_WORKER: 'poison/worker-2',
      OMX_TEAM_LEADER_CWD: '/tmp/poison-leader',
      OMX_TEAM_MODE: 'disabled',
      OMX_QUESTION_RETURN_PANE: '%1',
      OMX_LEADER_PANE_ID: '%2',
      OMX_TMUX_HUD_OWNER: '1',
      TMUX: '/tmp/poison-tmux',
      TMUX_PANE: '%9',
    },
  );

  assert.equal(environment.OMX_ROOT, '');
  assert.equal(environment.OMX_STATE_ROOT, '');
  assert.equal(environment.OMX_TEAM_STATE_ROOT, '');
  assert.equal(environment.OMX_TEAM_WORKER, '');
  assert.equal(environment.OMX_TEAM_INTERNAL_WORKER, '');
  assert.equal(environment.OMX_TEAM_LEADER_CWD, '');
  assert.equal(environment.OMX_TEAM_MODE, 'enabled');
  assert.equal(environment.TMUX, '/tmp/tmux-pr3140-regression');
  assert.equal(environment.TMUX_PANE, '%3140');
});

test('packed install native hook stdout validation allows empty or JSON output only', () => {
  assert.doesNotThrow(() => validateHookStdout('PostCompact', ''));
  assert.doesNotThrow(() => validateHookStdout('Stop', '{}\n'));
  assert.throws(
    () => validateHookStdout('UserPromptSubmit', '{not json'),
    /native hook UserPromptSubmit emitted invalid JSON stdout/,
  );
});
test('packed lifecycle and native hook smoke share the seven managed event names', () => {
  assert.deepEqual(MANAGED_CODEX_HOOK_EVENTS, PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS);
});

test('packed install native hook stdout validation enforces event output contracts', () => {
  assert.doesNotThrow(() => validateHookStdout('PostCompact', ''));
  assert.doesNotThrow(() => validateHookStdout('Stop', '{}\n'));
  assert.throws(
    () => validateHookStdout('PostCompact', '{}\n'),
    /PostCompact must emit empty stdout/,
  );
  for (const value of ['\n', ' ', ' \r\n']) {
    assert.throws(
      () => validateHookStdout('PostCompact', value),
      /PostCompact must emit empty stdout/,
    );
  }
  for (const value of ['null', '[]', '"text"', '1']) {
    assert.throws(
      () => validateHookStdout('Stop', value),
      /non-object JSON stdout payload/,
    );
  }
  assert.throws(
    () => validateHookStdout('UserPromptSubmit', '{not json'),
    /native hook UserPromptSubmit emitted invalid JSON stdout/,
  );
});

test('parseNpmPackJsonOutput ignores prepack logs before npm pack JSON', () => {
  const parsed = parseNpmPackJsonOutput([
    '[sync-plugin-mirror] synced 29 canonical skill directories and plugin metadata',
    '[',
    '  {',
    '    "filename": "oh-my-codex-0.15.0.tgz"',
    '  }',
    ']',
    '',
  ].join('\n'));

  assert.deepEqual(parsed, [{ filename: 'oh-my-codex-0.15.0.tgz' }]);
});

test('resolveGitCommonDir resolves relative git common dir output against the repo root', () => {
  const commonDir = resolveGitCommonDir('/tmp/worktree', () => ({
    status: 0,
    stdout: '../primary/.git\n',
    stderr: '',
  }) as ReturnType<typeof import('node:child_process').spawnSync>);
  assert.equal(commonDir, '/tmp/primary/.git');
});

test('hasUsableNodeModules requires the packaged build dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-node-modules-'));
  try {
    const nodeModules = join(root, 'node_modules');
    await mkdir(join(nodeModules, 'typescript'), { recursive: true });
    await mkdir(join(nodeModules, '@iarna', 'toml'), { recursive: true });
    await mkdir(join(nodeModules, '@modelcontextprotocol', 'sdk'), { recursive: true });
    await mkdir(join(nodeModules, 'zod'), { recursive: true });
    await writeFile(join(nodeModules, 'typescript', 'package.json'), '{}');
    await writeFile(join(nodeModules, '@iarna', 'toml', 'package.json'), '{}');
    await writeFile(join(nodeModules, '@modelcontextprotocol', 'sdk', 'package.json'), '{}');
    await writeFile(join(nodeModules, 'zod', 'package.json'), '{}');

    assert.equal(hasUsableNodeModules(root), true);

    await rm(join(nodeModules, 'zod', 'package.json'));
    assert.equal(hasUsableNodeModules(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveReusableNodeModulesSource reuses primary worktree node_modules when available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-reuse-node-modules-'));
  try {
    const primaryRepo = join(root, 'primary');
    const worktreeRepo = join(root, 'worktree');
    await mkdir(join(primaryRepo, 'node_modules', 'typescript'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@iarna', 'toml'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', 'zod'), { recursive: true });
    await writeFile(join(primaryRepo, 'node_modules', 'typescript', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@iarna', 'toml', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', 'zod', 'package.json'), '{}');
    await mkdir(worktreeRepo, { recursive: true });

    const reusable = resolveReusableNodeModulesSource(worktreeRepo, () => ({
      status: 0,
      stdout: `${join(primaryRepo, '.git')}\n`,
      stderr: '',
    }) as ReturnType<typeof import('node:child_process').spawnSync>);

    assert.equal(reusable, join(primaryRepo, 'node_modules'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensureRepoDependencies symlinks a reusable primary worktree node_modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-symlink-node-modules-'));
  try {
    const primaryRepo = join(root, 'primary');
    const worktreeRepo = join(root, 'worktree');
    await mkdir(join(primaryRepo, 'node_modules', 'typescript'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@iarna', 'toml'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', 'zod'), { recursive: true });
    await writeFile(join(primaryRepo, 'node_modules', 'typescript', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@iarna', 'toml', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', 'zod', 'package.json'), '{}');
    await mkdir(worktreeRepo, { recursive: true });

    const events: string[] = [];
    const result = ensureRepoDependencies(worktreeRepo, {
      gitRunner: () => ({
        status: 0,
        stdout: `${join(primaryRepo, '.git')}\n`,
        stderr: '',
      }) as ReturnType<typeof import('node:child_process').spawnSync>,
      install: () => {
        throw new Error('install should not be called when a reusable node_modules source exists');
      },
      log: (message: string) => events.push(message),
    });

    assert.equal(result.strategy, 'symlink');
    assert.equal(result.sourceNodeModulesPath, join(primaryRepo, 'node_modules'));
    assert.equal(events[0], `[smoke:packed-install] Reusing node_modules from ${join(primaryRepo, 'node_modules')}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensureRepoDependencies falls back to npm ci when no reusable node_modules source exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-install-node-modules-'));
  try {
    const installs: string[] = [];
    const result = ensureRepoDependencies(root, {
      gitRunner: () => ({
        status: 1,
        stdout: '',
        stderr: 'not a worktree',
      }) as ReturnType<typeof import('node:child_process').spawnSync>,
      install: (cwd: string) => {
        installs.push(cwd);
      },
    });

    assert.equal(result.strategy, 'installed');
    assert.deepEqual(installs, [root]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
