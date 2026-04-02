# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Ваш codex не самотній.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

> **[Вебсайт](https://yeachan-heo.github.io/oh-my-codex-website/)** | **[Документація](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** | **[Довідник CLI](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** | **[Робочі процеси](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** | **[Посібник з інтеграції OpenClaw](./docs/openclaw-integration.md)** | **[GitHub](https://github.com/Yeachan-Heo/oh-my-codex)** | **[npm](https://www.npmjs.com/package/oh-my-codex)**

Шар мультиагентної оркестрації для [OpenAI Codex CLI](https://github.com/openai/codex).

## Що нового у v0.9.0 — Spark Initiative

Spark Initiative — це реліз, що підсилює нативний шлях дослідження та інспекції в OMX.

- **Нативний harness для `omx explore`** — прискорює та посилює read-only дослідження репозиторію через Rust-шлях.
- **`omx sparkshell`** — нативна операторська поверхня для інспекції зі стислими зведеннями довгого виводу та явним захопленням tmux-pane.
- **Кросплатформні нативні release-артефакти** — шлях hydration для `omx-explore-harness`, `omx-sparkshell` та `native-release-manifest.json` тепер входить у release pipeline.
- **Посилений CI/CD** — додано явне налаштування Rust toolchain у job `build`, а також `cargo fmt --check` і `cargo clippy -- -D warnings`.

Див. також [release notes v0.9.0](./docs/release-notes-0.9.0.md) та [release body](./docs/release-body-0.9.0.md).

## Перша сесія

Всередині Codex:

```text
$deep-interview "clarify the auth change"
$ralplan "approve the auth plan and review tradeoffs"
$ralph "carry the approved plan to completion"
$team 3:executor "execute the approved plan in parallel"
```

З терміналу:

```bash
omx team 4:executor "parallelize a multi-module refactor"
omx team status <team-name>
omx team shutdown <team-name>
```

## Рекомендований робочий процес

1. `$deep-interview` — коли обсяг задачі або межі ще не прояснені.
2. `$ralplan` — щоб перетворити уточнений обсяг на узгоджений план архітектури та реалізації.
3. `$team` або `$ralph` — використовуйте `$team` для координованого паралельного виконання, а `$ralph` — для наполегливого циклу доведення до кінця і перевірки з одним відповідальним.

## Базова модель

OMX встановлює та зв'язує наступні шари:

```text
User
  -> Codex CLI
    -> AGENTS.md (мозок оркестрації)
    -> ~/.codex/prompts/*.md (каталог промптів агентів)
    -> ~/.codex/skills/*/SKILL.md (каталог навичок)
    -> ~/.codex/config.toml (функції, сповіщення, MCP)
    -> .omx/ (стан виконання, пам'ять, плани, журнали)
```

## Основні команди

```bash
omx                # Запустити Codex (+ HUD в tmux за наявності)
omx setup          # Встановити промпти/навички/конфіг за областю + .omx проєкту + AGENTS.md для обраної області
omx doctor         # Діагностика встановлення/середовища виконання
omx doctor --team  # Діагностика Team/swarm
omx team ...       # Запуск/статус/відновлення/завершення робочих tmux
omx status         # Показати активні режими
omx cancel         # Скасувати активні режими виконання
omx reasoning <mode> # low|medium|high|xhigh
omx tmux-hook ...  # init|status|validate|test
omx hooks ...      # init|status|validate|test (робочий процес розширень плагінів)
omx hud ...        # --watch|--json|--preset
omx help
```

## Розширення Hooks (Додаткова поверхня)

OMX тепер включає `omx hooks` для створення шаблонів плагінів та валідації.

- `omx tmux-hook` як і раніше підтримується і не змінений.
- `omx hooks` є додатковим і не замінює робочі процеси tmux-hook.
- Файли плагінів розташовуються в `.omx/hooks/*.mjs`.
- Плагіни за замовчуванням вимкнені; увімкніть за допомогою `OMX_HOOK_PLUGINS=1`.

Повний робочий процес розширень та модель подій описані в `docs/hooks-extension.md`.

## Прапорці запуску

```bash
--yolo
--high
--xhigh
--madmax
--force
--dry-run
--verbose
--scope <user|project>  # тільки для setup
```

`--madmax` відповідає Codex `--dangerously-bypass-approvals-and-sandbox`.
Використовуйте тільки у довірених/зовнішніх sandbox-середовищах.

### Політика workingDirectory MCP (опціональне посилення)

За замовчуванням інструменти MCP state/memory/trace приймають `workingDirectory`, наданий стороною, що викликає.
Щоб обмежити це, задайте список дозволених коренів:

```bash
export OMX_MCP_WORKDIR_ROOTS="/path/to/project:/path/to/another-root"
```

Під час встановлення значення `workingDirectory` за межами цих коренів будуть відхилені.

## Codex-First управління промптами

За замовчуванням OMX впроваджує:

```text
-c model_instructions_file="<cwd>/AGENTS.md"
```

Це об'єднує `AGENTS.md` з `CODEX_HOME` із проєктним `AGENTS.md` (якщо він є), а потім додає runtime-overlay.
Розширює поведінку Codex, але не замінює/обходить основні системні політики Codex.

Управління:

```bash
OMX_BYPASS_DEFAULT_SYSTEM_PROMPT=0 omx     # вимкнути впровадження AGENTS.md
OMX_MODEL_INSTRUCTIONS_FILE=/path/to/instructions.md omx
```

## Командний режим

Використовуйте командний режим для масштабної роботи, яка виграє від паралельних виконавців.

Життєвий цикл:

```text
start -> assign scoped lanes -> monitor -> verify terminal tasks -> shutdown
```

Операційні команди:

```bash
omx team <args>
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

Важливе правило: не завершуйте роботу, поки задачі знаходяться у стані `in_progress`, якщо тільки не перериваєте виконання.

### Політика завершення команди (Team shutdown policy)

Використовуйте `omx team shutdown <team-name>` після того, як команда досягла кінцевого стану.
Очищення команди тепер слідує одним окремим шляхом; застаріла обробка вимкнення пов'язаних Ralph більше не є самостійним публічним робочим процесом.

Вибір Worker CLI для робітників команди:

```bash
OMX_TEAM_WORKER_CLI=auto    # за замовчуванням; використовує claude, якщо worker --model містить "claude"
OMX_TEAM_WORKER_CLI=codex   # примусово Codex CLI
OMX_TEAM_WORKER_CLI=claude  # примусово Claude CLI
OMX_TEAM_WORKER_CLI_MAP=codex,codex,claude,claude  # CLI для кожного робітника (довжина=1 або кількість робітників)
OMX_TEAM_AUTO_INTERRUPT_RETRY=0  # опціонально: вимкнути адаптивний відкат queue->resend
```

Примітки:
- Аргументи запуску робітників, як і раніше, передаються через `OMX_TEAM_WORKER_LAUNCH_ARGS`.
- `OMX_TEAM_WORKER_CLI_MAP` перевизначає `OMX_TEAM_WORKER_CLI` для вибору на рівні робітника.
- Відправка тригерів за замовчуванням використовує адаптивні повторні спроби (queue/submit, потім безпечний відкат clear-line+resend за необхідності).
- У режимі Claude worker OMX запускає робітників як звичайний `claude` (без додаткових аргументів) і ігнорує явні перевизначення `--model` / `--config` / `--effort`, щоб Claude використовував стандартний `settings.json`.

## Що записує `omx setup`

- `.omx/setup-scope.json` (збережена область встановлення)
- Установки залежно від області:
  - `user`: `~/.codex/prompts/`, `~/.codex/skills/`, `~/.codex/config.toml`, `~/.omx/agents/`, `~/.codex/AGENTS.md`
  - `project`: `./.codex/prompts/`, `./.codex/skills/`, `./.codex/config.toml`, `./.omx/agents/`, `./AGENTS.md`
- Поведінка під час запуску: якщо збережена область — `project`, `omx` автоматично використовує `CODEX_HOME=./.codex` (якщо `CODEX_HOME` ще не задано).
- Інструкції запуску об'єднують `~/.codex/AGENTS.md` (або `CODEX_HOME/AGENTS.md`, якщо шлях перевизначено) з проєктним `./AGENTS.md`, а потім додають runtime-overlay.
- Існуючі файли `AGENTS.md` ніколи не перезаписуються мовчки: в інтерактивному TTY setup запитує перед заміною, а в неінтерактивному режимі пропускає заміну без `--force` (перевірки безпеки активних сесій залишаються в силі).
- Оновлення `config.toml` (для обох областей):
  - `notify = ["node", "..."]`
  - `model_reasoning_effort = "high"`
  - `developer_instructions = "..."`
  - `[features] multi_agent = true, child_agents_md = true`
  - Записи MCP-серверів (`omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`)
  - `[tui] status_line`
- `AGENTS.md` для обраної області
- Директорії `.omx/` та конфігурація HUD

## Агенти та навички

- Промпти: `prompts/*.md` (встановлюються у `~/.codex/prompts/` для `user`, `./.codex/prompts/` для `project`)
- Навички: `skills/*/SKILL.md` (встановлюються у `~/.codex/skills/` для `user`, `./.codex/skills/` для `project`)

Приклади:
- Агенти: `architect`, `planner`, `executor`, `debugger`, `verifier`, `security-reviewer`
- Навички: `deep-interview`, `ralplan`, `team`, `ralph`, `plan`, `cancel`

## Структура проєкту

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

## Розробка

```bash
git clone https://github.com/Yeachan-Heo/oh-my-codex.git
cd oh-my-codex
npm install
npm run build
npm test
```

## Історія Pull Request

Цей проєкт розвивається спільнотою. Ось як виглядає типовий процес внеску через Pull Request:

### Як зробити внесок

1. **Форкніть репозиторій** — натисніть кнопку «Fork» на сторінці [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex).
2. **Створіть гілку** — `git checkout -b feature/my-awesome-feature`
3. **Внесіть зміни** — дотримуйтесь стилю коду проєкту та конвенцій з `CONTRIBUTING.md`.
4. **Напишіть тести** — переконайтеся, що `npm test` проходить успішно.
5. **Зробіть коміт** — використовуйте зрозумілі повідомлення комітів.
6. **Надішліть PR** — опишіть, що змінилося, чому, та додайте скріншоти за потреби.

### Що відбувається після відкриття PR

- **Автоматичні перевірки** — CI запускає лінтер, перевірку типів та тести.
- **Рев'ю коду** — мейнтейнери переглядають зміни, можуть залишити коментарі або попросити про правки.
- **Ітерації** — автор вносить зміни відповідно до відгуків.
- **Мердж** — після затвердження PR зливається у головну гілку.

### Поради для успішного PR

- Тримайте PR невеликими та сфокусованими — один PR = одна зміна.
- Додайте опис «чому», а не тільки «що».
- Перевірте, що тести проходять локально перед надсиланням.
- Будьте відкриті до фідбеку — рев'ю коду покращує якість для всіх.

## Документація

- **[Повна документація](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** — Повний посібник
- **[Довідник CLI](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** — Всі команди `omx`, прапорці та інструменти
- **[Посібник зі сповіщень](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#notifications)** — Налаштування Discord, Telegram, Slack та webhook
- **[Рекомендовані робочі процеси](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** — Перевірені в бою ланцюжки навичок для типових задач
- **[Примітки до випусків](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#release-notes)** — Що нового в кожній версії

## Примітки

- Повний журнал змін: `CHANGELOG.md`
- Посібник з міграції (після v0.4.4 mainline): `docs/migration-mainline-post-v0.4.4.md`
- Нотатки про покриття та паритет: `COVERAGE.md`
- Робочий процес розширень hook: `docs/hooks-extension.md`
- Деталі встановлення та участі: `CONTRIBUTING.md`

## Подяки

Натхненно проєктом [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode), адаптовано для Codex CLI.

## Мови

- [English](./README.md)
- [한국어](./README.ko.md)
- [日本語](./README.ja.md)
- [简体中文](./README.zh.md)
- [繁體中文](./README.zh-TW.md)
- [Tiếng Việt](./README.vi.md)
- [Español](./README.es.md)
- [Português](./README.pt.md)
- [Русский](./README.ru.md)
- [Türkçe](./README.tr.md)
- [Deutsch](./README.de.md)
- [Français](./README.fr.md)
- [Italiano](./README.it.md)
- [Ελληνικά](./README.el.md)
- [Polski](./README.pl.md)
- [Українська](./README.uk.md)

## Ліцензія

MIT
