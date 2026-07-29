import type { TeamTask, WorkerStatus } from './state/types.js';
import { chooseTaskOwner, type AllocationWorkerInput } from './allocation-policy.js';

export interface RebalanceWorkerInput extends AllocationWorkerInput {
  alive: boolean;
  status: WorkerStatus;
}

export interface RebalanceDecision {
  type: 'assign' | 'recommend';
  taskId?: string;
  workerName?: string;
  reason: string;
}

export interface RebalancePolicyInput {
  tasks: TeamTask[];
  workers: RebalanceWorkerInput[];
  reclaimedTaskIds: string[];
}

function hasCompletedDependencies(task: TeamTask, taskById: Map<string, TeamTask>): boolean {
  const dependencyIds = task.depends_on ?? task.blocked_by ?? [];
  if (dependencyIds.length === 0) return true;
  return dependencyIds.every((id) => taskById.get(id)?.status === 'completed');
}

function isWorkerAvailable(worker: RebalanceWorkerInput): boolean {
  return worker.alive && (worker.status.state === 'idle' || worker.status.state === 'done' || worker.status.state === 'unknown');
}

export function buildRebalanceDecisions(input: RebalancePolicyInput): RebalanceDecision[] {
  const taskById = new Map(input.tasks.map((task) => [task.id, task] as const));
  const liveWorkers = input.workers.filter(isWorkerAvailable);
  if (liveWorkers.length === 0) return [];

  const unownedPendingTasks = input.tasks
    .filter((task) => task.status === 'pending' && !task.owner)
    .filter((task) => hasCompletedDependencies(task, taskById))
    .sort((left, right) => {
      const leftReclaimed = input.reclaimedTaskIds.includes(left.id) ? 0 : 1;
      const rightReclaimed = input.reclaimedTaskIds.includes(right.id) ? 0 : 1;
      if (leftReclaimed !== rightReclaimed) return leftReclaimed - rightReclaimed;
      return Number(left.id) - Number(right.id);
    });

  const inFlightAssignments = input.tasks
    .filter((task) => task.owner && task.status === 'in_progress')
    .map((task) => ({
      owner: task.owner as string,
      role: task.role,
      subject: task.subject,
      description: task.description,
      affinityDescription: task.affinityDescription,
      filePaths: task.filePaths,
      domains: task.domains,
    }));

  const decisions: RebalanceDecision[] = [];
  const claimedTaskIds = new Set<string>();

  for (const task of unownedPendingTasks) {
    if (claimedTaskIds.has(task.id)) continue;
    const decision = chooseTaskOwner(task, liveWorkers, inFlightAssignments);
    decisions.push({
      type: 'assign',
      taskId: task.id,
      workerName: decision.owner,
      reason: input.reclaimedTaskIds.includes(task.id)
        ? `reclaimed work is ready; ${decision.reason}`
        : `idle worker pickup; ${decision.reason}`,
    });
    inFlightAssignments.push({
      owner: decision.owner,
      role: task.role,
      subject: task.subject,
      description: task.description,
      affinityDescription: task.affinityDescription,
      filePaths: task.filePaths,
      domains: task.domains,
    });
    claimedTaskIds.add(task.id);
  }

  return decisions;
}
