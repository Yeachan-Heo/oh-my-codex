# Guia de integração OpenClaw (ajuste de prompts localizado)

> [← Back to Docs Home](./index.html) · [Integrations Landing](./integrations.html)

**Language Switcher:** [English](./openclaw-integration.md) | [한국어](./openclaw-integration.ko.md) | [日本語](./openclaw-integration.ja.md) | [简体中文](./openclaw-integration.zh.md) | [繁體中文](./openclaw-integration.zh-TW.md) | [Tiếng Việt](./openclaw-integration.vi.md) | [Español](./openclaw-integration.es.md) | [Português](./openclaw-integration.pt.md) | [Русский](./openclaw-integration.ru.md) | [Türkçe](./openclaw-integration.tr.md) | [Deutsch](./openclaw-integration.de.md) | [Français](./openclaw-integration.fr.md) | [Italiano](./openclaw-integration.it.md) | [Українська](./openclaw-integration.uk.md)


Esta página localiza a seção **“Prompt tuning guide (concise + context-aware)”** da documentação principal em inglês.

Para a documentação completa de integração (gateways, hooks, verificação), veja o [English guide](./openclaw-integration.md).

## Ajuste de prompts (conciso + sensível ao contexto)

## Onde editar os templates de prompt

- `notifications.openclaw.hooks["session-start"].instruction`
- `notifications.openclaw.hooks["session-idle"].instruction`
- `notifications.openclaw.hooks["ask-user-question"].instruction`
- `notifications.openclaw.hooks["stop"].instruction`
- `notifications.openclaw.hooks["session-end"].instruction`

## Tokens de contexto recomendados

- Sempre incluir: `{{sessionId}}`, `{{tmuxSession}}`
- Conforme evento: `{{projectName}}`, `{{question}}`, `{{reason}}`

## Estratégia de verbosidade

- `minimal`: avisos muito curtos
- `session`: contexto operacional conciso (recomendado)
- `verbose`: mais contexto de status/ação/risco

## Comando rápido de atualização (jq)

```bash
CONFIG_FILE="$HOME/.codex/.omx-config.json"

jq '.notifications.verbosity = "verbose" |
    .notifications.openclaw.hooks["session-start"].instruction = "[session-start|exec]\nproject={{projectName}} session={{sessionId}} tmux={{tmuxSession}}\n요약: 시작 맥락 1문장\n우선순위: 지금 할 일 1~2개\n주의사항: 리스크/의존성(없으면 없음)" |
    .notifications.openclaw.hooks["session-idle"].instruction = "[session-idle|exec]\nsession={{sessionId}} tmux={{tmuxSession}}\n요약: idle 원인 1문장\n복구계획: 즉시 조치 1~2개\n의사결정: 사용자 입력 필요 여부" |
    .notifications.openclaw.hooks["ask-user-question"].instruction = "[ask-user-question|exec]\nsession={{sessionId}} tmux={{tmuxSession}} question={{question}}\n핵심질문: 필요한 답변 1문장\n영향: 미응답 시 영향 1문장\n권장응답: 가장 빠른 답변 형태" |
    .notifications.openclaw.hooks["stop"].instruction = "[session-stop|exec]\nsession={{sessionId}} tmux={{tmuxSession}}\n요약: 중단 사유\n현재상태: 저장/미완료 항목\n재개: 첫 액션 1개" |
    .notifications.openclaw.hooks["session-end"].instruction = "[session-end|exec]\nproject={{projectName}} session={{sessionId}} tmux={{tmuxSession}} reason={{reason}}\n성과: 완료 결과 1~2문장\n검증: 확인/테스트 결과\n다음: 후속 액션 1~2개"'   "$CONFIG_FILE" > "$CONFIG_FILE.tmp" && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
```