/**
 * Code-review stage adapter for the default Autopilot loop.
 *
 * The stage produces a descriptor/instruction for the existing `$code-review`
 * skill and reports whether the latest review is clean. A non-clean review is
 * represented as `completed` with `clean: false` so Autopilot can return to
 * ralplan instead of treating review findings as infrastructure failure.
 */

import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { PipelineStage, StageContext, StageResult } from '../types.js';
import { validateFinalReviewArtifact } from '../../code-review/render.js';
import type { FinalReviewArtifact } from '../../code-review/contract.js';
import { verifyScopeDrift } from '../../code-review/scope.js';
import { parseCodeReviewStageArtifacts } from '../review-verdict.js';
import {
  parseReviewArtifactIdentity,
  reworkEvidenceCompletedAt,
  validateFreshReworkEvidence,
} from './rework.js';

export interface CodeReviewStageOptions {
  /** Optional review recommendation injected by tests or runtime adapters. */
  recommendation?: 'APPROVE' | 'COMMENT' | 'REQUEST CHANGES';

  /** Optional architecture status injected by tests or runtime adapters. */
  architecturalStatus?: 'CLEAR' | 'WATCH' | 'BLOCK';

  /** Optional human-readable review summary. */
  summary?: string;

  /** Repository-relative path to the finalized runtime artifact. */
  artifactPath?: string;

  /** Optional identity checks supplied by the coordinator handoff. */
  artifactReviewId?: string;
  artifactSha256?: string;
}

export interface CodeReviewDescriptor {
  task: string;
  cwd: string;
  sessionId?: string;
  executionArtifacts: Record<string, unknown>;
  instruction: string;
}

export interface CodeReviewVerdict {
  recommendation: 'APPROVE' | 'COMMENT' | 'REQUEST CHANGES';
  architectural_status: 'CLEAR' | 'WATCH' | 'BLOCK';
  clean: boolean;
  summary: string;
  stage: 'code-review';
  artifact_path: string;
  artifact_sha256?: string;
}

interface RuntimeArtifact {
  artifact: FinalReviewArtifact | null;
  artifactPath: string;
  artifactSha256?: string;
}

const MISSING_ARTIFACT_PATH = '.omx/state/autopilot-state.json#pipeline_stage_results.code-review.artifacts.review_verdict';

function isPathInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child !== '' && !child.startsWith('..') && !child.startsWith('/') && !child.startsWith('\\');
}

export async function loadPersistedRuntimeArtifact(
  artifactPath: string,
  cwd: string,
  expected?: { reviewId?: string; sha256?: string },
): Promise<RuntimeArtifact> {
  const reviewsRoot = resolve(cwd, '.omx', 'reviews');
  const absolutePath = resolve(cwd, artifactPath);
  const displayPath = relative(resolve(cwd), absolutePath).replaceAll('\\', '/');
  if (!isPathInside(reviewsRoot, absolutePath)
    || dirname(absolutePath) !== reviewsRoot
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/iu.test(basename(absolutePath))) {
    return { artifact: null, artifactPath: displayPath || artifactPath };
  }
  try {
    const rootMetadata = await lstat(reviewsRoot);
    const metadata = await lstat(absolutePath);
    const resolvedReviewsRoot = await realpath(reviewsRoot);
    const resolvedArtifactPath = await realpath(absolutePath);
    if (!rootMetadata.isDirectory()
      || rootMetadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.size > 2 * 1024 * 1024
      || dirname(resolvedArtifactPath) !== resolvedReviewsRoot) {
      return { artifact: null, artifactPath: displayPath || artifactPath };
    }
    const raw = await readFile(absolutePath);
    const artifactSha256 = createHash('sha256').update(raw).digest('hex');
    const artifact = validateFinalReviewArtifact(JSON.parse(raw.toString('utf8')) as unknown);
    const scopeValid = await isReviewArtifactScopeCurrent(artifact, cwd);
    if (basename(absolutePath) !== `${artifact.review_id}.json`
      || (expected?.reviewId !== undefined && expected.reviewId !== artifact.review_id)
      || (expected?.sha256 !== undefined && expected.sha256 !== artifactSha256)
      || !reviewVerdictConsistent(artifact)
      || !scopeValid) {
      return { artifact: null, artifactPath: displayPath || artifactPath };
    }
    return { artifact, artifactPath: displayPath, artifactSha256 };
  } catch {
    return { artifact: null, artifactPath: displayPath || artifactPath };
  }
}

async function findRuntimeArtifact(options: CodeReviewStageOptions, ctx: StageContext): Promise<RuntimeArtifact> {
  const successor = await findSuccessorRuntimeArtifact(ctx);
  if (successor.artifact !== null) return successor;
  if (hasSuccessorReworkEvidence(ctx)) {
    return { artifact: null, artifactPath: MISSING_ARTIFACT_PATH };
  }
  if (options.artifactPath !== undefined) {
    if (options.artifactReviewId === undefined
      || options.artifactSha256 === undefined
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(options.artifactReviewId)
      || !/^[0-9a-f]{64}$/u.test(options.artifactSha256)) {
      return { artifact: null, artifactPath: options.artifactPath };
    }
    return await loadPersistedRuntimeArtifact(options.artifactPath, ctx.cwd, {
      reviewId: options.artifactReviewId,
      sha256: options.artifactSha256,
    });
  }
  return { artifact: null, artifactPath: MISSING_ARTIFACT_PATH };
}

function reviewVerdictConsistent(artifact: FinalReviewArtifact): boolean {
  if (artifact.status === 'FINALIZED') {
    if (artifact.verdict.clean !== (
      artifact.verdict.recommendation === 'APPROVE'
      && artifact.verdict.architectural_status === 'CLEAR'
    ) && artifact.verdict.rule_id !== 'NO_CHANGES') {
      return false;
    }
  }
  if (artifact.status === 'BLOCKED') {
    return artifact.verdict.clean === false
      && artifact.verdict.recommendation === 'REQUEST CHANGES';
  }
  return true;
}

export async function isReviewArtifactScopeCurrent(
  artifact: FinalReviewArtifact,
  cwd: string,
): Promise<boolean> {
  if (artifact.scope === undefined) return false;
  try {
    return (await verifyScopeDrift(artifact.scope, { workingDirectory: cwd })).matches;
  } catch {
    return false;
  }
}

export async function validateCodeReviewStageArtifacts(
  artifacts: unknown,
  cwd: string,
): Promise<FinalReviewArtifact | null> {
  const parsed = parseCodeReviewStageArtifacts(artifacts);
  if (parsed === null) return null;
  const runtime = await loadPersistedRuntimeArtifact(parsed.identity.artifact_path, cwd, {
    reviewId: parsed.identity.review_id,
    sha256: parsed.identity.artifact_sha256,
  });
  return runtime.artifact !== null
    && isDeepStrictEqual(runtime.artifact, parsed.artifact)
    ? runtime.artifact
    : null;
}

function hasSuccessorReworkEvidence(ctx: StageContext): boolean {
  const rework = ctx.artifacts.rework;
  return !!rework
    && typeof rework === 'object'
    && !Array.isArray(rework)
    && Object.hasOwn(rework as Record<string, unknown>, 'rework_evidence');
}

async function findSuccessorRuntimeArtifact(ctx: StageContext): Promise<RuntimeArtifact> {
  const rework = ctx.artifacts.rework;
  if (!rework || typeof rework !== 'object' || Array.isArray(rework)) {
    return { artifact: null, artifactPath: MISSING_ARTIFACT_PATH };
  }
  const evidence = (rework as Record<string, unknown>).rework_evidence;
  const sourceReview = evidence && typeof evidence === 'object'
    ? parseReviewArtifactIdentity((evidence as Record<string, unknown>).source_review)
    : null;
  const reviewCycle = typeof ctx.artifacts.review_cycle === 'number' ? ctx.artifacts.review_cycle : 0;
  const priorReview = ctx.artifacts['code-review'];
  const priorArtifact = priorReview && typeof priorReview === 'object' && !Array.isArray(priorReview)
    ? (priorReview as Record<string, unknown>).code_review_artifact
    : undefined;
  const sourceReviewFinalizedAt = priorArtifact && typeof priorArtifact === 'object' && !Array.isArray(priorArtifact)
    ? (priorArtifact as Record<string, unknown>).finalized_at
    : undefined;
  const validatedEvidence = sourceReview === null
    ? null
    : await validateFreshReworkEvidence(
      evidence,
      sourceReview,
      reviewCycle,
      ctx.cwd,
      typeof sourceReviewFinalizedAt === 'string' ? sourceReviewFinalizedAt : undefined,
    );
  const completedAt = reworkEvidenceCompletedAt(validatedEvidence);
  if (validatedEvidence === null || sourceReview === null || completedAt === null) {
    return { artifact: null, artifactPath: MISSING_ARTIFACT_PATH };
  }

  const reviewsRoot = resolve(ctx.cwd, '.omx', 'reviews');
  let entries: string[];
  try {
    entries = await readdir(reviewsRoot);
  } catch {
    return { artifact: null, artifactPath: MISSING_ARTIFACT_PATH };
  }

  const candidates: Array<RuntimeArtifact & { finalizedAtMs: number }> = [];
  for (const entry of entries) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/iu.test(entry)) {
      continue;
    }
    const artifactPath = `.omx/reviews/${entry}`;
    const runtime = await loadPersistedRuntimeArtifact(artifactPath, ctx.cwd);
    if (runtime.artifact === null || runtime.artifactSha256 === undefined) continue;
    const finalizedAtMs = Date.parse(runtime.artifact.finalized_at);
    if (runtime.artifact.status !== 'FINALIZED'
      || runtime.artifact.supersedes_review_id !== sourceReview.review_id
      || runtime.artifact.review_id === sourceReview.review_id
      || runtime.artifact.verdict.clean !== true
      || Number.isNaN(finalizedAtMs)
      || finalizedAtMs <= Date.parse(completedAt)) {
      continue;
    }
    candidates.push({ ...runtime, finalizedAtMs });
  }
  candidates.sort((left, right) => right.finalizedAtMs - left.finalizedAtMs);
  return candidates[0] ?? { artifact: null, artifactPath: MISSING_ARTIFACT_PATH };
}

function suggestedNextPhase(artifact: FinalReviewArtifact | null): 'ultraqa' | 'rework' | 'ralplan' {
  if (artifact?.verdict.clean === true) return 'ultraqa';
  if (artifact?.verdict.rule_id === 'NO_CHANGES') return 'ralplan';
  if (!artifact) return 'ralplan';
  const hasImplementationFindings = artifact.lanes.some((lane) =>
    lane.role === 'code-reviewer'
    && (lane.findings.length > 0 || lane.recommendation === 'REQUEST CHANGES'));
  if (hasImplementationFindings) return 'rework';
  return 'ralplan';
}

function defaultSummary(artifact: FinalReviewArtifact | null, legacyEvidencePresent: boolean): string {
  if (!artifact) {
    return legacyEvidencePresent
      ? 'Code-review runtime artifact missing or invalid; fail closed and return to ralplan.'
      : 'Code-review evidence missing; fail closed and return to ralplan.';
  }
  if (artifact.verdict.clean) return 'Review clean.';
  if (artifact.verdict.rule_id === 'NO_CHANGES') return 'No reviewable changes; return to ralplan.';
  return artifact.verdict.reasons[0] ?? 'Review returned findings; return to ralplan.';
}

export function createCodeReviewStage(options: CodeReviewStageOptions = {}): PipelineStage {
  return {
    name: 'code-review',

    async run(ctx: StageContext): Promise<StageResult> {
      const startTime = Date.now();
      const executionArtifacts = (ctx.artifacts.ultragoal as Record<string, unknown> | undefined)
        ?? (ctx.artifacts.ralph as Record<string, unknown> | undefined)
        ?? {};
      const descriptor: CodeReviewDescriptor = {
        task: ctx.task,
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        executionArtifacts,
        instruction: buildCodeReviewInstruction(ctx.task),
      };
      const legacyEvidencePresent = options.recommendation !== undefined || options.architecturalStatus !== undefined;
      const runtime = await findRuntimeArtifact(options, ctx);
      const recommendation = runtime.artifact?.verdict.recommendation ?? options.recommendation ?? 'REQUEST CHANGES';
      const architecturalStatus = runtime.artifact?.verdict.architectural_status ?? options.architecturalStatus ?? 'BLOCK';
      const clean = runtime.artifact?.status === 'FINALIZED'
        && runtime.artifact.verdict.clean === true
        && runtime.artifact.verdict.recommendation === 'APPROVE'
        && runtime.artifact.verdict.architectural_status === 'CLEAR';
      const verdict: CodeReviewVerdict = {
        recommendation,
        architectural_status: architecturalStatus,
        clean,
        summary: options.summary ?? defaultSummary(runtime.artifact, legacyEvidencePresent),
        stage: 'code-review',
        artifact_path: runtime.artifactPath,
        ...(runtime.artifactSha256 === undefined ? {} : { artifact_sha256: runtime.artifactSha256 }),
      };
      const nextPhase = suggestedNextPhase(runtime.artifact);

      return {
        status: 'completed',
        artifacts: {
          stage: 'code-review',
          codeReviewDescriptor: descriptor,
          review_verdict: verdict,
          ...(runtime.artifact ? { code_review_artifact: runtime.artifact } : {}),
          ...(runtime.artifact && runtime.artifactSha256 ? {
            code_review_artifact_identity: {
              review_id: runtime.artifact.review_id,
              revision: runtime.artifact.revision,
              artifact_path: runtime.artifactPath,
              artifact_sha256: runtime.artifactSha256,
            },
          } : {}),
          suggested_next_phase: nextPhase,
          return_to_ralplan_reason: clean ? null : verdict.summary,
          instruction: descriptor.instruction,
        },
        duration_ms: Date.now() - startTime,
      };
    },
  };
}

export function buildCodeReviewInstruction(task: string): string {
  return `$code-review ${JSON.stringify(task)}`;
}
