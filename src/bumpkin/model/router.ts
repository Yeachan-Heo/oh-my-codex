export type ModelRole =
  | 'upgrade-planner'
  | 'breakage-fixer-mechanical'
  | 'breakage-fixer-reasoning'
  | 'llm-reviewer'
  | 'test-validator'
  | 'release-notes-reader';

export type ModelTier = 'oss' | 'frontier';

export interface RouteDecision {
  providerId: string;
  tier: ModelTier;
  reason: string;
}

export interface RouteInput {
  role: ModelRole;
  failureCount?: number;
  repoSafetyCritical?: boolean;
}

export interface RouterConfig {
  oss: { providerId: string };
  frontier: { providerId: string };
  escalateMechanicalAfter?: number;
}

const DEFAULT_ESCALATE_AFTER = 2;

export function routeModel(input: RouteInput, cfg: RouterConfig): RouteDecision {
  const failureCount = input.failureCount ?? 0;
  const escalateAfter = cfg.escalateMechanicalAfter ?? DEFAULT_ESCALATE_AFTER;

  if (input.repoSafetyCritical) {
    return {
      providerId: cfg.frontier.providerId,
      tier: 'frontier',
      reason: 'safety-critical repo — always frontier',
    };
  }

  switch (input.role) {
    case 'upgrade-planner':
      return { providerId: cfg.frontier.providerId, tier: 'frontier', reason: 'planner needs reasoning' };
    case 'llm-reviewer':
      return { providerId: cfg.frontier.providerId, tier: 'frontier', reason: 'reviewer is always frontier' };
    case 'breakage-fixer-reasoning':
      return { providerId: cfg.frontier.providerId, tier: 'frontier', reason: 'reasoning fixer is frontier' };
    case 'breakage-fixer-mechanical':
      if (failureCount >= escalateAfter) {
        return {
          providerId: cfg.frontier.providerId,
          tier: 'frontier',
          reason: `mechanical fixer escalated after ${failureCount} failures`,
        };
      }
      return {
        providerId: cfg.oss.providerId,
        tier: 'oss',
        reason: 'mechanical fixer uses OSS model',
      };
    case 'test-validator':
      return { providerId: cfg.oss.providerId, tier: 'oss', reason: 'test interpretation uses OSS model' };
    case 'release-notes-reader':
      return { providerId: cfg.oss.providerId, tier: 'oss', reason: 'release-notes reading uses OSS model' };
  }
}

export function summarizeSpend(
  entries: ReadonlyArray<{ tier: ModelTier; tokens: number }>,
): { ossTokens: number; frontierTokens: number; ossShare: number } {
  let oss = 0;
  let frontier = 0;
  for (const e of entries) {
    if (e.tier === 'oss') oss += e.tokens;
    else frontier += e.tokens;
  }
  const total = oss + frontier;
  return {
    ossTokens: oss,
    frontierTokens: frontier,
    ossShare: total === 0 ? 0 : oss / total,
  };
}
