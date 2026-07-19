import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

async function writeOmxStateFile(cwd: string, fileName: string, value: unknown): Promise<void> {
  const stateDir = join(cwd, '.omx', 'state');
  const targetPath = join(stateDir, fileName);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(value, null, 2));
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


    it('prefers non-HUD codex pane when targeting a tmux session', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-sdk-bin-'));
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const previousPath = process.env.PATH;
      try {
        await writeFile(fakeTmuxPath, `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "list-panes" ]]; then
  printf "%%2	1	node /pkg/dist/cli/omx.js hud --watch
%%42	0	codex --model gpt-5
"
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ "$format" == "#{pane_id}" ]]; then
    echo "$target"
    exit 0
  fi
  exit 0
fi
exit 1
`);
        await import('node:fs/promises').then((fs) => fs.chmod(fakeTmuxPath, 0o755));
        process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;

        const sdk = createHookPluginSdk({
          cwd,
          pluginName: 'test',
          event: makeEvent(),
          sideEffectsEnabled: true,
        });
        const result = await sdk.tmux.sendKeys({ text: 'hello', sessionName: 'devsess' });
        assert.equal(result.ok, true);
        assert.equal(result.target, '%42');
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        await rm(cwd, { recursive: true, force: true });
        await rm(fakeBinDir, { recursive: true, force: true });
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

  describe('omx', () => {
    it('exposes only the explicit read-only omx readers', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });

        assert.deepEqual(Object.keys(sdk.omx).sort(), ['hud', 'notifyFallback', 'session', 'updateCheck']);
        assert.equal(typeof sdk.omx.session.read, 'function');
        assert.equal(typeof sdk.omx.hud.read, 'function');
        assert.equal(typeof sdk.omx.notifyFallback.read, 'function');
        assert.equal(typeof sdk.omx.updateCheck.read, 'function');
        assert.equal('pluginState' in sdk, false);
        assert.equal('readJson' in sdk.omx, false);
        assert.equal('list' in sdk.omx, false);
        assert.equal('exists' in sdk.omx, false);
        assert.equal('write' in sdk.omx.session, false);
        assert.equal('delete' in sdk.omx.session, false);
        assert.equal('write' in sdk.omx.hud, false);
        assert.equal('delete' in sdk.omx.hud, false);
        assert.equal('write' in sdk.omx.notifyFallback, false);
        assert.equal('delete' in sdk.omx.notifyFallback, false);
        assert.equal('write' in sdk.omx.updateCheck, false);
        assert.equal('delete' in sdk.omx.updateCheck, false);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('reads session state from .omx/state/session.json', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        await writeOmxStateFile(cwd, 'session.json', {
          session_id: 'session-123',
          cwd,
          started_at: '2026-01-01T00:00:00.000Z',
        });

        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        const state = await sdk.omx.session.read();
        assert.deepEqual(state, {
          session_id: 'session-123',
          cwd,
          started_at: '2026-01-01T00:00:00.000Z',
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('returns null for invalid session state without session_id', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        await writeOmxStateFile(cwd, 'session.json', {
          started_at: '2026-01-01T00:00:00.000Z',
        });

        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        assert.equal(await sdk.omx.session.read(), null);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('reads hud, notifyFallback, and updateCheck state from root-scoped omx files', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        await writeOmxStateFile(cwd, 'hud-state.json', {
          last_turn_at: '2026-01-01T00:00:00.000Z',
          turn_count: 3,
        });
        await writeOmxStateFile(cwd, 'notify-fallback-state.json', {
          pid: 1234,
          stopping: false,
          tracked_files: 2,
        });
        await writeOmxStateFile(cwd, 'update-check.json', {
          last_checked_at: '2026-01-01T00:00:00.000Z',
          last_seen_latest: '0.11.0',
        });

        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        assert.deepEqual(await sdk.omx.hud.read(), {
          last_turn_at: '2026-01-01T00:00:00.000Z',
          turn_count: 3,
        });
        assert.deepEqual(await sdk.omx.notifyFallback.read(), {
          pid: 1234,
          stopping: false,
          tracked_files: 2,
        });
        assert.deepEqual(await sdk.omx.updateCheck.read(), {
          last_checked_at: '2026-01-01T00:00:00.000Z',
          last_seen_latest: '0.11.0',
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('reads hud state from the current session scope instead of stale root fallback', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-hud-session-'));
      try {
        await writeOmxStateFile(cwd, 'session.json', {
          session_id: 'sess-current',
          cwd,
          started_at: '2026-01-01T00:00:00.000Z',
        });
        await writeOmxStateFile(cwd, 'hud-state.json', {
          last_turn_at: 'root-stale',
          turn_count: 99,
          last_agent_output: 'Would you like me to continue?',
        });
        await writeOmxStateFile(cwd, join('sessions', 'sess-current', 'hud-state.json'), {
          last_turn_at: '2026-01-01T00:00:00.000Z',
          turn_count: 3,
          last_agent_output: 'Current session output',
        });

        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        assert.deepEqual(await sdk.omx.hud.read(), {
          last_turn_at: '2026-01-01T00:00:00.000Z',
          turn_count: 3,
          last_agent_output: 'Current session output',
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('honors explicit stateRoot when reading session-scoped HUD state', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-hud-source-'));
      const stateRoot = await mkdtemp(join(tmpdir(), 'omx-sdk-hud-authority-'));
      try {
        await writeOmxStateFile(cwd, 'session.json', { session_id: 'stale-source', cwd });
        await writeOmxStateFile(cwd, join('sessions', 'stale-source', 'hud-state.json'), {
          last_turn_at: 'stale-source',
          turn_count: 99,
        });
        await mkdir(join(stateRoot, 'sessions', 'sess-authority'), { recursive: true });
        await writeFile(join(stateRoot, 'session.json'), JSON.stringify({
          session_id: 'sess-authority',
          cwd,
          state_root: stateRoot,
        }));
        await writeFile(join(stateRoot, 'sessions', 'sess-authority', 'hud-state.json'), JSON.stringify({
          last_turn_at: 'authoritative',
          turn_count: 3,
        }));

        const sdk = createHookPluginSdk({
          cwd,
          stateRoot,
          pluginName: 'test',
          event: { ...makeEvent(), session_id: 'sess-authority' },
        });
        assert.deepEqual(await sdk.omx.hud.read(), {
          last_turn_at: 'authoritative',
          turn_count: 3,
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
        await rm(stateRoot, { recursive: true, force: true });
      }
    });

    it('requires a usable pointer and bound hook session for explicit HUD reads', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-hud-binding-source-'));
      const stateRoot = await mkdtemp(join(tmpdir(), 'omx-sdk-hud-binding-root-'));
      try {
        const sessionDir = join(stateRoot, 'sessions', 'sess-canonical');
        await mkdir(sessionDir, { recursive: true });
        await writeFile(join(sessionDir, 'hud-state.json'), JSON.stringify({ turn_count: 4 }));
        await writeFile(join(stateRoot, 'session.json'), JSON.stringify({
          session_id: 'sess-canonical',
          native_session_id: 'sess-native',
          owner_codex_session_id: 'sess-owner-codex',
          cwd,
          state_root: stateRoot,
        }));

        let sdk = createHookPluginSdk({
          cwd,
          stateRoot,
          pluginName: 'test',
          event: { ...makeEvent(), session_id: 'sess-native' },
        });
        assert.deepEqual(await sdk.omx.hud.read(), { turn_count: 4 });

        sdk = createHookPluginSdk({
          cwd,
          stateRoot,
          pluginName: 'test',
          event: { ...makeEvent(), session_id: 'sess-owner-codex' },
        });
        assert.deepEqual(await sdk.omx.hud.read(), { turn_count: 4 });

        sdk = createHookPluginSdk({
          cwd,
          stateRoot,
          pluginName: 'test',
          event: { ...makeEvent(), session_id: '../invalid' },
        });
        assert.equal(await sdk.omx.hud.read(), null);

        sdk = createHookPluginSdk({
          cwd,
          stateRoot,
          pluginName: 'test',
          event: { ...makeEvent(), session_id: 'sess-foreign' },
        });
        assert.equal(await sdk.omx.hud.read(), null);

        await writeFile(join(stateRoot, 'session.json'), JSON.stringify({
          session_id: 'sess-canonical',
          cwd,
          state_root: stateRoot,
          pid: 2_147_483_647,
        }));
        sdk = createHookPluginSdk({
          cwd,
          stateRoot,
          pluginName: 'test',
          event: { ...makeEvent(), session_id: 'sess-canonical' },
        });
        assert.equal(await sdk.omx.hud.read(), null);
      } finally {
        await rm(cwd, { recursive: true, force: true });
        await rm(stateRoot, { recursive: true, force: true });
      }
    });

    it('rejects invalid and symlink-escaped sessions under explicit stateRoot', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-hud-containment-source-'));
      const stateRoot = await mkdtemp(join(tmpdir(), 'omx-sdk-hud-containment-root-'));
      const outside = await mkdtemp(join(tmpdir(), 'omx-sdk-hud-containment-outside-'));
      try {
        await writeFile(join(stateRoot, 'session.json'), JSON.stringify({ session_id: '../outside' }));
        let sdk = createHookPluginSdk({ cwd, stateRoot, pluginName: 'test', event: makeEvent() });
        assert.equal(await sdk.omx.hud.read(), null);

        await mkdir(join(stateRoot, 'sessions'), { recursive: true });
        await writeFile(join(outside, 'hud-state.json'), JSON.stringify({ turn_count: 99 }));
        await symlink(outside, join(stateRoot, 'sessions', 'sess-escaped'), process.platform === 'win32' ? 'junction' : 'dir');
        await writeFile(join(stateRoot, 'session.json'), JSON.stringify({ session_id: 'sess-escaped', cwd, state_root: stateRoot }));
        sdk = createHookPluginSdk({ cwd, stateRoot, pluginName: 'test', event: { ...makeEvent(), session_id: 'sess-escaped' } });
        assert.equal(await sdk.omx.hud.read(), null);

        const crossSessionTarget = join(stateRoot, 'sessions', 'sess-cross-target');
        await mkdir(crossSessionTarget, { recursive: true });
        await writeFile(join(crossSessionTarget, 'hud-state.json'), JSON.stringify({ turn_count: 77 }));
        await symlink(
          crossSessionTarget,
          join(stateRoot, 'sessions', 'sess-cross'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        await writeFile(join(stateRoot, 'session.json'), JSON.stringify({
          session_id: 'sess-cross',
          cwd,
          state_root: stateRoot,
        }));
        sdk = createHookPluginSdk({
          cwd,
          stateRoot,
          pluginName: 'test',
          event: { ...makeEvent(), session_id: 'sess-cross' },
        });
        assert.equal(await sdk.omx.hud.read(), null);

        if (process.platform !== 'win32') {
          const fileSessionDir = join(stateRoot, 'sessions', 'sess-file-escaped');
          await mkdir(fileSessionDir, { recursive: true });
          await symlink(
            join(outside, 'hud-state.json'),
            join(fileSessionDir, 'hud-state.json'),
            'file',
          );
          await writeFile(join(stateRoot, 'session.json'), JSON.stringify({ session_id: 'sess-file-escaped', cwd, state_root: stateRoot }));
          sdk = createHookPluginSdk({ cwd, stateRoot, pluginName: 'test', event: { ...makeEvent(), session_id: 'sess-file-escaped' } });
          assert.equal(await sdk.omx.hud.read(), null);

          const siblingDir = join(stateRoot, 'sessions', 'sess-sibling');
          const siblingTargetDir = join(stateRoot, 'sessions', 'sess-sibling-target');
          await mkdir(siblingDir, { recursive: true });
          await mkdir(siblingTargetDir, { recursive: true });
          await writeFile(join(siblingTargetDir, 'hud-state.json'), JSON.stringify({ turn_count: 55 }));
          await symlink(join(siblingTargetDir, 'hud-state.json'), join(siblingDir, 'hud-state.json'), 'file');
          await writeFile(join(stateRoot, 'session.json'), JSON.stringify({ session_id: 'sess-sibling', cwd, state_root: stateRoot }));
          sdk = createHookPluginSdk({ cwd, stateRoot, pluginName: 'test', event: { ...makeEvent(), session_id: 'sess-sibling' } });
          assert.equal(await sdk.omx.hud.read(), null);
        }
      } finally {
        await rm(cwd, { recursive: true, force: true });
        await rm(stateRoot, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('returns null for missing omx reader files', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        assert.equal(await sdk.omx.session.read(), null);
        assert.equal(await sdk.omx.hud.read(), null);
        assert.equal(await sdk.omx.notifyFallback.read(), null);
        assert.equal(await sdk.omx.updateCheck.read(), null);
      } finally {
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
