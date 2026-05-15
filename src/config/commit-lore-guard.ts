import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "@iarna/toml";

export const OMX_LORE_COMMIT_GUARD_ENV = "OMX_LORE_COMMIT_GUARD";

const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

interface LoreCommitGuardCodexConfig {
	env?: Record<string, unknown>;
	shell_environment_policy?: {
		set?: Record<string, unknown>;
	};
}

function normalizeConfiguredValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

function resolveCodexConfigPath(
	env: NodeJS.ProcessEnv = process.env,
	codexHomeOverride?: string,
): string {
	const explicitCodexHome = normalizeConfiguredValue(codexHomeOverride);
	if (explicitCodexHome) return join(explicitCodexHome, "config.toml");

	const envCodexHome = normalizeConfiguredValue(env.CODEX_HOME);
	if (envCodexHome) return join(envCodexHome, "config.toml");

	return join(homedir(), ".codex", "config.toml");
}

export function readConfiguredLoreCommitGuardValue(
	env: NodeJS.ProcessEnv = process.env,
	codexHomeOverride?: string,
): string | undefined {
	const configPath = resolveCodexConfigPath(env, codexHomeOverride);
	if (!existsSync(configPath)) return undefined;

	try {
		const raw = parseToml(readFileSync(configPath, "utf-8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

		const parsed = raw as LoreCommitGuardCodexConfig;
		return normalizeConfiguredValue(
			parsed.shell_environment_policy?.set?.[OMX_LORE_COMMIT_GUARD_ENV] ??
				parsed.env?.[OMX_LORE_COMMIT_GUARD_ENV],
		);
	} catch {
		return undefined;
	}
}

export function buildLoreCommitGuardEnvWithConfigFallback(
	env: NodeJS.ProcessEnv = process.env,
	codexHomeOverride?: string,
): NodeJS.ProcessEnv {
	if (typeof env[OMX_LORE_COMMIT_GUARD_ENV] === "string") return env;

	const configuredValue = readConfiguredLoreCommitGuardValue(
		env,
		codexHomeOverride,
	);
	if (!configuredValue) return env;

	return {
		...env,
		[OMX_LORE_COMMIT_GUARD_ENV]: configuredValue,
	};
}

export function isLoreCommitGuardEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const raw = env[OMX_LORE_COMMIT_GUARD_ENV];
	if (typeof raw !== "string") return true;
	return !DISABLED_VALUES.has(raw.trim().toLowerCase());
}
