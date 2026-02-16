import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMention,
  parseMentionAllowedMentions,
  buildConfigFromEnv,
} from '../config.js';

const ENV_KEYS = [
  'OMX_DISCORD_NOTIFIER_BOT_TOKEN',
  'OMX_DISCORD_NOTIFIER_CHANNEL',
  'OMX_DISCORD_WEBHOOK_URL',
  'OMX_DISCORD_MENTION',
  'OMX_TELEGRAM_BOT_TOKEN',
  'OMX_TELEGRAM_NOTIFIER_BOT_TOKEN',
  'OMX_TELEGRAM_CHAT_ID',
  'OMX_TELEGRAM_NOTIFIER_CHAT_ID',
  'OMX_TELEGRAM_NOTIFIER_UID',
  'OMX_SLACK_WEBHOOK_URL',
];

function clearEnvVars(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe('validateMention', () => {
  it('accepts valid user mention', () => {
    assert.equal(validateMention('<@12345678901234567>'), '<@12345678901234567>');
  });

  it('accepts valid user mention with exclamation (nickname)', () => {
    assert.equal(validateMention('<@!12345678901234567>'), '<@!12345678901234567>');
  });

  it('accepts valid role mention', () => {
    assert.equal(validateMention('<@&12345678901234567>'), '<@&12345678901234567>');
  });

  it('accepts 20-digit IDs', () => {
    assert.equal(validateMention('<@12345678901234567890>'), '<@12345678901234567890>');
  });

  it('rejects @everyone', () => {
    assert.equal(validateMention('@everyone'), undefined);
  });

  it('rejects @here', () => {
    assert.equal(validateMention('@here'), undefined);
  });

  it('rejects arbitrary text', () => {
    assert.equal(validateMention('hello world'), undefined);
  });

  it('rejects mention with trailing text', () => {
    assert.equal(validateMention('<@123456789012345678> extra'), undefined);
  });

  it('rejects too-short ID', () => {
    assert.equal(validateMention('<@1234>'), undefined);
  });

  it('returns undefined for empty string', () => {
    assert.equal(validateMention(''), undefined);
  });

  it('returns undefined for undefined', () => {
    assert.equal(validateMention(undefined), undefined);
  });

  it('trims whitespace and validates', () => {
    assert.equal(validateMention('  <@12345678901234567>  '), '<@12345678901234567>');
  });

  it('rejects whitespace-only string', () => {
    assert.equal(validateMention('   '), undefined);
  });
});

describe('parseMentionAllowedMentions', () => {
  it('parses user mention', () => {
    assert.deepEqual(parseMentionAllowedMentions('<@12345678901234567>'), { users: ['12345678901234567'] });
  });

  it('parses nickname user mention', () => {
    assert.deepEqual(parseMentionAllowedMentions('<@!12345678901234567>'), { users: ['12345678901234567'] });
  });

  it('parses role mention', () => {
    assert.deepEqual(parseMentionAllowedMentions('<@&12345678901234567>'), { roles: ['12345678901234567'] });
  });

  it('returns empty for undefined', () => {
    assert.deepEqual(parseMentionAllowedMentions(undefined), {});
  });

  it('returns empty for invalid mention', () => {
    assert.deepEqual(parseMentionAllowedMentions('@everyone'), {});
  });
});

describe('buildConfigFromEnv', () => {
  beforeEach(() => {
    clearEnvVars();
  });

  afterEach(() => {
    clearEnvVars();
  });

  it('returns null when no env vars set', () => {
    assert.equal(buildConfigFromEnv(), null);
  });

  it('builds discord-bot config from env vars', () => {
    process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN = 'test-token';
    process.env.OMX_DISCORD_NOTIFIER_CHANNEL = '123456';
    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.equal(config.enabled, true);
    assert.deepEqual(config['discord-bot'], {
      enabled: true,
      botToken: 'test-token',
      channelId: '123456',
      mention: undefined,
    });
  });

  it('includes validated mention in discord-bot config', () => {
    process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN = 'test-token';
    process.env.OMX_DISCORD_NOTIFIER_CHANNEL = '123456';
    process.env.OMX_DISCORD_MENTION = '<@12345678901234567>';
    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.equal(config['discord-bot']!.mention, '<@12345678901234567>');
  });

  it('rejects invalid mention in env var', () => {
    process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN = 'test-token';
    process.env.OMX_DISCORD_NOTIFIER_CHANNEL = '123456';
    process.env.OMX_DISCORD_MENTION = '@everyone';
    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.equal(config['discord-bot']!.mention, undefined);
  });

  it('builds discord webhook config from env var', () => {
    process.env.OMX_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.deepEqual(config.discord, {
      enabled: true,
      webhookUrl: 'https://discord.com/api/webhooks/test',
      mention: undefined,
    });
  });

  it('builds telegram config from env vars', () => {
    process.env.OMX_TELEGRAM_BOT_TOKEN = '123:abc';
    process.env.OMX_TELEGRAM_CHAT_ID = '999';
    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.deepEqual(config.telegram, {
      enabled: true,
      botToken: '123:abc',
      chatId: '999',
    });
  });

  it('builds slack config from env var', () => {
    process.env.OMX_SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/test';
    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.deepEqual(config.slack, {
      enabled: true,
      webhookUrl: 'https://hooks.slack.com/services/test',
    });
  });

  it('uses OMX_TELEGRAM_NOTIFIER_BOT_TOKEN as fallback', () => {
    process.env.OMX_TELEGRAM_NOTIFIER_BOT_TOKEN = '123:fallback';
    process.env.OMX_TELEGRAM_CHAT_ID = '999';
    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.equal(config.telegram!.botToken, '123:fallback');
  });

  it('uses OMX_TELEGRAM_NOTIFIER_UID as fallback for chat ID', () => {
    process.env.OMX_TELEGRAM_BOT_TOKEN = '123:abc';
    process.env.OMX_TELEGRAM_NOTIFIER_UID = 'uid-999';
    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.equal(config.telegram!.chatId, 'uid-999');
  });

  it('builds config with multiple platforms from env', () => {
    process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN = 'bot-token';
    process.env.OMX_DISCORD_NOTIFIER_CHANNEL = 'channel-123';
    process.env.OMX_TELEGRAM_BOT_TOKEN = '456:tg';
    process.env.OMX_TELEGRAM_CHAT_ID = 'chat-789';
    process.env.OMX_SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/test';

    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.equal(config.enabled, true);
    assert.equal(config['discord-bot']!.enabled, true);
    assert.equal(config.telegram!.enabled, true);
    assert.equal(config.slack!.enabled, true);
  });

  it('mention from env is shared across discord-bot and discord webhook', () => {
    process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN = 'bot-token';
    process.env.OMX_DISCORD_NOTIFIER_CHANNEL = 'channel-123';
    process.env.OMX_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
    process.env.OMX_DISCORD_MENTION = '<@12345678901234567>';

    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.equal(config['discord-bot']!.mention, '<@12345678901234567>');
    assert.equal(config.discord!.mention, '<@12345678901234567>');
  });
});
