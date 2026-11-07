# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="Postać oh-my-codex" width="280">
  <br>
  <em>Zacznij z mocniejszym Codexem, a OMX doda lepsze prompty, przepływy pracy i wsparcie runtime, gdy zadanie urośnie.</em>
  <br><br>
  <strong>Lubisz OMX, ale wydaje się zbyt rozbudowany? <a href="https://github.com/Yeachan-Heo/gajae-code">Wypróbuj gajae-code</a>.</strong><br>
  <sub>Zachowaj OAuth Codexa, korzystając z szybszej, tańszej, prostszej i wydajniejszej ścieżki opartej na SDK dla OpenClaw, Hermes, Grokbot i innych integracji.</sub>
</p>

[![wersja npm](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![Licencja: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/wSyUQYfhAw)

**Strona:** https://yeachan-heo.github.io/oh-my-codex-website/

**Dokumentacja:** [Pierwsze kroki](../getting-started.html) · [Agenci](../agents.html) · [Skills](../skills.html) · [Integracje](../integrations.html) · [Demo](../../DEMO.md) · [Przewodnik OpenClaw](../../docs/openclaw-integration.md)

**Społeczność:** [Discord](https://discord.gg/wSyUQYfhAw) — wspólny serwer społeczności Gajae dla oh-my-codex, [gajae-code](https://github.com/Yeachan-Heo/gajae-code) i powiązanych narzędzi.

## Oficjalny projekt i pakiet

Oficjalnym/pierwotnym projektem OMX jest to repozytorium, [`Yeachan-Heo/oh-my-codex`](https://github.com/Yeachan-Heo/oh-my-codex), a oficjalnym pakietem npm jest [`oh-my-codex`](https://www.npmjs.com/package/oh-my-codex). Zainstaluj go poleceniem `npm install -g oh-my-codex` (lub razem z Codex CLI, jak pokazano poniżej).

Projekty zewnętrzne i forki o nazwach takich jak „OMX v2” nie są oficjalną kontynuacją, zamiennikiem ani linią wydań tego repozytorium, chyba że README lub dokumentacja mówią o tym wprost. W razie wątpliwości za oficjalny cel instalacji uznaj to repozytorium i pakiet `oh-my-codex`.

OMX to warstwa przepływu pracy dla [OpenAI Codex CLI](https://github.com/openai/codex).

<table>
<tr>
<td><strong>🚨 UWAGA — ZALECANE USTAWIENIE DOMYŚLNE: macOS lub Linux z Codex CLI.</strong><br><br><strong>OMX został zaprojektowany głównie z myślą o tej ścieżce i jest dla niej aktywnie optymalizowany.</strong><br><strong>Natywny Windows i Codex App nie są domyślnym doświadczeniem, mogą działać nieprawidłowo lub niespójnie i obecnie są słabiej wspierane.</strong></td>
</tr>
</table>

OMX pozostawia Codex jako silnik wykonawczy i ułatwia:
- domyślne uruchamianie mocniejszej sesji Codexa
- korzystanie ze spójnego przepływu od doprecyzowania do ukończenia
- niezależne wywoływanie kanonicznych przepływów `$plan`, `$ultragoal`, `$team`, `$code-review` i `$ultraqa`, bez stałego łańcucha
- przechowywanie instrukcji projektu, planów, logów i stanu w `.omx/`

## Główni opiekunowie

| Rola | Imię i nazwisko | GitHub |
| --- | --- | --- |
| Twórca i lider | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Opiekun | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Opiekun | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Ambasadorzy

| Imię i nazwisko | GitHub |
| --- | --- |
| Sigrid Jin | [@sigridjineth](https://github.com/sigridjineth) |

## Najważniejsi współtwórcy

| Imię i nazwisko | GitHub |
| --- | --- |
| Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Junho Yeo | [@junhoyeo](https://github.com/junhoyeo) |
| JiHongKim98 | [@JiHongKim98](https://github.com/JiHongKim98) |
| Lor | [@gobylor](https://github.com/gobylor) |
| HyunjunJeon | [@HyunjunJeon](https://github.com/HyunjunJeon) |

## Zalecany przepływ domyślny

Aby skorzystać z domyślnego doświadczenia OMX, zacznij tutaj. Wybierz jedną ścieżkę instalacji.

Jeśli Codex CLI jest już zainstalowany (przez Homebrew, npm lub inną obsługiwaną metodę):

```bash
codex --version
npm install -g oh-my-codex
# z repozytorium Git, które chcesz edytować za pomocą Codexa; wybierz nazwę właściwą dla zadania
omx --worktree=feat/task --madmax --xhigh
```

Jeśli nie masz jeszcze Codex CLI i chcesz zarządzać nim przez npm:

```bash
npm install -g @openai/codex
npm install -g oh-my-codex
```

Nie uruchamiaj `npm install -g @openai/codex oh-my-codex` w przypadku istniejącego binarium `codex` zarządzanego przez Homebrew, np. `/opt/homebrew/bin/codex`; npm może zakończyć się błędem `EEXIST`, próbując utworzyć to samo binarium. OMX potrzebuje jedynie działającego, uwierzytelnionego polecenia `codex` w `PATH`; Codex nie musi być zainstalowany przez npm.

Po instalacji nowej wersji `oh-my-codex` npm wyświetla wyraźne przypomnienie zamiast automatycznie uruchamiać setup. Gdy będziesz gotowy, uruchom setup z odpowiednim zakresem albo użyj `omx update`, aby sprawdzić npm i wykonać odświeżenie setupu.

OMX sprawdza również aktualizacje npm przy uruchomieniu, z ograniczoną częstotliwością, i prosi o zgodę na zaplanowanie aktualizacji po zakończeniu bieżącej sesji. Ustaw `OMX_AUTO_UPDATE=0`, aby wyłączyć sprawdzanie, albo `OMX_AUTO_UPDATE=defer`, aby zaplanować taką aktualizację bez pytania.

Świadomie wybierz zakres setupu:
- Uruchom `omx setup --scope project --merge-agents` w repozytorium Git, w którym OMX ma działać, jeśli to repo ma przechowywać trwałe instrukcje `AGENTS.md`.
- Użyj `omx setup --scope user`, aby skonfigurować Codex na poziomie użytkownika, jeśli bieżący katalog nie ma być projektem OMX.
- Unikaj setupu projektowego z szerokiego katalogu domowego lub huba operacyjnego, chyba że to właśnie jest projekt. Użytkownikowy `AGENTS.md` często zawiera globalne zasady bezpieczeństwa i routingu; instrukcje runtime specyficzne dla projektu przechowuj w jego repozytorium.

### Jawna polityka scalania AGENTS

`omx setup --merge-agents`, `omx setup --no-merge-agents` i `omx setup --clear-merge-agents-policy` to jedyne selektory polityki; używaj ich bez zapisu `=value`. Powtórzenie tego samego selektora jest bezpieczne, ale połączenie ustawiania z czyszczeniem kończy setup przed zmianami. Jawne ustawienie ma pierwszeństwo przed zapisanym. Pomyślne ustawienie zapisuje `mergeAgents: true` lub `false` w `./.omx/setup-scope.json` bieżącego katalogu głównego, także przy zakresie `user`; nie jest to globalna preferencja ani ustawienie przenoszone do innego katalogu. Kolejne `omx update` odtwarza poprawną politykę zgodną z zakresem dla natychmiastowych i odroczonych odświeżeń.

`true` wybiera istniejącą ścieżkę scalania. `false` jedynie ją wyłącza — nie gwarantuje zachowania, zastąpienia ani nowego trybu bezpieczeństwa; nadal obowiązują dotychczasowe reguły prompts, pomijania, zarządzanego odświeżania, ustawień pluginu i `--force`. Przegląd w tym samym zakresie zachowuje politykę przy zmianie innych ustawień. Reset lub zmiana zakresu usuwa odziedziczoną politykę, chyba że ta sama operacja jawnie ustawi `true` albo `false`; czyszczenie zawsze ją usuwa i nie może być łączone z selektorem ustawiania. Niepoprawne, nieznane, niebooleanowe lub niezgodne z zakresem dane są bezpiecznie ignorowane.

`--force` jest niezależne i tymczasowe: nie jest zapisywane ani odtwarzane i nie nadpisuje jawnej polityki. Setup atomowo zapisuje jawny zamiar ustawienia lub wyczyszczenia dopiero po pełnym powodzeniu, nawet jeśli zabezpieczenia aktywnej sesji lub symlinka pluginu pomijają zapis bieżącego `AGENTS.md`. Nie czyni to scalania domyślnym ani nie przywraca odrzuconego podejścia #2892 „zawsze scalaj”. Starsze wersje OMX bezpiecznie ignorują to pole, ale mogą je usunąć podczas przepisywania znanych preferencji setupu.

**Informacja o instalacji pluginu Codex:** repozytorium zawiera też oficjalny układ pluginu w `plugins/oh-my-codex` i metadane marketplace w `.agents/plugins/marketplace.json`. Plugin dostarcza lustrzaną powierzchnię skills oraz metadane oficjalnych lifecycle hooks Codexa, opcjonalnych serwerów MCP i aplikacji. Nie zastępuje globalnego CLI `oh-my-codex` ani setupu z zakresem: hooki pluginu uruchamiają zainstalowany CLI `omx`, a oba tryby setupu zwykle instalują TOML natywnych agentów do routingu `agent_type`. W obu trybach `omx setup --disable-hooks` wyłącza rejestracje hooków OMX i kończy działanie przed zwykłą instalacją zasobów, konfiguracją, `AGENTS.md`, HUD i stanem. Tryb legacy instaluje również kopie prompts i skills. Tryb pluginu odkrywa skills z pakietu, archiwizuje/usuwa stare kopie prompts zarządzane przez OMX i usuwa nieaktualne lub nieinstalowalne wygenerowane pliki native-agent. Bez `--force` zachowuje pliki ról utworzone przez użytkownika lub niejednoznaczne; wyłączenie Team przez `--disable-team` lub zapisane `teamMode: "disabled"` tworzy kopię zapasową i usuwa `team-executor.toml` niezależnie od właściciela. Zobacz [Plugin bundle SSOT](../../docs/plugin-bundle-ssot.md). Tryb pluginu nadal wymaga trwałego `AGENTS.md` dla zakresu (`~/.codex/AGENTS.md` dla setupu użytkownika lub `./AGENTS.md` dla setupu projektu); pliki sesji tylko łączą te instrukcje z runtime overlay i ich nie zastępują.

Następnie pracuj normalnie w Codexie:

```text
# Trwały cel/checkpointy dla długiego zadania:
/goal Przygotować bezpieczny plan refaktoryzacji uwierzytelniania, wdrożyć go i zweryfikować logowanie, wylogowanie oraz odświeżanie tokenów.

$deep-interview "doprecyzować zmianę uwierzytelniania"
$ralplan "zatwierdzić plan uwierzytelniania i ocenić kompromisy"
$ultragoal "zamienić zatwierdzony plan w trwałe cele Codexa"
```

To główna ścieżka. Zanim uznasz runtime za gotowy, wykonaj test startowy poniżej: `omx doctor` sprawdza instalację, a `omx exec` potwierdza, że aktywne środowisko Codexa może się uwierzytelnić i wykonać zapytanie do modelu. Uruchamiaj OMX z projektu Git, najpierw doprecyzuj wymagania, zatwierdź plan i używaj `$ultragoal` jako domyślnej trwałej ścieżki realizacji. `$team` stosuj w niej tylko wtedy, gdy konkretna historia Ultragoal wymaga koordynacji równoległej.

## Do czego służy OMX

Użyj OMX, jeśli lubisz Codexa i chcesz lepszego środowiska pracy na co dzień:
- standardowy przepływ `$deep-interview` → `$ralplan` → `$ultragoal`
- granice researchu: `$best-practice-research` dla oficjalnych/upstreamowych źródeł przed planowaniem; `$autoresearch` dla ograniczonych badań z walidacją (`$deep-interview --autoresearch` na wejściu, potem `$autoresearch` z wybranym trybem walidacji); wyniki przekaż do `$ralplan`
- trwałe przekazanie wielu celów przez `$ultragoal` i artefakty `.omx/ultragoal`
- role specjalistyczne i skills pomocnicze, gdy są potrzebne
- instrukcje projektu przez `AGENTS.md`
- trwały stan w `.omx/` dla planów, logów, pamięci i trybów

Jeśli chcesz czystego Codexa bez dodatkowej warstwy workflow, prawdopodobnie nie potrzebujesz OMX.

## Szybki start

### Wymagania

- Node.js 20+
- Zainstalowany Codex CLI, sprawdzony poleceniem `codex --version`, i skonfigurowane uwierzytelnianie (Homebrew i npm są obsługiwane; nie instaluj ponownie `@openai/codex` przez npm, jeśli Homebrew już zarządza binarium `codex`)
- Uwierzytelnianie Codexa widoczne w tym samym shellu/profilu, z którego uruchomisz OMX
- `tmux` w macOS/Linux dla zalecanego trwałego Team runtime
- Tylko na natywnym Windows — `psmux`, jeśli celowo wybierasz słabiej wspieraną ścieżkę Team

### Dobra pierwsza sesja

Po instalacji sprawdź oba poziomy:

```bash
omx doctor
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```

`omx doctor` wykrywa brakujące pliki, hooki i wymagania runtime. Prawdziwy smoke test wychwytuje problemy auth, profilu lub bazowego URL providera, które pojawiają się dopiero przy rzeczywistym zapytaniu Codexa.

Zalecany sposób uruchomienia z projektu Git:

```bash
omx --worktree=feat/task --madmax --xhigh
```

W interaktywnym terminalu macOS/Linux z `tmux` lider domyślnie startuje w odłączonym tmux zarządzanym przez OMX, co pozwala tworzyć i odzyskiwać panele HUD/runtime. `--worktree` przenosi pracę do osobnego checkoutu Git, bezpieczniejszego przy `--madmax`. Zastąp `feat/task` nazwą przypominającą gałąź.

### Równoległe standardowe rozmowy

Standardowe uruchomienie ma jeden zapisywalny wskaźnik sesji w wybranym `OMX_ROOT`. Drugie zwykłe `omx` w tym samym checkoucie kończy się bezpiecznie, zamiast współdzielić lub po cichu zmieniać ten katalog. Każdej dodatkowej rozmowie przypisz osobny root:

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

Wiersz polecenia Windows:

```bat
set "OMX_ROOT=%USERPROFILE%\.omx\instances\second-conversation"
omx
```

Root podany przez użytkownika jest traktowany dosłownie: dwa uruchomienia z tym samym jawnym `OMX_ROOT` powodują konflikt właściciela. Oddzielne checkouty mają różne domyślne rooty; `--worktree` i `--madmax` zachowują izolację.

### Bezpieczeństwo uruchomienia Madmax i worktree

`--madmax` to skrót OMX dla `--dangerously-bypass-approvals-and-sandbox` w Codexie. Usuwa standardowe zabezpieczenia zatwierdzania i sandboxa, więc używaj go tylko w zaufanych repozytoriach i środowiskach. `--high` i `--xhigh` są skrótami dla `-c model_reasoning_effort="high|xhigh"`. Zwykła mocna sesja to `omx --madmax --xhigh` (lub `omx --worktree=feat/task --madmax --xhigh`).

Uruchamiając `--madmax` w repozytorium Git, wybierz worktree zamiast bieżącego checkoutu. Do pracy powtarzalnej lub równoległej używaj nazwanych worktree:

```bash
omx --worktree=feature/auth --madmax --xhigh
omx --worktree=fix/flaky-tests --madmax --xhigh
```

Poza repozytorium Git pomiń `--worktree`; worktree wymaga Git. Nie uruchamiaj równoległych sesji `--madmax` w jednym katalogu. `--worktree` / `-w` bez nazwy tworzy/ponownie wykorzystuje `../<repo>.omx-worktrees/launch-detached`; wariant z nazwą tworzy/ponownie wykorzystuje worktree w `../<repo>.omx-worktrees/` i checkoutuje wskazaną gałąź. OMX obsługuje ten flag przed startem Codexa. Jeśli docelowy worktree jest brudny, OMX ostrzega i uruchamia go bez zmian — przed poleganiem na izolacji wyczyść, commituj lub odłóż zmiany.

Narzędzia świadome repozytorium otrzymują ten sam kontekst w launch, team-worker i autoresearch: `OMX_REPO_ROOT`, `OMX_WORKTREE_ROOT`, `OMX_GIT_COMMON_DIR`, `OMX_WORKTREE_SCOPE`, `OMX_CODEGRAPH_MODE`, `OMX_CODEGRAPH_PROJECT_PATH`. Tryb `auto` CodeGraph wybiera indeks worktree, potem lidera/repozytorium, a jeśli nie ma żadnego — wyłącza się. Jawne `shared`, `local` i `off` są respektowane. OMX nie instaluje CodeGraph, nie indeksuje worktree automatycznie i nie kopiuje ani nie linkuje `.codegraph`; współdzielony indeks pomaga w nawigacji, ale nie odzwierciedla dokładnie zmian tylko z worktree.

Jednorazowe uruchomienie bez zarządzania tmux/HUD przez OMX:

```bash
omx --direct --yolo
```

Trwała preferencja shella/profilu:

```bash
OMX_LAUNCH_POLICY=direct omx --yolo
```

Wróć do trybu domyślnego poleceniem `unset OMX_LAUNCH_POLICY`. Flagi CLI mają pierwszeństwo przed środowiskiem; przed `--` obowiązuje ostatnia flaga polityki. Obsługiwane wartości: `direct|tmux|detached-tmux|auto`; ta wersja nie dodaje ustawienia w pliku konfiguracyjnym. `--direct` uruchomione w istniejącym panelu tmux nie tworzy podziałów HUD, nie włącza myszy ani extended-key handling, ale proces nadal działa w tym panelu.

Wypróbuj kanoniczny przepływ:

```text
# Przykład trwałego celu:
/goal Dostarczyć poprawkę checkout z checkpointami na odtworzenie błędu, implementację, testy regresyjne i końcową weryfikację.

$plan "zatwierdzić plan poprawki checkout i ocenić kompromisy"
$ultragoal "wykonać zatwierdzoną poprawkę z dowodami na checkpointach"
```

Użyj `$team`, gdy aktywna historia Ultragoal wymaga koordynacji.

### `/goal` i wybór skills

Rozpocznij mocną sesję przez `omx --madmax --xhigh` (albo dodaj `--worktree=<task>` w repozytorium Git). Pracuj bezpośrednio lub użyj `$ultragoal` do trwałego wykonania wielu celów, `$team` do pracy równoległej albo `$plan`, jeśli najpierw potrzebujesz planu. Użyj `/goal`, gdy zadanie wymaga celu i checkpointów uzgadnianych przez Codexa w kolejnych turach.

Gdy natywne odpowiedzi `get_goal` są niedostępne lub opakowane przez transport, Ultragoal zachowuje status oparty na artefaktach bez deklarowania niepotwierdzonego ukończenia; zobacz [diagnostykę i odzyskiwanie Ultragoal](../../docs/ultragoal.md).

Domyślnie ładuj tylko 2–5 pasujących skills. Więcej jest dozwolone przy odpowiednim zakresie, ale duży katalog zwykle obciąża kontekst i uwagę, a nie parser/runtime. Uznaj to za rzeczywistą blokadę dopiero wtedy, gdy polecenie faktycznie zgłasza błąd.

Antywzorzec:

```text
omx --madmax --xhigh
# Następnie załaduj 20 skills „na wszelki wypadek”, zanim opiszesz zadanie.
# To przepełnia kontekst i rozprasza model nieistotnymi workflow.
```

## Prosty model mentalny

OMX nie zastępuje Codexa, tylko dodaje warstwę pracy:
- **Codex** wykonuje pracę agenta
- **słowa kluczowe ról OMX** umożliwiają wielokrotne używanie przydatnych ról
- **skills OMX** pozwalają ponownie wykorzystywać typowe workflow
- `.omx/` przechowuje plany, logi, pamięć i stan runtime

Myśl o OMX jako o lepszym routingu zadań, workflow i runtime, a nie o powierzchni komend, którą trzeba ręcznie obsługiwać przez cały dzień.

## Zacznij tutaj, jeśli jesteś nowy

1. Jeśli masz już Codex CLI, sprawdź `codex --version` i zainstaluj/zaktualizuj OMX poleceniem `npm install -g oh-my-codex`; w przeciwnym razie osobno zainstaluj `@openai/codex`, jeśli npm ma zarządzać Codexem.
2. Po instalacji lub aktualizacji wersji OMX uruchom `omx setup --scope project --merge-agents` w docelowym projekcie Git lub `omx setup --scope user`; `omx update` także sprawdzi npm, zainstaluje najnowszą wersję i odświeży setup.
3. Uruchom `omx doctor`.
4. Wykonaj prawdziwy smoke test: `codex login status` oraz `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"`.
5. W repozytorium Git uruchamiaj nazwany worktree, np. `omx --worktree=feat/task --madmax --xhigh`; równoległe sesje `--madmax` potrzebują różnych worktree.
6. Użyj `$deep-interview "..."`, gdy prośba lub jej granice są niejasne.
7. Użyj `$ralplan "..."`, aby zatwierdzić plan i przejrzeć kompromisy.
8. Użyj `$ultragoal` lub `$team` dla trwałej/parallel execution; dodaj `/goal`, gdy struktura celu i checkpointów ma być jawna.

## Zalecany workflow

`$autopilot` to pierwszorzędny kanoniczny orchestrator etapów `$deep-interview -> $ralplan -> $ultragoal`. Ten łańcuch jest domyślny, ale etapy można wywoływać osobno, jeśli ich wymagania wejściowe są już spełnione.

1. `$deep-interview` — iteracyjne sokratejskie doprecyzowanie i wymagania gotowe do realizacji.
2. `$ralplan` — synteza architektury, wykonalności i uzgodnionego planu na podstawie wywiadu.
3. `$ultragoal` — realizacja wielu celów z checkpointami w ledgerze `.omx/ultragoal`.
4. `$team` — skoordynowana praca, gdy historia tego potrzebuje.

`$deep-interview` jest niezależnym etapem wymagań, nie aliasem `$plan --interview` i nie wdraża zmian. Planowanie tworzy artefakty planu; zmiany kodu wymagają jawnego etapu wykonawczego (`$ultragoal` albo `$team`). W historii Ultragoal używaj Team tylko, jeśli koordynacja jest potrzebna.

## Typowe powierzchnie sesji

| Powierzchnia | Zastosowanie |
| --- | --- |
| `$plan "..."` | Opcjonalne planowanie i doprecyzowanie |
| `$ultragoal "..."` | Trwała realizacja wielu celów po zatwierdzeniu planu |
| `$team "..."` | Skoordynowana praca równoległa |
| `/skills` | Przegląd zainstalowanych skills |
| `/goal ...` | Trwała struktura celu/checkpointów |
| `omx mission <file>` | Sekwencyjne uruchamianie checklist/prompts przez `omx exec`, z artefaktami `.omx/missions/<slug>/summary.json` i `ledger.jsonl` |

## Zaawansowane / operatorskie powierzchnie

To narzędzia przydatne operatorom, nie główna ścieżka dla nowych użytkowników.

### Wykonawca kolejki misji

Użyj `omx mission plan ./mission.md` lub `omx mission ./mission.md --dry-run`, aby sprawdzić format; uruchom `omx mission run ./mission.md -- --model gpt-5`. Stan sprawdzisz przez `status`, wznowisz przez `resume`, oznaczysz blokadę przez `mark`, a zadanie ponowisz przez `rerun`. Zobacz [docs/mission.md](../../docs/mission.md).

### Eksport poprzedniej rozmowy

Znajdź ID przez `omx session search "zapamiętana fraza"`, a następnie eksportuj przez `omx session export <session-id> --output conversation.md`. Akceptuje dokładny ID lub unikalny prefiks, eksportuje aktywne i archiwalne transkrypcje z tych samych Codex homes. Obsługuje `--format json`, `--include-tools`, `--codex-home <path>`; bez `--output` wypisuje do stdout. Istniejący plik nie jest nadpisywany. Domyślnie uwzględnia tylko wiadomości użytkownika/asystenta, wyklucza instrukcje systemu/dewelopera i zapisy rozumowania; tekst nie jest redagowany. Zobacz [eksport sesji](../../docs/session-export.md).

### Zużycie tokenów

`omx session usage --since 7d --sort tokens` pokazuje zarejestrowane sumaryczne użycie w lokalnych aktywnych i archiwalnych sesjach. Zawęź wyniki przez `--project current`, `--session <fragment>`, `--json` lub `--codex-home <path>`. `--limit` ogranicza widoczne sesje, nie sumy; kopie tej samej sesji liczą się raz, brakujące pomiary są oznaczane jako nieznane. `--since` wybiera sesje według ostatniej aktywności, więc liczniki mogą obejmować wcześniejszą pracę i nie są raportem zużycia/rozliczenia za okres. Cached input i reasoning są podzbiorami input/output. Zobacz [usage sesji](../../docs/session-usage.md).

### Diagnostyka osi czasu wykonania

`omx session timeline <session-id>` pokazuje wywołania narzędzi, granice tur i kompakcje kontekstu bez eksportu tekstu rozmowy. Łączy wywołania z wynikami po ID, także równoległe; raport zawiera jawne błędy, niedopasowane wywołania, zmierzone czasy i sumy według narzędzia/namespace. Użyj `--kind tools --sort duration --limit 10`, `--status failed` lub `--tool <name>`. Filtry/paginacja zmieniają listę, nie sumy; obsługiwane są ID/prefiksy, sesje aktywne/archiwalne, `--codex-home <path>` i JSON przez `--json --output timeline.json`. Nieznany czas pozostaje nieznany, a wynik bez jawnego błędu nie dowodzi powodzenia. Zobacz [timeline sesji](../../docs/session-timeline.md).

### Runtime Team

Team służy do trwałej koordynacji przez tmux/worktree, nie jest domyślnym sposobem startu. W Codex App lub poza tmux `omx team` jest shellową powierzchnią tmux runtime; jeśli chcesz wykonać pracę zespołową, najpierw uruchom OMX CLI z shella.

W historii Ultragoal lider zarządza stanem, a workers przekazują dowody gotowe do checkpointów i nie modyfikują `.omx/ultragoal`. Niezwiązane uruchomienia tolerują nieaktualne/błędne artefakty Ultragoal, jawnie powiązane pozostają fail-closed. Start Team zapisuje `.omx/state/team/<team-name>/preflight-context.json`, aby można było wznowić duże zadanie z pierwotnym kontekstem i podziałem pracy.

Dla małej atomowej pracy Team może ograniczyć niejawny fan-out do jednego workera i ostrzec przed nadmierną orkiestracją. Liczbę podawaj jawnie tylko wtedy, gdy dodatkowa koordynacja jest zamierzona.

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

`omx team status [<team-name>] [--json]` tylko odczytuje stan i działa również na read-only OMX root. Nie odzyskuje wygasłych claims, nie dostarcza wiadomości, nie integruje commitów ani nie zmienia runtime. Bez nazwy wyszukuje tylko jeden Team z bieżącej sesji lidera; podaj nazwę, jeśli brakuje kontekstu. `omx tmux-hook status` też jest obserwacyjny; konfigurację inicjalizuje jawnie `omx tmux-hook init`.

### Setup, doctor i HUD

- Marketplace/discovery Codex plugin może przechowywać pakiet pod `${CODEX_HOME:-~/.codex}/plugins/cache/$MARKETPLACE_NAME/oh-my-codex/$VERSION/` (lokalne instalacje mogą używać wersji `local`). Pakiet zawiera metadane oficjalnych lifecycle hooks Codexa oraz opcjonalne MCP/apps (domyślnie wyłączone); nadal współpracuje z zainstalowanym CLI `omx`.
- Setup z zakresem instaluje prompts, skills, szkielet `AGENTS.md`, `.codex/config.toml`, `.omx/` oraz — dla legacy lub starszego Codexa bez `plugin_hooks` — zarządzane hooki OMX w `.codex/hooks.json`.
- Odświeżenie setupu zachowuje nie-OMX hooki i przepisuje wyłącznie wrappery zarządzane przez OMX.
- W trybie pluginu trwały `AGENTS.md` pozostaje obowiązkową warstwą instrukcji; `omx doctor` zgłasza błąd, gdy brakuje pliku zakresu, bo plik sesji zawiera tylko runtime overlay.
- `omx setup --merge-agents` aktualizuje sekcje między `<!-- OMX:AGENTS:START -->` i `<!-- OMX:AGENTS:END -->`; `--no-merge-agents` zapisuje jawny wybór kontekstowy, a `--clear-merge-agents-policy` usuwa politykę. Jest ona per-root, odtwarzana przy aktualizacji tylko dla zgodnego zakresu, nie jest globalna ani wymuszana domyślnie.
- `omx uninstall` usuwa wrappery zarządzane przez OMX z `.codex/hooks.json`, ale pozostawia plik, jeśli zawiera hooki użytkownika.
- `omx update` natychmiast sprawdza npm, instaluje najnowszą globalną wersję OMX i ponawia interaktywny setup. Kontrole przy starcie są ograniczone i pytają o zgodę; `OMX_AUTO_UPDATE=0` je wyłącza, `OMX_AUTO_UPDATE=defer` planuje aktualizację bez pytania.
- Nowy setup używa `gpt-6-astra` dla agentów frontier, standard oraz spark/fast z domyślnym reasoning zależnym od roli; istniejące konfiguracje i jawne overrides są zachowywane.
- Routing model/env w `.omx-config.json` opisano w [referencji schematu](../../docs/reference/omx-config-schema-routing.md); edytuj tylko klucze obsługiwane przez zainstalowaną wersję.
- `omx doctor` weryfikuje instalację, ale nie dowodzi, że aktywny profil Codexa wykona uwierzytelnione zapytanie do modelu.
- `omx hud --watch` to monitoring/status, nie główny workflow.
- Każdy preset HUD pokazuje nazwę Team i liczbę workers obok wersji OMX; podsumowanie Ultragoal/Team ma pierwszeństwo przed nazwą repo. Każdy agent ma odświeżany wiersz z durum, zadaniem, rolą, panelem tmux i wiekiem aktualizacji. HUD dopasowuje wysokość do zespołu, a nadmiar pokazuje jako `+N workers`. Stan `working` nie sprawdza żywotności procesu; odczyt nie modyfikuje plików.
- Postęp GitGuardex jest opcjonalny: dodaj `"guardex": { "enabled": true }` do projektowego `.omx/hud-config.json`, aby wyświetlać `gx:<step>/<total> <phase>`. Bez tego OMX nie odczytuje stanu Guardex.

Dla sesji bez Team kanoniczną powierzchnią są natywne hooki Codexa:
- `plugins/oh-my-codex/hooks/hooks.json` — oficjalne rejestracje hooków pluginu
- `.codex/hooks.json` — legacy/fallback rejestracje natywnych hooków
- `.omx/hooks/*.mjs` — hooki pluginu OMX
- `omx tmux-hook`, notify-hook i pochodny watcher — ścieżki fallback tmux/runtime

Zobacz [mapowanie natywnych hooków Codexa](../../docs/codex-native-hooks.md).

### Diagnozowanie fałszywie zielonej gotowości

Zielony `omx doctor` oznacza, że instalacja i lokalne połączenia runtime wyglądają prawidłowo. Jeśli wykonanie nadal nie działa:
- W tym samym shellu/profilu uruchom `codex login status` oraz `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"`.
- Przy niestandardowym HOME, profilu, kontenerze lub shellu usługi sprawdź, czy aktywne `~/.codex`/ `CODEX_HOME` zawiera oczekiwane auth i config; nie zakładaj dostępu do zwykłego home.
- Jeśli korzystasz z lokalnego proxy zgodnego z OpenAI, sprawdź `openai_base_url` w aktywnym `~/.codex/config.toml`; inaczej klucz proxy może trafić do domyślnego endpointu i zwrócić `401 Unauthorized`, `Missing bearer or basic authentication in header` lub `Incorrect API key provided`.
- Gdy `omx doctor --team` lub resume zgłasza nieaktualny Team, `resume_blocker` albo brak sesji tmux, wyczyść martwy stan:

```bash
omx team shutdown <team-name> --force --confirm-issues
omx cancel
omx doctor --team
```

Wymuszonego zamknięcia używaj tylko dla Teamu potwierdzonego jako martwy lub celowo porzucony. Jeśli `Shift+Enter` wysyła wiadomość zamiast wstawiać nową linię w tmux zarządzanym przez OMX, zobacz [rozwiązywanie problemów](../../docs/troubleshooting.md#shiftenter-submits-instead-of-inserting-a-newline-in-tmux-backed-omx-sessions). OMX już przekazuje extended keys w swoich ścieżkach startowych; trwały problem zwykle wynika z możliwości/wykrywania terminala tmux.

### Sparkshell

- `omx sparkshell <command>` służy do inspekcji shell-native i ograniczonej weryfikacji.
- Do read-only wyszukiwania repo używaj zwykłych narzędzi Codexa; przestarzałe `omx explore` zostało usunięte.
- Główny i zapasowy model podsumowań Sparkshell to domyślnie `gpt-6-astra`; ustaw `OMX_SPARKSHELL_FALLBACK_MODEL`, aby używać innego fallbacku.
- Ograniczone env overrides: `OMX_SPARKSHELL_BIN`, `OMX_SPARKSHELL_MODEL`, `OMX_SPARKSHELL_FALLBACK_MODEL`, `OMX_SPARKSHELL_MODEL_INSTRUCTIONS_FILE`, `OMX_SPARKSHELL_SUMMARY_TIMEOUT_MS`.

```bash
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```

### Wiki

- `omx wiki` to CLI-first interfejs JSON; MCP `omx_wiki` jest wyłącznie jawnie włączoną kompatybilnością.
- Dane Wiki to wiedza projektowa w Markdown w `omx_wiki/`.
- Podejście jest Markdown-first i search-first, nie vector-first.

```bash
omx wiki list --json
omx wiki query --input '{"query":"session-start lifecycle"}' --json
omx wiki lint --json
omx wiki refresh --json
```

### Uwagi o platformach dla Team

`omx team` najlepiej działa na macOS/Linux z `tmux`. Natywny Windows pozostaje drugorzędny; zwykle lepszym wyborem jest WSL2. Na natywnym Windows OMX akceptuje `psmux` jako binarium zgodne z tmux dla obsługiwanych ścieżek.

| Platforma | Instalacja |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## Znane problemy

### Intel Mac: wysokie zużycie CPU przez `syspolicyd` / `trustd` przy starcie

Na niektórych Intel Macach start OMX — szczególnie z `--madmax --high` — może zwiększyć użycie CPU przez `syspolicyd` / `trustd`, gdy Gatekeeper weryfikuje wiele procesów uruchamianych jednocześnie.

Jeśli tak się dzieje:
- `xattr -dr com.apple.quarantine $(which omx)`
- dodaj aplikację terminala do listy dozwolonych Developer Tools w ustawieniach bezpieczeństwa macOS
- zmniejsz współbieżność, np. unikaj `--madmax --high`

## Dokumentacja

- [Pierwsze kroki](../../docs/getting-started.html)
- [Przewodnik demo](../../DEMO.md)
- [Funkcja Wiki](../../docs/wiki-feature.md)
- [Katalog agentów](../../docs/agents.html)
- [Informacje o skills](../../docs/skills.html)
- [Mapowanie natywnych hooków Codexa](../../docs/codex-native-hooks.md)
- [Pipeline tożsamości GitHub/PR/pakietu](../../docs/pipeline/github-pr-package-identity.md)
- [Integracje](../../docs/integrations.html)
- [Rozwiązywanie problemów z gotowością](../../docs/troubleshooting.md)
- [Przewodnik OpenClaw/gateway powiadomień](../../docs/openclaw-integration.md)
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
- [Ελληνικά](./README.el.md)
- [Polski](./README.pl.md)
- [Українська](./README.uk.md)
- [Bahasa Indonesia](./README.id.md)

## Współtwórcy

| Rola | Imię i nazwisko | GitHub |
| --- | --- | --- |
| Twórca i lider | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Opiekun | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Opiekun | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Historia gwiazdek

[![Wykres historii gwiazdek](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## Licencja

MIT

## Benchmark widoczności GEO

OMX zawiera specyfikację produktu [`geobench`](https://github.com/NomaDamas/geobench) do mierzenia trafień LLM, MRR, udziału głosu i cytowań.

- Specyfikacja: [`geobench/oh-my-codex.yaml`](../../geobench/oh-my-codex.yaml)
- Instrukcja: [`docs/geobench.md`](../../docs/geobench.md)
