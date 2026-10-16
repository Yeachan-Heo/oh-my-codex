/**
 * Shared types for the slim native Codex hook policy surface (#3497).
 * Hook policy covers session bookkeeping, skill-context injection, and
 * notifications only. PreToolUse is advisory-only except authority-decreasing
 * cancel interception.
 */

export type CodexHookEventName =
  | "SessionStart"
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "PreCompact"
  | "PostCompact"
  | "SubagentStop"
  | "Stop";

export type CodexHookPayload = Record<string, unknown>;

export interface NativeHookDispatchOptions {
  cwd?: string;
  sessionOwnerPid?: number;
  /** @internal Scoped deterministic SessionStart durability seam for native-hook tests. */
  sessionStartOptions?: {
    platform?: NodeJS.Platform;
    regularFileSync?: (path: string) => void | Promise<void>;
  };
  reconcileHudForPromptSubmitFn?: (
    cwd: string,
    options?: { sessionId?: string | null; sessionIds?: string[] },
  ) => Promise<unknown>;
}

export interface NativeHookDispatchResult {
  hookEventName: CodexHookEventName | null;
  omxEventName: string | null;
  skillState: unknown;
  outputJson: Record<string, unknown> | null;
}

/** Reasons that may still emit PreToolUse deny (authority-decreasing cancel only). */
export const PRETOOLUSE_DENY_ALLOWED_REASONS = new Set([
  "cancelled_exact_session",
  "invalid_command",
  "session_binding",
  "actor_authority",
  "active_state",
  "preflight_failed",
  "identity_mismatch",
  "cwd_mismatch",
  "skill_mismatch",
  "write_failed",
  "rollback_failed",
  "recovery_required",
]);
