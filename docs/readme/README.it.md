# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="Personaggio oh-my-codex" width="280">
  <br>
  <em>Avvia Codex con basi solide; OMX aggiunge prompt, workflow e supporto runtime migliori quando il lavoro cresce.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/wSyUQYfhAw)

**Sito:** https://yeachan-heo.github.io/oh-my-codex-website/  
**Documentazione:** [Guida introduttiva](../getting-started.html) · [Agenti](../agents.html) · [Skill](../skills.html) · [Integrazioni](../integrations.html) · [Demo](../../DEMO.md) · [Guida OpenClaw](../openclaw-integration.it.md)  
**Community:** [Discord](https://discord.gg/wSyUQYfhAw) — server condiviso Gajae per oh-my-codex, [gajae-code](https://github.com/Yeachan-Heo/gajae-code) e strumenti correlati.

## Progetto e pacchetto ufficiali

Il progetto OMX ufficiale è questo repository, [Yeachan-Heo/oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex), e il pacchetto npm ufficiale è [oh-my-codex](https://www.npmjs.com/package/oh-my-codex). Installa con `npm install -g oh-my-codex`. Fork o progetti di terze parti con nomi come “OMX v2” non sono continuazioni o release ufficiali salvo indicazione esplicita qui o nella documentazione.

OMX è un livello di workflow per [OpenAI Codex CLI](https://github.com/openai/codex): Codex resta il motore di esecuzione, mentre OMX aggiunge instradamento dei task, workflow riutilizzabili e stato persistente in `.omx/`. È progettato e ottimizzato soprattutto per macOS/Linux con Codex CLI; Windows nativo e Codex App sono percorsi secondari e meno supportati.

Se OMX ti sembra eccessivo, prova [gajae-code](https://github.com/Yeachan-Heo/gajae-code), un percorso basato su SDK che conserva Codex OAuth per OpenClaw, Hermes, Grokbot e altre integrazioni.

## Responsabili principali

| Ruolo | Nome | GitHub |
| --- | --- | --- |
| Creatore e lead | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Maintainer | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Maintainer | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Ambasciatori

| Nome | GitHub |
| --- | --- |
| Sigrid Jin | [@sigridjineth](https://github.com/sigridjineth) |

## Principali collaboratori

| Nome | GitHub |
| --- | --- |
| Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Junho Yeo | [@junhoyeo](https://github.com/junhoyeo) |
| JiHongKim98 | [@JiHongKim98](https://github.com/JiHongKim98) |
| Lor | [@gobylor](https://github.com/gobylor) |
| HyunjunJeon | [@HyunjunJeon](https://github.com/HyunjunJeon) |

## Flusso predefinito consigliato

Scegli un solo percorso d’installazione. Se Codex CLI è già installato (Homebrew, npm o un altro metodo supportato):

```bash
codex --version
npm install -g oh-my-codex
# dalla repository Git che Codex deve modificare; scegli un nome specifico per il task
omx --worktree=feat/task --madmax --xhigh
```

Se non hai ancora Codex CLI e vuoi che npm lo gestisca:

```bash
npm install -g @openai/codex
npm install -g oh-my-codex
```

Non installare insieme `@openai/codex` e `oh-my-codex` sopra un binario Codex già gestito da Homebrew: npm può fallire con `EEXIST`. OMX richiede solo un comando `codex` autenticato nel `PATH`. Dopo un aggiornamento reale di versione, l’installazione globale mostra un promemoria; esegui `omx setup --scope user` o `omx update` quando vuoi aggiornare la configurazione. Il controllo aggiornamenti all’avvio è limitato e chiede conferma; `OMX_AUTO_UPDATE=0` lo disattiva e `OMX_AUTO_UPDATE=defer` pianifica l’aggiornamento dopo la sessione.

Scegli consapevolmente lo scope:
- `omx setup --scope project --merge-agents` dalla repository del progetto quando essa deve possedere le istruzioni `AGENTS.md` persistenti.
- `omx setup --scope user` per la configurazione Codex dell’utente.
- Non eseguire setup di progetto da una home directory ampia, a meno che quella directory non sia davvero il progetto.

### Salvare una policy esplicita per AGENTS

`omx setup --merge-agents`, `--no-merge-agents` e `--clear-merge-agents-policy` sono gli unici selettori; usa la forma senza `=value`. La policy si applica alla root di lavoro corrente, anche con scope utente, e viene registrata in `./.omx/setup-scope.json`. Una scelta `true` conserva il ramo di merge esistente; `false` lo disabilita senza promettere sostituzione o nuove garanzie. Il clear rimuove sempre la scelta salvata e non si combina con un selettore set. `--force` è indipendente, temporaneo e non sovrascrive una policy esplicita. La policy viene salvata solo dopo il completamento del setup; versioni OMX precedenti possono ignorarla o cancellarla riscrivendo le proprie preferenze.

**Installazione del plugin Codex:** la repository include anche il plugin ufficiale in `plugins/oh-my-codex`. Offre skill incluse, metadati companion e hook ufficiali del ciclo di vita; resta abbinato alla CLI globale `omx`, non la sostituisce. Entrambe le modalità installano normalmente i file TOML degli agenti nativi. La guida [Plugin bundle SSOT](../plugin-bundle-ssot.md) spiega la proprietà degli asset. La modalità plugin richiede comunque un `AGENTS.md` persistente in `~/.codex/AGENTS.md` o `./AGENTS.md`.

Una sessione lunga può usare un obiettivo durevole:

```text
/goal Pianifica e realizza un refactor sicuro dell'autenticazione, verificando login, logout e rinnovo dei token.

$deep-interview "chiarisci il cambiamento di autenticazione"
$ralplan "approva il piano e valuta i compromessi"
$ultragoal "trasforma il piano approvato in obiettivi Codex durevoli"
```

Questo è il percorso principale. Prima di considerare il runtime pronto, esegui `omx doctor` e uno smoke test reale: `codex login status` e `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"`. Usa `$team` all’interno dell’esecuzione Ultragoal solo quando uno specifico task richiede coordinamento.

## A cosa serve OMX

Usa OMX se apprezzi Codex ma vuoi un runtime quotidiano migliore:
- workflow standard `$deep-interview` → `$ralplan` → `$ultragoal`;
- ricerca ufficiale circoscritta con `$best-practice-research` o ricerca con validatori e artefatti tramite `$autoresearch`;
- handoff durevoli multi-obiettivo con `.omx/ultragoal`;
- ruoli specialistici, skill e istruzioni di progetto tramite `AGENTS.md`;
- log, piani, memoria e stato in `.omx/`.

Per Codex senza un livello di workflow aggiuntivo, OMX probabilmente non serve.

## Avvio rapido

### Requisiti
- Node.js 20+
- Codex CLI installato, autenticato e verificato con `codex --version` (Homebrew e npm vanno bene).
- Autenticazione visibile nello stesso profilo shell che avvia OMX.
- `tmux` su macOS/Linux per il runtime Team durevole consigliato; `psmux` solo se vuoi intenzionalmente il percorso Team meno supportato su Windows nativo.

### Una buona prima sessione

```bash
omx doctor
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```
omx --worktree=feat/task --madmax --xhigh
```
```

`omx doctor` controlla installazione e runtime locale; il vero smoke test verifica autenticazione, profilo e provider con una richiesta effettiva.

### Conversazioni standard simultanee

Una sessione standard possiede un solo puntatore scrivibile nella propria `OMX_ROOT`. Avviare due `omx` dalla stessa checkout fallisce invece di condividere la root. Per altre conversazioni usa root distinte:

```bash
omx
OMX_ROOT="$HOME/.omx/instances/second-conversation" omx
```

Imposta `$env:OMX_ROOT` in PowerShell oppure `OMX_ROOT` nel Prompt dei comandi. Root esplicite uguali generano conflitto; checkout separati hanno root predefinite separate.

### OMX_ROOT in PowerShell e Prompt dei comandi

PowerShell:
```powershell
$env:OMX_ROOT = "$HOME/.omx/instances/second-conversation"
omx
```

Prompt dei comandi:
```bat
set "OMX_ROOT=%USERPROFILE%\.omx\instances\second-conversation"
omx
```

### Sicurezza di Madmax e worktree

`--madmax` corrisponde a `--dangerously-bypass-approvals-and-sandbox`: rimuove le protezioni normali, quindi usalo solo in repository e ambienti fidati. Preferisci un worktree nominato:

```bash
Worktree nominato per un singolo task:
```bash
omx --worktree=feature/auth --madmax --xhigh
```

omx --worktree=feature/auth --madmax --xhigh
omx --worktree=fix/flaky-tests --madmax --xhigh
```

`--worktree` crea una checkout separata; senza nome usa una directory detached temporanea. Se un worktree è già sporco, OMX avvisa ma avvia comunque. Per una sessione senza gestione tmux/HUD usa `--direct`; `OMX_LAUNCH_POLICY=direct|tmux|detached-tmux|auto` controlla la preferenza persistente, mentre i flag CLI hanno precedenza. Il flag non introduce una nuova impostazione in file di configurazione.

Avvio diretto:
```bash
omx --direct --yolo
```

Preferenza di profilo:
```bash
OMX_LAUNCH_POLICY=direct omx --yolo
```

Ripristino automatico:
```bash
unset OMX_LAUNCH_POLICY
```

I flag CLI prevalgono sulla variabile d'ambiente; tra i flag CLI vale l'ultimo:
```bash
OMX_LAUNCH_POLICY=direct omx --tmux --yolo
```

### Selezione di /goal e skill

Avvia con `omx --madmax --xhigh` o aggiungi `--worktree=<task>`. Usa `/goal` per obiettivi e checkpoint durevoli, `$plan` per pianificare, `$team` per coordinamento parallelo, oppure `$ultragoal` per eseguire obiettivi multipli. In genere carica solo 2–5 skill pertinenti; un catalogo intero riduce la qualità dell’attenzione.

Esempio di obiettivo durevole:
```text
/goal Rilascia la correzione checkout con checkpoint per riproduzione, implementazione, test di regressione e verifica finale.

$plan "approva il piano della correzione checkout e valuta i compromessi"
$ultragoal "esegui la correzione approvata con evidenza dei checkpoint"
```

Antipattern: non caricare subito molte skill «per sicurezza»:
```text
omx --madmax --xhigh
# Non caricare subito 20 skill prima di descrivere il task.
# Questo gonfia il contesto e distrae da workflow non pertinenti.
```

## Modello mentale semplice

OMX non sostituisce Codex:
- **Codex** esegue il lavoro;
- **keyword di ruolo OMX** rendono riutilizzabili i ruoli;
- **skill OMX** rendono riutilizzabili i workflow;
- **`.omx/`** conserva piani, log, memoria e stato.

Pensalo come instradamento migliore dei task, workflow migliori e runtime migliore.

## Se sei nuovo

1. Verifica o installa Codex CLI, poi installa `oh-my-codex`.
2. Dopo una nuova installazione o un vero aggiornamento OMX, esegui `omx setup --scope project --merge-agents` o `omx setup --scope user`; `omx update` può aggiornare npm e poi rinfrescare setup.
3. Esegui `omx doctor`.
4. Verifica un'esecuzione autenticata con `codex login status` e `omx exec`.
5. Avvia in un worktree nominato; per sessioni Madmax concorrenti usa worktree distinti.
6. Chiarisci richieste ambigue con `$deep-interview`.
7. Approva piano e compromessi con `$ralplan`.
8. Usa `$ultragoal` o `$team` quando serve esecuzione durevole o parallela; `/goal` per checkpoint espliciti.

## Workflow consigliato

`$autopilot` è l’orchestratore canonico: `$deep-interview` → `$ralplan` → `$ultragoal`. Ogni fase è invocabile separatamente quando i suoi prerequisiti sono già soddisfatti.

1. `$deep-interview` — chiarisce ambiguità e produce requisiti pronti per l’esecuzione.
2. `$ralplan` — valuta architettura, fattibilità e consenso.
3. `$ultragoal` — esecuzione durevole con checkpoint in `.omx/ultragoal`.
4. `$team` — coordinamento solo quando il task lo giustifica.

All’interno di un racconto Ultragoal, usa Team solo se utile alla storia corrente. `$plan` pianifica ma non implementa; per le modifiche serve una fase di esecuzione.

## Superfici comuni nella sessione

| Superficie | Uso |
| --- | --- |
| `$plan` | pianificazione e chiarimento facoltativi |
| `$ultragoal` | completamento durevole dopo il piano approvato |
| `$team` | coordinamento parallelo |
| `/skills` | consultare skill installate |
| `/goal` | obiettivo e checkpoint da riconciliare tra turni |
| `omx mission <file>` | prompt/checklist sequenziali, con artefatti sotto `.omx/missions/` |

## Superfici avanzate e operative

- `omx mission plan ./mission.md` valida una checklist; usa `--dry-run`, `run`, `status`, `resume`, `mark` e `rerun` per gestirla. Vedi [Mission](../mission.md).
- `omx session search` e `omx session export` trovano ed esportano conversazioni precedenti; supportano ID o prefissi univoci, JSON, output file e selezione `--codex-home`. I messaggi utente/assistant sono inclusi, ma system/developer e ragionamento sono esclusi; il testo non viene redatto.
- `omx session usage --since 7d --sort tokens` mostra uso cumulativo locale, non consumo o fatturazione del periodo. I duplicati della stessa sessione vengono contati una sola volta; misure mancanti restano sconosciute.
- `omx session timeline <id>` mostra chiamate, risultati, durate note, errori e compattazioni senza esportare il testo; un risultato privo di errore esplicito non prova il successo.
- `omx team` è un runtime coordinato via tmux/worktree, non il modo predefinito per iniziare. `status` osserva soltanto e non modifica lo stato; `shutdown` va usato solo per il team corretto.
- `omx setup` installa asset e configurazione secondo lo scope; `omx update` controlla npm e aggiorna setup. `omx doctor` controlla l’installazione ma non prova che il profilo Codex possa autenticarsi. `omx hud --watch` è una superficie di monitoraggio.
- L’installazione plugin può mettere il pacchetto in `${CODEX_HOME:-~/.codex}/plugins/cache/...`; il plugin include hook e metadati companion, ma l’esecuzione dipende dalla CLI globale `omx`. `omx setup --disable-hooks` disattiva gli hook OMX. Consulta [mappa degli hook Codex](../codex-native-hooks.md).
- `.omx-config.json` può configurare routing model/env; usa solo chiavi supportate dalla versione installata: [schema di routing](../reference/omx-config-schema-routing.md). La configurazione Guardex opt-in è `"guardex": { "enabled": true }` in `.omx/hud-config.json`.
- Per problemi di «falso verde», verifica `codex login status`, `CODEX_HOME` e `openai_base_url` nel profilo attivo. Arresta forzatamente un team solo se è morto o abbandonato intenzionalmente.
- `omx sparkshell` serve per ispezione shell e verifiche circoscritte; per ricerche repo di sola lettura usa gli strumenti Codex normali. `omx wiki` è l’interfaccia JSON CLI per la knowledge base Markdown in `omx_wiki/`.

Esempi:

```bash
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```
```bash
omx wiki list --json
omx wiki query --input '{"query":"session-start lifecycle"}' --json
omx wiki lint --json
omx wiki refresh --json
```

Comandi Team:
```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

Usa la pulizia forzata solo dopo aver verificato che il team sia morto o abbandonato:
```bash
omx team shutdown <team-name> --force --confirm-issues
omx cancel
omx doctor --team
```

### Note di piattaforma per Team

Team funziona meglio su macOS/Linux con `tmux`. Windows nativo è secondario; WSL2 è generalmente preferibile. Su Windows OMX accetta `psmux`.

| Piattaforma | Installazione |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## Problemi noti

### Mac Intel: CPU elevata per `syspolicyd` / `trustd` all’avvio

Su alcuni Mac Intel, Gatekeeper può aumentare l’uso CPU all’avvio, soprattutto con `--madmax --high`. Prova `xattr -dr com.apple.quarantine $(which omx)`, consenti l’app Terminale nelle impostazioni Developer Tools o riduci la concorrenza.

Per problemi con Shift+Enter nei tmux gestiti da OMX, consulta [Troubleshooting](../troubleshooting.md#shiftenter-submits-instead-of-inserting-a-newline-in-tmux-backed-omx-sessions).

## Documentazione

- [Guida introduttiva](../getting-started.html)
- [Demo](../../DEMO.md)
- [Wiki](../wiki-feature.md)
- [Catalogo agenti](../agents.html)
- [Riferimento skill](../skills.html)
- [Mappa hook nativi Codex](../codex-native-hooks.md)
- [Pipeline identità GitHub/PR/package](../pipeline/github-pr-package-identity.md)
- [Integrazioni](../integrations.html)
- [Troubleshooting](../troubleshooting.md)
- [Guida OpenClaw/notifiche](../openclaw-integration.it.md)
- [Contribuire](../../CONTRIBUTING.md)
- [Changelog](../../CHANGELOG.md)

## Lingue

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

## Contributori

| Ruolo | Nome | GitHub |
| --- | --- | --- |
| Creatore e lead | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Maintainer | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Maintainer | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Cronologia stelle

[![Star History](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=Date)

## Licenza

MIT

## Benchmark di visibilità GEO

OMX include una specifica [geobench](https://github.com/NomaDamas/geobench) per misurare hit rate LLM, MRR, share of voice e citazioni.

- Specifica: [geobench/oh-my-codex.yaml](../../geobench/oh-my-codex.yaml)
- Runbook: [geobench.md](../geobench.md)
