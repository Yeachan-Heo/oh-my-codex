import { existsSync } from "fs";
import { cp, link, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { OMX_FIRST_PARTY_MCP_SERVER_NAMES } from "../config/omx-first-party-mcp.js";
import { teamModeEnabled, type SetupTeamMode } from "../config/team-mode.js";

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
}

const OMX_PLUGIN_HOOK_LAUNCHER_FILE = "omx-command.json";
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

export async function packagedOmxPluginVersion(
	packagedMarketplace: PackagedOmxMarketplace,
): Promise<string | null> {
	const manifest = await readPluginManifest(packagedMarketplace.pluginManifestPath);
	return typeof manifest?.version === "string" && manifest.version.trim()
		? manifest.version.trim()
		: null;
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

export function isOmxPluginCacheVersionEntryName(name: string): boolean {
	return /^(?:local|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.test(name);
}

const OMX_PLUGIN_CACHE_LOCK_RETRY_MS = 25;
const OMX_PLUGIN_CACHE_LOCK_TIMEOUT_MS = 30_000;

interface OmxPluginCacheLockOwner {
	token: string;
	pid: number;
}

interface OmxPluginCacheLock extends OmxPluginCacheLockOwner {
	path: string;
}

type OmxPluginCacheOwnerRecordState =
	| { kind: "valid"; owner: OmxPluginCacheLockOwner }
	| { kind: "missing" }
	| { kind: "malformed"; raw: string }
	| { kind: "unreadable"; error: unknown };

function pluginCacheNamespaceRoot(cacheDir: string): string {
	let candidate = cacheDir;
	for (;;) {
		if (basename(candidate) === OMX_PLUGIN_NAME) return candidate;
		const parent = dirname(candidate);
		if (parent === candidate) {
			throw new Error(`OMX plugin cache path is outside the managed namespace: ${cacheDir}`);
		}
		candidate = parent;
	}
}

async function assertPluginCacheNamespaceHasNoSymlinkAncestors(
	cacheDir: string,
): Promise<void> {
	const namespaceRoot = pluginCacheNamespaceRoot(cacheDir);
	const marketplaceRoot = dirname(namespaceRoot);
	const cacheRoot = dirname(marketplaceRoot);
	const pluginsRoot = dirname(cacheRoot);
	for (const candidate of [pluginsRoot, cacheRoot, marketplaceRoot, namespaceRoot]) {
		try {
			const stats = await lstat(candidate);
			if (!stats.isDirectory()) {
				throw new Error(
					`Refusing to mutate an OMX plugin cache through a non-directory namespace component: ${candidate}`,
				);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

function pluginCacheLockPath(cacheDir: string): string {
	return `${pluginCacheNamespaceRoot(cacheDir)}.omx-refresh.lock`;
}

async function inspectPluginCacheOwnerRecord(
	recordPath: string,
): Promise<OmxPluginCacheOwnerRecordState> {
	let raw: string;
	try {
		raw = await readFile(recordPath, "utf-8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { kind: "missing" }
			: { kind: "unreadable", error };
	}
	try {
		const parsed = JSON.parse(raw) as { token?: unknown; pid?: unknown };
		return typeof parsed.token === "string" &&
			parsed.token.length > 0 &&
			Number.isSafeInteger(parsed.pid) &&
			(parsed.pid as number) > 0 &&
			(parsed.pid as number) <= 0x7fffffff
			? { kind: "valid", owner: { token: parsed.token, pid: parsed.pid as number } }
			: { kind: "malformed", raw };
	} catch {
		return { kind: "malformed", raw };
	}
}

async function inspectPluginCacheLockOwner(
	lockPath: string,
): Promise<OmxPluginCacheOwnerRecordState> {
	return inspectPluginCacheOwnerRecord(join(lockPath, "owner.json"));
}

async function inspectPluginCacheReaperOwner(
	lockPath: string,
): Promise<OmxPluginCacheOwnerRecordState> {
	return inspectPluginCacheOwnerRecord(join(lockPath, "reaper.json"));
}

function pluginCacheOwnerRecordStatesMatch(
	left: OmxPluginCacheOwnerRecordState,
	right: OmxPluginCacheOwnerRecordState,
): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "missing") return true;
	if (left.kind === "malformed" && right.kind === "malformed") {
		return left.raw === right.raw;
	}
	if (left.kind === "valid" && right.kind === "valid") {
		return left.owner.token === right.owner.token && left.owner.pid === right.owner.pid;
	}
	return false;
}

async function readPluginCacheLockOwner(
	lockPath: string,
): Promise<OmxPluginCacheLockOwner | null> {
	const state = await inspectPluginCacheLockOwner(lockPath);
	return state.kind === "valid" ? state.owner : null;
}

async function readPluginCacheReaperOwner(
	lockPath: string,
): Promise<OmxPluginCacheLockOwner | null> {
	const state = await inspectPluginCacheReaperOwner(lockPath);
	return state.kind === "valid" ? state.owner : null;
}

function processIsDead(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

async function sleepForPluginCacheLock(): Promise<void> {
	await new Promise<void>((resolveSleep) =>
		setTimeout(resolveSleep, OMX_PLUGIN_CACHE_LOCK_RETRY_MS),
	);
}

async function recoverOrphanedPluginCacheReaper(
	lockPath: string,
	takeoverToken: string,
): Promise<void> {
	const observed = await inspectPluginCacheReaperOwner(lockPath);
	if (observed.kind === "missing") return;
	if (observed.kind === "unreadable") throw observed.error;
	if (observed.kind === "valid" && !processIsDead(observed.owner.pid)) return;
	const reaperPath = join(lockPath, "reaper.json");
	const quarantinePath = join(lockPath, `reaper-stale-${takeoverToken}.json`);
	try {
		await rename(reaperPath, quarantinePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const moved = await inspectPluginCacheOwnerRecord(quarantinePath);
	if (!pluginCacheOwnerRecordStatesMatch(observed, moved)) {
		await rename(quarantinePath, reaperPath).catch(() => undefined);
		return;
	}
	await rm(quarantinePath, { force: true });
}

async function withPluginCacheReaperClaim(
	lockPath: string,
	reaperToken: string,
	operation: () => Promise<boolean>,
): Promise<boolean> {
	const reaperPath = join(lockPath, "reaper.json");
	const candidatePath = join(lockPath, `reaper-candidate-${reaperToken}.json`);
	let claimedReaper = false;
	try {
		await recoverOrphanedPluginCacheReaper(lockPath, reaperToken);
		await writeFile(
			candidatePath,
			`${JSON.stringify({ token: reaperToken, pid: process.pid }, null, 2)}\n`,
			{ flag: "wx" },
		);
		try {
			await link(candidatePath, reaperPath);
			claimedReaper = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
		const claimedOwner = await readPluginCacheReaperOwner(lockPath);
		if (claimedOwner?.token !== reaperToken) return false;

		return await operation();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	} finally {
		await rm(candidatePath, { force: true }).catch(() => undefined);
		if (claimedReaper) {
			try {
				const reaper = JSON.parse(await readFile(reaperPath, "utf-8")) as {
					token?: unknown;
				};
				if (reaper.token === reaperToken) await rm(reaperPath, { force: true });
			} catch {
				// The lock may already have moved to its stale quarantine path.
			}
		}
	}
}

async function tryReapDeadPluginCacheLock(
	lockPath: string,
	reaperToken: string,
): Promise<boolean> {
	return withPluginCacheReaperClaim(lockPath, reaperToken, async () => {
		const owner = await readPluginCacheLockOwner(lockPath);
		if (!owner || !processIsDead(owner.pid)) return false;
		const stalePath = `${lockPath}.stale-${reaperToken}`;
		await rename(lockPath, stalePath);
		const movedOwner = await readPluginCacheLockOwner(stalePath);
		if (movedOwner?.token !== owner.token) {
			throw new Error(`OMX plugin cache refresh lock changed during stale recovery: ${lockPath}`);
		}
		await rm(stalePath, { recursive: true, force: true });
		return true;
	});
}

async function tryReapInvalidPluginCacheLock(
	lockPath: string,
	reaperToken: string,
): Promise<boolean> {
	return withPluginCacheReaperClaim(lockPath, reaperToken, async () => {
		const ownerState = await inspectPluginCacheLockOwner(lockPath);
		if (ownerState.kind === "valid") return false;
		if (ownerState.kind === "unreadable") throw ownerState.error;

		const stalePath = `${lockPath}.stale-${reaperToken}`;
		await rename(lockPath, stalePath);
		const movedReaper = await readPluginCacheReaperOwner(stalePath);
		const movedOwnerState = await inspectPluginCacheLockOwner(stalePath);
		if (
			movedReaper?.token !== reaperToken ||
			!pluginCacheOwnerRecordStatesMatch(ownerState, movedOwnerState)
		) {
			throw new Error(`OMX plugin cache refresh lock changed during invalid-owner recovery: ${lockPath}`);
		}
		await rm(stalePath, { recursive: true, force: true });
		return true;
	});
}

async function acquirePluginCacheLock(
	cacheDir: string,
): Promise<OmxPluginCacheLock> {
	const lockPath = pluginCacheLockPath(cacheDir);
	const token = `${process.pid}-${randomUUID()}`;
	const deadline = Date.now() + OMX_PLUGIN_CACHE_LOCK_TIMEOUT_MS;
	await assertPluginCacheNamespaceHasNoSymlinkAncestors(cacheDir);
	await mkdir(dirname(lockPath), { recursive: true });
	await assertPluginCacheNamespaceHasNoSymlinkAncestors(cacheDir);

	for (;;) {
		const candidatePath = `${lockPath}.candidate-${token}`;
		try {
			await mkdir(candidatePath);
			await writeFile(
				join(candidatePath, "owner.json"),
				`${JSON.stringify({ token, pid: process.pid }, null, 2)}\n`,
				{ flag: "wx" },
			);
			await rename(candidatePath, lockPath);
			return { path: lockPath, token, pid: process.pid };
		} catch (error) {
			await rm(candidatePath, { recursive: true, force: true }).catch(() => undefined);
			const code = (error as NodeJS.ErrnoException).code;
			if (
				code !== "EEXIST" &&
				code !== "ENOTEMPTY" &&
				code !== "ENOTDIR" &&
				code !== "EACCES" &&
				code !== "EPERM"
			) throw error;
			let lockStats;
			try {
				lockStats = await lstat(lockPath);
			} catch (lockStatError) {
				if (
					(lockStatError as NodeJS.ErrnoException).code === "ENOENT" &&
					(code === "EEXIST" || code === "ENOTEMPTY")
				) continue;
				throw error;
			}
			if (!lockStats.isDirectory()) {
				throw new Error(
					`Refusing to replace a non-directory OMX plugin cache refresh lock: ${lockPath}`,
					{ cause: error },
				);
			}

			const observedOwnerState = await inspectPluginCacheLockOwner(lockPath);
			if (observedOwnerState.kind === "unreadable") throw observedOwnerState.error;
			if (
				observedOwnerState.kind !== "valid" &&
				await tryReapInvalidPluginCacheLock(lockPath, token)
			) continue;
			const observedOwner = observedOwnerState.kind === "valid"
				? observedOwnerState.owner
				: null;
			if (
				observedOwner &&
				processIsDead(observedOwner.pid) &&
				await tryReapDeadPluginCacheLock(lockPath, token)
			) continue;

			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting for OMX plugin cache refresh lock: ${lockPath}`);
			}
			await sleepForPluginCacheLock();
		}
	}
}

async function releasePluginCacheLock(lock: OmxPluginCacheLock): Promise<void> {
	const owner = await readPluginCacheLockOwner(lock.path);
	if (owner?.token !== lock.token) {
		throw new Error(`OMX plugin cache refresh lock ownership was lost: ${lock.path}`);
	}
	const releasedPath = `${lock.path}.released-${lock.token}`;
	await rename(lock.path, releasedPath);
	const releasedOwner = await readPluginCacheLockOwner(releasedPath);
	if (releasedOwner?.token !== lock.token) {
		throw new Error(`OMX plugin cache refresh lock changed during release: ${lock.path}`);
	}
	await rm(releasedPath, { recursive: true, force: true });
}

async function withPluginCacheLock<T>(
	cacheDir: string,
	operation: () => Promise<T>,
): Promise<T> {
	const lock = await acquirePluginCacheLock(cacheDir);
	let operationError: unknown;
	try {
		await assertPluginCacheNamespaceHasNoSymlinkAncestors(cacheDir);
		return await operation();
	} catch (error) {
		operationError = error;
		throw error;
	} finally {
		try {
			await releasePluginCacheLock(lock);
		} catch (releaseError) {
			if (operationError !== undefined) {
				throw new AggregateError(
					[operationError, releaseError],
					`OMX plugin cache operation and lock release both failed: ${cacheDir}`,
				);
			}
			throw releaseError;
		}
	}
}

export async function discoverOmxPluginCacheDirs(
	codexHomeDir: string,
): Promise<string[]> {
	const cacheRoot = omxPluginCacheBase(codexHomeDir);
	if (!existsSync(cacheRoot)) return [];

	const queue: Array<{ path: string; depth: number; namespaceVersionRoot?: boolean }> = [
		{ path: cacheRoot, depth: 0 },
	];
	const maxDepth = 5;
	const matches: string[] = [];

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) break;

		let matchedPluginRoot = current.namespaceVersionRoot === true;
		const manifestPath = join(current.path, ".codex-plugin", "plugin.json");
		if (existsSync(manifestPath)) {
			const manifest = await readPluginManifest(manifestPath);
			if (manifest?.name === OMX_PLUGIN_NAME) {
				matchedPluginRoot = true;
			}
		}
		if (
			current.path === cacheRoot &&
			(
				existsSync(join(current.path, "hooks", "codex-native-hook.mjs")) ||
				existsSync(join(current.path, "hooks", "hooks.json")) ||
				existsSync(join(current.path, "skills"))
			)
		) matchedPluginRoot = true;
		if (matchedPluginRoot) matches.push(current.path);

		if (current.depth >= maxDepth) continue;

		let entries;
		try {
			entries = await readdir(current.path, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}

		const isOmxNamespaceRoot = basename(current.path) === OMX_PLUGIN_NAME;
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			if (
				(matchedPluginRoot || isOmxNamespaceRoot) &&
				!isOmxPluginCacheVersionEntryName(entry.name)
			) continue;
			queue.push({
				path: join(current.path, entry.name),
				depth: current.depth + 1,
				namespaceVersionRoot:
					(isOmxNamespaceRoot || matchedPluginRoot) &&
					isOmxPluginCacheVersionEntryName(entry.name),
			});
		}
	}

	return matches.sort();
}

export interface OmxPluginCacheState {
	cacheDir: string;
	manifestVersion: string | null;
	skillsPointer: string | null;
	skillNames: string[] | null;
	hooksPointer: string | null;
	hookLauncherPinned: boolean;
}

export async function readOmxPluginCacheState(
	cacheDir: string,
): Promise<OmxPluginCacheState | null> {
	const manifest = await readPluginManifest(
		join(cacheDir, ".codex-plugin", "plugin.json"),
	);
	if (manifest?.name !== OMX_PLUGIN_NAME) return null;
	return {
		cacheDir,
		manifestVersion:
			typeof manifest.version === "string" ? manifest.version : null,
		skillsPointer: typeof manifest.skills === "string" ? manifest.skills : null,
		skillNames: await listChildDirectoryNames(join(cacheDir, "skills")),
		hooksPointer: typeof manifest.hooks === "string" ? manifest.hooks : null,
		hookLauncherPinned: existsSync(
			join(cacheDir, "hooks", OMX_PLUGIN_HOOK_LAUNCHER_FILE),
		),
	};
}

export async function hasExpectedOmxPluginCache(
	codexHomeDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
	options: { teamMode?: SetupTeamMode } = {},
): Promise<boolean> {
	const [version, expectedSkillNames] = await Promise.all([
		packagedOmxPluginVersion(packagedMarketplace),
		expectedPackagedOmxSkillNames(packagedMarketplace, options),
	]);
	if (!version || !expectedSkillNames) return false;
	const state = await readOmxPluginCacheState(
		join(omxPluginCacheBase(codexHomeDir), version),
	);
	if (
		state?.manifestVersion !== version ||
		state.skillsPointer !== "./skills/" ||
		state.hooksPointer !== "./hooks/hooks.json" ||
		!state.hookLauncherPinned ||
		!existsSync(join(state.cacheDir, "hooks", "hooks.json")) ||
		!existsSync(join(state.cacheDir, "hooks", "codex-native-hook.mjs")) ||
		JSON.stringify(state.skillNames) !== JSON.stringify(expectedSkillNames)
	) {
		return false;
	}

	return pluginCacheContentsMatchPackaged(
		state.cacheDir,
		packagedMarketplace,
		options,
	);
}

async function fileContentsEqual(leftPath: string, rightPath: string): Promise<boolean> {
	try {
		const [left, right] = await Promise.all([
			readFile(leftPath),
			readFile(rightPath),
		]);
		return left.equals(right);
	} catch {
		return false;
	}
}

interface CollectPluginTreeOptions {
	excludeDisabledTeamSkills?: boolean;
	ignoreTopLevelVersionRoots?: boolean;
	ignoreAtomicTemps?: boolean;
}

async function collectPluginTree(
	root: string,
	options: CollectPluginTreeOptions,
	segments: string[] = [],
	entries = new Map<string, Buffer>(),
): Promise<Map<string, Buffer>> {
	const children = await readdir(root, { withFileTypes: true });
	children.sort((left, right) => left.name.localeCompare(right.name));
	for (const child of children) {
		if (
			segments.length === 0 &&
			options.ignoreTopLevelVersionRoots &&
			isOmxPluginCacheVersionEntryName(child.name) &&
			(child.isDirectory() || child.isSymbolicLink())
		) continue;
		if (
			options.ignoreAtomicTemps &&
			isOmxAtomicTempEntryName(child.name)
		) continue;
		if (
			options.excludeDisabledTeamSkills &&
			segments.length === 1 &&
			segments[0] === "skills" &&
			TEAM_MODE_PLUGIN_SKILL_NAMES.has(child.name)
		) continue;

		const childSegments = [...segments, child.name];
		const key = childSegments.join("/");
		const childPath = join(root, child.name);
		if (child.isDirectory()) {
			entries.set(`${key}/`, Buffer.from("directory"));
			await collectPluginTree(childPath, options, childSegments, entries);
		} else if (child.isFile()) {
			entries.set(key, await readFile(childPath));
		} else {
			entries.set(key, Buffer.from(`unsupported:${child.isSymbolicLink() ? "symlink" : "other"}`));
		}
	}
	return entries;
}

function pluginTreeMapsEqual(
	left: ReadonlyMap<string, Buffer>,
	right: ReadonlyMap<string, Buffer>,
): boolean {
	if (left.size !== right.size) return false;
	for (const [key, leftValue] of left) {
		const rightValue = right.get(key);
		if (!rightValue?.equals(leftValue)) return false;
	}
	return true;
}

export async function pluginCacheContentsMatchPackaged(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
	options: { teamMode?: SetupTeamMode } = {},
): Promise<boolean> {
	try {
		const [expected, actual] = await Promise.all([
			collectPluginTree(packagedMarketplace.pluginRoot, {
				excludeDisabledTeamSkills: !teamModeEnabled(options.teamMode),
			}),
			collectPluginTree(cacheDir, {
				ignoreTopLevelVersionRoots: true,
				ignoreAtomicTemps: true,
			}),
		]);
		expected.set(
			`hooks/${OMX_PLUGIN_HOOK_LAUNCHER_FILE}`,
			Buffer.from(buildPinnedHookLauncherContent(packagedMarketplace)),
		);
		return pluginTreeMapsEqual(expected, actual);
	} catch {
		return false;
	}
}

/**
 * Compares only plugin-scoped hook assets that Codex executes from the cache.
 * Manifest pointers and skill lists are validated by callers before using this
 * as a hook/launcher freshness predicate.
 */
export async function pluginHookCacheMatchesPackaged(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
): Promise<boolean> {
	return await fileContentsEqual(
		join(cacheDir, "hooks", "hooks.json"),
		join(packagedMarketplace.pluginRoot, "hooks", "hooks.json"),
	) && await fileContentsEqual(
		join(cacheDir, "hooks", "codex-native-hook.mjs"),
		join(packagedMarketplace.pluginRoot, "hooks", "codex-native-hook.mjs"),
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
	try {
		return await readFile(
			join(cacheDir, "hooks", OMX_PLUGIN_HOOK_LAUNCHER_FILE),
			"utf-8",
		) === buildPinnedHookLauncherContent(packagedMarketplace);
	} catch {
		return false;
	}
}

async function writePinnedHookLauncher(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
): Promise<void> {
	await writeFile(
		join(cacheDir, "hooks", OMX_PLUGIN_HOOK_LAUNCHER_FILE),
		buildPinnedHookLauncherContent(packagedMarketplace),
	);
}

async function pathIsDirectory(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isDirectory();
	} catch {
		return false;
	}
}

interface PluginCacheRootIdentity {
	path: string;
	dev: number | bigint;
	ino: number | bigint;
}

function pluginCacheRootIdentity(
	path: string,
	stats: Awaited<ReturnType<typeof lstat>>,
): PluginCacheRootIdentity {
	return { path, dev: stats.dev, ino: stats.ino };
}

async function readPluginCacheRootIdentity(
	path: string,
): Promise<PluginCacheRootIdentity | null> {
	try {
		const stats = await lstat(path);
		if (!stats.isDirectory()) {
			throw new Error(`Refusing to overlay a non-directory plugin cache root: ${path}`);
		}
		return pluginCacheRootIdentity(path, stats);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function ensureRealDirectoryRoot(path: string): Promise<Awaited<ReturnType<typeof lstat>>> {
	try {
		const stats = await lstat(path);
		if (!stats.isDirectory()) {
			throw new Error(`Refusing to overlay a non-directory plugin cache root: ${path}`);
		}
		return stats;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(path, { recursive: true });
	const stats = await lstat(path);
	if (!stats.isDirectory()) {
		throw new Error(`Refusing to overlay a non-directory plugin cache root: ${path}`);
	}
	return stats;
}

async function assertPluginCacheRootIdentity(
	identity: PluginCacheRootIdentity,
): Promise<void> {
	const stats = await lstat(identity.path);
	if (
		!stats.isDirectory() ||
		stats.dev !== identity.dev ||
		stats.ino !== identity.ino
	) {
		throw new Error(`OMX plugin cache root identity changed during refresh: ${identity.path}`);
	}
}

async function copyFileAtomically(sourcePath: string, destinationPath: string): Promise<void> {
	const tempPath = join(
		dirname(destinationPath),
		`.${basename(destinationPath)}.omx-atomic-${process.pid}-${randomUUID()}`,
	);
	try {
		await cp(sourcePath, tempPath, { force: true });
		if (await pathIsDirectory(destinationPath)) {
			await rm(destinationPath, { recursive: true, force: true });
		}
		await rename(tempPath, destinationPath);
	} catch (error) {
		try {
			await rm(tempPath, { recursive: true, force: true });
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				`Atomic plugin cache copy and cleanup both failed: ${destinationPath}`,
			);
		}
		throw error;
	}
}

async function withTemporaryPluginTree<T>(
	tempDir: string,
	operation: () => Promise<T>,
): Promise<T> {
	let operationError: unknown;
	try {
		return await operation();
	} catch (error) {
		operationError = error;
		throw error;
	} finally {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch (cleanupError) {
			if (operationError !== undefined) {
				throw new AggregateError(
					[operationError, cleanupError],
					`Plugin cache operation and staging cleanup both failed: ${tempDir}`,
				);
			}
			throw cleanupError;
		}
	}
}

function isOmxAtomicTempEntryName(name: string): boolean {
	return /^\..+\.omx-atomic-\d+-[0-9a-f-]+$/.test(name);
}

interface OverlayDirectoryOptions {
	preserveDestinationEntry?: (name: string) => boolean;
	mutationRootIdentity?: PluginCacheRootIdentity;
}

async function overlayDirectoryKeepingRootPresent(sourceDir: string, destinationDir: string, options: OverlayDirectoryOptions = {}): Promise<void> {
	const destinationStats = await ensureRealDirectoryRoot(destinationDir);
	const mutationRootIdentity = options.mutationRootIdentity ?? pluginCacheRootIdentity(
		destinationDir,
		destinationStats,
	);
	await assertPluginCacheRootIdentity(mutationRootIdentity);
	const sourceEntries = await readdir(sourceDir, { withFileTypes: true });
	const sourceNames = new Set(sourceEntries.map((entry) => entry.name));

	for (const entry of sourceEntries) {
		await assertPluginCacheRootIdentity(mutationRootIdentity);
		const sourcePath = join(sourceDir, entry.name);
		const destinationPath = join(destinationDir, entry.name);
		if (entry.isDirectory()) {
			if (existsSync(destinationPath) && !(await pathIsDirectory(destinationPath))) {
				await rm(destinationPath, { recursive: true, force: true });
			}
			await overlayDirectoryKeepingRootPresent(sourcePath, destinationPath, {
				mutationRootIdentity,
			});
		} else if (entry.isFile()) {
			await copyFileAtomically(sourcePath, destinationPath);
		}
	}

	const destinationEntries = await readdir(destinationDir, { withFileTypes: true });
	await Promise.all(
		destinationEntries
			.filter(
				(entry) =>
					!sourceNames.has(entry.name) &&
					!isOmxAtomicTempEntryName(entry.name) &&
					!options.preserveDestinationEntry?.(entry.name),
			)
			.map(async (entry) => {
				await assertPluginCacheRootIdentity(mutationRootIdentity);
				await rm(join(destinationDir, entry.name), { recursive: true, force: true });
			}),
	);
	await assertPluginCacheRootIdentity(mutationRootIdentity);
}

async function applyTeamModeToPluginCache(
	cacheDir: string,
	teamMode: SetupTeamMode | undefined,
): Promise<void> {
	if (teamModeEnabled(teamMode)) return;
	for (const skillName of TEAM_MODE_PLUGIN_SKILL_NAMES) {
		await rm(join(cacheDir, "skills", skillName), { recursive: true, force: true });
	}
}

export async function refreshPackagedOmxPluginCacheInPlace(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
	options: { teamMode?: SetupTeamMode } = {},
): Promise<void> {
	const initialRootIdentity = await readPluginCacheRootIdentity(cacheDir);
	if (!initialRootIdentity) {
		throw new Error(`Cannot refresh a missing OMX plugin cache root: ${cacheDir}`);
	}
	const tempDir = join(
		tmpdir(),
		`omx-plugin-cache-refresh-${process.pid}-${randomUUID()}`,
	);
	await withTemporaryPluginTree(tempDir, async () => {
		await cp(packagedMarketplace.pluginRoot, tempDir, { recursive: true });
		await applyTeamModeToPluginCache(tempDir, options.teamMode);
		await writePinnedHookLauncher(tempDir, packagedMarketplace);
		await withPluginCacheLock(cacheDir, async () => {
			await assertPluginCacheRootIdentity(initialRootIdentity);
			await overlayDirectoryKeepingRootPresent(tempDir, cacheDir, {
				preserveDestinationEntry: isOmxPluginCacheVersionEntryName,
				mutationRootIdentity: initialRootIdentity,
			});
			if (!(await pluginCacheContentsMatchPackaged(
				cacheDir,
				packagedMarketplace,
				options,
			))) {
				throw new Error(`OMX plugin cache refresh postcondition failed: ${cacheDir}`);
			}
		});
	});
}

export interface OmxPluginCacheMaterializeResult {
	status: "unavailable" | "unchanged" | "materialized";
	cacheDir?: string;
	version?: string;
}

export async function materializePackagedOmxPluginCache(
	codexHomeDir: string,
	packagedMarketplace: PackagedOmxMarketplace | null,
	options: {
		dryRun?: boolean;
		teamMode?: SetupTeamMode;
	} = {},
): Promise<OmxPluginCacheMaterializeResult> {
	if (!packagedMarketplace) return { status: "unavailable" };
	const version = await packagedOmxPluginVersion(packagedMarketplace);
	if (!version) return { status: "unavailable" };
	const cacheDir = join(omxPluginCacheBase(codexHomeDir), version);
	const initialRootIdentity = await readPluginCacheRootIdentity(cacheDir);
	if (await hasExpectedOmxPluginCache(codexHomeDir, packagedMarketplace, options)) {
		return { status: "unchanged", cacheDir, version };
	}
	if (!options.dryRun) {
		const tempDir = join(
			tmpdir(),
			`omx-plugin-cache-materialize-${process.pid}-${randomUUID()}`,
		);
		await withTemporaryPluginTree(tempDir, async () => {
			await cp(packagedMarketplace.pluginRoot, tempDir, { recursive: true });
			await applyTeamModeToPluginCache(tempDir, options.teamMode);
			await writePinnedHookLauncher(tempDir, packagedMarketplace);
			await withPluginCacheLock(cacheDir, async () => {
				if (initialRootIdentity) {
					await assertPluginCacheRootIdentity(initialRootIdentity);
				} else {
					const currentRootIdentity = await readPluginCacheRootIdentity(cacheDir);
					if (currentRootIdentity) {
						if (await pluginCacheContentsMatchPackaged(
							cacheDir,
							packagedMarketplace,
							options,
						)) return;
						throw new Error(
							`OMX plugin cache root appeared during materialization: ${cacheDir}`,
						);
					}
				}
				await overlayDirectoryKeepingRootPresent(tempDir, cacheDir, {
					preserveDestinationEntry: isOmxPluginCacheVersionEntryName,
					mutationRootIdentity: initialRootIdentity ?? undefined,
				});
				if (!(await pluginCacheContentsMatchPackaged(
					cacheDir,
					packagedMarketplace,
					options,
				))) {
					throw new Error(`OMX plugin cache materialization postcondition failed: ${cacheDir}`);
				}
			});
		});
	}
	return { status: "materialized", cacheDir, version };
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
