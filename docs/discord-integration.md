# Discord integration setup: webhook URL vs bot token

OMX supports two Discord notification surfaces. They are separate Discord concepts and are configured with separate OMX keys:

- **Incoming webhook URL**: an HTTPS endpoint for posting outbound notifications into one Discord channel. It is simple, channel-scoped, and does not log in as a Discord bot user.
- **Bot token**: a secret token for a Discord Developer Portal application/bot. It lets OMX use the Discord Bot API for bot-identity sends and reply/status workflows that need channel reads or message correlation.

Keep both values private. Do not paste webhook URLs or bot tokens in public issues, logs, screenshots, or shared config.

## Which credential do I need?

| OMX mode / goal | Required Discord credential(s) | OMX config platform | Typical env names |
| --- | --- | --- | --- |
| Webhook-only outbound notifications | One incoming webhook URL | `notifications.discord` | `OMX_DISCORD_WEBHOOK_URL` |
| Bot-only outbound notifications | Bot token + target channel ID | `notifications["discord-bot"]` | `OMX_DISCORD_NOTIFIER_BOT_TOKEN`, `OMX_DISCORD_NOTIFIER_CHANNEL` |
| Reply listener / `status` replies to tracked OMX notifications | Bot token + target channel ID + authorized Discord user IDs; enable replies | `notifications["discord-bot"]` plus `notifications.reply` | `OMX_DISCORD_NOTIFIER_BOT_TOKEN`, `OMX_DISCORD_NOTIFIER_CHANNEL`, `OMX_REPLY_ENABLED`, `OMX_REPLY_DISCORD_USER_IDS` |
| Hybrid webhook + bot | One incoming webhook URL, one bot token, one target channel ID | Both `notifications.discord` and `notifications["discord-bot"]` | All of the above webhook + bot env vars |

Use webhook-only mode if you only want OMX to post notifications. Use bot mode when you need Discord API features such as bot-identity delivery, reply correlation, or the reply/status listener.

## Why hybrid mode needs one webhook, not two

A webhook is already a complete outbound posting endpoint for one channel. The bot is a different Discord identity that can use the Discord API with its bot token; it does **not** need its own webhook to send bot-mode messages. In hybrid mode OMX has:

1. one webhook URL for the webhook sender, and
2. one bot token + channel ID for the bot sender/listener.

Create a second webhook only if you intentionally want a second webhook identity, a different channel, or independent rotation. It is not required just because bot mode is also configured.

## Create an incoming webhook URL

1. In Discord, open the server and channel where OMX should post.
2. Open **Server Settings** or the channel settings, then **Integrations** → **Webhooks**.
3. Choose **New Webhook**, select the target channel, name it, and copy the webhook URL.
4. Store it as `OMX_DISCORD_WEBHOOK_URL` or as `notifications.discord.webhookUrl` in `.omx-config.json`.

The webhook URL is channel-scoped. If messages appear in the wrong channel, create/copy the webhook from the intended channel's integration settings.

## Create a Discord bot token

1. Open the Discord Developer Portal and create or select an application.
2. Add a **Bot** to the application.
3. On the bot page, reset/copy the bot token. Store it as `OMX_DISCORD_NOTIFIER_BOT_TOKEN` or `notifications["discord-bot"].botToken`.
4. Invite the bot to your server from the Developer Portal OAuth2 URL generator. Select the `bot` scope and grant only the permissions OMX needs.
5. Copy the target channel ID and store it as `OMX_DISCORD_NOTIFIER_CHANNEL` or `notifications["discord-bot"].channelId`. In Discord you may need Developer Mode enabled to copy IDs.

A bot token alone is not enough: the bot must also be invited to the server and must be able to see/post in the target channel.

## Minimal bot permissions and intents

For outbound bot notifications, grant the bot in the target channel:

- View Channel
- Send Messages

For reply/status workflows, also grant:

- Read Message History
- Add Reactions, if you want acknowledgement reactions to succeed

Basic outbound sends do not require privileged gateway intents. If you enable workflows that read message content through a bot/reply listener and your Discord application settings require it, enable **Message Content Intent** for that bot in the Developer Portal. Keep privileged intents off unless your workflow needs them.

## Configuration examples

Prefer environment variables for secrets. JSON examples below show the supported `.omx-config.json` shape, but you can omit secret fields from the file and provide them via env vars instead.

### Webhook-only outbound notifications

```bash
export OMX_DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/.../...'
```

```json
{
  "notifications": {
    "enabled": true,
    "discord": {
      "enabled": true,
      "webhookUrl": "https://discord.com/api/webhooks/.../..."
    }
  }
}
```

### Bot-only outbound notifications

```bash
export OMX_DISCORD_NOTIFIER_BOT_TOKEN='your-bot-token'
export OMX_DISCORD_NOTIFIER_CHANNEL='123456789012345678'
```

```json
{
  "notifications": {
    "enabled": true,
    "discord-bot": {
      "enabled": true,
      "botToken": "your-bot-token",
      "channelId": "123456789012345678"
    }
  }
}
```

### Hybrid webhook + bot with reply/status listener

```bash
export OMX_DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/.../...'
export OMX_DISCORD_NOTIFIER_BOT_TOKEN='your-bot-token'
export OMX_DISCORD_NOTIFIER_CHANNEL='123456789012345678'
export OMX_REPLY_ENABLED='true'
export OMX_REPLY_DISCORD_USER_IDS='111111111111111111,222222222222222222'
```

```json
{
  "notifications": {
    "enabled": true,
    "discord": {
      "enabled": true,
      "webhookUrl": "https://discord.com/api/webhooks/.../..."
    },
    "discord-bot": {
      "enabled": true,
      "botToken": "your-bot-token",
      "channelId": "123456789012345678"
    },
    "reply": {
      "enabled": true,
      "authorizedDiscordUserIds": ["111111111111111111", "222222222222222222"]
    }
  }
}
```

Optional shared mention for webhook and bot sends:

```bash
export OMX_DISCORD_MENTION='<@123456789012345678>'
# or a role mention such as '<@&123456789012345678>'
```

## Common failure modes

- **Invalid bot token**: regenerate the token in the Developer Portal and update `OMX_DISCORD_NOTIFIER_BOT_TOKEN` / `notifications["discord-bot"].botToken`.
- **Bot token works elsewhere but not in OMX**: confirm `OMX_DISCORD_NOTIFIER_CHANNEL` / `channelId` is the numeric channel ID, not a channel name or webhook ID.
- **Bot is not in the server**: invite the application bot with the `bot` OAuth2 scope.
- **Missing channel permissions**: grant View Channel and Send Messages; add Read Message History for reply/status workflows.
- **Webhook deleted or copied from the wrong channel**: recreate/copy the incoming webhook from the intended channel's Integrations/Webhooks page and update `OMX_DISCORD_WEBHOOK_URL` / `notifications.discord.webhookUrl`.
- **Hybrid mode posts duplicate-looking messages**: both `notifications.discord` and `notifications["discord-bot"]` are enabled, so both transports can send. Disable one if you only want one Discord message path.
- **Reply listener says Discord is disabled or no authorized users**: set `OMX_REPLY_ENABLED=true` and set `OMX_REPLY_DISCORD_USER_IDS` or `notifications.reply.authorizedDiscordUserIds` to the Discord user IDs allowed to reply.
