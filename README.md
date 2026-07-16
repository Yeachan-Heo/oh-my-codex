# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Start Codex stronger, then let OMX add better prompts, workflows, and runtime help when the work grows.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/sj4exxQ9v)

**Website:** https://yeachan-heo.github.io/oh-my-codex-website/

**Docs:** [Getting Started](./docs/getting-started.html) · [Agents](./docs/agents.html) · [Skills](./docs/skills.html) · [Integrations](./docs/integrations.html) · [Demo](./DEMO.md) · [OpenClaw guide](./docs/openclaw-integration.md)

**Community:** [Discord](https://discord.gg/sj4exxQ9v) — shared OMX/community server for oh-my-codex and related tooling.

## Official project and package

The official/original OMX project is this repository, [`Yeachan-Heo/oh-my-codex`](https://github.com/Yeachan-Heo/oh-my-codex), and the official npm package for this project is [`oh-my-codex`](https://www.npmjs.com/package/oh-my-codex). Install this project with `npm install -g oh-my-codex` (or alongside Codex CLI as shown below).

Third-party projects or forks that use names such as “OMX v2” are not official continuations, replacements, or release lines for this repository unless this README or the docs explicitly say so. When in doubt, trust this repository and the `oh-my-codex` package as the official install target.

OMX is a workflow layer for [OpenAI Codex CLI](https://github.com/openai/codex).

<table>
<tr>
<td><strong>🚨 CAUTION — RECOMMENDED DEFAULT ONLY: macOS or Linux with Codex CLI.</strong><br><br><strong>OMX is primarily designed and actively tuned for that path.</strong><br><strong>Native Windows and Codex App are not the default experience, may break or behave inconsistently, and currently receive less support.</strong></td>
</tr>
</table>

It keeps Codex as the execution engine and makes it easier to:
- start a stronger Codex session by default
- run one consistent workflow from clarification to completion
- invoke the canonical default workflow with `$deep-interview`, `$ralplan`, and `$ultragoal`
- keep project guidance, plans, logs, and state in `.omx/`

## Core Maintainers

| Role | Name | GitHub |
| --- | --- | --- |
| Creator & Lead | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Maintainer | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Maintainer | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Ambassadors

| Name | GitHub |
| --- | --- |
| Sigrid Jin | [@sigridjineth](https://github.com/sigridjineth) |

## Top Collaborators

| Name | GitHub |
| --- | --- |
| Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Junho Yeo | [@junhoyeo](https://github.com/junhoyeo) |
| JiHongKim98 | [@JiHongKim98](https://github.com/JiHongKim98) |
| Lor | [@gobylor](https://github.com/gobylor) |
| HyunjunJeon | [@HyunjunJeon](https://github.com/HyunjunJeon) |

## Recommended default flow

If you want the default OMX experience, start here:

Choose one install path. If Codex CLI is already installed (Homebrew, npm, or another supported method):

```bash
codex --version
npm install -g oh-my-codex
# from the git project you want Codex to edit; choose a task-specific name
omx --worktree=feat/task --madmax --xhigh
```

If you do not have Codex CLI yet and want npm to manage it:

```bash
npm install -g @openai/codex
npm install -g oh-my-codex
```

Do not run a combined `npm install -g @openai/codex oh-my-codex` over an existing Homebrew-owned `codex` binary such as `/opt/homebrew/bin/codex`; npm may fail with `EEXIST` when `@openai/codex` tries to create the same binary. OMX only needs a working, authenticated `codex` command on `PATH`; it does not require Codex to be installed through npm.

On a real `oh-my-codex` version bump, the global npm install now prints an explicit reminder instead of launching setup automatically. When you're ready, run the scoped setup command below or use `omx update` to check npm and then run the same setup refresh path.

OMX also checks for npm updates at launch on a throttled cadence and prompts before scheduling the update after the current session exits. Set `OMX_AUTO_UPDATE=0` to disable the launch-time check, or set `OMX_AUTO_UPDATE=defer` to schedule the same deferred update without prompting.

Choose the setup scope deliberately:
- Use `omx setup --scope project --merge-agents` from the git project you want OMX to operate on when that repository should own the durable `AGENTS.md` guidance.
- Use `omx setup --scope user` for user-level Codex setup when you are not preparing the current directory as an OMX project.
- Avoid running project-scoped setup from a broad home directory or operating hub unless that directory is intentionally the project under review. A home-level `AGENTS.md` often contains global safety and routing rules; keep project-specific OMX runtime guidance in the real repository instead.

### Persisting an explicit AGENTS merge policy

`omx setup --merge-agents`, `omx setup --no-merge-agents`, and `omx setup --clear-merge-agents-policy` are the only policy selectors; use their bare forms (not `=value` spellings). Repeating an identical selector is harmless, but mixing set and clear choices fails before setup changes anything. An explicit set overrides a saved policy. A successful explicit set records `mergeAgents: true` or `false` in the current working root's `./.omx/setup-scope.json`, even when setup scope is `user`; it never becomes a global user preference or leaks to another root. Later `omx update` replays a valid matching policy for both immediate and deferred refreshes.

`true` takes the existing merge branch. `false` only suppresses that branch: it does not promise preservation, replacement, or any new safety mode, so the existing prompt, skip, managed-refresh, plugin-default, and force behavior still applies. A matching-scope review retains the policy while unrelated settings change. Reset or a scope change removes the inherited policy unless the same setup run explicitly sets `true` or `false`; clear always removes the policy and cannot be combined with a set selector. Malformed, unknown, nonboolean, or wrong-scope saved data is ignored safely.

`--force` is independent and transient: it is neither recorded nor replayed, and does not override an explicit merge policy. Setup atomically commits explicit set or clear intent only after all setup work succeeds, including when active-session or plugin-symlink safeguards skip the current `AGENTS.md` write, so the next refresh can honor the requested policy. This does not make merge the default or revive the rejected #2892 merge-by-default approach. Older OMX versions safely ignore the field, but may erase it when rewriting their known setup preferences.


**Codex plugin install note:** this repo also ships an official Codex plugin layout at `plugins/oh-my-codex` with marketplace metadata in `.agents/plugins/marketplace.json`. That plugin bundles the mirrored skill surface plus plugin-scoped companion metadata for official Codex lifecycle hooks, optional MCP compatibility servers, and apps. It is still **not** a replacement for the global `oh-my-codex` CLI plus scoped setup: plugin-scoped hooks launch the installed `omx` CLI, legacy setup mode installs native agents and prompts, and plugin setup mode relies on plugin discovery for bundled skills while archiving/removing legacy OMX-managed prompts/native-agent TOMLs so stale role files cannot shadow plugin behavior. Plugin mode still needs a persistent scope `AGENTS.md` (`~/.codex/AGENTS.md` for user setup or `./AGENTS.md` for project setup) as the durable orchestration guidance layer; session-scoped AGENTS files only compose that durable guidance with runtime overlays and are not a replacement.

Then work normally inside Codex:

```text
# Durable objective/checkpoints for a long task:
/goal Create a safe authentication refactor plan, implement it, and verify login, logout, and refresh-token behavior.

$deep-interview "clarify the authentication change"
$ralplan "approve the auth plan and review tradeoffs"
$prometheus-strict "stress-test the plan before durable execution"
$ultragoal "turn the approved plan into durable Codex goals"
```

That is the main path.
Before you treat the runtime as ready, run the quick-start smoke test below: `omx doctor` verifies the install shape, while `omx exec` proves the active Codex runtime can actually authenticate and complete a model call from the current environment.
Start OMX strongly, clarify first when needed, approve the plan, optionally use `$prometheus-strict` for interview-driven plan hardening on high-risk work, then use `$ultragoal` as the default durable completion wrapper. Use `$team` inside that execution path only when a specific Ultragoal story needs coordinated parallel work; use `$ralph` when you intentionally want a single-owner completion loop instead of a durable multi-goal run.

## What OMX is for

Use OMX if you already like Codex and want a better day-to-day runtime around it:
- a standard workflow built around `$deep-interview` -> `$ralplan` -> `$ultragoal`, with `$prometheus-strict` available when plans need stricter interview/critique/synthesis before execution and optional `.omx/plans/prometheus-strict/` artifacts
- research boundaries: use `$best-practice-research` for ordinary pre-planning official/upstream evidence, `$autoresearch` for bounded validator-gated research artifacts, `$autoresearch-goal` for goal-mode research missions, and feed any research findings into `$ralplan` for architecture synthesis
- durable multi-goal handoffs with `$ultragoal` and `.omx/ultragoal` artifacts as the default completion path after planning
- specialist roles and supporting skills when the task needs them
- project guidance through scoped `AGENTS.md`
- durable state under `.omx/` for plans, logs, memory, and mode tracking

If you want plain Codex with no extra workflow layer, you probably do not need OMX.

## Quick start

### Requirements

- Node.js 20+
- Codex CLI installed, verified with `codex --version`, and authenticated (Homebrew or npm are both fine; do not reinstall `@openai/codex` with npm if Homebrew already owns `codex`)
- Codex auth configured and visible in the same shell/profile that will run OMX
- `tmux` on macOS/Linux if you want the recommended durable team runtime
- `psmux` on native Windows only if you intentionally want the less-supported Windows team path

### A good first session

After install, check both boundaries:

```bash
omx doctor
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```

`omx doctor` catches missing OMX files, hooks, and runtime prerequisites. The real smoke test catches auth, profile, and provider/base-URL problems that only appear when Codex performs an actual request.

Launch OMX the recommended way from a git project:

```bash
omx --worktree=feat/task --madmax --xhigh
```

On macOS/Linux interactive terminals with `tmux` available, this starts the
leader in OMX-managed detached tmux by default so the HUD/runtime panes can be
created and recovered. `--worktree` also moves the launch into a separate git
checkout, which is the safer default when using `--madmax`. Replace
`feat/task` with a branch-like name for the task.

### Concurrent standard conversations

A standard launch owns one writable session pointer under its selected `OMX_ROOT`. A second ordinary `omx` launch from the same checkout therefore fails closed instead of sharing or silently changing that root. Give each additional conversation an explicit, distinct root:

```bash
omx
OMX_ROOT="$HOME/.omx/instances/second-conversation" omx
OMX_ROOT="$HOME/.omx/instances/third-conversation" omx
```

PowerShell:

```powershell
$env:OMX_ROOT = "$HOME/.omx/instances/second-conversation"
omx
```

Command Prompt:

```bat
set "OMX_ROOT=%USERPROFILE%\.omx\instances\second-conversation"
omx
```

User-specified roots are literal: launching twice with the same explicit `OMX_ROOT` remains a fatal owner conflict. Separate checkouts have separate default roots, while `--worktree` and `--madmax` keep their existing isolation behavior.

### Madmax and worktree launch safety

`--madmax` is OMX shorthand for Codex
`--dangerously-bypass-approvals-and-sandbox`. It removes the normal approval and
sandbox guardrails, so only use it in trusted repositories and environments.
`--high` and `--xhigh` are shorthand for `-c model_reasoning_effort="high|xhigh"`; a normal strong session is `omx --madmax --xhigh` (or `omx --worktree=feat/task --madmax --xhigh` from a git project).

When you use `--madmax` from a git repository, prefer a worktree launch instead
of running directly in the current checkout. For repeatable or concurrent work,
use a named worktree:

```bash
omx --worktree=feature/auth --madmax --xhigh
```

If you are outside a git repository, omit `--worktree`; worktree launches
require Git.

For concurrent `--madmax` sessions, do **not** run them all in the same
directory. Give each session its own named worktree:

```bash
omx --worktree=feature/auth --madmax --xhigh
omx --worktree=fix/flaky-tests --madmax --xhigh
```

`--worktree` / `-w` with no name creates or reuses a detached launch worktree at
`../<repo>.omx-worktrees/launch-detached`. `--worktree=<name>`,
`--worktree <name>`, or `-w <name>` creates or reuses a named launch worktree
under `../<repo>.omx-worktrees/` and checks out that branch name. OMX consumes
the worktree flag before starting Codex; it is not forwarded to Codex itself.
Treat the unnamed detached form as a one-off convenience: if the source checkout
advances after that worktree is created, a later unnamed launch can fail with
`worktree_target_mismatch` because `launch-detached` still points at the old
HEAD. Use a named worktree for repeated work, or remove the old detached
worktree before retrying.
If the target launch worktree is already dirty, OMX warns and launches as-is, so
clean, commit, or stash that worktree before relying on it for isolation.

For `omx team`, workers already use dedicated worktrees automatically by
default; `--worktree` on `omx team` is only a legacy-compatible override.

Repo-aware tools receive the same canonical context in launch, team-worker, and autoresearch runtimes: `OMX_REPO_ROOT`, `OMX_WORKTREE_ROOT`, `OMX_GIT_COMMON_DIR`, `OMX_WORKTREE_SCOPE`, `OMX_CODEGRAPH_MODE`, and `OMX_CODEGRAPH_PROJECT_PATH`. `OMX_CODEGRAPH_MODE=auto` prefers a worktree-local `.codegraph/codegraph.db`, then a leader/repo `.codegraph/codegraph.db`, otherwise resolves to `off`. Explicit `shared`, `local`, and `off` are honored. OMX does not install CodeGraph, auto-index worktrees, or copy/symlink `.codegraph`; shared leader indexes are useful for baseline navigation but are not branch-accurate for worktree-only changes.

If you want a one-off launch with no OMX tmux/HUD management, use `--direct`:

```bash
omx --direct --yolo
```

For a persistent shell/profile preference, set an environment policy:

```bash
OMX_LAUNCH_POLICY=direct omx --yolo
```

Return to the auto/default behavior with:

```bash
unset OMX_LAUNCH_POLICY
```

CLI policy flags win over the environment, and the last CLI policy flag before
`--` wins:

```bash
OMX_LAUNCH_POLICY=direct omx --tmux --yolo
```

Use `OMX_LAUNCH_POLICY=direct|tmux|detached-tmux|auto`. This iteration only
adds CLI and environment controls; it intentionally does not add a config-file
setting. If you run `--direct` from inside an existing tmux pane, OMX will not
create HUD splits, enable mouse mode, or wrap extended-key handling, but the
process still runs inside that already-open terminal pane.

Then try the canonical workflow:

```text
# Copy/pasteable durable-goal example:
/goal Ship the checkout bug fix with a durable objective, checkpoints for reproduction, implementation, regression tests, and final verification.

$ralplan "approve the checkout bug-fix plan and review tradeoffs"
$ultrawork "execute the approved checkout fix with checkpoint evidence"
```

Use `$team` when an active Ultragoal story needs coordinated parallel work, or `$ralph` when one persistent owner should keep pushing to completion without a multi-goal ledger.

### `/goal` and skill selection

Start a normal strong session with `omx --madmax --xhigh` (or add `--worktree=<task>` in a git repo). Inside that session, pick the execution spine that matches the work: `$autopilot` for the full supervised planning-to-execution loop, `$ultrawork` when you want durable checkpointed execution, or `$ralph` when one persistent owner should keep pushing to completion. Use `/goal` when the task itself needs a durable objective/checkpoint structure that Codex should keep reconciling across turns.

Add only 2-5 relevant skills by default. More skills are allowed when the task scope justifies them, but loading a large catalog is usually a context-budget and attention-quality problem, not a hard parser/runtime blocker. Treat it as a concrete runtime blocker only when a command actually errors.

Anti-pattern:

```text
omx --madmax --xhigh
# Then immediately load 20 skills "just in case" before stating the task.
# This bloats session context and makes the model spend attention on irrelevant workflows.
```

## A simple mental model

OMX does **not** replace Codex.

It adds a better working layer around it:
- **Codex** does the actual agent work
- **OMX role keywords** make useful roles reusable
- **OMX skills** make common workflows reusable
- **`.omx/`** stores plans, logs, memory, and runtime state

Most users should think of OMX as **better task routing + better workflow + better runtime**, not as a command surface to operate manually all day.

## Start here if you are new

1. If Codex CLI already exists, verify it with `codex --version` and install or update OMX with `npm install -g oh-my-codex`; otherwise install `@openai/codex` separately first if you want npm to manage Codex
2. After install or real OMX version bumps, run `omx setup --scope project --merge-agents` from the target git project or `omx setup --scope user` for user-level Codex setup, or use `omx update` when you also want npm to check for and install the latest build before refreshing setup
3. Run `omx doctor`
4. Run a real execution smoke test: `codex login status` and `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"`
5. Launch with a named worktree from a git repo, for example `omx --worktree=feat/task --madmax --xhigh`; if you run concurrent `--madmax` sessions, use distinct named worktrees such as `--worktree=feature/auth`
6. Use `$deep-interview "..."` when the request or boundaries are still unclear
7. Use `$ralplan "..."` to approve the plan and review tradeoffs
8. Use `$ultragoal`, `$ultrawork`, `$autopilot`, or `$ralph` when the task needs an execution spine; add `/goal` when durable objective/checkpoint structure should be explicit

## Recommended workflow

1. `$deep-interview` — clarify scope when the request or boundaries are still vague.
2. `$ralplan` — turn that clarified scope into an approved architecture and implementation plan.
3. `$ultragoal` — make the approved plan durable as sequential Codex goals with `.omx/ultragoal` ledger checkpoints.

`$ralplan` stops at planning artifacts and a durable consensus handoff. Code changes require an explicit execution lane (`$ultragoal`, `$team`, or an intentional `$ralph` fallback); ralplan does not implement directly.

Inside an Ultragoal story, use `$team` only when that story benefits from coordinated parallel execution. Use `$ralph` as an intentional alternate completion loop when you do not need a durable multi-goal ledger.

## Common in-session surfaces

| Surface | Use it for |
| --- | --- |
| `$deep-interview "..."` | clarifying intent, boundaries, and non-goals |
| `$ralplan "..."` | approving the implementation plan and tradeoffs |
| `$ultragoal "..."` | durable multi-goal completion after the approved plan |
| `$ralph "..."` | persistent completion and verification loops |
| `$team "..."` | coordinated parallel execution when the work is big enough |
| `/skills` | browsing installed skills and supporting helpers |
| `/goal ...` | durable objective/checkpoint structure for tasks that must reconcile progress across turns |
| `omx mission <file>` | sequential prompt/checklist batch runs through `omx exec`, with `.omx/missions/<slug>/summary.json` and `ledger.jsonl` operator artifacts |

## Advanced / operator surfaces

These are useful, but they are not the main onboarding path.

### Mission queue runner

Use `omx mission` when you have a short checklist of OmX/Codex prompts that should run one after another instead of opening a separate shell command for each prompt. Start with `omx mission plan ./mission.md` or `omx mission ./mission.md --dry-run` to validate parsing and inspect the durable summary, then run `omx mission run ./mission.md -- --model gpt-5` when the prompts are ready. Interrupted runs can be inspected with `omx mission status ./mission.md`, continued with `omx mission resume ./mission.md`, operator-blocked with `omx mission mark ./mission.md --task task-002 --status blocked`, and repaired task-by-task with `omx mission rerun ./mission.md --task task-002`. See [`docs/mission.md`](./docs/mission.md) for input format, status output, and artifact details.

### Team runtime

Use the team runtime when you specifically need durable tmux/worktree coordination, not as the default way to begin using OMX. In Codex App or plain outside-tmux sessions, treat `omx team` as a tmux-runtime shell surface rather than a directly available in-app workflow; launch OMX CLI from shell first if you actually want team execution.

When Team runs inside an Ultragoal story, Ultragoal remains leader-owned state: workers report checkpoint-ready evidence upward instead of mutating `.omx/ultragoal` directly. Team startup tolerates stale or malformed Ultragoal artifacts for unrelated work, but explicitly Ultragoal-linked Team launches stay fail-closed. Team startup also writes `.omx/state/team/<team-name>/preflight-context.json` so large Team runs can be resumed after compaction with the original task, worker split, Ultragoal context, and verification checklist.

For very small atomic work, Team may cap implicit fanout to one worker and print an over-orchestration warning; pass an explicit worker count only when the extra coordination cost is intentional.

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

### Setup, doctor, and HUD

These are operator/support surfaces:
- Codex plugin marketplace install/discovery can cache the plugin under `${CODEX_HOME:-~/.codex}/plugins/cache/$MARKETPLACE_NAME/oh-my-codex/$VERSION/` (local installs may use `local` as the version identifier); that packaged plugin includes plugin-scoped companion metadata for official Codex lifecycle hooks, optional MCP compatibility servers, and apps (MCP/apps disabled by default), so it is still paired with the installed `omx` CLI for runtime execution
- Scoped setup installs prompts, skills, AGENTS scaffolding, `.codex/config.toml`, and (for legacy installs or older Codex without `plugin_hooks`) OMX-managed native Codex hooks in `.codex/hooks.json`
  - setup refresh preserves non-OMX hook entries in `.codex/hooks.json` and only rewrites OMX-managed wrappers
  - plugin setup keeps `AGENTS.md` as persistent durable guidance even though bundled skills/hooks come from the plugin cache; `omx doctor` treats a missing persistent scope `AGENTS.md` in plugin mode as a failed check because the session-scoped AGENTS file would otherwise contain only runtime overlay guidance
  - `omx setup --merge-agents` preserves existing project `AGENTS.md` guidance while inserting or refreshing generated OMX sections between `<!-- OMX:AGENTS:START -->` / `<!-- OMX:AGENTS:END -->`; `--no-merge-agents` records an explicit contextual non-merge choice, and `--clear-merge-agents-policy` always removes the recorded choice and cannot combine with a set selector. The policy is stored per working root (even for user scope), replayed by immediate and deferred updates only when its saved scope is valid and matches, and is never a force/default policy.
  - `omx uninstall` removes OMX-managed wrappers from `.codex/hooks.json` but keeps the file when user hooks remain
- `omx update` checks npm immediately, installs the newest global OMX build, then reruns the same interactive setup refresh path
- launch-time update checks are throttled and prompt by default; use `OMX_AUTO_UPDATE=0` to disable them or `OMX_AUTO_UPDATE=defer` to schedule deferred updates without a prompt
- fresh OMX-managed `gpt-5.6-sol` config seeding now recommends `model_context_window = 250000` and `model_auto_compact_token_limit = 200000`, but only when those keys are missing
- `.omx-config.json` model/env routing is documented in [the model/env routing reference](./docs/reference/omx-config-schema-routing.md); only edit keys supported by your installed OMX version
- `omx doctor` verifies the install when something seems wrong; it does not prove that the active Codex profile can make an authenticated model call
- `omx hud --watch` is a monitoring/status surface, not the primary user workflow

For non-team sessions, native Codex hooks are now the canonical lifecycle surface:
- `plugins/oh-my-codex/hooks/hooks.json` = official plugin-scoped hook registrations for plugin installs
- `.codex/hooks.json` = legacy/fallback native Codex hook registrations preserved for legacy installs and older Codex versions
- `.omx/hooks/*.mjs` = OMX plugin hooks
- `omx tmux-hook` / notify-hook / derived watcher = tmux + runtime fallback paths

See [Codex native hook mapping](./docs/codex-native-hooks.md) for the current native / fallback matrix.


### Troubleshooting false-green readiness

A green `omx doctor` means the install and local runtime wiring look sane. If real execution still fails, check the environment Codex actually uses:

- Run `codex login status` and `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"` from the same shell/profile that will launch OMX.
- In custom HOME, profile, container, or service shells, confirm the active `~/.codex` (or `CODEX_HOME`) is the one with the expected auth and config. Do not assume your normal user `~/.codex` is visible there.
- If you depend on a local OpenAI-compatible proxy, confirm the active `~/.codex/config.toml` includes the expected `openai_base_url`; otherwise a proxy-issued key can be sent to the default endpoint and fail with `401 Unauthorized`, `Missing bearer or basic authentication in header`, or `Incorrect API key provided`.
- If `omx doctor --team` or resume reports a stale team such as `resume_blocker` or a missing tmux session, clean the dead runtime state before retrying:

```bash
omx team shutdown <team-name> --force --confirm-issues
omx cancel
omx doctor --team
```

Only use the forced team shutdown for a team you have confirmed is dead or intentionally abandoned.

If `Shift+Enter` still submits instead of inserting a newline inside an OMX-managed tmux session, see [Troubleshooting execution readiness](./docs/troubleshooting.md#shiftenter-submits-instead-of-inserting-a-newline-in-tmux-backed-omx-sessions). Current OMX already enables tmux extended-key forwarding around its own Codex launch paths, so a persistent failure is usually a tmux terminal-capability/discoverability problem rather than a net-new OMX feature gap.

### Sparkshell

- `omx sparkshell <command>` is for shell-native inspection and bounded verification
- for read-only repository lookups, use normal Codex repository inspection tools/subagents (the deprecated `omx explore` command has been removed)
- sparkshell env overrides are intentionally narrow: `OMX_SPARKSHELL_BIN` selects a native sidecar path, `OMX_SPARKSHELL_MODEL` selects the primary summary model, `OMX_SPARKSHELL_FALLBACK_MODEL` selects the retry model, `OMX_SPARKSHELL_MODEL_INSTRUCTIONS_FILE` selects summary instructions, and `OMX_SPARKSHELL_SUMMARY_TIMEOUT_MS` controls the local API summary timeout

Examples:

```bash
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```

### Wiki

- `omx wiki` is the CLI-first JSON surface for wiki operations; `omx_wiki` MCP is explicit compatibility only
- wiki data lives as repository project knowledge under `omx_wiki/`
- the wiki is markdown-first and search-first, not vector-first

Examples:

```bash
omx wiki list --json
omx wiki query --input '{"query":"session-start lifecycle"}' --json
omx wiki lint --json
omx wiki refresh --json
```

### Platform notes for team mode

`omx team` works best on macOS/Linux with `tmux`.
Native Windows remains a secondary path, and WSL2 is generally the better choice if you want a Windows-hosted setup.
On native Windows, OMX accepts `psmux` as the tmux-compatible binary for the existing tmux-backed paths it already uses.

| Platform | Install |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## Known issues

### Intel Mac: high `syspolicyd` / `trustd` CPU during startup

On some Intel Macs, OMX startup — especially with `--madmax --high` — can spike `syspolicyd` / `trustd` CPU usage while macOS Gatekeeper validates many concurrent process launches.

If this happens, try:
- `xattr -dr com.apple.quarantine $(which omx)`
- adding your terminal app to the Developer Tools allowlist in macOS Security settings
- using lower concurrency (for example, avoid `--madmax --high`)

## Documentation

- [Getting Started](./docs/getting-started.html)
- [Demo guide](./DEMO.md)
- [Wiki feature](./docs/wiki-feature.md)
- [Agent catalog](./docs/agents.html)
- [Skills reference](./docs/skills.html)
- [Codex native hook mapping](./docs/codex-native-hooks.md)
- [GitHub / PR / package identity pipeline](./docs/pipeline/github-pr-package-identity.md)
- [Integrations](./docs/integrations.html)
- [Troubleshooting execution readiness](./docs/troubleshooting.md)
- [OpenClaw / notification gateway guide](./docs/openclaw-integration.md)
- [Contributing](./CONTRIBUTING.md)
- [Changelog](./CHANGELOG.md)

## Languages

- [English](./README.md)
- [한국어](./docs/readme/README.ko.md)
- [日本語](./docs/readme/README.ja.md)
- [简体中文](./docs/readme/README.zh.md)
- [繁體中文](./docs/readme/README.zh-TW.md)
- [Tiếng Việt](./docs/readme/README.vi.md)
- [Español](./docs/readme/README.es.md)
- [Português](./docs/readme/README.pt.md)
- [Русский](./docs/readme/README.ru.md)
- [Türkçe](./docs/readme/README.tr.md)
- [Deutsch](./docs/readme/README.de.md)
- [Français](./docs/readme/README.fr.md)
- [Italiano](./docs/readme/README.it.md)
- [Ελληνικά](./docs/readme/README.el.md)
- [Polski](./docs/readme/README.pl.md)
- [Українська](./docs/readme/README.uk.md)

## Contributors

| Role | Name | GitHub |
| --- | --- | --- |
| Creator & Lead | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Maintainer | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Maintainer | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## License

MIT

## GEO visibility benchmark

OmX includes a [`geobench`](https://github.com/NomaDamas/geobench) product spec for measuring LLM hit rate, MRR, share of voice, and citations.

- Spec: [`geobench/oh-my-codex.yaml`](geobench/oh-my-codex.yaml)
- Runbook: [`docs/geobench.md`](docs/geobench.md)
