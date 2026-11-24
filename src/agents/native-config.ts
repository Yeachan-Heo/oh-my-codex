/**
 * Native agent config generators for Codex CLI.
 * Writes standalone TOML files under ~/.codex/agents/ or ./.codex/agents/.
 *
 * Model precedence for the written TOML `model` key:
 * 1. Per-agent override: .omx-config.json agentModels[role]
 * 2. Tier env var for the role's modelClass (shell env or .omx-config.json `env`):
 *    OMX_DEFAULT_FRONTIER_MODEL, OMX_DEFAULT_STANDARD_MODEL, OMX_DEFAULT_SPARK_MODEL
 * 3. Built-in tier default (gpt-6.2-astra / gpt-6.2-sol / gpt-6-luna)
 *
 * For built-in providers the resolved model is written for every role. For custom providers the
 * `model` key is omitted unless agentModels[role] is set. The config.toml root model is the
 * main/leader session model only and never affects agent tiers.
 */

import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { AGENT_DEFINITIONS, AgentDefinition } from "./definitions.js";
import { readCatalogManifest } from "../catalog/reader.js";
import type { CatalogManifest } from "../catalog/schema.js";
import { getInstallableNativeAgentNames } from "./policy.js";
import {
  getAgentReasoningOverride,
  getAgentModelOverride,
  getModelClassDefaultModel,
  getCodexConfigEffectiveModel,
  getCodexConfigEffectiveModelProvider,
  isBuiltinProvider,
  type PerAgentReasoningEffort,
} from "../config/models.js";
import { codexAgentsDir } from "../utils/paths.js";



const POSTURE_OVERLAYS: Record<AgentDefinition["posture"], string> = {
  "frontier-orchestrator": [
    "<posture_overlay>",
    "",
    "You are operating in the frontier-orchestrator posture.",
    "- Prioritize intent classification before implementation.",
    "- Specialist coverage must stay within the assigned role and delegation authority.",
    "- Treat the first decision as a routing problem: research vs planning vs implementation vs verification.",
    "- Challenge flawed user assumptions concisely before execution when the design is likely to cause avoidable problems.",
    "- Preserve explicit executor handoff boundaries: do not absorb deep implementation work when a specialized executor is more appropriate.",
    "",
    "</posture_overlay>",
  ].join("\n"),
  "deep-worker": [
    "<posture_overlay>",
    "",
    "You are operating in the deep-worker posture.",
    "- Once the task is clearly implementation-oriented, bias toward direct execution and end-to-end completion.",
    "- For authorized implementation, explore first, then make minimal changes that match existing patterns.",
    "- Verify the assigned result with fresh evidence: run diagnostics, tests, and builds when required by the task or repository; read-only analysis ends with supported conclusions and explicit limits.",
    "- Escalate only after materially different approaches fail or when architecture tradeoffs exceed local implementation scope.",
    "",
    "</posture_overlay>",
  ].join("\n"),
  "fast-lane": [
    "<posture_overlay>",
    "",
    "You are operating in the fast-lane posture.",
    "- Optimize for fast triage, search, lightweight synthesis, and narrow routing decisions.",
    "- Do not start deep implementation unless the task is tightly bounded and obvious.",
    "- If the task expands beyond quick classification or lightweight execution, escalate to a frontier-orchestrator or deep-worker role.",
    "- Keep responses quality-first, scope-aware, and conservative under ambiguity; avoid empty verbosity and reflexive tool escalation.",
    "",
    "</posture_overlay>",
  ].join("\n"),
};

const MODEL_CLASS_OVERLAYS: Record<AgentDefinition["modelClass"], string> = {
  frontier: [
    "<model_class_guidance>",
    "",
    "This role is tuned for frontier-class models.",
    "- Use the model's steerability for the assigned scope, tradeoff reasoning, and precise handoffs.",
    "- Favor clean routing decisions over impulsive implementation.",
    "",
    "</model_class_guidance>",
  ].join("\n"),
  standard: [
    "<model_class_guidance>",
    "",
    "This role is tuned for standard-capability models.",
    "- Balance autonomy with clear boundaries.",
    "- Prefer explicit verification and narrow scope control over speculative reasoning.",
    "",
    "</model_class_guidance>",
  ].join("\n"),
  fast: [
    "<model_class_guidance>",
    "",
    "This role is tuned for fast/low-latency models.",
    "- Prefer quick search, synthesis, and routing over prolonged reasoning.",
    "- Escalate rather than bluff when deeper work is required.",
    "",
    "</model_class_guidance>",
  ].join("\n"),
};

const NATIVE_SUBAGENT_LEAF_GUARD = [
  "<native_subagent_leaf_guard>",
  "",
  "Leaf native subagent: do not call Task, spawn_agent, or native child agents.",
  "Use local tools; report missing specialist coverage to the leader.",
  "",
  "</native_subagent_leaf_guard>",
].join("\n");

export interface GeneratedNativeAgentConfig {
  name: string;
  description: string;
  developerInstructions?: string;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: PerAgentReasoningEffort;
}

interface AgentModelResolutionOptions {
  codexHomeOverride?: string;
  env?: NodeJS.ProcessEnv;
}

interface RoleInstructionMetadata {
  name: string;
  posture: AgentDefinition["posture"];
  modelClass: AgentDefinition["modelClass"];
  routingRole: AgentDefinition["routingRole"];
  nativeSubagentDelegation?: AgentDefinition["nativeSubagentDelegation"];
}

interface ComposeRoleInstructionsOptions {
  nativeAgent?: boolean;
}

function resolveAgentModel(
  agent: AgentDefinition,
  options: AgentModelResolutionOptions = {},
): string | undefined {
  const modelOverride = getAgentModelOverride(agent.name, options.codexHomeOverride);
  if (modelOverride) return modelOverride;

  // Case-sensitive provider classification: custom providers like "OpenAI" do not match built-in "openai".
  const isBuiltin = isBuiltinProvider(getCodexConfigEffectiveModelProvider(options.codexHomeOverride));
  if (isBuiltin) {
    return getModelClassDefaultModel(agent.modelClass, options.codexHomeOverride, options.env);
  }
  // Custom provider: the provider's configured model (if any) is metadata only; no tier model applies.
  return getCodexConfigEffectiveModel(options.codexHomeOverride);
}

export function composeRoleInstructions(
  promptContent: string,
  metadata: RoleInstructionMetadata | null,
  resolvedModel?: string,
  options: ComposeRoleInstructionsOptions = {},
): string {
  const instructions = stripFrontmatter(promptContent);
  const parts = [instructions];

  if (metadata) {
    parts.push(
      "",
      POSTURE_OVERLAYS[metadata.posture],
      "",
      MODEL_CLASS_OVERLAYS[metadata.modelClass],
    );
  }

  if (options.nativeAgent === true && metadata?.nativeSubagentDelegation !== "allowed") {
    parts.push("", NATIVE_SUBAGENT_LEAF_GUARD);
  }

  const metadataLines = [];
  if (metadata) {
    metadataLines.push(
      "## OMX Agent Metadata",
      `- role: ${metadata.name}`,
      `- posture: ${metadata.posture}`,
      `- model_class: ${metadata.modelClass}`,
      `- routing_role: ${metadata.routingRole}`,
    );
    if (options.nativeAgent === true && metadata.nativeSubagentDelegation) {
      metadataLines.push(`- native_subagent_delegation: ${metadata.nativeSubagentDelegation}`);
    }
  }
  if (resolvedModel) {
    if (metadataLines.length === 0) {
      metadataLines.push("## OMX Agent Metadata");
    }
    metadataLines.push(`- resolved_model: ${resolvedModel}`);
  }
  if (metadataLines.length > 0) {
    parts.push("", ...metadataLines);
  }

  return parts.join("\n");
}

export function composeRoleInstructionsForRole(
  roleName: string,
  promptContent: string,
  resolvedModel?: string,
): string {
  const agent = AGENT_DEFINITIONS[roleName];
  return composeRoleInstructions(
    promptContent,
    agent
      ? {
          name: agent.name,
          posture: agent.posture,
      modelClass: agent.modelClass,
      routingRole: agent.routingRole,
      nativeSubagentDelegation: agent.nativeSubagentDelegation,
    }
      : null,
    resolvedModel,
  );
}

/**
 * Strip YAML frontmatter (between --- markers) from markdown content.
 */
export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (match) {
    return content.slice(match[0].length).trim();
  }
  return content.trim();
}

/**
 * Escape content for TOML triple-quoted strings.
 * TOML """ strings only need to escape sequences of 3+ consecutive quotes.
 */
function escapeTomlMultiline(s: string): string {
  return s.replace(/"{3,}/g, (match) => match.split("").join("\\"));
}

function escapeTomlBasicString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function generateStandaloneAgentToml(
  config: GeneratedNativeAgentConfig,
): string {
  const lines = [
    `# oh-my-codex agent: ${config.name}`,
    `name = "${escapeTomlBasicString(config.name)}"`,
    `description = "${escapeTomlBasicString(config.description)}"`,
  ];

  if (config.model) {
    lines.push(`model = "${escapeTomlBasicString(config.model)}"`);
  }
  if (config.modelProvider) {
    lines.push(`model_provider = "${escapeTomlBasicString(config.modelProvider)}"`);
  }
  if (config.reasoningEffort) {
    lines.push(`model_reasoning_effort = "${config.reasoningEffort}"`);
  }
  if (
    typeof config.developerInstructions === "string" &&
    config.developerInstructions.trim().length > 0
  ) {
    const escapedInstructions = escapeTomlMultiline(
      config.developerInstructions,
    );
    lines.push('developer_instructions = """', escapedInstructions, '"""');
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Generate TOML content for a prompt-backed OMX role agent.
 * Includes model field for all agents for documentation and discoverability.
 * Only includes modelProvider field if there's an explicit per-agent override,
 * not when it merely mirrors the config default. This prevents agent TOMLs from
 * becoming stale when config.toml provider changes (fixes #3779).
 */
export function generateAgentToml(
  agent: AgentDefinition,
  promptContent: string,
  options: AgentModelResolutionOptions = {},
): string {
  const resolvedModel = resolveAgentModel(agent, options);
  const reasoningOverride = getAgentReasoningOverride(agent.name, options.codexHomeOverride);
  const isBuiltin = isBuiltinProvider(getCodexConfigEffectiveModelProvider(options.codexHomeOverride));
  const hasAgentModelOverride = !!getAgentModelOverride(agent.name, options.codexHomeOverride);

  return generateStandaloneAgentToml({
    name: agent.name,
    description: agent.description,
    developerInstructions: composeRoleInstructions(
      promptContent,
      agent,
      resolvedModel,
      { nativeAgent: true },
    ),
    // Built-in providers: always write the resolved tier model. Custom providers: only write the
    // model when agentModels[role] is set; otherwise the agent inherits the provider default at runtime.
    model: (isBuiltin || hasAgentModelOverride) ? resolvedModel : undefined,
    // Never include modelProvider field in agent TOMLs to prevent staleness.
    // Agents inherit model_provider from config.toml at runtime. Not pinning provider for
    // model-only overrides allows independent provider updates at runtime.
    modelProvider: undefined,
    reasoningEffort: reasoningOverride ?? agent.reasoningEffort,
  });
}

/**
 * Install prompt-backed native agent config .toml files to ~/.codex/agents/
 * Returns the number of agent files written.
 */
export async function installNativeAgentConfigs(
  pkgRoot: string,
  options: {
    force?: boolean;
    dryRun?: boolean;
    verbose?: boolean;
    agentsDir?: string;
    catalogManifest?: CatalogManifest;
    allowUncatalogedDefinitions?: boolean;
  } = {},
): Promise<number> {
  const {
    force = false,
    dryRun = false,
    verbose = false,
    agentsDir = codexAgentsDir(),
    catalogManifest,
    allowUncatalogedDefinitions = false,
  } = options;
  const codexHomeOverride = join(agentsDir, "..");

  if (!dryRun) {
    await mkdir(agentsDir, { recursive: true });
  }

  let count = 0;

  const installableAgentNames = allowUncatalogedDefinitions
    ? new Set(Object.keys(AGENT_DEFINITIONS))
    : getInstallableNativeAgentNames(catalogManifest ?? readCatalogManifest(pkgRoot));

  for (const name of [...installableAgentNames].sort()) {
    const agent = AGENT_DEFINITIONS[name];
    if (!agent) {
      if (verbose) console.log(`  skip ${name} (no agent definition)`);
      continue;
    }
    const promptPath = join(pkgRoot, "prompts", `${name}.md`);
    if (!existsSync(promptPath)) {
      if (verbose) console.log(`  skip ${name} (no prompt file)`);
      continue;
    }

    const dst = join(agentsDir, `${name}.toml`);
    if (!force && existsSync(dst)) {
      if (verbose) console.log(`  skip ${name} (already exists)`);
      continue;
    }

    const promptContent = await readFile(promptPath, "utf-8");
    const toml = generateAgentToml(agent, promptContent, { codexHomeOverride });

    if (!dryRun) {
      await writeFile(dst, toml);
    }
    if (verbose) console.log(`  ${name}.toml`);
    count += 1;
  }

  return count;
}
