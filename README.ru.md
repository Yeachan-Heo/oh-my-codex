# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Ваш codex не одинок.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

> **[Website](https://yeachan-heo.github.io/oh-my-codex-website/)** | **[Documentation](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** | **[CLI Reference](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** | **[Workflows](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** | **[GitHub](https://github.com/Yeachan-Heo/oh-my-codex)** | **[npm](https://www.npmjs.com/package/oh-my-codex)**

Слой мультиагентной оркестрации для [OpenAI Codex CLI](https://github.com/openai/codex).

## Языки

- [English](./README.md)
- [한국어 (Korean)](./README.ko.md)
- [日本語 (Japanese)](./README.ja.md)
- [简体中文 (Chinese Simplified)](./README.zh.md)
- [繁體中文 (Chinese Traditional)](./README.zh-TW.md)
- [Tiếng Việt (Vietnamese)](./README.vi.md)
- [Español (Spanish)](./README.es.md)
- [Português (Portuguese)](./README.pt.md)
- [Русский (Russian)](./README.ru.md)
- [Türkçe (Turkish)](./README.tr.md)
- [Deutsch (German)](./README.de.md)
- [Français (French)](./README.fr.md)
- [Italiano (Italian)](./README.it.md)


OMX превращает Codex из однопользовательского агента в координированную систему:
- Role prompts (`/prompts:name`) для специализированных агентов
- Workflow skills (`$name`) для повторяемых режимов выполнения
- Командная оркестрация в tmux (`omx team`, `$team`)
- Постоянное состояние и память через MCP-серверы

## Почему OMX

Codex CLI хорошо справляется с прямыми задачами. OMX добавляет структуру для более крупной работы:
- Декомпозиция и поэтапное выполнение (`team-plan -> team-prd -> team-exec -> team-verify -> team-fix`)
- Постоянное состояние жизненного цикла режимов (`.omx/state/`)
- Поверхности памяти и блокнота для длительных сессий
- Операционные элементы управления для запуска, проверки и отмены

OMX — это дополнение, а не форк. Он использует нативные точки расширения Codex.

## Требования

- macOS или Linux (Windows через WSL2)
- Node.js >= 20
- Установленный Codex CLI (`npm install -g @openai/codex`)
- Настроенная аутентификация Codex

## Быстрый старт (3 минуты)

```bash
npm install -g oh-my-codex
omx setup
omx doctor
```

Рекомендуемый профиль запуска для доверенной среды:

```bash
omx --xhigh --madmax
```

## Новое в v0.5.0

- **Настройка с учётом области** через `omx setup --scope user|project` для гибких режимов установки.
- **Маршрутизация Spark worker** через `--spark` / `--madmax-spark` — рабочие команды могут использовать `gpt-5.3-codex-spark` без принудительной модели лидера.
- **Консолидация каталога** — удалены устаревшие промпты (`deep-executor`, `scientist`) и 9 устаревших навыков для более компактной поверхности.
- **Уровни подробности уведомлений** для детализированного управления выводом CCNotifier.

## Первая сессия

Внутри Codex:

```text
/prompts:architect "analyze current auth boundaries"
/prompts:executor "implement input validation in login"
$plan "ship OAuth callback safely"
$team 3:executor "fix all TypeScript errors"
```

Из терминала:

```bash
omx team 4:executor "parallelize a multi-module refactor"
omx team status <team-name>
omx team shutdown <team-name>
```

## Базовая модель

OMX устанавливает и связывает следующие слои:

```text
User
  -> Codex CLI
    -> AGENTS.md (мозг оркестрации)
    -> ~/.codex/prompts/*.md (каталог промптов агентов)
    -> ~/.agents/skills/*/SKILL.md (каталог навыков)
    -> ~/.codex/config.toml (функции, уведомления, MCP)
    -> .omx/ (состояние выполнения, память, планы, журналы)
```

## Основные команды

```bash
omx                # Запустить Codex (+ HUD в tmux при наличии)
omx setup          # Установить промпты/навыки/конфиг по области + проект AGENTS.md/.omx
omx doctor         # Диагностика установки/среды выполнения
omx doctor --team  # Диагностика Team/swarm
omx team ...       # Запуск/статус/возобновление/завершение рабочих tmux
omx status         # Показать активные режимы
omx cancel         # Отменить активные режимы выполнения
omx reasoning <mode> # low|medium|high|xhigh
omx tmux-hook ...  # init|status|validate|test
omx hooks ...      # init|status|validate|test (рабочий процесс расширений плагинов)
omx hud ...        # --watch|--json|--preset
omx help
```

## Расширение Hooks (Дополнительная поверхность)

OMX теперь включает `omx hooks` для создания шаблонов плагинов и валидации.

- `omx tmux-hook` по-прежнему поддерживается и не изменён.
- `omx hooks` является дополнительным и не заменяет рабочие процессы tmux-hook.
- Файлы плагинов располагаются в `.omx/hooks/*.mjs`.
- Плагины по умолчанию отключены; включите с помощью `OMX_HOOK_PLUGINS=1`.

Полный рабочий процесс расширений и модель событий описаны в `docs/hooks-extension.md`.

## Флаги запуска

```bash
--yolo
--high
--xhigh
--madmax
--force
--dry-run
--verbose
--scope <user|project>  # только для setup
```

`--madmax` соответствует Codex `--dangerously-bypass-approvals-and-sandbox`.
Используйте только в доверенных/внешних sandbox-окружениях.

### Политика workingDirectory MCP (опциональное усиление)

По умолчанию инструменты MCP state/memory/trace принимают `workingDirectory`, предоставленный вызывающей стороной.
Чтобы ограничить это, задайте список разрешённых корней:

```bash
export OMX_MCP_WORKDIR_ROOTS="/path/to/project:/path/to/another-root"
```

При установке значения `workingDirectory` за пределами этих корней будут отклонены.

## Codex-First управление промптами

По умолчанию OMX внедряет:

```text
-c model_instructions_file="<cwd>/AGENTS.md"
```

Это добавляет проектные инструкции `AGENTS.md` в команды запуска Codex.
Расширяет поведение Codex, но не заменяет/обходит основные системные политики Codex.

Управление:

```bash
OMX_BYPASS_DEFAULT_SYSTEM_PROMPT=0 omx     # отключить внедрение AGENTS.md
OMX_MODEL_INSTRUCTIONS_FILE=/path/to/instructions.md omx
```

## Командный режим

Используйте командный режим для масштабной работы, которая выигрывает от параллельных исполнителей.

Жизненный цикл:

```text
start -> assign scoped lanes -> monitor -> verify terminal tasks -> shutdown
```

Операционные команды:

```bash
omx team <args>
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

Важное правило: не завершайте работу, пока задачи находятся в состоянии `in_progress`, если только не прерываете выполнение.

### Политика очистки Ralph

Когда команда работает в режиме ralph (`omx team ralph ...`), очистка при завершении
применяет специальную политику, отличающуюся от обычного пути:

| Поведение | Обычная команда | Команда Ralph |
|---|---|---|
| Принудительное завершение при сбое | Выбрасывает `shutdown_gate_blocked` | Обходит шлюз, логирует событие `ralph_cleanup_policy` |
| Автоматическое удаление веток | Удаляет ветки worktree при откате | Сохраняет ветки (`skipBranchDeletion`) |
| Логирование завершения | Стандартное событие `shutdown_gate` | Дополнительное событие `ralph_cleanup_summary` с разбивкой задач |

Политика Ralph автоматически определяется из состояния командного режима (`linked_ralph`) или
может быть указана явно через `omx team shutdown <name> --ralph`.

Выбор Worker CLI для рабочих команды:

```bash
OMX_TEAM_WORKER_CLI=auto    # по умолчанию; использует claude, если worker --model содержит "claude"
OMX_TEAM_WORKER_CLI=codex   # принудительно Codex CLI
OMX_TEAM_WORKER_CLI=claude  # принудительно Claude CLI
OMX_TEAM_WORKER_CLI_MAP=codex,codex,claude,claude  # CLI для каждого рабочего (длина=1 или количество рабочих)
OMX_TEAM_AUTO_INTERRUPT_RETRY=0  # опционально: отключить адаптивный откат queue->resend
```

Примечания:
- Аргументы запуска рабочих по-прежнему передаются через `OMX_TEAM_WORKER_LAUNCH_ARGS`.
- `OMX_TEAM_WORKER_CLI_MAP` переопределяет `OMX_TEAM_WORKER_CLI` для выбора на уровне рабочего.
- Отправка триггеров по умолчанию использует адаптивные повторные попытки (queue/submit, затем безопасный откат clear-line+resend при необходимости).
- В режиме Claude worker OMX запускает рабочих как обычный `claude` (без дополнительных аргументов) и игнорирует явные переопределения `--model` / `--config` / `--effort`, чтобы Claude использовал стандартный `settings.json`.

## Что записывает `omx setup`

- `.omx/setup-scope.json` (сохранённая область установки)
- Установки в зависимости от области:
  - `user`: `~/.codex/prompts/`, `~/.agents/skills/`, `~/.codex/config.toml`, `~/.omx/agents/`
  - `project`: `./.codex/prompts/`, `./.agents/skills/`, `./.codex/config.toml`, `./.omx/agents/`
- Поведение при запуске: если сохранённая область — `project`, `omx` автоматически использует `CODEX_HOME=./.codex` (если `CODEX_HOME` ещё не задан).
- Существующий `AGENTS.md` сохраняется по умолчанию. В интерактивных TTY-запусках setup запрашивает подтверждение перед перезаписью; `--force` перезаписывает без запроса (проверки безопасности активных сессий остаются в силе).
- Обновления `config.toml` (для обеих областей):
  - `notify = ["node", "..."]`
  - `model_reasoning_effort = "high"`
  - `developer_instructions = "..."`
  - `[features] multi_agent = true, child_agents_md = true`
  - Записи MCP-серверов (`omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`)
  - `[tui] status_line`
- Проектный `AGENTS.md`
- Директории `.omx/` и конфигурация HUD

## Агенты и навыки

- Промпты: `prompts/*.md` (устанавливаются в `~/.codex/prompts/` для `user`, `./.codex/prompts/` для `project`)
- Навыки: `skills/*/SKILL.md` (устанавливаются в `~/.agents/skills/` для `user`, `./.agents/skills/` для `project`)

Примеры:
- Агенты: `architect`, `planner`, `executor`, `debugger`, `verifier`, `security-reviewer`
- Навыки: `autopilot`, `plan`, `team`, `ralph`, `ultrawork`, `cancel`

## Структура проекта

```text
oh-my-codex/
  bin/omx.js
  src/
    cli/
    team/
    mcp/
    hooks/
    hud/
    config/
    modes/
    notifications/
    verification/
  prompts/
  skills/
  templates/
  scripts/
```

## Разработка

```bash
git clone https://github.com/Yeachan-Heo/oh-my-codex.git
cd oh-my-codex
npm install
npm run build
npm test
```

## Документация

- **[Полная документация](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** — Полное руководство
- **[Справочник CLI](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** — Все команды `omx`, флаги и инструменты
- **[Руководство по уведомлениям](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#notifications)** — Настройка Discord, Telegram, Slack и webhook
- **[Рекомендуемые рабочие процессы](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** — Проверенные в бою цепочки навыков для типичных задач
- **[Примечания к выпускам](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#release-notes)** — Что нового в каждой версии

## Примечания

- Полный журнал изменений: `CHANGELOG.md`
- Руководство по миграции (после v0.4.4 mainline): `docs/migration-mainline-post-v0.4.4.md`
- Заметки о покрытии и паритете: `COVERAGE.md`
- Рабочий процесс расширений hook: `docs/hooks-extension.md`
- Детали установки и участия: `CONTRIBUTING.md`

## Благодарности

Вдохновлено проектом [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode), адаптировано для Codex CLI.

## Лицензия

MIT
