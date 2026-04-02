# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="postać oh-my-codex" width="280">
  <br>
  <em>Zacznij z Codexem mocniej, a gdy praca zrobi się większa, pozwól OMX dodać lepsze prompty, workflow i pomoc w trakcie działania.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/PUwSMR9XNk)

**Strona:** https://yeachan-heo.github.io/oh-my-codex-website/  
**Dokumentacja:** [Pierwsze kroki](./docs/getting-started.html) · [Agenty](./docs/agents.html) · [Skills](./docs/skills.html) · [Integracje](./docs/integrations.html) · [Demo](./DEMO.md) · [Przewodnik po OpenClaw](./docs/openclaw-integration.md)

OMX to warstwa workflow dla [OpenAI Codex CLI](https://github.com/openai/codex).

Zostawia Codexa jako silnik wykonawczy i ułatwia:
- domyślne rozpoczynanie mocniejszej sesji Codexa
- ponowne używanie dobrych wywołań ról i zadań przez słowa kluczowe `$name`
- uruchamianie workflow za pomocą skills takich jak `$plan`, `$ralph` i `$team`
- trzymanie wytycznych projektu, planów, logów i stanu w `.omx/`

## Zalecany domyślny przebieg

Jeśli chcesz domyślnego doświadczenia OMX, zacznij tutaj:

```bash
npm install -g @openai/codex oh-my-codex
omx setup
omx --madmax --high
```

Potem pracuj normalnie w Codexie:

```text
$architect "analyze the authentication flow"
$plan "ship this feature cleanly"
```

To jest główna ścieżka.
Uruchom OMX mocno, wykonuj pracę w Codexie i pozwól agentowi sięgać po `$team` lub inne workflow tylko wtedy, gdy zadanie naprawdę tego wymaga.

## Do czego służy OMX

Używaj OMX, jeśli lubisz już Codexa i chcesz mieć wokół niego lepsze środowisko pracy na co dzień:
- powtarzalne wywołania ról i zadań, takie jak `$architect` i `$executor`
- powtarzalne workflow, takie jak `$plan`, `$ralph`, `$team` i `$deep-interview`
- wytyczne projektu dzięki zakresowemu `AGENTS.md`
- trwały stan w `.omx/` dla planów, logów, pamięci i śledzenia trybu

Jeśli chcesz czystego Codexa bez dodatkowej warstwy workflow, prawdopodobnie nie potrzebujesz OMX.

## Szybki start

### Wymagania

- Node.js 20+
- Zainstalowany Codex CLI: `npm install -g @openai/codex`
- Skonfigurowane uwierzytelnianie Codex
- `tmux` na macOS/Linux, jeśli później chcesz używać trwałego runtime zespołu
- `psmux` na natywnym Windows, jeśli później chcesz używać trybu zespołu na Windows

### Dobra pierwsza sesja

Uruchom OMX w zalecany sposób:

```bash
omx --madmax --high
```

Następnie wypróbuj jedno słowo kluczowe roli i jeden skill workflow:

```text
$architect "analyze the authentication flow"
$plan "map the safest implementation path"
```

Jeśli zadanie urośnie, agent może eskalować do cięższych workflow, takich jak `$ralph` dla trwałego wykonania albo `$team` dla skoordynowanej pracy równoległej.

## Prosty model mentalny

OMX **nie** zastępuje Codexa.

Dodaje wokół niego lepszą warstwę pracy:
- **Codex** wykonuje właściwą pracę agenta
- **Słowa kluczowe ról OMX** sprawiają, że przydatne role są wielokrotnego użytku
- **Skills OMX** sprawiają, że wspólne workflow są wielokrotnego użytku
- **`.omx/`** przechowuje plany, logi, pamięć i stan runtime

Większość użytkowników powinna myśleć o OMX jako o **lepszym kierowaniu zadaniami + lepszym workflow + lepszym runtime**, a nie jako o powierzchni poleceń, którą trzeba ręcznie obsługiwać przez cały dzień.

## Zacznij tutaj, jeśli jesteś nowy

1. Uruchom `omx setup`
2. Wystartuj z `omx --madmax --high`
3. Poproś o analizę przez `$architect "..."`
4. Poproś o planowanie przez `$plan "..."`
5. Pozwól agentowi zdecydować, kiedy warto użyć `$ralph`, `$team` albo innego workflow

## Częste powierzchnie w trakcie sesji

| Powierzchnia | Do czego służy |
| --- | --- |
| `$architect "..."` | analiza, granice, kompromisy |
| `$executor "..."` | skoncentrowana praca implementacyjna |
| `/skills` | przegląd zainstalowanych skills |
| `$plan "..."` | planowanie przed implementacją |
| `$ralph "..."` | trwałe wykonywanie sekwencyjne |
| `$team "..."` | skoordynowane wykonywanie równoległe, gdy zadanie jest wystarczająco duże |

Używaj `$deep-interview`, gdy prośba jest wciąż niejasna, granice są niepewne albo chcesz, aby OMX dalej dopytywał o intencję, cele poza zakresem i granice decyzji, zanim przekaże pracę do `$plan`, `$ralph`, `$team` lub `$autopilot`.

Typowe przypadki:
- niejasne pomysły greenfield, które nadal potrzebują wyraźniejszej intencji i zakresu
- zmiany brownfield, gdzie OMX powinien najpierw przejrzeć repo, a dopiero potem zadać pytania potwierdzające z cytatami
- prośby, w których chcesz pętli doprecyzowania po jednym pytaniu naraz zamiast natychmiastowego planowania lub wdrożenia

## Zaawansowane powierzchnie / dla operatora

Są przydatne, ale nie są główną ścieżką onboardingu.

### Runtime zespołu

Używaj runtime zespołu, gdy konkretnie potrzebujesz trwałej koordynacji tmux/worktree, a nie jako domyślnego sposobu rozpoczęcia pracy z OMX.

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

### Setup, doctor i HUD

To powierzchnie operatorskie i pomocnicze:
- `omx setup` instaluje prompty, skills, konfigurację i scaffolding AGENTS
- `omx doctor` weryfikuje instalację, gdy coś wydaje się nie tak
- `omx hud --watch` jest powierzchnią monitorowania/statusu, a nie podstawowym workflow użytkownika

### Explore i sparkshell

- `omx explore --prompt "..."` służy do tylko-do-odczytu wyszukiwania w repozytorium
- `omx sparkshell <command>` służy do inspekcji w shellu i ograniczonej weryfikacji

Przykłady:

```bash
omx explore --prompt "find where team state is written"
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```

### Uwagi platformowe dla trybu team

`omx team` wymaga backendu zgodnego z tmux:

| Platforma | Instalacja |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## Znane problemy

### Intel Mac: wysokie użycie CPU przez `syspolicyd` / `trustd` podczas uruchamiania

Na niektórych komputerach Intel Mac uruchamianie OMX — zwłaszcza z `--madmax --high` — może powodować skok użycia CPU przez `syspolicyd` / `trustd`, gdy macOS Gatekeeper weryfikuje wiele jednoczesnych uruchomień procesów.

Jeśli tak się dzieje, spróbuj:
- `xattr -dr com.apple.quarantine $(which omx)`
- dodać aplikację terminala do listy dozwolonych Developer Tools w ustawieniach bezpieczeństwa macOS
- użyć niższej współbieżności, na przykład unikając `--madmax --high`

## Dokumentacja

- [Pierwsze kroki](./docs/getting-started.html)
- [Przewodnik po demo](./DEMO.md)
- [Katalog agentów](./docs/agents.html)
- [Dokumentacja skills](./docs/skills.html)
- [Integracje](./docs/integrations.html)
- [Przewodnik po OpenClaw / bramce powiadomień](./docs/openclaw-integration.md)
- [Współtworzenie](./CONTRIBUTING.md)
- [Dziennik zmian](./CHANGELOG.md)

## Języki

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
- [Polski](./README.pl.md)

## Współtwórcy

| Rola | Imię i nazwisko | GitHub |
| --- | --- | --- |
| Twórca i lider | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Maintainer | HaD0Yun | [@HaD0Yun](https://github.com/HaD0Yun) |

## Historia gwiazdek

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## Licencja

MIT
