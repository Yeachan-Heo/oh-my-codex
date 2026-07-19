import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DEAD_PID = 2_147_483_647;
const TOKEN = 'dead_lock_token_123456789';

function runOmx(cwd: string, argv: string[]) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  return spawnSync(process.execPath, [join(repoRoot, 'dist', 'cli', 'omx.js'), ...argv], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      OMX_ROOT: '',
      OMX_STATE_ROOT: '',
      OMX_TEAM_STATE_ROOT: '',
    },
  });
}

function validOwner(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    token: TOKEN,
    pid: DEAD_PID,
    platform: process.platform,
    created_at: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
}

async function prepareState(cwd: string): Promise<{ pointerPath: string; lockPath: string; pointerRaw: string }> {
  const stateDir = join(cwd, '.omx', 'state');
  const pointerPath = join(stateDir, 'session.json');
  const lockPath = `${pointerPath}.lock`;
  const pointerRaw = '{"session_id":"preserved-session"}\n';
  await mkdir(lockPath, { recursive: true });
  await writeFile(pointerPath, pointerRaw, 'utf8');
  return { pointerPath, lockPath, pointerRaw };
}

describe('omx session lock CLI', () => {
  it('keeps top-level and lock help reachable while an ambiguous lock blocks launch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-help-'));
    try {
      await prepareState(cwd);
      for (const argv of [['--help'], ['session', 'lock', '--help'], ['session', 'lock', 'inspect', '--help']]) {
        const result = runOmx(cwd, argv);
        assert.equal(result.status, 0, result.stderr || result.stdout);
      }
      assert.match(runOmx(cwd, ['session', 'lock', '--help']).stdout, /There is no force mode/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('inspects and idempotently recovers a definitely dead token-consistent temporary owner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recover-'));
    try {
      const fixture = await prepareState(cwd);
      await writeFile(join(fixture.lockPath, `owner.${TOKEN}.tmp`), JSON.stringify(validOwner()), 'utf8');

      const inspected = runOmx(cwd, ['session', 'lock', 'inspect', '--json']);
      assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
      const inspection = JSON.parse(inspected.stdout) as Record<string, unknown>;
      assert.equal(inspection.status, 'dead');
      assert.equal(inspection.evidenceSource, 'temporary');
      assert.equal(inspection.safeToRecover, true);

      const recovered = runOmx(cwd, ['session', 'lock', 'recover', '--json']);
      assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
      const recovery = JSON.parse(recovered.stdout) as Record<string, unknown>;
      assert.equal(recovery.action, 'quarantined');
      assert.equal(recovery.recovered, true);
      assert.equal(existsSync(fixture.lockPath), false);
      const quarantinePath = String(recovery.quarantinePath);
      assert.equal(existsSync(quarantinePath), true);
      assert.deepEqual(await readdir(quarantinePath), [`owner.${TOKEN}.tmp`]);
      assert.equal(await readFile(fixture.pointerPath, 'utf8'), fixture.pointerRaw);

      const repeated = runOmx(cwd, ['session', 'lock', 'recover', '--json']);
      assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
      const repeatResult = JSON.parse(repeated.stdout) as Record<string, unknown>;
      assert.equal(repeatResult.action, 'absent');
      assert.equal(repeatResult.recovered, false);
      assert.equal(await readFile(fixture.pointerPath, 'utf8'), fixture.pointerRaw);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reports ambiguous evidence without mutating the lock or session pointer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-ambiguous-'));
    try {
      const fixture = await prepareState(cwd);
      await writeFile(join(fixture.lockPath, 'unexpected.txt'), 'preserve me', 'utf8');
      const beforeEntries = await readdir(fixture.lockPath);

      const inspected = runOmx(cwd, ['session', 'lock', 'inspect', '--cwd', cwd, '--json']);
      assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
      assert.equal((JSON.parse(inspected.stdout) as { status: string }).status, 'ambiguous');

      const recovered = runOmx(cwd, ['session', 'lock', 'recover', `--cwd=${cwd}`, '--json']);
      assert.equal(recovered.status, 2, recovered.stderr || recovered.stdout);
      const recovery = JSON.parse(recovered.stdout) as Record<string, unknown>;
      assert.equal(recovery.action, 'blocked');
      assert.equal(recovery.recovered, false);
      assert.equal(recovery.reasonCode, 'lock_not_definitely_dead');
      assert.match(String(recovery.reason), /safe recovery requires a definitely dead owner/);
      assert.match(JSON.stringify(recovery.nextSteps), /Evidence was preserved/);
      assert.match(JSON.stringify(recovery.nextSteps), /No force recovery is available/);
      assert.match(JSON.stringify(recovery.nextSteps), /session lock inspect/);

      const human = runOmx(cwd, ['session', 'lock', 'recover', '--cwd', cwd]);
      assert.equal(human.status, 2, human.stderr || human.stdout);
      assert.match(human.stdout, /reason: Lock evidence is ambiguous/);
      assert.match(human.stdout, /next: Inspect the resolved lock path/);
      assert.match(human.stdout, /Evidence was preserved\. No force recovery is available/);
      assert.deepEqual(await readdir(fixture.lockPath), beforeEntries);
      assert.equal(await readFile(join(fixture.lockPath, 'unexpected.txt'), 'utf8'), 'preserve me');
      assert.equal(await readFile(fixture.pointerPath, 'utf8'), fixture.pointerRaw);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
