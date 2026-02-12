---
name: configure-discord
description: Configure Discord webhook/bot notifications via natural language
triggers:
  - "configure discord"
  - "setup discord"
  - "discord notifications"
  - "discord webhook"
---

# Configure Discord Notifications

Set up Discord notifications so OMX can ping you when sessions end, need input, or complete background tasks.

## How This Skill Works

This is an interactive, natural-language configuration skill. Walk the user through setup by asking questions with AskUserQuestion. Write the result to `~/.claude/.omc-config.json`.

## Step 1: Detect Existing Configuration

```bash
CONFIG_FILE="$HOME/.claude/.omc-config.json"

if [ -f "$CONFIG_FILE" ]; then
  # Check for existing discord config
  HAS_DISCORD=$(jq -r '.notifications.discord.enabled // false' "$CONFIG_FILE" 2>/dev/null)
  HAS_DISCORD_BOT=$(jq -r '.notifications["discord-bot"].enabled // false' "$CONFIG_FILE" 2>/dev/null)
  WEBHOOK_URL=$(jq -r '.notifications.discord.webhookUrl // empty' "$CONFIG_FILE" 2>/dev/null)
  MENTION=$(jq -r '.notifications.discord.mention // empty' "$CONFIG_FILE" 2>/dev/null)

  if [ "$HAS_DISCORD" = "true" ] || [ "$HAS_DISCORD_BOT" = "true" ]; then
    echo "EXISTING_CONFIG=true"
    echo "WEBHOOK_CONFIGURED=$HAS_DISCORD"
    echo "BOT_CONFIGURED=$HAS_DISCORD_BOT"
    [ -n "$WEBHOOK_URL" ] && echo "WEBHOOK_URL=$WEBHOOK_URL"
    [ -n "$MENTION" ] && echo "MENTION=$MENTION"
  else
    echo "EXISTING_CONFIG=false"
  fi
else
  echo "NO_CONFIG_FILE"
fi
```

If existing config is found, show the user what's currently configured and ask if they want to update or reconfigure.

## Step 2: Choose Discord Method

Use AskUserQuestion:

**Question:** "How would you like to send Discord notifications?"

**Options:**
1. **Webhook (Recommended)** - Create a webhook in your Discord channel. Simple, no bot needed. Just paste the URL.
2. **Bot API** - Use a Discord bot token + channel ID. More flexible, requires a bot application.

## Step 3A: Webhook Setup

If user chose Webhook:

Use AskUserQuestion:

**Question:** "Paste your Discord webhook URL. To create one: Server Settings > Integrations > Webhooks > New Webhook > Copy URL"

The user will type their webhook URL in the "Other" field.

**Validate** the URL:
- Must start with `https://discord.com/api/webhooks/` or `https://discordapp.com/api/webhooks/`
- If invalid, explain the format and ask again

## Step 3B: Bot API Setup

If user chose Bot API:

Ask two questions:

1. **"Paste your Discord bot token"** - From discord.com/developers > Your App > Bot > Token
2. **"Paste the channel ID"** - Right-click channel > Copy Channel ID (requires Developer Mode)

## Step 4: Configure Mention (User Ping)

Use AskUserQuestion:

**Question:** "Would you like notifications to mention (ping) someone?"

**Options:**
1. **Yes, mention a user** - Tag a specific user by their Discord user ID
2. **Yes, mention a role** - Tag a role by its role ID
3. **No mentions** - Just post the message without pinging anyone

### If user wants to mention a user:

Ask: "What is the Discord user ID to mention? (Right-click user > Copy User ID, requires Developer Mode)"

The mention format is: `<@USER_ID>` (e.g., `<@1465264645320474637>`)

### If user wants to mention a role:

Ask: "What is the Discord role ID to mention? (Server Settings > Roles > right-click role > Copy Role ID)"

The mention format is: `<@&ROLE_ID>` (e.g., `<@&123456789>`)

## Step 5: Configure Events

Use AskUserQuestion with multiSelect:

**Question:** "Which events should trigger Discord notifications?"

**Options (multiSelect: true):**
1. **Session end (Recommended)** - When a Claude session finishes
2. **Input needed** - When Claude is waiting for your response (great for long-running tasks)
3. **Session start** - When a new session begins
4. **Session continuing** - When a persistent mode keeps the session alive

Default selection: session-end + ask-user-question.

## Step 6: Optional Username Override

Use AskUserQuestion:

**Question:** "Custom bot display name? (Shows as the webhook sender name in Discord)"

**Options:**
1. **OMX (default)** - Display as "OMX"
2. **Codex CLI** - Display as "Codex CLI"
3. **Custom** - Enter a custom name

## Step 7: Write Configuration

Read the existing config, merge the new Discord settings, and write back:

```bash
CONFIG_FILE="$HOME/.claude/.omc-config.json"
mkdir -p "$(dirname "$CONFIG_FILE")"

if [ -f "$CONFIG_FILE" ]; then
  EXISTING=$(cat "$CONFIG_FILE")
else
  EXISTING='{}'
fi
```

### For Webhook method:

Build the notifications object with the collected values and merge into `.omc-config.json` using jq:

```bash
# WEBHOOK_URL, MENTION, USERNAME are collected from user
# EVENTS is the list of enabled events

echo "$EXISTING" | jq \
  --arg url "$WEBHOOK_URL" \
  --arg mention "$MENTION" \
  --arg username "$USERNAME" \
  '.notifications = (.notifications // {enabled: true}) |
   .notifications.enabled = true |
   .notifications.discord = {
     enabled: true,
     webhookUrl: $url,
     mention: (if $mention == "" then null else $mention end),
     username: (if $username == "" then null else $username end)
   }' > "$CONFIG_FILE"
```

### For Bot API method:

```bash
echo "$EXISTING" | jq \
  --arg token "$BOT_TOKEN" \
  --arg channel "$CHANNEL_ID" \
  --arg mention "$MENTION" \
  '.notifications = (.notifications // {enabled: true}) |
   .notifications.enabled = true |
   .notifications["discord-bot"] = {
     enabled: true,
     botToken: $token,
     channelId: $channel,
     mention: (if $mention == "" then null else $mention end)
   }' > "$CONFIG_FILE"
```

### Add event-specific config if user didn't select all events:

For each event NOT selected, disable it:

```bash
# Example: disable session-start if not selected
echo "$(cat "$CONFIG_FILE")" | jq \
  '.notifications.events = (.notifications.events // {}) |
   .notifications.events["session-start"] = {enabled: false}' > "$CONFIG_FILE"
```

## Step 8: Test the Configuration

After writing config, offer to send a test notification:

Use AskUserQuestion:

**Question:** "Send a test notification to verify the setup?"

**Options:**
1. **Yes, test now (Recommended)** - Send a test message to your Discord channel
2. **No, I'll test later** - Skip testing

### If testing:

```bash
# For webhook:
curl -s -o /dev/null -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"${MENTION:+$MENTION\\n}OMX test notification - Discord is configured!\"}" \
  "$WEBHOOK_URL"
```

Report success or failure. If it fails, help the user debug (check URL, permissions, etc.).

## Step 9: Confirm

Display the final configuration summary:

```
Discord Notifications Configured!

  Method:   Webhook / Bot API
  Mention:  <@1465264645320474637> (or "none")
  Events:   session-end, ask-user-question
  Username: OMX

Config saved to: ~/.claude/.omc-config.json

You can also set these via environment variables:
  OMX_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
  OMX_DISCORD_MENTION=<@1465264645320474637>

To reconfigure: /configure-discord
To configure Telegram: /configure-telegram
```

## Environment Variable Alternative

Users can skip this wizard entirely by setting env vars in their shell profile:

**Webhook method:**
```bash
export OMX_DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
export OMX_DISCORD_MENTION="<@1465264645320474637>"  # optional
```

**Bot API method:**
```bash
export OMX_DISCORD_NOTIFIER_BOT_TOKEN="your-bot-token"
export OMX_DISCORD_NOTIFIER_CHANNEL="your-channel-id"
export OMX_DISCORD_MENTION="<@1465264645320474637>"  # optional
```

Env vars are auto-detected by the notification system without needing `.omc-config.json`.
