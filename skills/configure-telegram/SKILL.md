---
name: configure-telegram
description: Configure Telegram bot notifications via natural language
triggers:
  - "configure telegram"
  - "setup telegram"
  - "telegram notifications"
  - "telegram bot"
---

# Configure Telegram Notifications

Set up Telegram notifications so OMX can message you when sessions end, need input, or complete background tasks.

## How This Skill Works

This is an interactive, natural-language configuration skill. Walk the user through setup by asking questions with AskUserQuestion. Write the result to `~/.claude/.omc-config.json`.

## Step 1: Detect Existing Configuration

```bash
CONFIG_FILE="$HOME/.claude/.omc-config.json"

if [ -f "$CONFIG_FILE" ]; then
  HAS_TELEGRAM=$(jq -r '.notifications.telegram.enabled // false' "$CONFIG_FILE" 2>/dev/null)
  CHAT_ID=$(jq -r '.notifications.telegram.chatId // empty' "$CONFIG_FILE" 2>/dev/null)
  PARSE_MODE=$(jq -r '.notifications.telegram.parseMode // "Markdown"' "$CONFIG_FILE" 2>/dev/null)

  if [ "$HAS_TELEGRAM" = "true" ]; then
    echo "EXISTING_CONFIG=true"
    echo "CHAT_ID=$CHAT_ID"
    echo "PARSE_MODE=$PARSE_MODE"
  else
    echo "EXISTING_CONFIG=false"
  fi
else
  echo "NO_CONFIG_FILE"
fi
```

If existing config is found, show the user what's currently configured and ask if they want to update or reconfigure.

## Step 2: Create a Telegram Bot

Guide the user through creating a bot if they don't have one:

```
To set up Telegram notifications, you need a Telegram bot token and your chat ID.

CREATE A BOT (if you don't have one):
1. Open Telegram and search for @BotFather
2. Send /newbot
3. Choose a name (e.g., "My OMX Notifier")
4. Choose a username (e.g., "my_omc_bot")
5. BotFather will give you a token like: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz

GET YOUR CHAT ID:
1. Start a chat with your new bot (send /start)
2. Visit: https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
3. Look for "chat":{"id":YOUR_CHAT_ID}
   - Personal chat IDs are positive numbers (e.g., 123456789)
   - Group chat IDs are negative numbers (e.g., -1001234567890)
```

## Step 3: Collect Bot Token

Use AskUserQuestion:

**Question:** "Paste your Telegram bot token (from @BotFather)"

The user will type their token in the "Other" field.

**Validate** the token:
- Must match pattern: `digits:alphanumeric` (e.g., `123456789:ABCdefGHI...`)
- If invalid, explain the format and ask again

## Step 4: Collect Chat ID

Use AskUserQuestion:

**Question:** "Paste your Telegram chat ID (the number from getUpdates API)"

The user will type their chat ID in the "Other" field.

**Validate** the chat ID:
- Must be a number (positive for personal, negative for groups)
- If invalid, offer to help them find it:

```bash
# Help user find their chat ID
BOT_TOKEN="USER_PROVIDED_TOKEN"
echo "Fetching recent messages to find your chat ID..."
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates" | jq '.result[-1].message.chat.id // .result[-1].message.from.id // "No messages found - send /start to your bot first"'
```

## Step 5: Choose Parse Mode

Use AskUserQuestion:

**Question:** "Which message format do you prefer?"

**Options:**
1. **Markdown (Recommended)** - Bold, italic, code blocks with Markdown syntax
2. **HTML** - Bold, italic, code with HTML tags

## Step 6: Configure Events

Use AskUserQuestion with multiSelect:

**Question:** "Which events should trigger Telegram notifications?"

**Options (multiSelect: true):**
1. **Session end (Recommended)** - When a Claude session finishes
2. **Input needed** - When Claude is waiting for your response (great for long-running tasks)
3. **Session start** - When a new session begins
4. **Session continuing** - When a persistent mode keeps the session alive

Default selection: session-end + ask-user-question.

## Step 7: Write Configuration

Read the existing config, merge the new Telegram settings, and write back:

```bash
CONFIG_FILE="$HOME/.claude/.omc-config.json"
mkdir -p "$(dirname "$CONFIG_FILE")"

if [ -f "$CONFIG_FILE" ]; then
  EXISTING=$(cat "$CONFIG_FILE")
else
  EXISTING='{}'
fi

# BOT_TOKEN, CHAT_ID, PARSE_MODE are collected from user
echo "$EXISTING" | jq \
  --arg token "$BOT_TOKEN" \
  --arg chatId "$CHAT_ID" \
  --arg parseMode "$PARSE_MODE" \
  '.notifications = (.notifications // {enabled: true}) |
   .notifications.enabled = true |
   .notifications.telegram = {
     enabled: true,
     botToken: $token,
     chatId: $chatId,
     parseMode: $parseMode
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
1. **Yes, test now (Recommended)** - Send a test message to your Telegram chat
2. **No, I'll test later** - Skip testing

### If testing:

```bash
BOT_TOKEN="USER_PROVIDED_TOKEN"
CHAT_ID="USER_PROVIDED_CHAT_ID"
PARSE_MODE="Markdown"

RESPONSE=$(curl -s -w "\n%{http_code}" \
  "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -d "chat_id=${CHAT_ID}" \
  -d "parse_mode=${PARSE_MODE}" \
  -d "text=OMX test notification - Telegram is configured!")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -1)

if [ "$HTTP_CODE" = "200" ]; then
  echo "Test notification sent successfully!"
else
  echo "Failed (HTTP $HTTP_CODE):"
  echo "$BODY" | jq -r '.description // "Unknown error"' 2>/dev/null || echo "$BODY"
fi
```

Report success or failure. Common issues:
- **401 Unauthorized**: Bot token is invalid
- **400 Bad Request: chat not found**: Chat ID is wrong, or user hasn't sent `/start` to the bot
- **Network error**: Check connectivity to api.telegram.org

## Step 9: Confirm

Display the final configuration summary:

```
Telegram Notifications Configured!

  Bot:        @your_bot_username
  Chat ID:    123456789
  Format:     Markdown
  Events:     session-end, ask-user-question

Config saved to: ~/.claude/.omc-config.json

You can also set these via environment variables:
  OMX_TELEGRAM_BOT_TOKEN=123456789:ABCdefGHI...
  OMX_TELEGRAM_CHAT_ID=123456789

To reconfigure: /configure-telegram
To configure Discord: /configure-discord
```

## Environment Variable Alternative

Users can skip this wizard entirely by setting env vars in their shell profile:

```bash
export OMX_TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
export OMX_TELEGRAM_CHAT_ID="123456789"
```

Env vars are auto-detected by the notification system without needing `.omc-config.json`.
