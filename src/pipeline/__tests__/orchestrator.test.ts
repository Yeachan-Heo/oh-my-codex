import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import { readModeState } from '../../modes/base.js';
import {
  runPipeline,
  canResumePipeline,
  readPipelineState,
  cancelPipeline,
  createAutopilotPipelineConfig,
  createStrictAutopilotStages,
} from '../orchestrator.js';
import { createRalplanStage } from '../stages/ralplan.js';
import { resolveGitScope, verifyScopeDrift } from '../../code-review/scope.js';
import * as pipelineIndex from '../index.js';
import type { PipelineConfig, PipelineStage, StageContext, StageResult } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStage(
  name: string,
  result: Partial<StageResult> = {},
  opts?: { canSkip?: (ctx: StageContext) => boolean; delay?: number },
): PipelineStage {
  return {
    name,
    canSkip: opts?.canSkip,
    async run(_ctx: StageContext): Promise<StageResult> {
      if (opts?.delay) await new Promise((r) => setTimeout(r, opts.delay));
      return {
        status: 'completed',
        artifacts: { produced_by: name },
        duration_ms: 0,
        ...result,
      };
    },
  };
}

function makeFailingStage(name: string, error: string): PipelineStage {
  return {
    name,
    async run(): Promise<StageResult> {
      return {
        status: 'failed',
        artifacts: {},
        duration_ms: 0,
        error,
      };
    },
  };
}

function makeThrowingStage(name: string, message: string): PipelineStage {
  return {
    name,
    async run(): Promise<StageResult> {
      throw new Error(message);
    },
  };
}

function cleanCodeReviewArtifact(): Record<string, unknown> {
  const scopeHash = 'a'.repeat(64);
  return {
    schema_version: 1,
    review_id: '22222222-2222-4222-8222-222222222222',
    revision: 7,
    status: 'FINALIZED',
    current_attempt: 1,
    scope: {
      selector: { explicit_paths: [] },
      status: 'FULL_SCOPE',
      scope_hash: scopeHash,
      files: [{
        path: 'src/example.ts',
        change: 'MODIFIED',
        sources: ['WORKTREE'],
        binary: false,
        additions: 1,
        deletions: 0,
      }],
      changed_lines: 1,
      reasons: [],
    },
    review_flags: [],
    batches: [{
      batch_id: 'batch-1',
      module_root: '.',
      files: ['src/example.ts'],
      changed_lines: 1,
      oversized_single_file: false,
    }],
    lanes: [
      {
        lane_id: 'reviewer-1',
        role: 'code-reviewer',
        batch_id: 'batch-1',
        scope_hash: scopeHash,
        status: 'COMPLETE',
        attempt: 1,
        recommendation: 'APPROVE',
        findings: [],
        diagnostic_ids: [],
      },
      {
        lane_id: 'architect-1',
        role: 'architect',
        batch_id: 'global',
        scope_hash: scopeHash,
        status: 'COMPLETE',
        attempt: 1,
        architectural_status: 'CLEAR',
        findings: [],
        diagnostic_ids: [],
      },
    ],
    diagnostics: [],
    verdict: {
      recommendation: 'APPROVE',
      architectural_status: 'CLEAR',
      scope_status: 'FULL_SCOPE',
      evidence_status: 'FULL_EVIDENCE',
      rule_id: 'CLEAN_APPROVAL',
      reasons: ['ALL_REQUIRED_EVIDENCE_CLEAR'],
      clean: true,
    },
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:01:00.000Z',
    finalized_at: '2026-07-15T00:01:00.000Z',
  };
}

function reviewArtifact(options: {
  reviewId: string;
  revision?: number;
  clean?: boolean;
  scopeHash?: string;
  finalizedAt?: string;
  supersedesReviewId?: string;
}): Record<string, unknown> {
  const artifact = JSON.parse(JSON.stringify(cleanCodeReviewArtifact())) as Record<string, unknown>;
  const clean = options.clean ?? true;
  const scopeHash = options.scopeHash ?? 'a'.repeat(64);
  artifact.review_id = options.reviewId;
  artifact.revision = options.revision ?? 1;
  artifact.status = clean ? 'FINALIZED' : 'BLOCKED';
  artifact.updated_at = options.finalizedAt ?? '2026-07-15T00:01:00.000Z';
  artifact.finalized_at = options.finalizedAt ?? '2026-07-15T00:01:00.000Z';
  if (options.supersedesReviewId !== undefined) {
    artifact.supersedes_review_id = options.supersedesReviewId;
  }
  const scope = artifact.scope as Record<string, unknown>;
  scope.scope_hash = scopeHash;
  const lanes = artifact.lanes as Array<Record<string, unknown>>;
  for (const lane of lanes) lane.scope_hash = scopeHash;
  const reviewer = lanes.find((lane) => lane.role === 'code-reviewer');
  if (reviewer) {
    reviewer.recommendation = clean ? 'APPROVE' : 'REQUEST CHANGES';
    reviewer.findings = clean ? [] : [{
      severity: 'HIGH',
      title: 'Implementation remains incomplete',
      body: 'The implementation evidence does not satisfy the review finding.',
      file: 'src/example.ts',
      start_line: 1,
      fix: 'Apply and verify the requested rework.',
    }];
  }
  artifact.verdict = {
    recommendation: clean ? 'APPROVE' : 'REQUEST CHANGES',
    architectural_status: 'CLEAR',
    scope_status: 'FULL_SCOPE',
    evidence_status: 'FULL_EVIDENCE',
    rule_id: clean ? 'CLEAN_APPROVAL' : 'LANE_REQUEST_CHANGES',
    reasons: clean ? ['ALL_REQUIRED_EVIDENCE_CLEAR'] : ['REVIEWER_REQUEST_CHANGES:reviewer-1'],
    clean,
  };
  return artifact;
}

async function persistReviewArtifact(artifact: Record<string, unknown>): Promise<{
  artifactPath: string;
  artifactReviewId: string;
  artifactSha256: string;
}> {
  const scope = await resolveGitScope({
    workingDirectory: tempDir,
    selector: { requested_base: 'HEAD', explicit_paths: [] },
  });
  artifact.scope = scope;
  for (const lane of artifact.lanes as Array<Record<string, unknown>>) {
    lane.scope_hash = scope.scope_hash;
  }
  const batch = (artifact.batches as Array<Record<string, unknown>>)[0];
  if (batch) {
    batch.files = scope.files.map((file) => file.path);
    batch.changed_lines = scope.changed_lines;
  }
  const artifactPath = `.omx/reviews/${String(artifact.review_id)}.json`;
  const raw = `${JSON.stringify(artifact, null, 2)}\n`;
  await mkdir(join(tempDir, '.omx', 'reviews'), { recursive: true });
  await writeFile(join(tempDir, artifactPath), raw);
  assert.equal((await verifyScopeDrift(scope, { workingDirectory: tempDir })).matches, true);
  return {
    artifactPath,
    artifactReviewId: String(artifact.review_id),
    artifactSha256: createHash('sha256').update(raw).digest('hex'),
  };
}

async function persistedStageArtifacts(artifact: Record<string, unknown>): Promise<Record<string, unknown>> {
  const persisted = await persistReviewArtifact(artifact);
  const verdict = artifact.verdict as Record<string, unknown>;
  return {
    review_verdict: {
      stage: 'code-review',
      clean: verdict.clean,
      recommendation: verdict.recommendation,
      architectural_status: verdict.architectural_status,
      artifact_path: persisted.artifactPath,
      artifact_sha256: persisted.artifactSha256,
    },
    code_review_artifact: artifact,
    code_review_artifact_identity: {
      review_id: artifact.review_id,
      revision: artifact.revision,
      artifact_path: persisted.artifactPath,
      artifact_sha256: persisted.artifactSha256,
    },
  };
}

async function persistReworkEvidence(
  sourceReview: Record<string, unknown>,
  reviewCycle = 1,
): Promise<Record<string, unknown>> {
  const executionId = '33333333-3333-4333-8333-333333333333';
  const implementationIdentity = {
    agent_role: 'executor',
    thread_id: 'thread-executor',
    produced_at: '2026-07-15T00:10:00.000Z',
  };
  const verificationIdentity = {
    agent_role: 'test-engineer',
    thread_id: 'thread-test',
    produced_at: '2026-07-15T00:12:00.000Z',
  };
  const implementation = {
    schema_version: 1,
    artifact_kind: 'rework_implementation',
    execution_id: executionId,
    review_cycle: reviewCycle,
    source_review: sourceReview,
    source_identity: implementationIdentity,
    changed_files: ['src/example.ts'],
    summary: 'Applied the blocking review findings.',
  };
  const verification = {
    schema_version: 1,
    artifact_kind: 'rework_verification',
    execution_id: executionId,
    review_cycle: reviewCycle,
    source_review: sourceReview,
    source_identity: verificationIdentity,
    checks: [{ command: 'npm test', exit_code: 0, source: 'local' }],
  };
  const reworkRoot = join(tempDir, '.omx', 'rework');
  await mkdir(reworkRoot, { recursive: true });
  const implementationRaw = `${JSON.stringify(implementation, null, 2)}\n`;
  const verificationRaw = `${JSON.stringify(verification, null, 2)}\n`;
  await writeFile(join(reworkRoot, 'implementation.json'), implementationRaw);
  await writeFile(join(reworkRoot, 'verification.json'), verificationRaw);
  return {
    schema_version: 1,
    review_cycle: reviewCycle,
    source_review: sourceReview,
    execution_id: executionId,
    implementation_artifact: {
      path: '.omx/rework/implementation.json',
      sha256: createHash('sha256').update(implementationRaw).digest('hex'),
      source_identity: implementationIdentity,
    },
    verification_artifact: {
      path: '.omx/rework/verification.json',
      sha256: createHash('sha256').update(verificationRaw).digest('hex'),
      source_identity: verificationIdentity,
    },
  };
}

let tempDir: string;
let savedOmxEnv: Pick<NodeJS.ProcessEnv, 'OMX_ROOT' | 'OMX_STATE_ROOT' | 'OMX_TEAM_STATE_ROOT' | 'OMX_SESSION_ID'>;

function clearAmbientOmxEnv(): void {
  savedOmxEnv = {
    OMX_ROOT: process.env.OMX_ROOT,
    OMX_STATE_ROOT: process.env.OMX_STATE_ROOT,
    OMX_TEAM_STATE_ROOT: process.env.OMX_TEAM_STATE_ROOT,
    OMX_SESSION_ID: process.env.OMX_SESSION_ID,
  };
  delete process.env.OMX_ROOT;
  delete process.env.OMX_STATE_ROOT;
  delete process.env.OMX_TEAM_STATE_ROOT;
  delete process.env.OMX_SESSION_ID;
}

function restoreAmbientOmxEnv(): void {
  for (const key of ['OMX_ROOT', 'OMX_STATE_ROOT', 'OMX_TEAM_STATE_ROOT', 'OMX_SESSION_ID'] as const) {
    const value = savedOmxEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function setup(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-pipeline-test-'));
  execFileSync('git', ['init', '-q'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.email', 'pipeline@example.invalid'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.name', 'Pipeline Test'], { cwd: tempDir });
  await mkdir(join(tempDir, 'src'), { recursive: true });
  await writeFile(join(tempDir, 'src', 'example.ts'), 'export const value = 1;\n');
  execFileSync('git', ['add', '--', 'src/example.ts'], { cwd: tempDir });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: tempDir });
  await writeFile(join(tempDir, 'src', 'example.ts'), 'export const value = 2;\n');
  return tempDir;
}

async function cleanup(): Promise<void> {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Pipeline Orchestrator', () => {
  beforeEach(async () => {
    clearAmbientOmxEnv();
    await setup();
  });

  afterEach(async () => {
    await cleanup();
    restoreAmbientOmxEnv();
  });

  describe('runPipeline', () => {
    it('runs a single-stage pipeline to completion', async () => {
      const config: PipelineConfig = {
        name: 'test-single',
        task: 'test task',
        stages: [makeStage('stage-a')],
        cwd: tempDir,
      };

      const result = await runPipeline(config);

      assert.equal(result.status, 'completed');
      assert.ok(result.stageResults['stage-a']);
      assert.equal(result.stageResults['stage-a'].status, 'completed');
      assert.ok(result.duration_ms >= 0);
    });

    it('runs a multi-stage pipeline sequentially', async () => {
      const order: string[] = [];
      const stages: PipelineStage[] = ['a', 'b', 'c'].map((name) => ({
        name: `stage-${name}`,
        async run(ctx: StageContext): Promise<StageResult> {
          order.push(`stage-${name}`);
          return {
            status: 'completed',
            artifacts: { step: name, prevArtifacts: Object.keys(ctx.artifacts) },
            duration_ms: 0,
          };
        },
      }));

      const result = await runPipeline({
        name: 'test-multi',
        task: 'multi-stage test',
        stages,
        cwd: tempDir,
      });

      assert.equal(result.status, 'completed');
      assert.deepEqual(order, ['stage-a', 'stage-b', 'stage-c']);
      assert.equal(Object.keys(result.stageResults).length, 3);
    });

    it('advances the default code-review adapter to ultraqa only from its persisted final artifact', async () => {
      const artifact = cleanCodeReviewArtifact();
      const persisted = await persistReviewArtifact(artifact);
      const { artifactPath, artifactSha256 } = persisted;
      const defaultConfig = createAutopilotPipelineConfig('consume final review', {
        cwd: tempDir,
        codeReviewArtifactPath: artifactPath,
        codeReviewArtifactReviewId: String(artifact.review_id),
        codeReviewArtifactSha256: artifactSha256,
      });
      const defaultCodeReview = defaultConfig.stages.find((stage) => stage.name === 'code-review');
      assert.ok(defaultCodeReview);
      const order: string[] = [];
      const observedCodeReview: PipelineStage = {
        name: 'code-review',
        async run(ctx): Promise<StageResult> {
          order.push('code-review');
          return await defaultCodeReview.run(ctx);
        },
      };
      const result = await runPipeline({
        name: 'real-review-artifact',
        task: 'consume final review',
        cwd: tempDir,
        stages: [
          makeStage('ralplan'),
          observedCodeReview,
          {
            name: 'ultraqa',
            async run(): Promise<StageResult> {
              order.push('ultraqa');
              return {
                status: 'completed',
                artifacts: {
                  qa_verdict: {
                    stage: 'ultraqa',
                    clean: true,
                    skipped: false,
                    url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/99',
                  },
                  return_to_ralplan_reason: null,
                },
                duration_ms: 0,
              };
            },
          },
        ],
      });

      assert.equal(result.status, 'completed', result.error ?? 'pipeline failed');
      assert.deepEqual(order, ['code-review', 'ultraqa']);
      const review = result.stageResults['code-review'].artifacts.review_verdict as Record<string, unknown>;
      assert.equal(review.clean, true);
      assert.equal(review.artifact_sha256, artifactSha256);
      const ext = await readPipelineState(tempDir);
      assert.deepEqual(
        (ext?.handoff_artifacts?.code_review as Record<string, unknown> | undefined)?.code_review_artifact_identity,
        {
          review_id: artifact.review_id,
          revision: artifact.revision,
          artifact_path: artifactPath,
          artifact_sha256: artifactSha256,
        },
      );
    });

    it('does not accept a self-described clean verdict without validated artifact identity', async () => {
      let qaRuns = 0;
      const result = await runPipeline({
        name: 'self-described-clean-review-test',
        task: 'reject self-described review verdict',
        stages: [
          makeStage('ralplan'),
          {
            name: 'code-review',
            async run(): Promise<StageResult> {
              return {
                status: 'completed',
                artifacts: {
                  review_verdict: {
                    clean: true,
                    recommendation: 'APPROVE',
                    architectural_status: 'CLEAR',
                    stage: 'code-review',
                    artifact_path: '.omx/reviews/99999999-9999-4999-8999-999999999999.json',
                    artifact_sha256: '9'.repeat(64),
                  },
                  suggested_next_phase: 'ultraqa',
                  return_to_ralplan_reason: null,
                },
                duration_ms: 0,
              };
            },
          },
          {
            name: 'ultraqa',
            async run(): Promise<StageResult> {
              qaRuns += 1;
              return {
                status: 'completed',
                artifacts: { qa_verdict: { stage: 'ultraqa', clean: true } },
                duration_ms: 0,
              };
            },
          },
        ],
        cwd: tempDir,
        maxRalphIterations: 1,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.failedStage, 'code-review');
      assert.equal(result.error, 'code_review_artifact_invalid_or_stale');
      assert.equal(qaRuns, 0);
    });

    it('returns to ralplan when code-review is not clean', async () => {
      const order: string[] = [];
      const transitions: Array<[string, string]> = [];
      let reviewRuns = 0;
      const stages: PipelineStage[] = [
        {
          name: 'ralplan',
          async run(): Promise<StageResult> {
            order.push('ralplan');
            return { status: 'completed', artifacts: { plan: `cycle-${order.length}` }, duration_ms: 0 };
          },
        },
        {
          name: 'ralph',
          async run(): Promise<StageResult> {
            order.push('ralph');
            return { status: 'completed', artifacts: { implemented: true }, duration_ms: 0 };
          },
        },
        {
          name: 'code-review',
          async run(): Promise<StageResult> {
            order.push('code-review');
            reviewRuns += 1;
            const clean = reviewRuns > 1;
            if (clean) {
              const artifact = reviewArtifact({
                reviewId: '33333333-3333-4333-8333-333333333333',
                clean: true,
              });
              return {
                status: 'completed',
                artifacts: {
                  ...(await persistedStageArtifacts(artifact)),
                  return_to_ralplan_reason: null,
                },
                duration_ms: 0,
              };
            }
            return {
              status: 'completed',
              artifacts: {
                review_verdict: {
                  recommendation: clean ? 'APPROVE' : 'REQUEST CHANGES',
                  architectural_status: 'CLEAR',
                  clean,
                  stage: 'code-review',
                  artifact_path: '.omx/reviews/review-loop.json',
                  artifact_sha256: '3'.repeat(64),
                },
                return_to_ralplan_reason: clean ? null : 'Review requested a plan update.',
              },
              duration_ms: 0,
            };
          },
        },
        {
          name: 'ultraqa',
          async run(): Promise<StageResult> {
            order.push('ultraqa');
            return {
              status: 'completed',
              artifacts: {
                qa_verdict: { stage: 'ultraqa', clean: true, skipped: false, url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/1' },
                return_to_ralplan_reason: null,
              },
              duration_ms: 0,
            };
          },
        },
      ];

      const result = await runPipeline({
        name: 'review-loop-test',
        task: 'loop until review clean',
        stages,
        cwd: tempDir,
        maxRalphIterations: 3,
        onStageTransition: (from, to) => transitions.push([from, to]),
      });

      assert.equal(result.status, 'completed', result.error ?? 'pipeline failed');
      assert.deepEqual(order, ['ralplan', 'ralph', 'code-review', 'ralplan', 'ralph', 'code-review', 'ultraqa']);
      assert.ok(transitions.some(([from, to]) => from === 'code-review' && to === 'ralplan'));

      const ext = await readPipelineState(tempDir);
      assert.equal(ext?.review_cycle, 1);
      assert.equal((ext?.review_verdict as { clean?: boolean } | undefined)?.clean, true);
      assert.equal(ext?.return_to_ralplan_reason, null);
      assert.ok(ext?.handoff_artifacts?.code_review);
      assert.equal(Object.prototype.hasOwnProperty.call(ext?.handoff_artifacts ?? {}, 'code-review'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(ext?.handoff_artifacts ?? {}, 'review_verdict'), false);
    });

    it('routes implementation findings through evidenced rework to a successor review', async () => {
      const order: string[] = [];
      const firstArtifact = reviewArtifact({
        reviewId: '11111111-1111-4111-8111-111111111111',
        revision: 7,
        clean: false,
        finalizedAt: '2026-07-15T00:01:00.000Z',
      });
      const firstArtifacts = await persistedStageArtifacts(firstArtifact);
      const firstReview = firstArtifacts.code_review_artifact_identity as Record<string, unknown>;
      const reworkEvidence = await persistReworkEvidence(firstReview);
      let reviewRuns = 0;
      const stages: PipelineStage[] = [
        {
          name: 'ralplan',
          async run(): Promise<StageResult> {
            order.push('ralplan');
            return { status: 'completed', artifacts: { plan: `cycle-${order.length}` }, duration_ms: 0 };
          },
        },
        {
          name: 'rework',
          canSkip: (ctx) => ctx.artifacts['code-review'] === undefined,
          async run(): Promise<StageResult> {
            order.push('rework');
            await writeFile(join(tempDir, 'src', 'example.ts'), 'export const value = 3;\n');
            return {
              status: 'completed',
              artifacts: { rework_evidence: reworkEvidence },
              duration_ms: 0,
            };
          },
        },
        {
          name: 'code-review',
          async run(): Promise<StageResult> {
            order.push('code-review');
            reviewRuns += 1;
            const clean = reviewRuns > 1;
            if (clean) {
              const successorArtifact = reviewArtifact({
                reviewId: '22222222-2222-4222-8222-222222222222',
                clean: true,
                finalizedAt: '2026-07-15T00:20:00.000Z',
                supersedesReviewId: String(firstReview.review_id),
              });
              return {
                status: 'completed',
                artifacts: {
                  ...(await persistedStageArtifacts(successorArtifact)),
                  suggested_next_phase: 'ultraqa',
                  return_to_ralplan_reason: null,
                },
                duration_ms: 0,
              };
            }
            return {
              status: 'completed',
              artifacts: {
                ...firstArtifacts,
                suggested_next_phase: 'rework',
                return_to_ralplan_reason: 'Implementation finding requires rework.',
              },
              duration_ms: 0,
            };
          },
        },
        {
          name: 'ultraqa',
          async run(): Promise<StageResult> {
            order.push('ultraqa');
            return {
              status: 'completed',
              artifacts: {
                qa_verdict: {
                  stage: 'ultraqa', clean: true, skipped: false,
                  url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/4',
                },
              },
              duration_ms: 0,
            };
          },
        },
      ];

      const result = await runPipeline({
        name: 'review-rework-test',
        task: 'route implementation findings',
        stages,
        cwd: tempDir,
        maxRalphIterations: 2,
      });

      assert.equal(result.status, 'completed');
      assert.deepEqual(order, ['ralplan', 'code-review', 'rework', 'code-review', 'ultraqa']);
      const ext = await readPipelineState(tempDir);
      assert.equal(ext?.return_to_ralplan_reason, null);
    });

    it('fails rework when fresh implementation and verification evidence is missing', async () => {
      let reviewRuns = 0;
      const blockingArtifacts = await persistedStageArtifacts(reviewArtifact({
        reviewId: '44444444-4444-4444-8444-444444444444',
        clean: false,
      }));
      const result = await runPipeline({
        name: 'review-rework-evidence-test',
        task: 'require rework evidence',
        stages: [
          makeStage('ralplan'),
          {
            name: 'rework',
            canSkip: (ctx) => ctx.artifacts['code-review'] === undefined,
            async run(): Promise<StageResult> {
              return { status: 'completed', artifacts: { instruction: '$ultragoal fix' }, duration_ms: 0 };
            },
          },
          {
            name: 'code-review',
            async run(): Promise<StageResult> {
              reviewRuns += 1;
              return {
                status: 'completed',
                artifacts: {
                  ...blockingArtifacts,
                  suggested_next_phase: 'rework',
                },
                duration_ms: 0,
              };
            },
          },
        ],
        cwd: tempDir,
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.failedStage, 'rework');
      assert.equal(result.error, 'rework_execution_evidence_missing_or_stale');
      assert.equal(reviewRuns, 1);
    });

    it('rejects reuse of the blocking review artifact after evidenced rework', async () => {
      const blockingArtifacts = await persistedStageArtifacts(reviewArtifact({
        reviewId: '55555555-5555-4555-8555-555555555555',
        revision: 3,
        clean: false,
      }));
      const identity = blockingArtifacts.code_review_artifact_identity as Record<string, unknown>;
      const reworkEvidence = await persistReworkEvidence(identity);
      let reviewRuns = 0;
      const result = await runPipeline({
        name: 'review-successor-identity-test',
        task: 'require successor review',
        stages: [
          makeStage('ralplan'),
          {
            name: 'rework',
            canSkip: (ctx) => ctx.artifacts['code-review'] === undefined,
            async run(): Promise<StageResult> {
              return {
                status: 'completed',
                artifacts: { rework_evidence: reworkEvidence },
                duration_ms: 0,
              };
            },
          },
          {
            name: 'code-review',
            async run(): Promise<StageResult> {
              reviewRuns += 1;
              return {
                status: 'completed',
                artifacts: {
                  ...blockingArtifacts,
                  suggested_next_phase: 'rework',
                },
                duration_ms: 0,
              };
            },
          },
          makeStage('ultraqa', { artifacts: { qa_verdict: { clean: true } } }),
        ],
        cwd: tempDir,
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.failedStage, 'code-review');
      assert.equal(result.error, 'successor_review_evidence_missing_or_reused');
      assert.equal(reviewRuns, 2);
    });

    it('rejects a correctly linked successor that is not newer than completed rework', async () => {
      const blockingArtifacts = await persistedStageArtifacts(reviewArtifact({
        reviewId: '77777777-7777-4777-8777-777777777777',
        revision: 2,
        clean: false,
      }));
      const blockingReview = blockingArtifacts.code_review_artifact_identity as Record<string, unknown>;
      const reworkEvidence = await persistReworkEvidence(blockingReview);
      let reviewRuns = 0;
      const result = await runPipeline({
        name: 'review-successor-scope-freshness-test',
        task: 'require successor review to bind post-rework scope',
        stages: [
          makeStage('ralplan'),
          {
            name: 'rework',
            canSkip: (ctx) => ctx.artifacts['code-review'] === undefined,
            async run(): Promise<StageResult> {
              return {
                status: 'completed',
                artifacts: { rework_evidence: reworkEvidence },
                duration_ms: 0,
              };
            },
          },
          {
            name: 'code-review',
            async run(): Promise<StageResult> {
              reviewRuns += 1;
              const clean = reviewRuns > 1;
              if (clean) {
                const staleSuccessor = reviewArtifact({
                  reviewId: '88888888-8888-4888-8888-888888888888',
                  clean: true,
                  finalizedAt: '2026-07-15T00:12:00.000Z',
                  supersedesReviewId: String(blockingReview.review_id),
                });
                return {
                  status: 'completed',
                  artifacts: {
                    ...(await persistedStageArtifacts(staleSuccessor)),
                    suggested_next_phase: 'ultraqa',
                    return_to_ralplan_reason: null,
                  },
                  duration_ms: 0,
                };
              }
              return {
                status: 'completed',
                artifacts: {
                  ...blockingArtifacts,
                  suggested_next_phase: 'rework',
                  return_to_ralplan_reason: 'Implementation finding requires rework.',
                },
                duration_ms: 0,
              };
            },
          },
          makeStage('ultraqa', { artifacts: { qa_verdict: { stage: 'ultraqa', clean: true } } }),
        ],
        cwd: tempDir,
        maxRalphIterations: 2,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.failedStage, 'code-review');
      assert.equal(result.error, 'successor_review_evidence_missing_or_reused');
      assert.equal(reviewRuns, 2);
    });

    it('rejects a clean successor that does not supersede the blocking review', async () => {
      const blockingArtifacts = await persistedStageArtifacts(reviewArtifact({
        reviewId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        revision: 2,
        clean: false,
      }));
      const blockingReview = blockingArtifacts.code_review_artifact_identity as Record<string, unknown>;
      const reworkEvidence = await persistReworkEvidence(blockingReview);
      let reviewRuns = 0;
      const result = await runPipeline({
        name: 'review-successor-linkage-test',
        task: 'require successor review linkage',
        stages: [
          makeStage('ralplan'),
          {
            name: 'rework',
            canSkip: (ctx) => ctx.artifacts['code-review'] === undefined,
            async run(): Promise<StageResult> {
              return {
                status: 'completed',
                artifacts: { rework_evidence: reworkEvidence },
                duration_ms: 0,
              };
            },
          },
          {
            name: 'code-review',
            async run(): Promise<StageResult> {
              reviewRuns += 1;
              if (reviewRuns > 1) {
                const unrelated = reviewArtifact({
                  reviewId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                  clean: true,
                  finalizedAt: '2026-07-15T00:20:00.000Z',
                });
                return {
                  status: 'completed',
                  artifacts: {
                    ...(await persistedStageArtifacts(unrelated)),
                    suggested_next_phase: 'ultraqa',
                    return_to_ralplan_reason: null,
                  },
                  duration_ms: 0,
                };
              }
              return {
                status: 'completed',
                artifacts: {
                  ...blockingArtifacts,
                  suggested_next_phase: 'rework',
                  return_to_ralplan_reason: 'Implementation finding requires rework.',
                },
                duration_ms: 0,
              };
            },
          },
          makeStage('ultraqa', { artifacts: { qa_verdict: { stage: 'ultraqa', clean: true } } }),
        ],
        cwd: tempDir,
        maxRalphIterations: 2,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.failedStage, 'code-review');
      assert.equal(result.error, 'successor_review_evidence_missing_or_reused');
      assert.equal(reviewRuns, 2);
    });

    it('fails closed when a completed code-review omits its verdict', async () => {
      let reviewRuns = 0;
      const result = await runPipeline({
        name: 'missing-review-verdict-test',
        task: 'reject absent verdict',
        stages: [makeStage('ralplan'), {
          name: 'code-review',
          async run(): Promise<StageResult> {
            reviewRuns += 1;
            if (reviewRuns > 1) throw new Error('code-review reran after the quality-gate limit');
            return { status: 'completed', artifacts: {}, duration_ms: 0 };
          },
        }],
        cwd: tempDir,
        maxRalphIterations: 1,
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.failedStage, 'code-review');
      assert.equal(result.error, 'Autopilot quality gates were not clean after 1 cycle(s).');
      assert.equal(reviewRuns, 1);
    });

    it('falls back to configured ralplan when a custom pipeline omits rework', async () => {
      const order: string[] = [];
      let reviewRuns = 0;
      const result = await runPipeline({
        name: 'review-rework-fallback-test',
        task: 'avoid restarting an unsupported phase',
        stages: [
          makeStage('deep-interview', undefined, { canSkip: () => {
            order.push('deep-interview');
            return false;
          } }),
          {
            name: 'ralplan',
            async run(): Promise<StageResult> {
              order.push('ralplan');
              return { status: 'completed', artifacts: {}, duration_ms: 0 };
            },
          },
          {
            name: 'code-review',
          async run(): Promise<StageResult> {
            order.push('code-review');
            reviewRuns += 1;
            const clean = reviewRuns > 1;
            if (clean) {
              const artifact = reviewArtifact({
                reviewId: '44444444-4444-4444-8444-444444444444',
                clean: true,
              });
              return {
                status: 'completed',
                artifacts: {
                  ...(await persistedStageArtifacts(artifact)),
                  suggested_next_phase: 'ultraqa',
                  return_to_ralplan_reason: null,
                },
                duration_ms: 0,
              };
            }
            return {
                status: 'completed',
                artifacts: {
                  review_verdict: {
                    stage: 'code-review',
                    clean,
                    recommendation: clean ? 'APPROVE' : 'REQUEST CHANGES',
                    architectural_status: 'CLEAR',
                    artifact_path: '.omx/reviews/custom-rework-fallback.json',
                    artifact_sha256: '4'.repeat(64),
                  },
                  suggested_next_phase: clean ? 'ultraqa' : 'rework',
                  return_to_ralplan_reason: clean ? null : 'Implementation finding requires rework.',
                },
                duration_ms: 0,
              };
            },
          },
          makeStage('ultraqa', {
            artifacts: {
              qa_verdict: {
                stage: 'ultraqa', clean: true, skipped: false, summary: 'QA clean.',
                url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/3',
              },
              return_to_ralplan_reason: null,
            },
          }),
        ],
        cwd: tempDir,
        maxRalphIterations: 2,
      });
      assert.equal(result.status, 'completed', result.error ?? 'pipeline failed');
      assert.deepEqual(order, ['deep-interview', 'ralplan', 'code-review', 'ralplan', 'code-review']);
    });

    it('threads return-loop review cycle into the rerun ralplan stage context', async () => {
      const plansDir = join(tempDir, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      await writeFile(join(plansDir, 'prd-stale.md'), '# Plan\n');
      await writeFile(join(plansDir, 'test-spec-stale.md'), '# Test Spec\n');

      let ralplanRuns = 0;
      const structuralRalplan = createRalplanStage();
      const staleRalplanArtifacts = {
        ralplanConsensusGate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: {
            agent_role: 'architect',
            verdict: 'approve',
            completed_at: '2026-06-12T09:00:00.000Z',
          },
          ralplan_critic_review: {
            agent_role: 'critic',
            verdict: 'approve',
            completed_at: '2026-06-12T09:05:00.000Z',
          },
        },
      };

      const ralplanStage: PipelineStage = {
        name: 'ralplan',
        async run(ctx: StageContext): Promise<StageResult> {
          ralplanRuns += 1;
          if (ralplanRuns === 1) {
            return {
              status: 'completed',
              artifacts: staleRalplanArtifacts,
              duration_ms: 0,
            };
          }
          assert.equal(ctx.artifacts.current_phase, 'ralplan');
          assert.equal(ctx.artifacts.return_to_ralplan_reason, 'Review requested a plan update.');
          assert.equal(ctx.artifacts.review_cycle, 1);
          return structuralRalplan.run(ctx);
        },
      };

      const result = await runPipeline({
        name: 'review-loop-stale-ralplan-test',
        task: 'reject stale ralplan consensus after review loopback',
        stages: [
          ralplanStage,
          makeStage('code-review', {
            artifacts: {
              review_verdict: {
                recommendation: 'REQUEST CHANGES',
                architectural_status: 'CLEAR',
                clean: false,
              },
              return_to_ralplan_reason: 'Review requested a plan update.',
            },
          }),
        ],
        cwd: tempDir,
        maxRalphIterations: 3,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.failedStage, 'ralplan');
      assert.equal(ralplanRuns, 2);
      assert.equal(result.stageResults.ralplan.error, 'ralplan_consensus_evidence_missing');
    });

    it('returns to ralplan rather than deep-interview after default quality-gate failures', async () => {
      const order: string[] = [];
      let qaRuns = 0;
      const cleanReviewArtifacts = await persistedStageArtifacts(reviewArtifact({
        reviewId: '55555555-5555-4555-8555-555555555555',
        clean: true,
      }));
      const stages: PipelineStage[] = [
        makeStage('deep-interview', undefined, {
          canSkip: () => {
            order.push('deep-interview:skip-check');
            return false;
          },
        }),
        {
          name: 'ralplan',
          async run(): Promise<StageResult> {
            order.push('ralplan');
            return { status: 'completed', artifacts: { plan: `cycle-${order.length}` }, duration_ms: 0 };
          },
        },
        makeStage('ultragoal', { artifacts: { implemented: true } }),
        makeStage('code-review', {
          artifacts: {
            ...cleanReviewArtifacts,
            return_to_ralplan_reason: null,
          },
        }),
        {
          name: 'ultraqa',
          async run(): Promise<StageResult> {
            order.push('ultraqa');
            qaRuns += 1;
            const clean = qaRuns > 1;
            return {
              status: 'completed',
              artifacts: {
                qa_verdict: { stage: 'ultraqa', clean, skipped: false, summary: clean ? 'QA clean.' : 'QA found a regression.', url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/2' },
                return_to_ralplan_reason: clean ? null : 'QA found a regression.',
              },
              duration_ms: 0,
            };
          },
        },
      ];

      const result = await runPipeline({
        name: 'default-quality-loop-test',
        task: 'loop until QA clean',
        stages,
        cwd: tempDir,
        maxRalphIterations: 3,
      });

      assert.equal(result.status, 'completed');
      assert.deepEqual(order, [
        'deep-interview:skip-check',
        'ralplan',
        'ultraqa',
        'ralplan',
        'ultraqa',
      ]);

      const ext = await readPipelineState(tempDir);
      assert.equal(ext?.review_cycle, 1);
      assert.equal((ext?.qa_verdict as { clean?: boolean } | undefined)?.clean, true);
      assert.equal(ext?.return_to_ralplan_reason, null);
    });

    it('fails after bounded non-clean code-review cycles', async () => {
      let reviewRuns = 0;
      const stages: PipelineStage[] = [
        makeStage('ralplan'),
        makeStage('ralph'),
        {
          name: 'code-review',
          async run(): Promise<StageResult> {
            reviewRuns += 1;
            if (reviewRuns > 2) throw new Error('code-review exceeded its configured cycle budget');
            return {
              status: 'completed',
              artifacts: {
                review_verdict: {
                  recommendation: 'REQUEST CHANGES',
                  architectural_status: 'WATCH',
                  clean: false,
                },
                return_to_ralplan_reason: 'Review still has findings.',
              },
              duration_ms: 0,
            };
          },
        },
      ];

      const result = await runPipeline({
        name: 'review-loop-fail-test',
        task: 'loop until bounded failure',
        stages,
        cwd: tempDir,
        maxRalphIterations: 2,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.failedStage, 'code-review');
      assert.match(result.error ?? '', /Autopilot quality gates were not clean after 2 cycle/);
      assert.equal(reviewRuns, 2);
    });


    it('final completion write replaces stale BLOCK verdict state with clean artifacts', async () => {
      let reviewRuns = 0;
      const stages: PipelineStage[] = [
        makeStage('ralplan', { artifacts: { plan: 'approved' } }),
        makeStage('ultragoal', { artifacts: { implemented: true } }),
        {
          name: 'code-review',
          async run(): Promise<StageResult> {
            reviewRuns += 1;
            const clean = reviewRuns > 1;
            if (clean) {
              const artifact = reviewArtifact({
                reviewId: '66666666-6666-4666-8666-666666666666',
                clean: true,
              });
              return {
                status: 'completed',
                artifacts: {
                  ...(await persistedStageArtifacts(artifact)),
                  return_to_ralplan_reason: null,
                },
                duration_ms: 0,
              };
            }
            return {
              status: 'completed',
              artifacts: {
                review_verdict: {
                  stage: 'code-review',
                  recommendation: clean ? 'APPROVE' : 'REQUEST CHANGES',
                  architectural_status: clean ? 'CLEAR' : 'BLOCK',
                  clean,
                  artifact_path: clean ? '.omx/reviews/final-clean.json' : '.omx/reviews/stale-block.json',
                  artifact_sha256: clean ? '6'.repeat(64) : '7'.repeat(64),
                },
                return_to_ralplan_reason: clean ? null : 'Stale BLOCK must be replaced after clean review.',
              },
              duration_ms: 0,
            };
          },
        },
        makeStage('ultraqa', {
          artifacts: {
            qa_verdict: {
              stage: 'ultraqa',
              clean: true,
              skipped: false,
              url: 'https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/42',
            },
            return_to_ralplan_reason: null,
          },
        }),
      ];

      const result = await runPipeline({
        name: 'stale-block-finalization',
        task: 'finalization replaces stale blockers',
        stages,
        cwd: tempDir,
      });

      assert.equal(result.status, 'completed');
      assert.equal(reviewRuns, 2);
      const ext = await readPipelineState(tempDir);
      const modeState = await readModeState('autopilot', tempDir);
      assert.equal(modeState?.active, false);
      assert.equal(modeState?.current_phase, 'complete');
      assert.equal((ext?.review_verdict as { recommendation?: string } | undefined)?.recommendation, 'APPROVE');
      assert.equal((ext?.review_verdict as { architectural_status?: string } | undefined)?.architectural_status, 'CLEAR');
      assert.equal((ext?.review_verdict as { clean?: boolean } | undefined)?.clean, true);
      assert.equal((ext?.qa_verdict as { clean?: boolean } | undefined)?.clean, true);
      assert.equal(ext?.return_to_ralplan_reason, null);
      assert.ok(ext?.handoff_artifacts?.code_review, 'clean code-review artifact should be preserved in terminal state');
      assert.ok(ext?.handoff_artifacts?.ultraqa, 'clean ultraqa artifact should be preserved in terminal state');
      assert.equal((ext?.pipeline_stage_results as Record<string, unknown> | undefined)?.['code-review'] !== undefined, true);
      assert.equal((ext?.pipeline_stage_results as Record<string, unknown> | undefined)?.ultraqa !== undefined, true);
    });

    it('passes artifacts between stages', async () => {
      let receivedArtifacts: Record<string, unknown> = {};

      const stages: PipelineStage[] = [
        {
          name: 'producer',
          async run(): Promise<StageResult> {
            return {
              status: 'completed',
              artifacts: { data: 'from-producer' },
              duration_ms: 0,
            };
          },
        },
        {
          name: 'consumer',
          async run(ctx: StageContext): Promise<StageResult> {
            receivedArtifacts = ctx.artifacts;
            return { status: 'completed', artifacts: {}, duration_ms: 0 };
          },
        },
      ];

      await runPipeline({ name: 'artifact-test', task: 'test', stages, cwd: tempDir });

      assert.ok(receivedArtifacts['producer']);
      assert.deepEqual(
        (receivedArtifacts['producer'] as Record<string, unknown>).data,
        'from-producer',
      );
    });

    it('stops pipeline on stage failure and reports failed stage', async () => {
      const stages: PipelineStage[] = [
        makeStage('ok-stage'),
        makeFailingStage('bad-stage', 'something broke'),
        makeStage('never-reached'),
      ];

      const result = await runPipeline({
        name: 'fail-test',
        task: 'test',
        stages,
        cwd: tempDir,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.failedStage, 'bad-stage');
      assert.equal(result.error, 'something broke');
      assert.ok(result.stageResults['ok-stage']);
      assert.ok(result.stageResults['bad-stage']);
      assert.equal(result.stageResults['never-reached'], undefined);
    });

    it('catches thrown errors and converts to failed result', async () => {
      const stages = [makeThrowingStage('throwing', 'kaboom')];

      const result = await runPipeline({
        name: 'throw-test',
        task: 'test',
        stages,
        cwd: tempDir,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.failedStage, 'throwing');
      assert.match(result.error!, /kaboom/);
    });

    it('skips stages when canSkip returns true', async () => {
      const ran: string[] = [];
      const stages: PipelineStage[] = [
        makeStage('always-run'),
        {
          name: 'skippable',
          canSkip: () => true,
          async run(): Promise<StageResult> {
            ran.push('skippable');
            return { status: 'completed', artifacts: {}, duration_ms: 0 };
          },
        },
        {
          name: 'after-skip',
          async run(): Promise<StageResult> {
            ran.push('after-skip');
            return { status: 'completed', artifacts: {}, duration_ms: 0 };
          },
        },
      ];

      const result = await runPipeline({
        name: 'skip-test',
        task: 'test',
        stages,
        cwd: tempDir,
      });

      assert.equal(result.status, 'completed');
      assert.equal(result.stageResults['skippable'].status, 'skipped');
      assert.ok(!ran.includes('skippable'));
      assert.ok(ran.includes('after-skip'));
      assert.equal(Object.hasOwn(result.artifacts, 'skippable'), false);
      const ext = await readPipelineState(tempDir);
      assert.equal(Object.hasOwn(ext?.handoff_artifacts ?? {}, 'skippable'), false);
    });

    it('materializes ralplan consensus handoff artifacts when ralplan is skipped', async () => {
      const plansDir = join(tempDir, '.omx', 'plans');
      const stateDir = join(tempDir, '.omx', 'state');
      await mkdir(plansDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(plansDir, 'prd-skip.md'), '# Plan\n');
      await writeFile(join(plansDir, 'test-spec-skip.md'), '# Test Spec\n');
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        mode: 'ralplan',
        current_phase: 'complete',
        planning_complete: true,
        ralplan_consensus_gate: {
          complete: true,
          ralplan_architect_review: { agent_role: 'architect', verdict: 'approve', summary: 'architect ok' },
          ralplan_critic_review: { agent_role: 'critic', verdict: 'approve', summary: 'critic ok' },
        },
      }));

      const result = await runPipeline({
        name: 'ralplan-skip-handoff',
        task: 'skip with durable evidence',
        stages: [createRalplanStage(), makeStage('after')],
        cwd: tempDir,
      });

      assert.equal(result.status, 'completed');
      assert.equal(result.stageResults.ralplan.status, 'skipped');

      const ext = await readPipelineState(tempDir);
      const handoffs = ext?.handoff_artifacts as Record<string, unknown>;
      assert.ok(handoffs.ralplan, 'skipped ralplan handoff should remain visible');
      assert.deepEqual(handoffs.ralplan_consensus_gate, {
        complete: true,
        sequence: ['architect-review', 'critic-review'],
        ralplan_architect_review: { agent_role: 'architect', verdict: 'approve', summary: 'architect ok' },
        ralplan_critic_review: { agent_role: 'critic', verdict: 'approve', summary: 'critic ok' },
        source: join(tempDir, '.omx', 'state', 'ralplan-state.json'),
        blockedReason: null,
      });
    });

    it('fires onStageTransition callback', async () => {
      const transitions: Array<[string, string]> = [];
      const stages = [makeStage('a'), makeStage('b'), makeStage('c')];

      await runPipeline({
        name: 'transition-test',
        task: 'test',
        stages,
        cwd: tempDir,
        onStageTransition: (from, to) => transitions.push([from, to]),
      });

      assert.deepEqual(transitions, [
        ['a', 'b'],
        ['b', 'c'],
      ]);
    });

    it('fires correct transitions when middle stage is skipped', async () => {
      const transitions: Array<[string, string]> = [];
      const stages: PipelineStage[] = [
        makeStage('a'),
        {
          name: 'b-skipped',
          canSkip: () => true,
          async run(): Promise<StageResult> {
            return { status: 'completed', artifacts: {}, duration_ms: 0 };
          },
        },
        makeStage('c'),
      ];

      await runPipeline({
        name: 'skip-transition-test',
        task: 'test',
        stages,
        cwd: tempDir,
        onStageTransition: (from, to) => transitions.push([from, to]),
      });

      assert.deepEqual(transitions, [
        ['a', 'b-skipped'],
        ['b-skipped', 'c'],
      ]);
    });

    it('passes previousStageResult to the next stage', async () => {
      let receivedPrevResult: StageResult | undefined;

      const stages: PipelineStage[] = [
        {
          name: 'first',
          async run(): Promise<StageResult> {
            return {
              status: 'completed',
              artifacts: { marker: 'first-stage' },
              duration_ms: 42,
            };
          },
        },
        {
          name: 'second',
          async run(ctx: StageContext): Promise<StageResult> {
            receivedPrevResult = ctx.previousStageResult;
            return { status: 'completed', artifacts: {}, duration_ms: 0 };
          },
        },
      ];

      await runPipeline({ name: 'prev-result-test', task: 'test', stages, cwd: tempDir });

      assert.ok(receivedPrevResult);
      assert.equal(receivedPrevResult!.status, 'completed');
      assert.deepEqual(receivedPrevResult!.artifacts, { marker: 'first-stage' });
    });

    it('persists pipeline state to mode state file', async () => {
      await runPipeline({
        name: 'persist-test',
        task: 'persistence check',
        stages: [makeStage('only')],
        cwd: tempDir,
      });

      const statePath = join(tempDir, '.omx', 'state', 'autopilot-state.json');
      assert.ok(existsSync(statePath), 'pipeline state file should exist');

      const raw = await readFile(statePath, 'utf-8');
      const state = JSON.parse(raw);
      assert.equal(state.active, false);
      assert.equal(state.current_phase, 'complete');
      assert.equal(state.pipeline_name, 'persist-test');
    });

    it('persists failed state with error', async () => {
      await runPipeline({
        name: 'fail-persist',
        task: 'will fail',
        stages: [makeFailingStage('failing', 'oops')],
        cwd: tempDir,
      });

      const statePath = join(tempDir, '.omx', 'state', 'autopilot-state.json');
      const raw = await readFile(statePath, 'utf-8');
      const state = JSON.parse(raw);
      assert.equal(state.active, false);
      assert.equal(state.current_phase, 'failed');
      assert.equal(state.error, 'oops');
    });
  });

  describe('validation', () => {
    it('rejects config with empty name', async () => {
      await assert.rejects(
        () => runPipeline({ name: '', task: 'x', stages: [makeStage('a')], cwd: tempDir }),
        /non-empty name/,
      );
    });

    it('rejects config with empty task', async () => {
      await assert.rejects(
        () => runPipeline({ name: 'x', task: '', stages: [makeStage('a')], cwd: tempDir }),
        /non-empty task/,
      );
    });

    it('rejects config with no stages', async () => {
      await assert.rejects(
        () => runPipeline({ name: 'x', task: 'x', stages: [], cwd: tempDir }),
        /at least one stage/,
      );
    });

    it('rejects duplicate stage names', async () => {
      await assert.rejects(
        () => runPipeline({
          name: 'x',
          task: 'x',
          stages: [makeStage('dup'), makeStage('dup')],
          cwd: tempDir,
        }),
        /Duplicate stage name/,
      );
    });

    it('rejects non-positive maxRalphIterations', async () => {
      await assert.rejects(
        () => runPipeline({
          name: 'x',
          task: 'x',
          stages: [makeStage('a')],
          cwd: tempDir,
          maxRalphIterations: 0,
        }),
        /maxRalphIterations must be a positive integer/,
      );
    });

    it('rejects non-positive workerCount', async () => {
      await assert.rejects(
        () => runPipeline({
          name: 'x',
          task: 'x',
          stages: [makeStage('a')],
          cwd: tempDir,
          workerCount: -1,
        }),
        /workerCount must be a positive integer/,
      );
    });
  });

  describe('canResumePipeline', () => {
    it('returns false when no state exists', async () => {
      assert.equal(await canResumePipeline(tempDir), false);
    });

    it('returns false after completed pipeline', async () => {
      await runPipeline({
        name: 'complete',
        task: 'test',
        stages: [makeStage('a')],
        cwd: tempDir,
      });
      assert.equal(await canResumePipeline(tempDir), false);
    });

    it('returns false after failed pipeline', async () => {
      await runPipeline({
        name: 'fail',
        task: 'test',
        stages: [makeFailingStage('bad', 'err')],
        cwd: tempDir,
      });
      assert.equal(await canResumePipeline(tempDir), false);
    });

    it('returns true when pipeline state is active and in-progress', async () => {
      // Manually write an in-progress pipeline state
      const { mkdir: mkdirFs, writeFile: writeFileFs } = await import('fs/promises');
      const stateDir = join(tempDir, '.omx', 'state');
      await mkdirFs(stateDir, { recursive: true });
      await writeFileFs(
        join(stateDir, 'autopilot-state.json'),
        JSON.stringify({
          active: true,
          mode: 'autopilot',
          iteration: 1,
          max_iterations: 3,
          current_phase: 'ralph',
          pipeline_name: 'resume-test',
          started_at: new Date().toISOString(),
        }),
      );
      assert.equal(await canResumePipeline(tempDir), true);
    });
  });

  describe('readPipelineState', () => {
    it('returns null when no state exists', async () => {
      assert.equal(await readPipelineState(tempDir), null);
    });

    it('returns extension fields after a run', async () => {
      await runPipeline({
        name: 'read-test',
        task: 'read task',
        stages: [makeStage('s1'), makeStage('s2')],
        cwd: tempDir,
        maxRalphIterations: 5,
        workerCount: 3,
        agentType: 'analyst',
      });

      const ext = await readPipelineState(tempDir);
      assert.ok(ext);
      assert.equal(ext.pipeline_name, 'read-test');
      assert.deepEqual(ext.pipeline_stages, ['s1', 's2']);
      assert.equal(ext.pipeline_max_ralph_iterations, 5);
      assert.equal(ext.pipeline_worker_count, 3);
      assert.equal(ext.pipeline_agent_type, 'analyst');
      assert.equal(ext.qa_verdict, null);
    });
  });

  describe('cancelPipeline', () => {
    it('does not throw when no state exists', async () => {
      await assert.doesNotReject(() => cancelPipeline(tempDir));
    });
  });

  describe('createAutopilotPipelineConfig', () => {
    it('creates config with default values', () => {
      const config = createAutopilotPipelineConfig('build feature X', {});

      assert.equal(config.name, 'autopilot');
      assert.equal(config.task, 'build feature X');
      assert.equal(config.maxRalphIterations, 10);
      assert.equal(config.workerCount, 2);
      assert.equal(config.agentType, 'executor');
      assert.deepEqual(config.stages.map((stage) => stage.name), [
        'deep-interview', 'ralplan', 'ultragoal', 'rework', 'code-review', 'ultraqa',
      ]);
    });

    it('skips default rework initially and enables it for implementation review findings', async () => {
      const rework = createStrictAutopilotStages().find((stage) => stage.name === 'rework');
      assert.ok(rework);
      const context: StageContext = {
        task: 'fix review findings',
        cwd: tempDir,
        artifacts: {},
      };
      assert.equal(rework.canSkip?.(context), true);
      context.artifacts['code-review'] = {
        suggested_next_phase: 'rework',
        review_verdict: { clean: false, recommendation: 'REQUEST CHANGES' },
        code_review_artifact_identity: {
          review_id: '77777777-7777-4777-8777-777777777777',
          revision: 1,
          artifact_path: '.omx/reviews/77777777-7777-4777-8777-777777777777.json',
          artifact_sha256: '8'.repeat(64),
        },
      };
      context.artifacts.review_cycle = 1;
      assert.equal(rework.canSkip?.(context), false);
      const result = await rework.run(context);
      assert.equal(result.status, 'failed');
      assert.equal(result.error, 'rework_execution_evidence_missing_or_stale');
      assert.equal(result.artifacts.stage, 'rework');
      assert.match(String(result.artifacts.instruction), /review findings/iu);
    });

    it('rediscovers the latest persisted review artifact on a successor code-review pass', async () => {
      const firstReview = reviewArtifact({
        reviewId: '11111111-1111-4111-8111-111111111111',
        revision: 1,
        clean: false,
        finalizedAt: '2026-07-15T00:01:00.000Z',
      });
      const firstPersisted = await persistReviewArtifact(firstReview);
      const codeReview = createStrictAutopilotStages(firstPersisted).find((stage) => stage.name === 'code-review');
      assert.ok(codeReview);

      const firstResult = await codeReview.run({
        task: 'consume first review',
        cwd: tempDir,
        artifacts: { ultragoal: { implemented: true } },
      });
      assert.equal(
        (firstResult.artifacts.code_review_artifact_identity as Record<string, unknown>).review_id,
        firstReview.review_id,
      );
      assert.equal((firstResult.artifacts.review_verdict as Record<string, unknown>).clean, false);

      const reworkEvidence = await persistReworkEvidence(
        firstResult.artifacts.code_review_artifact_identity as Record<string, unknown>,
      );
      await writeFile(join(tempDir, 'src', 'example.ts'), 'export const value = 3;\n');

      const successorReview = reviewArtifact({
        reviewId: '22222222-2222-4222-8222-222222222222',
        revision: 1,
        clean: true,
        finalizedAt: '2026-07-15T00:20:00.000Z',
        supersedesReviewId: String(firstReview.review_id),
      });
      await persistReviewArtifact(reviewArtifact({
        reviewId: '99999999-9999-4999-8999-999999999999',
        clean: true,
        finalizedAt: '2026-07-15T00:19:00.000Z',
        supersedesReviewId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }));
      await persistReviewArtifact(successorReview);
      await writeFile(join(tempDir, '.omx', 'reviews', 'not-a-review-artifact.txt'), 'ignored');

      const successorResult = await codeReview.run({
        task: 'consume successor review',
        cwd: tempDir,
        artifacts: {
          review_cycle: 1,
          'code-review': firstResult.artifacts,
          rework: {
            rework_evidence: reworkEvidence,
          },
        },
      });

      assert.equal(
        (successorResult.artifacts.code_review_artifact_identity as Record<string, unknown>).review_id,
        successorReview.review_id,
      );
      assert.equal((successorResult.artifacts.review_verdict as Record<string, unknown>).clean, true);
    });



    it('exposes strict default autopilot stages', () => {
      assert.deepEqual(createStrictAutopilotStages().map((stage) => stage.name), [
        'deep-interview', 'ralplan', 'ultragoal', 'rework', 'code-review', 'ultraqa',
      ]);
    });

    it('exports strict default autopilot stages from the public pipeline index', () => {
      assert.deepEqual(
        pipelineIndex.createStrictAutopilotStages().map((stage) => stage.name),
        ['deep-interview', 'ralplan', 'ultragoal', 'rework', 'code-review', 'ultraqa'],
      );
    });

    it('accepts custom overrides', () => {
      const stages = [makeStage('a'), makeStage('b')];
      const config = createAutopilotPipelineConfig('task', {
        stages,
        maxRalphIterations: 20,
        workerCount: 4,
        agentType: 'architect',
        cwd: '/tmp/test',
        sessionId: 'session-1',
      });

      assert.equal(config.maxRalphIterations, 20);
      assert.equal(config.workerCount, 4);
      assert.equal(config.agentType, 'architect');
      assert.equal(config.cwd, '/tmp/test');
      assert.equal(config.sessionId, 'session-1');
    });
  });
});
