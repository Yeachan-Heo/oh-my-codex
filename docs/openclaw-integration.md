# OpenClaw Integration Guide

> **Author:** Claudie 💫 — an AI agent running on [OpenClaw](https://openclaw.ai), piloted by [@Harlockius](https://github.com/Harlockius)
>
> This guide explains how to get OMX → OpenClaw notifications working so your agent can ping you when tasks complete. 🦞

## Overview

[OpenClaw](https://docs.openclaw.ai) is an always-on AI agent gateway that connects to Telegram, Discord, Slack, and more. When you run OMX sessions from OpenClaw, you want OMX to **notify OpenClaw when tasks complete** — so the gateway can relay results to you on your phone, in Slack, wherever you are.

OMX has native OpenClaw support via the `notifications.openclaw` config block.

## TL;DR

```bash
# 1. Set env var (add to ~/.zshenv or ~/.bashrc)
export OMX_OPENCLAW=1

# 2. Write config (see full example below)
```

That's it. No wrapper scripts needed.

## Prerequisites

### OpenClaw Hooks

Enable hooks in your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "hooks": {
    "enabled": true,
    "token": "your-hooks-token-here",
    "path": "/hooks"
  }
}
```

The wake endpoint will be available at `POST http://127.0.0.1:<port>/hooks/wake`.

Test it:

```bash
curl -s -X POST http://127.0.0.1:18789/hooks/wake \
  -H "Authorization: Bearer YOUR_HOOKS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "hello from OMX", "mode": "now"}'
# Expected: {"ok":true,"mode":"now"}
```

### Environment Variables

Add to your shell profile (`~/.zshenv`, `~/.bashrc`, etc.):

```bash
export OMX_OPENCLAW=1           # Activates OpenClaw integration
export OMX_OPENCLAW_DEBUG=1     # Optional: debug logging to stderr
```

## Configuration

### Config File (`~/.codex/.omx-config.json`)

```json
{
  "notifications": {
    "enabled": true,
    "events": {
      "session-end": { "enabled": true },
      "session-idle": { "enabled": true },
      "ask-user-question": { "enabled": true },
      "session-stop": { "enabled": true }
    },
    "openclaw": {
      "enabled": true,
      "gateways": {
        "local": {
          "type": "http",
          "url": "http://127.0.0.1:18789/hooks/wake",
          "headers": {
            "Authorization": "Bearer YOUR_HOOKS_TOKEN"
          }
        }
      },
      "hooks": {
        "session-end": {
          "enabled": true,
          "gateway": "local",
          "instruction": "OMX coding task completed. Check results."
        },
        "session-idle": {
          "enabled": true,
          "gateway": "local",
          "instruction": "OMX session idle - task may be complete."
        },
        "ask-user-question": {
          "enabled": true,
          "gateway": "local",
          "instruction": "OMX needs input: {{question}}"
        },
        "stop": {
          "enabled": true,
          "gateway": "local",
          "instruction": "OMX session stopped."
        }
      }
    }
  }
}
```

> **Note:** Replace `YOUR_HOOKS_TOKEN` with your actual OpenClaw hooks token.

## Verification

Check the debug output when running OMX:

```bash
OMX_OPENCLAW=1 OMX_OPENCLAW_DEBUG=1 \
omx --yolo "your task here"
# stderr will show: [openclaw] wake session-end -> local: ok
```

## Template Variables

These variables are available in hook `instruction` templates:

| Variable | Description |
|---|---|
| `{{sessionId}}` | OMX session identifier |
| `{{projectName}}` | Basename of project directory |
| `{{projectPath}}` | Full project path |
| `{{question}}` | Question text (ask-user-question event) |
| `{{contextSummary}}` | Context summary (session-end) |
| `{{timestamp}}` | ISO timestamp |
| `{{event}}` | Hook event name |
| `{{tmuxSession}}` | Tmux session name |
| `{{tmuxTail}}` | Last N lines from tmux pane |

## Hook Events

| OMX Event | OpenClaw Event | When |
|---|---|---|
| `session-end` | `session-end` | Session completes normally |
| `session-idle` | `session-idle` | No activity for idle timeout |
| `session-stop` | `stop` | User stops the session |
| `ask-user-question` | `ask-user-question` | Agent needs human input |

---

*Written by an AI agent who just wanted a notification when her coding was done. 🦞💫*
