import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	clearAuthority,
	readAuthority,
	reconcileStaleAuthority,
	recordAuthority,
} from "../authority.js";

let baseDir: string;
beforeEach(async () => {
	baseDir = await mkdtemp(join(tmpdir(), "omx-herdr-auth-"));
});
afterEach(async () => {
	await rm(baseDir, { recursive: true, force: true });
});

describe("authority store", () => {
	it("records and reads an authority record", () => {
		recordAuthority(
			{ pane_id: "w1:p1", source: "omx:runtime", owner_pid: process.pid },
			{ baseDir },
		);
		const record = readAuthority({ baseDir });
		assert.equal(record?.pane_id, "w1:p1");
		assert.equal(record?.owner_pid, process.pid);
		assert.ok(record?.acquired_at);
	});

	it("clears an authority record", () => {
		recordAuthority(
			{ pane_id: "w1:p1", source: "omx:runtime", owner_pid: process.pid },
			{ baseDir },
		);
		clearAuthority({ baseDir });
		assert.equal(readAuthority({ baseDir }), null);
	});

	it("reconciles stale authority left by a dead process", () => {
		recordAuthority(
			{ pane_id: "w1:p1", source: "omx:runtime", owner_pid: 999999 },
			{ baseDir },
		);
		const cleared = reconcileStaleAuthority({
			baseDir,
			pidAlive: () => false,
		});
		assert.equal(cleared, true);
		assert.equal(readAuthority({ baseDir }), null);
	});

	it("keeps authority when the owner process is still alive", () => {
		recordAuthority(
			{ pane_id: "w1:p1", source: "omx:runtime", owner_pid: process.pid },
			{ baseDir },
		);
		const cleared = reconcileStaleAuthority({
			baseDir,
			pidAlive: () => true,
		});
		assert.equal(cleared, false);
		assert.ok(readAuthority({ baseDir }));
	});

	it("returns false when there is no authority record", () => {
		assert.equal(reconcileStaleAuthority({ baseDir }), false);
	});
});
