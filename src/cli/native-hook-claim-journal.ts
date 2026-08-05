import { createHash } from "crypto";
import { constants } from "fs";
import {
	copyFile,
	link,
	open,
	lstat,
	mkdir,
	rm,
	type FileHandle,
} from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import {
	recordDirectorySyncOutcome,
	syncDirectory,
	syncRegularFile,
	type DirectorySyncOutcome,
	type RegularFileDurabilityTracker,
	type RegularFileSyncOutcome,
} from "../utils/file-durability.js";

export interface NativeHookClaimJournalDurability {
	platform: NodeJS.Platform;
	syncRegularFile(
		handle: Pick<FileHandle, "sync">,
	): Promise<RegularFileSyncOutcome>;
	syncDirectory(path: string): Promise<DirectorySyncOutcome>;
	linkFile?(existingPath: string, newPath: string): Promise<void>;
	copyFileExclusive?(
		sourcePath: string,
		destinationPath: string,
	): Promise<void>;
	openFileForRead?(path: string): Promise<FileHandle>;
}

interface ClaimJournalEntry {
	version: 1;
	ownerPid: number;
	canonicalPath: string;
	claimPath: string;
	beforeHash: string;
	afterHash: string | null;
}

function digest(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

function assertControlledPath(root: string, path: string): void {
	const rel = relative(root, path);
	if (
		isAbsolute(rel) ||
		rel === ".." ||
		rel.startsWith(`..${sep}`) ||
		rel === ""
	) {
		throw new Error(
			`Native hook claim journal path is outside controlled root: ${path}`,
		);
	}
}

interface ControlledAncestor {
	path: string;
	dev: number;
	ino: number;
}

async function captureControlledAncestors(
	root: string,
	paths: string[],
): Promise<ControlledAncestor[]> {
	const resolvedRoot = resolve(root);
	const ancestors = new Set<string>([resolvedRoot]);
	for (const path of paths) {
		assertControlledPath(resolvedRoot, resolve(path));
		let current = dirname(resolve(path));
		while (true) {
			ancestors.add(current);
			if (current === resolvedRoot) break;
			const parent = dirname(current);
			if (parent === current) {
				throw new Error(
					`Native hook claim journal path is outside controlled root: ${path}`,
				);
			}
			current = parent;
		}
	}
	const snapshot: ControlledAncestor[] = [];
	for (const path of ancestors) {
		const stat = await lstat(path);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`Native hook claim journal ancestor is unsafe: ${path}`);
		}
		snapshot.push({ path, dev: stat.dev, ino: stat.ino });
	}
	return snapshot;
}

async function assertControlledAncestorsUnchanged(
	snapshot: ControlledAncestor[],
): Promise<void> {
	for (const expected of snapshot) {
		const stat = await lstat(expected.path);
		if (
			stat.isSymbolicLink() ||
			!stat.isDirectory() ||
			stat.dev !== expected.dev ||
			stat.ino !== expected.ino
		) {
			throw new Error(
				`Native hook claim journal ancestor changed: ${expected.path}`,
			);
		}
	}
}

function sameFileIdentity(
	left: { dev: number; ino: number },
	right: { dev: number; ino: number },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: unknown }).code === "EPERM"
		);
	}
}

async function fsyncDirectory(
	path: string,
	platform: NodeJS.Platform,
): Promise<DirectorySyncOutcome> {
	const handle = await open(path, "r");
	try {
		return await syncDirectory(handle, platform);
	} finally {
		await handle.close();
	}
}

export function createNativeHookClaimJournalDurability(
	platform: NodeJS.Platform = process.platform,
	tracker?: RegularFileDurabilityTracker,
): NativeHookClaimJournalDurability {
	return {
		platform,
		syncRegularFile: (handle) => syncRegularFile(handle, platform),
		async syncDirectory(path) {
			const outcome = await fsyncDirectory(path, platform);
			if (tracker) recordDirectorySyncOutcome(tracker, outcome);
			return outcome;
		},
	};
}

export async function syncNativeHookClaimParent(
	path: string,
	durability: NativeHookClaimJournalDurability,
): Promise<DirectorySyncOutcome> {
	return durability.syncDirectory(dirname(path));
}

export async function restoreNativeHookClaimNoClobber(
	claimPath: string,
	destinationPath: string,
	durability: NativeHookClaimJournalDurability,
	validateControlledPaths: () => Promise<void> = async () => undefined,
): Promise<RegularFileSyncOutcome> {
	await validateControlledPaths();
	const originalClaimHandle = await open(claimPath, "r");
	try {
		const claimStat = await originalClaimHandle.stat();
		if (!claimStat.isFile() || claimStat.nlink !== 1) {
			throw new Error(
				`Native hook claim restore refuses unsafe claim ${claimPath}.`,
			);
		}
		const claimBytes = await originalClaimHandle.readFile();
		const claimStatAfterRead = await originalClaimHandle.stat();
		if (
			!sameFileIdentity(claimStat, claimStatAfterRead) ||
			claimStatAfterRead.nlink !== 1
		) {
			throw new Error(
				`Native hook claim changed during restore: ${claimPath}.`,
			);
		}
		await validateControlledPaths();
		const claimPathStat = await lstat(claimPath);
		if (
			claimPathStat.isSymbolicLink() ||
			!claimPathStat.isFile() ||
			claimPathStat.nlink !== 1 ||
			!sameFileIdentity(claimStat, claimPathStat)
		) {
			throw new Error(
				`Native hook claim changed during restore: ${claimPath}.`,
			);
		}
		let linked = false;
		try {
			await (durability.linkFile ?? link)(claimPath, destinationPath);
			linked = true;
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? (error as { code?: unknown }).code
					: undefined;
			if (
				code !== "EPERM" &&
				code !== "ENOTSUP" &&
				code !== "EOPNOTSUPP" &&
				code !== "EXDEV"
			) {
				throw error;
			}
			try {
				await (
					durability.copyFileExclusive ??
					((sourcePath, targetPath) =>
						copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL))
				)(claimPath, destinationPath);
			} catch (copyError) {
				throw copyError;
			}
		}
		let destinationHandle: FileHandle;
		try {
			destinationHandle = await open(destinationPath, "r");
		} catch (error) {
			throw error;
		}
		let outcome: RegularFileSyncOutcome;
		try {
			outcome = await durability.syncRegularFile(destinationHandle);
			await durability.syncDirectory(dirname(destinationPath));
			await validateControlledPaths();

			const currentClaimHandle = await open(claimPath, "r");
			try {
				const expectedLinks = linked ? 2 : 1;
				const currentClaimStat = await currentClaimHandle.stat();
				const destinationHandleStat = await destinationHandle.stat();
				const currentClaimPathStat = await lstat(claimPath);
				const destinationPathStat = await lstat(destinationPath);
				if (
					!currentClaimStat.isFile() ||
					!destinationHandleStat.isFile() ||
					currentClaimPathStat.isSymbolicLink() ||
					!currentClaimPathStat.isFile() ||
					destinationPathStat.isSymbolicLink() ||
					!destinationPathStat.isFile() ||
					currentClaimStat.nlink !== expectedLinks ||
					destinationHandleStat.nlink !== expectedLinks ||
					currentClaimPathStat.nlink !== expectedLinks ||
					destinationPathStat.nlink !== expectedLinks ||
					!sameFileIdentity(currentClaimStat, claimStat) ||
					!sameFileIdentity(currentClaimStat, currentClaimPathStat) ||
					!sameFileIdentity(destinationHandleStat, destinationPathStat) ||
					(linked && !sameFileIdentity(currentClaimStat, destinationHandleStat))
				) {
					throw new Error(
						`Native hook claim changed during restore: ${claimPath}.`,
					);
				}
				const [currentClaimBytes, destinationBytes] = await Promise.all([
					currentClaimHandle.readFile(),
					destinationHandle.readFile(),
				]);
				const currentClaimStatAfterRead = await currentClaimHandle.stat();
				const destinationStatAfterRead = await destinationHandle.stat();
				if (
					!currentClaimBytes.equals(claimBytes) ||
					!destinationBytes.equals(claimBytes) ||
					currentClaimStatAfterRead.nlink !== expectedLinks ||
					destinationStatAfterRead.nlink !== expectedLinks ||
					!sameFileIdentity(currentClaimStat, currentClaimStatAfterRead) ||
					!sameFileIdentity(destinationHandleStat, destinationStatAfterRead)
				) {
					throw new Error(
						`Native hook claim changed during restore: ${claimPath}.`,
					);
				}
				await validateControlledPaths();
				const claimBeforeRemove = await lstat(claimPath);
				if (
					claimBeforeRemove.isSymbolicLink() ||
					!claimBeforeRemove.isFile() ||
					claimBeforeRemove.nlink !== expectedLinks ||
					!sameFileIdentity(currentClaimStat, claimBeforeRemove)
				) {
					throw new Error(
						`Native hook claim changed during restore: ${claimPath}.`,
					);
				}
			} finally {
				await currentClaimHandle.close();
			}
			await rm(claimPath);
			await durability.syncDirectory(dirname(claimPath));
			return outcome;
		} finally {
			await destinationHandle.close();
		}
	} finally {
		await originalClaimHandle.close();
	}
}

interface RegularArtifact {
	bytes: Buffer;
	dev: number;
	ino: number;
}

async function readRegularArtifact(
	path: string,
	validateControlledPaths: () => Promise<void>,
	expectedLinks = 1,
	openFileForRead: (path: string) => Promise<FileHandle> = (targetPath) =>
		open(targetPath, "r"),
): Promise<RegularArtifact | null> {
	await validateControlledPaths();
	let handle: FileHandle;
	try {
		handle = await openFileForRead(path);
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
	try {
		const stat = await handle.stat();
		const pathStat = await lstat(path);
		if (
			!stat.isFile() ||
			stat.nlink !== expectedLinks ||
			pathStat.isSymbolicLink() ||
			!pathStat.isFile() ||
			pathStat.nlink !== expectedLinks ||
			!sameFileIdentity(stat, pathStat)
		) {
			throw new Error(
				`Native hook claim journal refuses unsafe artifact ${path}.`,
			);
		}
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (!sameFileIdentity(stat, after) || after.nlink !== expectedLinks) {
			throw new Error(
				`Native hook claim journal artifact changed while reading: ${path}.`,
			);
		}
		return { bytes, dev: stat.dev, ino: stat.ino };
	} finally {
		await handle.close();
	}
}

async function assertArtifactStillOwned(
	path: string,
	artifact: RegularArtifact,
): Promise<void> {
	const stat = await lstat(path);
	if (
		stat.isSymbolicLink() ||
		!stat.isFile() ||
		stat.nlink !== 1 ||
		!sameFileIdentity(stat, artifact)
	) {
		throw new Error(
			`Native hook claim journal artifact changed before removal: ${path}.`,
		);
	}
}

function journalPath(root: string): string {
	return join(root, ".omx", "native-hook-claim-journal.json");
}

export async function persistNativeHookClaimJournal(
	root: string,
	entry: Omit<
		ClaimJournalEntry,
		"version" | "ownerPid" | "beforeHash" | "afterHash"
	> & {
		before: Buffer;
		after: Buffer | null;
	},
	durability: NativeHookClaimJournalDurability,
): Promise<RegularFileSyncOutcome> {
	assertControlledPath(root, entry.canonicalPath);
	assertControlledPath(root, entry.claimPath);
	const artifactAncestors = await captureControlledAncestors(root, [
		entry.canonicalPath,
		entry.claimPath,
	]);
	const directory = dirname(journalPath(root));
	let directoryCreated = false;
	try {
		await lstat(directory);
	} catch (error) {
		if (!isMissing(error)) throw error;
		directoryCreated = true;
	}
	await mkdir(directory, { recursive: true });
	await assertControlledAncestorsUnchanged(artifactAncestors);
	const directoryStat = await lstat(directory);
	if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
		throw new Error(
			`Native hook claim journal directory is unsafe: ${directory}`,
		);
	}
	if (directoryCreated) await durability.syncDirectory(dirname(directory));
	const path = journalPath(root);
	const journalAncestors = await captureControlledAncestors(root, [path]);
	await assertControlledAncestorsUnchanged(journalAncestors);
	const payload: ClaimJournalEntry = {
		version: 1,
		ownerPid: process.pid,
		canonicalPath: entry.canonicalPath,
		claimPath: entry.claimPath,
		beforeHash: digest(entry.before),
		afterHash: entry.after === null ? null : digest(entry.after),
	};
	const handle = await open(path, "wx", 0o600);
	let outcome: RegularFileSyncOutcome;
	try {
		await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf-8");
		outcome = await durability.syncRegularFile(handle);
	} catch (error) {
		await handle.close();
		await rm(path, { force: true });
		throw error;
	}
	await handle.close();
	await durability.syncDirectory(directory);
	return outcome;
}

export async function clearNativeHookClaimJournal(
	root: string,
	durability: NativeHookClaimJournalDurability,
	expectedJournal?: RegularArtifact,
): Promise<void> {
	const path = journalPath(root);
	try {
		const ancestors = await captureControlledAncestors(root, [path]);
		await assertControlledAncestorsUnchanged(ancestors);
		if (expectedJournal) await assertArtifactStillOwned(path, expectedJournal);
		await rm(path);
		await durability.syncDirectory(dirname(path));
	} catch (error) {
		if (expectedJournal || !isMissing(error)) throw error;
	}
}

export async function recoverNativeHookClaimJournal(
	root: string,
	durability: NativeHookClaimJournalDurability,
): Promise<{ recovered: boolean; outcome: RegularFileSyncOutcome }> {
	const path = journalPath(root);
	let parsed: ClaimJournalEntry;
	let journal: RegularArtifact;
	const openFileForRead =
		durability.openFileForRead ??
		((targetPath: string) => open(targetPath, "r"));
	let journalAncestors: ControlledAncestor[];
	try {
		journalAncestors = await captureControlledAncestors(root, [path]);
	} catch (error) {
		if (isMissing(error)) return { recovered: false, outcome: "synced" };
		throw error;
	}
	const artifact = await readRegularArtifact(
		path,
		() => assertControlledAncestorsUnchanged(journalAncestors),
		1,
		openFileForRead,
	);
	if (artifact === null) return { recovered: false, outcome: "synced" };
	journal = artifact;
	parsed = JSON.parse(journal.bytes.toString("utf-8")) as ClaimJournalEntry;
	if (
		parsed.version !== 1 ||
		!Number.isSafeInteger(parsed.ownerPid) ||
		typeof parsed.canonicalPath !== "string" ||
		typeof parsed.claimPath !== "string" ||
		typeof parsed.beforeHash !== "string" ||
		!(typeof parsed.afterHash === "string" || parsed.afterHash === null)
	) {
		throw new Error(`Native hook claim journal is malformed: ${path}`);
	}
	assertControlledPath(root, parsed.canonicalPath);
	assertControlledPath(root, parsed.claimPath);
	const artifactAncestors = await captureControlledAncestors(root, [
		parsed.canonicalPath,
		parsed.claimPath,
	]);
	const validateArtifactPaths = () =>
		assertControlledAncestorsUnchanged(artifactAncestors);
	if (processIsAlive(parsed.ownerPid)) {
		throw new Error(
			"Native hook claim journal belongs to a live mutation; recovery refused to mutate it.",
		);
	}
	let outcome: RegularFileSyncOutcome = "synced";
	try {
		await validateArtifactPaths();
		const canonicalStat = await lstat(parsed.canonicalPath);
		const claimStat = await lstat(parsed.claimPath);
		if (
			!canonicalStat.isSymbolicLink() &&
			canonicalStat.isFile() &&
			canonicalStat.nlink === 2 &&
			!claimStat.isSymbolicLink() &&
			claimStat.isFile() &&
			claimStat.nlink === 2 &&
			canonicalStat.dev === claimStat.dev &&
			canonicalStat.ino === claimStat.ino
		) {
			const canonical = await readRegularArtifact(
				parsed.canonicalPath,
				validateArtifactPaths,
				2,
				openFileForRead,
			);
			const claim = await readRegularArtifact(
				parsed.claimPath,
				validateArtifactPaths,
				2,
				openFileForRead,
			);
			if (
				canonical === null ||
				claim === null ||
				!sameFileIdentity(canonical, claim) ||
				digest(canonical.bytes) !== parsed.beforeHash ||
				!canonical.bytes.equals(claim.bytes)
			) {
				throw new Error(
					"Native hook claim journal cannot finalize a linked restore with changed bytes.",
				);
			}
			await validateArtifactPaths();
			const claimBeforeRemove = await lstat(parsed.claimPath);
			if (
				claimBeforeRemove.isSymbolicLink() ||
				!claimBeforeRemove.isFile() ||
				claimBeforeRemove.nlink !== 2 ||
				!sameFileIdentity(claimBeforeRemove, claim)
			) {
				throw new Error(
					"Native hook claim journal claim changed before finalization.",
				);
			}
			await rm(parsed.claimPath);
			await durability.syncDirectory(dirname(parsed.claimPath));
			await clearNativeHookClaimJournal(root, durability, journal);
			return { recovered: true, outcome };
		}
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	const canonical = await readRegularArtifact(
		parsed.canonicalPath,
		validateArtifactPaths,
		1,
		openFileForRead,
	);
	const claim = await readRegularArtifact(
		parsed.claimPath,
		validateArtifactPaths,
		1,
		openFileForRead,
	);
	if (claim === null) {
		if (canonical === null && parsed.afterHash === null) {
			await clearNativeHookClaimJournal(root, durability, journal);
			return { recovered: true, outcome };
		}
		if (
			canonical !== null &&
			parsed.afterHash !== null &&
			digest(canonical.bytes) === parsed.afterHash
		) {
			await clearNativeHookClaimJournal(root, durability, journal);
			return { recovered: true, outcome };
		}
		if (canonical !== null && digest(canonical.bytes) === parsed.beforeHash) {
			await clearNativeHookClaimJournal(root, durability, journal);
			return { recovered: true, outcome };
		}
		throw new Error(
			"Native hook claim journal cannot recover: claim is missing and canonical bytes are not the recorded original.",
		);
	}
	if (digest(claim.bytes) !== parsed.beforeHash) {
		throw new Error(
			"Native hook claim journal cannot recover: claim bytes do not match recorded ownership.",
		);
	}
	if (canonical === null) {
		outcome = await restoreNativeHookClaimNoClobber(
			parsed.claimPath,
			parsed.canonicalPath,
			durability,
			validateArtifactPaths,
		);
		await clearNativeHookClaimJournal(root, durability, journal);
		return { recovered: true, outcome };
	}
	if (
		parsed.afterHash !== null &&
		digest(canonical.bytes) === parsed.afterHash
	) {
		await validateArtifactPaths();
		await assertArtifactStillOwned(parsed.claimPath, claim);
		await rm(parsed.claimPath);
		await durability.syncDirectory(dirname(parsed.claimPath));
		await clearNativeHookClaimJournal(root, durability, journal);
		return { recovered: true, outcome };
	}
	throw new Error(
		"Native hook claim journal cannot recover without overwriting unrecognized canonical content.",
	);
}
