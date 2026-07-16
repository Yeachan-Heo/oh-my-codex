import { existsSync, readFileSync } from "fs";
import { readFile } from "fs/promises";
import { mkdir, rename, rm, writeFile } from "fs/promises";
import { join } from "path";
import {
	isSetupTeamMode,
	type SetupTeamMode,
} from "../config/team-mode.js";

export const SETUP_SCOPES = ["user", "project"] as const;
export type SetupScope = (typeof SETUP_SCOPES)[number];

export const SETUP_INSTALL_MODES = ["legacy", "plugin"] as const;
export type SetupInstallMode = (typeof SETUP_INSTALL_MODES)[number];

export const SETUP_MCP_MODES = ["none", "compat"] as const;
export type SetupMcpMode = (typeof SETUP_MCP_MODES)[number];

export interface PersistedSetupScope {
	scope: SetupScope;
	installMode?: SetupInstallMode;
	mcpMode?: SetupMcpMode;
	teamMode?: SetupTeamMode;
	mergeAgents?: boolean;
}

export type PartialPersistedSetupScope = Partial<PersistedSetupScope>;

const LEGACY_SCOPE_MIGRATION: Record<string, SetupScope> = {
	"project-local": "project",
};

export function isSetupScope(value: string): value is SetupScope {
	return SETUP_SCOPES.includes(value as SetupScope);
}

export function isSetupInstallMode(value: string): value is SetupInstallMode {
	return SETUP_INSTALL_MODES.includes(value as SetupInstallMode);
}

export function isSetupMcpMode(value: string): value is SetupMcpMode {
	return SETUP_MCP_MODES.includes(value as SetupMcpMode);
}

export function getSetupScopeFilePath(projectRoot: string): string {
	return join(projectRoot, ".omx", "setup-scope.json");
}

export function resolvePersistedSetupMergeAgents(
	preferences: PartialPersistedSetupScope | undefined,
	scope: SetupScope,
): boolean | undefined {
	return preferences?.scope === scope && typeof preferences.mergeAgents === "boolean"
		? preferences.mergeAgents
		: undefined;
}

export interface WritePersistedSetupPreferencesDependencies {
	mkdir?: typeof mkdir;
	writeFile?: typeof writeFile;
	rename?: typeof rename;
	rm?: typeof rm;
	createTempName?: () => string;
}

export async function writePersistedSetupPreferences(
	projectRoot: string,
	preferences: PersistedSetupScope,
	dependencies: WritePersistedSetupPreferencesDependencies = {},
): Promise<void> {
	const scopePath = getSetupScopeFilePath(projectRoot);
	const directory = join(projectRoot, ".omx");
	const tempPath = join(
		directory,
		`.setup-scope-${dependencies.createTempName?.() ?? `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`}.tmp`,
	);
	const mkdirFn = dependencies.mkdir ?? mkdir;
	const writeFileFn = dependencies.writeFile ?? writeFile;
	const renameFn = dependencies.rename ?? rename;
	const rmFn = dependencies.rm ?? rm;
	try {
		await mkdirFn(directory, { recursive: true });
		await writeFileFn(tempPath, JSON.stringify(preferences, null, 2) + "\n");
		await renameFn(tempPath, scopePath);
	} catch (error) {
		try {
			await rmFn(tempPath, { force: true });
		} catch {
			// Preserve the original persistence error.
		}
		throw error;
	}
}

function parsePersistedSetupPreferences(
	raw: string,
	onLegacyScope?: (from: string, to: SetupScope) => void,
): PartialPersistedSetupScope | undefined {
	const parsed = JSON.parse(raw) as Partial<{
		scope: unknown;
		installMode: unknown;
		mcpMode: unknown;
		teamMode: unknown;
		mergeAgents: unknown;
	}>;
	const persisted: PartialPersistedSetupScope = {};

	if (typeof parsed.scope === "string") {
		if (isSetupScope(parsed.scope)) {
			persisted.scope = parsed.scope;
		}
		const migrated = LEGACY_SCOPE_MIGRATION[parsed.scope];
		if (migrated) {
			onLegacyScope?.(parsed.scope, migrated);
			persisted.scope = migrated;
		}
	}

	if (
		typeof parsed.installMode === "string" &&
		isSetupInstallMode(parsed.installMode)
	) {
		persisted.installMode = parsed.installMode;
	}

	if (typeof parsed.mcpMode === "string" && isSetupMcpMode(parsed.mcpMode)) {
		persisted.mcpMode = parsed.mcpMode;
	}

	if (typeof parsed.teamMode === "string" && isSetupTeamMode(parsed.teamMode)) {
		persisted.teamMode = parsed.teamMode;
	}

	if (persisted.scope && typeof parsed.mergeAgents === "boolean") {
		persisted.mergeAgents = parsed.mergeAgents;
	}

	return Object.keys(persisted).length > 0 ? persisted : undefined;
}

export async function readPersistedSetupPreferences(
	projectRoot: string,
	options: { warnOnLegacyScope?: boolean } = {},
): Promise<PartialPersistedSetupScope | undefined> {
	const scopePath = getSetupScopeFilePath(projectRoot);
	if (!existsSync(scopePath)) return undefined;
	try {
		const raw = await readFile(scopePath, "utf-8");
		return parsePersistedSetupPreferences(
			raw,
			options.warnOnLegacyScope
				? (from, to) => {
						console.warn(
							`[omx] Migrating persisted setup scope "${from}" → "${to}" ` +
								`(see issue #243: simplified to user/project).`,
						);
					}
				: undefined,
		);
	} catch {
		return undefined;
	}
}

export function readPersistedSetupPreferencesSync(
	projectRoot: string,
	options: { warnOnError?: boolean } = {},
): PartialPersistedSetupScope | undefined {
	const scopePath = getSetupScopeFilePath(projectRoot);
	if (!existsSync(scopePath)) return undefined;
	try {
		return parsePersistedSetupPreferences(readFileSync(scopePath, "utf-8"));
	} catch (err) {
		if (options.warnOnError) {
			process.stderr.write(`[cli/codex-home] operation failed: ${err}\n`);
		}
	}
	return undefined;
}

export function readPersistedSetupScopeSync(
	projectRoot: string,
): SetupScope | undefined {
	return readPersistedSetupPreferencesSync(projectRoot)?.scope;
}
