import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMergedConfig, mergeConfig, OMX_DEVELOPER_INSTRUCTIONS, upsertPluginModeRuntimeFeatureFlags } from '../generator.js';

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
      const modelIdx = toml.indexOf('model = "gpt-5.6-sol"');
      const featuresIdx = toml.indexOf('[features]');

      assert.ok(notifyIdx >= 0, 'notify not found');
      assert.ok(reasoningIdx >= 0, 'model_reasoning_effort not found');
      assert.ok(devInstrIdx >= 0, 'developer_instructions not found');
      assert.ok(modelIdx >= 0, 'model not found');
      assert.ok(featuresIdx >= 0, '[features] not found');

      assert.ok(notifyIdx < featuresIdx, 'notify must come before [features]');
      assert.ok(reasoningIdx < featuresIdx, 'model_reasoning_effort must come before [features]');
      assert.ok(devInstrIdx < featuresIdx, 'developer_instructions must come before [features]');
      assert.ok(modelIdx < featuresIdx, 'model must come before [features]');
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
      assert.match(toml, /^hooks = true$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not seed context defaults for fresh configs', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      assert.match(toml, /^model = "gpt-5\.6-sol"$/m);
      assert.doesNotMatch(toml, /seeded behavioral defaults/);
      assert.doesNotMatch(toml, /^model_context_window\s*=/m);
      assert.doesNotMatch(toml, /^model_auto_compact_token_limit\s*=/m);

      await mergeConfig(configPath, wd);
      const repeated = await readFile(configPath, 'utf-8');
      assert.equal(repeated, toml);
      assert.doesNotMatch(repeated, /seeded behavioral defaults/);
      assert.doesNotMatch(repeated, /^model_context_window\s*=/m);
      assert.doesNotMatch(repeated, /^model_auto_compact_token_limit\s*=/m);
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

      assert.match(toml, /^model_reasoning_effort = "medium"$/m);
      assert.match(toml, /^developer_instructions = "You have oh-my-codex installed/m);
      assert.match(toml, /AGENTS\.md is the orchestration brain and main control surface/);
      assert.match(toml, /Follow AGENTS\.md for skill\/keyword routing, \$name workflow invocation, and role-specialized subagents/);
      assert.match(toml, /Native subagents live in \.codex\/agents/);
      assert.match(toml, /when the native surface exposes `agent_type` role routing, set `agent_type` to an installed role and never omit it for OMX work/i);
      assert.match(toml, /role_routing_unavailable/i);
      assert.match(toml, /do not fabricate `agent_type`/i);
      assert.match(toml, /OMX adapted role-pass protocol/i);
      assert.match(toml, /pre-validated role intent in the OMX subagent ledger/i);
      assert.match(toml, /never fake the role via a prompt label/i);
      assert.match(toml, /Treat installed prompts as narrower execution surfaces under AGENTS\.md authority/);
      assert.match(toml, new RegExp(`^developer_instructions = "${OMX_DEVELOPER_INSTRUCTIONS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm'));
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
      assert.equal((rerun.match(/^# End oh-my-codex$/gm) ?? []).length, 1);

      // Features correct
      assert.equal((rerun.match(/^\[features\]$/gm) ?? []).length, 1);
      assert.doesNotMatch(rerun, /^multi_agent\s*=/m);
      assert.match(rerun, /^child_agents_md = true$/m);

      // User content preserved
      assert.match(rerun, /^\[user.settings\]$/m);
      assert.match(rerun, /^name = "kept"$/m);

      // Top-level keys present and before [features]
      assert.match(rerun, /^notify = \["node", ".*notify-hook\.js"\]$/m);
      assert.match(rerun, /^hooks = true$/m);
      assert.match(rerun, /^model_reasoning_effort = "medium"$/m);
      const notifyIdx = rerun.indexOf('notify =');
      const featuresIdx = rerun.indexOf('[features]');
      assert.ok(notifyIdx < featuresIdx, 'notify must come before [features]');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not add a missing context partner to explicit settings', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      await writeFile(
        configPath,
        ['model = "gpt-5.6-sol"', 'model_context_window = 640000', ''].join('\n'),
      );

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      assert.match(toml, /^model = "gpt-5\.6-sol"$/m);
      assert.match(toml, /^model_context_window = 640000$/m);
      assert.doesNotMatch(toml, /^model_auto_compact_token_limit\s*=/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not add context keys for non-gpt-5.6-sol models', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      await writeFile(configPath, 'model = \"o3\"\n');

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      assert.match(toml, /^model = "o3"$/m);
      assert.doesNotMatch(toml, /^model_context_window = 250000$/m);
      assert.doesNotMatch(toml, /^model_auto_compact_token_limit = 200000$/m);
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
      assert.match(toml, /^model_reasoning_effort = "medium"$/m);

      // User's feature flag preserved
      assert.match(toml, /^web_search = true$/m);

      // OMX feature flags added without legacy multi-agent configuration
      assert.doesNotMatch(toml, /^multi_agent\s*=/m);
      assert.match(toml, /^goals = true$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not write retired global [agents] defaults', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      assert.doesNotMatch(toml, /^\[agents\]$/m);
      assert.doesNotMatch(toml, /^max_threads\s*=/m);
      assert.doesNotMatch(toml, /^max_depth\s*=/m);
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

      // The retired flag is removed without introducing multi_agent.
      assert.doesNotMatch(toml, /^multi_agent\s*=/m);

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
        'goal = true',
        'goals = false',
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
      assert.doesNotMatch(merged, /^multi_agent\s*=/m);
      assert.match(merged, /^child_agents_md = true$/m);
      assert.match(merged, /^hooks = true$/m);
      assert.match(merged, /^goals = true$/m);
      assert.doesNotMatch(merged, /^goal\s*=/m);
      assert.match(merged, /^\[user.settings\]$/m);
      assert.match(merged, /^name = "kept"$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('migrates legacy codex_hooks flag to hooks without duplicating hook flags', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      const original = [
        '[features]',
        'custom_user_flag = false',
        'codex_hooks = true',
        '',
      ].join('\n');
      await writeFile(configPath, original);

      await mergeConfig(configPath, wd);
      const merged = await readFile(configPath, 'utf-8');

      assert.equal((merged.match(/^hooks = true$/gm) ?? []).length, 1);
      assert.doesNotMatch(merged, /^codex_hooks\s*=/m);
      assert.match(merged, /^custom_user_flag = false$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves existing hooks flag without adding legacy codex_hooks', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      const original = [
        '[features]',
        'hooks = true',
        'custom_user_flag = false',
        '',
      ].join('\n');
      await writeFile(configPath, original);

      await mergeConfig(configPath, wd);
      const merged = await readFile(configPath, 'utf-8');

      assert.equal((merged.match(/^hooks = true$/gm) ?? []).length, 1);
      assert.doesNotMatch(merged, /^codex_hooks\s*=/m);
      assert.match(merged, /^custom_user_flag = false$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('can target the legacy codex_hooks flag when requested', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      const original = [
        '[features]',
        'hooks = true',
        'custom_user_flag = false',
        '',
      ].join('\n');
      await writeFile(configPath, original);

      await mergeConfig(configPath, wd, { codexHookFeatureFlag: 'codex_hooks' });
      const merged = await readFile(configPath, 'utf-8');

      assert.equal((merged.match(/^codex_hooks = true$/gm) ?? []).length, 1);
      assert.doesNotMatch(merged, /^hooks\s*=/m);
      assert.match(merged, /^custom_user_flag = false$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('dedupes mixed legacy codex_hooks and hooks flags to a single hooks flag', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      const original = [
        '[features]',
        'codex_hooks = true',
        'custom_user_flag = false',
        'hooks = false',
        '',
      ].join('\n');
      await writeFile(configPath, original);

      await mergeConfig(configPath, wd);
      const merged = await readFile(configPath, 'utf-8');

      assert.equal((merged.match(/^hooks = true$/gm) ?? []).length, 1);
      assert.doesNotMatch(merged, /^codex_hooks\s*=/m);
      assert.match(merged, /^custom_user_flag = false$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('normalizes plugin-mode runtime flags to the current hooks flag by default', () => {
    const original = [
      '[features]',
      'custom_user_flag = false',
      'codex_hooks = true',
      'goal = true',
      '',
    ].join('\n');

    const merged = upsertPluginModeRuntimeFeatureFlags(original);

    assert.match(merged, /^hooks = true$/m);
    assert.match(merged, /^goals = true$/m);
    assert.doesNotMatch(merged, /^codex_hooks\s*=/m);
    assert.doesNotMatch(merged, /^goal\s*=/m);
    assert.match(merged, /^custom_user_flag = false$/m);
  });

  it('normalizes plugin-mode runtime flags to legacy codex_hooks when requested', () => {
    const original = [
      '[features]',
      'custom_user_flag = false',
      'codex_hooks = true',
      'goal = true',
      '',
    ].join('\n');

    const merged = upsertPluginModeRuntimeFeatureFlags(original, 'codex_hooks');

    assert.match(merged, /^codex_hooks = true$/m);
    assert.match(merged, /^goals = true$/m);
    assert.doesNotMatch(merged, /^hooks\s*=/m);
    assert.doesNotMatch(merged, /^goal\s*=/m);
    assert.match(merged, /^custom_user_flag = false$/m);
  });

  it('escapes Windows-style backslashes for MCP server args', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      const windowsPkgRoot = 'C:\\Users\\alice\\oh-my-codex';
      await mergeConfig(configPath, windowsPkgRoot, { includeFirstPartyMcp: true });
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

  it('does not preserve cross-install OMX notify commands when notify is disabled', () => {
    const pkgRoot = '/current/install/oh-my-codex';
    const staleConfig = [
      'notify = ["node", "/opt/homebrew/lib/node_modules/oh-my-codex/dist/scripts/notify-dispatcher.js", "--metadata", "/tmp/notify-dispatch.json"]',
      'approval_policy = "never"',
      '',
    ].join('\n');

    const merged = buildMergedConfig(staleConfig, pkgRoot, { notifyCommand: false });

    assert.doesNotMatch(merged, /^notify\s*=/m);
    assert.doesNotMatch(merged, /notify-dispatcher\.js/);
    assert.match(merged, /^approval_policy = "never"$/m);
  });

  it('does not preserve Windows-style OMX notify hooks when notify is disabled', () => {
    const pkgRoot = 'C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\oh-my-codex';
    const staleConfig = [
      'notify = ["node", "C:\\\\Users\\\\alice\\\\AppData\\\\Roaming\\\\npm\\\\node_modules\\\\oh-my-codex\\\\dist\\\\scripts\\\\notify-hook.js"]',
      'approval_policy = "never"',
      '',
    ].join('\n');

    const merged = buildMergedConfig(staleConfig, pkgRoot, { notifyCommand: false });

    assert.doesNotMatch(merged, /^notify\s*=/m);
    assert.doesNotMatch(merged, /notify-hook\.js/);
    assert.match(merged, /^approval_policy = "never"$/m);
  });

  it('does not preserve OMX notify commands invoked through node flags when notify is disabled', () => {
    const pkgRoot = '/current/install/oh-my-codex';
    const staleConfig = [
      'notify = ["node", "--no-warnings", "/opt/homebrew/lib/node_modules/oh-my-codex/dist/scripts/notify-hook.js"]',
      'approval_policy = "never"',
      '',
    ].join('\n');

    const merged = buildMergedConfig(staleConfig, pkgRoot, { notifyCommand: false });

    assert.doesNotMatch(merged, /^notify\s*=/m);
    assert.doesNotMatch(merged, /notify-hook\.js/);
    assert.match(merged, /^approval_policy = "never"$/m);
  });

  it('preserves real user notify commands that mention OMX paths as arguments', () => {
    const pkgRoot = '/current/install/oh-my-codex';
    const userNotify = [
      'notify = ["node", "/tmp/user-notify.js", "/opt/homebrew/lib/node_modules/oh-my-codex/dist/scripts/notify-hook.js"]',
      'approval_policy = "never"',
      '',
    ].join('\n');

    const merged = buildMergedConfig(userNotify, pkgRoot, { notifyCommand: false });

    assert.match(
      merged,
      /^notify = \["node", "\/tmp\/user-notify\.js", "\/opt\/homebrew\/lib\/node_modules\/oh-my-codex\/dist\/scripts\/notify-hook\.js"\]$/m,
    );
    assert.match(merged, /^approval_policy = "never"$/m);
  });
});
