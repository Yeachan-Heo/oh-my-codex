import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { inspectOpenClawConfig, resolveGateway } from "../openclaw/config.js";
import type {
	AdaptCapabilityReport,
	AdaptDoctorReport,
	AdaptEnvelope,
	AdaptInitResult,
	AdaptOpenClawGatewayObservation,
	AdaptOpenClawHookObservation,
	AdaptOpenClawMetadata,
	AdaptPathSet,
	AdaptPlanningLink,
	AdaptProbeReport,
	AdaptStatusReport,
} from "./contracts.js";
import { ADAPT_SCHEMA_VERSION } from "./contracts.js";

const OPENCLAW_HOOK_EVENTS = [
	"session-start",
	"session-end",
	"session-idle",
	"ask-user-question",
	"stop",
] as const;

const OPENCLAW_LIFECYCLE_BRIDGE = [
	{ omxEvent: "session-start", openclawEvent: "session-start" },
	{ omxEvent: "session-end", openclawEvent: "session-end" },
	{ omxEvent: "session-idle", openclawEvent: "session-idle" },
	{ omxEvent: "ask-user-question", openclawEvent: "ask-user-question" },
	{ omxEvent: "session-stop", openclawEvent: "stop" },
] as const;

function summarizeObservedState(
	metadata: Omit<AdaptOpenClawMetadata, "bootstrap">,
): string {
	switch (metadata.observedState) {
		case "configured":
			return `OpenClaw local adapter evidence is present with ${metadata.gateways.length} configured gateway(s) and ${metadata.hooks.filter((hook) => hook.status === "wired").length} wired hook mapping(s).`;
		case "degraded":
			return "OpenClaw local adapter evidence is partial; config is present but at least one mapped hook is locally blocked.";
		case "disabled":
			return "OpenClaw is disabled locally because OMX_OPENCLAW=1 is not set.";
		case "missing-config":
			return "OpenClaw is enabled, but no usable local config file was found.";
		case "invalid-config":
			return "OpenClaw config evidence exists, but it is invalid or incomplete.";
		default:
			return "OpenClaw has no local config or gateway evidence yet.";
	}
}

function observeOpenClaw(
	paths: AdaptPathSet,
	planning: AdaptPlanningLink,
): AdaptOpenClawMetadata {
	const inspection = inspectOpenClawConfig();
	const gateways: AdaptOpenClawGatewayObservation[] = [];
	const hooks: AdaptOpenClawHookObservation[] = [];

	if (inspection.config) {
		for (const [name, gateway] of Object.entries(inspection.config.gateways)) {
			const type = gateway.type === "command" ? "command" : "http";
			gateways.push({
				name,
				type,
				configured:
					type === "command"
						? Boolean("command" in gateway && gateway.command)
						: Boolean("url" in gateway && gateway.url),
				commandGateRequired: type === "command",
				commandGateEnabled:
					type === "command" ? inspection.commandGateEnabled : false,
				timeoutMs: typeof gateway.timeout === "number" ? gateway.timeout : null,
			});
		}

		for (const event of OPENCLAW_HOOK_EVENTS) {
			const mapping = inspection.config.hooks[event];
			if (!mapping || !mapping.enabled) {
				hooks.push({
					event,
					gateway: null,
					gatewayType: null,
					status: "unmapped",
					detail: "No enabled OpenClaw mapping exists for this event.",
				});
				continue;
			}

			const resolved = resolveGateway(inspection.config, event);
			if (!resolved) {
				hooks.push({
					event,
					gateway: mapping.gateway,
					gatewayType: null,
					status: "blocked",
					detail:
						"The hook mapping exists, but the referenced gateway is missing or disabled locally.",
				});
				continue;
			}

			const gatewayType =
				resolved.gateway.type === "command" ? "command" : "http";
			if (gatewayType === "command" && !inspection.commandGateEnabled) {
				hooks.push({
					event,
					gateway: resolved.gatewayName,
					gatewayType,
					status: "blocked",
					detail:
						"Mapped to a command gateway, but OMX_OPENCLAW_COMMAND=1 is not set.",
				});
				continue;
			}

			hooks.push({
				event,
				gateway: resolved.gatewayName,
				gatewayType,
				status: "wired",
				detail:
					gatewayType === "command"
						? "Mapped to a local command gateway with command opt-in enabled."
						: "Mapped to a local HTTP gateway; downstream acknowledgement is not observed here.",
			});
		}
	}

	const observedState =
		inspection.state === "configured" &&
		hooks.some((hook) => hook.status === "blocked")
			? "degraded"
			: inspection.state;

	const metadata: AdaptOpenClawMetadata = {
		observedState,
		observedDetail: inspection.detail,
		config: {
			activationGateEnabled: inspection.activationGateEnabled,
			commandGateEnabled: inspection.commandGateEnabled,
			configPath: inspection.configPath,
			configExists: inspection.configExists,
			source: inspection.configSource,
			explicitConfigPresent: inspection.explicitConfigPresent,
			aliasConfigPresent: inspection.aliasConfigPresent,
			aliasSources: inspection.aliasSources,
			explicitOverridesAliases: inspection.explicitOverridesAliases,
			warnings: inspection.warnings,
		},
		gateways,
		hooks,
		lifecycleBridge: OPENCLAW_LIFECYCLE_BRIDGE.map((entry) => ({ ...entry })),
		bootstrap: {
			adapterConfigPath: paths.configPath,
			envelopePath: paths.envelopePath,
			reportPaths: [paths.probeReportPath, paths.statusReportPath],
			planningArtifactPaths: [
				...(planning.prdPath ? [planning.prdPath] : []),
				...planning.testSpecPaths,
				...planning.deepInterviewSpecPaths,
				...(planning.contextPack ? [planning.contextPack.path] : []),
			],
		},
	};

	const { bootstrap: _bootstrap, ...summaryMetadata } = metadata;
	metadata.observedDetail = summarizeObservedState(summaryMetadata);
	return metadata;
}

export function buildOpenClawEnvelope(
	paths: AdaptPathSet,
	planning: AdaptPlanningLink,
	capabilities: AdaptCapabilityReport[],
	now: Date,
): AdaptEnvelope {
	const openclaw = observeOpenClaw(paths, planning);
	return {
		schemaVersion: ADAPT_SCHEMA_VERSION,
		generatedAt: now.toISOString(),
		target: "openclaw",
		displayName: "OpenClaw",
		summary:
			"OMX-owned OpenClaw adapter metadata built from existing local config, gateway, and lifecycle seams.",
		adapterPaths: paths,
		planning,
		capabilities,
		constraints: [
			"Status reflects local OMX/OpenClaw adapter evidence only; it does not claim downstream OpenClaw acknowledgement.",
			"Bootstrap output stays under .omx/adapters/openclaw/... and does not mutate .omx/state or upstream OpenClaw config.",
			"Command gateways remain gated by OMX_OPENCLAW_COMMAND=1 even when OMX_OPENCLAW=1 is enabled.",
		],
		openclaw,
	};
}

export function buildOpenClawProbeReport(
	paths: AdaptPathSet,
	planning: AdaptPlanningLink,
	capabilities: AdaptCapabilityReport[],
	now: Date,
): AdaptProbeReport {
	const openclaw = observeOpenClaw(paths, planning);
	const blockedHooks = openclaw.hooks.filter(
		(hook) => hook.status === "blocked",
	);
	return {
		schemaVersion: ADAPT_SCHEMA_VERSION,
		timestamp: now.toISOString(),
		target: "openclaw",
		phase: "foundation",
		summary: openclaw.observedDetail,
		adapterPaths: paths,
		planning,
		capabilities,
		targetRuntime: {
			state: "not-implemented",
			detail:
				"Probe reports only local OpenClaw adapter evidence; remote runtime acceptance remains unobserved.",
		},
		openclaw,
		nextSteps:
			blockedHooks.length > 0
				? blockedHooks.map((hook) => `${hook.event}: ${hook.detail}`)
				: [
						"Run omx adapt openclaw init --write to materialize adapter-owned OpenClaw artifacts.",
						"Confirm downstream OpenClaw behavior separately; this probe reports local wiring evidence only.",
					],
	};
}

export function buildOpenClawStatusReport(
	paths: AdaptPathSet,
	planning: AdaptPlanningLink,
	capabilities: AdaptCapabilityReport[],
	now: Date,
): AdaptStatusReport {
	const initialized =
		existsSync(paths.configPath) && existsSync(paths.envelopePath);
	const openclaw = observeOpenClaw(paths, planning);
	return {
		schemaVersion: ADAPT_SCHEMA_VERSION,
		timestamp: now.toISOString(),
		target: "openclaw",
		phase: "foundation",
		summary: initialized
			? `OpenClaw adapter artifacts exist under .omx/adapters/openclaw/... and local runtime evidence is ${openclaw.observedState}.`
			: `OpenClaw adapter artifacts have not been written yet; local runtime evidence is ${openclaw.observedState}.`,
		adapter: {
			state: initialized ? "initialized" : "not-initialized",
			detail: initialized
				? "Adapter-owned OpenClaw artifacts are present under .omx/adapters/openclaw/..."
				: "Run init --write to create adapter-owned OpenClaw artifacts.",
			configPath: paths.configPath,
			envelopePath: paths.envelopePath,
		},
		targetRuntime: {
			state: "unknown",
			detail:
				"Status reflects local config/env/gateway wiring evidence only, not authoritative remote OpenClaw runtime health.",
		},
		planning,
		capabilities,
		openclaw,
	};
}

export function buildOpenClawDoctorReport(
	paths: AdaptPathSet,
	planning: AdaptPlanningLink,
	now: Date,
): AdaptDoctorReport {
	const openclaw = observeOpenClaw(paths, planning);
	const issues = [];

	if (!existsSync(paths.configPath) || !existsSync(paths.envelopePath)) {
		issues.push({
			code: "adapter_not_initialized",
			message:
				"No OpenClaw adapter artifacts exist under .omx/adapters/openclaw.",
		});
	}

	if (!openclaw.config.activationGateEnabled) {
		issues.push({
			code: "openclaw_disabled",
			message:
				"OMX_OPENCLAW=1 is required before OpenClaw local config can be observed.",
		});
	} else if (
		openclaw.observedState === "missing-config" ||
		openclaw.observedState === "not-configured"
	) {
		issues.push({
			code: "openclaw_config_missing",
			message: `No usable OpenClaw config was found at ${openclaw.config.configPath}.`,
		});
	} else if (openclaw.observedState === "invalid-config") {
		issues.push({
			code: "openclaw_config_invalid",
			message:
				"OpenClaw config keys are present but do not form a valid runtime config.",
		});
	}

	if (openclaw.hooks.some((hook) => hook.status === "blocked")) {
		issues.push({
			code: "openclaw_hook_blocked",
			message:
				"At least one enabled OpenClaw hook is locally blocked by missing gateway evidence or command-gateway opt-in.",
		});
	}

	if (!planning.prdPath) {
		issues.push({
			code: "planning_artifacts_missing",
			message:
				"No canonical OMX PRD artifact is available to link into the OpenClaw adapter envelope.",
		});
	}

	return {
		schemaVersion: ADAPT_SCHEMA_VERSION,
		timestamp: now.toISOString(),
		target: "openclaw",
		phase: "foundation",
		summary:
			"OpenClaw doctor reports local adapter readiness and local gateway wiring evidence only.",
		issues,
		nextSteps: [
			"Run omx adapt openclaw init --write.",
			"Set OMX_OPENCLAW=1 and configure notifications.openclaw or compatible aliases in ~/.codex/.omx-config.json.",
			"If command gateways are configured, also set OMX_OPENCLAW_COMMAND=1 before expecting command mappings to be locally ready.",
		],
	};
}

export function initOpenClawFoundation(
	paths: AdaptPathSet,
	planning: AdaptPlanningLink,
	capabilities: AdaptCapabilityReport[],
	write: boolean,
	now: Date,
): AdaptInitResult {
	const envelope = buildOpenClawEnvelope(paths, planning, capabilities, now);
	const previewPaths = [
		paths.adapterRoot,
		paths.configPath,
		paths.envelopePath,
		paths.reportsDir,
		paths.probeReportPath,
		paths.statusReportPath,
	];
	const wrotePaths: string[] = [];

	if (write) {
		mkdirSync(paths.reportsDir, { recursive: true });
		writeFileSync(
			paths.configPath,
			`${JSON.stringify(
				{
					schemaVersion: ADAPT_SCHEMA_VERSION,
					target: "openclaw",
					createdAt: now.toISOString(),
					phase: "openclaw-local-observation",
					observedState: envelope.openclaw?.observedState ?? "not-configured",
					summary: "OMX-owned OpenClaw adapter bootstrap metadata.",
					lifecycleBridge: envelope.openclaw?.lifecycleBridge ?? [],
					constraints: envelope.constraints,
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);
		writeFileSync(
			paths.envelopePath,
			`${JSON.stringify(envelope, null, 2)}\n`,
			"utf-8",
		);
		wrotePaths.push(paths.configPath, paths.envelopePath);
	}

	return {
		schemaVersion: ADAPT_SCHEMA_VERSION,
		timestamp: now.toISOString(),
		target: "openclaw",
		write,
		summary: write
			? "OpenClaw adapter metadata was written under .omx/adapters/openclaw/..."
			: "OpenClaw adapter bootstrap preview is ready; rerun with --write to materialize it.",
		previewPaths,
		wrotePaths,
		envelope,
	};
}
