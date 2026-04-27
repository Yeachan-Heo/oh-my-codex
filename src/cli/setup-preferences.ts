import { existsSync, readFileSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

export const SETUP_SCOPES = ["user", "project"] as const;
export type SetupScope = (typeof SETUP_SCOPES)[number];

export const SETUP_INSTALL_MODES = ["legacy", "plugin"] as const;
export type SetupInstallMode = (typeof SETUP_INSTALL_MODES)[number];

export interface PersistedSetupScope {
	scope: SetupScope;
	installMode?: SetupInstallMode;
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

export function getSetupScopeFilePath(projectRoot: string): string {
	return join(projectRoot, ".omx", "setup-scope.json");
}

function parsePersistedSetupPreferences(
	raw: string,
	onLegacyScope?: (from: string, to: SetupScope) => void,
): PartialPersistedSetupScope | undefined {
	const parsed = JSON.parse(raw) as Partial<{
		scope: unknown;
		installMode: unknown;
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
