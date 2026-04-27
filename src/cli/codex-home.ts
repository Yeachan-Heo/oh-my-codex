import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { codexConfigPath } from "../utils/paths.js";
import {
  SETUP_INSTALL_MODES,
  SETUP_SCOPES,
  type SetupInstallMode,
  type SetupScope,
} from "./setup.js";

/**
 * Legacy scope values that may appear in persisted setup-scope.json files.
 * Both 'project-local' (renamed) and old 'project' (minimal, removed) are
 * migrated to the current 'project' scope on read.
 */
const LEGACY_SCOPE_MIGRATION_SYNC: Record<string, SetupScope> = {
  "project-local": "project",
};

export function readPersistedSetupScope(cwd: string): SetupScope | undefined {
  return readPersistedSetupPreferences(cwd)?.scope;
}

export function readPersistedSetupPreferences(
  cwd: string,
): Partial<{ scope: SetupScope; installMode: SetupInstallMode }> | undefined {
  const scopePath = join(cwd, ".omx", "setup-scope.json");
  if (!existsSync(scopePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(scopePath, "utf-8")) as Partial<{
      scope: string;
      installMode: string;
    }>;
    const persisted: Partial<{ scope: SetupScope; installMode: SetupInstallMode }> = {};
    if (typeof parsed.scope === "string") {
      if (SETUP_SCOPES.includes(parsed.scope as SetupScope)) {
        persisted.scope = parsed.scope as SetupScope;
      }
      const migrated = LEGACY_SCOPE_MIGRATION_SYNC[parsed.scope];
      if (migrated) persisted.scope = migrated;
    }
    if (
      typeof parsed.installMode === "string"
      && SETUP_INSTALL_MODES.includes(parsed.installMode as SetupInstallMode)
    ) {
      persisted.installMode = parsed.installMode as SetupInstallMode;
    }
    return Object.keys(persisted).length > 0 ? persisted : undefined;
  } catch (err) {
    process.stderr.write(`[cli/codex-home] operation failed: ${err}\n`);
    // Ignore malformed persisted scope and use defaults.
  }
  return undefined;
}

export function resolveCodexHomeForLaunch(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.CODEX_HOME && env.CODEX_HOME.trim() !== "") return env.CODEX_HOME;
  const persistedScope = readPersistedSetupScope(cwd);
  if (persistedScope === "project") {
    return join(cwd, ".codex");
  }
  return undefined;
}

export function resolveCodexConfigPathForLaunch(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const codexHomeOverride = resolveCodexHomeForLaunch(cwd, env);
  return codexHomeOverride
    ? join(codexHomeOverride, "config.toml")
    : codexConfigPath();
}
