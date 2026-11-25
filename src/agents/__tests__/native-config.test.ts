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
  isSafelyEditableNativeAgentToml,
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
  delete process.env.OMX_DEFAULT_STANDARD_MODEL;
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
  it("writes each role's tier default and reasoning effort", () => {
    const expectedEfforts: Record<string, string> = {
      executor: "medium",
      "team-executor": "medium",
      explore: "medium",
      analyst: "medium",
      planner: "medium",
      architect: "xhigh",
      debugger: "high",
      verifier: "high",
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
      designer: "high",
      writer: "high",
      "qa-tester": "low",
      "git-master": "high",
      "code-simplifier": "high",
      researcher: "high",
      "product-manager": "medium",
      "ux-researcher": "medium",
      "information-architect": "low",
      "product-analyst": "low",
      critic: "high",
      vision: "low",
    };
    const expectedClasses = {
      frontier: ["planner", "architect", "critic"],
      fast: ["explore", "style-reviewer", "vision"],
      standard: Object.keys(expectedEfforts).filter(
        (role) => !["planner", "architect", "critic", "explore", "style-reviewer", "vision"].includes(role),
      ),
    } as const;
    const defaultModels: Record<AgentDefinition["modelClass"], string> = {
      frontier: "gpt-6.2-astra",
      standard: "gpt-6.2-sol",
      fast: "gpt-6-luna",
    };

    assert.deepEqual(Object.keys(AGENT_DEFINITIONS).sort(), Object.keys(expectedEfforts).sort());
    for (const [modelClass, roles] of Object.entries(expectedClasses)) {
      for (const role of roles) {
        assert.equal(AGENT_DEFINITIONS[role].modelClass, modelClass, `${role} tier`);
      }
    }

    for (const [role, effort] of Object.entries(expectedEfforts)) {
      const toml = generateAgentToml(AGENT_DEFINITIONS[role], `${role} prompt`);
      const parsed = parseToml(toml);
      const expectedModel = defaultModels[AGENT_DEFINITIONS[role].modelClass];
      assert.equal(parsed.model, expectedModel, `${role} model`);
      assert.match(toml, new RegExp(`resolved_model: ${expectedModel}\\b`), `${role} metadata`);
      assert.equal(parsed.model_reasoning_effort, effort, `${role} reasoning effort`);
    }
  });

  it("applies configured tier environment defaults by role class", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "omx-native-config-env-tiers-"));
    try {
      await writeFile(join(codexHome, ".omx-config.json"), JSON.stringify({
        env: {
          OMX_DEFAULT_FRONTIER_MODEL: "frontier-from-env",
          OMX_DEFAULT_STANDARD_MODEL: "standard-from-env",
          OMX_DEFAULT_SPARK_MODEL: "spark-from-env",
        },
      }));

      for (const [role, expectedModel] of Object.entries({
        planner: "frontier-from-env",
        critic: "frontier-from-env",
        executor: "standard-from-env",
        researcher: "standard-from-env",
        explore: "spark-from-env",
        vision: "spark-from-env",
      })) {
        const toml = generateAgentToml(AGENT_DEFINITIONS[role], `${role} prompt`, {
          codexHomeOverride: codexHome,
        });
        assert.equal(parseToml(toml).model, expectedModel, role);
        assert.match(toml, new RegExp(`resolved_model: ${expectedModel}\\b`), role);
      }
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("uses an agentModels override for only that role, ahead of its tier environment default", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "omx-native-config-agent-model-override-"));
    try {
      await writeFile(join(codexHome, ".omx-config.json"), JSON.stringify({
        env: {
          OMX_DEFAULT_FRONTIER_MODEL: "frontier-from-env",
          OMX_DEFAULT_STANDARD_MODEL: "standard-from-env",
          OMX_DEFAULT_SPARK_MODEL: "spark-from-env",
        },
        agentModels: { planner: "planner-custom-model" },
      }));

      const plannerToml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt", {
        codexHomeOverride: codexHome,
      });
      assert.equal(parseToml(plannerToml).model, "planner-custom-model");
      assert.match(plannerToml, /resolved_model: planner-custom-model/);

      const architectToml = generateAgentToml(AGENT_DEFINITIONS.architect, "architect prompt", {
        codexHomeOverride: codexHome,
      });
      assert.equal(parseToml(architectToml).model, "frontier-from-env");
      assert.match(architectToml, /model_reasoning_effort = "xhigh"/);

      const executorToml = generateAgentToml(AGENT_DEFINITIONS.executor, "executor prompt", {
        codexHomeOverride: codexHome,
      });
      assert.equal(parseToml(executorToml).model, "standard-from-env");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("does not use root or active profile models for agent tiers", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "omx-native-config-main-model-"));
    try {
      await writeFile(join(codexHome, "config.toml"), [
        'profile = "work-lane"',
        'model = "gpt-5.2"',
        'model_provider = "openai"',
        "",
        "[profiles.work-lane]",
        'model = "profile-session-model"',
        'model_provider = "openai-chatgpt"',
      ].join("\n"));

      const executorToml = generateAgentToml(AGENT_DEFINITIONS.executor, "executor prompt", {
        codexHomeOverride: codexHome,
      });
      const executor = parseToml(executorToml);
      assert.equal(executor.model, "gpt-6.2-sol");
      assert.equal(executor.model_reasoning_effort, "medium");
      assert.match(executorToml, /resolved_model: gpt-6\.2-sol/);

      const plannerToml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt", {
        codexHomeOverride: codexHome,
      });
      assert.equal(parseToml(plannerToml).model, "gpt-6.2-astra");
      assert.match(plannerToml, /resolved_model: gpt-6\.2-astra/);

      const exploreToml = generateAgentToml(AGENT_DEFINITIONS.explore, "explore prompt", {
        codexHomeOverride: codexHome,
      });
      assert.equal(parseToml(exploreToml).model, "gpt-6-luna");
      assert.match(exploreToml, /resolved_model: gpt-6-luna/);

      await writeFile(join(codexHome, "config.toml"), 'model_provider = "openai-chatgpt"\n');
      const noConfiguredModelToml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt", {
        codexHomeOverride: codexHome,
      });
      assert.equal(parseToml(noConfiguredModelToml).model, "gpt-6.2-astra");
      assert.match(noConfiguredModelToml, /resolved_model: gpt-6\.2-astra/);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("omits tier models for custom providers unless a role override is configured", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "omx-native-config-custom-provider-"));
    try {
      await writeFile(join(codexHome, "config.toml"), [
        'model = "glm-custom-root"',
        'model_provider = "custom-provider"',
      ].join("\n"));
      await writeFile(join(codexHome, ".omx-config.json"), JSON.stringify({
        env: {
          OMX_DEFAULT_FRONTIER_MODEL: "frontier-from-env",
          OMX_DEFAULT_STANDARD_MODEL: "standard-from-env",
          OMX_DEFAULT_SPARK_MODEL: "spark-from-env",
        },
        agentModels: { planner: "planner-custom-model" },
      }));

      for (const role of ["architect", "debugger", "explore"] as const) {
        const toml = generateAgentToml(AGENT_DEFINITIONS[role], `${role} prompt`, {
          codexHomeOverride: codexHome,
        });
        assert.equal(parseToml(toml).model, undefined, role);
        assert.match(toml, /resolved_model: glm-custom-root/, role);
      }

      const plannerToml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt", {
        codexHomeOverride: codexHome,
      });
      assert.equal(parseToml(plannerToml).model, "planner-custom-model");
      assert.match(plannerToml, /resolved_model: planner-custom-model/);
      assert.doesNotMatch(plannerToml, /model_provider\s*=/);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("omits resolved model metadata for a custom provider without an effective model", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "omx-native-config-custom-no-model-"));
    try {
      await writeFile(join(codexHome, "config.toml"), [
        'model_provider = "custom-provider"',
        "",
        "[model_providers.custom-provider]",
        'name = "Custom Provider"',
        'base_url = "https://custom.example/v1"',
        'wire_api = "responses"',
      ].join("\n"));

      const toml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt", {
        codexHomeOverride: codexHome,
      });
      assert.equal(parseToml(toml).model, undefined);
      assert.doesNotMatch(toml, /resolved_model:/);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("treats mixed-case built-in provider IDs as custom providers", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "omx-native-config-mixed-case-provider-"));
    try {
      await writeFile(join(codexHome, "config.toml"), [
        'model_provider = "OpenAI"',
        'model = "mixed-case-provider-model"',
      ].join("\n"));

      const plannerToml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt", {
        codexHomeOverride: codexHome,
      });
      assert.equal(parseToml(plannerToml).model, undefined);
      assert.match(plannerToml, /resolved_model: mixed-case-provider-model/);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("uses an active custom provider profile model only as resolved metadata", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "omx-native-config-custom-profile-"));
    try {
      await writeFile(join(codexHome, "config.toml"), [
        'profile = "custom-lane"',
        'model = "main-session-model"',
        "",
        "[profiles.custom-lane]",
        'model_provider = "profile-custom-provider"',
        'model = "profile-custom-model"',
      ].join("\n"));

      const toml = generateAgentToml(AGENT_DEFINITIONS.planner, "planner prompt", {
        codexHomeOverride: codexHome,
      });
      assert.equal(parseToml(toml).model, undefined);
      assert.match(toml, /resolved_model: profile-custom-model/);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("generates TOML with stripped frontmatter, escaped triple quotes, and the standard executor model", () => {
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
    const parsed = parseToml(toml);

    assert.match(toml, /# oh-my-codex agent: executor/);
    assert.equal(parsed.model, "gpt-6.2-sol");
    assert.equal(parsed.model_reasoning_effort, "medium");
    assert.match(toml, /resolved_model: gpt-6\.2-sol/);
    assert.ok(!toml.includes("title: demo"));
    assert.ok(toml.includes("Instruction line"));
    assert.ok(toml.includes("You are operating in the deep-worker posture."));
    assert.ok(toml.includes("- posture: deep-worker"));

    const tripleQuoteBlocks = toml.match(/\"\"\"/g) || [];
    assert.equal(tripleQuoteBlocks.length, 2, "only TOML delimiters should remain as raw triple quotes");
  });

  it("applies configured reasoning overrides and normalizes unsupported values", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "omx-native-config-reasoning-"));
    try {
      await writeFile(join(codexHome, ".omx-config.json"), JSON.stringify({
        agentReasoning: {
          architect: " MAX ",
          critic: "ultra",
        },
      }));

      const architectToml = generateAgentToml(AGENT_DEFINITIONS.architect, "architect prompt", {
        codexHomeOverride: codexHome,
      });
      assert.equal(parseToml(architectToml).model_reasoning_effort, "max");

      const criticToml = generateAgentToml(AGENT_DEFINITIONS.critic, "critic prompt", {
        codexHomeOverride: codexHome,
      });
      assert.equal(parseToml(criticToml).model_reasoning_effort, "high");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("keeps posture overlays within read-only and advisory assignments", () => {
    for (const role of ["architect", "planner", "researcher", "debugger"] as const) {
      const toml = generateAgentToml(AGENT_DEFINITIONS[role], "Return a read-only analysis.");
      const instructions = parseToml(toml).developer_instructions as string;

      assert.match(instructions, /Return a read-only analysis\./);
      assert.doesNotMatch(instructions, /requested work is implemented/);
      assert.doesNotMatch(instructions, /diagnostics, tests, and build evidence are mandatory/);
      assert.doesNotMatch(instructions, /Default to delegation and orchestration when specialists exist/);
    }
  });

  it("places native leaf guards after role guidance and before metadata", () => {
    const codeReviewerToml = generateAgentToml(
      AGENT_DEFINITIONS["code-reviewer"],
      "code-reviewer prompt",
    );
    assert.match(codeReviewerToml, /<native_subagent_leaf_guard>/);
    assert.match(codeReviewerToml, /do not call Task, spawn_agent, or native child agents/);
    assert.match(codeReviewerToml, /report missing specialist coverage to the leader/);

    const postureIndex = codeReviewerToml.indexOf(
      "Specialist coverage must stay within the assigned role and delegation authority.",
    );
    const guardIndex = codeReviewerToml.indexOf("<native_subagent_leaf_guard>");
    const metadataIndex = codeReviewerToml.indexOf("## OMX Agent Metadata");
    assert.ok(postureIndex >= 0, "role posture should be present");
    assert.ok(guardIndex > postureIndex, "leaf guard should follow role guidance");
    assert.ok(metadataIndex > guardIndex, "metadata should follow the leaf guard");

    for (const role of ["researcher", "team-executor", "executor"] as const) {
      const toml = generateAgentToml(AGENT_DEFINITIONS[role], `${role} prompt`);
      assert.match(toml, /<native_subagent_leaf_guard>/, role);
    }
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

  it("installs only catalog-installable agents, writes tier models, and skips existing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "omx-native-config-install-"));
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

      const executorToml = await readFile(join(outDir, "executor.toml"), "utf8");
      assert.equal(parseToml(executorToml).model, "gpt-6.2-sol");
      assert.match(executorToml, /resolved_model: gpt-6\.2-sol/);
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
        agentReasoning: { architect: "xhigh" },
      }));
      await writeFile(join(promptsDir, "architect.md"), "architect prompt");

      await installNativeAgentConfigs(root, {
        agentsDir: outDir,
        catalogManifest: manifestWithAgents(["architect"]),
      });

      const architectToml = await readFile(join(outDir, "architect.toml"), "utf8");
      assert.equal(parseToml(architectToml).model, "gpt-6.2-astra");
      assert.equal(parseToml(architectToml).model_reasoning_effort, "xhigh");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("inherits custom provider settings without baking them into native TOML", async () => {
    const root = await mkdtemp(join(tmpdir(), "omx-native-config-provider-"));
    const codexHome = join(root, ".codex");
    const promptsDir = join(root, "prompts");
    const outDir = join(codexHome, "agents");
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = codexHome;
      await mkdir(promptsDir, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "config.toml"), [
        'model = "custom-session-model"',
        'model_provider = "cheapRouter"',
        "",
        "[model_providers.cheapRouter]",
        'name = "Cheap Router"',
        'base_url = "https://cheaprouter.example/v1"',
        'wire_api = "responses"',
        "supports_websockets = true",
      ].join("\n"));
      await writeFile(join(promptsDir, "executor.md"), "executor prompt");

      await installNativeAgentConfigs(root, {
        agentsDir: outDir,
        catalogManifest: manifestWithAgents(["executor"]),
      });
      const executorToml = await readFile(join(outDir, "executor.toml"), "utf8");
      assert.equal(parseToml(executorToml).model, undefined);
      assert.match(executorToml, /resolved_model: custom-session-model/);
      assert.doesNotMatch(executorToml, /model_provider\s*=/);
    } finally {
      if (typeof previousCodexHome === "string") process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("isSafelyEditableNativeAgentToml: rejects TOML with top-level keys after developer_instructions body", () => {
    const unsafe = [
      'name = "test"\n',
      'developer_instructions = """\n',
      'instructions here\n',
      '"""\n',
      'model = "claude-3-5-sonnet"\n',
    ].join("");
    assert.equal(isSafelyEditableNativeAgentToml(unsafe, "test"), false);
  });

  it("isSafelyEditableNativeAgentToml: rejects TOML with any top-level key after multiline developer_instructions", () => {
    const unsafe = [
      'name = "test"\n',
      'developer_instructions = """\n',
      'instructions\n',
      '"""\n',
      'model_reasoning_effort = "high"\n',
    ].join("");
    assert.equal(isSafelyEditableNativeAgentToml(unsafe, "test"), false);
  });

  it("isSafelyEditableNativeAgentToml: accepts TOML with single-line developer_instructions and top-level keys before it", () => {
    const safe = [
      'name = "test"\n',
      'model = "claude-3-5-sonnet"\n',
      'developer_instructions = "My custom prompt"\n',
    ].join("");
    assert.equal(isSafelyEditableNativeAgentToml(safe, "test"), true);
  });

  it("isSafelyEditableNativeAgentToml: accepts TOML with triple-quoted single-line developer_instructions", () => {
    const safe = [
      'name = "test"\n',
      'model = "claude-3-5-sonnet"\n',
      'developer_instructions = """My custom prompt"""\n',
    ].join("");
    assert.equal(isSafelyEditableNativeAgentToml(safe, "test"), true);
  });

  it("isSafelyEditableNativeAgentToml: accepts TOML with content ending in quotes adjacent to closing delimiter", () => {
    const safe = [
      'name = "test"\n',
      'model = "claude-3-5-sonnet"\n',
      'developer_instructions = """My favorite quote: \\""""\n',
    ].join("");
    assert.equal(isSafelyEditableNativeAgentToml(safe, "test"), true);
  });

  it("isSafelyEditableNativeAgentToml: accepts TOML with trailing blank lines and comments", () => {
    const safe = [
      'name = "test"\n',
      'developer_instructions = """\n',
      'instructions\n',
      '"""\n',
      '\n',
      '# trailing comment\n',
      '\n',
    ].join("");
    assert.equal(isSafelyEditableNativeAgentToml(safe, "test"), true);
  });

  it("isSafelyEditableNativeAgentToml: accepts normal generated TOML file", () => {
    const normal = [
      'name = "executor"\n',
      'model = "claude-3-5-sonnet"\n',
      'model_reasoning_effort = "medium"\n',
      'developer_instructions = """\n',
      'You are an executor.\n',
      'Your role is to execute tasks.\n',
      '"""\n',
    ].join("");
    assert.equal(isSafelyEditableNativeAgentToml(normal, "executor"), true);
  });
});
