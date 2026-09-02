# Troubleshooting execution readiness

Use this page when OMX appears installed but real Codex execution still fails.

## Install success vs real execution success

`omx setup` and `omx doctor` validate OMX's local install surface: prompts, skills, AGENTS scaffolding, config files, hooks, and runtime prerequisites. They do not guarantee that the active Codex profile can authenticate and complete a model request.

After `omx doctor`, run a real smoke test from the same shell, HOME, and project directory you will use for OMX:

```bash
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```

Treat the boundary this way:

- Codex plugin install/discovery may cache `oh-my-codex` under `${CODEX_HOME:-~/.codex}/plugins/cache/$MARKETPLACE_NAME/oh-my-codex/$VERSION/` (with `local` possible as a version identifier for local installs). That confirms a marketplace/plugin artifact; the packaged plugin includes plugin-scoped companion metadata for MCP servers and apps, while native/runtime hooks remain setup-owned, so it is still not the full OMX runtime setup.
- Plugin install/discovery is not a replacement for `npm install -g oh-my-codex` plus `omx setup`; legacy setup mode installs native agents and prompts, while plugin setup mode relies on plugin discovery for bundled skills, archives/removes legacy OMX-managed prompts/skills, and refreshes setup-owned native agent TOMLs so `agent_type` roles remain available without stale generated role files.
- `omx doctor` green: install and local runtime wiring look sane.
- `codex login status` green: the active Codex profile can see login state.
- `omx exec ...` returns `OMX-EXEC-OK`: real execution, auth, provider routing, and current working-directory assumptions are working together.

## AGENTS.md exists, but doctor says the OMX contract is missing

Other Codex ecosystem tools may rewrite `AGENTS.md` while leaving OMX prompts, skills, hooks, and config in place. In that case `omx doctor` warns when the file exists but no longer carries the generated OMX AGENTS contract marker.

To preserve local guidance and restore the OMX-managed contract sections, run:

```bash
omx setup --scope user --merge-agents
```

Use `--scope project` for project-scoped setup. The exact bare policy selectors are `--merge-agents`, `--no-merge-agents`, and `--clear-merge-agents-policy`; equals/value spellings are not supported. An explicit set overrides saved policy, while conflicting set/clear choices fail before setup mutations. Successful explicit sets are saved in the current working root's `./.omx/setup-scope.json`, including with user scope, and valid matching choices are replayed by immediate and deferred updates. They are not global user preferences.

`--no-merge-agents` only suppresses the current merge branch; it does not guarantee preservation or replacement, so normal prompt, skip, managed-refresh, plugin-default, and force behavior remains. Review retains a matching policy while unrelated settings change. Reset or a scope change removes the inherited policy unless the same run explicitly sets it; clear always removes the policy and cannot combine with a set selector. Malformed, unknown, nonboolean, or wrong-scope records are ignored. `--force` is transient and never stored or replayed.

If an active-session or plugin-symlink safeguard skips the current AGENTS write but all other setup work succeeds, an explicit set or clear is atomically committed as future intent. This does not make merging the default or adopt the rejected #2892 behavior. Older OMX versions safely ignore the field but may erase it when rewriting preferences. If you intentionally want to replace the existing file, use `omx setup --scope <user|project> --force`; setup backs up the old file before replacement.

## Green doctor, but `omx exec` fails with auth errors

Common failure strings include `401 Unauthorized`, `Missing bearer or basic authentication in header`, or `Incorrect API key provided`.

Check the active runtime profile, not only your normal login shell:

1. Print `HOME` and `CODEX_HOME` in the shell that launches OMX.
2. Confirm that the active `~/.codex` or `CODEX_HOME` contains the expected auth and `config.toml`.
3. Re-run `codex login status` from that same shell.

Custom HOME, container, profile, CI, and service-user environments often have a different `~/.codex` from the machine's main user. A working Codex setup in one home does not automatically make another home ready.

## Local proxy or `openai_base_url` mismatch

If your setup depends on an OpenAI-compatible local proxy or gateway, verify that the active runtime config contains the matching base URL:

```toml
openai_base_url = "http://localhost:8317/v1"
```

Use your actual proxy URL. If the profile-local `~/.codex/config.toml` is missing `openai_base_url`, Codex may send the proxy-issued key to the default endpoint. That can make setup and doctor look fine while real execution fails with 401-style auth errors.

## Root-owned or non-writable repo artifacts

OMX runtime and planning artifacts under repo-local `.omx/` and `.beads/` should be writable by the same operating-system user that runs `omx`. Files created through `sudo`, containers, or service users can become `root:root` or otherwise non-writable, which later blocks normal agents from appending plans, state, logs, or context artifacts.

`omx doctor` scans `.omx/` and `.beads/` when they exist and reports exact root-owned, owner-mismatched, or non-writable paths. The safe manual repair is:

```bash
sudo chown -R $(id -u):$(id -g) <repo>
```

Use the repository root for `<repo>`. `omx doctor --force` attempts automatic ownership repair only when the repo root is owned by the invoking user; otherwise it leaves files unchanged and prints manual remediation guidance.

## Stale `doctor --team` or dead tmux session state

`omx doctor --team`, `omx team resume`, or startup diagnostics can fail when a previous team state references a tmux session that no longer exists. The state may mention `resume_blocker`, or the dead session may be recorded under `.omx/state/team/<team-name>/config.json` or `manifest.v2.json`.

If the team is intentionally abandoned and no live tmux session remains, clean it up with:

```bash
omx team shutdown <team-name> --force --confirm-issues
omx cancel
omx doctor --team
```

Do not force-shutdown a team that may still have useful live panes or worker state. Prefer `omx team status <team-name>` and `tmux ls` first when unsure.


## Stale session pointer blocks state writes (`session.json is present but unusable`)

State writes fail closed with `Cannot resolve writable state scope: session.json is present but unusable.` when a stale-dead selected pointer lacks a valid `OMX_SESSION_ID` binding, or when the pointer is malformed, belongs to a different working directory, or has indeterminate identity without the bounded exact-session reconciliation described below. Malformed and foreign-working-directory pointers always fail closed; identity-indeterminate pointers have only the narrow exact-session recovery path described below. Durable Ultragoal mutations (`goals.json` story/goal transitions) perform point-in-time writable-authority checks at mutation entry and after lock acquisition; a later SessionStart publication can still interleave before filesystem writes.


### Exact-session reconciliation (stale-dead pointer)

To remove a verified-dead selected pointer and preserve its exact forensic bytes, use the official recovery command:

```bash
omx session pointer recover --cwd /path/to/project
```

The command serializes with the canonical pointer lock and moves only an authoritative, positively dead `session.json` to an adjacent no-clobber quarantine path. It refuses live or usable owners, uncertain or reused identities, malformed or foreign pointers, root/lineage mismatches, concurrent changes, I/O failures, and existing quarantine destinations. A successful recovery leaves the canonical pointer absent so an ordinary relaunch can publish a fresh pointer.

When the pointer's recorded PID is definitively dead, bind the exact current session explicitly and retry the same command — no manual file surgery:

```bash
export OMX_SESSION_ID=<current-session-id>
omx state write --input '{"mode":"ultragoal","active":true,"current_phase":"reviewing"}' --json
```

A stale-dead pointer holds no owner authority, so the validated `OMX_SESSION_ID` binding becomes the writable session scope (state lands under `.omx/state/sessions/<current-session-id>/`). The binding is operator-asserted: the code proves the pointer is definitively dead and authoritative, not that the env value names your live session — set it to the exact current session id. Recovery additionally requires the dead pointer itself to be authoritative for this project: its recorded `cwd` must contain the working directory, and its recorded `state_root` — when present — must canonical-match the selected state root (legacy pointers without `state_root` are accepted only when the cwd-derived `.omx/state` root matches exactly). A pointer with missing or foreign authority metadata stays fail-closed even with an env binding. Scope resolution never rewrites `session.json` itself; only a SessionStart hook reconciles the pointer through the normal pointer-lock protocol. Note that a plain OMX relaunch with a stale-dead pointer aborts with `session_pointer_unusable`/`stale-dead` and preserves the pointer, so setting `OMX_SESSION_ID` explicitly is the reliable recovery path.

### Exact-session reconciliation (identity-indeterminate pointer)

When the pointer's identity is indeterminate, recovery requires the same cwd/state_root authority as stale-dead recovery: the recorded `cwd` must contain the working directory, and the recorded `state_root` — when present — must canonical-match the selected state root (legacy pointers without `state_root` are accepted only when the cwd-derived `.omx/state` root matches exactly). In addition, `OMX_SESSION_ID` must exactly equal the pointer's own recorded `session_id`; no alias resolution is accepted. This is narrower than stale-dead recovery, which accepts any validated binding because a dead owner holds no authority. An identity-indeterminate owner might still be alive, so recovery requires the binding to already match the pointer's own claimed identity, not merely be validated. Scope resolution still never rewrites `session.json`; only a SessionStart hook reconciles the pointer through the normal pointer-lock protocol.

### Known limitation

Pre-commit scope revalidation is a point-in-time check: it reduces but does not eliminate the window between validation and the filesystem commit. A completion that touches several files is not atomic, so a concurrent SessionStart publication can still interleave. Fully addressing this is separate follow-up work: `state: serialize writable commits with SessionStart pointer publication`.

### Still fail-closed

- Malformed and foreign-working-directory pointers always fail closed. An identity-indeterminate pointer also fails closed unless `OMX_SESSION_ID` exactly matches the pointer's own `session_id` and cwd/state_root authority already holds; see **Exact-session reconciliation (identity-indeterminate pointer)**.
- Without an env binding, a stale-dead pointer still blocks writes — set `OMX_SESSION_ID` (a plain relaunch aborts instead of reconciling; only a SessionStart hook reconciles the pointer).
- A live pointer with an unmatched `OMX_SESSION_ID` fails closed as `OMX_SESSION_ID does not match the live session recorded in session.json`.
- Durable Ultragoal mutations (including the legacy aggregate-objective migration that used to run on plain reads) require successful writable-scope resolution: with no selected pointer they keep prior root/unbound behavior, but allowlist violations, conflicting roots, and live-owner mismatches now propagate instead of being ignored.

## Shift+Enter submits instead of inserting a newline in tmux-backed OMX sessions

This is usually **not** a net-new OMX feature gap.

OMX already carries the tmux-side preservation work from issue `#1271` / PR `#1273` (`4405f582`, “Preserve Shift+Enter inside tmux-backed OMX launches”), and current `dev` still enables tmux `extended-keys=always` around OMX-owned Codex launch paths:

- in-tmux launches wrap Codex with `withTmuxExtendedKeys(...)` in `src/cli/index.ts`
- detached tmux launches acquire the same protection through the detached leader bootstrap/cleanup path in `src/cli/index.ts`
- regression tests still cover the enable/restore/lease behavior in `src/cli/__tests__/index.test.ts`

So if `Shift+Enter` still behaves like plain `Enter`, the narrowest likely causes are:

1. **tmux is not actually forwarding extended keys for the reporter's terminal path**
   - tmux only forwards the richer key event when the attached terminal is detected as supporting extended keys
   - `tmux show -gv extended-keys` can say `always`, but forwarding can still fail if the terminal capability is missing or not detected
2. **the reporter is not in the OMX-owned tmux launch path**
   - for example, reproducing in a different pane/session than the one OMX launched or after attaching through a different client path
3. **terminal-specific capability mismatch**
   - some terminals need an explicit tmux `terminal-features` hint for `extkeys`

### Operator checks

Run these from the same tmux client/session where the failure happens:

```bash
tmux show -gv extended-keys
tmux info | grep extkeys
tmux show -gv terminal-features
printf '%s\n' "$TERM" "$TERM_PROGRAM"
```

Expected first check: `always` while OMX is actively running Codex in that tmux-managed path.

If `extended-keys` is **not** `always` during the failing session, that points to an OMX launch-path bug/regression.

If `extended-keys` **is** `always`, but `Shift+Enter` still submits, the likely problem is terminal capability discovery or upstream Codex terminal-input interpretation rather than OMX submission logic.

### Typical environment fix

If your terminal supports extended keys but tmux does not detect it automatically, add an `extkeys` feature hint in `~/.tmux.conf` and restart tmux:

```tmux
set -as terminal-features ',xterm-256color:extkeys'
```

Adjust the terminal pattern if your client advertises a different terminfo name.

### Maintainer triage guidance

- **Open a code fix** only if you can show current `dev` fails to set `extended-keys=always` on the live OMX-owned tmux launch path.
- **Close as environment limitation** if current `dev` sets the tmux option correctly but the reporter's terminal path still does not forward the richer key event.
- **Prefer a docs follow-up** when the root problem is discoverability/operator guidance rather than a broken OMX codepath.

## `omx explore` is hard-deprecated

`omx explore` is hard-deprecated and its direct command surface has been removed. Invoking it now fails intentionally; only `omx explore --help` still prints migration guidance.

- For read-only repository lookups, use the normal Codex repository inspection tools/subagents.
- For explicit shell-native read-only evidence or `--tmux-pane` summaries, use `omx sparkshell -- <command>`.

The earlier explore harness fallback boundaries (sparkshell-backend fallback and in-harness model fallback) no longer apply to a user-facing command, because the command no longer runs a harness. Internal harness-resolution helpers remain only to support `omx doctor`/native-asset diagnostics.

## `omx update` refuses to run on a working-tree build

A checkout that you run directly, or link into a global root with `npm link`, is not owned by any package manager. `omx update` refuses it explicitly:

```
[omx] This build runs from a working tree (/path/to/oh-my-codex), which no package manager owns.
      Self-update is refused; pull and rebuild the checkout instead.
```

Update such a build with `git pull && npm run build`. The launch-time check makes the same determination silently and records the cadence, so a linked dev build never nags on startup and never overwrites your tree.

This is distinct from `[omx] Unable to determine whether this global install is owned by npm or Bun`, which means the package root *is* inside a global `node_modules` but neither manager could be validated as its owner — reinstall globally with npm or Bun.

## The prompt input line drifts into the middle of the pane

Symptom: after a multi-agent/review workflow finishes, the Codex composer (`Ask Codex to do anything`) no longer sits directly above the bottom bars — it renders partway up the pane, with unused rows below it.

The composer is drawn by the Codex CLI itself, not by OMX. OMX only mutates the *pane* around it (HUD split, pane teardown, geometry changes, `send-keys` nudges, and the detached-client `clear-history` prune hook). Every one of those mutations was exercised against a live Codex TUI on `codex-cli 0.152.1` / `tmux 3.2a`, both idle and mid-stream, and none of them desynced the composer anchor:

| mutation | idle | mid-stream |
|---|---|---|
| HUD-style `split-window -v -f -l <n>` below the pane | anchored | anchored |
| `kill-pane` on the HUD pane (pane grows back) | anchored | anchored |
| window shrink 30 → 12 rows, then grow to 40 rows | re-anchors | re-anchors |
| `clear-history` on the leader pane (detach prune hook) | anchored | anchored |
| `detach-client` → `clear-history` → reattach | anchored | anchored |
| nudge transport `C-u` → trigger text → `Tab` → `Enter` | anchored | anchored |
| `alternate-screen off` + `aggressive-resize on` during the above | anchored | anchored |

So a drift is environment-specific rather than an unconditional OMX layout bug.

### Recovery

Force the TUI to recompute its layout by changing the pane geometry once:

```bash
tmux resize-pane -D 1 && tmux resize-pane -U 1
```

If that restores the composer to the bottom, the pane content was fine and only the app's cached bottom anchor was stale (an anchor desync). If the drift survives a resize, it is a genuine layout bug and worth an issue.

### What to attach when reporting it

1. `codex --version` from the affected session (the inline-viewport anchor logic is Codex-side and version-sensitive).
2. `tmux -V` and `tmux show -g | grep -iE 'aggressive-resize|alternate-screen|default-terminal|terminal-overrides'`.
3. Whether the resize nudge above heals it.
4. Whether the drift appeared while output was still streaming or only once everything was idle.
5. Terminal emulator, `TERM`, and any wrapper in the pane (`ssh`, `script`, `asciinema`, nested multiplexer).

## A multi-line assistant response is rendered as one line, or the rest of it is unreachable

Symptom: a long response shows only its first line (or only its tail), scrolling back does not reveal the rest, and `/copy` still reports that it copied the *whole* response.

`/copy` succeeding is the tell: the response is intact in session state, so nothing was truncated at generation time — the missing rows fell out of the terminal's **scrollback**, which is a pane property, not an OMX buffer.

Measured on `tmux 3.2a` with 1500 emitted lines in an 80x24 pane:

| effective `history-limit` at pane creation | lines recoverable with `capture-pane -S -` |
|---|---|
| 200 | 220 (visible screen + a small tail) |
| 5000 | 1500 (all of them) |

Two things follow, and both matter:

1. **`history-limit` is captured when the pane is created.** Setting it afterwards — session-scoped or pane-scoped — does not grow the existing pane's scrollback. It only affects panes created later.
2. OMX clamps `history-limit` for its own detached leader sessions to bound memory. That clamp is `5000` lines and is overridable with `OMX_TMUX_HISTORY_LIMIT` (accepted range 500–200000; anything unparseable falls back to the default rather than shrinking your transcript).

### Recovery and prevention

```bash
# recover the text you cannot see right now
/copy                       # in the Codex TUI: the full response goes to the clipboard

# prevent it for future panes/sessions
tmux set -g history-limit 20000          # or put it in ~/.tmux.conf
OMX_TMUX_HISTORY_LIMIT=20000 omx         # raise the OMX-owned leader clamp too
```

Then start a fresh pane — the current pane keeps the scrollback size it was born with.

If the response is unreachable even in a pane created with a large `history-limit`, that is a rendering defect rather than scrollback loss; attach `codex --version`, `tmux -V`, `tmux show -gv history-limit`, the pane size, and whether `/copy` returns the full text.
