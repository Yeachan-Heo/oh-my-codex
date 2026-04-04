# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="postać oh-my-codex" width="280">
  <br>
  <em>Zacznij z Codexem jak zwykle. Gdy projekt urośnie — niech OMX wesprze resztę.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/PUwSMR9XNk)

**Strona:** https://yeachan-heo.github.io/oh-my-codex-website/
**Dokumentacja:** [Pierwsze kroki](../getting-started.html) · [Agenty](../agents.html) · [Skille](../skills.html) · [Integracje](../integrations.html) · [Demo](../../DEMO.md) · [Przewodnik po OpenClaw](../openclaw-integration.md)

OMX to nakładka na [OpenAI Codex CLI](https://github.com/openai/codex).

Codex zostaje silnikiem, który wykonuje pracę. OMX daje mu lepszy kontekst, gotowe role i cykle pracy — żebyś nie zaczynał od zera przy każdej sesji. Konkretnie:
- lepsza sesja Codexa od pierwszego uruchomienia
- wielokrotne użycie ról i zadań przez słowa kluczowe `$name`
- gotowe cykle pracy: `$plan`, `$ralph`, `$team`
- plany, logi, pamięć i stan trzymane w `.omx/`

## Jak zacząć

Jeśli chcesz po prostu zacząć:

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

To jest główna ścieżka. Uruchom OMX, wykonaj pracę w Codexie i pozwól agentowi sięgać po `$team` lub inne cykle pracy tylko wtedy, gdy zadanie naprawdę tego wymaga.

## Do czego służy OMX

Używaj OMX, jeśli lubisz Codexa i chcesz mieć wokół niego lepsze środowisko pracy:
- wielokrotne role i zadania: `$architect`, `$executor`
- gotowe cykle pracy: `$plan`, `$ralph`, `$team`, `$deep-interview`
- wytyczne projektu przez `AGENTS.md`
- trwały stan w `.omx/`

Jeśli chcesz czystego Codexa bez żadnych dodatków, OMX pewnie nie jest dla Ciebie.

## Szybki start

### Wymagania

- Node.js 20+
- Codex CLI: `npm install -g @openai/codex`
- Skonfigurowane uwierzytelnianie Codex
- `tmux` na macOS/Linux — jeśli planujesz używać trybu zespołowego
- `psmux` na natywnym Windows — jeśli planujesz używać trybu zespołowego

### Dobra pierwsza sesja

```bash
omx --madmax --high
```

Potem wypróbuj jedną rolę i jeden skill:

```text
$architect "analyze the authentication flow"
$plan "map the safest implementation path"
```

Jeśli zadanie urośnie, agent może sam zdecydować o użyciu `$ralph` albo `$team`.

## Jak o tym myśleć

OMX **nie** zastępuje Codexa.

To warstwa, która go otacza:
- **Codex** wykonuje właściwą pracę
- **Role OMX** sprawiają, że przydatne role są wielokrotnego użytku
- **Skille OMX** dają gotowe cykle pracy
- **`.omx/`** przechowuje plany, logi, pamięć i stan

OMX to lepsze kierowanie zadaniami i gotowe cykle pracy — nie kolejna rzecz do klikania przez cały dzień.

## Zacznij tutaj, jeśli jesteś nowy

1. Uruchom `omx setup`
2. Wystartuj z `omx --madmax --high`
3. Poproś o analizę: `$architect "..."`
4. Poproś o plan: `$plan "..."`
5. Pozwól agentowi zdecydować, kiedy użyć `$ralph`, `$team` albo czegoś innego

## Co możesz robić podczas sesji

| Komenda | Do czego służy |
| --- | --- |
| `$architect "..."` | analiza, granice, kompromisy |
| `$executor "..."` | skupiona praca implementacyjna |
| `/skills` | lista zainstalowanych skilli |
| `$plan "..."` | planowanie przed implementacją |
| `$ralph "..."` | długie zadania krok po kroku |
| `$team "..."` | równoległa praca kilku agentów, gdy zadanie tego wymaga |

`$deep-interview` przydaje się, gdy prośba jest niejasna — OMX będzie dopytywał o intencję, zakres i granice decyzji, zanim przekaże pracę dalej do `$plan`, `$ralph`, `$team` albo `$autopilot`.

Kiedy to ma sens:
- masz pomysł na nowy projekt, ale jeszcze nie wiesz dokładnie, czego chcesz
- chcesz, żeby OMX najpierw przejrzał repo, a dopiero potem zadał pytania z konkretnymi cytatami
- wolisz doprecyzowywać po jednym pytaniu naraz zamiast od razu planować

## Zaawansowane / dla operatorów

Poniższe funkcje są przydatne, ale nie są główną ścieżką.

### Tryb zespołowy

Używaj trybu zespołowego, gdy konkretnie potrzebujesz trwałej koordynacji z tmuxem i gałęziami roboczymi — nie jako domyślnego sposobu pracy z OMX.

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

### Setup, doctor i HUD

- `omx setup` — instaluje prompty, skille, konfigurację i strukturę plików AGENTS
- `omx doctor` — sprawdza instalację, gdy coś nie działa
- `omx hud --watch` — podgląd stanu i postępu, nie główny cykl pracy

### Explore i sparkshell

- `omx explore --prompt "..."` — przeszukuje repo tylko do odczytu
- `omx sparkshell <command>` — inspekcja w shellu i ograniczona weryfikacja

Przykłady:

```bash
omx explore --prompt "find where team state is written"
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```

### Wymagania platformowe dla trybu zespołowego

`omx team` wymaga tmux lub odpowiednika:

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

Na niektórych komputerach Intel Mac uruchamianie OMX — zwłaszcza z `--madmax --high` — może powodować skok użycia CPU przez `syspolicyd` i `trustd`. Dzieje się tak, gdy macOS Gatekeeper weryfikuje wiele procesów naraz.

Jeśli to widzisz:
- `xattr -dr com.apple.quarantine $(which omx)`
- dodaj terminal do listy Developer Tools w ustawieniach bezpieczeństwa macOS
- ogranicz współbieżność, np. unikając `--madmax --high`

## Dokumentacja

- [Pierwsze kroki](../getting-started.html)
- [Przewodnik po demo](../../DEMO.md)
- [Katalog agentów](../agents.html)
- [Dokumentacja skilli](../skills.html)
- [Integracje](../integrations.html)
- [Przewodnik po OpenClaw / bramce powiadomień](../openclaw-integration.md)
- [Współtworzenie](../../CONTRIBUTING.md)
- [Dziennik zmian](../../CHANGELOG.md)

## Języki

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
