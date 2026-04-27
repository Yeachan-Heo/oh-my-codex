import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildAdaptDoctorReport,
	buildAdaptEnvelope,
	buildAdaptProbeReport,
	buildAdaptStatusReport,
	initAdaptFoundation,
} from "../index.js";
import {
	REQUIRED_CONTEXT_PACK_ROLES,
	readContextPackDocument,
	writeContextPackDocument,
	type ContextPackRole,
} from "../../planning/context-packs.js";
import { resolveAdaptPaths } from "../paths.js";
import { getAdaptTargetDescriptor } from "../registry.js";

let tempDir: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
	originalEnv = { ...process.env };
	tempDir = await mkdtemp(join(tmpdir(), "omx-adapt-foundation-"));
	process.env.HOME = tempDir;
	process.env.CODEX_HOME = join(tempDir, ".codex");
	delete process.env.OMX_OPENCLAW;
	delete process.env.OMX_OPENCLAW_CONFIG;
	delete process.env.OMX_OPENCLAW_COMMAND;
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

async function writeOpenClawOmxConfig(config: unknown): Promise<void> {
	const configDir = join(tempDir, ".codex");
	await mkdir(configDir, { recursive: true });
	await writeFile(
		join(configDir, ".omx-config.json"),
		`${JSON.stringify(config, null, 2)}\n`,
	);
}

function defaultReadFirstRef(
	slug: string,
	role: ContextPackRole,
): { label: string; path: string; relationTag: string } {
	if (role === "scope") {
		return { label: "boundary", path: `docs/${slug}-boundary.md`, relationTag: "bounds" };
	}
	if (role === "verify") {
		return { label: "acceptance", path: `docs/${slug}-acceptance.md`, relationTag: "verifies" };
	}
	return { label: "implementation", path: `docs/${slug}-implementation.md`, relationTag: "implements" };
}

async function writeDefaultContextPack(slug: string, timestamp: string): Promise<string> {
	for (const role of REQUIRED_CONTEXT_PACK_ROLES) {
		const readFirstRef = defaultReadFirstRef(slug, role);
		await mkdir(join(tempDir, "docs"), { recursive: true });
		await writeFile(
			join(tempDir, readFirstRef.path),
			`# ${readFirstRef.label}\n\n${role} context for ${slug}.\n`,
		);
	}
	const packName = `context-${timestamp}-${slug}.json`;
	writeContextPackDocument(
		join(tempDir, ".omx", "context", packName),
		{
			schema: "omx-context-pack-v1",
			slug,
			entries: REQUIRED_CONTEXT_PACK_ROLES.map((role) => {
				const readFirstRef = defaultReadFirstRef(slug, role);
				return {
					label: readFirstRef.label,
					path: readFirstRef.path,
					roles: [role],
					tags: [],
					relationPath: [
						{ tag: "plan", target: slug },
						{ tag: readFirstRef.relationTag, target: readFirstRef.path },
					],
				};
			}),
		},
		{ refreshBasis: true },
	);
	return packName;
}

function refreshContextPackBasis(packName: string): void {
	const packPath = join(tempDir, ".omx", "context", packName);
	const document = readContextPackDocument(packPath);
	assert.ok(document, `expected context pack at ${packPath}`);
	writeContextPackDocument(packPath, document, { refreshBasis: true });
}

describe("adapt foundation", () => {
	it("resolves OMX-owned adapter paths under .omx/adapters/<target>", () => {
		const paths = resolveAdaptPaths(tempDir, "openclaw");
		assert.equal(
			paths.adapterRoot,
			join(tempDir, ".omx", "adapters", "openclaw"),
		);
		assert.equal(
			paths.configPath,
			join(tempDir, ".omx", "adapters", "openclaw", "adapter.json"),
		);
		assert.equal(
			paths.envelopePath,
			join(tempDir, ".omx", "adapters", "openclaw", "envelope.json"),
		);
		assert.equal(
			paths.probeReportPath,
			join(tempDir, ".omx", "adapters", "openclaw", "reports", "probe.json"),
		);
		assert.equal(
			paths.statusReportPath,
			join(tempDir, ".omx", "adapters", "openclaw", "reports", "status.json"),
		);
	});

	it("links the latest canonical PRD/test-spec artifacts into the envelope", async () => {
		const plansDir = join(tempDir, ".omx", "plans");
		const contextDir = join(tempDir, ".omx", "context");
		await mkdir(plansDir, { recursive: true });
		await mkdir(contextDir, { recursive: true });
		const packName = await writeDefaultContextPack("zeta", "20260420T000000Z");
		await writeFile(join(plansDir, "prd-alpha.md"), "# Alpha\n");
		await writeFile(
			join(plansDir, "test-spec-alpha.md"),
			"# Alpha Test Spec\n",
		);
		await writeFile(
			join(plansDir, "prd-zeta.md"),
			[
				"# Zeta",
				"",
				"## Context Pack Outcome",
				"- pack: created `.omx/context/context-20260420T000000Z-zeta.json`",
				"",
			].join("\n"),
		);
		await writeFile(join(plansDir, "test-spec-zeta.md"), "# Zeta Test Spec\n");
		refreshContextPackBasis(packName);

		const envelope = buildAdaptEnvelope(
			tempDir,
			"openclaw",
			new Date("2026-04-14T00:00:00.000Z"),
		);
		assert.equal(envelope.planning.prdPath, join(plansDir, "prd-zeta.md"));
		assert.deepEqual(envelope.planning.testSpecPaths, [
			join(plansDir, "test-spec-zeta.md"),
		]);
		assert.deepEqual(envelope.planning.contextPack, {
			path: join(contextDir, packName),
			action: "created",
		});
		assert.match(envelope.planning.summary, /context pack/i);
	});

	it("keeps the plan-only execution baseline visible when the approved plan has no context pack", async () => {
		const plansDir = join(tempDir, ".omx", "plans");
		await mkdir(plansDir, { recursive: true });
		await writeFile(join(plansDir, "prd-plan-only.md"), "# Plan-only\n");
		await writeFile(join(plansDir, "test-spec-plan-only.md"), "# Plan-only Test Spec\n");

		const envelope = buildAdaptEnvelope(
			tempDir,
			"openclaw",
			new Date("2026-04-14T00:00:00.000Z"),
		);
		assert.equal(envelope.planning.prdPath, join(plansDir, "prd-plan-only.md"));
		assert.equal(envelope.planning.contextPackStatus, "plan-only");
		assert.equal(envelope.planning.contextPack, null);
		assert.match(envelope.planning.summary, /plan-only execution baseline remains available/i);
	});

	it("reports asymmetric capability ownership in the shared envelope", () => {
		const envelope = buildAdaptEnvelope(
			tempDir,
			"hermes",
			new Date("2026-04-14T00:00:00.000Z"),
		);
		const ownerships = new Set(
			envelope.capabilities.map((capability) => capability.ownership),
		);
		assert.deepEqual([...ownerships].sort(), [
			"omx-owned",
			"shared-contract",
			"target-observed",
		]);
	});

	it("keeps OpenClaw init preview read-only until --write is used", () => {
		const result = initAdaptFoundation(
			tempDir,
			"openclaw",
			false,
			new Date("2026-04-14T00:00:00.000Z"),
		);
		const paths = resolveAdaptPaths(tempDir, "openclaw");
		assert.equal(result.write, false);
		assert.deepEqual(result.wrotePaths, []);
		assert.equal(existsSync(paths.configPath), false);
		assert.equal(existsSync(join(tempDir, ".omx", "state")), false);
	});

	it("writes OpenClaw adapter artifacts only under adapter-owned paths", async () => {
		process.env.OMX_OPENCLAW = "1";
		await writeOpenClawOmxConfig({
			notifications: {
				openclaw: {
					enabled: true,
					gateways: {
						local: {
							type: "http",
							url: "https://example.com/hook",
							timeout: 9000,
						},
					},
					hooks: {
						"session-start": {
							enabled: true,
							gateway: "local",
							instruction: "start",
						},
					},
				},
			},
		});

		const result = initAdaptFoundation(
			tempDir,
			"openclaw",
			true,
			new Date("2026-04-14T00:00:00.000Z"),
		);
		const paths = resolveAdaptPaths(tempDir, "openclaw");
		assert.equal(result.write, true);
		assert.deepEqual(result.wrotePaths, [paths.configPath, paths.envelopePath]);
		assert.equal(existsSync(paths.configPath), true);
		assert.equal(existsSync(paths.envelopePath), true);
		assert.equal(existsSync(join(tempDir, ".omx", "state")), false);

		const envelope = JSON.parse(readFileSync(paths.envelopePath, "utf-8")) as {
			target: string;
			openclaw?: {
				observedState: string;
				hooks: Array<{ event: string; status: string }>;
			};
		};
		assert.equal(envelope.target, "openclaw");
		assert.equal(envelope.openclaw?.observedState, "configured");
		assert.equal(envelope.openclaw?.hooks[0]?.event, "session-start");
	});

	it("OpenClaw probe degrades gracefully when env/config evidence is absent", () => {
		const probe = buildAdaptProbeReport(
			tempDir,
			"openclaw",
			new Date("2026-04-14T00:00:00.000Z"),
		);
		assert.equal(probe.openclaw?.observedState, "disabled");
		assert.match(probe.summary, /disabled locally/i);
	});

	it("OpenClaw status degrades gracefully when config is absent", () => {
		process.env.OMX_OPENCLAW = "1";
		const status = buildAdaptStatusReport(
			tempDir,
			"openclaw",
			new Date("2026-04-14T00:00:00.000Z"),
		);
		assert.equal(status.adapter.state, "not-initialized");
		assert.equal(status.openclaw?.observedState, "missing-config");
		assert.match(
			status.targetRuntime.detail,
			/local config\/env\/gateway wiring evidence only/i,
		);
	});

	it("OpenClaw status reports local command-gateway blocking without over-claiming health", async () => {
		process.env.OMX_OPENCLAW = "1";
		await writeOpenClawOmxConfig({
			notifications: {
				openclaw: {
					enabled: true,
					gateways: {
						local: { type: "command", command: "echo hi" },
					},
					hooks: {
						stop: {
							enabled: true,
							gateway: "local",
							instruction: "stop",
						},
					},
				},
			},
		});

		const status = buildAdaptStatusReport(
			tempDir,
			"openclaw",
			new Date("2026-04-14T00:00:00.000Z"),
		);
		assert.equal(status.openclaw?.observedState, "degraded");
		assert.equal(
			status.openclaw?.hooks.find((hook) => hook.event === "stop")?.status,
			"blocked",
		);
		assert.match(
			status.targetRuntime.detail,
			/not authoritative remote OpenClaw runtime health/i,
		);
	});

	it("doctor surfaces actionable OpenClaw remediation", () => {
		const doctor = buildAdaptDoctorReport(
			tempDir,
			"openclaw",
			new Date("2026-04-14T00:00:00.000Z"),
		);
		assert.equal(doctor.issues[0]?.code, "adapter_not_initialized");
		assert.match(doctor.nextSteps.join("\n"), /OMX_OPENCLAW=1/i);
		assert.match(doctor.nextSteps.join("\n"), /init --write/i);
	});

	it("keeps Hermes foundation behavior unchanged", () => {
		const status = buildAdaptStatusReport(
			tempDir,
			"hermes",
			new Date("2026-04-14T00:00:00.000Z"),
		);
		assert.equal(status.adapter.state, "not-initialized");
		assert.equal(status.targetRuntime.state, "unknown");
	});

	it("doctor surfaces actionable foundation-only remediation", () => {
		const doctor = buildAdaptDoctorReport(
			tempDir,
			"hermes",
			new Date("2026-04-14T00:00:00.000Z"),
		);
		assert.equal(doctor.issues[0]?.code, "adapter_not_initialized");
		assert.match(doctor.nextSteps.join("\n"), /init --write/i);
		assert.match(
			doctor.nextSteps.join("\n"),
			/Hermes adapter reads external ACP, gateway, and session-store evidence/i,
		);
	});

	it("rejects inherited prototype-like targets during validation", () => {
		assert.equal(getAdaptTargetDescriptor("__proto__"), null);
		assert.equal(getAdaptTargetDescriptor("constructor"), null);
	});
});
