import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildManagedCodexNativeHookCommand,
  buildManagedCodexNativeHookWindowsShimContent,
  buildManagedCodexNativeHookWindowsShimPath,
  classifyManagedCodexNativeHookWindowsShimOwnership,
  buildManagedCodexHookTrustState,
  buildManagedCodexHookTrustToml,
  buildManagedCodexHooksConfig,
  extractCodexHooksJsonTrustState,
  hasCodexHooksJsonTopLevelState,
  discoverCodexHookConfigPaths,
  dedupeCodexHookConfigPaths,
  getMissingManagedCodexHookEvents,
  hasUserCodexHooksAfterManagedRemoval,
  isRuntimeCodexHomeMirrorPath,
  isManagedCodexHookCommand,
  mergeManagedCodexHooksConfig,
  removeManagedCodexHooks,
  resolveWindowsPowerShellPath,
  parseManagedCodexNativeHookWindowsShimCommand,
  ManagedCodexHooksPlanError,
  planManagedCodexHooksMerge,
  planManagedCodexHooksRemoval,
  scanManagedCodexHookTrustStateFromContent,
  validateCodexHooksConfigStrict,
} from "../codex-hooks.js";

describe("codex hooks helpers", () => {

  it("uses the current JavaScript runtime for managed hook commands", () => {
    const config = buildManagedCodexHooksConfig("/repo");
    const command = config.hooks.SessionStart[0]?.hooks[0]?.command;

    assert.equal(
      command,
      `"${process.execPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" "/repo/dist/scripts/codex-native-hook.js"`,
    );
  });

  it("registers SessionStart for startup, resume, and clear reset sources", () => {
    const config = buildManagedCodexHooksConfig("/repo");
    const sessionStart = config.hooks.SessionStart[0];

    assert.equal(sessionStart?.matcher, "startup|resume|clear");
    assert.match(
      sessionStart?.matcher ?? "",
      /(?:^|\|)clear(?:\||$)/,
      "Codex emits SessionStart source=clear after /clear replacement threads; OMX must keep beginning-of-session hooks active",
    );
    assert.match(
      sessionStart?.matcher ?? "",
      /(?:^|\|)startup(?:\||$)/,
      "fresh /new thread starts remain covered by Codex's startup SessionStart source",
    );
  });

  it("uses a PowerShell -Command-safe Windows shim command with single-quoted literals", () => {
    const config = buildManagedCodexHooksConfig(
      "D:\\Program Files\\nvm\\v24.12.0\\node_modules\\oh-my-codex",
      {
        platform: "win32",
        codexHomeDir: "C:\\Users\\Ada Lovelace\\.codex",
        env: { SystemRoot: "C:\\Windows" },
      },
    );
    const command = config.hooks.SessionStart[0]?.hooks[0]?.command;

    assert.equal(
      command,
      "& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File 'C:\\Users\\Ada Lovelace\\.codex\\hooks\\omx-native-hook-windows-shim.ps1'",
    );
    assert.doesNotMatch(command ?? "", /codex-native-hook\.js/);
    assert.doesNotMatch(command ?? "", /^"[A-Z]:\\/i);
    assert.doesNotMatch(command ?? "", /\\"/);
  });

  it("parses only managed Windows shim commands and returns their validated final path", () => {
    const shimPath = "C:\\Users\\Ada Lovelace\\.codex\\hooks\\omx-native-hook-windows-shim.ps1";
    const managed = `& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File '${shimPath}'`;

    assert.equal(parseManagedCodexNativeHookWindowsShimCommand(managed), shimPath);
    assert.equal(
      parseManagedCodexNativeHookWindowsShimCommand(
        `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${shimPath}"`,
      ),
      shimPath,
    );
    for (const command of [
      `${managed} -NoExit`,
      managed.replace("-ExecutionPolicy Bypass", "-ExecutionPolicy RemoteSigned"),
      managed.replace("omx-native-hook-windows-shim.ps1", "foreign-hook.ps1"),
      `${managed}; Write-Host modified`,
      managed.replace("& ", "'&' "),
    ]) {
      assert.equal(parseManagedCodexNativeHookWindowsShimCommand(command), null);
    }
  });

  it("accepts quoted POSIX and PowerShell path operators while rejecting unquoted operators", () => {
    const directCommand = buildManagedCodexNativeHookCommand(
      "/repo with spaces;|<> (fixture) $literal/O'Brien",
      { platform: "linux" },
    );
    const packageRoot = "D:\\Program Files\\O'Brien\\hook (fixture) $literal\\oh-my-codex";
    const codexHome = "C:\\Users\\O'Brien\\.codex (fixture) $literal";
    const shimPath = "C:\\Users\\O'Brien\\.codex (fixture) $literal\\hooks\\omx-native-hook-windows-shim.ps1";
    const windowsCommand = buildManagedCodexNativeHookCommand(packageRoot, {
      platform: "win32",
      codexHomeDir: codexHome,
      env: { SystemRoot: "C:\\Windows" },
    });

    assert.match(directCommand, /\\\$literal/);
    assert.equal(isManagedCodexHookCommand(directCommand), true);
    assert.equal(isManagedCodexHookCommand(windowsCommand), true);
    assert.equal(parseManagedCodexNativeHookWindowsShimCommand(windowsCommand), shimPath);
    assert.match(windowsCommand, /O''Brien/);
    assert.equal(
      isManagedCodexHookCommand(
        'node /repo/dist/scripts/codex-native-hook.js; Write-Host injected',
      ),
      false,
    );
  });

  it("owns only shell-static command spellings and keeps platform ownership exact", () => {
    const posixScript = "/repo/dist/scripts/codex-native-hook.js";
    const windowsScript = "C:\\repo\\DIST\\SCRIPTS\\CODEX-NATIVE-HOOK.JS";
    const shimPath = "C:\\Users\\Ada\\.codex\\hooks\\omx-native-hook-windows-shim.ps1";
    const managedWindowsShim = `& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File '${shimPath}'`;

    assert.equal(isManagedCodexHookCommand(`node '${posixScript}'`), true);
    assert.equal(isManagedCodexHookCommand(`C:\\Node\\NODE.EXE ${windowsScript}`), true);
    for (const command of [
      `node "$HOME${posixScript}"`,
      `node "$(printf /repo)/dist/scripts/codex-native-hook.js"`,
      "node /repo/*/dist/scripts/codex-native-hook.js",
      "node ~/repo/dist/scripts/codex-native-hook.js",
      "node /repo/{old,new}/dist/scripts/codex-native-hook.js",
      `node "${posixScript}"; :`,
    ]) {
      assert.equal(isManagedCodexHookCommand(command), false, command);
    }
    for (const command of [
      `& "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File '${shimPath}'`,
      `& "$([Environment]::GetFolderPath('Windows'))\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File '${shimPath}'`,
      `${managedWindowsShim}; Write-Host injected`,
    ]) {
      assert.equal(parseManagedCodexNativeHookWindowsShimCommand(command), null, command);
      assert.equal(isManagedCodexHookCommand(command), false, command);
    }

    const caseVariant = JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: `NODE ${posixScript}` }] }],
      },
    });
    const posix = planManagedCodexHooksRemoval(caseVariant, "/hooks.json", { platform: "linux" });
    const windows = planManagedCodexHooksRemoval(caseVariant, "C:\\Users\\Ada\\.codex\\hooks.json", { platform: "win32" });
    assert.equal(posix.ok, false);
    assert.equal(windows.ok, false);
    if (!windows.ok) assert.equal(windows.error.code, "ambiguous_managed_handler");
  });

  it("requires absolute, control-free POSIX OMX paths before ownership proof", () => {
    const historicalCommand = `node "/historical install/O'Brien/dist/scripts/codex-native-hook.js"`;
    const ownedSource = JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: historicalCommand }] }],
      },
    });
    const ownedMerge = planManagedCodexHooksMerge(ownedSource, "/repo", "/hooks.json", { platform: "linux" });
    const ownedRemoval = planManagedCodexHooksRemoval(ownedSource, "/hooks.json", { platform: "linux" });
    assert.equal(isManagedCodexHookCommand(historicalCommand), true);
    assert.equal(ownedMerge.ok, true);
    assert.equal(ownedRemoval.ok, true);
    if (ownedRemoval.ok) {
      assert.equal(ownedRemoval.removedCount, 1);
      assert.equal(ownedRemoval.finalContent, null);
    }

    const foreignCommand = "node ./foreign-hook.js";
    const foreignSource = JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: foreignCommand }] }],
      },
    });
    const foreignMerge = planManagedCodexHooksMerge(foreignSource, "/repo", "/hooks.json", { platform: "linux" });
    const foreignRemoval = planManagedCodexHooksRemoval(foreignSource, "/hooks.json", { platform: "linux" });
    assert.equal(foreignMerge.ok, true);
    assert.equal(foreignRemoval.ok, true);
    if (foreignMerge.ok) {
      assert.equal(foreignMerge.hasForeignHooks, true);
      assert.ok(foreignMerge.finalContent?.includes(foreignCommand));
    }
    if (foreignRemoval.ok) assert.equal(foreignRemoval.finalContent, foreignSource);

    const controlCodePoints = [
      ...Array.from({ length: 0x20 }, (_, codePoint) => codePoint),
      ...Array.from({ length: 0x21 }, (_, offset) => 0x7f + offset),
    ];
    const ambiguousCommands = [
      "node ./dist/scripts/codex-native-hook.js",
      "node dist/scripts/codex-native-hook.js",
      "node ../historical/dist/scripts/codex-native-hook.js",
      ...controlCodePoints.map(
        (codePoint) => `node "/historical/dist/scripts/codex-native-hook.js${String.fromCodePoint(codePoint)}"`,
      ),
    ];
    for (const command of ambiguousCommands) {
      const source = JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command }] }],
        },
      });
      const merge = planManagedCodexHooksMerge(source, "/repo", "/hooks.json", { platform: "linux" });
      const removal = planManagedCodexHooksRemoval(source, "/hooks.json", { platform: "linux" });
      const context = JSON.stringify(command);
      assert.equal(isManagedCodexHookCommand(command), false, context);
      assert.equal(merge.ok, false, context);
      assert.equal(removal.ok, false, context);
      if (!merge.ok) {
        assert.equal(merge.error.code, "ambiguous_managed_handler", context);
        assert.equal("finalContent" in merge, false, context);
      }
      if (!removal.ok) {
        assert.equal(removal.error.code, "ambiguous_managed_handler", context);
        assert.equal("finalContent" in removal, false, context);
      }
    }
  });

  it("fails closed for decoded POSIX OMX spellings across command fields", () => {
    const exactEscapedCommand = String.raw`node /repo/dist/scripts/codex-native-ho\ok.js`;
    assert.equal(isManagedCodexHookCommand(exactEscapedCommand), true);

    const decodedNonExactCommands = [
      ["escaped filename with extra argv", String.raw`node /repo/dist/scripts/codex-native-ho\ok.js --extra`],
      ["escaped filename with comment", String.raw`node /repo/dist/scripts/codex-native-ho\ok.js # retained comment`],
      ["backslash-newline filename split", "node /repo/dist/scripts/codex-native-ho\\\nok.js --extra"],
    ] as const;
    const commandFields = [
      ["command", (command: string) => ({ command })],
      ["commandWindows", (command: string) => ({
        command: 'node "/repo/dist/scripts/codex-native-hook.js"',
        commandWindows: command,
      })],
      ["command_windows", (command: string) => ({
        command: 'node "/repo/dist/scripts/codex-native-hook.js"',
        command_windows: command,
      })],
    ] as const;

    for (const [description, command] of decodedNonExactCommands) {
      for (const [field, commandFieldsForHandler] of commandFields) {
        const source = JSON.stringify({
          hooks: {
            PreToolUse: [{
              hooks: [{ type: "command", ...commandFieldsForHandler(command) }],
            }],
          },
        });
        const context = `${field}: ${description}`;
        const merge = planManagedCodexHooksMerge(source, "/repo", "/hooks.json", { platform: "linux" });
        const removal = planManagedCodexHooksRemoval(source, "/hooks.json", { platform: "linux" });

        assert.equal(isManagedCodexHookCommand(command), false, context);
        assert.equal(merge.ok, false, context);
        assert.equal(removal.ok, false, context);
        if (!merge.ok) {
          assert.equal(merge.error.code, "ambiguous_managed_handler", context);
          assert.equal("finalContent" in merge, false, context);
        }
        if (!removal.ok) {
          assert.equal(removal.error.code, "ambiguous_managed_handler", context);
          assert.equal("finalContent" in removal, false, context);
        }
      }
    }
  });

  it("owns only the exact current drive-less Windows shim command from supplied options", () => {
    const options = {
      platform: "win32" as const,
      codexHomeDir: "/fixture codex home",
      env: { SystemRoot: "C:\\Windows" },
    };
    const command = buildManagedCodexNativeHookCommand("/repo", options);
    const source = JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command }] }],
      },
    });
    const merge = planManagedCodexHooksMerge(source, "/repo", "/fixture codex home/hooks.json", options);
    const removal = planManagedCodexHooksRemoval(source, "/fixture codex home/hooks.json", options);
    assert.match(command, /-File '\\fixture codex home\\hooks\\omx-native-hook-windows-shim\.ps1'$/);
    assert.equal(isManagedCodexHookCommand(command), false);
    assert.equal(merge.ok, true);
    assert.equal(removal.ok, true);
    if (removal.ok) assert.equal(removal.finalContent, null);

    const altered = command.replace("\\fixture codex home\\", "\\foreign codex home\\");
    const alteredSource = JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: altered }] }],
      },
    });
    const alteredMerge = planManagedCodexHooksMerge(
      alteredSource,
      "/repo",
      "/fixture codex home/hooks.json",
      options,
    );
    const alteredRemoval = planManagedCodexHooksRemoval(
      alteredSource,
      "/fixture codex home/hooks.json",
      options,
    );
    assert.equal(alteredMerge.ok, false);
    assert.equal(alteredRemoval.ok, false);
    if (!alteredMerge.ok) assert.equal(alteredMerge.error.code, "ambiguous_managed_handler");
    if (!alteredRemoval.ok) assert.equal(alteredRemoval.error.code, "ambiguous_managed_handler");
  });

  it("owns only exact current host-joined Windows shim commands on non-Windows seams", () => {
    if (process.platform === "win32") return;
    const env = { SystemRoot: "C:\\Windows" };
    const fixtures = [
      {
        label: "supplied codex home",
        options: { platform: "win32" as const, codexHomeDir: "/fixture codex home", env },
        hooksPath: "/fixture codex home/hooks.json",
        codexHomeDir: "/fixture codex home",
      },
      {
        label: "derived codex home",
        options: { platform: "win32" as const, env },
        hooksPath: "/derived codex home/hooks.json",
        codexHomeDir: "/derived codex home",
      },
    ];
    for (const { label, options, hooksPath, codexHomeDir } of fixtures) {
      const hostShimPath = join(codexHomeDir, "hooks", "omx-native-hook-windows-shim.ps1");
      const powerShellPath = resolveWindowsPowerShellPath(env);
      const command = `& '${powerShellPath}' -NoProfile -ExecutionPolicy Bypass -File '${hostShimPath}'`;
      const source = JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command }] }],
        },
      });
      const merge = planManagedCodexHooksMerge(source, "/repo", hooksPath, options);
      const removal = planManagedCodexHooksRemoval(source, hooksPath, options);
      assert.match(command, /\/hooks\/omx-native-hook-windows-shim\.ps1'$/);
      assert.equal(isManagedCodexHookCommand(command), false, label);
      assert.equal(merge.ok, true, label);
      assert.equal(removal.ok, true, label);
      if (removal.ok) assert.equal(removal.finalContent, null, label);

      const alteredShimPath = join("/foreign codex home", "hooks", "omx-native-hook-windows-shim.ps1");
      const altered = command.replace(hostShimPath, alteredShimPath);
      const alteredSource = JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: altered }] }],
        },
      });
      const alteredMerge = planManagedCodexHooksMerge(alteredSource, "/repo", hooksPath, options);
      const alteredRemoval = planManagedCodexHooksRemoval(alteredSource, hooksPath, options);
      assert.equal(alteredMerge.ok, false, label);
      assert.equal(alteredRemoval.ok, false, label);
      if (!alteredMerge.ok) assert.equal(alteredMerge.error.code, "ambiguous_managed_handler", label);
      if (!alteredRemoval.ok) assert.equal(alteredRemoval.error.code, "ambiguous_managed_handler", label);
    }
  });

  it("fails closed for Windows direct command expansion, quoting, wrappers, and invalid cross-fields", () => {
    const script = "C:\\repo\\dist\\scripts\\codex-native-hook.js";
    const direct = `node "${script}"`;
    const invalidDirectCommands = [
      `node "%OMX_ROOT%\\dist\\scripts\\codex-native-hook.js"`,
      `node "!OMX_ROOT!\\dist\\scripts\\codex-native-hook.js"`,
      `node "$(Get-Location)\\dist\\scripts\\codex-native-hook.js"`,
      `node '${script}'`,
      `node "${script}`,
      `node "${script}\\"`,
      `${direct} & echo injected`,
      `${direct} ^& echo injected`,
      `${direct} --extra`,
      `cmd.exe /d /c ${direct}`,
      `${direct}\r\necho injected`,
      `node ".\\dist\\scripts\\codex-native-hook.js"`,
      `node "C:historical\\dist\\scripts\\codex-native-hook.js"`,
    ];
    const crossFieldHandlers = [
      { command: `node '${script}'`, commandWindows: direct },
      { command: direct, command_windows: `node '${script}'` },
      {
        command: 'node "/repo/dist/scripts/codex-native-hook.js"',
        commandWindows: "node '/repo/dist/scripts/codex-native-hook.js'",
      },
    ];
    const cases = [
      ...invalidDirectCommands.map((command) => ({
        handler: { command },
        options: { platform: "win32" as const },
      })),
      {
        handler: crossFieldHandlers[0]!,
        options: { platform: "win32" as const },
      },
      {
        handler: crossFieldHandlers[1]!,
        options: { platform: "win32" as const },
      },
      {
        handler: crossFieldHandlers[2]!,
        options: { platform: "linux" as const },
      },
    ];

    for (const { handler, options } of cases) {
      const source = JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", ...handler }] }],
        },
      });
      const merge = planManagedCodexHooksMerge(source, "C:\\repo", "C:\\Users\\Ada\\.codex\\hooks.json", options);
      const removal = planManagedCodexHooksRemoval(source, "C:\\Users\\Ada\\.codex\\hooks.json", options);
      assert.equal(merge.ok, false, source);
      assert.equal(removal.ok, false, source);
      if (!merge.ok) {
        assert.equal(merge.error.code, "ambiguous_managed_handler", source);
        assert.equal("finalContent" in merge, false);
      }
      if (!removal.ok) {
        assert.equal(removal.error.code, "ambiguous_managed_handler", source);
        assert.equal("finalContent" in removal, false);
      }
    }

    const staticSpecialPath = `"C:\\Program Files (x86)\\node.exe" "C:\\Users\\O'Brien\\@scope & safe\\dist\\scripts\\codex-native-hook.js"`;
    assert.equal(isManagedCodexHookCommand(staticSpecialPath), true);

    const validCrossField = JSON.stringify({
      hooks: {
        PreToolUse: [{
          hooks: [{
            type: "command",
            command: 'node "/repo/dist/scripts/codex-native-hook.js"',
            commandWindows: direct,
          }],
        }],
      },
    });
    for (const platform of ["linux", "win32"] as const) {
      const pkgRoot = platform === "win32" ? "C:\\repo" : "/repo";
      const hooksPath = platform === "win32" ? "C:\\Users\\Ada\\.codex\\hooks.json" : "/hooks.json";
      const options = { platform };
      const merge = planManagedCodexHooksMerge(validCrossField, pkgRoot, hooksPath, options);
      const removal = planManagedCodexHooksRemoval(validCrossField, hooksPath, options);
      assert.equal(merge.ok, true, `${platform} must accept platform-specific managed command fields`);
      assert.equal(removal.ok, true, `${platform} must remove platform-specific managed command fields`);
    }
  });

  it("fails closed for unqualified direct executables and quoted PowerShell executable paths across command fields", () => {
    const posixScript = "/historical/dist/scripts/codex-native-hook.js";
    const windowsScript = "C:\\historical\\dist\\scripts\\codex-native-hook.js";
    const powerShellExecutable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const shimPath = "C:\\Users\\Ada\\.codex\\hooks\\omx-native-hook-windows-shim.ps1";
    const fallbackPosixCommand = `node "${posixScript}"`;
    const unsafeCommands = [
      ["POSIX dot-relative executable", `./node "${posixScript}"`, "linux"],
      ["POSIX parent-relative executable", `../node "${posixScript}"`, "linux"],
      ["POSIX relative executable", `tools/node "${posixScript}"`, "linux"],
      ["Windows dot-relative executable", `.\\node.exe "${windowsScript}"`, "win32"],
      ["Windows relative executable", `tools\\node.exe "${windowsScript}"`, "win32"],
      ["Windows drive-relative executable", `C:node.exe "${windowsScript}"`, "win32"],
      [
        "PowerShell dot-relative executable",
        `.\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File '${shimPath}'`,
        "win32",
      ],
      [
        "PowerShell relative executable",
        `tools\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File '${shimPath}'`,
        "win32",
      ],
      [
        "PowerShell drive-relative executable",
        `C:powershell.exe -NoProfile -ExecutionPolicy Bypass -File '${shimPath}'`,
        "win32",
      ],
      [
        "quoted PowerShell executable without call operator",
        `'${powerShellExecutable}' -NoProfile -ExecutionPolicy Bypass -File '${shimPath}'`,
        "win32",
      ],
    ] as const;

    const assertAmbiguous = (
      source: string,
      platform: "linux" | "win32",
      context: string,
    ) => {
      const pkgRoot = platform === "win32" ? "C:\\repo" : "/repo";
      const hooksPath = platform === "win32" ? "C:\\Users\\Ada\\.codex\\hooks.json" : "/hooks.json";
      const merge = planManagedCodexHooksMerge(source, pkgRoot, hooksPath, { platform });
      const removal = planManagedCodexHooksRemoval(source, hooksPath, { platform });
      assert.equal(merge.ok, false, context);
      assert.equal(removal.ok, false, context);
      if (!merge.ok) {
        assert.equal(merge.error.code, "ambiguous_managed_handler", context);
        assert.equal("finalContent" in merge, false, context);
      }
      if (!removal.ok) {
        assert.equal(removal.error.code, "ambiguous_managed_handler", context);
        assert.equal("finalContent" in removal, false, context);
      }
    };

    for (const [spelling, unsafeCommand, primaryPlatform] of unsafeCommands) {
      assert.equal(isManagedCodexHookCommand(unsafeCommand), false, spelling);
      assertAmbiguous(
        JSON.stringify({
          hooks: {
            PreToolUse: [{ hooks: [{ type: "command", command: unsafeCommand }] }],
          },
        }),
        primaryPlatform,
        `${spelling} in command`,
      );
      for (const [field, handler] of [
        ["commandWindows", { command: fallbackPosixCommand, commandWindows: unsafeCommand }],
        ["command_windows", { command: fallbackPosixCommand, command_windows: unsafeCommand }],
      ] as const) {
        assertAmbiguous(
          JSON.stringify({
            hooks: {
              PreToolUse: [{ hooks: [{ type: "command", ...handler }] }],
            },
          }),
          "win32",
          `${spelling} in ${field}`,
        );
      }
    }
  });

  it("fails closed for Windows direct-node and PowerShell shim quote concatenation across command fields", () => {
    const posixScript = "/repo/dist/scripts/codex-native-hook.js";
    const windowsScript = "C:\\repo\\dist\\scripts\\codex-native-hook.js";
    const shimPath = "C:\\Users\\Ada\\.codex\\hooks\\omx-native-hook-windows-shim.ps1";
    const shimPrefix = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File";
    const malformedCommands = [
      ["direct doubled", `node "C:\\repo\\dist\\scripts\\codex""-native-hook.js"`],
      ["direct adjacent", `node ""${windowsScript}""`],
      ["direct triple", `node """${windowsScript}"""`],
      ["shim doubled", `${shimPrefix} "C:\\Users\\Ada\\.codex\\hooks\\omx""-native-hook-windows-shim.ps1"`],
      ["shim adjacent", `${shimPrefix} ""${shimPath}""`],
      ["shim triple", `${shimPrefix} """${shimPath}"""`],
    ] as const;

    for (const [spelling, malformed] of malformedCommands) {
      for (const [field, handler] of [
        ["command", { command: malformed }],
        ["commandWindows", { command: `node "${posixScript}"`, commandWindows: malformed }],
        ["command_windows", { command: `node "${posixScript}"`, command_windows: malformed }],
      ] as const) {
        const source = JSON.stringify({
          hooks: {
            PreToolUse: [{ hooks: [{ type: "command", ...handler }] }],
          },
        });
        const context = `${spelling} in ${field}: ${source}`;
        const merge = planManagedCodexHooksMerge(
          source,
          "C:\\repo",
          "C:\\Users\\Ada\\.codex\\hooks.json",
          { platform: "win32" },
        );
        const removal = planManagedCodexHooksRemoval(
          source,
          "C:\\Users\\Ada\\.codex\\hooks.json",
          { platform: "win32" },
        );

        assert.equal(merge.ok, false, context);
        assert.equal(removal.ok, false, context);
        if (!merge.ok) {
          assert.equal(merge.error.code, "ambiguous_managed_handler", context);
          assert.equal("finalContent" in merge, false, context);
        }
        if (!removal.ok) {
          assert.equal(removal.error.code, "ambiguous_managed_handler", context);
          assert.equal("finalContent" in removal, false, context);
        }
      }
    }
  });

  it("fails closed for invalid Windows path syntax in direct and PowerShell commands", () => {
    const posixCommand = 'node "/repo/dist/scripts/codex-native-hook.js"';
    const directExecutable = "C:\\base\\node.exe";
    const directScript = "C:\\base\\dist\\scripts\\codex-native-hook.js";
    const powerShellExecutable = "C:\\base\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const shimPath = "C:\\base\\hooks\\omx-native-hook-windows-shim.ps1";
    const invalidWindowsPaths: Array<[string, (path: string) => string]> = [
      ["pipe", (path) => path.replace("\\base\\", "\\ba|se\\")],
      ["angle brackets", (path) => path.replace("\\base\\", "\\ba<>se\\")],
      ["wildcards", (path) => path.replace("\\base\\", "\\ba?*se\\")],
      ["embedded quote", (path) => path.replace("\\base\\", '\\ba\\"se\\')],
      ["control character", (path) => path.replace("\\base\\", "\\ba\u0000se\\")],
      ["alternate data stream", (path) => path.replace("\\base\\", "\\base:stream\\")],
      ["extended namespace", (path) => `\\\\?\\${path}`],
      ["device namespace", (path) => `\\\\.\\${path}`],
      ["NT device namespace", (path) => `\\Device\\HarddiskVolume2${path.slice(2)}`],
      ["DOS device name", (path) => path.replace("\\base\\", "\\NUL\\")],
      ["DOS COM device stem before extension", (path) => path.replace("\\base\\", "\\COM1 .cache\\")],
      ["DOS NUL device stem before extension", (path) => path.replace("\\base\\", "\\NUL .dir\\")],
      ["superscript COM device name", (path) => path.replace("\\base\\", "\\COM¹\\")],
      ["superscript LPT device name", (path) => path.replace("\\base\\", "\\LPT²\\")],
      ["trailing component period", (path) => path.replace("\\base\\", "\\base.\\")],
      ["trailing component space", (path) => path.replace("\\base\\", "\\base " + String.fromCharCode(92))],
    ];
    const invalidCommands = invalidWindowsPaths.flatMap(([syntax, invalidPath]) => [
      [`direct executable ${syntax}`, `"${invalidPath(directExecutable)}" "${directScript}"`],
      [`direct script ${syntax}`, `node "${invalidPath(directScript)}"`],
      [
        `PowerShell executable ${syntax}`,
        `& '${invalidPath(powerShellExecutable)}' -NoProfile -ExecutionPolicy Bypass -File '${shimPath}'`,
      ],
      [
        `PowerShell shim ${syntax}`,
        `& '${powerShellExecutable}' -NoProfile -ExecutionPolicy Bypass -File '${invalidPath(shimPath)}'`,
      ],
    ]);

    const validDirect = '"C:\\Program Files (x86)\\node.exe" "C:\\Users\\O\'Brien\\@scope & safe\\(fixture)\\dist\\scripts\\codex-native-hook.js"';
    const validUncDirect = '"\\\\server\\share\\node.exe" "\\\\server\\share\\repo\\dist\\scripts\\codex-native-hook.js"';
    const validShimPath = "C:\\Users\\O'Brien\\@scope & safe\\(fixture)\\.codex\\hooks\\omx-native-hook-windows-shim.ps1";
    const validPowerShell = "& 'C:\\Program Files (x86)\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File 'C:\\Users\\O''Brien\\@scope & safe\\(fixture)\\.codex\\hooks\\omx-native-hook-windows-shim.ps1'";
    const rootedPowerShell = "& '\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File '\\Users\\Ada\\.codex\\hooks\\omx-native-hook-windows-shim.ps1'";
    assert.equal(isManagedCodexHookCommand(validDirect), true);
    assert.equal(isManagedCodexHookCommand(validUncDirect), true);
    assert.equal(parseManagedCodexNativeHookWindowsShimCommand(validPowerShell), validShimPath);
    assert.equal(parseManagedCodexNativeHookWindowsShimCommand(rootedPowerShell), null);
    assert.equal(isManagedCodexHookCommand(rootedPowerShell), false);

    for (const [spelling, invalid] of invalidCommands) {
      assert.equal(isManagedCodexHookCommand(invalid), false, spelling);
      for (const [field, handler] of [
        ["command", { command: invalid }],
        ["commandWindows", { command: posixCommand, commandWindows: invalid }],
        ["command_windows", { command: posixCommand, command_windows: invalid }],
      ] as const) {
        const source = JSON.stringify({
          hooks: {
            PreToolUse: [{ hooks: [{ type: "command", ...handler }] }],
          },
        });
        const context = `${spelling} in ${field}: ${source}`;
        const merge = planManagedCodexHooksMerge(
          source,
          "C:\\repo",
          "C:\\Users\\Ada\\.codex\\hooks.json",
          { platform: "win32" },
        );
        const removal = planManagedCodexHooksRemoval(
          source,
          "C:\\Users\\Ada\\.codex\\hooks.json",
          { platform: "win32" },
        );

        assert.equal(merge.ok, false, context);
        assert.equal(removal.ok, false, context);
        if (!merge.ok) {
          assert.equal(merge.error.code, "ambiguous_managed_handler", context);
          assert.equal("finalContent" in merge, false, context);
        }
        if (!removal.ok) {
          assert.equal(removal.error.code, "ambiguous_managed_handler", context);
          assert.equal("finalContent" in removal, false, context);
        }
      }
    }
  });

  it("preserves compatible mixed matcher source and managed coordinates", () => {
    const matcherCases = [
      {
        eventName: "PreToolUse",
        eventLabel: "pre_tool_use",
        matcherSlice: '"matcher" : null',
      },
      {
        eventName: "SessionStart",
        eventLabel: "session_start",
        matcherSlice: String.raw`"matcher" : "\u0073tartup\u007cresume\u007cclear"`,
      },
    ] as const;

    for (const { eventName, eventLabel, matcherSlice } of matcherCases) {
      const source = String.raw`{"hooks":{"${eventName}":[{${matcherSlice},"hooks":[{"type":"command","command":"echo foreign"},{"type":"command","command":"node \"/old/dist/scripts/codex-native-hook.js\""}]}]}}`;
      const merged = planManagedCodexHooksMerge(source, "/repo", "/hooks.json");
      assert.equal(merged.ok, true, source);
      if (!merged.ok) continue;
      assert.equal(merged.coordinateProof.safe, true);
      assert.equal(merged.hasForeignHooks, true);
      assert.ok(merged.finalContent?.includes(matcherSlice));
      assert.ok(merged.finalTrustState[`/hooks.json:${eventLabel}:0:1`]);

      const removal = planManagedCodexHooksRemoval(merged.finalContent!, "/hooks.json");
      assert.equal(removal.ok, true, merged.finalContent ?? source);
      if (!removal.ok) continue;
      assert.equal(removal.coordinateProof.safe, true);
      assert.ok(removal.finalContent?.includes(matcherSlice));
      assert.match(removal.finalContent ?? "", /echo foreign/);
      assert.deepEqual(removal.finalTrustState, {});
    }
  });

  it("emits Windows hooks.json entries with only the cmd-compatible command field", () => {
    const config = buildManagedCodexHooksConfig(
      "D:\\Program Files\\nvm\\v24.12.0\\node_modules\\oh-my-codex",
      {
        platform: "win32",
        codexHomeDir: "C:\\Users\\Ada Lovelace\\.codex",
        env: { SystemRoot: "C:\\Windows" },
      },
    );
    const serialized = JSON.parse(JSON.stringify(config)) as {
      hooks?: Record<string, Array<{ hooks?: Array<Record<string, unknown>> }>>;
      state?: unknown;
    };
    const commandHook = serialized.hooks?.SessionStart?.[0]?.hooks?.[0];

    assert.equal(serialized.state, undefined);
    assert.equal(commandHook?.type, "command");
    assert.equal(commandHook?.commandWindows, undefined);
    assert.equal(commandHook?.command_windows, undefined);
    assert.equal(
      commandHook?.command,
      "& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File 'C:\\Users\\Ada Lovelace\\.codex\\hooks\\omx-native-hook-windows-shim.ps1'",
    );
  });

  it("derives the PowerShell path from windir when SystemRoot is absent", () => {
    const command = buildManagedCodexNativeHookCommand(
      "D:\\Program Files\\nvm\\v24.12.0\\node_modules\\oh-my-codex",
      {
        platform: "win32",
        codexHomeDir: "C:\\Users\\Ada Lovelace\\.codex",
        env: { windir: "E:\\WINNT" },
      },
    );

    assert.equal(
      command,
      "& 'E:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File 'C:\\Users\\Ada Lovelace\\.codex\\hooks\\omx-native-hook-windows-shim.ps1'",
    );
  });

  it("falls back to the default Windows install root when no env hints exist", () => {
    assert.equal(
      resolveWindowsPowerShellPath({}),
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("keeps Windows shim paths quoted when they contain spaces", () => {
    const merged = JSON.parse(
      mergeManagedCodexHooksConfig(
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: undefined,
                hooks: [{ type: "command", command: "echo keep-me" }],
              },
            ],
          },
        }),
        "D:\\Program Files\\nvm\\v24.12.0\\node_modules\\oh-my-codex",
        "C:\\Users\\Ada Lovelace\\.codex\\hooks.json",
        {
          platform: "win32",
          codexHomeDir: "C:\\Users\\Ada Lovelace\\.codex",
          env: { SystemRoot: "C:\\Windows" },
        },
      ),
    ) as { hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };

    const commands = merged.hooks.PreToolUse
      .flatMap((entry) => entry.hooks ?? [])
      .map((hook) => hook.command);

    assert.ok(commands.includes("echo keep-me"));
    assert.ok(commands.includes(
      "& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File 'C:\\Users\\Ada Lovelace\\.codex\\hooks\\omx-native-hook-windows-shim.ps1'",
    ));
  });

  it("builds deterministic Windows shim paths and PowerShell 5.1-compatible ProcessStartInfo content", () => {
    assert.equal(
      buildManagedCodexNativeHookWindowsShimPath("C:\\Users\\Ada Lovelace\\.codex"),
      "C:\\Users\\Ada Lovelace\\.codex\\hooks\\omx-native-hook-windows-shim.ps1",
    );

    const content = buildManagedCodexNativeHookWindowsShimContent(
      "D:\\Program Files\\O'Malley\\oh-my-codex",
      { nodePath: "C:\\Program Files\\nodejs\\node.exe" },
    );

    assert.doesNotMatch(content, /\[Console\]::In\.ReadToEnd\(\)/);
    assert.match(content, /\[System\.Diagnostics\.ProcessStartInfo\]::new\(\)/);
    assert.doesNotMatch(content, /ArgumentList/);
    assert.match(content, /\$startInfo\.UseShellExecute = \$false/);
    assert.match(content, /\$startInfo\.RedirectStandardInput = \$true/);
    assert.match(content, /\$startInfo\.RedirectStandardOutput = \$true/);
    assert.match(content, /\$startInfo\.RedirectStandardError = \$true/);
    assert.match(content, /OpenStandardInput\(\)\.CopyToAsync\(\$process\.StandardInput\.BaseStream\)/);
    assert.match(content, /\$process\.StandardOutput\.BaseStream\.CopyToAsync\(\[Console\]::OpenStandardOutput\(\)\)/);
    assert.match(content, /\$process\.StandardError\.BaseStream\.CopyToAsync\(\[Console\]::OpenStandardError\(\)\)/);
    assert.doesNotMatch(content, /\$process\.StandardInput\.Write\(/);
    assert.match(content, /exit \$process\.ExitCode/);
    assert.match(content, /\$startInfo\.FileName = 'C:\\Program Files\\nodejs\\node\.exe'/);
    assert.match(
      content,
      /\$startInfo\.Arguments = '"D:\\Program Files\\O''Malley\\oh-my-codex\\dist\\scripts\\codex-native-hook\.js"'/,
    );
  });

  it("prepends a UTF-8 BOM to the Windows shim so PowerShell 5.1 reads non-ASCII paths as UTF-8", () => {
    const content = buildManagedCodexNativeHookWindowsShimContent(
      "C:\\Users\\정찬\\깃헙\\oh-my-codex",
      { nodePath: "C:\\Program Files\\nodejs\\node.exe" },
    );

    assert.equal(content.charCodeAt(0), 0xfeff);
    assert.equal(content.codePointAt(0), 0xfeff);
    // BOM must precede the script body, not replace it.
    assert.equal(content.slice(1).startsWith("$ErrorActionPreference = 'Stop'"), true);
    // Non-ASCII install path is preserved verbatim in the emitted shim.
    assert.match(content, /정찬\\깃헙\\oh-my-codex/);

    const utf8 = Buffer.from(content, "utf-8");
    assert.deepEqual([...utf8.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  });

  it("classifies only byte-identical Windows shims as current and complete generated variants as historical", () => {
    const expected = Buffer.from(buildManagedCodexNativeHookWindowsShimContent(
      "C:\\Current Install\\oh-my-codex",
      {
        nodePath: "C:\\Current Node\\node.exe",
        hookScriptPath: "C:\\Current Install\\oh-my-codex\\dist\\scripts\\codex-native-hook.js",
      },
    ), "utf-8");
    const historical = Buffer.from(buildManagedCodexNativeHookWindowsShimContent(
      "C:\\Historical Install\\oh-my-codex",
      {
        nodePath: "D:\\Historical Node\\O'Malley\\node",
        hookScriptPath: "D:\\Historical Install\\O'Malley\\oh-my-codex\\dist\\scripts\\codex-native-hook.js",
      },
    ), "utf-8");

    assert.equal(
      classifyManagedCodexNativeHookWindowsShimOwnership(expected, expected),
      "current",
    );
    assert.equal(
      classifyManagedCodexNativeHookWindowsShimOwnership(historical, expected),
      "historical",
    );
  });

  it("requires qualified valid paths before recognizing historical Windows shim ownership", () => {
    const expected = Buffer.from(buildManagedCodexNativeHookWindowsShimContent(
      "C:\\Current Install\\oh-my-codex",
      {
        nodePath: "C:\\Current Node\\node.exe",
        hookScriptPath: "C:\\Current Install\\oh-my-codex\\dist\\scripts\\codex-native-hook.js",
      },
    ), "utf-8");
    const validNodePath = "D:\\Historical Node\\node.exe";
    const validHookScriptPath = "D:\\Historical Install\\oh-my-codex\\dist\\scripts\\codex-native-hook.js";
    const invalidHistoricalPaths = [
      { nodePath: "node.exe", hookScriptPath: validHookScriptPath },
      { nodePath: "D:node.exe", hookScriptPath: validHookScriptPath },
      { nodePath: ".\\node.exe", hookScriptPath: validHookScriptPath },
      { nodePath: "D:\\bad|node\\node.exe", hookScriptPath: validHookScriptPath },
      { nodePath: "D:\\bad\u0000node\\node.exe", hookScriptPath: validHookScriptPath },
      { nodePath: String.raw`\\?\D:\\Historical Node\\node.exe`, hookScriptPath: validHookScriptPath },
      { nodePath: String.raw`\Device\HarddiskVolume2\node.exe`, hookScriptPath: validHookScriptPath },
      { nodePath: "D:\\COM¹\\node.exe", hookScriptPath: validHookScriptPath },
      { nodePath: "D:\\LPT²\\node.exe", hookScriptPath: validHookScriptPath },
      { nodePath: "D:\\COM1 .cache\\node.exe", hookScriptPath: validHookScriptPath },
      { nodePath: "D:\\NUL .dir\\node.exe", hookScriptPath: validHookScriptPath },
      { nodePath: "D:\\Historical Node.\\node.exe", hookScriptPath: validHookScriptPath },
      { nodePath: "D:\\Historical Node \\node.exe", hookScriptPath: validHookScriptPath },
      { nodePath: validNodePath, hookScriptPath: ".\\dist\\scripts\\codex-native-hook.js" },
      { nodePath: validNodePath, hookScriptPath: "D:historical\\dist\\scripts\\codex-native-hook.js" },
      { nodePath: validNodePath, hookScriptPath: "D:\\bad?script\\dist\\scripts\\codex-native-hook.js" },
      { nodePath: validNodePath, hookScriptPath: "D:\\bad\u0000script\\dist\\scripts\\codex-native-hook.js" },
      { nodePath: validNodePath, hookScriptPath: String.raw`\\?\D:\\Historical Install\\dist\\scripts\\codex-native-hook.js` },
      { nodePath: validNodePath, hookScriptPath: String.raw`\Device\HarddiskVolume2\dist\scripts\codex-native-hook.js` },
      { nodePath: validNodePath, hookScriptPath: "D:\\Historical Install.\\dist\\scripts\\codex-native-hook.js" },
      { nodePath: validNodePath, hookScriptPath: "D:\\Historical Install \\dist\\scripts\\codex-native-hook.js" },
      { nodePath: validNodePath, hookScriptPath: "D:\\COM1 .cache\\dist\\scripts\\codex-native-hook.js" },
      { nodePath: validNodePath, hookScriptPath: "D:\\NUL .dir\\dist\\scripts\\codex-native-hook.js" },
    ];
    const uncHistorical = Buffer.from(buildManagedCodexNativeHookWindowsShimContent(
      "\\\\server\\share\\Historical Install\\oh-my-codex",
      {
        nodePath: "\\\\server\\share\\Node O'Brien\\node.exe",
        hookScriptPath: "\\\\server\\share\\Historical Install\\O'Brien\\oh-my-codex\\dist\\scripts\\codex-native-hook.js",
      },
    ), "utf-8");

    assert.equal(
      classifyManagedCodexNativeHookWindowsShimOwnership(uncHistorical, expected),
      "historical",
    );
    for (const paths of invalidHistoricalPaths) {
      const content = Buffer.from(buildManagedCodexNativeHookWindowsShimContent(
        "D:\\Historical Install\\oh-my-codex",
        paths,
      ), "utf-8");
      assert.equal(
        classifyManagedCodexNativeHookWindowsShimOwnership(content, expected),
        "modified",
        JSON.stringify(paths),
      );
    }
  });

  it("rejects incomplete, altered, encoding-ambiguous, and unverifiable Windows shim ownership", () => {
    const expected = Buffer.from(buildManagedCodexNativeHookWindowsShimContent(
      "C:\\Current Install\\oh-my-codex",
      {
        nodePath: "C:\\Current Node\\node.exe",
        hookScriptPath: "C:\\Current Install\\oh-my-codex\\dist\\scripts\\codex-native-hook.js",
      },
    ), "utf-8");
    const historical = Buffer.from(buildManagedCodexNativeHookWindowsShimContent(
      "C:\\Historical Install\\oh-my-codex",
      {
        nodePath: "D:\\Historical Node\\node.exe",
        hookScriptPath: "D:\\Historical Install\\oh-my-codex\\dist\\scripts\\codex-native-hook.js",
      },
    ), "utf-8");
    const modifiedFixedStatement = Buffer.from(historical.toString("utf-8").replace(
      "$process.WaitForExit()",
      "$process.WaitForExit(1)",
    ), "utf-8");
    const unverifiableNode = Buffer.from(historical.toString("utf-8").replace(
      "D:\\Historical Node\\node.exe",
      "D:\\Historical Node\\foreign.exe",
    ), "utf-8");
    const unverifiableHookScript = Buffer.from(historical.toString("utf-8").replace(
      "\\dist\\scripts\\codex-native-hook.js",
      "\\dist\\scripts\\foreign-hook.js",
    ), "utf-8");
    const invalidUtf8 = Buffer.from(historical);
    invalidUtf8[10] = 0xff;

    for (const candidate of [
      historical.subarray(3),
      historical.subarray(0, historical.length - 1),
      Buffer.concat([historical, Buffer.from("# extra\\n", "utf-8")]),
      modifiedFixedStatement,
      unverifiableNode,
      unverifiableHookScript,
      invalidUtf8,
    ]) {
      assert.equal(
        classifyManagedCodexNativeHookWindowsShimOwnership(candidate, expected),
        "modified",
      );
    }
  });

  it("forwards payload, stdout, stderr, and non-zero exit through the Windows shim when PowerShell is available", async () => {
    const shell = ["pwsh", "powershell.exe", "powershell"].find((candidate) => {
      const probe = spawnSync(candidate, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
        encoding: "utf-8",
      });
      return !probe.error && probe.status === 0;
    });
    if (!shell) return;

    const wd = await mkdtemp(join(tmpdir(), "omx-windows-hook-shim-"));
    try {
      const pkgRoot = join(wd, "pkg root");
      const hookPath = join(pkgRoot, "dist", "scripts", "codex-native-hook.js");
      await mkdir(join(pkgRoot, "dist", "scripts"), { recursive: true });
      await writeFile(
        hookPath,
        [
          "const chunks = [];",
          "process.stdin.on('data', (chunk) => chunks.push(chunk));",
          "process.stdin.on('end', () => {",
          "  const input = Buffer.concat(chunks).toString('utf8');",
          "  const parsed = JSON.parse(input);",
          "  process.stdout.write(`stdout:${parsed.last_user_message.length}:${parsed.last_user_message.slice(0, 2)}`);",
          "  process.stderr.write(`stderr:${parsed.last_user_message.slice(-6)}`);",
          "  process.exit(17);",
          "});",
          "",
        ].join("\n"),
      );
      const shimPath = join(wd, "shim.ps1");
      await writeFile(
        shimPath,
        buildManagedCodexNativeHookWindowsShimContent(pkgRoot, {
          hookScriptPath: hookPath,
          nodePath: process.execPath,
        }),
      );

      const result = spawnSync(
        shell,
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", shimPath],
        {
          input: JSON.stringify({
            hook_event_name: "Stop",
            last_user_message: "这是 oh-my-codex PowerShell shim 回归测试，用长中文多字节 stdin JSON 验证不会触发截断。".repeat(600),
          }),
          encoding: "utf-8",
          maxBuffer: 1024 * 1024 * 10,
        },
      );

      assert.equal(result.status, 17);
      const expectedMessage = "这是 oh-my-codex PowerShell shim 回归测试，用长中文多字节 stdin JSON 验证不会触发截断。".repeat(600);
      assert.equal(result.stdout, `stdout:${expectedMessage.length}:这是`);
      assert.equal(result.stderr, "stderr:会触发截断。");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("merges managed wrappers without dropping user hooks", () => {
    const merged = JSON.parse(
      mergeManagedCodexHooksConfig(
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                matcher: "startup|resume|clear",
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

  it("replaces existing managed groups in place without moving foreign groups", () => {
    const managed = buildManagedCodexHooksConfig("/repo");
    const original = JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "echo before" }] },
          {
            matcher: "startup|resume|clear",
            hooks: [
              { type: "command", command: 'node "/old/dist/scripts/codex-native-hook.js"' },
            ],
          },
          { hooks: [{ type: "command", command: "echo after" }] },
        ],
        PreToolUse: [
          { hooks: [{ type: "command", command: "echo pre-before" }] },
          managed.hooks.PreToolUse[0],
          { hooks: [{ type: "command", command: "echo pre-after" }] },
        ],
      },
    });

    const first = mergeManagedCodexHooksConfig(original, "/repo", "/hooks.json");
    const second = mergeManagedCodexHooksConfig(first, "/repo", "/hooks.json");
    const merged = JSON.parse(first) as {
      hooks: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
    };

    assert.equal(second, first);
    assert.deepEqual(
      merged.hooks.SessionStart.map((entry) => entry.hooks?.[0]?.command),
      [
        "echo before",
        managed.hooks.SessionStart[0]?.hooks[0]?.command,
        "echo after",
      ],
    );
    assert.deepEqual(
      merged.hooks.PreToolUse.map((entry) => entry.hooks?.[0]?.command),
      [
        "echo pre-before",
        managed.hooks.PreToolUse[0]?.hooks[0]?.command,
        "echo pre-after",
      ],
    );
  });

  it("appends missing managed groups without moving unrelated foreign groups", () => {
    const merged = JSON.parse(mergeManagedCodexHooksConfig(
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "echo first" }] },
            { hooks: [{ type: "command", command: "echo second" }] },
          ],
        },
      }),
      "/repo",
      "/hooks.json",
    )) as { hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };

    assert.deepEqual(
      merged.hooks.Stop.map((entry) => entry.hooks?.[0]?.command),
      [
        "echo first",
        "echo second",
        buildManagedCodexHooksConfig("/repo").hooks.Stop[0]?.hooks[0]?.command,
      ],
    );
  });

  it("derives managed trust keys from the final merged hook group layout", () => {
    const hooksPath = "/home/me/.codex/hooks.json";
    const hooksContent = mergeManagedCodexHooksConfig(
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: "command", command: "echo first" }] },
            { hooks: [{ type: "command", command: "echo second" }] },
          ],
          Stop: [
            { hooks: [{ type: "command", command: "echo keep" }] },
          ],
        },
      }),
      "/repo",
      hooksPath,
    );
    const state = buildManagedCodexHookTrustState(hooksPath, "/repo", {
      hooksContent,
    });

    assert.ok(state[`${hooksPath}:pre_tool_use:2:0`]);
    assert.ok(state[`${hooksPath}:stop:1:0`]);
    assert.equal(state[`${hooksPath}:pre_tool_use:0:0`], undefined);
    assert.equal(state[`${hooksPath}:stop:0:0`], undefined);
  });

  it("distinguishes an absent final hooks artifact from fallback and scanned content", () => {
    const hooksPath = "/home/me/.codex/hooks.json";
    const fallbackState = buildManagedCodexHookTrustState(hooksPath, "/repo");
    const fallbackToml = buildManagedCodexHookTrustToml(hooksPath, "/repo");
    const normalFinalContent = mergeManagedCodexHooksConfig(
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "echo foreign" }] }],
        },
      }),
      "/repo",
      hooksPath,
    );
    const normalState = buildManagedCodexHookTrustState(hooksPath, "/repo", {
      hooksContent: normalFinalContent,
    });
    const normalToml = buildManagedCodexHookTrustToml(hooksPath, "/repo", {
      hooksContent: normalFinalContent,
    });

    assert.deepEqual(buildManagedCodexHookTrustState(hooksPath, "/repo", { hooksContent: null }), {});
    assert.equal(buildManagedCodexHookTrustToml(hooksPath, "/repo", { hooksContent: null }), "");

    assert.deepEqual(
      buildManagedCodexHookTrustState(hooksPath, "/repo", { hooksContent: undefined }),
      fallbackState,
    );
    assert.equal(
      buildManagedCodexHookTrustToml(hooksPath, "/repo", { hooksContent: undefined }),
      fallbackToml,
    );

    assert.deepEqual(buildManagedCodexHookTrustState(hooksPath, "/repo", { hooksContent: "{}" }), {});
    assert.equal(buildManagedCodexHookTrustToml(hooksPath, "/repo", { hooksContent: "{}" }), "");

    assert.ok(normalState[`${hooksPath}:pre_tool_use:1:0`]);
    assert.equal(normalState[`${hooksPath}:pre_tool_use:0:0`], undefined);
    assert.ok(normalToml.includes(`[hooks.state."${hooksPath}:pre_tool_use:1:0"]`));
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
      matcher: undefined,
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

  it("matches Codex's normalized command hook hash identity for Windows shim commands", async () => {
    const hooksPath = "C:\\Users\\Ada Lovelace\\.codex\\hooks.json";
    const pkgRoot = "D:\\Program Files\\nvm\\v24.12.0\\node_modules\\oh-my-codex";
    const state = buildManagedCodexHookTrustState(hooksPath, pkgRoot, {
      platform: "win32",
      codexHomeDir: "C:\\Users\\Ada Lovelace\\.codex",
    });
    const command = buildManagedCodexNativeHookCommand(pkgRoot, {
      platform: "win32",
      codexHomeDir: "C:\\Users\\Ada Lovelace\\.codex",
    });
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
      matcher: undefined,
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

    assert.equal(state[`${hooksPath}:pre_tool_use:0:0`]?.trusted_hash, expectedHash);
  });

  it("hashes u64 timeout literals without losing values above Number.MAX_SAFE_INTEGER", async () => {
    const command = buildManagedCodexNativeHookCommand("/repo");
    const lower = "9007199254740992";
    const higher = "9007199254740993";
    const scanTimeout = (timeout: string) => scanManagedCodexHookTrustStateFromContent(
      `{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":${JSON.stringify(command)},"timeout":${timeout}}]}]}}`,
      "/hooks.json",
    );
    const lowerScan = scanTimeout(lower);
    const higherScan = scanTimeout(higher);
    assert.equal(lowerScan.ok, true);
    assert.equal(higherScan.ok, true);
    if (!lowerScan.ok || !higherScan.ok) return;

    const key = "/hooks.json:pre_tool_use:0:0";
    const lowerHash = lowerScan.trustState[key]?.trusted_hash;
    const higherHash = higherScan.trustState[key]?.trusted_hash;
    assert.notEqual(lowerHash, higherHash);
    const canonical = `{"event_name":"pre_tool_use","hooks":[{"async":false,"command":${JSON.stringify(command)},"timeout":${higher},"type":"command"}]}`;
    const { createHash } = await import("node:crypto");
    assert.equal(
      higherHash,
      `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
    );
  });

  it("serializes managed hook trust state as TOML tables for config.toml", () => {
    const toml = buildManagedCodexHookTrustToml("/hooks.json", "/repo");

    assert.ok(
      toml.includes('[hooks.state."/hooks.json:pre_tool_use:0:0"]'),
    );
    assert.match(toml, /^trusted_hash = "sha256:[a-f0-9]{64}"$/m);
    assert.doesNotMatch(toml, /echo keep-me/);
  });

  it("keeps hooks.json trust state out of Codex-facing output", () => {
    const merged = JSON.parse(
      mergeManagedCodexHooksConfig(
        JSON.stringify({
          state: {
            "custom:/hooks.json:prompt:0:0": {
              trusted_hash: "sha256:top-level-user",
              enabled: true,
            },
          },
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
      state?: Record<string, { trusted_hash?: string; enabled?: boolean }>;
      hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };

    assert.equal(Object.hasOwn(merged, "state"), false);
    assert.equal(Object.hasOwn(merged.hooks, "state"), false);
    assert.ok(
      Object.values(merged.hooks).every(Array.isArray),
      "Codex Rust hook discovery expects all hooks values to be event arrays",
    );
    assert.match(JSON.stringify(merged.hooks.Stop), /echo user-stop/);
  });

  it("extracts legacy hooks.json trust state for migration before merge", () => {
    const content = JSON.stringify({
      state: {
        "custom:/hooks.json:prompt:0:0": {
          trusted_hash: "sha256:top-level-user",
          enabled: true,
        },
      },
      hooks: {
        state: {
          "custom:/hooks.json:stop:0:0": {
            trusted_hash: "sha256:user",
            enabled: false,
          },
          malformed: { enabled: true },
        },
      },
    });

    assert.equal(hasCodexHooksJsonTopLevelState(content), true);
    assert.deepEqual(extractCodexHooksJsonTrustState(content), {
      "custom:/hooks.json:stop:0:0": {
        trusted_hash: "sha256:user",
        enabled: false,
      },
      "custom:/hooks.json:prompt:0:0": {
        trusted_hash: "sha256:top-level-user",
        enabled: true,
      },
    });
  });


  it("drops top-level managed hook state metadata from hooks.json", () => {
    const managedState = buildManagedCodexHookTrustState("/hooks.json", "/repo");
    const managedKey = Object.keys(managedState).find((key) =>
      key.includes(":stop:"),
    ) ?? Object.keys(managedState)[0];
    assert.ok(managedKey);

    const merged = JSON.parse(
      mergeManagedCodexHooksConfig(
        JSON.stringify({
          state: {
            [managedKey]: {
              trusted_hash: "sha256:old",
              enabled: false,
            },
          },
        }),
        "/repo",
        "/hooks.json",
      ),
    ) as {
      state?: Record<string, { trusted_hash?: string; enabled?: boolean }>;
      hooks: Record<string, unknown>;
    };

    assert.equal(Object.hasOwn(merged, "state"), false);
    assert.equal(Object.hasOwn(merged.hooks, "state"), false);
  });


  it("drops misplaced managed hook state metadata from hooks.json", () => {
    const managedState = buildManagedCodexHookTrustState("/hooks.json", "/repo");
    const managedKey = Object.keys(managedState).find((key) =>
      key.includes(":stop:"),
    ) ?? Object.keys(managedState)[0];
    assert.ok(managedKey);

    const merged = JSON.parse(
      mergeManagedCodexHooksConfig(
        JSON.stringify({
          hooks: {
            state: {
              [managedKey]: {
                trusted_hash: "sha256:old",
                enabled: false,
              },
            },
          },
        }),
        "/repo",
        "/hooks.json",
      ),
    ) as {
      state?: Record<string, { trusted_hash?: string; enabled?: boolean }>;
      hooks: Record<string, unknown>;
    };

    assert.equal(Object.hasOwn(merged, "state"), false);
    assert.equal(Object.hasOwn(merged.hooks, "state"), false);

    const exactNestedPlan = planManagedCodexHooksMerge(
      JSON.stringify({
        hooks: {
          state: {
            "custom:/hooks.json:stop:0:0": {
              trusted_hash: "sha256:legacy",
              enabled: false,
            },
          },
        },
      }),
      "/repo",
      "/hooks.json",
    );
    assert.equal(exactNestedPlan.ok, true);
    if (exactNestedPlan.ok) {
      assert.deepEqual(exactNestedPlan.legacyTrustState, {
        "custom:/hooks.json:stop:0:0": {
          trusted_hash: "sha256:legacy",
          enabled: false,
        },
      });
      const finalContent = exactNestedPlan.finalContent;
      assert.ok(finalContent);
      assert.equal(Object.hasOwn(JSON.parse(finalContent), "hooks"), true);
    }
  });


  it("keeps managed hook merge idempotent", () => {
    const first = mergeManagedCodexHooksConfig(null, "/repo", "/hooks.json");
    const second = mergeManagedCodexHooksConfig(first, "/repo", "/hooks.json");

    assert.equal(second, first);
  });

  it("keeps Windows shim hook merge idempotent while replacing stale direct-node wrappers", () => {
    const stale = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: "startup|resume|clear",
            hooks: [
              { type: "command", command: 'node "D:\\old\\dist\\scripts\\codex-native-hook.js"' },
              { type: "command", command: "echo keep-me" },
            ],
          },
          {
            hooks: [
              {
                type: "command",
                command: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\Ada\\.codex\\hooks\\omx-native-hook-windows-shim.ps1"',
              },
            ],
          },
        ],
      },
    });
    const options = {
      platform: "win32" as const,
      codexHomeDir: "C:\\Users\\Ada Lovelace\\.codex",
    };
    const first = mergeManagedCodexHooksConfig(
      stale,
      "D:\\Program Files\\nvm\\v24.12.0\\node_modules\\oh-my-codex",
      "C:\\Users\\Ada Lovelace\\.codex\\hooks.json",
      options,
    );
    const second = mergeManagedCodexHooksConfig(
      first,
      "D:\\Program Files\\nvm\\v24.12.0\\node_modules\\oh-my-codex",
      "C:\\Users\\Ada Lovelace\\.codex\\hooks.json",
      options,
    );

    assert.equal(second, first);
    const merged = JSON.parse(first) as {
      hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    const commands = merged.hooks.SessionStart.flatMap((entry) => entry.hooks ?? [])
      .map((hook) => hook.command ?? "");
    assert.equal(commands.filter((command) => /omx-native-hook-windows-shim\.ps1/.test(command)).length, 1);
    assert.equal(commands.filter((command) => /codex-native-hook\.js/.test(command)).length, 0);
    assert.ok(commands.includes("echo keep-me"));
  });

  it("removes only OMX-managed wrappers during uninstall cleanup", () => {
    const managedOnly = JSON.stringify(buildManagedCodexHooksConfig("/repo"));
    const preserved = JSON.stringify({
      hooks: {
        state: {
          "custom:/hooks.json:session_start:0:0": {
            trusted_hash: "sha256:user",
          },
        },
        SessionStart: [
          {
            matcher: "startup|resume|clear",
            hooks: [
              { type: "command", command: "echo keep-me" },
              { type: "command", command: 'node "/repo/dist/scripts/codex-native-hook.js"' },
            ],
          },
        ],
      },
    });

    const removedManagedOnly = removeManagedCodexHooks(managedOnly);
    assert.equal(removedManagedOnly.removedCount > 0, true);
    assert.equal(removedManagedOnly.nextContent, null);

    const generatedWithTrustState = mergeManagedCodexHooksConfig(
      null,
      "/repo",
      "/hooks.json",
    );
    const removedGeneratedWithTrustState = removeManagedCodexHooks(
      generatedWithTrustState,
    );
    assert.equal(removedGeneratedWithTrustState.removedCount > 0, true);
    assert.equal(removedGeneratedWithTrustState.nextContent, null);

    const removedMixed = removeManagedCodexHooks(preserved);
    assert.equal(removedMixed.removedCount, 1);
    assert.ok(removedMixed.nextContent);
    assert.match(removedMixed.nextContent, /echo keep-me/);
    assert.doesNotMatch(removedMixed.nextContent, /codex-native-hook\.js/);

    const cleaned = JSON.parse(removedMixed.nextContent) as {
      state?: Record<string, { trusted_hash?: string }>;
      hooks?: Record<string, unknown>;
    };
    assert.equal(Object.hasOwn(cleaned, "state"), false);
    assert.equal(Object.hasOwn(cleaned.hooks ?? {}, "state"), false);
  });

  for (const handler of [
    { type: "prompt", prompt: "Review the future event." },
    { type: "agent", prompt: "Handle the future event." },
  ]) {
    it(`preserves executable foreign future-event ${handler.type} handlers after managed removal`, () => {
      const futureEvent = [{
        matcher: "future-source",
        hooks: [handler],
      }];
      const source = JSON.stringify({
        hooks: {
          ...buildManagedCodexHooksConfig("/repo").hooks,
          FutureEvent: futureEvent,
        },
      });
      const plan = planManagedCodexHooksRemoval(source, "/hooks.json");

      assert.equal(plan.ok, true);
      if (!plan.ok) return;
      assert.equal(plan.hasForeignHooks, true);
      assert.ok(plan.finalContent);
      assert.deepEqual(
        (JSON.parse(plan.finalContent) as { hooks?: Record<string, unknown> }).hooks?.FutureEvent,
        futureEvent,
      );
      assert.equal(hasUserCodexHooksAfterManagedRemoval(source), true);
    });
  }

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
            matcher: "startup|resume|clear",
            hooks: [
              { type: "command", command: "echo keep-me" },
              { type: "command", command: 'node "/repo/dist/scripts/codex-native-hook.js"' },
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
    const preCommand = config.hooks.PreCompact[0]?.hooks[0]?.command;
    const postCommand = config.hooks.PostCompact[0]?.hooks[0]?.command;
    assert.match(String(preCommand), /codex-native-hook\.js/);
    assert.match(String(postCommand), /codex-native-hook\.js/);
    assert.equal(postCommand, preCommand);
    assert.doesNotMatch(String(postCommand), /PostCompact Nudge|additionalContext|printf/);
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
  it("models Codex empty/default/null load behavior without accepting async null", () => {
    const valid = validateCodexHooksConfigStrict(JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: null,
          hooks: [{
            type: "command",
            command: "echo foreign",
            commandWindows: null,
            timeout: 0,
            statusMessage: null,
          }],
        }],
      },
    }));
    assert.equal(validateCodexHooksConfigStrict("{}").ok, true);
    assert.equal(valid.ok, true);
    if (valid.ok) {
      assert.equal(valid.groupOccurrences[0]?.groupIndex, 0);
      assert.equal(valid.handlerOccurrences[0]?.handlerIndex, 0);
    }

    const invalid = validateCodexHooksConfigStrict(JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "echo", async: null }] }],
      },
    }));
    assert.equal(invalid.ok, false);
  });

  it("matches pinned serde_json strict intake for whitespace, Unicode, numbers, and nesting", () => {
    const validTimeoutPrefix = '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo","timeout":';
    for (const content of [
      "\uFEFF{}",
      "\v{}",
      "\f{}",
      "\u00a0{}",
      `${validTimeoutPrefix}1e400}]}]}}`,
      '{"hooks":{"PreToolUse":[{"matcher":"\\uD800","hooks":[{"type":"command","command":"echo"}]}]}}',
    ]) {
      assert.equal(validateCodexHooksConfigStrict(content).ok, false, JSON.stringify(content));
    }

    const withinSerdeDepth = `{"x":${"[".repeat(127)}0${"]".repeat(127)}}`;
    const beyondSerdeDepth = `{"x":${"[".repeat(128)}0${"]".repeat(128)}}`;
    const within = validateCodexHooksConfigStrict(withinSerdeDepth);
    const beyond = validateCodexHooksConfigStrict(beyondSerdeDepth);
    assert.equal(within.ok, false);
    assert.equal(beyond.ok, false);
    if (!within.ok) assert.match(within.error.message, /unknown root field x/);
    if (!beyond.ok) assert.match(beyond.error.message, /must contain a JSON object/);
  });

  it("uses the platform-effective Windows command before discovery and skipped-command diagnostics", () => {
    const withWindowsCommand = JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: " \t", commandWindows: "echo windows" }] }],
      },
    });
    const windows = validateCodexHooksConfigStrict(withWindowsCommand, { platform: "win32" });
    assert.equal(windows.ok, true);
    if (windows.ok) {
      assert.deepEqual(windows.discoveredCommands.map((entry) => entry.command), ["echo windows"]);
      assert.equal(windows.diagnostics.some((entry) => entry.code === "empty_command"), false);
    }

    const withWindowsAlias = JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "echo posix", command_windows: " \n" }] }],
      },
    });
    const windowsAlias = validateCodexHooksConfigStrict(withWindowsAlias, { platform: "win32" });
    const posix = validateCodexHooksConfigStrict(withWindowsAlias, { platform: "linux" });
    assert.equal(windowsAlias.ok, true);
    assert.equal(posix.ok, true);
    if (windowsAlias.ok) {
      assert.deepEqual(windowsAlias.discoveredCommands, []);
      assert.equal(windowsAlias.diagnostics.filter((entry) => entry.code === "empty_command").length, 1);
    }
    if (posix.ok) assert.deepEqual(posix.discoveredCommands.map((entry) => entry.command), ["echo posix"]);
  });

  it("accepts Codex's match-all matcher and treats whitespace-only commands as skipped", () => {
    const strict = validateCodexHooksConfigStrict(JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: "*",
          hooks: [
            { type: "command", command: " \t" },
            { type: "command", command: "echo discovered" },
          ],
        }],
      },
    }));
    assert.equal(strict.ok, true);
    if (!strict.ok) return;
    assert.equal(strict.diagnostics.some((entry) => entry.code === "invalid_matcher"), false);
    assert.equal(strict.diagnostics.filter((entry) => entry.code === "empty_command").length, 1);
    assert.deepEqual(strict.discoveredCommands.map((entry) => entry.command), ["echo discovered"]);

    const managed = buildManagedCodexNativeHookCommand("/repo");
    const plan = planManagedCodexHooksMerge(JSON.stringify({
      hooks: {
        PreToolUse: [{
          hooks: [
            { type: "command", command: managed },
            { type: "command", command: "\n\t " },
          ],
        }],
      },
    }), "/repo", "/hooks.json");
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.equal(plan.error.code, "ambiguous_managed_handler");
  });

  it("uses Rust-regex matcher syntax rather than accepting JavaScript-only assertions", () => {
    const validateMatcher = (matcher: string) => validateCodexHooksConfigStrict(JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher,
          hooks: [{ type: "command", command: "echo matcher" }],
        }],
      },
    }));

    for (const matcher of [
      "(?i)startup",
      "(?i:startup)",
      "(?-i)startup",
      "(?im-s:startup)",
      "(?x: start up)",
      "\\Astartup\\z",
      "\\a\\x41\\u{1F600}",
      "\\p{Greek}",
    ]) {
      const result = validateMatcher(matcher);
      assert.equal(result.ok, true, matcher);
      if (result.ok) {
        assert.equal(
          result.diagnostics.some((entry) => entry.code === "invalid_matcher"),
          false,
          matcher,
        );
      }
    }
    for (const matcher of [
      "(?=startup)startup",
      "(?<=start)up",
      "(startup)\\1",
      "\\q",
      "\\u0041",
      "\\x4",
      "\\p{}",
      "\\p{NotAUnicodeProperty}",
      "\\u{D800}",
      "\\u{DFFF}",
    ]) {
      const result = validateMatcher(matcher);
      assert.equal(result.ok, true, matcher);
      if (result.ok) {
        assert.equal(
          result.diagnostics.some((entry) => entry.code === "invalid_matcher"),
          true,
          matcher,
        );
      }
    }

  });

  it("preserves ignored nested events, nonmatching hooks.state, and unknown raw members", () => {
    const existing = `{"hooks":{"state":{"not":"legacy"},"Future":{"raw":[1,{"keep":true}]},"PreToolUse":[{"opaque":{"source" : [1, 2]},"hooks":[{"type":"command","command":"echo foreign","unknown":{"keep":true}}]}]}}`;
    const plan = planManagedCodexHooksMerge(existing, "/repo", "/hooks.json");

    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.ok(plan.finalContent?.includes(`"state":{"not":"legacy"}`));
    assert.ok(plan.finalContent?.includes(`"Future":{"raw":[1,{"keep":true}]}`));
    assert.ok(plan.finalContent?.includes(`"opaque":{"source" : [1, 2]}`));
    assert.ok(plan.finalContent?.includes(`"unknown":{"keep":true}`));
  });

  it("migrates only exact historical root state and fails closed for nonmatching root state", () => {
    const exact = planManagedCodexHooksMerge(JSON.stringify({
      state: {
        "/hooks.json:stop:0:0": { trusted_hash: "sha256:legacy", enabled: true },
      },
    }), "/repo", "/hooks.json");
    assert.equal(exact.ok, true);
    if (exact.ok) {
      assert.deepEqual(exact.legacyTrustState, {
        "/hooks.json:stop:0:0": { trusted_hash: "sha256:legacy", enabled: true },
      });
      assert.doesNotMatch(exact.finalContent ?? "", /"state"/);
    }

    const nonmatching = planManagedCodexHooksMerge(JSON.stringify({
      state: { "/hooks.json:stop:0:0": { trusted_hash: "sha256:legacy", extra: true } },
    }), "/repo", "/hooks.json");
    assert.equal(nonmatching.ok, false);
    if (!nonmatching.ok) assert.equal(nonmatching.error.code, "invalid_document");
  });

  it("preserves a legacy __proto__ trust key as an own migration entry", () => {
    const plan = planManagedCodexHooksMerge(
      '{"state":{"__proto__":{"trusted_hash":"sha256:legacy","enabled":true}}}',
      "/repo",
      "/hooks.json",
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(Object.hasOwn(plan.legacyTrustState, "__proto__"), true);
    assert.deepEqual(plan.legacyTrustState["__proto__"], {
      trusted_hash: "sha256:legacy",
      enabled: true,
    });
  });

  it("coalesces identical root and nested legacy trust state but rejects conflicts", () => {
    const key = "/hooks.json:stop:0:0";
    const matching = planManagedCodexHooksMerge(JSON.stringify({
      state: { [key]: { trusted_hash: "sha256:legacy", enabled: false } },
      hooks: {
        state: { [key]: { trusted_hash: "sha256:legacy", enabled: false } },
      },
    }), "/repo", "/hooks.json");
    assert.equal(matching.ok, true);
    if (matching.ok) {
      assert.deepEqual(matching.legacyTrustState, {
        [key]: { trusted_hash: "sha256:legacy", enabled: false },
      });
    }

    const conflicting = planManagedCodexHooksMerge(JSON.stringify({
      state: { [key]: { trusted_hash: "sha256:root", enabled: false } },
      hooks: {
        state: { [key]: { trusted_hash: "sha256:nested", enabled: false } },
      },
    }), "/repo", "/hooks.json");
    assert.equal(conflicting.ok, false);
    if (!conflicting.ok) {
      assert.equal(conflicting.error.code, "managed_trust_key_conflict");
      assert.equal("finalContent" in conflicting, false);
    }
  });

  it("coalesces every exact duplicate nested legacy state and rejects conflicting duplicates", () => {
    const key = "/hooks.json:stop:0:0";
    const identical = planManagedCodexHooksMerge(
      `{"hooks":{"state":{"${key}":{"trusted_hash":"sha256:legacy","enabled":true}},"state":{"${key}":{"trusted_hash":"sha256:legacy","enabled":true}}}}`,
      "/repo",
      "/hooks.json",
    );
    assert.equal(identical.ok, true);
    if (identical.ok) {
      assert.deepEqual(identical.legacyTrustState, {
        [key]: { trusted_hash: "sha256:legacy", enabled: true },
      });
      assert.doesNotMatch(identical.finalContent ?? "", /"state"/);
    }

    const conflicting = planManagedCodexHooksMerge(
      `{"hooks":{"state":{"${key}":{"trusted_hash":"sha256:first"}},"state":{"${key}":{"trusted_hash":"sha256:second"}}}}`,
      "/repo",
      "/hooks.json",
    );
    assert.equal(conflicting.ok, false);
    if (!conflicting.ok) assert.equal(conflicting.error.code, "managed_trust_key_conflict");

    const nonLegacyDuplicate = planManagedCodexHooksMerge(
      '{"hooks":{"state":{"not":"legacy"},"state":{"not":"legacy"}}}',
      "/repo",
      "/hooks.json",
    );
    assert.equal(nonLegacyDuplicate.ok, false);
    if (!nonLegacyDuplicate.ok) assert.equal(nonLegacyDuplicate.error.code, "invalid_document");
  });

  it("records every raw group and handler occurrence across all ten Codex events", () => {
    const events = [
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "SessionStart",
      "UserPromptSubmit",
      "SubagentStart",
      "SubagentStop",
      "Stop",
    ];
    const hooks = Object.fromEntries(events.map((eventName) => [eventName, [
      eventName === "PreToolUse" ? {} : { hooks: [] },
      {
        ...(eventName === "PreToolUse" ? { matcher: "(" } : {}),
        hooks: [
          { type: "prompt", prompt: "keep" },
          { type: "agent", prompt: "keep" },
          { type: "command", command: "", async: true },
        ],
      },
    ]]));
    const strict = validateCodexHooksConfigStrict(JSON.stringify({ hooks }));

    assert.equal(strict.ok, true);
    if (!strict.ok) return;
    assert.equal(strict.groupOccurrences.length, 20);
    assert.equal(strict.handlerOccurrences.length, 30);
    assert.equal(strict.discoveredCommands.length, 0);
    assert.equal(strict.diagnostics.filter((entry) => entry.code === "invalid_matcher").length, 1);
  });

  it("ignores UserPromptSubmit and Stop matchers for discovery while keeping their coordinates", () => {
    const existing = JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ matcher: "(", hooks: [{ type: "command", command: "echo prompt" }] }],
        Stop: [{ matcher: "(", hooks: [{ type: "command", command: "echo stop" }] }],
      },
    });
    const strict = validateCodexHooksConfigStrict(existing);
    assert.equal(strict.ok, true);
    if (strict.ok) assert.equal(strict.diagnostics.some((entry) => entry.code === "invalid_matcher"), false);

    const plan = planManagedCodexHooksMerge(existing, "/repo", "/hooks.json");
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.ok(plan.finalTrustState["/hooks.json:user_prompt_submit:1:0"]);
    assert.ok(plan.finalTrustState["/hooks.json:stop:1:0"]);
  });

  it("appends each missing OMX event once and makes the third setup byte-identical", () => {
    const first = planManagedCodexHooksMerge("{}", "/repo", "/hooks.json");
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.deepEqual(first.diagnostics, []);
    const second = planManagedCodexHooksMerge(first.finalContent, "/repo", "/hooks.json");
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.changed, false);
    const finalContent = second.finalContent;
    assert.ok(finalContent);
    const merged = JSON.parse(finalContent) as { hooks?: Record<string, unknown[]> };
    assert.deepEqual(Object.keys(merged.hooks ?? {}).sort(), [
      "PostCompact",
      "PostToolUse",
      "PreCompact",
      "PreToolUse",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
  });

  it("replaces a compatible managed handler in place and scans trust from its actual coordinate", () => {
    const existing = String.raw`{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo before"}]},{"opaque":{"keep":[1,2]},"hooks":[{"type":"command","command":"node \"/old/dist/scripts/codex-native-hook.js\"","unknown":{"keep":true}}]},{"hooks":[{"type":"command","command":"echo after"}]}]}}`;
    const plan = planManagedCodexHooksMerge(existing, "/repo", "/hooks.json");

    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.ok(plan.finalContent?.includes(`"opaque":{"keep":[1,2]}`));
    assert.ok(plan.finalContent?.includes(`"unknown":{"keep":true}`));
    assert.ok(plan.finalTrustState["/hooks.json:pre_tool_use:1:0"]);
    const finalContent = plan.finalContent;
    assert.ok(finalContent);
    const scan = scanManagedCodexHookTrustStateFromContent(finalContent, "/hooks.json");
    assert.equal(scan.ok, true);
    if (scan.ok) assert.deepEqual(scan.trustState, plan.finalTrustState);
  });

  it("fails closed instead of leaving an opaque managed-only group tombstone during removal", () => {
    const command = buildManagedCodexHooksConfig("/repo").hooks.PreToolUse[0]!.hooks[0]!.command;
    const source = JSON.stringify({
      hooks: {
        PreToolUse: [{
          opaque: { preserve: "exactly" },
          hooks: [{ type: "command", command }],
        }],
      },
    });
    const original = source;
    const plan = planManagedCodexHooksRemoval(source, "/hooks.json");

    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.equal(plan.error.code, "unsafe_managed_removal");
    assert.deepEqual(plan.error.details, {
      shifted: {
        kind: "group",
        eventName: "PreToolUse",
        oldCoordinate: [0],
      },
    });
    assert.equal("finalContent" in plan, false);
    assert.equal(source, original);
  });

  it("fails closed instead of leaving an opaque duplicate group tombstone during cleanup", () => {
    const command = buildManagedCodexHooksConfig("/repo").hooks.PreToolUse[0]!.hooks[0]!.command;
    const source = JSON.stringify({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command }] },
          {
            opaque: { preserve: "exactly" },
            hooks: [{ type: "command", command }],
          },
        ],
      },
    });
    const original = source;
    const plan = planManagedCodexHooksMerge(source, "/repo", "/hooks.json");

    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.equal(plan.error.code, "unsafe_managed_removal");
    assert.deepEqual(plan.error.details, {
      shifted: {
        kind: "group",
        eventName: "PreToolUse",
        oldCoordinate: [1],
      },
    });
    assert.equal("finalContent" in plan, false);
    assert.equal(source, original);
  });

  it("removes a suffix duplicate only when all surviving foreign coordinates stay fixed", () => {
    const command = buildManagedCodexHooksConfig("/repo").hooks.SessionStart[0]?.hooks[0]?.command;
    const safe = JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "echo foreign" }] },
          { matcher: "startup|resume|clear", hooks: [{ type: "command", command }] },
          { matcher: "startup|resume|clear", hooks: [{ type: "command", command }] },
        ],
      },
    });
    const plan = planManagedCodexHooksMerge(safe, "/repo", "/hooks.json");
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    const finalContent = plan.finalContent;
    assert.ok(finalContent);
    const merged = JSON.parse(finalContent) as { hooks: { SessionStart: unknown[] } };
    assert.equal(merged.hooks.SessionStart.length, 2);
    assert.ok(plan.finalTrustState["/hooks.json:session_start:1:0"]);

    const unsafe = JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: "startup|resume|clear", hooks: [{ type: "command", command }] },
          { matcher: "startup|resume|clear", hooks: [{ type: "command", command }] },
          { hooks: [{ type: "command", command: "echo shifted" }] },
        ],
      },
    });
    const unsafePlan = planManagedCodexHooksMerge(unsafe, "/repo", "/hooks.json");
    assert.equal(unsafePlan.ok, false);
    if (!unsafePlan.ok) assert.equal(unsafePlan.error.code, "unsafe_managed_removal");
  });

  it("fails closed for unsafe mixed removal and partial-corrupt OMX commands", () => {
    const command = buildManagedCodexHooksConfig("/repo").hooks.SessionStart[0]?.hooks[0]?.command;
    const unsafeMixed = planManagedCodexHooksRemoval(JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: "startup|resume|clear",
          hooks: [
            { type: "command", command },
            { type: "command", command: "echo moved" },
          ],
        }],
      },
    }), "/hooks.json");
    assert.equal(unsafeMixed.ok, false);
    if (!unsafeMixed.ok) assert.equal(unsafeMixed.error.code, "unsafe_managed_removal");

    const partial = planManagedCodexHooksMerge(JSON.stringify({
      hooks: {
        PreToolUse: [{
          hooks: [{ type: "command", command: 'node "/repo/dist/scripts/codex-native-hook.js" --extra' }],
        }],
      },
    }), "/repo", "/hooks.json");
    assert.equal(partial.ok, false);
    if (!partial.ok) {
      assert.ok(partial.error instanceof ManagedCodexHooksPlanError);
      assert.equal(partial.error.code, "ambiguous_managed_handler");
      assert.ok(Array.isArray(partial.diagnostics));
    }

    const sharedSkipped = planManagedCodexHooksMerge(JSON.stringify({
      hooks: {
        PreToolUse: [{
          hooks: [
            { type: "command", command: buildManagedCodexHooksConfig("/repo").hooks.PreToolUse[0]?.hooks[0]?.command },
            { type: "command", command: "echo skipped", async: true },
          ],
        }],
      },
    }), "/repo", "/hooks.json");
    assert.equal(sharedSkipped.ok, false);
    if (!sharedSkipped.ok) assert.equal(sharedSkipped.error.code, "ambiguous_managed_handler");
  });
});
