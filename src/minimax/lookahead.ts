export const MINIMAX_LOOKAHEAD_POLICY_VERSION = 1;

export type MinimaxRiskLevel = 'low' | 'medium' | 'high';

export interface MinimaxLookaheadPolicy {
  schema_version: 'minimax-lookahead-policy-v1';
  depth: 1 | 2;
  branch_factor_by_risk: Record<MinimaxRiskLevel, 1 | 2 | 3>;
  max_branches: 3;
  scoring: {
    value_weight: 1;
    evidence_weight: 1;
    reversibility_bonus: 2;
    risk_weight: 1;
    scope_expansion_weight: 1;
  };
  progressive_widening: {
    add_branch_when_min_rejects: true;
    add_branch_when_risk_high: true;
    add_branch_when_verification_weak: true;
    add_branch_when_public_contract_changes: true;
  };
}

export interface MinimaxLookaheadBranch {
  id: string;
  max_action: string;
  next_state: string;
  value: number;
  risk: number;
  evidence_strength: number;
  reversible: boolean;
  scope_expansion: number;
  expected_evidence: string[];
  min_risk?: string;
}

export interface ScoredMinimaxLookaheadBranch extends MinimaxLookaheadBranch {
  score: number;
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeBranchFactor(value: unknown, fallback: 1 | 2 | 3): 1 | 2 | 3 {
  const clamped = clampInteger(value, fallback, 1, 3);
  return (clamped === 1 || clamped === 2 || clamped === 3) ? clamped : fallback;
}

export function buildDefaultMinimaxLookaheadPolicy(): MinimaxLookaheadPolicy {
  return {
    schema_version: 'minimax-lookahead-policy-v1',
    depth: 2,
    branch_factor_by_risk: {
      low: 1,
      medium: 2,
      high: 3,
    },
    max_branches: 3,
    scoring: {
      value_weight: 1,
      evidence_weight: 1,
      reversibility_bonus: 2,
      risk_weight: 1,
      scope_expansion_weight: 1,
    },
    progressive_widening: {
      add_branch_when_min_rejects: true,
      add_branch_when_risk_high: true,
      add_branch_when_verification_weak: true,
      add_branch_when_public_contract_changes: true,
    },
  };
}

export function normalizeMinimaxLookaheadPolicy(rawPolicy: unknown): MinimaxLookaheadPolicy {
  const defaults = buildDefaultMinimaxLookaheadPolicy();
  const raw = safeRecord(rawPolicy);
  const rawBranchFactors = safeRecord(raw.branch_factor_by_risk);

  return {
    ...defaults,
    depth: clampInteger(raw.depth, defaults.depth, 1, 2) as 1 | 2,
    branch_factor_by_risk: {
      low: normalizeBranchFactor(rawBranchFactors.low, defaults.branch_factor_by_risk.low),
      medium: normalizeBranchFactor(rawBranchFactors.medium, defaults.branch_factor_by_risk.medium),
      high: normalizeBranchFactor(rawBranchFactors.high, defaults.branch_factor_by_risk.high),
    },
    max_branches: 3,
    scoring: defaults.scoring,
    progressive_widening: defaults.progressive_widening,
  };
}

export function minimaxBranchFactorForRisk(
  risk: MinimaxRiskLevel,
  policy: unknown = buildDefaultMinimaxLookaheadPolicy(),
): 1 | 2 | 3 {
  return normalizeMinimaxLookaheadPolicy(policy).branch_factor_by_risk[risk];
}

function scoreMetric(value: number): number {
  return Math.min(10, Math.max(0, Number.isFinite(value) ? value : 0));
}

export function scoreMinimaxLookaheadBranch(
  branch: MinimaxLookaheadBranch,
  policy: unknown = buildDefaultMinimaxLookaheadPolicy(),
): number {
  const normalizedPolicy = normalizeMinimaxLookaheadPolicy(policy);
  const score = (scoreMetric(branch.value) * normalizedPolicy.scoring.value_weight)
    + (scoreMetric(branch.evidence_strength) * normalizedPolicy.scoring.evidence_weight)
    + (branch.reversible ? normalizedPolicy.scoring.reversibility_bonus : 0)
    - (scoreMetric(branch.risk) * normalizedPolicy.scoring.risk_weight)
    - (scoreMetric(branch.scope_expansion) * normalizedPolicy.scoring.scope_expansion_weight);
  return Math.round(score * 100) / 100;
}

export function rankMinimaxLookaheadBranches(
  branches: MinimaxLookaheadBranch[],
  policy: unknown = buildDefaultMinimaxLookaheadPolicy(),
): ScoredMinimaxLookaheadBranch[] {
  const normalizedPolicy = normalizeMinimaxLookaheadPolicy(policy);
  return branches
    .map((branch) => ({
      ...branch,
      score: scoreMinimaxLookaheadBranch(branch, normalizedPolicy),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const leftRisk = scoreMetric(left.risk);
      const rightRisk = scoreMetric(right.risk);
      if (leftRisk !== rightRisk) return leftRisk - rightRisk;
      return left.id.localeCompare(right.id);
    });
}

export function selectMinimaxLookaheadBranchesForRisk(
  branches: MinimaxLookaheadBranch[],
  risk: MinimaxRiskLevel,
  policy: unknown = buildDefaultMinimaxLookaheadPolicy(),
): ScoredMinimaxLookaheadBranch[] {
  const normalizedPolicy = normalizeMinimaxLookaheadPolicy(policy);
  const branchLimit = Math.min(normalizedPolicy.max_branches, minimaxBranchFactorForRisk(risk, normalizedPolicy));
  return rankMinimaxLookaheadBranches(branches, normalizedPolicy).slice(0, branchLimit);
}

export function selectMinimaxLookaheadBranch(
  branches: MinimaxLookaheadBranch[],
  policy: unknown = buildDefaultMinimaxLookaheadPolicy(),
): ScoredMinimaxLookaheadBranch | null {
  return rankMinimaxLookaheadBranches(branches, policy)[0] ?? null;
}
