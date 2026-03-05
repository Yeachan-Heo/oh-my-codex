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

## Prompt tuning guide (concise + context-aware)

For OpenClaw integrations, the most important quality lever is the hook
`instruction` template under:

- `notifications.openclaw.hooks["session-start"].instruction`
- `notifications.openclaw.hooks["session-idle"].instruction`
- `notifications.openclaw.hooks["ask-user-question"].instruction`
- `notifications.openclaw.hooks["stop"].instruction`
- `notifications.openclaw.hooks["session-end"].instruction`

### Recommended context tokens

Always include:

- `{{sessionId}}` for cross-log traceability
- `{{tmuxSession}}` for direct tmux follow-up targeting

Include when relevant:

- `{{projectName}}`
- `{{question}}` (`ask-user-question`)
- `{{reason}}` (`session-end`)

### Structured instruction format

For production deployments, use a structured format that clawdbot agents can parse efficiently:

```
[event|exec]
project={{projectName}} session={{sessionId}} tmux={{tmuxSession}}
필드1: 값
필드2: 값
```

The `[event|exec]` prefix indicates this is an executable hook that requires agent action.
Korean field names (요약, 우선순위, 주의사항, 성과, 검증, 다음) provide consistent structure
for dev teams using Korean as their primary language.

### Verbosity strategy

- `minimal`: very short pings (high signal, low narrative)
- `session` (**recommended default**): concise operational context
- `verbose`: richer status + action + risk framing

### Executive-summary verbose profile (example)

Use this profile when you want detailed but quickly scannable notifications:

```json
{
  "notifications": {
    "verbosity": "verbose",
    "openclaw": {
      "hooks": {
        "session-start": {
          "enabled": true,
          "gateway": "local",
          "instruction": "[session-start|exec]\nproject={{projectName}} session={{sessionId}} tmux={{tmuxSession}}\n요약: 시작 맥락 1문장\n우선순위: 지금 할 일 1~2개\n주의사항: 리스크/의존성(없으면 없음)"
        },
        "session-idle": {
          "enabled": true,
          "gateway": "local",
          "instruction": "[session-idle|exec]\nsession={{sessionId}} tmux={{tmuxSession}}\n요약: idle 원인 1문장\n복구계획: 즉시 조치 1~2개\n의사결정: 사용자 입력 필요 여부"
        },
        "ask-user-question": {
          "enabled": true,
          "gateway": "local",
          "instruction": "[ask-user-question|exec]\nsession={{sessionId}} tmux={{tmuxSession}} question={{question}}\n핵심질문: 필요한 답변 1문장\n영향: 미응답 시 영향 1문장\n권장응답: 가장 빠른 답변 형태"
        },
        "stop": {
          "enabled": true,
          "gateway": "local",
          "instruction": "[session-stop|exec]\nsession={{sessionId}} tmux={{tmuxSession}}\n요약: 중단 사유\n현재상태: 저장/미완료 항목\n재개: 첫 액션 1개"
        },
        "session-end": {
          "enabled": true,
          "gateway": "local",
          "instruction": "[session-end|exec]\nproject={{projectName}} session={{sessionId}} tmux={{tmuxSession}} reason={{reason}}\n성과: 완료 결과 1~2문장\n검증: 확인/테스트 결과\n다음: 후속 액션 1~2개"
        }
      }
    }
  }
}
```

### Quick update command (jq)

```bash
CONFIG_FILE="$HOME/.codex/.omx-config.json"

jq '.notifications.verbosity = "verbose" |
    .notifications.openclaw.hooks["session-start"].instruction = "[session-start|exec]\\nproject={{projectName}} session={{sessionId}} tmux={{tmuxSession}}\\n요약: 시작 맥락 1문장\\n우선순위: 지금 할 일 1~2개\\n주의사항: 리스크/의존성(없으면 없음)" |
    .notifications.openclaw.hooks["session-idle"].instruction = "[session-idle|exec]\\nsession={{sessionId}} tmux={{tmuxSession}}\\n요약: idle 원인 1문장\\n복구계획: 즉시 조치 1~2개\\n의사결정: 사용자 입력 필요 여부" |
    .notifications.openclaw.hooks["ask-user-question"].instruction = "[ask-user-question|exec]\\nsession={{sessionId}} tmux={{tmuxSession}} question={{question}}\\n핵심질문: 필요한 답변 1문장\\n영향: 미응답 시 영향 1문장\\n권장응답: 가장 빠른 답변 형태" |
    .notifications.openclaw.hooks["stop"].instruction = "[session-stop|exec]\\nsession={{sessionId}} tmux={{tmuxSession}}\\n요약: 중단 사유\\n현재상태: 저장/미완료 항목\\n재개: 첫 액션 1개" |
    .notifications.openclaw.hooks["session-end"].instruction = "[session-end|exec]\\nproject={{projectName}} session={{sessionId}} tmux={{tmuxSession}} reason={{reason}}\\n성과: 완료 결과 1~2문장\\n검증: 확인/테스트 결과\\n다음: 후속 액션 1~2개"' \
  "$CONFIG_FILE" > "$CONFIG_FILE.tmp" && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
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
>
> **Production best practices:**
> - Use `|| true` at the end of the command to prevent OMX hook failures from blocking sessions
> - Use `.jsonl` extension with append (`>>`) for structured log aggregation
> - Use `--reply-to 'channel:CHANNEL_ID'` format for reliable Discord delivery (preferred over aliases)

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
          "command": "(clawdbot agent --session-id omx-hooks --message {{instruction}} --thinking minimal --deliver --reply-channel discord --reply-to 'channel:1468539002985644084' --timeout 120 --json >>/tmp/omx-openclaw-agent.jsonl 2>&1 || true)",
          "timeout": 120000
        }
      },
      "hooks": {
        "session-start": {
          "enabled": true,
          "gateway": "local",
          "instruction": "[session-start|exec]\nproject={{projectName}} session={{sessionId}} tmux={{tmuxSession}}\n요약: 시작 맥락 1문장\n우선순위: 지금 할 일 1~2개\n주의사항: 리스크/의존성(없으면 없음)"
        },
        "session-idle": {
          "enabled": true,
          "gateway": "local",
          "instruction": "[session-idle|exec]\nsession={{sessionId}} tmux={{tmuxSession}}\n요약: idle 원인 1문장\n복구계획: 즉시 조치 1~2개\n의사결정: 사용자 입력 필요 여부"
        },
        "ask-user-question": {
          "enabled": true,
          "gateway": "local",
          "instruction": "[ask-user-question|exec]\nsession={{sessionId}} tmux={{tmuxSession}} question={{question}}\n핵심질문: 필요한 답변 1문장\n영향: 미응답 시 영향 1문장\n권장응답: 가장 빠른 답변 형태"
        },
        "stop": {
          "enabled": true,
          "gateway": "local",
          "instruction": "[session-stop|exec]\nsession={{sessionId}} tmux={{tmuxSession}}\n요약: 중단 사유\n현재상태: 저장/미완료 항목\n재개: 첫 액션 1개"
        },
        "session-end": {
          "enabled": true,
          "gateway": "local",
          "instruction": "[session-end|exec]\nproject={{projectName}} session={{sessionId}} tmux={{tmuxSession}} reason={{reason}}\n성과: 완료 결과 1~2문장\n검증: 확인/테스트 결과\n다음: 후속 액션 1~2개"
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
- **Prefer `--reply-to 'channel:CHANNEL_ID'` format** over channel aliases for reliability.
  - Example: `--reply-to 'channel:1468539002985644084'` (for #omc-dev)
  - Channel aliases like `#omc-dev` may fail if the bot doesn't have the channel cached.

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
# Inspect structured JSONL logs
tail -n 120 /tmp/omx-openclaw-agent.jsonl | jq -s '.[] | {timestamp: (.timestamp // .time), status: (.status // .error // "ok")}'

# Search for errors in logs
rg '"error"|"failed"|"timeout"' /tmp/omx-openclaw-agent.jsonl | tail -20

# Manual retry with production-tested settings
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
- **Hook failures blocking sessions**: ensure command ends with `|| true` to prevent OMX from waiting on clawdbot failures.
- **Missing logs**: use `.jsonl` extension with append (`>>`) for persistent structured logging.
- **Discord delivery failures**: use `--reply-to 'channel:CHANNEL_ID'` format instead of channel aliases.
