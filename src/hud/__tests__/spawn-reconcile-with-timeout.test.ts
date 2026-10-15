import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnReconcileWithTimeout } from '../spawn-reconcile-with-timeout.js';

test('spawnReconcileWithTimeout passes reconcile authority to the child', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'omx-hud-reconcile-success-'));
  try {
    const entry = join(testDir, 'reconcile.mjs');
    const reportPath = join(testDir, 'report.json');
    await writeFile(entry, [
      "import { writeFileSync } from 'node:fs';",
      'writeFileSync(process.env.OMX_TEST_REPORT, JSON.stringify({ args: process.argv.slice(2), repair: process.env.OMX_HUD_WATCH_REPAIR, pane: process.env.TMUX_PANE, leaderPid: process.env.OMX_HUD_WATCH_LEADER_PID }));',
    ].join('\n'));

    const completed = await spawnReconcileWithTimeout({
      omxBinary: entry,
      cwd: testDir,
      env: { ...process.env, OMX_TEST_REPORT: reportPath },
      timeoutMs: 5_000,
      leaderPaneId: '%1',
      leaderPanePid: '101',
      keepAlive: true,
    });

    assert.equal(completed, true);
    assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), {
      args: ['hud', '--reconcile-tmux'],
      repair: '1',
      pane: '%1',
      leaderPid: '101',
    });
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test('spawnReconcileWithTimeout kills a hung child and its process tree', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'omx-hud-reconcile-timeout-'));
  const childPidPath = join(testDir, 'child.pid');
  const grandchildPidPath = join(testDir, 'grandchild.pid');
  const markerPath = join(testDir, 'grandchild-survived');

  try {
    const entry = join(testDir, 'hung-reconcile.mjs');
    await writeFile(entry, [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      'writeFileSync(process.env.OMX_TEST_CHILD_PID, String(process.pid));',
      `const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").writeFileSync(process.env.OMX_TEST_MARKER, "alive"), 1200); setInterval(() => {}, 1000);'], { stdio: 'ignore', env: process.env });`,
      'writeFileSync(process.env.OMX_TEST_GRANDCHILD_PID, String(grandchild.pid));',
      'setInterval(() => {}, 1000);',
    ].join('\n'));

    const startedAt = Date.now();
    const completed = await spawnReconcileWithTimeout({
      omxBinary: entry,
      cwd: testDir,
      env: {
        ...process.env,
        OMX_TEST_CHILD_PID: childPidPath,
        OMX_TEST_GRANDCHILD_PID: grandchildPidPath,
        OMX_TEST_MARKER: markerPath,
      },
      timeoutMs: 500,
      keepAlive: true,
    });

    assert.equal(completed, false);
    assert.ok(Date.now() - startedAt < 7_000, 'the hung reconcile is bounded');
    assert.ok((await readFile(childPidPath, 'utf8')).trim().length > 0, 'reconcile child started');
    assert.ok((await readFile(grandchildPidPath, 'utf8')).trim().length > 0, 'reconcile grandchild started');
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    await assert.rejects(readFile(markerPath), { code: 'ENOENT' }, 'the grandchild was killed with the reconcile child');
  } finally {
    for (const pidPath of [childPidPath, grandchildPidPath]) {
      const pid = Number(await readFile(pidPath, 'utf8').catch(() => ''));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The timeout may already have killed the process.
        }
      }
    }
    await rm(testDir, { recursive: true, force: true });
  }
});

test('spawnReconcileWithTimeout kills its detached child when the wrapper receives SIGTERM', async () => {
  if (process.platform === 'win32') return;

  const testDir = await mkdtemp(join(tmpdir(), 'omx-hud-reconcile-sigterm-'));
  const entry = join(testDir, 'hung-reconcile.mjs');
  const wrapper = join(testDir, 'reconcile-wrapper.mjs');
  const childPidPath = join(testDir, 'child.pid');
  const markerPath = join(testDir, 'child-survived');
  let wrapperProcess: ReturnType<typeof spawn> | undefined;
  let childPid = 0;

  try {
    await writeFile(entry, [
      "import { writeFileSync } from 'node:fs';",
      'writeFileSync(process.env.OMX_TEST_CHILD_PID, String(process.pid));',
      'setTimeout(() => writeFileSync(process.env.OMX_TEST_MARKER, "alive"), 1_500);',
      'setInterval(() => {}, 1_000);',
    ].join('\n'));
    await writeFile(wrapper, [
      `import { spawnReconcileWithTimeout } from '${new URL('../spawn-reconcile-with-timeout.js', import.meta.url).href}';`,
      'await spawnReconcileWithTimeout({',
      '  omxBinary: process.env.OMX_TEST_ENTRY,',
      '  cwd: process.env.OMX_TEST_DIR,',
      '  env: process.env,',
      '  timeoutMs: 5_000,',
      '  keepAlive: true,',
      '});',
    ].join('\n'));

    const childWrapper = spawn(process.execPath, [wrapper], {
      cwd: testDir,
      env: {
        ...process.env,
        OMX_TEST_ENTRY: entry,
        OMX_TEST_DIR: testDir,
        OMX_TEST_CHILD_PID: childPidPath,
        OMX_TEST_MARKER: markerPath,
      },
      stdio: 'ignore',
    });
    wrapperProcess = childWrapper;

    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && childPid === 0) {
      const pid = await readFile(childPidPath, 'utf8').catch(() => '');
      childPid = Number(pid.trim()) || 0;
      if (childPid === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(childPid > 0, 'the detached reconcile child started');

    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      childWrapper.once('error', reject);
      childWrapper.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(childWrapper.kill('SIGTERM'), true);
    const result = await closed;

    assert.equal(result.signal, null);
    assert.equal(result.code, 0);
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    await assert.rejects(readFile(markerPath), { code: 'ENOENT' }, 'the detached child was killed with its wrapper');
  } finally {
    wrapperProcess?.kill('SIGKILL');
    if (childPid > 0) {
      try {
        process.kill(-childPid, 'SIGKILL');
      } catch {
        // The wrapper signal handler may already have killed the reconcile process group.
      }
    }
    await rm(testDir, { recursive: true, force: true });
  }
});

test('spawnReconcileWithTimeout returns false when the reconcile child fails', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'omx-hud-reconcile-error-'));
  try {
    const result = await spawnReconcileWithTimeout({
      omxBinary: join(testDir, 'missing-entry.mjs'),
      cwd: testDir,
      env: process.env,
      timeoutMs: 5_000,
      keepAlive: true,
    });

    assert.equal(result, false);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});
