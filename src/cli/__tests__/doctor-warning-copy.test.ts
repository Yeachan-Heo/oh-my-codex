import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	cp,
	link,
	mkdir,
	mkdtemp,
	realpath,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	withPackagedExploreHarnessHidden,
	withPackagedExploreHarnessLock,
} from "./packaged-explore-harness-lock.js";
import {
	buildPostCompactSmokeSpawnInvocation,
	checkExternalCodexProcessGuards,
	checkExploreHarness,
	checkLegacyMultiAgentCompatibility,
	checkNativeHookDistSmoke,
	checkNativePostCompactHookRuntime,
	checkNativeHooks,
	classifyPostCompactHookStdout,
	doctor,
	setDoctorClaimJournalDurabilityForTest,
} from "../doctor.js";
import {
	createNativeHookClaimJournalDurability,
	persistNativeHookClaimJournal,
} from "../native-hook-claim-journal.js";
import { syncRegularFile } from "../../utils/file-durability.js";
import {
	buildManagedCodexNativeHookCommand,
	buildManagedCodexNativeHookWindowsShimContent,
} from "../../config/codex-hooks.js";

const MANAGED_HOOK_EVENTS = [
	"SessionStart",
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"PreCompact",
	"PostCompact",
	"Stop",
] as const;

function runOmx(
	cwd: string,
	argv: string[],
	envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error?: string } {
	const testDir = dirname(fileURLToPath(import.meta.url));
	const repoRoot = join(testDir, "..", "..", "..");
	const omxBin = join(repoRoot, "dist", "cli", "omx.js");
	const mergedEnv = { ...process.env, ...envOverrides };
	if (
		typeof envOverrides.HOME === "string" &&
		typeof envOverrides.USERPROFILE !== "string"
	) {
		mergedEnv.USERPROFILE = envOverrides.HOME;
	}
	const r = spawnSync(process.execPath, [omxBin, ...argv], {
		cwd,
		encoding: "utf-8",
		env: mergedEnv,
	});
	return {
		status: r.status,
		stdout: r.stdout || "",
		stderr: r.stderr || "",
		error: r.error?.message,
	};
}

function shouldSkipForSpawnPermissions(err?: string): boolean {
	return typeof err === "string" && /(EPERM|EACCES)/i.test(err);
}

function quoteCommandPart(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function repoRoot(): string {
	const testDir = dirname(fileURLToPath(import.meta.url));
	return join(testDir, "..", "..", "..");
}

function currentNativeHookCommand(codexHomeDir: string): string {
	return buildManagedCodexNativeHookCommand(repoRoot(), {
		codexHomeDir,
	});
}

function buildWindowsShimCommand(shimPath: string): string {
	return `& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File '${shimPath.replace(/'/g, "''")}'`;
}

function buildWindowsShimHooksJson(shimPath: string, codexHomeDir: string): string {
	const command = buildWindowsShimCommand(shimPath);
	return buildHooksJsonWithPostCompactCommand(command, codexHomeDir, command);
}

async function installPluginCacheFixture(codexDir: string): Promise<string> {
	const root = repoRoot();
	const sourcePluginDir = join(root, "plugins", "oh-my-codex");
	const manifest = JSON.parse(
		await readFile(join(sourcePluginDir, ".codex-plugin", "plugin.json"), "utf-8"),
	) as { version: string };
	const cacheDir = join(
		codexDir,
		"plugins",
		"cache",
		"oh-my-codex-local",
		"oh-my-codex",
		manifest.version,
	);
	await rm(cacheDir, { recursive: true, force: true });
	await mkdir(dirname(cacheDir), { recursive: true });
	await cp(sourcePluginDir, cacheDir, { recursive: true });
	await writeFile(
		join(cacheDir, "hooks", "omx-command.json"),
		`${JSON.stringify(
			{
				command: process.execPath,
				argsPrefix: [join(root, "dist", "cli", "omx.js")],
			},
			null,
			2,
		)}\n`,
	);
	return cacheDir;
}

async function packagedPluginVersion(): Promise<string> {
	const testDir = dirname(fileURLToPath(import.meta.url));
	const repoRoot = join(testDir, "..", "..", "..");
	const manifest = JSON.parse(
		await readFile(
			join(repoRoot, "plugins", "oh-my-codex", ".codex-plugin", "plugin.json"),
			"utf-8",
		),
	) as { version?: unknown };
	if (typeof manifest.version !== "string") {
		assert.fail("packaged plugin manifest version must be a string");
	}
	return manifest.version;
}

function buildHooksJsonWithPostCompactCommand(
	postCompactCommand: string,
	codexHomeDir: string,
	expectedCommand = currentNativeHookCommand(codexHomeDir),
): string {
	return `${JSON.stringify({
		hooks: Object.fromEntries(
			MANAGED_HOOK_EVENTS.map((eventName) => [
				eventName,
				[
					{
						hooks: [
							{
								type: "command",
								command: eventName === "PostCompact"
									? postCompactCommand
									: expectedCommand,
							},
						],
					},
				],
			]),
		),
	}, null, 2)}\n`;
}

async function withRecoverableDoctorClaimJournal<T>(
	run: (codexHomeDir: string) => Promise<T>,
): Promise<T> {
	const wd = await mkdtemp(join(tmpdir(), "omx-doctor-claim-recovery-"));
	const codexHomeDir = join(wd, ".codex");
	const hooksPath = join(codexHomeDir, "hooks.json");
	const claimPath = join(codexHomeDir, ".hooks.json.omx-claim-test.tmp");
	const previousCwd = process.cwd();
	const previousCodexHome = process.env.CODEX_HOME;
	try {
		await mkdir(codexHomeDir, { recursive: true });
		await writeFile(hooksPath, "{\"hooks\":{}}\n");
		await persistNativeHookClaimJournal(
			codexHomeDir,
			{
				canonicalPath: hooksPath,
				claimPath,
				before: Buffer.from("{\"hooks\":{}}\n"),
				after: null,
			},
			createNativeHookClaimJournalDurability(),
		);
		await rename(hooksPath, claimPath);
		const journalPath = join(codexHomeDir, ".omx", "native-hook-claim-journal.json");
		const journal = JSON.parse(await readFile(journalPath, "utf-8")) as { ownerPid: number };
		journal.ownerPid = 2_147_483_647;
		await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf-8");
		process.env.CODEX_HOME = codexHomeDir;
		process.chdir(wd);
		return await run(codexHomeDir);
	} finally {
		process.chdir(previousCwd);
		if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = previousCodexHome;
		await rm(wd, { recursive: true, force: true });
	}
}

describe("omx doctor onboarding warning copy", () => {
	it("warns about external LaunchAgents that kill Codex app-server MCP children", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-external-guard-"));
		try {
			const home = join(wd, "home");
			const launchAgentsDir = join(home, "Library", "LaunchAgents");
			const scriptsDir = join(home, ".omx", "scripts");
			const scriptPath = join(scriptsDir, "codex_mcp_child_guard.sh");
			await mkdir(launchAgentsDir, { recursive: true });
			await mkdir(scriptsDir, { recursive: true });
			await writeFile(
				scriptPath,
				[
					"#!/usr/bin/env bash",
					"CODEX_MCP_GUARD_DEDUPE_APP_CHILDREN=1",
					"app_pid=123",
					"pgrep -P \"$app_pid\"",
					"kill 456",
					"",
				].join("\n"),
			);
			await writeFile(
				join(launchAgentsDir, "com.example.codex-mcp-child-guard.plist"),
				[
					'<?xml version="1.0" encoding="UTF-8"?>',
					'<plist version="1.0">',
					"<dict>",
					"<key>Label</key>",
					"<string>com.example.codex-mcp-child-guard</string>",
					"<key>ProgramArguments</key>",
					"<array>",
					`<string>${scriptPath}</string>`,
					"<string>cleanup</string>",
					"</array>",
					"</dict>",
					"</plist>",
					"",
				].join("\n"),
			);

			const check = await checkExternalCodexProcessGuards({
				platform: "darwin",
				homeDir: home,
			});

			assert.ok(check);
			assert.equal(check.name, "External process guards");
			assert.equal(check.status, "warn");
			assert.match(check.message, /com\.example\.codex-mcp-child-guard/);
			assert.match(check.message, /Codex app-server MCP child dedupe/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("follows XML-decoded HOME-relative LaunchAgent script paths", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-external-home-guard-"));
		try {
			const home = join(wd, "home");
			const launchAgentsDir = join(home, "Library", "LaunchAgents");
			const scriptsDir = join(home, ".omx", "scripts");
			const scriptPath = join(scriptsDir, "codex&mcp_guard.sh");
			await mkdir(launchAgentsDir, { recursive: true });
			await mkdir(scriptsDir, { recursive: true });
			await writeFile(
				scriptPath,
				[
					"#!/usr/bin/env bash",
					"CODEX_MCP_GUARD_DEDUPE_APP_CHILDREN=1",
					"kill 456",
					"",
				].join("\n"),
			);
			await writeFile(
				join(launchAgentsDir, "com.example.codex-encoded-guard.plist"),
				[
					'<?xml version="1.0" encoding="UTF-8"?>',
					'<plist version="1.0">',
					"<dict>",
					"<key>Label</key>",
					"<string>com.example.codex&amp;encoded-guard</string>",
					"<key>ProgramArguments</key>",
					"<array>",
					"<string>$HOME/.omx/scripts/codex&amp;mcp_guard.sh</string>",
					"</array>",
					"</dict>",
					"</plist>",
					"",
				].join("\n"),
			);

			const check = await checkExternalCodexProcessGuards({
				platform: "darwin",
				homeDir: home,
			});

			assert.ok(check);
			assert.equal(check.status, "warn");
			assert.match(check.message, /com\.example\.codex&encoded-guard/);
			assert.match(check.message, /Codex app-server MCP child dedupe/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("skips external process guard checks outside macOS", async () => {
		const check = await checkExternalCodexProcessGuards({
			platform: "linux",
			homeDir: "/tmp/unused",
		});

		assert.equal(check, null);
	});

	it("does not warn about the Windows explore harness when deprecated explore routing is disabled by default", () => {
		const check = checkExploreHarness("win32", {} as NodeJS.ProcessEnv);

		assert.equal(check.name, "Explore Harness");
		assert.equal(check.status, "pass");
		assert.match(check.message, /omx explore is hard-deprecated/i);
		assert.match(check.message, /explore routing is disabled by default/i);
		assert.match(check.message, /omx sparkshell/i);
		assert.doesNotMatch(check.message, /not ready on Windows/i);
	});

	it("still warns about the Windows built-in explore harness when deprecated routing is explicitly enabled", () => {
		const check = checkExploreHarness("win32", { USE_OMX_EXPLORE_CMD: "1" } as NodeJS.ProcessEnv);

		assert.equal(check.name, "Explore Harness");
		assert.equal(check.status, "warn");
		assert.match(check.message, /not ready on Windows/i);
		assert.match(check.message, /OMX_EXPLORE_BIN/);
		assert.match(check.message, /omx sparkshell/i);
	});

	it("preserves warnings for explicit custom explore harness overrides", () => {
		const check = checkExploreHarness("win32", { OMX_EXPLORE_BIN: "missing-custom-harness.exe" } as NodeJS.ProcessEnv);

		assert.equal(check.name, "Explore Harness");
		assert.equal(check.status, "warn");
		assert.match(check.message, /OMX_EXPLORE_BIN is set but path was not found/);
	});

	it("treats user-managed MCP servers as preserved under CLI-first defaults", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-copy-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await writeFile(
				join(codexDir, "config.toml"),
				`
[mcp_servers.non_omx]
command = "node"
`.trimStart(),
			);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: join(home, ".codex"),
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Config: config\.toml exists but no OMX entries yet \(expected before first setup; run "omx setup --force" once\)/,
			);
			assert.match(
				res.stdout,
				/MCP Servers: 1 user-managed MCP server\(s\) preserved; first-party OMX MCP omitted by default/,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("warns when an existing user AGENTS.md lacks OMX contract markers", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-agents-contract-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await writeFile(join(codexDir, "AGENTS.md"), "# context-mode instructions\n");

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(res.stdout, /\[!!\] AGENTS\.md: OMX AGENTS contract markers missing/);
			assert.match(res.stdout, /may have been overwritten by another tool/);
			assert.match(res.stdout, /omx setup --scope user --merge-agents/);
			assert.match(res.stdout, /omx setup --scope user --force/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reports a failed check in plugin mode when persistent AGENTS.md is missing", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-plugin-agents-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await mkdir(join(wd, ".omx"), { recursive: true });
			await writeFile(
				join(wd, ".omx", "setup-scope.json"),
				JSON.stringify({
					scope: "user",
					installMode: "plugin",
					mcpMode: "none",
				}),
			);
			await writeFile(
				join(codexDir, "config.toml"),
				[
					'developer_instructions = "You have oh-my-codex installed through Codex plugin mode. AGENTS.md is the orchestration brain and main control surface."',
					"plugin_hooks = true",
					"goals = true",
					"",
				].join("\n"),
			);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/\[XX\] AGENTS\.md: persistent AGENTS\.md is missing in plugin mode/,
			);
			assert.match(
				res.stdout,
				/session-scoped AGENTS\.md can carry runtime overlay only/,
			);
			assert.match(
				res.stdout,
				/Run "omx setup --scope user --force" and accept AGENTS\.md defaults/,
			);
			assert.doesNotMatch(
				res.stdout,
				/optional plugin-mode AGENTS\.md defaults not installed/,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("warns in plugin mode when persistent AGENTS.md exists without OMX contract markers", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-plugin-agents-contract-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await mkdir(join(wd, ".omx"), { recursive: true });
			await writeFile(
				join(wd, ".omx", "setup-scope.json"),
				JSON.stringify({
					scope: "user",
					installMode: "plugin",
					mcpMode: "none",
				}),
			);
			await writeFile(join(codexDir, "config.toml"), "plugin_hooks = true\ngoals = true\n");
			await writeFile(join(codexDir, "AGENTS.md"), "# local instructions\n");

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(res.stdout, /\[!!\] AGENTS\.md: OMX AGENTS contract markers missing/);
			assert.match(res.stdout, /omx setup --scope user --merge-agents/);
			assert.doesNotMatch(res.stdout, /optional plugin-mode AGENTS\.md defaults found/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("passes when user AGENTS.md contains the generated OMX contract marker", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-agents-contract-ok-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await writeFile(
				join(codexDir, "AGENTS.md"),
				[
					"<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->",
					"<!-- END AUTONOMY DIRECTIVE -->",
					"<!-- omx:generated:agents-md -->",
					"# oh-my-codex - Intelligent Multi-Agent Orchestration",
					"AGENTS.md is the top-level operating contract for the workspace.",
					"",
				].join("\n"),
			);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(res.stdout, /\[OK\] AGENTS\.md: found OMX contract in /);
			assert.doesNotMatch(res.stdout, /AGENTS contract markers missing/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("recognizes setup-installed native reviewer roles separately from healthy plugin skills and hooks", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-plugin-mode-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });

			const setupRes = runOmx(
				wd,
				["setup", "--scope", "user", "--plugin", "--force"],
				{
					HOME: home,
					CODEX_HOME: codexDir,
				},
			);
			if (shouldSkipForSpawnPermissions(setupRes.error)) return;
			assert.equal(setupRes.status, 0, setupRes.stderr || setupRes.stdout);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(res.stdout, /Resolved setup install mode: plugin/);
			assert.match(res.stdout, /Resolved setup MCP mode: none/);
			assert.match(
				res.stdout,
				/Prompts: plugin mode intentionally omits setup-owned prompts; Codex plugin discovery supplies workflow surfaces/,
			);
			assert.match(
				res.stdout,
				/Skills: plugin marketplace oh-my-codex-local registered; OMX skills are supplied by/,
			);
			assert.match(
				res.stdout,
				/\[OK\] Native reviewer roles: required RALPLAN\/Autopilot native reviewer roles are available \(architect, critic\); advisory scholastic role is also available/,
			);
			assert.doesNotMatch(res.stdout, /role-specific subagent calls may degrade/);
			assert.match(
				res.stdout,
				/MCP Servers: CLI-first plugin mode: first-party MCP compatibility explicitly disabled/,
			);
			assert.doesNotMatch(res.stdout, /Prompts: prompts directory not found/);
			assert.doesNotMatch(res.stdout, /Skills: skills directory not found/);
			assert.doesNotMatch(res.stdout, /Skills: \d+ skills \(expected >=/);
			assert.doesNotMatch(res.stdout, /MCP Servers: no MCP servers configured/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("accepts plugin mode when required native reviewer roles are available from agent files and config", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-plugin-native-roles-ok-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });

			const setupRes = runOmx(
				wd,
				["setup", "--scope", "user", "--plugin", "--force"],
				{
					HOME: home,
					CODEX_HOME: codexDir,
				},
			);
			if (shouldSkipForSpawnPermissions(setupRes.error)) return;
			assert.equal(setupRes.status, 0, setupRes.stderr || setupRes.stdout);

			await mkdir(join(codexDir, "agents"), { recursive: true });
			await writeFile(
				join(codexDir, "agents", "architect.toml"),
				'name = "architect"\ndescription = "Architect reviewer"\n',
			);
			await writeFile(
				join(codexDir, "config.toml"),
				`${await readFile(join(codexDir, "config.toml"), "utf-8")}\n[agents.critic]\ndescription = "Critic reviewer"\n\n[agents.scholastic]\ndescription = "Scholastic advisory reviewer"\n`,
			);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/\[OK\] Native reviewer roles: required RALPLAN\/Autopilot native reviewer roles are available \(architect, critic\); advisory scholastic role is also available/,
			);
			assert.match(
				res.stdout,
				/Skills: plugin marketplace oh-my-codex-local registered; OMX skills are supplied by/,
			);
			assert.doesNotMatch(res.stdout, /role-specific subagent calls may degrade/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("warns when plugin cache manifest version is stale even when skills match", async () => {
		const wd = await mkdtemp(
			join(tmpdir(), "omx-doctor-plugin-cache-stale-version-"),
		);
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });

			const setupRes = runOmx(
				wd,
				["setup", "--scope", "user", "--plugin", "--force"],
				{
					HOME: home,
					CODEX_HOME: codexDir,
				},
			);
			if (shouldSkipForSpawnPermissions(setupRes.error)) return;
			assert.equal(setupRes.status, 0, setupRes.stderr || setupRes.stdout);

			const version = await packagedPluginVersion();
			const cacheManifestPath = join(
				codexDir,
				"plugins",
				"cache",
				"oh-my-codex-local",
				"oh-my-codex",
				version,
				".codex-plugin",
				"plugin.json",
			);
			const staleManifest = JSON.parse(
				await readFile(cacheManifestPath, "utf-8"),
			) as Record<string, unknown>;
			staleManifest.version = "0.0.0-stale";
			await writeFile(
				cacheManifestPath,
				`${JSON.stringify(staleManifest, null, 2)}\n`,
			);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				new RegExp(
					`Skills: plugin marketplace oh-my-codex-local is registered, but installed Codex plugin cache manifest version 0\\.0\\.0-stale does not match packaged version ${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; run "omx setup --plugin --force" so /skills can discover OMX plugin skills`,
				),
			);
			assert.match(
				res.stdout,
				new RegExp(
					`Plugin versions: expected cache directory .*${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not materialized with packaged plugin manifest version ${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; run "omx setup --plugin --force" to refresh the plugin cache`,
				),
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("warns when plugin mode is configured but the Codex plugin cache is missing", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-plugin-cache-missing-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });

			const setupRes = runOmx(
				wd,
				["setup", "--scope", "user", "--plugin", "--force"],
				{
					HOME: home,
					CODEX_HOME: codexDir,
				},
			);
			if (shouldSkipForSpawnPermissions(setupRes.error)) return;
			assert.equal(setupRes.status, 0, setupRes.stderr || setupRes.stdout);
			await rm(join(codexDir, "plugins", "cache"), {
				recursive: true,
				force: true,
			});

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Skills: plugin marketplace oh-my-codex-local is registered, but no installed Codex plugin cache was found; run "omx setup --plugin --force" so \/skills can discover OMX plugin skills/,
			);
			assert.match(
				res.stdout,
				/Plugin versions: expected cache directory .* is not materialized with packaged plugin manifest version .*; run "omx setup --plugin --force" to refresh the plugin cache/,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("uses project-scoped plugin marketplace registration without legacy omission warnings", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-project-plugin-mode-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });

			const setupRes = runOmx(
				wd,
				["setup", "--scope", "project", "--plugin", "--force"],
				{
					HOME: home,
					CODEX_HOME: codexDir,
				},
			);
			if (shouldSkipForSpawnPermissions(setupRes.error)) return;
			assert.equal(setupRes.status, 0, setupRes.stderr || setupRes.stdout);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Resolved setup scope: project \(from \.omx\/setup-scope\.json\)/,
			);
			assert.match(
				res.stdout,
				/Resolved setup install mode: plugin \(from \.omx\/setup-scope\.json\)/,
			);
			assert.match(
				res.stdout,
				/Resolved setup MCP mode: none \(from \.omx\/setup-scope\.json\)/,
			);
			assert.match(
				res.stdout,
				/Skills: plugin marketplace oh-my-codex-local registered; OMX skills are supplied by/,
			);
			assert.match(
				res.stdout,
				/Prompts: plugin mode intentionally omits setup-owned prompts; Codex plugin discovery supplies workflow surfaces/,
			);
			assert.match(
				res.stdout,
				/MCP Servers: CLI-first plugin mode: first-party MCP compatibility explicitly disabled/,
			);
			assert.doesNotMatch(res.stdout, /Prompts: prompts directory not found/);
			assert.doesNotMatch(res.stdout, /Skills: skills directory not found/);
			assert.doesNotMatch(res.stdout, /MCP Servers: no MCP servers configured/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("warns specifically when plugin-mode marketplace registration is missing", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-plugin-mode-missing-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(join(wd, ".omx"), { recursive: true });
			await mkdir(codexDir, { recursive: true });
			await writeFile(
				join(wd, ".omx", "setup-scope.json"),
				JSON.stringify({ scope: "user", installMode: "plugin" }, null, 2) +
					"\n",
			);
			await writeFile(join(codexDir, "config.toml"), "codex_hooks = true\n");

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(res.stdout, /Resolved setup install mode: plugin/);
			assert.match(
				res.stdout,
				/Skills: plugin mode selected, but Codex marketplace oh-my-codex-local is not registered; run "omx setup --plugin --force"/,
			);
			assert.doesNotMatch(res.stdout, /Skills: skills directory not found/);
			assert.doesNotMatch(res.stdout, /MCP Servers: no MCP servers configured/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("warns about retired omx_team_run config left behind after upgrade", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-copy-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await writeFile(
				join(codexDir, "config.toml"),
				`
[mcp_servers.omx_team_run]
command = "node"
args = ["/tmp/team-server.js"]
enabled = true
`.trimStart(),
			);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: join(home, ".codex"),
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Config: retired \[mcp_servers\.omx_team_run\] table still present; run "omx setup --force" to repair the config/,
			);
			assert.match(
				res.stdout,
				/MCP Servers: 1 servers configured, but retired \[mcp_servers\.omx_team_run\] is not supported; run "omx setup --force" to repair the config/,
			);
			assert.doesNotMatch(res.stdout, /Config: config\.toml has OMX entries/);
			assert.doesNotMatch(
				res.stdout,
				/MCP Servers: 1 user-managed MCP server\(s\) preserved; first-party OMX MCP omitted by default/,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("warns when explore harness sources are packaged but cargo is unavailable", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-explore-copy-"));
		try {
			await withPackagedExploreHarnessHidden(async () => {
				const home = join(wd, "home");
				const codexDir = join(home, ".codex");
				const fakeBin = join(wd, "bin");
				await mkdir(codexDir, { recursive: true });
				await mkdir(fakeBin, { recursive: true });
				await writeFile(
					join(fakeBin, "codex"),
					'#!/bin/sh\necho "codex test"\n',
				);
				spawnSync("chmod", ["+x", join(fakeBin, "codex")], {
					encoding: "utf-8",
				});

				const res = runOmx(wd, ["doctor"], {
					HOME: home,
					CODEX_HOME: join(home, ".codex"),
					PATH: fakeBin,
					OMX_EXPLORE_BIN: "",
					USE_OMX_EXPLORE_CMD: "1",
				});
				if (shouldSkipForSpawnPermissions(res.error)) return;
				assert.equal(res.status, 0, res.stderr || res.stdout);
				assert.match(
					res.stdout,
					/Explore Harness: (Rust harness sources are packaged, but no compatible packaged prebuilt or cargo was found \(install Rust or set OMX_EXPLORE_BIN for omx explore\)|not ready \(no packaged binary, OMX_EXPLORE_BIN, or cargo toolchain\))/,
				);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("passes explore harness check when a packaged native binary is present even without cargo", async () => {
		await withPackagedExploreHarnessLock(async () => {
			const wd = await mkdtemp(join(tmpdir(), "omx-doctor-explore-binary-"));
			try {
				const home = join(wd, "home");
				const codexDir = join(home, ".codex");
				const fakeBin = join(wd, "bin");
				const packageBinDir = join(process.cwd(), "bin");
				const packagedBinary = join(
					packageBinDir,
					process.platform === "win32"
						? "omx-explore-harness.exe"
						: "omx-explore-harness",
				);
				const packagedMeta = join(
					packageBinDir,
					"omx-explore-harness.meta.json",
				);
				const hadExistingBinary = existsSync(packagedBinary);
				const hadExistingMeta = existsSync(packagedMeta);

				await mkdir(codexDir, { recursive: true });
				await mkdir(fakeBin, { recursive: true });
				await writeFile(
					join(fakeBin, "codex"),
					'#!/bin/sh\necho "codex test"\n',
				);
				spawnSync("chmod", ["+x", join(fakeBin, "codex")], {
					encoding: "utf-8",
				});
				const fsPromises = await import("node:fs/promises");
				const originalBinary = hadExistingBinary
					? await fsPromises.readFile(packagedBinary)
					: null;
				const originalMeta = hadExistingMeta
					? await fsPromises.readFile(packagedMeta, "utf-8")
					: null;
				await mkdir(packageBinDir, { recursive: true });
				await writeFile(packagedBinary, '#!/bin/sh\necho "stub harness"\n');
				await writeFile(
					packagedMeta,
					JSON.stringify({
						binaryName:
							process.platform === "win32"
								? "omx-explore-harness.exe"
								: "omx-explore-harness",
						platform: process.platform,
						arch: process.arch,
					}),
				);
				spawnSync("chmod", ["+x", packagedBinary], { encoding: "utf-8" });

				try {
					const res = runOmx(wd, ["doctor"], {
						HOME: home,
						CODEX_HOME: join(home, ".codex"),
						PATH: fakeBin,
						OMX_EXPLORE_BIN: "",
						USE_OMX_EXPLORE_CMD: "1",
					});
					if (shouldSkipForSpawnPermissions(res.error)) return;
					assert.equal(res.status, 0, res.stderr || res.stdout);
					assert.match(
						res.stdout,
						/Explore Harness: ready \(packaged native binary:/,
					);
				} finally {
					if (originalBinary) {
						await writeFile(packagedBinary, originalBinary);
						spawnSync("chmod", ["+x", packagedBinary], { encoding: "utf-8" });
					} else {
						await rm(packagedBinary, { force: true });
					}
					if (originalMeta !== null) {
						await writeFile(packagedMeta, originalMeta);
					} else {
						await rm(packagedMeta, { force: true });
					}
				}
			} finally {
				await rm(wd, { recursive: true, force: true });
			}
		});
	});

	it("passes when deprecated explore routing is explicitly disabled by environment/config", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-explore-routing-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await writeFile(
				join(codexDir, "config.toml"),
				`
[shell_environment_policy.set]
USE_OMX_EXPLORE_CMD = "off"
`.trimStart(),
			);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: join(home, ".codex"),
				USE_OMX_EXPLORE_CMD: "off",
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Explore routing: deprecated compatibility routing disabled by environment override \(recommended\)/,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reports when Lore commit guard is explicitly disabled in config.toml", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-lore-commit-guard-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await writeFile(
				join(codexDir, "config.toml"),
				`
[shell_environment_policy.set]
OMX_LORE_COMMIT_GUARD = "off"
`.trimStart(),
			);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: join(home, ".codex"),
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Lore commit guard: disabled in config\.toml\/default opt-out; set OMX_LORE_COMMIT_GUARD = "1" under \[shell_environment_policy\.set\] to enable Lore commit enforcement/,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reports when Lore commit guard is explicitly enabled in config.toml", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-lore-commit-guard-enabled-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await writeFile(
				join(codexDir, "config.toml"),
				`
[shell_environment_policy.set]
OMX_LORE_COMMIT_GUARD = "1"
`.trimStart(),
			);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: join(home, ".codex"),
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(res.stdout, /Lore commit guard: enabled by config\.toml opt-in/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("warns when Lore commit guard has an invalid config.toml value", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-lore-commit-guard-invalid-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await writeFile(
				join(codexDir, "config.toml"),
				`
[shell_environment_policy.set]
OMX_LORE_COMMIT_GUARD = "truee"
`.trimStart(),
			);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: join(home, ".codex"),
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Lore commit guard: invalid config\.toml value; Lore commit enforcement is disabled until OMX_LORE_COMMIT_GUARD = "1" \(or true\/yes\/on\) is set under \[shell_environment_policy\.set\]/,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("passes when shared skill root exists without duplicate skill names", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-shared-skills-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			const canonicalPlan = join(codexDir, "skills", "plan");
			const legacyShared = join(home, ".agents", "skills", "shared-context");
			await mkdir(canonicalPlan, { recursive: true });
			await mkdir(legacyShared, { recursive: true });
			await writeFile(join(canonicalPlan, "SKILL.md"), "# canonical plan\n");
			await writeFile(join(legacyShared, "SKILL.md"), "# shared context\n");

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/\[OK\] Legacy skill roots: shared ~\/\.agents\/skills exists \(1 skills\) alongside canonical .*\.codex[\\/]+skills; no duplicate skill names detected/,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("warns when canonical and legacy skill roots overlap", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-skill-overlap-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			const canonicalHelp = join(codexDir, "skills", "help");
			const canonicalPlan = join(codexDir, "skills", "plan");
			const legacyHelp = join(home, ".agents", "skills", "help");
			await mkdir(canonicalHelp, { recursive: true });
			await mkdir(canonicalPlan, { recursive: true });
			await mkdir(legacyHelp, { recursive: true });
			await writeFile(join(canonicalHelp, "SKILL.md"), "# canonical help\n");
			await writeFile(join(canonicalPlan, "SKILL.md"), "# canonical plan\n");
			await writeFile(join(legacyHelp, "SKILL.md"), "# legacy help\n");

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Legacy skill roots: 1 overlapping skill names between .*\.codex[\\/]+skills and .*\.agents[\\/]+skills; 1 differ in SKILL\.md content; Codex Enable\/Disable Skills may show duplicates until ~\/\.agents\/skills is cleaned up/,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});


	it("infers plugin MCP compat mode from Codex plugin config when setup-scope is absent", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-plugin-config-compat-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await installPluginCacheFixture(codexDir);
			await writeFile(
				join(codexDir, "config.toml"),
				[
					"plugin_hooks = true",
					"goals = true",
					"",
					"[marketplaces.oh-my-codex-local]",
					'source_type = "local"',
					`source = ${JSON.stringify(repoRoot())}`,
					"",
					'[plugins."oh-my-codex@oh-my-codex-local"]',
					"enabled = true",
					"",
					'[plugins."oh-my-codex@oh-my-codex-local".mcp_servers.omx_state]',
					"enabled = true",
					'[plugins."oh-my-codex@oh-my-codex-local".mcp_servers.omx_memory]',
					"enabled = true",
					'[plugins."oh-my-codex@oh-my-codex-local".mcp_servers.omx_code_intel]',
					"enabled = true",
					'[plugins."oh-my-codex@oh-my-codex-local".mcp_servers.omx_trace]',
					"enabled = true",
					'[plugins."oh-my-codex@oh-my-codex-local".mcp_servers.omx_wiki]',
					"enabled = true",
					'[plugins."oh-my-codex@oh-my-codex-local".mcp_servers.omx_hermes]',
					"enabled = true",
					"",
				].join("\n"),
			);

			assert.equal(existsSync(join(wd, ".omx", "setup-scope.json")), false);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Resolved setup MCP mode: compat \(inferred from Codex plugin config\)/,
			);
			assert.match(
				res.stdout,
				/MCP Servers: plugin MCP compatibility enabled by setup MCP mode compat \(6\/6 first-party servers enabled\)/,
			);
			assert.doesNotMatch(
				res.stdout,
				/plugin MCP compatibility overrides are incomplete or mixed/,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("does not infer plugin mode from a foreign local marketplace source", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-plugin-config-foreign-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await writeFile(
				join(codexDir, "config.toml"),
				[
					"plugin_hooks = true",
					"goals = true",
					"",
					"[marketplaces.oh-my-codex-local]",
					'source_type = "local"',
					`source = ${JSON.stringify(join(wd, "other-oh-my-codex"))}`,
					"",
					'[plugins."oh-my-codex@oh-my-codex-local"]',
					"enabled = true",
					"",
				].join("\n"),
			);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.doesNotMatch(
				res.stdout,
				/Resolved setup install mode: plugin \(inferred from Codex plugin config\)/,
			);
			assert.match(
				res.stdout,
				/Native hooks: expected setup-owned hooks\.json is missing at .*\.codex[\\/]+hooks\.json even though config\.toml has OMX entries; run "omx setup" to restore native hook coverage/,
			);
			assert.match(res.stdout, /Prompts: prompts directory not found/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("infers plugin mode from Codex plugin config when setup-scope is absent", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-plugin-config-infer-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			const cacheDir = await installPluginCacheFixture(codexDir);
			await writeFile(
				join(codexDir, "config.toml"),
				[
					"plugin_hooks = true",
					"goals = true",
					"",
					"[marketplaces.oh-my-codex-local]",
					'source_type = "local"',
					`source = ${JSON.stringify(repoRoot())}`,
					"",
					'[plugins."oh-my-codex@oh-my-codex-local"]',
					"enabled = true",
					"",
				].join("\n"),
			);

			assert.equal(existsSync(join(wd, ".omx", "setup-scope.json")), false);
			assert.equal(existsSync(join(codexDir, "hooks.json")), false);
			assert.equal(existsSync(join(codexDir, "prompts")), false);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Resolved setup install mode: plugin \(inferred from Codex plugin config\)/,
			);
			assert.match(
				res.stdout,
				new RegExp(
					`\\[OK\\] Native hooks: plugin-scoped hooks are enabled; setup-owned hooks\\.json is intentionally absent at .*\\.codex[\\/]+hooks\\.json, and plugin cache native hook coverage smoke passed via ${join(cacheDir, "hooks", "hooks.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
				),
			);
			assert.match(
				res.stdout,
				/Prompts: plugin mode intentionally omits setup-owned prompts; Codex plugin discovery supplies workflow surfaces/,
			);
			assert.match(
				res.stdout,
				/Skills: plugin marketplace oh-my-codex-local registered; OMX skills are supplied by/,
			);
			assert.doesNotMatch(
				res.stdout,
				/expected setup-owned hooks\.json is missing/,
			);
			assert.doesNotMatch(
				res.stdout,
				/plugin mode is using legacy native hook fallback/,
			);
			assert.doesNotMatch(
				res.stdout,
				/run "omx setup --force" to restore native hook coverage/,
			);
			assert.doesNotMatch(res.stdout, /Prompts: prompts directory not found/);
			assert.doesNotMatch(res.stdout, /Skills: skills directory not found/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("treats a dev-update plugin install shape without setup-scope as plugin mode", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-plugin-dev-update-infer-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			const installedSourceDir = join(wd, "installed-oh-my-codex");
			await mkdir(join(codexDir, ".omx"), { recursive: true });
			await mkdir(installedSourceDir, { recursive: true });
			await mkdir(codexDir, { recursive: true });
			const cacheDir = await installPluginCacheFixture(codexDir);
			const manifestVersion = await packagedPluginVersion();
			await writeFile(
				join(installedSourceDir, "package.json"),
				`${JSON.stringify({ name: "oh-my-codex", version: manifestVersion }, null, 2)}\n`,
			);
			await writeFile(
				join(codexDir, ".omx", "install-state.json"),
				`${JSON.stringify(
					{
						installed_version: manifestVersion,
						setup_completed_version: manifestVersion,
						install_channel: "dev",
						install_revision: "deadbeefcafefeed",
						dev_base_version: "0.18.11",
					},
					null,
					2,
				)}\n`,
			);
			await writeFile(
				join(codexDir, "config.toml"),
				[
					"plugin_hooks = true",
					"goals = true",
					"",
					"[marketplaces.oh-my-codex-local]",
					'source_type = "local"',
					`source = ${JSON.stringify(installedSourceDir)}`,
					"",
					'[plugins."oh-my-codex@oh-my-codex-local"]',
					"enabled = true",
					"",
				].join("\n"),
			);

			assert.equal(existsSync(join(wd, ".omx", "setup-scope.json")), false);
			assert.equal(existsSync(join(codexDir, "hooks.json")), false);
			assert.equal(existsSync(join(codexDir, "prompts")), false);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Resolved setup install mode: plugin \(inferred from Codex plugin config\)/,
			);
			assert.match(
				res.stdout,
				new RegExp(
					`\\[OK\\] Native hooks: plugin-scoped hooks are enabled; setup-owned hooks\\.json is intentionally absent at .*\\.codex[\\/]+hooks\\.json, and plugin cache native hook coverage smoke passed via ${join(cacheDir, "hooks", "hooks.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
				),
			);
			assert.match(
				res.stdout,
				/Prompts: plugin mode intentionally omits setup-owned prompts; Codex plugin discovery supplies workflow surfaces/,
			);
			assert.match(
				res.stdout,
				new RegExp(
					`Plugin versions: package/plugin manifest version ${manifestVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; dev display version v0\\.18\\.11-dev-deadbeefcafefeed; dev_base_version 0\\.18\\.11; install_revision deadbeefcafefeed; Codex may keep current-session plugin skill metadata until a new Codex session starts`,
				),
			);
			assert.doesNotMatch(
				res.stdout,
				/expected setup-owned hooks\.json is missing/,
			);
			assert.doesNotMatch(res.stdout, /Prompts: prompts directory not found/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("fills missing persisted install mode from plugin config without legacy warnings", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-plugin-partial-persisted-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(join(wd, ".omx"), { recursive: true });
			await mkdir(codexDir, { recursive: true });
			await installPluginCacheFixture(codexDir);
			await writeFile(
				join(wd, ".omx", "setup-scope.json"),
				`${JSON.stringify({ scope: "user" }, null, 2)}\n`,
			);
			await writeFile(
				join(codexDir, "config.toml"),
				[
					"plugin_hooks = true",
					"goals = true",
					"",
					"[marketplaces.oh-my-codex-local]",
					'source_type = "local"',
					`source = ${JSON.stringify(repoRoot())}`,
					"",
					'[plugins."oh-my-codex@oh-my-codex-local"]',
					"enabled = true",
					"",
				].join("\n"),
			);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Resolved setup scope: user \(from \.omx\/setup-scope\.json\)/,
			);
			assert.match(
				res.stdout,
				/Resolved setup install mode: plugin \(from \.omx\/setup-scope\.json\)/,
			);
			assert.match(
				res.stdout,
				/Prompts: plugin mode intentionally omits setup-owned prompts; Codex plugin discovery supplies workflow surfaces/,
			);
			assert.doesNotMatch(
				res.stdout,
				/expected setup-owned hooks\.json is missing/,
			);
			assert.doesNotMatch(res.stdout, /Prompts: prompts directory not found/);
			assert.doesNotMatch(res.stdout, /Skills: skills directory not found/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("infers project plugin mode from project Codex config when setup-scope is absent", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-project-plugin-config-infer-"));
		try {
			const home = join(wd, "home");
			const projectCodexDir = join(wd, ".codex");
			await mkdir(projectCodexDir, { recursive: true });
			await installPluginCacheFixture(projectCodexDir);
			await writeFile(
				join(projectCodexDir, "config.toml"),
				[
					"plugin_hooks = true",
					"goals = true",
					"",
					"[marketplaces.oh-my-codex-local]",
					'source_type = "local"',
					`source = ${JSON.stringify(repoRoot())}`,
					"",
					'[plugins."oh-my-codex@oh-my-codex-local"]',
					"enabled = true",
					"",
				].join("\n"),
			);

			assert.equal(existsSync(join(wd, ".omx", "setup-scope.json")), false);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: join(home, ".codex"),
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Resolved setup scope: project \(inferred from Codex plugin config\)/,
			);
			assert.match(
				res.stdout,
				/Resolved setup install mode: plugin \(inferred from Codex plugin config\)/,
			);
			assert.match(
				res.stdout,
				/Prompts: plugin mode intentionally omits setup-owned prompts; Codex plugin discovery supplies workflow surfaces/,
			);
			assert.match(
				res.stdout,
				/Skills: plugin marketplace oh-my-codex-local registered; OMX skills are supplied by/,
			);
			assert.doesNotMatch(
				res.stdout,
				/expected setup-owned hooks\.json is missing/,
			);
			assert.doesNotMatch(res.stdout, /Prompts: prompts directory not found/);
			assert.doesNotMatch(res.stdout, /Skills: skills directory not found/);
			assert.doesNotMatch(res.stdout, /MCP Servers: config\.toml not found/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("accepts plugin-scoped native hooks when setup-owned hooks.json is intentionally absent", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-plugin-scoped-hooks-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(join(wd, ".omx"), { recursive: true });
			await mkdir(codexDir, { recursive: true });
			const cacheDir = await installPluginCacheFixture(codexDir);
			await writeFile(
				join(wd, ".omx", "setup-scope.json"),
				`${JSON.stringify({ scope: "user", installMode: "plugin", mcpMode: "none" }, null, 2)}\n`,
			);
			await writeFile(
				join(codexDir, "config.toml"),
				[
					"plugin_hooks = true",
					"goals = true",
					"",
					"[marketplaces.oh-my-codex-local]",
					'source_type = "local"',
					`source = ${JSON.stringify(repoRoot())}`,
					"",
					'[plugins."oh-my-codex@oh-my-codex-local"]',
					"enabled = true",
					"",
				].join("\n"),
			);

			const setupOwnedHooksPath = join(codexDir, "hooks.json");
			assert.equal(existsSync(setupOwnedHooksPath), false);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(res.stdout, /Resolved setup install mode: plugin/);
			assert.match(
				res.stdout,
				new RegExp(
					`\\[OK\\] Native hooks: plugin-scoped hooks are enabled; setup-owned hooks\\.json is intentionally absent at .*\\.codex[\\/]+hooks\\.json, and plugin cache native hook coverage smoke passed via ${join(cacheDir, "hooks", "hooks.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
				),
			);
			assert.match(
				res.stdout,
				/Skills: plugin marketplace oh-my-codex-local registered; OMX skills are supplied by/,
			);
			assert.doesNotMatch(res.stdout, /hooks\.json not found even though config\.toml has OMX entries/);
			assert.doesNotMatch(res.stdout, /run "omx setup --force" to restore native hook coverage/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("warns when plugin-scoped hook cache launcher content is stale", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-plugin-hook-cache-stale-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(join(wd, ".omx"), { recursive: true });
			await mkdir(codexDir, { recursive: true });
			const cacheDir = await installPluginCacheFixture(codexDir);
			await writeFile(
				join(cacheDir, "hooks", "omx-command.json"),
				`${JSON.stringify(
					{
						command: process.execPath,
						argsPrefix: ["/tmp/stale-omx-worktree/dist/cli/omx.js"],
					},
					null,
					2,
				)}\n`,
			);
			await writeFile(
				join(wd, ".omx", "setup-scope.json"),
				`${JSON.stringify({ scope: "user", installMode: "plugin", mcpMode: "none" }, null, 2)}\n`,
			);
			await writeFile(
				join(codexDir, "config.toml"),
				[
					"plugin_hooks = true",
					"goals = true",
					"",
					"[marketplaces.oh-my-codex-local]",
					'source_type = "local"',
					`source = ${JSON.stringify(repoRoot())}`,
					"",
					'[plugins."oh-my-codex@oh-my-codex-local"]',
					"enabled = true",
					"",
				].join("\n"),
			);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				new RegExp(
					`\\[!!\\] Native hooks: plugin-scoped hooks are enabled, but cached plugin hook files or pinned hook launcher in ${cacheDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} do not match the packaged plugin; setup-owned hooks\\.json is intentionally absent at .*\\.codex[\\/]+hooks\\.json; run "omx setup --plugin" to refresh the plugin cache`,
				),
			);
			assert.doesNotMatch(res.stdout, /plugin cache native hook coverage smoke passed/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("accepts plugin-scoped native hooks when hooks.json contains user-owned hooks", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-plugin-scoped-hooks-user-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(join(wd, ".omx"), { recursive: true });
			await mkdir(codexDir, { recursive: true });
			const cacheDir = await installPluginCacheFixture(codexDir);
			await writeFile(
				join(wd, ".omx", "setup-scope.json"),
				`${JSON.stringify({ scope: "user", installMode: "plugin", mcpMode: "none" }, null, 2)}\n`,
			);
			await writeFile(
				join(codexDir, "config.toml"),
				[
					"plugin_hooks = true",
					"goals = true",
					"",
					"[marketplaces.oh-my-codex-local]",
					'source_type = "local"',
					`source = ${JSON.stringify(repoRoot())}`,
					"",
					'[plugins."oh-my-codex@oh-my-codex-local"]',
					"enabled = true",
					"",
				].join("\n"),
			);
			await writeFile(
				join(codexDir, "hooks.json"),
				JSON.stringify(
					{
						hooks: {
							Stop: [
								{
									hooks: [
										{
											type: "command",
											command: "/usr/bin/python3 /tmp/user-notify.py",
											timeout: 5,
										},
									],
								},
							],
						},
					},
					null,
					2,
				),
			);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				new RegExp(
					`\\[OK\\] Native hooks: plugin-scoped hooks are enabled; existing hooks\\.json at .*\\.codex[\\/]+hooks\\.json is retained read-only and validated separately because plugin-scoped hooks are enabled, and plugin cache native hook coverage smoke passed via ${join(cacheDir, "hooks", "hooks.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
				),
			);
			assert.doesNotMatch(res.stdout, /hooks\.json is missing OMX-managed coverage/);
			assert.doesNotMatch(res.stdout, /run "omx setup --force" to restore native hooks/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("warns when hooks.json is missing OMX-managed native hook coverage", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-hooks-coverage-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await writeFile(
				join(codexDir, "hooks.json"),
				JSON.stringify(
					{
						hooks: {
							SessionStart: [
								{
									hooks: [
										{
											type: "command",
											command: 'node "/repo/dist/scripts/codex-native-hook.js"',
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

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Native hooks: hooks\.json is missing OMX-managed coverage for PreToolUse, PostToolUse, UserPromptSubmit, PreCompact, PostCompact, Stop; run "omx setup" to restore native hooks/,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("warns when runtime codex-home hooks.json symlinks back to project hooks", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-hooks-runtime-mirror-"));
		try {
			const codexDir = join(wd, ".codex");
			const runtimeSessionDir = join(wd, ".omx", "runtime", "codex-home", "session-1");
			await mkdir(codexDir, { recursive: true });
			await mkdir(runtimeSessionDir, { recursive: true });
			await writeFile(
				join(wd, ".omx", "setup-scope.json"),
				JSON.stringify({ scope: "project" }),
			);
			const managedEntry = {
				hooks: [
					{
						type: "command",
						command: 'node "/repo/dist/scripts/codex-native-hook.js"',
					},
				],
			};
			await writeFile(
				join(codexDir, "hooks.json"),
				JSON.stringify(
					{
						hooks: {
							SessionStart: [managedEntry],
							PreToolUse: [managedEntry],
							PostToolUse: [managedEntry],
							UserPromptSubmit: [managedEntry],
							Stop: [managedEntry],
						},
					},
					null,
					2,
				) + "\n",
			);
			await symlink(join(codexDir, "hooks.json"), join(runtimeSessionDir, "hooks.json"));

			const res = runOmx(wd, ["doctor"]);
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Native hook runtime mirrors: \.omx\/runtime\/codex-home contains 1 hooks\.json runtime mirror skipped by hook discovery/,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("warns when hooks.json is missing after OMX config was already installed", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-hooks-missing-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await writeFile(
				join(codexDir, "config.toml"),
				`
omx_enabled = true
[mcp_servers.omx_state]
command = "node"
`.trimStart(),
			);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Native hooks: expected setup-owned hooks\.json is missing at .*\.codex[\/]+hooks\.json even though config\.toml has OMX entries; run "omx setup" to restore native hook coverage/,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("fails when hooks.json is invalid and native hook coverage cannot be read", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-hooks-invalid-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await writeFile(join(codexDir, "hooks.json"), "{invalid json\n");

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/\[XX\] Native hooks: hooks\.json failed strict load validation \(invalid_document\): hooks\.json must contain a JSON object; inspect the file manually because doctor will not modify it/,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reports matcher-aware discovery warnings without touching hooks.json", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-hooks-matcher-warning-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await writeFile(
				join(codexDir, "hooks.json"),
				JSON.stringify({
					hooks: {
						SessionStart: [{
							matcher: "[",
							hooks: [{ type: "command", command: "echo user-owned" }],
						}],
					},
				}, null, 2) + "\n",
			);

			const res = runOmx(wd, ["doctor"], { HOME: home, CODEX_HOME: codexDir });
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Native hooks: hooks\.json discovery warnings: SessionStart\[0\]: Codex skips groups whose matcher is not a valid regular expression; Codex may ignore the listed entries, and doctor will not modify them/,
			);
			assert.doesNotMatch(res.stdout, /Native hooks:.*--force/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("treats UserPromptSubmit and Stop matcher groups as valid foreign survivors", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-hooks-foreign-survivors-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await writeFile(
				join(codexDir, "hooks.json"),
				JSON.stringify({
					hooks: {
						UserPromptSubmit: [{ matcher: "[", hooks: [{ type: "command", command: "echo prompt" }] }],
						Stop: [{ matcher: "[", hooks: [{ type: "command", command: "echo stop" }] }],
					},
				}, null, 2) + "\n",
			);

			const res = runOmx(wd, ["doctor"], { HOME: home, CODEX_HOME: codexDir });
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/\[OK\] Native hooks: hooks\.json contains valid foreign hook entries and no OMX-managed wrappers; doctor will preserve the user-owned configuration/,
			);
			assert.doesNotMatch(res.stdout, /hooks\.json discovery warnings/);
			assert.doesNotMatch(res.stdout, /Native hooks:.*--force/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reports unsafe managed removal without recommending destructive repair", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-hooks-unsafe-removal-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await writeFile(
				join(codexDir, "hooks.json"),
				JSON.stringify({
					hooks: {
						SessionStart: [{
							matcher: "startup|resume|clear",
							hooks: [
								{ type: "command", command: 'node "/repo/dist/scripts/codex-native-hook.js"' },
								{ type: "command", command: "echo user-owned" },
							],
						}],
					},
				}, null, 2) + "\n",
			);

			const res = runOmx(wd, ["doctor"], { HOME: home, CODEX_HOME: codexDir });
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/\[!!\] Native hooks: hooks\.json has OMX entries that cannot be safely removed \(unsafe_managed_removal\): Removing OMX hooks would shift a foreign coordinate or discard opaque metadata; manual cleanup is required because doctor will not overwrite or remove it/,
			);
			assert.doesNotMatch(res.stdout, /Native hooks:.*--force/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("fails closed when a Windows native hook references a missing shim", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-windows-shim-missing-"));
		try {
			const codexDir = join(wd, ".codex");
			const hooksPath = join(codexDir, "hooks.json");
			const shimPath = join(codexDir, "hooks", "omx-native-hook-windows-shim.ps1");
			await mkdir(codexDir, { recursive: true });
			const original = buildWindowsShimHooksJson(shimPath, codexDir);
			await writeFile(hooksPath, original);

			const check = await checkNativeHooks(hooksPath, join(codexDir, "config.toml"), {
				codexHomeDir: codexDir,
				platform: "win32",
			});
			assert.equal(check.status, "fail");
			assert.match(check.message, /referenced Windows native hook shim is missing at/);
			assert.match(check.message, /manually reinstall the matching oh-my-codex version/);
			assert.doesNotMatch(check.message, /omx setup|--force/);
			assert.equal(existsSync(shimPath), false);
			assert.equal(await readFile(hooksPath, "utf-8"), original);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("fails closed when a referenced Windows native hook shim is tampered", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-windows-shim-tampered-"));
		try {
			const codexDir = join(wd, ".codex");
			const hooksPath = join(codexDir, "hooks.json");
			const shimPath = join(codexDir, "hooks", "omx-native-hook-windows-shim.ps1");
			await mkdir(dirname(shimPath), { recursive: true });
			const original = buildWindowsShimHooksJson(shimPath, codexDir);
			const tamperedShim = `${buildManagedCodexNativeHookWindowsShimContent(repoRoot())}# user change\n`;
			await writeFile(hooksPath, original);
			await writeFile(shimPath, tamperedShim, "utf-8");

			const check = await checkNativeHooks(hooksPath, join(codexDir, "config.toml"), {
				codexHomeDir: codexDir,
				platform: "win32",
			});
			assert.equal(check.status, "fail");
			assert.match(check.message, /not an exact current or complete historical generated shim/);
			assert.match(check.message, /modified, truncated, have extra content, or use ambiguous encoding/);
			assert.doesNotMatch(check.message, /omx setup|--force/);
			assert.equal(await readFile(hooksPath, "utf-8"), original);
			assert.equal(await readFile(shimPath, "utf-8"), tamperedShim);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("accepts a complete historical Windows native hook shim without modifying it", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-windows-shim-historical-"));
		try {
			const codexDir = join(wd, ".codex");
			const hooksPath = join(codexDir, "hooks.json");
			const shimPath = join(codexDir, "hooks", "omx-native-hook-windows-shim.ps1");
			await mkdir(dirname(shimPath), { recursive: true });
			const original = buildWindowsShimHooksJson(shimPath, codexDir);
			const historicalShim = buildManagedCodexNativeHookWindowsShimContent("", {
				nodePath: "C:\\Historical Node\\node.exe",
				hookScriptPath:
					"C:\\Historical Install\\oh-my-codex\\dist\\scripts\\codex-native-hook.js",
			});
			await writeFile(hooksPath, original);
			await writeFile(shimPath, historicalShim, "utf-8");

			const check = await checkNativeHooks(hooksPath, join(codexDir, "config.toml"), {
				codexHomeDir: codexDir,
				platform: "win32",
			});
			assert.equal(check.status, "pass");
			assert.match(check.message, /includes OMX-managed coverage for all native hook events/);
			assert.equal(await readFile(hooksPath, "utf-8"), original);
			assert.equal(await readFile(shimPath, "utf-8"), historicalShim);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reports Windows shim integrity before an unsafe managed/foreign group coordinate warning", async () => {
		for (const fixture of [
			{
				name: "missing",
				shimContent: null,
				integrity: /referenced Windows native hook shim is missing at/,
			},
			{
				name: "tampered",
				shimContent: `${buildManagedCodexNativeHookWindowsShimContent(repoRoot())}# mixed-group sentinel\n`,
				integrity: /not an exact current or complete historical generated shim/,
			},
		] as const) {
			const wd = await mkdtemp(join(tmpdir(), `omx-doctor-windows-shim-${fixture.name}-unsafe-`));
			try {
				const codexDir = join(wd, ".codex");
				const hooksPath = join(codexDir, "hooks.json");
				const shimPath = join(codexDir, "hooks", "omx-native-hook-windows-shim.ps1");
				const parsed = JSON.parse(buildWindowsShimHooksJson(shimPath, codexDir)) as {
					hooks: Record<string, Array<{ hooks: unknown[] }>>;
				};
				parsed.hooks.PreToolUse![0]!.hooks.push({
					type: "command",
					command: "echo foreign-handler",
				});
				await mkdir(codexDir, { recursive: true });
				await writeFile(hooksPath, `${JSON.stringify(parsed, null, 2)}\n`);
				if (fixture.shimContent !== null) {
					await mkdir(dirname(shimPath), { recursive: true });
					await writeFile(shimPath, fixture.shimContent, "utf-8");
				}

				const check = await checkNativeHooks(hooksPath, join(codexDir, "config.toml"), {
					codexHomeDir: codexDir,
					platform: "win32",
				});
				assert.equal(check.status, "fail", fixture.name);
				assert.match(check.message, fixture.integrity, fixture.name);
				assert.match(check.message, /unsafe_managed_removal/, fixture.name);
				assert.ok(
					check.message.search(fixture.integrity) < check.message.indexOf("unsafe_managed_removal"),
					`${fixture.name} shim integrity must take precedence over the coordinate warning`,
				);
			} finally {
				await rm(wd, { recursive: true, force: true });
			}
		}
	});

	it("never executes missing, tampered, historical, hard-linked, or symlinked Windows shim sentinels during verbose validation", async () => {
		for (const fixture of [
			{
				name: "missing",
				shimContent: null,
				hardLink: false,
				symlinkTarget: null,
				expected: /referenced Windows native hook shim is missing at/,
			},
			{
				name: "tampered",
				shimContent: `${buildManagedCodexNativeHookWindowsShimContent(repoRoot())}# verbose-execution sentinel\n`,
				hardLink: false,
				symlinkTarget: null,
				expected: /not an exact current or complete historical generated shim/,
			},
			{
				name: "historical",
				shimContent: buildManagedCodexNativeHookWindowsShimContent("", {
					nodePath: "C:\\Historical Node\\node.exe",
					hookScriptPath:
						"C:\\Historical Install\\oh-my-codex\\dist\\scripts\\codex-native-hook.js",
				}),
				hardLink: false,
				symlinkTarget: null,
				expected: /complete historical generated shim.*run "omx setup" to migrate/,
			},
			{
				name: "hard-linked",
				shimContent: buildManagedCodexNativeHookWindowsShimContent(repoRoot()),
				hardLink: true,
				symlinkTarget: null,
				expected: /is hard-linked; doctor will not execute or modify it/,
			},
			{
				name: "symlinked",
				shimContent: null,
				hardLink: false,
				symlinkTarget: buildManagedCodexNativeHookWindowsShimContent(repoRoot()),
				expected: /is not a regular file; doctor will not follow or modify it/,
			},
		] as const) {
			const wd = await mkdtemp(join(tmpdir(), `omx-doctor-verbose-windows-shim-${fixture.name}-`));
			try {
				const codexDir = join(wd, ".codex");
				const hooksPath = join(codexDir, "hooks.json");
				const shimPath = join(codexDir, "hooks", "omx-native-hook-windows-shim.ps1");
				const command = buildWindowsShimCommand(shimPath);
				await mkdir(codexDir, { recursive: true });
				await writeFile(hooksPath, buildWindowsShimHooksJson(shimPath, codexDir));
				if (fixture.symlinkTarget !== null) {
					const symlinkTargetPath = join(wd, "symlink-target.ps1");
					await mkdir(dirname(shimPath), { recursive: true });
					await writeFile(symlinkTargetPath, fixture.symlinkTarget, "utf-8");
					await symlink(symlinkTargetPath, shimPath);
				} else if (fixture.shimContent !== null) {
					await mkdir(dirname(shimPath), { recursive: true });
					await writeFile(shimPath, fixture.shimContent, "utf-8");
					if (fixture.hardLink) {
						await link(shimPath, join(wd, "canonical-shim-hardlink.ps1"));
					}
				}

				let spawned = false;
				const check = await checkNativePostCompactHookRuntime(hooksPath, wd, codexDir, {
					platform: "win32",
					expectedCommand: command,
					runner: (() => {
						spawned = true;
						throw new Error("unverified Windows shim execution");
					}) as unknown as typeof spawnSync,
				});
				assert.equal(spawned, false, `${fixture.name} shim executed`);
				assert.ok(check, `${fixture.name} shim must produce a safety diagnostic`);
				assert.notEqual(check.status, "pass", fixture.name);
				assert.match(check.message, fixture.expected, fixture.name);
			} finally {
				await rm(wd, { recursive: true, force: true });
			}
		}
	});

	it("runs exact current Windows shim bytes in memory after canonical replacement, hard-linking, and ancestor retargeting", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-verbose-windows-shim-in-memory-"));
		try {
			const codexDir = join(wd, ".codex");
			const hooksPath = join(codexDir, "hooks.json");
			const hooksDir = join(codexDir, "hooks");
			const shimPath = join(hooksDir, "omx-native-hook-windows-shim.ps1");
			const command = buildWindowsShimCommand(shimPath);
			const currentShim = buildManagedCodexNativeHookWindowsShimContent(repoRoot());
			const sentinel = "# foreign canonical shim sentinel\n";
			const foreignHooksDir = join(codexDir, "foreign-hooks");
			const foreignShimPath = join(foreignHooksDir, "omx-native-hook-windows-shim.ps1");
			const foreignHardLinkPath = join(foreignHooksDir, "foreign-shim-hard-link.ps1");
			await mkdir(hooksDir, { recursive: true });
			await writeFile(hooksPath, buildWindowsShimHooksJson(shimPath, codexDir));
			await writeFile(shimPath, currentShim, "utf-8");

			const check = await checkNativePostCompactHookRuntime(hooksPath, wd, codexDir, {
				platform: "win32",
				expectedCommand: command,
				beforeWindowsShimSmoke: async () => {
					const parkedHooksDir = join(codexDir, "validated-hooks");
					await rename(hooksDir, parkedHooksDir);
					await mkdir(foreignHooksDir, { recursive: true });
					await writeFile(foreignShimPath, sentinel);
					await link(foreignShimPath, foreignHardLinkPath);
					await symlink(foreignHooksDir, hooksDir, "dir");
				},
				runner: ((_command: string, args: readonly string[]) => {
					const encodedCommand = args[args.indexOf("-EncodedCommand") + 1];
					if (typeof encodedCommand !== "string") {
						throw new Error("PowerShell smoke must receive an encoded in-memory command");
					}
					assert.doesNotMatch(args.join("\u0000"), /(?:^|\u0000)-File(?:\u0000|$)/);
					const smokeCommand = Buffer.from(encodedCommand, "base64").toString("utf16le");
					assert.doesNotMatch(smokeCommand, /(?:^|\s)-File(?:\s|$)/);
					assert.equal(smokeCommand.includes(shimPath), false);
					assert.match(smokeCommand, /\[ScriptBlock\]::Create\(\$omxShimSource\)/);
					const encodedShimBytes = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(smokeCommand)?.[1];
					if (encodedShimBytes === undefined) {
						throw new Error("encoded PowerShell smoke command omitted validated shim bytes");
					}
					assert.deepEqual(Buffer.from(encodedShimBytes, "base64"), Buffer.from(currentShim, "utf-8"));
					assert.equal(readFileSync(shimPath, "utf-8"), sentinel);
					assert.equal(readFileSync(foreignHardLinkPath, "utf-8"), sentinel);
					return { status: 0, stdout: "", stderr: "" };
				}) as unknown as typeof spawnSync,
			});

			assert.equal(check?.status, "pass");
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves a swapped Windows PostCompact smoke root instead of recursively deleting it", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-verbose-windows-smoke-root-"));
		let foreignSmokeCwd: string | null = null;
		let parkedSmokeCwd: string | null = null;
		try {
			const codexDir = join(wd, ".codex");
			const hooksPath = join(codexDir, "hooks.json");
			const hooksDir = join(codexDir, "hooks");
			const shimPath = join(hooksDir, "omx-native-hook-windows-shim.ps1");
			const command = buildWindowsShimCommand(shimPath);
			await mkdir(hooksDir, { recursive: true });
			await writeFile(hooksPath, buildWindowsShimHooksJson(shimPath, codexDir));
			await writeFile(shimPath, buildManagedCodexNativeHookWindowsShimContent(repoRoot()), "utf-8");

			const check = await checkNativePostCompactHookRuntime(hooksPath, wd, codexDir, {
				platform: "win32",
				expectedCommand: command,
				beforeWindowsShimSmoke: ({ smokeCwd }) => {
					foreignSmokeCwd = smokeCwd;
				},
				runner: (() => {
					const currentSmokeCwd = foreignSmokeCwd;
					if (currentSmokeCwd === null) {
						throw new Error("Windows smoke root was not captured before execution");
					}
					parkedSmokeCwd = `${currentSmokeCwd}-parked`;
					renameSync(currentSmokeCwd, parkedSmokeCwd);
					mkdirSync(currentSmokeCwd, { mode: 0o700 });
					writeFileSync(join(currentSmokeCwd, "foreign-sentinel.txt"), "foreign smoke root\n");
					return { status: 0, stdout: "", stderr: "" };
				}) as unknown as typeof spawnSync,
			});

			assert.equal(check?.status, "warn");
			assert.match(check?.message ?? "", /temporary PostCompact smoke directory changed during validation/);
			if (foreignSmokeCwd === null) assert.fail("Windows smoke root was not captured");
			assert.equal(readFileSync(join(foreignSmokeCwd, "foreign-sentinel.txt"), "utf-8"), "foreign smoke root\n");
		} finally {
			if (foreignSmokeCwd !== null) await rm(foreignSmokeCwd, { recursive: true, force: true });
			if (parkedSmokeCwd !== null) await rm(parkedSmokeCwd, { recursive: true, force: true });
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves a failed PostCompact smoke result when cleanup retains the smoke directory", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-postcompact-smoke-cleanup-failure-"));
		let smokeCwd: string | null = null;
		try {
			const codexDir = join(wd, ".codex");
			const hooksPath = join(codexDir, "hooks.json");
			const hooksDir = join(codexDir, "hooks");
			const shimPath = join(hooksDir, "omx-native-hook-windows-shim.ps1");
			const command = buildWindowsShimCommand(shimPath);
			await mkdir(hooksDir, { recursive: true });
			await writeFile(hooksPath, buildWindowsShimHooksJson(shimPath, codexDir));
			await writeFile(shimPath, buildManagedCodexNativeHookWindowsShimContent(repoRoot()), "utf-8");

			const check = await checkNativePostCompactHookRuntime(hooksPath, wd, codexDir, {
				platform: "win32",
				expectedCommand: command,
				beforeWindowsShimSmoke: ({ smokeCwd: currentSmokeCwd }) => {
					smokeCwd = currentSmokeCwd;
				},
				runner: (() => {
					if (smokeCwd === null) {
						throw new Error("Windows smoke root was not captured before execution");
					}
					writeFileSync(join(smokeCwd, "retained-sentinel.txt"), "retained smoke root\n");
					return { status: 1, stdout: "", stderr: "hook failure" };
				}) as unknown as typeof spawnSync,
			});

			assert.equal(check?.status, "fail");
			assert.match(check?.message ?? "", /PostCompact hook smoke validation exited 1: hook failure/);
			assert.match(check?.message ?? "", /temporary PostCompact smoke directory could not be removed without recursive deletion/);
			if (smokeCwd === null) assert.fail("Windows smoke root was not captured");
			assert.equal(readFileSync(join(smokeCwd, "retained-sentinel.txt"), "utf-8"), "retained smoke root\n");
		} finally {
			if (smokeCwd !== null) await rm(smokeCwd, { recursive: true, force: true });
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves a thrown PostCompact smoke error when cleanup also fails", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-postcompact-smoke-thrown-cleanup-"));
		let smokeCwd: string | null = null;
		try {
			const codexDir = join(wd, ".codex");
			const hooksPath = join(codexDir, "hooks.json");
			const hooksDir = join(codexDir, "hooks");
			const shimPath = join(hooksDir, "omx-native-hook-windows-shim.ps1");
			const command = buildWindowsShimCommand(shimPath);
			await mkdir(hooksDir, { recursive: true });
			await writeFile(hooksPath, buildWindowsShimHooksJson(shimPath, codexDir));
			await writeFile(shimPath, buildManagedCodexNativeHookWindowsShimContent(repoRoot()), "utf-8");

			await assert.rejects(
				checkNativePostCompactHookRuntime(hooksPath, wd, codexDir, {
					platform: "win32",
					expectedCommand: command,
					beforeWindowsShimSmoke: ({ smokeCwd: currentSmokeCwd }) => {
						smokeCwd = currentSmokeCwd;
					},
					runner: (() => {
						if (smokeCwd === null) throw new Error("Windows smoke root was not captured before execution");
						writeFileSync(join(smokeCwd, "retained-sentinel.txt"), "retained smoke root\n");
						throw new Error("primary spawn failure");
					}) as unknown as typeof spawnSync,
				}),
				/primary spawn failure; temporary PostCompact smoke directory could not be removed without recursive deletion/,
			);
		} finally {
			if (smokeCwd !== null) await rm(smokeCwd, { recursive: true, force: true });
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reports exact nested legacy hook trust state as migration-required without modifying hooks.json", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-hooks-legacy-trust-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			const parsed = JSON.parse(
				buildHooksJsonWithPostCompactCommand(currentNativeHookCommand(codexDir), codexDir),
			) as { hooks: Record<string, unknown> };
			parsed.hooks.state = {
				"custom:/hooks.json:stop:0:0": {
					trusted_hash: "sha256:legacy",
					enabled: false,
				},
			};
			const hooksPath = join(codexDir, "hooks.json");
			const original = `${JSON.stringify(parsed, null, 2)}\n`;
			await writeFile(hooksPath, original);

			const res = runOmx(wd, ["doctor"], { HOME: home, CODEX_HOME: codexDir });
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/\[!!\] Native hooks: hooks\.json contains 1 exact historical OMX hook trust-state entry that requires migration; run "omx setup" to migrate it after reviewing the configuration/,
			);
			assert.doesNotMatch(res.stdout, /Native hooks: hooks\.json includes OMX-managed coverage/);
			assert.doesNotMatch(res.stdout, /Native hooks:.*--force/);
			assert.equal(await readFile(hooksPath, "utf-8"), original);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves nonmatching nested hooks.state without reporting a migration", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-hooks-nonlegacy-state-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			const parsed = JSON.parse(
				buildHooksJsonWithPostCompactCommand(currentNativeHookCommand(codexDir), codexDir),
			) as { hooks: Record<string, unknown> };
			parsed.hooks.state = {
				retained: { custom: true, trusted_hash: "sha256:not-omx" },
			};
			const hooksPath = join(codexDir, "hooks.json");
			const original = `${JSON.stringify(parsed, null, 2)}\n`;
			await writeFile(hooksPath, original);

			const res = runOmx(wd, ["doctor"], { HOME: home, CODEX_HOME: codexDir });
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/\[OK\] Native hooks: hooks\.json includes OMX-managed coverage for all native hook events/,
			);
			assert.doesNotMatch(res.stdout, /Native hooks:.*legacy OMX hook trust-state/);
			assert.equal(await readFile(hooksPath, "utf-8"), original);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("verbose doctor warns instead of executing when the effective PostCompact command is stale", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-postcompact-stale-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await writeFile(join(codexDir, "config.toml"), "omx_enabled = true\n");
			await writeFile(
				join(codexDir, "hooks.json"),
				buildHooksJsonWithPostCompactCommand(
					`${quoteCommandPart(process.execPath)} ${quoteCommandPart(join(wd, "old", "dist", "scripts", "codex-native-hook.js"))}`,
					codexDir,
				),
			);

			const res = runOmx(wd, ["doctor", "--verbose"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Native hooks: hooks\.json includes OMX-managed coverage for all native hook events/,
			);
			assert.match(
				res.stdout,
				/\[!!\] Native PostCompact hook: effective PostCompact OMX command does not match this installation's managed hook command; doctor skipped execution for safety/,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("classifies invalid or unsupported PostCompact stdout as a verbose doctor failure", () => {
		const invalidJson = classifyPostCompactHookStdout("{not json");
		assert.equal(invalidJson?.status, "fail");
		assert.match(invalidJson?.message ?? "", /invalid JSON stdout/);

		const unsupportedJson = classifyPostCompactHookStdout(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PostCompact",
					additionalContext: "stale nudge",
				},
			}),
		);
		assert.equal(unsupportedJson?.status, "fail");
		assert.match(unsupportedJson?.message ?? "", /must emit no stdout/);
	});

	it("routes Windows PostCompact smoke validation through PowerShell -Command", () => {
		const expectedCommand =
			"& 'C:\\Program Files\\PowerShell\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File 'C:\\Users\\Ada Lovelace\\.codex\\hooks\\omx-native-hook-windows-shim.ps1'";
		const invocation = buildPostCompactSmokeSpawnInvocation(expectedCommand, {
			platform: "win32",
			env: { SystemRoot: "C:\\Windows" },
		});

		assert.equal(
			invocation.command,
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		);
		assert.deepEqual(invocation.args, [
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			expectedCommand,
		]);
		assert.equal(invocation.shell, false);
	});

	it("verbose doctor smoke-validates the current PostCompact command with no stdout", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-postcompact-current-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await writeFile(join(codexDir, "config.toml"), "omx_enabled = true\n");
			await writeFile(
				join(codexDir, "hooks.json"),
				buildHooksJsonWithPostCompactCommand(
					currentNativeHookCommand(codexDir),
					codexDir,
				),
			);

			const res = runOmx(wd, ["doctor", "--verbose"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/\[OK\] Native PostCompact hook: verbose smoke validation confirmed the effective PostCompact hook exits successfully with no stdout/,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("doctor smoke-validates the installed native hook dist script by default", async () => {
		const check = await checkNativeHookDistSmoke();

		assert.equal(check.name, "Native hook dist smoke");
		assert.equal(check.status, "pass");
		assert.match(
			check.message,
			/installed dist\/scripts\/codex-native-hook\.js parsed and accepted a minimal UserPromptSubmit payload/,
		);
	});

	it("doctor reports reinstall guidance when the installed native hook dist script fails to parse", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-native-hook-dist-fail-"));
		try {
			const distScriptsDir = join(wd, "dist", "scripts");
			await mkdir(distScriptsDir, { recursive: true });
			await writeFile(join(wd, "package.json"), JSON.stringify({ version: "0.18.0" }));
			await writeFile(join(distScriptsDir, "codex-native-hook.js"), "export const broken = ;\n");

			const check = await checkNativeHookDistSmoke({
				packageRoot: wd,
				runner: ((cmd, args, options) => spawnSync(cmd, args, options)) as typeof spawnSync,
			});

			assert.equal(check.name, "Native hook dist smoke");
			assert.equal(check.status, "fail");
			assert.match(check.message, /minimal UserPromptSubmit smoke/);
			assert.match(check.message, /reinstall the matching oh-my-codex version/);
			assert.doesNotMatch(check.message, /--force/);
			assert.match(check.message, /run "omx setup"/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("passes when legacy skill root is a link to the canonical skills directory", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-skill-link-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			const canonicalSkillsRoot = join(codexDir, "skills");
			const canonicalHelp = join(canonicalSkillsRoot, "help");
			const legacyRoot = join(home, ".agents", "skills");
			await mkdir(canonicalHelp, { recursive: true });
			await mkdir(join(home, ".agents"), { recursive: true });
			await writeFile(join(canonicalHelp, "SKILL.md"), "# canonical help\n");
			await symlink(
				canonicalSkillsRoot,
				legacyRoot,
				process.platform === "win32" ? "junction" : "dir",
			);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Legacy skill roots: ~\/\.agents\/skills links to canonical .*\.codex[\\/]+skills; treating both paths as one shared skill root/,
			);
			assert.doesNotMatch(res.stdout, /\[!!\] Legacy skill roots:/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("reports retained and custom GPT-5.6 multi-agent settings without diagnosing a clean config", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-multi-agent-"));
		try {
			const cleanPath = join(wd, "clean.toml");
			await writeFile(cleanPath, 'model = "gpt-5.6"\n');
			assert.equal(
				await checkLegacyMultiAgentCompatibility(cleanPath, "user"),
				null,
			);

			const userPath = join(wd, "user.toml");
			await writeFile(
				userPath,
				"[features]\nmulti_agent = true\n\n[agents]\nmax_threads = 6\nmax_depth = 2\n",
			);
			const userCheck = await checkLegacyMultiAgentCompatibility(userPath, "user");
			assert.ok(userCheck);
			assert.equal(userCheck.name, "GPT-5.6 multi-agent compatibility");
			assert.equal(userCheck.status, "warn");
			assert.match(userCheck.message, new RegExp(`user scope config at ${userPath}`));
			assert.match(userCheck.message, /features\.multi_agent \(retained-legacy; exact-legacy-value\)/);
			assert.match(userCheck.message, /agents\.max_threads \(retained-legacy; exact-legacy-value\)/);
			assert.match(userCheck.message, /agents\.max_depth \(retained-legacy; exact-legacy-value\)/);
			assert.match(userCheck.message, /historical ownership cannot be proven/);
			assert.match(userCheck.message, /remove only keys you confirm OMX authored/);
			assert.match(userCheck.message, /omx setup --scope user/);
			assert.match(userCheck.message, /Setup does not auto-delete them/);

			const projectPath = join(wd, "project.toml");
			await writeFile(projectPath, "[agents]\nmax_threads = 8\n");
			const projectCheck = await checkLegacyMultiAgentCompatibility(projectPath, "project");
			assert.ok(projectCheck);
			assert.match(projectCheck.message, new RegExp(`project scope config at ${projectPath}`));
			assert.match(projectCheck.message, /agents\.max_threads \(custom; custom-value\)/);
			assert.doesNotMatch(projectCheck.message, /All checks passed/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reports project-scoped custom values once through the full doctor command", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-project-multi-agent-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(wd, ".codex");
			await mkdir(home, { recursive: true });
			await mkdir(codexDir, { recursive: true });
			await mkdir(join(wd, ".omx"), { recursive: true });
			await writeFile(
				join(wd, ".omx", "setup-scope.json"),
				`${JSON.stringify({ scope: "project" }, null, 2)}\n`,
			);
			const configPath = join(codexDir, "config.toml");
			await writeFile(
				configPath,
				"[features]\nmulti_agent = false\n\n[agents]\nmax_threads = 17\nmax_depth = 5\n",
			);

			const res = runOmx(wd, ["doctor"], { HOME: home });
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(
				res.stdout,
				/Resolved setup scope: project \(from \.omx\/setup-scope\.json\)/,
			);
			assert.equal(
				res.stdout.match(/\[!!\] GPT-5\.6 multi-agent compatibility:/g)?.length,
				1,
			);
			assert.match(res.stdout, new RegExp(`project scope config at ${join(await realpath(wd), ".codex", "config.toml")}`));
			assert.match(res.stdout, /features\.multi_agent \(custom; custom-value\)/);
			assert.match(res.stdout, /agents\.max_threads \(custom; custom-value\)/);
			assert.match(res.stdout, /agents\.max_depth \(custom; custom-value\)/);
			assert.match(res.stdout, /historical ownership cannot be proven/);
			assert.match(res.stdout, /remove only keys you confirm OMX authored/);
			assert.match(res.stdout, /omx setup --scope project/);
			assert.match(res.stdout, /Setup does not auto-delete them/);
			assert.match(res.stdout, /Results: \d+ passed, [1-9]\d* warnings, \d+ failed/);
			assert.doesNotMatch(res.stdout, /All checks passed!/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("counts the multi-agent compatibility warning and suppresses the all-clear footer", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-multi-agent-footer-"));
		try {
			const home = join(wd, "home");
			const codexDir = join(home, ".codex");
			await mkdir(codexDir, { recursive: true });
			await writeFile(
				join(codexDir, "config.toml"),
				"[features]\nmulti_agent = true\n",
			);

			const res = runOmx(wd, ["doctor"], {
				HOME: home,
				CODEX_HOME: codexDir,
			});
			if (shouldSkipForSpawnPermissions(res.error)) return;
			assert.equal(res.status, 0, res.stderr || res.stdout);
			assert.match(res.stdout, /\[!!\] GPT-5\.6 multi-agent compatibility:/);
			assert.match(res.stdout, /Results: \d+ passed, [1-9]\d* warnings, \d+ failed/);
			assert.doesNotMatch(res.stdout, /All checks passed!/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
	it("validates an existing global hooks.json before reporting plugin-cache status", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-plugin-global-invalid-"));
		try {
			const codexDir = join(wd, ".codex");
			const configPath = join(codexDir, "config.toml");
			const hooksPath = join(codexDir, "hooks.json");
			await mkdir(codexDir, { recursive: true });
			await writeFile(configPath, "plugin_hooks = true\n");
			await writeFile(hooksPath, '{"state":{}}\n');

			const check = await checkNativeHooks(hooksPath, configPath, {
				codexHomeDir: codexDir,
				installMode: "plugin",
			});

			assert.equal(check.status, "fail");
			assert.match(check.message, /plugin-scoped hooks are enabled/);
			assert.match(check.message, /existing global hooks\.json: hooks\.json failed strict load validation/);
			assert.match(check.message, /unknown root field state/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("fails plugin mode when an existing global Windows shim is tampered", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-plugin-global-shim-"));
		try {
			const codexDir = join(wd, ".codex");
			const configPath = join(codexDir, "config.toml");
			const hooksPath = join(codexDir, "hooks.json");
			const shimPath = join(codexDir, "hooks", "omx-native-hook-windows-shim.ps1");
			await mkdir(dirname(shimPath), { recursive: true });
			await writeFile(configPath, "plugin_hooks = true\n");
			await writeFile(
				hooksPath,
				`${JSON.stringify({
					hooks: {
						PostCompact: [{ hooks: [{ type: "command", command: buildWindowsShimCommand(shimPath) }] }],
					},
				})}\n`,
			);
			await writeFile(shimPath, "# modified\n");

			const check = await checkNativeHooks(hooksPath, configPath, {
				codexHomeDir: codexDir,
				installMode: "plugin",
				platform: "win32",
			});

			assert.equal(check.status, "fail");
			assert.match(check.message, /not an exact current or complete historical generated shim/);
			assert.match(check.message, /plugin-scoped hooks are enabled/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("fails ambiguous managed handler ownership instead of downgrading it to a warning", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-ambiguous-managed-handler-"));
		try {
			const codexDir = join(wd, ".codex");
			const hooksPath = join(codexDir, "hooks.json");
			await mkdir(codexDir, { recursive: true });
			await writeFile(
				hooksPath,
				`${JSON.stringify({
					hooks: {
						SessionStart: [{
							matcher: "startup|resume|clear",
							hooks: [{ type: "command", command: "node /repo/dist/scripts/codex-native-hook.js --unexpected" }],
						}],
					},
				})}\n`,
			);

			const check = await checkNativeHooks(hooksPath, join(codexDir, "config.toml"), {
				codexHomeDir: codexDir,
			});

			assert.equal(check.status, "fail");
			assert.match(check.message, /ambiguous_managed_handler/);
			assert.match(check.message, /ambiguous or untrusted OMX ownership/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("fails closed instead of recognizing a shell-expanding foreign command as an OMX hook", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-shell-expanding-handler-"));
		try {
			const codexDir = join(wd, ".codex");
			const hooksPath = join(codexDir, "hooks.json");
			await mkdir(codexDir, { recursive: true });
			await writeFile(
				hooksPath,
				`${JSON.stringify({
					hooks: {
						SessionStart: [{
							matcher: "startup|resume|clear",
							hooks: [{ type: "command", command: 'node "$HOME/repo/dist/scripts/codex-native-hook.js"' }],
						}],
					},
				})}\n`,
			);

			const check = await checkNativeHooks(hooksPath, join(codexDir, "config.toml"), {
				codexHomeDir: codexDir,
			});
			assert.equal(check.status, "fail");
			assert.match(check.message, /ambiguous_managed_handler|does not match the managed command grammar/i);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("ignores prompt, agent, and future-event metadata while scanning Windows shim references", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-inert-shim-metadata-"));
		try {
			const codexDir = join(wd, ".codex");
			const hooksPath = join(codexDir, "hooks.json");
			const missingShimPath = join(codexDir, "hooks", "omx-native-hook-windows-shim.ps1");
			await mkdir(codexDir, { recursive: true });
			await writeFile(
				hooksPath,
				`${JSON.stringify({
					hooks: {
						PostCompact: [{ hooks: [
							{ type: "prompt", command: buildWindowsShimCommand(missingShimPath) },
							{ type: "agent", commandWindows: buildWindowsShimCommand(missingShimPath) },
						] }],
						FutureSerdeEvent: [{ hooks: [{ type: "command", command: buildWindowsShimCommand(missingShimPath) }] }],
					},
				})}\n`,
			);

			const check = await checkNativeHooks(hooksPath, join(codexDir, "config.toml"), {
				codexHomeDir: codexDir,
				platform: "win32",
			});

			assert.equal(check.status, "warn");
			assert.match(check.message, /hooks\.json discovery warnings/);
			assert.doesNotMatch(check.message, /referenced Windows native hook shim/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("recovers a claim journal after Windows regular-file EPERM with one degraded-durability warning", async () => {
		const originalStderrWrite = process.stderr.write;
		const stderr: string[] = [];
		try {
			await withRecoverableDoctorClaimJournal(async (codexHomeDir) => {
				const restoreDurability = setDoctorClaimJournalDurabilityForTest({
					platform: "win32",
					syncRegularFile: async () => syncRegularFile({
						sync: async () => {
							throw Object.assign(new Error("injected Windows EPERM"), { code: "EPERM" });
						},
					}, "win32"),
					syncDirectory: async () => undefined,
				});
				process.stderr.write = ((chunk: string | Uint8Array) => {
					stderr.push(String(chunk));
					return true;
				}) as typeof process.stderr.write;
				try {
					await doctor();
					assert.equal(await readFile(join(codexHomeDir, "hooks.json"), "utf-8"), "{\"hooks\":{}}\n");
					await assert.rejects(
						readFile(join(codexHomeDir, ".omx", "native-hook-claim-journal.json")),
						/ENOENT/,
					);
				} finally {
					restoreDurability();
				}
			});
			assert.equal(stderr.length, 1);
			assert.match(stderr[0]!, /Windows EPERM/);
			assert.match(stderr[0]!, /native-hook claim-journal recovery/);
			assert.match(stderr[0]!, /degraded durability/);
		} finally {
			process.stderr.write = originalStderrWrite;
		}
	});

	it("keeps non-EPERM regular-file and directory claim-journal sync failures fatal", async () => {
		const regularError = Object.assign(new Error("injected regular-file EIO"), { code: "EIO" });
		await withRecoverableDoctorClaimJournal(async () => {
			const restoreDurability = setDoctorClaimJournalDurabilityForTest({
				platform: "win32",
				syncRegularFile: async () => { throw regularError; },
				syncDirectory: async () => undefined,
			});
			try {
				await assert.rejects(doctor(), (error) => error === regularError);
			} finally {
				restoreDurability();
			}
		});

		const directoryError = Object.assign(new Error("injected directory EPERM"), { code: "EPERM" });
		await withRecoverableDoctorClaimJournal(async () => {
			const restoreDurability = setDoctorClaimJournalDurabilityForTest({
				platform: "win32",
				syncRegularFile: async () => "synced",
				syncDirectory: async () => { throw directoryError; },
			});
			try {
				await assert.rejects(doctor(), (error) => error === directoryError);
			} finally {
				restoreDurability();
			}
		});
	});
});
