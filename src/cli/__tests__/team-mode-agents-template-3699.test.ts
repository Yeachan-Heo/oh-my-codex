import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyTeamModeToAgentsTemplate } from "../setup.js";

const packagedTemplatePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "templates",
  "AGENTS.md",
);

async function renderTeamDisabledTemplate(): Promise<string> {
  const template = await readFile(packagedTemplatePath, "utf-8");
  return applyTeamModeToAgentsTemplate(template, "disabled");
}

describe("#3699 disabling Team keeps non-Team AGENTS.md guidance intact", () => {
  it("preserves the native subagent directive without the Team complement sentence", async () => {
    const disabled = await renderTeamDisabledTemplate();
    assert.match(
      disabled,
      /USE CODEX NATIVE SUBAGENTS FOR INDEPENDENT PARALLEL SUBTASKS WHEN THAT IMPROVES THROUGHPUT\./,
    );
    assert.doesNotMatch(disabled, /COMPLEMENTARY TO OMX TEAM MODE/i);
    assert.match(
      disabled,
      /- Within one Codex session, use Codex native subagents for independent, bounded subtasks/,
    );
  });

  it("preserves the child-agent limit rules line without the Team-runtime clause", async () => {
    const disabled = await renderTeamDisabledTemplate();
    assert.match(disabled, /Rules: max 6 concurrent child agents;/);
    assert.match(
      disabled,
      /Rules: max 6 concurrent child agents;[^\n]*prefer inherited model defaults unless a task has a concrete model reason\.\n/,
    );
    assert.doesNotMatch(disabled, /is a team-runtime surface/i);
  });

  it("does not leave malformed sentences behind after Team wording is removed", async () => {
    const disabled = await renderTeamDisabledTemplate();
    assert.match(
      disabled,
      /- Outside active `swarm` mode, use `executor` for bounded implementation or review slices/,
    );
    assert.doesNotMatch(disabled, /Outside active\/`swarm`/);
    assert.doesNotMatch(disabled, /^- Use when an approved plan/m);
    assert.doesNotMatch(disabled, /^-\s*$/m);
    assert.doesNotMatch(disabled, /\s,/);
  });

  it("removes every remaining Team-only instruction", async () => {
    const disabled = await renderTeamDisabledTemplate();
    assert.doesNotMatch(disabled, /team/i);
    assert.doesNotMatch(disabled, /### Team protocol/);
    assert.doesNotMatch(disabled, /\$team/);
  });

  it("keeps the enabled template byte-identical", async () => {
    const template = await readFile(packagedTemplatePath, "utf-8");
    assert.equal(applyTeamModeToAgentsTemplate(template, "enabled"), template);
  });
});
