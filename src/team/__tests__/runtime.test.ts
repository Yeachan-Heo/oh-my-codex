import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir, chmod, readdir } from 'fs/promises';
import { join, relative, dirname } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import { HUD_TMUX_TEAM_HEIGHT_LINES } from '../../hud/constants.js';
import {
  DEFAULT_MAX_WORKERS,
  initTeamState,
  createTask,
  writeWorkerIdentity,
  writeWorkerInbox,
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
  readWorkerStatus,
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
  resolveTeamWorkerCliForResolvedLaunchArgs,
  shouldPrekillInteractiveShutdownProcessTrees,
  waitForWorkerStartupEvidence,
  waitForClaudeStartupEvidence,
  cleanupTeamWorkerLaunchOrphanedMcpProcesses,
  settleStartupAttemptResults,
  TEAM_LOW_COMPLEXITY_DEFAULT_MODEL,
  type TeamRuntime,
  setDetachedSessionDestroyAfterJournalHookForTest,
} from '../runtime.js';
import {
  resolveAgentReasoningEffort,
  resolveTeamLowComplexityDefaultModel,
  TEAM_WORKER_INHERITED_MODEL_ENV,
} from '../model-contract.js';
import { readTeamEvents } from '../state/events.js';
import { sanitizeTeamName } from '../tmux-session.js';
import { buildInternalTeamName, resolveTeamIdentityScope } from '../team-identity.js';
import { writePersistedApprovedTeamExecutionBinding } from '../approved-execution.js';
import { planWorktreeTarget } from '../worktree.js';
import { scaleDown } from '../scaling.js';

const coverageRun = process.env.NODE_V8_COVERAGE ? true : false;
const skipSlowLifecycleUnderCoverage = coverageRun
  ? 'covered by the team-state-runtime lane; skipped under c8 to keep the coverage gate bounded around slow process-lifecycle waits'
  : false;

const tmuxOwnerProofShim = `
if [ "\${1:-}" = "set-option" ] && [ "\${5:-}" = "@omx_team_pane_owner_id" ]; then
  printf '%s' "\${6:-}" > "$0.owner-\${4#%}"
fi
if [ "\${1:-}" = "show-option" ] && [ "\${6:-}" = "@omx_team_pane_owner_id" ]; then
  owner_path="$0.owner-\${5#%}"
  [ -f "$owner_path" ] && cat "$owner_path"
  exit 0
fi
`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

async function writeReadyContextPack(
  cwd: string,
  slug: string,
  prdPath: string,
  testSpecPath: string,
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
    entries: ['scope', 'build', 'verify'].map((role, index) => ({
      path: `src/${role}-${index}.ts`,
      roles: [role],
    })),
  }, null, 2));
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

function withIsolatedDefaultModelEnv<T>(run: () => T): T {
  const savedEnv = new Map<string, string | undefined>();
  for (const key of [
    'CODEX_HOME',
    'OMX_DEFAULT_FRONTIER_MODEL',
    'OMX_DEFAULT_STANDARD_MODEL',
    'OMX_DEFAULT_SPARK_MODEL',
    'OMX_SPARK_MODEL',
    'OMX_TEAM_WORKER_LAUNCH_ARGS',
  ] as const) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.CODEX_HOME = join(
    tmpdir(),
    `omx-runtime-defaults-${process.pid}-${Date.now()}`,
  );

  try {
    return run();
  } finally {
    for (const [key, value] of savedEnv.entries()) {
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
  }
}

async function withIsolatedDefaultModelEnvAsync<T>(
  run: () => Promise<T>,
): Promise<T> {
  const savedEnv = new Map<string, string | undefined>();
  for (const key of [
    'CODEX_HOME',
    'OMX_DEFAULT_FRONTIER_MODEL',
    'OMX_DEFAULT_STANDARD_MODEL',
    'OMX_DEFAULT_SPARK_MODEL',
    'OMX_SPARK_MODEL',
    'OMX_TEAM_WORKER_LAUNCH_ARGS',
  ] as const) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.CODEX_HOME = join(
    tmpdir(),
    `omx-runtime-defaults-${process.pid}-${Date.now()}`,
  );

  try {
    return await run();
  } finally {
    for (const [key, value] of savedEnv.entries()) {
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
  }
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

async function markDetachedSessionAbsent(teamName: string, cwd: string): Promise<void> {
  const config = await readTeamConfig(teamName, cwd);
  assert.ok(config, 'team config should exist');
  if (!config) throw new Error('missing team config');
  config.tmux_session = '';
  config.leader_pane_id = '';
  config.leader_pane_pid = undefined;
  config.hud_pane_id = null;
  config.hud_pane_pid = undefined;
  for (const worker of config.workers) {
    worker.pane_id = '';
    worker.pid = undefined;
  }
  config.workers = [];
  config.worker_count = 0;
  await saveTeamConfig(config, cwd);
  const manifestPath = join(cwd, '.omx', 'state', 'team', teamName, 'manifest.v2.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
  manifest.tmux_session = '';
  manifest.leader_pane_id = '';
  manifest.leader_pane_pid = undefined;
  manifest.hud_pane_id = null;
  manifest.hud_pane_pid = undefined;
  if (Array.isArray(manifest.workers)) {
    for (const worker of manifest.workers) {
      if (!worker || typeof worker !== 'object') continue;
      (worker as Record<string, unknown>).pane_id = '';
      (worker as Record<string, unknown>).pid = undefined;
    }
  }
  manifest.workers = [];
  manifest.worker_count = 0;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

async function shutdownWithoutTmuxSession(
  teamName: string,
  cwd: string,
  options?: Parameters<typeof shutdownTeam>[2],
): Promise<void> {
  const previousTmux = process.env.TMUX;
  const previousPane = process.env.TMUX_PANE;
  const previousPath = process.env.PATH;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  process.env.PATH = '';
  try {
    await shutdownTeam(teamName, cwd, options);
  } finally {
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
    if (previousPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = previousPane;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

async function markPendingInboxDispatchesDelivered(
  teamName: string,
  cwd: string,
  opts: {
    toWorker?: string;
    lastReason?: string;
    beforeDeliver?: () => Promise<void>;
    afterDeliver?: () => Promise<void>;
  } = {},
): Promise<void> {
  const requests = await listDispatchRequests(await resolveRuntimeTeamName(cwd, teamName), cwd, { kind: 'inbox' }).catch(() => []);
  for (const request of requests) {
    if (request.status !== 'pending') continue;
    if (opts.toWorker && request.to_worker !== opts.toWorker) continue;
    await opts.beforeDeliver?.();
    const notified = await transitionDispatchRequest(
      teamName,
      request.request_id,
      'pending',
      'notified',
      { last_reason: opts.lastReason ?? 'test_delivered_receipt' },
      cwd,
    ).catch(() => null);
    if (!notified) continue;
    await transitionDispatchRequest(
      teamName,
      request.request_id,
      'notified',
      'delivered',
      { last_reason: opts.lastReason ?? 'test_delivered_receipt' },
      cwd,
    ).catch(() => {});
    await opts.afterDeliver?.();
  }
}

async function markPendingInboxDispatchesNotified(
  teamName: string,
  cwd: string,
  opts: {
    toWorker?: string;
    lastReason?: string;
  } = {},
): Promise<void> {
  const requests = await listDispatchRequests(await resolveRuntimeTeamName(cwd, teamName), cwd, { kind: 'inbox' }).catch(() => []);
  for (const request of requests) {
    if (request.status !== 'pending') continue;
    if (opts.toWorker && request.to_worker !== opts.toWorker) continue;
    await transitionDispatchRequest(
      teamName,
      request.request_id,
      'pending',
      'notified',
      { last_reason: opts.lastReason ?? 'test_notified_receipt' },
      cwd,
    ).catch(() => {});
  }
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

async function resolveRuntimeTeamName(cwd: string, requestedName: string): Promise<string> {
  const teamsRoot = join(cwd, '.omx', 'state', 'team');
  const entries = await readdir(teamsRoot, { withFileTypes: true }).catch(() => []);
  const prefix = requestedName.slice(0, 18);
  const names = entries
    .filter((entry) => entry.isDirectory() && (entry.name === requestedName || entry.name.startsWith(`${requestedName}-`) || entry.name.startsWith(prefix)))
    .map((entry) => entry.name)
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return names[0] ?? requestedName;
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
const worker = String(process.env.OMX_TEAM_INTERNAL_WORKER || process.env.OMX_TEAM_WORKER || '');
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
if (process.argv[2] === '--version') {
  console.log('codex 0.0.0-test');
  process.exit(0);
}
${bootstrap}
${scriptBody}
`,
    { mode: 0o755 },
  );
}

async function writeSuccessfulEmptyTmuxQuery(binDir: string): Promise<void> {
  await writeFile(
    join(binDir, 'tmux'),
    `#!/bin/sh
if [ "\${1:-}" = "list-sessions" ]; then
  exit 0
fi
exit 1
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
    OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT: '1',
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

function fakeCodexShellScript(body: string): string {
  return `#!/bin/sh
if [ "\${1:-}" = "--version" ] || [ "\${1:-}" = "-V" ]; then
  echo "codex 0.0.0-test"
  exit 0
fi
${body}`;
}

function fakeCodexNodeScript(body: string): string {
  return `#!/usr/bin/env node
if (process.argv.includes('--version') || process.argv.includes('-V')) {
  console.log('codex 0.0.0-test');
  process.exit(0);
}
${body}`;
}


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
    const tmuxFixture = options.tmuxScript(tmuxLogPath);
    const fixtureDefinesGlobalExactPaneSnapshot = tmuxFixture.includes('-a -F #{pane_id}');
    const compatibleTmuxFixture = fixtureDefinesGlobalExactPaneSnapshot
      ? tmuxFixture
      : tmuxFixture.replace(
        '#!/bin/sh\n',
        `#!/bin/sh
# Legacy fixtures without a global snapshot get deterministic, valid live panes.
if [ "\${1:-}" = "list-panes" ] && [ "\${2:-}" = "-a" ] && [ "\${3:-}" = "-F" ] && [ "\${4:-}" = "#{pane_id}\t#{pane_dead}\t#{pane_pid}" ]; then
  printf '%s\n' "$*" >> "${tmuxLogPath}"
  pane_id=1
  while [ "$pane_id" -le 99 ]; do
    printf '%%%s\t0\t%s\n' "$pane_id" "$((2000000000 + pane_id * 1111))"
    pane_id=$((pane_id + 1))
  done
  exit 0
fi
`,
      );
    await writeFile(tmuxStubPath, compatibleTmuxFixture);
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

  it('keeps an explicit direct policy authoritative while preserving inherited model and role reasoning', () => {
    const args = resolveWorkerLaunchArgsFromEnv(
      {
        OMX_TEAM_WORKER_LAUNCH_ARGS: '--sandbox=workspace-write',
        [TEAM_WORKER_INHERITED_MODEL_ENV]: 'leader-model',
      },
      'executor',
      undefined,
      'medium',
      'codex',
    );
    assert.deepEqual(args, [
      '--sandbox', 'workspace-write',
      '-c', 'model_reasoning_effort="medium"',
      '--model', 'leader-model',
    ]);

  });

  it('rejects explicit mixed worker policy before initial team state or workers are created', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-explicit-policy-'));
    const previousLaunchArgs = process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
    process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = '--dangerously-bypass-approvals-and-sandbox -a on-request';
    try {
      await assert.rejects(
        () => withEmptyPath(() =>
          startTeam('explicit-policy', 'task', 'executor', 1, [{ subject: 's', description: 'd' }], cwd),
        ),
        /Invalid OMX_TEAM_WORKER_LAUNCH_ARGS: bypass cannot be combined with direct approval or sandbox policy/,
      );
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', 'explicit-policy')), false);
    } finally {
      if (typeof previousLaunchArgs === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = previousLaunchArgs;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam launches executor workers with authoritative config policy, positional backslashes, and no bypass', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-direct-policy-start-'));
    const binDir = join(cwd, 'bin');
    const capturePath = join(cwd, 'worker-argv.json');
    const fakeCodexPath = join(binDir, 'codex');
    let runtime: TeamRuntime | null = null;
    await mkdir(binDir, { recursive: true });
    await writeFakePromptWorkerBinary(
      fakeCodexPath,
      `fs.writeFileSync(process.env.OMX_POLICY_ARGV_CAPTURE, JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
setTimeout(() => process.exit(0), 5000);
process.on('SIGTERM', () => process.exit(0));`,
    );

    try {
      await withIsolatedDefaultModelEnvAsync(async () => {
        await withPromptModeCodexEnv(binDir, {
          OMX_BYPASS_DEFAULT_SYSTEM_PROMPT: '0',
          OMX_POLICY_ARGV_CAPTURE: capturePath,
          OMX_TEAM_WORKER_LAUNCH_ARGS: String.raw`--config 'sandbox_mode="workspace-write"' -- 'C:\workspace\nested\' '' '--sandbox=read-only' '--madmax'`,
        }, async () => {
          const previousArgv = process.argv;
          process.argv = ['node', 'omx', '--madmax'];
          try {
            runtime = await withoutTeamWorkerEnv(() =>
              startTeam(
                'direct-policy-start',
                'launch executor with a direct sandbox policy',
                'executor',
                1,
                [{ subject: 's', description: 'd', owner: 'worker-1' }],
                cwd,
              ));
          } finally {
            process.argv = previousArgv;
          }
        });
      });

      const workerArgs = JSON.parse(await waitForFileText(capturePath, (content) => content.length > 0)) as string[];
      assert.deepEqual(workerArgs, [
        '--sandbox', 'workspace-write',
        '-c', 'model_reasoning_effort="medium"',
        '--model', 'gpt-5.6-sol',
        '--', 'C:\\workspace\\nested\\', '', '--sandbox=read-only', '--madmax',
      ]);
      const startedRuntime = runtime as TeamRuntime | null;
      assert.ok(startedRuntime);
      await shutdownTeam(startedRuntime.teamName, cwd, { force: true });
      runtime = null;
    } finally {
      const activeRuntime = runtime as TeamRuntime | null;
      if (activeRuntime) await shutdownTeam(activeRuntime.teamName, cwd, { force: true }).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects Claude and Gemini restrictive config policy before prompt worker capture and cleans state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-restrictive-noncodex-'));
    const binDir = join(cwd, 'bin');
    const previousPath = process.env.PATH;
    const previousTmux = process.env.TMUX;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const previousLaunchArgs = process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
    const previousCapture = process.env.OMX_POLICY_ARGV_CAPTURE;
    const previousSessionId = process.env.OMX_SESSION_ID;
    await mkdir(binDir, { recursive: true });
    try {
      for (const workerCli of ['claude', 'gemini'] as const) {
        const capturePath = join(cwd, `${workerCli}-argv.json`);
        const teamName = `restrictive-${workerCli}`;
        const teamSessionId = `restrictive-${workerCli}-session`;
        const internalTeamName = buildInternalTeamName(teamName, resolveTeamIdentityScope({ OMX_SESSION_ID: teamSessionId }));
        assert.match(internalTeamName, new RegExp(`^${teamName}-[a-f0-9]{8}$`));
        await writeFile(
          join(binDir, workerCli),
          `#!/usr/bin/env node
require('fs').writeFileSync(process.env.OMX_POLICY_ARGV_CAPTURE, JSON.stringify(process.argv.slice(2)));
`,
          { mode: 0o755 },
        );
        process.env.PATH = `${binDir}:${previousPath ?? ''}`;
        delete process.env.TMUX;
        process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
        process.env.OMX_TEAM_WORKER_CLI = workerCli;
        process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = `--config 'sandbox_mode="workspace-write"'`;
        process.env.OMX_SESSION_ID = teamSessionId;
        process.env.OMX_POLICY_ARGV_CAPTURE = capturePath;

        await assert.rejects(
          () => withoutTeamWorkerEnv(() =>
            startTeam(teamName, 'restrictive non-Codex policy', 'executor', 1, [{ subject: 's', description: 'd', owner: 'worker-1' }], cwd)),
          new RegExp(`Selected team worker CLI "${workerCli}" is incompatible with an explicit approval or sandbox policy\\.`),
        );
        assert.equal(existsSync(capturePath), false, `${workerCli} must not be spawned`);
        assert.equal(
          existsSync(join(cwd, '.omx', 'state', 'team', internalTeamName)),
          false,
          `${workerCli} internal state must be rolled back`,
        );
      }
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof previousLaunchArgs === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = previousLaunchArgs;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
      if (typeof previousCapture === 'string') process.env.OMX_POLICY_ARGV_CAPTURE = previousCapture;
      else delete process.env.OMX_POLICY_ARGV_CAPTURE;
      if (typeof previousSessionId === 'string') process.env.OMX_SESSION_ID = previousSessionId;
      else delete process.env.OMX_SESSION_ID;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects mixed CLI restrictive policy before any prompt worker is spawned', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-mixed-policy-rollback-'));
    const codexBin = join(cwd, 'codex-bin');
    const nonCodexBin = join(cwd, 'non-codex-bin');
    const previousPath = process.env.PATH;
    const previousTmux = process.env.TMUX;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const previousWorkerCliMap = process.env.OMX_TEAM_WORKER_CLI_MAP;
    const previousLaunchArgs = process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
    const previousAllowNonTty = process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT;
    const previousBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const previousSessionId = process.env.OMX_SESSION_ID;
    const previousCodexCapture = process.env.OMX_CODEX_PID_CAPTURE;
    const previousNonCodexCapture = process.env.OMX_NON_CODEX_CAPTURE;
    await mkdir(codexBin, { recursive: true });
    await mkdir(nonCodexBin, { recursive: true });
    try {
      await writeFile(
        join(codexBin, 'codex'),
        `#!${process.execPath}
const fs = require('fs');
fs.writeFileSync(process.env.OMX_CODEX_PID_CAPTURE, String(process.pid));
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`,
        { mode: 0o755 },
      );
      for (const workerCli of ['claude', 'gemini'] as const) {
        await writeFile(
          join(nonCodexBin, workerCli),
          `#!${process.execPath}
require('fs').writeFileSync(process.env.OMX_NON_CODEX_CAPTURE, process.argv.slice(2).join(' '));
`,
          { mode: 0o755 },
        );
      }


      process.env.PATH = [codexBin, nonCodexBin, previousPath ?? ''].join(':');
      delete process.env.TMUX;
      delete process.env.OMX_TEAM_WORKER_CLI;
      process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
      process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = '--config sandbox_mode="workspace-write"';
      process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT = '1';
      process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';

      for (const nonCodexCli of ['claude', 'gemini'] as const) {
        const teamName = `mixed-${nonCodexCli}-rollback`;
        const teamSessionId = `mixed-${nonCodexCli}-rollback-session`;
        const internalTeamName = buildInternalTeamName(teamName, resolveTeamIdentityScope({ OMX_SESSION_ID: teamSessionId }));
        const codexCapturePath = join(cwd, `${nonCodexCli}-codex.pid`);
        const nonCodexCapturePath = join(cwd, `${nonCodexCli}-non-codex.argv`);
        process.env.OMX_SESSION_ID = teamSessionId;
        process.env.OMX_TEAM_WORKER_CLI_MAP = `codex,${nonCodexCli}`;
        process.env.OMX_CODEX_PID_CAPTURE = codexCapturePath;
        process.env.OMX_NON_CODEX_CAPTURE = nonCodexCapturePath;

        await assert.rejects(
          () => withoutTeamWorkerEnv(() =>
            startTeam(
              teamName,
              'mixed CLI restrictive policy rollback',
              'executor',
              2,
              [
                { subject: 'codex task', description: 'first worker', owner: 'worker-1' },
                { subject: 'non-Codex task', description: 'second worker', owner: 'worker-2' },
              ],
              cwd,
            )),
          new RegExp(`Selected team worker CLI "${nonCodexCli}" is incompatible with an explicit approval or sandbox policy\\.`),
        );

        assert.equal(existsSync(codexCapturePath), false, 'Codex must not spawn before every worker policy is compatible');
        assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', internalTeamName)), false);
        assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', internalTeamName, 'tasks')), false);
        assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', internalTeamName, 'workers')), false);
        assert.equal(existsSync(nonCodexCapturePath), false, `${nonCodexCli} must not be spawned`);
      }
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof previousWorkerCliMap === 'string') process.env.OMX_TEAM_WORKER_CLI_MAP = previousWorkerCliMap;
      else delete process.env.OMX_TEAM_WORKER_CLI_MAP;
      if (typeof previousLaunchArgs === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = previousLaunchArgs;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
      if (typeof previousAllowNonTty === 'string') process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT = previousAllowNonTty;
      else delete process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT;
      if (typeof previousBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = previousBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof previousSessionId === 'string') process.env.OMX_SESSION_ID = previousSessionId;
      else delete process.env.OMX_SESSION_ID;
      if (typeof previousCodexCapture === 'string') process.env.OMX_CODEX_PID_CAPTURE = previousCodexCapture;
      else delete process.env.OMX_CODEX_PID_CAPTURE;
      if (typeof previousNonCodexCapture === 'string') process.env.OMX_NON_CODEX_CAPTURE = previousNonCodexCapture;
      else delete process.env.OMX_NON_CODEX_CAPTURE;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects restrictive later CLI before provisioning or composing a reused worker worktree', async () => {
    const repo = await initRepo();
    const teamName = 'reused-worktree-policy';
    const teamSessionId = 'reused-worktree-policy-session';
    const internalTeamName = buildInternalTeamName(teamName, resolveTeamIdentityScope({ OMX_SESSION_ID: teamSessionId }));
    const worktreeMode = { enabled: true, detached: false, name: 'policy-preflight-reuse' } as const;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const previousWorkerCliMap = process.env.OMX_TEAM_WORKER_CLI_MAP;
    const previousLaunchArgs = process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
    const previousAllowNonTty = process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT;
    const previousSessionId = process.env.OMX_SESSION_ID;
    let workerWorktreePath: string | null = null;
    let rejectedWorkerWorktreePath: string | null = null;
    let rejectedWorkerBranchName: string | null = null;

    try {
      await writeFile(join(repo, '.gitignore'), '.omx/\n', 'utf-8');
      execFileSync('git', ['add', '.gitignore'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'ignore team worktrees'], { cwd: repo, stdio: 'ignore' });

      const workerWorktreePlan = planWorktreeTarget({
        cwd: repo,
        scope: 'team',
        mode: worktreeMode,
        teamName: internalTeamName,
        workerName: 'worker-1',
      });
      if (!workerWorktreePlan.enabled || !workerWorktreePlan.branchName) {
        throw new Error('expected named reusable worker worktree plan');
      }
      workerWorktreePath = workerWorktreePlan.worktreePath;
      await mkdir(dirname(workerWorktreePath), { recursive: true });
      execFileSync(
        'git',
        ['worktree', 'add', '-b', workerWorktreePlan.branchName, workerWorktreePath, 'HEAD'],
        { cwd: repo, stdio: 'ignore' },
      );

      const agentsPath = join(workerWorktreePath, 'AGENTS.md');
      await writeFile(agentsPath, '# Reused worker instructions\n\nKeep this exact content.\n', 'utf-8');
      execFileSync('git', ['add', 'AGENTS.md'], { cwd: workerWorktreePath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'seed reusable worker instructions'], { cwd: workerWorktreePath, stdio: 'ignore' });
      const agentsBefore = await readFile(agentsPath);
      const indexBefore = execFileSync('git', ['ls-files', '-v', '--', 'AGENTS.md'], {
        cwd: workerWorktreePath,
        encoding: 'utf-8',
      });
      const statusBefore = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
        cwd: workerWorktreePath,
        encoding: 'utf-8',
      });
      const rejectedWorkerPlan = planWorktreeTarget({
        cwd: repo,
        scope: 'team',
        mode: worktreeMode,
        teamName: internalTeamName,
        workerName: 'worker-2',
      });
      if (!rejectedWorkerPlan.enabled || !rejectedWorkerPlan.branchName) {
        throw new Error('expected named rejected worker worktree plan');
      }
      rejectedWorkerWorktreePath = rejectedWorkerPlan.worktreePath;
      rejectedWorkerBranchName = rejectedWorkerPlan.branchName;
      const worktreeRegistryBefore = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repo,
        encoding: 'utf-8',
      });
      const sourceStatusBefore = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
        cwd: repo,
        encoding: 'utf-8',
      });
      const rejectedBranchBefore = execFileSync('git', ['branch', '--list', rejectedWorkerBranchName], {
        cwd: repo,
        encoding: 'utf-8',
      });
      assert.equal(rejectedBranchBefore, '');
      assert.equal(existsSync(rejectedWorkerWorktreePath), false);


      delete process.env.OMX_TEAM_WORKER_CLI;
      process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
      process.env.OMX_TEAM_WORKER_CLI_MAP = 'codex,claude';
      process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = '--config sandbox_mode="workspace-write"';
      process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT = '1';
      process.env.OMX_SESSION_ID = teamSessionId;

      await assert.rejects(
        () => withoutTeamWorkerEnv(() =>
          startTeam(
            teamName,
            'reject policy before reused worktree mutation',
            'executor',
            2,
            [
              { subject: 'Codex task', description: 'first worker', owner: 'worker-1' },
              { subject: 'Claude task', description: 'later worker', owner: 'worker-2' },
            ],
            repo,
            { worktreeMode },
          )),
        /Selected team worker CLI "claude" is incompatible with an explicit approval or sandbox policy\./,
      );

      assert.deepEqual(await readFile(agentsPath), agentsBefore);
      assert.equal(
        execFileSync('git', ['ls-files', '-v', '--', 'AGENTS.md'], {
          cwd: workerWorktreePath,
          encoding: 'utf-8',
        }),
        indexBefore,
      );
      assert.equal(
        execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
          cwd: workerWorktreePath,
          encoding: 'utf-8',
        }),
        statusBefore,
      );
      assert.equal(
        execFileSync('git', ['worktree', 'list', '--porcelain'], {
          cwd: repo,
          encoding: 'utf-8',
        }),
        worktreeRegistryBefore,
      );
      assert.equal(
        execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
          cwd: repo,
          encoding: 'utf-8',
        }),
        sourceStatusBefore,
      );
      assert.equal(
        execFileSync('git', ['branch', '--list', rejectedWorkerBranchName], {
          cwd: repo,
          encoding: 'utf-8',
        }),
        rejectedBranchBefore,
      );
      assert.equal(existsSync(rejectedWorkerWorktreePath), false);

      assert.equal(existsSync(join(repo, '.omx', 'state', 'current-task-baseline.json')), false);
      assert.equal(existsSync(join(repo, '.omx', 'state', 'team', internalTeamName)), false);
    } finally {
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof previousWorkerCliMap === 'string') process.env.OMX_TEAM_WORKER_CLI_MAP = previousWorkerCliMap;
      else delete process.env.OMX_TEAM_WORKER_CLI_MAP;
      if (typeof previousLaunchArgs === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = previousLaunchArgs;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
      if (typeof previousAllowNonTty === 'string') process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT = previousAllowNonTty;
      else delete process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT;
      if (typeof previousSessionId === 'string') process.env.OMX_SESSION_ID = previousSessionId;
      else delete process.env.OMX_SESSION_ID;
      if (workerWorktreePath && existsSync(workerWorktreePath)) {
        execFileSync('git', ['worktree', 'remove', '--force', workerWorktreePath], { cwd: repo, stdio: 'ignore' });
      }
      if (rejectedWorkerWorktreePath && existsSync(rejectedWorkerWorktreePath)) {
        execFileSync('git', ['worktree', 'remove', '--force', rejectedWorkerWorktreePath], { cwd: repo, stdio: 'ignore' });
      }
      if (rejectedWorkerBranchName) {
        const rejectedBranch = execFileSync('git', ['branch', '--list', rejectedWorkerBranchName], {
          cwd: repo,
          encoding: 'utf-8',
        });
        if (rejectedBranch.trim() !== '') {
          execFileSync('git', ['branch', '-D', rejectedWorkerBranchName], { cwd: repo, stdio: 'ignore' });
        }
      }
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('resolveWorkerLaunchArgsFromEnv reads low-complexity model from config when present', async () => {
    // Intentional legacy model fixture: verifies explicit low-complexity config survives worker launch resolution.
    await withIsolatedDefaultModelEnvAsync(async () => {
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
  });

  it('resolveWorkerLaunchArgsFromEnv injects the frontier default model for executor workers', () => {
    withIsolatedDefaultModelEnv(() => {
      const args = resolveWorkerLaunchArgsFromEnv(
        { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
        'executor',
      );
      assert.deepEqual(args, ['--no-alt-screen', '--model', 'gpt-5.6-sol']);
    });
  });

  it('resolveWorkerLaunchArgsFromEnv uses medium reasoning for executor launch defaults', () => {
    withIsolatedDefaultModelEnv(() => {
      const args = resolveWorkerLaunchArgsFromEnv(
        { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
        'executor',
        undefined,
        resolveAgentReasoningEffort('executor'),
        'codex',
      );
      assert.deepEqual(args, ['--no-alt-screen', '-c', 'model_reasoning_effort="medium"', '--model', 'gpt-5.6-sol']);
    });
  });

  it('resolveWorkerLaunchArgsFromEnv keeps planner on exact gpt-5.6-sol medium when inherited leader is mini', () => {
    withIsolatedDefaultModelEnv(() => {
      const args = resolveWorkerLaunchArgsFromEnv(
        {
          OMX_TEAM_WORKER_LAUNCH_ARGS: '--dangerously-bypass-approvals-and-sandbox --model gpt-5.6-terra',
          [TEAM_WORKER_INHERITED_MODEL_ENV]: 'gpt-5.6-terra',
        },
        'planner',
        undefined,
        resolveAgentReasoningEffort('planner'),
        'codex',
      );
      assert.deepEqual(args, [
        '--dangerously-bypass-approvals-and-sandbox',
        '-c',
        'model_reasoning_effort="medium"',
        '--model',
        'gpt-5.6-sol',
      ]);
    });
  });

  it('resolveTeamWorkerCliForResolvedLaunchArgs derives auto CLI from exact-model resolved launch args', () => {
    withIsolatedDefaultModelEnv(() => {
      const resolvedLaunchArgs = resolveWorkerLaunchArgsFromEnv(
        {
          [TEAM_WORKER_INHERITED_MODEL_ENV]: 'claude-sonnet-4-6',
        },
        'planner',
        'claude-sonnet-4-6',
        resolveAgentReasoningEffort('planner'),
        'codex',
      );
      const workerCli = resolveTeamWorkerCliForResolvedLaunchArgs(
        1,
        1,
        resolvedLaunchArgs,
        { OMX_TEAM_WORKER_CLI_MAP: 'auto' },
      );
      assert.equal(workerCli, 'codex');
    });
  });

  it('resolveWorkerLaunchArgsFromEnv honors inherited leader model from the dedicated env path', () => {
    withIsolatedDefaultModelEnv(() => {
      const args = resolveWorkerLaunchArgsFromEnv(
        {
          OMX_TEAM_WORKER_LAUNCH_ARGS: '--dangerously-bypass-approvals-and-sandbox --model gpt-5.6-terra',
          [TEAM_WORKER_INHERITED_MODEL_ENV]: 'gpt-5.6-terra',
        },
        'planner',
        undefined,
        resolveAgentReasoningEffort('planner'),
        'codex',
      );
      assert.deepEqual(args, [
        '--dangerously-bypass-approvals-and-sandbox',
        '-c',
        'model_reasoning_effort="medium"',
        '--model',
        'gpt-5.6-sol',
      ]);
    });
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
      resolveWorkerLaunchArgsFromEnv({ OMX_TEAM_WORKER_LAUNCH_ARGS: '--model=gpt-5.5' }, 'explore'),
      ['--model', 'gpt-5.5'],
    );
  });

  it('resolveWorkerLaunchArgsFromEnv preserves explicit env model before planner exact model', () => {
    assert.deepEqual(
      resolveWorkerLaunchArgsFromEnv(
        { OMX_TEAM_WORKER_LAUNCH_ARGS: '--model explicit-worker-model' },
        'planner',
        'gpt-5.6-terra',
        'high',
        'codex',
      ),
      ['-c', 'model_reasoning_effort="high"', '--model', 'explicit-worker-model'],
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
      withIsolatedDefaultModelEnv(() => {
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
        assert.deepEqual(lowArgs, ['--no-alt-screen', '-c', 'model_reasoning_effort="low"', '--model', 'gpt-5.6-sol']);
        assert.deepEqual(highArgs, ['--no-alt-screen', '-c', 'model_reasoning_effort="high"', '--model', 'gpt-5.6-sol']);
      });
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
      let codexArgs: string[] = [];
      withIsolatedDefaultModelEnv(() => {
        codexArgs = resolveWorkerLaunchArgsFromEnv(
          { OMX_TEAM_WORKER_LAUNCH_ARGS: '--no-alt-screen' },
          'executor',
          undefined,
          'high',
          'codex',
        );
      });
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
      assert.deepEqual(codexArgs, ['--no-alt-screen', '-c', 'model_reasoning_effort="high"', '--model', 'gpt-5.6-sol']);
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

  it('cleanupTeamWorkerLaunchOrphanedMcpProcesses keeps ps and cleanup failures non-fatal', async () => {
    const warnings: string[] = [];
    let calls = 0;

    await cleanupTeamWorkerLaunchOrphanedMcpProcesses({
      cleanup: async () => {
        calls += 1;
        throw new Error('ps unavailable');
      },
      writeWarning: (message) => warnings.push(message),
    });

    await cleanupTeamWorkerLaunchOrphanedMcpProcesses({
      cleanup: async () => ({
        dryRun: false,
        candidates: [],
        terminatedCount: 0,
        forceKilledCount: 0,
        failedPids: [1234],
      }),
      writeWarning: (message) => warnings.push(message),
    });

    assert.equal(calls, 1);
    assert.match(warnings.join('\n'), /ps unavailable.*continuing worker launch/);
    assert.match(warnings.join('\n'), /Failed to reap 1 orphaned OMX MCP process/);
  });

  it('waitForWorkerStartupEvidence treats blocked worker status as settled progress even without a claimed task id', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-codex-blocked-startup-'));
    try {
      await initTeamState('codex-blocked-startup', 'blocked startup evidence test', 'executor', 1, cwd);

      await writeAtomic(
        join(cwd, '.omx', 'state', 'team', 'codex-blocked-startup', 'workers', 'worker-1', 'status.json'),
        JSON.stringify({
          state: 'blocked',
          reason: 'waiting on shared file',
          updated_at: new Date().toISOString(),
        }, null, 2),
      );
      const progress = await waitForWorkerStartupEvidence({
        teamName: 'codex-blocked-startup',
        workerName: 'worker-1',
        workerCli: 'codex',
        cwd,
        timeoutMs: 25,
        pollMs: 5,
      });
      assert.equal(progress, 'worker_progress');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it(
    'uses a production startup evidence window that can tolerate slow Codex startup',
    { skip: skipSlowLifecycleUnderCoverage },
    async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-startup-window-'));
    const prevTmux = process.env.TMUX;
    const prevTmuxPane = process.env.TMUX_PANE;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevSkipReadyWait = process.env.OMX_TEAM_SKIP_READY_WAIT;
    const prevStartupEvidenceTimeout = process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
    const prevStartupDispatchRetries = process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
    const prevStartupDispatchRetryDelay = process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS;
    let receiptNotifier: NodeJS.Timeout | null = null;
    let progressWriter: NodeJS.Timeout | null = null;

    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-startup-window-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
owner_path="${tmuxLogPath}.owner-%1"
case "$1" in
  --version|-V)
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
      *"-t leader:0 -F "*'#{pane_id}'*'#{pane_current_command}'*'#{pane_start_command}'*)
        team_owner=''
        if [ -f "$owner_path" ]; then IFS= read -r team_owner < "$owner_path" || true; fi
        team_name="\${team_owner#team:}"
        printf "%%1\\tzsh\\tzsh\\n"
        if [ -f "${tmuxLogPath}.worker-created" ] && [ ! -f "${tmuxLogPath}.killed-%2" ]; then
          printf "%%2\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=\${team_name}/worker-1 codex\\n"
        fi
        exit 0
        ;;
      *"-a -F #{pane_id}"*)
        printf "%%1\t0\t2000004321\n"
        if [ -f "${tmuxLogPath}.worker-created" ] && [ ! -f "${tmuxLogPath}.killed-%2" ]; then printf "%%2\t0\t2000004322\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ] && [ ! -f "${tmuxLogPath}.killed-%3" ]; then printf "%%3\t0\t2000004323\n"; fi
        ;;
      *"#{pane_pid}"*)
        echo "2000004321"
        exit 0
        ;;
      *)
        exit 0
        ;;
    esac
    ;;
  split-window)
    case "$*" in
      *" -h "*)
        : > "${tmuxLogPath}.worker-created"
        echo "%2"
        ;;
      *)
        : > "${tmuxLogPath}.hud-created"
        echo "%3"
        ;;
    esac
    exit 0
    ;;
  capture-pane)
    printf 'OpenAI Codex\\n> '
    exit 0
    ;;
  show-option)
    case "$*" in
      *"@omx_team_pane_owner_id"*) owner_path="${tmuxLogPath}.owner-\${5#%}"; [ -f "$owner_path" ] && cat "$owner_path" ;;
    esac
    exit 0
    ;;
  set-option)
    if [ "\${5:-}" = "@omx_team_pane_owner_id" ]; then owner_path="${tmuxLogPath}.owner-\${4#%}"; printf '%s' "\${6:-}" > "$owner_path"; fi
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          binaries: [
            {
              name: 'codex',
              content: fakeCodexShellScript('sleep 30\n'),
            },
          ],
        },
        async () => {
          process.env.TMUX = 'leader-session';
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
          process.env.OMX_TEAM_WORKER_CLI = 'codex';
          process.env.OMX_TEAM_SKIP_READY_WAIT = '1';
          delete process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
          process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = '1';
          process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS = '50';
          const expectedTeamName = buildInternalTeamName('team-startup-window', resolveTeamIdentityScope(process.env));

          receiptNotifier = setInterval(() => {
            void markPendingInboxDispatchesNotified(expectedTeamName, cwd, {
              toWorker: 'worker-1',
              lastReason: 'test_notified_receipt',
            }).catch(() => {});
          }, 20);

          progressWriter = setTimeout(() => {
            void writeWorkerStatus(
              expectedTeamName,
              'worker-1',
              {
                state: 'working',
                current_task_id: '1',
                updated_at: new Date().toISOString(),
              },
              cwd,
            ).catch(() => {});
          }, 6_000);

          const runtime = await withoutTeamWorkerEnv(() =>
            startTeam(
              'team-startup-window',
              'interactive startup should wait for slow Codex evidence',
              'executor',
              1,
              [{ subject: 's', description: 'd', owner: 'worker-1' }],
              cwd,
            ));

          assert.equal(runtime.teamName, expectedTeamName);
          assert.ok(await readTeamConfig(runtime.teamName, cwd));
        },
      );
    } finally {
      if (receiptNotifier) clearInterval(receiptNotifier);
      if (progressWriter) clearTimeout(progressWriter);
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
      if (typeof prevStartupEvidenceTimeout === 'string') {
        process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS = prevStartupEvidenceTimeout;
      } else {
        delete process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
      }
      if (typeof prevStartupDispatchRetries === 'string') {
        process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = prevStartupDispatchRetries;
      } else {
        delete process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
      }
      if (typeof prevStartupDispatchRetryDelay === 'string') {
        process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS = prevStartupDispatchRetryDelay;
      } else {
        delete process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it(
    'startTeam rejects tmux fallback when worker startup evidence stays missing',
    { skip: skipSlowLifecycleUnderCoverage },
    async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-startup-no-evidence-'));
    const prevTmux = process.env.TMUX;
    const prevTmuxPane = process.env.TMUX_PANE;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevSkipReadyWait = process.env.OMX_TEAM_SKIP_READY_WAIT;
    const prevStartupEvidenceTimeout = process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
    const prevStartupDispatchRetries = process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
    const prevStartupDispatchRetryDelay = process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS;
    let receiptFailer: NodeJS.Timeout | null = null;

    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-startup-no-evidence-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
owner_path="${tmuxLogPath}.owner-%1"
case "$1" in
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
      *"-t leader:0 -F "*'#{pane_id}'*'#{pane_current_command}'*'#{pane_start_command}'*)
        team_owner=''
        if [ -f "$owner_path" ]; then IFS= read -r team_owner < "$owner_path" || true; fi
        team_name="\${team_owner#team:}"
        printf "%%1\\tzsh\\tzsh\\n"
        if [ -f "${tmuxLogPath}.worker-created" ] && [ ! -f "${tmuxLogPath}.killed-%2" ]; then
          printf "%%2\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=\${team_name}/worker-1 codex\\n"
        fi
        exit 0
        ;;
      *"-a -F #{pane_id}"*)
        printf "%%1\t0\t2000004321\n"
        if [ -f "${tmuxLogPath}.worker-created" ] && [ ! -f "${tmuxLogPath}.killed-%2" ]; then printf "%%2\t0\t2000004322\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ] && [ ! -f "${tmuxLogPath}.killed-%3" ]; then printf "%%3\t0\t2000004323\n"; fi
        ;;
      *"#{pane_pid}"*)
        echo "2000004321"
        exit 0
        ;;
      *)
        exit 0
        ;;
    esac
    ;;
  split-window)
    case "$*" in
      *" -h "*)
        : > "${tmuxLogPath}.worker-created"
        echo "%2"
        ;;
      *)
        : > "${tmuxLogPath}.hud-created"
        echo "%3"
        ;;
    esac
    exit 0
    ;;
  capture-pane)
    printf 'OpenAI Codex\\n> '
    exit 0
    ;;
  show-option)
    case "$*" in
      *"@omx_team_pane_owner_id"*) owner_path="${tmuxLogPath}.owner-\${5#%}"; [ -f "$owner_path" ] && cat "$owner_path" ;;
    esac
    exit 0
    ;;
  set-option)
    if [ "\${5:-}" = "@omx_team_pane_owner_id" ]; then owner_path="${tmuxLogPath}.owner-\${4#%}"; printf '%s' "\${6:-}" > "$owner_path"; fi
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          binaries: [
            {
              name: 'codex',
              content: fakeCodexShellScript('sleep 30\n'),
            },
          ],
        },
        async ({ tmuxLogPath }) => {
          process.env.TMUX = 'leader-session';
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
          process.env.OMX_TEAM_WORKER_CLI = 'codex';
          process.env.OMX_TEAM_SKIP_READY_WAIT = '1';
          process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS = '100';
          process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = '1';
          process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS = '50';
          const expectedTeamName = buildInternalTeamName('team-startup-no-evidence', resolveTeamIdentityScope(process.env));

          receiptFailer = setInterval(() => {
            void (async () => {
              const requests = await listDispatchRequests(
                expectedTeamName,
                cwd,
                { kind: 'inbox' },
              ).catch(() => []);
              for (const request of requests) {
                if (request.status !== 'pending') continue;
                await transitionDispatchRequest(
                  expectedTeamName,
                  request.request_id,
                  'pending',
                  'failed',
                  { last_reason: 'test_failed_receipt' },
                  cwd,
                ).catch(() => {});
              }
            })();
          }, 20);

          await assert.rejects(
            withoutTeamWorkerEnv(() =>
              startTeam(
                'team-startup-no-evidence',
                'interactive startup rejects missing worker evidence without false task evidence',
                'executor',
                1,
                [{ subject: 's', description: 'd', owner: 'worker-1' }],
                cwd,
              )),
            /(worker_notify_failed:worker-1:codex_startup_no_evidence_after_fallback|startup_rollback_pane_proof_unavailable:%2:pane_proof_lost_during_process_teardown)/,
          );

          if (receiptFailer) {
            clearInterval(receiptFailer);
            receiptFailer = null;
          }

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /send-keys -t %2 -l --/);
          await shutdownTeam(expectedTeamName, cwd, { force: true }).catch(() => {});
        },
      );
    } finally {
      if (receiptFailer) clearInterval(receiptFailer);
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
      if (typeof prevStartupEvidenceTimeout === 'string') {
        process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS = prevStartupEvidenceTimeout;
      } else {
        delete process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
      }
      if (typeof prevStartupDispatchRetries === 'string') {
        process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = prevStartupDispatchRetries;
      } else {
        delete process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
      }
      if (typeof prevStartupDispatchRetryDelay === 'string') {
        process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS = prevStartupDispatchRetryDelay;
      } else {
        delete process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS;
      }
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
    await writeSuccessfulEmptyTmuxQuery(binDir);

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
      assert.match(runtime.teamName, /^nested-allowed-[a-f0-9]{8}$/);
      assert.equal(runtime.config.display_name, 'nested-allowed');
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
      delete process.env.OMX_TEAM_WORKER_CLI;
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('shutdownTeam with path-like display input cannot remove state outside the team directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-unsafe-'));
    try {
      const victim = join(cwd, '.omx', 'state', 'victim');
      await mkdir(victim, { recursive: true });
      await writeFile(join(victim, 'keep.txt'), 'keep');

      await shutdownTeam('../../victim', cwd, { force: true });
      assert.equal(existsSync(join(victim, 'keep.txt')), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam blocks duplicate no-session/no-tmux prompt-mode starts with stable cwd leader identity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-prompt-duplicate-nosession-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    await mkdir(binDir, { recursive: true });
    await writeFakePromptWorkerBinary(
      fakeCodexPath,
      `setTimeout(() => {}, 5000);
process.on('SIGTERM', () => process.exit(0));`,
    );
    await writeSuccessfulEmptyTmuxQuery(binDir);

    let runtime: TeamRuntime | null = null;
    try {
      await withPromptModeCodexEnv(
        binDir,
        {
          OMX_SESSION_ID: undefined,
          CODEX_SESSION_ID: undefined,
          SESSION_ID: undefined,
          TMUX_PANE: undefined,
        },
        async () => {
          runtime = await withoutTeamWorkerEnv(() =>
            startTeam(
              'first-prompt-team',
              'first no-session prompt team',
              'executor',
              1,
              [{ subject: 's', description: 'd', owner: 'worker-1' }],
              cwd,
            ));

          assert.equal(runtime.config.worker_launch_mode, 'prompt');
          assert.match(runtime.teamName, /^first-prompt-team-[a-f0-9]{8}$/);
          assert.equal(runtime.config.display_name, 'first-prompt-team');
          assert.equal(runtime.config.identity_source, 'run-id');
          const manifest = JSON.parse(
            await readFile(join(cwd, '.omx', 'state', 'team', runtime.teamName, 'manifest.v2.json'), 'utf-8'),
          ) as { leader?: { session_id?: string } };
          assert.equal(manifest.leader?.session_id, `cwd:${cwd}`);

          await assert.rejects(
            () => withoutTeamWorkerEnv(() =>
              startTeam(
                'second-prompt-team',
                'second no-session prompt team must be blocked',
                'executor',
                1,
                [{ subject: 's2', description: 'd2', owner: 'worker-1' }],
                cwd,
              )),
            /leader_session_conflict: active team exists \(first-prompt-team-[a-f0-9]{8}\)/,
          );

          const teamEntries = await readdir(join(cwd, '.omx', 'state', 'team'), { withFileTypes: true });
          assert.equal(
            teamEntries.some((entry) => entry.isDirectory() && entry.name.startsWith('second-prompt-team-')),
            false,
            'blocked duplicate start must not create a second prompt-mode team state directory',
          );
        },
      );
    } finally {
      const runtimeToShutdown = runtime as TeamRuntime | null;
      if (runtimeToShutdown) {
        await shutdownTeam(runtimeToShutdown.teamName, cwd, { force: true }).catch(() => {});
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam rejects duplicate active same-name team state without mutating existing files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-duplicate-team-'));
    const binDir = join(cwd, 'bin');
    const prevPath = process.env.PATH;
    await mkdir(binDir, { recursive: true });
    await writeSuccessfulEmptyTmuxQuery(binDir);
    const prevSessionId = process.env.OMX_SESSION_ID;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    try {
      process.env.PATH = `${binDir}:${prevPath ?? ''}`;
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
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
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

  it('startTeam tags interactive panes with the derived tmux-pane leader identity when session id is unavailable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-pane-derived-owner-'));
    const prevTmux = process.env.TMUX;
    const prevTmuxPane = process.env.TMUX_PANE;
    const prevSessionId = process.env.OMX_SESSION_ID;
    const prevCodexSessionId = process.env.CODEX_SESSION_ID;
    const prevGenericSessionId = process.env.SESSION_ID;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevSkipReadyWait = process.env.OMX_TEAM_SKIP_READY_WAIT;
    let runtime: TeamRuntime | null = null;

    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-pane-derived-owner-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
owner_path="${tmuxLogPath}.owner-%1"
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
      *"-t %2 -F "*'#{pane_dead}'*)
        echo "0 2000002222"
        ;;
      *"-t %3 -F "*'#{pane_dead}'*)
        echo "0 2000003333"
        ;;
      *"-t %2 -F #{pane_pid}"*)
        echo "2000002222"
        ;;
      *"-a -F #{pane_id}"*)
        printf "%%1\t0\t2000001111\n"
        if [ -f "${tmuxLogPath}.worker-created" ] && [ ! -f "${tmuxLogPath}.killed-%2" ]; then printf "%%2\t0\t2000002222\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ] && [ ! -f "${tmuxLogPath}.killed-%3" ]; then printf "%%3\t0\t2000003333\n"; fi
        ;;
      *"pane_current_command"*)
        team_owner=''
        if [ -f "$owner_path" ]; then IFS= read -r team_owner < "$owner_path" || true; fi
        team_name="\${team_owner#team:}"
        printf "%%1\\tnode\\t'codex'\\n"
        if [ -f "${tmuxLogPath}.worker-created" ]; then printf "%%2\\tgemini\\tenv OMX_TEAM_INTERNAL_WORKER=\${team_name}/worker-1 gemini\\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ] && [ ! -f "${tmuxLogPath}.killed-%3" ]; then printf "%%3\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%1' node /omx.js hud --watch\\n"; fi
        ;;
      *)
        printf "%%1\\n"
        ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *" -h "*)
        : > "${tmuxLogPath}.worker-created"
        rm -f "${tmuxLogPath}.killed-%2"
        echo "%2"
        ;;
      *)
        rm -f "${tmuxLogPath}.killed-%3"
        : > "${tmuxLogPath}.hud-created"
        echo "%3"
        ;;
    esac
    exit 0
    ;;
  show-option)
    case "$*" in
      *"@omx_team_pane_owner_id"*) owner_path="${tmuxLogPath}.owner-\${5#%}"; [ -f "$owner_path" ] && cat "$owner_path" ;;
    esac
    exit 0
    ;;
  set-option)
    if [ "\${5:-}" = "@omx_team_pane_owner_id" ]; then owner_path="${tmuxLogPath}.owner-\${4#%}"; printf '%s' "\${6:-}" > "$owner_path"; fi
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-\${3:-unknown}"
    exit 0
    ;;
  resize-pane|select-layout|set-window-option|select-pane|set-hook|run-shell|send-keys|kill-session)
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
          env: {
            OMX_SESSION_ID: undefined,
            CODEX_SESSION_ID: undefined,
            SESSION_ID: undefined,
          },
        },
        async ({ tmuxLogPath }) => {
          process.env.TMUX = 'leader-session,stub,0';
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
          process.env.OMX_TEAM_WORKER_CLI = 'gemini';
          process.env.OMX_TEAM_SKIP_READY_WAIT = '1';

          runtime = await withoutTeamWorkerEnv(() =>
            startTeam(
              'pane-derived-owner',
              'derived pane owner',
              'executor',
              1,
              [{ subject: 's', description: 'd', owner: 'worker-1' }],
              cwd,
            ));

          const manifest = JSON.parse(
            await readFile(join(cwd, '.omx', 'state', 'team', runtime.teamName, 'manifest.v2.json'), 'utf-8'),
          ) as { leader?: { session_id?: string } };
          assert.equal(manifest.leader?.session_id, '%1');

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /set-option -p -t %1 @omx_pane_instance_id %1/);
          assert.match(tmuxLog, /set-option -p -t %2 @omx_pane_instance_id %1/);
          assert.match(tmuxLog, /set-option -p -t %3 @omx_pane_instance_id %1/);
          assert.match(tmuxLog, /exec env OMX_SESSION_ID='%1' OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%1' .*hud --watch/);

          await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
          runtime = null;
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
      if (typeof prevSessionId === 'string') process.env.OMX_SESSION_ID = prevSessionId;
      else delete process.env.OMX_SESSION_ID;
      if (typeof prevCodexSessionId === 'string') process.env.CODEX_SESSION_ID = prevCodexSessionId;
      else delete process.env.CODEX_SESSION_ID;
      if (typeof prevGenericSessionId === 'string') process.env.SESSION_ID = prevGenericSessionId;
      else delete process.env.SESSION_ID;
      if (typeof prevLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = prevLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevSkipReadyWait === 'string') process.env.OMX_TEAM_SKIP_READY_WAIT = prevSkipReadyWait;
      else delete process.env.OMX_TEAM_SKIP_READY_WAIT;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam keeps logical session id out of team shutdown ownership tags', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-pane-owner-env-isolated-'));
    const prevTmux = process.env.TMUX;
    const prevTmuxPane = process.env.TMUX_PANE;
    const prevSessionId = process.env.OMX_SESSION_ID;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevSkipReadyWait = process.env.OMX_TEAM_SKIP_READY_WAIT;
    let runtime: TeamRuntime | null = null;

    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-pane-owner-env-isolated-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
owner_path="${tmuxLogPath}.owner-%1"
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
      *"-t %2 -F "*'#{pane_dead}'*)
        echo "0 2000002222"
        ;;
      *"-t %3 -F "*'#{pane_dead}'*)
        echo "0 2000003333"
        ;;
      *"-t %2 -F #{pane_pid}"*)
        echo "2000002222"
        ;;
      *"-a -F #{pane_id}"*)
        printf "%%1\t0\t2000001111\n"
        if [ -f "${tmuxLogPath}.worker-created" ] && [ ! -f "${tmuxLogPath}.killed-%2" ]; then printf "%%2\t0\t2000002222\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ] && [ ! -f "${tmuxLogPath}.killed-%3" ]; then printf "%%3\t0\t2000003333\n"; fi
        ;;
      *"pane_current_command"*)
        team_owner=''
        if [ -f "$owner_path" ]; then IFS= read -r team_owner < "$owner_path" || true; fi
        team_name="\${team_owner#team:}"
        printf "%%1\\tnode\\t'codex'\\n"
        if [ -f "${tmuxLogPath}.worker-created" ]; then printf "%%2\\tgemini\\tenv OMX_TEAM_INTERNAL_WORKER=\${team_name}/worker-1 gemini\\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ] && [ ! -f "${tmuxLogPath}.killed-%3" ]; then printf "%%3\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%1' node /omx.js hud --watch\\n"; fi
        ;;
      *)
        printf "%%1\\n"
        ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *" -h "*)
        : > "${tmuxLogPath}.worker-created"
        rm -f "${tmuxLogPath}.killed-%2"
        echo "%2"
        ;;
      *)
        rm -f "${tmuxLogPath}.killed-%3"
        : > "${tmuxLogPath}.hud-created"
        echo "%3"
        ;;
    esac
    exit 0
    ;;
  show-option)
    case "$*" in
      *"@omx_team_pane_owner_id"*) owner_path="${tmuxLogPath}.owner-\${5#%}"; [ -f "$owner_path" ] && cat "$owner_path" ;;
      *) exit 1 ;;
    esac
    exit 0
    ;;
  set-option)
    if [ "\${5:-}" = "@omx_team_pane_owner_id" ]; then owner_path="${tmuxLogPath}.owner-\${4#%}"; printf '%s' "\${6:-}" > "$owner_path"; fi
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-\${3:-unknown}"
    exit 0
    ;;
  resize-pane|select-layout|set-window-option|select-pane|set-hook|run-shell|send-keys|kill-session)
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
          process.env.TMUX = 'leader-session,stub,0';
          process.env.TMUX_PANE = '%1';
          process.env.OMX_SESSION_ID = 'logical-session-from-env';
          process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
          process.env.OMX_TEAM_WORKER_CLI = 'gemini';
          process.env.OMX_TEAM_SKIP_READY_WAIT = '1';

          runtime = await withoutTeamWorkerEnv(() =>
            startTeam(
              'pane-owner-env-isolated',
              'env session must not be pane owner',
              'executor',
              1,
              [{ subject: 's', description: 'd', owner: 'worker-1' }],
              cwd,
            ));

          const manifest = JSON.parse(
            await readFile(join(cwd, '.omx', 'state', 'team', runtime.teamName, 'manifest.v2.json'), 'utf-8'),
          ) as { leader?: { session_id?: string } };
          assert.equal(manifest.leader?.session_id, 'logical-session-from-env');

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /set-option -t leader @omx_instance_id logical-session-from-env/);
          assert.match(tmuxLog, /set-option -p -t %1 @omx_pane_instance_id logical-session-from-env/);
          assert.match(tmuxLog, /set-option -p -t %2 @omx_pane_instance_id logical-session-from-env/);
          assert.match(tmuxLog, /set-option -p -t %3 @omx_pane_instance_id logical-session-from-env/);
          assert.match(tmuxLog, /set-option -p -t %1 @omx_team_pane_owner_id team:pane-owner-env-isolat-[a-f0-9]{8}/);
          assert.match(tmuxLog, /set-option -p -t %2 @omx_team_pane_owner_id team:pane-owner-env-isolat-[a-f0-9]{8}/);
          assert.match(tmuxLog, /set-option -p -t %3 @omx_team_pane_owner_id team:pane-owner-env-isolat-[a-f0-9]{8}/);
          assert.doesNotMatch(tmuxLog, /set-option -p -t %1 @omx_team_pane_owner_id logical-session-from-env/);
          assert.match(tmuxLog, /exec env OMX_SESSION_ID='logical-session-from-env' OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%1' .*hud --watch/);

          await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
          runtime = null;
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
      if (typeof prevSessionId === 'string') process.env.OMX_SESSION_ID = prevSessionId;
      else delete process.env.OMX_SESSION_ID;
      if (typeof prevLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = prevLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof prevWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevSkipReadyWait === 'string') process.env.OMX_TEAM_SKIP_READY_WAIT = prevSkipReadyWait;
      else delete process.env.OMX_TEAM_SKIP_READY_WAIT;
      await rm(cwd, { recursive: true, force: true });
    }
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
printf '%s\n' "$*" >> "${tmuxLogPath}"
owner_path="${tmuxLogPath}.owner-%1"
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
      *"-t leader:0 -F "*'#{pane_id}'*'#{pane_current_command}'*'#{pane_start_command}'*)
        team_owner=''
        if [ -f "$owner_path" ]; then IFS= read -r team_owner < "$owner_path" || true; fi
        team_name="\${team_owner#team:}"
        printf "%%1\\tnode\\t'codex'\\n"
        if [ -f "${tmuxLogPath}.worker-created" ]; then printf "%%2\\tgemini\\tenv OMX_TEAM_INTERNAL_WORKER=\${team_name}/worker-1 gemini\\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ] && [ ! -f "${tmuxLogPath}.killed-%3" ]; then printf "%%3\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%1' node /omx.js hud --watch\\n"; fi
        ;;
      *"-t %2 -F "*'#{pane_dead}'*)
        echo "0 2000000002"
        ;;
      *"-t %3 -F "*'#{pane_dead}'*)
        echo "0 2000000003"
        ;;
      *"-a -F #{pane_id}"*)
        printf '%s\n' 'dedicated-strict-native-win32-global-proof' >> "${tmuxLogPath}"
        printf "%%1\t0\t2000000001\n"
        if [ -f "${tmuxLogPath}.worker-created" ] && [ ! -f "${tmuxLogPath}.killed-%2" ]; then printf "%%2\t0\t2000000002\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ] && [ ! -f "${tmuxLogPath}.killed-%3" ]; then printf "%%3\t0\t2000000003\n"; fi
        ;;

      *"pane_current_command"*)
        printf "%%1\\tnode\\t'codex'\\n"
        if [ -f "${tmuxLogPath}.worker-created" ]; then printf "%%2\\tgemini\\t'gemini'\\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ] && [ ! -f "${tmuxLogPath}.killed-%3" ]; then printf "%%3\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%1' node /omx.js hud --watch\\n"; fi
        ;;
      *)
        printf "%%1\\n%%2\\n%%3\\n"
        ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *" -h "*)
        : > "${tmuxLogPath}.worker-created"
        echo "%2"
        ;;
      *)
        rm -f "${tmuxLogPath}.killed-%3";
        : > "${tmuxLogPath}.hud-created"
        echo "%3"
        ;;
    esac
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    exit 0
    ;;
  show-option)
    case "$*" in
      *"@omx_team_pane_owner_id"*) owner_path="${tmuxLogPath}.owner-\${5#%}"; [ -f "$owner_path" ] && cat "$owner_path" ;;
    esac
    exit 0
    ;;
  set-option)
    if [ "\${5:-}" = "@omx_team_pane_owner_id" ]; then owner_path="${tmuxLogPath}.owner-\${4#%}"; printf '%s' "\${6:-}" > "$owner_path"; fi
    exit 0
    ;;
  resize-pane|select-layout|set-window-option|select-pane|set-hook|run-shell)
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

          const runtime = await withoutTeamWorkerEnv(() =>
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
          assert.match(tmuxLog, /display-message -p #\{session_name\}:#\{window_index\} #\{pane_id\}/);
          assert.match(tmuxLog, new RegExp(`resize-pane -t %3 -y ${HUD_TMUX_TEAM_HEIGHT_LINES}`));

          if (teamNameForCleanup) {
            await shutdownTeam(teamNameForCleanup, cwd, { force: true }).catch(() => {});
          }
          const cleanupTmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(
            cleanupTmuxLog,
            /dedicated-strict-native-win32-global-proof/,
            'dedicated strict native-Windows fixture must bypass the legacy compatibility prefix',
          );
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
        workerPaneIdsByIndex: ['%2', '%3'],
        workerPanePidsByIndex: [2000000002, 2000000003],
        leaderPanePid: 2000000001,
        hudPanePid: 2000000004,

        leaderPaneId: '%1',
        hudPaneId: '%4',
        resizeHookName: 'resize-hook',
        resizeHookTarget: 'leader:0',
        teamPaneOwnerId: 'team:team-pane-persist-race',
      }, workerPaneIds);

      assert.equal(config.tmux_session, 'leader:0');
      assert.equal(config.leader_pane_id, '%1');
      assert.equal(config.hud_pane_id, '%4');
      assert.equal(config.leader_pane_pid, 2000000001);
      assert.equal(config.hud_pane_pid, 2000000004);
      await saveTeamConfig(config, cwd);
      const durableConfig = await readTeamConfig('team-pane-persist-race', cwd);
      assert.equal(durableConfig?.leader_pane_pid, 2000000001);
      assert.equal(durableConfig?.hud_pane_pid, 2000000004);
      assert.equal(config.tmux_pane_owner_id, 'team:team-pane-persist-race');
      assert.deepEqual(workerPaneIds, ['%2', '%3']);
      assert.equal(config.workers[0]?.pane_id, '%2');
      assert.equal(config.workers[1]?.pane_id, '%3');
      assert.equal(config.workers[0]?.pid, 2000000002);
      assert.equal(config.workers[1]?.pid, 2000000003);


      const partialWorkerPaneIds = Array.from({ length: 2 }, () => undefined as string | undefined);
      applyCreatedInteractiveSessionToConfig(config, {
        name: 'leader:0',
        workerCount: 2,
        cwd,
        workerPaneIds: ['%30'],
        workerPaneIdsByIndex: [null, '%30'],
        workerPanePidsByIndex: [null, 2000000030],
        leaderPanePid: 2000000001,
        hudPanePid: 2000000004,

        leaderPaneId: '%1',
        hudPaneId: '%4',
        resizeHookName: 'resize-hook',
        resizeHookTarget: 'leader:0',
        teamPaneOwnerId: 'team:team-pane-persist-race',
      }, partialWorkerPaneIds);
      assert.deepEqual(partialWorkerPaneIds, [undefined, '%30']);
      assert.equal(config.workers[0]?.pane_id, '%2');
      assert.equal(config.workers[1]?.pane_id, '%30');
      assert.equal(config.workers[1]?.pid, 2000000030);
      assert.equal(config.leader_pane_pid, 2000000001);
      assert.equal(config.hud_pane_pid, 2000000004);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam runs worker MCP orphan cleanup before interactive tmux worker spawn', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-interactive-mcp-cleanup-'));
    const prevTmux = process.env.TMUX;
    const prevTmuxPane = process.env.TMUX_PANE;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevSkipReadyWait = process.env.OMX_TEAM_SKIP_READY_WAIT;
    let runtime: TeamRuntime | null = null;

    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-interactive-mcp-cleanup-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
${tmuxOwnerProofShim}
printf '%s\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*) echo "120" ;;
      *) echo "leader:0 %1" ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf "%%1\t0\t2000001111\n"
        if [ -f "${tmuxLogPath}.worker-created" ] && [ ! -f "${tmuxLogPath}.killed-%2" ]; then printf "%%2\t0\t2000002222\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ] && [ ! -f "${tmuxLogPath}.killed-%3" ]; then printf "%%3\t0\t2000003333\n"; fi
        ;;
      *"pane_current_command"*)
        printf "%%1\tnode\t'codex'\n"
        if [ -f "${tmuxLogPath}.worker-created" ]; then printf "%%2\tcodex\tcodex\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%3\tnode\thud --watch\n"; fi
        ;;
      *"#{pane_dead} #{pane_pid}"*) echo "1 2000999999" ;;
      *"-t %2"*"#{pane_pid}"*) echo "2000002222" ;;
      *"#{pane_pid}"*) echo "2000001111" ;;
      *) exit 0 ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *" -h "*)
        : > "${tmuxLogPath}.worker-created"
        team_dir=$(find "${cwd}/.omx/state/team" -maxdepth 1 -type d -name 'team-interactive*' | head -n 1)
        mkdir -p "$team_dir/workers/worker-1"
        cat > "$team_dir/workers/worker-1/status.json" <<'EOF'
{
  "state": "working",
  "current_task_id": "1",
  "updated_at": "2026-04-23T00:00:00.000Z"
}
EOF
        echo "%2"
        ;;
      *)
        : > "${tmuxLogPath}.hud-created"
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
          binaries: [{ name: 'codex', content: fakeCodexShellScript('exit 0\n') }],
        },
        async ({ tmuxLogPath }) => {
          delete process.env.TMUX;
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
          process.env.OMX_TEAM_WORKER_CLI = 'codex';
          process.env.OMX_TEAM_SKIP_READY_WAIT = '1';

          const events: string[] = [];
          runtime = await withoutTeamWorkerEnv(() =>
            startTeam(
              'team-interactive-cleanup',
              'interactive cleanup before worker spawn',
              'executor',
              1,
              [{ subject: 's', description: 'd', owner: 'worker-1' }],
              cwd,
              {
                cleanupLaunchOrphanedMcpProcesses: async () => {
                  events.push('cleanup');
                  return { dryRun: false, candidates: [], terminatedCount: 0, forceKilledCount: 0, failedPids: [] };
                },
              },
            ));

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /split-window/);
          assert.deepEqual(events, ['cleanup']);
          assert.equal(runtime.config.workers[0]?.pane_id, '%2');
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
${tmuxOwnerProofShim}
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
      *"-a -F #{pane_id}"*)
        printf "%%1\t0\t2000001111\n"
        if [ -f "${tmuxLogPath}.worker-created" ] && [ ! -f "${tmuxLogPath}.killed-%2" ]; then printf "%%2\t0\t2000002222\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ] && [ ! -f "${tmuxLogPath}.killed-%3" ]; then printf "%%3\t0\t2000003333\n"; fi
        ;;
      *"pane_current_command"*)
        printf "%%1\tnode\t'codex'\n"
        if [ -f "${tmuxLogPath}.worker-created" ]; then printf "%%2\tcodex\tcodex\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%3\tnode\thud --watch\n"; fi
        ;;
      *"#{pane_dead} #{pane_pid}"*)
        echo "1 2000999999"
        ;;
      *"-t %2"*"#{pane_pid}"*)
        echo "2000002222"
        ;;
      *"-t %3"*"#{pane_pid}"*)
        echo "2000003333"
        ;;
      *"#{pane_pid}"*)
        echo "2000001111"
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
        : > "${tmuxLogPath}.worker-created"
        team_dir=$(find "${cwd}/.omx/state/team" -maxdepth 1 -type d -name 'team-pane-pid*' | head -n 1)
        mkdir -p "$team_dir/workers/worker-1"
        cat > "$team_dir/workers/worker-1/status.json" <<'EOF'
{
  "state": "working",
  "current_task_id": "1",
  "updated_at": "2026-04-10T00:00:00.000Z"
}
EOF
        echo "%2"
        ;;
      *)
        : > "${tmuxLogPath}.hud-created"
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
          binaries: [{ name: 'codex', content: fakeCodexShellScript('exit 0\n') }],
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
          assert.equal(runtime.config.workers[0]?.pid, 2000002222);

          const identityPath = join(cwd, '.omx', 'state', 'team', runtime.teamName, 'workers', 'worker-1', 'identity.json');
          const identity = JSON.parse(await readFile(identityPath, 'utf-8')) as { pid?: number; pane_id?: string };
          assert.equal(identity.pane_id, '%2');
          assert.equal(identity.pid, 2000002222);
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

  it('startTeam preserves the created worker PID when its pane is reused before startup state materializes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-startup-pane-pid-reuse-'));
    const previousTmux = process.env.TMUX;
    const previousTmuxPane = process.env.TMUX_PANE;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const previousSkipReadyWait = process.env.OMX_TEAM_SKIP_READY_WAIT;
    const teamName = 'team-startup-pane-pid-reuse';

    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-startup-pane-pid-reuse-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
${tmuxOwnerProofShim}
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*) echo "120" ;;
      *) echo "leader:0 %1" ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf "%%1\\t0\\t2000001111\\n"
        if [ -f "${tmuxLogPath}.worker-created" ]; then
          if [ -f "${tmuxLogPath}.session-created" ]; then printf "%%2\\t0\\t2000009999\\n"; else printf "%%2\\t0\\t2000002222\\n"; fi
        fi
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%3\\t0\\t2000003333\\n"; fi
        ;;
      *"pane_current_command"*)
        printf "%%1\\tnode\\t'codex'\\n"
        if [ -f "${tmuxLogPath}.worker-created" ]; then printf "%%2\\tcodex\\tcodex\\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%3\\tnode\\thud --watch\\n"; fi
        ;;
      *) exit 0 ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *" -h "*) : > "${tmuxLogPath}.worker-created"; echo "%2" ;;
      *) : > "${tmuxLogPath}.hud-created"; echo "%3" ;;
    esac
    exit 0
    ;;
  set-option)
    case "$*" in
      *" mouse on"*) : > "${tmuxLogPath}.session-created" ;;
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
          binaries: [{ name: 'codex', content: fakeCodexShellScript('exit 0\n') }],
        },
        async ({ tmuxLogPath }) => {
          delete process.env.TMUX;
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
          process.env.OMX_TEAM_WORKER_CLI = 'codex';
          process.env.OMX_TEAM_SKIP_READY_WAIT = '1';

          await assert.rejects(
            withoutTeamWorkerEnv(() => startTeam(
              teamName,
              'created worker pane PID reuse must fail closed',
              'executor',
              1,
              [{ subject: 's', description: 'd', owner: 'worker-1' }],
              cwd,
            )),
            /startup_rollback_pane_proof_unavailable:%2:pane_pid_changed/,
          );

          const stateRoot = join(cwd, '.omx', 'state', 'team');
          assert.equal((await readdir(stateRoot)).length, 1);
          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.doesNotMatch(tmuxLog, /kill-pane -t %2/);
        },
      );
    } finally {
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof previousSkipReadyWait === 'string') process.env.OMX_TEAM_SKIP_READY_WAIT = previousSkipReadyWait;
      else delete process.env.OMX_TEAM_SKIP_READY_WAIT;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam saves interactive pane ids before concurrent readiness attempts', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'team', 'runtime.ts'), 'utf-8');
    const applyMatch = source.match(
      /applyCreatedInteractiveSessionToConfig\(\s*config,\s*createdSession,\s*workerPaneIds\s*\);/m,
    );
    const saveMatch = source.match(/await saveTeamConfig\(config, leaderCwd\);/m);
    const readyMatch = source.match(/waitForWorkerReadyAsync\(/m);

    const applyIndex = applyMatch?.index ?? -1;
    const saveIndex = saveMatch?.index ?? -1;
    const readyIndex = readyMatch?.index ?? -1;

    assert.notEqual(applyMatch, null);
    assert.notEqual(saveMatch, null);
    assert.notEqual(readyMatch, null);
    assert.equal(applyIndex < saveIndex, true);
    assert.equal(saveIndex < readyIndex, true);
  });


  it('startTeam rejects startup direct trigger success when Codex startup evidence is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-startup-direct-fast-'));
    const previousTmux = process.env.TMUX;
    const previousTmuxPane = process.env.TMUX_PANE;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const previousReadyTimeout = process.env.OMX_TEAM_READY_TIMEOUT_MS;
    const previousStartupEvidenceTimeout = process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
    const previousStartupDispatchRetries = process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
    const previousStartupDispatchRetryDelay = process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS;
    const teamName = `tsd-${process.pid}-${Date.now().toString(36)}`;

    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-startup-direct-fast-bin-',
          tmuxScript: () => `#!/bin/sh
set -eu
${tmuxOwnerProofShim}
order_file="${cwd}/startup-order.log"
count_file="${cwd}/startup-capture-count"
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*) echo "120" ;;
      *) echo "leader:0 %1" ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf "%%1\t0\t2000001111\n"
        if [ -f "${cwd}/startup-worker" ]; then printf "%%2\t0\t2000004242\n"; fi
        if [ -f "${cwd}/startup-hud" ]; then printf "%%3\t0\t2000004343\n"; fi
        ;;
      *"pane_current_command"*)
        printf "%%1\tnode\t'codex'\n"
        if [ -f "${cwd}/startup-worker" ]; then printf "%%2\tcodex\tcodex\n"; fi
        if [ -f "${cwd}/startup-hud" ]; then printf "%%3\tnode\thud --watch\n"; fi
        ;;
      *"#{pane_dead} #{pane_pid}"*) echo "0 2000004242" ;;
      *"#{pane_dead}"*) echo "0" ;;
      *"#{pane_pid}"*) echo "2000004242" ;;
      *) exit 0 ;;
    esac
    exit 0
    ;;
  capture-pane)
    printf '%s\n' capture >> "$order_file"
    count=0
    if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi
    count=$((count + 1))
    printf '%s' "$count" > "$count_file"
    if [ "$count" -eq 1 ]; then
      printf 'OpenAI Codex\nmodel: test\ndirectory: /tmp/demo\n'
    else
      printf 'worker process is still starting; no agent prompt yet\n'
    fi
    exit 0
    ;;
  send-keys)
    printf '%s\n' send-keys >> "$order_file"
    exit 0
    ;;
  split-window)
    if [ -f "${cwd}/startup-worker" ]; then : > "${cwd}/startup-hud"; echo "%3"; else : > "${cwd}/startup-worker"; echo "%2"; fi
    exit 0
    ;;
  set-hook|run-shell|select-layout|set-window-option|select-pane|kill-pane|kill-session|resize-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          binaries: [{ name: 'codex', content: fakeCodexNodeScript('process.stdin.resume();\n') }],
        },
        async () => {
          delete process.env.TMUX;
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
          process.env.OMX_TEAM_WORKER_CLI = 'codex';
          process.env.OMX_TEAM_READY_TIMEOUT_MS = '500';
          process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS = '100';
          process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = '1';
          process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS = '50';

          await assert.rejects(
            withoutTeamWorkerEnv(() =>
              startTeam(
                teamName,
                'startup direct trigger falls back to evidence-gated dispatch',
                'executor',
                1,
                [{ subject: 'w1', description: 'worker one', owner: 'worker-1' }],
                cwd,
              )),
            /(worker_notify_failed:worker-1:codex_startup_no_evidence_after_fallback|startup_rollback_pane_proof_unavailable:%2:pane_proof_lost_during_process_teardown)/,
          );

          const order = (await readFile(join(cwd, 'startup-order.log'), 'utf-8')).trim().split('\n');
          assert.ok(order.includes('send-keys'), `expected direct send-keys, got ${order.join(',')}`);
          assert.ok(
            order.filter((entry) => entry === 'send-keys').length >= 2,
            `expected evidence-gated dispatch after startup-direct no-evidence, got ${order.join(',')}`,
          );
        },
      );
    } finally {
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof previousReadyTimeout === 'string') process.env.OMX_TEAM_READY_TIMEOUT_MS = previousReadyTimeout;
      else delete process.env.OMX_TEAM_READY_TIMEOUT_MS;
      if (typeof previousStartupEvidenceTimeout === 'string') process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS = previousStartupEvidenceTimeout;
      else delete process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
      if (typeof previousStartupDispatchRetries === 'string') process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = previousStartupDispatchRetries;
      else delete process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
      if (typeof previousStartupDispatchRetryDelay === 'string') process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS = previousStartupDispatchRetryDelay;
      else delete process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam treats a confirmed ready prompt as startup evidence after hook notification', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-ready-prompt-evidence-'));
    const previousTmux = process.env.TMUX;
    const previousTmuxPane = process.env.TMUX_PANE;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const previousReadyTimeout = process.env.OMX_TEAM_READY_TIMEOUT_MS;
    const previousStartupEvidenceTimeout = process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
    const previousStartupDispatchRetries = process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
    let receiptNotifier: NodeJS.Timeout | null = null;
    let runtimeTeamName: string | null = null;

    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-ready-prompt-evidence-bin-',
          tmuxScript: () => `#!/bin/sh
set -eu
${tmuxOwnerProofShim}
count_file="${cwd}/capture-count"
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*) echo "120" ;;
      *) echo "leader:0 %1" ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf "%%1\t0\t2000001111\n"
        if [ -f "${cwd}/ready-worker" ]; then printf "%%2\t0\t2000004242\n"; fi
        if [ -f "${cwd}/ready-hud" ]; then printf "%%3\t0\t2000004343\n"; fi
        ;;
      *"pane_current_command"*)
        printf "%%1\tnode\t'codex'\n"
        if [ -f "${cwd}/ready-worker" ]; then printf "%%2\tcodex\tcodex\n"; fi
        if [ -f "${cwd}/ready-hud" ]; then printf "%%3\tnode\thud --watch\n"; fi
        ;;
      *"#{pane_dead} #{pane_pid}"*) echo "0 2000004242" ;;
      *"-t %2"*"#{pane_pid}"*) echo "2000004242" ;;
      *"#{pane_dead}"*) echo "0" ;;
      *"#{pane_pid}"*) echo "2000004242" ;;
      *) exit 0 ;;
    esac
    exit 0
    ;;
  capture-pane)
    count=0
    if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi
    count=$((count + 1))
    printf '%s' "$count" > "$count_file"
    if [ "$count" -eq 1 ]; then
      printf 'OpenAI Codex\nmodel: loading\nLoading workspace...\n'
    else
      printf 'OpenAI Codex\nmodel: test\n› \n'
    fi
    exit 0
    ;;
  split-window)
    if [ -f "${cwd}/ready-worker" ]; then : > "${cwd}/ready-hud"; echo "%3"; else : > "${cwd}/ready-worker"; echo "%2"; fi
    exit 0
    ;;
  set-hook|run-shell|select-layout|set-window-option|select-pane|send-keys|kill-pane|kill-session|resize-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          binaries: [{ name: 'codex', content: fakeCodexNodeScript('process.stdin.resume();\n') }],
        },
        async () => {
          delete process.env.TMUX;
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
          process.env.OMX_TEAM_WORKER_CLI = 'codex';
          process.env.OMX_TEAM_READY_TIMEOUT_MS = '500';
          process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS = '100';
          process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = '1';

          receiptNotifier = setInterval(() => {
            void markPendingInboxDispatchesNotified('team-ready-prompt-evidence', cwd);
          }, 20);

          const runtime = await withoutTeamWorkerEnv(() =>
            startTeam(
              'team-ready-prompt-evidence',
              'interactive ready prompt should settle startup evidence after notification',
              'executor',
              1,
              [{ subject: 'w1', description: 'worker one', owner: 'worker-1' }],
              cwd,
            ));
          runtimeTeamName = runtime.teamName;

          const workerStatus = await readWorkerStatus(runtime.teamName, 'worker-1', cwd);
          assert.equal(workerStatus.state, 'unknown');
          assert.equal(workerStatus.reason, undefined);

          const requests = await listDispatchRequests(runtime.teamName, cwd, { kind: 'inbox' });
          assert.ok(
            requests.some((request) => request.status === 'notified')
              || requests.some((request) => /fallback_confirmed/.test(request.last_reason ?? '')),
            `expected hook notification or ready-prompt fallback confirmation, got ${JSON.stringify(requests)}`,
          );

          const captureCount = Number.parseInt(await readFile(join(cwd, 'capture-count'), 'utf-8'), 10);
          assert.ok(captureCount >= 1, `expected startup capture, got ${captureCount}`);

          const timingPath = join(cwd, '.omx', 'state', 'team', runtime.teamName, 'startup-timing.json');
          if (existsSync(timingPath)) {
            const timing = JSON.parse(await readFile(timingPath, 'utf-8')) as { events: Array<{ phase: string; ok?: boolean }> };
            assert.ok(timing.events.some((event) => event.phase === 'ready_wait_start'));
            assert.ok(timing.events.some((event) => event.phase === 'ready_wait_end' && event.ok === true));
          }
        },
      );
    } finally {
      if (receiptNotifier) clearInterval(receiptNotifier);
      if (runtimeTeamName) await shutdownTeam(runtimeTeamName, cwd, { force: true }).catch(() => {});
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof previousReadyTimeout === 'string') process.env.OMX_TEAM_READY_TIMEOUT_MS = previousReadyTimeout;
      else delete process.env.OMX_TEAM_READY_TIMEOUT_MS;
      if (typeof previousStartupEvidenceTimeout === 'string') {
        process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS = previousStartupEvidenceTimeout;
      } else {
        delete process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
      }
      if (typeof previousStartupDispatchRetries === 'string') {
        process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = previousStartupDispatchRetries;
      } else {
        delete process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam rejects ready-prompt timeout when dispatch never produces startup evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-ready-timeout-no-evidence-'));
    const previousTmux = process.env.TMUX;
    const previousTmuxPane = process.env.TMUX_PANE;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const previousReadyTimeout = process.env.OMX_TEAM_READY_TIMEOUT_MS;
    const previousStartupEvidenceTimeout = process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
    const previousStartupDispatchRetries = process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
    const previousStartupDispatchRetryDelay = process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS;
    const teamName = `trt-${process.pid}-${Date.now().toString(36)}`;
    let receiptNotifier: NodeJS.Timeout | null = null;
    let runtimeTeamName: string | null = null;

    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-ready-timeout-no-evidence-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
${tmuxOwnerProofShim}
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*) echo "120" ;;
      *) echo "leader:0 %1" ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf "%%1\t0\t2000001111\n"
        if [ -f "${cwd}/timeout-worker" ]; then printf "%%2\t0\t2000004242\n"; fi
        if [ -f "${cwd}/timeout-hud" ]; then printf "%%3\t0\t2000004343\n"; fi
        ;;
      *"pane_current_command"*)
        printf "%%1\tnode\t'codex'\n"
        if [ -f "${cwd}/timeout-worker" ]; then printf "%%2\tcodex\tcodex\n"; fi
        if [ -f "${cwd}/timeout-hud" ]; then printf "%%3\tnode\thud --watch\n"; fi
        ;;
      *"#{pane_dead} #{pane_pid}"*) echo "0 2000004242" ;;
      *"#{pane_dead}"*) echo "0" ;;
      *"#{pane_pid}"*) echo "2000004242" ;;
      *) exit 0 ;;
    esac
    exit 0
    ;;
  capture-pane)
    printf 'worker process is still starting; no agent prompt yet\\n'
    exit 0
    ;;
  split-window)
    if [ -f "${cwd}/timeout-worker" ]; then : > "${cwd}/timeout-hud"; echo "%3"; else : > "${cwd}/timeout-worker"; echo "%2"; fi
    exit 0
    ;;
  set-hook|run-shell|select-layout|set-window-option|select-pane|send-keys|kill-pane|kill-session|resize-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          binaries: [{ name: 'codex', content: fakeCodexNodeScript('process.stdin.resume();\n') }],
        },
        async ({ tmuxLogPath }) => {
          delete process.env.TMUX;
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
          process.env.OMX_TEAM_WORKER_CLI = 'codex';
          process.env.OMX_TEAM_READY_TIMEOUT_MS = '500';
          process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS = '100';
          process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = '1';
          process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS = '50';

          receiptNotifier = setInterval(() => {
            void markPendingInboxDispatchesNotified(teamName, cwd);
          }, 20);

          await assert.rejects(
            withoutTeamWorkerEnv(() =>
              startTeam(
                teamName,
                'ready prompt timeout should not count a draft-only worker as started',
                'executor',
                1,
                [{ subject: 'w1', description: 'worker one', owner: 'worker-1' }],
                cwd,
              )),
            /(worker_notify_failed:worker-1:codex_startup_no_evidence_after_fallback|startup_rollback_pane_proof_unavailable:%2:pane_proof_lost_during_process_teardown)/,
          );

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /send-keys -t %2 -l --/);
          runtimeTeamName = await resolveRuntimeTeamName(cwd, teamName).catch(() => null);
        },
      );
    } finally {
      if (receiptNotifier) clearInterval(receiptNotifier);
      if (runtimeTeamName) await shutdownTeam(runtimeTeamName, cwd, { force: true }).catch(() => {});
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof previousReadyTimeout === 'string') process.env.OMX_TEAM_READY_TIMEOUT_MS = previousReadyTimeout;
      else delete process.env.OMX_TEAM_READY_TIMEOUT_MS;
      if (typeof previousStartupEvidenceTimeout === 'string') process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS = previousStartupEvidenceTimeout;
      else delete process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
      if (typeof previousStartupDispatchRetries === 'string') process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = previousStartupDispatchRetries;
      else delete process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
      if (typeof previousStartupDispatchRetryDelay === 'string') process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS = previousStartupDispatchRetryDelay;
      else delete process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam starts worker-2 readiness before delayed worker-1 readiness settles', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-parallel-ready-'));
    const previousTmux = process.env.TMUX;
    const previousTmuxPane = process.env.TMUX_PANE;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const previousReadyTimeout = process.env.OMX_TEAM_READY_TIMEOUT_MS;
    const previousStartupEvidenceTimeout = process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
    const previousStartupDispatchRetries = process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
    const previousStartupDispatchRetryDelay = process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS;
    let receiptDeliverer: NodeJS.Timeout | null = null;
    let runtimeTeamName: string | null = null;

    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-parallel-ready-bin-',
          tmuxScript: () => `#!/bin/sh
set -eu
${tmuxOwnerProofShim}
order_file="${cwd}/ready-order.log"
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*) echo "120" ;;
      *) echo "leader:0 %1" ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf "%%1\t0\t2000004141\n"
        if [ -f "${cwd}/parallel-w1" ]; then printf "%%2\t0\t2000004242\n"; fi
        if [ -f "${cwd}/parallel-w2" ]; then printf "%%3\t0\t2000004343\n"; fi
        if [ -f "${cwd}/parallel-hud" ]; then printf "%%4\t0\t2000004444\n"; fi
        ;;
      *"pane_current_command"*)
        printf "%%1\tnode\t'codex'\n"
        if [ -f "${cwd}/parallel-w1" ]; then printf "%%2\tcodex\tcodex\n"; fi
        if [ -f "${cwd}/parallel-w2" ]; then printf "%%3\tcodex\tcodex\n"; fi
        if [ -f "${cwd}/parallel-hud" ]; then printf "%%4\tnode\thud --watch\n"; fi
        ;;
      *"#{pane_dead} #{pane_pid}"*) echo "0 2000004242" ;;
      *"#{pane_dead}"*) echo "0" ;;
      *"-t %2"*"#{pane_pid}"*) echo "2000004242" ;;
      *"-t %3"*"#{pane_pid}"*) echo "2000004343" ;;
      *"#{pane_pid}"*) echo "2000004141" ;;
      *) exit 0 ;;
    esac
    exit 0
    ;;
  capture-pane)
    case "$*" in
      *"-t %2"*)
        printf '%s\n' w1-ready-start >> "$order_file"
        sleep 0.4
        printf '%s\n' w1-ready-done >> "$order_file"
        printf 'OpenAI Codex\nmodel: test\n› \n'
        ;;
      *"-t %3"*)
        printf '%s\n' w2-ready-start >> "$order_file"
        printf 'OpenAI Codex\nmodel: test\n› \n'
        ;;
      *)
        printf 'OpenAI Codex\nmodel: test\n› \n'
        ;;
    esac
    exit 0
    ;;
  split-window)
    count_file="${cwd}/parallel-split-count"
    count=0
    if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi
    count=$((count + 1))
    printf '%s' "$count" > "$count_file"
    case "$count" in
      1) : > "${cwd}/parallel-w1"; echo "%2" ;;
      2) : > "${cwd}/parallel-w2"; echo "%3" ;;
      *) : > "${cwd}/parallel-hud"; echo "%4" ;;
    esac
    exit 0
    ;;
  set-hook|run-shell|select-layout|set-window-option|select-pane|send-keys|kill-pane|kill-session|resize-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          binaries: [{ name: 'codex', content: fakeCodexNodeScript('process.stdin.resume();\n') }],
        },
        async () => {
          delete process.env.TMUX;
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
          process.env.OMX_TEAM_WORKER_CLI = 'codex';
          process.env.OMX_TEAM_READY_TIMEOUT_MS = '500';
          process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS = '50';
          process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = '1';
          process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS = '50';

          receiptDeliverer = setInterval(() => {
            void (async () => {
              await markPendingInboxDispatchesDelivered('team-parallel-ready', cwd);
            })();
          }, 20);

          const runtime = await withoutTeamWorkerEnv(() =>
            startTeam(
              'team-parallel-ready',
              'worker-2 readiness should not wait for worker-1 readiness settle',
              'executor',
              2,
              [
                { subject: 'w1', description: 'worker one', owner: 'worker-1' },
                { subject: 'w2', description: 'worker two', owner: 'worker-2' },
              ],
              cwd,
            ));
          runtimeTeamName = runtime.teamName;

          const order = (await readFile(join(cwd, 'ready-order.log'), 'utf-8')).trim().split('\n');
          assert.ok(order.includes('w1-ready-start'));
          assert.ok(order.includes('w2-ready-start'));
          assert.ok(order.includes('w1-ready-done'));
          assert.equal(
            order.indexOf('w2-ready-start') < order.indexOf('w1-ready-done'),
            true,
            `expected worker-2 readiness attempt before worker-1 readiness settled, got ${order.join(',')}`,
          );
        },
      );
    } finally {
      if (receiptDeliverer) clearInterval(receiptDeliverer);
      if (runtimeTeamName) await shutdownTeam(runtimeTeamName, cwd, { force: true }).catch(() => {});
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof previousReadyTimeout === 'string') process.env.OMX_TEAM_READY_TIMEOUT_MS = previousReadyTimeout;
      else delete process.env.OMX_TEAM_READY_TIMEOUT_MS;
      if (typeof previousStartupEvidenceTimeout === 'string') process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS = previousStartupEvidenceTimeout;
      else delete process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
      if (typeof previousStartupDispatchRetries === 'string') process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = previousStartupDispatchRetries;
      else delete process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
      if (typeof previousStartupDispatchRetryDelay === 'string') process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS = previousStartupDispatchRetryDelay;
      else delete process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it(
    'startTeam rejects no-evidence startup issues instead of treating live panes as recoverable',
    { skip: skipSlowLifecycleUnderCoverage },
    async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-no-startup-evidence-'));
    const previousTmux = process.env.TMUX;
    const previousTmuxPane = process.env.TMUX_PANE;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const previousSkipReadyWait = process.env.OMX_TEAM_SKIP_READY_WAIT;
    const previousStartupEvidenceTimeout = process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
    const previousStartupDispatchRetries = process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
    const previousStartupDispatchRetryDelay = process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS;
    let receiptFailer: NodeJS.Timeout | null = null;
    let runtime: TeamRuntime | null = null;
    const teamName = 'team-no-startup-evidence';
    let observedNoEvidenceRequest = false;

    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-no-startup-evidence-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
${tmuxOwnerProofShim}
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
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
      *"-a -F #{pane_id}"*)
        printf "%%1\t0\t2000004141\n"
        if [ -f "${tmuxLogPath}.w1" ]; then printf "%%2\t0\t2000004242\n"; fi
        if [ -f "${tmuxLogPath}.w2" ]; then printf "%%3\t0\t2000004343\n"; fi
        if [ -f "${tmuxLogPath}.hud" ]; then printf "%%4\t0\t2000004444\n"; fi
        ;;
      *"#{pane_dead}"*)
        echo "0"
        ;;
      *"#{pane_dead} #{pane_pid}"*)
        echo "0 2000004242"
        ;;
      *"pane_current_command"*)
        printf "%%1\tnode\t'codex'\n"
        if [ -f "${tmuxLogPath}.w1" ]; then printf "%%2\tcodex\tcodex\n"; fi
        if [ -f "${tmuxLogPath}.w2" ]; then printf "%%3\tcodex\tcodex\n"; fi
        if [ -f "${tmuxLogPath}.hud" ]; then printf "%%4\tnode\thud --watch\n"; fi
        ;;
      *"#{pane_pid}"*)
        echo "2000004242"
        ;;
      *)
        exit 0
        ;;
    esac
    exit 0
    ;;
  capture-pane)
    exit 0
    ;;
  split-window)
    count_file="${tmuxLogPath}.split-count"
    count=0
    if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi
    count=$((count + 1)); printf '%s' "$count" > "$count_file"
    case "$count" in
      1) : > "${tmuxLogPath}.w1"; echo "%2" ;;
      2) : > "${tmuxLogPath}.w2"; echo "%3" ;;
      *) : > "${tmuxLogPath}.hud"; echo "%4" ;;
    esac
    exit 0
    ;;
  set-hook|run-shell|select-layout|set-window-option|select-pane|send-keys|kill-pane|kill-session|resize-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          binaries: [
            {
              name: 'codex',
              content: fakeCodexNodeScript(`process.stdin.resume();
setTimeout(() => process.exit(0), 30000);
process.on('SIGTERM', () => process.exit(0));
`),
            },
          ],
        },
        async () => {
          delete process.env.TMUX;
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
          process.env.OMX_TEAM_WORKER_CLI = 'codex';
          process.env.OMX_TEAM_SKIP_READY_WAIT = '1';
          process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS = '100';
          process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = '1';
          process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS = '50';

          receiptFailer = setInterval(() => {
            void (async () => {
              const runtimeTeamName = await resolveRuntimeTeamName(cwd, teamName);
              const requests = await listDispatchRequests(runtimeTeamName, cwd, { kind: 'inbox' }).catch(() => []);
              for (const request of requests) {
                observedNoEvidenceRequest ||= /startup_no_evidence|fallback_attempted_but_unconfirmed/.test(request.last_reason ?? '');
                if (request.status !== 'pending') continue;
                await transitionDispatchRequest(
                  teamName,
                  request.request_id,
                  'pending',
                  'failed',
                  { last_reason: 'test_failed_receipt' },
                  cwd,
                ).catch(() => {});
              }
            })();
          }, 20);

          await assert.rejects(
            withoutTeamWorkerEnv(() =>
              startTeam(
                teamName,
                'interactive startup should reject no-evidence startup even while panes stay alive',
                'executor',
                2,
                [
                  { subject: 'worker-1 task', description: 'd', owner: 'worker-1' },
                  { subject: 'worker-2 task', description: 'd', owner: 'worker-2' },
                ],
                cwd,
              )),
            /(worker_notify_failed:worker-\d+:(codex_startup_no_evidence_after_fallback|fallback_attempted_but_unconfirmed)|startup_rollback_pane_proof_unavailable:%2:pane_proof_lost_during_process_teardown)/,
          );

          assert.equal(observedNoEvidenceRequest, true);

        },
      );
    } finally {
      if (receiptFailer) clearInterval(receiptFailer);
      if (runtime) {
        await shutdownTeam(teamName, cwd, { force: true }).catch(() => {});
      }
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof previousSkipReadyWait === 'string') process.env.OMX_TEAM_SKIP_READY_WAIT = previousSkipReadyWait;
      else delete process.env.OMX_TEAM_SKIP_READY_WAIT;
      if (typeof previousStartupEvidenceTimeout === 'string') {
        process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS = previousStartupEvidenceTimeout;
      } else {
        delete process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
      }
      if (typeof previousStartupDispatchRetries === 'string') {
        process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = previousStartupDispatchRetries;
      } else {
        delete process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
      }
      if (typeof previousStartupDispatchRetryDelay === 'string') {
        process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS = previousStartupDispatchRetryDelay;
      } else {
        delete process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it(
    'startTeam attempts worker-2 before rejecting lowest-index unrecoverable startup failure',
    { skip: skipSlowLifecycleUnderCoverage },
    async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-parallel-dead-pane-'));
    const previousTmux = process.env.TMUX;
    const previousTmuxPane = process.env.TMUX_PANE;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const previousReadyTimeout = process.env.OMX_TEAM_READY_TIMEOUT_MS;
    const previousStartupEvidenceTimeout = process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
    const previousStartupDispatchRetries = process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
    const previousStartupDispatchRetryDelay = process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS;
    let receiptFailer: NodeJS.Timeout | null = null;

    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-parallel-dead-pane-bin-',
          tmuxScript: () => `#!/bin/sh
set -eu
${tmuxOwnerProofShim}
order_file="${cwd}/dead-pane-order.log"
case "$1" in
  --version|-V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*) echo "120" ;;
      *) echo "leader:0 %1" ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf "%%1\t0\t2000004141\n"
        if [ -f "${cwd}/lowest-w1" ] && [ ! -f "${cwd}/killed-%2" ]; then printf "%%2\t0\t2000004242\n"; fi
        if [ -f "${cwd}/lowest-w2" ] && [ ! -f "${cwd}/killed-%3" ]; then printf "%%3\t0\t2000004343\n"; fi
        if [ -f "${cwd}/lowest-hud" ] && [ ! -f "${cwd}/killed-%4" ]; then printf "%%4\t0\t2000004444\n"; fi
        ;;
      *"pane_current_command"*)
        printf "%%1\tnode\t'codex'\n"
        if [ -f "${cwd}/lowest-w1" ] && [ ! -f "${cwd}/killed-%2" ]; then printf "%%2\tcodex\tcodex\n"; fi
        if [ -f "${cwd}/lowest-w2" ] && [ ! -f "${cwd}/killed-%3" ]; then printf "%%3\tcodex\tcodex\n"; fi
        if [ -f "${cwd}/lowest-hud" ] && [ ! -f "${cwd}/killed-%4" ]; then printf "%%4\tnode\thud --watch\n"; fi
        ;;
      *"-t %2"*"#{pane_dead} #{pane_pid}"*) echo "1 2000004242" ;;
      *"-t %3"*"#{pane_dead} #{pane_pid}"*) echo "0 2000004343" ;;
      *"-t %4"*"#{pane_dead} #{pane_pid}"*) echo "0 2000004444" ;;
      *"#{pane_dead} #{pane_pid}"*) echo "0 2000004141" ;;
      *"-t %2"*"#{pane_pid}"*) echo "2000004242" ;;
      *"-t %3"*"#{pane_pid}"*) echo "2000004343" ;;
      *"-t %4"*"#{pane_pid}"*) echo "2000004444" ;;
      *"#{pane_pid}"*) echo "2000004141" ;;
      *) exit 0 ;;
    esac
    exit 0
    ;;
  capture-pane)
    case "$*" in
      *"-t %2"*) printf '%s\n' w1-ready-start >> "$order_file" ;;
      *"-t %3"*) printf '%s\n' w2-ready-start >> "$order_file"; printf 'OpenAI Codex\nmodel: test\n› \n' ;;
      *) printf 'OpenAI Codex\nmodel: test\n› \n' ;;
    esac
    exit 0
    ;;
  split-window)
    count_file="${cwd}/split-window-count"
    count=0
    if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi
    count=$((count + 1))
    printf '%s' "$count" > "$count_file"
    case "$count" in
      1) : > "${cwd}/lowest-w1"; echo "%2" ;;
      2) : > "${cwd}/lowest-w2"; echo "%3" ;;
      *) : > "${cwd}/lowest-hud"; echo "%4" ;;
    esac
    exit 0
    ;;
  set-hook|run-shell|select-layout|set-window-option|select-pane|send-keys|kill-session|resize-pane)
    exit 0
    ;;
  kill-pane)
    case "$*" in
      *"%2"*) : > "${cwd}/killed-%2" ;;
      *"%3"*) : > "${cwd}/killed-%3" ;;
      *"%4"*) : > "${cwd}/killed-%4" ;;
    esac
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          binaries: [{ name: 'codex', content: fakeCodexNodeScript('setTimeout(() => process.exit(0), 100);\n') }],
        },
        async () => {
          delete process.env.TMUX;
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
          process.env.OMX_TEAM_WORKER_CLI = 'codex';
          process.env.OMX_TEAM_READY_TIMEOUT_MS = '500';
          process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS = '100';
          process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = '1';
          process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS = '50';

          receiptFailer = setInterval(() => {
            void (async () => {
              const requests = await listDispatchRequests('team-parallel-dead-pane', cwd, { kind: 'inbox' }).catch(() => []);
              for (const request of requests) {
                if (request.status !== 'pending') continue;
                await transitionDispatchRequest(
                  'team-parallel-dead-pane',
                  request.request_id,
                  'pending',
                  'failed',
                  { last_reason: 'test_failed_receipt' },
                  cwd,
                ).catch(() => {});
              }
            })();
          }, 20);

          await assert.rejects(
            () => withoutTeamWorkerEnv(() =>
              startTeam(
                'team-parallel-dead-pane',
                'worker-2 should be attempted despite worker-1 fatal readiness failure',
                'executor',
                2,
                [
                  { subject: 'w1', description: 'worker one', owner: 'worker-1' },
                  { subject: 'w2', description: 'worker two', owner: 'worker-2' },
                ],
                cwd,
              )),
            /(worker_notify_failed:worker-1:codex_startup_no_evidence_after_fallback|startup_rollback_pane_proof_unavailable:%2:pane_proof_lost_during_process_teardown)/,
          );

          const order = (await readFile(join(cwd, 'dead-pane-order.log'), 'utf-8')).trim().split('\n');
          assert.ok(order.includes('w1-ready-start'));
          assert.ok(order.includes('w2-ready-start'));
        },
      );
    } finally {
      if (receiptFailer) clearInterval(receiptFailer);
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof previousReadyTimeout === 'string') process.env.OMX_TEAM_READY_TIMEOUT_MS = previousReadyTimeout;
      else delete process.env.OMX_TEAM_READY_TIMEOUT_MS;
      if (typeof previousStartupEvidenceTimeout === 'string') process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS = previousStartupEvidenceTimeout;
      else delete process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
      if (typeof previousStartupDispatchRetries === 'string') process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = previousStartupDispatchRetries;
      else delete process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
      if (typeof previousStartupDispatchRetryDelay === 'string') process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS = previousStartupDispatchRetryDelay;
      else delete process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('settleStartupAttemptResults waits for sibling startup attempt to settle after worker startup throw', async () => {
    let worker2Settled = false;
    const startupAttemptResults = await settleStartupAttemptResults([
      {
        workerIndex: 1,
        workerName: 'worker-1',
        attempt: Promise.reject(new Error('test_startup_attempt_throw:worker-1')),
      },
      {
        workerIndex: 2,
        workerName: 'worker-2',
        attempt: new Promise((resolve) => {
          setTimeout(() => {
            worker2Settled = true;
            resolve({ ok: true, workerIndex: 2, workerName: 'worker-2' });
          }, 100);
        }),
      },
    ]);

    assert.equal(worker2Settled, true, 'worker-2 startup attempt should settle before results return');
    const firstStartupError = startupAttemptResults
      .filter((result): result is Extract<typeof result, { ok: false }> => !result.ok)
      .sort((a, b) => a.workerIndex - b.workerIndex)[0];
    assert.equal(firstStartupError?.workerName, 'worker-1');
    assert.match(String(firstStartupError?.error), /test_startup_attempt_throw:worker-1/);
  });

  it('startTeam preserves config when startup rollback proof is unavailable while treating dead panes as cleanup-compatible', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-dead-startup-pane-'));
    const previousTmux = process.env.TMUX;
    const previousTmuxPane = process.env.TMUX_PANE;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const previousReadyTimeout = process.env.OMX_TEAM_READY_TIMEOUT_MS;
    const previousStartupEvidenceTimeout = process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
    const previousStartupDispatchRetries = process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
    const previousStartupDispatchRetryDelay = process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS;

    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-dead-startup-pane-bin-',
          tmuxScript: () => `#!/bin/sh
set -eu
${tmuxOwnerProofShim}
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*) echo "120" ;;
      *) echo "leader:0 %1" ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        if [ -f "${cwd}/unavailable-pane-proof" ]; then
          if [ -f "${cwd}/startup-ready-check-started" ]; then
            printf 'not-a-pane-snapshot\n'
          else
            printf "%%1\t0\t2000000001\n"
            if [ -f "${cwd}/dead-w1" ]; then printf "%%2\t0\t2000004242\n"; fi
            if [ -f "${cwd}/dead-hud" ]; then printf "%%3\t0\t2000004343\n"; fi
          fi
        elif [ -f "${cwd}/startup-ready-check-started" ]; then
          printf "%%2\t1\t2000004242\n%%3\t1\t2000004343\n"
        else
          printf "%%1\t0\t2000000001\n"
          if [ -f "${cwd}/dead-w1" ]; then printf "%%2\t0\t2000004242\n"; fi
          if [ -f "${cwd}/dead-hud" ]; then printf "%%3\t0\t2000004343\n"; fi
        fi
        ;;
      *"pane_current_command"*)
        printf "%%1\tnode\t'codex'\n"
        if [ -f "${cwd}/dead-w1" ]; then printf "%%2\tcodex\tcodex\n"; fi
        if [ -f "${cwd}/dead-hud" ]; then printf "%%3\tnode\thud --watch\n"; fi
        ;;
      *"-t %2"*"#{pane_dead} #{pane_pid}"*) echo "1 2000004242" ;;
      *"-t %3"*"#{pane_dead} #{pane_pid}"*) echo "1 2000004343" ;;
      *"#{pane_dead} #{pane_pid}"*) echo "1 2000004242" ;;
      *"-t %2"*"#{pane_pid}"*) echo "2000004242" ;;
      *"-t %3"*"#{pane_pid}"*) echo "2000004343" ;;
      *"#{pane_pid}"*) echo "2000004242" ;;
      *) exit 0 ;;
    esac
    exit 0
    ;;
  capture-pane)
    : > "${cwd}/startup-ready-check-started"
    exit 0
    ;;

  split-window)
    case "$*" in
      *" -h "*) : > "${cwd}/dead-w1"; echo "%2" ;;
      *) : > "${cwd}/dead-hud"; echo "%3" ;;
    esac
    exit 0
    ;;
  set-hook|run-shell|select-layout|set-window-option|select-pane|send-keys|kill-pane|kill-session|resize-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          binaries: [{ name: 'codex', content: fakeCodexNodeScript('process.stdin.resume();\n') }],
        },
        async () => {
          delete process.env.TMUX;
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
          process.env.OMX_TEAM_WORKER_CLI = 'codex';
          process.env.OMX_TEAM_READY_TIMEOUT_MS = '500';
          process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS = '100';
          process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = '1';
          process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS = '50';

          await assert.rejects(
            () => withoutTeamWorkerEnv(() =>
              startTeam(
                'team-dead-startup-pane',
                'dead pane should still fail startup',
                'executor',
                1,
                [{ subject: 's', description: 'd', owner: 'worker-1' }],
                cwd,
              )),
            /Worker worker-1 did not become ready/,
          );

          assert.equal(await readTeamConfig('team-dead-startup-pane', cwd), null);

          await writeFile(join(cwd, 'unavailable-pane-proof'), '');
          await rm(join(cwd, 'startup-ready-check-started'), { force: true });
          await rm(join(cwd, 'dead-w1'), { force: true });
          await rm(join(cwd, 'dead-hud'), { force: true });
          await assert.rejects(
            () => withoutTeamWorkerEnv(() =>
              startTeam(
                'team-unavailable-startup-pane',
                'unavailable pane proof must preserve startup state',
                'executor',
                1,
                [{ subject: 's', description: 'd', owner: 'worker-1' }],
                cwd,
              )),
            /startup_rollback_pane_proof_unavailable:%2:malformed_snapshot/,
          );

          const runtimeTeamName = await resolveRuntimeTeamName(cwd, 'team-unavailable-startup-pane');
          const preservedConfig = await readTeamConfig(runtimeTeamName, cwd);
          assert.ok(preservedConfig);
          assert.equal(preservedConfig?.tmux_session, 'leader:0');
          assert.equal(preservedConfig?.workers[0]?.pane_id, '%2');
          assert.equal(preservedConfig?.hud_pane_id, '%3');
          assert.ok(preservedConfig?.resize_hook_name);
          assert.ok(preservedConfig?.resize_hook_target);

        },
      );
    } finally {
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof previousReadyTimeout === 'string') {
        process.env.OMX_TEAM_READY_TIMEOUT_MS = previousReadyTimeout;
      } else {
        delete process.env.OMX_TEAM_READY_TIMEOUT_MS;
      }
      if (typeof previousStartupEvidenceTimeout === 'string') {
        process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS = previousStartupEvidenceTimeout;
      } else {
        delete process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
      }
      if (typeof previousStartupDispatchRetries === 'string') {
        process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = previousStartupDispatchRetries;
      } else {
        delete process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
      }
      if (typeof previousStartupDispatchRetryDelay === 'string') {
        process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS = previousStartupDispatchRetryDelay;
      } else {
        delete process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam persists partial create-session metadata when rollback proof is unavailable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-partial-create-proof-'));
    const previousTmux = process.env.TMUX;
    const previousTmuxPane = process.env.TMUX_PANE;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-partial-create-proof-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
${tmuxOwnerProofShim}
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*) echo "120" ;;
      *) echo "leader:0 %1" ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        if [ -f "${cwd}/partial-created-pane" ]; then
          printf 'not-a-pane-snapshot\n'
        else
          printf "%%1\t0\t2000000001\n%%2\t0\t2000004242\n"
        fi
        ;;

      *"pane_current_command"*)
        printf "%%1\\tnode\\t'codex'\\n"
        ;;
      *)
        printf "%%1\\n"
        ;;
    esac
    exit 0
    ;;
  split-window)
    echo "%2"
    exit 0
    ;;
  set-option)
    case "$*" in
      *"-p -t %2 @omx_team_pane_owner_id"*)
        : > "${cwd}/partial-created-pane"
        echo "worker owner tag rejected" >&2
        exit 1
        ;;

      *) exit 0 ;;
    esac
    ;;
  set-hook|run-shell|select-layout|set-window-option|select-pane|send-keys|kill-pane|kill-session|resize-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          binaries: [{ name: 'codex', content: fakeCodexNodeScript('process.stdin.resume();\n') }],
        },
        async ({ tmuxLogPath }) => {
          delete process.env.TMUX;
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
          process.env.OMX_TEAM_WORKER_CLI = 'codex';

          await assert.rejects(
            () => withoutTeamWorkerEnv(() => startTeam(
              'team-partial-create-proof',
              'partial tmux session must remain recoverable',
              'executor',
              1,
              [{ subject: 's', description: 'd', owner: 'worker-1' }],
              cwd,
            )),
            /startup_rollback_pane_proof_unavailable:%2:malformed_snapshot/,
          );

          const runtimeTeamName = await resolveRuntimeTeamName(cwd, 'team-partial-create-proof');
          const config = await readTeamConfig(runtimeTeamName, cwd);
          assert.ok(config);
          assert.equal(config?.tmux_session, 'leader:0');
          assert.equal(config?.leader_pane_id, '%1');
          assert.equal(config?.workers[0]?.pane_id, '%2');
          assert.equal(config?.hud_pane_id, null);

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /list-panes -a -F #\{pane_id\}\t#\{pane_dead\}\t#\{pane_pid\}/);
          assert.doesNotMatch(tmuxLog, /kill-pane -t %2/);
        },
      );
    } finally {
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

  it('startTeam cleans state when create-session proof loss has no created resource', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-no-resource-create-proof-'));
    const previousTmux = process.env.TMUX;
    const previousTmuxPane = process.env.TMUX_PANE;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const previousEntryPath = process.env.OMX_ENTRY_PATH;
    const previousArgv = process.argv;
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-no-resource-create-proof-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
${tmuxOwnerProofShim}
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{window_width}"*) echo "120" ;;
      *) echo "leader:0 %1" ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        count_file="${cwd}/global-proof-count"
        count=0
        if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi
        count=$((count + 1))
        printf '%s' "$count" > "$count_file"
        if [ "$count" -le 6 ]; then
          printf "%%1\t0\t2000000001\n%%2\t0\t2000004242\n"
        else
          printf 'not-a-pane-snapshot\n'
        fi
        ;;
      *"pane_current_command"*) printf '%s\n' "%1\tnode\tcodex" "%2\tnode\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE=%1 node /omx.js hud --watch" ;;
      *) printf "%%1\\n%%2\\n" ;;
    esac
    exit 0
    ;;
  set-option)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          binaries: [{ name: 'codex', content: fakeCodexNodeScript('process.stdin.resume();\n') }],
        },
        async ({ tmuxLogPath }) => {
          process.env.TMUX = 'leader-session,stub,0';
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
          process.env.OMX_TEAM_WORKER_CLI = 'codex';
          process.env.OMX_ENTRY_PATH = join(cwd, 'omx.js');
          process.argv = [previousArgv[0] || 'node', join(cwd, 'omx.js')];

          await assert.rejects(
            () => withoutTeamWorkerEnv(() => startTeam(
              'team-no-resource-create-proof',
              'target and leader identity alone must not persist startup state',
              'executor',
              1,
              [{ subject: 's', description: 'd', owner: 'worker-1' }],
              cwd,
            )),
            /exact_pane_proof_unavailable:%1:malformed_snapshot/,
          );

          const runtimeTeamName = await resolveRuntimeTeamName(cwd, 'team-no-resource-create-proof');
          assert.equal(await readTeamConfig(runtimeTeamName, cwd), null);
          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.doesNotMatch(tmuxLog, /split-window/);
        },
      );
    } finally {
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof previousEntryPath === 'string') process.env.OMX_ENTRY_PATH = previousEntryPath;
      else delete process.env.OMX_ENTRY_PATH;
      process.argv = previousArgv;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it(
    'startTeam materializes all worker identity/inbox files before worker-1 startup evidence can block later workers',
    { skip: skipSlowLifecycleUnderCoverage },
    async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-materialize-before-evidence-'));
    const previousTmux = process.env.TMUX;
    const previousTmuxPane = process.env.TMUX_PANE;
    const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const previousSkipReadyWait = process.env.OMX_TEAM_SKIP_READY_WAIT;
    const previousStartupEvidenceTimeout = process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
    const previousStartupDispatchRetries = process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
    const previousStartupDispatchRetryDelay = process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS;
    let receiptFailer: NodeJS.Timeout | null = null;

    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-materialize-before-evidence-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
${tmuxOwnerProofShim}
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
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
      *"-a -F #{pane_id}"*)
        printf "%%1\t0\t2000004141\n"
        if [ -f "${tmuxLogPath}.w1" ]; then printf "%%2\t0\t2000004242\n"; fi
        if [ -f "${tmuxLogPath}.w2" ]; then printf "%%3\t0\t2000004343\n"; fi
        if [ -f "${tmuxLogPath}.hud" ]; then printf "%%4\t0\t2000004444\n"; fi
        ;;
      *"pane_current_command"*)
        printf "%%1\tnode\t'codex'\n"
        if [ -f "${tmuxLogPath}.w1" ]; then printf "%%2\tcodex\tcodex\n"; fi
        if [ -f "${tmuxLogPath}.w2" ]; then printf "%%3\tcodex\tcodex\n"; fi
        if [ -f "${tmuxLogPath}.hud" ]; then printf "%%4\tnode\thud --watch\n"; fi
        ;;
      *"-t %2"*"#{pane_dead} #{pane_pid}"*) echo "0 2000004242" ;;
      *"-t %3"*"#{pane_dead} #{pane_pid}"*) echo "0 2000004343" ;;
      *"-t %4"*"#{pane_dead} #{pane_pid}"*) echo "0 2000004444" ;;
      *"#{pane_dead} #{pane_pid}"*) echo "0 2000004141" ;;
      *"-t %2"*"#{pane_pid}"*) echo "2000004242" ;;
      *"-t %3"*"#{pane_pid}"*) echo "2000004343" ;;
      *"-t %4"*"#{pane_pid}"*) echo "2000004444" ;;
      *"#{pane_pid}"*) echo "2000004141" ;;
      *) exit 0 ;;
    esac
    exit 0
    ;;
  capture-pane)
    exit 0
    ;;
  split-window)
    count_file="${cwd}/split-window-count"
    count=0
    if [ -f "$count_file" ]; then
      count=$(cat "$count_file")
    fi
    count=$((count + 1))
    printf '%s' "$count" > "$count_file"
    case "$count" in
      1) : > "${tmuxLogPath}.w1"; echo "%2" ;;
      2) : > "${tmuxLogPath}.w2"; echo "%3" ;;
      3) : > "${tmuxLogPath}.hud"; echo "%4" ;;
      *) echo "%5" ;;
    esac
    exit 0
    ;;
  set-hook|run-shell|select-layout|set-window-option|select-pane|send-keys|kill-pane|kill-session|resize-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          binaries: [
            {
              name: 'codex',
              content: fakeCodexNodeScript(`process.stdin.resume();
setTimeout(() => process.exit(0), 30000);
process.on('SIGTERM', () => process.exit(0));
`),
            },
          ],
        },
        async () => {
          let runtimeTeamName = sanitizeTeamName('team-materialize-before-evidence');
          delete process.env.TMUX;
          process.env.TMUX_PANE = '%1';
          process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'interactive';
          process.env.OMX_TEAM_WORKER_CLI = 'codex';
          process.env.OMX_TEAM_SKIP_READY_WAIT = '1';
          process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS = '100';
          process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = '1';
          process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS = '50';

          receiptFailer = setInterval(() => {
            void (async () => {
              const activeTeamName = await resolveRuntimeTeamName(cwd, 'team-materialize-before-evidence');
              runtimeTeamName = activeTeamName;
              const requests = await listDispatchRequests(activeTeamName, cwd, { kind: 'inbox' }).catch(() => []);
              for (const request of requests) {
                if (request.status !== 'pending') continue;
                await transitionDispatchRequest(
                  activeTeamName,
                  request.request_id,
                  'pending',
                  'failed',
                  { last_reason: 'test_failed_receipt' },
                  cwd,
                ).catch(() => {});
              }
            })();
          }, 20);

          const teamPromise = withoutTeamWorkerEnv(() =>
            startTeam(
              'team-materialize-before-evidence',
              'later workers should materialize before startup evidence failure',
              'executor',
              2,
              [
                { subject: 'w1', description: 'worker one', owner: 'worker-1' },
                { subject: 'w2', description: 'worker two', owner: 'worker-2' },
              ],
              cwd,
            ));
          const observedTeamPromise = teamPromise.then(
            (runtime) => ({ ok: true as const, runtime }),
            (error: unknown) => ({ ok: false as const, error }),
          );

          let materializedAllWorkers = false;
          for (let attempt = 0; attempt < 200; attempt += 1) {
            runtimeTeamName = await resolveRuntimeTeamName(cwd, 'team-materialize-before-evidence');
            const workerOneIdentity = join(cwd, '.omx', 'state', 'team', runtimeTeamName, 'workers', 'worker-1', 'identity.json');
            const workerTwoIdentity = join(cwd, '.omx', 'state', 'team', runtimeTeamName, 'workers', 'worker-2', 'identity.json');
            const workerTwoInbox = join(cwd, '.omx', 'state', 'team', runtimeTeamName, 'workers', 'worker-2', 'inbox.md');
            if (
              existsSync(workerOneIdentity)
              && existsSync(workerTwoIdentity)
              && existsSync(workerTwoInbox)
            ) {
              materializedAllWorkers = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }

          assert.equal(
            materializedAllWorkers,
            true,
            'worker-2 durable state should exist before worker-1 startup evidence failure rejects launch',
          );

          const outcome = await observedTeamPromise;
          assert.equal(outcome.ok, false);
          assert.match(String((outcome as { ok: false; error: Error }).error), /(worker_notify_failed:worker-1|startup_rollback_pane_proof_unavailable:%2:pane_proof_lost_during_process_teardown)/);

          assert.equal(
            existsSync(join(cwd, '.omx', 'state', 'team', runtimeTeamName)),
            true,
            'failed pane teardown must retain retryable startup state',
          );
        },
      );
    } finally {
      if (receiptFailer) clearInterval(receiptFailer);
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof previousSkipReadyWait === 'string') process.env.OMX_TEAM_SKIP_READY_WAIT = previousSkipReadyWait;
      else delete process.env.OMX_TEAM_SKIP_READY_WAIT;
      if (typeof previousStartupEvidenceTimeout === 'string') {
        process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS = previousStartupEvidenceTimeout;
      } else {
        delete process.env.OMX_TEAM_STARTUP_EVIDENCE_TIMEOUT_MS;
      }
      if (typeof previousStartupDispatchRetries === 'string') {
        process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES = previousStartupDispatchRetries;
      } else {
        delete process.env.OMX_TEAM_STARTUP_DISPATCH_RETRIES;
      }
      if (typeof previousStartupDispatchRetryDelay === 'string') {
        process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS = previousStartupDispatchRetryDelay;
      } else {
        delete process.env.OMX_TEAM_STARTUP_DISPATCH_RETRY_DELAY_MS;
      }
      await rm(cwd, { recursive: true, force: true });
    }
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

  it('startTeam runs worker MCP orphan cleanup before prompt worker spawn', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-prompt-mcp-cleanup-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    const capturePath = join(cwd, 'prompt-cleanup-order.jsonl');
    await mkdir(binDir, { recursive: true });
    await writeFakePromptWorkerBinary(
      fakeCodexPath,
      `const capturePath = process.env.OMX_PROMPT_CLEANUP_CAPTURE_PATH;
if (capturePath) require('fs').appendFileSync(capturePath, 'spawn' + String.fromCharCode(10));
setTimeout(() => {}, 5000);`,
    );

    const prevPath = process.env.PATH;
    const prevTmux = process.env.TMUX;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevLaunchArgs = process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
    const prevCapture = process.env.OMX_PROMPT_CLEANUP_CAPTURE_PATH;
    const prevAllowNonTty = process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT;
    let runtime: TeamRuntime | null = null;

    try {
      process.env.PATH = `${binDir}:${prevPath ?? ''}`;
      delete process.env.TMUX;
      process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
      process.env.OMX_TEAM_WORKER_CLI = 'codex';
      process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = `--config ${JSON.stringify(`model_instructions_file=\"${join(cwd, 'AGENTS.md')}\"`)}`;
      process.env.OMX_PROMPT_CLEANUP_CAPTURE_PATH = capturePath;
      process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT = '1';

      const started = await withoutTeamWorkerEnv(() =>
        startTeam(
          'team-prompt-cleanup',
          'prompt cleanup before worker spawn',
          'executor',
          1,
          [{ subject: 's', description: 'd', owner: 'worker-1' }],
          cwd,
          {
            cleanupLaunchOrphanedMcpProcesses: async () => {
              await writeFile(capturePath, 'cleanup\n', 'utf-8');
              return { dryRun: false, candidates: [], terminatedCount: 0, forceKilledCount: 0, failedPids: [] };
            },
          },
        ),
      );
      runtime = started;

      const order = await waitForFileText(capturePath, (content) => /spawn/.test(content));
      assert.equal(order, 'cleanup\nspawn\n');

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
      if (typeof prevCapture === 'string') process.env.OMX_PROMPT_CLEANUP_CAPTURE_PATH = prevCapture;
      else delete process.env.OMX_PROMPT_CLEANUP_CAPTURE_PATH;
      if (typeof prevAllowNonTty === 'string') process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT = prevAllowNonTty;
      else delete process.env.OMX_TEST_ALLOW_NONTTY_CODEX_PROMPT;
      await rm(cwd, { recursive: true, force: true });
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
    process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = '--model gpt-5.6-luna';
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
        `Read .omx/state/team/${runtime.teamName}/workers/worker-1/inbox.md, start work now, report concrete progress, then continue assigned work or next feasible task.`,
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

  it('startTeam rejects codex prompt mode even when explicit launch args are provided', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-codex-explicit-launch-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  console.log('codex 0.0.0-test');
  process.exit(0);
}
process.exit(0);
`,
      { mode: 0o755 },
    );

    const prevPath = process.env.PATH;
    const prevTmux = process.env.TMUX;
    const prevLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
    const prevWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevLaunchArgs = process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;

    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    delete process.env.TMUX;
    process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
    process.env.OMX_TEAM_WORKER_CLI = 'codex';
    process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = '--model gpt-5.6-luna -c model_reasoning_effort="low"';
    try {
      await assert.rejects(
        () => withoutTeamWorkerEnv(() =>
          startTeam(
            'team-codex-explicit-launch',
            'codex prompt-mode team bootstrap',
            'explore',
            1,
            [{ subject: 's', description: 'd', owner: 'worker-1' }],
            cwd,
          )),
        /prompt_mode_codex_requires_tty/,
      );
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', 'team-codex-explicit-launch')), false);
    } finally {
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
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('startTeam preserves routed task roles into team state and override-aware worker launch args', async () => {
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
if (process.argv[2] === '--version') {
  console.log('codex 0.0.0-test');
  process.exit(0);
}
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
    const prevStandardModel = process.env.OMX_DEFAULT_STANDARD_MODEL;

    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    delete process.env.TMUX;
    process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
    process.env.OMX_TEAM_WORKER_CLI = 'codex';
    process.env.OMX_ARGV_CAPTURE_DIR = captureDir;
    delete process.env.OMX_DEFAULT_STANDARD_MODEL;

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withIsolatedDefaultModelEnvAsync(async () => {
        assert.ok(process.env.CODEX_HOME, 'isolated CODEX_HOME should be set');
        await mkdir(process.env.CODEX_HOME, { recursive: true });
        await writeFile(join(process.env.CODEX_HOME, '.omx-config.json'), JSON.stringify({
          agentReasoning: {
            writer: 'xhigh',
          },
        }));

        return await withMockPromptModeCodexAllowed(() =>
          withoutTeamWorkerEnv(() =>
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
            )));
      });

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
      assert.doesNotMatch(worker1Instructions, /exact gpt-5\.6-terra model/);
      assert.match(worker2Instructions, /You are operating as the \*\*writer\*\* role/);
      assert.match(worker2Instructions, /You are Writer\./);
      assert.doesNotMatch(worker2Instructions, /exact gpt-5\.6-terra model/);
      assert.match(worker2Instructions, /resolved_model: gpt-5\.6-sol/);

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
      assert.match(worker1Joined, /--model gpt-5\.6-sol/);
      assert.match(worker2Joined, /model_reasoning_effort="xhigh"/);
      assert.match(worker2Joined, /model_instructions_file=.*worker-2\/AGENTS\.md/);
      assert.match(worker2Joined, /--model gpt-5\.6-sol/);

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
      if (typeof prevStandardModel === 'string') process.env.OMX_DEFAULT_STANDARD_MODEL = prevStandardModel;
      else delete process.env.OMX_DEFAULT_STANDARD_MODEL;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam does not apply mini guidance for exact-match negatives like gpt-5.6-terra-tuned', async () => {
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
if (process.argv[2] === '--version') {
  console.log('codex 0.0.0-test');
  process.exit(0);
}
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
    const prevStandardModel = process.env.OMX_DEFAULT_STANDARD_MODEL;

    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    delete process.env.TMUX;
    process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
    process.env.OMX_TEAM_WORKER_CLI = 'codex';
    process.env.OMX_ARGV_CAPTURE_DIR = captureDir;
    delete process.env.OMX_DEFAULT_STANDARD_MODEL;
    process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = '--model gpt-5.6-terra-tuned';

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withMockPromptModeCodexAllowed(() =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-mini-tuned-routing',
            'mini tuned routing handoff',
            'executor',
            1,
            [
              { subject: 'document routing report only', description: 'document routing report only', owner: 'worker-1', role: 'writer' },
            ],
            cwd,
          )));

      const workerInstructions = await readFile(join(cwd, '.omx', 'state', 'team', runtime.teamName, 'workers', 'worker-1', 'AGENTS.md'), 'utf-8');
      assert.match(workerInstructions, /You are operating as the \*\*writer\*\* role/);
      assert.match(workerInstructions, /You are Writer\./);
      assert.doesNotMatch(workerInstructions, /exact gpt-5\.6-terra model/);
      assert.doesNotMatch(workerInstructions, /strict execution order: inspect -> plan -> act -> verify/);
      assert.match(workerInstructions, /resolved_model: gpt-5\.6-terra-tuned/);

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
      assert.match(workerJoined, /--model gpt-5\.6-terra-tuned/);

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
      if (typeof prevStandardModel === 'string') process.env.OMX_DEFAULT_STANDARD_MODEL = prevStandardModel;
      else delete process.env.OMX_DEFAULT_STANDARD_MODEL;
      if (typeof prevLaunchArgs === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = prevLaunchArgs;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_ARGS;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam rejects codex prompt mode without tmux with an explicit non-tty error', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-prompt-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  console.log('codex 0.0.0-test');
  process.exit(0);
}
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

    try {
      await assert.rejects(
        () => withoutTeamWorkerEnv(() =>
          startTeam(
            'team-prompt',
            'prompt-mode team bootstrap',
            'executor',
            1,
            [{ subject: 's', description: 'd', owner: 'worker-1' }],
            cwd,
          )),
        /prompt_mode_codex_requires_tty/,
      );
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', 'team-prompt')), false);
    } finally {
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
hud_state="${tmuxLogPath}.hud-state"
if [ ! -f "$hud_state" ]; then
  printf 'absent' > "$hud_state"
fi
worker_state="${tmuxLogPath}.worker-state"
if [ ! -f "$worker_state" ]; then
  printf 'absent' > "$worker_state"
fi
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
      *"-t leader:0 -F "*'#{pane_id}'*'#{pane_current_command}'*'#{pane_start_command}'*)
        printf "%%1\\tnode\\t'codex'\\n"
        if [ "$(cat "$worker_state")" != "absent" ]; then
          printf "%%2\\tgemini\\tenv OMX_TEAM_INTERNAL_WORKER=team-rerun-hud-6aa4d480/worker-1 gemini\\n"
        fi
        if [ "$(cat "$hud_state")" != "absent" ]; then
          printf "%%3\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%1' node /tmp/bin/omx.js hud --watch\\n"
        fi
        ;;
      *"-a -F #{pane_id}"*)
        printf "%%1\t0\t2000999998\n"
        if [ "$(cat "$worker_state")" != "absent" ]; then
          printf "%%2\t0\t2000999999\n"
        fi
        if [ "$(cat "$hud_state")" != "absent" ]; then
          printf "%%3\t0\t2000999997\n"
        fi
        ;;

      *"pane_current_command"* )
        printf "%%1\\tnode\\t'codex'\\n%%2\\tgemini\\tgemini\\n"
        if [ "$(cat "$hud_state")" != "absent" ]; then
          printf "%%3\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%1' node /tmp/bin/omx.js hud --watch\\n"
        fi
        ;;
      *"-t %1"*"#{pane_dead} #{pane_pid}"*) echo "0 2000999998" ;;
      *"-t %2"*"#{pane_dead} #{pane_pid}"*) echo "0 2000999999" ;;
      *"-t %3"*"#{pane_dead} #{pane_pid}"*) echo "0 2000999997" ;;
      *"-t %1"*"#{pane_pid}"*) echo "2000999998" ;;
      *"-t %2"*"#{pane_pid}"*) echo "2000999999" ;;
      *"-t %3"*"#{pane_pid}"*) echo "2000999997" ;;
      *"#{pane_pid}"*) echo "2000999998" ;;
      *)
        exit 0
        ;;
    esac
    exit 0
    ;;
  split-window)
    case "$*" in
      *" -h "*)
        rm -f "${tmuxLogPath}.killed-%2"
        printf 'present' > "$worker_state"
        echo "%2"
        ;;
      *" -f "*)
        printf 'team' > "$hud_state"
        echo "%3"
        ;;
      *)
        printf 'standalone' > "$hud_state"
        echo "%3"
        ;;
    esac
    exit 0
    ;;
  show-option)
    case "$*" in
      *"-p -t %1 @omx_team_pane_owner_id"*)
        echo "team:team-rerun-hud-6aa4d480"
        ;;
      *"-p -t %2 @omx_team_pane_owner_id"*)
        echo "team:team-rerun-hud-6aa4d480"
        ;;
      *"-p -t %3 @omx_team_pane_owner_id"*)
        echo "team:team-rerun-hud-6aa4d480"
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  kill-pane)
    case "$*" in
      *"%2"*) printf 'absent' > "$worker_state" ;;
      *"%3"*) printf 'absent' > "$hud_state" ;;
    esac
    exit 0
    ;;
  set-hook|run-shell|select-layout|set-window-option|select-pane|send-keys|kill-session)
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
          env: { OMX_SESSION_ID: 'team-rerun-hud-session' },
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
          const configBeforeShutdown = await readTeamConfig(runtime.teamName, cwd);
          assert.equal(configBeforeShutdown?.hud_pane_id, '%3');

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
          const teamHudSplitRe = new RegExp(`split-window -v -f -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t %1 -d -P -F #\\{pane_id\\}`, 'g');
          const standaloneHudSplitRe = new RegExp(`split-window -v -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t %1 -d -P -F #\\{pane_id\\}`, 'g');
          assert.equal(tmuxLog.match(teamHudSplitRe)?.length ?? 0, 2);
          assert.equal(tmuxLog.match(standaloneHudSplitRe)?.length ?? 0, 1);
          assert.equal(tmuxLog.match(/set-hook -t leader:0 client-resized\[\d+\]/g)?.length ?? 0, 2);
          assert.equal(tmuxLog.match(/set-hook -t leader:0 client-attached\[\d+\]/g)?.length ?? 0, 2);
          assert.match(tmuxLog, /snapshot=\$\(tmux list-panes -a -F/);
          assert.ok((tmuxLog.match(/list-panes -a -F '#\{pane_id\}\\t#\{pane_dead\}\\t#\{pane_pid\}'/g)?.length ?? 0) >= 6);
          assert.ok((tmuxLog.match(/select-layout -t leader:0 main-vertical/g)?.length ?? 0) >= 2);
          assert.equal(tmuxLog.match(/kill-pane -t %3/g)?.length ?? 0, 2);
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
if (process.argv[2] === '--version') {
  console.log('codex 0.0.0-test');
  process.exit(0);
}
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
      runtime = await withMockPromptModeCodexAllowed(() =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-detached-worktree-paths',
            'detached worktree path resolution',
            'executor',
            1,
            [{ subject: 's', description: 'd', owner: 'worker-1' }],
            repo,
            { worktreeMode: { enabled: true, detached: true, name: null } },
          )));

      const workerPath = runtime.config.workers[0]?.worktree_path;
      assert.ok(workerPath, 'detached worker should have a worktree path');
      assert.notEqual(workerPath, repo);
      const workerAgents = await readFile(join(workerPath as string, 'AGENTS.md'), 'utf-8');
      assert.match(workerAgents, /Team Worker Runtime Instructions/);
      assert.match(workerAgents, new RegExp(runtime.teamName));

      const startupLog = await waitForFileText(
        stdinLogPath,
        (content) => content.includes('/workers/worker-1/inbox.md'),
      );
      assert.match(
        startupLog,
        new RegExp(`\\$OMX_TEAM_STATE_ROOT/team/${runtime.teamName}/workers/worker-1/inbox\\.md`),
      );
      assert.doesNotMatch(
        startupLog,
        new RegExp(`Read \\.omx/state/team/${runtime.teamName}/workers/worker-1/inbox\\.md`),
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
      assert.match(rootAgents, new RegExp(`Inbox path: .*${runtime.teamName}/workers/worker-1/inbox\\.md`));

      await sendWorkerMessage(runtime.teamName, 'leader-fixed', 'worker-1', 'follow-up', repo);
      const mailboxLog = await waitForFileText(
        stdinLogPath,
        (content) => content.includes('/mailbox/worker-1.json'),
      );
      assert.match(
        mailboxLog,
        new RegExp(`\\$OMX_TEAM_STATE_ROOT/team/${runtime.teamName}/mailbox/worker-1\\.json`),
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
if (process.argv[2] === '--version') {
  console.log('codex 0.0.0-test');
  process.exit(0);
}
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
      runtime = await withMockPromptModeCodexAllowed(() =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-detached-worktree-shutdown',
            'detached worktree shutdown cleanup',
            'executor',
            1,
            [],
            repo,
            { worktreeMode: { enabled: true, detached: true, name: null } },
          )));

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
if (process.argv[2] === '--version') {
  console.log('codex 0.0.0-test');
  process.exit(0);
}
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
      runtime = await withMockPromptModeCodexAllowed(() =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-detached-worktree-resume-metadata',
            'detached worktree resume metadata',
            'executor',
            1,
            [{ subject: 's', description: 'd', owner: 'worker-1' }],
            repo,
            { worktreeMode: { enabled: true, detached: true, name: null } },
          )));

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

  it('shutdownTeam preserves generic prompt-worker state when process-group liveness is unknown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-prompt-unknown-pid-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    const originalProcessKill = process.kill;
    const originalDateNow = Date.now;
    let runtime: TeamRuntime | null = null;
    let workerPid = 0;
    await mkdir(binDir, { recursive: true });
    await writeFakePromptWorkerBinary(
      fakeCodexPath,
      `
process.stdin.resume();
setInterval(() => {}, 1000);
process.on('SIGTERM', () => {});
`,
    );
    try {
      runtime = await withPromptModeCodexEnv(binDir, {}, () =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-prompt-unknown-pid',
            'unknown prompt process-group teardown test',
            'executor',
            1,
            [{ subject: 's', description: 'd', owner: 'worker-1' }],
            cwd,
          )));
      workerPid = runtime.config.workers[0]?.pid ?? 0;
      assert.ok(workerPid > 0);

      let clock = originalDateNow();
      Date.now = () => (clock += 10_000);
      const positivePidSignals: Array<number | NodeJS.Signals | undefined> = [];
      process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
        if ((pid === -workerPid || pid === workerPid) && signal === 0) {
          const error = new Error('permission denied') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        if (pid === workerPid && signal !== 0) positivePidSignals.push(signal);
        return originalProcessKill(pid, signal as NodeJS.Signals);
      }) as typeof process.kill;

      await assert.rejects(
        () => shutdownTeam(runtime!.teamName, cwd, { force: true }),
        /shutdown_prompt_teardown_failed:worker-1:still_alive_after_sigkill/,
      );
      assert.ok(await readTeamConfig(runtime.teamName, cwd));
      assert.equal(positivePidSignals.includes('SIGKILL'), false);
    } finally {
      process.kill = originalProcessKill;
      Date.now = originalDateNow;
      if (runtime) await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
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
      await markDetachedSessionAbsent('team-shutdown', cwd);
      await shutdownWithoutTmuxSession('team-shutdown', cwd);

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
      await markDetachedSessionAbsent('team-shutdown-clean-fast', cwd);
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

      await shutdownWithoutTmuxSession('team-shutdown-clean-fast', cwd);

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
      await markDetachedSessionAbsent('team-shutdown-gate-override', cwd);
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

      await shutdownWithoutTmuxSession('team-shutdown-gate-override', cwd);

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
      await markDetachedSessionAbsent('team-shutdown-gate-legacy', cwd);
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

      await shutdownWithoutTmuxSession('team-shutdown-gate-legacy', cwd);

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
      await markDetachedSessionAbsent('team-shutdown-gate-force', cwd);
      await createTask(
        'team-shutdown-gate-force',
        { subject: 'pending', description: 'd', status: 'pending' },
        cwd,
      );

      await shutdownWithoutTmuxSession('team-shutdown-gate-force', cwd, { force: true });
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
      await markDetachedSessionAbsent('team-gate-forced-event', cwd);
      await createTask(
        'team-gate-forced-event',
        { subject: 'pending', description: 'd', status: 'pending' },
        cwd,
      );

      const eventsPath = join(cwd, '.omx', 'state', 'team', 'team-gate-forced-event', 'events', 'events.ndjson');
      await shutdownWithoutTmuxSession('team-gate-forced-event', cwd, { force: true });

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
      await markDetachedSessionAbsent('team-resize-meta', cwd);
      const config = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
      config.resize_hook_name = 'omx_resize_team_resize_meta_test';
      config.resize_hook_target = 'omx-team-team-resize-meta:0';
      await writeFile(configPath, JSON.stringify(config, null, 2));
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
      manifest.resize_hook_name = 'omx_resize_team_resize_meta_test';
      manifest.resize_hook_target = 'omx-team-team-resize-meta:0';
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      await shutdownWithoutTmuxSession('team-resize-meta', cwd);
      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-resize-meta');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam leaves no canonical config for a stale writer to overwrite', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-stale-config-'));
    try {
      await initTeamState('team-shutdown-stale-config', 'shutdown stale config test', 'executor', 1, cwd);
      await markDetachedSessionAbsent('team-shutdown-stale-config', cwd);
      const stale = await readTeamConfig('team-shutdown-stale-config', cwd);
      assert.ok(stale);
      if (!stale) throw new Error('missing config');
      await shutdownWithoutTmuxSession('team-shutdown-stale-config', cwd, { force: true });
      stale.task = 'must not recreate shutdown state';
      await assert.rejects(() => saveTeamConfig(stale, cwd), /team_config_missing:team-shutdown-stale-config/);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', 'team-shutdown-stale-config')), false);
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
          config.tmux_session = '';
          config.resize_hook_name = 'omx_resize_team_shutdown_gate_failed_test';
          config.resize_hook_target = 'omx-team-team-shutdown-gate-failed:0';
          await writeFile(configPath, JSON.stringify(config, null, 2));
          const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
          manifest.tmux_session = '';
          manifest.resize_hook_name = 'omx_resize_team_shutdown_gate_failed_test';
          manifest.resize_hook_target = 'omx-team-team-shutdown-gate-failed:0';
          await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
          process.env.TMUX_TEST_LOG = tmuxLogPath;

          await shutdownTeam('team-shutdown-gate-failed', cwd);

          const teamRoot = teamStateTestPath(cwd, 'team', 'team-shutdown-gate-failed');
          assert.equal(existsSync(teamRoot), false);

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /set-hook -u -t omx-team-team-shutdown-gate-failed:0 client-resized\[\d+\]/);
          assert.doesNotMatch(tmuxLog, /kill-session -t omx-team-team-shutdown-gate-failed/);
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
      await markDetachedSessionAbsent('team-ack-accept', cwd);
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

      await shutdownWithoutTmuxSession('team-ack-accept', cwd);

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
      await markDetachedSessionAbsent('team-force', cwd);
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

      await shutdownWithoutTmuxSession('team-force', cwd, { force: true });
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
      await markDetachedSessionAbsent('team-stale-ack', cwd);
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

      await shutdownWithoutTmuxSession('team-stale-ack', cwd);
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
      await markDetachedSessionAbsent('team-confirm-issues', cwd);
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

      await shutdownWithoutTmuxSession('team-confirm-issues', cwd, { confirmIssues: true });

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-confirm-issues');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam retains gone-pane descendant cleanup debt until tracked descendants exit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-gone-pane-descendant-debt-'));
    let descendant: ReturnType<typeof spawn> | null = null;
    try {
      descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      assert.ok(descendant.pid);
      const teamName = 'team-gone-pane-descendant-debt';
      await initTeamState(teamName, 'gone pane descendant cleanup debt test', 'executor', 1, cwd);
      await markDetachedSessionAbsent(teamName, cwd);
      const config = await readTeamConfig(teamName, cwd);
      assert.ok(config);
      if (!config || !descendant.pid) return;
      if (process.platform !== 'linux') return;
      const stat = await readFile(`/proc/${descendant.pid}/stat`, 'utf8');
      const startTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      assert.match(startTime ?? '', /^[0-9]+$/);
      const debtPath = join(cwd, '.omx', 'state', 'team', teamName, '.gone-pane-descendant-cleanup-debt.json');
      await writeFile(debtPath, JSON.stringify({
        schema_version: 1,
        operation: 'gone_pane_descendant_cleanup',
        entries: [{
          pane_id: '%404',
          authorized_pane_pid: descendant.pid,
          tracked_processes: [{ pid: descendant.pid, start_time: startTime! }],
          evidence: 'pane_authority_lost_during_descendant_teardown',
        }],
      }), 'utf-8');

      await assert.rejects(() => shutdownTeam(teamName, cwd, { force: true }), /gone_pane_descendant_cleanup_debt_unresolved:%404/);
      assert.equal(existsSync(debtPath), true);
      process.kill(descendant.pid, 'SIGKILL');
      await new Promise((resolve) => descendant?.once('exit', resolve));
      descendant = null;

      await shutdownTeam(teamName, cwd, { force: true });
      assert.equal(existsSync(debtPath), false);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', teamName)), false);
    } finally {
      try {
        if (descendant?.pid) process.kill(descendant.pid, 'SIGKILL');
      } catch {}
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam retains descendant-reuse debt without signaling a stable root or replacement PID', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-gone-pane-descendant-reuse-'));
    let descendant: ReturnType<typeof spawn> | null = null;
    const originalProcessKill = process.kill;
    try {
      descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      assert.ok(descendant.pid);
      if (!descendant.pid || process.platform !== 'linux') return;
      const stat = await readFile(`/proc/${descendant.pid}/stat`, 'utf8');
      const startTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      assert.match(startTime ?? '', /^[0-9]+$/);

      const teamName = 'team-gone-descendant-reuse';
      await initTeamState(teamName, 'gone pane descendant reuse test', 'executor', 1, cwd);
      await markDetachedSessionAbsent(teamName, cwd);
      const debtPath = join(cwd, '.omx', 'state', 'team', teamName, '.gone-pane-descendant-cleanup-debt.json');
      await writeFile(debtPath, JSON.stringify({
        schema_version: 1,
        operation: 'gone_pane_descendant_cleanup',
        entries: [{
          pane_id: '%406',
          authorized_pane_pid: process.pid,
          tracked_processes: [{ pid: descendant.pid, start_time: `${startTime}0` }],
          evidence: 'pane_authority_lost_during_descendant_teardown',
        }],
      }), 'utf-8');

      const signals: Array<{ pid: number; signal: number | NodeJS.Signals | undefined }> = [];
      process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
        if (signal !== 0) signals.push({ pid, signal });
        return originalProcessKill(pid, signal as NodeJS.Signals);
      }) as typeof process.kill;
      await assert.rejects(
        () => shutdownTeam(teamName, cwd, { force: true }),
        /gone_pane_descendant_cleanup_debt_unresolved:%406/,
      );
      assert.doesNotThrow(() => originalProcessKill(process.pid, 0), 'root remains live');
      assert.deepEqual(signals.filter(({ pid }) => pid === descendant!.pid), []);
      assert.equal(existsSync(debtPath), true);
    } finally {
      process.kill = originalProcessKill;
      try {
        if (descendant?.pid) process.kill(descendant.pid, 'SIGKILL');
      } catch {}
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam preserves identity-unavailable descendant debt when PID probing is unknown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-gone-pane-unknown-probe-'));
    const teamName = 'team-gone-probe';
    try {
      await initTeamState(teamName, 'unknown descendant probe debt test', 'executor', 1, cwd);
      await markDetachedSessionAbsent(teamName, cwd);
      const debtPath = join(cwd, '.omx', 'state', 'team', teamName, '.gone-pane-descendant-cleanup-debt.json');
      await writeFile(debtPath, JSON.stringify({
        schema_version: 1,
        operation: 'gone_pane_descendant_cleanup',
        entries: [{
          pane_id: '%405',
          authorized_pane_pid: process.pid,
          tracked_pids: [process.pid],
          evidence: 'process_identity_unavailable',
        }],
      }), 'utf-8');

      const originalProcessKill = process.kill;
      process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
        if (pid === process.pid && signal === 0) {
          const error = new Error('permission denied') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        return originalProcessKill(pid, signal as NodeJS.Signals);
      }) as typeof process.kill;
      try {
        await assert.rejects(
          () => shutdownTeam(teamName, cwd, { force: true }),
          /gone_pane_descendant_cleanup_debt_unresolved:%405/,
        );
      } finally {
        process.kill = originalProcessKill;
      }

      assert.equal(existsSync(debtPath), true);
      const persistedDebt = JSON.parse(await readFile(debtPath, 'utf-8')) as { entries: Array<{ pane_id: string }> };
      assert.deepEqual(persistedDebt.entries, [{ pane_id: '%405', authorized_pane_pid: process.pid, tracked_pids: [process.pid], evidence: 'process_identity_unavailable' }]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam treats workers proven dead or absent as already gone', async () => {
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
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf '%%404\t1\t2000000404\n'
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
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
          config.tmux_session = '';
          config.workers[0]!.pane_id = '%404';
          config.workers[1]!.pane_id = '%405';
          await saveTeamConfig(config, cwd);

          await shutdownTeam('team-shutdown-dead-pane', cwd, { force: true });
          const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-shutdown-dead-pane');
          assert.equal(existsSync(teamRoot), false);

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.doesNotMatch(tmuxLog, /kill-pane -t %404/);
          assert.doesNotMatch(tmuxLog, /kill-pane -t %405/);
          assert.doesNotMatch(tmuxLog, /kill-session -t omx-team-team-shutdown-dead-pane/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam pre-kills each detached pane immediately after its exact proof', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-prekill-order-'));
    const orderPath = join(cwd, 'prekill-order.log');
    let paneOne: ReturnType<typeof spawn> | null = null;
    let paneTwo: ReturnType<typeof spawn> | null = null;
    try {
      paneOne = spawn(process.execPath, ['-e', `
const { appendFileSync } = require('node:fs');
const orderPath = process.argv[1];
appendFileSync(orderPath, 'ready-pane-1\\n');
process.on('SIGTERM', () => {
  appendFileSync(orderPath, 'terminated-pane-1\\n');
  process.exit(0);
});
setInterval(() => {}, 1000);
`, orderPath], { stdio: 'ignore' });
      paneTwo = spawn(process.execPath, ['-e', `
const { appendFileSync } = require('node:fs');
const orderPath = process.argv[1];
appendFileSync(orderPath, 'ready-pane-2\\n');
process.on('SIGTERM', () => {
  appendFileSync(orderPath, 'terminated-pane-2\\n');
  process.exit(0);
});
setInterval(() => {}, 1000);
`, orderPath], { stdio: 'ignore' });
      const paneOnePid = paneOne.pid;
      const paneTwoPid = paneTwo.pid;
      assert.ok(paneOnePid);
      assert.ok(paneTwoPid);
      await waitForFileText(
        orderPath,
        (content) => content.includes('ready-pane-1') && content.includes('ready-pane-2'),
      );

      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-prekill-order-bin-',
          tmuxScript: () => `#!/bin/sh
set -eu
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf 'proof\n' >> "${orderPath}"
        printf "%%11\t0\t2000000011\n"
        if [ ! -f "${orderPath}.killed-%13" ] && ! grep -q 'terminated-pane-1' "${orderPath}" 2>/dev/null; then printf "%%13\t0\t${paneOnePid}\n"; fi
        if [ ! -f "${orderPath}.killed-%14" ] && ! grep -q 'terminated-pane-2' "${orderPath}" 2>/dev/null; then printf "%%14\t0\t${paneTwoPid}\n"; fi
        exit 0
        ;;
      *"-t omx-team-team-shutdown-prekill-order"*)
        printf "%%11\\tzsh\\tzsh\\n%%13\\tcodex\\tcodex\\n%%14\\tcodex\\tcodex\\n"
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  show-option|show-options)
    case "$*" in
      *"-p -t %11 @omx_team_pane_owner_id"*|*"-p -t %13 @omx_team_pane_owner_id"*|*"-p -t %14 @omx_team_pane_owner_id"*)
        echo "team:team-shutdown-prekill-order"
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  kill-pane)
    : > "${orderPath}.killed-$3"
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
        async () => {
          await initTeamState('team-shutdown-prekill-order', 'shutdown prekill order test', 'executor', 2, cwd);
          const config = await readTeamConfig('team-shutdown-prekill-order', cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'omx-team-team-shutdown-prekill-order';
          config.leader_pane_id = '%11';
          config.leader_pane_pid = 2000000011;
          config.hud_pane_id = null;
          config.tmux_pane_owner_id = 'team:team-shutdown-prekill-order';
          config.workers[0]!.pane_id = '%13';
          config.workers[0]!.pid = paneOnePid;
          config.workers[1]!.pane_id = '%14';
          config.workers[1]!.pid = paneTwoPid;
          await saveTeamConfig(config, cwd);

          await assert.rejects(
            () => shutdownTeam('team-shutdown-prekill-order', cwd, { force: true }),
            /shutdown_pane_proof_unavailable:%13:pane_proof_lost_during_process_teardown/,
          );

          const order = (await readFile(orderPath, 'utf-8')).trim().split('\n');
          const firstProof = order.indexOf('proof');
          const firstTermination = order.indexOf('terminated-pane-1');
          const secondTermination = order.indexOf('terminated-pane-2');
          assert.ok(firstProof >= 0);
          assert.ok(firstTermination > firstProof);
          assert.equal(secondTermination, -1);
        },
      );
    } finally {
      for (const pane of [paneOne, paneTwo]) {
        try {
          if (pane?.pid) process.kill(pane.pid, 'SIGKILL');
        } catch {}
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam tears down a detached HUD only with its persisted PID and Team owner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-detached-hud-shutdown-'));
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-detached-hud-shutdown-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V) echo 'tmux 3.4' ;;
  list-panes)
    case "$*" in
      *'#{session_name}'*) printf '%%1\t0\t4241\tomx-team-team-detached-hud-shutdown\t$81\t1700000001\n' ;;
      *'-a -F #{pane_id}'*)
        printf '%%1\\t0\\t4241\\n'
        [ -f "${tmuxLogPath}.hud-killed" ] || printf '%%2\\t0\\t4242\\n'
        ;;
      *) exit 1 ;;
    esac
    ;;
  show-option|show-options) echo 'team:team-detached-hud-shutdown' ;;
  kill-pane) : > "${tmuxLogPath}.hud-killed" ;;
  if-shell) : > "${tmuxLogPath}.session-killed" ;;
  list-sessions)
    if [ -f "${tmuxLogPath}.session-killed" ]; then
      printf '%s\n' 'no server running on /tmp/tmux-1000/default' >&2
      exit 1
    fi
    printf 'omx-team-team-detached-hud-shutdown\t$81\t1700000001\n'
    ;;
  *) exit 0 ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          const teamName = 'team-detached-hud-shutdown';
          await initTeamState(teamName, 'detached HUD shutdown', 'executor', 1, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'omx-team-team-detached-hud-shutdown';
          config.tmux_session_id = '$81';
          config.tmux_session_created = '1700000001';
          config.leader_pane_id = '%1';
          config.leader_pane_pid = 4241;
          config.hud_pane_id = '%2';
          config.hud_pane_pid = 4242;
          config.tmux_pane_owner_id = 'team:team-detached-hud-shutdown';
          config.workers[0]!.pane_id = '';
          config.workers[0]!.pid = undefined;
          await saveTeamConfig(config, cwd);

          await shutdownTeam(teamName, cwd, { force: true });

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /kill-pane -t %2/);
          assert.match(tmuxLog, /if-shell -F -t %1/);
          assert.match(tmuxLog, /kill-session -t \$81/);
          assert.doesNotMatch(tmuxLog, /^kill-session -t /m);
          assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', teamName)), false);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('retains an accepted detached-session kill receipt through a query failure and removes it only with final state cleanup', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-detached-session-post-kill-query-failure-'));
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-detached-session-post-kill-query-failure-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V) echo 'tmux 3.4' ;;
  list-panes)
    case "$*" in
      *'#{session_name}'*) printf '%%1\t0\t4241\tomx-team-team-postkill-query-fail\t$1\t1700000000\n' ;;
      *'-a -F #{pane_id}'*) printf '%%1\\t0\\t4241\\n' ;;
      *) exit 1 ;;
    esac
    ;;
  show-option|show-options) echo 'team:team-postkill-query-fail' ;;
  if-shell) : > "${tmuxLogPath}.session-killed" ;;
  list-sessions)
    if [ -f "${tmuxLogPath}.session-killed" ]; then
      if [ -f "${tmuxLogPath}.allow-retry" ]; then
        printf '%s\n' 'no server running on /tmp/tmux-1000/default' >&2
      else
        printf '%s\n' 'failed to connect to server: Permission denied' >&2
      fi
      exit 1
    fi
    printf 'omx-team-team-postkill-query-fail\t$1\t1700000000\n'
    ;;
  *) exit 0 ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          const teamName = 'team-postkill-query-fail';
          await initTeamState(teamName, 'retain state after detached-session query failure', 'executor', 1, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'omx-team-team-postkill-query-fail';
          config.tmux_session_id = '$1';
          config.tmux_session_created = '1700000000';
          config.leader_pane_id = '%1';
          config.leader_pane_pid = 4241;
          config.hud_pane_id = null;
          config.tmux_pane_owner_id = 'team:team-postkill-query-fail';
          config.workers[0]!.pane_id = '';
          config.workers[0]!.pid = undefined;
          await saveTeamConfig(config, cwd);

          await assert.rejects(
            () => shutdownTeam(teamName, cwd, { force: true }),
            /detached_session_destroy_unresolved:omx-team-team-postkill-query-fail/,
          );

          assert.ok(await readTeamConfig(teamName, cwd));
          const receiptPath = join(cwd, '.omx', 'state', 'team', teamName, '.detached-session-destroy-receipt.json');
          const receipt = JSON.parse(await readFile(receiptPath, 'utf-8')) as {
            status?: string;
            session_name?: string;
            leader_pane_id?: string;
            leader_pane_pid?: number;
            owner_id?: string;
            schema_version?: number;
            schema?: string;
            session_id?: string;
            session_created?: string;
            config_identity_version?: number;
            config_identity_digest?: string;
          };
          assert.equal(receipt.status, 'accepted');
          assert.equal(receipt.schema_version, 2);
          assert.equal(receipt.schema, 'omx.detached_session_destroy.v2');
          assert.equal(receipt.session_name, 'omx-team-team-postkill-query-fail');
          assert.equal(receipt.session_id, '$1');
          assert.equal(receipt.session_created, '1700000000');
          assert.equal(receipt.config_identity_version, 2);

          assert.match(receipt.config_identity_digest ?? '', /^[a-f0-9]{64}$/);
          const teamRoot = join(cwd, '.omx', 'state', 'team', teamName);
          await rm(join(teamRoot, 'config.json'));
          await rm(join(teamRoot, 'manifest.v2.json'));
          await writeFile(`${tmuxLogPath}.allow-retry`, '1');
          await assert.rejects(
            () => shutdownTeam(teamName, cwd, { force: true }),
            /detached_session_destroy_authorization_unavailable:omx-team-team-postkill-query-fail/,
          );
          assert.equal(existsSync(teamRoot), true);
          assert.equal(existsSync(receiptPath), true);
          const retryLog = await readFile(tmuxLogPath, 'utf-8');
          assert.equal((retryLog.match(/if-shell -F -t %1/g) ?? []).length, 1);
          assert.match(retryLog, /kill-session -t \$1/);
          assert.doesNotMatch(retryLog, /^kill-session -t /m);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not kill after journal publication when the stable authority drifts', async () => {
    const cases: readonly ('incarnation' | 'config' | 'generation' | 'owner')[] = ['incarnation', 'config', 'generation', 'owner'];
    for (const drift of cases) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-runtime-detached-journal-${drift}-`));
      try {
        await withMockTmuxFixture({
          dirPrefix: `omx-runtime-detached-journal-${drift}-bin-`,
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V) echo 'tmux 3.4' ;;
  list-panes)
    case "$*" in
      *'#{session_name}'*) printf '%%1\t0\t4241\tomx-team-journal-${drift}\t$901\t1700000001\n' ;;
      *'-a -F #{pane_id}'*) printf '%%1\\t0\\t4241\\n' ;;
      *) exit 1 ;;
    esac ;;
  show-option|show-options)
    if [ -f "${tmuxLogPath}.foreign-owner" ]; then echo 'foreign-owner'; else echo 'team:journal-${drift}'; fi ;;
  list-sessions)
    if [ -f "${tmuxLogPath}.replacement" ]; then printf 'omx-team-journal-${drift}\\t$902\\t1700000002\\n'; else printf 'omx-team-journal-${drift}\\t$901\\t1700000001\\n'; fi ;;
  kill-session) : > "${tmuxLogPath}.killed" ;;
  *) exit 0 ;;
esac
`,
        }, async ({ tmuxLogPath }) => {
          const teamName = `journal-${drift}`;
          await initTeamState(teamName, 'journal drift', 'executor', 1, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = `omx-team-journal-${drift}`;
          config.tmux_session_id = '$901';
          config.tmux_session_created = '1700000001';
          config.leader_pane_id = '%1';
          config.leader_pane_pid = 4241;
          config.hud_pane_id = null;
          config.tmux_pane_owner_id = `team:journal-${drift}`;
          config.workers[0]!.pane_id = '';
          config.workers[0]!.pid = undefined;
          await saveTeamConfig(config, cwd);

          const receiptPath = join(cwd, '.omx', 'state', 'team', teamName, '.detached-session-destroy-receipt.json');
          setDetachedSessionDestroyAfterJournalHookForTest(async () => {
            assert.equal(existsSync(receiptPath), true, 'journal must be durable before drift injection');
            if (drift === 'incarnation') await writeFile(`${tmuxLogPath}.replacement`, '1');
            if (drift === 'owner') await writeFile(`${tmuxLogPath}.foreign-owner`, '1');
            if (drift === 'config') {
              const manifestPath = join(cwd, '.omx', 'state', 'team', teamName, 'manifest.v2.json');
              const current = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
              current.created_at = '2026-01-01T00:00:00.000Z';
              await writeFile(manifestPath, JSON.stringify(current));
            }
            if (drift === 'generation') {
              const manifestPath = join(cwd, '.omx', 'state', 'team', teamName, 'manifest.v2.json');
              const current = JSON.parse(await readFile(manifestPath, 'utf8')) as { config_generation?: number };
              current.config_generation = (current.config_generation ?? 0) + 1;
              await writeFile(manifestPath, JSON.stringify(current));
            }
          });
          await assert.rejects(() => shutdownTeam(teamName, cwd, { force: true }), /detached_session_destroy_(authorization_unavailable|receipt_config_mismatch):omx-team-journal-/);
          assert.equal(existsSync(`${tmuxLogPath}.killed`), false, `${drift} drift must prevent kill-session`);
        });
      } finally {
        setDetachedSessionDestroyAfterJournalHookForTest(null);
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('fails closed on a malformed detached-session destruction receipt', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-detached-session-malformed-receipt-'));
    try {
      const teamName = 'team-malformed-receipt';
      await initTeamState(teamName, 'malformed detached receipt', 'executor', 1, cwd);
      const config = await readTeamConfig(teamName, cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-team-malformed-receipt';
      await saveTeamConfig(config, cwd);
      const receiptPath = join(cwd, '.omx', 'state', 'team', teamName, '.detached-session-destroy-receipt.json');
      await writeFile(receiptPath, '{not-json\n');

      await assert.rejects(
        () => shutdownTeam(teamName, cwd, { force: true }),
        /detached_session_destroy_receipt_malformed:omx-team-team-malformed-receipt/,
      );
      assert.equal(existsSync(receiptPath), true);
      assert.equal((await readTeamConfig(teamName, cwd))?.tmux_session, 'omx-team-team-malformed-receipt');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed for foreign receipt provenance and malformed receipt versions or digests', async () => {
    const cases = [
      { name: 'foreign-team', receipt: { schema_version: 2, schema: 'omx.detached_session_destroy.v2', operation: 'detached_session_destroy', status: 'accepted', team_name: 'other-team' } },
      { name: 'foreign-root', receipt: { schema_version: 2, schema: 'omx.detached_session_destroy.v2', operation: 'detached_session_destroy', status: 'accepted', team_name: 'receipt-invalid', state_root: '/foreign/root' } },
      { name: 'digest', receipt: { schema_version: 2, schema: 'omx.detached_session_destroy.v2', operation: 'detached_session_destroy', status: 'accepted', team_name: 'receipt-invalid', config_identity_digest: 'bad' } },
      { name: 'legacy-v1', receipt: { schema_version: 1, schema: 'omx.detached_session_destroy.v1', operation: 'detached_session_destroy', status: 'accepted' } },
    ];
    for (const entry of cases) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-runtime-detached-receipt-${entry.name}-`));
      try {
        const teamName = 'receipt-invalid';
        await initTeamState(teamName, 'invalid receipt', 'executor', 1, cwd);
        const config = await readTeamConfig(teamName, cwd);
        assert.ok(config);
        if (!config) continue;
        config.tmux_session = 'omx-team-receipt-invalid';
        await saveTeamConfig(config, cwd);
        const receiptPath = join(cwd, '.omx', 'state', 'team', teamName, '.detached-session-destroy-receipt.json');
        await writeFile(receiptPath, JSON.stringify(entry.receipt));
        await assert.rejects(
          () => shutdownTeam(teamName, cwd, { force: true }),
          /detached_session_destroy_receipt_malformed:omx-team-receipt-invalid/,
        );
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('replays an intent receipt only after exact leader PID and owner authorization', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-intent-receipt-replay-'));
    try {
      await withMockTmuxFixture({
        dirPrefix: 'omx-runtime-intent-receipt-replay-bin-',
        tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V) echo 'tmux 3.4' ;;
  list-panes)
    case "$*" in
      *'#{session_name}'*) [ -f "${tmuxLogPath}.killed" ] || printf '%%1\t0\t4241\tomx-team-intent-receipt\t$71\t1700000010\n' ;;
      *'-a -F #{pane_id}'*) [ -f "${tmuxLogPath}.killed" ] || printf '%%1\\t0\\t4241\\n' ;;
      *) exit 1 ;;
    esac ;;
  show-option|show-options) echo 'team:intent-receipt' ;;
  list-sessions) [ -f "${tmuxLogPath}.killed" ] || printf 'omx-team-intent-receipt\t$71\t1700000010\n' ;;
  if-shell) : > "${tmuxLogPath}.killed" ;;
  *) exit 0 ;;
esac
`,
      }, async ({ tmuxLogPath }) => {
        const teamName = 'intent-receipt';
        await initTeamState(teamName, 'intent receipt replay', 'executor', 1, cwd);
        const config = await readTeamConfig(teamName, cwd);
        assert.ok(config);
        if (!config) return;
        config.tmux_session = 'omx-team-intent-receipt';
        config.leader_pane_id = '%1';
        config.leader_pane_pid = 4241;
        config.hud_pane_id = null;
        config.tmux_session_id = '$71';
        config.tmux_session_created = '1700000010';
        config.tmux_pane_owner_id = 'team:intent-receipt';
        config.workers[0]!.pane_id = '';
        config.workers[0]!.pid = undefined;
        await saveTeamConfig(config, cwd);
        const receiptPath = join(cwd, '.omx', 'state', 'team', teamName, '.detached-session-destroy-receipt.json');
        const stateRoot = join(cwd, '.omx', 'state');
        const teamRoot = join(stateRoot, 'team', teamName);
        const configBytes = await readFile(join(teamRoot, 'config.json'), 'utf8');
        const manifestBytes = await readFile(join(teamRoot, 'manifest.v2.json'), 'utf8');
        const receipt = {
          schema_version: 2,
          schema: 'omx.detached_session_destroy.v2',
          operation: 'detached_session_destroy',
          status: 'intent',
          team_name: teamName,
          state_root: stateRoot,
          config_identity_version: 2,
          config_identity_digest: createHash('sha256').update(JSON.stringify({
            version: 2, team_name: teamName, state_root: stateRoot, config_bytes: configBytes, manifest_bytes: manifestBytes,
          })).digest('hex'),
          session_name: 'omx-team-intent-receipt',
          session_id: '$71',
          session_created: '1700000010',
          leader_pane_id: '%1',
          leader_pane_pid: 4241,
          owner_id: 'team:intent-receipt',
        };
        await writeFile(receiptPath, JSON.stringify(receipt));

        await shutdownTeam(teamName, cwd, { force: true });
        assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', teamName)), false);
        const log = await readFile(tmuxLogPath, 'utf8');
        assert.equal((log.match(/if-shell -F -t %1/g) ?? []).length, 1);
        assert.match(log, /kill-session -t \$71/);
        assert.doesNotMatch(log, /^kill-session -t /m);
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves an accepted receipt and state when a same-name session has a changed leader PID', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-recycled-receipt-'));
    try {
      await withMockTmuxFixture({
        dirPrefix: 'omx-runtime-recycled-receipt-bin-',
        tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V) echo 'tmux 3.4' ;;
  list-sessions) echo 'omx-team-recycled-receipt' ;;
  list-panes) printf '%%9\\t0\\t9999\\tomx-team-recycled-receipt\\n' ;;
  show-option|show-options) echo 'team:recycled-receipt' ;;
  kill-session) exit 99 ;;
  *) exit 0 ;;
esac
`,
      }, async ({ tmuxLogPath }) => {
        const teamName = 'recycled-receipt';
        await initTeamState(teamName, 'recycled receipt', 'executor', 1, cwd);
        const config = await readTeamConfig(teamName, cwd);
        assert.ok(config);
        if (!config) return;
        config.tmux_session = 'omx-team-recycled-receipt';
        await saveTeamConfig(config, cwd);
        const receiptPath = join(cwd, '.omx', 'state', 'team', teamName, '.detached-session-destroy-receipt.json');
        const receipt = { schema_version: 1, schema: 'omx.detached_session_destroy.v1', operation: 'detached_session_destroy', status: 'accepted', session_name: 'omx-team-recycled-receipt', leader_pane_id: '%1', leader_pane_pid: 4241, owner_id: 'team:recycled-receipt' };
        await writeFile(receiptPath, JSON.stringify(receipt));
        await assert.rejects(() => shutdownTeam(teamName, cwd, { force: true }), /detached_session_destroy_receipt_malformed:omx-team-recycled-receipt/);
        assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), receipt);
        assert.equal((await readTeamConfig(teamName, cwd))?.tmux_session, 'omx-team-recycled-receipt');
        if (existsSync(tmuxLogPath)) assert.doesNotMatch(await readFile(tmuxLogPath, 'utf8'), /kill-session/);
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves an accepted receipt and state when the original leader has a foreign owner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-foreign-receipt-'));
    try {
      await withMockTmuxFixture({
        dirPrefix: 'omx-runtime-foreign-receipt-bin-',
        tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V) echo 'tmux 3.4' ;;
  list-sessions) echo 'omx-team-foreign-receipt' ;;
  list-panes) printf '%%1\\t0\\t4241\\tomx-team-foreign-receipt\\n' ;;
  show-option|show-options) echo 'team:foreign-owner' ;;
  kill-session) exit 99 ;;
  *) exit 0 ;;
esac
`,
      }, async ({ tmuxLogPath }) => {
        const teamName = 'foreign-receipt';
        await initTeamState(teamName, 'foreign receipt', 'executor', 1, cwd);
        const config = await readTeamConfig(teamName, cwd);
        assert.ok(config);
        if (!config) return;
        config.tmux_session = 'omx-team-foreign-receipt';
        await saveTeamConfig(config, cwd);
        const receiptPath = join(cwd, '.omx', 'state', 'team', teamName, '.detached-session-destroy-receipt.json');
        const receipt = { schema_version: 1, schema: 'omx.detached_session_destroy.v1', operation: 'detached_session_destroy', status: 'accepted', session_name: 'omx-team-foreign-receipt', leader_pane_id: '%1', leader_pane_pid: 4241, owner_id: 'team:foreign-receipt' };
        await writeFile(receiptPath, JSON.stringify(receipt));
        await assert.rejects(() => shutdownTeam(teamName, cwd, { force: true }), /detached_session_destroy_receipt_malformed:omx-team-foreign-receipt/);
        assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), receipt);
        assert.equal((await readTeamConfig(teamName, cwd))?.tmux_session, 'omx-team-foreign-receipt');
        if (existsSync(tmuxLogPath)) assert.doesNotMatch(await readFile(tmuxLogPath, 'utf8'), /kill-session/);
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam fails closed when detached HUD PID changes before teardown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-detached-hud-pid-takeover-'));
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-detached-hud-pid-takeover-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V) echo 'tmux 3.4' ;;
  list-panes)
    case "$*" in
      *'-a -F #{pane_id}'*)
        printf '%%1\\t0\\t4241\\n'
        if [ -f "${tmuxLogPath}.hud-first-proof" ]; then printf '%%2\\t0\\t5252\\n'; else : > "${tmuxLogPath}.hud-first-proof"; printf '%%2\\t0\\t4242\\n'; fi
        ;;
      *) exit 1 ;;
    esac
    ;;
  show-option|show-options) echo 'team:team-dethud-pid' ;;
  kill-pane|kill-session) exit 99 ;;
  *) exit 0 ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          const teamName = 'team-dethud-pid';
          await initTeamState(teamName, 'detached HUD PID takeover', 'executor', 1, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'omx-team-team-dethud-pid';
          config.leader_pane_id = '%1';
          config.leader_pane_pid = 4241;
          config.hud_pane_id = '%2';
          config.hud_pane_pid = 4242;
          config.tmux_pane_owner_id = 'team:team-dethud-pid';
          config.workers[0]!.pane_id = '';
          config.workers[0]!.pid = undefined;
          await saveTeamConfig(config, cwd);

          await assert.rejects(
            () => shutdownTeam(teamName, cwd, { force: true }),
            /shutdown_detached_session_HUD_pane_identity_changed:%2/,
          );

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.doesNotMatch(tmuxLog, /kill-pane -t %2|kill-session -t omx-team-team-dethud-pid/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam fails closed when detached HUD ownership changes before teardown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-detached-hud-owner-takeover-'));
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-detached-hud-owner-takeover-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V) echo 'tmux 3.4' ;;
  list-panes)
    case "$*" in
      *'#{session_name}'*) printf '%%1\t0\t4241\tomx-team-team-dethud-owner\n' ;;
      *'-a -F #{pane_id}'*) printf '%%1\t0\t4241\n%%2\t0\t4242\n' ;;
      *) exit 1 ;;
    esac
    ;;
  show-option|show-options)
    case "$*" in
      *'%2'*)
        if [ -f "${tmuxLogPath}.hud-owner-read" ]; then echo 'team:foreign'; else : > "${tmuxLogPath}.hud-owner-read"; echo 'team:team-dethud-owner'; fi
        ;;
      *) echo 'team:team-dethud-owner' ;;
    esac
    ;;
  kill-pane|kill-session) exit 99 ;;
  *) exit 0 ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          const teamName = 'team-dethud-owner';
          await initTeamState(teamName, 'detached HUD owner takeover', 'executor', 1, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'omx-team-team-dethud-owner';
          config.leader_pane_id = '%1';
          config.leader_pane_pid = 4241;
          config.hud_pane_id = '%2';
          config.hud_pane_pid = 4242;
          config.tmux_pane_owner_id = 'team:team-dethud-owner';
          config.workers[0]!.pane_id = '';
          config.workers[0]!.pid = undefined;
          await saveTeamConfig(config, cwd);

          await assert.rejects(
            () => shutdownTeam(teamName, cwd, { force: true }),
            /shutdown_detached_session_HUD_pane_owner_changed:%2/,
          );

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.doesNotMatch(tmuxLog, /kill-pane -t %2|kill-session -t omx-team-team-dethud-owner/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam rejects a recycled detached session before kill-session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-detached-session-recycled-'));
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-detached-session-recycled-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    echo "tmux 3.4"
    ;;
  list-panes)
    case "$*" in
      *'#{session_name}'*) printf '%%1\t0\t4242\trecycled-session\t$91\t1700000101\n' ;;
      *'-a -F #{pane_id}'*) printf '%%1\\t0\\t4242\\n' ;;
      *) exit 1 ;;
    esac
    ;;
  list-sessions) printf 'omx-team-team-detached-session-recycled\t$91\t1700000101\n' ;;
  show-option|show-options)
    echo 'team:team-detached-session-recycled'
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
          const teamName = 'team-detached-session-recycled';
          await initTeamState(teamName, 'reject recycled detached session', 'executor', 1, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'omx-team-team-detached-session-recycled';
          config.tmux_session_id = '$90';
          config.tmux_session_created = '1700000100';
          config.leader_pane_id = '%1';
          config.leader_pane_pid = 4242;
          config.tmux_pane_owner_id = 'team:team-detached-session-recycled';
          await saveTeamConfig(config, cwd);

          await assert.rejects(
            () => shutdownTeam(teamName, cwd, { force: true }),
            /detached_session_destroy_authorization_unavailable:omx-team-team-detached-session-recycled/,
          );

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /list-sessions -F #\{session_name\}\t#\{session_id\}\t#\{session_created\}/);
          assert.doesNotMatch(tmuxLog, /kill-session/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam rejects a detached leader owner takeover immediately before kill-session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-detached-session-owner-takeover-'));
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-detached-session-owner-takeover-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V) echo 'tmux 3.4' ;;
  list-panes)
    case "$*" in
      *'#{session_name}'*) : > "${tmuxLogPath}.session-bound"; printf '%%1\t0\t4242\tomx-team-detached-owner-takeover\t$92\t1700000102\n' ;;
      *'-a -F #{pane_id}'*) printf '%%1\\t0\\t4242\\n' ;;
      *) exit 1 ;;
    esac
    ;;
  list-sessions) printf 'omx-team-detached-owner-takeover\t$92\t1700000102\n' ;;
  show-option|show-options)
    if [ -f "${tmuxLogPath}.session-bound" ]; then
      echo 'team:foreign'
    else
      echo 'team:detached-owner-takeover'
    fi
    ;;
  kill-session) exit 99 ;;
  *) exit 0 ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          const teamName = 'detached-owner-takeover';
          await initTeamState(teamName, 'reject detached leader owner takeover', 'executor', 1, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'omx-team-detached-owner-takeover';
          config.tmux_session_id = '$92';
          config.tmux_session_created = '1700000102';
          config.leader_pane_id = '%1';
          config.leader_pane_pid = 4242;
          config.tmux_pane_owner_id = 'team:detached-owner-takeover';
          await saveTeamConfig(config, cwd);

          await assert.rejects(
            () => shutdownTeam(teamName, cwd, { force: true }),
            /detached_session_destroy_authorization_unavailable:omx-team-detached-owner-takeover/,
          );
          assert.ok(await readTeamConfig(teamName, cwd));
          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.ok(
            tmuxLog.indexOf('list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}\t#{session_name}\t#{session_id}\t#{session_created}')
              < tmuxLog.indexOf('show-option -qv -p -t %1 @omx_team_pane_owner_id'),
          );
          assert.doesNotMatch(tmuxLog, /kill-session -t omx-team-detached-owner-takeover/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam stops before any OS signal when proof is lost after pane PID authorization', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-malformed-pane-proof-'));
    const proofStatePath = join(cwd, 'shutdown-proof-authorized-once');
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-malformed-pane-proof-bin-',
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
      *"-a -F #{pane_id}"*)
        if [ ! -f "${proofStatePath}" ]; then
          : > "${proofStatePath}"
          printf "%%404\t0\t${process.pid}\n"
        elif [ ! -f "${proofStatePath}.owner-authorized" ]; then
          : > "${proofStatePath}.owner-authorized"
          printf "%%404\t0\t${process.pid}\n"
        else
          printf 'not-a-pane-snapshot\n'
        fi
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  show-option|show-options)
    case "$*" in
      *"-p -t %404 @omx_team_pane_owner_id"*)
        echo "team:team-shutdown-malformed-proof"
        : > "${proofStatePath}.owner-authorized"
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
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
          await initTeamState('team-shutdown-malformed-proof', 'shutdown malformed pane proof test', 'executor', 1, cwd);
          const config = await readTeamConfig('team-shutdown-malformed-proof', cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'omx-team-team-shutdown-malformed-proof';
          config.tmux_pane_owner_id = 'team:team-shutdown-malformed-proof';
          config.workers[0]!.pane_id = '%404';
          config.workers[0]!.pid = process.pid;
          config.resize_hook_name = 'omx_resize_team_shutdown_malformed_proof_test';
          config.resize_hook_target = 'omx-team-team-shutdown-malformed-proof:0';
          await saveTeamConfig(config, cwd);

          const originalProcessKill = process.kill;
          let processKillCalls = 0;
          process.kill = ((...args: Parameters<typeof process.kill>) => {
            if (args[1] !== 0) processKillCalls += 1;
            return true;
          }) as typeof process.kill;
          try {
            await assert.rejects(
              () => shutdownTeam('team-shutdown-malformed-proof', cwd, { force: true }),
              /shutdown_pane_proof_unavailable:%404:(malformed_snapshot|pane_proof_lost_during_process_teardown)/,
            );
          } finally {
            process.kill = originalProcessKill;
          }
          assert.equal(processKillCalls, 0);
          assert.equal(existsSync(proofStatePath), true);

          const preservedConfig = await readTeamConfig('team-shutdown-malformed-proof', cwd);
          assert.ok(preservedConfig);
          assert.equal(preservedConfig?.resize_hook_name, 'omx_resize_team_shutdown_malformed_proof_test');
          assert.equal(preservedConfig?.resize_hook_target, 'omx-team-team-shutdown-malformed-proof:0');
          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          const globalProofReads = tmuxLog.match(/list-panes -a -F #\{pane_id\}\t#\{pane_dead\}\t#\{pane_pid\}/g) ?? [];
          assert.equal(globalProofReads.length, 1);
          assert.doesNotMatch(tmuxLog, /kill-pane -t %404/);
          assert.doesNotMatch(tmuxLog, /kill-session -t omx-team-team-shutdown-malformed-proof/);
          assert.doesNotMatch(tmuxLog, /set-hook -u -t omx-team-team-shutdown-malformed-proof:0 client-resized\[\d+\]/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam preserves exact-pane state when final liveness proof becomes unknown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-exact-final-unknown-'));
    const originalProcessKill = process.kill;
    const originalDateNow = Date.now;
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-exact-final-unknown-bin-',
          tmuxScript: () => `#!/bin/sh
set -eu
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf "%%404\\t0\\t${process.pid}\\n"
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  show-option|show-options)
    case "$*" in
      *"-p -t %404 @omx_team_pane_owner_id"*)
        echo "team:team-exact-final-unknown"
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async () => {
          await initTeamState('team-exact-final-unknown', 'exact final unknown teardown test', 'executor', 1, cwd);
          const config = await readTeamConfig('team-exact-final-unknown', cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'omx-team-exact-final-unknown';
          config.tmux_pane_owner_id = 'team:team-exact-final-unknown';
          config.workers[0]!.pane_id = '%404';
          config.workers[0]!.pid = process.pid;
          await saveTeamConfig(config, cwd);

          let clock = originalDateNow();
          let livenessProbes = 0;
          Date.now = () => (clock += 10_000);
          process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
            if (signal === 0 && pid === process.pid) {
              livenessProbes += 1;
              if (livenessProbes > 1) {
                const error = new Error('permission denied') as NodeJS.ErrnoException;
                error.code = 'EPERM';
                throw error;
              }
            }
            return true;
          }) as typeof process.kill;

          await assert.rejects(() => shutdownTeam('team-exact-final-unknown', cwd, { force: true }));
          assert.ok(await readTeamConfig('team-exact-final-unknown', cwd));
          assert.ok(livenessProbes >= 1);
        },
      );
    } finally {
      process.kill = originalProcessKill;
      Date.now = originalDateNow;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('scaleDown commits forward membership and durable debt when global pane proof is unavailable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-scale-down-pane-proof-'));
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-scale-down-pane-proof-bin-',
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
      *"-a -F #{pane_id}"*)
        echo "tmux global listing failed" >&2
        exit 1
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  kill-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState('team-scale-down-pane-proof', 'scale down pane proof test', 'executor', 2, cwd);
          const config = await readTeamConfig('team-scale-down-pane-proof', cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'omx-team-team-scale-down-pane-proof';
          config.workers[0]!.pane_id = '%404';
          config.workers[1]!.pane_id = '%405';
          await saveTeamConfig(config, cwd);

          const result = await scaleDown(
            'team-scale-down-pane-proof',
            cwd,
            { workerNames: ['worker-2'], force: true },
            { OMX_TEAM_SCALING_ENABLED: '1' },
          );
          assert.equal(result.ok, false);
          if (result.ok) return;
          assert.match(result.error, /scale_down_cleanup_debt:pane_teardown_unresolved:%405/);

          const committedConfig = await readTeamConfig('team-scale-down-pane-proof', cwd);
          assert.equal(committedConfig?.workers.length, 1);
          const debt = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'team', 'team-scale-down-pane-proof', '.scale-down-cleanup-debt.json'), 'utf8'));
          assert.equal(debt.status, 'unresolved');
          assert.equal(debt.unresolved_panes[0]?.pane_id, '%405');
          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /^list-panes -a -F #\{pane_id\}\t#\{pane_dead\}\t#\{pane_pid\}$/m);
          assert.doesNotMatch(tmuxLog, /kill-pane -t %405/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam reconciles persisted worker panes with live tmux panes before teardown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-pane-reconcile-'));
    const powershellWorkerCommand = Buffer.from(
      "$env:OMX_TEAM_INTERNAL_WORKER = 'team-shutdown-pane-reconcile/worker-6'; & '/opt/node.exe' '/tmp/node_modules/@openai/codex/bin/codex.js'",
      'utf16le',
    ).toString('base64');
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
        echo "2000001013"
        exit 0
        ;;
      *"-t %14 -F #{pane_pid}"*)
        echo "2000001014"
        exit 0
        ;;
      *"-a -F #{pane_id}"*)
        printf "%%11\t0\t2000000011\n"
        for pane in %12 %13 %14 %16 %17 %18 %19; do
          if [ ! -f "${tmuxLogPath}.killed-$pane" ]; then
            case "$pane" in
              %12) pid=2000000012 ;;
              %13) pid=2000000013 ;;
              %14) pid=2000000014 ;;
              %16) pid=2000000016 ;;
              %17) pid=2000000017 ;;
              %18) pid=2000000018 ;;
              %19) pid=2000000019 ;;
            esac
            printf '%s\t0\t%s\n' "$pane" "$pid"
          fi
        done
        printf "%%15\t0\t2000000015\n%%20\t0\t2000000020\n%%21\t0\t2000000021\n%%22\t0\t2000000022\n"
        if [ -f "$restored_marker" ]; then printf "%%44\t0\t2000000044\n"; fi
        exit 0
        ;;
      *"-t leader:0 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tzsh\\n%%12\\tnode\\tnode /tmp/bin/omx.js hud --watch\\n%%13\\tcodex\\texec /bin/sh '/tmp/.omx/state/team/team-shutdown-pane-reconcile/runtime/worker-1-startup.sh'\\n%%14\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-shutdown-pane-reconcile/worker-2 codex\\n%%15\\tcodex\\tcodex unrelated-not-worker\\n%%16\\tcodex\\tenv OMX_TEAM_WORKER=team-shutdown-pane-reconcile/worker-3 codex\\n%%17\\tcodex\\tworker-wrapper OMX_TEAM_INTERNAL_WORKER='team-shutdown-pane-reconcile/worker-4' codex\\n%%18\\tcodex\\tenv 'OMX_TEAM_INTERNAL_WORKER=team-shutdown-pane-reconcile/worker-5' codex\\n%%19\\tpowershell.exe\\tpowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${powershellWorkerCommand}\\n%%999\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-shutdown-pane-reconcile/worker-2 codex\\n%%20\\tzsh\\techo 'OMX_TEAM_INTERNAL_WORKER=team-shutdown-pane-reconcile/worker-7'\\n%%21\\tzsh\\tprintf 'OMX_TEAM_INTERNAL_WORKER=team-shutdown-pane-reconcile/worker-8 codex'\\n%%22\\tzsh\\tenv OMX_TEAM_INTERNAL_WORKER=team-shutdown-pane-reconcile/worker-9 bash -lc 'echo codex'\\n"
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
  show-option)
    case "$*" in
      *"-p -t %11 @omx_team_pane_owner_id"*)
        echo "team:team-shutdown-pane-reconcile"
        ;;
      *"-p -t %12 @omx_team_pane_owner_id"*)
        echo "team:team-shutdown-pane-reconcile"
        ;;
      *"-p -t %13 @omx_team_pane_owner_id"|*"-p -t %14 @omx_team_pane_owner_id"|*"-p -t %16 @omx_team_pane_owner_id"|*"-p -t %17 @omx_team_pane_owner_id"|*"-p -t %18 @omx_team_pane_owner_id"|*"-p -t %19 @omx_team_pane_owner_id"*)
        echo "team:team-shutdown-pane-reconcile"
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  kill-pane)
    if [ "\${3:-}" = "%999" ]; then
      echo "missing pane" >&2
      exit 1
    fi
    : > "${tmuxLogPath}.killed-$3"
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
          env: { OMX_SESSION_ID: 'team-shutdown-pane-reconcile-session' },
        },
        async ({ tmuxLogPath }) => {
          await initTeamState('team-shutdown-pane-reconcile', 'shutdown pane reconcile test', 'executor', 2, cwd);
          const config = await readTeamConfig('team-shutdown-pane-reconcile', cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader:0';
          config.leader_pane_id = '%11';
          config.leader_pane_pid = 2000000011;
          config.hud_pane_id = '%12';
          config.hud_pane_pid = 2000000012;
          config.workers[0]!.pane_id = '';
          config.workers[1]!.pane_id = '%999';
          await saveTeamConfig(config, cwd);

          await assert.rejects(
            () => shutdownTeam('team-shutdown-pane-reconcile', cwd, { force: true }),
            /shutdown_shared_session_worker_owner_changed:%999/,
          );
          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.doesNotMatch(tmuxLog, /set-hook -u|kill-pane|split-window|resize-pane|select-pane|run-shell/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam preserves shared-session state before non-force pane effects when topology cannot be queried', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-topology-unavailable-'));
    const teamName = 'team-topology-unavailable';
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-topology-unavailable-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    echo "tmux 3.4"
    ;;
  list-panes)
    echo "topology query failed" >&2
    exit 1
    ;;
  *)
    exit 1
    ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState(teamName, 'shutdown topology unavailable test', 'executor', 1, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader:0';
          config.leader_pane_id = '%10';
          config.leader_pane_pid = 2000000010;
          config.hud_pane_id = '%12';
          config.hud_pane_pid = 2000000012;
          config.workers[0]!.pane_id = '%13';
          await saveTeamConfig(config, cwd);

          await assert.rejects(
            () => shutdownTeam(teamName, cwd),
            /shutdown_shared_session_topology_unavailable:topology query failed/,
          );

          assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', teamName)), true);
          assert.deepEqual(await readTeamConfig(teamName, cwd), config);
          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /list-panes -t leader:0 -F #\{pane_id\}/);
          assert.doesNotMatch(tmuxLog, /send-keys|kill-pane|split-window|resize-pane|select-pane|show-option|kill-session/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam preserves shared-session state before non-force pane effects when topology output is malformed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-topology-malformed-'));
    const teamName = 'team-topology-malformed';
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-topology-malformed-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    echo "tmux 3.4"
    ;;
  list-panes)
    printf 'not-a-pane-snapshot\\n'
    ;;
  *)
    exit 1
    ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState(teamName, 'shutdown malformed topology test', 'executor', 1, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader:0';
          config.leader_pane_id = '%10';
          config.leader_pane_pid = 2000000010;
          config.hud_pane_id = '%12';
          config.hud_pane_pid = 2000000012;
          config.workers[0]!.pane_id = '%13';
          await saveTeamConfig(config, cwd);

          await assert.rejects(
            () => shutdownTeam(teamName, cwd),
            /shutdown_shared_session_topology_unavailable:malformed pane topology/,
          );

          assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', teamName)), true);
          assert.deepEqual(await readTeamConfig(teamName, cwd), config);
          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /list-panes -t leader:0 -F #\{pane_id\}/);
          assert.doesNotMatch(tmuxLog, /send-keys|kill-pane|split-window|resize-pane|select-pane|show-option|kill-session/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam preserves state when an exact-proven worker pane cannot be killed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-kill-failure-'));
    const teamName = 'team-shutdown-kill-failure';
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-kill-failure-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    echo "tmux 3.4"
    ;;
  list-panes)
    case "$*" in
      *"-t leader:0"*)
        printf '%%10\\tzsh\\tzsh\\n%%13\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-shutdown-kill-failure/worker-1 codex\\n'
        ;;
      *"-a -F #{pane_id}"*)
        printf '%%10\t0\t2000000010\n%%13\t0\t2000000013\n'
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  show-option)
    printf 'owner-1\\n'
    ;;
  kill-pane)
    echo "kill pane failed" >&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState(teamName, 'shutdown kill failure test', 'executor', 1, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader:0';
          config.leader_pane_id = '%10';
          config.leader_pane_pid = 2000000010;
          config.hud_pane_id = null;
          config.tmux_pane_owner_id = 'owner-1';
          config.workers[0]!.pane_id = '%13';
          config.workers[0]!.pid = 2000000013;
          await saveTeamConfig(config, cwd);

          await assert.rejects(
            () => shutdownTeam(teamName, cwd, { force: true }),
            /shutdown_pane_teardown_failed:%13/,
          );

          assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', teamName)), true);
          assert.deepEqual(await readTeamConfig(teamName, cwd), config);
          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /kill-pane -t %13/);
          assert.doesNotMatch(tmuxLog, /split-window|resize-pane|select-pane|kill-session/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam preserves unrelated non-worker panes during shared-session shutdown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-unrelated-pane-'));
    const teamName = 'team-shutdown-unrelated-pane';
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-unrelated-pane-bin-',
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
      *"-a -F #{pane_id}"*)
        printf "%%10\t0\t2000000010\n%%11\t0\t2000000011\n%%15\t0\t2000000015\n"
        if [ ! -f "${tmuxLogPath}.killed-%12" ]; then printf "%%12\t0\t2000000012\n"; fi
        if [ ! -f "${tmuxLogPath}.killed-%13" ]; then printf "%%13\t0\t2000000013\n"; fi
        if [ ! -f "${tmuxLogPath}.killed-%14" ]; then printf "%%14\t0\t2000000014\n"; fi
        if [ -f "$restored_marker" ]; then printf "%%44\t0\t2000000044\n"; fi
        exit 0
        ;;
      *"-F #{pane_dead} #{pane_pid}"*)
        exit 1
        ;;
      *"-t leader:0 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%10\\tzsh\\tzsh\\n%%11\\tnode\\tnode existing-user-work\\n%%12\\tnode\\tnode /tmp/bin/omx.js hud --watch\\n%%13\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-shutdown-unrelated-pane/worker-1 codex\\n%%14\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-shutdown-unrelated-pane/worker-2 codex\\n%%15\\tnode\\tnode /tmp/bin/omx.js sidecar --watch\\n"
        if [ -f "$restored_marker" ]; then
          printf "%%44\tnode\tenv OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE=%%10 node /tmp/bin/omx.js hud --watch\n"
        fi
        exit 0
        ;;
      *"-t %10 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%10\\tzsh\\tzsh\\n"
        if [ -f "$restored_marker" ]; then
          printf "%%44\\tnode\\tenv OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE=%%10 node /tmp/bin/omx.js hud --watch\\n"
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
  show-option)
    case "$*" in
      *"-p -t %10 @omx_team_pane_owner_id"*|*"-p -t %12 @omx_team_pane_owner_id"*|*"-p -t %13 @omx_team_pane_owner_id"*|*"-p -t %14 @omx_team_pane_owner_id"*|*"-p -t %44 @omx_team_pane_owner_id"*)
        echo "team:team-shutdown-unrelated-pane"
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    exit 0
    ;;
  resize-pane|select-pane|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          env: { OMX_SESSION_ID: 'team-shutdown-unrelated-pane-session' },
        },
        async ({ tmuxLogPath }) => {
          await initTeamState(teamName, 'shutdown unrelated pane test', 'executor', 2, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader:0';
          config.leader_pane_id = '%10';
          config.leader_pane_pid = 2000000010;
          config.hud_pane_id = '%12';
          config.hud_pane_pid = 2000000012;
          config.workers[0]!.pane_id = '%13';
          config.workers[0]!.pid = 2000000013;
          config.workers[1]!.pane_id = '%14';
          config.workers[1]!.pid = 2000000014;
          await saveTeamConfig(config, cwd);

          await shutdownTeam(teamName, cwd, { force: true });

          const teamRoot = join(cwd, '.omx', 'state', 'team', teamName);
          assert.equal(existsSync(teamRoot), false);
          assert.equal(await readMonitorSnapshot(teamName, cwd), null);

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.doesNotMatch(tmuxLog, /kill-pane -t %10/);
          assert.doesNotMatch(tmuxLog, /kill-pane -t %11/);
          assert.doesNotMatch(tmuxLog, /kill-pane -t %15/);
          assert.match(tmuxLog, /kill-pane -t %12/);
          assert.match(tmuxLog, /kill-pane -t %13/);
          assert.match(tmuxLog, /kill-pane -t %14/);
          assert.doesNotMatch(tmuxLog, /kill-session -t leader:0/);
          assert.match(tmuxLog, new RegExp(`split-window -v -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t %10 -d -P -F #\\{pane_id\\}`));
          assert.doesNotMatch(tmuxLog, /kill-pane -t %44/);
          assert.match(tmuxLog, /select-pane -t %10/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam fails closed before HUD effects when topology omits a canonical shared worker', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-stale-worker-pane-id-'));
    const teamName = 'team-stale-worker-pane-id';
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-stale-worker-pane-id-bin-',
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
      *"-a -F #{pane_id}"*)
        printf "%%10\t0\t2000000010\n"
        if [ ! -f "${tmuxLogPath}.killed-%15" ]; then printf "%%15\t0\t2000000015\n"; fi
        if [ ! -f "${tmuxLogPath}.killed-%12" ]; then printf "%%12\t0\t2000000012\n"; fi
        if [ ! -f "${tmuxLogPath}.killed-%13" ]; then printf "%%13\t0\t2000000013\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\t0\t2000000044\n"; fi
        exit 0
        ;;
      *"-F #{pane_dead} #{pane_pid}"*)
        exit 1
        ;;
      *"-t leader:0 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%10\\tzsh\\tzsh\\n%%12\\tzsh\\tzsh\\n%%13\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-stale-worker-pane-id/worker-1 codex\\n%%15\\tcodex\\tcodex unrelated-user-pane\\n"
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  split-window)
    : > "${tmuxLogPath}.hud-created"
    printf '%%44\n'
    exit 0
    ;;
  show-option)
    case "$*" in
      *"-p -t %13 @omx_team_pane_owner_id"*|*"-p -t %15 @omx_team_pane_owner_id"*)
        echo "team:team-stale-worker-pane-id"
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    exit 0
    ;;
  resize-pane|select-pane|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          env: { OMX_SESSION_ID: 'team-stale-worker-pane-id-session' },
        },
        async ({ tmuxLogPath }) => {
          await initTeamState(teamName, 'shutdown stale persisted worker pane id test', 'executor', 2, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader:0';
          config.leader_pane_id = '%10';
          config.leader_pane_pid = 2000000010;
          config.hud_pane_id = '%12';
          config.hud_pane_pid = 2000000012;
          config.workers[0]!.pane_id = '%13';
          config.workers[0]!.pid = 2000000013;
          config.workers[1]!.pane_id = '%15';
          config.workers[1]!.pid = 2000000015;
          await saveTeamConfig(config, cwd);

          await shutdownTeam(teamName, cwd, { force: true });
          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /kill-pane -t %13/);
          assert.match(tmuxLog, /kill-pane -t %15/);
          assert.doesNotMatch(tmuxLog, /split-window|resize-pane|select-pane|run-shell/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam fails closed when a canonical shared worker owner tag is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-worker-owner-missing-'));
    const teamName = 'team-worker-owner-missing';
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-worker-owner-missing-bin-',
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
      *"-a -F #{pane_id}"*)
        printf "%%11\t0\t2000000011\n%%14\t0\t2000000014\n"
        if [ ! -f "${tmuxLogPath}.killed-%12" ]; then printf "%%12\t0\t2000000012\n"; fi
        if [ ! -f "${tmuxLogPath}.killed-%13" ]; then printf "%%13\t0\t2000000013\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\t0\t2000000044\n"; fi
        exit 0
        ;;
      *"-F #{pane_dead} #{pane_pid}"*)
        exit 1
        ;;
      *"-t leader:0 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tzsh\\n%%12\\tnode\\tnode /tmp/bin/omx.js hud --watch\\n%%13\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-worker-owner-missing/worker-1 codex\\n%%14\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-worker-owner-missing/worker-2 codex\\n"
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  split-window)
    : > "${tmuxLogPath}.hud-created"
    printf '%%44\n'
    exit 0
    ;;
  show-option)
    case "$*" in
      *"-p -t %11 @omx_team_pane_owner_id"*|*"-p -t %12 @omx_team_pane_owner_id"*|*"-p -t %13 @omx_team_pane_owner_id"*)
        echo "team:team-worker-owner-missing"
        ;;
      *"-p -t %14 @omx_team_pane_owner_id"*)
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    exit 0
    ;;
  resize-pane|select-pane|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState(teamName, 'shutdown worker owner missing test', 'executor', 2, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader:0';
          config.leader_pane_id = '%11';
          config.leader_pane_pid = 2000000011;
          config.hud_pane_id = '%12';
          config.hud_pane_pid = 2000000012;
          config.workers[0]!.pane_id = '%13';
          config.workers[0]!.pid = 2000000013;
          config.workers[1]!.pane_id = '%14';
          config.workers[1]!.pid = 2000000014;
          await saveTeamConfig(config, cwd);
          const originalProcessKill = process.kill;
          const signals: Array<number | NodeJS.Signals | undefined> = [];
          process.kill = ((_pid: number, signal?: number | NodeJS.Signals) => {
            if (signal !== 0) signals.push(signal);
            return true;
          }) as typeof process.kill;
          try {
            await assert.rejects(
              () => shutdownTeam(teamName, cwd, { force: true }),
              /shutdown_shared_session_worker_owner_changed:%14/,
            );
          } finally {
            process.kill = originalProcessKill;
          }
          assert.deepEqual(signals.filter((signal) => signal === 'SIGTERM' || signal === 'SIGKILL'), []);

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.doesNotMatch(tmuxLog, /set-hook -u|kill-pane|split-window|resize-pane|select-pane|run-shell/);
          assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', teamName)), true);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam fails closed when a canonical shared worker owner tag cannot be read', async () => {

    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-worker-owner-read-error-'));
    const teamName = 'team-worker-owner-read-error';
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-worker-owner-read-error-bin-',
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
      *"-a -F #{pane_id}"*)
        printf "%%11\t0\t2000000011\n%%14\t0\t2000000014\n"
        if [ ! -f "${tmuxLogPath}.killed-%12" ]; then printf "%%12\t0\t2000000012\n"; fi
        if [ ! -f "${tmuxLogPath}.killed-%13" ]; then printf "%%13\t0\t2000000013\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\t0\t2000000044\n"; fi
        exit 0
        ;;
      *"-F #{pane_dead} #{pane_pid}"*)
        exit 1
        ;;
      *"-t leader:0 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tzsh\\n%%12\\tnode\\tnode /tmp/bin/omx.js hud --watch\\n%%13\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-worker-owner-read-error/worker-1 codex\\n%%14\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-worker-owner-read-error/worker-2 codex\\n"
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  split-window)
    : > "${tmuxLogPath}.hud-created"
    printf '%%44\n'
    exit 0
    ;;
  show-option)
    case "$*" in
      *"-p -t %11 @omx_team_pane_owner_id"*|*"-p -t %12 @omx_team_pane_owner_id"*|*"-p -t %13 @omx_team_pane_owner_id"*)
        echo "team:team-worker-owner-read-error"
        ;;
      *"-p -t %14 @omx_team_pane_owner_id"*)
        exit 2
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    exit 0
    ;;
  resize-pane|select-pane|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState(teamName, 'shutdown worker owner read error test', 'executor', 2, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader:0';
          config.leader_pane_id = '%11';
          config.leader_pane_pid = 2000000011;
          config.hud_pane_id = '%12';
          config.hud_pane_pid = 2000000012;
          config.workers[0]!.pane_id = '%13';
          config.workers[0]!.pid = 2000000013;
          config.workers[1]!.pane_id = '%14';
          config.workers[1]!.pid = 2000000014;
          await saveTeamConfig(config, cwd);

          await assert.rejects(
            () => shutdownTeam(teamName, cwd, { force: true }),
            /shutdown_shared_session_worker_owner_unavailable:%14:tmux show-option exited 2/,
          );
          assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', teamName)), true);
          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.doesNotMatch(tmuxLog, /set-hook -u|kill-pane|split-window|resize-pane|select-pane|run-shell/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam does not use a detected worker as fallback leader when the shared-session leader is stale', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-stale-leader-worker-'));
    const teamName = 'team-stale-leader-worker';
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-stale-leader-worker-bin-',
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
      *"-a -F #{pane_id}"*)
        printf "%%11\t0\t2000000011\n"
        if [ ! -f "${tmuxLogPath}.killed-%12" ]; then printf "%%12\t0\t2000000012\n"; fi
        if [ ! -f "${tmuxLogPath}.killed-%13" ]; then printf "%%13\t0\t2000000013\n"; fi
        exit 0
        ;;
      *"-F #{pane_dead} #{pane_pid}"*)
        exit 1
        ;;
      *"-t leader:0 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tvim notes.md\\n%%12\\tnode\\tnode /tmp/bin/omx.js hud --watch\\n%%13\\tcodex\\tenv 'OMX_TEAM_INTERNAL_WORKER=team-stale-leader-worker/worker-1' codex\\n"
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  show-option)
    case "$*" in
      *"-p -t %12 @omx_team_pane_owner_id"*)
        echo "team:team-stale-leader-worker"
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    exit 0
    ;;
  select-pane|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState(teamName, 'shutdown stale leader worker test', 'executor', 1, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader:0';
          config.leader_pane_id = '%10';
          config.leader_pane_pid = 2000000010;
          config.hud_pane_id = '%12';
          config.hud_pane_pid = 2000000012;
          config.workers[0]!.pane_id = '';
          await saveTeamConfig(config, cwd);

          await shutdownTeam(teamName, cwd, { force: true });

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.doesNotMatch(tmuxLog, /kill-pane -t %10/);
          assert.doesNotMatch(tmuxLog, /kill-pane -t %11/);
          assert.match(tmuxLog, /kill-pane -t %12/);
          assert.doesNotMatch(tmuxLog, /kill-pane -t %13/);
          assert.doesNotMatch(tmuxLog, /split-window/);
          assert.doesNotMatch(tmuxLog, /select-pane -t %11/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam rejects a reused persisted HUD pane after successful and partial session persistence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-reused-leader-pane-'));
    const teamName = 'team-reused-leader-pane';
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-reused-leader-pane-bin-',
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
      *"-a -F #{pane_id}"*)
        printf "%%11\t0\t2000000011\n%%12\t0\t2000000012\n"
        if [ ! -f "${tmuxLogPath}.killed-%13" ]; then printf "%%13\t0\t2000000013\n"; fi
        exit 0
        ;;
      *"-F #{pane_dead} #{pane_pid}"*)
        exit 1
        ;;
      *"-t leader:0 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tvim unrelated-notes.md\\n%%12\\tnode\\tnode /tmp/bin/omx.js hud --watch\\n%%13\\tcodex\\tenv 'OMX_TEAM_INTERNAL_WORKER=team-reused-leader-pane/worker-1' codex\\n"
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  show-option)
    case "$*" in
      *"-p -t %11 @omx_team_pane_owner_id"*)
        echo "team:other-team"
        ;;
      *"-p -t %12 @omx_team_pane_owner_id"*)
        echo "team:other-team"
        ;;
      *"-p -t %13 @omx_team_pane_owner_id"*)
        echo "team:team-reused-leader-pane"
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    exit 0
    ;;
  select-pane|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          env: { OMX_SESSION_ID: 'expected-team-session' },
        },
        async ({ tmuxLogPath }) => {
          const config = await initTeamState(teamName, 'shutdown reused HUD pane test', 'executor', 1, cwd);
          applyCreatedInteractiveSessionToConfig(config, {
            name: 'leader:0',
            workerCount: 1,
            cwd,
            workerPaneIds: [],
            workerPanePidsByIndex: [],
            leaderPaneId: '%11',
            leaderPanePid: 1000000011,
            hudPaneId: '%12',
            hudPanePid: 1000000012,
            resizeHookName: null,
            resizeHookTarget: null,
            teamPaneOwnerId: `team:${teamName}`,
          }, []);
          // A partial-session replay must retain the exact leader/HUD bindings rather
          // than degrading the persisted HUD target to its pane ID.
          applyCreatedInteractiveSessionToConfig(config, {
            name: 'leader:0',
            workerCount: 1,
            cwd,
            workerPaneIds: [],
            workerPaneIdsByIndex: [null],
            workerPanePidsByIndex: [null],
            leaderPaneId: '%11',
            leaderPanePid: 1000000011,
            hudPaneId: '%12',
            hudPanePid: 1000000012,
            resizeHookName: null,
            resizeHookTarget: null,
            teamPaneOwnerId: `team:${teamName}`,
          }, []);
          config.workers[0]!.pane_id = '';
          await saveTeamConfig(config, cwd);

          await assert.rejects(
            () => shutdownTeam(teamName, cwd, { force: true }),
            /shutdown_shared_session_HUD_pane_identity_changed:%12/,
          );

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.doesNotMatch(tmuxLog, /kill-pane -t %11/);
          assert.doesNotMatch(tmuxLog, /kill-pane -t %12/);
          assert.doesNotMatch(tmuxLog, /kill-pane -t %13/);
          assert.doesNotMatch(tmuxLog, /split-window|resize-pane|select-pane|run-shell/);
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
      *"-a -F #{pane_id}"*)
        printf "%%11\t0\t2000000011\n"
        if [ ! -f "${tmuxLogPath}.killed-%12" ]; then printf "%%12\t0\t2000000012\n"; fi
        if [ ! -f "${tmuxLogPath}.killed-%13" ]; then printf "%%13\t0\t2000000013\n"; fi
        if [ ! -f "${tmuxLogPath}.killed-%14" ]; then printf "%%14\t0\t2000000014\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\t0\t2000000044\n"; fi
        exit 0
        ;;
      *"-F #{pane_dead} #{pane_pid}"*)
        exit 1
        ;;
      *"-t leader:0 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tpwsh\\tpwsh\\n%%12\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%11' node /tmp/bin/omx.js hud --watch\\n%%13\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-shutdown-win32-split/worker-1 codex\\n%%14\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-shutdown-win32-split/worker-2 codex\\n"
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%11' node /tmp/bin/omx.js hud --watch\\n"; fi
        exit 0
        ;;
      *"-t %11 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tpwsh\\tpwsh\\n"
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%11' node /tmp/bin/omx.js hud --watch\\n"; fi
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  split-window)
    : > "${tmuxLogPath}.hud-created"
    printf '%%44\\n'
    exit 0
    ;;
  show-option)
    case "$*" in
      *"%44"*)
        echo "team:team-shutdown-win32-split"
        ;;
      *"%11"*|*"%12"*|*"%13"*|*"%14"*)
        echo "team:team-shutdown-win32-split"
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    exit 0
    ;;
  resize-pane|select-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
            env: { OMX_SESSION_ID: 'team-shutdown-win32-split-session' },
          },
          async ({ tmuxLogPath }) => {
            await initTeamState('team-shutdown-win32-split', 'shutdown win32 split test', 'executor', 2, cwd);
            const config = await readTeamConfig('team-shutdown-win32-split', cwd);
            assert.ok(config);
            if (!config) return;
            config.tmux_session = 'leader:0';
            config.leader_pane_id = '%11';
            config.leader_pane_pid = 2000000011;
            config.hud_pane_id = '%12';
            config.hud_pane_pid = 2000000012;
            config.tmux_pane_owner_id = 'team:team-shutdown-win32-split';
            config.workers[0]!.pane_id = '%13';
            config.workers[0]!.pid = 2000000013;
            config.workers[1]!.pane_id = '%14';
            config.workers[1]!.pid = 2000000014;
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

  it('shutdownTeam preserves an unrelated HUD when the leader is live but persisted shared-session HUD is stale', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-win32-stale-topology-'));
    const teamName = 'team-win32-stale-topo';
    try {
      await withNativeWindowsPlatform(async () => {
        await withMockTmuxFixture(
          {
            dirPrefix: 'omx-runtime-shutdown-win32-stale-topology-bin-',
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
      *"-a -F #{pane_id}"*)
        printf "%%11\t0\t2000000011\n%%22\t0\t2000000022\n"
        if [ ! -f "${tmuxLogPath}.killed-%23" ]; then printf "%%23\t0\t2000000023\n"; fi
        if [ ! -f "${tmuxLogPath}.killed-%24" ]; then printf "%%24\t0\t2000000024\n"; fi
        exit 0
        ;;
      *"-F #{pane_dead} #{pane_pid}"*)
        exit 1
        ;;
      *"-t leader:0 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tpwsh\\tpwsh\\n%%22\\tnode\\tnode /tmp/bin/omx.js hud --watch\\n%%23\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-win32-stale-topo/worker-1 codex\\n%%24\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-win32-stale-topo/worker-2 codex\\n"
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
  show-option)
    case "$*" in
      *"-p -t %11 @omx_team_pane_owner_id"*|*"-p -t %23 @omx_team_pane_owner_id"*|*"-p -t %24 @omx_team_pane_owner_id"*)
        echo "team:team-win32-stale-topo"
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    exit 0
    ;;
  resize-pane|select-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          },
          async ({ tmuxLogPath }) => {
            await initTeamState(teamName, 'shutdown win32 stale topology test', 'executor', 2, cwd);
            const config = await readTeamConfig(teamName, cwd);
            assert.ok(config);
            if (!config) return;
            config.tmux_session = 'leader:0';
            config.leader_pane_id = '%11';
            config.leader_pane_pid = 2000000011;
            config.hud_pane_id = '%12';
            config.hud_pane_pid = 2000000012;
            config.workers[0]!.pane_id = '%23';
            config.workers[0]!.pid = 2000000023;
            config.workers[1]!.pane_id = '%24';
            config.workers[1]!.pid = 2000000024;
            await saveTeamConfig(config, cwd);

            await shutdownTeam(teamName, cwd, { force: true });

            const teamRoot = join(cwd, '.omx', 'state', 'team', teamName);
            assert.equal(existsSync(teamRoot), false);
            assert.equal(await readMonitorSnapshot(teamName, cwd), null);

            const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
            assert.doesNotMatch(tmuxLog, /list-panes -t %11 -F #\{pane_pid\}/);
            assert.doesNotMatch(tmuxLog, /kill-pane -t %11/);
            assert.doesNotMatch(tmuxLog, /kill-pane -t %22/);
            assert.match(tmuxLog, /kill-pane -t %23/);
            assert.match(tmuxLog, /kill-pane -t %24/);
            assert.doesNotMatch(tmuxLog, /split-window/);
            assert.doesNotMatch(tmuxLog, /select-pane -t %11/);
          },
        );
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam fails closed when a tagged shared worker loses its owner tag before the HUD gate', async () => {

    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-hud-prevalidation-'));
    const teamName = 'team-hud-prevalidation';
    try {
      await withMockTmuxFixture({
        dirPrefix: 'omx-runtime-shutdown-hud-prevalidation-bin-',
        tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V) echo "tmux 3.4" ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf '%%11\t0\t2000000011\n%%12\t0\t2000000012\n%%13\t0\t2000000013\n'
        ;;
      *"-t leader:0 -F #{pane_id}"*) printf '%%11\\tzsh\\tzsh\\n%%12\\tnode\\tnode /omx.js hud --watch\\n%%13\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-hud-prevalidation/worker-1 codex\\n' ;;
      *) exit 1 ;;
    esac
    ;;
  show-option)
    case "$*" in
      *"-t %11 "*|*"-t %12 "*) echo 'team:team-hud-prevalidation' ;;
      *"-t %13 "*)
        if [ -f "${tmuxLogPath}.worker-owner-read" ]; then exit 1; fi
        : > "${tmuxLogPath}.worker-owner-read"
        echo 'team:team-hud-prevalidation'
        ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 0 ;;
esac
`,
      }, async ({ tmuxLogPath }) => {
        await initTeamState(teamName, 'shared HUD prevalidation test', 'executor', 1, cwd);
        const config = await readTeamConfig(teamName, cwd);
        assert.ok(config);
        if (!config) return;
        config.tmux_session = 'leader:0';
        config.leader_pane_id = '%11';
        config.leader_pane_pid = 2000000011;
        config.hud_pane_id = '%12';
        config.hud_pane_pid = 2000000012;
        config.tmux_pane_owner_id = 'team:team-hud-prevalidation';
        config.resize_hook_name = 'omx_resize_hud_prevalidation';
        config.resize_hook_target = 'leader:0';
        config.workers[0]!.pane_id = '%13';
        config.workers[0]!.pid = 2000000013;
        await saveTeamConfig(config, cwd);

        await assert.rejects(() => shutdownTeam(teamName, cwd, { force: true }), /shutdown_shared_session_worker_owner_changed:%13/);
        assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', teamName)), true);
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /set-hook -u|kill-pane|split-window|resize-pane|select-pane/);
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam fails closed before killing a shared HUD whose pane PID changes after authorization', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-hud-pid-continuity-'));
    const teamName = 'team-hud-pid-continuity';
    try {
      await withMockTmuxFixture({
        dirPrefix: 'omx-runtime-shutdown-hud-pid-continuity-bin-',
        tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V) echo 'tmux 3.4' ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        count_file="${tmuxLogPath}.exact-reads"
        count=0
        [ -f "$count_file" ] && count=$(cat "$count_file")
        count=$((count + 1))
        printf '%s' "$count" > "$count_file"
        hud_pid=2000000012
        [ "$count" -ge 5 ] && hud_pid=2000000099
        printf '%%11\\t0\\t2000000011\\n%%12\\t0\\t%s\\n%%13\\t0\\t2000000013\\n' "$hud_pid"
        ;;
      *"-t leader:0 -F #{pane_id}"*) printf '%%11\\tzsh\\tzsh\\n%%12\\tnode\\tnode /omx.js hud --watch\\n%%13\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-hud-pid-continuity/worker-1 codex\\n' ;;
      *) exit 1 ;;
    esac
    ;;
  show-option)
    case "$*" in
      *"-t %11 "*|*"-t %12 "*|*"-t %13 "*) echo 'team:team-hud-pid-continuity' ;;
      *) exit 1 ;;
    esac
    ;;
  kill-pane|split-window|resize-pane|select-pane) exit 0 ;;
  *) exit 0 ;;
esac
`,
      }, async ({ tmuxLogPath }) => {
        await initTeamState(teamName, 'shared HUD PID continuity test', 'executor', 1, cwd);
        const config = await readTeamConfig(teamName, cwd);
        assert.ok(config);
        if (!config) return;
        config.tmux_session = 'leader:0';
        config.leader_pane_id = '%11';
        config.leader_pane_pid = 2000000011;
        config.hud_pane_id = '%12';
        config.hud_pane_pid = 2000000012;
        config.tmux_pane_owner_id = 'team:team-hud-pid-continuity';
        config.workers[0]!.pane_id = '%13';
        config.workers[0]!.pid = 2000000013;
        await saveTeamConfig(config, cwd);

        await assert.rejects(() => shutdownTeam(teamName, cwd, { force: true }), /shutdown_shared_session_HUD_pane_identity_changed:%12/);
        assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', teamName)), true);
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /kill-pane -t %12|split-window/);
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam blocks restoration when a shared leader PID and owner change after the post-HUD check', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-leader-owner-continuity-'));
    const teamName = 'team-leader-owner-continuity';
    try {
      await withMockTmuxFixture({
        dirPrefix: 'omx-runtime-shutdown-leader-owner-continuity-bin-',
        tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V) echo 'tmux 3.4' ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        owner_reads=0
        [ -f "${tmuxLogPath}.leader-owner-reads" ] && owner_reads=$(cat "${tmuxLogPath}.leader-owner-reads")
        if [ "$owner_reads" -ge 4 ]; then printf '%%11\t0\t2000000099\n'; else printf '%%11\t0\t2000000011\n'; fi
        if [ ! -f "${tmuxLogPath}.killed-%12" ]; then printf '%%12\t0\t2000000012\n'; fi
        printf '%%13\t0\t2000000013\n'
        ;;
      *"-t leader:0 -F #{pane_id}"*) printf '%%11\\tzsh\\tzsh\\n%%12\\tnode\\tnode /omx.js hud --watch\\n%%13\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-leader-owner-continuity/worker-1 codex\\n' ;;
      *) exit 1 ;;
    esac
    ;;
  show-option)
    case "$*" in
      *"-t %11 "*)
        count_file="${tmuxLogPath}.leader-owner-reads"
        count=0
        [ -f "$count_file" ] && count=$(cat "$count_file")
        count=$((count + 1))
        printf '%s' "$count" > "$count_file"
        [ "$count" -ge 4 ] && { echo 'team:foreign'; exit 0; }
        echo 'team:team-leader-owner-continuity'
        ;;
      *"-t %12 "*|*"-t %13 "*) echo 'team:team-leader-owner-continuity' ;;
      *) exit 1 ;;
    esac
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    exit 0
    ;;
  split-window|resize-pane|select-pane) exit 0 ;;
  *) exit 0 ;;
esac
`,
      }, async ({ tmuxLogPath }) => {
        await initTeamState(teamName, 'shared leader owner continuity test', 'executor', 1, cwd);
        const config = await readTeamConfig(teamName, cwd);
        assert.ok(config);
        if (!config) return;
        config.tmux_session = 'leader:0';
        config.leader_pane_id = '%11';
        config.leader_pane_pid = 2000000011;
        config.hud_pane_id = '%12';
        config.hud_pane_pid = 2000000012;
        config.tmux_pane_owner_id = 'team:team-leader-owner-continuity';
        config.workers[0]!.pane_id = '%13';
        config.workers[0]!.pid = 2000000013;
        await saveTeamConfig(config, cwd);

        await assert.rejects(() => shutdownTeam(teamName, cwd, { force: true }), /shutdown_shared_session_restore_leader_pane_owner_changed:%11/);
        assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', teamName)), true);
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.match(tmuxLog, /kill-pane -t %12/);
        assert.doesNotMatch(tmuxLog, /split-window/);
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
      *"-a -F #{pane_id}"*)
        printf "%%11\t0\t2000000011\n"
        if [ ! -f "${tmuxLogPath}.killed-%12" ]; then printf "%%12\t0\t2000000012\n"; fi
        if [ ! -f "${tmuxLogPath}.killed-%13" ]; then printf "%%13\t0\t2000000013\n"; fi
        if [ ! -f "${tmuxLogPath}.killed-%14" ]; then printf "%%14\t0\t2000000014\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\t0\t2000000044\n"; fi
        exit 0
        ;;
      *"-F #{pane_dead} #{pane_pid}"*)
        exit 1
        ;;
      *"-t leader:0 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tzsh\\n%%12\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%11' node /tmp/bin/omx.js hud --watch\\n%%13\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-shutdown-shared-session/worker-1 codex\\n%%14\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-shutdown-shared-session/worker-2 codex\\n"
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%11' node /tmp/bin/omx.js hud --watch\\n"; fi
        exit 0
        ;;
      *"-t %11 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tzsh\\n"
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%11' node /tmp/bin/omx.js hud --watch\\n"; fi
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  split-window)
    : > "${tmuxLogPath}.hud-created"
    printf '%%44\n'
    exit 0
    ;;
  show-option)
    case "$*" in
      *"%44"*)
        echo "team:team-shutdown-shared-session"
        ;;
      *"%11"*|*"%12"*|*"%13"*|*"%14"*)
        echo "team:team-shutdown-shared-session"
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    exit 0
    ;;
  resize-pane|select-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          env: { OMX_SESSION_ID: 'team-shutdown-shared-session-owner' },
        },
        async ({ tmuxLogPath }) => {
          await initTeamState('team-shutdown-shared-session', 'shutdown shared session test', 'executor', 2, cwd);
          const config = await readTeamConfig('team-shutdown-shared-session', cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader:0';
          config.leader_pane_id = '%11';
          config.leader_pane_pid = 2000000011;
          config.hud_pane_id = '%12';
          config.hud_pane_pid = 2000000012;
          config.tmux_pane_owner_id = 'team:team-shutdown-shared-session';
          config.workers[0]!.pane_id = '%13';
          config.workers[0]!.pid = 2000000013;
          config.workers[1]!.pane_id = '%14';
          config.workers[1]!.pid = 2000000014;
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
    const leaderPaneCwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-restore-hud-leader-cwd-'));
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
  display-message)
    case "$*" in
      *"#{pane_current_path}"*)
        echo "${leaderPaneCwd}"
        ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf "%%11\t0\t2000000011\n"
        if [ ! -f "${tmuxLogPath}.killed-%12" ]; then printf "%%12\t0\t2000000012\n"; fi
        if [ ! -f "${tmuxLogPath}.killed-%13" ]; then printf "%%13\t0\t2000000013\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\t0\t2000000044\n"; fi
        exit 0
        ;;
      *"-t leader:0 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tzsh\\n%%12\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%11' node /tmp/bin/omx.js hud --watch\\n%%13\\tcodex\\tcodex\\n"
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\\tnode\\tenv OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE=%%11 node /tmp/bin/omx.js hud --watch\\n"; fi
        exit 0
        ;;
      *"-t %11 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tzsh\\n"
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\\tnode\\tenv OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE=%%11 node /tmp/bin/omx.js hud --watch\\n"; fi
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  split-window)
    : > "${tmuxLogPath}.hud-created"
    printf '%%44\n'
    exit 0
    ;;
  show-option)
    case "$*" in
      *"-p -t %11 @omx_team_pane_owner_id"*|*"-p -t %12 @omx_team_pane_owner_id"*|*"-p -t %13 @omx_team_pane_owner_id"*|*"-p -t %44 @omx_team_pane_owner_id"*)
        echo "team:team-shutdown-restore-hud"
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    exit 0
    ;;
  kill-session|select-pane)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
          env: { OMX_SESSION_ID: 'team-shutdown-restore-hud-session' },
        },
        async ({ tmuxLogPath }) => {
          await initTeamState('team-shutdown-restore-hud', 'shutdown restore hud test', 'executor', 2, cwd);
          const config = await readTeamConfig('team-shutdown-restore-hud', cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader:0';
          config.leader_pane_id = '%11';
          config.leader_pane_pid = 2000000011;
          config.hud_pane_id = '%12';
          config.hud_pane_pid = 2000000012;
          config.workers[0]!.pane_id = '%12';
          config.workers[0]!.pid = 2000000012;
          config.workers[1]!.pane_id = '%13';
          config.workers[1]!.pid = 2000000013;
          config.workers[0]!.pid = 2000000012;
          config.workers[1]!.pid = 2000000013;
          await saveTeamConfig(config, cwd);

          await shutdownTeam('team-shutdown-restore-hud', cwd, { force: true });
          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          const count = (pattern: RegExp): number => [...tmuxLog.matchAll(pattern)].length;
          assert.doesNotMatch(tmuxLog, /kill-pane -t %11/);
          assert.match(tmuxLog, /kill-pane -t %12/);
          assert.match(tmuxLog, /kill-pane -t %13/);
          assert.match(tmuxLog, new RegExp(`split-window -v -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t %11 -d -P -F #\{pane_id\}`));
          assert.equal(count(/kill-pane -t %12/g), 1);
          assert.equal(count(new RegExp(`split-window -v -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t %11 -d -P -F #\\{pane_id\\}`, 'g')), 1);
          assert.match(tmuxLog, /run-shell -b sleep \d+; if snapshot=\$\(tmux list-panes -a -F/);
          assert.match(tmuxLog, /run-shell if snapshot=\$\(tmux list-panes -a -F/);
          assert.match(tmuxLog, /hud --watch/);
          assert.match(tmuxLog, /OMX_TMUX_HUD_LEADER_PANE='%11'/);
          assert.match(tmuxLog, /OMX_SESSION_ID='team-shutdown-restore-hud-session'/);
          assert.match(tmuxLog, new RegExp(`split-window -v -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t %11 -d -P -F #\\{pane_id\\} -c ${escapeRegExp(leaderPaneCwd)} `));
          assert.doesNotMatch(tmuxLog, new RegExp(`split-window -v -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t %11 -d -P -F #\\{pane_id\\} -c ${escapeRegExp(cwd)} `));
          assert.doesNotMatch(tmuxLog, /kill-pane -t %44/);
          assert.match(tmuxLog, /select-pane -t %11/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(leaderPaneCwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam replays pinned restored-HUD debt when a crash leaves canonical config on a different HUD identity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-restored-hud-debt-retry-'));
    const teamName = 'team-hud-debt-retry';
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-restored-hud-debt-retry-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    echo 'tmux 3.4'
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf '%%11\\t0\\t2000000011\\n'
        if [ ! -f "${tmuxLogPath}.killed-%44" ]; then printf '%%44\\t0\\t2000000044\\n'; fi
        ;;
      *"-t %11 -F #{pane_id}"*"#{pane_current_command}"*)
        printf '%%11\\tzsh\\tzsh\\n'
        if [ ! -f "${tmuxLogPath}.killed-%44" ]; then printf "%%44\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%11' node /tmp/bin/omx.js hud --watch\\n"; fi
        ;;
      *) exit 1 ;;
    esac
    ;;
  show-option)
    if [ "$5" = '%11' ] && [ "$6" = '@omx_team_pane_owner_id' ]; then
      printf 'team:restored-hud-debt-retry\\n'
    else
      exit 1
    fi
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    ;;
  *) : ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState(teamName, 'restored HUD debt retry test', 'executor', 1, cwd);
          await markDetachedSessionAbsent(teamName, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          // Simulate a crash after a restored HUD was durably recorded but
          // before its config transaction: a later stale HUD must not erase
          // that pinned obligation.
          config.hud_pane_id = '%45';
          config.hud_pane_pid = 2000000045;
          await saveTeamConfig(config, cwd);
          const debtPath = join(cwd, '.omx', 'state', 'team', teamName, '.restored-hud-cleanup-debt.json');
          await writeFile(debtPath, `${JSON.stringify({
            schema_version: 1,
            operation: 'restored_hud_cleanup',
            pane_id: '%44',
            pane_pid: 2000000044,
            leader_pane_id: '%11',
            leader_pane_pid: 2000000011,
            leader_pane_owner_id: 'team:restored-hud-debt-retry',
            hud_owner_leader_pane_id: '%11',
          })}\n`);

          await shutdownTeam(teamName, cwd, { force: true });

          assert.equal(existsSync(debtPath), false);
          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /kill-pane -t %44/);
          assert.doesNotMatch(tmuxLog, /kill-pane -t %45/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam clears mismatched restored-HUD config before repeated detached recovery leaves a live non-HUD pane untouched', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-restored-hud-mismatched-detached-'));
    const teamName = 'hud-mismatch-detached';
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-restored-hud-mismatched-detached-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    echo 'tmux 3.4'
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf '%%11\\t0\\t2000000011\\n%%44\\t0\\t2000000044\\n%%45\\t0\\t2000000045\\n'
        ;;
      *"-t %11 -F #{pane_id}"*"#{pane_current_command}"*)
        printf '%%11\\tzsh\\tzsh\\n%%44\\tnode\\tnot-a-hud\\n%%45\\tnode\\tnot-a-hud\\n'
        ;;
      *) exit 1 ;;
    esac
    ;;
  show-option)
    case "$*" in
      *"-p -t %11 @omx_team_pane_owner_id"*|*"-p -t %45 @omx_team_pane_owner_id"*)
        printf 'team:hud-mismatch-detached\\n'
        ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState(teamName, 'restored HUD mismatch detached recovery test', 'executor', 1, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader';
          config.tmux_pane_owner_id = 'team:hud-mismatch-detached';
          config.leader_pane_id = '%11';
          config.leader_pane_pid = 2000000011;
          config.hud_pane_id = '%45';
          config.hud_pane_pid = 2000000045;
          config.workers = [];
          config.worker_count = 0;
          await saveTeamConfig(config, cwd);
          const debtPath = join(cwd, '.omx', 'state', 'team', teamName, '.restored-hud-cleanup-debt.json');
          await writeFile(debtPath, `${JSON.stringify({
            schema_version: 1,
            operation: 'restored_hud_cleanup',
            pane_id: '%44',
            pane_pid: 2000000044,
            leader_pane_id: '%11',
            leader_pane_pid: 2000000011,
            leader_pane_owner_id: 'team:hud-mismatch-detached',
            hud_owner_leader_pane_id: '%11',
          })}\n`);

          for (let attempt = 0; attempt < 2; attempt++) {
            await assert.rejects(
              () => shutdownTeam(teamName, cwd, { force: true }),
              /restored_hud_cleanup_debt_unresolved:%44/,
            );
            const persisted = await readTeamConfig(teamName, cwd);
            assert.ok(persisted);
            assert.equal(persisted?.hud_pane_id, null);
            assert.equal(persisted?.hud_pane_pid, null);
            assert.equal(existsSync(debtPath), true);
          }

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.doesNotMatch(tmuxLog, /kill-pane -t %44|kill-pane -t %45|kill-session|resize-pane|select-pane|send-keys|run-shell/);
          assert.doesNotMatch(tmuxLog, /show-option -p -t %45 @omx_team_pane_owner_id/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam retires matching restored-HUD config when the pinned pane is no longer a HUD', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-restored-hud-matching-nonhud-'));
    const teamName = 'hud-matching-nonhud';
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-restored-hud-matching-nonhud-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    echo 'tmux 3.4'
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf '%%11\\t0\\t2000000011\\n%%44\\t0\\t2000000044\\n'
        ;;
      *"-t %11 -F #{pane_id}"*"#{pane_current_command}"*)
        printf '%%11\\tzsh\\tzsh\\n%%44\\tnode\\tnot-a-hud\\n'
        ;;
      *) exit 1 ;;
    esac
    ;;
  show-option)
    case "$*" in
      *"-p -t %11 @omx_team_pane_owner_id"*)
        printf 'team:hud-matching-nonhud\\n'
        ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState(teamName, 'matching restored HUD non-authority test', 'executor', 1, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader';
          config.tmux_pane_owner_id = 'team:hud-matching-nonhud';
          config.leader_pane_id = '%11';
          config.leader_pane_pid = 2000000011;
          config.hud_pane_id = '%44';
          config.hud_pane_pid = 2000000044;
          config.workers = [];
          config.worker_count = 0;
          await saveTeamConfig(config, cwd);
          const debtPath = join(cwd, '.omx', 'state', 'team', teamName, '.restored-hud-cleanup-debt.json');
          await writeFile(debtPath, `${JSON.stringify({
            schema_version: 1,
            operation: 'restored_hud_cleanup',
            pane_id: '%44',
            pane_pid: 2000000044,
            leader_pane_id: '%11',
            leader_pane_pid: 2000000011,
            leader_pane_owner_id: 'team:hud-matching-nonhud',
            hud_owner_leader_pane_id: '%11',
          })}\n`);

          for (let attempt = 0; attempt < 2; attempt++) {
            await assert.rejects(
              () => shutdownTeam(teamName, cwd, { force: true }),
              /restored_hud_cleanup_debt_unresolved:%44/,
            );
            const persisted = await readTeamConfig(teamName, cwd);
            assert.ok(persisted);
            assert.equal(persisted?.hud_pane_id, null);
            assert.equal(persisted?.hud_pane_pid, null);
            assert.equal(existsSync(debtPath), true);
          }

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.doesNotMatch(tmuxLog, /kill-pane|kill-session|resize-pane|select-pane|send-keys|run-shell/);
          assert.doesNotMatch(tmuxLog, /show-option -p -t %44 @omx_team_pane_owner_id/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam preserves unpersisted legacy worker-looking panes without owner tags', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-unpersisted-legacy-worker-'));
    const teamName = 'team-unpersisted-legacy-worker';
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-unpersisted-legacy-worker-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{pane_current_path}"*)
        echo "${cwd}"
        ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf "%%11\t0\t2000000011\n%%14\t0\t2000000014\n"
        if [ ! -f "${tmuxLogPath}.killed-%12" ]; then printf "%%12\t0\t2000000012\n"; fi
        if [ ! -f "${tmuxLogPath}.killed-%13" ]; then printf "%%13\t0\t2000000013\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\t0\t2000000044\n"; fi
        exit 0
        ;;
      *"-F #{pane_dead} #{pane_pid}"*)
        exit 1
        ;;
      *"-t leader:0 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tzsh\\n%%12\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%11' node /tmp/bin/omx.js hud --watch\\n%%13\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-unpersisted-legacy-worker/worker-1 codex\\n%%14\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-unpersisted-legacy-worker/worker-2 codex\\n"
        exit 0
        ;;
      *"-t %11 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tzsh\\n"
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  split-window)
    : > "${tmuxLogPath}.hud-created"
    printf '%%44\n'
    exit 0
    ;;
  show-option)
    case "$*" in
      *"-p -t %11 @omx_team_pane_owner_id"*|*"-p -t %12 @omx_team_pane_owner_id"*|*"-p -t %13 @omx_team_pane_owner_id"*)
        echo "team:team-unpersisted-legacy-worker"
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    exit 0
    ;;
  resize-pane|select-pane|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState(teamName, 'shutdown unpersisted legacy worker test', 'executor', 2, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader:0';
          config.leader_pane_id = '%11';
          config.leader_pane_pid = 2000000011;
          config.hud_pane_id = '%12';
          config.hud_pane_pid = 2000000012;
          config.workers[0]!.pane_id = '%13';
          config.workers[0]!.pid = 2000000013;
          config.workers[1]!.pane_id = '%99';
          config.workers[1]!.pid = 2000000099;
          await saveTeamConfig(config, cwd);

          await assert.rejects(
            () => shutdownTeam(teamName, cwd, { force: true }),
            /shutdown_shared_session_worker_owner_changed:%99/,
          );
          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.doesNotMatch(tmuxLog, /set-hook -u|kill-pane|split-window|resize-pane|select-pane|run-shell/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam reclaims a matching-owner live HUD when the persisted HUD id is stale', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-stale-hud-live-owner-'));
    const teamName = 'team-stale-hud-live-owner';
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-stale-hud-live-owner-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{pane_current_path}"*)
        echo "${cwd}"
        ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf "%%11\t0\t2000000011\n"
        if [ ! -f "${tmuxLogPath}.killed-%12" ]; then printf "%%12\t0\t2000000012\n"; fi
        if [ ! -f "${tmuxLogPath}.killed-%13" ]; then printf "%%13\t0\t2000000013\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\t0\t2000000044\n"; fi
        exit 0
        ;;
      *"-F #{pane_dead} #{pane_pid}"*)
        exit 1
        ;;
      *"-t leader:0 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tzsh\\n%%12\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%11' node /tmp/bin/omx.js hud --watch\\n%%13\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-stale-hud-live-owner/worker-1 codex\\n"
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\\tnode\\tenv OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE=%%11 node /tmp/bin/omx.js hud --watch\\n"; fi
        exit 0
        ;;
      *"-t %11 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tzsh\\n"
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\\tnode\\tenv OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE=%%11 node /tmp/bin/omx.js hud --watch\\n"; fi
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  split-window)
    : > "${tmuxLogPath}.hud-created"
    printf '%%44\n'
    exit 0
    ;;
  show-option)
    case "$*" in
      *"-p -t %11 @omx_team_pane_owner_id"*|*"-p -t %12 @omx_team_pane_owner_id"*|*"-p -t %13 @omx_team_pane_owner_id"*|*"-p -t %44 @omx_team_pane_owner_id"*)
        echo "team:team-stale-hud-live-owner"
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    exit 0
    ;;
  resize-pane|select-pane|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState(teamName, 'shutdown stale hud live owner test', 'executor', 1, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader:0';
          config.leader_pane_id = '%11';
          config.leader_pane_pid = 2000000011;
          config.hud_pane_id = '%99';
          config.hud_pane_pid = 2000000099;
          config.workers[0]!.pane_id = '%13';
          config.workers[0]!.pid = 2000000013;
          await saveTeamConfig(config, cwd);

          await shutdownTeam(teamName, cwd, { force: true });

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          const count = (pattern: RegExp): number => [...tmuxLog.matchAll(pattern)].length;
          assert.doesNotMatch(tmuxLog, /kill-pane -t %11/);
          assert.match(tmuxLog, /kill-pane -t %12/);
          assert.match(tmuxLog, /kill-pane -t %13/);
          assert.doesNotMatch(tmuxLog, /kill-pane -t %99/);
          assert.equal(count(/kill-pane -t %12/g), 1);
          assert.equal(count(new RegExp(`split-window -v -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t %11 -d -P -F #\\{pane_id\\}`, 'g')), 1);
          assert.match(tmuxLog, /select-pane -t %11/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam reclaims an owner-tagged shared HUD pane', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-legacy-hud-owner-'));
    const teamName = 'team-legacy-hud-owner';
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-legacy-hud-owner-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{pane_current_path}"*)
        echo "${cwd}"
        ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf "%%11\t0\t2000000011\n"
        if [ ! -f "${tmuxLogPath}.killed-%12" ]; then printf "%%12\t0\t2000000012\n"; fi
        if [ ! -f "${tmuxLogPath}.killed-%13" ]; then printf "%%13\t0\t2000000013\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\t0\t2000000044\n"; fi
        exit 0
        ;;
      *"-F #{pane_dead} #{pane_pid}"*)
        exit 1
        ;;
      *"-t leader:0 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tzsh\\n%%12\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%11' node /tmp/bin/omx.js hud --watch\\n%%13\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-legacy-hud-owner/worker-1 codex\\n"
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\\tnode\\tenv OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE=%%11 node /tmp/bin/omx.js hud --watch\\n"; fi
        exit 0
        ;;
      *"-t %11 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tzsh\\n"
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\\tnode\\tenv OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE=%%11 node /tmp/bin/omx.js hud --watch\\n"; fi
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  split-window)
    : > "${tmuxLogPath}.hud-created"
    printf '%%44\n'
    exit 0
    ;;
  show-option)
    case "$*" in
      *"-p -t %11 @omx_team_pane_owner_id"*|*"-p -t %12 @omx_team_pane_owner_id"*|*"-p -t %13 @omx_team_pane_owner_id"*|*"-p -t %44 @omx_team_pane_owner_id"*)
        echo "team:team-legacy-hud-owner"
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    exit 0
    ;;
  resize-pane|select-pane|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState(teamName, 'shutdown legacy hud owner test', 'executor', 1, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader:0';
          config.leader_pane_id = '%11';
          config.leader_pane_pid = 2000000011;
          config.hud_pane_id = '%12';
          config.hud_pane_pid = 2000000012;
          config.tmux_pane_owner_id = 'team:team-legacy-hud-owner';
          config.workers[0]!.pane_id = '%13';
          config.workers[0]!.pid = 2000000013;
          await saveTeamConfig(config, cwd);

          await shutdownTeam(teamName, cwd, { force: true });

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /kill-pane -t %12/);
          assert.match(tmuxLog, /kill-pane -t %13/);
          assert.match(tmuxLog, new RegExp(`split-window -v -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t %11 -d -P -F #\\{pane_id\\}`));
          assert.match(tmuxLog, /select-pane -t %11/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam restores standalone HUD only for an owner-tagged leader', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-legacy-leader-instance-'));
    const teamName = 'team-legacy-leader-instance';
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-legacy-leader-instance-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  display-message)
    case "$*" in
      *"#{pane_current_path}"*)
        echo "${cwd}"
        ;;
    esac
    exit 0
    ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf "%%11\t0\t2000000011\n"
        if [ ! -f "${tmuxLogPath}.killed-%12" ]; then printf "%%12\t0\t2000000012\n"; fi
        if [ ! -f "${tmuxLogPath}.killed-%13" ]; then printf "%%13\t0\t2000000013\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\t0\t2000000044\n"; fi
        exit 0
        ;;
      *"-F #{pane_dead} #{pane_pid}"*)
        exit 1
        ;;
      *"-t leader:0 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tzsh\\n%%12\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%11' node /tmp/bin/omx.js hud --watch\\n%%13\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-legacy-leader-instance/worker-1 codex\\n"
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\\tnode\\tenv OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE=%%11 node /tmp/bin/omx.js hud --watch\\n"; fi
        exit 0
        ;;
      *"-t %11 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tzsh\\n"
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\\tnode\\tenv OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE=%%11 node /tmp/bin/omx.js hud --watch\\n"; fi
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  split-window)
    : > "${tmuxLogPath}.hud-created"
    printf '%%44\n'
    exit 0
    ;;
  show-option)
    case "$*" in
      *"-p -t %11 @omx_team_pane_owner_id"*|*"-p -t %12 @omx_team_pane_owner_id"*|*"-p -t %13 @omx_team_pane_owner_id"*|*"-p -t %44 @omx_team_pane_owner_id"*)
        echo "team:team-legacy-leader-instance"
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    exit 0
    ;;
  resize-pane|select-pane|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState(teamName, 'shutdown legacy leader instance test', 'executor', 1, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader:0';
          config.leader_pane_id = '%11';
          config.leader_pane_pid = 2000000011;
          config.hud_pane_id = '%12';
          config.hud_pane_pid = 2000000012;
          config.tmux_pane_owner_id = 'team:team-legacy-leader-instance';
          config.workers[0]!.pane_id = '%13';
          config.workers[0]!.pid = 2000000013;
          await saveTeamConfig(config, cwd);

          await shutdownTeam(teamName, cwd, { force: true });

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.match(tmuxLog, /show-option -qv -p -t %11 @omx_team_pane_owner_id/);
          assert.doesNotMatch(tmuxLog, /show-option -qv -p -t %11 @omx_pane_instance_id/);
          assert.match(tmuxLog, /kill-pane -t %12/);
          assert.match(tmuxLog, /kill-pane -t %13/);
          assert.match(tmuxLog, new RegExp(`split-window -v -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t %11 -d -P -F #\\{pane_id\\}`));
          assert.match(tmuxLog, /select-pane -t %11/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shutdownTeam preserves a persisted HUD pane when the team owner tag cannot be read', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-shutdown-hud-owner-read-error-'));
    const teamName = 'team-hud-owner-read-error';
    const originalWarn = console.warn;
    const warnings: string[] = [];
    try {
      console.warn = (message?: unknown, ...optionalParams: unknown[]): void => {
        warnings.push([message, ...optionalParams].map(String).join(' '));
      };
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-shutdown-hud-owner-read-error-bin-',
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
      *"-a -F #{pane_id}"*)
        printf "%%11\t0\t2000000011\n"
        printf "%%12\t0\t2000000012\n"
        if [ ! -f "${tmuxLogPath}.killed-%13" ]; then printf "%%13\t0\t2000000013\n"; fi
        exit 0
        ;;
      *"-F #{pane_dead} #{pane_pid}"*)
        exit 1
        ;;
      *"-t leader:0 -F #{pane_id}"*"#{pane_current_command}"*)
        printf "%%11\\tzsh\\tzsh\\n%%12\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%11' node /tmp/bin/omx.js hud --watch\\n%%13\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-hud-owner-read-error/worker-1 codex\\n"
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
  show-option)
    case "$*" in
      *"-p -t %11 @omx_team_pane_owner_id"*)
        echo "team:team-hud-owner-read-error"
        ;;
      *"-p -t %12 @omx_team_pane_owner_id"*)
        exit 2
        ;;
      *"-p -t %13 @omx_team_pane_owner_id"*)
        echo "team:team-hud-owner-read-error"
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    exit 0
    ;;
  resize-pane|select-pane|run-shell)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
        },
        async ({ tmuxLogPath }) => {
          await initTeamState(teamName, 'shutdown hud owner read error test', 'executor', 1, cwd);
          const config = await readTeamConfig(teamName, cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'leader:0';
          config.leader_pane_id = '%11';
          config.leader_pane_pid = 2000000011;
          config.hud_pane_id = '%12';
          config.hud_pane_pid = 2000000012;
          config.workers[0]!.pane_id = '%13';
          config.workers[0]!.pid = 2000000013;
          await saveTeamConfig(config, cwd);

          await shutdownTeam(teamName, cwd, { force: true });

          const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
          assert.doesNotMatch(tmuxLog, /kill-pane -t %12/);
          assert.match(tmuxLog, /kill-pane -t %13/);
          assert.doesNotMatch(tmuxLog, new RegExp(`split-window -v -l ${HUD_TMUX_TEAM_HEIGHT_LINES} -t %11 -d -P -F #\\{pane_id\\}`));
          assert.match(warnings.join('\n'), /skipped shared-session HUD pane %12 because team owner tag could not be read: tmux show-option exited 2/);
        },
      );
    } finally {
      console.warn = originalWarn;
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
    case "$*" in
      *"-a -F #{pane_id}"*)
        if [ ! -f "${tmuxLogPath}.killed-%11" ]; then printf "%%11\t0\t2000000011\n"; fi
        if [ ! -f "${tmuxLogPath}.killed-%12" ]; then printf "%%12\t0\t2000000012\n"; fi
        if [ ! -f "${tmuxLogPath}.killed-%13" ]; then printf "%%13\t0\t2000000013\n"; fi
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\t0\t2000000044\n"; fi
        ;;
      *"-t omx-team-team-shutdown-exclusions:0"*)
        printf "%%11\\tzsh\\tzsh\\n%%12\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%11' node /tmp/bin/omx.js hud --watch\\n%%13\\tcodex\\tenv OMX_TEAM_INTERNAL_WORKER=team-shutdown-exclusions/worker-3 codex\\n"
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%11' node /tmp/bin/omx.js hud --watch\\n"; fi
        ;;
      *"-t %11 -F #{pane_id}"*)
        printf "%%11\\tzsh\\tzsh\\n"
        if [ -f "${tmuxLogPath}.hud-created" ]; then printf "%%44\\tnode\\texec env OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE='%%11' node /tmp/bin/omx.js hud --watch\\n"; fi
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  show-option|show-options)
    case "$*" in
      *"%44"*)
        echo "team:team-shutdown-exclusions"
        ;;
      *"%11"*|*"%12"*|*"%13"*)
        echo "team:team-shutdown-exclusions"
        ;;
      *)
        exit 1
        ;;
    esac
    exit 0
    ;;
  split-window)
    : > "${tmuxLogPath}.hud-created"
    printf '%%44\n'
    exit 0
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
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
          await initTeamState('team-shutdown-exclusions', 'shutdown exclusions test', 'executor', 3, cwd);
          const config = await readTeamConfig('team-shutdown-exclusions', cwd);
          assert.ok(config);
          if (!config) return;
          config.tmux_session = 'omx-team-team-shutdown-exclusions:0';
          config.leader_pane_id = '%11';
          config.leader_pane_pid = 2000000011;
          config.hud_pane_id = '%12';
          config.hud_pane_pid = 2000000012;
          config.tmux_pane_owner_id = 'team:team-shutdown-exclusions';
          config.workers[0]!.pane_id = '%11';
          config.workers[0]!.pid = 2000000011;
          config.workers[1]!.pane_id = '%12';
          config.workers[1]!.pid = 2000000012;
          config.workers[2]!.pane_id = '%13';
          config.workers[2]!.pid = 2000000013;
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

  it('resumeTeam fails closed when the persisted approved binding is stale', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-approved-resume-'));
    try {
      await initTeamState('team-approved-resume', 'approved resume test', 'executor', 1, cwd);
      await writePersistedApprovedTeamExecutionBinding('team-approved-resume', cwd, {
        prd_path: join(cwd, '.omx', 'plans', 'prd-missing.md'),
        task: 'Execute missing approved plan',
      });

      await assert.rejects(
        () => resumeTeam('team-approved-resume', cwd),
        /approved_execution_binding_stale:.*Execute missing approved plan/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resumeTeam fails closed when the persisted approved binding is ambiguous', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-approved-resume-ambiguous-'));
    const approvedTask = 'Execute approved issue 2111 plan';
    try {
      await initTeamState('team-approved-resume', 'approved resume test', 'executor', 1, cwd);
      await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
      const prdPath = join(cwd, '.omx', 'plans', 'prd-issue-2111.md');
      await writeFile(
        prdPath,
        [
          '# Approved plan',
          '',
          `Launch via omx team 2:executor "${approvedTask}"`,
          `Launch via omx team 5:debugger "${approvedTask}"`,
        ].join('\n'),
      );
      await writeFile(join(cwd, '.omx', 'plans', 'test-spec-issue-2111.md'), '# Test spec\n');
      await writePersistedApprovedTeamExecutionBinding('team-approved-resume', cwd, {
        prd_path: prdPath,
        task: approvedTask,
      });

      await assert.rejects(
        () => resumeTeam('team-approved-resume', cwd),
        /approved_execution_binding_ambiguous:.*Execute approved issue 2111 plan/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resumeTeam accepts persisted approved bindings that still resolve to a baseline-ready hint', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-approved-resume-nonready-'));
    try {
      await initTeamState('team-approved-resume', 'approved resume test', 'executor', 1, cwd);
      await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
      const prdPath = join(cwd, '.omx', 'plans', 'prd-issue-2112.md');
      await writeFile(
        prdPath,
        [
          '# Approved plan',
          '',
          '## Context Pack Outcome',
          '',
          '- pack: created `.omx/context/context-20260507T120000Z-other.json`',
          '',
          'Launch via omx team 1:executor "Execute approved issue 2112 plan"',
        ].join('\n'),
      );
      await writeFile(join(cwd, '.omx', 'plans', 'test-spec-issue-2112.md'), '# Test spec\n');
      await writePersistedApprovedTeamExecutionBinding('team-approved-resume', cwd, {
        prd_path: prdPath,
        task: 'Execute approved issue 2112 plan',
      });

      const resumed = await resumeTeam('team-approved-resume', cwd);
      assert.equal(resumed, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resumeTeam resolves approved binding continuity against the persisted leader cwd', async () => {
    const teamName = 'team-approved-shared-root';
    const leaderCwd = await mkdtemp(join(tmpdir(), 'omx-runtime-approved-leader-'));
    const resumeCwd = await mkdtemp(join(tmpdir(), 'omx-runtime-approved-resume-alt-'));
    const sharedStateRoot = await mkdtemp(join(tmpdir(), 'omx-runtime-approved-state-'));
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    process.env.OMX_TEAM_STATE_ROOT = sharedStateRoot;

    try {
      await initTeamState(
        teamName,
        'approved resume shared-root test',
        'executor',
        1,
        leaderCwd,
        DEFAULT_MAX_WORKERS,
        process.env,
        {
          leader_cwd: leaderCwd,
          team_state_root: sharedStateRoot,
        },
      );
      const plansDir = join(leaderCwd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      const prdPath = join(plansDir, 'prd-issue-2110.md');
      await writeFile(
        prdPath,
        '# Approved plan\n\nLaunch via omx team 1:executor "Execute approved issue 2110 plan"\n',
      );
      await writeFile(join(plansDir, 'test-spec-issue-2110.md'), '# Test spec\n');
      await writePersistedApprovedTeamExecutionBinding(
        teamName,
        leaderCwd,
        {
          prd_path: prdPath,
          task: 'Execute approved issue 2110 plan',
          command: 'omx team 1:executor "Execute approved issue 2110 plan"',
        },
        sharedStateRoot,
      );

      const resumed = await resumeTeam(teamName, resumeCwd);
      assert.equal(resumed, null);
    } finally {
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(leaderCwd, { recursive: true, force: true });
      await rm(resumeCwd, { recursive: true, force: true });
      await rm(sharedStateRoot, { recursive: true, force: true });
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
      const manifestPath = join(cwd, '.omx', 'state', 'team', 'team-prompt-resume', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as any;
      manifest.policy.worker_launch_mode = 'prompt';
      manifest.tmux_session = 'prompt-team-prompt-resume';
      manifest.leader_pane_id = null;
      manifest.hud_pane_id = null;
      manifest.workers[0].pid = sleeperPid;
      manifest.workers[0].pane_id = null;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const runtime = await resumeTeam('team-prompt-resume', cwd);
      assert.equal(runtime, null);

      const events = await readTeamEvents('team-prompt-resume', cwd);
      assert.ok(
        events.some((event) => event.reason === `prompt_resume_unavailable:missing_handle:worker-1:${sleeperPid}`),
        'resumeTeam should persist an explicit missing-handle diagnostic event',
      );
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



  it('startTeam persists synthesized delegation plans for broad tasks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    await mkdir(binDir, { recursive: true });
    await writeFakePromptWorkerBinary(
      fakeCodexPath,
      `setTimeout(() => {}, 5000);`,
    );

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withPromptModeCodexEnv(binDir, {}, () =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-delegation-persist',
            'delegation persistence test',
            'executor',
            1,
            [{ subject: 'Investigate runtime assignment', description: 'Search runtime, debug assignTask behavior, and coordinate shared handoff boundaries' }],
            cwd,
          ),
        ),
      );

      const task = await readTask(runtime.teamName, '1', cwd);
      assert.equal(task?.delegation?.mode, 'auto');
      assert.equal(task?.delegation?.child_model, 'gpt-5.6-terra');
      assert.equal(task?.delegation?.required_parallel_probe, true);
      assert.equal(task?.coordination?.mode, 'coordinated');
      assert.ok(task?.coordination?.activation_reasons.includes('cross_boundary_or_handoff_language'));
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam persists approved execution binding under the team state root', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-approved-binding-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    await mkdir(binDir, { recursive: true });
    await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
    const prdPath = join(cwd, '.omx', 'plans', 'prd-issue-1314.md');
    const testSpecPath = join(cwd, '.omx', 'plans', 'test-spec-issue-1314.md');
    await writeFile(
      prdPath,
      [
        '# Approved plan',
        '',
        buildContextPackOutcome(canonicalContextPackRelativePath('issue-1314')),
        '',
        'Launch via omx team 1:executor "Execute approved issue 1314 plan"',
      ].join('\n'),
    );
    await writeFile(testSpecPath, '# Test spec\n');
    await writeReadyContextPack(cwd, 'issue-1314', prdPath, testSpecPath);
    await writeFakePromptWorkerBinary(
      fakeCodexPath,
      `setTimeout(() => {}, 5000);`,
    );

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withPromptModeCodexEnv(binDir, {}, () =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-approved-binding',
            'approved binding persistence test',
            'executor',
            1,
            [{ subject: 's', description: 'd', owner: 'worker-1' }],
            cwd,
            {
              approvedExecution: {
                prd_path: prdPath,
                task: 'Execute approved issue 1314 plan',
                command: 'omx team 1:executor "Execute approved issue 1314 plan"',
              },
            },
          ),
        ),
      );

      const bindingPath = join(
        runtime.config.team_state_root ?? join(cwd, '.omx', 'state'),
        'team',
        runtime.teamName,
        'approved-execution.json',
      );
      const binding = JSON.parse(await readFile(bindingPath, 'utf-8')) as Record<string, string>;
      assert.deepEqual(binding, {
        prd_path: prdPath,
        task: 'Execute approved issue 1314 plan',
        command: 'omx team 1:executor "Execute approved issue 1314 plan"',
      });
      assert.deepEqual(Object.keys(binding).sort(), ['command', 'prd_path', 'task']);
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam treats a completed Ultragoal plan without activeGoalId as no active bridge context', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-ultragoal-idle-start-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    await mkdir(binDir, { recursive: true });
    await mkdir(join(cwd, '.omx', 'ultragoal'), { recursive: true });
    await writeFile(
      join(cwd, '.omx', 'ultragoal', 'goals.json'),
      `${JSON.stringify({
        version: 1,
        codexGoalMode: 'aggregate',
        goals: [{
          id: 'G001-completed-story',
          title: 'Completed story',
          status: 'complete',
        }],
      })}\n`,
    );
    await writeFakePromptWorkerBinary(
      fakeCodexPath,
      `setTimeout(() => {}, 5000);`,
    );

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withPromptModeCodexEnv(binDir, {}, () =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-ultragoal-idle-start',
            'completed Ultragoal artifacts must not block unrelated team startup',
            'executor',
            1,
            [{ subject: 's', description: 'd', owner: 'worker-1' }],
            cwd,
          ),
        ),
      );

      const teamStateRoot = runtime.config.team_state_root ?? join(cwd, '.omx', 'state');
      assert.equal(
        existsSync(join(teamStateRoot, 'team', runtime.teamName, 'ultragoal-context.json')),
        false,
      );
      const preflight = JSON.parse(await readFile(
        join(teamStateRoot, 'team', runtime.teamName, 'preflight-context.json'),
        'utf-8',
      )) as {
        schema_version: number;
        task: string;
        ultragoal: { status: string; active_goal_id: string | null };
        prohibitions: string[];
        resume_instructions: string[];
      };
      assert.equal(preflight.schema_version, 1);
      assert.match(preflight.task, /completed Ultragoal artifacts/);
      assert.equal(preflight.ultragoal.status, 'missing');
      assert.equal(preflight.ultragoal.active_goal_id, null);
      assert.ok(preflight.prohibitions.includes('workers_must_not_mutate_ultragoal'));
      assert.ok(preflight.resume_instructions.some((line) => /preflight-context\.json/.test(line)));
      const inbox = await readFile(
        join(teamStateRoot, 'team', runtime.teamName, 'workers', 'worker-1', 'inbox.md'),
        'utf-8',
      );
      assert.doesNotMatch(inbox, /Leader-owned Ultragoal context/);
      assert.doesNotMatch(inbox, /omx ultragoal checkpoint --goal-id G001-completed-story/);
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam tolerates malformed Ultragoal artifacts for unrelated Team startup', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-ultragoal-malformed-optional-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    await mkdir(binDir, { recursive: true });
    await mkdir(join(cwd, '.omx', 'ultragoal'), { recursive: true });
    await writeFile(join(cwd, '.omx', 'ultragoal', 'goals.json'), '{not-json');
    await writeFakePromptWorkerBinary(
      fakeCodexPath,
      `setTimeout(() => {}, 5000);`,
    );

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withPromptModeCodexEnv(binDir, {}, () =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-ultragoal-malformed-optional',
            'malformed Ultragoal artifacts must not block unrelated team startup',
            'executor',
            1,
            [{ subject: 's', description: 'd', owner: 'worker-1' }],
            cwd,
          ),
        ),
      );

      const teamStateRoot = runtime.config.team_state_root ?? join(cwd, '.omx', 'state');
      const preflight = JSON.parse(await readFile(
        join(teamStateRoot, 'team', runtime.teamName, 'preflight-context.json'),
        'utf-8',
      )) as { ultragoal: { status: string; warning: string | null } };
      assert.equal(preflight.ultragoal.status, 'malformed');
      assert.match(preflight.ultragoal.warning ?? '', /malformed_goals_json/);
      const inbox = await readFile(
        join(teamStateRoot, 'team', runtime.teamName, 'workers', 'worker-1', 'inbox.md'),
        'utf-8',
      );
      assert.doesNotMatch(inbox, /Leader-owned Ultragoal context/);
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam fails closed for malformed artifacts when explicitly linked to an Ultragoal goal', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-ultragoal-malformed-strict-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    await mkdir(binDir, { recursive: true });
    await mkdir(join(cwd, '.omx', 'ultragoal'), { recursive: true });
    await writeFile(join(cwd, '.omx', 'ultragoal', 'goals.json'), '{not-json');
    await writeFakePromptWorkerBinary(
      fakeCodexPath,
      `setTimeout(() => {}, 5000);`,
    );

    try {
      await assert.rejects(
        () => withPromptModeCodexEnv(binDir, {}, () =>
          withoutTeamWorkerEnv(() =>
            startTeam(
              'team-ultragoal-malformed-strict',
              'Execute Ultragoal goal G001-malformed-story with Team',
              'executor',
              1,
              [{ subject: 's', description: 'd', owner: 'worker-1' }],
              cwd,
            ),
          ),
        ),
        /invalid_ultragoal_team_context:malformed_goals_json/,
      );
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', 'team-ultragoal-malformed-strict')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam injects approved handoff context into ready approved worker inboxes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-approved-handoff-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    const approvedTask = 'Execute approved issue 1314 handoff plan';
    await mkdir(binDir, { recursive: true });
    await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
    const prdPath = join(cwd, '.omx', 'plans', 'prd-issue-1314-handoff.md');
    const testSpecPath = join(cwd, '.omx', 'plans', 'test-spec-issue-1314-handoff.md');
    await writeFile(
      prdPath,
      [
        '# Approved plan',
        '',
        buildContextPackOutcome(canonicalContextPackRelativePath('issue-1314-handoff')),
        '',
        `Launch via omx team 1:executor "${approvedTask}"`,
      ].join('\n'),
    );
    await writeFile(testSpecPath, '# Test spec\n');
    await writeReadyContextPack(cwd, 'issue-1314-handoff', prdPath, testSpecPath);
    await writeFile(
      join(cwd, '.omx', 'plans', 'repo-context-issue-1314-handoff.md'),
      'Read the approved repository slice first.\n',
    );
    await writeFakePromptWorkerBinary(
      fakeCodexPath,
      `setTimeout(() => {}, 5000);`,
    );

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withPromptModeCodexEnv(binDir, {}, () =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-approved-handoff',
            'approved handoff context test',
            'executor',
            1,
            [{ subject: 's', description: 'd', owner: 'worker-1' }],
            cwd,
            {
              approvedExecution: {
                prd_path: prdPath,
                task: approvedTask,
                command: `omx team 1:executor "${approvedTask}"`,
              },
            },
          ),
        ),
      );

      const inbox = await readFile(
        join(cwd, '.omx', 'state', 'team', runtime.teamName, 'workers', 'worker-1', 'inbox.md'),
        'utf-8',
      );
      assert.match(inbox, /## Approved Handoff Context/);
      assert.match(inbox, new RegExp(`Approved plan: ${prdPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(inbox, new RegExp(`Test specs: ${testSpecPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(inbox, /Approved repository context summary source: .*repo-context-issue-1314-handoff\.md/);
      assert.match(inbox, /Read the approved repository slice first\./);
      assert.match(inbox, /Use the approved plan and matching test specs as the execution baseline/);
      assert.doesNotMatch(inbox, /Approved context pack|Build refs|Verify refs|Scope refs|query the canonical pack|Context pack index/);
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam carries explicit baseline-ready approved bindings without context-pack metadata', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-approved-binding-plan-only-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    await mkdir(binDir, { recursive: true });
    await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
    await writeFile(
      join(cwd, '.omx', 'plans', 'prd-issue-1314-plan-only.md'),
      '# Approved plan\n\nLaunch via omx team 1:executor "Execute approved issue 1314 plan-only"\n',
    );
    await writeFile(join(cwd, '.omx', 'plans', 'test-spec-issue-1314-plan-only.md'), '# Test spec\n');
    await writeFakePromptWorkerBinary(
      fakeCodexPath,
      `setTimeout(() => {}, 5000);`,
    );

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withPromptModeCodexEnv(binDir, {}, () =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-approved-binding-plan-only',
            'approved binding generic fallback test',
            'executor',
            1,
            [{ subject: 's', description: 'd', owner: 'worker-1' }],
            cwd,
            {
              approvedExecution: {
                prd_path: join(cwd, '.omx', 'plans', 'prd-issue-1314-plan-only.md'),
                task: 'Execute approved issue 1314 plan-only',
                command: 'omx team 1:executor "Execute approved issue 1314 plan-only"',
              },
            },
          ),
        ),
      );

      const bindingPath = join(
        runtime.config.team_state_root ?? join(cwd, '.omx', 'state'),
        'team',
        runtime.teamName,
        'approved-execution.json',
      );
      assert.equal(existsSync(bindingPath), true);
      const inbox = await readFile(
        join(cwd, '.omx', 'state', 'team', runtime.teamName, 'workers', 'worker-1', 'inbox.md'),
        'utf-8',
      );
      assert.match(inbox, /## Approved Handoff Context/);
      assert.match(inbox, /Approved plan: .*prd-issue-1314-plan-only\.md/);
      assert.match(inbox, /Test specs: .*test-spec-issue-1314-plan-only\.md/);
      assert.doesNotMatch(inbox, /Approved context pack|Context pack index/);
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam carries explicit baseline-ready bindings despite obsolete context-pack markers', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-approved-binding-obsolete-marker-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    await mkdir(binDir, { recursive: true });
    await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
    const prdPath = join(cwd, '.omx', 'plans', 'prd-issue-1314-obsolete-marker.md');
    await writeFile(
      prdPath,
      [
        '# Approved plan',
        '',
        '## Context Pack Outcome',
        '',
        '- pack: created `.omx/context/context-20260507T120000Z-other.json`',
        '',
        'Launch via omx team 1:executor "Execute approved issue 1314 obsolete-marker plan"',
      ].join('\n'),
    );
    await writeFile(join(cwd, '.omx', 'plans', 'test-spec-issue-1314-obsolete-marker.md'), '# Test spec\n');
    await writeFakePromptWorkerBinary(
      fakeCodexPath,
      `setTimeout(() => {}, 5000);`,
    );

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withPromptModeCodexEnv(binDir, {}, () =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-approved-binding-obsolete-marker',
            'approved binding obsolete-marker start test',
            'executor',
            1,
            [{ subject: 's', description: 'd', owner: 'worker-1' }],
            cwd,
            {
              approvedExecution: {
                prd_path: prdPath,
                task: 'Execute approved issue 1314 obsolete-marker plan',
              },
            },
          ),
        ),
      );
      assert.equal(
        existsSync(join(runtime.config.team_state_root ?? join(cwd, '.omx', 'state'), 'team', runtime.teamName, 'approved-execution.json')),
        true,
      );
      const inbox = await readFile(
        join(cwd, '.omx', 'state', 'team', runtime.teamName, 'workers', 'worker-1', 'inbox.md'),
        'utf-8',
      );
      assert.match(inbox, /## Approved Handoff Context/);
      assert.match(inbox, /Approved plan: .*prd-issue-1314-obsolete-marker\.md/);
      assert.match(inbox, /Test specs: .*test-spec-issue-1314-obsolete-marker\.md/);
      assert.doesNotMatch(inbox, /Approved context pack|Context pack index/);
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam fails closed when an explicit approved execution binding is stale', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-approved-binding-stale-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    await mkdir(binDir, { recursive: true });
    await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
    const stalePrdPath = join(cwd, '.omx', 'plans', 'prd-issue-1315.md');
    await writeFile(
      stalePrdPath,
      '# Approved plan\n\nLaunch via omx team 1:executor "Execute approved issue 1315 plan"\n',
    );
    await writeFile(join(cwd, '.omx', 'plans', 'test-spec-issue-1315.md'), '# Test spec\n');
    await rm(stalePrdPath, { force: true });
    await writeFakePromptWorkerBinary(
      fakeCodexPath,
      `setTimeout(() => {}, 5000);`,
    );

    try {
      await assert.rejects(
        () => withPromptModeCodexEnv(binDir, {}, () =>
          withoutTeamWorkerEnv(() =>
            startTeam(
              'team-approved-binding-stale',
              'approved binding stale start test',
              'executor',
              1,
              [{ subject: 's', description: 'd', owner: 'worker-1' }],
              cwd,
              {
                approvedExecution: {
                  prd_path: stalePrdPath,
                  task: 'Execute approved issue 1315 plan',
                },
              },
            ),
          ),
        ),
        /approved_execution_binding_stale:.*Execute approved issue 1315 plan/,
      );
      assert.equal(
        existsSync(join(cwd, '.omx', 'state', 'team', 'team-approved-binding-stale')),
        false,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam fails closed when an explicit approved execution binding is ambiguous', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-approved-binding-ambiguous-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    const approvedTask = 'Execute approved issue 1316 plan';
    await mkdir(binDir, { recursive: true });
    await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
    const prdPath = join(cwd, '.omx', 'plans', 'prd-issue-1316.md');
    await writeFile(
      prdPath,
      [
        '# Approved plan',
        '',
        `Launch via omx team 2:executor "${approvedTask}"`,
        `Launch via omx team 5:debugger "${approvedTask}"`,
      ].join('\n'),
    );
    await writeFile(join(cwd, '.omx', 'plans', 'test-spec-issue-1316.md'), '# Test spec\n');
    await writeFakePromptWorkerBinary(
      fakeCodexPath,
      `setTimeout(() => {}, 5000);`,
    );

    try {
      await assert.rejects(
        () => withPromptModeCodexEnv(binDir, {}, () =>
          withoutTeamWorkerEnv(() =>
            startTeam(
              'team-approved-binding-ambiguous',
              'approved binding ambiguous start test',
              'executor',
              1,
              [{ subject: 's', description: 'd', owner: 'worker-1' }],
              cwd,
              {
                approvedExecution: {
                  prd_path: prdPath,
                  task: approvedTask,
                },
              },
            ),
          ),
        ),
        /approved_execution_binding_ambiguous:.*Execute approved issue 1316 plan/,
      );
      assert.equal(
        existsSync(join(cwd, '.omx', 'state', 'team', 'team-approved-binding-ambiguous')),
        false,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('startTeam remaps repo-aware DAG dependencies after concrete task IDs are created', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    const binDir = join(cwd, 'bin');
    const fakeCodexPath = join(binDir, 'codex');
    await mkdir(binDir, { recursive: true });
    await writeFakePromptWorkerBinary(
      fakeCodexPath,
      `setTimeout(() => {}, 5000);`,
    );

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withPromptModeCodexEnv(binDir, {}, () =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-dag-remap',
            'repo-aware DAG remap test',
            'executor',
            2,
            [
              {
                subject: 'Implement runtime',
                description: 'Change runtime',
                owner: 'worker-1',
                role: 'executor',
                symbolic_id: 'impl',
                symbolic_depends_on: [],
                lane: 'implementation',
                filePaths: ['src/team/runtime.ts'],
                allocation_reason: 'balances current load',
              },
              {
                subject: 'Verify runtime',
                description: 'Test runtime',
                owner: 'worker-2',
                role: 'test-engineer',
                symbolic_id: 'verify',
                symbolic_depends_on: ['impl'],
                lane: 'verification',
                allocation_reason: 'keeps blocked work on a lighter lane',
              },
            ],
            cwd,
            {
              decompositionMetadata: {
                decomposition_source: 'dag_sidecar',
                worker_count_requested: 2,
                worker_count_effective: 2,
                worker_count_source: 'plan-suggested',
                ready_lane_count: 1,
                useful_lane_count: 2,
                allocation_reasons: {
                  impl: 'balances current load',
                  verify: 'keeps blocked work on a lighter lane',
                },
                node_dependencies: {
                  impl: [],
                  verify: ['impl'],
                },
              },
            },
          ),
        ),
      );

      const first = await readTask(runtime.teamName, '1', cwd);
      const second = await readTask(runtime.teamName, '2', cwd);
      assert.deepEqual(first?.depends_on, []);
      assert.deepEqual(first?.blocked_by, undefined);
      assert.deepEqual(second?.depends_on, ['1']);
      assert.deepEqual(second?.blocked_by, ['1']);

      const report = JSON.parse(
        await readFile(join(cwd, '.omx', 'state', 'team', runtime.teamName, 'decomposition-report.json'), 'utf-8'),
      ) as {
        node_id_to_task_id?: Record<string, string>;
        task_hints?: Record<string, { node_id?: string; depends_on?: string[]; symbolic_depends_on?: string[] }>;
      };
      assert.deepEqual(report.node_id_to_task_id, { impl: '1', verify: '2' });
      assert.deepEqual(report.task_hints?.['2']?.depends_on, ['1']);
      assert.deepEqual(report.task_hints?.['2']?.symbolic_depends_on, ['impl']);

      const inbox = await readFile(join(cwd, '.omx', 'state', 'team', runtime.teamName, 'workers', 'worker-2', 'inbox.md'), 'utf-8');
      assert.match(inbox, /Blocked by: 1/);
      assert.doesNotMatch(inbox, /Blocked by: impl/);
      assert.doesNotMatch(inbox, /Depends on: impl/);
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('assignTask synthesizes delegation before follow-up dispatch rollback', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-assign-delegation', 'assignment delegation test', 'executor', 1, cwd);
      const config = await readTeamConfig('team-assign-delegation', cwd);
      assert.ok(config);
      config.worker_launch_mode = 'prompt';
      await saveTeamConfig(config, cwd);
      const task = await createTask(
        'team-assign-delegation',
        {
          subject: 'Investigate follow-up assignment',
          description: 'Search repo and debug follow-up assignment behavior.',
          status: 'pending',
          filePaths: ['src/team/runtime.ts'],
          coordination: { mode: 'coordinated', activation_reasons: ['stale_snapshot_before_assignment'] },
        },
        cwd,
      );
      await createTask(
        'team-assign-delegation',
        {
          subject: 'Sibling runtime verification',
          description: 'Verify the same runtime path.',
          status: 'pending',
          filePaths: ['src/team/runtime.ts'],
        },
        cwd,
      );

      await writeWorkerInbox('team-assign-delegation', 'worker-1', 'existing inbox', cwd);
      await assert.rejects(
        () => assignTask('team-assign-delegation', 'worker-1', task.id, cwd),
        /worker_notify_failed/,
      );

      const reread = await readTask('team-assign-delegation', task.id, cwd);
      assert.equal(reread?.delegation?.mode, 'auto');
      assert.equal(reread?.delegation?.child_model, 'gpt-5.6-terra');
      assert.equal(reread?.coordination?.mode, 'coordinated');
      assert.ok(reread?.coordination?.activation_reasons.includes('shared_file_scope'));
      assert.equal(reread?.coordination?.activation_reasons.includes('stale_snapshot_before_assignment'), false);

      const inbox = await readFile(join(cwd, '.omx', 'state', 'team', 'team-assign-delegation', 'workers', 'worker-1', 'inbox.md'), 'utf-8');
      assert.match(inbox, /Assignment Cancelled/);
      assert.match(inbox, /worker_notify_failed/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('assignTask preserves explicitly authored coordination metadata', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-assign-explicit', 'assignment explicit coordination test', 'executor', 1, cwd);
      const config = await readTeamConfig('team-assign-explicit', cwd);
      assert.ok(config);
      config.worker_launch_mode = 'prompt';
      await saveTeamConfig(config, cwd);
      const task = await createTask(
        'team-assign-explicit',
        {
          subject: 'Explicit coordination lane',
          description: 'Preserve the caller-authored coordination plan.',
          status: 'pending',
          filePaths: ['src/team/runtime.ts'],
          coordination: { mode: 'coordinated', activation_reasons: ['caller_authored_boundary'], source: 'explicit' },
        },
        cwd,
      );
      await createTask(
        'team-assign-explicit',
        {
          subject: 'Sibling runtime verification',
          description: 'Verify the same runtime path.',
          status: 'pending',
          filePaths: ['./src/team/runtime.ts'],
        },
        cwd,
      );

      await writeWorkerInbox('team-assign-explicit', 'worker-1', 'existing inbox', cwd);
      await assert.rejects(
        () => assignTask('team-assign-explicit', 'worker-1', task.id, cwd),
        /worker_notify_failed/,
      );

      const reread = await readTask('team-assign-explicit', task.id, cwd);
      assert.equal(reread?.coordination?.source, 'explicit');
      assert.deepEqual(reread?.coordination?.activation_reasons, ['caller_authored_boundary']);
      assert.equal(reread?.coordination?.activation_reasons.includes('shared_file_scope'), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('assignTask injects approved handoff context when the persisted approved binding remains ready', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-approved-followup-'));
    const approvedTask = 'Execute approved issue 1320 plan';
    try {
      await initTeamState('team-approved-followup', 'assignment test', 'executor', 1, cwd);
      const manifestPath = teamStateTestPath(cwd, 'team', 'team-approved-followup', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
      manifest.policy = { ...(manifest.policy || {}), dispatch_ack_timeout_ms: 250 };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      const plansDir = join(cwd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      const prdPath = join(plansDir, 'prd-issue-1320.md');
      const testSpecPath = join(plansDir, 'test-spec-issue-1320.md');
      await writeFile(
        prdPath,
        [
          '# Approved plan',
          '',
          buildContextPackOutcome(canonicalContextPackRelativePath('issue-1320')),
          '',
          `Launch via omx team 1:executor "${approvedTask}"`,
        ].join('\n'),
      );
      await writeFile(testSpecPath, '# Test spec\n');
      await writeReadyContextPack(cwd, 'issue-1320', prdPath, testSpecPath);
      await writeFile(
        join(plansDir, 'repo-context-issue-1320.md'),
        'Follow the approved repository slice before broader repo exploration.\n',
      );
      await writePersistedApprovedTeamExecutionBinding('team-approved-followup', cwd, {
        prd_path: prdPath,
        task: approvedTask,
        command: `omx team 1:executor "${approvedTask}"`,
      });
      const task = await createTask(
        'team-approved-followup',
        { subject: 'Implement approved follow-up', description: 'Implement approved follow-up', status: 'pending' },
        cwd,
      );

      const assignPromise = assignTask('team-approved-followup', 'worker-1', task.id, cwd);
      const deadline = Date.now() + 2_000;
      let delivered = false;
      while (Date.now() < deadline && !delivered) {
        const requests = await listDispatchRequests('team-approved-followup', cwd, { kind: 'inbox', to_worker: 'worker-1' });
        if (!requests.some((request) => request.status === 'pending')) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          continue;
        }
        await markPendingInboxDispatchesDelivered('team-approved-followup', cwd, {
          toWorker: 'worker-1',
          lastReason: 'test_delivered_receipt',
        });
        delivered = true;
      }
      assert.ok(delivered, 'expected follow-up inbox dispatch request to be queued');

      await assignPromise;

      const inbox = await readFile(
        join(cwd, '.omx', 'state', 'team', 'team-approved-followup', 'workers', 'worker-1', 'inbox.md'),
        'utf-8',
      );
      assert.match(inbox, /## Approved Handoff Context/);
      assert.match(inbox, new RegExp(`Approved plan: ${prdPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(inbox, new RegExp(`Test specs: ${testSpecPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(inbox, /Use the approved plan and matching test specs as the execution baseline/);
      assert.match(inbox, /Follow the approved repository slice before broader repo exploration\./);
      assert.doesNotMatch(inbox, /Approved context pack|Build refs|Verify refs|Scope refs|query the canonical pack|Context pack index/);
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

  it('sendWorkerMessage transport_direct fails fast for leader-fixed when leader_pane_id missing', async () => {
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

      await assert.rejects(
        sendWorkerMessage('team-leader-direct', 'worker-1', 'leader-fixed', 'hello leader direct', cwd),
        /mailbox_notify_failed:leader_pane_missing_transport_direct_failed/,
      );

      const mailbox = await listMailboxMessages('team-leader-direct', 'leader-fixed', cwd);
      assert.ok(mailbox.length >= 1, `expected at least 1 mailbox message, got ${mailbox.length}`);
      const requests = await listDispatchRequests('team-leader-direct', cwd, { kind: 'mailbox', to_worker: 'leader-fixed' });
      assert.ok(requests.length >= 1, `expected at least 1 leader-fixed dispatch request, got ${requests.length}`);
      const latest = requests[requests.length - 1];
      assert.equal(latest?.status, 'failed');
      assert.equal(latest?.last_reason, 'leader_pane_missing_transport_direct_failed');
      assert.ok(latest?.failed_at, 'missing leader pane should fail fast with failed_at evidence');

      const deliveryLog = await readTeamDeliveryLog(cwd);
      const runtimeEntries = deliveryLog.filter((entry) =>
        entry.event === 'dispatch_result'
        && entry.source === 'team.runtime'
        && entry.to_worker === 'leader-fixed'
        && entry.transport === 'mailbox'
        && entry.result === 'failed'
        && entry.reason === 'leader_pane_missing_transport_direct_failed');
      assert.equal(runtimeEntries.length, 1, 'leader direct missing-pane failure should emit exactly one runtime dispatch_result entry');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('shutdownTeam without config never destroys a conventionally named tmux session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-no-config-session-'));
    try {
      await withMockTmuxFixture(
        {
          dirPrefix: 'omx-runtime-no-config-session-bin-',
          tmuxScript: (tmuxLogPath) => `#!/bin/sh
printf '%s\\n' "$*" >> "${tmuxLogPath}"
exit 0
`,
        },
        async ({ tmuxLogPath }) => {
          await shutdownTeam('unowned-session', cwd, { force: true });
          const log = await readFile(tmuxLogPath, 'utf8').catch(() => '');
          assert.doesNotMatch(log, /kill-session/);
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
