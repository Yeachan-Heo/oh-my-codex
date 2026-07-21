import type {
	AdaptBootstrapMetadata,
	AdaptCapabilityReport,
	AdaptEnvelope,
	AdaptProbeReport,
	AdaptRuntimeObservation,
	AdaptStatusReport,
} from "./contracts.js";
import { detectHerdrEnv, type HerdrEnv } from "./herdr/transport.js";

export interface HerdrEvidence {
	env: HerdrEnv;
	transport: "socket" | "cli" | "none";
}

/**
 * Herdr evidence is environment-based: OMX only bridges to Herdr when it is
 * running inside a Herdr-managed pane (HERDR_ENV=1 + HERDR_PANE_ID). Socket
 * transport is preferred when HERDR_SOCKET_PATH is exported.
 */
export function collectHerdrEvidence(
	env: NodeJS.ProcessEnv = process.env,
): HerdrEvidence {
	const detected = detectHerdrEnv(env);
	const transport: HerdrEvidence["transport"] = !detected.enabled
		? "none"
		: detected.socketPath
			? "socket"
			: "cli";
	return { env: detected, transport };
}

export function buildHerdrCapabilityOverrides(
	capabilities: AdaptCapabilityReport[],
	evidence: HerdrEvidence,
): AdaptCapabilityReport[] {
	return capabilities.map((capability) => {
		if (capability.id === "herdr-env-detection") {
			return {
				...capability,
				status: evidence.env.enabled ? "ready" : "stub",
				summary: evidence.env.enabled
					? `Herdr pane detected (pane ${evidence.env.paneId}); ${evidence.transport} transport selected.`
					: "Herdr pane environment (HERDR_ENV=1 + HERDR_PANE_ID) is not present; the bridge stays inert.",
			};
		}
		if (capability.id === "lifecycle-status-bridge") {
			return {
				...capability,
				status: evidence.env.enabled ? "ready" : "stub",
				summary: evidence.env.enabled
					? "OMX lifecycle/team state can be reported as Herdr semantic state with monotonic seq ordering and authority release."
					: "Lifecycle/status bridge is available but idle until OMX runs inside a Herdr pane.",
			};
		}
		return capability;
	});
}

export function buildHerdrRuntimeObservation(
	evidence: HerdrEvidence,
): AdaptRuntimeObservation {
	if (!evidence.env.enabled) {
		return {
			state: "not-detected",
			detail:
				"OMX is not running inside a Herdr pane; set HERDR_ENV=1 and HERDR_PANE_ID (Herdr exports these automatically) to enable the bridge.",
			evidence: {
				herdrEnv: false,
				paneId: evidence.env.paneId,
				socketPath: evidence.env.socketPath,
			},
		};
	}
	return {
		state: "detected",
		detail: `Herdr pane ${evidence.env.paneId} detected; ${evidence.transport} transport will be used for best-effort, non-blocking reports.`,
		evidence: {
			herdrEnv: true,
			paneId: evidence.env.paneId,
			socketPath: evidence.env.socketPath,
			binPath: evidence.env.binPath,
			transport: evidence.transport,
		},
	};
}

export function buildHerdrBootstrapMetadata(): AdaptBootstrapMetadata {
	return {
		summary:
			"Herdr bootstrap maps OMX lifecycle/team state into Herdr semantic states (working/blocked/idle/unknown) via the documented pane.report_agent / pane.release_agent surfaces. Phase 2 runtime backend is out of scope.",
		eventBridge: [
			"session-start / run.heartbeat / worker.assigned -> working",
			"blocked / run.blocked_on_user / needs-input -> blocked",
			"turn-complete / finished / failed / session-end -> idle (+ release authority)",
			"unmapped/uncertain -> unknown",
		],
		commands: [
			'herdr pane report-agent "$HERDR_PANE_ID" --source omx:runtime --agent codex --state working --seq <n>',
			'herdr pane release-agent "$HERDR_PANE_ID" --source omx:runtime --seq <n>',
		],
		nextSteps: [
			"Run OMX inside a Herdr pane; the bridge is opt-in and inert otherwise.",
			"A Herdr socket/CLI failure never fails the OMX run (best-effort, non-blocking).",
		],
	};
}

export function applyHerdrEnvelope(
	envelope: AdaptEnvelope,
	evidence: HerdrEvidence,
): AdaptEnvelope {
	return {
		...envelope,
		capabilities: buildHerdrCapabilityOverrides(envelope.capabilities, evidence),
		targetRuntime: buildHerdrRuntimeObservation(evidence),
		bootstrap: buildHerdrBootstrapMetadata(),
	};
}

export function applyHerdrProbe(
	report: AdaptProbeReport,
	evidence: HerdrEvidence,
): AdaptProbeReport {
	return {
		...report,
		summary: evidence.env.enabled
			? "Herdr probe detected a live Herdr pane; the opt-in lifecycle/status bridge is ready."
			: "Herdr probe found no Herdr pane; the bridge stays inert until OMX runs inside Herdr.",
		capabilities: buildHerdrCapabilityOverrides(report.capabilities, evidence),
		targetRuntime: buildHerdrRuntimeObservation(evidence),
		nextSteps: [
			"Run omx adapt herdr init --write to materialize OMX-owned adapter artifacts.",
			"Launch OMX inside a Herdr pane to activate the opt-in bridge.",
		],
	};
}

export function applyHerdrStatus(
	report: AdaptStatusReport,
	evidence: HerdrEvidence,
): AdaptStatusReport {
	const targetRuntime = buildHerdrRuntimeObservation(evidence);
	return {
		...report,
		summary: evidence.env.enabled
			? "Herdr adapter is active inside a detected Herdr pane."
			: "Herdr adapter is available but inert; no Herdr pane is currently detected.",
		capabilities: buildHerdrCapabilityOverrides(report.capabilities, evidence),
		targetRuntime,
	};
}
