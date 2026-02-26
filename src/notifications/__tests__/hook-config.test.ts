/**
 * Tests for hook notification config reader.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  getHookConfig,
  resetHookConfigCache,
  resolveEventTemplate,
  mergeHookConfigIntoNotificationConfig,
} from '../hook-config.js';
import type { HookNotificationConfig } from '../hook-config-types.js';
import type { FullNotificationConfig } from '../types.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `omx-hook-cfg-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('getHookConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    resetHookConfigCache();
    delete process.env.OMX_HOOK_CONFIG;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    resetHookConfigCache();
    delete process.env.OMX_HOOK_CONFIG;
  });

  it('returns null when no config exists', () => {
    assert.equal(getHookConfig(), null);
  });

  it('reads config from OMX_HOOK_CONFIG env var path', () => {
    const path = join(tmpDir, 'hook.json');
    writeFileSync(path, JSON.stringify({ version: 1, enabled: true }));
    process.env.OMX_HOOK_CONFIG = path;
    const result = getHookConfig();
    assert.ok(result !== null);
    assert.equal(result!.enabled, true);
  });

  it('returns null when OMX_HOOK_CONFIG file does not exist', () => {
    process.env.OMX_HOOK_CONFIG = join(tmpDir, 'nonexistent.json');
    assert.equal(getHookConfig(), null);
  });

  it('returns null when config has enabled: false', () => {
    const path = join(tmpDir, 'hook.json');
    writeFileSync(path, JSON.stringify({ version: 1, enabled: false }));
    process.env.OMX_HOOK_CONFIG = path;
    assert.equal(getHookConfig(), null);
  });

  it('caches result after first read', () => {
    const path = join(tmpDir, 'hook.json');
    writeFileSync(path, JSON.stringify({ version: 1, enabled: true }));
    process.env.OMX_HOOK_CONFIG = path;
    const first = getHookConfig();
    writeFileSync(path, JSON.stringify({ version: 1, enabled: false }));
    const second = getHookConfig();
    assert.equal(first, second);
  });

  it('resetHookConfigCache clears cache', () => {
    const path = join(tmpDir, 'hook.json');
    writeFileSync(path, JSON.stringify({ version: 1, enabled: true }));
    process.env.OMX_HOOK_CONFIG = path;
    getHookConfig();
    resetHookConfigCache();
    writeFileSync(path, JSON.stringify({ version: 1, enabled: false }));
    assert.equal(getHookConfig(), null);
  });
});

describe('resolveEventTemplate', () => {
  const baseConfig: HookNotificationConfig = {
    version: 1,
    enabled: true,
    defaultTemplate: 'default: {{event}}',
    events: {
      'session-end': {
        enabled: true,
        template: 'event-level template',
        platforms: {
          discord: { template: 'discord-specific template' },
        },
      },
      'session-idle': { enabled: true },
    },
  };

  it('returns null when hookConfig is null', () => {
    assert.equal(resolveEventTemplate(null, 'session-end', 'discord'), null);
  });

  it('returns platform-specific template when available', () => {
    assert.equal(resolveEventTemplate(baseConfig, 'session-end', 'discord'), 'discord-specific template');
  });

  it('falls back to event-level template when no platform override', () => {
    assert.equal(resolveEventTemplate(baseConfig, 'session-end', 'telegram'), 'event-level template');
  });

  it('falls back to defaultTemplate when event has no template', () => {
    assert.equal(resolveEventTemplate(baseConfig, 'session-idle', 'discord'), 'default: {{event}}');
  });

  it('returns null when no template found at any level', () => {
    const minimal: HookNotificationConfig = { version: 1, enabled: true };
    assert.equal(resolveEventTemplate(minimal, 'session-start', 'telegram'), null);
  });
});

describe('mergeHookConfigIntoNotificationConfig', () => {
  const baseNotif: FullNotificationConfig = {
    enabled: true,
    discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/test' },
    events: {
      'session-end': { enabled: true },
      'session-start': { enabled: true },
    },
  };

  it('overrides event enabled flag from hook config', () => {
    const hook: HookNotificationConfig = {
      version: 1, enabled: true,
      events: { 'session-end': { enabled: false } },
    };
    const merged = mergeHookConfigIntoNotificationConfig(hook, baseNotif);
    assert.equal(merged.events?.['session-end']?.enabled, false);
  });

  it('does not affect events not in hook config', () => {
    const hook: HookNotificationConfig = {
      version: 1, enabled: true,
      events: { 'session-end': { enabled: false } },
    };
    const merged = mergeHookConfigIntoNotificationConfig(hook, baseNotif);
    assert.equal(merged.events?.['session-start']?.enabled, true);
  });

  it('does not affect platform credentials', () => {
    const hook: HookNotificationConfig = {
      version: 1, enabled: true,
      events: { 'session-end': { enabled: false } },
    };
    const merged = mergeHookConfigIntoNotificationConfig(hook, baseNotif);
    assert.equal(merged.discord?.webhookUrl, 'https://discord.com/api/webhooks/test');
  });

  it('returns base config unchanged when hook config has no events', () => {
    const hook: HookNotificationConfig = { version: 1, enabled: true };
    const merged = mergeHookConfigIntoNotificationConfig(hook, baseNotif);
    assert.deepEqual(merged, baseNotif);
  });
});
