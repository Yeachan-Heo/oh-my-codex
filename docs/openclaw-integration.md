# OpenClaw / Generic Notification Gateway Integration Guide

This guide covers two supported setup paths:

1. **Explicit OpenClaw schema** (`notifications.openclaw`) — runtime-native shape
2. **Generic aliases** (`custom_webhook_command`, `custom_cli_command`) — flexible setup for OpenClaw or other services

## Activation gates

```bash
# Prefer exporting a token env var in your shell profile (avoid hardcoding secrets in JSON):
export HOOKS_TOKEN="your-openclaw-hooks-token"

# Required for OpenClaw dispatch pipeline
export OMX_OPENCLAW=1

# Required in addition for command gateways
export OMX_OPENCLAW_COMMAND=1
```

## Canonical precedence contract

When both explicit OpenClaw config and generic aliases are present:

1. `notifications.openclaw` wins
2. `custom_webhook_command` / `custom_cli_command` are ignored
3. OMX emits a warning for clarity

This keeps behavior deterministic and backward compatible.

## Option A: Explicit `notifications.openclaw` (legacy/runtime shape)

```json
{
  "notifications": {
    "enabled": true,
    "openclaw": {
      "enabled": true,
      "gateways": {
        "local": {
          "type": "http",
          "url": "http://127.0.0.1:18789/hooks/agent",
          "headers": {
            "Authorization": "Bearer ${HOOKS_TOKEN}"
          }
        }
      },
      "hooks": {
        "session-end": {
          "enabled": true,
          "gateway": "local",
          "instruction": "OMX task completed for {{projectPath}}"
        },
        "ask-user-question": {
          "enabled": true,
          "gateway": "local",
          "instruction": "OMX needs input: {{question}}"
        }
      }
    }
  }
}
```

## Option B: Generic aliases (`custom_webhook_command` / `custom_cli_command`)

```json
{
  "notifications": {
    "enabled": true,
    "custom_webhook_command": {
      "enabled": true,
      "url": "http://127.0.0.1:18789/hooks/agent",
      "method": "POST",
      "headers": {
        "Authorization": "Bearer ${HOOKS_TOKEN}"
      },
      "events": ["session-end", "ask-user-question"],
      "instruction": "OMX event {{event}} for {{projectPath}}"
    },
    "custom_cli_command": {
      "enabled": true,
      "command": "~/.local/bin/my-notifier --event {{event}} --text {{instruction}}",
      "events": ["session-end"],
      "instruction": "OMX event {{event}} for {{projectPath}}"
    }
  }
}
```

These aliases are normalized by OMX into internal OpenClaw gateway mappings.

## Option C: Clawdbot agent-command workflow (recommended for dev)

Use this when you want OMX hook events to trigger **agent turns** (not plain
message/webhook forwarding), e.g. for `#omc-dev`.

> Shell safety: template variables (for example `{{instruction}}`) are interpolated into the
> command string. Keep templates simple and avoid shell metacharacters in user-derived content.
> For troubleshooting, temporarily remove output redirection and inspect command output.

```json
{
  "notifications": {
    "enabled": true,
    "verbosity": "verbose",
    "events": {
      "session-start": { "enabled": true },
      "session-idle": { "enabled": true },
      "ask-user-question": { "enabled": true },
      "session-stop": { "enabled": true },
      "session-end": { "enabled": true }
    },
    "openclaw": {
      "enabled": true,
      "gateways": {
        "local": {
          "type": "command",
          "command": "(clawdbot agent --session-id omx-hooks --message {{instruction}} --thinking minimal --deliver --reply-channel discord --reply-to '#omc-dev' --timeout 120 --json >/tmp/omx-openclaw-agent.log 2>&1)"
        }
      },
      "hooks": {
        "session-start": {
          "enabled": true,
          "gateway": "local",
          "instruction": "OMX hook=session-start project={{projectName}} session={{sessionId}}. Send concise status update."
        },
        "session-idle": {
          "enabled": true,
          "gateway": "local",
          "instruction": "OMX hook=session-idle project={{projectName}} session={{sessionId}}. Send brief idle update."
        },
        "ask-user-question": {
          "enabled": true,
          "gateway": "local",
          "instruction": "OMX hook=ask-user-question session={{sessionId}} question={{question}}. ACTION NEEDED: request user reply."
        },
        "stop": {
          "enabled": true,
          "gateway": "local",
          "instruction": "OMX hook=session-stop project={{projectName}} session={{sessionId}}. Send stop update."
        },
        "session-end": {
          "enabled": true,
          "gateway": "local",
          "instruction": "OMX hook=session-end project={{projectName}} session={{sessionId}} reason={{reason}}. Send completion summary in one line."
        }
      }
    }
  }
}
```

## Verification (required)

### A) Wake smoke test (`/hooks/wake`)

```bash
curl -sS -X POST http://127.0.0.1:18789/hooks/wake \
  -H "Authorization: Bearer ${HOOKS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"text":"OMX wake smoke test","mode":"now"}'
```

Expected pass signal: JSON includes `"ok":true`.

### B) Delivery verification (`/hooks/agent`)

```bash
curl -sS -o /tmp/omx-openclaw-agent-check.json -w "HTTP %{http_code}\n" \
  -X POST http://127.0.0.1:18789/hooks/agent \
  -H "Authorization: Bearer ${HOOKS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"message":"OMX delivery verification","instruction":"OMX delivery verification","event":"session-end","sessionId":"manual-check"}'
```

Expected pass signal: HTTP 2xx + accepted response body.

## Preflight checks

```bash
# token present
test -n "$HOOKS_TOKEN" && echo "token ok" || echo "token missing"

# reachability
curl -sS -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:18789 || echo "gateway unreachable"

# gate checks
test "$OMX_OPENCLAW" = "1" && echo "OMX_OPENCLAW=1" || echo "missing OMX_OPENCLAW=1"
test "$OMX_OPENCLAW_COMMAND" = "1" && echo "OMX_OPENCLAW_COMMAND=1" || echo "missing OMX_OPENCLAW_COMMAND=1"
```

## Pass/Fail Diagnostics

- **401/403**: invalid/missing bearer token.
- **404**: wrong path; verify `/hooks/agent` and `/hooks/wake`.
- **5xx**: gateway runtime issue; inspect logs.
- **Timeout/connection refused**: host/port/firewall issue.
- **Command gateway disabled**: set both `OMX_OPENCLAW=1` and `OMX_OPENCLAW_COMMAND=1`.
