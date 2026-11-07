# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="Персонаж oh-my-codex" width="280">
  <br>
  <em>Запускайте Codex сильнее, а OMX добавит более качественные промпты, рабочие процессы и поддержку runtime по мере роста задачи.</em>
  <br><br>
  <strong>Нравится OMX, но он кажется избыточным? <a href="https://github.com/Yeachan-Heo/gajae-code">Попробуйте gajae-code</a>.</strong><br>
  <sub>Сохраните OAuth Codex и получите более быстрый, доступный, простой и мощный путь на основе SDK для OpenClaw, Hermes, Grokbot и других интеграций.</sub>
</p>

[![версия npm](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![Лицензия: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/wSyUQYfhAw)

**Сайт:** https://yeachan-heo.github.io/oh-my-codex-website/

**Документация:** [Начало работы](../getting-started.html) · [Агенты](../agents.html) · [Skills](../skills.html) · [Интеграции](../integrations.html) · [Демо](../../DEMO.md) · [Руководство OpenClaw](../../docs/openclaw-integration.md)

**Сообщество:** [Discord](https://discord.gg/wSyUQYfhAw) — общий сервер сообщества Gajae для oh-my-codex, [gajae-code](https://github.com/Yeachan-Heo/gajae-code) и связанных инструментов.

## Официальный проект и пакет

Официальный/исходный проект OMX — этот репозиторий, [`Yeachan-Heo/oh-my-codex`](https://github.com/Yeachan-Heo/oh-my-codex), а официальный npm-пакет — [`oh-my-codex`](https://www.npmjs.com/package/oh-my-codex). Установите его через `npm install -g oh-my-codex` (или вместе с Codex CLI, как показано ниже).

Сторонние проекты и форки с названиями вроде «OMX v2» не являются официальным продолжением, заменой или линией релизов этого репозитория, если README или документация прямо не говорят обратного. Если сомневаетесь, считайте этот репозиторий и пакет `oh-my-codex` официальным источником установки.

OMX — слой рабочих процессов для [OpenAI Codex CLI](https://github.com/openai/codex).

<table>
<tr>
<td><strong>🚨 ВНИМАНИЕ — РЕКОМЕНДУЕМЫЙ ВАРИАНТ ПО УМОЛЧАНИЮ: macOS или Linux с Codex CLI.</strong><br><br><strong>OMX в первую очередь разработан и активно оптимизируется для этого сценария.</strong><br><strong>Нативная Windows и Codex App не являются основным вариантом, могут работать нестабильно и сейчас поддерживаются в меньшей степени.</strong></td>
</tr>
</table>

OMX оставляет Codex движком выполнения и помогает:
- по умолчанию запускать более сильную сессию Codex
- использовать единый процесс от уточнения задачи до результата
- независимо запускать канонические процессы `$plan`, `$ultragoal`, `$team`, `$code-review` и `$ultraqa` — без обязательной цепочки
- хранить инструкции проекта, планы, журналы и состояние в `.omx/`

## Основные сопровождающие

| Роль | Имя | GitHub |
| --- | --- | --- |
| Создатель и лидер | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Сопровождающий | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Сопровождающий | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Амбассадоры

| Имя | GitHub |
| --- | --- |
| Sigrid Jin | [@sigridjineth](https://github.com/sigridjineth) |

## Главные участники

| Имя | GitHub |
| --- | --- |
| Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Junho Yeo | [@junhoyeo](https://github.com/junhoyeo) |
| JiHongKim98 | [@JiHongKim98](https://github.com/JiHongKim98) |
| Lor | [@gobylor](https://github.com/gobylor) |
| HyunjunJeon | [@HyunjunJeon](https://github.com/HyunjunJeon) |

## Рекомендуемый путь по умолчанию

Чтобы использовать OMX в рекомендованном режиме, начните здесь. Выберите один способ установки.

Если Codex CLI уже установлен (через Homebrew, npm или другой поддерживаемый способ):

```bash
codex --version
npm install -g oh-my-codex
# из Git-проекта, который нужно редактировать с Codex; выберите имя под конкретную задачу
omx --worktree=feat/task --madmax --xhigh
```

Если Codex CLI ещё нет и вы хотите управлять им через npm:

```bash
npm install -g @openai/codex
npm install -g oh-my-codex
```

Не запускайте `npm install -g @openai/codex oh-my-codex` поверх существующего бинарника `codex`, принадлежащего Homebrew, например `/opt/homebrew/bin/codex`: npm может завершиться с `EEXIST`, пытаясь создать тот же бинарник. OMX нужен только работающий и аутентифицированный `codex` в `PATH`; устанавливать Codex именно через npm не требуется.

После установки новой версии `oh-my-codex` npm выводит напоминание вместо автоматического запуска setup. Когда будете готовы, выполните команду setup с нужной областью либо запустите `omx update`, чтобы проверить npm и затем обновить setup.

OMX также проверяет обновления npm при запуске с ограниченной частотой и спрашивает разрешение на обновление после завершения текущей сессии. Установите `OMX_AUTO_UPDATE=0`, чтобы отключить проверку, или `OMX_AUTO_UPDATE=defer`, чтобы запланировать отложенное обновление без запроса.

Осознанно выберите область setup:
- Выполняйте `omx setup --scope project --merge-agents` из Git-проекта, где работает OMX, если репозиторий должен хранить постоянные инструкции `AGENTS.md`.
- Используйте `omx setup --scope user` для настройки Codex на уровне пользователя, если текущая директория не должна становиться проектом OMX.
- Не запускайте project-setup из общей домашней директории или операторского хаба, если это не сам проект. Пользовательский `AGENTS.md` часто содержит общие правила безопасности и маршрутизации; проектные инструкции runtime следует держать в нужном репозитории.

### Явная политика объединения AGENTS

`omx setup --merge-agents`, `omx setup --no-merge-agents` и `omx setup --clear-merge-agents-policy` — единственные селекторы политики; используйте именно эти формы, без `=value`. Повтор одинакового селектора безопасен, но сочетание установки и очистки завершит setup до любых изменений. Явная настройка важнее сохранённой. Успешное явное действие записывает `mergeAgents: true` или `false` в `./.omx/setup-scope.json` текущей корневой директории, в том числе при области `user`; это не глобальная настройка и не передаётся другим корням. Последующий `omx update` повторно применяет корректную политику с совпадающей областью при немедленном и отложенном обновлении.

`true` выбирает существующее объединение. `false` лишь отключает эту ветку и не обещает сохранение, замену или новый режим безопасности: сохраняются текущие правила prompts, пропуска, управляемого обновления, настроек plugin и `--force`. Проверка с той же областью сохраняет политику при изменении других параметров. Сброс или смена области удаляет унаследованную политику, если та же команда явно не задала `true` или `false`; очистка всегда удаляет её и не совмещается с селектором установки. Некорректные, неизвестные, не boolean или относящиеся к другой области сохранённые данные безопасно игнорируются.

`--force` действует отдельно и временно: он не сохраняется, не воспроизводится и не отменяет явную политику объединения. Setup атомарно фиксирует намерение установить или очистить политику только после полного успеха, даже если защита активной сессии или plugin symlink пропускает запись текущего `AGENTS.md`. Это не делает объединение настройкой по умолчанию и не возвращает отклонённый подход #2892 «всегда объединять». Старые версии OMX безопасно игнорируют это поле, но могут удалить его при перезаписи известных настроек setup.

**Примечание об установке плагина Codex:** в репозитории есть официальный layout плагина в `plugins/oh-my-codex` и метаданные marketplace в `.agents/plugins/marketplace.json`. Плагин содержит зеркальную поверхность skills и метаданные для официальных lifecycle hooks Codex, необязательных MCP-серверов совместимости и apps. Это не замена глобальному CLI `oh-my-codex` и setup с областью: hooks плагина запускают установленный CLI `omx`, а оба режима setup обычно устанавливают TOML нативных агентов для маршрутизации `agent_type`. В обоих режимах `omx setup --disable-hooks` отключает регистрацию hooks OMX и связанные функции, после чего завершает работу до обычной установки ресурсов, настройки, `AGENTS.md`, HUD и состояния. Legacy-режим также устанавливает копии prompts и skills. Plugin-режим находит упакованные skills, архивирует/удаляет legacy-копии prompts OMX и удаляет устаревшие или непригодные для установки сгенерированные файлы native-agent. Без `--force` сохраняются пользовательские и неоднозначные файлы ролей; отключение Team через `--disable-team` или сохранённое `teamMode: "disabled"` резервно копирует и удаляет `team-executor.toml` независимо от владельца. См. [Plugin bundle SSOT](../../docs/plugin-bundle-ssot.md). Plugin-режиму всё равно нужен постоянный `AGENTS.md` для области (`~/.codex/AGENTS.md` для user-setup или `./AGENTS.md` для project-setup) как долговременный слой инструкций; сессионные AGENTS-файлы лишь дополняют его runtime-оверлеем и не заменяют.

Затем работайте как обычно внутри Codex:

```text
# Долговременная цель и checkpoints для большой задачи:
/goal Спланировать безопасный рефакторинг аутентификации, реализовать его и проверить вход, выход и обновление токенов.

$deep-interview "уточнить изменение аутентификации"
$ralplan "утвердить план аутентификации и проверить компромиссы"
$ultragoal "превратить утверждённый план в долговременные цели Codex"
```

Это основной путь. Прежде чем считать runtime готовым, выполните quick-start smoke test: `omx doctor` проверяет установку, а `omx exec` — что активный runtime Codex может аутентифицироваться и выполнить запрос к модели. Запускайте OMX из Git-проекта, сначала уточните задачу при необходимости, утвердите план и используйте `$ultragoal` как стандартную оболочку долговременного выполнения. Подключайте `$team` внутри этого пути только если конкретная история Ultragoal требует параллельной координации.

## Для чего нужен OMX

Используйте OMX, если Codex уже подходит вам и нужен более удобный runtime на каждый день:
- стандартный процесс `$deep-interview` → `$ralplan` → `$ultragoal`
- границы исследований: `$best-practice-research` для официальных/upstream-источников до планирования, `$autoresearch` для ограниченных исследований с проверкой валидаторами (сначала `$deep-interview --autoresearch`, затем `$autoresearch` с выбранным режимом проверки); результаты передавайте в `$ralplan`
- долговременная передача нескольких целей через `$ultragoal` и артефакты `.omx/ultragoal`
- специализированные роли и skills
- инструкции проекта через `AGENTS.md`
- постоянное состояние в `.omx/` для планов, журналов, памяти и режимов

Если нужен обычный Codex без дополнительного слоя процессов, вероятно, OMX вам не нужен.

## Быстрый старт

### Требования

- Node.js 20+
- установленный Codex CLI (проверьте `codex --version`) и выполненная аутентификация; подходят Homebrew и npm. Не переустанавливайте `@openai/codex` через npm, если Homebrew уже управляет бинарником `codex`.
- аутентификация Codex должна быть доступна в том же shell/профиле, из которого запускается OMX
- `tmux` в macOS/Linux для рекомендованного долговременного Team runtime
- только для нативной Windows, `psmux`, если намеренно выбираете менее поддерживаемый Team-сценарий

### Хорошая первая сессия

После установки проверьте оба уровня:

```bash
omx doctor
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```

`omx doctor` обнаруживает отсутствующие файлы OMX, hooks и требования runtime. Реальный smoke test выявляет проблемы auth, профиля или базового URL провайдера, возникающие только при запросе к модели.

Рекомендуемый запуск из Git-проекта:

```bash
omx --worktree=feat/task --madmax --xhigh
```

В интерактивных терминалах macOS/Linux с `tmux` лидер по умолчанию запускается в управляемом OMX отсоединённом tmux, чтобы HUD/runtime панели можно было создавать и восстанавливать. `--worktree` также запускает отдельный Git checkout, что безопаснее при `--madmax`. Замените `feat/task` именем, похожим на имя ветки.

### Параллельные стандартные диалоги

Обычный запуск владеет одним изменяемым указателем сессии в выбранном `OMX_ROOT`. Второй стандартный запуск `omx` из того же checkout завершится безопасно, вместо того чтобы совместно использовать или незаметно менять корень. Для дополнительных диалогов задайте отдельные корни:

```bash
omx
OMX_ROOT="$HOME/.omx/instances/second-conversation" omx
OMX_ROOT="$HOME/.omx/instances/third-conversation" omx
```

PowerShell:

```powershell
$env:OMX_ROOT = "$HOME/.omx/instances/second-conversation"
omx
```

Командная строка Windows:

```bat
set "OMX_ROOT=%USERPROFILE%\.omx\instances\second-conversation"
omx
```

Явно заданные корни трактуются буквально: повторный запуск с тем же `OMX_ROOT` — конфликт владельцев. У отдельных checkout разные корни по умолчанию; `--worktree` и `--madmax` сохраняют изоляцию.

### Безопасность запуска Madmax и worktree

`--madmax` — сокращение OMX для `--dangerously-bypass-approvals-and-sandbox` в Codex. Оно отключает стандартные ограничения подтверждения и sandbox, поэтому используйте его только в доверенных репозиториях и средах. `--high` и `--xhigh` сокращают `-c model_reasoning_effort="high|xhigh"`. Обычная сильная сессия: `omx --madmax --xhigh` (или `omx --worktree=feat/task --madmax --xhigh`).

При запуске `--madmax` из Git-репозитория предпочтительнее worktree, а не текущий checkout. Для повторяемых или параллельных задач используйте именованные worktree:

```bash
omx --worktree=feature/auth --madmax --xhigh
omx --worktree=fix/flaky-tests --madmax --xhigh
```

Вне Git-репозитория опустите `--worktree`; worktree требует Git. Не запускайте параллельные `--madmax`-сессии в одном каталоге — каждой нужен свой worktree. `--worktree` / `-w` без имени создаёт/использует `../<repo>.omx-worktrees/launch-detached`; с именем — worktree под `../<repo>.omx-worktrees/` и checkout указанной ветки. OMX обрабатывает флаг до запуска Codex. Если выбранный worktree грязный, OMX предупредит и запустит его как есть — перед полаганием на изоляцию очистите, сохраните или закоммитьте изменения.

Repo-aware инструменты получают единый контекст в launch, team-worker и autoresearch: `OMX_REPO_ROOT`, `OMX_WORKTREE_ROOT`, `OMX_GIT_COMMON_DIR`, `OMX_WORKTREE_SCOPE`, `OMX_CODEGRAPH_MODE`, `OMX_CODEGRAPH_PROJECT_PATH`. CodeGraph в режиме `auto` сначала ищет индекс worktree, затем лидера/репозитория и иначе выключается. Явные `shared`, `local`, `off` соблюдаются. OMX не устанавливает CodeGraph, не индексирует worktree автоматически и не копирует/связывает `.codegraph`; общий индекс помогает навигации, но не соответствует точно изменениям только в worktree.

Разовый запуск без управления tmux/HUD OMX:

```bash
omx --direct --yolo
```

Постоянная настройка shell/профиля:

```bash
OMX_LAUNCH_POLICY=direct omx --yolo
```

Вернитесь к стандартному поведению через `unset OMX_LAUNCH_POLICY`. CLI-политики важнее переменных окружения; до `--` действует последняя CLI-политика. Допустимые значения: `direct|tmux|detached-tmux|auto`; файловой настройки в этой версии нет. Если `--direct` запущен из существующей tmux-панели, OMX не создаёт HUD-разделения, не включает mouse mode и обработку extended keys, но процесс остаётся в этой панели.

Попробуйте канонический процесс:

```text
# Пример долговременной цели:
/goal Выпустить исправление checkout с контрольными точками воспроизведения, реализации, регрессионных тестов и итоговой проверки.

$plan "утвердить план исправления checkout и проверить компромиссы"
$ultragoal "выполнить утверждённое исправление с доказательствами на контрольных точках"
```

Используйте `$team`, когда активная история Ultragoal требует координации.

### `/goal` и выбор skills

Начните с `omx --madmax --xhigh` (или добавьте `--worktree=<task>` в Git-репозитории). Работайте напрямую или используйте `$ultragoal` для долговременных целей, `$team` для параллельной координации, `$plan` для предварительного планирования. `/goal` нужен, когда Codex должен сверять цель и checkpoints между ходами.

Если нативные ответы `get_goal` недоступны или обёрнуты транспортом, Ultragoal сохраняет статус на основе артефактов и не заявляет о завершении без подтверждения; см. [диагностику и восстановление Ultragoal](../../docs/ultragoal.md).

По умолчанию загружайте только 2–5 релевантных skills. Больше допустимо по объёму задачи, но большой каталог обычно расходует контекст и внимание, а не достигает жёсткого лимита parser/runtime. Считайте это реальным блокером, только если команда действительно завершается ошибкой.

Антипаттерн:

```text
omx --madmax --xhigh
# Затем загрузить 20 skills «на всякий случай» до постановки задачи.
# Это раздувает контекст и отвлекает модель на нерелевантные процессы.
```

## Простая ментальная модель

OMX не заменяет Codex, а добавляет рабочий слой:
- **Codex** выполняет работу агента
- **ключевые слова ролей OMX** позволяют повторно использовать роли
- **skills OMX** делают общие процессы повторно используемыми
- `.omx/` хранит планы, журналы, память и состояние runtime

Думайте об OMX как о маршрутизации задач, процессах и runtime, а не о наборе команд, которым нужно вручную управлять весь день.

## Если вы только начинаете

1. Если Codex CLI уже установлен, проверьте `codex --version` и установите/обновите OMX через `npm install -g oh-my-codex`; иначе отдельно установите `@openai/codex`, если хотите управлять Codex через npm.
2. После установки или обновления версии OMX запустите `omx setup --scope project --merge-agents` в целевом Git-проекте либо `omx setup --scope user`; `omx update` также проверит npm, установит свежую сборку и обновит setup.
3. Выполните `omx doctor`.
4. Проведите реальный smoke test: `codex login status` и `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"`.
5. Из Git-репозитория запускайте именованный worktree, например `omx --worktree=feat/task --madmax --xhigh`; параллельным сессиям `--madmax` нужны разные worktree.
6. Используйте `$deep-interview "..."`, пока запрос или границы не ясны.
7. Используйте `$ralplan "..."`, чтобы утвердить план и проверить компромиссы.
8. Используйте `$ultragoal` или `$team` для долговременного или параллельного выполнения; добавьте `/goal`, если нужно явно обозначить структуру цели и checkpoints.

## Рекомендуемый процесс

`$autopilot` — основной канонический оркестратор для этапов `$deep-interview -> $ralplan -> $ultragoal`. Эта цепочка задаёт поведение по умолчанию, но этапы можно запускать независимо, если входные требования уже выполнены.

1. `$deep-interview` — итеративное уточнение и готовые к выполнению требования.
2. `$ralplan` — архитектура, реализуемость и согласованный план по результатам интервью.
3. `$ultragoal` — выполнение нескольких целей с checkpoints в ledger `.omx/ultragoal`.
4. `$team` — координация, когда история от этого выигрывает.

`$deep-interview` — независимый этап требований, а не псевдоним `$plan --interview`; он ничего не реализует. Планирование создаёт артефакты плана, а изменения кода требуют явного этапа исполнения (`$ultragoal` или `$team`). В истории Ultragoal подключайте Team, только если он полезен.

## Типовые поверхности сессии

| Поверхность | Назначение |
| --- | --- |
| `$plan "..."` | Дополнительное планирование и уточнение |
| `$ultragoal "..."` | Долговременное выполнение нескольких целей после утверждения плана |
| `$team "..."` | Координированное параллельное выполнение |
| `/skills` | Просмотр установленных skills |
| `/goal ...` | Долговременная структура цели/checkpoints |
| `omx mission <file>` | Последовательный запуск checklist/prompts через `omx exec` с артефактами `.omx/missions/<slug>/summary.json` и `ledger.jsonl` |

## Расширенные / операторские поверхности

Это полезные инструменты оператора, а не основной путь знакомства с OMX.

### Исполнитель очереди миссий

Используйте `omx mission plan ./mission.md` или `omx mission ./mission.md --dry-run` для проверки формата; запуск — `omx mission run ./mission.md -- --model gpt-5`. Состояние смотрите через `status`, продолжайте через `resume`, отмечайте блокировки через `mark`, повторяйте задачу через `rerun`. См. [docs/mission.md](../../docs/mission.md).

### Экспорт прошлой сессии

Найдите ID: `omx session search "запомнившаяся фраза"`; экспортируйте: `omx session export <session-id> --output conversation.md`. Допускается точный ID или уникальный префикс; экспорт включит активные и архивные расшифровки из тех же Codex homes. Поддерживаются `--format json`, `--include-tools`, `--codex-home <path>`; без `--output` вывод идёт в stdout. Существующий файл не перезаписывается. По умолчанию экспортируются только сообщения пользователя и ассистента, не системные/разработческие инструкции и записи рассуждений; текст не редактируется. См. [экспорт сессий](../../docs/session-export.md).

### Использование токенов

`omx session usage --since 7d --sort tokens` показывает накопленное зарегистрированное потребление в локальных активных и архивных сессиях. Уточняйте выбор через `--project current`, `--session <fragment>`, `--json` или `--codex-home <path>`. `--limit` ограничивает отображение, не сумму; зеркала одной сессии учитываются один раз, отсутствующие измерения показываются как неизвестные. `--since` отбирает сессии по последней активности, поэтому счётчики могут включать более раннюю работу и не являются периодическим отчётом о биллинге. Кэшированный input и reasoning входят в input и output. См. [использование сессий](../../docs/session-usage.md).

### Диагностика временной шкалы выполнения

`omx session timeline <session-id>` показывает вызовы инструментов, границы ходов и compact-события без экспорта текста диалога. Вызовы связываются с результатами по ID (включая параллельные), отчёт показывает ошибки, несопоставленные вызовы, измеренные длительности и итоги по инструменту/namespace. Используйте `--kind tools --sort duration --limit 10`, `--status failed` или `--tool <name>`. Фильтры и пагинация меняют список, но не общие счётчики. Поддерживаются точные ID/префиксы, активные и архивные сессии, `--codex-home <path>` и JSON: `--json --output timeline.json`. Неизвестная длительность остаётся неизвестной, а результат без явной ошибки не доказывает успех. См. [timeline сессии](../../docs/session-timeline.md).

### Team runtime

Используйте Team для долговременной координации через tmux/worktree, а не как начальный путь. В Codex App или вне tmux `omx team` — shell-интерфейс tmux runtime; сначала запустите OMX CLI из shell.

Внутри истории Ultragoal состояние остаётся у лидера; workers передают готовые доказательства checkpoints и не изменяют `.omx/ultragoal`. Для несвязанных задач запуск tolerates stale/malformed Ultragoal artifacts, но явно связанный запуск остаётся fail-closed. При старте Team сохраняет `.omx/state/team/<team-name>/preflight-context.json` для восстановления больших задач с исходным контекстом и распределением workers.

Для небольшой атомарной задачи Team может ограничить неявное распараллеливание одним worker и предупредить об избыточной оркестрации. Указывайте число workers явно только при намеренной дополнительной координации.

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

`omx team status [<team-name>] [--json]` только наблюдает состояние и работает с read-only OMX root. Он не забирает истёкшие claims, не доставляет сообщения, не интегрирует commits и не меняет runtime. Без имени ищется только уникальная команда текущей leader-сессии; при отсутствии контекста укажите имя. `omx tmux-hook status` тоже ничего не изменяет; для создания конфигурации используйте `omx tmux-hook init`.

### Setup, doctor и HUD

- Marketplace/обнаружение plugin Codex может кэшировать его в `${CODEX_HOME:-~/.codex}/plugins/cache/$MARKETPLACE_NAME/oh-my-codex/$VERSION/` (локальная версия может называться `local`). В комплекте есть companion metadata официальных lifecycle hooks, необязательные MCP/apps (по умолчанию отключены); plugin всё равно использует установленный CLI `omx`.
- Setup с областью устанавливает prompts, skills, scaffolding AGENTS, `.codex/config.toml`, `.omx/` и для legacy/старых Codex без `plugin_hooks` управляемые OMX hooks в `.codex/hooks.json`.
- При обновлении сохраняются hooks не от OMX; переписываются только управляемые wrapper.
- Plugin-режиму нужен постоянный `AGENTS.md` выбранной области как долговременная инструкция; `omx doctor` считает его отсутствие ошибкой, так как сессионный AGENTS содержит только runtime overlay.
- `omx setup --merge-agents` обновляет разделы между `<!-- OMX:AGENTS:START -->` и `<!-- OMX:AGENTS:END -->`; `--no-merge-agents` сохраняет явный контекстный отказ, `--clear-merge-agents-policy` удаляет политику. Она хранится для каждого корня, применяется в обновлениях только при совпадении области и не является глобальной/force-политикой.
- `omx uninstall` удаляет управляемые OMX wrappers из `.codex/hooks.json`, но сохраняет файл, если там есть пользовательские hooks.
- `omx update` сразу проверяет npm, ставит свежую глобальную OMX и запускает тот же интерактивный setup. Проверки обновлений при старте ограничены и спрашивают разрешение; `OMX_AUTO_UPDATE=0` отключает их, `OMX_AUTO_UPDATE=defer` откладывает обновление без запроса.
- Новый setup использует `gpt-6-astra` для frontier, standard и spark/fast агентов с настройками reasoning по роли; пользовательские параметры и явные overrides сохраняются.
- Маршрутизация model/env в `.omx-config.json` описана в [справке по схеме](../../docs/reference/omx-config-schema-routing.md); меняйте только ключи, поддерживаемые установленной версией.
- `omx doctor` проверяет установку, но не подтверждает возможность аутентифицированного запроса из активного профиля Codex.
- `omx hud --watch` — мониторинг состояния, не основной workflow.
- В каждом HUD preset имя и количество workers активной команды отображаются рядом с версией OMX; сводка Ultragoal/Team выше названия репозитория. У каждого агента есть обновляемая строка состояния, задачи, роли, tmux-pane и возраста обновления. HUD растёт/сжимается вместе со списком, а лишние workers сворачиваются в `+N workers`. Состояние `working` не проверяет жизнь процесса; чтение не меняет team files.
- Прогресс GitGuardex включается явно: добавьте `"guardex": { "enabled": true }` в `.omx/hud-config.json` проекта, чтобы видеть `gx:<step>/<total> <phase>`. Без флага OMX не читает Guardex.

Для сессий без Team каноничны native hooks Codex:
- `plugins/oh-my-codex/hooks/hooks.json` — официальные hooks плагина
- `.codex/hooks.json` — legacy/fallback native hooks
- `.omx/hooks/*.mjs` — hooks plugin OMX
- `omx tmux-hook`, notify-hook и watcher — fallback для tmux/runtime

См. [схему native hooks Codex](../../docs/codex-native-hooks.md).

### Диагностика ложной готовности

Зелёный `omx doctor` означает, что установка и локальный runtime выглядят исправными. Если реальное выполнение не работает:
- Из того же shell/профиля проверьте `codex login status` и `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"`.
- В пользовательском HOME, профиле, контейнере или служебном shell проверьте, что активный `~/.codex`/ `CODEX_HOME` содержит нужные auth и config; не считайте обычный home доступным.
- Для локального OpenAI-compatible proxy проверьте `openai_base_url` в активном `~/.codex/config.toml`; иначе ключ proxy может попасть на стандартный endpoint и дать `401 Unauthorized`, `Missing bearer or basic authentication in header` или `Incorrect API key provided`.
- Если `omx doctor --team`/resume сообщает о stale-команде, `resume_blocker` или пропавшей tmux-сессии, очистите мёртвое состояние:

```bash
omx team shutdown <team-name> --force --confirm-issues
omx cancel
omx doctor --team
```

Используйте принудительное завершение только для подтверждённо мёртвой или сознательно оставленной команды. Если `Shift+Enter` отправляет сообщение вместо переноса строки внутри OMX-tmux, см. [устранение неполадок](../../docs/troubleshooting.md#shiftenter-submits-instead-of-inserting-a-newline-in-tmux-backed-omx-sessions). OMX уже включает forwarding extended keys в своих путях запуска; причина обычно в возможностях/обнаружении терминала tmux.

### Sparkshell

- `omx sparkshell <command>` нужен для shell-native проверки и ограниченной верификации.
- Для read-only поиска по репозиторию используйте обычные средства Codex; устаревший `omx explore` удалён.
- Основная и резервная модели сводок по умолчанию — `gpt-6-astra`; задайте `OMX_SPARKSHELL_FALLBACK_MODEL`, чтобы различать их.
- Допустимые env overrides: `OMX_SPARKSHELL_BIN`, `OMX_SPARKSHELL_MODEL`, `OMX_SPARKSHELL_FALLBACK_MODEL`, `OMX_SPARKSHELL_MODEL_INSTRUCTIONS_FILE`, `OMX_SPARKSHELL_SUMMARY_TIMEOUT_MS`.

```bash
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```

### Wiki

- `omx wiki` — CLI-first JSON-интерфейс; MCP `omx_wiki` — только явная совместимость.
- Wiki хранит проектные знания в Markdown в `omx_wiki/`.
- Это Markdown/search-first, а не vector-first система.

```bash
omx wiki list --json
omx wiki query --input '{"query":"session-start lifecycle"}' --json
omx wiki lint --json
omx wiki refresh --json
```

### Платформы для Team

Лучший вариант для `omx team` — macOS/Linux с `tmux`. Нативная Windows — вторичный путь; обычно предпочтительнее WSL2. В нативной Windows OMX поддерживает `psmux` как tmux-совместимый бинарник для уже поддерживаемых путей.

| Платформа | Установка |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## Известные проблемы

### Intel Mac: высокая загрузка CPU `syspolicyd` / `trustd` при старте

На некоторых Intel Mac старт OMX — особенно с `--madmax --high` — повышает нагрузку `syspolicyd` / `trustd`, пока Gatekeeper проверяет много одновременно запускаемых процессов.

Если это происходит:
- `xattr -dr com.apple.quarantine $(which omx)`
- добавьте приложение терминала в список разрешённых Developer Tools в настройках безопасности macOS
- уменьшите параллелизм, например избегайте `--madmax --high`

## Документация

- [Начало работы](../../docs/getting-started.html)
- [Демо-руководство](../../DEMO.md)
- [Функция Wiki](../../docs/wiki-feature.md)
- [Каталог агентов](../../docs/agents.html)
- [Справочник skills](../../docs/skills.html)
- [Карта native hooks Codex](../../docs/codex-native-hooks.md)
- [Pipeline идентичности GitHub/PR/package](../../docs/pipeline/github-pr-package-identity.md)
- [Интеграции](../../docs/integrations.html)
- [Устранение неполадок выполнения](../../docs/troubleshooting.md)
- [Руководство OpenClaw/notification gateway](../../docs/openclaw-integration.md)
- [Участие в разработке](../../CONTRIBUTING.md)
- [История изменений](../../CHANGELOG.md)

## Языки

- [English](../../README.md)
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
- [Bahasa Indonesia](./README.id.md)

## Участники

| Роль | Имя | GitHub |
| --- | --- | --- |
| Создатель и лидер | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Сопровождающий | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Сопровождающий | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## История звёзд

[![График истории звёзд](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## Лицензия

MIT

## Бенчмарк видимости GEO

OMX включает продуктовую спецификацию [`geobench`](https://github.com/NomaDamas/geobench) для измерения доли попаданий LLM, MRR, доли голоса и цитирований.

- Спецификация: [`geobench/oh-my-codex.yaml`](../../geobench/oh-my-codex.yaml)
- Инструкция: [`docs/geobench.md`](../../docs/geobench.md)
