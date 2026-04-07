import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentDefinition } from "../definitions.js";
import {
  generateAgentToml,
  installNativeAgentConfigs,
} from "../native-config.js";

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
    assert.match(toml, /model = "gpt-5\.4"/);
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
      env: { OMX_DEFAULT_STANDARD_MODEL: "gpt-5.4" } as NodeJS.ProcessEnv,
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

  it("disables leader-oriented OMX MCP servers for generated native subagents only when present in config", () => {
    const agent: AgentDefinition = {
      name: "planner",
      description: "Project planner",
      reasoningEffort: "medium",
      posture: "frontier-orchestrator",
      modelClass: "frontier",
      routingRole: "leader",
      tools: "analysis",
      category: "build",
    };

    const prompt = "Instruction line";
    const toml = generateAgentToml(agent, prompt, {
      configTomlContent: `
[mcp_servers.omx_state]
command = "node"

[mcp_servers.omx_code_intel]
command = "node"

[mcp_servers.omx_trace]
command = "node"

[mcp_servers.chrome-mcp]
url = "http://127.0.0.1:12306/mcp"
`,
    });

    assert.match(toml, /\[mcp_servers\.omx_state\]\nenabled = false/);
    assert.match(toml, /\[mcp_servers\.omx_trace\]\nenabled = false/);
    assert.doesNotMatch(toml, /\[mcp_servers\.omx_code_intel\]\nenabled = false/);
    assert.doesNotMatch(toml, /\[mcp_servers\.chrome-mcp\]\nenabled = false/);
  });

  it("does not inject OMX MCP disable blocks when the current config has no matching OMX servers", () => {
    const agent: AgentDefinition = {
      name: "planner",
      description: "Project planner",
      reasoningEffort: "medium",
      posture: "frontier-orchestrator",
      modelClass: "frontier",
      routingRole: "leader",
      tools: "analysis",
      category: "build",
    };

    const prompt = "Instruction line";
    const toml = generateAgentToml(agent, prompt, {
      configTomlContent: `
[mcp_servers.chrome-mcp]
url = "http://127.0.0.1:12306/mcp"
`,
    });

    assert.doesNotMatch(toml, /\[mcp_servers\.omx_/);
  });

  it("installs only agents with prompt files and skips existing files without force", async () => {
    const root = await mkdtemp(join(tmpdir(), "omx-native-config-"));
    const promptsDir = join(root, "prompts");
    const outDir = join(root, "agents-out");

    try {
      await mkdir(promptsDir, { recursive: true });
      await writeFile(join(promptsDir, "executor.md"), "executor prompt");
      await writeFile(join(promptsDir, "planner.md"), "planner prompt");

      const created = await installNativeAgentConfigs(root, {
        agentsDir: outDir,
      });
      assert.equal(created, 2);
      assert.equal(existsSync(join(outDir, "executor.toml")), true);
      assert.equal(existsSync(join(outDir, "planner.toml")), true);

      const executorToml = await readFile(
        join(outDir, "executor.toml"),
        "utf8",
      );
      assert.match(executorToml, /model = "gpt-5\.4"/);
      assert.match(executorToml, /model_reasoning_effort = "high"/);

      const skipped = await installNativeAgentConfigs(root, {
        agentsDir: outDir,
      });
      assert.equal(skipped, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps standard agents off a custom gpt-5.2 root model", async () => {
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

      await installNativeAgentConfigs(root, { agentsDir: outDir });
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

      await installNativeAgentConfigs(root, { agentsDir: outDir });
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
