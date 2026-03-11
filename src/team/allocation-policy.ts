export interface AllocationTaskInput {
  subject: string;
  description: string;
  role?: string;
  blocked_by?: string[];
}

export interface AllocationWorkerInput {
  name: string;
  role?: string;
}

export interface AllocationDecision {
  owner: string;
  reason: string;
}

interface WorkerAllocationState extends AllocationWorkerInput {
  assignedCount: number;
  primaryRole?: string;
}

function scoreWorker(task: AllocationTaskInput, worker: WorkerAllocationState, uniformRolePool = false): number {
  let score = 0;
  const taskRole = task.role?.trim();
  const workerRole = worker.role?.trim();

  if (!uniformRolePool) {
    if (taskRole && worker.primaryRole === taskRole) score += 18;
    if (taskRole && workerRole === taskRole) score += 12;
    if (taskRole && !worker.primaryRole && worker.assignedCount === 0) score += 9;
  }

  score -= worker.assignedCount * 4;

  if ((task.blocked_by?.length ?? 0) > 0) {
    score -= worker.assignedCount;
  }

  return score;
}

export function chooseTaskOwner(
  task: AllocationTaskInput,
  workers: AllocationWorkerInput[],
  currentAssignments: Array<{ owner: string; role?: string }>,
): AllocationDecision {
  if (workers.length === 0) {
    throw new Error('at least one worker is required for allocation');
  }

  const workerState = workers.map<WorkerAllocationState>((worker) => {
    const assigned = currentAssignments.filter((item) => item.owner === worker.name);
    const primaryRole = assigned.find((item) => item.role)?.role;
    return {
      ...worker,
      assignedCount: assigned.length,
      primaryRole,
    };
  });

  const uniformRolePool = Boolean(task.role?.trim())
    && workerState.length > 0
    && workerState.every((worker) => worker.role?.trim() === task.role?.trim());

  const ranked = workerState
    .map((worker, index) => ({
      worker,
      index,
      score: scoreWorker(task, worker, uniformRolePool),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.worker.assignedCount !== right.worker.assignedCount) {
        return left.worker.assignedCount - right.worker.assignedCount;
      }
      return left.index - right.index;
    });

  const selected = ranked[0]?.worker ?? workerState[0];
  const reasons: string[] = [];
  if (task.role && selected.primaryRole === task.role) reasons.push(`keeps ${task.role} work grouped`);
  else if (task.role && selected.role === task.role) reasons.push(`matches worker role ${selected.role}`);
  else reasons.push('balances current load');

  if ((task.blocked_by?.length ?? 0) > 0) reasons.push('keeps blocked work on a lighter lane');

  return {
    owner: selected.name,
    reason: reasons.join('; '),
  };
}

export function allocateTasksToWorkers<T extends AllocationTaskInput>(
  tasks: T[],
  workers: AllocationWorkerInput[],
): Array<T & { owner: string; allocation_reason: string }> {
  const assignments: Array<T & { owner: string; allocation_reason: string }> = [];
  for (const task of tasks) {
    const decision = chooseTaskOwner(task, workers, assignments);
    assignments.push({
      ...task,
      owner: decision.owner,
      allocation_reason: decision.reason,
    });
  }
  return assignments;
}
