import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

type CommandHook = {
  type?: string;
  command?: string;
  statusMessage?: string;
  timeout?: number;
  [key: string]: unknown;
};

type HookRegistration = {
  matcher?: string;
  hooks?: CommandHook[];
  [key: string]: unknown;
};

type HooksFile = {
  hooks?: Record<string, HookRegistration[]>;
  [key: string]: unknown;
};

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, "..", "..", "..");
  const omxBin = join(repoRoot, "dist", "cli", "omx.js");
  const resolvedHome = envOverrides.HOME ?? process.env.HOME;
  const result = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      ...(resolvedHome && !envOverrides.CODEX_HOME
        ? { CODEX_HOME: join(resolvedHome, ".codex") }
        : {}),
      ...envOverrides,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error?.message || "",
  };
}

function shouldSkipForSpawnPermissions(err: string): boolean {
  return typeof err === "string" && /(EPERM|EACCES)/i.test(err);
}

async function readHooksJson(filePath: string): Promise<HooksFile> {
  return JSON.parse(await readFile(filePath, "utf-8")) as HooksFile;
}

async function writeHooksJson(filePath: string, hooksFile: HooksFile): Promise<void> {
  await writeFile(filePath, JSON.stringify(hooksFile, null, 2) + "\n");
}

function makeUserCommandHook(command: string, matcher?: string): HookRegistration {
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [
      {
        type: "command",
        command,
        statusMessage: `user hook ${command}`,
      },
    ],
  };
}

function hookCommands(entries: HookRegistration[] | undefined): string[] {
  return (entries ?? [])
    .flatMap((entry) => entry.hooks ?? [])
    .map((hook) => hook.command)
    .filter((command): command is string => typeof command === "string");
}

function countManagedHooks(entries: HookRegistration[] | undefined): number {
  return hookCommands(entries).filter((command) => command.includes("codex-native-hook.js")).length;
}

function cloneRegistration(entry: HookRegistration): HookRegistration {
  return structuredClone(entry) as HookRegistration;
}

describe("omx setup/uninstall shared ownership for native hooks", () => {
  it("setup merges managed wrappers into an existing user-owned hooks.json", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-hooks-existing-user-file-"));
    try {
      const home = join(wd, "home");
      const codexDir = join(wd, ".codex");
      await mkdir(home, { recursive: true });
      await mkdir(codexDir, { recursive: true });

      const hooksPath = join(codexDir, "hooks.json");
      await writeHooksJson(hooksPath, {
        hooks: {
          SessionStart: [
            makeUserCommandHook('node "/custom/session-start.js"', "startup"),
          ],
          PostToolUse: [makeUserCommandHook('node "/custom/post-tool.js"')],
        },
      });

      const setupResult = runOmx(wd, ["setup", "--scope", "project"], {
        HOME: home,
      });
      if (shouldSkipForSpawnPermissions(setupResult.error)) return;
      assert.equal(setupResult.status, 0, setupResult.stderr || setupResult.stdout);

      const refreshed = await readHooksJson(hooksPath);
      assert.ok(
        hookCommands(refreshed.hooks?.SessionStart).includes(
          'node "/custom/session-start.js"',
        ),
        "setup should preserve pre-existing user SessionStart hooks",
      );
      assert.ok(
        hookCommands(refreshed.hooks?.PostToolUse).includes(
          'node "/custom/post-tool.js"',
        ),
        "setup should preserve pre-existing user PostToolUse hooks",
      );
      assert.equal(
        countManagedHooks(refreshed.hooks?.SessionStart),
        1,
        "setup should append the managed SessionStart wrapper into user-owned hooks.json",
      );
      assert.equal(
        countManagedHooks(refreshed.hooks?.PostToolUse),
        1,
        "setup should append the managed PostToolUse wrapper into user-owned hooks.json",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("setup preserves user hooks while deduping stale OMX wrappers", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-hooks-ownership-"));
    try {
      const home = join(wd, "home");
      await mkdir(home, { recursive: true });

      const initial = runOmx(wd, ["setup", "--scope", "project"], { HOME: home });
      if (shouldSkipForSpawnPermissions(initial.error)) return;
      assert.equal(initial.status, 0, initial.stderr || initial.stdout);

      const hooksPath = join(wd, ".codex", "hooks.json");
      const generated = await readHooksJson(hooksPath);
      const generatedSessionStart = generated.hooks?.SessionStart ?? [];
      assert.ok(generatedSessionStart.length > 0, "setup should generate managed SessionStart hooks");

      const staleManagedSessionStart = cloneRegistration(generatedSessionStart[0]!);
      if (staleManagedSessionStart.hooks?.[0]) {
        staleManagedSessionStart.hooks[0].command = 'node "/tmp/old/codex-native-hook.js"';
        staleManagedSessionStart.hooks[0].statusMessage = "stale omx wrapper";
      }

      await writeHooksJson(hooksPath, {
        ...generated,
        hooks: {
          ...(generated.hooks ?? {}),
          SessionStart: [
            makeUserCommandHook('node "/custom/session-start.js"', "startup"),
            staleManagedSessionStart,
            ...generatedSessionStart,
          ],
          PostToolUse: [
            ...(generated.hooks?.PostToolUse ?? []),
            makeUserCommandHook('node "/custom/post-tool.js"'),
          ],
        },
      });

      const refreshedSetup = runOmx(wd, ["setup", "--scope", "project"], { HOME: home });
      if (shouldSkipForSpawnPermissions(refreshedSetup.error)) return;
      assert.equal(refreshedSetup.status, 0, refreshedSetup.stderr || refreshedSetup.stdout);

      const refreshed = await readHooksJson(hooksPath);
      const sessionStartCommands = hookCommands(refreshed.hooks?.SessionStart);
      const postToolCommands = hookCommands(refreshed.hooks?.PostToolUse);

      assert.ok(
        sessionStartCommands.includes('node "/custom/session-start.js"'),
        "setup should preserve user SessionStart hooks",
      );
      assert.ok(
        postToolCommands.includes('node "/custom/post-tool.js"'),
        "setup should preserve user PostToolUse hooks",
      );
      assert.equal(
        countManagedHooks(refreshed.hooks?.SessionStart),
        1,
        "setup should leave a single managed SessionStart wrapper after refresh",
      );
      assert.equal(
        countManagedHooks(refreshed.hooks?.PostToolUse),
        1,
        "setup should keep the managed PostToolUse wrapper alongside user hooks",
      );
      assert.ok(
        hookCommands(refreshed.hooks?.UserPromptSubmit).some((command) => command.includes("codex-native-hook.js")),
        "setup should still register managed UserPromptSubmit hooks",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("uninstall removes only OMX-managed wrappers and preserves user hook content", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-uninstall-hooks-ownership-"));
    try {
      const home = join(wd, "home");
      await mkdir(home, { recursive: true });

      const initial = runOmx(wd, ["setup", "--scope", "project"], { HOME: home });
      if (shouldSkipForSpawnPermissions(initial.error)) return;
      assert.equal(initial.status, 0, initial.stderr || initial.stdout);

      const hooksPath = join(wd, ".codex", "hooks.json");
      const generated = await readHooksJson(hooksPath);

      await writeHooksJson(hooksPath, {
        ...generated,
        hooks: {
          ...(generated.hooks ?? {}),
          SessionStart: [
            makeUserCommandHook('node "/custom/session-start.js"', "startup"),
            ...(generated.hooks?.SessionStart ?? []),
          ],
          PostToolUse: [
            ...(generated.hooks?.PostToolUse ?? []),
            makeUserCommandHook('node "/custom/post-tool.js"'),
          ],
        },
      });

      const uninstall = runOmx(wd, ["uninstall"], { HOME: home });
      if (shouldSkipForSpawnPermissions(uninstall.error)) return;
      assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);

      assert.equal(existsSync(hooksPath), true, "uninstall should keep hooks.json when user hooks remain");
      const remaining = await readHooksJson(hooksPath);
      const allCommands = Object.values(remaining.hooks ?? {}).flatMap((entries) => hookCommands(entries));

      assert.ok(allCommands.includes('node "/custom/session-start.js"'));
      assert.ok(allCommands.includes('node "/custom/post-tool.js"'));
      assert.equal(
        allCommands.some((command) => command.includes("codex-native-hook.js")),
        false,
        "uninstall should strip only OMX-managed wrappers",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
