import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createHookPluginSdk, clearHookPluginState } from '../sdk.js';
import type { HookEventEnvelope } from '../types.js';

function makeEvent(event = 'session-start'): HookEventEnvelope {
  return {
    schema_version: '1',
    event,
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'native',
    context: {},
  };
}

describe('createHookPluginSdk', () => {
  describe('state', () => {
    it('reads undefined for missing key', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        const val = await sdk.state.read('nonexistent');
        assert.equal(val, undefined);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('returns fallback for missing key', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        const val = await sdk.state.read('missing', 42);
        assert.equal(val, 42);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('writes and reads state', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        await sdk.state.write('counter', 5);
        const val = await sdk.state.read('counter');
        assert.equal(val, 5);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('deletes state key', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        await sdk.state.write('key', 'value');
        await sdk.state.delete('key');
        const val = await sdk.state.read('key');
        assert.equal(val, undefined);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('delete is a no-op for nonexistent key', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        await sdk.state.write('keep', 'yes');
        await sdk.state.delete('nonexistent');
        const val = await sdk.state.read('keep');
        assert.equal(val, 'yes');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('reads all state', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        await sdk.state.write('a', 1);
        await sdk.state.write('b', 'two');
        const all = await sdk.state.all();
        assert.deepEqual(all, { a: 1, b: 'two' });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('returns empty object for all() with no state', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        const all = await sdk.state.all();
        assert.deepEqual(all, {});
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('rejects empty state key', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        await assert.rejects(() => sdk.state.read(''), /state key is required/);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('rejects state key with path traversal', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        await assert.rejects(() => sdk.state.read('../escape'), /invalid state key/);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('rejects state key starting with /', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        await assert.rejects(() => sdk.state.write('/absolute', 1), /invalid state key/);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('log', () => {
    it('exposes info, warn, error methods', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        // These should not throw
        await sdk.log.info('test info');
        await sdk.log.warn('test warn');
        await sdk.log.error('test error');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('tmux.sendKeys', () => {
    it('returns side_effects_disabled when sideEffectsEnabled is false', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({
          cwd,
          pluginName: 'test',
          event: makeEvent(),
          sideEffectsEnabled: false,
        });
        const result = await sdk.tmux.sendKeys({ text: 'hello' });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'side_effects_disabled');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('returns invalid_text for empty text', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({
          cwd,
          pluginName: 'test',
          event: makeEvent(),
          sideEffectsEnabled: true,
        });
        const result = await sdk.tmux.sendKeys({ text: '   ' });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'invalid_text');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('returns loop_guard_input_marker when text contains loop marker', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      const originalMarker = process.env.OMX_HOOK_PLUGIN_LOOP_MARKER;
      try {
        process.env.OMX_HOOK_PLUGIN_LOOP_MARKER = '[TESTMARK]';
        const sdk = createHookPluginSdk({
          cwd,
          pluginName: 'test',
          event: makeEvent(),
          sideEffectsEnabled: true,
        });
        const result = await sdk.tmux.sendKeys({ text: 'hello [TESTMARK] world' });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'loop_guard_input_marker');
      } finally {
        if (originalMarker === undefined) {
          delete process.env.OMX_HOOK_PLUGIN_LOOP_MARKER;
        } else {
          process.env.OMX_HOOK_PLUGIN_LOOP_MARKER = originalMarker;
        }
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('returns target_missing when no pane is resolvable', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      const originalPane = process.env.TMUX_PANE;
      try {
        delete process.env.TMUX_PANE;
        const sdk = createHookPluginSdk({
          cwd,
          pluginName: 'test',
          event: makeEvent(),
          sideEffectsEnabled: true,
        });
        const result = await sdk.tmux.sendKeys({ text: 'hello' });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'target_missing');
      } finally {
        if (originalPane !== undefined) {
          process.env.TMUX_PANE = originalPane;
        }
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('plugin name sanitization', () => {
    it('sanitizes special characters in plugin name', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({
          cwd,
          pluginName: 'my plugin!@#',
          event: makeEvent(),
        });
        await sdk.state.write('test', 'value');
        const val = await sdk.state.read('test');
        assert.equal(val, 'value');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });
});

describe('clearHookPluginState', () => {
  it('removes data.json and tmux.json for plugin', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-clear-'));
    try {
      const pluginDir = join(cwd, '.omx', 'state', 'hooks', 'plugins', 'my-plugin');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(pluginDir, 'data.json'), '{}');
      await writeFile(join(pluginDir, 'tmux.json'), '{}');

      await clearHookPluginState(cwd, 'my-plugin');

      assert.equal(existsSync(join(pluginDir, 'data.json')), false);
      assert.equal(existsSync(join(pluginDir, 'tmux.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not throw when files do not exist', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-clear-'));
    try {
      await clearHookPluginState(cwd, 'nonexistent');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
