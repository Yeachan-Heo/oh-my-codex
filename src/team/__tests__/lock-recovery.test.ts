import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createTask, enqueueDispatchRequest, initTeamState, listTasks } from '../state.js';
import { assertTeamLockNotStale, withMailboxLock, withScalingLock, withTaskClaimLock, withTeamLock } from '../state/locks.js';
import { drainPendingTeamDispatch } from '../../scripts/notify-hook/team-dispatch.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-team-lock-recovery-'));
  roots.push(cwd);
  return cwd;
}

async function staleLock(lockDir: string, token?: string): Promise<void> {
  await mkdir(lockDir, { recursive: true });
  if (token !== undefined) await writeFile(join(lockDir, 'owner'), token);
  await writeFile(join(lockDir, 'lease'), 'abandoned');
  const old = new Date(Date.now() - 10 * 60_000);
  await utimes(join(lockDir, 'lease'), old, old);
  await utimes(lockDir, old, old);
}

describe('team lock recovery safety', () => {
  it('rejects concurrent recovery without changing the lock, tasks, or config', async () => {
    const cwd = await workspace();
    const team = 'audit';
    await initTeamState(team, 'lock regression', 'executor', 1, cwd);
    const teamDir = join(cwd, '.omx/state/team', team);
    const config = await readFile(join(teamDir, 'config.json'), 'utf8');
    const lockDir = join(cwd, '.omx/state/.team-locks', `${team}.membership`);
    await staleLock(lockDir, '99999999.0.dead');
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
      createTask(team, { subject: `task-${index}`, description: 'independent submission', status: 'pending' }, cwd)));
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.match(String(result.reason), /team_lock_recovery_required:/);
    }
    assert.equal(await readFile(join(lockDir, 'owner'), 'utf8'), '99999999.0.dead');
    assert.equal(await readFile(join(lockDir, 'lease'), 'utf8'), 'abandoned');
    assert.equal(await readFile(join(teamDir, 'config.json'), 'utf8'), config);
    // The operator removes only the isolated fixture after all failed callers have exited.
    await rm(lockDir, { recursive: true });
    assert.deepEqual(await listTasks(team, cwd), []);
    for (let round = 0; round < 20; round++) {
      const tasks = await Promise.all(Array.from({ length: 12 }, (_, index) =>
        createTask(team, { subject: `${round}-${index}`, description: 'normal concurrent submission', status: 'pending' }, cwd)));
      assert.equal(new Set(tasks.map((task) => task.id)).size, 12);
    }
    const persisted = await listTasks(team, cwd);
    assert.equal(persisted.length, 240);
    assert.equal(new Set(persisted.map((task) => task.subject)).size, 240);
  });

  it('never treats an old lease or an unknown owner as deletion authority', async () => {
    const cwd = await workspace();
    for (const [name, token] of [['live', `${process.pid}.0.live`], ['unknown', 'unrecognized-owner'], ['empty', undefined]] as const) {
      const lockDir = join(cwd, name);
      await staleLock(lockDir, token);
      if (name === 'live') await assertTeamLockNotStale(lockDir, 1);
      else await assert.rejects(() => assertTeamLockNotStale(lockDir, 1), /team_lock_recovery_required:/);
      assert.equal(await readFile(join(lockDir, 'lease'), 'utf8'), 'abandoned');
      if (token !== undefined) assert.equal(await readFile(join(lockDir, 'owner'), 'utf8'), token);
    }
    const initializer = join(cwd, 'empty-initializer');
    await mkdir(initializer);
    await assertTeamLockNotStale(initializer, 60_000);
    assert.deepEqual(await readdir(initializer), []);
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(initializer, old, old);
    await assert.rejects(() => assertTeamLockNotStale(initializer, 1), /team_lock_recovery_required:/);
    assert.deepEqual(await readdir(initializer), []);
  });

  it('protects every shared team lock wrapper against stale deletion', async () => {
    const cwd = await workspace();
    const root = join(cwd, '.omx/state/team/audit');
    const deps = {
      teamDir: () => root,
      taskClaimLockDir: () => join(root, 'claims/task-1.lock'),
      mailboxLockDir: () => join(root, 'mailbox/.lock-worker-1'),
    };
    for (const [lockDir, acquire] of [
      [join(cwd, '.omx/state/.team-locks/audit.scaling'), (fn: () => Promise<void>) => withScalingLock('audit', cwd, 1, deps, fn)],
      [join(cwd, '.omx/state/.team-locks/audit.membership'), (fn: () => Promise<void>) => withTeamLock('audit', cwd, 1, deps, fn)],
      [deps.taskClaimLockDir(), (fn: () => Promise<void>) => withTaskClaimLock('audit', '1', cwd, 1, deps, fn)],
      [deps.mailboxLockDir(), (fn: () => Promise<void>) => withMailboxLock('audit', 'worker-1', cwd, 1, deps, fn)],
    ] as const) {
      await staleLock(lockDir, '99999999.0.dead');
      await assert.rejects(() => acquire(async () => { assert.fail('stale lock must not enter'); }), /team_lock_recovery_required:/);
      assert.equal(await readFile(join(lockDir, 'owner'), 'utf8'), '99999999.0.dead');
    }
  });

  it('retries when an owner releases and exits after its token was read', async () => {
    const cwd = await workspace();
    const lockModule = new URL('../state/locks.js', import.meta.url).href;
    const owner = spawn(process.execPath, ['--input-type=module', '-e', `
      import { withTeamLock } from ${JSON.stringify(lockModule)};
      import { once } from 'node:events';
      await withTeamLock('audit', ${JSON.stringify(cwd)}, 60_000,
        { teamDir: () => ${JSON.stringify(join(cwd, '.omx/state/team/audit'))} }, async () => {
          process.send('locked');
          await once(process, 'message');
        });
      process.disconnect();
    `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let contender: ReturnType<typeof spawn> | undefined;
    const signal = AbortSignal.timeout(10_000);
    try {
      await once(owner, 'message', { signal });
      contender = spawn(process.execPath, ['--input-type=module', '-e', `
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        import { once } from 'node:events';
        const readFile = fs.readFile;
        let delayed = false;
        fs.readFile = async (...args) => {
          const token = await readFile(...args);
          if (!delayed && String(args[0]) === ${JSON.stringify(join(cwd, '.omx/state/.team-locks/audit.membership/owner'))}) {
            delayed = true;
            process.send('owner-read');
            await once(process, 'message');
          }
          return token;
        };
        syncBuiltinESMExports();
        const { withTeamLock } = await import(${JSON.stringify(lockModule)});
        await withTeamLock('audit', ${JSON.stringify(cwd)}, 60_000,
          { teamDir: () => ${JSON.stringify(join(cwd, '.omx/state/team/audit'))} }, async () => {});
        process.disconnect();
      `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let stderr = '';
      contender.stderr?.on('data', (data) => { stderr += String(data); });
      const contenderExit = once(contender, 'exit', { signal });
      await once(contender, 'message', { signal });
      const ownerExit = once(owner, 'exit', { signal });
      owner.send('release');
      assert.deepEqual(await ownerExit, [0, null]);
      contender.send('continue');
      assert.deepEqual(await contenderExit, [0, null], stderr);
    } finally {
      for (const child of [owner, contender]) {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
  });

  it('rechecks owner initialization and directory replacement before requiring recovery', async () => {
    const cwd = await workspace();
    const lockModule = new URL('../state/locks.js', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import { join } from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      const stat = fs.stat;
      const lockDir = ${JSON.stringify(join(cwd, 'lock'))};
      const { assertTeamLockNotStale } = await import(${JSON.stringify(lockModule)});
      for (const mode of ['initialize', 'replace']) {
        await fs.mkdir(lockDir);
        if (mode === 'replace') await fs.writeFile(join(lockDir, 'owner'), 'unrecognized-owner');
        await fs.writeFile(join(lockDir, 'lease'), 'old');
        const old = new Date(Date.now() - 600_000);
        await fs.utimes(join(lockDir, 'lease'), old, old);
        let changed = false;
        fs.stat = async (...args) => {
          const info = await stat(...args);
          if (!changed && String(args[0]) === join(lockDir, 'lease')) {
            changed = true;
            if (mode === 'replace') {
              await fs.rename(lockDir, lockDir + '.old');
              await fs.mkdir(lockDir);
              await fs.writeFile(join(lockDir, 'owner'), 'unrecognized-owner');
            } else {
              await fs.writeFile(join(lockDir, 'owner'), process.pid + '.0.initialized');
            }
          }
          return info;
        };
        syncBuiltinESMExports();
        await assertTeamLockNotStale(lockDir, 1);
        assert.equal(changed, true);
        assert.equal(await fs.readFile(join(lockDir, 'owner'), 'utf8'),
          mode === 'replace' ? 'unrecognized-owner' : process.pid + '.0.initialized');
        fs.stat = stat;
        syncBuiltinESMExports();
        await fs.rm(lockDir, { recursive: true });
      }
    `], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (data) => { stderr += String(data); });
    try { assert.deepEqual(await once(child, 'exit', { signal: AbortSignal.timeout(10_000) }), [0, null], stderr); }
    finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });

  it('preserves a SIGKILLed owner lock and gives a recovery diagnostic', async () => {
    const cwd = await workspace();
    const lockModule = new URL('../state/locks.js', import.meta.url).href;
    const entered = join(cwd, 'entered');
    const code = `import { withTeamLock } from ${JSON.stringify(lockModule)};
      import {writeFile} from 'node:fs/promises';
      const root=${JSON.stringify(cwd)};
      await withTeamLock('audit',root,1,{teamDir:()=>root+'/.omx/state/team/audit'},async()=>{
        await writeFile(${JSON.stringify(entered)},'entered');setInterval(()=>{},1000);await new Promise(()=>{});
      });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
    try {
      for (let attempt = 0; ; attempt++) {
        if (await readFile(entered, 'utf8').catch(() => '') === 'entered') break;
        assert.ok(attempt < 200, 'child must acquire the real lock');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const lockDir = join(cwd, '.omx/state/.team-locks/audit.membership');
      const owner = await readFile(join(lockDir, 'owner'), 'utf8');
      await assert.rejects(() => assertTeamLockNotStale(lockDir, 1), /team_lock_recovery_required:/);
      assert.equal(await readFile(join(lockDir, 'owner'), 'utf8'), owner);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });

  it('preserves the same stale dispatch lock from both the API and the hook', async () => {
    const cwd = await workspace();
    await initTeamState('audit', 'shared dispatch lock', 'executor', 1, cwd);
    const stateDir = join(cwd, '.omx/state');
    const dispatchDir = join(stateDir, 'team/audit/dispatch');
    const before = await readFile(join(dispatchDir, 'requests.json'), 'utf8');
    const lockDir = join(dispatchDir, '.lock');
    await staleLock(lockDir, '99999999.0.dead');
    await assert.rejects(() => enqueueDispatchRequest('audit', { kind: 'inbox', to_worker: 'worker-1', trigger_message: 'ping' }, cwd), /team_lock_recovery_required:/);
    const logsDir = join(cwd, '.omx/logs');
    const drained = await drainPendingTeamDispatch({ cwd, stateDir, logsDir, injector: async () => { assert.fail('stale dispatch lock must not inject'); } });
    assert.deepEqual(drained, { processed: 0, skipped: 0, failed: 1 });
    const log = (await readdir(logsDir)).find((name) => name.startsWith('team-dispatch-'));
    assert.ok(log, 'the hook reports the abandoned lock');
    assert.match(await readFile(join(logsDir, log), 'utf8'), /"type":"dispatch_lock_recovery_required","team":"audit","reason":"team_lock_recovery_required:/);
    assert.equal(await readFile(join(dispatchDir, 'requests.json'), 'utf8'), before);
    assert.equal(await readFile(join(lockDir, 'owner'), 'utf8'), '99999999.0.dead');
  });

  it('keeps draining other teams when one team needs dispatch lock recovery', async () => {
    const cwd = await workspace();
    await initTeamState('audit', 'abandoned dispatch lock', 'executor', 1, cwd);
    await initTeamState('zeta', 'healthy team', 'executor', 1, cwd);
    const stateDir = join(cwd, '.omx/state');
    const healthy = await enqueueDispatchRequest('zeta', { kind: 'inbox', to_worker: 'worker-1', trigger_message: 'ping' }, cwd);
    const lockDir = join(stateDir, 'team/audit/dispatch/.lock');
    await staleLock(lockDir, '99999999.0.dead');
    const injected: string[] = [];
    const drained = await drainPendingTeamDispatch({
      cwd,
      stateDir,
      logsDir: join(cwd, '.omx/logs'),
      injector: async (request) => {
        injected.push(String(request.request_id));
        return { ok: true, reason: 'injected_for_test' };
      },
    });
    assert.deepEqual(injected, [healthy.request.request_id]);
    assert.equal(drained.processed, 1);
    assert.equal(drained.failed, 1);
    assert.equal(await readFile(join(lockDir, 'owner'), 'utf8'), '99999999.0.dead');
  });

  it('serializes independent processes creating tasks through the public API', async () => {
    const cwd = await workspace();
    await initTeamState('audit', 'cross-process lock regression', 'executor', 1, cwd);
    const stateModule = new URL('../state.js', import.meta.url).href;
    const children = Array.from({ length: 12 }, (_, index) => spawn(process.execPath, ['--input-type=module', '-e',
      `import{createTask}from ${JSON.stringify(stateModule)};await createTask('audit',{subject:'process-${index}',description:'independent process',status:'pending'},${JSON.stringify(cwd)});`], { stdio: ['ignore', 'ignore', 'pipe'] }));
    try {
      await Promise.all(children.map(async (child) => {
        let stderr = '';
        child.stderr?.on('data', (data) => { stderr += String(data); });
        const [code, signal] = await once(child, 'exit');
        assert.equal(code, 0, stderr);
        assert.equal(signal, null);
      }));
      const tasks = await listTasks('audit', cwd);
      assert.equal(tasks.length, 12);
      assert.equal(new Set(tasks.map((task) => task.id)).size, 12);
      assert.equal(new Set(tasks.map((task) => task.subject)).size, 12);
    } finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });
});
