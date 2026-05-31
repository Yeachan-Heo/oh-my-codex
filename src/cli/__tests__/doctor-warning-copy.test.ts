import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	withPackagedExploreHarnessHidden,
	withPackagedExploreHarnessLock,
} from "./packaged-explore-harness-lock.js";
import {
	checkExploreHarness,
	checkNativeHookDistSmoke,
	classifyPostCompactHookStdout,
} from "../doctor.js";
import { buildManagedCodexNativeHookCommand } from "../../config/codex-hooks.js";

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
): string {
	const expectedCommand = currentNativeHookCommand(codexHomeDir);
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

describe("omx doctor onboarding warning copy", () => {
	it("warns that the built-in explore harness is not ready on Windows", () => {
		const check = checkExploreHarness("win32", {} as NodeJS.ProcessEnv);

		assert.equal(check.name, "Explore Harness");
		assert.equal(check.status, "warn");
		assert.match(check.message, /not ready on Windows/i);
		assert.match(check.message, /OMX_EXPLORE_BIN/);
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
					`\\[!!\\] Native hooks: plugin-scoped hooks are enabled, but cached plugin hook files or pinned hook launcher in ${cacheDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} do not match the packaged plugin; setup-owned hooks\\.json is intentionally absent at .*\\.codex[\\/]+hooks\\.json; run "omx setup --plugin --force" to refresh the plugin cache`,
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
					`\\[OK\\] Native hooks: plugin-scoped hooks are enabled; existing hooks\\.json at .*\\.codex[\\/]+hooks\\.json is treated as user-owned because plugin-scoped hooks are enabled, and plugin cache native hook coverage smoke passed via ${join(cacheDir, "hooks", "hooks.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
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
				/Native hooks: hooks\.json is missing OMX-managed coverage for PreToolUse, PostToolUse, UserPromptSubmit, PreCompact, PostCompact, Stop; run "omx setup --force" to restore native hooks/,
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
				/Native hooks: expected setup-owned hooks\.json is missing at .*\.codex[\/]+hooks\.json even though config\.toml has OMX entries; run "omx setup --force" to restore native hook coverage/,
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
				/\[XX\] Native hooks: invalid hooks\.json; Codex may skip OMX hook coverage until "omx setup --force" repairs it/,
			);
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
			assert.match(
				check.message,
				/npm install -g oh-my-codex@0\.18\.0 --force --min-release-age=0 --before=/,
			);
			assert.match(check.message, /omx setup --force/);
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
});
