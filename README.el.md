# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Ξεκινήστε το Codex πιο δυναμικά και αφήστε το OMX να προσθέσει καλύτερα prompts, workflows και runtime υποστήριξη όταν η δουλειά μεγαλώνει.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/PUwSMR9XNk)

**Ιστοσελίδα:** https://yeachan-heo.github.io/oh-my-codex-website/  
**Τεκμηρίωση:** [Ξεκινώντας](./docs/getting-started.html) · [Agents](./docs/agents.html) · [Skills](./docs/skills.html) · [Ενσωματώσεις](./docs/integrations.html) · [Demo](./DEMO.md) · [Οδηγός OpenClaw](./docs/openclaw-integration.md)

Το OMX είναι ένα workflow layer για το [OpenAI Codex CLI](https://github.com/openai/codex).

Διατηρεί το Codex ως μηχανή εκτέλεσης και διευκολύνει τα εξής:
- να ξεκινάτε μια πιο δυναμική συνεδρία Codex από προεπιλογή
- να επαναχρησιμοποιείτε χρήσιμες κλήσεις ρόλων/εργασιών με keywords `$name`
- να ενεργοποιείτε workflows με skills όπως `$plan`, `$ralph` και `$team`
- να κρατάτε οδηγίες έργου, σχέδια, αρχεία καταγραφής και κατάσταση στον φάκελο `.omx/`

## Προτεινόμενη προεπιλεγμένη ροή

Αν θέλετε την προεπιλεγμένη εμπειρία OMX, ξεκινήστε εδώ:

```bash
npm install -g @openai/codex oh-my-codex
omx setup
omx --madmax --high
```

Στη συνέχεια εργαστείτε κανονικά μέσα στο Codex:

```text
$architect "analyze the authentication flow"
$plan "ship this feature cleanly"
```

Αυτή είναι η βασική ροή.
Ξεκινήστε το OMX δυναμικά, κάντε τη δουλειά στο Codex και αφήστε τον agent να ενεργοποιήσει το `$team` ή άλλες ροές εργασίας μόνο όταν η εργασία πραγματικά τις χρειάζεται.

## Σε τι χρησιμεύει το OMX

Χρησιμοποιήστε το OMX αν σας αρέσει ήδη το Codex και θέλετε ένα καλύτερο καθημερινό περιβάλλον εργασίας γύρω του:
- επαναχρησιμοποιήσιμες κλήσεις ρόλων/εργασιών όπως `$architect` και `$executor`
- επαναχρησιμοποιήσιμα workflows όπως `$plan`, `$ralph`, `$team` και `$deep-interview`
- καθοδήγηση έργου μέσω scoped `AGENTS.md`
- επίμονη κατάσταση στον `.omx/` για σχέδια, αρχεία καταγραφής, μνήμη και παρακολούθηση λειτουργίας

Αν θέλετε απλό Codex χωρίς επιπλέον επίπεδο ροής εργασίας, πιθανότατα δεν χρειάζεστε το OMX.

## Γρήγορη εκκίνηση

### Απαιτήσεις

- Node.js 20+
- Εγκατεστημένο Codex CLI: `npm install -g @openai/codex`
- Ρυθμισμένη αυθεντικοποίηση Codex
- `tmux` σε macOS/Linux αν θέλετε αργότερα τον ανθεκτικό team runtime
- `psmux` σε native Windows αν θέλετε αργότερα τη λειτουργία team για Windows

### Μια καλή πρώτη συνεδρία

Εκκινήστε το OMX με τον προτεινόμενο τρόπο:

```bash
omx --madmax --high
```

Στη συνέχεια δοκιμάστε ένα keyword ρόλου και ένα workflow skill:

```text
$architect "analyze the authentication flow"
$plan "map the safest implementation path"
```

Αν η εργασία μεγαλώσει, ο agent μπορεί να κλιμακώσει σε βαρύτερες ροές εργασίας όπως `$ralph` για επίμονη εκτέλεση ή `$team` για συντονισμένη παράλληλη εργασία.

## Ένα απλό νοητικό μοντέλο

Το OMX **δεν** αντικαθιστά το Codex.

Προσθέτει ένα καλύτερο workflow layer γύρω του:
- **Codex** κάνει την πραγματική δουλειά του agent
- **Keywords ρόλων OMX** κάνουν τους χρήσιμους ρόλους επαναχρησιμοποιήσιμους
- **Skills OMX** κάνουν τα συνηθισμένα workflows επαναχρησιμοποιήσιμα
- **`.omx/`** αποθηκεύει σχέδια, αρχεία καταγραφής, μνήμη και κατάσταση εκτέλεσης

Οι περισσότεροι χρήστες καλό είναι να βλέπουν το OMX ως **καλύτερη δρομολόγηση εργασιών + καλύτερο workflow + καλύτερο runtime**, όχι ως ένα σύνολο εντολών για χειροκίνητη χρήση όλη μέρα.

## Ξεκινήστε εδώ αν είστε νέοι

1. Εκτελέστε `omx setup`
2. Εκκινήστε με `omx --madmax --high`
3. Ζητήστε ανάλυση με `$architect "..."`
4. Ζητήστε σχεδιασμό με `$plan "..."`
5. Αφήστε τον agent να αποφασίσει πότε αξίζει να χρησιμοποιήσει `$ralph`, `$team` ή κάποια άλλη ροή εργασίας

## Συνηθισμένες λειτουργίες μέσα στη συνεδρία

| Λειτουργία | Χρήση |
| --- | --- |
| `$architect "..."` | ανάλυση, όρια, συμβιβασμοί |
| `$executor "..."` | εστιασμένη εργασία υλοποίησης |
| `/skills` | περιήγηση εγκατεστημένων skills |
| `$plan "..."` | σχεδιασμός πριν την υλοποίηση |
| `$ralph "..."` | επίμονη διαδοχική εκτέλεση |
| `$team "..."` | συντονισμένη παράλληλη εκτέλεση όταν η εργασία είναι αρκετά μεγάλη |

Χρησιμοποιήστε `$deep-interview` όταν το αίτημα είναι ακόμα ασαφές, τα όρια δεν είναι ξεκάθαρα ή θέλετε το OMX να συνεχίσει να σας πιέζει να ξεκαθαρίσετε την πρόθεση, τους μη-στόχους και τα όρια αποφάσεων πριν παραδώσει τη δουλειά στο `$plan`, `$ralph`, `$team` ή `$autopilot`.

Τυπικές περιπτώσεις:
- ασαφείς greenfield ιδέες που χρειάζονται πιο καθαρή πρόθεση και εύρος
- brownfield αλλαγές όπου το OMX πρέπει πρώτα να εξετάσει το repo και μετά να κάνει στοχευμένες ερωτήσεις επιβεβαίωσης
- αιτήματα όπου θέλετε έναν βρόχο διευκρίνισης μία-ερώτηση-τη-φορά αντί για άμεσο σχεδιασμό ή υλοποίηση

## Προχωρημένες λειτουργίες / για διαχειριστές

Αυτά είναι χρήσιμα, αλλά δεν είναι ο βασικός τρόπος για να ξεκινήσετε.

### Team runtime

Χρησιμοποιήστε τον team runtime όταν χρειάζεστε ειδικά ανθεκτικό συντονισμό tmux/worktree, όχι ως τον προεπιλεγμένο τρόπο για να ξεκινήσετε με το OMX.

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

### Setup, doctor και HUD

Αυτές είναι λειτουργίες διαχείρισης/υποστήριξης:
- `omx setup` εγκαθιστά prompts, skills, ρυθμίσεις και scaffolding AGENTS
- `omx doctor` επαληθεύει την εγκατάσταση όταν κάτι φαίνεται λάθος
- `omx hud --watch` είναι λειτουργία παρακολούθησης/κατάστασης, όχι η κύρια ροή εργασίας του χρήστη

### Explore και sparkshell

- `omx explore --prompt "..."` είναι για αναζήτηση μόνο ανάγνωσης στο repository
- `omx sparkshell <command>` είναι για επιθεώρηση απευθείας από το shell και στοχευμένη επαλήθευση

Παραδείγματα:

```bash
omx explore --prompt "find where team state is written"
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```

### Σημειώσεις πλατφόρμας για τη λειτουργία team

Η `omx team` χρειάζεται ένα tmux-συμβατό backend:

| Πλατφόρμα | Εγκατάσταση |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## Γνωστά ζητήματα

### Mac με Intel: υψηλή χρήση CPU `syspolicyd` / `trustd` κατά την εκκίνηση

Σε ορισμένα Mac με Intel, η εκκίνηση του OMX, ειδικά με `--madmax --high`, μπορεί να αυξήσει απότομα τη χρήση CPU των `syspolicyd` / `trustd` ενώ το macOS Gatekeeper επαληθεύει πολλές ταυτόχρονες εκκινήσεις διεργασιών.

Αν συμβεί αυτό, δοκιμάστε:
- `xattr -dr com.apple.quarantine $(which omx)`
- προσθέστε την εφαρμογή τερματικού σας στη λίστα επιτρεπόμενων Developer Tools στις ρυθμίσεις Ασφάλειας του macOS
- χρησιμοποιήστε χαμηλότερο επίπεδο ταυτόχρονων εκτελέσεων (για παράδειγμα, αποφύγετε `--madmax --high`)

## Τεκμηρίωση

- [Ξεκινώντας](./docs/getting-started.html)
- [Οδηγός Demo](./DEMO.md)
- [Κατάλογος Agents](./docs/agents.html)
- [Αναφορά Skills](./docs/skills.html)
- [Ενσωματώσεις](./docs/integrations.html)
- [Οδηγός OpenClaw / notification gateway](./docs/openclaw-integration.md)
- [Συνεισφορά](./CONTRIBUTING.md)
- [Αρχείο αλλαγών](./CHANGELOG.md)

## Γλώσσες

- [English](./README.md)
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

## Συνεισφέροντες

| Ρόλος | Όνομα | GitHub |
| --- | --- | --- |
| Δημιουργός & Επικεφαλής | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Συντηρητής | HaD0Yun | [@HaD0Yun](https://github.com/HaD0Yun) |

## Ιστορικό Αστεριών

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## Άδεια

MIT
