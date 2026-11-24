import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "@iarna/toml";
import { AGENT_DEFINITIONS } from "../definitions.js";
import { generateAgentToml } from "../native-config.js";
import { resolveAgentDefaultModel } from "../../team/model-contract.js";
import {
  buildAgentsModelTable,
  resolveAgentsModelTableContext,
} from "../../utils/agents-model-table.js";

const FRONTIER_ROLES = ["planner", "architect", "critic"] as const;
const STANDARD_ROLES = [
  "researcher",
  "analyst",
  "test-engineer",
  "code-reviewer",
  "security-reviewer",
  "code-simplifier",
  "team-executor",
  "executor",
] as const;
const SPARK_ROLES = ["explore", "style-reviewer", "vision"] as const;
const ALL_ROLES = [...FRONTIER_ROLES, ...STANDARD_ROLES, ...SPARK_ROLES];

const ENV_KEYS = [
  "CODEX_HOME",
  "OMX_DEFAULT_FRONTIER_MODEL",
  "OMX_DEFAULT_STANDARD_MODEL",
  "OMX_DEFAULT_SPARK_MODEL",
  "OMX_SPARK_MODEL",
] as const;

const savedEnv = new Map<string, string | undefined>();
let codexHome: string;

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  codexHome = await mkdtemp(join(tmpdir(), "omx-tier-models-"));
  process.env.CODEX_HOME = codexHome;
});

afterEach(async () => {
  for (const [key, value] of savedEnv) {
    if (typeof value === "string") process.env[key] = value;
    else delete process.env[key];
  }
  await rm(codexHome, { recursive: true, force: true });
});

const ENV_ONLY = {
  OMX_DEFAULT_FRONTIER_MODEL: "frontier-env",
  OMX_DEFAULT_STANDARD_MODEL: "standard-env",
  OMX_DEFAULT_SPARK_MODEL: "spark-env",
};

async function writeOmxConfig(config: Record<string, unknown>): Promise<void> {
  await writeFile(join(codexHome, ".omx-config.json"), JSON.stringify(config));
}

function nativeModel(role: string): unknown {
  const toml = generateAgentToml(AGENT_DEFINITIONS[role], `${role} prompt`, {
    codexHomeOverride: codexHome,
  });
  return parseToml(toml).model;
}

function tierOf(role: string): string {
  if ((FRONTIER_ROLES as readonly string[]).includes(role)) return "frontier";
  if ((SPARK_ROLES as readonly string[]).includes(role)) return "spark";
  return "standard";
}

function expectedFor(
  role: string,
  models: { frontier: string; standard: string; spark: string },
): string {
  if ((FRONTIER_ROLES as readonly string[]).includes(role)) return models.frontier;
  if ((SPARK_ROLES as readonly string[]).includes(role)) return models.spark;
  return models.standard;
}

describe("env tier vars as the single source of truth", () => {
  it("writes native TOML models from an env-only config", async () => {
    await writeOmxConfig({ env: ENV_ONLY, agentModels: {} });
    for (const role of ALL_ROLES) {
      assert.equal(
        nativeModel(role),
        expectedFor(role, { frontier: "frontier-env", standard: "standard-env", spark: "spark-env" }),
        role,
      );
    }
  });

  it("falls back to gpt-6.2-astra / gpt-6.2-sol / gpt-6-luna with no env set", () => {
    for (const role of ALL_ROLES) {
      assert.equal(
        nativeModel(role),
        expectedFor(role, { frontier: "gpt-6.2-astra", standard: "gpt-6.2-sol", spark: "gpt-6-luna" }),
        role,
      );
    }
  });

  it("does not let a different config.toml root model change any agent row", async () => {
    await writeFile(join(codexHome, "config.toml"), 'model = "root-model"\n');
    await writeOmxConfig({ env: ENV_ONLY });
    const context = resolveAgentsModelTableContext('model = "root-model"\n', { codexHomeOverride: codexHome });
    const table = buildAgentsModelTable(context, undefined, { codexHomeOverride: codexHome });
    for (const role of ALL_ROLES) {
      const expected = expectedFor(role, { frontier: "frontier-env", standard: "standard-env", spark: "spark-env" });
      assert.equal(nativeModel(role), expected, `native ${role}`);
      assert.equal(resolveAgentDefaultModel(role, codexHome), expected, `team ${role}`);
      if (table.includes(`| \`${role}\` |`)) {
        assert.match(table, new RegExp(`\\| \`${role}\` \\| ${tierOf(role)} \\| \`${expected}\` \\|`), `table ${role}`);
      }
    }
    assert.match(table, /\| Leader\/main session \| config\.toml root \| `root-model` \| high \|/);
  });

  it("lets agentModels.architect override only architect", async () => {
    await writeOmxConfig({ env: ENV_ONLY, agentModels: { architect: "architect-override" } });
    for (const role of ALL_ROLES) {
      const expected = role === "architect"
        ? "architect-override"
        : expectedFor(role, { frontier: "frontier-env", standard: "standard-env", spark: "spark-env" });
      assert.equal(nativeModel(role), expected, `native ${role}`);
      assert.equal(resolveAgentDefaultModel(role, codexHome), expected, `team ${role}`);
    }
  });

  it("gives the Team fallback the same results as native TOML with env and with defaults", async () => {
    for (const config of [{ env: ENV_ONLY }, {}]) {
      await writeOmxConfig(config);
      for (const role of ALL_ROLES) {
        assert.equal(resolveAgentDefaultModel(role, codexHome), nativeModel(role), role);
      }
    }
  });

  it("renders the same model per role in the AGENTS.md model table", async () => {
    for (const config of [{ env: ENV_ONLY }, {}]) {
      await writeOmxConfig(config);
      const context = resolveAgentsModelTableContext("", { codexHomeOverride: codexHome });
      const table = buildAgentsModelTable(context, undefined, { codexHomeOverride: codexHome });
      for (const role of ALL_ROLES) {
        const model = nativeModel(role);
        if (!table.includes(`| \`${role}\` |`)) continue; // non-installable roles are not listed
        assert.match(table, new RegExp(`\\| \`${role}\` \\| ${tierOf(role)} \\| \`${model}\` \\|`), role);
      }
    }
  });

  it("records the same model in instruction resolved_model metadata", async () => {
    await writeOmxConfig({ env: ENV_ONLY });
    const toml = generateAgentToml(AGENT_DEFINITIONS.executor, "prompt", { codexHomeOverride: codexHome });
    assert.match(toml, /resolved_model: standard-env/);
  });
});
