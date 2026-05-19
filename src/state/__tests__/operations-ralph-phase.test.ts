import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeStateOperation } from '../operations.js';

describe('state operations Ralph phase contract', () => {
  it('normalizes legacy Ralph phase aliases on state_write', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-phase-'));
    try {
      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        active: true,
        current_phase: 'execution',
        started_at: '2026-02-22T00:00:00.000Z',
      });
      assert.equal(response.isError, undefined);

      const file = join(wd, '.omx', 'state', 'ralph-state.json');
      const state = JSON.parse(await readFile(file, 'utf-8'));
      assert.equal(state.current_phase, 'executing');
      assert.equal(state.ralph_phase_normalized_from, 'execution');
      assert.equal(state.run_outcome, 'continue');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('accepts blocked_on_user as an explicit terminal Ralph outcome', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-phase-'));
    try {
      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        active: false,
        current_phase: 'blocked_on_user',
      });
      assert.equal(response.isError, undefined);

      const file = join(wd, '.omx', 'state', 'ralph-state.json');
      const state = JSON.parse(await readFile(file, 'utf-8'));
      assert.equal(state.current_phase, 'blocked_on_user');
      assert.equal(state.run_outcome, 'blocked_on_user');
      assert.equal(typeof state.completed_at, 'string');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects unknown Ralph phases on state_write', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-phase-'));
    try {
      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        active: true,
        current_phase: 'bananas',
      });
      assert.equal(response.isError, true);
      const body = response.payload as { error?: string };
      assert.match(body.error || '', /Invalid Ralph phase|must be one of/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects terminal Ralph phase when active=true', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-phase-'));
    try {
      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        active: true,
        current_phase: 'complete',
      });
      assert.equal(response.isError, true);
      const body = response.payload as { error?: string };
      assert.match(body.error || '', /terminal Ralph phases require active=false/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects complete Ralph state without completion-audit evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-complete-audit-'));
    try {
      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        active: false,
        current_phase: 'complete',
      });
      assert.equal(response.isError, true);
      const body = response.payload as { error?: string };
      assert.match(body.error || '', /requires passing completion_audit/i);
      assert.match(body.error || '', /missing_completion_audit/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects complete Ralph state without completion-audit evidence when active is omitted', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-complete-audit-'));
    try {
      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        current_phase: 'complete',
      });
      assert.equal(response.isError, true);
      const body = response.payload as { error?: string };
      assert.match(body.error || '', /requires passing completion_audit/i);
      assert.match(body.error || '', /missing_completion_audit/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('accepts complete Ralph state with in-state completion-audit evidence and clears stale audit gate markers', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-complete-audit-'));
    try {
      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        active: false,
        current_phase: 'complete',
        completion_audit_gate: 'blocked',
        completion_audit_missing_reason: 'missing_completion_checklist',
        completion_audit_blocked_at: '2026-05-10T12:00:00.000Z',
        completion_audit: {
          passed: true,
          prompt_to_artifact_checklist: ['requirement mapped to committed source changes'],
          verification_evidence: ['npm run build exited 0'],
        },
      });
      assert.equal(response.isError, undefined);

      const file = join(wd, '.omx', 'state', 'ralph-state.json');
      const state = JSON.parse(await readFile(file, 'utf-8'));
      assert.equal(state.current_phase, 'complete');
      assert.equal(state.active, false);
      assert.equal(typeof state.completed_at, 'string');
      assert.equal(state.completion_audit_gate, undefined);
      assert.equal(state.completion_audit_missing_reason, undefined);
      assert.equal(state.completion_audit_blocked_at, undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('accepts complete Ralph state with repo-relative completion-audit artifact', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-complete-audit-path-'));
    try {
      await writeFile(
        join(wd, 'audit.json'),
        JSON.stringify({
          passed: true,
          prompt_to_artifact_checklist: ['prompt requirement has an artifact'],
          verification_evidence: ['node --test dist/state/__tests__/operations-ralph-phase.test.js exited 0'],
        }),
        'utf-8',
      );

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        active: false,
        current_phase: 'complete',
        completion_audit_path: 'audit.json',
      });
      assert.equal(response.isError, undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects fractional iteration values for Ralph state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-phase-'));
    try {
      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        active: true,
        current_phase: 'executing',
        iteration: 0.25,
        max_iterations: 10.5,
      });
      assert.equal(response.isError, true);
      const body = response.payload as { error?: string };
      assert.match(body.error || '', /finite integer/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
