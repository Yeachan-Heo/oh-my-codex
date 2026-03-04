# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Il tuo codex non è solo.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

> **[Website](https://yeachan-heo.github.io/oh-my-codex-website/)** | **[Documentation](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** | **[CLI Reference](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** | **[Workflows](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** | **[GitHub](https://github.com/Yeachan-Heo/oh-my-codex)** | **[npm](https://www.npmjs.com/package/oh-my-codex)**

Livello di orchestrazione multi-agente per [OpenAI Codex CLI](https://github.com/openai/codex).

## Lingue

- [English](./README.md)
- [한국어 (Korean)](./README.ko.md)
- [日本語 (Japanese)](./README.ja.md)
- [简体中文 (Chinese Simplified)](./README.zh.md)
- [繁體中文 (Chinese Traditional)](./README.zh-TW.md)
- [Tiếng Việt (Vietnamese)](./README.vi.md)
- [Español (Spanish)](./README.es.md)
- [Português (Portuguese)](./README.pt.md)
- [Русский (Russian)](./README.ru.md)
- [Türkçe (Turkish)](./README.tr.md)
- [Deutsch (German)](./README.de.md)
- [Français (French)](./README.fr.md)
- [Italiano (Italian)](./README.it.md)


OMX trasforma Codex da un agente a sessione singola in un sistema coordinato con:
- Role prompts (`/prompts:name`) per agenti specializzati
- Workflow skills (`$name`) per modalità di esecuzione ripetibili
- Orchestrazione team in tmux (`omx team`, `$team`)
- Stato e memoria persistenti tramite server MCP

## Perché OMX

Codex CLI è efficace per compiti diretti. OMX aggiunge struttura per lavori più ampi:
- Decomposizione ed esecuzione a stadi (`team-plan -> team-prd -> team-exec -> team-verify -> team-fix`)
- Stato persistente del ciclo di vita delle modalità (`.omx/state/`)
- Superfici di memoria e notepad per sessioni di lunga durata
- Controlli operativi per avvio, verifica e annullamento

OMX è un add-on, non un fork. Utilizza i punti di estensione nativi di Codex.

## Requisiti

- macOS o Linux (Windows tramite WSL2)
- Node.js >= 20
- Codex CLI installato (`npm install -g @openai/codex`)
- Autenticazione Codex configurata

## Avvio rapido (3 minuti)

```bash
npm install -g oh-my-codex
omx setup
omx doctor
```

Profilo di avvio consigliato per ambienti fidati:

```bash
omx --xhigh --madmax
```

## Novità nella v0.5.0

- **Setup sensibile allo scope** con `omx setup --scope user|project` per modalità di installazione flessibili.
- **Routing Spark worker** tramite `--spark` / `--madmax-spark` in modo che i worker del team possano usare `gpt-5.3-codex-spark` senza forzare il modello leader.
- **Consolidamento del catalogo** — rimossi prompt obsoleti (`deep-executor`, `scientist`) e 9 skill obsolete.
- **Livelli di verbosità delle notifiche** per un controllo dettagliato dell'output CCNotifier.

## Prima sessione

All'interno di Codex:

```text
/prompts:architect "analyze current auth boundaries"
/prompts:executor "implement input validation in login"
$plan "ship OAuth callback safely"
$team 3:executor "fix all TypeScript errors"
```

Dal terminale:

```bash
omx team 4:executor "parallelize a multi-module refactor"
omx team status <team-name>
omx team shutdown <team-name>
```

## Modello di base

OMX installa e collega questi livelli:

```text
User
  -> Codex CLI
    -> AGENTS.md (cervello dell'orchestrazione)
    -> ~/.codex/prompts/*.md (catalogo prompt degli agenti)
    -> ~/.agents/skills/*/SKILL.md (catalogo skill)
    -> ~/.codex/config.toml (funzionalità, notifiche, MCP)
    -> .omx/ (stato di esecuzione, memoria, piani, log)
```

## Comandi principali

```bash
omx                # Avvia Codex (+ HUD in tmux se disponibile)
omx setup          # Installa prompt/skill/config per scope + progetto AGENTS.md/.omx
omx doctor         # Diagnostica installazione/esecuzione
omx doctor --team  # Diagnostica Team/Swarm
omx team ...       # Avvia/stato/riprendi/arresta i worker del team tmux
omx status         # Mostra le modalità attive
omx cancel         # Annulla le modalità di esecuzione attive
omx reasoning <mode> # low|medium|high|xhigh
omx tmux-hook ...  # init|status|validate|test
omx hooks ...      # init|status|validate|test (workflow estensione plugin)
omx hud ...        # --watch|--json|--preset
omx help
```

## Estensione Hooks (Superficie additiva)

OMX ora include `omx hooks` per lo scaffolding e la validazione dei plugin.

- `omx tmux-hook` resta supportato e invariato.
- `omx hooks` è additivo e non sostituisce i workflow tmux-hook.
- I file dei plugin si trovano in `.omx/hooks/*.mjs`.
- I plugin sono disattivati per impostazione predefinita; abilitali con `OMX_HOOK_PLUGINS=1`.

Consulta `docs/hooks-extension.md` per il workflow completo di estensione e il modello degli eventi.

## Flag di avvio

```bash
--yolo
--high
--xhigh
--madmax
--force
--dry-run
--verbose
--scope <user|project>  # solo per setup
```

`--madmax` corrisponde a Codex `--dangerously-bypass-approvals-and-sandbox`.
Utilizzare solo in ambienti sandbox fidati/esterni.

### Policy MCP workingDirectory (hardening opzionale)

Per impostazione predefinita, gli strumenti MCP stato/memoria/trace accettano il `workingDirectory` fornito dal chiamante.
Per limitare questo, imposta una lista di directory root consentite:

```bash
export OMX_MCP_WORKDIR_ROOTS="/path/to/project:/path/to/another-root"
```

Quando impostato, i valori `workingDirectory` al di fuori di queste root vengono rifiutati.

## Controllo Codex-First dei prompt

Per impostazione predefinita, OMX inietta:

```text
-c model_instructions_file="<cwd>/AGENTS.md"
```

Questo sovrappone le istruzioni `AGENTS.md` del progetto alle istruzioni di avvio di Codex.
Estende il comportamento di Codex, ma non sostituisce/aggira le policy di sistema core di Codex.

Controlli:

```bash
OMX_BYPASS_DEFAULT_SYSTEM_PROMPT=0 omx     # disabilita l'iniezione AGENTS.md
OMX_MODEL_INSTRUCTIONS_FILE=/path/to/instructions.md omx
```

## Modalità team

Usa la modalità team per lavori ampi che beneficiano di worker paralleli.

Ciclo di vita:

```text
start -> assign scoped lanes -> monitor -> verify terminal tasks -> shutdown
```

Comandi operativi:

```bash
omx team <args>
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

Regola importante: non arrestare mentre i task sono ancora `in_progress`, a meno che non si stia abortendo.

### Policy di pulizia Ralph

Quando un team è in esecuzione in modalità ralph (`omx team ralph ...`), la pulizia allo shutdown
applica una policy dedicata che differisce dal percorso normale:

| Comportamento | Team normale | Team Ralph |
|---|---|---|
| Shutdown forzato in caso di errore | Lancia `shutdown_gate_blocked` | Aggira il gate, registra l'evento `ralph_cleanup_policy` |
| Eliminazione automatica dei branch | Elimina i branch worktree durante il rollback | Preserva i branch (`skipBranchDeletion`) |
| Logging di completamento | Evento standard `shutdown_gate` | Evento aggiuntivo `ralph_cleanup_summary` con dettaglio dei task |

La policy ralph viene rilevata automaticamente dallo stato della modalità team (`linked_ralph`) o
può essere passata esplicitamente tramite `omx team shutdown <name> --ralph`.

Selezione CLI worker per i worker del team:

```bash
OMX_TEAM_WORKER_CLI=auto    # predefinito; usa claude quando worker --model contiene "claude"
OMX_TEAM_WORKER_CLI=codex   # forza i worker Codex CLI
OMX_TEAM_WORKER_CLI=claude  # forza i worker Claude CLI
OMX_TEAM_WORKER_CLI_MAP=codex,codex,claude,claude  # mix CLI per worker (lunghezza=1 o numero di worker)
OMX_TEAM_AUTO_INTERRUPT_RETRY=0  # opzionale: disabilita il fallback adattivo queue->resend
```

Note:
- Gli argomenti di avvio dei worker sono ancora condivisi tramite `OMX_TEAM_WORKER_LAUNCH_ARGS`.
- `OMX_TEAM_WORKER_CLI_MAP` sovrascrive `OMX_TEAM_WORKER_CLI` per la selezione per singolo worker.
- L'invio dei trigger usa per impostazione predefinita tentativi adattivi (queue/submit, poi fallback sicuro clear-line+resend quando necessario).
- In modalità worker Claude, OMX avvia i worker come semplice `claude` (nessun argomento di avvio aggiuntivo) e ignora le sovrascritture esplicite `--model` / `--config` / `--effort` in modo che Claude usi il `settings.json` predefinito.

## Cosa scrive `omx setup`

- `.omx/setup-scope.json` (scope di setup persistito)
- Installazioni dipendenti dallo scope:
  - `user`: `~/.codex/prompts/`, `~/.agents/skills/`, `~/.codex/config.toml`, `~/.omx/agents/`
  - `project`: `./.codex/prompts/`, `./.agents/skills/`, `./.codex/config.toml`, `./.omx/agents/`
- Comportamento all'avvio: se lo scope persistito è `project`, l'avvio `omx` usa automaticamente `CODEX_HOME=./.codex` (a meno che `CODEX_HOME` non sia già impostato).
- L'`AGENTS.md` esistente è preservato per impostazione predefinita. Nelle esecuzioni TTY interattive, il setup chiede conferma prima di sovrascrivere; `--force` sovrascrive senza chiedere (i controlli di sicurezza della sessione attiva si applicano comunque).
- Aggiornamenti `config.toml` (per entrambi gli scope):
  - `notify = ["node", "..."]`
  - `model_reasoning_effort = "high"`
  - `developer_instructions = "..."`
  - `[features] multi_agent = true, child_agents_md = true`
  - Voci server MCP (`omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`)
  - `[tui] status_line`
- `AGENTS.md` del progetto
- Directory di esecuzione `.omx/` e configurazione HUD

## Agenti e Skill

- Prompt: `prompts/*.md` (installati in `~/.codex/prompts/` per `user`, `./.codex/prompts/` per `project`)
- Skill: `skills/*/SKILL.md` (installati in `~/.agents/skills/` per `user`, `./.agents/skills/` per `project`)

Esempi:
- Agenti: `architect`, `planner`, `executor`, `debugger`, `verifier`, `security-reviewer`
- Skill: `autopilot`, `plan`, `team`, `ralph`, `ultrawork`, `cancel`

## Struttura del progetto

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

## Sviluppo

```bash
git clone https://github.com/Yeachan-Heo/oh-my-codex.git
cd oh-my-codex
npm install
npm run build
npm test
```

## Documentazione

- **[Documentazione completa](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** — Guida completa
- **[Riferimento CLI](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** — Tutti i comandi `omx`, flag e strumenti
- **[Guida alle notifiche](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#notifications)** — Configurazione Discord, Telegram, Slack e webhook
- **[Workflow consigliati](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** — Catene di skill collaudate per i compiti comuni
- **[Note di rilascio](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#release-notes)** — Novità di ogni versione

## Note

- Changelog completo: `CHANGELOG.md`
- Guida alla migrazione (post-v0.4.4 mainline): `docs/migration-mainline-post-v0.4.4.md`
- Note di copertura e parità: `COVERAGE.md`
- Workflow estensione hook: `docs/hooks-extension.md`
- Dettagli setup e contribuzione: `CONTRIBUTING.md`

## Ringraziamenti

Ispirato da [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode), adattato per Codex CLI.

## Licenza

MIT
