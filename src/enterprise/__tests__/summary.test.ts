import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEnterpriseTopology, addDivisionLead, addSubordinate } from '../topology.js';
import { projectChairmanSummary, summarizeDivisionLead } from '../summary.js';

describe('enterprise summary projection', () => {
  it('keeps chairman view summary-first while preserving escalations', () => {
    let topology = createEnterpriseTopology({ task: 'summary first' });
    topology = addDivisionLead(topology, {
      id: 'lead-1',
      label: 'Research Division',
      scope: 'research',
    });
    topology = addSubordinate(topology, 'lead-1', { id: 'sub-1', label: 'Probe', scope: 'probe' });
    topology = addSubordinate(topology, 'lead-1', { id: 'sub-2', label: 'Verify', scope: 'verify' });

    const division = summarizeDivisionLead(topology, 'lead-1', [
      {
        subordinateId: 'sub-1',
        leadId: 'lead-1',
        scope: 'probe',
        status: 'completed',
        summary: 'Found the relevant code path',
        details: 'Deep raw transcript that should only appear when escalated',
      },
      {
        subordinateId: 'sub-2',
        leadId: 'lead-1',
        scope: 'verify',
        status: 'blocked',
        summary: 'Blocked on shared file claim',
        blockers: ['shared file claim needed'],
        details: 'Detailed blocker payload',
        escalated: true,
      },
    ]);

    const chairman = projectChairmanSummary(topology, [division]);
    assert.equal(chairman.divisionCount, 1);
    assert.equal(chairman.totalSubordinates, 2);
    assert.equal(chairman.blockedCount, 1);
    assert.deepEqual(chairman.divisions[0]?.highlights, ['Found the relevant code path']);
    assert.deepEqual(chairman.divisions[0]?.blockers, ['shared file claim needed']);
    assert.equal(chairman.divisions[0]?.escalations.length, 1);
    assert.match(chairman.divisions[0]?.escalations[0]?.details ?? '', /Detailed blocker payload/);
  });
});
