import type { FileHandle } from "fs/promises";

export type RegularFileSyncOutcome = "synced" | "unsupported-windows-eperm";

export type DurabilityWarningSubsystem =
	| "session pointer start/reconcile"
	| "session pointer end"
	| "native-hook setup"
	| "native-hook uninstall"
	| "native-hook claim-journal recovery";

export interface RegularFileDurabilityTracker {
	degraded: boolean;
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
 * Windows does not support fsync for directory handles and reports EPERM.
 * Preserve every other platform/error pair as fatal.
 */
export async function syncDirectoryHandle(
	handle: Pick<FileHandle, "sync">,
	platform: NodeJS.Platform = process.platform,
): Promise<void> {
	try {
		await handle.sync();
	} catch (error) {
		if (!isUnsupportedWindowsSync(error, platform)) throw error;
	}
}

export function recordRegularFileSyncOutcome(
	tracker: RegularFileDurabilityTracker,
	outcome: RegularFileSyncOutcome,
): void {
	tracker.degraded ||= outcome === "unsupported-windows-eperm";
}

export function emitDegradedDurabilityWarning(
	subsystem: DurabilityWarningSubsystem,
	tracker: RegularFileDurabilityTracker,
): void {
	if (!tracker.degraded) return;
	try {
		process.stderr.write(
			`[omx] warning: Windows EPERM regular-file fsync unsupported in ${subsystem}; operation succeeded with degraded durability.\n`,
		);
	} catch {
		// Diagnostics must not fail an already committed transaction.
	}
}
