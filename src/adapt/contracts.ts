export const ADAPT_SCHEMA_VERSION = "1.0";

export const ADAPT_TARGETS = ["openclaw", "hermes", "herdr"] as const;
export type AdaptTarget = (typeof ADAPT_TARGETS)[number];

export const ADAPT_SUBCOMMANDS = [
	"probe",
	"status",
	"init",
	"envelope",
	"doctor",
] as const;
export type AdaptSubcommand = (typeof ADAPT_SUBCOMMANDS)[number];

export type AdaptCapabilityOwnership =
	| "omx-owned"
	| "shared-contract"
	| "target-observed";

export type AdaptCapabilityStatus = "ready" | "stub" | "unsupported";

export interface AdaptCapabilityReport {
	id: string;
	label: string;
	ownership: AdaptCapabilityOwnership;
	status: AdaptCapabilityStatus;
	summary: string;
}

export interface AdaptTargetDescriptor {
	target: AdaptTarget;
	displayName: string;
	summary: string;
	followupHint: string;
	capabilities: AdaptCapabilityReport[];
}

export interface AdaptPathSet {
	adapterRoot: string;
	configPath: string;
	envelopePath: string;
	reportsDir: string;
	probeReportPath: string;
	statusReportPath: string;
}

export interface AdaptPlanningLink {
	prdPath: string | null;
	testSpecPaths: string[];
	deepInterviewSpecPaths: string[];
	summary: string;
}

export interface AdaptOpenClawGatewayObservation {
	name: string;
	type: "http" | "command";
	configured: boolean;
	commandGateRequired: boolean;
	commandGateEnabled: boolean;
	timeoutMs: number | null;
}

export interface AdaptOpenClawHookObservation {
	event: string;
	gateway: string | null;
	gatewayType: "http" | "command" | null;
	status: "wired" | "blocked" | "unmapped";
	detail: string;
}

export interface AdaptOpenClawMetadata {
	observedState:
		| "configured"
		| "degraded"
		| "disabled"
		| "missing-config"
		| "invalid-config"
		| "not-configured";
	observedDetail: string;
	config: {
		activationGateEnabled: boolean;
		commandGateEnabled: boolean;
		configPath: string;
		configExists: boolean;
		source: string | null;
		explicitConfigPresent: boolean;
		aliasConfigPresent: boolean;
		aliasSources: Array<"custom_cli_command" | "custom_webhook_command">;
		explicitOverridesAliases: boolean;
		warnings: string[];
	};
	gateways: AdaptOpenClawGatewayObservation[];
	hooks: AdaptOpenClawHookObservation[];
	lifecycleBridge: Array<{
		omxEvent: string;
		openclawEvent: string;
	}>;
	bootstrap?: {
		adapterConfigPath: string;
		envelopePath: string;
		reportPaths: string[];
		planningArtifactPaths: string[];
	};
}

export interface AdaptEnvelope {
	schemaVersion: string;
	generatedAt: string;
	target: AdaptTarget;
	displayName: string;
	summary: string;
	adapterPaths: AdaptPathSet;
	planning: AdaptPlanningLink;
	capabilities: AdaptCapabilityReport[];
	constraints: string[];
	targetRuntime?: AdaptRuntimeObservation;
	bootstrap?: AdaptBootstrapMetadata;
	openclaw?: AdaptOpenClawMetadata;
}

export interface AdaptRuntimeObservation {
	state: string;
	detail: string;
	evidence?: Record<string, unknown>;
}

export interface AdaptBootstrapMetadata {
	summary: string;
	eventBridge: string[];
	commands: string[];
	nextSteps: string[];
}

export interface AdaptProbeReport {
	schemaVersion: string;
	timestamp: string;
	target: AdaptTarget;
	phase: "foundation";
	summary: string;
	adapterPaths: AdaptPathSet;
	planning: AdaptPlanningLink;
	capabilities: AdaptCapabilityReport[];
	targetRuntime: AdaptRuntimeObservation;
	openclaw?: AdaptOpenClawMetadata;
	nextSteps: string[];
}

export interface AdaptStatusReport {
	schemaVersion: string;
	timestamp: string;
	target: AdaptTarget;
	phase: "foundation";
	summary: string;
	adapter: {
		state: "initialized" | "not-initialized";
		detail: string;
		configPath: string;
		envelopePath: string;
	};
	targetRuntime: AdaptRuntimeObservation;
	planning: AdaptPlanningLink;
	capabilities: AdaptCapabilityReport[];
	openclaw?: AdaptOpenClawMetadata;
}

export interface AdaptDoctorIssue {
	code: string;
	message: string;
}

export interface AdaptDoctorReport {
	schemaVersion: string;
	timestamp: string;
	target: AdaptTarget;
	phase: "foundation";
	summary: string;
	issues: AdaptDoctorIssue[];
	nextSteps: string[];
}

export interface AdaptInitResult {
	schemaVersion: string;
	timestamp: string;
	target: AdaptTarget;
	write: boolean;
	summary: string;
	previewPaths: string[];
	wrotePaths: string[];
	envelope: AdaptEnvelope;
}
