import { spawnSync } from "child_process";
import {
  DEFAULT_CODEX_HOOK_FEATURE_FLAG,
  resolveCodexHookFeatureFlag,
  resolveCodexPluginHookSurface,
  supportsCodexPluginScopedHooks,
  type CodexHookFeatureFlag,
  type CodexPluginHookSurface,
} from "../config/codex-feature-flags.js";

export interface CodexFeatureProbeOptions {
  codexFeaturesProbe?: () => string | null;
  codexVersionProbe?: () => string | null;
}

type SpawnSyncLike = typeof spawnSync;

const CODEX_FEATURE_PROBE_TIMEOUT_MS = 3_000;
const CODEX_VERSION_PROBE_MAX_BYTES = 4_096;
const CODEX_VERSION_PROBE_MAX_LINES = 8;

let cachedFeatureListOutput: string | null | undefined;
let cachedVersionOutput: string | null | undefined;
let cachedDetailedVersionResult: CodexVersionProbeResult | undefined;

export interface CodexVersionProbeOutput {
  output: string;
  truncated: boolean;
  lineLimitExceeded: boolean;
}

export type CodexVersionProbeResult =
  | { status: "ok"; collected: CodexVersionProbeOutput }
  | { status: "start-unavailable" }
  | { status: "exit-failure" }
  | { status: "timeout" };
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

function collectBoundedVersionOutput(stdout: string, stderr: string): CodexVersionProbeOutput {
  const raw = [stdout, stderr].filter(Boolean).join("\n");
  const rawBytes = Buffer.from(raw, "utf8");
  const truncated = rawBytes.length > CODEX_VERSION_PROBE_MAX_BYTES;
  const byteBounded = rawBytes.subarray(0, CODEX_VERSION_PROBE_MAX_BYTES).toString("utf8");
  const rawLines = raw.split(/\r?\n/);
  const lineLimitExceeded = rawLines.length > CODEX_VERSION_PROBE_MAX_LINES;
  const output = byteBounded.split(/\r?\n/).slice(0, CODEX_VERSION_PROBE_MAX_LINES).join("\n");
  return { output, truncated, lineLimitExceeded };
}

export function probeInstalledCodexVersionDetailed(
  spawnImpl: SpawnSyncLike = spawnSync,
): CodexVersionProbeResult {
  if (spawnImpl === spawnSync && cachedDetailedVersionResult !== undefined) {
    return cachedDetailedVersionResult;
  }
  const result = spawnImpl("codex", ["--version"], {
    encoding: "utf-8",
    killSignal: "SIGKILL",
    timeout: CODEX_FEATURE_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  let probeResult: CodexVersionProbeResult;
  if (errorCode === "ETIMEDOUT" || result.signal) {
    probeResult = { status: "timeout" };
  } else if (result.error) {
    probeResult = { status: "start-unavailable" };
  } else if (result.status !== 0) {
    probeResult = { status: "exit-failure" };
  } else {
    probeResult = {
      status: "ok",
      collected: collectBoundedVersionOutput(
        typeof result.stdout === "string" ? result.stdout : "",
        typeof result.stderr === "string" ? result.stderr : "",
      ),
    };
  }
  if (spawnImpl === spawnSync) cachedDetailedVersionResult = probeResult;
  return probeResult;
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
  pluginHookSurface: CodexPluginHookSurface;
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
    pluginHookSurface: resolveCodexPluginHookSurface({ featuresListOutput }),
  };
}

export function resolveCodexHookFeatureFlagForCli(
  options: CodexFeatureProbeOptions = {},
): CodexHookFeatureFlag {
  return resolveCodexHookFeatureSupportForCli(options).hookFeatureFlag;
}
