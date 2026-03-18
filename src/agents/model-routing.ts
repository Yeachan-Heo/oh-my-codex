import type { AgentDefinition } from './definitions.js';
import { getRootModelName } from '../config/generator.js';
import {
  DEFAULT_FRONTIER_MODEL,
  DEFAULT_MINI_MODEL,
  DEFAULT_SPARK_MODEL,
  getEnvConfiguredMainDefaultModel,
  getEnvConfiguredSparkDefaultModel,
  getSparkDefaultModel,
} from '../config/models.js';

export interface AgentModelResolutionContext {
  frontierModel: string;
  miniModel: string;
  sparkModel: string;
  subagentDefaultModel: string;
}

export function resolveAgentModelContext(
  configTomlContent: string,
  options: {
    codexHomeOverride?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): AgentModelResolutionContext {
  const { codexHomeOverride, env = process.env } = options;
  const frontierModel =
    getRootModelName(configTomlContent) ??
    getEnvConfiguredMainDefaultModel(env, codexHomeOverride) ??
    DEFAULT_FRONTIER_MODEL;
  const sparkModel =
    getEnvConfiguredSparkDefaultModel(env, codexHomeOverride) ??
    getSparkDefaultModel(codexHomeOverride) ??
    DEFAULT_SPARK_MODEL;

  return {
    frontierModel,
    miniModel: DEFAULT_MINI_MODEL,
    sparkModel,
    subagentDefaultModel: frontierModel,
  };
}

export function resolveModelForPreferredTier(
  preferredModelTier: AgentDefinition['preferredModelTier'],
  context: AgentModelResolutionContext,
): string {
  switch (preferredModelTier) {
    case 'frontier':
      return context.frontierModel;
    case 'mini':
      return context.miniModel;
    case 'spark':
      return context.sparkModel;
    case 'default':
    default:
      return context.subagentDefaultModel;
  }
}

export function resolveAgentModel(
  agent: AgentDefinition,
  context: AgentModelResolutionContext,
): string {
  return resolveModelForPreferredTier(agent.preferredModelTier, context);
}
