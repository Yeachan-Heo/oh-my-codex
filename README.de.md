# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Dein Codex ist nicht allein.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

> **[Website](https://yeachan-heo.github.io/oh-my-codex-website/)** | **[Documentation](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** | **[CLI Reference](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** | **[Workflows](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** | **[OpenClaw-Integrationsleitfaden](./docs/openclaw-integration.de.md)** | **[GitHub](https://github.com/Yeachan-Heo/oh-my-codex)** | **[npm](https://www.npmjs.com/package/oh-my-codex)**

Multi-Agenten-Orchestrierungsschicht für [OpenAI Codex CLI](https://github.com/openai/codex).

## Neu in v0.9.0 — Spark Initiative

Spark Initiative ist das Release, das den nativen Pfad für Exploration und Inspektion in OMX stärkt.

- **Nativer Harness für `omx explore`** — führt Read-only-Repository-Exploration über einen schnelleren und strengeren Rust-Pfad aus.
- **`omx sparkshell`** — native Operator-Oberfläche für Inspektion mit Zusammenfassungen langer Ausgaben und expliziter tmux-Pane-Erfassung.
- **Plattformübergreifende native Release-Artefakte** — der Hydration-Pfad für `omx-explore-harness`, `omx-sparkshell` und `native-release-manifest.json` ist jetzt Teil der Release-Pipeline.
- **Gehärtetes CI/CD** — ergänzt ein explizites Rust-Toolchain-Setup im `build`-Job sowie `cargo fmt --check` und `cargo clippy -- -D warnings`.

Siehe auch die [Release Notes zu v0.9.0](./docs/release-notes-0.9.0.md) und den [Release-Text](./docs/release-body-0.9.0.md).

## Erste Sitzung

Innerhalb von Codex:

```text
/prompts:architect "analyze current auth boundaries"
/prompts:executor "implement input validation in login"
$plan "ship OAuth callback safely"
$team 3:executor "fix all TypeScript errors"
```

Vom Terminal:

```bash
omx team 4:executor "parallelize a multi-module refactor"
omx team status <team-name>
omx team shutdown <team-name>
```

## Kernmodell

OMX installiert und verbindet diese Schichten:

```text
User
  -> Codex CLI
    -> AGENTS.md (Orchestrierungs-Gehirn)
    -> ~/.codex/prompts/*.md (Agenten-Prompt-Katalog)
    -> ~/.codex/skills/*/SKILL.md (Skill-Katalog)
    -> ~/.codex/config.toml (Features, Benachrichtigungen, MCP)
    -> .omx/ (Laufzeitzustand, Speicher, Pläne, Protokolle)
```

## Hauptbefehle

```bash
omx                # Codex starten (+ HUD in tmux wenn verfügbar)
omx setup          # Prompts/Skills/Config nach Bereich installieren + Projekt-.omx + bereichsspezifische AGENTS.md
omx doctor         # Installations-/Laufzeitdiagnose
omx doctor --team  # Team/Swarm-Diagnose
omx team ...       # tmux-Team-Worker starten/Status/fortsetzen/herunterfahren
omx status         # Aktive Modi anzeigen
omx cancel         # Aktive Ausführungsmodi abbrechen
omx reasoning <mode> # low|medium|high|xhigh
omx tmux-hook ...  # init|status|validate|test
omx hooks ...      # init|status|validate|test (Plugin-Erweiterungs-Workflow)
omx hud ...        # --watch|--json|--preset
omx help
```

## Hooks-Erweiterung (Additive Oberfläche)

OMX enthält jetzt `omx hooks` für Plugin-Gerüstbau und -Validierung.

- `omx tmux-hook` wird weiterhin unterstützt und ist unverändert.
- `omx hooks` ist additiv und ersetzt keine tmux-hook-Workflows.
- Plugin-Dateien befinden sich unter `.omx/hooks/*.mjs`.
- Plugins sind standardmäßig deaktiviert; aktivieren mit `OMX_HOOK_PLUGINS=1`.

Siehe `docs/hooks-extension.md` für den vollständigen Erweiterungs-Workflow und das Ereignismodell.

## Start-Flags

```bash
--yolo
--high
--xhigh
--madmax
--force
--dry-run
--verbose
--scope <user|project>  # nur bei setup
```

`--madmax` entspricht Codex `--dangerously-bypass-approvals-and-sandbox`.
Nur in vertrauenswürdigen/externen Sandbox-Umgebungen verwenden.

### MCP workingDirectory-Richtlinie (optionale Härtung)

Standardmäßig akzeptieren MCP-Zustand/Speicher/Trace-Tools das vom Aufrufer bereitgestellte `workingDirectory`.
Um dies einzuschränken, setzen Sie eine Erlaubnisliste von Wurzelverzeichnissen:

```bash
export OMX_MCP_WORKDIR_ROOTS="/path/to/project:/path/to/another-root"
```

Wenn gesetzt, werden `workingDirectory`-Werte außerhalb dieser Wurzeln abgelehnt.

## Codex-First Prompt-Steuerung

Standardmäßig injiziert OMX:

```text
-c model_instructions_file="<cwd>/AGENTS.md"
```

Dies kombiniert `AGENTS.md` aus `CODEX_HOME` mit dem Projekt-`AGENTS.md` (falls vorhanden) und legt dann die Laufzeit-Überlagerung darüber.
Es erweitert das Codex-Verhalten, ersetzt/umgeht aber nicht die Codex-Kernsystemrichtlinien.

Steuerung:

```bash
OMX_BYPASS_DEFAULT_SYSTEM_PROMPT=0 omx     # AGENTS.md-Injektion deaktivieren
OMX_MODEL_INSTRUCTIONS_FILE=/path/to/instructions.md omx
```

## Team-Modus

Verwenden Sie den Team-Modus für umfangreiche Arbeiten, die von parallelen Workern profitieren.

Lebenszyklus:

```text
start -> assign scoped lanes -> monitor -> verify terminal tasks -> shutdown
```

Operationelle Befehle:

```bash
omx team <args>
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

Wichtige Regel: Fahren Sie nicht herunter, während Aufgaben noch `in_progress` sind, es sei denn, Sie brechen ab.

### Ralph-Aufräumrichtlinie

Wenn ein Team im Ralph-Modus läuft (`omx team ralph ...`), wendet die Shutdown-Bereinigung
eine spezielle Richtlinie an, die sich vom normalen Pfad unterscheidet:

| Verhalten | Normales Team | Ralph-Team |
|---|---|---|
| Erzwungenes Herunterfahren bei Fehler | Wirft `shutdown_gate_blocked` | Umgeht Gate, protokolliert `ralph_cleanup_policy`-Ereignis |
| Automatische Branch-Löschung | Löscht Worktree-Branches bei Rollback | Bewahrt Branches (`skipBranchDeletion`) |
| Abschluss-Protokollierung | Standard-`shutdown_gate`-Ereignis | Zusätzliches `ralph_cleanup_summary`-Ereignis mit Aufgabenaufschlüsselung |

Die Ralph-Richtlinie wird automatisch aus dem Team-Modus-Zustand (`linked_ralph`) erkannt oder
kann explizit über `omx team shutdown <name> --ralph` übergeben werden.

Worker-CLI-Auswahl für Team-Worker:

```bash
OMX_TEAM_WORKER_CLI=auto    # Standard; verwendet claude wenn Worker --model "claude" enthält
OMX_TEAM_WORKER_CLI=codex   # Codex-CLI-Worker erzwingen
OMX_TEAM_WORKER_CLI=claude  # Claude-CLI-Worker erzwingen
OMX_TEAM_WORKER_CLI_MAP=codex,codex,claude,claude  # CLI-Mix pro Worker (Länge=1 oder Worker-Anzahl)
OMX_TEAM_AUTO_INTERRUPT_RETRY=0  # optional: adaptiven Queue->Resend-Fallback deaktivieren
```

Hinweise:
- Worker-Startargumente werden weiterhin über `OMX_TEAM_WORKER_LAUNCH_ARGS` geteilt.
- `OMX_TEAM_WORKER_CLI_MAP` überschreibt `OMX_TEAM_WORKER_CLI` für Worker-spezifische Auswahl.
- Trigger-Übermittlung verwendet standardmäßig adaptive Wiederholungsversuche (Queue/Submit, dann sicherer Clear-Line+Resend-Fallback bei Bedarf).
- Im Claude-Worker-Modus startet OMX Worker als einfaches `claude` (keine zusätzlichen Startargumente) und ignoriert explizite `--model` / `--config` / `--effort`-Überschreibungen, sodass Claude die Standard-`settings.json` verwendet.

## Was `omx setup` schreibt

- `.omx/setup-scope.json` (persistierter Setup-Bereich)
- Bereichsabhängige Installationen:
  - `user`: `~/.codex/prompts/`, `~/.codex/skills/`, `~/.codex/config.toml`, `~/.omx/agents/`, `~/.codex/AGENTS.md`
  - `project`: `./.codex/prompts/`, `./.codex/skills/`, `./.codex/config.toml`, `./.omx/agents/`, `./AGENTS.md`
- Startverhalten: Wenn der persistierte Bereich `project` ist, verwendet `omx` automatisch `CODEX_HOME=./.codex` (sofern `CODEX_HOME` nicht bereits gesetzt ist).
- Startanweisungen kombinieren `~/.codex/AGENTS.md` (bzw. `CODEX_HOME/AGENTS.md`, wenn überschrieben) mit dem Projekt-`./AGENTS.md` und hängen anschließend die Runtime-Überlagerung an.
- Vorhandene `AGENTS.md`-Dateien werden nie stillschweigend überschrieben: Interaktive TTY-Läufe fragen vor dem Ersetzen, nicht-interaktive Läufe überspringen das Ersetzen ohne `--force` (aktive Sitzungs-Sicherheitsprüfungen gelten weiterhin).
- `config.toml`-Aktualisierungen (für beide Bereiche):
  - `notify = ["node", "..."]`
  - `model_reasoning_effort = "high"`
  - `developer_instructions = "..."`
  - `[features] multi_agent = true, child_agents_md = true`
  - MCP-Server-Einträge (`omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`)
  - `[tui] status_line`
- Bereichsspezifische `AGENTS.md`
- `.omx/`-Laufzeitverzeichnisse und HUD-Konfiguration

## Agenten und Skills

- Prompts: `prompts/*.md` (installiert nach `~/.codex/prompts/` für `user`, `./.codex/prompts/` für `project`)
- Skills: `skills/*/SKILL.md` (installiert nach `~/.codex/skills/` für `user`, `./.codex/skills/` für `project`)

Beispiele:
- Agenten: `architect`, `planner`, `executor`, `debugger`, `verifier`, `security-reviewer`
- Skills: `autopilot`, `plan`, `team`, `ralph`, `ultrawork`, `cancel`

## Projektstruktur

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

## Entwicklung

```bash
git clone https://github.com/Yeachan-Heo/oh-my-codex.git
cd oh-my-codex
npm install
npm run build
npm test
```

## Dokumentation

- **[Vollständige Dokumentation](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** — Kompletter Leitfaden
- **[CLI-Referenz](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** — Alle `omx`-Befehle, Flags und Tools
- **[Benachrichtigungs-Leitfaden](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#notifications)** — Discord, Telegram, Slack und Webhook-Einrichtung
- **[Empfohlene Workflows](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** — Praxiserprobte Skill-Ketten für häufige Aufgaben
- **[Versionshinweise](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#release-notes)** — Neuheiten in jeder Version

## Hinweise

- Vollständiges Änderungsprotokoll: `CHANGELOG.md`
- Migrationsleitfaden (nach v0.4.4 mainline): `docs/migration-mainline-post-v0.4.4.md`
- Abdeckungs- und Paritätsnotizen: `COVERAGE.md`
- Hook-Erweiterungs-Workflow: `docs/hooks-extension.md`
- Setup- und Beitragsdetails: `CONTRIBUTING.md`

## Danksagungen

Inspiriert von [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode), angepasst für Codex CLI.

## Lizenz

MIT
