---
name: configure-slack
description: Configure Slack webhook notifications via natural language
triggers:
  - "configure slack"
  - "setup slack"
  - "slack notifications"
  - "slack webhook"
---

# Configure Slack Notifications

Set up Slack notifications so OMX can ping you when sessions end, need input, or complete background tasks.

## How This Skill Works

This is an interactive, natural-language configuration skill. Walk the user through setup by asking questions with AskUserQuestion. Write the result to `~/.codex/.omx-config.json`.

## Step 1: Detect Existing Configuration

```bash
CONFIG_FILE="$HOME/.codex/.omx-config.json"

if [ -f "$CONFIG_FILE" ]; then
  HAS_SLACK=$(jq -r '.notifications.slack.enabled // false' "$CONFIG_FILE" 2>/dev/null)
  WEBHOOK_URL=$(jq -r '.notifications.slack.webhookUrl // empty' "$CONFIG_FILE" 2>/dev/null)
  CHANNEL=$(jq -r '.notifications.slack.channel // empty' "$CONFIG_FILE" 2>/dev/null)
  USERNAME=$(jq -r '.notifications.slack.username // empty' "$CONFIG_FILE" 2>/dev/null)
  MENTION=$(jq -r '.notifications.slack.mention // empty' "$CONFIG_FILE" 2>/dev/null)

  if [ "$HAS_SLACK" = "true" ]; then
    echo "EXISTING_CONFIG=true"
    [ -n "$WEBHOOK_URL" ] && echo "WEBHOOK_URL=$WEBHOOK_URL"
    [ -n "$CHANNEL" ] && echo "CHANNEL=$CHANNEL"
    [ -n "$USERNAME" ] && echo "USERNAME=$USERNAME"
    [ -n "$MENTION" ] && echo "MENTION=$MENTION"
  else
    echo "EXISTING_CONFIG=false"
  fi
else
  echo "NO_CONFIG_FILE"
fi
```

If existing config is found, show the user what's currently configured and ask if they want to update or reconfigure.

## Step 2: Collect Webhook URL

Use AskUserQuestion:

**Question:** "Paste your Slack Incoming Webhook URL. To create one: Go to api.slack.com/apps > Your App > Incoming Webhooks > Add New Webhook to Workspace > Copy URL"

The user will type their webhook URL in the "Other" field.

**Validate** the URL:
- Must start with `https://hooks.slack.com/services/` or `https://hooks.slack.com/workflows/`
- If invalid, explain the format and ask again

## Step 3: Configure Channel (Optional)

Use AskUserQuestion:

**Question:** "Which Slack channel should receive notifications? (Optional — leave blank to use the webhook's default channel)"

**Options:**
1. **Use webhook default** - The channel configured in the Slack app integration
2. **Specify a channel** - Enter a channel name (e.g. `#dev-alerts`) or channel ID

Note: Overriding the channel requires the webhook to have permission for that channel.

## Step 4: Configure Mention (Optional)

Use AskUserQuestion:

**Question:** "Would you like notifications to mention (ping) someone?"

**Options:**
1. **Yes, mention a user** - Tag a user with `<@UXXXXXXXX>`
2. **Yes, mention a channel** - Tag everyone with `<!channel>` or `<!here>`
3. **No mentions** - Just post the message without pinging anyone

### If user wants to mention a user:

Ask: "What is the Slack member ID to mention? (Click the user's profile > More > Copy member ID)"

Format: `<@UXXXXXXXX>` (e.g. `<@U012AB3CD>`)

### If user wants a channel mention:

Choose between:
- `<!channel>` — notifies all channel members regardless of online status
- `<!here>` — notifies only currently active channel members

## Step 5: Configure Display Name (Optional)

Use AskUserQuestion:

**Question:** "Custom bot display name in Slack? (Shows as the message sender)"

**Options:**
1. **OMX (default)** - Display as "OMX"
2. **Codex CLI** - Display as "Codex CLI"
3. **Custom** - Enter a custom name

## Step 6: Configure Events

Use AskUserQuestion with multiSelect:

**Question:** "Which events should trigger Slack notifications?"

**Options (multiSelect: true):**
1. **Session end (Recommended)** - When a Codex session finishes
2. **Input needed** - When Codex is waiting for your response (great for long-running tasks)
3. **Session start** - When a new session begins
4. **Session continuing** - When a persistent mode keeps the session alive

Default selection: session-end + ask-user-question.

## Step 7: Write Configuration

Read the existing config, merge the new Slack settings, and write back:

```bash
CONFIG_FILE="$HOME/.codex/.omx-config.json"
mkdir -p "$(dirname "$CONFIG_FILE")"

if [ -f "$CONFIG_FILE" ]; then
  EXISTING=$(cat "$CONFIG_FILE")
else
  EXISTING='{}'
fi

# WEBHOOK_URL, CHANNEL, MENTION, USERNAME are collected from user
echo "$EXISTING" | jq \
  --arg url "$WEBHOOK_URL" \
  --arg channel "$CHANNEL" \
  --arg mention "$MENTION" \
  --arg username "$USERNAME" \
  '.notifications = (.notifications // {enabled: true}) |
   .notifications.enabled = true |
   .notifications.slack = {
     enabled: true,
     webhookUrl: $url,
     channel: (if $channel == "" then null else $channel end),
     mention: (if $mention == "" then null else $mention end),
     username: (if $username == "" then null else $username end)
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
1. **Yes, test now (Recommended)** - Send a test message to your Slack channel
2. **No, I'll test later** - Skip testing

### If testing:

```bash
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"${MENTION:+$MENTION\\n}OMX test notification - Slack is configured!\", \"username\": \"${USERNAME:-OMX}\"}" \
  "$WEBHOOK_URL")

if [ "$RESPONSE" = "200" ]; then
  echo "Test notification sent successfully!"
else
  echo "Failed (HTTP $RESPONSE). Check the webhook URL and channel permissions."
fi
```

Report success or failure. Common issues:
- **400 Bad Request**: Malformed JSON or invalid channel override
- **403 Forbidden**: Channel override not permitted by the webhook
- **404 Not Found**: Webhook URL is invalid or revoked — regenerate it in Slack

## Step 9: Confirm

Display the final configuration summary:

```
Slack Notifications Configured!

  Webhook:  https://hooks.slack.com/services/...
  Channel:  #dev-alerts (or "webhook default")
  Mention:  <!channel> (or "none")
  Username: OMX
  Events:   session-end, ask-user-question

Config saved to: ~/.codex/.omx-config.json

You can also set these via environment variables:
  OMX_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
  OMX_SLACK_MENTION=<!channel>

To reconfigure: /configure-slack
To configure Discord: /configure-discord
To configure Telegram: /configure-telegram
```

## Environment Variable Alternative

Users can skip this wizard entirely by setting env vars in their shell profile:

```bash
export OMX_SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
export OMX_SLACK_MENTION="<!channel>"  # optional
```

Env vars are auto-detected by the notification system without needing `.omx-config.json`.
