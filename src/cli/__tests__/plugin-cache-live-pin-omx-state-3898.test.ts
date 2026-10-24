import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, it, before, after } from "node:test";
import {
	materializePackagedOmxPluginCache,
	omxPluginCacheBase,
	registerOmxPluginCacheLivePin,
	resolvePackagedOmxMarketplace,
} from "../plugin-marketplace.js";

const packageRoot = process.cwd();
const packageVersion = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as { version: string };

/**
 * Issue #3898: Verify that live pin files are written to OMX-owned state directory,
 * not inside the plugin cache directory.
 *
 * Codex 0.164.0 binds hook approval to plugin contents hash. Writing pin files
 * inside the cache invalidates approvals on every run. The fix moves pins to
 * ~/.omx/plugin-cache-live-pins/, outside the cache tree that Codex hashes.
 */
describe("issue 3898 - live pins moved out of plugin cache", () => {
	let testDir: string;

	before(async () => {
		testDir = join(tmpdir(), `omx-test-${randomUUID()}`);
		await mkdir(testDir, { recursive: true });
	});

	after(async () => {
		try {
			await rm(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	it("registerOmxPluginCacheLivePin does not create .omx-live-pin inside plugin cache", async () => {
		const tempHome = join(testDir, `home-${randomUUID()}`);
		await mkdir(tempHome, { recursive: true });

		const codexHomeDir = tempHome;
		const originalCodexHome = process.env.CODEX_HOME;
		try {
			process.env.CODEX_HOME = codexHomeDir;

			const packagedMarketplace = await resolvePackagedOmxMarketplace(packageRoot);
			assert.ok(packagedMarketplace, "Expected packaged marketplace");

			const result = await materializePackagedOmxPluginCache(codexHomeDir, packagedMarketplace, {
				teamMode: undefined,
			});
			assert.ok(result.status === "materialized" || result.status === "unchanged", "Failed to materialize cache");

			const cacheBase = omxPluginCacheBase(codexHomeDir);
			const pluginRoot = join(cacheBase, packageVersion.version);
			const legacyPinDir = join(pluginRoot, ".omx-live-pin");

			// Register a live pin
			const sessionId = `test-session-${randomUUID()}`;
			const ownerPid = process.pid;
			const registered = await registerOmxPluginCacheLivePin(pluginRoot, sessionId, ownerPid);
			assert.ok(registered, "Failed to register live pin");

			// Verify .omx-live-pin directory was NOT created inside plugin cache
			try {
				const stat = await (await import("node:fs/promises")).stat(legacyPinDir);
				assert.fail(
					`Legacy pin directory should not exist at ${legacyPinDir}. ` +
						`Pin files must be in OMX-owned state (~/.omx/plugin-cache-live-pins/) ` +
						`to avoid invalidating Codex hook approvals.`,
				);
			} catch (error) {
				// Expected: directory should not exist
				const err = error as NodeJS.ErrnoException;
				assert.equal(
					err.code,
					"ENOENT",
					`Expected ENOENT when checking legacy pin directory, got: ${err.code}`,
				);
			}

			// Verify that plugin cache contents hash is not affected by pin registration
			// (This is verified indirectly by the absence of pin files in the cache)
		} finally {
			if (originalCodexHome !== undefined) {
				process.env.CODEX_HOME = originalCodexHome;
			} else {
				delete process.env.CODEX_HOME;
			}
		}
	});
});
