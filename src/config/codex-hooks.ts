import { join } from "path";

export interface ManagedCodexHooksConfig {
  hooks: {
    SessionStart: Array<Record<string, unknown>>;
    PreToolUse: Array<Record<string, unknown>>;
    PostToolUse: Array<Record<string, unknown>>;
    UserPromptSubmit: Array<Record<string, unknown>>;
    Stop: Array<Record<string, unknown>>;
  };
}
function buildCommandHook(
  command: string,
  options: {
    matcher?: string;
    statusMessage?: string;
    timeout?: number;
  } = {},
): Record<string, unknown> {
  const hook = {
    type: "command",
    command,
    ...(options.statusMessage ? { statusMessage: options.statusMessage } : {}),
    ...(typeof options.timeout === "number" ? { timeout: options.timeout } : {}),
  };

  return {
    ...(options.matcher ? { matcher: options.matcher } : {}),
    hooks: [hook],
  };
}

export function buildManagedCodexHooksConfig(pkgRoot: string): ManagedCodexHooksConfig {
  const hookScript = join(pkgRoot, "dist", "scripts", "codex-native-hook.js");
  const command = `"${process.execPath || "node"}" "${hookScript}"`;

  return {
    hooks: {
      SessionStart: [
        buildCommandHook(command, {
          matcher: "startup|resume",
          statusMessage: "Loading OMX session context",
        }),
      ],
      PreToolUse: [
        buildCommandHook(command, {
          matcher: "Bash",
          statusMessage: "Running OMX Bash preflight",
        }),
      ],
      PostToolUse: [
        buildCommandHook(command, {
          matcher: "Bash",
          statusMessage: "Running OMX Bash review",
        }),
      ],
      UserPromptSubmit: [
        buildCommandHook(command, {
          statusMessage: "Applying OMX prompt routing",
        }),
      ],
      Stop: [
        buildCommandHook(command, {
          timeout: 30,
        }),
      ],
    },
  };
}
