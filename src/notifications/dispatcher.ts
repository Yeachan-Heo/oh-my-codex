/**
 * Notification Dispatcher
 *
 * Sends notifications to configured platforms (Discord, Telegram, Slack, webhook).
 * All sends are non-blocking with timeouts. Failures are swallowed to avoid
 * blocking hooks.
 */

import { requestJson } from "./http-client.js";
import type {
  DiscordNotificationConfig,
  DiscordBotNotificationConfig,
  TelegramNotificationConfig,
  SlackNotificationConfig,
  WebhookNotificationConfig,
  FullNotificationPayload,
  NotificationResult,
  NotificationPlatform,
  DispatchResult,
  FullNotificationConfig,
  NotificationEvent,
} from "./types.js";

import {
  getEffectiveNotificationPlatformConfig,
  parseMentionAllowedMentions,
} from "./config.js";

const SEND_TIMEOUT_MS = 10_000;
const DISPATCH_TIMEOUT_MS = 15_000;
const DISCORD_MAX_CONTENT_LENGTH = 2000;

function composeDiscordContent(
  message: string,
  mention: string | undefined,
): {
  content: string;
  allowed_mentions: { parse: string[]; users?: string[]; roles?: string[] };
} {
  const mentionParsed = parseMentionAllowedMentions(mention);
  const allowed_mentions = {
    parse: [] as string[],
    users: mentionParsed.users,
    roles: mentionParsed.roles,
  };

  let content: string;
  if (mention) {
    const prefix = `${mention}\n`;
    const maxBody = DISCORD_MAX_CONTENT_LENGTH - prefix.length;
    const body =
      message.length > maxBody
        ? message.slice(0, maxBody - 1) + "\u2026"
        : message;
    content = `${prefix}${body}`;
  } else {
    content =
      message.length > DISCORD_MAX_CONTENT_LENGTH
        ? message.slice(0, DISCORD_MAX_CONTENT_LENGTH - 1) + "\u2026"
        : message;
  }

  return { content, allowed_mentions };
}

function validateDiscordUrl(webhookUrl: string): boolean {
  try {
    const url = new URL(webhookUrl);
    const allowedHosts = ["discord.com", "discordapp.com"];
    if (
      !allowedHosts.some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    ) {
      return false;
    }
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function validateTelegramToken(token: string): boolean {
  return /^[0-9]+:[A-Za-z0-9_-]+$/.test(token);
}

function validateSlackUrl(webhookUrl: string): boolean {
  try {
    const url = new URL(webhookUrl);
    return (
      url.protocol === "https:" &&
      (url.hostname === "hooks.slack.com" ||
        url.hostname.endsWith(".hooks.slack.com"))
    );
  } catch {
    return false;
  }
}

function validateWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function sendDiscord(
  config: DiscordNotificationConfig,
  payload: FullNotificationPayload,
): Promise<NotificationResult> {
  if (!config.enabled || !config.webhookUrl) {
    return { platform: "discord", success: false, error: "Not configured" };
  }

  if (!validateDiscordUrl(config.webhookUrl)) {
    return {
      platform: "discord",
      success: false,
      error: "Invalid webhook URL",
    };
  }

  try {
    const { content, allowed_mentions } = composeDiscordContent(
      payload.message,
      config.mention,
    );
    const body: Record<string, unknown> = { content, allowed_mentions };
    if (config.username) {
      body.username = config.username;
    }

    const response = await requestJson(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: SEND_TIMEOUT_MS,
    });

    if (!response.ok) {
      return {
        platform: "discord",
        success: false,
        error: `HTTP ${response.status}`,
      };
    }

    return { platform: "discord", success: true };
  } catch (error) {
    return {
      platform: "discord",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function sendDiscordBot(
  config: DiscordBotNotificationConfig,
  payload: FullNotificationPayload,
): Promise<NotificationResult> {
  if (!config.enabled) {
    return { platform: "discord-bot", success: false, error: "Not enabled" };
  }

  const botToken = config.botToken;
  const channelId = config.channelId;

  if (!botToken || !channelId) {
    return {
      platform: "discord-bot",
      success: false,
      error: "Missing botToken or channelId",
    };
  }

  try {
    const { content, allowed_mentions } = composeDiscordContent(
      payload.message,
      config.mention,
    );
    const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
    const response = await requestJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${botToken}`,
      },
      body: JSON.stringify({ content, allowed_mentions }),
      timeoutMs: SEND_TIMEOUT_MS,
    });

    if (!response.ok) {
      return {
        platform: "discord-bot",
        success: false,
        error: `HTTP ${response.status}`,
      };
    }

    let messageId: string | undefined;
    try {
      const data = (await response.json()) as { id?: string };
      messageId = data?.id;
    } catch {
      // Non-fatal
    }

    return { platform: "discord-bot", success: true, messageId };
  } catch (error) {
    return {
      platform: "discord-bot",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function sendTelegram(
  config: TelegramNotificationConfig,
  payload: FullNotificationPayload,
): Promise<NotificationResult> {
  if (!config.enabled || !config.botToken || !config.chatId) {
    return { platform: "telegram", success: false, error: "Not configured" };
  }

  if (!validateTelegramToken(config.botToken)) {
    return {
      platform: "telegram",
      success: false,
      error: "Invalid bot token format",
    };
  }

  try {
    const body = JSON.stringify({
      chat_id: config.chatId,
      text: payload.message,
      parse_mode: config.parseMode || "Markdown",
    });

    const response = await requestJson(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      },
      body,
      timeoutMs: SEND_TIMEOUT_MS,
    });

    if (!response.ok) {
      return {
        platform: "telegram",
        success: false,
        error: `HTTP ${response.status}`,
      };
    }

    let messageId: string | undefined;
    try {
      const responseBody = await response.json() as { result?: { message_id?: unknown } };
      if (responseBody?.result?.message_id !== undefined) {
        messageId = String(responseBody.result.message_id);
      }
    } catch {
      // Non-fatal
    }

    return { platform: "telegram", success: true, messageId };
  } catch (error) {
    return {
      platform: "telegram",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function sendSlack(
  config: SlackNotificationConfig,
  payload: FullNotificationPayload,
): Promise<NotificationResult> {
  if (!config.enabled || !config.webhookUrl) {
    return { platform: "slack", success: false, error: "Not configured" };
  }

  if (!validateSlackUrl(config.webhookUrl)) {
    return { platform: "slack", success: false, error: "Invalid webhook URL" };
  }

  try {
    const body: Record<string, unknown> = { text: payload.message };
    if (config.channel) {
      body.channel = config.channel;
    }
    if (config.username) {
      body.username = config.username;
    }

    const response = await requestJson(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: SEND_TIMEOUT_MS,
    });

    if (!response.ok) {
      return {
        platform: "slack",
        success: false,
        error: `HTTP ${response.status}`,
      };
    }

    return { platform: "slack", success: true };
  } catch (error) {
    return {
      platform: "slack",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function sendWebhook(
  config: WebhookNotificationConfig,
  payload: FullNotificationPayload,
): Promise<NotificationResult> {
  if (!config.enabled || !config.url) {
    return { platform: "webhook", success: false, error: "Not configured" };
  }

  if (!validateWebhookUrl(config.url)) {
    return {
      platform: "webhook",
      success: false,
      error: "Invalid URL (HTTPS required)",
    };
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...config.headers,
    };

    const response = await requestJson(config.url, {
      method: config.method || "POST",
      headers,
      body: JSON.stringify({
        event: payload.event,
        session_id: payload.sessionId,
        message: payload.message,
        timestamp: payload.timestamp,
        tmux_session: payload.tmuxSession,
        project_name: payload.projectName,
        project_path: payload.projectPath,
        modes_used: payload.modesUsed,
        duration_ms: payload.durationMs,
        reason: payload.reason,
        active_mode: payload.activeMode,
        question: payload.question,
      }),
      timeoutMs: SEND_TIMEOUT_MS,
    });

    if (!response.ok) {
      return {
        platform: "webhook",
        success: false,
        error: `HTTP ${response.status}`,
      };
    }

    return { platform: "webhook", success: true };
  } catch (error) {
    return {
      platform: "webhook",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function dispatchNotifications(
  config: FullNotificationConfig,
  event: NotificationEvent,
  payload: FullNotificationPayload,
): Promise<DispatchResult> {
  const promises: Promise<NotificationResult>[] = [];

  const discordConfig = getEffectiveNotificationPlatformConfig<DiscordNotificationConfig>(
    "discord",
    config,
    event,
  );
  if (discordConfig?.enabled) {
    promises.push(sendDiscord(discordConfig, payload));
  }

  const telegramConfig = getEffectiveNotificationPlatformConfig<TelegramNotificationConfig>(
    "telegram",
    config,
    event,
  );
  if (telegramConfig?.enabled) {
    promises.push(sendTelegram(telegramConfig, payload));
  }

  const slackConfig = getEffectiveNotificationPlatformConfig<SlackNotificationConfig>(
    "slack",
    config,
    event,
  );
  if (slackConfig?.enabled) {
    promises.push(sendSlack(slackConfig, payload));
  }

  const webhookConfig = getEffectiveNotificationPlatformConfig<WebhookNotificationConfig>(
    "webhook",
    config,
    event,
  );
  if (webhookConfig?.enabled) {
    promises.push(sendWebhook(webhookConfig, payload));
  }

  const discordBotConfig =
    getEffectiveNotificationPlatformConfig<DiscordBotNotificationConfig>(
      "discord-bot",
      config,
      event,
    );
  if (discordBotConfig?.enabled) {
    promises.push(sendDiscordBot(discordBotConfig, payload));
  }

  if (promises.length === 0) {
    return { event, results: [], anySuccess: false };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([
      Promise.allSettled(promises).then((settled) =>
        settled.map((s) =>
          s.status === "fulfilled"
            ? s.value
            : {
                platform: "unknown" as NotificationPlatform,
                success: false,
                error: String(s.reason),
              },
        ),
      ),
      new Promise<NotificationResult[]>((resolve) => {
        timer = setTimeout(
          () =>
            resolve([
              {
                platform: "unknown" as NotificationPlatform,
                success: false,
                error: "Dispatch timeout",
              },
            ]),
          DISPATCH_TIMEOUT_MS,
        );
      }),
    ]);

    if (timer) clearTimeout(timer);

    return {
      event,
      results,
      anySuccess: results.some((r) => r.success),
    };
  } catch (error) {
    if (timer) clearTimeout(timer);
    return {
      event,
      results: [
        {
          platform: "unknown" as NotificationPlatform,
          success: false,
          error: String(error),
        },
      ],
      anySuccess: false,
    };
  }
}
