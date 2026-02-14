import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { main } from '../index.js';

async function runMain(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const originalCwd = process.cwd();
  let exitCode = 0;

  console.log = (...parts: unknown[]) => { stdout.push(parts.join(' ')); };
  console.error = (...parts: unknown[]) => { stderr.push(parts.join(' ')); };
  process.exit = ((code?: number) => {
    const normalized = typeof code === 'number' ? code : 0;
    throw new Error(`__TEST_EXIT__${normalized}`);
  }) as typeof process.exit;

  try {
    process.chdir(cwd);
    await main(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('__TEST_EXIT__')) {
      exitCode = Number(msg.replace('__TEST_EXIT__', '')) || 0;
    } else {
      throw err;
    }
  } finally {
    process.chdir(originalCwd);
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }

  return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode };
}

describe('CLI session-scoped state parity', () => {
  it('status and cancel include session-scoped states', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-session-scope-'));
    try {
      const scopedDir = join(wd, '.omx', 'state', 'sessions', 'sess1');
      await mkdir(scopedDir, { recursive: true });
      await writeFile(join(scopedDir, 'team-state.json'), JSON.stringify({
        active: true,
        current_phase: 'execution',
      }));

      const statusResult = await runMain(['status'], wd);
      assert.equal(statusResult.exitCode, 0, statusResult.stderr || statusResult.stdout);
      assert.match(statusResult.stdout, /team: ACTIVE/);

      const cancelResult = await runMain(['cancel'], wd);
      assert.equal(cancelResult.exitCode, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /Cancelled: team/);

      const updated = JSON.parse(await readFile(join(scopedDir, 'team-state.json'), 'utf-8'));
      assert.equal(updated.active, false);
      assert.equal(updated.current_phase, 'cancelled');
      assert.ok(typeof updated.completed_at === 'string' && updated.completed_at.length > 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
