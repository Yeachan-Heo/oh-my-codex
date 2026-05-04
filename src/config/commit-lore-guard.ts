export const OMX_LORE_COMMIT_GUARD_ENV = "OMX_LORE_COMMIT_GUARD";

const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

export function isLoreCommitGuardEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const raw = env[OMX_LORE_COMMIT_GUARD_ENV];
	if (typeof raw !== "string") return true;
	return !DISABLED_VALUES.has(raw.trim().toLowerCase());
}
