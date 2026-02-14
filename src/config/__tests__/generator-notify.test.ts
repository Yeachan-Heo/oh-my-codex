import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeConfig } from '../generator.js';

describe('config generator notify', () => {
  it('includes the default model reasoning effort in OMX block', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      assert.match(toml, /^model_reasoning_effort = "high"$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('writes notify as a TOML string (not an array)', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      assert.match(toml, /^notify = ".*"$/m);
      assert.doesNotMatch(toml, /^notify = \[/m);
      assert.match(toml, /notify = "node /);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('always emits notify as a TOML string even when OMX_NOTIFY_FORMAT=array is set', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    const previous = process.env.OMX_NOTIFY_FORMAT;
    process.env.OMX_NOTIFY_FORMAT = 'array';
    try {
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      assert.match(toml, /^notify = ".*"$/m);
      assert.doesNotMatch(toml, /^notify = \[/m);
    } finally {
      if (previous === undefined) {
        delete process.env.OMX_NOTIFY_FORMAT;
      } else {
        process.env.OMX_NOTIFY_FORMAT = previous;
      }
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('quotes notify hook path so spaces are preserved', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omx config gen space-'));
    // Add a space in the pkgRoot path itself.
    const wd = join(base, 'pkg root');
    try {
      await mkdir(wd, { recursive: true });
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      const m = toml.match(/^notify = "(.*)"$/m);
      assert.ok(m, 'notify string not found');

      const notify = m[1];
      assert.match(notify, /^node /);
      // The path part should be quoted inside the command string.
      assert.ok(notify.startsWith('node \\"'));
      assert.ok(notify.endsWith('notify-hook.js\\"'));
      assert.match(notify, /pkg root/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('re-runs setup by replacing OMX block cleanly', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);

      let toml = await readFile(configPath, 'utf-8');
      toml = toml.replace(
        'model_reasoning_effort = "high"',
        'model_reasoning_effort = "low"'
      );
      toml += '\n# user tail\n[user.settings]\nname = "kept"\n';
      await writeFile(configPath, toml);

      await mergeConfig(configPath, wd);
      const rerun = await readFile(configPath, 'utf-8');

      assert.match(rerun, /^model_reasoning_effort = "high"$/m);
      assert.doesNotMatch(rerun, /^model_reasoning_effort = "low"$/m);
      assert.equal(
        (rerun.match(/# oh-my-codex \(OMX\) Configuration/g) ?? []).length,
        1
      );
      assert.equal((rerun.match(/# End oh-my-codex/g) ?? []).length, 1);
      assert.equal((rerun.match(/^\[features\]$/gm) ?? []).length, 1);
      assert.match(rerun, /^collab = true$/m);
      assert.match(rerun, /^child_agents_md = true$/m);
      assert.match(rerun, /^\[user.settings\]$/m);
      assert.match(rerun, /^name = "kept"$/m);
      assert.match(rerun, /^notify = ".*"$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('migrates a legacy OMX block notify array into a TOML string', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      const legacy = [
        '[features]',
        'web_search_request = true',
        '',
        '# ============================================================',
        '# oh-my-codex (OMX) Configuration',
        '# Managed by omx setup - manual edits preserved on next setup',
        '# ============================================================',
        '',
        'notify = ["node", "/tmp/notify-hook.js"]',
        '',
        '[mcp_servers.omx_state]',
        'command = "node"',
        'args = ["/tmp/state-server.js"]',
        '',
        '# ============================================================',
        '# End oh-my-codex',
        '',
      ].join('\n');
      await writeFile(configPath, legacy);

      await mergeConfig(configPath, wd);
      const merged = await readFile(configPath, 'utf-8');

      assert.match(merged, /^notify = ".*"$/m);
      assert.doesNotMatch(merged, /^notify = \[/m);
      assert.equal((merged.match(/# oh-my-codex \(OMX\) Configuration/g) ?? []).length, 1);
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
      assert.match(merged, /^collab = true$/m);
      assert.match(merged, /^child_agents_md = true$/m);
      assert.match(merged, /^\[user.settings\]$/m);
      assert.match(merged, /^name = "kept"$/m);
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
      assert.match(toml, /^notify = ".*"$/m);
      assert.doesNotMatch(toml, /^notify = \[/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
