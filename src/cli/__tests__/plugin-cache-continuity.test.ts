import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	materializePackagedOmxPluginCache,
	pluginCacheContentsMatchPackaged,
	refreshPackagedOmxPluginCacheInPlace,
	resolvePackagedOmxMarketplace,
} from "../plugin-marketplace.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface HookRunResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

function cleanHookEnvironment(stateRoot: string): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const name of [
		"CODEX_THREAD_ID",
		"OMX_SESSION_ID",
		"OMX_STATE_ROOT",
		"OMX_TEAM_STATE_ROOT",
		"OMX_NATIVE_HOOK_COMMAND",
	]) delete env[name];
	return {
		...env,
		OMX_AUTO_UPDATE: "0",
		OMX_ROOT: stateRoot,
		OMX_CODEX_LAUNCH_ID: "plugin-cache-continuity",
		OMX_ENTRY_PATH: join(packageRoot, "dist", "cli", "omx.js"),
		OMX_HOOK_DERIVED_SIGNALS: "0",
		OMX_NOTIFY_FALLBACK: "0",
	};
}

function runPluginHook(
	hookPath: string,
	cwd: string,
	stateRoot: string,
): Promise<HookRunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [hookPath], {
			cwd,
			env: cleanHookEnvironment(stateRoot),
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, 10_000);
		child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timeout);
			resolve({
				code,
				signal,
				stdout: Buffer.concat(stdout).toString("utf-8"),
				stderr: `${Buffer.concat(stderr).toString("utf-8")}${timedOut ? "hook execution timed out\n" : ""}`,
			});
		});
		child.stdin.end(`${JSON.stringify({
			hook_event_name: "UserPromptSubmit",
			session_id: "plugin-cache-continuity-session",
			cwd,
		})}\n`);
	});
}

describe("plugin cache continuity", () => {
	it("keeps the pinned root and native hook launcher usable throughout concurrent refreshes", { timeout: 30_000 }, async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-plugin-cache-continuity-"));
		try {
			const codexHomeDir = join(wd, "codex-home");
			const stateRoot = join(wd, "state-root");
			const packagedMarketplace = await resolvePackagedOmxMarketplace(packageRoot);
			assert.ok(packagedMarketplace);
			const materialized = await materializePackagedOmxPluginCache(
				codexHomeDir,
				packagedMarketplace,
			);
			assert.ok(materialized.cacheDir);
			const cacheDir = materialized.cacheDir;
			const hookPath = join(cacheDir, "hooks", "codex-native-hook.mjs");
			const initialRoot = await lstat(cacheDir);

			let keepReading = true;
			let hookRunInFlight = false;
			let readCount = 0;
			const hookFailures: HookRunResult[] = [];
			let markReaderReady: (() => void) | undefined;
			const readerReady = new Promise<void>((resolveReady) => {
				markReaderReady = resolveReady;
			});
			const reader = (async () => {
				do {
					hookRunInFlight = true;
					const result = await runPluginHook(hookPath, wd, stateRoot);
					hookRunInFlight = false;
					readCount += 1;
					if (result.code !== 0 || result.signal !== null) hookFailures.push(result);
					if (readCount === 1) markReaderReady?.();
				} while (keepReading || readCount < 4);
			})();

			await readerReady;
			assert.equal(hookRunInFlight, true);
			let refreshError: unknown;
			try {
				await Promise.all(Array.from({ length: 6 }, () =>
					refreshPackagedOmxPluginCacheInPlace(cacheDir, packagedMarketplace),
				));
			} catch (error) {
				refreshError = error;
			} finally {
				keepReading = false;
			}
			await reader;
			if (refreshError !== undefined) throw refreshError;

			const finalRoot = await lstat(cacheDir);
			assert.equal(finalRoot.dev, initialRoot.dev);
			assert.equal(finalRoot.ino, initialRoot.ino);
			assert.ok(readCount >= 4);
			assert.deepEqual(hookFailures, []);
			assert.equal(
				await readFile(hookPath, "utf-8"),
				await readFile(join(packagedMarketplace.pluginRoot, "hooks", "codex-native-hook.mjs"), "utf-8"),
			);
			assert.equal(
				await pluginCacheContentsMatchPackaged(cacheDir, packagedMarketplace),
				true,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("recovers namespace locks whose owner and reaper records are missing or malformed", { timeout: 10_000 }, async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-plugin-cache-invalid-lock-"));
		try {
			const packagedMarketplace = await resolvePackagedOmxMarketplace(packageRoot);
			assert.ok(packagedMarketplace);
			for (const [name, ownerJson, reaperJson] of [
				["missing", null, null],
				["invalid-json", "{not-json\n", null],
				["invalid-schema", `${JSON.stringify({ token: 42, pid: "wrong" })}\n`, null],
				["out-of-range-pid", `${JSON.stringify({ token: "invalid", pid: 0x80000000 })}\n`, null],
				["empty-token", `${JSON.stringify({ token: "", pid: process.pid })}\n`, null],
				["invalid-reaper", null, "{bad-reaper\n"],
			] as const) {
				const codexHomeDir = join(wd, name, "codex-home");
				const materialized = await materializePackagedOmxPluginCache(
					codexHomeDir,
					packagedMarketplace,
				);
				assert.ok(materialized.cacheDir);
				const cacheDir = materialized.cacheDir;
				const lockPath = `${dirname(cacheDir)}.omx-refresh.lock`;
				const sentinelPath = join(cacheDir, "sentinel.txt");
				const initialRoot = await lstat(cacheDir);
				await writeFile(sentinelPath, "remove during refresh\n");
				await mkdir(lockPath);
				if (ownerJson !== null) {
					await writeFile(join(lockPath, "owner.json"), ownerJson);
				}
				if (reaperJson !== null) {
					await writeFile(join(lockPath, "reaper.json"), reaperJson);
				}

				await refreshPackagedOmxPluginCacheInPlace(cacheDir, packagedMarketplace);
				const finalRoot = await lstat(cacheDir);
				assert.equal(finalRoot.dev, initialRoot.dev, name);
				assert.equal(finalRoot.ino, initialRoot.ino, name);
				await assert.rejects(readFile(sentinelPath, "utf-8"), { code: "ENOENT" });
				await assert.rejects(lstat(lockPath), { code: "ENOENT" });
				assert.equal(
					await pluginCacheContentsMatchPackaged(cacheDir, packagedMarketplace),
					true,
					name,
				);
				const namespaceRoot = dirname(cacheDir);
				assert.deepEqual(
					(await readdir(dirname(namespaceRoot))).filter((entry) =>
						entry.startsWith(`${basename(namespaceRoot)}.omx-refresh.lock`)
					),
					[],
					name,
				);
			}
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("refuses a non-directory namespace lock without modifying it", { timeout: 10_000 }, async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-plugin-cache-file-lock-"));
		try {
			const codexHomeDir = join(wd, "codex-home");
			const packagedMarketplace = await resolvePackagedOmxMarketplace(packageRoot);
			assert.ok(packagedMarketplace);
			const materialized = await materializePackagedOmxPluginCache(
				codexHomeDir,
				packagedMarketplace,
			);
			assert.ok(materialized.cacheDir);
			const cacheDir = materialized.cacheDir;
			const lockPath = `${dirname(cacheDir)}.omx-refresh.lock`;
			const initialRoot = await lstat(cacheDir);
			await writeFile(lockPath, "foreign lock occupant\n");

			await assert.rejects(
				refreshPackagedOmxPluginCacheInPlace(cacheDir, packagedMarketplace),
				/non-directory OMX plugin cache refresh lock/,
			);
			const finalRoot = await lstat(cacheDir);
			assert.equal(finalRoot.dev, initialRoot.dev);
			assert.equal(finalRoot.ino, initialRoot.ino);
			assert.equal(await readFile(lockPath, "utf-8"), "foreign lock occupant\n");
			assert.equal(
				await pluginCacheContentsMatchPackaged(cacheDir, packagedMarketplace),
				true,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("serializes parent and nested version refreshes on one namespace lock", { timeout: 30_000 }, async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-plugin-cache-nested-lock-"));
		try {
			const codexHomeDir = join(wd, "codex-home");
			const packagedMarketplace = await resolvePackagedOmxMarketplace(packageRoot);
			assert.ok(packagedMarketplace);
			const materialized = await materializePackagedOmxPluginCache(
				codexHomeDir,
				packagedMarketplace,
			);
			assert.ok(materialized.cacheDir);
			const parentCacheDir = materialized.cacheDir;
			const nestedCacheDir = join(parentCacheDir, "0.0.1");
			await cp(packagedMarketplace.pluginRoot, nestedCacheDir, { recursive: true });
			await cp(
				join(parentCacheDir, "hooks", "omx-command.json"),
				join(nestedCacheDir, "hooks", "omx-command.json"),
			);
			const initialParent = await lstat(parentCacheDir);
			const initialNested = await lstat(nestedCacheDir);
			const namespaceRoot = dirname(parentCacheDir);
			const canonicalLockPath = `${namespaceRoot}.omx-refresh.lock`;
			const obsoleteNestedLockPath = `${parentCacheDir}.omx-refresh.lock`;
			await mkdir(canonicalLockPath);
			await writeFile(join(canonicalLockPath, "owner.json"), "{invalid-canonical-owner\n");

			await refreshPackagedOmxPluginCacheInPlace(
				nestedCacheDir,
				packagedMarketplace,
			);
			await assert.rejects(lstat(canonicalLockPath), { code: "ENOENT" });
			await assert.rejects(lstat(obsoleteNestedLockPath), { code: "ENOENT" });

			await Promise.all(Array.from({ length: 8 }, (_, index) =>
				refreshPackagedOmxPluginCacheInPlace(
					index % 2 === 0 ? parentCacheDir : nestedCacheDir,
					packagedMarketplace,
				),
			));

			const finalParent = await lstat(parentCacheDir);
			const finalNested = await lstat(nestedCacheDir);
			assert.equal(finalParent.dev, initialParent.dev);
			assert.equal(finalParent.ino, initialParent.ino);
			assert.equal(finalNested.dev, initialNested.dev);
			assert.equal(finalNested.ino, initialNested.ino);
			assert.equal(
				await pluginCacheContentsMatchPackaged(parentCacheDir, packagedMarketplace),
				true,
			);
			assert.equal(
				await pluginCacheContentsMatchPackaged(nestedCacheDir, packagedMarketplace),
				true,
			);
			assert.deepEqual(
				(await readdir(parentCacheDir)).filter((entry) => entry.includes(".omx-refresh.lock")),
				[],
			);
			await assert.rejects(lstat(canonicalLockPath), { code: "ENOENT" });
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
});
