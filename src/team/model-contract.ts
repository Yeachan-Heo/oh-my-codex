const MADMAX_FLAG = '--madmax';
const CODEX_BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox';
const MODEL_FLAG = '--model';
const CONFIG_FLAG = '-c';
const REASONING_KEY = 'model_reasoning_effort';

const LOW_COMPLEXITY_AGENT_TYPES = new Set([
  'explore',
  'explorer',
  'style-reviewer',
  'writer',
]);

export const TEAM_LOW_COMPLEXITY_DEFAULT_MODEL = 'gpt-5.3-codex-spark';

export interface ParsedTeamWorkerLaunchArgs {
  passthrough: string[];
  wantsBypass: boolean;
  reasoningOverride: string | null;
  modelOverride: string | null;
}

export interface ResolveTeamWorkerLaunchArgsOptions {
  existingRaw?: string;
  inheritedArgs?: string[];
  fallbackModel?: string;
}

function isReasoningOverride(value: string): boolean {
  return new RegExp(`^${REASONING_KEY}\\s*=`).test(value.trim());
}

function isValidModelValue(value: string): boolean {
  return value.trim().length > 0 && !value.startsWith('-');
}

function normalizeOptionalModel(model?: string | null): string | undefined {
  if (typeof model !== 'string') return undefined;
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
    }

    passthrough.push(arg);
  }

  return {
    passthrough,
    wantsBypass,
    reasoningOverride,
    modelOverride,
  };
}

export function collectInheritableTeamWorkerArgs(codexArgs: string[]): string[] {
  const parsed = parseTeamWorkerLaunchArgs(codexArgs);

  const inherited: string[] = [];
  if (parsed.wantsBypass) inherited.push(CODEX_BYPASS_FLAG);
  if (parsed.reasoningOverride) inherited.push(CONFIG_FLAG, parsed.reasoningOverride);
  if (parsed.modelOverride) inherited.push(MODEL_FLAG, parsed.modelOverride);
  return inherited;
}

export function normalizeTeamWorkerLaunchArgs(args: string[], preferredModel?: string): string[] {
  const parsed = parseTeamWorkerLaunchArgs(args);
  const normalized = [...parsed.passthrough];

  if (parsed.wantsBypass) normalized.push(CODEX_BYPASS_FLAG);
  if (parsed.reasoningOverride) normalized.push(CONFIG_FLAG, parsed.reasoningOverride);

  const selectedModel = normalizeOptionalModel(preferredModel) ?? normalizeOptionalModel(parsed.modelOverride);
  if (selectedModel) normalized.push(MODEL_FLAG, selectedModel);

  return normalized;
}

export function resolveTeamWorkerLaunchArgs(options: ResolveTeamWorkerLaunchArgsOptions): string[] {
  const envArgs = splitWorkerLaunchArgs(options.existingRaw);
  const inheritedArgs = options.inheritedArgs ?? [];
  const allArgs = [...envArgs, ...inheritedArgs];

  const envModel = normalizeOptionalModel(parseTeamWorkerLaunchArgs(envArgs).modelOverride);
  const inheritedModel = normalizeOptionalModel(parseTeamWorkerLaunchArgs(inheritedArgs).modelOverride);
  const fallbackModel = normalizeOptionalModel(options.fallbackModel);
  const selectedModel = envModel ?? inheritedModel ?? fallbackModel;
  return normalizeTeamWorkerLaunchArgs(allArgs, selectedModel);
}

export function isLowComplexityAgentType(agentType?: string): boolean {
  if (!agentType) return false;
  const normalized = agentType.trim().toLowerCase();
  if (normalized === '') return false;
  if (normalized.endsWith('-low')) return true;
  return LOW_COMPLEXITY_AGENT_TYPES.has(normalized);
}
