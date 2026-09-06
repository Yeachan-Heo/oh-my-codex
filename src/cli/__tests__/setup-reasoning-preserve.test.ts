import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { buildMergedConfig } from "../../config/generator.js";
import { setup } from "../setup.js";
import { upsertTopLevelTomlString } from "../../utils/toml.js";

/**
 * Regression coverage for issue #3630:
 * `omx setup` must preserve an existing root `model_reasoning_effort`
 * (explicit user edit or `omx reasoning <mode>`) while still seeding the
 * `medium` default when the key is absent.
 */

interface IsolatedHome {
	wd: string;
	home: string;
	codexHome: string;
	configPath: string;
	restore: () => void;
}


async function createIsolatedHome(prefix: string): Promise<IsolatedHome> {
	const wd = await mkdtemp(join(tmpdir(), `${prefix}-`));
	const home = join(wd, "home");
	const codexHome = join(home, ".codex");
	await mkdirRecursive(codexHome);
	const previous = {
		HOME: process.env.HOME,
		CODEX_HOME: process.env.CODEX_HOME,
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
	};
	process.env.HOME = home;
	process.env.CODEX_HOME = codexHome;
	process.env.XDG_CONFIG_HOME = join(home, ".config");
	return {
		wd,
		home,
		codexHome,
		configPath: join(codexHome, "config.toml"),
		restore: () => {
			if (previous.HOME !== undefined) process.env.HOME = previous.HOME;
			else delete process.env.HOME;
			if (previous.CODEX_HOME !== undefined) {
				process.env.CODEX_HOME = previous.CODEX_HOME;
			} else {
				delete process.env.CODEX_HOME;
			}
			if (previous.XDG_CONFIG_HOME !== undefined) {
				process.env.XDG_CONFIG_HOME = previous.XDG_CONFIG_HOME;
			} else {
				delete process.env.XDG_CONFIG_HOME;
			}
		},
	};
}

async function mkdirRecursive(dir: string): Promise<void> {
	const { mkdir } = await import("node:fs/promises");
	await mkdir(dir, { recursive: true });
}

const MANAGED_EFFORT_DEFAULT = "medium";

describe("buildMergedConfig reasoning effort ownership (issue #3630)", () => {
	it("does not preserve by default (legacy callers keep the managed default)", () => {
		const existing = [
			"model_reasoning_effort = \"high\"",
			"",
			"[features]",
			"hooks = true",
			"",
		].join("\n");
		const merged = buildMergedConfig(existing, "/tmp/omx-test-root", {
			includeTui: false,
		});
		const parsed = TOML.parse(merged) as { model_reasoning_effort?: string };
		assert.equal(parsed.model_reasoning_effort, MANAGED_EFFORT_DEFAULT);
	});

	it("preserves an existing non-default root effort when asked", () => {
		const existing = [
			"model_reasoning_effort = \"xhigh\"",
			"",
			"[features]",
			"hooks = true",
			"",
		].join("\n");
		const merged = buildMergedConfig(existing, "/tmp/omx-test-root", {
			includeTui: false,
			preserveReasoningEffort: true,
		});
		const parsed = TOML.parse(merged) as { model_reasoning_effort?: string };
		assert.equal(parsed.model_reasoning_effort, "xhigh");
	});

	it("preserves the exact raw TOML value, including invalid values (honest hand-off)", () => {
		const existing = [
			"model_reasoning_effort = 'low'",
			"",
			"[features]",
			"hooks = true",
			"",
		].join("\n");
		const merged = buildMergedConfig(existing, "/tmp/omx-test-root", {
			includeTui: false,
			preserveReasoningEffort: true,
		});
		assert.match(
			merged,
			/^model_reasoning_effort = 'low'$/m,
			"raw user-owned spelling must survive verbatim",
		);
	});

	it("seeds the managed default when the key is absent even with preserve enabled", () => {
		const existing = [
			"model = \"gpt-5.6-sol\"",
			"",
			"[features]",
			"hooks = true",
			"",
		].join("\n");
		const merged = buildMergedConfig(existing, "/tmp/omx-test-root", {
			includeTui: false,
			preserveReasoningEffort: true,
		});
		const parsed = TOML.parse(merged) as { model_reasoning_effort?: string };
		assert.equal(parsed.model_reasoning_effort, MANAGED_EFFORT_DEFAULT);
	});

	it("keeps [profiles.*] reasoning values intact while preserving the root key", () => {
		const existing = [
			"model_reasoning_effort = \"high\"",
			"",
			"[profiles.research]",
			"model = \"gpt-5.6-terra\"",
			"model_reasoning_effort = \"low\"",
			"",
			"[features]",
			"hooks = true",
			"",
		].join("\n");
		const merged = buildMergedConfig(existing, "/tmp/omx-test-root", {
			includeTui: false,
			preserveReasoningEffort: true,
		});
		const parsed = TOML.parse(merged) as {
			model_reasoning_effort?: string;
			profiles?: Record<string, { model_reasoning_effort?: string }>;
		};
		assert.equal(parsed.model_reasoning_effort, "high");
		assert.equal(parsed.profiles?.research?.model_reasoning_effort, "low");
	});

	it("produces exactly one root effort key after a refresh", () => {
		const existing = [
			"# oh-my-codex top-level settings (must be before any [table])",
			"notify = false",
			"model_reasoning_effort = \"high\"",
			"developer_instructions = \"custom\"",
			"",
			"[features]",
			"hooks = true",
			"",
		].join("\n");
		const merged = buildMergedConfig(existing, "/tmp/omx-test-root", {
			includeTui: false,
			preserveReasoningEffort: true,
		});
		const rootMatches = merged.match(/^model_reasoning_effort\s*=/gm) ?? [];
		assert.equal(rootMatches.length, 1);
	});
});

describe("omx setup preserves user reasoning effort (issue #3630)", () => {
	const homes: IsolatedHome[] = [];

	after(async () => {
		for (const home of homes.splice(0)) {
			home.restore();
			await rm(home.wd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	});

	it("keeps a non-default value across repeated setup runs", async () => {
		const home = await createIsolatedHome("omx3630-nondefault-");
		homes.push(home);
		try {
			await setup({ scope: "user", mergeAgents: true, installMode: "legacy" });
			let content = await readFile(home.configPath, "utf-8");
			content = upsertTopLevelTomlString(
				content,
				"model_reasoning_effort",
				"high",
			);
			await writeFile(home.configPath, content);

			await setup({ scope: "user", mergeAgents: true, installMode: "legacy" });
			await setup({ scope: "user", mergeAgents: true, installMode: "legacy" });

			const parsed = TOML.parse(
				await readFile(home.configPath, "utf-8"),
			) as { model_reasoning_effort?: string };
			assert.equal(
				parsed.model_reasoning_effort,
				"high",
				"`omx reasoning high` must survive repeated setup/update",
			);
		} finally {
			// cleanup happens in `after`
		}
	});

	it("seeds the managed default on fresh setups (missing default)", async () => {
		const home = await createIsolatedHome("omx3630-fresh-");
		homes.push(home);
		await setup({ scope: "user", mergeAgents: true, installMode: "legacy" });
		assert.ok(existsSync(home.configPath), "fresh setup must create config.toml");
		const parsed = TOML.parse(
			await readFile(home.configPath, "utf-8"),
		) as { model_reasoning_effort?: string };
		assert.equal(parsed.model_reasoning_effort, MANAGED_EFFORT_DEFAULT);
	});

	it("preserves a directly hand-edited non-default value through setup", async () => {
		const home = await createIsolatedHome("omx3630-handedit-");
		homes.push(home);
		await writeFile(
			home.configPath,
			[
				"model = \"gpt-5.6-sol\"",
				"model_reasoning_effort = \"low\"",
				"",
			].join("\n"),
		);
		await setup({ scope: "user", mergeAgents: true, installMode: "legacy" });
		const parsed = TOML.parse(
			await readFile(home.configPath, "utf-8"),
		) as { model_reasoning_effort?: string };
		assert.equal(parsed.model_reasoning_effort, "low");
	});
});
