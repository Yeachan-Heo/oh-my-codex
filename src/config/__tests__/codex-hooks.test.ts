import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManagedCodexHookTrustState,
  buildManagedCodexHookTrustToml,
  buildManagedCodexHooksConfig,
  discoverCodexHookConfigPaths,
  dedupeCodexHookConfigPaths,
  getMissingManagedCodexHookEvents,
  hasUserCodexHooksAfterManagedRemoval,
  isRuntimeCodexHomeMirrorPath,
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

  it("uses portable node invocation for Windows managed hook commands", () => {
    const config = buildManagedCodexHooksConfig(
      "D:\\Program Files\\nvm\\v24.12.0\\node_modules\\oh-my-codex",
      { platform: "win32" },
    );
    const command = (config.hooks.SessionStart[0] as {
      hooks?: Array<{ command?: string }>;
    } | undefined)?.hooks?.[0]?.command;

    assert.equal(
      command,
      'node "D:\\Program Files\\nvm\\v24.12.0\\node_modules\\oh-my-codex\\dist\\scripts\\codex-native-hook.js"',
    );
    assert.doesNotMatch(command ?? "", /^"/, "the node launcher must not be a quoted absolute node.exe path");
    assert.match(command ?? "", /^node "[^"]*Program Files[^"]*codex-native-hook\.js"$/);
  });

  it("keeps Windows hook script paths quoted when they contain spaces", () => {
    const merged = JSON.parse(
      mergeManagedCodexHooksConfig(
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "echo keep-me" }],
              },
            ],
          },
        }),
        "D:\\Program Files\\nvm\\v24.12.0\\node_modules\\oh-my-codex",
        { platform: "win32" },
      ),
    ) as { hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };

    const commands = merged.hooks.PreToolUse
      .flatMap((entry) => entry.hooks ?? [])
      .map((hook) => hook.command);

    assert.ok(commands.includes("echo keep-me"));
    assert.ok(commands.includes(
      'node "D:\\Program Files\\nvm\\v24.12.0\\node_modules\\oh-my-codex\\dist\\scripts\\codex-native-hook.js"',
    ));
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

  it("builds trust state only for generated OMX hook handlers", () => {
    const state = buildManagedCodexHookTrustState("/home/me/.codex/hooks.json", "/repo");
    const keys = Object.keys(state).sort();

    assert.deepEqual(keys, [
      "/home/me/.codex/hooks.json:post_compact:0:0",
      "/home/me/.codex/hooks.json:post_tool_use:0:0",
      "/home/me/.codex/hooks.json:pre_compact:0:0",
      "/home/me/.codex/hooks.json:pre_tool_use:0:0",
      "/home/me/.codex/hooks.json:session_start:0:0",
      "/home/me/.codex/hooks.json:stop:0:0",
      "/home/me/.codex/hooks.json:user_prompt_submit:0:0",
    ]);
    for (const hookState of Object.values(state)) {
      assert.match(hookState.trusted_hash, /^sha256:[a-f0-9]{64}$/);
    }
  });

  it("matches Codex's normalized command hook hash identity", async () => {
    const state = buildManagedCodexHookTrustState("/hooks.json", "/repo");
    const command =
      `"${process.execPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" "/repo/dist/scripts/codex-native-hook.js"`;
    const expectedIdentity = {
      event_name: "pre_tool_use",
      hooks: [
        {
          async: false,
          command,
          timeout: 600,
          type: "command",
        },
      ],
      matcher: "Bash",
    };
    const canonical = JSON.stringify({
      event_name: expectedIdentity.event_name,
      hooks: expectedIdentity.hooks.map((hook) => ({
        async: hook.async,
        command: hook.command,
        timeout: hook.timeout,
        type: hook.type,
      })),
      matcher: expectedIdentity.matcher,
    });
    const { createHash } = await import("node:crypto");
    const expectedHash = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;

    assert.equal(state["/hooks.json:pre_tool_use:0:0"]?.trusted_hash, expectedHash);
  });

  it("serializes managed hook trust state as TOML tables for config.toml", () => {
    const toml = buildManagedCodexHookTrustToml("/hooks.json", "/repo");

    assert.ok(
      toml.includes('[hooks.state."/hooks.json:pre_tool_use:0:0"]'),
    );
    assert.match(toml, /^trusted_hash = "sha256:[a-f0-9]{64}"$/m);
    assert.doesNotMatch(toml, /echo keep-me/);
  });

  it("can preserve existing hook state when explicitly merging trust into hooks.json", () => {
    const merged = JSON.parse(
      mergeManagedCodexHooksConfig(
        JSON.stringify({
          hooks: {
            state: {
              "custom:/hooks.json:stop:0:0": {
                trusted_hash: "sha256:user",
                enabled: false,
              },
            },
            Stop: [
              {
                hooks: [{ type: "command", command: "echo user-stop" }],
              },
            ],
          },
        }),
        "/repo",
        "/hooks.json",
      ),
    ) as {
      hooks: {
        state: Record<string, { trusted_hash?: string; enabled?: boolean }>;
        Stop: Array<{ hooks?: Array<{ command?: string }> }>;
      };
    };

    assert.deepEqual(merged.hooks.state["custom:/hooks.json:stop:0:0"], {
      trusted_hash: "sha256:user",
      enabled: false,
    });
    assert.match(
      merged.hooks.state["/hooks.json:stop:0:0"]?.trusted_hash ?? "",
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.match(JSON.stringify(merged.hooks.Stop), /echo user-stop/);
  });

  it("keeps managed hook merge idempotent", () => {
    const first = mergeManagedCodexHooksConfig(null, "/repo", "/hooks.json");
    const second = mergeManagedCodexHooksConfig(first, "/repo", "/hooks.json");

    assert.equal(second, first);
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

  it("detects user hooks that remain after managed wrapper removal", () => {
    const managedOnly = JSON.stringify(buildManagedCodexHooksConfig("/repo"));
    const mixed = JSON.stringify({
      hooks: {
        state: {
          "custom:/hooks.json:stop:0:0": {
            trusted_hash: "sha256:user",
          },
        },
        SessionStart: [
          {
            hooks: [
              { type: "command", command: 'node "/repo/dist/scripts/codex-native-hook.js"' },
              { type: "command", command: "echo keep-me" },
            ],
          },
        ],
      },
    });
    const stateOnly = JSON.stringify({
      hooks: {
        state: {
          "custom:/hooks.json:stop:0:0": {
            trusted_hash: "sha256:user",
          },
        },
      },
    });

    assert.equal(hasUserCodexHooksAfterManagedRemoval(managedOnly), false);
    assert.equal(hasUserCodexHooksAfterManagedRemoval(mixed), true);
    assert.equal(hasUserCodexHooksAfterManagedRemoval(stateOnly), false);
  });

  it("registers managed compact hook wrappers", () => {
    const config = buildManagedCodexHooksConfig("/repo");
    assert.ok(config.hooks.PreCompact?.length);
    assert.ok(config.hooks.PostCompact?.length);
    const preCompact = config.hooks.PreCompact as Array<{ hooks?: Array<{ command?: string }> }>;
    const postCompact = config.hooks.PostCompact as Array<{ hooks?: Array<{ command?: string }> }>;
    const preCommand = preCompact[0]?.hooks?.[0]?.command;
    const postCommand = postCompact[0]?.hooks?.[0]?.command;
    assert.match(String(preCommand), /codex-native-hook\.js/);
    assert.match(String(postCommand), /codex-native-hook\.js/);
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

    assert.deepEqual(missing, ["PreToolUse", "PostToolUse", "UserPromptSubmit", "PreCompact", "PostCompact", "Stop"]);
  });

  it("returns null for invalid hooks.json content", () => {
    assert.equal(getMissingManagedCodexHookEvents("{ invalid json"), null);
  });

  it("ignores runtime codex-home hook mirrors before hook loading", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-hook-dedupe-"));
    try {
      const canonicalPath = join(cwd, ".codex", "hooks.json");
      const mirrorPath = join(cwd, ".omx", "runtime", "codex-home", "session-1", "hooks.json");
      await mkdir(join(cwd, ".codex"), { recursive: true });
      await mkdir(join(cwd, ".omx", "runtime", "codex-home", "session-1"), { recursive: true });
      await writeFile(canonicalPath, JSON.stringify(buildManagedCodexHooksConfig("/repo")));
      await symlink(canonicalPath, mirrorPath);

      assert.equal(isRuntimeCodexHomeMirrorPath(mirrorPath, cwd), true);

      const result = await dedupeCodexHookConfigPaths([canonicalPath, mirrorPath], cwd);
      assert.deepEqual(result.paths.map((entry) => entry.path), [canonicalPath]);
      assert.deepEqual(result.skipped.map((entry) => entry.reason), ["runtime_codex_home_mirror"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("de-dupes hook config paths by realpath outside runtime mirrors", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-hook-realpath-dedupe-"));
    try {
      const canonicalPath = join(cwd, ".codex", "hooks.json");
      const aliasPath = join(cwd, "alias-hooks.json");
      await mkdir(join(cwd, ".codex"), { recursive: true });
      await writeFile(canonicalPath, JSON.stringify(buildManagedCodexHooksConfig("/repo")));
      await symlink(canonicalPath, aliasPath);

      const result = await dedupeCodexHookConfigPaths([canonicalPath, aliasPath], cwd);
      assert.deepEqual(result.paths.map((entry) => entry.path), [canonicalPath]);
      assert.deepEqual(result.skipped.map((entry) => entry.reason), ["duplicate_realpath"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("discovers canonical hook configs while skipping runtime codex-home mirrors", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-hook-discover-"));
    try {
      const canonicalPath = join(cwd, ".codex", "hooks.json");
      const mirrorPath = join(cwd, ".omx", "runtime", "codex-home", "session-1", "hooks.json");
      await mkdir(join(cwd, ".codex"), { recursive: true });
      await mkdir(join(cwd, ".omx", "runtime", "codex-home", "session-1"), { recursive: true });
      await writeFile(canonicalPath, JSON.stringify(buildManagedCodexHooksConfig("/repo")));
      await writeFile(mirrorPath, JSON.stringify(buildManagedCodexHooksConfig("/repo")));

      const result = await discoverCodexHookConfigPaths(cwd);

      assert.deepEqual(result.paths.map((entry) => entry.path), [canonicalPath]);
      assert.deepEqual(result.skipped.map((entry) => entry.path), [mirrorPath]);
      assert.deepEqual(result.skipped.map((entry) => entry.reason), ["runtime_codex_home_mirror"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
