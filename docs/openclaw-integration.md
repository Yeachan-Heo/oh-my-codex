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

# Optional global default for command gateway timeout (ms)
# Precedence: gateway timeout > env override > 5000 default
export OMX_OPENCLAW_COMMAND_TIMEOUT_MS=120000
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
>
> Command gateway timeout precedence: `gateways.<name>.timeout` > `OMX_OPENCLAW_COMMAND_TIMEOUT_MS` > `5000`.
> For `clawdbot agent` workflows, use `120000` (2 minutes) to avoid premature timeout.

For Korean-first tmux follow-up operations in `#omc-dev`, see the dev guide section below.

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
          "command": "(clawdbot agent --session-id omx-hooks --message {{instruction}} --thinking minimal --deliver --reply-channel discord --reply-to '#omc-dev' --timeout 120 --json >/tmp/omx-openclaw-agent.log 2>&1)",
          "timeout": 120000
        }
      },
      "hooks": {
        "session-start": {
          "enabled": true,
          "gateway": "local",
          "instruction": "OMX hook=session-start project={{projectName}} session={{sessionId}} tmux={{tmuxSession}}. 한국어로 간단한 상태 업데이트를 #omc-dev에 전달하고, 필요한 후속조치는 SOUL.md를 참고해 진행하세요."
        },
        "session-idle": {
          "enabled": true,
          "gateway": "local",
          "instruction": "OMX hook=session-idle project={{projectName}} session={{sessionId}} tmux={{tmuxSession}}. 한국어로 idle 상태를 짧게 공유하고, 진행중이던 작업을 SOUL.md 기준으로 팔로업하세요."
        },
        "ask-user-question": {
          "enabled": true,
          "gateway": "local",
          "instruction": "OMX hook=ask-user-question session={{sessionId}} tmux={{tmuxSession}} question={{question}}. 한국어로 사용자 응답이 필요함을 #omc-dev에 알리고 즉시 후속 요청을 남기세요."
        },
        "stop": {
          "enabled": true,
          "gateway": "local",
          "instruction": "OMX hook=session-stop project={{projectName}} session={{sessionId}} tmux={{tmuxSession}}. 한국어로 중단 상태를 공유하고 필요한 정리 액션을 SOUL.md 기준으로 수행하세요."
        },
        "session-end": {
          "enabled": true,
          "gateway": "local",
          "instruction": "OMX hook=session-end project={{projectName}} session={{sessionId}} tmux={{tmuxSession}} reason={{reason}}. 한국어로 완료 요약 1줄을 #omc-dev에 남기고 필요한 후속조치를 SOUL.md 기준으로 이어가세요."
        }
      }
    }
  }
}
```

## Dev Guide: OpenClaw + Clawdbot Agent (Korean follow-up mode)

Use this profile when `#omc-dev` should receive OpenClaw notifications as
**actual clawdbot agent turns**, with proactive follow-up behavior.

### 1) Force Korean output in hook instructions

- Write all hook instructions in Korean.
- Explicitly require Korean in each instruction template.
- Prefer Discord channel ID (`channel:<id>`) over channel alias for reliability.

Example instruction style:

```text
OMX 훅={{event}} 프로젝트={{projectName}} 세션={{sessionId}}.
반드시 한국어로 응답하세요.
OMX tmux 세션: {{tmuxSession}}.
SOUL.md 및 #omc-dev 맥락을 참고해 필요한 후속 액션이 있으면 즉시 안내하세요.
```

### 2) Track which OMX tmux session emitted the hook

- Include both `{{sessionId}}` and `{{tmuxSession}}` in every hook message.
- If `{{tmuxSession}}` is present, use that as the primary follow-up target.
- If missing, derive candidate tmux sessions from `sessionId` and current project path.

Quick checks:

```bash
tmux ls | grep '^omx-' || true
tmux list-panes -a -F '#{session_name}\t#{pane_id}\t#{pane_current_path}' | grep "$(basename "$PWD")" || true
```

### 3) SOUL.md + #omc-dev follow-up runbook

When a hook suggests active work or pending user action:

1. Read `SOUL.md` and recent `#omc-dev` context.
2. Follow up in Korean, citing `sessionId` + `tmuxSession`.
3. If action is required, state concrete next step (for example, reply needed, retry needed, or session check needed).
4. If delivery looks broken, inspect logs and retry without swallowed output.

Troubleshooting commands:

```bash
tail -n 120 /tmp/omx-openclaw-agent.log

clawdbot agent --session-id omx-hooks \
  --message "OMX hook retry 점검: session={{sessionId}} tmux={{tmuxSession}}" \
  --thinking minimal --deliver --reply-channel discord --reply-to 'channel:1468539002985644084' \
  --timeout 120 --json
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
- **Command killed by `SIGTERM`**: increase `gateways.<name>.timeout` (recommend `120000` for clawdbot agent) or set `OMX_OPENCLAW_COMMAND_TIMEOUT_MS`.
