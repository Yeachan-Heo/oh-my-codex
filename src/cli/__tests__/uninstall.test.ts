import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {}
): { status: number | null; stdout: string; stderr: string; error: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'bin', 'omx.js');
  const result = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...envOverrides },
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
    'model_reasoning_effort = "high"',
    'developer_instructions = "You have oh-my-codex installed."',
    '',
    '[features]',
    'multi_agent = true',
    'child_agents_md = true',
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
function buildMixedConfig(): string {
  return [
    '# User settings',
    'model = "o4-mini"',
    '',
    '# oh-my-codex top-level settings (must be before any [table])',
    'notify = ["node", "/path/to/notify-hook.js"]',
    'model_reasoning_effort = "high"',
    'developer_instructions = "You have oh-my-codex installed."',
    '',
    '[features]',
    'multi_agent = true',
    'child_agents_md = true',
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

      const res = runOmx(wd, ['uninstall', '--dry-run'], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /dry-run mode/);
      assert.match(res.stdout, /OMX configuration block/);
      assert.match(res.stdout, /omx_state/);

      // Config should NOT have been modified
      const config = await readFile(join(codexDir, 'config.toml'), 'utf-8');
      assert.match(config, /oh-my-codex \(OMX\) Configuration/);
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
      assert.doesNotMatch(config, /\[agents\.executor\]/);
      assert.doesNotMatch(config, /\[tui\]/);
      assert.doesNotMatch(config, /notify\s*=/);
      assert.doesNotMatch(config, /model_reasoning_effort\s*=/);
      assert.doesNotMatch(config, /developer_instructions\s*=/);
      assert.doesNotMatch(config, /multi_agent\s*=/);
      assert.doesNotMatch(config, /child_agents_md\s*=/);
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
      assert.match(res.stdout, /MCP servers: omx_state, omx_memory, omx_code_intel, omx_trace/);
      assert.match(res.stdout, /Agent entries: 1/);
      assert.match(res.stdout, /TUI status line section/);
      assert.match(res.stdout, /Top-level keys/);
      assert.match(res.stdout, /Feature flags/);
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
