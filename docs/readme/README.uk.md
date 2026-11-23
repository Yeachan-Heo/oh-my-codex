# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="Персонаж oh-my-codex" width="280">
  <br>
  <em>Починайте з потужнішого Codex, а OMX додасть кращі промпти, робочі процеси й підтримку runtime, коли завдання зростатиме.</em>
  <br><br>
  <strong>Подобається OMX, але здається надмірним? <a href="https://github.com/Yeachan-Heo/gajae-code">Спробуйте gajae-code</a>.</strong><br>
  <sub>Збережіть OAuth Codex і використовуйте швидший, дешевший, простіший і потужніший шлях на основі SDK для OpenClaw, Hermes, Grokbot та інших інтеграцій.</sub>
</p>

[![версія npm](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![Ліцензія: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/wSyUQYfhAw)

**Сайт:** https://yeachan-heo.github.io/oh-my-codex-website/

**Документація:** [Початок роботи](../getting-started.html) · [Агенти](../agents.html) · [Skills](../skills.html) · [Інтеграції](../integrations.html) · [Демо](../../DEMO.md) · [Посібник OpenClaw](../../docs/openclaw-integration.md)

**Спільнота:** [Discord](https://discord.gg/wSyUQYfhAw) — спільний сервер спільноти Gajae для oh-my-codex, [gajae-code](https://github.com/Yeachan-Heo/gajae-code) та суміжних інструментів.

## Офіційний проєкт і пакет

Офіційний/оригінальний проєкт OMX — цей репозиторій [`Yeachan-Heo/oh-my-codex`](https://github.com/Yeachan-Heo/oh-my-codex), а офіційний npm-пакет — [`oh-my-codex`](https://www.npmjs.com/package/oh-my-codex). Встановіть його командою `npm install -g oh-my-codex` (або разом із Codex CLI, як показано нижче).

Сторонні проєкти чи форки з назвами на кшталт «OMX v2» не є офіційними продовженнями, замінами чи лініями релізів цього репозиторію, якщо README або документація прямо не стверджують інше. У разі сумнівів вважайте цей репозиторій і пакет `oh-my-codex` офіційним місцем встановлення.

OMX — шар робочих процесів для [OpenAI Codex CLI](https://github.com/openai/codex).

<table>
<tr>
<td><strong>🚨 УВАГА — РЕКОМЕНДОВАНИЙ СТАНДАРТНИЙ ВАРІАНТ: macOS або Linux із Codex CLI.</strong><br><br><strong>OMX насамперед розроблено й активно оптимізовано для цього сценарію.</strong><br><strong>Нативна Windows і Codex App не є типовим досвідом, можуть працювати нестабільно й наразі мають менший рівень підтримки.</strong></td>
</tr>
</table>

OMX залишає Codex рушієм виконання та допомагає:
- за замовчуванням запускати сильнішу сесію Codex
- дотримуватися єдиного процесу від уточнення до завершення
- окремо запускати канонічні процеси `$plan`, `$ultragoal`, `$team`, `$code-review` і `$ultraqa` — без фіксованого ланцюжка
- зберігати інструкції проєкту, плани, журнали й стан у `.omx/`

## Основні мейнтейнери

| Роль | Ім’я | GitHub |
| --- | --- | --- |
| Творець і лідер | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Мейнтейнер | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Мейнтейнер | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Амбасадори

| Ім’я | GitHub |
| --- | --- |
| Sigrid Jin | [@sigridjineth](https://github.com/sigridjineth) |

## Провідні контриб’ютори

| Ім’я | GitHub |
| --- | --- |
| Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Junho Yeo | [@junhoyeo](https://github.com/junhoyeo) |
| JiHongKim98 | [@JiHongKim98](https://github.com/JiHongKim98) |
| Lor | [@gobylor](https://github.com/gobylor) |
| HyunjunJeon | [@HyunjunJeon](https://github.com/HyunjunJeon) |

## Рекомендований стандартний процес

Щоб скористатися стандартним досвідом OMX, почніть тут. Оберіть один спосіб встановлення.

Якщо Codex CLI вже встановлено (Homebrew, npm або іншим підтримуваним способом):

```bash
codex --version
npm install -g oh-my-codex
# із Git-проєкту, який треба редагувати за допомогою Codex; виберіть назву для конкретного завдання
omx --worktree=feat/task --madmax --xhigh
```

Якщо Codex CLI ще немає і ви хочете керувати ним через npm:

```bash
npm install -g @openai/codex
npm install -g oh-my-codex
```

Не виконуйте `npm install -g @openai/codex oh-my-codex` поверх наявного бінарного файла `codex`, яким керує Homebrew, наприклад `/opt/homebrew/bin/codex`: npm може завершитися з `EEXIST`, намагаючись створити той самий файл. OMX потрібна лише робоча й автентифікована команда `codex` у `PATH`; встановлювати Codex саме через npm не потрібно.

Після встановлення нової версії `oh-my-codex` npm показує явне нагадування замість автоматичного запуску setup. Коли будете готові, запустіть setup із потрібною областю або скористайтеся `omx update`, щоб перевірити npm і оновити setup.

OMX також перевіряє оновлення npm під час запуску з обмеженою частотою й запитує підтвердження перед плануванням оновлення після завершення поточної сесії. Задайте `OMX_AUTO_UPDATE=0`, щоб вимкнути перевірку, або `OMX_AUTO_UPDATE=defer`, щоб запланувати таке саме відкладене оновлення без запиту.

Обирайте область setup свідомо:
- Виконуйте `omx setup --scope project --merge-agents` у Git-проєкті, де працюватиме OMX, якщо репозиторій має зберігати довготривалі інструкції `AGENTS.md`.
- Використовуйте `omx setup --scope user` для налаштування Codex на рівні користувача, якщо поточна директорія не має ставати проєктом OMX.
- Не запускайте project-setup із широкої домашньої директорії чи операційного хаба, якщо це не сам проєкт. Користувацький `AGENTS.md` часто містить глобальні правила безпеки й маршрутизації; проектні інструкції runtime зберігайте у відповідному репозиторії.

### Явна політика злиття AGENTS

`omx setup --merge-agents`, `omx setup --no-merge-agents` і `omx setup --clear-merge-agents-policy` — єдині перемикачі політики; використовуйте саме ці форми, без `=value`. Повторення однакового перемикача безпечне, але поєднання встановлення й очищення завершить setup до будь-яких змін. Явне встановлення має пріоритет над збереженим значенням. У разі успіху воно записує `mergeAgents: true` або `false` у `./.omx/setup-scope.json` поточного кореня, навіть для області `user`; це не глобальна настройка й не поширюється на інший корінь. Наступний `omx update` повторює коректну політику з відповідною областю для негайного та відкладеного оновлення.

`true` використовує наявну гілку злиття. `false` лише вимикає її й не обіцяє збереження, заміну чи новий режим безпеки: далі діють чинні правила prompts, пропуску, керованого оновлення, plugin-default і `--force`. Перегляд із тією самою областю зберігає політику, коли змінюються інші параметри. Скидання чи зміна області видаляє успадковану політику, якщо той самий запуск явно не задає `true` або `false`; очищення завжди її видаляє й не може поєднуватися з перемикачем встановлення. Некоректні, невідомі, не boolean або не тієї області збережені дані безпечно ігноруються.

`--force` незалежний і тимчасовий: його не зберігають і не відтворюють, він не скасовує явну політику злиття. Setup атомарно фіксує явний намір встановити чи очистити її лише після успішного завершення всієї роботи, навіть якщо захист активної сесії чи символьного посилання plugin пропустив запис поточного `AGENTS.md`. Це не робить злиття стандартним і не повертає відхилений підхід #2892 «завжди зливати». Старі версії OMX безпечно ігнорують це поле, але можуть стерти його, переписуючи відомі налаштування setup.

**Примітка щодо встановлення Codex plugin:** репозиторій також містить офіційний plugin-layout `plugins/oh-my-codex` із marketplace-метаданими в `.agents/plugins/marketplace.json`. Plugin включає дзеркальні skills і метадані для офіційних lifecycle hooks Codex, необов’язкових MCP-серверів сумісності й apps. Це не заміна глобального CLI `oh-my-codex` та setup з областю: hooks plugin запускають встановлений CLI `omx`, а обидва режими setup зазвичай встановлюють TOML нативних агентів для маршрутизації `agent_type`. В обох режимах `omx setup --disable-hooks` вимикає реєстрації hooks OMX і пов’язані можливості, після чого завершується до звичайного встановлення ресурсів, конфігурації, `AGENTS.md`, HUD і state. Legacy-режим також встановлює копії prompts і skills. Plugin-режим знаходить упаковані skills, архівує/видаляє старі копії prompts OMX і видаляє застарілі або неінстальовні згенеровані файли native-agent. Без `--force` він зберігає користувацькі чи неоднозначні файли ролей; вимкнення Team через `--disable-team` або збережене `teamMode: "disabled"` резервує та видаляє `team-executor.toml` незалежно від власника. Див. [Plugin bundle SSOT](../../docs/plugin-bundle-ssot.md). Plugin-режиму все одно потрібен постійний `AGENTS.md` обраної області (`~/.codex/AGENTS.md` для user-setup або `./AGENTS.md` для project-setup) як довготривалий шар інструкцій; файли сесії лише поєднують його з runtime-оверлеєм, а не замінюють.

Далі працюйте у Codex звичайним чином:

```text
# Довготривала ціль/checkpoints для великого завдання:
/goal Створити безпечний план рефакторингу автентифікації, реалізувати його й перевірити вхід, вихід та оновлення токена.

$deep-interview "уточнити зміну автентифікації"
$ralplan "затвердити план автентифікації та перевірити компроміси"
$ultragoal "перетворити затверджений план на довготривалі цілі Codex"
```

Це основний шлях. Перед тим як вважати runtime готовим, виконайте quick-start smoke test нижче: `omx doctor` перевіряє форму встановлення, а `omx exec` доводить, що активне середовище Codex може автентифікуватися й виконати виклик моделі. Запускайте OMX із Git-проєкту, спершу за потреби уточніть вимоги, затвердьте план і використовуйте `$ultragoal` як стандартну оболонку завершення. Застосовуйте `$team` у цьому процесі лише для конкретної історії Ultragoal, яка потребує паралельної координації.

## Для чого потрібен OMX

Використовуйте OMX, якщо вам подобається Codex і потрібен кращий повсякденний runtime:
- стандартний процес `$deep-interview` → `$ralplan` → `$ultragoal`
- межі дослідження: `$best-practice-research` для офіційних/upstream-джерел до планування, `$autoresearch` для обмежених досліджень із перевіркою валідаторами (`$deep-interview --autoresearch` для збору вимог, потім `$autoresearch` із вибраним режимом валідації); висновки передавайте в `$ralplan`
- довготривалі передачі кількох цілей через `$ultragoal` і артефакти `.omx/ultragoal`
- спеціалізовані ролі й допоміжні skills за потреби
- інструкції проєкту через `AGENTS.md`
- довготривалий стан у `.omx/` для планів, журналів, пам’яті й режимів

Якщо потрібен звичайний Codex без додаткового шару процесів, OMX вам, імовірно, не потрібен.

## Швидкий старт

### Вимоги

- Node.js 20+
- Встановлений Codex CLI, перевірений командою `codex --version`, та налаштована автентифікація (підходять Homebrew і npm; не перевстановлюйте `@openai/codex` через npm, якщо Homebrew уже керує `codex`)
- автентифікація Codex має бути доступною в тій самій shell/profile-сесії, що запускає OMX
- `tmux` у macOS/Linux для рекомендованого довготривалого Team runtime
- лише для нативної Windows — `psmux`, якщо свідомо обираєте менш підтримуваний сценарій Team

### Вдала перша сесія

Після встановлення перевірте обидві межі:

```bash
omx doctor
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```

`omx doctor` знаходить відсутні файли OMX, hooks та передумови runtime. Реальний smoke test виявляє проблеми автентифікації, профілю або базової URL-адреси провайдера, які проявляються лише під час реального запиту Codex.

Рекомендований запуск із Git-проєкту:

```bash
omx --worktree=feat/task --madmax --xhigh
```

В інтерактивних терміналах macOS/Linux із `tmux` лідер за замовчуванням запускається в керованому OMX від’єднаному tmux, щоб панелі HUD/runtime можна було створити й відновити. `--worktree` також запускає інший Git checkout, що безпечніше для `--madmax`. Замініть `feat/task` назвою, схожою на гілку.

### Паралельні стандартні розмови

Звичайний запуск володіє одним доступним для запису покажчиком сесії у вибраному `OMX_ROOT`. Другий стандартний запуск `omx` з того самого checkout безпечно завершується замість спільного використання чи прихованої зміни кореня. Для додаткових розмов використовуйте окремі корені:

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

Командний рядок Windows:

```bat
set "OMX_ROOT=%USERPROFILE%\.omx\instances\second-conversation"
omx
```

Заданий користувачем корінь є буквальним: повторний запуск із тим самим явним `OMX_ROOT` спричинить конфлікт власника. Окремі checkout мають різні стандартні корені; `--worktree` і `--madmax` зберігають ізоляцію.

### Безпека запуску Madmax і worktree

`--madmax` — скорочення OMX для `--dangerously-bypass-approvals-and-sandbox` у Codex. Воно прибирає звичайні запобіжники підтвердження та sandbox, тож використовуйте його лише в довірених репозиторіях і середовищах. `--high` та `--xhigh` скорочують `-c model_reasoning_effort="high|xhigh"`. Звичайна потужна сесія: `omx --madmax --xhigh` (або `omx --worktree=feat/task --madmax --xhigh`).

З `--madmax` у Git-репозиторії віддавайте перевагу worktree, а не поточному checkout. Для повторюваної чи паралельної роботи використовуйте іменовані worktree:

```bash
omx --worktree=feature/auth --madmax --xhigh
```

```bash
omx --worktree=fix/flaky-tests --madmax --xhigh
```

Поза Git-репозиторієм приберіть `--worktree`; worktree потребує Git. Не запускайте паралельні `--madmax`-сесії в одній директорії. `--worktree` / `-w` без назви створює/повторно використовує `../<repo>.omx-worktrees/launch-detached`; з назвою — створює/повторно використовує worktree у `../<repo>.omx-worktrees/` та checkout тієї гілки. OMX обробляє параметр до запуску Codex. Якщо цільовий worktree має незбережені зміни, OMX попереджає, але запускає його як є; очистьте, закомітьте або відкладіть зміни, перш ніж покладатися на ізоляцію.

Інструменти, що враховують репозиторій, отримують однаковий контекст у launch, team-worker і autoresearch: `OMX_REPO_ROOT`, `OMX_WORKTREE_ROOT`, `OMX_GIT_COMMON_DIR`, `OMX_WORKTREE_SCOPE`, `OMX_CODEGRAPH_MODE`, `OMX_CODEGRAPH_PROJECT_PATH`. Режим CodeGraph `auto` віддає перевагу індексу worktree, далі індексу лідера/репозиторію, інакше вимикається. Явні `shared`, `local`, `off` виконуються. OMX не встановлює CodeGraph, не індексує worktree автоматично й не копіює/не створює symlink для `.codegraph`; спільний індекс допомагає навігації, але не відображає точно зміни лише у worktree.

Разовий запуск без керування tmux/HUD OMX:

```bash
omx --direct --yolo
```

Постійне налаштування shell/profile:

```bash
OMX_LAUNCH_POLICY=direct omx --yolo
```

Поверніться до стандартної поведінки через:

```bash
unset OMX_LAUNCH_POLICY
``` Прапорці CLI мають пріоритет над середовищем. Цей приклад примусово вмикає tmux, навіть якщо в середовищі задано `direct`:

```bash
OMX_LAUNCH_POLICY=direct omx --tmux --yolo
```

До `--` діє останній CLI-прапорець. Дозволені значення: `direct|tmux|detached-tmux|auto`; налаштування у файлі конфігурації не додається. Якщо запустити `--direct` у вже наявній tmux-панелі, OMX не створює HUD-поділів, не вмикає mouse mode чи обробку extended-key, але процес усе одно працює в цій панелі.

Спробуйте канонічний процес:

```text
# Приклад довготривалої цілі:
/goal Випустити виправлення checkout із контрольними точками відтворення, реалізації, регресійних тестів і фінальної перевірки.

$plan "затвердити план виправлення checkout і переглянути компроміси"
$ultragoal "виконати затверджене виправлення з доказами на контрольних точках"
```

Використовуйте `$team`, коли активна історія Ultragoal потребує координації.

### `/goal` і вибір skills

Почніть сильну звичайну сесію з `omx --madmax --xhigh` (або додайте `--worktree=<task>` у Git-репозиторії). Працюйте напряму або використовуйте `$ultragoal` для довготривалих багатокрокових запусків, `$team` для координації паралельної роботи, `$plan` для попереднього планування. Використовуйте `/goal`, коли Codex має звіряти ціль і checkpoints у кількох ходах.

Якщо нативні відповіді `get_goal` недоступні чи обгорнуті транспортом, Ultragoal зберігає статус на основі артефактів і не заявляє про завершення без доказів; див. [діагностику й відновлення Ultragoal](../../docs/ultragoal.md).

Типово завантажуйте лише 2–5 доречних skills. Більше можна, якщо цього вимагає обсяг задачі, але великий каталог зазвичай витрачає контекст і увагу, а не впирається в жорсткий ліміт parser/runtime. Вважайте це реальним блокером лише якщо команда справді завершується помилкою.

Антипатерн:

```text
omx --madmax --xhigh
# Потім завантажити 20 skills «про всяк випадок» до формулювання завдання.
# Це роздуває контекст і відволікає модель на нерелевантні процеси.
```

## Проста ментальна модель

OMX не замінює Codex, а додає робочий шар:
- **Codex** виконує роботу агента
- **ключові слова ролей OMX** дають змогу повторно використовувати ролі
- **skills OMX** роблять типові процеси повторно використовуваними
- `.omx/` зберігає плани, журнали, пам’ять і стан runtime

Сприймайте OMX як кращу маршрутизацію задач, робочий процес і runtime, а не як набір команд для ручного керування протягом дня.

## Почніть тут, якщо ви новачок

1. Якщо Codex CLI вже є, перевірте `codex --version` та встановіть/оновіть OMX через `npm install -g oh-my-codex`; інакше окремо встановіть `@openai/codex`, якщо хочете керувати Codex через npm.
2. Після встановлення чи оновлення OMX запустіть `omx setup --scope project --merge-agents` у цільовому Git-проєкті або `omx setup --scope user`; `omx update` додатково перевірить npm, встановить нову версію й оновить setup.
3. Виконайте `omx doctor`.
4. Проведіть реальний smoke test: `codex login status` та `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"`.
5. У Git-репозиторії запускайте іменований worktree, наприклад `omx --worktree=feat/task --madmax --xhigh`; паралельні сесії `--madmax` потребують різних worktree.
6. Використовуйте `$deep-interview "..."`, якщо запит чи його межі ще неясні.
7. Використовуйте `$ralplan "..."`, щоб затвердити план і переглянути компроміси.
8. Використовуйте `$ultragoal` або `$team`, коли потрібне довготривале чи паралельне виконання; додайте `/goal`, щоб явно оформити цілі й checkpoints.

## Рекомендований робочий процес

`$autopilot` — основний канонічний оркестратор етапів `$deep-interview -> $ralplan -> $ultragoal`. Цей ланцюжок є типовим, але етапи можна викликати окремо, якщо вимоги до входу вже виконані.

1. `$deep-interview` — ітеративне сократівське уточнення та вимоги, готові до виконання.
2. `$ralplan` — архітектурний синтез, здійсненність і узгоджений план на основі інтерв’ю.
3. `$ultragoal` — виконання кількох цілей із checkpoints у ledger `.omx/ultragoal`.
4. `$team` — скоординоване виконання, коли історія від цього виграє.

`$deep-interview` — окремий етап вимог, не псевдонім `$plan --interview`, і він нічого не реалізує. Планування створює артефакти; зміни коду потребують явного етапу виконання — `$ultragoal` або `$team`. Усередині історії Ultragoal застосовуйте Team лише за наявності користі.

## Типові поверхні під час сесії

| Поверхня | Для чого |
| --- | --- |
| `$plan "..."` | Необов’язкове планування й уточнення |
| `$ultragoal "..."` | Довготривале виконання кількох цілей після затвердження плану |
| `$team "..."` | Скоординоване паралельне виконання |
| `/skills` | Перегляд встановлених skills |
| `/goal ...` | Довготривала структура цілей/checkpoints |
| `omx mission <file>` | Послідовний запуск checklist/prompts через `omx exec` з артефактами `.omx/missions/<slug>/summary.json` і `ledger.jsonl` |

## Розширені / операторські поверхні

Ці можливості корисні операторам, але не є основним шляхом знайомства з OMX.

### Виконавець черги місій

Скористайтеся `omx mission plan ./mission.md` чи `omx mission ./mission.md --dry-run`, щоб перевірити формат; виконайте `omx mission run ./mission.md -- --model gpt-5`. Переглядайте `status`, продовжуйте `resume`, позначайте блокування `mark`, повторно запускайте окреме завдання через `rerun`. Див. [docs/mission.md](../../docs/mission.md).

### Експорт попередньої розмови

Знайдіть ID через `omx session search "згадана фраза"`, експортуйте через `omx session export <session-id> --output conversation.md`. Підтримується точний ID чи унікальний префікс; експорт охоплює активні й архівні транскрипти з тих самих Codex homes. Доступні `--format json`, `--include-tools`, `--codex-home <path>`; без `--output` результат іде у stdout, наявний файл не перезаписується. Типово включаються лише повідомлення користувача й асистента, інструкції системи/розробника та записи reasoning виключені; текст не редагується. Див. [експорт сесій](../../docs/session-export.md).

### Перегляд використання токенів

`omx session usage --since 7d --sort tokens` показує зареєстроване сукупне використання в активних і архівних локальних сесіях. Звузьте вибір параметрами `--project current`, `--session <fragment>`, `--json` або `--codex-home <path>`. `--limit` обмежує список, а не суму; дзеркала однієї сесії рахуються один раз, відсутні виміри позначаються невідомими. `--since` відбирає сесії за останньою активністю, тому лічильники можуть містити давнішу роботу й не є звітом споживання/оплати за період. Кешований input і reasoning є підмножинами input/output. Див. [використання сесій](../../docs/session-usage.md).

### Діагностика часової шкали виконання

`omx session timeline <session-id>` показує виклики інструментів, межі ходів і ущільнення контексту без експорту тексту розмови. Виклики й результати зіставляються за ID, зокрема паралельні; звіт показує явні помилки, незіставлені виклики, виміряні тривалості й суми за інструментом/namespace. Використовуйте `--kind tools --sort duration --limit 10`, `--status failed` або `--tool <name>`. Фільтри/пагінація змінюють перелік, але не загальні підсумки. Підтримуються точні ID чи префікси, активні й архівні сесії, `--codex-home <path>` та JSON через `--json --output timeline.json`. Невідома тривалість залишається невідомою, а результат без явної помилки не доводить успіх. Див. [timeline сесій](../../docs/session-timeline.md).

### Team runtime

Використовуйте Team для довготривалої координації через tmux/worktree, а не як стандартний початок. У Codex App або поза tmux `omx team` є shell-поверхнею для tmux runtime; для виконання Team спершу запустіть OMX CLI із shell.

У межах історії Ultragoal лідер володіє її станом, а workers повідомляють готові докази checkpoints, не змінюючи `.omx/ultragoal`. Непов’язані запуски терпимі до застарілих/пошкоджених артефактів Ultragoal, але явно пов’язані запуски fail-closed. Team також записує `.omx/state/team/<team-name>/preflight-context.json`, щоб відновити масштабні задачі з початковим контекстом і розподілом робіт.

Для малої атомарної роботи Team може обмежити неявне розгалуження одним worker і попередити про зайву оркестрацію. Вказуйте кількість явно, лише коли додаткова координація потрібна.

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

`omx team status [<team-name>] [--json]` лише спостерігає стан і працює з read-only OMX root. Він не відновлює прострочені claims, не доставляє повідомлення, не інтегрує commits і не змінює runtime. Без імені шукається лише одна відповідна команда поточної leader-сесії; коли контексту немає, вкажіть ім’я. `omx tmux-hook status` також лише спостерігає; ініціалізуйте конфігурацію через `omx tmux-hook init`.

### Setup, doctor і HUD

- Marketplace/виявлення Codex plugin може кешувати пакет у `${CODEX_HOME:-~/.codex}/plugins/cache/$MARKETPLACE_NAME/oh-my-codex/$VERSION/` (локальні інсталяції можуть мати версію `local`). Пакет містить метадані офіційних lifecycle hooks Codex і необов’язкові MCP/apps (за замовчуванням вимкнені); для runtime все одно потрібен встановлений CLI `omx`.
- Setup з областю встановлює prompts, skills, каркас `AGENTS.md`, `.codex/config.toml`, `.omx/` та для legacy/старого Codex без `plugin_hooks` — керовані OMX hooks у `.codex/hooks.json`.
- Оновлення setup зберігає hooks не від OMX і переписує лише керовані OMX wrappers.
- У plugin-режимі постійний `AGENTS.md` залишається обов’язковим шаром інструкцій; `omx doctor` позначає його відсутність як помилку, бо сесійний файл містить лише runtime-overlay.
- `omx setup --merge-agents` оновлює секції між `<!-- OMX:AGENTS:START -->` і `<!-- OMX:AGENTS:END -->`; `--no-merge-agents` зберігає явний контекстний вибір, `--clear-merge-agents-policy` його прибирає. Політика зберігається окремо для кожного кореня й повторюється під час оновлення лише за відповідної області; вона не є глобальною або force-політикою.
- `omx uninstall` видаляє OMX-managed wrappers із `.codex/hooks.json`, але зберігає файл, якщо там лишилися користувацькі hooks.
- `omx update` одразу перевіряє npm, встановлює найновішу глобальну версію й повторно проходить інтерактивне оновлення setup. Перевірки при запуску обмежені та питають дозвіл; `OMX_AUTO_UPDATE=0` вимикає їх, `OMX_AUTO_UPDATE=defer` планує відкладене оновлення без запиту.
- Новий setup використовує `gpt-6-astra` для frontier, standard і spark/fast агентів із типовими параметрами reasoning за ролями; наявні налаштування й явні overrides зберігаються.
- Маршрутизацію model/env у `.omx-config.json` описано в [довідці зі схеми](../../docs/reference/omx-config-schema-routing.md); змінюйте лише ключі, які підтримує встановлена версія.
- `omx doctor` перевіряє інсталяцію, але не здатність активного профілю Codex виконати автентифікований виклик моделі.
- `omx hud --watch` — моніторинг стану, не основний workflow.
- У кожному HUD preset активні команди показують назву й кількість workers поруч із версією OMX; зведення Ultragoal/Team має пріоритет над назвою репозиторію. Кожен агент має рядок стану, задачі, ролі, tmux-pane та віку оновлення. Висота HUD підлаштовується під склад команди; надлишок відображається як `+N workers`. `working` не перевіряє життєздатність процесу; читання стану не змінює файли.
- Прогрес GitGuardex вмикається окремо: додайте `"guardex": { "enabled": true }` до проєктного `.omx/hud-config.json`, щоб показувати `gx:<step>/<total> <phase>`. Без цього прапорця OMX не читає Guardex state.

Для сесій без Team канонічною поверхнею є нативні hooks Codex:
- `plugins/oh-my-codex/hooks/hooks.json` — офіційні реєстрації hooks plugin
- `.codex/hooks.json` — legacy/fallback реєстрації native hooks
- `.omx/hooks/*.mjs` — hooks OMX plugin
- `omx tmux-hook`, notify-hook і похідний watcher — fallback-шляхи tmux/runtime

Див. [мапу native hooks Codex](../../docs/codex-native-hooks.md).

### Діагностика хибно-зеленої готовності

Зелений `omx doctor` означає, що інсталяція й локальне підключення runtime виглядають справними. Якщо виконання не вдається:
- У тому самому shell/profile запустіть `codex login status` і `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"`.
- У custom HOME, профілі, контейнері чи сервісному shell переконайтеся, що активний `~/.codex` або `CODEX_HOME` має очікувану auth/config; не припускайте, що доступний звичайний home користувача.
- Якщо використовуєте локальний OpenAI-сумісний proxy, перевірте `openai_base_url` в активному `~/.codex/config.toml`; інакше ключ proxy може потрапити на стандартний endpoint і повернути `401 Unauthorized`, `Missing bearer or basic authentication in header` чи `Incorrect API key provided`.
- Якщо `omx doctor --team` або resume повідомляє про застарілу команду, `resume_blocker` або відсутню tmux-сесію, очистьте мертвий стан:

```bash
omx team shutdown <team-name> --force --confirm-issues
omx cancel
omx doctor --team
```

Примусове shutdown використовуйте лише для команди, яку підтверджено як мертву чи навмисно залишену. Якщо `Shift+Enter` надсилає повідомлення замість перенесення рядка в OMX-tmux, див. [усунення несправностей](../../docs/troubleshooting.md#shiftenter-submits-instead-of-inserting-a-newline-in-tmux-backed-omx-sessions). OMX вже вмикає forwarding extended keys у власних шляхах запуску; стійка проблема зазвичай пов’язана з можливостями/виявленням термінала tmux.

### Sparkshell

- `omx sparkshell <command>` призначений для shell-native перевірок і обмеженої верифікації.
- Для read-only пошуку в репозиторії використовуйте звичайні засоби Codex; застарілу команду `omx explore` видалено.
- Основна й резервна моделі підсумків Sparkshell типово — `gpt-6-astra`; задайте `OMX_SPARKSHELL_FALLBACK_MODEL`, щоб вони відрізнялися.
- Вузькі env overrides: `OMX_SPARKSHELL_BIN`, `OMX_SPARKSHELL_MODEL`, `OMX_SPARKSHELL_FALLBACK_MODEL`, `OMX_SPARKSHELL_MODEL_INSTRUCTIONS_FILE`, `OMX_SPARKSHELL_SUMMARY_TIMEOUT_MS`.

```bash
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```

### Wiki

- `omx wiki` — CLI-first JSON API; MCP `omx_wiki` — лише явно ввімкнена сумісність.
- Wiki зберігає знання про проєкт у Markdown у `omx_wiki/`.
- Це Markdown-first і search-first підхід, не vector-first.

```bash
omx wiki list --json
omx wiki query --input '{"query":"session-start lifecycle"}' --json
omx wiki lint --json
omx wiki refresh --json
```

### Примітки щодо платформ для Team

`omx team` найкраще працює на macOS/Linux із `tmux`. Нативна Windows — другорядний шлях; для Windows зазвичай краще WSL2. У нативній Windows OMX приймає `psmux` як tmux-сумісний бінарник для підтримуваних шляхів.

| Платформа | Встановлення |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## Відомі проблеми

### Intel Mac: високе навантаження CPU від `syspolicyd` / `trustd` під час запуску

На деяких Intel Mac запуск OMX, особливо з `--madmax --high`, може спричинити сплеск CPU для `syspolicyd` / `trustd`, поки Gatekeeper перевіряє багато процесів одночасно.

Якщо це трапилося:
- `xattr -dr com.apple.quarantine $(which omx)`
- додайте застосунок термінала до переліку дозволених Developer Tools у налаштуваннях безпеки macOS
- зменште паралельність, наприклад не використовуйте `--madmax --high`

## Документація

- [Початок роботи](../../docs/getting-started.html)
- [Посібник демо](../../DEMO.md)
- [Функція Wiki](../../docs/wiki-feature.md)
- [Каталог агентів](../../docs/agents.html)
- [Довідник skills](../../docs/skills.html)
- [Мапа native hooks Codex](../../docs/codex-native-hooks.md)
- [Pipeline ідентичності GitHub/PR/package](../../docs/pipeline/github-pr-package-identity.md)
- [Інтеграції](../../docs/integrations.html)
- [Усунення проблем готовності виконання](../../docs/troubleshooting.md)
- [Посібник OpenClaw/notification gateway](../../docs/openclaw-integration.md)
- [Контриб’ютинг](../../CONTRIBUTING.md)
- [Журнал змін](../../CHANGELOG.md)

## Мови

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

## Учасники

| Роль | Ім’я | GitHub |
| --- | --- | --- |
| Творець і лідер | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Мейнтейнер | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Мейнтейнер | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Історія зірок

[![Графік історії зірок](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## Ліцензія

MIT

## Бенчмарк GEO-видимості

OMX містить продуктову специфікацію [`geobench`](https://github.com/NomaDamas/geobench) для вимірювання частоти влучань LLM, MRR, share of voice і цитувань.

- Специфікація: [`geobench/oh-my-codex.yaml`](../../geobench/oh-my-codex.yaml)
- Інструкція запуску: [`docs/geobench.md`](../../docs/geobench.md)
