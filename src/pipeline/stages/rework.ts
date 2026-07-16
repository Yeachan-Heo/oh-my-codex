/** Rework adapter used only after code-review reports implementation findings. */

import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import type { PipelineStage, StageContext, StageResult } from '../types.js';

export interface ReworkDescriptor {
  task: string;
  cwd: string;
  sessionId?: string;
  reviewArtifacts: Record<string, unknown>;
  instruction: string;
}

export interface ReviewArtifactIdentity {
  review_id: string;
  revision: number;
  artifact_path: string;
  artifact_sha256: string;
}

export interface ReworkExecutionEvidence {
  schema_version: 1;
  review_cycle: number;
  source_review: ReviewArtifactIdentity;
  execution_id: string;
  implementation_artifact: ReworkArtifactDescriptor;
  verification_artifact: ReworkArtifactDescriptor;
}

export interface ReworkSourceIdentity {
  agent_role: string;
  thread_id: string;
  produced_at: string;
}

export interface ReworkArtifactDescriptor {
  path: string;
  sha256: string;
  source_identity: ReworkSourceIdentity;
}

export interface ReworkStageOptions {
  executionEvidence?: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

export function parseReviewArtifactIdentity(value: unknown): ReviewArtifactIdentity | null {
  if (!exactObject(value, ['review_id', 'revision', 'artifact_path', 'artifact_sha256'])
    || typeof value.review_id !== 'string' || !UUID.test(value.review_id)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || typeof value.artifact_path !== 'string'
    || value.artifact_path !== `.omx/reviews/${value.review_id}.json`
    || typeof value.artifact_sha256 !== 'string' || !SHA256.test(value.artifact_sha256)) {
    return null;
  }
  return {
    review_id: value.review_id,
    revision: value.revision as number,
    artifact_path: value.artifact_path,
    artifact_sha256: value.artifact_sha256,
  };
}

function parseSourceIdentity(value: unknown): ReworkSourceIdentity | null {
  if (!exactObject(value, ['agent_role', 'thread_id', 'produced_at'])
    || typeof value.agent_role !== 'string' || value.agent_role.trim() === ''
    || typeof value.thread_id !== 'string' || value.thread_id.trim() === ''
    || typeof value.produced_at !== 'string' || Number.isNaN(Date.parse(value.produced_at))) {
    return null;
  }
  return {
    agent_role: value.agent_role,
    thread_id: value.thread_id,
    produced_at: value.produced_at,
  };
}

function sameSourceIdentity(left: ReworkSourceIdentity, right: ReworkSourceIdentity): boolean {
  return left.agent_role === right.agent_role
    && left.thread_id === right.thread_id
    && left.produced_at === right.produced_at;
}

function parseArtifactDescriptor(value: unknown): ReworkArtifactDescriptor | null {
  if (!exactObject(value, ['path', 'sha256', 'source_identity'])
    || typeof value.path !== 'string'
    || typeof value.sha256 !== 'string'
    || !SHA256.test(value.sha256)) {
    return null;
  }
  const sourceIdentity = parseSourceIdentity(value.source_identity);
  if (sourceIdentity === null) return null;
  return {
    path: value.path,
    sha256: value.sha256,
    source_identity: sourceIdentity,
  };
}

function parseReworkExecutionEvidence(value: unknown): ReworkExecutionEvidence | null {
  if (!exactObject(value, [
    'schema_version', 'review_cycle', 'source_review', 'execution_id',
    'implementation_artifact', 'verification_artifact',
  ])
    || value.schema_version !== 1
    || !Number.isSafeInteger(value.review_cycle)
    || (value.review_cycle as number) < 0
    || typeof value.execution_id !== 'string'
    || !UUID.test(value.execution_id)) {
    return null;
  }
  const sourceReview = parseReviewArtifactIdentity(value.source_review);
  const implementationArtifact = parseArtifactDescriptor(value.implementation_artifact);
  const verificationArtifact = parseArtifactDescriptor(value.verification_artifact);
  if (sourceReview === null || implementationArtifact === null || verificationArtifact === null) {
    return null;
  }
  return {
    schema_version: 1,
    review_cycle: value.review_cycle as number,
    source_review: sourceReview,
    execution_id: value.execution_id,
    implementation_artifact: implementationArtifact,
    verification_artifact: verificationArtifact,
  };
}

export function reviewArtifactIdentityFromStageArtifacts(
  artifacts: unknown,
): ReviewArtifactIdentity | null {
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) return null;
  return parseReviewArtifactIdentity(
    (artifacts as Record<string, unknown>).code_review_artifact_identity,
  );
}

export function isFreshReworkEvidence(
  value: unknown,
  sourceReview: ReviewArtifactIdentity,
  reviewCycle: number,
): value is ReworkExecutionEvidence {
  const observed = parseReworkExecutionEvidence(value);
  if (observed === null || observed.review_cycle !== reviewCycle) return false;
  const observedSource = observed.source_review;
  return observedSource !== null
    && observedSource.review_id === sourceReview.review_id
    && observedSource.revision === sourceReview.revision
    && observedSource.artifact_path === sourceReview.artifact_path
    && observedSource.artifact_sha256 === sourceReview.artifact_sha256;
}

function relativeArtifactPath(cwd: string, descriptorPath: string): string | null {
  const root = resolve(cwd);
  const reworkRoot = resolve(root, '.omx', 'rework');
  const absolutePath = resolve(root, descriptorPath);
  const relativeToRoot = relative(root, absolutePath).replaceAll('\\', '/');
  if (relativeToRoot !== descriptorPath
    || dirname(absolutePath) !== reworkRoot
    || basename(absolutePath).length === 0
    || !basename(absolutePath).endsWith('.json')) {
    return null;
  }
  return absolutePath;
}

async function readBoundedJsonArtifact(
  cwd: string,
  descriptor: ReworkArtifactDescriptor,
): Promise<unknown | null> {
  const artifactPath = relativeArtifactPath(cwd, descriptor.path);
  if (artifactPath === null) return null;
  try {
    const lexicalReworkRoot = resolve(cwd, '.omx', 'rework');
    const rootMetadata = await lstat(lexicalReworkRoot);
    const reworkRoot = await realpath(lexicalReworkRoot);
    const metadata = await lstat(artifactPath);
    const resolvedArtifact = await realpath(artifactPath);
    if (!rootMetadata.isDirectory()
      || rootMetadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.size > 1024 * 1024
      || dirname(resolvedArtifact) !== reworkRoot) {
      return null;
    }
    const raw = await readFile(artifactPath);
    const sha256 = createHash('sha256').update(raw).digest('hex');
    if (sha256 !== descriptor.sha256) return null;
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function sameReviewIdentity(left: unknown, right: ReviewArtifactIdentity): boolean {
  const parsed = parseReviewArtifactIdentity(left);
  return parsed !== null
    && parsed.review_id === right.review_id
    && parsed.revision === right.revision
    && parsed.artifact_path === right.artifact_path
    && parsed.artifact_sha256 === right.artifact_sha256;
}

function validChangedFiles(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((path) =>
      typeof path === 'string'
      && path.trim() !== ''
      && !path.includes('\0')
      && !path.startsWith('/')
      && !path.split(/[\\/]/u).includes('..'));
}

function validVerificationChecks(value: unknown): boolean {
  return Array.isArray(value)
    && value.length > 0
    && value.every((check) =>
      exactObject(check, ['command', 'exit_code', 'source'])
      && typeof check.command === 'string'
      && check.command.trim() !== ''
      && check.exit_code === 0
      && typeof check.source === 'string'
      && check.source.trim() !== '');
}

function validImplementationPayload(
  value: unknown,
  evidence: ReworkExecutionEvidence,
): boolean {
  if (!exactObject(value, [
    'schema_version', 'artifact_kind', 'execution_id', 'review_cycle', 'source_review',
    'source_identity', 'changed_files', 'summary',
  ])
    || value.schema_version !== 1
    || value.artifact_kind !== 'rework_implementation'
    || value.execution_id !== evidence.execution_id
    || value.review_cycle !== evidence.review_cycle
    || !sameReviewIdentity(value.source_review, evidence.source_review)
    || typeof value.summary !== 'string'
    || value.summary.trim() === ''
    || !validChangedFiles(value.changed_files)) {
    return false;
  }
  const sourceIdentity = parseSourceIdentity(value.source_identity);
  return sourceIdentity !== null
    && sameSourceIdentity(sourceIdentity, evidence.implementation_artifact.source_identity);
}

function validVerificationPayload(
  value: unknown,
  evidence: ReworkExecutionEvidence,
): boolean {
  if (!exactObject(value, [
    'schema_version', 'artifact_kind', 'execution_id', 'review_cycle', 'source_review',
    'source_identity', 'checks',
  ])
    || value.schema_version !== 1
    || value.artifact_kind !== 'rework_verification'
    || value.execution_id !== evidence.execution_id
    || value.review_cycle !== evidence.review_cycle
    || !sameReviewIdentity(value.source_review, evidence.source_review)
    || !validVerificationChecks(value.checks)) {
    return false;
  }
  const sourceIdentity = parseSourceIdentity(value.source_identity);
  return sourceIdentity !== null
    && sameSourceIdentity(sourceIdentity, evidence.verification_artifact.source_identity);
}

export async function validateFreshReworkEvidence(
  value: unknown,
  sourceReview: ReviewArtifactIdentity,
  reviewCycle: number,
  cwd: string,
  sourceReviewFinalizedAt?: string,
): Promise<ReworkExecutionEvidence | null> {
  if (!isFreshReworkEvidence(value, sourceReview, reviewCycle)) return null;
  const evidence = parseReworkExecutionEvidence(value) as ReworkExecutionEvidence;
  if (evidence.implementation_artifact.source_identity.thread_id
      === evidence.verification_artifact.source_identity.thread_id) {
    return null;
  }
  const implementationProducedAt = Date.parse(evidence.implementation_artifact.source_identity.produced_at);
  const verificationProducedAt = Date.parse(evidence.verification_artifact.source_identity.produced_at);
  const sourceReviewFinalizedAtMs = sourceReviewFinalizedAt === undefined
    ? Number.NaN
    : Date.parse(sourceReviewFinalizedAt);
  if (Number.isNaN(sourceReviewFinalizedAtMs)
    || !(sourceReviewFinalizedAtMs < implementationProducedAt)
    || !(implementationProducedAt < verificationProducedAt)) return null;

  const implementation = await readBoundedJsonArtifact(cwd, evidence.implementation_artifact);
  const verification = await readBoundedJsonArtifact(cwd, evidence.verification_artifact);
  if (!validImplementationPayload(implementation, evidence)) return null;
  if (!validVerificationPayload(verification, evidence)) return null;
  return evidence;
}

export function reworkEvidenceCompletedAt(value: unknown): string | null {
  const evidence = parseReworkExecutionEvidence(value);
  return evidence?.verification_artifact.source_identity.produced_at ?? null;
}

function pendingImplementationRework(ctx: StageContext): Record<string, unknown> | null {
  const artifacts = ctx.artifacts['code-review'];
  if (!artifacts || typeof artifacts !== 'object') return null;
  const reviewArtifacts = artifacts as Record<string, unknown>;
  const verdict = reviewArtifacts.review_verdict;
  const clean = verdict && typeof verdict === 'object'
    ? (verdict as { clean?: unknown }).clean
    : undefined;
  return reviewArtifacts.suggested_next_phase === 'rework' && clean !== true
    ? reviewArtifacts
    : null;
}

function sourceReviewFinalizedAt(reviewArtifacts: Record<string, unknown>): string | undefined {
  const artifact = reviewArtifacts.code_review_artifact;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return undefined;
  const value = (artifact as Record<string, unknown>).finalized_at;
  return typeof value === 'string' ? value : undefined;
}

export function createReworkStage(options: ReworkStageOptions = {}): PipelineStage {
  return {
    name: 'rework',
    canSkip: (ctx) => pendingImplementationRework(ctx) === null,

    async run(ctx: StageContext): Promise<StageResult> {
      const startTime = Date.now();
      const reviewArtifacts = pendingImplementationRework(ctx) ?? {};
      const descriptor: ReworkDescriptor = {
        task: ctx.task,
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        reviewArtifacts,
        instruction: buildReworkInstruction(ctx.task),
      };
      const sourceReview = reviewArtifactIdentityFromStageArtifacts(reviewArtifacts);
      const reviewCycle = typeof ctx.artifacts.review_cycle === 'number'
        ? ctx.artifacts.review_cycle
        : 0;
      const evidence = options.executionEvidence ?? ctx.artifacts.rework_execution_evidence;
      const validatedEvidence = sourceReview === null
        ? null
        : await validateFreshReworkEvidence(
          evidence,
          sourceReview,
          reviewCycle,
          ctx.cwd,
          sourceReviewFinalizedAt(reviewArtifacts),
        );
      if (validatedEvidence === null) {
        return {
          status: 'failed',
          artifacts: {
            stage: 'rework',
            reworkDescriptor: descriptor,
            review_artifacts: reviewArtifacts,
            instruction: descriptor.instruction,
          },
          duration_ms: Date.now() - startTime,
          error: 'rework_execution_evidence_missing_or_stale',
        };
      }
      return {
        status: 'completed',
        artifacts: {
          stage: 'rework',
          reworkDescriptor: descriptor,
          review_artifacts: reviewArtifacts,
          rework_evidence: validatedEvidence,
          instruction: descriptor.instruction,
        },
        duration_ms: Date.now() - startTime,
      };
    },
  };
}

export function buildReworkInstruction(task: string): string {
  return `$ultragoal ${JSON.stringify(`Address the persisted code-review findings for: ${task}`)}`;
}
