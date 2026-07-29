import { normalizeTeamFileScope } from './coordination-protocol.js';

export interface AllocationTaskInput {
  subject: string;
  description: string;
  role?: string;
  blocked_by?: string[];
  filePaths?: string[];
  domains?: string[];
  inferredDomains?: string[];
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
  scopeHints: Set<string>;
  hardAffinityHints: Set<string>;
}

const FILE_PATH_PATTERN = /(?:^|[\s("'])((?:\.[\\/])?(?:src|scripts|docs|prompts|skills|templates|native|crates)[\\/][A-Za-z0-9._\\/-]+)/g;
const DOMAIN_STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'for', 'with', 'into', 'from', 'then', 'than', 'that', 'this', 'those', 'these',
  'work', 'task', 'tasks', 'implement', 'implementation', 'continue', 'additional', 'update', 'fix', 'lane',
  'runtime', 'tests', 'test', 'worker', 'workers', 'leader', 'team', 'plan', 'approved', 'supporting',
  'needed', 'focus', 'prefer', 'plus', 'related', 'files', 'file', 'code', 'notify',
  'src', 'scripts', 'docs', 'prompts', 'skills', 'templates', 'native', 'crates', 'team', 'index', 'test', 'spec',
]);

function normalizeHint(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized.length >= 3 ? normalized : null;
}

function normalizedPathHint(pathValue: string, source: 'structured' | 'prose'): string {
  const boundaryValue = source === 'prose'
    ? pathValue.replace(/([A-Za-z0-9])\.+$/, '$1')
    : pathValue;
  return normalizeTeamFileScope(boundaryValue);
}

function collectPathHints(pathValue: string, target: Set<string>, source: 'structured' | 'prose'): void {
  const normalizedPath = normalizedPathHint(pathValue, source);
  if (!normalizedPath) return;
  target.add(`path:${normalizedPath}`);

  const basename = normalizedPath.split('/').pop() ?? normalizedPath;
  const basenameStem = basename.replace(/\.[^.]+$/, '');
  const normalizedStem = normalizeHint(basenameStem);
  if (normalizedStem) target.add(`domain:${normalizedStem}`);
}

function collectExactPathHint(pathValue: string, target: Set<string>, source: 'structured' | 'prose'): void {
  const normalizedPath = normalizedPathHint(pathValue, source);
  if (normalizedPath) target.add(`path:${normalizedPath}`);
}

function collectDomainHints(value: string, target: Set<string>): void {
  const words = value.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
  for (const word of words) {
    if (!DOMAIN_STOP_WORDS.has(word)) target.add(`domain:${word}`);
  }
}

function normalizeDeclaredDomainHint(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized || null;
}

function collectDeclaredDomainHints(value: string, target: Set<string>): void {
  const normalized = normalizeDeclaredDomainHint(value);
  if (normalized) target.add(`domain:${normalized}`);
  collectDomainHints(value, target);
}

function collectExactDeclaredDomainHint(value: string, target: Set<string>): void {
  const normalized = normalizeDeclaredDomainHint(value);
  if (normalized) target.add(`declared-domain:${normalized}`);
}

function extractHardAffinityHints(task: AllocationTaskInput): Set<string> {
  const hints = new Set<string>();
  for (const pathValue of task.filePaths ?? []) collectExactPathHint(pathValue, hints, 'structured');
  for (const domain of task.domains ?? []) collectExactDeclaredDomainHint(domain, hints);

  const text = `${task.subject}\n${task.description}`;
  for (const match of text.matchAll(FILE_PATH_PATTERN)) {
    if (match[1]) collectExactPathHint(match[1], hints, 'prose');
  }
  return hints;
}

function extractTaskHints(task: AllocationTaskInput): Set<string> {
  const hints = new Set<string>();
  for (const pathValue of task.filePaths ?? []) collectPathHints(pathValue, hints, 'structured');
  for (const domain of task.domains ?? []) collectDeclaredDomainHints(domain, hints);
  for (const domain of task.inferredDomains ?? []) collectDeclaredDomainHints(domain, hints);

  const text = `${task.subject}\n${task.description}`;
  for (const match of text.matchAll(FILE_PATH_PATTERN)) {
    if (match[1]) collectPathHints(match[1], hints, 'prose');
  }
  collectDomainHints(text, hints);
  return hints;
}

function countHintOverlap(taskHints: Set<string>, workerHints: Set<string>): number {
  let overlap = 0;
  for (const hint of taskHints) {
    if (workerHints.has(hint)) overlap += hint.startsWith('path:') ? 3 : 1;
  }
  return overlap;
}

function scoreWorker(
  task: AllocationTaskInput,
  worker: WorkerAllocationState,
  taskHints: Set<string>,
  uniformRolePool = false,
): number {
  let score = 0;
  const taskRole = task.role?.trim();
  const workerRole = worker.role?.trim();

  if (!uniformRolePool) {
    if (taskRole && worker.primaryRole === taskRole) score += 18;
    if (taskRole && workerRole === taskRole) score += 12;
    if (taskRole && !worker.primaryRole && worker.assignedCount === 0) score += 9;
  }

  const overlap = countHintOverlap(taskHints, worker.scopeHints);
  if (overlap > 0) score += overlap * 4;
  if (taskHints.size > 0 && overlap === 0 && worker.scopeHints.size > 0) score -= 3;

  score -= worker.assignedCount * 4;

  if ((task.blocked_by?.length ?? 0) > 0) {
    score -= worker.assignedCount;
  }

  return score;
}

export function chooseTaskOwner(
  task: AllocationTaskInput,
  workers: AllocationWorkerInput[],
  currentAssignments: Array<{ owner: string; role?: string; subject?: string; description?: string; filePaths?: string[]; domains?: string[]; inferredDomains?: string[] }>,
): AllocationDecision {
  if (workers.length === 0) {
    throw new Error('at least one worker is required for allocation');
  }

  const hardAffinityHints = extractHardAffinityHints(task);
  const taskHints = extractTaskHints(task);
  const workerState = workers.map<WorkerAllocationState>((worker) => {
    const assigned = currentAssignments.filter((item) => item.owner === worker.name);
    const primaryRole = assigned.find((item) => item.role)?.role;
    const scopeHints = new Set<string>();
    const workerHardAffinityHints = new Set<string>();
    for (const item of assigned) {
      const assignedTask = {
        subject: item.subject ?? '',
        description: item.description ?? '',
        role: item.role,
        filePaths: item.filePaths,
        domains: item.domains,
        inferredDomains: item.inferredDomains,
      };
      for (const hint of extractTaskHints(assignedTask)) scopeHints.add(hint);
      for (const hint of extractHardAffinityHints(assignedTask)) workerHardAffinityHints.add(hint);
    }
    return {
      ...worker,
      assignedCount: assigned.length,
      primaryRole,
      scopeHints,
      hardAffinityHints: workerHardAffinityHints,
    };
  });

  const genericWorkerPool = workerState.length > 0
    && workerState.every((worker) => !worker.role?.trim());
  const minimumAssignedCount = Math.min(...workerState.map((worker) => worker.assignedCount));
  let candidates = workerState;
  if (genericWorkerPool) {
    if (hardAffinityHints.size > 0) {
      const affinityCandidates = workerState.filter((worker) => (
        countHintOverlap(hardAffinityHints, worker.hardAffinityHints) > 0
      ));
      candidates = affinityCandidates.length > 0
        ? affinityCandidates
        : workerState.filter((worker) => worker.assignedCount === minimumAssignedCount);
    } else {
      candidates = workerState.filter((worker) => worker.assignedCount === minimumAssignedCount);
    }
  }
  const uniformRolePool = Boolean(task.role?.trim())
    && candidates.length > 0
    && candidates.every((worker) => worker.role?.trim() === task.role?.trim());

  const ranked = candidates
    .map((worker, index) => ({
      worker,
      index,
      score: scoreWorker(task, worker, taskHints, uniformRolePool),
      overlap: countHintOverlap(taskHints, worker.scopeHints),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.overlap !== left.overlap) return right.overlap - left.overlap;
      if (left.worker.assignedCount !== right.worker.assignedCount) {
        return left.worker.assignedCount - right.worker.assignedCount;
      }
      return left.index - right.index;
    });

  const selected = ranked[0]?.worker ?? workerState[0];
  const selectedOverlap = ranked[0]?.overlap ?? 0;
  const reasons: string[] = [];
  if (task.role && selected.primaryRole === task.role) reasons.push(`keeps ${task.role} work grouped`);
  else if (task.role && selected.role === task.role) reasons.push(`matches worker role ${selected.role}`);
  else reasons.push('balances current load');

  if (selectedOverlap > 0) reasons.push('preserves low-overlap file/domain ownership');
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
