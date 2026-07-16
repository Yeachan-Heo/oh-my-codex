import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createCodeReviewStage } from '../../pipeline/stages/code-review.js';
import { createReworkStage } from '../../pipeline/stages/rework.js';
import { dispatchCodexNativeHook } from '../codex-native-hook.js';
import { writeSessionStart } from '../../hooks/session.js';
import type { StageContext } from '../../pipeline/types.js';
import { resolveGitScope } from '../../code-review/scope.js';

const REVIEW_ID = '11111111-1111-4111-8111-111111111111';

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function finalizedArtifact(): Record<string, unknown> {
  const scopeHash = 'a'.repeat(64);
  return {
    schema_version: 1,
    review_id: REVIEW_ID,
    revision: 3,
    status: 'FINALIZED',
    current_attempt: 1,
    scope: {
      selector: { explicit_paths: [] }, status: 'FULL_SCOPE', scope_hash: scopeHash,
      files: [{
        path: 'src/example.ts', change: 'MODIFIED', sources: ['WORKTREE'], binary: false,
        additions: 1, deletions: 0,
      }],
      changed_lines: 1, reasons: [],
    },
    review_flags: [],
    batches: [{
      batch_id: 'batch-1', module_root: '.', files: ['src/example.ts'],
      changed_lines: 1, oversized_single_file: false,
    }],
    lanes: [
      {
        lane_id: 'reviewer-1', role: 'code-reviewer', batch_id: 'batch-1', scope_hash: scopeHash,
        status: 'COMPLETE', attempt: 1, recommendation: 'APPROVE', findings: [], diagnostic_ids: [],
      },
      {
        lane_id: 'architect-1', role: 'architect', batch_id: 'global', scope_hash: scopeHash,
        status: 'COMPLETE', attempt: 1, architectural_status: 'CLEAR', findings: [], diagnostic_ids: [],
      },
    ],
    diagnostics: [],
    verdict: {
      recommendation: 'APPROVE', architectural_status: 'CLEAR', scope_status: 'FULL_SCOPE',
      evidence_status: 'FULL_EVIDENCE', rule_id: 'CLEAN_APPROVAL',
      reasons: ['ALL_REQUIRED_EVIDENCE_CLEAR'], clean: true,
    },
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:01:00.000Z',
    finalized_at: '2026-07-15T00:01:00.000Z',
  };
}

async function initializeChangedRepository(root: string): Promise<void> {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'installed@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Installed Contract Test'], { cwd: root });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'example.ts'), 'export const value = 1;\n');
  execFileSync('git', ['add', '--', 'src/example.ts'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  await writeFile(join(root, 'src', 'example.ts'), 'export const value = 2;\n');
}

async function bindCurrentScope(root: string, artifact: Record<string, unknown>): Promise<void> {
  const scope = await resolveGitScope({
    workingDirectory: root,
    selector: { requested_base: 'HEAD', explicit_paths: [] },
  });
  artifact.scope = scope;
  for (const lane of artifact.lanes as Array<Record<string, unknown>>) lane.scope_hash = scope.scope_hash;
  const batch = (artifact.batches as Array<Record<string, unknown>>)[0];
  if (batch) {
    batch.files = scope.files.map((file) => file.path);
    batch.changed_lines = scope.changed_lines;
  }
}

describe('installed code-review runtime contract', () => {
  it('accepts only a persisted finalized artifact with matching coordinator identity and digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-installed-review-stage-'));
    try {
      await initializeChangedRepository(root);
      const artifact = finalizedArtifact();
      await bindCurrentScope(root, artifact);
      const artifactPath = `.omx/reviews/${REVIEW_ID}.json`;
      const raw = `${JSON.stringify(artifact, null, 2)}\n`;
      await writeJson(join(root, artifactPath), artifact);
      const artifactSha256 = createHash('sha256').update(raw).digest('hex');
      const context: StageContext = { task: 'review packed contract', cwd: root, artifacts: {} };

      const absent = await createCodeReviewStage().run(context);
      assert.equal((absent.artifacts.review_verdict as { clean?: boolean }).clean, false);

      const valid = await createCodeReviewStage({
        artifactPath, artifactReviewId: REVIEW_ID, artifactSha256,
      }).run(context);
      assert.equal((valid.artifacts.review_verdict as { clean?: boolean }).clean, true);

      const wrongDigest = await createCodeReviewStage({
        artifactPath, artifactReviewId: REVIEW_ID, artifactSha256: 'b'.repeat(64),
      }).run(context);
      assert.equal((wrongDigest.artifacts.review_verdict as { clean?: boolean }).clean, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks descriptor-only rework and accepts evidence bound to the blocking review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-installed-rework-stage-'));
    const sourceReview = {
      review_id: REVIEW_ID,
      revision: 3,
      artifact_path: `.omx/reviews/${REVIEW_ID}.json`,
      artifact_sha256: 'a'.repeat(64),
    };
    try {
      const context: StageContext = {
        task: 'repair packed findings', cwd: root,
        artifacts: {
          review_cycle: 1,
          'code-review': {
            suggested_next_phase: 'rework',
            review_verdict: { clean: false },
            code_review_artifact_identity: sourceReview,
            code_review_artifact: { finalized_at: '2026-07-15T00:01:00.000Z' },
          },
        },
      };
      const descriptorOnly = await createReworkStage().run(context);
      assert.equal(descriptorOnly.status, 'failed');
      assert.equal(descriptorOnly.error, 'rework_execution_evidence_missing_or_stale');

      const executionId = '22222222-2222-4222-8222-222222222222';
      const implementationIdentity = {
        agent_role: 'executor', thread_id: 'installed-executor',
        produced_at: '2026-07-15T00:10:00.000Z',
      };
      const verificationIdentity = {
        agent_role: 'test-engineer', thread_id: 'installed-test-engineer',
        produced_at: '2026-07-15T00:12:00.000Z',
      };
      const implementation = {
        schema_version: 1, artifact_kind: 'rework_implementation', execution_id: executionId,
        review_cycle: 1, source_review: sourceReview, source_identity: implementationIdentity,
        changed_files: ['src/example.ts'], summary: 'Applied the review findings.',
      };
      const verification = {
        schema_version: 1, artifact_kind: 'rework_verification', execution_id: executionId,
        review_cycle: 1, source_review: sourceReview, source_identity: verificationIdentity,
        checks: [{ command: 'npm test', exit_code: 0, source: 'local' }],
      };
      const implementationRaw = `${JSON.stringify(implementation, null, 2)}\n`;
      const verificationRaw = `${JSON.stringify(verification, null, 2)}\n`;
      await writeJson(join(root, '.omx', 'rework', 'implementation.json'), implementation);
      await writeJson(join(root, '.omx', 'rework', 'verification.json'), verification);
      const evidenced = await createReworkStage({ executionEvidence: {
        schema_version: 1,
        review_cycle: 1,
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
      } }).run(context);
      assert.equal(evidenced.status, 'completed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps packed hook and CLI recovery surfaces fail closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-installed-review-surfaces-'));
    try {
      const sessionId = 'installed-review-session';
      const rootThreadId = 'installed-review-root';
      await writeSessionStart(root, sessionId, { nativeSessionId: rootThreadId });
      await writeJson(join(root, '.omx', 'state', 'sessions', sessionId, 'skill-active-state.json'), {
        active: true,
        skill: 'code-review',
        phase: 'reviewing',
        session_id: sessionId,
        thread_id: rootThreadId,
        active_skills: [{
          skill: 'code-review', phase: 'reviewing', active: true,
          session_id: sessionId, thread_id: rootThreadId, review_status: 'CREATED',
        }],
      });
      const stopped = await dispatchCodexNativeHook({
        hook_event_name: 'Stop', cwd: root, session_id: rootThreadId, thread_id: rootThreadId,
      }, { cwd: root });
      assert.equal(stopped.outputJson?.decision, 'block');

      const packageRoot = process.env.OMX_TEST_PACKAGE_ROOT;
      assert.ok(packageRoot, 'installed test runner must identify the packed package root');
      const cli = spawnSync(
        process.execPath,
        [join(packageRoot, 'dist', 'cli', 'omx.js'), 'state', 'review-get', '--input', '-', '--json'],
        { cwd: root, input: '{}', encoding: 'utf8' },
      );
      assert.notEqual(cli.status, 0);
      assert.match(cli.stderr, /workingDirectory|INVALID_INVOCATION/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
