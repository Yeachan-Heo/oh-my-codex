import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import {
	chmod,
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	symlink,
	writeFile,
	stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse as parseToml } from "@iarna/toml";
import {
	decideWindowsNativeHookShimReference,
	setNativeHookTransactionFailureInjectorForTest,
	setSetupLatePhaseFailureInjectorForTest,
	setNativeHookTransactionPlatformForTest,
	setNativeHookTransactionRegularFileSyncForTest,
	setNativeHookTransactionTemporaryPathForTest,
	setup,
} from "../setup.js";
import { resolveSetupRefreshArgs } from "../update.js";
import { uninstall } from "../uninstall.js";
import { OMX_FIRST_PARTY_MCP_SERVER_NAMES } from "../../config/omx-first-party-mcp.js";
import {
	OMX_DEVELOPER_INSTRUCTIONS,
	OMX_PLUGIN_DEVELOPER_INSTRUCTIONS,
} from "../../config/generator.js";
import {
	materializePackagedOmxPluginCache,
	resolvePackagedOmxMarketplace,
} from "../plugin-marketplace.js";
import {
	buildManagedCodexHookTrustState,
	buildManagedCodexHooksConfig,
	buildManagedCodexNativeHookWindowsShimContent,
	buildManagedCodexNativeHookWindowsShimPath,
} from "../../config/codex-hooks.js";


const packageRoot = process.cwd();
let previousPathForFakeCodex: string | undefined;
let fakeCodexBinDir: string | null = null;

before(async () => {
	previousPathForFakeCodex = process.env.PATH;
	fakeCodexBinDir = await mkdtemp(join(tmpdir(), "omx-fake-codex-"));
	const fakeCodexPath = join(fakeCodexBinDir, "codex");
	await writeFile(
		fakeCodexPath,
		[
			"#!/usr/bin/env node",
			"if (process.argv[2] === 'features' && process.argv[3] === 'list') {",
			"  console.log('hooks                                   stable             true');",
			"  console.log('plugin_hooks                            experimental       true');",
			"  console.log('goals                                   experimental       true');",
			"  process.exit(0);",
			"}",
			"if (process.argv.includes('--version') || process.argv[2] === '--version') {",
			"  console.log('codex-cli 0.999.0');",
			"  process.exit(0);",
			"}",
			"process.exit(0);",
			"",
		].join("\n"),
	);
	await chmod(fakeCodexPath, 0o755);
	process.env.PATH = `${fakeCodexBinDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
});

after(async () => {
	if (previousPathForFakeCodex === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = previousPathForFakeCodex;
	}
	if (fakeCodexBinDir !== null) {
		await rm(fakeCodexBinDir, { recursive: true, force: true });
	}
});

async function withTempCwd(wd: string, fn: () => Promise<void>): Promise<void> {
	const previousCwd = process.cwd();
	process.chdir(wd);
	try {
		await fn();
	} finally {
		process.chdir(previousCwd);
	}
}

async function runSetupWithCapturedLogs(
	wd: string,
	options: Parameters<typeof setup>[0],
): Promise<string> {
	const previousCwd = process.cwd();
	const originalLog = console.log;
	const logs: string[] = [];
	process.chdir(wd);
	console.log = (...args: unknown[]) => {
		logs.push(args.map((arg) => String(arg)).join(" "));
	};
	try {
		await setup(options);
		return logs.join("\n");
	} finally {
		console.log = originalLog;
		process.chdir(previousCwd);
	}
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
		if (typeof previousCodexHome === "string") {
			process.env.CODEX_HOME = previousCodexHome;
		} else {
			delete process.env.CODEX_HOME;
		}
	}
}

async function withDriveQualifiedWindowsCodexHome<T>(
	wd: string,
	fn: (codexHomeDir: string) => Promise<T>,
): Promise<T> {
	const previousCwd = process.cwd();
	const previousHome = process.env.HOME;
	const previousCodexHome = process.env.CODEX_HOME;
	const codexHomeDir = "C:\\Users\\omx\\.codex";
	process.chdir(wd);
	process.env.HOME = wd;
	process.env.CODEX_HOME = codexHomeDir;
	try {
		await mkdir(codexHomeDir, { recursive: true });
		return await fn(codexHomeDir);
	} finally {
		process.chdir(previousCwd);
		if (typeof previousHome === "string") process.env.HOME = previousHome;
		else delete process.env.HOME;
		if (typeof previousCodexHome === "string") {
			process.env.CODEX_HOME = previousCodexHome;
		} else {
			delete process.env.CODEX_HOME;
		}
	}
}

describe("notify setup scope", () => {
	it("does not write unsupported project-scope notify", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-project-no-notify-"));
		try {
			await withTempCwd(wd, async () => {
				await setup({ scope: "project", installMode: "legacy" });
			});
			const config = await readFile(join(wd, ".codex", "config.toml"), "utf-8");
			assert.doesNotMatch(config, /^notify\s*=/m);
			assert.doesNotMatch(config, /notify-hook\.js/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves existing user project-scope notify while suppressing OMX notify", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-project-user-notify-"));
		try {
			await mkdir(join(wd, ".codex"), { recursive: true });
			await writeFile(
				join(wd, ".codex", "config.toml"),
				'notify = ["node", "/tmp/notify-hook.js"]\napproval_policy = "never"\n',
			);
			await withTempCwd(wd, async () => {
				await setup({ scope: "project", installMode: "legacy" });
			});
			const config = await readFile(join(wd, ".codex", "config.toml"), "utf-8");
			assert.match(config, /^notify = \["node", "\/tmp\/notify-hook\.js"\]$/m);
			assert.doesNotMatch(config, /oh-my-codex.*notify-hook\.js/);
			assert.match(config, /^approval_policy = "never"$/m);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("wraps and restores an existing user notify", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-user-notify-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await mkdir(codexHomeDir, { recursive: true });
				await writeFile(
					join(codexHomeDir, "config.toml"),
					'notify = ["node", "/tmp/user-notify.js"]\napproval_policy = "on-failure"\n',
				);
				await withTempCwd(wd, async () => {
					await setup({ scope: "user" });
				});

				const config = await readFile(join(codexHomeDir, "config.toml"), "utf-8");
				assert.match(
					config,
					/^notify = \["node", ".*notify-dispatcher\.js", "--metadata", ".*notify-dispatch\.json"\]$/m,
				);
				const metadataPath = join(
					codexHomeDir,
					".omx",
					"notify-dispatch.json",
				);
				const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
				assert.deepEqual(metadata.previousNotify, ["node", "/tmp/user-notify.js"]);
				assert.deepEqual(metadata.omxNotify?.slice(0, 1), ["node"]);

				await withTempCwd(wd, async () => {
					await setup({ scope: "user" });
				});
				const rerunConfig = await readFile(
					join(codexHomeDir, "config.toml"),
					"utf-8",
				);
				assert.match(rerunConfig, /notify-dispatcher\.js/);
				const rerunMetadata = JSON.parse(await readFile(metadataPath, "utf-8"));
				assert.deepEqual(rerunMetadata.previousNotify, [
					"node",
					"/tmp/user-notify.js",
				]);

				await withTempCwd(wd, async () => {
					await uninstall({ scope: "user" });
				});
				const restored = await readFile(
					join(codexHomeDir, "config.toml"),
					"utf-8",
				);
				assert.match(
					restored,
					new RegExp('^notify = \\["node", "/tmp/user-notify\\.js"\\]$', "m"),
				);
				assert.doesNotMatch(restored, /notify-dispatcher\.js/);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("does not preserve stale OMX dispatcher metadata as previous notify", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-stale-dispatcher-notify-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await mkdir(codexHomeDir, { recursive: true });
				const metadataPath = join(
					codexHomeDir,
					".omx",
					"notify-dispatch.json",
				);
				const stalePkgRoot = join(wd, "old-global", "oh-my-codex");
				const staleDispatcher = join(
					stalePkgRoot,
					"dist",
					"scripts",
					"notify-dispatcher.js",
				);
				await mkdir(dirname(metadataPath), { recursive: true });
				await writeFile(
					join(codexHomeDir, "config.toml"),
					`notify = ["node", "${staleDispatcher}", "--metadata", "${metadataPath}"]\napproval_policy = "on-failure"\n`,
				);
				await writeFile(
					metadataPath,
					JSON.stringify({
						managedBy: "oh-my-codex",
						version: 1,
						previousNotify: [
							"node",
							staleDispatcher,
							"--metadata",
							metadataPath,
						],
						omxNotify: [
							"node",
							join(stalePkgRoot, "dist", "scripts", "notify-hook.js"),
						],
						dispatcherNotify: ["node", staleDispatcher, "--metadata", metadataPath],
					}),
				);

				await withTempCwd(wd, async () => {
					await setup({ scope: "user" });
				});

				const config = await readFile(join(codexHomeDir, "config.toml"), "utf-8");
				assert.match(config, /^notify = \["node", ".*notify-hook\.js"\]$/m);
				assert.doesNotMatch(config, /notify-dispatcher\.js/);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("does not preserve nested encoded stale turn-ended previous notify metadata", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-stale-nested-wrapper-notify-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await mkdir(codexHomeDir, { recursive: true });
				const metadataPath = join(
					codexHomeDir,
					".omx",
					"notify-dispatch.json",
				);
				const stalePkgRoot = join(wd, "old-global", "oh-my-codex");
				const staleDispatcher = join(
					stalePkgRoot,
					"dist",
					"scripts",
					"notify-dispatcher.js",
				);
				const staleTurnEndedWrapper = join(wd, "SkyComputerUseClient");
				await mkdir(dirname(metadataPath), { recursive: true });
				await writeFile(
					join(codexHomeDir, "config.toml"),
					`notify = ["node", "${staleDispatcher}", "--metadata", "${metadataPath}"]\napproval_policy = "on-failure"\n`,
				);
				const nestedWrapper = JSON.stringify([
					"node",
					staleTurnEndedWrapper,
					"turn-ended",
					"--previous-notify",
					JSON.stringify(["node", staleDispatcher, "--metadata", metadataPath]),
				]);
				await writeFile(
					metadataPath,
					JSON.stringify({
						managedBy: "oh-my-codex",
						version: 1,
						previousNotify: [
							"node",
							staleTurnEndedWrapper,
							"turn-ended",
							"--previous-notify",
							JSON.stringify(nestedWrapper),
						],
						omxNotify: [
							"node",
							join(stalePkgRoot, "dist", "scripts", "notify-hook.js"),
						],
						dispatcherNotify: ["node", staleDispatcher, "--metadata", metadataPath],
					}),
				);

				await withTempCwd(wd, async () => {
					await setup({ scope: "user" });
				});

				const config = await readFile(join(codexHomeDir, "config.toml"), "utf-8");
				assert.match(config, /^notify = \["node", ".*notify-hook\.js"\]$/m);
				assert.doesNotMatch(config, /notify-dispatcher\.js/);
				assert.doesNotMatch(config, /SkyComputerUseClient/);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("does not preserve stale turn-ended wrappers with OMX previous notify metadata", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-stale-wrapper-notify-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await mkdir(codexHomeDir, { recursive: true });
				const metadataPath = join(
					codexHomeDir,
					".omx",
					"notify-dispatch.json",
				);
				const stalePkgRoot = join(wd, "old-global", "oh-my-codex");
				const staleDispatcher = join(
					stalePkgRoot,
					"dist",
					"scripts",
					"notify-dispatcher.js",
				);
				const staleTurnEndedWrapper = join(wd, "SkyComputerUseClient");
				await mkdir(dirname(metadataPath), { recursive: true });
				await writeFile(
					join(codexHomeDir, "config.toml"),
					`notify = ["node", "${staleDispatcher}", "--metadata", "${metadataPath}"]\napproval_policy = "on-failure"\n`,
				);
				await writeFile(
					metadataPath,
					JSON.stringify({
						managedBy: "oh-my-codex",
						version: 1,
						previousNotify: [
							"node",
							staleTurnEndedWrapper,
							"turn-ended",
							"--previous-notify",
							JSON.stringify([
								"node",
								staleDispatcher,
								"--metadata",
								metadataPath,
							]),
						],
						omxNotify: [
							"node",
							join(stalePkgRoot, "dist", "scripts", "notify-hook.js"),
						],
						dispatcherNotify: ["node", staleDispatcher, "--metadata", metadataPath],
					}),
				);

				await withTempCwd(wd, async () => {
					await setup({ scope: "user" });
				});

				const config = await readFile(join(codexHomeDir, "config.toml"), "utf-8");
				assert.match(config, /^notify = \["node", ".*notify-hook\.js"\]$/m);
				assert.doesNotMatch(config, /notify-dispatcher\.js/);
				assert.doesNotMatch(config, /SkyComputerUseClient/);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("repairs reporter-shaped SkyComputerUseClient dispatcher metadata on rerun", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-reporter-wrapper-notify-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await mkdir(codexHomeDir, { recursive: true });
				const metadataPath = join(
					codexHomeDir,
					".omx",
					"notify-dispatch.json",
				);
				const stalePkgRoot = join(wd, "pkg-without-managed-name");
				const staleDispatcher = join(
					stalePkgRoot,
					"dist",
					"scripts",
					"notify-dispatcher.js",
				);
				const staleTurnEndedWrapper = join(wd, "SkyComputerUseClient");
				await mkdir(dirname(metadataPath), { recursive: true });
				await writeFile(
					join(codexHomeDir, "config.toml"),
					`notify = ["node", "${staleDispatcher}", "--metadata", "${metadataPath}"]
approval_policy = "on-failure"
`,
				);
				await writeFile(
					metadataPath,
					JSON.stringify({
						managedBy: "oh-my-codex",
						version: 1,
						previousNotify: [
							staleTurnEndedWrapper,
							"turn-ended",
							"--previous-notify",
							JSON.stringify([
								"node",
								staleDispatcher,
								"--metadata",
								metadataPath,
							]),
						],
						omxNotify: [
							"node",
							join(stalePkgRoot, "dist", "scripts", "notify-hook.js"),
						],
						dispatcherNotify: ["node", staleDispatcher, "--metadata", metadataPath],
					}),
				);

				await withTempCwd(wd, async () => {
					await setup({ scope: "user" });
				});

				const config = await readFile(join(codexHomeDir, "config.toml"), "utf-8");
				assert.match(config, /^notify = \["node", ".*notify-hook\.js"\]$/m);
				assert.doesNotMatch(config, /notify-dispatcher\.js/);
				assert.doesNotMatch(config, /SkyComputerUseClient/);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("does not wrap stale global OMX notify hooks as user notify commands", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-stale-hook-notify-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await mkdir(codexHomeDir, { recursive: true });
				const staleHook = join(
					"/opt",
					"homebrew",
					"lib",
					"node_modules",
					"oh-my-codex",
					"dist",
					"scripts",
					"notify-hook.js",
				);
				await writeFile(
					join(codexHomeDir, "config.toml"),
					`notify = ["node", "${staleHook}"]\napproval_policy = "on-failure"\n`,
				);

				await withTempCwd(wd, async () => {
					await setup({ scope: "user" });
				});

				const config = await readFile(join(codexHomeDir, "config.toml"), "utf-8");
				assert.match(config, /^notify = \["node", ".*notify-hook\.js"\]$/m);
				assert.doesNotMatch(config, /notify-dispatcher\.js/);
				assert.doesNotMatch(config, /lib\/node_modules\/oh-my-codex\/dist\/scripts\/notify-hook\.js/);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
});

async function assertProjectPluginModeArtifacts(wd: string): Promise<void> {
	assert.equal(existsSync(join(wd, ".codex", "hooks.json")), false);
	const config = await readFile(join(wd, ".codex", "config.toml"), "utf-8");
	assert.match(config, /^plugin_hooks = true$/m);
	assert.doesNotMatch(config, /^hooks = true$/m);
	assert.match(config, /^goals = true$/m);
	assert.doesNotMatch(config, /developer_instructions|notify-hook/g);
	assert.equal(
		existsSync(join(wd, ".codex", "skills", "ask", "SKILL.md")),
		false,
	);
	assert.equal(existsSync(join(wd, ".codex", "agents", "planner.toml")), true);
	assert.equal(existsSync(join(wd, ".codex", "prompts", "executor.md")), false);
	assert.equal(existsSync(join(wd, "AGENTS.md")), true);

	const persisted = JSON.parse(
		await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
	) as { scope: string; installMode?: string };
	assert.deepEqual(persisted, {
		scope: "project",
		installMode: "plugin",
		mcpMode: "none",
	});
}

async function captureConsoleOutput(fn: () => Promise<void>): Promise<string> {
	const originalLog = console.log;
	const originalWarn = console.warn;
	const lines: string[] = [];
	console.log = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	console.warn = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	try {
		await fn();
	} finally {
		console.log = originalLog;
		console.warn = originalWarn;
	}
	return lines.join("\n");
}

async function seedPluginCacheFromInstalledSkills(
	codexHomeDir: string,
): Promise<void> {
	const artifactPath = join(
		codexHomeDir,
		"plugins",
		"cache",
		"local-marketplace",
		"oh-my-codex",
		"local",
	);
	await mkdir(join(artifactPath, ".codex-plugin"), { recursive: true });
	await writeFile(
		join(artifactPath, ".codex-plugin", "plugin.json"),
		JSON.stringify({ name: "oh-my-codex", version: "local" }),
	);
	const manifest = JSON.parse(
		await readFile(
			join(packageRoot, "src", "catalog", "manifest.json"),
			"utf-8",
		),
	) as { skills: Array<{ name: string; status?: string }> };
	const installableSkillNames = new Set([
		...manifest.skills
			.filter(
				(skill) => skill.status === "active" || skill.status === "internal",
			)
			.map((skill) => skill.name),
		"wiki",
	]);
	await mkdir(join(artifactPath, "skills"), { recursive: true });
	await Promise.all(
		[...installableSkillNames].map((skillName) =>
			cp(
				join(codexHomeDir, "skills", skillName),
				join(artifactPath, "skills", skillName),
				{
					recursive: true,
				},
			),
		),
	);
}

async function seedStalePluginDiscoveryCache(codexHomeDir: string): Promise<string> {
	const artifactPath = join(
		codexHomeDir,
		"plugins",
		"cache",
		"oh-my-codex-local",
		"oh-my-codex",
	);
	await mkdir(join(artifactPath, ".codex-plugin"), { recursive: true });
	await writeFile(
		join(artifactPath, ".codex-plugin", "plugin.json"),
		JSON.stringify(
			{ name: "oh-my-codex", version: "0.0.0", skills: "./skills/" },
			null,
			2,
		),
	);
	await mkdir(join(artifactPath, "skills", "old-only"), { recursive: true });
	await writeFile(join(artifactPath, "skills", "old-only", "SKILL.md"), "# old\n");
	return artifactPath;
}

async function seedOldVersionedPluginDiscoveryCache(codexHomeDir: string): Promise<string> {
	const artifactPath = join(
		codexHomeDir,
		"plugins",
		"cache",
		"oh-my-codex-local",
		"oh-my-codex",
		"0.0.0",
	);
	await mkdir(dirname(artifactPath), { recursive: true });
	await cp(join(packageRoot, "plugins", "oh-my-codex"), artifactPath, {
		recursive: true,
	});
	await writeFile(
		join(artifactPath, ".codex-plugin", "plugin.json"),
		JSON.stringify(
			{ name: "oh-my-codex", version: "0.0.0", skills: "./skills/", hooks: "./hooks/hooks.json" },
			null,
			2,
		) + "\n",
	);
	await mkdir(join(artifactPath, "skills", "old-only"), { recursive: true });
	await writeFile(join(artifactPath, "skills", "old-only", "SKILL.md"), "# old\n");
	return artifactPath;
}


async function seedSameVersionPluginCacheWithStaleHooks(codexHomeDir: string): Promise<string> {
	const cacheDir = await packagedPluginCacheDir(codexHomeDir);
	await mkdir(dirname(cacheDir), { recursive: true });
	await cp(join(packageRoot, "plugins", "oh-my-codex"), cacheDir, {
		recursive: true,
	});
	await writeFile(
		join(cacheDir, "hooks", "omx-command.json"),
		JSON.stringify({ command: process.execPath, argsPrefix: [join(packageRoot, "dist", "cli", "omx.js")] }, null, 2) + "\n",
	);
	const hooksPath = join(cacheDir, "hooks", "hooks.json");
	const hooks = JSON.parse(await readFile(hooksPath, "utf-8")) as { hooks?: { PreToolUse?: Array<Record<string, unknown>> } };
	const preToolUse = hooks.hooks?.PreToolUse?.[0];
	assert.ok(preToolUse, "expected packaged plugin PreToolUse hook fixture");
	preToolUse.matcher = "Bash";
	await writeFile(hooksPath, JSON.stringify(hooks, null, 2) + "\n");
	return cacheDir;
}


async function seedSameVersionPluginCacheWithStaleLauncher(codexHomeDir: string): Promise<string> {
	const cacheDir = await packagedPluginCacheDir(codexHomeDir);
	await mkdir(dirname(cacheDir), { recursive: true });
	await cp(join(packageRoot, "plugins", "oh-my-codex"), cacheDir, {
		recursive: true,
	});
	await writeFile(
		join(cacheDir, "hooks", "omx-command.json"),
		JSON.stringify({ command: "/stale/node", argsPrefix: ["/stale/omx.js"] }, null, 2) + "\n",
	);
	return cacheDir;
}

async function packagedPluginCacheDir(codexHomeDir: string): Promise<string> {
	const manifest = JSON.parse(
		await readFile(
			join(packageRoot, "plugins", "oh-my-codex", ".codex-plugin", "plugin.json"),
			"utf-8",
		),
	) as { version: string };
	return join(
		codexHomeDir,
		"plugins",
		"cache",
		"oh-my-codex-local",
		"oh-my-codex",
		manifest.version,
	);
}

describe("omx setup install mode behavior", () => {
	it("summarizes and keeps persisted setup preferences when review chooses keep", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async () => {
				await withTempCwd(wd, async () => {
					await mkdir(join(wd, ".omx"), { recursive: true });
					await writeFile(
						join(wd, ".omx", "setup-scope.json"),
						JSON.stringify({ scope: "user", installMode: "legacy" }),
					);

					const output = await captureConsoleOutput(async () => {
						await setup({
							persistedSetupReviewPrompt: async (preferences) => {
								assert.deepEqual(preferences, {
									scope: "user",
									installMode: "legacy",
								});
								return "keep";
							},
						});
					});

					assert.match(
						output,
						/Setup preference review: keep \(scope=user, installMode=legacy, mcpMode=not recorded\)/,
					);
					assert.match(
						output,
						/Using setup scope: user \(from \.omx\/setup-scope\.json\)/,
					);
					assert.match(
						output,
						/Using setup install mode: legacy \(from \.omx\/setup-scope\.json\)/,
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("uses persisted choices as defaults when review changes setup preferences", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async () => {
				await withTempCwd(wd, async () => {
					await mkdir(join(wd, ".omx"), { recursive: true });
					await writeFile(
						join(wd, ".omx", "setup-scope.json"),
						JSON.stringify({ scope: "user", installMode: "legacy" }),
					);

					await setup({
						persistedSetupReviewPrompt: async () => "review",
						setupScopePrompt: async (defaultScope) => {
							assert.equal(defaultScope, "user");
							return "user";
						},
						installModePrompt: async (defaultMode) => {
							assert.equal(defaultMode, "legacy");
							return "plugin";
						},
					});

					const persisted = JSON.parse(
						await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
					) as { scope: string; installMode?: string };
					assert.deepEqual(persisted, {
						scope: "user",
						installMode: "plugin",
						mcpMode: "none",
					});
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("clears user-scope install mode when review switches setup to project scope", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async () => {
				await withTempCwd(wd, async () => {
					await mkdir(join(wd, ".omx"), { recursive: true });
					await writeFile(
						join(wd, ".omx", "setup-scope.json"),
						JSON.stringify({ scope: "user", installMode: "plugin" }),
					);

					await setup({
						persistedSetupReviewPrompt: async () => "review",
						setupScopePrompt: async (defaultScope) => {
							assert.equal(defaultScope, "user");
							return "project";
						},
					});

					const persisted = JSON.parse(
						await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
					) as { scope: string; installMode?: string };
					assert.deepEqual(persisted, { scope: "project", mcpMode: "none" });
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reviews persisted scope when only install mode is provided", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async () => {
				await withTempCwd(wd, async () => {
					await mkdir(join(wd, ".omx"), { recursive: true });
					await writeFile(
						join(wd, ".omx", "setup-scope.json"),
						JSON.stringify({ scope: "project" }),
					);

					let reviewed = false;
					await setup({
						installMode: "plugin",
						persistedSetupReviewPrompt: async () => {
							reviewed = true;
							return "reset";
						},
						setupScopePrompt: async (defaultScope) => {
							assert.equal(defaultScope, "user");
							return "user";
						},
					});

					assert.equal(reviewed, true);
					const persisted = JSON.parse(
						await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
					) as { scope: string; installMode?: string };
					assert.deepEqual(persisted, {
						scope: "user",
						installMode: "plugin",
						mcpMode: "none",
					});
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reviews persisted install mode when only user scope is provided", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async () => {
				await withTempCwd(wd, async () => {
					await mkdir(join(wd, ".omx"), { recursive: true });
					await writeFile(
						join(wd, ".omx", "setup-scope.json"),
						JSON.stringify({ scope: "user", installMode: "legacy" }),
					);

					let reviewed = false;
					await setup({
						scope: "user",
						persistedSetupReviewPrompt: async () => {
							reviewed = true;
							return "review";
						},
						installModePrompt: async (defaultMode) => {
							assert.equal(defaultMode, "legacy");
							return "plugin";
						},
					});

					assert.equal(reviewed, true);
					const persisted = JSON.parse(
						await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
					) as { scope: string; installMode?: string };
					assert.deepEqual(persisted, {
						scope: "user",
						installMode: "plugin",
						mcpMode: "none",
					});
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("ignores persisted setup preferences when review chooses reset", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async () => {
				await withTempCwd(wd, async () => {
					await mkdir(join(wd, ".omx"), { recursive: true });
					await writeFile(
						join(wd, ".omx", "setup-scope.json"),
						JSON.stringify({ scope: "project", installMode: "plugin" }),
					);

					await setup({
						persistedSetupReviewPrompt: async () => "reset",
						setupScopePrompt: async (defaultScope) => {
							assert.equal(defaultScope, "user");
							return "user";
						},
						installModePrompt: async (defaultMode) => {
							assert.equal(defaultMode, "legacy");
							return "legacy";
						},
					});

					const persisted = JSON.parse(
						await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
					) as { scope: string; installMode?: string };
					assert.deepEqual(persisted, {
						scope: "user",
						installMode: "legacy",
						mcpMode: "none",
					});
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("installs native agent TOML files in plugin mode so agent_type roles are available", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const output = await runSetupWithCapturedLogs(wd, {
					scope: "user",
					installMode: "plugin",
				});

				assert.match(output, /Next steps:/);
				assert.match(
					output,
					/Registered Codex marketplace oh-my-codex-local supplies OMX skills and workflow surfaces/,
				);
				assert.match(output, /Native agent role TOML files written to \.codex\/agents\//);

				for (const role of ["architect", "critic", "scholastic"]) {
					const tomlPath = join(codexHomeDir, "agents", `${role}.toml`);
					assert.equal(existsSync(tomlPath), true, `${role}.toml should exist`);
					const toml = await readFile(tomlPath, "utf-8");
					assert.match(toml, new RegExp(`^name = "${role}"$`, "m"));
				}
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("omits Team plugin skills and native team executor when plugin mode disables Team", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-no-team-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({
						scope: "user",
						installMode: "plugin",
						teamMode: "disabled",
					});
				});

				const pkg = JSON.parse(
					await readFile(join(packageRoot, "package.json"), "utf-8"),
				) as { version: string };
				const cacheSkillsDir = join(
					codexHomeDir,
					"plugins",
					"cache",
					"oh-my-codex-local",
					"oh-my-codex",
					pkg.version,
					"skills",
				);
				assert.equal(existsSync(join(cacheSkillsDir, "team", "SKILL.md")), false);
				assert.equal(existsSync(join(cacheSkillsDir, "worker", "SKILL.md")), false);
				assert.equal(existsSync(join(cacheSkillsDir, "ralph", "SKILL.md")), true);
				assert.equal(existsSync(join(codexHomeDir, "agents", "team-executor.toml")), false);
				assert.equal(existsSync(join(codexHomeDir, "agents", "executor.toml")), true);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("keeps legacy-mode next steps describing native agent TOML output", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async () => {
				const output = await runSetupWithCapturedLogs(wd, {
					scope: "user",
					installMode: "legacy",
				});

				assert.match(output, /Next steps:/);
				assert.match(
					output,
					/Native agent role TOML files written to \.codex\/agents\/; use explicit agent_type when spawning OMX roles/,
				);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("persists user install mode choices alongside setup scope", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async () => {
				await withTempCwd(wd, async () => {
					await setup({ scope: "user", installMode: "plugin" });
				});
			});

			const persisted = JSON.parse(
				await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
			) as { scope: string; installMode?: string; mcpMode?: string };
			assert.deepEqual(persisted, {
				scope: "user",
				installMode: "plugin",
				mcpMode: "none",
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("defaults setup to no first-party MCP blocks", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-mcp-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({ scope: "user", installMode: "legacy" });
				});
				const config = await readFile(join(codexHomeDir, "config.toml"), "utf-8");
				assert.doesNotMatch(config, /^\[mcp_servers\.omx_state\]$/m);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("emits first-party MCP blocks when compat MCP mode is requested", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-mcp-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({ scope: "user", installMode: "legacy", mcpMode: "compat" });
				});
				const config = await readFile(join(codexHomeDir, "config.toml"), "utf-8");
				assert.match(config, /^\[mcp_servers\.omx_state\]$/m);
				const persisted = JSON.parse(
					await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
				) as { mcpMode?: string };
				assert.equal(persisted.mcpMode, "compat");
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("warns and preserves existing first-party MCP registrations in non-interactive default setup", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-mcp-preserve-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const configPath = join(codexHomeDir, "config.toml");
				await writeFile(
					configPath,
					[
						"[mcp_servers.omx_state]",
						'command = "node"',
						'args = ["/tmp/state-server.js"]',
						"",
						"[mcp_servers.user_tool]",
						'command = "user-tool"',
						"",
					].join("\n"),
				);
				const output = await runSetupWithCapturedLogs(wd, {
					scope: "user",
					installMode: "legacy",
				});
				const config = await readFile(configPath, "utf-8");
				assert.match(output, /deprecated first-party OMX MCP registrations were detected but preserved/);
				assert.match(config, /^\[mcp_servers\.omx_state\]$/m);
				assert.match(config, /^\[mcp_servers\.user_tool\]$/m);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("removes existing first-party MCP registrations only when the interactive migration prompt is accepted", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-mcp-remove-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const configPath = join(codexHomeDir, "config.toml");
				await writeFile(
					configPath,
					[
						"[mcp_servers.omx_state]",
						'command = "node"',
						'args = ["/tmp/state-server.js"]',
						"",
						"[mcp_servers.omx_team_run]",
						'command = "node"',
						"",
						"[mcp_servers.user_tool]",
						'command = "user-tool"',
						"",
					].join("\n"),
				);
				const output = await runSetupWithCapturedLogs(wd, {
					scope: "user",
					installMode: "legacy",
					firstPartyMcpRemovalPrompt: async (_path, kinds) => {
						assert.deepEqual(kinds, ["config.toml [mcp_servers.omx_*]"]);
						return true;
					},
				});
				const config = await readFile(configPath, "utf-8");
				assert.match(output, /Deprecated first-party OMX MCP registrations will be removed/);
				assert.doesNotMatch(config, /^\[mcp_servers\.omx_state\]$/m);
				assert.doesNotMatch(config, /^\[mcp_servers\.omx_team_run\]$/m);
				assert.match(config, /^\[mcp_servers\.user_tool\]$/m);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves existing first-party MCP registrations when the interactive migration prompt is declined", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-mcp-decline-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const configPath = join(codexHomeDir, "config.toml");
				await writeFile(
					configPath,
					"[mcp_servers.omx_memory]\ncommand = \"node\"\n\n[mcp_servers.user_tool]\ncommand = \"user-tool\"\n",
				);
				await withTempCwd(wd, async () => {
					await setup({
						scope: "user",
						installMode: "legacy",
						firstPartyMcpRemovalPrompt: async () => false,
					});
				});
				const config = await readFile(configPath, "utf-8");
				assert.match(config, /^\[mcp_servers\.omx_memory\]$/m);
				assert.match(config, /^\[mcp_servers\.user_tool\]$/m);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("defaults to plugin mode when an installed oh-my-codex plugin cache is discovered", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const pluginDir = join(
						codexHomeDir,
						"plugins",
						"cache",
						"oh-my-codex-local",
						"oh-my-codex",
					);
					await mkdir(join(pluginDir, ".codex-plugin"), { recursive: true });
					await writeFile(
						join(pluginDir, ".codex-plugin", "plugin.json"),
						JSON.stringify({ name: "oh-my-codex", version: "local" }),
					);

					await setup({ scope: "user" });

					const persisted = JSON.parse(
						await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
					) as { scope: string; installMode?: string };
					assert.deepEqual(persisted, {
						scope: "user",
						installMode: "plugin",
						mcpMode: "none",
					});
					assert.equal(
						existsSync(join(codexHomeDir, "skills", "ask", "SKILL.md")),
						false,
					);
					assert.equal(existsSync(join(codexHomeDir, "hooks.json")), false);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("defaults project setup to plugin mode when an installed oh-my-codex plugin cache is discovered", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const pluginDir = join(
						codexHomeDir,
						"plugins",
						"cache",
						"oh-my-codex-local",
						"oh-my-codex",
					);
					await mkdir(join(pluginDir, ".codex-plugin"), { recursive: true });
					await writeFile(
						join(pluginDir, ".codex-plugin", "plugin.json"),
						JSON.stringify({ name: "oh-my-codex", version: "local" }),
					);

					await setup({ scope: "project" });

					await assertProjectPluginModeArtifacts(wd);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("invalidates stale plugin discovery caches so updated plugin skills refresh", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const cacheDir = await seedStalePluginDiscoveryCache(codexHomeDir);

					const output = await captureConsoleOutput(async () => {
						await setup({ scope: "user", installMode: "plugin" });
					});

					assert.equal(existsSync(join(cacheDir, "skills", "old-only", "SKILL.md")), false);
					assert.equal(
						existsSync(join(await packagedPluginCacheDir(codexHomeDir), "skills", "ask", "SKILL.md")),
						true,
					);
					assert.match(
						output,
						/Invalidated 1 stale Codex plugin discovery cache entry/,
					);
					assert.equal(
						existsSync(join(codexHomeDir, "skills", "old-only", "SKILL.md")),
						false,
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("invalidates old versioned plugin cache dirs while materializing the current cache", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const oldCacheDir = await seedOldVersionedPluginDiscoveryCache(codexHomeDir);

					const output = await captureConsoleOutput(async () => {
						await setup({ scope: "user", installMode: "plugin" });
					});

					const currentCacheDir = await packagedPluginCacheDir(codexHomeDir);
					assert.equal(existsSync(oldCacheDir), false);
					assert.equal(existsSync(join(currentCacheDir, ".codex-plugin", "plugin.json")), true);
					assert.equal(existsSync(join(currentCacheDir, "hooks", "hooks.json")), true);
					assert.equal(existsSync(join(currentCacheDir, "hooks", "codex-native-hook.mjs")), true);
					assert.equal(existsSync(join(currentCacheDir, "hooks", "omx-command.json")), true);
					assert.equal(existsSync(join(currentCacheDir, "skills", "ask", "SKILL.md")), true);
					assert.match(output, /Invalidated 1 stale Codex plugin discovery cache entry/);
					assert.match(output, /Installed local Codex plugin cache/);
					assert.doesNotMatch(output, /Retained .* old versioned Codex plugin cache/);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("invalidates same-version plugin caches when hook file contents drift", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const cacheDir = await seedSameVersionPluginCacheWithStaleHooks(codexHomeDir);

					const output = await captureConsoleOutput(async () => {
						await setup({ scope: "user", installMode: "plugin" });
					});

					const refreshedHooks = JSON.parse(
						await readFile(join(cacheDir, "hooks", "hooks.json"), "utf-8"),
					) as { hooks?: { PreToolUse?: Array<{ matcher?: unknown }> } };
					assert.equal(refreshedHooks.hooks?.PreToolUse?.[0]?.matcher, undefined);
					assert.match(output, /Invalidated 1 stale Codex plugin discovery cache entry/);
					assert.match(output, /Installed local Codex plugin cache/);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("invalidates same-version plugin caches when the pinned hook launcher drifts", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const cacheDir = await seedSameVersionPluginCacheWithStaleLauncher(codexHomeDir);

					const output = await captureConsoleOutput(async () => {
						await setup({ scope: "user", installMode: "plugin" });
					});

					const launcher = JSON.parse(
						await readFile(join(cacheDir, "hooks", "omx-command.json"), "utf-8"),
					) as { command?: string; argsPrefix?: string[] };
					assert.equal(launcher.command, process.execPath);
					assert.deepEqual(launcher.argsPrefix, [join(packageRoot, "dist", "cli", "omx.js")]);
					assert.match(output, /Invalidated 1 stale Codex plugin discovery cache entry/);
					assert.match(output, /Installed local Codex plugin cache/);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("materializes replacement plugin caches without removing the existing cache root", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const cacheDir = await seedSameVersionPluginCacheWithStaleHooks(codexHomeDir);
				const staleOnlyPath = join(cacheDir, "stale-only.txt");
				await writeFile(staleOnlyPath, "stale\n");
				const packagedMarketplace = await resolvePackagedOmxMarketplace(packageRoot);
				assert.ok(packagedMarketplace, "expected packaged OMX plugin marketplace fixture");

				let observedPreparedCache = false;
				await materializePackagedOmxPluginCache(codexHomeDir, packagedMarketplace, {
					onCacheDirPrepared: async (preparedCacheDir) => {
						if (preparedCacheDir !== cacheDir) return;
						observedPreparedCache = true;
						assert.equal(existsSync(cacheDir), true, "cache root must remain present before overlay replacement starts");
						assert.equal(existsSync(join(cacheDir, ".codex-plugin", "plugin.json")), true);
						assert.equal(existsSync(join(cacheDir, "hooks", "codex-native-hook.mjs")), true);
					},
				});

				assert.equal(observedPreparedCache, true, "test hook should observe cache root during replacement");
				assert.equal(existsSync(cacheDir), true);
				assert.equal(existsSync(join(cacheDir, ".codex-plugin", "plugin.json")), true);
				assert.equal(existsSync(join(cacheDir, "hooks", "codex-native-hook.mjs")), true);
				assert.equal(existsSync(join(cacheDir, "hooks", "omx-command.json")), true);
				assert.equal(existsSync(staleOnlyPath), false, "overlay cleanup should remove stale files after refreshed files are present");
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reports stale plugin discovery cache invalidation during dry-run without deleting it", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const cacheDir = await seedStalePluginDiscoveryCache(codexHomeDir);

					const output = await captureConsoleOutput(async () => {
						await setup({ scope: "user", installMode: "plugin", dryRun: true });
					});

					assert.equal(existsSync(cacheDir), true);
					assert.match(
						output,
						/Would invalidate 1 stale Codex plugin discovery cache entry/,
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reports plugin cache materialization during dry-run without writing cache", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const output = await captureConsoleOutput(async () => {
						await setup({ scope: "user", installMode: "plugin", dryRun: true });
					});

					const cacheDir = await packagedPluginCacheDir(codexHomeDir);
					assert.equal(existsSync(cacheDir), false);
					assert.match(output, /Would install local Codex plugin cache/);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("does not prompt for install mode during project-scoped setup", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		let promptCalls = 0;
		try {
			await withIsolatedUserHome(wd, async () => {
				await withTempCwd(wd, async () => {
					await setup({
						scope: "project",
						installModePrompt: async () => {
							promptCalls += 1;
							return "plugin";
						},
					});
				});
			});

			assert.equal(promptCalls, 0);
			const persisted = JSON.parse(
				await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
			) as { scope: string; installMode?: string };
			assert.deepEqual(persisted, { scope: "project", mcpMode: "none" });
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("defaults project setup to plugin mode after user plugin setup installs plugin cache", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async () => {
				await withTempCwd(wd, async () => {
					await setup({ scope: "user", installMode: "plugin" });

					await setup({ scope: "project" });

					const persisted = JSON.parse(
						await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
					) as { scope: string; installMode?: string };
					assert.deepEqual(persisted, {
						scope: "project",
						installMode: "plugin",
						mcpMode: "none",
					});
					assert.equal(existsSync(join(wd, ".codex", "hooks.json")), false);
					assert.equal(
						existsSync(join(wd, ".codex", "skills", "ask", "SKILL.md")),
						false,
					);

					await setup({ scope: "project" });

					const repeatedPersisted = JSON.parse(
						await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
					) as { scope: string; installMode?: string };
					assert.deepEqual(repeatedPersisted, {
						scope: "project",
						installMode: "plugin",
						mcpMode: "none",
					});
					assert.equal(
						existsSync(join(wd, ".codex", "agents", "planner.toml")),
						true,
					);
					assert.equal(
						existsSync(join(wd, ".codex", "prompts", "executor.md")),
						false,
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("does not reuse stale project install mode for user-scoped setup", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({ scope: "project", installMode: "plugin" });

					await setup({ scope: "user" });

					const persisted = JSON.parse(
						await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
					) as { scope: string; installMode?: string };
					assert.deepEqual(persisted, {
						scope: "user",
						installMode: "legacy",
						mcpMode: "none",
					});
					assert.equal(
						existsSync(join(codexHomeDir, "skills", "ask", "SKILL.md")),
						true,
					);
					assert.equal(
						existsSync(join(codexHomeDir, "agents", "planner.toml")),
						true,
					);
					assert.equal(
						existsSync(join(codexHomeDir, "prompts", "executor.md")),
						true,
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("registers the local Codex plugin marketplace without reintroducing legacy assets", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const configPath = join(codexHomeDir, "config.toml");
					await writeFile(
						configPath,
						[
							'model = "gpt-5.6-sol"',
							"",
							"[marketplaces.other]",
							'source_type = "local"',
							'source = "/tmp/other"',
							"",
							"[marketplaces.oh-my-codex-local]",
							'source_type = "local"',
							'source = "/tmp/stale-oh-my-codex"',
							"",
						].join("\n"),
					);

					await setup({ scope: "user", installMode: "plugin", force: true });
					await setup({ scope: "user", installMode: "plugin", force: true });

					const config = await readFile(configPath, "utf-8");
					const parsed = parseToml(config) as {
						marketplaces?: Record<
							string,
							{ source_type?: string; source?: string }
						>;
						plugins?: Record<string, { enabled?: boolean }>;
					};
					assert.equal(
						parsed.marketplaces?.["oh-my-codex-local"]?.source_type,
						"local",
					);
					assert.equal(
						parsed.marketplaces?.["oh-my-codex-local"]?.source,
						packageRoot,
					);
					assert.equal(parsed.marketplaces?.other?.source_type, "local");
					assert.equal(parsed.marketplaces?.other?.source, "/tmp/other");
					assert.equal(
						(config.match(/^\[marketplaces\.oh-my-codex-local\]$/gm) ?? [])
							.length,
						1,
					);
					assert.equal(
						(config.match(/^\[plugins\."oh-my-codex@oh-my-codex-local"\]$/gm) ?? [])
							.length,
						1,
					);
					assert.equal(
						parsed.plugins?.["oh-my-codex@oh-my-codex-local"]?.enabled,
						true,
					);
					const cacheDir = await packagedPluginCacheDir(codexHomeDir);
					assert.equal(
						existsSync(join(cacheDir, ".codex-plugin", "plugin.json")),
						true,
					);
					assert.equal(
						existsSync(join(cacheDir, "skills", "ask", "SKILL.md")),
						true,
					);
					assert.match(config, /^plugin_hooks = true$/m);
					assert.doesNotMatch(config, /^hooks = true$/m);
					assert.doesNotMatch(config, /^codex_hooks = true$/m);
					assert.doesNotMatch(config, /\[mcp_servers\./);
					assert.equal(
						existsSync(join(codexHomeDir, "skills", "ask", "SKILL.md")),
						false,
					);
					assert.equal(
						existsSync(join(codexHomeDir, "agents", "planner.toml")),
						true,
					);
					assert.equal(
						existsSync(join(codexHomeDir, "prompts", "executor.md")),
						false,
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("enables the local Codex plugin while preserving plugin subtable policy", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const configPath = join(codexHomeDir, "config.toml");
					await writeFile(
						configPath,
						[
							"[plugins.\"oh-my-codex@oh-my-codex-local\"]",
							"enabled = false",
							"",
							"[plugins.\"oh-my-codex@oh-my-codex-local\".mcp_servers.omx_state]",
							"enabled = false",
							"",
						].join("\n"),
					);

					await setup({ scope: "user", installMode: "plugin", force: true });
					await setup({ scope: "user", installMode: "plugin", force: true });

					const config = await readFile(configPath, "utf-8");
					const parsed = parseToml(config) as {
						plugins?: Record<
							string,
							{
								enabled?: boolean;
								mcp_servers?: Record<string, { enabled?: boolean }>;
							}
						>;
					};

					assert.equal(
						(config.match(/^\[plugins\."oh-my-codex@oh-my-codex-local"\]$/gm) ?? [])
							.length,
						1,
					);
					assert.equal(
						parsed.plugins?.["oh-my-codex@oh-my-codex-local"]?.enabled,
						true,
					);
					assert.equal(
						parsed.plugins?.["oh-my-codex@oh-my-codex-local"]?.mcp_servers
							?.omx_state?.enabled,
						false,
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("registers plugin MCP subtables only when compat MCP mode is requested", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const configPath = join(codexHomeDir, "config.toml");

					await setup({
						scope: "user",
						installMode: "plugin",
						mcpMode: "compat",
						force: true,
					});
					let parsed = parseToml(await readFile(configPath, "utf-8")) as {
						plugins?: Record<
							string,
							{ mcp_servers?: Record<string, { enabled?: boolean }> }
						>;
					};
					assert.equal(
						parsed.plugins?.["oh-my-codex@oh-my-codex-local"]?.mcp_servers
							?.omx_state?.enabled,
						true,
					);

					await setup({
						scope: "user",
						installMode: "plugin",
						mcpMode: "none",
						force: true,
					});
					parsed = parseToml(await readFile(configPath, "utf-8")) as {
						plugins?: Record<
							string,
							{ mcp_servers?: Record<string, { enabled?: boolean }> }
						>;
					};
					assert.equal(
						parsed.plugins?.["oh-my-codex@oh-my-codex-local"]?.mcp_servers
							?.omx_state?.enabled,
						true,
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("removes plugin MCP registrations only when the migration prompt is accepted", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-plugin-mcp-remove-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const configPath = join(codexHomeDir, "config.toml");
				await writeFile(
					configPath,
					[
						"[mcp_servers.omx_state]",
						'command = "node"',
						"",
						'[plugins."oh-my-codex@oh-my-codex-local"]',
						"enabled = true",
						"",
						'[plugins."oh-my-codex@oh-my-codex-local".mcp_servers.omx_memory]',
						"enabled = true",
						"",
					].join("\n"),
				);
				await withTempCwd(wd, async () => {
					await setup({
						scope: "user",
						installMode: "plugin",
						firstPartyMcpRemovalPrompt: async (_path, kinds) => {
							assert.deepEqual(kinds, [
								"config.toml [mcp_servers.omx_*]",
								"plugin mcp_servers overrides",
							]);
							return true;
						},
					});
				});
				const config = await readFile(configPath, "utf-8");
				assert.doesNotMatch(config, /mcp_servers\.omx_state/);
				assert.doesNotMatch(config, /mcp_servers\.omx_memory/);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves plugin-mode top-level MCP registrations without duplicating them when removal is declined", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-plugin-mcp-preserve-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const configPath = join(codexHomeDir, "config.toml");
				await writeFile(
					configPath,
					[
						"[mcp_servers.omx_state]",
						'command = "node"',
						"",
						"[mcp_servers.user_tool]",
						'command = "user-tool"',
						"",
					].join("\n"),
				);
				await withTempCwd(wd, async () => {
					await setup({
						scope: "user",
						installMode: "plugin",
						firstPartyMcpRemovalPrompt: async () => false,
					});
				});
				const config = await readFile(configPath, "utf-8");
				assert.equal(config.match(/^\[mcp_servers\.omx_state\]$/gm)?.length, 1);
				assert.match(config, /^\[mcp_servers\.user_tool\]$/m);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reports plugin marketplace registration during dry-run without mutating config", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const configPath = join(codexHomeDir, "config.toml");
					await writeFile(configPath, 'model = "gpt-5.6-sol"\n');

					const output = await captureConsoleOutput(async () => {
						await setup({ scope: "user", installMode: "plugin", dryRun: true });
					});

					assert.match(
						output,
						/Would register local Codex plugin marketplace oh-my-codex-local/,
					);
					assert.equal(
						await readFile(configPath, "utf-8"),
						'model = "gpt-5.6-sol"\n',
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("uses plugin-scoped hooks when plugin mode is selected", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({ scope: "user", installMode: "plugin" });
					await setup({ scope: "user", installMode: "plugin" });

					assert.equal(existsSync(join(codexHomeDir, "hooks.json")), false);
					const config = await readFile(
						join(codexHomeDir, "config.toml"),
						"utf-8",
					);
					assert.match(config, /^plugin_hooks = true$/m);
					assert.doesNotMatch(config, /^hooks = true$/m);
					assert.doesNotMatch(config, /^codex_hooks = true$/m);
					assert.match(config, /^goals = true$/m);
					assert.doesNotMatch(config, /\[hooks\.state\./);
					assert.doesNotMatch(
						config,
						/developer_instructions|notify-hook/g,
					);
					assert.equal(
						existsSync(join(codexHomeDir, "skills", "ask", "SKILL.md")),
						false,
					);
					assert.equal(
						existsSync(join(codexHomeDir, "agents", "planner.toml")),
						true,
					);
					assert.equal(
						existsSync(join(codexHomeDir, "prompts", "executor.md")),
						false,
					);
					assert.equal(existsSync(join(codexHomeDir, "AGENTS.md")), true);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("can opt into plugin AGENTS.md and developer_instructions defaults", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({
						scope: "user",
						installMode: "plugin",
						pluginAgentsMdPrompt: async () => true,
						pluginDeveloperInstructionsPrompt: async () => true,
					});

					assert.equal(existsSync(join(codexHomeDir, "hooks.json")), false);
					assert.equal(
						existsSync(join(codexHomeDir, "skills", "ask", "SKILL.md")),
						false,
					);
					assert.equal(
						existsSync(join(codexHomeDir, "agents", "planner.toml")),
						true,
					);
					assert.equal(
						existsSync(join(codexHomeDir, "prompts", "executor.md")),
						false,
					);

					const config = await readFile(
						join(codexHomeDir, "config.toml"),
						"utf-8",
					);
					assert.match(config, /developer_instructions\s*=/);
					assert.match(config, /<omx version=\\"1\\">You have oh-my-codex installed through Codex plugin mode/);
					assert.ok(config.includes("detail.</omx>"));
					assert.match(
						config,
						/Registered Codex plugin marketplace surfaces supply OMX workflows and plugin-scoped companion resources/,
					);
					assert.match(config, /User-installed skills may still live under ~\/.codex\/skills/);
					assert.match(
						config,
						/native agent roles are installed as setup-owned Codex agent TOML files in plugin mode so agent_type routing works/i,
					);
					assert.match(
						config,
						/When the native surface exposes `agent_type` role routing, set `agent_type` to an installed role and never omit it for OMX work/i,
					);
					assert.match(config, /role_routing_unavailable/i);
					assert.match(config, /do not fabricate `agent_type`/i);
					assert.match(config, /omx ralplan preflight --json/i);
					assert.match(config, /unsupported_documented_leader_proof/i);
					assert.match(config, /never fake the role via a prompt label/i);
					assert.doesNotMatch(config, /Native subagents live in \.codex\/agents/);
					assert.doesNotMatch(config, /Treat installed prompts as narrower execution surfaces/);
					assert.match(config, /^plugin_hooks = true$/m);
					assert.doesNotMatch(config, /notify-hook/);
					assert.doesNotMatch(config, /^\s*\[mcp_servers[.\]]/m);
					assert.doesNotMatch(config, /mcp_servers\.omx_state/);

					const agentsMd = await readFile(
						join(codexHomeDir, "AGENTS.md"),
						"utf-8",
					);
					assert.match(
						agentsMd,
						/oh-my-codex - Intelligent Multi-Agent Orchestration/,
					);
					assert.match(agentsMd, /<!-- omx:generated:agents-md -->/);
					assert.match(agentsMd, /<!-- OMX:MODELS:START -->/);
					assert.match(agentsMd, /<!-- OMX:MODELS:END -->/);
					assert.match(agentsMd, /<guidance_schema_contract>/);
					assert.match(agentsMd, /<execution_protocols>/);
					assert.match(
						agentsMd,
						/AGENTS\.md is the top-level operating contract/,
					);
					assert.match(
						agentsMd,
						/Registered Codex plugin marketplace surfaces supply OMX workflows and plugin-scoped companion resources/,
					);
					assert.match(agentsMd, /User-installed skills may still live under `~\/.codex\/skills`/);
					assert.match(
						agentsMd,
						/native agent roles are installed as setup-owned Codex agent TOML files in plugin mode so agent_type routing works/i,
					);
					assert.doesNotMatch(agentsMd, /Role prompts under `prompts\/\*\.md`/);
					assert.doesNotMatch(agentsMd, /load the installed prompt\/skill\/agent surfaces from/);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("uses project-scoped plugin AGENTS.md wording without legacy prompt or agent paths", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async () => {
				await withTempCwd(wd, async () => {
					await setup({
						scope: "project",
						installMode: "plugin",
						pluginAgentsMdPrompt: async () => true,
						pluginDeveloperInstructionsPrompt: async () => false,
					});

					const agentsMd = await readFile(join(wd, "AGENTS.md"), "utf-8");
					assert.match(
						agentsMd,
						/Registered Codex plugin marketplace surfaces supply OMX workflows and plugin-scoped companion resources/,
					);
					assert.match(
						agentsMd,
						/User-installed skills may still live under `\.\/.codex\/skills` for project scope, or `~\/.codex\/skills` for user-installed skills/,
					);
					assert.doesNotMatch(agentsMd, /`~\/.codex\/prompts`/);
					assert.doesNotMatch(agentsMd, /`~\/.codex\/agents`/);
					assert.doesNotMatch(agentsMd, /Role prompts under `prompts\/\*\.md`/);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves custom developer_instructions without prompting", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const configPath = join(codexHomeDir, "config.toml");
					const existingConfig = 'developer_instructions = "custom"\n';
					await writeFile(configPath, existingConfig);

					let promptCount = 0;
					await setup({
						scope: "user",
						installMode: "plugin",
						pluginDeveloperInstructionsPrompt: async () => {
							promptCount += 1;
							return true;
						},
					});

					assert.equal(promptCount, 0);
					const config = await readFile(configPath, "utf-8");
					assert.match(config, /^developer_instructions = "custom"$/m);
					assert.match(config, /^plugin_hooks = true$/m);
					assert.equal(
						(config.match(/^developer_instructions\s*=/gm) ?? []).length,
						1,
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves current wrapped developer_instructions without prompting", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const configPath = join(codexHomeDir, "config.toml");
					await writeFile(
						configPath,
						`developer_instructions = ${JSON.stringify(OMX_PLUGIN_DEVELOPER_INSTRUCTIONS)}\n`,
					);

					let promptCount = 0;
					await setup({
						scope: "user",
						installMode: "plugin",
						pluginDeveloperInstructionsPrompt: async () => {
							promptCount += 1;
							return "refresh";
						},
					});

					assert.equal(promptCount, 0);
					const config = await readFile(configPath, "utf-8");
					assert.match(config, /<omx version=\\"1\\">You have oh-my-codex installed through Codex plugin mode/);
					assert.equal(
						(config.match(/^developer_instructions\s*=/gm) ?? []).length,
						1,
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("migrates historical unwrapped developer_instructions after prompting", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const configPath = join(codexHomeDir, "config.toml");
					const latestUnwrapped =
						"You have oh-my-codex installed through Codex plugin mode. AGENTS.md is the orchestration brain and main control surface. Follow AGENTS.md for skill/keyword routing and $name workflow invocation. When spawning native subagents, set `agent_type` to an installed role and never omit it for OMX work. Registered Codex plugin marketplace surfaces supply OMX workflows and plugin-scoped companion resources when the plugin is installed; native agent roles are installed as setup-owned Codex agent TOML files in plugin mode so agent_type routing works. User-installed skills may still live under ~/.codex/skills. Use outcome-first, concise progress updates: state the target result, constraints, validation evidence, and stop condition before adding process detail.";
					await writeFile(
						configPath,
						`developer_instructions = ${JSON.stringify(latestUnwrapped)}\n`,
					);

					let promptCount = 0;
					await setup({
						scope: "user",
						installMode: "plugin",
						pluginDeveloperInstructionsPrompt: async () => {
							promptCount += 1;
							return "refresh";
						},
					});

					assert.equal(promptCount, 1);
					const config = await readFile(configPath, "utf-8");
					assert.match(
						config,
						/<omx version=\\"1\\">You have oh-my-codex installed through Codex plugin mode/,
					);
					assert.match(
						config,
						/When the native surface exposes `agent_type` role routing, set `agent_type` to an installed role and never omit it for OMX work/i,
					);
					assert.match(config, /role_routing_unavailable/i);
					assert.match(config, /omx ralplan preflight --json/i);
					assert.equal(
						(config.match(/^developer_instructions\s*=/gm) ?? []).length,
						1,
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("updates managed classic developer_instructions during plugin migration", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const configPath = join(codexHomeDir, "config.toml");
					await writeFile(
						configPath,
						`developer_instructions = ${JSON.stringify(OMX_DEVELOPER_INSTRUCTIONS)}\n`,
					);

					let promptCount = 0;
					await setup({
						scope: "user",
						installMode: "plugin",
						pluginDeveloperInstructionsPrompt: async () => {
							promptCount += 1;
							return true;
						},
					});

					assert.equal(promptCount, 1);
					const config = await readFile(configPath, "utf-8");
					assert.match(
						config,
						/<omx version=\\"1\\">You have oh-my-codex installed through Codex plugin mode/,
					);
					assert.doesNotMatch(
						config,
						/You have oh-my-codex installed\\. AGENTS\\.md/,
					);
					assert.equal(
						(config.match(/^developer_instructions\s*=/gm) ?? []).length,
						1,
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves managed classic developer_instructions when plugin migration refresh is declined", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const configPath = join(codexHomeDir, "config.toml");
					await writeFile(
						configPath,
						`developer_instructions = ${JSON.stringify(OMX_DEVELOPER_INSTRUCTIONS)}\n`,
					);

					await setup({
						scope: "user",
						installMode: "plugin",
						pluginDeveloperInstructionsPrompt: async () => false,
					});

					const config = await readFile(configPath, "utf-8");
					assert.match(config, /You have oh-my-codex installed\. AGENTS\.md/);
					assert.doesNotMatch(config, /<omx version=/);
					assert.equal(
						(config.match(/^developer_instructions\s*=/gm) ?? []).length,
						1,
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves edited classic developer_instructions containing the legacy phrase", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const configPath = join(codexHomeDir, "config.toml");
					const edited = `${OMX_DEVELOPER_INSTRUCTIONS}\nCustom local rule: keep this line.`;
					await writeFile(
						configPath,
						`developer_instructions = ${JSON.stringify(edited)}\n`,
					);

					let promptCount = 0;
					await setup({
						scope: "user",
						installMode: "plugin",
						pluginDeveloperInstructionsPrompt: async () => {
							promptCount += 1;
							return true;
						},
					});

					assert.equal(promptCount, 0);
					const config = await readFile(configPath, "utf-8");
					assert.match(config, /You have oh-my-codex installed\. AGENTS\.md/);
					assert.match(config, /Custom local rule: keep this line/);
					assert.doesNotMatch(config, /<omx version=/);
					assert.equal(
						(config.match(/^developer_instructions\s*=/gm) ?? []).length,
						1,
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves edited wrapper developer_instructions as custom without prompting", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const configPath = join(codexHomeDir, "config.toml");
					const edited = '<omx version="1">Custom instructions</omx>';
					await writeFile(
						configPath,
						`developer_instructions = ${JSON.stringify(edited)}\n`,
					);

					let promptCount = 0;
					await setup({
						scope: "user",
						installMode: "plugin",
						pluginDeveloperInstructionsPrompt: async () => {
							promptCount += 1;
							return "refresh";
						},
					});

					assert.equal(promptCount, 0);
					const config = await readFile(configPath, "utf-8");
					assert.match(config, /Custom instructions/);
					assert.doesNotMatch(config, /Registered Codex plugin marketplace surfaces supply OMX workflows/);
					assert.equal(
						(config.match(/^developer_instructions\s*=/gm) ?? []).length,
						1,
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves changed-version wrapper developer_instructions as custom without prompting", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const configPath = join(codexHomeDir, "config.toml");
					const edited = '<omx version="2">Custom instructions</omx>';
					await writeFile(
						configPath,
						`developer_instructions = ${JSON.stringify(edited)}\n`,
					);

					let promptCount = 0;
					await setup({
						scope: "user",
						installMode: "plugin",
						pluginDeveloperInstructionsPrompt: async () => {
							promptCount += 1;
							return "refresh";
						},
					});

					assert.equal(promptCount, 0);
					const config = await readFile(configPath, "utf-8");
					assert.match(config, /version=\\"2\\">Custom instructions/);
					assert.doesNotMatch(config, /Registered Codex plugin marketplace surfaces supply OMX workflows/);
					assert.equal(
						(config.match(/^developer_instructions\s*=/gm) ?? []).length,
						1,
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("does not refresh custom developer_instructions from plugin policy prompt", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const configPath = join(codexHomeDir, "config.toml");
					await writeFile(configPath, 'developer_instructions = "custom"\n');

					let promptCount = 0;
					await setup({
						scope: "user",
						installMode: "plugin",
						pluginDeveloperInstructionsPrompt: async () => {
							promptCount += 1;
							return "refresh";
						},
					});

					assert.equal(promptCount, 0);
					const config = await readFile(configPath, "utf-8");
					assert.match(config, /^developer_instructions = "custom"$/m);
					assert.equal(
						(config.match(/^developer_instructions\s*=/gm) ?? []).length,
						1,
					);
					assert.match(config, /^plugin_hooks = true$/m);
					assert.doesNotMatch(config, /\[hooks\.state\./);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("does not add developer_instructions in non-interactive plugin mode", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const configPath = join(codexHomeDir, "config.toml");

					await setup({
						scope: "user",
						installMode: "plugin",
					});

					const config = await readFile(configPath, "utf-8");
					assert.doesNotMatch(config, /^developer_instructions\s*=/m);
					assert.match(config, /^plugin_hooks = true$/m);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("uses legacy codex_hooks only when the installed Codex reports that hook feature", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({
						scope: "user",
						installMode: "plugin",
						codexFeaturesProbe: () =>
							"codex_hooks                             experimental       true\n",
						codexVersionProbe: () => "codex-cli 0.129.0",
					});

					const config = await readFile(
						join(codexHomeDir, "config.toml"),
						"utf-8",
					);
					assert.match(config, /^codex_hooks = true$/m);
					assert.doesNotMatch(config, /^hooks = true$/m);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("removes legacy setup-managed hook wrappers when plugin-scoped hooks are supported", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({
						scope: "user",
						installMode: "plugin",
						codexFeaturesProbe: () =>
							"hooks                                   stable             true\n",
					});

					const hooksPath = join(codexHomeDir, "hooks.json");
					assert.equal(existsSync(hooksPath), true);

					await setup({
						scope: "user",
						installMode: "plugin",
						codexFeaturesProbe: () =>
							[
								"hooks                                   stable             true",
								"plugin_hooks                            experimental       true",
								"",
							].join("\n"),
					});

					assert.equal(existsSync(hooksPath), false);
					const config = await readFile(
						join(codexHomeDir, "config.toml"),
						"utf-8",
					);
					assert.match(config, /^plugin_hooks = true$/m);
					assert.doesNotMatch(config, /^hooks = true$/m);
					assert.doesNotMatch(config, /\[hooks\.state\./);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("fails before plugin transition writes when marker-wrapped trust state has foreign siblings", async () => {
		const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
		const representations = [
			{
				name: "inline",
				render: (key: string, hash: string) => [
					`hooks = { state = { ${JSON.stringify(key)} = { trusted_hash = ${JSON.stringify(hash)}, foreign = true } } }`,
				],
			},
			{
				name: "dotted",
				render: (key: string, hash: string) => [
					`hooks.state.${JSON.stringify(key)}.trusted_hash = ${JSON.stringify(hash)}`,
					`hooks.state.${JSON.stringify(key)}.foreign = true`,
				],
			},
			{
				name: "table",
				render: (key: string, hash: string) => [
					`[hooks.state.${JSON.stringify(key)}]`,
					`trusted_hash = ${JSON.stringify(hash)}`,
					"foreign = true",
				],
			},
			{
				name: "separate-foreign-table",
				render: (key: string, hash: string) => [
					`[hooks.state.${JSON.stringify(key)}]`,
					`trusted_hash = ${JSON.stringify(hash)}`,
					"",
					'[hooks.state."foreign-key"]',
					'trusted_hash = "sha256:foreign"',
				],
			},
		] as const;
		try {
			for (const representation of representations) {
				const wd = await mkdtemp(join(tmpdir(), `omx-plugin-trust-${representation.name}-`));
				try {
					await withIsolatedUserHome(wd, async (codexHomeDir) => {
						await withTempCwd(wd, async () => {
							const configPath = join(codexHomeDir, "config.toml");
							const hooksPath = join(codexHomeDir, "hooks.json");
							const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
							const metadataPath = join(codexHomeDir, ".omx", "notify-dispatch.json");
							const hooks = `${JSON.stringify(
								buildManagedCodexHooksConfig(packageRoot, {
									platform: "win32",
									codexHomeDir,
								}),
								null,
								2,
							)}\n`;
							const [key, trust] = Object.entries(
								buildManagedCodexHookTrustState(hooksPath, packageRoot, {
									platform: "win32",
									codexHomeDir,
									hooksContent: hooks,
								}),
							)[0] ?? [];
							assert.ok(key);
							assert.ok(trust);
							const config = [
								'model = "foreign"',
								"",
								"# ============================================================",
								"# oh-my-codex (OMX) Configuration",
								"# Managed by omx setup - manual edits preserved on next setup",
								"# ============================================================",
								"",
								...representation.render(key, trust.trusted_hash),
								"",
								"# ============================================================",
								"# End oh-my-codex",
								"",
							].join("\n");
							const metadata = Buffer.from('{"managedBy":"foreign"}\n', "utf-8");
							const shim = Buffer.from(
								buildManagedCodexNativeHookWindowsShimContent(packageRoot),
								"utf-8",
							);
							await mkdir(dirname(metadataPath), { recursive: true });
							await writeFile(configPath, config);
							await writeFile(hooksPath, hooks);
							await writeFile(shimPath, shim);
							await writeFile(metadataPath, metadata);

							await assert.rejects(
								setup({
									scope: "user",
									installMode: "plugin",
									pluginAgentsMdPrompt: async () => false,
									codexFeaturesProbe: () =>
										"hooks stable true\nplugin_hooks experimental true\n",
								}),
								(error: unknown) =>
									typeof error === "object" &&
									error !== null &&
									"code" in error &&
									(error as { code?: unknown }).code === "managed_trust_key_conflict",
							);
							assert.deepEqual(await readFile(configPath), Buffer.from(config, "utf-8"));
							assert.deepEqual(await readFile(hooksPath), Buffer.from(hooks, "utf-8"));
							assert.deepEqual(await readFile(shimPath), shim);
							assert.deepEqual(await readFile(metadataPath), metadata);
							assert.deepEqual(
								(await readdir(codexHomeDir)).filter((entry) => entry.includes(".omx-")),
								[],
							);
							assert.deepEqual(
								(await readdir(wd)).filter((entry) => entry.includes(".omx-")),
								[],
							);
						});
					});
				} finally {
					await rm(wd, { recursive: true, force: true });
				}
			}
		} finally {
			resetPlatform();
		}
	});
	it("fails before plugin transition writes when marker trust has absent or non-managed hooks expectations", async () => {
		const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
		const fixtures = [
			{ name: "absent", hooks: null },
			{
				name: "non-managed",
				hooks: `${JSON.stringify({
					hooks: {
						UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo foreign" }] }],
					},
				}, null, 2)}\n`,
			},
		] as const;
		try {
			for (const fixture of fixtures) {
				const wd = await mkdtemp(join(tmpdir(), `omx-plugin-marker-${fixture.name}-`));
				try {
					await withIsolatedUserHome(wd, async (codexHomeDir) => {
						await withTempCwd(wd, async () => {
							const configPath = join(codexHomeDir, "config.toml");
							const hooksPath = join(codexHomeDir, "hooks.json");
							const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
							const metadataPath = join(codexHomeDir, ".omx", "notify-dispatch.json");
							const config = [
								'model = "foreign"',
								"",
								"# ============================================================",
								"# oh-my-codex (OMX) Configuration",
								"# Managed by omx setup - manual edits preserved on next setup",
								"# ============================================================",
								"",
								'[hooks.state."foreign-key"]',
								'trusted_hash = "sha256:foreign"',
								"",
								"# ============================================================",
								"# End oh-my-codex",
								"",
							].join("\n");
							const shim = Buffer.from(
								buildManagedCodexNativeHookWindowsShimContent(packageRoot),
								"utf-8",
							);
							const metadata = Buffer.from('{"managedBy":"foreign"}\n', "utf-8");
							await mkdir(dirname(metadataPath), { recursive: true });
							await writeFile(configPath, config);
							if (fixture.hooks !== null) await writeFile(hooksPath, fixture.hooks);
							await writeFile(shimPath, shim);
							await writeFile(metadataPath, metadata);

							await assert.rejects(
								setup({
									scope: "user",
									installMode: "plugin",
									pluginAgentsMdPrompt: async () => false,
									skipNativeAgentRefresh: true,
									codexFeaturesProbe: () =>
										"hooks stable true\nplugin_hooks experimental true\n",
								}),
								(error: unknown) =>
									typeof error === "object" &&
									error !== null &&
									"code" in error &&
									(error as { code?: unknown }).code === "managed_trust_key_conflict",
							);
							assert.deepEqual(await readFile(configPath), Buffer.from(config, "utf-8"));
							assert.deepEqual(await readFile(shimPath), shim);
							assert.deepEqual(await readFile(metadataPath), metadata);
							if (fixture.hooks === null) {
								assert.equal(existsSync(hooksPath), false);
							} else {
								assert.deepEqual(await readFile(hooksPath), Buffer.from(fixture.hooks, "utf-8"));
							}
							assert.deepEqual(
								(await readdir(codexHomeDir)).filter((entry) => entry.includes(".omx-")),
								[],
							);
							assert.deepEqual(
								(await readdir(wd)).filter((entry) => entry.includes(".omx-")),
								[],
							);
						});
					});
				} finally {
					await rm(wd, { recursive: true, force: true });
				}
			}
		} finally {
			resetPlatform();
		}
	});
	it("treats normalized managed Windows shim identity as exact and every distinct target as ambiguous", () => {
		const shimBasename = "omx-native-hook-windows-shim.ps1";
		const targetShimPath = `C:\\Users\\alice\\.codex\\hooks\\${shimBasename}`;
		const futureCommand = (shimPath: string) =>
			`& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File '${shimPath}'`;
		const futureHooks = (shimPath: string) =>
			JSON.stringify({
				hooks: {
					FutureEvent: [{ hooks: [{ type: "command", command: futureCommand(shimPath) }] }],
				},
			});

		assert.equal(
			decideWindowsNativeHookShimReference(
				futureHooks(`c:/users/alice/.codex/hooks/../hooks/${shimBasename.toUpperCase()}`),
				targetShimPath,
			),
			"referenced",
		);
		assert.equal(
			decideWindowsNativeHookShimReference(
				futureHooks(`D:\\Users\\alice\\.codex\\hooks\\${shimBasename}`),
				targetShimPath,
			),
			"ambiguous",
		);
		assert.equal(
			decideWindowsNativeHookShimReference(
				futureHooks("D:\\Users\\alice\\.codex\\hooks\\unrelated.ps1"),
				targetShimPath,
			),
			"ambiguous",
		);
		assert.equal(
			decideWindowsNativeHookShimReference(
				JSON.stringify({
					hooks: {
						FutureEvent: [{ hooks: [{ type: "command", command: "& $env:OMX_SHIM" }] }],
					},
				}),
				targetShimPath,
			),
			"ambiguous",
		);
		for (const command of [
			"& %OMX_SHIM%",
			"& !OMX_SHIM!",
			"& $(Get-Item env:OMX_SHIM)",
		]) {
			assert.equal(
				decideWindowsNativeHookShimReference(
					JSON.stringify({
						hooks: {
							FutureEvent: [{ hooks: [{ type: "command", command }] }],
						},
					}),
					targetShimPath,
				),
				"ambiguous",
				command,
			);
		}
		for (const command of [
			`Write-Output "don't"; & $env:HOOK_SCRIPT; Write-Output "user's"`,
			"Invoke-Expression '& $env:HOOK_SCRIPT'",
			"cmd /c 'call %HOOK_SCRIPT%'",
			`& ('C:\\Users\\alice\\.codex\\hooks\\omx-native-hook-windows-' + 'shim.ps1')`,
			"& (Get-Content C:\\shim-path.txt)",
		]) {
			assert.equal(
				decideWindowsNativeHookShimReference(
					JSON.stringify({
						hooks: {
							FutureEvent: [{ hooks: [{ type: "command", command }] }],
						},
					}),
					targetShimPath,
				),
				"ambiguous",
				command,
			);
		}
		assert.equal(
			decideWindowsNativeHookShimReference(
				JSON.stringify({
					hooks: {
						FutureEvent: [{
							hooks: [{
								type: "command",
								command:
									"& 'C:\\%OMX_INERT%\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File 'D:\\tools\\unrelated-$env:INERT.ps1'",
							}],
						}],
					},
				}),
				targetShimPath,
			),
			"ambiguous",
		);
		for (const ambiguousPath of [
			`\\Users\\alice\\.codex\\hooks\\${shimBasename}`,
			`C:Users\\alice\\.codex\\hooks\\${shimBasename}`,
			`C:\\\\Users\\alice\\.codex\\hooks\\${shimBasename}`,
			String.raw`\Users\ALICE~1\.codex\hooks\OMX-NA~1.PS1`,
			String.raw`C:Users\ALICE~1\.codex\hooks\OMX-NA~1.PS1`,
			`\\\\?\\C:\\Users\\alice\\.codex\\hooks\\${shimBasename}`,
			`C:\\$env:USERPROFILE\\hooks\\${shimBasename}`,
			`.\\hooks\\${shimBasename}`,
			`D:\\aliases\\${shimBasename}. `,
			`C:\\Users\\ALICE~1\\.codex\\hooks\\OMX-NA~1.PS1`,
		]) {
			assert.equal(
				decideWindowsNativeHookShimReference(futureHooks(ambiguousPath), targetShimPath),
				"ambiguous",
				ambiguousPath,
			);
		}

		const uncTargetShimPath = `\\\\server\\share\\users\\alice\\.codex\\hooks\\${shimBasename}`;
		assert.equal(
			decideWindowsNativeHookShimReference(
				futureHooks(`//SERVER/share/users/alice/.codex/hooks/../hooks/${shimBasename.toUpperCase()}`),
				uncTargetShimPath,
			),
			"referenced",
		);
	});
	it("rolls back when an environment-indirected preserved Windows shim drifts during hooks or config writes", async () => {
		const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
		try {
			for (const mutationKind of ["hooks", "config"] as const) {
				const wd = await mkdtemp(join(tmpdir(), `omx-plugin-preserved-shim-${mutationKind}-`));
				let resetFailureInjector: (() => void) | undefined;
				try {
					await withIsolatedUserHome(wd, async (codexHomeDir) => {
						await withTempCwd(wd, async () => {
							const hooksPath = join(codexHomeDir, "hooks.json");
							const configPath = join(codexHomeDir, "config.toml");
							const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
							const managed = buildManagedCodexHooksConfig(packageRoot, {
								platform: "win32",
								codexHomeDir,
							});
							const hooksBefore = Buffer.from(
								`${JSON.stringify({
									...managed,
									hooks: {
										...managed.hooks,
										FutureEvent: [{
											hooks: [{ type: "command", command: "& $env:OMX_SHIM" }],
										}],
									},
								}, null, 2)}\n`,
								"utf-8",
							);
							const foreignShim = Buffer.from(
								`# concurrent ${mutationKind} shim replacement\n`,
								"utf-8",
							);
							await writeFile(hooksPath, hooksBefore);
							await writeFile(
								shimPath,
								buildManagedCodexNativeHookWindowsShimContent(packageRoot),
							);
							let injected = false;
							resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
								(stage, target) => {
									if (
										stage !== "before_temp_write" ||
										target.kind !== mutationKind ||
										injected
									) {
										return;
									}
									injected = true;
									writeFileSync(shimPath, foreignShim);
								},
							);
							await assert.rejects(
								setup({
									scope: "user",
									installMode: "plugin",
									pluginAgentsMdPrompt: async () => false,
									skipNativeAgentRefresh: true,
									codexFeaturesProbe: () =>
										"hooks stable true\nplugin_hooks experimental true\n",
								}),
								/precondition changed/,
							);
							assert.equal(injected, true, mutationKind);
							assert.deepEqual(await readFile(shimPath), foreignShim);
							assert.deepEqual(await readFile(hooksPath), hooksBefore);
							assert.equal(existsSync(configPath), false);
						});
					});
				} finally {
					resetFailureInjector?.();
					await rm(wd, { recursive: true, force: true });
				}
			}
		} finally {
			resetPlatform();
		}
	});
	it("rolls back when a preserved Windows shim drifts after staged cleanup finalization", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-plugin-preserved-shim-finalization-"));
		const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
		let resetFailureInjector: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const hooksPath = join(codexHomeDir, "hooks.json");
					const configPath = join(codexHomeDir, "config.toml");
					const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
					const managed = buildManagedCodexHooksConfig(packageRoot, {
						platform: "win32",
						codexHomeDir,
					});
					const hooksBefore = Buffer.from(
						`${JSON.stringify({
							...managed,
							hooks: {
								...managed.hooks,
								FutureEvent: [{
									hooks: [{ type: "command", command: "& $env:OMX_SHIM" }],
								}],
							},
						}, null, 2)}\n`,
						"utf-8",
					);
					const foreignShim = Buffer.from("# concurrent finalization shim replacement\n", "utf-8");
					await writeFile(hooksPath, hooksBefore);
					await writeFile(
						shimPath,
						buildManagedCodexNativeHookWindowsShimContent(packageRoot),
					);
					let injected = false;
					resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
						(stage) => {
							if (stage !== "after_staged_cleanup" || injected) return;
							injected = true;
							writeFileSync(shimPath, foreignShim);
						},
					);

					await assert.rejects(
						setup({
							scope: "user",
							installMode: "plugin",
							pluginAgentsMdPrompt: async () => false,
							skipNativeAgentRefresh: true,
							codexFeaturesProbe: () =>
								"hooks stable true\nplugin_hooks experimental true\n",
						}),
						/precondition changed/,
					);
					assert.equal(injected, true);
					assert.deepEqual(await readFile(shimPath), foreignShim);
					assert.deepEqual(await readFile(hooksPath), hooksBefore);
					assert.equal(existsSync(configPath), false);
				});
			});
		} finally {
			resetFailureInjector?.();
			resetPlatform();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("preserves a drive-qualified shim for a drive-less future reference and aborts stale plugin transitions", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-plugin-drive-qualified-future-shim-"));
		const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
		let resetFailureInjector: (() => void) | undefined;
		try {
			await withDriveQualifiedWindowsCodexHome(wd, async (codexHomeDir) => {
				const hooksPath = join(codexHomeDir, "hooks.json");
				const configPath = join(codexHomeDir, "config.toml");
				const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
				const managed = buildManagedCodexHooksConfig(packageRoot, {
					platform: "win32",
					codexHomeDir,
				});
				const driveLessFutureShimPath = "\\Users\\omx\\.codex\\hooks\\omx-native-hook-windows-shim.ps1";
				const futureHooks = `${JSON.stringify({
					...managed,
					hooks: {
						...managed.hooks,
						FutureEvent: [{
							hooks: [{
								type: "command",
								command: `& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File '${driveLessFutureShimPath}'`,
							}],
						}],
					},
				}, null, 2)}\n`;
				const pluginSetup = () => setup({
					scope: "user",
					installMode: "plugin",
					pluginAgentsMdPrompt: async () => false,
					skipNativeAgentRefresh: true,
					codexFeaturesProbe: () =>
						"hooks stable true\nplugin_hooks experimental true\n",
				});
				await writeFile(hooksPath, futureHooks);
				await writeFile(
					shimPath,
					buildManagedCodexNativeHookWindowsShimContent(packageRoot),
				);

				await pluginSetup();
				assert.equal(existsSync(shimPath), true);
				assert.match(await readFile(hooksPath, "utf-8"), /FutureEvent/);

				await writeFile(hooksPath, futureHooks);
				const hooksBefore = await readFile(hooksPath);
				const configBefore = await readFile(configPath);
				const foreignShim = Buffer.from("# concurrent foreign shim\n", "utf-8");
				let injected = false;
				resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
					(stage, target) => {
						if (stage !== "before_precondition" || target.kind !== "shim" || injected) {
							return;
						}
						injected = true;
						writeFileSync(shimPath, foreignShim);
					},
				);
				await assert.rejects(pluginSetup(), /precondition changed/);
				assert.equal(injected, true);
				assert.deepEqual(await readFile(shimPath), foreignShim);
				assert.deepEqual(await readFile(hooksPath), hooksBefore);
				assert.deepEqual(await readFile(configPath), configBefore);
			});
		} finally {
			resetFailureInjector?.();
			resetPlatform();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("preserves a shim referenced by a Unicode-escaped future hook event", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-plugin-future-shim-"));
		const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const hooksPath = join(codexHomeDir, "hooks.json");
					const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
					const managed = buildManagedCodexHooksConfig(packageRoot, {
						platform: "win32",
						codexHomeDir,
					});
					const sentinel = "__OMX_ESCAPED_SHIM_COMMAND__";
					const futureHooks = JSON.stringify(
						{
							...managed,
							hooks: {
								...managed.hooks,
								FutureEvent: [{ hooks: [{ type: "command", command: sentinel }] }],
							},
						},
						null,
						2,
					).replace(
						JSON.stringify(sentinel),
						JSON.stringify(
							`& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File '${shimPath}'`,
						).replace(/\\\\/g, "\\u005c"),
					) + "\n";
					await writeFile(hooksPath, futureHooks);
					await writeFile(
						shimPath,
						buildManagedCodexNativeHookWindowsShimContent(packageRoot),
					);

					await setup({
						scope: "user",
						installMode: "plugin",
						pluginAgentsMdPrompt: async () => false,
						skipNativeAgentRefresh: true,
						codexFeaturesProbe: () =>
							"hooks stable true\nplugin_hooks experimental true\n",
					});
					assert.equal(existsSync(shimPath), true);
					const finalHooks = await readFile(hooksPath, "utf-8");
					assert.match(finalHooks, /FutureEvent/);
					assert.match(finalHooks, /\\u005c/);
					assert.doesNotMatch(finalHooks, /codex-native-hook\.js/);
				});
			});
		} finally {
			resetPlatform();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("preserves a shim referenced through a normalized Windows path alias", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-plugin-shim-path-alias-"));
		const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const hooksPath = join(codexHomeDir, "hooks.json");
					const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
					const shimAlias = shimPath
						.replace(/[\\/]+hooks[\\/]+/i, "\\hooks\\\\.\\")
						.replace(/omx-native-hook-windows-shim\.ps1$/i, "OMX-NATIVE-HOOK-WINDOWS-SHIM.PS1")
						.replace(/\\/g, "/");
					const managed = buildManagedCodexHooksConfig(packageRoot, {
						platform: "win32",
						codexHomeDir,
					});
					await writeFile(
						hooksPath,
						JSON.stringify({
							...managed,
							hooks: {
								...managed.hooks,
								FutureEvent: [{
									hooks: [{
										type: "command",
										command: `& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File '${shimAlias}'`,
									}],
								}],
							},
						}, null, 2) + "\n",
					);
					await writeFile(
						shimPath,
						buildManagedCodexNativeHookWindowsShimContent(packageRoot),
					);

					await setup({
						scope: "user",
						installMode: "plugin",
						pluginAgentsMdPrompt: async () => false,
						skipNativeAgentRefresh: true,
						codexFeaturesProbe: () =>
							"hooks stable true\nplugin_hooks experimental true\n",
					});
					assert.equal(existsSync(shimPath), true);
					assert.match(await readFile(hooksPath, "utf-8"), /FutureEvent/);
				});
			});
		} finally {
			resetPlatform();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("preserves a shim for a distinct absolute -File target", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-plugin-quoted-inert-shim-"));
		const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const hooksPath = join(codexHomeDir, "hooks.json");
					const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
					const managed = buildManagedCodexHooksConfig(packageRoot, {
						platform: "win32",
						codexHomeDir,
					});
					await writeFile(
						hooksPath,
						JSON.stringify({
							...managed,
							hooks: {
								...managed.hooks,
								FutureEvent: [{
									hooks: [{
										type: "command",
										command:
											"& 'C:\\%OMX_INERT%\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File 'D:\\tools\\unrelated-$env:INERT.ps1'",
									}],
								}],
							},
						}, null, 2) + "\n",
					);
					await writeFile(
						shimPath,
						buildManagedCodexNativeHookWindowsShimContent(packageRoot),
					);

					await setup({
						scope: "user",
						installMode: "plugin",
						pluginAgentsMdPrompt: async () => false,
						skipNativeAgentRefresh: true,
						codexFeaturesProbe: () =>
							"hooks stable true\nplugin_hooks experimental true\n",
					});
					assert.equal(existsSync(shimPath), true);
					assert.match(await readFile(hooksPath, "utf-8"), /FutureEvent/);
				});
			});
		} finally {
			resetPlatform();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("does not retain a shim for inert future-event metadata", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-plugin-future-shim-metadata-"));
		const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const hooksPath = join(codexHomeDir, "hooks.json");
					const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
					const managed = buildManagedCodexHooksConfig(packageRoot, {
						platform: "win32",
						codexHomeDir,
					});
					await writeFile(
						hooksPath,
						JSON.stringify(
							{
								...managed,
								hooks: {
									...managed.hooks,
									FutureEvent: [
										{
											metadata: shimPath,
											hooks: [{ type: "agent", prompt: shimPath }],
										},
									],
								},
							},
							null,
							2,
						) + "\n",
					);
					await writeFile(
						shimPath,
						buildManagedCodexNativeHookWindowsShimContent(packageRoot),
					);

					await setup({
						scope: "user",
						installMode: "plugin",
						pluginAgentsMdPrompt: async () => false,
						skipNativeAgentRefresh: true,
						codexFeaturesProbe: () =>
							"hooks stable true\nplugin_hooks experimental true\n",
					});
					assert.equal(existsSync(shimPath), false);
					assert.match(await readFile(hooksPath, "utf-8"), /FutureEvent/);
				});
			});
		} finally {
			resetPlatform();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("completes Windows native-hook transactions when regular-file fsync reports EPERM", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-windows-fsync-eperm-"));
		const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
		let syncCalls = 0;
		const stderr: string[] = [];
		const originalStderrWrite = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderr.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		const resetSync = setNativeHookTransactionRegularFileSyncForTest(async (platform) => {
			assert.equal(platform, "win32");
			syncCalls += 1;
			throw Object.assign(new Error("EPERM: fsync"), { code: "EPERM" });
		});
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({
						scope: "user",
						installMode: "legacy",
						skipNativeAgentRefresh: true,
					});
					assert.ok(syncCalls > 0);
					assert.equal(existsSync(join(codexHomeDir, "hooks.json")), true);
					assert.equal(existsSync(buildManagedCodexNativeHookWindowsShimPath(codexHomeDir)), true);
					assert.equal(existsSync(join(codexHomeDir, "config.toml")), true);
				});
				assert.equal(
					stderr.filter((line) => line.includes("native-hook setup")).length,
					1,
				);
			});
		} finally {
			process.stderr.write = originalStderrWrite;
			resetSync();
			resetPlatform();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("orders Windows plugin-transition mutations as hooks, shim, then config", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-windows-hook-removal-"));
		const forwardOrder: string[] = [];
		const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
		let resetFailureInjector: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({
						scope: "user",
						installMode: "legacy",
						skipNativeAgentRefresh: true,
					});
					const hooksPath = join(codexHomeDir, "hooks.json");
					const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
					assert.equal(existsSync(hooksPath), true);
					assert.equal(existsSync(shimPath), true);
					resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
						(stage, artifact) => {
							if (stage === "before_temp_write") forwardOrder.push(artifact.kind);
						},
					);
					await setup({
						scope: "user",
						installMode: "plugin",
						skipNativeAgentRefresh: true,
						pluginAgentsMdPrompt: async () => false,
						codexFeaturesProbe: () =>
							[
								"hooks                                   stable             true",
								"plugin_hooks                            experimental       true",
								"",
							].join("\n"),
					});
					assert.deepEqual(forwardOrder, ["hooks", "shim", "config"]);
					assert.equal(existsSync(hooksPath), false);
					assert.equal(existsSync(shimPath), false);
				});
			});
		} finally {
			resetFailureInjector?.();
			resetPlatform();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("rolls back Windows plugin-transition artifacts in exact reverse order", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-windows-hook-rollback-"));
		const forwardOrder: string[] = [];
		const restorationOrder: string[] = [];
		const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
		let resetFailureInjector: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({
						scope: "user",
						installMode: "legacy",
						skipNativeAgentRefresh: true,
					});
					const hooksPath = join(codexHomeDir, "hooks.json");
					const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
					const hooksBefore = await readFile(hooksPath);
					const shimBefore = await readFile(shimPath);
					const configBefore = await readFile(join(codexHomeDir, "config.toml"));
					resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
						(stage, artifact) => {
							if (stage === "before_temp_write") forwardOrder.push(artifact.kind);
							if (stage === "before_readback" && artifact.kind === "config") {
								throw new Error("injected Windows config replacement failure");
							}
							if (stage === "before_rollback_rename") {
								restorationOrder.push(artifact.kind);
							}
						},
					);
					await assert.rejects(
						setup({
							scope: "user",
							installMode: "plugin",
							skipNativeAgentRefresh: true,
							pluginAgentsMdPrompt: async () => false,
							codexFeaturesProbe: () =>
								[
									"hooks                                   stable             true",
									"plugin_hooks                            experimental       true",
									"",
								].join("\n"),
						}),
						/rolled back: injected Windows config replacement failure/,
					);
					assert.deepEqual(forwardOrder, ["hooks", "shim", "config"]);
					assert.deepEqual(restorationOrder, ["config", "shim", "hooks"]);
					assert.deepEqual(await readFile(join(codexHomeDir, "config.toml")), configBefore);
					assert.deepEqual(await readFile(shimPath), shimBefore);
					assert.deepEqual(await readFile(hooksPath), hooksBefore);
				});
			});
		} finally {
			resetFailureInjector?.();
			resetPlatform();
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves foreign native hook enablement when transitioning from plugin fallback", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({
						scope: "user",
						installMode: "plugin",
						codexFeaturesProbe: () =>
							"hooks                                   stable             true\n",
					});
					const hooksPath = join(codexHomeDir, "hooks.json");
					const existingHooks = JSON.parse(await readFile(hooksPath, "utf-8")) as {
						hooks?: Record<string, Array<Record<string, unknown>>>;
					};
					const foreignHookGroup = {
						hooks: [
							{
								type: "command",
								command: "/usr/bin/python3 /tmp/foreign-hook.py",
								timeout: 5,
							},
						],
					};
					const existingRegistrations = existingHooks.hooks ?? {};
					existingHooks.hooks = {
						...existingRegistrations,
						UserPromptSubmit: [
							foreignHookGroup,
							...(existingRegistrations.UserPromptSubmit ?? []),
						],
					};
					await writeFile(
						hooksPath,
						JSON.stringify(existingHooks, null, 2) + "\n",
					);

					await setup({ scope: "user", installMode: "plugin" });

					const finalHooksContent = await readFile(hooksPath, "utf-8");
					const config = await readFile(join(codexHomeDir, "config.toml"), "utf-8");
					assert.match(finalHooksContent, /foreign-hook\.py/);
					assert.doesNotMatch(finalHooksContent, /codex-native-hook\.js/);
					assert.match(config, /^plugin_hooks = true$/m);
					assert.match(config, /^hooks = true$/m);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("keeps native hooks enabled for pre-existing foreign hooks in plugin-scoped setup", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const hooksPath = join(codexHomeDir, "hooks.json");
					const foreignHookGroup = {
						hooks: [
							{
								type: "command",
								command: "/usr/bin/python3 /tmp/foreign-hook.py",
								timeout: 5,
							},
						],
					};
					await writeFile(
						hooksPath,
						JSON.stringify(
							{ hooks: { UserPromptSubmit: [foreignHookGroup] } },
							null,
							2,
						) + "\n",
					);

					await setup({ scope: "user", installMode: "plugin" });

					const finalHooksContent = await readFile(hooksPath, "utf-8");
					assert.match(finalHooksContent, /"UserPromptSubmit"/);
					assert.match(finalHooksContent, /foreign-hook\.py/);
					assert.doesNotMatch(finalHooksContent, /codex-native-hook\.js/);
					const config = await readFile(
						join(codexHomeDir, "config.toml"),
						"utf-8",
					);
					assert.match(config, /^plugin_hooks = true$/m);
					assert.match(
						config,
						/^hooks = true$/m,
						"plugin-scoped setup must keep native hooks enabled for foreign hooks",
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves same-key user hook trust state in plugin-scoped setup", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const hooksPath = join(codexHomeDir, "hooks.json");
					const configPath = join(codexHomeDir, "config.toml");
					await writeFile(
						hooksPath,
						JSON.stringify(
							{
								hooks: {
									PostCompact: [
										{
											hooks: [
												{
													type: "command",
													command: "/usr/bin/python3 /tmp/user-hook.py",
													timeout: 5,
												},
											],
										},
									],
								},
							},
							null,
							2,
						) + "\n",
					);
					await writeFile(
						configPath,
						[
							'model = "gpt-5.6-sol"',
							"",
							`[hooks.state."${hooksPath}:post_compact:0:0"]`,
							'trusted_hash = "sha256:user"',
							"enabled = false",
							"",
						].join("\n"),
					);

					await setup({ scope: "user", installMode: "plugin" });

					const config = await readFile(configPath, "utf-8");
					assert.match(config, /^plugin_hooks = true$/m);
					assert.match(config, /^trusted_hash = "sha256:user"$/m);
					assert.match(config, /^enabled = false$/m);
					assert.equal(
						config
							.split(/\r?\n/)
							.filter(
								(line) =>
									line.trim() ===
									`[hooks.state."${hooksPath}:post_compact:0:0"]`,
							).length,
						1,
						"plugin setup must not duplicate preserved user hook trust state",
					);
					assert.doesNotThrow(() => parseToml(config));
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("honors persisted project-scoped plugin mode on repeat setup", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withTempCwd(wd, async () => {
				await setup({ scope: "project", installMode: "plugin" });

				const persisted = JSON.parse(
					await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
				) as { scope: string; installMode?: string };
				assert.deepEqual(persisted, {
					scope: "project",
					installMode: "plugin",
					mcpMode: "none",
				});

				await setup({ scope: "project" });

				assert.equal(
					existsSync(join(wd, ".codex", "skills", "ask", "SKILL.md")),
					false,
				);
				assert.equal(
					existsSync(join(wd, ".codex", "agents", "planner.toml")),
					true,
				);
				assert.equal(
					existsSync(join(wd, ".codex", "prompts", "executor.md")),
					false,
				);
				assert.equal(existsSync(join(wd, ".codex", "hooks.json")), false);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("lets explicit project legacy setup clear persisted project plugin mode", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withTempCwd(wd, async () => {
				await mkdir(join(wd, ".omx"), { recursive: true });
				await writeFile(
					join(wd, ".omx", "setup-scope.json"),
					JSON.stringify({ scope: "project", installMode: "plugin" }),
				);

				await setup({ scope: "project", installMode: "legacy" });

				const persisted = JSON.parse(
					await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
				) as { scope: string; installMode?: string };
				assert.deepEqual(persisted, { scope: "project", mcpMode: "none" });
				assert.equal(
					existsSync(join(wd, ".codex", "skills", "ask", "SKILL.md")),
					true,
				);
				assert.equal(
					existsSync(join(wd, ".codex", "agents", "planner.toml")),
					true,
				);
				assert.equal(
					existsSync(join(wd, ".codex", "prompts", "executor.md")),
					true,
				);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("lets explicit user legacy setup override persisted user plugin mode", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await mkdir(join(wd, ".omx"), { recursive: true });
					await writeFile(
						join(wd, ".omx", "setup-scope.json"),
						JSON.stringify({ scope: "user", installMode: "plugin" }),
					);

					await setup({ installMode: "legacy" });

					const persisted = JSON.parse(
						await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
					) as { scope: string; installMode?: string };
					assert.deepEqual(persisted, {
						scope: "user",
						installMode: "legacy",
						mcpMode: "none",
					});
					assert.equal(
						existsSync(join(codexHomeDir, "skills", "ask", "SKILL.md")),
						true,
					);
					assert.equal(
						existsSync(join(codexHomeDir, "agents", "planner.toml")),
						true,
					);
					assert.equal(
						existsSync(join(codexHomeDir, "prompts", "executor.md")),
						true,
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("dedupes plugin-mode hook trust state when switching user setup back to legacy", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const configPath = join(codexHomeDir, "config.toml");

					await setup({ scope: "user", installMode: "plugin", force: true });
					const pluginConfig = await readFile(configPath, "utf-8");
					const staleUnfencedPluginConfig = pluginConfig
						.split(/\r?\n/)
						.filter(
							(line) =>
								line.trim() !== "# OMX-owned Codex hook trust state" &&
								line.trim() !==
									"# Trusts only setup-managed codex-native-hook.js wrappers." &&
								line.trim() !== "# End OMX-owned Codex hook trust state",
						)
						.join("\n");
					await writeFile(configPath, staleUnfencedPluginConfig);
					assert.doesNotThrow(() => parseToml(staleUnfencedPluginConfig));

					await setup({ scope: "user", installMode: "legacy", force: true });

					const legacyConfig = await readFile(configPath, "utf-8");
					assert.doesNotThrow(() => parseToml(legacyConfig));
					assert.equal(
						legacyConfig
							.split(/\r?\n/)
							.filter(
								(line) =>
									line.trim() ===
									`[hooks.state."${join(codexHomeDir, "hooks.json")}:post_compact:0:0"]`,
							).length,
						1,
						"legacy setup should replace stale plugin-mode hook trust state instead of duplicating it",
					);
					assert.match(
						legacyConfig,
						/# OMX-owned Codex hook trust state[\s\S]*# End OMX-owned Codex hook trust state/,
					);
					const persisted = JSON.parse(
						await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
					) as { scope: string; installMode?: string };
					assert.deepEqual(persisted, {
						scope: "user",
						installMode: "legacy",
						mcpMode: "none",
					});
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("uses project-scoped plugin hooks when plugin mode is explicitly requested", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withTempCwd(wd, async () => {
				await setup({ scope: "project", installMode: "plugin" });

				await assertProjectPluginModeArtifacts(wd);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("honors persisted project plugin mode on repeat setup", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withTempCwd(wd, async () => {
				await setup({ scope: "project", installMode: "plugin" });
				await setup();

				await assertProjectPluginModeArtifacts(wd);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("prints plugin-mode next steps without legacy-only claims", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async () => {
				await withTempCwd(wd, async () => {
					const pluginOutput = await captureConsoleOutput(async () => {
						await setup({ scope: "project", installMode: "plugin" });
					});
					assert.match(pluginOutput, /Using setup install mode: plugin/);
					assert.match(
						pluginOutput,
						/Plugin-scoped Codex hooks and runtime feature flags refresh complete .*plugin_hooks, goals/,
					);
					assert.doesNotMatch(pluginOutput, /user-scope skill delivery mode/);
					assert.doesNotMatch(
						pluginOutput,
						/use explicit agent_type when spawning OMX roles/,
					);
					assert.doesNotMatch(
						pluginOutput,
						/Use role\/workflow keywords like \$architect, \$executor, and \$plan/,
					);
					assert.doesNotMatch(
						pluginOutput,
						/AGENTS keyword routing can also activate them implicitly/,
					);
					assert.doesNotMatch(
						pluginOutput,
						/The AGENTS\.md orchestration brain is loaded automatically/,
					);
					assert.match(
						pluginOutput,
						/Registered Codex marketplace oh-my-codex-local supplies OMX skills and workflow surfaces/,
					);
					assert.match(
						pluginOutput,
						/Browse plugin-provided skills with \/skills/,
					);
					assert.match(
						pluginOutput,
						/Plugin-mode AGENTS\.md defaults provide persistent orchestration guidance; developer_instructions is an optional bootstrap/,
					);

					const legacyWd = join(wd, "legacy");
					await mkdir(legacyWd, { recursive: true });
					await withTempCwd(legacyWd, async () => {
						const legacyOutput = await captureConsoleOutput(async () => {
							await setup({ scope: "user", installMode: "legacy" });
						});
						assert.match(
							legacyOutput,
							/Native agent role TOML files written to \.codex\/agents\//,
						);
						assert.match(
							legacyOutput,
							/Use role\/workflow keywords like \$architect, \$executor, and \$plan/,
						);
						assert.match(
							legacyOutput,
							/AGENTS keyword routing can also activate them implicitly/,
						);
						assert.match(
							legacyOutput,
							/The AGENTS\.md orchestration brain is loaded automatically/,
						);
					});
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("removes legacy user components when plugin mode is selected", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({ scope: "user", installMode: "legacy" });

					const askSkillPath = join(
						codexHomeDir,
						"skills",
						"ask",
						"SKILL.md",
					);
					const promptPath = join(codexHomeDir, "prompts", "executor.md");
					const agentPath = join(codexHomeDir, "agents", "planner.toml");
					const hooksPath = join(codexHomeDir, "hooks.json");
					const configPath = join(codexHomeDir, "config.toml");
					const agentsMdPath = join(codexHomeDir, "AGENTS.md");
					assert.equal(existsSync(askSkillPath), true);
					assert.equal(existsSync(promptPath), true);
					assert.equal(existsSync(agentPath), true);
					assert.equal(existsSync(hooksPath), true);
					assert.equal(existsSync(configPath), true);
					assert.equal(existsSync(agentsMdPath), true);

					await setup({ scope: "user", installMode: "plugin" });

					assert.equal(existsSync(askSkillPath), false);
					assert.equal(existsSync(promptPath), false);
					assert.equal(existsSync(agentPath), true);
					assert.equal(existsSync(hooksPath), false);
					assert.equal(existsSync(agentsMdPath), true);
					const config = await readFile(configPath, "utf-8");
					assert.match(config, /^plugin_hooks = true$/m);
					assert.doesNotMatch(
						config,
						/^\s*(?:notify)\s*=|^\s*\[mcp_servers[.\]]/m,
					);
					assert.match(config, /^developer_instructions\s*=/m);
					assert.match(config, /You have oh-my-codex installed\. AGENTS\.md/);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves existing AGENTS.md when plugin AGENTS defaults are declined", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({ scope: "user", installMode: "legacy" });

					const agentsMdPath = join(codexHomeDir, "AGENTS.md");
					const before = await readFile(agentsMdPath, "utf-8");
					assert.match(before, /<!-- omx:generated:agents-md -->/);

					await setup({
						scope: "user",
						installMode: "plugin",
						pluginAgentsMdPrompt: async () => false,
					});

					assert.equal(await readFile(agentsMdPath, "utf-8"), before);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("repairs existing AGENTS.md during non-interactive plugin force setup", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await mkdir(codexHomeDir, { recursive: true });
					const agentsMdPath = join(codexHomeDir, "AGENTS.md");
					await writeFile(agentsMdPath, "# local instructions\n");

					await setup({ scope: "user", installMode: "plugin", force: true });

					const after = await readFile(agentsMdPath, "utf-8");
					assert.match(after, /<!-- omx:generated:agents-md -->/);
					assert.match(after, /oh-my-codex - Intelligent Multi-Agent Orchestration/);
					const backupRoot = join(wd, "home", ".omx", "backups", "setup");
					const backupRuns = await readdir(backupRoot);
					assert.equal(
						backupRuns.some((entry) =>
							existsSync(join(backupRoot, entry, ".codex", "AGENTS.md")),
						),
						true,
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("archives stale legacy prompts and preserves modified native agents when plugin mode refreshes", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({ scope: "user", installMode: "legacy" });

					const promptPath = join(codexHomeDir, "prompts", "executor.md");
					const agentPath = join(codexHomeDir, "agents", "planner.toml");
					await writeFile(
						promptPath,
						"---\ndescription: stale legacy executor prompt\n---\n\nold executor body\n",
					);
					const staleAgentToml = [
						"# oh-my-codex agent: planner",
						'name = "planner"',
						'description = "stale legacy generated planner"',
						'developer_instructions = """old planner body"""',
						"",
					].join("\n");
					await writeFile(agentPath, staleAgentToml);

					const output = await captureConsoleOutput(async () => {
						await setup({ scope: "user", installMode: "plugin" });
					});

					assert.equal(existsSync(promptPath), false);
					assert.equal(existsSync(agentPath), true);
					assert.equal(await readFile(agentPath, "utf-8"), staleAgentToml);
					assert.match(
						output,
						/Archived and removed .* legacy OMX-managed prompt file/,
					);
					assert.match(
						output,
						/Native agent role refresh complete/,
					);

					const backupRoot = join(wd, "home", ".omx", "backups", "setup");
					const backupRuns = await readdir(backupRoot);
					assert.ok(backupRuns.length > 0);
					assert.equal(
						backupRuns.some((entry) =>
							existsSync(
								join(backupRoot, entry, ".codex", "prompts", "executor.md"),
							),
						),
						true,
					);
					assert.equal(
						backupRuns.some((entry) =>
							existsSync(
								join(backupRoot, entry, ".codex", "agents", "planner.toml"),
							),
						),
						false,
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves unmanaged native agent TOMLs with obsolete skill_ref during plugin refresh", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({ scope: "user", installMode: "legacy" });

					const customAgentPath = join(
						codexHomeDir,
						"agents",
						"custom-reviewer.toml",
					);
					const generatedAgentPath = join(
						codexHomeDir,
						"agents",
						"ghost.toml",
					);
					const customAgentToml = [
						'name = "custom-reviewer"',
						'description = "user-managed reviewer"',
						'skill_ref = "custom-reviewer"',
						"",
					].join("\n");
					await writeFile(customAgentPath, customAgentToml);
					await writeFile(
						generatedAgentPath,
						[
							"# oh-my-codex agent: ghost",
							'name = "ghost"',
							'description = "obsolete generated reviewer"',
							'skill_ref = "ghost"',
							"",
						].join("\n"),
					);

					await setup({ scope: "user", installMode: "plugin" });

					assert.equal(await readFile(customAgentPath, "utf-8"), customAgentToml);
					assert.equal(existsSync(generatedAgentPath), false);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("counts plugin cleanup skill directory backups in the setup summary", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({ scope: "user", installMode: "legacy" });
					await seedPluginCacheFromInstalledSkills(codexHomeDir);

					const output = await captureConsoleOutput(async () => {
						await setup({ scope: "user", installMode: "plugin" });
					});

					const skillsSummary = output.match(
						/skills: updated=0, unchanged=0, backed_up=(\d+), skipped=0, removed=(\d+)/,
					);
					assert.notEqual(skillsSummary, null);
					const backedUp = Number(skillsSummary?.[1]);
					const removed = Number(skillsSummary?.[2]);
					assert.ok(backedUp > 0);
					assert.equal(backedUp, removed);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("removes matching legacy user skills even when plugin readiness is proven", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({ scope: "user", installMode: "legacy" });
					await seedPluginCacheFromInstalledSkills(codexHomeDir);

					const askSkillDir = join(codexHomeDir, "skills", "ask");
					const wikiSkillDir = join(codexHomeDir, "skills", "wiki");
					assert.equal(existsSync(askSkillDir), true);
					assert.equal(existsSync(wikiSkillDir), true);

					const outputLines: string[] = [];
					const previousLog = console.log;
					console.log = (...args: unknown[]) => {
						outputLines.push(args.join(" "));
					};
					try {
						await setup({ scope: "user", installMode: "plugin" });
					} finally {
						console.log = previousLog;
					}

					const setupOutput = outputLines.join("\n");
					assert.equal(existsSync(askSkillDir), false);
					assert.equal(existsSync(wikiSkillDir), false);
					assert.match(
						setupOutput,
						/skills: updated=0, unchanged=0, backed_up=\d+, skipped=0, removed=\d+/,
					);

					const backupSetupRoot = join(wd, "home", ".omx", "backups", "setup");
					const backupTimestamps = await readdir(backupSetupRoot);
					assert.equal(backupTimestamps.length, 1);
					const backupSkillsDir = join(
						backupSetupRoot,
						backupTimestamps[0],
						".codex",
						"skills",
					);
					const backedUpSkillNames = await readdir(backupSkillsDir);
					assert.ok(backedUpSkillNames.includes("ask"));
					assert.ok(backedUpSkillNames.includes("wiki"));
					assert.match(
						setupOutput,
						new RegExp(
							`skills: updated=0, unchanged=0, backed_up=${backedUpSkillNames.length}, skipped=0, removed=${backedUpSkillNames.length}`,
						),
					);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves customized legacy user skills during plugin cleanup", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({ scope: "user", installMode: "legacy" });
					await seedPluginCacheFromInstalledSkills(codexHomeDir);

					const askSkillPath = join(
						codexHomeDir,
						"skills",
						"ask",
						"SKILL.md",
					);
					const wikiSkillDir = join(codexHomeDir, "skills", "wiki");
					await writeFile(askSkillPath, "# customized ask\n");

					await setup({ scope: "user", installMode: "plugin" });

					assert.equal(
						await readFile(askSkillPath, "utf-8"),
						"# customized ask\n",
					);
					assert.equal(existsSync(wikiSkillDir), false);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("fails plugin hook-removal preflight before creating unrelated setup artifacts", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-preflight-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const hooksPath = join(codexHomeDir, "hooks.json");
					const configPath = join(codexHomeDir, "config.toml");
					const hooksContent = JSON.stringify(
						{
							hooks: {
								SessionStart: [
									{
										matcher: "startup|resume|clear",
										hooks: [
											{
												type: "command",
												command: 'node "/repo/dist/scripts/codex-native-hook.js"',
											},
										],
									},
									{ hooks: [{ type: "command", command: "echo foreign" }] },
								],
							},
						},
						null,
						2,
					) + "\n";
					const configContent = 'model = "foreign-config"\n';
					await writeFile(hooksPath, hooksContent);
					await writeFile(configPath, configContent);

					await assert.rejects(
						() =>
							setup({
								scope: "user",
								installMode: "plugin",
								mergeAgents: true,
								codexFeaturesProbe: () =>
									"hooks                                   stable             true\nplugin_hooks                            experimental       true\n",
							}),
						(error: unknown) => {
							assert.equal(
								(error as { code?: unknown }).code,
								"unsafe_managed_removal",
							);
							return true;
						},
					);
					assert.equal(await readFile(hooksPath, "utf-8"), hooksContent);
					assert.equal(await readFile(configPath, "utf-8"), configContent);
					assert.equal(existsSync(join(wd, ".omx")), false);
					assert.equal(existsSync(join(codexHomeDir, "prompts")), false);
					assert.equal(existsSync(join(codexHomeDir, "agents")), false);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("rejects symlinked Codex transaction ancestors without writing foreign storage", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-symlinked-codex-home-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const foreignCodexHome = join(wd, "foreign-codex-home");
					await mkdir(foreignCodexHome);
					await writeFile(join(foreignCodexHome, "sentinel.txt"), "foreign\n");
					await rm(codexHomeDir, { recursive: true, force: true });
					await symlink(foreignCodexHome, codexHomeDir);

					await assert.rejects(
						setup({
							scope: "user",
							installMode: "legacy",
							skipNativeAgentRefresh: true,
						}),
						/ancestor .*symbolic link/,
					);
					assert.deepEqual(await readdir(foreignCodexHome), ["sentinel.txt"]);
					assert.equal(existsSync(join(wd, ".omx")), false);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("rejects a symlinked native artifact parent before touching its target", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-symlinked-native-parent-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const foreignMetadataDir = join(wd, "foreign-native-metadata");
					await mkdir(foreignMetadataDir);
					await writeFile(join(foreignMetadataDir, "sentinel.txt"), "foreign\n");
					await symlink(foreignMetadataDir, join(codexHomeDir, ".omx"));

					await assert.rejects(
						setup({
							scope: "user",
							installMode: "legacy",
							skipNativeAgentRefresh: true,
						}),
						/ancestor .*symbolic link/,
					);
					assert.deepEqual(await readdir(foreignMetadataDir), ["sentinel.txt"]);
					assert.equal(existsSync(join(codexHomeDir, "config.toml")), false);
					assert.equal(existsSync(join(codexHomeDir, "hooks.json")), false);
					assert.equal(existsSync(join(wd, ".omx")), false);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("revalidates native artifact parent topology immediately before mutation", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-stale-native-parent-"));
		let resetFailureInjector: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const metadataParent = join(codexHomeDir, ".omx");
					let injected = false;
					resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
						(stage) => {
							if (stage !== "before_precondition" || injected) return;
							injected = true;
							writeFileSync(metadataParent, "foreign\n");
						},
					);

					await assert.rejects(
						setup({
							scope: "user",
							installMode: "legacy",
							skipNativeAgentRefresh: true,
						}),
						/ancestor .*not a directory/,
					);
					assert.equal(injected, true);
					assert.equal(await readFile(metadataParent, "utf-8"), "foreign\n");
					assert.equal(existsSync(join(codexHomeDir, "config.toml")), false);
					assert.equal(existsSync(join(codexHomeDir, "hooks.json")), false);
				});
			});
		} finally {
			resetFailureInjector?.();
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("rejects a modified Windows hook shim during setup preflight", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-windows-shim-"));
		const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
					const modifiedShim = "# modified by user\n";
					await writeFile(shimPath, modifiedShim);

					await assert.rejects(
						() =>
							setup({
								scope: "user",
								installMode: "legacy",
								mergeAgents: true,
							}),
						/modified Windows native hook shim/,
					);
					assert.equal(await readFile(shimPath, "utf-8"), modifiedShim);
					assert.equal(existsSync(join(codexHomeDir, "hooks.json")), false);
					assert.equal(existsSync(join(codexHomeDir, "config.toml")), false);
					assert.equal(existsSync(join(wd, ".omx")), false);
				});
			});
		} finally {
			resetPlatform();
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("writes hooks, notification metadata, then config/trust and rolls all writes back when config replacement fails", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-hook-transaction-"));
		const writeOrder: string[] = [];
		const resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
			(stage, artifact) => {
				if (stage !== "before_temp_write") return;
				writeOrder.push(artifact.kind);
				if (artifact.kind === "config") {
					throw new Error("injected config replacement failure");
				}
			},
		);
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await writeFile(
						join(codexHomeDir, "config.toml"),
						'notify = ["node", "/tmp/user-notify.js"]\n',
					);
					await assert.rejects(
						() =>
							setup({
								scope: "user",
								installMode: "legacy",
								mergeAgents: true,
								skipNativeAgentRefresh: true,
							}),
						/rolled back: injected config replacement failure/,
					);
					assert.deepEqual(writeOrder, ["hooks", "metadata", "config"]);
					assert.equal(existsSync(join(codexHomeDir, "hooks.json")), false);
					assert.equal(
						await readFile(join(codexHomeDir, "config.toml"), "utf-8"),
						'notify = ["node", "/tmp/user-notify.js"]\n',
					);
					assert.equal(
						existsSync(join(codexHomeDir, ".omx", "notify-dispatch.json")),
						false,
					);
				});
			});
		} finally {
			resetFailureInjector();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("writes the Windows shim, hooks, notification metadata, then config/trust and rolls all writes back", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-windows-hook-transaction-"));
		const writeOrder: string[] = [];
		const resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
			(stage, artifact) => {
				if (stage !== "before_temp_write") return;
				writeOrder.push(artifact.kind);
				if (artifact.kind === "config") {
					throw new Error("injected Windows config replacement failure");
				}
			},
		);
		const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await writeFile(
						join(codexHomeDir, "config.toml"),
						'notify = ["node", "/tmp/user-notify.js"]\n',
					);
					const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
					await assert.rejects(
						() =>
							setup({
								scope: "user",
								installMode: "legacy",
								mergeAgents: true,
								skipNativeAgentRefresh: true,
							}),
						/rolled back: injected Windows config replacement failure/,
					);
					assert.deepEqual(writeOrder, ["shim", "hooks", "metadata", "config"]);
					assert.equal(existsSync(shimPath), false);
					assert.equal(existsSync(join(codexHomeDir, "hooks.json")), false);
					assert.equal(
						await readFile(join(codexHomeDir, "config.toml"), "utf-8"),
						'notify = ["node", "/tmp/user-notify.js"]\n',
					);
					assert.equal(
						existsSync(join(codexHomeDir, ".omx", "notify-dispatch.json")),
						false,
					);
				});
			});
		} finally {
			resetFailureInjector();
			resetPlatform();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("aborts stale native snapshots before setup can write unrelated artifacts", async () => {
		const originalConfig = Buffer.from('model = "before"\n', "utf-8");
		const originalHooks = Buffer.from('{"hooks": {}}\n', "utf-8");
		const foreignHooks = Buffer.from('{"hooks": {"Stop": []}}\n', "utf-8");
		const foreignConfig = Buffer.from('model = "foreign"\n', "utf-8");
		const fixtures = [
			{
				name: "hooks creation",
				seedHooks: null,
				mutate: (hooksPath: string, _configPath: string) =>
					writeFileSync(hooksPath, foreignHooks),
				expectedHooks: foreignHooks,
				expectedConfig: originalConfig,
			},
			{
				name: "config modification",
				seedHooks: originalHooks,
				mutate: (_hooksPath: string, configPath: string) =>
					writeFileSync(configPath, foreignConfig),
				expectedHooks: originalHooks,
				expectedConfig: foreignConfig,
			},
			{
				name: "hooks deletion",
				seedHooks: originalHooks,
				mutate: (hooksPath: string, _configPath: string) => rmSync(hooksPath),
				expectedHooks: null,
				expectedConfig: originalConfig,
			},
			{
				name: "config deletion",
				seedHooks: originalHooks,
				mutate: (_hooksPath: string, configPath: string) => rmSync(configPath),
				expectedHooks: originalHooks,
				expectedConfig: null,
			},
		] as const;
		for (const fixture of fixtures) {
			const wd = await mkdtemp(join(tmpdir(), "omx-setup-stale-native-"));
			let resetFailureInjector: (() => void) | undefined;
			try {
				await withIsolatedUserHome(wd, async (codexHomeDir) => {
					await withTempCwd(wd, async () => {
						const hooksPath = join(codexHomeDir, "hooks.json");
						const configPath = join(codexHomeDir, "config.toml");
						await writeFile(configPath, originalConfig);
						if (fixture.seedHooks) await writeFile(hooksPath, fixture.seedHooks);

						let injected = false;
						resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
							(stage) => {
								if (stage !== "before_precondition" || injected) return;
								injected = true;
								fixture.mutate(hooksPath, configPath);
							},
						);
						await assert.rejects(
							setup({
								scope: "user",
								installMode: "legacy",
								skipNativeAgentRefresh: true,
								codexFeaturesProbe: () => null,
								codexVersionProbe: () => null,
							}),
							/precondition changed/,
						);
						assert.equal(injected, true, fixture.name);
						if (fixture.expectedConfig === null) {
							assert.equal(existsSync(configPath), false);
						} else {
							assert.deepEqual(await readFile(configPath), fixture.expectedConfig);
						}
						if (fixture.expectedHooks === null) {
							assert.equal(existsSync(hooksPath), false);
						} else {
							assert.deepEqual(await readFile(hooksPath), fixture.expectedHooks);
						}
						assert.equal(existsSync(join(wd, ".omx")), false);
						assert.equal(existsSync(join(codexHomeDir, "agents")), false);
					});
				});
			} finally {
				resetFailureInjector?.();
				await rm(wd, { recursive: true, force: true });
			}
		}
	});
	it("aborts when notification metadata changes after planning", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-stale-notify-metadata-"));
		let resetFailureInjector: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const configPath = join(codexHomeDir, "config.toml");
					const hooksPath = join(codexHomeDir, "hooks.json");
					const metadataPath = join(
						codexHomeDir,
						".omx",
						"notify-dispatch.json",
					);
					const configBefore = 'notify = ["node", "/tmp/user-notify.js"]\n';
					const foreignMetadata = Buffer.from('{"managedBy":"foreign"}\n', "utf-8");
					await writeFile(configPath, configBefore);
					await mkdir(dirname(metadataPath), { recursive: true });
					let injected = false;
					resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
						(stage, target) => {
							if (
								stage !== "before_precondition" ||
								target.kind !== "metadata" ||
								injected
							) {
								return;
							}
							injected = true;
							writeFileSync(metadataPath, foreignMetadata);
						},
					);
					await assert.rejects(
						setup({
							scope: "user",
							installMode: "legacy",
							skipNativeAgentRefresh: true,
							codexFeaturesProbe: () => null,
							codexVersionProbe: () => null,
						}),
						/precondition changed/,
					);
					assert.equal(injected, true);
					assert.deepEqual(await readFile(metadataPath), foreignMetadata);
					assert.equal(await readFile(configPath, "utf-8"), configBefore);
					assert.equal(existsSync(hooksPath), false);
				});
			});
		} finally {
			resetFailureInjector?.();
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("aborts when the Windows shim changes after planning", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-stale-windows-shim-"));
		const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
		let resetFailureInjector: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({
						scope: "user",
						installMode: "legacy",
						skipNativeAgentRefresh: true,
						codexFeaturesProbe: () => null,
						codexVersionProbe: () => null,
					});
					const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
					const hooksPath = join(codexHomeDir, "hooks.json");
					const configPath = join(codexHomeDir, "config.toml");
					const configBefore = await readFile(configPath);
					await writeFile(hooksPath, '{"hooks": {}}\n');
					const hooksBefore = await readFile(hooksPath);
					const foreignShim = Buffer.from("# foreign shim\n", "utf-8");
					let injected = false;
					resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
						(stage, target) => {
							if (
								stage === "before_precondition" &&
								target.kind === "shim" &&
								!injected
							) {
								injected = true;
								writeFileSync(shimPath, foreignShim);
							}
						},
					);
					await assert.rejects(
						setup({
							scope: "user",
							installMode: "legacy",
							skipNativeAgentRefresh: true,
							codexFeaturesProbe: () => null,
							codexVersionProbe: () => null,
						}),
						/precondition changed/,
					);
					assert.equal(injected, true);
					assert.deepEqual(await readFile(shimPath), foreignShim);
					assert.deepEqual(await readFile(hooksPath), hooksBefore);
					assert.deepEqual(await readFile(configPath), configBefore);
				});
			});
		} finally {
			resetFailureInjector?.();
			resetPlatform();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("never deletes plugin hooks from a stale snapshot", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-plugin-stale-hooks-"));
		let resetFailureInjector: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({ scope: "user", installMode: "legacy", skipNativeAgentRefresh: true });
					const hooksPath = join(codexHomeDir, "hooks.json");
					const configPath = join(codexHomeDir, "config.toml");
					const configBefore = await readFile(configPath);
					const foreignHooks = Buffer.from('{"hooks": {"Stop": []}}\n', "utf-8");
					let injected = false;
					resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
						(stage) => {
							if (stage !== "before_precondition" || injected) return;
							injected = true;
							writeFileSync(hooksPath, foreignHooks);
						},
					);
					await assert.rejects(
						setup({
							scope: "user",
							installMode: "plugin",
							pluginAgentsMdPrompt: async () => false,
							skipNativeAgentRefresh: true,
						}),
						/precondition changed/,
					);
					assert.equal(injected, true);
					assert.deepEqual(await readFile(hooksPath), foreignHooks);
					assert.deepEqual(await readFile(configPath), configBefore);
				});
			});
		} finally {
			resetFailureInjector?.();
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("never rolls back a concurrent foreign hook replacement", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-stale-rollback-"));
		let resetFailureInjector: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const hooksPath = join(codexHomeDir, "hooks.json");
					const configPath = join(codexHomeDir, "config.toml");
					const hooksBefore = Buffer.from('{"hooks": {}}\n', "utf-8");
					const configBefore = Buffer.from('model = "before"\n', "utf-8");
					const foreignHooks = Buffer.from('{"hooks": {"Stop": []}}\n', "utf-8");
					await writeFile(hooksPath, hooksBefore);
					await writeFile(configPath, configBefore);
					resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
						(stage, target) => {
							if (stage !== "before_temp_write" || target.kind !== "config") return;
							writeFileSync(hooksPath, foreignHooks);
							throw new Error("injected config replacement failure after foreign hook write");
						},
					);
					await assert.rejects(
						setup({
							scope: "user",
							installMode: "legacy",
							skipNativeAgentRefresh: true,
							codexFeaturesProbe: () => null,
							codexVersionProbe: () => null,
						}),
						/rollback failed/,
					);
					assert.deepEqual(await readFile(hooksPath), foreignHooks);
					assert.deepEqual(await readFile(configPath), configBefore);
				});
			});
		} finally {
			resetFailureInjector?.();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("preserves pre-existing native bytes and modes across injected transaction failures", async () => {
		const failures = [
			{ stage: "before_backup", kind: "shim" },
			{ stage: "before_temp_write", kind: "shim" },
			{ stage: "before_rename", kind: "hooks" },
			{ stage: "before_temp_write", kind: "metadata" },
			{ stage: "before_readback", kind: "config" },
		] as const;
		for (const failure of failures) {
			const wd = await mkdtemp(join(tmpdir(), "omx-setup-transaction-rollback-"));
			const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
			let resetFailureInjector: (() => void) | undefined;
			try {
				await withIsolatedUserHome(wd, async (codexHomeDir) => {
					await withTempCwd(wd, async () => {
						const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
						const hooksPath = join(codexHomeDir, "hooks.json");
						const configPath = join(codexHomeDir, "config.toml");
						const shimBefore = Buffer.from(
							buildManagedCodexNativeHookWindowsShimContent("", {
								nodePath: "C:\\Historical Node\\node.exe",
								hookScriptPath:
									"C:\\Historical Install\\oh-my-codex\\dist\\scripts\\codex-native-hook.js",
							}),
							"utf-8",
						);
						const hooksBefore = Buffer.from('{"hooks": {}}\n', "utf-8");
						const configBefore = Buffer.from(
							'model = "before"\nnotify = ["node", "/tmp/user-notify.js"]\n',
							"utf-8",
						);
						await mkdir(dirname(shimPath), { recursive: true });
						await writeFile(shimPath, shimBefore);
						await writeFile(hooksPath, hooksBefore);
						await writeFile(configPath, configBefore);
						await Promise.all([
							chmod(shimPath, 0o640),
							chmod(hooksPath, 0o640),
							chmod(configPath, 0o640),
						]);

						resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
							(stage, target) => {
								if (stage === failure.stage && target.kind === failure.kind) {
									throw new Error(`injected ${failure.stage} ${failure.kind} failure`);
								}
							},
						);
						await assert.rejects(
							setup({
								scope: "user",
								installMode: "legacy",
								skipNativeAgentRefresh: true,
								codexFeaturesProbe: () => null,
								codexVersionProbe: () => null,
							}),
							/injected .* failure/,
						);
						assert.deepEqual(await readFile(shimPath), shimBefore, failure.stage);
						assert.deepEqual(await readFile(hooksPath), hooksBefore, failure.stage);
						assert.deepEqual(await readFile(configPath), configBefore, failure.stage);
						assert.equal(
							existsSync(join(codexHomeDir, ".omx", "notify-dispatch.json")),
							false,
							failure.stage,
						);
						for (const path of [shimPath, hooksPath, configPath]) {
							assert.equal((await stat(path)).mode & 0o777, 0o640, path);
						}
					});
				});
			} finally {
				resetFailureInjector?.();
				resetPlatform();
				await rm(wd, { recursive: true, force: true });
			}
		}
	});
	it("fails closed when a managed dispatcher metadata snapshot is not valid UTF-8", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-invalid-notify-metadata-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const configPath = join(codexHomeDir, "config.toml");
					const metadataPath = join(
						codexHomeDir,
						".omx",
						"notify-dispatch.json",
					);
					const dispatcherPath = join(
						packageRoot,
						"dist",
						"scripts",
						"notify-dispatcher.js",
					);
					const configBefore = `notify = ${JSON.stringify([
						"node",
						dispatcherPath,
						"--metadata",
						metadataPath,
					])}\n`;
					await mkdir(dirname(metadataPath), { recursive: true });
					await writeFile(configPath, configBefore);
					await writeFile(metadataPath, Buffer.from([0xff]));

					await assert.rejects(
						setup({ scope: "user", installMode: "legacy", skipNativeAgentRefresh: true }),
						/notification metadata .*invalid UTF-8/,
					);
					assert.equal(await readFile(configPath, "utf-8"), configBefore);
					assert.deepEqual(await readFile(metadataPath), Buffer.from([0xff]));
					assert.equal(existsSync(join(codexHomeDir, "hooks.json")), false);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("keeps consulted unchanged notification metadata in the native transaction preconditions", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-notify-precondition-"));
		let resetFailureInjector: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const configPath = join(codexHomeDir, "config.toml");
					const hooksPath = join(codexHomeDir, "hooks.json");
					const metadataPath = join(
						codexHomeDir,
						".omx",
						"notify-dispatch.json",
					);
					await writeFile(
						configPath,
						'notify = ["node", "/tmp/user-notify.js"]\n',
					);
					await setup({
						scope: "user",
						installMode: "legacy",
						skipNativeAgentRefresh: true,
					});
					const configBefore = await readFile(configPath);
					const hooksBefore = await readFile(hooksPath);
					const foreignMetadata = Buffer.from('{"managedBy":"foreign"}\n', "utf-8");
					let injected = false;
					resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
						(stage, target) => {
							if (
								stage === "before_precondition" &&
								target.kind === "metadata" &&
								!injected
							) {
								injected = true;
								writeFileSync(metadataPath, foreignMetadata);
							}
						},
					);
					await assert.rejects(
						setup({
							scope: "user",
							installMode: "legacy",
							skipNativeAgentRefresh: true,
						}),
						/precondition changed/,
					);
					assert.equal(injected, true);
					assert.deepEqual(await readFile(metadataPath), foreignMetadata);
					assert.deepEqual(await readFile(configPath), configBefore);
					assert.deepEqual(await readFile(hooksPath), hooksBefore);
				});
			});
		} finally {
			resetFailureInjector?.();
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("rejects config decisions whose MCP-removal callback changed the planned config snapshot", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-stale-config-decision-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const configPath = join(codexHomeDir, "config.toml");
					const configBefore = '[mcp_servers.omx_state]\ncommand = "node"\n';
					const foreignConfig = 'model = "foreign"\n';
					await writeFile(configPath, configBefore);

					await assert.rejects(
						setup({
							scope: "user",
							installMode: "legacy",
							skipNativeAgentRefresh: true,
							firstPartyMcpRemovalPrompt: async () => {
								await writeFile(configPath, foreignConfig);
								return false;
							},
						}),
						/precondition changed/,
					);
					assert.equal(await readFile(configPath, "utf-8"), foreignConfig);
					assert.equal(existsSync(join(codexHomeDir, "hooks.json")), false);
					assert.equal(existsSync(join(codexHomeDir, ".omx")), false);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("fails closed for pre-existing native transaction write temporaries", async () => {
		const fixtures = ["regular file", "symlink"] as const;
		for (const fixture of fixtures) {
			const wd = await mkdtemp(join(tmpdir(), "omx-setup-temp-collision-"));
			let resetTemporaryPath: (() => void) | undefined;
			try {
				await withIsolatedUserHome(wd, async (codexHomeDir) => {
					await withTempCwd(wd, async () => {
						const configPath = join(codexHomeDir, "config.toml");
						const hooksPath = join(codexHomeDir, "hooks.json");
						const collisionPath = join(codexHomeDir, ".hooks-write-collision");
						const configBefore = 'model = "before"\n';
						await writeFile(configPath, configBefore);
						if (fixture === "regular file") {
							await writeFile(collisionPath, "collision\n");
						} else {
							const targetPath = join(wd, "collision-target");
							await writeFile(targetPath, "collision\n");
							await symlink(targetPath, collisionPath);
						}
						resetTemporaryPath = setNativeHookTransactionTemporaryPathForTest(
							(path, purpose) =>
								path === hooksPath && purpose === "write"
									? collisionPath
									: join(dirname(path), `.${purpose}-unused`),
						);

						await assert.rejects(
							setup({
								scope: "user",
								installMode: "legacy",
								skipNativeAgentRefresh: true,
							}),
							/EEXIST/,
						);
						assert.equal(await readFile(collisionPath, "utf-8"), "collision\n");
						assert.equal(await readFile(configPath, "utf-8"), configBefore);
						assert.equal(existsSync(hooksPath), false);
					});
				});
			} finally {
				resetTemporaryPath?.();
				await rm(wd, { recursive: true, force: true });
			}
		}
	});

	it("fails closed when a non-throwing injector replaces an owned write temporary", async () => {
		const fixtures = ["regular file", "symlink"] as const;
		for (const fixture of fixtures) {
			const wd = await mkdtemp(join(tmpdir(), "omx-setup-write-temp-replacement-"));
			let resetFailureInjector: (() => void) | undefined;
			let resetTemporaryPath: (() => void) | undefined;
			try {
				await withIsolatedUserHome(wd, async (codexHomeDir) => {
					await withTempCwd(wd, async () => {
						const configPath = join(codexHomeDir, "config.toml");
						const hooksPath = join(codexHomeDir, "hooks.json");
						const temporaryPath = join(codexHomeDir, ".hooks-write-owned");
						const foreignTargetPath = join(wd, "foreign-write-temporary-target");
						const configBefore = Buffer.from('model = "before"\n', "utf-8");
						const foreignContents = `foreign ${fixture} write temporary\n`;
						await writeFile(configPath, configBefore);
						if (fixture === "symlink") {
							await writeFile(foreignTargetPath, foreignContents);
						}
						resetTemporaryPath = setNativeHookTransactionTemporaryPathForTest(
							(path, purpose) =>
								path === hooksPath && purpose === "write"
									? temporaryPath
									: join(dirname(path), `.${basename(path)}.${purpose}-fallback`),
						);
						let injected = false;
						resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
							(stage, target) => {
								if (stage !== "before_rename" || target.kind !== "hooks") return;
								injected = true;
								rmSync(temporaryPath);
								if (fixture === "regular file") {
									writeFileSync(temporaryPath, foreignContents);
								} else {
									symlinkSync(foreignTargetPath, temporaryPath);
								}
							},
						);

						await assert.rejects(
							setup({
								scope: "user",
								installMode: "legacy",
								skipNativeAgentRefresh: true,
							}),
							/temporary.*manual recovery/,
						);
						assert.equal(injected, true);
						const replacementStatus = await lstat(temporaryPath);
						if (fixture === "regular file") {
							assert.equal(replacementStatus.isFile(), true);
							assert.equal(await readFile(temporaryPath, "utf-8"), foreignContents);
						} else {
							assert.equal(replacementStatus.isSymbolicLink(), true);
							assert.equal(await readFile(foreignTargetPath, "utf-8"), foreignContents);
						}
						assert.equal(existsSync(hooksPath), false);
						assert.deepEqual(await readFile(configPath), configBefore);
					});
				});
			} finally {
				resetFailureInjector?.();
				resetTemporaryPath?.();
				await rm(wd, { recursive: true, force: true });
			}
		}
	});

	it("fails closed when a non-throwing injector replaces an owned staged deletion", async () => {
		const fixtures = ["regular file", "symlink"] as const;
		for (const fixture of fixtures) {
			const wd = await mkdtemp(join(tmpdir(), "omx-setup-staged-delete-replacement-"));
			const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
			let resetFailureInjector: (() => void) | undefined;
			let resetTemporaryPath: (() => void) | undefined;
			try {
				await withIsolatedUserHome(wd, async (codexHomeDir) => {
					await withTempCwd(wd, async () => {
						await setup({
							scope: "user",
							installMode: "legacy",
							skipNativeAgentRefresh: true,
						});
						const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
						const hooksPath = join(codexHomeDir, "hooks.json");
						const configPath = join(codexHomeDir, "config.toml");
						const stagedDeletionPath = join(codexHomeDir, ".hooks-delete-owned");
						const foreignTargetPath = join(wd, "foreign-staged-deletion-target");
						const shimBefore = await readFile(shimPath);
						const hooksBefore = await readFile(hooksPath);
						const configBefore = await readFile(configPath);
						const foreignContents = `foreign ${fixture} staged deletion\n`;
						if (fixture === "symlink") {
							await writeFile(foreignTargetPath, foreignContents);
						}
						resetTemporaryPath = setNativeHookTransactionTemporaryPathForTest(
							(path, purpose) =>
								path === hooksPath && purpose === "delete"
									? stagedDeletionPath
									: join(dirname(path), `.${basename(path)}.${purpose}-fallback`),
						);
						let injected = false;
						resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
							(stage, target) => {
								if (stage !== "before_remove" || target.kind !== "hooks") return;
								injected = true;
								rmSync(stagedDeletionPath);
								if (fixture === "regular file") {
									writeFileSync(stagedDeletionPath, foreignContents);
								} else {
									symlinkSync(foreignTargetPath, stagedDeletionPath);
								}
							},
						);

						await assert.rejects(
							setup({
								scope: "user",
								installMode: "plugin",
								pluginAgentsMdPrompt: async () => false,
								skipNativeAgentRefresh: true,
							}),
							/staged deletion.*manual recovery/,
						);
						assert.equal(injected, true);
						const replacementStatus = await lstat(stagedDeletionPath);
						if (fixture === "regular file") {
							assert.equal(replacementStatus.isFile(), true);
							assert.equal(await readFile(stagedDeletionPath, "utf-8"), foreignContents);
						} else {
							assert.equal(replacementStatus.isSymbolicLink(), true);
							assert.equal(await readFile(foreignTargetPath, "utf-8"), foreignContents);
						}
						assert.deepEqual(await readFile(shimPath), shimBefore);
						assert.deepEqual(await readFile(hooksPath), hooksBefore);
						assert.deepEqual(await readFile(configPath), configBefore);
					});
				});
			} finally {
				resetFailureInjector?.();
				resetTemporaryPath?.();
				resetPlatform();
				await rm(wd, { recursive: true, force: true });
			}
		}
	});

	it("rolls back a renamed native hook when post-rename verification fails", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-post-rename-rollback-"));
		const resetPlatform = setNativeHookTransactionPlatformForTest("linux");
		let resetFailureInjector: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const hooksPath = join(codexHomeDir, "hooks.json");
					const configPath = join(codexHomeDir, "config.toml");
					const hooksBefore = Buffer.from('{"hooks": {}}\n', "utf-8");
					const configBefore = Buffer.from('model = "before"\n', "utf-8");
					await writeFile(hooksPath, hooksBefore);
					await writeFile(configPath, configBefore);
					await Promise.all([chmod(hooksPath, 0o640), chmod(configPath, 0o640)]);
					resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
						(stage, target) => {
							if (stage === "after_rename" && target.kind === "hooks") {
								throw new Error("injected post-rename verification failure");
							}
						},
					);

					await assert.rejects(
						setup({
							scope: "user",
							installMode: "legacy",
							skipNativeAgentRefresh: true,
							codexFeaturesProbe: () => null,
							codexVersionProbe: () => null,
						}),
						/rolled back: injected post-rename verification failure/,
					);
					assert.deepEqual(await readFile(hooksPath), hooksBefore);
					assert.deepEqual(await readFile(configPath), configBefore);
					assert.equal((await stat(hooksPath)).mode & 0o777, 0o640);
					assert.equal((await stat(configPath)).mode & 0o777, 0o640);
				});
			});
		} finally {
			resetFailureInjector?.();
			resetPlatform();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("preserves a concurrent replacement after staged source removal for manual recovery", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-post-remove-manual-recovery-"));
		const resetPlatform = setNativeHookTransactionPlatformForTest("linux");
		let resetFailureInjector: (() => void) | undefined;
		let resetTemporaryPath: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({
						scope: "user",
						installMode: "legacy",
						skipNativeAgentRefresh: true,
					});
					const hooksPath = join(codexHomeDir, "hooks.json");
					const configPath = join(codexHomeDir, "config.toml");
					const stagedDeletionPath = join(codexHomeDir, ".hooks-delete-post-remove");
					const hooksBefore = await readFile(hooksPath);
					const configBefore = await readFile(configPath);
					const foreignHooks = Buffer.from('{"hooks":{"Stop":[]}}\n', "utf-8");
					resetTemporaryPath = setNativeHookTransactionTemporaryPathForTest(
						(path, purpose) =>
							path === hooksPath && purpose === "delete"
								? stagedDeletionPath
								: join(dirname(path), `.${basename(path)}.${purpose}-fallback`),
					);
					resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
						(stage, target) => {
							if (stage === "after_remove" && target.kind === "hooks") {
								writeFileSync(hooksPath, foreignHooks);
								throw new Error("injected post-remove verification failure");
							}
						},
					);

					await assert.rejects(
						setup({
							scope: "user",
							installMode: "plugin",
							skipNativeAgentRefresh: true,
							pluginAgentsMdPrompt: async () => false,
							codexFeaturesProbe: () =>
								[
									"hooks                                   stable             true",
									"plugin_hooks                            experimental       true",
									"",
								].join("\n"),
						}),
						(error: unknown) => {
							const message = error instanceof Error ? error.message : String(error);
							assert.match(message, /manual recovery/);
							assert.ok(message.includes(hooksPath));
							return true;
						},
					);
					assert.deepEqual(await readFile(hooksPath), foreignHooks);
					assert.deepEqual(await readFile(configPath), configBefore);
					assert.deepEqual(await readFile(stagedDeletionPath), hooksBefore);
				});
			});
		} finally {
			resetFailureInjector?.();
			resetTemporaryPath?.();
			resetPlatform();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("never removes a concurrent replacement while rolling back a newly created artifact", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-rollback-remove-"));
		let resetFailureInjector: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const hooksPath = join(codexHomeDir, "hooks.json");
					const configPath = join(codexHomeDir, "config.toml");
					const configBefore = Buffer.from(
						'notify = ["node", "/tmp/user-notify.js"]\n',
						"utf-8",
					);
					const foreignHooks = Buffer.from('{"hooks":{"Stop":[]}}\n', "utf-8");
					await writeFile(configPath, configBefore);
					resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
						(stage, target) => {
							if (stage === "before_temp_write" && target.kind === "config") {
								throw new Error("injected config failure");
							}
							if (stage === "before_rollback_remove" && target.kind === "hooks") {
								writeFileSync(hooksPath, foreignHooks);
							}
						},
					);
					await assert.rejects(
						setup({
							scope: "user",
							installMode: "legacy",
							skipNativeAgentRefresh: true,
						}),
						/rollback failed/,
					);
					assert.deepEqual(await readFile(hooksPath), foreignHooks);
					assert.deepEqual(await readFile(configPath), configBefore);
				});
			});
		} finally {
			resetFailureInjector?.();
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("does not roll back when the second staged-deletion copy drifts after the first cleanup", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-staged-deletion-cleanup-"));
		const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
		let resetFailureInjector: (() => void) | undefined;
		let resetTemporaryPath: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({
						scope: "user",
						installMode: "legacy",
						skipNativeAgentRefresh: true,
					});
					const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
					const hooksPath = join(codexHomeDir, "hooks.json");
					const configPath = join(codexHomeDir, "config.toml");
					const stagedDeletionPath = (path: string, purpose: "write" | "delete") =>
						join(dirname(path), `.${basename(path)}.cleanup-${purpose}`);
					const foreignStagedCopy = Buffer.from("foreign second staged deletion\n", "utf-8");
					let cleanupCount = 0;
					let driftedStagedPath: string | undefined;
					resetTemporaryPath = setNativeHookTransactionTemporaryPathForTest(
						stagedDeletionPath,
					);
					resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
						(stage, target) => {
							if (
								stage !== "before_staged_cleanup" ||
								(target.kind !== "shim" && target.kind !== "hooks")
							) {
								return;
							}
							cleanupCount += 1;
							if (cleanupCount === 2) {
								driftedStagedPath = stagedDeletionPath(target.path, "delete");
								writeFileSync(driftedStagedPath, foreignStagedCopy);
							}
						},
					);
					await assert.rejects(
						setup({
							scope: "user",
							installMode: "plugin",
							skipNativeAgentRefresh: true,
							pluginAgentsMdPrompt: async () => false,
						}),
						/committed but staged deletion cleanup failed/,
					);
					assert.equal(cleanupCount, 2);
					assert.ok(driftedStagedPath);
					assert.deepEqual(await readFile(driftedStagedPath), foreignStagedCopy);
					assert.equal(existsSync(shimPath), false);
					assert.equal(existsSync(hooksPath), false);
					assert.match(await readFile(configPath, "utf-8"), /^plugin_hooks = true$/m);
				});
			});
		} finally {
			resetFailureInjector?.();
			resetTemporaryPath?.();
			resetPlatform();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("treats applied hook, shim, and config snapshots as CAS through commit finalization", async () => {
		const fixtures = [
			{
				name: "later commit",
				stage: "before_temp_write",
				target: "shim",
				drift: "hooks",
				committed: false,
			},
			{
				name: "staged cleanup",
				stage: "before_staged_cleanup",
				target: "hooks",
				drift: "shim",
				committed: false,
			},
			{
				name: "finalization",
				stage: "after_staged_cleanup",
				target: "config",
				drift: "config",
				committed: true,
			},
		] as const;
		for (const fixture of fixtures) {
			const wd = await mkdtemp(join(tmpdir(), `omx-setup-applied-${fixture.name}-`));
			const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
			let resetFailureInjector: (() => void) | undefined;
			try {
				await withIsolatedUserHome(wd, async (codexHomeDir) => {
					await withTempCwd(wd, async () => {
						await setup({
							scope: "user",
							installMode: "legacy",
							skipNativeAgentRefresh: true,
						});
						const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
						const hooksPath = join(codexHomeDir, "hooks.json");
						const configPath = join(codexHomeDir, "config.toml");
						const before = {
							shim: await readFile(shimPath),
							hooks: await readFile(hooksPath),
							config: await readFile(configPath),
						};
						const paths = { shim: shimPath, hooks: hooksPath, config: configPath };
						const foreign = Buffer.from(`foreign applied ${fixture.drift} ${fixture.name}\n`, "utf-8");
						let injected = false;
						resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
							(stage, target) => {
								if (
									stage !== fixture.stage ||
									target.kind !== fixture.target ||
									injected
								) {
									return;
								}
								injected = true;
								writeFileSync(paths[fixture.drift], foreign);
							},
						);
						await assert.rejects(
							setup({
								scope: "user",
								installMode: "plugin",
								pluginAgentsMdPrompt: async () => false,
								skipNativeAgentRefresh: true,
							}),
							fixture.committed
								? /committed but staged deletion cleanup failed during finalization/
								: /rollback failed/,
						);
						assert.equal(injected, true, fixture.name);
						if (fixture.name === "staged cleanup") {
							assert.equal(existsSync(hooksPath), false);
							assert.deepEqual(await readFile(shimPath), foreign);
							assert.notDeepEqual(await readFile(configPath), before.config);
							return;
						}
						if (fixture.committed) {
							assert.equal(existsSync(hooksPath), false);
							assert.equal(existsSync(shimPath), false);
							assert.deepEqual(await readFile(configPath), foreign);
							return;
						}
						assert.deepEqual(
							await readFile(hooksPath),
							fixture.drift === "hooks" ? foreign : before.hooks,
						);
						assert.deepEqual(
							await readFile(shimPath),
							before.shim,
						);
						assert.deepEqual(await readFile(configPath), before.config);
					});
				});
			} finally {
				resetFailureInjector?.();
				resetPlatform();
				await rm(wd, { recursive: true, force: true });
			}
		}
	});
	it("preserves a same-byte foreign replacement made immediately after a native-hook rename", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-immediate-post-rename-"));
		let resetFailureInjector: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const hooksPath = join(codexHomeDir, "hooks.json");
					const configPath = join(codexHomeDir, "config.toml");
					const configBefore = Buffer.from('model = "before"\n', "utf-8");
					let replacement: Buffer | undefined;
					let replacedInode: number | undefined;
					await writeFile(configPath, configBefore);
					resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
						(stage, target) => {
							if (stage !== "after_rename" || target.kind !== "hooks") return;
							replacement = readFileSync(hooksPath);
							const ownedInode = lstatSync(hooksPath).ino;
							const foreignPath = join(codexHomeDir, ".foreign-hooks-same-byte");
							writeFileSync(foreignPath, replacement);
							assert.notEqual(lstatSync(foreignPath).ino, ownedInode);
							rmSync(hooksPath);
							renameSync(foreignPath, hooksPath);
							replacedInode = lstatSync(hooksPath).ino;
							assert.notEqual(replacedInode, ownedInode);
						},
					);
					await assert.rejects(
						setup({
							scope: "user",
							installMode: "legacy",
							skipNativeAgentRefresh: true,
							codexFeaturesProbe: () => null,
							codexVersionProbe: () => null,
						}),
						/rollback failed/,
					);
					assert.ok(replacement);
					assert.ok(replacedInode);
					assert.deepEqual(await readFile(hooksPath), replacement);
					assert.deepEqual(await readFile(configPath), configBefore);
				});
			});
		} finally {
			resetFailureInjector?.();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("preflights every staged native-hook recovery copy before rollback", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-rollback-recovery-preflight-"));
		const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
		let resetFailureInjector: (() => void) | undefined;
		let resetTemporaryPath: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({ scope: "user", installMode: "legacy", skipNativeAgentRefresh: true });
					const hooksPath = join(codexHomeDir, "hooks.json");
					const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
					const configPath = join(codexHomeDir, "config.toml");
					const configBefore = await readFile(configPath);
					const stagedHooksPath = join(codexHomeDir, ".hooks-preflight-recovery");
					resetTemporaryPath = setNativeHookTransactionTemporaryPathForTest(
						(path, purpose) =>
							path === hooksPath && purpose === "delete"
								? stagedHooksPath
								: join(dirname(path), `.${basename(path)}.${purpose}-preflight`),
					);
					resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
						(stage, target) => {
							if (stage !== "before_readback" || target.kind !== "config") return;
							rmSync(stagedHooksPath);
							throw new Error("injected missing staged recovery copy");
						},
					);
					await assert.rejects(
						setup({
							scope: "user",
							installMode: "plugin",
							pluginAgentsMdPrompt: async () => false,
							skipNativeAgentRefresh: true,
							codexFeaturesProbe: () => "hooks stable true\nplugin_hooks experimental true\n",
						}),
						/rollback failed.*recovery preflight/,
					);
					assert.equal(existsSync(hooksPath), false);
					assert.equal(existsSync(shimPath), false);
					assert.notDeepEqual(await readFile(configPath), configBefore);
					assert.equal(existsSync(stagedHooksPath), false);
				});
			});
		} finally {
			resetFailureInjector?.();
			resetTemporaryPath?.();
			resetPlatform();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("stops later native-hook rollback restores when the first restored artifact drifts", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-rollback-restored-drift-"));
		const resetPlatform = setNativeHookTransactionPlatformForTest("win32");
		let resetFailureInjector: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({ scope: "user", installMode: "legacy", skipNativeAgentRefresh: true });
					const hooksPath = join(codexHomeDir, "hooks.json");
					const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
					const configPath = join(codexHomeDir, "config.toml");
					const configBefore = await readFile(configPath);
					let injectedFailure = false;
					let drifted = false;
					resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
						(stage, target) => {
							if (stage === "before_readback" && target.kind === "config" && !injectedFailure) {
								injectedFailure = true;
								throw new Error("injected rollback start failure");
							}
							if (stage === "before_rollback_rename" && target.kind === "shim" && !drifted) {
								const restoredInode = lstatSync(configPath).ino;
								const foreignPath = join(codexHomeDir, ".foreign-restored-config");
								writeFileSync(foreignPath, configBefore);
								assert.notEqual(lstatSync(foreignPath).ino, restoredInode);
								rmSync(configPath);
								renameSync(foreignPath, configPath);
								drifted = lstatSync(configPath).ino !== restoredInode;
							}
						},
					);
					await assert.rejects(
						setup({
							scope: "user",
							installMode: "plugin",
							pluginAgentsMdPrompt: async () => false,
							skipNativeAgentRefresh: true,
							codexFeaturesProbe: () => "hooks stable true\nplugin_hooks experimental true\n",
						}),
						/rollback failed/,
					);
					assert.equal(injectedFailure, true);
					assert.equal(drifted, true);
					assert.deepEqual(await readFile(configPath), configBefore);
					assert.equal(existsSync(shimPath), false);
					assert.equal(existsSync(hooksPath), false);
				});
			});
		} finally {
			resetFailureInjector?.();
			resetPlatform();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("preserves a foreign inode injected after final setup rename validation", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-final-rename-claim-"));
		let resetFailureInjector: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const hooksPath = join(codexHomeDir, "hooks.json");
					const configPath = join(codexHomeDir, "config.toml");
					const configBefore = Buffer.from('model = "before"\n', "utf-8");
					const foreignHooks = Buffer.from('{"hooks":{"Stop":[]}}\n', "utf-8");
					await writeFile(configPath, configBefore);
					await writeFile(hooksPath, '{"hooks": {}}\n');
					let foreignInode: number | undefined;
					resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
						(stage, target) => {
							if (stage !== "after_final_rename_validation" || target.kind !== "hooks") return;
							const foreignPath = join(codexHomeDir, ".foreign-final-rename-hooks");
							writeFileSync(foreignPath, foreignHooks);
							foreignInode = lstatSync(foreignPath).ino;
							rmSync(hooksPath);
							renameSync(foreignPath, hooksPath);
						},
					);
					await assert.rejects(
						setup({ scope: "user", installMode: "legacy", skipNativeAgentRefresh: true }),
						/precondition changed/,
					);
					assert.ok(foreignInode);
					assert.equal(lstatSync(hooksPath).ino, foreignInode);
					assert.deepEqual(await readFile(hooksPath), foreignHooks);
					assert.deepEqual(await readFile(configPath), configBefore);
				});
			});
		} finally {
			resetFailureInjector?.();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("preserves a foreign inode injected after final setup removal validation", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-final-remove-claim-"));
		let resetFailureInjector: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					await setup({ scope: "user", installMode: "legacy", skipNativeAgentRefresh: true });
					const hooksPath = join(codexHomeDir, "hooks.json");
					const configPath = join(codexHomeDir, "config.toml");
					const configBefore = await readFile(configPath);
					const foreignHooks = Buffer.from('{"hooks":{"Stop":[]}}\n', "utf-8");
					let foreignInode: number | undefined;
					resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
						(stage, target) => {
							if (stage !== "after_final_remove_validation" || target.kind !== "hooks") return;
							const foreignPath = join(codexHomeDir, ".foreign-final-remove-hooks");
							writeFileSync(foreignPath, foreignHooks);
							foreignInode = lstatSync(foreignPath).ino;
							rmSync(hooksPath);
							renameSync(foreignPath, hooksPath);
						},
					);
					await assert.rejects(
						setup({
							scope: "user",
							installMode: "plugin",
							pluginAgentsMdPrompt: async () => false,
							skipNativeAgentRefresh: true,
						}),
						/precondition changed/,
					);
					assert.ok(foreignInode);
					assert.equal(lstatSync(hooksPath).ino, foreignInode);
					assert.deepEqual(await readFile(hooksPath), foreignHooks);
					assert.deepEqual(await readFile(configPath), configBefore);
				});
			});
		} finally {
			resetFailureInjector?.();
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("preserves a foreign inode injected after final setup rollback validation", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-final-restore-claim-"));
		let resetFailureInjector: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const hooksPath = join(codexHomeDir, "hooks.json");
					const configPath = join(codexHomeDir, "config.toml");
					const configBefore = Buffer.from('model = "before"\n', "utf-8");
					const foreignHooks = Buffer.from('{"hooks":{"Stop":[]}}\n', "utf-8");
					await writeFile(configPath, configBefore);
					let foreignInode: number | undefined;
					resetFailureInjector = setNativeHookTransactionFailureInjectorForTest(
						(stage, target) => {
							if (stage === "before_temp_write" && target.kind === "config") {
								throw new Error("injected rollback start");
							}
							if (stage !== "after_final_restore_validation" || target.kind !== "hooks") return;
							const foreignPath = join(codexHomeDir, ".foreign-final-restore-hooks");
							writeFileSync(foreignPath, foreignHooks);
							foreignInode = lstatSync(foreignPath).ino;
							rmSync(hooksPath);
							renameSync(foreignPath, hooksPath);
						},
					);
					await assert.rejects(
						setup({ scope: "user", installMode: "legacy", skipNativeAgentRefresh: true }),
						/rollback failed/,
					);
					assert.ok(foreignInode);
					assert.equal(lstatSync(hooksPath).ino, foreignInode);
					assert.deepEqual(await readFile(hooksPath), foreignHooks);
					assert.deepEqual(await readFile(configPath), configBefore);
				});
			});
		} finally {
			resetFailureInjector?.();
			await rm(wd, { recursive: true, force: true });
		}
	});
});

describe("late setup failure transaction boundary", () => {
	it("does not commit config or hooks when a later setup phase fails", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-late-failure-"));
		let resetLateFailure: (() => void) | undefined;
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				await withTempCwd(wd, async () => {
					const hooksPath = join(codexHomeDir, "hooks.json");
					const configPath = join(codexHomeDir, "config.toml");
					const hooksBefore = Buffer.from('{"hooks":{"FutureEvent":[{"hooks":[{"type":"prompt","prompt":"keep"}]}]}}\n');
					const configBefore = Buffer.from('[features]\nhooks = true\n');
					await mkdir(codexHomeDir, { recursive: true });
					await writeFile(hooksPath, hooksBefore);
					await writeFile(configPath, configBefore);
					resetLateFailure = setSetupLatePhaseFailureInjectorForTest(() => {
						throw new Error("injected late setup phase failure");
					});
					await assert.rejects(
						setup({
							scope: "user",
							installMode: "legacy",
							skipNativeAgentRefresh: true,
							codexFeaturesProbe: () => null,
							codexVersionProbe: () => null,
						}),
						/injected late setup phase failure/,
					);
					assert.deepEqual(await readFile(hooksPath), hooksBefore);
					assert.deepEqual(await readFile(configPath), configBefore);
				});
			});
		} finally {
			resetLateFailure?.();
			await rm(wd, { recursive: true, force: true });
		}
	});
});

describe("persisted merge policy lifecycle", () => {
	it("preserves matching policy through review and lets explicit sets override reset or a scope change", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-merge-policy-lifecycle-"));
		try {
			await withIsolatedUserHome(wd, async () => {
				await withTempCwd(wd, async () => {
					await mkdir(join(wd, ".omx"), { recursive: true });
					const statePath = join(wd, ".omx", "setup-scope.json");
					await writeFile(statePath, JSON.stringify({ scope: "user", installMode: "legacy", mergeAgents: true }));

					await setup({ persistedSetupReviewPrompt: async () => "review", setupScopePrompt: async () => "user", installModePrompt: async () => "legacy" });
					assert.equal((JSON.parse(await readFile(statePath, "utf-8")) as { mergeAgents?: boolean }).mergeAgents, true);

					await setup({ persistedSetupReviewPrompt: async () => "reset", scope: "user", mergeAgents: false });
					assert.equal((JSON.parse(await readFile(statePath, "utf-8")) as { mergeAgents?: boolean }).mergeAgents, false);

					await setup({ persistedSetupReviewPrompt: async () => "review", scope: "project", installMode: "legacy", mergeAgents: true });
					const changedScope = JSON.parse(await readFile(statePath, "utf-8")) as { scope: string; mergeAgents?: boolean };
					assert.equal(changedScope.scope, "project");
					assert.equal(changedScope.mergeAgents, true);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("removes an explicit policy when clear succeeds", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-merge-policy-clear-"));
		try {
			await withIsolatedUserHome(wd, async () => {
				await withTempCwd(wd, async () => {
					await mkdir(join(wd, ".omx"), { recursive: true });
					const statePath = join(wd, ".omx", "setup-scope.json");
					await writeFile(statePath, JSON.stringify({ scope: "project", mergeAgents: true }));

					await setup({
						scope: "project",
						installMode: "legacy",
						mergeAgentsPolicy: { kind: "clear" },
					});

					assert.equal(Object.hasOwn(JSON.parse(await readFile(statePath, "utf-8")), "mergeAgents"), false);
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("covers persisted and explicit merge policy precedence across force", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-setup-merge-policy-force-"));
		try {
			await withIsolatedUserHome(wd, async () => {
				await withTempCwd(wd, async () => {
					const statePath = join(wd, ".omx", "setup-scope.json");
					const agentsPath = join(wd, "AGENTS.md");
					const rows = [
						{ name: "persisted true + force", stored: true, policy: undefined, keepsCustom: true, persisted: true, refresh: "--merge-agents" },
						{ name: "persisted false + force", stored: false, policy: undefined, keepsCustom: false, persisted: false, refresh: "--no-merge-agents" },
						{ name: "absent + force", stored: undefined, policy: undefined, keepsCustom: false, persisted: undefined, refresh: undefined },
						{ name: "force + explicit true", stored: false, policy: { kind: "set", value: true } as const, keepsCustom: true, persisted: true, refresh: "--merge-agents" },
						{ name: "force + explicit false", stored: true, policy: { kind: "set", value: false } as const, keepsCustom: false, persisted: false, refresh: "--no-merge-agents" },
						{ name: "force + explicit clear", stored: true, policy: { kind: "clear" } as const, keepsCustom: false, persisted: undefined, refresh: undefined },
					];

					for (const row of rows) {
						await rm(join(wd, ".omx"), { recursive: true, force: true });
						await rm(join(wd, ".codex"), { recursive: true, force: true });
						await mkdir(join(wd, ".omx"), { recursive: true });
						await writeFile(
							statePath,
							JSON.stringify({ scope: "project", ...(row.stored === undefined ? {} : { mergeAgents: row.stored }) }),
						);
						await writeFile(agentsPath, `# custom ${row.name}\n`);

						await setup({
							scope: "project",
							installMode: "legacy",
							force: true,
							mergeAgentsPolicy: row.policy,
						});

						const agents = await readFile(agentsPath, "utf-8");
						assert.equal(agents.includes(`# custom ${row.name}`), row.keepsCustom, row.name);
						const persisted = JSON.parse(await readFile(statePath, "utf-8")) as { force?: boolean; mergeAgents?: boolean };
						assert.equal(persisted.mergeAgents, row.persisted, row.name);
						assert.equal(Object.hasOwn(persisted, "force"), false, row.name);
						const refreshArgs = resolveSetupRefreshArgs(wd);
						assert.equal(refreshArgs.includes("--force"), false, row.name);
						if (row.refresh) assert.equal(refreshArgs.includes(row.refresh), true, row.name);
						else assert.equal(refreshArgs.some((arg) => arg === "--merge-agents" || arg === "--no-merge-agents"), false, row.name);
					}
				});
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
});
