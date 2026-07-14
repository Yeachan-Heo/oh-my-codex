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
  sanitizeTmuxAlertText,
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

// Dispatch cooldown exports
export {
  getDispatchNotificationCooldownSeconds,
  shouldSendDispatchNotification,
  recordDispatchNotificationSent,
} from "./dispatch-cooldown.js";

// Idle cooldown exports (for backward compatibility)
export {
  getIdleNotificationCooldownSeconds,
  shouldSendIdleNotification,
  recordIdleNotificationSent,
} from "./idle-cooldown.js";

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
import {
  getSelectedOpenClawGatewayNames,
  isOpenClawSelectedInTempContract,
  readNotifyTempContractFromEnv,
  type NotifyTempContract,
} from "./temp-contract.js";
import { formatNotification } from "./formatter.js";
import { dispatchNotifications } from "./dispatcher.js";
import { getCurrentTmuxSession, sanitizeTmuxAlertText } from "./tmux.js";
import { basename } from "path";
import { omxStateDir } from "../utils/paths.js";
import {
  shouldSendLifecycleNotification,
  recordLifecycleNotificationSent,
} from "./lifecycle-dedupe.js";
import type { OpenClawHookEvent } from "../openclaw/types.js";
import { parseTmuxTail } from "./formatter.js";
import {
  shouldIncludeSessionIdleTmuxTail,
  recordSessionIdleTmuxTailSent,
} from "./idle-cooldown.js";

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

export async function shouldDispatchOpenClaw(
  event: OpenClawHookEvent,
  tempContract: NotifyTempContract | null,
  env: NodeJS.ProcessEnv = process.env,
) : Promise<boolean> {
  if (env.OMX_OPENCLAW !== "1") return false;
  if (!tempContract?.active) return true;
  if (!isOpenClawSelectedInTempContract(tempContract)) return false;

  const selectedGatewayNames = getSelectedOpenClawGatewayNames(tempContract);
  if (selectedGatewayNames.size === 0) return false;

  try {
    const { getOpenClawConfig, resolveGateway } = await import("../openclaw/config.js");
    const config = getOpenClawConfig();
    if (!config) return false;
    const resolved = resolveGateway(config, event);
    if (!resolved) return false;
    return selectedGatewayNames.has(resolved.gatewayName.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * High-level notification function for lifecycle events.
 *
 * Reads config, checks if the event is enabled, formats the message,
 * and dispatches to all configured platforms. Non-blocking, swallows errors.
 */
interface NotificationLifecycleOptions {
  persistScopedReceipts?: boolean;
}

export async function notifyLifecycle(
  event: NotificationEvent,
  data: Partial<FullNotificationPayload> & { sessionId: string },
  profileName?: string,
  options: NotificationLifecycleOptions = {},
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

    // Auto-capture tmux tail only for live idle events. Stop/end lifecycle dispatches
    // happen after the relevant session is stopping or has already completed, so
    // blind capture-pane reads can replay historical pane lines into follow-up
    // alerts. Explicitly supplied tmuxTail still passes through unchanged.
    const verbosity = getVerbosity(config);
    if (
      shouldIncludeTmuxTail(verbosity)
      && !data.tmuxTail
      && event === "session-idle"
    ) {
      const { captureTmuxPaneWithLiveness } = await import("./tmux.js");
      const tmuxCapture = captureTmuxPaneWithLiveness(payload.tmuxPaneId);
      payload.tmuxTail = sanitizeTmuxAlertText(tmuxCapture.content);
      payload.tmuxTailLive = tmuxCapture.live;
    } else {
      payload.tmuxTail = sanitizeTmuxAlertText(data.tmuxTail);
      payload.tmuxTailLive = data.tmuxTailLive;
    }

    const lifecycleStateDir = payload.projectPath ? omxStateDir(payload.projectPath) : "";
    const normalizedIdleTmuxTail = event === "session-idle" ? parseTmuxTail(payload.tmuxTail || "") : "";
    const sessionIdleTmuxTailAllowed = event !== "session-idle"
      || shouldIncludeSessionIdleTmuxTail(lifecycleStateDir, payload.sessionId, normalizedIdleTmuxTail);

    if (
      event === "session-idle"
      && !sessionIdleTmuxTailAllowed
    ) {
      payload.tmuxTail = undefined;
      payload.tmuxTailLive = undefined;
    }

    payload.message = data.message || formatNotification(payload);

    if (!shouldSendLifecycleNotification(lifecycleStateDir, payload)) {
      return {
        event,
        anySuccess: true,
        results: [],
      };
    }

    const openClawEvent = toOpenClawEvent(event);
    let dispatchOpenClawLater: (() => Promise<void>) | null = null;
    if (openClawEvent !== null) {
      const tempContract = readNotifyTempContractFromEnv(process.env);
      const openClawContext = {
        sessionId: payload.sessionId,
        projectPath: payload.projectPath,
        tmuxSession: payload.tmuxSession,
        contextSummary: payload.contextSummary,
        reason: payload.reason,
        question: payload.question,
        tmuxTail: payload.tmuxTail,
        // Reply context env vars are read inside wakeOpenClaw;
        // callers do not need to pass them explicitly.
      };
      dispatchOpenClawLater = async (): Promise<void> => {
        try {
          const openClawAllowed = await shouldDispatchOpenClaw(
            openClawEvent,
            tempContract,
            process.env,
          );
          if (!openClawAllowed) return;

          const { wakeOpenClaw } = await import("../openclaw/index.js");
          if (openClawEvent === "ask-user-question") {
            // ask-user-question must launch through the current foreground hook path
            // so downstream answer routing stays attached to the live session.
            await wakeOpenClaw(openClawEvent, openClawContext);
            return;
          }

          // Other lifecycle hooks remain fire-and-forget to avoid delaying notification return.
          void wakeOpenClaw(openClawEvent, openClawContext);
        } catch {
          // OpenClaw failures must never affect notification dispatch
        }
      };
    }

    if (openClawEvent !== "ask-user-question" && dispatchOpenClawLater) {
      // Let the non-blocking OpenClaw eligibility/import path overlap the primary
      // platform dispatch so session-start does not wait on background wake work.
      void dispatchOpenClawLater();
    }

    const result = await dispatchNotifications(config, event, payload);
    if (result.anySuccess && options.persistScopedReceipts !== false) {
      recordLifecycleNotificationSent(lifecycleStateDir, payload);
      if (event === "session-idle" && sessionIdleTmuxTailAllowed) {
        recordSessionIdleTmuxTailSent(lifecycleStateDir, payload.sessionId, normalizedIdleTmuxTail);
      }
    }

    if (openClawEvent === "ask-user-question" && dispatchOpenClawLater) {
      await dispatchOpenClawLater();
    }

    if (result.anySuccess && payload.tmuxPaneId && options.persistScopedReceipts !== false) {
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
