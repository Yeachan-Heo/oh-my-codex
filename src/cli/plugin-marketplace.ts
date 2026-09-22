import { constants as fsConstants, existsSync, type Stats } from "fs";
import { createHash, randomUUID } from "crypto";
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, type FileHandle } from "fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { OMX_FIRST_PARTY_MCP_SERVER_NAMES } from "../config/omx-first-party-mcp.js";
import { teamModeEnabled, type SetupTeamMode } from "../config/team-mode.js";
import {
	emitDegradedDurabilityWarning,
	recordDirectorySyncOutcome,
	recordRegularFileSyncOutcome,
	syncDirectory,
	syncRegularFile,
	type RegularFileDurabilityTracker,
} from "../utils/file-durability.js";

export const OMX_LOCAL_MARKETPLACE_NAME = "oh-my-codex-local";
export const OMX_PLUGIN_NAME = "oh-my-codex";
export const OMX_LOCAL_PLUGIN_CONFIG_KEY = `${OMX_PLUGIN_NAME}@${OMX_LOCAL_MARKETPLACE_NAME}`;

export interface PackagedOmxMarketplace {
	marketplacePath: string;
	packageRoot: string;
	pluginRoot: string;
	pluginManifestPath: string;
}

interface MarketplaceManifest {
	name?: unknown;
	plugins?: Array<{
		name?: unknown;
		source?: { source?: unknown; path?: unknown };
	}>;
}

interface PluginManifest {
	name?: unknown;
	version?: unknown;
	skills?: unknown;
	hooks?: unknown;
	mcpServers?: unknown;
	apps?: unknown;
}

const OMX_PLUGIN_HOOK_LAUNCHER_FILE = "omx-command.json";
const OMX_PLUGIN_MANAGED_MARKER = ".omx-managed";
const OMX_PLUGIN_CACHE_STAGING_PREFIX = ".omx-plugin-";
const TEAM_MODE_PLUGIN_SKILL_NAMES = new Set(["team", "worker"]);

export async function resolvePackagedOmxMarketplace(
	packageRoot: string,
): Promise<PackagedOmxMarketplace | null> {
	const marketplacePath = join(
		packageRoot,
		".agents",
		"plugins",
		"marketplace.json",
	);
	if (!existsSync(marketplacePath)) return null;

	let marketplace: MarketplaceManifest;
	try {
		marketplace = JSON.parse(
			await readFile(marketplacePath, "utf-8"),
		) as MarketplaceManifest;
	} catch {
		return null;
	}

	if (marketplace.name !== OMX_LOCAL_MARKETPLACE_NAME) return null;
	const pluginEntry = marketplace.plugins?.find(
		(entry) =>
			entry.name === OMX_PLUGIN_NAME &&
			entry.source?.source === "local" &&
			typeof entry.source.path === "string",
	);
	if (!pluginEntry || typeof pluginEntry.source?.path !== "string") return null;

	const pluginRoot = resolve(packageRoot, pluginEntry.source.path);
	const pluginManifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
	if (!existsSync(pluginManifestPath)) return null;

	try {
		const pluginManifest = JSON.parse(
			await readFile(pluginManifestPath, "utf-8"),
		) as PluginManifest;
		if (
			pluginManifest.name !== OMX_PLUGIN_NAME ||
			pluginManifest.skills !== "./skills/"
		) {
			return null;
		}
	} catch {
		return null;
	}

	return { marketplacePath, packageRoot, pluginRoot, pluginManifestPath };
}

async function readPluginManifest(
	manifestPath: string,
): Promise<PluginManifest | null> {
	try {
		return JSON.parse(await readFile(manifestPath, "utf-8")) as PluginManifest;
	} catch {
		return null;
	}
}

function isSafeCacheVersion(version: string): boolean {
	return version.length > 0
		&& version !== "."
		&& version !== ".."
		&& !version.includes("/")
		&& !version.includes("\\")
		&& !version.includes("\0");
}

function isPluginCacheStagingEntryName(name: string): boolean {
	return name === "snapshot" || name.startsWith(OMX_PLUGIN_CACHE_STAGING_PREFIX) || name.includes(".reclaim-");
}

function directoryFdPath(fd: number): string | null {
	if (process.platform === "linux") return `/proc/self/fd/${fd}`;
	return null;
}

function isDirectoryDescriptorPath(path: string): boolean {
	return /^\/proc\/self\/fd\/\d+$/.test(path);
}

function directoryOpenFlags(path: string, directoryFlags: number, noFollowFlags: number): number {
	return fsConstants.O_RDONLY | directoryFlags | (isDirectoryDescriptorPath(path) ? 0 : noFollowFlags);
}
interface DirectoryRef {
	handle: FileHandle;
	path: string;
	operationPath: string;
	scanOperationPath: string;
	mutationPath: string | null;
}

interface PluginCacheMutationTestHooks {
	beforeRename?: (sourcePath: string, destinationPath: string) => void | Promise<void>;
	beforeMkdirExclusive?: (parentPath: string, name: string) => void | Promise<void>;
	beforeExclusiveCreate?: (parentPath: string, name: string) => void | Promise<void>;
	afterStagedFileRead?: (path: string, stats: Stats, bytes: Buffer) => void | Promise<void>;
	beforeFinalClaimValidation?: (claimPath: string) => void | Promise<void>;
	beforeCompleteMarker?: (claimPath: string) => void | Promise<void>;
	beforeStaleLockReclaim?: (lockPath: string, stats: Stats) => void | Promise<void>;
	beforeRemove?: (path: string, stats: Stats) => void | Promise<void>;
	beforeRemoveSyscall?: (path: string, stats: Stats) => void | Promise<void>;
}

let pluginCacheMutationTestHooks: PluginCacheMutationTestHooks | undefined;

/** @internal Test seam for deterministic cache mutation interposition coverage. */
export function setPluginCacheMutationHooksForTest(
	hooks: PluginCacheMutationTestHooks | undefined,
): () => void {
	const previous = pluginCacheMutationTestHooks;
	pluginCacheMutationTestHooks = hooks;
	return () => {
		pluginCacheMutationTestHooks = previous;
	};
}

function directoryScanOperationPath(handle: FileHandle, path: string): string {
	return directoryFdPath(handle.fd) ?? resolve(path);
}

function directoryOperationPath(handle: FileHandle, path: string): string | null {
	// #3552 blockers 1+2: Linux mutates through a descriptor-relative
	// /proc/self/fd path. Node exposes no *at() primitives on other
	// platforms, so every mutation elsewhere goes through the visible path
	// that this handle's open() already validated without following
	// symlinks/reparse points, restricted to non-destructive shapes:
	// exclusive mkdir / O_CREAT|O_EXCL|O_NOFOLLOW creates (never O_TRUNC on
	// a foreign inode), fd-bound writes, quarantine+inode-gated rm, and
	// rename only into this process's own verified claim, with
	// assertDirectoryRef identity barriers immediately before and after
	// every mutation so a replaced parent is detected before any result is
	// trusted.
	if (process.platform === "linux") return `/proc/self/fd/${handle.fd}`;
	return resolve(path);
}

function unsupportedDirectoryOperationError(): NodeJS.ErrnoException {
	return Object.assign(
		new Error("platform cannot provide descriptor-relative directory operations"),
		{ code: "ENOTSUP" },
	);
}

function childMutationPath(parent: DirectoryRef, name: string): string {
	// name is one or more "/"-joined simple components; callers validate the
	// shape before reaching here, and every component must be a plain name.
	const components = name.split("/");
	if (components.some((component) => !component || component === "." || component === ".." || component.includes("\\"))) {
		throw new Error(`invalid descriptor-relative child name: ${name}`);
	}
	if (!parent.mutationPath) throw unsupportedDirectoryOperationError();
	return join(parent.mutationPath, ...components);
}

function childOperationPath(parent: DirectoryRef, name: string): string {
	if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
		throw new Error(`invalid descriptor-relative child name: ${name}`);
	}
	return join(parent.operationPath, name);
}

async function assertDirectoryRef(parent: DirectoryRef, operation: string): Promise<void> {
	const descriptorStats = await parent.handle.stat();
	const visibleStats = await lstat(parent.path);
	if (
		!descriptorStats.isDirectory() ||
		!visibleStats.isDirectory() ||
		visibleStats.isSymbolicLink() ||
		descriptorStats.dev !== visibleStats.dev ||
		descriptorStats.ino !== visibleStats.ino
	) {
		throw new Error(`descriptor-bound ${operation} parent was replaced: ${parent.path}`);
	}
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
	return typeof left.dev === "number" && typeof left.ino === "number"
		&& typeof right.dev === "number" && typeof right.ino === "number"
		&& left.dev === right.dev && left.ino === right.ino;
}

async function openDirectoryRef(path: string): Promise<DirectoryRef> {
	const noFollowFlags = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
	const directoryFlags = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
	if (process.platform !== "win32" && (noFollowFlags === 0 || directoryFlags === 0)) {
		throw new Error("directory anchoring flags are unavailable");
	}
	const visiblePath = resolve(path);
	const windowsRealpathBefore = process.platform === "win32" ? await realpath(visiblePath) : null;
	const visibleBefore = await lstat(visiblePath);
	if (visibleBefore.isSymbolicLink() || !visibleBefore.isDirectory()) throw new Error(`reparse-safe directory anchor rejected symbolic link or non-directory namespace component: ${visiblePath}`);
	const handle = await open(visiblePath, directoryOpenFlags(visiblePath, directoryFlags, noFollowFlags));
	const scanOperationPath = directoryScanOperationPath(handle, visiblePath);
	const mutationPath = directoryOperationPath(handle, visiblePath);
	const ref = { handle, path: visiblePath, operationPath: scanOperationPath, scanOperationPath, mutationPath };
	try {
		await assertDirectoryRef(ref, "open");
		if (windowsRealpathBefore && (await realpath(visiblePath)).toLowerCase() !== windowsRealpathBefore.toLowerCase()) {
			throw new Error(`reparse-safe directory anchor changed during open: ${visiblePath}`);
		}
		return ref;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function openDirectoryChild(parent: DirectoryRef, name: string): Promise<DirectoryRef> {
	const noFollowFlags = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
	const directoryFlags = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
	if (process.platform !== "win32" && (noFollowFlags === 0 || directoryFlags === 0)) {
		throw new Error("directory anchoring flags are unavailable");
	}
	const operationPath = childOperationPath(parent, name);
	const visiblePath = join(parent.path, name);
	await assertDirectoryRef(parent, "open");
	const windowsRealpathBefore = process.platform === "win32" ? await realpath(visiblePath) : null;
	const visibleBefore = await lstat(visiblePath);
	if (visibleBefore.isSymbolicLink() || !visibleBefore.isDirectory()) throw new Error(`reparse-safe directory anchor rejected symbolic link or non-directory namespace component: ${visiblePath}`);
	const handle = await open(operationPath, directoryOpenFlags(operationPath, directoryFlags, noFollowFlags));
	const childScan = directoryScanOperationPath(handle, visiblePath);
	const childMutation = directoryOperationPath(handle, visiblePath);
	const child = { handle, path: visiblePath, operationPath: childScan, scanOperationPath: childScan, mutationPath: childMutation };
	try {
		await assertDirectoryRef(parent, "open");
		await assertDirectoryRef(child, "open");
		if (windowsRealpathBefore && (await realpath(visiblePath)).toLowerCase() !== windowsRealpathBefore.toLowerCase()) {
			throw new Error(`reparse-safe directory anchor changed during open: ${visiblePath}`);
		}
		return child;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function mkdirDirectoryChild(parent: DirectoryRef, name: string): Promise<void> {
	const mutationPath = childMutationPath(parent, name);
	await assertDirectoryRef(parent, "mkdir");
	try {
		await mkdir(mutationPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	await assertDirectoryRef(parent, "mkdir");
}

async function mkdirDirectoryChildExclusive(parent: DirectoryRef, name: string): Promise<void> {
	const mutationPath = childMutationPath(parent, name);
	await assertDirectoryRef(parent, "exclusive mkdir");
	await pluginCacheMutationTestHooks?.beforeMkdirExclusive?.(parent.path, name);
	await mkdir(mutationPath);
	await assertDirectoryRef(parent, "exclusive mkdir");
}

async function copyPackagedTree(
	source: DirectoryRef,
	destination: DirectoryRef,
	tracker?: RegularFileDurabilityTracker,
): Promise<void> {
	await assertDirectoryRef(source, "packaged source copy");
	const entries = await readdir(source.operationPath, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isSymbolicLink()) {
			throw new Error(`refusing to copy a symlinked packaged plugin entry: ${join(source.path, entry.name)}`);
		}
		if (entry.isDirectory()) {
			await mkdirDirectoryChildExclusive(destination, entry.name);
			const sourceChild = await openDirectoryChild(source, entry.name);
			const child = await openDirectoryChild(destination, entry.name);
			try {
				await copyPackagedTree(sourceChild, child, tracker);
			} finally {
				await sourceChild.handle.close();
				await child.handle.close();
			}
			continue;
		}
		if (!entry.isFile()) {
			throw new Error(`refusing to copy a non-regular packaged plugin entry: ${join(source.path, entry.name)}`);
		}
		const sourceHandle = await openRegularFileChild(source, entry.name, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		try {
			const before = await sourceHandle.stat();
			if (!before.isFile() || before.isSymbolicLink()) {
				throw new Error(`packaged plugin entry changed while copying: ${join(source.path, entry.name)}`);
			}
			const content = await sourceHandle.readFile();
			const verifyHandle = await openRegularFileChild(source, entry.name, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
			try {
				const verifyStats = await verifyHandle.stat();
				const verifyContent = await verifyHandle.readFile();
				if (
					verifyStats.dev !== before.dev ||
					verifyStats.ino !== before.ino ||
					verifyStats.size !== before.size ||
					!content.equals(verifyContent)
				) {
					throw new Error(`packaged plugin entry changed while copying: ${join(source.path, entry.name)}`);
				}
			} finally {
				await verifyHandle.close();
			}
			const destinationHandle = await openRegularFileChild(
				destination,
				entry.name,
				fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
				before.mode & 0o7777,
			);
			try {
				await destinationHandle.writeFile(content);
				await destinationHandle.chmod(before.mode & 0o7777);
				const outcome = await syncRegularFile(destinationHandle);
				if (tracker) recordRegularFileSyncOutcome(tracker, outcome);
			} finally {
				await destinationHandle.close();
			}
		} finally {
			await sourceHandle.close();
		}
	}
	await assertDirectoryRef(source, "packaged source copy");
}

async function copyStagedTreeNoReplace(
	source: DirectoryRef,
	destination: DirectoryRef,
	tracker?: RegularFileDurabilityTracker,
): Promise<void> {
	await assertDirectoryRef(source, "staged source copy");
	await assertDirectoryRef(destination, "staged destination copy");
	const entries = await readdir(source.operationPath, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name === ".omx-incomplete") continue;
		if (entry.isSymbolicLink()) {
			throw new Error(`refusing to copy a symlinked staged cache entry: ${join(source.path, entry.name)}`);
		}
		if (entry.isDirectory()) {
			await mkdirDirectoryChildExclusive(destination, entry.name);
			const sourceChild = await openDirectoryChild(source, entry.name);
			const destinationChild = await openDirectoryChild(destination, entry.name);
			try {
				await copyStagedTreeNoReplace(sourceChild, destinationChild, tracker);
			} finally {
				await sourceChild.handle.close();
				await destinationChild.handle.close();
			}
			continue;
		}
		if (!entry.isFile()) {
			throw new Error(`refusing to copy a non-regular staged cache entry: ${join(source.path, entry.name)}`);
		}
		const sourceHandle = await openRegularFileChild(source, entry.name, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		try {
			const before = await sourceHandle.stat();
			if (!before.isFile() || before.isSymbolicLink()) {
				throw new Error(`staged cache entry changed while copying: ${join(source.path, entry.name)}`);
			}
			const content = await sourceHandle.readFile();
			await pluginCacheMutationTestHooks?.afterStagedFileRead?.(join(source.path, entry.name), before, content);
			const verifyHandle = await openRegularFileChild(source, entry.name, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
			try {
				const verifyStats = await verifyHandle.stat();
				const verifyContent = await verifyHandle.readFile();
				if (
					!sameFileIdentity(before, verifyStats)
					|| verifyStats.size !== before.size
					|| !content.equals(verifyContent)
				) {
					throw new Error(`staged cache entry changed while copying: ${join(source.path, entry.name)}`);
				}
			} finally {
				await verifyHandle.close();
			}
			const destinationHandle = await openRegularFileChild(
				destination,
				entry.name,
				fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
				before.mode & 0o7777,
			);
			try {
				await destinationHandle.writeFile(content);
				await destinationHandle.chmod(before.mode & 0o7777);
				const outcome = await syncRegularFile(destinationHandle);
				if (tracker) recordRegularFileSyncOutcome(tracker, outcome);
			} finally {
				await destinationHandle.close();
			}
		} finally {
			await sourceHandle.close();
		}
	}
	await assertDirectoryRef(source, "staged source copy");
	await assertDirectoryRef(destination, "staged destination copy");
}

async function openRegularFileChild(parent: DirectoryRef, name: string, flags: number, mode?: number): Promise<FileHandle> {
	const mutationPath = childMutationPath(parent, name);
	await assertDirectoryRef(parent, "file open");
	if ((flags & fsConstants.O_EXCL) !== 0) {
		await pluginCacheMutationTestHooks?.beforeExclusiveCreate?.(parent.path, name);
	}
	const handle = await open(mutationPath, flags, mode);
	try {
		await assertDirectoryRef(parent, "file open");
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function syncRegularFileChild(
	parent: DirectoryRef,
	name: string,
	tracker?: RegularFileDurabilityTracker,
): Promise<void> {
	const noFollowFlags = fsConstants.O_NOFOLLOW;
	if (process.platform !== "win32" && typeof noFollowFlags !== "number") throw new Error("O_NOFOLLOW is unavailable");
	const handle = await openRegularFileChild(parent, name, fsConstants.O_RDONLY | (noFollowFlags ?? 0));
	try {
		const outcome = await syncRegularFile(handle);
		if (tracker) recordRegularFileSyncOutcome(tracker, outcome);
	} finally {
		await handle.close();
	}
	await assertDirectoryRef(parent, "file sync");
}


async function createExclusiveFileChild(
	parent: DirectoryRef,
	name: string,
	content: string,
	tracker?: RegularFileDurabilityTracker,
): Promise<void> {
	const noFollowFlags = fsConstants.O_NOFOLLOW;
	if (process.platform !== "win32" && typeof noFollowFlags !== "number") throw new Error("O_NOFOLLOW is unavailable");
	const handle = await openRegularFileChild(parent, name, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (noFollowFlags ?? 0), 0o600);
	try {
		await handle.writeFile(content);
		const outcome = await syncRegularFile(handle);
		if (tracker) recordRegularFileSyncOutcome(tracker, outcome);
	} finally {
		await handle.close();
	}
	await assertDirectoryRef(parent, "exclusive file create");
}

interface RemoveChildOptions {
	recursive?: boolean;
	force?: boolean;
	preserveRecursive?: boolean;
	expectedManagedVersion?: string;
	preservedPaths?: string[];
	beforeDestructiveRemove?: () => Promise<boolean>;
}

async function removeChild(parent: DirectoryRef, name: string, options: RemoveChildOptions = {}): Promise<boolean> {
	const mutationPath = childMutationPath(parent, name);
	await assertDirectoryRef(parent, "remove");
	let before: Stats | undefined;
	try {
		before = await lstat(mutationPath);
	} catch (error) {
		if (!options.force || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (before) {
		if (options.recursive && options.preserveRecursive && before.isDirectory()) {
			return false;
		}
		// A final identity fence immediately before rm is the portable fallback
		// for platforms without unlinkat(2). If an interposer changes the name
		// after the quarantine lstat, preserve the replacement and report bounded
		// cleanup instead of recursively deleting an unknown inode.
		await pluginCacheMutationTestHooks?.beforeRemove?.(mutationPath, before);
		const current = await lstat(mutationPath).catch((error) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		});
		if (!current || !sameFileIdentity(before, current)) {
			throw new Error(`identity-bound removal target changed before deletion: ${mutationPath}`);
		}
		// Keep an explicit barrier immediately before the destructive syscall. The
		// production path has no portable unlinkat(2) primitive; the final re-lstat
		// after this barrier is the fail-closed fallback that preserves a raced
		// replacement instead of trusting a stale pathname check.
		await pluginCacheMutationTestHooks?.beforeRemoveSyscall?.(mutationPath, current);
		const final = await lstat(mutationPath).catch((error) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		});
		if (!final || !sameFileIdentity(before, final)) {
			throw new Error(`identity-bound removal target changed before removal syscall: ${mutationPath}`);
		}
		if (options.beforeDestructiveRemove && !await options.beforeDestructiveRemove()) return false;
	}
	await rm(mutationPath, options);
	if (before) {
		try {
			await lstat(mutationPath);
			throw new Error(`removed cache entry reappeared during removal: ${mutationPath}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	await assertDirectoryRef(parent, "remove");
	return true;
}

async function renameChild(sourceParent: DirectoryRef, sourceName: string, destinationParent: DirectoryRef, destinationName: string): Promise<void> {
	// sourceName may be a single component or a "/"-joined relative path of
	// simple components (publication moves staged snapshot entries), so
	// validate each component instead of rejecting separators outright.
	const sourceComponents = sourceName.split("/");
	if (sourceComponents.some((component) => !component || component === "." || component === ".." || component.includes("\\"))) {
		throw new Error(`invalid descriptor-relative child name: ${sourceName}`);
	}
	if (destinationName.includes("/") || destinationName.includes("\\") || !destinationName || destinationName === "." || destinationName === "..") {
		throw new Error(`invalid descriptor-relative child name: ${destinationName}`);
	}
	const sourcePath = childMutationPath(sourceParent, sourceComponents.join("/"));
	const destinationPath = childMutationPath(destinationParent, destinationName);
	await assertDirectoryRef(sourceParent, "rename");
	await assertDirectoryRef(destinationParent, "rename");
	const destinationBefore = await lstat(destinationPath).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	});
	if (destinationBefore) {
		throw Object.assign(
			new Error(`rename destination already exists: ${destinationPath}`),
			{ code: "EEXIST" },
		);
	}
	await pluginCacheMutationTestHooks?.beforeRename?.(sourcePath, destinationPath);
	const destinationAfter = await lstat(destinationPath).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	});
	if (destinationAfter) {
		throw Object.assign(
			new Error(`rename destination appeared during no-replace check: ${destinationPath}`),
			{ code: "EEXIST" },
		);
	}
	await rename(sourcePath, destinationPath);
	await assertDirectoryRef(sourceParent, "rename");
	await assertDirectoryRef(destinationParent, "rename");
}

/**
 * #3552 blocker 3 / review 3860267789: POSIX rename() silently replaces an
 * empty same-version directory and Node exposes no renameat2(RENAME_NOREPLACE),
 * so pre/post inode checks around a rename can never be atomic no-replace.
 * Publication therefore never renames onto `<version>`: the destination is
 * claimed with an atomic exclusive mkdir (the one portable no-replace
 * primitive). EEXIST — whether the destination is empty, foreign, incomplete,
 * or a completed snapshot — always fails closed without touching it. The
 * claim is self-described with an O_EXCL `.omx-incomplete` marker, the staged
 * snapshot entries are renamed into the empty claim (destination names cannot
 * pre-exist), and `.omx-complete` is committed last. Every trust path requires
 * `.omx-complete` and rejects `.omx-incomplete`, so no intermediate state is
 * trusted, and no pre-existing directory is ever replaced or removed.
 *
 * A claim abandoned by a crashed publisher keeps `.omx-incomplete` and no
 * `.omx-complete`; the next publication fails closed on it (stale-launcher
 * with the removal recovery hint) rather than deleting foreign content.
 */
async function claimPublicationDestination(
	destinationParent: DirectoryRef,
	destinationName: string,
	tracker?: RegularFileDurabilityTracker,
): Promise<DirectoryRef> {
	await mkdirDirectoryChildExclusive(destinationParent, destinationName);
	const claimRef = await openDirectoryChild(destinationParent, destinationName);
	try {
		await assertDirectoryRef(claimRef, "publication claim");
		await createExclusiveFileChild(claimRef, ".omx-incomplete", `${process.pid}\n`, tracker);
		return claimRef;
	} catch (error) {
		await claimRef.handle.close();
		throw error;
	}
}

async function syncDirectoryTree(
	directory: DirectoryRef,
	tracker?: RegularFileDurabilityTracker,
): Promise<void> {
	await assertDirectoryRef(directory, "directory sync");
	const entries = await readdir(directory.operationPath, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isSymbolicLink()) throw new Error(`cannot sync symlinked cache entry: ${join(directory.path, entry.name)}`);
		if (entry.isDirectory()) {
			const child = await openDirectoryChild(directory, entry.name);
			try {
				await syncDirectoryTree(child, tracker);
			} finally {
				await child.handle.close();
			}
		} else {
			await syncRegularFileChild(directory, entry.name, tracker);
		}
	}
	await assertDirectoryRef(directory, "directory sync");
	const outcome = await syncDirectory(directory.handle);
	if (tracker) recordDirectorySyncOutcome(tracker, outcome);
}

export async function readOmxPluginCacheFileNoFollow(
	path: string,
	options: { requireSingleLink?: boolean; anchorDir?: string } = {},
): Promise<Buffer | null> {
	let handle: FileHandle | undefined;
	let anchorHandle: FileHandle | undefined;
	const intermediateDirectories: Array<{ handle: FileHandle; path: string; stats: Stats }> = [];
	try {
		const requireSingleLink = options.requireSingleLink ?? true;
		const noFollowFlags = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
		if (process.platform !== "win32" && noFollowFlags === 0) return null;
		let readPath = path;
		let anchorBefore: Stats | null = null;
		if (options.anchorDir) {
			const directoryFlags = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
			if (process.platform !== "win32" && directoryFlags === 0) return null;
			anchorHandle = await open(options.anchorDir, directoryOpenFlags(options.anchorDir, directoryFlags, noFollowFlags));
			anchorBefore = await anchorHandle.stat();
			if (!anchorBefore.isDirectory()) return null;
			if (typeof anchorBefore.dev !== "number" || typeof anchorBefore.ino !== "number") return null;
			const fdPath = process.platform === "linux"
				? directoryFdPath(anchorHandle.fd)
				: resolve(options.anchorDir);
			if (!fdPath) return null;
			const relativePath = relative(resolve(options.anchorDir), resolve(path));
			if (!relativePath || relativePath.startsWith("..")) return null;
			const components = relativePath.split(sep);
			if (components.some((component) => !component || component === "." || component === "..")) return null;
			let parentPath = fdPath;
			for (const component of components.slice(0, -1)) {
				const childPath = join(parentPath, component);
				const childHandle = await open(childPath, fsConstants.O_RDONLY | directoryFlags | noFollowFlags);
				const childStats = await childHandle.stat();
				if (!childStats.isDirectory() || childStats.isSymbolicLink()) {
					await childHandle.close();
					return null;
				}
				intermediateDirectories.push({ handle: childHandle, path: childPath, stats: childStats });
				parentPath = process.platform === "linux" ? directoryFdPath(childHandle.fd) ?? "" : childPath;
				if (!parentPath) return null;
			}
			readPath = join(parentPath, components.at(-1)!);
		}
		const parentDescriptor = intermediateDirectories.at(-1)?.handle ?? anchorHandle;
		const parentBefore = parentDescriptor ? await parentDescriptor.stat() : await lstat(resolve(readPath, ".."));
		if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) return null;
		if (typeof parentBefore.dev !== "number" || typeof parentBefore.ino !== "number") return null;
		const before = await lstat(readPath);
		if (!before.isFile() || before.isSymbolicLink()) return null;
		if (requireSingleLink && before.nlink !== 1) return null;
		if (typeof before.dev !== "number" || typeof before.ino !== "number") return null;
		handle = await open(readPath, fsConstants.O_RDONLY | noFollowFlags);
		const descriptorStats = await handle.stat();
		if (!descriptorStats.isFile()) return null;
		if (requireSingleLink && descriptorStats.nlink !== 1) return null;
		if (descriptorStats.dev !== before.dev || descriptorStats.ino !== before.ino) return null;
		const bytes = await handle.readFile();
		const after = await lstat(readPath);
		const parentAfter = parentDescriptor ? await parentDescriptor.stat() : await lstat(resolve(readPath, ".."));
		if (!parentAfter) return null;
		if (!after.isFile() || after.isSymbolicLink()) return null;
		if (requireSingleLink && after.nlink !== 1) return null;
		if (typeof after.dev !== "number" || typeof after.ino !== "number") return null;
		if (after.dev !== before.dev || after.ino !== before.ino) return null;
		if (!parentAfter.isDirectory() || parentAfter.isSymbolicLink()) return null;
		if (typeof parentAfter.dev !== "number" || typeof parentAfter.ino !== "number" || parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino) return null;
		for (const directory of intermediateDirectories) {
			const currentStats = await lstat(directory.path);
			if (!currentStats.isDirectory() || currentStats.isSymbolicLink() || typeof currentStats.dev !== "number" || typeof currentStats.ino !== "number" || currentStats.dev !== directory.stats.dev || currentStats.ino !== directory.stats.ino) return null;
		}
		if (options.anchorDir && anchorBefore) {
			const anchorAfter = isDirectoryDescriptorPath(options.anchorDir)
				? await anchorHandle!.stat()
				: await lstat(options.anchorDir);
			if (!anchorAfter.isDirectory() || (!isDirectoryDescriptorPath(options.anchorDir) && anchorAfter.isSymbolicLink()) || typeof anchorAfter.dev !== "number" || typeof anchorAfter.ino !== "number" || anchorAfter.dev !== anchorBefore.dev || anchorAfter.ino !== anchorBefore.ino) return null;
		}
		return bytes;
	} catch {
		return null;
	} finally {
		if (handle) await handle.close();
		for (const directory of intermediateDirectories.reverse()) await directory.handle.close();
		if (anchorHandle) await anchorHandle.close();
	}
}

async function readRegularFileTextNoFollow(path: string, options: { anchorDir?: string } = {}): Promise<string | null> {
	const bytes = await readOmxPluginCacheFileNoFollow(path, options);
	return bytes?.toString("utf-8") ?? null;
}

export async function computeOmxPluginCacheClaimDigest(root: string): Promise<string> {
	const hash = createHash("sha256");
	const visit = async (directory: string, isRoot: boolean): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (isRoot && (entry.name === ".omx-complete" || entry.name === ".omx-live-pin")) continue;
			const path = join(directory, entry.name);
			const stats = await lstat(path);
			if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile()) || (stats.isFile() && stats.nlink !== 1)) {
				throw new Error(`claim entry is not a singly-linked regular file or directory: ${path}`);
			}
			hash.update(`${entry.name}\0${stats.isDirectory() ? "d" : "f"}\0${stats.dev}\0${stats.ino}\0${stats.size}\0`);
			if (stats.isDirectory()) {
				await visit(path, false);
			} else {
				const bytes = await readOmxPluginCacheFileNoFollow(path, { anchorDir: directory });
				if (bytes === null) throw new Error(`claim entry cannot be read: ${path}`);
				hash.update(bytes);
			}
		}
	};
	await visit(root, true);
	return hash.digest("hex");
}

async function hasRegularPublicationMarker(cacheDir: string, name: ".omx-complete" | ".omx-incomplete" | ".omx-managed"): Promise<boolean> {
	const bytes = await readOmxPluginCacheFileNoFollow(join(cacheDir, name), { anchorDir: cacheDir });
	if (bytes === null) return false;
	if (name !== ".omx-complete") return true;
	try {
		const record = JSON.parse(bytes.toString("utf-8")) as { claimDigest?: unknown };
		if (typeof record.claimDigest !== "string") return false;
		return record.claimDigest === await computeOmxPluginCacheClaimDigest(cacheDir);
	} catch {
		return false;
	}
}

async function listChildDirectoryNames(dir: string): Promise<string[] | null> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return null;
	}
}

async function readRegularOmxPluginCacheManifest(
	cacheDir: string,
	anchorDir = cacheDir,
): Promise<PluginManifest | null> {
	const manifestDir = join(cacheDir, ".codex-plugin");
	const manifestPath = join(manifestDir, "plugin.json");
	try {
		const manifestDirStats = await lstat(manifestDir);
		if (!manifestDirStats.isDirectory() || manifestDirStats.isSymbolicLink()) return null;
		const manifestStats = await lstat(manifestPath);
		if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) return null;
		const bytes = await readOmxPluginCacheFileNoFollow(manifestPath, { anchorDir });
		return bytes ? JSON.parse(bytes.toString("utf-8")) as PluginManifest : null;
	} catch {
		return null;
	}
}

export async function packagedOmxPluginVersion(
	packagedMarketplace: PackagedOmxMarketplace,
): Promise<string | null> {
	const manifest = await readPluginManifest(packagedMarketplace.pluginManifestPath);
	if (typeof manifest?.version !== "string") return null;
	const version = manifest.version.trim();
	return isSafeCacheVersion(version) ? version : null;
}

export async function expectedPackagedOmxSkillNames(
	packagedMarketplace: PackagedOmxMarketplace,
	options: { teamMode?: SetupTeamMode } = {},
): Promise<string[] | null> {
	const skillNames = await listChildDirectoryNames(join(packagedMarketplace.pluginRoot, "skills"));
	if (!skillNames) return null;
	return skillNames.filter((name) => (
		teamModeEnabled(options.teamMode) || !TEAM_MODE_PLUGIN_SKILL_NAMES.has(name)
	));
}

export function omxPluginCacheBase(codexHomeDir: string): string {
	return join(
		codexHomeDir,
		"plugins",
		"cache",
		OMX_LOCAL_MARKETPLACE_NAME,
		OMX_PLUGIN_NAME,
	);
}

function isMissingPathError(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/**
 * #3552 blocker 6: a recycled PID makes `process.kill(pid, 0)` report a dead
 * publisher as alive, so a PID check alone can never prove the lock owner is
 * the process that created the lock. Bind each lock to a per-process random
 * token and treat the lock as reclaimable only when (a) the recorded process
 * start identity is missing (legacy locks become lease-bounded) and the lease
 * expired, (b) the process is dead (ESRCH — no live process holds the PID), or
 * (c) the recorded lease expired. Live-owner locks with a valid lease are
 * never reclaimed.
 */
interface PublicationLockRecord {
	pid?: unknown;
	createdAt?: unknown;
	bootId?: unknown;
	processToken?: unknown;
	heartbeatAt?: unknown;
}

const PUBLICATION_LOCK_LEASE_MS = 120_000;
const PUBLICATION_LOCK_MAX_FUTURE_SKEW_MS = 300_000;
const PUBLICATION_LOCK_PROCESS_TOKEN = randomUUID();
const PUBLICATION_LOCK_HEARTBEAT_INTERVAL_MS = 30_000;

function buildPublicationLockRecord(heartbeatAt: number = Date.now()): string {
	return `${JSON.stringify({
		pid: process.pid,
		createdAt: heartbeatAt,
		heartbeatAt,
		processToken: PUBLICATION_LOCK_PROCESS_TOKEN,
	})}\n`;
}

function parsePublicationLockRecord(bytes: Buffer): PublicationLockRecord | null {
	try {
		const lines = bytes.toString("utf-8").split("\n").map((line) => line.trim()).filter(Boolean);
		const parsed = JSON.parse(lines.at(-1) ?? "") as PublicationLockRecord;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function publicationLockLeaseExpired(record: PublicationLockRecord, now = Date.now()): boolean {
	const heartbeat = typeof record.heartbeatAt === "number" && Number.isFinite(record.heartbeatAt)
		? record.heartbeatAt
		: typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
			? record.createdAt
			: null;
	if (heartbeat === null) return true;
	return now - heartbeat > PUBLICATION_LOCK_LEASE_MS;
}

function publicationLockFileAgeExpired(stats: Stats, now = Date.now()): boolean {
	return typeof stats.mtimeMs === "number" && Number.isFinite(stats.mtimeMs)
		&& now - stats.mtimeMs > PUBLICATION_LOCK_LEASE_MS;
}

function publicationLockRecordStructurallyValid(record: PublicationLockRecord, now = Date.now()): boolean {
	const hasPid = typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0;
	const hasHeartbeat = typeof record.heartbeatAt === "number" && Number.isFinite(record.heartbeatAt);
	const hasCreatedAt = typeof record.createdAt === "number" && Number.isFinite(record.createdAt);
	const heartbeatPlausible = !hasHeartbeat || (record.heartbeatAt as number) <= now + PUBLICATION_LOCK_MAX_FUTURE_SKEW_MS;
	const createdPlausible = !hasCreatedAt || (record.createdAt as number) <= now + PUBLICATION_LOCK_MAX_FUTURE_SKEW_MS;
	return hasPid && (hasHeartbeat || hasCreatedAt) && heartbeatPlausible && createdPlausible;
}

function isPublicationLockStale(record: PublicationLockRecord, now = Date.now()): boolean {
	if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return false;
	if (publicationLockLeaseExpired(record, now)) return true;
	return !isProcessAlive(record.pid);
}

async function refreshPublicationLockRecord(
	lockPath: string,
	lockHandle: FileHandle,
	lockIdentity: Stats,
	tracker?: RegularFileDurabilityTracker,
	): Promise<boolean> {
	let before: Stats;
	try {
		before = await lstat(lockPath);
		const descriptorStats = await lockHandle.stat();
		if (!sameFileIdentity(before, lockIdentity) || !sameFileIdentity(descriptorStats, lockIdentity)) return false;
	} catch {
		return false;
	}
	try {
		const record = buildPublicationLockRecord();
		const buf = Buffer.from(record, "utf-8");
		// Heartbeats are append-only complete records. Readers consume the last
		// complete line, so an in-progress write can never turn a previous valid
		// owner record into a partially published lock state.
		await lockHandle.write(buf);
		const outcome = await syncRegularFile(lockHandle);
		if (tracker) recordRegularFileSyncOutcome(tracker, outcome);
	} catch {
		// Heartbeat is best-effort; a slow filesystem or closed handle must not fail the
		// already-claimed publication. The next interval will retry if the handle is still open.
	}
	try {
		const after = await lstat(lockPath);
		const descriptorStats = await lockHandle.stat();
		return sameFileIdentity(after, lockIdentity) && sameFileIdentity(descriptorStats, lockIdentity);
	} catch {
		return false;
	}
}

interface PublicationLockGuard {
	timer: NodeJS.Timeout;
	assertOwned: () => Promise<void>;
}

function startPublicationLockHeartbeat(
	lockPath: string,
	lockHandle: FileHandle,
	lockIdentity: Stats,
	tracker?: RegularFileDurabilityTracker,
	): PublicationLockGuard {
	let lost = false;
	const assertOwned = async (): Promise<void> => {
		if (lost) throw new Error(`publication lock ownership lost at ${lockPath}`);
		try {
			const pathStats = await lstat(lockPath);
			const descriptorStats = await lockHandle.stat();
			if (!sameFileIdentity(pathStats, lockIdentity) || !sameFileIdentity(descriptorStats, lockIdentity)) {
				lost = true;
				throw new Error(`publication lock ownership lost at ${lockPath}`);
			}
		} catch (error) {
			lost = true;
			throw error;
		}
	};
	const timer = setInterval(() => {
		void refreshPublicationLockRecord(lockPath, lockHandle, lockIdentity, tracker).then((owned) => {
			if (!owned) lost = true;
		});
	}, PUBLICATION_LOCK_HEARTBEAT_INTERVAL_MS);
	return { timer, assertOwned };
}

export async function removeChildIfIdentity(
	cacheBaseRef: DirectoryRef,
	childName: string,
	childStats: Stats,
	options: RemoveChildOptions,
): Promise<boolean> {
	const quarantineName = `.${childName}.reclaim-${process.pid}-${randomUUID()}`;
	await renameChild(cacheBaseRef, childName, cacheBaseRef, quarantineName);
	const quarantinePath = childOperationPath(cacheBaseRef, quarantineName);
	let quarantineStats: Stats;
	try {
		quarantineStats = await lstat(quarantinePath);
	} catch (error) {
		throw new Error(`identity-bound removal target disappeared during reclamation: ${(error as Error).message}`);
	}
	if (quarantineStats.dev !== childStats.dev || quarantineStats.ino !== childStats.ino) {
		// Quarantined the wrong inode (replacement after validation). There is no
		// portable atomic no-replace directory restore: rename(quarantine, name)
		// can overwrite a successor inserted after any lstat(name). Preserve the
		// quarantined inode instead of risking overwrite or deletion. Regular
		// files can be linked back with no-clobber semantics, but the quarantine
		// link is intentionally retained so cleanup never follows a raced path.
		try {
			if (!quarantineStats.isDirectory()) {
				await link(quarantinePath, childOperationPath(cacheBaseRef, childName));
			}
		} catch {
			// Preserve replacement without overwriting a successor that appeared
			// between the quarantine and the restore attempt; quarantine remains.
		}
		throw new Error(`identity-bound removal target changed during reclamation; preserved quarantine ${quarantinePath}`);
	}
	if (options.expectedManagedVersion) {
		const verifyQuarantineOwnership = async (): Promise<boolean> => {
		const manifest = await readRegularOmxPluginCacheManifest(quarantinePath, quarantinePath);
		const owned = manifest?.name === OMX_PLUGIN_NAME
			&& manifest.version === options.expectedManagedVersion
			&& await hasRegularPublicationMarker(quarantinePath, ".omx-complete")
			&& !(await hasRegularPublicationMarker(quarantinePath, ".omx-incomplete"))
			&& await hasRegularPublicationMarker(quarantinePath, OMX_PLUGIN_MANAGED_MARKER);
		const livePin = await readOmxPluginCacheFileNoFollow(join(quarantinePath, ".omx-live-pin"), { anchorDir: quarantinePath }) !== null;
		if (!owned || livePin) {
			return false;
		}
		return true;
		};
		await pluginCacheMutationTestHooks?.beforeRemove?.(quarantinePath, quarantineStats);
		if (!await verifyQuarantineOwnership()) {
			options.preservedPaths?.push(join(cacheBaseRef.path, quarantineName));
			return false;
		}
		return removeChild(cacheBaseRef, quarantineName, {
			...options,
			preserveRecursive: false,
			beforeDestructiveRemove: async () => {
				const owned = await verifyQuarantineOwnership();
				if (!owned) options.preservedPaths?.push(join(cacheBaseRef.path, quarantineName));
				return owned;
			},
		});
	}
	return removeChild(cacheBaseRef, quarantineName, {
		...options,
		preserveRecursive: options.preserveRecursive ?? options.recursive === true,
	});
}

async function reclaimStalePublicationLock(
	cacheBaseRef: DirectoryRef,
	lockName: string,
	lockStats: Stats,
	checkLateHeartbeat = true,
): Promise<void> {
	const quarantineName = `.${lockName}.reclaim-${process.pid}-${randomUUID()}`;
	await renameChild(cacheBaseRef, lockName, cacheBaseRef, quarantineName);
	const quarantinePath = childOperationPath(cacheBaseRef, quarantineName);
	let quarantineStats: Stats;
	try {
		quarantineStats = await lstat(quarantinePath);
	} catch (error) {
		throw new Error(`stale publication lock disappeared during reclamation: ${(error as Error).message}`);
	}
	if (quarantineStats.dev !== lockStats.dev || quarantineStats.ino !== lockStats.ino) {
		try {
			await link(quarantinePath, childOperationPath(cacheBaseRef, lockName));
		} catch {
			// Preserve a replacement lock and its contents without overwriting it.
		}
		throw new Error(`publication lock changed during stale-lock reclamation; preserved quarantine ${quarantinePath}`);
	}
	if (checkLateHeartbeat) {
		await pluginCacheMutationTestHooks?.beforeRemoveSyscall?.(quarantinePath, quarantineStats);
		const quarantineBytes = await readFile(quarantinePath).catch(() => null);
		const quarantineRecord = quarantineBytes === null ? null : parsePublicationLockRecord(quarantineBytes);
		const quarantineStillStale = quarantineRecord !== null && publicationLockRecordStructurallyValid(quarantineRecord)
			? isPublicationLockStale(quarantineRecord)
			: publicationLockFileAgeExpired(quarantineStats);
		if (!quarantineStillStale) {
			try {
				await link(quarantinePath, childOperationPath(cacheBaseRef, lockName));
			} catch {
				// Preserve a successor lock or a late-heartbeat owner without clobbering.
			}
			throw new Error(`publication lock heartbeat changed during stale-lock reclamation; preserved quarantine ${quarantinePath}`);
		}
	}
	await removeChild(cacheBaseRef, quarantineName, { force: true });
}

async function claimPublicationLock(
	cacheBaseRef: DirectoryRef,
	cacheBase: string,
	noFollowFlags: number,
	tracker?: RegularFileDurabilityTracker,
): Promise<FileHandle> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const lockHandle = await openRegularFileChild(
				cacheBaseRef,
				".omx-publish.lock",
				fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlags,
				0o600,
			);
			try {
				await lockHandle.writeFile(buildPublicationLockRecord());
				const outcome = await syncRegularFile(lockHandle);
				if (tracker) recordRegularFileSyncOutcome(tracker, outcome);
			} catch (error) {
				let lockIdentity: Stats | undefined;
				try { lockIdentity = await lockHandle.stat(); } catch { /* preserve the primary failure */ }
				try { await lockHandle.close(); } catch { /* preserve the primary failure */ }
				if (lockIdentity) {
					try { await reclaimStalePublicationLock(cacheBaseRef, ".omx-publish.lock", lockIdentity, false); } catch { /* preserve the primary failure */ }
				}
				throw error;
			}
			return lockHandle;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error;
			const lockPath = join(cacheBaseRef.path, ".omx-publish.lock");
			let lockBefore: Stats;
			try { lockBefore = await lstat(lockPath); } catch { continue; }
			if (!lockBefore.isFile() || lockBefore.isSymbolicLink() || typeof lockBefore.dev !== "number" || typeof lockBefore.ino !== "number") {
				throw new Error(`another OMX plugin cache publication is active at ${cacheBase}; refusing concurrent publication`);
			}
			const lockBytes = await readOmxPluginCacheFileNoFollow(lockPath, { anchorDir: cacheBaseRef.path });
			let lockAfter: Stats;
			try { lockAfter = await lstat(lockPath); } catch { continue; }
			if (lockAfter.dev !== lockBefore.dev || lockAfter.ino !== lockBefore.ino) continue;
			let stale = false;
			if (lockBytes !== null) {
				const record = parsePublicationLockRecord(lockBytes);
				stale = record !== null && publicationLockRecordStructurallyValid(record)
					? isPublicationLockStale(record)
					: publicationLockFileAgeExpired(lockBefore);
			} else {
				stale = publicationLockFileAgeExpired(lockBefore);
			}
			if (!stale) {
				throw new Error(`another OMX plugin cache publication is active at ${cacheBase}; refusing concurrent publication`);
			}
			const reclaimBefore = await lstat(lockPath);
			if (reclaimBefore.dev !== lockBefore.dev || reclaimBefore.ino !== lockBefore.ino) continue;
			await pluginCacheMutationTestHooks?.beforeStaleLockReclaim?.(lockPath, reclaimBefore);
			try {
				await reclaimStalePublicationLock(cacheBaseRef, ".omx-publish.lock", reclaimBefore);
			} catch (reclaimError) {
				if ((reclaimError as NodeJS.ErrnoException).code === "ENOENT") continue;
				if (
					(reclaimError as Error).message.startsWith("publication lock changed during stale-lock reclamation")
					|| (reclaimError as Error).message.startsWith("publication lock heartbeat changed during stale-lock reclamation")
				) continue;
				throw reclaimError;
			}
		}
	}
	throw new Error(`cannot recover stale OMX plugin cache publication lock at ${cacheBase}`);
}

/**
 * #3552: executed assets Codex loads from the plugin cache must be regular files inside a
 * regular `hooks/` directory inside a regular snapshot root. `readFile`/content equality
 * follow symlinks to their external targets before any provenance check, so a symlinked
 * `<version>` cache root or a symlinked executed asset (hooks/hooks.json,
 * hooks/codex-native-hook.mjs, hooks/omx-command.json) with byte-identical external
 * content could satisfy the unchanged fast paths while the executed bytes stayed
 * attacker-writable outside the managed namespace. Returns a human-readable reason when
 * provenance is broken (missing/symlinked/non-regular root, hooks dir, or asset), or
 * null when the snapshot's provenance is intact. Callers treat non-null as fail-closed.
 */
export async function omxPluginCacheExecutedAssetProvenanceReason(
	cacheDir: string,
): Promise<string | null> {
	if ((await readOmxPluginCacheFileNoFollow(join(cacheDir, ".omx-complete"), { anchorDir: cacheDir })) === null) {
		return `cache snapshot publication marker is missing at ${cacheDir}`;
	}
	if ((await readOmxPluginCacheFileNoFollow(join(cacheDir, ".omx-incomplete"), { anchorDir: cacheDir })) !== null) {
		return `cache snapshot publication is incomplete at ${cacheDir}`;
	}
	const expectations: Array<{ path: string; kind: "file" | "directory"; label: string }> = [
		{ path: cacheDir, kind: "directory", label: "cache root" },
		{ path: join(cacheDir, "hooks"), kind: "directory", label: "hooks directory" },
		{ path: join(cacheDir, "hooks", "hooks.json"), kind: "file", label: "executed cache asset" },
		{ path: join(cacheDir, "hooks", "codex-native-hook.mjs"), kind: "file", label: "executed cache asset" },
		{ path: join(cacheDir, "hooks", OMX_PLUGIN_HOOK_LAUNCHER_FILE), kind: "file", label: "executed cache asset" },
	];
	for (const { path, kind, label } of expectations) {
		let stats;
		try {
			stats = await lstat(path);
		} catch {
			return `${label} is missing at ${path}`;
		}
		const shapeOk = kind === "directory"
			? stats.isDirectory() && !stats.isSymbolicLink()
			: stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1;
		if (!shapeOk) {
			return `${label} at ${path} is a symlink or not a ${kind === "directory" ? "directory" : "regular file"}`;
		}
	}
	return null;
}

async function omxPluginCacheManifestProvenanceReason(
	cacheDir: string,
	expectedVersion?: string,
): Promise<string | null> {
	const manifestDir = join(cacheDir, ".codex-plugin");
	const manifestPath = join(manifestDir, "plugin.json");
	let manifestDirStats;
	try {
		manifestDirStats = await lstat(manifestDir);
	} catch {
		return `plugin manifest directory is missing at ${manifestDir}`;
	}
	if (!manifestDirStats.isDirectory() || manifestDirStats.isSymbolicLink()) {
		return `plugin manifest directory at ${manifestDir} is a symlink or not a directory`;
	}
	let manifestStats;
	try {
		manifestStats = await lstat(manifestPath);
	} catch {
		return `plugin manifest is missing at ${manifestPath}`;
	}
	if (!manifestStats.isFile() || manifestStats.isSymbolicLink() || manifestStats.nlink !== 1) {
		return `plugin manifest at ${manifestPath} is a symlink or not a regular file`;
	}
	const manifestBytes = await readOmxPluginCacheFileNoFollow(manifestPath, { anchorDir: cacheDir });
	let manifest: PluginManifest | null = null;
	try {
		manifest = manifestBytes ? JSON.parse(manifestBytes.toString("utf-8")) as PluginManifest : null;
	} catch {
		manifest = null;
	}
	if (!manifest) return `plugin manifest at ${manifestPath} is unreadable or invalid JSON`;
	if (manifest.name !== OMX_PLUGIN_NAME) {
		return `plugin manifest name is not ${OMX_PLUGIN_NAME} at ${manifestPath}`;
	}
	if (typeof manifest.version !== "string" || (expectedVersion !== undefined && manifest.version !== expectedVersion)) {
		return `plugin manifest version is not ${expectedVersion ?? "a valid string"} at ${manifestPath}`;
	}
	if (manifest.skills !== "./skills/") {
		return `plugin manifest skills pointer is not ./skills/ at ${manifestPath}`;
	}
	if (manifest.hooks !== "./hooks/hooks.json") {
		return `plugin manifest hooks pointer is not ./hooks/hooks.json at ${manifestPath}`;
	}
	if (manifest.mcpServers !== "./.mcp.json") {
		return `plugin manifest mcpServers pointer is not ./.mcp.json at ${manifestPath}`;
	}
	if (manifest.apps !== "./.app.json") {
		return `plugin manifest apps pointer is not ./.app.json at ${manifestPath}`;
	}
	return null;
}

/**
 * #3699: reports why an existing same-version cache cannot satisfy the requested
 * Team mode. Returns `null` when the installed skill set already matches, so the
 * caller only surfaces the immutability limitation for a real mode transition.
 */
async function omxPluginCacheTeamModeSkillMismatchReason(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
	teamMode: SetupTeamMode | undefined,
): Promise<string | null> {
	const expectedSkillNames = await expectedPackagedOmxSkillNames(packagedMarketplace, { teamMode });
	if (!expectedSkillNames) return null;
	const installedSkillNames = await listChildDirectoryNames(join(cacheDir, "skills"));
	if (!installedSkillNames) return null;
	const expected = new Set(expectedSkillNames);
	const unexpected = installedSkillNames.filter((name) => !expected.has(name)).sort();
	const missing = expectedSkillNames.filter((name) => !installedSkillNames.includes(name)).sort();
	if (unexpected.length === 0 && missing.length === 0) return null;
	// Only Team-mode skill drift explains itself as a mode transition; any other
	// difference stays with the fail-closed provenance reporting path.
	if (![...unexpected, ...missing].every((name) => TEAM_MODE_PLUGIN_SKILL_NAMES.has(name))) {
		return null;
	}
	const details = [
		unexpected.length > 0 ? `still exposes ${unexpected.join(", ")}` : null,
		missing.length > 0 ? `is missing ${missing.join(", ")}` : null,
	].filter((part): part is string => part !== null).join(" and ");
	return `existing same-version OMX plugin cache at ${cacheDir} ${details} for teamMode=${teamMode ?? "enabled"}; a same-version snapshot is immutable and cannot be rewritten in place`;
}

async function omxPluginCacheSkillsProvenanceReason(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
	expectedSkillNames: string[],
): Promise<string | null> {
	const skillsDir = join(cacheDir, "skills");
	let skillsStats;
	try {
		skillsStats = await lstat(skillsDir);
	} catch {
		return `skills directory is missing at ${skillsDir}`;
	}
	if (!skillsStats.isDirectory() || skillsStats.isSymbolicLink()) {
		return `skills directory at ${skillsDir} is a symlink or not a directory`;
	}
	let skillEntries;
	try {
		skillEntries = await readdir(skillsDir, { withFileTypes: true });
	} catch {
		return `skills directory at ${skillsDir} is unreadable`;
	}
	const actualSkillNames = skillEntries.map((entry) => entry.name).sort();
	if (skillEntries.some((entry) => entry.isSymbolicLink() || !entry.isDirectory())) {
		return `skills directory at ${skillsDir} contains a symlink or non-directory entry`;
	}
	if (JSON.stringify(actualSkillNames) !== JSON.stringify([...expectedSkillNames].sort())) {
		return `skills directory contents differ at ${skillsDir}`;
	}
	for (const skillName of expectedSkillNames) {
		const skillDir = join(skillsDir, skillName);
		let skillDirStats;
		try {
			skillDirStats = await lstat(skillDir);
		} catch {
			return `expected skill directory is missing at ${skillDir}`;
		}
		if (!skillDirStats.isDirectory() || skillDirStats.isSymbolicLink()) {
			return `expected skill directory at ${skillDir} is a symlink or not a directory`;
		}
		const cachedSkill = join(skillDir, "SKILL.md");
		const packagedSkill = join(packagedMarketplace.pluginRoot, "skills", skillName, "SKILL.md");
		let cachedSkillStats;
		try {
			cachedSkillStats = await lstat(cachedSkill);
		} catch {
			return `expected skill file is missing at ${cachedSkill}`;
		}
		if (!cachedSkillStats.isFile() || cachedSkillStats.isSymbolicLink() || cachedSkillStats.nlink !== 1) {
			return `expected skill file at ${cachedSkill} is a symlink or not a regular file`;
		}
		if (!(await fileContentsEqual(cachedSkill, packagedSkill, cacheDir))) {
			return `expected skill file content differs at ${cachedSkill}`;
		}
	}
	return null;
}

async function omxPluginCacheCompanionMetadataProvenanceReason(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
): Promise<string | null> {
	for (const [name, relativePath] of [["mcpServers", ".mcp.json"], ["apps", ".app.json"]] as const) {
		const cachedPath = join(cacheDir, relativePath);
		let stats;
		try {
			stats = await lstat(cachedPath);
		} catch {
			return `plugin manifest ${name} companion file is missing at ${cachedPath}`;
		}
		if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
			return `plugin manifest ${name} companion file at ${cachedPath} is a symlink or not a regular file`;
		}
		if (!(await fileContentsEqual(cachedPath, join(packagedMarketplace.pluginRoot, relativePath), cacheDir))) {
			return `plugin manifest ${name} companion file content differs at ${cachedPath}`;
		}
	}
	return null;
}

export async function omxPluginCacheProvenanceReason(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
	expectedVersion?: string,
	options: { teamMode?: SetupTeamMode } = {},
): Promise<string | null> {
	const manifestReason = await omxPluginCacheManifestProvenanceReason(cacheDir, expectedVersion);
	if (manifestReason) return manifestReason;
	const companionReason = await omxPluginCacheCompanionMetadataProvenanceReason(cacheDir, packagedMarketplace);
	if (companionReason) return companionReason;
	const expectedSkillNames = await expectedPackagedOmxSkillNames(packagedMarketplace, options);
	if (!expectedSkillNames) return "packaged skill names are unavailable";
	const skillsReason = await omxPluginCacheSkillsProvenanceReason(cacheDir, packagedMarketplace, expectedSkillNames);
	if (skillsReason) return skillsReason;
	const assetReason = await omxPluginCacheExecutedAssetProvenanceReason(cacheDir);
	if (assetReason) return assetReason;
	if (!(await hasRegularPublicationMarker(cacheDir, ".omx-complete"))) {
		return `cache snapshot completion marker is malformed or does not match the immutable claim at ${cacheDir}`;
	}
	return null;
}

async function openManagedCacheNamespace(
	cacheBase: string,
	codexHomeDir: string,
	options: { create: boolean },
): Promise<{ handle: FileHandle; fdPath: string; path: string; handles: FileHandle[] } | null> {
	const managedNamespace = relative(resolve(codexHomeDir), resolve(cacheBase));
	if (!managedNamespace || managedNamespace.startsWith("..") || isAbsolute(managedNamespace)) {
		throw new Error(`Refusing to access an OMX plugin cache outside the Codex home: ${resolve(cacheBase)}`);
	}
	const noFollowFlags = fsConstants.O_NOFOLLOW;
	const directoryFlags = fsConstants.O_DIRECTORY;
	if (process.platform !== "win32" && (typeof noFollowFlags !== "number" || typeof directoryFlags !== "number")) {
		throw new Error("platform cannot provide no-follow directory anchoring for the OMX plugin cache namespace");
	}
	if (options.create) await mkdir(codexHomeDir, { recursive: true });
	let homeRealpath: string;
	try {
		homeRealpath = await realpath(codexHomeDir);
	} catch (error) {
		if (isMissingPathError(error) && !options.create) return null;
		throw error;
	}
	const handles: FileHandle[] = [];
	try {
		const homeRef = await openDirectoryRef(homeRealpath);
		handles.push(homeRef.handle);
		let parentRef = homeRef;
		for (const component of managedNamespace.split(sep).filter(Boolean)) {
			let childRef: DirectoryRef;
			try {
				childRef = await openDirectoryChild(parentRef, component);
			} catch (error) {
				if (!isMissingPathError(error) || !options.create) {
					if (isMissingPathError(error) && !options.create) {
						for (const handle of handles.reverse()) await handle.close();
						return null;
					}
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "ELOOP" || code === "ENOTDIR") {
						throw new Error(`Refusing to access OMX plugin cache through a symbolic link or non-directory namespace component: ${join(parentRef.path, component)}`);
					}
					throw error;
				}
				try {
					await mkdirDirectoryChild(parentRef, component);
				} catch (mkdirError) {
					if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
				}
				try {
					childRef = await openDirectoryChild(parentRef, component);
				} catch (retryError) {
					const code = (retryError as NodeJS.ErrnoException).code;
					if (code === "ELOOP" || code === "ENOTDIR") {
						throw new Error(`Refusing to access OMX plugin cache through a symbolic link or non-directory namespace component: ${join(parentRef.path, component)}`);
					}
					throw retryError;
				}
			}
			handles.push(childRef.handle);
			parentRef = childRef;
		}
		return { handle: parentRef.handle, fdPath: parentRef.mutationPath ?? parentRef.scanOperationPath, path: parentRef.path, handles };
	} catch (error) {
		for (const handle of handles.reverse()) {
			try { await handle.close(); } catch { /* preserve the primary failure */ }
		}
		throw error;
	}
}

async function inspectCacheRoot(cacheDir: string): Promise<"missing" | "directory" | "foreign" | "untrusted"> {
		try {
			const stats = await lstat(cacheDir);
			if (!stats.isDirectory() || stats.isSymbolicLink()) {
				return "untrusted";
			}
			if (await hasRegularPublicationMarker(cacheDir, ".omx-incomplete")) return "untrusted";
			if (!(await hasRegularPublicationMarker(cacheDir, ".omx-complete"))) return "directory";
			const manifest = await readRegularOmxPluginCacheManifest(cacheDir);
			if (!manifest) {
				const manifestPath = join(cacheDir, ".codex-plugin", "plugin.json");
				try {
					const manifestStats = await lstat(manifestPath);
					if (manifestStats.isSymbolicLink()) return "directory";
				} catch {
					// Treat missing or unreadable manifests as foreign cache entries.
				}
			}
			return manifest?.name === OMX_PLUGIN_NAME ? "directory" : "foreign";
		} catch (error) {
			if (isMissingPathError(error)) return "missing";
			throw error;
		}
}

async function validateStagedPluginSnapshot(
	snapshot: DirectoryRef,
	packagedMarketplace: PackagedOmxMarketplace,
	version: string,
	teamMode: SetupTeamMode | undefined,
): Promise<void> {
	const snapshotPath = snapshot.operationPath;
	const manifestReason = await omxPluginCacheManifestProvenanceReason(snapshotPath, version);
	if (manifestReason) throw new Error(`Packaged OMX plugin snapshot has invalid provenance: ${manifestReason}`);
	const expectedSkillNames = await expectedPackagedOmxSkillNames(packagedMarketplace, { teamMode });
	if (!expectedSkillNames) throw new Error("Packaged OMX plugin snapshot cannot determine expected skills");
	const skillsReason = await omxPluginCacheSkillsProvenanceReason(snapshotPath, packagedMarketplace, expectedSkillNames);
	if (skillsReason) throw new Error(`Packaged OMX plugin snapshot has invalid provenance: ${skillsReason}`);
	const companionReason = await omxPluginCacheCompanionMetadataProvenanceReason(snapshotPath, packagedMarketplace);
	if (companionReason) throw new Error(`Packaged OMX plugin snapshot has invalid provenance: ${companionReason}`);
	for (const relativePath of [".mcp.json", ".app.json", "hooks/hooks.json", "hooks/codex-native-hook.mjs", `hooks/${OMX_PLUGIN_HOOK_LAUNCHER_FILE}`]) {
		const path = join(snapshotPath, relativePath);
		let stats;
		try {
			stats = await lstat(path);
		} catch {
			throw new Error(`Packaged OMX plugin snapshot is missing required surface: ${path}`);
		}
		if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
			throw new Error(`Packaged OMX plugin snapshot has an invalid required surface: ${path}`);
		}
		if (await readOmxPluginCacheFileNoFollow(path, { anchorDir: snapshotPath }) === null) {
			throw new Error(`Packaged OMX plugin snapshot cannot read required surface: ${path}`);
		}
}
	for (const relativePath of [".mcp.json", ".app.json", "hooks/hooks.json"] as const) {
		const bytes = await readOmxPluginCacheFileNoFollow(join(snapshotPath, relativePath), { anchorDir: snapshotPath });
		try {
			if (!bytes) throw new Error("missing");
			JSON.parse(bytes.toString("utf-8"));
		} catch {
			throw new Error(`Packaged OMX plugin snapshot has invalid JSON: ${join(snapshot.path, relativePath)}`);
		}
	}
	if (!(await fileContentsEqual(join(snapshotPath, "hooks", "hooks.json"), join(packagedMarketplace.pluginRoot, "hooks", "hooks.json"), snapshotPath))) {
		throw new Error(`Packaged OMX plugin snapshot hooks.json differs from packaged hooks`);
	}
	if (!(await fileContentsEqual(join(snapshotPath, "hooks", "codex-native-hook.mjs"), join(packagedMarketplace.pluginRoot, "hooks", "codex-native-hook.mjs"), snapshotPath))) {
		throw new Error(`Packaged OMX plugin snapshot native hook differs from packaged hook`);
	}
	const launcherReason = await getPinnedLauncherIncompatibilityReason(snapshotPath, packagedMarketplace);
	if (launcherReason) throw new Error(`Packaged OMX plugin snapshot has invalid launcher provenance: ${launcherReason.reason}`);
}

async function stageCompletePluginSnapshot(
	stagingParent: DirectoryRef,
	packagedMarketplace: PackagedOmxMarketplace,
	version: string,
	teamMode: SetupTeamMode | undefined,
	tracker?: RegularFileDurabilityTracker,
): Promise<DirectoryRef> {
	await assertDirectoryRef(stagingParent, "snapshot staging");
	await mkdirDirectoryChildExclusive(stagingParent, "snapshot");
	const snapshot = await openDirectoryChild(stagingParent, "snapshot");
	try {
		await createExclusiveFileChild(snapshot, ".omx-incomplete", `${process.pid}\n`, tracker);
		const packagedSource = await openDirectoryRef(packagedMarketplace.pluginRoot);
		try {
			await copyPackagedTree(packagedSource, snapshot, tracker);
		} finally {
			await packagedSource.handle.close();
		}
		await assertDirectoryRef(snapshot, "snapshot staging");
		await applyTeamModeToPluginCache(snapshot, teamMode);
		const hooksDir = await openDirectoryChild(snapshot, "hooks");
		try {
			await writePinnedHookLauncher(hooksDir, packagedMarketplace, tracker);
		} finally {
			await hooksDir.handle.close();
		}
		await validateStagedPluginSnapshot(snapshot, packagedMarketplace, version, teamMode);
		return snapshot;
	} catch (error) {
		await snapshot.handle.close();
		throw error;
	}
}

export async function discoverOmxPluginCacheDirs(
	codexHomeDir: string,
): Promise<string[]> {
	const cacheRoot = join(codexHomeDir, "plugins", "cache");
	let cacheRootIdentity: { dev: number; ino: number };
	try {
		const cacheRootStats = await lstat(cacheRoot);
		if (!cacheRootStats.isDirectory() || cacheRootStats.isSymbolicLink()) return [];
		if (typeof cacheRootStats.dev !== "number" || typeof cacheRootStats.ino !== "number") return [];
		cacheRootIdentity = { dev: cacheRootStats.dev, ino: cacheRootStats.ino };
	} catch {
		return [];
	}

	const queue: Array<{ path: string; depth: number }> = [
		{ path: cacheRoot, depth: 0 },
	];
	const maxDepth = 5;
	const matches: string[] = [];

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) break;
		if (current.depth >= 2) {
			if (await hasRegularPublicationMarker(current.path, ".omx-incomplete")) continue;
			const manifest = await readRegularOmxPluginCacheManifest(current.path, cacheRoot);
			if (manifest?.name === OMX_PLUGIN_NAME) {
				if (!(await hasRegularPublicationMarker(current.path, ".omx-complete"))) continue;
				matches.push(current.path);
				continue;
			}
		}

		if (current.depth >= maxDepth) continue;

		let entries;
		try {
			entries = await readdir(current.path, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			// #3552 blocker 5: staging trees (`.omx-plugin-*` and reclaim
			// quarantines) live inside the scanned namespace only until
			// publication; discovery must never descend into them, so a
			// marker-committed snapshot can never be observed at its staging
			// path before the final no-replace publication.
			if (isPluginCacheStagingEntryName(entry.name)) continue;
			queue.push({
				path: join(current.path, entry.name),
				depth: current.depth + 1,
			});
		}
	}

	try {
		const finalRootStats = await lstat(cacheRoot);
		if (!finalRootStats.isDirectory() || finalRootStats.isSymbolicLink() || finalRootStats.dev !== cacheRootIdentity.dev || finalRootStats.ino !== cacheRootIdentity.ino) return [];
	} catch {
		return [];
	}
	return matches.sort();
}

export interface OmxPluginCacheState {
	cacheDir: string;
	manifestVersion: string | null;
	skillsPointer: string | null;
	skillNames: string[] | null;
	hooksPointer: string | null;
	mcpServersPointer: string | null;
	appsPointer: string | null;
	hookLauncherPinned: boolean;
}

async function readRegularCacheSkillNames(cacheDir: string): Promise<string[] | null> {
	const skillsDir = join(cacheDir, "skills");
	try {
		const skillsStats = await lstat(skillsDir);
		if (!skillsStats.isDirectory() || skillsStats.isSymbolicLink()) return null;
		const entries = await readdir(skillsDir, { withFileTypes: true });
		if (entries.some((entry) => entry.isSymbolicLink() || !entry.isDirectory())) return null;
		for (const entry of entries) {
			const skillFile = join(skillsDir, entry.name, "SKILL.md");
			const skillStats = await lstat(skillFile);
			if (!skillStats.isFile() || skillStats.isSymbolicLink() || skillStats.nlink !== 1) return null;
			if (await readOmxPluginCacheFileNoFollow(skillFile, { anchorDir: cacheDir }) === null) return null;
		}
		return entries.map((entry) => entry.name).sort();
	} catch {
		return null;
	}
}

async function cacheCompanionIsReadable(cacheDir: string, relativePath: ".mcp.json" | ".app.json"): Promise<boolean> {
	const bytes = await readOmxPluginCacheFileNoFollow(join(cacheDir, relativePath), { anchorDir: cacheDir });
	if (bytes === null) return false;
	try {
		JSON.parse(bytes.toString("utf-8"));
		return true;
	} catch {
		return false;
	}
}

export async function readOmxPluginCacheState(
	cacheDir: string,
	expectedVersion?: string,
): Promise<OmxPluginCacheState | null> {
	// #3552: never read cache state through a symlinked or non-directory snapshot root —
	// readFile-based manifest reads would follow an external target before provenance checks.
	// A missing pinned launcher is reported by the dedicated launcher checks, not here.
	const executedAssetReason = await omxPluginCacheExecutedAssetProvenanceReason(cacheDir);
	if (executedAssetReason) return null;
	if (await hasRegularPublicationMarker(cacheDir, ".omx-incomplete")) return null;
	if (await omxPluginCacheManifestProvenanceReason(cacheDir, expectedVersion)) return null;
	const manifest = await readRegularOmxPluginCacheManifest(cacheDir);
	if (manifest?.name !== OMX_PLUGIN_NAME) return null;
	if (expectedVersion !== undefined && manifest.version !== expectedVersion) return null;
	const skillNames = await readRegularCacheSkillNames(cacheDir);
	if (!skillNames) return null;
	if (!(await cacheCompanionIsReadable(cacheDir, ".mcp.json")) || !(await cacheCompanionIsReadable(cacheDir, ".app.json"))) return null;
	const launcher = await readPinnedLauncherRaw(cacheDir);
	if (
		launcher.error ||
		!launcher.parsed ||
		typeof launcher.parsed.command !== "string" ||
		launcher.parsed.command.trim() === "" ||
		!Array.isArray(launcher.parsed.argsPrefix) ||
		launcher.parsed.argsPrefix.length !== 1 ||
		typeof launcher.parsed.argsPrefix[0] !== "string" ||
		launcher.parsed.argsPrefix[0].trim() === "" ||
		Object.keys(launcher.parsed).some((key) => key !== "command" && key !== "argsPrefix")
	) return null;
	return {
		cacheDir,
		manifestVersion:
			typeof manifest.version === "string" ? manifest.version : null,
		skillsPointer: typeof manifest.skills === "string" ? manifest.skills : null,
		skillNames,
		hooksPointer: typeof manifest.hooks === "string" ? manifest.hooks : null,
		mcpServersPointer: typeof manifest.mcpServers === "string" ? manifest.mcpServers : null,
		appsPointer: typeof manifest.apps === "string" ? manifest.apps : null,
		hookLauncherPinned: true,
	};
}

export async function hasExpectedOmxPluginCache(
	codexHomeDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
	options: { teamMode?: SetupTeamMode; cacheDirOverride?: string } = {},
): Promise<boolean> {
	const [version, expectedSkillNames] = await Promise.all([
		packagedOmxPluginVersion(packagedMarketplace),
		expectedPackagedOmxSkillNames(packagedMarketplace, options),
	]);
	if (!version || !expectedSkillNames) return false;
	const state = await readOmxPluginCacheState(
		options.cacheDirOverride ?? join(omxPluginCacheBase(codexHomeDir), version),
		version,
	);
	if (!state) return false;
	if (
		state.manifestVersion !== version ||
		state.skillsPointer !== "./skills/" ||
		state.hooksPointer !== "./hooks/hooks.json" ||
		!state.hookLauncherPinned ||
		JSON.stringify(state.skillNames) !== JSON.stringify(expectedSkillNames)
	) {
		return false;
	}
	if (await omxPluginCacheProvenanceReason(state.cacheDir, packagedMarketplace, version, options)) {
		return false;
	}

	return pluginHookCacheMatchesPackaged(state.cacheDir, packagedMarketplace);
}

async function fileContentsEqual(leftPath: string, rightPath: string, anchorDir?: string): Promise<boolean> {
	const [left, right] = await Promise.all([
		readOmxPluginCacheFileNoFollow(leftPath, anchorDir ? { anchorDir } : {}),
		readOmxPluginCacheFileNoFollow(rightPath, { requireSingleLink: false }),
	]);
	return left !== null && right !== null && left.equals(right);
}


/**
 * Compares only plugin-scoped hook assets that Codex executes from the cache.
 * Manifest pointers and skill lists are validated by callers before using this
 * as a hook/launcher freshness predicate.
 *
 * #3552: the comparison is fail-closed about provenance — every executed asset
 * is lstat-validated as a regular file before it is read, so a symlinked asset
 * with byte-identical external content can no longer satisfy the unchanged
 * fast paths. `false` here means "do not trust this cache snapshot".
 */
export async function pluginHookCacheMatchesPackaged(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
): Promise<boolean> {
	if ((await omxPluginCacheExecutedAssetProvenanceReason(cacheDir)) !== null) {
		return false;
	}
	return await fileContentsEqual(
		join(cacheDir, "hooks", "hooks.json"),
		join(packagedMarketplace.pluginRoot, "hooks", "hooks.json"),
		cacheDir,
	) && await fileContentsEqual(
		join(cacheDir, "hooks", "codex-native-hook.mjs"),
		join(packagedMarketplace.pluginRoot, "hooks", "codex-native-hook.mjs"),
		cacheDir,
	) && await pinnedHookLauncherMatchesPackaged(
		cacheDir,
		packagedMarketplace,
	);
}

function buildPinnedHookLauncherContent(
	packagedMarketplace: PackagedOmxMarketplace,
): string {
	return `${JSON.stringify(
		{
			command: process.execPath,
			argsPrefix: [join(packagedMarketplace.packageRoot, "dist", "cli", "omx.js")],
		},
		null,
		2,
	)}\n`;
}

async function pinnedHookLauncherMatchesPackaged(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
): Promise<boolean> {
	return await readRegularFileTextNoFollow(
		join(cacheDir, "hooks", OMX_PLUGIN_HOOK_LAUNCHER_FILE),
		{ anchorDir: cacheDir },
	) === buildPinnedHookLauncherContent(packagedMarketplace);
}

async function writePinnedHookLauncher(
	hooksDir: DirectoryRef,
	packagedMarketplace: PackagedOmxMarketplace,
	tracker?: RegularFileDurabilityTracker,
): Promise<void> {
	// #3552 review 3859434238: the launcher is generated into a freshly
	// created staging snapshot, so it must be created exclusively; a
	// concurrent hard link at the staged path would otherwise let O_TRUNC
	// clobber a foreign inode before any provenance check.
	await createExclusiveFileChild(
		hooksDir,
		OMX_PLUGIN_HOOK_LAUNCHER_FILE,
		buildPinnedHookLauncherContent(packagedMarketplace),
		tracker,
	);
}

async function applyTeamModeToPluginCache(
	cacheDir: DirectoryRef,
	teamMode: SetupTeamMode | undefined,
): Promise<void> {
	if (teamModeEnabled(teamMode)) return;
	let skillsDir: DirectoryRef;
	try {
		skillsDir = await openDirectoryChild(cacheDir, "skills");
	} catch (error) {
		if (isMissingPathError(error)) return;
		throw error;
	}
	try {
		for (const skillName of TEAM_MODE_PLUGIN_SKILL_NAMES) {
			await removeChild(skillsDir, skillName, { recursive: true, force: true });
		}
	} finally {
		await skillsDir.handle.close();
	}
}

export interface OmxPluginCacheMaterializeResult {
	status: "unavailable" | "unchanged" | "materialized" | "stale-launcher";
	cacheDir?: string;
	version?: string;
	retiredDirs?: string[];
	preservedDirs?: string[];
	reason?: string;
	launcherTarget?: string;
}

export const PLUGIN_LAUNCHER_RECOVERY_HINT = "codex plugin remove oh-my-codex@oh-my-codex-local --json";

async function canonicalRealpath(path: string): Promise<string | null> {
	try {
		return await realpath(path);
	} catch {
		return null;
	}
}

export async function readPinnedLauncherRaw(cacheDir: string): Promise<{ raw: string | null; parsed: { command?: unknown; argsPrefix?: unknown } | null; error?: string }> {
	const launcherPath = join(cacheDir, "hooks", OMX_PLUGIN_HOOK_LAUNCHER_FILE);
	const raw = await readRegularFileTextNoFollow(launcherPath, { anchorDir: cacheDir });
	if (raw === null) {
		try {
			await lstat(launcherPath);
			return { raw: null, parsed: null, error: "cannot read pinned launcher" };
		} catch (e) {
			if (isMissingPathError(e)) return { raw: null, parsed: null, error: "missing pinned launcher" };
			return { raw: null, parsed: null, error: `cannot read pinned launcher: ${(e as Error).message}` };
		}
	}
	try {
		const parsed = JSON.parse(raw) as { command?: unknown; argsPrefix?: unknown };
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { raw, parsed: null, error: `malformed pinned launcher JSON: expected object but got ${Array.isArray(parsed) ? "array" : String(parsed)}` };
		}
		return { raw, parsed, error: undefined };
	} catch (e) {
		return { raw, parsed: null, error: `malformed pinned launcher JSON: ${(e as Error).message}` };
	}
}

export async function getPinnedLauncherIncompatibilityReason(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
): Promise<{ reason: string; target?: string } | null> {
	const hooksDir = join(cacheDir, "hooks");
	try {
		const hooksStats = await lstat(hooksDir);
		if (!hooksStats.isDirectory() || hooksStats.isSymbolicLink()) {
			return { reason: `hooks directory at ${hooksDir} is a symlink or not a directory; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
		}
	} catch (e) {
		if (isMissingPathError(e)) return { reason: `hooks directory missing at ${hooksDir}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
		return { reason: `cannot read hooks directory at ${hooksDir}: ${(e as Error).message}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
	}
	const launcherPath = join(cacheDir, "hooks", OMX_PLUGIN_HOOK_LAUNCHER_FILE);
	try {
		const launcherStats = await lstat(launcherPath);
		if (!launcherStats.isFile() || launcherStats.isSymbolicLink() || launcherStats.nlink !== 1) {
			return { reason: `pinned launcher at ${launcherPath} is a symlink or not a regular file; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
		}
	} catch (e) {
		if (isMissingPathError(e)) return { reason: `pinned launcher missing at ${launcherPath}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
		return { reason: `cannot read pinned launcher at ${launcherPath}: ${(e as Error).message}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
	}
	const raw = await readRegularFileTextNoFollow(launcherPath, { anchorDir: cacheDir });
	if (raw === null) {
		try {
			await lstat(launcherPath);
			return { reason: `cannot read pinned launcher at ${launcherPath}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
		} catch (e) {
			if (isMissingPathError(e)) return { reason: `pinned launcher missing at ${launcherPath}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
			return { reason: `cannot read pinned launcher at ${launcherPath}: ${(e as Error).message}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
		}
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (e) {
		return { reason: `pinned launcher at ${launcherPath} is malformed JSON (${(e as Error).message}); run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { reason: `pinned launcher at ${launcherPath} is malformed JSON (expected object but got ${Array.isArray(parsed) ? "array" : String(parsed)}); run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
	}
	const obj = parsed as { command?: unknown; argsPrefix?: unknown };
	const extraKeys = Object.keys(obj).filter((key) => key !== "command" && key !== "argsPrefix");
	if (extraKeys.length > 0) {
		return { reason: `pinned launcher at ${launcherPath} has extra keys (${extraKeys.sort().join(", ")}); run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
	}
	if (typeof obj.command !== "string" || obj.command.trim() === "") {
		return { reason: `pinned launcher at ${launcherPath} has invalid command; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
	}
	if (!Array.isArray(obj.argsPrefix) || obj.argsPrefix.length !== 1 || typeof obj.argsPrefix[0] !== "string" || obj.argsPrefix[0].trim() === "") {
		return { reason: `pinned launcher at ${launcherPath} has invalid argsPrefix (expected exactly one packaged omx.js target); run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
	}
	const command = obj.command.trim();
	const target = (obj.argsPrefix as string[])[0]!;
	// Validate command field (generated launcher contract) — fail-closed on dead/mismatched executable
	if (!isAbsolute(command)) {
		return { reason: `pinned launcher command is not absolute: ${command}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`, target };
	}
	if (!existsSync(command)) {
		return { reason: `pinned launcher command does not exist: ${command}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`, target };
	}
	const expectedCommand = process.execPath;
	const [canonicalActualCommand, canonicalExpectedCommand] = await Promise.all([
		canonicalRealpath(command),
		canonicalRealpath(expectedCommand),
	]);
	if (canonicalActualCommand === null || canonicalExpectedCommand === null || canonicalActualCommand !== canonicalExpectedCommand) {
		return { reason: `pinned launcher command provenance mismatch: expected ${expectedCommand} but found ${command} (different Node executable); run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`, target };
	}
	if (!isAbsolute(target)) {
		return { reason: `pinned launcher target is not absolute: ${target}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`, target };
	}
	if (!existsSync(target)) {
		return { reason: `pinned launcher target does not exist: ${target} (package root removed?); run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`, target };
	}
	const expectedTarget = join(packagedMarketplace.packageRoot, "dist", "cli", "omx.js");
	const [canonicalActual, canonicalExpected] = await Promise.all([
		canonicalRealpath(target),
		canonicalRealpath(expectedTarget),
	]);
	if (canonicalActual === null || canonicalExpected === null || canonicalActual !== canonicalExpected) {
		return { reason: `pinned launcher provenance mismatch: expected ${expectedTarget} but found ${target} (different package root); run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`, target };
	}
	return null;
}

export async function retireUnpinnedManagedSnapshots(
	codexHomeDir: string,
	currentVersion: string,
	anchoredCacheBaseRef?: DirectoryRef,
	publicationLockHeld = false,
	preservedDirs?: string[],
	heldPublicationLockGuard?: PublicationLockGuard,
): Promise<string[]> {
	const cacheBase = omxPluginCacheBase(codexHomeDir);
	const noFollowFlags = fsConstants.O_NOFOLLOW;
	const directoryFlags = fsConstants.O_DIRECTORY;
	if (process.platform !== "win32" && (typeof noFollowFlags !== "number" || typeof directoryFlags !== "number")) {
		throw new Error("platform cannot provide no-follow directory anchoring for cache retirement");
	}
	let baseRef = anchoredCacheBaseRef;
	let ownsBaseRef = false;
	let publicationLock: FileHandle | undefined;
	let publicationLockIdentity: Stats | undefined;
	const durability: RegularFileDurabilityTracker = { degraded: false };
	let publicationLockGuard: PublicationLockGuard | undefined = heldPublicationLockGuard;
	let ownsPublicationLockGuard = false;
	const candidateRefs: DirectoryRef[] = [];
	let cleanupError: unknown = null;
	try {
		if (!baseRef) {
			baseRef = await openDirectoryRef(cacheBase);
			ownsBaseRef = true;
		}
		if (!publicationLockHeld) {
			publicationLock = await claimPublicationLock(baseRef, cacheBase, noFollowFlags, durability);
			publicationLockIdentity = await publicationLock.stat();
			await refreshPublicationLockRecord(join(cacheBase, ".omx-publish.lock"), publicationLock, publicationLockIdentity!, durability);
			publicationLockGuard = startPublicationLockHeartbeat(join(cacheBase, ".omx-publish.lock"), publicationLock, publicationLockIdentity!, durability);
			ownsPublicationLockGuard = true;
		}
		await publicationLockGuard?.assertOwned();
		const entries = await readdir(baseRef.operationPath, { withFileTypes: true });
		const managed: Array<{ path: string; version: string; mtimeMs: number; ref: DirectoryRef; stats: Stats }> = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === currentVersion) continue;
			let candidateRef: DirectoryRef;
			try {
				candidateRef = await openDirectoryChild(baseRef, entry.name);
			} catch {
				continue;
			}
			const candidateStats = await candidateRef.handle.stat();
			if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink()) {
				await candidateRef.handle.close();
				continue;
			}
			candidateRefs.push(candidateRef);
			const manifest = await readRegularOmxPluginCacheManifest(candidateRef.operationPath, candidateRef.operationPath);
			if (manifest?.name !== OMX_PLUGIN_NAME || manifest.version !== entry.name) continue;
			if (!(await hasRegularPublicationMarker(candidateRef.operationPath, ".omx-complete")) || await hasRegularPublicationMarker(candidateRef.operationPath, ".omx-incomplete")) continue;
			if (!(await hasRegularPublicationMarker(candidateRef.operationPath, OMX_PLUGIN_MANAGED_MARKER))) continue;
			if (await readOmxPluginCacheFileNoFollow(join(candidateRef.operationPath, ".omx-live-pin"), { anchorDir: candidateRef.operationPath }) !== null) continue;
			managed.push({ path: join(cacheBase, entry.name), version: entry.name, mtimeMs: candidateStats.mtimeMs, ref: candidateRef, stats: candidateStats });
		}
		managed.sort((left, right) =>
			right.version.localeCompare(left.version, undefined, { numeric: true }) ||
			right.mtimeMs - left.mtimeMs,
		);
		const retired: string[] = [];
		for (const candidate of managed.slice(1)) {
			await publicationLockGuard?.assertOwned();
			await assertDirectoryRef(baseRef, "retirement");
			const currentStats = await candidate.ref.handle.stat();
			if (!currentStats.isDirectory() || currentStats.isSymbolicLink() || currentStats.dev !== candidate.stats.dev || currentStats.ino !== candidate.stats.ino) {
				throw new Error(`managed cache retirement target changed before removal: ${candidate.path}`);
			}
			if (await readOmxPluginCacheFileNoFollow(join(candidate.ref.operationPath, ".omx-live-pin"), { anchorDir: candidate.ref.operationPath }) !== null) {
				continue;
			}
			if (await removeChildIfIdentity(baseRef, candidate.version, currentStats, { recursive: true, force: true, expectedManagedVersion: candidate.version, preservedPaths: preservedDirs })) {
				retired.push(candidate.path);
			} else {
				preservedDirs?.push(candidate.path);
			}
		}
		return retired;
	} finally {
		if (ownsPublicationLockGuard && publicationLockGuard) clearInterval(publicationLockGuard.timer);
		for (const candidateRef of candidateRefs.reverse()) {
			try { await candidateRef.handle.close(); } catch (error) { cleanupError ??= error; }
		}
		if (publicationLock) {
			try { await publicationLock.close(); } catch (error) { cleanupError ??= error; }
			if (publicationLockIdentity) {
				const cur = await lstat(join(baseRef!.path, ".omx-publish.lock")).catch(() => null);
				if (
					cur &&
					cur.isFile() &&
					!cur.isSymbolicLink() &&
					cur.dev === publicationLockIdentity.dev &&
					cur.ino === publicationLockIdentity.ino
				) {
					try { await reclaimStalePublicationLock(baseRef!, ".omx-publish.lock", publicationLockIdentity, false); } catch (error) { cleanupError ??= error; }
				}
			}
		}
		emitDegradedDurabilityWarning("plugin cache publication", durability);
		if (ownsBaseRef && baseRef) {
			try { await baseRef.handle.close(); } catch (error) { cleanupError ??= error; }
		}
		if (cleanupError) throw cleanupError;
	}
}

interface MaterializePackagedOmxPluginCacheOptions {
	dryRun?: boolean;
	teamMode?: SetupTeamMode;
	onCacheDirPrepared?: (cacheDir: string) => void | Promise<void>;
	anchoredCacheBaseRef?: DirectoryRef;
	anchoredCacheDir?: string;
	cacheDirOverride?: string;
}

async function materializePackagedOmxPluginCacheImpl(
	codexHomeDir: string,
	packagedMarketplace: PackagedOmxMarketplace | null,
	options: MaterializePackagedOmxPluginCacheOptions = {},
): Promise<OmxPluginCacheMaterializeResult> {
	if (!packagedMarketplace) return { status: "unavailable" };
	const version = await packagedOmxPluginVersion(packagedMarketplace);
	if (!version) return { status: "unavailable" };
	const cacheDir = join(omxPluginCacheBase(codexHomeDir), version);
	const inspectedCacheDir = options.anchoredCacheDir ?? cacheDir;
	if (await hasExpectedOmxPluginCache(codexHomeDir, packagedMarketplace, {
		...options,
		cacheDirOverride: inspectedCacheDir,
	})) {
		return {
			status: "unchanged",
			cacheDir,
			version,
			retiredDirs: options.dryRun
				? []
				: await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBaseRef),
		};
	}
	// Same-version directory exists but is not byte-identical: distinguish immutable-preserved vs dead/provenance-incompatible launcher.
	// Preserve #3499 immutability: never rewrite an existing same-version directory in place.
	const rootState = await inspectCacheRoot(inspectedCacheDir);
	if (rootState === "untrusted") {
		return {
			status: "stale-launcher",
			cacheDir,
			version,
			reason: `OMX plugin cache root at ${cacheDir} is a symlink or non-directory entry; managed snapshots must be regular immutable directories; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`,
			launcherTarget: undefined,
			retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBaseRef),
		};
	}
	if (rootState === "directory") {
		const incompat = await getPinnedLauncherIncompatibilityReason(inspectedCacheDir, packagedMarketplace);
		if (incompat) {
			return {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: incompat.reason,
				launcherTarget: incompat.target,
				retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBaseRef),
			};
		}
		// #3699: an existing same-version snapshot is immutable, so a Team-mode change
		// cannot be republished in place. Report that limitation by name — before the
		// generic provenance reason, which would only say the skills directory differs —
		// instead of implying the requested mode is already installed.
		const teamModeSkillReason = await omxPluginCacheTeamModeSkillMismatchReason(
			inspectedCacheDir,
			packagedMarketplace,
			options.teamMode,
		);
		if (teamModeSkillReason) {
			return {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: `${teamModeSkillReason}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`,
				launcherTarget: undefined,
				retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBaseRef),
			};
		}
		const snapshotProvenanceReason = await omxPluginCacheProvenanceReason(
			inspectedCacheDir,
			packagedMarketplace,
			version,
			options,
		);
		if (snapshotProvenanceReason) {
			return {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: `${snapshotProvenanceReason}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`,
				launcherTarget: undefined,
				retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBaseRef),
			};
		}
		const assetProvenanceReason = await omxPluginCacheExecutedAssetProvenanceReason(inspectedCacheDir);
		if (assetProvenanceReason) {
			return {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: `${assetProvenanceReason}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`,
				launcherTarget: undefined,
				retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBaseRef),
			};
		}
		return {
			status: "unchanged",
			cacheDir,
			version,
			retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBaseRef),
		};
	}
	if (rootState === "foreign") {
		return { status: "unavailable", cacheDir, version };
	}
	if (!options.dryRun) {
		const cacheBase = omxPluginCacheBase(codexHomeDir);
		const noFollowFlags = fsConstants.O_NOFOLLOW;
		const directoryFlags = fsConstants.O_DIRECTORY;
		if (process.platform !== "win32" && (typeof noFollowFlags !== "number" || typeof directoryFlags !== "number")) {
			return {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: "platform cannot provide no-follow directory anchoring for immutable cache publication",
				launcherTarget: undefined,
				retiredDirs: [],
			};
		}
		let cacheBaseRef = options.anchoredCacheBaseRef;
		let ownsCacheBaseRef = false;
		if (!cacheBaseRef) {
			cacheBaseRef = await openDirectoryRef(cacheBase);
			ownsCacheBaseRef = true;
		}
		const durability: RegularFileDurabilityTracker = { degraded: false };
		let lockHandle: FileHandle;
		let lockIdentity: Stats;
		let publicationLockGuard: PublicationLockGuard | undefined;
		try {
			lockHandle = await claimPublicationLock(cacheBaseRef, cacheBase, noFollowFlags, durability);
			lockIdentity = await lockHandle.stat();
			// Keep heartbeatAt fresh while the critical section is held so a slow live
			// publisher is never reclaimed by a concurrent claimant after LEASE_MS.
			if (!await refreshPublicationLockRecord(join(cacheBaseRef.path, ".omx-publish.lock"), lockHandle, lockIdentity, durability)) {
				throw new Error(`publication lock ownership lost at ${join(cacheBaseRef.path, ".omx-publish.lock")}`);
			}
			publicationLockGuard = startPublicationLockHeartbeat(join(cacheBaseRef.path, ".omx-publish.lock"), lockHandle, lockIdentity, durability);
		} catch (error) {
			emitDegradedDurabilityWarning("plugin cache publication", durability);
			if (ownsCacheBaseRef) await cacheBaseRef.handle.close();
			return {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: `cannot claim immutable OMX plugin cache publication at ${cacheBase}: ${(error as Error).message}`,
				launcherTarget: undefined,
				retiredDirs: [],
			};
		}
		let tempName: string | undefined;
		let tempRef: DirectoryRef | undefined;
		let snapshotRef: DirectoryRef | undefined;
		let outcome: OmxPluginCacheMaterializeResult = {
			status: "materialized",
			cacheDir,
			version,
			retiredDirs: [],
		};
		let cleanupError: unknown = null;
		let finalRef: DirectoryRef | undefined;
		let claimRef: DirectoryRef | undefined;
		try {
			await publicationLockGuard.assertOwned();
			const candidateTempName = `.omx-plugin-${version}-${process.pid}-${randomUUID()}`;
			await mkdirDirectoryChildExclusive(cacheBaseRef, candidateTempName);
			await assertDirectoryRef(cacheBaseRef, "temporary staging");
			tempName = candidateTempName;
			tempRef = await openDirectoryChild(cacheBaseRef, tempName);
			snapshotRef = await stageCompletePluginSnapshot(tempRef, packagedMarketplace, version, options.teamMode, durability);
			await syncDirectoryTree(snapshotRef, durability);
			await options.onCacheDirPrepared?.(cacheDir);
			try {
				await publicationLockGuard.assertOwned();
				// #3552 blockers 3+5 / review 3860267789: never rename onto
				// `<version>` (rename silently replaces an empty destination and
				// pre/post inode checks cannot make it atomic). The destination is
				// claimed with an atomic exclusive mkdir self-described by
				// `.omx-incomplete`; the staged snapshot entries are then renamed
				// into that empty claim (destination names cannot pre-exist), and
				// `.omx-complete` is committed last inside the claim. Every trust
				// path requires `.omx-complete`, so no intermediate state is
				// trusted, and no pre-existing directory is ever replaced.
				try {
					claimRef = await claimPublicationDestination(cacheBaseRef, version, durability);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "EEXIST") {
						outcome = {
							status: "stale-launcher",
							cacheDir,
							version,
							reason: `same-version OMX plugin cache already exists at ${cacheDir}; refusing to replace or remove an existing directory; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`,
							launcherTarget: undefined,
							retiredDirs: [],
						};
					} else {
						throw error;
					}
				}
				if (claimRef) {
					// Drop the snapshot's staging marker and the claim's placeholder;
					// the claim is then populated only through exclusive creates and
					// the final marker is the trust switch.
					await removeChild(snapshotRef, ".omx-incomplete", { force: true });
					await removeChild(claimRef, ".omx-incomplete", { force: true });
					await assertDirectoryRef(claimRef, "publication claim");
					const claimEntries = await readdir(claimRef.scanOperationPath, { withFileTypes: true });
					if (claimEntries.length > 0) {
						throw new Error(`publication claim is not empty at ${join(cacheBaseRef.path, version)}`);
					}
					// The portable no-replace primitive is exclusive create, not rename.
					// Copy the private staged tree into the empty claim with exclusive
					// mkdir/O_EXCL file creation so a destination inserted between any
					// checks is rejected instead of overwritten.
					await copyStagedTreeNoReplace(snapshotRef, claimRef, durability);
					await snapshotRef.handle.close();
					snapshotRef = undefined;
					await createExclusiveFileChild(claimRef, OMX_PLUGIN_MANAGED_MARKER, `${process.pid}\n`, durability);
					await pluginCacheMutationTestHooks?.beforeFinalClaimValidation?.(claimRef.path);
					await publicationLockGuard.assertOwned();
					await validateStagedPluginSnapshot(claimRef, packagedMarketplace, version, options.teamMode);
					await pluginCacheMutationTestHooks?.beforeCompleteMarker?.(claimRef.path);
					await validateStagedPluginSnapshot(claimRef, packagedMarketplace, version, options.teamMode);
					await syncDirectoryTree(claimRef, durability);
					await publicationLockGuard.assertOwned();
					const claimDigest = await computeOmxPluginCacheClaimDigest(claimRef.path);
					await createExclusiveFileChild(claimRef, ".omx-complete", `${JSON.stringify({ version, claimDigest })}\n`, durability);
					const claimDirSyncOutcome = await syncDirectory(claimRef.handle);
					recordDirectorySyncOutcome(durability, claimDirSyncOutcome);
					await assertDirectoryRef(claimRef, "publication commit");
					finalRef = claimRef;
					const syncOutcome = await syncDirectory(cacheBaseRef.handle);
					recordDirectorySyncOutcome(durability, syncOutcome);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") {
					outcome = {
						status: "stale-launcher",
						cacheDir,
						version,
						reason: `same-version OMX plugin cache appeared concurrently at ${cacheDir}; refusing to replace an immutable cache`,
						launcherTarget: undefined,
						retiredDirs: [],
					};
				} else {
					throw error;
				}
			}
			if (outcome.status === "materialized") {
				try {
					await publicationLockGuard.assertOwned();
					const preservedDirs: string[] = [];
					outcome.retiredDirs = await retireUnpinnedManagedSnapshots(
						codexHomeDir,
						version,
						cacheBaseRef,
						true,
						preservedDirs,
						publicationLockGuard,
					);
					if (preservedDirs.length > 0) outcome.preservedDirs = preservedDirs;
				} catch (error) {
					outcome = {
						status: "stale-launcher",
						cacheDir,
						version,
						reason: `immutable OMX plugin cache retirement failed closed: ${(error as Error).message}`,
						launcherTarget: undefined,
						retiredDirs: [],
					};
				}
			}
		} catch (error) {
			outcome = {
			status: "stale-launcher",
			cacheDir,
			version,
			reason: `immutable OMX plugin cache publication failed closed: ${(error as Error).message}`,
			launcherTarget: undefined,
			retiredDirs: [],
		};
	} finally {
			if (publicationLockGuard) clearInterval(publicationLockGuard.timer);
			try { if (finalRef) await finalRef.handle.close(); } catch (error) { cleanupError ??= error; }
			if (claimRef && claimRef !== finalRef) {
				try { await claimRef.handle.close(); } catch (error) { cleanupError ??= error; }
			}
			try { if (snapshotRef) await snapshotRef.handle.close(); } catch (error) { cleanupError ??= error; }
			try { if (tempRef) await tempRef.handle.close(); } catch (error) { cleanupError ??= error; }
			try { if (tempName) await removeChild(cacheBaseRef, tempName, { recursive: true, force: true }); } catch (error) { cleanupError = error; }
			try { await lockHandle.close(); } catch (error) { cleanupError ??= error; }
			try {
				if (!lockIdentity) throw new Error(`publication lock identity unavailable at ${cacheBase}`);
				// Own-lock release must not quarantine a successor: only remove
				// if the file on disk still has the dev/ino we created.
				const cur = await lstat(join(cacheBaseRef.path, ".omx-publish.lock")).catch(() => null);
				if (
					cur &&
					cur.isFile() &&
					!cur.isSymbolicLink() &&
					cur.dev === lockIdentity.dev &&
					cur.ino === lockIdentity.ino
				) {
					await reclaimStalePublicationLock(cacheBaseRef, ".omx-publish.lock", lockIdentity, false);
				}
				const syncOutcome = await syncDirectory(cacheBaseRef.handle);
				recordDirectorySyncOutcome(durability, syncOutcome);
			} catch (error) { cleanupError ??= error; }
			if (ownsCacheBaseRef) {
				try { await cacheBaseRef.handle.close(); } catch (error) { cleanupError ??= error; }
			}
		}

		emitDegradedDurabilityWarning("plugin cache publication", durability);
		if (cleanupError) {
			return {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: `immutable OMX plugin cache publication cleanup failed closed: ${(cleanupError as Error).message}`,
				launcherTarget: undefined,
				retiredDirs: [],
			};
		}
		return outcome;
	}
	return {
		status: "materialized",
		cacheDir,
		version,
		retiredDirs: options.dryRun
			? []
			: await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBaseRef),
	};
}

export async function materializePackagedOmxPluginCache(
	codexHomeDir: string,
	packagedMarketplace: PackagedOmxMarketplace | null,
	options: MaterializePackagedOmxPluginCacheOptions = {},
): Promise<OmxPluginCacheMaterializeResult> {
	if (!packagedMarketplace) return { status: "unavailable" };
	const version = await packagedOmxPluginVersion(packagedMarketplace);
	if (!version) return { status: "unavailable" };
	const cacheBase = omxPluginCacheBase(codexHomeDir);
	const cacheDir = join(cacheBase, version);
	const noFollowFlags = fsConstants.O_NOFOLLOW;
	const directoryFlags = fsConstants.O_DIRECTORY;
	if (process.platform !== "win32" && (typeof noFollowFlags !== "number" || typeof directoryFlags !== "number")) {
		return {
			status: "stale-launcher",
			cacheDir,
			version,
			reason: "platform cannot provide no-follow directory anchoring for immutable cache validation/publication",
			launcherTarget: undefined,
			retiredDirs: [],
		};
	}
	let namespace: { handle: FileHandle; fdPath: string; path: string; handles: FileHandle[] } | null;
	try {
		namespace = await openManagedCacheNamespace(cacheBase, codexHomeDir, { create: !options.dryRun });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
			return {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: `cannot anchor OMX plugin cache namespace at ${cacheBase}: ${code}; refusing to trust or publish cache contents`,
				launcherTarget: undefined,
				retiredDirs: [],
			};
		}
		throw error;
	}
	if (!namespace) {
		return { status: "materialized", cacheDir, version, retiredDirs: [] };
	}
	const cacheBaseFdPath = namespace.fdPath;
	let result: OmxPluginCacheMaterializeResult;
	try {
		result = await materializePackagedOmxPluginCacheImpl(
			codexHomeDir,
			packagedMarketplace,
			{
				...options,
				anchoredCacheBaseRef: {
					handle: namespace.handle,
					path: namespace.path,
					operationPath: cacheBaseFdPath,
					scanOperationPath: cacheBaseFdPath,
					mutationPath: cacheBaseFdPath,
				},
				anchoredCacheDir: join(namespace.fdPath, version),
			},
		);
	} catch (error) {
		result = {
			status: "stale-launcher",
			cacheDir,
			version,
			reason: `anchored OMX plugin cache operation failed closed: ${(error as Error).message}`,
			launcherTarget: undefined,
			retiredDirs: [],
		};
	}
	let closeError: unknown = null;
	for (const handle of namespace.handles.reverse()) {
		try {
			await handle.close();
		} catch (error) {
			closeError ??= error;
		}
	}
	if (closeError) {
		return {
			status: "stale-launcher",
			cacheDir,
			version,
			reason: `anchored OMX plugin cache descriptor close failed closed: ${(closeError as Error).message}`,
			launcherTarget: undefined,
			retiredDirs: [],
		};
	}
	return result;
}

function marketplaceTableHeaderPattern(): RegExp {
	return new RegExp(
		`^\\s*\\[marketplaces\\.${OMX_LOCAL_MARKETPLACE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`,
	);
}

function isTomlTableHeader(line: string): boolean {
	return /^\s*\[/.test(line);
}

function stripTomlTablesByHeaderPattern(config: string, headerPattern: RegExp): string {
	const lines = config.split(/\r?\n/);
	const result: string[] = [];

	for (let index = 0; index < lines.length; ) {
		if (headerPattern.test(lines[index])) {
			index += 1;
			while (index < lines.length && !isTomlTableHeader(lines[index])) {
				index += 1;
			}
			continue;
		}

		result.push(lines[index]);
		index += 1;
	}

	return result.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function stripLocalOmxMarketplaceRegistration(config: string): string {
	return stripTomlTablesByHeaderPattern(config, marketplaceTableHeaderPattern());
}

export function buildLocalOmxMarketplaceRegistration(
	packageRoot: string,
): string {
	return [
		`[marketplaces.${OMX_LOCAL_MARKETPLACE_NAME}]`,
		`source_type = "local"`,
		`source = ${JSON.stringify(packageRoot)}`,
	].join("\n");
}

export function upsertLocalOmxMarketplaceRegistration(
	config: string,
	packageRoot: string,
): string {
	const stripped = stripLocalOmxMarketplaceRegistration(config).trimEnd();
	const registration = buildLocalOmxMarketplaceRegistration(packageRoot);
	return `${stripped ? `${stripped}\n\n` : ""}${registration}\n`;
}

function localPluginTableHeaderPattern(): RegExp {
	return new RegExp(
		`^\\s*\\[plugins\\.${JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`,
	);
}

function localPluginMcpServerTableHeaderPattern(serverName: string): RegExp {
	return new RegExp(
		`^\\s*\\[plugins\\.${JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.mcp_servers\\.${serverName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`,
	);
}
function localPluginScalarLinePattern(): RegExp {
	return new RegExp(
		`^\\s*${JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=.*$`,
	);
}

function localPluginScalarBooleanPattern(): RegExp {
	return new RegExp(
		`^\\s*${JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(true|false)\\s*(?:#.*)?$`,
	);
}

function tomlBooleanLiteralIsTrue(value: string): boolean {
	return /^\s*true\s*(?:#.*)?$/.test(value);
}

export function hasLocalOmxPluginEnablement(config: string): boolean {
	const modernHeaderPattern = localPluginTableHeaderPattern();
	const legacyScalarPattern = localPluginScalarBooleanPattern();
	const lines = config.split(/\r?\n/);
	let inLocalPluginTable = false;
	let inPluginsTable = false;

	for (const line of lines) {
		if (isTomlTableHeader(line)) {
			inLocalPluginTable = modernHeaderPattern.test(line);
			inPluginsTable = /^\s*\[plugins\]\s*$/.test(line);
			continue;
		}

		if (inLocalPluginTable) {
			const enabled = /^\s*enabled\s*=\s*(.*)$/.exec(line);
			if (enabled && tomlBooleanLiteralIsTrue(enabled[1])) return true;
		}

		if (inPluginsTable) {
			const legacy = legacyScalarPattern.exec(line);
			if (legacy?.[1] === "true") return true;
		}
	}

	return false;
}

function removeLocalOmxPluginLegacyScalar(config: string): string {
	const scalarPattern = localPluginScalarLinePattern();
	const lines = config.split(/\r?\n/);
	const result: string[] = [];
	let inPluginsTable = false;

	for (const line of lines) {
		if (isTomlTableHeader(line)) {
			inPluginsTable = /^\s*\[plugins\]\s*$/.test(line);
			result.push(line);
			continue;
		}

		if (inPluginsTable && scalarPattern.test(line)) continue;
		result.push(line);
	}

	return result.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}


export function hasLocalOmxPluginMcpServerRegistrations(config: string): boolean {
	const lines = config.split(/\r?\n/);
	return OMX_FIRST_PARTY_MCP_SERVER_NAMES.some((serverName) =>
		lines.some((line) => localPluginMcpServerTableHeaderPattern(serverName).test(line)),
	);
}

export function stripLocalOmxPluginMcpServerRegistrations(config: string): string {
	let next = config;
	for (const serverName of OMX_FIRST_PARTY_MCP_SERVER_NAMES) {
		next = stripTomlTablesByHeaderPattern(
			next,
			localPluginMcpServerTableHeaderPattern(serverName),
		);
	}
	return next;
}

function upsertTomlTableBooleanKey(
	config: string,
	header: string,
	headerPattern: RegExp,
	key: string,
	value: boolean,
	options: { create: boolean },
): string {
	const lines = config.split(/\r?\n/);
	const start = lines.findIndex((line) => headerPattern.test(line));

	if (start < 0) {
		if (!options.create) return config;
		const base = config.trimEnd();
		return `${base ? `${base}\n\n` : ""}${header}\n${key} = ${value ? "true" : "false"}\n`;
	}

	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) {
		if (isTomlTableHeader(lines[index])) {
			end = index;
			break;
		}
	}

	let keyIndex = -1;
	for (let index = start + 1; index < end; index += 1) {
		if (new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`).test(lines[index])) {
			if (keyIndex < 0) {
				keyIndex = index;
				lines[index] = `${key} = ${value ? "true" : "false"}`;
			} else {
				lines.splice(index, 1);
				index -= 1;
				end -= 1;
			}
		}
	}

	if (keyIndex < 0) {
		lines.splice(start + 1, 0, `${key} = ${value ? "true" : "false"}`);
	}

	return lines.join("\n").replace(/\n*$/, "\n");
}

export function upsertLocalOmxPluginEnablement(config: string): string {
	const normalized = removeLocalOmxPluginLegacyScalar(config);
	const stripped = stripTomlTablesByHeaderPattern(
		normalized,
		localPluginTableHeaderPattern(),
	).trimEnd();
	return `${stripped ? `${stripped}\n\n` : ""}[plugins.${JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY)}]\nenabled = true\n`;
}

export function upsertLocalOmxPluginMcpServerEnablement(
	config: string,
	enabled: boolean,
	options: { removeWhenDisabled?: boolean } = {},
): string {
	if (!enabled && options.removeWhenDisabled) {
		const stripped = stripLocalOmxPluginMcpServerRegistrations(config);
		return stripped ? `${stripped}\n` : "";
	}
	if (!enabled) {
		return config;
	}
	let next = stripLocalOmxPluginMcpServerRegistrations(config);
	for (const serverName of OMX_FIRST_PARTY_MCP_SERVER_NAMES) {
		const header = `[plugins.${JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY)}.mcp_servers.${serverName}]`;
		const headerPattern = localPluginMcpServerTableHeaderPattern(serverName);
		next = upsertTomlTableBooleanKey(next, header, headerPattern, "enabled", enabled, {
			create: enabled,
		});
	}
	return next;
}
