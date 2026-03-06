export const ENTERPRISE_NODE_ID_SAFE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type EnterpriseNodeRole = 'chairman' | 'division_lead' | 'subordinate';
export type EnterpriseNodeState = 'pending' | 'working' | 'blocked' | 'completed' | 'failed' | 'draining';
export type EnterpriseVisibilityMode = 'summary_only' | 'debug';
export type EnterpriseSubordinateWriteMode = 'read_only' | 'lead_controlled_apply';
export type EnterpriseExecutionStatus = 'pending' | 'working' | 'blocked' | 'completed' | 'failed';

export interface EnterpriseHierarchyLimits {
  maxDepth: number;
  maxDivisionLeads: number;
  maxSubordinatesPerLead: number;
  maxSubordinatesTotal: number;
}

export interface EnterpriseNode {
  id: string;
  role: EnterpriseNodeRole;
  label: string;
  parentId: string | null;
  ownerId: string;
  scope: string;
  depth: number;
  childIds: string[];
  state: EnterpriseNodeState;
}

export interface EnterpriseTopology {
  rootId: string;
  nodes: Record<string, EnterpriseNode>;
  limits: EnterpriseHierarchyLimits;
}

export interface EnterprisePolicy {
  max_depth: number;
  max_division_leads: number;
  max_subordinates_per_lead: number;
  max_subordinates_total: number;
  chairman_visibility: EnterpriseVisibilityMode;
  subordinate_write_mode: EnterpriseSubordinateWriteMode;
  raw_transcript_visibility: 'suppressed' | 'debug_only';
}

export interface EnterpriseSubordinateReport {
  subordinateId: string;
  leadId: string;
  scope: string;
  status: 'completed' | 'blocked' | 'failed';
  summary: string;
  details?: string;
  blockers?: string[];
  filesTouched?: string[];
  escalated?: boolean;
}

export interface EnterpriseDivisionSummary {
  leadId: string;
  leadLabel: string;
  scope: string;
  subordinateCount: number;
  completedCount: number;
  blockedCount: number;
  failedCount: number;
  highlights: string[];
  blockers: string[];
  escalations: Array<Pick<EnterpriseSubordinateReport, 'subordinateId' | 'details' | 'summary'>>;
}

export interface EnterpriseChairmanSummary {
  chairmanId: string;
  divisionCount: number;
  totalSubordinates: number;
  completedCount: number;
  blockedCount: number;
  failedCount: number;
  divisions: EnterpriseDivisionSummary[];
}

export interface EnterpriseExecutionUpdate {
  nodeId: string;
  status: EnterpriseExecutionStatus;
  summary: string;
  details?: string;
  blockers?: string[];
  filesTouched?: string[];
  escalated?: boolean;
}

export interface EnterpriseMonitorDivisionSnapshot {
  leadId: string;
  leadLabel: string;
  scope: string;
  state: EnterpriseExecutionStatus;
  subordinateCount: number;
  blockedCount: number;
  failedCount: number;
  completedCount: number;
  latestSummary: string | null;
  subordinateStates: Record<string, EnterpriseExecutionStatus>;
}

export interface EnterpriseMonitorSnapshot {
  chairmanId: string;
  chairmanState: EnterpriseExecutionStatus;
  divisionCount: number;
  subordinateCount: number;
  blockedDivisionIds: string[];
  failedDivisionIds: string[];
  divisions: EnterpriseMonitorDivisionSnapshot[];
  updatedAt: string;
}

export interface EnterpriseShutdownStep {
  nodeId: string;
  role: EnterpriseNodeRole;
  parentId: string | null;
  order: number;
  action: 'request_shutdown' | 'await_ack' | 'cleanup';
}

export function isEnterpriseNodeRole(value: string): value is EnterpriseNodeRole {
  return value === 'chairman' || value === 'division_lead' || value === 'subordinate';
}

export function assertEnterpriseNodeId(id: string): void {
  if (!ENTERPRISE_NODE_ID_SAFE_PATTERN.test(id)) {
    throw new Error(`Invalid enterprise node ID: "${id}". Must match ${ENTERPRISE_NODE_ID_SAFE_PATTERN}.`);
  }
}

export function isValidEnterpriseChildRole(
  parentRole: EnterpriseNodeRole,
  childRole: EnterpriseNodeRole,
): boolean {
  if (parentRole === 'chairman') return childRole === 'division_lead';
  if (parentRole === 'division_lead') return childRole === 'subordinate';
  return false;
}

export function maxDepthForRole(role: EnterpriseNodeRole): number {
  switch (role) {
    case 'chairman':
      return 0;
    case 'division_lead':
      return 1;
    case 'subordinate':
      return 2;
    default: {
      const exhaustive: never = role;
      throw new Error(`Unknown enterprise role: ${exhaustive}`);
    }
  }
}
