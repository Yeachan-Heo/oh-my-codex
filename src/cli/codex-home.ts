import { join } from "path";
import { codexConfigPath } from "../utils/paths.js";
import {
	readPersistedSetupPreferencesSync,
	readPersistedSetupScopeSync,
	resolveNearestPersistedSetupScopeSync,
} from "./setup-preferences.js";

export const readPersistedSetupPreferences = readPersistedSetupPreferencesSync;
export const readPersistedSetupScope = readPersistedSetupScopeSync;

export function resolvePersistedSetupProjectRoot(
	cwd: string,
): string | undefined {
	return resolveNearestPersistedSetupScopeSync(cwd)?.projectRoot;
}

export function resolvePersistedProjectCodexHome(
	cwd: string,
): string | undefined {
	const nearest = resolveNearestPersistedSetupScopeSync(cwd);
	return nearest?.scope === "project"
		? join(nearest.projectRoot, ".codex")
		: undefined;
}

export function resolveProjectLocalCodexHomeForLaunch(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (env.CODEX_HOME && env.CODEX_HOME.trim() !== "") return undefined;
	// Walk upward so a project-scoped setup is honored from any directory
	// inside its tree — launching from a subdirectory must not fall through
	// to the user config (issue #3447).
	return resolvePersistedProjectCodexHome(cwd);
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
