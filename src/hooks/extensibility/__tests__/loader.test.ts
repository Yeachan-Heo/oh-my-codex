import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  HOOK_PLUGIN_ENABLE_ENV,
  HOOK_PLUGIN_TIMEOUT_ENV,
  hooksDir,
  isHookPluginsEnabled,
  resolveHookPluginTimeoutMs,
  ensureHooksDir,
  discoverHookPlugins,
  validateHookPluginExport,
  loadHookPluginDescriptors,
} from '../loader.js';

describe('hooksDir', () => {
  it('returns .omx/hooks under cwd', () => {
    assert.equal(hooksDir('/project'), join('/project', '.omx', 'hooks'));
  });
});

describe('isHookPluginsEnabled', () => {
  it('returns true for "1"', () => {
    assert.equal(isHookPluginsEnabled({ [HOOK_PLUGIN_ENABLE_ENV]: '1' }), true);
  });

  it('returns true for "true"', () => {
    assert.equal(isHookPluginsEnabled({ [HOOK_PLUGIN_ENABLE_ENV]: 'true' }), true);
  });

  it('returns true for "yes"', () => {
    assert.equal(isHookPluginsEnabled({ [HOOK_PLUGIN_ENABLE_ENV]: 'yes' }), true);
  });

  it('returns true for "TRUE" (case insensitive)', () => {
    assert.equal(isHookPluginsEnabled({ [HOOK_PLUGIN_ENABLE_ENV]: 'TRUE' }), true);
  });

  it('returns false for "0"', () => {
    assert.equal(isHookPluginsEnabled({ [HOOK_PLUGIN_ENABLE_ENV]: '0' }), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isHookPluginsEnabled({ [HOOK_PLUGIN_ENABLE_ENV]: '' }), false);
  });

  it('returns false when env var is missing', () => {
    assert.equal(isHookPluginsEnabled({}), false);
  });

  it('returns false for arbitrary string', () => {
    assert.equal(isHookPluginsEnabled({ [HOOK_PLUGIN_ENABLE_ENV]: 'enabled' }), false);
  });
});

describe('resolveHookPluginTimeoutMs', () => {
  it('returns fallback when env var is missing', () => {
    assert.equal(resolveHookPluginTimeoutMs({}), 1500);
  });

  it('returns custom fallback', () => {
    assert.equal(resolveHookPluginTimeoutMs({}, 3000), 3000);
  });

  it('parses valid numeric string', () => {
    assert.equal(resolveHookPluginTimeoutMs({ [HOOK_PLUGIN_TIMEOUT_ENV]: '5000' }), 5000);
  });

  it('clamps to minimum of 100', () => {
    assert.equal(resolveHookPluginTimeoutMs({ [HOOK_PLUGIN_TIMEOUT_ENV]: '10' }), 100);
  });

  it('clamps to maximum of 60000', () => {
    assert.equal(resolveHookPluginTimeoutMs({ [HOOK_PLUGIN_TIMEOUT_ENV]: '999999' }), 60000);
  });

  it('floors fractional values', () => {
    assert.equal(resolveHookPluginTimeoutMs({ [HOOK_PLUGIN_TIMEOUT_ENV]: '2500.9' }), 2500);
  });

  it('returns fallback for non-numeric string', () => {
    assert.equal(resolveHookPluginTimeoutMs({ [HOOK_PLUGIN_TIMEOUT_ENV]: 'abc' }), 1500);
  });

  it('returns fallback for empty string', () => {
    assert.equal(resolveHookPluginTimeoutMs({ [HOOK_PLUGIN_TIMEOUT_ENV]: '' }), 1500);
  });
});

describe('ensureHooksDir', () => {
  it('creates .omx/hooks directory and returns path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ensure-'));
    try {
      const dir = await ensureHooksDir(cwd);
      assert.equal(dir, join(cwd, '.omx', 'hooks'));
      assert.ok(existsSync(dir));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('discoverHookPlugins', () => {
  it('returns empty array when hooks directory does not exist', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-discover-'));
    try {
      const plugins = await discoverHookPlugins(cwd);
      assert.deepEqual(plugins, []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('discovers .mjs files in hooks directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-discover-'));
    try {
      const dir = join(cwd, '.omx', 'hooks');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'alpha.mjs'), 'export function onHookEvent() {}');
      await writeFile(join(dir, 'beta.mjs'), 'export function onHookEvent() {}');
      await writeFile(join(dir, 'readme.txt'), 'not a plugin');

      const plugins = await discoverHookPlugins(cwd);
      assert.equal(plugins.length, 2);
      assert.equal(plugins[0].id, 'alpha');
      assert.equal(plugins[0].file, 'alpha.mjs');
      assert.equal(plugins[1].id, 'beta');
      assert.equal(plugins[1].file, 'beta.mjs');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('sorts plugins alphabetically by file name', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-discover-'));
    try {
      const dir = join(cwd, '.omx', 'hooks');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'z-last.mjs'), 'export function onHookEvent() {}');
      await writeFile(join(dir, 'a-first.mjs'), 'export function onHookEvent() {}');

      const plugins = await discoverHookPlugins(cwd);
      assert.equal(plugins[0].file, 'a-first.mjs');
      assert.equal(plugins[1].file, 'z-last.mjs');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('sanitizes plugin id from file name', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-discover-'));
    try {
      const dir = join(cwd, '.omx', 'hooks');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'My Plugin!!(v2).mjs'), 'export function onHookEvent() {}');

      const plugins = await discoverHookPlugins(cwd);
      assert.equal(plugins.length, 1);
      assert.match(plugins[0].id, /^[a-z0-9_-]+$/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('skips subdirectories', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-discover-'));
    try {
      const dir = join(cwd, '.omx', 'hooks');
      await mkdir(join(dir, 'subdir.mjs'), { recursive: true });
      await writeFile(join(dir, 'real.mjs'), 'export function onHookEvent() {}');

      const plugins = await discoverHookPlugins(cwd);
      assert.equal(plugins.length, 1);
      assert.equal(plugins[0].file, 'real.mjs');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('validateHookPluginExport', () => {
  it('returns valid for plugin with onHookEvent export', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-validate-'));
    try {
      const pluginPath = join(cwd, 'valid.mjs');
      await writeFile(pluginPath, 'export function onHookEvent() {}');

      const result = await validateHookPluginExport(pluginPath);
      assert.equal(result.valid, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns invalid for plugin without onHookEvent export', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-validate-'));
    try {
      const pluginPath = join(cwd, 'invalid.mjs');
      await writeFile(pluginPath, 'export function hello() {}');

      const result = await validateHookPluginExport(pluginPath);
      assert.equal(result.valid, false);
      assert.ok(result.reason);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns invalid for nonexistent file', async () => {
    const result = await validateHookPluginExport('/nonexistent/plugin.mjs');
    assert.equal(result.valid, false);
    assert.ok(result.reason);
  });

  it('returns invalid for plugin with syntax error', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-validate-'));
    try {
      const pluginPath = join(cwd, 'broken.mjs');
      await writeFile(pluginPath, 'export function {{{');

      const result = await validateHookPluginExport(pluginPath);
      assert.equal(result.valid, false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('loadHookPluginDescriptors', () => {
  it('returns empty array when no hooks directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-load-'));
    try {
      const descriptors = await loadHookPluginDescriptors(cwd);
      assert.deepEqual(descriptors, []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns descriptors with validation status', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-load-'));
    try {
      const dir = join(cwd, '.omx', 'hooks');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'good.mjs'), 'export function onHookEvent() {}');
      await writeFile(join(dir, 'bad.mjs'), 'export const x = 1;');

      const descriptors = await loadHookPluginDescriptors(cwd);
      assert.equal(descriptors.length, 2);

      const bad = descriptors.find((d) => d.id === 'bad');
      const good = descriptors.find((d) => d.id === 'good');
      assert.ok(bad);
      assert.ok(good);
      assert.equal(bad.valid, false);
      assert.ok(bad.reason);
      assert.equal(good.valid, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
