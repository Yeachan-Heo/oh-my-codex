import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	readPersistedSetupPreferences,
	readPersistedSetupPreferencesSync,
	resolvePersistedSetupMergeAgents,
	writePersistedSetupPreferences,
} from "../setup-preferences.js";

describe("persisted setup merge policy", () => {
	it("accepts literal booleans only when the same record has a valid or migrated scope", async () => {
		const root = await mkdtemp(join(tmpdir(), "omx-setup-preferences-"));
		try {
			const path = join(root, ".omx", "setup-scope.json");
			await mkdir(join(root, ".omx"), { recursive: true });

			await writeFile(path, JSON.stringify({ scope: "user", mergeAgents: true }));
			assert.equal(resolvePersistedSetupMergeAgents(await readPersistedSetupPreferences(root), "user"), true);

			await writeFile(path, JSON.stringify({ scope: "project-local", mergeAgents: false }));
			assert.equal(resolvePersistedSetupMergeAgents(readPersistedSetupPreferencesSync(root), "project"), false);

			for (const record of [
				{ mergeAgents: true },
				{ scope: "workspace", mergeAgents: true },
				{ scope: "user", mergeAgents: "true" },
				{ scope: "user", mergeAgents: null },
				null,
			]) {
				await writeFile(path, JSON.stringify(record));
				assert.equal(resolvePersistedSetupMergeAgents(await readPersistedSetupPreferences(root), "user"), undefined);
			}

			await writeFile(path, "{ malformed");
			assert.equal(readPersistedSetupPreferencesSync(root), undefined);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("writes canonical newline-terminated state atomically without retaining temporary files", async () => {
		const root = await mkdtemp(join(tmpdir(), "omx-setup-preferences-"));
		try {
			await writePersistedSetupPreferences(root, { scope: "project", mergeAgents: false });
			const path = join(root, ".omx", "setup-scope.json");
			assert.equal(await readFile(path, "utf-8"), '{\n  "scope": "project",\n  "mergeAgents": false\n}\n');
			const entries = await readdir(join(root, ".omx"));
			assert.deepEqual(entries, ["setup-scope.json"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("preserves target bytes and cleans its temp file when an atomic replacement fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "omx-setup-preferences-"));
		try {
			const dir = join(root, ".omx");
			const path = join(dir, "setup-scope.json");
			const original = '{"scope":"user","mergeAgents":true}\n';
			await mkdir(dir, { recursive: true });
			await writeFile(path, original);
			await assert.rejects(
				writePersistedSetupPreferences(root, { scope: "user", mergeAgents: false }, {
					rename: async () => { throw new Error("rename denied"); },
				}),
				/rename denied/,
			);
			assert.equal(await readFile(path, "utf-8"), original);
			assert.deepEqual(await readdir(dir), ["setup-scope.json"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not create a target when the initial atomic write fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "omx-setup-preferences-"));
		try {
			await assert.rejects(
				writePersistedSetupPreferences(root, { scope: "user", mergeAgents: true }, {
					writeFile: async () => { throw new Error("write denied"); },
				}),
				/write denied/,
			);
			assert.equal(existsSync(join(root, ".omx", "setup-scope.json")), false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
