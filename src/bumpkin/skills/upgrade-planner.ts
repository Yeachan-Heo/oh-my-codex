import type { ModelProvider, ModelRequest } from '../model/provider.js';

export interface DependencyRecord {
  name: string;
  current: string;
  latest: string;
  changelog?: string;
}

export interface UpgradeTarget {
  name: string;
  from: string;
  to: string;
  rationale: string;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface UpgradePlan {
  order: UpgradeTarget[];
  raw: string;
}

export interface UpgradePlannerInput {
  dependencies: readonly DependencyRecord[];
  repoContext?: string;
}

export const PLANNER_SYSTEM_PROMPT =
  'You are Bumpkin, a dependency-upgrade planning agent. Given a set of stale ' +
  'dependencies with changelogs, output a JSON array under the key "order" of ' +
  'upgrade targets in the correct application order: patch → minor → major, ' +
  'devDeps before prod deps, never batch majors together. Include a risk level ' +
  'per target. Respond ONLY with JSON.';

export function buildPlannerRequest(input: UpgradePlannerInput): ModelRequest {
  const user =
    (input.repoContext ? `Repo context:\n${input.repoContext}\n\n` : '') +
    'Dependencies:\n' +
    input.dependencies
      .map((d) => `- ${d.name}: ${d.current} -> ${d.latest}${d.changelog ? ` (${d.changelog})` : ''}`)
      .join('\n');
  return {
    system: PLANNER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: user }],
  };
}

export interface PlannerResponseShape {
  order?: Array<{
    name: string;
    from: string;
    to: string;
    rationale: string;
    riskLevel: string;
  }>;
}

export class PlannerResponseError extends Error {}

export function parsePlannerResponse(raw: string): UpgradePlan {
  let parsed: PlannerResponseShape;
  try {
    parsed = JSON.parse(raw) as PlannerResponseShape;
  } catch (e) {
    throw new PlannerResponseError(`planner output was not JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed.order)) {
    throw new PlannerResponseError('planner output missing "order" array');
  }
  const order: UpgradeTarget[] = parsed.order.map((t, i) => {
    if (!t.name || !t.from || !t.to) {
      throw new PlannerResponseError(`planner target #${i} is missing required fields`);
    }
    const risk: UpgradeTarget['riskLevel'] =
      t.riskLevel === 'low' || t.riskLevel === 'medium' || t.riskLevel === 'high'
        ? t.riskLevel
        : 'medium';
    return { name: t.name, from: t.from, to: t.to, rationale: t.rationale ?? '', riskLevel: risk };
  });
  return { order, raw };
}

export async function planUpgrades(
  provider: ModelProvider,
  input: UpgradePlannerInput,
): Promise<UpgradePlan> {
  const response = await provider.call(buildPlannerRequest(input));
  return parsePlannerResponse(response.content);
}
