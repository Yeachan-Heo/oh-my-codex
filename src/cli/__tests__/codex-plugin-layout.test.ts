import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { buildMergedConfig } from '../../config/generator.js';

type PackageJson = {
  version: string;
};

type CatalogManifest = {
  skills?: Array<{ name?: string; status?: string }>;
};

type PluginManifest = {
  name?: string;
  version?: string;
  skills?: string;
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
const setupOnlyInstallableSkills = new Set(['wiki']);

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

    assert.equal('hooks' in (await readJson<Record<string, unknown>>(pluginManifestPath)), false);
    assert.deepEqual(appsManifest, { apps: {} });

    assert.deepEqual(
      Object.keys(mcpManifest.mcpServers ?? {}).sort(),
      ['omx_code_intel', 'omx_memory', 'omx_state', 'omx_trace', 'omx_wiki'],
    );
    assert.deepEqual(mcpManifest.mcpServers?.omx_state, {
      command: 'node',
      args: ['../../dist/mcp/state-server.js'],
      enabled: true,
    });
    assert.deepEqual(mcpManifest.mcpServers?.omx_memory, {
      command: 'node',
      args: ['../../dist/mcp/memory-server.js'],
      enabled: true,
    });
    assert.deepEqual(mcpManifest.mcpServers?.omx_code_intel, {
      command: 'node',
      args: ['../../dist/mcp/code-intel-server.js'],
      enabled: true,
    });
    assert.deepEqual(mcpManifest.mcpServers?.omx_trace, {
      command: 'node',
      args: ['../../dist/mcp/trace-server.js'],
      enabled: true,
    });
    assert.deepEqual(mcpManifest.mcpServers?.omx_wiki, {
      command: 'node',
      args: ['../../dist/mcp/wiki-server.js'],
      enabled: true,
    });

    for (const [serverName, server] of Object.entries(mcpManifest.mcpServers ?? {})) {
      assert.equal(server.command, 'node', `${serverName} should run via node`);
      assert.equal(server.enabled, true, `${serverName} should be enabled`);
      assert.equal(server.args?.length, 1, `${serverName} should have a single entrypoint arg`);
      const entrypoint = server.args?.[0];
      assert.ok(entrypoint, `${serverName} should declare an entrypoint`);
      assert.equal(entrypoint?.startsWith('../../dist/mcp/'), true, `${serverName} should point back to packaged dist/mcp assets`);
      const resolvedEntrypoint = resolve(pluginRoot, entrypoint ?? '');
      const entrypointStat = await stat(resolvedEntrypoint);
      assert.equal(entrypointStat.isFile(), true, `${serverName} entrypoint should exist at ${resolvedEntrypoint}`);
    }
  });

  it('keeps plugin MCP metadata aligned with the setup-managed MCP roster', async () => {
    const mcpManifest = await readJson<PluginMcpManifest>(pluginMcpPath);
    const mergedConfig = buildMergedConfig('', root, { includeTui: false });
    const setupManagedServers = [...mergedConfig.matchAll(/^\[mcp_servers\.(omx_[^\]]+)\]$/gm)]
      .map((match) => match[1])
      .sort();

    assert.deepEqual(setupManagedServers, Object.keys(mcpManifest.mcpServers ?? {}).sort());

    for (const [serverName, server] of Object.entries(mcpManifest.mcpServers ?? {})) {
      const entrypoint = basename(server.args?.[0] ?? '');
      assert.ok(entrypoint, `${serverName} should expose an entrypoint basename`);
      assert.match(
        mergedConfig,
        new RegExp(`\\[mcp_servers\\.${escapeRegex(serverName)}\\][\\s\\S]*?${escapeRegex(entrypoint)}`),
        `${serverName} should stay aligned with the setup-managed MCP entrypoint`,
      );
    }
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
    const expectedSkillNames = [...new Set([
      ...(manifest.skills ?? [])
        .filter((skill) => skill.name && (skill.status === 'active' || skill.status === 'internal'))
        .map((skill) => skill.name as string),
      ...setupOnlyInstallableSkills,
    ])].sort();

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
    assert.match(combined, /omx setup` remains responsible for native agents, prompts\/config\/hooks\/AGENTS\.md\/HUD\/runtime wiring/);
    assert.match(combined, /plugin-scoped companion metadata for MCP servers and apps/i);
    assert.match(combined, /hooks stay setup-owned|hooks remain setup-owned|native \.codex\/hooks\.json coverage/i);
  });
});
