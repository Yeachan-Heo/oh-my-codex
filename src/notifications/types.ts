/**
 * Notification System Types
 *
 * Defines types for the multi-platform lifecycle notification system.
 * Supports Discord, Telegram, Slack, and generic webhooks across
 * session lifecycle events (start, stop, end, ask-user-question).
 */

/** Events that can trigger notifications */
export type NotificationEvent =
  | "session-start"
  | "session-stop"
  | "session-end"
  | "session-idle"
  | "ask-user-question";

/**
 * Verbosity levels for notification filtering.
 *
 * - verbose: all text/tool call output
 * - agent:   per-agent-call events (includes ask-user-question)
 * - session: start/idle/stop/end + tmux tail snippet [DEFAULT]
 * - minimal: start/stop/end only, no idle, no tmux tail
 */
export type VerbosityLevel = "verbose" | "agent" | "session" | "minimal";

/** Supported notification platforms */
export type NotificationPlatform =
  | "discord"
  | "discord-bot"
  | "telegram"
  | "slack"
  | "webhook";

/** Discord webhook configuration */
export interface DiscordNotificationConfig {
  enabled: boolean;
  /** Discord webhook URL */
  webhookUrl: string;
  /** Optional username override for the webhook bot */
  username?: string;
  /** Optional mention to prepend to messages (e.g. "<@123456>" for user, "<@&789>" for role) */
  mention?: string;
}

/** Discord Bot API configuration (bot token + channel ID) */
export interface DiscordBotNotificationConfig {
  enabled: boolean;
  /** Discord bot token (or env var: OMX_DISCORD_NOTIFIER_BOT_TOKEN) */
  botToken?: string;
  /** Channel ID to send messages to (or env var: OMX_DISCORD_NOTIFIER_CHANNEL) */
  channelId?: string;
  /** Optional mention to prepend to messages (e.g. "<@123456>" for user, "<@&789>" for role) */
  mention?: string;
}

/** Telegram platform configuration */
export interface TelegramNotificationConfig {
  enabled: boolean;
  /** Telegram bot token */
  botToken: string;
  /** Chat ID to send messages to */
  chatId: string;
  /** Parse mode: Markdown or HTML (default: Markdown) */
  parseMode?: "Markdown" | "HTML";
}

/** Slack platform configuration */
export interface SlackNotificationConfig {
  enabled: boolean;
  /** Slack incoming webhook URL */
  webhookUrl: string;
  /** Optional channel override */
  channel?: string;
  /** Optional username override */
  username?: string;
  /** Optional mention to prepend to messages (e.g. "<!here>", "<@UXXXXXXXX>") */
  mention?: string;
}

/** Generic webhook configuration */
export interface WebhookNotificationConfig {
  enabled: boolean;
  /** Webhook URL (POST with JSON body) */
  url: string;
  /** Optional custom headers */
  headers?: Record<string, string>;
  /** Optional HTTP method override (default: POST) */
  method?: "POST" | "PUT";
}

/** Platform config union */
export type PlatformConfig =
  | DiscordNotificationConfig
  | DiscordBotNotificationConfig
  | TelegramNotificationConfig
  | SlackNotificationConfig
  | WebhookNotificationConfig;

/** Per-event notification configuration */
export interface EventNotificationConfig {
  /** Whether this event triggers notifications */
  enabled: boolean;
  /** Custom message template (optional, uses default if not set) */
  messageTemplate?: string;
  /** Platform overrides for this event (inherits from top-level if not set) */
  discord?: DiscordNotificationConfig;
  "discord-bot"?: DiscordBotNotificationConfig;
  telegram?: TelegramNotificationConfig;
  slack?: SlackNotificationConfig;
  webhook?: WebhookNotificationConfig;
}

/** Top-level notification configuration (stored in .omx-config.json) */
export interface FullNotificationConfig {
  /** Global enable/disable for all notifications */
  enabled: boolean;

  /** Notification verbosity level (default: "session") */
  verbosity?: VerbosityLevel;

  /** Default platform configs (used when event-specific config is not set) */
  discord?: DiscordNotificationConfig;
  "discord-bot"?: DiscordBotNotificationConfig;
  telegram?: TelegramNotificationConfig;
  slack?: SlackNotificationConfig;
  webhook?: WebhookNotificationConfig;

  /** Per-event configuration */
  events?: {
    "session-start"?: EventNotificationConfig;
    "session-stop"?: EventNotificationConfig;
    "session-end"?: EventNotificationConfig;
    "session-idle"?: EventNotificationConfig;
    "ask-user-question"?: EventNotificationConfig;
  };
}

/** Payload sent with each notification */
export interface FullNotificationPayload {
  /** The event that triggered this notification */
  event: NotificationEvent;
  /** Session identifier */
  sessionId: string;
  /** Pre-formatted message text */
  message: string;
  /** ISO timestamp */
  timestamp: string;
  /** Current tmux session name (if in tmux) */
  tmuxSession?: string;
  /** Project directory path */
  projectPath?: string;
  /** Basename of the project directory */
  projectName?: string;
  /** Active OMX modes during this session */
  modesUsed?: string[];
  /** Context summary of what was done */
  contextSummary?: string;
  /** Session duration in milliseconds */
  durationMs?: number;
  /** Number of agents spawned */
  agentsSpawned?: number;
  /** Number of agents completed */
  agentsCompleted?: number;
  /** Stop/end reason */
  reason?: string;
  /** Active mode name (for stop events) */
  activeMode?: string;
  /** Current iteration (for stop events) */
  iteration?: number;
  /** Max iterations (for stop events) */
  maxIterations?: number;
  /** Question text (for ask-user-question events) */
  question?: string;
  /** Incomplete task count */
  incompleteTasks?: number;
  /** tmux pane ID for reply injection target */
  tmuxPaneId?: string;
  /** Captured tmux pane output (tail lines) for session-level notifications */
  tmuxTail?: string;
  /** Agent name (populated by extensibility plugins, not set by core Codex CLI hooks) */
  agentName?: string;
  /** Agent type (populated by extensibility plugins, not set by core Codex CLI hooks) */
  agentType?: string;
}

/** Result of a notification send attempt */
export interface NotificationResult {
  platform: NotificationPlatform;
  success: boolean;
  error?: string;
  messageId?: string;
}

/** Result of dispatching notifications for an event */
export interface DispatchResult {
  event: NotificationEvent;
  results: NotificationResult[];
  /** Whether at least one notification was sent successfully */
  anySuccess: boolean;
}

/** Named notification profiles configuration */
export interface NotificationProfilesConfig {
  /** Global enable/disable for all notifications */
  enabled: boolean;

  /** Default profile name when none specified */
  defaultProfile?: string;

  /** Named profiles, each a full notification config */
  profiles: Record<string, FullNotificationConfig>;
}

/** Top-level notifications block (supports both flat and profiled config) */
export interface NotificationsBlock extends FullNotificationConfig {
  /** Default profile name (used when profiles are defined) */
  defaultProfile?: string;

  /** Named notification profiles */
  profiles?: Record<string, FullNotificationConfig>;
}

/** Reply injection configuration */
export interface ReplyConfig {
  enabled: boolean;
  /** Polling interval in milliseconds (default: 3000) */
  pollIntervalMs: number;
  /** Maximum message length (default: 500) */
  maxMessageLength: number;
  /** Rate limit: max messages per minute (default: 10) */
  rateLimitPerMinute: number;
  /** Include visual prefix like [reply:discord] (default: true) */
  includePrefix: boolean;
  /** Authorized Discord user IDs (REQUIRED for Discord, empty = Discord disabled) */
  authorizedDiscordUserIds: string[];
}
