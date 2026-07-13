import { getAgent } from '../agents/definitions.js';
import {
  DEFAULT_SPARK_MODEL,
  getAgentModelOverride,
  getAgentReasoningOverride,
  getMainDefaultModel,
  getSparkDefaultModel,
  getStandardDefaultModel,
  type PerAgentReasoningEffort,
} from '../config/models.js';

const MADMAX_FLAG = '--madmax';
const CODEX_BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox';
const MODEL_FLAG = '--model';
const CONFIG_FLAG = '-c';
const LONG_CONFIG_FLAG = '--config';
const APPROVAL_POLICY_KEY = 'approval_policy';
const SANDBOX_MODE_KEY = 'sandbox_mode';
const REASONING_KEY = 'model_reasoning_effort';
const MODEL_PROVIDER_KEY = 'model_provider';
export const TEAM_WORKER_APPROVAL_FLAG = '--ask-for-approval';
export const TEAM_WORKER_SANDBOX_FLAG = '--sandbox';
export const TEAM_WORKER_INHERITED_MODEL_ENV = 'OMX_TEAM_WORKER_INHERITED_MODEL';

const LOW_COMPLEXITY_AGENT_TYPES = new Set([
  'explore',
  'explorer',
  'style-reviewer',
]);

// Canonical default only; effective low-complexity resolution flows through resolveTeamLowComplexityDefaultModel().
export const TEAM_LOW_COMPLEXITY_DEFAULT_MODEL = DEFAULT_SPARK_MODEL;
export type TeamReasoningEffort = PerAgentReasoningEffort;
export type TeamWorkerLaunchPolicyKind = 'none' | 'bypass' | 'direct-policy';
export type TeamWorkerLaunchPolicyClassification = TeamWorkerLaunchPolicyKind | 'mixed-policy';

export interface ParsedTeamWorkerLaunchArgs {
  passthrough: string[];
  endOfOptionsIndex: number | null;
  wantsBypass: boolean;
  approvalValue: string | null;
  sandboxValue: string | null;
  policyKind: TeamWorkerLaunchPolicyKind;
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
  honorExactRoleModel?: boolean;
}

function teamWorkerLaunchArgsError(source: string, reason: string): Error {
  return new Error(`Invalid ${source}: ${reason}`);
}

type PolicyAxis = 'approval' | 'sandbox';

function isConfigOverrideForKey(value: string, key: string): boolean {
  return new RegExp(`^${key}\\s*=`).test(value.trim());
}

function isReasoningOverride(value: string): boolean {
  return isConfigOverrideForKey(value, REASONING_KEY);
}

function isModelProviderOverride(value: string): boolean {
  return isConfigOverrideForKey(value, MODEL_PROVIDER_KEY);
}

function canonicalizeConfigStringOverride(value: string, key: string): string {
  const extracted = extractConfigStringValue(value, key);
  if (!extracted) return value;
  return `${key}="${extracted.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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

function configSelector(arg: string): { value?: string } | null {
  if (arg === CONFIG_FLAG || arg === LONG_CONFIG_FLAG) return {};
  if (arg.startsWith(`${CONFIG_FLAG}=`)) return { value: arg.slice(`${CONFIG_FLAG}=`.length) };
  if (arg.startsWith(`${LONG_CONFIG_FLAG}=`)) return { value: arg.slice(`${LONG_CONFIG_FLAG}=`.length) };
  return null;
}

function extractConfigPolicyAssignment(value: string): { axis: PolicyAxis; value: string } | null {
  const match = new RegExp(`^(${APPROVAL_POLICY_KEY}|${SANDBOX_MODE_KEY})\\s*=\\s*([\\s\\S]*)$`).exec(value.trim());
  if (!match) return null;

  const rawValue = match[2]!.trim();
  const quoted = rawValue.length >= 2
    && ((rawValue.startsWith('"') && rawValue.endsWith('"'))
      || (rawValue.startsWith("'") && rawValue.endsWith("'")));
  return {
    axis: match[1] === APPROVAL_POLICY_KEY ? 'approval' : 'sandbox',
    value: quoted ? rawValue.slice(1, -1) : rawValue,
  };
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
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh' || normalized === 'max') {
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
  const explicitReasoningOverride = params.inheritedParsed.reasoningOverride
    ?? params.envParsed.reasoningOverride;
  const selectedModel = normalizeOptionalModel(actualParsed.modelOverride);

  return {
    requestedAgentType: params.requestedAgentType,
    requestedDefaultModel: fallbackModel,
    requestedDefaultReasoning,
    actualModel: selectedModel,
    actualReasoning: extractReasoningEffort(actualParsed.reasoningOverride),
    modelSource:
      selectedModel && envModel && selectedModel === envModel && (!inheritedModel || envModel !== inheritedModel)
        ? 'env'
        : selectedModel && inheritedModel && selectedModel === inheritedModel
          ? 'inherited'
          : selectedModel
            ? 'fallback'
            : 'none',
    reasoningSource: explicitReasoningOverride ? 'explicit' : requestedDefaultReasoning ? 'role-default' : 'none',
    inheritedParentModel: Boolean(inheritedModel) && Boolean(selectedModel) && selectedModel === inheritedModel,
    actualLaunchArgs: [...params.actualLaunchArgs],
  };
}

/**
 * Tokenize OMX_TEAM_WORKER_LAUNCH_ARGS without evaluating shell syntax.
 * Quoting and escaping are intentionally limited to this transport grammar.
 */
interface WorkerLaunchArgToken {
  value: string;
  source: string;
}

function tokenizeWorkerLaunchArgs(raw: string | undefined): WorkerLaunchArgToken[] {
  if (raw === undefined || raw === '') return [];

  const args: WorkerLaunchArgToken[] = [];
  let token = '';
  let tokenStarted = false;
  let tokenStart = 0;
  let quote: 'single' | 'double' | null = null;

  const pushToken = (end: number): void => {
    args.push({ value: token, source: raw.slice(tokenStart, end) });
    token = '';
    tokenStarted = false;
  };

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (quote === 'single') {
      if (character === "'") quote = null;
      else token += character;
      continue;
    }

    if (quote === 'double') {
      if (character === '"') {
        quote = null;
      } else if (character === '\\' && raw[index + 1] === '"') {
        token += '"';
        index += 1;
      } else {
        token += character;
      }
      continue;
    }

    if (/\s/u.test(character)) {
      if (tokenStarted) pushToken(index);
      continue;
    }
    if (!tokenStarted) tokenStart = index;
    if (character === "'") {
      quote = 'single';
      tokenStarted = true;
      continue;
    }
    if (character === '"') {
      quote = 'double';
      tokenStarted = true;
      continue;
    }
    if (character === '\\') {
      token += character;
      tokenStarted = true;
      continue;
    }
    token += character;
    tokenStarted = true;
  }

  if (quote !== null) {
    throw teamWorkerLaunchArgsError('OMX_TEAM_WORKER_LAUNCH_ARGS', 'unterminated quote');
  }
  if (tokenStarted) pushToken(raw.length);
  return args;
}

function extractExactEnvironmentReasoningOverride(raw: string | undefined): string | null {
  const tokens = tokenizeWorkerLaunchArgs(raw);
  let reasoningOverride: string | null = null;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.value === '--') break;
    if (token.value !== CONFIG_FLAG) continue;

    const configValue = tokens[index + 1];
    if (!configValue) continue;
    index += 1;
    if (!isReasoningOverride(configValue.value)) continue;

    const startsWithGroupingQuote = configValue.source.startsWith('"') || configValue.source.startsWith("'");
    reasoningOverride = startsWithGroupingQuote ? configValue.value : configValue.source;
  }

  return reasoningOverride;
}

function restoreExactEnvironmentReasoningOverride(args: string[], raw: string | undefined): string[] {
  const exactReasoningOverride = extractExactEnvironmentReasoningOverride(raw);
  if (exactReasoningOverride === null) return args;

  let reasoningValueIndex: number | null = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--') break;
    if (args[index] !== CONFIG_FLAG || !isReasoningOverride(args[index + 1] ?? '')) continue;
    reasoningValueIndex = index + 1;
    index += 1;
  }
  if (reasoningValueIndex !== null) args[reasoningValueIndex] = exactReasoningOverride;
  return args;
}

export function splitWorkerLaunchArgs(raw: string | undefined): string[] {
  return tokenizeWorkerLaunchArgs(raw).map((token) => token.value);
}

/** Serialize worker launch arguments for reversible environment transport. */
export function serializeTeamWorkerLaunchArgs(args: readonly string[]): string {
  return args.map((arg) => {
    if (arg.includes('\\')) return `'${arg.replace(/'/g, `'"'"'`)}'`;
    return `"${arg.replace(/"/g, '\\"')}"`;
  }).join(' ');
}

function parseDirectPolicyValue(
  value: string | undefined,
  flag: string,
  source: string,
): string {
  if (typeof value !== 'string') {
    throw teamWorkerLaunchArgsError(source, `missing value for ${flag}`);
  }
  const normalized = value.trim();
  if (normalized === '' || normalized.startsWith('-')) {
    throw teamWorkerLaunchArgsError(source, `missing value for ${flag}`);
  }
  return value;
}

function setDirectPolicyValue(
  existingValue: string | null,
  value: string,
  axis: PolicyAxis,
  source: string,
): string {
  if (existingValue !== null && existingValue !== value) {
    throw teamWorkerLaunchArgsError(source, `conflicting duplicate ${axis} policy`);
  }
  return value;
}

function directPolicySelector(arg: string): { axis: 'approval' | 'sandbox'; flag: string; value?: string } | null {
  if (arg === TEAM_WORKER_APPROVAL_FLAG || arg === '-a') {
    return { axis: 'approval', flag: TEAM_WORKER_APPROVAL_FLAG };
  }
  if (arg.startsWith(`${TEAM_WORKER_APPROVAL_FLAG}=`)) {
    return {
      axis: 'approval',
      flag: TEAM_WORKER_APPROVAL_FLAG,
      value: arg.slice(`${TEAM_WORKER_APPROVAL_FLAG}=`.length),
    };
  }
  if (arg.startsWith('-a=')) {
    return { axis: 'approval', flag: TEAM_WORKER_APPROVAL_FLAG, value: arg.slice(3) };
  }
  if (arg === TEAM_WORKER_SANDBOX_FLAG || arg === '-s') {
    return { axis: 'sandbox', flag: TEAM_WORKER_SANDBOX_FLAG };
  }
  if (arg.startsWith(`${TEAM_WORKER_SANDBOX_FLAG}=`)) {
    return {
      axis: 'sandbox',
      flag: TEAM_WORKER_SANDBOX_FLAG,
      value: arg.slice(`${TEAM_WORKER_SANDBOX_FLAG}=`.length),
    };
  }
  if (arg.startsWith('-s=')) {
    return { axis: 'sandbox', flag: TEAM_WORKER_SANDBOX_FLAG, value: arg.slice(3) };
  }
  return null;
}

interface ParseTeamWorkerLaunchArgsOptions {
  directPolicyMode?: 'validate' | 'ignore';
}

export function parseTeamWorkerLaunchArgs(
  args: string[],
  source: string = 'worker launch arguments',
  options: ParseTeamWorkerLaunchArgsOptions = {},
): ParsedTeamWorkerLaunchArgs {

  const passthrough: string[] = [];
  let endOfOptionsIndex: number | null = null;
  let wantsBypass = false;
  let approvalValue: string | null = null;
  let sandboxValue: string | null = null;
  let reasoningOverride: string | null = null;
  let modelProviderOverride: string | null = null;
  let modelOverride: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      endOfOptionsIndex = passthrough.length;
      passthrough.push(...args.slice(i));
      break;
    }
    if (arg === CODEX_BYPASS_FLAG || arg === MADMAX_FLAG) {
      wantsBypass = true;
      continue;
    }

    const directPolicy = directPolicySelector(arg);
    if (directPolicy) {
      if (options.directPolicyMode === 'ignore') {
        if (directPolicy.value === undefined && typeof args[i + 1] === 'string' && !args[i + 1]!.startsWith('-')) {
          i += 1;
        }
        continue;
      }

      const value = parseDirectPolicyValue(
        directPolicy.value === undefined ? args[i + 1] : directPolicy.value,
        directPolicy.flag,
        source,
      );
      if (directPolicy.value === undefined) i += 1;
      if (directPolicy.axis === 'approval') {
        approvalValue = setDirectPolicyValue(approvalValue, value, 'approval', source);
      } else {
        sandboxValue = setDirectPolicyValue(sandboxValue, value, 'sandbox', source);
      }
      continue;
    }

    const config = configSelector(arg);
    if (config) {
      const splitConfig = config.value === undefined;
      const configValue = splitConfig ? args[i + 1] : config.value;
      const configValueMissing = typeof configValue !== 'string'
        || configValue.trim() === ''
        || configValue.trim().startsWith('-');
      if (configValueMissing) {
        if (options.directPolicyMode === 'ignore') continue;
        const configFlag = arg === LONG_CONFIG_FLAG || arg.startsWith(`${LONG_CONFIG_FLAG}=`)
          ? LONG_CONFIG_FLAG
          : CONFIG_FLAG;
        throw teamWorkerLaunchArgsError(source, `missing value for ${configFlag}`);
      }
      if (splitConfig) i += 1;

      const configPolicy = typeof configValue === 'string' ? extractConfigPolicyAssignment(configValue) : null;
      if (configPolicy) {
        if (options.directPolicyMode === 'ignore') continue;

        const flag = configPolicy.axis === 'approval' ? TEAM_WORKER_APPROVAL_FLAG : TEAM_WORKER_SANDBOX_FLAG;
        const value = parseDirectPolicyValue(configPolicy.value, flag, source);
        if (configPolicy.axis === 'approval') {
          approvalValue = setDirectPolicyValue(approvalValue, value, 'approval', source);
        } else {
          sandboxValue = setDirectPolicyValue(sandboxValue, value, 'sandbox', source);
        }
        continue;
      }

      if (arg === CONFIG_FLAG && splitConfig && typeof configValue === 'string') {
        if (isReasoningOverride(configValue)) {
          reasoningOverride = configValue;
          continue;
        }
        if (isModelProviderOverride(configValue)) {
          modelProviderOverride = configValue;
          continue;
        }
      }

      passthrough.push(arg);
      if (splitConfig && typeof configValue === 'string') passthrough.push(configValue);
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

    passthrough.push(arg);
  }

  const policyKind: TeamWorkerLaunchPolicyKind = approvalValue !== null || sandboxValue !== null
    ? 'direct-policy'
    : wantsBypass
      ? 'bypass'
      : 'none';
  return {
    passthrough,
    endOfOptionsIndex,
    wantsBypass,
    approvalValue,
    sandboxValue,
    policyKind,
    reasoningOverride,
    modelProviderOverride,
    modelOverride,
  };
}

export function classifyTeamWorkerLaunchPolicy(args: string[]): TeamWorkerLaunchPolicyClassification {
  const parsed = parseTeamWorkerLaunchArgs(args);
  if (parsed.wantsBypass && parsed.policyKind === 'direct-policy') return 'mixed-policy';
  return parsed.policyKind;
}

export function collectInheritableTeamWorkerArgs(codexArgs: string[]): string[] {
  const parsed = parseTeamWorkerLaunchArgs(codexArgs, 'leader arguments', { directPolicyMode: 'ignore' });

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
  const endOfOptionsIndex = parsed.endOfOptionsIndex ?? parsed.passthrough.length;
  const normalized = parsed.passthrough.slice(0, endOfOptionsIndex);

  if (parsed.policyKind === 'direct-policy') {
    if (parsed.approvalValue !== null) normalized.push(TEAM_WORKER_APPROVAL_FLAG, parsed.approvalValue);
    if (parsed.sandboxValue !== null) normalized.push(TEAM_WORKER_SANDBOX_FLAG, parsed.sandboxValue);
  } else if (parsed.wantsBypass) {
    normalized.push(CODEX_BYPASS_FLAG);
  }

  const selectedReasoning = parsed.reasoningOverride
    ?? (normalizeOptionalReasoning(preferredReasoning)
      ? `${REASONING_KEY}="${normalizeOptionalReasoning(preferredReasoning)}"`
      : null);
  const selectedModelProvider = preferredModelProviderOverride ?? parsed.modelProviderOverride;
  if (selectedModelProvider) normalized.push(CONFIG_FLAG, canonicalizeConfigStringOverride(selectedModelProvider, MODEL_PROVIDER_KEY));
  if (selectedReasoning) normalized.push(CONFIG_FLAG, selectedReasoning);

  const selectedModel = normalizeOptionalModel(preferredModel) ?? normalizeOptionalModel(parsed.modelOverride);
  if (selectedModel) normalized.push(MODEL_FLAG, selectedModel);

  normalized.push(...parsed.passthrough.slice(endOfOptionsIndex));
  return normalized;
}

function shouldHonorExactRoleModel(options: ResolveTeamWorkerLaunchArgsOptions): boolean {
  return options.honorExactRoleModel === true && Boolean(options.fallbackModel);
}

function selectTeamWorkerModel(params: {
  envModel?: string;
  inheritedModel?: string;
  fallbackModel?: string;
  honorExactRoleModel?: boolean;
}): string | undefined {
  const envModel = normalizeOptionalModel(params.envModel);
  const inheritedModel = normalizeOptionalModel(params.inheritedModel);
  const fallbackModel = normalizeOptionalModel(params.fallbackModel);
  if (envModel && envModel !== inheritedModel) return envModel;
  if (params.honorExactRoleModel && fallbackModel) return fallbackModel;
  return envModel ?? inheritedModel ?? fallbackModel;
}

export function resolveTeamWorkerLaunchArgs(options: ResolveTeamWorkerLaunchArgsOptions): string[] {
  const envArgs = restoreExactEnvironmentReasoningOverride(
    splitWorkerLaunchArgs(options.existingRaw),
    options.existingRaw,
  );
  const inheritedArgs = options.inheritedArgs ?? [];
  const envParsed = parseTeamWorkerLaunchArgs(envArgs, 'OMX_TEAM_WORKER_LAUNCH_ARGS');
  if (envParsed.wantsBypass && envParsed.policyKind === 'direct-policy') {
    throw teamWorkerLaunchArgsError(
      'OMX_TEAM_WORKER_LAUNCH_ARGS',
      'bypass cannot be combined with direct approval or sandbox policy',
    );
  }
  const inheritedParsed = parseTeamWorkerLaunchArgs(inheritedArgs, 'inherited leader worker launch arguments');

  const envModel = normalizeOptionalModel(envParsed.modelOverride);
  const inheritedModel = normalizeOptionalModel(inheritedParsed.modelOverride);
  const fallbackModel = normalizeOptionalModel(options.fallbackModel);
  const selectedModel = selectTeamWorkerModel({
    envModel,
    inheritedModel,
    fallbackModel,
    honorExactRoleModel: shouldHonorExactRoleModel(options),
  });
  const selectedModelProvider = envParsed.modelProviderOverride ?? inheritedParsed.modelProviderOverride ?? undefined;
  const endOfOptionsIndex = envArgs.indexOf('--');
  const combinedArgs = endOfOptionsIndex === -1
    ? [...envArgs, ...inheritedArgs]
    : [...envArgs.slice(0, endOfOptionsIndex), ...inheritedArgs, ...envArgs.slice(endOfOptionsIndex)];
  return normalizeTeamWorkerLaunchArgs(
    combinedArgs,
    selectedModel,
    options.preferredReasoning,
    selectedModelProvider,
  );
}

export function resolveTeamWorkerLaunchDiagnostics(
  options: ResolveTeamWorkerLaunchArgsOptions & { requestedAgentType?: string },
): ResolvedTeamWorkerLaunchDiagnostics {
  const envArgs = restoreExactEnvironmentReasoningOverride(
    splitWorkerLaunchArgs(options.existingRaw),
    options.existingRaw,
  );
  const inheritedArgs = options.inheritedArgs ?? [];
  const envParsed = parseTeamWorkerLaunchArgs(envArgs, 'OMX_TEAM_WORKER_LAUNCH_ARGS');
  const inheritedParsed = parseTeamWorkerLaunchArgs(inheritedArgs, 'inherited leader worker launch arguments');
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

export function shouldHonorAgentExactModel(
  agentType?: string,
  codexHomeOverride?: string,
): boolean {
  if (typeof agentType !== 'string' || agentType.trim() === '') return false;
  const normalized = agentType.trim().toLowerCase();
  if (getAgentModelOverride(normalized, codexHomeOverride)) return true;
  return Boolean(getAgent(normalized)?.exactModel);
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

  const agent = getAgent(normalized);
  if (agent?.exactModel) return agent.exactModel;
  if (normalized === 'executor') return getMainDefaultModel(codexHomeOverride);

  switch (agent?.modelClass) {
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
