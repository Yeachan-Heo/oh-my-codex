/**
 * Notification Configuration Reader
 *
 * Reads notification config from .omx-config.json and provides
 * backward compatibility with the old stopHookCallbacks format.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { codexHome } from "../utils/paths.js";
import type {
  FullNotificationConfig,
  NotificationsBlock,
  NotificationEvent,
  NotificationPlatform,
  EventNotificationConfig,
  DiscordNotificationConfig,
  DiscordBotNotificationConfig,
  TelegramNotificationConfig,
  VerbosityLevel,
} from "./types.js";

const CONFIG_FILE = join(codexHome(), ".omx-config.json");

function readRawConfig(): Record<string, unknown> | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function migrateStopHookCallbacks(
  raw: Record<string, unknown>,
): FullNotificationConfig | null {
  const callbacks = raw.stopHookCallbacks as
    | Record<string, unknown>
    | undefined;
  if (!callbacks) return null;

  const config: FullNotificationConfig = {
    enabled: true,
    events: {
      "session-end": { enabled: true },
    },
  };

  const telegram = callbacks.telegram as Record<string, unknown> | undefined;
  if (telegram?.enabled) {
    const telegramConfig: TelegramNotificationConfig = {
      enabled: true,
      botToken: (telegram.botToken as string) || "",
      chatId: (telegram.chatId as string) || "",
    };
    config.telegram = telegramConfig;
  }

  const discord = callbacks.discord as Record<string, unknown> | undefined;
  if (discord?.enabled) {
    const discordConfig: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: (discord.webhookUrl as string) || "",
    };
    config.discord = discordConfig;
  }

  return config;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function validateMention(raw: string | undefined): string | undefined {
  const mention = normalizeOptional(raw);
  if (!mention) return undefined;
  if (/^<@!?\d{17,20}>$/.test(mention) || /^<@&\d{17,20}>$/.test(mention)) {
    return mention;
  }
  return undefined;
}

export function parseMentionAllowedMentions(
  mention: string | undefined,
): { users?: string[]; roles?: string[] } {
  if (!mention) return {};
  const userMatch = mention.match(/^<@!?(\d{17,20})>$/);
  if (userMatch) return { users: [userMatch[1]] };
  const roleMatch = mention.match(/^<@&(\d{17,20})>$/);
  if (roleMatch) return { roles: [roleMatch[1]] };
  return {};
}

export function buildConfigFromEnv(): FullNotificationConfig | null {
  const config: FullNotificationConfig = { enabled: false };
  let hasAnyPlatform = false;

  const discordMention = validateMention(process.env.OMX_DISCORD_MENTION);

  const discordBotToken = process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN;
  const discordChannel = process.env.OMX_DISCORD_NOTIFIER_CHANNEL;
  if (discordBotToken && discordChannel) {
    config["discord-bot"] = {
      enabled: true,
      botToken: discordBotToken,
      channelId: discordChannel,
      mention: discordMention,
    };
    hasAnyPlatform = true;
  }

  const discordWebhook = process.env.OMX_DISCORD_WEBHOOK_URL;
  if (discordWebhook) {
    config.discord = {
      enabled: true,
      webhookUrl: discordWebhook,
      mention: discordMention,
    };
    hasAnyPlatform = true;
  }

  const telegramToken =
    process.env.OMX_TELEGRAM_BOT_TOKEN ||
    process.env.OMX_TELEGRAM_NOTIFIER_BOT_TOKEN;
  const telegramChatId =
    process.env.OMX_TELEGRAM_CHAT_ID ||
    process.env.OMX_TELEGRAM_NOTIFIER_CHAT_ID ||
    process.env.OMX_TELEGRAM_NOTIFIER_UID;
  if (telegramToken && telegramChatId) {
    config.telegram = {
      enabled: true,
      botToken: telegramToken,
      chatId: telegramChatId,
    };
    hasAnyPlatform = true;
  }

  const slackWebhook = process.env.OMX_SLACK_WEBHOOK_URL;
  if (slackWebhook) {
    config.slack = {
      enabled: true,
      webhookUrl: slackWebhook,
    };
    hasAnyPlatform = true;
  }

  if (!hasAnyPlatform) return null;

  config.enabled = true;
  return config;
}

function mergeEnvIntoFileConfig(
  fileConfig: FullNotificationConfig,
  envConfig: FullNotificationConfig,
): FullNotificationConfig {
  const merged = { ...fileConfig };

  if (!merged["discord-bot"] && envConfig["discord-bot"]) {
    merged["discord-bot"] = envConfig["discord-bot"];
  } else if (merged["discord-bot"] && envConfig["discord-bot"]) {
    merged["discord-bot"] = {
      ...merged["discord-bot"],
      botToken: merged["discord-bot"].botToken || envConfig["discord-bot"].botToken,
      channelId: merged["discord-bot"].channelId || envConfig["discord-bot"].channelId,
      mention:
        merged["discord-bot"].mention !== undefined
          ? validateMention(merged["discord-bot"].mention)
          : envConfig["discord-bot"].mention,
    };
  }

  if (!merged.discord && envConfig.discord) {
    merged.discord = envConfig.discord;
  } else if (merged.discord && envConfig.discord) {
    merged.discord = {
      ...merged.discord,
      webhookUrl: merged.discord.webhookUrl || envConfig.discord.webhookUrl,
      mention:
        merged.discord.mention !== undefined
          ? validateMention(merged.discord.mention)
          : envConfig.discord.mention,
    };
  } else if (merged.discord) {
    merged.discord = {
      ...merged.discord,
      mention: validateMention(merged.discord.mention),
    };
  }

  if (!merged.telegram && envConfig.telegram) {
    merged.telegram = envConfig.telegram;
  }

  if (!merged.slack && envConfig.slack) {
    merged.slack = envConfig.slack;
  }

  return merged;
}

/**
 * Resolve a named profile from the notifications block.
 *
 * Priority:
 *   1. Explicit `profileName` argument
 *   2. OMX_NOTIFY_PROFILE environment variable
 *   3. `defaultProfile` field in config
 *   4. null (no profile selected → fall back to flat config)
 */
export function resolveProfileConfig(
  notifications: NotificationsBlock,
  profileName?: string,
): FullNotificationConfig | null {
  const profiles = notifications.profiles;
  if (!profiles || Object.keys(profiles).length === 0) {
    return null; // no profiles defined, use flat config
  }

  const name =
    profileName ||
    process.env.OMX_NOTIFY_PROFILE ||
    notifications.defaultProfile;

  if (!name) {
    return null; // no profile selected, use flat config
  }

  const profile = profiles[name];
  if (!profile) {
    console.warn(
      `[notifications] Profile "${name}" not found. Available: ${Object.keys(profiles).join(", ")}`,
    );
    return null;
  }

  return profile;
}

/**
 * List available profile names from the config file.
 */
export function listProfiles(): string[] {
  const raw = readRawConfig();
  if (!raw) return [];
  const notifications = raw.notifications as NotificationsBlock | undefined;
  if (!notifications?.profiles) return [];
  return Object.keys(notifications.profiles);
}

/**
 * Get the active profile name based on resolution priority.
 * Returns null if no profile is active (flat config mode).
 */
export function getActiveProfileName(): string | null {
  if (process.env.OMX_NOTIFY_PROFILE) {
    return process.env.OMX_NOTIFY_PROFILE;
  }
  const raw = readRawConfig();
  if (!raw) return null;
  const notifications = raw.notifications as NotificationsBlock | undefined;
  if (!notifications?.profiles || Object.keys(notifications.profiles).length === 0) {
    return null;
  }
  return notifications.defaultProfile || null;
}

export function getNotificationConfig(
  profileName?: string,
): FullNotificationConfig | null {
  const raw = readRawConfig();

  if (raw) {
    const notifications = raw.notifications as NotificationsBlock | undefined;
    if (notifications) {
      // Try profile resolution first
      const profileConfig = resolveProfileConfig(notifications, profileName);
      if (profileConfig) {
        if (typeof profileConfig.enabled !== "boolean") {
          return null;
        }
        const envConfig = buildConfigFromEnv();
        if (envConfig) {
          return mergeEnvIntoFileConfig(profileConfig, envConfig);
        }
        return profileConfig;
      }

      // Fall back to flat config (backward compatible)
      if (typeof notifications.enabled !== "boolean") {
        return null;
      }
      const envConfig = buildConfigFromEnv();
      if (envConfig) {
        return mergeEnvIntoFileConfig(notifications, envConfig);
      }
      const envMention = validateMention(process.env.OMX_DISCORD_MENTION);
      if (envMention) {
        const patched = { ...notifications };
        if (patched["discord-bot"] && patched["discord-bot"].mention === undefined) {
          patched["discord-bot"] = { ...patched["discord-bot"], mention: envMention };
        }
        if (patched.discord && patched.discord.mention === undefined) {
          patched.discord = { ...patched.discord, mention: envMention };
        }
        return patched;
      }
      return notifications;
    }
  }

  const envConfig = buildConfigFromEnv();
  if (envConfig) return envConfig;

  if (raw) {
    return migrateStopHookCallbacks(raw);
  }

  return null;
}

const VALID_VERBOSITY_LEVELS: VerbosityLevel[] = ["verbose", "agent", "session", "minimal"];
const DEFAULT_VERBOSITY: VerbosityLevel = "session";

/**
 * Numeric rank for verbosity levels (higher = more verbose).
 */
const VERBOSITY_RANK: Record<VerbosityLevel, number> = {
  minimal: 0,
  session: 1,
  agent: 2,
  verbose: 3,
};

/**
 * Minimum verbosity level required for each event type.
 */
const EVENT_MIN_VERBOSITY: Record<NotificationEvent, VerbosityLevel> = {
  "session-start": "minimal",
  "session-stop": "minimal",
  "session-end": "minimal",
  "session-idle": "session",
  "ask-user-question": "agent",
};

/**
 * Resolve the effective verbosity level.
 * Priority: env var > config field > default ("session").
 */
export function getVerbosity(config: FullNotificationConfig | null): VerbosityLevel {
  const envVal = process.env.OMX_NOTIFY_VERBOSITY as string | undefined;
  if (envVal && VALID_VERBOSITY_LEVELS.includes(envVal as VerbosityLevel)) {
    return envVal as VerbosityLevel;
  }
  if (config?.verbosity && VALID_VERBOSITY_LEVELS.includes(config.verbosity)) {
    return config.verbosity;
  }
  return DEFAULT_VERBOSITY;
}

/**
 * Check whether a given event is allowed at the specified verbosity level.
 */
export function isEventAllowedByVerbosity(
  verbosity: VerbosityLevel,
  event: NotificationEvent,
): boolean {
  const required = EVENT_MIN_VERBOSITY[event] ?? "session";
  return VERBOSITY_RANK[verbosity] >= VERBOSITY_RANK[required];
}

/**
 * Whether the given verbosity level should include tmux tail output.
 */
export function shouldIncludeTmuxTail(verbosity: VerbosityLevel): boolean {
  return VERBOSITY_RANK[verbosity] >= VERBOSITY_RANK["session"];
}

export function isEventEnabled(
  config: FullNotificationConfig,
  event: NotificationEvent,
): boolean {
  if (!config.enabled) return false;

  // Verbosity gate: reject events below the configured verbosity level
  const verbosity = getVerbosity(config);
  if (!isEventAllowedByVerbosity(verbosity, event)) return false;

  const eventConfig = config.events?.[event];

  if (eventConfig && eventConfig.enabled === false) return false;

  if (!eventConfig) {
    return !!(
      config.discord?.enabled ||
      config["discord-bot"]?.enabled ||
      config.telegram?.enabled ||
      config.slack?.enabled ||
      config.webhook?.enabled
    );
  }

  if (
    eventConfig.discord?.enabled ||
    eventConfig["discord-bot"]?.enabled ||
    eventConfig.telegram?.enabled ||
    eventConfig.slack?.enabled ||
    eventConfig.webhook?.enabled
  ) {
    return true;
  }

  return !!(
    config.discord?.enabled ||
    config["discord-bot"]?.enabled ||
    config.telegram?.enabled ||
    config.slack?.enabled ||
    config.webhook?.enabled
  );
}

export function getEnabledPlatforms(
  config: FullNotificationConfig,
  event: NotificationEvent,
): NotificationPlatform[] {
  if (!config.enabled) return [];

  const platforms: NotificationPlatform[] = [];
  const eventConfig = config.events?.[event];

  if (eventConfig && eventConfig.enabled === false) return [];

  const checkPlatform = (platform: NotificationPlatform) => {
    const eventPlatform =
      eventConfig?.[platform as keyof EventNotificationConfig];
    if (
      eventPlatform &&
      typeof eventPlatform === "object" &&
      "enabled" in eventPlatform
    ) {
      if ((eventPlatform as { enabled: boolean }).enabled) {
        platforms.push(platform);
      }
      return;
    }

    const topLevel = config[platform as keyof FullNotificationConfig];
    if (
      topLevel &&
      typeof topLevel === "object" &&
      "enabled" in topLevel &&
      (topLevel as { enabled: boolean }).enabled
    ) {
      platforms.push(platform);
    }
  };

  checkPlatform("discord");
  checkPlatform("discord-bot");
  checkPlatform("telegram");
  checkPlatform("slack");
  checkPlatform("webhook");

  return platforms;
}

const REPLY_PLATFORM_EVENTS: NotificationEvent[] = [
  "session-start",
  "ask-user-question",
  "session-stop",
  "session-idle",
  "session-end",
];

function getEnabledReplyPlatformConfig<T extends { enabled: boolean }>(
  config: FullNotificationConfig,
  platform: "discord-bot" | "telegram",
): T | undefined {
  const topLevel = config[platform] as T | undefined;
  if (topLevel?.enabled) {
    return topLevel;
  }

  for (const event of REPLY_PLATFORM_EVENTS) {
    const eventConfig = config.events?.[event];
    const eventPlatform =
      eventConfig?.[platform as keyof EventNotificationConfig];

    if (
      eventPlatform &&
      typeof eventPlatform === "object" &&
      "enabled" in eventPlatform &&
      (eventPlatform as { enabled: boolean }).enabled
    ) {
      return eventPlatform as T;
    }
  }

  return undefined;
}

export function getReplyListenerPlatformConfig(
  config: FullNotificationConfig | null,
): {
  telegramBotToken?: string;
  telegramChatId?: string;
  discordBotToken?: string;
  discordChannelId?: string;
  discordMention?: string;
} {
  if (!config) return {};

  const telegramConfig =
    getEnabledReplyPlatformConfig<TelegramNotificationConfig>(
      config,
      "telegram",
    );
  const discordBotConfig =
    getEnabledReplyPlatformConfig<DiscordBotNotificationConfig>(
      config,
      "discord-bot",
    );

  return {
    telegramBotToken: telegramConfig?.botToken || config.telegram?.botToken,
    telegramChatId: telegramConfig?.chatId || config.telegram?.chatId,
    discordBotToken:
      discordBotConfig?.botToken || config["discord-bot"]?.botToken,
    discordChannelId:
      discordBotConfig?.channelId || config["discord-bot"]?.channelId,
    discordMention:
      discordBotConfig?.mention || config["discord-bot"]?.mention,
  };
}

function parseDiscordUserIds(
  envValue: string | undefined,
  configValue: unknown,
): string[] {
  if (envValue) {
    const ids = envValue
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^\d{17,20}$/.test(id));
    if (ids.length > 0) return ids;
  }

  if (Array.isArray(configValue)) {
    const ids = configValue
      .filter((id) => typeof id === "string" && /^\d{17,20}$/.test(id));
    if (ids.length > 0) return ids;
  }

  return [];
}

export function getReplyConfig(): import("./types.js").ReplyConfig | null {
  const notifConfig = getNotificationConfig();
  if (!notifConfig?.enabled) return null;

  const hasDiscordBot = !!getEnabledReplyPlatformConfig<DiscordBotNotificationConfig>(
    notifConfig,
    "discord-bot",
  );
  const hasTelegram = !!getEnabledReplyPlatformConfig<TelegramNotificationConfig>(
    notifConfig,
    "telegram",
  );
  if (!hasDiscordBot && !hasTelegram) return null;

  const raw = readRawConfig();
  const replyRaw = (raw?.notifications as any)?.reply;

  const enabled = process.env.OMX_REPLY_ENABLED === "true" || replyRaw?.enabled === true;
  if (!enabled) return null;

  const authorizedDiscordUserIds = parseDiscordUserIds(
    process.env.OMX_REPLY_DISCORD_USER_IDS,
    replyRaw?.authorizedDiscordUserIds,
  );

  if (hasDiscordBot && authorizedDiscordUserIds.length === 0) {
    console.warn(
      "[notifications] Discord reply listening disabled: authorizedDiscordUserIds is empty. " +
      "Set OMX_REPLY_DISCORD_USER_IDS or add to .omx-config.json notifications.reply.authorizedDiscordUserIds"
    );
  }

  return {
    enabled: true,
    pollIntervalMs: parseInt(process.env.OMX_REPLY_POLL_INTERVAL_MS || "") || replyRaw?.pollIntervalMs || 3000,
    maxMessageLength: replyRaw?.maxMessageLength || 500,
    rateLimitPerMinute: parseInt(process.env.OMX_REPLY_RATE_LIMIT || "") || replyRaw?.rateLimitPerMinute || 10,
    includePrefix: process.env.OMX_REPLY_INCLUDE_PREFIX !== "false" && (replyRaw?.includePrefix !== false),
    authorizedDiscordUserIds,
  };
}
