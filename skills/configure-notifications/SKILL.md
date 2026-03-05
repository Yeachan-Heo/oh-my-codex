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

Unified and only entry point for notification setup.

- **Native integrations (first-class):** Discord, Telegram, Slack
- **Generic extensibility integrations:** `custom_webhook_command`, `custom_cli_command`

> Standalone configure skills (`configure-discord`, `configure-telegram`, `configure-slack`, `configure-openclaw`) are removed.

## Step 1: Inspect Current State

```bash
CONFIG_FILE="$HOME/.codex/.omx-config.json"

if [ -f "$CONFIG_FILE" ]; then
  jq -r '
    {
      notifications_enabled: (.notifications.enabled // false),
      discord: (.notifications.discord.enabled // false),
      discord_bot: (.notifications["discord-bot"].enabled // false),
      telegram: (.notifications.telegram.enabled // false),
      slack: (.notifications.slack.enabled // false),
      openclaw: (.notifications.openclaw.enabled // false),
      custom_webhook_command: (.notifications.custom_webhook_command.enabled // false),
      custom_cli_command: (.notifications.custom_cli_command.enabled // false),
      verbosity: (.notifications.verbosity // "session"),
      idleCooldownSeconds: (.notifications.idleCooldownSeconds // 60),
      reply_enabled: (.notifications.reply.enabled // false)
    }
  ' "$CONFIG_FILE"
else
  echo "NO_CONFIG_FILE"
fi
```

## Step 2: Main Menu

Use AskUserQuestion:

**Question:** "What would you like to configure?"

**Options:**
1. **Discord (native)** - webhook or bot
2. **Telegram (native)** - bot token + chat id
3. **Slack (native)** - incoming webhook
4. **Generic webhook command** - `custom_webhook_command`
5. **Generic CLI command** - `custom_cli_command`
6. **Cross-cutting settings** - verbosity, idle cooldown, profiles, reply listener
7. **Disable all notifications** - set `notifications.enabled = false`

## Step 3: Configure Native Platforms (Discord / Telegram / Slack)

Collect and validate platform-specific values, then write directly under native keys:

- Discord webhook: `notifications.discord`
- Discord bot: `notifications["discord-bot"]`
- Telegram: `notifications.telegram`
- Slack: `notifications.slack`

Do not write these as generic command/webhook aliases.

## Step 4: Configure Generic Extensibility

### 4a) `custom_webhook_command`

Use AskUserQuestion to collect:
- URL
- Optional headers
- Optional method (`POST` default, or `PUT`)
- Optional event list (`session-end`, `ask-user-question`, `session-start`, `session-idle`, `stop`)
- Optional instruction template

Write:

```bash
jq \
  --arg url "$URL" \
  --arg method "${METHOD:-POST}" \
  --arg instruction "${INSTRUCTION:-OMX event {{event}} for {{projectPath}}}" \
  '.notifications = (.notifications // {enabled: true}) |
   .notifications.enabled = true |
   .notifications.custom_webhook_command = {
     enabled: true,
     url: $url,
     method: $method,
     instruction: $instruction,
     events: ["session-end", "ask-user-question"]
   }' "$CONFIG_FILE" > "$CONFIG_FILE.tmp" && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
```

### 4b) `custom_cli_command`

Use AskUserQuestion to collect:
- Command template (supports `{{event}}`, `{{instruction}}`, `{{sessionId}}`, `{{projectPath}}`)
- Optional event list
- Optional instruction template

Write:

```bash
jq \
  --arg command "$COMMAND_TEMPLATE" \
  --arg instruction "${INSTRUCTION:-OMX event {{event}} for {{projectPath}}}" \
  '.notifications = (.notifications // {enabled: true}) |
   .notifications.enabled = true |
   .notifications.custom_cli_command = {
     enabled: true,
     command: $command,
     instruction: $instruction,
     events: ["session-end", "ask-user-question"]
   }' "$CONFIG_FILE" > "$CONFIG_FILE.tmp" && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
```

> Activation gate: OpenClaw-backed dispatch is active only when `OMX_OPENCLAW=1`.
> For command gateways, also require `OMX_OPENCLAW_COMMAND=1`.
> Optional timeout env override: `OMX_OPENCLAW_COMMAND_TIMEOUT_MS` (ms).

### 4b-1) OpenClaw + Clawdbot Agent Workflow (recommended for dev)

If the user explicitly asks to route hook notifications through **clawdbot agent turns**
(not direct message/webhook forwarding), use a command gateway that invokes
`clawdbot agent` and delivers back to Discord.

Notes:
- Hook name mapping is intentional: notifications `session-stop` -> OpenClaw hook `stop`.
- OMX shell-escapes template substitutions for command gateways (including `{{instruction}}`).
- Keep `instruction` templates concise and avoid untrusted shell metacharacters.
- During troubleshooting, avoid swallowing command output; route it to a log file.
- Timeout precedence: `gateways.<name>.timeout` > `OMX_OPENCLAW_COMMAND_TIMEOUT_MS` > `5000`.
- For clawdbot agent workflows, set `gateways.<name>.timeout` to `120000` (recommended).
- For dev operations, enforce Korean output in all hook instructions.
- Include both `session={{sessionId}}` and `tmux={{tmuxSession}}` in hook text for traceability.
- If follow-up is needed, explicitly instruct clawdbot to consult `SOUL.md` and continue in `#omc-dev`.
- **Error handling**: Append `|| true` to prevent OMX hook failures from blocking the session.
- **JSONL logging**: Use `.jsonl` extension and append (`>>`) for structured log aggregation.
- **Reply target format**: Use `--reply-to 'channel:CHANNEL_ID'` for reliability (preferred over channel aliases).

Example (targeting `#omc-dev` with production-tested settings):

```bash
jq \
  --arg command "(clawdbot agent --session-id omx-hooks --message {{instruction}} --thinking minimal --deliver --reply-channel discord --reply-to 'channel:1468539002985644084' --timeout 120 --json >>/tmp/omx-openclaw-agent.jsonl 2>&1 || true)" \
  '.notifications = (.notifications // {enabled: true}) |
   .notifications.enabled = true |
   .notifications.verbosity = "verbose" |
   .notifications.events = (.notifications.events // {}) |
   .notifications.events["session-start"] = {enabled: true} |
   .notifications.events["session-idle"] = {enabled: true} |
   .notifications.events["ask-user-question"] = {enabled: true} |
   .notifications.events["session-stop"] = {enabled: true} |
   .notifications.events["session-end"] = {enabled: true} |
   .notifications.openclaw = (.notifications.openclaw // {}) |
   .notifications.openclaw.enabled = true |
   .notifications.openclaw.gateways = (.notifications.openclaw.gateways // {}) |
   .notifications.openclaw.gateways["local"] = {
     type: "command",
     command: $command,
     timeout: 120000
   } |
   .notifications.openclaw.hooks = (.notifications.openclaw.hooks // {}) |
   .notifications.openclaw.hooks["session-start"] = {
     enabled: true,
     gateway: "local",
     instruction: "OMX hook=session-start project={{projectName}} session={{sessionId}} tmux={{tmuxSession}}. 한국어로 상태를 공유하고 SOUL.md를 참고해 필요한 후속 조치를 #omc-dev에 안내하세요."
   } |
   .notifications.openclaw.hooks["session-idle"] = {
     enabled: true,
     gateway: "local",
     instruction: "OMX hook=session-idle project={{projectName}} session={{sessionId}} tmux={{tmuxSession}}. 한국어로 idle 상황을 간단히 공유하고 진행중인 작업 팔로업을 안내하세요."
   } |
   .notifications.openclaw.hooks["ask-user-question"] = {
     enabled: true,
     gateway: "local",
     instruction: "OMX hook=ask-user-question session={{sessionId}} tmux={{tmuxSession}} question={{question}}. 한국어로 사용자 응답 필요를 #omc-dev에 알리고 즉시 액션 아이템을 제시하세요."
   } |
   .notifications.openclaw.hooks["stop"] = {
     enabled: true,
     gateway: "local",
     instruction: "OMX hook=session-stop project={{projectName}} session={{sessionId}} tmux={{tmuxSession}}. 한국어로 중단 상태와 정리 액션을 SOUL.md 기준으로 전달하세요."
   } |
   .notifications.openclaw.hooks["session-end"] = {
     enabled: true,
     gateway: "local",
     instruction: "OMX hook=session-end project={{projectName}} session={{sessionId}} tmux={{tmuxSession}} reason={{reason}}. 한국어로 완료 요약을 1줄로 남기고 필요한 후속 조치를 안내하세요."
   }' "$CONFIG_FILE" > "$CONFIG_FILE.tmp" && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
```

Verification for this mode:

```bash
clawdbot agent --session-id omx-hooks --message "OMX hook test via clawdbot agent path" \
  --thinking minimal --deliver --reply-channel discord --reply-to 'channel:1468539002985644084' --timeout 120 --json
```

Dev runbook (Korean + tmux follow-up):

```bash
# 1) identify active OMX tmux sessions
tmux list-sessions -F '#{session_name}' | rg '^omx-' || true

# 2) confirm hook templates include session/tmux context
jq '.notifications.openclaw.hooks' "$CONFIG_FILE"

# 3) inspect agent JSONL logs when delivery looks broken
tail -n 120 /tmp/omx-openclaw-agent.jsonl | jq -s '.[] | {timestamp: (.timestamp // .time), status: (.status // .error // "ok")}'

# 4) check for recent errors in logs
rg '"error"|"failed"|"timeout"' /tmp/omx-openclaw-agent.jsonl | tail -20
```

### 4c) Compatibility + precedence contract

OMX accepts both:
- explicit `notifications.openclaw` schema (legacy/runtime shape)
- generic aliases (`custom_webhook_command`, `custom_cli_command`)

Deterministic precedence:
1. `notifications.openclaw` **wins** when present and valid.
2. Generic aliases are ignored in that case (with warning).

## Step 5: Cross-Cutting Settings

### Verbosity
- minimal / session (recommended) / agent / verbose

### Idle cooldown
- `notifications.idleCooldownSeconds`

### Profiles
- `notifications.profiles`
- `notifications.defaultProfile`

### Reply listener
- `notifications.reply.enabled`
- env gates: `OMX_REPLY_ENABLED=true`, and for Discord `OMX_REPLY_DISCORD_USER_IDS=...`

## Step 6: Disable All Notifications

```bash
jq '.notifications.enabled = false' "$CONFIG_FILE" > "$CONFIG_FILE.tmp" && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
```

## Step 7: Verification Guidance

After writing config, run a smoke check:

```bash
npm run build
```

For OpenClaw-like HTTP integrations, verify both:
- `/hooks/wake` smoke test
- `/hooks/agent` delivery verification

## Final Summary Template

Show:
- Native platforms enabled
- Generic aliases enabled (`custom_webhook_command`, `custom_cli_command`)
- Whether explicit `notifications.openclaw` exists (and therefore overrides aliases)
- Verbosity + idle cooldown + reply listener state
- Config path (`~/.codex/.omx-config.json`)
