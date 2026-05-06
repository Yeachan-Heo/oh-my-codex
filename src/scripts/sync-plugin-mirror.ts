#!/usr/bin/env node
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
	getSetupInstallableSkillNames,
	isCatalogInstallableStatus,
} from "../catalog/installable.js";
import { readCatalogManifest } from "../catalog/reader.js";
import {
	assertSkillMirror,
	compareSkillMirror,
} from "../catalog/skill-mirror.js";
import { buildOmxPluginMcpManifest } from "../config/omx-first-party-mcp.js";

export interface SyncPluginMirrorOptions {
	root?: string;
	check?: boolean;
	verbose?: boolean;
}

export interface SyncPluginMirrorResult {
	checked: boolean;
	mirroredSkillNames: string[];
	changed: boolean;
}

type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

type PluginManifest = {
	name?: string;
	version?: string;
	skills?: string;
	mcpServers?: string;
	apps?: string;
	agents?: string;
	prompts?: string;
	hooks?: string;
	[key: string]: JsonValue | undefined;
};

type PackageJson = {
	version?: string;
};

const PLUGIN_NAME = "oh-my-codex";
const SETUP_OWNED_PLUGIN_MANIFEST_FIELDS = [
	"agents",
	"prompts",
	"hooks",
] as const;

async function readJsonFile<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf-8")) as T;
}

function stringifyJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function assertDeepJsonEqual(
	actual: unknown,
	expected: unknown,
	label: string,
): void {
	const actualJson = stringifyJson(actual);
	const expectedJson = stringifyJson(expected);
	if (actualJson !== expectedJson) {
		throw new Error(
			[
				"plugin_bundle_metadata_out_of_sync",
				`kind=${label}`,
				`expected=${expectedJson.trim()}`,
				`actual=${actualJson.trim()}`,
			].join("\n"),
		);
	}
}

function getPluginPaths(root: string): {
	pluginRoot: string;
	pluginSkillsDir: string;
	pluginMcpPath: string;
	pluginAppsPath: string;
	pluginManifestPath: string;
} {
	const pluginRoot = join(root, "plugins", PLUGIN_NAME);
	return {
		pluginRoot,
		pluginSkillsDir: join(pluginRoot, "skills"),
		pluginMcpPath: join(pluginRoot, ".mcp.json"),
		pluginAppsPath: join(pluginRoot, ".app.json"),
		pluginManifestPath: join(pluginRoot, ".codex-plugin", "plugin.json"),
	};
}

async function assertRootSkillCatalogConsistency(
	root: string,
	skillNames: readonly string[],
): Promise<void> {
	const manifest = readCatalogManifest(root);
	const rootSkillsDir = join(root, "skills");
	const manifestByName = new Map(
		manifest.skills.map((skill) => [skill.name, skill]),
	);
	const expectedSkillNames = new Set(skillNames);

	for (const skillName of skillNames) {
		const skillMd = join(rootSkillsDir, skillName, "SKILL.md");
		if (!existsSync(skillMd)) {
			throw new Error(`canonical_skill_missing: skills/${skillName}/SKILL.md`);
		}
	}

	const rootEntries = await readdir(rootSkillsDir, { withFileTypes: true });
	const unlistedSkillDirs = rootEntries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter(
			(skillName) =>
				!manifestByName.has(skillName) && !expectedSkillNames.has(skillName),
		)
		.sort();
	if (unlistedSkillDirs.length > 0) {
		throw new Error(
			[
				"canonical_skill_catalog_out_of_sync",
				"message=root skill directories must be listed in the catalog or explicitly included by setup policy",
				`skills=${JSON.stringify(unlistedSkillDirs)}`,
			].join("\n"),
		);
	}

	const nonInstallableRootSkillDirs = rootEntries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter((skillName) => {
			if (expectedSkillNames.has(skillName)) return false;
			const status = manifestByName.get(skillName)?.status;
			return status !== "alias" && status !== "merged" && status !== "deprecated";
		})
		.sort();
	if (nonInstallableRootSkillDirs.length > 0) {
		throw new Error(
			[
				"canonical_skill_catalog_out_of_sync",
				"message=root skill directories excluded from plugin must be alias, merged, or deprecated catalog entries",
				`skills=${JSON.stringify(nonInstallableRootSkillDirs)}`,
			].join("\n"),
		);
	}

	const installableMissingFromSetup = manifest.skills
		.filter((skill) => isCatalogInstallableStatus(skill.status))
		.map((skill) => skill.name)
		.filter((skillName) => !expectedSkillNames.has(skillName))
		.sort();
	if (installableMissingFromSetup.length > 0) {
		throw new Error(
			[
				"canonical_skill_catalog_out_of_sync",
				"message=installable catalog skills must be included in plugin/setup installable skill set",
				`skills=${JSON.stringify(installableMissingFromSetup)}`,
			].join("\n"),
		);
	}
}

async function buildExpectedPluginManifest(
	root: string,
): Promise<PluginManifest> {
	const { pluginManifestPath } = getPluginPaths(root);
	const [manifest, pkg] = await Promise.all([
		readJsonFile<PluginManifest>(pluginManifestPath),
		readJsonFile<PackageJson>(join(root, "package.json")),
	]);
	return {
		...manifest,
		name: PLUGIN_NAME,
		version: pkg.version,
		skills: "./skills/",
		mcpServers: "./.mcp.json",
		apps: "./.app.json",
	};
}

async function assertPluginManifestPolicy(
	root: string,
	manifest: PluginManifest,
): Promise<void> {
	const pkg = await readJsonFile<PackageJson>(join(root, "package.json"));
	const expectedFields: Pick<
		PluginManifest,
		"name" | "version" | "skills" | "mcpServers" | "apps"
	> = {
		name: PLUGIN_NAME,
		version: pkg.version,
		skills: "./skills/",
		mcpServers: "./.mcp.json",
		apps: "./.app.json",
	};

	for (const [field, expectedValue] of Object.entries(expectedFields)) {
		if (manifest[field] !== expectedValue) {
			throw new Error(
				[
					"plugin_bundle_metadata_out_of_sync",
					"kind=plugin-manifest",
					`field=${field}`,
					`expected=${JSON.stringify(expectedValue)}`,
					`actual=${JSON.stringify(manifest[field])}`,
				].join("\n"),
			);
		}
	}

	for (const field of SETUP_OWNED_PLUGIN_MANIFEST_FIELDS) {
		if (manifest[field] !== undefined) {
			throw new Error(
				[
					"plugin_bundle_metadata_out_of_sync",
					"kind=plugin-manifest",
					`field=${field}`,
					"message=setup-owned agents/prompts/hooks must not be plugin-scoped",
				].join("\n"),
			);
		}
	}
}

async function assertPluginMetadata(root: string): Promise<void> {
	const { pluginMcpPath, pluginAppsPath, pluginManifestPath } =
		getPluginPaths(root);
	const [actualMcp, actualApps, actualManifest] = await Promise.all([
		readJsonFile<unknown>(pluginMcpPath),
		readJsonFile<unknown>(pluginAppsPath),
		readJsonFile<PluginManifest>(pluginManifestPath),
	]);

	assertDeepJsonEqual(actualMcp, buildOmxPluginMcpManifest(), "mcp-manifest");
	assertDeepJsonEqual(actualApps, { apps: {} }, "apps-manifest");
	await assertPluginManifestPolicy(root, actualManifest);
}

async function writePluginMetadata(
	root: string,
	verbose = false,
): Promise<boolean> {
	const { pluginMcpPath, pluginAppsPath, pluginManifestPath } =
		getPluginPaths(root);
	const expectedMcp = buildOmxPluginMcpManifest();
	const expectedApps = { apps: {} };
	const expectedManifest = await buildExpectedPluginManifest(root);
	const writes = [
		{
			path: pluginMcpPath,
			content: stringifyJson(expectedMcp),
			label: "plugin MCP manifest",
		},
		{
			path: pluginAppsPath,
			content: stringifyJson(expectedApps),
			label: "plugin apps manifest",
		},
		{
			path: pluginManifestPath,
			content: stringifyJson(expectedManifest),
			label: "plugin manifest",
		},
	];
	let changed = false;

	for (const write of writes) {
		const existing = existsSync(write.path)
			? await readFile(write.path, "utf-8")
			: null;
		if (existing !== write.content) {
			await mkdir(dirname(write.path), { recursive: true });
			await writeFile(write.path, write.content);
			changed = true;
			if (verbose) console.log(`synced ${write.label}`);
		}
	}

	return changed;
}

export async function syncPluginMirror(
	options: SyncPluginMirrorOptions = {},
): Promise<SyncPluginMirrorResult> {
	const root = options.root ?? process.cwd();
	const manifest = readCatalogManifest(root);
	const skillNames = [...getSetupInstallableSkillNames(manifest)].sort();
	const rootSkillsDir = join(root, "skills");
	const { pluginSkillsDir } = getPluginPaths(root);

	await assertRootSkillCatalogConsistency(root, skillNames);

	if (options.check) {
		await assertSkillMirror(rootSkillsDir, pluginSkillsDir, skillNames);
		await assertPluginMetadata(root);
		return { checked: true, mirroredSkillNames: skillNames, changed: false };
	}

	const beforeSkillsMatch =
		(await compareSkillMirror(rootSkillsDir, pluginSkillsDir, skillNames)) ===
		null;

	await rm(pluginSkillsDir, { recursive: true, force: true });
	await mkdir(pluginSkillsDir, { recursive: true });

	for (const skillName of skillNames) {
		await cp(join(rootSkillsDir, skillName), join(pluginSkillsDir, skillName), {
			recursive: true,
		});
		if (options.verbose) {
			console.log(
				`mirrored skills/${skillName} -> plugins/${PLUGIN_NAME}/skills/${skillName}`,
			);
		}
	}

	const metadataChanged = await writePluginMetadata(root, options.verbose);

	await assertSkillMirror(rootSkillsDir, pluginSkillsDir, skillNames);
	await assertPluginMetadata(root);
	return {
		checked: false,
		mirroredSkillNames: skillNames,
		changed: !beforeSkillsMatch || metadataChanged,
	};
}

function parseArgs(argv: string[]): SyncPluginMirrorOptions {
	return {
		check: argv.includes("--check"),
		verbose: argv.includes("--verbose"),
	};
}

export function isDirectCliInvocation(
	importMetaUrl: string,
	argvPath: string | undefined,
): boolean {
	if (!argvPath) return false;
	return fileURLToPath(importMetaUrl) === resolve(argvPath);
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
	syncPluginMirror(parseArgs(process.argv.slice(2)))
		.then((result) => {
			const action = result.checked ? "verified" : "synced";
			console.log(
				`[sync-plugin-mirror] ${action} ${result.mirroredSkillNames.length} canonical skill director${result.mirroredSkillNames.length === 1 ? "y" : "ies"} and plugin metadata`,
			);
		})
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
}
