import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function runDispatcher(metadataPath: string): void {
	const dispatcherScript = join(process.cwd(), "dist", "scripts", "notify-dispatcher.js");
	const result = spawnSync(
		process.execPath,
		[dispatcherScript, "--metadata", metadataPath, JSON.stringify({ type: "test" })],
		{ encoding: "utf-8", windowsHide: true },
	);
	assert.equal(result.status, 0, result.stderr || result.stdout);
}

describe("notify dispatcher previousNotify guard", () => {
	it("skips stale OMX-managed previousNotify dispatcher entries", () => {
		const wd = mkdtempSync(join(tmpdir(), "omx-notify-dispatcher-stale-"));
		try {
			const oldPkgScripts = join(wd, "global", "oh-my-codex", "dist", "scripts");
			mkdirSync(oldPkgScripts, { recursive: true });
			const stalePreviousMarker = join(wd, "stale-previous-ran");
			const omxMarker = join(wd, "omx-ran");
			const staleDispatcher = join(oldPkgScripts, "notify-dispatcher.js");
			const omxHook = join(wd, "current-notify-hook.js");
			writeFileSync(staleDispatcher, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(stalePreviousMarker)}, "ran");\n`);
			writeFileSync(omxHook, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(omxMarker)}, "ran");\n`);
			const metadataPath = join(wd, "notify-dispatch.json");
			writeFileSync(
				metadataPath,
				JSON.stringify({
					managedBy: "oh-my-codex",
					version: 1,
					previousNotify: [process.execPath, staleDispatcher, "--metadata", metadataPath],
					omxNotify: [process.execPath, omxHook],
					dispatcherNotify: [
						process.execPath,
						join(process.cwd(), "dist", "scripts", "notify-dispatcher.js"),
						"--metadata",
						metadataPath,
					],
				}),
			);

			runDispatcher(metadataPath);

			assert.equal(existsSync(stalePreviousMarker), false);
			assert.equal(readFileSync(omxMarker, "utf-8"), "ran");
		} finally {
			rmSync(wd, { recursive: true, force: true });
		}
	});

	it("skips stale OMX-managed previousNotify dispatcher entries behind node flags", () => {
		const wd = mkdtempSync(join(tmpdir(), "omx-notify-dispatcher-flagged-stale-"));
		try {
			const oldPkgScripts = join(wd, "global", "oh-my-codex", "dist", "scripts");
			mkdirSync(oldPkgScripts, { recursive: true });
			const stalePreviousMarker = join(wd, "stale-previous-ran");
			const omxMarker = join(wd, "omx-ran");
			const staleDispatcher = join(oldPkgScripts, "notify-dispatcher.js");
			const omxHook = join(wd, "current-notify-hook.js");
			writeFileSync(staleDispatcher, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(stalePreviousMarker)}, "ran");\n`);
			writeFileSync(omxHook, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(omxMarker)}, "ran");\n`);
			const metadataPath = join(wd, "notify-dispatch.json");
			writeFileSync(
				metadataPath,
				JSON.stringify({
					managedBy: "oh-my-codex",
					version: 1,
					previousNotify: [
						process.execPath,
						"--no-warnings",
						staleDispatcher,
						"--metadata",
						metadataPath,
					],
					omxNotify: [process.execPath, omxHook],
				}),
			);

			runDispatcher(metadataPath);

			assert.equal(existsSync(stalePreviousMarker), false);
			assert.equal(readFileSync(omxMarker, "utf-8"), "ran");
		} finally {
			rmSync(wd, { recursive: true, force: true });
		}
	});

	it("preserves and runs real user previousNotify entries", () => {
		const wd = mkdtempSync(join(tmpdir(), "omx-notify-dispatcher-user-"));
		try {
			const userMarker = join(wd, "user-ran");
			const omxMarker = join(wd, "omx-ran");
			const userScript = join(wd, "user-notify.js");
			const omxHook = join(wd, "current-notify-hook.js");
			writeFileSync(userScript, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(userMarker)}, "ran");\n`);
			writeFileSync(omxHook, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(omxMarker)}, "ran");\n`);
			const metadataPath = join(wd, "notify-dispatch.json");
			writeFileSync(
				metadataPath,
				JSON.stringify({
					managedBy: "oh-my-codex",
					version: 1,
					previousNotify: [process.execPath, userScript],
					omxNotify: [process.execPath, omxHook],
				}),
			);

			runDispatcher(metadataPath);

			assert.equal(readFileSync(userMarker, "utf-8"), "ran");
			assert.equal(readFileSync(omxMarker, "utf-8"), "ran");
		} finally {
			rmSync(wd, { recursive: true, force: true });
		}
	});

	it("does not mistake real user notify arguments for managed entrypoints", () => {
		const wd = mkdtempSync(join(tmpdir(), "omx-notify-dispatcher-user-arg-"));
		try {
			const userMarker = join(wd, "user-ran");
			const userScript = join(wd, "user-notify.js");
			writeFileSync(
				userScript,
				`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(userMarker)}, process.argv.slice(2).join("\\n"));\n`,
			);
			const metadataPath = join(wd, "notify-dispatch.json");
			writeFileSync(
				metadataPath,
				JSON.stringify({
					managedBy: "oh-my-codex",
					version: 1,
					previousNotify: [
						process.execPath,
						userScript,
						"/opt/homebrew/lib/node_modules/oh-my-codex/dist/scripts/notify-hook.js",
					],
				}),
			);

			runDispatcher(metadataPath);

			assert.match(readFileSync(userMarker, "utf-8"), /notify-hook\.js/);
		} finally {
			rmSync(wd, { recursive: true, force: true });
		}
	});
});
