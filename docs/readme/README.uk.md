# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Починайте з Codex впевненіше — нехай OMX додасть кращі промпти, робочі процеси та підтримку під час виконання, коли обсяг роботи зростає.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/PUwSMR9XNk)

**Вебсайт:** https://yeachan-heo.github.io/oh-my-codex-website/
**Документація:** [Початок роботи](../getting-started.html) · [Агенти](../agents.html) · [Навички](../skills.html) · [Інтеграції](../integrations.html) · [Demo](../../DEMO.md) · [Посібник OpenClaw](../openclaw-integration.uk.md)
**Спільнота:** [Discord](https://discord.gg/PUwSMR9XNk) — спільний сервер OMX/спільноти для oh-my-codex та суміжних інструментів.

OMX — це шар робочих процесів для [OpenAI Codex CLI](https://github.com/openai/codex).

Він залишає Codex рушієм виконання й допомагає:
- запускати потужнішу сесію Codex за замовчуванням
- виконувати єдиний послідовний робочий процес від уточнення до завершення
- викликати канонічні навички через `$deep-interview`, `$ralplan`, `$team` і `$ralph`
- зберігати керівні принципи проєкту, плани, журнали та стан у `.omx/`

## Основні мейнтейнери

| Роль | Ім'я | GitHub |
| --- | --- | --- |
| Автор та керівник | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Мейнтейнер | HaD0Yun | [@HaD0Yun](https://github.com/HaD0Yun) |

## Амбасадори

| Ім'я | GitHub |
| --- | --- |
| Sigrid Jin | [@sigridjineth](https://github.com/sigridjineth) |

## Провідні контриб'ютори

| Ім'я | GitHub |
| --- | --- |
| HaD0Yun | [@HaD0Yun](https://github.com/HaD0Yun) |
| Junho Yeo | [@junhoyeo](https://github.com/junhoyeo) |
| JiHongKim98 | [@JiHongKim98](https://github.com/JiHongKim98) |
| Lor | [@gobylor](https://github.com/gobylor) |
| HyunjunJeon | [@HyunjunJeon](https://github.com/HyunjunJeon) |

## Рекомендований стандартний процес

Якщо ви хочете отримати стандартний досвід OMX, почніть тут:

```bash
npm install -g @openai/codex oh-my-codex
omx setup
omx --madmax --high
```

Далі працюйте звично всередині Codex:

```text
$deep-interview "clarify the authentication change"
$ralplan "approve the auth plan and review tradeoffs"
$ralph "carry the approved plan to completion"
$team 3:executor "execute the approved plan in parallel"
```

Це основний шлях.
Запускайте OMX потужно, уточнюйте спочатку за необхідності, схвалюйте план, а потім обирайте `$team` для скоординованого паралельного виконання або `$ralph` для циклу наполегливого завершення.

## Для чого призначений OMX

Використовуйте OMX, якщо вам уже подобається Codex і ви хочете зручнішу щоденну роботу з ним:
- стандартний робочий процес, побудований навколо `$deep-interview`, `$ralplan`, `$team` і `$ralph`
- спеціалізовані ролі та допоміжні навички, коли завдання їх потребує
- керівні принципи проєкту через локальний `AGENTS.md`
- постійний стан у `.omx/` для планів, журналів, пам'яті та відстеження режимів

Якщо ви хочете простий Codex без додаткового шару робочих процесів, OMX вам, мабуть, не потрібен.

## Швидкий старт

### Вимоги

- Node.js 20+
- встановлений Codex CLI: `npm install -g @openai/codex`
- налаштована автентифікація Codex
- `tmux` на macOS/Linux, якщо пізніше знадобиться стійкий командний рушій
- `psmux` на нативному Windows, якщо пізніше знадобиться командний режим для Windows

### Вдала перша сесія

Запустіть OMX рекомендованим способом:

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

Використовуйте `$team`, коли затверджений план потребує скоординованої паралельної роботи, або `$ralph`, коли один наполегливий відповідальний має продовжувати до завершення.

## Проста ментальна модель

OMX **не** замінює Codex.

Він додає кращий шар роботи навколо нього:
- **Codex** виконує фактичну роботу агента
- **Ключові слова ролей OMX** роблять корисні ролі багаторазовими
- **Навички OMX** роблять типові робочі процеси багаторазовими
- **`.omx/`** зберігає плани, журнали, пам'ять і стан роботи

Більшість користувачів мають сприймати OMX як **кращу маршрутизацію завдань + кращий робочий процес + кращий рушій**, а не як набір команд для ручного керування цілий день.

## Почніть тут, якщо ви новачок

1. Запустіть `omx setup`
2. Запустіть з `omx --madmax --high`
3. Використовуйте `$deep-interview "..."`, коли запит або межі ще не ясні
4. Використовуйте `$ralplan "..."`, щоб схвалити план і переглянути компроміси
5. Обирайте `$team` для скоординованого паралельного виконання або `$ralph` для циклів наполегливого завершення

## Рекомендований робочий процес

1. `$deep-interview` — уточнюйте обсяг, коли запит або межі ще розмиті.
2. `$ralplan` — перетворіть уточнений обсяг на затверджену архітектуру та план реалізації.
3. `$team` або `$ralph` — використовуйте `$team` для скоординованого паралельного виконання або `$ralph`, коли потрібен цикл наполегливого завершення з одним відповідальним.

## Типові команди під час сесії

| Команда | Призначення |
| --- | --- |
| `$deep-interview "..."` | уточнення намірів, меж і не-цілей |
| `$ralplan "..."` | схвалення плану реалізації та компромісів |
| `$ralph "..."` | цикли наполегливого завершення та перевірки |
| `$team "..."` | скоординоване паралельне виконання, коли обсяг достатньо великий |
| `/skills` | перегляд встановлених навичок і допоміжних інструментів |

## Розширені / службові можливості

Це корисні функції, але вони не є основним шляхом для початку роботи.

### Командний режим

Використовуйте командний режим, коли вам справді потрібна стійка координація tmux/worktree, а не як стандартний спосіб починати з OMX.

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

### Setup, doctor і HUD

Це службові команди підтримки:
- `omx setup` встановлює промпти, навички, конфіг і структуру AGENTS
- `omx doctor` перевіряє встановлення, коли щось здається не так
- `omx hud --watch` — це інструмент моніторингу стану, а не основний робочий процес користувача

### Explore і sparkshell

- `omx explore --prompt "..."` призначений для пошуку в репозиторії лише для читання
- `omx sparkshell <command>` призначений для перевірки в терміналі та обмеженої валідації

Приклади:

```bash
omx explore --prompt "find where team state is written"
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```

### Власність нативних хуків

Для не-командних сесій OMX тепер працює переважно через нативні хуки:

- `omx setup` має увімкнути нативні хуки Codex (`[features].codex_hooks = true`) у
  підтримуваних областях.
- локальні хуки Codex на рівні репозиторію є канонічною поверхнею автоматизації для не-командних сесій
- `omx tmux-hook` зарезервовано для поведінки командного рушія та усунення проблем із застарілим tmux
- непідтримувані або вимкнені рушії нативних хуків мають повідомляти явний статус setup/doctor замість
  тихого переходу на не-командне впровадження tmux

Дивіться [Розширення хуків](../hooks-extension.md) для контракту власності нативних хуків та плагінів.

### Примітки щодо платформ для командного режиму

`omx team` потребує інструмента, сумісного з tmux:

| Платформа | Встановлення |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## Відомі проблеми

### Intel Mac: висока завантаженість CPU `syspolicyd` / `trustd` під час запуску

На деяких Intel Mac запуск OMX — особливо з `--madmax --high` — може різко підвищити завантаженість CPU `syspolicyd` / `trustd`, поки macOS Gatekeeper перевіряє численні одночасні запуски процесів.

Якщо це трапляється, спробуйте:
- `xattr -dr com.apple.quarantine $(which omx)`
- додайте свій термінал до списку дозволених Developer Tools у налаштуваннях безпеки macOS
- використовуйте нижчий рівень паралелізму (наприклад, уникайте `--madmax --high`)

## Документація

- [Початок роботи](../getting-started.html)
- [Посібник Demo](../../DEMO.md)
- [Каталог агентів](../agents.html)
- [Довідник навичок](../skills.html)
- [Інтеграції](../integrations.html)
- [Посібник OpenClaw / шлюзу сповіщень](../openclaw-integration.uk.md)
- [Участь у проєкті](../../CONTRIBUTING.md)
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

## Учасники

| Роль | Ім'я | GitHub |
| --- | --- | --- |
| Автор та керівник | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Мейнтейнер | HaD0Yun | [@HaD0Yun](https://github.com/HaD0Yun) |

## Історія зірок

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## Ліцензія

MIT
