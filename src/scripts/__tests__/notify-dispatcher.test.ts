import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

describe("notify dispatcher", () => {
	it("skips managed OMX notify commands stored as previous notify", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-notify-dispatcher-"));
		try {
			const dispatcher = join(
				process.cwd(),
				"dist",
				"scripts",
				"notify-dispatcher.js",
			);
			const managedPrevious = join(
				wd,
				"old",
				"node_modules",
				"oh-my-codex",
				"dist",
				"scripts",
				"notify-dispatcher.js",
			);
			const omxNotify = join(wd, "omx-notify.js");
			const previousMarker = join(wd, "previous-ran");
			const omxMarker = join(wd, "omx-ran");
			const metadataPath = join(wd, "notify-dispatch.json");

			await mkdir(join(managedPrevious, ".."), { recursive: true });
			await writeFile(
				managedPrevious,
				`require("node:fs").writeFileSync(${JSON.stringify(previousMarker)}, "ran");\n`,
			);
			await writeFile(
				omxNotify,
				`require("node:fs").writeFileSync(${JSON.stringify(omxMarker)}, "ran");\n`,
			);
			await writeFile(
				metadataPath,
				JSON.stringify({
					previousNotify: ["node", managedPrevious],
					omxNotify: ["node", omxNotify],
				}),
			);

			const result = spawnSync(
				process.execPath,
				[dispatcher, "--metadata", metadataPath, "{}"],
				{ encoding: "utf-8" },
			);

			assert.equal(result.status, 0);
			await assert.rejects(readFile(previousMarker, "utf-8"));
			assert.equal(await readFile(omxMarker, "utf-8"), "ran");
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
});
