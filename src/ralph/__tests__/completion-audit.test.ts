import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateRalphCompletionAuditEvidence } from '../completion-audit.js';

test('rejects absolute completion-audit paths', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-audit-absolute-'));
  try {
    const result = evaluateRalphCompletionAuditEvidence({ completion_audit_path: '/etc/hosts' }, cwd);

    assert.equal(result.complete, false);
    assert.equal(result.reason, 'missing_completion_audit');
    assert.equal(result.source, 'missing');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('rejects non-JSON completion-audit artifacts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-audit-non-json-'));
  try {
    await writeFile(join(cwd, 'audit.md'), 'passed with checklist and tests', 'utf-8');

    const result = evaluateRalphCompletionAuditEvidence({ completion_audit_path: 'audit.md' }, cwd);

    assert.equal(result.complete, false);
    assert.equal(result.reason, 'missing_completion_audit');
    assert.equal(result.source, 'missing');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('rejects completion-audit artifacts outside the workspace', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-audit-traversal-'));
  const outside = await mkdtemp(join(tmpdir(), 'omx-ralph-audit-outside-'));
  try {
    await writeFile(
      join(outside, 'audit.json'),
      JSON.stringify({
        passed: true,
        prompt_to_artifact_checklist: ['mapped'],
        verification_evidence: ['tested'],
      }),
      'utf-8',
    );

    const result = evaluateRalphCompletionAuditEvidence(
      { completion_audit_path: relative(cwd, join(outside, 'audit.json')) },
      cwd,
    );

    assert.equal(result.complete, false);
    assert.equal(result.reason, 'missing_completion_audit');
    assert.equal(result.source, 'missing');
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('rejects completion-audit symlinks that resolve outside the workspace', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-audit-symlink-cwd-'));
  const outside = await mkdtemp(join(tmpdir(), 'omx-ralph-audit-symlink-outside-'));
  try {
    await writeFile(
      join(outside, 'audit.json'),
      JSON.stringify({
        passed: true,
        prompt_to_artifact_checklist: ['mapped'],
        verification_evidence: ['tested'],
      }),
      'utf-8',
    );
    await symlink(join(outside, 'audit.json'), join(cwd, 'audit.json'));

    const result = evaluateRalphCompletionAuditEvidence({ completion_audit_path: 'audit.json' }, cwd);

    assert.equal(result.complete, false);
    assert.equal(result.reason, 'missing_completion_audit');
    assert.equal(result.source, 'missing');
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('rejects malformed and empty completion-audit JSON artifacts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-audit-invalid-json-'));
  try {
    await writeFile(join(cwd, 'empty.json'), '', 'utf-8');
    await writeFile(join(cwd, 'invalid.json'), '{not json', 'utf-8');

    for (const path of ['empty.json', 'invalid.json']) {
      const result = evaluateRalphCompletionAuditEvidence({ completion_audit_path: path }, cwd);

      assert.equal(result.complete, false);
      assert.equal(result.reason, 'missing_completion_audit');
      assert.equal(result.source, 'missing');
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('requires explicit passed=true in completion-audit evidence', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-audit-explicit-pass-'));
  try {
    await writeFile(
      join(cwd, 'audit.json'),
      JSON.stringify({
        status: 'passed',
        prompt_to_artifact_checklist: ['mapped'],
        verification_evidence: ['tested'],
      }),
      'utf-8',
    );

    const result = evaluateRalphCompletionAuditEvidence({ completion_audit_path: 'audit.json' }, cwd);

    assert.equal(result.complete, false);
    assert.equal(result.reason, 'completion_audit_not_passing');
    assert.equal(result.source, 'artifact');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('requires explicit passed=true in inline completion-audit state', () => {
  for (const completion_audit of [
    {
      passed: false,
      prompt_to_artifact_checklist: ['mapped'],
      verification_evidence: ['tested'],
    },
    {
      status: 'passed',
      prompt_to_artifact_checklist: ['mapped'],
      verification_evidence: ['tested'],
    },
  ]) {
    const result = evaluateRalphCompletionAuditEvidence({ completion_audit }, process.cwd());

    assert.equal(result.complete, false);
    assert.equal(result.reason, 'completion_audit_not_passing');
    assert.equal(result.source, 'state');
  }
});

test('requires checklist and verification evidence in inline completion-audit state', () => {
  const missingChecklist = evaluateRalphCompletionAuditEvidence({
    completion_audit: {
      passed: true,
      verification_evidence: ['tested'],
    },
  }, process.cwd());

  assert.equal(missingChecklist.complete, false);
  assert.equal(missingChecklist.reason, 'missing_completion_checklist');
  assert.equal(missingChecklist.source, 'state');

  const missingEvidence = evaluateRalphCompletionAuditEvidence({
    completion_audit: {
      passed: true,
      prompt_to_artifact_checklist: ['mapped'],
    },
  }, process.cwd());

  assert.equal(missingEvidence.complete, false);
  assert.equal(missingEvidence.reason, 'missing_verification_evidence');
  assert.equal(missingEvidence.source, 'state');
});

test('accepts structured relative JSON completion-audit artifacts with evidence', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-audit-valid-json-'));
  try {
    await writeFile(
      join(cwd, 'audit.json'),
      JSON.stringify({
        passed: true,
        prompt_to_artifact_checklist: ['mapped prompt to artifact'],
        verification_evidence: ['node --test dist/ralph/__tests__/completion-audit.test.js'],
      }),
      'utf-8',
    );

    const result = evaluateRalphCompletionAuditEvidence({ completion_audit_path: 'audit.json' }, cwd);

    assert.equal(result.complete, true);
    assert.equal(result.reason, 'completion_audit_passed');
    assert.equal(result.source, 'artifact');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
