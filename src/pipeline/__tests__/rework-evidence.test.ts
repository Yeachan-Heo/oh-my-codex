import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  createReworkStage,
  isFreshReworkEvidence,
  parseReviewArtifactIdentity,
  validateFreshReworkEvidence,
} from '../stages/rework.js';
import { createCodeReviewStage } from '../stages/code-review.js';
import type { StageContext } from '../types.js';

const sourceReview = {
  review_id: '11111111-1111-4111-8111-111111111111',
  revision: 4,
  artifact_path: '.omx/reviews/11111111-1111-4111-8111-111111111111.json',
  artifact_sha256: 'a'.repeat(64),
};

const evidence = {
  schema_version: 1 as const,
  review_cycle: 2,
  source_review: sourceReview,
  execution_id: '22222222-2222-4222-8222-222222222222',
  implementation_artifact_sha256: 'b'.repeat(64),
  verification_artifact_sha256: 'c'.repeat(64),
};

let tempDir = '';

async function setup(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-rework-evidence-test-'));
}

async function cleanup(): Promise<void> {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDir = '';
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function writeReworkArtifact(
  relativePath: string,
  payload: Record<string, unknown>,
): Promise<{ path: string; sha256: string; payload: Record<string, unknown> }> {
  const raw = `${JSON.stringify(payload, null, 2)}\n`;
  await mkdir(join(tempDir, '.omx', 'rework'), { recursive: true });
  await writeFile(join(tempDir, relativePath), raw);
  return { path: relativePath, sha256: sha256(raw), payload };
}

async function durableEvidence(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const executionId = '22222222-2222-4222-8222-222222222222';
  const implementation = await writeReworkArtifact('.omx/rework/implementation.json', {
    schema_version: 1,
    artifact_kind: 'rework_implementation',
    execution_id: executionId,
    review_cycle: 2,
    source_review: sourceReview,
    source_identity: {
      agent_role: 'executor',
      thread_id: 'thread-executor',
      produced_at: '2026-07-15T00:10:00.000Z',
    },
    changed_files: ['src/pipeline/orchestrator.ts'],
    summary: 'Applied the code-review remediation.',
  });
  const verification = await writeReworkArtifact('.omx/rework/verification.json', {
    schema_version: 1,
    artifact_kind: 'rework_verification',
    execution_id: executionId,
    review_cycle: 2,
    source_review: sourceReview,
    source_identity: {
      agent_role: 'test-engineer',
      thread_id: 'thread-test',
      produced_at: '2026-07-15T00:12:00.000Z',
    },
    checks: [{
      command: 'npm test -- src/pipeline/__tests__/orchestrator.test.ts',
      exit_code: 0,
      source: 'local',
    }],
  });
  return {
    schema_version: 1,
    review_cycle: 2,
    source_review: sourceReview,
    execution_id: executionId,
    implementation_artifact: {
      path: implementation.path,
      sha256: implementation.sha256,
      source_identity: (implementation.payload.source_identity as Record<string, unknown>),
    },
    verification_artifact: {
      path: verification.path,
      sha256: verification.sha256,
      source_identity: (verification.payload.source_identity as Record<string, unknown>),
    },
    ...overrides,
  };
}

async function rewriteEvidenceArtifact(
  value: Record<string, unknown>,
  key: 'implementation_artifact' | 'verification_artifact',
  mutate: (payload: Record<string, unknown>) => void,
): Promise<void> {
  const descriptor = value[key] as Record<string, unknown>;
  const path = String(descriptor.path);
  const payload = JSON.parse(await readFile(join(tempDir, path), 'utf8')) as Record<string, unknown>;
  mutate(payload);
  const raw = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(join(tempDir, path), raw);
  descriptor.sha256 = sha256(raw);
  descriptor.source_identity = payload.source_identity;
}

function reworkCtx(evidenceValue: unknown): StageContext {
  return {
    task: 'fix review findings',
    cwd: tempDir,
    artifacts: {
      review_cycle: 2,
      rework_execution_evidence: evidenceValue,
      'code-review': {
        suggested_next_phase: 'rework',
        review_verdict: {
          clean: false,
          recommendation: 'REQUEST CHANGES',
          architectural_status: 'CLEAR',
        },
        code_review_artifact_identity: sourceReview,
        code_review_artifact: { finalized_at: '2026-07-15T00:01:00.000Z' },
      },
    },
  };
}

describe('rework evidence identity', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('accepts only the exact persisted review artifact identity', () => {
    assert.deepEqual(parseReviewArtifactIdentity(sourceReview), sourceReview);
    assert.deepEqual(parseReviewArtifactIdentity({ ...sourceReview, revision: 0 }), {
      ...sourceReview,
      revision: 0,
    });
    for (const value of [
      null,
      {},
      { ...sourceReview, unknown: true },
      { ...sourceReview, review_id: 'bad' },
      { ...sourceReview, revision: -1 },
      { ...sourceReview, revision: 1.5 },
      { ...sourceReview, artifact_path: '.omx/reviews/other.json' },
      { ...sourceReview, artifact_sha256: 'bad' },
    ]) assert.equal(parseReviewArtifactIdentity(value), null, JSON.stringify(value));
  });

  it('rejects descriptor-only implementation and verification hashes without persisted artifacts', () => {
    assert.equal(isFreshReworkEvidence(evidence, sourceReview, 2), false);
    for (const value of [
      { ...evidence, unknown: true },
      { ...evidence, schema_version: 2 },
      { ...evidence, review_cycle: 1 },
      { ...evidence, execution_id: 'bad' },
      { ...evidence, implementation_artifact_sha256: 'bad' },
      { ...evidence, verification_artifact_sha256: 'bad' },
      { ...evidence, source_review: { ...sourceReview, revision: 5 } },
      { ...evidence, implementation_artifact_sha256: sourceReview.artifact_sha256 },
      { ...evidence, verification_artifact_sha256: sourceReview.artifact_sha256 },
    ]) assert.equal(isFreshReworkEvidence(value, sourceReview, 2), false, JSON.stringify(value));
  });

  it('requires real persisted implementation and verification artifacts bound to source identity and cycle', async () => {
    const validEvidence = await durableEvidence();
    const validResult = await createReworkStage().run(reworkCtx(validEvidence));

    assert.equal(validResult.status, 'completed');
    assert.deepEqual(validResult.artifacts.rework_evidence, validEvidence);

    const staleCycle = await durableEvidence({ review_cycle: 1 });
    const staleCycleResult = await createReworkStage().run(reworkCtx(staleCycle));
    assert.equal(staleCycleResult.status, 'failed');
    assert.equal(staleCycleResult.error, 'rework_execution_evidence_missing_or_stale');

    const fabricated = await durableEvidence({
      implementation_artifact: {
        path: '.omx/rework/missing-implementation.json',
        sha256: 'd'.repeat(64),
        source_identity: { agent_role: 'executor', thread_id: 'thread-executor' },
      },
    });
    const fabricatedResult = await createReworkStage().run(reworkCtx(fabricated));
    assert.equal(fabricatedResult.status, 'failed');
    assert.equal(fabricatedResult.error, 'rework_execution_evidence_missing_or_stale');

    const tampered = await durableEvidence();
    await writeFile(join(tempDir, '.omx/rework/implementation.json'), '{"tampered":true}\n');
    const tamperedResult = await createReworkStage().run(reworkCtx(tampered));
    assert.equal(tamperedResult.status, 'failed');
    assert.equal(tamperedResult.error, 'rework_execution_evidence_missing_or_stale');

    const wrongSource = await durableEvidence({
      source_review: { ...sourceReview, review_id: '33333333-3333-4333-8333-333333333333' },
    });
    const wrongSourceResult = await createReworkStage().run(reworkCtx(wrongSource));
    assert.equal(wrongSourceResult.status, 'failed');
    assert.equal(wrongSourceResult.error, 'rework_execution_evidence_missing_or_stale');
  });

  it('fails closed when successor lookup has stale evidence or no review artifact directory', async () => {
    const staleContext = reworkCtx({});
    staleContext.artifacts.rework = { rework_evidence: {} };
    const stale = await createCodeReviewStage().run(staleContext);
    assert.equal((stale.artifacts.review_verdict as Record<string, unknown>).clean, false);

    const validEvidence = await durableEvidence();
    const missingDirectoryContext = reworkCtx(validEvidence);
    missingDirectoryContext.artifacts.rework = { rework_evidence: validEvidence };
    const missingDirectory = await createCodeReviewStage().run(missingDirectoryContext);
    assert.equal((missingDirectory.artifacts.review_verdict as Record<string, unknown>).clean, false);
  });

  it('validates external review binding, independent agents, causal ordering, and artifact payloads', async () => {
    const valid = await durableEvidence();
    assert.deepEqual(
      await validateFreshReworkEvidence(valid, sourceReview, 2, tempDir, '2026-07-15T00:01:00.000Z'),
      valid,
    );
    assert.equal(await validateFreshReworkEvidence(
      valid, { ...sourceReview, revision: 5 }, 2, tempDir, '2026-07-15T00:01:00.000Z',
    ), null);
    assert.equal(await validateFreshReworkEvidence(
      valid, sourceReview, 3, tempDir, '2026-07-15T00:01:00.000Z',
    ), null);
    assert.equal(await validateFreshReworkEvidence(valid, sourceReview, 2, tempDir), null);
    assert.equal(await validateFreshReworkEvidence(
      valid, sourceReview, 2, tempDir, 'not-a-timestamp',
    ), null);
    assert.equal(await validateFreshReworkEvidence(
      valid, sourceReview, 2, tempDir, '2026-07-15T00:10:00.000Z',
    ), null);

    const sameProducedAt = await durableEvidence();
    await rewriteEvidenceArtifact(sameProducedAt, 'verification_artifact', (payload) => {
      (payload.source_identity as Record<string, unknown>).produced_at = '2026-07-15T00:10:00.000Z';
    });
    assert.equal(await validateFreshReworkEvidence(
      sameProducedAt, sourceReview, 2, tempDir, '2026-07-15T00:01:00.000Z',
    ), null);

    const sameThread = await durableEvidence();
    await rewriteEvidenceArtifact(sameThread, 'verification_artifact', (payload) => {
      (payload.source_identity as Record<string, unknown>).thread_id = 'thread-executor';
    });
    assert.equal(await validateFreshReworkEvidence(
      sameThread, sourceReview, 2, tempDir, '2026-07-15T00:01:00.000Z',
    ), null);

    const missingArtifact = await durableEvidence();
    (missingArtifact.implementation_artifact as Record<string, unknown>).path = '.omx/rework/missing.json';
    (missingArtifact.implementation_artifact as Record<string, unknown>).sha256 = 'd'.repeat(64);
    assert.equal(await validateFreshReworkEvidence(
      missingArtifact, sourceReview, 2, tempDir, '2026-07-15T00:01:00.000Z',
    ), null);

    const malformedDescriptor = await durableEvidence();
    (malformedDescriptor.implementation_artifact as Record<string, unknown>).path = 42;
    assert.equal(await validateFreshReworkEvidence(
      malformedDescriptor, sourceReview, 2, tempDir, '2026-07-15T00:01:00.000Z',
    ), null);

    const escapedArtifact = await durableEvidence();
    (escapedArtifact.implementation_artifact as Record<string, unknown>).path = 'implementation.json';
    assert.equal(await validateFreshReworkEvidence(
      escapedArtifact, sourceReview, 2, tempDir, '2026-07-15T00:01:00.000Z',
    ), null);

    const oversizedArtifact = await durableEvidence();
    const oversizedRaw = 'x'.repeat(1024 * 1024 + 1);
    await writeFile(join(tempDir, '.omx', 'rework', 'oversized.json'), oversizedRaw);
    const oversizedDescriptor = oversizedArtifact.implementation_artifact as Record<string, unknown>;
    oversizedDescriptor.path = '.omx/rework/oversized.json';
    oversizedDescriptor.sha256 = sha256(oversizedRaw);
    assert.equal(await validateFreshReworkEvidence(
      oversizedArtifact, sourceReview, 2, tempDir, '2026-07-15T00:01:00.000Z',
    ), null);

    const invalidImplementation = await durableEvidence();
    await rewriteEvidenceArtifact(invalidImplementation, 'implementation_artifact', (payload) => {
      payload.changed_files = [];
    });
    assert.equal(await validateFreshReworkEvidence(
      invalidImplementation, sourceReview, 2, tempDir, '2026-07-15T00:01:00.000Z',
    ), null);

    const invalidVerification = await durableEvidence();
    await rewriteEvidenceArtifact(invalidVerification, 'verification_artifact', (payload) => {
      payload.checks = [{ command: 'npm test', exit_code: 1, source: 'local' }];
    });
    assert.equal(await validateFreshReworkEvidence(
      invalidVerification, sourceReview, 2, tempDir, '2026-07-15T00:01:00.000Z',
    ), null);
  });
});
