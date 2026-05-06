import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getSetupInstallableSkillNames } from "../installable.js";
import { readCatalogManifest } from "../reader.js";
import {
	isDirectCliInvocation,
	syncPluginMirror,
} from "../../scripts/sync-plugin-mirror.js";

const root = process.cwd();

async function copyBundleFixture(): Promise<string> {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "omx-plugin-bundle-ssot-"));
	await Promise.all([
		cp(join(root, "templates"), join(fixtureRoot, "templates"), {
			recursive: true,
		}),
		cp(join(root, "skills"), join(fixtureRoot, "skills"), { recursive: true }),
		cp(join(root, "plugins"), join(fixtureRoot, "plugins"), {
			recursive: true,
		}),
		cp(join(root, "package.json"), join(fixtureRoot, "package.json")),
	]);
	return fixtureRoot;
}

describe("plugin bundle SSOT contract", () => {
	it("detects direct CLI execution when repo paths contain spaces", () => {
		const scriptPath = join(
			tmpdir(),
			"Manual Library",
			"repo",
			"dist",
			"scripts",
			"sync-plugin-mirror.js",
		);
		const importMetaUrl = pathToFileURL(scriptPath).href;

		assert.equal(isDirectCliInvocation(importMetaUrl, scriptPath), true);
		assert.equal(isDirectCliInvocation(importMetaUrl, undefined), false);
		assert.equal(
			isDirectCliInvocation(
				importMetaUrl,
				join(tmpdir(), "other", "sync-plugin-mirror.js"),
			),
			false,
		);
	});

	it("verifies the checked-in plugin bundle mirrors canonical roots", async () => {
		const result = await syncPluginMirror({ root, check: true });
		const expectedSkillNames = [
			...getSetupInstallableSkillNames(readCatalogManifest(root)),
		].sort();

		assert.equal(result.checked, true);
		assert.equal(result.changed, false);
		assert.deepEqual(result.mirroredSkillNames, expectedSkillNames);
		assert.equal(result.mirroredSkillNames.includes("pipeline"), true);
	});

	it("fails check mode when plugin MCP metadata drifts from canonical first-party specs", async () => {
		const fixtureRoot = await copyBundleFixture();
		try {
			await writeFile(
				join(fixtureRoot, "plugins", "oh-my-codex", ".mcp.json"),
				`${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
			);

			await assert.rejects(
				() => syncPluginMirror({ root: fixtureRoot, check: true }),
				/plugin_bundle_metadata_out_of_sync[\s\S]*kind=mcp-manifest/,
			);
		} finally {
			await rm(fixtureRoot, { recursive: true, force: true });
		}
	});

	it("sync mode repairs stale plugin metadata from canonical roots", async () => {
		const fixtureRoot = await copyBundleFixture();
		try {
			await writeFile(
				join(fixtureRoot, "plugins", "oh-my-codex", ".mcp.json"),
				`${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
			);

			const syncResult = await syncPluginMirror({ root: fixtureRoot });
			const checkResult = await syncPluginMirror({
				root: fixtureRoot,
				check: true,
			});

			assert.equal(syncResult.changed, true);
			assert.equal(checkResult.checked, true);
		} finally {
			await rm(fixtureRoot, { recursive: true, force: true });
		}
	});

	it("allows catalog-deprecated root skill dirs as non-installed compatibility shims", async () => {
		const fixtureRoot = await copyBundleFixture();
		try {
			const manifestPath = join(fixtureRoot, "templates", "catalog-manifest.json");
			const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as {
				skills: Array<{ name: string; status: string; canonical?: string }>;
			};
			const skill = manifest.skills.find((entry) => entry.name === "help");
			assert.ok(skill, "fixture should include help skill");
			skill.status = "deprecated";
			skill.canonical = "omx-setup";
			await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

			const result = await syncPluginMirror({ root: fixtureRoot });
			assert.equal(result.mirroredSkillNames.includes("help"), false);

			const checkResult = await syncPluginMirror({ root: fixtureRoot, check: true });
			assert.equal(checkResult.checked, true);
		} finally {
			await rm(fixtureRoot, { recursive: true, force: true });
		}
	});

	it("fails when a root skill directory is not represented by the catalog policy", async () => {
		const fixtureRoot = await copyBundleFixture();
		try {
			await cp(
				join(fixtureRoot, "skills", "help"),
				join(fixtureRoot, "skills", "uncataloged-skill"),
				{ recursive: true },
			);

			await assert.rejects(
				() => syncPluginMirror({ root: fixtureRoot, check: true }),
				/canonical_skill_catalog_out_of_sync[\s\S]*uncataloged-skill/,
			);
		} finally {
			await rm(fixtureRoot, { recursive: true, force: true });
		}
	});
});
