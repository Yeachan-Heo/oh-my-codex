import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { OMX_FIRST_PARTY_MCP_SERVER_NAMES } from "../../config/omx-first-party-mcp.js";
import {
	OMX_LOCAL_MARKETPLACE_NAME,
	OMX_LOCAL_PLUGIN_CONFIG_KEY,
	discoverOmxPluginCacheDirs,
	isOmxPluginCacheVersionEntryName,
	upsertLocalOmxMarketplaceRegistration,
	upsertLocalOmxPluginEnablement,
	upsertLocalOmxPluginMcpServerEnablement,
} from "../plugin-marketplace.js";

describe("plugin cache discovery", () => {
	it("recognizes supported cache version names without accepting work artifacts", () => {
		for (const name of ["local", "0.20.5", "1.0.0-alpha.1", "1.0.0+build.7"]) {
			assert.equal(isOmxPluginCacheVersionEntryName(name), true, name);
		}
		for (const name of [".materializing-0.20.5-123", "v0.20.5", "0.20", "latest"]) {
			assert.equal(isOmxPluginCacheVersionEntryName(name), false, name);
		}
	});

	it("finds corrupt version roots by namespace and ignores materialization workdirs", async () => {
		const codexHomeDir = await mkdtemp(join(tmpdir(), "omx-plugin-discovery-"));
		try {
			const namespaceRoot = join(
				codexHomeDir,
				"plugins",
				"cache",
				"oh-my-codex-local",
				"oh-my-codex",
			);
			const corruptVersionRoot = join(namespaceRoot, "0.20.3");
			const workdir = join(namespaceRoot, ".materializing-0.20.5-123");
			await mkdir(corruptVersionRoot, { recursive: true });
			await mkdir(join(workdir, ".codex-plugin"), { recursive: true });
			await writeFile(
				join(workdir, ".codex-plugin", "plugin.json"),
				JSON.stringify({ name: "oh-my-codex", version: "0.20.5" }),
			);

			assert.deepEqual(await discoverOmxPluginCacheDirs(codexHomeDir), [
				corruptVersionRoot,
			]);
		} finally {
			await rm(codexHomeDir, { recursive: true, force: true });
		}
	});
});

function countMatches(content: string, pattern: RegExp): number {
	return [...content.matchAll(pattern)].length;
}

function applyPluginModeConfig(content: string, packageRoot: string): string {
	return upsertLocalOmxMarketplaceRegistration(
		upsertLocalOmxPluginMcpServerEnablement(
			upsertLocalOmxPluginEnablement(content),
			true,
		),
		packageRoot,
	);
}

describe("plugin marketplace config upserts", () => {
	it("keeps repeated plugin-mode setup config updates idempotent", () => {
		const packageRoot = "/tmp/oh-my-codex";
		const first = applyPluginModeConfig('model = "gpt-5.6-sol"\n', packageRoot);
		const second = applyPluginModeConfig(first, packageRoot);

		assert.equal(second, first);
		assert.equal(
			countMatches(second, /^\[marketplaces\.oh-my-codex-local\]$/gm),
			1,
		);
		assert.equal(
			countMatches(
				second,
				/^\[plugins\."oh-my-codex@oh-my-codex-local"\]$/gm,
			),
			1,
		);
		for (const serverName of OMX_FIRST_PARTY_MCP_SERVER_NAMES) {
			assert.equal(
				countMatches(
					second,
					new RegExp(
						`^\\[plugins\\.${JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.mcp_servers\\.${serverName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]$`,
						"gm",
					),
				),
				1,
				`${serverName} should be emitted once`,
			);
		}
		assert.doesNotThrow(() => TOML.parse(second));
	});

	it("normalizes legacy local plugin scalar before emitting plugin table", () => {
		const repaired = upsertLocalOmxPluginEnablement(
			[
				'model = "gpt-5.6-sol"',
				'',
				'[plugins]',
				`"${OMX_LOCAL_PLUGIN_CONFIG_KEY}" = true`,
				'other-plugin = true',
				'',
			].join("\n"),
		);

		assert.doesNotThrow(() => TOML.parse(repaired));
		assert.doesNotMatch(repaired, new RegExp(`^"${OMX_LOCAL_PLUGIN_CONFIG_KEY}"\\s*=`, "m"));
		assert.match(repaired, /^other-plugin = true$/m);
		assert.equal(
			countMatches(
				repaired,
				/^\[plugins\."oh-my-codex@oh-my-codex-local"\]$/gm,
			),
			1,
		);
	});

	it("dedupes existing local marketplace and plugin MCP blocks without removing unrelated config", () => {
		const packageRoot = "/tmp/oh-my-codex-new";
		const duplicated = [
			'model = "gpt-5.6-sol"',
			'',
			'[mcp_servers.user_tool]',
			'command = "user-tool"',
			'',
			`[plugins.${JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY)}]`,
			'enabled = false',
			'',
			`[plugins.${JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY)}]`,
			'enabled = false',
			'',
			`[plugins.${JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY)}.mcp_servers.omx_state]`,
			'enabled = false',
			'',
			`[plugins.${JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY)}.mcp_servers.omx_state]`,
			'enabled = false',
			'',
			`[marketplaces.${OMX_LOCAL_MARKETPLACE_NAME}]`,
			'source_type = "local"',
			'source = "/tmp/old"',
			'',
			`[marketplaces.${OMX_LOCAL_MARKETPLACE_NAME}]`,
			'source_type = "local"',
			'source = "/tmp/older"',
			'',
		].join("\n");

		assert.throws(() => TOML.parse(duplicated), /redefine|duplicate/i);

		const repaired = applyPluginModeConfig(duplicated, packageRoot);

		assert.doesNotThrow(() => TOML.parse(repaired));
		assert.match(repaired, /^\[mcp_servers\.user_tool\]$/m);
		assert.match(repaired, /^command = "user-tool"$/m);
		assert.equal(
			countMatches(repaired, /^\[marketplaces\.oh-my-codex-local\]$/gm),
			1,
		);
		assert.match(repaired, new RegExp(`^source = ${JSON.stringify(packageRoot)}$`, "m"));
		assert.equal(
			countMatches(
				repaired,
				/^\[plugins\."oh-my-codex@oh-my-codex-local"\.mcp_servers\.omx_state\]$/gm,
			),
			1,
		);
	});
});
