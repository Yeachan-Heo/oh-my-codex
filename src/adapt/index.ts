import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readLatestPlanningArtifacts } from "../planning/artifacts.js";
import {
	ADAPT_SCHEMA_VERSION,
	type AdaptDoctorIssue,
	type AdaptDoctorReport,
	type AdaptEnvelope,
	type AdaptInitResult,
	type AdaptPlanningLink,
	type AdaptProbeReport,
	type AdaptStatusReport,
	type AdaptTarget,
} from "./contracts.js";
import {
	applyHermesEnvelope,
	applyHermesProbe,
	applyHermesStatus,
	buildHermesBootstrapMetadata,
	buildHermesRuntimeObservation,
	collectHermesEvidence,
} from "./hermes.js";
import {
	applyHerdrEnvelope,
	applyHerdrProbe,
	applyHerdrStatus,
	buildHerdrBootstrapMetadata,
	buildHerdrRuntimeObservation,
	collectHerdrEvidence,
} from "./herdr.js";
import {
	buildOpenClawDoctorReport,
	buildOpenClawEnvelope,
	buildOpenClawProbeReport,
	buildOpenClawStatusReport,
	initOpenClawFoundation,
} from "./openclaw.js";
import { resolveAdaptPaths } from "./paths.js";
import { getAdaptTargetDescriptor, listAdaptTargets } from "./registry.js";

const FOUNDATION_CONSTRAINTS = [
	"Thin adapter surface only; no bidirectional control plane is claimed in this foundation PR.",
	"No direct writes to .omx/state/... or target runtime internals.",
	"Capability reporting is asymmetric: OMX-owned, shared-contract, and target-observed surfaces are reported separately.",
];

function toIsoTimestamp(now = new Date()): string {
	return now.toISOString();
}

export function supportedAdaptTargets(): string[] {
	return listAdaptTargets().map((descriptor) => descriptor.target);
}

export function buildAdaptPlanningLink(cwd: string): AdaptPlanningLink {
	const selection = readLatestPlanningArtifacts(cwd);
	if (!selection.prdPath) {
		return {
			prdPath: null,
			testSpecPaths: [],
			deepInterviewSpecPaths: [],
			summary:
				"No canonical OMX PRD/test-spec artifacts are present in this worktree.",
		};
	}

	const testSpecSummary =
		selection.testSpecPaths.length > 0
			? `${selection.testSpecPaths.length} matching test spec artifact(s) linked.`
			: "PRD detected, but no matching test spec artifact was found for its slug.";

	return {
		prdPath: selection.prdPath,
		testSpecPaths: selection.testSpecPaths,
		deepInterviewSpecPaths: selection.deepInterviewSpecPaths,
		summary: testSpecSummary,
	};
}

export function buildAdaptEnvelope(
	cwd: string,
	target: AdaptTarget,
	now = new Date(),
): AdaptEnvelope {
	const descriptor = getAdaptTargetDescriptor(target);
	if (!descriptor) {
		throw new Error(`Unknown adapt target: ${target}`);
	}

	const paths = resolveAdaptPaths(cwd, target);
	const planning = buildAdaptPlanningLink(cwd);

	if (target === "openclaw") {
		return buildOpenClawEnvelope(paths, planning, descriptor.capabilities, now);
	}

	return {
		schemaVersion: ADAPT_SCHEMA_VERSION,
		generatedAt: toIsoTimestamp(now),
		target,
		displayName: descriptor.displayName,
		summary: descriptor.summary,
		adapterPaths: paths,
		planning,
		capabilities: descriptor.capabilities,
		constraints: FOUNDATION_CONSTRAINTS,
	};
}

export async function buildAdaptEnvelopeForTarget(
	cwd: string,
	target: AdaptTarget,
	now = new Date(),
): Promise<AdaptEnvelope> {
	const envelope = buildAdaptEnvelope(cwd, target, now);
	if (target === "herdr") {
		return applyHerdrEnvelope(envelope, collectHerdrEvidence());
	}
	if (target !== "hermes") {
		return envelope;
	}

	return applyHermesEnvelope(envelope, await collectHermesEvidence(cwd));
}

export function buildAdaptProbeReport(
	cwd: string,
	target: AdaptTarget,
	now = new Date(),
): AdaptProbeReport {
	const descriptor = getAdaptTargetDescriptor(target);
	if (!descriptor) {
		throw new Error(`Unknown adapt target: ${target}`);
	}

	const paths = resolveAdaptPaths(cwd, target);
	const planning = buildAdaptPlanningLink(cwd);

	if (target === "openclaw") {
		return buildOpenClawProbeReport(
			paths,
			planning,
			descriptor.capabilities,
			now,
		);
	}

	return {
		schemaVersion: ADAPT_SCHEMA_VERSION,
		timestamp: toIsoTimestamp(now),
		target,
		phase: "foundation",
		summary: `${descriptor.displayName} probe foundation is available, but target-specific runtime probing is deferred.`,
		adapterPaths: paths,
		planning,
		capabilities: descriptor.capabilities,
		targetRuntime: {
			state: "not-implemented",
			detail: descriptor.followupHint,
		},
		nextSteps: [
			`Run omx adapt ${target} init --write to materialize OMX-owned adapter artifacts.`,
			descriptor.followupHint,
		],
	};
}

export async function buildAdaptProbeReportForTarget(
	cwd: string,
	target: AdaptTarget,
	now = new Date(),
): Promise<AdaptProbeReport> {
	const report = buildAdaptProbeReport(cwd, target, now);
	if (target === "herdr") {
		return applyHerdrProbe(report, collectHerdrEvidence());
	}
	if (target !== "hermes") {
		return report;
	}

	return applyHermesProbe(report, await collectHermesEvidence(cwd));
}

export function buildAdaptStatusReport(
	cwd: string,
	target: AdaptTarget,
	now = new Date(),
): AdaptStatusReport {
	const descriptor = getAdaptTargetDescriptor(target);
	if (!descriptor) {
		throw new Error(`Unknown adapt target: ${target}`);
	}

	const paths = resolveAdaptPaths(cwd, target);
	const initialized =
		existsSync(paths.configPath) && existsSync(paths.envelopePath);
	const planning = buildAdaptPlanningLink(cwd);

	if (target === "openclaw") {
		return buildOpenClawStatusReport(
			paths,
			planning,
			descriptor.capabilities,
			now,
		);
	}

	return {
		schemaVersion: ADAPT_SCHEMA_VERSION,
		timestamp: toIsoTimestamp(now),
		target,
		phase: "foundation",
		summary: initialized
			? `${descriptor.displayName} adapter foundation is initialized under OMX-owned paths.`
			: `${descriptor.displayName} adapter foundation has not been initialized yet.`,
		adapter: {
			state: initialized ? "initialized" : "not-initialized",
			detail: initialized
				? "Adapter foundation artifacts exist under .omx/adapters/<target>/..."
				: "Run init --write to create OMX-owned adapter artifacts.",
			configPath: paths.configPath,
			envelopePath: paths.envelopePath,
		},
		targetRuntime: {
			state: "unknown",
			detail: descriptor.followupHint,
		},
		planning,
		capabilities: descriptor.capabilities,
	};
}

export async function buildAdaptStatusReportForTarget(
	cwd: string,
	target: AdaptTarget,
	now = new Date(),
): Promise<AdaptStatusReport> {
	const report = buildAdaptStatusReport(cwd, target, now);
	if (target === "herdr") {
		return applyHerdrStatus(report, collectHerdrEvidence());
	}
	if (target !== "hermes") {
		return report;
	}

	return applyHermesStatus(report, await collectHermesEvidence(cwd));
}

export function buildAdaptDoctorReport(
	cwd: string,
	target: AdaptTarget,
	now = new Date(),
): AdaptDoctorReport {
	const descriptor = getAdaptTargetDescriptor(target);
	if (!descriptor) {
		throw new Error(`Unknown adapt target: ${target}`);
	}

	const status = buildAdaptStatusReport(cwd, target, now);
	const planning = buildAdaptPlanningLink(cwd);
	const issues: AdaptDoctorIssue[] = [];

	if (target === "openclaw") {
		return buildOpenClawDoctorReport(
			resolveAdaptPaths(cwd, target),
			planning,
			now,
		);
	}

	if (status.adapter.state === "not-initialized") {
		issues.push({
			code: "adapter_not_initialized",
			message: `No adapter foundation artifacts exist for ${target} under ${join(".omx", "adapters", target)}.`,
		});
	}

	if (!planning.prdPath) {
		issues.push({
			code: "planning_artifacts_missing",
			message:
				"No canonical OMX PRD artifact is available to link into the adapter envelope.",
		});
	}

	issues.push({
		code: "target_specific_logic_deferred",
		message: descriptor.followupHint,
	});

	return {
		schemaVersion: ADAPT_SCHEMA_VERSION,
		timestamp: toIsoTimestamp(now),
		target,
		phase: "foundation",
		summary: `Foundation doctor for ${descriptor.displayName} reports only OMX-owned adapter readiness and shared planning linkage.`,
		issues,
		nextSteps: [
			`Run omx adapt ${target} init --write.`,
			"Keep follow-on integration work out of .omx/state/... and target runtime internals unless a reviewed contract exists.",
			descriptor.followupHint,
		],
	};
}

export async function buildAdaptDoctorReportForTarget(
	cwd: string,
	target: AdaptTarget,
	now = new Date(),
): Promise<AdaptDoctorReport> {
	const report = buildAdaptDoctorReport(cwd, target, now);
	if (target === "herdr") {
		const evidence = collectHerdrEvidence();
		const runtime = buildHerdrRuntimeObservation(evidence);
		const bootstrap = buildHerdrBootstrapMetadata();
		const issues = report.issues.filter(
			(issue) => issue.code !== "target_specific_logic_deferred",
		);
		if (!evidence.env.enabled) {
			issues.push({
				code: "herdr_pane_not_detected",
				message:
					"No Herdr pane detected (HERDR_ENV=1 + HERDR_PANE_ID absent); the opt-in bridge is inert.",
			});
		}
		return {
			...report,
			summary:
				"Herdr doctor reports Herdr pane detection plus OMX-owned adapter readiness; the bridge is opt-in and best-effort.",
			issues,
			nextSteps: [...bootstrap.nextSteps, `Herdr runtime: ${runtime.detail}`],
		};
	}
	if (target !== "hermes") {
		return report;
	}

	const evidence = await collectHermesEvidence(cwd);
	const runtime = buildHermesRuntimeObservation(evidence);
	const bootstrap = buildHermesBootstrapMetadata(evidence);
	const issues = report.issues.filter(
		(issue) => issue.code !== "target_specific_logic_deferred",
	);

	if (!evidence.installed) {
		issues.push({
			code: "hermes_runtime_missing",
			message: `Hermes external runtime was not detected under ${evidence.hermesRoot}.`,
		});
	} else if (!evidence.runtimeFiles.stateDbReadable) {
		issues.push({
			code: "hermes_session_store_unavailable",
			message: `Hermes session store is not readable at ${evidence.runtimeFiles.stateDbPath}.`,
		});
	}

	if (runtime.state === "degraded") {
		issues.push({
			code: "hermes_runtime_degraded",
			message: runtime.detail,
		});
	}

	return {
		...report,
		summary:
			"Hermes doctor inspects external ACP, gateway, and session-store evidence plus OMX-owned adapter readiness.",
		issues,
		nextSteps: [
			...bootstrap.nextSteps,
			...report.nextSteps.filter(
				(step) => !/follow-on integration gaps/i.test(step),
			),
		],
	};
}

export function initAdaptFoundation(
	cwd: string,
	target: AdaptTarget,
	write = false,
	now = new Date(),
): AdaptInitResult {
	const descriptor = getAdaptTargetDescriptor(target);
	if (!descriptor) {
		throw new Error(`Unknown adapt target: ${target}`);
	}

	const paths = resolveAdaptPaths(cwd, target);
	const planning = buildAdaptPlanningLink(cwd);

	if (target === "openclaw") {
		return initOpenClawFoundation(
			paths,
			planning,
			descriptor.capabilities,
			write,
			now,
		);
	}

	const envelope = buildAdaptEnvelope(cwd, target, now);
	const envelopePaths = envelope.adapterPaths;
	const previewPaths = [
		envelopePaths.adapterRoot,
		envelopePaths.configPath,
		envelopePaths.envelopePath,
		envelopePaths.reportsDir,
		envelopePaths.probeReportPath,
		envelopePaths.statusReportPath,
	];
	const wrotePaths: string[] = [];

	if (write) {
		mkdirSync(envelopePaths.reportsDir, { recursive: true });
		const config = {
			schemaVersion: ADAPT_SCHEMA_VERSION,
			target,
			createdAt: toIsoTimestamp(now),
			phase: "foundation",
			summary: descriptor.summary,
			followupHint: descriptor.followupHint,
			constraints: FOUNDATION_CONSTRAINTS,
		};
		writeFileSync(
			envelopePaths.configPath,
			`${JSON.stringify(config, null, 2)}\n`,
			"utf-8",
		);
		writeFileSync(
			envelopePaths.envelopePath,
			`${JSON.stringify(envelope, null, 2)}\n`,
			"utf-8",
		);
		wrotePaths.push(envelopePaths.configPath, envelopePaths.envelopePath);
	}

	return {
		schemaVersion: ADAPT_SCHEMA_VERSION,
		timestamp: toIsoTimestamp(now),
		target,
		write,
		summary: write
			? `${descriptor.displayName} adapter foundation was written under OMX-owned paths.`
			: `${descriptor.displayName} adapter foundation preview is ready; rerun with --write to materialize it.`,
		previewPaths,
		wrotePaths,
		envelope,
	};
}

export async function initAdaptFoundationForTarget(
	cwd: string,
	target: AdaptTarget,
	write = false,
	now = new Date(),
): Promise<AdaptInitResult> {
	const result = initAdaptFoundation(cwd, target, write, now);
	if (target === "herdr") {
		const evidence = collectHerdrEvidence();
		const envelope = applyHerdrEnvelope(result.envelope, evidence);
		if (write) {
			writeFileSync(
				envelope.adapterPaths.envelopePath,
				`${JSON.stringify(envelope, null, 2)}\n`,
				"utf-8",
			);
		}
		return {
			...result,
			envelope,
			summary: write
				? "Herdr adapter metadata was written under OMX-owned paths with Herdr pane detection evidence."
				: "Herdr adapter metadata preview includes Herdr pane detection evidence; rerun with --write to materialize it.",
		};
	}
	if (target !== "hermes") {
		return result;
	}

	const evidence = await collectHermesEvidence(cwd);
	const envelope = applyHermesEnvelope(result.envelope, evidence);
	if (write) {
		const paths = envelope.adapterPaths;
		writeFileSync(paths.envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf-8");
	}

	return {
		...result,
		envelope,
		summary: write
			? "Hermes adapter metadata was written under OMX-owned paths with external runtime evidence."
			: "Hermes adapter metadata preview includes external ACP/gateway/session-store evidence; rerun with --write to materialize it.",
	};
}
// Herdr lifecycle/status bridge (issue #3241, Phase 1) — reusable runtime bridge
// plus the production wiring entry point invoked from the hook dispatcher.
export {
	HerdrBridge,
	createHerdrBridge,
	HERDR_BRIDGE_SOURCE,
	HERDR_BRIDGE_AGENT,
	type HerdrBridgeOptions,
	type HerdrBridgeOutcome,
} from "./herdr/bridge.js";
export {
	reportHerdrLifecycleEvent,
	type HerdrWiringInput,
	type HerdrWiringResult,
} from "./herdr/wiring.js";
export {
	mapTeamStateToRollup,
	type TeamStateInput,
	type TeamWorkerStateInput,
} from "./herdr/team-map.js";
export {
	detectHerdrEnv,
	type HerdrEnv,
} from "./herdr/transport.js";
