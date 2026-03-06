import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnterpriseShutdownPlan } from '../shutdown.js';
import { addDivisionLead, addSubordinate, createEnterpriseTopology } from '../topology.js';

describe('enterprise shutdown planning', () => {
  it('creates child-first shutdown order with request -> ack -> cleanup per node', () => {
    let topology = createEnterpriseTopology({ task: 'shutdown' });
    topology = addDivisionLead(topology, { id: 'lead-1', label: 'Lead', scope: 'scope' });
    topology = addSubordinate(topology, 'lead-1', { id: 'sub-1', label: 'Sub', scope: 'scope' });

    const plan = buildEnterpriseShutdownPlan(topology);
    assert.deepEqual(
      plan.map((step) => [step.nodeId, step.action]),
      [
        ['sub-1', 'request_shutdown'],
        ['sub-1', 'await_ack'],
        ['sub-1', 'cleanup'],
        ['lead-1', 'request_shutdown'],
        ['lead-1', 'await_ack'],
        ['lead-1', 'cleanup'],
        ['chairman-1', 'request_shutdown'],
        ['chairman-1', 'await_ack'],
        ['chairman-1', 'cleanup'],
      ],
    );
  });
});
