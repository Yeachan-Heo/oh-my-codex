import { spawn } from "child_process";
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";

export const STRICT_MEMORY_MODE_ENV = "OMX_STRICT_MEMORY_MODE";
export const STRICT_MEMORY_REFRESH_ON_EXIT_ENV = "OMX_STRICT_MEMORY_REFRESH_ON_EXIT";
export const STRICT_MEMORY_REFRESH_ON_TEAM_COMPLETE_ENV =
  "OMX_STRICT_MEMORY_REFRESH_ON_TEAM_COMPLETE";
export const EXTERNAL_MEMORY_ROOT_ENV = "OMX_EXTERNAL_MEMORY_ROOT";
export const EXTERNAL_MEMORY_REFRESH_SCRIPT_ENV = "OMX_EXTERNAL_MEMORY_REFRESH_SCRIPT";
export const EXTERNAL_MEMORY_REFRESH_PYTHON_ENV = "OMX_EXTERNAL_MEMORY_REFRESH_PYTHON";
export const TEAM_WORKER_ENV = "OMX_TEAM_WORKER";

export interface FormalMemoryRefreshPlan {
  enabled: boolean;
  strictMode: boolean;
  reason: string;
  scriptPath?: string;
  command?: string;
  args?: string[];
  childEnv?: NodeJS.ProcessEnv;
}

export interface FormalMemoryRefreshScheduleResult {
  scheduled: boolean;
  reason: string;
  plan: FormalMemoryRefreshPlan;
}

export interface FormalMemoryRefreshTarget {
  cwd: string;
  source: string;
  enableEnvKeys: readonly string[];
  disabledReason: string;
  sessionId?: string;
  teamName?: string;
  skipTeamWorker?: boolean;
}

export type FormalMemoryRefreshSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    detached: boolean;
    stdio: "ignore";
  },
) => {
  unref?: () => void;
};

function parseOptionalBooleanEnv(value: string | undefined): boolean | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function isRefreshEnabled(
  envKeys: readonly string[],
  env: NodeJS.ProcessEnv,
): boolean {
  return envKeys.some((key) => parseOptionalBooleanEnv(env[key]) === true);
}

export function resolveFormalMemoryRefreshScript(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = env[EXTERNAL_MEMORY_REFRESH_SCRIPT_ENV]?.trim();
  if (explicit) return explicit;

  const memoryRoot = env[EXTERNAL_MEMORY_ROOT_ENV]?.trim();
  if (!memoryRoot) return null;

  const candidate = join(dirname(resolve(memoryRoot)), "scripts", "refresh_memory.py");
  return existsSync(candidate) ? candidate : null;
}

export function resolveFormalMemoryRefreshPlan(
  target: FormalMemoryRefreshTarget,
  env: NodeJS.ProcessEnv = process.env,
): FormalMemoryRefreshPlan {
  const strictMode = parseOptionalBooleanEnv(env[STRICT_MEMORY_MODE_ENV]) === true;
  if (!strictMode) {
    return {
      enabled: false,
      strictMode,
      reason: "strict_mode_disabled",
    };
  }

  if (!isRefreshEnabled(target.enableEnvKeys, env)) {
    return {
      enabled: false,
      strictMode,
      reason: target.disabledReason,
    };
  }

  if (
    target.skipTeamWorker !== false
    && typeof env[TEAM_WORKER_ENV] === "string"
    && env[TEAM_WORKER_ENV].trim() !== ""
  ) {
    return {
      enabled: false,
      strictMode,
      reason: "team_worker_process",
    };
  }

  const scriptPath = resolveFormalMemoryRefreshScript(env);
  if (!scriptPath) {
    return {
      enabled: false,
      strictMode,
      reason: "refresh_script_unavailable",
    };
  }

  const command = env[EXTERNAL_MEMORY_REFRESH_PYTHON_ENV]?.trim() || "python3";
  return {
    enabled: true,
    strictMode,
    reason: "enabled",
    scriptPath,
    command,
    args: [scriptPath, "--workspace-root", target.cwd],
    childEnv: {
      ...process.env,
      ...env,
      OMX_EXTERNAL_MEMORY_REFRESH_SOURCE: target.source,
      ...(target.sessionId
        ? { OMX_EXTERNAL_MEMORY_REFRESH_SESSION_ID: target.sessionId }
        : {}),
      ...(target.teamName
        ? { OMX_EXTERNAL_MEMORY_REFRESH_TEAM_NAME: target.teamName }
        : {}),
    },
  };
}

export function scheduleFormalMemoryRefresh(
  target: FormalMemoryRefreshTarget,
  env: NodeJS.ProcessEnv = process.env,
  spawnImpl: FormalMemoryRefreshSpawn = spawn,
): FormalMemoryRefreshScheduleResult {
  const plan = resolveFormalMemoryRefreshPlan(target, env);
  if (!plan.enabled || !plan.command || !plan.args || !plan.childEnv) {
    return {
      scheduled: false,
      reason: plan.reason,
      plan,
    };
  }

  try {
    const child = spawnImpl(plan.command, plan.args, {
      cwd: target.cwd,
      env: plan.childEnv,
      detached: true,
      stdio: "ignore",
    });
    child.unref?.();
    return {
      scheduled: true,
      reason: "scheduled",
      plan,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      scheduled: false,
      reason: `spawn_failed:${message}`,
      plan,
    };
  }
}
