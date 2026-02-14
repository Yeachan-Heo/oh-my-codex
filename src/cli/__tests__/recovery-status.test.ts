import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
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

describe('CLI recovery + status output', () => {
  it('suggests closest command on unknown command', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-recovery-'));
    try {
      const result = await runMain(['stauts'], wd);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /Unknown command: stauts/);
      assert.match(result.stderr, /Did you mean: omx status/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('suggests closest tmux-hook subcommand on typo', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-subcommand-'));
    try {
      const result = await runMain(['tmux-hook', 'statu'], wd);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /Unknown tmux-hook subcommand: statu/);
      assert.match(result.stderr, /Did you mean: omx tmux-hook status/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('sorts status output and prints a summary', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-status-'));
    try {
      const base = join(wd, '.omx', 'state');
      const sess = join(base, 'sessions', 'sess1');
      await mkdir(sess, { recursive: true });

      await writeFile(join(base, 'team-state.json'), JSON.stringify({ active: true, current_phase: 'execution' }));
      await writeFile(join(sess, 'autopilot-state.json'), JSON.stringify({ active: false, current_phase: 'idle' }));
      await writeFile(join(base, 'ralph-state.json'), JSON.stringify({ active: true, current_phase: 'running' }));

      const result = await runMain(['status'], wd);
      assert.equal(result.exitCode, 0, result.stderr || result.stdout);

      const lines = result.stdout.split('\n').map(l => l.trim()).filter(Boolean);
      const autopilotIdx = lines.findIndex(l => l.startsWith('autopilot: '));
      const ralphIdx = lines.findIndex(l => l.startsWith('ralph: '));
      const teamIdx = lines.findIndex(l => l.startsWith('team: '));
      assert.ok(autopilotIdx !== -1 && ralphIdx !== -1 && teamIdx !== -1);
      assert.ok(autopilotIdx < ralphIdx);
      assert.ok(ralphIdx < teamIdx);

      assert.match(result.stdout, /Summary: 3 mode\(s\), 2 active, 1 inactive/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
