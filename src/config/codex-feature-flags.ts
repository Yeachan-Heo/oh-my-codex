export const CODEX_HOOK_FEATURE_FLAGS = ["hooks", "codex_hooks"] as const;
export const CODEX_PLUGIN_SCOPED_HOOKS_FEATURE_FLAG = "plugin_hooks";

export type CodexHookFeatureFlag = (typeof CODEX_HOOK_FEATURE_FLAGS)[number];

/**
 * Current Codex CLI releases expose lifecycle hooks as `[features].hooks`.
 * Older releases used `[features].codex_hooks`. Keep the default on the
 * current canonical name while allowing setup to probe and select the legacy
 * spelling when it is the only feature reported by the installed Codex.
 */
export const DEFAULT_CODEX_HOOK_FEATURE_FLAG: CodexHookFeatureFlag = "hooks";

export function isCodexHookFeatureFlagName(
  name: string,
): name is CodexHookFeatureFlag {
  return (CODEX_HOOK_FEATURE_FLAGS as readonly string[]).includes(name);
}

export function normalizeCodexHookFeatureFlag(
  value: string | null | undefined,
): CodexHookFeatureFlag {
  return value === "codex_hooks" ? "codex_hooks" : DEFAULT_CODEX_HOOK_FEATURE_FLAG;
}

export function parseCodexFeatureNames(
  featuresListOutput: string | null | undefined,
): Set<string> {
  const names = new Set<string>();
  for (const rawLine of (featuresListOutput ?? "").split(/\r?\n/)) {
    const match = rawLine.trim().match(/^([A-Za-z0-9_]+)\s+/);
    if (match) names.add(match[1]);
  }
  return names;
}

export function parseCodexCliVersion(
  versionOutput: string | null | undefined,
): [number, number, number] | null {
  const match = (versionOutput ?? "").match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isCodexCliVersionAtLeast(
  versionOutput: string | null | undefined,
  minimum: [number, number, number],
): boolean {
  const parsed = parseCodexCliVersion(versionOutput);
  if (!parsed) return false;
  for (let i = 0; i < minimum.length; i++) {
    if (parsed[i] > minimum[i]) return true;
    if (parsed[i] < minimum[i]) return false;
  }
  return true;
}

export type CodexPluginHookFeatureFlag = "hooks" | "plugin_hooks";

export function resolveCodexPluginHookFeatureFlag(options: {
  featuresListOutput?: string | null;
} = {}): CodexPluginHookFeatureFlag | null {
  const stages = new Map<string, string>();
  for (const line of (options.featuresListOutput ?? "").split(/\r?\n/)) {
    const match = line.trim().match(/^(\w+)\s+(.+?)\s+(?:true|false)$/);
    if (match) stages.set(match[1], match[2]);
  }
  const pluginStage = stages.get(CODEX_PLUGIN_SCOPED_HOOKS_FEATURE_FLAG);
  // Removed flags remain in `features list`, but cannot enable a capability.
  // Codex consolidated plugin hooks into the canonical hooks feature.
  if (pluginStage === "removed") {
    const hooksStage = stages.get("hooks");
    return hooksStage && hooksStage !== "removed" ? "hooks" : null;
  }
  return pluginStage ? CODEX_PLUGIN_SCOPED_HOOKS_FEATURE_FLAG : null;
}

export function supportsCodexPluginScopedHooks(options: {
  featuresListOutput?: string | null;
} = {}): boolean {
  return resolveCodexPluginHookFeatureFlag(options) !== null;
}

export function resolveCodexHookFeatureFlag(options: {
  featuresListOutput?: string | null;
  versionOutput?: string | null;
  fallback?: CodexHookFeatureFlag;
} = {}): CodexHookFeatureFlag {
  const featureNames = parseCodexFeatureNames(options.featuresListOutput);

  if (featureNames.has("hooks")) return "hooks";
  if (featureNames.has("codex_hooks")) return "codex_hooks";

  if (isCodexCliVersionAtLeast(options.versionOutput, [0, 130, 0])) {
    return "hooks";
  }

  return options.fallback ?? DEFAULT_CODEX_HOOK_FEATURE_FLAG;
}

export function formatCodexHookFeatureFlagLine(
  featureFlag: CodexHookFeatureFlag,
): string {
  return `${normalizeCodexHookFeatureFlag(featureFlag)} = true`;
}
