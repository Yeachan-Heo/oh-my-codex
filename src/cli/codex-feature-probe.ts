import { spawnSync } from "child_process";
import {
  DEFAULT_CODEX_HOOK_FEATURE_FLAG,
  resolveCodexHookFeatureFlag,
  supportsCodexPluginScopedHooks,
  type CodexHookFeatureFlag,
} from "../config/codex-feature-flags.js";

export interface CodexFeatureProbeOptions {
  codexFeaturesProbe?: () => string | null;
  codexVersionProbe?: () => string | null;
}

type SpawnSyncLike = typeof spawnSync;

const CODEX_FEATURE_PROBE_TIMEOUT_MS = 3_000;

let cachedFeatureListOutput: string | null | undefined;
let cachedVersionOutput: string | null | undefined;

function runCodexProbe(args: readonly string[], spawnImpl: SpawnSyncLike): string | null {
  const result = spawnImpl("codex", [...args], {
    encoding: "utf-8",
    killSignal: "SIGKILL",
    timeout: CODEX_FEATURE_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  return [result.stdout, result.stderr].filter(Boolean).join("\n") || null;
}

export function probeInstalledCodexFeatureList(
  spawnImpl: SpawnSyncLike = spawnSync,
): string | null {
  if (spawnImpl === spawnSync && cachedFeatureListOutput !== undefined) {
    return cachedFeatureListOutput;
  }
  const output = runCodexProbe(["features", "list"], spawnImpl);
  if (spawnImpl === spawnSync) cachedFeatureListOutput = output;
  return output;
}

export function probeInstalledCodexVersion(
  spawnImpl: SpawnSyncLike = spawnSync,
): string | null {
  if (spawnImpl === spawnSync && cachedVersionOutput !== undefined) {
    return cachedVersionOutput;
  }
  const output = runCodexProbe(["--version"], spawnImpl);
  if (spawnImpl === spawnSync) cachedVersionOutput = output;
  return output;
}

export interface CodexHookFeatureSupport {
  hookFeatureFlag: CodexHookFeatureFlag;
  pluginScopedHooks: boolean;
}

export function resolveCodexHookFeatureSupportForCli(
  options: CodexFeatureProbeOptions = {},
): CodexHookFeatureSupport {
  const featuresListOutput =
    options.codexFeaturesProbe?.() ?? probeInstalledCodexFeatureList();
  const versionOutput = options.codexVersionProbe?.() ?? probeInstalledCodexVersion();
  return {
    hookFeatureFlag: resolveCodexHookFeatureFlag({
      featuresListOutput,
      versionOutput,
      fallback: DEFAULT_CODEX_HOOK_FEATURE_FLAG,
    }),
    pluginScopedHooks: supportsCodexPluginScopedHooks({ featuresListOutput }),
  };
}

export function resolveCodexHookFeatureFlagForCli(
  options: CodexFeatureProbeOptions = {},
): CodexHookFeatureFlag {
  return resolveCodexHookFeatureSupportForCli(options).hookFeatureFlag;
}
