import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

describe('omx setup AGENTS overwrite prompt behavior', () => {
  it('overwrites existing AGENTS.md when prompt accepts in TTY', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agents-'));
    const restoreTty = setMockTty(true);
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(wd, 'AGENTS.md'), '# old agents file\n');

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'project',
        agentsOverwritePrompt: async () => true,
      });

      const agentsContent = await readFile(join(wd, 'AGENTS.md'), 'utf-8');
      assert.match(output, /Generated AGENTS\.md in project root\./);
      assert.match(agentsContent, /# oh-my-codex - Intelligent Multi-Agent Orchestration/);
      assert.doesNotMatch(agentsContent, /# old agents file/);
    } finally {
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves existing AGENTS.md when prompt declines in TTY', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agents-'));
    const restoreTty = setMockTty(true);
    const existing = '# keep me\n';
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(wd, 'AGENTS.md'), existing);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'project',
        agentsOverwritePrompt: async () => false,
      });

      assert.match(output, /AGENTS\.md already exists \(use --force to overwrite\)\./);
      assert.equal(await readFile(join(wd, 'AGENTS.md'), 'utf-8'), existing);
    } finally {
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('skips overwrite during active session even when prompt accepts in TTY', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agents-'));
    const restoreTty = setMockTty(true);
    const existing = '# active session file\n';
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(wd, 'AGENTS.md'), existing);
      await writeFile(
        join(wd, '.omx', 'state', 'session.json'),
        JSON.stringify({
          session_id: 'sess-test',
          started_at: new Date().toISOString(),
          cwd: wd,
          pid: process.pid,
        }, null, 2)
      );

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'project',
        agentsOverwritePrompt: async () => true,
      });

      assert.match(output, /WARNING: Active omx session detected/);
      assert.match(output, /Skipping AGENTS\.md overwrite to avoid corrupting runtime overlay\./);
      assert.match(output, /re-run setup and approve overwrite \(or use --force\)\./);
      assert.equal(await readFile(join(wd, 'AGENTS.md'), 'utf-8'), existing);
    } finally {
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });
});
