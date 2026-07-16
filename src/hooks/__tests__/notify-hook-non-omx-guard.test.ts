import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

describe("notify-hook non-OMX project guard", () => {
	it("co-locates boxed prompt skill mode detail and canonical skill state under OMX_ROOT", async () => {
		const root = await mkdtemp(join(tmpdir(), "omx-notify-boxed-skill-"));
		const wd = join(root, "source");
		const omxRoot = join(root, "box");
		const sessionId = "sess-notify-ralplan";
		try {
			await mkdir(join(wd, ".omx"), { recursive: true });
			await writeFile(join(wd, ".omx", "managed"), "");
			const payload = JSON.stringify({
				cwd: wd,
				type: "agent-turn-complete",
				session_id: sessionId,
				thread_id: "thread-notify",
				turn_id: "turn-notify",
				"input-messages": ["$ralplan plan this change"],
				"last-assistant-message": "working",
			});
			const result = spawnSync(
				process.execPath,
				["dist/scripts/notify-hook.js", payload],
				{
					cwd: process.cwd(),
					encoding: "utf-8",
					env: {
						...process.env,
						OMX_ROOT: omxRoot,
						OMX_STATE_ROOT: "",
						OMX_TEAM_STATE_ROOT: "",
					},
				},
			);
			assert.equal(result.status, 0);
			const boxedSessionDir = join(omxRoot, ".omx", "state", "sessions", sessionId);
			assert.equal(existsSync(join(boxedSessionDir, "skill-active-state.json")), true);
			assert.equal(existsSync(join(boxedSessionDir, "ralplan-state.json")), true);
			const skillState = JSON.parse(await readFile(join(boxedSessionDir, "skill-active-state.json"), "utf-8"));
			assert.equal(skillState.skill, "ralplan");
			assert.equal(skillState.active, true);
			assert.equal(existsSync(join(wd, ".omx", "state", "sessions", sessionId, "skill-active-state.json")), false);
			assert.equal(existsSync(join(wd, ".omx", "state", "sessions", sessionId, "ralplan-state.json")), false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not activate issue #3133 negated, non-English, or quoted ralplan mentions under OMX_ROOT", async () => {
		const root = await mkdtemp(join(tmpdir(), "omx-notify-boxed-ralplan-inert-"));
		const wd = join(root, "source");
		const omxRoot = join(root, "box");
		try {
			await mkdir(join(wd, ".omx"), { recursive: true });
			await writeFile(join(wd, ".omx", "managed"), "");
			for (const [index, input] of [
				"Do not run $ralplan and do not repeat the review.",
				"Не запускай $ralplan",
				"Logged review text: \"$ralplan plan this change\".",
			].entries()) {
				const sessionId = `sess-notify-ralplan-inert-${index}`;
				const result = spawnSync(
					process.execPath,
					["dist/scripts/notify-hook.js", JSON.stringify({
						cwd: wd,
						type: "agent-turn-complete",
						session_id: sessionId,
						thread_id: `thread-notify-ralplan-inert-${index}`,
						turn_id: `turn-notify-ralplan-inert-${index}`,
						"input-messages": [input],
						"last-assistant-message": "working",
					})],
					{
						cwd: process.cwd(),
						encoding: "utf-8",
						env: {
							...process.env,
							OMX_ROOT: omxRoot,
							OMX_STATE_ROOT: "",
							OMX_TEAM_STATE_ROOT: "",
						},
					},
				);
				assert.equal(result.status, 0);
				const boxedSessionDir = join(omxRoot, ".omx", "state", "sessions", sessionId);
				assert.equal(existsSync(join(boxedSessionDir, "skill-active-state.json")), false);
				assert.equal(existsSync(join(boxedSessionDir, "ralplan-state.json")), false);
				assert.equal(existsSync(join(omxRoot, ".omx", "state", "skill-active-state.json")), false);
				assert.equal(existsSync(join(wd, ".omx", "state", "sessions", sessionId, "ralplan-state.json")), false);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("co-locates team-worker prompt skill state under the resolved team state root", async () => {
		const root = await mkdtemp(join(tmpdir(), "omx-notify-team-worker-skill-"));
		const wd = join(root, "worker-worktree");
		const teamStateRoot = join(root, "team-state");
		const teamName = "fixhud";
		const workerName = "worker-1";
		const sessionId = "sess-worker-ralplan";
		try {
			await mkdir(join(teamStateRoot, "team", teamName, "workers", workerName), { recursive: true });
			await writeFile(
				join(teamStateRoot, "team", teamName, "workers", workerName, "identity.json"),
				JSON.stringify({
					name: workerName,
					worktree_path: wd,
					team_state_root: teamStateRoot,
				}),
			);
			await mkdir(wd, { recursive: true });

			const payload = JSON.stringify({
				cwd: wd,
				type: "agent-turn-complete",
				session_id: sessionId,
				thread_id: "thread-worker",
				turn_id: "turn-worker",
				"input-messages": ["$ralplan implement issue #1307"],
				"last-assistant-message": "working",
			});
			const result = spawnSync(
				process.execPath,
				["dist/scripts/notify-hook.js", payload],
				{
					cwd: process.cwd(),
					encoding: "utf-8",
					env: {
						...process.env,
						OMX_TEAM_INTERNAL_WORKER: `${teamName}/${workerName}`,
						OMX_TEAM_STATE_ROOT: teamStateRoot,
						OMX_ROOT: "",
						OMX_STATE_ROOT: "",
					},
				},
			);
			assert.equal(result.status, 0);
			const teamSessionDir = join(teamStateRoot, "sessions", sessionId);
			assert.equal(existsSync(join(teamSessionDir, "skill-active-state.json")), true);
			assert.equal(existsSync(join(teamSessionDir, "ralplan-state.json")), true);
			assert.equal(existsSync(join(wd, ".omx", "state", "sessions", sessionId, "skill-active-state.json")), false);
			assert.equal(existsSync(join(wd, ".omx", "state", "sessions", sessionId, "ralplan-state.json")), false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("co-locates non-worker prompt skill state under OMX_TEAM_STATE_ROOT", async () => {
		const root = await mkdtemp(join(tmpdir(), "omx-notify-team-root-skill-"));
		const wd = join(root, "source");
		const teamStateRoot = join(root, "team-state");
		const sessionId = "sess-notify-team-root";
		try {
			await mkdir(join(wd, ".omx"), { recursive: true });
			await writeFile(join(wd, ".omx", "managed"), "");
			const payload = JSON.stringify({
				cwd: wd,
				type: "agent-turn-complete",
				session_id: sessionId,
				thread_id: "thread-notify-team-root",
				turn_id: "turn-notify-team-root",
				"input-messages": ["$ralplan implement issue #1307"],
				"last-assistant-message": "working",
			});
			const result = spawnSync(
				process.execPath,
				["dist/scripts/notify-hook.js", payload],
				{
					cwd: process.cwd(),
					encoding: "utf-8",
					env: {
						...process.env,
						OMX_TEAM_STATE_ROOT: teamStateRoot,
						OMX_ROOT: "",
						OMX_STATE_ROOT: "",
						OMX_TEAM_INTERNAL_WORKER: "",
						OMX_TEAM_WORKER: "",
					},
				},
			);
			assert.equal(result.status, 0);
			const teamSessionDir = join(teamStateRoot, "sessions", sessionId);
			assert.equal(existsSync(join(teamSessionDir, "skill-active-state.json")), true);
			assert.equal(existsSync(join(teamSessionDir, "ralplan-state.json")), true);
			assert.equal(existsSync(join(wd, ".omx", "state", "sessions", sessionId, "skill-active-state.json")), false);
			assert.equal(existsSync(join(wd, ".omx", "state", "sessions", sessionId, "ralplan-state.json")), false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("exits without creating .omx artifacts for unmanaged cwd", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-notify-unmanaged-"));
		try {
			const payload = JSON.stringify({
				cwd: wd,
				type: "agent-turn-complete",
				"turn-id": "t1",
			});
			const result = spawnSync(
				process.execPath,
				["dist/scripts/notify-hook.js", payload],
				{
					cwd: process.cwd(),
					encoding: "utf-8",
				},
			);
			assert.equal(result.status, 0);
			assert.equal(existsSync(join(wd, ".omx")), false);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("ignores stale .omx state/log directories without an ownership marker", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-notify-stale-state-"));
		try {
			await mkdir(join(wd, ".omx", "state"), { recursive: true });
			await mkdir(join(wd, ".omx", "logs"), { recursive: true });
			const payload = JSON.stringify({
				cwd: wd,
				type: "agent-turn-complete",
				"turn-id": "t1",
				"last-assistant-message": "completed",
			});
			const result = spawnSync(
				process.execPath,
				["dist/scripts/notify-hook.js", payload],
				{
					cwd: process.cwd(),
					encoding: "utf-8",
				},
			);
			assert.equal(result.status, 0);
			assert.equal(existsSync(join(wd, ".omx", "state", "notify.json")), false);
			assert.equal(existsSync(join(wd, ".omx", "logs", "notify-hook.log")), false);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
});
