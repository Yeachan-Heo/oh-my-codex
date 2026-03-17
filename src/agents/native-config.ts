/**
 * Native agent config generators for Codex CLI.
 * Writes standalone TOML files under ~/.codex/agents/ or ./.codex/agents/.
 */

import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { AGENT_DEFINITIONS, AgentDefinition } from "./definitions.js";
import { codexAgentsDir } from "../utils/paths.js";

const POSTURE_OVERLAYS: Record<AgentDefinition["posture"], string> = {
  "frontier-orchestrator": [
    "<posture_overlay>",
    "",
    "You are operating in the frontier-orchestrator posture.",
    "- Prioritize intent classification before implementation.",
    "- Default to delegation and orchestration when specialists exist.",
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
    "- Explore first, then implement minimal changes that match existing patterns.",
    "- Keep verification strict: diagnostics, tests, and build evidence are mandatory before claiming completion.",
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
    "- Keep responses concise, scope-aware, and conservative under ambiguity.",
    "",
    "</posture_overlay>",
  ].join("\n"),
};

const MODEL_CLASS_OVERLAYS: Record<AgentDefinition["modelClass"], string> = {
  frontier: [
    "<model_class_guidance>",
    "",
    "This role is tuned for frontier-class models.",
    "- Use the model's steerability for coordination, tradeoff reasoning, and precise delegation.",
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

export interface GeneratedNativeAgentConfig {
  name: string;
  description: string;
  developerInstructions?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
}

function buildPromptInstructions(
  agent: AgentDefinition,
  promptContent: string,
): string {
  const instructions = stripFrontmatter(promptContent);
  return [
    instructions,
    "",
    POSTURE_OVERLAYS[agent.posture],
    "",
    MODEL_CLASS_OVERLAYS[agent.modelClass],
    "",
    "## OMX Agent Metadata",
    `- role: ${agent.name}`,
    `- posture: ${agent.posture}`,
    `- model_class: ${agent.modelClass}`,
    `- routing_role: ${agent.routingRole}`,
  ].join("\n");
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
 */
export function generateAgentToml(
  agent: AgentDefinition,
  promptContent: string,
): string {
  return generateStandaloneAgentToml({
    name: agent.name,
    description: agent.description,
    developerInstructions: buildPromptInstructions(agent, promptContent),
    reasoningEffort: agent.reasoningEffort,
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
  } = {},
): Promise<number> {
  const {
    force = false,
    dryRun = false,
    verbose = false,
    agentsDir = codexAgentsDir(),
  } = options;

  if (!dryRun) {
    await mkdir(agentsDir, { recursive: true });
  }

  let count = 0;

  for (const [name, agent] of Object.entries(AGENT_DEFINITIONS)) {
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
    const toml = generateAgentToml(agent, promptContent);

    if (!dryRun) {
      await writeFile(dst, toml);
    }
    if (verbose) console.log(`  ${name}.toml`);
    count += 1;
  }

  return count;
}
