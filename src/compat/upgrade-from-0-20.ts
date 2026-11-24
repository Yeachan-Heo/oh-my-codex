/**
 * 0.20.x → 0.21 upgrade fixture helpers (epic #3491 / C10).
 *
 * End-to-end upgrade contract on top of sibling authorities:
 * - stale-state retirement via the explicit `omx doctor --repair-state` archive path
 * - `.omx` plans/specs/context preserved byte-for-byte through setup
 * - hooks re-register under CLI (legacy) and plugin modes
 * - plugin cache roots are versioned (C8 shape)
 */
import { existsSync, readFileSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setup } from "../cli/setup.js";
import {
	materializePackagedOmxPluginCache,
	packagedOmxPluginVersion,
	resolvePackagedOmxMarketplace,
} from "../cli/plugin-marketplace.js";
import { repairStateProjections } from "../cli/doctor.js";
import { getPackageRoot } from "../utils/package.js";

export const UPGRADE_FIXTURE_PLAN_MARKER = "omx-upgrade-fixture-plan-v0.20";
export const UPGRADE_FIXTURE_SPEC_MARKER = "omx-upgrade-fixture-spec-v0.20";
export const UPGRADE_FIXTURE_CONTEXT_MARKER = "omx-upgrade-fixture-context-v0.20";

export type UpgradeInstallMode = "legacy" | "plugin";

export interface UpgradeFixtureSeed {
	root: string;
	planPath: string;
	specPath: string;
	contextPath: string;
	statePaths: string[];
	planContent: string;
	specContent: string;
	contextContent: string;
}

export interface UpgradeNeutralizeResult {
	ran: boolean;
	touched: string[];
	skipped: number;
}

export interface UpgradeFixtureResult {
	mode: UpgradeInstallMode;
	root: string;
	codexHomeDir: string;
	plansPreserved: boolean;
	hooksReregistered: boolean;
	pluginRootsVersioned: boolean;
	/** True when the upgrade did not rewrite or terminalize any authoritative projection. */
	stateProjectionsPreservedVerbatim: boolean;
	neutralize: UpgradeNeutralizeResult;
	pluginCacheDir?: string;
}

/**
 * Seed a 0.20.x-shaped tree using C7's `{mode}-state.json` projection names.
 */
export async function seed020xUpgradeFixture(root: string): Promise<UpgradeFixtureSeed> {
	const planContent = `# Plan\n\n${UPGRADE_FIXTURE_PLAN_MARKER}\n`;
	const specContent = `# Spec\n\n${UPGRADE_FIXTURE_SPEC_MARKER}\n`;
	const contextContent = `# Context\n\n${UPGRADE_FIXTURE_CONTEXT_MARKER}\n`;
	const planPath = join(root, ".omx", "plans", "upgrade-fixture-plan.md");
	const specPath = join(root, ".omx", "specs", "upgrade-fixture-spec.md");
	const contextPath = join(root, ".omx", "context", "upgrade-fixture-context.md");
	const statePaths = [
		join(root, ".omx", "state", "ralph-state.json"),
		join(root, ".omx", "state", "ralplan-state.json"),
		join(root, ".omx", "state", "autopilot-state.json"),
		join(root, ".omx", "state", "sessions", "sess-020", "ralph-state.json"),
		join(root, ".omx", "state", "sessions", "sess-020", "ralplan-state.json"),
	];

	for (const path of [planPath, specPath, contextPath, ...statePaths]) {
		await mkdir(dirname(path), { recursive: true });
	}
	await writeFile(planPath, planContent, "utf-8");
	await writeFile(specPath, specContent, "utf-8");
	await writeFile(contextPath, contextContent, "utf-8");

	const activeRalph = {
		active: true,
		mode: "ralph",
		current_phase: "executing",
		iteration: 2,
		max_iterations: 10,
		task_description: "0.20.x ralph residue",
		started_at: "2026-08-01T00:00:00.000Z",
	};
	const activeRalplan = {
		active: true,
		mode: "ralplan",
		current_phase: "planning",
		task_description: "0.20.x ralplan residue",
		started_at: "2026-08-01T00:00:00.000Z",
		input_lock: { active: true, status: "pending" },
	};
	const activeAutopilot = {
		active: true,
		mode: "autopilot",
		current_phase: "ralplan",
		iteration: 1,
		started_at: "2026-08-01T00:00:00.000Z",
	};

	await writeFile(statePaths[0], `${JSON.stringify(activeRalph, null, 2)}\n`, "utf-8");
	await writeFile(statePaths[1], `${JSON.stringify(activeRalplan, null, 2)}\n`, "utf-8");
	await writeFile(statePaths[2], `${JSON.stringify(activeAutopilot, null, 2)}\n`, "utf-8");
	await writeFile(statePaths[3], `${JSON.stringify(activeRalph, null, 2)}\n`, "utf-8");
	await writeFile(statePaths[4], `${JSON.stringify(activeRalplan, null, 2)}\n`, "utf-8");

	return {
		root,
		planPath,
		specPath,
		contextPath,
		statePaths,
		planContent,
		specContent,
		contextContent,
	};
}

/**
 * Retire stale 0.20.x projections through the explicit `omx doctor --repair-state` archive path.
 *
 * The automatic launch-time neutralizer was removed: it rewrote projections in place with no
 * version or provenance check, so it could terminalize a valid CURRENT active run on first launch.
 * Upgrading is now an explicit operator action that archives under `.omx/archive/` instead of
 * mutating state, and the current session scope is preserved rather than neutralized.
 */
export async function neutralizeStale020xState(
	root: string,
): Promise<UpgradeNeutralizeResult> {
	const result = await repairStateProjections(root);
	return {
		ran: result.archived.length > 0 || result.preserved.length > 0,
		touched: result.archived,
		skipped: result.skipped.length,
	};
}

async function withIsolatedUserHome<T>(
	wd: string,
	fn: (codexHomeDir: string) => Promise<T>,
): Promise<T> {
	const previousHome = process.env.HOME;
	const previousCodexHome = process.env.CODEX_HOME;
	const homeDir = join(wd, "home");
	const codexHomeDir = join(homeDir, ".codex");
	await mkdir(codexHomeDir, { recursive: true });
	process.env.HOME = homeDir;
	process.env.CODEX_HOME = codexHomeDir;
	try {
		return await fn(codexHomeDir);
	} finally {
		if (typeof previousHome === "string") process.env.HOME = previousHome;
		else delete process.env.HOME;
		if (typeof previousCodexHome === "string") process.env.CODEX_HOME = previousCodexHome;
		else delete process.env.CODEX_HOME;
	}
}

async function withTempCwd(wd: string, fn: () => Promise<void>): Promise<void> {
	const previousCwd = process.cwd();
	process.chdir(wd);
	try {
		await fn();
	} finally {
		process.chdir(previousCwd);
	}
}

function legacyHooksReregistered(codexHomeDir: string): boolean {
	const hooksPath = join(codexHomeDir, "hooks.json");
	if (!existsSync(hooksPath)) return false;
	try {
		return readFileSync(hooksPath, "utf-8").includes("codex-native-hook");
	} catch {
		return false;
	}
}

async function pluginHooksReregistered(pluginCacheDir: string): Promise<boolean> {
	const hooksPath = join(pluginCacheDir, "hooks", "hooks.json");
	const launcherPath = join(pluginCacheDir, "hooks", "codex-native-hook.mjs");
	if (!existsSync(hooksPath) || !existsSync(launcherPath)) return false;
	const content = await readFile(hooksPath, "utf-8");
	return content.includes("codex-native-hook.mjs");
}

/**
 * C8-shaped plugin root assertion: cache materializes under a versioned path.
 */
export async function assertVersionedPluginRoots(options: {
	codexHomeDir: string;
	packageRoot?: string;
	previousVersion?: string;
	previousMustRemain?: boolean;
}): Promise<{ ok: boolean; currentCacheDir?: string; message: string }> {
	const packageRoot = options.packageRoot ?? getPackageRoot();
	const marketplace = await resolvePackagedOmxMarketplace(packageRoot);
	if (!marketplace) {
		return { ok: false, message: "packaged marketplace missing" };
	}
	const version = await packagedOmxPluginVersion(marketplace);
	if (!version) {
		return { ok: false, message: "packaged plugin version missing" };
	}
	const currentCacheDir = join(
		options.codexHomeDir,
		"plugins",
		"cache",
		"oh-my-codex-local",
		"oh-my-codex",
		version,
	);
	if (!existsSync(join(currentCacheDir, ".codex-plugin", "plugin.json"))) {
		return {
			ok: false,
			currentCacheDir,
			message: `current versioned plugin root missing: ${currentCacheDir}`,
		};
	}
	if (options.previousVersion && options.previousMustRemain) {
		const previous = join(
			options.codexHomeDir,
			"plugins",
			"cache",
			"oh-my-codex-local",
			"oh-my-codex",
			options.previousVersion,
		);
		if (!existsSync(previous)) {
			return {
				ok: false,
				currentCacheDir,
				message: `previous versioned plugin root was deleted: ${previous}`,
			};
		}
	}
	return { ok: true, currentCacheDir, message: "versioned plugin roots ok" };
}

export async function run020To021UpgradeFixture(options: {
	mode: UpgradeInstallMode;
	packageRoot?: string;
	retainPreviousPluginRoot?: boolean;
}): Promise<UpgradeFixtureResult> {
	const packageRoot = options.packageRoot ?? getPackageRoot();
	const root = await mkdtemp(join(tmpdir(), `omx-upgrade-020-${options.mode}-`));
	const seed = await seed020xUpgradeFixture(root);
	const neutralize = await neutralizeStale020xState(root);

	let plansPreserved = false;
	let hooksReregistered = false;
	let pluginRootsVersioned = false;
	let pluginCacheDir: string | undefined;
	let codexHomeDir = "";

	await withIsolatedUserHome(root, async (homeCodex) => {
		codexHomeDir = homeCodex;

		if (options.mode === "plugin" && options.retainPreviousPluginRoot) {
			const previous = join(
				homeCodex,
				"plugins",
				"cache",
				"oh-my-codex-local",
				"oh-my-codex",
				"0.20.0",
			);
			await mkdir(join(previous, ".codex-plugin"), { recursive: true });
			await writeFile(
				join(previous, ".codex-plugin", "plugin.json"),
				JSON.stringify({ name: "oh-my-codex", version: "0.20.0", skills: "./skills/" }, null, 2),
			);
			await writeFile(join(previous, ".omx-live-session-pin"), "sess-020\n", "utf-8");
		}

		await withTempCwd(root, async () => {
			await setup({
				scope: "user",
				installMode: options.mode === "plugin" ? "plugin" : "legacy",
				force: true,
				pluginAgentsMdPrompt: async () => false,
				pluginDeveloperInstructionsPrompt: async () => false,
				codexFeaturesProbe: () =>
					[
						"hooks                                   stable             true",
						"plugin_hooks                            experimental       true",
						"",
					].join("\n"),
				codexVersionProbe: () => "codex-cli 0.999.0",
			});
		});

		const planAfter = await readFile(seed.planPath, "utf-8");
		const specAfter = await readFile(seed.specPath, "utf-8");
		const contextAfter = await readFile(seed.contextPath, "utf-8");
		plansPreserved =
			planAfter === seed.planContent &&
			specAfter === seed.specContent &&
			contextAfter === seed.contextContent;

		if (options.mode === "legacy") {
			hooksReregistered = legacyHooksReregistered(homeCodex);
			pluginRootsVersioned = true;
		} else {
			const marketplace = await resolvePackagedOmxMarketplace(packageRoot);
			if (marketplace) {
				const materialize = await materializePackagedOmxPluginCache(homeCodex, marketplace);
				pluginCacheDir = materialize.cacheDir;
			}
			const roots = await assertVersionedPluginRoots({
				codexHomeDir: homeCodex,
				packageRoot,
			});
			pluginRootsVersioned = roots.ok;
			pluginCacheDir = roots.currentCacheDir ?? pluginCacheDir;
			hooksReregistered = pluginCacheDir
				? await pluginHooksReregistered(pluginCacheDir)
				: false;
		}
	});

	// Upgrading must not silently mutate workflow state. The automatic in-place neutralizer was
	// removed because it could terminalize a valid CURRENT run, so the contract is now the opposite
	// of the old one: an authoritative projection survives the upgrade untouched, and retiring stale
	// scopes is an explicit `omx doctor --repair-state` action that archives instead of rewriting.
	const rootStatePaths = seed.statePaths.filter(
		(path) => !path.includes(`${join("state", "sessions")}`),
	);
	let rewrittenInPlace = 0;
	for (const path of rootStatePaths) {
		if (!existsSync(path)) continue;
		const state = JSON.parse(await readFile(path, "utf-8")) as {
			active?: boolean;
			neutralized_by?: string;
		};
		if (state.active !== true || typeof state.neutralized_by === "string") {
			rewrittenInPlace += 1;
		}
	}
	const stateProjectionsPreservedVerbatim = rewrittenInPlace === 0;

	return {
		mode: options.mode,
		root,
		codexHomeDir,
		plansPreserved,
		hooksReregistered,
		pluginRootsVersioned,
		stateProjectionsPreservedVerbatim,
		neutralize,
		pluginCacheDir,
	};
}

export async function cleanupUpgradeFixtureRoot(root: string): Promise<void> {
	await rm(root, { recursive: true, force: true });
}
