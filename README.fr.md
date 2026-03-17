# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Votre codex n'est pas seul.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

> **[Website](https://yeachan-heo.github.io/oh-my-codex-website/)** | **[Documentation](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** | **[CLI Reference](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** | **[Workflows](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** | **[Guide d’intégration OpenClaw](./docs/openclaw-integration.fr.md)** | **[GitHub](https://github.com/Yeachan-Heo/oh-my-codex)** | **[npm](https://www.npmjs.com/package/oh-my-codex)**

Couche d'orchestration multi-agents pour [OpenAI Codex CLI](https://github.com/openai/codex).

## Nouveautés de la v0.9.0 — Spark Initiative

Spark Initiative est la version qui renforce la voie native d’exploration et d’inspection dans OMX.

- **Harness natif pour `omx explore`** — exécute l’exploration read-only du dépôt via une voie Rust plus rapide et plus stricte.
- **`omx sparkshell`** — surface native orientée opérateur, avec résumés de sorties longues et capture explicite de panneaux tmux.
- **Artifacts natifs multiplateformes** — le chemin d’hydratation de `omx-explore-harness`, `omx-sparkshell` et `native-release-manifest.json` fait désormais partie du pipeline de release.
- **CI/CD renforcé** — ajoute une configuration explicite de la toolchain Rust dans le job `build`, ainsi que `cargo fmt --check` et `cargo clippy -- -D warnings`.

Voir aussi les [notes de version v0.9.0](./docs/release-notes-0.9.0.md) et le [corps de release](./docs/release-body-0.9.0.md).

## Première session

Dans Codex :

```text
/prompts:architect "analyze current auth boundaries"
/prompts:executor "implement input validation in login"
$plan "ship OAuth callback safely"
$team 3:executor "fix all TypeScript errors"
```

Depuis le terminal :

```bash
omx team 4:executor "parallelize a multi-module refactor"
omx team status <team-name>
omx team shutdown <team-name>
```

## Modèle de base

OMX installe et connecte ces couches :

```text
User
  -> Codex CLI
    -> AGENTS.md (cerveau d'orchestration)
    -> ~/.codex/prompts/*.md (catalogue de prompts d'agents)
    -> ~/.codex/skills/*/SKILL.md (catalogue de skills)
    -> ~/.codex/config.toml (fonctionnalités, notifications, MCP)
    -> .omx/ (état d'exécution, mémoire, plans, journaux)
```

## Commandes principales

```bash
omx                # Lancer Codex (+ HUD dans tmux si disponible)
omx setup          # Installer prompts/skills/config par scope + .omx du projet + AGENTS.md propre au scope
omx doctor         # Diagnostics d'installation/exécution
omx doctor --team  # Diagnostics Team/Swarm
omx team ...       # Démarrer/statut/reprendre/arrêter les workers d'équipe tmux
omx status         # Afficher les modes actifs
omx cancel         # Annuler les modes d'exécution actifs
omx reasoning <mode> # low|medium|high|xhigh
omx tmux-hook ...  # init|status|validate|test
omx hooks ...      # init|status|validate|test (workflow d'extension de plugins)
omx hud ...        # --watch|--json|--preset
omx help
```

## Extension Hooks (Surface additive)

OMX inclut désormais `omx hooks` pour l'échafaudage et la validation de plugins.

- `omx tmux-hook` reste supporté et inchangé.
- `omx hooks` est additif et ne remplace pas les workflows tmux-hook.
- Les fichiers de plugins se trouvent dans `.omx/hooks/*.mjs`.
- Les plugins sont désactivés par défaut ; activez-les avec `OMX_HOOK_PLUGINS=1`.

Consultez `docs/hooks-extension.md` pour le workflow d'extension complet et le modèle d'événements.

## Flags de lancement

```bash
--yolo
--high
--xhigh
--madmax
--force
--dry-run
--verbose
--scope <user|project>  # uniquement pour setup
```

`--madmax` correspond à Codex `--dangerously-bypass-approvals-and-sandbox`.
À utiliser uniquement dans des environnements sandbox de confiance/externes.

### Politique MCP workingDirectory (durcissement optionnel)

Par défaut, les outils MCP état/mémoire/trace acceptent le `workingDirectory` fourni par l'appelant.
Pour restreindre cela, définissez une liste d'autorisation de racines :

```bash
export OMX_MCP_WORKDIR_ROOTS="/path/to/project:/path/to/another-root"
```

Lorsque défini, les valeurs `workingDirectory` en dehors de ces racines sont rejetées.

## Contrôle Codex-First des prompts

Par défaut, OMX injecte :

```text
-c model_instructions_file="<cwd>/AGENTS.md"
```

Cela fusionne le `AGENTS.md` de `CODEX_HOME` avec le `AGENTS.md` du projet (s'il existe), puis ajoute l'overlay d'exécution.
Cela étend le comportement de Codex, mais ne remplace/contourne pas les politiques système de base de Codex.

Contrôles :

```bash
OMX_BYPASS_DEFAULT_SYSTEM_PROMPT=0 omx     # désactiver l'injection AGENTS.md
OMX_MODEL_INSTRUCTIONS_FILE=/path/to/instructions.md omx
```

## Mode équipe

Utilisez le mode équipe pour les travaux importants qui bénéficient de workers parallèles.

Cycle de vie :

```text
start -> assign scoped lanes -> monitor -> verify terminal tasks -> shutdown
```

Commandes opérationnelles :

```bash
omx team <args>
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

Règle importante : n'arrêtez pas tant que des tâches sont encore `in_progress`, sauf en cas d'abandon.

### Politique de nettoyage Ralph

Lorsqu'une équipe s'exécute en mode ralph (`omx team ralph ...`), le nettoyage à l'arrêt
applique une politique dédiée qui diffère du chemin normal :

| Comportement | Équipe normale | Équipe Ralph |
|---|---|---|
| Arrêt forcé en cas d'échec | Lance `shutdown_gate_blocked` | Contourne la porte, journalise l'événement `ralph_cleanup_policy` |
| Suppression automatique des branches | Supprime les branches worktree lors du rollback | Préserve les branches (`skipBranchDeletion`) |
| Journalisation de complétion | Événement standard `shutdown_gate` | Événement supplémentaire `ralph_cleanup_summary` avec détail des tâches |

La politique ralph est auto-détectée depuis l'état du mode équipe (`linked_ralph`) ou
peut être passée explicitement via `omx team shutdown <name> --ralph`.

Sélection du CLI worker pour les workers d'équipe :

```bash
OMX_TEAM_WORKER_CLI=auto    # par défaut ; utilise claude quand worker --model contient "claude"
OMX_TEAM_WORKER_CLI=codex   # forcer les workers Codex CLI
OMX_TEAM_WORKER_CLI=claude  # forcer les workers Claude CLI
OMX_TEAM_WORKER_CLI_MAP=codex,codex,claude,claude  # mix CLI par worker (longueur=1 ou nombre de workers)
OMX_TEAM_AUTO_INTERRUPT_RETRY=0  # optionnel : désactiver le fallback adaptatif queue->resend
```

Notes :
- Les arguments de lancement des workers sont toujours partagés via `OMX_TEAM_WORKER_LAUNCH_ARGS`.
- `OMX_TEAM_WORKER_CLI_MAP` remplace `OMX_TEAM_WORKER_CLI` pour la sélection par worker.
- La soumission de déclencheurs utilise par défaut des tentatives adaptatives (queue/submit, puis fallback sécurisé clear-line+resend si nécessaire).
- En mode worker Claude, OMX lance les workers en tant que simple `claude` (pas d'arguments de lancement supplémentaires) et ignore les surcharges explicites `--model` / `--config` / `--effort` pour que Claude utilise le `settings.json` par défaut.

## Ce que `omx setup` écrit

- `.omx/setup-scope.json` (scope de setup persisté)
- Installations dépendantes du scope :
  - `user` : `~/.codex/prompts/`, `~/.codex/skills/`, `~/.codex/config.toml`, `~/.omx/agents/`, `~/.codex/AGENTS.md`
  - `project` : `./.codex/prompts/`, `./.codex/skills/`, `./.codex/config.toml`, `./.omx/agents/`, `./AGENTS.md`
- Comportement au lancement : si le scope persisté est `project`, le lancement `omx` utilise automatiquement `CODEX_HOME=./.codex` (sauf si `CODEX_HOME` est déjà défini).
- Les instructions de lancement fusionnent `~/.codex/AGENTS.md` (ou `CODEX_HOME/AGENTS.md` s'il est redéfini) avec `./AGENTS.md` du projet, puis ajoutent l'overlay d'exécution.
- Les fichiers `AGENTS.md` existants ne sont jamais écrasés silencieusement : en TTY interactif, setup demande avant de remplacer ; en non-interactif, le remplacement est ignoré sauf avec `--force` (les vérifications de sécurité de session active s'appliquent toujours).
- Mises à jour de `config.toml` (pour les deux scopes) :
  - `notify = ["node", "..."]`
  - `model_reasoning_effort = "high"`
  - `developer_instructions = "..."`
  - `[features] multi_agent = true, child_agents_md = true`
  - Entrées de serveurs MCP (`omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`)
  - `[tui] status_line`
- `AGENTS.md` spécifique au scope
- Répertoires d'exécution `.omx/` et configuration HUD

## Agents et Skills

- Prompts : `prompts/*.md` (installés dans `~/.codex/prompts/` pour `user`, `./.codex/prompts/` pour `project`)
- Skills : `skills/*/SKILL.md` (installés dans `~/.codex/skills/` pour `user`, `./.codex/skills/` pour `project`)

Exemples :
- Agents : `architect`, `planner`, `executor`, `debugger`, `verifier`, `security-reviewer`
- Skills : `autopilot`, `plan`, `team`, `ralph`, `ultrawork`, `cancel`

## Structure du projet

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

## Développement

```bash
git clone https://github.com/Yeachan-Heo/oh-my-codex.git
cd oh-my-codex
npm install
npm run build
npm test
```

## Documentation

- **[Documentation complète](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** — Guide complet
- **[Référence CLI](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** — Toutes les commandes `omx`, flags et outils
- **[Guide des notifications](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#notifications)** — Configuration Discord, Telegram, Slack et webhooks
- **[Workflows recommandés](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** — Chaînes de skills éprouvées pour les tâches courantes
- **[Notes de version](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#release-notes)** — Nouveautés de chaque version

## Notes

- Journal des modifications complet : `CHANGELOG.md`
- Guide de migration (post-v0.4.4 mainline) : `docs/migration-mainline-post-v0.4.4.md`
- Notes de couverture et parité : `COVERAGE.md`
- Workflow d'extension hooks : `docs/hooks-extension.md`
- Détails de configuration et contribution : `CONTRIBUTING.md`

## Remerciements

Inspiré par [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode), adapté pour Codex CLI.

## Licence

MIT
