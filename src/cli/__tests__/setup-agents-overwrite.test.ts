import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup } from '../setup.js';
import { addGeneratedAgentsMarker } from '../../utils/agents-md.js';
import { resolveAgentsModelTableContext, upsertAgentsModelTable } from '../../utils/agents-model-table.js';

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

function setMockHome(home: string): () => void {
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  process.env.CODEX_HOME = join(home, '.codex');
  return () => {
    if (typeof previousHome === 'string') process.env.HOME = previousHome;
    else delete process.env.HOME;
    if (typeof previousCodexHome === 'string') process.env.CODEX_HOME = previousCodexHome;
    else delete process.env.CODEX_HOME;
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
    await setup({
      modelUpgradePrompt: async () => false,
      ...options,
    });
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
  it('creates user-scope AGENTS.md and leaves project AGENTS.md untouched', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agents-'));
    const restoreTty = setMockTty(true);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const existing = '# project-owned agents file\n';
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(wd, 'AGENTS.md'), existing);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'user',
      });

      assert.match(output, /Generated AGENTS\.md in .*home\/\.codex\./);
      assert.match(output, /User scope leaves project AGENTS\.md unchanged\./);
      assert.match(output, /agents_md: updated=1, unchanged=0, backed_up=0, skipped=0, removed=0/);
      assert.equal(await readFile(join(wd, 'AGENTS.md'), 'utf-8'), existing);
      assert.equal(existsSync(join(home, '.codex', 'AGENTS.md')), true);
      assert.equal(existsSync(join(wd, '.omx', 'backups', 'setup')), false);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('overwrites existing AGENTS.md in TTY after confirmation and moves the old file to a deterministic sibling backup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agents-'));
    const restoreTty = setMockTty(true);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const existing = '# oh-my-codex - Intelligent Multi-Agent Orchestration\n\nUser-owned guidance.\n';
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(wd, 'AGENTS.md'), existing);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'project',
        agentsOverwritePrompt: async () => true,
      });

      const agentsContent = await readFile(join(wd, 'AGENTS.md'), 'utf-8');
      const backupPath = join(wd, '.AGENTS.md.bkup');
      assert.match(output, /Generated AGENTS\.md in project root\./);
      assert.match(output, new RegExp(`Backed up existing AGENTS\\.md to ${backupPath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\.`));
      assert.match(output, /agents_md: updated=1, unchanged=0, backed_up=1, skipped=0, removed=0/);
      assert.match(agentsContent, /^<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->/);
      assert.match(agentsContent, /# oh-my-codex - Intelligent Multi-Agent Orchestration/);
      assert.doesNotMatch(agentsContent, /User-owned guidance\./);
      assert.equal(existsSync(backupPath), true);
      assert.equal(existsSync(join(wd, '.omx', 'backups', 'setup')), false);
      const backupContent = await readFile(backupPath, 'utf-8');
      assert.equal(backupContent, existing);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('increments the deterministic sibling backup name when prior AGENTS backups already exist', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agents-'));
    const restoreTty = setMockTty(true);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const existing = '# keep me\n';
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(wd, 'AGENTS.md'), existing);
      await writeFile(join(wd, '.AGENTS.md.bkup'), 'older backup\n');
      await writeFile(join(wd, '.AGENTS.md.bkup1'), 'older backup 1\n');

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'project',
        agentsOverwritePrompt: async () => true,
      });

      const backupPath = join(wd, '.AGENTS.md.bkup2');
      assert.match(output, new RegExp(`Backed up existing AGENTS\\.md to ${backupPath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\.`));
      assert.equal(await readFile(backupPath, 'utf-8'), existing);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('refreshes the managed model table in non-interactive runs without requiring --force', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agents-'));
    const restoreTty = setMockTty(false);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const template = readFileSync(join(process.cwd(), 'templates', 'AGENTS.md'), 'utf-8');
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      const existing = upsertAgentsModelTable(
        addGeneratedAgentsMarker(template),
        {
          frontierModel: 'legacy-frontier',
          sparkModel: 'legacy-spark',
          subagentDefaultModel: 'legacy-frontier',
        },
      );
      await writeFile(join(wd, 'AGENTS.md'), existing);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'project',
      });

      const agentsContent = await readFile(join(wd, 'AGENTS.md'), 'utf-8');
      const expectedContext = resolveAgentsModelTableContext(
        await readFile(join(wd, '.codex', 'config.toml'), 'utf-8'),
        { codexHomeOverride: join(wd, '.codex') },
      );

      assert.match(output, /Refreshed AGENTS\.md model capability table in project root\./);
      assert.doesNotMatch(output, /Skipped AGENTS\.md overwrite/);
      assert.match(
        agentsContent,
        new RegExp(`\\| Frontier \\(leader\\) \\| \`${expectedContext.frontierModel}\` \\| high \\|`),
      );
      assert.match(
        agentsContent,
        new RegExp(`\\| Spark \\(explorer\\/fast\\) \\| \`${expectedContext.sparkModel}\` \\| low \\|`),
      );
      assert.match(
        agentsContent,
        new RegExp(String.raw`\| \`executor\` \| \`${expectedContext.frontierModel}\` \| medium \| Code implementation, refactoring, feature work`),
      );
      assert.doesNotMatch(agentsContent, /legacy-frontier/);
      assert.doesNotMatch(agentsContent, /legacy-spark/);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('refreshes only the explicit OMX-owned model block inside a user-authored AGENTS.md', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agents-'));
    const restoreTty = setMockTty(false);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      const existing = [
        '# Team Instructions',
        '',
        'Keep this custom guidance.',
        '',
        '<!-- OMX:MODELS:START -->',
        '## Model Capability Table',
        '',
        '| Role | Model | Reasoning Effort | Use Case |',
        '| --- | --- | --- | --- |',
        '| Frontier (leader) | `legacy-frontier` | high | stale |',
        '<!-- OMX:MODELS:END -->',
        '',
        'Footer guidance stays user-owned.',
      ].join('\n');
      await writeFile(join(wd, 'AGENTS.md'), existing);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'project',
      });

      const agentsContent = await readFile(join(wd, 'AGENTS.md'), 'utf-8');
      const expectedContext = resolveAgentsModelTableContext(
        await readFile(join(wd, '.codex', 'config.toml'), 'utf-8'),
        { codexHomeOverride: join(wd, '.codex') },
      );

      assert.match(output, /Refreshed AGENTS\.md model capability table in project root\./);
      assert.match(agentsContent, /Keep this custom guidance\./);
      assert.match(agentsContent, /Footer guidance stays user-owned\./);
      assert.match(
        agentsContent,
        new RegExp(`\\| Frontier \\(leader\\) \\| \`${expectedContext.frontierModel}\` \\| high \\|`),
      );
      assert.doesNotMatch(agentsContent, /legacy-frontier/);
      assert.doesNotMatch(agentsContent, /<!-- omx:generated:agents-md -->/);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves a title-only user-authored AGENTS.md by default when no OMX markers exist', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agents-'));
    const restoreTty = setMockTty(false);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const existing = '# oh-my-codex - Intelligent Multi-Agent Orchestration\n\nUser-owned guidance.\n';
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(wd, 'AGENTS.md'), existing);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'project',
      });

      assert.match(output, /Skipped AGENTS\.md overwrite/);
      assert.doesNotMatch(output, /Refreshed AGENTS\.md model capability table/);
      assert.equal(await readFile(join(wd, 'AGENTS.md'), 'utf-8'), existing);
      assert.equal(existsSync(join(wd, '.omx', 'backups', 'setup')), false);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('skips overwrite when confirmation is declined', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agents-'));
    const restoreTty = setMockTty(true);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const existing = '# keep this agents file\n';
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(wd, 'AGENTS.md'), existing);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'project',
        agentsOverwritePrompt: async () => false,
      });

      assert.match(output, /Skipped AGENTS\.md overwrite/);
      assert.match(output, /agents_md: updated=0, unchanged=0, backed_up=0, skipped=1, removed=0/);
      assert.equal(await readFile(join(wd, 'AGENTS.md'), 'utf-8'), existing);
      assert.equal(existsSync(join(wd, '.omx', 'backups', 'setup')), false);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('skips overwrite during active session under refresh-first defaults', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agents-'));
    const restoreTty = setMockTty(true);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
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
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });
});
