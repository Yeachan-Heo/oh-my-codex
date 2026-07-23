import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..", "..");
const omxBin = join(repoRoot, "dist", "cli", "omx.js");

describe("tmux-hook CLI", () => {
	it("keeps status read-only when no tmux-hook configuration exists", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omx-tmux-hook-status-pure-"));
		try {
			const result = spawnSync(
				process.execPath,
				[omxBin, "tmux-hook", "status"],
				{
					cwd,
					encoding: "utf-8",
					env: {
						...process.env,
						OMX_AUTO_UPDATE: "0",
						OMX_NOTIFY_FALLBACK: "0",
						OMX_HOOK_DERIVED_SIGNALS: "0",
					},
				},
			);

			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.match(result.stdout, /Config: missing/);
			assert.match(result.stdout, /Run: omx tmux-hook init/);
			assert.equal(existsSync(join(cwd, ".omx")), false);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
