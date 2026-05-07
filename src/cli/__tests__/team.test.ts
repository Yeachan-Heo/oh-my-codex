import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildLeaderMonitoringHints, parseTeamStartArgs, teamCommand } from '../team.js';
import { readModeState } from '../../modes/base.js';
import { readApprovedExecutionLaunchHint } from '../../planning/artifacts.js';
import { buildRepoAwareTeamExecutionPlan } from '../../team/repo-aware-decomposition.js';
import { DEFAULT_MAX_WORKERS } from '../../team/state.js';
import { shutdownTeam } from '../../team/runtime.js';
import { sameFilePath } from '../../utils/paths.js';
import {
  appendTeamEvent,
  createTask,
  initTeamState,
  readTeamConfig,
  saveTeamConfig,
  updateWorkerHeartbeat,
  writeMonitorSnapshot,
  writeTaskApproval,
  writeWorkerStatus,
} from '../../team/state.js';
import {
  buildApprovedTeamExecutionBinding,
  writePersistedApprovedTeamExecutionBinding,
} from '../../team/approved-execution.js';
import { isRealTmuxAvailable, withTempTmuxSession, type TempTmuxSessionFixture } from '../../team/__tests__/tmux-test-fixture.js';

const OMX_CLI_PATH = fileURLToPath(new URL('../omx.js', import.meta.url));
const ORIGINAL_OMX_TEAM_WORKER = process.env.OMX_TEAM_WORKER;
const ORIGINAL_OMX_TEAM_STATE_ROOT = process.env.OMX_TEAM_STATE_ROOT;

function encodeApprovedExecutionTask(task: string, quote: 'single' | 'double'): string {
  return quote === 'single'
    ? `'${task.replace(/'/g, "\\'")}'`
    : `"${task.replace(/"/g, '\\"')}"`;
}

function computeGitBlobSha1(content: string): string {
  const buffer = Buffer.from(content, 'utf-8');
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf-8');
  return createHash('sha1').update(header).update(buffer).digest('hex');
}

function canonicalContextPackRelativePath(slug: string): string {
  return `.omx/context/context-20260507T120000Z-${slug}.json`;
}

function buildContextPackOutcome(relativePackPath: string): string {
  return [
    '## Context Pack Outcome',
    '',
    `- pack: created \`${relativePackPath}\``,
  ].join('\n');
}

async function writeContextPack(
  cwd: string,
  slug: string,
  prdPath: string,
  testSpecPath: string,
  roles: readonly string[],
): Promise<void> {
  const contextDir = join(cwd, '.omx', 'context');
  const packPath = join(cwd, canonicalContextPackRelativePath(slug));
  const prdContent = await readFile(prdPath, 'utf-8');
  const testSpecContent = await readFile(testSpecPath, 'utf-8');
  await mkdir(contextDir, { recursive: true });
  await writeFile(packPath, JSON.stringify({
    slug,
    basis: {
      prd: {
        path: relative(cwd, prdPath).replaceAll('\\', '/'),
        sha1: computeGitBlobSha1(prdContent),
      },
      testSpecs: [{
        path: relative(cwd, testSpecPath).replaceAll('\\', '/'),
        sha1: computeGitBlobSha1(testSpecContent),
      }],
    },
    entries: roles.map((role, index) => ({
      path: `src/${role}-${index}.ts`,
      roles: [role],
    })),
  }, null, 2));
}

async function writeReadyContextPack(
  cwd: string,
  slug: string,
  prdPath: string,
  testSpecPath: string,
): Promise<void> {
  await writeContextPack(cwd, slug, prdPath, testSpecPath, ['scope', 'build', 'verify']);
}

beforeEach(() => {
  delete process.env.OMX_TEAM_WORKER;
  delete process.env.OMX_TEAM_STATE_ROOT;
});

afterEach(() => {
  if (typeof ORIGINAL_OMX_TEAM_WORKER === 'string') process.env.OMX_TEAM_WORKER = ORIGINAL_OMX_TEAM_WORKER;
  else delete process.env.OMX_TEAM_WORKER;

  if (typeof ORIGINAL_OMX_TEAM_STATE_ROOT === 'string') process.env.OMX_TEAM_STATE_ROOT = ORIGINAL_OMX_TEAM_STATE_ROOT;
  else delete process.env.OMX_TEAM_STATE_ROOT;
});

function withoutTeamTestWorkerEnv<T>(fn: () => T): T {
  const previousTeamWorker = process.env.OMX_TEAM_WORKER;
  const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
  delete process.env.OMX_TEAM_WORKER;
  delete process.env.OMX_TEAM_STATE_ROOT;

  let restoreImmediately = true;
  const restore = () => {
    if (typeof previousTeamWorker === 'string') process.env.OMX_TEAM_WORKER = previousTeamWorker;
    else delete process.env.OMX_TEAM_WORKER;

    if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
    else delete process.env.OMX_TEAM_STATE_ROOT;
  };

  try {
    const result = fn();
    if (result instanceof Promise) {
      restoreImmediately = false;
      return result.finally(restore) as T;
    }
    return result;
  } finally {
    if (restoreImmediately) restore();
  }
}

function withMockPromptModeCodexAllowed<T>(fn: () => T): T {
  const previous = process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT;
  process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT = '1';
  let restoreImmediately = true;
  const restore = () => {
    if (typeof previous === 'string') process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT = previous;
    else delete process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT;
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      restoreImmediately = false;
      return result.finally(restore) as T;
    }
    return result;
  } finally {
    if (restoreImmediately) restore();
  }
}

async function runNodeCli(
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [OMX_CLI_PATH, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function skipUnlessTmux(t: TestContext): void {
  if (!isRealTmuxAvailable()) {
    t.skip('tmux is not available in this environment');
  }
}

function runFixtureTmux(fixture: TempTmuxSessionFixture, args: string[]): string {
  return execFileSync('tmux', args, {
    encoding: 'utf-8',
    env: {
      ...process.env,
      TMUX: fixture.env.TMUX,
      TMUX_PANE: fixture.leaderPaneId,
    },
  }).trim();
}

function fixturePaneExists(fixture: TempTmuxSessionFixture, paneId: string): boolean {
  try {
    runFixtureTmux(fixture, ['display-message', '-p', '-t', paneId, '#{pane_id}']);
    return true;
  } catch {
    return false;
  }
}

async function waitForFileText(filePath: string, timeoutMs: number = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const text = await readFile(filePath, 'utf-8');
      if (text.trim() !== '') return text;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

describe('parseTeamStartArgs', () => {
  it('parses default team start args with automatic detached worktrees', () => {
    const result = parseTeamStartArgs(['2:executor', 'build', 'feature']);
    assert.deepEqual(result.worktreeMode, { enabled: true, detached: true, name: null });
    assert.equal(result.parsed.workerCount, 2);
    assert.equal(result.parsed.agentType, 'executor');
    assert.equal(result.parsed.task, 'build feature');
    assert.equal(result.parsed.teamName, 'build-feature');
  });

  it('parses detached worktree mode and strips the flag', () => {
    const result = parseTeamStartArgs(['--worktree', '3:debugger', 'fix', 'bug']);
    assert.deepEqual(result.worktreeMode, { enabled: true, detached: true, name: null });
    assert.equal(result.parsed.workerCount, 3);
    assert.equal(result.parsed.agentType, 'debugger');
    assert.equal(result.parsed.task, 'fix bug');
    assert.equal(result.parsed.teamName, 'fix-bug');
  });

  it('keeps explicit --worktree detached mode as a legacy-compatible override', () => {
    const result = parseTeamStartArgs(['--worktree', '3:debugger', 'fix', 'bug']);
    assert.deepEqual(result.worktreeMode, { enabled: true, detached: true, name: null });
    assert.equal(result.parsed.workerCount, 3);
    assert.equal(result.parsed.agentType, 'debugger');
  });

  it('rejects deprecated omx team ralph syntax', () => {
    assert.throws(
      () => parseTeamStartArgs(['ralph', '--worktree=feature/demo', '4:executor', 'ship', 'it']),
      /Deprecated usage: `omx team ralph \.\.\.` has been removed/,
    );
  });

  it('accepts the maximum supported worker count', () => {
    const result = parseTeamStartArgs([`${DEFAULT_MAX_WORKERS}:executor`, 'ship', 'it']);
    assert.equal(result.parsed.workerCount, DEFAULT_MAX_WORKERS);
  });

  it('rejects worker count above the supported maximum', () => {
    assert.throws(
      () => parseTeamStartArgs([`${DEFAULT_MAX_WORKERS + 1}:executor`, 'ship', 'it']),
      new RegExp(`Expected 1-${DEFAULT_MAX_WORKERS}`),
    );
  });

  it('reuses the approved team launch hint for a short English follow-up', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-followup-en-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      await mkdir(join(wd, '.omx', 'plans'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'plans', 'prd-issue-831.md'),
        '# Approved plan\n\nLaunch via omx team 3:executor "Execute approved issue 831 plan"\n',
      );
      await writeFile(join(wd, '.omx', 'plans', 'test-spec-issue-831.md'), '# Test spec\n');

      const result = parseTeamStartArgs(['team']);
      assert.equal(result.parsed.task, 'Execute approved issue 831 plan');
      assert.equal(result.parsed.workerCount, 3);
      assert.equal(result.parsed.agentType, 'executor');
      assert.equal(result.parsed.explicitWorkerCount, true);
      assert.equal(result.parsed.allowRepoAwareDagHandoff, true);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('reuses the approved team launch hint for a short Korean follow-up', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-followup-ko-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      await mkdir(join(wd, '.omx', 'plans'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'plans', 'prd-issue-831.md'),
        '# Approved plan\n\nLaunch via omx team 3:executor "Execute approved issue 831 plan"\n',
      );
      await writeFile(join(wd, '.omx', 'plans', 'test-spec-issue-831.md'), '# Test spec\n');

      const result = parseTeamStartArgs(['team으로', '해줘']);
      assert.equal(result.parsed.task, 'Execute approved issue 831 plan');
      assert.equal(result.parsed.workerCount, 3);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prefers the persisted approved binding over a newer latest approved hint for a short follow-up', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-followup-bound-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      const plansDir = join(wd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      const boundPrdPath = join(plansDir, 'prd-20260501T010203Z-issue-831.md');
      const boundTestSpecPath = join(plansDir, 'test-spec-20260501T010203Z-issue-831.md');
      await writeFile(
        boundPrdPath,
        [
          '# Approved plan',
          '',
          buildContextPackOutcome(canonicalContextPackRelativePath('issue-831')),
          '',
          'Launch via omx team 2:executor "Execute approved issue 831 plan"',
        ].join('\n'),
      );
      await writeFile(boundTestSpecPath, '# Test spec\n');
      await writeReadyContextPack(wd, 'issue-831', boundPrdPath, boundTestSpecPath);
      await writeFile(
        join(plansDir, 'prd-20260502T010203Z-issue-999.md'),
        '# Approved plan\n\nLaunch via omx team 5:debugger "Execute newer approved issue 999 plan"\n',
      );
      await writeFile(
        join(plansDir, 'test-spec-20260502T010203Z-issue-999.md'),
        '# Test spec\n',
      );
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'state', 'team-state.json'),
        JSON.stringify({ active: true, team_name: 'bound-team' }, null, 2),
      );
      await writePersistedApprovedTeamExecutionBinding('bound-team', wd, {
        prd_path: boundPrdPath,
        task: 'Execute approved issue 831 plan',
        command: 'omx team 2:executor "Execute approved issue 831 plan"',
      });

      const result = parseTeamStartArgs(['team']);
      assert.equal(result.parsed.task, 'Execute approved issue 831 plan');
      assert.equal(result.parsed.workerCount, 2);
      assert.equal(result.parsed.agentType, 'executor');
      assert.equal(result.parsed.approvedExecution?.task, 'Execute approved issue 831 plan');
      assert.equal(
        result.parsed.approvedExecution?.command,
        'omx team 2:executor "Execute approved issue 831 plan"',
      );
      assert.equal(sameFilePath(result.parsed.approvedExecution?.prd_path ?? '', boundPrdPath), true);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('round-trips single-quoted approved follow-ups from launch hint encoding through persisted binding', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-followup-bound-quoted-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      const plansDir = join(wd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      const boundTask = "Fix Bob's regression in C:\\\\tmp";
      const boundCommand = `omx team 2:executor ${encodeApprovedExecutionTask(boundTask, 'single')}`;
      const boundPrdPath = join(plansDir, 'prd-issue-831-quoted.md');
      const boundTestSpecPath = join(plansDir, 'test-spec-issue-831-quoted.md');
      await writeFile(
        boundPrdPath,
        [
          '# Approved plan',
          '',
          buildContextPackOutcome(canonicalContextPackRelativePath('issue-831-quoted')),
          '',
          `Launch via ${boundCommand}`,
        ].join('\n'),
      );
      await writeFile(boundTestSpecPath, '# Test spec\n');
      await writeReadyContextPack(wd, 'issue-831-quoted', boundPrdPath, boundTestSpecPath);
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'state', 'team-state.json'),
        JSON.stringify({ active: true, team_name: 'bound-team-quoted' }, null, 2),
      );
      const approvedHint = readApprovedExecutionLaunchHint(wd, 'team');
      assert.ok(approvedHint);
      assert.equal(approvedHint?.task, boundTask);
      assert.equal(approvedHint?.command, boundCommand);
      await writePersistedApprovedTeamExecutionBinding(
        'bound-team-quoted',
        wd,
        buildApprovedTeamExecutionBinding(approvedHint),
      );

      const result = parseTeamStartArgs(['team']);
      assert.equal(result.parsed.task, boundTask);
      assert.equal(result.parsed.workerCount, 2);
      assert.equal(result.parsed.agentType, 'executor');
      assert.equal(result.parsed.approvedExecution?.task, boundTask);
      assert.equal(result.parsed.approvedExecution?.command, boundCommand);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('round-trips double-quoted approved follow-ups from launch hint encoding through persisted binding', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-followup-bound-double-quoted-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      const plansDir = join(wd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      const boundTask = String.raw`Use C:\tmp and keep \n literal plus "quotes"`;
      const boundCommand = `omx team 2:executor ${encodeApprovedExecutionTask(boundTask, 'double')}`;
      const boundPrdPath = join(plansDir, 'prd-issue-831-double-quoted.md');
      const boundTestSpecPath = join(plansDir, 'test-spec-issue-831-double-quoted.md');
      await writeFile(
        boundPrdPath,
        [
          '# Approved plan',
          '',
          buildContextPackOutcome(canonicalContextPackRelativePath('issue-831-double-quoted')),
          '',
          `Launch via ${boundCommand}`,
        ].join('\n'),
      );
      await writeFile(boundTestSpecPath, '# Test spec\n');
      await writeReadyContextPack(wd, 'issue-831-double-quoted', boundPrdPath, boundTestSpecPath);
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'state', 'team-state.json'),
        JSON.stringify({ active: true, team_name: 'bound-team-double-quoted' }, null, 2),
      );
      const approvedHint = readApprovedExecutionLaunchHint(wd, 'team');
      assert.ok(approvedHint);
      assert.equal(approvedHint?.task, boundTask);
      assert.equal(approvedHint?.command, boundCommand);
      await writePersistedApprovedTeamExecutionBinding(
        'bound-team-double-quoted',
        wd,
        buildApprovedTeamExecutionBinding(approvedHint),
      );

      const result = parseTeamStartArgs(['team']);
      assert.equal(result.parsed.task, boundTask);
      assert.equal(result.parsed.workerCount, 2);
      assert.equal(result.parsed.agentType, 'executor');
      assert.equal(result.parsed.approvedExecution?.task, boundTask);
      assert.equal(result.parsed.approvedExecution?.command, boundCommand);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('reuses the persisted approved binding from session-scoped team state for a short follow-up', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-followup-bound-session-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      const sessionId = 'sess-team-followup-bound';
      const plansDir = join(wd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      const prdPath = join(plansDir, 'prd-issue-954.md');
      await writeFile(
        prdPath,
        '# Approved plan\n\nLaunch via omx team 5:executor "Execute approved session-scoped plan"\n',
      );
      await writeFile(join(plansDir, 'test-spec-issue-954.md'), '# Test spec\n');
      await mkdir(join(wd, '.omx', 'state', 'sessions', sessionId), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'state', 'session.json'),
        JSON.stringify({ session_id: sessionId }, null, 2),
      );
      await writeFile(
        join(wd, '.omx', 'state', 'sessions', sessionId, 'team-state.json'),
        JSON.stringify({
          active: true,
          team_name: 'bound-team-session',
          task_description: 'Execute approved session-scoped plan',
          agent_count: 5,
        }, null, 2),
      );
      await writePersistedApprovedTeamExecutionBinding('bound-team-session', wd, {
        prd_path: prdPath,
        task: 'Execute approved session-scoped plan',
        command: 'omx team 5:executor "Execute approved session-scoped plan"',
      });

      const result = parseTeamStartArgs(['team']);
      assert.equal(result.parsed.task, 'Execute approved session-scoped plan');
      assert.equal(result.parsed.workerCount, 5);
      assert.equal(result.parsed.agentType, 'executor');
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps plan-only short follow-ups on the generic path even when a persisted approved binding exists', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-followup-plan-only-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      const plansDir = join(wd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      const prdPath = join(plansDir, 'prd-issue-2085.md');
      const command = 'omx team 3:executor "Execute approved issue 2085 plan"';
      await writeFile(
        prdPath,
        `# Approved plan\n\nLaunch via ${command}\n`,
      );
      await writeFile(join(plansDir, 'test-spec-issue-2085.md'), '# Test spec\n');
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'state', 'team-state.json'),
        JSON.stringify({ active: true, team_name: 'bound-plan-only-team' }, null, 2),
      );
      await writePersistedApprovedTeamExecutionBinding('bound-plan-only-team', wd, {
        prd_path: prdPath,
        task: 'Execute approved issue 2085 plan',
        command,
      });

      const result = parseTeamStartArgs(['team']);
      assert.equal(result.parsed.task, 'Execute approved issue 2085 plan');
      assert.equal(result.parsed.workerCount, 3);
      assert.equal(result.parsed.agentType, 'executor');
      assert.equal(result.parsed.approvedExecution, undefined);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails short follow-up reuse when the latest approved handoff is nonready', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-followup-nonready-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      const plansDir = join(wd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      await writeFile(
        join(plansDir, 'prd-issue-2086.md'),
        [
          '# Approved plan',
          '',
          '## Context Pack Outcome',
          '',
          '- pack: created `.omx/context/context-20260507T120000Z-other.json`',
          '',
          'Launch via omx team 3:executor "Execute approved issue 2086 plan"',
        ].join('\n'),
      );
      await writeFile(join(plansDir, 'test-spec-issue-2086.md'), '# Test spec\n');

      assert.throws(
        () => parseTeamStartArgs(['team']),
        /approved_execution_hint_nonready:team:invalid/,
      );
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails short follow-up reuse when the latest approved handoff is missing its baseline', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-followup-missing-baseline-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      const plansDir = join(wd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      await writeFile(
        join(plansDir, 'prd-issue-2086-missing-baseline.md'),
        '# Approved plan\n\nLaunch via omx team 3:executor "Execute approved issue 2086 missing-baseline plan"\n',
      );

      assert.throws(
        () => parseTeamStartArgs(['team']),
        /approved_execution_hint_nonready:team:missing-baseline/,
      );
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails short follow-up reuse when the latest approved handoff is incomplete', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-followup-incomplete-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      const plansDir = join(wd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      const prdPath = join(plansDir, 'prd-issue-2086-incomplete.md');
      const testSpecPath = join(plansDir, 'test-spec-issue-2086-incomplete.md');
      await writeFile(
        prdPath,
        [
          '# Approved plan',
          '',
          buildContextPackOutcome(canonicalContextPackRelativePath('issue-2086-incomplete')),
          '',
          'Launch via omx team 3:executor "Execute approved issue 2086 incomplete plan"',
        ].join('\n'),
      );
      await writeFile(testSpecPath, '# Test spec\n');
      await writeContextPack(wd, 'issue-2086-incomplete', prdPath, testSpecPath, ['scope']);

      assert.throws(
        () => parseTeamStartArgs(['team']),
        /approved_execution_hint_nonready:team:incomplete/,
      );
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed for a short follow-up when the persisted approved binding is malformed', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-followup-malformed-binding-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      const plansDir = join(wd, '.omx', 'plans');
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(plansDir, { recursive: true });
      await mkdir(join(stateDir, 'team', 'broken-team'), { recursive: true });
      await writeFile(
        join(plansDir, 'prd-issue-831.md'),
        '# Approved plan\n\nLaunch via omx team 3:executor "Execute approved issue 831 plan"\n',
      );
      await writeFile(join(plansDir, 'test-spec-issue-831.md'), '# Test spec\n');
      await writeFile(
        join(stateDir, 'team-state.json'),
        JSON.stringify({ active: true, team_name: 'broken-team' }, null, 2),
      );
      await writeFile(
        join(stateDir, 'team', 'broken-team', 'approved-execution.json'),
        '{"prd_path":42}',
        'utf-8',
      );

      assert.throws(
        () => parseTeamStartArgs(['team']),
        /approved_execution_binding_malformed:broken-team/,
      );
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed for a short follow-up when the persisted approved binding is stale even if a newer PRD is ready', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-followup-bound-stale-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      const plansDir = join(wd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      const stalePrdPath = join(plansDir, 'prd-issue-955-alpha.md');
      await writeFile(
        stalePrdPath,
        '# Approved plan\n\nLaunch via omx team 4:executor "Execute approved alpha plan"\n',
      );
      await writeFile(join(plansDir, 'test-spec-issue-955-alpha.md'), '# Test spec\n');
      await writeFile(
        join(plansDir, 'prd-issue-955-zeta.md'),
        '# Approved plan\n\nLaunch via omx team 6:debugger "Execute approved zeta plan"\n',
      );
      await writeFile(join(plansDir, 'test-spec-issue-955-zeta.md'), '# Test spec\n');
      await rm(stalePrdPath, { force: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'state', 'team-state.json'),
        JSON.stringify({
          active: true,
          team_name: 'bound-team-stale',
          task_description: 'Execute approved alpha plan',
          agent_count: 4,
        }, null, 2),
      );
      await writePersistedApprovedTeamExecutionBinding('bound-team-stale', wd, {
        prd_path: stalePrdPath,
        task: 'Execute approved alpha plan',
      });

      assert.throws(
        () => parseTeamStartArgs(['team']),
        /approved_execution_binding_stale:.*Execute approved alpha plan/,
      );
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed for a short follow-up when the persisted approved binding is ambiguous', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-followup-bound-ambiguous-'));
    const previousCwd = process.cwd();
    const approvedTask = 'Execute approved issue 956 plan';
    try {
      process.chdir(wd);
      const plansDir = join(wd, '.omx', 'plans');
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(plansDir, { recursive: true });
      await writeFile(
        join(plansDir, 'prd-issue-956.md'),
        [
          '# Approved plan',
          '',
          `Launch via omx team 4:executor "${approvedTask}"`,
          `Launch via omx team 6:debugger "${approvedTask}"`,
        ].join('\n'),
      );
      await writeFile(join(plansDir, 'test-spec-issue-956.md'), '# Test spec\n');
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, 'team-state.json'),
        JSON.stringify({
          active: true,
          team_name: 'bound-team-ambiguous',
          task_description: approvedTask,
          agent_count: 4,
        }, null, 2),
      );
      await writePersistedApprovedTeamExecutionBinding('bound-team-ambiguous', wd, {
        prd_path: join(plansDir, 'prd-issue-956.md'),
        task: approvedTask,
      });

      assert.throws(
        () => parseTeamStartArgs(['team']),
        /approved_execution_binding_ambiguous:.*Execute approved issue 956 plan/,
      );
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed for a short team follow-up when the selected PRD lists multiple team launch hints', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-followup-ambiguous-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      await mkdir(join(wd, '.omx', 'plans'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'plans', 'prd-issue-831-ambiguous.md'),
        [
          '# Approved plan',
          '',
          'Launch via omx team 3:executor "Execute approved issue 831 plan"',
          'Launch via omx team 5:debugger "Execute alternate issue 831 plan"',
        ].join('\n'),
      );
      await writeFile(join(wd, '.omx', 'plans', 'test-spec-issue-831-ambiguous.md'), '# Test spec\n');

      assert.throws(
        () => parseTeamStartArgs(['team']),
        /approved_execution_hint_ambiguous:team/,
      );
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });


  it('does not opt normal team startup into repo-aware DAG handoff even when a stale sidecar exists', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-dag-normal-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      await mkdir(join(wd, '.omx', 'plans'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'plans', 'prd-issue-831.md'),
        '# Approved plan\n\nLaunch via omx team 3:executor "Execute approved issue 831 plan"\n',
      );
      await writeFile(join(wd, '.omx', 'plans', 'test-spec-issue-831.md'), '# Test spec\n');
      await writeFile(join(wd, '.omx', 'plans', 'team-dag-issue-831.json'), '{"schema_version":1,"nodes":[{"id":"impl","subject":"Impl","description":"Impl"}]}\n');

      const result = parseTeamStartArgs(['3:executor', 'fix', 'unrelated', 'bug']);
      assert.equal(result.parsed.task, 'fix unrelated bug');
      assert.equal(result.parsed.allowRepoAwareDagHandoff, false);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('opts into repo-aware DAG handoff when the invocation matches the approved launch hint', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-dag-approved-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      await mkdir(join(wd, '.omx', 'plans'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'plans', 'prd-issue-831.md'),
        '# Approved plan\n\nLaunch via omx team 3:executor "Execute approved issue 831 plan"\n',
      );
      await writeFile(join(wd, '.omx', 'plans', 'test-spec-issue-831.md'), '# Test spec\n');

      const result = parseTeamStartArgs(['3:executor', 'Execute', 'approved', 'issue', '831', 'plan']);
      assert.equal(result.parsed.allowRepoAwareDagHandoff, true);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('attaches approved repository context summary only for matching ready team launches', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-context-approved-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      const plansDir = join(wd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      const prdPath = join(plansDir, 'prd-issue-2039.md');
      const testSpecPath = join(plansDir, 'test-spec-issue-2039.md');
      await writeFile(
        prdPath,
        [
          '# Approved plan',
          '',
          buildContextPackOutcome(canonicalContextPackRelativePath('issue-2039')),
          '',
          'Launch via omx team 3:executor "Execute approved issue 2039 plan"',
        ].join('\n'),
      );
      await writeFile(testSpecPath, '# Test spec\n');
      await writeReadyContextPack(wd, 'issue-2039', prdPath, testSpecPath);
      await writeFile(join(plansDir, 'repo-context-issue-2039.md'), 'Key boundary: latest approved handoff only.\n');

      const approved = parseTeamStartArgs(['3:executor', 'Execute', 'approved', 'issue', '2039', 'plan']);
      assert.equal(approved.parsed.approvedRepositoryContextSummary?.content, 'Key boundary: latest approved handoff only.');

      const unrelated = parseTeamStartArgs(['3:executor', 'fix', 'unrelated', 'bug']);
      assert.equal(unrelated.parsed.approvedRepositoryContextSummary, undefined);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps ready approved execution generic when staffing no longer matches the approved launch hint', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-context-ready-mismatch-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      const plansDir = join(wd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      const prdPath = join(plansDir, 'prd-issue-2040.md');
      const testSpecPath = join(plansDir, 'test-spec-issue-2040.md');
      await writeFile(
        prdPath,
        [
          '# Approved plan',
          '',
          buildContextPackOutcome(canonicalContextPackRelativePath('issue-2040')),
          '',
          'Launch via omx team 3:executor "Execute approved issue 2040 plan"',
        ].join('\n'),
      );
      await writeFile(testSpecPath, '# Test spec\n');
      await writeReadyContextPack(wd, 'issue-2040', prdPath, testSpecPath);
      await writeFile(join(plansDir, 'repo-context-issue-2040.md'), 'Keep approved context off generic mismatches.\n');

      const result = parseTeamStartArgs(['2:debugger', 'Execute', 'approved', 'issue', '2040', 'plan']);
      assert.equal(result.parsed.allowRepoAwareDagHandoff, false);
      assert.equal(result.parsed.approvedExecution, undefined);
      assert.equal(result.parsed.approvedRepositoryContextSummary, undefined);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not carry approved execution for explicit plan-only team launches', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-explicit-plan-only-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      await mkdir(join(wd, '.omx', 'plans'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'plans', 'prd-issue-2087.md'),
        '# Approved plan\n\nLaunch via omx team 3:executor "Execute approved issue 2087 plan"\n',
      );
      await writeFile(join(wd, '.omx', 'plans', 'test-spec-issue-2087.md'), '# Test spec\n');
      await writeFile(join(wd, '.omx', 'plans', 'repo-context-issue-2087.md'), 'Do not widen plan-only context.\n');

      const result = parseTeamStartArgs(['3:executor', 'Execute', 'approved', 'issue', '2087', 'plan']);
      assert.equal(result.parsed.allowRepoAwareDagHandoff, true);
      assert.equal(result.parsed.approvedExecution, undefined);
      assert.equal(result.parsed.approvedRepositoryContextSummary, undefined);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves lifecycle-specific DAG fallback reasons for explicit nonready approved launches', async () => {
    const previousCwd = process.cwd();
    const cases = [
      {
        name: 'missing-baseline',
        slug: 'issue-2090-missing-baseline',
        includeOutcome: false,
        writeTestSpec: false,
        packSetup: async (_wd: string, _prdPath: string, _testSpecPath: string) => {},
        expected: 'context_pack_not_followup_ready:missing-baseline',
      },
      {
        name: 'incomplete',
        slug: 'issue-2090-incomplete',
        includeOutcome: true,
        writeTestSpec: true,
        packSetup: async (wd: string, prdPath: string, testSpecPath: string) => {
          await writeContextPack(wd, 'issue-2090-incomplete', prdPath, testSpecPath, ['scope']);
        },
        expected: 'context_pack_not_followup_ready:incomplete',
      },
      {
        name: 'invalid',
        slug: 'issue-2090-invalid',
        includeOutcome: true,
        writeTestSpec: true,
        packSetup: async (_wd: string, _prdPath: string, _testSpecPath: string) => {},
        expected: 'context_pack_not_followup_ready:invalid',
      },
    ] as const;

    try {
      for (const scenario of cases) {
        const wd = await mkdtemp(join(tmpdir(), `omx-team-dag-fallback-${scenario.name}-`));
        try {
          process.chdir(wd);
          const plansDir = join(wd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, `prd-${scenario.slug}.md`);
          const testSpecPath = join(plansDir, `test-spec-${scenario.slug}.md`);
          const outcomePath = scenario.name === 'invalid'
            ? canonicalContextPackRelativePath('other')
            : canonicalContextPackRelativePath(scenario.slug);
          const prdSections = ['# Approved plan', ''];
          if (scenario.includeOutcome) {
            prdSections.push(buildContextPackOutcome(outcomePath), '');
          }
          prdSections.push(`Launch via omx team 3:executor "Execute approved ${scenario.name} DAG plan"`);
          await writeFile(
            prdPath,
            prdSections.join('\n'),
          );
          if (scenario.writeTestSpec) {
            await writeFile(testSpecPath, '# Test spec\n');
          }
          await writeFile(
            join(plansDir, `team-dag-${scenario.slug}.json`),
            '{"schema_version":1,"nodes":[{"id":"impl","subject":"Impl","description":"Impl"}]}\n',
          );
          await scenario.packSetup(wd, prdPath, testSpecPath);

          const parsed = parseTeamStartArgs(['3:executor', 'Execute', 'approved', scenario.name, 'DAG', 'plan']);
          const executionPlan = buildRepoAwareTeamExecutionPlan({
            task: parsed.parsed.task,
            workerCount: parsed.parsed.workerCount,
            agentType: parsed.parsed.agentType,
            explicitAgentType: parsed.parsed.explicitAgentType,
            explicitWorkerCount: parsed.parsed.explicitWorkerCount,
            cwd: wd,
            buildLegacyPlan: (task, workerCount, agentType) => ({
              workerCount,
              tasks: [{ subject: task, description: task, owner: 'worker-1', role: agentType }],
            }),
            allowDagHandoff: parsed.parsed.allowRepoAwareDagHandoff,
            dagFallbackReason: parsed.parsed.dagFallbackReason,
            approvedRepositoryContextSummary: parsed.parsed.approvedRepositoryContextSummary,
          });

          assert.equal(parsed.parsed.allowRepoAwareDagHandoff, false);
          assert.equal(parsed.parsed.dagFallbackReason, scenario.expected);
          assert.equal(parsed.parsed.approvedExecution, undefined);
          assert.equal(executionPlan.metadata?.decomposition_source, 'legacy_text');
          assert.equal(executionPlan.metadata?.fallback_reason, scenario.expected);
        } finally {
          process.chdir(previousCwd);
          await rm(wd, { recursive: true, force: true });
        }
      }
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('preserves explicit team staffing overrides while reusing the approved plan task', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-followup-override-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(wd);
      await mkdir(join(wd, '.omx', 'plans'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'plans', 'prd-issue-831.md'),
        '# Approved plan\n\nLaunch via omx team 3:executor "Execute approved issue 831 plan"\n',
      );
      await writeFile(join(wd, '.omx', 'plans', 'test-spec-issue-831.md'), '# Test spec\n');

      const result = parseTeamStartArgs(['2:debugger', 'team']);
      assert.equal(result.parsed.task, 'Execute approved issue 831 plan');
      assert.equal(result.parsed.workerCount, 2);
      assert.equal(result.parsed.agentType, 'debugger');
      assert.equal(result.parsed.explicitWorkerCount, true);
      assert.equal(result.parsed.explicitAgentType, true);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('teamCommand shutdown --force parsing', () => {
  it('parses --force flag from shutdown args', () => {
    const teamArgs = ['shutdown', 'my-team', '--force'];
    const force = teamArgs.includes('--force');
    assert.equal(force, true);
  });

  it('does not set force when --force is absent', () => {
    const teamArgs = ['shutdown', 'my-team'];
    const force = teamArgs.includes('--force');
    assert.equal(force, false);
  });

  it('parses --force regardless of position after subcommand', () => {
    const teamArgs = ['shutdown', '--force', 'my-team'];
    const force = teamArgs.includes('--force');
    assert.equal(force, true);
  });

  it('persists cancelled team mode state on shutdown even when no team mode state existed beforehand', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-shutdown-mode-state-'));
    const previousCwd = process.cwd();
    const originalLog = console.log;
    const originalWarn = console.warn;
    const logs: string[] = [];
    const warns: string[] = [];

    try {
      process.chdir(wd);
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'state', 'session.json'),
        JSON.stringify({ session_id: 'sess-team-shutdown-state' }),
      );
      await initTeamState(
        'team-shutdown-mode-state',
        'persist cancelled team mode state after shutdown',
        'executor',
        1,
        wd,
      );

      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      console.warn = (...args: unknown[]) => warns.push(args.map(String).join(' '));

      await teamCommand(['shutdown', 'team-shutdown-mode-state', '--force']);

      const state = await readModeState('team', wd);
      assert.ok(state);
      assert.equal(state?.active, false);
      assert.equal(state?.current_phase, 'cancelled');
      assert.equal(state?.team_name, 'team-shutdown-mode-state');
      assert.equal(warns.length, 0);
      assert.ok(
        logs.some((line) =>
          line.includes('Team shutdown complete: team-shutdown-mode-state')),
      );
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('persists cancelled session-scoped team mode state on shutdown', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-shutdown-session-mode-state-'));
    const previousCwd = process.cwd();
    const teamName = 'team-shutdown-scoped';

    try {
      process.chdir(wd);
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-team-shutdown-scoped';
      const scopedStateDir = join(stateDir, 'sessions', sessionId);
      await mkdir(scopedStateDir, { recursive: true });
      await writeFile(
        join(stateDir, 'session.json'),
        JSON.stringify({ session_id: sessionId }),
      );
      await writeFile(
        join(scopedStateDir, 'team-state.json'),
        JSON.stringify({
          active: true,
          mode: 'team',
          current_phase: 'team-exec',
          team_name: teamName,
        }, null, 2),
      );
      await initTeamState(
        teamName,
        'persist cancelled session-scoped team mode state after shutdown',
        'executor',
        1,
        wd,
      );

      await teamCommand(['shutdown', teamName, '--force']);

      const scopedState = JSON.parse(
        await readFile(join(scopedStateDir, 'team-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(scopedState.active, false);
      assert.equal(scopedState.current_phase, 'cancelled');
      assert.equal(scopedState.team_name, teamName);
      assert.ok(typeof scopedState.completed_at === 'string' && scopedState.completed_at.length > 0);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not create session-scoped team mode state on shutdown when only root team mode state exists', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-shutdown-root-mode-only-'));
    const previousCwd = process.cwd();
    const teamName = 'team-shutdown-root-only';
    const sessionId = 'sess-team-shutdown-root-only';

    try {
      process.chdir(wd);
      const stateDir = join(wd, '.omx', 'state');
      const scopedStatePath = join(stateDir, 'sessions', sessionId, 'team-state.json');
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, 'session.json'),
        JSON.stringify({ session_id: sessionId }),
      );
      await writeFile(
        join(stateDir, 'team-state.json'),
        JSON.stringify({
          active: true,
          mode: 'team',
          current_phase: 'team-exec',
          team_name: teamName,
        }, null, 2),
      );
      await initTeamState(
        teamName,
        'shutdown should not create scoped team mode state from a root-only mode state',
        'executor',
        1,
        wd,
      );

      await teamCommand(['shutdown', teamName, '--force']);

      assert.equal(existsSync(scopedStatePath), false);
      const rootState = JSON.parse(
        await readFile(join(stateDir, 'team-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(rootState.active, false);
      assert.equal(rootState.current_phase, 'cancelled');
      assert.equal(rootState.team_name, teamName);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not create session-scoped team mode state on shutdown when a stale session.json remains', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-shutdown-stale-session-json-'));
    const previousCwd = process.cwd();
    const teamName = 'team-shutdown-stale-session';
    const staleSessionId = 'sess-team-shutdown-stale';

    try {
      process.chdir(wd);
      const stateDir = join(wd, '.omx', 'state');
      const staleSessionDir = join(stateDir, 'sessions', staleSessionId);
      const scopedStatePath = join(staleSessionDir, 'team-state.json');
      await mkdir(staleSessionDir, { recursive: true });
      await writeFile(
        join(stateDir, 'session.json'),
        JSON.stringify({ session_id: staleSessionId }),
      );
      await writeFile(
        join(staleSessionDir, 'hud-state.json'),
        JSON.stringify({ turn_count: 12 }, null, 2),
      );
      await writeFile(
        join(stateDir, 'team-state.json'),
        JSON.stringify({
          active: true,
          mode: 'team',
          current_phase: 'team-exec',
          team_name: teamName,
        }, null, 2),
      );
      await initTeamState(
        teamName,
        'shutdown should ignore stale session.json when only root team mode state exists',
        'executor',
        1,
        wd,
      );

      await teamCommand(['shutdown', teamName, '--force']);

      assert.equal(existsSync(scopedStatePath), false);
      const rootState = JSON.parse(
        await readFile(join(stateDir, 'team-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(rootState.active, false);
      assert.equal(rootState.current_phase, 'cancelled');
      assert.equal(rootState.team_name, teamName);
    } finally {
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('parses --confirm-issues from shutdown args', () => {
    const teamArgs = ['shutdown', 'my-team', '--confirm-issues'];
    const confirmIssues = teamArgs.includes('--confirm-issues');
    assert.equal(confirmIssues, true);
  });

  it('keeps the shutdown CLI alive while tearing down a shared leader tmux session', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-shutdown-shared-cli-'));
    const binDir = join(wd, 'bin');
    const tmuxLogPath = join(wd, 'tmux.log');
    const tmuxPath = join(binDir, 'tmux');
    const previousPath = process.env.PATH;

    await mkdir(binDir, { recursive: true });
    await writeFile(
      tmuxPath,
      `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-F #{pane_dead} #{pane_pid}"*)
        exit 1
        ;;
      *"-t leader:0 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tzsh\\n%%12\\tnode\\tnode /tmp/bin/omx.js hud --watch\\n%%13\\tcodex\\tcodex\\n%%14\\tcodex\\tcodex\\n"
        exit 0
        ;;
      *"-t leader:0 -F #{pane_id}"*)
        printf "%%11\\n%%12\\n%%13\\n%%14\\n"
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  split-window)
    printf '%%44\\n'
    exit 0
    ;;
  kill-pane)
    # Shared-session runtime coverage should validate pane-targeted teardown
    # only. Detached leader-wrapper signal behavior is covered separately in
    # cli/index detached-session tests.
    exit 0
    ;;
  resize-pane|select-pane|has-session|show-options|show-hooks|set-hook|set-option)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
    );
    await chmod(tmuxPath, 0o755);

    try {
      await initTeamState('shared-shutdown-cli', 'shared shutdown cli test', 'executor', 2, wd);
      const config = await readTeamConfig('shared-shutdown-cli', wd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'leader:0';
      config.leader_pane_id = '%11';
      config.hud_pane_id = '%12';
      config.workers[0]!.pane_id = '%13';
      config.workers[1]!.pane_id = '%14';
      await saveTeamConfig(config, wd);

      const result = await runNodeCli(['team', 'shutdown', 'shared-shutdown-cli', '--force'], {
        cwd: wd,
        env: {
          ...process.env,
          PATH: `${binDir}:${previousPath ?? ''}`,
          OMX_TEAM_STATE_ROOT: join(wd, '.omx', 'state'),
        },
      });

      assert.equal(result.signal, null, `shutdown CLI received signal ${result.signal ?? 'none'}\n${result.stderr}`);
      assert.equal(result.code, 0, `shutdown CLI exit=${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stdout, /Team shutdown complete: shared-shutdown-cli/);
      assert.equal(existsSync(join(wd, '.omx', 'state', 'team', 'shared-shutdown-cli')), false);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /kill-pane -t %12/);
      assert.match(tmuxLog, /kill-pane -t %13/);
      assert.match(tmuxLog, /kill-pane -t %14/);
      assert.doesNotMatch(tmuxLog, /kill-pane -t %11/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps the shutdown command alive when executed inside the leader pane PTY', { concurrency: false }, async (t) => {
    skipUnlessTmux(t);

    const wd = await mkdtemp(join(tmpdir(), 'omx-team-shutdown-shared-in-pane-'));
    try {
      await withTempTmuxSession(async (fixture) => {
        const teamName = 'shared-shutdown-in-pane';
        const teamStateRoot = join(wd, '.omx', 'state');
        const hudPaneId = runFixtureTmux(fixture, ['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', fixture.windowTarget, 'sleep 300']);
        const workerPaneOne = runFixtureTmux(fixture, ['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', fixture.windowTarget, 'sleep 300']);
        const workerPaneTwo = runFixtureTmux(fixture, ['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', fixture.windowTarget, 'sleep 300']);

        await initTeamState(teamName, 'shared shutdown in-pane test', 'executor', 2, wd);
        const config = await readTeamConfig(teamName, wd);
        assert.ok(config);
        if (!config) return;
        config.tmux_session = fixture.windowTarget;
        config.leader_pane_id = fixture.leaderPaneId;
        config.hud_pane_id = hudPaneId;
        config.workers[0]!.pane_id = workerPaneOne;
        config.workers[1]!.pane_id = workerPaneTwo;
        await saveTeamConfig(config, wd);

        const result = await runNodeCli(['team', 'shutdown', teamName, '--force'], {
          cwd: wd,
          env: {
            ...process.env,
            OMX_AUTO_UPDATE: '0',
            OMX_TEAM_STATE_ROOT: teamStateRoot,
            TMUX: fixture.env.TMUX,
            TMUX_PANE: fixture.leaderPaneId,
          },
        });

        assert.equal(result.signal, null, `shutdown CLI received signal ${result.signal ?? 'none'}\n${result.stderr}`);
        assert.equal(result.code, 0, `shutdown CLI exit=${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        const stdout = result.stdout;
        assert.match(stdout, new RegExp(`Team shutdown complete: ${teamName}`));
        assert.equal(existsSync(join(teamStateRoot, 'team', teamName)), false);
        assert.equal(fixturePaneExists(fixture, fixture.leaderPaneId), true, 'leader pane should remain alive');
        // Exact HUD/worker-pane teardown is covered in runtime shutdown tests.
        // This CLI test owns the stable operator contract: the command must not
        // die by signal, it must exit 0, and explicit shutdown must remove team
        // state while preserving leader survival in a real tmux client context.
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('teamCommand api', () => {
  it('builds leader monitoring hints that keep team status visible while ON', () => {
    const hints = buildLeaderMonitoringHints('My Team');
    assert.equal(hints[0], 'leader_check: omx team status my-team');
    assert.match(hints[1] ?? '', /while ON, keep checking state/);
    assert.match(hints[1] ?? '', /sleep 30 && omx team status my-team/);
  });

  it('prints team-specific help for omx team --help', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['--help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team \[N:agent-type\]/);
      assert.match(logs[0] ?? '', /omx team api <operation>/);
      assert.match(logs[0] ?? '', /dedicated worktrees automatically by default/);
      assert.match(logs[0] ?? '', /--worktree is deprecated/);
      assert.match(logs[0] ?? '', /tmux-runtime surface by default/);
      assert.match(logs[0] ?? '', /Codex App or plain outside-tmux sessions/);
      assert.match(logs[0] ?? '', /native Codex subagents for small in-session fanout/);
    } finally {
      console.log = originalLog;
    }
  });

  it('prints team-specific help for omx team help alias', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team \[N:agent-type\]/);
      assert.match(logs[0] ?? '', /omx team api <operation>/);
      assert.match(logs[0] ?? '', /dedicated worktrees automatically by default/);
      assert.match(logs[0] ?? '', /--worktree is deprecated/);
      assert.match(logs[0] ?? '', /tmux-runtime surface by default/);
      assert.match(logs[0] ?? '', /Codex App or plain outside-tmux sessions/);
    } finally {
      console.log = originalLog;
    }
  });

  it('prints team-api-specific help for omx team api --help', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['api', '--help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team api <operation>/);
      assert.match(logs[0] ?? '', /send-message/);
      assert.match(logs[0] ?? '', /transition-task-status/);
      assert.match(logs[0] ?? '', /read-idle-state/);
      assert.match(logs[0] ?? '', /read-stall-state/);
    } finally {
      console.log = originalLog;
    }
  });

  it('prints team-api-specific help for omx team api help alias', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['api', 'help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team api <operation>/);
      assert.match(logs[0] ?? '', /send-message/);
      assert.match(logs[0] ?? '', /transition-task-status/);
    } finally {
      console.log = originalLog;
    }
  });

  it('prints operation-specific help for omx team api <operation> --help', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['api', 'send-message', '--help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team api send-message --input <json> \[--json\]/);
      assert.match(logs[0] ?? '', /Required input fields/);
      assert.match(logs[0] ?? '', /from_worker/);
      assert.match(logs[0] ?? '', /to_worker/);
      assert.match(logs[0] ?? '', /body/);
    } finally {
      console.log = originalLog;
    }
  });

  it('prints operation-specific help for omx team api <operation> help alias', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['api', 'claim-task', 'help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team api claim-task --input <json> \[--json\]/);
      assert.match(logs[0] ?? '', /expected_version/);
    } finally {
      console.log = originalLog;
    }
  });

  it('prints event query help for omx team api read-events help alias', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand(['api', 'read-events', 'help']);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? '', /Usage: omx team api read-events --input <json> \[--json\]/);
      assert.match(logs[0] ?? '', /after_event_id/);
      assert.match(logs[0] ?? '', /wakeable_only/);
      assert.match(logs[0] ?? '', /worker_idle/);
    } finally {
      console.log = originalLog;
    }
  });

  it('executes read-events via CLI api with canonical JSON results', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-api-read-events-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      await initTeamState('api-read-events', 'api event test', 'executor', 1, wd);
      await appendTeamEvent('api-read-events', {
        type: 'worker_idle',
        worker: 'worker-1',
        task_id: '1',
        prev_state: 'working',
      }, wd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

      await teamCommand([
        'api',
        'read-events',
        '--input',
        JSON.stringify({
          team_name: 'api-read-events',
          type: 'worker_idle',
          worker: 'worker-1',
          task_id: '1',
        }),
        '--json',
      ]);

      assert.equal(logs.length, 1);
      const envelope = JSON.parse(logs[0]) as {
        command?: string;
        ok?: boolean;
        operation?: string;
        data?: {
          count?: number;
          events?: Array<{ type?: string; source_type?: string; worker?: string; task_id?: string }>;
        };
      };
      assert.equal(envelope.command, 'omx team api read-events');
      assert.equal(envelope.ok, true);
      assert.equal(envelope.operation, 'read-events');
      assert.equal(envelope.data?.count, 1);
      assert.equal(envelope.data?.events?.[0]?.type, 'worker_state_changed');
      assert.equal(envelope.data?.events?.[0]?.source_type, 'worker_idle');
      assert.equal(envelope.data?.events?.[0]?.worker, 'worker-1');
      assert.equal(envelope.data?.events?.[0]?.task_id, '1');
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('executes read-idle-state via CLI api with structured JSON results', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-api-read-idle-state-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      await initTeamState('api-read-idle', 'api idle state test', 'executor', 2, wd);
      await writeMonitorSnapshot('api-read-idle', {
        taskStatusById: {},
        workerAliveByName: { 'worker-1': true, 'worker-2': true },
        workerStateByName: { 'worker-1': 'idle', 'worker-2': 'working' },
        workerTurnCountByName: { 'worker-1': 2, 'worker-2': 4 },
        workerTaskIdByName: { 'worker-1': '', 'worker-2': '1' },
        mailboxNotifiedByMessageId: {},
        completedEventTaskIds: {},
      }, wd);
      await appendTeamEvent('api-read-idle', {
        type: 'worker_idle',
        worker: 'worker-1',
        task_id: '1',
        prev_state: 'working',
      }, wd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

      await teamCommand([
        'api',
        'read-idle-state',
        '--input',
        JSON.stringify({ team_name: 'api-read-idle' }),
        '--json',
      ]);

      assert.equal(logs.length, 1);
      const envelope = JSON.parse(logs[0]) as {
        command?: string;
        ok?: boolean;
        operation?: string;
        data?: {
          all_workers_idle?: boolean;
          idle_worker_count?: number;
          idle_workers?: string[];
          non_idle_workers?: string[];
          last_idle_transition_by_worker?: Record<string, { source_type?: string } | null>;
        };
      };
      assert.equal(envelope.command, 'omx team api read-idle-state');
      assert.equal(envelope.ok, true);
      assert.equal(envelope.operation, 'read-idle-state');
      assert.equal(envelope.data?.all_workers_idle, false);
      assert.equal(envelope.data?.idle_worker_count, 1);
      assert.deepEqual(envelope.data?.idle_workers, ['worker-1']);
      assert.deepEqual(envelope.data?.non_idle_workers, ['worker-2']);
      assert.equal(envelope.data?.last_idle_transition_by_worker?.['worker-1']?.source_type, 'worker_idle');
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('executes read-stall-state via CLI api with structured JSON results', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-api-read-stall-state-'));
    const previousCwd = process.cwd();
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      delete process.env.OMX_TEAM_STATE_ROOT;
      process.chdir(wd);
      await initTeamState('api-read-stall', 'api stall state test', 'executor', 2, wd);
      const task = await createTask('api-read-stall', {
        subject: 'Pending work',
        description: 'Needs leader attention',
        status: 'pending',
      }, wd);
      await writeWorkerStatus('api-read-stall', 'worker-1', {
        state: 'working',
        current_task_id: task.id,
        updated_at: '2026-03-10T10:00:00.000Z',
      }, wd);
      await writeWorkerStatus('api-read-stall', 'worker-2', {
        state: 'idle',
        updated_at: '2026-03-10T10:00:00.000Z',
      }, wd);
      await updateWorkerHeartbeat('api-read-stall', 'worker-1', {
        alive: true,
        pid: 201,
        turn_count: 1,
        last_turn_at: '2026-03-10T10:00:00.000Z',
      }, wd);
      await updateWorkerHeartbeat('api-read-stall', 'worker-2', {
        alive: true,
        pid: 202,
        turn_count: 1,
        last_turn_at: '2026-03-10T10:00:00.000Z',
      }, wd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await teamCommand([
        'api',
        'get-summary',
        '--input',
        JSON.stringify({ team_name: 'api-read-stall' }),
        '--json',
      ]);
      logs.length = 0;

      await updateWorkerHeartbeat('api-read-stall', 'worker-1', {
        alive: true,
        pid: 201,
        turn_count: 8,
        last_turn_at: '2026-03-10T10:05:00.000Z',
      }, wd);
      await writeMonitorSnapshot('api-read-stall', {
        taskStatusById: { [task.id]: 'pending' },
        workerAliveByName: { 'worker-1': true, 'worker-2': true },
        workerStateByName: { 'worker-1': 'idle', 'worker-2': 'idle' },
        workerTurnCountByName: { 'worker-1': 8, 'worker-2': 1 },
        workerTaskIdByName: { 'worker-1': task.id, 'worker-2': '' },
        mailboxNotifiedByMessageId: {},
        completedEventTaskIds: {},
      }, wd);
      await mkdir(join(wd, '.omx', 'state', 'team', 'api-read-stall'), { recursive: true });
      await writeFile(join(wd, '.omx', 'state', 'team', 'api-read-stall', 'leader-attention.json'), JSON.stringify({
        team_name: 'api-read-stall',
        updated_at: '2026-03-10T10:05:00.000Z',
        source: 'native_stop',
        leader_decision_state: 'still_actionable',
        leader_attention_pending: true,
        leader_attention_reason: 'leader_session_stopped',
        attention_reasons: ['leader_session_stopped'],
        leader_stale: false,
        leader_session_active: false,
        leader_session_id: 'leader-session-1',
        leader_session_stopped_at: '2026-03-10T10:05:00.000Z',
        unread_leader_message_count: 1,
        work_remaining: true,
        stalled_for_ms: null,
      }, null, 2));

      await teamCommand([
        'api',
        'read-stall-state',
        '--input',
        JSON.stringify({ team_name: 'api-read-stall' }),
        '--json',
      ]);

      assert.equal(logs.length, 1);
      const envelope = JSON.parse(logs[0]) as {
        command?: string;
        ok?: boolean;
        operation?: string;
        data?: {
          team_stalled?: boolean;
          leader_stale?: boolean;
          stalled_workers?: string[];
          reasons?: string[];
        };
      };
      assert.equal(envelope.command, 'omx team api read-stall-state');
      assert.equal(envelope.ok, true);
      assert.equal(envelope.operation, 'read-stall-state');
      assert.equal(envelope.data?.team_stalled, true);
      assert.equal(envelope.data?.leader_stale, true);
      assert.deepEqual(envelope.data?.stalled_workers, ['worker-1']);
      assert.match((envelope.data?.reasons ?? []).join(' '), /leader_attention_pending:leader_session_stopped/);
    } finally {
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('executes CLI interop operation with stable JSON envelope', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-api-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      await initTeamState('api-team', 'api test', 'executor', 1, wd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

      await teamCommand([
        'api',
        'send-message',
        '--input',
        JSON.stringify({
          team_name: 'api-team',
          from_worker: 'worker-1',
          to_worker: 'leader-fixed',
          body: 'ACK',
        }),
        '--json',
      ]);

      assert.equal(logs.length, 1);
      const envelope = JSON.parse(logs[0]) as {
        schema_version?: string;
        timestamp?: string;
        command?: string;
        ok?: boolean;
        operation?: string;
        data?: { message?: { body?: string } };
      };
      assert.equal(envelope.schema_version, '1.0');
      assert.equal(typeof envelope.timestamp, 'string');
      assert.equal(envelope.command, 'omx team api send-message');
      assert.equal(envelope.ok, true);
      assert.equal(envelope.operation, 'send-message');
      assert.equal(envelope.data?.message?.body, 'ACK');
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('returns deterministic JSON errors for invalid api usage with --json', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      process.exitCode = 0;
      await teamCommand(['api', 'unknown-operation', '--json']);
      assert.equal(logs.length, 1);
      const envelope = JSON.parse(logs[0]) as {
        schema_version?: string;
        timestamp?: string;
        command?: string;
        ok?: boolean;
        operation?: string;
        error?: { code?: string; message?: string };
      };
      assert.equal(envelope.schema_version, '1.0');
      assert.equal(typeof envelope.timestamp, 'string');
      assert.equal(envelope.command, 'omx team api');
      assert.equal(envelope.ok, false);
      assert.equal(envelope.operation, 'unknown');
      assert.equal(envelope.error?.code, 'invalid_input');
      assert.match(envelope.error?.message ?? '', /Usage: omx team api/);
      assert.equal(process.exitCode, 1);
    } finally {
      console.log = originalLog;
      process.exitCode = 0;
    }
  });

  it('supports claim-safe lifecycle via CLI api (create -> claim -> transition)', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-api-lifecycle-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      await initTeamState('lifecycle-team', 'lifecycle test', 'executor', 1, wd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

      await teamCommand([
        'api',
        'create-task',
        '--input',
        JSON.stringify({
          team_name: 'lifecycle-team',
          subject: 'Lifecycle task',
          description: 'Created through CLI interop',
        }),
        '--json',
      ]);
      const created = JSON.parse(logs.at(-1) ?? '{}') as {
        ok?: boolean;
        data?: { task?: { id?: string } };
      };
      assert.equal(created.ok, true);
      const taskId = created.data?.task?.id;
      assert.equal(typeof taskId, 'string');

      await teamCommand([
        'api',
        'claim-task',
        '--input',
        JSON.stringify({
          team_name: 'lifecycle-team',
          task_id: taskId,
          worker: 'worker-1',
          expected_version: 1,
        }),
        '--json',
      ]);
      const claimed = JSON.parse(logs.at(-1) ?? '{}') as {
        ok?: boolean;
        data?: { claimToken?: string };
      };
      assert.equal(claimed.ok, true);
      const claimToken = claimed.data?.claimToken;
      assert.equal(typeof claimToken, 'string');

      await teamCommand([
        'api',
        'transition-task-status',
        '--input',
        JSON.stringify({
          team_name: 'lifecycle-team',
          task_id: taskId,
          from: 'in_progress',
          to: 'completed',
          claim_token: claimToken,
        }),
        '--json',
      ]);
      const transitioned = JSON.parse(logs.at(-1) ?? '{}') as {
        ok?: boolean;
        data?: { ok?: boolean; task?: { status?: string } };
      };
      assert.equal(transitioned.ok, true);
      assert.equal(transitioned.data?.ok, true);
      assert.equal(transitioned.data?.task?.status, 'completed');
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });


  it('accepts new canonical event types via CLI api append-event', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-api-event-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      await initTeamState('event-team', 'event test', 'executor', 1, wd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

      await teamCommand([
        'api',
        'append-event',
        '--input',
        JSON.stringify({
          team_name: 'event-team',
          type: 'leader_notification_deferred',
          worker: 'worker-1',
          to_worker: 'leader-fixed',
          source_type: 'worker_idle',
          reason: 'leader_pane_missing_no_injection',
        }),
        '--json',
      ]);

      const envelope = JSON.parse(logs.at(-1) ?? '{}') as {
        ok?: boolean;
        data?: { event?: { type?: string; to_worker?: string; reason?: string; source_type?: string } };
      };
      assert.equal(envelope.ok, true);
      assert.equal(envelope.data?.event?.type, 'leader_notification_deferred');
      assert.equal(envelope.data?.event?.to_worker, 'leader-fixed');
      assert.equal(envelope.data?.event?.source_type, 'worker_idle');
      assert.equal(envelope.data?.event?.reason, 'leader_pane_missing_no_injection');
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });
});


describe('teamCommand status', () => {
  it('prints pane ids and raw inspect hints when tmux panes are recorded', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-status-panes-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      const config = await withoutTeamTestWorkerEnv(() => initTeamState('pane-team', 'inspect worker panes', 'executor', 2, wd));
      await withoutTeamTestWorkerEnv(() => createTask('pane-team', {
        subject: 'Recover worker-1 progress',
        description: 'Inspect worker-1 pane',
        status: 'pending',
        version: 3,
        requires_code_change: true,
        role: 'debugger',
        owner: 'worker-1',
      }, wd));
      await withoutTeamTestWorkerEnv(() => createTask('pane-team', {
        subject: 'Recover worker-2 progress',
        description: 'Inspect worker-2 pane',
        status: 'pending',
        version: 4,
        requires_code_change: false,
        blocked_by: ['1'],
        depends_on: ['1'],
        role: 'test-engineer',
        owner: 'worker-2',
        result: 'waiting on worker-1',
        error: 'blocked by dependency',
      }, wd));
      await writeFile(
        join(wd, '.omx', 'state', 'team', 'pane-team', 'tasks', 'task-1.json'),
        `${JSON.stringify({
          ...JSON.parse(await readFile(join(wd, '.omx', 'state', 'team', 'pane-team', 'tasks', 'task-1.json'), 'utf-8')) as Record<string, unknown>,
          created_at: '2026-03-10T23:55:00.000Z',
          claim: {
            owner: 'worker-1',
            token: 'claim-token-1',
            leased_until: '2026-03-11T00:10:00.000Z',
          },
        }, null, 2)}\n`,
      );
      await writeFile(
        join(wd, '.omx', 'state', 'team', 'pane-team', 'tasks', 'task-2.json'),
        `${JSON.stringify({
          ...JSON.parse(await readFile(join(wd, '.omx', 'state', 'team', 'pane-team', 'tasks', 'task-2.json'), 'utf-8')) as Record<string, unknown>,
          created_at: '2026-03-10T23:56:00.000Z',
          completed_at: '2026-03-11T00:06:00.000Z',
        }, null, 2)}\n`,
      );
      config.workers[0]!.worker_cli = 'codex';
      config.workers[1]!.worker_cli = 'gemini';
      config.workers[0]!.pid = 101;
      config.workers[1]!.pid = 102;
      config.workers[0]!.assigned_tasks = ['1'];
      config.workers[1]!.assigned_tasks = ['2', '3'];
      config.leader_pane_id = '%10';
      config.hud_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      config.workers[1]!.pane_id = '%22';
      config.workers[0]!.working_dir = '/tmp/pane-team/worker-1';
      config.workers[1]!.working_dir = '/tmp/pane-team/worker-2';
      config.workers[0]!.worktree_repo_root = '/tmp/pane-team/repo';
      config.workers[1]!.worktree_repo_root = '/tmp/pane-team/repo';
      config.workers[0]!.team_state_root = '/tmp/pane-team/.omx/state';
      config.workers[1]!.team_state_root = '/tmp/pane-team/.omx/state';
      config.workers[0]!.worktree_path = '/tmp/pane-team/worktrees/worker-1';
      config.workers[1]!.worktree_path = '/tmp/pane-team/worktrees/worker-2';
      config.workers[0]!.worktree_branch = 'feat/pane-team-worker-1';
      config.workers[1]!.worktree_branch = 'feat/pane-team-worker-2';
      config.workers[0]!.worktree_detached = false;
      config.workers[1]!.worktree_detached = true;
      config.workers[0]!.worktree_created = true;
      config.workers[1]!.worktree_created = false;
      await writeWorkerStatus('pane-team', 'worker-1', {
        state: 'working',
        current_task_id: '1',
        reason: 'recovering progress',
        updated_at: '2026-03-11T00:00:00.000Z',
      }, wd);
      await writeWorkerStatus('pane-team', 'worker-2', {
        state: 'blocked',
        current_task_id: '2',
        reason: 'waiting for dependency 1',
        updated_at: '2026-03-11T00:00:00.000Z',
      }, wd);
      await updateWorkerHeartbeat('pane-team', 'worker-1', {
        pid: 101,
        last_turn_at: '2026-03-11T00:01:00.000Z',
        turn_count: 3,
        alive: false,
      }, wd);
      await updateWorkerHeartbeat('pane-team', 'worker-2', {
        pid: 102,
        last_turn_at: '2026-03-11T00:02:00.000Z',
        turn_count: 4,
        alive: false,
      }, wd);
      await writeTaskApproval('pane-team', {
        task_id: '1',
        required: true,
        status: 'approved',
        reviewer: 'leader-fixed',
        decision_reason: 'Looks good',
        decided_at: '2026-03-11T00:05:00.000Z',
      }, wd);
      const manifestPath = join(wd, '.omx', 'state', 'team', 'pane-team', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
        leader_pane_id?: string | null;
        hud_pane_id?: string | null;
        workers?: Array<{ pane_id?: string }>;
      };
      manifest.leader_pane_id = config.leader_pane_id;
      manifest.hud_pane_id = config.hud_pane_id;
      manifest.workers = config.workers.map((worker) => ({
        ...worker,
        pane_id: worker.pane_id,
      }));
      await writeFile(
        join(wd, '.omx', 'state', 'team', 'pane-team', 'config.json'),
        `${JSON.stringify(config, null, 2)}\n`,
      );
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
      );

      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await withoutTeamTestWorkerEnv(() => teamCommand(['status', 'pane-team']));

      const output = logs.join('\n');
      assert.match(output, /panes: leader=%10 hud=%11/);
      assert.match(output, /worker_panes: worker-1=%21 worker-2=%22/);
      assert.match(output, /inspect_hint: raw tmux capture commands are quota-free/);
      assert.match(output, /inspect_leader: tmux capture-pane -p -t %10 -S -400/);
      assert.match(output, /inspect_hud: tmux capture-pane -p -t %11 -S -400/);
      assert.match(output, /inspect_worker-1: tmux capture-pane -p -t %21 -S -400/);
      assert.match(output, /inspect_worker-2: tmux capture-pane -p -t %22 -S -400/);
      assert.match(output, /inspect_summary: .*command=tmux capture-pane -p -t %21 -S -400/);
      assert.doesNotMatch(output
        .split('\n')
        .filter((line) => !line.includes('--model-inspect'))
        .join('\n'), /omx sparkshell/);

      logs.length = 0;
      await withoutTeamTestWorkerEnv(() => teamCommand(['status', 'pane-team', '--model-inspect']));
      const modelInspectOutput = logs.join('\n');
      assert.match(modelInspectOutput, /inspect_summary: .*command=omx sparkshell --tmux-pane %21 --tail-lines 400/);
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('returns pane ids and sparkshell hint in JSON mode', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-status-json-'));
    const previousCwd = process.cwd();
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      delete process.env.OMX_TEAM_STATE_ROOT;
      process.chdir(wd);
      const config = await withoutTeamTestWorkerEnv(() => initTeamState('pane-json-team', 'inspect worker panes', 'executor', 1, wd));
      await withoutTeamTestWorkerEnv(() => createTask('pane-json-team', {
        subject: 'Recover worker-1 progress',
        description: 'Inspect worker-1 pane',
        status: 'pending',
        version: 7,
        requires_code_change: true,
        role: 'debugger',
        owner: 'worker-1',
      }, wd));
      await writeFile(
        join(wd, '.omx', 'state', 'team', 'pane-json-team', 'tasks', 'task-1.json'),
        `${JSON.stringify({
          ...JSON.parse(await readFile(join(wd, '.omx', 'state', 'team', 'pane-json-team', 'tasks', 'task-1.json'), 'utf-8')) as Record<string, unknown>,
          created_at: '2026-03-10T23:57:00.000Z',
          claim: {
            owner: 'worker-1',
            token: 'claim-token-1',
            leased_until: '2026-03-11T00:11:00.000Z',
          },
        }, null, 2)}\n`,
      );
      config.workers[0]!.worker_cli = 'claude';
      config.workers[0]!.pid = 201;
      config.workers[0]!.assigned_tasks = ['1', 'extra-2'];
      config.leader_pane_id = '%30';
      config.hud_pane_id = '%31';
      config.workers[0]!.pane_id = '%41';
      config.workers[0]!.working_dir = '/tmp/pane-json-team/worker-1';
      config.workers[0]!.worktree_repo_root = '/tmp/pane-json-team/repo';
      config.workers[0]!.team_state_root = '/tmp/pane-json-team/.omx/state';
      config.workers[0]!.worktree_path = '/tmp/pane-json-team/worktrees/worker-1';
      config.workers[0]!.worktree_branch = 'feat/pane-json-team-worker-1';
      config.workers[0]!.worktree_detached = false;
      config.workers[0]!.worktree_created = true;
      await writeWorkerStatus('pane-json-team', 'worker-1', {
        state: 'working',
        current_task_id: '1',
        reason: 'recovering progress',
        updated_at: '2026-03-11T00:00:00.000Z',
      }, wd);
      await updateWorkerHeartbeat('pane-json-team', 'worker-1', {
        pid: 201,
        last_turn_at: '2026-03-11T00:03:00.000Z',
        turn_count: 5,
        alive: false,
      }, wd);
      await writeTaskApproval('pane-json-team', {
        task_id: '1',
        required: true,
        status: 'approved',
        reviewer: 'leader-fixed',
        decision_reason: 'Looks good',
        decided_at: '2026-03-11T00:05:00.000Z',
      }, wd);
      const manifestPath = join(wd, '.omx', 'state', 'team', 'pane-json-team', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
        leader_pane_id?: string | null;
        hud_pane_id?: string | null;
        workers?: Array<{ pane_id?: string }>;
      };
      manifest.leader_pane_id = config.leader_pane_id;
      manifest.hud_pane_id = config.hud_pane_id;
      manifest.workers = config.workers.map((worker) => ({
        ...worker,
        pane_id: worker.pane_id,
      }));
      await writeFile(
        join(wd, '.omx', 'state', 'team', 'pane-json-team', 'config.json'),
        `${JSON.stringify(config, null, 2)}\n`,
      );
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
      );

      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await withoutTeamTestWorkerEnv(() => teamCommand(['status', 'pane-json-team', '--json']));

      const payload = JSON.parse(logs.at(-1) ?? '{}') as {
        schema_version?: string;
        timestamp?: string;
        command?: string;
        team_name?: string;
        status?: string;
        dead_workers?: string[];
        non_reporting_workers?: string[];
        panes?: {
          leader_pane_id?: string | null;
          hud_pane_id?: string | null;
          worker_panes?: Record<string, string>;
          sparkshell_hint?: string | null;
          sparkshell_commands?: Record<string, string>;
          recommended_inspect_targets?: string[];
          recommended_inspect_reasons?: Record<string, string>;
          recommended_inspect_clis?: Record<string, string | null>;
          recommended_inspect_roles?: Record<string, string | null>;
          recommended_inspect_indexes?: Record<string, number | null>;
          recommended_inspect_alive?: Record<string, boolean | null>;
          recommended_inspect_turn_counts?: Record<string, number | null>;
          recommended_inspect_turns_without_progress?: Record<string, number | null>;
          recommended_inspect_last_turn_at?: Record<string, string | null>;
          recommended_inspect_status_updated_at?: Record<string, string | null>;
          recommended_inspect_pids?: Record<string, number | null>;
          recommended_inspect_worktree_paths?: Record<string, string | null>;
          recommended_inspect_worktree_repo_roots?: Record<string, string | null>;
          recommended_inspect_worktree_branches?: Record<string, string | null>;
          recommended_inspect_worktree_detached?: Record<string, boolean | null>;
          recommended_inspect_worktree_created?: Record<string, boolean | null>;
          recommended_inspect_team_state_roots?: Record<string, string | null>;
          recommended_inspect_workdirs?: Record<string, string | null>;
          recommended_inspect_assigned_tasks?: Record<string, string[]>;
          recommended_inspect_task_statuses?: Record<string, string | null>;
          recommended_inspect_task_results?: Record<string, string | null>;
          recommended_inspect_task_errors?: Record<string, string | null>;
          recommended_inspect_task_versions?: Record<string, number | null>;
          recommended_inspect_task_created_at?: Record<string, string | null>;
          recommended_inspect_task_completed_at?: Record<string, string | null>;
          recommended_inspect_task_depends_on?: Record<string, string[]>;
          recommended_inspect_task_claim_present?: Record<string, boolean | null>;
          recommended_inspect_task_claim_owners?: Record<string, string | null>;
          recommended_inspect_task_claim_tokens?: Record<string, string | null>;
          recommended_inspect_task_claim_leases?: Record<string, string | null>;
          recommended_inspect_approval_required?: Record<string, boolean | null>;
          recommended_inspect_requires_code_change?: Record<string, boolean | null>;
          recommended_inspect_descriptions?: Record<string, string | null>;
          recommended_inspect_blocked_by?: Record<string, string[]>;
          recommended_inspect_task_roles?: Record<string, string | null>;
          recommended_inspect_task_owners?: Record<string, string | null>;
          recommended_inspect_approval_statuses?: Record<string, string | null>;
          recommended_inspect_approval_reviewers?: Record<string, string | null>;
          recommended_inspect_approval_reasons?: Record<string, string | null>;
          recommended_inspect_approval_decided_at?: Record<string, string | null>;
          recommended_inspect_approval_record_present?: Record<string, boolean | null>;
          recommended_inspect_states?: Record<string, string | null>;
          recommended_inspect_state_reasons?: Record<string, string | null>;
          recommended_inspect_tasks?: Record<string, string | null>;
          recommended_inspect_subjects?: Record<string, string | null>;
          recommended_inspect_task_paths?: Record<string, string | null>;
          recommended_inspect_approval_paths?: Record<string, string | null>;
          recommended_inspect_worker_state_dirs?: Record<string, string | null>;
          recommended_inspect_worker_status_paths?: Record<string, string | null>;
          recommended_inspect_worker_heartbeat_paths?: Record<string, string | null>;
          recommended_inspect_worker_identity_paths?: Record<string, string | null>;
          recommended_inspect_worker_inbox_paths?: Record<string, string | null>;
          recommended_inspect_worker_mailbox_paths?: Record<string, string | null>;
          recommended_inspect_worker_shutdown_request_paths?: Record<string, string | null>;
          recommended_inspect_worker_shutdown_ack_paths?: Record<string, string | null>;
          recommended_inspect_team_dir_paths?: Record<string, string | null>;
          recommended_inspect_team_config_paths?: Record<string, string | null>;
          recommended_inspect_team_manifest_paths?: Record<string, string | null>;
          recommended_inspect_team_events_paths?: Record<string, string | null>;
          recommended_inspect_team_dispatch_paths?: Record<string, string | null>;
          recommended_inspect_team_phase_paths?: Record<string, string | null>;
          recommended_inspect_team_monitor_snapshot_paths?: Record<string, string | null>;
          recommended_inspect_team_summary_snapshot_paths?: Record<string, string | null>;
          recommended_inspect_panes?: Record<string, string | null>;
          recommended_inspect_command?: string | null;
          recommended_inspect_commands?: string[];
          recommended_inspect_summary?: string | null;
          recommended_inspect_items?: Array<{
            target?: string;
            pane_id?: string;
            worker_cli?: string | null;
            role?: string | null;
            index?: number | null;
            alive?: boolean | null;
            turn_count?: number | null;
            turns_without_progress?: number | null;
            last_turn_at?: string | null;
            status_updated_at?: string | null;
            pid?: number | null;
            worktree_repo_root?: string | null;
            worktree_path?: string | null;
            worktree_branch?: string | null;
            worktree_detached?: boolean | null;
            worktree_created?: boolean | null;
            team_state_root?: string | null;
            working_dir?: string | null;
            assigned_tasks?: string[];
            task_status?: string | null;
            task_result?: string | null;
            task_error?: string | null;
            task_version?: number | null;
            task_created_at?: string | null;
            task_completed_at?: string | null;
            task_depends_on?: string[];
            task_claim_present?: boolean | null;
            task_claim_owner?: string | null;
            task_claim_token?: string | null;
            task_claim_leased_until?: string | null;
            approval_required?: boolean | null;
            requires_code_change?: boolean | null;
            task_description?: string | null;
            blocked_by?: string[];
            task_role?: string | null;
            task_owner?: string | null;
            approval_status?: string | null;
            approval_reviewer?: string | null;
            approval_reason?: string | null;
            approval_decided_at?: string | null;
            approval_record_present?: boolean | null;
            reason?: string;
            state?: string | null;
            state_reason?: string | null;
            task_id?: string | null;
            task_subject?: string | null;
            task_path?: string | null;
            approval_path?: string | null;
            worker_state_dir?: string | null;
            worker_status_path?: string | null;
            worker_heartbeat_path?: string | null;
            worker_identity_path?: string | null;
            worker_inbox_path?: string | null;
            worker_mailbox_path?: string | null;
            worker_shutdown_request_path?: string | null;
            worker_shutdown_ack_path?: string | null;
            team_dir_path?: string | null;
            team_config_path?: string | null;
            team_manifest_path?: string | null;
            team_events_path?: string | null;
            team_dispatch_path?: string | null;
            team_phase_path?: string | null;
            team_monitor_snapshot_path?: string | null;
            team_summary_snapshot_path?: string | null;
            command?: string;
          }>;
        };
      };
      const expectedWd = process.platform === 'darwin' && wd.startsWith('/var/')
        ? `/private${wd}`
        : wd;
      assert.equal(payload.schema_version, '1.0');
      assert.equal(typeof payload.timestamp, 'string');
      assert.equal(payload.command, 'omx team status');
      assert.equal(payload.team_name, 'pane-json-team');
      assert.equal(payload.status, 'ok');
      assert.deepEqual(payload.dead_workers, ['worker-1']);
      assert.deepEqual(payload.non_reporting_workers, []);
      assert.deepEqual(payload.panes?.recommended_inspect_targets, ['worker-1']);
      assert.deepEqual(payload.panes?.recommended_inspect_reasons, { 'worker-1': 'dead_worker' });
      assert.deepEqual(payload.panes?.recommended_inspect_clis, { 'worker-1': 'claude' });
      assert.deepEqual(payload.panes?.recommended_inspect_roles, { 'worker-1': 'executor' });
      assert.deepEqual(payload.panes?.recommended_inspect_indexes, { 'worker-1': 1 });
      assert.deepEqual(payload.panes?.recommended_inspect_alive, { 'worker-1': false });
      assert.deepEqual(payload.panes?.recommended_inspect_turn_counts, { 'worker-1': 5 });
      assert.deepEqual(payload.panes?.recommended_inspect_turns_without_progress, { 'worker-1': 0 });
      assert.deepEqual(payload.panes?.recommended_inspect_last_turn_at, { 'worker-1': '2026-03-11T00:03:00.000Z' });
      assert.deepEqual(payload.panes?.recommended_inspect_status_updated_at, { 'worker-1': '2026-03-11T00:00:00.000Z' });
      assert.deepEqual(payload.panes?.recommended_inspect_pids, { 'worker-1': 201 });
      assert.deepEqual(payload.panes?.recommended_inspect_worktree_paths, { 'worker-1': '/tmp/pane-json-team/worktrees/worker-1' });
      assert.deepEqual(payload.panes?.recommended_inspect_worktree_repo_roots, { 'worker-1': '/tmp/pane-json-team/repo' });
      assert.deepEqual(payload.panes?.recommended_inspect_worktree_branches, { 'worker-1': 'feat/pane-json-team-worker-1' });
      assert.deepEqual(payload.panes?.recommended_inspect_worktree_detached, { 'worker-1': false });
      assert.deepEqual(payload.panes?.recommended_inspect_worktree_created, { 'worker-1': true });
      assert.deepEqual(payload.panes?.recommended_inspect_team_state_roots, { 'worker-1': '/tmp/pane-json-team/.omx/state' });
      assert.deepEqual(payload.panes?.recommended_inspect_workdirs, { 'worker-1': '/tmp/pane-json-team/worker-1' });
      assert.deepEqual(payload.panes?.recommended_inspect_assigned_tasks, { 'worker-1': ['1', 'extra-2'] });
      assert.deepEqual(payload.panes?.recommended_inspect_task_statuses, { 'worker-1': 'pending' });
      assert.deepEqual(payload.panes?.recommended_inspect_task_results, { 'worker-1': null });
      assert.deepEqual(payload.panes?.recommended_inspect_task_errors, { 'worker-1': null });
      assert.deepEqual(payload.panes?.recommended_inspect_task_versions, { 'worker-1': 1 });
      assert.deepEqual(payload.panes?.recommended_inspect_task_created_at, { 'worker-1': '2026-03-10T23:57:00.000Z' });
      assert.deepEqual(payload.panes?.recommended_inspect_task_completed_at, { 'worker-1': null });
      assert.deepEqual(payload.panes?.recommended_inspect_task_depends_on, { 'worker-1': [] });
      assert.deepEqual(payload.panes?.recommended_inspect_task_claim_present, { 'worker-1': true });
      assert.deepEqual(payload.panes?.recommended_inspect_task_claim_owners, { 'worker-1': 'worker-1' });
      assert.deepEqual(payload.panes?.recommended_inspect_task_claim_tokens, { 'worker-1': 'claim-token-1' });
      assert.deepEqual(payload.panes?.recommended_inspect_task_claim_leases, { 'worker-1': '2026-03-11T00:11:00.000Z' });
      assert.deepEqual(payload.panes?.recommended_inspect_approval_required, { 'worker-1': true });
      assert.deepEqual(payload.panes?.recommended_inspect_requires_code_change, { 'worker-1': true });
      assert.deepEqual(payload.panes?.recommended_inspect_descriptions, { 'worker-1': 'Inspect worker-1 pane' });
      assert.deepEqual(payload.panes?.recommended_inspect_blocked_by, { 'worker-1': [] });
      assert.deepEqual(payload.panes?.recommended_inspect_task_roles, { 'worker-1': 'debugger' });
      assert.deepEqual(payload.panes?.recommended_inspect_task_owners, { 'worker-1': 'worker-1' });
      assert.deepEqual(payload.panes?.recommended_inspect_approval_statuses, { 'worker-1': 'approved' });
      assert.deepEqual(payload.panes?.recommended_inspect_approval_reviewers, { 'worker-1': 'leader-fixed' });
      assert.deepEqual(payload.panes?.recommended_inspect_approval_reasons, { 'worker-1': 'Looks good' });
      assert.deepEqual(payload.panes?.recommended_inspect_approval_decided_at, { 'worker-1': '2026-03-11T00:05:00.000Z' });
      assert.deepEqual(payload.panes?.recommended_inspect_approval_record_present, { 'worker-1': true });
      assert.deepEqual(payload.panes?.recommended_inspect_states, { 'worker-1': 'working' });
      assert.deepEqual(payload.panes?.recommended_inspect_state_reasons, { 'worker-1': 'recovering progress' });
      assert.deepEqual(payload.panes?.recommended_inspect_tasks, { 'worker-1': '1' });
      assert.deepEqual(payload.panes?.recommended_inspect_subjects, { 'worker-1': 'Recover worker-1 progress' });
      assert.deepEqual(payload.panes?.recommended_inspect_task_paths, { 'worker-1': `${expectedWd}/.omx/state/team/pane-json-team/tasks/task-1.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_approval_paths, { 'worker-1': `${expectedWd}/.omx/state/team/pane-json-team/approvals/task-1.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_worker_state_dirs, { 'worker-1': `${expectedWd}/.omx/state/team/pane-json-team/workers/worker-1` });
      assert.deepEqual(payload.panes?.recommended_inspect_worker_status_paths, { 'worker-1': `${expectedWd}/.omx/state/team/pane-json-team/workers/worker-1/status.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_worker_heartbeat_paths, { 'worker-1': `${expectedWd}/.omx/state/team/pane-json-team/workers/worker-1/heartbeat.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_worker_identity_paths, { 'worker-1': `${expectedWd}/.omx/state/team/pane-json-team/workers/worker-1/identity.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_worker_inbox_paths, { 'worker-1': `${expectedWd}/.omx/state/team/pane-json-team/workers/worker-1/inbox.md` });
      assert.deepEqual(payload.panes?.recommended_inspect_worker_mailbox_paths, { 'worker-1': `${expectedWd}/.omx/state/team/pane-json-team/mailbox/worker-1.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_worker_shutdown_request_paths, { 'worker-1': `${expectedWd}/.omx/state/team/pane-json-team/workers/worker-1/shutdown-request.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_worker_shutdown_ack_paths, { 'worker-1': `${expectedWd}/.omx/state/team/pane-json-team/workers/worker-1/shutdown-ack.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_team_dir_paths, { 'worker-1': `${expectedWd}/.omx/state/team/pane-json-team` });
      assert.deepEqual(payload.panes?.recommended_inspect_team_config_paths, { 'worker-1': `${expectedWd}/.omx/state/team/pane-json-team/config.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_team_manifest_paths, { 'worker-1': `${expectedWd}/.omx/state/team/pane-json-team/manifest.v2.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_team_events_paths, { 'worker-1': `${expectedWd}/.omx/state/team/pane-json-team/events/events.ndjson` });
      assert.deepEqual(payload.panes?.recommended_inspect_team_dispatch_paths, { 'worker-1': `${expectedWd}/.omx/state/team/pane-json-team/dispatch/requests.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_team_phase_paths, { 'worker-1': `${expectedWd}/.omx/state/team/pane-json-team/phase.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_team_monitor_snapshot_paths, { 'worker-1': `${expectedWd}/.omx/state/team/pane-json-team/monitor-snapshot.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_team_summary_snapshot_paths, { 'worker-1': `${expectedWd}/.omx/state/team/pane-json-team/summary-snapshot.json` });
      assert.deepEqual(payload.panes?.recommended_inspect_panes, { 'worker-1': '%41' });
      assert.equal(payload.panes?.recommended_inspect_command, 'omx sparkshell --tmux-pane %41 --tail-lines 400');
      assert.deepEqual(payload.panes?.recommended_inspect_commands, ['omx sparkshell --tmux-pane %41 --tail-lines 400']);
      assert.equal(payload.panes?.recommended_inspect_summary, 'target=worker-1 pane=%41 cli=claude role=executor alive=false turn_count=5 turns_without_progress=0 reason=dead_worker state=working task=1 subject=Recover worker-1 progress command=omx sparkshell --tmux-pane %41 --tail-lines 400');
      assert.deepEqual(payload.panes?.recommended_inspect_items, [{
        target: 'worker-1',
        pane_id: '%41',
        worker_cli: 'claude',
        role: 'executor',
        index: 1,
        alive: false,
        turn_count: 5,
        turns_without_progress: 0,
        last_turn_at: '2026-03-11T00:03:00.000Z',
        status_updated_at: '2026-03-11T00:00:00.000Z',
        pid: 201,
        worktree_repo_root: '/tmp/pane-json-team/repo',
        worktree_path: '/tmp/pane-json-team/worktrees/worker-1',
        worktree_branch: 'feat/pane-json-team-worker-1',
        worktree_detached: false,
        worktree_created: true,
        team_state_root: '/tmp/pane-json-team/.omx/state',
        working_dir: '/tmp/pane-json-team/worker-1',
        assigned_tasks: ['1', 'extra-2'],
        task_status: 'pending',
        task_result: null,
        task_error: null,
        task_version: 1,
        task_created_at: '2026-03-10T23:57:00.000Z',
        task_completed_at: null,
        task_depends_on: [],
        task_claim_present: true,
        task_claim_owner: 'worker-1',
        task_claim_token: 'claim-token-1',
        task_claim_leased_until: '2026-03-11T00:11:00.000Z',
        task_claim_lock_path: `${expectedWd}/.omx/state/team/pane-json-team/claims/task-1.lock`,
        approval_required: true,
        requires_code_change: true,
        task_description: 'Inspect worker-1 pane',
        blocked_by: [],
        task_role: 'debugger',
        task_owner: 'worker-1',
        approval_status: 'approved',
        approval_reviewer: 'leader-fixed',
        approval_reason: 'Looks good',
        approval_decided_at: '2026-03-11T00:05:00.000Z',
        approval_record_present: true,
        reason: 'dead_worker',
        state: 'working',
        state_reason: 'recovering progress',
        task_id: '1',
        task_subject: 'Recover worker-1 progress',
        task_path: `${expectedWd}/.omx/state/team/pane-json-team/tasks/task-1.json`,
        approval_path: `${expectedWd}/.omx/state/team/pane-json-team/approvals/task-1.json`,
        worker_state_dir: `${expectedWd}/.omx/state/team/pane-json-team/workers/worker-1`,
        worker_status_path: `${expectedWd}/.omx/state/team/pane-json-team/workers/worker-1/status.json`,
        worker_heartbeat_path: `${expectedWd}/.omx/state/team/pane-json-team/workers/worker-1/heartbeat.json`,
        worker_identity_path: `${expectedWd}/.omx/state/team/pane-json-team/workers/worker-1/identity.json`,
        worker_inbox_path: `${expectedWd}/.omx/state/team/pane-json-team/workers/worker-1/inbox.md`,
        worker_mailbox_path: `${expectedWd}/.omx/state/team/pane-json-team/mailbox/worker-1.json`,
        worker_shutdown_request_path: `${expectedWd}/.omx/state/team/pane-json-team/workers/worker-1/shutdown-request.json`,
        worker_shutdown_ack_path: `${expectedWd}/.omx/state/team/pane-json-team/workers/worker-1/shutdown-ack.json`,
        team_dir_path: `${expectedWd}/.omx/state/team/pane-json-team`,
        team_config_path: `${expectedWd}/.omx/state/team/pane-json-team/config.json`,
        team_manifest_path: `${expectedWd}/.omx/state/team/pane-json-team/manifest.v2.json`,
        team_events_path: `${expectedWd}/.omx/state/team/pane-json-team/events/events.ndjson`,
        team_dispatch_path: `${expectedWd}/.omx/state/team/pane-json-team/dispatch/requests.json`,
        team_phase_path: `${expectedWd}/.omx/state/team/pane-json-team/phase.json`,
        team_monitor_snapshot_path: `${expectedWd}/.omx/state/team/pane-json-team/monitor-snapshot.json`,
        team_summary_snapshot_path: `${expectedWd}/.omx/state/team/pane-json-team/summary-snapshot.json`,
        command: 'omx sparkshell --tmux-pane %41 --tail-lines 400',
      }]);
      assert.equal(payload.panes?.leader_pane_id, '%30');
      assert.equal(payload.panes?.hud_pane_id, '%31');
      assert.deepEqual(payload.panes?.worker_panes, { 'worker-1': '%41' });
      assert.equal(payload.panes?.sparkshell_hint, 'omx sparkshell --tmux-pane <pane-id> --tail-lines 400');
      assert.deepEqual(payload.panes?.sparkshell_commands, {
        leader: 'omx sparkshell --tmux-pane %30 --tail-lines 400',
        hud: 'omx sparkshell --tmux-pane %31 --tail-lines 400',
        'worker-1': 'omx sparkshell --tmux-pane %41 --tail-lines 400',
      });
    } finally {
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });


  it('prints workspace_mode in text status output when present', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-status-workspace-mode-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      const config = await withoutTeamTestWorkerEnv(() => initTeamState('workspace-mode-team', 'inspect workspace mode', 'executor', 1, wd));
      config.workspace_mode = 'worktree';
      const teamDir = join(wd, '.omx', 'state', 'team', 'workspace-mode-team');
      const configPath = join(teamDir, 'config.json');
      const manifestPath = join(teamDir, 'manifest.v2.json');
      await mkdir(teamDir, { recursive: true });
      await writeFile(configPath, JSON.stringify(config, null, 2));
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest.workspace_mode = 'worktree';
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

      await withoutTeamTestWorkerEnv(() => teamCommand(['status', 'workspace-mode-team']));

      assert.ok(logs.some((line) => /workspace_mode: worktree/.test(line)));
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('returns workspace_mode in JSON status output when present', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-status-json-workspace-mode-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      const config = await withoutTeamTestWorkerEnv(() => initTeamState('workspace-mode-json-team', 'inspect workspace mode', 'executor', 1, wd));
      config.workspace_mode = 'worktree';
      const teamDir = join(wd, '.omx', 'state', 'team', 'workspace-mode-json-team');
      const configPath = join(teamDir, 'config.json');
      const manifestPath = join(teamDir, 'manifest.v2.json');
      await mkdir(teamDir, { recursive: true });
      await writeFile(configPath, JSON.stringify(config, null, 2));
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest.workspace_mode = 'worktree';
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

      await withoutTeamTestWorkerEnv(() => teamCommand(['status', 'workspace-mode-json-team', '--json']));

      const payload = JSON.parse(logs[0] ?? '{}') as { workspace_mode?: string | null; status?: string };
      assert.equal(payload.status, 'ok');
      assert.equal(payload.workspace_mode, 'worktree');
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('returns a missing envelope in JSON mode when team state is absent', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-status-missing-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await withoutTeamTestWorkerEnv(() => teamCommand(['status', 'missing-team', '--json']));

      const payload = JSON.parse(logs.at(-1) ?? '{}') as {
        schema_version?: string;
        timestamp?: string;
        command?: string;
        team_name?: string;
        status?: string;
      };
      assert.equal(payload.schema_version, '1.0');
      assert.equal(typeof payload.timestamp, 'string');
      assert.equal(payload.command, 'omx team status');
      assert.equal(payload.team_name, 'missing-team');
      assert.equal(payload.status, 'missing');
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('records leader runtime activity when team status is read', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-status-activity-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      await withoutTeamTestWorkerEnv(() => initTeamState('activity-team', 'inspect activity', 'executor', 1, wd));
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

      await withoutTeamTestWorkerEnv(() => teamCommand(['status', 'activity-team', '--json']));

      const activity = JSON.parse(await readFile(join(wd, '.omx', 'state', 'leader-runtime-activity.json'), 'utf-8')) as {
        last_activity_at?: string;
        last_team_status_at?: string;
        last_source?: string;
        last_team_name?: string;
      };
      assert.equal(activity.last_source, 'team_status');
      assert.equal(activity.last_team_name, 'activity-team');
      assert.ok(typeof activity.last_activity_at === 'string' && activity.last_activity_at.length > 0);
      assert.ok(typeof activity.last_team_status_at === 'string' && activity.last_team_status_at.length > 0);
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('supports custom tail lines for generated raw inspect commands', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-status-tail-lines-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      const config = await withoutTeamTestWorkerEnv(() => initTeamState('pane-tail-team', 'inspect worker panes', 'executor', 1, wd));
      config.workers[0]!.pane_id = '%51';
      const manifestPath = join(wd, '.omx', 'state', 'team', 'pane-tail-team', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
        workers?: Array<{ pane_id?: string }>;
      };
      manifest.workers = config.workers.map((worker) => ({
        ...worker,
        pane_id: worker.pane_id,
      }));
      await writeFile(
        join(wd, '.omx', 'state', 'team', 'pane-tail-team', 'config.json'),
        `${JSON.stringify(config, null, 2)}\n`,
      );
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
      );

      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      await withoutTeamTestWorkerEnv(() => teamCommand(['status', 'pane-tail-team', '--tail-lines', '600']));
      assert.match(logs.join('\n'), /inspect_worker-1: tmux capture-pane -p -t %51 -S -600/);

      logs.length = 0;
      await withoutTeamTestWorkerEnv(() => teamCommand(['status', 'pane-tail-team', '--model-inspect', '--tail-lines', '600']));
      assert.match(logs.join('\n'), /inspect_worker-1: omx sparkshell --tmux-pane %51 --tail-lines 600/);

      logs.length = 0;
      await withoutTeamTestWorkerEnv(() => teamCommand(['status', 'pane-tail-team', '--json', '--tail-lines=550']));
      const payload = JSON.parse(logs.at(-1) ?? '{}') as {
        tail_lines?: number;
        panes?: { sparkshell_commands?: Record<string, string> };
      };
      assert.equal(payload.tail_lines, 550);
      assert.equal(payload.panes?.sparkshell_commands?.['worker-1'], 'omx sparkshell --tmux-pane %51 --tail-lines 550');
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('teamCommand await', () => {
  it('applies project-scope agentReasoning overrides when CODEX_HOME is unset', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-project-reasoning-'));
    const binDir = join(wd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    const captureDir = join(wd, 'captures');
    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const previousCodexHome = process.env.CODEX_HOME;
    const previousTmux = process.env.TMUX;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const previousCaptureDir = process.env.OMX_ARGV_CAPTURE_DIR;
    const previousLaunchArgs = process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
    const previousSkipReadyWait = process.env.OMX_TEAM_SKIP_READY_WAIT;
    const logs: string[] = [];
    const originalLog = console.log;
    const teamTask = 'project scoped architect reasoning override';
    let displayTeamName = '';

    await mkdir(binDir, { recursive: true });
    await mkdir(captureDir, { recursive: true });
    await mkdir(join(wd, '.omx'), { recursive: true });
    await mkdir(join(wd, '.codex', 'prompts'), { recursive: true });
    await writeFile(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }, null, 2));
    await writeFile(join(wd, '.codex', '.omx-config.json'), JSON.stringify({
      agentReasoning: {
        architect: 'xhigh',
      },
    }, null, 2));
    await writeFile(join(wd, '.codex', 'prompts', 'architect.md'), '<identity>You are Architect.</identity>');
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const worker = String(process.env.OMX_TEAM_WORKER || 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '__');
const out = path.join(process.env.OMX_ARGV_CAPTURE_DIR, worker + '.json');
fs.writeFileSync(out, JSON.stringify({
  argv: process.argv.slice(2),
  codexHome: process.env.CODEX_HOME || null,
  worker,
}, null, 2));
process.stdin.resume();
setTimeout(() => process.exit(0), 5000);
process.on('SIGTERM', () => process.exit(0));
`,
      { mode: 0o755 },
    );

    let runtimeTeamName: string | null = null;
    try {
      process.chdir(wd);
      process.env.PATH = `${binDir}:${previousPath ?? ''}`;
      delete process.env.CODEX_HOME;
      delete process.env.TMUX;
      delete process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
      process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
      process.env.OMX_TEAM_WORKER_CLI = 'codex';
      process.env.OMX_ARGV_CAPTURE_DIR = captureDir;
      process.env.OMX_TEAM_SKIP_READY_WAIT = '1';
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      displayTeamName = parseTeamStartArgs(['1:architect', teamTask]).parsed.teamName;

      await withMockPromptModeCodexAllowed(() =>
        withoutTeamTestWorkerEnv(() => teamCommand(['1:architect', teamTask])));

      const startedState = await readModeState('team', wd);
      runtimeTeamName = String(startedState?.team_name ?? parseTeamStartArgs(['1:architect', teamTask]).parsed.teamName);

      let captured: { argv: string[]; codexHome: string | null } | null = null;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const capturePath = join(captureDir, `${displayTeamName}__worker-1.json`);
        if (existsSync(capturePath)) {
          captured = JSON.parse(await readFile(capturePath, 'utf-8')) as { argv: string[]; codexHome: string | null };
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      assert.ok(captured, 'worker argv capture file should be written');
      assert.equal(captured!.codexHome, join(process.cwd(), '.codex'));
      assert.match(captured!.argv.join(' '), /model_reasoning_effort="xhigh"/);
      assert.match(logs.join('\n'), /architect x1 .*xhigh reasoning/);
    } finally {
      console.log = originalLog;
      if (runtimeTeamName) {
        await shutdownTeam(runtimeTeamName, wd, { force: true }).catch(() => {});
      }
      process.chdir(previousCwd);
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousCodexHome === 'string') process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof previousCaptureDir === 'string') process.env.OMX_ARGV_CAPTURE_DIR = previousCaptureDir;
      else delete process.env.OMX_ARGV_CAPTURE_DIR;
      if (typeof previousLaunchArgs === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = previousLaunchArgs;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
      if (typeof previousSkipReadyWait === 'string') process.env.OMX_TEAM_SKIP_READY_WAIT = previousSkipReadyWait;
      else delete process.env.OMX_TEAM_SKIP_READY_WAIT;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('returns next canonical event for a team in JSON mode', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-await-'));
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      process.chdir(wd);
      await initTeamState('await-team', 'await test', 'executor', 1, wd);
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

      const waitPromise = teamCommand(['await', 'await-team', '--json', '--timeout-ms', '500']);
      setTimeout(() => {
        void appendTeamEvent('await-team', {
          type: 'worker_state_changed',
          worker: 'worker-1',
          state: 'blocked',
          prev_state: 'working',
          reason: 'needs_follow_up',
        }, wd);
      }, 50);
      await waitPromise;

      const payload = JSON.parse(logs.at(-1) ?? '{}') as {
        team_name?: string;
        status?: string;
        cursor?: string;
        event?: { type?: string; state?: string; prev_state?: string; reason?: string } | null;
      };
      assert.equal(payload.team_name, 'await-team');
      assert.equal(payload.status, 'event');
      assert.equal(typeof payload.cursor, 'string');
      assert.equal(payload.event?.type, 'worker_state_changed');
      assert.equal(payload.event?.state, 'blocked');
      assert.equal(payload.event?.prev_state, 'working');
      assert.equal(payload.event?.reason, 'needs_follow_up');
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('returns a dead-worker event for the prompt-launch smoke path instead of timing out', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-await-prompt-dead-'));
    const binDir = join(wd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const previousTmux = process.env.TMUX;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const logs: string[] = [];
    const stderr: string[] = [];
    const originalLog = console.log;
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const teamTask = 'issue 662 prompt dead worker smoke';
    const teamName = parseTeamStartArgs(['1:executor', teamTask]).parsed.teamName;

    await mkdir(binDir, { recursive: true });
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
setTimeout(() => process.exit(0), 0);
process.stdin.resume();
process.on('SIGTERM', () => process.exit(0));
`,
    );
    await chmod(fakeCodexPath, 0o755);

    try {
      process.chdir(wd);
      process.env.PATH = `${binDir}:${previousPath ?? ''}`;
      delete process.env.TMUX;
      process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
      process.env.OMX_TEAM_WORKER_CLI = 'codex';
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;

      await withMockPromptModeCodexAllowed(() =>
        withoutTeamTestWorkerEnv(() => teamCommand(['1:executor', teamTask])));
      const startedState = await readModeState('team', wd);
      const runtimeTeamName = String(startedState?.team_name ?? teamName);

      let statusOutput = '';
      for (let attempt = 0; attempt < 50; attempt += 1) {
        logs.length = 0;
        stderr.length = 0;
        await withoutTeamTestWorkerEnv(() => teamCommand(['status', runtimeTeamName]));
        statusOutput = logs.join('\n');
        if (/phase=failed/.test(statusOutput)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.match(statusOutput, /phase=failed/);
      assert.doesNotMatch(stderr.join('\n'), /ESRCH/);

      logs.length = 0;
      await withoutTeamTestWorkerEnv(() => teamCommand(['await', runtimeTeamName, '--json', '--timeout-ms', '250']));
      const payload = JSON.parse(logs.at(-1) ?? '{}') as {
        team_name?: string;
        status?: string;
        event?: { type?: string; worker?: string; reason?: string | null } | null;
      };
      assert.equal(payload.team_name, runtimeTeamName);
      assert.equal(payload.status, 'event');
      assert.equal(payload.event?.type, 'worker_stopped');
      assert.equal(payload.event?.worker, 'worker-1');
    } finally {
      console.log = originalLog;
      process.stderr.write = originalStderrWrite;
      process.chdir(previousCwd);
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('initializes and rehydrates active team mode state on start and resume', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-mode-state-'));
    const binDir = join(wd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const previousTmux = process.env.TMUX;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const teamTask = 'issue 771 rehydrate team mode state';
    const teamName = parseTeamStartArgs(['1:executor', teamTask]).parsed.teamName;

    await mkdir(binDir, { recursive: true });
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
setTimeout(() => process.exit(0), 3000);
process.stdin.resume();
process.on('SIGTERM', () => process.exit(0));
`,
    );
    await chmod(fakeCodexPath, 0o755);

    try {
      process.chdir(wd);
      process.env.PATH = `${binDir}:${previousPath ?? ''}`;
      delete process.env.TMUX;
      process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
      process.env.OMX_TEAM_WORKER_CLI = 'codex';

      await withMockPromptModeCodexAllowed(() =>
        withoutTeamTestWorkerEnv(() => teamCommand(['1:executor', teamTask])));

      const startedState = await readModeState('team', wd);
      const runtimeTeamName = String(startedState?.team_name ?? teamName);
      assert.equal(startedState?.active, true);
      assert.equal(startedState?.team_name, runtimeTeamName);
      assert.equal(startedState?.display_name, teamName);
      assert.equal(startedState?.current_phase, 'team-exec');

      await rm(join(wd, '.omx', 'state', 'team-state.json'), { force: true });
      assert.equal(await readModeState('team', wd), null);

      await withoutTeamTestWorkerEnv(() => teamCommand(['resume', runtimeTeamName]));

      const resumedState = await readModeState('team', wd);
      assert.equal(resumedState?.active, true);
      assert.equal(resumedState?.team_name, runtimeTeamName);
      assert.equal(resumedState?.current_phase, 'team-exec');
    } finally {
      process.chdir(previousCwd);
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not resurrect active team mode state when canonical team phase is terminal on resume', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-team-mode-terminal-'));
    const binDir = join(wd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const previousTmux = process.env.TMUX;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const teamTask = 'issue 772 terminal team mode state';
    const teamName = parseTeamStartArgs(['1:executor', teamTask]).parsed.teamName;

    await mkdir(binDir, { recursive: true });
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
setTimeout(() => process.exit(0), 3000);
process.stdin.resume();
process.on('SIGTERM', () => process.exit(0));
`,
    );
    await chmod(fakeCodexPath, 0o755);

    try {
      process.chdir(wd);
      process.env.PATH = `${binDir}:${previousPath ?? ''}`;
      delete process.env.TMUX;
      process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
      process.env.OMX_TEAM_WORKER_CLI = 'codex';

      await withMockPromptModeCodexAllowed(() =>
        withoutTeamTestWorkerEnv(() => teamCommand(['1:executor', teamTask])));
      const startedState = await readModeState('team', wd);
      const runtimeTeamName = String(startedState?.team_name ?? teamName);
      await writeFile(
        join(wd, '.omx', 'state', 'team', runtimeTeamName, 'phase.json'),
        JSON.stringify({
          current_phase: 'complete',
          max_fix_attempts: 3,
          current_fix_attempt: 0,
          transitions: [],
          updated_at: new Date().toISOString(),
        }, null, 2),
      );
      await rm(join(wd, '.omx', 'state', 'team-state.json'), { force: true });

      await withoutTeamTestWorkerEnv(() => teamCommand(['resume', runtimeTeamName]));

      const resumedState = await readModeState('team', wd);
      assert.equal(resumedState?.active, false);
      assert.equal(resumedState?.team_name, runtimeTeamName);
      assert.equal(resumedState?.current_phase, 'complete');
    } finally {
      process.chdir(previousCwd);
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects legacy omx team ralph launches at command entry', async () => {
    await assert.rejects(
      () => withoutTeamTestWorkerEnv(() => teamCommand(['ralph', '1:executor', 'issue 742 linked ralph launch'])),
      /Deprecated usage: `omx team ralph \.\.\.` has been removed/,
    );
  });

});
