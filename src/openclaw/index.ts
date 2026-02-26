/**
 * OpenClaw Integration - Public API
 *
 * Wakes OpenClaw gateways on hook events. Non-blocking, fire-and-forget.
 *
 * Usage (from notify hook via wakeOpenClaw):
 *   wakeOpenClaw("session-start", { sessionId, projectPath: directory });
 *
 * Activation requires OMX_OPENCLAW=1 env var and config in .omx-config.json.
 */

export type {
  OpenClawCommandGatewayConfig,
  OpenClawConfig,
  OpenClawContext,
  OpenClawGatewayConfig,
  OpenClawHookEvent,
  OpenClawHookMapping,
  OpenClawHttpGatewayConfig,
  OpenClawPayload,
  OpenClawResult,
} from "./types.js";

export { getOpenClawConfig, resolveGateway, resetOpenClawConfigCache } from "./config.js";
export {
  wakeGateway,
  wakeCommandGateway,
  interpolateInstruction,
  isCommandGateway,
  shellEscapeArg,
  validateGatewayUrl,
} from "./dispatcher.js";

import type { OpenClawHookEvent, OpenClawContext, OpenClawResult } from "./types.js";
import { getOpenClawConfig, resolveGateway } from "./config.js";
import { wakeGateway, wakeCommandGateway, interpolateInstruction, isCommandGateway } from "./dispatcher.js";
import { basename } from "path";
import { getCurrentTmuxSession, captureTmuxPane } from "../notifications/tmux.js";

/** Whether debug logging is enabled */
const DEBUG = process.env.OMX_OPENCLAW_DEBUG === "1";

/**
 * Build a whitelisted context object from the input context.
 * Only known fields are included to prevent accidental data leakage.
 */
function buildWhitelistedContext(context: OpenClawContext): OpenClawContext {
  const result: OpenClawContext = {};
  if (context.sessionId !== undefined) result.sessionId = context.sessionId;
  if (context.projectPath !== undefined) result.projectPath = context.projectPath;
  if (context.tmuxSession !== undefined) result.tmuxSession = context.tmuxSession;
  if (context.prompt !== undefined) result.prompt = context.prompt;
  if (context.contextSummary !== undefined) result.contextSummary = context.contextSummary;
  if (context.reason !== undefined) result.reason = context.reason;
  if (context.question !== undefined) result.question = context.question;
  if (context.tmuxTail !== undefined) result.tmuxTail = context.tmuxTail;
  if (context.replyChannel !== undefined) result.replyChannel = context.replyChannel;
  if (context.replyTarget !== undefined) result.replyTarget = context.replyTarget;
  if (context.replyThread !== undefined) result.replyThread = context.replyThread;
  return result;
}

/**
 * Wake the OpenClaw gateway mapped to a hook event.
 *
 * This is the main entry point called from the notify hook.
 * Non-blocking, swallows all errors. Returns null if OpenClaw
 * is not configured or the event is not mapped.
 *
 * @param event - The hook event type
 * @param context - Context data for template variable interpolation
 * @returns OpenClawResult or null if not configured/mapped
 */
export async function wakeOpenClaw(
  event: OpenClawHookEvent,
  context: OpenClawContext,
): Promise<OpenClawResult | null> {
  try {
    const config = getOpenClawConfig();
    if (!config) return null;

    const resolved = resolveGateway(config, event);
    if (!resolved) return null;

    const { gatewayName, gateway, instruction } = resolved;

    // Single timestamp for both template variables and payload
    const now = new Date().toISOString();

    // Read originating channel context from env vars (set by external bot/automation)
    const replyChannel = context.replyChannel ?? process.env.OPENCLAW_REPLY_CHANNEL ?? undefined;
    const replyTarget = context.replyTarget ?? process.env.OPENCLAW_REPLY_TARGET ?? undefined;
    const replyThread = context.replyThread ?? process.env.OPENCLAW_REPLY_THREAD ?? undefined;

    // Merge reply context into the context object for whitelisting
    const enrichedContext: OpenClawContext = {
      ...context,
      ...(replyChannel !== undefined && { replyChannel }),
      ...(replyTarget !== undefined && { replyTarget }),
      ...(replyThread !== undefined && { replyThread }),
    };

    // Auto-detect tmux session if not provided in context
    const tmuxSession = enrichedContext.tmuxSession ?? getCurrentTmuxSession() ?? undefined;

    // Auto-capture tmux pane content for stop/session-end events (best-effort)
    let tmuxTail = enrichedContext.tmuxTail;
    if (!tmuxTail && (event === "stop" || event === "session-end") && process.env.TMUX) {
      try {
        const paneId = process.env.TMUX_PANE;
        if (paneId) {
          tmuxTail = captureTmuxPane(paneId, 15) ?? undefined;
        }
      } catch {
        // Non-blocking: tmux capture is best-effort
      }
    }

    // Build template variables from whitelisted context fields
    const variables: Record<string, string | undefined> = {
      sessionId: enrichedContext.sessionId,
      projectPath: enrichedContext.projectPath,
      projectName: enrichedContext.projectPath ? basename(enrichedContext.projectPath) : undefined,
      tmuxSession,
      prompt: enrichedContext.prompt,
      contextSummary: enrichedContext.contextSummary,
      reason: enrichedContext.reason,
      question: enrichedContext.question,
      tmuxTail,
      event,
      timestamp: now,
      replyChannel,
      replyTarget,
      replyThread,
    };

    // Add interpolated instruction to variables for command gateway {{instruction}} placeholder
    const interpolatedInstruction = interpolateInstruction(instruction, variables);
    variables.instruction = interpolatedInstruction;

    let result: OpenClawResult;

    if (isCommandGateway(gateway)) {
      // Command gateway: execute shell command with shell-escaped variables
      result = await wakeCommandGateway(gatewayName, gateway, variables);
    } else {
      // HTTP gateway: send JSON payload
      const payload = {
        event,
        instruction: interpolatedInstruction,
        timestamp: now,
        sessionId: enrichedContext.sessionId,
        projectPath: enrichedContext.projectPath,
        projectName: enrichedContext.projectPath ? basename(enrichedContext.projectPath) : undefined,
        tmuxSession,
        tmuxTail,
        ...(replyChannel !== undefined && { channel: replyChannel }),
        ...(replyTarget !== undefined && { to: replyTarget }),
        ...(replyThread !== undefined && { threadId: replyThread }),
        context: buildWhitelistedContext(enrichedContext),
      };
      result = await wakeGateway(gatewayName, gateway, payload);
    }

    if (DEBUG) {
      console.error(`[openclaw] wake ${event} -> ${gatewayName}: ${result.success ? "ok" : result.error}`);
    }

    return result;
  } catch (error) {
    // Never let OpenClaw failures propagate to hooks
    if (DEBUG) {
      console.error(`[openclaw] wakeOpenClaw error:`, error instanceof Error ? error.message : error);
    }
    return null;
  }
}
