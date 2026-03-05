import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const openclawIntegrationDoc = readFileSync(
  join(__dirname, "../../../docs/openclaw-integration.md"),
  "utf-8",
);
const configureNotificationsSkill = readFileSync(
  join(__dirname, "../../../skills/configure-notifications/SKILL.md"),
  "utf-8",
);

function extractJsonFenceContaining(content: string, needle: string): string {
  const matches = [...content.matchAll(/```json\n([\s\S]*?)\n```/g)];
  const found = matches.map((m) => m[1]).find((block) => block.includes(needle));
  assert.ok(found, `Expected a JSON code fence containing ${needle}`);
  return found;
}

describe("OpenClaw setup workflow contracts", () => {
  it("documents explicit /hooks/agent delivery verification path", () => {
    assert.ok(
      configureNotificationsSkill.includes("/hooks/agent"),
      "configure-notifications skill should include /hooks/agent guidance",
    );
    assert.ok(
      openclawIntegrationDoc.includes("/hooks/agent"),
      "openclaw integration doc should include /hooks/agent",
    );
  });

  it("keeps wake smoke test guidance alongside delivery verification", () => {
    assert.ok(
      configureNotificationsSkill.includes("/hooks/wake"),
      "configure-notifications skill should include /hooks/wake smoke test guidance",
    );
    assert.ok(
      openclawIntegrationDoc.includes("Wake smoke test (`/hooks/wake`)"),
      "openclaw integration doc should include /hooks/wake smoke test",
    );
  });

  it("includes pass/fail diagnostics guidance", () => {
    assert.ok(
      /Pass\/Fail Diagnostics/.test(openclawIntegrationDoc),
      "openclaw integration doc should include pass/fail diagnostics",
    );
    assert.ok(
      /Compatibility \+ precedence contract/.test(configureNotificationsSkill),
      "configure-notifications should include compatibility + precedence contract",
    );
  });

  it("includes token check, URL reachability check, and command dual env gate guidance", () => {
    assert.ok(
      openclawIntegrationDoc.includes("OMX_OPENCLAW_COMMAND=1"),
      "openclaw integration doc should mention command dual gate",
    );
    assert.ok(
      openclawIntegrationDoc.includes("token present"),
      "openclaw integration doc should include token preflight check",
    );
    assert.ok(
      openclawIntegrationDoc.includes("reachability"),
      "openclaw integration doc should include URL reachability checks",
    );
  });

  it("uses runtime schema examples with notifications.openclaw and generic alias keys", () => {
    assert.ok(
      configureNotificationsSkill.includes("custom_webhook_command"),
      "configure-notifications skill should reference custom_webhook_command",
    );
    assert.ok(
      configureNotificationsSkill.includes("custom_cli_command"),
      "configure-notifications skill should reference custom_cli_command",
    );

    const configJson = extractJsonFenceContaining(openclawIntegrationDoc, "\"notifications\"");
    const parsed = JSON.parse(configJson) as {
      notifications?: {
        openclaw?: {
          gateways?: Record<string, unknown>;
          hooks?: Record<string, unknown>;
        };
        custom_webhook_command?: Record<string, unknown>;
      };
    };

    assert.ok(parsed.notifications, "Doc example should include notifications block");
    assert.ok(
      parsed.notifications?.openclaw || parsed.notifications?.custom_webhook_command,
      "Doc example should include explicit openclaw schema or generic alias schema",
    );
  });

  it("documents deterministic precedence: explicit notifications.openclaw wins", () => {
    assert.ok(
      configureNotificationsSkill.includes("notifications.openclaw") &&
        configureNotificationsSkill.includes("wins"),
      "configure-notifications should document explicit openclaw precedence",
    );
    assert.ok(
      openclawIntegrationDoc.includes("notifications.openclaw") &&
        openclawIntegrationDoc.includes("wins"),
      "openclaw integration doc should document explicit openclaw precedence",
    );
  });

  it("documents clawdbot agent command workflow for OpenClaw command gateways", () => {
    assert.ok(
      configureNotificationsSkill.includes("clawdbot agent"),
      "configure-notifications should document clawdbot agent workflow",
    );
    assert.ok(
      openclawIntegrationDoc.includes("clawdbot agent"),
      "openclaw integration doc should document clawdbot agent workflow",
    );
    assert.ok(
      openclawIntegrationDoc.includes("#omc-dev"),
      "openclaw integration doc should include #omc-dev target example",
    );
  });

  it("documents dev runbook requirements: Korean output, tmux session tracing, and SOUL.md follow-up", () => {
    assert.ok(
      configureNotificationsSkill.includes("한국어"),
      "configure-notifications should include Korean output guidance for clawdbot agent workflow",
    );
    assert.ok(
      configureNotificationsSkill.includes("{{tmuxSession}}"),
      "configure-notifications should include tmuxSession template guidance",
    );
    assert.ok(
      configureNotificationsSkill.includes("SOUL.md"),
      "configure-notifications should include SOUL.md follow-up guidance",
    );
    assert.ok(
      openclawIntegrationDoc.includes("Dev Guide: OpenClaw + Clawdbot Agent"),
      "openclaw integration doc should include dedicated dev guide section",
    );
    assert.ok(
      openclawIntegrationDoc.includes("{{tmuxSession}}"),
      "openclaw integration doc should include tmuxSession tracing guidance",
    );
    assert.ok(
      openclawIntegrationDoc.includes("SOUL.md"),
      "openclaw integration doc should include SOUL.md follow-up guidance",
    );
  });
});
