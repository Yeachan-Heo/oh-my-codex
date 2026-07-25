// Characterization baseline for issue #3293 wave B callsite parity. Only the valid
// exact-session deep-interview direct-cancel case is expected to change in wave B.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { dispatchCodexNativeHook } from "../codex-native-hook.js";

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(value, null, 2));
}

type Mode = "deep-interview" | "ralplan" | "conductor";

async function fixture(mode: Mode, suffix: string) {
	const cwd = await mkdtemp(join(tmpdir(), `omx-3293-parity-${suffix}-`));
	const stateDir = join(cwd, ".omx", "state");
	const sessionId = `session-${suffix}`;
	const threadId = `thread-${suffix}`;
	const sessionDir = join(stateDir, "sessions", sessionId);
	const skill = mode === "conductor" ? "ultragoal" : mode === "deep-interview" ? "autopilot" : "ralplan";
	const phase = mode === "deep-interview" ? "deep-interview" : "planning";
	await writeJson(join(stateDir, "session.json"), { session_id: sessionId, cwd, leader_thread_id: threadId });
	await writeJson(join(stateDir, "subagent-tracking.json"), {
		schemaVersion: 1,
		sessions: { [sessionId]: { session_id: sessionId, leader_thread_id: threadId, threads: { [threadId]: { thread_id: threadId, kind: "leader" } } } },
	});
	await writeJson(join(sessionDir, "skill-active-state.json"), {
		active: true, skill, phase, session_id: sessionId, thread_id: threadId,
		active_skills: [{ active: true, skill, phase, session_id: sessionId, thread_id: threadId }],
	});
	if (mode === "deep-interview") {
		await writeJson(join(sessionDir, "autopilot-state.json"), { active: true, mode: "autopilot", current_phase: phase, session_id: sessionId, thread_id: threadId, workingDirectory: cwd });
	} else if (mode === "ralplan") {
		await writeJson(join(sessionDir, "ralplan-state.json"), { active: true, mode: "ralplan", current_phase: phase, session_id: sessionId, thread_id: threadId, workingDirectory: cwd });
	} else {
		await writeJson(join(sessionDir, "ultragoal-state.json"), { active: true, mode: "ultragoal", current_phase: phase, session_id: sessionId, thread_id: threadId, workingDirectory: cwd });
	}
	return { cwd, stateDir, sessionId, threadId };
}

async function preToolUse(f: Awaited<ReturnType<typeof fixture>>, command: string, toolInput: Record<string, unknown> = { command }) {
	return dispatchCodexNativeHook({
		hook_event_name: "PreToolUse", cwd: f.cwd, session_id: f.sessionId, thread_id: f.threadId,
		agent_id: f.threadId, tool_name: "Bash", tool_use_id: `tool-${Math.random()}`, tool_input: toolInput,
	}, { cwd: f.cwd });
}

function assertBlocked(result: Awaited<ReturnType<typeof dispatchCodexNativeHook>>, pattern?: RegExp): void {
	assert.equal(result.omxEventName, "pre-tool-use");
	assert.equal(result.outputJson?.decision, "block");
	if (pattern) assert.match(JSON.stringify(result.outputJson), pattern);
}

async function withTrustedOmx<T>(cwd: string, action: () => Promise<T>): Promise<T> {
	const binDir = join(cwd, "trusted-bin");
	const priorPath = process.env.PATH;
	await mkdir(binDir, { recursive: true });
	await symlink(resolve(process.cwd(), "dist", "cli", "omx.js"), join(binDir, "omx"));
	process.env.PATH = `${binDir}:${dirname(process.execPath)}`;
	try { return await action(); }
	finally {
		if (priorPath === undefined) delete process.env.PATH;
		else process.env.PATH = priorPath;
	}
}


describe("issue #3293 callsite parity baseline", () => {
	it("deep-interview ~9541: payload-absent implementation-write path remains fail-closed by provenance", async () => {
		const f = await fixture("deep-interview", "payload-absent");
		try {
			// blocksDeepInterviewImplementationWrite is private; this public root-conflict
			// boundary reaches its payload-absent invocation with a cancel-shaped Bash command.
			const result = await dispatchCodexNativeHook({
				hook_event_name: "PreToolUse", cwd: f.cwd, session_id: "foreign-native", tool_name: "Bash",
				tool_input: { command: "omx cancel" },
			}, { cwd: f.cwd });
			assertBlocked(result, /payload session identity is foreign or cannot be mapped to the active session/);

		} finally { await rm(f.cwd, { recursive: true, force: true }); }
	});

	it("deep-interview ~9498: non-cancel read-only OMX command is allowed", async () => {
		const f = await fixture("deep-interview", "readonly");
		try { assert.equal((await preToolUse(f, "omx state read --json")).outputJson, null); }
		finally { await rm(f.cwd, { recursive: true, force: true }); }
	});

	it("deep-interview ~9498: permitted planning artifact write is allowed", async () => {
		const f = await fixture("deep-interview", "artifact");
		try { assert.equal((await preToolUse(f, "printf spec > .omx/specs/issue.md")).outputJson, null); }
		finally { await rm(f.cwd, { recursive: true, force: true }); }
	});

	it("deep-interview ~9498: forbidden implementation write is blocked", async () => {
		const f = await fixture("deep-interview", "implementation");
		try { assertBlocked(await preToolUse(f, "printf code > src/product.ts"), /src\/product\.ts/); }
		finally { await rm(f.cwd, { recursive: true, force: true }); }
	});

	it("deep-interview ~8863: bare omx cancel is handled by the hook", async () => {
		const f = await fixture("deep-interview", "deep-bare");
		try { await withTrustedOmx(f.cwd, async () => assertBlocked(await preToolUse(f, "omx cancel"), /cancelled_exact_session/)); }
		finally { await rm(f.cwd, { recursive: true, force: true }); }
	});

	it("deep-interview ~8863: omx cancel --force remains blocked by bare-only grammar", async () => {
		const f = await fixture("deep-interview", "deep-force");
		try { assertBlocked(await preToolUse(f, "omx cancel --force"), /invalid_command/); }
		finally { await rm(f.cwd, { recursive: true, force: true }); }
	});

	for (const mode of ["deep-interview", "ralplan", "conductor"] as const) {
		it(`${mode} direct-cancel callsite: raw/analyzed command mismatch remains blocked`, async () => {
			const f = await fixture(mode, `${mode}-raw-mismatch`);
			try { assertBlocked(await preToolUse(f, " omx cancel ")); }
			finally { await rm(f.cwd, { recursive: true, force: true }); }
		});
	}

	for (const [mode, site] of [["ralplan", "~9114"], ["conductor", "~18227"]] as const) {
		for (const command of ["omx cancel", "omx cancel --force"]) {
			it(`${mode} ${site}: ${command} falls through to the pre-#3293 executable-trust path`, async () => {
				const f = await fixture(mode, `${mode}-${command.endsWith("force") ? "force" : "bare"}`);
				try { await withTrustedOmx(f.cwd, async () => assert.equal((await preToolUse(f, command)).outputJson, null)); }
				finally { await rm(f.cwd, { recursive: true, force: true }); }
			});
		}
	}


	it("deep-interview ~9616: foreign payload remains fail-closed by provenance", async () => {
		const f = await fixture("deep-interview", "deep-root-conflict");
		try {
			await writeJson(join(f.stateDir, "session.json"), { session_id: f.sessionId, cwd: f.cwd });
			const result = await dispatchCodexNativeHook({ hook_event_name: "PreToolUse", cwd: f.cwd, session_id: "foreign-native", tool_name: "Edit", tool_input: { file_path: "src/product.ts" } }, { cwd: f.cwd });
			assertBlocked(result, /payload session identity is foreign or cannot be mapped to the active session/);
		} finally { await rm(f.cwd, { recursive: true, force: true }); }
	});

	it("ralplan ~9645: foreign payload remains fail-closed by provenance", async () => {
		const f = await fixture("ralplan", "ralplan-root-conflict");
		try {
			const result = await dispatchCodexNativeHook({ hook_event_name: "PreToolUse", cwd: f.cwd, session_id: "foreign-native", tool_name: "Edit", tool_input: { file_path: "src/product.ts" } }, { cwd: f.cwd });
			assertBlocked(result, /payload session identity is foreign or cannot be mapped to the active session/);
		} finally { await rm(f.cwd, { recursive: true, force: true }); }
	});

	for (const command of [
		"FOO=bar omx cancel", "PATH=/tmp omx cancel", "omx cancel; ls", "omx cancel | cat",
		"omx cancel > /tmp/x", "omx cancel $(id)", "omx cancel `id`", "/tmp/omx cancel",
		"omx cancel extra", "omx cancel --unknown", "omx cancel;",
	]) {
		it(`deep-interview ~8863: invalid direct-cancel grammar ${JSON.stringify(command)} is blocked`, async () => {
			const f = await fixture("deep-interview", `grammar-${command.length}`);
			try { assertBlocked(await preToolUse(f, command)); }
			finally { await rm(f.cwd, { recursive: true, force: true }); }
		});
	}

	it("Conductor ~18419: cancel-shaped command retains its pre-#3293 trust denial when trust is absent", async () => {
		const f = await fixture("conductor", "conductor-detail");
		try { assertBlocked(await preToolUse(f, "omx cancel"), /direct cancellation execution context is not trusted/); }
		finally { await rm(f.cwd, { recursive: true, force: true }); }
	});
});
