import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { once } from "node:events";
import {
	computeOmxPluginCacheClaimDigest,
	materializePackagedOmxPluginCache,
	omxPluginCacheBase,
	registerOmxPluginCacheLivePin,
	resolvePackagedOmxMarketplace,
	retireUnpinnedManagedSnapshots,
	setPluginCacheMutationHooksForTest,
} from "../plugin-marketplace.js";

const packageRoot = process.cwd();

async function withIsolatedUserHome<T>(
	wd: string,
	run: (codexHomeDir: string) => Promise<T>,
): Promise<T> {
	const previousHome = process.env.HOME;
	const previousCodexHome = process.env.CODEX_HOME;
	const homeDir = join(wd, "home");
	const codexHomeDir = join(homeDir, ".codex");
	await mkdir(codexHomeDir, { recursive: true });
	process.env.HOME = homeDir;
	process.env.CODEX_HOME = codexHomeDir;
	try {
		return await run(codexHomeDir);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = previousCodexHome;
	}
}

async function seedManagedSnapshot(
	codexHomeDir: string,
	version: string,
): Promise<string> {
	const cacheDir = join(omxPluginCacheBase(codexHomeDir), version);
	await mkdir(dirname(cacheDir), { recursive: true });
	await cp(join(packageRoot, "plugins", "oh-my-codex"), cacheDir, {
		recursive: true,
	});
	const manifestPath = join(cacheDir, ".codex-plugin", "plugin.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as Record<
		string,
		unknown
	>;
	manifest.version = version;
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	await writeFile(
		join(cacheDir, "hooks", "omx-command.json"),
		`${JSON.stringify({
			command: process.execPath,
			argsPrefix: [join(packageRoot, "dist", "cli", "omx.js")],
		})}\n`,
	);
	await writeFile(join(cacheDir, ".omx-managed"), "managed\n");
	const claimDigest = await computeOmxPluginCacheClaimDigest(cacheDir);
	await writeFile(
		join(cacheDir, ".omx-complete"),
		`${JSON.stringify({ version, claimDigest })}\n`,
	);
	return cacheDir;
}

async function markAsPrePinManagedSnapshot(
	cacheDir: string,
	version: string,
	markerFormat: "legacy-record" | "legacy-pid",
): Promise<void> {
	const marker = markerFormat === "legacy-record"
		? `${JSON.stringify({ version: 1, cacheVersion: version, pid: process.pid, processStartHash: null })}\n`
		: `${process.pid}\n`;
	await writeFile(join(cacheDir, ".omx-managed"), marker);
	const claimDigest = await computeOmxPluginCacheClaimDigest(cacheDir);
	await writeFile(join(cacheDir, ".omx-complete"), `${JSON.stringify({ version, claimDigest })}\n`);
}

async function writeDeadLivePin(cacheDir: string): Promise<void> {
	const markerDir = join(cacheDir, ".omx-live-pin");
	await mkdir(markerDir, { recursive: true });
	const record = {
		version: 1,
		pid: 99_999_999,
		processStartHash: null,
		sessionHash: createHash("sha256").update("dead-session").digest("hex"),
	};
	await writeFile(join(markerDir, "dead.json"), `${JSON.stringify(record)}\n`);
}

function livePinMutationLockPath(codexHomeDir: string, version: string): string {
	const versionHash = createHash("sha256").update(version).digest("hex").slice(0, 24);
	return join(omxPluginCacheBase(codexHomeDir), `.omx-live-pin-${versionHash}.lock`);
}

function livePinIntentPath(codexHomeDir: string, version: string, sessionId: string): string {
	const versionHash = createHash("sha256").update(version).digest("hex").slice(0, 24);
	const sessionHash = createHash("sha256").update(sessionId).digest("hex");
	return join(omxPluginCacheBase(codexHomeDir), `.omx-live-pin-intent-${versionHash}-${sessionHash}.json`);
}

async function writeLivePinMutationLock(
	codexHomeDir: string,
	version: string,
	ownerPid: number,
	operation: "pin" | "retire",
	withStageLink = false,
): Promise<{ path: string; stagePath: string; content: string }> {
	const path = livePinMutationLockPath(codexHomeDir, version);
	const token = "11111111-1111-4111-8111-111111111111";
	const content = `${JSON.stringify({ version: 1, pid: ownerPid, operation, token })}\n`;
	const stagePath = `${path}.stage-${ownerPid}-${token}`;
	if (withStageLink) {
		await writeFile(stagePath, content);
		await link(stagePath, path);
	} else {
		await writeFile(path, content);
	}
	return { path, stagePath, content };
}

async function assertDelegateSurvivesLostLeasesWithPin(
	wd: string,
	codexHomeDir: string,
	pluginRoot: string,
	sessionId: string,
	launchId: string,
	pinName: string,
	pinContent: string,
): Promise<string> {
	const pinDirectory = join(pluginRoot, ".omx-live-pin");
	await mkdir(pinDirectory, { recursive: true });
	const pinPath = join(pinDirectory, pinName);
	await writeFile(pinPath, pinContent);
	const delegateStartedPath = join(wd, `${launchId}-delegate-started`);
	const delegateStoppedPath = join(wd, `${launchId}-delegate-stopped`);
	const delegateFinishedPath = join(wd, `${launchId}-delegate-finished`);
	const delegateDonePath = join(wd, `${launchId}-delegate-done`);
	const delegatePath = join(wd, `${launchId}-delegate.mjs`);
	await writeFile(delegatePath, `
import { existsSync, writeFileSync } from "node:fs";
writeFileSync(process.env.OMX_TEST_DELEGATE_STARTED, "started");
process.on("SIGTERM", () => {
  writeFileSync(process.env.OMX_TEST_DELEGATE_STOPPED, "stopped");
  process.exit(1);
});
const timer = setInterval(() => {
  if (!existsSync(process.env.OMX_TEST_DELEGATE_FINISHED)) return;
  clearInterval(timer);
  writeFileSync(process.env.OMX_TEST_DELEGATE_DONE, "completed");
  process.stdout.write("{}\\n");
  process.exit(0);
}, 10);
process.stdin.resume();
`);
	await writeFile(
		join(pluginRoot, "hooks", "omx-command.json"),
		`${JSON.stringify({ command: process.execPath, argsPrefix: [delegatePath] })}\n`,
	);
	const routingPath = join(wd, "state", "plugin-hook-routing", `${launchId}.json`);
	await mkdir(dirname(routingPath), { recursive: true });
	await writeFile(
		routingPath,
		`${JSON.stringify({ routing: "omx-plugin-hook-routing-only:v1", ownerSessionId: sessionId })}\n`,
	);
	const versionHash = createHash("sha256").update("0.20.0").digest("hex").slice(0, 24);
	const cacheBase = omxPluginCacheBase(codexHomeDir);
	const intentLockPath = join(cacheBase, `.omx-live-pin-intent-${versionHash}.lock`);
	const mutationLockPath = livePinMutationLockPath(codexHomeDir, "0.20.0");
	const preloadPath = join(wd, `${launchId}-expire-guards.mjs`);
	await writeFile(preloadPath, `
import { existsSync, writeFileSync } from "node:fs";
const realSetInterval = globalThis.setInterval;
const callbacks = [];
globalThis.setInterval = function (callback, delay, ...args) {
  if (delay === 60_000) {
    callbacks.push(callback);
    return { unref() {} };
  }
  return realSetInterval(callback, delay, ...args);
};
const realNow = Date.now;
let dateOffsetMs = 0;
Date.now = () => realNow() + dateOffsetMs;
let attempts = 0;
const waitForDelegate = () => {
  if (!existsSync(process.env.OMX_TEST_DELEGATE_STARTED)) {
    attempts += 1;
    if (attempts >= 500) return;
    setTimeout(waitForDelegate, 10);
    return;
  }
  dateOffsetMs = 6 * 60 * 1000;
  const lock = JSON.stringify({
    version: 1,
    pid: process.pid,
    operation: "pin",
    token: "77777777-7777-4777-8777-777777777777",
  }) + "\\n";
  writeFileSync(process.env.OMX_TEST_INTENT_LOCK, lock, { flag: "wx", mode: 0o600 });
  writeFileSync(process.env.OMX_TEST_MUTATION_LOCK, lock, { flag: "wx", mode: 0o600 });
  for (const callback of callbacks) callback();
  setTimeout(() => writeFileSync(process.env.OMX_TEST_DELEGATE_FINISHED, "finish"), 100);
};
setTimeout(waitForDelegate, 10);
`);
	const hookResult = spawnSync(
		process.execPath,
		["--import", preloadPath, join(pluginRoot, "hooks", "codex-native-hook.mjs")],
		{
			cwd: wd,
			input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, codex_pid: process.pid, cwd: wd }),
			encoding: "utf-8",
			timeout: 15_000,
			env: {
				...process.env,
				CODEX_HOME: codexHomeDir,
				OMX_ROOT: wd,
				OMX_CODEX_LAUNCH_ID: launchId,
				OMX_ENTRY_PATH: wd,
				OMX_TEST_DELEGATE_STARTED: delegateStartedPath,
				OMX_TEST_DELEGATE_STOPPED: delegateStoppedPath,
				OMX_TEST_DELEGATE_FINISHED: delegateFinishedPath,
				OMX_TEST_DELEGATE_DONE: delegateDonePath,
				OMX_TEST_INTENT_LOCK: intentLockPath,
				OMX_TEST_MUTATION_LOCK: mutationLockPath,
			},
		},
	);
	await rm(intentLockPath, { force: true });
	await rm(mutationLockPath, { force: true });
	assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
	await assert.rejects(lstat(delegateStoppedPath), { code: "ENOENT" });
	assert.equal(await readFile(delegateDonePath, "utf-8"), "completed");
	return pinPath;
}

describe("issue 3790 live plugin cache pins", () => {
	it("writes a live pin from an uncorrelated SessionStart hook, not during publication", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-session-pin-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const packaged = await resolvePackagedOmxMarketplace(packageRoot);
				assert.ok(packaged);
				const materialized = await materializePackagedOmxPluginCache(
					codexHomeDir,
					packaged,
				);
				assert.equal(materialized.status, "materialized");
				const cacheDir = materialized.cacheDir!;
				const markerDir = join(cacheDir, ".omx-live-pin");
				const launcherPath = join(cacheDir, "hooks", "omx-command.json");
				const launcherContent = await readFile(launcherPath, "utf-8");
				await assert.rejects(lstat(markerDir), { code: "ENOENT" });

				const hookResult = spawnSync(
					process.execPath,
					[join(cacheDir, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({
							hook_event_name: "SessionStart",
							session_id: "issue-3790-session",
							codex_pid: process.pid,
							cwd: wd,
						}),
						encoding: "utf-8",
						env: { ...process.env, CODEX_HOME: codexHomeDir },
					},
				);
				assert.equal(
					hookResult.status,
					0,
					hookResult.stderr || hookResult.stdout,
				);
				const markerStats = await lstat(markerDir);
				assert.equal(markerStats.isDirectory(), true);
				const entries = await readdir(markerDir);
				assert.equal(entries.length, 1);
				const pin = JSON.parse(
					await readFile(join(markerDir, entries[0]!), "utf-8"),
				) as {
					pid: number;
					sessionHash: string;
					processStartHash: string | null;
				};
				assert.equal(pin.pid, process.pid);
				assert.equal(
					pin.sessionHash,
					createHash("sha256").update("issue-3790-session").digest("hex"),
				);
				assert.ok(
					pin.processStartHash === null ||
						/^[0-9a-f]{24}$/.test(pin.processStartHash),
				);
				await assert.rejects(
					lstat(livePinIntentPath(codexHomeDir, materialized.version!, "issue-3790-session")),
					{ code: "ENOENT" },
				);
				const helperCalls = join(wd, "pin-helper-calls.txt");
				const fakeLauncher = join(wd, "fake-pin-launcher.mjs");
				await writeFile(
					fakeLauncher,
					`import { appendFileSync } from "node:fs";\nappendFileSync(process.env.OMX_PIN_HELPER_CALLS, "called\\n");\nprocess.stdout.write("{}\\n");\n`,
				);
				await writeFile(launcherPath, JSON.stringify({ command: process.execPath, argsPrefix: [fakeLauncher] }));
				const alreadyPinnedResult = spawnSync(
					process.execPath,
					[join(cacheDir, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "issue-3790-session", codex_pid: process.pid, cwd: wd }),
						encoding: "utf-8",
						env: { ...process.env, CODEX_HOME: codexHomeDir, OMX_PIN_HELPER_CALLS: helperCalls },
					},
				);
				assert.equal(alreadyPinnedResult.status, 0, alreadyPinnedResult.stderr || alreadyPinnedResult.stdout);
				assert.equal(await readFile(helperCalls, "utf-8"), "called\n");
				await writeFile(launcherPath, launcherContent);
				await rm(join(markerDir, entries[0]!), { force: true });
				const retryResult = spawnSync(
					process.execPath,
					[join(cacheDir, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({
							hook_event_name: "UserPromptSubmit",
							session_id: "issue-3790-session",
							codex_pid: process.pid,
							cwd: wd,
						}),
						encoding: "utf-8",
						env: { ...process.env, CODEX_HOME: codexHomeDir },
					},
				);
				assert.equal(retryResult.status, 0, retryResult.stderr || retryResult.stdout);
				assert.equal((await readdir(markerDir)).length, 1);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("publishes post-pin hooks under a new cache version and retains every pre-pin snapshot", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-legacy-snapshot-upgrade-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const legacySnapshots = await Promise.all(
					["0.21.13", "0.21.14"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				await Promise.all(
					legacySnapshots.map((snapshot, index) => markAsPrePinManagedSnapshot(
						snapshot,
						["0.21.13", "0.21.14"][index]!,
						index === 0 ? "legacy-record" : "legacy-pid",
					)),
				);
				const packaged = await resolvePackagedOmxMarketplace(packageRoot);
				assert.ok(packaged);
				const pluginManifest = JSON.parse(await readFile(packaged.pluginManifestPath, "utf-8")) as { version: string };
				assert.equal(pluginManifest.version, "0.21.15");

				const published = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
				assert.equal(published.status, "materialized");
				assert.ok(legacySnapshots.every((snapshot) => published.cacheDir !== snapshot));
				await lstat(published.cacheDir!);
				await Promise.all(legacySnapshots.map((snapshot) => lstat(snapshot)));
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("uses the configured launcher to pin an unrouted session when the cache launcher is invalid", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-configured-pin-launcher-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const packaged = await resolvePackagedOmxMarketplace(packageRoot);
				assert.ok(packaged);
				const published = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
				assert.equal(published.status, "materialized");
				const cacheDir = published.cacheDir!;
				await writeFile(join(cacheDir, "hooks", "omx-command.json"), "invalid launcher\n");

				const cliPath = join(packageRoot, "dist", "cli", "omx.js");
				const overrideName = "omx-hook-override";
				if (process.platform === "win32") {
					await writeFile(
						join(wd, `${overrideName}.cmd`),
						`@echo off\r\n"${process.execPath}" "${cliPath}" %*\r\n`,
					);
				} else {
					const overridePath = join(wd, overrideName);
					await writeFile(
						overridePath,
						`#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nimport { readFileSync } from "node:fs";\nconst result = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(cliPath)}, ...process.argv.slice(2)], { input: readFileSync(0), stdio: ["pipe", "inherit", "inherit"], env: process.env });\nprocess.exitCode = result.status ?? 1;\n`,
					);
					await chmod(overridePath, 0o755);
				}

				const sessionId = "configured-launcher-session";
				const hookResult = spawnSync(
					process.execPath,
					[join(cacheDir, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({
							hook_event_name: "SessionStart",
							session_id: sessionId,
							codex_pid: process.pid,
							cwd: wd,
						}),
						encoding: "utf-8",
						env: {
							...process.env,
							CODEX_HOME: codexHomeDir,
							OMX_NATIVE_HOOK_COMMAND: overrideName,
							PATH: `${wd}${delimiter}${process.env.PATH ?? ""}`,
						},
					},
				);
				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				const markerDir = join(cacheDir, ".omx-live-pin");
				const entries = await readdir(markerDir);
				assert.equal(entries.length, 1);
				const pin = JSON.parse(await readFile(join(markerDir, entries[0]!), "utf-8")) as {
					pid: number;
					sessionHash: string;
				};
				assert.equal(pin.pid, process.pid);
				assert.equal(pin.sessionHash, createHash("sha256").update(sessionId).digest("hex"));
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("returns a no-op when an unrouted pin helper hangs", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-pin-helper-timeout-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const packaged = await resolvePackagedOmxMarketplace(packageRoot);
				assert.ok(packaged);
				const materialized = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
				assert.equal(materialized.status, "materialized");
				const cacheDir = materialized.cacheDir!;
				const launcherPath = join(cacheDir, "hooks", "omx-command.json");
				const helperPath = join(wd, "hanging-pin-helper.mjs");
				await writeFile(
					helperPath,
					`
const parentPid = process.ppid;
process.on("SIGTERM", () => {});
setInterval(() => {
	try { process.kill(parentPid, 0); } catch { process.exit(0); }
}, 50);
setInterval(() => {}, 60_000);
`,
				);
				await writeFile(launcherPath, JSON.stringify({ command: process.execPath, argsPrefix: [helperPath] }));

				const hookResult = spawnSync(process.execPath, [join(cacheDir, "hooks", "codex-native-hook.mjs")], {
					cwd: wd,
					input: JSON.stringify({
						hook_event_name: "SessionStart",
						session_id: "hung-pin-helper-session",
						codex_pid: process.pid,
						cwd: wd,
					}),
					encoding: "utf-8",
					timeout: 12_000,
					env: { ...process.env, CODEX_HOME: codexHomeDir },
				});
				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				assert.equal(hookResult.stdout, "");
				assert.match(hookResult.stderr, /live plugin cache pin helper timed out/);
				const sessionHash = createHash("sha256").update("hung-pin-helper-session").digest("hex");
				assert.deepEqual(
					JSON.parse(await readFile(livePinIntentPath(codexHomeDir, materialized.version!, "hung-pin-helper-session"), "utf-8")),
					{ version: 1, cacheVersion: materialized.version, sessionHash },
				);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("pins a running hook wrapper before it waits for stdin", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-startup-pin-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.19.0", "0.20.0", "0.20.1"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const pluginRoot = snapshots[1]!;
				const pinDirectory = join(pluginRoot, ".omx-live-pin");
				const expiredAt = new Date(Date.now() - 60 * 60 * 1000);
				await utimes(pluginRoot, expiredAt, expiredAt);
				const hook = spawn(
					process.execPath,
					[join(pluginRoot, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						stdio: ["pipe", "pipe", "pipe"],
						env: { ...process.env, CODEX_HOME: codexHomeDir },
					},
				);
				hook.stdout.resume();
				let hookStderr = "";
				hook.stderr.setEncoding("utf-8");
				hook.stderr.on("data", (chunk: string) => { hookStderr += chunk; });
				const closed = once(hook, "close");
				try {
					let pendingEntries: string[] = [];
					for (let attempt = 0; attempt < 100; attempt += 1) {
						try {
							pendingEntries = (await readdir(pinDirectory)).filter((name) => name.startsWith(".pending-"));
							if (pendingEntries.length > 0) break;
						} catch {
						// The launcher may not have created its startup guard yet.
						}
						await new Promise((resolveWait) => setTimeout(resolveWait, 10));
					}
					assert.equal(pendingEntries.length, 1, "startup pin must exist while the wrapper waits for stdin");
					const pending = JSON.parse(await readFile(join(pinDirectory, pendingEntries[0]!), "utf-8")) as {
						version: number;
						sessionHash: string;
					};
					assert.equal(pending.version, 1);
					assert.match(pending.sessionHash, /^[0-9a-f]{64}$/);
					assert.equal(pendingEntries[0], `.pending-${pending.sessionHash}.json`);

					const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.2");
					assert.equal(retired.includes(pluginRoot), false);
					assert.equal(retired.includes(snapshots[0]!), true);
					await lstat(pluginRoot);
					await lstat(snapshots[2]!);
					await assert.rejects(lstat(snapshots[0]!), { code: "ENOENT" });

					hook.stdin.end(JSON.stringify({
						hook_event_name: "SessionStart",
						session_id: "startup-pin-session",
						codex_pid: process.pid,
						cwd: wd,
					}));
					const [code] = await closed as [number | null];
					assert.equal(code, 0, hookStderr);
					assert.equal((await readdir(pinDirectory)).length, 1);
				} finally {
					if (hook.exitCode === null) {
						hook.kill();
						await closed;
					}
				}
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("publishes a renewable startup intent before waiting for hook input", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-startup-intent-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const pluginRoot = snapshots[0]!;
				const cacheBase = omxPluginCacheBase(codexHomeDir);
				const versionHash = createHash("sha256").update("0.20.0").digest("hex").slice(0, 24);
				const intentPrefix = `.omx-live-pin-intent-${versionHash}-`;
				const mutationLock = await writeLivePinMutationLock(codexHomeDir, "0.20.0", process.pid, "retire");
				const helperPath = join(wd, "codex-native-hook");
				await writeFile(helperPath, "process.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\n");
				const hook = spawn(
					process.execPath,
					[join(pluginRoot, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						stdio: ["pipe", "pipe", "pipe"],
						env: {
							...process.env,
							CODEX_HOME: codexHomeDir,
							OMX_NATIVE_HOOK_COMMAND: process.execPath,
						},
					},
				);
				hook.stdout.resume();
				let hookStderr = "";
				hook.stderr.setEncoding("utf-8");
				hook.stderr.on("data", (chunk: string) => { hookStderr += chunk; });
				const closed = once(hook, "close");
				try {
					let startupIntents: string[] = [];
					for (let attempt = 0; attempt < 100; attempt += 1) {
						startupIntents = (await readdir(cacheBase)).filter((name) => name.startsWith(intentPrefix));
						if (startupIntents.length > 0) break;
						await new Promise((resolveWait) => setTimeout(resolveWait, 10));
					}
					assert.equal(startupIntents.length, 1, "startup intent must exist before the wrapper reads stdin");
					const startupIntentPath = join(cacheBase, startupIntents[0]!);
					const startupIntent = JSON.parse(await readFile(startupIntentPath, "utf-8")) as {
						version: number;
						cacheVersion: string;
						sessionHash: string;
					};
					assert.deepEqual(
						{ version: startupIntent.version, cacheVersion: startupIntent.cacheVersion },
						{ version: 1, cacheVersion: "0.20.0" },
					);
					assert.match(startupIntent.sessionHash, /^[0-9a-f]{64}$/);

					await rm(mutationLock.path);
					const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");
					assert.equal(retired.includes(pluginRoot), false);
					assert.equal(retired.includes(snapshots[1]!), true);
					await lstat(pluginRoot);
					await assert.rejects(lstat(snapshots[1]!), { code: "ENOENT" });

					hook.stdin.end(JSON.stringify({
						hook_event_name: "SessionStart",
						session_id: "startup-intent-session",
						codex_pid: process.pid,
						cwd: wd,
					}));
					const [code] = await closed as [number | null];
					assert.equal(code, 0, hookStderr);
					await assert.rejects(lstat(startupIntentPath), { code: "ENOENT" });
				} finally {
					await rm(mutationLock.path, { force: true });
					if (hook.exitCode === null) {
						hook.kill();
						await closed;
					}
				}
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("does not publish a startup pin after the snapshot is quarantined", {
		skip: process.platform !== "linux",
	}, async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-quarantine-pin-race-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const pluginRoot = await seedManagedSnapshot(codexHomeDir, "0.20.0");
				const quarantinePath = join(wd, "quarantined-snapshot");
				const preloadPath = join(wd, "rename-before-pin-write.mjs");
				await writeFile(preloadPath, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalWriteFileSync = fs.writeFileSync;
let renamed = false;
fs.writeFileSync = function (path, ...args) {
	if (!renamed && typeof path === "string" && path.includes("/.omx-live-pin/.stage-")) {
		fs.renameSync(process.env.OMX_TEST_PLUGIN_ROOT, process.env.OMX_TEST_QUARANTINE);
		renamed = true;
	}
	return originalWriteFileSync.call(this, path, ...args);
};
syncBuiltinESMExports();
`);
				const hookResult = spawnSync(
					process.execPath,
					[
						"--import",
						preloadPath,
						join(pluginRoot, "hooks", "codex-native-hook.mjs"),
					],
					{
						cwd: wd,
						input: JSON.stringify({
							hook_event_name: "SessionStart",
							session_id: "quarantine-race-session",
							codex_pid: process.pid,
							cwd: wd,
						}),
						encoding: "utf-8",
						env: {
							...process.env,
							CODEX_HOME: codexHomeDir,
							OMX_TEST_PLUGIN_ROOT: pluginRoot,
							OMX_TEST_QUARANTINE: quarantinePath,
						},
					},
				);
				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				await assert.rejects(lstat(pluginRoot), { code: "ENOENT" });
				assert.deepEqual(await readdir(join(quarantinePath, ".omx-live-pin")), []);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("keeps a session intent visible when snapshot rename races its publication", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-intent-rename-race-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const pluginRoot = snapshots[0]!;
				const quarantinePath = join(wd, "snapshot-during-intent-publication");
				const raceMarkerPath = join(wd, "intent-publication-raced-rename");
				const helperPath = join(wd, "codex-native-hook");
				const preloadPath = join(wd, "rename-during-intent-link.mjs");
				const sessionId = "snapshot-rename-race-session";
				const mutationLock = await writeLivePinMutationLock(
					codexHomeDir,
					"0.20.0",
					process.pid,
					"pin",
				);
				await writeFile(helperPath, "process.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\n");
				await writeFile(preloadPath, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalLinkSync = fs.linkSync;
const originalRenameSync = fs.renameSync;
const originalWriteFileSync = fs.writeFileSync;
let raced = false;
fs.linkSync = function (source, destination, ...args) {
	if (!raced && typeof destination === "string" && destination.includes(".omx-live-pin-intent-")) {
		originalRenameSync.call(this, process.env.OMX_TEST_PLUGIN_ROOT, process.env.OMX_TEST_QUARANTINE);
		try {
			const result = originalLinkSync.call(this, source, destination, ...args);
			raced = true;
			originalWriteFileSync.call(this, process.env.OMX_TEST_RACE_MARKER, "renamed during publication\\n");
			return result;
		} finally {
			originalRenameSync.call(this, process.env.OMX_TEST_QUARANTINE, process.env.OMX_TEST_PLUGIN_ROOT);
		}
	}
	return originalLinkSync.call(this, source, destination, ...args);
};
syncBuiltinESMExports();
`);
				const hookResult = spawnSync(
					process.execPath,
					["--import", preloadPath, join(pluginRoot, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({
							hook_event_name: "SessionStart",
							session_id: sessionId,
							codex_pid: process.pid,
							cwd: wd,
						}),
						encoding: "utf-8",
						timeout: 15_000,
						env: {
							...process.env,
							CODEX_HOME: codexHomeDir,
							OMX_NATIVE_HOOK_COMMAND: process.execPath,
							OMX_TEST_PLUGIN_ROOT: pluginRoot,
							OMX_TEST_QUARANTINE: quarantinePath,
							OMX_TEST_RACE_MARKER: raceMarkerPath,
						},
					},
				);
				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				await lstat(raceMarkerPath);
				await lstat(pluginRoot);
				await lstat(livePinIntentPath(codexHomeDir, "0.20.0", sessionId));

				await rm(mutationLock.path);
				const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");
				assert.equal(retired.includes(pluginRoot), false);
				assert.equal(retired.includes(snapshots[1]!), true);
				await lstat(pluginRoot);
				await lstat(snapshots[2]!);
				await assert.rejects(lstat(snapshots[1]!), { code: "ENOENT" });
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("serializes startup pin publication with quarantine deletion", {
		skip: process.platform !== "linux",
	}, async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-retirement-gate-race-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const pluginRoot = snapshots[0]!;
				const pinDirectory = join(pluginRoot, ".omx-live-pin");
				await mkdir(pinDirectory);
				const expiredAt = new Date(Date.now() - 6 * 60 * 1000);
				await utimes(pinDirectory, expiredAt, expiredAt);

				const mutationLockPath = join(
					omxPluginCacheBase(codexHomeDir),
					`.omx-live-pin-${createHash("sha256").update("0.20.0").digest("hex").slice(0, 24)}.lock`,
				);

				const readyPath = join(wd, "pin-writer-ready");
				const releasePath = join(wd, "pin-writer-release");
				const preloadPath = join(wd, "pause-before-pin-write.mjs");
				await writeFile(
					preloadPath,
					`
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalWriteFileSync = fs.writeFileSync;
let paused = false;
fs.writeFileSync = function (path, ...args) {
	if (!paused && typeof path === "string" && path.includes("/.omx-live-pin/.stage-")) {
		paused = true;
		originalWriteFileSync.call(this, process.env.OMX_TEST_PIN_READY, "ready\\n");
		const wait = new Int32Array(new SharedArrayBuffer(4));
		while (!fs.existsSync(process.env.OMX_TEST_PIN_RELEASE)) Atomics.wait(wait, 0, 0, 10);
	}
	return originalWriteFileSync.call(this, path, ...args);
};
syncBuiltinESMExports();
`,
				);
				const hook = spawn(
					process.execPath,
					["--import", preloadPath, join(pluginRoot, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						stdio: ["pipe", "pipe", "pipe"],
						env: {
							...process.env,
							CODEX_HOME: codexHomeDir,
							OMX_TEST_PIN_READY: readyPath,
							OMX_TEST_PIN_RELEASE: releasePath,
						},
					},
				);
				hook.stdout.resume();
				let hookStderr = "";
				hook.stderr.setEncoding("utf-8");
				hook.stderr.on("data", (chunk: string) => {
					hookStderr += chunk;
				});
				const closed = once(hook, "close");
				let retirement: Promise<string[]> | undefined;
				try {
					hook.stdin.end(
						JSON.stringify({
							hook_event_name: "SessionStart",
							session_id: "retirement-gate-session",
							codex_pid: process.pid,
							cwd: wd,
						}),
					);
					let writerPaused = false;
					for (let attempt = 0; attempt < 500; attempt += 1) {
						try {
							await lstat(readyPath);
							writerPaused = true;
							break;
						} catch {
							await new Promise((resolveWait) => setTimeout(resolveWait, 10));
						}
					}
					assert.equal(writerPaused, true, hookStderr || "pin writer did not reach the interposed stage write");

					retirement = retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");
					const retiredWhileWriterPaused = await retirement;
					assert.equal(retiredWhileWriterPaused.includes(pluginRoot), false);
					assert.equal(retiredWhileWriterPaused.includes(snapshots[1]!), true);
					await lstat(pluginRoot);
					const mutationLock = JSON.parse(await readFile(mutationLockPath, "utf-8")) as { operation: string };
					assert.equal(mutationLock.operation, "pin");
					await writeFile(releasePath, "release\n");
					let closeTimeout: NodeJS.Timeout | undefined;
					let closeResult: unknown[];
					try {
						closeResult = await Promise.race([
							closed,
							new Promise<never>((_resolve, reject) => {
								closeTimeout = setTimeout(
									() => reject(new Error("startup hook did not finish after releasing the pin writer")),
									5000,
								);
							}),
						]);
					} finally {
						if (closeTimeout) clearTimeout(closeTimeout);
					}
					const [hookCode] = closeResult as [number | null];
					assert.equal(hookCode, 0, hookStderr);
					const pinRecords = await Promise.all(
						(await readdir(pinDirectory)).map(
							async (name) => JSON.parse(await readFile(join(pinDirectory, name), "utf-8")) as { sessionHash: string },
						),
					);
					assert.deepEqual(
						pinRecords.map((record) => record.sessionHash),
						[createHash("sha256").update("retirement-gate-session").digest("hex")],
					);
					const retiredAfterPin = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");
					assert.equal(retiredAfterPin.includes(pluginRoot), false);
					await lstat(pluginRoot);
					await assert.rejects(lstat(snapshots[1]!), { code: "ENOENT" });
				} finally {
					await writeFile(releasePath, "release\n").catch(() => undefined);
					if (hook.exitCode === null) hook.kill();
					await closed.catch(() => undefined);
					await retirement?.catch(() => undefined);
				}
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("blocks startup intent publication after the final retirement check", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-final-intent-fence-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const pluginRoot = snapshots[0]!;
				const versionHash = createHash("sha256").update("0.20.0").digest("hex").slice(0, 24);
				const readyPath = join(wd, "intent-writer-ready");
				const releasePath = join(wd, "intent-writer-release");
				const launcherInvokedPath = join(wd, "launcher-invoked-without-pin");
				const preloadPath = join(wd, "pause-before-intent-lock.mjs");
				await writeFile(
					join(wd, "codex-native-hook"),
					"process.env.OMX_TEST_LAUNCHER_INVOKED && require('node:fs').writeFileSync(process.env.OMX_TEST_LAUNCHER_INVOKED, 'invoked');\nprocess.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\n",
				);
				await writeFile(preloadPath, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalWriteFileSync = fs.writeFileSync;
let paused = false;
fs.writeFileSync = function (path, ...args) {
	if (!paused && typeof path === "string" && path.includes(".omx-live-pin-intent-${versionHash}.lock.stage-")) {
		paused = true;
		originalWriteFileSync.call(this, process.env.OMX_TEST_INTENT_READY, "ready\\n");
		const wait = new Int32Array(new SharedArrayBuffer(4));
		while (!fs.existsSync(process.env.OMX_TEST_INTENT_RELEASE)) Atomics.wait(wait, 0, 0, 10);
	}
	return originalWriteFileSync.call(this, path, ...args);
};
syncBuiltinESMExports();
`);
				const hook = spawn(
					process.execPath,
					["--import", preloadPath, join(pluginRoot, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						stdio: ["pipe", "pipe", "pipe"],
						env: {
							...process.env,
							CODEX_HOME: codexHomeDir,
							OMX_NATIVE_HOOK_COMMAND: process.execPath,
							OMX_TEST_INTENT_READY: readyPath,
							OMX_TEST_INTENT_RELEASE: releasePath,
							OMX_TEST_LAUNCHER_INVOKED: launcherInvokedPath,
						},
					},
				);
				hook.stdout.resume();
				let hookStderr = "";
				hook.stderr.setEncoding("utf-8");
				hook.stderr.on("data", (chunk: string) => { hookStderr += chunk; });
				const closed = once(hook, "close");
				let retirement: Promise<string[]> | undefined;
				let interposed = false;
				const resetHooks = setPluginCacheMutationHooksForTest({
					afterDestructiveCheck: async (path) => {
						if (interposed || !path.includes(".0.20.0.reclaim-")) return;
						interposed = true;
						await writeFile(releasePath, "release\\n");
						const [code] = await closed as [number | null];
						assert.equal(code, 0, hookStderr);
					},
				});
				try {
					hook.stdin.end(JSON.stringify({
						hook_event_name: "SessionStart",
						session_id: "late-intent-session",
						codex_pid: process.pid,
						cwd: wd,
					}));
					let writerPaused = false;
					for (let attempt = 0; attempt < 500; attempt += 1) {
						try {
							await lstat(readyPath);
							writerPaused = true;
							break;
						} catch {
							await new Promise((resolveWait) => setTimeout(resolveWait, 10));
						}
					}
					assert.equal(writerPaused, true, hookStderr || "startup wrapper did not reach intent-fence acquisition");

					retirement = retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");
					const retired = await retirement;
					assert.equal(interposed, true, "retirement must interpose after its final intent scan");
					assert.equal(retired.includes(pluginRoot), true);
					assert.equal(retired.includes(snapshots[1]!), true);
					await assert.rejects(lstat(pluginRoot), { code: "ENOENT" });
					await assert.rejects(lstat(launcherInvokedPath), { code: "ENOENT" });
					const intentPrefix = `.omx-live-pin-intent-${versionHash}-`;
					assert.equal((await readdir(omxPluginCacheBase(codexHomeDir))).some((name) => name.startsWith(intentPrefix)), false);
				} finally {
					resetHooks();
					await writeFile(releasePath, "release\\n").catch(() => undefined);
					if (hook.exitCode === null) hook.kill();
					await closed.catch(() => undefined);
					await retirement?.catch(() => undefined);
				}
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("registers a live pin before concurrent publication retires an older snapshot", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-pin-lock-retry-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const oldSnapshot = await seedManagedSnapshot(codexHomeDir, "0.20.0");
				const olderSnapshots = await Promise.all(
					["0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const packaged = await resolvePackagedOmxMarketplace(packageRoot);
				assert.ok(packaged);
				let signalPrepared!: () => void;
				let releasePublication!: () => void;
				const prepared = new Promise<void>((resolvePrepared) => { signalPrepared = resolvePrepared; });
				const publicationGate = new Promise<void>((resolvePublication) => { releasePublication = resolvePublication; });
				const publication = materializePackagedOmxPluginCache(codexHomeDir, packaged, {
					onCacheDirPrepared: async () => {
						signalPrepared();
						await publicationGate;
					},
				});
				try {
					await prepared;
					assert.equal(await registerOmxPluginCacheLivePin(
						oldSnapshot,
						"lock-contention-session",
						process.pid,
					), true);
					releasePublication();
					const published = await publication;
					assert.equal(published.status, "materialized");
					assert.equal(published.retiredDirs?.includes(olderSnapshots[0]!), true);
					assert.equal(published.retiredDirs?.includes(oldSnapshot), false);
					await lstat(oldSnapshot);
					await assert.rejects(lstat(olderSnapshots[0]!), { code: "ENOENT" });
				} finally {
					releasePublication();
				}
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves a snapshot while its live-pin directory is being initialized", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-pin-directory-race-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const pinDirectory = join(snapshots[0]!, ".omx-live-pin");
				await mkdir(pinDirectory);

				const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");

				assert.equal(retired.includes(snapshots[0]!), false);
				assert.equal(retired.includes(snapshots[1]!), true);
				await lstat(snapshots[0]!);
				assert.deepEqual(await readdir(pinDirectory), []);
				await assert.rejects(lstat(snapshots[1]!), { code: "ENOENT" });
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reclaims an abandoned empty live-pin directory after its initialization lease", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-expired-empty-pin-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const pinDirectory = join(snapshots[0]!, ".omx-live-pin");
				await mkdir(pinDirectory);
				const expiredAt = new Date(Date.now() - 6 * 60 * 1000);
				await utimes(pinDirectory, expiredAt, expiredAt);

				const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");

				assert.equal(retired.includes(snapshots[0]!), true);
				await assert.rejects(lstat(snapshots[0]!), { code: "ENOENT" });
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("does not steal an aged mutation lock from a live owner", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-live-mutation-lock-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const lock = await writeLivePinMutationLock(codexHomeDir, "0.20.0", process.pid, "pin");
				const expiredAt = new Date(Date.now() - 6 * 60 * 1000);
				await utimes(lock.path, expiredAt, expiredAt);

				const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");

				assert.equal(retired.includes(snapshots[0]!), false);
				assert.equal(retired.includes(snapshots[1]!), true);
				await lstat(snapshots[0]!);
				assert.equal(await readFile(lock.path, "utf-8"), lock.content);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("waits for pin identity lookup and verifies durable pins after lock contention", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-pin-lock-identity-wait-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const pluginRoot = await seedManagedSnapshot(codexHomeDir, "0.20.0");
				const lock = await writeLivePinMutationLock(
					codexHomeDir,
					"0.20.0",
					process.pid,
					"pin",
				);
				const registration = registerOmxPluginCacheLivePin(
					pluginRoot,
					"pin-lock-identity-wait-session",
					process.pid,
				);
				await new Promise((resolveWait) => setTimeout(resolveWait, 1_250));
				await rm(lock.path);
				assert.equal(await registration, true);
				const competingRetirement = await writeLivePinMutationLock(
					codexHomeDir,
					"0.20.0",
					process.pid,
					"retire",
				);
				assert.equal(
					await registerOmxPluginCacheLivePin(pluginRoot, "pin-lock-identity-wait-session", process.pid),
					true,
				);
				await rm(competingRetirement.path);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reclaims expired pending markers while preserving live snapshots", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-expired-pending-marker-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const sessionHash = createHash("sha256").update("expired-pending-session").digest("hex");
				const pinDirectory = join(snapshots[0]!, ".omx-live-pin");
				await mkdir(pinDirectory);
				assert.equal(await registerOmxPluginCacheLivePin(snapshots[0]!, "pending-marker-live-session", process.pid), true);
				const pendingPath = join(pinDirectory, `.pending-${sessionHash}.json`);
				await writeFile(pendingPath, `${JSON.stringify({ version: 1, sessionHash })}\n`);
				const expiredAt = new Date(Date.now() - 6 * 60 * 1000);
				await utimes(pendingPath, expiredAt, expiredAt);
				const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");
				assert.equal(retired.includes(snapshots[0]!), false);
				await lstat(snapshots[0]!);
				await assert.rejects(lstat(pendingPath), { code: "ENOENT" });
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reclaims expired sidecar intents and stages while holding the retirement lock", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-expired-sidecar-intents-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const cacheBase = omxPluginCacheBase(codexHomeDir);
				const versionHash = createHash("sha256").update("0.20.0").digest("hex").slice(0, 24);
				const sessionId = "abandoned-startup-intent";
				const sessionHash = createHash("sha256").update(sessionId).digest("hex");
				const intentPath = livePinIntentPath(codexHomeDir, "0.20.0", sessionId);
				const stagePath = join(
					cacheBase,
					`.stage-omx-live-pin-intent-${versionHash}-${sessionHash}-99999-abandoned`,
				);
				const content = `${JSON.stringify({ version: 1, cacheVersion: "0.20.0", sessionHash })}\n`;
				await writeFile(intentPath, content);
				await writeFile(stagePath, content);
				const expiredAt = new Date(Date.now() - 6 * 60 * 1000);
				await utimes(intentPath, expiredAt, expiredAt);
				await utimes(stagePath, expiredAt, expiredAt);

				const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");

				assert.equal(retired.includes(snapshots[0]!), true);
				await assert.rejects(lstat(intentPath), { code: "ENOENT" });
				await assert.rejects(lstat(stagePath), { code: "ENOENT" });
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("sweeps expired sidecar intents from current and retained snapshots", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-retained-sidecar-intents-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const cacheBase = omxPluginCacheBase(codexHomeDir);
				const expiredAt = new Date(Date.now() - 6 * 60 * 1000);
				for (const version of ["0.20.1", "0.20.2"]) {
					const versionHash = createHash("sha256").update(version).digest("hex").slice(0, 24);
					const sessionHash = createHash("sha256").update(`expired-${version}`).digest("hex");
					const intentPath = livePinIntentPath(codexHomeDir, version, `expired-${version}`);
					const stagePath = join(
						cacheBase,
						`.stage-omx-live-pin-intent-${versionHash}-${sessionHash}-99999-abandoned`,
					);
					const content = `${JSON.stringify({ version: 1, cacheVersion: version, sessionHash })}\n`;
					const snapshot = snapshots[version === "0.20.1" ? 1 : 2]!;
					const pinDirectory = join(snapshot, ".omx-live-pin");
					const pendingPinPath = join(pinDirectory, `.pending-${sessionHash}.json`);
					const pinStagePath = join(pinDirectory, `.stage-pending-${sessionHash}-99999-abandoned`);
					const pinContent = `${JSON.stringify({ version: 1, sessionHash })}\n`;
					await mkdir(pinDirectory);
					await writeFile(intentPath, content);
					await writeFile(stagePath, content);
					await writeFile(pendingPinPath, pinContent);
					await writeFile(pinStagePath, pinContent);
					await utimes(intentPath, expiredAt, expiredAt);
					await utimes(stagePath, expiredAt, expiredAt);
					await utimes(pendingPinPath, expiredAt, expiredAt);
					await utimes(pinStagePath, expiredAt, expiredAt);
					await utimes(pinDirectory, expiredAt, expiredAt);
				}

				const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.2");

				assert.equal(retired.includes(snapshots[0]!), true);
				await assert.rejects(lstat(snapshots[0]!), { code: "ENOENT" });
				for (const version of ["0.20.1", "0.20.2"]) {
					await assert.rejects(lstat(livePinIntentPath(codexHomeDir, version, `expired-${version}`)), { code: "ENOENT" });
					const versionHash = createHash("sha256").update(version).digest("hex").slice(0, 24);
					const sessionHash = createHash("sha256").update(`expired-${version}`).digest("hex");
					await assert.rejects(
						lstat(join(cacheBase, `.stage-omx-live-pin-intent-${versionHash}-${sessionHash}-99999-abandoned`)),
						{ code: "ENOENT" },
					);
					const pinDirectory = join(snapshots[version === "0.20.1" ? 1 : 2]!, ".omx-live-pin");
					await assert.rejects(lstat(join(pinDirectory, `.pending-${sessionHash}.json`)), { code: "ENOENT" });
					await assert.rejects(lstat(join(pinDirectory, `.stage-pending-${sessionHash}-99999-abandoned`)), { code: "ENOENT" });
					await lstat(snapshots[version === "0.20.1" ? 1 : 2]!);
				}
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("recovers a dead-owner lock left between publication and stage cleanup", {
		skip: process.platform !== "linux",
	}, async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-dead-mutation-lock-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const lock = await writeLivePinMutationLock(codexHomeDir, "0.20.0", 2_147_483_647, "pin", true);

				assert.equal(
					await registerOmxPluginCacheLivePin(snapshots[0]!, "dead-lock-recovery-session", process.pid),
					true,
				);

				await assert.rejects(lstat(lock.path), { code: "ENOENT" });
				await assert.rejects(lstat(lock.stagePath), { code: "ENOENT" });
				const pinDirectory = join(snapshots[0]!, ".omx-live-pin");
				const sessionHash = createHash("sha256").update("dead-lock-recovery-session").digest("hex");
				const records = await Promise.all(
					(await readdir(pinDirectory)).map(
						async (name) => JSON.parse(await readFile(join(pinDirectory, name), "utf-8")) as { sessionHash: string },
					),
				);
				assert.ok(records.some((record) => record.sessionHash === sessionHash));
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("keeps a session pending pin when a live retirement lock blocks startup pinning", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-retirement-lock-wins-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const pluginRoot = snapshots[0]!;
				const lock = await writeLivePinMutationLock(codexHomeDir, "0.20.0", process.pid, "retire");
				const expiredAt = new Date(Date.now() - 6 * 60 * 1000);
				await utimes(lock.path, expiredAt, expiredAt);
				const preloadPath = join(wd, "assert-no-unlocked-snapshot-read.mjs");
				const violationPath = join(wd, "launcher-read-while-retiring");
				await writeFile(
					preloadPath,
					`
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const root = process.env.OMX_TEST_SNAPSHOT_ROOT;
const originalLstatSync = fs.lstatSync;
const originalReadFileSync = fs.readFileSync;
const originalWriteFileSync = fs.writeFileSync;
function checkSnapshotPath(path) {
	if (typeof path !== "string" || !path.startsWith(root) || !path.endsWith("/hooks/omx-command.json")) return;
	try { originalWriteFileSync.call(fs, process.env.OMX_TEST_VIOLATION_PATH, path); } catch {}
}
fs.lstatSync = function (path, ...args) { checkSnapshotPath(path); return originalLstatSync.call(this, path, ...args); };
fs.readFileSync = function (path, ...args) { checkSnapshotPath(path); return originalReadFileSync.call(this, path, ...args); };
syncBuiltinESMExports();
`,
				);

				const hookResult = spawnSync(
					process.execPath,
					["--import", preloadPath, join(pluginRoot, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({
							hook_event_name: "SessionStart",
							session_id: "retirement-lock-session",
							cwd: wd,
						}),
						encoding: "utf-8",
						env: {
							...process.env,
							CODEX_HOME: codexHomeDir,
							OMX_TEST_SNAPSHOT_ROOT: pluginRoot,
							OMX_TEST_VIOLATION_PATH: violationPath,
						},
					},
				);

				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				await assert.rejects(lstat(violationPath), { code: "ENOENT" });
				assert.equal(await readFile(lock.path, "utf-8"), lock.content);
				const sessionHash = createHash("sha256").update("retirement-lock-session").digest("hex");
				const pendingPath = livePinIntentPath(codexHomeDir, "0.20.0", "retirement-lock-session");
				assert.deepEqual(JSON.parse(await readFile(pendingPath, "utf-8")), {
					version: 1,
					cacheVersion: "0.20.0",
					sessionHash,
				});
				await rm(lock.path);
				const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");
				assert.equal(retired.includes(pluginRoot), false);
				assert.equal(retired.includes(snapshots[1]!), true);
				await lstat(pluginRoot);
				await assert.rejects(lstat(snapshots[1]!), { code: "ENOENT" });
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("rejects a stale session pin when startup pin publication is blocked", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-stale-pin-fallback-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const pluginRoot = await seedManagedSnapshot(codexHomeDir, "0.20.0");
				const cacheBase = omxPluginCacheBase(codexHomeDir);
				const sessionId = "reused-pid-fallback-session";
				const sessionHash = createHash("sha256").update(sessionId).digest("hex");
				const staleProcessStartHash = "0".repeat(24);
				const pinDirectory = join(pluginRoot, ".omx-live-pin");
				await mkdir(pinDirectory);
				await writeFile(
					join(pinDirectory, `pin-${process.pid}-${sessionHash.slice(0, 24)}-${staleProcessStartHash}.json`),
					`${JSON.stringify({ version: 1, pid: process.pid, processStartHash: staleProcessStartHash, sessionHash })}\n`,
				);
				const mutationLock = await writeLivePinMutationLock(codexHomeDir, "0.20.0", process.pid, "pin");
				const versionHash = createHash("sha256").update("0.20.0").digest("hex").slice(0, 24);
				const intentLockPath = join(cacheBase, `.omx-live-pin-intent-${versionHash}.lock`);
				const lockContent = `${JSON.stringify({
					version: 1,
					pid: process.pid,
					operation: "pin",
					token: "22222222-2222-4222-8222-222222222222",
				})}\n`;
				await writeFile(intentLockPath, lockContent);
				const launcherInvokedPath = join(wd, "launcher-invoked-with-stale-pin");
				await writeFile(
					join(wd, "codex-native-hook"),
					"require('node:fs').writeFileSync(process.env.OMX_TEST_LAUNCHER_INVOKED, 'invoked');\nprocess.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\n",
				);

				const hookResult = spawnSync(process.execPath, [join(pluginRoot, "hooks", "codex-native-hook.mjs")], {
					cwd: wd,
					input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId, codex_pid: process.pid, cwd: wd }),
					encoding: "utf-8",
					env: { ...process.env, CODEX_HOME: codexHomeDir, OMX_NATIVE_HOOK_COMMAND: process.execPath, OMX_TEST_LAUNCHER_INVOKED: launcherInvokedPath },
				});

				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				await assert.rejects(lstat(launcherInvokedPath), { code: "ENOENT" });
				assert.equal(await readFile(mutationLock.path, "utf-8"), mutationLock.content);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("re-registers an aged same-session pin before non-start hooks", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-aged-session-pin-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const pluginRoot = await seedManagedSnapshot(codexHomeDir, "0.20.0");
				const sessionId = "aged-same-session-pin";
				const sessionHash = createHash("sha256").update(sessionId).digest("hex");
				const staleProcessStartHash = "a".repeat(24);
				const pinDirectory = join(pluginRoot, ".omx-live-pin");
				await mkdir(pinDirectory);
				const stalePinPath = join(pinDirectory, `pin-${process.pid}-${sessionHash.slice(0, 24)}-${staleProcessStartHash}.json`);
				await writeFile(
					stalePinPath,
					`${JSON.stringify({ version: 1, pid: process.pid, processStartHash: staleProcessStartHash, sessionHash })}\n`,
				);
				const expiredAt = new Date(Date.now() - 6 * 60 * 1000);
				await utimes(stalePinPath, expiredAt, expiredAt);

				const hookResult = spawnSync(process.execPath, [join(pluginRoot, "hooks", "codex-native-hook.mjs")], {
					cwd: wd,
					input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, codex_pid: process.pid, cwd: wd }),
					encoding: "utf-8",
					env: { ...process.env, CODEX_HOME: codexHomeDir },
				});

				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				const pinRecords = await Promise.all(
					(await readdir(pinDirectory))
						.filter((name) => name.startsWith("pin-"))
						.map(async (name) => JSON.parse(await readFile(join(pinDirectory, name), "utf-8")) as { processStartHash: string | null; sessionHash: string }),
				);
				assert.ok(pinRecords.some((record) => record.sessionHash === sessionHash && record.processStartHash !== staleProcessStartHash));
				const currentPinName = (await readdir(pinDirectory)).find((name) => {
					if (!name.startsWith("pin-")) return false;
					return name.includes(`-${sessionHash.slice(0, 24)}-`) && !name.endsWith(`-${staleProcessStartHash}.json`);
				});
				assert.ok(currentPinName);
				const currentPinPath = join(pinDirectory, currentPinName);
				await utimes(currentPinPath, expiredAt, expiredAt);
				assert.equal(await registerOmxPluginCacheLivePin(pluginRoot, sessionId, process.pid), true);
				assert.ok((await lstat(currentPinPath)).mtimeMs > expiredAt.getTime());
				await assert.rejects(lstat(livePinIntentPath(codexHomeDir, "0.20.0", sessionId)), { code: "ENOENT" });
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("fails closed when startup pin leases are expired", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-expired-startup-lease-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const pluginRoot = await seedManagedSnapshot(codexHomeDir, "0.20.0");
				const preloadPath = join(wd, "expire-startup-leases.mjs");
				await writeFile(preloadPath, `
const realNow = Date.now;
Date.now = () => realNow() + 6 * 60 * 1000;
`);
				const launcherInvokedPath = join(wd, "launcher-invoked-with-expired-lease");
				await writeFile(
					join(wd, "codex-native-hook"),
					"require('node:fs').writeFileSync(process.env.OMX_TEST_LAUNCHER_INVOKED, 'invoked');\nprocess.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\n",
				);

				const hookResult = spawnSync(
					process.execPath,
					["--import", preloadPath, join(pluginRoot, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "expired-startup-session", cwd: wd }),
						encoding: "utf-8",
						env: { ...process.env, CODEX_HOME: codexHomeDir, OMX_NATIVE_HOOK_COMMAND: process.execPath, OMX_TEST_LAUNCHER_INVOKED: launcherInvokedPath },
					},
				);

				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				await assert.rejects(lstat(launcherInvokedPath), { code: "ENOENT" });
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("renews the temporary pin when startup intent renewal fails", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-startup-pin-renewal-fallback-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const pluginRoot = await seedManagedSnapshot(codexHomeDir, "0.20.0");
				const versionHash = createHash("sha256").update("0.20.0").digest("hex").slice(0, 24);
				const intentLockPath = join(omxPluginCacheBase(codexHomeDir), `.omx-live-pin-intent-${versionHash}.lock`);
				const preloadPath = join(wd, "renew-startup-pin-after-intent-failure.mjs");
				await writeFile(preloadPath, `
import fs from "node:fs";
const RealDate = Date;
let virtualNow = RealDate.now();
globalThis.Date = class extends RealDate {
	constructor(...args) { super(...(args.length ? args : [virtualNow])); }
	static now() { return virtualNow; }
};
const originalSetInterval = globalThis.setInterval;
let intervalCount = 0;
globalThis.setInterval = function (callback, delay, ...args) {
	if (delay === 60_000) {
		intervalCount += 1;
		if (intervalCount === 1) {
			virtualNow = RealDate.now() + 6 * 60 * 1000;
			const content = JSON.stringify({ version: 1, pid: process.pid, operation: "pin", token: "44444444-4444-4444-8444-444444444444" }) + "\\n";
			fs.writeFileSync(process.env.OMX_TEST_INTENT_LOCK, content, { flag: "wx", mode: 0o600 });
		}
		callback();
		return { unref() {} };
	}
	return originalSetInterval(callback, delay, ...args);
};
globalThis.clearInterval = () => {};
`);
				const launcherInvokedPath = join(wd, "launcher-invoked-after-pin-renewal");
				await writeFile(
					join(wd, "codex-native-hook"),
					"require('node:fs').writeFileSync(process.env.OMX_TEST_LAUNCHER_INVOKED, 'invoked');\nprocess.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\n",
				);

				const hookResult = spawnSync(
					process.execPath,
					["--import", preloadPath, join(pluginRoot, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "renewed-startup-pin-session", cwd: wd }),
						encoding: "utf-8",
						env: {
							...process.env,
							CODEX_HOME: codexHomeDir,
							OMX_NATIVE_HOOK_COMMAND: process.execPath,
							OMX_TEST_INTENT_LOCK: intentLockPath,
							OMX_TEST_LAUNCHER_INVOKED: launcherInvokedPath,
						},
					},
				);

				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				await lstat(intentLockPath);
				await lstat(launcherInvokedPath);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("fails closed when startup intent renewal loses its lock", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-startup-intent-renewal-failure-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const pluginRoot = await seedManagedSnapshot(codexHomeDir, "0.20.0");
				const versionHash = createHash("sha256").update("0.20.0").digest("hex").slice(0, 24);
				const cacheBase = omxPluginCacheBase(codexHomeDir);
				const intentLockPath = join(cacheBase, `.omx-live-pin-intent-${versionHash}.lock`);
				const mutationLockPath = livePinMutationLockPath(codexHomeDir, "0.20.0");
				const preloadPath = join(wd, "block-startup-lease-renewal.mjs");
				await writeFile(preloadPath, `
import fs from "node:fs";
const originalSetInterval = globalThis.setInterval;
let blocked = false;
globalThis.setInterval = function (callback, delay, ...args) {
	if (!blocked && delay === 60_000) {
		blocked = true;
		const content = JSON.stringify({ version: 1, pid: process.pid, operation: "pin", token: "33333333-3333-4333-8333-333333333333" }) + "\\n";
		fs.writeFileSync(process.env.OMX_TEST_INTENT_LOCK, content, { flag: "wx", mode: 0o600 });
		fs.writeFileSync(process.env.OMX_TEST_MUTATION_LOCK, content, { flag: "wx", mode: 0o600 });
		callback();
		return { unref() {} };
	}
	return originalSetInterval(callback, delay, ...args);
};
globalThis.clearInterval = () => {};
`);
				const launcherInvokedPath = join(wd, "launcher-invoked-with-unrenewed-intent");
				await writeFile(
					join(wd, "codex-native-hook"),
					"require('node:fs').writeFileSync(process.env.OMX_TEST_LAUNCHER_INVOKED, 'invoked');\nprocess.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\n",
				);

				const hookResult = spawnSync(
					process.execPath,
					["--import", preloadPath, join(pluginRoot, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "unrenewed-startup-session", cwd: wd }),
						encoding: "utf-8",
						env: {
							...process.env,
							CODEX_HOME: codexHomeDir,
							OMX_NATIVE_HOOK_COMMAND: process.execPath,
							OMX_TEST_INTENT_LOCK: intentLockPath,
							OMX_TEST_MUTATION_LOCK: mutationLockPath,
							OMX_TEST_LAUNCHER_INVOKED: launcherInvokedPath,
						},
					},
				);

				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				await lstat(intentLockPath);
				await lstat(mutationLockPath);
				await assert.rejects(lstat(launcherInvokedPath), { code: "ENOENT" });
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("terminates a delegated hook after every live-cache guard is lost", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-delegate-lease-loss-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) =>
						seedManagedSnapshot(codexHomeDir, version),
					),
				);
				const pluginRoot = snapshots[0]!;
				const sessionId = "lease-loss-session";
				const delegateStartedPath = join(wd, "delegate-started");
				const delegateStoppedPath = join(wd, "delegate-stopped");
				const delegatePinRequiredPath = join(wd, "delegate-pin-required");
				const delegatePath = join(wd, "blocking-delegate.mjs");
				await writeFile(delegatePath, `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.OMX_TEST_DELEGATE_STARTED, "started");
writeFileSync(process.env.OMX_TEST_PIN_REQUIRED, process.env.OMX_PLUGIN_CACHE_PIN_REQUIRED || "missing");
process.on("SIGTERM", () => {
  writeFileSync(process.env.OMX_TEST_DELEGATE_STOPPED, "stopped");
  process.exit(0);
});
setInterval(() => {}, 1000);
process.stdin.resume();
`);
				await writeFile(
					join(pluginRoot, "hooks", "omx-command.json"),
					`${JSON.stringify({ command: process.execPath, argsPrefix: [delegatePath] })}\n`,
				);
				const routingPath = join(wd, "state", "plugin-hook-routing", "lease-loss.json");
				await mkdir(dirname(routingPath), { recursive: true });
				await writeFile(routingPath, `${JSON.stringify({ routing: "omx-plugin-hook-routing-only:v1", ownerSessionId: sessionId })}\n`);
				const versionHash = createHash("sha256").update("0.20.0").digest("hex").slice(0, 24);
				const cacheBase = omxPluginCacheBase(codexHomeDir);
				const intentLockPath = join(cacheBase, `.omx-live-pin-intent-${versionHash}.lock`);
				const mutationLockPath = livePinMutationLockPath(codexHomeDir, "0.20.0");
				const preloadPath = join(wd, "expire-live-cache-guards.mjs");
				await writeFile(preloadPath, `
import { existsSync, writeFileSync } from "node:fs";
const realSetInterval = globalThis.setInterval;
const callbacks = [];
globalThis.setInterval = function (callback, delay, ...args) {
  if (delay === 60_000) {
    callbacks.push(callback);
    return { unref() {} };
  }
  return realSetInterval(callback, delay, ...args);
};
const realNow = Date.now;
let dateOffsetMs = 0;
Date.now = () => realNow() + dateOffsetMs;
let attempts = 0;
const waitForDelegate = () => {
  if (!existsSync(process.env.OMX_TEST_DELEGATE_STARTED)) {
    attempts += 1;
    if (attempts >= 500) {
      writeFileSync(process.env.OMX_TEST_DELEGATE_DIAGNOSTIC, JSON.stringify({ callbacks: callbacks.length }));
      return;
    }
    setTimeout(waitForDelegate, 10);
    return;
  }
  dateOffsetMs = 6 * 60 * 1000;
  const lock = JSON.stringify({
    version: 1,
    pid: process.pid,
    operation: "pin",
    token: "66666666-6666-4666-8666-666666666666",
  }) + "\\n";
  writeFileSync(process.env.OMX_TEST_INTENT_LOCK, lock, { flag: "wx", mode: 0o600 });
  writeFileSync(process.env.OMX_TEST_MUTATION_LOCK, lock, { flag: "wx", mode: 0o600 });
  for (const callback of callbacks) callback();
};
setTimeout(waitForDelegate, 10);
`);
				const delegateDiagnosticPath = join(wd, "delegate-diagnostic.json");
				const hookResult = spawnSync(
					process.execPath,
					["--import", preloadPath, join(pluginRoot, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, codex_pid: process.pid, cwd: wd }),
						encoding: "utf-8",
						timeout: 15_000,
						env: {
							...process.env,
							CODEX_HOME: codexHomeDir,
							OMX_ROOT: wd,
							OMX_CODEX_LAUNCH_ID: "lease-loss",
							OMX_ENTRY_PATH: wd,
							OMX_TEST_DELEGATE_STARTED: delegateStartedPath,
							OMX_TEST_DELEGATE_STOPPED: delegateStoppedPath,
							OMX_TEST_PIN_REQUIRED: delegatePinRequiredPath,
							OMX_TEST_DELEGATE_DIAGNOSTIC: delegateDiagnosticPath,
							OMX_TEST_INTENT_LOCK: intentLockPath,
							OMX_TEST_MUTATION_LOCK: mutationLockPath,
						},
					},
				);
				const delegateStarted = await readFile(delegateStartedPath, "utf-8").catch(() => null);
				const delegateStopped = await readFile(delegateStoppedPath, "utf-8").catch(() => null);
				const delegateDiagnostic = await readFile(delegateDiagnosticPath, "utf-8").catch(() => null);
				assert.equal(
					hookResult.status,
					1,
					JSON.stringify({ error: hookResult.error?.message, stderr: hookResult.stderr, stdout: hookResult.stdout, delegateStarted, delegateStopped, delegateDiagnostic }),
				);
				assert.equal(await readFile(delegatePinRequiredPath, "utf-8"), "1");
				assert.equal(delegateStopped, "stopped");

				const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");
				assert.ok(retired.length > 0);
				// The fixture is removed only after verifying the delegated process stopped.
				await rm(pluginRoot, { recursive: true, force: true });
				await assert.rejects(lstat(pluginRoot), { code: "ENOENT" });
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("keeps an active delegate when retirement must preserve an unknown-identity pin", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-unknown-pin-lease-loss-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const pluginRoot = await seedManagedSnapshot(codexHomeDir, "0.20.0");
				const sessionId = "unknown-owner-pin-session";
				const sessionHash = createHash("sha256").update(sessionId).digest("hex");
				const pinDirectory = join(pluginRoot, ".omx-live-pin");
				await mkdir(pinDirectory);
				await writeFile(
					join(pinDirectory, `pin-${process.pid}-${sessionHash.slice(0, 24)}-unknown.json`),
					`${JSON.stringify({ version: 1, pid: process.pid, processStartHash: null, sessionHash })}\n`,
				);
				const delegateStartedPath = join(wd, "delegate-started");
				const delegateStoppedPath = join(wd, "delegate-stopped");
				const delegateFinishedPath = join(wd, "delegate-finished");
				const delegatePath = join(wd, "unknown-pin-delegate.mjs");
				await writeFile(delegatePath, `
import { existsSync, writeFileSync } from "node:fs";
writeFileSync(process.env.OMX_TEST_DELEGATE_STARTED, "started");
process.on("SIGTERM", () => {
  writeFileSync(process.env.OMX_TEST_DELEGATE_STOPPED, "stopped");
  process.exit(1);
});
const timer = setInterval(() => {
  if (!existsSync(process.env.OMX_TEST_DELEGATE_FINISHED)) return;
  clearInterval(timer);
  writeFileSync(process.env.OMX_TEST_DELEGATE_DONE, "completed");
  process.stdout.write("{}\\n");
  process.exit(0);
}, 10);
process.stdin.resume();
`);
				await writeFile(
					join(pluginRoot, "hooks", "omx-command.json"),
					`${JSON.stringify({ command: process.execPath, argsPrefix: [delegatePath] })}\n`,
				);
				const routingPath = join(wd, "state", "plugin-hook-routing", "unknown-pin.json");
				await mkdir(dirname(routingPath), { recursive: true });
				await writeFile(
					routingPath,
					`${JSON.stringify({ routing: "omx-plugin-hook-routing-only:v1", ownerSessionId: sessionId })}\n`,
				);
				const versionHash = createHash("sha256").update("0.20.0").digest("hex").slice(0, 24);
				const cacheBase = omxPluginCacheBase(codexHomeDir);
				const intentLockPath = join(cacheBase, `.omx-live-pin-intent-${versionHash}.lock`);
				const mutationLockPath = livePinMutationLockPath(codexHomeDir, "0.20.0");
				const preloadPath = join(wd, "expire-live-cache-guards.mjs");
				await writeFile(preloadPath, `
import { existsSync, writeFileSync } from "node:fs";
const realSetInterval = globalThis.setInterval;
const callbacks = [];
globalThis.setInterval = function (callback, delay, ...args) {
  if (delay === 60_000) {
    callbacks.push(callback);
    return { unref() {} };
  }
  return realSetInterval(callback, delay, ...args);
};
const realNow = Date.now;
let dateOffsetMs = 0;
Date.now = () => realNow() + dateOffsetMs;
let attempts = 0;
const waitForDelegate = () => {
  if (!existsSync(process.env.OMX_TEST_DELEGATE_STARTED)) {
    attempts += 1;
    if (attempts >= 500) return;
    setTimeout(waitForDelegate, 10);
    return;
  }
  dateOffsetMs = 6 * 60 * 1000;
  const lock = JSON.stringify({
    version: 1,
    pid: process.pid,
    operation: "pin",
    token: "77777777-7777-4777-8777-777777777777",
  }) + "\\n";
  writeFileSync(process.env.OMX_TEST_INTENT_LOCK, lock, { flag: "wx", mode: 0o600 });
  writeFileSync(process.env.OMX_TEST_MUTATION_LOCK, lock, { flag: "wx", mode: 0o600 });
  for (const callback of callbacks) callback();
  setTimeout(() => writeFileSync(process.env.OMX_TEST_DELEGATE_FINISHED, "finish"), 100);
};
setTimeout(waitForDelegate, 10);
`);
				const hookResult = spawnSync(
					process.execPath,
					["--import", preloadPath, join(pluginRoot, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, codex_pid: process.pid, cwd: wd }),
						encoding: "utf-8",
						timeout: 15_000,
						env: {
							...process.env,
							CODEX_HOME: codexHomeDir,
							OMX_ROOT: wd,
							OMX_CODEX_LAUNCH_ID: "unknown-pin",
							OMX_ENTRY_PATH: wd,
							OMX_TEST_DELEGATE_STARTED: delegateStartedPath,
							OMX_TEST_DELEGATE_STOPPED: delegateStoppedPath,
							OMX_TEST_DELEGATE_FINISHED: delegateFinishedPath,
							OMX_TEST_DELEGATE_DONE: join(wd, "delegate-done"),
							OMX_TEST_INTENT_LOCK: intentLockPath,
							OMX_TEST_MUTATION_LOCK: mutationLockPath,
						},
					},
				);
				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				await assert.rejects(lstat(delegateStoppedPath), { code: "ENOENT" });
				assert.equal(await readFile(join(wd, "delegate-done"), "utf-8"), "completed");
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("keeps an active delegate when a durable pin record is malformed", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-malformed-pin-lease-loss-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const pluginRoot = await seedManagedSnapshot(codexHomeDir, "0.20.0");
				const pinPath = await assertDelegateSurvivesLostLeasesWithPin(
					wd,
					codexHomeDir,
					pluginRoot,
					"malformed-durable-pin-session",
					"malformed-pin",
					"pin-unreadable-record.json",
					"{ malformed durable pin\n",
				);
				await rm(pinPath, { force: true });
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("refuses native hook dispatch when a required live pin cannot be recorded", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-required-session-pin-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const pluginRoot = await seedManagedSnapshot(codexHomeDir, "0.20.0");
				const payload = { hook_event_name: "UserPromptSubmit", session_id: "required-session-pin", cwd: wd };
				const env = {
					...process.env,
					CODEX_HOME: codexHomeDir,
					NODE_ENV: "test",
					OMX_PLUGIN_ROOT: pluginRoot,
					OMX_PLUGIN_CACHE_PIN_PENDING: "1",
					OMX_PLUGIN_CACHE_PIN_REQUIRED: "1",
					OMX_NATIVE_HOOK_TEST_THROW_DISPATCH: "1",
				};
				const scriptPath = join(packageRoot, "dist", "scripts", "codex-native-hook.js");
				const requiredPinResult = spawnSync(process.execPath, [scriptPath], {
					cwd: wd,
					input: JSON.stringify(payload),
					encoding: "utf-8",
					env,
				});
				assert.equal(requiredPinResult.status, 1, requiredPinResult.stderr || requiredPinResult.stdout);
				assert.equal(requiredPinResult.stdout.trim(), "{}", JSON.stringify({ error: requiredPinResult.error?.message, stderr: requiredPinResult.stderr, stdout: requiredPinResult.stdout }));
				assert.match(requiredPinResult.stderr, /refusing hook delegation/);
				assert.doesNotMatch(requiredPinResult.stderr, /test-induced dispatch failure/);

				const pinOnlyResult = spawnSync(process.execPath, [scriptPath, "--plugin-cache-pin-only"], {
					cwd: wd,
					input: JSON.stringify(payload),
					encoding: "utf-8",
					env,
				});
				assert.equal(pinOnlyResult.status, 1, pinOnlyResult.stderr || pinOnlyResult.stdout);
				assert.equal(pinOnlyResult.stdout.trim(), "{}", JSON.stringify({ error: pinOnlyResult.error?.message, stderr: pinOnlyResult.stderr, stdout: pinOnlyResult.stdout }));
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("fails closed when managed-cache identity probing fails", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-managed-cache-probe-failure-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const pluginRoot = await seedManagedSnapshot(codexHomeDir, "0.20.0");
				const preloadPath = join(wd, "fail-managed-cache-probe.mjs");
				await writeFile(preloadPath, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalLstatSync = fs.lstatSync;
fs.lstatSync = function (path, ...args) {
	if (typeof path === "string" && path === process.env.OMX_TEST_CACHE_BASE) {
		const error = new Error("injected cache-base access failure");
		error.code = "EACCES";
		throw error;
	}
	return originalLstatSync.call(this, path, ...args);
};
syncBuiltinESMExports();
`);
				const launcherInvokedPath = join(wd, "launcher-invoked-after-probe-failure");
				await writeFile(
					join(wd, "codex-native-hook"),
					"require('node:fs').writeFileSync(process.env.OMX_TEST_LAUNCHER_INVOKED, 'invoked');\nprocess.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\n",
				);

				const hookResult = spawnSync(
					process.execPath,
					["--import", preloadPath, join(pluginRoot, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "cache-probe-failure-session", cwd: wd }),
						encoding: "utf-8",
						env: {
							...process.env,
							CODEX_HOME: codexHomeDir,
							OMX_NATIVE_HOOK_COMMAND: process.execPath,
							OMX_TEST_CACHE_BASE: omxPluginCacheBase(codexHomeDir),
							OMX_TEST_LAUNCHER_INVOKED: launcherInvokedPath,
						},
					},
				);

				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				await assert.rejects(lstat(launcherInvokedPath), { code: "ENOENT" });
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("does not create live pins for doctor hook smoke runs", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-doctor-smoke-pin-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const pluginRoot = await seedManagedSnapshot(codexHomeDir, "0.20.0");
				const hookResult = spawnSync(process.execPath, [join(pluginRoot, "hooks", "codex-native-hook.mjs")], {
					cwd: wd,
					input: JSON.stringify({
						hook_event_name: "UserPromptSubmit",
						session_id: "omx-doctor-plugin-hook-smoke",
						cwd: wd,
					}),
					encoding: "utf-8",
					env: {
						...process.env,
						CODEX_HOME: codexHomeDir,
						OMX_NATIVE_HOOK_DOCTOR_SMOKE: "1",
					},
				});

				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				await assert.rejects(lstat(join(pluginRoot, ".omx-live-pin")), { code: "ENOENT" });
				await assert.rejects(
					lstat(livePinIntentPath(codexHomeDir, "0.20.0", "omx-doctor-plugin-hook-smoke")),
					{ code: "ENOENT" },
				);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("does not require managed-cache pins for routed unmanaged plugin hooks", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-unmanaged-plugin-pin-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const pluginRoot = join(wd, "local-plugin");
				const hooksDir = join(pluginRoot, "hooks");
				await mkdir(hooksDir, { recursive: true });
				await cp(
					join(packageRoot, "plugins", "oh-my-codex", "hooks", "codex-native-hook.mjs"),
					join(hooksDir, "codex-native-hook.mjs"),
				);
				const pinStatePath = join(wd, "pin-state.json");
				const helperPath = join(wd, "unmanaged-hook-helper.mjs");
				await writeFile(helperPath, `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.OMX_TEST_UNMANAGED_PIN_STATE, JSON.stringify({
  pending: process.env.OMX_PLUGIN_CACHE_PIN_PENDING ?? null,
  required: process.env.OMX_PLUGIN_CACHE_PIN_REQUIRED ?? null,
}));
process.stdout.write("{}\\n");
`);
				await writeFile(
					join(hooksDir, "omx-command.json"),
					`${JSON.stringify({ command: process.execPath, argsPrefix: [helperPath] })}\n`,
				);
				const sessionId = "unmanaged-plugin-session";
				const routingPath = join(wd, "state", "plugin-hook-routing", "unmanaged.json");
				await mkdir(dirname(routingPath), { recursive: true });
				await writeFile(
					routingPath,
					`${JSON.stringify({ routing: "omx-plugin-hook-routing-only:v1", ownerSessionId: sessionId })}\n`,
				);
				const hookResult = spawnSync(
					process.execPath,
					[join(hooksDir, "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: wd }),
						encoding: "utf-8",
						env: {
							...process.env,
							CODEX_HOME: codexHomeDir,
							OMX_ROOT: wd,
							OMX_CODEX_LAUNCH_ID: "unmanaged",
							OMX_ENTRY_PATH: wd,
							OMX_TEST_UNMANAGED_PIN_STATE: pinStatePath,
						},
					},
				);
				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				assert.deepEqual(JSON.parse(await readFile(pinStatePath, "utf-8")), { pending: null, required: null });
				await assert.rejects(lstat(join(pluginRoot, ".omx-live-pin")), { code: "ENOENT" });
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("recovers a dead sidecar lock before the wrapper opens its snapshot", {
		skip: process.platform !== "linux",
	}, async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-wrapper-dead-lock-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const pluginRoot = snapshots[0]!;
				const lock = await writeLivePinMutationLock(codexHomeDir, "0.20.0", 2_147_483_647, "retire", true);
				const sessionId = "wrapper-dead-lock-session";

				const hookResult = spawnSync(process.execPath, [join(pluginRoot, "hooks", "codex-native-hook.mjs")], {
					cwd: wd,
					input: JSON.stringify({
						hook_event_name: "SessionStart",
						session_id: sessionId,
						codex_pid: process.pid,
						cwd: wd,
					}),
					encoding: "utf-8",
					env: { ...process.env, CODEX_HOME: codexHomeDir },
				});

				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				await assert.rejects(lstat(lock.path), { code: "ENOENT" });
				await assert.rejects(lstat(lock.stagePath), { code: "ENOENT" });
				const pinDirectory = join(pluginRoot, ".omx-live-pin");
				const sessionHash = createHash("sha256").update(sessionId).digest("hex");
				const records = await Promise.all(
					(await readdir(pinDirectory)).map(
						async (name) => JSON.parse(await readFile(join(pinDirectory, name), "utf-8")) as { sessionHash: string },
					),
				);
				assert.ok(records.some((record) => record.sessionHash === sessionHash));
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("restores a snapshot if a live pin appears after it is quarantined", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-late-pin-restore-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				let interposed = false;
				const resetHooks = setPluginCacheMutationHooksForTest({
					beforeRemove: async (quarantinePath) => {
						if (interposed || !quarantinePath.includes(".0.20.0.reclaim-")) return;
						interposed = true;
						const pinDirectory = join(quarantinePath, ".omx-live-pin");
						await mkdir(pinDirectory);
						await writeFile(
							join(pinDirectory, "late-pin.json"),
							`${JSON.stringify({
								version: 1,
								pid: process.pid,
								processStartHash: null,
								sessionHash: createHash("sha256").update("late-session").digest("hex"),
							})}\n`,
						);
					},
				});
				try {
					const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");
					assert.equal(interposed, true);
					assert.equal(retired.includes(snapshots[0]!), false);
					assert.equal(retired.includes(snapshots[1]!), true);
					await lstat(snapshots[0]!);
					await assert.rejects(lstat(snapshots[1]!), { code: "ENOENT" });
				} finally {
					resetHooks();
				}
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("preserves active old-session roots and retires roots whose pin owner exited", async () => {
		const activeWd = await mkdtemp(join(tmpdir(), "omx-3790-active-pin-"));
		try {
			await withIsolatedUserHome(activeWd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) =>
						seedManagedSnapshot(codexHomeDir, version),
					),
				);
				assert.equal(
					await registerOmxPluginCacheLivePin(
						snapshots[0]!,
						"active-old-session",
						process.pid,
					),
					true,
				);
				const retired = await retireUnpinnedManagedSnapshots(
					codexHomeDir,
					"0.20.3",
				);
				assert.equal(retired.includes(snapshots[0]!), false);
				assert.equal(retired.includes(snapshots[1]!), true);
				await lstat(snapshots[0]!);
				await lstat(snapshots[2]!);
				await assert.rejects(lstat(snapshots[1]!), { code: "ENOENT" });
			});
		} finally {
			await rm(activeWd, { recursive: true, force: true });
		}

		const staleWd = await mkdtemp(join(tmpdir(), "omx-3790-stale-pin-"));
		try {
			await withIsolatedUserHome(staleWd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) =>
						seedManagedSnapshot(codexHomeDir, version),
					),
				);
				await writeDeadLivePin(snapshots[0]!);
				const retired = await retireUnpinnedManagedSnapshots(
					codexHomeDir,
					"0.20.3",
				);
				assert.equal(retired.includes(snapshots[0]!), true);
				await assert.rejects(lstat(snapshots[0]!), { code: "ENOENT" });
				await lstat(snapshots[2]!);
			});
		} finally {
			await rm(staleWd, { recursive: true, force: true });
		}
	});

	it("repairs manifest version drift from verified publication ownership without removing live pins", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-manifest-version-drift-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const packaged = await resolvePackagedOmxMarketplace(packageRoot);
				assert.ok(packaged);
				const published = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
				assert.equal(published.status, "materialized");
				const cacheDir = published.cacheDir!;
				const manifestPath = join(cacheDir, ".codex-plugin", "plugin.json");
				const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
				const expectedVersion = String(manifest.version);
				assert.equal(expectedVersion, published.version);
				assert.equal(await registerOmxPluginCacheLivePin(cacheDir, "drifted-manifest-session", process.pid), true);

				manifest.version = "corrupted-version";
				await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
				const blocked = await materializePackagedOmxPluginCache(codexHomeDir, packaged, { repairCache: true });
				assert.equal(blocked.status, "stale-launcher");
				assert.match(blocked.reason ?? "", /pinned by a live Codex session/);
				assert.equal(JSON.parse(await readFile(manifestPath, "utf-8")).version, "corrupted-version");

				await rm(join(cacheDir, ".omx-live-pin"), { recursive: true, force: true });
				const repaired = await materializePackagedOmxPluginCache(codexHomeDir, packaged, { repairCache: true });
				assert.equal(repaired.status, "materialized", JSON.stringify(repaired));
				assert.equal(repaired.version, expectedVersion);
				assert.equal(JSON.parse(await readFile(manifestPath, "utf-8")).version, expectedVersion);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("refreshes a fresh same-session pin whose live PID has stale process identity", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-fresh-stale-session-pin-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const pluginRoot = await seedManagedSnapshot(codexHomeDir, "0.20.0");
				const sessionId = "fresh-stale-session-pin";
				const sessionHash = createHash("sha256").update(sessionId).digest("hex");
				const staleProcessStartHash = "0".repeat(24);
				const pinDirectory = join(pluginRoot, ".omx-live-pin");
				await mkdir(pinDirectory);
				const stalePinPath = join(
					pinDirectory,
					`pin-${process.pid}-${sessionHash.slice(0, 24)}-${staleProcessStartHash}.json`,
				);
				await writeFile(
					stalePinPath,
					`${JSON.stringify({ version: 1, pid: process.pid, processStartHash: staleProcessStartHash, sessionHash })}\n`,
				);
				assert.ok(Date.now() - (await lstat(stalePinPath)).mtimeMs < 60_000);

				const hookResult = spawnSync(
					process.execPath,
					[join(pluginRoot, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, codex_pid: process.pid, cwd: wd }),
						encoding: "utf-8",
						env: { ...process.env, CODEX_HOME: codexHomeDir },
					},
				);
				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				const pinRecords = await Promise.all(
					(await readdir(pinDirectory))
						.filter((name) => name.startsWith("pin-"))
						.map(async (name) => JSON.parse(await readFile(join(pinDirectory, name), "utf-8")) as {
							processStartHash: string | null;
							sessionHash: string;
						}),
				);
				assert.ok(pinRecords.some((record) => record.sessionHash === sessionHash && record.processStartHash !== staleProcessStartHash));
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("retries pin registration on later hooks when a same-session PID has stale identity", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-stale-later-hook-pin-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const sessionId = "resumed-session";
				const sessionHash = createHash("sha256").update(sessionId).digest("hex");
				const staleProcessStartHash = "000000000000000000000000";
				const pinDirectory = join(snapshots[0]!, ".omx-live-pin");
				await mkdir(pinDirectory, { recursive: true });
				await writeFile(
					join(pinDirectory, "stale-reused-pid.json"),
					`${JSON.stringify({
						version: 1,
						pid: process.pid,
						processStartHash: staleProcessStartHash,
						sessionHash,
					})}\n`,
				);

				const failedStart = spawnSync(process.execPath, [join(snapshots[0]!, "hooks", "codex-native-hook.mjs")], {
					cwd: wd,
					input: JSON.stringify({
						hook_event_name: "SessionStart",
						session_id: sessionId,
						codex_pid: process.pid,
						cwd: wd,
					}),
					encoding: "utf-8",
					env: {
						...process.env,
						CODEX_HOME: codexHomeDir,
						OMX_NATIVE_HOOK_COMMAND: process.execPath,
					},
				});
				assert.equal(failedStart.status, 0, failedStart.stderr || failedStart.stdout);
				const pendingPath = livePinIntentPath(codexHomeDir, "0.20.0", sessionId);
				assert.equal(JSON.parse(await readFile(pendingPath, "utf-8")).sessionHash, sessionHash);
				const expiredAt = new Date(Date.now() - 6 * 60 * 1000);
				await utimes(pendingPath, expiredAt, expiredAt);

				const hookResult = spawnSync(process.execPath, [join(snapshots[0]!, "hooks", "codex-native-hook.mjs")], {
					cwd: wd,
					input: JSON.stringify({
						hook_event_name: "UserPromptSubmit",
						session_id: sessionId,
						codex_pid: process.pid,
						cwd: wd,
					}),
					encoding: "utf-8",
					env: { ...process.env, CODEX_HOME: codexHomeDir },
				});
				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				await assert.rejects(lstat(pendingPath), { code: "ENOENT" });
				const pinRecords = await Promise.all(
					(await readdir(pinDirectory)).map(
						async (name) =>
							JSON.parse(await readFile(join(pinDirectory, name), "utf-8")) as {
								pid: number;
								processStartHash: string | null;
								sessionHash: string;
							},
					),
				);
				assert.ok(
					pinRecords.some(
						(record) =>
							record.pid === process.pid &&
							record.sessionHash === sessionHash &&
							record.processStartHash !== staleProcessStartHash,
					),
				);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("refreshes a resumed SessionStart pin when its prior process identity is stale", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-resumed-session-pin-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const snapshots = await Promise.all(
					["0.20.0", "0.20.1", "0.20.2"].map((version) => seedManagedSnapshot(codexHomeDir, version)),
				);
				const sessionId = "resumed-session";
				const sessionHash = createHash("sha256").update(sessionId).digest("hex");
				const staleProcessStartHash = "000000000000000000000000";
				const pinDirectory = join(snapshots[0]!, ".omx-live-pin");
				await mkdir(pinDirectory, { recursive: true });
				await writeFile(
					join(pinDirectory, "stale-reused-pid.json"),
					`${JSON.stringify({
						version: 1,
						pid: process.pid,
						processStartHash: staleProcessStartHash,
						sessionHash,
					})}\n`,
				);

				const hookResult = spawnSync(
					process.execPath,
					[join(snapshots[0]!, "hooks", "codex-native-hook.mjs")],
					{
						cwd: wd,
						input: JSON.stringify({
							hook_event_name: "SessionStart",
							session_id: sessionId,
							codex_pid: process.pid,
							cwd: wd,
						}),
						encoding: "utf-8",
						env: { ...process.env, CODEX_HOME: codexHomeDir },
					},
				);
				assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
				const pinRecords = await Promise.all(
					(await readdir(pinDirectory)).map(async (name) =>
						JSON.parse(await readFile(join(pinDirectory, name), "utf-8")) as {
							pid: number;
							processStartHash: string | null;
							sessionHash: string;
						},
					),
				);
				assert.ok(pinRecords.some((record) =>
					record.pid === process.pid
					&& record.sessionHash === sessionHash
					&& record.processStartHash !== staleProcessStartHash,
				));

				const retired = await retireUnpinnedManagedSnapshots(codexHomeDir, "0.20.3");
				assert.equal(retired.includes(snapshots[0]!), false);
				assert.equal(retired.includes(snapshots[1]!), true);
				await lstat(snapshots[0]!);
				await assert.rejects(lstat(snapshots[1]!), { code: "ENOENT" });
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("retries stale same-session pins after intent-lock contention", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-session-pin-intent-contention-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const pluginRoot = await seedManagedSnapshot(codexHomeDir, "0.20.0");
				const sessionId = "intent-lock-retry-session";
				const sessionHash = createHash("sha256").update(sessionId).digest("hex");
				const pinDirectory = join(pluginRoot, ".omx-live-pin");
				await mkdir(pinDirectory);
				const staleHash = "a".repeat(24);
				await writeFile(
					join(pinDirectory, "stale-reused-pid.json"),
					`${JSON.stringify({ version: 1, pid: process.pid, processStartHash: staleHash, sessionHash })}\n`,
				);
				const cacheBase = omxPluginCacheBase(codexHomeDir);
				const versionHash = createHash("sha256").update("0.20.0").digest("hex").slice(0, 24);
				const intentLockPath = join(cacheBase, `.omx-live-pin-intent-${versionHash}.lock`);
				await writeFile(
					intentLockPath,
					`${JSON.stringify({
						version: 1,
						pid: process.pid,
						operation: "pin",
						token: "55555555-5555-4555-8555-555555555555",
					})}\n`,
				);

				const launcherPath = join(pluginRoot, "hooks", "omx-command.json");
				const originalLauncher = await readFile(launcherPath, "utf-8");
				const failedHelperPath = join(wd, "failed-pin-helper.mjs");
				await writeFile(failedHelperPath, "process.stdin.resume();\nprocess.stdin.on('end', () => { process.exitCode = 1; });\n");
				await writeFile(launcherPath, `${JSON.stringify({ command: process.execPath, argsPrefix: [failedHelperPath] })}\n`);
				const failedStart = spawnSync(process.execPath, [join(pluginRoot, "hooks", "codex-native-hook.mjs")], {
					cwd: wd,
					input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId, codex_pid: process.pid, cwd: wd }),
					encoding: "utf-8",
					env: { ...process.env, CODEX_HOME: codexHomeDir },
				});
				assert.equal(failedStart.status, 0, failedStart.stderr || failedStart.stdout);
				const retryMarkerPath = join(pinDirectory, `.pending-${sessionHash}.json`);
				assert.equal(JSON.parse(await readFile(retryMarkerPath, "utf-8")).sessionHash, sessionHash);

				await rm(intentLockPath);
				await writeFile(launcherPath, originalLauncher);
				const retriedHook = spawnSync(process.execPath, [join(pluginRoot, "hooks", "codex-native-hook.mjs")], {
					cwd: wd,
					input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, codex_pid: process.pid, cwd: wd }),
					encoding: "utf-8",
					env: { ...process.env, CODEX_HOME: codexHomeDir },
				});
				assert.equal(retriedHook.status, 0, retriedHook.stderr || retriedHook.stdout);
				await assert.rejects(lstat(retryMarkerPath), { code: "ENOENT" });
				const records = await Promise.all(
					(await readdir(pinDirectory))
						.filter((name) => name.startsWith("pin-"))
						.map(async (name) => JSON.parse(await readFile(join(pinDirectory, name), "utf-8")) as { sessionHash: string; processStartHash: string | null }),
				);
				assert.ok(records.some((record) => record.sessionHash === sessionHash && record.processStartHash !== staleHash));
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("repairs a missing manifest from the legacy numeric managed marker", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3790-legacy-managed-marker-"));
		try {
			await withIsolatedUserHome(wd, async (codexHomeDir) => {
				const packaged = await resolvePackagedOmxMarketplace(packageRoot);
				assert.ok(packaged);
				const published = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
				assert.equal(published.status, "materialized");
				const cacheDir = published.cacheDir!;
				await writeFile(join(cacheDir, ".omx-managed"), `${process.pid}\n`);
				const manifestPath = join(cacheDir, ".codex-plugin", "plugin.json");
				await rm(manifestPath);
				await writeFile(join(cacheDir, "hooks", "omx-command.json"), "stale launcher\n");

				const repaired = await materializePackagedOmxPluginCache(codexHomeDir, packaged, { repairCache: true });
				assert.equal(repaired.status, "materialized", JSON.stringify(repaired));
				const ownership = JSON.parse(await readFile(join(cacheDir, ".omx-managed"), "utf-8")) as { cacheVersion: string };
				assert.equal(ownership.cacheVersion, published.version);
				assert.equal(JSON.parse(await readFile(manifestPath, "utf-8")).version, published.version);
			});
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
});
