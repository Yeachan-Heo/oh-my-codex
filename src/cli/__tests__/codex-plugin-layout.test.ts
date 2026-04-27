import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, sep } from 'node:path';
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

  it('ships plugin-scoped companion metadata for MCP servers and apps while hooks stay setup-owned', async () => {
    const [mcpManifest, appsManifest] = await Promise.all([
      readJson<PluginMcpManifest>(pluginMcpPath),
      readJson<PluginAppsManifest>(pluginAppsPath),
    ]);
    const expectedPluginMcpManifest = buildOmxPluginMcpManifest();

    const pluginManifest = await readJson<PluginManifest>(pluginManifestPath);
    assert.equal(pluginManifest.agents, undefined);
    assert.equal(pluginManifest.prompts, undefined);
    assert.equal(pluginManifest.hooks, undefined);
    assert.deepEqual(appsManifest, { apps: {} });
    assert.deepEqual(mcpManifest, expectedPluginMcpManifest);

    for (const [serverName, server] of Object.entries(mcpManifest.mcpServers ?? {})) {
      assert.equal(server.command, OMX_PLUGIN_MCP_COMMAND, `${serverName} should run via omx`);
      assert.equal(server.enabled, true, `${serverName} should be enabled`);
      assert.equal(server.args?.length, 2, `${serverName} should have serve subcommand + public target args`);
      assert.equal(server.args?.[0], OMX_PLUGIN_MCP_SERVE_SUBCOMMAND, `${serverName} should launch through omx mcp-serve`);
      const target = server.args?.[1];
      assert.ok(target, `${serverName} should declare a public target`);
      assert.equal(target?.includes('..'), false, `${serverName} should not depend on path traversal outside the plugin root`);
      assert.equal(OMX_FIRST_PARTY_MCP_PLUGIN_TARGETS.includes(target ?? ''), true, `${serverName} should use a stable public OMX MCP target`);
      assert.equal(target?.endsWith('-server.js'), false, `${serverName} should not expose internal dist filenames in plugin metadata`);
    }
  });

  it('keeps plugin MCP metadata aligned with the setup-managed MCP roster', async () => {
    const mcpManifest = await readJson<PluginMcpManifest>(pluginMcpPath);
    const mergedConfig = buildMergedConfig('', root, { includeTui: false });
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

  it('does not stage plugin-scoped hook manifests or runtime hook directories', async () => {
    const pluginEntries = await readdir(pluginRoot);

    assert.equal(pluginEntries.includes('.codex'), false, 'official plugin should not ship setup-owned .codex hook assets');
    assert.equal(pluginEntries.includes('.omx'), false, 'official plugin should not ship runtime hook directories');
    assert.equal(pluginEntries.includes('hooks.json'), false, 'official plugin should not ship a plugin-scoped hooks manifest');
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
    assert.equal(actualSkillNames.includes('ecomode'), false, 'merged skills should not be mirrored');
    assert.equal(actualSkillNames.includes('swarm'), false, 'alias skills should not be mirrored');
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
      'plugins/oh-my-codex/skills/help/SKILL.md',
    ];

    for (const docPath of docsToCheck) {
      const content = await readFile(join(root, docPath), 'utf-8');
      assert.equal(content.includes(staleCachePath), false, `${docPath} should not hard-code stale omc cache path`);
    }

    const combinedDocs = await Promise.all(docsToCheck.map((docPath) => readFile(join(root, docPath), 'utf-8')));
    const combined = combinedDocs.join('\n');
    assert.match(combined, /plugins\/cache\/\$MARKETPLACE_NAME\/oh-my-codex\/\$VERSION\//);
    assert.match(combined, /not a replacement for `npm install -g oh-my-codex` plus `omx setup`/);
    assert.match(combined, /legacy setup mode installs native agents\/prompts|plugin setup mode archives stale legacy prompt\/native-agent files/);
    assert.match(combined, /plugin-scoped companion metadata for MCP servers and apps/i);
    assert.match(combined, /hooks stay setup-owned|hooks remain setup-owned|native \.codex\/hooks\.json coverage/i);
  });
});
