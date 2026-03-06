import type {
  EnterpriseChairmanSummary,
  EnterpriseDivisionSummary,
  EnterpriseExecutionUpdate,
  EnterpriseMonitorDivisionSnapshot,
  EnterpriseMonitorSnapshot,
  EnterpriseSubordinateReport,
  EnterpriseTopology,
} from './contracts.js';

function asSubordinateReports(topology: EnterpriseTopology, updates: EnterpriseExecutionUpdate[]): EnterpriseSubordinateReport[] {
  const reports: EnterpriseSubordinateReport[] = [];
  for (const update of updates) {
    const node = topology.nodes[update.nodeId];
    if (!node || node.role !== 'subordinate' || !node.parentId) continue;
    if (update.status === 'pending' || update.status === 'working') continue;
    reports.push({
      subordinateId: node.id,
      leadId: node.parentId,
      scope: node.scope,
      status: update.status,
      summary: update.summary,
      details: update.details,
      blockers: update.blockers,
      filesTouched: update.filesTouched,
      escalated: update.escalated,
    });
  }
  return reports;
}

export function summarizeDivisionLead(
  topology: EnterpriseTopology,
  leadId: string,
  reports: EnterpriseSubordinateReport[],
): EnterpriseDivisionSummary {
  const lead = topology.nodes[leadId];
  if (!lead || lead.role !== 'division_lead') {
    throw new Error('enterprise_lead_not_found');
  }

  const knownSubordinateCount = lead.childIds.filter((childId) => topology.nodes[childId]?.role === 'subordinate').length;

  const highlights = reports
    .filter((report) => report.status === 'completed')
    .map((report) => report.summary);
  const blockers = reports.flatMap((report) => report.blockers ?? []);
  const escalations = reports
    .filter((report) => report.escalated === true && report.details)
    .map((report) => ({
      subordinateId: report.subordinateId,
      summary: report.summary,
      details: report.details,
    }));

  return {
    leadId,
    leadLabel: lead.label,
    scope: lead.scope,
    subordinateCount: knownSubordinateCount,
    completedCount: reports.filter((report) => report.status === 'completed').length,
    blockedCount: reports.filter((report) => report.status === 'blocked').length,
    failedCount: reports.filter((report) => report.status === 'failed').length,
    highlights,
    blockers,
    escalations,
  };
}

export function projectChairmanSummary(
  topology: EnterpriseTopology,
  divisionSummaries: EnterpriseDivisionSummary[],
): EnterpriseChairmanSummary {
  const chairman = topology.nodes[topology.rootId];
  if (!chairman || chairman.role !== 'chairman') {
    throw new Error('enterprise_chairman_not_found');
  }

  return {
    chairmanId: chairman.id,
    divisionCount: divisionSummaries.length,
    totalSubordinates: divisionSummaries.reduce((sum, summary) => sum + summary.subordinateCount, 0),
    completedCount: divisionSummaries.reduce((sum, summary) => sum + summary.completedCount, 0),
    blockedCount: divisionSummaries.reduce((sum, summary) => sum + summary.blockedCount, 0),
    failedCount: divisionSummaries.reduce((sum, summary) => sum + summary.failedCount, 0),
    divisions: divisionSummaries.map((summary) => ({
      ...summary,
      escalations: summary.escalations.map((entry: { subordinateId: string; summary: string; details?: string }) => ({
        subordinateId: entry.subordinateId,
        summary: entry.summary,
        details: entry.details,
      })),
    })),
  };
}

function computeDivisionState(snapshot: EnterpriseMonitorDivisionSnapshot): EnterpriseMonitorDivisionSnapshot['state'] {
  if (snapshot.failedCount > 0) return 'failed';
  if (snapshot.blockedCount > 0) return 'blocked';
  if (snapshot.subordinateCount > 0 && snapshot.completedCount === snapshot.subordinateCount) return 'completed';
  return snapshot.subordinateCount > 0 ? 'working' : 'pending';
}

export function buildEnterpriseMonitorSnapshot(
  topology: EnterpriseTopology,
  updates: EnterpriseExecutionUpdate[],
): EnterpriseMonitorSnapshot {
  const subordinateReports = asSubordinateReports(topology, updates);
  const updateByNodeId = new Map(updates.map((update) => [update.nodeId, update] as const));

  const divisions: EnterpriseMonitorDivisionSnapshot[] = Object.values(topology.nodes)
    .filter((node) => node.role === 'division_lead')
    .map((lead) => {
      const childIds = lead.childIds.filter((childId) => topology.nodes[childId]?.role === 'subordinate');
      const subordinateStates = Object.fromEntries(
        childIds.map((childId) => [childId, updateByNodeId.get(childId)?.status ?? 'pending']),
      ) as Record<string, EnterpriseMonitorDivisionSnapshot['state']>;
      const reports = subordinateReports.filter((report) => report.leadId === lead.id);
      const latestSummary = reports.length > 0 ? reports[reports.length - 1]?.summary ?? null : null;
      const snapshot: EnterpriseMonitorDivisionSnapshot = {
        leadId: lead.id,
        leadLabel: lead.label,
        scope: lead.scope,
        state: 'pending',
        subordinateCount: childIds.length,
        blockedCount: Object.values(subordinateStates).filter((status) => status === 'blocked').length,
        failedCount: Object.values(subordinateStates).filter((status) => status === 'failed').length,
        completedCount: Object.values(subordinateStates).filter((status) => status === 'completed').length,
        latestSummary,
        subordinateStates,
      };
      snapshot.state = computeDivisionState(snapshot);
      return snapshot;
    });

  const chairmanSummary = projectChairmanSummary(
    topology,
    divisions.map((division) => summarizeDivisionLead(topology, division.leadId, subordinateReports.filter((report) => report.leadId === division.leadId))),
  );

  return {
    chairmanId: topology.rootId,
    chairmanState: chairmanSummary.failedCount > 0
      ? 'failed'
      : chairmanSummary.blockedCount > 0
        ? 'blocked'
        : chairmanSummary.totalSubordinates > 0 && chairmanSummary.completedCount === chairmanSummary.totalSubordinates
          ? 'completed'
          : 'working',
    divisionCount: divisions.length,
    subordinateCount: chairmanSummary.totalSubordinates,
    blockedDivisionIds: divisions.filter((division) => division.state === 'blocked').map((division) => division.leadId),
    failedDivisionIds: divisions.filter((division) => division.state === 'failed').map((division) => division.leadId),
    divisions,
    updatedAt: new Date().toISOString(),
  };
}
