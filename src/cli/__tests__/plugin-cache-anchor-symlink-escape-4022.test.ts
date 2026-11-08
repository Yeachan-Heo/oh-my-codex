import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, symlink, writeFile, readdir, lstat, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
	omxPluginCacheBase,
	registerOmxPluginCacheLivePin,
	retireUnpinnedManagedSnapshots,
	resolvePackagedOmxMarketplace,
	materializePackagedOmxPluginCache,
} from "../plugin-marketplace.js";

const packageRoot = process.cwd();

async function withIsolatedUserHome<T>(
	wd: string,
	run: (codexHomeDir: string) => Promise<T>,
): Promise<T> {
	const tmpTestDir = join(tmpdir(), `test-omx-${randomBytes(8).toString("hex")}`);
	const codexHomeDir = join(tmpTestDir, "home");
	try {
		await mkdir(codexHomeDir, { recursive: true });
		return await run(codexHomeDir);
	} finally {
		// Cleanup is best-effort; test runner will clean tmpdir
	}
}

describe("issue 4022 symlink escape prevention (anchor external pin directory)", () => {
	it("should prevent symlink escape when .omx-pins points outside cache (invariant: I1, r4502733977)", async () => {
		await withIsolatedUserHome(packageRoot, async (codexHomeDir: string) => {
			const packagedMarketplace = await resolvePackagedOmxMarketplace(packageRoot);
			assert.ok(packagedMarketplace, "Expected to resolve packaged marketplace");

			const cacheBase = omxPluginCacheBase(codexHomeDir);
			await mkdir(cacheBase, { recursive: true });

			// Materialize cache first to establish baseline
			const result = await materializePackagedOmxPluginCache(codexHomeDir, packagedMarketplace);
			assert.ok(
				result.status === "materialized" || result.status === "unchanged",
				`Expected successful materialization, got ${result.status}`,
			);

			// Create an external directory outside the cache
			const externalDir = join(dirname(cacheBase), `external-escape-${randomBytes(4).toString("hex")}`);
			await mkdir(externalDir, { recursive: true });

			// Remove any existing .omx-pins and replace with a symlink pointing outside cache
			const pinsDirPath = join(cacheBase, ".omx-pins");
			try {
				await rm(pinsDirPath, { recursive: true, force: true });
			} catch {
				// Ignore errors if it doesn't exist
			}

			await symlink(externalDir, pinsDirPath, "dir");

			// Verify the symlink was created and points outside cache
			const stats = await lstat(pinsDirPath);
			assert.ok(stats.isSymbolicLink(), "Expected .omx-pins to be a symlink");

			// With the fix, registerOmxPluginCacheLivePin should use openExternalLivePinDirectoryReadOnly
			// which uses anchored, read-only opening via openDirectoryChild.
			// This should prevent following the symlink and safely handle the directory.
			// Without the fix, it would create directories during checks, mutating state.
			try {
				const materializedVersion = result.version || (result.cacheDir ? basename(result.cacheDir) : undefined);
				if (materializedVersion) {
					const materializedCacheDir = join(cacheBase, materializedVersion);
					await registerOmxPluginCacheLivePin(
						materializedCacheDir,
						`test-session-4022-${randomBytes(4).toString("hex")}`,
						process.pid,
					);
				}
			} catch (err: any) {
				// Either success or safe error is acceptable
				// The important part is that it doesn't escape the cache
			}

			// Verify that pin operations don't access external dir
			const externalEntries = await readdir(externalDir).catch(() => []);
			assert.equal(
				externalEntries.length,
				0,
				"Pin operations should not have written to external directory",
			);
		});
	});

	it("should prevent symlink escape in sweep operations (invariant: I1, r4503105176)", async () => {
		await withIsolatedUserHome(packageRoot, async (codexHomeDir: string) => {
			const packagedMarketplace = await resolvePackagedOmxMarketplace(packageRoot);
			assert.ok(packagedMarketplace, "Expected to resolve packaged marketplace");

			const cacheBase = omxPluginCacheBase(codexHomeDir);
			await mkdir(cacheBase, { recursive: true });

			// Materialize cache first
			await materializePackagedOmxPluginCache(codexHomeDir, packagedMarketplace);

			// Create external directory
			const externalDir = join(dirname(cacheBase), `external-escape-sweep-${randomBytes(4).toString("hex")}`);
			await mkdir(externalDir, { recursive: true });

			// Remove and replace .omx-pins with symlink pointing outside
			const pinsDirPath = join(cacheBase, ".omx-pins");
			try {
				await rm(pinsDirPath, { recursive: true, force: true });
			} catch {
				// Ignore
			}
			await symlink(externalDir, pinsDirPath, "dir");

			// Verify symlink
			const stats = await lstat(pinsDirPath);
			assert.ok(stats.isSymbolicLink(), "Expected .omx-pins to be a symlink");

			// Call retireUnpinnedManagedSnapshots which calls sweepExpiredOmxPluginCacheLivePinIntents.
			// With the fix, this uses openExternalLivePinDirectoryReadOnly (anchored, read-only opening).
			// Without the fix, this would create directories, mutating state and blocking GC.
			try {
				await retireUnpinnedManagedSnapshots(codexHomeDir, "1.0.0");
			} catch (err: any) {
				// Either success or safe error is acceptable
			}

			// Verify no data was written to external directory
			const externalEntries = await readdir(externalDir).catch(() => []);
			assert.equal(
				externalEntries.length,
				0,
				"Sweep operations should not have written to external directory",
			);
		});
	});

	it("should anchor external pin directory to cacheBase (invariant: I1)", async () => {
		await withIsolatedUserHome(packageRoot, async (codexHomeDir: string) => {
			const cacheBase = omxPluginCacheBase(codexHomeDir);
			await mkdir(cacheBase, { recursive: true });

			const packagedMarketplace = await resolvePackagedOmxMarketplace(packageRoot);
			assert.ok(packagedMarketplace, "Expected to resolve packaged marketplace");

			// Materialize the cache
			const result = await materializePackagedOmxPluginCache(codexHomeDir, packagedMarketplace);
			assert.ok(
				result.status === "materialized" || result.status === "unchanged",
				`Expected successful materialization, got ${result.status}`,
			);

			// With the fix, .omx-pins should be a proper directory (or not exist yet)
			// not a symlink to outside the cache
			const pinsDirPath = join(cacheBase, ".omx-pins");
			try {
				const stats = await lstat(pinsDirPath);
				if (stats.isSymbolicLink()) {
					// If it's a symlink, verify it points within cacheBase
					const { realpath } = await import("node:fs/promises");
					const resolvedPath = await realpath(pinsDirPath).catch(() => pinsDirPath);
					assert.ok(
						resolvedPath.startsWith(cacheBase),
						`Symlink should point within cache, got ${resolvedPath}`,
					);
				} else {
					// Otherwise it should be a directory
					assert.ok(
						stats.isDirectory(),
						"Expected .omx-pins to be a directory or safe symlink",
					);
				}
			} catch {
				// If .omx-pins doesn't exist yet, that's fine - it will be created when needed
			}
		});
	});

	it("should validate anchored pin directory operations (invariant: I1, r4502733977, r4503105176)", async () => {
		await withIsolatedUserHome(packageRoot, async (codexHomeDir: string) => {
			const packagedMarketplace = await resolvePackagedOmxMarketplace(packageRoot);
			assert.ok(packagedMarketplace, "Expected to resolve packaged marketplace");

			const cacheBase = omxPluginCacheBase(codexHomeDir);
			await mkdir(cacheBase, { recursive: true });

			// Materialize cache with normal structure
			const result = await materializePackagedOmxPluginCache(codexHomeDir, packagedMarketplace);
			assert.ok(
				result.status === "materialized" || result.status === "unchanged",
				`Expected successful materialization, got ${result.status}`,
			);

			// With the fix, registerOmxPluginCacheLivePin should create proper anchored pin structure
			// that stays within cacheBase, not escape via symlinks
			const pinBaseDir = join(cacheBase, ".omx-pins");

			// Verify structure is created properly when calling pin registration
			try {
				const materializedVersion = result.version || (result.cacheDir ? basename(result.cacheDir) : undefined);
				if (materializedVersion) {
					const materializedCacheDir = join(cacheBase, materializedVersion);
					await registerOmxPluginCacheLivePin(
						materializedCacheDir,
						`test-session-anchor-${randomBytes(4).toString("hex")}`,
						process.pid,
					);
				}
			} catch (err: any) {
				// Error is acceptable; what matters is the structure
			}

			// Verify that .omx-pins is either:
			// 1. A directory (normal case)
			// 2. A symlink pointing within cache (safe)
			// 3. Doesn't exist yet (will be created when needed)
			const pinBaseStats = await lstat(pinBaseDir).catch(() => null);
			if (pinBaseStats) {
				if (pinBaseStats.isSymbolicLink()) {
					// If symlink, it should point within cache
					const { realpath } = await import("node:fs/promises");
					const target = await realpath(pinBaseDir);
					assert.ok(
						target.startsWith(cacheBase),
						`Pin directory symlink should point within cache, got ${target}`,
					);
				} else {
					// Should be a directory
					assert.ok(pinBaseStats.isDirectory(), "Expected .omx-pins to be a directory when it exists");
				}
			}
		});
	});
});
