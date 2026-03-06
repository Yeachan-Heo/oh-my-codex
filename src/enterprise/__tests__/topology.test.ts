import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addDivisionLead, addSubordinate, createEnterpriseTopology } from '../topology.js';

describe('enterprise topology', () => {
  it('creates a chairman-rooted topology and adds valid children', () => {
    const topology = createEnterpriseTopology({ task: 'ship enterprise mode' });
    const withLead = addDivisionLead(topology, {
      id: 'lead-1',
      label: 'Execution Division',
      scope: 'execution',
    });
    const withSubordinate = addSubordinate(withLead, 'lead-1', {
      id: 'sub-1',
      label: 'Verifier',
      scope: 'verify execution scope',
    });

    assert.equal(withSubordinate.nodes['chairman-1']?.role, 'chairman');
    assert.equal(withSubordinate.nodes['lead-1']?.parentId, 'chairman-1');
    assert.equal(withSubordinate.nodes['sub-1']?.parentId, 'lead-1');
    assert.equal(withSubordinate.nodes['sub-1']?.ownerId, 'lead-1');
  });

  it('enforces per-lead subordinate limits', () => {
    let topology = createEnterpriseTopology({
      task: 'bounded hierarchy',
      policy: { max_subordinates_per_lead: 1 },
    });
    topology = addDivisionLead(topology, { id: 'lead-1', label: 'Lead', scope: 'scope' });
    topology = addSubordinate(topology, 'lead-1', { id: 'sub-1', label: 'Sub 1', scope: 'scope' });

    assert.throws(
      () => addSubordinate(topology, 'lead-1', { id: 'sub-2', label: 'Sub 2', scope: 'scope' }),
      /enterprise_subordinate_per_lead_limit_exceeded/,
    );
  });

  it('enforces total subordinate limits', () => {
    let topology = createEnterpriseTopology({
      task: 'bounded hierarchy',
      policy: { max_division_leads: 2, max_subordinates_per_lead: 2, max_subordinates_total: 1 },
    });
    topology = addDivisionLead(topology, { id: 'lead-1', label: 'Lead', scope: 'scope' });
    topology = addSubordinate(topology, 'lead-1', { id: 'sub-1', label: 'Sub 1', scope: 'scope' });

    assert.throws(
      () => addSubordinate(topology, 'lead-1', { id: 'sub-2', label: 'Sub 2', scope: 'scope' }),
      /enterprise_subordinate_total_limit_exceeded/,
    );
  });
});
