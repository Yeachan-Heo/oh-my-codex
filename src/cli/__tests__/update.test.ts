import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isNewerVersion,
  maybeCheckAndPromptUpdate,
  shouldCheckForUpdates,
} from '../update.js';

describe('isNewerVersion', () => {
  it('returns true when latest has higher major', () => {
    assert.equal(isNewerVersion('1.0.0', '2.0.0'), true);
  });

  it('returns true when latest has higher minor', () => {
    assert.equal(isNewerVersion('1.0.0', '1.1.0'), true);
  });

  it('returns true when latest has higher patch', () => {
    assert.equal(isNewerVersion('1.0.0', '1.0.1'), true);
  });

  it('returns false when versions are equal', () => {
    assert.equal(isNewerVersion('1.2.3', '1.2.3'), false);
  });

  it('returns false when current is ahead', () => {
    assert.equal(isNewerVersion('2.0.0', '1.9.9'), false);
  });

  it('returns false for invalid current version', () => {
    assert.equal(isNewerVersion('invalid', '1.0.0'), false);
  });

  it('returns false for invalid latest version', () => {
    assert.equal(isNewerVersion('1.0.0', 'invalid'), false);
  });

  it('handles v-prefixed versions', () => {
    assert.equal(isNewerVersion('v1.0.0', 'v1.0.1'), true);
  });

  it('returns false when major is lower even if minor/patch higher', () => {
    assert.equal(isNewerVersion('2.5.5', '1.9.9'), false);
  });
});

describe('shouldCheckForUpdates', () => {
  const INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h

  it('returns true when state is null', () => {
    assert.equal(shouldCheckForUpdates(Date.now(), null), true);
  });

  it('returns true when last_checked_at is missing', () => {
    assert.equal(shouldCheckForUpdates(Date.now(), {} as never), true);
  });

  it('returns true when last_checked_at is invalid', () => {
    assert.equal(shouldCheckForUpdates(Date.now(), { last_checked_at: 'not-a-date' }), true);
  });

  it('returns false when checked within interval', () => {
    const now = Date.now();
    const recentCheck = new Date(now - INTERVAL_MS + 1000).toISOString();
    assert.equal(shouldCheckForUpdates(now, { last_checked_at: recentCheck }), false);
  });

  it('returns true when check is overdue', () => {
    const now = Date.now();
    const oldCheck = new Date(now - INTERVAL_MS - 1000).toISOString();
    assert.equal(shouldCheckForUpdates(now, { last_checked_at: oldCheck }), true);
  });

  it('returns true when exactly at interval boundary', () => {
    const now = Date.now();
    const exactCheck = new Date(now - INTERVAL_MS).toISOString();
    assert.equal(shouldCheckForUpdates(now, { last_checked_at: exactCheck }), true);
  });

  it('respects custom interval', () => {
    const now = Date.now();
    const customInterval = 60 * 1000; // 1 min
    const recentCheck = new Date(now - 30 * 1000).toISOString(); // 30s ago
    assert.equal(shouldCheckForUpdates(now, { last_checked_at: recentCheck }, customInterval), false);
  });
});

describe('maybeCheckAndPromptUpdate', () => {
  async function withInteractiveTty(run: () => Promise<void>): Promise<void> {
    const originalStdinTty = process.stdin.isTTY;
    const originalStdoutTty = process.stdout.isTTY;

    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });

    try {
      await run();
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: originalStdinTty,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: originalStdoutTty,
      });
    }
  }

  it('runs setup refresh after a successful auto-update', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-'));
    const originalLog = console.log;
    const prompts: string[] = [];
    const setupCalls: Array<{ force?: boolean }> = [];
    console.log = (...args: unknown[]) => {
      prompts.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      await withInteractiveTty(async () => {
        await maybeCheckAndPromptUpdate(cwd, {
          getCurrentVersion: async () => '0.8.9',
          fetchLatestVersion: async () => '0.9.0',
          askYesNo: async () => true,
          runGlobalUpdate: () => ({ ok: true, stderr: '' }),
          setup: async (options) => {
            setupCalls.push(options ?? {});
          },
        });
      });

      assert.deepEqual(setupCalls, [{ force: true }]);
      assert.match(prompts.join('\n'), /Updated to v0\.9\.0/);
    } finally {
      console.log = originalLog;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not update or refresh setup when the prompt is declined', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-'));
    let updateAttempts = 0;
    let setupCalls = 0;

    try {
      await withInteractiveTty(async () => {
        await maybeCheckAndPromptUpdate(cwd, {
          getCurrentVersion: async () => '0.8.9',
          fetchLatestVersion: async () => '0.9.0',
          askYesNo: async () => false,
          runGlobalUpdate: () => {
            updateAttempts += 1;
            return { ok: true, stderr: '' };
          },
          setup: async () => {
            setupCalls += 1;
          },
        });
      });

      assert.equal(updateAttempts, 0);
      assert.equal(setupCalls, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not refresh setup when the global update fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-'));
    const originalLog = console.log;
    const logs: string[] = [];
    let setupCalls = 0;

    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      await withInteractiveTty(async () => {
        await maybeCheckAndPromptUpdate(cwd, {
          getCurrentVersion: async () => '0.8.9',
          fetchLatestVersion: async () => '0.9.0',
          askYesNo: async () => true,
          runGlobalUpdate: () => ({ ok: false, stderr: 'npm exited 1' }),
          setup: async () => {
            setupCalls += 1;
          },
        });
      });

      assert.equal(setupCalls, 0);
      assert.match(logs.join('\n'), /Update failed\. Run manually: npm install -g oh-my-codex@latest/);
    } finally {
      console.log = originalLog;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('skips the update flow when the fetched version is not newer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-update-'));
    let promptCalls = 0;
    let updateAttempts = 0;

    try {
      await withInteractiveTty(async () => {
        await maybeCheckAndPromptUpdate(cwd, {
          getCurrentVersion: async () => '0.8.9',
          fetchLatestVersion: async () => '0.8.9',
          askYesNo: async () => {
            promptCalls += 1;
            return true;
          },
          runGlobalUpdate: () => {
            updateAttempts += 1;
            return { ok: true, stderr: '' };
          },
          setup: async () => {
            throw new Error('setup should not run when already up to date');
          },
        });
      });

      assert.equal(promptCalls, 0);
      assert.equal(updateAttempts, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
