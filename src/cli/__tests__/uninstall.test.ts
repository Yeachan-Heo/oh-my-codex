import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildManagedCodexHooksConfig } from '../../config/codex-hooks.js';

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
  return typeof err === 'string' && /(EPERM|EACCES)/i.test(err);
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
    'codex_hooks = true',
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
    'model = "gpt-5.5"',
    '# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)',
    'model_context_window = 250000',
    'model_auto_compact_token_limit = 200000',
    '# End oh-my-codex seeded behavioral defaults',
    '',
    '[features]',
    'multi_agent = true',
    'child_agents_md = true',
    'codex_hooks = true',
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
    'model = "gpt-5.5"',
    '# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)',
    'model_context_window = 123456',
    'model_auto_compact_token_limit = 200000',
    '# End oh-my-codex seeded behavioral defaults',
    '',
    '[features]',
    'multi_agent = true',
    'child_agents_md = true',
    'codex_hooks = true',
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
    'codex_hooks = true',
    'web_search = true',
    '',
    '[mcp_servers.user_custom]',
    'command = "custom"',
    'args = ["--flag"]',
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
      assert.doesNotMatch(config, /multi_agent\s*=/);
      assert.doesNotMatch(config, /child_agents_md\s*=/);
      assert.doesNotMatch(config, /codex_hooks\s*=/);
      assert.equal(existsSync(join(codexDir, 'hooks.json')), false);
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
      // OMX entries removed
      assert.doesNotMatch(config, /omx_state/);
      assert.doesNotMatch(config, /omx_memory/);
      assert.doesNotMatch(config, /notify\s*=.*node/);
      assert.doesNotMatch(config, /multi_agent/);
      assert.doesNotMatch(config, /child_agents_md/);
      assert.doesNotMatch(config, /codex_hooks/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves user hooks while removing OMX-managed wrappers', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-uninstall-'));
    try {
      const home = join(wd, 'home');
      const codexDir = join(home, '.codex');
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(codexDir, 'config.toml'), buildOmxConfig());
      await writeFile(
        join(codexDir, 'hooks.json'),
        JSON.stringify(
          {
            hooks: {
              SessionStart: [
                {
                  hooks: [
                    { type: 'command', command: 'node "/repo/dist/scripts/codex-native-hook.js"' },
                    { type: 'command', command: 'echo keep-me' },
                  ],
                },
              ],
            },
            version: 1,
          },
          null,
          2,
        ) + '\n',
      );

      const res = runOmx(wd, ['uninstall'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.equal(existsSync(join(codexDir, 'hooks.json')), true);

      const hooks = await readFile(join(codexDir, 'hooks.json'), 'utf-8');
      assert.match(hooks, /echo keep-me/);
      assert.match(hooks, /"version": 1/);
      assert.doesNotMatch(hooks, /codex-native-hook\.js/);
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
      assert.match(config, /^model = "gpt-5\.5"$/m);
      assert.doesNotMatch(config, /^model_context_window = 250000$/m);
      assert.doesNotMatch(config, /^model_auto_compact_token_limit = 200000$/m);
      assert.doesNotMatch(config, /seeded behavioral defaults/);
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
      assert.match(config, /^model = "gpt-5\.5"$/m);
      assert.match(config, /^model_context_window = 123456$/m);
      assert.match(config, /^model_auto_compact_token_limit = 200000$/m);
      assert.doesNotMatch(config, /seeded behavioral defaults/);
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
});

describe('stripOmxFeatureFlags', () => {
  it('removes OMX feature flags and preserves user flags', async () => {
    const { stripOmxFeatureFlags } = await import('../../config/generator.js');

    const config = [
      '[features]',
      'multi_agent = true',
      'child_agents_md = true',
      'web_search = true',
      '',
    ].join('\n');

    const result = stripOmxFeatureFlags(config);
    assert.doesNotMatch(result, /multi_agent/);
    assert.doesNotMatch(result, /child_agents_md/);
    assert.match(result, /web_search = true/);
    assert.match(result, /\[features\]/);
  });

  it('removes [features] section if it becomes empty', async () => {
    const { stripOmxFeatureFlags } = await import('../../config/generator.js');

    const config = [
      '[features]',
      'multi_agent = true',
      'child_agents_md = true',
      '',
    ].join('\n');

    const result = stripOmxFeatureFlags(config);
    assert.doesNotMatch(result, /\[features\]/);
    assert.doesNotMatch(result, /multi_agent/);
  });

  it('handles config without [features] section', async () => {
    const { stripOmxFeatureFlags } = await import('../../config/generator.js');

    const config = 'model = "o4-mini"\n';
    const result = stripOmxFeatureFlags(config);
    assert.equal(result, config);
  });
});
