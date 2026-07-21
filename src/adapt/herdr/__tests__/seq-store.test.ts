import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { afterEach, beforeEach, describe, it } from "node:test";
import { nextSeq, readPersistedSeq, sanitizeSourceKey } from "../seq-store.js";

let baseDir: string;
const moduleHref = new URL("../seq-store.js", import.meta.url).href;

beforeEach(async () => {
	baseDir = await mkdtemp(join(tmpdir(), "omx-herdr-seq-"));
});
afterEach(async () => {
	await rm(baseDir, { recursive: true, force: true });
});

describe("seq-store durable monotonic counter", () => {
	it("is strictly increasing per source in-process", () => {
		assert.deepEqual(
			[
				nextSeq("omx:runtime", { baseDir }),
				nextSeq("omx:runtime", { baseDir }),
				nextSeq("omx:runtime", { baseDir }),
			],
			[1, 2, 3],
		);
	});

	it("keeps separate streams per source", () => {
		assert.equal(nextSeq("src-a", { baseDir }), 1);
		assert.equal(nextSeq("src-b", { baseDir }), 1);
		assert.equal(nextSeq("src-a", { baseDir }), 2);
	});

	it("continues (does not reset to 1) after a simulated restart", () => {
		nextSeq("omx:runtime", { baseDir });
		nextSeq("omx:runtime", { baseDir });
		assert.equal(readPersistedSeq("omx:runtime", { baseDir }), 2);
		assert.equal(nextSeq("omx:runtime", { baseDir }), 3);
	});

	it("sanitizes source ids into safe file stems", () => {
		assert.equal(sanitizeSourceKey("omx:runtime"), "omx_runtime");
		assert.equal(sanitizeSourceKey("../../etc/passwd"), ".._.._etc_passwd");
		assert.equal(sanitizeSourceKey(""), "unknown-source");
	});

	it("produces unique, strictly-increasing seqs across concurrent processes", () => {
		const N = 12;
		const script = `import(${JSON.stringify(moduleHref)}).then((m) => { console.log(m.nextSeq("omx:runtime", { baseDir: ${JSON.stringify(baseDir)} })); });`;
		const results = new Array(N).fill(0).map(() =>
			Number(
				execFileSync(execPath, ["--input-type=module", "-e", script], {
					encoding: "utf-8",
				}).trim(),
			),
		);
		const unique = new Set(results);
		assert.equal(
			unique.size,
			N,
			`expected ${N} unique seqs, got ${[...unique].sort((a, b) => a - b).join(",")}`,
		);
		assert.equal(Math.max(...results), N);
		assert.equal(Math.min(...results), 1);
		assert.equal(readPersistedSeq("omx:runtime", { baseDir }), N);
	});
});
