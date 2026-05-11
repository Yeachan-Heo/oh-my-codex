import { spawnSync } from "child_process";
import {
  DEFAULT_CODEX_HOOK_FEATURE_FLAG,
  resolveCodexHookFeatureFlag,
  type CodexHookFeatureFlag,
} from "../config/codex-feature-flags.js";

export interface CodexFeatureProbeOptions {
  codexFeaturesProbe?: () => string | null;
  codexVersionProbe?: () => string | null;
}

export function probeInstalledCodexFeatureList(): string | null {
  const result = spawnSync("codex", ["features", "list"], {
    encoding: "utf-8",
  });
  if (result.error || result.status !== 0) return null;
  return [result.stdout, result.stderr].filter(Boolean).join("\n") || null;
}

export function probeInstalledCodexVersion(): string | null {
  const result = spawnSync("codex", ["--version"], {
    encoding: "utf-8",
  });
  if (result.error || result.status !== 0) return null;
  return [result.stdout, result.stderr].filter(Boolean).join("\n") || null;
}

export function resolveCodexHookFeatureFlagForCli(
  options: CodexFeatureProbeOptions = {},
): CodexHookFeatureFlag {
  const featuresListOutput =
    options.codexFeaturesProbe?.() ?? probeInstalledCodexFeatureList();
  const versionOutput = options.codexVersionProbe?.() ?? probeInstalledCodexVersion();
  return resolveCodexHookFeatureFlag({
    featuresListOutput,
    versionOutput,
    fallback: DEFAULT_CODEX_HOOK_FEATURE_FLAG,
  });
}
