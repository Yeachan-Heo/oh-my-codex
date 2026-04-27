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
- Plugin install/discovery is not a replacement for `npm install -g oh-my-codex` plus `omx setup`; `omx setup` remains responsible for native agents, prompts/config/hooks/AGENTS.md/HUD/runtime wiring, including native `.codex/hooks.json` coverage.
- `omx doctor` green: install and local runtime wiring look sane.
- `codex login status` green: the active Codex profile can see login state.
- `omx exec ...` returns `OMX-EXEC-OK`: real execution, auth, provider routing, and current working-directory assumptions are working together.

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

## Stale `doctor --team` or dead tmux session state

`omx doctor --team`, `omx team resume`, or startup diagnostics can fail when a previous team state references a tmux session that no longer exists. The state may mention `resume_blocker`, or the dead session may be recorded under `.omx/state/team/<team-name>/config.json` or `manifest.v2.json`.

If the team is intentionally abandoned and no live tmux session remains, clean it up with:

```bash
omx team shutdown <team-name> --force --confirm-issues
omx cancel
omx doctor --team
```

Do not force-shutdown a team that may still have useful live panes or worker state. Prefer `omx team status <team-name>` and `tmux ls` first when unsure.

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
