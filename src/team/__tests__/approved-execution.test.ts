import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { assignTask, startTeam, resumeTeam, shutdownTeam, type TeamRuntime } from '../runtime.js';
import { scaleUp } from '../scaling.js';
import { createTask, initTeamState, readTeamConfig, readTask, saveTeamConfig } from '../state.js';
import {
  readApprovedTeamExecutionHintFromBinding,
  readBoundApprovedTeamExecutionState,
  readPersistedApprovedTeamExecutionBinding,
  readPersistedApprovedTeamExecutionHint,
  resolvePersistedApprovedTeamExecutionContinuityState,
  resolveApprovedTeamExecutionHint,
  buildApprovedTeamHandoffSection,
  writePersistedApprovedTeamExecutionBinding,
} from '../approved-execution.js';
import { readContextPackDocument, writeContextPackDocument } from '../../planning/context-packs.js';

const CONTEXT_PACK_SCHEMA = 'omx-context-pack-v1';

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

function withoutTeamWorkerEnv<T>(fn: () => T): T {
  const previous = process.env.OMX_TEAM_WORKER;
  delete process.env.OMX_TEAM_WORKER;
  let restoreImmediately = true;
  const restore = () => {
    if (typeof previous === 'string') process.env.OMX_TEAM_WORKER = previous;
    else delete process.env.OMX_TEAM_WORKER;
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

async function writeRepoFile(root: string, relativePath: string, content: string): Promise<string> {
  const absolutePath = join(root, relativePath);
  await mkdir(join(absolutePath, '..'), { recursive: true });
  await writeFile(absolutePath, content, 'utf-8');
  return absolutePath;
}

function refreshContextPackBasis(packPath: string): void {
  const document = readContextPackDocument(packPath);
  assert.ok(document, `expected context pack at ${packPath}`);
  writeContextPackDocument(packPath, document, { refreshBasis: true });
}

async function writeApprovedTeamHandoffFiles(
  cwd: string,
  slug: string,
  task: string,
): Promise<{ prdPath: string; packPath: string }> {
  await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
  await mkdir(join(cwd, '.omx', 'context'), { recursive: true });
  await mkdir(join(cwd, 'docs'), { recursive: true });

  await writeRepoFile(cwd, `docs/${slug}-scope.md`, `# Scope\n\nScope context for ${slug}.\n`);
  await writeRepoFile(cwd, `docs/${slug}-build.md`, `# Build\n\nBuild context for ${slug}.\n`);
  await writeRepoFile(cwd, `docs/${slug}-verify.md`, `# Verify\n\nVerify context for ${slug}.\n`);

  const packPath = join(cwd, '.omx', 'context', `context-20260421T000000Z-${slug}.json`);
  writeContextPackDocument(packPath, {
    schema: CONTEXT_PACK_SCHEMA,
    slug,
    entries: [
      {
        label: 'scope',
        path: `docs/${slug}-scope.md`,
        roles: ['scope'],
        tags: ['scope'],
        relationPath: [
          { tag: 'plan', target: slug },
          { tag: 'bounds', target: `docs/${slug}-scope.md` },
        ],
      },
      {
        label: 'build',
        path: `docs/${slug}-build.md`,
        roles: ['build'],
        tags: ['build'],
        relationPath: [
          { tag: 'plan', target: slug },
          { tag: 'implements', target: `docs/${slug}-build.md` },
        ],
      },
      {
        label: 'verify',
        path: `docs/${slug}-verify.md`,
        roles: ['verify'],
        tags: ['verify'],
        relationPath: [
          { tag: 'plan', target: slug },
          { tag: 'verifies', target: `docs/${slug}-verify.md` },
        ],
      },
    ],
  }, { refreshBasis: true });

  const prdPath = join(cwd, '.omx', 'plans', `prd-${slug}.md`);
  await writeFile(
    prdPath,
    [
      '# Approved plan',
      '',
      '## Context Pack Outcome',
      `- pack: created \`.omx/context/context-20260421T000000Z-${slug}.json\``,
      '',
      `Launch via omx team 1:executor ${JSON.stringify(task)}`,
    ].join('\n'),
    'utf-8',
  );
  await writeFile(join(cwd, '.omx', 'plans', `test-spec-${slug}.md`), '# Test spec\n', 'utf-8');
  refreshContextPackBasis(packPath);

  return { prdPath, packPath };
}

async function createFakePromptCodex(root: string): Promise<{ restore: () => Promise<void> }> {
  const binDir = join(root, 'bin');
  const fakeCodexPath = join(binDir, 'codex');
  const previousPath = process.env.PATH;
  const previousTmux = process.env.TMUX;
  const previousLaunchMode = process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
  const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;

  await mkdir(binDir, { recursive: true });
  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
process.stdin.resume();
setTimeout(() => process.exit(0), 5000);
process.on('SIGTERM', () => process.exit(0));
`,
    'utf-8',
  );
  await chmod(fakeCodexPath, 0o755);

  process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  delete process.env.TMUX;
  process.env.OMX_TEAM_WORKER_LAUNCH_MODE = 'prompt';
  process.env.OMX_TEAM_WORKER_CLI = 'codex';

  return {
    restore: async () => {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousLaunchMode === 'string') process.env.OMX_TEAM_WORKER_LAUNCH_MODE = previousLaunchMode;
      else delete process.env.OMX_TEAM_WORKER_LAUNCH_MODE;
      if (typeof previousWorkerCli === 'string') process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
    },
  };
}

describe('approved team execution integration', () => {
  it('reads the active bound team execution from session-scoped team state before root fallback', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-session-bound-'));
    const approvedTask = 'Execute approved issue 1310 plan';
    const sessionId = 'sess-team-approved-followup';
    try {
      const { prdPath } = await writeApprovedTeamHandoffFiles(cwd, 'issue-1310', approvedTask);
      await mkdir(join(cwd, '.omx', 'state', 'sessions', sessionId), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'state', 'session.json'),
        `${JSON.stringify({
          session_id: sessionId,
          cwd,
          started_at: new Date().toISOString(),
        }, null, 2)}\n`,
      );
      await writeFile(
        join(cwd, '.omx', 'state', 'sessions', sessionId, 'team-state.json'),
        `${JSON.stringify({
          active: true,
          team_name: 'bound-team-session',
          task_description: approvedTask,
          agent_count: 2,
        }, null, 2)}\n`,
      );
      await writePersistedApprovedTeamExecutionBinding('bound-team-session', cwd, {
        prd_path: prdPath,
        task: approvedTask,
      });

      const boundState = readBoundApprovedTeamExecutionState(cwd);
      assert.equal(boundState.teamName, 'bound-team-session');
      assert.equal(boundState.bindingConfigured, true);
      assert.equal(boundState.teamState?.team_name, 'bound-team-session');
      assert.equal(boundState.approvedHint?.task, approvedTask);
      assert.equal(boundState.approvedHint?.sourcePath, prdPath);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('falls back to root team state when the current session has no session-scoped team state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-root-fallback-'));
    const approvedTask = 'Execute approved issue 1311 plan';
    const sessionId = 'sess-team-approved-root-fallback';
    try {
      const { prdPath } = await writeApprovedTeamHandoffFiles(cwd, 'issue-1311', approvedTask);
      await mkdir(join(cwd, '.omx', 'state', 'sessions', sessionId), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'state', 'session.json'),
        `${JSON.stringify({
          session_id: sessionId,
          cwd,
          started_at: new Date().toISOString(),
        }, null, 2)}\n`,
      );
      await writeFile(
        join(cwd, '.omx', 'state', 'team-state.json'),
        `${JSON.stringify({
          active: true,
          team_name: 'bound-team-root',
          task_description: approvedTask,
          agent_count: 3,
        }, null, 2)}\n`,
      );
      await writePersistedApprovedTeamExecutionBinding('bound-team-root', cwd, {
        prd_path: prdPath,
        task: approvedTask,
      });

      const boundState = readBoundApprovedTeamExecutionState(cwd);
      assert.equal(boundState.teamName, 'bound-team-root');
      assert.equal(boundState.bindingConfigured, true);
      assert.equal(boundState.teamState?.team_name, 'bound-team-root');
      assert.equal(boundState.approvedHint?.task, approvedTask);
      assert.equal(boundState.approvedHint?.sourcePath, prdPath);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('falls back to root team state when the current session-scoped team state is inactive', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-inactive-session-fallback-'));
    const approvedTask = 'Execute approved issue 1312 plan';
    const sessionId = 'sess-team-approved-inactive-fallback';
    try {
      const { prdPath } = await writeApprovedTeamHandoffFiles(cwd, 'issue-1312', approvedTask);
      await mkdir(join(cwd, '.omx', 'state', 'sessions', sessionId), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'state', 'session.json'),
        `${JSON.stringify({
          session_id: sessionId,
          cwd,
          started_at: new Date().toISOString(),
        }, null, 2)}\n`,
      );
      await writeFile(
        join(cwd, '.omx', 'state', 'sessions', sessionId, 'team-state.json'),
        `${JSON.stringify({
          active: false,
          team_name: 'inactive-session-team',
          task_description: 'Inactive session state should not mask root',
          current_phase: 'cancelled',
        }, null, 2)}\n`,
      );
      await writeFile(
        join(cwd, '.omx', 'state', 'team-state.json'),
        `${JSON.stringify({
          active: true,
          team_name: 'bound-team-root-fallback',
          task_description: approvedTask,
          agent_count: 3,
        }, null, 2)}\n`,
      );
      await writePersistedApprovedTeamExecutionBinding('bound-team-root-fallback', cwd, {
        prd_path: prdPath,
        task: approvedTask,
      });

      const boundState = readBoundApprovedTeamExecutionState(cwd);
      assert.equal(boundState.teamName, 'bound-team-root-fallback');
      assert.equal(boundState.bindingConfigured, true);
      assert.equal(boundState.teamState?.team_name, 'bound-team-root-fallback');
      assert.equal(boundState.approvedHint?.task, approvedTask);
      assert.equal(boundState.approvedHint?.sourcePath, prdPath);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reads bound approved execution files from the team_state_root stored in active mode state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-custom-root-'));
    const customStateRoot = join(cwd, 'custom-team-state');
    const approvedTask = 'Execute approved custom-root plan';
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      delete process.env.OMX_TEAM_STATE_ROOT;
      const { prdPath } = await writeApprovedTeamHandoffFiles(cwd, 'custom-root', approvedTask);
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'state', 'team-state.json'),
        `${JSON.stringify({
          active: true,
          team_name: 'bound-team-custom-root',
          team_state_root: customStateRoot,
          task_description: approvedTask,
          agent_count: 3,
        }, null, 2)}\n`,
      );
      await writePersistedApprovedTeamExecutionBinding('bound-team-custom-root', cwd, {
        prd_path: prdPath,
        task: approvedTask,
      }, customStateRoot);

      const boundState = readBoundApprovedTeamExecutionState(cwd);
      assert.equal(boundState.teamName, 'bound-team-custom-root');
      assert.equal(boundState.bindingConfigured, true);
      assert.equal(boundState.teamState?.team_state_root, customStateRoot);
      assert.equal(boundState.approvedHint?.task, approvedTask);
      assert.equal(boundState.approvedHint?.sourcePath, prdPath);
    } finally {
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('falls back to root team state when the current session-scoped team state is malformed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-malformed-session-fallback-'));
    const approvedTask = 'Execute approved issue 1313 plan';
    const sessionId = 'sess-team-approved-malformed-fallback';
    try {
      const { prdPath } = await writeApprovedTeamHandoffFiles(cwd, 'issue-1313', approvedTask);
      await mkdir(join(cwd, '.omx', 'state', 'sessions', sessionId), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'state', 'session.json'),
        `${JSON.stringify({
          session_id: sessionId,
          cwd,
          started_at: new Date().toISOString(),
        }, null, 2)}\n`,
      );
      await writeFile(join(cwd, '.omx', 'state', 'sessions', sessionId, 'team-state.json'), '{ not-json', 'utf-8');
      await writeFile(
        join(cwd, '.omx', 'state', 'team-state.json'),
        `${JSON.stringify({
          active: true,
          team_name: 'bound-team-root-malformed-fallback',
          task_description: approvedTask,
          agent_count: 3,
        }, null, 2)}\n`,
      );
      await writePersistedApprovedTeamExecutionBinding('bound-team-root-malformed-fallback', cwd, {
        prd_path: prdPath,
        task: approvedTask,
      });

      const boundState = readBoundApprovedTeamExecutionState(cwd);
      assert.equal(boundState.teamName, 'bound-team-root-malformed-fallback');
      assert.equal(boundState.bindingConfigured, true);
      assert.equal(boundState.teamState?.team_name, 'bound-team-root-malformed-fallback');
      assert.equal(boundState.approvedHint?.task, approvedTask);
      assert.equal(boundState.approvedHint?.sourcePath, prdPath);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('surfaces malformed persisted approved execution bindings distinctly', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-malformed-binding-state-'));
    const approvedTask = 'Execute approved malformed binding state plan';
    try {
      await writeApprovedTeamHandoffFiles(cwd, 'malformed-binding-state', approvedTask);
      await mkdir(join(cwd, '.omx', 'state', 'team', 'bound-team-malformed-binding-state'), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'state', 'team-state.json'),
        `${JSON.stringify({
          active: true,
          team_name: 'bound-team-malformed-binding-state',
          task_description: approvedTask,
          agent_count: 3,
        }, null, 2)}\n`,
      );
      await writeFile(
        join(cwd, '.omx', 'state', 'team', 'bound-team-malformed-binding-state', 'approved-execution.json'),
        '{invalid json\n',
        'utf-8',
      );

      const boundState = readBoundApprovedTeamExecutionState(cwd);
      assert.equal(boundState.teamName, 'bound-team-malformed-binding-state');
      assert.equal(boundState.bindingConfigured, true);
      assert.equal(boundState.bindingState, 'malformed');
      assert.equal(boundState.teamState?.team_name, 'bound-team-malformed-binding-state');
      assert.equal(boundState.approvedExecution, null);
      assert.equal(boundState.approvedHint, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('falls back to root team state when the current session-scoped team state is active but lacks team identity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-incomplete-session-fallback-'));
    const approvedTask = 'Execute approved incomplete-session fallback plan';
    const sessionId = 'sess-team-approved-incomplete-fallback';
    try {
      const { prdPath } = await writeApprovedTeamHandoffFiles(cwd, 'issue-1313-incomplete-session', approvedTask);
      await mkdir(join(cwd, '.omx', 'state', 'sessions', sessionId), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'state', 'session.json'),
        `${JSON.stringify({
          session_id: sessionId,
          cwd,
          started_at: new Date().toISOString(),
        }, null, 2)}\n`,
      );
      await writeFile(
        join(cwd, '.omx', 'state', 'sessions', sessionId, 'team-state.json'),
        `${JSON.stringify({
          active: true,
          task_description: 'Session state is semantically incomplete',
          agent_count: 1,
        }, null, 2)}\n`,
      );
      await writeFile(
        join(cwd, '.omx', 'state', 'team-state.json'),
        `${JSON.stringify({
          active: true,
          team_name: 'bound-team-root-incomplete-fallback',
          task_description: approvedTask,
          agent_count: 4,
        }, null, 2)}\n`,
      );
      await writePersistedApprovedTeamExecutionBinding('bound-team-root-incomplete-fallback', cwd, {
        prd_path: prdPath,
        task: approvedTask,
      });

      const boundState = readBoundApprovedTeamExecutionState(cwd);
      assert.equal(boundState.teamName, 'bound-team-root-incomplete-fallback');
      assert.equal(boundState.bindingConfigured, true);
      assert.equal(boundState.bindingState, 'valid');
      assert.equal(boundState.teamState?.team_name, 'bound-team-root-incomplete-fallback');
      assert.equal(boundState.approvedHint?.task, approvedTask);
      assert.equal(boundState.approvedHint?.sourcePath, prdPath);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('treats persisted plan-only bindings as nonready for approved-context continuity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-plan-only-continuity-'));
    const approvedTask = 'Execute approved plan-only task';
    const prdPath = join(cwd, '.omx', 'plans', 'prd-legacy-plan-only.md');
    try {
      await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
      await writeFile(
        prdPath,
        [
          '# Approved plan',
          '',
          `Launch via omx team 1:executor ${JSON.stringify(approvedTask)}`,
        ].join('\n'),
        'utf-8',
      );
      await writeFile(join(cwd, '.omx', 'plans', 'test-spec-legacy-plan-only.md'), '# Test spec\n', 'utf-8');
      await writePersistedApprovedTeamExecutionBinding('bound-team-plan-only', cwd, {
        prd_path: prdPath,
        task: approvedTask,
      });

      const continuity = await resolvePersistedApprovedTeamExecutionContinuityState(
        'bound-team-plan-only',
        cwd,
      );
      assert.equal(continuity.status, 'nonready');
      assert.equal(continuity.approvedHint.contextPackStatus, 'plan-only');
      assert.equal(continuity.approvedHint.sourcePath, prdPath);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('documents incomplete context-pack handoffs as repair-only', () => {
    const section = buildApprovedTeamHandoffSection({
      mode: 'team',
      command: 'omx team 1:executor "Execute approved incomplete plan"',
      task: 'Execute approved incomplete plan',
      sourcePath: '.omx/plans/prd-incomplete.md',
      testSpecPaths: ['.omx/plans/test-spec-incomplete.md'],
      deepInterviewSpecPaths: ['.omx/specs/deep-interview-incomplete.md'],
      contextPack: { path: '.omx/context/context-20260420T000000Z-incomplete.json', action: 'created' },
      contextPackStatus: 'incomplete',
      missingRequiredContextPackRoles: ['build', 'verify'],
      contextPackIssues: [],
      contextRefs: [],
      contextRefIssues: [],
    });

    assert.match(section ?? '', /Missing required context roles: build, verify/i);
    assert.match(section ?? '', /only as repair inputs/i);
    assert.match(section ?? '', /repair or recreate the canonical context pack with required role coverage, then sync it before broader context loading/i);
    assert.doesNotMatch(section ?? '', /as the brief/i);
  });

  it('resolves approved handoff context inside startTeam and persists it for resume', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-start-'));
    const approvedTask = 'Execute approved issue 1300 plan';
    const { prdPath } = await writeApprovedTeamHandoffFiles(cwd, 'issue-1300', approvedTask);
    const approvedExecution = {
      prd_path: prdPath,
      task: approvedTask,
    };
    const fakeCodex = await createFakePromptCodex(cwd);

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withMockPromptModeCodexAllowed(() =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-approved-start',
            approvedTask,
            'executor',
            1,
            [{ subject: 'Implement approved issue 1300', description: 'Implement approved issue 1300', owner: 'worker-1' }],
            cwd,
            { approvedExecution },
          )));

      const persistedBinding = await readPersistedApprovedTeamExecutionBinding(runtime.teamName, cwd);
      assert.deepEqual(persistedBinding, {
        prd_path: prdPath,
        task: approvedTask,
        command: `omx team 1:executor ${JSON.stringify(approvedTask)}`,
      });
      const persistedHint = await readPersistedApprovedTeamExecutionHint(runtime.teamName, cwd);
      assert.equal(persistedHint?.task, approvedTask);
      assert.equal(persistedHint?.sourcePath, prdPath);

      const inbox = await readFile(
        join(cwd, '.omx', 'state', 'team', runtime.teamName, 'workers', 'worker-1', 'inbox.md'),
        'utf-8',
      );
      assert.match(inbox, /## Approved Handoff Context/);
      assert.match(inbox, /Build refs \(read first\):/);
      assert.match(inbox, /Scope refs:/);
      assert.match(inbox, /Verify refs:/);

      const resumed = await resumeTeam(runtime.teamName, cwd);
      assert.equal(resumed?.teamName, runtime.teamName);
      const resumedHint = await readPersistedApprovedTeamExecutionHint(runtime.teamName, cwd);
      assert.equal(resumedHint?.task, approvedTask);
      assert.equal(resumedHint?.sourcePath, prdPath);

      await shutdownTeam(runtime.teamName, cwd, { force: true });
      runtime = null;
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      await fakeCodex.restore();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves approved handoff context when assigning later tasks to an already bound worker', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-reassign-'));
    const approvedTask = 'Execute approved issue 1300 reassign plan';
    const { prdPath } = await writeApprovedTeamHandoffFiles(cwd, 'issue-1300-reassign', approvedTask);
    const approvedExecution = {
      prd_path: prdPath,
      task: approvedTask,
    };
    const fakeCodex = await createFakePromptCodex(cwd);

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withMockPromptModeCodexAllowed(() =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-approved-reassign',
            approvedTask,
            'executor',
            1,
            [{ subject: 'Implement approved issue 1300', description: 'Implement approved issue 1300', owner: 'worker-1' }],
            cwd,
            { approvedExecution },
          )));

      const nextTask = await createTask(runtime.teamName, {
        subject: 'Follow-up implementation',
        description: 'Handle the second approved assignment',
        status: 'pending',
      }, cwd);
      await assignTask(runtime.teamName, 'worker-1', nextTask.id, cwd);

      const inbox = await readFile(
        join(cwd, '.omx', 'state', 'team', runtime.teamName, 'workers', 'worker-1', 'inbox.md'),
        'utf-8',
      );
      assert.match(inbox, /# New Task Assignment/);
      assert.match(inbox, /## Approved Handoff Context/);
      assert.match(inbox, /Approved plan:/);
      assert.match(inbox, /Build refs \(read first\):/);

      await shutdownTeam(runtime.teamName, cwd, { force: true });
      runtime = null;
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      await fakeCodex.restore();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('respects explicit approvedExecution null and suppresses persisted bindings during startTeam', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-start-explicit-null-'));
    const approvedTask = 'Execute approved issue 1300 explicit null plan';
    const { prdPath } = await writeApprovedTeamHandoffFiles(cwd, 'issue-1300-explicit-null', approvedTask);
    const fakeCodex = await createFakePromptCodex(cwd);

    let runtime: TeamRuntime | null = null;
    try {
      await writePersistedApprovedTeamExecutionBinding('team-approved-start-explicit-null', cwd, {
        prd_path: prdPath,
        task: approvedTask,
        command: `omx team 1:executor ${JSON.stringify(approvedTask)}`,
      });

      runtime = await withMockPromptModeCodexAllowed(() =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-approved-start-explicit-null',
            'generic team launch',
            'executor',
            1,
            [{ subject: 'Implement generic task', description: 'Implement generic task', owner: 'worker-1' }],
            cwd,
            { approvedExecution: null },
          )));

      const persistedBinding = await readPersistedApprovedTeamExecutionBinding(runtime.teamName, cwd);
      assert.equal(persistedBinding, null);
      const persistedHint = await readPersistedApprovedTeamExecutionHint(runtime.teamName, cwd);
      assert.equal(persistedHint, null);

      const inbox = await readFile(
        join(cwd, '.omx', 'state', 'team', runtime.teamName, 'workers', 'worker-1', 'inbox.md'),
        'utf-8',
      );
      assert.doesNotMatch(inbox, /## Approved Handoff Context/);

      await shutdownTeam(runtime.teamName, cwd, { force: true });
      runtime = null;
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      await fakeCodex.restore();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('threads persisted approved handoff context into scaled-up worker inboxes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-scale-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-team-approved-scale-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    const approvedTask = 'Execute approved issue 1301 plan';
    const { prdPath } = await writeApprovedTeamHandoffFiles(cwd, 'issue-1301', approvedTask);

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%41"',
          '    ;;',
          '  list-panes)',
          '    echo "51515"',
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
        'utf-8',
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '', 'utf-8');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.omx', 'state', 'team', 'team-approved-scale'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'team', 'team-approved-scale', 'worker-agents.md'), '# Base worker instructions\n', 'utf-8');

      await initTeamState('team-approved-scale', approvedTask, 'executor', 1, cwd);
      await createTask('team-approved-scale', {
        subject: 'existing task',
        description: 'already persisted',
        status: 'pending',
        owner: 'worker-1',
      }, cwd);

      const config = await readTeamConfig('team-approved-scale', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-team-approved-scale';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await writePersistedApprovedTeamExecutionBinding('team-approved-scale', cwd, {
        prd_path: prdPath,
        task: approvedTask,
      });
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'team-approved-scale', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

      const result = await scaleUp(
        'team-approved-scale',
        1,
        'executor',
        [{ subject: 'implement approved follow-up', description: 'implement approved follow-up', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const createdTask = await readTask('team-approved-scale', '2', cwd);
      assert.equal(createdTask?.owner, 'worker-2');

      const inbox = await readFile(
        join(cwd, '.omx', 'state', 'team', 'team-approved-scale', 'workers', 'worker-2', 'inbox.md'),
        'utf-8',
      );
      assert.match(inbox, /## Approved Handoff Context/);
      assert.match(inbox, /Approved plan:/);
      assert.match(inbox, /Build refs \(read first\):/);

      const persistedBinding = await readPersistedApprovedTeamExecutionBinding('team-approved-scale', cwd);
      assert.deepEqual(persistedBinding, {
        prd_path: prdPath,
        task: approvedTask,
        command: `omx team 1:executor ${JSON.stringify(approvedTask)}`,
      });
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('keeps scaleUp unbound when no approved execution binding file exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-scale-unbound-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-team-approved-scale-unbound-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    const approvedTask = 'Execute approved issue 1302 unbound plan';
    await writeApprovedTeamHandoffFiles(cwd, 'issue-1302-unbound', approvedTask);

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%43"',
          '    ;;',
          '  list-panes)',
          '    echo "61616"',
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
        'utf-8',
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '', 'utf-8');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.omx', 'state', 'team', 'team-approved-scale-unbound'), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'state', 'team', 'team-approved-scale-unbound', 'worker-agents.md'),
        '# Base worker instructions\n',
        'utf-8',
      );

      await initTeamState('team-approved-scale-unbound', approvedTask, 'executor', 1, cwd);
      await createTask('team-approved-scale-unbound', {
        subject: 'existing task',
        description: 'already persisted',
        status: 'pending',
        owner: 'worker-1',
      }, cwd);

      const config = await readTeamConfig('team-approved-scale-unbound', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-team-approved-scale-unbound';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, cwd);

      const result = await scaleUp(
        'team-approved-scale-unbound',
        1,
        'executor',
        [{ subject: 'implement approved follow-up', description: 'implement approved follow-up', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const inbox = await readFile(
        join(cwd, '.omx', 'state', 'team', 'team-approved-scale-unbound', 'workers', 'worker-2', 'inbox.md'),
        'utf-8',
      );
      assert.doesNotMatch(inbox, /## Approved Handoff Context/);

      const persistedBinding = await readPersistedApprovedTeamExecutionBinding('team-approved-scale-unbound', cwd);
      assert.equal(persistedBinding, null);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('fails closed when the persisted approved execution binding file is malformed during scaleUp', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-scale-malformed-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-team-approved-scale-malformed-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    const approvedTask = 'Execute approved issue 1302 malformed binding plan';

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%51"',
          '    ;;',
          '  list-panes)',
          '    echo "71717"',
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
        'utf-8',
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '', 'utf-8');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.omx', 'state', 'team', 'team-approved-scale-malformed'), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'state', 'team', 'team-approved-scale-malformed', 'worker-agents.md'),
        '# Base worker instructions\n',
        'utf-8',
      );

      await initTeamState('team-approved-scale-malformed', approvedTask, 'executor', 1, cwd);
      await createTask('team-approved-scale-malformed', {
        subject: 'existing task',
        description: 'already persisted',
        status: 'pending',
        owner: 'worker-1',
      }, cwd);

      const config = await readTeamConfig('team-approved-scale-malformed', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-team-approved-scale-malformed';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, cwd);

      await writeFile(
        join(cwd, '.omx', 'state', 'team', 'team-approved-scale-malformed', 'approved-execution.json'),
        '{invalid json\n',
        'utf-8',
      );

      const result = await scaleUp(
        'team-approved-scale-malformed',
        1,
        'executor',
        [{ subject: 'implement approved follow-up', description: 'implement approved follow-up', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, false);
      assert.match(result.error, /approved_execution_binding_malformed/);

      const createdTask = await readTask('team-approved-scale-malformed', '2', cwd);
      assert.equal(createdTask, null);
      assert.equal(
        existsSync(join(cwd, '.omx', 'state', 'team', 'team-approved-scale-malformed', 'workers', 'worker-2')),
        false,
      );
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('fails closed when scaleUp cannot rehydrate the persisted approved execution binding', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-scale-stale-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-team-approved-scale-stale-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    const approvedTask = 'Execute approved issue 1302 plan';
    const { prdPath } = await writeApprovedTeamHandoffFiles(cwd, 'issue-1302', approvedTask);

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%41"',
          '    ;;',
          '  list-panes)',
          '    echo "51515"',
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
        'utf-8',
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '', 'utf-8');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.omx', 'state', 'team', 'team-approved-scale-stale'), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'state', 'team', 'team-approved-scale-stale', 'worker-agents.md'),
        '# Base worker instructions\n',
        'utf-8',
      );

      await initTeamState('team-approved-scale-stale', approvedTask, 'executor', 1, cwd);
      await createTask('team-approved-scale-stale', {
        subject: 'existing task',
        description: 'already persisted',
        status: 'pending',
        owner: 'worker-1',
      }, cwd);

      const config = await readTeamConfig('team-approved-scale-stale', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-team-approved-scale-stale';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await writePersistedApprovedTeamExecutionBinding('team-approved-scale-stale', cwd, {
        prd_path: prdPath,
        task: approvedTask,
      });
      await saveTeamConfig(config, cwd);

      await rm(prdPath, { force: true });

      const result = await scaleUp(
        'team-approved-scale-stale',
        1,
        'executor',
        [{ subject: 'implement approved follow-up', description: 'implement approved follow-up', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, false);
      assert.match(result.error, /approved_execution_binding_stale/);

      const createdTask = await readTask('team-approved-scale-stale', '2', cwd);
      assert.equal(createdTask, null);
      assert.equal(
        existsSync(join(cwd, '.omx', 'state', 'team', 'team-approved-scale-stale', 'workers', 'worker-2')),
        false,
      );

      const configAfter = await readTeamConfig('team-approved-scale-stale', cwd);
      assert.ok(configAfter);
      assert.equal(configAfter?.worker_count, 1);
      assert.equal(configAfter?.workers.length, 1);

      const persistedBinding = await readPersistedApprovedTeamExecutionBinding('team-approved-scale-stale', cwd);
      assert.deepEqual(persistedBinding, {
        prd_path: prdPath,
        task: approvedTask,
      });
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('fails closed when scaleUp rehydrates a persisted approved execution binding that is no longer reusable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-scale-nonready-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-team-approved-scale-nonready-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    const approvedTask = 'Execute approved issue 1302 missing-baseline plan';
    const { prdPath } = await writeApprovedTeamHandoffFiles(cwd, 'issue-1302-missing-baseline', approvedTask);

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%41"',
          '    ;;',
          '  list-panes)',
          '    echo "51515"',
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
        'utf-8',
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '', 'utf-8');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.omx', 'state', 'team', 'team-approved-scale-nonready'), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'state', 'team', 'team-approved-scale-nonready', 'worker-agents.md'),
        '# Base worker instructions\n',
        'utf-8',
      );

      await initTeamState('team-approved-scale-nonready', approvedTask, 'executor', 1, cwd);
      await createTask('team-approved-scale-nonready', {
        subject: 'existing task',
        description: 'already persisted',
        status: 'pending',
        owner: 'worker-1',
      }, cwd);

      const config = await readTeamConfig('team-approved-scale-nonready', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-team-approved-scale-nonready';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await writePersistedApprovedTeamExecutionBinding('team-approved-scale-nonready', cwd, {
        prd_path: prdPath,
        task: approvedTask,
      });
      await saveTeamConfig(config, cwd);

      await rm(join(cwd, '.omx', 'plans', 'test-spec-issue-1302-missing-baseline.md'), { force: true });

      const result = await scaleUp(
        'team-approved-scale-nonready',
        1,
        'executor',
        [{ subject: 'implement approved follow-up', description: 'implement approved follow-up', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, false);
      assert.match(result.error, /approved_execution_binding_nonready:.*:missing-baseline/);

      const createdTask = await readTask('team-approved-scale-nonready', '2', cwd);
      assert.equal(createdTask, null);
      assert.equal(
        existsSync(join(cwd, '.omx', 'state', 'team', 'team-approved-scale-nonready', 'workers', 'worker-2')),
        false,
      );
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('uses approved execution bindings when the team task summary does not match the approved launch task', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-binding-'));
    const approvedTask = 'Execute approved issue 1304 plan';
    const { prdPath } = await writeApprovedTeamHandoffFiles(cwd, 'issue-1304', approvedTask);
    const fakeCodex = await createFakePromptCodex(cwd);

    let runtime: TeamRuntime | null = null;
    try {
      runtime = await withMockPromptModeCodexAllowed(() =>
        withoutTeamWorkerEnv(() =>
          startTeam(
            'team-approved-binding',
            'Implement approved issue 1304; Verify approved issue 1304',
            'executor',
            1,
            [{ subject: 'Implement approved issue 1304', description: 'Implement approved issue 1304', owner: 'worker-1' }],
            cwd,
            {
              approvedExecution: {
                prd_path: prdPath,
                task: approvedTask,
              },
            },
          )));

      const persistedBinding = await readPersistedApprovedTeamExecutionBinding(runtime.teamName, cwd);
      assert.deepEqual(persistedBinding, {
        prd_path: prdPath,
        task: approvedTask,
        command: `omx team 1:executor ${JSON.stringify(approvedTask)}`,
      });

      const inbox = await readFile(
        join(cwd, '.omx', 'state', 'team', runtime.teamName, 'workers', 'worker-1', 'inbox.md'),
        'utf-8',
      );
      assert.match(inbox, /## Approved Handoff Context/);
      assert.match(inbox, /Approved plan:/);

      await shutdownTeam(runtime.teamName, cwd, { force: true });
      runtime = null;
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, cwd, { force: true }).catch(() => {});
      }
      await fakeCodex.restore();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed when startTeam receives a stale explicit approved execution binding', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-binding-stale-'));
    const approvedTask = 'Execute approved issue 1305 plan';
    const { prdPath } = await writeApprovedTeamHandoffFiles(cwd, 'issue-1305', approvedTask);
    const fakeCodex = await createFakePromptCodex(cwd);

    try {
      await rm(prdPath, { force: true });

      await assert.rejects(
        () => withMockPromptModeCodexAllowed(() =>
          withoutTeamWorkerEnv(() =>
            startTeam(
              'team-approved-binding-stale',
              'Implement approved issue 1305; Verify approved issue 1305',
              'executor',
              1,
              [{ subject: 'Implement approved issue 1305', description: 'Implement approved issue 1305', owner: 'worker-1' }],
              cwd,
              {
                approvedExecution: {
                  prd_path: prdPath,
                  task: approvedTask,
                },
              },
            ))),
        /approved_execution_binding_stale/,
      );

      const persistedBinding = await readPersistedApprovedTeamExecutionBinding('team-approved-binding-stale', cwd);
      assert.equal(persistedBinding, null);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', 'team-approved-binding-stale')), false);
      assert.equal(existsSync(join(cwd, '.omx', 'team', 'team-approved-binding-stale')), false);
    } finally {
      await fakeCodex.restore();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed when startTeam receives a non-ready explicit approved execution binding', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-binding-nonready-'));
    const approvedTask = 'Execute approved issue 1305 missing-baseline plan';
    const { prdPath } = await writeApprovedTeamHandoffFiles(cwd, 'issue-1305-missing-baseline', approvedTask);
    const fakeCodex = await createFakePromptCodex(cwd);

    try {
      await rm(join(cwd, '.omx', 'plans', 'test-spec-issue-1305-missing-baseline.md'), { force: true });

      await assert.rejects(
        () => withMockPromptModeCodexAllowed(() =>
          withoutTeamWorkerEnv(() =>
            startTeam(
              'team-approved-binding-nonready',
              'Implement approved issue 1305; Verify approved issue 1305',
              'executor',
              1,
              [{ subject: 'Implement approved issue 1305', description: 'Implement approved issue 1305', owner: 'worker-1' }],
              cwd,
              {
                approvedExecution: {
                  prd_path: prdPath,
                  task: approvedTask,
                },
              },
            ))),
        /approved_execution_binding_nonready:.*:missing-baseline/,
      );

      const persistedBinding = await readPersistedApprovedTeamExecutionBinding('team-approved-binding-nonready', cwd);
      assert.equal(persistedBinding, null);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', 'team-approved-binding-nonready')), false);
      assert.equal(existsSync(join(cwd, '.omx', 'team', 'team-approved-binding-nonready')), false);
    } finally {
      await fakeCodex.restore();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed when a persisted binding points at a deleted PRD even if another PRD reuses the task', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-stale-prd-'));
    const approvedTask = 'Execute approved issue 1311 plan';
    const { prdPath: stalePrdPath } = await writeApprovedTeamHandoffFiles(cwd, 'issue-1311-stale', approvedTask);
    const { prdPath: currentPrdPath } = await writeApprovedTeamHandoffFiles(cwd, 'issue-1311-current', approvedTask);

    try {
      await rm(stalePrdPath, { force: true });

      const staleBindingHint = resolveApprovedTeamExecutionHint(cwd, {
        approvedExecution: {
          prd_path: stalePrdPath,
          task: approvedTask,
        },
        task: approvedTask,
      });
      assert.equal(staleBindingHint, null);

      const taskMatchedHint = resolveApprovedTeamExecutionHint(cwd, { task: approvedTask });
      assert.equal(taskMatchedHint?.sourcePath, currentPrdPath);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed when a persisted binding task no longer exists in the bound PRD', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-stale-hint-'));
    const approvedTask = 'Execute approved issue 1312 plan';
    const { prdPath: stalePrdPath } = await writeApprovedTeamHandoffFiles(cwd, 'issue-1312-stale', approvedTask);
    const { prdPath: currentPrdPath } = await writeApprovedTeamHandoffFiles(cwd, 'issue-1312-current', approvedTask);

    try {
      await writeFile(
        stalePrdPath,
        [
          '# Approved plan',
          '',
          '## Context Pack Outcome',
          '- pack: created `.omx/context/context-20260421T000000Z-issue-1312-stale.json`',
          '',
          'Launch via omx team 1:executor "Execute different issue 1312 plan"',
        ].join('\n'),
        'utf-8',
      );

      const staleBindingHint = resolveApprovedTeamExecutionHint(cwd, {
        approvedExecution: {
          prd_path: stalePrdPath,
          task: approvedTask,
        },
        task: approvedTask,
      });
      assert.equal(staleBindingHint, null);

      const taskMatchedHint = resolveApprovedTeamExecutionHint(cwd, { task: approvedTask });
      assert.equal(taskMatchedHint?.sourcePath, currentPrdPath);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rehydrates persisted bindings by exact command when one PRD repeats the same task text', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-approved-command-binding-'));
    const approvedTask = 'Execute approved issue 1314 plan';
    const primaryCommand = `omx team 2:executor ${JSON.stringify(approvedTask)}`;
    const secondaryCommand = `$team 5:debugger ${JSON.stringify(approvedTask)}`;
    const { packPath, prdPath } = await writeApprovedTeamHandoffFiles(cwd, 'issue-1314', approvedTask);

    try {
      await writeFile(
        prdPath,
        [
          '# Approved plan',
          '',
          '## Context Pack Outcome',
          `- pack: created \`${join('.omx', 'context', 'context-20260421T000000Z-issue-1314.json').replaceAll('\\', '/')}\``,
          '',
          `Launch via ${primaryCommand}`,
          `Launch via ${secondaryCommand}`,
        ].join('\n'),
        'utf-8',
      );
      refreshContextPackBasis(packPath);

      const exactBindingHint = readApprovedTeamExecutionHintFromBinding(cwd, {
        prd_path: prdPath,
        task: approvedTask,
        command: primaryCommand,
      });
      assert.equal(exactBindingHint?.command, primaryCommand);
      assert.equal(exactBindingHint?.workerCount, 2);
      assert.equal(exactBindingHint?.agentType, 'executor');

      const legacyBindingHint = readApprovedTeamExecutionHintFromBinding(cwd, {
        prd_path: prdPath,
        task: approvedTask,
      });
      assert.equal(legacyBindingHint, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
