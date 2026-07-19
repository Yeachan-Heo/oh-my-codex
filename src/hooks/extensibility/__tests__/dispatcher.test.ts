import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';
import { isHookPluginFeatureEnabled, dispatchHookEvent } from '../dispatcher.js';
import { buildHookEvent } from '../events.js';

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} should exit before timeout`);
}

describe('isHookPluginFeatureEnabled', () => {
  it('returns true when OMX_HOOK_PLUGINS=1', () => {
    assert.equal(isHookPluginFeatureEnabled({ OMX_HOOK_PLUGINS: '1' }), true);
  });

  it('returns true when env var is missing', () => {
    assert.equal(isHookPluginFeatureEnabled({}), true);
  });

  it('returns false for "0"', () => {
    assert.equal(isHookPluginFeatureEnabled({ OMX_HOOK_PLUGINS: '0' }), false);
  });
});

describe('dispatchHookEvent', () => {
  it('returns disabled summary when plugins are disabled', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-'));
    try {
      const event = buildHookEvent('session-start');
      const result = await dispatchHookEvent(event, {
        cwd,
        env: {},
        enabled: false,
      });

      assert.equal(result.enabled, false);
      assert.equal(result.reason, 'disabled');
      assert.equal(result.event, 'session-start');
      assert.equal(result.plugin_count, 0);
      assert.deepEqual(result.results, []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns enabled summary with zero plugins for native events even when env is unset', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-'));
    try {
      const event = buildHookEvent('session-start');
      const result = await dispatchHookEvent(event, {
        cwd,
        env: {},
      });

      assert.equal(result.enabled, true);
      assert.equal(result.reason, 'ok');
      assert.equal(result.plugin_count, 0);
      assert.deepEqual(result.results, []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reports invalid_export for plugins without onHookEvent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-'));
    try {
      const dir = join(cwd, '.omx', 'hooks');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'bad.mjs'), 'export const x = 1;');

      const event = buildHookEvent('session-start');
      const result = await dispatchHookEvent(event, {
        cwd,
        env: { OMX_HOOK_PLUGINS: '1' },
      });

      assert.equal(result.enabled, true);
      assert.equal(result.plugin_count, 1);
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].ok, false);
      assert.equal(result.results[0].status, 'invalid_export');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('dispatches valid plugins successfully', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-'));
    try {
      const dir = join(cwd, '.omx', 'hooks');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'good.mjs'),
        'export async function onHookEvent(event, sdk) { await sdk.state.write("ran", true); }',
      );

      const event = buildHookEvent('session-start');
      const result = await dispatchHookEvent(event, {
        cwd,
        env: { ...process.env, OMX_HOOK_PLUGINS: '1' },
      });

      assert.equal(result.enabled, true);
      assert.equal(result.plugin_count, 1);
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].ok, true);
      assert.equal(result.results[0].plugin, 'good');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('forwards explicit stateRoot through the plugin runner to HUD reads', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-root-source-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'omx-dispatch-root-authority-'));
    try {
      const dir = join(cwd, '.omx', 'hooks');
      const sessionDir = join(stateRoot, 'sessions', 'sess-dispatch');
      await mkdir(dir, { recursive: true });
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateRoot, 'session.json'), JSON.stringify({ session_id: 'sess-dispatch', cwd, state_root: stateRoot }));
      await writeFile(join(sessionDir, 'hud-state.json'), JSON.stringify({ turn_count: 7 }));
      await writeFile(
        join(dir, 'root-reader.mjs'),
        `import { writeFile } from 'node:fs/promises';
export async function onHookEvent(event, sdk) {
  const hud = await sdk.omx.hud.read();
  await writeFile(process.env.OMX_TEST_DISPATCH_OUTPUT, JSON.stringify(hud));
}`,
      );
      const outputPath = join(cwd, 'dispatch-output.json');

      const result = await dispatchHookEvent(buildHookEvent('session-start'), {
        cwd,
        stateRoot,
        env: { ...process.env, OMX_HOOK_PLUGINS: '1', OMX_TEST_DISPATCH_OUTPUT: outputPath },
      });

      assert.equal(result.results[0]?.ok, true);
      assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), { turn_count: 7 });
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('resolves plugin authority from options.env instead of ambient process.env', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-env-source-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'omx-dispatch-env-authority-'));
    const ambientRoot = await mkdtemp(join(tmpdir(), 'omx-dispatch-env-ambient-'));
    const previousTeamRoot = process.env.OMX_TEAM_STATE_ROOT;
    const previousAllowlist = process.env.OMX_MCP_WORKDIR_ROOTS;
    try {
      process.env.OMX_TEAM_STATE_ROOT = ambientRoot;
      process.env.OMX_MCP_WORKDIR_ROOTS = ambientRoot;
      const dir = join(cwd, '.omx', 'hooks');
      const sessionDir = join(stateRoot, 'sessions', 'sess-env');
      await mkdir(dir, { recursive: true });
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateRoot, 'session.json'), JSON.stringify({ session_id: 'sess-env', cwd, state_root: stateRoot }));
      await writeFile(join(sessionDir, 'hud-state.json'), JSON.stringify({ turn_count: 8 }));
      await writeFile(
        join(dir, 'env-root-reader.mjs'),
        `import { writeFile } from 'node:fs/promises';
export async function onHookEvent(event, sdk) {
  await writeFile(process.env.OMX_TEST_DISPATCH_OUTPUT, JSON.stringify(await sdk.omx.hud.read()));
}`,
      );
      const outputPath = join(cwd, 'dispatch-output.json');
      const result = await dispatchHookEvent(buildHookEvent('session-start', { session_id: 'sess-env' }), {
        cwd,
        env: {
          ...process.env,
          OMX_TEAM_STATE_ROOT: stateRoot,
          OMX_MCP_WORKDIR_ROOTS: [cwd, stateRoot].join(delimiter),
          OMX_HOOK_PLUGINS: '1',
          OMX_TEST_DISPATCH_OUTPUT: outputPath,
        },
      });

      assert.equal(result.results[0]?.ok, true);
      assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), { turn_count: 8 });
    } finally {
      if (previousTeamRoot === undefined) delete process.env.OMX_TEAM_STATE_ROOT;
      else process.env.OMX_TEAM_STATE_ROOT = previousTeamRoot;
      if (previousAllowlist === undefined) delete process.env.OMX_MCP_WORKDIR_ROOTS;
      else process.env.OMX_MCP_WORKDIR_ROOTS = previousAllowlist;
      await rm(cwd, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
      await rm(ambientRoot, { recursive: true, force: true });
    }
  });

  it('returns null HUD state through the runner when the default state root is absent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-missing-root-'));
    try {
      const dir = join(cwd, '.omx', 'hooks');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'missing-root-reader.mjs'),
        `import { writeFile } from 'node:fs/promises';
export async function onHookEvent(event, sdk) {
  const hud = await sdk.omx.hud.read();
  await writeFile(process.env.OMX_TEST_DISPATCH_OUTPUT, JSON.stringify(hud));
}`,
      );
      const outputPath = join(cwd, 'dispatch-output.json');

      const result = await dispatchHookEvent(buildHookEvent('session-start'), {
        cwd,
        env: { ...process.env, OMX_HOOK_PLUGINS: '1', OMX_TEST_DISPATCH_OUTPUT: outputPath },
      });

      assert.equal(result.results[0]?.ok, true);
      assert.equal(JSON.parse(await readFile(outputPath, 'utf8')), null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not execute plugin top-level code in the parent process', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-'));
    try {
      const dir = join(cwd, '.omx', 'hooks');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'top-level-side-effect.mjs'),
        `import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
appendFileSync(join(process.cwd(), '.omx', 'top-level-pids.log'), String(process.pid) + '\\n');
export async function onHookEvent() {}
`,
      );

      const event = buildHookEvent('session-start');
      const result = await dispatchHookEvent(event, {
        cwd,
        env: { ...process.env, OMX_HOOK_PLUGINS: '1' },
      });

      assert.equal(result.enabled, true);
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].ok, true);

      const pids = (await readFile(join(cwd, '.omx', 'top-level-pids.log'), 'utf-8'))
        .trim()
        .split('\n')
        .filter(Boolean);
      assert.equal(pids.length, 1);
      assert.notEqual(pids[0], String(process.pid));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('respects explicit enabled=true option', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-'));
    try {
      const event = buildHookEvent('session-start');
      const result = await dispatchHookEvent(event, {
        cwd,
        env: {},
        enabled: true,
      });

      assert.equal(result.enabled, true);
      assert.equal(result.plugin_count, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('includes source from event in summary', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-'));
    try {
      const event = buildHookEvent('needs-input');
      const result = await dispatchHookEvent(event, {
        cwd,
      });

      assert.equal(result.source, 'derived');
      assert.equal(result.event, 'needs-input');
      assert.equal(result.enabled, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('disables side effects for team workers by default', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-'));
    try {
      const dir = join(cwd, '.omx', 'hooks');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'se-test.mjs'),
        `export async function onHookEvent(event, sdk) {
          const result = await sdk.tmux.sendKeys({ text: 'hello' });
          await sdk.state.write('send_result', result.reason);
        }`,
      );

      const event = buildHookEvent('session-start');
      const result = await dispatchHookEvent(event, {
        cwd,
        env: { ...process.env, OMX_HOOK_PLUGINS: '1', OMX_TEAM_WORKER: 'worker-1' },
      });

      assert.equal(result.enabled, true);
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].ok, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns timeout promptly when plugin ignores SIGTERM', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-'));
    try {
      const dir = join(cwd, '.omx', 'hooks');
      await mkdir(dir, { recursive: true });
      const pidFile = join(cwd, 'plugin-runner.pid');
      await writeFile(
        join(dir, 'ignore-sigterm.mjs'),
        `import { writeFileSync } from 'node:fs';
        export async function onHookEvent() {
          writeFileSync(process.env.OMX_TEST_PLUGIN_PID_FILE, String(process.pid));
          process.on('SIGTERM', () => {});
          setInterval(() => {}, 60_000);
          await new Promise(() => {});
        }`,
      );

      const event = buildHookEvent('session-start');
      const startedAt = Date.now();
      const result = await dispatchHookEvent(event, {
        cwd,
        timeoutMs: 300,
        env: { ...process.env, OMX_HOOK_PLUGINS: '1', OMX_TEST_PLUGIN_PID_FILE: pidFile },
      });
      const elapsedMs = Date.now() - startedAt;
      const pid = Number(await readFile(pidFile, 'utf8'));

      assert.equal(result.enabled, true);
      assert.equal(result.plugin_count, 1);
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].ok, false);
      assert.equal(result.results[0].status, 'timeout');
      assert.ok(elapsedMs < 1500, `dispatch should timeout promptly (elapsed=${elapsedMs}ms)`);
      await waitForProcessExit(pid);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('dedupes repeated native lifecycle hook dispatches for the same session/turn fingerprint', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-dedupe-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'omx-dispatch-dedupe-root-'));
    try {
      const dir = join(cwd, '.omx', 'hooks');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'good.mjs'),
        'export async function onHookEvent(event, sdk) { const count = Number((await sdk.state.read("count", 0)) || 0); await sdk.state.write("count", count + 1); }',
      );

      const event = buildHookEvent('keyword-detector', {
        source: 'native',
        session_id: 'sess-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        context: { phase: 'prompt-submitted', marker: 'same-turn' },
      });

      const first = await dispatchHookEvent(event, {
        cwd,
        stateRoot,
        env: { ...process.env, OMX_HOOK_PLUGINS: '1' },
      });
      const second = await dispatchHookEvent(event, {
        cwd,
        stateRoot,
        env: { ...process.env, OMX_HOOK_PLUGINS: '1' },
      });

      assert.equal(first.enabled, true);
      assert.equal(first.results.length, 1);
      assert.equal(first.results[0].ok, true);

      assert.equal(second.enabled, true);
      assert.equal(second.reason, 'deduped');
      assert.equal(second.results.length, 0);
      assert.equal(existsSync(join(stateRoot, 'sessions', 'sess-1', 'lifecycle-notif-state.json')), true);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'sessions', 'sess-1', 'lifecycle-notif-state.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
