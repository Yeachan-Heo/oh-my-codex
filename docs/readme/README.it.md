# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Il tuo codex non è solo.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

> **[Website](https://yeachan-heo.github.io/oh-my-codex-website/)** | **[Documentation](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** | **[CLI Reference](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** | **[Workflows](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** | **[Guida all’integrazione OpenClaw](../openclaw-integration.it.md)** | **[GitHub](https://github.com/Yeachan-Heo/oh-my-codex)** | **[npm](https://www.npmjs.com/package/oh-my-codex)**

Livello di orchestrazione multi-agente per [OpenAI Codex CLI](https://github.com/openai/codex).

## Novità nella v0.9.0 — Spark Initiative

Spark Initiative è la release che rafforza il percorso nativo di esplorazione e ispezione in OMX.

- **Harness nativo per `omx explore`** — esegue l’esplorazione del repository in sola lettura tramite un percorso Rust più rapido e più rigoroso.
- **`omx sparkshell`** — superficie nativa per operatori con riepiloghi dell’output lungo e cattura esplicita dei pannelli tmux.
- **Asset nativi multipiattaforma** — il percorso di hydration per `omx-explore-harness`, `omx-sparkshell` e `native-release-manifest.json` ora fa parte della pipeline di release.
- **CI/CD rafforzato** — aggiunge la configurazione esplicita della toolchain Rust nel job `build`, oltre a `cargo fmt --check` e `cargo clippy -- -D warnings`.

Vedi anche le [note di rilascio v0.9.0](../release-notes-0.9.0.md) e il [testo della release](../release-body-0.9.0.md).

## Prima sessione

All'interno di Codex:

```text
$deep-interview "clarify the auth change"
$ralplan "approve the auth plan and review tradeoffs"
$ralph "carry the approved plan to completion"
$team 3:executor "execute the approved plan in parallel"
```

Dal terminale:

```bash
omx team 4:executor "parallelize a multi-module refactor"
omx team status <team-name>
omx team shutdown <team-name>
```

## Flusso consigliato

1. `$deep-interview` — quando ambito o confini non sono ancora chiari.
2. `$ralplan` — per trasformare l’ambito chiarito in un piano approvato di architettura e implementazione.
3. `$team` o `$ralph` — usa `$team` per l’esecuzione parallela coordinata, oppure `$ralph` per un loop persistente di completamento/verifica con un solo responsabile.

## Modello di base

OMX installa e collega questi livelli:

```text
User
  -> Codex CLI
    -> AGENTS.md (cervello dell'orchestrazione)
    -> ~/.codex/prompts/*.md (catalogo prompt degli agenti)
    -> ~/.codex/skills/*/SKILL.md (catalogo skill)
    -> ~/.codex/config.toml (funzionalità, notifiche, MCP)
    -> .omx/ (stato di esecuzione, memoria, piani, log)
```

## Comandi principali

```bash
omx                # Avvia Codex (+ HUD in tmux se disponibile)
omx setup          # Installa prompt/skill/config per scope + .omx del progetto + AGENTS.md specifico dello scope
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

Questo unisce l'`AGENTS.md` di `CODEX_HOME` con l'`AGENTS.md` del progetto (se presente) e poi aggiunge l'overlay di runtime.
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

### Team shutdown policy

Use `omx team shutdown <team-name>` after the team reaches a terminal state.
Team cleanup now follows one standalone path; legacy linked-Ralph shutdown handling is no longer a separate public workflow.

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
  - `user`: `~/.codex/prompts/`, `~/.codex/skills/`, `~/.codex/config.toml`, `~/.omx/agents/`, `~/.codex/AGENTS.md`
  - `project`: `./.codex/prompts/`, `./.codex/skills/`, `./.codex/config.toml`, `./.omx/agents/`, `./AGENTS.md`
- Comportamento all'avvio: se lo scope persistito è `project`, l'avvio `omx` usa automaticamente `CODEX_HOME=./.codex` (a meno che `CODEX_HOME` non sia già impostato).
- Le istruzioni di avvio uniscono `~/.codex/AGENTS.md` (o `CODEX_HOME/AGENTS.md` se ridefinito) con `./AGENTS.md` del progetto, quindi aggiungono l'overlay di runtime.
- I file `AGENTS.md` esistenti non vengono mai sovrascritti in silenzio: in TTY interattivo il setup chiede prima di sostituire; in modalità non interattiva la sostituzione viene saltata salvo `--force` (i controlli di sicurezza della sessione attiva restano validi).
- Aggiornamenti `config.toml` (per entrambi gli scope):
  - `notify = ["node", "..."]`
  - `model_reasoning_effort = "high"`
  - `developer_instructions = "..."`
  - `[features] multi_agent = true, child_agents_md = true`
  - Voci server MCP (`omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`)
  - `[tui] status_line`
- `AGENTS.md` specifico dello scope
- Directory di esecuzione `.omx/` e configurazione HUD

## Agenti e Skill

- Prompt: `prompts/*.md` (installati in `~/.codex/prompts/` per `user`, `./.codex/prompts/` per `project`)
- Skill: `skills/*/SKILL.md` (installati in `~/.codex/skills/` per `user`, `./.codex/skills/` per `project`)

Esempi:
- Agenti: `architect`, `planner`, `executor`, `debugger`, `verifier`, `security-reviewer`
- Skill: `deep-interview`, `ralplan`, `team`, `ralph`, `plan`, `cancel`

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
