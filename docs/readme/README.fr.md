
# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Démarrez Codex sur de bonnes bases ; OMX ajoute de meilleurs prompts, workflows et aides d’exécution quand le travail prend de l’ampleur.</em>
  <br><br>
  <strong>Vous aimez OMX mais le trouvez un peu trop complet ? <a href="https://github.com/Yeachan-Heo/gajae-code">Essayez gajae-code</a>.</strong><br>
  <sub>Gardez Codex OAuth avec une voie basée sur un SDK, plus rapide, moins coûteuse et plus simple, pour OpenClaw, Hermes, Grokbot et d’autres intégrations.</sub>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/wSyUQYfhAw)

**Site web :** https://yeachan-heo.github.io/oh-my-codex-website/

**Documentation :** [Bien démarrer](../getting-started.html) · [Agents](../agents.html) · [Skills](../skills.html) · [Intégrations](../integrations.html) · [Démo](../../DEMO.md) · [Guide OpenClaw](../openclaw-integration.fr.md)

**Communauté :** [Discord](https://discord.gg/wSyUQYfhAw) — serveur communautaire Gajae pour oh-my-codex, [gajae-code](https://github.com/Yeachan-Heo/gajae-code) et les outils associés.

## Projet et package officiels

Le projet OMX officiel est ce dépôt, [Yeachan-Heo/oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex), et son package npm officiel est [oh-my-codex](https://www.npmjs.com/package/oh-my-codex). Installez-le avec `npm install -g oh-my-codex`.

Les projets tiers ou forks utilisant des noms comme « OMX v2 » ne sont pas des continuations ni des versions officielles, sauf mention explicite dans ce README ou la documentation. En cas de doute, fiez-vous à ce dépôt et au package `oh-my-codex`.

OMX est une couche de workflow pour [OpenAI Codex CLI](https://github.com/openai/codex).

<table>
<tr><td><strong>🚨 ATTENTION — PARCOURS RECOMMANDÉ : macOS ou Linux avec Codex CLI.</strong><br><br>OMX est principalement conçu et optimisé pour ce parcours. Windows natif et Codex App ne constituent pas l’expérience par défaut, peuvent être instables et bénéficient actuellement d’un support plus limité.</td></tr>
</table>

OMX laisse Codex effectuer le travail et facilite :
- le démarrage de sessions Codex solides ;
- l’utilisation d’un workflow cohérent, de la clarification à la livraison ;
- l’appel indépendant de `$plan`, `$ultragoal`, `$team`, `$code-review` et `$ultraqa` ;
- le stockage des consignes du projet, plans, journaux et états dans `.omx/`.

## Mainteneurs principaux

| Rôle | Nom | GitHub |
| --- | --- | --- |
| Créateur et responsable | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Mainteneur | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Mainteneur | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Ambassadeurs

| Nom | GitHub |
| --- | --- |
| Sigrid Jin | [@sigridjineth](https://github.com/sigridjineth) |

## Principaux contributeurs

| Nom | GitHub |
| --- | --- |
| Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Junho Yeo | [@junhoyeo](https://github.com/junhoyeo) |
| JiHongKim98 | [@JiHongKim98](https://github.com/JiHongKim98) |
| Lor | [@gobylor](https://github.com/gobylor) |
| HyunjunJeon | [@HyunjunJeon](https://github.com/HyunjunJeon) |

## Parcours recommandé

Si Codex CLI est déjà installé :

```bash
codex --version
npm install -g oh-my-codex
# Depuis le dépôt Git que Codex doit modifier ; choisissez un nom propre à la tâche
omx --worktree=feat/task --madmax --xhigh
```

Si vous souhaitez que npm gère également Codex CLI :

```bash
npm install -g @openai/codex
npm install -g oh-my-codex
```

N’exécutez pas `npm install -g @openai/codex oh-my-codex` si une installation Homebrew possède déjà `codex` (par exemple `/opt/homebrew/bin/codex`) : npm peut échouer avec `EEXIST`. OMX a seulement besoin d’une commande `codex` fonctionnelle et authentifiée dans le `PATH`.

Lors d’un vrai changement de version OMX, l’installation npm globale affiche un rappel explicite sans lancer Setup automatiquement. Lancez `omx setup` avec le bon scope ou `omx update` lorsque vous êtes prêt. La vérification des mises à jour au démarrage est limitée en fréquence ; `OMX_AUTO_UPDATE=0` la désactive et `OMX_AUTO_UPDATE=defer` programme l’update sans invite après la session.

Choisissez soigneusement le scope :
- `omx setup --scope project --merge-agents` depuis le projet cible si ce dépôt doit posséder ses consignes `AGENTS.md` durables ;
- `omx setup --scope user` pour la configuration Codex de l’utilisateur ;
- évitez le setup de projet depuis un répertoire home ou un hub générique.

### Enregistrer la politique de fusion AGENTS

`omx setup --merge-agents`, `--no-merge-agents` et `--clear-merge-agents-policy` sont les sélecteurs de politique. Un choix explicite réussi est enregistré dans `./.omx/setup-scope.json` du root de travail, même pour le scope utilisateur ; il ne devient jamais une préférence globale. `omx update` réapplique une politique valide correspondant au scope.

`true` emprunte la branche de fusion existante. `false` la désactive seulement et ne garantit ni conservation ni remplacement des fichiers existants. Un reset ou changement de scope supprime la politique héritée, sauf nouveau choix explicite ; le sélecteur de suppression ne peut pas être combiné avec un choix. Les valeurs invalides ou hors scope sont ignorées.

`--force` est indépendant et temporaire : il n’est ni enregistré ni rejoué et ne remplace pas la politique explicite. Le choix n’est enregistré qu’après la réussite complète du setup. Cela ne fait pas de la fusion le comportement par défaut.

### Installation du plugin Codex

Ce dépôt fournit aussi une disposition de plugin Codex sous `plugins/oh-my-codex`. Le plugin fournit les skills groupés et des métadonnées de hooks/intégrations, mais ne remplace pas le CLI global `oh-my-codex` ni le setup scoped. Les hooks du plugin lancent le CLI `omx` installé.

Le mode plugin nécessite toujours un `AGENTS.md` durable au scope choisi : `~/.codex/AGENTS.md` pour le scope utilisateur ou `./AGENTS.md` pour le scope projet. Les fichiers AGENTS propres à une session ne font qu’ajouter des overlays d’exécution.

## À quoi sert OMX
Pour un objectif durable explicite, combinez `/goal` avec des checkpoints appropriés :

```text
# Objectif durable avec checkpoints :
/goal Préparer un plan de refactorisation d’authentification sûre, le mettre en œuvre et vérifier la connexion, la déconnexion et les jetons de renouvellement.

$deep-interview "clarify the authentication change"
$ralplan "approve the auth plan and review tradeoffs"
$ultragoal "turn the approved plan into durable Codex goals"
```



OMX s’adresse aux personnes qui aiment Codex et veulent un workflow plus cohérent, des rôles et skills réutilisables, des consignes durables et un état de runtime dans `.omx/`. Si vous préférez Codex sans couche de workflow supplémentaire, OMX n’est probablement pas nécessaire.

## Démarrage rapide

### Prérequis
- Node.js 20+
- Codex CLI installé et authentifié, vérifiable avec `codex --version`
- Authentification visible depuis le même shell/profil qu’OMX
- `tmux` sur macOS/Linux pour le runtime d’équipe recommandé
- `psmux` uniquement pour la voie d’équipe Windows native, moins prise en charge

### Une bonne première session

```bash
omx doctor
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```

`omx doctor` détecte les fichiers OMX, hooks et prérequis manquants. Le smoke test réel vérifie que Codex peut s’authentifier et effectuer une requête au modèle.

Depuis un dépôt Git, démarrez de préférence ainsi :

```bash
omx --worktree=feat/task --madmax --xhigh
```

Sur un terminal interactif macOS/Linux où tmux est disponible, OMX lance par défaut le leader dans un tmux détaché géré par OMX. `--worktree` isole le travail dans un checkout séparé, option plus sûre avec `--madmax`.

### Plusieurs conversations standard

Une session standard possède un pointeur d’écriture sous son root OMX. Pour d’autres conversations, utilisez des roots distincts :

```bash
omx
OMX_ROOT="$HOME/.omx/instances/second-conversation" omx
OMX_ROOT="$HOME/.omx/instances/third-conversation" omx
```

Un `OMX_ROOT` explicite est littéral : deux sessions utilisant le même root entrent en conflit. Des checkouts séparés ont des roots par défaut distincts.
PowerShell :

```powershell
$env:OMX_ROOT = "$HOME/.omx/instances/second-conversation"
omx
```

Invite de commandes Windows :

```bat
set "OMX_ROOT=%USERPROFILE%\.omx\instances\second-conversation"
omx
```


### Sécurité de Madmax et des worktrees

`--madmax` est l’alias de `--dangerously-bypass-approvals-and-sandbox` : il supprime les protections normales. Réservez-le aux dépôts et environnements fiables ; depuis Git, préférez un worktree nommé :

```bash
omx --worktree=feature/auth --madmax --xhigh
```
Pour des sessions Madmax parallèles, donnez à chacune un worktree nommé distinct :

```bash
omx --worktree=feature/auth --madmax --xhigh
omx --worktree=fix/flaky-tests --madmax --xhigh
```


`--high` et `--xhigh` règlent `model_reasoning_effort`. Chaque session Madmax concurrente doit utiliser un worktree différent. L’option `--worktree` est consommée par OMX et n’est pas transmise à Codex. OMX avertit si le worktree cible est déjà modifié ; vérifiez-le avant de vous y fier.

Pour un lancement ponctuel sans tmux/HUD OMX, utilisez `--direct` :


```bash
omx --direct --yolo
```

Comme préférence de shell ou de profil :

```bash
OMX_LAUNCH_POLICY=direct omx --yolo
```

Revenir au comportement automatique par défaut :

```bash
unset OMX_LAUNCH_POLICY
```

Les options CLI priment ; si plusieurs politiques sont données, la dernière gagne :

```bash
OMX_LAUNCH_POLICY=direct omx --tmux --yolo
```

Les politiques possibles sont `direct|tmux|detached-tmux|auto`. Les options CLI ont priorité sur la variable `OMX_LAUNCH_POLICY`.

## Modèle mental simple

OMX ne remplace pas Codex :
- **Codex** effectue le travail de l’agent ;
- **les rôles OMX** rendent les rôles utiles réutilisables ;
- **les skills OMX** réutilisent les workflows courants ;
- **`.omx/`** contient plans, journaux, mémoire et état d’exécution.

## Commencer ici si vous découvrez OMX

1. Installez ou mettez à jour OMX ; installez Codex CLI séparément si nécessaire.
2. Lancez `omx setup --scope project --merge-agents` dans le dépôt cible ou `omx setup --scope user` pour la configuration utilisateur.
3. Vérifiez avec `omx doctor`.
4. Vérifiez l’authentification et l’exécution réelle avec `codex login status` et `omx exec`.
5. Depuis un dépôt Git, lancez un worktree nommé.
6. Utilisez `$deep-interview` pour clarifier les exigences, `$ralplan` pour approuver le plan, puis `$ultragoal` pour l’exécuter durablement.
7. Utilisez `$team` lorsqu’une story bénéficie d’une coordination parallèle ; ajoutez `/goal` si des objectifs et checkpoints explicites sont nécessaires.
Exemple prêt à copier :

```text
# Objectif durable à copier avec checkpoints :
/goal Livrer le correctif du bug de checkout avec des objectifs et checkpoints durables pour la reproduction, l’implémentation, les tests de régression et la vérification finale.

$plan "approve the checkout bug-fix plan and review tradeoffs"
$ultragoal "execute the approved checkout fix with checkpoint evidence"
```

Chargez normalement seulement 2 à 5 skills pertinents. Évitez de charger un grand catalogue « au cas où » :

```text
omx --madmax --xhigh
# Puis charger immédiatement 20 skills « au cas où » avant même d'énoncer la tâche.
# Cela gonfle le contexte et détourne l'attention vers du contenu non pertinent.
```


## Workflow recommandé

`$autopilot` est l’orchestrateur canonique pour `$deep-interview -> $ralplan -> $ultragoal` ; chaque étape peut aussi être invoquée séparément si ses entrées sont déjà disponibles.

1. **`$deep-interview`** — clarifie progressivement exigences, limites et non-objectifs.
2. **`$ralplan`** — synthétise architecture, faisabilité et consensus.
3. **`$ultragoal`** — exécute à l’aide d’objectifs et checkpoints durables.
4. **`$team`** — coordonne plusieurs agents lorsque la story le justifie.

Chargez 2 à 5 skills pertinentes par défaut. Un catalogue trop vaste gaspille le budget de contexte et l’attention.

## Surfaces courantes en session

| Surface | Utilisation |
| --- | --- |
| `$plan` | Planification légère et clarification facultative |
| `$ultragoal` | Exécution durable en plusieurs objectifs |
| `$team` | Exécution parallèle coordonnée |
| `/skills` | Parcourir les skills |
| `/goal ...` | Objectifs et checkpoints durables |
| `omx mission` | Exécuter une checklist de prompts dans l’ordre |

## Surfaces avancées et opérateur

### Mission queue runner

`omx mission plan ./mission.md` valide une mission ; `omx mission run ./mission.md -- <args>` l’exécute. `status`, `resume`, `mark` et `rerun` servent aux missions interrompues. Voir la [documentation Mission](../mission.md).

### Exporter une session

Utilisez `omx session search "phrase"` puis `omx session export <session-id> --output conversation.md`. JSON, arguments/résultats d’outils et sélection d’un `--codex-home` sont optionnels. Par défaut, seules les conversations User/Assistant sont exportées ; instructions système/développeur et raisonnements sont exclus, mais le texte n’est pas expurgé. Voir [export de session](../session-export.md).

### Consulter l’usage des tokens

`omx session usage --since 7d --sort tokens` montre les compteurs cumulatifs enregistrés. Ajoutez filtres, `--json` ou `--codex-home`. `--since` filtre selon la dernière activité, pas la consommation facturée ; les valeurs manquantes restent inconnues. Voir [usage des sessions](../session-usage.md).

### Diagnostiquer la chronologie

`omx session timeline <session-id>` montre les outils, frontières de tours, durées observées et erreurs sans exporter le texte de conversation. Une durée inconnue reste inconnue ; un résultat sans erreur explicite ne prouve pas la réussite. Voir [timeline de session](../session-timeline.md).

### Runtime Team

`omx team` sert à une coordination durable via tmux/worktrees, et non à chaque petite tâche. Les workers rapportent statut et preuves ; l’Ultragoal reste géré par le leader. Les petites tâches peuvent limiter automatiquement le nombre de workers.

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

Dans Codex App ou une session hors tmux, `omx team` est une surface shell/tmux et non un workflow directement disponible dans l’application.

### Setup, doctor et HUD

Le setup scoped installe ou actualise prompts, skills, AGENTS, configuration et runtime. `omx update` vérifie npm, installe le dernier build global puis relance le parcours de setup. `omx doctor` vérifie l’installation et le câblage local, mais ne prouve pas qu’un vrai appel de modèle fonctionne.

En mode plugin, les skills et hooks sont fournis par le cache du plugin, mais le `AGENTS.md` de scope doit rester présent. `omx setup --disable-hooks` désactive les hooks gérés par OMX puis s’arrête avant l’installation normale des assets/configurations.

Pour les sessions hors Team, les hooks natifs Codex sont le cycle de vie canonique : `plugins/oh-my-codex/hooks/hooks.json` pour le plugin et `.codex/hooks.json` pour le mode legacy/fallback. Voir [mapping des hooks natifs Codex](../codex-native-hooks.md).


Après avoir confirmé qu’une équipe est réellement morte ou abandonnée :

```bash
omx team shutdown <team-name> --force --confirm-issues
omx cancel
omx doctor --team
```


Le HUD Team affiche le nom de l’équipe, le nombre de workers et, pour chacun, l’état, la task-ID, le rôle, le pane et l’âge de la mise à jour. Les données absentes ou mal formées s’affichent comme `unknown` et ne prouvent pas qu’un processus est vivant ; le roster est lu en mode read-only. Guardex est facultatif : `{ "guardex": { "enabled": true } }` dans le `.omx/hud-config.json` du projet l’active.

### Dépanner une disponibilité trompeuse

Un `omx doctor` vert ne garantit pas une exécution réelle :
- vérifiez `codex login status` et `omx exec` dans le même profil/shell ;
- avec un HOME personnalisé, un conteneur ou un service, vérifiez le `CODEX_HOME` réellement utilisé ;
- avec un proxy compatible OpenAI, vérifiez `openai_base_url` dans la configuration active ;
- confirmez qu’un état Team est réellement abandonné avant de forcer son arrêt.

### Sparkshell

`omx sparkshell <command>` sert à l’inspection shell et à la vérification bornée :

```bash
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```

Pour la recherche read-only ordinaire dans un dépôt, utilisez les outils de dépôt habituels plutôt qu’un ancien Explore.

### Wiki

`omx wiki` est l’interface CLI-first JSON. Les données Wiki résident sous `omx_wiki/` en Markdown ; la recherche est textuelle et orientée Markdown, pas vectorielle.

```bash
omx wiki list --json
omx wiki query --input '{"query":"session-start lifecycle"}' --json
omx wiki lint --json
omx wiki refresh --json
```

### Notes de plateforme pour Team

Team fonctionne au mieux sur macOS/Linux avec `tmux`. Windows natif est secondaire ; WSL2 est généralement préférable. Le chemin Windows natif accepte `psmux` comme exécutable compatible tmux.

| Plateforme | Installation |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## Problèmes connus

### Mac Intel : CPU `syspolicyd` / `trustd` élevé au démarrage

Sur certains Mac Intel, Gatekeeper peut fortement solliciter `syspolicyd` / `trustd` lorsqu’il vérifie de nombreux processus simultanés. Réduisez la concurrence ou ajustez les autorisations Developer Tools de macOS. Ne retirez les attributs de quarantaine que si vous avez vérifié l’origine et la sécurité du binaire.

## Documentation

- [Bien démarrer](../getting-started.html)
- [Guide de démo](../../DEMO.md)
- [Fonction Wiki](../wiki-feature.md)
- [Catalogue des agents](../agents.html)
- [Référence des skills](../skills.html)
- [Mapping des hooks natifs Codex](../codex-native-hooks.md)
- [Identité GitHub / PR / package](../pipeline/github-pr-package-identity.md)
- [Intégrations](../integrations.html)
- [Dépannage](../troubleshooting.md)
- [Guide OpenClaw / passerelle de notifications](../openclaw-integration.fr.md)
- [Contribution](../../CONTRIBUTING.md)
- [Journal des modifications](../../CHANGELOG.md)

## Langues

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

## Contributeurs

| Rôle | Nom | GitHub |
| --- | --- | --- |
| Créateur et responsable | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Mainteneur | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Mainteneur | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## Licence

MIT

## Benchmark de visibilité GEO

OMX inclut une spécification produit [geobench](https://github.com/NomaDamas/geobench) pour mesurer le taux de réussite, le MRR, la part de voix et les citations LLM.

- Spécification : [geobench/oh-my-codex.yaml](../../geobench/oh-my-codex.yaml)
- Guide d’exécution : [geobench.md](../geobench.md)
