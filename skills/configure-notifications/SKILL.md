---
name: configure-notifications
description: Configure OMX notifications - unified entry point for all platforms
triggers:
  - "configure notifications"
  - "setup notifications"
  - "notification settings"
  - "configure discord"
  - "configure telegram"
  - "configure slack"
  - "configure openclaw"
  - "setup discord"
  - "setup telegram"
  - "setup slack"
  - "setup openclaw"
  - "discord notifications"
  - "telegram notifications"
  - "slack notifications"
  - "openclaw notifications"
  - "discord webhook"
  - "telegram bot"
  - "slack webhook"
---

# Configure OMX Notifications

Unified entry point for setting up notifications across all supported platforms.
OMX can notify you on Discord, Telegram, Slack, or your own OpenClaw gateway.

## How This Skill Works

This skill detects what's already configured, presents a menu, and delegates to the
appropriate platform skill. It also handles cross-cutting settings like verbosity,
notification profiles, reply listener, and idle cooldown.

## Step 1: Detect Currently Configured Platforms

```bash
CONFIG_FILE="$HOME/.codex/.omx-config.json"

if [ -f "$CONFIG_FILE" ]; then
  DISCORD_ENABLED=$(jq -r '.notifications.discord.enabled // false' "$CONFIG_FILE" 2>/dev/null)
  DISCORD_BOT_ENABLED=$(jq -r '.notifications["discord-bot"].enabled // false' "$CONFIG_FILE" 2>/dev/null)
  TELEGRAM_ENABLED=$(jq -r '.notifications.telegram.enabled // false' "$CONFIG_FILE" 2>/dev/null)
  SLACK_ENABLED=$(jq -r '.notifications.slack.enabled // false' "$CONFIG_FILE" 2>/dev/null)
  OPENCLAW_ENABLED=$(jq -r '.notifications.openclaw.enabled // false' "$CONFIG_FILE" 2>/dev/null)
  NOTIF_ENABLED=$(jq -r '.notifications.enabled // false' "$CONFIG_FILE" 2>/dev/null)
  VERBOSITY=$(jq -r '.notifications.verbosity // "session"' "$CONFIG_FILE" 2>/dev/null)
  COOLDOWN=$(jq -r '.notifications.idleCooldownSeconds // 60' "$CONFIG_FILE" 2>/dev/null)
  REPLY_ENABLED=$(jq -r '.notifications.reply.enabled // false' "$CONFIG_FILE" 2>/dev/null)

  echo "NOTIF_ENABLED=$NOTIF_ENABLED"
  echo "DISCORD_ENABLED=$DISCORD_ENABLED"
  echo "DISCORD_BOT_ENABLED=$DISCORD_BOT_ENABLED"
  echo "TELEGRAM_ENABLED=$TELEGRAM_ENABLED"
  echo "SLACK_ENABLED=$SLACK_ENABLED"
  echo "OPENCLAW_ENABLED=$OPENCLAW_ENABLED"
  echo "VERBOSITY=$VERBOSITY"
  echo "COOLDOWN=$COOLDOWN"
  echo "REPLY_ENABLED=$REPLY_ENABLED"
else
  echo "NO_CONFIG_FILE"
fi
```

## Step 2: Show Current Status and Main Menu

Display a summary of what's configured:

```
OMX Notification Status
───────────────────────
  Discord webhook: enabled / not configured
  Discord bot:     enabled / not configured
  Telegram:        enabled / not configured
  Slack:           enabled / not configured
  OpenClaw:        enabled / not configured

  Verbosity:       session (default)
  Idle cooldown:   60s
  Reply listener:  disabled
```

Then use AskUserQuestion:

**Question:** "What would you like to configure?"

**Options:**
1. **Discord** - Webhook or bot notifications to Discord channels
2. **Telegram** - Bot notifications to personal or group chats
3. **Slack** - Incoming webhook notifications to Slack channels
4. **OpenClaw** - Self-hosted HTTP or CLI command gateway
5. **Cross-cutting settings** - Verbosity, idle cooldown, profiles, reply listener
6. **Disable all notifications** - Turn off all notification dispatching

## Step 3: Delegate to Platform Skill

Based on the user's choice, invoke the appropriate platform skill:

- **Discord** → invoke `/configure-discord`
- **Telegram** → invoke `/configure-telegram`
- **Slack** → invoke `/configure-slack`
- **OpenClaw** → invoke `/configure-openclaw`
- **Cross-cutting settings** → continue with Step 4 below
- **Disable all** → continue with Step 5 below

When delegating, say: "Starting the [Platform] configuration wizard..." and invoke the skill.

## Step 4: Cross-Cutting Settings

If the user chose "Cross-cutting settings":

### 4a. Verbosity

Use AskUserQuestion:

**Question:** "How verbose should notifications be?"

**Options:**
1. **session (Recommended)** - Start, idle, stop, end events + tmux snippet
2. **minimal** - Start, stop, end only (no idle events, no tmux tail)
3. **agent** - All session events plus ask-user-question prompts
4. **verbose** - Everything including tool call output

Write verbosity to config:

```bash
echo "$(cat "$CONFIG_FILE")" | jq \
  --arg verbosity "$VERBOSITY" \
  '.notifications.verbosity = $verbosity' > "$CONFIG_FILE"
```

Env var alternative: `OMX_NOTIFY_VERBOSITY=session`

### 4b. Idle Notification Cooldown

Use AskUserQuestion:

**Question:** "How often should idle notifications fire at most? (in seconds)"

**Options:**
1. **60 seconds (default)** - At most once per minute
2. **300 seconds** - At most once per 5 minutes
3. **0 (disabled)** - Send every turn with no throttling
4. **Custom** - Enter a number of seconds

Write the cooldown to config:

```bash
echo "$(cat "$CONFIG_FILE")" | jq \
  --argjson cooldown "$COOLDOWN_SECONDS" \
  '.notifications.idleCooldownSeconds = $cooldown' > "$CONFIG_FILE"
```

Env var alternative: `OMX_IDLE_COOLDOWN_SECONDS=60`

### 4c. Notification Profiles

Explain that profiles let the user have different notification configs per context:

```
Notification Profiles
─────────────────────
Profiles let you switch notification targets based on context.
For example: a "work" profile for your work Slack, a "personal"
profile for your personal Telegram.

Activate a profile with: OMX_NOTIFY_PROFILE=work
or set a default: .omx-config.json > notifications.defaultProfile
```

Use AskUserQuestion:

**Question:** "Would you like to configure notification profiles?"

**Options:**
1. **Yes** - Set up named profiles
2. **No, use flat config** - Keep the current single-config setup

If yes, guide the user to manually add profiles under `notifications.profiles` in `.omx-config.json`, and set `defaultProfile`.

### 4d. Reply Listener

Explain the reply listener:

```
Reply Listener
──────────────
The reply listener lets you send messages back to Codex from
Discord (bot) or Telegram. When OMX asks for input, you can
reply directly from your phone or messaging app.

Requires:
  - Discord Bot or Telegram platform configured
  - OMX_REPLY_ENABLED=true in your shell profile
  - For Discord: OMX_REPLY_DISCORD_USER_IDS=<your user ID>
    (only messages from these IDs are accepted for security)
```

Use AskUserQuestion:

**Question:** "Would you like to enable the reply listener?"

**Options:**
1. **Yes** - Enable two-way communication from Discord/Telegram
2. **No** - Keep notifications one-way only

If yes, write to config:

```bash
echo "$(cat "$CONFIG_FILE")" | jq \
  '.notifications.reply = (.notifications.reply // {}) |
   .notifications.reply.enabled = true' > "$CONFIG_FILE"
```

And remind them to set `OMX_REPLY_ENABLED=true` and (for Discord) `OMX_REPLY_DISCORD_USER_IDS`.

## Step 5: Disable All Notifications

If the user chose "Disable all notifications":

Use AskUserQuestion:

**Question:** "Are you sure you want to disable all notifications?"

**Options:**
1. **Yes, disable all** - Set notifications.enabled = false
2. **No, go back** - Return to the main menu

If confirmed:

```bash
echo "$(cat "$CONFIG_FILE")" | jq \
  '.notifications.enabled = false' > "$CONFIG_FILE"
```

Confirm: "Notifications disabled. Re-enable anytime by running /configure-notifications."

## Step 6: After Configuration

After completing any platform or setting configuration, offer to configure another:

Use AskUserQuestion:

**Question:** "Would you like to configure another platform or setting?"

**Options:**
1. **Yes** - Return to the main menu (Step 2)
2. **No, I'm done** - Show final summary and exit

## Final Summary

Display a summary of all active notification platforms:

```
OMX Notification Configuration Complete!
─────────────────────────────────────────
  Active platforms:
    Discord webhook: enabled
    Telegram:        enabled

  Verbosity:       session
  Idle cooldown:   60s
  Reply listener:  disabled

Config saved to: ~/.codex/.omx-config.json

Quick reference — env vars:
  OMX_DISCORD_WEBHOOK_URL=...
  OMX_TELEGRAM_BOT_TOKEN=...
  OMX_TELEGRAM_CHAT_ID=...
  OMX_SLACK_WEBHOOK_URL=...
  OMX_NOTIFY_VERBOSITY=session
  OMX_IDLE_COOLDOWN_SECONDS=60
  OMX_OPENCLAW=1

Run /configure-notifications again to update any settings.
```
