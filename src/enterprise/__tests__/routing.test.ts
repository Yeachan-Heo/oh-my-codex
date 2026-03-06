import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyMailboxRoutingToDivisionSummaries, routeMailboxMessagesToLeadSummaries } from '../routing.js';
import type { EnterpriseDivisionSummary } from '../contracts.js';
import type { EnterpriseMailboxMessage, EnterpriseSubordinateRecord } from '../state.js';

function sampleDivision(): EnterpriseDivisionSummary {
  return {
    leadId: 'division-1',
    leadLabel: 'Division 1',
    scope: 'scope-a',
    subordinateCount: 2,
    completedCount: 0,
    blockedCount: 0,
    failedCount: 0,
    highlights: [],
    blockers: [],
    escalations: [],
  };
}

describe('enterprise routing', () => {
  it('groups subordinate mailbox messages by owning lead', () => {
    const messages: EnterpriseMailboxMessage[] = [
      {
        messageId: 'm1',
        fromNodeId: 'sub-1',
        toNodeId: 'division-1',
        body: 'verification complete',
        createdAt: '2026-03-06T00:00:00.000Z',
      },
      {
        messageId: 'm2',
        fromNodeId: 'sub-2',
        toNodeId: 'division-1',
        body: 'blocked on shared file',
        createdAt: '2026-03-06T00:01:00.000Z',
      },
    ];
    const subordinateRecords: EnterpriseSubordinateRecord[] = [
      {
        nodeId: 'sub-1',
        leadId: 'division-1',
        scope: 'scope-a',
        status: 'completed',
        summary: 'verification complete',
        updatedAt: '2026-03-06T00:00:00.000Z',
      },
      {
        nodeId: 'sub-2',
        leadId: 'division-1',
        scope: 'scope-b',
        status: 'blocked',
        summary: 'blocked on shared file',
        updatedAt: '2026-03-06T00:01:00.000Z',
      },
    ];

    const grouped = routeMailboxMessagesToLeadSummaries(messages, subordinateRecords);
    const division = grouped.get('division-1');

    assert.ok(division);
    assert.equal(division?.latestMessages.length, 2);
    assert.deepEqual(division?.collapsedSummary, ['verification complete', 'blocked on shared file']);
  });

  it('applies collapsed mailbox summaries onto division highlights', () => {
    const division = sampleDivision();
    const next = applyMailboxRoutingToDivisionSummaries(
      [division],
      [
        {
          messageId: 'm1',
          fromNodeId: 'sub-1',
          toNodeId: 'division-1',
          body: 'verification complete',
          createdAt: '2026-03-06T00:00:00.000Z',
        },
      ],
      [
        {
          nodeId: 'sub-1',
          leadId: 'division-1',
          scope: 'scope-a',
          status: 'completed',
          summary: 'verification complete',
          updatedAt: '2026-03-06T00:00:00.000Z',
        },
      ],
    );

    assert.equal(next.length, 1);
    assert.deepEqual(next[0]?.highlights, ['verification complete']);
    assert.equal(next[0]?.leadId, 'division-1');
  });
});
