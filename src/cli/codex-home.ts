import { join } from "path";
import { codexConfigPath } from "../utils/paths.js";
import {
	readPersistedSetupPreferencesSync,
	readPersistedSetupScopeSync,
} from "./setup-preferences.js";

export const readPersistedSetupPreferences = readPersistedSetupPreferencesSync;
export const readPersistedSetupScope = readPersistedSetupScopeSync;

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
