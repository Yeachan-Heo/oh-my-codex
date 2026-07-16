import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildManagedCodexHookTrustState,
  buildManagedCodexHooksConfig,
  buildManagedCodexNativeHookWindowsShimContent,
  buildManagedCodexNativeHookWindowsShimPath,
} from '../../config/codex-hooks.js';
import { uninstall } from '../uninstall.js';
import TOML from '@iarna/toml';

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {}
): { status: number | null; stdout: string; stderr: string; error: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
  const resolvedHome = envOverrides.HOME ?? process.env.HOME;
  const result = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...(resolvedHome && !envOverrides.CODEX_HOME ? { CODEX_HOME: join(resolvedHome, '.codex') } : {}),
      ...envOverrides,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || '',
  };
}

function shouldSkipForSpawnPermissions(err: string): boolean {
  return /(EPERM|EACCES)/i.test(err);
}

async function withCwd<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    return await run();
  } finally {
    process.chdir(previousCwd);
  }
}

async function withDriveQualifiedWindowsCodexHome<T>(
  wd: string,
  run: (codexHomeDir: string) => Promise<T>,
): Promise<T> {
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHomeDir = 'C:\\Users\\omx\\.codex';
  process.env.HOME = wd;
  process.env.CODEX_HOME = codexHomeDir;
  try {
    return await withCwd(wd, async () => {
      await mkdir(codexHomeDir, { recursive: true });
      return run(codexHomeDir);
    });
  } finally {
    if (typeof previousHome === 'string') process.env.HOME = previousHome;
    else delete process.env.HOME;
    if (typeof previousCodexHome === 'string') {
      process.env.CODEX_HOME = previousCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }
  }
}

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/** Build a realistic OMX config.toml for testing */
function buildOmxConfig(): string {
  return [
    '# oh-my-codex top-level settings (must be before any [table])',
    'notify = ["node", "/path/to/notify-hook.js"]',
    'model_reasoning_effort = "medium"',
    'developer_instructions = "You have oh-my-codex installed."',
    '',
    '[features]',
    'multi_agent = true',
    'child_agents_md = true',
    'hooks = true',
    'goals = true',
    '',
    '# ============================================================',
    '# oh-my-codex (OMX) Configuration',
    '# Managed by omx setup - manual edits preserved on next setup',
    '# ============================================================',
    '',
    '# OMX State Management MCP Server',
    '[mcp_servers.omx_state]',
    'command = "node"',
    'args = ["/path/to/state-server.js"]',
    'enabled = true',
    'startup_timeout_sec = 5',
    '',
    '# OMX Project Memory MCP Server',
    '[mcp_servers.omx_memory]',
    'command = "node"',
    'args = ["/path/to/memory-server.js"]',
    'enabled = true',
    'startup_timeout_sec = 5',
    '',
    '# OMX Code Intelligence MCP Server',
    '[mcp_servers.omx_code_intel]',
    'command = "node"',
    'args = ["/path/to/code-intel-server.js"]',
    'enabled = true',
    'startup_timeout_sec = 10',
    '',
    '# OMX Trace MCP Server',
    '[mcp_servers.omx_trace]',
    'command = "node"',
    'args = ["/path/to/trace-server.js"]',
    'enabled = true',
    'startup_timeout_sec = 5',
    '',
    '# OMX Wiki MCP Server',
    '[mcp_servers.omx_wiki]',
    'command = "node"',
    'args = ["/path/to/wiki-server.js"]',
    'enabled = true',
    'startup_timeout_sec = 5',
    '',
    '[agents.executor]',
    'description = "Code implementation"',
    'config_file = "/path/to/executor.toml"',
    '',
    '# OMX TUI StatusLine (Codex CLI v0.101.0+)',
    '[tui]',
    'status_line = ["model-with-reasoning", "git-branch"]',
    '',
    '# ============================================================',
    '# End oh-my-codex',
    '',
  ].join('\n');
}

/** Build a config with OMX entries mixed with user entries */

function buildConfigWithSeededModelContext(): string {
  return [
    '# oh-my-codex top-level settings (must be before any [table])',
    'notify = ["node", "/path/to/notify-hook.js"]',
    'model_reasoning_effort = "medium"',
    'developer_instructions = "You have oh-my-codex installed."',
    'model = "gpt-5.6-sol"',
    '# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)',
    'model_context_window = 250000',
    'model_auto_compact_token_limit = 200000',
    '# End oh-my-codex seeded behavioral defaults',
    '',
    '[features]',
    'multi_agent = true',
    'child_agents_md = true',
    'hooks = true',
    'goals = true',
    '',
    '# ============================================================',
    '# oh-my-codex (OMX) Configuration',
    '# Managed by omx setup - manual edits preserved on next setup',
    '# ============================================================',
    '',
    '[mcp_servers.omx_state]',
    'command = "node"',
    'args = ["/path/to/state-server.js"]',
    'enabled = true',
    '',
    '# ============================================================',
    '# End oh-my-codex',
    '',
  ].join('\n');
}

function buildConfigWithEditedSeededModelContext(): string {
  return [
    '# oh-my-codex top-level settings (must be before any [table])',
    'notify = ["node", "/path/to/notify-hook.js"]',
    'model_reasoning_effort = "medium"',
    'developer_instructions = "You have oh-my-codex installed."',
    'model = "gpt-5.6-sol"',
    '# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)',
    'model_context_window = 123456',
    'model_auto_compact_token_limit = 200000',
    '# End oh-my-codex seeded behavioral defaults',
    '',
    '[features]',
    'multi_agent = true',
    'child_agents_md = true',
    'hooks = true',
    'goals = true',
    '',
    '# ============================================================',
    '# oh-my-codex (OMX) Configuration',
    '# Managed by omx setup - manual edits preserved on next setup',
    '# ============================================================',
    '',
    '[mcp_servers.omx_state]',
    'command = "node"',
    'args = ["/path/to/state-server.js"]',
    'enabled = true',
    '',
    '# ============================================================',
    '# End oh-my-codex',
    '',
  ].join('\n');
}

function buildMixedConfig(): string {
  return [
    '# User settings',
    'model = "o4-mini"',
    '',
    '# oh-my-codex top-level settings (must be before any [table])',
    'notify = ["node", "/path/to/notify-hook.js"]',
    'model_reasoning_effort = "medium"',
    'developer_instructions = "You have oh-my-codex installed."',
    '',
    '[features]',
    'multi_agent = true',
    'child_agents_md = true',
    'hooks = true',
    'goals = true',
    'web_search = true',
    '',
    '[mcp_servers.user_custom]',
    'command = "custom"',
    'args = ["--flag"]',
    '',
    '[agents]',
    'max_threads = 17',
    'max_depth = 5',
    '',
    '[agents.custom_role]',
    'description = "keep me"',
    '',
    '# ============================================================',
    '# oh-my-codex (OMX) Configuration',
    '# Managed by omx setup - manual edits preserved on next setup',
    '# ============================================================',
    '',
    '[mcp_servers.omx_state]',
    'command = "node"',
    'args = ["/path/to/state-server.js"]',
    'enabled = true',
    '',
    '[mcp_servers.omx_memory]',
    'command = "node"',
    'args = ["/path/to/memory-server.js"]',
    'enabled = true',
    '',
    '[mcp_servers.omx_code_intel]',
    'command = "node"',
    'args = ["/path/to/code-intel-server.js"]',
    'enabled = true',
    '',
    '[mcp_servers.omx_trace]',
    'command = "node"',
    'args = ["/path/to/trace-server.js"]',
    'enabled = true',
    '',
    '[mcp_servers.omx_wiki]',
    'command = "node"',
    'args = ["/path/to/wiki-server.js"]',
    'enabled = true',
    '',
    '[agents.executor]',
    'description = "Code implementation"',
    'config_file = "/path/to/executor.toml"',
    '',
    '[tui]',
    'status_line = ["model-with-reasoning"]',
    '',
    '# ============================================================',
    '# End oh-my-codex',
    '',
  ].join('\n');
}

type MultiAgentPreservationVariant = {
  name: string;
  multiAgent: boolean;
  maxThreads: number;
  maxDepth: number;
};

function buildAmbiguousMultiAgentConfig(
  marker: string,
  variant: MultiAgentPreservationVariant,
): string {
  return [
    `sentinel = "${marker}"`,
    '',
    '[features]',
    `multi_agent = ${variant.multiAgent}`,
    'child_agents_md = true',
    'goals = true',
    'custom_feature = true',
    '',
    '[agents]',
    `max_threads = ${variant.maxThreads}`,
    `max_depth = ${variant.maxDepth}`,
    '',
    '[agents.custom_role]',
    `description = "${marker}"`,
    '',
    '# ============================================================',
    '# oh-my-codex (OMX) Configuration',
    '# Managed by omx setup - manual edits preserved on next setup',
    '# ============================================================',
    '',
    '[mcp_servers.omx_state]',
    'command = "node"',
    'args = ["/path/to/state-server.js"]',
    'enabled = true',
    '',
    '# ============================================================',
    '# End oh-my-codex',
    '',
  ].join('\n');
}

describe('omx uninstall', () => {
  it('removes OMX block from config.toml with --dry-run', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(codexDir, 'config.toml'), buildOmxConfig());
      await writeFile(
        join(codexDir, 'hooks.json'),
        JSON.stringify(buildManagedCodexHooksConfig(wd), null, 2) + '\n',
      );

      const res = runOmx(wd, ['uninstall', '--dry-run'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /dry-run mode/);
      assert.match(res.stdout, /OMX configuration block/);
      assert.match(res.stdout, /hooks\.json/);
      assert.match(res.stdout, /omx_state/);

      // Config should NOT have been modified
      const config = await readFile(join(codexDir, 'config.toml'), 'utf-8');
      assert.match(config, /oh-my-codex \(OMX\) Configuration/);
      assert.equal(existsSync(join(codexDir, 'hooks.json')), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes OMX block from config.toml', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(codexDir, 'config.toml'), buildOmxConfig());
      await writeFile(
        join(codexDir, 'hooks.json'),
        JSON.stringify(buildManagedCodexHooksConfig(wd), null, 2) + '\n',
      );

      const res = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Removed OMX configuration block/);

      const config = await readFile(join(codexDir, 'config.toml'), 'utf-8');
      assert.doesNotMatch(config, /oh-my-codex \(OMX\) Configuration/);
      assert.doesNotMatch(config, /omx_state/);
      assert.doesNotMatch(config, /omx_memory/);
      assert.doesNotMatch(config, /omx_code_intel/);
      assert.doesNotMatch(config, /omx_trace/);
      assert.doesNotMatch(config, /omx_wiki/);
      assert.doesNotMatch(config, /\[agents\.executor\]/);
      assert.doesNotMatch(config, /\[tui\]/);
      assert.doesNotMatch(config, /notify\s*=/);
      assert.doesNotMatch(config, /model_reasoning_effort\s*=/);
      assert.doesNotMatch(config, /developer_instructions\s*=/);
      assert.match(config, /multi_agent\s*=/);
      assert.doesNotMatch(config, /child_agents_md\s*=/);
      assert.doesNotMatch(config, /^hooks\s*=/m);
      assert.equal(existsSync(join(codexDir, 'hooks.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });


  it('does not restore stale OMX dispatcher metadata as notify', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-stale-notify-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      const metadataPath = join(codexDir, '.omx', 'notify-dispatch.json');
      const stalePkgRoot = join(wd, 'old-global', 'oh-my-codex');
      const staleDispatcher = join(stalePkgRoot, 'dist', 'scripts', 'notify-dispatcher.js');
      await mkdir(dirname(metadataPath), { recursive: true });
      await writeFile(
        join(codexDir, 'config.toml'),
        [
          '# User settings',
          'approval_policy = "on-failure"',
          `notify = ["node", "${staleDispatcher}", "--metadata", "${metadataPath}"]`,
          '',
          '# ============================================================',
          '# oh-my-codex (OMX) Configuration',
          '# Managed by omx setup - manual edits preserved on next setup',
          '# ============================================================',
          '[mcp_servers.omx_state]',
          'command = "node"',
          'args = ["/path/to/state-server.js"]',
          'enabled = true',
          '# ============================================================',
          '# End oh-my-codex',
          '',
        ].join('\n'),
      );
      await writeFile(
        metadataPath,
        JSON.stringify({
          managedBy: 'oh-my-codex',
          version: 1,
          previousNotify: ['node', staleDispatcher, '--metadata', metadataPath],
          omxNotify: ['node', join(stalePkgRoot, 'dist', 'scripts', 'notify-hook.js')],
          dispatcherNotify: ['node', staleDispatcher, '--metadata', metadataPath],
        }),
      );

      const res = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const config = await readFile(join(codexDir, 'config.toml'), 'utf-8');
      assert.match(config, /^approval_policy = "on-failure"$/m);
      assert.doesNotMatch(config, /^notify\s*=/m);
      assert.doesNotMatch(config, /notify-dispatcher\.js/);
      assert.doesNotMatch(config, /oh-my-codex \(OMX\) Configuration/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves user config entries when removing OMX', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(codexDir, 'config.toml'), buildMixedConfig());

      const res = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const config = await readFile(join(codexDir, 'config.toml'), 'utf-8');
      // User settings preserved
      assert.match(config, /model = "o4-mini"/);
      assert.match(config, /\[mcp_servers\.user_custom\]/);
      assert.match(config, /web_search = true/);
      assert.match(config, /^multi_agent = true$/m);
      assert.match(config, /^\[agents\]$/m);
      assert.match(config, /^max_threads = 17$/m);
      assert.match(config, /^max_depth = 5$/m);
      assert.match(config, /^\[agents\.custom_role\]$/m);
      assert.match(config, /^description = "keep me"$/m);
      // OMX entries removed
      assert.doesNotMatch(config, /omx_state/);
      assert.doesNotMatch(config, /omx_memory/);
      assert.doesNotMatch(config, /notify\s*=.*node/);
      assert.match(config, /multi_agent\s*=/);
      assert.doesNotMatch(config, /child_agents_md/);
      assert.doesNotMatch(config, /^hooks\s*=/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed for unsupported root metadata in hooks.json', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-invalid-hooks-root-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      const configPath = join(codexDir, 'config.toml');
      const hooksPath = join(codexDir, 'hooks.json');
      const config = buildOmxConfig().replace(/^hooks = true$/m, 'codex_hooks = true');
      const hooks = JSON.stringify({
        version: 1,
        hooks: {
          SessionStart: [{
            hooks: [{ type: 'command', command: 'node "/repo/dist/scripts/codex-native-hook.js"' }],
          }],
        },
      }, null, 2) + '\n';
      await mkdir(codexDir, { recursive: true });
      await writeFile(configPath, config);
      await writeFile(hooksPath, hooks);

      const res = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 1, res.stderr || res.stdout);
      assert.match(res.stderr, /unknown root field version/);
      assert.equal(await readFile(configPath, 'utf-8'), config);
      assert.equal(await readFile(hooksPath, 'utf-8'), hooks);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes safely positioned managed wrappers while preserving foreign hooks and the native feature flag', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-safe-foreign-hooks-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      const configPath = join(codexDir, 'config.toml');
      const hooksPath = join(codexDir, 'hooks.json');
      await mkdir(codexDir, { recursive: true });
      await writeFile(configPath, buildOmxConfig().replace(/^hooks = true$/m, 'codex_hooks = true'));
      await writeFile(hooksPath, JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'echo keep-me' }] },
            { matcher: 'startup|resume|clear', hooks: [{ type: 'command', command: 'node "/repo/dist/scripts/codex-native-hook.js"' }] },
          ],
        },
      }, null, 2) + '\n');

      const res = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const hooks = await readFile(hooksPath, 'utf-8');
      assert.match(hooks, /echo keep-me/);
      assert.doesNotMatch(hooks, /codex-native-hook\.js/);
      const config = await readFile(configPath, 'utf-8');
      assert.match(config, /^hooks = true$/m);
      assert.doesNotMatch(config, /^codex_hooks\s*=/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('fails closed without removing a shell-expanding foreign command that resembles an OMX hook', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-shell-expanding-hook-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      const configPath = join(codexDir, 'config.toml');
      const hooksPath = join(codexDir, 'hooks.json');
      const config = buildOmxConfig();
      const hooks = JSON.stringify({
        hooks: {
          SessionStart: [{
            matcher: 'startup|resume|clear',
            hooks: [{ type: 'command', command: 'node "$HOME/repo/dist/scripts/codex-native-hook.js"' }],
          }],
        },
      }, null, 2) + '\n';
      await mkdir(codexDir, { recursive: true });
      await writeFile(configPath, config);
      await writeFile(hooksPath, hooks);

      const res = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 1, res.stderr || res.stdout);
      assert.match(res.stderr, /ambiguous_managed_handler|does not match the managed command grammar/i);
      assert.equal(await readFile(configPath, 'utf-8'), config);
      assert.equal(await readFile(hooksPath, 'utf-8'), hooks);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed without cleaning config when managed removal would shift a foreign handler', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-unsafe-foreign-hooks-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      const configPath = join(codexDir, 'config.toml');
      const hooksPath = join(codexDir, 'hooks.json');
      const config = buildOmxConfig();
      const hooks = JSON.stringify({
        hooks: {
          SessionStart: [{
            matcher: 'startup|resume|clear',
            hooks: [
              { type: 'command', command: 'node "/repo/dist/scripts/codex-native-hook.js"' },
              { type: 'command', command: 'echo keep-me' },
            ],
          }],
        },
      }, null, 2) + '\n';
      await mkdir(codexDir, { recursive: true });
      await writeFile(configPath, config);
      await writeFile(hooksPath, hooks);

      const res = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 1, res.stderr || res.stdout);
      assert.match(res.stderr, /unsafe_managed_removal|shift a foreign coordinate/i);
      assert.equal(await readFile(configPath, 'utf-8'), config);
      assert.equal(await readFile(hooksPath, 'utf-8'), hooks);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('fails before uninstall writes when marker-wrapped trust state has foreign siblings', async () => {
    const representations = [
      {
        name: 'inline',
        render: (key: string, hash: string) => [
          `hooks = { state = { ${JSON.stringify(key)} = { trusted_hash = ${JSON.stringify(hash)}, foreign = true } } }`,
        ],
      },
      {
        name: 'dotted',
        render: (key: string, hash: string) => [
          `hooks.state.${JSON.stringify(key)}.trusted_hash = ${JSON.stringify(hash)}`,
          `hooks.state.${JSON.stringify(key)}.foreign = true`,
        ],
      },
      {
        name: 'table',
        render: (key: string, hash: string) => [
          `[hooks.state.${JSON.stringify(key)}]`,
          `trusted_hash = ${JSON.stringify(hash)}`,
          'foreign = true',
        ],
      },
      {
        name: 'separate-foreign-table',
        render: (key: string, hash: string) => [
          `[hooks.state.${JSON.stringify(key)}]`,
          `trusted_hash = ${JSON.stringify(hash)}`,
          '',
          '[hooks.state."foreign-key"]',
          'trusted_hash = "sha256:foreign"',
        ],
      },
    ] as const;
    for (const representation of representations) {
      const wd = await mkdtemp(join(tmpdir(), `omx-uninstall-trust-${representation.name}-`));
      try {
        await withCwd(wd, async () => {
          const codexDir = join(wd, '.codex');
          const configPath = join(codexDir, 'config.toml');
          const hooksPath = join(codexDir, 'hooks.json');
          const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexDir);
          const metadataPath = join(codexDir, '.omx', 'notify-dispatch.json');
          const hooks = `${JSON.stringify(buildManagedCodexHooksConfig(packageRoot(), {
            platform: 'win32',
            codexHomeDir: codexDir,
          }), null, 2)}\n`;
          const [key, trust] = Object.entries(buildManagedCodexHookTrustState(
            hooksPath,
            packageRoot(),
            {
              platform: 'win32',
              codexHomeDir: codexDir,
              hooksContent: hooks,
            },
          ))[0] ?? [];
          assert.ok(key);
          assert.ok(trust);
          const config = [
            'model = "foreign"',
            '',
            '# ============================================================',
            '# oh-my-codex (OMX) Configuration',
            '# Managed by omx setup - manual edits preserved on next setup',
            '# ============================================================',
            '',
            ...representation.render(key, trust.trusted_hash),
            '',
            '# ============================================================',
            '# End oh-my-codex',
            '',
          ].join('\n');
          const metadata = Buffer.from('{"managedBy":"foreign"}\n', 'utf-8');
          const shim = Buffer.from(
            buildManagedCodexNativeHookWindowsShimContent(packageRoot()),
            'utf-8',
          );
          await mkdir(dirname(metadataPath), { recursive: true });
          await writeFile(configPath, config);
          await writeFile(hooksPath, hooks);
          await writeFile(shimPath, shim);
          await writeFile(metadataPath, metadata);

          await assert.rejects(
            uninstall({ scope: 'project', transactionPlatform: 'win32' }),
            (error: unknown) =>
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              (error as { code?: unknown }).code === 'managed_trust_key_conflict',
          );
          assert.deepEqual(await readFile(configPath), Buffer.from(config, 'utf-8'));
          assert.deepEqual(await readFile(hooksPath), Buffer.from(hooks, 'utf-8'));
          assert.deepEqual(await readFile(shimPath), shim);
          assert.deepEqual(await readFile(metadataPath), metadata);
          assert.deepEqual(
            (await readdir(codexDir)).filter((entry) => entry.includes('.omx-')),
            [],
          );
          assert.deepEqual(
            (await readdir(wd)).filter((entry) => entry.includes('.omx-')),
            [],
          );
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });
  it('fails before uninstall writes when marker trust has absent or non-managed hooks expectations', async () => {
    const fixtures = [
      { name: 'absent', hooks: null },
      {
        name: 'non-managed',
        hooks: `${JSON.stringify({
          hooks: {
            UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo foreign' }] }],
          },
        }, null, 2)}\n`,
      },
    ] as const;
    for (const fixture of fixtures) {
      const wd = await mkdtemp(join(tmpdir(), `omx-uninstall-marker-${fixture.name}-`));
      try {
        await withCwd(wd, async () => {
          const codexDir = join(wd, '.codex');
          const configPath = join(codexDir, 'config.toml');
          const hooksPath = join(codexDir, 'hooks.json');
          const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexDir);
          const metadataPath = join(codexDir, '.omx', 'notify-dispatch.json');
          const config = buildOmxConfig().replace(
            '# End oh-my-codex',
            '[hooks.state."foreign-key"]\ntrusted_hash = "sha256:foreign"\n\n# End oh-my-codex',
          );
          const shim = Buffer.from(
            buildManagedCodexNativeHookWindowsShimContent(packageRoot()),
            'utf-8',
          );
          const metadata = Buffer.from('{"managedBy":"foreign"}\n', 'utf-8');
          await mkdir(dirname(metadataPath), { recursive: true });
          await writeFile(configPath, config);
          if (fixture.hooks !== null) await writeFile(hooksPath, fixture.hooks);
          await writeFile(shimPath, shim);
          await writeFile(metadataPath, metadata);

          await assert.rejects(
            uninstall({ scope: 'project', transactionPlatform: 'win32' }),
            (error: unknown) =>
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              (error as { code?: unknown }).code === 'managed_trust_key_conflict',
          );
          assert.deepEqual(await readFile(configPath), Buffer.from(config, 'utf-8'));
          assert.deepEqual(await readFile(shimPath), shim);
          assert.deepEqual(await readFile(metadataPath), metadata);
          if (fixture.hooks === null) {
            assert.equal(existsSync(hooksPath), false);
          } else {
            assert.deepEqual(await readFile(hooksPath), Buffer.from(fixture.hooks, 'utf-8'));
          }
          assert.deepEqual(
            (await readdir(codexDir)).filter((entry) => entry.includes('.omx-')),
            [],
          );
          assert.deepEqual(
            (await readdir(wd)).filter((entry) => entry.includes('.omx-')),
            [],
          );
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });
  it('preserves a shim referenced by a Unicode-escaped future hook event', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-future-shim-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexDir);
        const managed = buildManagedCodexHooksConfig(packageRoot(), {
          platform: 'win32',
          codexHomeDir: codexDir,
        });
        const sentinel = '__OMX_ESCAPED_SHIM_COMMAND__';
        const hooks = JSON.stringify({
          ...managed,
          hooks: {
            ...managed.hooks,
            FutureEvent: [{ hooks: [{ type: 'command', command: sentinel }] }],
          },
        }, null, 2).replace(
          JSON.stringify(sentinel),
          JSON.stringify(
            `& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File '${shimPath}'`,
          ).replace(/\\\\/g, '\\u005c'),
        ) + '\n';
        await mkdir(codexDir, { recursive: true });
        await writeFile(configPath, buildOmxConfig());
        await writeFile(hooksPath, hooks);
        await writeFile(
          shimPath,
          buildManagedCodexNativeHookWindowsShimContent(packageRoot()),
        );

        await uninstall({ scope: 'project', transactionPlatform: 'win32' });
        assert.equal(existsSync(shimPath), true);
        const finalHooks = await readFile(hooksPath, 'utf-8');
        assert.match(finalHooks, /FutureEvent/);
        assert.match(finalHooks, /\\u005c/);
        assert.doesNotMatch(finalHooks, /codex-native-hook\.js/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('preserves a drive-qualified shim referenced by a drive-less future hook event', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-drive-qualified-future-shim-'));
    try {
      await withDriveQualifiedWindowsCodexHome(wd, async (codexHomeDir) => {
        const configPath = join(codexHomeDir, 'config.toml');
        const hooksPath = join(codexHomeDir, 'hooks.json');
        const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
        const managed = buildManagedCodexHooksConfig(packageRoot(), {
          platform: 'win32',
          codexHomeDir,
        });
        const driveLessFutureShimPath = '\\Users\\omx\\.codex\\hooks\\omx-native-hook-windows-shim.ps1';
        const hooks = `${JSON.stringify({
          ...managed,
          hooks: {
            ...managed.hooks,
            FutureEvent: [{
              hooks: [{
                type: 'command',
                command: `& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File '${driveLessFutureShimPath}'`,
              }],
            }],
          },
        }, null, 2)}\n`;
        await writeFile(configPath, buildOmxConfig());
        await writeFile(hooksPath, hooks);
        await writeFile(
          shimPath,
          buildManagedCodexNativeHookWindowsShimContent(packageRoot()),
        );

        await uninstall({ scope: 'user', transactionPlatform: 'win32' });
        assert.equal(existsSync(shimPath), true);
        const finalHooks = await readFile(hooksPath, 'utf-8');
        assert.match(finalHooks, /FutureEvent/);
        assert.doesNotMatch(finalHooks, /codex-native-hook\.js/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves a shim referenced through a normalized Windows path alias', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-shim-path-alias-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexDir);
        const shimAlias = shimPath
          .replace(/[\\/]+hooks[\\/]+/i, '\\hooks\\\\.\\')
          .replace(/omx-native-hook-windows-shim\.ps1$/i, 'OMX-NATIVE-HOOK-WINDOWS-SHIM.PS1')
          .replace(/\\/g, '/');
        const managed = buildManagedCodexHooksConfig(packageRoot(), {
          platform: 'win32',
          codexHomeDir: codexDir,
        });
        const hooks = `${JSON.stringify({
          ...managed,
          hooks: {
            ...managed.hooks,
            FutureEvent: [{
              hooks: [{
                type: 'command',
                command: `& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File '${shimAlias}'`,
              }],
            }],
          },
        }, null, 2)}\n`;
        await mkdir(codexDir, { recursive: true });
        await writeFile(configPath, buildOmxConfig());
        await writeFile(hooksPath, hooks);
        await writeFile(
          shimPath,
          buildManagedCodexNativeHookWindowsShimContent(packageRoot()),
        );

        await uninstall({ scope: 'project', transactionPlatform: 'win32' });
        assert.equal(existsSync(shimPath), true);
        assert.match(await readFile(hooksPath, 'utf-8'), /FutureEvent/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('preserves a shim for a distinct absolute -File target', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-quoted-inert-shim-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexDir);
        const managed = buildManagedCodexHooksConfig(packageRoot(), {
          platform: 'win32',
          codexHomeDir: codexDir,
        });
        const hooks = `${JSON.stringify({
          ...managed,
          hooks: {
            ...managed.hooks,
            FutureEvent: [{
              hooks: [{
                type: 'command',
                command: "& 'C:\\%OMX_INERT%\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File 'D:\\tools\\unrelated-$env:INERT.ps1'",
              }],
            }],
          },
        }, null, 2)}\n`;
        await mkdir(codexDir, { recursive: true });
        await mkdir(dirname(shimPath), { recursive: true });
        await writeFile(configPath, buildOmxConfig());
        await writeFile(hooksPath, hooks);
        await writeFile(
          shimPath,
          buildManagedCodexNativeHookWindowsShimContent(packageRoot()),
        );

        await uninstall({ scope: 'project', transactionPlatform: 'win32' });
        assert.equal(existsSync(shimPath), true);
        assert.match(await readFile(hooksPath, 'utf-8'), /FutureEvent/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('treats exact and all ambiguous preserved shim references as read-only transaction preconditions', async () => {
    const fixtures = [
      { name: 'normalized-alias-deletion', reference: 'exact', mutation: 'delete' },
      { name: 'basename-ambiguity-replacement', reference: 'basename', mutation: 'replace' },
      { name: 'environment-indirection-replacement', reference: 'environment', mutation: 'replace' },
      { name: 'alternate-absolute-alias-deletion', reference: 'alternate-absolute', mutation: 'delete' },
      { name: 'rooted-short-name-deletion', reference: 'rooted-short-name', mutation: 'delete' },
      { name: 'drive-relative-short-name-deletion', reference: 'drive-relative-short-name', mutation: 'delete' },
      { name: 'distinct-basename-absolute-deletion', reference: 'distinct-basename-absolute', mutation: 'delete' },
    ] as const;
    for (const fixture of fixtures) {
      const wd = await mkdtemp(join(tmpdir(), `omx-uninstall-preserved-shim-${fixture.name}-`));
      try {
        await withCwd(wd, async () => {
          const codexDir = join(wd, '.codex');
          const configPath = join(codexDir, 'config.toml');
          const hooksPath = join(codexDir, 'hooks.json');
          const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexDir);
          const shimAlias = shimPath
            .replace(/[\\/]+hooks[\\/]+/i, '\\hooks\\\\.\\')
            .replace(/omx-native-hook-windows-shim\.ps1$/i, 'OMX-NATIVE-HOOK-WINDOWS-SHIM.PS1')
            .replace(/\\/g, '/');
          const command = fixture.reference === 'exact'
            ? `& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File '${shimAlias}'`
            : fixture.reference === 'environment'
              ? '& $env:OMX_SHIM'
              : fixture.reference === 'alternate-absolute'
                ? "& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File 'D:\\aliases\\omx-native-hook-windows-shim.ps1'"
                : fixture.reference === 'rooted-short-name'
                  ? "& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File '\\Users\\ALICE~1\\.codex\\hooks\\OMX-NA~1.PS1'"
                  : fixture.reference === 'drive-relative-short-name'
                    ? "& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File 'C:Users\\ALICE~1\\.codex\\hooks\\OMX-NA~1.PS1'"
                    : fixture.reference === 'distinct-basename-absolute'
                      ? "& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File 'D:\\aliases\\foreign-hook-alias.ps1'"
                      : 'echo omx-native-hook-windows-shim.ps1';
          const managed = buildManagedCodexHooksConfig(packageRoot(), {
            platform: 'win32',
            codexHomeDir: codexDir,
          });
          const hooks = `${JSON.stringify({
            ...managed,
            hooks: {
              ...managed.hooks,
              FutureEvent: [{ hooks: [{ type: 'command', command }] }],
            },
          }, null, 2)}\n`;
          const config = buildOmxConfig();
          const shim = Buffer.from(
            buildManagedCodexNativeHookWindowsShimContent(packageRoot()),
            'utf-8',
          );
          const replacement = Buffer.from('concurrent shim replacement\n', 'utf-8');
          await mkdir(codexDir, { recursive: true });
          await writeFile(configPath, config);
          await writeFile(hooksPath, hooks);
          await writeFile(shimPath, shim);

          await assert.rejects(
            uninstall({
              scope: 'project',
              transactionPlatform: 'win32',
              transactionFailureInjector: async (stage) => {
                if (stage !== 'before-config-commit') return;
                if (fixture.mutation === 'delete') {
                  await rm(shimPath);
                } else {
                  await writeFile(shimPath, replacement);
                }
              },
            }),
            /planned artifact .* changed, was created, or was removed after planning/,
          );
          assert.deepEqual(await readFile(configPath), Buffer.from(config, 'utf-8'));
          assert.deepEqual(await readFile(hooksPath), Buffer.from(hooks, 'utf-8'));
          if (fixture.mutation === 'delete') {
            assert.equal(existsSync(shimPath), false);
          } else {
            assert.deepEqual(await readFile(shimPath), replacement);
          }
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });
  it('rolls back hooks when a preserved environment-indirected shim drifts under --keep-config', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-keep-config-preserved-shim-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexDir);
        const managed = buildManagedCodexHooksConfig(packageRoot(), {
          platform: 'win32',
          codexHomeDir: codexDir,
        });
        const hooks = `${JSON.stringify({
          ...managed,
          hooks: {
            ...managed.hooks,
            FutureEvent: [{ hooks: [{ type: 'command', command: '& $env:OMX_SHIM' }] }],
          },
        }, null, 2)}\n`;
        const config = buildOmxConfig();
        const replacement = Buffer.from('concurrent preserved shim replacement\n', 'utf-8');
        await mkdir(codexDir, { recursive: true });
        await writeFile(configPath, config);
        await writeFile(hooksPath, hooks);
        await writeFile(
          shimPath,
          buildManagedCodexNativeHookWindowsShimContent(packageRoot()),
        );

        let injected = false;
        await assert.rejects(
          uninstall({
            scope: 'project',
            keepConfig: true,
            transactionPlatform: 'win32',
            transactionFailureInjector: async (stage) => {
              if (stage !== 'before-rename' || injected) return;
              injected = true;
              await writeFile(shimPath, replacement);
            },
          }),
          /planned artifact .* changed, was created, or was removed after planning/,
        );
        assert.equal(injected, true);
        assert.equal(await readFile(configPath, 'utf-8'), config);
        assert.equal(await readFile(hooksPath, 'utf-8'), hooks);
        assert.deepEqual(await readFile(shimPath), replacement);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('rolls back when a preserved Windows shim drifts after staged-cleanup finalization', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-preserved-shim-finalization-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexDir);
        const managed = buildManagedCodexHooksConfig(packageRoot(), {
          platform: 'win32',
          codexHomeDir: codexDir,
        });
        const hooks = `${JSON.stringify({
          ...managed,
          hooks: {
            ...managed.hooks,
            FutureEvent: [{ hooks: [{ type: 'command', command: '& $env:OMX_SHIM' }] }],
          },
        }, null, 2)}\n`;
        const config = buildOmxConfig();
        const replacement = Buffer.from('concurrent finalization shim replacement\n', 'utf-8');
        await mkdir(codexDir, { recursive: true });
        await writeFile(configPath, config);
        await writeFile(hooksPath, hooks);
        await writeFile(
          shimPath,
          buildManagedCodexNativeHookWindowsShimContent(packageRoot()),
        );

        let injected = false;
        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionPlatform: 'win32',
            transactionFailureInjector: async (stage) => {
              if (stage !== 'after-staged-cleanup' || injected) return;
              injected = true;
              await writeFile(shimPath, replacement);
            },
          }),
          /planned artifact .* changed, was created, or was removed after planning/,
        );
        assert.equal(injected, true);
        assert.equal(await readFile(configPath, 'utf-8'), config);
        assert.equal(await readFile(hooksPath, 'utf-8'), hooks);
        assert.deepEqual(await readFile(shimPath), replacement);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('rolls back hooks, historical proof-owned shim, and config when shim removal fails', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-shim-rollback-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexDir);
        const config = buildOmxConfig();
        const hooks = `${JSON.stringify(
          buildManagedCodexHooksConfig(packageRoot(), {
            platform: 'win32',
            codexHomeDir: codexDir,
          }),
          null,
          2,
        )}\n`;
        const shim = buildManagedCodexNativeHookWindowsShimContent(
          'C:\\Historical Install\\oh-my-codex',
          { nodePath: 'D:\\Historical Node\\node.exe' },
        );
        await mkdir(codexDir, { recursive: true });
        await mkdir(dirname(shimPath), { recursive: true });
        await writeFile(configPath, config);
        await writeFile(hooksPath, hooks);
        await writeFile(shimPath, shim);

        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionPlatform: 'win32',
            transactionFailureInjector: async (stage) => {
              if (stage !== 'before-shim-removal') return;
              assert.equal(existsSync(hooksPath), false, 'hooks must mutate before shim removal');
              assert.equal(await readFile(configPath, 'utf-8'), config);
              throw new Error('simulated shim removal failure');
            },
          }),
          /simulated shim removal failure/,
        );

        assert.equal(await readFile(hooksPath, 'utf-8'), hooks);
        assert.equal(await readFile(shimPath, 'utf-8'), shim);
        assert.equal(await readFile(configPath, 'utf-8'), config);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects a modified Windows shim before any uninstall artifact write', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-modified-shim-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexDir);
        const config = buildOmxConfig();
        const hooks = `${JSON.stringify(
          buildManagedCodexHooksConfig(packageRoot(), {
            platform: 'win32',
            codexHomeDir: codexDir,
          }),
          null,
          2,
        )}\n`;
        const shim = `${buildManagedCodexNativeHookWindowsShimContent(packageRoot())}\n# user edit\n`;
        await mkdir(codexDir, { recursive: true });
        await mkdir(dirname(shimPath), { recursive: true });
        await writeFile(configPath, config);
        await writeFile(hooksPath, hooks);
        await writeFile(shimPath, shim);

        await assert.rejects(
          uninstall({ scope: 'project', transactionPlatform: 'win32' }),
          /modified native hook Windows shim/,
        );

        assert.equal(await readFile(hooksPath, 'utf-8'), hooks);
        assert.equal(await readFile(shimPath, 'utf-8'), shim);
        assert.equal(await readFile(configPath, 'utf-8'), config);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rolls back hooks, shim, and config when config commit fails after hook mutation', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-config-rollback-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexDir);
        const config = buildOmxConfig();
        const hooks = `${JSON.stringify(
          buildManagedCodexHooksConfig(packageRoot(), {
            platform: 'win32',
            codexHomeDir: codexDir,
          }),
          null,
          2,
        )}\n`;
        const shim = buildManagedCodexNativeHookWindowsShimContent(packageRoot());
        await mkdir(codexDir, { recursive: true });
        await mkdir(dirname(shimPath), { recursive: true });
        await writeFile(configPath, config);
        await writeFile(hooksPath, hooks);
        await writeFile(shimPath, shim);

        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionPlatform: 'win32',
            transactionFailureInjector: async (stage) => {
              if (stage !== 'after-config-commit') return;
              assert.equal(existsSync(hooksPath), false, 'hooks must mutate before config commit');
              assert.equal(existsSync(shimPath), false, 'shim must mutate before config commit');
              assert.notEqual(await readFile(configPath, 'utf-8'), config);
              throw new Error('simulated config commit failure');
            },
          }),
          /simulated config commit failure/,
        );

        assert.equal(await readFile(hooksPath, 'utf-8'), hooks);
        assert.equal(await readFile(shimPath, 'utf-8'), shim);
        assert.equal(await readFile(configPath, 'utf-8'), config);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects invalid UTF-8 hooks.json and config.toml before changing either artifact', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-invalid-utf8-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const hooks = Buffer.from([0x7b, 0xff, 0x7d]);
        const config = Buffer.from([0x6f, 0x6d, 0x78, 0x5f, 0xff]);
        await mkdir(codexDir, { recursive: true });
        await writeFile(configPath, buildOmxConfig());
        await writeFile(hooksPath, hooks);

        await assert.rejects(uninstall({ scope: 'project' }), /not valid UTF-8/);
        assert.deepEqual(await readFile(hooksPath), hooks);

        await writeFile(hooksPath, JSON.stringify(buildManagedCodexHooksConfig(packageRoot())));
        await writeFile(configPath, config);
        await assert.rejects(uninstall({ scope: 'project' }), /not valid UTF-8/);
        assert.deepEqual(await readFile(configPath), config);

        const bomHooks = Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from('{"hooks":{}}\n', 'utf-8'),
        ]);
        await writeFile(configPath, buildOmxConfig());
        await writeFile(hooksPath, bomHooks);
        await assert.rejects(uninstall({ scope: 'project' }), /must contain a JSON object/);
        assert.deepEqual(await readFile(hooksPath), bomHooks);
        assert.equal(existsSync(hooksPath), true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects symlinked native hook artifacts without following their targets', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-symlink-hooks-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const targetPath = join(wd, 'user-hooks.json');
        const config = buildOmxConfig();
        const target = '{"user":"hooks"}\n';
        await mkdir(codexDir, { recursive: true });
        await writeFile(configPath, config);
        await writeFile(targetPath, target);
        await symlink(targetPath, hooksPath);

        await assert.rejects(uninstall({ scope: 'project' }), /expected a regular file, not a symbolic link/);
        assert.equal((await lstat(hooksPath)).isSymbolicLink(), true);
        assert.equal(await readFile(targetPath, 'utf-8'), target);
        assert.equal(await readFile(configPath, 'utf-8'), config);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('aborts before the first removal when any planned artifact becomes stale', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-stale-snapshot-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const config = buildOmxConfig();
        const hooks = `${JSON.stringify(buildManagedCodexHooksConfig(packageRoot()), null, 2)}\n`;
        const staleConfig = `${config}# concurrent user edit\n`;
        await mkdir(codexDir, { recursive: true });
        await writeFile(configPath, config);
        await writeFile(hooksPath, hooks);

        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionFailureInjector: async (stage) => {
              if (stage === 'before-hooks-commit') await writeFile(configPath, staleConfig);
            },
          }),
          /planned artifact .* changed, was created, or was removed after planning/,
        );
        assert.equal(await readFile(hooksPath, 'utf-8'), hooks);
        assert.equal(await readFile(configPath, 'utf-8'), staleConfig);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('never replaces a concurrent symlink while rolling back a failed uninstall transaction', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-stale-rollback-link-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexDir);
        const replacementPath = join(wd, 'concurrent-user-hooks.json');
        const config = buildOmxConfig();
        const hooks = `${JSON.stringify(buildManagedCodexHooksConfig(packageRoot(), {
          platform: 'win32',
          codexHomeDir: codexDir,
        }), null, 2)}\n`;
        const replacement = '{"user":"replacement"}\n';
        await mkdir(codexDir, { recursive: true });
        await mkdir(dirname(shimPath), { recursive: true });
        await writeFile(configPath, config);
        await writeFile(hooksPath, hooks);
        await writeFile(shimPath, buildManagedCodexNativeHookWindowsShimContent(packageRoot()));
        await writeFile(replacementPath, replacement);

        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionPlatform: 'win32',
            transactionFailureInjector: async (stage) => {
              if (stage !== 'before-shim-removal') return;
              await symlink(replacementPath, hooksPath);
              throw new Error('simulated concurrent hook replacement');
            },
          }),
          /Uninstall artifact rollback failed.*(?:Refusing stale rollback|expected a regular file, not a symbolic link)/,
        );
        assert.equal((await lstat(hooksPath)).isSymbolicLink(), true);
        assert.equal(await readFile(replacementPath, 'utf-8'), replacement);
        assert.equal(await readFile(configPath, 'utf-8'), config);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('rejects a symlinked controlled ancestor before reading an escaped artifact', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-ancestor-link-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const escapedDir = join(wd, 'escaped-codex');
        const configPath = join(escapedDir, 'config.toml');
        const config = buildOmxConfig();
        await mkdir(escapedDir, { recursive: true });
        await writeFile(configPath, config);
        await symlink(
          escapedDir,
          codexDir,
          process.platform === 'win32' ? 'junction' : 'dir',
        );

        await assert.rejects(
          uninstall({ scope: 'project' }),
          /controlled ancestor .* must be a non-symbolic-link directory/,
        );
        assert.equal(await readFile(configPath, 'utf-8'), config);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not truncate or follow regular and symlink replacement temporary collisions', async () => {
    for (const collisionKind of ['regular', 'symlink'] as const) {
      const wd = await mkdtemp(join(tmpdir(), `omx-uninstall-temp-${collisionKind}-`));
      try {
        await withCwd(wd, async () => {
          const codexDir = join(wd, '.codex');
          const configPath = join(codexDir, 'config.toml');
          const collisionPath = join(codexDir, '.config.toml.collision');
          const collisionTarget = join(wd, 'collision-target');
          const config = buildOmxConfig();
          const collision = 'foreign temporary collision\n';
          await mkdir(codexDir, { recursive: true });
          await writeFile(configPath, config);
          if (collisionKind === 'regular') {
            await writeFile(collisionPath, collision);
          } else {
            await writeFile(collisionTarget, collision);
            await symlink(collisionTarget, collisionPath);
          }

          await assert.rejects(
            uninstall({
              scope: 'project',
              transactionTemporaryPath: () => collisionPath,
            }),
            /EEXIST/,
          );
          assert.equal(await readFile(configPath, 'utf-8'), config);
          assert.equal(
            await readFile(collisionKind === 'regular' ? collisionPath : collisionTarget, 'utf-8'),
            collision,
          );
          if (collisionKind === 'symlink') {
            assert.equal((await lstat(collisionPath)).isSymbolicLink(), true);
          }
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('rejects stale snapshots immediately before forward rename and remove mutations', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-stale-forward-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const config = buildOmxConfig();
        const concurrentConfig = `${config}# concurrent replacement\n`;
        await mkdir(codexDir, { recursive: true });
        await writeFile(configPath, config);

        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionFailureInjector: async (stage) => {
              if (stage === 'before-rename') await writeFile(configPath, concurrentConfig);
            },
          }),
          /planned artifact .* changed, was created, or was removed after planning/,
        );
        assert.equal(await readFile(configPath, 'utf-8'), concurrentConfig);

        const hooks = `${JSON.stringify(buildManagedCodexHooksConfig(packageRoot()), null, 2)}\n`;
        const concurrentHooks = '{"foreign":"replacement"}\n';
        await writeFile(configPath, config);
        await writeFile(hooksPath, hooks);
        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionFailureInjector: async (stage) => {
              if (stage === 'before-remove') await writeFile(hooksPath, concurrentHooks);
            },
          }),
          /planned artifact .* changed, was created, or was removed after planning/,
        );
        assert.equal(await readFile(hooksPath, 'utf-8'), concurrentHooks);
        assert.equal(await readFile(configPath, 'utf-8'), config);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed for non-throwing regular and symlink write-temporary replacements', async () => {
    for (const replacementKind of ['regular', 'symlink'] as const) {
      const wd = await mkdtemp(join(tmpdir(), `omx-uninstall-write-temp-${replacementKind}-`));
      try {
        await withCwd(wd, async () => {
          const codexDir = join(wd, '.codex');
          const configPath = join(codexDir, 'config.toml');
          const hooksPath = join(codexDir, 'hooks.json');
          const temporaryPath = join(codexDir, '.config.toml.write-temporary');
          const replacementTarget = join(wd, 'foreign-write-temporary');
          const config = Buffer.from(buildOmxConfig());
          const hooks = Buffer.from('{}\n');
          const replacement = Buffer.from('foreign write temporary replacement\n');
          await mkdir(codexDir, { recursive: true });
          await writeFile(configPath, config);
          await writeFile(hooksPath, hooks);

          await assert.rejects(
            uninstall({
              scope: 'project',
              transactionTemporaryPath: (_path, purpose) =>
                purpose === 'write' ? temporaryPath : join(codexDir, '.hooks.json.staged'),
              transactionFailureInjector: async (stage) => {
                if (stage !== 'before-rename') return;
                await rm(temporaryPath, { force: true });
                if (replacementKind === 'regular') {
                  await writeFile(temporaryPath, replacement);
                } else {
                  await writeFile(replacementTarget, replacement);
                  await symlink(replacementTarget, temporaryPath);
                }
              },
            }),
            (error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              assert.match(message, /planned artifact .* changed, was created, or was removed after planning|expected a regular file, not a symbolic link/);
              assert.ok(message.includes(temporaryPath));
              assert.match(message, /preserved temporary .*manual recovery after cleanup verification failed/);
              return true;
            },
          );

          assert.deepEqual(await readFile(configPath), config);
          assert.deepEqual(await readFile(hooksPath), hooks);
          if (replacementKind === 'regular') {
            assert.deepEqual(await readFile(temporaryPath), replacement);
          } else {
            assert.equal((await lstat(temporaryPath)).isSymbolicLink(), true);
            assert.deepEqual(await readFile(replacementTarget), replacement);
          }
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('fails closed for non-throwing regular and symlink staged-tombstone replacements', async () => {
    for (const replacementKind of ['regular', 'symlink'] as const) {
      const wd = await mkdtemp(join(tmpdir(), `omx-uninstall-staged-tombstone-${replacementKind}-`));
      try {
        await withCwd(wd, async () => {
          const codexDir = join(wd, '.codex');
          const configPath = join(codexDir, 'config.toml');
          const hooksPath = join(codexDir, 'hooks.json');
          const stagedPath = join(codexDir, '.hooks.json.staged-tombstone');
          const replacementTarget = join(wd, 'foreign-staged-tombstone');
          const config = Buffer.from(buildOmxConfig());
          const hooks = Buffer.from(`${JSON.stringify(buildManagedCodexHooksConfig(packageRoot()), null, 2)}\n`);
          const replacement = Buffer.from('foreign staged tombstone replacement\n');
          await mkdir(codexDir, { recursive: true });
          await writeFile(configPath, config);
          await writeFile(hooksPath, hooks);

          await assert.rejects(
            uninstall({
              scope: 'project',
              transactionTemporaryPath: (_path, purpose) =>
                purpose === 'delete' ? stagedPath : join(codexDir, '.write-temporary'),
              transactionFailureInjector: async (stage) => {
                if (stage !== 'before-remove') return;
                await rm(stagedPath, { force: true });
                if (replacementKind === 'regular') {
                  await writeFile(stagedPath, replacement);
                } else {
                  await writeFile(replacementTarget, replacement);
                  await symlink(replacementTarget, stagedPath);
                }
              },
            }),
            (error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              assert.match(message, /planned artifact .* changed, was created, or was removed after planning|expected a regular file, not a symbolic link/);
              assert.ok(message.includes(stagedPath));
              assert.match(message, /preserved staged deletion .*manual recovery after cleanup verification failed/);
              return true;
            },
          );

          assert.deepEqual(await readFile(configPath), config);
          assert.deepEqual(await readFile(hooksPath), hooks);
          if (replacementKind === 'regular') {
            assert.deepEqual(await readFile(stagedPath), replacement);
          } else {
            assert.equal((await lstat(stagedPath)).isSymbolicLink(), true);
            assert.deepEqual(await readFile(replacementTarget), replacement);
          }
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('rejects stale snapshots immediately before rollback rename and staged-copy removal', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-stale-rollback-primitives-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const hooks = `${JSON.stringify(buildManagedCodexHooksConfig(packageRoot()), null, 2)}\n`;
        const config = buildOmxConfig();
        await mkdir(codexDir, { recursive: true });
        await writeFile(configPath, config);
        await writeFile(hooksPath, hooks);

        const concurrentHooks = '{"foreign":"rollback rename"}\n';
        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionFailureInjector: async (stage) => {
              if (stage === 'before-config-commit') throw new Error('stop after hook deletion');
              if (stage === 'before-rollback-rename') {
                await writeFile(hooksPath, concurrentHooks);
              }
            },
          }),
          /Uninstall artifact rollback failed.*Refusing uninstall because planned artifact/,
        );
        assert.equal(await readFile(hooksPath, 'utf-8'), concurrentHooks);

        await writeFile(hooksPath, hooks);
        const stagedPath = join(codexDir, '.hooks.json.rollback-stage');
        const staleStagedCopy = 'foreign staged copy\n';
        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionTemporaryPath: (_path, purpose) =>
              purpose === 'delete' ? stagedPath : join(codexDir, '.write-temporary'),
            transactionFailureInjector: async (stage) => {
              if (stage === 'before-config-commit') throw new Error('stop after hook deletion');
              if (stage === 'before-rollback-remove') {
                await writeFile(stagedPath, staleStagedCopy);
              }
            },
          }),
          /Uninstall artifact rollback failed.*staged deletion cleanup/,
        );
        assert.equal(await readFile(hooksPath, 'utf-8'), hooks);
        assert.equal(await readFile(stagedPath, 'utf-8'), staleStagedCopy);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rolls back when staged-deletion cleanup fails before any staged copy is committed', async () => {

    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-staged-deletion-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const hooks = `${JSON.stringify(buildManagedCodexHooksConfig(packageRoot()), null, 2)}\n`;
        const config = buildOmxConfig();
        const stagedPath = join(codexDir, '.hooks.json.staged');
        await mkdir(codexDir, { recursive: true });
        await writeFile(configPath, config);
        await writeFile(hooksPath, hooks);

        await uninstall({
          scope: 'project',
          transactionTemporaryPath: (_path, purpose) =>
            purpose === 'delete' ? stagedPath : join(codexDir, '.write-temporary'),
        });
        assert.equal(existsSync(hooksPath), false);
        assert.equal(existsSync(stagedPath), false, 'successful commit leaves no staged tombstone');

        await writeFile(configPath, config);
        await writeFile(hooksPath, hooks);
        let interrupted = false;
        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionTemporaryPath: (_path, purpose) =>
              purpose === 'delete' ? stagedPath : join(codexDir, '.write-temporary'),
            transactionFailureInjector: (stage) => {
              if (stage === 'before-staged-cleanup' && !interrupted) {
                interrupted = true;
                throw new Error('staged deletion cleanup interrupted');
              }
            },
          }),
          /staged deletion cleanup interrupted/,
        );
        assert.equal(interrupted, true);
        assert.equal(await readFile(hooksPath, 'utf-8'), hooks);
        assert.equal(await readFile(configPath, 'utf-8'), config);
        assert.equal(existsSync(stagedPath), false);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not roll back when preserved metadata drifts after staged-deletion cleanup finalization', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-second-staged-drift-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexDir);
        const metadataPath = join(codexDir, '.omx', 'notify-dispatch.json');
        const dispatcherPath = join(packageRoot(), 'dist', 'scripts', 'notify-dispatcher.js');
        const hooks = `${JSON.stringify(buildManagedCodexHooksConfig(packageRoot(), {
          platform: 'win32',
          codexHomeDir: codexDir,
        }), null, 2)}\n`;
        const metadata = {
          managedBy: 'oh-my-codex',
          version: 1,
          previousNotify: ['node', '/tmp/user-notify.js'],
          omxNotify: ['node', join(packageRoot(), 'dist', 'scripts', 'notify-hook.js')],
          dispatcherNotify: ['node', dispatcherPath, '--metadata', metadataPath],
        };
        const foreignMetadata = JSON.stringify({
          ...metadata,
          previousNotify: ['node', '/tmp/concurrent-notify.js'],
        });
        const config = buildOmxConfig().replace(
          /^notify = .*$/m,
          `notify = ${JSON.stringify(metadata.dispatcherNotify)}`,
        );
        const stagedDeletionPath = (path: string, purpose: 'write' | 'delete') =>
          join(dirname(path), `.${basename(path)}.cleanup-${purpose}`);
        await mkdir(dirname(metadataPath), { recursive: true });
        await mkdir(dirname(shimPath), { recursive: true });
        await writeFile(configPath, config);
        await writeFile(hooksPath, hooks);
        await writeFile(shimPath, buildManagedCodexNativeHookWindowsShimContent(packageRoot()));
        await writeFile(metadataPath, JSON.stringify(metadata));

        let injected = false;
        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionPlatform: 'win32',
            transactionTemporaryPath: stagedDeletionPath,
            transactionFailureInjector: async (stage) => {
              if (stage !== 'after-staged-cleanup' || injected) return;
              injected = true;
              await writeFile(metadataPath, foreignMetadata);
            },
          }),
          /committed but staged deletion cleanup failed/,
        );
        assert.equal(injected, true);
        assert.equal(await readFile(metadataPath, 'utf-8'), foreignMetadata);
        assert.equal(existsSync(hooksPath), false);
        assert.equal(existsSync(shimPath), false);
        assert.notEqual(await readFile(configPath, 'utf-8'), config);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('treats applied hook, shim, and config snapshots as CAS through commit finalization', async () => {
    const fixtures = [
      { name: 'later commit', stage: 'before-shim-removal', drift: 'hooks', committed: false },
      { name: 'staged cleanup', stage: 'before-staged-cleanup', drift: 'shim', committed: false },
      { name: 'finalization', stage: 'after-staged-cleanup', drift: 'config', committed: true },
    ] as const;
    for (const fixture of fixtures) {
      const wd = await mkdtemp(join(tmpdir(), `omx-uninstall-applied-${fixture.name}-`));
      try {
        await withCwd(wd, async () => {
          const codexDir = join(wd, '.codex');
          const configPath = join(codexDir, 'config.toml');
          const hooksPath = join(codexDir, 'hooks.json');
          const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexDir);
          const config = Buffer.from(buildOmxConfig(), 'utf-8');
          const hooks = Buffer.from(`${JSON.stringify(buildManagedCodexHooksConfig(packageRoot(), {
            platform: 'win32',
            codexHomeDir: codexDir,
          }), null, 2)}\n`, 'utf-8');
          const shim = Buffer.from(buildManagedCodexNativeHookWindowsShimContent(packageRoot()), 'utf-8');
          const paths = { config: configPath, hooks: hooksPath, shim: shimPath };
          const before = { config, hooks, shim };
          const foreign = Buffer.from(`foreign applied ${fixture.drift} ${fixture.name}\n`, 'utf-8');
          await mkdir(codexDir, { recursive: true });
          await mkdir(dirname(shimPath), { recursive: true });
          await writeFile(configPath, config);
          await writeFile(hooksPath, hooks);
          await writeFile(shimPath, shim);

          let injected = false;
          await assert.rejects(
            uninstall({
              scope: 'project',
              transactionPlatform: 'win32',
              transactionFailureInjector: async (stage) => {
                if (stage !== fixture.stage || injected) return;
                injected = true;
                await writeFile(paths[fixture.drift], foreign);
              },
            }),
            fixture.committed
              ? /committed but staged deletion cleanup failed during finalization/
              : /Uninstall artifact rollback failed/,
          );
          assert.equal(injected, true, fixture.name);
          if (fixture.name === 'staged cleanup') {
            assert.equal(existsSync(hooksPath), false);
            assert.deepEqual(await readFile(shimPath), foreign);
            assert.notDeepEqual(await readFile(configPath), before.config);
            return;
          }
          if (fixture.committed) {
            assert.equal(existsSync(hooksPath), false);
            assert.equal(existsSync(shimPath), false);
            assert.deepEqual(await readFile(configPath), foreign);
            return;
          }
          assert.deepEqual(
            await readFile(hooksPath),
            fixture.drift === 'hooks' ? foreign : before.hooks,
          );
          assert.deepEqual(
            await readFile(shimPath),
            before.shim,
          );
          assert.deepEqual(await readFile(configPath), before.config);
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });
  it('rolls back registered destinations when post-rename or post-remove verification fails', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-post-apply-recovery-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const config = Buffer.from(buildOmxConfig(), 'utf-8');
        const hooks = Buffer.from(`${JSON.stringify(buildManagedCodexHooksConfig(packageRoot()), null, 2)}\n`, 'utf-8');
        await mkdir(codexDir, { recursive: true });

        await writeFile(configPath, config);
        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionFailureInjector: (stage) => {
              if (stage === 'after-rename') throw new Error('post-rename verification failure');
            },
          }),
          /post-rename verification failure/,
        );
        assert.deepEqual(await readFile(configPath), config);

        await writeFile(configPath, config);
        await writeFile(hooksPath, hooks);
        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionFailureInjector: (stage) => {
              if (stage === 'after-remove') throw new Error('post-remove verification failure');
            },
          }),
          /post-remove verification failure/,
        );
        assert.deepEqual(await readFile(hooksPath), hooks);
        assert.deepEqual(await readFile(configPath), config);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('strictly validates dispatcher metadata and treats it as a stale read-only transaction precondition', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-notify-metadata-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const metadataPath = join(codexDir, '.omx', 'notify-dispatch.json');
        const dispatcherPath = join(packageRoot(), 'dist', 'scripts', 'notify-dispatcher.js');
        const config = buildOmxConfig().replace(
          /^notify = .*$/m,
          `notify = ${JSON.stringify(['node', dispatcherPath, '--metadata', metadataPath])}`,
        );
        const metadata = {
          managedBy: 'oh-my-codex',
          version: 1,
          previousNotify: ['node', '/tmp/user-notify.js'],
          omxNotify: ['node', join(packageRoot(), 'dist', 'scripts', 'notify-hook.js')],
          dispatcherNotify: ['node', dispatcherPath, '--metadata', metadataPath],
        };
        await mkdir(dirname(metadataPath), { recursive: true });
        await writeFile(configPath, config);
        await writeFile(
          metadataPath,
          JSON.stringify({ ...metadata, previousNotify: ['not-a-string', 7] }),
        );

        await assert.rejects(
          uninstall({ scope: 'project' }),
          /previousNotify must be null or an array of strings/,
        );
        assert.equal(await readFile(configPath, 'utf-8'), config);
        await writeFile(metadataPath, Buffer.from([0x7b, 0xff, 0x7d]));
        await assert.rejects(
          uninstall({ scope: 'project' }),
          /not valid UTF-8/,
        );
        assert.equal(await readFile(configPath, 'utf-8'), config);

        await writeFile(metadataPath, JSON.stringify(metadata));
        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionFailureInjector: async (stage) => {
              if (stage === 'before-config-commit') {
                await writeFile(
                  metadataPath,
                  JSON.stringify({ ...metadata, previousNotify: ['node', '/tmp/concurrent.js'] }),
                );
              }
            },
          }),
          /planned artifact .* changed, was created, or was removed after planning/,
        );
        assert.equal(await readFile(configPath, 'utf-8'), config);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not report stale rollback recovery when failure occurs before destructive removal', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-pre-destructive-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const stagedPath = join(codexDir, '.hooks.json.pre-destructive');
        const config = buildOmxConfig();
        const hooks = `${JSON.stringify(buildManagedCodexHooksConfig(packageRoot()), null, 2)}\n`;
        await mkdir(codexDir, { recursive: true });
        await writeFile(configPath, config);
        await writeFile(hooksPath, hooks);

        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionTemporaryPath: (_path, purpose) =>
              purpose === 'delete' ? stagedPath : join(codexDir, '.write-temporary'),
            transactionFailureInjector: (stage) => {
              if (stage === 'before-remove') throw new Error('pre-destructive removal failure');
            },
          }),
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            assert.match(message, /pre-destructive removal failure/);
            assert.doesNotMatch(message, /manual recovery|stale rollback/i);
            return true;
          },
        );
        assert.equal(await readFile(hooksPath, 'utf-8'), hooks);
        assert.equal(await readFile(configPath, 'utf-8'), config);
        assert.equal(existsSync(stagedPath), false);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes exact historical root trust state but preserves nonmatching nested state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-legacy-hook-state-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      const configPath = join(codexDir, 'config.toml');
      const hooksPath = join(codexDir, 'hooks.json');
      await mkdir(codexDir, { recursive: true });
      await writeFile(configPath, buildOmxConfig());
      await writeFile(hooksPath, JSON.stringify({
        state: {
          [`${hooksPath}:stop:0:0`]: { trusted_hash: 'sha256:historical' },
        },
      }, null, 2) + '\n');

      const rootStateCleanup = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(rootStateCleanup.error)) return;
      assert.equal(rootStateCleanup.status, 0, rootStateCleanup.stderr || rootStateCleanup.stdout);
      assert.deepEqual(JSON.parse(await readFile(hooksPath, 'utf-8')), {});

      const nestedState = {
        retained: { custom: true, trusted_hash: 'sha256:not-omx' },
      };
      await writeFile(hooksPath, JSON.stringify({
        hooks: {
          state: nestedState,
          SessionStart: [{
            hooks: [{ type: 'command', command: 'node "/repo/dist/scripts/codex-native-hook.js"' }],
          }],
        },
      }, null, 2) + '\n');
      const nestedStateCleanup = runOmx(wd, ['uninstall', '--keep-config'], { HOME: home });
      assert.equal(nestedStateCleanup.status, 0, nestedStateCleanup.stderr || nestedStateCleanup.stdout);
      const after = JSON.parse(await readFile(hooksPath, 'utf-8')) as {
        hooks?: { state?: unknown; SessionStart?: unknown };
      };
      assert.deepEqual(after.hooks?.state, nestedState);
      assert.equal(after.hooks?.SessionStart, undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes only trust state at the managed hook coordinates planned from hooks.json', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-hook-trust-coordinates-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      const configPath = join(codexDir, 'config.toml');
      const hooksPath = join(codexDir, 'hooks.json');
      const hooks = JSON.stringify({
        hooks: {
          SessionStart: [{
            hooks: [{ type: 'command', command: 'node "/repo/dist/scripts/codex-native-hook.js"' }],
          }],
        },
      }, null, 2) + '\n';
      const trustState = buildManagedCodexHookTrustState(hooksPath, wd, {
        hooksContent: hooks,
      });
      const [actualKey, actualTrust] = Object.entries(trustState)[0] ?? [];
      if (!actualKey || !actualTrust) {
        assert.fail('expected SessionStart managed trust state');
      }
      const staleCoordinate = `${hooksPath}:session_start:9:0`;
      const actualHeader = `[hooks.state.${JSON.stringify(actualKey)}]`;
      const staleHeader = `[hooks.state.${JSON.stringify(staleCoordinate)}]`;
      const config = [
        buildOmxConfig().trimEnd(),
        '',
        actualHeader,
        `trusted_hash = "${actualTrust.trusted_hash}"`,
        '',
        staleHeader,
        `trusted_hash = "${actualTrust.trusted_hash}"`,
        '',
      ].join('\n');
      await mkdir(codexDir, { recursive: true });
      await writeFile(configPath, config);
      await writeFile(hooksPath, hooks);

      const res = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const cleaned = await readFile(configPath, 'utf-8');
      assert.equal(cleaned.includes(actualHeader), false);
      assert.equal(cleaned.includes(staleHeader), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps empty hooks.json byte-identical during dry-run and no-op uninstall', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-empty-hooks-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      const configPath = join(codexDir, 'config.toml');
      const hooksPath = join(codexDir, 'hooks.json');
      const config = buildOmxConfig();
      const hooks = '{}\n';
      await mkdir(codexDir, { recursive: true });
      await writeFile(configPath, config);
      await writeFile(hooksPath, hooks);

      const dryRun = runOmx(wd, ['uninstall', '--dry-run'], { HOME: home });
      if (shouldSkipForSpawnPermissions(dryRun.error)) return;
      assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
      assert.equal(await readFile(configPath, 'utf-8'), config);
      assert.equal(await readFile(hooksPath, 'utf-8'), hooks);

      const uninstall = runOmx(wd, ['uninstall'], { HOME: home });
      assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
      assert.equal(await readFile(hooksPath, 'utf-8'), hooks);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed for partial hooks.json corruption before config cleanup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-corrupt-hooks-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      const configPath = join(codexDir, 'config.toml');
      const hooksPath = join(codexDir, 'hooks.json');
      const config = buildOmxConfig();
      const hooks = '{\n  "hooks": { "SessionStart": {} }\n}\n';
      await mkdir(codexDir, { recursive: true });
      await writeFile(configPath, config);
      await writeFile(hooksPath, hooks);

      const res = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 1, res.stderr || res.stdout);
      assert.match(res.stderr, /SessionStart must be an array/);
      assert.equal(await readFile(configPath, 'utf-8'), config);
      assert.equal(await readFile(hooksPath, 'utf-8'), hooks);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not preserve hooks feature flag from non-features tables', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      await mkdir(codexDir, { recursive: true });
      await writeFile(
        join(codexDir, 'config.toml'),
        `${buildOmxConfig().replace('hooks = true\n', '')}\n[user.settings]\nhooks = true\n`,
      );
      await writeFile(
        join(codexDir, 'hooks.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: 'echo keep-me' }] },
              {
                matcher: 'startup|resume|clear',
                hooks: [
                  { type: 'command', command: 'node "/repo/dist/scripts/codex-native-hook.js"' },
                ],
              },
            ],
          },
        }) + '\n',
      );

      const res = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const config = await readFile(join(codexDir, 'config.toml'), 'utf-8');
      const featuresBlock = config.match(/^\[features\]\n(?:(?!^\[).*\n?)*/m)?.[0] ?? '';
      assert.doesNotMatch(featuresBlock, /^hooks = true$/m);
      assert.doesNotMatch(featuresBlock, /^codex_hooks = true$/m);
      assert.match(config, /^\[user\.settings\]\nhooks = true$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes unchanged OMX-seeded model/context keys during uninstall', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(codexDir, 'config.toml'), buildConfigWithSeededModelContext());

      const res = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const config = await readFile(join(codexDir, 'config.toml'), 'utf-8');
      assert.match(config, /^model = "gpt-5\.6-sol"$/m);
      assert.doesNotMatch(config, /^model_context_window = 250000$/m);
      assert.doesNotMatch(config, /^model_auto_compact_token_limit = 200000$/m);
      assert.doesNotMatch(config, /seeded behavioral defaults/);
      assert.match(config, /^multi_agent = true$/m);
      assert.doesNotMatch(config, /notify\s*=/);
      assert.doesNotMatch(config, /model_reasoning_effort\s*=/);
      assert.doesNotMatch(config, /developer_instructions\s*=/);
      assert.doesNotMatch(config, /oh-my-codex \(OMX\) Configuration/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves user-edited seeded model/context keys during uninstall', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(codexDir, 'config.toml'), buildConfigWithEditedSeededModelContext());

      const res = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const config = await readFile(join(codexDir, 'config.toml'), 'utf-8');
      assert.match(config, /^model = "gpt-5\.6-sol"$/m);
      assert.match(config, /^model_context_window = 123456$/m);
      assert.match(config, /^model_auto_compact_token_limit = 200000$/m);
      assert.doesNotMatch(config, /seeded behavioral defaults/);
      assert.match(config, /^multi_agent = true$/m);
      assert.doesNotMatch(config, /notify\s*=/);
      assert.doesNotMatch(config, /model_reasoning_effort\s*=/);
      assert.doesNotMatch(config, /developer_instructions\s*=/);
      assert.doesNotMatch(config, /oh-my-codex \(OMX\) Configuration/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('--keep-config skips config.toml cleanup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(codexDir, 'config.toml'), buildOmxConfig());

      const res = runOmx(wd, ['uninstall', '--keep-config'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /--keep-config/);

      // Config should NOT have been modified
      const config = await readFile(join(codexDir, 'config.toml'), 'utf-8');
      assert.match(config, /oh-my-codex \(OMX\) Configuration/);
      assert.match(config, /omx_state/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('--purge removes .omx/ cache directory', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });
      // Create .omx/ directory with some files
      const omxDir = join(wd, '.omx');
      await mkdir(join(omxDir, 'state'), { recursive: true });
      await writeFile(join(omxDir, 'setup-scope.json'), JSON.stringify({ scope: 'user' }));
      await writeFile(join(omxDir, 'notepad.md'), '# notes');
      await writeFile(join(omxDir, 'state', 'ralph-state.json'), '{}');

      const res = runOmx(wd, ['uninstall', '--keep-config', '--purge'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /\.omx\/ cache directory/);

      assert.equal(existsSync(omxDir), false, '.omx/ directory should be removed');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  for (const scope of ['user', 'project'] as const) {
    for (const variant of [
      { name: 'legacy-looking', multiAgent: true, maxThreads: 6, maxDepth: 2 },
      { name: 'custom', multiAgent: false, maxThreads: 17, maxDepth: 5 },
    ] satisfies MultiAgentPreservationVariant[]) {
      it(`preserves ambiguous multi-agent ownership in ${scope} scope (${variant.name})`, async () => {
        const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-ownership-'));
        try {
          const home = join(wd, 'home');
          const userConfigPath = join(home, '.codex', 'config.toml');
          const projectConfigPath = join(wd, '.codex', 'config.toml');
          const setupStateDir = join(wd, '.omx');
          await mkdir(join(home, '.codex'), { recursive: true });
          await mkdir(join(wd, '.codex'), { recursive: true });
          await mkdir(setupStateDir, { recursive: true });

          const userConfig = buildAmbiguousMultiAgentConfig('user-config', variant);
          const projectConfig = buildAmbiguousMultiAgentConfig('project-config', variant);
          await writeFile(userConfigPath, userConfig);
          await writeFile(projectConfigPath, projectConfig);
          await writeFile(
            join(setupStateDir, 'setup-scope.json'),
            `${JSON.stringify({ scope })}\n`,
          );

          const selectedPath = scope === 'user' ? userConfigPath : projectConfigPath;
          const unselectedPath = scope === 'user' ? projectConfigPath : userConfigPath;
          const unselectedBefore = await readFile(unselectedPath, 'utf-8');

          const res = runOmx(wd, ['uninstall'], { HOME: home });
          if (shouldSkipForSpawnPermissions(res.error)) return;
          assert.equal(res.status, 0, res.stderr || res.stdout);
          assert.match(res.stdout, new RegExp(`Resolved scope: ${scope}`));

          const selectedAfter = await readFile(selectedPath, 'utf-8');
          const parsed = TOML.parse(selectedAfter) as {
            sentinel?: unknown;
            features?: Record<string, unknown>;
            agents?: Record<string, unknown>;
          };
          assert.equal(parsed.sentinel, `${scope}-config`);
          assert.equal(parsed.features?.multi_agent, variant.multiAgent);
          assert.equal(parsed.features?.custom_feature, true);
          assert.equal(parsed.features?.child_agents_md, undefined);
          assert.equal(parsed.features?.goals, undefined);
          assert.equal(parsed.agents?.max_threads, variant.maxThreads);
          assert.equal(parsed.agents?.max_depth, variant.maxDepth);
          assert.deepEqual(parsed.agents?.custom_role, {
            description: `${scope}-config`,
          });
          assert.doesNotMatch(selectedAfter, /mcp_servers\.omx_state/);
          assert.doesNotMatch(selectedAfter, /oh-my-codex \(OMX\) Configuration/);

          assert.equal(
            await readFile(unselectedPath, 'utf-8'),
            unselectedBefore,
            'unselected scope config must remain byte-identical',
          );
        } finally {
          await rm(wd, { recursive: true, force: true });
        }
      });
    }
  }
  it('works with project scope', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });

      // Create project-scoped setup
      const omxDir = join(wd, '.omx');
      const codexDir = join(wd, '.codex');
      await mkdir(omxDir, { recursive: true });
      await mkdir(join(codexDir, 'prompts'), { recursive: true });
      await writeFile(join(omxDir, 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await writeFile(join(codexDir, 'config.toml'), buildOmxConfig());
      // Install a prompt
      await writeFile(join(codexDir, 'prompts', 'executor.md'), '# executor');

      const res = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Resolved scope: project/);

      // Project-local config.toml should be cleaned
      const config = await readFile(join(codexDir, 'config.toml'), 'utf-8');
      assert.doesNotMatch(config, /oh-my-codex \(OMX\) Configuration/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('handles missing config.toml gracefully', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });

      const res = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Nothing to remove/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('shows summary of what was removed', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(codexDir, 'config.toml'), buildOmxConfig());

      const res = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Uninstall summary/);
      assert.match(res.stdout, /MCP servers: omx_state, omx_memory, omx_code_intel, omx_trace, omx_wiki/);
      assert.match(res.stdout, /Agent entries: 1/);
      assert.match(res.stdout, /TUI status line section/);
      assert.match(res.stdout, /Top-level keys/);
      assert.match(res.stdout, /Feature flags/);
      assert.match(res.stdout, /goal/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('warns when overlapping legacy ~/.agents/skills remains after user-scope uninstall', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      const canonicalHelp = join(codexDir, 'skills', 'help');
      const legacyHelp = join(home, '.agents', 'skills', 'help');
      await mkdir(canonicalHelp, { recursive: true });
      await mkdir(legacyHelp, { recursive: true });
      await writeFile(join(canonicalHelp, 'SKILL.md'), '# canonical help\n');
      await writeFile(join(legacyHelp, 'SKILL.md'), '# legacy help\n');

      const res = runOmx(wd, ['uninstall', '--keep-config'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(
        res.stdout,
        /Warning: 1 overlapping skill names remain between .*\.codex[\\/]+skills and .*\.agents[\\/]+skills; 1 differ in SKILL\.md content\. omx uninstall only removes the active canonical skill root; archive or remove ~\/\.agents\/skills if Codex still shows duplicates/,
      );
      assert.equal(existsSync(canonicalHelp), false, 'canonical OMX skill should be removed');
      assert.equal(existsSync(join(home, '.agents', 'skills')), true, 'legacy skill root should remain for manual cleanup');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('warns when a distinct legacy ~/.agents/skills root remains after user-scope uninstall', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      const canonicalHelp = join(codexDir, 'skills', 'help');
      const legacyDoctor = join(home, '.agents', 'skills', 'doctor');
      await mkdir(canonicalHelp, { recursive: true });
      await mkdir(legacyDoctor, { recursive: true });
      await writeFile(join(canonicalHelp, 'SKILL.md'), '# canonical help\n');
      await writeFile(join(legacyDoctor, 'SKILL.md'), '# legacy doctor\n');

      const res = runOmx(wd, ['uninstall', '--keep-config'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(
        res.stdout,
        /Warning: legacy ~\/\.agents\/skills still exists \(1 skills\)\. omx uninstall does not remove that historical root automatically; archive or remove ~\/\.agents\/skills if Codex still shows stale or duplicate skills/,
      );
      assert.equal(existsSync(canonicalHelp), false, 'canonical OMX skill should be removed');
      assert.equal(existsSync(join(home, '.agents', 'skills')), true, 'legacy skill root should remain for manual cleanup');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not warn about legacy ~/.agents/skills when none exists', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      const canonicalHelp = join(codexDir, 'skills', 'help');
      await mkdir(canonicalHelp, { recursive: true });
      await writeFile(join(canonicalHelp, 'SKILL.md'), '# canonical help\n');

      const res = runOmx(wd, ['uninstall', '--keep-config'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.doesNotMatch(res.stdout, /legacy ~\/\.agents\/skills still exists/);
      assert.doesNotMatch(res.stdout, /omx uninstall does not remove legacy ~\/\.agents\/skills/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not warn about legacy ~/.agents/skills during project-scope uninstall', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      const projectSkillsHelp = join(wd, '.codex', 'skills', 'help');
      const legacyHelp = join(home, '.agents', 'skills', 'help');
      await mkdir(projectSkillsHelp, { recursive: true });
      await mkdir(legacyHelp, { recursive: true });
      await mkdir(join(wd, '.omx'), { recursive: true });
      await writeFile(join(projectSkillsHelp, 'SKILL.md'), '# project help\n');
      await writeFile(join(legacyHelp, 'SKILL.md'), '# legacy help\n');
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));

      const res = runOmx(wd, ['uninstall', '--keep-config'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Resolved scope: project/);
      assert.doesNotMatch(res.stdout, /legacy ~\/\.agents\/skills still exists/);
      assert.doesNotMatch(res.stdout, /omx uninstall does not remove legacy ~\/\.agents\/skills/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not warn when legacy ~/.agents/skills is just a link to the canonical skills root', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-legacy-link-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      const canonicalSkillsRoot = join(codexDir, 'skills');
      const canonicalSkill = join(canonicalSkillsRoot, 'doctor');
      const legacyRoot = join(home, '.agents', 'skills');
      await mkdir(canonicalSkill, { recursive: true });
      await mkdir(join(home, '.agents'), { recursive: true });
      await writeFile(join(canonicalSkill, 'SKILL.md'), '# canonical doctor\n');
      await symlink(
        canonicalSkillsRoot,
        legacyRoot,
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      const res = runOmx(wd, ['uninstall', '--keep-config'], { HOME: home, CODEX_HOME: codexDir });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.doesNotMatch(res.stdout, /legacy ~\/\.agents\/skills/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('--dry-run --purge does not actually remove .omx/ directory', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });
      const omxDir = join(wd, '.omx');
      await mkdir(join(omxDir, 'state'), { recursive: true });
      await writeFile(join(omxDir, 'setup-scope.json'), JSON.stringify({ scope: 'user' }));
      await writeFile(join(omxDir, 'notepad.md'), '# notes');

      const res = runOmx(wd, ['uninstall', '--keep-config', '--purge', '--dry-run'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /dry-run mode/);
      assert.match(res.stdout, /\.omx\/ cache directory/);

      // .omx/ should still exist
      assert.equal(existsSync(omxDir), true, '.omx/ should NOT be removed in dry-run');
      assert.equal(existsSync(join(omxDir, 'notepad.md')), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('second uninstall run reports nothing to remove (idempotent)', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(codexDir, 'config.toml'), buildOmxConfig());

      const first = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(first.error)) return;
      assert.equal(first.status, 0, first.stderr || first.stdout);
      assert.match(first.stdout, /Removed OMX configuration block/);

      const second = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(second.error)) return;
      assert.equal(second.status, 0, second.stderr || second.stdout);
      assert.match(second.stdout, /Nothing to remove/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not delete user AGENTS.md that merely mentions oh-my-codex', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });
      const userAgentsMd = '# My Agents\n\nDo not use oh-my-codex for this project.\n';
      await writeFile(join(wd, 'AGENTS.md'), userAgentsMd);

      const res = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      // User AGENTS.md should be preserved
      assert.equal(existsSync(join(wd, 'AGENTS.md')), true);
      const content = await readFile(join(wd, 'AGENTS.md'), 'utf-8');
      assert.equal(content, userAgentsMd);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes OMX-managed AGENTS sections while preserving project guidance', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-merged-agents-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });
      await mkdir(join(wd, '.omx'), { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      const userGuidance = '# User project instructions\n\nPreserve this guidance.\n';
      await writeFile(
        join(wd, 'AGENTS.md'),
        `${userGuidance}\n<!-- OMX:AGENTS:START -->\n<!-- omx:generated:agents-md -->\n# oh-my-codex - Intelligent Multi-Agent Orchestration\n<!-- OMX:AGENTS:END -->\n`,
      );

      const res = runOmx(wd, ['uninstall', '--keep-config'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.equal(await readFile(join(wd, 'AGENTS.md'), 'utf-8'), userGuidance);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes managed user-scope AGENTS.md from CODEX_HOME', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexHome = join(home, '.codex');
      await mkdir(codexHome, { recursive: true });
      await mkdir(join(wd, '.omx'), { recursive: true });
      await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'user' }));
      await writeFile(
        join(codexHome, 'AGENTS.md'),
        '<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->\n'
          + 'YOU ARE AN AUTONOMOUS CODING AGENT. EXECUTE TASKS TO COMPLETION WITHOUT ASKING FOR PERMISSION.\n'
          + 'DO NOT STOP TO ASK "SHOULD I PROCEED?" — PROCEED. DO NOT WAIT FOR CONFIRMATION ON OBVIOUS NEXT STEPS.\n'
          + 'IF BLOCKED, TRY AN ALTERNATIVE APPROACH. ONLY ASK WHEN TRULY AMBIGUOUS OR DESTRUCTIVE.\n'
          + '<!-- END AUTONOMY DIRECTIVE -->\n'
          + '<!-- omx:generated:agents-md -->\n'
          + '# oh-my-codex - Intelligent Multi-Agent Orchestration\n',
      );

      const res = runOmx(wd, ['uninstall', '--keep-config'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.equal(existsSync(join(codexHome, 'AGENTS.md')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes setup-scope.json and hud-config.json without --purge', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      await mkdir(home, { recursive: true });
      const omxDir = join(wd, '.omx');
      await mkdir(omxDir, { recursive: true });
      await writeFile(join(omxDir, 'setup-scope.json'), JSON.stringify({ scope: 'user' }));
      await writeFile(join(omxDir, 'hud-config.json'), JSON.stringify({ preset: 'focused' }));
      await writeFile(join(omxDir, 'notepad.md'), '# keep this');

      const res = runOmx(wd, ['uninstall', '--keep-config'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      assert.equal(existsSync(join(omxDir, 'setup-scope.json')), false);
      assert.equal(existsSync(join(omxDir, 'hud-config.json')), false);
      // notepad.md should still exist (not purged)
      assert.equal(existsSync(join(omxDir, 'notepad.md')), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('removes exact marked pairs and authorized singleton blocks during uninstall', async () => {
    const cases = [
      { lines: ['# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)', 'model_context_window = 250000', 'model_auto_compact_token_limit = 200000', '# End oh-my-codex seeded behavioral defaults'], removed: ['model_context_window', 'model_auto_compact_token_limit'], preserved: {} },
      { lines: ['model_auto_compact_token_limit=777', '# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)', 'model_context_window = 250000', '# End oh-my-codex seeded behavioral defaults'], removed: ['model_context_window'], preserved: { model_auto_compact_token_limit: 777 } },
      { lines: ['model_context_window = 123456', '# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)', 'model_auto_compact_token_limit = 200000', '# End oh-my-codex seeded behavioral defaults'], removed: ['model_auto_compact_token_limit'], preserved: { model_context_window: 123456 } },
    ];
    for (const fixture of cases) {
      const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-defaults-'));
      try {
        const home = join(wd, 'home');
        const configPath = join(home, '.codex', 'config.toml');
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, `${fixture.lines.join('\n')}\n`);
        const res = runOmx(wd, ['uninstall'], { HOME: home });
        if (shouldSkipForSpawnPermissions(res.error)) return;
        assert.equal(res.status, 0, res.stderr || res.stdout);
        const config = await readFile(configPath, 'utf-8');
        const parsed = TOML.parse(config) as Record<string, unknown>;
        assert.doesNotMatch(config, /seeded behavioral defaults/);
        for (const key of fixture.removed) assert.equal(parsed[key], undefined);
        for (const [key, value] of Object.entries(fixture.preserved)) assert.equal(parsed[key], value);
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('preserves unmarked and edited values, retaining only ambiguous ownership markers', async () => {
    const cases = [
      {
        lines: ['model_context_window = 250000', 'model_auto_compact_token_limit = 200000', '[user_table]', 'label = "unmarked"'],
        preservedLines: ['model_context_window = 250000', 'model_auto_compact_token_limit = 200000', '[user_table]', 'label = "unmarked"'],
        markers: false,
      },
      {
        lines: ['# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)', 'model_context_window = 123456', 'model_auto_compact_token_limit = 200000', '# End oh-my-codex seeded behavioral defaults', '[user_table]', 'label = "edited"'],
        preservedLines: ['model_context_window = 123456', 'model_auto_compact_token_limit = 200000', '[user_table]', 'label = "edited"'],
        markers: false,
      },
      {
        lines: ['model_auto_compact_token_limit = 1', 'model_auto_compact_token_limit = 2', '# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)', 'model_context_window = 250000', '# End oh-my-codex seeded behavioral defaults', '[user_table]', 'label = "ambiguous"'],
        preservedLines: ['model_auto_compact_token_limit = 1', 'model_auto_compact_token_limit = 2', 'model_context_window = 250000', '[user_table]', 'label = "ambiguous"'],
        markers: true,
      },
      {
        lines: ['model_context_window = 999', '# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)', 'model_context_window = 250000', 'model_auto_compact_token_limit = 200000', '# End oh-my-codex seeded behavioral defaults', '[user_table]', 'label = "pair-duplicate-before"'],
        preservedLines: ['model_context_window = 999', 'model_context_window = 250000', 'model_auto_compact_token_limit = 200000', '[user_table]', 'label = "pair-duplicate-before"'],
        markers: true,
      },
      {
        lines: ['# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)', 'model_context_window = 250000', 'model_auto_compact_token_limit = 200000', '# End oh-my-codex seeded behavioral defaults', 'model_auto_compact_token_limit = 999', '[user_table]', 'label = "pair-duplicate-after"'],
        preservedLines: ['model_context_window = 250000', 'model_auto_compact_token_limit = 200000', 'model_auto_compact_token_limit = 999', '[user_table]', 'label = "pair-duplicate-after"'],
        markers: true,
      },
      {
        lines: ['# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)', 'model_context_window = 250000', '# End oh-my-codex seeded behavioral defaults', '[user_table]', 'label = "after-table"', 'model_auto_compact_token_limit = 777'],
        preservedLines: ['model_context_window = 250000', '[user_table]', 'label = "after-table"', 'model_auto_compact_token_limit = 777'],
        markers: false,
      },
    ];
    for (const fixture of cases) {
      const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-defaults-'));
      try {
        const home = join(wd, 'home');
        const configPath = join(home, '.codex', 'config.toml');
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, `${fixture.lines.join('\n')}\n`);
        const res = runOmx(wd, ['uninstall'], { HOME: home });
        if (shouldSkipForSpawnPermissions(res.error)) return;
        assert.equal(res.status, 0, res.stderr || res.stdout);
        const config = await readFile(configPath, 'utf-8');
        for (const line of fixture.preservedLines) assert.ok(config.includes(line), `missing preserved line: ${line}`);
        fixture.markers ? assert.match(config, /seeded behavioral defaults/) : assert.doesNotMatch(config, /seeded behavioral defaults/);
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('does not write during dry-run and is a fixed point after legacy-default cleanup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-defaults-'));
    try {
      const home = join(wd, 'home');
      const configPath = join(home, '.codex', 'config.toml');
      const original = ['# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)', 'model_context_window = 250000', 'model_auto_compact_token_limit = 200000', '# End oh-my-codex seeded behavioral defaults', ''].join('\n');
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, original);
      const dryRun = runOmx(wd, ['uninstall', '--dry-run'], { HOME: home });
      if (shouldSkipForSpawnPermissions(dryRun.error)) return;
      assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
      assert.equal(await readFile(configPath, 'utf-8'), original);
      const first = runOmx(wd, ['uninstall'], { HOME: home });
      assert.equal(first.status, 0, first.stderr || first.stdout);
      const cleaned = await readFile(configPath, 'utf-8');
      const second = runOmx(wd, ['uninstall'], { HOME: home });
      assert.equal(second.status, 0, second.stderr || second.stdout);
      assert.equal(await readFile(configPath, 'utf-8'), cleaned);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps singleton and bounded cleanup dry-run-safe, differential, and idempotent', async () => {
    const start = '# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)';
    const end = '# End oh-my-codex seeded behavioral defaults';
    const fixtures = [
      {
        baseline: ['model_auto_compact_token_limit = 777', '[user_table]', 'label = "context-singleton"', ''].join('\n'),
        migrated: ['model_auto_compact_token_limit = 777', start, 'model_context_window = 250000', end, '[user_table]', 'label = "context-singleton"', ''].join('\n'),
      },
      {
        baseline: ['model_context_window = [', '  123456,', ']', '[user_table]', 'label = "auto-singleton"', ''].join('\n'),
        migrated: ['model_context_window = [', '  123456,', ']', start, 'model_auto_compact_token_limit = 200000', end, '[user_table]', 'label = "auto-singleton"', ''].join('\n'),
      },
      {
        baseline: ['before = "keep"', 'model_context_window = 123456', '# interior comment', '[user_table]', 'label = "bounded"', ''].join('\n'),
        migrated: ['before = "keep"', start, 'model_context_window = 123456', '# interior comment', end, '[user_table]', 'label = "bounded"', ''].join('\n'),
      },
    ];

    for (const fixture of fixtures) {
      const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-defaults-'));
      try {
        const baselineHome = join(wd, 'baseline-home');
        const migratedHome = join(wd, 'migrated-home');
        const baselinePath = join(baselineHome, '.codex', 'config.toml');
        const migratedPath = join(migratedHome, '.codex', 'config.toml');
        await mkdir(dirname(baselinePath), { recursive: true });
        await mkdir(dirname(migratedPath), { recursive: true });
        await writeFile(baselinePath, fixture.baseline);
        await writeFile(migratedPath, fixture.migrated);

        const dryRun = runOmx(wd, ['uninstall', '--dry-run'], { HOME: migratedHome });
        if (shouldSkipForSpawnPermissions(dryRun.error)) return;
        assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
        assert.equal(await readFile(migratedPath, 'utf-8'), fixture.migrated);

        const baselineRun = runOmx(wd, ['uninstall'], { HOME: baselineHome });
        assert.equal(baselineRun.status, 0, baselineRun.stderr || baselineRun.stdout);
        const migratedRun = runOmx(wd, ['uninstall'], { HOME: migratedHome });
        assert.equal(migratedRun.status, 0, migratedRun.stderr || migratedRun.stdout);
        const cleaned = await readFile(migratedPath, 'utf-8');
        assert.equal(cleaned, await readFile(baselinePath, 'utf-8'));

        const repeated = runOmx(wd, ['uninstall'], { HOME: migratedHome });
        assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
        assert.equal(await readFile(migratedPath, 'utf-8'), cleaned);
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it('preserves existing uninstall-pipeline semantics after removing a marked pair', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-defaults-'));
    try {
      const baselineHome = join(wd, 'baseline-home');
      const migratedHome = join(wd, 'migrated-home');
      const baselinePath = join(baselineHome, '.codex', 'config.toml');
      const migratedPath = join(migratedHome, '.codex', 'config.toml');
      const baseline = buildMixedConfig();
      await mkdir(dirname(baselinePath), { recursive: true });
      await mkdir(dirname(migratedPath), { recursive: true });
      await writeFile(baselinePath, baseline);
      await writeFile(migratedPath, baseline.replace('model = "o4-mini"', ['model = "o4-mini"', '# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)', 'model_context_window = 250000', 'model_auto_compact_token_limit = 200000', '# End oh-my-codex seeded behavioral defaults'].join('\n')));
      const baselineRun = runOmx(wd, ['uninstall'], { HOME: baselineHome });
      if (shouldSkipForSpawnPermissions(baselineRun.error)) return;
      assert.equal(baselineRun.status, 0, baselineRun.stderr || baselineRun.stdout);
      const migratedRun = runOmx(wd, ['uninstall'], { HOME: migratedHome });
      assert.equal(migratedRun.status, 0, migratedRun.stderr || migratedRun.stdout);
      assert.deepEqual(TOML.parse(await readFile(migratedPath, 'utf-8')), TOML.parse(await readFile(baselinePath, 'utf-8')));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('preserves a same-byte foreign replacement made immediately after an uninstall rename', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-immediate-post-rename-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const foreignPath = join(codexDir, '.foreign-config-same-byte');
        const config = Buffer.from(buildOmxConfig(), 'utf-8');
        let replacement: Buffer | undefined;
        let replacedInode: number | undefined;
        await mkdir(codexDir, { recursive: true });
        await writeFile(configPath, config);
        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionFailureInjector: async (stage) => {
              if (stage !== 'after-rename') return;
              replacement = readFileSync(configPath);
              const ownedInode = lstatSync(configPath).ino;
              await writeFile(foreignPath, replacement);
              assert.notEqual(lstatSync(foreignPath).ino, ownedInode);
              rmSync(configPath);
              renameSync(foreignPath, configPath);
              replacedInode = lstatSync(configPath).ino;
            },
          }),
          /Uninstall artifact rollback failed.*recovery preflight/,
        );
        assert.ok(replacement);
        assert.ok(replacedInode);
        assert.deepEqual(await readFile(configPath), replacement);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('preflights every staged uninstall recovery copy before rollback', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-rollback-recovery-preflight-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexDir);
        const stagedShimPath = join(dirname(shimPath), '.shim-preflight-recovery');
        const config = Buffer.from(buildOmxConfig(), 'utf-8');
        const hooks = Buffer.from(`${JSON.stringify(buildManagedCodexHooksConfig(packageRoot(), {
          platform: 'win32',
          codexHomeDir: codexDir,
        }), null, 2)}\n`, 'utf-8');
        await mkdir(codexDir, { recursive: true });
        await mkdir(dirname(shimPath), { recursive: true });
        await writeFile(configPath, config);
        await writeFile(hooksPath, hooks);
        await writeFile(shimPath, buildManagedCodexNativeHookWindowsShimContent(packageRoot()));
        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionPlatform: 'win32',
            transactionTemporaryPath: (path, purpose) =>
              path === shimPath && purpose === 'delete'
                ? stagedShimPath
                : join(dirname(path), `.${basename(path)}.${purpose}-preflight`),
            transactionFailureInjector: async (stage) => {
              if (stage !== 'after-config-commit') return;
              await rm(stagedShimPath);
              throw new Error('injected missing staged recovery copy');
            },
          }),
          /Uninstall artifact rollback failed.*recovery preflight/,
        );
        assert.equal(existsSync(hooksPath), false);
        assert.equal(existsSync(shimPath), false);
        assert.notDeepEqual(await readFile(configPath), config);
        assert.equal(existsSync(stagedShimPath), false);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('stops later uninstall rollback restores when the first restored artifact drifts', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-rollback-restored-drift-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexDir);
        const foreignConfigPath = join(codexDir, '.foreign-restored-config');
        const config = Buffer.from(buildOmxConfig(), 'utf-8');
        const hooks = Buffer.from(`${JSON.stringify(buildManagedCodexHooksConfig(packageRoot(), {
          platform: 'win32',
          codexHomeDir: codexDir,
        }), null, 2)}\n`, 'utf-8');
        await mkdir(codexDir, { recursive: true });
        await mkdir(dirname(shimPath), { recursive: true });
        await writeFile(configPath, config);
        await writeFile(hooksPath, hooks);
        await writeFile(shimPath, buildManagedCodexNativeHookWindowsShimContent(packageRoot()));
        let rollbackRenameCount = 0;
        let drifted = false;
        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionPlatform: 'win32',
            transactionFailureInjector: async (stage) => {
              if (stage === 'after-config-commit') {
                throw new Error('injected rollback start failure');
              }
              if (stage !== 'before-rollback-rename') return;
              rollbackRenameCount += 1;
              if (rollbackRenameCount !== 2) return;
              const restoredInode = lstatSync(configPath).ino;
              await writeFile(foreignConfigPath, config);
              assert.notEqual(lstatSync(foreignConfigPath).ino, restoredInode);
              rmSync(configPath);
              renameSync(foreignConfigPath, configPath);
              drifted = lstatSync(configPath).ino !== restoredInode;
            },
          }),
          /Uninstall artifact rollback failed/,
        );
        assert.equal(rollbackRenameCount, 2);
        assert.equal(drifted, true);
        assert.deepEqual(await readFile(configPath), config);
        assert.equal(existsSync(shimPath), false);
        assert.equal(existsSync(hooksPath), false);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('preserves a foreign inode injected after final uninstall rename validation', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-final-rename-claim-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const config = Buffer.from(buildOmxConfig(), 'utf-8');
        const foreignConfig = Buffer.from('model = "foreign-final-rename"\n', 'utf-8');
        await mkdir(codexDir, { recursive: true });
        await writeFile(configPath, config);
        let foreignInode: number | undefined;
        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionFailureInjector: (stage) => {
              if (stage !== 'after-final-rename-validation') return;
              const foreignPath = join(codexDir, '.foreign-final-rename-config');
              writeFileSync(foreignPath, foreignConfig);
              foreignInode = lstatSync(foreignPath).ino;
              rmSync(configPath);
              renameSync(foreignPath, configPath);
            },
          }),
          /(?:replacement claim.*not the planned artifact|planned artifact .* changed)/,
        );
        assert.ok(foreignInode);
        assert.equal(lstatSync(configPath).ino, foreignInode);
        assert.deepEqual(await readFile(configPath), foreignConfig);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('preserves a foreign inode injected after final uninstall removal validation', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-final-remove-claim-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const config = Buffer.from(buildOmxConfig(), 'utf-8');
        const hooks = Buffer.from(`${JSON.stringify(buildManagedCodexHooksConfig(packageRoot()), null, 2)}\n`, 'utf-8');
        const foreignHooks = Buffer.from('{"hooks":{"Stop":[]}}\n', 'utf-8');
        await mkdir(codexDir, { recursive: true });
        await writeFile(configPath, config);
        await writeFile(hooksPath, hooks);
        let foreignInode: number | undefined;
        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionFailureInjector: (stage) => {
              if (stage !== 'after-final-remove-validation') return;
              const foreignPath = join(codexDir, '.foreign-final-remove-hooks');
              writeFileSync(foreignPath, foreignHooks);
              foreignInode = lstatSync(foreignPath).ino;
              rmSync(hooksPath);
              renameSync(foreignPath, hooksPath);
            },
          }),
          /removal claim.*not the planned artifact/,
        );
        assert.ok(foreignInode);
        assert.equal(lstatSync(hooksPath).ino, foreignInode);
        assert.deepEqual(await readFile(hooksPath), foreignHooks);
        assert.deepEqual(await readFile(configPath), config);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it('preserves a foreign inode injected after final uninstall rollback validation', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-final-restore-claim-'));
    try {
      await withCwd(wd, async () => {
        const codexDir = join(wd, '.codex');
        const configPath = join(codexDir, 'config.toml');
        const hooksPath = join(codexDir, 'hooks.json');
        const config = Buffer.from(buildOmxConfig(), 'utf-8');
        const hooks = Buffer.from(`${JSON.stringify(buildManagedCodexHooksConfig(packageRoot()), null, 2)}\n`, 'utf-8');
        const foreignHooks = Buffer.from('{"hooks":{"Stop":[]}}\n', 'utf-8');
        await mkdir(codexDir, { recursive: true });
        await writeFile(configPath, config);
        await writeFile(hooksPath, hooks);
        let foreignInode: number | undefined;
        await assert.rejects(
          uninstall({
            scope: 'project',
            transactionFailureInjector: (stage) => {
              if (stage === 'before-config-commit') throw new Error('injected rollback start');
              if (stage !== 'after-final-restore-validation') return;
              const foreignPath = join(codexDir, '.foreign-final-restore-hooks');
              writeFileSync(foreignPath, foreignHooks);
              foreignInode = lstatSync(foreignPath).ino;
              renameSync(foreignPath, hooksPath);
            },
          }),
          /Uninstall artifact rollback failed/,
        );
        assert.ok(foreignInode);
        assert.equal(lstatSync(hooksPath).ino, foreignInode);
        assert.deepEqual(await readFile(hooksPath), foreignHooks);
        assert.deepEqual(await readFile(configPath), config);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('stripOmxFeatureFlags', () => {
  it('removes OMX feature flags and preserves user flags', async () => {
    const { stripOmxFeatureFlags } = await import('../../config/generator.js');

    const config = [
      '[features]',
      'multi_agent = true',
      'child_agents_md = true',
      'hooks = true',
      'codex_hooks = true',
      'goals = true',
      'goal = true',
      'web_search = true',
      '',
    ].join('\n');

    const result = stripOmxFeatureFlags(config);
    assert.doesNotMatch(result, /multi_agent/);
    assert.doesNotMatch(result, /child_agents_md/);
    assert.doesNotMatch(result, /^hooks\s*=/m);
    assert.doesNotMatch(result, /^codex_hooks\s*=/m);
    assert.doesNotMatch(result, /^goals\s*=/m);
    assert.doesNotMatch(result, /^goal\s*=/m);
    assert.match(result, /web_search = true/);
    assert.match(result, /\[features\]/);
  });

  it('removes [features] section if it becomes empty', async () => {
    const { stripOmxFeatureFlags } = await import('../../config/generator.js');

    const config = [
      '[features]',
      'multi_agent = true',
      'child_agents_md = true',
      'goals = true',
      '',
    ].join('\n');

    const result = stripOmxFeatureFlags(config);
    assert.doesNotMatch(result, /\[features\]/);
    assert.doesNotMatch(result, /multi_agent/);
    assert.doesNotMatch(result, /^goals\s*=/m);
  });

  it('handles config without [features] section', async () => {
    const { stripOmxFeatureFlags } = await import('../../config/generator.js');

    const config = 'model = "o4-mini"\n';
    const result = stripOmxFeatureFlags(config);
    assert.equal(result, config);
  });

  it('preserves multi_agent when explicitly requested', async () => {
    const { stripOmxFeatureFlags } = await import('../../config/generator.js');
    const config = [
      '[features]',
      'multi_agent = false',
      'child_agents_md = true',
      'goals = true',
      'web_search = true',
      '',
    ].join('\n');

    const result = stripOmxFeatureFlags(config, { preserveMultiAgent: true });
    assert.match(result, /^multi_agent = false$/m);
    assert.doesNotMatch(result, /^child_agents_md\s*=/m);
    assert.doesNotMatch(result, /^goals\s*=/m);
    assert.match(result, /^web_search = true$/m);
  });
});
