# OpenClaw 통합 가이드 (프롬프트 튜닝 로컬라이즈)

> [← Back to Docs Home](./index.html) · [Integrations Landing](./integrations.html)

**Language Switcher:** [English](./openclaw-integration.md) | [한국어](./openclaw-integration.ko.md) | [日本語](./openclaw-integration.ja.md) | [简体中文](./openclaw-integration.zh.md) | [繁體中文](./openclaw-integration.zh-TW.md) | [Tiếng Việt](./openclaw-integration.vi.md) | [Español](./openclaw-integration.es.md) | [Português](./openclaw-integration.pt.md) | [Русский](./openclaw-integration.ru.md) | [Türkçe](./openclaw-integration.tr.md) | [Deutsch](./openclaw-integration.de.md) | [Français](./openclaw-integration.fr.md) | [Italiano](./openclaw-integration.it.md) | [Українська](./openclaw-integration.uk.md)


이 문서는 영문 본문 가이드의 **“Prompt tuning guide (concise + context-aware)”** 섹션을 한국어로 정리한 페이지입니다.

게이트웨이/훅/검증까지 포함한 전체 통합 문서는 [English guide](./openclaw-integration.md)를 참고하세요.

## 프롬프트 튜닝 (간결 + 컨텍스트 인식)

## 프롬프트 템플릿 수정 위치

- `notifications.openclaw.hooks["session-start"].instruction`
- `notifications.openclaw.hooks["session-idle"].instruction`
- `notifications.openclaw.hooks["ask-user-question"].instruction`
- `notifications.openclaw.hooks["stop"].instruction`
- `notifications.openclaw.hooks["session-end"].instruction`

## 권장 컨텍스트 토큰

- 항상 포함: `{{sessionId}}`, `{{tmuxSession}}`
- 이벤트별 선택: `{{projectName}}`, `{{question}}`, `{{reason}}`

## verbosity 전략

- `minimal`: 매우 짧은 알림
- `session`: 간결한 운영 맥락 (권장)
- `verbose`: 상태/액션/리스크까지 확장

## 프로덕션 구성 모범 사례

### 명령 게이트웨이 설정

clawdbot agent를 사용하는 프로덕션 환경에서는 다음 설정을 권장합니다:

```json
{
  "notifications": {
    "openclaw": {
      "gateways": {
        "local": {
          "type": "command",
          "command": "(clawdbot agent --session-id omx-hooks --message {{instruction}} --thinking minimal --deliver --reply-channel discord --reply-to 'channel:1468539002985644084' --timeout 120 --json >>/tmp/omx-openclaw-agent.jsonl 2>&1 || true)",
          "timeout": 120000
        }
      }
    }
  }
}
```

**주요 설정 설명:**
- `|| true`: clawdbot 실패 시 OMX 세션이 차단되지 않도록 합니다
- `>>/tmp/omx-openclaw-agent.jsonl`: 구조화된 JSONL 로그를 append 모드로 기록합니다
- `--reply-to 'channel:CHANNEL_ID'`: 채널 별칭 대신 ID를 사용하여 안정적인 전달을 보장합니다
- `timeout: 120000`: 2분 타임아웃으로 clawdbot agent 작업이 완료될 시간을 확보합니다

### 로그 확인 명령어

```bash
# JSONL 로그에서 최근 항목 확인
tail -n 120 /tmp/omx-openclaw-agent.jsonl | jq -s '.[] | {timestamp: (.timestamp // .time), status: (.status // .error // "ok")}'

# 오류 검색
rg '"error"|"failed"|"timeout"' /tmp/omx-openclaw-agent.jsonl | tail -20
```

## 빠른 업데이트 명령어 (jq)

```bash
CONFIG_FILE="$HOME/.codex/.omx-config.json"

jq '.notifications.verbosity = "verbose" |
    .notifications.openclaw.hooks["session-start"].instruction = "[session-start|exec]\nproject={{projectName}} session={{sessionId}} tmux={{tmuxSession}}\n요약: 시작 맥락 1문장\n우선순위: 지금 할 일 1~2개\n주의사항: 리스크/의존성(없으면 없음)" |
    .notifications.openclaw.hooks["session-idle"].instruction = "[session-idle|exec]\nsession={{sessionId}} tmux={{tmuxSession}}\n요약: idle 원인 1문장\n복구계획: 즉시 조치 1~2개\n의사결정: 사용자 입력 필요 여부" |
    .notifications.openclaw.hooks["ask-user-question"].instruction = "[ask-user-question|exec]\nsession={{sessionId}} tmux={{tmuxSession}} question={{question}}\n핵심질문: 필요한 답변 1문장\n영향: 미응답 시 영향 1문장\n권장응답: 가장 빠른 답변 형태" |
    .notifications.openclaw.hooks["stop"].instruction = "[session-stop|exec]\nsession={{sessionId}} tmux={{tmuxSession}}\n요약: 중단 사유\n현재상태: 저장/미완료 항목\n재개: 첫 액션 1개" |
    .notifications.openclaw.hooks["session-end"].instruction = "[session-end|exec]\nproject={{projectName}} session={{sessionId}} tmux={{tmuxSession}} reason={{reason}}\n성과: 완료 결과 1~2문장\n검증: 확인/테스트 결과\n다음: 후속 액션 1~2개"'   "$CONFIG_FILE" > "$CONFIG_FILE.tmp" && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
```