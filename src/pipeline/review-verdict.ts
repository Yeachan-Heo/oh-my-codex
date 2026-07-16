/** Shared helpers for interpreting code-review stage verdicts. */

import { validateFinalReviewArtifact } from '../code-review/render.js';
import type { FinalReviewArtifact } from '../code-review/contract.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;

interface CodeReviewArtifactIdentity {
  review_id: string;
  revision: number;
  artifact_path: string;
  artifact_sha256: string;
}

export interface ParsedCodeReviewStageArtifacts {
  artifact: FinalReviewArtifact;
  identity: CodeReviewArtifactIdentity;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseArtifactIdentity(value: unknown): CodeReviewArtifactIdentity | null {
  if (!isPlainObject(value)
    || Object.keys(value).length !== 4
    || typeof value.review_id !== 'string'
    || !UUID.test(value.review_id)
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
    || typeof value.artifact_path !== 'string'
    || value.artifact_path !== `.omx/reviews/${value.review_id}.json`
    || typeof value.artifact_sha256 !== 'string'
    || !SHA256.test(value.artifact_sha256)) {
    return null;
  }
  return {
    review_id: value.review_id,
    revision: value.revision as number,
    artifact_path: value.artifact_path,
    artifact_sha256: value.artifact_sha256,
  };
}

function parseFinalReviewArtifact(value: unknown): FinalReviewArtifact | null {
  try {
    return validateFinalReviewArtifact(value);
  } catch {
    return null;
  }
}

export function parseCodeReviewStageArtifacts(
  artifacts: unknown,
): ParsedCodeReviewStageArtifacts | null {
  if (!isPlainObject(artifacts)) return null;
  const identity = parseArtifactIdentity(artifacts.code_review_artifact_identity);
  const artifact = parseFinalReviewArtifact(artifacts.code_review_artifact);
  if (identity === null || artifact === null) return null;
  if (!isPlainObject(artifacts.review_verdict)) return null;
  const verdict = artifacts.review_verdict;
  if (artifact.review_id !== identity.review_id
    || artifact.revision !== identity.revision
    || verdict.clean !== artifact.verdict.clean
    || verdict.recommendation !== artifact.verdict.recommendation
    || verdict.architectural_status !== artifact.verdict.architectural_status
    || verdict.stage !== 'code-review'
    || verdict.artifact_path !== identity.artifact_path
    || verdict.artifact_sha256 !== identity.artifact_sha256) {
    return null;
  }
  return { artifact, identity };
}

export function isCleanCodeReviewStageArtifacts(artifacts: unknown): boolean {
  const parsed = parseCodeReviewStageArtifacts(artifacts);
  return parsed !== null
    && parsed.artifact.review_id === parsed.identity.review_id
    && parsed.artifact.status === 'FINALIZED'
    && parsed.artifact.verdict.clean === true
    && parsed.artifact.verdict.recommendation === 'APPROVE'
    && parsed.artifact.verdict.architectural_status === 'CLEAR';
}

export function isCleanReviewVerdict(verdict: unknown, artifacts?: unknown): boolean {
  return isPlainObject(artifacts)
    && artifacts.review_verdict === verdict
    && isCleanCodeReviewStageArtifacts(artifacts);
}

export function isNonCleanReviewVerdict(verdict: unknown, artifacts?: unknown): boolean {
  return !isCleanReviewVerdict(verdict, artifacts);
}
