import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseToml } from "@iarna/toml";
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
  it("defaults every role to Astra with its existing reasoning effort", () => {
    delete process.env.OMX_DEFAULT_STANDARD_MODEL;
    const expectedEfforts = {
      "executor": "medium",
      "team-executor": "medium",
      "explore": "low",
      "analyst": "medium",
      "planner": "medium",
      "architect": "xhigh",
      "debugger": "high",
      "verifier": "high",
      "style-reviewer": "low",
      "quality-reviewer": "medium",
      "api-reviewer": "medium",
      "security-reviewer": "medium",
      "performance-reviewer": "medium",
      "code-reviewer": "high",
      "dependency-expert": "high",
      "test-engineer": "medium",
      "quality-strategist": "medium",
      "build-fixer": "high",
      "designer": "high",
      "writer": "high",
      "qa-tester": "low",
      "git-master": "high",
      "code-simplifier": "high",
      "researcher": "high",
      "product-manager": "medium",
      "ux-researcher": "medium",
      "information-architect": "low",
      "product-analyst": "low",
      "critic": "high",
      "vision": "low",
    };
    assert.deepEqual(Object.keys(AGENT_DEFINITIONS).sort(), Object.keys(expectedEfforts).sort());
    for (const [role, effort] of Object.entries(expectedEfforts)) {
      const toml = generateAgentToml(AGENT_DEFINITIONS[role], `${role} prompt`);
      // Agents without explicit overrides inherit default model at runtime; resolved_model documented
      // Only agents with exactModel write model field
      const parsedToml = parseToml(toml);
      if (AGENT_DEFINITIONS[role].exactModel) {
        assert.equal(parsedToml.model, "gpt-6-astra", `${role} with exactModel should write model`);
      } else {
        assert.equal(parsedToml.model, undefined, `${role} without exactModel should not write model field`);
        assert.match(toml, /resolved_model: gpt-6-astra/, `${role} should document resolved model`);
      }
      assert.equal(parsedToml.model_reasoning_effort, effort, role);
      assert.doesNotMatch(String(toml), /exact gpt-5\.6-terra model/, role);
    }
  });

  it("generates GPT-6 Sol and Luna role overrides without changing role efforts", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "omx-native-config-gpt6-"));
    try {
      const agentModels = { planner: "gpt-6-sol", executor: "gpt-6-sol", explore: "gpt-6-luna" };
      await writeFile(join(codexHome, ".omx-config.json"), JSON.stringify({ agentModels }));
      for (const [role, model] of Object.entries(agentModels)) {
        const toml = parseToml(generateAgentToml(AGENT_DEFINITIONS[role], `${role} prompt`, { codexHomeOverride: codexHome }));
        assert.equal(toml.model, model, role);
        assert.equal(toml.model_reasoning_effort, AGENT_DEFINITIONS[role].reasoningEffort, role);
        assert.doesNotMatch(String(toml.developer_instructions), /exact gpt-6-astra model/, role);
      }
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("preserves older per-role model choices across every model class", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "omx-native-config-legacy-models-"));
    try {
      const agentModels = { planner: "gpt-5.6-sol", researcher: "gpt-5.6-terra", explore: "gpt-5.6-luna" };
      await writeFile(join(codexHome, ".omx-config.json"), JSON.stringify({ agentModels }));
      for (const [role, model] of Object.entries(agentModels)) {
        const toml = parseToml(generateAgentToml(AGENT_DEFINITIONS[role], `${role} prompt`, { codexHomeOverride: codexHome }));
        assert.equal(toml.model, model, role);
        assert.equal(toml.model_reasoning_effort, AGENT_DEFINITIONS[role].reasoningEffort, role);
      }
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

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
    // After fix for #3779: model field not written for agents without explicit overrides
    // The model is resolved from config defaults and documented in resolved_model metadata
    assert.doesNotMatch(toml, /^model = /m);
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

  it("transports normalized per-agent max through exact native TOML and falls back from ultra", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "omx-native-config-max-reasoning-"));
    try {
      await writeFile(join(codexHome, ".omx-config.json"), JSON.stringify({
        agentReasoning: {
          architect: " MAX ",
          critic: "ultra",
        },
      }));

      const maxToml = generateAgentToml(AGENT_DEFINITIONS.architect, "Architect prompt", {
        codexHomeOverride: codexHome,
      });
      assert.match(maxToml, /model_reasoning_effort = "max"/);
      assert.equal(
        (parseToml(maxToml) as { model_reasoning_effort?: unknown }).model_reasoning_effort,
        "max",
      );

      const fallbackToml = generateAgentToml(AGENT_DEFINITIONS.critic, "Critic prompt", {
        codexHomeOverride: codexHome,
      });
      assert.match(fallbackToml, /model_reasoning_effort = "high"/);
      assert.doesNotMatch(fallbackToml, /model_reasoning_effort = "ultra"/);
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

  it("applies Terra guidance when agentModels resolves exact-Astra roles to gpt-5.6-terra", async () => {
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


  it("pins planner, architect, and researcher to Astra while retaining effort defaults", () => {
    process.env.OMX_DEFAULT_FRONTIER_MODEL = "gpt-5.6-sol";
    process.env.OMX_DEFAULT_STANDARD_MODEL = "gpt-5.6-sol";

    for (const role of ["planner", "architect", "researcher"] as const) {
      const toml = generateAgentToml(AGENT_DEFINITIONS[role], `${role} prompt`);
      assert.match(toml, /model = "gpt-6-astra"/, `${role} should use exact gpt-6-astra`);
      assert.match(toml, /exact gpt-6-astra model/, `${role} should receive exact-gpt-6-astra guidance`);
      assert.match(toml, /strict execution order: inspect -> plan -> act -> verify/, `${role} should receive the exact-model guardrail`);
      assert.match(toml, /resolved_model: gpt-6-astra/, `${role} should record exact gpt-6-astra metadata`);
    }

    const plannerToml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt");
    assert.match(plannerToml, /model_reasoning_effort = "medium"/);

    const architectToml = generateAgentToml(AGENT_DEFINITIONS.architect, "architect prompt");
    assert.match(architectToml, /model_reasoning_effort = "xhigh"/);

    const researcherToml = generateAgentToml(AGENT_DEFINITIONS.researcher, "researcher prompt");
    assert.match(researcherToml, /model = "gpt-6-astra"/, "researcher should keep exact Astra");
    assert.match(researcherToml, /exact gpt-6-astra model/, "researcher should receive exact-Astra guidance");
    assert.match(researcherToml, /resolved_model: gpt-6-astra/, "researcher should record exact Astra metadata");
    assert.match(researcherToml, /model_reasoning_effort = "high"/);

    for (const role of [
      "critic",
      "debugger",
    ] as const) {
      const toml = generateAgentToml(AGENT_DEFINITIONS[role], `${role} prompt`);
      // No exactModel, so model not written; resolved_model documented
      assert.match(toml, /resolved_model: gpt-5\.6-sol/, `${role} should resolve to configured/default gpt-5.6-sol`);
      assert.doesNotMatch(toml, /resolved_model: gpt-5\.6-terra/, `${role} must not inherit exact-Terra pins`);
    }
  });

  it("does not bake exactModel for planner/architect/researcher when custom provider is configured (fixes #3823)", async () => {
    const codexHome = join(tmpdir(), `omx-custom-provider-test-${process.pid}`);
    try {
      // Create a config.toml with a custom provider
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "config.toml"), [
        'model = "glm-5.3-flash"',
        'model_provider = "custom-provider"',
      ].join("\n"));

      // With custom provider, planner should NOT bake gpt-6-astra, should inherit from config
      const plannerToml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt", {
        codexHomeOverride: codexHome,
      });
      assert.doesNotMatch(plannerToml, /^model\s*=/m, "planner should not bake model field with custom provider");
      // When model is not baked, agents inherit from config.toml at runtime
      assert.doesNotMatch(plannerToml, /exact gpt-6-astra model/, "planner should not receive exactModel guidance with custom provider");

      // With custom provider, architect should NOT bake gpt-6-astra, should inherit from config
      const architectToml = generateAgentToml(AGENT_DEFINITIONS.architect, "architect prompt", {
        codexHomeOverride: codexHome,
      });
      assert.doesNotMatch(architectToml, /^model\s*=/m, "architect should not bake model field with custom provider");
      assert.doesNotMatch(architectToml, /exact gpt-6-astra model/, "architect should not receive exactModel guidance with custom provider");

      // With custom provider, researcher should NOT bake gpt-6-astra, should inherit from config
      const researcherToml = generateAgentToml(AGENT_DEFINITIONS.researcher, "researcher prompt", {
        codexHomeOverride: codexHome,
      });
      assert.doesNotMatch(researcherToml, /^model\s*=/m, "researcher should not bake model field with custom provider");
      assert.doesNotMatch(researcherToml, /exact gpt-6-astra model/, "researcher should not receive exactModel guidance with custom provider");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
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

  it("keeps generated overlays within read-only and advisory assignments", () => {
    for (const role of ["architect", "planner", "researcher", "debugger"] as const) {
      const toml = generateAgentToml(AGENT_DEFINITIONS[role], "Return a read-only analysis.");
      const instructions = parseToml(toml).developer_instructions as string;

      assert.match(instructions, /Return a read-only analysis\./);
      assert.doesNotMatch(instructions, /requested work is implemented/);
      assert.doesNotMatch(instructions, /diagnostics, tests, and build evidence are mandatory/);
      assert.doesNotMatch(instructions, /Default to delegation and orchestration when specialists exist/);
      assert.match(instructions, /assigned (?:result|scope)/);
    }
  });

  it("adds a leaf guard after scope-aware posture guidance in generated native agent instructions", () => {
    const codeReviewerToml = generateAgentToml(
      AGENT_DEFINITIONS["code-reviewer"],
      "code-reviewer prompt",
    );

    assert.match(codeReviewerToml, /<native_subagent_leaf_guard>/);
    assert.match(codeReviewerToml, /do not call Task, spawn_agent, or native child agents/);
    assert.match(codeReviewerToml, /report missing specialist coverage to the leader/);

    const postureScopeIndex = codeReviewerToml.indexOf(
      "Specialist coverage must stay within the assigned role and delegation authority.",
    );
    const modelScopeIndex = codeReviewerToml.indexOf("assigned scope, tradeoff reasoning, and precise handoffs.");
    const guardIndex = codeReviewerToml.indexOf("<native_subagent_leaf_guard>");
    const metadataIndex = codeReviewerToml.indexOf("## OMX Agent Metadata");

    assert.ok(postureScopeIndex >= 0, "frontier posture should preserve assigned scope");
    assert.ok(modelScopeIndex >= 0, "frontier model guidance should preserve assigned scope");
    assert.ok(guardIndex > postureScopeIndex, "leaf guard should follow posture guidance");
    assert.ok(guardIndex > modelScopeIndex, "leaf guard should follow model guidance");
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

  it("applies the leaf guard to standard roles after sunset of delegation roles", () => {
    const researcherToml = generateAgentToml(
      AGENT_DEFINITIONS.researcher,
      "researcher prompt",
    );

    assert.match(researcherToml, /<native_subagent_leaf_guard>/);
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
      // Model resolved but not written without explicit override; resolved_model documented
      assert.match(executorToml, /resolved_model: gpt-6-astra/);
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
      // Model is resolved from root config, but without explicit per-agent override, isn't written to TOML
      assert.match(executorToml, /resolved_model: gpt-5\.6-sol/);
      // After #3779 fix: model_provider is NOT written to agent TOML when it's just inherited from config
      // Agents inherit it from config.toml at runtime, preventing staleness when provider changes
      assert.doesNotMatch(executorToml, /model_provider = "cheapRouter"/, "model_provider should not be baked in when inherited from config");
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
      // Use lowercase "openai" (built-in) instead of "OpenAI" (custom) to match expected behavior
      await writeFile(join(codexHome, "config.toml"), [
        'model = "gpt-5.6-sol"',
        'model_provider = "openai"',  // Built-in provider
        '',
      ].join('\n'));
      await writeFile(join(promptsDir, "explore.md"), "explore prompt");

      await installNativeAgentConfigs(root, {
        agentsDir: outDir,
        catalogManifest: manifestWithAgents(["explore"]),
      });
      const exploreToml = await readFile(join(outDir, "explore.toml"), "utf8");
      // Model resolved from env default for Spark-lane agents (gpt-5.6-luna), not from root config
      assert.match(exploreToml, /resolved_model: gpt-5\.6-luna/);
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
      // Model resolved from root config but not written without explicit override
      assert.match(debuggerToml, /resolved_model: gpt-5\.2/);
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
      // Model resolved from env default not written without explicit override
      assert.match(debuggerToml, /resolved_model: gpt-5\.6-terra/);
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
      // Model resolved from root config but not written without explicit override  
      assert.match(executorToml, /resolved_model: gpt-5\.2/);
    } finally {
      if (typeof previousCodexHome === "string") process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      process.env.OMX_DEFAULT_STANDARD_MODEL = "gpt-5.6-terra";
      await rm(root, { recursive: true, force: true });
    }
  });

  it("agent TOMLs do not include model_provider fields that merely mirror config defaults (reproduces #3779)", async () => {
    const root = await mkdtemp(join(tmpdir(), "omx-issue-3779-stale-provider-"));
    const codexHome = join(root, ".codex");
    const promptsDir = join(root, "prompts");
    const outDir = join(codexHome, "agents");
    const previousCodexHome = process.env.CODEX_HOME;
    const previousStandardModel = process.env.OMX_DEFAULT_STANDARD_MODEL;

    try {
      process.env.CODEX_HOME = codexHome;
      delete process.env.OMX_DEFAULT_STANDARD_MODEL; // Isolate test from env defaults
      await mkdir(promptsDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });

      // Step 1: Setup with provider A
      await writeFile(
        join(codexHome, "config.toml"),
        'model = "gpt-5.6-terra"\nmodel_provider = "provider-a"\n',
      );
      await writeFile(join(promptsDir, "executor.md"), "executor prompt");

      await installNativeAgentConfigs(root, {
        agentsDir: outDir,
        catalogManifest: manifestWithAgents(["executor"]),
      });

      let executorToml = await readFile(join(outDir, "executor.toml"), "utf8");
      // After the fix, model_provider should NOT be written for default inheritance
      assert.doesNotMatch(executorToml, /model_provider\s*=/, "model_provider should not be written for default inheritance");

      // Step 2: Change config to provider B without --force
      await writeFile(
        join(codexHome, "config.toml"),
        'model = "gpt-6-astra"\nmodel_provider = "provider-b"\n',
      );

      // Step 3: Check that the agent TOML is NOT stale
      // Since model_provider was never written (no per-agent override), it won't be stale
      executorToml = await readFile(join(outDir, "executor.toml"), "utf8");
      assert.doesNotMatch(executorToml, /model_provider\s*=/, "model_provider should still not be present - not stale because never written");
    } finally {
      if (typeof previousCodexHome === "string") process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      if (typeof previousStandardModel === "string") process.env.OMX_DEFAULT_STANDARD_MODEL = previousStandardModel;
      else delete process.env.OMX_DEFAULT_STANDARD_MODEL;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not bake exactModel pins for planner/architect/researcher when using custom provider (fixes #3823)", async () => {
    const root = await mkdtemp(join(tmpdir(), "omx-issue-3823-custom-provider-"));
    const codexHome = join(root, ".codex");
    const promptsDir = join(root, "prompts");
    const outDir = join(codexHome, "agents");
    const previousCodexHome = process.env.CODEX_HOME;
    const previousStandardModel = process.env.OMX_DEFAULT_STANDARD_MODEL;

    try {
      delete process.env.OMX_DEFAULT_STANDARD_MODEL; // Isolate test from env defaults
      process.env.CODEX_HOME = codexHome;
      await mkdir(promptsDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });

      // Test 1: With custom provider, exactModel pins should NOT be baked
      await writeFile(
        join(codexHome, "config.toml"),
        [
          'model = "glm-5.3-flash"',
          'model_provider = "custom"',
          '',
          '[model_providers.custom]',
          'name = "Custom Third-Party"',
          'base_url = "https://custom-provider.com/v1"',
          'wire_api = "responses"',
          '',
        ].join("\n"),
      );
      await writeFile(join(promptsDir, "planner.md"), "planner prompt");
      await writeFile(join(promptsDir, "architect.md"), "architect prompt");
      await writeFile(join(promptsDir, "researcher.md"), "researcher prompt");

      await installNativeAgentConfigs(root, {
        agentsDir: outDir,
        catalogManifest: manifestWithAgents(["planner", "architect", "researcher"]),
      });

      // Planner should NOT have model baked, inherits from config.toml
      let plannerToml = await readFile(join(outDir, "planner.toml"), "utf8");
      assert.doesNotMatch(
        plannerToml,
        /^model\s*=/m,
        "planner should not bake model when using custom provider",
      );
      assert.match(
        plannerToml,
        /resolved_model: glm-5\.3-flash/,
        "planner should resolve to custom provider model from config",
      );

      // Architect should NOT have model baked, inherits from config.toml
      let architectToml = await readFile(join(outDir, "architect.toml"), "utf8");
      assert.doesNotMatch(
        architectToml,
        /^model\s*=/m,
        "architect should not bake model when using custom provider",
      );
      assert.match(
        architectToml,
        /resolved_model: glm-5\.3-flash/,
        "architect should resolve to custom provider model from config",
      );

      // Researcher should NOT have model baked, inherits from config.toml
      let researcherToml = await readFile(join(outDir, "researcher.toml"), "utf8");
      assert.doesNotMatch(
        researcherToml,
        /^model\s*=/m,
        "researcher should not bake model when using custom provider",
      );
      assert.match(
        researcherToml,
        /resolved_model: glm-5\.3-flash/,
        "researcher should resolve to custom provider model from config",
      );

      // Test 2: With default provider, exactModel pins SHOULD be baked
      await rm(outDir, { recursive: true, force: true });
      await writeFile(
        join(codexHome, "config.toml"),
        'model = "gpt-5.6-sol"\n', // No model_provider = default OpenAI
      );

      await installNativeAgentConfigs(root, {
        agentsDir: outDir,
        catalogManifest: manifestWithAgents(["planner", "architect", "researcher"]),
      });

      // Planner SHOULD have exactModel baked with default provider
      plannerToml = await readFile(join(outDir, "planner.toml"), "utf8");
      assert.match(
        plannerToml,
        /model = "gpt-6-astra"/,
        "planner should bake exactModel when using default provider",
      );
      assert.match(
        plannerToml,
        /resolved_model: gpt-6-astra/,
        "planner should resolve to gpt-6-astra with default provider",
      );

      // Architect SHOULD have exactModel baked with default provider
      architectToml = await readFile(join(outDir, "architect.toml"), "utf8");
      assert.match(
        architectToml,
        /model = "gpt-6-astra"/,
        "architect should bake exactModel when using default provider",
      );

      // Researcher SHOULD have exactModel baked with default provider
      researcherToml = await readFile(join(outDir, "researcher.toml"), "utf8");
      assert.match(
        researcherToml,
        /model = "gpt-6-astra"/,
        "researcher should bake exactModel when using default provider",
      );
    } finally {
      if (typeof previousCodexHome === "string") process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      if (typeof previousStandardModel === "string") process.env.OMX_DEFAULT_STANDARD_MODEL = previousStandardModel;
      else delete process.env.OMX_DEFAULT_STANDARD_MODEL;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves profile-selected custom provider and skips exactModel pins (P1 fix for #3824)", async () => {
    const codexHome = join(tmpdir(), `omx-profile-provider-test-${process.pid}`);
    try {
      // Create a config.toml with a profile-selected custom provider
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "config.toml"), [
        'profile = "custom-lane"',
        '',
        '[profiles.custom-lane]',
        'model_provider = "profile-custom-provider"',
        'model = "llm-5.0-custom"',
      ].join("\n"));

      // With profile-selected custom provider, planner should NOT bake exactModel
      const plannerToml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt", {
        codexHomeOverride: codexHome,
      });
      assert.doesNotMatch(plannerToml, /^model\s*=/m, "planner should not bake model when custom provider is in active profile");
      assert.doesNotMatch(plannerToml, /exact gpt-6-astra model/, "planner should not receive astra guidance when custom provider is in active profile");

      // With profile-selected custom provider, architect should NOT bake exactModel
      const architectToml = generateAgentToml(AGENT_DEFINITIONS.architect, "architect prompt", {
        codexHomeOverride: codexHome,
      });
      assert.doesNotMatch(architectToml, /^model\s*=/m, "architect should not bake model when custom provider is in active profile");
      assert.doesNotMatch(architectToml, /exact gpt-6-astra model/, "architect should not receive astra guidance when custom provider is in active profile");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("preserves exactModel pins for built-in openai-chatgpt provider (P2.1 fix for #3824)", async () => {
    const codexHome = join(tmpdir(), `omx-builtin-provider-test-${process.pid}`);
    const origCodexHome = process.env.CODEX_HOME;
    try {
      // Create config with built-in openai-chatgpt provider
      // This would normally be set by omx auth add
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "config.toml"), [
        'model = "gpt-6-astra"',
        'model_provider = "openai-chatgpt"',
      ].join("\n"));

      // With built-in openai-chatgpt provider, planner SHOULD bake exactModel
      const plannerToml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt", {
        codexHomeOverride: codexHome,
      });
      assert.match(plannerToml, /model = "gpt-6-astra"/, "planner should bake exactModel with openai-chatgpt provider");
      assert.match(plannerToml, /exact gpt-6-astra model/, "planner should receive astra guidance with openai-chatgpt provider");

      // With built-in openai-chatgpt provider, architect SHOULD bake exactModel
      const architectToml = generateAgentToml(AGENT_DEFINITIONS.architect, "architect prompt", {
        codexHomeOverride: codexHome,
      });
      assert.match(architectToml, /model = "gpt-6-astra"/, "architect should bake exactModel with openai-chatgpt provider");
      assert.match(architectToml, /exact gpt-6-astra model/, "architect should receive astra guidance with openai-chatgpt provider");
    } finally {
      if (typeof origCodexHome === "string") {
        process.env.CODEX_HOME = origCodexHome;
      } else {
        delete process.env.CODEX_HOME;
      }
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("suppresses astra guidance for custom provider without root model (P2.2 fix for #3824)", async () => {
    const codexHome = join(tmpdir(), `omx-custom-no-model-test-${process.pid}`);
    try {
      // Create a config.toml with a custom provider but no root model
      // This is the configuration shape from tmux-session.test.ts:3683-3692
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "config.toml"), [
        'model_provider = "custom_provider"',
        '',
        '[model_providers.custom_provider]',
        'name = "custom_provider"',
        'base_url = "http://localhost:3000/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        'env_key = "CUSTOM_PROVIDER_API_KEY"',
      ].join("\n"));

      // With custom provider and no root model, planner should NOT emit astra guidance
      const plannerToml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt", {
        codexHomeOverride: codexHome,
      });
      assert.doesNotMatch(plannerToml, /^model\s*=/m, "planner should not bake model field with custom provider and no root model");
      assert.doesNotMatch(plannerToml, /exact gpt-6-astra model/, "planner should not emit astra guidance with custom provider and no root model");

      // With custom provider and no root model, architect should NOT emit astra guidance
      const architectToml = generateAgentToml(AGENT_DEFINITIONS.architect, "architect prompt", {
        codexHomeOverride: codexHome,
      });
      assert.doesNotMatch(architectToml, /^model\s*=/m, "architect should not bake model field with custom provider and no root model");
      assert.doesNotMatch(architectToml, /exact gpt-6-astra model/, "architect should not emit astra guidance with custom provider and no root model");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("preserves exactModel pins for profile-scoped built-in provider model (Codex finding 4309255932)", async () => {
    const codexHome = join(tmpdir(), `omx-profile-builtin-model-test-${process.pid}`);
    try {
      // Create a config.toml with profile-scoped built-in provider and model, but no root model
      // This reproduces the scenario from finding 4309255932
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "config.toml"), [
        'profile = "work-lane"',
        '',
        '[profiles.work-lane]',
        'model_provider = "openai-chatgpt"',
        'model = "gpt-6-luna"',
      ].join("\n"));

      // With profile-scoped built-in provider and model (no root model),
      // planner SHOULD bake exactModel because:
      // - It has exactModel (gpt-6-astra)
      // - The effective provider is built-in (openai-chatgpt from profile)
      // - The effective model is configured (gpt-6-luna in profile)
      const plannerToml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt", {
        codexHomeOverride: codexHome,
      });
      assert.match(plannerToml, /model = "gpt-6-astra"/, "planner should bake exactModel with profile-scoped built-in provider and model");
      assert.match(plannerToml, /exact gpt-6-astra model/, "planner should receive astra guidance with profile-scoped built-in provider and model");

      // Same for architect
      const architectToml = generateAgentToml(AGENT_DEFINITIONS.architect, "architect prompt", {
        codexHomeOverride: codexHome,
      });
      assert.match(architectToml, /model = "gpt-6-astra"/, "architect should bake exactModel with profile-scoped built-in provider and model");
      assert.match(architectToml, /exact gpt-6-astra model/, "architect should receive astra guidance with profile-scoped built-in provider and model");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("preserves exact guidance for custom provider with per-agent override (Codex finding 4309255938)", async () => {
    const codexHome = join(tmpdir(), `omx-custom-override-test-${process.pid}`);
    try {
      // Create a config.toml with custom provider, no root model, but explicit agentModels override
      // This reproduces the scenario from finding 4309255938
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "config.toml"), [
        'model_provider = "custom_provider"',
        '',
        '[model_providers.custom_provider]',
        'name = "custom_provider"',
        'base_url = "http://localhost:3000/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        'env_key = "CUSTOM_PROVIDER_API_KEY"',
      ].join("\n"));
      await writeFile(join(codexHome, ".omx-config.json"), JSON.stringify({
        agentModels: { planner: "gpt-5.6-terra" }
      }));

      // With custom provider, no root model, but explicit planner override to gpt-5.6-terra,
      // planner SHOULD bake the override model AND receive terra guidance because:
      // - There IS an explicit per-agent override (planner: "gpt-5.6-terra")
      // - The overlay should NOT be suppressed when there's an override
      const plannerToml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt", {
        codexHomeOverride: codexHome,
      });
      assert.match(plannerToml, /model = "gpt-5\.6-terra"/, "planner should bake override model with per-agent override");
      assert.match(plannerToml, /exact gpt-5\.6-terra model/, "planner should receive terra guidance with per-agent override");

      // Architect should NOT have override or guidance (no override specified)
      const architectToml = generateAgentToml(AGENT_DEFINITIONS.architect, "architect prompt", {
        codexHomeOverride: codexHome,
      });
      assert.doesNotMatch(architectToml, /^model\s*=/m, "architect should not bake model without override");
      assert.doesNotMatch(architectToml, /exact gpt-6-astra model/, "architect should not emit astra guidance without override");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("resolves profile model before falling back to env vars (Codex P2 finding)", async () => {
    const codexHome = join(tmpdir(), `omx-profile-env-priority-test-${process.pid}`);
    const origFrontierModel = process.env.OMX_DEFAULT_FRONTIER_MODEL;
    try {
      // Create a config.toml with profile-scoped built-in provider and model, but no root model
      // Also set OMX_DEFAULT_FRONTIER_MODEL env var to a different model
      // The profile model should take precedence and planner should return exactModel
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "config.toml"), [
        'profile = "work-lane"',
        '',
        '[profiles.work-lane]',
        'model_provider = "openai-chatgpt"',
        'model = "gpt-6-luna"',
      ].join("\n"));

      // Set env var to a different model
      process.env.OMX_DEFAULT_FRONTIER_MODEL = "gpt-5.6-terra";

      // With profile-scoped built-in provider and model + env var set,
      // planner should return exactModel (gpt-6-astra), not the env var default
      const plannerToml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt", {
        codexHomeOverride: codexHome,
      });
      assert.match(plannerToml, /model = "gpt-6-astra"/, "planner should bake exactModel, not env var default, when profile model is set");
      assert.match(plannerToml, /exact gpt-6-astra model/, "planner should receive astra guidance, not fall back to env var");

      // Same for architect
      const architectToml = generateAgentToml(AGENT_DEFINITIONS.architect, "architect prompt", {
        codexHomeOverride: codexHome,
      });
      assert.match(architectToml, /model = "gpt-6-astra"/, "architect should bake exactModel, not env var default");
      assert.match(architectToml, /exact gpt-6-astra model/, "architect should receive astra guidance");
    } finally {
      if (typeof origFrontierModel === "string") {
        process.env.OMX_DEFAULT_FRONTIER_MODEL = origFrontierModel;
      } else {
        delete process.env.OMX_DEFAULT_FRONTIER_MODEL;
      }
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("resolves profile-scoped model before root fallback (Codex finding 4309857268)", async () => {
    const codexHome = join(tmpdir(), `omx-profile-model-priority-test-${process.pid}`);
    try {
      // Create a config.toml with:
      // - Root model: astra
      // - Profile-scoped custom provider + model: custom_glm
      // When the profile is active, metadata should reflect the profile model, not root
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "config.toml"), [
        'profile = "custom-lane"',
        'model = "gpt-6-astra"',
        '',
        '[profiles.custom-lane]',
        'model_provider = "custom-glm-provider"',
        'model = "custom-glm-4.0"',
      ].join("\n"));

      // With profile-scoped custom provider + model + root astra,
      // planner should use profile model for metadata, not root astra
      const plannerToml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt", {
        codexHomeOverride: codexHome,
      });
      // Should NOT emit astra guidance (the root model)
      assert.doesNotMatch(plannerToml, /exact gpt-6-astra model/, "planner should not resolve to root astra when profile has custom provider with model");
      // Should NOT have astra in resolved_model if custom provider is active
      assert.doesNotMatch(plannerToml, /resolved_model: gpt-6-astra/, "planner metadata should not report root model when profile model is configured");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("keeps exact pins when built-in provider omits model field (Codex finding 4309857276)", async () => {
    const codexHome = join(tmpdir(), `omx-builtin-no-model-test-${process.pid}`);
    try {
      // Create a config.toml with explicit built-in provider (openai-chatgpt) but NO model field
      // This should behave like the implicit default provider and keep exact pins
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "config.toml"), [
        'model_provider = "openai-chatgpt"',
        // Intentionally NO model field
      ].join("\n"));

      // With explicit built-in provider but no root model,
      // planner should STILL bake exactModel (like implicit default)
      const plannerToml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt", {
        codexHomeOverride: codexHome,
      });
      assert.match(plannerToml, /model = "gpt-6-astra"/, "planner should bake exactModel when built-in provider is explicit even without root model");
      assert.match(plannerToml, /exact gpt-6-astra model/, "planner should receive exact guidance when built-in provider is explicit without root model");

      // Same for architect
      const architectToml = generateAgentToml(AGENT_DEFINITIONS.architect, "architect prompt", {
        codexHomeOverride: codexHome,
      });
      assert.match(architectToml, /model = "gpt-6-astra"/, "architect should bake exactModel when built-in provider is explicit without root model");
      assert.match(architectToml, /exact gpt-6-astra model/, "architect should receive exact guidance when built-in provider is explicit without root model");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("omits fallback metadata for custom provider without root or profile model (Codex finding 4309974425)", async () => {
    const codexHome = join(tmpdir(), `omx-custom-provider-no-model-test-${process.pid}`);
    try {
      // Create a config.toml with custom provider but NO root model and NO profile model
      // The agent will inherit the custom provider's default model at runtime
      // So we should NOT emit resolved_model metadata claiming astra
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "config.toml"), [
        'model_provider = "custom-provider-x"',
        '',
        '[model_providers.custom-provider-x]',
        'name = "custom-provider-x"',
        'base_url = "http://localhost:8000/v1"',
        'wire_api = "openai"',
        'requires_openai_auth = false',
        'env_key = "CUSTOM_PROVIDER_X_API_KEY"',
      ].join("\n"));

      // With custom provider and no root/profile model,
      // planner should NOT emit resolved_model metadata
      const plannerToml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt", {
        codexHomeOverride: codexHome,
      });
      assert.doesNotMatch(plannerToml, /^model\s*=/m, "planner should not bake model field with custom provider and no root model");
      assert.doesNotMatch(plannerToml, /resolved_model:/, "planner should not emit resolved_model metadata with custom provider and no root model");
      assert.doesNotMatch(plannerToml, /exact gpt-6-astra model/, "planner should not emit astra guidance with custom provider and no root model");

      // Same for architect
      const architectToml = generateAgentToml(AGENT_DEFINITIONS.architect, "architect prompt", {
        codexHomeOverride: codexHome,
      });
      assert.doesNotMatch(architectToml, /^model\s*=/m, "architect should not bake model field with custom provider and no root model");
      assert.doesNotMatch(architectToml, /resolved_model:/, "architect should not emit resolved_model metadata with custom provider and no root model");
      assert.doesNotMatch(architectToml, /exact gpt-6-astra model/, "architect should not emit astra guidance with custom provider and no root model");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("treats mixed-case provider IDs as custom providers (Codex finding new)", async () => {
    const codexHome = join(tmpdir(), `omx-mixed-case-provider-test-${process.pid}`);
    try {
      // Create a config.toml with mixed-case provider ID ("OpenAI" instead of lowercase "openai")
      // This should be treated as a custom provider, NOT the built-in "openai" provider,
      // to preserve intentional custom provider configurations.
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "config.toml"), [
        'model_provider = "OpenAI"',  // Custom provider (not built-in)
        'model = "gpt-6-astra"',
      ].join("\n"));

      // With a custom provider, planner should NOT bake exactModel
      const plannerToml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt", {
        codexHomeOverride: codexHome,
      });
      assert.doesNotMatch(plannerToml, /^model\s*=/m, "planner should not bake model field with custom provider");
      assert.doesNotMatch(plannerToml, /exact gpt-6-astra model/, "planner should not receive exact guidance with custom provider");

      // Same for architect
      const architectToml = generateAgentToml(AGENT_DEFINITIONS.architect, "architect prompt", {
        codexHomeOverride: codexHome,
      });
      assert.doesNotMatch(architectToml, /^model\s*=/m, "architect should not bake model field with custom provider");
      assert.doesNotMatch(architectToml, /exact gpt-6-astra model/, "architect should not receive exact guidance with custom provider");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("applies profile models before built-in fallbacks (Codex finding 4310223529)", async () => {
    // This test verifies that when a built-in provider has an explicit model configured
    // (from profile or root), roles without exactModel get that model instead of
    // falling back to env/class-based defaults.
    const codexHome = join(tmpdir(), `omx-profile-model-test-${process.pid}`);
    try {
      // Create a config with built-in provider and explicit model
      // For roles without exactModel (like debugger), this model should be used
      // instead of falling back to resolveStandardModel/resolveFrontierModel
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "config.toml"), [
        'model = "gpt-5.6-terra"',
        'model_provider = "openai"',  // Built-in provider
      ].join("\n"));

      // Debugger has no exactModel, so with this fix it should:
      // 1. See built-in provider (openai)
      // 2. See configured model (gpt-5.6-terra)
      // 3. Return the configured model instead of falling back to modelClass defaults
      const debuggerToml = generateAgentToml(AGENT_DEFINITIONS.debugger, "debugger prompt", {
        codexHomeOverride: codexHome,
      });
      assert.match(debuggerToml, /resolved_model: gpt-5\.6-terra/, "debugger should resolve to configured model with built-in provider");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});
