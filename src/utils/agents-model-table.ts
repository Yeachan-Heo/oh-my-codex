import {
	AGENT_DEFINITIONS,
	type AgentDefinition,
} from "../agents/definitions.js";
import { isNativeAgentInstallableStatus } from "../agents/policy.js";
import { tryReadCatalogManifest } from "../catalog/reader.js";
import { getRootModelName } from "../config/generator.js";
import {
	DEFAULT_FRONTIER_MODEL,
	DEFAULT_SPARK_MODEL,
	getAgentModelOverride,
	getAgentReasoningOverride,
	getConfiguredTeamLowComplexityModel,
	getEnvConfiguredMainDefaultModel,
	getEnvConfiguredSparkDefaultModel,
	getEnvConfiguredStandardDefaultModel,
} from "../config/models.js";

export const OMX_MODELS_START_MARKER = "<!-- OMX:MODELS:START -->";
export const OMX_MODELS_END_MARKER = "<!-- OMX:MODELS:END -->";

const TEAM_MODEL_RESOLUTION_END = "</team_model_resolution>";

export interface AgentsModelTableContext {
	frontierModel: string;
	sparkModel: string;
	subagentDefaultModel: string;
}

interface AgentsModelTableOptions {
	codexHomeOverride?: string;
}

function escapeTableCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function formatRoleLabel(role: string): string {
	return role.includes("(") ? role : `\`${role}\``;
}

function getAgentRecommendedModel(
	agent: AgentDefinition,
	context: AgentsModelTableContext,
	options: AgentsModelTableOptions = {},
): string {
	const modelOverride = getAgentModelOverride(
		agent.name,
		options.codexHomeOverride,
	);
	if (modelOverride) {
		return modelOverride;
	}
	// Same role set as native-config resolveEnvTierModel: the frontier env tier
	// default beats the root config model, matching the baked native agent TOML.
	if (
		agent.exactModel ||
		agent.name === "executor" ||
		agent.modelClass === "frontier"
	) {
		return (
			getEnvConfiguredMainDefaultModel(process.env, options.codexHomeOverride) ??
			agent.exactModel ??
			context.frontierModel
		);
	}

	switch (agent.modelClass) {
		case "fast":
			return context.sparkModel;
		case "standard":
		default:
			return context.subagentDefaultModel;
	}
}

function getAgentReasoningEffort(
	agent: AgentDefinition,
	options: AgentsModelTableOptions = {},
): string {
	return (
		getAgentReasoningOverride(agent.name, options.codexHomeOverride) ??
		agent.reasoningEffort
	);
}

function getAgentUseCase(agent: AgentDefinition): string {
	return `${agent.description} (${agent.posture}, ${agent.modelClass})`;
}

function buildTableRow(
	role: string,
	model: string,
	reasoningEffort: string,
	useCase: string,
): string {
	return `| ${escapeTableCell(formatRoleLabel(role))} | ${escapeTableCell(`\`${model}\``)} | ${escapeTableCell(reasoningEffort)} | ${escapeTableCell(useCase)} |`;
}

function getModelTableAgents(
	definitions: Record<string, AgentDefinition>,
): AgentDefinition[] {
	const manifest = tryReadCatalogManifest();
	if (!manifest) return Object.values(definitions);

	const installableAgentNames = new Set(
		manifest.agents
			.filter((agent) => isNativeAgentInstallableStatus(agent.status))
			.map((agent) => agent.name),
	);

	return Object.values(definitions).filter((agent) =>
		installableAgentNames.has(agent.name),
	);
}

export function resolveAgentsModelTableContext(
	configTomlContent: string,
	options: {
		codexHomeOverride?: string;
		env?: NodeJS.ProcessEnv;
	} = {},
): AgentsModelTableContext {
	const { codexHomeOverride, env = process.env } = options;

	// Resolve frontier model from config.toml root model, env override, or default.
	// Priority: config.toml model > env override > default
	const rootModel = getRootModelName(configTomlContent);
	const envMainModel = getEnvConfiguredMainDefaultModel(env, codexHomeOverride);
	const frontierModel = rootModel ?? envMainModel ?? DEFAULT_FRONTIER_MODEL;

	// Spark never inherits the main model (the built-in spark default is the cheapest tier).
	// Same resolution as the runtime: explicit spark env > low-complexity keys > DEFAULT_SPARK_MODEL
	const explicitSparkOverride = getEnvConfiguredSparkDefaultModel(
		env,
		codexHomeOverride,
	);
	const lowComplexityOverride =
		getConfiguredTeamLowComplexityModel(codexHomeOverride);
	const sparkModel =
		explicitSparkOverride ?? lowComplexityOverride ?? DEFAULT_SPARK_MODEL;

	const subagentDefaultModel =
		getEnvConfiguredStandardDefaultModel(env, codexHomeOverride) ??
		frontierModel;

	return {
		frontierModel,
		sparkModel,
		subagentDefaultModel,
	};
}

export function buildAgentsModelTable(
	context: AgentsModelTableContext,
	definitions: Record<string, AgentDefinition> = AGENT_DEFINITIONS,
	options: AgentsModelTableOptions = {},
): string {
	const rows = [
		buildTableRow(
			"Frontier (leader)",
			context.frontierModel,
			"high",
			"Primary leader/orchestrator for planning, coordination, and frontier-class reasoning.",
		),
		buildTableRow(
			"Spark (explorer/fast)",
			context.sparkModel,
			"medium",
			"Fast triage, explore, lightweight synthesis, and low-latency routing.",
		),
		buildTableRow(
			"Standard (subagent default)",
			context.subagentDefaultModel,
			"high",
			"Default standard-capability model for installable specialists and secondary worker lanes unless a role is explicitly frontier or spark.",
		),
		...getModelTableAgents(definitions).map((agent) =>
			buildTableRow(
				agent.name,
				getAgentRecommendedModel(agent, context, options),
				getAgentReasoningEffort(agent, options),
				getAgentUseCase(agent),
			),
		),
	];

	return [
		"## Model Capability Table",
		"",
		"Auto-generated by `omx setup` from the current `config.toml` plus OMX model overrides. Precedence per role: `.omx-config.json` `agentModels[role]` > env tier default (`OMX_DEFAULT_FRONTIER_MODEL` for frontier and pinned roles, `OMX_DEFAULT_SPARK_MODEL` for spark, `OMX_DEFAULT_STANDARD_MODEL` for standard) > built-in pin or tier default.",
		"",
		"| Role | Model | Reasoning Effort | Use Case |",
		"| --- | --- | --- | --- |",
		...rows,
	].join("\n");
}

export function renderAgentsModelTableBlock(
	context: AgentsModelTableContext,
	definitions: Record<string, AgentDefinition> = AGENT_DEFINITIONS,
	options: AgentsModelTableOptions = {},
): string {
	return [
		OMX_MODELS_START_MARKER,
		buildAgentsModelTable(context, definitions, options),
		OMX_MODELS_END_MARKER,
	].join("\n");
}

export function upsertAgentsModelTable(
	content: string,
	context: AgentsModelTableContext,
	definitions: Record<string, AgentDefinition> = AGENT_DEFINITIONS,
	options: AgentsModelTableOptions = {},
): string {
	const block = renderAgentsModelTableBlock(context, definitions, options);
	const startIndex = content.indexOf(OMX_MODELS_START_MARKER);
	const endIndex = content.indexOf(OMX_MODELS_END_MARKER);

	if (startIndex >= 0 && endIndex > startIndex) {
		const replaceEnd = endIndex + OMX_MODELS_END_MARKER.length;
		return `${content.slice(0, startIndex)}${block}${content.slice(replaceEnd)}`;
	}

	const insertionAnchor = `${TEAM_MODEL_RESOLUTION_END}\n\n---`;
	if (content.includes(insertionAnchor)) {
		return content.replace(
			insertionAnchor,
			`${TEAM_MODEL_RESOLUTION_END}\n\n${block}\n\n---`,
		);
	}

	const trailingNewline = content.endsWith("\n") ? "" : "\n";
	return `${content}${trailingNewline}\n${block}\n`;
}
