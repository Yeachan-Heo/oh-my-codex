import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeConfig } from '../generator.js';

describe('config generator', () => {
  it('places top-level keys before [features]', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      // Top-level keys must appear before the first [table] header
      const notifyIdx = toml.indexOf('notify =');
      const reasoningIdx = toml.indexOf('model_reasoning_effort =');
      const devInstrIdx = toml.indexOf('developer_instructions =');
      const modelIdx = toml.indexOf('model = "gpt-5.4"');
      const contextIdx = toml.indexOf('model_context_window = 1000000');
      const compactIdx = toml.indexOf('model_auto_compact_token_limit = 900000');
      const featuresIdx = toml.indexOf('[features]');

      assert.ok(notifyIdx >= 0, 'notify not found');
      assert.ok(reasoningIdx >= 0, 'model_reasoning_effort not found');
      assert.ok(devInstrIdx >= 0, 'developer_instructions not found');
      assert.ok(modelIdx >= 0, 'model not found');
      assert.ok(contextIdx >= 0, 'model_context_window not found');
      assert.ok(compactIdx >= 0, 'model_auto_compact_token_limit not found');
      assert.ok(featuresIdx >= 0, '[features] not found');

      assert.ok(notifyIdx < featuresIdx, 'notify must come before [features]');
      assert.ok(reasoningIdx < featuresIdx, 'model_reasoning_effort must come before [features]');
      assert.ok(devInstrIdx < featuresIdx, 'developer_instructions must come before [features]');
      assert.ok(modelIdx < featuresIdx, 'model must come before [features]');
      assert.ok(contextIdx < featuresIdx, 'model_context_window must come before [features]');
      assert.ok(compactIdx < featuresIdx, 'model_auto_compact_token_limit must come before [features]');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('writes notify as a TOML array', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      assert.match(toml, /^notify = \["node", ".*notify-hook\.js"\]$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('seeds gpt-5.4 model and context defaults for fresh configs', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      assert.match(toml, /^model = "gpt-5\.4"$/m);
      assert.match(toml, /^model_context_window = 1000000$/m);
      assert.match(toml, /^model_auto_compact_token_limit = 900000$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('seeds default model and context settings on fresh config', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      assert.match(toml, /^model = "gpt-5\.4"$/m);
      assert.match(toml, /^model_context_window = 1000000$/m);
      assert.match(toml, /^model_auto_compact_token_limit = 900000$/m);

      const modelIdx = toml.indexOf('model = "gpt-5.4"');
      const featuresIdx = toml.indexOf('[features]');
      assert.ok(modelIdx >= 0 && modelIdx < featuresIdx, 'seeded model must come before [features]');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('writes model_reasoning_effort and strengthened developer_instructions', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      assert.match(toml, /^model_reasoning_effort = "high"$/m);
      assert.match(toml, /^developer_instructions = "You have oh-my-codex installed/m);
      assert.match(toml, /AGENTS\.md is your orchestration brain and the main orchestration surface/);
      assert.match(toml, /Use skill\/keyword routing like \$name plus spawned role-specialized subagents for specialized work/);
      assert.match(toml, /Codex native subagents are available via \.codex\/agents/);
      assert.match(toml, /Treat installed prompts as narrower internal execution surfaces under AGENTS\.md authority/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('handles paths with spaces in notify array', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omx config gen space-'));
    const wd = join(base, 'pkg root');
    try {
      await mkdir(wd, { recursive: true });
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      const m = toml.match(/^notify = \["node", "(.*)"\]$/m);
      assert.ok(m, 'notify array not found');
      assert.match(m[1], /pkg root/);
      assert.match(m[1], /notify-hook\.js$/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('re-runs setup replacing OMX config cleanly', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);

      // Simulate user adding content
      let toml = await readFile(configPath, 'utf-8');
      toml += '\n# user tail\n[user.settings]\nname = "kept"\n';
      await writeFile(configPath, toml);

      // Re-run setup
      await mergeConfig(configPath, wd);
      const rerun = await readFile(configPath, 'utf-8');

      // OMX block appears exactly once
      assert.equal(
        (rerun.match(/# oh-my-codex \(OMX\) Configuration/g) ?? []).length,
        1
      );
      assert.equal((rerun.match(/# End oh-my-codex/g) ?? []).length, 1);

      // Features correct
      assert.equal((rerun.match(/^\[features\]$/gm) ?? []).length, 1);
      assert.match(rerun, /^multi_agent = true$/m);
      assert.match(rerun, /^child_agents_md = true$/m);

      // User content preserved
      assert.match(rerun, /^\[user.settings\]$/m);
      assert.match(rerun, /^name = "kept"$/m);

      // Top-level keys present and before [features]
      assert.match(rerun, /^notify = \["node", ".*notify-hook\.js"\]$/m);
      assert.match(rerun, /^model_reasoning_effort = "high"$/m);
      const notifyIdx = rerun.indexOf('notify =');
      const featuresIdx = rerun.indexOf('[features]');
      assert.ok(notifyIdx < featuresIdx, 'notify must come before [features]');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not seed 1M context keys for non-gpt-5.4 models', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      await writeFile(configPath, 'model = \"o3\"\n');

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      assert.match(toml, /^model = "o3"$/m);
      assert.doesNotMatch(toml, /^model_context_window = 1000000$/m);
      assert.doesNotMatch(toml, /^model_auto_compact_token_limit = 900000$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves existing user top-level config', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      const existing = [
        'model = "o3"',
        'approval_policy = "on-failure"',
        '',
        '[features]',
        'web_search = true',
        '',
      ].join('\n');
      await writeFile(configPath, existing);

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      // User's existing top-level keys preserved
      assert.match(toml, /^model = "o3"$/m);
      assert.match(toml, /^approval_policy = "on-failure"$/m);

      // OMX keys added
      assert.match(toml, /^notify = \[/m);
      assert.match(toml, /^model_reasoning_effort = "high"$/m);

      // User's feature flag preserved
      assert.match(toml, /^web_search = true$/m);

      // OMX feature flags added
      assert.match(toml, /^multi_agent = true$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('writes a global [agents] section with OMX defaults', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      assert.match(toml, /^\[agents\]$/m);
      assert.match(toml, /^max_threads = 6$/m);
      assert.match(toml, /^max_depth = 2$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes deprecated collab flag from [features]', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      const existing = [
        '[features]',
        'collab = true',
        'web_search = true',
        '',
        '[user.settings]',
        'name = "kept"',
        '',
      ].join('\n');
      await writeFile(configPath, existing);

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      // collab must be gone
      assert.ok(!/^\s*collab\s*=/m.test(toml), 'deprecated collab key should be removed');

      // multi_agent replaces it
      assert.match(toml, /^multi_agent = true$/m);

      // other user flags preserved
      assert.match(toml, /^web_search = true$/m);
      assert.match(toml, /^name = "kept"$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('migrates a legacy OMX block and preserves user settings', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      const legacy = [
        '[user.before]',
        'name = "kept-before"',
        '',
        '# oh-my-codex (OMX) Configuration',
        '# legacy block without top divider',
        'notify = ["node", "/tmp/legacy notify-hook.js"]',
        '[mcp_servers.omx_state]',
        'command = "node"',
        'args = ["/tmp/state-server.js"]',
        '# End oh-my-codex',
        '',
        '[user.after]',
        'name = "kept-after"',
        '',
      ].join('\n');
      await writeFile(configPath, legacy);

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      assert.equal(
        (toml.match(/oh-my-codex \(OMX\) Configuration/g) ?? []).length,
        1
      );
      assert.match(toml, /^\[user.before\]$/m);
      assert.match(toml, /^name = "kept-before"$/m);
      assert.match(toml, /^\[user.after\]$/m);
      assert.match(toml, /^name = "kept-after"$/m);
      assert.match(toml, /^notify = \["node", ".*notify-hook\.js"\]$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('merges into existing [features] table without duplicating it', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      const original = [
        '[features]',
        'custom_user_flag = false',
        'child_agents_md = false',
        '',
        '[user.settings]',
        'name = "kept"',
        '',
      ].join('\n');
      await writeFile(configPath, original);

      await mergeConfig(configPath, wd);
      const merged = await readFile(configPath, 'utf-8');

      assert.equal((merged.match(/^\[features\]$/gm) ?? []).length, 1);
      assert.match(merged, /^custom_user_flag = false$/m);
      assert.match(merged, /^multi_agent = true$/m);
      assert.match(merged, /^child_agents_md = true$/m);
      assert.match(merged, /^\[user.settings\]$/m);
      assert.match(merged, /^name = "kept"$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('escapes Windows-style backslashes for MCP server args', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      const windowsPkgRoot = 'C:\\Users\\alice\\oh-my-codex';
      await mergeConfig(configPath, windowsPkgRoot);
      const toml = await readFile(configPath, 'utf-8');

      assert.match(
        toml,
        /args = \["C:\\\\Users\\\\alice\\\\oh-my-codex\/dist\/mcp\/state-server\.js"\]/,
      );
      assert.match(
        toml,
        /args = \["C:\\\\Users\\\\alice\\\\oh-my-codex\/dist\/mcp\/memory-server\.js"\]/,
      );
      assert.match(
        toml,
        /args = \["C:\\\\Users\\\\alice\\\\oh-my-codex\/dist\/mcp\/code-intel-server\.js"\]/,
      );
      assert.match(
        toml,
        /args = \["C:\\\\Users\\\\alice\\\\oh-my-codex\/dist\/mcp\/trace-server\.js"\]/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
