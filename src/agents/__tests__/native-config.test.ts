import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AGENT_DEFINITIONS } from "../definitions.js";
import type { AgentDefinition } from "../definitions.js";
import type { CatalogManifest } from "../../catalog/schema.js";
import {
  composeRoleInstructionsForRole,
  generateAgentToml,
  installNativeAgentConfigs,
} from "../native-config.js";

function manifestWithAgents(names: string[]): CatalogManifest {
  return {
    schemaVersion: 1,
    catalogVersion: "test",
    skills: [
      { name: "ralplan", category: "planning", status: "active", core: true },
      { name: "team", category: "execution", status: "active", core: true },
      { name: "ralph", category: "execution", status: "active", core: true },
      { name: "ultrawork", category: "execution", status: "active", core: true },
      { name: "autopilot", category: "execution", status: "active", core: true },
    ],
    agents: names.map((name) => ({ name, category: "build", status: "active" })),
  };
}

const originalCodexHome = process.env.CODEX_HOME;
const originalFrontierModel = process.env.OMX_DEFAULT_FRONTIER_MODEL;
const originalStandardModel = process.env.OMX_DEFAULT_STANDARD_MODEL;
const originalSparkModel = process.env.OMX_DEFAULT_SPARK_MODEL;
const originalLegacySparkModel = process.env.OMX_SPARK_MODEL;
const isolatedCodexHome = join(
  tmpdir(),
  `omx-native-config-empty-codex-home-${process.pid}`,
);

beforeEach(() => {
  process.env.CODEX_HOME = isolatedCodexHome;
  delete process.env.OMX_DEFAULT_FRONTIER_MODEL;
  process.env.OMX_DEFAULT_STANDARD_MODEL = "gpt-5.6-terra";
  delete process.env.OMX_DEFAULT_SPARK_MODEL;
  delete process.env.OMX_SPARK_MODEL;
});

afterEach(() => {
  if (typeof originalCodexHome === "string") {
    process.env.CODEX_HOME = originalCodexHome;
  } else {
    delete process.env.CODEX_HOME;
  }
  if (typeof originalFrontierModel === "string") {
    process.env.OMX_DEFAULT_FRONTIER_MODEL = originalFrontierModel;
  } else {
    delete process.env.OMX_DEFAULT_FRONTIER_MODEL;
  }
  if (typeof originalStandardModel === "string") {
    process.env.OMX_DEFAULT_STANDARD_MODEL = originalStandardModel;
  } else {
    delete process.env.OMX_DEFAULT_STANDARD_MODEL;
  }
  if (typeof originalSparkModel === "string") {
    process.env.OMX_DEFAULT_SPARK_MODEL = originalSparkModel;
  } else {
    delete process.env.OMX_DEFAULT_SPARK_MODEL;
  }
  if (typeof originalLegacySparkModel === "string") {
    process.env.OMX_SPARK_MODEL = originalLegacySparkModel;
  } else {
    delete process.env.OMX_SPARK_MODEL;
  }
});

describe("agents/native-config", () => {
  it("generates TOML with stripped frontmatter and escaped triple quotes", () => {
    const agent: AgentDefinition = {
      name: "executor",
      description: "Code implementation",
      reasoningEffort: "medium",
      posture: "deep-worker",
      modelClass: "standard",
      routingRole: "executor",
      tools: "execution",
      category: "build",
    };

    const prompt = `---\ntitle: demo\n---\n\nInstruction line\n\"\"\"danger\"\"\"`;
    const toml = generateAgentToml(agent, prompt);

    assert.match(toml, /# oh-my-codex agent: executor/);
    assert.match(toml, /model = "gpt-5\.6-sol"/);
    assert.match(toml, /model_reasoning_effort = "medium"/);
    assert.ok(!toml.includes("title: demo"));
    assert.ok(toml.includes("Instruction line"));
    assert.ok(toml.includes("You are operating in the deep-worker posture."));
    assert.ok(toml.includes("- posture: deep-worker"));

    const tripleQuoteBlocks = toml.match(/"""/g) || [];
    assert.equal(
      tripleQuoteBlocks.length,
      2,
      "only TOML delimiters should remain as raw triple quotes",
    );
  });

  it("applies per-agent reasoning overrides when generating native TOML", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "omx-native-config-reasoning-"));
    try {
      await writeFile(join(codexHome, ".omx-config.json"), JSON.stringify({
        agentReasoning: {
          architect: "xhigh",
        },
      }));
      const agent: AgentDefinition = {
        name: "architect",
        description: "System design",
        reasoningEffort: "high",
        posture: "frontier-orchestrator",
        modelClass: "frontier",
        routingRole: "leader",
        tools: "read-only",
        category: "build",
      };

      const toml = generateAgentToml(agent, "Architect prompt", { codexHomeOverride: codexHome });

      assert.match(toml, /model_reasoning_effort = "xhigh"/);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("lets agentModels override exact pins without stale exact-mini guidance", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "omx-native-config-agent-models-"));
    try {
      await writeFile(join(codexHome, ".omx-config.json"), JSON.stringify({
        agentModels: {
          architect: "gpt-5.6-sol",
        },
        agentReasoning: {
          architect: "xhigh",
        },
      }));

      const toml = generateAgentToml(AGENT_DEFINITIONS.architect, "Architect prompt", {
        codexHomeOverride: codexHome,
      });

      assert.match(toml, /model = "gpt-5\.6-sol"/);
      assert.match(toml, /model_reasoning_effort = "xhigh"/);
      assert.match(toml, /resolved_model: gpt-5\.6-sol/);
      assert.doesNotMatch(toml, /model = "gpt-5\.6-terra"/);
      assert.doesNotMatch(toml, /exact gpt-5\.6-terra model/);
      assert.doesNotMatch(toml, /resolved_model: gpt-5\.6-terra/);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("applies Terra guidance when agentModels resolves exact-Sol roles to gpt-5.6-terra", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "omx-native-config-terra-override-"));
    try {
      await writeFile(join(codexHome, ".omx-config.json"), JSON.stringify({
        agentModels: {
          planner: "gpt-5.6-terra",
          architect: "gpt-5.6-terra",
        },
      }));

      for (const role of ["planner", "architect"] as const) {
        const toml = generateAgentToml(AGENT_DEFINITIONS[role], `${role} prompt`, {
          codexHomeOverride: codexHome,
        });
        assert.match(toml, /model = "gpt-5\.6-terra"/);
        assert.match(toml, /exact gpt-5\.6-terra model/);
      }

      await writeFile(join(codexHome, ".omx-config.json"), JSON.stringify({
        agentModels: { planner: "gpt-5.6-terra-tuned" },
      }));
      const tunedToml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt", {
        codexHomeOverride: codexHome,
      });
      assert.match(tunedToml, /model = "gpt-5\.6-terra-tuned"/);
      assert.doesNotMatch(tunedToml, /exact gpt-5\.6-terra model/);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });


  it("pins planner and architect to exact gpt-5.6-sol while keeping researcher on exact Terra", () => {
    process.env.OMX_DEFAULT_FRONTIER_MODEL = "gpt-5.6-sol";
    process.env.OMX_DEFAULT_STANDARD_MODEL = "gpt-5.6-sol";

    for (const role of ["planner", "architect"] as const) {
      const toml = generateAgentToml(AGENT_DEFINITIONS[role], `${role} prompt`);
      assert.match(toml, /model = "gpt-5\.6-sol"/, `${role} should use exact gpt-5.6-sol`);
      assert.match(toml, /exact gpt-5\.6-sol model/, `${role} should receive exact-gpt-5.6-sol guidance`);
      assert.match(toml, /strict execution order: inspect -> plan -> act -> verify/, `${role} should receive the exact-model guardrail`);
      assert.match(toml, /resolved_model: gpt-5\.6-sol/, `${role} should record exact gpt-5.6-sol metadata`);
    }

    const plannerToml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt");
    assert.match(plannerToml, /model_reasoning_effort = "medium"/);

    const architectToml = generateAgentToml(AGENT_DEFINITIONS.architect, "architect prompt");
    assert.match(architectToml, /model_reasoning_effort = "xhigh"/);

    const researcherToml = generateAgentToml(AGENT_DEFINITIONS.researcher, "researcher prompt");
    assert.match(researcherToml, /model = "gpt-5\.6-terra"/, "researcher should keep exact Terra");
    assert.match(researcherToml, /exact gpt-5\.6-terra model/, "researcher should receive exact-Terra guidance");
    assert.match(researcherToml, /resolved_model: gpt-5.6-terra/, "researcher should record exact Terra metadata");
    assert.match(researcherToml, /model_reasoning_effort = "high"/);

    for (const role of [
      "critic",
      "debugger",
      "scholastic",
      "prometheus-strict-metis",
      "prometheus-strict-momus",
      "prometheus-strict-oracle",
    ] as const) {
      const toml = generateAgentToml(AGENT_DEFINITIONS[role], `${role} prompt`);
      assert.match(toml, /model = "gpt-5\.6-sol"/, `${role} should stay on configured/root gpt-5.6-sol`);
      assert.doesNotMatch(toml, /model = "gpt-5\.6-terra"/, `${role} must not inherit exact-Terra pins`);
    }
  });

  it("applies exact-model Terra guidance only for resolved gpt-5.6-terra standard roles", () => {
    const agent: AgentDefinition = {
      name: "debugger",
      description: "Root-cause analysis",
      reasoningEffort: "medium",
      posture: "deep-worker",
      modelClass: "standard",
      routingRole: "executor",
      tools: "analysis",
      category: "build",
    };

    const prompt = "Instruction line";
    const exactMiniToml = generateAgentToml(agent, prompt, {
      env: { OMX_DEFAULT_STANDARD_MODEL: "gpt-5.6-terra" } as NodeJS.ProcessEnv,
    });
    const frontierToml = generateAgentToml(agent, prompt, {
      env: { OMX_DEFAULT_STANDARD_MODEL: "gpt-5.6-sol" } as NodeJS.ProcessEnv,
    });
    const tunedToml = generateAgentToml(agent, prompt, {
      env: { OMX_DEFAULT_STANDARD_MODEL: "gpt-5.6-terra-tuned" } as NodeJS.ProcessEnv,
    });

    assert.match(exactMiniToml, /exact gpt-5\.6-terra model/);
    assert.match(exactMiniToml, /strict execution order: inspect -> plan -> act -> verify/);
    assert.match(exactMiniToml, /resolved_model: gpt-5\.6-terra/);
    assert.doesNotMatch(frontierToml, /exact gpt-5\.6-terra model/);
    assert.doesNotMatch(tunedToml, /exact gpt-5\.6-terra model/);
  });

  it("adds a leaf guard after delegation guidance in generated native agent instructions", () => {
    const codeReviewerToml = generateAgentToml(
      AGENT_DEFINITIONS["code-reviewer"],
      "code-reviewer prompt",
    );

    assert.match(codeReviewerToml, /<native_subagent_leaf_guard>/);
    assert.match(codeReviewerToml, /do not call Task, spawn_agent, or native child agents/);
    assert.match(codeReviewerToml, /report missing specialist coverage to the leader/);

    const postureDelegationIndex = codeReviewerToml.indexOf(
      "Default to delegation and orchestration when specialists exist.",
    );
    const modelDelegationIndex = codeReviewerToml.indexOf("precise delegation.");
    const guardIndex = codeReviewerToml.indexOf("<native_subagent_leaf_guard>");
    const metadataIndex = codeReviewerToml.indexOf("## OMX Agent Metadata");

    assert.ok(postureDelegationIndex >= 0, "frontier posture delegation text should exist");
    assert.ok(modelDelegationIndex >= 0, "frontier model delegation text should exist");
    assert.ok(guardIndex > postureDelegationIndex, "leaf guard should override posture delegation text");
    assert.ok(guardIndex > modelDelegationIndex, "leaf guard should override model delegation text");
    assert.ok(metadataIndex > guardIndex, "metadata should remain final non-policy bookkeeping");

    const researcherToml = generateAgentToml(
      AGENT_DEFINITIONS.researcher,
      "researcher prompt",
    );
    const exactMiniIndex = researcherToml.indexOf(
      "strict execution order: inspect -> plan -> act -> verify",
    );
    const researcherGuardIndex = researcherToml.indexOf("<native_subagent_leaf_guard>");
    const researcherMetadataIndex = researcherToml.indexOf("## OMX Agent Metadata");

    assert.ok(exactMiniIndex >= 0, "researcher should exercise the exact-mini overlay path");
    assert.ok(
      researcherGuardIndex > exactMiniIndex,
      "leaf guard should override exact-mini overlay guidance",
    );
    assert.ok(
      researcherMetadataIndex > researcherGuardIndex,
      "metadata should remain final non-policy bookkeeping for exact-model roles",
    );

    const teamExecutorToml = generateAgentToml(
      AGENT_DEFINITIONS["team-executor"],
      "team-executor prompt",
    );
    assert.match(teamExecutorToml, /<native_subagent_leaf_guard>/);
  });

  it("keeps executor native agents as leaf implementation lanes", () => {
    const executorToml = generateAgentToml(
      AGENT_DEFINITIONS.executor,
      "executor prompt",
    );

    assert.match(executorToml, /<native_subagent_leaf_guard>/);
    assert.doesNotMatch(executorToml, /native_subagent_delegation: allowed/);
  });

  it("does not apply the leaf guard to roles with explicit native delegation contracts", () => {
    const metisToml = generateAgentToml(
      AGENT_DEFINITIONS["prometheus-strict-metis"],
      "metis prompt",
    );

    assert.doesNotMatch(metisToml, /<native_subagent_leaf_guard>/);
    assert.match(metisToml, /native_subagent_delegation: allowed/);
  });

  it("keeps native-only leaf guards out of non-native role composition", () => {
    const writerInstructions = composeRoleInstructionsForRole(
      "writer",
      "writer prompt",
      "gpt-5.6-sol",
    );
    const unknownInstructions = composeRoleInstructionsForRole(
      "does-not-exist",
      "plain prompt",
      "gpt-5.6-sol",
    );

    assert.doesNotMatch(writerInstructions, /<native_subagent_leaf_guard>/);
    assert.doesNotMatch(writerInstructions, /native_subagent_delegation: allowed/);
    assert.doesNotMatch(unknownInstructions, /<native_subagent_leaf_guard>/);
  });

  it("installs only catalog-installable agents and skips existing files without force", async () => {
    const root = await mkdtemp(join(tmpdir(), "omx-native-config-"));
    const promptsDir = join(root, "prompts");
    const outDir = join(root, "agents-out");

    try {
      await mkdir(promptsDir, { recursive: true });
      await writeFile(join(promptsDir, "executor.md"), "executor prompt");
      await writeFile(join(promptsDir, "planner.md"), "planner prompt");
      await writeFile(join(promptsDir, "style-reviewer.md"), "merged prompt");

      const created = await installNativeAgentConfigs(root, {
        agentsDir: outDir,
        catalogManifest: manifestWithAgents(["executor", "planner"]),
      });
      assert.equal(created, 2);
      assert.equal(existsSync(join(outDir, "executor.toml")), true);
      assert.equal(existsSync(join(outDir, "planner.toml")), true);
      assert.equal(existsSync(join(outDir, "style-reviewer.toml")), false);

      const executorToml = await readFile(
        join(outDir, "executor.toml"),
        "utf8",
      );
      assert.match(executorToml, /model = "gpt-5\.6-sol"/);
      assert.match(executorToml, /model_reasoning_effort = "medium"/);

      const skipped = await installNativeAgentConfigs(root, {
        agentsDir: outDir,
        catalogManifest: manifestWithAgents(["executor", "planner"]),
      });
      assert.equal(skipped, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("installs native agent TOML with configured per-agent reasoning overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "omx-native-config-install-reasoning-"));
    const codexHome = join(root, ".codex");
    const promptsDir = join(root, "prompts");
    const outDir = join(codexHome, "agents");

    try {
      await mkdir(promptsDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, ".omx-config.json"), JSON.stringify({
        agentReasoning: {
          architect: "xhigh",
        },
      }));
      await writeFile(join(promptsDir, "architect.md"), "architect prompt");

      await installNativeAgentConfigs(root, {
        agentsDir: outDir,
        catalogManifest: manifestWithAgents(["architect"]),
      });

      const architectToml = await readFile(join(outDir, "architect.toml"), "utf8");
      assert.match(architectToml, /model_reasoning_effort = "xhigh"/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves active provider on native agents so websocket-capable Responses providers are inherited", async () => {
    const root = await mkdtemp(join(tmpdir(), "omx-native-config-provider-"));
    const codexHome = join(root, ".codex");
    const promptsDir = join(root, "prompts");
    const outDir = join(codexHome, "agents");
    const previousCodexHome = process.env.CODEX_HOME;

    try {
      delete process.env.OMX_DEFAULT_STANDARD_MODEL;
      process.env.CODEX_HOME = codexHome;
      await mkdir(promptsDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "config.toml"), [
        'model = "gpt-5.6-sol"',
        'model_provider = "cheapRouter"',
        '',
        '[model_providers.cheapRouter]',
        'name = "Cheap Router"',
        'base_url = "https://cheaprouter.uk/v1"',
        'wire_api = "responses"',
        'supports_websockets = true',
        '',
      ].join('\n'));
      await writeFile(join(promptsDir, "executor.md"), "executor prompt");

      await installNativeAgentConfigs(root, {
        agentsDir: outDir,
        catalogManifest: manifestWithAgents(["executor"]),
      });
      const executorToml = await readFile(join(outDir, "executor.toml"), "utf8");
      assert.match(executorToml, /model = "gpt-5\.6-sol"/);
      assert.match(executorToml, /model_provider = "cheapRouter"/);
    } finally {
      if (typeof previousCodexHome === "string") process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      process.env.OMX_DEFAULT_STANDARD_MODEL = "gpt-5.6-terra";
      await rm(root, { recursive: true, force: true });
    }
  });

  it("omits inherited custom provider for default Spark-lane native agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "omx-native-config-spark-provider-"));
    const codexHome = join(root, ".codex");
    const promptsDir = join(root, "prompts");
    const outDir = join(codexHome, "agents");
    const previousCodexHome = process.env.CODEX_HOME;

    try {
      process.env.CODEX_HOME = codexHome;
      await mkdir(promptsDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, ".omx-config.json"), JSON.stringify({
        env: {
          OMX_DEFAULT_SPARK_MODEL: "gpt-5.6-luna",
        },
      }));
      await writeFile(join(codexHome, "config.toml"), [
        'model = "gpt-5.6-sol"',
        'model_provider = "OpenAI"',
        '',
      ].join('\n'));
      await writeFile(join(promptsDir, "explore.md"), "explore prompt");

      await installNativeAgentConfigs(root, {
        agentsDir: outDir,
        catalogManifest: manifestWithAgents(["explore"]),
      });
      const exploreToml = await readFile(join(outDir, "explore.toml"), "utf8");
      assert.match(exploreToml, /model = "gpt-5\.6-luna"/);
      assert.doesNotMatch(exploreToml, /model_provider = /);
    } finally {
      if (typeof previousCodexHome === "string") process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("inherits a custom root model for standard agents when no standard override exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "omx-native-config-root-model-"));
    const codexHome = join(root, ".codex");
    const promptsDir = join(root, "prompts");
    const outDir = join(codexHome, "agents");
    const previousCodexHome = process.env.CODEX_HOME;

    try {
      delete process.env.OMX_DEFAULT_STANDARD_MODEL;
      process.env.CODEX_HOME = codexHome;
      await mkdir(promptsDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "config.toml"), 'model = "gpt-5.2"\n');
      await writeFile(join(promptsDir, "debugger.md"), "debugger prompt");

      await installNativeAgentConfigs(root, {
        agentsDir: outDir,
        catalogManifest: manifestWithAgents(["debugger"]),
      });
      const debuggerToml = await readFile(join(outDir, "debugger.toml"), "utf8");
      assert.match(debuggerToml, /model = "gpt-5\.2"/);
      assert.doesNotMatch(debuggerToml, /model = "gpt-5\.6-terra"/);
    } finally {
      if (typeof previousCodexHome === "string") process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      process.env.OMX_DEFAULT_STANDARD_MODEL = "gpt-5.6-terra";
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves explicit standard model override for standard agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "omx-native-config-standard-override-"));
    const codexHome = join(root, ".codex");
    const promptsDir = join(root, "prompts");
    const outDir = join(codexHome, "agents");
    const previousCodexHome = process.env.CODEX_HOME;

    try {
      process.env.OMX_DEFAULT_STANDARD_MODEL = "gpt-5.6-terra";
      process.env.CODEX_HOME = codexHome;
      await mkdir(promptsDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "config.toml"), 'model = "gpt-5.2"\n');
      await writeFile(join(promptsDir, "debugger.md"), "debugger prompt");

      await installNativeAgentConfigs(root, {
        agentsDir: outDir,
        catalogManifest: manifestWithAgents(["debugger"]),
      });
      const debuggerToml = await readFile(join(outDir, "debugger.toml"), "utf8");
      assert.match(debuggerToml, /model = "gpt-5\.6-terra"/);
      assert.doesNotMatch(debuggerToml, /model = "gpt-5\.2"/);
    } finally {
      if (typeof previousCodexHome === "string") process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      process.env.OMX_DEFAULT_STANDARD_MODEL = "gpt-5.6-terra";
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps executor on the frontier lane so an explicit gpt-5.2 root model still applies there", async () => {
    const root = await mkdtemp(join(tmpdir(), "omx-native-config-executor-model-"));
    const codexHome = join(root, ".codex");
    const promptsDir = join(root, "prompts");
    const outDir = join(codexHome, "agents");
    const previousCodexHome = process.env.CODEX_HOME;

    try {
      delete process.env.OMX_DEFAULT_STANDARD_MODEL;
      process.env.CODEX_HOME = codexHome;
      await mkdir(promptsDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "config.toml"), 'model = "gpt-5.2"\n');
      await writeFile(join(promptsDir, "executor.md"), "executor prompt");

      await installNativeAgentConfigs(root, {
        agentsDir: outDir,
        catalogManifest: manifestWithAgents(["executor"]),
      });
      const executorToml = await readFile(join(outDir, "executor.toml"), "utf8");
      assert.match(executorToml, /model = "gpt-5\.2"/);
    } finally {
      if (typeof previousCodexHome === "string") process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      process.env.OMX_DEFAULT_STANDARD_MODEL = "gpt-5.6-terra";
      await rm(root, { recursive: true, force: true });
    }
  });
});
