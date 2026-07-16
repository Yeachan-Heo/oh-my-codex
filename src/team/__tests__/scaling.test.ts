import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod, readdir, symlink } from 'fs/promises';
import { join, posix, relative, win32 } from 'path';
import { tmpdir } from 'os';
import { existsSync, readFileSync } from 'fs';
import {
  initTeamState,
  createTask,
  claimTask,
  readTask,
  readTeamConfig,
  saveTeamConfig,
  readWorkerStatus,
  writeWorkerStatus,
  withScalingLock,
  recoverTeamMembershipTaskTransaction,
  commitTeamMembershipTaskTransaction,
  withTeamTaskBarrier,
  DEFAULT_MAX_WORKERS,
  listDispatchRequests,
  readTeamManifestV2,
} from '../state.js';
import { isSameOrInsidePath, isScalingEnabled, reconcileScaleDownCleanupDebt, scaleUp, scaleDown } from '../scaling.js';
import { resolveCanonicalTeamStateRoot } from '../state-root.js';
import {
  resolvePersistedApprovedTeamExecutionContinuityState,
  writePersistedApprovedTeamExecutionBinding,
} from '../approved-execution.js';
import { TEAM_WORKER_INHERITED_MODEL_ENV } from '../model-contract.js';
import { buildWorkerProcessLaunchSpec } from '../tmux-session.js';


delete process.env.OMX_TEAM_STATE_ROOT;
process.env.OMX_RUNTIME_BRIDGE = '0';

async function initCommittedGitRepo(cwd: string): Promise<void> {
  execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'OMX Test'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'omx@example.com'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'pipe' });
}

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-worktree-repo-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

function computeGitBlobSha1(content: string): string {
  const buffer = Buffer.from(content, 'utf-8');
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf-8');
  return createHash('sha1').update(header).update(buffer).digest('hex');
}

function withoutConfigGeneration(bytes: string): Record<string, unknown> {
  const value = JSON.parse(bytes) as Record<string, unknown>;
  delete value.config_generation;
  return value;
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


function workerStartupScriptPath(cwd: string, teamName: string, workerName: string): string {
  return join(cwd, '.omx', 'state', 'team', teamName, 'runtime', `${workerName}-startup.sh`);
}

type ContextPackRole = 'scope' | 'build' | 'verify';

type ScaleUpApprovedBindingState =
  | 'missing'
  | 'malformed'
  | 'stale'
  | 'ambiguous'
  | 'missing-baseline'
  | 'plan-only'
  | 'incomplete'
  | 'invalid'
  | 'ready';

type ScaleUpObservedOutcome = 'generic' | 'blocked' | 'approved';

type ScaleUpCount = 1 | 2 | 3;

type BlockedScaleUpApprovedBindingState = Exclude<
  ScaleUpApprovedBindingState,
  'missing' | 'plan-only' | 'incomplete' | 'invalid' | 'ready'
>;

const BLOCKED_SCALE_UP_APPROVED_BINDING_STATES: readonly BlockedScaleUpApprovedBindingState[] = [
  'malformed',
  'stale',
  'ambiguous',
  'missing-baseline',
];

const SCALE_UP_STATE_TEAM_SUFFIX: Record<ScaleUpApprovedBindingState, string> = {
  missing: 'miss',
  malformed: 'mal',
  stale: 'stale',
  ambiguous: 'amb',
  'missing-baseline': 'mbase',
  'plan-only': 'ponly',
  incomplete: 'inc',
  invalid: 'inv',
  ready: 'ready',
};

const SCALE_UP_APPROVED_BINDING_STATES: readonly ScaleUpApprovedBindingState[] = [
  'missing',
  ...BLOCKED_SCALE_UP_APPROVED_BINDING_STATES,
  'plan-only',
  'incomplete',
  'invalid',
  'ready',
];

const SCALE_UP_COUNTS: readonly ScaleUpCount[] = [1, 2, 3];

function assertNeverScaleUpState(state: never): never {
  throw new Error(`unexpected scale-up approved binding state: ${state}`);
}

function expectedScaleUpOutcome(state: ScaleUpApprovedBindingState): ScaleUpObservedOutcome {
  if (state === 'missing') {
    return 'generic';
  }
  return BLOCKED_SCALE_UP_APPROVED_BINDING_STATES.includes(state as BlockedScaleUpApprovedBindingState)
    ? 'blocked'
    : 'approved';
}

function forbiddenScaleUpOutcomes(
  state: ScaleUpApprovedBindingState,
): readonly ScaleUpObservedOutcome[] {
  switch (state) {
    case 'missing':
      return ['blocked', 'approved'];
    case 'plan-only':
    case 'incomplete':
    case 'invalid':
    case 'ready':
      return ['blocked', 'generic'];
    case 'malformed':
    case 'stale':
    case 'ambiguous':
    case 'missing-baseline':
      return ['generic', 'approved'];
    default:
      return assertNeverScaleUpState(state);
  }
}

function buildScaleUpScenarioTasks(
  state: ScaleUpApprovedBindingState,
  count: ScaleUpCount,
): Array<{ subject: string; description: string; owner: string }> {
  return Array.from({ length: count }, (_, index) => {
    const workerIndex = index + 2;
    return {
      subject: `Implement ${state} follow-up ${workerIndex}/${count}`,
      description: `Implement ${state} follow-up ${workerIndex}/${count}`,
      owner: `worker-${workerIndex}`,
    };
  });
}

async function writeContextPack(
  cwd: string,
  slug: string,
  prdPath: string,
  testSpecPath: string,
  roles: readonly ContextPackRole[],
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

async function writeSuccessfulScaleUpTmuxStub(
  fakeBinDir: string,
  tmuxLogPath: string,
): Promise<void> {
  const tmuxStubPath = join(fakeBinDir, 'tmux');
  await writeFile(
    tmuxStubPath,
    [
      '#!/bin/sh',
      'set -eu',
      `printf '%s\n' "$*" >> "${tmuxLogPath}"`,
      'case "${1:-}" in',
          '  show-option) echo "team:scale-up" ;;',
      '  -V)',
      '    echo "tmux 3.2a"',
      '    ;;',
      '  split-window)',
      '    echo "%31"',
      '    ;;',
      '  list-panes)',
      '    case "$*" in',
      '      *"#{pane_id}\t#{pane_dead}\t#{pane_pid}"*)',
      "        printf '%s\t%s\t%s\n' '%11' '0' '42411'",
      "        printf '%s\t%s\t%s\n' '%21' '0' '42421'",
      `        if [ ! -f "${join(fakeBinDir, 'killed-%31')}" ]; then printf '%s\\t%s\\t%s\\n' '%31' '0' '42424'; fi`,
      '        ;;',
      '      *)',
      '        echo "42424"',
      '        ;;',
      '    esac',
      '    ;;',
      '  show-option)',
      '    case "$*" in',
      '      *"@omx_team_pane_owner_id"*) echo "team:scale-up" ;;',
      '      *) exit 1 ;;',
      '    esac',
      '    ;;',
      '  send-keys)',
      '    ;;',
      '  kill-pane)',
      `    : > "${join(fakeBinDir, 'killed-')}$3"`,
      '    ;;',
      '  capture-pane)',
      '    echo ""',
      '    ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
  );
  await chmod(tmuxStubPath, 0o755);
  await writeFile(tmuxLogPath, '');
}

async function configureScaleUpTeamForDirectDispatch(teamName: string, cwd: string): Promise<void> {
  const config = await readTeamConfig(teamName, cwd);
  assert.ok(config);
  if (!config) {
    throw new Error(`missing team config for ${teamName}`);
  }
  config.tmux_session = `omx-team-${teamName}`;
  config.tmux_pane_owner_id = 'team:scale-up';
  config.leader_pane_id = '%11';

  config.tmux_pane_owner_id = 'team:scale-up';
  config.leader_pane_pid = 42411;
  config.workers[0]!.pane_id = '%21';
  config.workers[0]!.pid = 42421;
  await saveTeamConfig(config, cwd);

  const manifestPath = join(cwd, '.omx', 'state', 'team', teamName, 'manifest.v2.json');
  if (!existsSync(manifestPath)) {
    await mkdir(join(cwd, '.omx', 'state', 'team', teamName), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify({ version: 2, policy: {} }, null, 2)}\n`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
  manifest.policy = {
    ...(manifest.policy ?? {}),
    dispatch_mode: 'transport_direct',
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

async function readScaleUpTmuxLogCommands(tmuxLogPath: string): Promise<string[]> {
  const content = await readFile(tmuxLogPath, 'utf-8');
  const trimmed = content.trim();
  return trimmed === '' ? [] : trimmed.split('\n');
}

async function readScaleUpTaskPayloads(teamName: string, cwd: string): Promise<string[]> {
  const tasksDir = join(cwd, '.omx', 'state', 'team', teamName, 'tasks');
  if (!existsSync(tasksDir)) {
    return [];
  }
  const taskFiles = (await readdir(tasksDir)).filter((entry) => entry.endsWith('.json')).sort();
  return await Promise.all(taskFiles.map((entry) => readFile(join(tasksDir, entry), 'utf-8')));
}

async function readExpectedScaleUpApprovedBindingError(
  teamName: string,
  cwd: string,
): Promise<string | null> {
  const continuity = await resolvePersistedApprovedTeamExecutionContinuityState(teamName, cwd);
  if (continuity.status === 'missing') {
    return null;
  }
  if (continuity.status === 'malformed') {
    return `approved_execution_binding_malformed:${teamName}`;
  }
  if (continuity.status === 'ambiguous') {
    return `approved_execution_binding_ambiguous:${continuity.binding.prd_path}:${continuity.binding.task}`;
  }
  if (continuity.status === 'stale') {
    return `approved_execution_binding_stale:${continuity.binding.prd_path}:${continuity.binding.task}`;
  }
  return null;
}

async function prepareScaleUpApprovedBindingState(
  teamName: string,
  cwd: string,
  state: Exclude<ScaleUpApprovedBindingState, 'missing'>,
): Promise<void> {
  if (state === 'malformed') {
    await writeFile(
      join(cwd, '.omx', 'state', 'team', teamName, 'approved-execution.json'),
      '{"prd_path":42}\n',
    );
    return;
  }

  const plansDir = join(cwd, '.omx', 'plans');
  const approvedTask = `Execute ${state} scale-up handoff`;
  const prdPath = join(plansDir, `prd-${state}.md`);
  const testSpecPath = join(plansDir, `test-spec-${state}.md`);
  await mkdir(plansDir, { recursive: true });

  if (state === 'stale') {
    await writePersistedApprovedTeamExecutionBinding(teamName, cwd, {
      prd_path: prdPath,
      task: approvedTask,
      command: `omx team 1:executor "${approvedTask}"`,
    });
    return;
  }

  if (state === 'ambiguous') {
    await writeFile(
      prdPath,
      [
        '# Approved plan',
        '',
        `Launch via omx team 1:executor "${approvedTask}"`,
        `Launch via omx team 2:writer "${approvedTask}"`,
      ].join('\n'),
    );
    await writePersistedApprovedTeamExecutionBinding(teamName, cwd, {
      prd_path: prdPath,
      task: approvedTask,
    });
    return;
  }

  const prdLines = ['# Approved plan', ''];
  if (state === 'incomplete' || state === 'invalid' || state === 'ready') {
    prdLines.push(buildContextPackOutcome(canonicalContextPackRelativePath(state)), '');
  }
  prdLines.push(`Launch via omx team 1:executor "${approvedTask}"`);
  await writeFile(prdPath, prdLines.join('\n'));

  if (state !== 'missing-baseline') {
    await writeFile(testSpecPath, `# ${state} test spec\n`);
  }

  if (state === 'incomplete') {
    await writeContextPack(cwd, state, prdPath, testSpecPath, ['scope']);
  }
  if (state === 'invalid') {
    await writeContextPack(cwd, state, prdPath, testSpecPath, ['scope', 'build', 'verify']);
    await writeFile(testSpecPath, '# invalid drifted test spec\n');
  }
  if (state === 'ready') {
    await writeContextPack(cwd, state, prdPath, testSpecPath, ['scope', 'build', 'verify']);
  }

  await writePersistedApprovedTeamExecutionBinding(teamName, cwd, {
    prd_path: prdPath,
    task: approvedTask,
    command: `omx team 1:executor "${approvedTask}"`,
  });
}

// ── isScalingEnabled ──────────────────────────────────────────────────────────

describe('isScalingEnabled', () => {
  it('returns false when env var is not set', () => {
    assert.equal(isScalingEnabled({}), false);
  });

  it('returns false when env var is empty string', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: '' }), false);
  });

  it('returns false when env var is "0"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: '0' }), false);
  });

  it('returns false when env var is "false"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'false' }), false);
  });

  it('returns false when env var is "no"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'no' }), false);
  });

  it('returns true when env var is "1"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: '1' }), true);
  });

  it('returns true when env var is "true"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'true' }), true);
  });

  it('returns true when env var is "yes"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'yes' }), true);
  });

  it('returns true when env var is "on"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'on' }), true);
  });

  it('returns true when env var is "enabled"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'enabled' }), true);
  });

  it('returns true case-insensitively', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'TRUE' }), true);
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'Yes' }), true);
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'ON' }), true);
  });

  it('returns true with leading/trailing whitespace', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: '  1  ' }), true);
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: ' true ' }), true);
  });
});

// ── scale-down cleanup debt path containment ──────────────────────────────────

describe('scale-down cleanup debt path containment', () => {
  const windowsPathSemantics = {
    relative: win32.relative,
    isAbsolute: win32.isAbsolute,
    sep: win32.sep,
  };

  it('accepts same-root and descendant native Windows canonical paths', () => {
    assert.equal(isSameOrInsidePath('C:\\repo', 'C:\\repo', windowsPathSemantics), true);
    assert.equal(isSameOrInsidePath('C:\\repo\\.omx\\team\\alpha', 'C:\\repo', windowsPathSemantics), true);
  });

  it('accepts mixed-separator, drive-letter, and case-equivalent Windows descendants', () => {
    assert.equal(isSameOrInsidePath('c:/REPO/.omx\\team/alpha', 'C:\\repo', windowsPathSemantics), true);
  });

  it('accepts same-share UNC descendants across host and share casing', () => {
    assert.equal(
      isSameOrInsidePath('\\\\SERVER\\Share\\repo/.omx\\team\\alpha', '\\\\server\\share\\REPO', windowsPathSemantics),
      true,
    );
  });

  for (const [name, candidate] of [
    ['a sibling prefix collision', 'C:\\repo-other\\worker'],
    ['a parent traversal escape', 'C:\\repo\\..\\foreign\\worker'],
    ['a foreign same-volume root', 'C:\\foreign\\worker'],
    ['an absolute relative result from a foreign drive', 'D:\\foreign\\worker'],
    ['a foreign UNC host', '\\\\foreign-server\\share\\repo\\worker'],
    ['a foreign UNC share', '\\\\server\\foreign-share\\repo\\worker'],
    ['a UNC sibling prefix collision', '\\\\server\\share\\repo-other\\worker'],
  ] as const) {
    it(`rejects ${name} under native Windows path semantics`, () => {
      assert.equal(isSameOrInsidePath(candidate, 'C:\\repo', windowsPathSemantics), false);
    });
  }

  for (const [name, candidate] of [
    ['a foreign UNC host', '\\\\foreign-server\\share\\repo\\worker'],
    ['a foreign UNC share', '\\\\server\\foreign-share\\repo\\worker'],
    ['a UNC sibling prefix collision', '\\\\server\\share\\repo-other\\worker'],
  ] as const) {
    it(`rejects ${name} under native Windows UNC path semantics`, () => {
      assert.equal(isSameOrInsidePath(candidate, '\\\\server\\share\\repo', windowsPathSemantics), false);
    });
  }

  const posixPathSemantics = {
    relative: posix.relative,
    isAbsolute: posix.isAbsolute,
    sep: posix.sep,
  };

  it('preserves POSIX same-root and descendant containment', () => {
    assert.equal(isSameOrInsidePath('/repo', '/repo', posixPathSemantics), true);
    assert.equal(isSameOrInsidePath('/repo/.omx/team/alpha', '/repo', posixPathSemantics), true);
  });

  it('rejects POSIX siblings, traversal, and foreign roots', () => {
    assert.equal(isSameOrInsidePath('/repo-other/worker', '/repo', posixPathSemantics), false);
    assert.equal(isSameOrInsidePath('/repo/../foreign/worker', '/repo', posixPathSemantics), false);
    assert.equal(isSameOrInsidePath('/foreign/worker', '/repo', posixPathSemantics), false);
  });
});
// ── WorkerStatus draining state ───────────────────────────────────────────────

describe('WorkerStatus draining state', () => {
  it('writeWorkerStatus writes draining status and readWorkerStatus reads it back', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-drain-'));
    try {
      await initTeamState('drain-test', 'task', 'executor', 2, cwd);
      const drainingStatus = {
        state: 'draining' as const,
        reason: 'scale_down requested',
        updated_at: new Date().toISOString(),
      };
      await writeWorkerStatus('drain-test', 'worker-1', drainingStatus, cwd);
      const status = await readWorkerStatus('drain-test', 'worker-1', cwd);
      assert.equal(status.state, 'draining');
      assert.equal(status.reason, 'scale_down requested');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('readWorkerStatus returns unknown for non-existent worker', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-nw-'));
    try {
      await initTeamState('nw-test', 'task', 'executor', 1, cwd);
      const status = await readWorkerStatus('nw-test', 'worker-99', cwd);
      assert.equal(status.state, 'unknown');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ── Monotonic worker index counter ────────────────────────────────────────────

describe('Monotonic worker index counter', () => {
  it('initTeamState sets next_worker_index to workerCount + 1', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-idx-'));
    try {
      const cfg = await initTeamState('idx-test', 'task', 'executor', 3, cwd);
      assert.equal(cfg.next_worker_index, 4);

      // Verify on disk
      const diskCfg = JSON.parse(
        readFileSync(join(cwd, '.omx', 'state', 'team', 'idx-test', 'config.json'), 'utf8'),
      ) as { next_worker_index?: number };
      assert.equal(diskCfg.next_worker_index, 4);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('next_worker_index is present in manifest.v2.json', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-manif-'));
    try {
      await initTeamState('manif-test', 'task', 'executor', 2, cwd);
      const manifest = JSON.parse(
        readFileSync(join(cwd, '.omx', 'state', 'team', 'manif-test', 'manifest.v2.json'), 'utf8'),
      ) as { next_worker_index?: number };
      assert.equal(manifest.next_worker_index, 3);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('readTeamConfig preserves next_worker_index', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-read-'));
    try {
      await initTeamState('read-test', 'task', 'executor', 5, cwd);
      const config = await readTeamConfig('read-test', cwd);
      assert.ok(config);
      assert.equal(config.next_worker_index, 6);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ── File-based scaling lock ───────────────────────────────────────────────────

describe('withScalingLock', () => {
  it('acquires and releases lock for successful operations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-lock-'));
    try {
      await initTeamState('lock-test', 'task', 'executor', 1, cwd);
      const lockDir = join(cwd, '.omx', 'state', '.team-locks', 'lock-test.scaling');

      const result = await withScalingLock('lock-test', cwd, async () => {
        // Lock should exist during execution
        assert.equal(existsSync(lockDir), true);
        return 42;
      });

      assert.equal(result, 42);
      // Lock should be released after execution
      assert.equal(existsSync(lockDir), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('releases lock even when function throws', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-lock-err-'));
    try {
      await initTeamState('lock-err', 'task', 'executor', 1, cwd);
      const lockDir = join(cwd, '.omx', 'state', '.team-locks', 'lock-err.scaling');

      await assert.rejects(
        withScalingLock('lock-err', cwd, async () => {
          throw new Error('test error');
        }),
        { message: 'test error' },
      );

      // Lock should be released after error
      assert.equal(existsSync(lockDir), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('serializes concurrent operations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-lock-con-'));
    try {
      await initTeamState('lock-con', 'task', 'executor', 1, cwd);
      const order: number[] = [];

      // Launch two operations concurrently - second should wait for first
      const op1 = withScalingLock('lock-con', cwd, async () => {
        order.push(1);
        await new Promise(r => setTimeout(r, 100));
        order.push(2);
        return 'first';
      });

      // Small delay to ensure op1 acquires lock first
      await new Promise(r => setTimeout(r, 10));

      const op2 = withScalingLock('lock-con', cwd, async () => {
        order.push(3);
        return 'second';
      });

      const [r1, r2] = await Promise.all([op1, op2]);
      assert.equal(r1, 'first');
      assert.equal(r2, 'second');
      // First operation should complete (1, 2) before second starts (3)
      assert.deepEqual(order, [1, 2, 3]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ── scaleUp / scaleDown error cases ──────────────────────────────────────────

describe('scaleUp', () => {
  it('rejects when scaling is disabled', async () => {
    await assert.rejects(
      scaleUp('test', 1, 'executor', [], '/tmp', {}),
      /Dynamic scaling is disabled/,
    );
  });

  it('returns error for invalid count', async () => {
    const result = await scaleUp(
      'test', 0, 'executor', [], '/tmp',
      { OMX_TEAM_SCALING_ENABLED: '1' },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /count must be a positive integer/);
    }
  });

  it('returns error for negative count', async () => {
    const result = await scaleUp(
      'test', -1, 'executor', [], '/tmp',
      { OMX_TEAM_SCALING_ENABLED: '1' },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /count must be a positive integer/);
    }
  });

  it('returns error when tmux is not available', async () => {
    // Temporarily remove PATH so tmux binary is not found
    const prevPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const result = await scaleUp(
        'test', 1, 'executor', [], '/tmp',
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /tmux is not available/);
      }
    } finally {
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
    }
  });

  it('rejects explicit mixed worker policy before scale-up creates worker state or a pane', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-explicit-policy-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-explicit-policy-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(tmuxStubPath, `#!/bin/sh
printf '%s\n' "$*" >> "${tmuxLogPath}"
exit 0
`);
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState('scale-up-explicit-policy', 'task', 'executor', 1, cwd);

      const result = await scaleUp(
        'scale-up-explicit-policy',
        1,
        'executor',
        [{ subject: 'new task', description: 'new task', owner: 'worker-2' }],
        cwd,
        {
          OMX_TEAM_SCALING_ENABLED: '1',
          OMX_TEAM_WORKER_LAUNCH_ARGS: '--dangerously-bypass-approvals-and-sandbox --sandbox workspace-write',
        },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /Invalid OMX_TEAM_WORKER_LAUNCH_ARGS: bypass cannot be combined with direct approval or sandbox policy/);
      }
      const config = await readTeamConfig('scale-up-explicit-policy', cwd);
      assert.equal(config?.workers.length, 1);
      assert.equal(config?.next_worker_index, 2);
      assert.deepEqual(await readScaleUpTaskPayloads('scale-up-explicit-policy', cwd), []);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', 'scale-up-explicit-policy', 'workers', 'worker-2')), false);
      assert.equal(existsSync(workerStartupScriptPath(cwd, 'scale-up-explicit-policy', 'worker-2')), false);
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.equal(tmuxCommands.some((command) => command.startsWith('split-window ')), false);
      assert.equal(tmuxCommands.some((command) => command.startsWith('send-keys ')), false);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('rejects Claude and Gemini restrictive config policy before scale-up creates task payloads, worker state, a pane, or process', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-restrictive-noncodex-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-restrictive-noncodex-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(tmuxStubPath, `#!/bin/sh
printf '%s\n' "$*" >> "${tmuxLogPath}"
exit 0
`);
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      for (const workerCli of ['claude', 'gemini'] as const) {
        const teamName = `scale-up-restrictive-${workerCli}`;
        await writeFile(tmuxLogPath, '');
        await initTeamState(teamName, 'task', 'executor', 1, cwd);
        const result = await scaleUp(
          teamName,
          1,
          'executor',
          [{ subject: 'new task', description: 'new task', owner: 'worker-2' }],
          cwd,
          {
            OMX_TEAM_SCALING_ENABLED: '1',
            OMX_TEAM_WORKER_CLI: workerCli,
            OMX_TEAM_WORKER_LAUNCH_ARGS: `--config 'sandbox_mode="workspace-write"'`,
          },
        );
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.match(result.error, new RegExp(`Selected team worker CLI "${workerCli}" is incompatible with an explicit approval or sandbox policy\\.`));
        }
        const config = await readTeamConfig(teamName, cwd);
        assert.equal(config?.workers.length, 1);
        assert.equal(config?.next_worker_index, 2);
        assert.deepEqual(await readScaleUpTaskPayloads(teamName, cwd), []);
        assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2')), false);
        assert.equal(existsSync(workerStartupScriptPath(cwd, teamName, 'worker-2')), false);
        const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
        assert.equal(tmuxCommands.some((command) => command.startsWith('split-window ')), false);
        assert.equal(tmuxCommands.some((command) => command.startsWith('send-keys ')), false);
      }
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });


  it('persists scaled-up task roles in canonical task state and inbox ids', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-role-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-role-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '\%s\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  show-option) echo "team:scale-up-role" ;;',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%31"',
          '    ;;',
          '  list-panes)',
          '    case "$*" in',
          '      *"#{pane_id}\t#{pane_dead}\t#{pane_pid}"*)',
          "        printf '%s\\t%s\\t%s\\n' '%11' '0' '42411'",
          "        printf '%s\\t%s\\t%s\\n' '%21' '0' '42421'",
          `        if [ ! -f "${join(fakeBinDir, 'scale-up-role-killed-%31')}" ]; then printf '%s\\t%s\\t%s\\n' '%31' '0' '42424'; fi`,
          '        ;;',
          '      *)',
          '        echo "42424"',
          '        ;;',
          '    esac',
          '    ;;',
          '  send-keys)',
          '    ;;',
          '  kill-pane)',
          `    : > "${join(fakeBinDir, 'scale-up-role-killed-')}$3"`,
          '    ;;',
          '  capture-pane)',
          '    echo ""',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'writer.md'), '<identity>You are Writer.</identity>');
      await mkdir(join(cwd, '.omx', 'state', 'team', 'scale-up-role'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'team', 'scale-up-role', 'worker-agents.md'), '# Base worker instructions\n');

      await initTeamState('scale-up-role', 'task', 'executor', 1, cwd);
      await createTask('scale-up-role', {
        subject: 'existing task',
        description: 'already persisted',
        status: 'pending',
        owner: 'worker-1',
      }, cwd);

      const config = await readTeamConfig('scale-up-role', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-scale-up-role';
      config.leader_pane_id = '%11';

      config.tmux_pane_owner_id = 'team:scale-up-role';
      config.workers[0]!.pane_id = '%21';
      config.workers[0]!.pid = 42421;
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'scale-up-role', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'scale-up-role',
        1,
        'executor',
        [{ subject: 'document routing report only', description: 'document routing report only', owner: 'worker-2', role: 'writer' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },


      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const createdTask = await readTask('scale-up-role', '2', cwd);
      assert.equal(createdTask?.role, 'writer');
      assert.equal(createdTask?.owner, 'worker-2');

      const workerIdentity = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'team', 'scale-up-role', 'workers', 'worker-2', 'identity.json'), 'utf-8')) as { role?: string };
      assert.equal(workerIdentity.role, 'writer');

      const inbox = await readFile(join(cwd, '.omx', 'state', 'team', 'scale-up-role', 'workers', 'worker-2', 'inbox.md'), 'utf-8');
      assert.match(inbox, /Task 2/);
      assert.match(inbox, /Role: writer/);

      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.ok(tmuxCommands.some((command) => (
        command === 'set-option -p -t %31 @omx_team_pane_owner_id team:scale-up-role'
      )));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('covers the scale-up config-policy and no-policy argv matrix', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-policy-matrix-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-policy-matrix-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const capturePath = join(cwd, 'worker-argv.txt');
    const emptyCodexHome = await mkdtemp(join(tmpdir(), 'omx-scale-up-policy-matrix-codex-home-'));
    const previousPath = process.env.PATH;
    const previousArgv = process.argv;
    const previousBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
      await writeFile(
        join(fakeBinDir, 'codex'),
        `#!/bin/sh
printf '%s\\n' "$@" > '${capturePath}'
`,
      );
      await chmod(join(fakeBinDir, 'codex'), 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';

      const runScaleUpCase = async (params: {
        teamName: string;
        role?: string;
        launchArgs: string;
        inheritedModel?: string;
      }): Promise<string[]> => {
        await writeFile(capturePath, '');
        await initTeamState(params.teamName, 'task', 'executor', 1, cwd);
        await configureScaleUpTeamForDirectDispatch(params.teamName, cwd);
        const result = await scaleUp(
          params.teamName,
          1,
          'executor',
          [{
            subject: 'implement task',
            description: 'implement task',
            owner: 'worker-2',
            ...(params.role === undefined ? {} : { role: params.role }),
          }],
          cwd,
          {
            OMX_TEAM_SCALING_ENABLED: '1',
            OMX_TEAM_SKIP_READY_WAIT: '1',
            CODEX_HOME: emptyCodexHome,
            OMX_TEAM_WORKER_LAUNCH_ARGS: params.launchArgs,
            ...(params.inheritedModel ? { [TEAM_WORKER_INHERITED_MODEL_ENV]: params.inheritedModel } : {}),
          },
        );
        if (!result.ok) assert.fail(result.error);

        const startupScriptPath = workerStartupScriptPath(cwd, params.teamName, 'worker-2');
        const scriptResult = execFileSync('/bin/sh', [startupScriptPath], { encoding: 'utf-8' });
        assert.equal(scriptResult, '');
        return (await readFile(capturePath, 'utf-8')).trim().split('\n');
      };

      process.argv = [
        ...previousArgv.filter((arg) => arg !== '--dangerously-bypass-approvals-and-sandbox' && arg !== '--madmax'),
        '--madmax',
      ];
      const sandboxArgs = await runScaleUpCase({
        teamName: 'scale-up-sandbox-policy',
        role: 'executor',
        launchArgs: String.raw`--config 'sandbox_mode="workspace-write"' -- 'C:\scale-up\nested\' '--sandbox=read-only' '--madmax'`,
        inheritedModel: 'leader-model',
      });
      const expectedSandboxArgs = [
        '--sandbox', 'workspace-write',
        '-c', 'model_reasoning_effort="medium"',
        '--model', 'leader-model',
        '--', 'C:\\scale-up\\nested\\', '--sandbox=read-only', '--madmax',
      ];
      assert.deepEqual(sandboxArgs, expectedSandboxArgs);
      assert.deepEqual(
        buildWorkerProcessLaunchSpec(
          'initial-policy-team',
          1,
          expectedSandboxArgs,
          cwd,
          { CODEX_HOME: emptyCodexHome },
          'codex',
          undefined,
          'executor',
        ).args,
        sandboxArgs,
      );

      const approvalArgs = await runScaleUpCase({
        teamName: 'scale-up-approval-policy',
        role: 'executor',
        launchArgs: '--ask-for-approval=on-request',
        inheritedModel: 'leader-model',
      });
      assert.deepEqual(approvalArgs, [
        '--ask-for-approval', 'on-request',
        '-c', 'model_reasoning_effort="medium"',
        '--model', 'leader-model',
      ]);

      process.argv = previousArgv.filter((arg) => arg !== '--dangerously-bypass-approvals-and-sandbox' && arg !== '--madmax');
      const bypass = '--dangerously-bypass-approvals-and-sandbox';
      assert.deepEqual(
        await runScaleUpCase({ teamName: 'scale-up-execution-default', role: 'executor', launchArgs: '--model policy-model' }),
        ['-c', 'model_reasoning_effort="medium"', '--model', 'policy-model', bypass],
      );
      assert.deepEqual(
        await runScaleUpCase({ teamName: 'scale-up-nonexecution-default', role: 'explore', launchArgs: '--model policy-model' }),
        ['-c', 'model_reasoning_effort="low"', '--model', 'policy-model'],
      );
      assert.deepEqual(
        await runScaleUpCase({ teamName: 'scale-up-absent-role-default', launchArgs: '--model policy-model' }),
        ['-c', 'model_reasoning_effort="medium"', '--model', 'policy-model', bypass],
      );
      assert.deepEqual(
        await runScaleUpCase({ teamName: 'scale-up-unknown-role-default', role: 'unknown-role', launchArgs: '--model policy-model' }),
        ['-c', 'model_reasoning_effort="medium"', '--model', 'policy-model', bypass],
      );
    } finally {
      process.argv = previousArgv;
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = previousBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      await rm(emptyCodexHome, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('persists a newly created worker when rollback pane proof is unavailable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-owner-tag-rollback-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-owner-tag-rollback-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  show-option) echo "team:scale-up-owner-tag-rollback" ;;',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%31"',
          '    ;;',
          '  set-option)',
          '    case "$*" in',
          '      *"@omx_team_pane_owner_id"*)',
          '        echo "owner tag failed" >&2',
          '        exit 1',
          '        ;;',
          '    esac',
          '    ;;',
          '  list-panes)',
          `    count_file="${join(fakeBinDir, 'proof-count')}"`,
          '    count=0',
          '    if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi',
          '    count=$((count + 1))',
          '    printf "%s" "$count" > "$count_file"',
          '    if [ "$count" -le 5 ]; then',
          "      printf '%s\\t%s\\t%s\\n' '%11' '0' '42411'",
          "      printf '%s\\t%s\\t%s\\n' '%21' '0' '42421'",
          "      printf '%s\\t%s\\t%s\\n' '%31' '0' '42424'",
          '    else',
          "      printf 'malformed pane snapshot\\n'",
          '    fi',
          '    ;;',
          '  kill-pane|send-keys|capture-pane)',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      process.env.OMX_RUNTIME_BRIDGE = '0';

      await initTeamState('scale-up-owner-tag-rollback', 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch('scale-up-owner-tag-rollback', cwd);
      const ownerConfig = await readTeamConfig('scale-up-owner-tag-rollback', cwd);
      assert.ok(ownerConfig);
      if (!ownerConfig) return;
      ownerConfig.tmux_pane_owner_id = 'team:scale-up-owner-tag-rollback';
      await saveTeamConfig(ownerConfig, cwd);

      const result = await scaleUp(
        'scale-up-owner-tag-rollback',
        1,
        'executor',
        [{ subject: 'new work', description: 'new work', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /scale_up_rollback_cleanup_debt:pane_owner_unverified:%31/);

      const config = await readTeamConfig('scale-up-owner-tag-rollback', cwd);
      assert.deepEqual(config?.workers.map((worker) => worker.name), ['worker-1', 'worker-2']);
      assert.equal(config?.workers[1]?.pane_id, '%31');
      assert.equal(config?.next_worker_index, 3);
      assert.equal((await readTask('scale-up-owner-tag-rollback', '1', cwd))?.owner, 'worker-2');
      assert.equal(existsSync(
        join(cwd, '.omx', 'state', 'team', 'scale-up-owner-tag-rollback', 'workers', 'worker-2', 'identity.json'),
      ), false);
      assert.equal(existsSync(
        join(cwd, '.omx', 'state', 'team', 'scale-up-owner-tag-rollback', 'workers', 'worker-2', 'inbox.md'),
      ), false);
      const dispatch = JSON.parse(await readFile(
        join(cwd, '.omx', 'state', 'team', 'scale-up-owner-tag-rollback', 'dispatch', 'requests.json'),
        'utf8',
      )) as Array<{ to_worker?: string }>;
      assert.equal(dispatch.some((request) => request.to_worker === 'worker-2'), false);
      assert.equal((await listDispatchRequests('scale-up-owner-tag-rollback', cwd, { to_worker: 'worker-2' })).length, 0);

      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.ok(tmuxCommands.some((command) => (
        command === 'set-option -p -t %31 @omx_team_pane_owner_id team:scale-up-owner-tag-rollback'
      )));
      assert.equal(tmuxCommands.some((command) => command === 'kill-pane -t %31'), false);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousBridge === 'string') process.env.OMX_RUNTIME_BRIDGE = previousBridge;
      else delete process.env.OMX_RUNTIME_BRIDGE;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('retains unpinned rollback debt without killing a pane when its first post-split proof is unavailable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-unpinned-rollback-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-unpinned-rollback-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const splitPath = join(fakeBinDir, 'split-created');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(tmuxStubPath, [
        '#!/bin/sh',
        'set -eu',
        `printf '%s\\n' "$*" >> "${tmuxLogPath}"`,
        'case "${1:-}" in',
        '  -V) echo "tmux 3.2a" ;;',
        '  show-option) echo "team:scale-up" ;;',
        '  split-window) : > "' + splitPath + '"; echo "%31" ;;',
        '  list-panes)',
        '    if [ -f "' + splitPath + '" ]; then printf "malformed pane snapshot\\n"; else',
        "      printf '%s\\t%s\\t%s\\n' '%11' '0' '42411'",
        "      printf '%s\\t%s\\t%s\\n' '%21' '0' '42421'",
        '    fi',
        '    ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'));
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      const teamName = 'scale-up-unpinned-rollback';
      await initTeamState(teamName, 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);
      const result = await scaleUp(teamName, 1, 'executor', [], cwd, {
        OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1',
      });

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /scale_up_rollback_cleanup_debt:pane_pid_unpinned:%31/);
      const config = await readTeamConfig(teamName, cwd);
      assert.equal(config?.workers[1]?.pane_id, '%31');
      assert.equal(config?.workers[1]?.pid, undefined);
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.equal(tmuxCommands.some((command) => command === 'kill-pane -t %31'), false);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('retains the original pane/PID rollback debt when the new pane ID is reused before owner tagging', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-owner-tag-reuse-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-owner-tag-reuse-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(tmuxStubPath, [
        '#!/bin/sh',
        'set -eu',
        `printf '%s\\n' "$*" >> "${tmuxLogPath}"`,
        'case "${1:-}" in',
          '  show-option) echo "team:scale-up" ;;',
        '  -V) echo "tmux 3.2a" ;;',
        '  split-window) echo "%31" ;;',
        '  list-panes)',
        `    count_file="${join(fakeBinDir, 'proof-count')}"`,
        '    count=0; [ ! -f "$count_file" ] || count=$(cat "$count_file")',
        '    count=$((count + 1)); printf "%s" "$count" > "$count_file"',
        '    if [ "$count" -le 4 ]; then',
        "      printf '%s\\t%s\\t%s\\n' '%21' '0' '42421'",
        "      printf '%s\\t%s\\t%s\\n' '%31' '0' '42424'",
        '    elif [ "$count" -eq 5 ]; then',
        "      printf '%s\\t%s\\t%s\\n' '%21' '0' '42421'",
        "      printf '%s\\t%s\\t%s\\n' '%31' '0' '52424'",
        '    else',
        "      printf 'malformed pane snapshot\\n'",
        '    fi',
        '    ;;',
        '  kill-pane|send-keys|capture-pane) ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'));
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      const teamName = 'scale-up-owner-tag-reuse';
      await initTeamState(teamName, 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);
      const result = await scaleUp(teamName, 1, 'executor', [], cwd, {
        OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1',
      });

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /scale_up_rollback_cleanup_debt:pane_owner_unverified:%31/);
      const config = await readTeamConfig(teamName, cwd);
      assert.equal(config?.workers[1]?.pane_id, '%31');
      assert.equal(config?.workers[1]?.pid, 42424);
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.equal(tmuxCommands.some((command) => command.includes('set-option -p -t %31 @omx_team_pane_owner_id')), false);
      assert.equal(tmuxCommands.some((command) => command.startsWith('split-window ')), true);
      assert.equal(tmuxCommands.some((command) => command === 'kill-pane -t %31'), false);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('injects persisted leader-owned Ultragoal context into scaled worker inboxes', async () => {
    const teamName = 'scale-up-ultragoal-context';
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-ultragoal-context-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-ultragoal-context-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;

    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState(teamName, 'ultragoal scale-up test', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);
      const teamStateRoot = resolveCanonicalTeamStateRoot(cwd);
      await mkdir(join(teamStateRoot, 'team', teamName), { recursive: true });
      await writeFile(
        join(teamStateRoot, 'team', teamName, 'ultragoal-context.json'),
        `${JSON.stringify({
          kind: 'leader_owned_ultragoal_context',
          goalsPath: '.omx/ultragoal/goals.json',
          ledgerPath: '.omx/ultragoal/ledger.jsonl',
          activeGoalId: 'G001-team-runtime-bridge',
          activeGoalTitle: 'Team runtime bridge',
          codexGoalMode: 'aggregate',
          checkpointPolicy: 'fresh_leader_get_goal_required',
        })}\n`,
      );

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [{ subject: 'Implement ultragoal follow-up', description: 'Implement ultragoal follow-up', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const inboxStateRoot = result.addedWorkers[0]?.team_state_root ?? resolveCanonicalTeamStateRoot(cwd);
      const inbox = await readFile(
        join(inboxStateRoot, 'team', teamName, 'workers', 'worker-2', 'inbox.md'),
        'utf-8',
      );
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.match(inbox, /Implement ultragoal follow-up/);
      assert.match(inbox, /### Leader-owned Ultragoal context/);
      assert.match(inbox, /G001-team-runtime-bridge/);
      assert.match(inbox, /workers do not own Ultragoal goal state/i);
      assert.match(inbox, /omx ultragoal checkpoint --goal-id G001-team-runtime-bridge/);
      assert.ok(tmuxCommands.some((command) => command.startsWith('split-window ')));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('keeps scale-up on the generic path when no approved binding is persisted', async () => {
    const teamName = 'scale-up-no-approved-binding';
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-no-approved-binding-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-no-approved-binding-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;

    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState(teamName, 'generic scale-up test', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);

      assert.equal(await readExpectedScaleUpApprovedBindingError(teamName, cwd), null);

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [{ subject: 'Implement generic follow-up', description: 'Implement generic follow-up', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const inbox = await readFile(
        join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2', 'inbox.md'),
        'utf-8',
      );
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.match(inbox, /Implement generic follow-up/);
      assert.doesNotMatch(inbox, /## Approved Handoff Context/);
      assert.ok(tmuxCommands.some((command) => command.startsWith('split-window ')));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('injects approved handoff context on scale-up when the persisted binding is baseline-ready without context-pack metadata', async () => {
    const teamName = 'scale-up-plan-only';
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-plan-only-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-plan-only-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;

    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState(teamName, 'plan-only scale-up test', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);
      await prepareScaleUpApprovedBindingState(teamName, cwd, 'plan-only');

      assert.equal(await readExpectedScaleUpApprovedBindingError(teamName, cwd), null);

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [{ subject: 'Implement plan-only follow-up', description: 'Implement plan-only follow-up', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const inbox = await readFile(
        join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2', 'inbox.md'),
        'utf-8',
      );
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.match(inbox, /Implement plan-only follow-up/);
      assert.match(inbox, /## Approved Handoff Context/);
      assert.match(inbox, /Use the approved plan and matching test specs as the execution baseline/);
      assert.doesNotMatch(inbox, /Approved context pack|Context pack index/);
      assert.ok(tmuxCommands.some((command) => command.startsWith('split-window ')));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('injects approved handoff context into scaled worker inboxes when the persisted binding stays ready', async () => {
    const teamName = 'scale-up-approved-context';
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-approved-context-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-approved-context-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;
    const approvedTask = 'Execute approved issue 1410 plan';

    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState(teamName, 'approved scale-up test', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);

      const plansDir = join(cwd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      const prdPath = join(plansDir, 'prd-issue-1410.md');
      const testSpecPath = join(plansDir, 'test-spec-issue-1410.md');
      await writeFile(
        prdPath,
        [
          '# Approved plan',
          '',
          buildContextPackOutcome(canonicalContextPackRelativePath('issue-1410')),
          '',
          `Launch via omx team 1:executor "${approvedTask}"`,
        ].join('\n'),
      );
      await writeFile(testSpecPath, '# Test spec\n');
      await writeReadyContextPack(cwd, 'issue-1410', prdPath, testSpecPath);
      await writeFile(
        join(plansDir, 'repo-context-issue-1410.md'),
        'Read the approved repository slice first.\n',
      );
      await writePersistedApprovedTeamExecutionBinding(teamName, cwd, {
        prd_path: prdPath,
        task: approvedTask,
        command: `omx team 1:executor "${approvedTask}"`,
      });

      assert.equal(await readExpectedScaleUpApprovedBindingError(teamName, cwd), null);

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [{ subject: 'Implement approved follow-up', description: 'Implement approved follow-up', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const inbox = await readFile(
        join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2', 'inbox.md'),
        'utf-8',
      );
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.match(inbox, /## Approved Handoff Context/);
      assert.ok(inbox.includes(`Approved plan: ${prdPath}`));
      assert.ok(inbox.includes(`Test specs: ${testSpecPath}`));
      assert.match(inbox, /Approved repository context summary source: .*repo-context-issue-1410\.md/);
      assert.match(inbox, /Read the approved repository slice first\./);
      assert.match(inbox, /Use the approved plan and matching test specs as the execution baseline/);
      assert.doesNotMatch(inbox, /Approved context pack|Build refs|Verify refs|Scope refs|query the canonical pack|Context pack index/);
      assert.ok(tmuxCommands.some((command) => command.startsWith('split-window ')));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('proves the approved-binding scale-up model across generated state/count scenarios, including forbidden counterfactuals', async () => {
    for (const state of SCALE_UP_APPROVED_BINDING_STATES) {
      for (const count of SCALE_UP_COUNTS) {
        const teamName = `su-model-${SCALE_UP_STATE_TEAM_SUFFIX[state]}-${count}`;
        const cwd = await mkdtemp(join(tmpdir(), `omx-scale-up-model-${state}-${count}-`));
        const fakeBinDir = await mkdtemp(join(tmpdir(), `omx-scale-up-model-${state}-${count}-bin-`));
        const tmuxLogPath = join(fakeBinDir, 'tmux.log');
        const previousPath = process.env.PATH;

        try {
          await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
          process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

          await initTeamState(teamName, `approved ${state} scale-up model`, 'executor', 1, cwd);
          await configureScaleUpTeamForDirectDispatch(teamName, cwd);

          if (state !== 'missing') {
            await prepareScaleUpApprovedBindingState(teamName, cwd, state);
          }

          const expectedOutcome = expectedScaleUpOutcome(state);
          const expectedError = await readExpectedScaleUpApprovedBindingError(teamName, cwd);
          const tasks = buildScaleUpScenarioTasks(state, count);

          const result = await scaleUp(
            teamName,
            count,
            'executor',
            tasks,
            cwd,
            { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
          );
          const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
          const splitWindowCommands = tmuxCommands.filter((command) => command.startsWith('split-window '));
          const inboxes = await Promise.all(tasks.map(async (task) => {
            const inboxPath = join(
              cwd,
              '.omx',
              'state',
              'team',
              teamName,
              'workers',
              task.owner,
              'inbox.md',
            );
            return existsSync(inboxPath)
              ? await readFile(inboxPath, 'utf-8')
              : null;
          }));
          const approvedInboxCount = inboxes.filter((inbox) =>
            typeof inbox === 'string' && inbox.includes('## Approved Handoff Context')
          ).length;
          assert.ok(
            approvedInboxCount === 0 || approvedInboxCount === tasks.length,
            `expected approved handoff context presence to stay consistent across all scaled workers (state=${state} count=${count})`,
          );
          const observedOutcome: ScaleUpObservedOutcome = !result.ok
            ? 'blocked'
            : approvedInboxCount === tasks.length
              ? 'approved'
              : 'generic';
          const taskPayloads = await readScaleUpTaskPayloads(teamName, cwd);

          assert.equal(observedOutcome, expectedOutcome, `state=${state} count=${count}`);
          assert.equal(
            forbiddenScaleUpOutcomes(state).includes(observedOutcome),
            false,
            `state=${state} count=${count} produced forbidden counterfactual outcome ${observedOutcome}`,
          );
          if (expectedOutcome === 'blocked') {
            assert.equal(result.ok, false);
            if (result.ok) {
              throw new Error(`expected blocked scale-up outcome for ${state} count=${count}`);
            }
            assert.equal(result.error, expectedError);
            assert.deepEqual(tmuxCommands, ['-V']);
            assert.deepEqual(splitWindowCommands, []);
            assert.ok(inboxes.every((inbox) => inbox === null));
            assert.equal(
              taskPayloads.some((payload) => tasks.some((task) => payload.includes(task.subject))),
              false,
            );

            const config = await readTeamConfig(teamName, cwd);
            assert.ok(config);
            if (!config) {
              throw new Error(`missing team config for ${teamName}`);
            }
            assert.equal(config.workers.length, 1);
            assert.equal(config.worker_count, 1);
            assert.equal(config.next_worker_index, 2);
            continue;
          }

          assert.equal(result.ok, true);
          if (!result.ok) {
            throw new Error(`expected successful scale-up outcome for ${state} count=${count}`);
          }
          assert.equal(result.newWorkerCount, 1 + count);
          assert.equal(result.nextWorkerIndex, 2 + count);
          assert.equal(splitWindowCommands.length, count);
          assert.equal(expectedError, null);
          assert.ok(inboxes.every((inbox): inbox is string => typeof inbox === 'string'));

          for (const [index, inbox] of inboxes.entries()) {
            const task = tasks[index]!;
            assert.ok(inbox.includes(task.subject), `expected inbox to include task subject ${task.subject}`);
          }
          assert.equal(
            taskPayloads.filter((payload) => tasks.some((task) => payload.includes(task.subject))).length,
            count,
          );
          if (expectedOutcome === 'approved') {
            assert.ok(inboxes.every((inbox) => inbox.includes('## Approved Handoff Context')));
          } else {
            assert.ok(inboxes.every((inbox) => !inbox.includes('## Approved Handoff Context')));
          }
        } finally {
          if (typeof previousPath === 'string') process.env.PATH = previousPath;
          else delete process.env.PATH;
          await rm(cwd, { recursive: true, force: true });
          await rm(fakeBinDir, { recursive: true, force: true });
        }
      }
    }
  });

  for (const state of BLOCKED_SCALE_UP_APPROVED_BINDING_STATES) {
    it(`fails closed before worker launch when the persisted approved binding is ${state}`, async () => {
      const teamName = `su-block-${SCALE_UP_STATE_TEAM_SUFFIX[state]}`;
      const cwd = await mkdtemp(join(tmpdir(), `omx-scale-up-approved-${state}-`));
      const fakeBinDir = await mkdtemp(join(tmpdir(), `omx-scale-up-approved-${state}-bin-`));
      const tmuxLogPath = join(fakeBinDir, 'tmux.log');
      const previousPath = process.env.PATH;

      try {
        await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
        process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

        await initTeamState(teamName, `approved ${state} scale-up test`, 'executor', 1, cwd);
        await configureScaleUpTeamForDirectDispatch(teamName, cwd);
        await prepareScaleUpApprovedBindingState(teamName, cwd, state);

        const expectedError = await readExpectedScaleUpApprovedBindingError(teamName, cwd);
        assert.ok(expectedError);

        const result = await scaleUp(
          teamName,
          1,
          'executor',
          [{ subject: 'Implement approved follow-up', description: 'Implement approved follow-up', owner: 'worker-2' }],
          cwd,
          { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
        );
        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.error, expectedError);

        const config = await readTeamConfig(teamName, cwd);
        assert.ok(config);
        if (!config) return;
        assert.equal(config.workers.length, 1);
        assert.equal(config.worker_count, 1);
        assert.equal(config.next_worker_index, 2);

        const taskPayloads = await readScaleUpTaskPayloads(teamName, cwd);
        assert.equal(
          taskPayloads.some((payload) => payload.includes('Implement approved follow-up')),
          false,
        );
        assert.equal(
          existsSync(join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2', 'identity.json')),
          false,
        );
        assert.equal(
          existsSync(join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2', 'inbox.md')),
          false,
        );
        assert.deepEqual(await readScaleUpTmuxLogCommands(tmuxLogPath), ['-V']);
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        await rm(cwd, { recursive: true, force: true });
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    });
  }


  it('uses project-scoped CODEX_HOME for scaled worker reasoning and model defaults', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-project-reasoning-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-project-reasoning-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    const previousStandardModel = process.env.OMX_DEFAULT_STANDARD_MODEL;
    const previousFrontierModel = process.env.OMX_DEFAULT_FRONTIER_MODEL;
    const previousCodeHome = process.env.CODEX_HOME;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  show-option) echo "team:scale-up" ;;',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%31"',
          '    ;;',
          '  list-panes)',
          '    case "$*" in',
          '      *"#{pane_id}\t#{pane_dead}\t#{pane_pid}"*)',
          "        printf '%s\\t%s\\t%s\\n' '%11' '0' '42411'",
          "        printf '%s\\t%s\\t%s\\n' '%21' '0' '42421'",
          "        printf '%s\\t%s\\t%s\\n' '%31' '0' '42424'",
          '        ;;',
          '      *)',
          '        echo "42424"',
          '        ;;',
          '    esac',
          '    ;;',
          '  send-keys)',
          '    ;;',
          '  capture-pane)',
          '    echo ""',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      delete process.env.CODEX_HOME;
      delete process.env.OMX_DEFAULT_STANDARD_MODEL;
      delete process.env.OMX_DEFAULT_FRONTIER_MODEL;

      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await mkdir(join(cwd, '.codex'), { recursive: true });
      await writeFile(join(cwd, '.codex', '.omx-config.json'), JSON.stringify({
        env: {
          OMX_DEFAULT_STANDARD_MODEL: 'project-standard-model',
        },
        agentReasoning: {
          writer: 'xhigh',
        },
      }));
      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'writer.md'), '<identity>You are Writer.</identity>');
      await mkdir(join(cwd, '.omx', 'state', 'team', 'scale-up-project-reasoning'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'team', 'scale-up-project-reasoning', 'worker-agents.md'), '# Base worker instructions\n');

      await initTeamState('scale-up-project-reasoning', 'task', 'executor', 1, cwd);
      await createTask('scale-up-project-reasoning', {
        subject: 'existing task',
        description: 'already persisted',
        status: 'pending',
        owner: 'worker-1',
      }, cwd);

      const config = await readTeamConfig('scale-up-project-reasoning', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-scale-up-project-reasoning';
      config.leader_pane_id = '%11';

      config.tmux_pane_owner_id = 'team:scale-up';
      config.workers[0]!.pane_id = '%21';
      config.workers[0]!.pid = 42421;
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'scale-up-project-reasoning', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'scale-up-project-reasoning',
        1,
        'executor',
        [{ subject: 'document routing report only', description: 'document routing report only', owner: 'worker-2', role: 'writer' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      const startupScript = await readFile(
        workerStartupScriptPath(cwd, 'scale-up-project-reasoning', 'worker-2'),
        'utf-8',
      );
      assert.match(tmuxLog, /worker-2-startup\.sh/);
      assert.match(startupScript, /CODEX_HOME=.*\.codex/);
      assert.match(startupScript, /model_reasoning_effort="xhigh"/);
      assert.match(startupScript, /--model/);
      assert.match(startupScript, /project-standard-model/);

      const workerAgents = await readFile(join(cwd, '.omx', 'state', 'team', 'scale-up-project-reasoning', 'workers', 'worker-2', 'AGENTS.md'), 'utf-8');
      assert.match(workerAgents, /You are operating as the \*\*writer\*\* role/);
      assert.match(workerAgents, /resolved_model: project-standard-model/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousStandardModel === 'string') process.env.OMX_DEFAULT_STANDARD_MODEL = previousStandardModel;
      else delete process.env.OMX_DEFAULT_STANDARD_MODEL;
      if (typeof previousFrontierModel === 'string') process.env.OMX_DEFAULT_FRONTIER_MODEL = previousFrontierModel;
      else delete process.env.OMX_DEFAULT_FRONTIER_MODEL;
      if (typeof previousCodeHome === 'string') process.env.CODEX_HOME = previousCodeHome;
      else delete process.env.CODEX_HOME;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });


  it('removes generated worktree-root AGENTS when scale-up rolls back', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-rollback-worktree-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-rollback-worktree-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
	case "\${1:-}" in
  show-option) echo 'team:scale-up' ;;
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
    ;;
  list-panes)
    case "$*" in
      *"#{pane_id}\t#{pane_dead}\t#{pane_pid}"*)
        printf '%s\t%s\t%s\n' '%11' '0' '42411'
        printf '%s\t%s\t%s\n' '%21' '0' '42421'
        if [ ! -f "${fakeBinDir}/killed-%31" ]; then printf '%s\t%s\t%s\n' '%31' '0' '42424'; fi
        ;;
      *)
        echo "42424"
        ;;
    esac
    ;;
  send-keys)
    exit 1
    ;;
  kill-pane)
    : > "${fakeBinDir}/killed-$3"
    ;;
  capture-pane)
    echo ""
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'writer.md'), '<identity>You are Writer.</identity>');
      await writeFile(join(cwd, 'AGENTS.md'), '# Root project instructions\n');
      await initCommittedGitRepo(cwd);
      await initTeamState('rollback-worktree', 'task', 'executor', 1, cwd, undefined, process.env, {
        workspace_mode: 'worktree',
        leader_cwd: cwd,
        team_state_root: join(cwd, '.omx', 'state'),
      });

      const config = await readTeamConfig('rollback-worktree', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-rollback-worktree';
      config.leader_pane_id = '%11';

      config.tmux_pane_owner_id = 'team:scale-up';
      config.workers[0]!.pane_id = '%21';
      config.workers[0]!.pid = 42421;
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'rollback-worktree', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'rollback-worktree',
        1,
        'executor',
        [{ subject: 'write docs', description: 'write docs', owner: 'worker-2', role: 'writer' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /scale_up_dispatch_failed:worker-2/);

      const workerRootAgents = join(cwd, '.omx', 'team', 'rollback-worktree', 'worktrees', 'worker-2', 'AGENTS.md');
      await assert.rejects(readFile(workerRootAgents, 'utf-8'), { code: 'ENOENT' });
      const backupPath = join(cwd, '.git', 'worktrees', 'worker-2', 'omx', 'root-agents-backup.json');
      assert.equal(existsSync(backupPath), false);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('uses canonical root AGENTS bootstrap for scaled worktree workers', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-canonical-root-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-canonical-root-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
	case "\${1:-}" in
  show-option) echo 'team:scale-up' ;;
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
    ;;
  list-panes)
    case "$*" in
      *"#{pane_id}\t#{pane_dead}\t#{pane_pid}"*)
        printf '%s\t%s\t%s\n' '%11' '0' '42411'
        printf '%s\t%s\t%s\n' '%21' '0' '42421'
        if [ ! -f "${fakeBinDir}/canonical-root-killed-%31" ]; then printf '%s\t%s\t%s\n' '%31' '0' '42424'; fi
        ;;
      *)
        echo "42424"
        ;;
    esac
    ;;
  capture-pane)
    echo ""
    ;;
  kill-pane)
    : > "${fakeBinDir}/canonical-root-killed-$3"
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'writer.md'), '<identity>You are Writer.</identity>');
      await writeFile(join(cwd, 'AGENTS.md'), '# Root project instructions\n');
      await initCommittedGitRepo(cwd);
      await initTeamState('canonical-root', 'task', 'executor', 1, cwd, undefined, process.env, {
        workspace_mode: 'worktree',
        leader_cwd: cwd,
        team_state_root: join(cwd, '.omx', 'state'),
      });

      const config = await readTeamConfig('canonical-root', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-canonical-root';
      config.leader_pane_id = '%11';

      config.tmux_pane_owner_id = 'team:scale-up';
      config.workers[0]!.pane_id = '%21';
      config.workers[0]!.pid = 42421;
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'canonical-root', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'canonical-root',
        1,
        'executor',
        [{ subject: 'write docs', description: 'write docs', owner: 'worker-2', role: 'writer' }],
        cwd,
        {
          OMX_TEAM_SCALING_ENABLED: '1',
          OMX_TEAM_SKIP_READY_WAIT: '1',
          OMX_TEAM_WORKER_LAUNCH_ARGS: '--model gpt-5.6-terra',
        },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const inbox = await readFile(join(cwd, '.omx', 'state', 'team', 'canonical-root', 'workers', 'worker-2', 'inbox.md'), 'utf-8');
      assert.doesNotMatch(inbox, /## Your Specialization/);
      assert.match(inbox, /\*\*Role:\*\* writer/);

      const rootAgents = await readFile(join(cwd, '.omx', 'team', 'canonical-root', 'worktrees', 'worker-2', 'AGENTS.md'), 'utf-8');
      assert.match(rootAgents, /You are operating as the \*\*writer\*\* role/);
      assert.match(rootAgents, /<identity>You are Writer\.<\/identity>/);
      assert.match(rootAgents, /exact gpt-5\.6-terra model/);
      assert.match(rootAgents, /strict execution order: inspect -> plan -> act -> verify/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('does not apply mini guidance during scale-up when the final worker model is gpt-5.6-sol', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-frontier-role-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-frontier-role-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
case "\${1:-}" in
  show-option) echo 'team:scale-up' ;;
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
    ;;
  list-panes)
    case "$*" in
      *"#{pane_id}\t#{pane_dead}\t#{pane_pid}"*)
        printf '%s\t%s\t%s\n' '%11' '0' '42411'
        printf '%s\t%s\t%s\n' '%21' '0' '42421'
        if [ ! -f "${fakeBinDir}/frontier-role-killed-%31" ]; then printf '%s\t%s\t%s\n' '%31' '0' '42424'; fi
        ;;
      *)
        echo "42424"
        ;;
    esac
    ;;
  capture-pane)
    echo ""
    ;;
  kill-pane)
    : > "${fakeBinDir}/frontier-role-killed-$3"
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'test-engineer.md'), '<identity>Test Engineer</identity>');
      await mkdir(join(cwd, '.omx', 'state', 'team', 'frontier-role'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'team', 'frontier-role', 'worker-agents.md'), '# Base worker instructions\n');

      await initTeamState('frontier-role', 'task', 'executor', 1, cwd);
      await createTask('frontier-role', {
        subject: 'existing task',
        description: 'already persisted',
        status: 'pending',
        owner: 'worker-1',
      }, cwd);

      const config = await readTeamConfig('frontier-role', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-frontier-role';
      config.leader_pane_id = '%11';

      config.tmux_pane_owner_id = 'team:scale-up';
      config.workers[0]!.pane_id = '%21';
      config.workers[0]!.pid = 42421;
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'frontier-role', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'frontier-role',
        1,
        'executor',
        [{ subject: 'test routing report only', description: 'test routing report only', owner: 'worker-2', role: 'test-engineer' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const workerAgents = await readFile(join(cwd, '.omx', 'state', 'team', 'frontier-role', 'workers', 'worker-2', 'AGENTS.md'), 'utf-8');
      assert.match(workerAgents, /You are operating as the \*\*test-engineer\*\* role/);
      assert.match(workerAgents, /<identity>Test Engineer<\/identity>/);
      assert.doesNotMatch(workerAgents, /exact gpt-5\.6-terra model/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('does not apply mini guidance during scale-up for gpt-5.6-terra-tuned overrides', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-mini-tuned-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-mini-tuned-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
case "\${1:-}" in
  show-option) echo 'team:scale-up' ;;
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
    ;;
  list-panes)
    case "$*" in
      *"#{pane_id}\t#{pane_dead}\t#{pane_pid}"*)
        printf '%s\t%s\t%s\n' '%11' '0' '42411'
        printf '%s\t%s\t%s\n' '%21' '0' '42421'
        if [ ! -f "${fakeBinDir}/mini-tuned-killed-%31" ]; then printf '%s\t%s\t%s\n' '%31' '0' '42424'; fi
        ;;
      *)
        echo "42424"
        ;;
    esac
    ;;
  capture-pane)
    echo ""
    ;;
  kill-pane)
    : > "${fakeBinDir}/mini-tuned-killed-$3"
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'writer.md'), '<identity>You are Writer.</identity>');
      await writeFile(join(cwd, 'AGENTS.md'), '# Root project instructions\n');
      await initCommittedGitRepo(cwd);
      await initTeamState('mini-tuned-root', 'task', 'executor', 1, cwd, undefined, process.env, {
        workspace_mode: 'worktree',
        leader_cwd: cwd,
        team_state_root: join(cwd, '.omx', 'state'),
      });

      const config = await readTeamConfig('mini-tuned-root', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-mini-tuned-root';
      config.leader_pane_id = '%11';

      config.tmux_pane_owner_id = 'team:scale-up';
      config.workers[0]!.pane_id = '%21';
      config.workers[0]!.pid = 42421;
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'mini-tuned-root', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'mini-tuned-root',
        1,
        'executor',
        [{ subject: 'write docs', description: 'write docs', owner: 'worker-2', role: 'writer' }],
        cwd,
        {
          OMX_TEAM_SCALING_ENABLED: '1',
          OMX_TEAM_SKIP_READY_WAIT: '1',
          OMX_TEAM_WORKER_LAUNCH_ARGS: '--model gpt-5.6-terra-tuned',
        },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const rootAgents = await readFile(join(cwd, '.omx', 'team', 'mini-tuned-root', 'worktrees', 'worker-2', 'AGENTS.md'), 'utf-8');
      assert.match(rootAgents, /You are operating as the \*\*writer\*\* role/);
      assert.match(rootAgents, /<identity>You are Writer\.<\/identity>/);
      assert.doesNotMatch(rootAgents, /exact gpt-5\.6-terra model/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('preserves leader/HUD layout by avoiding tiled relayout during scale-up', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-layout-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-layout-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  show-option) echo 'team:scale-up' ;;
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
    ;;
  list-panes)
    case "$*" in
      *"#{pane_id}\t#{pane_dead}\t#{pane_pid}"*)
        printf '%s\t%s\t%s\n' '%11' '0' '42411'
        printf '%s\t%s\t%s\n' '%21' '0' '42421'
        if [ ! -f "${fakeBinDir}/layout-killed-%31" ]; then printf '%s\t%s\t%s\n' '%31' '0' '42424'; fi
        ;;
      *)
        echo "42424"
        ;;
    esac
    ;;
  capture-pane)
    echo ""
    ;;
  kill-pane)
    : > "${fakeBinDir}/layout-killed-$3"
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('scale-up-layout', 'task', 'executor', 1, cwd);

      const config = await readTeamConfig('scale-up-layout', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-scale-up-layout';
      config.leader_pane_id = '%11';

      config.tmux_pane_owner_id = 'team:scale-up';
      config.workers[0]!.pane_id = '%21';
      config.workers[0]!.pid = 42421;
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'scale-up-layout', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'scale-up-layout',
        1,
        'executor',
        [],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      const splitWindowIndex = tmuxCommands.findIndex((command) => command.startsWith('split-window '));
      assert.ok(splitWindowIndex > 2);
      assert.match(tmuxCommands[splitWindowIndex - 3]!, /^list-panes -a -F #\{pane_id\}\t#\{pane_dead\}\t#\{pane_pid\}$/);
      assert.equal(tmuxCommands[splitWindowIndex - 2], 'show-option -qv -p -t %21 @omx_team_pane_owner_id');
      assert.match(tmuxCommands[splitWindowIndex - 1]!, /^list-panes -a -F #\{pane_id\}\t#\{pane_dead\}\t#\{pane_pid\}$/);
      assert.match(tmuxCommands[splitWindowIndex]!, /split-window -v -t %21/);
      assert.doesNotMatch(tmuxCommands.join('\n'), /select-layout .*tiled/);

    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  for (const [name, proofOutput, proofExitStatus, expectedReason] of [
    ['dead persisted worker pane', '%21\t1\t42421\n', 0, 'dead'],
    ['similar persisted worker pane ID', '%210\t0\t424210\n', 0, 'absent'],
    ['malformed global pane PID', '%21\t0\tnot-a-pid\n', 0, 'malformed_snapshot'],
    ['duplicate global pane proof rows', '%21\t0\t42421\n%21\t0\t42422\n', 0, 'malformed_snapshot'],
    ['unavailable global pane query', '', 1, 'query_failed'],
  ] as const) {
    it(`fails closed before split-window when exact proof has ${name}`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-split-proof-'));
      const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-split-proof-bin-'));
      const tmuxLogPath = join(fakeBinDir, 'tmux.log');
      const tmuxStubPath = join(fakeBinDir, 'tmux');
      const previousPath = process.env.PATH;

      try {
        await writeFile(
          tmuxStubPath,
          [
            '#!/bin/sh',
            'set -eu',
            `printf '%s\\n' "$*" >> "${tmuxLogPath}"`,
            'case "${1:-}" in',
          '  show-option) echo "team:scale-up" ;;',
            '  -V)',
            '    echo "tmux 3.2a"',
            '    ;;',
            '  list-panes)',
            `    printf '%b' ${JSON.stringify(proofOutput)}`,
            proofExitStatus === 0 ? '    ;;' : '    exit 1',
            proofExitStatus === 0 ? '' : '    ;;',
            '  split-window)',
            '    echo "%31"',
            '    ;;',
            'esac',
            'exit 0',
            '',
          ].join('\n'),
        );
        await chmod(tmuxStubPath, 0o755);
        await writeFile(tmuxLogPath, '');
        process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

        const teamName = `split-proof-${expectedReason === 'malformed_snapshot' ? name.includes('duplicate') ? 'duplicate' : 'malformed' : expectedReason.replace('_', '-')}`;
        await initTeamState(teamName, 'task', 'executor', 1, cwd);
        await configureScaleUpTeamForDirectDispatch(teamName, cwd);

        const result = await scaleUp(
          teamName,
          1,
          'executor',
          [],
          cwd,
          { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
        );
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.error, `scale_up_split_target_proof_unavailable:%21:${expectedReason}`);
        }

        const config = await readTeamConfig(teamName, cwd);
        assert.equal(config?.workers.length, 1);
        const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
        assert.equal(tmuxCommands.some((command) => command.startsWith('split-window ')), false);
        assert.equal(tmuxCommands.some((command) => command.startsWith('send-keys ')), false);
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        await rm(cwd, { recursive: true, force: true });
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    });
  }

  it('migrates a legacy worker PID from an exact owner-bound proof before split-window', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-legacy-target-pid-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-legacy-target-pid-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
      const stub = await readFile(tmuxStubPath, 'utf-8');
      const configPath = join(cwd, '.omx', 'state', 'team', 'legacy-target-pid', 'config.json');
      await writeFile(tmuxStubPath, stub.replace(
        '  split-window)',
        `  split-window)\n    grep -q '"pid": 42421' "${configPath}" || exit 23`,
      ));
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      const teamName = 'legacy-target-pid';
      await initTeamState(teamName, 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);
      const config = await readTeamConfig(teamName, cwd);
      assert.ok(config);
      if (!config) return;
      delete config.workers[0]!.pid;
      await saveTeamConfig(config, cwd);

      const result = await scaleUp(teamName, 1, 'executor', [], cwd, {
        OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1',
      });
      assert.equal(result.ok, true);
      assert.equal((await readTeamConfig(teamName, cwd))?.workers[0]?.pid, 42421);
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.ok(tmuxCommands.some((command) => command.startsWith('split-window ')));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  for (const [name, proofOutput, owner, expectedError] of [
    ['malformed proof', '%21\\t0\\tnot-a-pid\\n', 'team:scale-up', 'scale_up_split_target_proof_unavailable:%21:malformed_snapshot'],
    ['foreign pane', '%210\\t0\\t424210\\n', 'team:scale-up', 'scale_up_split_target_proof_unavailable:%21:absent'],
    ['foreign owner tag', '%21\\t0\\t42421\\n', 'team:foreign', 'scale_up_split_target_owner_changed:%21'],
  ] as const) {
    it(`rejects legacy PID migration with ${name} before a scale effect`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-legacy-proof-reject-'));
      const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-legacy-proof-reject-bin-'));
      const tmuxLogPath = join(fakeBinDir, 'tmux.log');
      const tmuxStubPath = join(fakeBinDir, 'tmux');
      const previousPath = process.env.PATH;
      try {
        await writeFile(tmuxStubPath, [
          '#!/bin/sh', 'set -eu', `printf '%s\\n' "$*" >> "${tmuxLogPath}"`, 'case "${1:-}" in',
          '  -V) echo "tmux 3.2a" ;;',
          `  list-panes) printf '%b' ${JSON.stringify(proofOutput)} ;;`,
          `  show-option) echo ${JSON.stringify(owner)} ;;`,
          'esac', 'exit 0', '',
        ].join('\n'));
        await chmod(tmuxStubPath, 0o755);
        await writeFile(tmuxLogPath, '');
        process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
        const teamName = `legacy-proof-${name.replaceAll(' ', '-')}`;
        await initTeamState(teamName, 'task', 'executor', 1, cwd);
        await configureScaleUpTeamForDirectDispatch(teamName, cwd);
        const config = await readTeamConfig(teamName, cwd);
        assert.ok(config);
        if (!config) return;
        delete config.workers[0]!.pid;
        await saveTeamConfig(config, cwd);

        assert.deepEqual(await scaleUp(teamName, 1, 'executor', [], cwd, {
          OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1',
        }), { ok: false, error: expectedError });
        assert.equal((await readTeamConfig(teamName, cwd))?.workers[0]?.pid, undefined);
        const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
        assert.equal(tmuxCommands.some((command) => command.startsWith('split-window ') || command.startsWith('set-option ')), false);
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        await rm(cwd, { recursive: true, force: true });
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    });
  }

  it('rejects a PID-reused explicit split target at the first proof before any split or owner tag', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-first-proof-reuse-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-first-proof-reuse-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(tmuxStubPath, [
        '#!/bin/sh', 'set -eu', `printf '%s\\n' "$*" >> "${tmuxLogPath}"`, 'case "${1:-}" in', '  show-option) echo "team:scale-up" ;;',
          '  show-option) echo "team:scale-up" ;;',
        '  -V) echo "tmux 3.2a" ;;',
        "  list-panes) printf '%s\\t%s\\t%s\\n' '%21' '0' '52421' ;;",
        'esac', 'exit 0', '',
      ].join('\n'));
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      const teamName = 'first-proof-reuse';
      await initTeamState(teamName, 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);
      const result = await scaleUp(teamName, 1, 'executor', [], cwd, { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' });
      assert.deepEqual(result, { ok: false, error: 'scale_up_split_target_pid_changed:%21:42421:52421' });
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.equal(tmuxCommands.some((command) => command.startsWith('split-window ') || command.startsWith('set-option ')), false);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('rolls back all preparation when the split target proof is lost immediately before split-window', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-second-split-proof-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-second-split-proof-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const proofCountPath = join(fakeBinDir, 'proof-count');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  show-option) echo "team:scale-up" ;;',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  list-panes)',
          `    count=0; [ ! -f "${proofCountPath}" ] || count=$(cat "${proofCountPath}")`,
          '    count=$((count + 1))',
          `    printf '%s' "$count" > "${proofCountPath}"`,
          '    if [ "$count" -eq 1 ]; then',
          "      printf '%s\\t%s\\t%s\\n' '%21' '0' '42421'",
          '    else',
          '      exit 1',
          '    fi',
          '    ;;',
          '  split-window)',
          '    echo "%31"',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      const teamName = 'second-split-proof';
      await initTeamState(teamName, 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);
      const teamStateDir = join(cwd, '.omx', 'state', 'team', teamName);
      const configPath = join(teamStateDir, 'config.json');
      const tasksDir = join(teamStateDir, 'tasks');
      const workersDir = join(teamStateDir, 'workers');
      const runtimeDir = join(teamStateDir, 'runtime');
      const configBefore = await readFile(configPath, 'utf-8');
      const taskEntriesBefore = (await readdir(tasksDir)).sort();
      const workerEntriesBefore = (await readdir(workersDir)).sort();
      const runtimeDirExistedBefore = existsSync(runtimeDir);

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [{ subject: 'must not persist', description: 'proof loss rollback', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );

      assert.deepEqual(result, {
        ok: false,
        error: 'scale_up_split_target_proof_unavailable:%21:query_failed',
      });
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.deepEqual(
        tmuxCommands.filter((command) => command.startsWith('list-panes ')),
        [
          'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
          'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
        ],
      );
      assert.equal(tmuxCommands.some((command) => command.startsWith('split-window ')), false);
      assert.equal(tmuxCommands.some((command) => command.startsWith('send-keys ')), false);
      assert.deepEqual(withoutConfigGeneration(await readFile(configPath, 'utf-8')), withoutConfigGeneration(configBefore));
      assert.deepEqual((await readdir(tasksDir)).sort(), taskEntriesBefore);
      assert.deepEqual((await readdir(workersDir)).sort(), workerEntriesBefore);
      assert.equal(existsSync(join(workersDir, 'worker-2')), false);
      assert.equal(existsSync(join(cwd, '.omx', 'team', teamName, 'worktrees', 'worker-2')), false);
      assert.equal(existsSync(runtimeDir), runtimeDirExistedBefore);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('rejects a split target ID replacement that occurs during owner authorization', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-split-target-pid-reuse-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-split-target-pid-reuse-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const proofCountPath = join(fakeBinDir, 'proof-count');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(tmuxStubPath, [
        '#!/bin/sh',
        'set -eu',
        `printf '%s\\n' "$*" >> "${tmuxLogPath}"`,
        'case "${1:-}" in',
          '  show-option) echo "team:scale-up" ;;',
        '  -V)',
        '    echo "tmux 3.2a"',
        '    ;;',
        '  list-panes)',
        `    count=0; [ ! -f "${proofCountPath}" ] || count=$(cat "${proofCountPath}")`,
        '    count=$((count + 1))',
        `    printf '%s' "$count" > "${proofCountPath}"`,
        '    if [ "$count" -eq 1 ]; then',
        "      printf '%s\\t%s\\t%s\\n' '%21' '0' '42421'",
        '    else',
        "      printf '%s\\t%s\\t%s\\n' '%21' '0' '52421'",
        '    fi',
        '    ;;',
        '  split-window)',
        '    echo "%31"',
        '    ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'));
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      const teamName = 'split-target-pid-reuse';
      await initTeamState(teamName, 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);
      const config = await readTeamConfig(teamName, cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[0]!.pid = 42421;
      await saveTeamConfig(config, cwd);

      const teamStateDir = join(cwd, '.omx', 'state', 'team', teamName);
      const configPath = join(teamStateDir, 'config.json');
      const tasksDir = join(teamStateDir, 'tasks');
      const workersDir = join(teamStateDir, 'workers');
      const runtimeDir = join(teamStateDir, 'runtime');

      const configBefore = await readFile(configPath, 'utf-8');
      const taskEntriesBefore = (await readdir(tasksDir)).sort();
      const workerEntriesBefore = (await readdir(workersDir)).sort();
      const runtimeDirExistedBefore = existsSync(runtimeDir);


      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [{ subject: 'must not persist', description: 'PID reuse rollback', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );

      assert.deepEqual(result, {
        ok: false,
        error: 'scale_up_split_target_pid_changed:%21:42421:52421',
      });
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.equal(tmuxCommands.filter((command) => command.startsWith('list-panes ')).length, 2);
      assert.equal(tmuxCommands.some((command) => command.startsWith('split-window ')), false);
      assert.equal(tmuxCommands.some((command) => command.startsWith('send-keys ')), false);
      assert.deepEqual(withoutConfigGeneration(await readFile(configPath, 'utf-8')), withoutConfigGeneration(configBefore));
      assert.deepEqual((await readdir(tasksDir)).sort(), taskEntriesBefore);
      assert.deepEqual((await readdir(workersDir)).sort(), workerEntriesBefore);
      assert.equal(existsSync(join(workersDir, 'worker-2')), false);
      assert.equal(existsSync(runtimeDir), runtimeDirExistedBefore);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('provisions detached worktrees for scaled-up workers from persisted team worktree mode', async () => {
    const repo = await initRepo();
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-detached-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  show-option) echo "team:scale-up" ;;',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%41"',
          '    ;;',
          '  list-panes)',
          '    case "$*" in',
          '      *"#{pane_id}\t#{pane_dead}\t#{pane_pid}"*)',
          "        printf '%s\\t%s\\t%s\\n' '%11' '0' '45451'",
          "        printf '%s\\t%s\\t%s\\n' '%21' '0' '45452'",
          "        printf '%s\\t%s\\t%s\\n' '%41' '0' '45454'",
          '        ;;',
          '      *)',
          '        echo "45454"',
          '        ;;',
          '    esac',
          '    ;;',
          '  capture-pane)',
          '    echo ""',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      const teamName = 'scale-up-detached-worktree';
      await mkdir(join(repo, '.omx', 'state', 'team', teamName), { recursive: true });
      await writeFile(join(repo, '.omx', 'state', 'team', teamName, 'worker-agents.md'), '# Base worker instructions\n');
      await initTeamState(
        teamName,
        'task',
        'executor',
        1,
        repo,
        DEFAULT_MAX_WORKERS,
        process.env,
        {
          leader_cwd: repo,
          team_state_root: join(repo, '.omx', 'state'),
          workspace_mode: 'worktree',
          worktree_mode: { enabled: true, detached: true, name: null },
        },
      );

      const config = await readTeamConfig(teamName, repo);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = `omx-team-${teamName}`;
      config.leader_pane_id = '%11';

      config.tmux_pane_owner_id = 'team:scale-up';
      config.workers[0]!.pane_id = '%21';
      config.workers[0]!.pid = 45452;
      await saveTeamConfig(config, repo);

      const manifestPath = join(repo, '.omx', 'state', 'team', teamName, 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [],
        repo,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const updated = await readTeamConfig(teamName, repo);
      const worker = updated?.workers.find((entry) => entry.name === 'worker-2');
      assert.deepEqual(updated?.worktree_mode, { enabled: true, detached: true, name: null });
      assert.ok(worker?.worktree_path, 'scaled worker should have detached worktree path');
      assert.equal(worker?.working_dir, worker?.worktree_path);
      assert.equal(worker?.worktree_detached, true);
      assert.equal(worker?.worktree_created, true);
      assert.equal(existsSync(worker?.worktree_path as string), true);
      assert.throws(
        () => execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: worker?.worktree_path, stdio: 'pipe' }),
      );
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('provisions named worktrees for scaled-up workers from persisted team worktree mode', async () => {
    const repo = await initRepo();
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-named-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  show-option) echo "team:scale-up" ;;',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%42"',
          '    ;;',
          '  list-panes)',
          '    case "$*" in',
          '      *"#{pane_id}\t#{pane_dead}\t#{pane_pid}"*)',
          "        printf '%s\\t%s\\t%s\\n' '%11' '0' '46461'",
          "        printf '%s\\t%s\\t%s\\n' '%21' '0' '46462'",
          "        printf '%s\\t%s\\t%s\\n' '%42' '0' '46464'",
          '        ;;',
          '      *)',
          '        echo "46464"',
          '        ;;',
          '    esac',
          '    ;;',
          '  capture-pane)',
          '    echo ""',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      const teamName = 'scale-up-named-worktree';
      const branchBase = 'feature/team-scale';
      await mkdir(join(repo, '.omx', 'state', 'team', teamName), { recursive: true });
      await writeFile(join(repo, '.omx', 'state', 'team', teamName, 'worker-agents.md'), '# Base worker instructions\n');
      await initTeamState(
        teamName,
        'task',
        'executor',
        1,
        repo,
        DEFAULT_MAX_WORKERS,
        process.env,
        {
          leader_cwd: repo,
          team_state_root: join(repo, '.omx', 'state'),
          workspace_mode: 'worktree',
          worktree_mode: { enabled: true, detached: false, name: branchBase },
        },
      );

      const config = await readTeamConfig(teamName, repo);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = `omx-team-${teamName}`;
      config.leader_pane_id = '%11';

      config.tmux_pane_owner_id = 'team:scale-up';
      config.workers[0]!.pane_id = '%21';
      config.workers[0]!.pid = 46462;
      await saveTeamConfig(config, repo);

      const manifestPath = join(repo, '.omx', 'state', 'team', teamName, 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [],
        repo,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const updated = await readTeamConfig(teamName, repo);
      const worker = updated?.workers.find((entry) => entry.name === 'worker-2');
      assert.deepEqual(updated?.worktree_mode, { enabled: true, detached: false, name: branchBase });
      assert.equal(worker?.worktree_branch, `${branchBase}/worker-2`);
      assert.equal(worker?.working_dir, worker?.worktree_path);
      assert.equal(worker?.worktree_detached, false);
      assert.equal(worker?.worktree_created, true);
      assert.equal(existsSync(worker?.worktree_path as string), true);
      assert.equal(
        execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: worker?.worktree_path, encoding: 'utf-8' }).trim(),
        `${branchBase}/worker-2`,
      );
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
  it('rolls back pre-split worker preparation when worktree-root instructions cannot materialize', async () => {
    const cwd = await initRepo();
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-pre-split-root-failure-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;
    const teamName = 'pre-split-root-failure';
    const worktreePath = join(cwd, '.omx', 'team', teamName, 'worktrees', 'worker-2');
    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  show-option) echo 'team:scale-up' ;;
  -V) echo 'tmux 3.2a' ;;
  list-panes) printf '%s\\t%s\\t%s\\n' '%21' '0' '42421' ;;
esac
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState(teamName, 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);
      const config = await readTeamConfig(teamName, cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = `omx-team-${teamName}`;
      config.workers[0]!.pane_id = '%21';
      config.workspace_mode = 'worktree';
      config.worktree_mode = { enabled: true, detached: true, name: null };
      await saveTeamConfig(config, cwd);
      execFileSync('git', ['worktree', 'add', '--detach', worktreePath], { cwd, stdio: 'ignore' });
      await mkdir(join(worktreePath, 'AGENTS.md'));

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /^scale_up_worker_preparation_failed:worker-2:/);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2')), false);
      assert.equal(existsSync(workerStartupScriptPath(cwd, teamName, 'worker-2')), false);
      assert.equal(existsSync(join(worktreePath, 'AGENTS.md')), true);
      assert.deepEqual(await readScaleUpTmuxLogCommands(tmuxLogPath), [
        '-V',
        'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
      ]);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
  it('retains only unresolved rollback workers and deletes never-created tasks after an explicit proof-loss phase', async () => {
    const cwd = await initRepo();
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-rollback-kill-fail-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const proofLossUsedPath = join(fakeBinDir, 'proof-loss-used');
    const splitCountPath = join(fakeBinDir, 'split-count');
    const previousPath = process.env.PATH;
    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  show-option) echo 'team:scale-up' ;;
  -V) echo 'tmux 3.2a' ;;
  list-panes)
    split_count=0; [ ! -f "${splitCountPath}" ] || split_count=$(cat "${splitCountPath}")
    if [ "$split_count" -ge 2 ] && [ ! -f "${proofLossUsedPath}" ]; then
      : > "${proofLossUsedPath}"
      exit 1
    fi
    if [ "$split_count" -ge 2 ]; then
      printf '%s\t%s\t%s\n' '%21' '0' '42421'
      printf '%s\t%s\t%s\n' '%31' '0' '42431'
      printf '%s\t%s\t%s\n' '%32' '0' '42432'
    elif [ "$split_count" -eq 1 ]; then
      printf '%s\t%s\t%s\n' '%21' '0' '42421'
      printf '%s\t%s\t%s\n' '%31' '0' '42431'
    else
      printf '%s\t%s\t%s\n' '%21' '0' '42421'
    fi
    ;;
  split-window)
    split_count=0; [ ! -f "${splitCountPath}" ] || split_count=$(cat "${splitCountPath}")
    split_count=$((split_count + 1)); printf '%s' "$split_count" > "${splitCountPath}"
    if [ "$split_count" -eq 1 ]; then
      echo '%31'
    else
      echo '%32'
    fi
    ;;
  kill-pane)
    case "$3" in
      %31|%32) exit 0 ;;
      *) exit 1 ;;
    esac
    ;;
esac
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState('rollback-kill-fail', 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch('rollback-kill-fail', cwd);
      const rollbackConfig = await readTeamConfig('rollback-kill-fail', cwd);
      assert.ok(rollbackConfig);
      if (!rollbackConfig) return;
      rollbackConfig.workspace_mode = 'worktree';
      rollbackConfig.worktree_mode = { enabled: true, detached: true, name: null };
      await saveTeamConfig(rollbackConfig, cwd);

      const result = await scaleUp(
        'rollback-kill-fail',
        3,
        'executor',
        [
          { subject: 'first', description: 'created before mixed rollback', owner: 'worker-2' },
          { subject: 'second', description: 'created before mixed rollback', owner: 'worker-3' },
          { subject: 'third', description: 'never created after proof loss', owner: 'worker-4' },
        ],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );

      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /^scale_up_rollback_cleanup_debt:.*pane_teardown_failed:%31.*pane_teardown_unresolved:%32/);
      assert.equal(await readFile(splitCountPath, 'utf-8'), '2');
      const config = await readTeamConfig('rollback-kill-fail', cwd);
      assert.deepEqual(config?.workers.map((worker) => worker.name), ['worker-1', 'worker-2', 'worker-3']);
      assert.equal(config?.worker_count, 3);
      assert.equal(config?.next_worker_index, 4);
      assert.equal((await readTask('rollback-kill-fail', '1', cwd))?.owner, 'worker-2');
      assert.equal((await readTask('rollback-kill-fail', '2', cwd))?.owner, 'worker-3');
      assert.equal(await readTask('rollback-kill-fail', '3', cwd), null);
      for (const workerName of ['worker-2', 'worker-3']) {
        const workerDir = join(cwd, '.omx', 'state', 'team', 'rollback-kill-fail', 'workers', workerName);
        assert.equal(existsSync(workerStartupScriptPath(cwd, 'rollback-kill-fail', workerName)), true, `${workerName} startup script must remain`);
        assert.equal(existsSync(join(cwd, '.omx', 'team', 'rollback-kill-fail', 'worktrees', workerName)), true, `${workerName} worktree must remain`);
        if (workerName === 'worker-2') {
          assert.equal(existsSync(workerDir), true, 'worker-2 materialized state must remain retryable');
          assert.equal(existsSync(join(workerDir, 'identity.json')), true, 'worker-2 identity must remain');
          assert.equal(existsSync(join(workerDir, 'inbox.md')), true, 'worker-2 inbox must remain');
        } else {
          assert.equal(existsSync(join(workerDir, 'identity.json')), false, 'worker-3 proof failed before identity materialization');
          assert.equal(existsSync(join(workerDir, 'inbox.md')), false, 'worker-3 proof failed before inbox materialization');
        }
      }
      // P2: retry execution of recorded cleanup debt is intentionally a follow-up surface.
      const tmuxCommands: string[] = await readScaleUpTmuxLogCommands(tmuxLogPath);
      const mutationCommands = tmuxCommands
        .filter((command) => command.startsWith('split-window ') || command.startsWith('kill-pane '))
        .map((command) => command.startsWith('split-window ') ? command.split(' -c ')[0]! : command);
      assert.deepEqual(mutationCommands, [
        'split-window -v -t %21 -d -P -F #{pane_id}',
        'split-window -v -t %31 -d -P -F #{pane_id}',
        'kill-pane -t %31',
      ]);
      for (const mutationCommand of mutationCommands) {
        const mutationIndex = tmuxCommands.findIndex((command) => (
          command === mutationCommand || command.startsWith(`${mutationCommand} -c `)
        ));
        if (mutationCommand.startsWith('split-window ')) {
          assert.ok(mutationIndex > 2);
          assert.equal(tmuxCommands[mutationIndex - 3], 'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}');
          assert.match(tmuxCommands[mutationIndex - 2]!, /^show-option -qv -p -t %(?:21|31) @omx_team_pane_owner_id$/);
          assert.equal(tmuxCommands[mutationIndex - 1], 'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}');
        } else {
          assert.ok(mutationIndex > 2);
          assert.equal(tmuxCommands[mutationIndex - 3], 'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}');
          assert.equal(tmuxCommands[mutationIndex - 2], 'show-option -qv -p -t %31 @omx_team_pane_owner_id');
          assert.equal(tmuxCommands[mutationIndex - 1], 'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}');
        }
      }
      assert.ok(tmuxCommands.some((command) => command.startsWith('split-window -v -t %21 ')));
      assert.ok(tmuxCommands.some((command) => command.startsWith('split-window -v -t %31 ')));
      assert.ok(tmuxCommands.some((command) => command === 'kill-pane -t %31'));
      assert.equal(tmuxCommands.some((command) => command === 'kill-pane -t %32'), false);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  for (const rollbackFailurePhase of ['rollback-membership-config-persistence', 'rollback-membership-manifest-persistence'] as const) {
    it(`recovers and raw-verifies original membership after public scaleUp ${rollbackFailurePhase}`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), `omx-scale-up-${rollbackFailurePhase}-`));
      const fakeBinDir = await mkdtemp(join(tmpdir(), `omx-scale-up-${rollbackFailurePhase}-bin-`));
      const tmuxLogPath = join(fakeBinDir, 'tmux.log');
      const previousPath = process.env.PATH;
      const teamName = `scale-up-${rollbackFailurePhase.replace('rollback-membership-', '').replace('-persistence', '')}`;
      try {
        await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
        process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
        await initTeamState(teamName, 'task', 'executor', 1, cwd);
        await configureScaleUpTeamForDirectDispatch(teamName, cwd);
        const teamDir = join(cwd, '.omx', 'state', 'team', teamName);
        const configPath = join(teamDir, 'config.json');
        const manifestPath = join(teamDir, 'manifest.v2.json');
        const originalConfigBytes = await readFile(configPath, 'utf8');
        const originalManifestBytes = await readFile(manifestPath, 'utf8');

        const result = await scaleUp(
          teamName,
          1,
          'executor',
          [{ subject: 'public rollback recovery', description: 'must be removed', owner: 'worker-2' }],
          cwd,
          {
            OMX_TEAM_SCALING_ENABLED: '1',
            OMX_TEAM_SKIP_READY_WAIT: '1',
            OMX_TEAM_SCALE_UP_INJECT_FAILURE: `finalization,${rollbackFailurePhase}`,
          },
        );

        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.error, /scale_up_rollback_membership_persistence_failed:.*rollback-persistence-failure/);
        await readTeamConfig(teamName, cwd);
        assert.deepEqual(withoutConfigGeneration(await readFile(configPath, 'utf8')), withoutConfigGeneration(originalConfigBytes));
        assert.deepEqual(withoutConfigGeneration(await readFile(manifestPath, 'utf8')), withoutConfigGeneration(originalManifestBytes));
        assert.equal(existsSync(join(teamDir, '.membership-task-transaction.json')), false);
        assert.equal(await readTask(teamName, '1', cwd), null);
        assert.deepEqual(await listDispatchRequests(teamName, cwd), []);
        assert.equal(existsSync(join(teamDir, 'workers', 'worker-2')), true);
        assert.equal(existsSync(workerStartupScriptPath(cwd, teamName, 'worker-2')), true);
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        await rm(cwd, { recursive: true, force: true });
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    });
  }
  for (const phase of ['identity', 'inbox', 'config'] as const) {
    it(`rolls back live pane and materialized state when ${phase} materialization fails`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), `omx-scale-up-${phase}-failure-`));
      const fakeBinDir = await mkdtemp(join(tmpdir(), `omx-scale-up-${phase}-failure-bin-`));
      const tmuxLogPath = join(fakeBinDir, 'tmux.log');
      const previousPath = process.env.PATH;
      try {
        await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
        process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
        const teamName = `scale-up-${phase}-failure`;
        await initTeamState(teamName, 'task', 'executor', 1, cwd);
        await configureScaleUpTeamForDirectDispatch(teamName, cwd);
        const result = await scaleUp(
          teamName,
          1,
          'executor',
          [{ subject: `${phase} rollback`, description: 'must be removed', owner: 'worker-2' }],
          cwd,
          {
            OMX_TEAM_SCALING_ENABLED: '1',
            OMX_TEAM_SKIP_READY_WAIT: '1',
            OMX_TEAM_SCALE_UP_INJECT_FAILURE: phase,
          },
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.error, new RegExp(`scale_up_worker_materialization_failed:worker-2:.*${phase}`));
        assert.equal((await readTeamConfig(teamName, cwd))?.workers.length, 1);
        assert.equal(await readTask(teamName, '1', cwd), null);
        assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2')), false);
        assert.equal(existsSync(workerStartupScriptPath(cwd, teamName, 'worker-2')), false);
        const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
        assert.ok(tmuxCommands.some((command) => command.startsWith('split-window ')));
        assert.ok(tmuxCommands.includes('kill-pane -t %31'));
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        await rm(cwd, { recursive: true, force: true });
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    });
  }
  it('rolls back a named worktree created before injected ensure bookkeeping fails', async () => {
    const repo = await initRepo();
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-named-post-create-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;
    const teamName = 'named-post-create-failure';
    const branchName = 'feature/named-post-create/worker-2';
    const worktreePath = join(repo, '.omx', 'team', teamName, 'worktrees', 'worker-2');
    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState(teamName, 'task', 'executor', 1, repo, undefined, process.env, {
        workspace_mode: 'worktree',
        leader_cwd: repo,
        team_state_root: join(repo, '.omx', 'state'),
        worktree_mode: { enabled: true, detached: false, name: 'feature/named-post-create' },
      });
      await configureScaleUpTeamForDirectDispatch(teamName, repo);
      const result = await scaleUp(teamName, 1, 'executor', [], repo, {
        OMX_TEAM_SCALING_ENABLED: '1',
        OMX_TEAM_SKIP_READY_WAIT: '1',
        OMX_TEAM_SCALE_UP_INJECT_FAILURE: 'worktree-ensure-post-create',
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /scale_up_worker_preparation_failed:worker-2:.*worktree-ensure-post-create/);
      assert.equal(existsSync(worktreePath), false);
      assert.throws(() => execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], { cwd: repo }));
      assert.equal((await readTeamConfig(teamName, repo))?.workers.length, 1);
      assert.equal(existsSync(join(repo, '.omx', 'state', 'team', teamName, 'workers', 'worker-2')), false);
      assert.deepEqual((await readScaleUpTmuxLogCommands(tmuxLogPath)).filter((command) => command.startsWith('split-window ')), []);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
});

describe('scaleDown', () => {
  it('rejects when scaling is disabled', async () => {
    await assert.rejects(
      scaleDown('test', '/tmp', {}, {}),
      /Dynamic scaling is disabled/,
    );
  });

  it('returns error when team not found', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-nf-'));
    try {
      const result = await scaleDown(
        'nonexistent', cwd, {},
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /not found/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns error when trying to remove all workers', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-all-'));
    try {
      await initTeamState('all-test', 'task', 'executor', 1, cwd);
      const result = await scaleDown(
        'all-test', cwd,
        { workerNames: ['worker-1'] },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /at least 1 must remain/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns error for worker not in team', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-miss-'));
    try {
      await initTeamState('miss-test', 'task', 'executor', 2, cwd);
      const result = await scaleDown(
        'miss-test', cwd,
        { workerNames: ['worker-99'] },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /Worker worker-99 not found/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns error when not enough idle workers and force=false', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-busy-'));
    try {
      await initTeamState('busy-test', 'task', 'executor', 2, cwd);
      // Write working status for both workers
      await writeWorkerStatus('busy-test', 'worker-1', {
        state: 'working',
        current_task_id: 't-1',
        updated_at: new Date().toISOString(),
      }, cwd);
      await writeWorkerStatus('busy-test', 'worker-2', {
        state: 'working',
        current_task_id: 't-2',
        updated_at: new Date().toISOString(),
      }, cwd);
      const result = await scaleDown(
        'busy-test', cwd,
        { count: 1 },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /Not enough idle workers/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('serializes a concurrent claim across the canonical scale-down boundary', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-claim-boundary-'));
    try {
      await initTeamState('claim-boundary', 'task', 'executor', 2, cwd);
      const task = await createTask('claim-boundary', {
        subject: 'boundary task', description: 'must not be claimed by a removed worker', status: 'pending', owner: 'worker-2',
      }, cwd);
      const down = scaleDown('claim-boundary', cwd, { workerNames: ['worker-2'], force: true }, {
        OMX_TEAM_SCALING_ENABLED: '1',
        OMX_TEAM_SCALE_DOWN_BOUNDARY_HOLD_MS: '100',
      });
      const lockPath = join(cwd, '.omx', 'state', 'team', 'claim-boundary', 'claims', `task-${task.id}.lock`);
      for (let attempt = 0; attempt < 50 && !existsSync(lockPath); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(existsSync(lockPath), true);
      const claim = claimTask('claim-boundary', task.id, 'worker-2', task.version ?? 1, cwd);
      assert.deepEqual(await down, { ok: true, removedWorkers: ['worker-2'], newWorkerCount: 1 });
      assert.deepEqual(await claim, { ok: false, error: 'claim_conflict' });
      const reconciled = await readTask('claim-boundary', task.id, cwd);
      assert.equal(reconciled?.owner, undefined);
      assert.equal(reconciled?.claim, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('blocks post-snapshot task creation and null-version claims until removed membership is committed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-create-claim-boundary-'));
    try {
      await initTeamState('create-claim-boundary', 'task', 'executor', 2, cwd);
      const seed = await createTask('create-claim-boundary', {
        subject: 'snapshot marker', description: 'holds the canonical task lock', status: 'pending', owner: 'worker-2',
      }, cwd);
      const postSnapshotMarker = join(cwd, 'post-snapshot-held');
      const down = scaleDown('create-claim-boundary', cwd, { workerNames: ['worker-2'], force: true }, {
        OMX_TEAM_SCALING_ENABLED: '1',
        OMX_TEAM_SCALE_DOWN_BOUNDARY_HOLD_MS: '250',
        OMX_TEAM_SCALE_DOWN_POST_SNAPSHOT_MARKER: postSnapshotMarker,
      });
      for (let attempt = 0; attempt < 50 && !existsSync(postSnapshotMarker); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(existsSync(postSnapshotMarker), true);
      let createSettled = false;
      let claimSettled = false;
      const created = createTask('create-claim-boundary', {
        subject: 'created after snapshot', description: 'must not restore removed membership', status: 'pending', owner: 'worker-2',
      }, cwd).finally(() => { createSettled = true; });
      const claim = claimTask('create-claim-boundary', seed.id, 'worker-2', null, cwd)
        .finally(() => { claimSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(createSettled, false);
      assert.equal(claimSettled, false);
      assert.deepEqual(await down, { ok: true, removedWorkers: ['worker-2'], newWorkerCount: 1 });
      assert.deepEqual(await claim, { ok: false, error: 'worker_not_found' });
      const task = await created;
      assert.equal(task.owner, 'worker-2');
      assert.deepEqual((await readTeamConfig('create-claim-boundary', cwd))?.workers.map((worker) => worker.name), ['worker-1']);
      assert.equal((await readTask('create-claim-boundary', task.id, cwd))?.owner, 'worker-2');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});


describe('scaleDown worktree AGENTS cleanup', () => {
  it('removes generated worktree-root AGENTS during scale-down', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-worktree-agents-'));
    try {
      await initTeamState('scale-down-worktree', 'task', 'executor', 2, cwd, undefined, process.env, {
        workspace_mode: 'worktree',
        leader_cwd: cwd,
        team_state_root: join(cwd, '.omx', 'state'),
      });

      const worktree = join(cwd, '.omx', 'team', 'scale-down-worktree', 'worktrees', 'worker-2');
      await mkdir(worktree, { recursive: true });
      await writeFile(join(worktree, 'AGENTS.md'), '# Tracked root instructions\n', 'utf8');
      await mkdir(join(cwd, '.omx', 'state', 'team', 'scale-down-worktree', 'workers', 'worker-2'), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'state', 'team', 'scale-down-worktree', 'workers', 'worker-2', 'root-agents-backup.json'),
        JSON.stringify({ existed: true, tracked: false, previousContent: '# Tracked root instructions\n' }, null, 2),
        'utf8',
      );
      await writeFile(join(worktree, 'AGENTS.md'), '# Generated runtime instructions\n', 'utf8');

      const config = await readTeamConfig('scale-down-worktree', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[1]!.worktree_path = worktree;
      await saveTeamConfig(config, cwd);

      const result = await scaleDown(
        'scale-down-worktree',
        cwd,
        { workerNames: ['worker-2'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      assert.equal(await readFile(join(worktree, 'AGENTS.md'), 'utf-8'), '# Tracked root instructions\n');
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', 'scale-down-worktree', 'workers', 'worker-2', 'root-agents-backup.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('scaleDown teardown hardening', () => {
  it('scaleDown removes a worker with a pane proven dead without targeting it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-dead-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-dead-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  show-option) echo 'team:scale-down' ;;
  list-panes)
    case "$*" in
      *"-a -F #{pane_id}"*)
        printf '%%405\t1\t4050\n'
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  kill-pane)
    echo "a proven-dead pane must not be targeted" >&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('dead-pane', 'task', 'executor', 2, cwd);
      const config = await readTeamConfig('dead-pane', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[1]!.pane_id = '%405';
      config.workers[1]!.pid = 424405;
      config.tmux_pane_owner_id = 'team:scale-down';
      await saveTeamConfig(config, cwd);

      const result = await scaleDown(
        'dead-pane',
        cwd,
        { workerNames: ['worker-2'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.deepEqual(result.removedWorkers, ['worker-2']);

      const updated = await readTeamConfig('dead-pane', cwd);
      assert.ok(updated);
      assert.equal(updated?.workers.some((worker) => worker.name === 'worker-2'), false);
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.deepEqual(tmuxCommands, [
        'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
        'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
      ]);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('retains PID-less rollback debt when a recycled same-Team pane remains live', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-unpinned-recycled-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-unpinned-recycled-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(tmuxStubPath, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  list-panes) printf '%%405\\t0\\t999405\\n' ;;
  show-option|kill-pane) echo "PID-less debt must not authorize an effect" >&2; exit 99 ;;
esac
`);
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('unpinned-recycled', 'task', 'executor', 2, cwd);
      const config = await readTeamConfig('unpinned-recycled', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[1]!.pane_id = '%405';
      config.workers[1]!.pid = undefined;
      config.tmux_pane_owner_id = 'team:scale-down';
      await saveTeamConfig(config, cwd);

      const initial = await scaleDown('unpinned-recycled', cwd, { workerNames: ['worker-2'], force: true }, {
        OMX_TEAM_SCALING_ENABLED: '1',
      });
      assert.deepEqual(initial, {
        ok: false,
        error: 'scale_down_cleanup_debt:pane_teardown_unresolved:%405',
      });
      const debtPath = join(cwd, '.omx', 'state', 'team', 'unpinned-recycled', '.scale-down-cleanup-debt.json');
      const initialDebt = JSON.parse(await readFile(debtPath, 'utf8')) as {
        unresolved_panes: Array<{ name: string; index: number; pane_id: string; pid: number | null }>;
        reasons: string[];
      };
      assert.deepEqual(initialDebt.unresolved_panes, [{ name: 'worker-2', index: 2, pane_id: '%405', pid: null }]);
      assert.ok(initialDebt.reasons.includes('%405:legacy_pid_missing_live'));

      const canonical = await readTeamConfig('unpinned-recycled', cwd);
      assert.ok(canonical);
      if (!canonical) return;
      assert.deepEqual(await reconcileScaleDownCleanupDebt('unpinned-recycled', cwd, canonical), {
        ok: false,
        error: 'scale_down_cleanup_debt_unresolved:%405',
      });
      const reconciledDebt = JSON.parse(await readFile(debtPath, 'utf8')) as { reasons: string[] };
      assert.ok(reconciledDebt.reasons.includes('%405:legacy_pid_missing_live'));
      const commands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.deepEqual(commands, [
        'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
        'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
      ]);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('scaleDown never targets leader or hud panes during teardown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-exclusions-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-fake-tmux-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  show-option) echo 'team:scale-down' ;;
  list-panes)
    case "$*" in
      *"#{pane_id}\t#{pane_dead}\t#{pane_pid}"*)
        printf '%s\t%s\t%s\n' '%11' '0' '42411'
        printf '%s\t%s\t%s\n' '%12' '0' '42412'
        if [ ! -f "${tmuxLogPath}.killed-%13" ]; then printf '%s\t%s\t%s\n' '%13' '0' '42413'; fi
        printf '%s\t%s\t%s\n' '%14' '0' '42414'
        ;;
    esac
    ;;
  kill-pane)
    : > "${tmuxLogPath}.killed-$3"
    ;;
esac
exit 0
`,
      );
      await writeFile(tmuxLogPath, '');
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('exclusions', 'task', 'executor', 4, cwd);
      const config = await readTeamConfig('exclusions', cwd);
      assert.ok(config);
      if (!config) return;
      config.leader_pane_id = '%11';
      config.hud_pane_id = '%12';
      config.workers[0]!.pane_id = '%11';
      config.workers[0]!.pid = 42411;
      config.workers[1]!.pane_id = '%12';
      config.workers[1]!.pid = 42412;
      config.workers[2]!.pane_id = '%13';
      config.workers[2]!.pid = 42413;
      config.workers[3]!.pane_id = '%14';
      config.workers[3]!.pid = 42414;
      config.tmux_pane_owner_id = 'team:scale-down';
      await saveTeamConfig(config, cwd);

      const result = await scaleDown(
        'exclusions',
        cwd,
        { workerNames: ['worker-1', 'worker-2', 'worker-3'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /pane_teardown_unresolved:%11.*pane_teardown_unresolved:%12/);
      assert.deepEqual((await readTeamConfig('exclusions', cwd))?.workers.map((worker) => worker.name), ['worker-4']);

      const tmuxCommands = (await readFile(tmuxLogPath, 'utf-8')).trim().split('\n');
      assert.deepEqual(tmuxCommands, [
        'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
        'show-option -qv -p -t %13 @omx_team_pane_owner_id',
        'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
        'kill-pane -t %13',
        'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
      ]);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('scaleDown commits forward membership and retains artifacts/debt when pane ID is reused', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-kill-fail-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-kill-fail-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  show-option) echo 'team:scale-down' ;;
  list-panes)
    if [ -f "${cwd}/pane-reused" ]; then
      printf '%s\t%s\t%s\n' '%13' '0' '42414'
    else
      printf '%s\t%s\t%s\n' '%13' '0' '42413'
    fi
    ;;
  kill-pane)
    : > "${cwd}/pane-reused"
    exit 0
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('kill-fail', 'task', 'executor', 2, cwd);
      const config = await readTeamConfig('kill-fail', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[1]!.pane_id = '%13';
      config.workers[1]!.pid = 42413;
      const worktreePath = join(cwd, '.omx', 'team', 'kill-fail', 'worktrees', 'worker-2');
      await mkdir(worktreePath, { recursive: true });
      await writeFile(join(worktreePath, 'keep.txt'), 'retryable worktree');
      config.workers[1]!.worktree_path = worktreePath;
      const workerDir = join(cwd, '.omx', 'state', 'team', 'kill-fail', 'workers', 'worker-2');
      await writeFile(join(workerDir, 'identity.json'), '{"worker":"worker-2"}');
      await writeFile(join(workerDir, 'inbox.md'), 'retryable inbox');
      await mkdir(join(cwd, '.omx', 'state', 'team', 'kill-fail', 'runtime'), { recursive: true });
      const startupScriptPath = workerStartupScriptPath(cwd, 'kill-fail', 'worker-2');
      await writeFile(startupScriptPath, '#!/bin/sh\n');
      config.tmux_pane_owner_id = 'team:scale-down';
      await saveTeamConfig(config, cwd);

      const priorStatus = {
        state: 'idle' as const,
        reason: 'waiting for assignment',
        updated_at: '2026-07-14T00:00:00.000Z',
      };
      await writeWorkerStatus('kill-fail', 'worker-2', priorStatus, cwd);


      const result = await scaleDown(
        'kill-fail',
        cwd,
        { workerNames: ['worker-2'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /^scale_down_cleanup_debt:pane_teardown_failed:%13/);
      const committed = await readTeamConfig('kill-fail', cwd);
      assert.deepEqual(committed?.workers.map((worker) => worker.name), ['worker-1']);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', 'kill-fail', 'workers', 'worker-2')), true);
      assert.equal(await readFile(join(workerDir, 'identity.json'), 'utf8'), '{"worker":"worker-2"}');
      assert.equal(await readFile(join(workerDir, 'inbox.md'), 'utf8'), 'retryable inbox');
      assert.equal(await readFile(join(worktreePath, 'keep.txt'), 'utf8'), 'retryable worktree');
      assert.equal(await readFile(startupScriptPath, 'utf8'), '#!/bin/sh\n');
      assert.deepEqual(await readWorkerStatus('kill-fail', 'worker-2', cwd), priorStatus);
      const debt = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'team', 'kill-fail', '.scale-down-cleanup-debt.json'), 'utf8'));
      assert.equal(debt.status, 'unresolved');
      assert.equal(debt.unresolved_panes[0]?.pane_id, '%13');
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.deepEqual(tmuxCommands, [
        'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
        'show-option -qv -p -t %13 @omx_team_pane_owner_id',
        'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
        'kill-pane -t %13',
        'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
      ]);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
  it('aborts before pane teardown and preserves exact state when task reconciliation cannot acquire a lock', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-task-reconcile-fail-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-task-reconcile-fail-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;
    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  show-option) echo 'team:scale-down' ;;
  list-panes) printf '%s\\t%s\\t%s\\n' '%11' '0' '42411' ;;
esac
`,
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState('task-reconcile-fail', 'task', 'executor', 2, cwd);
      const config = await readTeamConfig('task-reconcile-fail', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[1]!.pane_id = '%13';
      config.workers[1]!.pid = 42413;
      config.tmux_pane_owner_id = 'team:scale-down';
      await saveTeamConfig(config, cwd);
      const firstTask = await createTask('task-reconcile-fail', {
        subject: 'first reconciliation', description: 'must be restored after later failure', status: 'pending', owner: 'worker-2',
      }, cwd);
      const firstTaskPath = join(cwd, '.omx', 'state', 'team', 'task-reconcile-fail', 'tasks', `task-${firstTask.id}.json`);
      const firstTaskRaw = await readFile(firstTaskPath, 'utf-8');
      const task = await createTask('task-reconcile-fail', {
        subject: 'locked reconciliation', description: 'must remain exact', status: 'pending', owner: 'worker-2',
      }, cwd);
      const taskPath = join(cwd, '.omx', 'state', 'team', 'task-reconcile-fail', 'tasks', `task-${task.id}.json`);
      const taskRaw = await readFile(taskPath, 'utf-8');
      const priorConfig = structuredClone(await readTeamConfig('task-reconcile-fail', cwd));
      await mkdir(join(cwd, '.omx', 'state', 'team', 'task-reconcile-fail', 'claims', `task-${task.id}.lock`));

      const result = await scaleDown(
        'task-reconcile-fail',
        cwd,
        { workerNames: ['worker-2'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );

      assert.deepEqual(result, { ok: false, error: 'scale_down_task_reconciliation_failed:Error: Timed out acquiring task claim lock for task-reconcile-fail/2' });
      assert.deepEqual(await readTeamConfig('task-reconcile-fail', cwd), priorConfig);
      assert.equal(await readFile(taskPath, 'utf-8'), taskRaw);
      assert.equal(await readFile(firstTaskPath, 'utf-8'), firstTaskRaw);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', 'task-reconcile-fail', 'workers', 'worker-2')), true);
      assert.deepEqual(await readScaleUpTmuxLogCommands(tmuxLogPath), []);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
  it('commits forward membership and durable debt when scale-down pane proof is unavailable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-proof-unavailable-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-proof-unavailable-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(tmuxStubPath, '#!/bin/sh\n[ "$1" = list-panes ] && exit 1\nexit 0\n');
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState('proof-unavailable', 'task', 'executor', 2, cwd);
      const config = await readTeamConfig('proof-unavailable', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[1]!.pane_id = '%13';
      config.workers[1]!.pid = 42413;
      config.tmux_pane_owner_id = 'team:scale-down';
      await saveTeamConfig(config, cwd);
      const task = await createTask('proof-unavailable', {
        subject: 'preserved', description: 'exact proof is unavailable', status: 'pending', owner: 'worker-2',
      }, cwd);
      const statusPath = join(cwd, '.omx', 'state', 'team', 'proof-unavailable', 'workers', 'worker-2', 'status.json');
      const statusRaw = '{"state":"idle", "reason":"preserve bytes", "updated_at":"2026-07-14T00:00:00.000Z"}\n';
      await writeFile(statusPath, statusRaw);
      const result = await scaleDown('proof-unavailable', cwd, { workerNames: ['worker-2'], force: true }, {
        OMX_TEAM_SCALING_ENABLED: '1',
      });
      assert.equal(result.ok, false);
      assert.deepEqual((await readTeamConfig('proof-unavailable', cwd))?.workers.map((worker) => worker.name), ['worker-1']);
      assert.equal((await readTask('proof-unavailable', task.id, cwd))?.owner, undefined);
      assert.equal(await readFile(statusPath, 'utf8'), statusRaw);
      const debt = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'team', 'proof-unavailable', '.scale-down-cleanup-debt.json'), 'utf8'));
      assert.equal(debt.status, 'unresolved');
      assert.equal(debt.unresolved_panes[0]?.pane_id, '%13');
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('converges entirely old or entirely new after a mid-commit scale-down interruption', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-atomic-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-atomic-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(tmuxStubPath, `#!/bin/sh
marker="${tmuxStubPath}.killed"
if [ "$1" = list-panes ]; then
  [ -f "$marker" ] || printf '%s\t%s\t%s\n' '%13' '0' '42413'
  exit 0
fi
if [ "$1" = kill-pane ]; then : > "$marker"; exit 0; fi
exit 0
`);
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState('atomic-down', 'task', 'executor', 2, cwd);
      const config = await readTeamConfig('atomic-down', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[1]!.pane_id = '%13';
      config.workers[1]!.pid = 42413;
      config.tmux_pane_owner_id = 'team:scale-down';
      await saveTeamConfig(config, cwd);
      const first = await createTask('atomic-down', { subject: 'first', description: 'first', status: 'pending', owner: 'worker-2' }, cwd);
      const second = await createTask('atomic-down', { subject: 'second', description: 'second', status: 'pending', owner: 'worker-2' }, cwd);
      const result = await scaleDown('atomic-down', cwd, { workerNames: ['worker-2'], force: true }, {
        OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SCALE_DOWN_INJECT_FAILURE: 'after-first-task-write',
      });
      assert.match(result.ok ? '' : result.error, /injected_scale_down_interruption:after-first-task-write/);
      await recoverTeamMembershipTaskTransaction('atomic-down', cwd);
      const recoveredConfig = await readTeamConfig('atomic-down', cwd);
      const recoveredFirst = await readTask('atomic-down', first.id, cwd);
      const recoveredSecond = await readTask('atomic-down', second.id, cwd);
      const convergedOld = recoveredConfig?.workers.some((worker) => worker.name === 'worker-2') === true
        && recoveredFirst?.owner === 'worker-2'
        && recoveredSecond?.owner === 'worker-2';
      const convergedNew = recoveredConfig?.workers.some((worker) => worker.name === 'worker-2') === false
        && recoveredFirst?.owner === undefined
        && recoveredSecond?.owner === undefined;
      assert.equal(convergedOld || convergedNew, true);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('recovers rollback-persistence failure through public config reads with config, manifest, and tasks converged', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-rollback-recovery-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-rollback-recovery-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(tmuxStubPath, `#!/bin/sh
marker="${tmuxStubPath}.killed"
if [ "$1" = list-panes ]; then
  [ -f "$marker" ] || printf '%s\t%s\t%s\n' '%13' '0' '42413'
  exit 0
fi
if [ "$1" = kill-pane ]; then : > "$marker"; exit 0; fi
exit 0
`);
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState('rollback-recovery', 'task', 'executor', 2, cwd);
      const config = await readTeamConfig('rollback-recovery', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[1]!.pane_id = '%13';
      config.workers[1]!.pid = 42413;
      config.tmux_pane_owner_id = 'team:scale-down';
      await saveTeamConfig(config, cwd);
      const task = await createTask('rollback-recovery', { subject: 'owned', description: 'owned', status: 'pending', owner: 'worker-2' }, cwd);
      const failed = await scaleDown('rollback-recovery', cwd, { workerNames: ['worker-2'], force: true }, {
        OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SCALE_DOWN_INJECT_FAILURE: 'rollback-persistence-failure',
      });
      assert.match(failed.ok ? '' : failed.error, /rollback-persistence-failure/);
      const recoveredConfig = await readTeamConfig('rollback-recovery', cwd);
      const recoveredManifest = await readTeamManifestV2('rollback-recovery', cwd);
      const recoveredTask = await readTask('rollback-recovery', task.id, cwd);
      assert.equal(recoveredConfig?.workers.some((worker) => worker.name === 'worker-2'), false);
      assert.equal(recoveredManifest?.workers.some((worker) => worker.name === 'worker-2'), false);
      assert.equal(recoveredTask?.owner, undefined);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  for (const target of ['config', 'manifest'] as const) {
    it(`publicly recovers a committed scale-up membership rollback after partial ${target} old-generation persistence`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), `omx-scale-up-rollback-${target}-`));
      try {
        const teamName = `rollback-${target}`;
        await initTeamState(teamName, 'task', 'executor', 2, cwd);
        const task = await createTask(teamName, {
          subject: 'rollback owner', description: 'must converge with membership', status: 'pending', owner: 'worker-2',
        }, cwd);
        const teamDir = join(cwd, '.omx', 'state', 'team', teamName);
        const configPath = join(teamDir, 'config.json');
        const manifestPath = join(teamDir, 'manifest.v2.json');
        const taskPath = join(teamDir, 'tasks', `task-${task.id}.json`);
        const oldConfig = await readFile(configPath, 'utf8');
        const oldManifest = await readFile(manifestPath, 'utf8');
        const oldTask = await readFile(taskPath, 'utf8');
        const oldConfigValue = JSON.parse(oldConfig) as { workers: Array<{ name: string }> };
        const nextConfig = { ...oldConfigValue, workers: oldConfigValue.workers.filter((worker) => worker.name !== 'worker-2') };
        const nextManifest = { ...JSON.parse(oldManifest) as object, workers: nextConfig.workers, worker_count: nextConfig.workers.length };
        const nextTask = { ...JSON.parse(oldTask) as object, owner: undefined, claim: undefined };
        await assert.rejects(
          withTeamTaskBarrier(teamName, cwd, () => commitTeamMembershipTaskTransaction(teamName, cwd, {
            baseGeneration: 0,
            tasks: [{ taskId: task.id, oldBytes: oldTask, newBytes: JSON.stringify(nextTask, null, 2) }],
            config: { oldBytes: oldConfig, newBytes: JSON.stringify(nextConfig, null, 2) },
            manifest: { oldBytes: oldManifest, newBytes: JSON.stringify(nextManifest, null, 2) },
            recoverToNewOnFailure: true,
            failRollbackPersistenceAfter: target,
          })),
          /rollback-persistence-failure/,
        );
        assert.equal(existsSync(join(teamDir, '.membership-task-transaction.json')), true);
        await recoverTeamMembershipTaskTransaction(teamName, cwd);
        assert.equal((await readTeamConfig(teamName, cwd))?.workers.some((worker) => worker.name === 'worker-2'), false);
        assert.equal((await readTeamManifestV2(teamName, cwd))?.workers.some((worker) => worker.name === 'worker-2'), false);
        assert.equal((await readTask(teamName, task.id, cwd))?.owner, undefined);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }

  it('discards precommit cleanup debt while removed workers remain canonical', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-precommit-debt-'));
    try {
      await initTeamState('precommit-debt', 'task', 'executor', 2, cwd);
      const config = await readTeamConfig('precommit-debt', cwd);
      assert.ok(config);
      if (!config) return;
      const debtPath = join(cwd, '.omx', 'state', 'team', 'precommit-debt', '.scale-down-cleanup-debt.json');
      await writeFile(debtPath, JSON.stringify({
        schema_version: 1,
        operation: 'scale_down',
        status: 'pending_teardown',
        removed_worker_names: ['worker-2'],
        workers: [{ name: 'worker-2', index: 2, pane_id: '%13', pid: 42413 }],
        resource_workers: [{ name: 'worker-2' }],
      }));

      const recovered = await reconcileScaleDownCleanupDebt('precommit-debt', cwd, config);
      assert.deepEqual(recovered, { ok: true });
      assert.equal(existsSync(debtPath), false);
      assert.equal((await readTeamConfig('precommit-debt', cwd))?.workers.some((worker) => worker.name === 'worker-2'), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('commits forward state and records unresolved debt when proof is lost after a pane kill', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-success-proof-loss-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-success-proof-loss-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const proofLossMarkerPath = join(fakeBinDir, 'proof-loss');
    const previousPath = process.env.PATH;
    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  show-option) echo 'team:scale-down' ;;
  list-panes)
    if [ -f "${proofLossMarkerPath}.recovery" ]; then
      if [ ! -f "${proofLossMarkerPath}.killed-13" ]; then printf '%s\t%s\t%s\n' '%13' '0' '42413'; fi
      if [ ! -f "${proofLossMarkerPath}.killed-14" ]; then printf '%s\t%s\t%s\n' '%14' '0' '42414'; fi
    else
      if [ -f "${proofLossMarkerPath}.killed" ]; then exit 1; fi
      printf '%s\t%s\t%s\n' '%13' '0' '42413'
      printf '%s\t%s\t%s\n' '%14' '0' '42414'
    fi
    ;;
  show-option) printf '%s\n' 'team:success-proof-loss' ;;
  kill-pane)
    if [ -f "${proofLossMarkerPath}.recovery" ]; then
      if [ "$3" = '%13' ]; then : > "${proofLossMarkerPath}.killed-13"; fi
      if [ "$3" = '%14' ]; then : > "${proofLossMarkerPath}.killed-14"; fi
    elif [ "$3" = '%13' ]; then
      : > "${proofLossMarkerPath}.killed"
    fi
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState('success-proof-loss', 'task', 'executor', 3, cwd);
      const config = await readTeamConfig('success-proof-loss', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[1]!.pane_id = '%13';
      config.workers[1]!.pid = 42413;
      config.workers[2]!.pane_id = '%14';
      config.workers[2]!.pid = 42414;
      config.tmux_pane_owner_id = 'team:scale-down';
      await saveTeamConfig(config, cwd);
      await writeFile(
        join(cwd, '.omx', 'state', 'team', 'success-proof-loss', 'workers', 'worker-2', 'identity.json'),
        JSON.stringify({ name: 'worker-2', index: 2, pane_id: '%13', pid: 42413 }),
      );
      await writeFile(
        join(cwd, '.omx', 'state', 'team', 'success-proof-loss', 'workers', 'worker-3', 'identity.json'),
        JSON.stringify({ name: 'worker-3', index: 3, pane_id: '%14', pid: 42414 }),
      );
      const resolvedTask = await createTask('success-proof-loss', {
        subject: 'resolved owner task', description: 'must be reclaimed', status: 'pending', owner: 'worker-2',
      }, cwd);
      const unresolvedTask = await createTask('success-proof-loss', {
        subject: 'unresolved owner task', description: 'must be preserved', status: 'pending', owner: 'worker-3',
      }, cwd);
      const resolvedClaim = await claimTask('success-proof-loss', resolvedTask.id, 'worker-2', resolvedTask.version ?? 1, cwd);
      assert.equal(resolvedClaim.ok, true);
      const worker3StatusPath = join(cwd, '.omx', 'state', 'team', 'success-proof-loss', 'workers', 'worker-3', 'status.json');
      const worker3Raw = '{"reason":"three",\n"updated_at":"2026-07-14T00:00:01.000Z", "state":"idle"}\n';
      await writeFile(worker3StatusPath, worker3Raw);

      const result = await scaleDown(
        'success-proof-loss',
        cwd,
        { workerNames: ['worker-2', 'worker-3'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );

      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /^scale_down_pane_proof_unavailable:%13:query_failed/);
      assert.deepEqual((await readTeamConfig('success-proof-loss', cwd))?.workers.map((worker) => worker.name), ['worker-1']);
      assert.equal(existsSync(worker3StatusPath), true);
      assert.equal(await readFile(worker3StatusPath, 'utf8'), worker3Raw);
      assert.equal((await readTask('success-proof-loss', resolvedTask.id, cwd))?.owner, undefined);
      assert.equal((await readTask('success-proof-loss', unresolvedTask.id, cwd))?.owner, undefined);
      const retainedTask = await readTask('success-proof-loss', resolvedTask.id, cwd);
      assert.equal(retainedTask?.status, 'pending');
      assert.equal(retainedTask?.claim, undefined);
      const debt = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'team', 'success-proof-loss', '.scale-down-cleanup-debt.json'), 'utf8'));
      assert.deepEqual(debt.unresolved_panes.map((pane: { pane_id: string }) => pane.pane_id), ['%13', '%14']);
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.deepEqual(tmuxCommands.filter((command) => command.startsWith('kill-pane ')), ['kill-pane -t %13']);
      const killIndex = tmuxCommands.indexOf('kill-pane -t %13');
      assert.ok(killIndex > 2);
      assert.equal(tmuxCommands[killIndex - 3], 'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}');
      assert.equal(tmuxCommands[killIndex - 2], 'show-option -qv -p -t %13 @omx_team_pane_owner_id');
      assert.equal(tmuxCommands[killIndex - 1], 'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}');
      assert.equal(tmuxCommands[killIndex + 1], 'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}');
      await writeFile(`${proofLossMarkerPath}.recovery`, '1');
      await rm(`${proofLossMarkerPath}.killed`, { force: true });
      const committedConfig = await readTeamConfig('success-proof-loss', cwd);
      assert.ok(committedConfig);
      if (!committedConfig) return;
      const recovered = await reconcileScaleDownCleanupDebt('success-proof-loss', cwd, committedConfig);
      assert.deepEqual(recovered, { ok: true });
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', 'success-proof-loss', '.scale-down-cleanup-debt.json')), false);
      const recoveredCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.deepEqual(recoveredCommands.filter((command) => command.startsWith('kill-pane ')), [
        'kill-pane -t %13',
        'kill-pane -t %13',
        'kill-pane -t %14',
      ]);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('commits forward membership and retains exact debt when a later pane teardown fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-gone-kill-fail-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-gone-kill-fail-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;
    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  show-option) echo 'team:scale-down' ;;
  list-panes)
    if [ -f "${tmuxLogPath}.killed-%13" ]; then
      printf '%s\t%s\t%s\n' '%14' '0' '42414'
    else
      printf '%s\t%s\t%s\n' '%13' '0' '42413'
      printf '%s\t%s\t%s\n' '%14' '0' '42414'
    fi
    ;;
  kill-pane)
    if [ "$3" = '%13' ]; then : > "${tmuxLogPath}.killed-%13"; exit 0; fi
    exit 1
    ;;
esac
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState('gone-kill-fail', 'task', 'executor', 3, cwd);
      const config = await readTeamConfig('gone-kill-fail', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[1]!.pane_id = '%13';
      config.workers[1]!.pid = 42413;
      config.workers[2]!.pane_id = '%14';
      config.workers[2]!.pid = 42414;
      config.tmux_pane_owner_id = 'team:scale-down';
      await saveTeamConfig(config, cwd);
      const resolvedTask = await createTask('gone-kill-fail', {
        subject: 'gone owner task', description: 'must be reclaimed', status: 'pending', owner: 'worker-2',
      }, cwd);
      const unresolvedTask = await createTask('gone-kill-fail', {
        subject: 'failed owner task', description: 'must be preserved', status: 'pending', owner: 'worker-3',
      }, cwd);
      const resolvedClaim = await claimTask('gone-kill-fail', resolvedTask.id, 'worker-2', resolvedTask.version ?? 1, cwd);
      assert.equal(resolvedClaim.ok, true);
      const worker3StatusPath = join(cwd, '.omx', 'state', 'team', 'gone-kill-fail', 'workers', 'worker-3', 'status.json');
      await writeFile(worker3StatusPath, '{\n "state" : "idle", "reason":"three", "updated_at":"2026-07-14T00:00:01.000Z"\n}\n');

      const result = await scaleDown(
        'gone-kill-fail',
        cwd,
        { workerNames: ['worker-2', 'worker-3'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );

      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /^scale_down_cleanup_debt:pane_teardown_failed:%14/);
      assert.deepEqual((await readTeamConfig('gone-kill-fail', cwd))?.workers.map((worker) => worker.name), ['worker-1']);
      assert.equal(existsSync(worker3StatusPath), true);
      assert.equal(await readFile(worker3StatusPath, 'utf8'), '{\n "state" : "idle", "reason":"three", "updated_at":"2026-07-14T00:00:01.000Z"\n}\n');
      assert.equal((await readTask('gone-kill-fail', resolvedTask.id, cwd))?.owner, undefined);
      assert.equal((await readTask('gone-kill-fail', unresolvedTask.id, cwd))?.owner, undefined);
      const retainedTask = await readTask('gone-kill-fail', resolvedTask.id, cwd);
      assert.equal(retainedTask?.status, 'pending');
      assert.equal(retainedTask?.claim, undefined);
      const debt = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'team', 'gone-kill-fail', '.scale-down-cleanup-debt.json'), 'utf8'));
      assert.deepEqual(debt.unresolved_panes.map((pane: { pane_id: string }) => pane.pane_id), ['%14']);
      assert.deepEqual(await readScaleUpTmuxLogCommands(tmuxLogPath), [
        'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
        'show-option -qv -p -t %13 @omx_team_pane_owner_id',
        'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
        'kill-pane -t %13',
        'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
        'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
        'show-option -qv -p -t %14 @omx_team_pane_owner_id',
        'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
        'kill-pane -t %14',
      ]);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
  for (const [name, priorRaw] of [
    ['absent status artifact', undefined],
    ['malformed status artifact', '{"state":\n'],
    ['noncanonical valid status artifact', '{\n  "updated_at" : "2026-07-14T00:00:00.000Z",\n "reason":"waiting for assignment", "state" : "idle"\n}\n'],
  ] as const) {
    it(`scaleDown restores the exact ${name} after kill-pane failure`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-status-artifact-'));
      const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-status-artifact-bin-'));
      const tmuxStubPath = join(fakeBinDir, 'tmux');
      const previousPath = process.env.PATH;
      try {
        await writeFile(
          tmuxStubPath,
          `#!/bin/sh
case "\${1:-}" in
  show-option) echo 'team:scale-down' ;;
  list-panes) printf '%s\\t%s\\t%s\\n' '%13' '0' '42413' ;;
  kill-pane) exit 1 ;;
esac
`,
        );
        await chmod(tmuxStubPath, 0o755);
        process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
        await initTeamState(`status-${name.startsWith('absent') ? 'absent' : 'malformed'}`, 'task', 'executor', 2, cwd);
        const teamName = `status-${name.startsWith('absent') ? 'absent' : 'malformed'}`;
        const config = await readTeamConfig(teamName, cwd);
        assert.ok(config);
        if (!config) return;
        config.workers[1]!.pane_id = '%13';
        config.workers[1]!.pid = 42413;
        config.tmux_pane_owner_id = 'team:scale-down';
      await saveTeamConfig(config, cwd);
        const statusPath = join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2', 'status.json');
        if (priorRaw === undefined) {
          await rm(statusPath, { force: true });
        } else {
          await writeFile(statusPath, priorRaw);
        }

        const result = await scaleDown(
          teamName,
          cwd,
          { workerNames: ['worker-2'], force: true },
          { OMX_TEAM_SCALING_ENABLED: '1' },
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.error, /^scale_down_cleanup_debt:pane_teardown_failed:%13/);
        assert.equal(existsSync(statusPath), priorRaw !== undefined);
        if (priorRaw !== undefined) assert.equal(await readFile(statusPath, 'utf8'), priorRaw);
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        await rm(cwd, { recursive: true, force: true });
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    });
  }
  it('uses canonical membership rather than a stale caller config before consuming precommit debt', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-canonical-debt-'));
    try {
      await initTeamState('canonical-debt', 'task', 'executor', 2, cwd);
      const canonical = await readTeamConfig('canonical-debt', cwd);
      assert.ok(canonical);
      if (!canonical) return;
      const staleCaller = structuredClone(canonical);
      staleCaller.workers = staleCaller.workers.filter((worker) => worker.name !== 'worker-2');
      staleCaller.worker_count = staleCaller.workers.length;
      const workerDir = join(cwd, '.omx', 'state', 'team', 'canonical-debt', 'workers', 'worker-2');
      const sentinelPath = join(workerDir, 'caller-must-not-authorize');
      await writeFile(sentinelPath, 'preserve');
      const debtPath = join(cwd, '.omx', 'state', 'team', 'canonical-debt', '.scale-down-cleanup-debt.json');
      await writeFile(debtPath, JSON.stringify({
        schema_version: 1,
        operation: 'scale_down',
        status: 'pending_teardown',
        removed_worker_names: ['worker-2'],
        workers: [{ name: 'worker-2', index: 2, pane_id: '%13', pid: 42413 }],
        resource_workers: [{ name: 'worker-2' }],
      }));

      assert.deepEqual(await reconcileScaleDownCleanupDebt('canonical-debt', cwd, staleCaller), { ok: true });
      assert.equal(existsSync(debtPath), false);
      assert.equal(await readFile(sentinelPath, 'utf8'), 'preserve');
      assert.equal((await readTeamConfig('canonical-debt', cwd))?.workers.some((worker) => worker.name === 'worker-2'), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('converges pane-less crash debt through worker status and directory cleanup', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-zero-pane-debt-'));
    try {
      await initTeamState('zero-pane-debt', 'task', 'executor', 2, cwd);
      const config = await readTeamConfig('zero-pane-debt', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers = config.workers.filter((worker) => worker.name !== 'worker-2');
      config.worker_count = config.workers.length;
      config.tmux_pane_owner_id = 'team:scale-down';
      await saveTeamConfig(config, cwd);
      const workerDir = join(cwd, '.omx', 'state', 'team', 'zero-pane-debt', 'workers', 'worker-2');
      await mkdir(workerDir, { recursive: true });
      await writeFile(join(workerDir, 'status.json'), '{"state":"draining"}');
      const debtPath = join(cwd, '.omx', 'state', 'team', 'zero-pane-debt', '.scale-down-cleanup-debt.json');
      await writeFile(debtPath, JSON.stringify({
        schema_version: 1,
        operation: 'scale_down',
        status: 'resource_cleanup_pending',
        removed_worker_names: ['worker-2'],
        workers: [],
        resource_workers: [{ name: 'worker-2' }],
      }));

      assert.deepEqual(await reconcileScaleDownCleanupDebt('zero-pane-debt', cwd, config), { ok: true });
      assert.equal(existsSync(workerDir), false);
      assert.equal(existsSync(debtPath), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('converges resource debt after a crash following successful worktree cleanup', async () => {
    const repo = await initRepo();
    try {
      await initTeamState('resource-retry', 'task', 'executor', 2, repo);
      const config = await readTeamConfig('resource-retry', repo);
      assert.ok(config);
      if (!config) return;
      config.workers = config.workers.filter((worker) => worker.name !== 'worker-2');
      config.worker_count = config.workers.length;
      await saveTeamConfig(config, repo);
      const worktreePath = join(repo, '.omx', 'team', 'resource-retry', 'worktrees', 'worker-2');
      const workerDir = join(repo, '.omx', 'state', 'team', 'resource-retry', 'workers', 'worker-2');
      await mkdir(workerDir, { recursive: true });
      execFileSync('git', ['worktree', 'add', '--detach', worktreePath], { cwd: repo, stdio: 'ignore' });
      const debtPath = join(repo, '.omx', 'state', 'team', 'resource-retry', '.scale-down-cleanup-debt.json');
      await writeFile(debtPath, JSON.stringify({
        schema_version: 1,
        operation: 'scale_down',
        status: 'resource_cleanup_pending',
        removed_worker_names: ['worker-2'],
        workers: [],
        resource_workers: [{
          name: 'worker-2', worktree_path: worktreePath, worktree_repo_root: repo,
          worktree_detached: true, worktree_created: true,
        }],
      }));

      // Simulate a crash after git worktree removal but before worker-state
      // cleanup and debt deletion. The retry must treat the exact absent target
      // as converged rather than attempting to remove a replacement.
      execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repo, stdio: 'ignore' });
      assert.equal(existsSync(worktreePath), false);
      assert.equal(existsSync(workerDir), true);

      assert.deepEqual(await reconcileScaleDownCleanupDebt('resource-retry', repo, config), { ok: true });
      assert.equal(existsSync(worktreePath), false);
      assert.equal(existsSync(workerDir), false);
      assert.equal(existsSync(debtPath), false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects malformed worktree debt without mutating worker resources', async () => {
    const repo = await initRepo();
    try {
      await initTeamState('malformed-resource-debt', 'task', 'executor', 2, repo);
      const config = await readTeamConfig('malformed-resource-debt', repo);
      assert.ok(config);
      if (!config) return;
      config.workers = config.workers.filter((worker) => worker.name !== 'worker-2');
      config.worker_count = config.workers.length;
      await saveTeamConfig(config, repo);
      const workerDir = join(repo, '.omx', 'state', 'team', 'malformed-resource-debt', 'workers', 'worker-2');
      const sentinelPath = join(workerDir, 'sentinel');
      await mkdir(workerDir, { recursive: true });
      await writeFile(sentinelPath, 'preserve');
      const debtPath = join(repo, '.omx', 'state', 'team', 'malformed-resource-debt', '.scale-down-cleanup-debt.json');
      await writeFile(debtPath, JSON.stringify({
        schema_version: 1,
        operation: 'scale_down',
        status: 'resource_cleanup_pending',
        removed_worker_names: ['worker-2'],
        workers: [],
        resource_workers: [{
          name: 'worker-2',
          worktree_path: join(repo, '.omx', 'team', 'malformed-resource-debt', 'worktrees', '..', 'worker-2'),
          worktree_repo_root: repo,
          worktree_detached: true,
          worktree_created: true,
        }],
      }));

      assert.deepEqual(await reconcileScaleDownCleanupDebt('malformed-resource-debt', repo, config), {
        ok: false,
        error: 'scale_down_cleanup_debt_malformed',
      });
      assert.equal(await readFile(sentinelPath, 'utf8'), 'preserve');
      assert.equal(existsSync(debtPath), true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects foreign worktree debt without mutating the foreign location', async () => {
    const repo = await initRepo();
    const foreign = await mkdtemp(join(tmpdir(), 'omx-scale-down-foreign-'));
    try {
      await initTeamState('foreign-resource-debt', 'task', 'executor', 2, repo);
      const config = await readTeamConfig('foreign-resource-debt', repo);
      assert.ok(config);
      if (!config) return;
      config.workers = config.workers.filter((worker) => worker.name !== 'worker-2');
      config.worker_count = config.workers.length;
      await saveTeamConfig(config, repo);
      const sentinelPath = join(foreign, 'AGENTS.md');
      await writeFile(sentinelPath, 'foreign');
      const debtPath = join(repo, '.omx', 'state', 'team', 'foreign-resource-debt', '.scale-down-cleanup-debt.json');
      await writeFile(debtPath, JSON.stringify({
        schema_version: 1,
        operation: 'scale_down',
        status: 'resource_cleanup_pending',
        removed_worker_names: ['worker-2'],
        workers: [],
        resource_workers: [{
          name: 'worker-2', worktree_path: foreign, worktree_repo_root: repo,
          worktree_detached: true, worktree_created: true,
        }],
      }));

      assert.deepEqual(await reconcileScaleDownCleanupDebt('foreign-resource-debt', repo, config), {
        ok: false,
        error: 'scale_down_cleanup_debt_malformed',
      });
      assert.equal(await readFile(sentinelPath, 'utf8'), 'foreign');
      assert.equal(existsSync(debtPath), true);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(foreign, { recursive: true, force: true });
    }
  });

  it('rejects symlink-parent worktree debt without mutating the linked location', async () => {
    const repo = await initRepo();
    const foreign = await mkdtemp(join(tmpdir(), 'omx-scale-down-symlink-'));
    try {
      await initTeamState('symlink-resource-debt', 'task', 'executor', 2, repo);
      const config = await readTeamConfig('symlink-resource-debt', repo);
      assert.ok(config);
      if (!config) return;
      config.workers = config.workers.filter((worker) => worker.name !== 'worker-2');
      config.worker_count = config.workers.length;
      await saveTeamConfig(config, repo);
      const expectedWorktreeRoot = join(repo, '.omx', 'team', 'symlink-resource-debt', 'worktrees');
      await mkdir(join(repo, '.omx', 'team', 'symlink-resource-debt'), { recursive: true });
      await symlink(foreign, expectedWorktreeRoot);
      const sentinelPath = join(foreign, 'AGENTS.md');
      await writeFile(sentinelPath, 'foreign');
      const debtPath = join(repo, '.omx', 'state', 'team', 'symlink-resource-debt', '.scale-down-cleanup-debt.json');
      await writeFile(debtPath, JSON.stringify({
        schema_version: 1,
        operation: 'scale_down',
        status: 'resource_cleanup_pending',
        removed_worker_names: ['worker-2'],
        workers: [],
        resource_workers: [{
          name: 'worker-2', worktree_path: join(expectedWorktreeRoot, 'worker-2'), worktree_repo_root: repo,
          worktree_detached: true, worktree_created: true,
        }],
      }));

      assert.deepEqual(await reconcileScaleDownCleanupDebt('symlink-resource-debt', repo, config), {
        ok: false,
        error: 'scale_down_cleanup_debt_malformed',
      });
      assert.equal(await readFile(sentinelPath, 'utf8'), 'foreign');
      assert.equal(existsSync(debtPath), true);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(foreign, { recursive: true, force: true });
    }
  });
  it('rejects cleanup debt that collides with a surviving canonical worker before any tmux effect', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-debt-survivor-collision-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-debt-survivor-collision-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;
    try {
      await writeFile(tmuxStubPath, `#!/bin/sh
printf '%s\\n' "$*" >> "${tmuxLogPath}"
exit 99
`);
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState('debt-survivor-collision', 'task', 'executor', 3, cwd);
      const config = await readTeamConfig('debt-survivor-collision', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[0]!.pane_id = '%13';
      config.workers[0]!.pid = 42413;
      config.workers = config.workers.filter((worker) => worker.name !== 'worker-2' && worker.name !== 'worker-3');
      config.worker_count = config.workers.length;
      config.tmux_pane_owner_id = 'team:scale-down';
      await saveTeamConfig(config, cwd);
      const debtPath = join(cwd, '.omx', 'state', 'team', 'debt-survivor-collision', '.scale-down-cleanup-debt.json');
      const debt = {
        schema_version: 1,
        operation: 'scale_down',
        status: 'pending_teardown',
        removed_worker_names: ['worker-2', 'worker-3'],
        workers: [
          { name: 'worker-2', index: 2, pane_id: '%13', pid: 42414 },
          { name: 'worker-3', index: 3, pane_id: '%14', pid: 42413 },
        ],
        resource_workers: [{ name: 'worker-2' }, { name: 'worker-3' }],
      };
      await writeFile(debtPath, JSON.stringify(debt));

      assert.deepEqual(await reconcileScaleDownCleanupDebt('debt-survivor-collision', cwd, config), {
        ok: false,
        error: 'scale_down_cleanup_debt_malformed',
      });
      assert.deepEqual(JSON.parse(await readFile(debtPath, 'utf8')), debt);
      assert.equal(existsSync(tmuxLogPath), false);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  for (const [name, livePid, ownerMode, expectedReason] of [
    ['refuses an unrelated current pane occupant', 42413, 'foreign', 'team_owner_mismatch'],
    ['refuses a PID-reused pane even with the Team owner tag', 52413, 'team', 'pane_pid_changed'],
    ['fails closed when Team owner authorization is unavailable', 42413, 'unavailable', 'team_owner_unavailable'],
  ] as const) {
    it(name, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-debt-pane-authority-'));
      const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-debt-pane-authority-bin-'));
      const tmuxStubPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(fakeBinDir, 'tmux.log');
      const previousPath = process.env.PATH;
      try {
        const ownerScript = ownerMode === 'unavailable'
          ? 'echo owner-query-failed >&2; exit 2'
          : `printf '%s\\n' '${ownerMode === 'team' ? 'team:debt-pane-authority' : 'team:another-team'}'`;
        await writeFile(tmuxStubPath, `#!/bin/sh
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  list-panes) printf '%s\\t%s\\t%s\\n' '%13' '0' '${livePid}' ;;
  show-option) ${ownerScript} ;;
  kill-pane) echo unexpected-kill >&2; exit 99 ;;
esac
`);
        await chmod(tmuxStubPath, 0o755);
        process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
        await initTeamState('debt-pane-authority', 'task', 'executor', 2, cwd);
        const config = await readTeamConfig('debt-pane-authority', cwd);
        assert.ok(config);
        if (!config) return;
        config.workers = config.workers.filter((worker) => worker.name !== 'worker-2');
        config.worker_count = config.workers.length;
        config.tmux_pane_owner_id = 'team:scale-down';
      await saveTeamConfig(config, cwd);
        await writeFile(
          join(cwd, '.omx', 'state', 'team', 'debt-pane-authority', 'workers', 'worker-2', 'identity.json'),
          JSON.stringify({ name: 'worker-2', index: 2, pane_id: '%13', pid: 42413 }),
        );
        const debtPath = join(cwd, '.omx', 'state', 'team', 'debt-pane-authority', '.scale-down-cleanup-debt.json');
        await writeFile(debtPath, JSON.stringify({
          schema_version: 1, operation: 'scale_down', status: 'pending_teardown',
          removed_worker_names: ['worker-2'],
          workers: [{ name: 'worker-2', index: 2, pane_id: '%13', pid: 42413 }],
          resource_workers: [{ name: 'worker-2' }],
        }));

        assert.deepEqual(await reconcileScaleDownCleanupDebt('debt-pane-authority', cwd, config), {
          ok: false, error: 'scale_down_cleanup_debt_unresolved:%13',
        });
        const debt = JSON.parse(await readFile(debtPath, 'utf8')) as { reasons: string[] };
        assert.ok(debt.reasons.includes(`%13:${expectedReason}`));
        const commands = existsSync(tmuxLogPath) ? await readFile(tmuxLogPath, 'utf8') : '';
        assert.doesNotMatch(commands, /kill-pane/);
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        await rm(cwd, { recursive: true, force: true });
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    });
  }

  it('rejects mismatched worker pane bindings before any recovery mutation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-debt-mismatched-binding-'));
    try {
      await initTeamState('debt-mismatched-binding', 'task', 'executor', 2, cwd);
      const config = await readTeamConfig('debt-mismatched-binding', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers = config.workers.filter((worker) => worker.name !== 'worker-2');
      config.worker_count = config.workers.length;
      config.tmux_pane_owner_id = 'team:scale-down';
      await saveTeamConfig(config, cwd);
      const workerDir = join(cwd, '.omx', 'state', 'team', 'debt-mismatched-binding', 'workers', 'worker-2');
      const sentinel = join(workerDir, 'must-remain');
      await writeFile(sentinel, 'preserve');
      const debtPath = join(cwd, '.omx', 'state', 'team', 'debt-mismatched-binding', '.scale-down-cleanup-debt.json');
      await writeFile(debtPath, JSON.stringify({
        schema_version: 1, operation: 'scale_down', status: 'unresolved',
        removed_worker_names: ['worker-2'],
        workers: [{ name: 'worker-2', index: 2, pane_id: '%13', pid: 42413 }],
        unresolved_panes: [{ name: 'worker-2', index: 2, pane_id: '%14', pid: 42413 }],
        resource_workers: [{ name: 'worker-2' }],
      }));
      assert.deepEqual(await reconcileScaleDownCleanupDebt('debt-mismatched-binding', cwd, config), {
        ok: false, error: 'scale_down_cleanup_debt_malformed',
      });
      assert.equal(await readFile(sentinel, 'utf8'), 'preserve');
      assert.equal(existsSync(debtPath), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('converges a PID-less legacy pane record only after a fresh global gone proof', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-debt-legacy-gone-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-debt-legacy-gone-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;
    try {
      await writeFile(tmuxStubPath, `#!/bin/sh
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in list-panes) exit 0 ;; kill-pane) exit 99 ;; esac
`);
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState('debt-legacy-gone', 'task', 'executor', 2, cwd);
      const config = await readTeamConfig('debt-legacy-gone', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers = config.workers.filter((worker) => worker.name !== 'worker-2');
      config.worker_count = config.workers.length;
      config.tmux_pane_owner_id = 'team:scale-down';
      await saveTeamConfig(config, cwd);
      const debtPath = join(cwd, '.omx', 'state', 'team', 'debt-legacy-gone', '.scale-down-cleanup-debt.json');
      await writeFile(debtPath, JSON.stringify({
        schema_version: 1, operation: 'scale_down', status: 'unresolved',
        removed_worker_names: ['worker-2'],
        workers: [{ name: 'worker-2', index: 2, pane_id: '%13', pid: null }],
        unresolved_panes: [{ name: 'worker-2', index: 2, pane_id: '%13', pid: null }],
        resource_workers: [{ name: 'worker-2' }],
      }));
      assert.deepEqual(await reconcileScaleDownCleanupDebt('debt-legacy-gone', cwd, config), { ok: true });
      assert.equal(existsSync(debtPath), false);
      assert.doesNotMatch(await readFile(tmuxLogPath, 'utf8'), /kill-pane|show-option/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
});
