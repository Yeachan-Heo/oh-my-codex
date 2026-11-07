
# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Starte Codex mit einer starken Grundlage; OMX ergänzt bessere Prompts, Workflows und Runtime-Unterstützung, wenn die Arbeit wächst.</em>
  <br><br>
  <strong>OMX gefällt dir, ist dir aber zu umfangreich? <a href="https://github.com/Yeachan-Heo/gajae-code">Probiere gajae-code</a>.</strong><br>
  <sub>Behalte Codex OAuth und nutze einen schnelleren, günstigeren und einfacheren SDK-basierten Weg für OpenClaw, Hermes, Grokbot und weitere Integrationen.</sub>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/wSyUQYfhAw)

**Website:** https://yeachan-heo.github.io/oh-my-codex-website/

**Dokumentation:** [Erste Schritte](../getting-started.html) · [Agents](../agents.html) · [Skills](../skills.html) · [Integrationen](../integrations.html) · [Demo](../../DEMO.md) · [OpenClaw-Leitfaden](../openclaw-integration.de.md)

**Community:** [Discord](https://discord.gg/wSyUQYfhAw) — gemeinsamer Gajae-Community-Server für oh-my-codex, [gajae-code](https://github.com/Yeachan-Heo/gajae-code) und verwandte Tools.

## Offizielles Projekt und Paket

Das offizielle OMX-Projekt ist dieses Repository, [Yeachan-Heo/oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex); das offizielle npm-Paket heißt [oh-my-codex](https://www.npmjs.com/package/oh-my-codex). Installation: `npm install -g oh-my-codex`.

Drittprojekte oder Forks mit Namen wie „OMX v2“ sind keine offiziellen Fortsetzungen oder Ersatzprojekte, sofern dieses README oder die Dokumentation das nicht ausdrücklich sagen. Verlasse dich im Zweifel auf dieses Repository und das Paket `oh-my-codex`.

OMX ist eine Workflow-Ebene für [OpenAI Codex CLI](https://github.com/openai/codex).

<table>
<tr><td><strong>🚨 HINWEIS — EMPFOHLENER STANDARD: macOS oder Linux mit Codex CLI.</strong><br><br>OMX ist primär für diesen Weg entwickelt und optimiert. Native Windows-Umgebungen und Codex App sind nicht der Standard, können sich inkonsistent verhalten und werden derzeit weniger stark unterstützt.</td></tr>
</table>

OMX lässt Codex die Ausführung übernehmen und hilft dir dabei:
- starke Codex-Sitzungen zu starten;
- einen konsistenten Workflow von der Klärung bis zum Abschluss zu nutzen;
- `$plan`, `$ultragoal`, `$team`, `$code-review` und `$ultraqa` unabhängig aufzurufen;
- Projektanweisungen, Pläne, Logs und Zustand in `.omx/` zu halten.

## Kernteam

| Rolle | Name | GitHub |
| --- | --- | --- |
| Creator & Lead | Yеachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Maintainer | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Maintainer | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Ambassadors

| Name | GitHub |
| --- | --- |
| Sigrid Jin | [@sigridjineth](https://github.com/sigridjineth) |

## Top-Mitwirkende

| Name | GitHub |
| --- | --- |
| Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Junho Yeo | [@junhoyeo](https://github.com/junhoyeo) |
| JiHongKim98 | [@JiHongKim98](https://github.com/JiHongKim98) |
| Lor | [@gobylor](https://github.com/gobylor) |
| HyunjunJeon | [@HyunjunJeon](https://github.com/HyunjunJeon) |

## Empfohlener Standardablauf

Wenn Codex CLI bereits installiert ist:

```bash
codex --version
npm install -g oh-my-codex
# Im Git-Projekt ausführen, das Codex bearbeiten soll; aufgabenspezifischen Namen wählen
omx --worktree=feat/task --madmax --xhigh
```

Wenn npm Codex CLI verwalten soll:

```bash
npm install -g @openai/codex
npm install -g oh-my-codex
```

Installiere `@openai/codex` nicht zusammen mit OMX über npm, wenn eine Homebrew-Version wie `/opt/homebrew/bin/codex` bereits den Befehl besitzt: npm kann wegen `EEXIST` abbrechen. OMX benötigt lediglich einen authentifizierten `codex`-Befehl im `PATH`.

Nach einer echten OMX-Versionsaktualisierung startet die globale npm-Installation Setup nicht automatisch. Starte bei Bedarf `omx setup` mit passendem Scope oder `omx update`. Der Start prüft npm-Updates in gedrosselten Abständen; mit `OMX_AUTO_UPDATE=0` deaktivierst du diese Prüfung, mit `OMX_AUTO_UPDATE=defer` wird die Aktualisierung ohne Rückfrage nach Sitzungsende geplant.

Wähle den Setup-Scope bewusst:
- `omx setup --scope project --merge-agents` im Zielprojekt, wenn dieses Repository die dauerhaften `AGENTS.md`-Anweisungen besitzen soll;
- `omx setup --scope user` für benutzerweite Codex-Konfiguration;
- starte projektbezogenes Setup nicht aus einem allgemeinen Home- oder Hub-Verzeichnis.

### AGENTS-Merge-Richtlinie speichern

`omx setup --merge-agents`, `--no-merge-agents` und `--clear-merge-agents-policy` sind die Richtlinienauswahl. Eine erfolgreiche explizite Wahl wird in `./.omx/setup-scope.json` des aktuellen Roots gespeichert — nicht als globale Benutzereinstellung. Spätere `omx update`-Läufe verwenden eine gültige, zum Scope passende Richtlinie erneut.

`true` nutzt den vorhandenen Merge-Pfad. `false` deaktiviert nur diesen Pfad und verspricht keine Erhaltung oder Ersetzung vorhandener Inhalte. Ein Scope-Wechsel oder Reset entfernt die übernommene Richtlinie, sofern derselbe Lauf nicht ausdrücklich eine neue setzt; `--clear-merge-agents-policy` entfernt sie immer. Ungültige oder nicht passende Daten werden ignoriert.

`--force` ist unabhängig und vorübergehend; es wird nicht gespeichert und überschreibt keine explizite Merge-Richtlinie. Die Richtlinie wird erst gespeichert, wenn das Setup vollständig erfolgreich war. Sie macht Merge weder zum Standard noch stellt sie den abgelehnten Merge-by-default-Ansatz wieder her.

### Codex-Plugin-Installation

Das Repository enthält außerdem ein offizielles Codex-Plugin unter `plugins/oh-my-codex`. Es liefert gebündelte Skills und pluginbezogene Metadaten für Hooks und optionale Integrationen, ersetzt aber nicht das globale `oh-my-codex`-CLI plus scoped Setup. Plugin-Hooks starten weiterhin das installierte `omx`-CLI.

Auch im Plugin-Modus bleibt ein dauerhaftes Scope-`AGENTS.md` als Orchestrierungsgrundlage erforderlich: `~/.codex/AGENTS.md` beim User-Setup oder `./AGENTS.md` beim Projekt-Setup. Sitzungsbezogene AGENTS-Dateien ergänzen diese Anleitung nur um Runtime-Overlays.

## Wofür OMX gedacht ist

OMX richtet sich an Codex-Nutzer, die einen zuverlässigeren Workflow, wiederverwendbare Spezialistenrollen und Skills, dauerhafte Projektanweisungen sowie Runtime-Zustand unter `.omx/` möchten. Für schlichtes Codex ohne zusätzliche Workflow-Ebene brauchst du OMX wahrscheinlich nicht.

## Schnellstart

### Voraussetzungen
- Node.js 20+
- Installiertes und authentifiziertes Codex CLI (`codex --version`)
- Authentifizierung im selben Shell-/Profil-Kontext wie OMX
- `tmux` unter macOS/Linux für die empfohlene dauerhafte Team-Runtime
- `psmux` nur für den weniger unterstützten nativen Windows-Team-Pfad

### Eine gute erste Sitzung

```bash
omx doctor
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```

`omx doctor` prüft OMX-Dateien, Hooks und Voraussetzungen. Der echte Smoke-Test prüft Authentifizierung und Provider-Verbindung mit einer tatsächlichen Modellanfrage.

Starte im Git-Projekt vorzugsweise so:

```bash
omx --worktree=feat/task --madmax --xhigh
```

Auf interaktiven macOS-/Linux-Terminals mit tmux startet OMX standardmäßig eine verwaltete tmux-Sitzung. `--worktree` erstellt einen separaten Checkout und ist besonders mit `--madmax` die sicherere Wahl.

### Mehrere Standard-Sitzungen

Ein normales OMX-Startziel besitzt einen beschreibbaren Sitzungseintrag. Für weitere Gespräche verwende unterschiedliche Roots:

```bash
omx
OMX_ROOT="$HOME/.omx/instances/second-conversation" omx
OMX_ROOT="$HOME/.omx/instances/third-conversation" omx
```

Ein expliziter Root ist wörtlich: Zwei Sitzungen mit demselben `OMX_ROOT` bleiben ein Konflikt. Separate Checkouts besitzen getrennte Standard-Roots.

### Sicherheit bei Madmax und Worktrees

`--madmax` ist eine Kurzform für `--dangerously-bypass-approvals-and-sandbox` und entfernt normale Schutzmechanismen. Verwende es nur in vertrauenswürdigen Umgebungen und bevorzuge aus Git-Repositories einen benannten Worktree:

```bash
omx --worktree=feature/auth --madmax --xhigh
```

`--high` und `--xhigh` setzen `model_reasoning_effort`. Für parallele Madmax-Sitzungen braucht jede Sitzung einen eigenen Worktree. `--worktree` ist eine OMX-Option und wird nicht an Codex weitergereicht. Ein bereits veränderter Ziel-Worktree wird trotzdem verwendet — prüfe daher seinen Zustand vorher.

Mit `--direct` überspringst du die OMX-tmux-/HUD-Verwaltung für einen einzelnen Start:

```bash
omx --direct --yolo
OMX_LAUNCH_POLICY=direct omx --yolo
```

Unterstützte Richtlinien sind `direct|tmux|detached-tmux|auto`; CLI-Flags haben Vorrang vor der Umgebungsvariable `OMX_LAUNCH_POLICY`.

## Einfaches mentales Modell

OMX ersetzt Codex nicht:
- **Codex** führt die Agentenarbeit aus;
- **OMX-Rollen** machen hilfreiche Rollen wiederverwendbar;
- **OMX-Skills** standardisieren wiederkehrende Abläufe;
- **`.omx/`** speichert Pläne, Logs, Gedächtnis und Runtime-Zustand.

Die Leitplanken umfassen `AGENTS.md`, Skills, Prompts, Codex-Konfiguration und projektspezifischen Zustand. OMX erfindet keine zusätzlichen Sicherheitsgarantien jenseits der vorhandenen Tools und Einstellungen.

## Hier starten, wenn du neu bist

1. Installiere oder aktualisiere OMX; installiere Codex CLI separat, falls nötig.
2. Führe `omx setup --scope project --merge-agents` im Projekt oder `omx setup --scope user` für User-Setup aus.
3. Prüfe die Installation mit `omx doctor`.
4. Prüfe Anmeldung und tatsächliche Ausführung mit `codex login status` und dem Smoke-Test oben.
5. Starte vorzugsweise mit einem benannten Worktree.
6. Nutze `$deep-interview` zur Klärung, `$ralplan` zur Planfreigabe und `$ultragoal` für dauerhafte Umsetzung.
7. Verwende `$team`, wenn eine konkrete Story wirklich parallele Koordination erfordert; ergänze `/goal`, wenn ein explizites, dauerhaftes Ziel-/Checkpoint-Gerüst nützlich ist.

## Empfohlener Workflow

`$autopilot` ist der kanonische Orchestrator für `$deep-interview -> $ralplan -> $ultragoal`; jede Stufe kann unabhängig gestartet werden, wenn ihre Eingabeanforderungen bereits erfüllt sind.

1. **`$deep-interview`** — klärt Anforderungen und Grenzen iterativ.
2. **`$ralplan`** — prüft Architektur, Machbarkeit und Konsens.
3. **`$ultragoal`** — führt mit dauerhaften Zielen und Checkpoints aus.
4. **`$team`** — koordiniert mehrere Agenten, wenn die Story davon profitiert.

Plane nicht unnötig: Lade standardmäßig nur 2–5 relevante Skills. Ein übergroßer Skill-Katalog bindet Aufmerksamkeit und Kontextbudget.

## Häufige Oberflächen in der Sitzung

| Oberfläche | Zweck |
| --- | --- |
| `$plan` | Leichte Planung und optionale Klärung |
| `$ultragoal` | Dauerhafte Umsetzung mit mehreren Zielen |
| `$team` | Koordinierte parallele Ausführung |
| `/skills` | Skills durchsuchen |
| `/goal ...` | Dauerhafte Ziele und Checkpoints |
| `omx mission` | Prompt-/Checklisten-Aufträge nacheinander ausführen |

## Erweiterte Oberflächen

### Mission Queue Runner

`omx mission plan ./mission.md` prüft einen Auftrag; `omx mission run ./mission.md -- <args>` führt ihn aus. Unterbrochene Läufe kannst du mit `status`, `resume`, `mark` und `rerun` verwalten. Siehe [Mission-Dokumentation](../mission.md).

### Sitzung exportieren

Finde Sitzungen mit `omx session search "phrase"` und exportiere mit `omx session export <session-id> --output conversation.md`. JSON, Tool-Aufrufe und ein bestimmtes Codex-Home sind optional. Standardmäßig enthält der Export User- und Assistant-Nachrichten; Systemanweisungen und Reasoning-Datensätze bleiben ausgeschlossen, Text wird jedoch nicht redigiert. Siehe [Session-Export](../session-export.md).

### Token-Nutzung ansehen

`omx session usage --since 7d --sort tokens` zeigt gespeicherte kumulative Token-Zähler. Filter, JSON-Ausgabe und `--codex-home` sind verfügbar. Der Zeitraum bezieht sich auf letzte Aktivität, nicht auf abgerechneten Verbrauch; fehlende Werte bleiben unbekannt. Siehe [Session-Nutzung](../session-usage.md).

### Sitzungsablauf untersuchen

`omx session timeline <session-id>` zeigt Tool-Aufrufe, Turn-Grenzen, Dauer und Fehler — ohne Konversationstext zu exportieren. Dauerangaben sind beobachtet und können unbekannt sein; ein Resultat ohne expliziten Fehler beweist keinen Erfolg. Siehe [Session-Timeline](../session-timeline.md).

### Team-Runtime

`omx team` ist für dauerhafte tmux-/Worktree-Koordination gedacht, nicht als Einstieg für jede Aufgabe. Worker melden Status und Evidenz; Ultragoal-Zustand bleibt beim Leader. Kleine Aufgaben können implizite Parallelität auf einen Worker begrenzen.

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

In Codex App oder gewöhnlichen Sessions außerhalb von tmux ist `omx team` eine Shell-/tmux-Oberfläche und nicht direkt als In-App-Workflow verfügbar.

### Setup, Doctor und HUD

Scoped Setup installiert oder aktualisiert verwaltete Prompts, Skills, AGENTS-Gerüst, Konfiguration und Runtime-Verknüpfungen. `omx update` prüft npm, installiert den neuesten globalen Build und durchläuft anschließend den Setup-Pfad. `omx doctor` diagnostiziert Installation und Laufzeit; es beweist nicht, dass Codex authentifiziert Modellanfragen ausführen kann.

Im Plugin-Modus kommen gebündelte Skills und Hooks aus dem Plugin-Cache; das dauerhafte Scope-`AGENTS.md` bleibt dennoch notwendig. `omx setup --disable-hooks` deaktiviert OMX-Hook-Registrierungen und beendet den Setup-Lauf frühzeitig.

Für Nicht-Team-Sitzungen sind native Codex Hooks der kanonische Lifecycle-Pfad: Plugin-Registrierungen liegen unter `plugins/oh-my-codex/hooks/hooks.json`, Legacy-/Fallback-Registrierungen in `.codex/hooks.json`. Details: [Codex Native Hook Mapping](../codex-native-hooks.md).

### Troubleshooting bei falscher Bereitschaftsanzeige

Ein grüner Doctor-Test bestätigt nicht automatisch die echte Codex-Ausführung:
- Prüfe `codex login status` und `omx exec` in derselben Shell, die OMX starten wird.
- Prüfe bei eigenem HOME, Container oder Service, welches `CODEX_HOME` tatsächlich aktiv ist.
- Bei einem OpenAI-kompatiblen Proxy muss die aktive Codex-Konfiguration die erwartete `openai_base_url` enthalten.
- Verifiziere einen vermeintlich verwaisten Team-Runtime-Zustand, bevor du ihn per `omx team shutdown <name> --force --confirm-issues` entfernst.

### Sparkshell

`omx sparkshell <command>` dient der shell-nativen Inspektion und begrenzten Verifikation, etwa:

```bash
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```

Für normale read-only Repository-Suche nutze die regulären Repository-Tools statt eines veralteten Explore-Kommandos.

### Wiki

`omx wiki` ist die CLI-first JSON-Oberfläche. Wiki-Daten liegen Markdown-basiert im Projekt unter `omx_wiki/`; die Suche ist markdown- und suchorientiert, nicht vektororientiert.

```bash
omx wiki list --json
omx wiki query --input '{"query":"session-start lifecycle"}' --json
omx wiki lint --json
omx wiki refresh --json
```

### Plattformhinweise für Team-Modus

Team läuft am besten auf macOS/Linux mit `tmux`. Native Windows-Unterstützung ist zweitrangig; unter Windows ist WSL2 in der Regel die bessere Wahl. Native Windows-Pfade können `psmux` als tmux-kompatible ausführbare Datei nutzen.

| Plattform | Installation |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## Bekannte Probleme

### Intel Mac: hohe CPU-Auslastung von `syspolicyd` / `trustd`

Bei manchen Intel Macs kann Gatekeeper beim Start vieler paralleler Prozesse die CPU-Auslastung von `syspolicyd` / `trustd` erhöhen. Probiere niedrigere Parallelität, passe die macOS-Developer-Tools-Freigabe an oder entferne Quarantäneattribute nur, wenn du Herkunft und Sicherheit des Binaries überprüft hast.

## Dokumentation

- [Erste Schritte](../getting-started.html)
- [Demo-Leitfaden](../../DEMO.md)
- [Wiki-Funktion](../wiki-feature.md)
- [Agent-Katalog](../agents.html)
- [Skills-Referenz](../skills.html)
- [Codex Native Hook Mapping](../codex-native-hooks.md)
- [GitHub-/PR-/Paket-Identität](../pipeline/github-pr-package-identity.md)
- [Integrationen](../integrations.html)
- [Troubleshooting](../troubleshooting.md)
- [OpenClaw-/Notification-Gateway-Leitfaden](../openclaw-integration.de.md)
- [Mitwirken](../../CONTRIBUTING.md)
- [Änderungsprotokoll](../../CHANGELOG.md)

## Sprachen

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

## Mitwirkende

| Rolle | Name | GitHub |
| --- | --- | --- |
| Creator & Lead | Yеachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Maintainer | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Maintainer | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## Lizenz

MIT

## GEO-Sichtbarkeitsbenchmark

OMX enthält eine [geobench](https://github.com/NomaDamas/geobench)-Produktspezifikation für LLM-Trefferrate, MRR, Share of Voice und Zitationen.

- Spezifikation: [geobench/oh-my-codex.yaml](../../geobench/oh-my-codex.yaml)
- Ablaufhandbuch: [geobench.md](../geobench.md)
