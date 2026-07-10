import { AGENT_DEFINITIONS } from '../agents/definitions.js';
import {
  DEFAULT_SPARK_MODEL,
  DEFAULT_STANDARD_MODEL,
  getAgentModelOverride,
  getMainDefaultModel,
  getModelForMode,
} from '../config/models.js';

export type AutopilotPlanningOwner = 'main' | 'planner';

export interface AutopilotPlannerRoutingDecision {
  owner: AutopilotPlanningOwner;
  mainModel: string;
  plannerModel: string;
  reason: 'main_is_cheap_or_mini' | 'explicit_planner_override' | 'main_not_cheap_or_mini';
  explicitPlannerOverride: boolean;
}

const CHEAP_OR_MINI_MODEL_PATTERN = /(?:^|[-_:/\s])(?:o\d+-mini|mini|nano|small|cheap|economy|spark|luna|lite|flash)(?:$|[-_:/\s])/i;

function normalizeModelName(value: string): string {
  return value.trim();
}

export function isCheapOrMiniModelName(model: string): boolean {
  const normalized = normalizeModelName(model);
  if (!normalized) return false;
  if (normalized === DEFAULT_STANDARD_MODEL || normalized === DEFAULT_SPARK_MODEL) return true;
  return CHEAP_OR_MINI_MODEL_PATTERN.test(normalized);
}

export function getDefaultPlannerModel(codexHomeOverride?: string): string {
  return getAgentModelOverride('planner', codexHomeOverride)
    ?? AGENT_DEFINITIONS.planner.exactModel
    ?? getMainDefaultModel(codexHomeOverride);
}

/**
 * Decide who owns heavy Autopilot planning before the ralplan consensus gates.
 *
 * Backward compatibility: when the Autopilot/main model is not recognizably
 * cheap/mini and no planner override exists, planning remains on main. When a
 * maintainer deliberately makes main cheap, or configures `agentModels.planner`,
 * Autopilot records a dedicated planner owner so the ralplan draft/decomposition
 * phase does not silently stay on the economy lane.
 */
export function resolveAutopilotPlannerRouting(
  codexHomeOverride?: string,
): AutopilotPlannerRoutingDecision {
  const mainModel = getModelForMode('autopilot', codexHomeOverride);
  const explicitPlannerModel = getAgentModelOverride('planner', codexHomeOverride);
  const plannerModel = explicitPlannerModel ?? getDefaultPlannerModel(codexHomeOverride);
  const explicitPlannerOverride = Boolean(explicitPlannerModel);
  const mainIsCheapOrMini = isCheapOrMiniModelName(mainModel);

  if (explicitPlannerOverride) {
    return {
      owner: 'planner',
      mainModel,
      plannerModel,
      reason: 'explicit_planner_override',
      explicitPlannerOverride,
    };
  }

  if (mainIsCheapOrMini) {
    return {
      owner: 'planner',
      mainModel,
      plannerModel,
      reason: 'main_is_cheap_or_mini',
      explicitPlannerOverride,
    };
  }

  return {
    owner: 'main',
    mainModel,
    plannerModel,
    reason: 'main_not_cheap_or_mini',
    explicitPlannerOverride,
  };
}
