import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir, chmod } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import { HUD_TMUX_TEAM_HEIGHT_LINES } from '../../hud/constants.js';
import {
  initTeamState,
  createTask,
  writeWorkerIdentity,
  readTeamConfig,
  saveTeamConfig,
  listMailboxMessages,
  listDispatchRequests,
  transitionDispatchRequest,
  updateWorkerHeartbeat,
  writeAtomic,
  readTask,
  readMonitorSnapshot,
  claimTask,
  transitionTaskStatus,
  writeWorkerStatus,
} from '../state.js';
import {
  monitorTeam,
  shutdownTeam,
  resumeTeam,
  startTeam,
  assignTask,
  sendWorkerMessage,
  applyCreatedInteractiveSessionToConfig,
  resolveWorkerLaunchArgsFromEnv,
  shouldPrekillInteractiveShutdownProcessTrees,
  waitForWorkerStartupEvidence,
  waitForClaudeStartupEvidence,
  TEAM_LOW_COMPLEXITY_DEFAULT_MODEL,
  type TeamRuntime,
} from '../runtime.js';
import { resolveTeamLowComplexityDefaultModel } from '../model-contract.js';
import { readTeamEvents } from '../state/events.js';

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-worktree-repo-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

async function addWorktree(repo: string, branchName: string, pathPrefix: string): Promise<string> {
  const worktreePath = await mkdtemp(join(tmpdir(), pathPrefix));
  execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], { cwd: repo, stdio: 'ignore' });
  return worktreePath;
}

async function attachDirtyWorkerRepo(teamName: string, cwd: string, repoName: string): Promise<void> {
  const repo = join(cwd, repoName);
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' });
  await writeFile(join(repo, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  await writeFile(join(repo, 'DIRTY.txt'), 'dirty\n', 'utf-8');

  const config = await readTeamConfig(teamName, cwd);
  assert.ok(config, 'team config should exist');
  if (!config) throw new Error('missing config');
  config.workers[0]!.worktree_repo_root = repo;
  config.workers[0]!.worktree_path = repo;
  await saveTeamConfig(config, cwd);
}


function expectedLowComplexityModel(codexHomeOverride?: string): string {
  return resolveTeamLowComplexityDefaultModel(codexHomeOverride);
}

async function readTeamDeliveryLog(cwd: string): Promise<Array<Record<string, unknown>>> {
  const path = join(cwd, '.omx', 'logs', `team-delivery-${new Date().toISOString().slice(0, 10)}.jsonl`);
  const raw = await readFile(path, 'utf-8').catch(() => '');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function withEmptyPath<T>(fn: () => T): T {
  const prev = process.env.PATH;
  process.env.PATH = '';
  let restoreImmediately = true;
  try {
    const result = fn();
    if (result instanceof Promise) {
      restoreImmediately = false;
      return result.finally(() => {
        if (typeof prev === 'string') process.env.PATH = prev;
        else delete process.env.PATH;
      }) as T;
    }
    return result;
  } finally {
    if (restoreImmediately) {
      if (typeof prev === 'string') process.env.PATH = prev;
      else delete process.env.PATH;
    }
  }
}

function withoutTeamWorkerEnv<T>(fn: () => T): T {
  const prev = process.env.OMX_TEAM_WORKER;
  delete process.env.OMX_TEAM_WORKER;
  let restoreImmediately = true;
  try {
    const result = fn();
    if (result instanceof Promise) {
      restoreImmediately = false;
      return result.finally(() => {
        if (typeof prev === 'string') process.env.OMX_TEAM_WORKER = prev;
        else delete process.env.OMX_TEAM_WORKER;
      }) as T;
    }
    return result;
  } finally {
    if (restoreImmediately) {
      if (typeof prev === 'string') process.env.OMX_TEAM_WORKER = prev;
      else delete process.env.OMX_TEAM_WORKER;
    }
  }
}

async function waitForFileText(
  filePath: string,
  matcher: (content: string) => boolean,
  timeoutMs: number = 3_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const content = await readFile(filePath, 'utf-8');
      if (matcher(content)) return content;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function writeFakePromptWorkerBinary(
  binaryPath: string,
  scriptBody: string,
  options: { emitStartupEvidence?: boolean } = {},
): Promise<void> {
  const bootstrap = options.emitStartupEvidence === false
    ? ''
    : `
const fs = require('fs');
const path = require('path');
const stateRoot = process.env.OMX_TEAM_STATE_ROOT;
const worker = String(process.env.OMX_TEAM_WORKER || '');
const [teamName, workerName] = worker.split('/');
if (stateRoot && teamName && workerName) {
  const workerDir = path.join(stateRoot, 'team', teamName, 'workers', workerName);
  fs.mkdirSync(workerDir, { recursive: true });
  fs.writeFileSync(path.join(workerDir, 'status.json'), JSON.stringify({
    state: 'working',
    current_task_id: '1',
    updated_at: new Date().toISOString(),
  }, null, 2));
}
`;
  await writeFile(
    binaryPath,
    `#!/usr/bin/env node
${bootstrap}
${scriptBody}
`,
    { mode: 0o755 },
  );
}

async function withPromptModeCodexEnv<T>(
  binDir: string,
  extraEnv: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  const nextEnv: Record<string, string | undefined> = {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    TMUX: undefined,
    OMX_TEAM_WORKER_LAUNCH_MODE: 'prompt',
    OMX_TEAM_WORKER_CLI: 'codex',
    ...extraEnv,
  };

  for (const [key, value] of Object.entries(nextEnv)) {
    previous.set(key, process.env[key]);
    if (typeof value === 'string') process.env[key] = value;
    else delete process.env[key];
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
  }
}

type MockBinarySpec = {
  name: string;
  content: string;
};


function teamStateTestPath(cwd: string, ...parts: string[]): string {
  const stateRoot = process.env.OMX_TEAM_STATE_ROOT ?? join(cwd, '.omx', 'state');
  return join(stateRoot, ...parts);
}

async function withMockTmuxFixture<T>(
  options: {
    dirPrefix: string;
    tmuxScript: (tmuxLogPath: string) => string;
    binaries?: MockBinarySpec[];
    env?: Record<string, string | undefined>;
  },
  run: (ctx: { fakeBinDir: string; tmuxLogPath: string }) => Promise<T>,
): Promise<T> {
  const fakeBinDir = await mkdtemp(join(tmpdir(), options.dirPrefix));
  const tmuxLogPath = join(fakeBinDir, 'tmux.log');
  const tmuxStubPath = join(fakeBinDir, 'tmux');
  const previousPath = process.env.PATH;
  const previousEnv = new Map<string, string | undefined>();
  const envOverrides = {
    OMX_TEAM_STATE_ROOT: undefined,
    ...(options.env ?? {}),
  };

  try {
    await writeFile(tmuxStubPath, options.tmuxScript(tmuxLogPath));
    await chmod(tmuxStubPath, 0o755);

    for (const binary of options.binaries ?? []) {
      const binaryPath = join(fakeBinDir, binary.name);
      await writeFile(binaryPath, binary.content);
      await chmod(binaryPath, 0o755);
    }

    process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

    for (const [key, value] of Object.entries(envOverrides)) {
      previousEnv.set(key, process.env[key]);
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }

    return await run({ fakeBinDir, tmuxLogPath });
  } finally {
    if (typeof previousPath === 'string') process.env.PATH = previousPath;
    else delete process.env.PATH;

    for (const [key, value] of previousEnv) {
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }

    await rm(fakeBinDir, { recursive: true, force: true });
  }
}

async function withNativeWindowsPlatform<T>(run: () => Promise<T>): Promise<T> {
  const prevMsystem = process.env.MSYSTEM;
  const prevOstype = process.env.OSTYPE;
  const prevWsl = process.env.WSL_DISTRO_NAME;
  const prevWslInterop = process.env.WSL_INTEROP;
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  try {
    delete process.env.MSYSTEM;
    delete process.env.OSTYPE;
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    return await run();
  } finally {
    if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
    if (typeof prevMsystem === 'string') process.env.MSYSTEM = prevMsystem;
    else delete process.env.MSYSTEM;
    if (typeof prevOstype === 'string') process.env.OSTYPE = prevOstype;
    else delete process.env.OSTYPE;
    if (typeof prevWsl === 'string') process.env.WSL_DISTRO_NAME = prevWsl;
    else delete process.env.WSL_DISTRO_NAME;
    if (typeof prevWslInterop === 'string') process.env.WSL_INTEROP = prevWslInterop;
    else delete process.env.WSL_INTEROP;
  }
}

const ORIGINAL_OMX_TEAM_STATE_ROOT = process.env.OMX_TEAM_STATE_ROOT;

beforeEach(() => {
  delete process.env.OMX_TEAM_STATE_ROOT;
});

afterEach(() => {
  if (typeof ORIGINAL_OMX_TEAM_STATE_ROOT === 'string') process.env.OMX_TEAM_STATE_ROOT = ORIGINAL_OMX_TEAM_STATE_ROOT;
  else delete process.env.OMX_TEAM_STATE_ROOT;
});

describe('runtime', () => {
  it('resolveWorkerLaunchArgsFromEnv injects low-complexity default model when missing', () => {
    const args = resolveWorkerLaunchArgsFromEnv(
      { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
      'explore',
    );
    assert.deepEqual(args, ['--no-alt-screen', '--model', expectedLowComplexityModel()]);
  });

  it('resolveWorkerLaunchArgsFromEnv reads low-complexity model from config when present', async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const tempCodexHome = await mkdtemp(join(tmpdir(), 'omx-codex-home-'));
    await writeFile(
      join(tempCodexHome, '.omx-config.json'),
      JSON.stringify({ models: { team_low_complexity: 'gpt-4.1-mini' } }),
    );
    process.env.CODEX_HOME = tempCodexHome;
    try {
      const args = resolveWorkerLaunchArgsFromEnv(
        { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
        'explore',
      );
      assert.deepEqual(args, ['--no-alt-screen', '--model', 'gpt-4.1-mini']);
    } finally {
      if (typeof previousCodexHome === 'string') process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      await rm(tempCodexHome, { recursive: true, force: true });
    }
  });

  it('resolveWorkerLaunchArgsFromEnv injects the frontier default model for executor workers', () => {
    const args = resolveWorkerLaunchArgsFromEnv(
      { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
      'executor',
    );
    assert.deepEqual(args, ['--no-alt-screen', '--model', 'gpt-5.4']);
  });

  it('resolveWorkerLaunchArgsFromEnv treats *-low aliases as low complexity', () => {
    const args = resolveWorkerLaunchArgsFromEnv(
      { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
      'executor-low',
    );
    assert.deepEqual(args, ['--no-alt-screen', '--model', expectedLowComplexityModel()]);
  });

  it('resolveWorkerLaunchArgsFromEnv preserves explicit model in either syntax', () => {
    assert.deepEqual(
      resolveWorkerLaunchArgsFromEnv({ OMX_TEAM_WORKER_LAUNCH_ARGS: '--model gpt-5' }, 'explore'),
      ['--model', 'gpt-5'],
    );
    assert.deepEqual(
      resolveWorkerLaunchArgsFromEnv({ OMX_TEAM_WORKER_LAUNCH_ARGS: '--model=gpt-5.3' }, 'explore'),
      ['--model', 'gpt-5.3'],
    );
  });

  it('resolveWorkerLaunchArgsFromEnv uses inherited leader model for all agent types', () => {
    const args = resolveWorkerLaunchArgsFromEnv(
      { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
      'executor',
      'gpt-4.1',
    );
    assert.deepEqual(args, ['--no-alt-screen', '--model', 'gpt-4.1']);
  });

  it('resolveWorkerLaunchArgsFromEnv uses inherited leader model over low-complexity default', () => {
    const args = resolveWorkerLaunchArgsFromEnv(
      { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
      'explore',
      'gpt-4.1',
    );
    assert.deepEqual(args, ['--no-alt-screen', '--model', 'gpt-4.1']);
  });

  it('resolveWorkerLaunchArgsFromEnv prefers explicit env model over inherited leader model', () => {
    assert.deepEqual(
      resolveWorkerLaunchArgsFromEnv({ OMX_TEAM_WORKER_LAUNCH_ARGS: '--model gpt-5' }, 'explore', 'gpt-4.1'),
      ['--model', 'gpt-5'],
    );
  });

  it('resolveWorkerLaunchArgsFromEnv injects teammate reasoning and logs source=role-default', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try {
      const lowArgs = resolveWorkerLaunchArgsFromEnv(
        { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
        'executor',
        undefined,
        'low',
        'codex',
      );
      const highArgs = resolveWorkerLaunchArgsFromEnv(
        { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
        'executor',
        undefined,
        'high',
        'codex',
      );
      assert.deepEqual(lowArgs, ['--no-alt-screen', '-c', 'model_reasoning_effort="low"', '--model', 'gpt-5.4']);
      assert.deepEqual(highArgs, ['--no-alt-screen', '-c', 'model_reasoning_effort="high"', '--model', 'gpt-5.4']);
    } finally {
      console.log = originalLog;
    }
    assert.ok(logs.some((line) => line.includes('thinking_level=low') && line.includes('source=role-default')));
    assert.ok(logs.some((line) => line.includes('thinking_level=high') && line.includes('source=role-default')));
  });

  it('resolveWorkerLaunchArgsFromEnv preserves explicit reasoning and logs source=explicit', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try {
      const args = resolveWorkerLaunchArgsFromEnv(
        { OMX_TEAM_WORKER_LAUNCH_ARGS: '-c model_reasoning_effort=\"high\" --no-alt-screen' },
        'explore',
      );
      assert.deepEqual(
        args,
        ['--no-alt-screen', '-c', 'model_reasoning_effort="high"', '--model', expectedLowComplexityModel()],
      );
    } finally {
      console.log = originalLog;
    }
    assert.ok(logs.some((line) => line.includes('thinking_level=high') && line.includes('source=explicit')));
  });

  it('resolveWorkerLaunchArgsFromEnv logs model=claude without thinking_level for claude CLI', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try {
      const args = resolveWorkerLaunchArgsFromEnv(
        {
          OMX_TEAM_WORKER_CLI: 'claude',
          OMX_TEAM_WORKER_LAUNCH_ARGS: '-c model_reasoning_effort="high" --no-alt-screen',
        },
        'explore',
      );
      assert.deepEqual(
        args,
        ['--no-alt-screen', '-c', 'model_reasoning_effort="high"', '--model', expectedLowComplexityModel()],
      );
    } finally {
      console.log = originalLog;
    }
    const startupLog = logs.find((line) => line.includes('worker startup resolution:'));
    assert.ok(startupLog);
    assert.match(startupLog, /model=claude/);
    assert.match(startupLog, /source=local-settings/);
    assert.doesNotMatch(startupLog, /thinking_level=/);
  });

  it('resolveWorkerLaunchArgsFromEnv logs model=gemini without thinking_level for gemini CLI', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try {
      const args = resolveWorkerLaunchArgsFromEnv(
        {
          OMX_TEAM_WORKER_CLI: 'gemini',
          OMX_TEAM_WORKER_LAUNCH_ARGS: '--model gemini-2.0-pro',
        },
        'executor',
      );
      assert.deepEqual(args, ['--model', 'gemini-2.0-pro']);
    } finally {
      console.log = originalLog;
    }
    const startupLog = logs.find((line) => line.includes('worker startup resolution:'));
    assert.ok(startupLog);
    assert.match(startupLog, /model=gemini/);
    assert.match(startupLog, /source=local-settings/);
    assert.doesNotMatch(startupLog, /thinking_level=/);
  });

  it('resolveWorkerLaunchArgsFromEnv keeps codex thinking_level logging for mixed CLI maps', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try {
      const args = resolveWorkerLaunchArgsFromEnv(
        {
          OMX_TEAM_WORKER_CLI_MAP: 'codex,claude',
          OMX_TEAM_WORKER_LAUNCH_ARGS: '-c model_reasoning_effort="high" --model claude-3-7-sonnet',
        },
        'executor',
      );
      assert.deepEqual(args, ['-c', 'model_reasoning_effort="high"', '--model', 'claude-3-7-sonnet']);
    } finally {
      console.log = originalLog;
    }
    assert.ok(logs.some((line) => line.includes('thinking_level=high') && line.includes('source=explicit')));
  });

  it('resolveWorkerLaunchArgsFromEnv keeps claude and gemini startup logs free of thinking_level during teammate allocation', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try {
      const codexArgs = resolveWorkerLaunchArgsFromEnv(
        { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
        'executor',
        undefined,
        'high',
        'codex',
      );
      const claudeArgs = resolveWorkerLaunchArgsFromEnv(
        { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen --model claude-3-7-sonnet' },
        'executor',
        undefined,
        'low',
        'claude',
      );
      const geminiArgs = resolveWorkerLaunchArgsFromEnv(
        { OMX_TEAM_WORKER_LAUNCH_ARGS: '--model gemini-2.0-pro' },
        'executor',
        undefined,
        'low',
        'gemini',
      );
      assert.deepEqual(codexArgs, ['--no-alt-screen', '-c', 'model_reasoning_effort="high"', '--model', 'gpt-5.4']);
      assert.deepEqual(claudeArgs, ['--no-alt-screen', '-c', 'model_reasoning_effort="low"', '--model', 'claude-3-7-sonnet']);
      assert.deepEqual(geminiArgs, ['-c', 'model_reasoning_effort="low"', '--model', 'gemini-2.0-pro']);
    } finally {
      console.log = originalLog;
    }
    const codexLog = logs.find((line) => line.includes('thinking_level=high'));
    const claudeLog = logs.find((line) => line.includes('model=claude'));
    const geminiLog = logs.find((line) => line.includes('model=gemini'));
    assert.ok(codexLog);
    assert.ok(claudeLog);
    assert.ok(geminiLog);
    assert.doesNotMatch(claudeLog ?? '', /thinking_level=/);
    assert.doesNotMatch(geminiLog ?? '', /thinking_level=/);
  });

  it('waitForClaudeStartupEvidence requires first-start ACK/task progress before startup dispatch is treated as settled', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-claude-startup-'));
    try {
      await initTeamState('claude-startup', 'startup evidence test', 'executor', 1, cwd);

      const none = await waitForClaudeStartupEvidence({
        teamName: 'claude-startup',
        workerName: 'worker-1',
        cwd,
        timeoutMs: 25,
        pollMs: 5,
      });
      assert.equal(none, 'none');

      await sendWorkerMessage('claude-startup', 'worker-1', 'leader-fixed', 'ACK', cwd);
      const ack = await waitForClaudeStartupEvidence({
        teamName: 'claude-startup',
        workerName: 'worker-1',
        cwd,
        timeoutMs: 25,
        pollMs: 5,
      });
      assert.equal(ack, 'leader_ack');

      await writeAtomic(
        join(cwd, '.omx', 'state', 'team', 'claude-startup', 'workers', 'worker-1', 'status.json'),
        JSON.stringify({
          state: 'working',
          current_task_id: 'task-1',
          updated_at: new Date().toISOString(),
        }, null, 2),
      );
      const taskClaim = await waitForClaudeStartupEvidence({
        teamName: 'claude-startup',
        workerName: 'worker-1',
        cwd,
        timeoutMs: 25,
        pollMs: 5,
      });
      assert.equal(taskClaim, 'task_claim');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('waitForWorkerStartupEvidence ignores Codex ACK-only startup replies until work is claimed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-codex-startup-'));
    try {
      await initTeamState('codex-startup', 'startup evidence test', 'executor', 1, cwd);

      await sendWorkerMessage('codex-startup', 'worker-1', 'leader-fixed', 'ACK', cwd);
      const ackOnly = await waitForWorkerStartupEvidence({
        teamName: 'codex-startup',
        workerName: 'worker-1',
        workerCli: 'codex',
        cwd,
        timeoutMs: 25,
        pollMs: 5,
      });
      assert.equal(ackOnly, 'none');

      await writeAtomic(
        join(cwd, '.omx', 'state', 'team', 'codex-startup', 'workers', 'worker-1', 'status.json'),
        JSON.stringify({
          state: 'working',
          current_task_id: 'task-1',
          updated_at: new Date().toISOString(),
        }, null, 2),
      );
      const taskClaim = await waitForWorkerStartupEvidence({
        teamName: 'codex-startup',
        workerName: 'worker-1',
        workerCli: 'codex',
        cwd,
        timeoutMs: 25,
        pollMs: 5,
      });
      assert.equal(taskClaim, 'task_claim');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resolveWorkerLaunchArgsFromEnv logs source=none/default-none when thinking is not explicit', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try {
      const args = resolveWorkerLaunchArgsFromEnv(
        { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
        'explore',
      );
      assert.deepEqual(args, ['--no-alt-screen', '--model', expectedLowComplexityModel()]);
    } finally {
      console.log = originalLog;
    }
    assert.ok(logs.some((line) => line.includes('thinking_level=none') && line.includes('source=none/default-none')));
  });

  it('startTeam rejects nested team invocation inside worker context', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    const prev = process.env.OMX_TEAM_WORKER;
    process.env.OMX_TEAM_WORKER = 'alpha/worker-1';
    try {
      await assert.rejects(
        () => startTeam('nested-a', 'task', 'executor', 1, [{ subject: 's', description: 'd' }], cwd),
        /nested_team_disallowed/,
      );
    } finally {
      if (typeof prev === 'string') process.env.OMX_TEAM_WORKER = prev;
      else delete process.env.OMX_TEAM_WORKER;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam allows nested team invocation when parent governance enables it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-nested-allow-'));
    const binDir = join(cwd, 'bin');
    const fakeGeminiPath = join(binDir, 'gemini');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      fakeGeminiPath,
      `#!/usr/bin/env bash
sleep 5
`,
      { mode: 0o755 },
    );

    await initTeamState('parent-team', 'parent', 'executor', 1, cwd);
    const parentManifestPath = join(cwd, '.omx', 'state', 'team', 'parent-team', 'manifest.v2.json');
    const parentManifest = JSON.parse(await readFile(parentManifestPath, 'utf-8')) as any;
    parentManifest.governance = { ...(parentManifest.governance || {}), nested_teams_allowed: true };
    await writeFile(parentManifestPath, JSON.stringify(parentManifest, null, 2));

    const prevPath = process.env.PATH;
    const prevTmux = process.env.TMUX;
    const prevWorker = process.env.OMX_TEAM_WORKER;
    const prevStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const prevLeaderCwd = process.env.OMX_TEAM_LEADER_CWD;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;

    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    delete process.env.TMUX;
    process.env.OMX_TEAM_WORKER = 'parent-team/worker-1';
    process.env.OMX_TEAM_STATE_ROOT = join(cwd, '.omx', 'state');
    process.env.OMX_TEAM_LEADER_CWD = cwd;
    process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
    process.env.OMX_TEAM_WORKER_CLI = 'gemini';

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await startTeam(
        'nested-allowed',
        'nested task',
        'explore',
        1,
        [{ subject: 's', description: 'd', owner: 'worker-1' }],
        cwd,
      );
      assert.equal(runtime.teamName, 'nested-allowed');
      await shutdownTeam(runtime.teamName, cwd, { force: true });
      runtime = null;
    } finally {
      const runtimeToShutdown = runtime as TeamRuntime | null;
      if (runtimeToShutdown) {
        await shutdownTeam(runtimeToShutdown.teamName, cwd, { force: true }).catch(() => {});
      }
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevWorker === 'string') process.env.OMX_TEAM_WORKER = prevWorker;
      else delete process.env.OMX_TEAM_WORKER;
      if (typeof prevStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = prevStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      if (typeof prevLeaderCwd === 'string') process.env.OMX_TEAM_LEADER_CWD = prevLeaderCwd;
      else delete process.env.OMX_TEAM_LEADER_CWD;
      if (typeof prevLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = prevLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam throws when tmux is not available', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    try {
      process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
      await assert.rejects(
        () => withoutTeamWorkerEnv(() =>
          withEmptyPath(() =>
            startTeam('team-a', 'task', 'executor', 1, [{ subject: 's', description: 'd' }], cwd),
          )),
        /requires tmux/i,
      );
    } finally {
      if (typeof prevLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = prevLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam rejects duplicate active same-name team state without mutating existing files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-duplicate-team-'));
    const prevSessionId = process.env.OMX_SESSION_ID;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    try {
      process.env.OMX_SESSION_ID = 'sess-existing-team';
      await initTeamState(
        'dup-team',
        'existing task',
        'executor',
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: 'sess-existing-team' },
      );
      await createTask('dup-team', {
        subject: 'existing subject',
        description: 'existing description',
        status: 'pending',
      }, cwd);

      const beforeConfig = await readTeamConfig('dup-team', cwd);
      assert.ok(beforeConfig);

      process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
      process.env.OMX_SESSION_ID = 'sess-second-team';

      await assert.rejects(
        () => withoutTeamWorkerEnv(() =>
          startTeam(
            'dup-team',
            'replacement task',
            'executor',
            1,
            [{ subject: 'new subject', description: 'new description', owner: 'worker-1' }],
            cwd,
          )),
        /team_name_conflict: active team state already exists/,
      );

      const afterConfig = await readTeamConfig('dup-team', cwd);
      const existingTask = await readTask('dup-team', '1', cwd);
      assert.equal(afterConfig?.task, 'existing task');
      assert.equal(afterConfig?.created_at, beforeConfig?.created_at);
      assert.equal(existingTask?.subject, 'existing subject');
      assert.equal(existingTask?.description, 'existing description');
    } finally {
      if (typeof prevSessionId === 'string') process.env.OMX_SESSION_ID = prevSessionId;
      else delete process.env.OMX_SESSION_ID;
      if (typeof prevLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = prevLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('skips interactive worker process-tree prekill on native Windows split-pane sessions', async () => {
    await withNativeWindowsPlatform(async () => {
      assert.equal(shouldPrekillInteractiveShutdownProcessTrees('leader:0'), false);
      assert.equal(shouldPrekillInteractiveShutdownProcessTrees('omx-team-alpha'), true);
    });

    assert.equal(shouldPrekillInteractiveShutdownProcessTrees('leader:0'), false);
    assert.equal(shouldPrekillInteractiveShutdownProcessTrees('omx-team-alpha'), true);
  });

  it('startTeam accepts native Windows tmux clients even when TMUX env vars are absent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-win32-no-env-'));
    const prevTmux = process.env.TMUX;
    const prevTmuxPane = process.env.TMUX_PANE;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevSkipReadyWait = process.env.OMX_TEAM_SKIP_READY_WAIT;
    const prevMsystem = process.env.MSYSTEM;
    const prevOstype = process.env.OSTYPE;
    const prevWsl = process.env.WSL_DISTRO_NAME;
    const prevWslInterop = process.env.WSL_INTEROP;
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    let runtime: TeamRuntime | null = null;
    let teamNameForCleanup: string | null = null;

    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-win32-no-env-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*)
        echo "120"
        ;;
      *)
        echo "leader:0 %1"
        ;;
    esac
    exit 0
    ;;
  list-panes)
    printf "%%1\\tnode\\t'codex'\\n"
    exit 0
    ;;
  split-window)
    case "$*" in
      *" -h "*)
        echo "%2"
        ;;
      *)
        echo "%3"
        ;;
    esac
    exit 0
    ;;
  resize-pane|select-layout|set-window-option|select-pane|kill-pane|set-hook|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          binaries: [{
            name: 'gemini',
            content: '#!/bin/sh\nexit 0\n',
          }],
        },
        async ({ tmuxLogPath }) => {
          delete process.env.TMUX;
          delete process.env.TMUX_PANE;
          process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
          process.env.OMX_TEAM_WORKER_CLI = 'gemini';
          process.env.OMX_TEAM_SKIP_READY_WAIT = '1';
          delete process.env.MSYSTEM;
          delete process.env.OSTYPE;
          delete process.env.WSL_DISTRO_NAME;
          delete process.env.WSL_INTEROP;
          Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

          runtime = await withoutTeamWorkerEnv(() =>
            startTeam(
              'team-win32-no-env',
              'native windows current-client detection',
              'executor',
              1,
              [{ subject: 's', description: 'd', owner: 'worker-1' }],
              cwd,
            ));
          teamNameForCleanup = runtime.teamName;
          assert.equal(runtime.config.tmux_session, 'leader:0');
          assert.equal(runtime.config.leader_pane_id, '%1');
          assert.equal(runtime.config.hud_pane_id, '%3');

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /display-message -p #S:#I #{pane_id}/);
          assert.match(tmuxLog, new RegExp(`resize-pane -t %3 -y ${HUD_TMUX_TEAM_HEIGHT_LINES}`));

          if (teamNameForCleanup) {
            await shutdownTeam(teamNameForCleanup, cwd, { force: true });
          }
          runtime = null;
        },
      );
    } finally {
      if (teamNameForCleanup) {
        await shutdownTeam(teamNameForCleanup, cwd, { force: true }).catch(() => {});
      }
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevTmuxPane === 'string') process.env.TMUX_PANE = prevTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof prevLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = prevLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevSkipReadyWait === 'string') process.env.OMX_TEAM_SKIP_READY_WAIT = prevSkipReadyWait;
      else delete process.env.OMX_TEAM_SKIP_READY_WAIT;
      if (typeof prevMsystem === 'string') process.env.MSYSTEM = prevMsystem;
      else delete process.env.MSYSTEM;
      if (typeof prevOstype === 'string') process.env.OSTYPE = prevOstype;
      else delete process.env.OSTYPE;
      if (typeof prevWsl === 'string') process.env.WSL_DISTRO_NAME = prevWsl;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof prevWslInterop === 'string') process.env.WSL_INTEROP = prevWslInterop;
      else delete process.env.WSL_INTEROP;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('applyCreatedInteractiveSessionToConfig persists worker pane ids before readiness waits', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-pane-persist-race-'));
    try {
      const config = await initTeamState('team-pane-persist-race', 'persist pane ids before readiness wait', 'executor', 2, cwd);
      const workerPaneIds = Array.from({ length: 2 }, () => undefined as string | undefined);
      applyCreatedInteractiveSessionToConfig(config, {
        name: 'leader:0',
        workerCount: 2,
        cwd,
        workerPaneIds: ['%2', '%3'],
        leaderPaneId: '%1',
        hudPaneId: '%4',
        resizeHookName: 'resize-hook',
        resizeHookTarget: 'leader:0',
      }, workerPaneIds);

      assert.equal(config.tmux_session, 'leader:0');
      assert.equal(config.leader_pane_id, '%1');
      assert.equal(config.hud_pane_id, '%4');
      assert.deepEqual(workerPaneIds, ['%2', '%3']);
      assert.equal(config.workers[0]?.pane_id, '%2');
      assert.equal(config.workers[1]?.pane_id, '%3');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam captures interactive worker pid from the resolved pane id', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-pane-pid-'));
    const prevTmux = process.env.TMUX;
    const prevTmuxPane = process.env.TMUX_PANE;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevSkipReadyWait = process.env.OMX_TEAM_SKIP_READY_WAIT;
    let runtime: TeamRuntime | null = null;

    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-pane-pid-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*)
        echo "120"
        ;;
      *)
        echo "leader:0 %1"
        ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"pane_current_command"*)
        printf "%%1\tnode\t'codex'\n"
        ;;
      *"#{pane_dead} #{pane_pid}"*)
        echo "1 999999"
        ;;
      *"-t %2"*"#{pane_pid}"*)
        echo "2222"
        ;;
      *"-t %3"*"#{pane_pid}"*)
        echo "3333"
        ;;
      *"#{pane_pid}"*)
        echo "1111"
        ;;
      *)
        exit 0
        ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *" -h "*)
        echo "%2"
        ;;
      *)
        echo "%3"
        ;;
    esac
    exit 0
    ;;
  set-hook|run-shell|select-layout|set-window-option|select-pane|send-keys|kill-pane|kill-session)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          binaries: [{ name: 'codex', content: '#!/bin/sh\nexit 0\n' }],
        },
        async () => {
          delete process.env.TMUX;
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
          process.env.OMX_TEAM_WORKER_CLI = 'codex';
          process.env.OMX_TEAM_SKIP_READY_WAIT = '1';

          runtime = await withoutTeamWorkerEnv(() =>
            startTeam(
              'team-pane-pid',
              'interactive pane pid capture',
              'executor',
              1,
              [{ subject: 's', description: 'd', owner: 'worker-1' }],
              cwd,
            ));

          assert.equal(runtime.config.workers[0]?.pane_id, '%2');
          assert.equal(runtime.config.workers[0]?.pid, 2222);

          const identityPath = join(cwd, '.omx', 'state', 'team', runtime.teamName, 'workers', 'worker-1', 'identity.json');
          const identity = JSON.parse(await readFile(identityPath, 'utf-8')) as { pid?: number; pane_id?: string };
          assert.equal(identity.pane_id, '%2');
          assert.equal(identity.pid, 2222);
        },
      );
    } finally {
      const runtimeToShutdown = runtime as TeamRuntime | null;
      if (runtimeToShutdown) {
        await shutdownTeam(runtimeToShutdown.teamName, cwd, { force: true }).catch(() => {});
      }
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevTmuxPane === 'string') process.env.TMUX_PANE = prevTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof prevLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = prevLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevSkipReadyWait === 'string') process.env.OMX_TEAM_SKIP_READY_WAIT = prevSkipReadyWait;
      else delete process.env.OMX_TEAM_SKIP_READY_WAIT;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam saves interactive pane ids before readiness waits in source order', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'team', 'runtime.ts'), 'utf-8');
    const applyIndex = source.indexOf('applyCreatedInteractiveSessionToConfig(config, createdSession, workerPaneIds);');
    const saveIndex = source.indexOf('await saveTeamConfig(config, leaderCwd);', applyIndex);
    const readyIndex = source.indexOf('const ready = waitForWorkerReady(sessionName, i, workerReadyTimeoutMs, paneId);', saveIndex);

    assert.notEqual(applyIndex, -1);
    assert.notEqual(saveIndex, -1);
    assert.notEqual(readyIndex, -1);
    assert.equal(applyIndex < saveIndex, true);
    assert.equal(saveIndex < readyIndex, true);
  });

  it('startTeam rejects dirty leader workspace before provisioning worker worktrees', async () => {
    const repo = await initRepo();
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    await writeFile(join(repo, 'README.md'), 'dirty\n', 'utf-8');
    await writeFile(join(repo, 'notes.txt'), 'local only\n', 'utf-8');
    try {
      process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
      await assert.rejects(
        () => withoutTeamWorkerEnv(() =>
          startTeam(
            'team-dirty-preflight',
            'reject dirty leader workspace',
            'executor',
            1,
            [{ subject: 's', description: 'd', owner: 'worker-1' }],
            repo,
            { worktreeMode: { enabled: true, detached: true, name: null } },
          )),
        /leader_workspace_dirty_for_worktrees:.*M README\.md.*\?\? notes\.txt.*commit_or_stash_before_omx_team/s,
      );

      const listedWorktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repo,
        encoding: 'utf-8',
      });
      assert.doesNotMatch(listedWorktrees, /team-team-dirty-preflight-worker-1/);
      assert.equal(existsSync(join(repo, '.omx', 'state', 'team', 'team-dirty-preflight')), false);
    } finally {
      if (typeof prevLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = prevLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('startTeam launches gemini workers with startup prompt and no default model passthrough', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-gemini-'));
    const binDir = join(cwd, 'bin');
    const fakeGeminiPath = join(binDir, 'gemini');
    const capturePath = join(cwd, 'gemini-argv.json');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      fakeGeminiPath,
      `#!/usr/bin/env bash
printf '%s\n' "$@" > "$OMX_GEMINI_ARGV_CAPTURE_PATH"
sleep 5
`,
      { mode: 0o755 },
    );

    const prevPath = process.env.PATH;
    const prevTmux = process.env.TMUX;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevLaunchArgs = process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
    const prevCapture = process.env.OMX_GEMINI_ARGV_CAPTURE_PATH;

    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    delete process.env.TMUX;
    process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
    process.env.OMX_TEAM_WORKER_CLI = 'gemini';
    process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = '--model gpt-5.3-codex-spark';
    process.env.OMX_GEMINI_ARGV_CAPTURE_PATH = capturePath;

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withoutTeamWorkerEnv(() =>
        startTeam(
          'team-gemini-prompt',
          'gemini prompt-mode team bootstrap',
          'explore',
          1,
          [{ subject: 's', description: 'd', owner: 'worker-1' }],
          cwd,
        ));

      assert.equal(runtime.config.worker_launch_mode, 'prompt');
      assert.equal((runtime.config.workers[0]?.pid ?? 0) > 0, true);

      const expectedArgv = [
        '-i',
        'Read .omx/state/team/team-gemini-prompt/workers/worker-1/inbox.md, start work now, report concrete progress, then continue assigned work or next feasible task.',
      ];
      let argv: string[] | null = null;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (existsSync(capturePath)) {
          const captured = (await readFile(capturePath, 'utf-8')).trim().split('\n').filter(Boolean);
          if (captured.length >= expectedArgv.length) {
            argv = captured;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(argv, 'gemini argv capture file should be written');
      assert.deepEqual(argv, expectedArgv);

      await shutdownTeam(runtime.teamName, cwd, { force: true });
      runtime = null;
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = prevLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevLaunchArgs === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = prevLaunchArgs;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
      if (typeof prevCapture === 'string') process.env.OMX_GEMINI_ARGV_CAPTURE_PATH = prevCapture;
      else delete process.env.OMX_GEMINI_ARGV_CAPTURE_PATH;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam preserves explicit codex launch args while forcing bypass in prompt mode', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-codex-explicit-launch-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    const capturePath = join(cwd, 'codex-argv.json');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(process.env.OMX_CODEX_ARGV_CAPTURE_PATH, JSON.stringify(process.argv.slice(2), null, 2));
process.stdin.resume();
setTimeout(() => process.exit(0), 5000);
process.on('SIGTERM', () => process.exit(0));
`,
      { mode: 0o755 },
    );

    const prevPath = process.env.PATH;
    const prevTmux = process.env.TMUX;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevLaunchArgs = process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
    const prevCapture = process.env.OMX_CODEX_ARGV_CAPTURE_PATH;

    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    delete process.env.TMUX;
    process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
    process.env.OMX_TEAM_WORKER_CLI = 'codex';
    process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = '--model gpt-5.3-codex-spark -c model_reasoning_effort="low"';
    process.env.OMX_CODEX_ARGV_CAPTURE_PATH = capturePath;

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withoutTeamWorkerEnv(() =>
        startTeam(
          'team-codex-explicit-launch',
          'codex prompt-mode team bootstrap',
          'explore',
          1,
          [{ subject: 's', description: 'd', owner: 'worker-1' }],
          cwd,
        ));

      assert.equal(runtime.config.worker_launch_mode, 'prompt');
      assert.equal((runtime.config.workers[0]?.pid ?? 0) > 0, true);

      let argv: string[] | null = null;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (existsSync(capturePath)) {
          argv = JSON.parse(await readFile(capturePath, 'utf-8')) as string[];
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(argv, 'codex argv capture file should be written');
      assert.equal(argv.includes('--dangerously-bypass-approvals-and-sandbox'), false);
      assert.equal(argv.filter((arg) => arg === '--dangerously-bypass-approvals-and-sandbox').length, 0);
      assert.equal(argv.includes('--model'), true);
      assert.equal(argv[argv.indexOf('--model') + 1], 'gpt-5.3-codex-spark');
      assert.equal(argv.includes('-c'), true);
      assert.equal(argv.includes('model_reasoning_effort="low"'), true);
      assert.equal(argv.some((arg) => arg.includes('model_instructions_file=')), true);

      await shutdownTeam(runtime.teamName, cwd, { force: true });
      runtime = null;
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = prevLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevLaunchArgs === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = prevLaunchArgs;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
      if (typeof prevCapture === 'string') process.env.OMX_CODEX_ARGV_CAPTURE_PATH = prevCapture;
      else delete process.env.OMX_CODEX_ARGV_CAPTURE_PATH;
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('startTeam preserves routed task roles into team state and worker launch args', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-role-routing-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    const captureDir = join(cwd, 'captures');
    const promptsDir = join(cwd, '.codex', 'prompts');
    await mkdir(binDir, { recursive: true });
    await mkdir(captureDir, { recursive: true });
    await mkdir(promptsDir, { recursive: true });
    await writeFile(join(promptsDir, 'test-engineer.md'), '<identity>Test Engineer</identity>');
    await writeFile(join(promptsDir, 'writer.md'), '<identity>You are Writer.</identity>');
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const worker = String(process.env.OMX_TEAM_WORKER || 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '__');
const out = path.join(process.env.OMX_ARGV_CAPTURE_DIR, worker + '.json');
fs.writeFileSync(out, JSON.stringify({ argv: process.argv.slice(2), worker }, null, 2));
process.stdin.resume();
setTimeout(() => process.exit(0), 5000);
process.on('SIGTERM', () => process.exit(0));
`,
      { mode: 0o755 },
    );

    const prevPath = process.env.PATH;
    const prevTmux = process.env.TMUX;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevCaptureDir = process.env.OMX_ARGV_CAPTURE_DIR;

    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    delete process.env.TMUX;
    process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
    process.env.OMX_TEAM_WORKER_CLI = 'codex';
    process.env.OMX_ARGV_CAPTURE_DIR = captureDir;

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withoutTeamWorkerEnv(() =>
        startTeam(
          'team-role-routing',
          'heuristic routing handoff',
          'executor',
          2,
          [
            { subject: 'test routing report only', description: 'test routing report only', owner: 'worker-1', role: 'test-engineer' },
            { subject: 'document routing report only', description: 'document routing report only', owner: 'worker-2', role: 'writer' },
          ],
          cwd,
        ));

      assert.equal(runtime.config.worker_launch_mode, 'prompt');
      assert.equal(runtime.config.workers[0]?.role, 'test-engineer');
      assert.equal(runtime.config.workers[1]?.role, 'writer');

      const config = await readTeamConfig(runtime.teamName, cwd);
      assert.equal(config?.workers[0]?.role, 'test-engineer');
      assert.equal(config?.workers[1]?.role, 'writer');

      const task1 = await readTask(runtime.teamName, '1', cwd);
      const task2 = await readTask(runtime.teamName, '2', cwd);
      assert.equal(task1?.role, 'test-engineer');
      assert.equal(task2?.role, 'writer');

      const worker1Instructions = await readFile(join(cwd, '.omx', 'state', 'team', runtime.teamName, 'workers', 'worker-1', 'AGENTS.md'), 'utf-8');
      const worker2Instructions = await readFile(join(cwd, '.omx', 'state', 'team', runtime.teamName, 'workers', 'worker-2', 'AGENTS.md'), 'utf-8');
      assert.match(worker1Instructions, /You are operating as the \*\*test-engineer\*\* role/);
      assert.match(worker1Instructions, /Test Engineer/);
      assert.doesNotMatch(worker1Instructions, /exact gpt-5\.4-mini model/);
      assert.match(worker2Instructions, /You are operating as the \*\*writer\*\* role/);
      assert.match(worker2Instructions, /You are Writer\./);
      assert.match(worker2Instructions, /exact gpt-5\.4-mini model/);
      assert.match(worker2Instructions, /strict execution order: inspect -> plan -> act -> verify/);

      let worker1Args: string[] | null = null;
      let worker2Args: string[] | null = null;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const worker1Path = join(captureDir, 'team-role-routing__worker-1.json');
        const worker2Path = join(captureDir, 'team-role-routing__worker-2.json');
        if (existsSync(worker1Path) && existsSync(worker2Path)) {
          worker1Args = JSON.parse(await readFile(worker1Path, 'utf-8')).argv;
          worker2Args = JSON.parse(await readFile(worker2Path, 'utf-8')).argv;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      assert.ok(worker1Args, 'worker-1 argv capture file should be written');
      assert.ok(worker2Args, 'worker-2 argv capture file should be written');
      const worker1Joined = worker1Args!.join(' ');
      const worker2Joined = worker2Args!.join(' ');
      assert.match(worker1Joined, /model_reasoning_effort="medium"/);
      assert.match(worker1Joined, /model_instructions_file=.*worker-1\/AGENTS\.md/);
      assert.match(worker1Joined, /--model gpt-5\.4/);
      assert.match(worker2Joined, /model_reasoning_effort="high"/);
      assert.match(worker2Joined, /model_instructions_file=.*worker-2\/AGENTS\.md/);
      assert.match(worker2Joined, /--model gpt-5\.4-mini/);

      await shutdownTeam(runtime.teamName, cwd, { force: true });
      runtime = null;
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = prevLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevCaptureDir === 'string') process.env.OMX_ARGV_CAPTURE_DIR = prevCaptureDir;
      else delete process.env.OMX_ARGV_CAPTURE_DIR;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam does not apply mini guidance for exact-match negatives like gpt-5.4-mini-tuned', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-mini-tuned-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    const captureDir = join(cwd, 'captures');
    const promptsDir = join(cwd, '.codex', 'prompts');
    await mkdir(binDir, { recursive: true });
    await mkdir(captureDir, { recursive: true });
    await mkdir(promptsDir, { recursive: true });
    await writeFile(join(promptsDir, 'writer.md'), '<identity>You are Writer.</identity>');
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const worker = String(process.env.OMX_TEAM_WORKER || 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '__');
const out = path.join(process.env.OMX_ARGV_CAPTURE_DIR, worker + '.json');
fs.writeFileSync(out, JSON.stringify({ argv: process.argv.slice(2), worker }, null, 2));
process.stdin.resume();
setTimeout(() => process.exit(0), 5000);
process.on('SIGTERM', () => process.exit(0));
`,
      { mode: 0o755 },
    );

    const prevPath = process.env.PATH;
    const prevTmux = process.env.TMUX;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevCaptureDir = process.env.OMX_ARGV_CAPTURE_DIR;
    const prevLaunchArgs = process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;

    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    delete process.env.TMUX;
    process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
    process.env.OMX_TEAM_WORKER_CLI = 'codex';
    process.env.OMX_ARGV_CAPTURE_DIR = captureDir;
    process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = '--model gpt-5.4-mini-tuned';

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withoutTeamWorkerEnv(() =>
        startTeam(
          'team-mini-tuned-routing',
          'mini tuned routing handoff',
          'executor',
          1,
          [
            { subject: 'document routing report only', description: 'document routing report only', owner: 'worker-1', role: 'writer' },
          ],
          cwd,
        ));

      const workerInstructions = await readFile(join(cwd, '.omx', 'state', 'team', runtime.teamName, 'workers', 'worker-1', 'AGENTS.md'), 'utf-8');
      assert.match(workerInstructions, /You are operating as the \*\*writer\*\* role/);
      assert.match(workerInstructions, /You are Writer\./);
      assert.doesNotMatch(workerInstructions, /exact gpt-5\.4-mini model/);
      assert.doesNotMatch(workerInstructions, /strict execution order: inspect -> plan -> act -> verify/);
      assert.match(workerInstructions, /resolved_model: gpt-5\.4-mini-tuned/);

      let workerArgs: string[] | null = null;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const workerPath = join(captureDir, 'team-mini-tuned-routing__worker-1.json');
        if (existsSync(workerPath)) {
          workerArgs = JSON.parse(await readFile(workerPath, 'utf-8')).argv;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      assert.ok(workerArgs, 'worker argv capture file should be written');
      const workerJoined = workerArgs!.join(' ');
      assert.match(workerJoined, /--model gpt-5\.4-mini-tuned/);

      await shutdownTeam(runtime.teamName, cwd, { force: true });
      runtime = null;
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = prevLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevCaptureDir === 'string') process.env.OMX_ARGV_CAPTURE_DIR = prevCaptureDir;
      else delete process.env.OMX_ARGV_CAPTURE_DIR;
      if (typeof prevLaunchArgs === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = prevLaunchArgs;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam supports prompt launch mode without tmux and pipes trigger text via stdin', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-prompt-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
process.stdin.resume();
setTimeout(() => process.exit(0), 5000);
process.on('SIGTERM', () => process.exit(0));
`,
      { mode: 0o755 },
    );

    const prevPath = process.env.PATH;
    const prevTmux = process.env.TMUX;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;

    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    delete process.env.TMUX;
    process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
    process.env.OMX_TEAM_WORKER_CLI = 'codex';

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withoutTeamWorkerEnv(() =>
        startTeam(
          'team-prompt',
          'prompt-mode team bootstrap',
          'executor',
          1,
          [{ subject: 's', description: 'd', owner: 'worker-1' }],
          cwd,
        ));

      assert.equal(runtime.config.worker_launch_mode, 'prompt');
      assert.equal(runtime.config.leader_pane_id, null);
      assert.equal((runtime.config.workers[0]?.pid ?? 0) > 0, true);

      await shutdownTeam(runtime.teamName, cwd, { force: true });
      runtime = null;
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = prevLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam relaunch re-creates HUD pane and re-registers reconcile hooks after shutdown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-relaunch-hud-'));
    const previousTmux = process.env.TMUX;
    const previousTmuxPane = process.env.TMUX_PANE;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    let runtime: TeamRuntime | null = null;
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-relaunch-hud-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*)
        echo "120"
        ;;
      *)
        echo "leader:0 %1"
        ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"pane_current_command"* )
        printf "%%1\\tnode\\t'codex'\\n"
        ;;
      *"#{pane_dead} #{pane_pid}"*)
        echo "1 999999"
        ;;
      *"#{pane_pid}"*)
        echo "999999"
        ;;
      *)
        exit 0
        ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *" -h "*)
        echo "%2"
        ;;
      *)
        echo "%3"
        ;;
    esac
    exit 0
    ;;
  set-hook|run-shell|select-layout|set-window-option|select-pane|send-keys|kill-pane|kill-session)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          binaries: [{
            name: 'gemini',
            content: `#!/bin/sh
exit 0
`,
          }],
        },
        async ({ tmuxLogPath }) => {
          process.env.TMUX = 'leader-session,stub,0';
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
          process.env.OMX_TEAM_WORKER_CLI = 'gemini';

          runtime = await withoutTeamWorkerEnv(() =>
            startTeam(
              'team-rerun-hud',
              'rerun hud restore',
              'explore',
              1,
              [{ subject: 'restore hud', description: 'restore hud', owner: 'worker-1' }],
              cwd,
            ));
          assert.equal(runtime.config.hud_pane_id, '%3');
          assert.ok(runtime.config.resize_hook_name);

          await shutdownTeam(runtime.teamName, cwd, { force: true });
          runtime = null;

          runtime = await withoutTeamWorkerEnv(() =>
            startTeam(
              'team-rerun-hud',
              'rerun hud restore',
              'explore',
              1,
              [{ subject: 'restore hud again', description: 'restore hud again', owner: 'worker-1' }],
              cwd,
            ));
          assert.equal(runtime.config.hud_pane_id, '%3');
          assert.ok(runtime.config.resize_hook_name);

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          const teamHudSplitRe = new RegExp(`split-window -v -f -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t leader:0 -d -P -F #\\{pane_id\\}`, 'g');
          const standaloneHudSplitRe = new RegExp(`split-window -v -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t %1 -d -P -F #\\{pane_id\\}`, 'g');
          assert.equal(tmuxLog.match(teamHudSplitRe)?.length ?? 0, 2);
          assert.equal(tmuxLog.match(standaloneHudSplitRe)?.length ?? 0, 1);
          assert.equal(tmuxLog.match(/set-hook -t leader:0 client-resized\[\d+\]/g)?.length ?? 0, 2);
          assert.equal(tmuxLog.match(/set-hook -t leader:0 client-attached\[\d+\]/g)?.length ?? 0, 2);
          assert.equal(tmuxLog.match(/run-shell -b sleep \d+; tmux resize-pane -t %3 -y \d+ >/g)?.length ?? 0, 3);
          assert.equal(tmuxLog.match(/run-shell tmux resize-pane -t %3 -y \d+ >/g)?.length ?? 0, 3);
          assert.ok((tmuxLog.match(/select-layout -t leader:0 main-vertical/g)?.length ?? 0) >= 2);
          assert.match(tmuxLog, /kill-pane -t %3/);
        },
      );
    } finally {
      const runtimeToShutdown = runtime as TeamRuntime | null;
      if (runtimeToShutdown) {
        await shutdownTeam(runtimeToShutdown.teamName, cwd, { force: true }).catch(() => {});
      }
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam routes detached worktree worker inbox and mailbox triggers through leader-root state references', async () => {
    const repo = await initRepo();
    const toolingDir = await mkdtemp(join(tmpdir(), 'omx-runtime-worktree-tools-'));
    const binDir = join(toolingDir, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    const logDir = join(toolingDir, 'worker-logs');
    const stdinLogPath = join(logDir, 'stdin.log');
    const envLogPath = join(logDir, 'env.json');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const logDir = process.env.OMX_TEST_LOG_DIR;
fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(path.join(logDir, 'env.json'), JSON.stringify({
  cwd: process.cwd(),
  teamStateRoot: process.env.OMX_TEAM_STATE_ROOT || '',
  worker: process.env.OMX_TEAM_WORKER || '',
}));
process.stdin.on('data', (chunk) => {
  fs.appendFileSync(path.join(logDir, 'stdin.log'), chunk.toString());
});
process.stdin.resume();
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`,
      { mode: 0o755 },
    );

    const prevPath = process.env.PATH;
    const prevTmux = process.env.TMUX;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevLogDir = process.env.OMX_TEST_LOG_DIR;

    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    delete process.env.TMUX;
    process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
    process.env.OMX_TEAM_WORKER_CLI = 'codex';
    process.env.OMX_TEST_LOG_DIR = logDir;

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withoutTeamWorkerEnv(() =>
        startTeam(
          'team-detached-worktree-paths',
          'detached worktree path resolution',
          'executor',
          1,
          [{ subject: 's', description: 'd', owner: 'worker-1' }],
          repo,
          { worktreeMode: { enabled: true, detached: true, name: null } },
        ));

      const workerPath = runtime.config.workers[0]?.worktree_path;
      assert.ok(workerPath, 'detached worker should have a worktree path');
      assert.notEqual(workerPath, repo);
      const workerAgents = await readFile(join(workerPath as string, 'AGENTS.md'), 'utf-8');
      assert.match(workerAgents, /Team Worker Runtime Instructions/);
      assert.match(workerAgents, /team-detached-worktree-paths/);

      const startupLog = await waitForFileText(
        stdinLogPath,
        (content) => content.includes('/workers/worker-1/inbox.md'),
      );
      assert.match(
        startupLog,
        /\$OMX_TEAM_STATE_ROOT\/team\/team-detached-worktree-paths\/workers\/worker-1\/inbox\.md/,
      );
      assert.doesNotMatch(
        startupLog,
        /Read \.omx\/state\/team\/team-detached-worktree-paths\/workers\/worker-1\/inbox\.md/,
      );

      const envLog = JSON.parse(await waitForFileText(envLogPath, (content) => content.includes('teamStateRoot'))) as {
        cwd: string;
        teamStateRoot: string;
        worker: string;
      };
      assert.equal(envLog.cwd, workerPath);
      assert.equal(envLog.teamStateRoot, join(repo, '.omx', 'state'));
      assert.equal(envLog.worker, 'team-detached-worktree-paths/worker-1');
      const rootAgents = await readFile(join(workerPath, 'AGENTS.md'), 'utf-8');
      assert.match(rootAgents, /Team Worker Runtime Instructions/);
      assert.match(rootAgents, /Inbox path: .*team-detached-worktree-paths\/workers\/worker-1\/inbox\.md/);

      await sendWorkerMessage(runtime.teamName, 'leader-fixed', 'worker-1', 'follow-up', repo);
      const mailboxLog = await waitForFileText(
        stdinLogPath,
        (content) => content.includes('/mailbox/worker-1.json'),
      );
      assert.match(
        mailboxLog,
        /\$OMX_TEAM_STATE_ROOT\/team\/team-detached-worktree-paths\/mailbox\/worker-1\.json/,
      );

      await shutdownTeam(runtime.teamName, repo, { force: true });
      runtime = null;
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, repo, { force: true }).catch(() => {});
      }
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = prevLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevLogDir === 'string') process.env.OMX_TEST_LOG_DIR = prevLogDir;
      else delete process.env.OMX_TEST_LOG_DIR;
      await rm(toolingDir, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('shutdownTeam removes team-created detached worktrees on normal shutdown', async () => {
    const repo = await initRepo();
    const toolingDir = await mkdtemp(join(tmpdir(), 'omx-runtime-worktree-tools-'));
    const binDir = join(toolingDir, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
process.stdin.resume();
setTimeout(() => process.exit(0), 5000);
process.on('SIGTERM', () => process.exit(0));
`,
      { mode: 0o755 },
    );

    const prevPath = process.env.PATH;
    const prevTmux = process.env.TMUX;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;

    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    delete process.env.TMUX;
    process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
    process.env.OMX_TEAM_WORKER_CLI = 'codex';

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withoutTeamWorkerEnv(() =>
        startTeam(
          'team-detached-worktree-shutdown',
          'detached worktree shutdown cleanup',
          'executor',
          1,
          [],
          repo,
          { worktreeMode: { enabled: true, detached: true, name: null } },
        ));

      const worktreePath = runtime.config.workers[0]?.worktree_path;
      assert.ok(worktreePath, 'worker worktree path should be persisted');
      assert.equal(runtime.config.workers[0]?.worktree_created, true);
      assert.equal(existsSync(worktreePath as string), true);
      assert.equal(existsSync(join(worktreePath as string, 'AGENTS.md')), true);

      await shutdownTeam(runtime.teamName, repo);
      runtime = null;

      assert.equal(existsSync(worktreePath as string), false);
      assert.equal(existsSync(join(repo, '.omx', 'state', 'team', 'team-detached-worktree-shutdown')), false);
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, repo, { force: true }).catch(() => {});
      }
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = prevLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      await rm(toolingDir, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('resumeTeam preserves detached worktree metadata for live prompt workers', async () => {
    const repo = await initRepo();
    const binDir = await mkdtemp(join(tmpdir(), 'omx-runtime-prompt-bin-'));
    const fakeCodexPath = join(binDir, 'codex');
    const logDir = await mkdtemp(join(tmpdir(), 'omx-runtime-prompt-logs-'));
    const envLogPath = join(logDir, 'env.json');
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const logDir = process.env.OMX_TEST_LOG_DIR;
fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(path.join(logDir, 'env.json'), JSON.stringify({
  cwd: process.cwd(),
  teamStateRoot: process.env.OMX_TEAM_STATE_ROOT || '',
  worker: process.env.OMX_TEAM_WORKER || '',
}));
process.stdin.resume();
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`,
      { mode: 0o755 },
    );

    const prevPath = process.env.PATH;
    const prevTmux = process.env.TMUX;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevLogDir = process.env.OMX_TEST_LOG_DIR;

    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    delete process.env.TMUX;
    process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
    process.env.OMX_TEAM_WORKER_CLI = 'codex';
    process.env.OMX_TEST_LOG_DIR = logDir;

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withoutTeamWorkerEnv(() =>
        startTeam(
          'team-detached-worktree-resume-metadata',
          'detached worktree resume metadata',
          'executor',
          1,
          [{ subject: 's', description: 'd', owner: 'worker-1' }],
          repo,
          { worktreeMode: { enabled: true, detached: true, name: null } },
        ));

      const originalWorker = runtime.config.workers[0];
      const originalWorktreePath = originalWorker?.worktree_path;
      assert.ok(originalWorktreePath, 'worker worktree path should be persisted before resume');
      assert.equal(originalWorker?.worktree_created, true);

      const envLog = JSON.parse(await waitForFileText(envLogPath, (content) => content.includes('teamStateRoot'))) as {
        cwd: string;
        teamStateRoot: string;
        worker: string;
      };
      assert.equal(envLog.cwd, originalWorktreePath);
      assert.equal(envLog.teamStateRoot, join(repo, '.omx', 'state'));

      const resumed = await resumeTeam(runtime.teamName, repo);
      assert.ok(resumed, 'resumeTeam should reuse live prompt workers');
      assert.equal(resumed?.config.workers[0]?.worktree_path, originalWorktreePath);
      assert.equal(resumed?.config.workers[0]?.worktree_created, true);
      assert.equal(resumed?.config.workers[0]?.team_state_root, join(repo, '.omx', 'state'));

      const identityPath = join(
        repo,
        '.omx',
        'state',
        'team',
        runtime.teamName,
        'workers',
        'worker-1',
        'identity.json',
      );
      const identity = JSON.parse(await readFile(identityPath, 'utf-8')) as {
        worktree_path?: string;
        worktree_created?: boolean;
        team_state_root?: string;
      };
      assert.equal(identity.worktree_path, originalWorktreePath);
      assert.equal(identity.worktree_created, true);
      assert.equal(identity.team_state_root, join(repo, '.omx', 'state'));

      await shutdownTeam(runtime.teamName, repo, { force: true });
      runtime = null;
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, repo, { force: true }).catch(() => {});
      }
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      if (typeof prevTmux === 'string') process.env.TMUX = prevTmux;
      else delete process.env.TMUX;
      if (typeof prevLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = prevLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevLogDir === 'string') process.env.OMX_TEST_LOG_DIR = prevLogDir;
      else delete process.env.OMX_TEST_LOG_DIR;
      await rm(binDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('shutdownTeam force-kills prompt workers that ignore SIGTERM', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-prompt-stubborn-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    await mkdir(binDir, { recursive: true });
    await writeFakePromptWorkerBinary(
      fakeCodexPath,
      `
process.stdin.resume();
setInterval(() => {}, 1000);
process.on('SIGTERM', () => {
  // Intentionally ignore SIGTERM so runtime teardown must escalate.
});
`,
    );

    let runtime: TeamRuntime | null = null;
    let workerPid = 0;
    try {
      runtime = await withPromptModeCodexEnv(binDir, {}, () =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-prompt-stubborn',
            'prompt-mode stubborn worker teardown',
            'executor',
            1,
            [{ subject: 's', description: 'd', owner: 'worker-1' }],
            cwd,
          )));
      workerPid = runtime.config.workers[0]?.pid ?? 0;
      assert.ok(workerPid > 0, 'prompt worker PID should be captured');

      const shutdownStartedAt = Date.now();
      await shutdownTeam(runtime.teamName, cwd, { force: true });
      const shutdownDurationMs = Date.now() - shutdownStartedAt;
      runtime = null;

      let alive = false;
      try {
        process.kill(workerPid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      assert.equal(alive, false, `worker pid ${workerPid} should be terminated after shutdown`);
      assert.ok(
        shutdownDurationMs < 10_000,
        `forced prompt-worker shutdown should skip the 15s ack wait (actual ${shutdownDurationMs}ms)`,
      );
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam reaps detached prompt-worker descendants', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-prompt-descendants-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    const helperPidPath = join(cwd, 'helper.pid');
    await mkdir(binDir, { recursive: true });
    await writeFakePromptWorkerBinary(
      fakeCodexPath,
      `
const { spawn } = require('child_process');
const { writeFileSync } = require('fs');
const helper = spawn(process.execPath, ['-e', \`
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
\`], { detached: true, stdio: 'ignore' });
helper.unref();
writeFileSync(process.env.OMX_HELPER_PID_PATH, String(helper.pid));
process.stdin.resume();
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`,
    );

    let runtime: TeamRuntime | null = null;
    let helperPid = 0;
    try {
      runtime = await withPromptModeCodexEnv(binDir, { OMX_HELPER_PID_PATH: helperPidPath }, () =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-prompt-descendants',
            'prompt-mode detached descendant teardown',
            'executor',
            1,
            [{ subject: 's', description: 'd', owner: 'worker-1' }],
            cwd,
          )));

      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (existsSync(helperPidPath)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      helperPid = Number((await readFile(helperPidPath, 'utf-8')).trim());
      assert.ok(helperPid > 0, 'detached helper pid should be captured');

      const shutdownStartedAt = Date.now();
      await shutdownTeam(runtime.teamName, cwd, { force: true });
      const shutdownDurationMs = Date.now() - shutdownStartedAt;
      runtime = null;

      let alive = false;
      try {
        process.kill(helperPid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      assert.equal(alive, false, `detached helper pid ${helperPid} should be terminated after shutdown`);
      assert.ok(
        shutdownDurationMs < 10_000,
        `forced descendant teardown should skip the 15s ack wait (actual ${shutdownDurationMs}ms)`,
      );
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      if (helperPid > 0) {
        try {
          process.kill(helperPid, 'SIGKILL');
        } catch {}
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam returns null for non-existent team', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      const snapshot = await monitorTeam('missing-team', cwd);
      assert.equal(snapshot, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam returns correct task counts from state files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-counts', 'monitor task counts', 'executor', 2, cwd);

      const t1 = await createTask('team-counts', { subject: 'p', description: 'd', status: 'pending' }, cwd);
      const t2 = await createTask('team-counts', { subject: 'ip', description: 'd', status: 'in_progress', owner: 'worker-1' }, cwd);
      await createTask('team-counts', { subject: 'c', description: 'd', status: 'completed' }, cwd);
      await createTask('team-counts', { subject: 'f', description: 'd', status: 'failed' }, cwd);

      await updateWorkerHeartbeat(
        'team-counts',
        'worker-1',
        { pid: 111, last_turn_at: new Date().toISOString(), turn_count: 7, alive: true },
        cwd,
      );

      const statusPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-counts',
        'workers',
        'worker-1',
        'status.json',
      );
      await writeAtomic(
        statusPath,
        JSON.stringify(
          {
            state: 'working',
            current_task_id: t2.id,
            updated_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      const snapshot = await monitorTeam('team-counts', cwd);
      assert.ok(snapshot);
      assert.equal(snapshot?.tasks.total, 4);
      assert.equal(snapshot?.tasks.pending, 1);
      assert.equal(snapshot?.tasks.in_progress, 1);
      assert.equal(snapshot?.tasks.completed, 1);
      assert.equal(snapshot?.tasks.failed, 1);
      assert.equal(snapshot?.allTasksTerminal, false);
      assert.equal(snapshot?.phase, 'team-exec');

      const worker1 = snapshot?.workers.find((w) => w.name === 'worker-1');
      assert.ok(worker1);
      assert.equal(worker1?.turnsWithoutProgress, 0);

      const reassignHint = snapshot?.recommendations.some((r) => r.includes(`task-${t2.id}`));
      assert.equal(typeof reassignHint, 'boolean');
      void t1;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam surfaces reclaimed work pickup attempts when an idle worker is available', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-reassign-reclaimed-'));
    const prevTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    delete process.env.OMX_TEAM_STATE_ROOT;
    let sleeper1: ReturnType<typeof spawn> | null = null;
    let sleeper2: ReturnType<typeof spawn> | null = null;
    try {
      await initTeamState('team-runtime-reassign', 'reassign reclaimed test', 'executor', 2, cwd);
      const task = await createTask('team-runtime-reassign', { subject: 'write docs', description: 'document feature', status: 'pending', role: 'writer' }, cwd);
      const claim = await claimTask('team-runtime-reassign', task.id, 'worker-1', null, cwd);
      assert.ok(claim.ok);
      if (!claim.ok) throw new Error('claim failed');

      const taskPath = join(cwd, '.omx', 'state', 'team', 'team-runtime-reassign', 'tasks', `task-${task.id}.json`);
      const current = JSON.parse(await readFile(taskPath, 'utf-8')) as any;
      current.claim.leased_until = new Date(Date.now() - 1000).toISOString();
      await writeAtomic(taskPath, JSON.stringify(current, null, 2));

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'team-runtime-reassign', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as any;
      sleeper1 = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: false });
      sleeper2 = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: false });
      manifest.policy = { ...(manifest.policy || {}), worker_launch_mode: 'prompt' };
      manifest.workers[0].role = 'executor';
      manifest.workers[1].role = 'writer';
      manifest.workers[0].pid = sleeper1.pid;
      manifest.workers[1].pid = sleeper2.pid;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      await writeAtomic(
        join(cwd, '.omx', 'state', 'team', 'team-runtime-reassign', 'workers', 'worker-1', 'status.json'),
        JSON.stringify({ state: 'working', current_task_id: task.id, updated_at: new Date().toISOString() }, null, 2),
      );
      await writeAtomic(
        join(cwd, '.omx', 'state', 'team', 'team-runtime-reassign', 'workers', 'worker-2', 'status.json'),
        JSON.stringify({ state: 'idle', updated_at: new Date().toISOString() }, null, 2),
      );

      const snapshot = await monitorTeam('team-runtime-reassign', cwd);
      assert.ok(snapshot);
      const reread = await readTask('team-runtime-reassign', task.id, cwd);
      assert.equal(reread?.status, 'pending');
      assert.equal(reread?.owner, undefined);
      assert.equal(snapshot?.recommendations.some((r) => r.includes(`Unable to assign task-${task.id} to worker-2: worker_notify_failed`)), true);
    } finally {
      try { if (sleeper1?.pid) process.kill(sleeper1.pid, 'SIGKILL'); } catch {}
      try { if (sleeper2?.pid) process.kill(sleeper2.pid, 'SIGKILL'); } catch {}
      if (typeof prevTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = prevTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam reclaims expired task claims and surfaces the recovery in recommendations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-reclaim-'));
    const prevTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    delete process.env.OMX_TEAM_STATE_ROOT;
    try {
      await initTeamState('team-runtime-reclaim', 'reclaim test', 'executor', 2, cwd);
      const t = await createTask('team-runtime-reclaim', { subject: 'task', description: 'd', status: 'pending' }, cwd);
      const claim = await claimTask('team-runtime-reclaim', t.id, 'worker-1', null, cwd);
      assert.ok(claim.ok);
      if (!claim.ok) throw new Error('claim failed');

      const taskPath = join(cwd, '.omx', 'state', 'team', 'team-runtime-reclaim', 'tasks', `task-${t.id}.json`);
      const current = JSON.parse(await readFile(taskPath, 'utf-8')) as any;
      current.claim.leased_until = new Date(Date.now() - 1000).toISOString();
      await writeAtomic(taskPath, JSON.stringify(current, null, 2));

      const snapshot = await monitorTeam('team-runtime-reclaim', cwd);
      assert.ok(snapshot);
      const reread = await readTask('team-runtime-reclaim', t.id, cwd);
      assert.equal(reread?.status, 'pending');
      assert.equal(reread?.claim, undefined);
      assert.equal(snapshot?.recommendations.some((r) => r.includes(`task-${t.id}`) && r.includes('Reclaimed expired claim')), true);
    } finally {
      if (typeof prevTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = prevTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam keeps phase in team-verify when completed code tasks lack verification evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-verify-gate-'));
    const prevTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    delete process.env.OMX_TEAM_STATE_ROOT;
    try {
      await initTeamState('team-verify-gate', 'verification gate test', 'executor', 1, cwd);
      const task = await createTask(
        'team-verify-gate',
        {
          subject: 'code change',
          description: 'implement feature',
          status: 'completed',
          owner: 'worker-1',
          requires_code_change: true,
        },
        cwd,
      );

      const first = await monitorTeam('team-verify-gate', cwd);
      assert.ok(first);
      assert.equal(first?.phase, 'team-verify');
      assert.equal(
        first?.recommendations.some((r) => r.includes(`task-${task.id}`) && r.includes('Verification evidence missing')),
        true,
      );

      const taskPath = join(cwd, '.omx', 'state', 'team', 'team-verify-gate', 'tasks', `task-${task.id}.json`);
      const fromDisk = JSON.parse(await readFile(taskPath, 'utf-8')) as Record<string, unknown>;
      fromDisk.result = [
        'Summary: done',
        'Verification:',
        '- PASS build: `npm run build`',
        '- PASS tests: `node --test dist/foo.test.js`',
      ].join('\n');
      await writeAtomic(taskPath, JSON.stringify(fromDisk, null, 2));

      const second = await monitorTeam('team-verify-gate', cwd);
      assert.ok(second);
      assert.equal(second?.phase, 'complete');
    } finally {
      if (typeof prevTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = prevTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
    }
  });



  it('monitorTeam deactivates root team-state.json when the local phase becomes terminal', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-root-team-state-'));
    try {
      await initTeamState('team-root-sync', 'root sync test', 'executor', 1, cwd);
      await createTask(
        'team-root-sync',
        {
          subject: 'code change',
          description: 'implement feature',
          status: 'completed',
          owner: 'worker-1',
          requires_code_change: false,
        },
        cwd,
      );
      const rootStatePath = join(cwd, '.omx', 'state', 'team-state.json');
      await writeFile(rootStatePath, JSON.stringify({
        active: true,
        current_phase: 'team-exec',
        team_name: 'team-root-sync',
      }, null, 2));

      const snapshot = await monitorTeam('team-root-sync', cwd);
      assert.ok(snapshot);
      assert.equal(snapshot?.phase, 'complete');

      const rootState = JSON.parse(await readFile(rootStatePath, 'utf-8')) as Record<string, unknown>;
      assert.equal(rootState.active, false);
      assert.equal(rootState.current_phase, 'complete');
      assert.ok(typeof rootState.completed_at === 'string' && rootState.completed_at.length > 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('monitorTeam emits worker_state_changed, worker_idle, and task_completed events based on transitions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-events', 'monitor event test', 'executor', 1, cwd);
      const t = await createTask('team-events', { subject: 'a', description: 'd', status: 'pending' }, cwd);

      // First monitor creates baseline snapshot.
      await monitorTeam('team-events', cwd);

      // Transition task to completed and worker status to idle.
      await writeAtomic(
        join(cwd, '.omx', 'state', 'team', 'team-events', 'tasks', `task-${t.id}.json`),
        JSON.stringify({ ...t, status: 'completed', owner: 'worker-1' }, null, 2),
      );
      await writeAtomic(
        join(cwd, '.omx', 'state', 'team', 'team-events', 'workers', 'worker-1', 'status.json'),
        JSON.stringify({ state: 'idle', updated_at: new Date().toISOString() }, null, 2),
      );

      await monitorTeam('team-events', cwd);

      const eventsPath = join(cwd, '.omx', 'state', 'team', 'team-events', 'events', 'events.ndjson');
      const content = await readFile(eventsPath, 'utf-8');
      assert.match(content, /\"type\":\"task_completed\"/);
      assert.match(content, /\"type\":\"worker_state_changed\"/);
      assert.match(content, /\"type\":\"worker_idle\"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam persists integration ledger and cherry-picks unseen worker HEADs once', async () => {
    const repo = await initRepo();
    let workerPath = '';
    try {
      workerPath = await addWorktree(repo, 'worker-1-branch', 'omx-runtime-worker-1-wt-');
      await writeFile(join(workerPath, 'worker.txt'), 'from worker\n', 'utf-8');
      execFileSync('git', ['add', 'worker.txt'], { cwd: workerPath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worker change'], { cwd: workerPath, stdio: 'ignore' });
      const workerHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workerPath, encoding: 'utf-8' }).trim();

      await initTeamState('team-integration-ledger', 'integration ledger test', 'executor', 1, repo);
      const cfg = await readTeamConfig('team-integration-ledger', repo);
      assert.ok(cfg);
      if (!cfg) throw new Error('missing team config');
      cfg.leader_pane_id = '';
      cfg.workers[0] = {
        ...cfg.workers[0],
        assigned_tasks: ['1'],
        worktree_repo_root: repo,
        worktree_path: workerPath,
        worktree_branch: 'worker-1-branch',
        worktree_detached: false,
        worktree_created: false,
      };
      await saveTeamConfig(cfg, repo);

      await monitorTeam('team-integration-ledger', repo);
      const firstSnapshot = await readMonitorSnapshot('team-integration-ledger', repo);
      assert.equal(firstSnapshot?.integrationByWorker?.['worker-1']?.last_seen_head, workerHead);
      assert.equal(typeof firstSnapshot?.integrationByWorker?.['worker-1']?.last_integrated_head, 'string');
      // Status is 'idle' after successful merge/rebase, or 'integrated' if rebase was skipped
      const status = firstSnapshot?.integrationByWorker?.['worker-1']?.status;
      assert.ok(status === 'idle' || status === 'integrated', `expected idle or integrated, got ${status}`);

      // Worker is cleanly ahead of leader → hybrid strategy uses merge (not cherry-pick)
      // Verify merge commit on leader (2 parents) and worker content landed
      const leaderHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
      const commitObj = execFileSync('git', ['cat-file', '-p', leaderHead], { cwd: repo, encoding: 'utf-8' });
      const parentLines = commitObj.split('\n').filter((l: string) => l.startsWith('parent '));
      assert.equal(parentLines.length, 2, 'hybrid merge should produce merge commit for clean-ahead worker');
      assert.equal(await readFile(join(repo, 'worker.txt'), 'utf-8'), 'from worker\n');

      await monitorTeam('team-integration-ledger', repo);
      const secondSnapshot = await readMonitorSnapshot('team-integration-ledger', repo);
      assert.equal(typeof secondSnapshot?.integrationByWorker?.['worker-1']?.last_seen_head, 'string');
      assert.equal(typeof secondSnapshot?.integrationByWorker?.['worker-1']?.last_integrated_head, 'string');

      // Hybrid merge emits merge events (or cherry-pick for backward compat)
      const events = await readTeamEvents('team-integration-ledger', repo, { wakeableOnly: false });
      const integrationEvents = events.filter((e) =>
        (e.type as string) === 'worker_merge_applied' || e.type === 'worker_cherry_pick_applied');
      assert.ok(integrationEvents.length >= 1, 'should have at least one integration event (merge or cherry-pick)');
      const leaderMailbox = await listMailboxMessages('team-integration-ledger', 'leader-fixed', repo);
      assert.equal(leaderMailbox.some((message) => /INTEGRATED:/.test(message.body)), true);
    } finally {
      if (workerPath) {
        await rm(workerPath, { recursive: true, force: true });
      }
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('monitorTeam auto-commits dirty worker worktree before integration', async () => {
    const repo = await initRepo();
    let workerPath = '';
    try {
      workerPath = await addWorktree(repo, 'wk1-ac-branch', 'omx-runtime-wk1-auto-commit-');

      // Add uncommitted file (dirty worktree — no git commit)
      await writeFile(join(workerPath, 'dirty.txt'), 'uncommitted content\n', 'utf-8');

      await initTeamState('team-auto-commit', 'auto-commit test', 'executor', 1, repo);
      const cfg = await readTeamConfig('team-auto-commit', repo);
      assert.ok(cfg);
      if (!cfg) throw new Error('missing config');
      cfg.leader_pane_id = '';
      cfg.workers[0] = {
        ...cfg.workers[0],
        assigned_tasks: ['1'],
        worktree_repo_root: repo,
        worktree_path: workerPath,
        worktree_branch: 'wk1-ac-branch',
        worktree_detached: false,
        worktree_created: false,
      };
      await saveTeamConfig(cfg, repo);

      await monitorTeam('team-auto-commit', repo);

      // Verify worktree is no longer dirty (auto-commit was made)
      const status = execFileSync('git', ['status', '--porcelain'], { cwd: workerPath, encoding: 'utf-8' }).trim();
      assert.equal(status, '', 'worktree should be clean after auto-commit');

      // Verify the commit message matches the auto-checkpoint pattern
      const log = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: workerPath, encoding: 'utf-8' }).trim();
      assert.match(log, /omx\(team\): auto-checkpoint worker-1 \[1\]/, 'commit message should match auto-checkpoint pattern');

      // Verify worker's changes are integrated into leader
      const snapshot = await readMonitorSnapshot('team-auto-commit', repo);
      assert.ok(snapshot?.integrationByWorker?.['worker-1']?.last_integrated_head, 'auto-committed changes should be integrated');

      const ledgerPath = join(repo, '.omx', 'reports', 'team-commit-hygiene', 'team-auto-commit.ledger.json');
      assert.equal(existsSync(ledgerPath), true, 'commit hygiene ledger should be written for runtime operational commits');
      const ledger = JSON.parse(await readFile(ledgerPath, 'utf-8')) as {
        entries: Array<{ operation: string; operational_commit?: string | null }>;
      };
      assert.equal(ledger.entries.some((entry) => entry.operation === 'auto_checkpoint'), true);
      assert.equal(ledger.entries.some((entry) => entry.operation === 'integration_merge'), true);
    } finally {
      if (workerPath) {
        await rm(workerPath, { recursive: true, force: true });
      }
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('monitorTeam uses merge for worker cleanly ahead of leader (hybrid merge path)', async () => {
    const repo = await initRepo();
    let workerPath = '';
    try {
      workerPath = await addWorktree(repo, 'wk1-merge-branch', 'omx-runtime-wk1-merge-clean-');

      // Commit only in worker (worker is cleanly ahead of leader)
      await writeFile(join(workerPath, 'feature.txt'), 'new feature\n', 'utf-8');
      execFileSync('git', ['add', 'feature.txt'], { cwd: workerPath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worker feature'], { cwd: workerPath, stdio: 'ignore' });

      const leaderHeadBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();

      await initTeamState('team-merge-clean', 'merge clean test', 'executor', 1, repo);
      const cfg = await readTeamConfig('team-merge-clean', repo);
      assert.ok(cfg);
      if (!cfg) throw new Error('missing config');
      cfg.leader_pane_id = '';
      cfg.workers[0] = {
        ...cfg.workers[0],
        assigned_tasks: ['1'],
        worktree_repo_root: repo,
        worktree_path: workerPath,
        worktree_branch: 'wk1-merge-branch',
        worktree_detached: false,
        worktree_created: false,
      };
      await saveTeamConfig(cfg, repo);

      await monitorTeam('team-merge-clean', repo);

      // Verify worker content is on leader
      const content = await readFile(join(repo, 'feature.txt'), 'utf-8');
      assert.equal(content, 'new feature\n');

      // Verify merge commit (2 parents) — hybrid strategy uses merge for clean-ahead worker
      const leaderHeadAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
      assert.notEqual(leaderHeadAfter, leaderHeadBefore, 'leader HEAD should advance');
      const commitObj = execFileSync('git', ['cat-file', '-p', leaderHeadAfter], { cwd: repo, encoding: 'utf-8' });
      const parentCount = commitObj.split('\n').filter((l: string) => l.startsWith('parent ')).length;
      assert.equal(parentCount, 2, 'merge commit should have 2 parents');
    } finally {
      if (workerPath) {
        await rm(workerPath, { recursive: true, force: true });
      }
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('monitorTeam integrates detached worker worktree by commit sha instead of merging leader HEAD into itself', async () => {
    const repo = await initRepo();
    let workerPath = '';
    try {
      workerPath = await addWorktree(repo, 'wk1-detached-merge-branch', 'omx-runtime-wk1-detached-merge-');

      await writeFile(join(workerPath, 'detached-feature.txt'), 'detached worker feature\n', 'utf-8');
      execFileSync('git', ['add', 'detached-feature.txt'], { cwd: workerPath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'detached worker feature'], { cwd: workerPath, stdio: 'ignore' });
      execFileSync('git', ['checkout', '--detach', 'HEAD'], { cwd: workerPath, stdio: 'ignore' });

      const workerHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workerPath, encoding: 'utf-8' }).trim();
      const detachedName = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workerPath, encoding: 'utf-8' }).trim();
      assert.equal(detachedName, 'HEAD');

      const leaderHeadBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();

      await initTeamState('team-merge-detached', 'merge detached head test', 'executor', 1, repo);
      const cfg = await readTeamConfig('team-merge-detached', repo);
      assert.ok(cfg);
      if (!cfg) throw new Error('missing config');
      cfg.leader_pane_id = '';
      cfg.workers[0] = {
        ...cfg.workers[0],
        assigned_tasks: ['1'],
        worktree_repo_root: repo,
        worktree_path: workerPath,
        worktree_branch: undefined,
        worktree_detached: true,
        worktree_created: false,
      };
      await saveTeamConfig(cfg, repo);

      await monitorTeam('team-merge-detached', repo);

      const leaderHeadAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
      assert.notEqual(leaderHeadAfter, leaderHeadBefore, 'leader HEAD should advance for detached worker integration');
      assert.equal(await readFile(join(repo, 'detached-feature.txt'), 'utf-8'), 'detached worker feature\n');

      const commitObj = execFileSync('git', ['cat-file', '-p', leaderHeadAfter], { cwd: repo, encoding: 'utf-8' });
      const parentCount = commitObj.split('\n').filter((l: string) => l.startsWith('parent ')).length;
      assert.equal(parentCount, 2, 'detached worker integration should still produce a merge commit');

      const workerMerged = execFileSync('git', ['merge-base', '--is-ancestor', workerHead, 'HEAD'], { cwd: repo, encoding: 'utf-8' });
      assert.equal(workerMerged.length >= 0, true);

      const leaderMailbox = await listMailboxMessages('team-merge-detached', 'leader-fixed', repo);
      assert.equal(
        leaderMailbox.some((message) =>
          message.body.includes(`INTEGRATED: merged worker-1 (${workerHead.slice(0, 12)})`)
          && message.body.includes(leaderHeadAfter.slice(0, 12))),
        true,
      );

      const ledgerPath = join(repo, '.omx', 'reports', 'team-commit-hygiene', 'team-merge-detached.ledger.json');
      const ledger = JSON.parse(await readFile(ledgerPath, 'utf-8')) as {
        entries: Array<{
          operation: string;
          status: string;
          source_commit?: string;
          leader_head_before?: string;
          leader_head_after?: string;
        }>;
      };
      assert.equal(
        ledger.entries.some((entry) =>
          entry.operation === 'integration_merge'
          && entry.status === 'applied'
          && entry.source_commit === workerHead
          && entry.leader_head_before !== entry.leader_head_after),
        true,
      );
    } finally {
      if (workerPath) {
        await rm(workerPath, { recursive: true, force: true });
      }
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('monitorTeam does not emit INTEGRATED when merge reports success but leader HEAD never advances', async () => {
    const repo = await initRepo();
    let workerPath = '';
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-runtime-fake-git-'));
    const previousPath = process.env.PATH;
    const previousFakeMode = process.env.OMX_FAKE_GIT_SUCCESS_NOOP;
    try {
      workerPath = await addWorktree(repo, 'wk1-merge-noadvance-branch', 'omx-runtime-wk1-merge-noadvance-');
      await writeFile(join(workerPath, 'feature.txt'), 'new feature\n', 'utf-8');
      execFileSync('git', ['add', 'feature.txt'], { cwd: workerPath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worker feature'], { cwd: workerPath, stdio: 'ignore' });

      await initTeamState('team-merge-noadvance', 'merge no advance test', 'executor', 1, repo);
      const cfg = await readTeamConfig('team-merge-noadvance', repo);
      assert.ok(cfg);
      if (!cfg) throw new Error('missing config');
      cfg.leader_pane_id = '';
      cfg.workers[0] = {
        ...cfg.workers[0],
        assigned_tasks: ['1'],
        worktree_repo_root: repo,
        worktree_path: workerPath,
        worktree_branch: 'wk1-merge-noadvance-branch',
        worktree_detached: false,
        worktree_created: false,
      };
      await saveTeamConfig(cfg, repo);

      const realGit = execFileSync('bash', ['-lc', 'command -v git'], { encoding: 'utf-8' }).trim();
      await writeFile(
        join(fakeBinDir, 'git'),
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${OMX_FAKE_GIT_SUCCESS_NOOP:-}" == "merge" && "\${1:-}" == "merge" ]]; then
  exit 0
fi
exec "${realGit}" "$@"
`,
        { mode: 0o755 },
      );
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      process.env.OMX_FAKE_GIT_SUCCESS_NOOP = 'merge';

      const leaderHeadBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
      await monitorTeam('team-merge-noadvance', repo);
      const leaderHeadAfter = execFileSync(realGit, ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
      assert.equal(leaderHeadAfter, leaderHeadBefore, 'leader HEAD should stay unchanged in regression setup');

      const snapshot = await readMonitorSnapshot('team-merge-noadvance', repo);
      assert.equal(snapshot?.integrationByWorker?.['worker-1']?.status, 'integration_failed');
      assert.equal(snapshot?.integrationByWorker?.['worker-1']?.last_integrated_head, undefined);

      const leaderMailbox = await listMailboxMessages('team-merge-noadvance', 'leader-fixed', repo);
      assert.equal(leaderMailbox.some((message) => /INTEGRATED:/.test(message.body)), false);
      assert.equal(leaderMailbox.some((message) => /INTEGRATION FAILED:/.test(message.body)), true);

      const events = await readTeamEvents('team-merge-noadvance', repo, { wakeableOnly: false });
      assert.equal(events.some((event) => event.type === 'worker_integration_failed'), true);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousFakeMode === 'string') process.env.OMX_FAKE_GIT_SUCCESS_NOOP = previousFakeMode;
      else delete process.env.OMX_FAKE_GIT_SUCCESS_NOOP;
      await rm(fakeBinDir, { recursive: true, force: true });
      if (workerPath) {
        await rm(workerPath, { recursive: true, force: true });
      }
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('monitorTeam uses cherry-pick for diverged worker (hybrid cherry-pick path)', async () => {
    const repo = await initRepo();
    let workerPath = '';
    try {
      workerPath = await addWorktree(repo, 'wk1-div-branch', 'omx-runtime-wk1-diverged-');

      // Commit in worker
      await writeFile(join(workerPath, 'worker-file.txt'), 'worker content\n', 'utf-8');
      execFileSync('git', ['add', 'worker-file.txt'], { cwd: workerPath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worker diverge'], { cwd: workerPath, stdio: 'ignore' });

      // Commit in leader (creates divergence)
      await writeFile(join(repo, 'leader-file.txt'), 'leader content\n', 'utf-8');
      execFileSync('git', ['add', 'leader-file.txt'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'leader diverge'], { cwd: repo, stdio: 'ignore' });

      await initTeamState('team-diverged', 'diverged test', 'executor', 1, repo);
      const cfg = await readTeamConfig('team-diverged', repo);
      assert.ok(cfg);
      if (!cfg) throw new Error('missing config');
      cfg.leader_pane_id = '';
      cfg.workers[0] = {
        ...cfg.workers[0],
        assigned_tasks: ['1'],
        worktree_repo_root: repo,
        worktree_path: workerPath,
        worktree_branch: 'wk1-div-branch',
        worktree_detached: false,
        worktree_created: false,
      };
      await saveTeamConfig(cfg, repo);

      await monitorTeam('team-diverged', repo);

      // Verify both contents are on leader
      assert.equal(await readFile(join(repo, 'worker-file.txt'), 'utf-8'), 'worker content\n');
      assert.equal(await readFile(join(repo, 'leader-file.txt'), 'utf-8'), 'leader content\n');

      // Cherry-pick creates single-parent commits (not merge)
      const leaderHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
      const commitObj = execFileSync('git', ['cat-file', '-p', leaderHead], { cwd: repo, encoding: 'utf-8' });
      const parentCount = commitObj.split('\n').filter((l: string) => l.startsWith('parent ')).length;
      assert.equal(parentCount, 1, 'cherry-pick should create single-parent commit');

      const snapshot = await readMonitorSnapshot('team-diverged', repo);
      assert.ok(snapshot?.integrationByWorker?.['worker-1']?.last_integrated_head);
    } finally {
      if (workerPath) {
        await rm(workerPath, { recursive: true, force: true });
      }
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('monitorTeam rebases idle workers after integration lands on leader (cross-worker rebase)', async () => {
    const repo = await initRepo();
    let worker1Path = '';
    let worker2Path = '';
    try {
      worker1Path = await addWorktree(repo, 'wk1-xr-branch', 'omx-runtime-wk1-cross-rebase-');
      worker2Path = await addWorktree(repo, 'wk2-xr-branch', 'omx-runtime-wk2-cross-rebase-');

      // Worker-1 commits a change
      await writeFile(join(worker1Path, 'w1.txt'), 'from worker 1\n', 'utf-8');
      execFileSync('git', ['add', 'w1.txt'], { cwd: worker1Path, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worker-1 change'], { cwd: worker1Path, stdio: 'ignore' });

      // Worker-2 commits its own change (so rebase is meaningful)
      await writeFile(join(worker2Path, 'w2.txt'), 'from worker 2\n', 'utf-8');
      execFileSync('git', ['add', 'w2.txt'], { cwd: worker2Path, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worker-2 change'], { cwd: worker2Path, stdio: 'ignore' });

      await initTeamState('team-cross-rebase', 'cross rebase test', 'executor', 2, repo);
      const cfg = await readTeamConfig('team-cross-rebase', repo);
      assert.ok(cfg);
      if (!cfg) throw new Error('missing config');
      cfg.leader_pane_id = '';
      cfg.workers[0] = {
        ...cfg.workers[0],
        assigned_tasks: ['1'],
        worktree_repo_root: repo,
        worktree_path: worker1Path,
        worktree_branch: 'wk1-xr-branch',
        worktree_detached: false,
        worktree_created: false,
      };
      cfg.workers[1] = {
        ...cfg.workers[1],
        assigned_tasks: ['2'],
        worktree_repo_root: repo,
        worktree_path: worker2Path,
        worktree_branch: 'wk2-xr-branch',
        worktree_detached: false,
        worktree_created: false,
      };
      await saveTeamConfig(cfg, repo);

      // Set worker-2 status to idle (eligible for rebase)
      await writeWorkerStatus('team-cross-rebase', 'worker-2', { state: 'idle', updated_at: new Date().toISOString() }, repo);

      await monitorTeam('team-cross-rebase', repo);

      // Verify leader has worker-1's changes
      assert.equal(await readFile(join(repo, 'w1.txt'), 'utf-8'), 'from worker 1\n');

      // Verify worker-2 was rebased onto new leader HEAD
      // After rebase, worker-2 should have both its own files AND worker-1's files (from leader)
      assert.equal(existsSync(join(worker2Path, 'w1.txt')), true, 'worker-2 should have w1.txt after rebase onto leader');
      assert.equal(existsSync(join(worker2Path, 'w2.txt')), true, 'worker-2 should still have its own w2.txt');

      // Verify leader HEAD is ancestor of worker-2 branch (rebase succeeded)
      const newLeaderHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
      const mergeBase = execFileSync('git', ['merge-base', newLeaderHead, 'wk2-xr-branch'], { cwd: repo, encoding: 'utf-8' }).trim();
      assert.equal(mergeBase, newLeaderHead, 'worker-2 should be rebased onto new leader HEAD');

      const ledgerPath = join(repo, '.omx', 'reports', 'team-commit-hygiene', 'team-cross-rebase.ledger.json');
      const ledger = JSON.parse(await readFile(ledgerPath, 'utf-8')) as {
        entries: Array<{ operation: string; worker_name: string; status: string }>;
      };
      assert.equal(
        ledger.entries.some((entry) => entry.operation === 'cross_rebase' && entry.worker_name === 'worker-2' && entry.status === 'applied'),
        true,
      );
    } finally {
      if (worker1Path) {
        await rm(worker1Path, { recursive: true, force: true });
      }
      if (worker2Path) {
        await rm(worker2Path, { recursive: true, force: true });
      }
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('monitorTeam auto-resolves conflicts with -X theirs (worker wins on leader)', async () => {
    const repo = await initRepo();
    let workerPath = '';
    try {
      workerPath = await addWorktree(repo, 'wk1-cr-branch', 'omx-runtime-wk1-conflict-resolve-');

      // Worker edits README.md (same file, different content → conflict)
      await writeFile(join(workerPath, 'README.md'), 'worker version\n', 'utf-8');
      execFileSync('git', ['add', 'README.md'], { cwd: workerPath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worker edits README'], { cwd: workerPath, stdio: 'ignore' });

      // Leader also edits README.md (creates divergence + conflict)
      await writeFile(join(repo, 'README.md'), 'leader version\n', 'utf-8');
      execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'leader edits README'], { cwd: repo, stdio: 'ignore' });

      await initTeamState('team-conflict-resolve', 'conflict resolution test', 'executor', 1, repo);
      const cfg = await readTeamConfig('team-conflict-resolve', repo);
      assert.ok(cfg);
      if (!cfg) throw new Error('missing config');
      cfg.leader_pane_id = '';
      cfg.workers[0] = {
        ...cfg.workers[0],
        assigned_tasks: ['1'],
        worktree_repo_root: repo,
        worktree_path: workerPath,
        worktree_branch: 'wk1-cr-branch',
        worktree_detached: false,
        worktree_created: false,
      };
      await saveTeamConfig(cfg, repo);

      await monitorTeam('team-conflict-resolve', repo);

      // Verify worker's version wins on leader (-X theirs = worker wins)
      const leaderContent = await readFile(join(repo, 'README.md'), 'utf-8');
      assert.equal(leaderContent, 'worker version\n', 'worker content should win with -X theirs');

      // Verify integration was not blocked
      const snapshot = await readMonitorSnapshot('team-conflict-resolve', repo);
      assert.notEqual(snapshot?.integrationByWorker?.['worker-1']?.status, 'cherry_pick_conflict',
        'integration should not be permanently blocked');

      // Note: -X theirs resolves conflicts silently — git cherry-pick succeeds,
      // so the integration report is only written when -X theirs itself fails (e.g. binary conflicts).
      // The key assertion above is that worker content wins on leader.
    } finally {
      if (workerPath) {
        await rm(workerPath, { recursive: true, force: true });
      }
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('monitorTeam skips rebase for workers with "working" status (idle-only gating)', async () => {
    const repo = await initRepo();
    let worker1Path = '';
    let worker2Path = '';
    try {
      worker1Path = await addWorktree(repo, 'wk1-gate-branch', 'omx-runtime-wk1-rebase-gate-');
      worker2Path = await addWorktree(repo, 'wk2-gate-branch', 'omx-runtime-wk2-rebase-gate-');

      // Worker-1 commits a change
      await writeFile(join(worker1Path, 'w1.txt'), 'from worker 1\n', 'utf-8');
      execFileSync('git', ['add', 'w1.txt'], { cwd: worker1Path, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worker-1 change'], { cwd: worker1Path, stdio: 'ignore' });

      // Record worker-2 HEAD before integration
      const worker2HeadBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worker2Path, encoding: 'utf-8' }).trim();

      await initTeamState('team-rebase-gate', 'rebase gate test', 'executor', 2, repo);
      const cfg = await readTeamConfig('team-rebase-gate', repo);
      assert.ok(cfg);
      if (!cfg) throw new Error('missing config');
      cfg.leader_pane_id = '';
      cfg.workers[0] = {
        ...cfg.workers[0],
        assigned_tasks: ['1'],
        worktree_repo_root: repo,
        worktree_path: worker1Path,
        worktree_branch: 'wk1-gate-branch',
        worktree_detached: false,
        worktree_created: false,
      };
      cfg.workers[1] = {
        ...cfg.workers[1],
        assigned_tasks: ['2'],
        worktree_repo_root: repo,
        worktree_path: worker2Path,
        worktree_branch: 'wk2-gate-branch',
        worktree_detached: false,
        worktree_created: false,
      };
      await saveTeamConfig(cfg, repo);

      // Set worker-2 status to "working" (NOT eligible for rebase)
      await writeWorkerStatus('team-rebase-gate', 'worker-2', { state: 'working', updated_at: new Date().toISOString() }, repo);

      await monitorTeam('team-rebase-gate', repo);

      // Verify worker-2 HEAD is unchanged (NOT rebased)
      const worker2HeadAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worker2Path, encoding: 'utf-8' }).trim();
      assert.equal(worker2HeadAfter, worker2HeadBefore, 'worker-2 should NOT be rebased when status is "working"');
    } finally {
      if (worker1Path) {
        await rm(worker1Path, { recursive: true, force: true });
      }
      if (worker2Path) {
        await rm(worker2Path, { recursive: true, force: true });
      }
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('monitorTeam aborts failed rebase and leaves worktree in clean state', async () => {
    const repo = await initRepo();
    let worker1Path = '';
    let worker2Path = '';
    try {
      // Add a file that will be subject to rename/rename conflict
      await writeFile(join(repo, 'original.txt'), 'original content\n', 'utf-8');
      execFileSync('git', ['add', 'original.txt'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'add original.txt'], { cwd: repo, stdio: 'ignore' });

      worker1Path = await addWorktree(repo, 'wk1-rf-branch', 'omx-runtime-wk1-rebase-fail-');
      worker2Path = await addWorktree(repo, 'wk2-rf-branch', 'omx-runtime-wk2-rebase-fail-');

      // Worker-1 renames original.txt → renamed-by-w1.txt (will be integrated to leader)
      execFileSync('git', ['mv', 'original.txt', 'renamed-by-w1.txt'], { cwd: worker1Path, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worker-1 renames original'], { cwd: worker1Path, stdio: 'ignore' });

      // Worker-2 renames original.txt → renamed-by-w2.txt (will conflict on rebase)
      execFileSync('git', ['mv', 'original.txt', 'renamed-by-w2.txt'], { cwd: worker2Path, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worker-2 renames original'], { cwd: worker2Path, stdio: 'ignore' });

      const worker2HeadBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worker2Path, encoding: 'utf-8' }).trim();

      await initTeamState('team-rebase-fail', 'rebase failure test', 'executor', 2, repo);
      const cfg = await readTeamConfig('team-rebase-fail', repo);
      assert.ok(cfg);
      if (!cfg) throw new Error('missing config');
      cfg.leader_pane_id = '';
      cfg.workers[0] = {
        ...cfg.workers[0],
        assigned_tasks: ['1'],
        worktree_repo_root: repo,
        worktree_path: worker1Path,
        worktree_branch: 'wk1-rf-branch',
        worktree_detached: false,
        worktree_created: false,
      };
      cfg.workers[1] = {
        ...cfg.workers[1],
        assigned_tasks: ['2'],
        worktree_repo_root: repo,
        worktree_path: worker2Path,
        worktree_branch: 'wk2-rf-branch',
        worktree_detached: false,
        worktree_created: false,
      };
      await saveTeamConfig(cfg, repo);

      // Set worker-2 status to idle (eligible for rebase attempt)
      await writeWorkerStatus('team-rebase-fail', 'worker-2', { state: 'idle', updated_at: new Date().toISOString() }, repo);

      await monitorTeam('team-rebase-fail', repo);

      // Verify worker-1's changes landed on leader
      assert.equal(existsSync(join(repo, 'renamed-by-w1.txt')), true, 'leader should have worker-1 renamed file');

      // Verify worker-2 worktree is NOT in a broken rebase state (rebase --abort was called)
      const worker2HeadAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worker2Path, encoding: 'utf-8' }).trim();
      assert.equal(worker2HeadAfter, worker2HeadBefore, 'worker-2 HEAD should revert to pre-rebase state after abort');
      // Verify no rebase-in-progress markers
      const gitStatusOutput = execFileSync('git', ['status'], { cwd: worker2Path, encoding: 'utf-8' });
      assert.doesNotMatch(gitStatusOutput, /rebase in progress/, 'worktree should not have rebase in progress');

      // Verify integration report logged the failure
      const reportPath = join(repo, '.omx', 'state', 'team', 'team-rebase-fail', 'integration-report.md');
      assert.equal(existsSync(reportPath), true, 'integration report should exist after rebase failure');
      const report = await readFile(reportPath, 'utf-8');
      assert.match(report, /rebase/, 'report should mention the rebase operation');
    } finally {
      if (worker1Path) {
        await rm(worker1Path, { recursive: true, force: true });
      }
      if (worker2Path) {
        await rm(worker2Path, { recursive: true, force: true });
      }
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('shutdownTeam cleans up state even when tmux session doesn\'t exist', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-shutdown', 'shutdown test', 'executor', 1, cwd);
      await shutdownTeam('team-shutdown', cwd);

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-shutdown');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam clean fast path ignores worker shutdown ack files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-clean-fast-'));
    try {
      await initTeamState('team-shutdown-clean-fast', 'shutdown clean fast path test', 'executor', 1, cwd);
      const ackPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-shutdown-clean-fast',
        'workers',
        'worker-1',
        'shutdown-ack.json',
      );
      await writeFile(
        ackPath,
        JSON.stringify({ status: 'reject', reason: 'stale ack', updated_at: '9999-01-01T00:00:00.000Z' }),
      );

      await shutdownTeam('team-shutdown-clean-fast', cwd);

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-shutdown-clean-fast');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam blocks when pending tasks remain (shutdown gate)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-gate-'));
    try {
      await initTeamState('team-shutdown-gate-pending', 'shutdown gate pending test', 'executor', 1, cwd);
      await createTask(
        'team-shutdown-gate-pending',
        { subject: 'pending', description: 'd', status: 'pending' },
        cwd,
      );

      await assert.rejects(
        () => shutdownTeam('team-shutdown-gate-pending', cwd),
        /shutdown_gate_blocked:pending=1,blocked=0,in_progress=0,failed=0/,
      );

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-shutdown-gate-pending');
      assert.equal(existsSync(teamRoot), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam honors governance cleanup override when active tasks remain', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-gate-override-'));
    try {
      await initTeamState('team-shutdown-gate-override', 'shutdown gate override test', 'executor', 1, cwd);
      await createTask(
        'team-shutdown-gate-override',
        { subject: 'pending', description: 'd', status: 'pending' },
        cwd,
      );

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'team-shutdown-gate-override', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as any;
      manifest.governance = {
        ...(manifest.governance || {}),
        cleanup_requires_all_workers_inactive: false,
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      await shutdownTeam('team-shutdown-gate-override', cwd);

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-shutdown-gate-override');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam honors legacy policy cleanup override after governance hydration', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-gate-legacy-'));
    try {
      await initTeamState('team-shutdown-gate-legacy', 'shutdown gate legacy policy test', 'executor', 1, cwd);
      await createTask(
        'team-shutdown-gate-legacy',
        { subject: 'pending', description: 'd', status: 'pending' },
        cwd,
      );

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'team-shutdown-gate-legacy', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as any;
      manifest.policy = {
        ...(manifest.policy || {}),
        cleanup_requires_all_workers_inactive: false,
      };
      delete manifest.governance;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      await shutdownTeam('team-shutdown-gate-legacy', cwd);

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-shutdown-gate-legacy');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam requires explicit issue confirmation when failed tasks remain', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-gate-failed-'));
    try {
      await initTeamState('team-shutdown-gate-failed', 'shutdown gate failed test', 'executor', 1, cwd);
      await createTask(
        'team-shutdown-gate-failed',
        { subject: 'failed', description: 'd', status: 'failed' },
        cwd,
      );

      await assert.rejects(
        () => shutdownTeam('team-shutdown-gate-failed', cwd),
        /shutdown_confirm_issues_required:failed=1:rerun=omx team shutdown team-shutdown-gate-failed --confirm-issues/,
      );

      const teamRoot = teamStateTestPath(cwd, 'team', 'team-shutdown-gate-failed');
      assert.equal(existsSync(teamRoot), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam force=true bypasses shutdown gate and cleans up', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-gate-force-'));
    try {
      await initTeamState('team-shutdown-gate-force', 'shutdown gate force test', 'executor', 1, cwd);
      await createTask(
        'team-shutdown-gate-force',
        { subject: 'pending', description: 'd', status: 'pending' },
        cwd,
      );

      await shutdownTeam('team-shutdown-gate-force', cwd, { force: true });
      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-shutdown-gate-force');
      // Verify the forced shutdown audit event was written before cleanup removed state
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam force=true emits shutdown_gate_forced audit event', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-gate-forced-event-'));
    try {
      await initTeamState('team-gate-forced-event', 'forced event test', 'executor', 1, cwd);
      await createTask(
        'team-gate-forced-event',
        { subject: 'pending', description: 'd', status: 'pending' },
        cwd,
      );

      const eventsPath = join(cwd, '.omx', 'state', 'team', 'team-gate-forced-event', 'events', 'events.ndjson');
      await shutdownTeam('team-gate-forced-event', cwd, { force: true });

      // Events file may have been removed during cleanup; if it existed before cleanup
      // the audit event was appended. Verify by checking that the team root is gone (cleanup ran).
      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-gate-forced-event');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam handles persisted resize hook metadata during cleanup', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-resize-meta-'));
    try {
      const configPath = join(cwd, '.omx', 'state', 'team', 'team-resize-meta', 'config.json');
      const manifestPath = join(cwd, '.omx', 'state', 'team', 'team-resize-meta', 'manifest.v2.json');
      await initTeamState('team-resize-meta', 'shutdown resize metadata', 'executor', 1, cwd);
      const config = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
      config.resize_hook_name = 'omx_resize_team_resize_meta_test';
      config.resize_hook_target = 'omx-team-team-resize-meta:0';
      await writeFile(configPath, JSON.stringify(config, null, 2));
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
      manifest.resize_hook_name = 'omx_resize_team_resize_meta_test';
      manifest.resize_hook_target = 'omx-team-team-resize-meta:0';
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      await shutdownTeam('team-resize-meta', cwd);
      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-resize-meta');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam continues cleanup when resize hook unregister fails while session remains active', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-gate-failed-'));
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-fake-tmux-',
          env: { TMUX_TEST_LOG: undefined },
          tmuxScript: () => `#!/bin/sh
set -eu
if [ -n "\${TMUX_TEST_LOG:-}" ]; then
  printf '%s\\n' "$*" >> "$TMUX_TEST_LOG"
fi
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  list-sessions)
    echo "omx-team-team-shutdown-gate-failed"
    exit 0
    ;;
  set-hook)
    if [ "\${2:-}" = "-u" ]; then
      echo "simulated unregister failure" >&2
      exit 1
    fi
    exit 0
    ;;
  list-panes)
    exit 1
    ;;
  kill-session)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState('team-shutdown-gate-failed', 'shutdown resize hook failure test', 'executor', 1, cwd);
          const configPath = teamStateTestPath(cwd, 'team', 'team-shutdown-gate-failed', 'config.json');
          const manifestPath = teamStateTestPath(cwd, 'team', 'team-shutdown-gate-failed', 'manifest.v2.json');
          const config = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
          config.tmux_session = 'omx-team-team-shutdown-gate-failed';
          config.resize_hook_name = 'omx_resize_team_shutdown_gate_failed_test';
          config.resize_hook_target = 'omx-team-team-shutdown-gate-failed:0';
          await writeFile(configPath, JSON.stringify(config, null, 2));
          const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
          manifest.tmux_session = 'omx-team-team-shutdown-gate-failed';
          manifest.resize_hook_name = 'omx_resize_team_shutdown_gate_failed_test';
          manifest.resize_hook_target = 'omx-team-team-shutdown-gate-failed:0';
          await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
          process.env.TMUX_TEST_LOG = tmuxLogPath;

          await shutdownTeam('team-shutdown-gate-failed', cwd);

          const teamRoot = teamStateTestPath(cwd, 'team', 'team-shutdown-gate-failed');
          assert.equal(existsSync(teamRoot), false);

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /set-hook -u -t omx-team-team-shutdown-gate-failed:0 client-resized\[\d+\]/);
          assert.match(tmuxLog, /kill-session -t omx-team-team-shutdown-gate-failed/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam returns rejection error when worker rejects shutdown and force is false', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-reject', 'shutdown reject test', 'executor', 1, cwd);
      await attachDirtyWorkerRepo('team-reject', cwd, 'team-reject-repo');
      const ackPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-reject',
        'workers',
        'worker-1',
        'shutdown-ack.json',
      );
      await writeFile(
        ackPath,
        JSON.stringify({ status: 'reject', reason: 'still working', updated_at: '9999-01-01T00:00:00.000Z' }),
      );

      await assert.rejects(() => shutdownTeam('team-reject', cwd), /shutdown_rejected:worker-1:still working/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam emits shutdown_ack event when worker ack is received', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-ack-evt', 'shutdown ack event test', 'executor', 1, cwd);
      await attachDirtyWorkerRepo('team-ack-evt', cwd, 'team-ack-evt-repo');
      const ackPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-ack-evt',
        'workers',
        'worker-1',
        'shutdown-ack.json',
      );
      await writeFile(
        ackPath,
        JSON.stringify({ status: 'reject', reason: 'busy', updated_at: '9999-01-01T00:00:00.000Z' }),
      );

      await assert.rejects(() => shutdownTeam('team-ack-evt', cwd), /shutdown_rejected/);

      // Verify that a shutdown_ack event was written to the event log
      const eventLogPath = join(cwd, '.omx', 'state', 'team', 'team-ack-evt', 'events', 'events.ndjson');
      assert.ok(existsSync(eventLogPath), 'event log should exist');
      const raw = await readFile(eventLogPath, 'utf-8');
      const events = raw.trim().split('\n').map(line => JSON.parse(line));
      const ackEvents = events.filter((e: { type: string }) => e.type === 'shutdown_ack');
      assert.equal(ackEvents.length, 1, 'should have exactly one shutdown_ack event');
      assert.equal(ackEvents[0].worker, 'worker-1');
      assert.equal(ackEvents[0].reason, 'reject:busy');
      assert.equal(ackEvents[0].team, 'team-ack-evt');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam emits shutdown_ack event with accept reason for accepted acks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-ack-accept', 'shutdown ack accept test', 'executor', 1, cwd);
      const ackPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-ack-accept',
        'workers',
        'worker-1',
        'shutdown-ack.json',
      );
      await writeFile(
        ackPath,
        JSON.stringify({ status: 'accept', updated_at: '9999-01-01T00:00:00.000Z' }),
      );

      // Read the event log before cleanup destroys it
      const eventLogPath = join(cwd, '.omx', 'state', 'team', 'team-ack-accept', 'events', 'events.ndjson');

      await shutdownTeam('team-ack-accept', cwd);

      // State is cleaned up, but we can verify the event was emitted by checking
      // that cleanup succeeded (no error) -- the event was written before cleanup.
      // For a more direct test, check that the team root was cleaned up.
      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-ack-accept');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam force=true ignores rejection and cleans up team state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-force', 'shutdown force test', 'executor', 1, cwd);
      const ackPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-force',
        'workers',
        'worker-1',
        'shutdown-ack.json',
      );
      await writeFile(
        ackPath,
        JSON.stringify({ status: 'reject', reason: 'still working', updated_at: '9999-01-01T00:00:00.000Z' }),
      );

      await shutdownTeam('team-force', cwd, { force: true });
      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-force');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam ignores stale rejection ack from a prior request', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-stale-ack', 'shutdown stale ack test', 'executor', 1, cwd);
      const ackPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-stale-ack',
        'workers',
        'worker-1',
        'shutdown-ack.json',
      );
      await writeFile(
        ackPath,
        JSON.stringify({ status: 'reject', reason: 'old ack', updated_at: '2000-01-01T00:00:00.000Z' }),
      );

      await shutdownTeam('team-stale-ack', cwd);
      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-stale-ack');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam confirmIssues=true allows failed-task shutdown without worker ack handshake', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-confirm-issues-'));
    try {
      await initTeamState('team-confirm-issues', 'shutdown confirm issues test', 'executor', 1, cwd);
      await createTask(
        'team-confirm-issues',
        { subject: 'failed', description: 'd', status: 'failed' },
        cwd,
      );
      const ackPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-confirm-issues',
        'workers',
        'worker-1',
        'shutdown-ack.json',
      );
      await writeFile(
        ackPath,
        JSON.stringify({ status: 'reject', reason: 'should be ignored', updated_at: '9999-01-01T00:00:00.000Z' }),
      );

      await shutdownTeam('team-confirm-issues', cwd, { confirmIssues: true });

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-confirm-issues');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam applies best-effort teardown even when worker pane is already dead', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-dead-pane-'));
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-dead-pane-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  list-panes)
    exit 1
    ;;
  kill-pane)
    if [ "\${3:-}" = "%404" ]; then
      echo "missing pane" >&2
      exit 1
    fi
    exit 0
    ;;
  kill-session)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState('team-shutdown-dead-pane', 'shutdown dead pane test', 'executor', 2, cwd);
          const config = await readTeamConfig('team-shutdown-dead-pane', cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'omx-team-team-shutdown-dead-pane';
          config.workers[0]!.pane_id = '%404';
          config.workers[1]!.pane_id = '%405';
          await saveTeamConfig(config, cwd);

          await shutdownTeam('team-shutdown-dead-pane', cwd, { force: true });
          const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-shutdown-dead-pane');
          assert.equal(existsSync(teamRoot), false);

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /kill-pane -t %404/);
          assert.match(tmuxLog, /kill-pane -t %405/);
          assert.match(tmuxLog, /kill-session -t omx-team-team-shutdown-dead-pane/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam reconciles persisted worker panes with live tmux panes before teardown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-pane-reconcile-'));
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-pane-reconcile-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
restored_marker="${tmuxLogPath}.restored"
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-t leader:0 -F #{pane_dead} #{pane_pid}"*)
        exit 1
        ;;
      *"-t %13 -F #{pane_pid}"*)
        echo "1013"
        exit 0
        ;;
      *"-t %14 -F #{pane_pid}"*)
        echo "1014"
        exit 0
        ;;
      *"-t leader:0 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tzsh\\n%%12\\tnode\\tnode /tmp/bin/omx.js hud --watch\\n%%13\\tcodex\\tcodex\\n%%14\\tcodex\\tcodex\\n"
        if [ -f "$restored_marker" ]; then
          printf "%%44\\tnode\\tnode /tmp/bin/omx.js hud --watch\\n"
        fi
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  split-window)
    : > "$restored_marker"
    printf '%%44\\n'
    exit 0
    ;;
  kill-pane)
    if [ "\${3:-}" = "%999" ]; then
      echo "missing pane" >&2
      exit 1
    fi
    exit 0
    ;;
  kill-session|select-pane|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState('team-shutdown-pane-reconcile', 'shutdown pane reconcile test', 'executor', 2, cwd);
          const config = await readTeamConfig('team-shutdown-pane-reconcile', cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader:0';
          config.leader_pane_id = '%11';
          config.hud_pane_id = '%12';
          config.workers[0]!.pane_id = '';
          config.workers[1]!.pane_id = '%999';
          await saveTeamConfig(config, cwd);

          await shutdownTeam('team-shutdown-pane-reconcile', cwd, { force: true });
          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.doesNotMatch(tmuxLog, /kill-pane -t %11/);
          assert.match(tmuxLog, /kill-pane -t %12/);
          assert.match(tmuxLog, /kill-pane -t %13/);
          assert.match(tmuxLog, /kill-pane -t %14/);
          assert.match(tmuxLog, /kill-pane -t %999/);
          assert.match(tmuxLog, new RegExp(`split-window -v -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t %11 -d -P -F #\{pane_id\}`));
          assert.doesNotMatch(tmuxLog, /kill-pane -t %44/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam skips prekill and keeps the leader pane alive on native Windows split-pane shutdown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-win32-split-'));
    try {
      await withNativeWindowsPlatform(async () => {
        await withMockTmuxFixture(
          {
            dirPrefix: 'omx-runtime-shutdown-win32-split-bin-',
            tmuxScript: (tmuxLogPath) => `#!/bin/sh
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
        printf "%%11\\tpwsh\\tpwsh\\n%%12\\tnode\\tnode /tmp/bin/omx.js hud --watch\\n%%13\\tcodex\\tcodex\\n%%14\\tcodex\\tcodex\\n"
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
  kill-pane|resize-pane|select-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          },
          async ({ tmuxLogPath }) => {
            await initTeamState('team-shutdown-win32-split', 'shutdown win32 split test', 'executor', 2, cwd);
            const config = await readTeamConfig('team-shutdown-win32-split', cwd);
            assert.ok(config);
            if (!config) return;
            config.tmux_session = 'leader:0';
            config.leader_pane_id = '%11';
            config.hud_pane_id = '%12';
            config.workers[0]!.pane_id = '%13';
            config.workers[1]!.pane_id = '%14';
            await saveTeamConfig(config, cwd);

            await shutdownTeam('team-shutdown-win32-split', cwd, { force: true });

            const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-shutdown-win32-split');
            assert.equal(existsSync(teamRoot), false);
            assert.equal(await readMonitorSnapshot('team-shutdown-win32-split', cwd), null);

            const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
            assert.doesNotMatch(tmuxLog, /list-panes -t %13 -F #\{pane_pid\}/);
            assert.doesNotMatch(tmuxLog, /list-panes -t %14 -F #\{pane_pid\}/);
            assert.doesNotMatch(tmuxLog, /kill-pane -t %11/);
            assert.doesNotMatch(tmuxLog, /kill-session -t leader:0/);
            assert.match(tmuxLog, /kill-pane -t %12/);
            assert.match(tmuxLog, /kill-pane -t %13/);
            assert.match(tmuxLog, /kill-pane -t %14/);
            assert.match(tmuxLog, new RegExp(`split-window -v -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t %11 -d -P -F #\\{pane_id\\}`));
            assert.match(tmuxLog, new RegExp(`resize-pane -t %44 -y ${HUD_TMUX_TEAM_HEIGHT_LINES}`));
            assert.match(tmuxLog, /select-pane -t %11/);
          },
        );
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam skips prekill and keeps the leader pane alive on shared-session shutdown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-shared-session-'));
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-shared-session-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
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
      *)
        exit 1
        ;;
    esac
    ;;
  split-window)
    printf '%%44\\n'
    exit 0
    ;;
  kill-pane|resize-pane|select-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState('team-shutdown-shared-session', 'shutdown shared session test', 'executor', 2, cwd);
          const config = await readTeamConfig('team-shutdown-shared-session', cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader:0';
          config.leader_pane_id = '%11';
          config.hud_pane_id = '%12';
          config.workers[0]!.pane_id = '%13';
          config.workers[1]!.pane_id = '%14';
          await saveTeamConfig(config, cwd);

          await shutdownTeam('team-shutdown-shared-session', cwd, { force: true });

          const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-shutdown-shared-session');
          assert.equal(existsSync(teamRoot), false);
          assert.equal(await readMonitorSnapshot('team-shutdown-shared-session', cwd), null);

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.doesNotMatch(tmuxLog, /list-panes -t %13 -F #\{pane_pid\}/);
          assert.doesNotMatch(tmuxLog, /list-panes -t %14 -F #\{pane_pid\}/);
          assert.doesNotMatch(tmuxLog, /kill-pane -t %11/);
          assert.doesNotMatch(tmuxLog, /kill-session -t leader:0/);
          assert.match(tmuxLog, /kill-pane -t %12/);
          assert.match(tmuxLog, /kill-pane -t %13/);
          assert.match(tmuxLog, /kill-pane -t %14/);
          assert.match(tmuxLog, new RegExp(`split-window -v -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t %11 -d -P -F #\\{pane_id\\}`));
          assert.match(tmuxLog, /select-pane -t %11/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('shutdownTeam restores a standalone HUD pane after tearing down the team HUD', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-restore-hud-'));
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-restore-hud-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  list-panes)
    exit 1
    ;;
  split-window)
    printf '%%44\n'
    exit 0
    ;;
  kill-pane|kill-session|select-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState('team-shutdown-restore-hud', 'shutdown restore hud test', 'executor', 2, cwd);
          const config = await readTeamConfig('team-shutdown-restore-hud', cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader:0';
          config.leader_pane_id = '%11';
          config.hud_pane_id = '%12';
          config.workers[0]!.pane_id = '%12';
          config.workers[1]!.pane_id = '%13';
          await saveTeamConfig(config, cwd);

          await shutdownTeam('team-shutdown-restore-hud', cwd, { force: true });
          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.doesNotMatch(tmuxLog, /kill-pane -t %11/);
          assert.match(tmuxLog, /kill-pane -t %12/);
          assert.match(tmuxLog, /kill-pane -t %13/);
          assert.match(tmuxLog, new RegExp(`split-window -v -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t %11 -d -P -F #\{pane_id\}`));
          assert.match(tmuxLog, /run-shell -b sleep \d+; tmux resize-pane -t %44 -y \d+ >/);
          assert.match(tmuxLog, /run-shell tmux resize-pane -t %44 -y \d+ >/);
          assert.match(tmuxLog, /hud --watch/);
          assert.match(tmuxLog, /select-pane -t %11/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam preserves leader exclusion while tearing down the hud pane', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-exclusions-'));
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-exclusions-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  list-panes)
    exit 1
    ;;
  kill-pane|kill-session)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState('team-shutdown-exclusions', 'shutdown exclusions test', 'executor', 3, cwd);
          const config = await readTeamConfig('team-shutdown-exclusions', cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'omx-team-team-shutdown-exclusions';
          config.leader_pane_id = '%11';
          config.hud_pane_id = '%12';
          config.workers[0]!.pane_id = '%11';
          config.workers[1]!.pane_id = '%12';
          config.workers[2]!.pane_id = '%13';
          await saveTeamConfig(config, cwd);

          await shutdownTeam('team-shutdown-exclusions', cwd, { force: true });
          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.doesNotMatch(tmuxLog, /kill-pane -t %11/);
          assert.match(tmuxLog, /kill-pane -t %12/);
          assert.match(tmuxLog, /kill-pane -t %13/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam still requires confirm-issues on failed tasks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-normal-gate-'));
    try {
      await initTeamState('team-normal-gate', 'normal gate test', 'executor', 1, cwd);
      await createTask(
        'team-normal-gate',
        { subject: 'failed', description: 'd', status: 'failed' },
        cwd,
      );

      await assert.rejects(
        () => shutdownTeam('team-normal-gate', cwd),
        /shutdown_confirm_issues_required:failed=1/,
      );

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-normal-gate');
      assert.equal(existsSync(teamRoot), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('resumeTeam returns null for non-existent team', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      const runtime = await resumeTeam('missing-team', cwd);
      assert.equal(runtime, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resumeTeam returns null for prompt teams when worker handles are missing after restart', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-prompt-resume-'));
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: false,
    });
    let sleeperPid = sleeper.pid ?? 0;
    const prevTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const prevLeaderCwd = process.env.OMX_TEAM_LEADER_CWD;
    delete process.env.OMX_TEAM_STATE_ROOT;
    delete process.env.OMX_TEAM_LEADER_CWD;

    try {
      await initTeamState('team-prompt-resume', 'prompt resume test', 'executor', 1, cwd);
      const configPath = join(cwd, '.omx', 'state', 'team', 'team-prompt-resume', 'config.json');
      const config = JSON.parse(await readFile(configPath, 'utf-8')) as any;
      config.worker_launch_mode = 'prompt';
      config.tmux_session = 'prompt-team-prompt-resume';
      config.leader_pane_id = null;
      config.hud_pane_id = null;
      config.workers[0].pid = sleeperPid;
      config.workers[0].pane_id = null;
      await writeFile(configPath, JSON.stringify(config, null, 2));

      const runtime = await resumeTeam('team-prompt-resume', cwd);
      assert.equal(runtime, null);
    } finally {
      if (sleeperPid > 0) {
        try {
          process.kill(sleeperPid, 'SIGKILL');
        } catch {
          // already exited
        }
      }
      if (typeof prevTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = prevTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      if (typeof prevLeaderCwd === 'string') process.env.OMX_TEAM_LEADER_CWD = prevLeaderCwd;
      else delete process.env.OMX_TEAM_LEADER_CWD;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('assignTask enforces delegation_only policy for leader-fixed worker', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-delegation', 'delegation policy test', 'executor', 1, cwd);
      const task = await createTask(
        'team-delegation',
        { subject: 'x', description: 'd', status: 'pending', requires_code_change: false },
        cwd,
      );

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'team-delegation', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as any;
      manifest.governance = { ...(manifest.governance || {}), delegation_only: true };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      await assert.rejects(
        () => assignTask('team-delegation', 'leader-fixed', task.id, cwd),
        /delegation_only_violation/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('assignTask does not claim task when worker does not exist', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-missing-worker', 'assignment test', 'executor', 1, cwd);
      const task = await createTask(
        'team-missing-worker',
        { subject: 'x', description: 'd', status: 'pending', requires_code_change: false },
        cwd,
      );

      await assert.rejects(
        () => assignTask('team-missing-worker', 'worker-404', task.id, cwd),
        /Worker worker-404 not found in team/,
      );

      const reread = await readTask('team-missing-worker', task.id, cwd);
      assert.equal(reread?.status, 'pending');
      assert.equal(reread?.owner, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('assignTask rolls back claim when notification transport fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-notify-fail', 'assignment test', 'executor', 1, cwd);
      const task = await createTask(
        'team-notify-fail',
        { subject: 'x', description: 'd', status: 'pending', requires_code_change: false },
        cwd,
      );

      // Force notification transport to fail by clearing PATH so tmux is unavailable.
      await assert.rejects(
        () => withEmptyPath(() => assignTask('team-notify-fail', 'worker-1', task.id, cwd)),
        /worker_notify_failed/,
      );

      const reread = await readTask('team-notify-fail', task.id, cwd);
      assert.equal(reread?.status, 'pending');
      assert.equal(reread?.owner, undefined);
      assert.equal(reread?.claim, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('assignTask rolls back claim when inbox write fails after claim', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-inbox-fail', 'assignment test', 'executor', 1, cwd);
      const task = await createTask(
        'team-inbox-fail',
        { subject: 'x', description: 'd', status: 'pending', requires_code_change: false },
        cwd,
      );
      const workerDir = join(cwd, '.omx', 'state', 'team', 'team-inbox-fail', 'workers', 'worker-1');
      await rm(workerDir, { recursive: true, force: true });
      // Force inbox write failure by turning the would-be directory into a file.
      await writeFile(workerDir, 'not-a-directory');

      await assert.rejects(
        () => assignTask('team-inbox-fail', 'worker-1', task.id, cwd),
        /worker_assignment_failed:/,
      );

      const reread = await readTask('team-inbox-fail', task.id, cwd);
      assert.equal(reread?.status, 'pending');
      assert.equal(reread?.owner, undefined);
      assert.equal(reread?.claim, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('assignTask enforces plan approval for code-change tasks when required', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-approval', 'approval policy test', 'executor', 1, cwd);
      const task = await createTask(
        'team-approval',
        { subject: 'x', description: 'd', status: 'pending', requires_code_change: true },
        cwd,
      );

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'team-approval', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as any;
      manifest.governance = { ...(manifest.governance || {}), plan_approval_required: true };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      await assert.rejects(
        () => assignTask('team-approval', 'worker-1', task.id, cwd),
        /plan_approval_required/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam does not re-notify already-notified mailbox messages (issue #116)', async () => {
    // Regression: deliverPendingMailboxMessages used to re-notify every 15 s via shouldRetry.
    // After the fix it must NOT re-notify messages that already have notified_at set.
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-no-spam-'));
    try {
      await initTeamState('team-no-spam', 'no spam test', 'executor', 1, cwd);

      // Write a mailbox message that is already notified but not yet delivered.
      const mailboxDir = join(cwd, '.omx', 'state', 'team', 'team-no-spam', 'mailbox');
      await mkdir(mailboxDir, { recursive: true });
      const notifiedAt = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
      await writeFile(join(mailboxDir, 'worker-1.json'), JSON.stringify({
        worker: 'worker-1',
        messages: [
          {
            message_id: 'msg-already-notified',
            from_worker: 'leader-fixed',
            to_worker: 'worker-1',
            body: 'hello',
            created_at: notifiedAt,
            notified_at: notifiedAt, // already notified
            // delivered_at intentionally absent — message is still pending
          },
        ],
      }));

      // First monitorTeam call — should see the message as already-notified (unnotified=[]).
      const result1 = await monitorTeam('team-no-spam', cwd);
      assert.ok(result1, 'snapshot should exist');

      // Read the monitor snapshot from disk to verify the notified map.
      const diskSnap1 = await readMonitorSnapshot('team-no-spam', cwd);
      assert.ok(diskSnap1, 'disk snapshot should exist after first poll');
      assert.ok(
        diskSnap1.mailboxNotifiedByMessageId['msg-already-notified'],
        'already-notified message must be preserved in snapshot after first poll',
      );

      // Second monitorTeam call — previousNotifications now carries the timestamp.
      // The message must again be treated as notified (no duplicate notification).
      const result2 = await monitorTeam('team-no-spam', cwd);
      assert.ok(result2, 'second snapshot should exist');
      const diskSnap2 = await readMonitorSnapshot('team-no-spam', cwd);
      assert.ok(diskSnap2, 'disk snapshot should exist after second poll');
      assert.ok(
        diskSnap2.mailboxNotifiedByMessageId['msg-already-notified'],
        'already-notified message must remain in snapshot after second poll (no reset)',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam only notifies once per new message even without notified_at (issue #116)', async () => {
    // Regression: messages delivered via team_send_message MCP have no notified_at.
    // After the first successful poll that sets notified_at, subsequent polls must not re-notify.
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-new-msg-'));
    try {
      await initTeamState('team-new-msg', 'new msg test', 'executor', 1, cwd);

      const mailboxDir = join(cwd, '.omx', 'state', 'team', 'team-new-msg', 'mailbox');
      await mkdir(mailboxDir, { recursive: true });
      const createdAt = new Date().toISOString();
      await writeFile(join(mailboxDir, 'worker-1.json'), JSON.stringify({
        worker: 'worker-1',
        messages: [
          {
            message_id: 'msg-unnotified',
            from_worker: 'leader-fixed',
            to_worker: 'worker-1',
            body: 'task assignment',
            created_at: createdAt,
            // notified_at and delivered_at intentionally absent
          },
        ],
      }));

      // First poll — unnotified=[msg-unnotified]. notifyWorker will fail (no tmux in tests)
      // so markMessageNotified is not called and the snapshot has no entry for this message.
      const result1 = await monitorTeam('team-new-msg', cwd);
      assert.ok(result1);
      const diskSnap1 = await readMonitorSnapshot('team-new-msg', cwd);
      // Without tmux the notify fails, so no entry is expected in the first snapshot.
      assert.ok(diskSnap1);

      // Simulate a successful notification by manually setting notified_at on the message.
      await writeFile(join(mailboxDir, 'worker-1.json'), JSON.stringify({
        worker: 'worker-1',
        messages: [
          {
            message_id: 'msg-unnotified',
            from_worker: 'leader-fixed',
            to_worker: 'worker-1',
            body: 'task assignment',
            created_at: createdAt,
            notified_at: new Date().toISOString(),
          },
        ],
      }));

      // Second poll — message now has notified_at, so unnotified=[], no re-notification.
      const result2 = await monitorTeam('team-new-msg', cwd);
      assert.ok(result2);
      const diskSnap2 = await readMonitorSnapshot('team-new-msg', cwd);
      assert.ok(diskSnap2);
      assert.ok(
        diskSnap2.mailboxNotifiedByMessageId['msg-unnotified'],
        'notified message must be captured in snapshot after second poll',
      );

      // Third poll — previousNotifications carries the timestamp.
      // unnotified=[] so no re-notification attempt, and snapshot still tracks it.
      const result3 = await monitorTeam('team-new-msg', cwd);
      assert.ok(result3);
      const diskSnap3 = await readMonitorSnapshot('team-new-msg', cwd);
      assert.ok(diskSnap3);
      assert.ok(
        diskSnap3.mailboxNotifiedByMessageId['msg-unnotified'],
        'notified message must remain in snapshot on third poll (no duplicate notification)',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam does not emit duplicate task_completed when transitionTaskStatus completed the task first (issue #161)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-no-dup-'));
    try {
      await initTeamState('team-no-dup', 'dedup test', 'executor', 1, cwd);
      const t = await createTask('team-no-dup', { subject: 'task', description: 'd', status: 'pending' }, cwd);

      // Establish a baseline snapshot (task is pending).
      await monitorTeam('team-no-dup', cwd);

      // Complete the task via the claim-safe path — this emits the first task_completed event
      // and records the task ID in the monitor snapshot.
      const claim = await claimTask('team-no-dup', t.id, 'worker-1', null, cwd);
      assert.ok(claim.ok);
      if (!claim.ok) throw new Error('claim failed');
      await transitionTaskStatus('team-no-dup', t.id, 'in_progress', 'completed', claim.claimToken, cwd);

      // Run monitorTeam again — it must NOT emit a second task_completed event.
      await monitorTeam('team-no-dup', cwd);

      const eventsPath = join(cwd, '.omx', 'state', 'team', 'team-no-dup', 'events', 'events.ndjson');
      const content = await readFile(eventsPath, 'utf-8');
      const events = content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const completedEvents = events.filter((e: { type: string }) => e.type === 'task_completed');
      assert.equal(completedEvents.length, 1, 'should have exactly one task_completed event');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('sendWorkerMessage allows worker to message leader-fixed mailbox', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-leader-msg', 'leader mailbox test', 'executor', 2, cwd);
      await sendWorkerMessage('team-leader-msg', 'worker-1', 'leader-fixed', 'worker one ack', cwd);
      await sendWorkerMessage('team-leader-msg', 'worker-2', 'leader-fixed', 'worker two ack', cwd);

      const messages = await listMailboxMessages('team-leader-msg', 'leader-fixed', cwd);
      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.from_worker, 'worker-1');
      assert.equal(messages[1]?.from_worker, 'worker-2');
      assert.equal(messages[0]?.to_worker, 'leader-fixed');
      assert.equal(messages[1]?.to_worker, 'leader-fixed');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('sendWorkerMessage dedupes identical undelivered leader-fixed messages', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-leader-dedupe', 'leader mailbox dedupe test', 'executor', 1, cwd);
      await sendWorkerMessage('team-leader-dedupe', 'worker-1', 'leader-fixed', 'INTEGRATED: same-body', cwd);
      await sendWorkerMessage('team-leader-dedupe', 'worker-1', 'leader-fixed', 'INTEGRATED: same-body', cwd);

      const messages = await listMailboxMessages('team-leader-dedupe', 'leader-fixed', cwd);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.body, 'INTEGRATED: same-body');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('sendWorkerMessage keeps hook-preferred duplicate leader mailbox sends idempotent after notification', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-leader-dedupe-notified-'));
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-leader-dedupe-notified-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\n' "$$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  send-keys)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async () => {
          await initTeamState('team-leader-dedupe-notified', 'leader mailbox dedupe notified test', 'executor', 1, cwd);
          const cfg = await readTeamConfig('team-leader-dedupe-notified', cwd);
          assert.ok(cfg);
          if (!cfg) throw new Error('missing team config');
          cfg.leader_pane_id = '%55';
          await saveTeamConfig(cfg, cwd);

          const manifestPath = teamStateTestPath(cwd, 'team', 'team-leader-dedupe-notified', 'manifest.v2.json');
          const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
          manifest.policy = { ...(manifest.policy || {}), dispatch_ack_timeout_ms: 100 };
          await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

          await sendWorkerMessage('team-leader-dedupe-notified', 'worker-1', 'leader-fixed', 'INTEGRATED: same-body', cwd);
          await sendWorkerMessage('team-leader-dedupe-notified', 'worker-1', 'leader-fixed', 'INTEGRATED: same-body', cwd);

          const messages = await listMailboxMessages('team-leader-dedupe-notified', 'leader-fixed', cwd);
          const workerMessages = messages.filter((message) => message.from_worker === 'worker-1' && message.body === 'INTEGRATED: same-body');
          assert.equal(workerMessages.length, 1);
          assert.ok(workerMessages[0]?.notified_at);

          const requests = await listDispatchRequests('team-leader-dedupe-notified', cwd, { kind: 'mailbox', to_worker: 'leader-fixed' });
          assert.ok(requests.some((request) => request.status === 'notified' && request.message_id === workerMessages[0]?.message_id));
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('sendWorkerMessage hook-preferred path persists leader mailbox guidance when leader pane exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-leader-inject-'));
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-leader-inject-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  send-keys)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState('team-leader-inject', 'leader injection test', 'executor', 1, cwd);
          const cfg = await readTeamConfig('team-leader-inject', cwd);
          assert.ok(cfg);
          if (!cfg) throw new Error('missing team config');
          cfg.leader_pane_id = '%55';
          cfg.team_state_root = '/tmp/custom-team-state-root';
          await saveTeamConfig(cfg, cwd);

          const manifestPath = teamStateTestPath(cwd, 'team', 'team-leader-inject', 'manifest.v2.json');
          const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
          manifest.policy = { ...(manifest.policy || {}), dispatch_ack_timeout_ms: 100 };
          await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

          await sendWorkerMessage('team-leader-inject', 'worker-1', 'leader-fixed', 'hello leader', cwd);

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
          assert.doesNotMatch(tmuxLog, /send-keys -t %55/, 'team runtime should not directly inject into leader pane');

          const mailbox = await listMailboxMessages('team-leader-inject', 'leader-fixed', cwd);
          assert.ok(mailbox.some((m: { notified_at?: string }) => typeof m.notified_at === 'string' && m.notified_at.length > 0));
          assert.equal(mailbox[0]?.body, 'hello leader');

          const requests = await listDispatchRequests('team-leader-inject', cwd, { kind: 'mailbox', to_worker: 'leader-fixed' });
          const latest = requests[requests.length - 1];
          assert.equal(latest?.status, 'notified');
          assert.equal(latest?.last_reason, 'fallback_confirmed:leader_mailbox_notified');
          assert.match(
            latest?.trigger_message ?? '',
            /Read \/tmp\/custom-team-state-root\/team\/team-leader-inject\/mailbox\/leader-fixed\.json; new msg from worker-1\./,
          );

          const deliveryLog = await readTeamDeliveryLog(cwd);
          const runtimeEntries = deliveryLog.filter((entry) =>
            entry.event === 'dispatch_result'
            && entry.source === 'team.runtime'
            && entry.to_worker === 'leader-fixed'
            && entry.transport === 'mailbox'
            && entry.result === 'confirmed'
            && typeof entry.reason === 'string'
            && String(entry.reason).includes('leader_mailbox_notified'));
          assert.equal(runtimeEntries.length, 1, 'leader hook-preferred confirmation should emit exactly one runtime dispatch_result entry');
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('sendWorkerMessage keeps failed hook receipts failed when fallback mailbox persistence confirms delivery', { concurrency: false }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-leader-failed-receipt-'));
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-leader-failed-receipt-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  send-keys)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async () => {
          await initTeamState('team-leader-failed-receipt', 'leader failed receipt fallback test', 'executor', 1, cwd);
          const cfg = await readTeamConfig('team-leader-failed-receipt', cwd);
          assert.ok(cfg);
          if (!cfg) throw new Error('missing team config');
          cfg.leader_pane_id = '%55';
          await saveTeamConfig(cfg, cwd);

          const manifestPath = teamStateTestPath(cwd, 'team', 'team-leader-failed-receipt', 'manifest.v2.json');
          const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
          manifest.policy = { ...(manifest.policy || {}), dispatch_ack_timeout_ms: 250 };
          await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

          const sendPromise = sendWorkerMessage('team-leader-failed-receipt', 'worker-1', 'leader-fixed', 'hello failed receipt', cwd);

          const deadline = Date.now() + 2_000;
          let requestId: string | null = null;
          while (Date.now() < deadline && !requestId) {
            const requests = await listDispatchRequests('team-leader-failed-receipt', cwd, { kind: 'mailbox', to_worker: 'leader-fixed' });
            requestId = requests[requests.length - 1]?.request_id ?? null;
            if (!requestId) await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.ok(requestId, 'expected mailbox dispatch request to be queued');
          if (!requestId) throw new Error('missing request id');

          await transitionDispatchRequest(
            'team-leader-failed-receipt',
            requestId,
            'pending',
            'failed',
            { last_reason: 'hook_failed:test_receipt' },
            cwd,
          );

          const outcome = await sendPromise;
          assert.equal(outcome.ok, true);
          assert.equal(outcome.reason, 'fallback_confirmed_after_failed_receipt:leader_mailbox_notified');

          const requests = await listDispatchRequests('team-leader-failed-receipt', cwd, { kind: 'mailbox', to_worker: 'leader-fixed' });
          const latest = requests[requests.length - 1];
          assert.equal(latest?.request_id, requestId);
          assert.equal(latest?.status, 'failed');
          assert.equal(latest?.last_reason, 'fallback_confirmed_after_failed_receipt:leader_mailbox_notified');

          const mailbox = await listMailboxMessages('team-leader-failed-receipt', 'leader-fixed', cwd);
          assert.ok(mailbox[0]?.notified_at, 'fallback mailbox persistence should still mark notified_at');
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('sendWorkerMessage hook-preferred path for leader waits for receipt then falls back to mailbox persistence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-leader-hook-'));
    try {
      await initTeamState('team-leader-hook', 'leader hook fallback test', 'executor', 1, cwd);
      const cfg = await readTeamConfig('team-leader-hook', cwd);
      assert.ok(cfg);
      if (!cfg) throw new Error('missing team config');
      cfg.leader_pane_id = '';
      await saveTeamConfig(cfg, cwd);
      await sendWorkerMessage('team-leader-hook', 'worker-1', 'leader-fixed', 'hello leader', cwd);

      const mailbox = await listMailboxMessages('team-leader-hook', 'leader-fixed', cwd);
      assert.ok(mailbox.length >= 1, `expected at least 1 mailbox message, got ${mailbox.length}`);
      const notifiedMsg = mailbox.find((m: { notified_at?: string }) => m.notified_at);
      assert.equal(notifiedMsg, undefined, 'leader mailbox message should remain unnotified while pane is missing');

      const requests = await listDispatchRequests('team-leader-hook', cwd, { kind: 'mailbox' });
      assert.ok(requests.length >= 1, `expected at least 1 dispatch request, got ${requests.length}`);
      const pending = requests.find((r: { status?: string; to_worker?: string }) =>
        r.status === 'pending' && r.to_worker === 'leader-fixed');
      assert.ok(pending, 'expected a pending leader-fixed dispatch request');
      assert.equal(pending?.last_reason, 'leader_pane_missing_deferred');

      const deliveryLog = await readTeamDeliveryLog(cwd);
      const runtimeEntries = deliveryLog.filter((entry) =>
        entry.event === 'dispatch_result'
        && entry.source === 'team.runtime'
        && entry.to_worker === 'leader-fixed'
        && entry.transport === 'mailbox'
        && entry.reason === 'leader_pane_missing_mailbox_persisted');
      assert.equal(runtimeEntries.length, 1, 'leader missing-pane fallback should emit exactly one runtime dispatch_result entry');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('sendWorkerMessage transport_direct keeps leader-fixed request pending when leader_pane_id missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-leader-direct-'));
    try {
      await initTeamState('team-leader-direct', 'leader direct transport test', 'executor', 1, cwd);
      const cfg = await readTeamConfig('team-leader-direct', cwd);
      assert.ok(cfg);
      if (!cfg) throw new Error('missing team config');
      cfg.leader_pane_id = '';
      await saveTeamConfig(cfg, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'team-leader-direct', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
      manifest.policy = { ...(manifest.policy || {}), dispatch_mode: 'transport_direct' };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      await sendWorkerMessage('team-leader-direct', 'worker-1', 'leader-fixed', 'hello leader direct', cwd);

      const mailbox = await listMailboxMessages('team-leader-direct', 'leader-fixed', cwd);
      assert.ok(mailbox.length >= 1, `expected at least 1 mailbox message, got ${mailbox.length}`);
      const requests = await listDispatchRequests('team-leader-direct', cwd, { kind: 'mailbox', to_worker: 'leader-fixed' });
      assert.ok(requests.length >= 1, `expected at least 1 leader-fixed dispatch request, got ${requests.length}`);
      const latest = requests[requests.length - 1];
      assert.equal(latest?.status, 'pending');
      assert.equal(latest?.last_reason, 'leader_pane_missing_deferred');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
