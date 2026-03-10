import { join } from 'path';
import { codexPromptsDir, packageRoot } from '../utils/paths.js';
import { listAvailableRoles, routeTaskToRole } from './role-router.js';

export type FollowupMode = 'team' | 'ralph';

export interface FollowupAllocation {
  role: string;
  count: number;
  reason: string;
}

export interface FollowupStaffingPlan {
  mode: FollowupMode;
  availableAgentTypes: string[];
  recommendedHeadcount: number;
  allocations: FollowupAllocation[];
  rosterSummary: string;
  staffingSummary: string;
}

export interface ResolveAvailableAgentTypesOptions {
  promptDirs?: string[];
}

export interface BuildFollowupStaffingPlanOptions {
  workerCount?: number;
  fallbackRole?: string;
}

function defaultPromptDirs(projectRoot: string): string[] {
  return [
    join(projectRoot, 'prompts'),
    join(projectRoot, '.codex', 'prompts'),
    join(packageRoot(), 'prompts'),
    codexPromptsDir(),
  ];
}

export async function resolveAvailableAgentTypes(
  projectRoot: string,
  options: ResolveAvailableAgentTypesOptions = {},
): Promise<string[]> {
  const dirs = options.promptDirs ?? defaultPromptDirs(projectRoot);
  const roles = new Set<string>();

  for (const dir of dirs) {
    const dirRoles = await listAvailableRoles(dir);
    for (const role of dirRoles) roles.add(role);
  }

  return [...roles].sort();
}

function chooseAvailableRole(
  availableRoles: readonly string[],
  preferredRoles: readonly string[],
  fallbackRole: string,
): string {
  for (const role of preferredRoles) {
    if (availableRoles.includes(role)) return role;
  }
  if (availableRoles.includes(fallbackRole)) return fallbackRole;
  return availableRoles[0] ?? fallbackRole;
}

function mergeAllocation(
  allocations: FollowupAllocation[],
  role: string,
  count: number,
  reason: string,
): void {
  if (count <= 0) return;
  const existing = allocations.find((item) => item.role === role && item.reason === reason);
  if (existing) {
    existing.count += count;
    return;
  }
  allocations.push({ role, count, reason });
}

function summarizeAllocations(allocations: readonly FollowupAllocation[]): string {
  return allocations
    .map((allocation) => `${allocation.role} x${allocation.count} (${allocation.reason})`)
    .join('; ');
}

function pickSpecialistRole(
  task: string,
  availableRoles: readonly string[],
  fallbackRole: string,
): string {
  const normalizedTask = task.toLowerCase();

  if (/(security|auth|authorization|authentication|xss|injection|cve|vulnerability)/.test(normalizedTask)) {
    return chooseAvailableRole(availableRoles, ['security-reviewer', 'architect'], fallbackRole);
  }
  if (/(debug|regression|root cause|stack trace|incident|flaky)/.test(normalizedTask)) {
    return chooseAvailableRole(availableRoles, ['debugger', 'architect'], fallbackRole);
  }
  if (/(build|compile|tsc|type error|lint)/.test(normalizedTask)) {
    return chooseAvailableRole(availableRoles, ['build-fixer', 'debugger'], fallbackRole);
  }
  if (/(ui|ux|layout|css|responsive|design|frontend)/.test(normalizedTask)) {
    return chooseAvailableRole(availableRoles, ['designer'], fallbackRole);
  }
  if (/(readme|docs|documentation|changelog|migration)/.test(normalizedTask)) {
    return chooseAvailableRole(availableRoles, ['writer'], fallbackRole);
  }

  return chooseAvailableRole(availableRoles, ['architect', 'researcher'], fallbackRole);
}

export function buildFollowupStaffingPlan(
  mode: FollowupMode,
  task: string,
  availableAgentTypes: readonly string[],
  options: BuildFollowupStaffingPlanOptions = {},
): FollowupStaffingPlan {
  const fallbackRole = options.fallbackRole ?? 'executor';
  const workerCount = Math.max(1, options.workerCount ?? (mode === 'team' ? 2 : 3));
  const primaryRoute = routeTaskToRole(
    task,
    task,
    mode === 'team' ? 'team-exec' : 'team-verify',
    fallbackRole,
  );
  const primaryRole = chooseAvailableRole(availableAgentTypes, [primaryRoute.role], fallbackRole);
  const qualityRole = chooseAvailableRole(
    availableAgentTypes,
    ['test-engineer', 'verifier', 'quality-reviewer'],
    primaryRole,
  );
  const allocations: FollowupAllocation[] = [];

  mergeAllocation(allocations, primaryRole, 1, mode === 'team' ? 'primary delivery lane' : 'primary implementation lane');

  if (mode === 'team') {
    if (workerCount >= 2) {
      mergeAllocation(allocations, qualityRole, 1, 'verification + regression lane');
    }
    if (workerCount >= 3) {
      const specialistRole = pickSpecialistRole(task, availableAgentTypes, primaryRole);
      mergeAllocation(allocations, specialistRole, 1, 'specialist support lane');
    }
    if (workerCount >= 4) {
      mergeAllocation(allocations, primaryRole, workerCount - 3, 'extra implementation capacity');
    }
  } else {
    mergeAllocation(allocations, qualityRole, 1, 'evidence + regression checks');
    const architectRole = chooseAvailableRole(
      availableAgentTypes,
      ['architect', 'critic', 'verifier'],
      qualityRole,
    );
    mergeAllocation(allocations, architectRole, 1, 'final architecture / completion sign-off');

    if (workerCount >= 4) {
      const specialistRole = pickSpecialistRole(task, availableAgentTypes, primaryRole);
      mergeAllocation(allocations, specialistRole, workerCount - 3, 'parallel specialist follow-up capacity');
    }
  }

  return {
    mode,
    availableAgentTypes: [...availableAgentTypes],
    recommendedHeadcount: workerCount,
    allocations,
    rosterSummary: availableAgentTypes.join(', '),
    staffingSummary: summarizeAllocations(allocations),
  };
}
