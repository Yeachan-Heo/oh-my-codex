import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, it } from "node:test";
import { computeOmxPluginCacheClaimDigest } from "../plugin-marketplace.js";

/**
 * Regression test for issue #3898:
 * Verify that creating pins in the external location (.omx-pins/) does NOT
 * change the Codex content hash of the plugin directory.
 */
describe("issue 3898: Codex content hash regression", () => {
	it("does not change plugin content hash when pins are created in external location", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-3898-hash-"));
		try {
			// Create a minimal plugin structure
			const pluginRoot = join(wd, "plugin");
			await mkdir(pluginRoot, { recursive: true });

			// Create required plugin files
			await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
			await writeFile(
				join(pluginRoot, ".codex-plugin", "plugin.json"),
				JSON.stringify({
					name: "test-plugin",
					version: "1.0.0",
					skills: "./skills/",
					hooks: "./hooks/",
				}, null, 2),
			);

			await mkdir(join(pluginRoot, "hooks"), { recursive: true });
			await writeFile(join(pluginRoot, "hooks", "test.mjs"), "export default {};");

			// Compute initial hash
			const hashBefore = await computeOmxPluginCacheClaimDigest(pluginRoot);
			console.log(`Hash before pins: ${hashBefore}`);

			// Create pins in the EXTERNAL location (not inside the plugin directory)
			const externalPinDir = join(wd, ".omx-pins", "1.0.0");
			await mkdir(externalPinDir, { recursive: true });

			// Write multiple pin files
			for (let i = 0; i < 3; i++) {
				const pinRecord = {
					version: 1,
					pid: process.pid + i,
					processStartHash: createHash("sha256").update(`proc-${i}`).digest("hex"),
					sessionHash: createHash("sha256").update(`session-${i}`).digest("hex"),
				};
				await writeFile(
					join(externalPinDir, `pin-${i}.json`),
					JSON.stringify(pinRecord) + "\n",
				);
			}

			// Compute hash after creating external pins
			const hashAfter = await computeOmxPluginCacheClaimDigest(pluginRoot);
			console.log(`Hash after external pins: ${hashAfter}`);

			// Verify hashes are identical
			assert.equal(
				hashAfter,
				hashBefore,
				"Plugin content hash should not change when pins are stored externally",
			);
	} finally {
		await rm(wd, { recursive: true, force: true });
		}
	});
});
