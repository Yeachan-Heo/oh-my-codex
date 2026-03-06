import type { EnterpriseMailboxMessage, EnterpriseSubordinateRecord } from './state.js';
import type { EnterpriseDivisionSummary } from './contracts.js';

export function routeMailboxMessagesToLeadSummaries(
  messages: EnterpriseMailboxMessage[],
  subordinateRecords: EnterpriseSubordinateRecord[],
): Map<string, { latestMessages: EnterpriseMailboxMessage[]; collapsedSummary: string[] }> {
  const subordinateById = new Map(subordinateRecords.map((record) => [record.nodeId, record] as const));
  const grouped = new Map<string, { latestMessages: EnterpriseMailboxMessage[]; collapsedSummary: string[] }>();

  for (const message of messages) {
    const subordinate = subordinateById.get(message.fromNodeId) ?? subordinateById.get(message.toNodeId);
    const leadId = subordinate?.leadId;
    if (!leadId) continue;
    const bucket = grouped.get(leadId) ?? { latestMessages: [], collapsedSummary: [] };
    bucket.latestMessages.push(message);
    bucket.collapsedSummary.push(message.body);
    grouped.set(leadId, bucket);
  }

  return grouped;
}

export function collapseDivisionSummary(
  division: EnterpriseDivisionSummary,
  routed: { latestMessages: EnterpriseMailboxMessage[]; collapsedSummary: string[] } | undefined,
): EnterpriseDivisionSummary {
  if (!routed || routed.collapsedSummary.length === 0) return division;
  const latest = routed.collapsedSummary.at(-1) ?? null;
  return {
    ...division,
    highlights: [...division.highlights, ...routed.collapsedSummary],
    escalations: division.escalations,
    blockers: division.blockers,
    scope: division.scope,
    leadId: division.leadId,
    leadLabel: division.leadLabel,
    subordinateCount: division.subordinateCount,
    completedCount: division.completedCount,
    blockedCount: division.blockedCount,
    failedCount: division.failedCount,
    ...(latest ? {} : {}),
  };
}


export function applyMailboxRoutingToDivisionSummaries(
  divisions: EnterpriseDivisionSummary[],
  messages: EnterpriseMailboxMessage[],
  subordinateRecords: EnterpriseSubordinateRecord[],
): EnterpriseDivisionSummary[] {
  const routed = routeMailboxMessagesToLeadSummaries(messages, subordinateRecords);
  return divisions.map((division) => collapseDivisionSummary(division, routed.get(division.leadId)));
}
