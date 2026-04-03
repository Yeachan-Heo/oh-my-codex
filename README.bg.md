# oh-my-codex (OMX)
![Image 1: oh-my-codex character](https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png)
_Твоят codex не е сам._

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

> **[Website](https://yeachan-heo.github.io/oh-my-codex-website/)** | **[Documentation](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** | **[CLI Reference](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** | **[Workflows](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** | **[OpenClaw Integration Guide](./docs/openclaw-integration.bg.md)** | **[GitHub](https://github.com/Yeachan-Heo/oh-my-codex)** | **[npm](https://www.npmjs.com/package/oh-my-codex)**

Слой за мултиагентна оркестрация за [OpenAI Codex CLI](https://github.com/openai/codex).

## Ново в v0.9.0 — Spark Initiative

Spark Initiative е версията, която засилва native пътя за изследване и инспекция в OMX.

- **Native harness за `omx explore`** — изпълнява изследване на хранилището в режим само за четене с по-бърз и по-строг Rust път.
- **`omx sparkshell`** — native повърхност за оператори, с резюмета на дълги изходи и явно захващане на tmux pane-ове.
- **Мултиплатформени native артефакти** — hydration пътят за `omx-explore-harness`, `omx-sparkshell` и `native-release-manifest.json` вече е част от release pipeline.
- **Подсилен CI/CD** — добавена е изрична Rust конфигурация в `build` job, както и `cargo fmt --check` и `cargo clippy -- -D warnings`.

Вижте също [release notes v0.9.0](./docs/release-notes-0.9.0.md) и [release body](./docs/release-body-0.9.0.md).

## Първа сесия

В Codex:
```
$deep-interview "clarify the auth change"
$ralplan "approve the auth plan and review tradeoffs"
$ralph "carry the approved plan to completion"
$team 3:executor "execute the approved plan in parallel"
```

От терминала:
```bash
omx team 4:executor "parallelize a multi-module refactor"
omx team status
omx team shutdown
```

## Препоръчителен работен процес

1. `$deep-interview` — когато обхватът или границите все още не са ясни.
2. `$ralplan` — за да превърнете изяснения обхват в съгласуван план за архитектура и имплементация.
3. `$team` или `$ralph` — използвайте `$team` за координирано паралелно изпълнение, или `$ralph` за устойчив цикъл на довеждане до край и верификация с един отговорен.

## Основен модел

OMX инсталира и свързва следните слоеве:
```
User
-> Codex CLI
-> AGENTS.md (мозък на оркестрацията)
-> ~/.codex/prompts/*.md (каталог с промптове за агенти)
-> ~/.codex/skills/*/SKILL.md (каталог с умения)
-> ~/.codex/config.toml (функции, нотификации, MCP)
-> .omx/ (състояние на изпълнение, памет, планове, логове)
```

## Основни команди

```bash
omx                  # Стартирай Codex (+ HUD в tmux когато е налично)
omx setup            # Инсталирай промптове/умения/конфиг по обхват + .omx на проекта + AGENTS.md за избрания обхват
omx doctor           # Диагностика на инсталация/изпълнение
omx doctor --team    # Диагностика на Team/swarm
omx team ...         # Старт/статус/възобновяване/спиране на tmux workers
omx status           # Покажи активните режими
omx cancel           # Отмени активните режими на изпълнение
omx reasoning        # low|medium|high|xhigh
omx tmux-hook ...    # init|status|validate|test
omx hooks ...        # init|status|validate|test (workflow за разширения на плъгини)
omx hud ...          # --watch|--json|--preset
omx help
```

## Разширение Hooks (Допълнителна повърхност)

OMX вече включва `omx hooks` за създаване на шаблони за плъгини и валидация.
- `omx tmux-hook` остава поддържан и непроменен.
- `omx hooks` е допълнителен и не заменя tmux-hook работните процеси.
- Файловете на плъгините се намират в `.omx/hooks/*.mjs`.
- Плагините са изключени по подразбиране; включете ги с `OMX_HOOK_PLUGINS=1`.

Пълният workflow за разширения и event модела е описан в `docs/hooks-extension.md`.

## Флагове за стартиране

```bash
--yolo
--high
--xhigh
--madmax
--force
--dry-run
--verbose
--scope              # само за setup
```

`--madmax` съответства на Codex `--dangerously-bypass-approvals-and-sandbox`.
Използвайте само в доверени/външни sandbox среди.

### Политика за workingDirectory на MCP (опционално заздравяване)

По подразбиране MCP инструментите state/memory/trace приемат `workingDirectory`, предоставен от извикващия.
За да ограничите това, задайте списък с разрешени корени:
```bash
export OMX_MCP_WORKDIR_ROOTS="/path/to/project:/path/to/another-root"
```

Когато е зададено, `workingDirectory` стойности извън тези корени ще бъдат отхвърлени.

## Codex-First управление на промптове

По подразбиране OMX инжектира:
```
-c model_instructions_file="/AGENTS.md"
```

Това обединява `AGENTS.md` от `CODEX_HOME` с проектния `AGENTS.md` (ако съществува) и след това добавя runtime overlay.
Разширява поведението на Codex, но не заменя/заобикаля основните системни политики на Codex.

Управление:
```bash
OMX_BYPASS_DEFAULT_SYSTEM_PROMPT=0 omx   # деактивирай инжектирането на AGENTS.md
OMX_MODEL_INSTRUCTIONS_FILE=/path/to/instructions.md omx
```

## Team режим

Използвайте team режим за широка работа, която се възползва от паралелни изпълнители.
Жизнен цикъл:
```
start -> assign scoped lanes -> monitor -> verify terminal tasks -> shutdown
```

Оперативни команди:
```bash
omx team
omx team status
omx team resume
omx team shutdown
```

Важно правило: не спирайте докато задачите са в състояние `in_progress`, освен ако не прекъсвате изпълнението.

### Team shutdown policy

Използвайте `omx team shutdown` след като екипът достигне крайно състояние.
Почистването на екипa вече следва един самостоятелен път; legacy linked-Ralph обработката на спиране вече не е отделен публичен workflow.

Избор на Worker CLI за workers на екипа:
```bash
OMX_TEAM_WORKER_CLI=auto           # по подразбиране; използва claude когато worker --model съдържа "claude"
OMX_TEAM_WORKER_CLI=codex          # принудително Codex CLI workers
OMX_TEAM_WORKER_CLI=claude         # принудително Claude CLI workers
OMX_TEAM_WORKER_CLI_MAP=codex,codex,claude,claude  # CLI за всеки worker (дължина=1 или брой workers)
OMX_TEAM_AUTO_INTERRUPT_RETRY=0    # опционално: деактивирай адаптивния fallback queue->resend
```

Бележки:
- Аргументите за стартиране на workers все още се споделят чрез `OMX_TEAM_WORKER_LAUNCH_ARGS`.
- `OMX_TEAM_WORKER_CLI_MAP` заменя `OMX_TEAM_WORKER_CLI` за избор на ниво worker.
- Изпращането на тригери по подразбиране използва адаптивни повторни опити (queue/submit, след това безопасен fallback clear-line+resend при необходимост).
- В Claude worker режим, OMX стартира workers като обикновен `claude` (без допълнителни аргументи за стартиране) и игнорира изричните `--model` / `--config` / `--effort` override-и, за да използва стандартния `settings.json`.

## Какво пише `omx setup`

- `.omx/setup-scope.json` (запазен обхват на инсталация)
- Инсталации в зависимост от обхвата:
- `user`: `~/.codex/prompts/`, `~/.codex/skills/`, `~/.codex/config.toml`, `~/.omx/agents/`, `~/.codex/AGENTS.md`
- `project`: `./.codex/prompts/`, `./.codex/skills/`, `./.codex/config.toml`, `./.omx/agents/`, `./AGENTS.md`
- Поведение при стартиране: ако запазеният обхват е `project`, `omx` автоматично използва `CODEX_HOME=./.codex` (ако `CODEX_HOME` вече не е зададен).
- Инструкциите за стартиране обединяват `~/.codex/AGENTS.md` (или `CODEX_HOME/AGENTS.md` ако е override-нат) с проектния `./AGENTS.md` и след това добавят runtime overlay.
- Съществуващите `AGENTS.md` файлове никога не се презаписват тихо: в интерактивен TTY setup пита преди замяна, а в неинтерактивен режим пропуска замяната без `--force` (проверките за безопасност на активни сесии остават в сила).
- Обновления на `config.toml` (за двата обхвата):
- `notify = ["node", "..."]`
- `model_reasoning_effort = "high"`
- `developer_instructions = "..."`
- `[features] multi_agent = true, child_agents_md = true`
- MCP сървър записи (`omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`)
- `[tui] status_line`
- `AGENTS.md` за избрания обхват
- Директории `.omx/` и конфигурация на HUD

## Агенти и умения

- Промптове: `prompts/*.md` (инсталирани в `~/.codex/prompts/` за `user`, `./.codex/prompts/` за `project`)
- Умения: `skills/*/SKILL.md` (инсталирани в `~/.codex/skills/` за `user`, `./.codex/skills/` за `project`)

Примери:
- Агенти: `architect`, `planner`, `executor`, `debugger`, `verifier`, `security-reviewer`
- Умения: `deep-interview`, `ralplan`, `team`, `ralph`, `plan`, `cancel`

## Структура на проекта

```
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

- **[Пълна документация](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** — Пълно ръководство
- **[CLI справочник](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** — Всички команди `omx`, флагове и инструменти
- **[Ръководство за нотификации](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#notifications)** — Настройка на Discord, Telegram, Slack и webhook
- **[Препоръчителни работни процеси](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** — Проверени в бой условия вериги от умения за типични задачи
- **[Бележки към версиите](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#release-notes)** — Какво е ново във всяка версия

## Бележки

- Пълна история на промените: `CHANGELOG.md`
- Ръководство за миграция (след v0.4.4 mainline): `docs/migration-mainline-post-v0.4.4.md`
- Бележки за покритие и паритет: `COVERAGE.md`
- Workflow за разширения на hooks: `docs/hooks-extension.md`
- Детайли за инсталация и участие: `CONTRIBUTING.md`

## Благодарности

Вдъхновено от [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode), адаптирано за Codex CLI.

## Лиценз

MIT
