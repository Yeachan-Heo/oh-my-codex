import {
  maxDepthForRole,
  isValidEnterpriseChildRole,
  type EnterpriseNode,
  type EnterpriseNodeRole,
  type EnterpriseTopology,
} from './contracts.js';
import { normalizeEnterprisePolicy } from './policy.js';

export interface CreateEnterpriseTopologyInput {
  chairmanId?: string;
  chairmanLabel?: string;
  task: string;
  policy?: Parameters<typeof normalizeEnterprisePolicy>[0];
}

export interface AddEnterpriseNodeInput {
  id: string;
  label: string;
  scope: string;
}

function cloneTopology(topology: EnterpriseTopology): EnterpriseTopology {
  return {
    ...topology,
    nodes: Object.fromEntries(
      Object.entries(topology.nodes).map(([id, node]) => [id, { ...node, childIds: [...node.childIds] }]),
    ),
  };
}

export function createEnterpriseTopology(input: CreateEnterpriseTopologyInput): EnterpriseTopology {
  const policy = normalizeEnterprisePolicy(input.policy);
  const chairmanId = input.chairmanId ?? 'chairman-1';
  const chairman: EnterpriseNode = {
    id: chairmanId,
    role: 'chairman',
    label: input.chairmanLabel ?? 'Chairman',
    parentId: null,
    ownerId: chairmanId,
    scope: input.task,
    depth: 0,
    childIds: [],
    state: 'pending',
  };

  return {
    rootId: chairmanId,
    limits: {
      maxDepth: policy.max_depth,
      maxDivisionLeads: policy.max_division_leads,
      maxSubordinatesPerLead: policy.max_subordinates_per_lead,
      maxSubordinatesTotal: policy.max_subordinates_total,
    },
    nodes: {
      [chairmanId]: chairman,
    },
  };
}

export function countNodesByRole(topology: EnterpriseTopology, role: EnterpriseNodeRole): number {
  return Object.values(topology.nodes).filter((node) => node.role === role).length;
}

export function countSubordinatesForLead(topology: EnterpriseTopology, leadId: string): number {
  const lead = topology.nodes[leadId];
  if (!lead || lead.role !== 'division_lead') return 0;
  return lead.childIds.filter((childId: string) => topology.nodes[childId]?.role === 'subordinate').length;
}

export function addDivisionLead(
  topology: EnterpriseTopology,
  input: AddEnterpriseNodeInput,
): EnterpriseTopology {
  const next = cloneTopology(topology);
  const chairman = next.nodes[next.rootId];
  if (!chairman || chairman.role !== 'chairman') {
    throw new Error('enterprise_topology_invalid_root');
  }
  if (countNodesByRole(next, 'division_lead') >= next.limits.maxDivisionLeads) {
    throw new Error('enterprise_division_lead_limit_exceeded');
  }

  const node: EnterpriseNode = {
    id: input.id,
    role: 'division_lead',
    label: input.label,
    parentId: chairman.id,
    ownerId: input.id,
    scope: input.scope,
    depth: 1,
    childIds: [],
    state: 'pending',
  };

  next.nodes[input.id] = node;
  chairman.childIds.push(input.id);
  return next;
}

export function addSubordinate(
  topology: EnterpriseTopology,
  leadId: string,
  input: AddEnterpriseNodeInput,
): EnterpriseTopology {
  const next = cloneTopology(topology);
  const lead = next.nodes[leadId];
  if (!lead) throw new Error('enterprise_parent_not_found');
  if (!isValidEnterpriseChildRole(lead.role, 'subordinate')) {
    throw new Error('enterprise_invalid_parent_child');
  }
  if (lead.depth + 1 > next.limits.maxDepth || maxDepthForRole('subordinate') > next.limits.maxDepth) {
    throw new Error('enterprise_depth_limit_exceeded');
  }
  if (countSubordinatesForLead(next, leadId) >= next.limits.maxSubordinatesPerLead) {
    throw new Error('enterprise_subordinate_per_lead_limit_exceeded');
  }
  if (countNodesByRole(next, 'subordinate') >= next.limits.maxSubordinatesTotal) {
    throw new Error('enterprise_subordinate_total_limit_exceeded');
  }

  const subordinate: EnterpriseNode = {
    id: input.id,
    role: 'subordinate',
    label: input.label,
    parentId: lead.id,
    ownerId: lead.id,
    scope: input.scope,
    depth: lead.depth + 1,
    childIds: [],
    state: 'pending',
  };

  next.nodes[input.id] = subordinate;
  lead.childIds.push(input.id);
  return next;
}
