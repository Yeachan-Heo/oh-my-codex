import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'fs/promises';
import { basename, dirname, join, relative } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import type { StageContext } from '../types.js';
import { createDeepInterviewStage, buildDeepInterviewInstruction } from '../stages/deep-interview.js';
import { createRalplanStage } from '../stages/ralplan.js';
import { createTeamExecStage, buildTeamInstruction } from '../stages/team-exec.js';
import { createRalphVerifyStage, createRalphStage, buildRalphInstruction } from '../stages/ralph-verify.js';
import { createCodeReviewStage, buildCodeReviewInstruction } from '../stages/code-review.js';
import { createUltragoalStage, buildUltragoalInstruction } from '../stages/ultragoal.js';
import { createUltraqaStage, buildUltraqaInstruction } from '../stages/ultraqa.js';
import { buildFollowupStaffingPlan } from '../../team/followup-planner.js';
import { packageRoot } from '../../utils/paths.js';
import { subagentTrackingPath } from '../../subagents/tracker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

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

function makeCtx(overrides: Partial<StageContext> = {}): StageContext {
  return {
    task: 'test task',
    artifacts: {},
    cwd: tempDir,
    ...overrides,
  };
}

async function setup(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-stages-test-'));
  return tempDir;
}

async function cleanup(): Promise<void> {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function decodeRuntimeCliInstructionPayload(instruction: string): Record<string, unknown> {
  const match = instruction.match(/--input-json-base64\s+([A-Za-z0-9_-]+)/);
  assert.ok(match?.[1], 'expected --input-json-base64 payload');
  return JSON.parse(Buffer.from(match[1], 'base64url').toString('utf-8')) as Record<string, unknown>;
}

async function writeNativeSubagentTracking(cwd: string, sessionId: string): Promise<void> {
  const trackingPath = subagentTrackingPath(cwd);
  const now = '2026-05-28T00:00:00.000Z';
  await mkdir(dirname(trackingPath), { recursive: true });
  await writeFile(trackingPath, JSON.stringify({
    schemaVersion: 1,
    sessions: {
      [sessionId]: {
        session_id: sessionId,
        leader_thread_id: 'thread-leader',
        updated_at: now,
        threads: {
          'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: now, last_seen_at: now, turn_count: 1 },
          'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: now, last_seen_at: now, completed_at: now, turn_count: 1 },
          'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: now, last_seen_at: now, completed_at: now, turn_count: 1 },
        },
      },
    },
  }, null, 2));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// RALPLAN stage tests
// ---------------------------------------------------------------------------

describe('RALPLAN Stage', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('creates a stage with the correct name', () => {
    const stage = createRalplanStage();
    assert.equal(stage.name, 'ralplan');
  });

  it('fails closed without planning artifacts and consensus evidence', async () => {
    const stage = createRalplanStage();
    const result = await stage.run(makeCtx());

    assert.equal(result.status, 'failed');
    assert.equal((result.artifacts as Record<string, unknown>).stage, 'ralplan');
    assert.ok((result.artifacts as Record<string, unknown>).instruction);
    assert.equal(result.error, 'ralplan_planning_artifacts_missing');
  });

  it('canSkip returns false when no plans directory exists', () => {
    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx()), false);
  });

  it('canSkip returns false when plans directory is empty', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx()), false);
  });

  it('canSkip returns false when only a prd- plan file exists', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx()), false);
  });

  it('canSkip returns false when only prd and test spec plan files exist without consensus evidence', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx()), false);
  });

  it('run fails with consensus-specific artifact error when consensus exists but planning artifacts are missing', async () => {
    const stage = createRalplanStage();
    const result = await stage.run(makeCtx({
      artifacts: {
        ralplan: {
          ralplanConsensusGate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: { agent_role: 'architect', verdict: 'approve' },
            ralplan_critic_review: { agent_role: 'critic', verdict: 'approve' },
          },
        },
      },
    }));

    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'ralplan_planning_artifacts_missing_after_consensus');
    assert.equal((result.artifacts as Record<string, unknown>).planningComplete, false);
  });

  it('canSkip returns true only when planning artifacts have sequential Architect and Critic approval evidence', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx({
      artifacts: {
        ralplan: {
          ralplanConsensusGate: {
            complete: true,
            ralplan_architect_review: { agent_role: 'architect', verdict: 'approve', summary: 'architect approved' },
            ralplan_critic_review: { agent_role: 'critic', verdict: 'approve', summary: 'critic approved after architect' },
          },
        },
      },
    })), true);
  });

  it('strict Autopilot canSkip rejects artifact-only or codex_exec consensus evidence', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');

    const stage = createRalplanStage({ requireNativeSubagents: true });
    assert.equal(stage.canSkip!(makeCtx({
      sessionId: 'sess-native-required',
      artifacts: {
        ralplan: {
          ralplanConsensusGate: {
            complete: true,
            ralplan_architect_review: {
              agent_role: 'architect',
              verdict: 'approve',
              provenance_kind: 'codex_exec',
              session_id: 'sess-native-required',
              thread_id: 'exec-architect',
              artifact_path: '.omx/artifacts/architect.md',
              tracker_path: '.omx/state/subagent-tracking.json',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              verdict: 'approve',
              provenance_kind: 'codex_exec',
              session_id: 'sess-native-required',
              thread_id: 'exec-critic',
              artifact_path: '.omx/artifacts/critic.md',
              tracker_path: '.omx/state/subagent-tracking.json',
            },
          },
        },
      },
    })), false);
  });


  it('strict Autopilot canSkip rejects native reviews that reuse one subagent thread', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const sessionId = 'sess-native-same-thread';
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');
    await writeNativeSubagentTracking(tempDir, sessionId);

    const stage = createRalplanStage({ requireNativeSubagents: true });
    assert.equal(stage.canSkip!(makeCtx({
      sessionId,
      artifacts: {
        ralplan: {
          ralplanConsensusGate: {
            complete: true,
            ralplan_architect_review: {
              agent_role: 'architect',
              verdict: 'approve',
              provenance_kind: 'native_subagent',
              session_id: sessionId,
              thread_id: 'thread-architect',
              artifact_path: '.omx/artifacts/architect.md',
              tracker_path: '.omx/state/subagent-tracking.json',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              verdict: 'approve',
              provenance_kind: 'native_subagent',
              session_id: sessionId,
              thread_id: 'thread-architect',
              artifact_path: '.omx/artifacts/critic.md',
              tracker_path: '.omx/state/subagent-tracking.json',
            },
          },
        },
      },
    })), false);
  });

  it('strict Autopilot canSkip accepts tracker-backed native Architect and Critic lanes', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const sessionId = 'sess-native-required';
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');
    await writeNativeSubagentTracking(tempDir, sessionId);

    const stage = createRalplanStage({ requireNativeSubagents: true });
    assert.equal(stage.canSkip!(makeCtx({
      sessionId,
      artifacts: {
        ralplan: {
          ralplanConsensusGate: {
            complete: true,
            ralplan_architect_review: {
              agent_role: 'architect',
              verdict: 'approve',
              provenance_kind: 'native_subagent',
              session_id: sessionId,
              thread_id: 'thread-architect',
              artifact_path: '.omx/artifacts/architect.md',
              tracker_path: '.omx/state/subagent-tracking.json',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              verdict: 'approve',
              provenance_kind: 'native_subagent',
              session_id: sessionId,
              thread_id: 'thread-critic',
              artifact_path: '.omx/artifacts/critic.md',
              tracker_path: '.omx/state/subagent-tracking.json',
            },
          },
        },
      },
    })), true);
  });

  it('canSkip honors explicit session-scoped consensus state before root state', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const stateDir = join(tempDir, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', 'sess-explicit');
    await mkdir(plansDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');
    await writeFile(join(stateDir, 'autopilot-state.json'), JSON.stringify({
      state: {
        handoff_artifacts: {
          ralplan_architect_review: { agent_role: 'architect', verdict: 'reject', approved: true },
          ralplan_critic_review: { agent_role: 'critic', verdict: 'approve' },
        },
      },
    }));
    await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
      state: {
        handoff_artifacts: {
          ralplan_architect_review: { agent_role: 'architect', verdict: 'approve' },
          ralplan_critic_review: { agent_role: 'critic', verdict: 'approve' },
        },
      },
    }));

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx({ sessionId: 'sess-explicit' })), true);
  });

  it('canSkip fails closed when explicit session state is missing despite root consensus', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const stateDir = join(tempDir, '.omx', 'state');
    await mkdir(plansDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');
    await writeFile(join(stateDir, 'autopilot-state.json'), JSON.stringify({
      state: {
        handoff_artifacts: {
          ralplan_architect_review: { agent_role: 'architect', verdict: 'approve' },
          ralplan_critic_review: { agent_role: 'critic', verdict: 'approve' },
        },
      },
    }));

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx({ sessionId: 'sess-missing' })), false);
  });

  it('canSkip fails closed for malformed explicit session ids instead of falling back to root consensus', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const stateDir = join(tempDir, '.omx', 'state');
    await mkdir(plansDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');
    await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
      ralplanConsensusGate: {
        complete: true,
        sequence: ['architect-review', 'critic-review'],
        ralplan_architect_review: { agent_role: 'architect', verdict: 'approve' },
        ralplan_critic_review: { agent_role: 'critic', verdict: 'approve' },
      },
    }));

    const stage = createRalplanStage();
    for (const sessionId of ['../bad', 'a'.repeat(65), '']) {
      assert.equal(stage.canSkip!(makeCtx({ sessionId })), false);
    }
  });

  it('canSkip rejects blocker aliases even with approval-shaped booleans', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');

    const stage = createRalplanStage();
    for (const blocker of [
      { blocking: true },
      { request_changes: true },
      { requestChanges: true },
      { status: 'request changes' },
      { recommendation: 'changes-requested' },
    ]) {
      assert.equal(stage.canSkip!(makeCtx({
        artifacts: {
          ralplan: {
            ralplanConsensusGate: {
              complete: true,
              ralplan_architect_review: { agent_role: 'architect', verdict: 'approve' },
              ralplan_critic_review: { agent_role: 'critic', approved: true, clean: true, ...blocker },
            },
          },
        },
      })), false);
    }
  });

  it('canSkip returns false when Critic evidence is recorded before Architect evidence', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx({
      artifacts: {
        ralplan: {
          ralplanConsensusGate: {
            complete: true,
            sequence: ['critic-review', 'architect-review'],
            ralplan_architect_review: { agent_role: 'architect', verdict: 'approve' },
            ralplan_critic_review: { agent_role: 'critic', verdict: 'approve' },
          },
        },
      },
    })), false);
  });

  it('canSkip returns false when Critic timestamp predates Architect timestamp', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx({
      artifacts: {
        ralplan: {
          ralplanConsensusGate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              verdict: 'approve',
              completed_at: '2026-05-21T10:05:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              verdict: 'approve',
              completed_at: '2026-05-21T10:00:00.000Z',
            },
          },
        },
      },
    })), false);
  });

  it('canSkip ignores ambient OMX_ROOT consensus state for local PRD/test-spec-only artifacts', async () => {
    const ambientRoot = await mkdtemp(join(tmpdir(), 'omx-ralplan-ambient-'));
    const previousOmxRoot = process.env.OMX_ROOT;
    try {
      const plansDir = join(tempDir, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      await writeFile(join(plansDir, 'prd-local.md'), '# Plan\n');
      await writeFile(join(plansDir, 'test-spec-local.md'), '# Test Spec\n');

      const ambientStateDir = join(ambientRoot, '.omx', 'state');
      await mkdir(ambientStateDir, { recursive: true });
      await writeFile(join(ambientStateDir, 'ralplan-state.json'), JSON.stringify({
        current_phase: 'complete',
        planning_complete: true,
        ralplan_consensus_gate: {
          complete: true,
          ralplan_architect_review: { agent_role: 'architect', verdict: 'approve', iteration: 1 },
          ralplan_critic_review: { agent_role: 'critic', verdict: 'approve', iteration: 1 },
        },
      }));
      process.env.OMX_ROOT = ambientRoot;

      const stage = createRalplanStage();
      assert.equal(stage.canSkip!(makeCtx()), false);
    } finally {
      if (previousOmxRoot === undefined) delete process.env.OMX_ROOT;
      else process.env.OMX_ROOT = previousOmxRoot;
      await rm(ambientRoot, { recursive: true, force: true });
    }
  });

  it('canSkip returns false for rejected consensus objects with approval-shaped booleans', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx({
      artifacts: {
        ralplan: {
          ralplanConsensusGate: {
            complete: true,
            ralplan_architect_review: {
              agent_role: 'architect',
              verdict: 'reject',
              approved: true,
              clean: true,
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              verdict: 'approve',
              approved: true,
              clean: true,
            },
          },
        },
      },
    })), false);
  });

  it('canSkip returns false when consensus-shaped reviews do not record agent roles', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx({
      artifacts: {
        ralplan: {
          ralplanConsensusGate: {
            complete: true,
            ralplan_architect_review: { verdict: 'approve', summary: 'role missing' },
            ralplan_critic_review: { verdict: 'approve', summary: 'role missing' },
          },
        },
      },
    })), false);
  });

  it('canSkip returns false when review history entries do not record agent roles', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx({
      artifacts: {
        ralplan: {
          review_history: [{
            architect_review: { verdict: 'approve', summary: 'role missing' },
            critic_review: { verdict: 'approve', summary: 'role missing' },
          }],
        },
      },
    })), false);
  });

  it('canSkip returns false when review arrays do not record agent roles', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx({
      artifacts: {
        ralplan: {
          architectReviews: [{ verdict: 'approve', summary: 'role missing' }],
          criticReviews: [{ verdict: 'approve', summary: 'role missing' }],
        },
      },
    })), false);
  });

  it('canSkip returns false when local state only has latest verdict fields', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    const stateDir = join(tempDir, '.omx', 'state');
    await mkdir(plansDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');
    await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
      current_phase: 'complete',
      planning_complete: true,
      latest_architect_verdict: 'approve',
      latest_critic_verdict: 'approve',
    }));

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx()), false);
  });

  it('canSkip returns false when Architect and Critic roles are swapped', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx({
      artifacts: {
        ralplan: {
          ralplanConsensusGate: {
            complete: true,
            ralplan_architect_review: { agent_role: 'critic', verdict: 'approve' },
            ralplan_critic_review: { agent_role: 'architect', verdict: 'approve' },
          },
        },
      },
    })), false);
  });

  it('canSkip returns false after non-clean code-review loopback even when plans exist', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx({
      artifacts: {
        return_to_ralplan_reason: 'Review requested a plan update.',
        review_verdict: { recommendation: 'REQUEST CHANGES', architectural_status: 'CLEAR', clean: false },
      },
    })), false);
  });

  it('canSkip returns false when nested code-review artifacts are non-clean', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx({
      artifacts: {
        'code-review': {
          review_verdict: { recommendation: 'COMMENT', architectural_status: 'CLEAR', clean: true },
          return_to_ralplan_reason: null,
        },
      },
    })), false);
  });

  it('surfaces deep-interview specs in ralplan artifacts for downstream traceability', async () => {
    const specsDir = join(tempDir, '.omx', 'specs');
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, 'deep-interview-my-feature.md'), '# Deep Interview Spec\n');

    const stage = createRalplanStage();
    const result = await stage.run(makeCtx());
    const artifacts = result.artifacts as Record<string, unknown>;

    assert.deepEqual(artifacts.deepInterviewSpecPaths, [join(specsDir, 'deep-interview-my-feature.md')]);
    assert.equal(artifacts.planningComplete, false);
  });

  it('can execute a real ralplan runtime when an executor is provided', async () => {
    const stage = createRalplanStage({
      executor: {
        async draft() {
          const plansDir = join(tempDir, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-runtime.md');
          await writeFile(prdPath, '# Runtime Plan\n');
          await writeFile(join(plansDir, 'test-spec-runtime.md'), '# Runtime Tests\n');
          return { summary: 'drafted', planPath: prdPath, artifacts: { runtimeDrafted: true } };
        },
        async architectReview() {
          return { verdict: 'approve', summary: 'architect ok' };
        },
        async criticReview() {
          return { verdict: 'approve', summary: 'critic ok' };
        },
      },
    });

    const result = await stage.run(makeCtx({ task: 'live ralplan run' }));
    const artifacts = result.artifacts as Record<string, unknown>;

    assert.equal(result.status, 'completed');
    assert.equal(result.error, undefined);
    assert.equal(artifacts.runtime, true);
    assert.equal(artifacts.planningComplete, true);
    assert.deepEqual(artifacts.ralplanConsensusGate, {
      complete: true,
      sequence: ['architect-review', 'critic-review'],
      ralplan_architect_review: { agent_role: 'architect', iteration: 1, verdict: 'approve', summary: 'architect ok' },
      ralplan_critic_review: { agent_role: 'critic', iteration: 1, verdict: 'approve', summary: 'critic ok' },
      source: 'runtime-result',
      blockedReason: null,
    });
    assert.equal(artifacts.iteration, 1);
    assert.equal(artifacts.runtimeDrafted, true);
  });

  it('fails runtime handoff when consensus approves but test spec does not match selected PRD', async () => {
    const stage = createRalplanStage({
      executor: {
        async draft() {
          const plansDir = join(tempDir, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-new.md');
          await writeFile(prdPath, '# New runtime plan\n');
          await writeFile(join(plansDir, 'test-spec-old.md'), '# Stale runtime tests\n');
          return { summary: 'drafted mismatched artifacts', planPath: prdPath };
        },
        async architectReview() {
          return { verdict: 'approve', summary: 'architect ok' };
        },
        async criticReview() {
          return { verdict: 'approve', summary: 'critic ok' };
        },
      },
    });

    const result = await stage.run(makeCtx({ task: 'live ralplan mismatched artifacts' }));
    const artifacts = result.artifacts as Record<string, unknown>;

    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'ralplan_planning_artifacts_missing_after_consensus');
    assert.equal(artifacts.planningComplete, false);
    assert.equal((artifacts.ralplanConsensusGate as { complete?: boolean }).complete, true);
  });

  it('fails runtime handoff when consensus approves but required planning artifacts are missing', async () => {
    const stage = createRalplanStage({
      executor: {
        async draft() {
          return { summary: 'draft without files' };
        },
        async architectReview() {
          return { verdict: 'approve', summary: 'architect ok' };
        },
        async criticReview() {
          return { verdict: 'approve', summary: 'critic ok' };
        },
      },
    });

    const result = await stage.run(makeCtx({ task: 'live ralplan no artifacts' }));
    const artifacts = result.artifacts as Record<string, unknown>;

    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'ralplan_planning_artifacts_missing_after_consensus');
    assert.equal(artifacts.planningComplete, false);
    assert.equal((artifacts.ralplanConsensusGate as { complete?: boolean }).complete, true);
  });

  it('fails runtime handoff when Critic has not approved after Architect', async () => {
    const stage = createRalplanStage({
      executor: {
        async draft() {
          const plansDir = join(tempDir, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-runtime.md');
          await writeFile(prdPath, '# Runtime Plan\n');
          await writeFile(join(plansDir, 'test-spec-runtime.md'), '# Runtime Tests\n');
          return { summary: 'drafted', planPath: prdPath };
        },
        async architectReview() {
          return { verdict: 'approve', summary: 'architect ok' };
        },
        async criticReview() {
          return { verdict: 'iterate', summary: 'critic needs changes' };
        },
      },
      maxIterations: 1,
    });

    const result = await stage.run(makeCtx({ task: 'live ralplan run' }));
    const artifacts = result.artifacts as Record<string, unknown>;

    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'ralplan_consensus_not_reached_after_1_iterations');
    assert.deepEqual(artifacts.ralplanConsensusGate, {
      complete: false,
      sequence: ['architect-review', 'critic-review'],
      ralplan_architect_review: null,
      ralplan_critic_review: null,
      source: null,
      blockedReason: 'missing_sequential_architect_then_critic_approval',
    });
  });

  it('canSkip returns false for non-prd plan files', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'autopilot-spec.md'), '# Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx()), false);
  });
});

// ---------------------------------------------------------------------------
// Team exec stage tests
// ---------------------------------------------------------------------------

describe('Team Exec Stage', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('creates a stage with the correct name', () => {
    const stage = createTeamExecStage();
    assert.equal(stage.name, 'team-exec');
  });

  it('uses default worker count and agent type', async () => {
    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx());

    assert.equal(result.status, 'completed');
    const arts = result.artifacts as Record<string, unknown>;
    assert.equal(arts.workerCount, 2);
    assert.equal(arts.agentType, 'executor');
  });

  it('respects custom worker count and agent type', async () => {
    const stage = createTeamExecStage({ workerCount: 4, agentType: 'architect' });
    const result = await stage.run(makeCtx());
    const runtimeCliInput = decodeRuntimeCliInstructionPayload(
      (result.artifacts as Record<string, unknown>).instruction as string,
    );

    const arts = result.artifacts as Record<string, unknown>;
    assert.equal(arts.workerCount, 4);
    assert.equal(arts.agentType, 'architect');
    assert.equal(runtimeCliInput.agentType, 'architect');
  });

  it('derives the team-exec task from a relative latest approved PRD handoff path', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const approvedPrdPath = join(plansDir, 'prd-zeta.md');
    const approvedTestSpecPath = join(plansDir, 'test-spec-zeta.md');
    await writeFile(
      approvedPrdPath,
      [
        '# Zeta plan',
        '',
        buildContextPackOutcome(canonicalContextPackRelativePath('zeta')),
        '',
        'Launch via omx team 5:debugger "Execute zeta handoff"',
      ].join('\n'),
    );
    await writeFile(approvedTestSpecPath, '# Zeta test spec\n');
    await writeReadyContextPack(tempDir, 'zeta', approvedPrdPath, approvedTestSpecPath);

    const previousCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      const stage = createTeamExecStage();
      const result = await stage.run(makeCtx({
        task: 'original request task',
        artifacts: {
          ralplan: {
            task: 'original request task',
            data: 'plan-content',
            stage: 'ralplan',
            latestPlanPath: join('.omx', 'plans', 'prd-zeta.md'),
          },
        },
      }));

      assert.equal(result.status, 'completed');
      const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
      const instruction = (result.artifacts as Record<string, unknown>).instruction as string;
      const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);
      assert.equal(descriptor.task, 'Execute zeta handoff');
      assert.deepEqual(descriptor.approvedExecution, {
        prd_path: approvedPrdPath,
        task: 'Execute zeta handoff',
        command: 'omx team 5:debugger "Execute zeta handoff"',
      });
      assert.match(instruction, /Execute zeta handoff/);
      assert.doesNotMatch(instruction, /plan-content/);
      assert.ok(Array.isArray(descriptor.availableAgentTypes));
      assert.ok((descriptor.availableAgentTypes as unknown[]).length > 0);
      assert.equal(typeof (descriptor.staffingPlan as Record<string, unknown>).staffingSummary, 'string');
      assert.equal(runtimeCliInput.task, 'Execute zeta handoff');
      assert.deepEqual(runtimeCliInput.approvedExecution, descriptor.approvedExecution);
      assert.equal(runtimeCliInput.workerCount, 2);
      assert.equal(runtimeCliInput.agentType, 'executor');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('derives the team-exec task from the selected approved PRD when a newer draft is incomplete', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const approvedPrdPath = join(plansDir, 'prd-zeta.md');
    const approvedTestSpecPath = join(plansDir, 'test-spec-zeta.md');
    await writeFile(
      approvedPrdPath,
      [
        '# Zeta plan',
        '',
        buildContextPackOutcome(canonicalContextPackRelativePath('zeta')),
        '',
        'Launch via omx team 5:debugger "Execute zeta handoff"',
      ].join('\n'),
    );
    await writeFile(approvedTestSpecPath, '# Zeta test spec\n');
    await writeReadyContextPack(tempDir, 'zeta', approvedPrdPath, approvedTestSpecPath);
    await writeFile(join(plansDir, 'prd-zulu.md'), '# Zulu draft\n\nNo approved team launch here.\n');

    const previousCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      const stage = createTeamExecStage();
      const result = await stage.run(makeCtx({
        task: 'original request task',
        artifacts: {
          ralplan: {
            task: 'original request task',
            stage: 'ralplan',
            latestPlanPath: join('.omx', 'plans', 'prd-zeta.md'),
          },
        },
      }));

      assert.equal(result.status, 'completed');
      const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
      const instruction = (result.artifacts as Record<string, unknown>).instruction as string;
      const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);
      assert.equal(descriptor.task, 'Execute zeta handoff');
      assert.deepEqual(descriptor.approvedExecution, {
        prd_path: approvedPrdPath,
        task: 'Execute zeta handoff',
        command: 'omx team 5:debugger "Execute zeta handoff"',
      });
      assert.deepEqual(runtimeCliInput.approvedExecution, descriptor.approvedExecution);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('skips newer incomplete runtime drafts when selecting the approved team handoff', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const approvedPrdPath = join(plansDir, 'prd-zeta.md');
    const approvedTestSpecPath = join(plansDir, 'test-spec-zeta.md');
    await writeFile(
      approvedPrdPath,
      [
        '# Zeta plan',
        '',
        buildContextPackOutcome(canonicalContextPackRelativePath('zeta')),
        '',
        'Launch via omx team 5:debugger "Execute zeta handoff"',
      ].join('\n'),
    );
    await writeFile(approvedTestSpecPath, '# Zeta test spec\n');
    await writeReadyContextPack(tempDir, 'zeta', approvedPrdPath, approvedTestSpecPath);
    const incompleteDraftPath = join(plansDir, 'prd-zulu.md');
    await writeFile(incompleteDraftPath, '# Zulu draft\n\nNo approved team launch here.\n');

    const previousCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      const stage = createTeamExecStage();
      const result = await stage.run(makeCtx({
        task: 'original request task',
        artifacts: {
          ralplan: {
            task: 'original request task',
            stage: 'ralplan',
            latestPlanPath: join('.omx', 'plans', 'prd-zeta.md'),
            drafts: [
              { planPath: join('.omx', 'plans', 'prd-zeta.md') },
              { planPath: join('.omx', 'plans', 'prd-zulu.md') },
            ],
          },
        },
      }));

      assert.equal(result.status, 'completed');
      const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
      const instruction = (result.artifacts as Record<string, unknown>).instruction as string;
      const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);
      assert.equal(descriptor.task, 'Execute zeta handoff');
      assert.deepEqual(descriptor.approvedExecution, {
        prd_path: approvedPrdPath,
        task: 'Execute zeta handoff',
        command: 'omx team 5:debugger "Execute zeta handoff"',
      });
      assert.doesNotMatch(instruction, new RegExp(escapeRegExp(incompleteDraftPath)));
      assert.deepEqual(runtimeCliInput.approvedExecution, descriptor.approvedExecution);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('reuses baseline-only approved handoffs for team-exec', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const approvedPrdPath = join(plansDir, 'prd-plan-only.md');
    await writeFile(
      approvedPrdPath,
      '# Plan-only plan\n\nLaunch via omx team 5:debugger "Execute plan-only team handoff"\n',
    );
    await writeFile(join(plansDir, 'test-spec-plan-only.md'), '# Plan-only test spec\n');
    await writeFile(join(plansDir, 'repo-context-plan-only.md'), 'Baseline repo summary may reach workers.\n');

    const previousCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      const stage = createTeamExecStage();
      const result = await stage.run(makeCtx({
        task: 'original request task',
        artifacts: {
          ralplan: {
            task: 'original request task',
            stage: 'ralplan',
            latestPlanPath: join('.omx', 'plans', 'prd-plan-only.md'),
          },
        },
      }));

      assert.equal(result.status, 'completed');
      const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
      const instruction = (result.artifacts as Record<string, unknown>).instruction as string;
      const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);
      assert.equal(descriptor.task, 'Execute plan-only team handoff');
      assert.deepEqual(descriptor.approvedExecution, {
        prd_path: approvedPrdPath,
        task: 'Execute plan-only team handoff',
        command: 'omx team 5:debugger "Execute plan-only team handoff"',
      });
      assert.equal(runtimeCliInput.task, 'Execute plan-only team handoff');
      assert.deepEqual(runtimeCliInput.approvedExecution, descriptor.approvedExecution);
      assert.equal(
        (runtimeCliInput.decompositionMetadata as Record<string, unknown> | undefined)?.approved_context_summary,
        undefined,
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('blocks team-exec when the selected approved handoff is missing its baseline', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-missing-baseline.md'),
      '# Missing-baseline plan\n\nLaunch via omx team 5:debugger "Execute missing-baseline team handoff"\n',
    );

    const previousCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      const stage = createTeamExecStage();
      const result = await stage.run(makeCtx({
        task: 'original request task',
        artifacts: {
          ralplan: {
            task: 'original request task',
            stage: 'ralplan',
            latestPlanPath: join('.omx', 'plans', 'prd-issue-missing-baseline.md'),
          },
        },
      }));
      assert.equal(result.status, 'failed');
      assert.match(
        result.error ?? '',
        /team_exec_approved_handoff_missing:.*prd-issue-missing-baseline\.md/,
      );
      assert.deepEqual(result.artifacts, {});
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('ignores obsolete context-pack markers when a matching test spec baseline exists', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-nonready.md'),
      [
        '# Nonready plan',
        '',
        '## Context Pack Outcome',
        '',
        '- pack: created `.omx/context/context-20260507T120000Z-other.json`',
        '',
        'Launch via omx team 5:debugger "Execute nonready team handoff"',
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-issue-nonready.md'), '# Nonready test spec\n');

    const previousCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      const stage = createTeamExecStage();
      const result = await stage.run(makeCtx({
        task: 'original request task',
        artifacts: {
          ralplan: {
            task: 'original request task',
            stage: 'ralplan',
            latestPlanPath: join('.omx', 'plans', 'prd-issue-nonready.md'),
          },
        },
      }));
      assert.equal(result.status, 'completed');
      const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
      assert.equal(descriptor.task, 'Execute nonready team handoff');
      assert.deepEqual(descriptor.approvedExecution, {
        prd_path: join(plansDir, 'prd-issue-nonready.md'),
        task: 'Execute nonready team handoff',
        command: 'omx team 5:debugger "Execute nonready team handoff"',
      });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('derives the team-exec task when latestPlanPath is already cwd-prefixed', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-zeta.md'),
      '# Zeta plan\n\nLaunch via omx team 5:debugger "Execute zeta handoff"\n',
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta test spec\n');

    const relativeCwd = basename(tempDir);
    const previousCwd = process.cwd();
    try {
      process.chdir(dirname(tempDir));
      const stage = createTeamExecStage();
      const result = await stage.run(makeCtx({
        cwd: relativeCwd,
        task: 'original request task',
        artifacts: {
          ralplan: {
            task: 'original request task',
            stage: 'ralplan',
            latestPlanPath: join(relativeCwd, '.omx', 'plans', 'prd-zeta.md'),
          },
        },
      }));

      assert.equal(result.status, 'completed');
      const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
      assert.equal(descriptor.task, 'Execute zeta handoff');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('derives the team-exec task when latestPlanPath resolves through equivalent relative segments', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-zeta.md'),
      '# Zeta plan\n\nLaunch via omx team 5:debugger "Execute zeta handoff"\n',
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta test spec\n');

    const relativeCwd = basename(tempDir);
    const previousCwd = process.cwd();
    try {
      process.chdir(dirname(tempDir));
      const stage = createTeamExecStage();
      const result = await stage.run(makeCtx({
        cwd: relativeCwd,
        task: 'original request task',
        artifacts: {
          ralplan: {
            task: 'original request task',
            stage: 'ralplan',
            latestPlanPath: join('..', relativeCwd, '.omx', 'plans', 'prd-zeta.md'),
          },
        },
      }));

      assert.equal(result.status, 'completed');
      const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
      assert.equal(descriptor.task, 'Execute zeta handoff');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('derives the team-exec task from single-quoted approved handoff text with escapes', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-zeta.md'),
      "# Zeta plan\n\nLaunch via $team 2:executor 'Fix Bob\\'s regression'\n",
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta test spec\n');

    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'original request task',
      artifacts: {
        ralplan: {
          task: 'original request task',
          stage: 'ralplan',
          latestPlanPath: join('.omx', 'plans', 'prd-zeta.md'),
        },
      },
    }));

    assert.equal(result.status, 'completed');
    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    const instruction = (result.artifacts as Record<string, unknown>).instruction as string;
    assert.equal(descriptor.task, "Fix Bob's regression");
    assert.match(instruction, /Fix Bob's regression/);
    assert.doesNotMatch(instruction, /Fix Bob\\'s regression/);
  });

  it('preserves literal backslashes in single-quoted approved handoff text', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const expectedTask = String.raw`Fix C:\\tmp and keep \n literal`;
    await writeFile(
      join(plansDir, 'prd-zeta.md'),
      `# Zeta plan\n\nLaunch via $team 2:executor ${encodeApprovedExecutionTask(expectedTask, 'single')}\n`,
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta test spec\n');

    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'original request task',
      artifacts: {
        ralplan: {
          task: 'original request task',
          stage: 'ralplan',
          latestPlanPath: join('.omx', 'plans', 'prd-zeta.md'),
        },
      },
    }));

    assert.equal(result.status, 'completed');
    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    const instruction = (result.artifacts as Record<string, unknown>).instruction as string;
    assert.equal(descriptor.task, expectedTask);
    assert.ok(instruction.includes(JSON.stringify(expectedTask)));
  });

  it('preserves literal backslashes in double-quoted approved handoff text', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const expectedTask = String.raw`Use C:\tmp and keep \n literal plus "quotes"`;
    await writeFile(
      join(plansDir, 'prd-zeta.md'),
      `# Zeta plan\n\nLaunch via omx team 2:executor ${encodeApprovedExecutionTask(expectedTask, 'double')}\n`,
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta test spec\n');

    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'original request task',
      artifacts: {
        ralplan: {
          task: 'original request task',
          stage: 'ralplan',
          latestPlanPath: join('.omx', 'plans', 'prd-zeta.md'),
        },
      },
    }));

    assert.equal(result.status, 'completed');
    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    const instruction = (result.artifacts as Record<string, unknown>).instruction as string;
    assert.equal(descriptor.task, expectedTask);
    assert.ok(instruction.includes(JSON.stringify(expectedTask)));
  });

  it('derives the team-exec task from the latest ralplan draft when numeric PRD slugs sort lexically out of order', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-issue-9.md'),
      '# Issue 9 plan\n\nLaunch via omx team 2:executor "Execute issue 9 handoff"\n',
    );
    await writeFile(join(plansDir, 'test-spec-issue-9.md'), '# Issue 9 test spec\n');
    await writeFile(
      join(plansDir, 'prd-issue-10.md'),
      '# Issue 10 plan\n\nLaunch via omx team 3:debugger "Execute issue 10 handoff"\n',
    );
    await writeFile(join(plansDir, 'test-spec-issue-10.md'), '# Issue 10 test spec\n');

    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'original request task',
      artifacts: {
        ralplan: {
          task: 'original request task',
          stage: 'ralplan',
          latestPlanPath: join('.omx', 'plans', 'prd-issue-10.md'),
          drafts: [
            { planPath: join('.omx', 'plans', 'prd-issue-9.md') },
            { planPath: join('.omx', 'plans', 'prd-issue-10.md') },
          ],
        },
      },
    }));

    assert.equal(result.status, 'completed');
    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    assert.equal(descriptor.task, 'Execute issue 10 handoff');
  });

  it('fails closed when latestPlanPath is not the selected latest approved PRD', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const stalePrdPath = join(plansDir, 'prd-alpha.md');
    await writeFile(
      stalePrdPath,
      '# Alpha plan\n\nLaunch via omx team 2:executor "Execute alpha handoff"\n',
    );
    await writeFile(join(plansDir, 'test-spec-alpha.md'), '# Alpha test spec\n');
    await writeFile(
      join(plansDir, 'prd-zeta.md'),
      '# Zeta plan\n\nLaunch via omx team 5:debugger "Execute zeta handoff"\n',
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta test spec\n');

    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'original request task',
      artifacts: {
        ralplan: {
          task: 'original request task',
          data: 'plan-content',
          stage: 'ralplan',
          latestPlanPath: stalePrdPath,
        },
      },
    }));

    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /team_exec_approved_handoff_stale:/);
    assert.deepEqual(result.artifacts, {});
  });

  it('keeps structural ralplan handoffs on the generic task path', async () => {
    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'structural pipeline task',
      artifacts: {
        ralplan: {
          task: 'structural pipeline task',
          data: 'plan-content',
          stage: 'ralplan',
          plansDir: join(tempDir, '.omx', 'plans'),
          specsDir: join(tempDir, '.omx', 'specs'),
          prdPaths: [],
          testSpecPaths: [],
          deepInterviewSpecPaths: [],
          planningComplete: false,
        },
      },
    }));

    assert.equal(result.status, 'completed');
    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    const instruction = (result.artifacts as Record<string, unknown>).instruction as string;
    const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);
    assert.equal(descriptor.task, 'structural pipeline task');
    assert.equal(descriptor.approvedExecution, null);
    assert.match(instruction, /structural pipeline task/);
    assert.doesNotMatch(instruction, /plan-content/);
    assert.equal(runtimeCliInput.task, 'structural pipeline task');
    assert.equal(runtimeCliInput.approvedExecution, null);
  });

  it('does not adopt a pre-existing approved plan when latestPlanPath is absent', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, 'prd-zeta.md'),
      '# Zeta plan\n\nLaunch via omx team 5:debugger "Execute zeta handoff"\n',
    );
    await writeFile(join(plansDir, 'test-spec-zeta.md'), '# Zeta test spec\n');

    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'generic pipeline task',
      artifacts: {
        ralplan: {
          task: 'generic pipeline task',
          stage: 'ralplan',
          prdPaths: [join(plansDir, 'prd-zeta.md')],
          testSpecPaths: [join(plansDir, 'test-spec-zeta.md')],
          planningComplete: true,
        },
      },
    }));

    assert.equal(result.status, 'completed');
    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    const instruction = (result.artifacts as Record<string, unknown>).instruction as string;
    const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);
    assert.equal(descriptor.task, 'generic pipeline task');
    assert.equal(descriptor.approvedExecution, null);
    assert.match(instruction, /generic pipeline task/);
    assert.doesNotMatch(instruction, /Execute zeta handoff/);
    assert.equal(runtimeCliInput.task, 'generic pipeline task');
    assert.equal(runtimeCliInput.approvedExecution, null);
  });

  it('fails closed when latestPlanPath has no team launch hint', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const prdPath = join(plansDir, 'prd-no-team-hint.md');
    await writeFile(prdPath, '# PRD\n\nNo team launch hint here.\n');

    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'original request task',
      artifacts: {
        ralplan: {
          task: 'original request task',
          stage: 'ralplan',
          latestPlanPath: prdPath,
        },
      },
    }));

    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /team_exec_approved_handoff_missing:/);
  });

  it('fails closed when latestPlanPath has ambiguous team launch hints', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const prdPath = join(plansDir, 'prd-ambiguous-team-hint.md');
    await writeFile(
      prdPath,
      [
        '# PRD',
        '',
        'Launch via omx team 2:executor "Execute first handoff"',
        'Launch via omx team 2:executor "Execute second handoff"',
      ].join('\n'),
    );
    await writeFile(join(plansDir, 'test-spec-ambiguous-team-hint.md'), '# Test spec\n');

    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({
      task: 'original request task',
      artifacts: {
        ralplan: {
          task: 'original request task',
          stage: 'ralplan',
          latestPlanPath: prdPath,
        },
      },
    }));

    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /team_exec_approved_handoff_ambiguous:/);
  });

  it('falls back to raw task when no ralplan artifacts exist', async () => {
    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({ task: 'raw task description' }));

    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    assert.equal(descriptor.task, 'raw task description');
    assert.equal(typeof (descriptor.staffingPlan as Record<string, unknown>).staffingSummary, 'string');
  });

  describe('buildTeamInstruction', () => {
    it('builds correct runtime-cli instruction', () => {
      const staffingPlan = buildFollowupStaffingPlan('team', 'implement feature', ['executor', 'test-engineer'], {
        workerCount: 3,
      });
      const instruction = buildTeamInstruction({
        task: 'implement feature',
        workerCount: 3,
        agentType: 'executor',
        availableAgentTypes: ['executor', 'test-engineer'],
        staffingPlan,
        useWorktrees: false,
        cwd: '/tmp/test',
        approvedExecution: null,
      });
      const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);

      assert.match(instruction, /runtime-cli\.js/);
      assert.match(instruction, /--input-json-base64/);
      assert.match(
        instruction,
        new RegExp(escapeRegExp(join(packageRoot(), 'dist', 'team', 'runtime-cli.js'))),
      );
      assert.doesNotMatch(
        instruction,
        new RegExp(escapeRegExp(join('/tmp/test', 'dist', 'team', 'runtime-cli.js'))),
      );
      assert.equal(runtimeCliInput.teamName, 'implement-feature');
      assert.equal(runtimeCliInput.workerCount, 3);
      assert.equal(runtimeCliInput.agentType, 'executor');
      assert.equal('agentTypes' in runtimeCliInput, false);
      assert.equal(runtimeCliInput.cwd, '/tmp/test');
      assert.ok(Array.isArray(runtimeCliInput.tasks));
      assert.equal((runtimeCliInput.tasks as unknown[]).length > 0, true);
      assert.equal(runtimeCliInput.task, 'implement feature');
      assert.equal(runtimeCliInput.approvedExecution, null);
      assert.equal('useWorktrees' in runtimeCliInput, false);
      assert.equal(
        (runtimeCliInput.decompositionMetadata as Record<string, unknown>).decomposition_source,
        'legacy_text',
      );
      assert.match(instruction, /staffing=/);
      assert.match(instruction, /verify=/);
    });

    it('still emits a launch instruction for long task descriptions', () => {
      const longTask = 'a'.repeat(1000);
      const staffingPlan = buildFollowupStaffingPlan('team', longTask, ['executor', 'test-engineer'], {
        workerCount: 1,
      });
      const instruction = buildTeamInstruction({
        task: longTask,
        workerCount: 1,
        agentType: 'executor',
        availableAgentTypes: ['executor', 'test-engineer'],
        staffingPlan,
        useWorktrees: false,
        cwd: '/tmp',
        approvedExecution: null,
      });
      const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);

      assert.match(instruction, /runtime-cli\.js/);
      assert.match(instruction, /--input-json-base64/);
      assert.equal(runtimeCliInput.task, longTask);
      assert.equal(runtimeCliInput.approvedExecution, null);
      assert.equal(runtimeCliInput.workerCount, 1);
      assert.equal(runtimeCliInput.agentType, 'executor');
      assert.match(instruction, /staffing=/);
    });

    it('keeps Windows instructions free of POSIX launch comments', () => {
      const task = `fix "quoted" paths, keep it's 100% safe & support café 运行时`;
      const staffingPlan = buildFollowupStaffingPlan('team', task, ['executor', 'test-engineer'], {
        workerCount: 1,
      });
      const instruction = buildTeamInstruction({
        task,
        workerCount: 1,
        agentType: 'executor',
        availableAgentTypes: ['executor', 'test-engineer'],
        staffingPlan,
        useWorktrees: false,
        cwd: 'C:\\repo with spaces',
        approvedExecution: null,
      }, { platform: 'win32' });
      const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);
      const commandPrefix = instruction.split('--input-json-base64')[0] ?? '';
      const encodedPayload = instruction.match(/--input-json-base64\s+([A-Za-z0-9_-]+)/)?.[1] ?? '';

      assert.match(instruction, /^"[^"]+"\s+"[^"]*runtime-cli\.js"\s+--input-json-base64\s+[A-Za-z0-9_-]+/);
      assert.equal(commandPrefix.includes("'"), false);
      assert.doesNotMatch(encodedPayload, /[%&|<>"'\s]/);
      assert.doesNotMatch(instruction, /# staffing=/);
      assert.doesNotMatch(instruction, /# verify=/);
      assert.equal(runtimeCliInput.task, task);
      assert.equal(runtimeCliInput.approvedExecution, null);
      assert.equal(runtimeCliInput.workerCount, 1);
      assert.equal(runtimeCliInput.agentType, 'executor');
      assert.equal('agentTypes' in runtimeCliInput, false);
      assert.equal(runtimeCliInput.cwd, 'C:\\repo with spaces');
    });

    it('preserves approved DAG handoff tasks and metadata in the runtime-cli payload', async () => {
      const plansDir = join(tempDir, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      await writeFile(
        join(plansDir, 'prd-demo.md'),
        '# Demo\n\nLaunch via omx team 2:executor "Execute approved demo plan"\n',
      );
      await writeFile(join(plansDir, 'test-spec-demo.md'), '# Demo Test Spec\n');
      await writeFile(join(plansDir, 'team-dag-demo.json'), JSON.stringify({
        schema_version: 1,
        nodes: [
          {
            id: 'impl',
            lane: 'implementation',
            role: 'executor',
            subject: 'Implement runtime',
            description: 'Change runtime',
            filePaths: ['src/team/runtime.ts'],
            requires_code_change: true,
          },
          {
            id: 'verify',
            lane: 'verification',
            role: 'test-engineer',
            subject: 'Verify runtime',
            description: 'Cover runtime',
            depends_on: ['impl'],
          },
        ],
        worker_policy: { requested_count: 2, count_source: 'cli-explicit' },
      }));
      const staffingPlan = buildFollowupStaffingPlan('team', 'Execute approved demo plan', ['executor', 'test-engineer'], {
        workerCount: 2,
      });
      const instruction = buildTeamInstruction({
        task: 'Execute approved demo plan',
        workerCount: 2,
        agentType: 'executor',
        availableAgentTypes: ['executor', 'test-engineer'],
        staffingPlan,
        useWorktrees: false,
        cwd: tempDir,
        approvedExecution: null,
      });
      const runtimeCliInput = decodeRuntimeCliInstructionPayload(instruction);
      const tasks = runtimeCliInput.tasks as Array<Record<string, unknown>>;
      const decompositionMetadata = runtimeCliInput.decompositionMetadata as Record<string, unknown>;

      assert.equal(runtimeCliInput.teamName, 'execute-approved-demo-plan');
      assert.equal(runtimeCliInput.task, 'Execute approved demo plan');
      assert.equal(runtimeCliInput.approvedExecution, null);
      assert.equal(runtimeCliInput.workerCount, 2);
      assert.equal(runtimeCliInput.agentType, 'executor');
      assert.equal(tasks.length, 2);
      assert.equal(tasks[0]?.symbolic_id, 'impl');
      assert.deepEqual(tasks[1]?.symbolic_depends_on, ['impl']);
      assert.deepEqual(tasks[0]?.filePaths, ['src/team/runtime.ts']);
      assert.equal(tasks[0]?.lane, 'implementation');
      assert.equal(decompositionMetadata.decomposition_source, 'dag_sidecar');
      assert.deepEqual(decompositionMetadata.node_dependencies, {
        impl: [],
        verify: ['impl'],
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Ralph verify stage tests
// ---------------------------------------------------------------------------

describe('Ralph Verify Stage', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('creates a stage with the correct name', () => {
    const stage = createRalphVerifyStage();
    assert.equal(stage.name, 'ralph-verify');
  });

  it('uses default max iterations of 10', async () => {
    const stage = createRalphVerifyStage();
    const result = await stage.run(makeCtx());

    assert.equal(result.status, 'completed');
    const arts = result.artifacts as Record<string, unknown>;
    assert.equal(arts.maxIterations, 10);
  });

  it('respects custom max iterations', async () => {
    const stage = createRalphVerifyStage({ maxIterations: 25 });
    const result = await stage.run(makeCtx());

    const arts = result.artifacts as Record<string, unknown>;
    assert.equal(arts.maxIterations, 25);
  });

  it('includes team-exec artifacts in verification context', async () => {
    const stage = createRalphVerifyStage();
    const ctx = makeCtx({
      artifacts: {
        'team-exec': { teamDescriptor: { task: 'completed work' } },
      },
    });
    const result = await stage.run(ctx);

    const descriptor = (result.artifacts as Record<string, unknown>).verifyDescriptor as Record<string, unknown>;
    const execArtifacts = descriptor.executionArtifacts as Record<string, unknown>;
    assert.ok(execArtifacts.teamDescriptor);
    assert.ok(Array.isArray(descriptor.availableAgentTypes));
    assert.equal(typeof (descriptor.staffingPlan as Record<string, unknown>).staffingSummary, 'string');
  });

  it('preserves legacy verification context precedence over ralplan artifacts', async () => {
    const stage = createRalphVerifyStage();
    const result = await stage.run(makeCtx({
      artifacts: {
        ralplan: { plan: 'approved plan' },
        'team-exec': { teamDescriptor: { task: 'completed work' } },
      },
    }));

    const descriptor = (result.artifacts as Record<string, unknown>).verifyDescriptor as Record<string, unknown>;
    assert.deepEqual(descriptor.executionArtifacts, { teamDescriptor: { task: 'completed work' } });
  });

  describe('buildRalphInstruction', () => {
    it('includes max iterations in instruction', () => {
      const staffingPlan = buildFollowupStaffingPlan('ralph', 'verify feature', ['architect', 'executor', 'test-engineer']);
      const instruction = buildRalphInstruction({
        task: 'verify feature',
        maxIterations: 15,
        cwd: '/tmp',
        availableAgentTypes: ['architect', 'executor', 'test-engineer'],
        staffingPlan,
        executionArtifacts: {},
      });

      assert.match(instruction, /max_iterations=15/);
      assert.match(instruction, /^omx ralph /);
      assert.match(instruction, /verify feature/);
      assert.match(instruction, /staffing=/);
      assert.match(instruction, /verify=/);
    });

    it('still emits a launch instruction for long task descriptions', () => {
      const longTask = 'b'.repeat(500);
      const staffingPlan = buildFollowupStaffingPlan('ralph', longTask, ['architect', 'executor', 'test-engineer']);
      const instruction = buildRalphInstruction({
        task: longTask,
        maxIterations: 10,
        cwd: '/tmp',
        availableAgentTypes: ['architect', 'executor', 'test-engineer'],
        staffingPlan,
        executionArtifacts: {},
      });

      assert.match(instruction, /^omx ralph /);
      assert.match(instruction, /staffing=/);
    });
  });
});


// ---------------------------------------------------------------------------
// Strict Autopilot stage tests
// ---------------------------------------------------------------------------

describe('Explicit Legacy Ralph Stage', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('uses the explicit legacy phase name ralph', () => {
    assert.equal(createRalphStage().name, 'ralph');
  });

  it('uses ralplan artifacts as the primary explicit legacy Ralph execution input', async () => {
    const result = await createRalphStage().run(makeCtx({
      artifacts: {
        ralplan: { plan: 'approved plan' },
        'team-exec': { teamDescriptor: { task: 'legacy work' } },
      },
    }));

    const descriptor = (result.artifacts as Record<string, unknown>).verifyDescriptor as Record<string, unknown>;
    assert.deepEqual(descriptor.executionArtifacts, { plan: 'approved plan' });
  });
});


describe('Default Autopilot Ultragoal Stage Adapters', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('creates a deep-interview descriptor and instruction', async () => {
    const stage = createDeepInterviewStage();
    assert.equal(stage.name, 'deep-interview');
    const result = await stage.run(makeCtx());
    const artifacts = result.artifacts as Record<string, unknown>;
    assert.equal(artifacts.stage, 'deep-interview');
    assert.match(artifacts.instruction as string, /^\$deep-interview /);
    assert.match(buildDeepInterviewInstruction('clarify me'), /^\$deep-interview /);
  });

  it('creates an ultragoal descriptor with explicit team condition', async () => {
    const stage = createUltragoalStage();
    assert.equal(stage.name, 'ultragoal');
    const result = await stage.run(makeCtx({ artifacts: { ralplan: { plan: 'approved' } } }));
    const artifacts = result.artifacts as Record<string, unknown>;
    const descriptor = artifacts.ultragoalDescriptor as Record<string, unknown>;
    assert.equal(artifacts.stage, 'ultragoal');
    assert.deepEqual(descriptor.ralplanArtifacts, { plan: 'approved' });
    assert.match(artifacts.team_condition as string, /Launch \$team only inside an active Ultragoal story/);
    assert.match(buildUltragoalInstruction('execute me'), /^\$ultragoal /);
  });

  it('creates an ultraqa gate that fails closed without evidence and can record clean skips', async () => {
    const missingEvidence = await createUltraqaStage().run(makeCtx({
      artifacts: { ultragoal: { tests: 'passed' }, 'code-review': { review_verdict: { clean: true } } },
    }));
    const missingArtifacts = missingEvidence.artifacts as Record<string, unknown>;
    const missingVerdict = missingArtifacts.qa_verdict as Record<string, unknown>;
    assert.equal(missingVerdict.clean, false);
    assert.equal(missingArtifacts.return_to_ralplan_reason, 'UltraQA evidence missing; fail closed and return to ralplan.');

    const skipped = await createUltraqaStage({ skipped: true, summary: 'Docs-only change; QA not applicable.' }).run(makeCtx());
    const skippedArtifacts = skipped.artifacts as Record<string, unknown>;
    const skippedVerdict = skippedArtifacts.qa_verdict as Record<string, unknown>;
    assert.equal(skippedVerdict.clean, true);
    assert.equal(skippedVerdict.skipped, true);
    assert.equal(skippedArtifacts.return_to_ralplan_reason, null);
    assert.match(buildUltraqaInstruction('qa me'), /^\$ultraqa /);
  });
});

describe('Code Review Stage', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('creates a code-review stage that fails closed without review evidence', async () => {
    const stage = createCodeReviewStage();
    assert.equal(stage.name, 'code-review');
    const result = await stage.run(makeCtx({ artifacts: { ultragoal: { tests: 'passed' } } }));
    const artifacts = result.artifacts as Record<string, unknown>;
    const descriptor = artifacts.codeReviewDescriptor as Record<string, unknown>;
    assert.deepEqual(descriptor.executionArtifacts, { tests: 'passed' });
    const verdict = artifacts.review_verdict as Record<string, unknown>;
    assert.equal(result.status, 'completed');
    assert.equal(verdict.clean, false);
    assert.equal(verdict.recommendation, 'REQUEST CHANGES');
    assert.equal(verdict.architectural_status, 'BLOCK');
    assert.equal(artifacts.return_to_ralplan_reason, 'Code-review evidence missing; fail closed and return to ralplan.');
  });

  it('marks explicit approve and clear review evidence as clean', async () => {
    const stage = createCodeReviewStage({ recommendation: 'APPROVE', architecturalStatus: 'CLEAR' });
    const result = await stage.run(makeCtx({ artifacts: { ralph: { tests: 'passed' } } }));
    const artifacts = result.artifacts as Record<string, unknown>;
    const verdict = artifacts.review_verdict as Record<string, unknown>;
    assert.equal(verdict.clean, true);
    assert.equal(verdict.recommendation, 'APPROVE');
    assert.equal(verdict.architectural_status, 'CLEAR');
    assert.equal(artifacts.return_to_ralplan_reason, null);
  });

  it('marks non-clean review as return-to-ralplan input', async () => {
    const stage = createCodeReviewStage({ recommendation: 'REQUEST CHANGES', architecturalStatus: 'BLOCK', summary: 'fix review findings' });
    const result = await stage.run(makeCtx());
    const artifacts = result.artifacts as Record<string, unknown>;
    const verdict = artifacts.review_verdict as Record<string, unknown>;
    assert.equal(verdict.clean, false);
    assert.equal(artifacts.return_to_ralplan_reason, 'fix review findings');
  });

  it('builds a code-review instruction', () => {
    assert.match(buildCodeReviewInstruction('review me'), /^\$code-review /);
  });
});
