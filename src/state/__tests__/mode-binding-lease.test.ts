import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMode } from '../../modes/base.js';
import { __setStateOperationTestHooksForTests, executeStateOperation, withStateFileWriteTransaction, writeStateFile } from '../operations.js';
import { __setCanonicalModeBindingLeaseTestHooksForTests, resolveValidatedCanonicalModeBinding } from '../mode-binding-lease.js';
import { JsonChildClient } from '../pinned-atomic-file-darwin-client.js';
import {
  formatProcessOwnerToken,
  hashHistoricalProcessStartIdentity,
  parseProcessOwnerToken,
  readHistoricalProcessStartIdentity,
  readProcessStartIdentity,
} from '../process-identity.js';

const roots: string[] = [];
const operationsModuleUrl = new URL('../operations.js', import.meta.url).href;

async function runTransactionProcess(path: string, options: { ready?: string; release?: string; entered?: string } = {}): Promise<void> {
  const source = [
    `import { stat, writeFile } from 'node:fs/promises';`,
    `import { withStateFileWriteTransaction } from ${JSON.stringify(operationsModuleUrl)};`,
    'const ready = process.env.READY_FILE; const release = process.env.RELEASE_FILE; const entered = process.env.ENTERED_FILE;',
    'await withStateFileWriteTransaction(process.argv[1], async () => {',
    '  if (ready) await writeFile(ready, "ready");',
    '  if (release) { for (;;) { try { await stat(release); break; } catch (error) { if (error.code !== "ENOENT") throw error; await new Promise(resolve => setTimeout(resolve, 5)); } } }',
    '  if (entered) await writeFile(entered, "entered");',
    '});',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source, path], {
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    env: { ...process.env, ...(options.ready ? { READY_FILE: options.ready } : {}), ...(options.release ? { RELEASE_FILE: options.release } : {}), ...(options.entered ? { ENTERED_FILE: options.entered } : {}) },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
}

afterEach(async () => {
  __setStateOperationTestHooksForTests({});
  __setCanonicalModeBindingLeaseTestHooksForTests({});
  delete process.env.OMX_TEST_MODE_BINDING_RECLAIM_CRASH_PHASE;
  delete process.env.OMX_TEST_MODE_BINDING_RECLAIM_CRASH_SENTINEL;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('canonical mode binding lease', () => {
  it('uses a longer initialization timeout without weakening later request timeouts', async () => {
    const source = [
      "process.stdin.resume();",
      "setTimeout(() => process.stdout.write(JSON.stringify({ id: 0, ok: true, ready: true }) + '\\n'), 60);",
    ].join('\n');
    const child = spawn(process.execPath, ['--eval', source], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const client = new JsonChildClient(child, 'timeout-scope-test');
    await client.initialize({ timeoutMs: 250 });
    const started = Date.now();
    await assert.rejects(client.request({ op: 'ignored' }, { timeoutMs: 40 }), /request timed out/);
    assert.ok(Date.now() - started < 500);
    await client.close();
  });

  it('clean release is ownerless and the next acquire does not depend on the prior PID', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-clean-release-'));
    roots.push(cwd);
    const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    await withStateFileWriteTransaction(path, async () => undefined);
    const lockPath = (await resolveValidatedCanonicalModeBinding(path)).leasePath;
    assert.deepEqual(await readdir(lockPath), []);

    let ran = false;
    await withStateFileWriteTransaction(path, async () => { ran = true; });

    assert.equal(ran, true);
    assert.deepEqual(await readdir(lockPath), []);
  });

  it('does not steal a valid owner whose foreign PID is still live', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-live-foreign-owner-'));
    roots.push(cwd);
    const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    await withStateFileWriteTransaction(path, async () => undefined);
    const lockPath = (await resolveValidatedCanonicalModeBinding(path)).leasePath;
    const liveToken = `${process.pid}-${Date.now()}-${'9'.repeat(24)}`;
    const liveOwner = join(lockPath, `owner-${liveToken}`);
    await writeFile(liveOwner, liveToken);
    let ran = false;
    const contender = withStateFileWriteTransaction(path, async () => { ran = true; });

    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 150));
    assert.equal(ran, false);
    assert.equal(await readFile(liveOwner, 'utf8'), liveToken);
    await unlink(liveOwner);
    await contender;

    assert.equal(ran, true);
    assert.deepEqual(await readdir(lockPath), []);
  });

  for (const kind of ['malformed', 'partial', 'symlink', 'foreign-entry'] as const) {
    it(`rejects ${kind} extra-owner ambiguity beside its own valid owner`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), `omx-mode-extra-owner-${kind}-`));
      roots.push(cwd);
      const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
      const lockPath = (await resolveValidatedCanonicalModeBinding(path)).leasePath;
      const extraToken = `${process.pid}-${Date.now()}-${'9'.repeat(24)}`;
      const extraPath = join(lockPath, `owner-${extraToken}`);
      const external = join(cwd, 'external-extra-owner');
      await assert.rejects(withStateFileWriteTransaction(path, async () => {
        if (kind === 'symlink') {
          await writeFile(external, extraToken);
          await symlink(external, extraPath);
        } else {
          await writeFile(extraPath, kind === 'malformed' ? 'tampered' : kind === 'partial' ? extraToken.slice(0, 8) : extraToken);
        }
        if (kind === 'foreign-entry') await writeFile(join(lockPath, 'foreign'), 'preserve');
      }), /lock ownership lost|ambiguous|ELOOP/);
      if (kind === 'symlink') assert.equal(await readFile(external, 'utf8'), extraToken);
    });
  }

  it('parses legacy owners and emits v3 owners bound to process start identity', async () => {
    const legacy = `${process.pid}-${Date.now()}-${'1'.repeat(24)}`;
    assert.deepEqual(parseProcessOwnerToken(legacy), {
      version: 'legacy', pid: process.pid, issuedAtMs: Number(legacy.split('-')[1]), nonce: '1'.repeat(24),
    });
    const identity = await readProcessStartIdentity(process.pid);
    const token = formatProcessOwnerToken({ pid: process.pid, issuedAtMs: Date.now(), nonce: '2'.repeat(24), processStartIdentity: identity });
    assert.equal(parseProcessOwnerToken(token)?.version, 'v3');
    assert.match(token, /^v3-\d+-\d+-[0-9a-f]{24}-(?:[0-9a-f]{24}|unavailable)$/u);
  });

  for (const ownerCase of ['live', 'reused', 'dead', 'unavailable', 'dead-unavailable'] as const) {
    it(`${ownerCase === 'live' || ownerCase === 'unavailable' ? 'preserves' : 'reclaims'} a v3 ${ownerCase} owner`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), `omx-mode-lease-v3-${ownerCase}-`));
      roots.push(cwd);
      const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
      await withStateFileWriteTransaction(path, async () => undefined);
      const lockPath = (await resolveValidatedCanonicalModeBinding(path)).leasePath;
      const liveIdentity = await readProcessStartIdentity(process.pid);
      const pid = ownerCase === 'dead' || ownerCase === 'dead-unavailable' ? 99_999_999 : process.pid;
      const processStartIdentity = ownerCase === 'reused' ? 'definitely-not-this-process'
        : ownerCase === 'unavailable' || ownerCase === 'dead-unavailable' ? null : liveIdentity;
      const token = formatProcessOwnerToken({
        pid, issuedAtMs: Date.now() - 10_000, nonce: '3'.repeat(24), processStartIdentity,
      });
      const ownerPath = join(lockPath, `owner-${token}`);
      await writeFile(ownerPath, token);
      let ran = false;
      const contender = withStateFileWriteTransaction(path, async () => { ran = true; });
      if (ownerCase === 'live' || ownerCase === 'unavailable') {
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 150));
        assert.equal(ran, false);
        assert.equal(await readFile(ownerPath, 'utf8'), token);
        await unlink(ownerPath);
      }
      await contender;
      assert.equal(ran, true);
      assert.deepEqual(await readdir(lockPath), []);
    });
  }

  for (const ownerCase of ['live', 'reused', 'dead', 'unknown', 'dead-unknown'] as const) {
    it(`${ownerCase === 'live' || ownerCase === 'unknown' ? 'preserves' : 'reclaims'} a persisted historical v2 ${ownerCase} owner`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), `omx-mode-lease-historical-v2-${ownerCase}-`));
      roots.push(cwd);
      const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
      await withStateFileWriteTransaction(path, async () => undefined);
      const lockPath = (await resolveValidatedCanonicalModeBinding(path)).leasePath;
      const pid = ownerCase === 'dead' || ownerCase === 'dead-unknown' ? 99_999_999 : process.pid;
      const historicalIdentity = await readHistoricalProcessStartIdentity(process.pid);
      const hash = ownerCase === 'unknown' || ownerCase === 'dead-unknown' ? 'unknown'
        : ownerCase === 'reused' ? hashHistoricalProcessStartIdentity('different-process-start')
          : ownerCase === 'dead' ? 'a'.repeat(16)
            : historicalIdentity ? hashHistoricalProcessStartIdentity(historicalIdentity) : 'unknown';
      const token = `v2-${pid}-${hash}-${Date.now() - 10_000}-${'4'.repeat(24)}`;
      assert.equal(parseProcessOwnerToken(token)?.version, 'v2');
      const ownerPath = join(lockPath, `owner-${token}`);
      await writeFile(ownerPath, token);
      let ran = false;
      const contender = withStateFileWriteTransaction(path, async () => { ran = true; });
      if (ownerCase === 'live' || ownerCase === 'unknown') {
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 150));
        assert.equal(ran, false);
        assert.equal(await readFile(ownerPath, 'utf8'), token);
        await unlink(ownerPath);
      }
      await contender;
      assert.equal(ran, true);
      assert.deepEqual(await readdir(lockPath), []);
    });
  }

  it('keeps persistent namespace identity evidence out of git worktree status', async () => {
    const ignore = await readFile(join(process.cwd(), '.gitignore'), 'utf8');
    assert.match(ignore, /^\.omx-state-locks\/\s*$/mu);
    assert.match(ignore, /^\.omx-state-locks\.identity\.json\s*$/mu);
  });

  it('supports the authorized arbitrary OMX_TEAM_STATE_ROOT binding surface', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-team-cwd-'));
    const shared = await mkdtemp(join(tmpdir(), 'omx-mode-lease-team-root-'));
    roots.push(cwd, shared);
    const teamRoot = join(shared, 'team-state');
    await mkdir(teamRoot);
    const previous = [process.env.OMX_TEAM_STATE_ROOT, process.env.OMX_ROOT, process.env.OMX_STATE_ROOT];
    try {
      process.env.OMX_TEAM_STATE_ROOT = teamRoot;
      delete process.env.OMX_ROOT;
      delete process.env.OMX_STATE_ROOT;
      await startMode('ralplan', 'team-root', 10, cwd, 'session-a');
      const state = JSON.parse(await readFile(join(teamRoot, 'sessions', 'session-a', 'ralplan-state.json'), 'utf8'));
      assert.equal(state.active, true);
    } finally {
      for (const [key, value] of [['OMX_TEAM_STATE_ROOT', previous[0]], ['OMX_ROOT', previous[1]], ['OMX_STATE_ROOT', previous[2]]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it('derives one structural root/session lease when an authorized root itself contains sessions components', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'omx-mode-lease-structural-root-'));
    roots.push(parent);
    const stateRoot = join(parent, 'sessions', 'outer', 'sessions', 'team-state');
    await mkdir(stateRoot, { recursive: true });
    const rootPath = join(stateRoot, 'ralplan-state.json');
    const sessionPath = join(stateRoot, 'sessions', 'session-a', 'ralplan-state.json');
    const rootBinding = await resolveValidatedCanonicalModeBinding(rootPath, stateRoot);
    const sessionBinding = await resolveValidatedCanonicalModeBinding(sessionPath, stateRoot);
    assert.equal(rootBinding.leasePath, sessionBinding.leasePath);
    let concurrent = 0;
    let maximum = 0;
    const run = (path: string) => withStateFileWriteTransaction(path, async () => {
      concurrent += 1;
      maximum = Math.max(maximum, concurrent);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      concurrent -= 1;
    }, stateRoot);
    await Promise.all([run(rootPath), run(sessionPath)]);
    assert.equal(maximum, 1);
  });

  it('supports authorized OMX_ROOT and OMX_STATE_ROOT boxed roots', async () => {
    for (const selector of ['OMX_ROOT', 'OMX_STATE_ROOT'] as const) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-mode-lease-${selector}-cwd-`));
      const boxed = await mkdtemp(join(tmpdir(), `omx-mode-lease-${selector}-root-`));
      roots.push(cwd, boxed);
      const previous = [process.env.OMX_TEAM_STATE_ROOT, process.env.OMX_ROOT, process.env.OMX_STATE_ROOT];
      try {
        delete process.env.OMX_TEAM_STATE_ROOT;
        delete process.env.OMX_ROOT;
        delete process.env.OMX_STATE_ROOT;
        process.env[selector] = boxed;
        await startMode('ralplan', selector, 10, cwd, 'session-a');
        const state = JSON.parse(await readFile(join(boxed, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json'), 'utf8'));
        assert.equal(state.active, true);
      } finally {
        for (const [key, value] of [['OMX_TEAM_STATE_ROOT', previous[0]], ['OMX_ROOT', previous[1]], ['OMX_STATE_ROOT', previous[2]]] as const) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
      }
    }
  });

  it('serializes symlink aliases under one canonical workspace identity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-alias-'));
    const aliasRoot = await mkdtemp(join(tmpdir(), 'omx-mode-lease-alias-parent-'));
    roots.push(cwd, aliasRoot);
    const alias = join(aliasRoot, 'workspace');
    await symlink(cwd, alias);
    const direct = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    const throughAlias = join(alias, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    let concurrent = 0;
    let maximum = 0;
    const run = (path: string) => withStateFileWriteTransaction(path, async () => {
      concurrent += 1;
      maximum = Math.max(maximum, concurrent);
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      concurrent -= 1;
    });
    await Promise.all([run(direct), run(throughAlias)]);
    assert.equal(maximum, 1);
  });

  it('rejects traversal before creating a lease namespace or running work', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-traversal-'));
    roots.push(cwd);
    const traversal = join(cwd, '.omx', 'state', 'sessions', '..', '..', 'foreign.json');
    let ran = false;
    await assert.rejects(withStateFileWriteTransaction(traversal, async () => { ran = true; }), /canonical \.omx\/state/);
    assert.equal(ran, false);
    assert.equal(existsSync(join(cwd, '.omx-state-locks')), false);
  });

  it('keeps standard sanctioned writers on the legacy local queue on unsupported platforms', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-unsupported-'));
    roots.push(cwd);
    const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    let ran = false;
    __setCanonicalModeBindingLeaseTestHooksForTests({ platform: 'win32' });
    await Promise.race([
      withStateFileWriteTransaction(path, async () => {
        await withStateFileWriteTransaction(path, async () => { ran = true; });
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('nested fallback timed out')), 500)),
    ]);
    assert.equal(ran, true);
    await startMode('team', 'win32 standard', 10, cwd, 'session-a');
    const state = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'sessions', 'session-a', 'team-state.json'), 'utf8'));
    assert.equal(state.active, true);
    assert.equal(existsSync(join(cwd, '.omx-state-locks')), false);
    assert.equal(existsSync(join(cwd, '.omx-state-locks.identity.json')), false);
  });

  it('never reclaims an ambiguous lock owner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-ambiguous-'));
    roots.push(cwd);
    const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    await withStateFileWriteTransaction(path, async () => undefined);
    const lockPath = (await resolveValidatedCanonicalModeBinding(path)).leasePath;
    await writeFile(join(lockPath, 'foreign-metadata'), 'do-not-delete');
    await assert.rejects(withStateFileWriteTransaction(path, async () => undefined), /owner ambiguous/);
    assert.equal(await readFile(join(lockPath, 'foreign-metadata'), 'utf8'), 'do-not-delete');
  });

  it('recovers an old malformed partial owner only after pinning its inode', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-partial-owner-'));
    roots.push(cwd);
    const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    await withStateFileWriteTransaction(path, async () => undefined);
    const lockPath = (await resolveValidatedCanonicalModeBinding(path)).leasePath;
    const deadToken = `99999999-${Date.now() - 10_000}-${'a'.repeat(24)}`;
    const ownerPath = join(lockPath, `owner-${deadToken}`);
    await writeFile(ownerPath, deadToken.slice(0, 12));
    const stale = new Date(Date.now() - 10_000);
    await utimes(ownerPath, stale, stale);

    let ran = false;
    await withStateFileWriteTransaction(path, async () => { ran = true; });

    assert.equal(ran, true);
    assert.deepEqual(await readdir(lockPath), []);
  });

  it('fails closed on old owner bytes that are not a published token prefix', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-tampered-owner-'));
    roots.push(cwd);
    const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    await withStateFileWriteTransaction(path, async () => undefined);
    const lockPath = (await resolveValidatedCanonicalModeBinding(path)).leasePath;
    const deadToken = `99999999-${Date.now() - 10_000}-${'c'.repeat(24)}`;
    const ownerPath = join(lockPath, `owner-${deadToken}`);
    await writeFile(ownerPath, 'tampered');
    const stale = new Date(Date.now() - 10_000);
    await utimes(ownerPath, stale, stale);

    let ran = false;
    await assert.rejects(
      withStateFileWriteTransaction(path, async () => { ran = true; }),
      /owner ambiguous/,
    );
    assert.equal(ran, false);
    assert.equal(await readFile(ownerPath, 'utf8'), 'tampered');
  });

  for (const phase of ['after-quarantine', 'after-successor-publish', 'before-cleanup']) {
    it(`converges without stealing a live successor after SIGKILL ${phase}`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), `omx-mode-lease-reclaim-${phase}-`));
      roots.push(cwd);
      const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
      await withStateFileWriteTransaction(path, async () => undefined);
      const lockPath = (await resolveValidatedCanonicalModeBinding(path)).leasePath;
      const deadToken = `99999999-${Date.now() - 10_000}-${'b'.repeat(24)}`;
      const ownerPath = join(lockPath, `owner-${deadToken}`);
      await writeFile(ownerPath, deadToken.slice(0, 7));
      const stale = new Date(Date.now() - 10_000);
      await utimes(ownerPath, stale, stale);
      const sentinel = join(cwd, `${phase}.sentinel`);
      process.env.OMX_TEST_MODE_BINDING_RECLAIM_CRASH_PHASE = phase;
      process.env.OMX_TEST_MODE_BINDING_RECLAIM_CRASH_SENTINEL = sentinel;

      await withStateFileWriteTransaction(path, async () => {
        const entries = await readdir(lockPath);
        assert.equal(entries.length, 1);
        assert.match(entries[0], /^owner-v3-\d+-\d+-[0-9a-f]{24}-(?:[0-9a-f]{24}|unavailable)$/u);
        const token = entries[0].slice('owner-'.length);
        assert.equal(await readFile(join(lockPath, entries[0]), 'utf8'), token);
        const parsed = parseProcessOwnerToken(token);
        assert.ok(parsed);
        assert.doesNotThrow(() => process.kill(parsed.pid, 0));
      });

      assert.equal(await readFile(sentinel, 'utf8'), phase);
      assert.deepEqual(await readdir(lockPath), []);
    });
  }

  it('converges quarantine-only state across repeated 20, 32, and 64 process stress', async () => {
    for (const count of [20, 32, 64]) {
      for (let round = 0; round < 2; round += 1) {
        const cwd = await mkdtemp(join(tmpdir(), `omx-mode-lease-quarantine-${count}-${round}-`));
        roots.push(cwd);
        const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
        await withStateFileWriteTransaction(path, async () => undefined);
        const lockPath = (await resolveValidatedCanonicalModeBinding(path)).leasePath;
        const deadToken = `99999999-${Date.now() - 10_000}-${'d'.repeat(24)}`;
        const ownerPath = join(lockPath, `owner-${deadToken}`);
        await writeFile(ownerPath, deadToken);
        await rename(ownerPath, join(lockPath, `.owner-reclaim-${deadToken}`));

        await Promise.all(Array.from({ length: count }, () => runTransactionProcess(path)));

        assert.deepEqual(await readdir(lockPath), []);
      }
    }
  });

  it('serializes two parent transactions under the native mutex', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-mutex-race-'));
    roots.push(cwd);
    const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    const ready = join(cwd, 'first-ready');
    const release = join(cwd, 'first-release');
    const entered = join(cwd, 'second-entered');
    const first = runTransactionProcess(path, { ready, release });
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready)) {
      if (Date.now() >= deadline) throw new Error('timed out waiting for first transaction readiness');
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    const lockPath = (await resolveValidatedCanonicalModeBinding(path)).leasePath;
    const second = runTransactionProcess(path, { entered });
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 150));
    assert.equal(existsSync(entered), false);
    const heldOwners = (await readdir(lockPath)).filter((entry) => entry.startsWith('owner-'));
    assert.equal(heldOwners.length, 1);
    await writeFile(release, 'release');
    await Promise.all([first, second]);
    assert.equal(existsSync(entered), true);
    assert.deepEqual(await readdir(lockPath), []);
  });

  it('recovers quarantine plus an aged dead partial successor', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-partial-successor-'));
    roots.push(cwd);
    const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    await withStateFileWriteTransaction(path, async () => undefined);
    const lockPath = (await resolveValidatedCanonicalModeBinding(path)).leasePath;
    const displacedToken = `99999999-${Date.now() - 10_000}-${'e'.repeat(24)}`;
    const successorToken = `99999998-${Date.now() - 10_000}-${'f'.repeat(24)}`;
    await writeFile(join(lockPath, `.owner-reclaim-${displacedToken}`), displacedToken);
    const partialPath = join(lockPath, `owner-${successorToken}`);
    await writeFile(partialPath, successorToken.slice(0, 10));
    const stale = new Date(Date.now() - 10_000);
    await utimes(partialPath, stale, stale);

    await withStateFileWriteTransaction(path, async () => undefined);

    assert.deepEqual(await readdir(lockPath), []);
  });

  it('atomically repairs a partial namespace marker against the pinned namespace identity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-partial-marker-'));
    roots.push(cwd);
    const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    const binding = await resolveValidatedCanonicalModeBinding(path);
    await mkdir(binding.namespacePath);
    const markerPath = `${binding.namespacePath}.identity.json`;
    await writeFile(markerPath, '{"dev":');

    await withStateFileWriteTransaction(path, async () => undefined);

    const namespace = await stat(binding.namespacePath);
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { dev: number; ino: number };
    assert.deepEqual(marker, { dev: namespace.dev, ino: namespace.ino });
  });

  it('fails closed without mutating an arbitrary malformed namespace marker', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-tampered-marker-'));
    roots.push(cwd);
    const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    const binding = await resolveValidatedCanonicalModeBinding(path);
    await mkdir(binding.namespacePath);
    const markerPath = `${binding.namespacePath}.identity.json`;
    const tampered = '{"dev":"not-a-published-partial"';
    await writeFile(markerPath, tampered);

    await assert.rejects(
      withStateFileWriteTransaction(path, async () => undefined),
      /namespace marker malformed/,
    );
    assert.equal(await readFile(markerPath, 'utf8'), tampered);
  });

  it('initializes one canonical namespace marker across twenty processes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-marker-contenders-'));
    roots.push(cwd);
    const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    const binding = await resolveValidatedCanonicalModeBinding(path);

    await Promise.all(Array.from({ length: 20 }, () => runTransactionProcess(path)));

    const namespace = await stat(binding.namespacePath);
    const marker = await readFile(`${binding.namespacePath}.identity.json`, 'utf8');
    assert.equal(marker, `${JSON.stringify({ dev: namespace.dev, ino: namespace.ino })}\n`);
  });

  it('rejects a lock-directory symlink swap without dereferencing or deleting the external owner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-lock-swap-'));
    const external = await mkdtemp(join(tmpdir(), 'omx-mode-lease-lock-external-'));
    roots.push(cwd, external);
    const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    const lockPath = (await resolveValidatedCanonicalModeBinding(path)).leasePath;
    const displaced = `${lockPath}.displaced`;
    await writeFile(join(external, 'owner-external'), 'external');
    await assert.rejects(withStateFileWriteTransaction(path, async () => {
      await rename(lockPath, displaced);
      await symlink(external, lockPath);
    }), /lock ownership lost/);
    assert.equal(await readFile(join(external, 'owner-external'), 'utf8'), 'external');
    assert.equal((await readdir(displaced)).length, 1);
  });

  it('never follows a stale lock symlink while attempting reclaim', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-stale-symlink-'));
    const external = await mkdtemp(join(tmpdir(), 'omx-mode-lease-stale-external-'));
    roots.push(cwd, external);
    const path = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    await withStateFileWriteTransaction(path, async () => undefined);
    const lockPath = (await resolveValidatedCanonicalModeBinding(path)).leasePath;
    await rm(lockPath, { recursive: true, force: true });
    await writeFile(join(external, 'owner-external'), 'external');
    await symlink(external, lockPath);
    let ran = false;
    await assert.rejects(withStateFileWriteTransaction(path, async () => { ran = true; }), /lock invalid/);
    assert.equal(ran, false);
    assert.equal(await readFile(join(external, 'owner-external'), 'utf8'), 'external');
  });

  it('rejects a state-root swap before a nested sanctioned write', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-root-swap-'));
    roots.push(cwd);
    const stateRoot = join(cwd, '.omx', 'state');
    const displaced = join(cwd, '.omx', 'state.displaced');
    const path = join(stateRoot, 'sessions', 'session-a', 'ralplan-state.json');
    await mkdir(join(stateRoot, 'sessions', 'session-a'), { recursive: true });
    await assert.rejects(withStateFileWriteTransaction(path, async () => {
      await rename(stateRoot, displaced);
      await mkdir(join(stateRoot, 'sessions', 'session-a'), { recursive: true });
      await writeStateFile(path, '{}');
    }), /state root identity changed/);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(join(displaced, 'sessions', 'session-a', 'ralplan-state.json')), false);
  });

  it('serializes a new session start until session clear finishes all mirrors', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-clear-'));
    roots.push(cwd);
    await startMode('ralplan', 'old', 10, cwd, 'session-a');
    let successor: Promise<unknown> | undefined;
    __setStateOperationTestHooksForTests({
      afterStateClearPrimary: () => {
        successor ??= startMode('ralplan', 'successor', 10, cwd, 'session-a');
      },
    });
    const cleared = await executeStateOperation('state_clear', {
      workingDirectory: cwd, session_id: 'session-a', mode: 'ralplan',
    });
    assert.equal(cleared.isError, undefined);
    await successor;
    const state = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json'), 'utf8'));
    assert.equal(state.active, true);
    assert.equal(state.task_description, 'successor');
  });

  it('uses the root lease as an umbrella across every session during all-sessions clear', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mode-lease-clear-all-'));
    roots.push(cwd);
    await startMode('ralplan', 'session-a', 10, cwd, 'session-a');
    await startMode('ralplan', 'session-b', 10, cwd, 'session-b');
    let successor: Promise<unknown> | undefined;
    __setStateOperationTestHooksForTests({
      afterStateClearPrimary: () => {
        successor ??= startMode('ralplan', 'session-b-successor', 10, cwd, 'session-b');
      },
    });
    const cleared = await executeStateOperation('state_clear', {
      workingDirectory: cwd, mode: 'ralplan', all_sessions: true,
    });
    assert.equal(cleared.isError, undefined);
    await successor;
    const state = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'sessions', 'session-b', 'ralplan-state.json'), 'utf8'));
    assert.equal(state.active, true);
    assert.equal(state.task_description, 'session-b-successor');
  });
});
