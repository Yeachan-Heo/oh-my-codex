interface ReplyListenerLiveConfig {
  discordBotToken: string;
  discordChannelId: string;
  telegramBotToken: string;
  telegramChatId: string;
}

interface ReplyListenerLiveEnvResolution {
  enabled: boolean;
  missing: string[];
  config: ReplyListenerLiveConfig | null;
}

interface ReplyListenerLiveSmokeResult {
  discordMessageId: string;
  telegramMessageId: string;
}

interface ReplyListenerLiveSmokeDeps {
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

const LIVE_ENABLE_ENV = 'OMX_REPLY_LISTENER_LIVE';
const REQUIRED_ENV_KEYS = [
  'OMX_DISCORD_NOTIFIER_BOT_TOKEN',
  'OMX_DISCORD_NOTIFIER_CHANNEL',
  'OMX_TELEGRAM_BOT_TOKEN',
  'OMX_TELEGRAM_CHAT_ID',
] as const;

const DISCORD_API = 'https://discord.com/api/v10';
const TELEGRAM_API = 'https://api.telegram.org';
const REQUEST_TIMEOUT_MS = 10_000;

// --- Helpers ---

function requireJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} returned a non-object JSON payload`);
  }
  return value as Record<string, unknown>;
}

async function parseResponseJson(
  response: Response,
  label: string,
): Promise<Record<string, unknown>> {
  const body = (await response.json()) as unknown;
  return requireJsonObject(body, label);
}

function extractStringId(value: unknown, label: string): string {
  const id = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!id) throw new Error(`${label}: missing or empty id`);
  return id;
}

function abortAfter(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

// --- Discord ---

async function sendDiscordProbe(
  config: ReplyListenerLiveConfig,
  fetchImpl: typeof fetch,
  stamp: string,
): Promise<string> {
  const url = `${DISCORD_API}/channels/${config.discordChannelId}/messages`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${config.discordBotToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: `[omx live smoke ${stamp}] reply-listener Discord connectivity probe`,
    }),
    signal: abortAfter(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Discord live smoke failed: HTTP ${response.status}`);
  }

  const payload = await parseResponseJson(response, 'Discord sendMessage');
  return extractStringId(payload.id, 'Discord sendMessage');
}

async function deleteDiscordProbe(
  config: ReplyListenerLiveConfig,
  fetchImpl: typeof fetch,
  messageId: string,
): Promise<void> {
  await fetchImpl(
    `${DISCORD_API}/channels/${config.discordChannelId}/messages/${messageId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bot ${config.discordBotToken}` },
      signal: abortAfter(REQUEST_TIMEOUT_MS),
    },
  );
}

// --- Telegram ---

async function sendTelegramProbe(
  config: ReplyListenerLiveConfig,
  fetchImpl: typeof fetch,
  stamp: string,
): Promise<string> {
  const url = `${TELEGRAM_API}/bot${config.telegramBotToken}/sendMessage`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text: `[omx live smoke ${stamp}] reply-listener Telegram connectivity probe`,
    }),
    signal: abortAfter(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Telegram live smoke failed: HTTP ${response.status}`);
  }

  const payload = await parseResponseJson(response, 'Telegram sendMessage');
  const result = requireJsonObject(payload.result, 'Telegram sendMessage.result');
  return extractStringId(result.message_id, 'Telegram sendMessage');
}

async function deleteTelegramProbe(
  config: ReplyListenerLiveConfig,
  fetchImpl: typeof fetch,
  messageId: string,
): Promise<void> {
  await fetchImpl(`${TELEGRAM_API}/bot${config.telegramBotToken}/deleteMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      message_id: Number(messageId),
    }),
    signal: abortAfter(REQUEST_TIMEOUT_MS),
  });
}

// --- Public API ---

export function resolveReplyListenerLiveEnv(
  env: NodeJS.ProcessEnv = process.env,
): ReplyListenerLiveEnvResolution {
  const enabled = env[LIVE_ENABLE_ENV] === '1';
  if (!enabled) {
    return { enabled: false, missing: [], config: null };
  }

  const missing = REQUIRED_ENV_KEYS.filter((key) => {
    const value = env[key];
    return typeof value !== 'string' || value.trim().length === 0;
  });
  if (missing.length > 0) {
    return { enabled: true, missing: [...missing], config: null };
  }

  return {
    enabled: true,
    missing: [],
    config: {
      discordBotToken: env.OMX_DISCORD_NOTIFIER_BOT_TOKEN!.trim(),
      discordChannelId: env.OMX_DISCORD_NOTIFIER_CHANNEL!.trim(),
      telegramBotToken: env.OMX_TELEGRAM_BOT_TOKEN!.trim(),
      telegramChatId: env.OMX_TELEGRAM_CHAT_ID!.trim(),
    },
  };
}

export async function runReplyListenerLiveSmoke(
  config: ReplyListenerLiveConfig,
  deps: ReplyListenerLiveSmokeDeps = {},
): Promise<ReplyListenerLiveSmokeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? console.log;
  const stamp = new Date().toISOString();

  const discordMessageId = await sendDiscordProbe(config, fetchImpl, stamp);
  log(`Discord probe message sent: ${discordMessageId}`);
  deleteDiscordProbe(config, fetchImpl, discordMessageId).catch(() => {
    log(`Discord probe cleanup skipped for ${discordMessageId}`);
  });

  const telegramMessageId = await sendTelegramProbe(config, fetchImpl, stamp);
  log(`Telegram probe message sent: ${telegramMessageId}`);
  deleteTelegramProbe(config, fetchImpl, telegramMessageId).catch(() => {
    log(`Telegram probe cleanup skipped for ${telegramMessageId}`);
  });

  return { discordMessageId, telegramMessageId };
}

export async function main(): Promise<void> {
  // ... unchanged
}
