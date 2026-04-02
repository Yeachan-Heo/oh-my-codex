# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="персонаж oh-my-codex" width="280">
  <br>
  <em>Запускай Codex як зазвичай. Коли проєкт росте — OMX подбає про решту.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/PUwSMR9XNk)

**Сайт:** https://yeachan-heo.github.io/oh-my-codex-website/  
**Документація:** [Початок роботи](./docs/getting-started.html) · [Агенти](./docs/agents.html) · [Навички](./docs/skills.html) · [Інтеграції](./docs/integrations.html) · [Демо](./DEMO.md) · [Посібник з OpenClaw](./docs/openclaw-integration.md)

OMX — це шар робочих процесів для [OpenAI Codex CLI](https://github.com/openai/codex).

Codex залишається двигуном, який виконує роботу. OMX надає йому кращий контекст, готові ролі та робочі процеси — щоб ви не починали з нуля кожну сесію. А саме:
- краща сесія Codex з першого запуску
- багаторазове використання ролей і завдань через ключові слова `$name`
- готові робочі процеси: `$deep-interview`, `$ralplan`, `$team`, `$ralph`
- плани, логи, пам'ять і стан зберігаються в `.omx/`

## Як почати

Якщо ви хочете просто розпочати:

```bash
npm install -g @openai/codex oh-my-codex
omx setup
omx --madmax --high
```

Потім працюйте як зазвичай у Codex:

```text
$deep-interview "clarify the authentication change"
$ralplan "approve the auth plan and review tradeoffs"
$ralph "carry the approved plan to completion"
$team 3:executor "execute the approved plan in parallel"
```

Це — основний шлях.
Запустіть OMX, уточніть задачу за потреби, затвердіть план, а потім оберіть `$team` для координованого паралельного виконання або `$ralph` для послідовного циклу завершення з одним відповідальним.

## Для чого потрібен OMX

Використовуйте OMX, якщо вам подобається Codex і ви хочете кращий робочий досвід навколо нього:
- стандартний робочий процес на основі `$deep-interview`, `$ralplan`, `$team` та `$ralph`
- спеціалізовані ролі та допоміжні навички, коли завдання цього потребує
- настанови проєкту через `AGENTS.md`
- стійкий стан у `.omx/` для планів, логів, пам'яті та відстеження режимів

Якщо вам потрібен чистий Codex без додаткових шарів — OMX вам, мабуть, не потрібен.

## Швидкий старт

### Вимоги

- Node.js 20+
- Codex CLI: `npm install -g @openai/codex`
- Налаштована автентифікація Codex
- `tmux` на macOS/Linux — якщо плануєте використовувати командний режим
- `psmux` на Windows — якщо плануєте використовувати командний режим у Windows

### Перша вдала сесія

Запустіть OMX рекомендованим чином:

```bash
omx --madmax --high
```

Потім спробуйте канонічний робочий процес:

```text
$deep-interview "clarify the authentication change"
$ralplan "approve the safest implementation path"
$ralph "carry the approved plan to completion"
$team 3:executor "execute the approved plan in parallel"
```

Використовуйте `$team`, коли затверджений план потребує координованої паралельної роботи, або `$ralph`, коли один відповідальний має послідовно доводити задачу до завершення.

## Проста ментальна модель

OMX **не** замінює Codex.

Він додає кращий робочий шар навколо нього:
- **Codex** виконує основну роботу агента
- **Ролі OMX** роблять корисні ролі багаторазовими
- **Навички OMX** роблять типові робочі процеси багаторазовими
- **`.omx/`** зберігає плани, логи, пам'ять і стан виконання

Більшість користувачів мають сприймати OMX як **краще маршрутизування задач + кращий робочий процес + краще середовище виконання**, а не як командну панель для ручного управління протягом усього дня.

## Почніть тут, якщо ви новачок

1. Виконайте `omx setup`
2. Запустіть `omx --madmax --high`
3. Використовуйте `$deep-interview "..."`, коли запит або межі ще не прояснені
4. Використовуйте `$ralplan "..."`, щоб затвердити план та розглянути компроміси
5. Оберіть `$team` для координованого паралельного виконання або `$ralph` для послідовного циклу завершення

## Рекомендований робочий процес

1. `$deep-interview` — прояснити обсяг, коли запит або межі ще розмиті.
2. `$ralplan` — перетворити прояснений обсяг на затверджений план архітектури та реалізації.
3. `$team` або `$ralph` — використовуйте `$team` для координованого паралельного виконання, або `$ralph`, якщо потрібен послідовний цикл завершення з одним відповідальним.

## Типові поверхні під час сесії

| Поверхня | Для чого |
| --- | --- |
| `$deep-interview "..."` | прояснення наміру, меж і не-цілей |
| `$ralplan "..."` | затвердження плану реалізації та компромісів |
| `$ralph "..."` | послідовний цикл завершення та верифікації |
| `$team "..."` | координоване паралельне виконання, коли обсяг роботи достатній |
| `/skills` | перегляд встановлених навичок та допоміжних інструментів |

## Розширене / для операторів

Ці функції корисні, але вони не є основним шляхом для початку роботи.

### Командний режим

Використовуйте командний режим, коли конкретно потрібна стійка координація через tmux/worktree — не як спосіб за замовчуванням працювати з OMX.

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

### Setup, doctor та HUD

- `omx setup` — встановлює промпти, навички, конфігурацію та структуру AGENTS
- `omx doctor` — перевіряє встановлення, коли щось працює не так
- `omx hud --watch` — моніторинг стану та прогресу, не основний робочий процес

### Explore та sparkshell

- `omx explore --prompt "..."` — пошук по репозиторію тільки для читання
- `omx sparkshell <command>` — інспекція через оболонку та обмежена верифікація

Приклади:

```bash
omx explore --prompt "find where team state is written"
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```

### Вимоги до платформи для командного режиму

`omx team` потребує tmux-сумісного бекенду:

| Платформа | Встановлення |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## Відомі проблеми

### Intel Mac: високе навантаження CPU через `syspolicyd` / `trustd` під час запуску

На деяких Intel Mac запуск OMX — особливо з `--madmax --high` — може спричинити стрибок навантаження CPU через `syspolicyd` та `trustd`, поки macOS Gatekeeper перевіряє багато одночасних запусків процесів.

Якщо це трапляється:
- `xattr -dr com.apple.quarantine $(which omx)`
- додайте ваш термінал до списку Developer Tools у налаштуваннях безпеки macOS
- зменшіть паралелізм, наприклад, уникаючи `--madmax --high`

## Історія Pull Request

Цей проєкт побудований спільнотою. Ось як виглядає типовий процес внеску через Pull Request:

### Як зробити внесок

1. **Форкніть репозиторій** — натисніть кнопку «Fork» на сторінці [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex).
2. **Створіть гілку** — `git checkout -b feature/my-awesome-feature`
3. **Внесіть зміни** — дотримуйтесь стилю коду проєкту та конвенцій з `CONTRIBUTING.md`.
4. **Напишіть тести** — переконайтесь, що `npm test` проходить успішно.
5. **Зробіть коміт** — використовуйте зрозумілі повідомлення комітів.
6. **Надішліть PR** — опишіть, що змінилось, чому, та додайте скріншоти за потреби.

### Що відбувається після відкриття PR

- **Автоматичні перевірки** — CI запускає лінтер, перевірку типів та тести.
- **Рев'ю коду** — мейнтейнери переглядають зміни, можуть залишити коментарі або запитати правки.
- **Ітерації** — автор вносить зміни відповідно до фідбеку.
- **Мердж** — після затвердження PR зливають у головну гілку.

### Поради для успішного PR

- Тримайте PR невеликими та сфокусованими — один PR = одна зміна.
- Додайте опис «чому», а не тільки «що».
- Перевірте, що тести проходять локально перед надсиланням.
- Будьте відкриті до фідбеку — рев'ю коду покращує якість для всіх.

## Документація

- [Початок роботи](./docs/getting-started.html)
- [Посібник з демо](./DEMO.md)
- [Каталог агентів](./docs/agents.html)
- [Довідник навичок](./docs/skills.html)
- [Інтеграції](./docs/integrations.html)
- [Посібник з OpenClaw / шлюзу сповіщень](./docs/openclaw-integration.md)
- [Внески](./CONTRIBUTING.md)
- [Журнал змін](./CHANGELOG.md)

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

## Учасники

| Роль | Ім'я | GitHub |
| --- | --- | --- |
| Творець та лід | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Мейнтейнер | HaD0Yun | [@HaD0Yun](https://github.com/HaD0Yun) |

## Історія зірок

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## Ліцензія

MIT
