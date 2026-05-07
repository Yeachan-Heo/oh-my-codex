import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildManagedCodexHooksConfig,
  getMissingManagedCodexHookEvents,
  mergeManagedCodexHooksConfig,
  removeManagedCodexHooks,
} from "../codex-hooks.js";

describe("codex hooks helpers", () => {

  it("uses the current JavaScript runtime for managed hook commands", () => {
    const config = buildManagedCodexHooksConfig("/repo");
    const command = (config.hooks.SessionStart[0] as { hooks?: Array<{ command?: string }> } | undefined)?.hooks?.[0]?.command;

    assert.equal(
      command,
      `"${process.execPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" "/repo/dist/scripts/codex-native-hook.js"`,
    );
  });
  it("merges managed wrappers without dropping user hooks", () => {
    const merged = JSON.parse(
      mergeManagedCodexHooksConfig(
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [
                  { type: "command", command: 'node "/old/dist/scripts/codex-native-hook.js"' },
                  { type: "command", command: "echo keep-me" },
                ],
              },
              {
                hooks: [{ type: "command", command: "echo standalone-user" }],
              },
            ],
          },
        }),
        "/repo",
      ),
    ) as { hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };

    const sessionStart = merged.hooks.SessionStart;
    assert.equal(
      sessionStart.flatMap((entry) => entry.hooks ?? []).filter((hook) =>
        String(hook.command ?? "").includes("codex-native-hook.js")
      ).length,
      1,
    );
    assert.match(JSON.stringify(sessionStart), /echo keep-me/);
    assert.match(JSON.stringify(sessionStart), /echo standalone-user/);
    assert.doesNotMatch(JSON.stringify(sessionStart), /Loading OMX session context/);
  });

  it("removes only OMX-managed wrappers during uninstall cleanup", () => {
    const managedOnly = JSON.stringify(buildManagedCodexHooksConfig("/repo"));
    const preserved = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: 'node "/repo/dist/scripts/codex-native-hook.js"' },
              { type: "command", command: "echo keep-me" },
            ],
          },
        ],
      },
      version: 1,
    });

    const removedManagedOnly = removeManagedCodexHooks(managedOnly);
    assert.equal(removedManagedOnly.removedCount > 0, true);
    assert.equal(removedManagedOnly.nextContent, null);

    const removedMixed = removeManagedCodexHooks(preserved);
    assert.equal(removedMixed.removedCount, 1);
    assert.ok(removedMixed.nextContent);
    assert.match(removedMixed.nextContent, /echo keep-me/);
    assert.doesNotMatch(removedMixed.nextContent, /codex-native-hook\.js/);
    assert.match(removedMixed.nextContent, /"version": 1/);
  });

  it("reports missing managed hook coverage by event", () => {
    const missing = getMissingManagedCodexHookEvents(
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: "command", command: 'node "/repo/dist/scripts/codex-native-hook.js"' },
              ],
            },
          ],
          UserPromptSubmit: [
            {
              hooks: [
                { type: "command", command: "echo custom-only" },
              ],
            },
          ],
        },
      }),
    );

    assert.deepEqual(missing, ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"]);
  });

  it("returns null for invalid hooks.json content", () => {
    assert.equal(getMissingManagedCodexHookEvents("{ invalid json"), null);
  });
});
