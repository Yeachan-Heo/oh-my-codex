import { join } from "path";
import { codexConfigPath } from "../utils/paths.js";
import {
	readPersistedSetupPreferencesSync,
	readPersistedSetupScopeSync,
	resolveNearestPersistedSetupScopeSync,
} from "./setup-preferences.js";

export const readPersistedSetupPreferences = readPersistedSetupPreferencesSync;
export const readPersistedSetupScope = readPersistedSetupScopeSync;

export function resolveProjectLocalCodexHomeForLaunch(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (env.CODEX_HOME && env.CODEX_HOME.trim() !== "") return undefined;
	// Walk upward so a project-scoped setup is honored from any directory
	// inside its tree — launching from a subdirectory must not fall through
	// to the user config (issue #3447).
	const nearest = resolveNearestPersistedSetupScopeSync(cwd);
	if (nearest?.scope === "project") {
		return join(nearest.projectRoot, ".codex");
	}
	return undefined;
}

export function resolveCodexHomeForLaunch(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (env.CODEX_HOME && env.CODEX_HOME.trim() !== "") return env.CODEX_HOME;
	return resolveProjectLocalCodexHomeForLaunch(cwd, env);
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

/**
 * Decide what CODEX_HOME, if any, should be exported into a child team
 * worker's environment (issue #3629).
 *
 * - An explicit CODEX_HOME from the caller is authoritative and is passed
 *   through unchanged.
 * - A project-scope home derived from <project>/.codex is NOT exported.
 *   Exporting it makes the worker's own launch treat it as an explicit
 *   CODEX_HOME with no credentials (401) and disables the worker's project
 *   scope resolution. Leaving it unset lets the worker's `omx` process
 *   resolve project scope and seed credential provenance itself, exactly
 *   like a leader launch.
 */
export function resolveCodexHomeForChildExport(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (env.CODEX_HOME && env.CODEX_HOME.trim() !== "") return env.CODEX_HOME;
	const explicit = resolveCodexHomeForLaunch(cwd, env);
	if (!explicit) return undefined;
	if (resolveProjectLocalCodexHomeForLaunch(cwd, env)) return undefined;
	return explicit;
}
