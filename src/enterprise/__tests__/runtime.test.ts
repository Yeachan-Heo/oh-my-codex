import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyEnterpriseExecutionUpdates,
  assignEnterpriseSubordinate,
  completeEnterpriseRuntime,
  escalateEnterpriseNode,
  readEnterpriseRuntime,
  refreshEnterpriseRuntime,
  startEnterpriseRuntime,
} from '../runtime.js';
import {
  listEnterpriseAssignments,
  listEnterpriseEscalations,
  readEnterpriseChairmanSummary,
  readEnterpriseEventLog,
  readEnterpriseSubordinateRecord,
} from '../state.js';

describe('enterprise runtime', () => {
  it('starts enterprise mode and persists a topology snapshot', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-runtime-'));
    try {
      const handle = await startEnterpriseRuntime('ship enterprise phase 1', {
        divisions: [
          { id: 'division-research', label: 'Research', scope: 'investigate reuse' },
          { id: 'division-exec', label: 'Execution', scope: 'build runtime shell' },
        ],
      }, cwd);

      assert.equal(handle.modeState.active, true);
      assert.equal(handle.snapshot.chairmanSummary.divisionCount, 2);
      assert.equal(handle.snapshot.monitor.subordinateCount, 2);

      const reread = await readEnterpriseRuntime(cwd);
      assert.ok(reread);
      assert.equal(reread?.snapshot.monitor.divisionCount, 2);
      const chairmanSummary = await readEnterpriseChairmanSummary(cwd);
      assert.equal(chairmanSummary?.divisionCount, 2);
      const subordinate = await readEnterpriseSubordinateRecord(cwd, 'subordinate-1');
      assert.equal(subordinate?.status, 'pending');
      const events = await readEnterpriseEventLog(cwd);
      assert.ok(events.some((event) => event.type === 'runtime_started'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('assigns a new subordinate beneath a division lead and records the assignment', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-runtime-'));
    try {
      await startEnterpriseRuntime('ship enterprise phase 1', {
        divisions: [{ id: 'division-research', label: 'Research', scope: 'investigate reuse' }],
      }, cwd);

      const result = await assignEnterpriseSubordinate('division-research', 'Verifier', 'verify runtime shell', cwd);
      assert.equal(result.handle.snapshot.monitor.subordinateCount, 2);
      assert.equal(result.subordinateId.startsWith('subordinate-'), true);
      const assignments = await listEnterpriseAssignments(cwd);
      assert.equal(assignments.length, 1);
      assert.equal(assignments[0]?.nodeId, result.subordinateId);
      const events = await readEnterpriseEventLog(cwd);
      assert.ok(events.some((event) => event.type === 'assignment_created'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('creates escalation records for escalated subordinate work', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-runtime-'));
    try {
      await startEnterpriseRuntime('ship enterprise phase 1', {
        divisions: [{ id: 'division-research', label: 'Research', scope: 'investigate reuse' }],
        subordinates: [{ id: 'subordinate-research', leadId: 'division-research', label: 'Probe', scope: 'investigate reuse' }],
      }, cwd);

      const result = await escalateEnterpriseNode('subordinate-research', 'needs chairman review', 'shared file conflict', cwd);
      assert.equal(result.handle.snapshot.monitor.chairmanState, 'working');
      const escalations = await listEnterpriseEscalations(cwd);
      assert.equal(escalations.length >= 1, true);
      assert.equal(escalations.at(-1)?.nodeId, 'subordinate-research');
      const events = await readEnterpriseEventLog(cwd);
      assert.ok(events.some((event) => event.type === 'escalation_created'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('applies subordinate execution updates and rolls up monitor state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-runtime-'));
    try {
      await startEnterpriseRuntime('ship enterprise phase 1', {
        divisions: [{ id: 'division-research', label: 'Research', scope: 'investigate reuse' }],
        subordinates: [{ id: 'subordinate-research', leadId: 'division-research', label: 'Probe', scope: 'investigate reuse' }],
      }, cwd);

      const updated = await applyEnterpriseExecutionUpdates([
        {
          nodeId: 'subordinate-research',
          status: 'completed',
          summary: 'Mapped the reusable runtime seams',
        },
      ], cwd);

      assert.equal(updated.snapshot.monitor.chairmanState, 'completed');
      assert.equal(updated.modeState.current_phase, 'enterprise-verify');
      const subordinate = await readEnterpriseSubordinateRecord(cwd, 'subordinate-research');
      assert.equal(subordinate?.status, 'completed');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('refreshes enterprise monitor state from persisted runtime snapshot', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-runtime-'));
    try {
      await startEnterpriseRuntime('ship enterprise phase 1', {}, cwd);
      const refreshed = await refreshEnterpriseRuntime(cwd);
      assert.equal(refreshed.snapshot.monitor.divisionCount, 1);
      assert.equal(refreshed.modeState.chairman_state, refreshed.snapshot.monitor.chairmanState);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('marks enterprise mode complete', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-runtime-'));
    try {
      await startEnterpriseRuntime('ship enterprise phase 1', {}, cwd);
      const completed = await completeEnterpriseRuntime(cwd);
      assert.equal(completed.active, false);
      assert.equal(completed.current_phase, 'complete');
      assert.ok(typeof completed.completed_at === 'string');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
