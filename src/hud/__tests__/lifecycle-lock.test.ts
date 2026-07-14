import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  acquireHudLifecycleLock,
  releaseHudLifecycleLock,
  type HudLifecycleLockOwner,
} from '../lifecycle-lock.js';

const DOMAIN = 'hud-control-plane:test';
const NOW = 10_000;

async function fixture(): Promise<{ root: string; lockPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'omx-hud-lifecycle-lock-'));
  return { root, lockPath: join(root, 'hud.lock') };
}

function owner(overrides: Partial<HudLifecycleLockOwner> = {}): HudLifecycleLockOwner {
  return {
    version: 1,
    token: 'old-token',
    generation: 'old-generation',
    domainKey: DOMAIN,
    pid: 4242,
    platform: process.platform,
    processStartIdentity: 'linux:old',
    acquiredAt: new Date(0).toISOString(),
    ...overrides,
  };
}

async function writeOwner(lockPath: string, value: unknown): Promise<void> {
  await mkdir(lockPath);
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify(value));
}

const freshDeps = {
  nowMs: () => NOW,
  token: () => 'new-token',
  generation: () => 'new-generation',
  processStartIdentity: async () => 'linux:new',
};

describe('HUD lifecycle lock', () => {
  it('acquires a fresh lock and safely releases only its token and generation', async () => {
    const { root, lockPath } = await fixture();
    try {
      const result = await acquireHudLifecycleLock({ path: lockPath, domainKey: DOMAIN, staleMs: 1_000 }, freshDeps);
      assert.equal(result.status, 'acquired');
      assert.ok(result.lock);
      await releaseHudLifecycleLock(result.lock!);
      assert.equal(existsSync(lockPath), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves malformed, unprobeable, and PID-reuse-uncertain locks', async () => {
    const { root, lockPath } = await fixture();
    try {
      await writeOwner(lockPath, { malformed: true });
      assert.equal((await acquireHudLifecycleLock({ path: lockPath, domainKey: DOMAIN, staleMs: 1 }, freshDeps)).status, 'locked_uncertain');
      await rm(lockPath, { recursive: true, force: true });
      await writeOwner(lockPath, owner());
      const uncertain = await acquireHudLifecycleLock(
        { path: lockPath, domainKey: DOMAIN, staleMs: 1 },
        { ...freshDeps, probeProcess: async () => 'uncertain' },
      );
      assert.equal(uncertain.status, 'locked_uncertain');
      assert.equal(existsSync(lockPath), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves owners with missing or blank identity as malformed and never quarantines them', async () => {
    const { root, lockPath } = await fixture();
    try {
      const legacyOwner = { ...owner() } as Partial<HudLifecycleLockOwner>;
      delete legacyOwner.processStartIdentity;
      await writeOwner(lockPath, legacyOwner);
      let quarantined = false;
      const result = await acquireHudLifecycleLock(
        { path: lockPath, domainKey: DOMAIN, staleMs: 1_000 },
        {
          ...freshDeps,
          probeProcess: async () => 'dead',
          afterQuarantine: () => { quarantined = true; },
        },
      );
      assert.equal(result.status, 'locked_uncertain');
      assert.equal(quarantined, false);
      assert.equal(existsSync(lockPath), true);
      await rm(lockPath, { recursive: true, force: true });
      await writeOwner(lockPath, { ...owner(), processStartIdentity: '   ' });
      const blankIdentity = await acquireHudLifecycleLock(
        { path: lockPath, domainKey: DOMAIN, staleMs: 1_000 },
        { ...freshDeps, probeProcess: async () => 'dead' },
      );
      assert.equal(blankIdentity.status, 'locked_uncertain');
      assert.equal(existsSync(lockPath), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed before creating a fresh lock when the current identity is unavailable or blank', async () => {
    const { root, lockPath } = await fixture();
    try {
      const result = await acquireHudLifecycleLock(
        { path: lockPath, domainKey: DOMAIN, staleMs: 1_000 },
        {
          ...freshDeps,
          processStartIdentity: async () => undefined,
          token: () => assert.fail('must not create an owner without an identity'),
        },
      );
      assert.equal(result.status, 'failed');
      assert.equal(existsSync(lockPath), false);
      const blankIdentity = await acquireHudLifecycleLock(
        { path: join(root, 'blank.lock'), domainKey: DOMAIN, staleMs: 1_000 },
        { ...freshDeps, processStartIdentity: async () => '   ' },
      );
      assert.equal(blankIdentity.status, 'failed');
      assert.equal(existsSync(join(root, 'blank.lock')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('takes over only a stale owner proven dead or reused', async () => {
    const { root, lockPath } = await fixture();
    try {
      await writeOwner(lockPath, owner());
      const result = await acquireHudLifecycleLock(
        { path: lockPath, domainKey: DOMAIN, staleMs: 1_000 },
        { ...freshDeps, probeProcess: async () => 'reused' },
      );
      assert.equal(result.status, 'acquired');
      const current = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'));
      assert.equal(current.token, 'new-token');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not delete a replacement token during release', async () => {
    const { root, lockPath } = await fixture();
    try {
      const result = await acquireHudLifecycleLock({ path: lockPath, domainKey: DOMAIN, staleMs: 1_000 }, freshDeps);
      assert.ok(result.lock);
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify(owner({ token: 'replacement', generation: 'replacement' })));
      await releaseHudLifecycleLock(result.lock!);
      const current = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'));
      assert.equal(current.token, 'replacement');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not restore a quarantined stale lock over an ABA replacement', async () => {
    const { root, lockPath } = await fixture();
    try {
      await writeOwner(lockPath, owner());
      const result = await acquireHudLifecycleLock(
        { path: lockPath, domainKey: DOMAIN, staleMs: 1_000 },
        {
          ...freshDeps,
          probeProcess: async () => 'reused',
          afterQuarantine: async () => {
            await writeOwner(lockPath, owner({ token: 'replacement', generation: 'replacement' }));
          },
        },
      );
      assert.equal(result.status, 'locked_uncertain');
      const current = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'));
      assert.equal(current.token, 'replacement');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
