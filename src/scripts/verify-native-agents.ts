#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import TOML from "@iarna/toml";
import { AGENT_DEFINITIONS, type AgentDefinition } from "../agents/definitions.js";
import { generateAgentToml } from "../agents/native-config.js";
import {
  NON_NATIVE_AGENT_PROMPT_ASSETS,
  assertNativeAgentCanonicalTargets,
  getCatalogAgentByName,
  getInstallableNativeAgentNames,
  isNativeAgentInstallableStatus,
} from "../agents/policy.js";
import { readCatalogManifest } from "../catalog/reader.js";
import type { CatalogManifest } from "../catalog/schema.js";

export interface VerifyNativeAgentsOptions {
  root?: string;
  manifest?: CatalogManifest;
  definitions?: Record<string, AgentDefinition>;
  promptNames?: Set<string>;
  pluginManifest?: Record<string, unknown>;
}

export interface VerifyNativeAgentsResult {
  installableAgentNames: string[];
  promptAssetNames: string[];
}

function errorBlock(code: string, fields: Record<string, unknown>): Error {
  return new Error(
    [
      code,
      ...Object.entries(fields).map(
        ([key, value]) => `${key}=${JSON.stringify(value)}`,
      ),
    ].join("\n"),
  );
}

async function readPromptNames(root: string): Promise<Set<string>> {
  const promptsDir = join(root, "prompts");
  const entries = await readdir(promptsDir, { withFileTypes: true });
  return new Set(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -3)),
  );
}

async function readPluginManifest(
  root: string,
): Promise<Record<string, unknown> | null> {
  const pluginManifestPath = join(
    root,
    "plugins",
    "oh-my-codex",
    ".codex-plugin",
    "plugin.json",
  );
  if (!existsSync(pluginManifestPath)) return null;
  return JSON.parse(await readFile(pluginManifestPath, "utf-8")) as Record<
    string,
    unknown
  >;
}

function assertTomlStructure(
  agentName: string,
  agent: AgentDefinition,
  toml: string,
): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = TOML.parse(toml) as Record<string, unknown>;
  } catch (cause) {
    throw errorBlock("native_agent_toml_invalid", {
      agent: agentName,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }

  if (parsed.name !== agentName) {
    throw errorBlock("native_agent_toml_invalid", {
      agent: agentName,
      field: "name",
      expected: agentName,
      actual: parsed.name,
    });
  }
  if (parsed.description !== agent.description) {
    throw errorBlock("native_agent_toml_invalid", {
      agent: agentName,
      field: "description",
      expected: agent.description,
      actual: parsed.description,
    });
  }
  if (parsed.model_reasoning_effort !== agent.reasoningEffort) {
    throw errorBlock("native_agent_toml_invalid", {
      agent: agentName,
      field: "model_reasoning_effort",
      expected: agent.reasoningEffort,
      actual: parsed.model_reasoning_effort,
    });
  }

  const instructions = parsed.developer_instructions;
  if (typeof instructions !== "string" || instructions.trim() === "") {
    throw errorBlock("native_agent_toml_invalid", {
      agent: agentName,
      field: "developer_instructions",
      message: "developer instructions must be non-empty",
    });
  }

  for (const expected of [
    `- role: ${agentName}`,
    `- posture: ${agent.posture}`,
    `- model_class: ${agent.modelClass}`,
    `- routing_role: ${agent.routingRole}`,
  ]) {
    if (!instructions.includes(expected)) {
      throw errorBlock("native_agent_toml_invalid", {
        agent: agentName,
        field: "developer_instructions",
        missing: expected,
      });
    }
  }
}

export async function verifyNativeAgents(
  options: VerifyNativeAgentsOptions = {},
): Promise<VerifyNativeAgentsResult> {
  const root = resolve(options.root ?? process.cwd());
  const manifest = options.manifest ?? readCatalogManifest(root);
  const definitions = options.definitions ?? AGENT_DEFINITIONS;
  const promptNames = options.promptNames ?? (await readPromptNames(root));
  const catalogByName = getCatalogAgentByName(manifest);
  const installableAgentNames = [...getInstallableNativeAgentNames(manifest)].sort();

  assertNativeAgentCanonicalTargets(manifest);

  for (const agent of manifest.agents) {
    if (!isNativeAgentInstallableStatus(agent.status)) continue;
    if (!definitions[agent.name]) {
      throw errorBlock("native_agent_definition_missing", {
        agent: agent.name,
        status: agent.status,
      });
    }
    if (!promptNames.has(agent.name)) {
      throw errorBlock("native_agent_prompt_missing", {
        agent: agent.name,
        status: agent.status,
        path: `prompts/${agent.name}.md`,
      });
    }
  }

  for (const name of Object.keys(definitions).sort()) {
    if (!catalogByName.has(name)) {
      throw errorBlock("native_agent_catalog_out_of_sync", {
        agent: name,
        message: "agent definition must be listed in catalog agents",
      });
    }
  }

  for (const name of [...promptNames].sort()) {
    if (catalogByName.has(name)) continue;
    if (NON_NATIVE_AGENT_PROMPT_ASSETS.has(name)) continue;
    throw errorBlock("native_agent_prompt_unclassified", {
      prompt: name,
      path: `prompts/${name}.md`,
      message:
        "prompt files must be cataloged native agents or explicit non-native prompt assets",
    });
  }

  for (const name of installableAgentNames) {
    const agent = definitions[name];
    if (!agent) continue;
    const promptPath = join(root, "prompts", `${name}.md`);
    const promptContent = options.promptNames
      ? `${name} prompt fixture`
      : await readFile(promptPath, "utf-8");
    const toml = generateAgentToml(agent, promptContent, {
      codexHomeOverride: join(root, ".omx", "verify-native-agents-codex-home"),
    });
    assertTomlStructure(name, agent, toml);
  }

  const pluginManifest =
    options.pluginManifest === undefined
      ? await readPluginManifest(root)
      : options.pluginManifest;
  if (pluginManifest) {
    for (const field of ["agents", "prompts", "hooks"]) {
      if (pluginManifest[field] !== undefined) {
        throw errorBlock("native_agent_plugin_boundary_violation", {
          field,
          message: "native agents/prompts/hooks are setup-owned, not plugin-scoped",
        });
      }
    }
  }

  return {
    installableAgentNames,
    promptAssetNames: [...promptNames].sort(),
  };
}

function parseArgs(argv: string[]): { root: string } {
  let root = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) throw new Error("missing --root value");
      root = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { root };
}

async function main(): Promise<void> {
  const { root } = parseArgs(process.argv.slice(2));
  const result = await verifyNativeAgents({ root });
  console.log(
    `verified ${result.installableAgentNames.length} installable native agents and ${result.promptAssetNames.length} setup prompt assets`,
  );
}

if (process.argv[1]?.endsWith("verify-native-agents.js")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
