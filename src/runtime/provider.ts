import { join } from "path";

export type RuntimeProvider = "codex" | "cursor";

export const OMX_RUNTIME_PROVIDER_ENV = "OMX_RUNTIME_PROVIDER";
export const OMX_PROVIDER_ENV = "OMX_PROVIDER";
export const CODEX_HOME_ENV = "CODEX_HOME";
export const CURSOR_HOME_ENV = "CURSOR_HOME";

function normalizeProviderName(raw: string | undefined): RuntimeProvider | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "codex" || value === "cursor") return value;
  return null;
}

export function resolveRuntimeProvider(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeProvider {
  return (
    normalizeProviderName(env[OMX_RUNTIME_PROVIDER_ENV]) ??
    normalizeProviderName(env[OMX_PROVIDER_ENV]) ??
    "codex"
  );
}

export function resolveRuntimeCommand(provider: RuntimeProvider): string {
  return provider === "cursor" ? "agent" : "codex";
}

export function resolveRuntimeLeadingArgs(provider: RuntimeProvider): string[] {
  return [];
}

export function resolveRuntimeHomeEnvVar(provider: RuntimeProvider): string {
  return provider === "cursor" ? CURSOR_HOME_ENV : CODEX_HOME_ENV;
}

export function resolveProjectRuntimeHome(
  provider: RuntimeProvider,
  cwd: string,
): string {
  return join(cwd, provider === "cursor" ? ".cursor" : ".codex");
}
