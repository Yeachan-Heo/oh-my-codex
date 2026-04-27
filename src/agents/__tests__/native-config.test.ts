import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentDefinition } from "../definitions.js";
import type { CatalogManifest } from "../../catalog/schema.js";
import {
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

const originalStandardModel = process.env.OMX_DEFAULT_STANDARD_MODEL;

beforeEach(() => {
  process.env.OMX_DEFAULT_STANDARD_MODEL = "gpt-5.4-mini";
});

afterEach(() => {
  if (typeof originalStandardModel === "string") {
    process.env.OMX_DEFAULT_STANDARD_MODEL = originalStandardModel;
  } else {
    delete process.env.OMX_DEFAULT_STANDARD_MODEL;
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
    assert.match(toml, /model = "gpt-5\.5"/);
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

  it("applies exact-model mini guidance only for resolved gpt-5.4-mini standard roles", () => {
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
      env: { OMX_DEFAULT_STANDARD_MODEL: "gpt-5.4-mini" } as NodeJS.ProcessEnv,
    });
    const frontierToml = generateAgentToml(agent, prompt, {
      env: { OMX_DEFAULT_STANDARD_MODEL: "gpt-5.5" } as NodeJS.ProcessEnv,
    });
    const tunedToml = generateAgentToml(agent, prompt, {
      env: { OMX_DEFAULT_STANDARD_MODEL: "gpt-5.4-mini-tuned" } as NodeJS.ProcessEnv,
    });

    assert.match(exactMiniToml, /exact gpt-5\.4-mini model/);
    assert.match(exactMiniToml, /strict execution order: inspect -> plan -> act -> verify/);
    assert.match(exactMiniToml, /resolved_model: gpt-5\.4-mini/);
    assert.doesNotMatch(frontierToml, /exact gpt-5\.4-mini model/);
    assert.doesNotMatch(tunedToml, /exact gpt-5\.4-mini model/);
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
      assert.match(executorToml, /model = "gpt-5\.5"/);
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
        'model = "gpt-5.5"',
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
      assert.match(executorToml, /model = "gpt-5\.5"/);
      assert.match(executorToml, /model_provider = "cheapRouter"/);
    } finally {
      if (typeof previousCodexHome === "string") process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      process.env.OMX_DEFAULT_STANDARD_MODEL = "gpt-5.4-mini";
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
      assert.doesNotMatch(debuggerToml, /model = "gpt-5\.4-mini"/);
    } finally {
      if (typeof previousCodexHome === "string") process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      process.env.OMX_DEFAULT_STANDARD_MODEL = "gpt-5.4-mini";
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
      process.env.OMX_DEFAULT_STANDARD_MODEL = "gpt-5.4-mini";
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
      assert.match(debuggerToml, /model = "gpt-5\.4-mini"/);
      assert.doesNotMatch(debuggerToml, /model = "gpt-5\.2"/);
    } finally {
      if (typeof previousCodexHome === "string") process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      process.env.OMX_DEFAULT_STANDARD_MODEL = "gpt-5.4-mini";
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
      process.env.OMX_DEFAULT_STANDARD_MODEL = "gpt-5.4-mini";
      await rm(root, { recursive: true, force: true });
    }
  });
});
