import type { FileHandle } from "fs/promises";

export type RegularFileSyncOutcome = "synced" | "unsupported-windows-eperm";
export type DirectorySyncOutcome = "synced" | "unsupported-windows-eperm";

export type DurabilityWarningSubsystem =
	| "session pointer start/reconcile"
	| "session pointer end"
	| "native-hook setup"
	| "native-hook uninstall"
	| "native-hook claim-journal recovery";

export interface RegularFileDurabilityTracker {
	degraded: boolean;
	regularFileDegraded?: boolean;
	directoryDegraded?: boolean;
}

function isUnsupportedWindowsSync(
	error: unknown,
	platform: NodeJS.Platform,
): boolean {
	return platform === "win32"
		&& typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as { code?: unknown }).code === "EPERM";
}

/**
 * Windows can report EPERM when fsync is unsupported for an otherwise valid
 * regular-file handle. Only that platform/error pair is a durability
 * capability limitation; every other failure remains fatal.
 */

export async function syncRegularFile(
	handle: Pick<FileHandle, "sync">,
	platform: NodeJS.Platform = process.platform,
): Promise<RegularFileSyncOutcome> {
	try {
		await handle.sync();
		return "synced";
	} catch (error) {
		if (!isUnsupportedWindowsSync(error, platform)) throw error;
		return "unsupported-windows-eperm";
	}
}

/**
 * Windows can also report EPERM when fsync is unsupported for an otherwise
 * valid directory handle. Keep the capability boundary as narrow as the
 * regular-file fallback: every other platform/error pair remains fatal.
 */
export async function syncDirectory(
	handle: Pick<FileHandle, "sync">,
	platform: NodeJS.Platform = process.platform,
): Promise<DirectorySyncOutcome> {
	try {
		await handle.sync();
		return "synced";
	} catch (error) {
		if (!isUnsupportedWindowsSync(error, platform)) throw error;
		return "unsupported-windows-eperm";
	}
}

export function recordRegularFileSyncOutcome(
	tracker: RegularFileDurabilityTracker,
	outcome: RegularFileSyncOutcome,
): void {
	if (outcome !== "unsupported-windows-eperm") return;
	tracker.degraded = true;
	tracker.regularFileDegraded = true;
}

export function recordDirectorySyncOutcome(
	tracker: RegularFileDurabilityTracker,
	outcome: DirectorySyncOutcome,
): void {
	if (outcome !== "unsupported-windows-eperm") return;
	tracker.degraded = true;
	tracker.directoryDegraded = true;
}

export function emitDegradedDurabilityWarning(
	subsystem: DurabilityWarningSubsystem,
	tracker: RegularFileDurabilityTracker,
): void {
	if (!tracker.degraded) return;
	const target = tracker.directoryDegraded
		? tracker.regularFileDegraded
			? "regular-file and directory fsync"
			: "directory fsync"
		: "regular-file fsync";
	try {
		process.stderr.write(
			`[omx] warning: Windows EPERM ${target} unsupported in ${subsystem}; operation succeeded with degraded durability.\n`,
		);
	} catch {
		// Diagnostics must not fail an already committed transaction.
	}
}
