import { join } from "path";
import { resolveRuntimeProvider, type RuntimeProvider } from "../runtime/provider.js";

export interface ManagedRuntimeHooksConfig {
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

function resolveHookScriptName(provider: RuntimeProvider): string {
  // Cursor currently reuses the same native bridge semantics as codex.
  // Keep a dedicated resolver so provider-specific hook scripts can be added
  // later without touching setup call sites.
  return provider === "cursor" ? "codex-native-hook.js" : "codex-native-hook.js";
}

export function buildManagedRuntimeHooksConfig(
  pkgRoot: string,
  provider: RuntimeProvider = resolveRuntimeProvider(),
): ManagedRuntimeHooksConfig {
  const hookScript = join(pkgRoot, "dist", "scripts", resolveHookScriptName(provider));
  const command = `node "${hookScript}"`;

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

export type ManagedCodexHooksConfig = ManagedRuntimeHooksConfig;

export function buildManagedCodexHooksConfig(
  pkgRoot: string,
): ManagedCodexHooksConfig {
  return buildManagedRuntimeHooksConfig(pkgRoot, "codex");
}
