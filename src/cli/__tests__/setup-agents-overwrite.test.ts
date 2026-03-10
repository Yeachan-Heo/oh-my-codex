import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup } from '../setup.js';

function setMockTty(value: boolean): () => void {
  Object.defineProperty(process.stdin, 'isTTY', {
    value,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value,
    configurable: true,
  });
  return () => {
    delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
  };
}

async function runSetupWithCapturedLogs(
  cwd: string,
  options: Parameters<typeof setup>[0]
): Promise<string> {
  const previousCwd = process.cwd();
  const logs: string[] = [];
  const originalLog = console.log;
  process.chdir(cwd);
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    await setup(options);
    return logs.join('\n');
  } finally {
    console.log = originalLog;
    process.chdir(previousCwd);
  }
}

async function readCurrentLinuxStartTicks(): Promise<number | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = await readFile('/proc/self/stat', 'utf-8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd === -1) return undefined;
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const ticks = Number(fields[19]);
    return Number.isFinite(ticks) ? ticks : undefined;
  } catch {
    return undefined;
  }
}

describe('omx setup AGENTS refresh behavior', () => {
  it('leaves project AGENTS.md untouched for user scope', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agents-'));
    const restoreTty = setMockTty(true);
    const existing = '# project-owned agents file\n';
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(wd, 'AGENTS.md'), existing);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'user',
      });

      assert.match(output, /User scope leaves project AGENTS\.md unchanged\./);
      assert.match(output, /agents_md: updated=0, unchanged=0, backed_up=0, skipped=1, removed=0/);
      assert.equal(await readFile(join(wd, 'AGENTS.md'), 'utf-8'), existing);
      assert.equal(existsSync(join(wd, '.omx', 'backups', 'setup')), false);
    } finally {
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('refreshes existing AGENTS.md by default in TTY and creates a backup first', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agents-'));
    const restoreTty = setMockTty(true);
    const existing = '# old agents file\n';
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(wd, 'AGENTS.md'), existing);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'project',
      });

      const agentsContent = await readFile(join(wd, 'AGENTS.md'), 'utf-8');
      assert.match(output, /Generated AGENTS\.md in project root\./);
      assert.match(output, /agents_md: updated=1, unchanged=0, backed_up=1, skipped=0, removed=0/);
      assert.match(agentsContent, /# oh-my-codex - Intelligent Multi-Agent Orchestration/);
      assert.doesNotMatch(agentsContent, /# old agents file/);

      const backupsRoot = join(wd, '.omx', 'backups', 'setup');
      assert.equal(existsSync(backupsRoot), true);
      const timestamps = await readdir(backupsRoot);
      assert.equal(timestamps.length, 1);
      const backupContent = await readFile(join(backupsRoot, timestamps[0], 'AGENTS.md'), 'utf-8');
      assert.equal(backupContent, existing);
    } finally {
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('skips overwrite during active session under refresh-first defaults', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agents-'));
    const restoreTty = setMockTty(true);
    const existing = '# active session file\n';
    try {
      const pidStartTicks = await readCurrentLinuxStartTicks();
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(wd, 'AGENTS.md'), existing);
      await writeFile(
        join(wd, '.omx', 'state', 'session.json'),
        JSON.stringify({
          session_id: 'sess-test',
          started_at: new Date().toISOString(),
          cwd: wd,
          pid: process.pid,
          pid_start_ticks: pidStartTicks,
        }, null, 2)
      );

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'project',
      });

      assert.match(output, /WARNING: Active omx session detected/);
      assert.match(output, /Skipping AGENTS\.md overwrite to avoid corrupting runtime overlay\./);
      assert.match(output, /Stop the active session first, then re-run setup\./);
      assert.match(output, /agents_md: updated=0, unchanged=0, backed_up=0, skipped=1, removed=0/);
      assert.equal(await readFile(join(wd, 'AGENTS.md'), 'utf-8'), existing);
      assert.equal(existsSync(join(wd, '.omx', 'backups', 'setup')), false);
    } finally {
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });
});
