import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup } from '../setup.js';
import {
  addGeneratedAgentsMarker,
  OMX_MANAGED_AGENTS_END_MARKER,
  OMX_MANAGED_AGENTS_START_MARKER,
  OMX_USER_POLICY_END_MARKER,
  OMX_USER_POLICY_START_MARKER,
} from '../../utils/agents-md.js';
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

function normalizeDarwinTmpPath(value: string): string {
  return process.platform === 'darwin' ? value.replaceAll('/private/var/', '/var/') : value;
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
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
      installModePrompt: async (defaultMode) => defaultMode,
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
      assert.match(normalizeDarwinTmpPath(output), new RegExp(`Backed up existing AGENTS\\.md to ${normalizeDarwinTmpPath(backupPath).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\.`));
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
      assert.match(normalizeDarwinTmpPath(output), new RegExp(`Backed up existing AGENTS\\.md to ${normalizeDarwinTmpPath(backupPath).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\.`));
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

  it('keeps --merge-agents idempotent for already generated AGENTS.md and refreshes stale model rows', async () => {
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
          frontierModel: 'stale-frontier',
          sparkModel: 'stale-spark',
          subagentDefaultModel: 'stale-frontier',
        },
      );
      await writeFile(join(wd, 'AGENTS.md'), existing);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'project',
        mergeAgents: true,
      });

      const agentsContent = await readFile(join(wd, 'AGENTS.md'), 'utf-8');
      const expectedContext = resolveAgentsModelTableContext(
        await readFile(join(wd, '.codex', 'config.toml'), 'utf-8'),
        { codexHomeOverride: join(wd, '.codex') },
      );

      assert.match(output, /Merged OMX-managed AGENTS\.md sections into project root\./);
      assert.equal(countOccurrences(agentsContent, '<!-- omx:generated:agents-md -->'), 1);
      assert.equal(countOccurrences(agentsContent, OMX_MANAGED_AGENTS_START_MARKER), 0);
      assert.equal(countOccurrences(agentsContent, OMX_MANAGED_AGENTS_END_MARKER), 0);
      assert.match(
        agentsContent,
        new RegExp(`\\| Frontier \\(leader\\) \\| \`${expectedContext.frontierModel}\` \\| high \\|`),
      );
      assert.match(
        agentsContent,
        new RegExp(`\\| Spark \\(explorer\\/fast\\) \\| \`${expectedContext.sparkModel}\` \\| low \\|`),
      );
      assert.doesNotMatch(agentsContent, /stale-frontier/);
      assert.doesNotMatch(agentsContent, /stale-spark/);
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
      assert.match(output, /WARNING: Existing AGENTS\.md .* lacks OMX contract markers/);
      assert.match(output, /omx setup --scope project --merge-agents/);
      assert.doesNotMatch(output, /Refreshed AGENTS\.md model capability table/);
      assert.equal(await readFile(join(wd, 'AGENTS.md'), 'utf-8'), existing);
      assert.equal(existsSync(join(wd, '.omx', 'backups', 'setup')), false);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves symlinked user-scope AGENTS.md during plugin-mode cleanup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-plugin-agents-symlink-'));
    const restoreTty = setMockTty(false);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const dotfilesAgentsPath = join(wd, 'dotfiles', '.codex', 'AGENTS.md');
    const codexAgentsPath = join(home, '.codex', 'AGENTS.md');
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(join(wd, 'dotfiles', '.codex'), { recursive: true });
      await mkdir(join(home, '.codex'), { recursive: true });
      await writeFile(
        dotfilesAgentsPath,
        addGeneratedAgentsMarker('# oh-my-codex - Intelligent Multi-Agent Orchestration\n\nDotfiles-owned guidance.\n'),
      );
      await symlink(dotfilesAgentsPath, codexAgentsPath);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'user',
        installMode: 'plugin',
        force: true,
      });

      assert.match(output, /Plugin-mode AGENTS\.md defaults not selected; existing AGENTS\.md left untouched\./);
      assert.equal(await readlink(codexAgentsPath), dotfilesAgentsPath);
      assert.match(await readFile(codexAgentsPath, 'utf-8'), /Dotfiles-owned guidance\./);
      assert.match(output, /agents_md: updated=0, unchanged=0, backed_up=0, skipped=1, removed=0/);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('merges plugin-mode OMX-managed sections into an unmarked user AGENTS.md when explicitly requested', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-plugin-agents-merge-'));
    const restoreTty = setMockTty(false);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const codexAgentsPath = join(home, '.codex', 'AGENTS.md');
    const existing = '# Personal Instructions\n\nKeep this custom user guidance.\n';
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(join(home, '.codex'), { recursive: true });
      await writeFile(codexAgentsPath, existing);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'user',
        installMode: 'plugin',
        mergeAgents: true,
      });
      const agentsContent = await readFile(codexAgentsPath, 'utf-8');

      assert.match(output, /Merged plugin-mode OMX-managed AGENTS\.md sections into/);
      assert.match(output, /agents_md: updated=1, unchanged=0, backed_up=1, skipped=0, removed=0/);
      assert.match(agentsContent, /^# Personal Instructions/);
      assert.match(agentsContent, /Keep this custom user guidance\./);
      assert.match(agentsContent, new RegExp(OMX_MANAGED_AGENTS_START_MARKER));
      assert.match(agentsContent, new RegExp(OMX_MANAGED_AGENTS_END_MARKER));
      assert.match(agentsContent, /<!-- omx:generated:agents-md -->/);
      assert.match(agentsContent, /# oh-my-codex - Intelligent Multi-Agent Orchestration/);
      assert.equal(existsSync(join(home, '.omx', 'backups', 'setup')), true);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps plugin-mode explicit AGENTS.md merge idempotent on repeated runs', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-plugin-agents-merge-'));
    const restoreTty = setMockTty(false);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const codexAgentsPath = join(home, '.codex', 'AGENTS.md');
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(join(home, '.codex'), { recursive: true });
      await writeFile(codexAgentsPath, '# Personal Instructions\n\nKeep this custom user guidance.\n');

      await runSetupWithCapturedLogs(wd, {
        scope: 'user',
        installMode: 'plugin',
        mergeAgents: true,
      });
      const firstContent = await readFile(codexAgentsPath, 'utf-8');
      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'user',
        installMode: 'plugin',
        mergeAgents: true,
      });
      const secondContent = await readFile(codexAgentsPath, 'utf-8');

      assert.equal(secondContent, firstContent);
      assert.match(output, /Plugin-mode AGENTS\.md already up to date in/);
      assert.match(output, /agents_md: updated=0, unchanged=1, backed_up=0, skipped=0, removed=0/);
      assert.equal(countOccurrences(secondContent, OMX_MANAGED_AGENTS_START_MARKER), 1);
      assert.equal(countOccurrences(secondContent, OMX_MANAGED_AGENTS_END_MARKER), 1);
      assert.equal(countOccurrences(secondContent, '# oh-my-codex - Intelligent Multi-Agent Orchestration'), 1);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not ask for plugin AGENTS defaults during explicit plugin-mode AGENTS.md merge', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-plugin-agents-merge-prompt-'));
    const restoreTty = setMockTty(true);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const codexAgentsPath = join(home, '.codex', 'AGENTS.md');
    let promptCalls = 0;
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(join(home, '.codex'), { recursive: true });
      await writeFile(codexAgentsPath, '# Personal Instructions\n');

      await runSetupWithCapturedLogs(wd, {
        scope: 'user',
        installMode: 'plugin',
        mergeAgents: true,
        pluginDeveloperInstructionsPrompt: async () => false,
        pluginAgentsMdPrompt: async () => {
          promptCalls += 1;
          return true;
        },
      });

      assert.equal(promptCalls, 0);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('skips plugin-mode explicit AGENTS.md merge for symlinked user AGENTS.md', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-plugin-agents-symlink-merge-'));
    const restoreTty = setMockTty(false);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const dotfilesAgentsPath = join(wd, 'dotfiles', '.codex', 'AGENTS.md');
    const codexAgentsPath = join(home, '.codex', 'AGENTS.md');
    const dotfilesContent = '# Dotfiles Instructions\n\nDotfiles-owned guidance.\n';
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(join(wd, 'dotfiles', '.codex'), { recursive: true });
      await mkdir(join(home, '.codex'), { recursive: true });
      await writeFile(dotfilesAgentsPath, dotfilesContent);
      await symlink(dotfilesAgentsPath, codexAgentsPath);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'user',
        installMode: 'plugin',
        mergeAgents: true,
      });

      assert.match(output, /Skipped plugin-mode AGENTS\.md merge for symlinked/);
      assert.equal(await readlink(codexAgentsPath), dotfilesAgentsPath);
      assert.equal(await readFile(dotfilesAgentsPath, 'utf-8'), dotfilesContent);
      assert.match(output, /agents_md: updated=0, unchanged=0, backed_up=0, skipped=1, removed=0/);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('persists explicit false and clear policies when a plugin symlink skips the user AGENTS.md write', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-plugin-agents-symlink-policy-'));
    const restoreTty = setMockTty(false);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const dotfilesAgentsPath = join(wd, 'dotfiles', '.codex', 'AGENTS.md');
    const codexAgentsPath = join(home, '.codex', 'AGENTS.md');
    const dotfilesContent = '# Dotfiles Instructions\n\nDotfiles-owned guidance.\n';
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(join(wd, 'dotfiles', '.codex'), { recursive: true });
      await mkdir(join(home, '.codex'), { recursive: true });
      await writeFile(dotfilesAgentsPath, dotfilesContent);
      await symlink(dotfilesAgentsPath, codexAgentsPath);
      const statePath = join(wd, '.omx', 'setup-scope.json');

      for (const [mergeAgentsPolicy, expected] of [
        [{ kind: 'set', value: false }, false],
        [{ kind: 'clear' }, undefined],
      ] as const) {
        await writeFile(statePath, JSON.stringify({ scope: 'user', installMode: 'plugin', mcpMode: 'none', mergeAgents: true }));
        await runSetupWithCapturedLogs(wd, {
          scope: 'user',
          installMode: 'plugin',
          mergeAgentsPolicy,
        });
        assert.equal(await readlink(codexAgentsPath), dotfilesAgentsPath);
        assert.equal(await readFile(dotfilesAgentsPath, 'utf-8'), dotfilesContent);
        const persisted = JSON.parse(await readFile(statePath, 'utf-8')) as { mergeAgents?: boolean };
        assert.equal(persisted.mergeAgents, expected);
        assert.equal(Object.hasOwn(persisted, 'mergeAgents'), expected !== undefined);
      }
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('skips plugin-mode explicit AGENTS.md merge for broken symlinked user AGENTS.md', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-plugin-agents-broken-symlink-merge-'));
    const restoreTty = setMockTty(false);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const missingAgentsPath = join(wd, 'dotfiles', '.codex', 'AGENTS.md');
    const codexAgentsPath = join(home, '.codex', 'AGENTS.md');
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(join(home, '.codex'), { recursive: true });
      await symlink(missingAgentsPath, codexAgentsPath);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'user',
        installMode: 'plugin',
        mergeAgents: true,
      });

      assert.match(output, /Skipped plugin-mode AGENTS\.md merge for symlinked/);
      assert.equal(await readlink(codexAgentsPath), missingAgentsPath);
      assert.equal(existsSync(missingAgentsPath), false);
      assert.match(output, /agents_md: updated=0, unchanged=0, backed_up=0, skipped=1, removed=0/);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('skips plugin-mode AGENTS defaults for symlinked user AGENTS.md even when prompted overwrite would be accepted', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-plugin-agents-symlink-default-'));
    const restoreTty = setMockTty(true);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const dotfilesAgentsPath = join(wd, 'dotfiles', '.codex', 'AGENTS.md');
    const codexAgentsPath = join(home, '.codex', 'AGENTS.md');
    const dotfilesContent = '# Dotfiles Instructions\n\nDotfiles-owned guidance.\n';
    let promptCalls = 0;
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(join(wd, 'dotfiles', '.codex'), { recursive: true });
      await mkdir(join(home, '.codex'), { recursive: true });
      await writeFile(dotfilesAgentsPath, dotfilesContent);
      await symlink(dotfilesAgentsPath, codexAgentsPath);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'user',
        installMode: 'plugin',
        pluginDeveloperInstructionsPrompt: async () => false,
        pluginAgentsMdPrompt: async () => {
          promptCalls += 1;
          return true;
        },
        agentsOverwritePrompt: async () => true,
      });

      assert.equal(promptCalls, 0);
      assert.match(output, /Plugin-mode AGENTS\.md defaults not selected; existing AGENTS\.md left untouched\./);
      assert.equal(await readlink(codexAgentsPath), dotfilesAgentsPath);
      assert.equal(await readFile(dotfilesAgentsPath, 'utf-8'), dotfilesContent);
      assert.match(output, /agents_md: updated=0, unchanged=0, backed_up=0, skipped=1, removed=0/);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('skips plugin-mode AGENTS defaults for broken symlinked user AGENTS.md', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-plugin-agents-broken-symlink-default-'));
    const restoreTty = setMockTty(false);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const missingAgentsPath = join(wd, 'dotfiles', '.codex', 'AGENTS.md');
    const codexAgentsPath = join(home, '.codex', 'AGENTS.md');
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(join(home, '.codex'), { recursive: true });
      await symlink(missingAgentsPath, codexAgentsPath);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'user',
        installMode: 'plugin',
        force: true,
        pluginDeveloperInstructionsPrompt: async () => false,
      });

      assert.match(output, /Plugin-mode AGENTS\.md defaults not selected; existing AGENTS\.md left untouched\./);
      assert.equal(await readlink(codexAgentsPath), missingAgentsPath);
      assert.equal(existsSync(missingAgentsPath), false);
      assert.match(output, /agents_md: updated=0, unchanged=0, backed_up=0, skipped=1, removed=0/);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves user-owned OMX policy blocks during forced plugin defaults refresh', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-plugin-agents-policy-'));
    const restoreTty = setMockTty(false);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const codexAgentsPath = join(home, '.codex', 'AGENTS.md');
    const policyBlock = [
      OMX_USER_POLICY_START_MARKER,
      'Durable local operator rule: never drop this.',
      OMX_USER_POLICY_END_MARKER,
    ].join('\n');
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await mkdir(join(home, '.codex'), { recursive: true });
      await writeFile(codexAgentsPath, `# Local Instructions\n\n${policyBlock}\n`);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'user',
        installMode: 'plugin',
        force: true,
        pluginDeveloperInstructionsPrompt: async () => false,
      });

      const agents = await readFile(codexAgentsPath, 'utf-8');
      assert.match(output, /Generated plugin-mode AGENTS\.md defaults/);
      assert.match(agents, /# oh-my-codex - Intelligent Multi-Agent Orchestration/);
      assert.match(agents, /Durable local operator rule: never drop this\./);
      assert.equal(countOccurrences(agents, OMX_USER_POLICY_START_MARKER), 1);
      assert.equal(countOccurrences(agents, OMX_USER_POLICY_END_MARKER), 1);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('merges OMX-managed sections into an unmarked user-authored AGENTS.md when explicitly requested', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agents-'));
    const restoreTty = setMockTty(false);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const existing = '# Team Instructions\n\nKeep this custom guidance.\n';
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(wd, 'AGENTS.md'), existing);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'project',
        mergeAgents: true,
      });

      const agentsContent = await readFile(join(wd, 'AGENTS.md'), 'utf-8');

      assert.match(output, /Merged OMX-managed AGENTS\.md sections into project root\./);
      assert.match(output, /agents_md: updated=1, unchanged=0, backed_up=1, skipped=0, removed=0/);
      assert.match(agentsContent, /^# Team Instructions/);
      assert.match(agentsContent, /Keep this custom guidance\./);
      assert.match(agentsContent, new RegExp(OMX_MANAGED_AGENTS_START_MARKER));
      assert.match(agentsContent, new RegExp(OMX_MANAGED_AGENTS_END_MARKER));
      assert.match(agentsContent, /# oh-my-codex - Intelligent Multi-Agent Orchestration/);
      assert.equal(existsSync(join(wd, '.omx', 'backups', 'setup')), true);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps explicit AGENTS.md merge idempotent on repeated runs', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agents-'));
    const restoreTty = setMockTty(false);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(wd, 'AGENTS.md'), '# Team Instructions\n\nKeep this custom guidance.\n');

      await runSetupWithCapturedLogs(wd, {
        scope: 'project',
        mergeAgents: true,
      });
      const firstContent = await readFile(join(wd, 'AGENTS.md'), 'utf-8');
      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'project',
        mergeAgents: true,
      });
      const secondContent = await readFile(join(wd, 'AGENTS.md'), 'utf-8');

      assert.equal(secondContent, firstContent);
      assert.match(output, /AGENTS\.md already up to date in project root\./);
      assert.match(output, /agents_md: updated=0, unchanged=1, backed_up=0, skipped=0, removed=0/);
      assert.equal(countOccurrences(secondContent, OMX_MANAGED_AGENTS_START_MARKER), 1);
      assert.equal(countOccurrences(secondContent, OMX_MANAGED_AGENTS_END_MARKER), 1);
      assert.equal(countOccurrences(secondContent, '# oh-my-codex - Intelligent Multi-Agent Orchestration'), 1);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('refreshes the managed model table inside an explicit merged AGENTS.md block', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agents-'));
    const restoreTty = setMockTty(false);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const template = readFileSync(join(process.cwd(), 'templates', 'AGENTS.md'), 'utf-8');
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      const staleManaged = upsertAgentsModelTable(
        addGeneratedAgentsMarker(template),
        {
          frontierModel: 'legacy-frontier',
          sparkModel: 'legacy-spark',
          subagentDefaultModel: 'legacy-frontier',
        },
      );
      const existing = [
        '# Team Instructions',
        '',
        'Keep this custom guidance.',
        '',
        OMX_MANAGED_AGENTS_START_MARKER,
        staleManaged.trimEnd(),
        OMX_MANAGED_AGENTS_END_MARKER,
        '',
      ].join('\n');
      await writeFile(join(wd, 'AGENTS.md'), existing);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: 'project',
        mergeAgents: true,
      });
      const agentsContent = await readFile(join(wd, 'AGENTS.md'), 'utf-8');
      const expectedContext = resolveAgentsModelTableContext(
        await readFile(join(wd, '.codex', 'config.toml'), 'utf-8'),
        { codexHomeOverride: join(wd, '.codex') },
      );

      assert.match(output, /Merged OMX-managed AGENTS\.md sections into project root\./);
      assert.match(agentsContent, /Keep this custom guidance\./);
      assert.match(
        agentsContent,
        new RegExp(`\\| Frontier \\(leader\\) \\| \`${expectedContext.frontierModel}\` \\| high \\|`),
      );
      assert.doesNotMatch(agentsContent, /legacy-frontier/);
      assert.doesNotMatch(agentsContent, /legacy-spark/);
      assert.equal(countOccurrences(agentsContent, OMX_MANAGED_AGENTS_START_MARKER), 1);
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('skips explicit AGENTS.md merge during an active project session', async () => {
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
        mergeAgents: true,
      });

      assert.match(output, /WARNING: Active omx session detected/);
      assert.match(output, /Skipping AGENTS\.md overwrite to avoid corrupting runtime overlay\./);
      assert.match(output, /agents_md: updated=0, unchanged=0, backed_up=0, skipped=1, removed=0/);
      assert.equal(await readFile(join(wd, 'AGENTS.md'), 'utf-8'), existing);
      assert.equal(existsSync(join(wd, '.omx', 'backups', 'setup')), false);
      assert.deepEqual(
        JSON.parse(await readFile(join(wd, '.omx', 'setup-scope.json'), 'utf-8')),
        { scope: 'project', mcpMode: 'none', mergeAgents: true },
      );
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('persists explicit false and clear policies when an active session skips the project AGENTS.md write', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-agents-active-policy-'));
    const restoreTty = setMockTty(false);
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
      const statePath = join(wd, '.omx', 'setup-scope.json');

      for (const [mergeAgentsPolicy, expected] of [
        [{ kind: 'set', value: false }, false],
        [{ kind: 'clear' }, undefined],
      ] as const) {
        await writeFile(statePath, JSON.stringify({ scope: 'project', mcpMode: 'none', mergeAgents: true }));
        await runSetupWithCapturedLogs(wd, {
          scope: 'project',
          mergeAgentsPolicy,
        });
        assert.equal(await readFile(join(wd, 'AGENTS.md'), 'utf-8'), existing);
        const persisted = JSON.parse(await readFile(statePath, 'utf-8')) as { mergeAgents?: boolean };
        assert.equal(persisted.mergeAgents, expected);
        assert.equal(Object.hasOwn(persisted, 'mergeAgents'), expected !== undefined);
      }
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('skips plugin-mode explicit AGENTS.md merge during an active project session', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-plugin-agents-active-'));
    const restoreTty = setMockTty(false);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const existing = '# active plugin project file\n';
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
        installMode: 'plugin',
        mergeAgents: true,
      });

      assert.match(output, /WARNING: Active omx session detected/);
      assert.match(output, /Skipping AGENTS\.md overwrite to avoid corrupting runtime overlay\./);
      assert.match(output, /Stop the active session first, then re-run setup\./);
      assert.match(output, /agents_md: updated=0, unchanged=0, backed_up=0, skipped=1, removed=0/);
      assert.equal(await readFile(join(wd, 'AGENTS.md'), 'utf-8'), existing);
      assert.deepEqual(
        JSON.parse(await readFile(join(wd, '.omx', 'setup-scope.json'), 'utf-8')),
        { scope: 'project', installMode: 'plugin', mcpMode: 'none', mergeAgents: true },
      );
    } finally {
      restoreHome();
      restoreTty();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('skips plugin-mode AGENTS defaults during an active project session', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-setup-plugin-agents-active-default-'));
    const restoreTty = setMockTty(true);
    const home = join(wd, 'home');
    const restoreHome = setMockHome(home);
    const existing = '# active plugin project file\n';
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
        installMode: 'plugin',
        force: true,
        pluginDeveloperInstructionsPrompt: async () => false,
      });

      assert.match(output, /WARNING: Active omx session detected/);
      assert.match(output, /Skipping AGENTS\.md overwrite to avoid corrupting runtime overlay\./);
      assert.match(output, /Stop the active session first, then re-run setup\./);
      assert.match(output, /agents_md: updated=0, unchanged=0, backed_up=0, skipped=1, removed=0/);
      assert.equal(await readFile(join(wd, 'AGENTS.md'), 'utf-8'), existing);
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
