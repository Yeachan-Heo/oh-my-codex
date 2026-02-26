/**
 * OpenClaw Gateway Dispatcher
 *
 * Sends instruction payloads to OpenClaw gateways via HTTP or CLI command.
 * All calls are non-blocking with timeouts. Failures are swallowed
 * to avoid blocking hooks.
 *
 * SECURITY: Command gateway requires OMX_OPENCLAW_COMMAND=1 opt-in.
 * Hard 5-second timeout (non-configurable). Prefers execFile for
 * simple commands; falls back to sh -c only for shell metacharacters.
 */

import type {
  OpenClawCommandGatewayConfig,
  OpenClawGatewayConfig,
  OpenClawHttpGatewayConfig,
  OpenClawPayload,
  OpenClawResult,
} from "./types.js";

/** Default per-request timeout for HTTP gateways */
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

/** Hard non-configurable timeout for command gateways */
const COMMAND_TIMEOUT_MS = 5_000;

/** Shell metacharacters that require sh -c instead of execFile */
const SHELL_METACHAR_RE = /[|&;><`$()]/;

/**
 * Validate gateway URL. Must be HTTPS, except localhost/127.0.0.1/::1
 * which allows HTTP for local development.
 */
export function validateGatewayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    if (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "::1" ||
        parsed.hostname === "[::1]")
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Interpolate template variables in an instruction string.
 *
 * Supported variables (from hook context):
 * - {{projectName}} - basename of project directory
 * - {{projectPath}} - full project directory path
 * - {{sessionId}} - session identifier
 * - {{prompt}} - prompt text
 * - {{contextSummary}} - context summary (session-end event)
 * - {{question}} - question text (ask-user-question event)
 * - {{timestamp}} - ISO timestamp
 * - {{event}} - hook event name
 * - {{instruction}} - interpolated instruction (for command gateway)
 *
 * Unresolved variables are left as-is (not replaced with empty string).
 */
export function interpolateInstruction(
  template: string,
  variables: Record<string, string | undefined>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return variables[key] ?? match;
  });
}

/**
 * Type guard: is this gateway config a command gateway?
 */
export function isCommandGateway(
  config: OpenClawGatewayConfig,
): config is OpenClawCommandGatewayConfig {
  return (config as OpenClawCommandGatewayConfig).type === "command";
}

/**
 * Shell-escape a string for safe embedding in a shell command.
 * Uses single-quote wrapping with internal quote escaping.
 */
export function shellEscapeArg(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Wake an HTTP-type OpenClaw gateway with the given payload.
 */
export async function wakeGateway(
  gatewayName: string,
  gatewayConfig: OpenClawHttpGatewayConfig,
  payload: OpenClawPayload,
): Promise<OpenClawResult> {
  if (!validateGatewayUrl(gatewayConfig.url)) {
    return {
      gateway: gatewayName,
      success: false,
      error: "Invalid URL (HTTPS required)",
    };
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...gatewayConfig.headers,
    };

    const timeout = gatewayConfig.timeout ?? DEFAULT_HTTP_TIMEOUT_MS;

    const response = await fetch(gatewayConfig.url, {
      method: gatewayConfig.method || "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      return {
        gateway: gatewayName,
        success: false,
        error: `HTTP ${response.status}`,
        statusCode: response.status,
      };
    }

    return { gateway: gatewayName, success: true, statusCode: response.status };
  } catch (error) {
    return {
      gateway: gatewayName,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Wake a command-type OpenClaw gateway by executing a shell command.
 *
 * SECURITY REQUIREMENTS:
 * - Requires OMX_OPENCLAW_COMMAND=1 opt-in (separate gate from OMX_OPENCLAW)
 * - Hard 5-second timeout (non-configurable)
 * - Prefers execFile for simple commands (no metacharacters)
 * - Falls back to sh -c only when metacharacters detected
 * - detached: false to prevent orphan processes
 * - SIGTERM cleanup handler kills child on parent SIGTERM, 1s grace then SIGKILL
 *
 * The command template supports {{variable}} placeholders. All variable
 * values are shell-escaped before interpolation to prevent injection.
 */
export async function wakeCommandGateway(
  gatewayName: string,
  gatewayConfig: OpenClawCommandGatewayConfig,
  variables: Record<string, string | undefined>,
): Promise<OpenClawResult> {
  // Separate command gateway opt-in gate
  if (process.env.OMX_OPENCLAW_COMMAND !== "1") {
    return {
      gateway: gatewayName,
      success: false,
      error: "Command gateway disabled (set OMX_OPENCLAW_COMMAND=1 to enable)",
    };
  }

  let child: import("child_process").ChildProcess | null = null;
  let sigtermHandler: (() => void) | null = null;

  try {
    const { execFile, exec } = await import("child_process");

    // Interpolate variables with shell escaping
    const interpolated = gatewayConfig.command.replace(
      /\{\{(\w+)\}\}/g,
      (match, key: string) => {
        const value = variables[key];
        if (value === undefined) return match;
        return shellEscapeArg(value);
      },
    );

    // Detect whether the interpolated command contains shell metacharacters
    const hasMetachars = SHELL_METACHAR_RE.test(interpolated);

    await new Promise<void>((resolve, reject) => {
      const cleanup = (signal: NodeJS.Signals) => {
        if (child) {
          child.kill(signal);
          // 1s grace period then SIGKILL
          setTimeout(() => {
            try { child?.kill("SIGKILL"); } catch { /* already dead */ }
          }, 1000);
        }
      };

      sigtermHandler = () => cleanup("SIGTERM");
      process.once("SIGTERM", sigtermHandler);

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (sigtermHandler) {
          process.removeListener("SIGTERM", sigtermHandler);
          sigtermHandler = null;
        }
        if (signal) {
          reject(new Error(`Command killed by signal ${signal}`));
        } else if (code !== 0) {
          reject(new Error(`Command exited with code ${code}`));
        } else {
          resolve();
        }
      };

      const onError = (err: Error) => {
        if (sigtermHandler) {
          process.removeListener("SIGTERM", sigtermHandler);
          sigtermHandler = null;
        }
        reject(err);
      };

      if (hasMetachars) {
        // Fall back to sh -c for complex commands with metacharacters
        child = exec(interpolated, {
          timeout: COMMAND_TIMEOUT_MS,
          env: { ...process.env },
        });
      } else {
        // Parse simple command: split on whitespace, use execFile
        const parts = interpolated.split(/\s+/).filter(Boolean);
        const cmd = parts[0];
        const args = parts.slice(1);
        child = execFile(cmd, args, {
          timeout: COMMAND_TIMEOUT_MS,
          env: { ...process.env },
        });
      }

      // Ensure detached is false (default, but explicit via options above)
      child.on("exit", onExit);
      child.on("error", onError);
    });

    return { gateway: gatewayName, success: true };
  } catch (error) {
    // Ensure SIGTERM handler is cleaned up on error
    if (sigtermHandler) {
      process.removeListener("SIGTERM", sigtermHandler);
    }
    return {
      gateway: gatewayName,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
