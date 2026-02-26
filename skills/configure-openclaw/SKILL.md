---
name: configure-openclaw
description: Configure OpenClaw notification gateway via natural language
triggers:
  - "configure openclaw"
  - "setup openclaw"
  - "openclaw notifications"
  - "openclaw gateway"
---

# Configure OpenClaw Notifications

Set up OpenClaw as a notification gateway so OMX can route session events through your own HTTP endpoint or CLI command.

## What is OpenClaw?

OpenClaw is a self-hosted notification gateway that lets you receive OMX events however you want — HTTP webhooks to your own server, shell commands, or any integration you build. Unlike platform-specific notifiers (Discord, Slack), OpenClaw gives you full control over message routing and format.

**Two gateway modes:**
- **HTTP Gateway** — OMX POSTs JSON events to your HTTP endpoint
- **CLI Command Gateway** — OMX runs a shell command with event data as arguments or stdin

## How This Skill Works

This is an interactive, natural-language configuration skill. Walk the user through setup by asking questions with AskUserQuestion. Write the result to `~/.codex/.omx-config.json`.

## Step 1: Detect Existing Configuration

```bash
CONFIG_FILE="$HOME/.codex/.omx-config.json"

if [ -f "$CONFIG_FILE" ]; then
  HAS_OPENCLAW=$(jq -r '.notifications.openclaw.enabled // false' "$CONFIG_FILE" 2>/dev/null)
  GATEWAY_TYPE=$(jq -r '.notifications.openclaw.gatewayType // empty' "$CONFIG_FILE" 2>/dev/null)
  ENDPOINT=$(jq -r '.notifications.openclaw.endpoint // empty' "$CONFIG_FILE" 2>/dev/null)
  COMMAND=$(jq -r '.notifications.openclaw.command // empty' "$CONFIG_FILE" 2>/dev/null)

  if [ "$HAS_OPENCLAW" = "true" ]; then
    echo "EXISTING_CONFIG=true"
    echo "GATEWAY_TYPE=$GATEWAY_TYPE"
    [ -n "$ENDPOINT" ] && echo "ENDPOINT=$ENDPOINT"
    [ -n "$COMMAND" ] && echo "COMMAND=$COMMAND"
  else
    echo "EXISTING_CONFIG=false"
  fi
else
  echo "NO_CONFIG_FILE"
fi
```

If existing config is found, show the user what's currently configured and ask if they want to update or reconfigure.

## Step 2: Choose Gateway Type

Use AskUserQuestion:

**Question:** "Which OpenClaw gateway mode do you want to use?"

**Options:**
1. **HTTP Gateway** - OMX sends a POST request with JSON to your endpoint. Good for web servers, n8n, Zapier webhooks, or any HTTP-capable service.
2. **CLI Command Gateway** - OMX runs a shell command you specify. Good for local scripts, custom notification tools, or anything shell-scriptable.

## Step 3A: HTTP Gateway Setup

If user chose HTTP:

Use AskUserQuestion:

**Question:** "Enter your OpenClaw HTTP endpoint URL. OMX will POST JSON event data to this URL."

The user types their URL in the "Other" field.

**Validate** the URL:
- Must start with `http://` or `https://`
- If invalid, explain the format and ask again

### Optional: Secret Header

Use AskUserQuestion:

**Question:** "Add an authorization header to secure requests? (Optional)"

**Options:**
1. **Yes, add Bearer token** - Sends `Authorization: Bearer <token>`
2. **Yes, add custom header** - Specify header name and value
3. **No auth header** - Open endpoint (use firewall rules or IP allowlist instead)

If they want a Bearer token or custom header, collect the values.

## Step 3B: CLI Command Gateway Setup

If user chose CLI Command:

Use AskUserQuestion:

**Question:** "Enter the shell command OMX should run for each notification event. Use these placeholders:
- `{event}` — event name (e.g. session-end)
- `{session_id}` — session identifier
- `{project}` — project name/path
- `{message}` — formatted notification message

Example: `notify-send 'OMX: {event}' '{message}'`
Example: `~/.local/bin/my-notifier --event {event} --msg '{message}'`"

The user types their command in the "Other" field.

**IMPORTANT: Dual activation gate for CLI Command gateways**

CLI command gateways require TWO environment variables to be set:
- `OMX_OPENCLAW=1` — enables the OpenClaw gateway
- `OMX_OPENCLAW_COMMAND=1` — specifically enables CLI command execution

This two-gate design prevents accidental command execution when only the config file is present. Remind the user to set both in their shell profile.

## Step 4: Map Events

Use AskUserQuestion with multiSelect:

**Question:** "Which events should be routed through OpenClaw?"

**Options (multiSelect: true):**
1. **Session end (Recommended)** - When a Codex session finishes
2. **Input needed** - When Codex is waiting for your response
3. **Session start** - When a new session begins
4. **Session continuing** - When a persistent mode keeps the session alive

Default selection: session-end + ask-user-question.

## Step 5: Write Configuration

Read the existing config, merge the OpenClaw settings, and write back:

```bash
CONFIG_FILE="$HOME/.codex/.omx-config.json"
mkdir -p "$(dirname "$CONFIG_FILE")"

if [ -f "$CONFIG_FILE" ]; then
  EXISTING=$(cat "$CONFIG_FILE")
else
  EXISTING='{}'
fi
```

### For HTTP Gateway:

```bash
# ENDPOINT, AUTH_HEADER_NAME, AUTH_HEADER_VALUE are collected from user
echo "$EXISTING" | jq \
  --arg endpoint "$ENDPOINT" \
  --arg headerName "$AUTH_HEADER_NAME" \
  --arg headerValue "$AUTH_HEADER_VALUE" \
  '.notifications = (.notifications // {enabled: true}) |
   .notifications.enabled = true |
   .notifications.openclaw = {
     enabled: true,
     gatewayType: "http",
     endpoint: $endpoint,
     headers: (if $headerName == "" then null else {($headerName): $headerValue} end)
   }' > "$CONFIG_FILE"
```

### For CLI Command Gateway:

```bash
# COMMAND is collected from user
echo "$EXISTING" | jq \
  --arg command "$COMMAND" \
  '.notifications = (.notifications // {enabled: true}) |
   .notifications.enabled = true |
   .notifications.openclaw = {
     enabled: true,
     gatewayType: "command",
     command: $command
   }' > "$CONFIG_FILE"
```

### Add event-specific config if user didn't select all events:

```bash
# Example: disable session-start if not selected
echo "$(cat "$CONFIG_FILE")" | jq \
  '.notifications.events = (.notifications.events // {}) |
   .notifications.events["session-start"] = {enabled: false}' > "$CONFIG_FILE"
```

## Step 6: Explain Activation Gates

Regardless of gateway type, explain the activation model:

```
OpenClaw Activation Gates
─────────────────────────
OpenClaw requires environment variables to be set before it activates.
This prevents accidental notifications in shared or CI environments.

For HTTP Gateway:
  export OMX_OPENCLAW=1

For CLI Command Gateway (requires both):
  export OMX_OPENCLAW=1
  export OMX_OPENCLAW_COMMAND=1

Add these to your ~/.zshrc or ~/.bashrc.
```

## Step 7: Test the Configuration

After writing config, offer to test:

Use AskUserQuestion:

**Question:** "Send a test notification through OpenClaw to verify the setup?"

**Options:**
1. **Yes, test now (Recommended)** - Run a test dispatch
2. **No, I'll test later** - Skip testing

### If testing HTTP Gateway:

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -H "Content-Type: application/json" \
  ${AUTH_HEADER_NAME:+-H "$AUTH_HEADER_NAME: $AUTH_HEADER_VALUE"} \
  -d '{"event":"test","message":"OMX OpenClaw test notification","session_id":"test"}' \
  "$ENDPOINT"
```

### If testing CLI Command Gateway:

Replace placeholders in the command with test values and run it.

Report success or failure. If it fails, help debug (check URL accessibility, command path, permissions).

## Step 8: Confirm

Display the final configuration summary:

```
OpenClaw Gateway Configured!

  Type:     HTTP / CLI Command
  Endpoint: https://your-server/omx-hook  (HTTP only)
  Command:  notify-send 'OMX' '{message}'  (CLI only)
  Events:   session-end, ask-user-question

Config saved to: ~/.codex/.omx-config.json

Activation (add to ~/.zshrc or ~/.bashrc):
  export OMX_OPENCLAW=1
  export OMX_OPENCLAW_COMMAND=1   # CLI Command gateways only

To reconfigure: /configure-openclaw
To configure other platforms: /configure-notifications
```

## Environment Variable Reference

```bash
# Required for all OpenClaw gateways
export OMX_OPENCLAW=1

# Required additionally for CLI Command gateways
export OMX_OPENCLAW_COMMAND=1

# HTTP gateway: override endpoint URL
export OMX_OPENCLAW_URL="https://your-server/omx-hook"
```
