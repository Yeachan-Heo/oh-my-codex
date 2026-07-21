import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildAdaptDoctorReportForTarget,
	buildAdaptEnvelopeForTarget,
	buildAdaptProbeReportForTarget,
	buildAdaptStatusReportForTarget,
	initAdaptFoundationForTarget,
	supportedAdaptTargets,
} from "../index.js";
import { resolveAdaptPaths } from "../paths.js";
import { getAdaptTargetDescriptor } from "../registry.js";

let tempDir: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
	originalEnv = { ...process.env };
	tempDir = await mkdtemp(join(tmpdir(), "omx-adapt-herdr-"));
	process.env.HOME = tempDir;
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_PANE_ID;
	delete process.env.HERDR_SOCKET_PATH;
	delete process.env.HERDR_BIN_PATH;
});

afterEach(async () => {
	for (const key of Object.keys(process.env)) {
		if (!(key in originalEnv)) delete process.env[key];
	}
	for (const [key, val] of Object.entries(originalEnv)) {
		process.env[key] = val;
	}
	if (tempDir && existsSync(tempDir)) {
		await rm(tempDir, { recursive: true, force: true });
	}
});

describe("adapt herdr target", () => {
	it("is a registered adapt target with a descriptor", () => {
		assert.ok(supportedAdaptTargets().includes("herdr"));
		const descriptor = getAdaptTargetDescriptor("herdr");
		assert.ok(descriptor);
		assert.equal(descriptor?.displayName, "Herdr");
		assert.ok(
			descriptor?.capabilities.some((c) => c.id === "lifecycle-status-bridge"),
		);
	});

	it("resolves OMX-owned adapter paths under .omx/adapters/herdr", () => {
		const paths = resolveAdaptPaths(tempDir, "herdr");
		assert.equal(paths.adapterRoot, join(tempDir, ".omx", "adapters", "herdr"));
	});

	it("reports not-detected runtime state outside a Herdr pane", async () => {
		const probe = await buildAdaptProbeReportForTarget(tempDir, "herdr");
		assert.equal(probe.target, "herdr");
		assert.equal(probe.targetRuntime.state, "not-detected");
		const status = await buildAdaptStatusReportForTarget(tempDir, "herdr");
		assert.equal(status.targetRuntime.state, "not-detected");
	});

	it("reports detected runtime state and a transport inside a Herdr pane", async () => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "w1:p1";
		process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
		const envelope = await buildAdaptEnvelopeForTarget(tempDir, "herdr");
		assert.equal(envelope.targetRuntime?.state, "detected");
		assert.equal(envelope.bootstrap?.eventBridge.length, 4);
		const bridgeCap = envelope.capabilities.find(
			(c) => c.id === "lifecycle-status-bridge",
		);
		assert.equal(bridgeCap?.status, "ready");
	});

	it("flags a doctor issue when no Herdr pane is detected", async () => {
		const doctor = await buildAdaptDoctorReportForTarget(tempDir, "herdr");
		assert.ok(
			doctor.issues.some((issue) => issue.code === "herdr_pane_not_detected"),
		);
	});

	it("materializes OMX-owned adapter artifacts on init --write", async () => {
		const result = await initAdaptFoundationForTarget(
			tempDir,
			"herdr",
			true,
		);
		assert.ok(existsSync(result.envelope.adapterPaths.configPath));
		assert.ok(existsSync(result.envelope.adapterPaths.envelopePath));
	});
});
