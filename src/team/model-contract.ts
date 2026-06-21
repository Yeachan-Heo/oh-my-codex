import { getAgent } from '../agents/definitions.js';
import {
  DEFAULT_SPARK_MODEL,
  getAgentModelOverride,
  getAgentReasoningOverride,
  getMainDefaultModel,
  getSparkDefaultModel,
  getStandardDefaultModel,
} from '../config/models.js';

const MADMAX_FLAG = '--madmax';
const CODEX_BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox';
const MODEL_FLAG = '--model';
const CONFIG_FLAG = '-c';
const REASONING_KEY = 'model_reasoning_effort';
const MODEL_PROVIDER_KEY = 'model_provider';

const LOW_COMPLEXITY_AGENT_TYPES = new Set([
  'explore',
  'explorer',
  'style-reviewer',
]);

// Canonical default only; effective low-complexity resolution flows through resolveTeamLowComplexityDefaultModel().
export const TEAM_LOW_COMPLEXITY_DEFAULT_MODEL = DEFAULT_SPARK_MODEL;
export type TeamReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface ParsedTeamWorkerLaunchArgs {
  passthrough: string[];
  wantsBypass: boolean;
  reasoningOverride: string | null;
  modelProviderOverride: string | null;
  modelOverride: string | null;
}

export type TeamWorkerLaunchModelSource = 'env' | 'inherited' | 'fallback' | 'none';
export type TeamWorkerLaunchReasoningSource = 'explicit' | 'role-default' | 'none';

export interface ResolvedTeamWorkerLaunchDiagnostics {
  requestedAgentType?: string;
  requestedDefaultModel?: string;
  requestedDefaultReasoning?: TeamReasoningEffort;
  actualModel?: string;
  actualReasoning?: TeamReasoningEffort;
  modelSource: TeamWorkerLaunchModelSource;
  reasoningSource: TeamWorkerLaunchReasoningSource;
  inheritedParentModel: boolean;
  actualLaunchArgs: string[];
}

export interface ResolveTeamWorkerLaunchArgsOptions {
  existingRaw?: string;
  inheritedArgs?: string[];
  fallbackModel?: string;
  preferredReasoning?: TeamReasoningEffort;
}


function isConfigOverrideForKey(value: string, key: string): boolean {
  return new RegExp(`^${key}\\s*=`).test(value.trim());
}

function isReasoningOverride(value: string): boolean {
  return isConfigOverrideForKey(value, REASONING_KEY);
}

function isModelProviderOverride(value: string): boolean {
  return isConfigOverrideForKey(value, MODEL_PROVIDER_KEY);
}

function extractConfigStringValue(value: string, key: string): string | null {
  const trimmed = value.trim();
  const match = new RegExp(`^${key}\\s*=\\s*(.+)$`).exec(trimmed);
  if (!match) return null;
  const raw = match[1]?.trim() ?? '';
  if (raw === '') return null;
  const quoted = /^(?:\"([^\"]*)\"|'([^']*)')$/.exec(raw);
  return (quoted?.[1] ?? quoted?.[2] ?? raw).trim() || null;
}

function isValidModelValue(value: string): boolean {
  return value.trim().length > 0 && !value.startsWith('-');
}

function normalizeOptionalModel(model?: string | null): string | undefined {
  if (typeof model !== 'string') return undefined;
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalReasoning(reasoning?: TeamReasoningEffort | string | null): TeamReasoningEffort | undefined {
  if (typeof reasoning !== 'string') return undefined;
  const normalized = reasoning.trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') {
    return normalized;
  }
  return undefined;
}

function extractReasoningEffort(value: string | null): TeamReasoningEffort | undefined {
  return normalizeOptionalReasoning(
    value ? extractConfigStringValue(value, REASONING_KEY) : null,
  );
}

function resolveTeamWorkerLaunchDiagnosticsFromParts(params: {
  envParsed: ParsedTeamWorkerLaunchArgs;
  inheritedParsed: ParsedTeamWorkerLaunchArgs;
  fallbackModel?: string;
  preferredReasoning?: TeamReasoningEffort;
  actualLaunchArgs: string[];
  requestedAgentType?: string;
}): ResolvedTeamWorkerLaunchDiagnostics {
  const envModel = normalizeOptionalModel(params.envParsed.modelOverride);
  const inheritedModel = normalizeOptionalModel(params.inheritedParsed.modelOverride);
  const fallbackModel = normalizeOptionalModel(params.fallbackModel);
  const actualParsed = parseTeamWorkerLaunchArgs(params.actualLaunchArgs);
  const requestedDefaultReasoning = normalizeOptionalReasoning(params.preferredReasoning);
  const explicitReasoning = extractReasoningEffort(
    params.envParsed.reasoningOverride ?? params.inheritedParsed.reasoningOverride,
  );

  return {
    requestedAgentType: params.requestedAgentType,
    requestedDefaultModel: fallbackModel,
    requestedDefaultReasoning,
    actualModel: normalizeOptionalModel(actualParsed.modelOverride),
    actualReasoning: extractReasoningEffort(actualParsed.reasoningOverride),
    modelSource: envModel ? 'env' : inheritedModel ? 'inherited' : fallbackModel ? 'fallback' : 'none',
    reasoningSource: explicitReasoning ? 'explicit' : requestedDefaultReasoning ? 'role-default' : 'none',
    inheritedParentModel: !envModel && Boolean(inheritedModel),
    actualLaunchArgs: [...params.actualLaunchArgs],
  };
}

export function splitWorkerLaunchArgs(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return [];
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseTeamWorkerLaunchArgs(args: string[]): ParsedTeamWorkerLaunchArgs {
  const passthrough: string[] = [];
  let wantsBypass = false;
  let reasoningOverride: string | null = null;
  let modelProviderOverride: string | null = null;
  let modelOverride: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === CODEX_BYPASS_FLAG || arg === MADMAX_FLAG) {
      wantsBypass = true;
      continue;
    }

    if (arg === MODEL_FLAG) {
      const maybeValue = args[i + 1];
      if (typeof maybeValue === 'string' && isValidModelValue(maybeValue)) {
        modelOverride = maybeValue.trim();
        i += 1;
      }
      // Orphan --model with no valid value is silently dropped (never passthrough)
      continue;
    }

    if (arg.startsWith(`${MODEL_FLAG}=`)) {
      const inlineValue = arg.slice(`${MODEL_FLAG}=`.length).trim();
      if (isValidModelValue(inlineValue)) {
        modelOverride = inlineValue;
      }
      // --model= with empty/invalid value is silently dropped (never passthrough)
      continue;
    }

    if (arg === CONFIG_FLAG) {
      const maybeValue = args[i + 1];
      if (typeof maybeValue === 'string' && isReasoningOverride(maybeValue)) {
        reasoningOverride = maybeValue;
        i += 1;
        continue;
      }
      if (typeof maybeValue === 'string' && isModelProviderOverride(maybeValue)) {
        modelProviderOverride = maybeValue;
        i += 1;
        continue;
      }
    }

    passthrough.push(arg);
  }

  return {
    passthrough,
    wantsBypass,
    reasoningOverride,
    modelProviderOverride,
    modelOverride,
  };
}

export function collectInheritableTeamWorkerArgs(codexArgs: string[]): string[] {
  const parsed = parseTeamWorkerLaunchArgs(codexArgs);

  const inherited: string[] = [];
  if (parsed.wantsBypass) inherited.push(CODEX_BYPASS_FLAG);
  if (parsed.modelProviderOverride) inherited.push(CONFIG_FLAG, parsed.modelProviderOverride);
  if (parsed.reasoningOverride) inherited.push(CONFIG_FLAG, parsed.reasoningOverride);
  if (parsed.modelOverride) inherited.push(MODEL_FLAG, parsed.modelOverride);
  return inherited;
}

export function extractModelProviderOverrideValue(args: string[]): string | undefined {
  const override = parseTeamWorkerLaunchArgs(args).modelProviderOverride;
  if (!override) return undefined;
  return extractConfigStringValue(override, MODEL_PROVIDER_KEY) ?? undefined;
}

export function normalizeTeamWorkerLaunchArgs(
  args: string[],
  preferredModel?: string,
  preferredReasoning?: TeamReasoningEffort,
  preferredModelProviderOverride?: string,
): string[] {
  const parsed = parseTeamWorkerLaunchArgs(args);
  const normalized = [...parsed.passthrough];

  if (parsed.wantsBypass) normalized.push(CODEX_BYPASS_FLAG);

  const selectedReasoning = parsed.reasoningOverride
    ?? (normalizeOptionalReasoning(preferredReasoning)
      ? `${REASONING_KEY}="${normalizeOptionalReasoning(preferredReasoning)}"`
      : null);
  const selectedModelProvider = preferredModelProviderOverride ?? parsed.modelProviderOverride;
  if (selectedModelProvider) normalized.push(CONFIG_FLAG, selectedModelProvider);
  if (selectedReasoning) normalized.push(CONFIG_FLAG, selectedReasoning);

  const selectedModel = normalizeOptionalModel(preferredModel) ?? normalizeOptionalModel(parsed.modelOverride);
  if (selectedModel) normalized.push(MODEL_FLAG, selectedModel);

  return normalized;
}

export function resolveTeamWorkerLaunchArgs(options: ResolveTeamWorkerLaunchArgsOptions): string[] {
  const envArgs = splitWorkerLaunchArgs(options.existingRaw);
  const inheritedArgs = options.inheritedArgs ?? [];
  const allArgs = [...envArgs, ...inheritedArgs];

  const envParsed = parseTeamWorkerLaunchArgs(envArgs);
  const inheritedParsed = parseTeamWorkerLaunchArgs(inheritedArgs);
  const envModel = normalizeOptionalModel(envParsed.modelOverride);
  const inheritedModel = normalizeOptionalModel(inheritedParsed.modelOverride);
  const fallbackModel = normalizeOptionalModel(options.fallbackModel);
  const selectedModel = envModel ?? inheritedModel ?? fallbackModel;
  const selectedModelProvider = envParsed.modelProviderOverride ?? inheritedParsed.modelProviderOverride ?? undefined;
  return normalizeTeamWorkerLaunchArgs(allArgs, selectedModel, options.preferredReasoning, selectedModelProvider);
}

export function resolveTeamWorkerLaunchDiagnostics(
  options: ResolveTeamWorkerLaunchArgsOptions & { requestedAgentType?: string },
): ResolvedTeamWorkerLaunchDiagnostics {
  const envArgs = splitWorkerLaunchArgs(options.existingRaw);
  const inheritedArgs = options.inheritedArgs ?? [];
  const envParsed = parseTeamWorkerLaunchArgs(envArgs);
  const inheritedParsed = parseTeamWorkerLaunchArgs(inheritedArgs);
  const actualLaunchArgs = resolveTeamWorkerLaunchArgs(options);

  return resolveTeamWorkerLaunchDiagnosticsFromParts({
    envParsed,
    inheritedParsed,
    fallbackModel: options.fallbackModel,
    preferredReasoning: options.preferredReasoning,
    actualLaunchArgs,
    requestedAgentType: options.requestedAgentType,
  });
}

export function resolveAgentReasoningEffort(
  agentType?: string,
  codexHomeOverride?: string,
): TeamReasoningEffort | undefined {
  if (typeof agentType !== 'string' || agentType.trim() === '') return undefined;
  return normalizeOptionalReasoning(getAgentReasoningOverride(agentType, codexHomeOverride))
    ?? normalizeOptionalReasoning(getAgent(agentType)?.reasoningEffort);
}

export function resolveAgentDefaultModel(
  agentType?: string,
  codexHomeOverride?: string,
): string | undefined {
  if (typeof agentType !== 'string' || agentType.trim() === '') return undefined;
  const normalized = agentType.trim().toLowerCase();
  if (normalized === '') return undefined;
  const modelOverride = getAgentModelOverride(normalized, codexHomeOverride);
  if (modelOverride) return modelOverride;
  if (normalized.endsWith('-low')) return resolveTeamLowComplexityDefaultModel(codexHomeOverride);
  if (normalized === 'executor') return getMainDefaultModel(codexHomeOverride);

  switch (getAgent(normalized)?.modelClass) {
    case 'fast':
      return resolveTeamLowComplexityDefaultModel(codexHomeOverride);
    case 'frontier':
      return getMainDefaultModel(codexHomeOverride);
    case 'standard':
      return getStandardDefaultModel(codexHomeOverride);
    default:
      return undefined;
  }
}

export function isLowComplexityAgentType(agentType?: string): boolean {
  if (!agentType) return false;
  const normalized = agentType.trim().toLowerCase();
  if (normalized === '') return false;
  if (normalized.endsWith('-low')) return true;
  return LOW_COMPLEXITY_AGENT_TYPES.has(normalized);
}

export function resolveTeamLowComplexityDefaultModel(codexHomeOverride?: string): string {
  return getSparkDefaultModel(codexHomeOverride);
}
