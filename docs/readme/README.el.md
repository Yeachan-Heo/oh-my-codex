# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="Χαρακτήρας oh-my-codex" width="280">
  <br>
  <em>Ξεκινήστε με ισχυρότερο Codex· καθώς μεγαλώνει η εργασία, το OMX προσθέτει καλύτερα prompts, workflows και υποστήριξη runtime.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/wSyUQYfhAw)

**Ιστότοπος:** https://yeachan-heo.github.io/oh-my-codex-website/  
**Τεκμηρίωση:** [Ξεκινώντας](../getting-started.html) · [Agents](../agents.html) · [Skills](../skills.html) · [Ενσωματώσεις](../integrations.html) · [Demo](../../DEMO.md) · [Οδηγός OpenClaw](../openclaw-integration.md)  
**Κοινότητα:** [Discord](https://discord.gg/wSyUQYfhAw) — κοινός διακομιστής Gajae για oh-my-codex, [gajae-code](https://github.com/Yeachan-Heo/gajae-code) και σχετικά εργαλεία.

## Επίσημο έργο και πακέτο

Το επίσημο/original έργο OMX είναι αυτό το repository, [Yeachan-Heo/oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex), και το επίσημο πακέτο npm είναι [oh-my-codex](https://www.npmjs.com/package/oh-my-codex). Εγκαταστήστε με `npm install -g oh-my-codex`. Fork ή τρίτα έργα με ονόματα όπως «OMX v2» δεν αποτελούν επίσημες συνέχειες, αντικαταστάσεις ή γραμμές έκδοσης, εκτός αν αυτό δηλώνεται ρητά.

Το OMX είναι επίπεδο workflow για το [OpenAI Codex CLI](https://github.com/openai/codex). Το Codex παραμένει η μηχανή εκτέλεσης· το OMX κάνει ευκολότερη την έναρξη ισχυρότερων συνεδριών, την επαναχρησιμοποίηση ρόλων/skills και workflow από διευκρίνιση έως ολοκλήρωση, και την αποθήκευση οδηγιών, σχεδίων, logs και κατάστασης στο `.omx/`. Ο κύριος, ενεργά βελτιστοποιημένος δρόμος είναι macOS/Linux με Codex CLI. Τα Windows native και το Codex App είναι δευτερεύουσες, λιγότερο υποστηριζόμενες επιλογές.

Αν το OMX φαίνεται υπερβολικά πλήρες, δοκιμάστε το [gajae-code](https://github.com/Yeachan-Heo/gajae-code), μια ελαφρύτερη διαδρομή βασισμένη σε SDK που διατηρεί το Codex OAuth για OpenClaw, Hermes, Grokbot και άλλες ενσωματώσεις.

## Κύριοι συντηρητές

| Ρόλος | Όνομα | GitHub |
| --- | --- | --- |
| Δημιουργός και επικεφαλής | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Συντηρητής | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Συντηρητής | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Πρεσβευτές

| Όνομα | GitHub |
| --- | --- |
| Sigrid Jin | [@sigridjineth](https://github.com/sigridjineth) |

## Κορυφαίοι συνεργάτες

| Όνομα | GitHub |
| --- | --- |
| Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Junho Yeo | [@junhoyeo](https://github.com/junhoyeo) |
| JiHongKim98 | [@JiHongKim98](https://github.com/JiHongKim98) |
| Lor | [@gobylor](https://github.com/gobylor) |
| HyunjunJeon | [@HyunjunJeon](https://github.com/HyunjunJeon) |

## Προτεινόμενη προεπιλεγμένη ροή

Επιλέξτε έναν τρόπο εγκατάστασης. Αν το Codex CLI είναι ήδη εγκατεστημένο:

```bash
codex --version
npm install -g oh-my-codex
# από το git project που θα επεξεργαστεί το Codex· επιλέξτε όνομα ειδικό για την εργασία
omx --worktree=feat/task --madmax --xhigh
```

Αν δεν έχετε Codex CLI και θέλετε να το διαχειρίζεται το npm:

```bash
npm install -g @openai/codex
npm install -g oh-my-codex
```

Μην εγκαθιστάτε μαζί `@openai/codex` και OMX πάνω από υπάρχον binary `codex` που διαχειρίζεται το Homebrew· το npm μπορεί να αποτύχει με `EEXIST`. Το OMX χρειάζεται μόνο λειτουργική και authenticated εντολή `codex` στο `PATH`. Σε πραγματική αναβάθμιση έκδοσης, η global εγκατάσταση npm εμφανίζει υπενθύμιση αντί να ξεκινήσει αυτόματα το setup· όταν είστε έτοιμοι, τρέξτε `omx setup` ή `omx update`. Ο έλεγχος ενημερώσεων στην εκκίνηση είναι περιοδικός και ζητά επιβεβαίωση· `OMX_AUTO_UPDATE=0` τον απενεργοποιεί, ενώ `OMX_AUTO_UPDATE=defer` προγραμματίζει αναβολή χωρίς prompt.

Επιλέξτε scope setup συνειδητά:
- `omx setup --scope project --merge-agents` από το git project που θέλετε να λειτουργεί ως μόνιμη πηγή των οδηγιών `AGENTS.md`.
- `omx setup --scope user` για ρύθμιση Codex σε επίπεδο χρήστη.
- Μην κάνετε project setup από γενικό home directory εκτός αν αυτό είναι όντως το project.

### Αποθήκευση ρητής πολιτικής merge AGENTS

Οι μόνοι επιλογείς είναι `--merge-agents`, `--no-merge-agents` και `--clear-merge-agents-policy`· χρησιμοποιήστε τους χωρίς `=value`. Η επιλογή αποθηκεύεται στη ρίζα εργασίας `./.omx/setup-scope.json` (ακόμη και όταν το scope είναι user), όχι ως global preference. Το `true` διατηρεί τον υπάρχοντα κλάδο merge· το `false` απλώς τον καταστέλλει και δεν υπόσχεται διατήρηση ή αντικατάσταση. Το clear αφαιρεί πάντα την επιλογή και δεν συνδυάζεται με set. Το `--force` είναι ανεξάρτητο και προσωρινό, δεν αποθηκεύεται και δεν υπερισχύει ρητής policy. Η επιλογή γράφεται μόνο μετά την επιτυχή ολοκλήρωση setup. Παλαιότερες εκδόσεις OMX μπορεί να αγνοήσουν ή να αφαιρέσουν το πεδίο όταν ξαναγράψουν γνωστές προτιμήσεις.

**Εγκατάσταση plugin Codex:** το repository περιλαμβάνει επίσημο plugin στο `plugins/oh-my-codex`, με bundled skills, companion metadata και επίσημα Codex lifecycle hooks· δεν αντικαθιστά όμως την global CLI `omx`. Και οι δύο τρόποι setup συνήθως εγκαθιστούν native agent TOML. Η λειτουργία plugin χρειάζεται μόνιμο `AGENTS.md` στο `~/.codex/AGENTS.md` ή στο `./AGENTS.md`. Δείτε [Plugin bundle SSOT](../plugin-bundle-ssot.md). Το `omx setup --disable-hooks` απενεργοποιεί τις εγγραφές hook του OMX.

Για μεγάλα tasks ορίστε διαρκή στόχο και checkpoints:

```text
/goal Σχεδιάστε ασφαλές refactor αυθεντικοποίησης, υλοποιήστε το και ελέγξτε login, logout και ανανέωση token.

$deep-interview "διευκρίνισε την αλλαγή αυθεντικοποίησης"
$ralplan "έγκρινε το σχέδιο και αξιολόγησε τα tradeoffs"
$ultragoal "μετέτρεψε το εγκεκριμένο σχέδιο σε ανθεκτικούς στόχους Codex"
```

Πριν θεωρήσετε έτοιμο το runtime, τρέξτε `omx doctor` και πραγματικό smoke test: `codex login status` και `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"`. Χρησιμοποιήστε `$team` μέσα σε εκτέλεση Ultragoal μόνο όταν μια ιστορία χρειάζεται συντονισμό.

## Σε τι χρησιμεύει το OMX

Χρησιμοποιήστε το αν σας αρέσει το Codex αλλά θέλετε καλύτερο καθημερινό runtime:
- τυπική ροή `$deep-interview` → `$ralplan` → `$ultragoal`·
- οριοθετημένη upstream έρευνα με `$best-practice-research` ή έρευνα με validators και artifacts μέσω `$autoresearch`·
- διαρκή handoffs πολλών στόχων με `.omx/ultragoal`·
- ειδικούς ρόλους, επαναχρησιμοποιήσιμα skills και οδηγίες έργου `AGENTS.md`·
- σχέδια, logs, μνήμη και κατάσταση στο `.omx/`.

Για απλό Codex χωρίς πρόσθετο workflow layer, πιθανότατα δεν χρειάζεστε OMX.

## Γρήγορη εκκίνηση

### Απαιτήσεις
- Node.js 20+
- Εγκατεστημένο και authenticated Codex CLI, ελεγμένο με `codex --version`.
- Τα auth στοιχεία ορατά στο ίδιο shell/profile που ξεκινά το OMX.
- `tmux` σε macOS/Linux για το προτεινόμενο Team runtime· `psmux` μόνο για το λιγότερο υποστηριζόμενο native Windows Team path.

### Μια καλή πρώτη συνεδρία

```bash
omx doctor
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
omx --worktree=feat/task --madmax --xhigh
```

Το `omx doctor` εντοπίζει ελλείψεις εγκατάστασης, hooks και runtime. Το πραγματικό smoke test ελέγχει authentication, profile και provider με κανονικό αίτημα Codex.

### Πολλαπλές τυπικές συνομιλίες

Μια τυπική εκκίνηση έχει έναν writable session pointer στο επιλεγμένο `OMX_ROOT`. Δεύτερη `omx` από το ίδιο checkout αποτυγχάνει κλειστά αντί να μοιραστεί root. Δώστε ξεχωριστή root σε κάθε συνομιλία:

```bash
omx
OMX_ROOT="$HOME/.omx/instances/second-conversation" omx
```

Για PowerShell ορίστε `$env:OMX_ROOT`· για Command Prompt χρησιμοποιήστε `%USERPROFILE%`. Ίδια ρητή root προκαλεί owner conflict, ενώ διαφορετικά checkouts έχουν ξεχωριστές προεπιλογές.

### Ασφάλεια Madmax και worktree

Το `--madmax` είναι συντομογραφία του `--dangerously-bypass-approvals-and-sandbox` και αφαιρεί τις κανονικές δικλείδες. Χρησιμοποιήστε το μόνο σε έμπιστα repos και περιβάλλοντα. Προτιμήστε ονομασμένο worktree:

```bash
omx --worktree=feature/auth --madmax --xhigh
omx --worktree=fix/flaky-tests --madmax --xhigh
```

Το `--worktree` δημιουργεί ξεχωριστό git checkout· χωρίς όνομα χρησιμοποιεί detached worktree μίας χρήσης. Αν είναι dirty, OMX προειδοποιεί αλλά συνεχίζει. Το `--direct` παρακάμπτει διαχείριση tmux/HUD για μία εκκίνηση· το `OMX_LAUNCH_POLICY=direct|tmux|detached-tmux|auto` ορίζει προτίμηση περιβάλλοντος και τα CLI flags υπερισχύουν. Δεν προστίθεται ρύθμιση config file.

### /goal και επιλογή skill

Χρησιμοποιήστε `/goal` για διαρκείς στόχους/checkpoints, `$plan` για σχεδιασμό, `$team` για παράλληλο συντονισμό και `$ultragoal` για διαρκή εκτέλεση πολλών στόχων. Φορτώστε συνήθως μόνο 2–5 σχετικά skills· η μαζική φόρτωση σπαταλά πλαίσιο και προσοχή.

## Ένα απλό νοητικό μοντέλο

Το OMX δεν αντικαθιστά το Codex:
- **Codex** εκτελεί την εργασία.
- **OMX role keywords** επαναχρησιμοποιούν ρόλους.
- **OMX skills** επαναχρησιμοποιούν workflows.
- **`.omx/`** αποθηκεύει σχέδια, logs, μνήμη και runtime state.

Σκεφτείτε το ως καλύτερη δρομολόγηση εργασιών, workflow και runtime.

## Για νέους χρήστες

1. Ελέγξτε ή εγκαταστήστε Codex CLI και μετά `oh-my-codex`.
2. Μετά από εγκατάσταση ή πραγματικό version bump, τρέξτε setup στο σωστό scope· το `omx update` μπορεί πρώτα να ενημερώσει npm.
3. Τρέξτε `omx doctor`.
4. Ελέγξτε `codex login status` και πραγματικό `omx exec` smoke test.
5. Ξεκινήστε σε ονομασμένο worktree· χωρίστε concurrent Madmax sessions.
6. Χρησιμοποιήστε `$deep-interview` για ασάφειες.
7. Χρησιμοποιήστε `$ralplan` για έγκριση σχεδίου και tradeoffs.
8. Επιλέξτε `$ultragoal` ή `$team` για διαρκή ή παράλληλη εργασία και `/goal` για ρητά checkpoints.

## Προτεινόμενο workflow

Το `$autopilot` είναι ο βασικός orchestrator με ακολουθία `$deep-interview` → `$ralplan` → `$ultragoal`. Κάθε στάδιο καλείται και χωριστά αν έχουν καλυφθεί οι προϋποθέσεις.

1. `$deep-interview` — διευκρίνιση και εκτελέσιμες απαιτήσεις.
2. `$ralplan` — αρχιτεκτονική, εφικτότητα και συναίνεση.
3. `$ultragoal` — διαρκής εκτέλεση και checkpoints στο `.omx/ultragoal`.
4. `$team` — συντονισμός μόνο όπου χρειάζεται.

Τα skills σχεδιασμού σταματούν στο σχέδιο· αλλαγές κώδικα χρειάζονται εκτέλεση. Μέσα σε story Ultragoal, χρησιμοποιήστε Team μόνο αν βοηθά την ιστορία.

## Συνήθεις επιφάνειες συνεδρίας

| Επιφάνεια | Χρήση |
| --- | --- |
| `$plan` | προαιρετικός σχεδιασμός και διευκρίνιση |
| `$ultragoal` | διαρκής ολοκλήρωση μετά το εγκεκριμένο σχέδιο |
| `$team` | παράλληλος συντονισμός |
| `/skills` | περιήγηση εγκατεστημένων skills |
| `/goal` | στόχος και checkpoints που συμφιλιώνονται ανάμεσα σε turns |
| `omx mission <file>` | διαδοχικά prompts/checklist με artifacts στο `.omx/missions/` |

## Προχωρημένες / λειτουργικές επιφάνειες

- `omx mission plan ./mission.md` και `--dry-run` ελέγχουν ένα checklist· `run`, `status`, `resume`, `mark` και `rerun` το διαχειρίζονται. [Mission](../mission.md).
- `omx session search` / `export` βρίσκουν και εξάγουν συνομιλίες με ακριβές ID ή μοναδικό prefix, JSON, tools και `--codex-home`. Προεπιλεγμένα εξάγονται μόνο user/assistant μηνύματα· system/developer και reasoning εξαιρούνται, το κείμενο δεν redacted.
- `omx session usage --since 7d --sort tokens` δείχνει καταγεγραμμένη σωρευτική χρήση, όχι κατανάλωση/χρέωση περιόδου. Mirrors μετριούνται μία φορά και μετρήσεις που λείπουν μένουν unknown.
- `omx session timeline <id>` δείχνει tool calls, αποτελέσματα, γνωστές διάρκειες, σφάλματα και compactions χωρίς εξαγωγή κειμένου· απουσία ρητού error δεν αποδεικνύει επιτυχία.
- `omx team` είναι runtime tmux/worktree, όχι προεπιλεγμένη αρχή. Στο Codex App ή εκτός tmux είναι shell surface. Το `team status` παρατηρεί μόνο, δεν αλλάζει κατάσταση.
- `omx setup` εγκαθιστά scoped assets/config· `omx update` ελέγχει npm και κάνει refresh. `omx doctor` δεν εγγυάται authenticated model call· `omx hud --watch` είναι monitoring.
- Το plugin cache μπορεί να βρίσκεται στο `${CODEX_HOME:-~/.codex}/plugins/cache/...` και περιλαμβάνει official lifecycle hooks/companion metadata, αλλά η εκτέλεση απαιτεί CLI `omx`. `omx setup --disable-hooks` απενεργοποιεί OMX hooks. Δείτε [Codex hook mapping](../codex-native-hooks.md).
- Το `.omx-config.json` αφορά model/env routing· επεξεργαστείτε μόνο keys που υποστηρίζει η εγκατεστημένη έκδοση: [schema](../reference/omx-config-schema-routing.md). Το Guardex είναι opt-in με `"guardex": { "enabled": true }` στο project `.omx/hud-config.json`.
- Αν το doctor είναι πράσινο αλλά η εκτέλεση αποτυγχάνει, ελέγξτε auth, `CODEX_HOME` και `openai_base_url` στο ίδιο profile. Force team shutdown μόνο για επιβεβαιωμένα νεκρό/εγκαταλειμμένο team.
- `omx sparkshell` είναι για shell inspection και περιορισμένη επαλήθευση· οι απλές read-only αναζητήσεις repo γίνονται με τα κανονικά εργαλεία Codex. `omx wiki` είναι CLI-first JSON interface για Markdown knowledge base στο `omx_wiki/`.

```bash
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
omx wiki list --json
omx wiki lint --json
```

### Σημειώσεις πλατφόρμας Team

Το Team αποδίδει καλύτερα σε macOS/Linux με `tmux`. Native Windows είναι δευτερεύον· το WSL2 είναι συνήθως προτιμότερο. Σε Windows χρησιμοποιείται `psmux` για συμβατές διαδρομές.

| Πλατφόρμα | Εγκατάσταση |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## Γνωστά ζητήματα

### Intel Mac: υψηλή χρήση CPU `syspolicyd` / `trustd` κατά την εκκίνηση

Σε μερικούς Intel Mac, το Gatekeeper μπορεί να αυξήσει τη χρήση CPU κατά την εκκίνηση OMX, ιδίως με `--madmax --high`. Δοκιμάστε `xattr -dr com.apple.quarantine $(which omx)`, προσθέστε το Terminal στα Developer Tools ή μειώστε το concurrency.

Για Shift+Enter σε tmux συνεδρίες OMX δείτε [Troubleshooting](../troubleshooting.md#shiftenter-submits-instead-of-inserting-a-newline-in-tmux-backed-omx-sessions).

## Τεκμηρίωση

- [Ξεκινώντας](../getting-started.html)
- [Οδηγός demo](../../DEMO.md)
- [Wiki](../wiki-feature.md)
- [Κατάλογος agents](../agents.html)
- [Αναφορά skills](../skills.html)
- [Χάρτης native Codex hooks](../codex-native-hooks.md)
- [Pipeline ταυτότητας GitHub/PR/package](../pipeline/github-pr-package-identity.md)
- [Ενσωματώσεις](../integrations.html)
- [Troubleshooting](../troubleshooting.md)
- [Οδηγός OpenClaw/notifications](../openclaw-integration.md)
- [Συνεισφορά](../../CONTRIBUTING.md)
- [Changelog](../../CHANGELOG.md)

## Γλώσσες

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

## Συνεισφέροντες

| Ρόλος | Όνομα | GitHub |
| --- | --- | --- |
| Δημιουργός και επικεφαλής | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Συντηρητής | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Συντηρητής | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Ιστορικό αστέρων

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date)

## Άδεια

MIT

## Benchmark ορατότητας GEO

Το OMX περιλαμβάνει spec προϊόντος [geobench](https://github.com/NomaDamas/geobench) για μέτρηση LLM hit rate, MRR, share of voice και citations.

- Spec: [geobench/oh-my-codex.yaml](../../geobench/oh-my-codex.yaml)
- Runbook: [geobench.md](../geobench.md)
