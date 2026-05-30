import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { buildMergedConfig } from '../../config/generator.js';
import type { CatalogManifest } from '../../catalog/schema.js';
import { getSetupInstallableSkillNames } from '../../catalog/installable.js';
import {
  buildOmxPluginMcpManifest,
  OMX_FIRST_PARTY_MCP_ENTRYPOINTS,
  OMX_FIRST_PARTY_MCP_PLUGIN_TARGETS,
  OMX_FIRST_PARTY_MCP_SERVER_NAMES,
  OMX_PLUGIN_MCP_COMMAND,
  OMX_PLUGIN_MCP_SERVE_SUBCOMMAND,
} from '../../config/omx-first-party-mcp.js';

type PackageJson = {
  version: string;
};


type PluginManifest = {
  name?: string;
  version?: string;
  skills?: string;
  agents?: string;
  prompts?: string;
  hooks?: string;
  mcpServers?: string;
  apps?: string;
  interface?: {
    displayName?: string;
    shortDescription?: string;
    longDescription?: string;
    developerName?: string;
    category?: string;
  };
};

type Marketplace = {
  name?: string;
  interface?: { displayName?: string };
  plugins?: Array<{
    name?: string;
    source?: { source?: string; path?: string };
    policy?: { installation?: string; authentication?: string };
    category?: string;
  }>;
};

const root = process.cwd();
const pluginName = 'oh-my-codex';
const pluginRoot = join(root, 'plugins', pluginName);
const pluginManifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
const pluginMcpPath = join(pluginRoot, '.mcp.json');
const pluginAppsPath = join(pluginRoot, '.app.json');
const pluginHooksPath = join(pluginRoot, 'hooks', 'hooks.json');
const pluginHookLauncherPath = join(pluginRoot, 'hooks', 'codex-native-hook.mjs');
const marketplacePath = join(root, '.agents', 'plugins', 'marketplace.json');
const omxBin = join(root, 'dist', 'cli', 'omx.js');

type PluginMcpManifest = {
  mcpServers?: Record<string, {
    command?: string;
    args?: string[];
    enabled?: boolean;
  }>;
};

type PluginAppsManifest = {
  apps?: Record<string, unknown>;
};

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), 'utf-8');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(fullPath, base);
    if (entry.isFile()) return [relative(base, fullPath).split(sep).join('/')];
    return [];
  }));
  return files.flat().sort();
}

async function writeOmxShim(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });

  if (process.platform === 'win32') {
    await writeFile(
      join(binDir, 'omx.cmd'),
      `@echo off\r\n"${process.execPath}" "${omxBin}" %*\r\n`,
      'utf-8',
    );
    return;
  }

  const shimPath = join(binDir, 'omx');
  await writeFile(
    shimPath,
    `#!/bin/sh\nexec "${process.execPath}" "${omxBin}" "$@"\n`,
    'utf-8',
  );
  await chmod(shimPath, 0o755);
}

async function createPluginMirrorFixtureRoot(): Promise<string> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'omx-plugin-mirror-fixture-'));
  await Promise.all([
    mkdir(join(fixtureRoot, 'plugins'), { recursive: true }),
    mkdir(join(fixtureRoot, 'src', 'catalog'), { recursive: true }),
  ]);
  await Promise.all([
    cp(join(root, 'package.json'), join(fixtureRoot, 'package.json')),
    cp(join(root, 'plugins', pluginName), join(fixtureRoot, 'plugins', pluginName), { recursive: true }),
    cp(join(root, 'skills'), join(fixtureRoot, 'skills'), { recursive: true }),
    cp(join(root, 'src', 'catalog', 'manifest.json'), join(fixtureRoot, 'src', 'catalog', 'manifest.json')),
  ]);
  return fixtureRoot;
}

async function assertSyncPluginRepairsMissingHooksPointer(): Promise<void> {
  const fixtureRoot = await createPluginMirrorFixtureRoot();
  try {
    const fixtureManifestPath = join(fixtureRoot, 'plugins', pluginName, '.codex-plugin', 'plugin.json');
    const fixtureHooksPath = join(fixtureRoot, 'plugins', pluginName, 'hooks', 'hooks.json');
    const originalManifest = await readFile(fixtureManifestPath, 'utf-8');
    const manifest = JSON.parse(originalManifest) as PluginManifest;
    delete manifest.hooks;
    await writeFile(fixtureManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = spawnSync(process.execPath, [join(root, 'dist', 'scripts', 'sync-plugin-mirror.js')], {
      cwd: fixtureRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        OMX_AUTO_UPDATE: '0',
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const repairedManifest = await readJson<PluginManifest>(fixtureManifestPath);
    assert.equal(repairedManifest.hooks, './hooks/hooks.json');

    const hooksManifest = await readJson<{ hooks?: Record<string, Array<{ matcher?: string }>> }>(fixtureHooksPath);
    const preToolUseEntries = hooksManifest.hooks?.PreToolUse ?? [];
    assert.notEqual(preToolUseEntries.length, 0, 'fixture sync should keep PreToolUse hook entries');
    assert.deepEqual(
      preToolUseEntries.map((entry) => entry.matcher).filter((matcher): matcher is string => typeof matcher === 'string'),
      [],
      'fixture sync must not reintroduce a Bash-only PreToolUse matcher',
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function assertSyncPluginCheckRejectsLauncherWithoutContract(): Promise<void> {
  const fixtureRoot = await createPluginMirrorFixtureRoot();
  try {
    const fixtureHookLauncherPath = join(fixtureRoot, 'plugins', pluginName, 'hooks', 'codex-native-hook.mjs');
    const launcher = await readFile(fixtureHookLauncherPath, 'utf-8');
    await writeFile(
      fixtureHookLauncherPath,
      launcher.replace('omx-plugin-hook-launcher:v1', 'omx-plugin-hook-launcher:missing'),
      'utf-8',
    );

    const result = spawnSync(process.execPath, [join(root, 'dist', 'scripts', 'sync-plugin-mirror.js'), '--check'], {
      cwd: fixtureRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        OMX_AUTO_UPDATE: '0',
      },
    });

    assert.notEqual(result.status, 0, 'sync-plugin-mirror --check should reject launcher contract drift');
    assert.match(result.stderr, /plugin_bundle_metadata_out_of_sync/);
    assert.match(result.stderr, /kind=hook-launcher/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function assertPluginHookEventsAlignWithLauncher(): Promise<void> {
  const hooksManifest = await readJson<{ hooks?: Record<string, unknown> }>(pluginHooksPath);
  const launcher = await readFile(pluginHookLauncherPath, 'utf-8');
  const eventSetMatch = launcher.match(/const CODEX_HOOK_EVENT_NAMES = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(eventSetMatch, 'plugin hook launcher should declare a CODEX_HOOK_EVENT_NAMES set');
  const launcherEvents = Array.from(eventSetMatch[1].matchAll(/'([^']+)'/g), (match) => match[1]).sort();
  assert.deepEqual(
    launcherEvents,
    Object.keys(hooksManifest.hooks ?? {}).sort(),
    'plugin hook launcher event allowlist must stay aligned with generated plugin hooks manifest',
  );
}

async function assertPluginHookLaunchesPostCompactFromCache(): Promise<void> {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'omx-plugin-hook-cache-'));
  const cachePluginRoot = join(cacheRoot, pluginName, 'local');
  const shimDir = join(cacheRoot, 'bin');
  await cp(pluginRoot, cachePluginRoot, { recursive: true });
  await writeOmxShim(shimDir);

  try {
    const payload = JSON.stringify({
      hook_event_name: 'PostCompact',
      session_id: 'omx-plugin-hook-postcompact-smoke',
      transcript_path: join(cacheRoot, 'missing-transcript.jsonl'),
      cwd: cacheRoot,
    });
    const result = spawnSync(process.execPath, [join(cachePluginRoot, 'hooks', 'codex-native-hook.mjs')], {
      cwd: cachePluginRoot,
      encoding: 'utf-8',
      input: payload,
      env: {
        ...process.env,
        PATH: `${shimDir}${delimiter}${process.env.PATH || ''}`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
        OMX_ROOT: join(cacheRoot, '.omx-root'),
        OMX_SESSION_ID: 'omx-plugin-hook-postcompact-smoke',
        OMX_SOURCE_CWD: cacheRoot,
        OMX_STARTUP_CWD: cacheRoot,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout, '', 'PostCompact plugin hook launcher should emit no stdout');
    assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|Cannot find module/);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
}

async function assertPluginHookDelegatesPostCompactToPinnedCommand(): Promise<void> {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'omx-plugin-hook-delegate-'));
  const cachePluginRoot = join(cacheRoot, pluginName, 'local');
  const recorderPath = join(cacheRoot, 'record-hook.mjs');
  const argsPath = join(cacheRoot, 'recorded-args.json');
  const stdinPath = join(cacheRoot, 'recorded-stdin.json');
  await cp(pluginRoot, cachePluginRoot, { recursive: true });
  await writeFile(
    recorderPath,
    [
      "import { writeFileSync } from 'node:fs';",
      "const chunks = [];",
      "for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));",
      `writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
      `writeFileSync(${JSON.stringify(stdinPath)}, Buffer.concat(chunks));`,
      "",
    ].join('\n'),
    'utf-8',
  );
  await writeJson(join(cachePluginRoot, 'hooks', 'omx-command.json'), {
    command: process.execPath,
    argsPrefix: [recorderPath],
  });

  try {
    const payload = JSON.stringify({
      hook_event_name: 'PostCompact',
      session_id: 'omx-plugin-hook-postcompact-delegate',
      transcript_path: join(cacheRoot, 'missing-transcript.jsonl'),
      cwd: cacheRoot,
    });
    const result = spawnSync(process.execPath, [join(cachePluginRoot, 'hooks', 'codex-native-hook.mjs')], {
      cwd: cachePluginRoot,
      encoding: 'utf-8',
      input: payload,
      env: {
        ...process.env,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
        OMX_ROOT: join(cacheRoot, '.omx-root'),
        OMX_SESSION_ID: 'omx-plugin-hook-postcompact-delegate',
        OMX_SOURCE_CWD: cacheRoot,
        OMX_STARTUP_CWD: cacheRoot,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout, '', 'PostCompact plugin hook launcher should emit no stdout when delegate is quiet');
    assert.deepEqual(JSON.parse(await readFile(argsPath, 'utf-8')), ['codex-native-hook']);
    assert.deepEqual(JSON.parse(await readFile(stdinPath, 'utf-8')), JSON.parse(payload));
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
}

async function assertPluginCacheLaunchable(entrypoint: string): Promise<void> {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'omx-plugin-cache-'));
  const cachePluginRoot = join(cacheRoot, pluginName, 'local');
  const shimDir = join(cacheRoot, 'bin');
  await cp(pluginRoot, cachePluginRoot, { recursive: true });
  await writeOmxShim(shimDir);

  try {
    const result = spawnSync(OMX_PLUGIN_MCP_COMMAND, [OMX_PLUGIN_MCP_SERVE_SUBCOMMAND, entrypoint], {
      cwd: cachePluginRoot,
      encoding: 'utf-8',
      input: '',
      env: {
        ...process.env,
        PATH: `${shimDir}${delimiter}${process.env.PATH || ''}`,
        OMX_AUTO_UPDATE: '0',
        OMX_NOTIFY_FALLBACK: '0',
        OMX_HOOK_DERIVED_SIGNALS: '0',
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr.trim(), '', `${entrypoint} should not fail when launched from a cache-style plugin root`);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
}

function parseSingleJsonStdout(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  assert.notEqual(trimmed, '');
  assert.equal(trimmed.split('\n').length, 1);
  return JSON.parse(trimmed) as Record<string, unknown>;
}

async function withPluginCacheCopy<T>(run: (cachePluginRoot: string, cacheRoot: string) => Promise<T>): Promise<T> {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'omx-plugin-hook-cache-'));
  const cachePluginRoot = join(cacheRoot, pluginName, 'local');
  await cp(pluginRoot, cachePluginRoot, { recursive: true });
  try {
    return await run(cachePluginRoot, cacheRoot);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
}

function pluginHookEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['OMX_TEAM_STATE_ROOT', 'OMX_ROOT', 'OMX_STATE_ROOT', 'OMX_SESSION_ID', 'CODEX_SESSION_ID']) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

function runPluginNativeHook(
  cachePluginRoot: string,
  input: string,
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, [join(cachePluginRoot, 'hooks', 'codex-native-hook.mjs')], {
    cwd: cachePluginRoot,
    input,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: pluginHookEnv(env),
  });
}

describe('official Codex plugin layout', () => {
  it('defines a plugin manifest under a plugin root and keeps .codex-plugin limited to plugin.json', async () => {
    const pkg = await readJson<PackageJson>(join(root, 'package.json'));
    const manifest = await readJson<PluginManifest>(pluginManifestPath);
    const codexPluginEntries = await readdir(join(pluginRoot, '.codex-plugin'));

    assert.deepEqual(codexPluginEntries.sort(), ['plugin.json']);
    assert.equal(manifest.name, pluginName);
    assert.equal(manifest.name, pluginRoot.split(sep).at(-1));
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.skills, './skills/');
    assert.equal(manifest.mcpServers, './.mcp.json');
    assert.equal(manifest.apps, './.app.json');
    assert.equal(manifest.interface?.displayName, 'oh-my-codex');
    assert.equal(manifest.interface?.category, 'Developer Tools');
    assert.ok(manifest.interface?.shortDescription, 'expected short interface description');
    assert.ok(manifest.interface?.longDescription, 'expected long interface description');
    assert.ok(manifest.interface?.developerName, 'expected developerName');
  });

  it('repairs a missing plugin hooks manifest pointer during plugin sync', async () => {
    await assertSyncPluginRepairsMissingHooksPointer();
  });

  it('rejects plugin hook launcher drift during plugin sync check', async () => {
    await assertSyncPluginCheckRejectsLauncherWithoutContract();
  });

  it('keeps generated plugin hook events aligned with the launcher allowlist', async () => {
    await assertPluginHookEventsAlignWithLauncher();
  });

  it('ships plugin-scoped hooks and disabled-by-default MCP compatibility metadata', async () => {
    const [mcpManifest, appsManifest, hooksManifest] = await Promise.all([
      readJson<PluginMcpManifest>(pluginMcpPath),
      readJson<PluginAppsManifest>(pluginAppsPath),
      readJson<{ hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>> }>(pluginHooksPath),
    ]);
    const expectedPluginMcpManifest = buildOmxPluginMcpManifest();

    const pluginManifest = await readJson<PluginManifest>(pluginManifestPath);
    assert.equal(pluginManifest.agents, undefined);
    assert.equal(pluginManifest.prompts, undefined);
    assert.equal(pluginManifest.hooks, './hooks/hooks.json');
    assert.deepEqual(appsManifest, { apps: {} });
    const hookCommands = Object.values(hooksManifest.hooks ?? {})
      .flatMap((entries) => entries)
      .flatMap((entry) => entry.hooks ?? [])
      .map((hook) => hook.command);
    assert.ok(
      hookCommands.every((command) => command === 'node "${PLUGIN_ROOT}/hooks/codex-native-hook.mjs"'),
      'plugin hooks should use Codex PLUGIN_ROOT instead of setup-owned .codex/hooks.json',
    );
    assert.equal(
      hooksManifest.hooks?.PreToolUse?.some((entry) => typeof entry.matcher === 'string'),
      false,
      'plugin PreToolUse hooks must cover non-Bash tools just like setup-owned native hooks',
    );
    assert.deepEqual(mcpManifest, expectedPluginMcpManifest);

    for (const [serverName, server] of Object.entries(mcpManifest.mcpServers ?? {})) {
      assert.equal(server.command, OMX_PLUGIN_MCP_COMMAND, `${serverName} should run via omx`);
      assert.notEqual(server.command, 'node', `${serverName} should not depend on a bare node command`);
      assert.equal(server.enabled, false, `${serverName} should be disabled by default`);
      assert.equal(server.args?.length, 2, `${serverName} should have serve subcommand + public target args`);
      assert.equal(server.args?.[0], OMX_PLUGIN_MCP_SERVE_SUBCOMMAND, `${serverName} should launch through omx mcp-serve`);
      const target = server.args?.[1];
      assert.ok(target, `${serverName} should declare a public target`);
      assert.equal(target?.includes('..'), false, `${serverName} should not depend on path traversal outside the plugin root`);
      assert.equal(OMX_FIRST_PARTY_MCP_PLUGIN_TARGETS.includes(target ?? ''), true, `${serverName} should use a stable public OMX MCP target`);
      assert.equal(target?.endsWith('-server.js'), false, `${serverName} should not expose internal dist filenames in plugin metadata`);
    }
  });

  it('emits Stop JSON when the plugin hook pinned launcher is invalid', async () => {
    await withPluginCacheCopy(async (cachePluginRoot) => {
      await writeFile(join(cachePluginRoot, 'hooks', 'omx-command.json'), '{"command":', 'utf-8');

      const result = runPluginNativeHook(cachePluginRoot, JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'sess-plugin-invalid-launcher-stop',
      }));

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stderr, /invalid plugin hook launcher/);
      const output = parseSingleJsonStdout(result.stdout);
      assert.equal(output.decision, 'block');
      assert.equal(output.stopReason, 'plugin_stop_hook_launcher_failure');
    });
  });

  it('emits Stop JSON when the plugin hook command cannot spawn', async () => {
    await withPluginCacheCopy(async (cachePluginRoot, cacheRoot) => {
      const result = runPluginNativeHook(
        cachePluginRoot,
        JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-plugin-missing-command-stop' }),
        {
          OMX_NATIVE_HOOK_COMMAND: join(cacheRoot, 'bin', 'missing-omx-command'),
        },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const output = parseSingleJsonStdout(result.stdout);
      assert.equal(output.decision, 'block');
      assert.equal(output.stopReason, 'plugin_stop_hook_launcher_spawn_error');
    });
  });

  it('emits Stop JSON when the launched plugin hook command exits before producing stdout', async () => {
    await withPluginCacheCopy(async (cachePluginRoot) => {
      const result = runPluginNativeHook(
        cachePluginRoot,
        JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-plugin-false-command-stop' }),
        {
          OMX_NATIVE_HOOK_COMMAND: process.platform === 'win32' ? 'cmd.exe /c exit 1' : '/bin/false',
        },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const output = parseSingleJsonStdout(result.stdout);
      assert.equal(output.decision, 'block');
      assert.match(String(output.stopReason ?? ''), /plugin_stop_hook_launcher_(?:exit|stdin_error)/);
    });
  });

  it('emits Stop JSON when the launched plugin hook command exits successfully without stdout', async () => {
    await withPluginCacheCopy(async (cachePluginRoot, cacheRoot) => {
      const commandPath = join(cacheRoot, process.platform === 'win32' ? 'empty-ok.cmd' : 'empty-ok.sh');
      if (process.platform === 'win32') {
        await writeFile(commandPath, '@echo off\r\nexit /b 0\r\n', 'utf-8');
      } else {
        await writeFile(commandPath, '#!/bin/sh\nexit 0\n', 'utf-8');
        await chmod(commandPath, 0o755);
      }

      const result = runPluginNativeHook(
        cachePluginRoot,
        JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-plugin-empty-ok-stop' }),
        { OMX_NATIVE_HOOK_COMMAND: commandPath },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const output = parseSingleJsonStdout(result.stdout);
      assert.equal(output.decision, 'block');
      assert.equal(output.stopReason, 'plugin_stop_hook_launcher_empty_stdout');
    });
  });

  it('does not append fallback Stop JSON after partial child stdout', async () => {
    await withPluginCacheCopy(async (cachePluginRoot, cacheRoot) => {
      const commandPath = join(cacheRoot, process.platform === 'win32' ? 'partial.cmd' : 'partial.sh');
      if (process.platform === 'win32') {
        await writeFile(commandPath, '@echo off\r\n<nul set /p=PARTIAL\r\nexit /b 2\r\n', 'utf-8');
      } else {
        await writeFile(commandPath, '#!/bin/sh\nprintf PARTIAL\nexit 2\n', 'utf-8');
        await chmod(commandPath, 0o755);
      }

      const result = runPluginNativeHook(
        cachePluginRoot,
        JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-plugin-partial-stop' }),
        { OMX_NATIVE_HOOK_COMMAND: commandPath },
      );

      assert.equal(result.status, 2, result.stderr || result.stdout);
      assert.equal(result.stdout, 'PARTIAL');
      assert.doesNotMatch(result.stdout, /plugin_stop_hook_launcher/);
    });
  });

  it('emits Stop JSON for malformed Stop-looking stdin before invalid launcher failure', async () => {
    await withPluginCacheCopy(async (cachePluginRoot) => {
      await writeFile(join(cachePluginRoot, 'hooks', 'omx-command.json'), '{"command":', 'utf-8');

      const result = runPluginNativeHook(cachePluginRoot, '{"hook_event_name":"Stop",');

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const output = parseSingleJsonStdout(result.stdout);
      assert.equal(output.decision, 'block');
      assert.equal(output.stopReason, 'plugin_stop_hook_launcher_failure');
    });
  });

  it('emits Stop JSON for the core-supported name alias before invalid launcher failure', async () => {
    await withPluginCacheCopy(async (cachePluginRoot) => {
      await writeFile(join(cachePluginRoot, 'hooks', 'omx-command.json'), '{"command":', 'utf-8');

      const result = runPluginNativeHook(cachePluginRoot, '{"name":"Stop",');

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const output = parseSingleJsonStdout(result.stdout);
      assert.equal(output.decision, 'block');
      assert.equal(output.stopReason, 'plugin_stop_hook_launcher_failure');
    });
  });

  it('keeps non-Stop plugin hook launcher failures fail-closed without Stop JSON', async () => {
    await withPluginCacheCopy(async (cachePluginRoot) => {
      await writeFile(join(cachePluginRoot, 'hooks', 'omx-command.json'), '{"command":', 'utf-8');

      const result = runPluginNativeHook(cachePluginRoot, JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'hello',
      }));

      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /invalid plugin hook launcher/);
    });
  });

  it('does not classify valid non-Stop plugin JSON with nested Stop text as Stop', async () => {
    await withPluginCacheCopy(async (cachePluginRoot) => {
      await writeFile(join(cachePluginRoot, 'hooks', 'omx-command.json'), '{"command":', 'utf-8');

      const result = runPluginNativeHook(cachePluginRoot, JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_input: { name: 'Stop' },
      }));

      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /invalid plugin hook launcher/);
    });
  });

  it('does not classify malformed non-Stop plugin JSON with nested Stop text as Stop', async () => {
    await withPluginCacheCopy(async (cachePluginRoot) => {
      await writeFile(join(cachePluginRoot, 'hooks', 'omx-command.json'), '{"command":', 'utf-8');

      const result = runPluginNativeHook(
        cachePluginRoot,
        '{"hook_event_name":"PreToolUse","tool_input":{"name":"Stop"},',
      );

      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /invalid plugin hook launcher/);
    });
  });

  it('allows oversized plugin Stop stdin when no active workflow state is present', async () => {
    await withPluginCacheCopy(async (cachePluginRoot) => {
      const oversizedStop = `{"hook_event_name":"Stop","padding":"${'x'.repeat(1024 * 1024 + 1)}`;
      const result = runPluginNativeHook(cachePluginRoot, oversizedStop);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(parseSingleJsonStdout(result.stdout), {});
    });
  });

  it('blocks oversized plugin Stop stdin when current session autopilot state is active', async () => {
    await withPluginCacheCopy(async (cachePluginRoot) => {
      const sessionId = 'sess-plugin-oversized-active';
      await writeJson(join(cachePluginRoot, '.omx', 'state', 'session.json'), { session_id: sessionId });
      await writeJson(join(cachePluginRoot, '.omx', 'state', 'sessions', sessionId, 'autopilot-state.json'), {
        active: true,
        current_phase: 'execution',
      });
      const oversizedStop = `{"hook_event_name":"Stop","cwd":"${cachePluginRoot}","session_id":"${sessionId}","padding":"${'x'.repeat(1024 * 1024 + 1)}`;
      const result = runPluginNativeHook(cachePluginRoot, oversizedStop);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const output = parseSingleJsonStdout(result.stdout);
      assert.equal(output.decision, 'block');
      assert.equal(output.stopReason, 'plugin_stop_hook_stdin_oversized_active_workflow');
    });
  });

  it('does not let unrelated terminal run-state suppress active plugin Autopilot oversized Stop blocking', async () => {
    await withPluginCacheCopy(async (cachePluginRoot) => {
      const sessionId = 'sess-plugin-oversized-unrelated-terminal';
      await writeJson(join(cachePluginRoot, '.omx', 'state', 'session.json'), { session_id: sessionId });
      await writeJson(join(cachePluginRoot, '.omx', 'state', 'sessions', sessionId, 'autopilot-state.json'), {
        active: true,
        current_phase: 'execution',
      });
      await writeJson(join(cachePluginRoot, '.omx', 'state', 'sessions', sessionId, 'run-state.json'), {
        mode: 'ralph',
        active: false,
        outcome: 'finish',
      });
      const oversizedStop = `{"hook_event_name":"Stop","cwd":"${cachePluginRoot}","session_id":"${sessionId}","padding":"${'x'.repeat(1024 * 1024 + 1)}`;
      const result = runPluginNativeHook(cachePluginRoot, oversizedStop);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const output = parseSingleJsonStdout(result.stdout);
      assert.equal(output.decision, 'block');
      assert.equal(output.stopReason, 'plugin_stop_hook_stdin_oversized_active_workflow');
    });
  });

  it('allows oversized plugin Stop stdin when terminal Autopilot run-state shadows stale active state', async () => {
    await withPluginCacheCopy(async (cachePluginRoot) => {
      const sessionId = 'sess-plugin-oversized-terminal-autopilot';
      await writeJson(join(cachePluginRoot, '.omx', 'state', 'session.json'), { session_id: sessionId });
      await writeJson(join(cachePluginRoot, '.omx', 'state', 'sessions', sessionId, 'autopilot-state.json'), {
        active: true,
        current_phase: 'execution',
      });
      await writeJson(join(cachePluginRoot, '.omx', 'state', 'sessions', sessionId, 'run-state.json'), {
        mode: 'autopilot',
        active: false,
        outcome: 'blocked_on_user',
      });
      const oversizedStop = `{"hook_event_name":"Stop","cwd":"${cachePluginRoot}","session_id":"${sessionId}","padding":"${'x'.repeat(1024 * 1024 + 1)}`;
      const result = runPluginNativeHook(cachePluginRoot, oversizedStop);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(parseSingleJsonStdout(result.stdout), {});
    });
  });

  it('detects active plugin Autopilot state for oversized Stop under OMX_ROOT', async () => {
    await withPluginCacheCopy(async (cachePluginRoot, cacheRoot) => {
      const sessionId = 'sess-plugin-oversized-omx-root';
      const omxRoot = join(cacheRoot, 'boxed-root');
      await writeJson(join(omxRoot, '.omx', 'state', 'session.json'), { session_id: sessionId });
      await writeJson(join(omxRoot, '.omx', 'state', 'sessions', sessionId, 'autopilot-state.json'), {
        active: true,
        current_phase: 'execution',
      });
      const oversizedStop = `{"hook_event_name":"Stop","cwd":"${cachePluginRoot}","session_id":"${sessionId}","padding":"${'x'.repeat(1024 * 1024 + 1)}`;
      const result = runPluginNativeHook(cachePluginRoot, oversizedStop, { OMX_ROOT: omxRoot });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const output = parseSingleJsonStdout(result.stdout);
      assert.equal(output.decision, 'block');
      assert.equal(output.stopReason, 'plugin_stop_hook_stdin_oversized_active_workflow');
    });
  });

  it('lets terminal OMX_ROOT Autopilot state override stale cwd active state for oversized Stop', async () => {
    await withPluginCacheCopy(async (cachePluginRoot, cacheRoot) => {
      const sessionId = 'sess-plugin-oversized-omx-root-terminal';
      const omxRoot = join(cacheRoot, 'boxed-root-terminal');
      await writeJson(join(omxRoot, '.omx', 'state', 'session.json'), { session_id: sessionId });
      await writeJson(join(omxRoot, '.omx', 'state', 'sessions', sessionId, 'run-state.json'), {
        mode: 'autopilot',
        outcome: 'blocked_on_user',
      });
      await writeJson(join(cachePluginRoot, '.omx', 'state', 'session.json'), { session_id: sessionId });
      await writeJson(join(cachePluginRoot, '.omx', 'state', 'sessions', sessionId, 'autopilot-state.json'), {
        active: true,
        current_phase: 'execution',
      });
      const oversizedStop = `{"hook_event_name":"Stop","cwd":"${cachePluginRoot}","session_id":"${sessionId}","padding":"${'x'.repeat(1024 * 1024 + 1)}`;
      const result = runPluginNativeHook(cachePluginRoot, oversizedStop, { OMX_ROOT: omxRoot });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(parseSingleJsonStdout(result.stdout), {});
    });
  });

  it('allows oversized plugin Stop when Autopilot state is active but terminal by phase', async () => {
    await withPluginCacheCopy(async (cachePluginRoot) => {
      const sessionId = 'sess-plugin-oversized-terminal-phase';
      await writeJson(join(cachePluginRoot, '.omx', 'state', 'session.json'), { session_id: sessionId });
      await writeJson(join(cachePluginRoot, '.omx', 'state', 'sessions', sessionId, 'autopilot-state.json'), {
        active: true,
        current_phase: 'complete',
      });
      const oversizedStop = `{"hook_event_name":"Stop","cwd":"${cachePluginRoot}","session_id":"${sessionId}","padding":"${'x'.repeat(1024 * 1024 + 1)}`;
      const result = runPluginNativeHook(cachePluginRoot, oversizedStop);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(parseSingleJsonStdout(result.stdout), {});
    });
  });

  it('ignores stale plugin session state whose cwd does not match oversized Stop cwd', async () => {
    await withPluginCacheCopy(async (cachePluginRoot, cacheRoot) => {
      const sessionId = 'sess-plugin-oversized-stale-cwd';
      await writeJson(join(cachePluginRoot, '.omx', 'state', 'session.json'), {
        session_id: sessionId,
        cwd: join(cacheRoot, 'different-cwd'),
      });
      await writeJson(join(cachePluginRoot, '.omx', 'state', 'sessions', sessionId, 'autopilot-state.json'), {
        active: true,
        current_phase: 'execution',
      });
      const oversizedStop = `{"hook_event_name":"Stop","cwd":"${cachePluginRoot}","session_id":"${sessionId}","padding":"${'x'.repeat(1024 * 1024 + 1)}`;
      const result = runPluginNativeHook(cachePluginRoot, oversizedStop);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(parseSingleJsonStdout(result.stdout), {});
    });
  });

  it('fails oversized non-Stop plugin stdin without Stop JSON', async () => {
    await withPluginCacheCopy(async (cachePluginRoot) => {
      const result = runPluginNativeHook(cachePluginRoot, 'x'.repeat(1024 * 1024 + 1));

      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /plugin hook stdin exceeded/);
    });
  });

  it('forwards under-cap plugin hook stdin bytes unchanged to the delegated command', async () => {
    await withPluginCacheCopy(async (cachePluginRoot, cacheRoot) => {
      const capturePath = join(cacheRoot, 'captured-stdin.json');
      const commandPath = join(cacheRoot, 'capture-hook.mjs');
      const launcherPath = join(cacheRoot, process.platform === 'win32' ? 'capture-hook.cmd' : 'capture-hook.sh');
      await writeFile(
        commandPath,
        `import { writeFileSync } from 'node:fs';
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  writeFileSync(process.env.CAPTURE_PATH, Buffer.concat(chunks));
  process.stdout.write('{}\\n');
});
`,
        'utf-8',
      );
      if (process.platform === 'win32') {
        await writeFile(launcherPath, `@echo off\r\n"${process.execPath}" "${commandPath}" %*\r\n`, 'utf-8');
      } else {
        await writeFile(launcherPath, `#!/bin/sh\nexec "${process.execPath}" "${commandPath}" "$@"\n`, 'utf-8');
        await chmod(launcherPath, 0o755);
      }

      const input = JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'sess-plugin-forward-stdin',
        payload: 'keep these bytes unchanged',
      });
      const result = runPluginNativeHook(cachePluginRoot, input, {
        OMX_NATIVE_HOOK_COMMAND: launcherPath,
        CAPTURE_PATH: capturePath,
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(parseSingleJsonStdout(result.stdout), {});
      assert.equal(await readFile(capturePath, 'utf-8'), input);
    });
  });

  it('keeps plugin MCP metadata aligned with the explicit compat setup-managed MCP roster', async () => {
    const mcpManifest = await readJson<PluginMcpManifest>(pluginMcpPath);
    const defaultConfig = buildMergedConfig('', root, { includeTui: false });
    assert.doesNotMatch(
      defaultConfig,
      /^\[mcp_servers\.omx_state\]$/m,
      'default setup config should stay CLI-first without first-party MCP tables',
    );
    const mergedConfig = buildMergedConfig('', root, { includeTui: false, includeFirstPartyMcp: true });
    const setupManagedServers = [...mergedConfig.matchAll(/^\[mcp_servers\.(omx_[^\]]+)\]$/gm)]
      .map((match) => match[1])
      .sort();

    assert.deepEqual(
      setupManagedServers,
      [...OMX_FIRST_PARTY_MCP_SERVER_NAMES].sort(),
      'setup should expose the canonical first-party OMX MCP roster',
    );
    assert.deepEqual(setupManagedServers, Object.keys(mcpManifest.mcpServers ?? {}).sort());

    const targetToEntrypoint = new Map(
      OMX_FIRST_PARTY_MCP_PLUGIN_TARGETS.map((target, index) => [target, OMX_FIRST_PARTY_MCP_ENTRYPOINTS[index]]),
    );

    for (const [serverName, server] of Object.entries(mcpManifest.mcpServers ?? {})) {
      const target = server.args?.[1] ?? '';
      const entrypoint = targetToEntrypoint.get(target);
      assert.ok(entrypoint, `${serverName} should expose a canonical public target`);
      assert.match(
        mergedConfig,
        new RegExp(`\\[mcp_servers\\.${escapeRegex(serverName)}\\][\\s\\S]*?${escapeRegex(entrypoint)}`),
        `${serverName} should stay aligned with the setup-managed MCP entrypoint`,
      );
    }
  });

  it('launches plugin MCP public targets from a cache-style plugin root via the installed omx CLI', async () => {
    for (const target of OMX_FIRST_PARTY_MCP_PLUGIN_TARGETS) {
      await assertPluginCacheLaunchable(target);
    }
  });

  it('launches the plugin-scoped native hook for PostCompact from a cache-style plugin root', async () => {
    await assertPluginHookLaunchesPostCompactFromCache();
  });

  it('delegates PostCompact plugin hook payloads to the pinned launcher command', async () => {
    await assertPluginHookDelegatesPostCompactToPinnedCommand();
  });

  it('does not stage setup-owned hook or runtime directories inside the plugin', async () => {
    const pluginEntries = await readdir(pluginRoot);

    assert.equal(pluginEntries.includes('.codex'), false, 'official plugin should not ship setup-owned .codex hook assets');
    assert.equal(pluginEntries.includes('.omx'), false, 'official plugin should not ship runtime hook directories');
    assert.equal(pluginEntries.includes('hooks.json'), false, 'official plugin hook metadata should stay under hooks/');
    assert.equal(pluginEntries.includes('hooks'), true, 'official plugin should ship plugin-scoped lifecycle hooks');
    await stat(pluginHookLauncherPath);
  });

  it('registers the plugin in the repo marketplace with explicit source, policy, and category', async () => {
    const marketplace = await readJson<Marketplace>(marketplacePath);
    const entry = marketplace.plugins?.find((candidate) => candidate.name === pluginName);

    assert.equal(marketplace.name, 'oh-my-codex-local');
    assert.equal(marketplace.interface?.displayName, 'oh-my-codex Local Plugins');
    assert.ok(entry, 'expected marketplace entry for oh-my-codex');
    assert.equal(entry.source?.source, 'local');
    assert.equal(entry.source?.path, './plugins/oh-my-codex');
    assert.equal(entry.policy?.installation, 'AVAILABLE');
    assert.equal(entry.policy?.authentication, 'ON_INSTALL');
    assert.equal(entry.category, 'Developer Tools');
  });

  it('mirrors exactly the setup-installable skill subset from the canonical root skills', async () => {
    const manifest = await readJson<CatalogManifest>(join(root, 'src', 'catalog', 'manifest.json'));
    const expectedSkillNames = [...getSetupInstallableSkillNames(manifest)].sort();

    const pluginSkillEntries = await readdir(join(pluginRoot, 'skills'), { withFileTypes: true });
    const actualSkillNames = pluginSkillEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    assert.deepEqual(actualSkillNames, expectedSkillNames);
    assert.ok(actualSkillNames.includes('worker'), 'internal setup-installed worker skill should be mirrored');
    assert.ok(actualSkillNames.includes('performance-goal'), 'performance-goal should be available through setup/plugin skill delivery');
    assert.ok(actualSkillNames.includes('autoresearch-goal'), 'autoresearch-goal should be available through setup/plugin skill delivery');
    assert.ok(actualSkillNames.includes('ultragoal'), 'ultragoal should remain available through setup/plugin skill delivery');
    assert.equal(actualSkillNames.includes('ecomode'), false, 'deprecated skills should not be mirrored');
    assert.equal(actualSkillNames.includes('swarm'), false, 'deprecated skills should not be mirrored');
    assert.equal(actualSkillNames.includes('configure-discord'), false, 'merged notification aliases should not be mirrored');

    for (const skillName of expectedSkillNames) {
      const rootSkillDir = join(root, 'skills', skillName);
      const pluginSkillDir = join(pluginRoot, 'skills', skillName);
      const [rootStat, pluginStat] = await Promise.all([stat(rootSkillDir), stat(pluginSkillDir)]);
      assert.equal(rootStat.isDirectory(), true, `${skillName} root skill should be a directory`);
      assert.equal(pluginStat.isDirectory(), true, `${skillName} plugin skill should be a directory`);

      const [rootFiles, pluginFiles] = await Promise.all([
        listFiles(rootSkillDir),
        listFiles(pluginSkillDir),
      ]);
      assert.deepEqual(pluginFiles, rootFiles, `${skillName} plugin file list should match root skill`);

      for (const file of rootFiles) {
        const [rootContent, pluginContent] = await Promise.all([
          readFile(join(rootSkillDir, file), 'utf-8'),
          readFile(join(pluginSkillDir, file), 'utf-8'),
        ]);
        assert.equal(pluginContent, rootContent, `${skillName}/${file} should match canonical root skill file`);
      }
    }
  });

  it('documents marketplace-aware cache semantics without replacing full setup', async () => {
    const staleCachePath = '~/.codex/plugins/cache/omc/oh-my-codex';
    const docsToCheck = [
      'README.md',
      'docs/troubleshooting.md',
      'docs/hooks-extension.md',
      'skills/doctor/SKILL.md',
      'skills/help/SKILL.md',
      'plugins/oh-my-codex/skills/doctor/SKILL.md',
      'plugins/oh-my-codex/skills/omx-setup/SKILL.md',
    ];

    for (const docPath of docsToCheck) {
      const content = await readFile(join(root, docPath), 'utf-8');
      assert.equal(content.includes(staleCachePath), false, `${docPath} should not hard-code stale omc cache path`);
    }

    const combinedDocs = await Promise.all(docsToCheck.map((docPath) => readFile(join(root, docPath), 'utf-8')));
    const combined = combinedDocs.join('\n');
    assert.match(combined, /plugins\/cache\/\$MARKETPLACE_NAME\/oh-my-codex\/\$VERSION\//);
    assert.match(combined, /not a replacement for `npm install -g oh-my-codex` plus `omx setup`/);
    assert.match(combined, /legacy setup mode installs native agents(?:\/| and )prompts|plugin setup mode archives stale legacy prompt\/native-agent files/);
    assert.match(combined, /plugin-scoped companion metadata for official Codex lifecycle hooks/i);
    assert.match(combined, /legacy\/fallback native Codex hook registrations|legacy setup mode installs prompts\/native agents and \.codex\/hooks\.json/i);
  });
});
