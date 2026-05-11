import { existsSync } from "fs";
import { cp, readdir, readFile, rm } from "fs/promises";
import { join, resolve } from "path";
import { OMX_FIRST_PARTY_MCP_SERVER_NAMES } from "../config/omx-first-party-mcp.js";

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
}

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
): Promise<string[] | null> {
	return listChildDirectoryNames(join(packagedMarketplace.pluginRoot, "skills"));
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

export async function discoverOmxPluginCacheDirs(
	codexHomeDir: string,
): Promise<string[]> {
	const cacheRoot = join(codexHomeDir, "plugins", "cache");
	if (!existsSync(cacheRoot)) return [];

	const queue: Array<{ path: string; depth: number }> = [
		{ path: cacheRoot, depth: 0 },
	];
	const maxDepth = 5;
	const matches: string[] = [];

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) break;

		const manifestPath = join(current.path, ".codex-plugin", "plugin.json");
		if (existsSync(manifestPath)) {
			const manifest = await readPluginManifest(manifestPath);
			if (manifest?.name === OMX_PLUGIN_NAME) {
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
			queue.push({
				path: join(current.path, entry.name),
				depth: current.depth + 1,
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
	};
}

export async function hasExpectedOmxPluginCache(
	codexHomeDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
): Promise<boolean> {
	const [version, expectedSkillNames] = await Promise.all([
		packagedOmxPluginVersion(packagedMarketplace),
		expectedPackagedOmxSkillNames(packagedMarketplace),
	]);
	if (!version || !expectedSkillNames) return false;
	const state = await readOmxPluginCacheState(
		join(omxPluginCacheBase(codexHomeDir), version),
	);
	return (
		state?.manifestVersion === version &&
		state.skillsPointer === "./skills/" &&
		JSON.stringify(state.skillNames) === JSON.stringify(expectedSkillNames)
	);
}

export interface OmxPluginCacheMaterializeResult {
	status: "unavailable" | "unchanged" | "materialized";
	cacheDir?: string;
	version?: string;
}

export async function materializePackagedOmxPluginCache(
	codexHomeDir: string,
	packagedMarketplace: PackagedOmxMarketplace | null,
	options: { dryRun?: boolean } = {},
): Promise<OmxPluginCacheMaterializeResult> {
	if (!packagedMarketplace) return { status: "unavailable" };
	const version = await packagedOmxPluginVersion(packagedMarketplace);
	if (!version) return { status: "unavailable" };
	const cacheDir = join(omxPluginCacheBase(codexHomeDir), version);
	if (await hasExpectedOmxPluginCache(codexHomeDir, packagedMarketplace)) {
		return { status: "unchanged", cacheDir, version };
	}
	if (!options.dryRun) {
		await rm(cacheDir, { recursive: true, force: true });
		await cp(packagedMarketplace.pluginRoot, cacheDir, { recursive: true });
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

export function stripLocalOmxMarketplaceRegistration(config: string): string {
	const lines = config.split(/\r?\n/);
	const headerPattern = marketplaceTableHeaderPattern();
	const start = lines.findIndex((line) => headerPattern.test(line));
	if (start < 0) return config;

	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) {
		if (isTomlTableHeader(lines[index])) {
			end = index;
			break;
		}
	}

	const nextLines = [...lines.slice(0, start), ...lines.slice(end)];
	return nextLines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd();
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
	const lines = config.split(/\r?\n/);
	const headerPattern = localPluginTableHeaderPattern();
	const start = lines.findIndex((line) => headerPattern.test(line));

	if (start < 0) {
		const base = config.trimEnd();
		return `${base ? `${base}\n\n` : ""}[plugins.${JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY)}]\nenabled = true\n`;
	}

	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) {
		if (isTomlTableHeader(lines[index])) {
			end = index;
			break;
		}
	}

	let enabledIndex = -1;
	for (let index = start + 1; index < end; index += 1) {
		if (/^\s*enabled\s*=/.test(lines[index])) {
			if (enabledIndex < 0) {
				enabledIndex = index;
				lines[index] = "enabled = true";
			} else {
				lines.splice(index, 1);
				index -= 1;
				end -= 1;
			}
		}
	}

	if (enabledIndex < 0) {
		lines.splice(start + 1, 0, "enabled = true");
	}

	return lines.join("\n").replace(/\n*$/, "\n");
}

export function upsertLocalOmxPluginMcpServerEnablement(
	config: string,
	enabled: boolean,
): string {
	let next = config;
	for (const serverName of OMX_FIRST_PARTY_MCP_SERVER_NAMES) {
		const header = `[plugins.${JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY)}.mcp_servers.${serverName}]`;
		const headerPattern = localPluginMcpServerTableHeaderPattern(serverName);
		next = upsertTomlTableBooleanKey(next, header, headerPattern, "enabled", enabled, {
			create: true,
		});
	}
	return next;
}
