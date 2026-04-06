# Посібник з інтеграції OpenClaw (локалізоване налаштування промптів)

> [← Повернутися на головну Docs](./index.html) · [Сторінка інтеграцій](./integrations.html)

**Language Switcher:** [English](./openclaw-integration.md) | [한국어](./openclaw-integration.ko.md) | [日本語](./openclaw-integration.ja.md) | [简体中文](./openclaw-integration.zh.md) | [繁體中文](./openclaw-integration.zh-TW.md) | [Tiếng Việt](./openclaw-integration.vi.md) | [Español](./openclaw-integration.es.md) | [Português](./openclaw-integration.pt.md) | [Русский](./openclaw-integration.ru.md) | [Türkçe](./openclaw-integration.tr.md) | [Deutsch](./openclaw-integration.de.md) | [Français](./openclaw-integration.fr.md) | [Italiano](./openclaw-integration.it.md) | [Українська](./openclaw-integration.uk.md)


Ця сторінка локалізує розділ **«Prompt tuning guide (concise + context-aware)»** з основної англомовної документації.

Повний посібник з інтеграції (gateway, hooks, перевірка) див. у [English guide](./openclaw-integration.md).

## Налаштування промптів (стисло + з урахуванням контексту)

## Де редагувати шаблони промптів

- `notifications.openclaw.hooks["session-start"].instruction`
- `notifications.openclaw.hooks["session-idle"].instruction`
- `notifications.openclaw.hooks["ask-user-question"].instruction`
- `notifications.openclaw.hooks["stop"].instruction`
- `notifications.openclaw.hooks["session-end"].instruction`

## Рекомендовані контекстні токени

- Завжди включати: `{{sessionId}}`, `{{tmuxSession}}`
- За подією: `{{projectName}}`, `{{question}}`, `{{reason}}`

## Стратегія деталізації (verbosity)

- `minimal`: дуже короткі сповіщення
- `session`: стислий операційний контекст (рекомендовано)
- `verbose`: розширений контекст статусу/дій/ризиків

## Швидка команда оновлення (jq)

```bash
CONFIG_FILE="$HOME/.codex/.omx-config.json"

jq '.notifications.verbosity = "verbose" |
    .notifications.openclaw.hooks["session-start"].instruction = "[session-start|exec]\nproject={{projectName}} session={{sessionId}} tmux={{tmuxSession}}\nпідсумок: контекст старту 1 реченням\nпріоритет: що робити зараз 1–2 пункти\nувага: ризики/залежності (якщо немає — немає)" |
    .notifications.openclaw.hooks["session-idle"].instruction = "[session-idle|exec]\nsession={{sessionId}} tmux={{tmuxSession}}\nпідсумок: причина idle 1 реченням\nплан відновлення: негайні дії 1–2 пункти\nрішення: чи потрібен ввід користувача" |
    .notifications.openclaw.hooks["ask-user-question"].instruction = "[ask-user-question|exec]\nsession={{sessionId}} tmux={{tmuxSession}} question={{question}}\nключове питання: потрібна відповідь 1 реченням\nвплив: наслідки відсутності відповіді 1 реченням\nрекомендована відповідь: найшвидший формат відповіді" |
    .notifications.openclaw.hooks["stop"].instruction = "[session-stop|exec]\nsession={{sessionId}} tmux={{tmuxSession}}\nпідсумок: причина зупинки\nпоточний стан: збережені/незавершені елементи\nвідновлення: перша дія 1 пункт" |
    .notifications.openclaw.hooks["session-end"].instruction = "[session-end|exec]\nproject={{projectName}} session={{sessionId}} tmux={{tmuxSession}} reason={{reason}}\nрезультат: завершені результати 1–2 реченнями\nперевірка: підтвердження/результати тестів\nдалі: наступні дії 1–2 пункти"'   "$CONFIG_FILE" > "$CONFIG_FILE.tmp" && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
```
