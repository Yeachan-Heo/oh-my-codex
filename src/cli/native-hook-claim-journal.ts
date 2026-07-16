import { createHash } from "crypto";
import { constants } from "fs";
import { copyFile, link, open, lstat, mkdir, readFile, rm, type FileHandle } from "fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "path";
import {
	syncRegularFile,
	type RegularFileSyncOutcome,
} from "../utils/file-durability.js";

export interface NativeHookClaimJournalDurability {
	platform: NodeJS.Platform;
	syncRegularFile(handle: Pick<FileHandle, "sync">): Promise<RegularFileSyncOutcome>;
	syncDirectory(path: string): Promise<void>;
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
	return typeof error === "object" && error !== null && "code" in error &&
		(error as { code?: unknown }).code === "ENOENT";
}

function assertControlledPath(root: string, path: string): void {
	const rel = relative(root, path);
	if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || rel === "") {
		throw new Error(`Native hook claim journal path is outside controlled root: ${path}`);
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error &&
			(error as { code?: unknown }).code === "EPERM";
	}
}

async function fsyncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export function createNativeHookClaimJournalDurability(
	platform: NodeJS.Platform = process.platform,
): NativeHookClaimJournalDurability {
	return {
		platform,
		syncRegularFile: (handle) => syncRegularFile(handle, platform),
		syncDirectory: fsyncDirectory,
	};
}

export async function syncNativeHookClaimParent(
	path: string,
	durability: NativeHookClaimJournalDurability,
): Promise<void> {
	await durability.syncDirectory(dirname(path));
}

export async function restoreNativeHookClaimNoClobber(
	claimPath: string,
	destinationPath: string,
	durability: NativeHookClaimJournalDurability,
): Promise<RegularFileSyncOutcome> {
	const claimStat = await lstat(claimPath);
	if (claimStat.isSymbolicLink() || !claimStat.isFile() || claimStat.nlink !== 1) {
		throw new Error(`Native hook claim restore refuses unsafe claim ${claimPath}.`);
	}
	const claimBytes = await readFile(claimPath);
	let linked = false;
	try {
		await link(claimPath, destinationPath);
		linked = true;
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error
			? (error as { code?: unknown }).code
			: undefined;
		if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EXDEV") {
			throw error;
		}
		await copyFile(claimPath, destinationPath, constants.COPYFILE_EXCL);
	}
	const destinationHandle = await open(destinationPath, "r");
	let outcome: RegularFileSyncOutcome;
	try {
		outcome = await durability.syncRegularFile(destinationHandle);
	} finally {
		await destinationHandle.close();
	}
	await durability.syncDirectory(dirname(destinationPath));
	const [currentClaimStat, currentClaimBytes, destinationBytes, destinationStat] = await Promise.all([
		lstat(claimPath),
		readFile(claimPath),
		readFile(destinationPath),
		lstat(destinationPath),
	]);
	if (
		currentClaimStat.dev !== claimStat.dev ||
		currentClaimStat.ino !== claimStat.ino ||
		!currentClaimBytes.equals(claimBytes) ||
		!destinationBytes.equals(claimBytes) ||
		(linked && (currentClaimStat.dev !== destinationStat.dev || currentClaimStat.ino !== destinationStat.ino))
	) {
		throw new Error(`Native hook claim changed during restore: ${claimPath}.`);
	}
	await rm(claimPath);
	await durability.syncDirectory(dirname(claimPath));
	return outcome;
}

async function readRegularBytes(path: string): Promise<Buffer | null> {
	try {
		const stat = await lstat(path);
		if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
			throw new Error(`Native hook claim journal refuses unsafe artifact ${path}.`);
		}
		return await readFile(path);
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
}

function journalPath(root: string): string {
	return join(root, ".omx", "native-hook-claim-journal.json");
}

export async function persistNativeHookClaimJournal(
	root: string,
	entry: Omit<ClaimJournalEntry, "version" | "ownerPid" | "beforeHash" | "afterHash"> & {
		before: Buffer;
		after: Buffer | null;
	},
	durability: NativeHookClaimJournalDurability,
): Promise<RegularFileSyncOutcome> {
	assertControlledPath(root, entry.canonicalPath);
	assertControlledPath(root, entry.claimPath);
	const directory = dirname(journalPath(root));
	let directoryCreated = false;
	try {
		await lstat(directory);
	} catch (error) {
		if (!isMissing(error)) throw error;
		directoryCreated = true;
	}
	await mkdir(directory, { recursive: true });
	const directoryStat = await lstat(directory);
	if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
		throw new Error(`Native hook claim journal directory is unsafe: ${directory}`);
	}
	if (directoryCreated) await durability.syncDirectory(dirname(directory));
	const path = journalPath(root);
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
): Promise<void> {
	const path = journalPath(root);
	try {
		await rm(path);
		await durability.syncDirectory(dirname(path));
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
}

export async function recoverNativeHookClaimJournal(
	root: string,
	durability: NativeHookClaimJournalDurability,
): Promise<{ recovered: boolean; outcome: RegularFileSyncOutcome }> {
	const path = journalPath(root);
	let parsed: ClaimJournalEntry;
	try {
		const stat = await lstat(path);
		if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
			throw new Error(`Native hook claim journal is unsafe: ${path}`);
		}
		parsed = JSON.parse(await readFile(path, "utf-8")) as ClaimJournalEntry;
	} catch (error) {
		if (isMissing(error)) return { recovered: false, outcome: "synced" };
		throw error;
	}
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
	if (processIsAlive(parsed.ownerPid)) {
		throw new Error("Native hook claim journal belongs to a live mutation; recovery refused to mutate it.");
	}
	let outcome: RegularFileSyncOutcome = "synced";
	try {
		const [canonicalStat, claimStat] = await Promise.all([
			lstat(parsed.canonicalPath),
			lstat(parsed.claimPath),
		]);
		if (
			!canonicalStat.isSymbolicLink() && canonicalStat.isFile() && canonicalStat.nlink === 2 &&
			!claimStat.isSymbolicLink() && claimStat.isFile() && claimStat.nlink === 2 &&
			canonicalStat.dev === claimStat.dev && canonicalStat.ino === claimStat.ino
		) {
			const bytes = await readFile(parsed.canonicalPath);
			if (digest(bytes) !== parsed.beforeHash) {
				throw new Error("Native hook claim journal cannot finalize a linked restore with changed bytes.");
			}
			await rm(parsed.claimPath);
			await durability.syncDirectory(dirname(parsed.claimPath));
			await clearNativeHookClaimJournal(root, durability);
			return { recovered: true, outcome };
		}
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	const [canonical, claim] = await Promise.all([
		readRegularBytes(parsed.canonicalPath),
		readRegularBytes(parsed.claimPath),
	]);
	if (claim === null) {
		if (canonical === null && parsed.afterHash === null) {
			await clearNativeHookClaimJournal(root, durability);
			return { recovered: true, outcome };
		}
		if (canonical !== null && parsed.afterHash !== null && digest(canonical) === parsed.afterHash) {
			await clearNativeHookClaimJournal(root, durability);
			return { recovered: true, outcome };
		}
		if (canonical !== null && digest(canonical) === parsed.beforeHash) {
			await clearNativeHookClaimJournal(root, durability);
			return { recovered: true, outcome };
		}
		throw new Error("Native hook claim journal cannot recover: claim is missing and canonical bytes are not the recorded original.");
	}
	if (digest(claim) !== parsed.beforeHash) {
		throw new Error("Native hook claim journal cannot recover: claim bytes do not match recorded ownership.");
	}
	if (canonical === null) {
		outcome = await restoreNativeHookClaimNoClobber(parsed.claimPath, parsed.canonicalPath, durability);
		await clearNativeHookClaimJournal(root, durability);
		return { recovered: true, outcome };
	}
	if (parsed.afterHash !== null && digest(canonical) === parsed.afterHash) {
		await rm(parsed.claimPath);
		await durability.syncDirectory(dirname(parsed.claimPath));
		await clearNativeHookClaimJournal(root, durability);
		return { recovered: true, outcome };
	}
	throw new Error("Native hook claim journal cannot recover without overwriting unrecognized canonical content.");
}
