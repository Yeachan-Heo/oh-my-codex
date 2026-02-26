/**
 * Notification System - Public API
 *
 * Multi-platform lifecycle notifications for oh-my-codex.
 * Sends notifications to Discord, Telegram, Slack, and generic webhooks
 * on session lifecycle events.
 *
 * Usage:
 *   import { notifyLifecycle } from '../notifications/index.js';
 *   await notifyLifecycle('session-start', { sessionId, projectPath, ... });
 */

export type {
  NotificationEvent,
  NotificationPlatform,
  FullNotificationConfig,
  FullNotificationPayload,
  NotificationResult,
  DispatchResult,
  DiscordNotificationConfig,
  DiscordBotNotificationConfig,
  TelegramNotificationConfig,
  SlackNotificationConfig,
  WebhookNotificationConfig,
  EventNotificationConfig,
  ReplyConfig,
  NotificationProfilesConfig,
  NotificationsBlock,
  VerbosityLevel,
} from "./types.js";

export {
  dispatchNotifications,
  sendDiscord,
  sendDiscordBot,
  sendTelegram,
  sendSlack,
  sendWebhook,
} from "./dispatcher.js";
export {
  formatNotification,
  formatSessionStart,
  formatSessionStop,
  formatSessionEnd,
  formatSessionIdle,
  formatAskUserQuestion,
} from "./formatter.js";
export {
  getCurrentTmuxSession,
  getCurrentTmuxPaneId,
  getTeamTmuxSessions,
  formatTmuxInfo,
  captureTmuxPane,
} from "./tmux.js";
export {
  getNotificationConfig,
  isEventEnabled,
  getEnabledPlatforms,
  getReplyConfig,
  getReplyListenerPlatformConfig,
  resolveProfileConfig,
  listProfiles,
  getActiveProfileName,
  getVerbosity,
  isEventAllowedByVerbosity,
  shouldIncludeTmuxTail,
} from "./config.js";
export {
  registerMessage,
  loadAllMappings,
  lookupByMessageId,
  removeSession,
  removeMessagesByPane,
  pruneStale,
} from "./session-registry.js";
export type { SessionMapping } from "./session-registry.js";
export {
  startReplyListener,
  stopReplyListener,
  getReplyListenerStatus,
  isDaemonRunning,
  sanitizeReplyInput,
} from "./reply-listener.js";

// Re-export the legacy notifier for backward compatibility
export { notify, loadNotificationConfig } from "./notifier.js";
export type { NotificationConfig, NotificationPayload } from "./notifier.js";

// Template engine exports
export {
  interpolateTemplate,
  validateTemplate,
  computeTemplateVariables,
  getDefaultTemplate,
} from "./template-engine.js";

// Hook config exports
export {
  getHookConfig,
  resetHookConfigCache,
  resolveEventTemplate,
  mergeHookConfigIntoNotificationConfig,
} from "./hook-config.js";
export type {
  HookNotificationConfig,
  HookEventConfig,
  PlatformTemplateOverride,
  TemplateVariable,
} from "./hook-config-types.js";

import type {
  NotificationEvent,
  FullNotificationPayload,
  DispatchResult,
} from "./types.js";
import { getNotificationConfig, isEventEnabled, getVerbosity, shouldIncludeTmuxTail, getActiveProfileName } from "./config.js";
import { formatNotification } from "./formatter.js";
import { dispatchNotifications } from "./dispatcher.js";
import { getCurrentTmuxSession, captureTmuxPane } from "./tmux.js";
import { basename } from "path";
import type { OpenClawHookEvent } from "../openclaw/types.js";

// Suppress unused import — used by callers via re-export
void getActiveProfileName;

/**
 * Map a NotificationEvent to an OpenClawHookEvent.
 * Returns null for events that have no OpenClaw equivalent.
 */
function toOpenClawEvent(event: NotificationEvent): OpenClawHookEvent | null {
  switch (event) {
    case "session-start": return "session-start";
    case "session-end": return "session-end";
    case "session-idle": return "session-idle";
    case "ask-user-question": return "ask-user-question";
    case "session-stop": return "stop";
    default: return null;
  }
}

/**
 * High-level notification function for lifecycle events.
 *
 * Reads config, checks if the event is enabled, formats the message,
 * and dispatches to all configured platforms. Non-blocking, swallows errors.
 */
export async function notifyLifecycle(
  event: NotificationEvent,
  data: Partial<FullNotificationPayload> & { sessionId: string },
  profileName?: string,
): Promise<DispatchResult | null> {
  try {
    const config = getNotificationConfig(profileName);
    if (!config || !isEventEnabled(config, event)) {
      return null;
    }

    const { getCurrentTmuxPaneId } = await import("./tmux.js");

    const payload: FullNotificationPayload = {
      event,
      sessionId: data.sessionId,
      message: "",
      timestamp: data.timestamp || new Date().toISOString(),
      tmuxSession: data.tmuxSession ?? getCurrentTmuxSession() ?? undefined,
      tmuxPaneId: data.tmuxPaneId ?? getCurrentTmuxPaneId() ?? undefined,
      projectPath: data.projectPath,
      projectName:
        data.projectName ||
        (data.projectPath ? basename(data.projectPath) : undefined),
      modesUsed: data.modesUsed,
      contextSummary: data.contextSummary,
      durationMs: data.durationMs,
      agentsSpawned: data.agentsSpawned,
      agentsCompleted: data.agentsCompleted,
      reason: data.reason,
      activeMode: data.activeMode,
      iteration: data.iteration,
      maxIterations: data.maxIterations,
      question: data.question,
      incompleteTasks: data.incompleteTasks,
    };

    // Capture tmux tail for session+ verbosity on idle/stop/end events
    const verbosity = getVerbosity(config);
    if (
      shouldIncludeTmuxTail(verbosity) &&
      !data.tmuxTail &&
      (event === "session-idle" || event === "session-stop" || event === "session-end")
    ) {
      payload.tmuxTail = captureTmuxPane(payload.tmuxPaneId) ?? undefined;
    } else {
      payload.tmuxTail = data.tmuxTail;
    }

    payload.message = data.message || formatNotification(payload);

    const result = await dispatchNotifications(config, event, payload);

    // Fire-and-forget OpenClaw gateway call (if OMX_OPENCLAW=1)
    if (process.env.OMX_OPENCLAW === "1") {
      try {
        const openClawEvent = toOpenClawEvent(event);
        if (openClawEvent !== null) {
          const { wakeOpenClaw } = await import("../openclaw/index.js");
          // Non-blocking: do not await to avoid delaying notification return
          void wakeOpenClaw(openClawEvent, {
            sessionId: payload.sessionId,
            projectPath: payload.projectPath,
            tmuxSession: payload.tmuxSession,
            contextSummary: payload.contextSummary,
            reason: payload.reason,
            question: payload.question,
            tmuxTail: payload.tmuxTail,
            // Reply context env vars are read inside wakeOpenClaw;
            // callers do not need to pass them explicitly.
          });
        }
      } catch {
        // OpenClaw failures must never affect notification dispatch
      }
    }

    if (result.anySuccess && payload.tmuxPaneId) {
      try {
        const { registerMessage } = await import("./session-registry.js");
        for (const r of result.results) {
          if (
            r.success &&
            r.messageId &&
            (r.platform === "discord-bot" || r.platform === "telegram")
          ) {
            registerMessage({
              platform: r.platform,
              messageId: r.messageId,
              sessionId: payload.sessionId,
              tmuxPaneId: payload.tmuxPaneId,
              tmuxSessionName: payload.tmuxSession || "",
              event: payload.event,
              createdAt: new Date().toISOString(),
              projectPath: payload.projectPath,
            });
          }
        }
      } catch {
        // Non-fatal: reply correlation is best-effort
      }
    }

    return result;
  } catch (error) {
    console.error(
      "[notifications] Error:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
