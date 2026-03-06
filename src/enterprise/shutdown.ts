import type { EnterpriseShutdownStep, EnterpriseTopology } from './contracts.js';

function sortByDepthDesc(topology: EnterpriseTopology): Array<{ id: string; depth: number }> {
  return Object.values(topology.nodes)
    .map((node) => ({ id: node.id, depth: node.depth }))
    .sort((left, right) => right.depth - left.depth || left.id.localeCompare(right.id));
}

export function buildEnterpriseShutdownPlan(topology: EnterpriseTopology): EnterpriseShutdownStep[] {
  const orderedNodes = sortByDepthDesc(topology);
  const steps: EnterpriseShutdownStep[] = [];
  let order = 0;

  for (const { id } of orderedNodes) {
    const node = topology.nodes[id];
    steps.push({
      nodeId: node.id,
      role: node.role,
      parentId: node.parentId,
      order: order++,
      action: 'request_shutdown',
    });
    steps.push({
      nodeId: node.id,
      role: node.role,
      parentId: node.parentId,
      order: order++,
      action: 'await_ack',
    });
    steps.push({
      nodeId: node.id,
      role: node.role,
      parentId: node.parentId,
      order: order++,
      action: 'cleanup',
    });
  }

  return steps;
}
